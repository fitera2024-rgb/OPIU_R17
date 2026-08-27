import crypto from "node:crypto";

const ACTIVE_STATUS = "ACTIVE_EXACT_ORGANIZATION_MONTH";
const DEFAULT_STATUS = "MISSING_DEFAULT_ALL_GROUPS";

function text(value) {
  return String(value ?? "").trim();
}

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("STRUCTURAL_CONTROL_PROOF_NONFINITE_NUMBER");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") fail("STRUCTURAL_CONTROL_PROOF_UNSUPPORTED_VALUE");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalStructuralControlSHA256(value) {
  const serialized = JSON.stringify(canonicalValue(value));
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex").toUpperCase();
}

function requireZero(value, label) {
  if (Number(value) !== 0) fail("STRUCTURAL_CONTROL_PROOF_UNSAFE_NONZERO", label);
}

function requireFalse(value, label) {
  if (value !== false) fail("STRUCTURAL_CONTROL_PROOF_UNSAFE_TRUE_OR_MISSING", label);
}

function normalizedAppliedVersionIds(binding) {
  const registry = binding?.ui_fixed_registry;
  const exactVersions = Array.isArray(registry?.active_versions) ? registry.active_versions : [];
  const ids = exactVersions.length > 0
    ? exactVersions.map((version) => {
        const controlSetId = text(version?.control_set_id);
        const versionNumber = Number(version?.version);
        const payloadSHA256 = text(version?.payload_sha256).toUpperCase();
        if (!controlSetId || !Number.isInteger(versionNumber) || versionNumber < 1
          || !/^[0-9A-F]{64}$/.test(payloadSHA256)) {
          fail("STRUCTURAL_CONTROL_PROOF_APPLIED_VERSION_INVALID");
        }
        return `${controlSetId}@${versionNumber}:${payloadSHA256}`;
      })
    : Array.isArray(registry?.control_set_ids)
      ? registry.control_set_ids.map(text)
      : Array.isArray(binding?.sets)
        ? binding.sets.map((set) => text(set?.id))
        : [];
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    fail("STRUCTURAL_CONTROL_PROOF_APPLIED_VERSION_DUPLICATE_OR_EMPTY");
  }
  return ids.sort((left, right) => left.localeCompare(right, "en"));
}

export function structuralControlProofFromCodexPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("STRUCTURAL_CONTROL_PROOF_CODEX_PAYLOAD_INVALID");
  }
  if (payload.report_only !== true) fail("STRUCTURAL_CONTROL_PROOF_REPORT_ONLY_REQUIRED");
  requireZero(payload.posting_rows, "codex.posting_rows");
  requireFalse(payload.ready_to_upload, "codex.ready_to_upload");
  requireFalse(payload.release_allowed, "codex.release_allowed");

  const binding = payload.structural_control_settings_binding ?? null;
  const results = payload.structural_group_control_results ?? [];
  if (!Array.isArray(results)) fail("STRUCTURAL_CONTROL_PROOF_RESULTS_NOT_ARRAY");

  if (binding !== null) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      fail("STRUCTURAL_CONTROL_PROOF_BINDING_INVALID");
    }
    requireZero(binding.financial_rows, "binding.financial_rows");
    requireZero(binding.posting_rows, "binding.posting_rows");
    requireFalse(binding.correction_authority, "binding.correction_authority");
    requireFalse(binding.execution_allowed, "binding.execution_allowed");
  } else if (results.length !== 0) {
    fail("STRUCTURAL_CONTROL_PROOF_RESULTS_WITHOUT_BINDING");
  }

  for (const [index, result] of results.entries()) {
    requireZero(result?.financial_rows, `results[${index}].financial_rows`);
    requireZero(result?.posting_rows, `results[${index}].posting_rows`);
    requireFalse(result?.execution_allowed, `results[${index}].execution_allowed`);
    if (result?.posting_allowed !== undefined) requireFalse(result.posting_allowed, `results[${index}].posting_allowed`);
  }

  const settingsStatus = text(binding?.status) || DEFAULT_STATUS;
  const appliedVersionIds = normalizedAppliedVersionIds(binding);
  const setCount = Number(binding?.set_count ?? binding?.sets?.length ?? 0);
  if (!Number.isInteger(setCount) || setCount < 0) fail("STRUCTURAL_CONTROL_PROOF_SET_COUNT_INVALID");
  if (settingsStatus === ACTIVE_STATUS && (setCount === 0 || appliedVersionIds.length !== setCount)) {
    fail("STRUCTURAL_CONTROL_PROOF_ACTIVE_VERSION_COUNT_MISMATCH");
  }
  if (settingsStatus === DEFAULT_STATUS && (setCount !== 0 || appliedVersionIds.length !== 0 || results.length !== 0)) {
    fail("STRUCTURAL_CONTROL_PROOF_DEFAULT_STATE_MISMATCH");
  }

  const settingsBindingSHA256 = canonicalStructuralControlSHA256(binding);
  const controlResultsSHA256 = canonicalStructuralControlSHA256(results);
  const proofSHA256 = canonicalStructuralControlSHA256({
    structural_control_settings_binding: binding,
    structural_group_control_results: results,
  });
  return Object.freeze({
    schema_version: "opiu-structural-control-proof.v1",
    status: settingsStatus === DEFAULT_STATUS ? "NO_ACTIVE_DEFAULT_ALL_GROUPS" : "ACTIVE_VERIFIED",
    settings_status: settingsStatus,
    settings_binding_sha256: settingsBindingSHA256,
    control_results_sha256: controlResultsSHA256,
    structural_control_proof_sha256: proofSHA256,
    set_count: setCount,
    control_result_count: results.length,
    applied_version_ids: Object.freeze(appliedVersionIds),
    report_only: true,
    financial_rows: 0,
    posting_rows: 0,
    correction_authority: false,
    execution_allowed: false,
  });
}

export function verifyStructuralControlProofDescriptor(descriptor, payload) {
  const expected = structuralControlProofFromCodexPayload(payload);
  if (canonicalStructuralControlSHA256(descriptor) !== canonicalStructuralControlSHA256(expected)) {
    fail("STRUCTURAL_CONTROL_PROOF_DESCRIPTOR_MISMATCH");
  }
  return expected;
}
