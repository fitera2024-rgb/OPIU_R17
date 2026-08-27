import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const INVENTORY_SCHEMA = "opiu-structural-control-inventory.v3";
const BINDING_SCHEMA = "opiu-structural-control-inventory-binding.v3";
const HIERARCHY_SCHEMA = "opiu-hierarchy-tree-v1";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA256_PATTERN = /^[A-F0-9]{64}$/;

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function sha256Value(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function exactCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  const represented = cents / 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.abs(value - represented) <= tolerance ? cents : null;
}

function blocker(code, side = "RUN", details = {}) {
  return Object.freeze({ code: `STRUCTURAL_INVENTORY_${code}`, side, ...details });
}

function addBlocker(blockers, value) {
  const signature = canonicalJson(value);
  if (!blockers.some((candidate) => canonicalJson(candidate) === signature)) blockers.push(value);
}

function sameStringSet(left, right) {
  const normalize = (values) => [...new Set(values.map(text).filter(Boolean))].sort();
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function validateSource(source, nodeID, side, blockers) {
  const file = text(source?.file ?? source?.source_file);
  const sheet = text(source?.sheet);
  const row = Number(source?.row ?? source?.physical_row);
  const sourceCell = text(source?.source_cell);
  const sha256 = text(source?.sha256).toUpperCase();
  if (!file || !sheet || !Number.isInteger(row) || row <= 0 || !sourceCell || !SHA256_PATTERN.test(sha256)) {
    addBlocker(blockers, blocker("SOURCE_TRACE_INCOMPLETE", side, { node_id: nodeID }));
    return null;
  }
  return Object.freeze({ file, sheet, row, source_cell: sourceCell, sha256, node_id: nodeID });
}

function validateTree(tree, side, blockers) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    addBlocker(blockers, blocker("TREE_MISSING", side));
    return null;
  }
  if (text(tree.schema) !== HIERARCHY_SCHEMA) {
    addBlocker(blockers, blocker("TREE_SCHEMA_UNVERIFIED", side, { schema: text(tree.schema) }));
  }
  if (text(tree.status) !== "PASS") {
    addBlocker(blockers, blocker("TREE_STATUS_NOT_PASS", side, { status: text(tree.status) }));
  }
  for (const sourceBlocker of Array.isArray(tree.blockers) ? tree.blockers : []) {
    addBlocker(blockers, blocker("TREE_BLOCKER", side, {
      source_code: text(sourceBlocker?.code),
      node_id: text(sourceBlocker?.node_id),
    }));
  }

  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const roots = Array.isArray(tree.root_node_ids) ? tree.root_node_ids.map(text).filter(Boolean) : [];
  if (Number.isFinite(Number(tree.node_count)) && Number(tree.node_count) !== nodes.length) {
    addBlocker(blockers, blocker("TREE_NODE_COUNT_MISMATCH", side, {
      declared_node_count: Number(tree.node_count),
      actual_node_count: nodes.length,
    }));
  }
  if (nodes.length === 0) addBlocker(blockers, blocker("TREE_NODES_MISSING", side));
  if (roots.length === 0) addBlocker(blockers, blocker("ROOTS_MISSING", side));
  if (new Set(roots).size !== roots.length) addBlocker(blockers, blocker("ROOT_ID_DUPLICATE", side));

  const byID = new Map();
  const sourceRows = [];
  const sourceByNodeID = new Map();
  for (const node of nodes) {
    const nodeID = text(node?.node_id);
    if (!nodeID) {
      addBlocker(blockers, blocker("NODE_ID_MISSING", side));
      continue;
    }
    if (byID.has(nodeID)) {
      addBlocker(blockers, blocker("NODE_ID_DUPLICATE", side, { node_id: nodeID }));
      continue;
    }
    byID.set(nodeID, node);
    const source = validateSource(node?.source, nodeID, side, blockers);
    if (source) {
      sourceRows.push(source);
      sourceByNodeID.set(nodeID, source);
    }
  }

  const derivedRoots = [];
  for (const [nodeID, node] of byID) {
    const parentID = text(node?.parent_node_id);
    if (!parentID) derivedRoots.push(nodeID);
    else if (!byID.has(parentID)) {
      addBlocker(blockers, blocker("PARENT_MISSING", side, { node_id: nodeID, parent_node_id: parentID }));
    }
    const children = Array.isArray(node?.immediate_children)
      ? node.immediate_children.map(text).filter(Boolean)
      : [];
    if (new Set(children).size !== children.length) {
      addBlocker(blockers, blocker("CHILD_ID_DUPLICATE", side, { node_id: nodeID }));
    }
    for (const childID of children) {
      const child = byID.get(childID);
      if (!child) {
        addBlocker(blockers, blocker("CHILD_MISSING", side, { node_id: nodeID, child_node_id: childID }));
      } else if (text(child.parent_node_id) !== nodeID) {
        addBlocker(blockers, blocker("PARENT_CHILD_CONFLICT", side, { node_id: nodeID, child_node_id: childID }));
      }
    }
    if (parentID) {
      const parentChildren = Array.isArray(byID.get(parentID)?.immediate_children)
        ? byID.get(parentID).immediate_children.map(text).filter(Boolean)
        : [];
      if (byID.has(parentID) && !parentChildren.includes(nodeID)) {
        addBlocker(blockers, blocker("CHILD_EDGE_MISSING", side, {
          node_id: nodeID,
          parent_node_id: parentID,
        }));
      }
    }
  }
  if (!sameStringSet(roots, derivedRoots)) {
    addBlocker(blockers, blocker("ROOT_SET_MISMATCH", side, {
      declared_root_count: roots.length,
      derived_root_count: derivedRoots.length,
    }));
  }

  for (const nodeID of byID.keys()) {
    const visited = new Set();
    let currentID = nodeID;
    while (currentID) {
      if (visited.has(currentID)) {
        addBlocker(blockers, blocker("CYCLE_DETECTED", side, { node_id: nodeID }));
        break;
      }
      visited.add(currentID);
      currentID = text(byID.get(currentID)?.parent_node_id);
      if (currentID && !byID.has(currentID)) break;
    }
  }

  const members = [];
  let sourceOrder = 0;
  for (const [nodeID, node] of byID) {
    const parentID = text(node.parent_node_id);
    if (!parentID || node.is_group !== true) continue;
    const sourceIdentity = text(node.source_identity);
    const sourceIdentityScope = text(node.source_identity_scope);
    const exactSource = sourceByNodeID.get(nodeID);
    if (!sourceIdentity || !sourceIdentityScope || !exactSource) {
      addBlocker(blockers, blocker("CANDIDATE_SOURCE_IDENTITY_INCOMPLETE", side, { node_id: nodeID }));
      continue;
    }
    const name = text(node.name ?? node.label);
    const hierarchyPath = text(node.full_path);
    const amountCents = exactCents(node.direct_total);
    if (!name || !hierarchyPath) {
      addBlocker(blockers, blocker("CANDIDATE_LABEL_INCOMPLETE", side, { node_id: nodeID }));
      continue;
    }
    if (amountCents === null) continue;
    members.push(Object.freeze({
      identity: nodeID,
      parent_identity: parentID,
      source_identity: sourceIdentity,
      source_identity_scope: sourceIdentityScope,
      dimension_key: text(node.dimension_key),
      dimension_identity_status: text(node.dimension_identity_status),
      source: Object.freeze({
        file: exactSource.file,
        sheet: exactSource.sheet,
        row: exactSource.row,
        source_cell: exactSource.source_cell,
        sha256: exactSource.sha256,
      }),
      code: text(node.code ?? node.catalog_code),
      name,
      hierarchy_path: hierarchyPath,
      amount_cents: amountCents,
      source_order: sourceOrder,
      level: Number(node.level ?? node.hierarchy_level ?? 0),
      is_group: true,
      selectable_root: false,
      candidate_selectable: true,
      business_block_declared: false,
      semantic_status: "BUSINESS_BLOCK_UNPROVEN",
      requires_user_declaration: true,
      correction_authority: false,
    }));
    sourceOrder += 1;
  }
  if (members.length === 0) addBlocker(blockers, blocker("SOURCE_HIERARCHY_CANDIDATES_MISSING", side));

  const sourcesByKey = new Map();
  const sourceRowsByIdentity = new Map();
  const hashesByFile = new Map();
  for (const source of sourceRows) {
    const sourceIdentity = `${source.file}\u0000${source.sheet}\u0000${source.row}\u0000${source.source_cell}`;
    const sourceOwner = sourceRowsByIdentity.get(sourceIdentity);
    if (sourceOwner && sourceOwner !== source.node_id) {
      addBlocker(blockers, blocker("SOURCE_ROW_IDENTITY_CONFLICT", side, {
        node_id: source.node_id,
        conflicting_node_id: sourceOwner,
      }));
    } else {
      sourceRowsByIdentity.set(sourceIdentity, source.node_id);
    }
    const fileHashes = hashesByFile.get(source.file) ?? new Set();
    fileHashes.add(source.sha256);
    hashesByFile.set(source.file, fileHashes);
    const key = `${source.file}\u0000${source.sha256}`;
    const current = sourcesByKey.get(key) ?? { file: source.file, sha256: source.sha256, sheets: new Set(), rows: [] };
    current.sheets.add(source.sheet);
    current.rows.push(source.row);
    sourcesByKey.set(key, current);
  }
  for (const [file, hashes] of hashesByFile) {
    if (hashes.size > 1) {
      addBlocker(blockers, blocker("SOURCE_FILE_HASH_CONFLICT", side, {
        file,
        sha256_count: hashes.size,
      }));
    }
  }
  const sources = [...sourcesByKey.values()]
    .sort((left, right) => `${left.file}\u0000${left.sha256}`.localeCompare(`${right.file}\u0000${right.sha256}`, "en"))
    .map((source) => Object.freeze({
      file: source.file,
      sha256: source.sha256,
      sheets: Object.freeze([...source.sheets].sort((left, right) => left.localeCompare(right, "ru"))),
      first_row: Math.min(...source.rows),
      last_row: Math.max(...source.rows),
    }));
  if (sources.length === 0) addBlocker(blockers, blocker("SOURCE_SCOPE_EMPTY", side));

  return Object.freeze({
    tree_sha256: sha256Value(tree),
    node_count: nodes.length,
    root_count: roots.length,
    sources: Object.freeze(sources),
    members: Object.freeze(members),
  });
}

