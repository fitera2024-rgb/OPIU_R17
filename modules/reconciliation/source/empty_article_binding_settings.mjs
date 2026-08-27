import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA = "opiu-empty-article-binding-settings.v1";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const AUTHORITY_TYPES = new Set(["OWNER_APPROVED", "BUSINESS_APPROVED"]);
const AUTHORITY_SCOPE = "CLASSIFICATION_BINDING_ONLY";
const CLASSIFICATION_MODE = "CLASSIFICATION_ONLY";
const DECISION_TYPE = "NO_POSTING";

function text(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedKey(value) {
  return text(value)
    .replace(/[«»"]/g, "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
}

function blocked(code, detail = "") {
  throw new Error("BLOCKED_EMPTY_ARTICLE_BINDING_SETTINGS_" + code + (detail ? ":" + detail : ""));
}

function exactString(value, code) {
  if (typeof value !== "string") blocked(code);
  const result = text(value);
  if (!result) blocked(code);
  return result;
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) blocked(code);
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) blocked(code, actual.join(","));
}

function month(value, code) {
  const result = exactString(value, code);
  if (!MONTH_PATTERN.test(result)) blocked(code, result);
  return result;
}

function monthNumber(value) {
  return Number(value.replace("-", ""));
}

function normalizePath(value, code) {
  if (!Array.isArray(value) || value.length === 0) blocked(code);
  const segments = value.map((segment) => exactString(segment, code));
  const normalizedSegments = segments.map(normalizedKey);
  if (normalizedSegments.some((segment) => !segment)) blocked(code);
  return Object.freeze({
    segments: Object.freeze(segments),
    normalized_segments: Object.freeze(normalizedSegments),
    normalized_key: normalizedSegments.join("\u001F"),
  });
}

function normalizeLabels(value, code) {
  if (!Array.isArray(value) || value.length === 0) blocked(code);
  const labels = value.map((label) => exactString(label, code));
  const normalizedLabels = labels.map(normalizedKey);
  if (new Set(normalizedLabels).size !== normalizedLabels.length) blocked(code + "_DUPLICATE");
  return Object.freeze({
    labels: Object.freeze(labels),
    normalized_labels: Object.freeze(normalizedLabels),
  });
}

function normalizeValidity(value, bindingId) {
  const validity = object(value, "VALIDITY_INVALID");
  let validFrom;
  let validTo;
  if (Object.hasOwn(validity, "period")) {
    exactKeys(validity, ["period"], "VALIDITY_KEYS_INVALID");
    validFrom = month(validity.period, "VALIDITY_PERIOD_INVALID");
    validTo = validFrom;
  } else {
    exactKeys(validity, ["from", "to"], "VALIDITY_KEYS_INVALID");
    validFrom = month(validity.from, "VALIDITY_FROM_INVALID");
    validTo = month(validity.to, "VALIDITY_TO_INVALID");
  }
  if (monthNumber(validFrom) > monthNumber(validTo)) blocked("VALIDITY_RANGE_REVERSED", bindingId);
  return Object.freeze({ from: validFrom, to: validTo });
}

function normalizeOrganizationScope(value, codePrefix = "ORGANIZATION") {
  const scope = object(value, codePrefix + "_SCOPE_INVALID");
  exactKeys(scope, [
    "organization_id",
    "organization_name",
    "organization_hierarchy_path",
  ], codePrefix + "_SCOPE_KEYS_INVALID");
  const hierarchyPath = normalizePath(
    scope.organization_hierarchy_path,
    codePrefix + "_HIERARCHY_PATH_INVALID",
  );
  return Object.freeze({
    organization_id: exactString(scope.organization_id, codePrefix + "_ID_MISSING"),
    organization_name: exactString(scope.organization_name, codePrefix + "_NAME_MISSING"),
    organization_hierarchy_path: hierarchyPath.segments,
    normalized_organization_hierarchy_path: hierarchyPath.normalized_key,
  });
}

function organizationScopeKey(scope) {
  return [
    scope.organization_id,
    scope.organization_name,
    scope.normalized_organization_hierarchy_path,
  ].join("\u001E");
}

function normalizeRunScope(options) {
  const hierarchyPath = options?.organizationHierarchyPath ?? options?.organization_hierarchy_path;
  const organizationScope = normalizeOrganizationScope({
    organization_id: options?.organizationId ?? options?.organization_id,
    organization_name: options?.organizationName ?? options?.organization_name,
    organization_hierarchy_path: hierarchyPath,
  }, "RUN_ORGANIZATION");
  return Object.freeze({
    organization_scope: organizationScope,
    period: month(options?.period, "RUN_PERIOD_INVALID"),
  });
}

function normalizeAuthority(value) {
  const authority = object(value, "AUTHORITY_INVALID");
  exactKeys(authority, [
    "type",
    "scope",
    "approval_id",
    "approved_by",
    "approved_at",
    "evidence_ref",
  ], "AUTHORITY_KEYS_INVALID");
  const type = exactString(authority.type, "AUTHORITY_TYPE_MISSING").toUpperCase();
  if (!AUTHORITY_TYPES.has(type)) blocked("AUTHORITY_TYPE_INVALID", type);
  const scope = exactString(authority.scope, "AUTHORITY_SCOPE_MISSING").toUpperCase();
  if (scope !== AUTHORITY_SCOPE) blocked("AUTHORITY_SCOPE_INVALID", scope);
  const approvedAt = exactString(authority.approved_at, "AUTHORITY_APPROVED_AT_MISSING");
  if (!Number.isFinite(Date.parse(approvedAt))) blocked("AUTHORITY_APPROVED_AT_INVALID", approvedAt);
  return Object.freeze({
    type,
    scope,
    approval_id: exactString(authority.approval_id, "AUTHORITY_APPROVAL_ID_MISSING"),
    approved_by: exactString(authority.approved_by, "AUTHORITY_APPROVED_BY_MISSING"),
    approved_at: approvedAt,
    evidence_ref: exactString(authority.evidence_ref, "AUTHORITY_EVIDENCE_REF_MISSING"),
  });
}

function normalizeSafety(value) {
  const safety = object(value, "SAFETY_INVALID");
  exactKeys(safety, [
    "mode",
    "classification_only",
    "decision_type",
    "correction_authority",
    "physical_posting_authority",
    "financial_rows",
    "posting_rows",
    "ready_to_upload",
    "release_allowed",
    "execution_allowed",
    "live_1c_allowed",
    "report_only",
    "executed_posting_rows",
    "live_posting_rows",
    "live_delete_allowed",
  ], "SAFETY_KEYS_INVALID");
  if (safety.mode !== "REPORT_ONLY" ||
      safety.classification_only !== true ||
      safety.decision_type !== DECISION_TYPE ||
      safety.correction_authority !== false ||
      safety.physical_posting_authority !== false ||
      safety.financial_rows !== 0 ||
      safety.posting_rows !== 0 ||
      safety.ready_to_upload !== false ||
      safety.release_allowed !== false ||
      safety.execution_allowed !== false ||
      safety.live_1c_allowed !== false ||
      safety.report_only !== true ||
      safety.executed_posting_rows !== 0 ||
      safety.live_posting_rows !== 0 ||
      safety.live_delete_allowed !== false) {
    blocked("SAFETY_OPEN_OR_INVALID");
  }
  return Object.freeze({ ...safety });
}

function normalizeTarget(value, bindingId) {
  const target = object(value, "TARGET_INVALID");
  exactKeys(target, [
    "target_code",
    "target_node_identity",
    "display_path",
    "display_article",
  ], "TARGET_NOT_EXACTLY_ONE");
  const displayPath = normalizePath(target.display_path, "TARGET_DISPLAY_PATH_INVALID");
  const displayArticle = exactString(target.display_article, "TARGET_DISPLAY_ARTICLE_INVALID");
  const normalizedArticle = normalizedKey(displayArticle);
  if (displayPath.normalized_segments.at(-1) !== normalizedArticle) {
    blocked("TARGET_DISPLAY_PATH_ARTICLE_MISMATCH", bindingId);
  }
  return Object.freeze({
    target_code: exactString(target.target_code, "TARGET_CODE_INVALID"),
    target_node_identity: exactString(target.target_node_identity, "TARGET_NODE_IDENTITY_INVALID"),
    display_path: displayPath.segments,
    normalized_display_path: displayPath.normalized_key,
    display_article: displayArticle,
    normalized_display_article: normalizedArticle,
  });
}

function normalizeBinding(value, organizationScope, approvalId) {
  const binding = object(value, "BINDING_INVALID");
  exactKeys(binding, [
    "binding_id",
    "validity",
    "source",
    "target",
    "mode",
    "decision_type",
    "authority_ref",
  ], "BINDING_KEYS_INVALID");
  const bindingId = exactString(binding.binding_id, "BINDING_ID_MISSING");
  if (binding.mode !== CLASSIFICATION_MODE || binding.decision_type !== DECISION_TYPE) {
    blocked("BINDING_FINANCIAL_ACTION_FORBIDDEN", bindingId);
  }
  if (text(binding.authority_ref) !== approvalId) blocked("BINDING_AUTHORITY_REF_MISMATCH", bindingId);

  const source = object(binding.source, "SOURCE_INVALID");
  exactKeys(source, ["parent_path", "leaf_labels", "blank_ancestor_required"], "SOURCE_KEYS_INVALID");
  if (source.blank_ancestor_required !== true) blocked("BLANK_ANCESTOR_REQUIRED", bindingId);
  const sourcePath = normalizePath(source.parent_path, "SOURCE_PARENT_PATH_INVALID");
  const sourceLabels = normalizeLabels(source.leaf_labels, "SOURCE_LEAF_LABELS_INVALID");

  return Object.freeze({
    binding_id: bindingId,
    organization_scope: organizationScope,
    validity: normalizeValidity(binding.validity, bindingId),
    source: Object.freeze({
      parent_path: sourcePath.segments,
      normalized_parent_path: sourcePath.normalized_key,
      leaf_labels: sourceLabels.labels,
      normalized_leaf_labels: sourceLabels.normalized_labels,
      blank_ancestor_required: true,
    }),
    target: normalizeTarget(binding.target, bindingId),
    mode: CLASSIFICATION_MODE,
    decision_type: DECISION_TYPE,
    authority_ref: approvalId,
  });
}

function rangesOverlap(left, right) {
  return monthNumber(left.from) <= monthNumber(right.to) &&
    monthNumber(right.from) <= monthNumber(left.to);
}

function targetFingerprint(target) {
  return [
    target.target_code,
    target.target_node_identity,
    target.normalized_display_path,
    target.normalized_display_article,
  ].join("\u001E");
}

function assertUnambiguous(bindings) {
  const ids = new Set();
  const targetByCode = new Map();
  const targetByNodeIdentity = new Map();
  for (const binding of bindings) {
    if (ids.has(binding.binding_id)) blocked("BINDING_ID_DUPLICATE", binding.binding_id);
    ids.add(binding.binding_id);
    const fingerprint = targetFingerprint(binding.target);
    const codeFingerprint = targetByCode.get(binding.target.target_code);
    if (codeFingerprint && codeFingerprint !== fingerprint) {
      blocked("TARGET_CODE_IDENTITY_AMBIGUOUS", binding.target.target_code);
    }
    targetByCode.set(binding.target.target_code, fingerprint);
    const nodeFingerprint = targetByNodeIdentity.get(binding.target.target_node_identity);
    if (nodeFingerprint && nodeFingerprint !== fingerprint) {
      blocked("TARGET_NODE_IDENTITY_AMBIGUOUS", binding.target.target_node_identity);
    }
    targetByNodeIdentity.set(binding.target.target_node_identity, fingerprint);
  }
  for (let leftIndex = 0; leftIndex < bindings.length; leftIndex += 1) {
    const left = bindings[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < bindings.length; rightIndex += 1) {
      const right = bindings[rightIndex];
      if (left.source.normalized_parent_path !== right.source.normalized_parent_path ||
          !rangesOverlap(left.validity, right.validity)) continue;
      const rightLabels = new Set(right.source.normalized_leaf_labels);
      const overlap = left.source.normalized_leaf_labels.find((label) => rightLabels.has(label));
      if (overlap) {
        blocked("AMBIGUOUS_OVERLAPPING_SOURCE", left.binding_id + ":" + right.binding_id + ":" + overlap);
      }
    }
  }
}

function inactive(scope, status) {
  return Object.freeze({
    rules: Object.freeze([]),
    document: null,
    audit: Object.freeze({
      schema: SCHEMA,
      status,
      ...scope.organization_scope,
      period: scope.period,
      rule_count: 0,
      classification_only: true,
      decision_type: DECISION_TYPE,
      correction_authority: false,
      physical_posting_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      execution_allowed: false,
      live_1c_allowed: false,
      report_only: true,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      live_delete_allowed: false,
    }),
  });
}

export function validateEmptyArticleBindingSettingsDocument(document, options = {}) {
  const scope = normalizeRunScope(options);
  const input = object(document, "DOCUMENT_INVALID");
  exactKeys(input, [
    "schema",
    "settings_id",
    "organization_scope",
    "authority",
    "safety",
    "bindings",
  ], "DOCUMENT_KEYS_INVALID");
  if (input.schema !== SCHEMA) blocked("SCHEMA_INVALID", text(input.schema));
  const settingsId = exactString(input.settings_id, "SETTINGS_ID_MISSING");
  const documentOrganizationScope = normalizeOrganizationScope(input.organization_scope);
  if (organizationScopeKey(documentOrganizationScope) !== organizationScopeKey(scope.organization_scope)) {
    blocked("RUN_ORGANIZATION_SCOPE_MISMATCH", organizationScopeKey(scope.organization_scope));
  }
  const authority = normalizeAuthority(input.authority);
  const safety = normalizeSafety(input.safety);
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) blocked("BINDINGS_MISSING");
  const bindings = input.bindings.map((binding) =>
    normalizeBinding(binding, documentOrganizationScope, authority.approval_id));
  assertUnambiguous(bindings);
  const active = bindings.filter((binding) =>
    monthNumber(binding.validity.from) <= monthNumber(scope.period) &&
    monthNumber(scope.period) <= monthNumber(binding.validity.to));
  const normalizedDocument = Object.freeze({
    schema: SCHEMA,
    settings_id: settingsId,
    organization_scope: documentOrganizationScope,
    authority,
    safety,
    bindings: Object.freeze(bindings),
  });
  return Object.freeze({
    rules: Object.freeze(active),
    document: normalizedDocument,
    audit: Object.freeze({
      schema: SCHEMA,
      status: active.length > 0
        ? "ACTIVE_EXACT_ORGANIZATION_PERIOD"
        : "NO_ACTIVE_RULES_EXACT_ORGANIZATION_PERIOD",
      settings_id: settingsId,
      ...scope.organization_scope,
      period: scope.period,
      authority_type: authority.type,
      authority_scope: authority.scope,
      approval_id: authority.approval_id,
      evidence_ref: authority.evidence_ref,
      input_path: text(options?.source?.path),
      input_sha256: text(options?.source?.sha256).toUpperCase(),
      input_size: Number(options?.source?.size ?? 0),
      rule_count: active.length,
      configured_rule_count: bindings.length,
      classification_only: true,
      decision_type: DECISION_TYPE,
      correction_authority: false,
      physical_posting_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      execution_allowed: false,
      live_1c_allowed: false,
      report_only: true,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      live_delete_allowed: false,
    }),
  });
}

export async function loadEmptyArticleBindingSettingsDocument(requestedPath, options = {}) {
  const scope = normalizeRunScope(options);
  const requested = text(requestedPath);
  if (!requested) return inactive(scope, "MISSING_NO_CLASSIFICATION_BINDING");
  const resolved = path.resolve(requested);
  let bytes;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    blocked("DOCUMENT_UNREADABLE", resolved + ":" + error.message);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    blocked("DOCUMENT_JSON_INVALID", error.message);
  }
  return validateEmptyArticleBindingSettingsDocument(document, {
    ...scope.organization_scope,
    period: scope.period,
    source: {
      path: resolved,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(),
      size: bytes.length,
    },
  });
}

export function normalizeEmptyArticleBindingValue(value) {
  return normalizedKey(value);
}

export function normalizeEmptyArticleBindingPath(value) {
  return normalizePath(value, "PATH_INVALID").normalized_key;
}

export const EMPTY_ARTICLE_BINDING_SETTINGS_SCHEMA = SCHEMA;
export const EMPTY_ARTICLE_BINDING_CLASSIFICATION_MODE = CLASSIFICATION_MODE;
export const EMPTY_ARTICLE_BINDING_DECISION_TYPE = DECISION_TYPE;
