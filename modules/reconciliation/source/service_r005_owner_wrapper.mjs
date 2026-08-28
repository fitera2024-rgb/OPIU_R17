import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectOwnerEconomicDecisions } from "./owner_decision_projection.mjs";
import { appendOwnerDecisionExplanationSheet } from "./owner_decision_xlsx.mjs";
import { loadEconomicRouteProofDocument } from "./economic_route_proof_binding.mjs";
import {
  loadStructuralControlSettingsDocument,
  materializeStructuralControlSettingsForRun,
} from "./structural_control_settings_binding.mjs";
import {
  materializeStructuralControlInventoryV3,
  planStructuralControlInventoryV3,
} from "./structural_control_inventory_v3.mjs";
import { buildAuthoritativeStructuralControlInventoryHierarchyPeriod } from "./structural_control_authoritative_candidates.mjs";
import {
  OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION,
  isOwnerPresentationBlockExempt,
} from "./owner_presentation_block_exemption.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_SCRIPT = path.join(MODULE_DIR, "opiu_reconcile.mjs");
const POLICY_PATH = path.join(MODULE_DIR, "owner_decision_policy.json");
const OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY = path.join(MODULE_DIR, "owner_economic_route_proofs");

export function resolveDefaultStructuralControlSettingsCsv(moduleDir = MODULE_DIR) {
  const moduleProductRoot = path.resolve(moduleDir, "..", "..", "..");
  const packageRoot = path.basename(moduleProductRoot).toLowerCase() === "runtime"
    ? path.dirname(moduleProductRoot)
    : moduleProductRoot;
  return path.join(packageRoot, "user-settings", "Настройка_группировки_блоков.csv");
}

const DEFAULT_STRUCTURAL_CONTROL_SETTINGS_CSV = resolveDefaultStructuralControlSettingsCsv();
const STRUCTURAL_CONTROL_SELECTION_PROOF_MAX_BYTES = 1024 * 1024;
const STRUCTURAL_CONTROL_SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

function text(value) { return String(value ?? "").trim(); }
function normalizedText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueTracePaths(trace) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(trace) ? trace : []) {
    const fullPath = normalizedText(item?.full_path);
    if (!fullPath || seen.has(fullPath)) continue;
    seen.add(fullPath);
    result.push(fullPath);
  }
  return result;
}

function blockedStructuralInventoryPeriod(period) {
  throw new Error(`BLOCKED_STRUCTURAL_CONTROL_INVENTORY_PERIOD_BINDING:${normalizedText(period)}`);
}

export function authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload = {}) {
  const hierarchyPeriods = Array.isArray(payload?.hierarchy_periods)
    ? payload.hierarchy_periods
    : [];
  const periodRows = Array.isArray(payload?.period_rows) ? payload.period_rows : [];
  const rowsByPeriod = new Map();
  for (const month of periodRows) {
    const period = normalizedText(month?.period);
    if (!period || rowsByPeriod.has(period)) blockedStructuralInventoryPeriod(period);
    rowsByPeriod.set(period, month);
  }

  const usedPeriods = new Set();
  const projection = hierarchyPeriods.map((hierarchyPeriod) => {
    const period = normalizedText(hierarchyPeriod?.period);
    const month = rowsByPeriod.get(period);
    if (!period || !month || usedPeriods.has(period)) blockedStructuralInventoryPeriod(period);
    usedPeriods.add(period);
    return buildAuthoritativeStructuralControlInventoryHierarchyPeriod({
      ...month,
      period,
      rows: (month.rows ?? []).map((row) => ({
        ...row,
        intalev_amount: row?.intalev_amount
          ?? (typeof row?.intalev === "number" ? row.intalev : row?.intalev?.amount),
        erp_amount: row?.erp_amount
          ?? (typeof row?.erp === "number" ? row.erp : row?.erp?.amount),
        erp_paths: row?.erp_paths ?? uniqueTracePaths(row?.erp?.trace),
      })),
    }, hierarchyPeriod);
  });

  const extraPeriod = [...rowsByPeriod.keys()].find((period) => !usedPeriods.has(period));
  if (extraPeriod) blockedStructuralInventoryPeriod(extraPeriod);
  return projection;
}

export function authoritativeStructuralInventoryPlanFromPayload(payload = {}) {
  const embeddedPlan = payload?.structural_control_inventory;
  if (text(embeddedPlan?.schema_version) !== "opiu-structural-control-inventory.v3") return null;
  const input = Object.freeze({
    runId: embeddedPlan.run_id,
    contextId: embeddedPlan.context_id,
    organization: embeddedPlan.organization,
    reconciliationOrganizationName: payload.organization,
    period: payload.period,
    hierarchyPeriods: authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload),
    generatedAt: payload.generated_at,
  });
  return Object.freeze({
    input,
    plan: planStructuralControlInventoryV3(input),
  });
}