function safety() {
  return Object.freeze({
    mode: "REPORT_ONLY",
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    execution_allowed: false,
    live_1c_allowed: false,
  });
}

function exactInputHashes(intalev, erp) {
  const hashes = (tree) => Object.freeze((tree?.sources ?? []).map((source) => Object.freeze({
    file: source.file,
    sha256: source.sha256,
  })));
  return Object.freeze({ intalev: hashes(intalev), erp: hashes(erp) });
}

function normalizeArtifactDescriptor(value) {
  return Object.freeze({
    file: text(value?.file),
    sha256: text(value?.sha256).toUpperCase(),
  });
}

function validateCurrentRunProvenance(value, scope, inventoryID, blockers) {
  const provenance = {
    report: normalizeArtifactDescriptor(value?.report),
    codex_input: normalizeArtifactDescriptor(value?.codex_input),
    manifest: normalizeArtifactDescriptor(value?.manifest),
    scope_verified: value?.scope_verified === true,
    verification_blockers: Object.freeze(Array.isArray(value?.verification_blockers)
      ? value.verification_blockers.map((item) => text(item)).filter(Boolean)
      : []),
  };
  for (const [role, artifact] of Object.entries({
    REPORT: provenance.report,
    CODEX_INPUT: provenance.codex_input,
    MANIFEST: provenance.manifest,
  })) {
    if (!artifact.file || !SHA256_PATTERN.test(artifact.sha256)) {
      addBlocker(blockers, blocker(`CURRENT_RUN_${role}_PROVENANCE_MISSING`));
    }
  }
  if (!provenance.scope_verified) {
    addBlocker(blockers, blocker("CURRENT_RUN_SCOPE_NOT_VERIFIED", "RUN", {
      verification_blockers: provenance.verification_blockers,
    }));
  }
  return Object.freeze({
    ...provenance,
    run_id: scope.run_id,
    context_id: scope.context_id,
    organization: Object.freeze({ ...scope.organization }),
    period: scope.period,
    inventory_id: inventoryID,
  });
}

