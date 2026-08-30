import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SERVICE_HANDOFF_SCHEMA = "opiu-service-r005-r001-handoff.v1";
export const SERVICE_HANDOFF_ARTIFACT_TYPE = "R005_R001_SERVICE_HANDOFF";

const SHA256 = /^[A-F0-9]{64}$/u;
const FORBIDDEN_DIRECT_INPUTS = new Set(["rules", "applications", "decisions", "financial_rows"]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}
function text(value) { return String(value ?? "").trim(); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SERVICE_HANDOFF_OBJECT_REQUIRED", label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("SERVICE_HANDOFF_EXACT_SCHEMA_MISMATCH", `${label}:${actual.join(",")}`);
  }
}

// JSON.parse discards duplicate members. Scan the original bytes first so an
// attacker cannot smuggle an alternate value behind the same key.
export function rejectDuplicateJsonKeys(source) {
  let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const whitespace = () => { while (/\s/u.test(source[index] ?? "")) index += 1; };
  const stringToken = () => {
    if (source[index] !== '"') fail("SERVICE_HANDOFF_JSON_INVALID", `string@${index}`);
    const start = index;
    index += 1;
    while (index < source.length) {
      const current = source[index];
      if (current === "\\") { index += 2; continue; }
      if (current === '"') {
        index += 1;
        try { return JSON.parse(source.slice(start, index)); }
        catch { fail("SERVICE_HANDOFF_JSON_INVALID", `escape@${start}`); }
      }
      if (current.charCodeAt(0) < 0x20) fail("SERVICE_HANDOFF_JSON_INVALID", `control@${index}`);
      index += 1;
    }
    fail("SERVICE_HANDOFF_JSON_INVALID", "unterminated-string");
  };
  const value = () => {
    whitespace();
    if (source[index] === "{") {
      index += 1; whitespace();
      const keys = new Set();
      if (source[index] === "}") { index += 1; return; }
      while (index < source.length) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) fail("SERVICE_HANDOFF_DUPLICATE_KEY", key);
        keys.add(key);
        whitespace();
        if (source[index] !== ":") fail("SERVICE_HANDOFF_JSON_INVALID", `colon@${index}`);
        index += 1; value(); whitespace();
        if (source[index] === "}") { index += 1; return; }
        if (source[index] !== ",") fail("SERVICE_HANDOFF_JSON_INVALID", `object@${index}`);
        index += 1;
      }
      fail("SERVICE_HANDOFF_JSON_INVALID", "unterminated-object");
    }
    if (source[index] === "[") {
      index += 1; whitespace();
      if (source[index] === "]") { index += 1; return; }
      while (index < source.length) {
        value(); whitespace();
        if (source[index] === "]") { index += 1; return; }
        if (source[index] !== ",") fail("SERVICE_HANDOFF_JSON_INVALID", `array@${index}`);
        index += 1;
      }
      fail("SERVICE_HANDOFF_JSON_INVALID", "unterminated-array");
    }
    if (source[index] === '"') { stringToken(); return; }
    const match = source.slice(index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u);
    if (!match) fail("SERVICE_HANDOFF_JSON_INVALID", `value@${index}`);
    index += match[0].length;
  };
  value(); whitespace();
  if (index !== source.length) fail("SERVICE_HANDOFF_JSON_INVALID", `trailing@${index}`);
}