export function bindAuthoritativeStructuralInventoryPlan(document, preparedPlan) {
  if (!preparedPlan) return document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("STRUCTURAL_CONTROL_INVENTORY_PLAN_DOCUMENT_INVALID");
  }
  document.structural_control_inventory = preparedPlan.plan.audit;
  return document;
}

export function bindFinalReportCrossLinks(document, { reportPath, reportSha256 } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("R005_CURRENT_RUN_DOCUMENT_INVALID");
  }
  const exactPath = path.resolve(text(reportPath));
  const exactSha256 = text(reportSha256).toUpperCase();
  if (!text(reportPath) || !/^[A-F0-9]{64}$/.test(exactSha256)) {
    throw new Error("R005_CURRENT_RUN_REPORT_BINDING_INVALID");
  }
  document.report_path = exactPath;
  document.report_sha256 = exactSha256;
  document.output_path = exactPath;
  document.output_sha256 = exactSha256;
  return document;
}

export function bindFinalManifestCrossLinks(document, {
  reportPath,
  reportSha256,
  codexInputPath,
  codexInputSha256,
} = {}) {
  bindFinalReportCrossLinks(document, { reportPath, reportSha256 });
  const exactCodexPath = path.resolve(text(codexInputPath));
  const exactCodexSha256 = text(codexInputSha256).toUpperCase();
  if (!text(codexInputPath) || !/^[A-F0-9]{64}$/.test(exactCodexSha256)) {
    throw new Error("R005_CURRENT_RUN_CODEX_BINDING_INVALID");
  }
  document.codex_input_path = exactCodexPath;
  document.codex_input_sha256 = exactCodexSha256;
  return document;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}
async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}
async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function writeJsonImmutable(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function rejectReparsePathComponents(resolved, errorCode) {
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  let current = parsed.root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(errorCode);
  }
}