export function buildStructuralControlInventoryV3({
  runId,
  contextId,
  organization,
  reconciliationOrganizationName,
  period,
  hierarchyPeriods,
  currentRunProvenance,
  deferCurrentRunProvenance = false,
  generatedAt = "",
} = {}) {
  const blockers = [];
  const scope = {
    run_id: text(runId),
    context_id: text(contextId),
    organization: {
      id: text(organization?.id),
      name: text(organization?.name),
      path: text(organization?.path),
    },
    period: text(period),
  };
  if (!scope.run_id) addBlocker(blockers, blocker("RUN_ID_MISSING"));
  if (!scope.context_id) addBlocker(blockers, blocker("CONTEXT_ID_MISSING"));
  if (!scope.organization.id) addBlocker(blockers, blocker("ORGANIZATION_ID_MISSING"));
  if (!scope.organization.name) addBlocker(blockers, blocker("ORGANIZATION_NAME_MISSING"));
  if (!scope.organization.path) addBlocker(blockers, blocker("ORGANIZATION_PATH_MISSING"));
  if (text(reconciliationOrganizationName) &&
      text(reconciliationOrganizationName) !== scope.organization.name) {
    addBlocker(blockers, blocker("ORGANIZATION_NAME_SCOPE_MISMATCH", "RUN", {
      reconciliation_organization_name: text(reconciliationOrganizationName),
      inventory_organization_name: scope.organization.name,
    }));
  }
  if (!MONTH_PATTERN.test(scope.period)) addBlocker(blockers, blocker("CONCRETE_MONTH_REQUIRED", "RUN", { period: scope.period }));

  const periods = Array.isArray(hierarchyPeriods) ? hierarchyPeriods : [];
  const periodItem = periods.length === 1 && text(periods[0]?.period) === scope.period ? periods[0] : null;
  if (!periodItem) {
    addBlocker(blockers, blocker("EXACT_PERIOD_HIERARCHY_MISSING", "RUN", {
      requested_period: scope.period,
      hierarchy_period_count: periods.length,
    }));
  }
  if (periodItem && text(periodItem.source_hierarchy_status) !== "PASS") {
    addBlocker(blockers, blocker("SOURCE_HIERARCHY_NOT_PASS", "RUN", {
      status: text(periodItem.source_hierarchy_status),
    }));
  }

  const intalev = periodItem ? validateTree(periodItem.intalev_tree, "INTALEV", blockers) : null;
  const erp = periodItem ? validateTree(periodItem.erp_tree, "ERP", blockers) : null;
  const hierarchyVersions = Object.freeze({
    intalev: intalev?.tree_sha256 ?? "",
    erp: erp?.tree_sha256 ?? "",
  });
  const memberHashes = Object.freeze({
    intalev: intalev ? sha256Value(intalev.members) : "",
    erp: erp ? sha256Value(erp.members) : "",
  });
  const inputHashes = exactInputHashes(intalev, erp);
  const inventoryID = `SCI-${sha256Value({
    schema_version: INVENTORY_SCHEMA,
    run_id: scope.run_id,
    context_id: scope.context_id,
    organization: scope.organization,
    period: scope.period,
    hierarchy_versions: hierarchyVersions,
    member_hashes: memberHashes,
    input_hashes: inputHashes,
  }).slice(0, 32)}`;
  const currentRun = deferCurrentRunProvenance
    ? null
    : validateCurrentRunProvenance(currentRunProvenance, scope, inventoryID, blockers);
  const base = {
    schema_version: INVENTORY_SCHEMA,
    artifact_type: "STRUCTURAL_CONTROL_INVENTORY",
    status: blockers.length === 0
      ? (deferCurrentRunProvenance ? "ELIGIBLE_PENDING_CURRENT_RUN_PROVENANCE" : "VERIFIED")
      : "BLOCKED",
    run_id: scope.run_id,
    context_id: scope.context_id,
    organization: scope.organization,
    period: scope.period,
    generated_at: text(generatedAt),
    hierarchy_versions: hierarchyVersions,
    member_hashes: memberHashes,
    input_hashes: inputHashes,
    current_run_provenance: currentRun,
    source_scope: {
      intalev: intalev ? { node_count: intalev.node_count, root_count: intalev.root_count, sources: intalev.sources } : null,
      erp: erp ? { node_count: erp.node_count, root_count: erp.root_count, sources: erp.sources } : null,
    },
    intalev_members: blockers.length === 0 ? intalev.members : [],
    erp_members: blockers.length === 0 ? erp.members : [],
    blockers: Object.freeze(blockers),
    default_behavior: "PROCESS_ALL_DISCREPANCIES",
    optional_control_only: true,
    candidate_semantics: "USER_DECLARED_CONTROL_ONLY",
    automatic_business_block_classification: false,
    user_declaration_required: true,
    correction_authority: false,
    financial_rows: 0,
    safety: safety(),
  };
  const inventory = Object.freeze({
    ...base,
    inventory_id: inventoryID,
  });
  return Object.freeze({ status: inventory.status, inventory });
}