function parseStrictJson(source, label) {
  rejectDuplicateJsonKeys(source);
  try { return JSON.parse(source.replace(/^\uFEFF/u, "")); }
  catch (error) { fail("SERVICE_HANDOFF_JSON_INVALID", `${label}:${error.message}`); }
}

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}
function idsDigest(values) {
  return crypto.createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex").toUpperCase();
}
function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.normalize(path.resolve(text(value)));
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}
function sameRunPath(value, expected, runRoot) {
  const candidate = text(value);
  if (!candidate) return false;
  if (path.isAbsolute(candidate)) return samePath(candidate, expected);
  if (candidate.replaceAll("\\", "/").split("/").some((segment) => segment === "." || segment === "..")) return false;
  return samePath(path.resolve(runRoot, candidate), expected);
}
async function verifyArtifact(ref, label) {
  exactKeys(ref, ["path", "size", "sha256"], label);
  const resolved = path.resolve(text(ref.path));
  if (!text(ref.path) || !Number.isInteger(ref.size) || ref.size < 0 || !SHA256.test(text(ref.sha256))) {
    fail("SERVICE_HANDOFF_ARTIFACT_INVALID", label);
  }
  const stat = await fs.stat(resolved).catch(() => fail("SERVICE_HANDOFF_ARTIFACT_MISSING", label));
  if (!stat.isFile() || stat.size !== ref.size || await sha256(resolved) !== ref.sha256) {
    fail("SERVICE_HANDOFF_ARTIFACT_DRIFT", label);
  }
  return resolved;
}
async function verifyJournal(ref) {
  exactKeys(ref, ["path", "size", "sha256", "sheet"], "physical_evidence.erp_journal");
  if (!text(ref.sheet)) fail("SERVICE_HANDOFF_JOURNAL_SHEET_REQUIRED");
  return verifyArtifact({ path: ref.path, size: ref.size, sha256: ref.sha256 }, "physical_evidence.erp_journal");
}
function closedSafety(safety) {
  exactKeys(safety, ["mode", "posting_rows", "ready_to_upload", "release_allowed", "execution_allowed", "live_1c_allowed"], "safety");
  return safety.mode === "REPORT_ONLY" && safety.posting_rows === 0 && safety.ready_to_upload === false &&
    safety.release_allowed === false && safety.execution_allowed === false && safety.live_1c_allowed === false;
}
function closedR005(value) {
  return value?.report_only === true && value?.posting_rows === 0 && value?.executed_posting_rows === 0 &&
    value?.live_posting_rows === 0 && value?.execution_allowed === false && value?.ready_to_upload === false &&
    value?.release_allowed === false && value?.live_1c_allowed === false && value?.live_delete_allowed === false;
}
function exactPhysicalIdsFromCodex(codex, erpPackageSha) {
  const cross = codex?.cross_journal_discrepancy_evidence;
  const operation = codex?.operation_evidence;
  let journal = null;
  let ids = [];
  let reuse = 0;
  if (cross?.applicable === true) {
    journal = cross?.sources?.erp ?? null;
    ids = (cross.rows ?? [])
      .filter((row) => text(row?.financial_gate_status) === "ДОКАЗАНО")
      .map((row) => {
        if (text(row?.source_archive_sha256) && text(row.source_archive_sha256).toUpperCase() !== erpPackageSha) {
          fail("SERVICE_HANDOFF_ERP_PACKAGE_SCOPE_DRIFT");
        }
        return text(row?.erp_source_row_id);
      }).filter(Boolean);
    reuse = Number(cross?.counts?.reused_intalev_rows ?? 0) + Number(cross?.counts?.reused_erp_rows ?? 0);
  } else if (operation) {
    journal = {
      path: operation?.input?.journal_source,
      sha256: operation?.journal_sha256,
      sheet: operation?.journal_sheet,
    };
    ids = (operation.rows ?? []).filter((row) => text(row?.evidence_status) === "PROVEN")
      .map((row) => text(row?.source_row_id)).filter(Boolean);
  }
  if (reuse !== 0) fail("SERVICE_HANDOFF_PHYSICAL_ROW_REUSED");
  const unique = [...new Set(ids)].sort();
  if (unique.length !== ids.length) fail("SERVICE_HANDOFF_PHYSICAL_ROW_DUPLICATE");
  return { ids: unique, journal };
}

export function assertNoDirectR001Overrides(args = {}) {
  for (const key of ["decisions", "rules", "applications", "reconciliation", "codex-input", "structural-control-proof", "period", "organization", "run-id", "organization-id"]) {
    if (Object.hasOwn(args, key)) fail("R001_DIRECT_SOURCE_OVERRIDE_FORBIDDEN", key);
  }
}