async function readBoundedRegularFile(requestedPath, maxBytes, errorCode) {
  const resolved = path.resolve(text(requestedPath));
  if (!resolved || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(errorCode);
  await rejectReparsePathComponents(resolved, errorCode);
  const pathBefore = await fs.lstat(resolved);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1 || pathBefore.size > maxBytes) {
    throw new Error(errorCode);
  }
  const handle = await fs.open(resolved, "r");
  try {
    const handleBefore = await handle.stat();
    if (!handleBefore.isFile() || handleBefore.size < 1 || handleBefore.size > maxBytes ||
        !sameFileIdentity(pathBefore, handleBefore)) {
      throw new Error(errorCode);
    }
    const buffer = Buffer.alloc(Number(handleBefore.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const handleAfter = await handle.stat();
    const pathAfter = await fs.lstat(resolved);
    if (offset !== Number(handleBefore.size) || handleAfter.size !== handleBefore.size ||
        !sameFileIdentity(handleBefore, handleAfter) || !sameFileIdentity(handleAfter, pathAfter) ||
        pathAfter.isSymbolicLink() || !pathAfter.isFile()) {
      throw new Error(errorCode);
    }
    return Object.freeze({ resolved, bytes: buffer.subarray(0, offset), size: offset });
  } finally {
    await handle.close();
  }
}
async function pathKind(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function selectOwnerEconomicRouteProof({
  organization,
  period,
  directory = OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY,
} = {}) {
  const runOrganization = text(organization);
  const runPeriod = text(period);
  if (!runOrganization || !runPeriod) {
    return Object.freeze({ status: "RUN_SCOPE_INCOMPLETE", path: "", document: null });
  }
  const kind = await pathKind(directory);
  if (kind === "missing") {
    return Object.freeze({ status: "NO_CONFIG_DIRECTORY", path: "", document: null });
  }
  if (kind !== "directory") throw new Error(`OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY_INVALID:${path.resolve(directory)}`);
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const matches = [];
  for (const entry of entries) {
    const proofPath = path.join(directory, entry.name);
    const document = await loadEconomicRouteProofDocument(proofPath);
    if (document.organization === runOrganization && document.period === runPeriod) {
      matches.push({ path: path.resolve(proofPath), document });
    }
  }
  if (matches.length > 1) {
    throw new Error(`OWNER_ECONOMIC_ROUTE_PROOF_DUPLICATE_SCOPE:${runOrganization}|${runPeriod}`);
  }
  if (matches.length === 0) {
    return Object.freeze({ status: "NO_EXACT_SCOPE", path: "", document: null });
  }
  return Object.freeze({ status: "EXACT_SCOPE_SELECTED", ...matches[0] });
}

export async function coreArgsWithOwnerEconomicRouteProof(argv, {
  directory = OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY,
} = {}) {
  const args = parseArgs(argv);
  if (text(args["economic-route-proofs"])) {
    return Object.freeze({
      argv: Object.freeze([...argv]),
      selection: Object.freeze({ status: "EXPLICIT_CLI_PROOF", path: path.resolve(args["economic-route-proofs"]) }),
    });
  }
  const selection = await selectOwnerEconomicRouteProof({
    organization: args.organization,
    period: args.period,
    directory,
  });
  const result = [...argv];
  if (selection.path) result.push("--economic-route-proofs", selection.path);
  return Object.freeze({ argv: Object.freeze(result), selection });
}

function withoutWrapperStructuralControlArguments(argv) {
  const wrapperOnly = new Set([
    "--structural-control-authority",
    "--structural-control-settings-csv",
    "--structural-control-selection-proof",
  ]);
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!wrapperOnly.has(token)) {
      result.push(token);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) index += 1;
  }
  return result;
}

async function readServiceStructuralControlSelectionProof(requestedPath, expectedSettingsPath = "") {
  const proofFile = await readBoundedRegularFile(
    requestedPath,
    STRUCTURAL_CONTROL_SELECTION_PROOF_MAX_BYTES,
    "STRUCTURAL_CONTROL_SELECTION_PROOF_UNSAFE",
  );
  const value = JSON.parse(proofFile.bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const materializationStatus = text(value?.status);
  const active = materializationStatus === "EXACT_ORGANIZATION_MATERIALIZED";
  if (!["opiu-service-structural-control-selection.v1", "opiu-service-structural-control-verification.v1"].includes(value?.schema)
      || value?.authority !== "service-csv"
      || !["EXACT_ORGANIZATION_MATERIALIZED", "NO_EXACT_ORGANIZATION", "NO_ACTIVE_SETS"].includes(materializationStatus)
      || !text(value?.source_path)
      || !/^[0-9A-F]{64}$/u.test(text(value?.source_sha256).toUpperCase())
      || !Number.isSafeInteger(Number(value?.source_size))
      || Number(value?.source_size) < 1
      || (active && value?.schema !== "opiu-service-structural-control-verification.v1")
      || (!active && value?.schema !== "opiu-service-structural-control-selection.v1")) {
    throw new Error("STRUCTURAL_CONTROL_SELECTION_PROOF_INVALID");
  }
  const expected = text(expectedSettingsPath) ? path.resolve(expectedSettingsPath) : "";
  if (active && (
    !expected || path.resolve(text(value.path)) !== expected || path.resolve(text(value.settings_path)) !== expected ||
    !/^[0-9A-F]{64}$/u.test(text(value.settings_sha256).toUpperCase()) ||
    !Number.isSafeInteger(Number(value.settings_size)) || Number(value.settings_size) < 1 ||
    !text(value.settings_id) || !Number.isSafeInteger(Number(value.set_count)) || Number(value.set_count) < 1 ||
    !Array.isArray(value.set_ids) || value.set_ids.length !== Number(value.set_count) ||
    new Set(value.set_ids.map(text)).size !== value.set_ids.length || value.set_ids.some((id) => !text(id)) ||
    !/^[0-9A-F]{64}$/u.test(text(value.sets_sha256).toUpperCase())
  )) {
    throw new Error("STRUCTURAL_CONTROL_SELECTION_PROOF_SETTINGS_INVALID");
  }
  if (!active && (text(value.path) || expected)) {
    throw new Error("STRUCTURAL_CONTROL_SELECTION_PROOF_EMPTY_PATH_INVALID");
  }
  return Object.freeze({
    materialization_status: materializationStatus,
    source_path: path.resolve(value.source_path),
    source_sha256: text(value.source_sha256).toUpperCase(),
    source_size: Number(value.source_size),
    selection_proof_path: proofFile.resolved,
    selection_proof_sha256: crypto.createHash("sha256").update(proofFile.bytes).digest("hex").toUpperCase(),
    selection_proof_size: proofFile.size,
    ...(active ? {
      verified_settings_path: path.resolve(value.settings_path),
      verified_settings_sha256: text(value.settings_sha256).toUpperCase(),
      verified_settings_size: Number(value.settings_size),
      verified_settings_id: text(value.settings_id),
      verified_set_count: Number(value.set_count),
      verified_set_ids: Object.freeze(value.set_ids.map(text)),
      verified_sets_sha256: text(value.sets_sha256).toUpperCase(),
    } : {}),
  });
}

export async function coreArgsWithUserStructuralControlSettings(argv, {
  csvPath = process.env.OPIU_STRUCTURAL_CONTROL_SETTINGS_CSV || DEFAULT_STRUCTURAL_CONTROL_SETTINGS_CSV,
} = {}) {
  const args = parseArgs(argv);
  const flagCount = (flag) => argv.filter((token) => token === flag).length;
  const authorityCount = flagCount("--structural-control-authority");
  const settingsCount = flagCount("--structural-control-settings");
  const csvCount = flagCount("--structural-control-settings-csv");
  const selectionProofCount = flagCount("--structural-control-selection-proof");
  if (authorityCount > 1 || settingsCount > 1 || csvCount > 1 || selectionProofCount > 1) {
    throw new Error("STRUCTURAL_CONTROL_AUTHORITY_DUPLICATE");
  }
  const authority = text(args["structural-control-authority"]);
  if (authority) {
    if (authorityCount !== 1 || !["service-json", "service-csv", "service-none"].includes(authority)) {
      throw new Error(`STRUCTURAL_CONTROL_AUTHORITY_INVALID:${authority}`);
    }
    if (authority === "service-json") {
      if (settingsCount !== 1 || csvCount !== 0 || !text(args["structural-control-settings"])) {
        throw new Error("STRUCTURAL_CONTROL_SERVICE_JSON_ARGUMENT_INVALID");
      }
      const serviceSelectionProof = selectionProofCount === 1
        ? await readServiceStructuralControlSelectionProof(
          args["structural-control-selection-proof"],
          args["structural-control-settings"],
        )
        : null;
      return Object.freeze({
        argv: Object.freeze(withoutWrapperStructuralControlArguments(argv)),
        selection: Object.freeze({
          authority,
          status: "EXPLICIT_CLI_SETTINGS",
          path: path.resolve(args["structural-control-settings"]),
          ...serviceSelectionProof,
        }),
      });
    }
    if (authority === "service-none") {
      if (settingsCount !== 0 || csvCount !== 0) {
        throw new Error("STRUCTURAL_CONTROL_SERVICE_NONE_ARGUMENT_INVALID");
      }
      const serviceSelectionProof = selectionProofCount === 1
        ? await readServiceStructuralControlSelectionProof(args["structural-control-selection-proof"])
        : null;
      return Object.freeze({
        argv: Object.freeze(withoutWrapperStructuralControlArguments(argv)),
        selection: Object.freeze({ authority, status: "SERVICE_NO_SETTINGS", path: "", ...serviceSelectionProof }),
      });
    }
    if (selectionProofCount !== 0) throw new Error("STRUCTURAL_CONTROL_SERVICE_CSV_SELECTION_PROOF_INVALID");
    if (settingsCount !== 0 || csvCount !== 1 || !text(args["structural-control-settings-csv"])) {
      throw new Error("STRUCTURAL_CONTROL_SERVICE_CSV_ARGUMENT_INVALID");
    }
    csvPath = path.resolve(args["structural-control-settings-csv"]);
  } else if (selectionProofCount !== 0) {
    throw new Error("STRUCTURAL_CONTROL_SELECTION_PROOF_WITHOUT_SERVICE_AUTHORITY");
  } else if (settingsCount === 1 && text(args["structural-control-settings"])) {
    return Object.freeze({
      argv: Object.freeze([...argv]),
      selection: Object.freeze({ authority: "standalone", status: "EXPLICIT_CLI_SETTINGS", path: path.resolve(args["structural-control-settings"]) }),
    });
  } else if (settingsCount !== 0) {
    throw new Error("STRUCTURAL_CONTROL_SETTINGS_ARGUMENT_INVALID");
  } else if (csvCount === 1 && text(args["structural-control-settings-csv"])) {
    csvPath = path.resolve(args["structural-control-settings-csv"]);
  } else if (csvCount !== 0) {
    throw new Error("STRUCTURAL_CONTROL_SETTINGS_CSV_ARGUMENT_INVALID");
  }
  const kind = await pathKind(csvPath);
  if (kind === "missing") {
    if (authority === "service-csv") throw new Error(`STRUCTURAL_CONTROL_SERVICE_CSV_MISSING:${path.resolve(csvPath)}`);
    return Object.freeze({ argv: Object.freeze([...argv]), selection: Object.freeze({ authority: "standalone", status: "NO_USER_CSV", path: "" }) });
  }
  if (kind !== "file") throw new Error(`STRUCTURAL_CONTROL_SETTINGS_CSV_INVALID:${path.resolve(csvPath)}`);
  const reportPath = text(args.output) ? path.resolve(args.output) : "";
  if (!reportPath) throw new Error("OWNER_DECISION_R005_OUTPUT_REQUIRED");
  const settingsPath = reportPath.replace(/\.xlsx$/i, ".structural-control-settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const selection = await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: args.organization,
    period: args.period,
    outputPath: settingsPath,
  });
  const result = withoutWrapperStructuralControlArguments(argv);
  if (selection.path) result.push("--structural-control-settings", selection.path);
  return Object.freeze({
    argv: Object.freeze(result),
    selection: Object.freeze({ ...selection, authority: authority || "standalone" }),
  });
}
function nonzeroRows(payload) {
  const structuralControlGroups = closedStructuralControlGroups(payload);
  const partitions = Array.isArray(payload?.period_rows) && payload.period_rows.length > 0
    ? payload.period_rows
    : [{ period: text(payload?.period), rows: payload?.rows ?? [] }];
  return partitions.flatMap((partition) => (partition?.rows ?? [])
    .filter((row) =>
      !isOwnerPresentationBlockExempt(row, structuralControlGroups) &&
      typeof row?.delta === "number" &&
      Number.isFinite(row.delta) &&
      Math.abs(row.delta) > 0.009)
    .map((row) => ({ period: text(partition.period), code: text(row.code) })));
}

export function closedStructuralControlGroups(payload = {}) {
  const closedIds = new Set((Array.isArray(payload?.structural_group_control_results)
    ? payload.structural_group_control_results
    : [])
    .filter((result) => text(result?.classification) === "STRUCTURAL_GROUP_SUM_OK")
    .map((result) => text(result?.group_id ?? result?.control_set_id))
    .filter(Boolean));
  return (Array.isArray(payload?.structural_group_control_sets)
    ? payload.structural_group_control_sets
    : [])
    .filter((group) => closedIds.has(text(group?.group_id ?? group?.id)));
}
function linkedCaseIds(projection, period, code) {
  return projection?.period_row_links?.[period]?.[code]
    ?? projection?.row_links?.[code]
    ?? projection?.row_links?.[`${period}|${code}`]
    ?? [];
}
function rowCoverage(projection, period, code) {
  return projection?.period_row_coverage?.[period]?.[code]
    ?? projection?.owner_projection_coverage?.[code]
    ?? projection?.owner_projection_coverage?.[`${period}|${code}`]
    ?? null;
}
function explicitlyBlockedNonfinancial(projection, period, code) {
  const coverage = rowCoverage(projection, period, code);
  return coverage?.coverage_status === "EXPLICIT_NONFINANCIAL_BLOCKED"
    && Boolean(text(coverage?.causal_blocker))
    && coverage?.financial_rows === 0
    && coverage?.posting_rows === 0;
}
function nonzeroCodes(payload) {
  return nonzeroRows(payload).map((row) => `${row.period}|${row.code}`);
}
function caseSummary(projection) {
  return (projection?.cases ?? []).map((decisionCase) => ({
    case_id: decisionCase.case_id,
    pair_id: decisionCase.pair_id,
    classification: decisionCase.classification,
    decision_type: decisionCase.decision_type,
    amount: decisionCase.amount,
    status_text: decisionCase.status_text,
    proof_status: decisionCase.proof_status,
    period: decisionCase.period,
    member_rows: decisionCase.member_rows,
  }));
}

export async function enrichOwnerDecisionOutputs({
  reportPath,
  codexPath,
  manifestPath = "",
  policyPath = POLICY_PATH,
  structuralControlSettingsSelection = null,
} = {}) {
  if (!reportPath || !codexPath) throw new Error("OWNER_DECISION_OUTPUT_PATH_REQUIRED");
  const [payloadText, policyText] = await Promise.all([fs.readFile(codexPath, "utf8"), fs.readFile(policyPath, "utf8")]);
  const payload = JSON.parse(payloadText.replace(/^\uFEFF/, ""));
  const policy = JSON.parse(policyText.replace(/^\uFEFF/, ""));
  const structuralInventoryPlan = authoritativeStructuralInventoryPlanFromPayload(payload);
  const projection = projectOwnerEconomicDecisions(payload, { ownerAcceptancePolicy: policy?.accepted_classification_gaps ?? [] });
  const missing = nonzeroRows(payload).filter((row) =>
    !linkedCaseIds(projection, row.period, row.code).length
      && !explicitlyBlockedNonfinancial(projection, row.period, row.code));
  if (missing.length) {
    throw new Error(`OWNER_DECISION_UNCOVERED_NONZERO:${missing.map((row) =>
      `${row.period}|${row.code}`).join(",")}`);
  }
  if (projection.safety?.posting_rows !== 0 || projection.safety?.add_one_side_rows !== 0 || projection.safety?.storno_rows !== 0 || projection.safety?.repost_rows !== 0 || projection.safety?.execution_allowed !== false) {
    throw new Error("OWNER_DECISION_SAFETY_NOT_FAIL_CLOSED");
  }

  const worksheet = await appendOwnerDecisionExplanationSheet(reportPath, payload, projection);
  const reportSha = await sha256(reportPath);
  const byCase = new Map((projection.cases ?? []).map((decisionCase) => [decisionCase.case_id, decisionCase]));
  payload.owner_decisions = {
    ...projection,
    policy_sha256: crypto.createHash("sha256").update(policyText).digest("hex").toUpperCase(),
    explanation_sheet: worksheet.sheet_name,
  };
  if (structuralControlSettingsSelection) {
    const source = structuralControlSettingsSelection.source
      ?? structuralControlSettingsSelection.document?.source
      ?? null;
    payload.structural_control_settings_selection = {
      authority: text(structuralControlSettingsSelection.authority),
      status: text(structuralControlSettingsSelection.status),
      path: text(structuralControlSettingsSelection.path),
      materialization_status: text(structuralControlSettingsSelection.materialization_status),
      source_path: text(structuralControlSettingsSelection.source_path ?? source?.path),
      source_sha256: text(structuralControlSettingsSelection.source_sha256 ?? source?.sha256).toUpperCase(),
      source_size: Number(structuralControlSettingsSelection.source_size ?? source?.size ?? 0),
      selection_proof_path: text(structuralControlSettingsSelection.selection_proof_path),
      selection_proof_sha256: text(structuralControlSettingsSelection.selection_proof_sha256).toUpperCase(),
      selection_proof_size: Number(structuralControlSettingsSelection.selection_proof_size ?? 0),
      verified_settings_path: text(structuralControlSettingsSelection.verified_settings_path),
      verified_settings_sha256: text(structuralControlSettingsSelection.verified_settings_sha256).toUpperCase(),
      verified_settings_size: Number(structuralControlSettingsSelection.verified_settings_size ?? 0),
      verified_settings_id: text(structuralControlSettingsSelection.verified_settings_id),
      verified_set_count: Number(structuralControlSettingsSelection.verified_set_count ?? 0),
      verified_set_ids: [...(structuralControlSettingsSelection.verified_set_ids ?? [])].map(text),
      verified_sets_sha256: text(structuralControlSettingsSelection.verified_sets_sha256).toUpperCase(),
    };
  }
  const closedGroups = closedStructuralControlGroups(payload);
  payload.rows = (payload.rows ?? []).map((row) => {
    const presentationBlockExempt = isOwnerPresentationBlockExempt(
      row,
      closedGroups,
    );
    const caseIds = [...new Set((projection.cases ?? [])
      .filter((decisionCase) => (decisionCase.member_rows ?? []).some((member) => text(member.code) === text(row.code)))
      .map((decisionCase) => decisionCase.case_id))];
    const cases = caseIds.map((caseId) => byCase.get(caseId)).filter(Boolean);
    const coverage = rowCoverage(projection, text(row?.period), text(row?.code));
    return {
      ...row,
      owner_presentation_block_exempt: presentationBlockExempt,
      owner_control_classification: presentationBlockExempt
        ? OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION
        : "",
      owner_case_ids: caseIds,
      owner_decision_classes: cases.map((decisionCase) => decisionCase.classification),
      owner_decision_statuses: cases.map((decisionCase) => decisionCase.status_text),
      owner_decision_proof_statuses: cases.map((decisionCase) => decisionCase.proof_status),
      owner_decision_reasons: cases.map((decisionCase) => decisionCase.reason),
      owner_decision_solutions: cases.map((decisionCase) => decisionCase.solution),
      owner_projection_coverage_status: coverage?.coverage_status ?? "",
      owner_projection_causal_blocker: coverage?.causal_blocker ?? "",
    };
  });
  bindFinalReportCrossLinks(payload, { reportPath, reportSha256: reportSha });
  bindAuthoritativeStructuralInventoryPlan(payload, structuralInventoryPlan);
  await writeJson(codexPath, payload);
  const codexSha = await sha256(codexPath);

  let structuralInventory = null;
  if (manifestPath) {
    try {
      const manifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
      bindFinalManifestCrossLinks(manifest, {
        reportPath,
        reportSha256: reportSha,
        codexInputPath: codexPath,
        codexInputSha256: codexSha,
      });
      manifest.owner_decisions = {
        schema: projection.schema,
        case_count: projection.cases.length,
        mapped_nonzero_rows: nonzeroRows(payload).length,
        owner_case_mapped_nonzero_rows: nonzeroRows(payload).filter((row) =>
          linkedCaseIds(projection, row.period, row.code).length > 0).length,
        explicitly_blocked_nonfinancial_rows: nonzeroRows(payload).filter((row) =>
          explicitlyBlockedNonfinancial(projection, row.period, row.code)).length,
        owner_projection_coverage: projection.owner_projection_coverage,
        presentation_block_exempt_rows:
          projection.presentation_block_exemptions?.length ?? 0,
        cases: caseSummary(projection),
        safety: projection.safety,
        explanation_sheet: worksheet.sheet_name,
      };
      bindAuthoritativeStructuralInventoryPlan(manifest, structuralInventoryPlan);
      await writeJson(manifestPath, manifest);
      if (structuralInventoryPlan) {
        structuralInventory = await materializeStructuralControlInventoryV3({
          outputDirectory: path.dirname(reportPath),
          ...structuralInventoryPlan.input,
          currentRunFiles: {
            reportPath,
            codexInputPath: codexPath,
            manifestPath,
          },
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    projection,
    report_sha256: reportSha,
    codex_sha256: codexSha,
    explanation_sheet: worksheet.sheet_name,
    structural_control_inventory: structuralInventory?.audit ?? null,
  };
}

async function runCore(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE_SCRIPT, ...argv], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`R005_CORE_FAILED:${signal || code}`)));
  });
}