export function planStructuralControlInventoryV3(input = {}) {
  const result = buildStructuralControlInventoryV3({
    ...input,
    deferCurrentRunProvenance: true,
  });
  const inventory = result.inventory;
  return Object.freeze({
    status: result.status,
    inventory_id: inventory.inventory_id,
    audit: Object.freeze({
      schema_version: INVENTORY_SCHEMA,
      status: result.status,
      inventory_id: inventory.inventory_id,
      run_id: inventory.run_id,
      context_id: inventory.context_id,
      organization: inventory.organization,
      period: inventory.period,
      hierarchy_versions: inventory.hierarchy_versions,
      member_hashes: inventory.member_hashes,
      input_hashes: inventory.input_hashes,
      blocker_codes: Object.freeze(inventory.blockers.map((item) => item.code)),
      verified_binding_written: false,
      binding_status: "PENDING_CURRENT_RUN_PROVENANCE",
      default_behavior: "PROCESS_ALL_DISCREPANCIES",
      optional_control_only: true,
      candidate_semantics: "USER_DECLARED_CONTROL_ONLY",
      automatic_business_block_classification: false,
      user_declaration_required: true,
      correction_authority: false,
      financial_rows: 0,
      safety: safety(),
    }),
  });
}

async function writeAtomic(filePath, bytes) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function readCurrentRunArtifact(filePath, role, verificationBlockers) {
  const file = text(filePath) ? path.resolve(text(filePath)) : "";
  if (!file) {
    verificationBlockers.push(`${role}_PATH_MISSING`);
    return { file: "", sha256: "", bytes: null, document: null };
  }
  try {
    const bytes = await fs.readFile(file);
    let document = null;
    if (role !== "REPORT") {
      try {
        document = JSON.parse(bytes.toString("utf8"));
      } catch {
        verificationBlockers.push(`${role}_JSON_INVALID`);
      }
    }
    return { file, sha256: sha256Bytes(bytes), bytes, document };
  } catch {
    verificationBlockers.push(`${role}_READ_FAILED`);
    return { file, sha256: "", bytes: null, document: null };
  }
}