export async function verifyServiceR001Handoff({ handoffPath, handoffSha256 } = {}) {
  const resolvedHandoff = path.resolve(text(handoffPath));
  const expectedHash = text(handoffSha256).toUpperCase();
  if (!text(handoffPath)) fail("SERVICE_HANDOFF_PATH_REQUIRED");
  if (!SHA256.test(expectedHash)) fail("SERVICE_HANDOFF_SHA256_REQUIRED");
  if (path.basename(resolvedHandoff) !== "r005-r001-service-handoff.json" || path.basename(path.dirname(resolvedHandoff)) !== "handoff") {
    fail("SERVICE_HANDOFF_PATH_NOT_CANONICAL");
  }
  const raw = await fs.readFile(resolvedHandoff, "utf8").catch((error) => fail("SERVICE_HANDOFF_UNREADABLE", error.message));
  const runRoot = path.resolve(path.dirname(path.dirname(resolvedHandoff)));
  const actualHash = crypto.createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex").toUpperCase();
  if (actualHash !== expectedHash) fail("SERVICE_HANDOFF_HASH_MISMATCH");
  const sidecar = text(await fs.readFile(`${resolvedHandoff}.sha256`, "utf8").catch(() => ""));
  if (sidecar !== actualHash) fail("SERVICE_HANDOFF_SIDECAR_MISMATCH");
  const handoff = parseStrictJson(raw, "handoff");

  exactKeys(handoff, ["schema_version", "artifact_type", "run_id", "source_run_id", "context_id", "organization", "period", "sources", "r005", "structural", "physical_evidence", "cross_checks", "safety"], "handoff");
  if (handoff.schema_version !== SERVICE_HANDOFF_SCHEMA || handoff.artifact_type !== SERVICE_HANDOFF_ARTIFACT_TYPE) fail("SERVICE_HANDOFF_SCHEMA_MISMATCH");
  for (const forbidden of FORBIDDEN_DIRECT_INPUTS) if (Object.hasOwn(handoff, forbidden)) fail("SERVICE_HANDOFF_AUTHORITY_FORBIDDEN", forbidden);
  if (!text(handoff.run_id) || handoff.source_run_id !== handoff.run_id || !text(handoff.context_id) || !text(handoff.period)) fail("SERVICE_HANDOFF_SCOPE_REQUIRED");
  exactKeys(handoff.organization, ["id", "name", "hierarchy_path"], "organization");
  if (![handoff.organization.id, handoff.organization.name, handoff.organization.hierarchy_path].every((value) => text(value))) fail("SERVICE_HANDOFF_ORGANIZATION_REQUIRED");
  exactKeys(handoff.sources, ["erp", "intalev"], "sources");
  exactKeys(handoff.r005, ["workbook", "codex_input", "manifest"], "r005");
  exactKeys(handoff.structural, ["inventory", "inventory_binding", "proof", "proof_binding"], "structural");
  exactKeys(handoff.physical_evidence, ["status", "erp_package", "erp_journal", "source_row_ids", "source_row_ids_sha256", "unique_count", "reuse_count"], "physical_evidence");
  exactKeys(handoff.physical_evidence.erp_package, ["path", "size", "sha256"], "physical_evidence.erp_package");
  exactKeys(handoff.cross_checks, ["manifest_schema", "codex_input_schema", "scope_verified", "source_hashes_verified", "r005_hashes_verified", "structural_inventory_verified", "structural_proof_verified", "physical_evidence_bound"], "cross_checks");
  if (!closedSafety(handoff.safety)) fail("SERVICE_HANDOFF_SAFETY_MISMATCH");
  if (handoff.cross_checks.manifest_schema !== "opiu-auto-reconciliation-run-v3" || handoff.cross_checks.codex_input_schema !== "opiu-codex-review-input-v1" ||
    ["scope_verified", "source_hashes_verified", "r005_hashes_verified", "structural_inventory_verified", "structural_proof_verified", "physical_evidence_bound"].some((key) => handoff.cross_checks[key] !== true)) {
    fail("SERVICE_HANDOFF_CROSS_CHECKS_INCOMPLETE");
  }

  const [erpPath, intalevPath, workbookPath, codexPath, manifestPath, inventoryPath, inventoryBindingPath, proofPath, proofBindingPath, journalPath] = await Promise.all([
    verifyArtifact(handoff.sources.erp, "sources.erp"), verifyArtifact(handoff.sources.intalev, "sources.intalev"),
    verifyArtifact(handoff.r005.workbook, "r005.workbook"), verifyArtifact(handoff.r005.codex_input, "r005.codex_input"),
    verifyArtifact(handoff.r005.manifest, "r005.manifest"), verifyArtifact(handoff.structural.inventory, "structural.inventory"),
    verifyArtifact(handoff.structural.inventory_binding, "structural.inventory_binding"), verifyArtifact(handoff.structural.proof, "structural.proof"),
    verifyArtifact(handoff.structural.proof_binding, "structural.proof_binding"), verifyJournal(handoff.physical_evidence.erp_journal),
  ]);
  if (!samePath(handoff.physical_evidence.erp_package.path, erpPath) || handoff.physical_evidence.erp_package.sha256 !== handoff.sources.erp.sha256 || handoff.physical_evidence.erp_package.size !== handoff.sources.erp.size) fail("SERVICE_HANDOFF_ERP_PACKAGE_BINDING_MISMATCH");

  const [codexRaw, manifestRaw, inventoryBindingRaw, proofRaw, proofBindingRaw] = await Promise.all([
    fs.readFile(codexPath, "utf8"), fs.readFile(manifestPath, "utf8"), fs.readFile(inventoryBindingPath, "utf8"), fs.readFile(proofPath, "utf8"), fs.readFile(proofBindingPath, "utf8"),
  ]);
  const codex = parseStrictJson(codexRaw, "r005.codex_input");
  const manifest = parseStrictJson(manifestRaw, "r005.manifest");
  const inventoryBinding = parseStrictJson(inventoryBindingRaw, "structural.inventory_binding");
  const proof = parseStrictJson(proofRaw, "structural.proof");
  const proofBinding = parseStrictJson(proofBindingRaw, "structural.proof_binding");
  if (codex.schema !== "opiu-codex-review-input-v1" || manifest.schema !== "opiu-auto-reconciliation-run-v3" ||
    codex.organization !== handoff.organization.name || manifest.organization !== handoff.organization.name ||
    text(codex.organization_code) !== handoff.organization.id || text(manifest.organization_code) !== handoff.organization.id ||
    codex.period !== handoff.period || manifest.period !== handoff.period || !closedR005(codex) || !closedR005(manifest)) fail("SERVICE_HANDOFF_R005_SCOPE_MISMATCH");
  if (!samePath(codex.report_path, workbookPath) || text(codex.report_sha256).toUpperCase() !== handoff.r005.workbook.sha256 ||
    !samePath(manifest.output_path, workbookPath) || text(manifest.output_sha256).toUpperCase() !== handoff.r005.workbook.sha256 ||
    !samePath(manifest.codex_input_path, codexPath) || text(manifest.codex_input_sha256).toUpperCase() !== handoff.r005.codex_input.sha256) fail("SERVICE_HANDOFF_R005_CROSS_LINK_MISMATCH");
  if (inventoryBinding.run_id !== handoff.run_id || inventoryBinding.context_id !== handoff.context_id ||
    inventoryBinding.organization_id !== handoff.organization.id || inventoryBinding.organization_name !== handoff.organization.name ||
    inventoryBinding.organization_path !== handoff.organization.hierarchy_path || inventoryBinding.period !== handoff.period ||
    inventoryBinding.verified !== true || text(inventoryBinding.sha256).toUpperCase() !== handoff.structural.inventory.sha256) fail("SERVICE_HANDOFF_STRUCTURAL_INVENTORY_MISMATCH");
  if (proof.schema_version !== "opiu-structural-control-proof.v1" || proof.report_only !== true || proof.financial_rows !== 0 || proof.posting_rows !== 0 || proof.correction_authority !== false || proof.execution_allowed !== false) fail("SERVICE_HANDOFF_STRUCTURAL_PROOF_UNSAFE");
  if (proofBinding.schema_version !== "opiu-service-structural-control-proof-binding.v1" || proofBinding.run_id !== handoff.run_id || proofBinding.context_id !== handoff.context_id ||
    proofBinding.organization_id !== handoff.organization.id || proofBinding.organization_name !== handoff.organization.name || proofBinding.organization_path !== handoff.organization.hierarchy_path || proofBinding.period !== handoff.period ||
    !sameRunPath(proofBinding.codex_input?.path, codexPath, runRoot) || text(proofBinding.codex_input?.sha256).toUpperCase() !== handoff.r005.codex_input.sha256 ||
    !sameRunPath(proofBinding.proof?.path, proofPath, runRoot) || text(proofBinding.proof?.sha256).toUpperCase() !== handoff.structural.proof.sha256) fail("SERVICE_HANDOFF_STRUCTURAL_PROOF_BINDING_MISMATCH");

  const physical = handoff.physical_evidence;
  if (physical.status !== "VERIFIED_JOURNAL_REPORT_ONLY" || physical.reuse_count !== 0 || !Array.isArray(physical.source_row_ids) ||
    physical.source_row_ids.some((value) => !text(value)) || physical.unique_count !== physical.source_row_ids.length ||
    new Set(physical.source_row_ids).size !== physical.source_row_ids.length || JSON.stringify([...physical.source_row_ids].sort()) !== JSON.stringify(physical.source_row_ids) ||
    idsDigest(physical.source_row_ids) !== physical.source_row_ids_sha256) fail("SERVICE_HANDOFF_PHYSICAL_DIGEST_MISMATCH");
  const derived = exactPhysicalIdsFromCodex(codex, handoff.sources.erp.sha256);
  if (JSON.stringify(derived.ids) !== JSON.stringify(physical.source_row_ids) || !derived.journal ||
    !samePath(derived.journal.path, journalPath) || text(derived.journal.sha256).toUpperCase() !== physical.erp_journal.sha256 || text(derived.journal.sheet) !== physical.erp_journal.sheet) fail("SERVICE_HANDOFF_PHYSICAL_BINDING_MISMATCH");

  return {
    handoffPath: resolvedHandoff, handoffSha256: actualHash,
    runId: handoff.run_id, sourceRunId: handoff.source_run_id, contextId: handoff.context_id,
    organizationId: handoff.organization.id, organizationName: handoff.organization.name,
    organizationPath: handoff.organization.hierarchy_path, period: handoff.period,
    erpPath, intalevPath, reconciliationPath: workbookPath, codexInputPath: codexPath, manifestPath,
    inventoryPath, inventoryBindingPath, structuralControlProofPath: proofPath, structuralControlProofBindingPath: proofBindingPath,
    journalPath, sourceRowIDs: [...physical.source_row_ids], document: handoff,
  };
}