async function materializeServiceStructuralControlSettings(argv) {
  const args = parseArgs(argv);
  const csvPath = text(args["structural-control-settings-csv"]);
  const outputPath = text(args.output);
  const selectionOutput = text(args["selection-output"]);
  if (!csvPath || !outputPath || !selectionOutput) {
    throw new Error("STRUCTURAL_CONTROL_SERVICE_MATERIALIZATION_ARGUMENT_REQUIRED");
  }
  const selection = await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: args.organization,
    period: args.period,
    outputPath,
  });
  const source = selection.source ?? selection.document?.source ?? null;
  const proof = {
    schema: "opiu-service-structural-control-selection.v1",
    authority: "service-csv",
    status: text(selection.status),
    path: text(selection.path),
    source_path: text(source?.path),
    source_sha256: text(source?.sha256).toUpperCase(),
    source_size: Number(source?.size ?? 0),
  };
  await writeJsonImmutable(selectionOutput, proof);
  console.log(JSON.stringify(proof));
}

export async function verifyServiceStructuralControlSettings({
  csvPath,
  settingsPath,
  organization,
  period,
  outputPath,
} = {}) {
  if (![csvPath, settingsPath, organization, period, outputPath].every((value) => text(value))) {
    throw new Error("STRUCTURAL_CONTROL_SERVICE_VERIFICATION_ARGUMENT_REQUIRED");
  }
  const settingsBefore = await readBoundedRegularFile(
    settingsPath,
    STRUCTURAL_CONTROL_SETTINGS_MAX_BYTES,
    "STRUCTURAL_CONTROL_SERVICE_SETTINGS_UNSAFE",
  );
  const sourceBefore = await readBoundedRegularFile(
    csvPath,
    STRUCTURAL_CONTROL_SELECTION_PROOF_MAX_BYTES,
    "STRUCTURAL_CONTROL_SERVICE_CSV_UNSAFE",
  );
  const loaded = await loadStructuralControlSettingsDocument(settingsBefore.resolved, { organization, period });
  const settingsAfter = await readBoundedRegularFile(
    settingsPath,
    STRUCTURAL_CONTROL_SETTINGS_MAX_BYTES,
    "STRUCTURAL_CONTROL_SERVICE_SETTINGS_UNSAFE",
  );
  const sourceAfter = await readBoundedRegularFile(
    csvPath,
    STRUCTURAL_CONTROL_SELECTION_PROOF_MAX_BYTES,
    "STRUCTURAL_CONTROL_SERVICE_CSV_UNSAFE",
  );
  const settingsSHA = crypto.createHash("sha256").update(settingsBefore.bytes).digest("hex").toUpperCase();
  const sourceSHA = crypto.createHash("sha256").update(sourceBefore.bytes).digest("hex").toUpperCase();
  if (settingsSHA !== crypto.createHash("sha256").update(settingsAfter.bytes).digest("hex").toUpperCase() ||
      sourceSHA !== crypto.createHash("sha256").update(sourceAfter.bytes).digest("hex").toUpperCase() ||
      loaded.audit?.status !== "ACTIVE_EXACT_ORGANIZATION_MONTH" ||
      path.resolve(text(loaded.audit?.input_path)) !== settingsBefore.resolved ||
      text(loaded.audit?.input_sha256).toUpperCase() !== settingsSHA || Number(loaded.audit?.input_size) !== settingsBefore.size ||
      text(loaded.audit?.source_sha256).toUpperCase() !== sourceSHA || Number(loaded.audit?.source_size) !== sourceBefore.size ||
      path.resolve(text(loaded.document?.source?.path)) !== sourceBefore.resolved) {
    throw new Error("STRUCTURAL_CONTROL_SERVICE_VERIFICATION_DRIFT");
  }
  const sets = loaded.document?.structural_group_control_sets;
  const setIDs = Array.isArray(sets) ? sets.map((set) => text(set?.id)) : [];
  if (setIDs.length < 1 || setIDs.some((id) => !id) || new Set(setIDs).size !== setIDs.length) {
    throw new Error("STRUCTURAL_CONTROL_SERVICE_VERIFICATION_SETS_INVALID");
  }
  const proof = {
    schema: "opiu-service-structural-control-verification.v1",
    authority: "service-csv",
    status: "EXACT_ORGANIZATION_MATERIALIZED",
    path: settingsBefore.resolved,
    source_path: sourceBefore.resolved,
    source_sha256: sourceSHA,
    source_size: sourceBefore.size,
    settings_path: settingsBefore.resolved,
    settings_sha256: settingsSHA,
    settings_size: settingsBefore.size,
    settings_id: text(loaded.document.settings_id),
    set_count: setIDs.length,
    set_ids: setIDs,
    sets_sha256: crypto.createHash("sha256").update(JSON.stringify(sets)).digest("hex").toUpperCase(),
  };
  await writeJsonImmutable(path.resolve(outputPath), proof);
  return Object.freeze(proof);
}