function sameResolvedPath(left, right) {
  if (!text(left) || !text(right)) return false;
  return path.resolve(text(left)).toLocaleLowerCase("en-US") ===
    path.resolve(text(right)).toLocaleLowerCase("en-US");
}

async function verifyCurrentRunFiles(currentRunFiles, input, plan) {
  const verificationBlockers = [];
  const report = await readCurrentRunArtifact(currentRunFiles?.reportPath, "REPORT", verificationBlockers);
  const codexInput = await readCurrentRunArtifact(
    currentRunFiles?.codexInputPath,
    "CODEX_INPUT",
    verificationBlockers,
  );
  const manifest = await readCurrentRunArtifact(
    currentRunFiles?.manifestPath,
    "MANIFEST",
    verificationBlockers,
  );
  const expectedOrganization = text(input?.organization?.name);
  const expectedPeriod = text(input?.period);
  for (const [role, artifact] of [["CODEX_INPUT", codexInput], ["MANIFEST", manifest]]) {
    const document = artifact.document;
    if (!document) continue;
    if (text(document.organization) !== expectedOrganization || text(document.period) !== expectedPeriod) {
      verificationBlockers.push(`${role}_RECONCILIATION_SCOPE_MISMATCH`);
    }
    if (canonicalJson(document.structural_control_inventory) !== canonicalJson(plan.audit)) {
      verificationBlockers.push(`${role}_STRUCTURAL_PLAN_SCOPE_MISMATCH`);
    }
    const reportPath = role === "CODEX_INPUT"
      ? document.report_path
      : document.output_path;
    const reportSHA256 = role === "CODEX_INPUT"
      ? document.report_sha256
      : document.output_sha256;
    if (!sameResolvedPath(reportPath, report.file) ||
        text(reportSHA256).toUpperCase() !== report.sha256) {
      verificationBlockers.push(`${role}_REPORT_BINDING_MISMATCH`);
    }
  }
  if (manifest.document && (
    !sameResolvedPath(manifest.document.codex_input_path, codexInput.file) ||
    text(manifest.document.codex_input_sha256).toUpperCase() !== codexInput.sha256
  )) {
    verificationBlockers.push("MANIFEST_CODEX_INPUT_BINDING_MISMATCH");
  }
  return Object.freeze({
    report: Object.freeze({ file: report.file, sha256: report.sha256 }),
    codex_input: Object.freeze({ file: codexInput.file, sha256: codexInput.sha256 }),
    manifest: Object.freeze({ file: manifest.file, sha256: manifest.sha256 }),
    scope_verified: verificationBlockers.length === 0,
    verification_blockers: Object.freeze(verificationBlockers),
  });
}

