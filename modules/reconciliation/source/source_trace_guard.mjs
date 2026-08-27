import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[A-F0-9]{64}$/;

export class SourceTraceError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "SourceTraceError";
    this.code = code;
    this.details = details;
  }
}

function block(code, details = {}) {
  throw new SourceTraceError(code, details);
}

function requiredText(value, field, details = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) block("BLOCKED_EXACT_SOURCE_TRACE_INCOMPLETE", { field, ...details });
  return normalized;
}

async function fileEvidence(filePath, role) {
  const resolvedPath = path.resolve(requiredText(filePath, "file_path", { role }));
  try {
    const bytes = await fs.readFile(resolvedPath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) block("BLOCKED_SOURCE_NOT_FILE", { role, path: resolvedPath });
    return {
      path: resolvedPath,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    };
  } catch (error) {
    if (error instanceof SourceTraceError) throw error;
    block("BLOCKED_SOURCE_UNREADABLE", {
      role,
      path: resolvedPath,
      reason: error?.code ?? "READ_FAILED",
    });
  }
}

export async function captureSourceEvidence({ role, filePath, expectedSha256 = null }) {
  const normalizedRole = requiredText(role, "role");
  const evidence = await fileEvidence(filePath, normalizedRole);
  const expected = expectedSha256 ? String(expectedSha256).trim().toUpperCase() : null;
  if (expected && (!SHA256_PATTERN.test(expected) || evidence.sha256 !== expected)) {
    block("SOURCE_DRIFT", {
      phase: "PRE_READ",
      role: normalizedRole,
      path: evidence.path,
      expected_sha256: expected,
      actual_sha256: evidence.sha256,
    });
  }
  return Object.freeze({
    role: normalizedRole,
    path: evidence.path,
    size_before: evidence.size,
    sha256_before: evidence.sha256,
    status: "CAPTURED_BEFORE_READ",
  });
}

export async function assertSourceUnchanged(evidence) {
  if (!evidence?.role || !evidence?.path || !SHA256_PATTERN.test(evidence.sha256_before ?? "")) {
    block("BLOCKED_SOURCE_EVIDENCE_INVALID", { evidence });
  }
  const after = await fileEvidence(evidence.path, evidence.role);
  if (after.sha256 !== evidence.sha256_before || after.size !== evidence.size_before) {
    block("SOURCE_DRIFT", {
      phase: "POST_READ",
      role: evidence.role,
      path: evidence.path,
      before_sha256: evidence.sha256_before,
      after_sha256: after.sha256,
      before_size: evidence.size_before,
      after_size: after.size,
    });
  }
  return Object.freeze({
    ...evidence,
    size_after: after.size,
    sha256_after: after.sha256,
    status: "PASS_NO_SOURCE_DRIFT",
  });
}

export function serializeExactSourceTrace(item) {
  if (!item || typeof item !== "object") {
    block("BLOCKED_EXACT_SOURCE_TRACE_INCOMPLETE", { field: "trace_item" });
  }
  const physicalRow = item.physical_row ?? item.row;
  const month = item.month ?? item.period;
  const amount = Object.hasOwn(item, "amount") ? item.amount : item.value;
  const sha256 = requiredText(item.sha256, "sha256").toUpperCase();
  if (!SHA256_PATTERN.test(sha256)) {
    block("BLOCKED_EXACT_SOURCE_TRACE_INCOMPLETE", { field: "sha256", value: sha256 });
  }
  if (!Number.isInteger(physicalRow) || physicalRow <= 0) {
    block("BLOCKED_EXACT_SOURCE_TRACE_INCOMPLETE", {
      field: "physical_row",
      value: physicalRow,
    });
  }
  if (amount !== null && typeof amount !== "number") {
    block("BLOCKED_EXACT_SOURCE_TRACE_INCOMPLETE", { field: "amount", value: amount });
  }
  return {
    amount,
    sha256,
    source_file: requiredText(item.source_file, "source_file"),
    sheet: requiredText(item.sheet, "sheet"),
    source_cell: requiredText(item.source_cell, "source_cell"),
    month: requiredText(month, "month"),
    physical_row: physicalRow,
  };
}

function stableEvidence(value, role) {
  if (
    !value ||
    value.status !== "PASS_NO_SOURCE_DRIFT" ||
    value.role !== role ||
    value.sha256_before !== value.sha256_after
  ) {
    block("BLOCKED_SOURCE_PROVENANCE_INCOMPLETE", { role });
  }
  return value;
}

export function buildSourceProvenance({
  template,
  intalevTemplateGraph = null,
  rules,
  policy = null,
  referenceCatalogs,
}) {
  const stableReferenceStatuses = new Set([
    "PASS_REFERENCE_CATALOGS_BOUND_AND_REHASHED",
    "PASS_AVAILABLE_REFERENCE_CATALOGS_REHASHED_WITH_DECLARED_MISSING_ROLES",
  ]);
  if (!stableReferenceStatuses.has(referenceCatalogs?.status)) {
    block("BLOCKED_SOURCE_PROVENANCE_INCOMPLETE", { role: "reference_catalogs" });
  }
  const declaredMissing = referenceCatalogs.declared_missing_roles ?? [];
  return Object.freeze({
    status: declaredMissing.length > 0
      ? "PASS_AVAILABLE_SOURCES_REHASHED_WITH_DECLARED_MISSING_REFERENCE"
      : "PASS_ALL_REGISTERED_SOURCES_REHASHED",
    template: stableEvidence(template, "template"),
    intalev_template_graph: intalevTemplateGraph
      ? stableEvidence(intalevTemplateGraph, "intalev_template_graph")
      : null,
    rules: stableEvidence(rules, "rules"),
    policy: policy ? stableEvidence(policy, "policy") : null,
    reference_catalogs: referenceCatalogs,
    declared_missing_reference_roles: declaredMissing,
    release_blockers: referenceCatalogs.release_blockers ?? [],
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  });
}