async function verifyServiceStructuralControlSettingsCommand(argv) {
  const args = parseArgs(argv);
  const proof = await verifyServiceStructuralControlSettings({
    csvPath: args["structural-control-settings-csv"],
    settingsPath: args["structural-control-settings"],
    organization: args.organization,
    period: args.period,
    outputPath: args["verification-output"],
  });
  console.log(JSON.stringify(proof));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "materialize-structural-control-settings") {
    await materializeServiceStructuralControlSettings(argv.slice(1));
    return;
  }
  if (argv[0] === "verify-structural-control-settings") {
    await verifyServiceStructuralControlSettingsCommand(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);
  const reportPath = text(args.output) ? path.resolve(args.output) : "";
  if (!reportPath) throw new Error("OWNER_DECISION_R005_OUTPUT_REQUIRED");
  const proofInput = await coreArgsWithOwnerEconomicRouteProof(argv);
  const structuralInput = await coreArgsWithUserStructuralControlSettings(proofInput.argv);
  await runCore(structuralInput.argv);
  const codexPath = reportPath.replace(/\.xlsx$/i, ".codex-input.json");
  const manifestPath = reportPath.replace(/\.xlsx$/i, ".manifest.json");
  const result = await enrichOwnerDecisionOutputs({
    reportPath,
    codexPath,
    manifestPath,
    structuralControlSettingsSelection: structuralInput.selection,
  });
  console.log(JSON.stringify({
    owner_decision_wrapper: "R005",
    cases: result.projection.cases.length,
    mapped_nonzero_rows: nonzeroCodes(JSON.parse(await fs.readFile(codexPath, "utf8"))).length,
    presentation_block_exempt_rows:
      result.projection.presentation_block_exemptions?.length ?? 0,
    add_one_side_rows: 0,
    posting_rows: 0,
    report_sha256: result.report_sha256,
    codex_sha256: result.codex_sha256,
    explanation_sheet: result.explanation_sheet,
    structural_control_inventory: result.structural_control_inventory,
    economic_route_proof_selection: {
      status: proofInput.selection.status,
      path: proofInput.selection.path || "",
    },
    structural_control_settings_selection: {
      status: structuralInput.selection.status,
      path: structuralInput.selection.path || "",
    },
  }));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