export async function materializeStructuralControlInventoryV3({
  outputDirectory,
  currentRunFiles,
  ...input
} = {}) {
  if (!text(outputDirectory)) throw new Error("STRUCTURAL_INVENTORY_OUTPUT_DIRECTORY_MISSING");
  const directory = path.resolve(text(outputDirectory));
  await fs.mkdir(directory, { recursive: true });
  const plan = planStructuralControlInventoryV3(input);
  const currentRunProvenance = await verifyCurrentRunFiles(currentRunFiles, input, plan);
  const result = buildStructuralControlInventoryV3({
    ...input,
    currentRunProvenance,
  });
  const verified = result.status === "VERIFIED";
  const verifiedInventoryPath = path.join(directory, "structural-control-inventory.json");
  const blockedInventoryPath = path.join(directory, "structural-control-inventory.blocked.json");
  const bindingPath = path.join(directory, "structural-control-inventory.binding.json");
  // Remove the authority-bearing binding first. A crash during replacement can
  // therefore leave no usable binding, never a stale binding for new bytes.
  await fs.rm(bindingPath, { force: true });
  if (verified) await fs.rm(blockedInventoryPath, { force: true });
  else await fs.rm(verifiedInventoryPath, { force: true });
  const inventoryFile = verified ? "structural-control-inventory.json" : "structural-control-inventory.blocked.json";
  const inventoryPath = path.join(directory, inventoryFile);
  const inventoryBytes = Buffer.from(`${JSON.stringify(result.inventory, null, 2)}\n`, "utf8");
  await writeAtomic(inventoryPath, inventoryBytes);
  const inventorySHA256 = sha256Bytes(inventoryBytes);

  let binding = null;
  let bindingFile = "";
  let bindingSHA256 = "";
  if (verified) {
    bindingFile = "structural-control-inventory.binding.json";
    binding = Object.freeze({
      schema_version: BINDING_SCHEMA,
      artifact_type: "STRUCTURAL_CONTROL_INVENTORY",
      run_id: result.inventory.run_id,
      context_id: result.inventory.context_id,
      organization_id: result.inventory.organization.id,
      organization_name: result.inventory.organization.name,
      organization_path: result.inventory.organization.path,
      period: result.inventory.period,
      inventory_id: result.inventory.inventory_id,
      inventory_file: inventoryFile,
      sha256: inventorySHA256,
      input_hashes: result.inventory.input_hashes,
      hierarchy_versions: result.inventory.hierarchy_versions,
      member_hashes: result.inventory.member_hashes,
      report: result.inventory.current_run_provenance.report,
      codex_input: result.inventory.current_run_provenance.codex_input,
      manifest: result.inventory.current_run_provenance.manifest,
      current_run_provenance_sha256: sha256Value(result.inventory.current_run_provenance),
      verified: true,
      candidate_semantics: result.inventory.candidate_semantics,
      automatic_business_block_classification: false,
      user_declaration_required: true,
      correction_authority: false,
      safety: safety(),
    });
    const bindingBytes = Buffer.from(`${JSON.stringify(binding, null, 2)}\n`, "utf8");
    await writeAtomic(bindingPath, bindingBytes);
    bindingSHA256 = sha256Bytes(bindingBytes);
  }

  return Object.freeze({
    status: result.status,
    inventory: result.inventory,
    binding,
    audit: Object.freeze({
      schema_version: INVENTORY_SCHEMA,
      status: result.status,
      inventory_id: result.inventory.inventory_id,
      inventory_file: inventoryFile,
      inventory_sha256: inventorySHA256,
      binding_file: bindingFile,
      binding_sha256: bindingSHA256,
      verified_binding_written: verified,
      run_id: result.inventory.run_id,
      context_id: result.inventory.context_id,
      organization: result.inventory.organization,
      period: result.inventory.period,
      hierarchy_versions: result.inventory.hierarchy_versions,
      member_hashes: result.inventory.member_hashes,
      input_hashes: result.inventory.input_hashes,
      current_run_provenance: result.inventory.current_run_provenance,
      blocker_codes: Object.freeze(result.inventory.blockers.map((item) => item.code)),
      default_behavior: "PROCESS_ALL_DISCREPANCIES",
      optional_control_only: true,
      correction_authority: false,
      financial_rows: 0,
      safety: safety(),
    }),
  });
}

export const STRUCTURAL_CONTROL_INVENTORY_V3_SCHEMA = INVENTORY_SCHEMA;
export const STRUCTURAL_CONTROL_INVENTORY_BINDING_V3_SCHEMA = BINDING_SCHEMA;
