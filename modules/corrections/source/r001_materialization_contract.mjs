import {
  relevantIntalevAbsenceProof,
} from "../../reconciliation/source/intalev_source_scope.mjs";

const MATERIALIZATION_CASE_SCHEMA = "opiu-materialization-case.v1";
const CANONICAL_POSTING_ROW_SCHEMA = "opiu-canonical-posting-row.v1";

export const MATERIALIZATION_ACTIONS = Object.freeze([
  "STORNO",
  "REPOST",
  "STORNO_REPOST",
  "ADD_ONE_SIDE",
  "NO_POSTING",
  "UPDATE_MAPPING",
]);

export const MATERIALIZATION_ROLES = Object.freeze([
  "",
  "STANDALONE",
  "RECLASS_SOURCE",
  "RECLASS_TARGET",
]);

export const MATERIALIZATION_OUTPUT_ROUTES = Object.freeze([
  "READY",
  "SPORNO",
  "REVIEW_ONLY",
]);

export const MATERIALIZATION_STATES = Object.freeze([
  "MATERIALIZED_READY",
  "MATERIALIZED_SPORNO",
  "REVIEW_ONLY",
]);

export const LOADER_A_AA_FIELDS = Object.freeze([
  "СчетДт",
  "СчетКт",
  "ВалютаДт",
  "ВалютаКт",
  "ВидОперации",
  "ПодразделениеДт",
  "ПодразделениеКт",
  "НаправлениеДеятельностиДт",
  "НаправлениеДеятельностиКт",
  "СуммаВВалютеУчета",
  "СуммаВВалютеОтчетности",
  "СуммаВВалютеДт",
  "СуммаВВалютеКт",
  "КоличествоДт",
  "КоличествоКт",
  "Содержание",
  "СчетДтИсточник",
  "СчетКтИсточник",
  "ИдентификаторФинЗаписи",
  "ПравилоДт",
  "ПравилоКт",
  "СубконтоДт1",
  "СубконтоДт2",
  "СубконтоДт3",
  "СубконтоКт1",
  "СубконтоКт2",
  "СубконтоКт3",
]);

const LOADER_MONETARY_FIELDS = Object.freeze([
  "СуммаВВалютеУчета",
  "СуммаВВалютеОтчетности",
  "СуммаВВалютеДт",
  "СуммаВВалютеКт",
]);

export const REPORT_ONLY_SAFETY = Object.freeze({
  report_only: true,
  execution_allowed: false,
  ready_to_upload: false,
  posting_rows: 0,
  executed_posting_rows: 0,
  live_posting_rows: 0,
  release_allowed: false,
  live_1c_allowed: false,
  live_delete_allowed: false,
});

const ACTION_SET = new Set(MATERIALIZATION_ACTIONS);
const ROLE_SET = new Set(MATERIALIZATION_ROLES);
const ROUTE_SET = new Set(MATERIALIZATION_OUTPUT_ROUTES);
const OPERATION_SET = new Set(["STORNO", "REPOST"]);
const NON_FINANCIAL_ACTIONS = new Set(["NO_POSTING", "UPDATE_MAPPING"]);
const ROUTE_STATE = Object.freeze({
  READY: "MATERIALIZED_READY",
  SPORNO: "MATERIALIZED_SPORNO",
  REVIEW_ONLY: "REVIEW_ONLY",
});
const CANONICAL_PHYSICAL_FIELDS = Object.freeze([
  "source_organization",
  "source_archive_path",
  "source_archive_sha256",
  "journal_entry",
  "journal_sha256",
  "source_sheet",
  "source_range",
  "source_row_id",
  "date",
  "document",
  "posting_number",
  "debit",
  "credit",
  "debit_department",
  "credit_department",
  "amount",
]);

export class MaterializationContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MaterializationContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new MaterializationContractError(code, message, details);
}

function clean(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function finiteNumber(value, field, { minimum = -Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail("INVALID_NUMBER", `${field} must be a finite number${minimum > -Infinity ? ` >= ${minimum}` : ""}`, { field, value });
  }
  return value;
}

function optionalNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value, field);
}

function exactSlots(value, field) {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("INVALID_ANALYTICS_SLOTS", `${field} must contain exactly three slots`, { field });
  }
  return value.map((item) => clean(item));
}

function optionalBoolean(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") fail("INVALID_BOOLEAN", `${field} must be boolean or null`, { field, value });
  return value;
}

function validateOptionalSha256(value, field) {
  const normalized = upper(value);
  if (normalized && !/^[A-F0-9]{64}$/.test(normalized)) {
    fail("INVALID_SHA256", `${field} must be an exact SHA-256 when supplied`, { field });
  }
  return normalized;
}

function assertClosedSafety(safety = {}) {
  if (safety === null || typeof safety !== "object" || Array.isArray(safety)) {
    fail("INVALID_SAFETY", "safety must be an object when supplied");
  }
  if (safety.report_only === false) fail("SAFETY_ELEVATION", "report_only cannot be disabled");
  for (const field of [
    "execution_allowed",
    "ready_to_upload",
    "release_allowed",
    "live_1c_allowed",
    "live_delete_allowed",
  ]) {
    if (safety[field] === true) fail("SAFETY_ELEVATION", `${field} cannot be enabled`, { field });
  }
  for (const field of ["posting_rows", "executed_posting_rows", "live_posting_rows"]) {
    if (safety[field] !== undefined && Number(safety[field]) !== 0) {
      fail("SAFETY_ELEVATION", `${field} must remain zero`, { field, value: safety[field] });
    }
  }
  return { ...REPORT_ONLY_SAFETY };
}

function normalizeAccounting(input = {}, prefix) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_ACCOUNTING_BLOCK", `${prefix} must be an object`);
  }
  return {
    debit: clean(input.debit),
    credit: clean(input.credit),
    debit_analytics: exactSlots(input.debit_analytics ?? ["", "", ""], `${prefix}.debit_analytics`),
    credit_analytics: exactSlots(input.credit_analytics ?? ["", "", ""], `${prefix}.credit_analytics`),
    debit_department: clean(input.debit_department),
    credit_department: clean(input.credit_department),
    article: clean(input.article),
  };
}

function normalizePhysicalSource(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_PHYSICAL_SOURCE", "physical_source must be an object");
  }
  return {
    source_organization: clean(input.source_organization),
    source_archive_path: clean(input.source_archive_path),
    source_archive_sha256: validateOptionalSha256(input.source_archive_sha256, "physical_source.source_archive_sha256"),
    journal_entry: clean(input.journal_entry),
    journal_sha256: validateOptionalSha256(input.journal_sha256, "physical_source.journal_sha256"),
    source_sheet: clean(input.source_sheet),
    source_range: clean(input.source_range),
    source_row_id: clean(input.source_row_id),
    date: clean(input.date),
    document: clean(input.document),
    posting_number: clean(input.posting_number),
    debit: clean(input.debit),
    credit: clean(input.credit),
    debit_analytics: exactSlots(input.debit_analytics ?? ["", "", ""], "physical_source.debit_analytics"),
    credit_analytics: exactSlots(input.credit_analytics ?? ["", "", ""], "physical_source.credit_analytics"),
    debit_department: clean(input.debit_department),
    credit_department: clean(input.credit_department),
    amount: optionalNumber(input.amount, "physical_source.amount"),
    activity: clean(input.activity),
    scenario: clean(input.scenario),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(clean).filter(Boolean);
}

function normalizeAnalyticalBasis(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_ANALYTICAL_BASIS", "analytical_basis must be an object");
  }
  return {
    reconciliation_row: clean(input.reconciliation_row),
    analytical_basis_id: clean(input.analytical_basis_id),
    residual_atom_id: clean(input.residual_atom_id),
    transformation_id: clean(input.transformation_id),
    raw_delta: optionalNumber(input.raw_delta, "analytical_basis.raw_delta"),
    effective_delta: optionalNumber(input.effective_delta, "analytical_basis.effective_delta"),
  };
}

function normalizeIntalevSource(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INTALEV_SOURCE", "intalev_source must be an object");
  }
  return {
    reconciliation_row: clean(input.reconciliation_row),
    block: clean(input.block),
    path: clean(input.path),
    source_reference: clean(input.source_reference),
    amount: optionalNumber(input.amount, "intalev_source.amount"),
  };
}

function normalizeEconomicRoute(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_ECONOMIC_ROUTE", "economic_route must be an object");
  }
  return {
    route_id: clean(input.route_id),
    proof_status: clean(input.proof_status),
    accepted: input.accepted === true,
    accepted_amount: optionalNumber(input.accepted_amount, "economic_route.accepted_amount"),
    accepted_effect: optionalNumber(input.accepted_effect, "economic_route.accepted_effect"),
    root_effective_delta: optionalNumber(input.root_effective_delta, "economic_route.root_effective_delta"),
    processing_stage: clean(input.processing_stage),
    stage_order: optionalNumber(input.stage_order, "economic_route.stage_order"),
  };
}

function normalizeSourceScope(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_SOURCE_SCOPE", "source_scope must be an object");
  }
  const normalized = {
    intalev_source_scope_presence: upper(input.intalev_source_scope_presence),
    intalev_source_scope_absence_claimed: input.intalev_source_scope_absence_claimed === true
      || input.intalev_source_scope_absence_proven === true
      || upper(input.intalev_source_scope_presence) === "ABSENT_PROVEN",
    intalev_source_scope_absence_proven: input.intalev_source_scope_absence_proven === true,
    intalev_source_scope_inventory_complete: input.intalev_source_scope_inventory_complete === true,
    intalev_source_scope_complete: input.intalev_source_scope_complete === true,
    intalev_source_amount_lost: input.intalev_source_amount_lost === true
      ? true
      : input.intalev_source_amount_lost === false ? false : null,
  };
  const proof = relevantIntalevAbsenceProof(normalized);
  return {
    ...normalized,
    relevant_intalev_absence_proven: proof.proven,
    relevant_intalev_absence_blockers: [...proof.blockers],
  };
}

function normalizeProvenance(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_PROVENANCE", "provenance must be an object");
  }
  return {
    source: clean(input.source),
    handoff_sha256: validateOptionalSha256(input.handoff_sha256, "provenance.handoff_sha256"),
    applications_sha256: validateOptionalSha256(input.applications_sha256, "provenance.applications_sha256"),
    upstream_decision_index: optionalNumber(input.upstream_decision_index, "provenance.upstream_decision_index"),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireText(value, field) {
  if (!clean(value)) fail("MISSING_REQUIRED_FIELD", `${field} is required`, { field });
}

function assertCanonicalPhysicalSource(source) {
  const missing = CANONICAL_PHYSICAL_FIELDS.filter((field) => !clean(source[field]));
  for (const field of ["debit_analytics", "credit_analytics"]) {
    if (!Array.isArray(source[field]) || source[field].length !== 3) missing.push(field);
  }
  if (missing.length) {
    fail(
      "CANONICAL_PHYSICAL_IDENTITY_INCOMPLETE",
      `A financial A:AA row requires one exact physical ERP source: ${missing.join(", ")}`,
      { missing },
    );
  }
}

function hasPhysicalSourceClaim(source) {
  return CANONICAL_PHYSICAL_FIELDS.some((field) => clean(source?.[field]));
}

function assertSpornoPhysicalSource(source) {
  // An owner-approved economic route may be emitted as a sparse _СПОРНО
  // draft.  In that case every unknown physical field must stay blank.  Once
  // any physical identity is claimed, the complete canonical tuple is still
  // mandatory so a partial/fabricated source can never enter A:AA.
  if (hasPhysicalSourceClaim(source)) assertCanonicalPhysicalSource(source);
}

function hasAccountingClaim(accounting) {
  return Boolean(
    clean(accounting?.debit)
    || clean(accounting?.credit)
    || clean(accounting?.debit_department)
    || clean(accounting?.credit_department)
    || (accounting?.debit_analytics ?? []).some((value) => clean(value))
    || (accounting?.credit_analytics ?? []).some((value) => clean(value))
  );
}

function assertReadyPhysicalSource(source) {
  assertCanonicalPhysicalSource(source);
  const missing = [];
  for (const field of ["debit_analytics", "credit_analytics"]) {
    source[field].forEach((value, index) => {
      if (!clean(value)) missing.push(`${field}[${index}]`);
    });
  }
  if (missing.length) {
    fail("READY_PHYSICAL_IDENTITY_INCOMPLETE", `READY requires exact physical source identity: ${missing.join(", ")}`, { missing });
  }
}

export function createMaterializationCase(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_MATERIALIZATION_CASE", "MaterializationCase input must be an object");
  }
  const action = upper(input.action);
  const role = upper(input.role);
  const outputRoute = upper(input.output_route);
  requireText(input.case_id, "case_id");
  requireText(input.pair_id, "pair_id");
  requireText(input.reconciliation_organization, "reconciliation_organization");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean(input.period))) {
    fail("INVALID_PERIOD", "period must be one concrete YYYY-MM month", { value: input.period });
  }
  if (!ACTION_SET.has(action)) fail("INVALID_ACTION", `Unsupported materialization action: ${action || "<empty>"}`);
  if (!ROLE_SET.has(role)) fail("INVALID_ROLE", `Unsupported materialization role: ${role}`);
  if (!ROUTE_SET.has(outputRoute)) fail("INVALID_OUTPUT_ROUTE", `Unsupported output route: ${outputRoute || "<empty>"}`);

  const proofStatus = clean(input.proof_status);
  requireText(proofStatus, "proof_status");
  const correctionAllowed = optionalBoolean(input.correction_allowed, "correction_allowed");
  const physicalSource = normalizePhysicalSource(input.physical_source);
  const sourceScope = normalizeSourceScope(input.source_scope);
  const signedEconomicEffect = finiteNumber(input.signed_economic_effect, "signed_economic_effect");
  const correctionAmount = finiteNumber(input.correction_amount, "correction_amount", { minimum: 0 });

  if (action === "ADD_ONE_SIDE" && outputRoute === "SPORNO") {
    fail("FINANCIAL_ACTION_DIRECTION_MISSING", "SPORNO ADD_ONE_SIDE requires an explicit STORNO or REPOST action direction");
  }

  if (sourceScope.intalev_source_scope_absence_claimed === true
    && sourceScope.relevant_intalev_absence_proven !== true
    && outputRoute !== "REVIEW_ONLY") {
    fail(
      "RELEVANT_INTALEV_ABSENCE_AUTHORITY_UNPROVEN",
      `Financial absence authority requires complete relevant Intalev scope: ${sourceScope.relevant_intalev_absence_blockers.join(", ")}`,
      { blockers: sourceScope.relevant_intalev_absence_blockers },
    );
  }

  if (outputRoute === "READY") {
    if (NON_FINANCIAL_ACTIONS.has(action)) fail("NON_FINANCIAL_READY", `${action} cannot be routed READY`);
    if (action === "ADD_ONE_SIDE") {
      fail("READY_ACTION_DIRECTION_MISSING", "READY ADD_ONE_SIDE requires an explicit STORNO or REPOST action direction");
    }
    if (correctionAllowed !== true) fail("READY_AUTHORITY_MISSING", "READY requires explicit correction_allowed=true");
    assertReadyPhysicalSource(physicalSource);
  }

  return deepFreeze({
    schema_version: MATERIALIZATION_CASE_SCHEMA,
    case_id: clean(input.case_id),
    pair_id: clean(input.pair_id),
    period: clean(input.period),
    reconciliation_organization: clean(input.reconciliation_organization),
    action,
    role,
    signed_economic_effect: signedEconomicEffect,
    correction_amount: correctionAmount,
    economic: {
      source_code: clean(input.economic?.source_code),
      target_code: clean(input.economic?.target_code),
      source_article: clean(input.economic?.source_article),
      target_article: clean(input.economic?.target_article),
    },
    proof_status: proofStatus,
    correction_allowed: correctionAllowed,
    correction_authority: clean(input.correction_authority),
    output_route: outputRoute,
    physical_source: physicalSource,
    target_accounting: normalizeAccounting(input.target_accounting, "target_accounting"),
    analytical_basis: normalizeAnalyticalBasis(input.analytical_basis),
    intalev_source: normalizeIntalevSource(input.intalev_source),
    economic_route: normalizeEconomicRoute(input.economic_route),
    source_scope: sourceScope,
    reason: clean(input.reason),
    blockers: normalizeStringArray(input.blockers),
    provenance: normalizeProvenance(input.provenance),
    safety: assertClosedSafety(input.safety),
  });
}

function assertMaterializationCase(value) {
  if (!value || value.schema_version !== MATERIALIZATION_CASE_SCHEMA) {
    fail("INVALID_MATERIALIZATION_CASE", `Expected ${MATERIALIZATION_CASE_SCHEMA}`);
  }
  return createMaterializationCase(value);
}

function normalizeLoader(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_LOADER_BLOCK", "loader must be an object keyed by the A:AA headers");
  }
  return Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, input[field] ?? null]));
}

function normalizeLoaderMoneySigns(loader, operation) {
  const normalized = { ...loader };
  for (const field of LOADER_MONETARY_FIELDS) {
    const value = normalized[field];
    if (value === null || value === undefined || value === "") {
      normalized[field] = null;
      continue;
    }
    const numeric = finiteNumber(value, `loader.${field}`);
    normalized[field] = numeric === 0 ? 0 : operation === "STORNO" ? -Math.abs(numeric) : Math.abs(numeric);
  }
  return normalized;
}

function assertLoaderMatchesAccounting(loader, source, result, operation, amount) {
  if (upper(loader["ВидОперации"]) !== operation) {
    fail("LOADER_OPERATION_MISMATCH", "A:AA ВидОперации must equal canonical operation");
  }
  const sourceRowId = clean(source.source_row_id);
  const loaderSourceId = clean(loader["ИдентификаторФинЗаписи"]);
  if (sourceRowId !== loaderSourceId) {
    fail("SOURCE_IDENTITY_MISMATCH", "A:AA financial record id must exactly equal physical source_row_id; generated UploadID fallback is forbidden", {
      source_row_id: sourceRowId,
      loader_financial_record_id: loaderSourceId,
    });
  }
  const expectedReportingAmount = operation === "STORNO" ? -amount : amount;
  if (loader["СуммаВВалютеОтчетности"] !== expectedReportingAmount) {
    fail("LOADER_AMOUNT_MISMATCH", "A:AA reporting amount must equal canonical amount with the operation sign", {
      canonical_amount: amount,
      expected_reporting_amount: expectedReportingAmount,
      loader_reporting_amount: loader["СуммаВВалютеОтчетности"],
    });
  }
  const comparisons = [
    ["СчетДтИсточник", source.debit],
    ["СчетКтИсточник", source.credit],
    ["СчетДт", result.debit],
    ["СчетКт", result.credit],
    ["ПодразделениеДт", result.debit_department],
    ["ПодразделениеКт", result.credit_department],
    ["СубконтоДт1", result.debit_analytics[0]],
    ["СубконтоДт2", result.debit_analytics[1]],
    ["СубконтоДт3", result.debit_analytics[2]],
    ["СубконтоКт1", result.credit_analytics[0]],
    ["СубконтоКт2", result.credit_analytics[1]],
    ["СубконтоКт3", result.credit_analytics[2]],
  ];
  const mismatches = comparisons
    .filter(([field, expected]) => clean(loader[field]) !== clean(expected))
    .map(([field]) => field);
  if (mismatches.length) {
    fail("LOADER_ACCOUNTING_MISMATCH", `A:AA values conflict with canonical accounting: ${mismatches.join(", ")}`, { mismatches });
  }
}

function assertStornoPreservesSource(source, result) {
  const comparisons = [
    ["debit", source.debit, result.debit],
    ["credit", source.credit, result.credit],
    ["debit_department", source.debit_department, result.debit_department],
    ["credit_department", source.credit_department, result.credit_department],
    ...source.debit_analytics.map((value, index) => [`debit_analytics[${index}]`, value, result.debit_analytics[index]]),
    ...source.credit_analytics.map((value, index) => [`credit_analytics[${index}]`, value, result.credit_analytics[index]]),
  ];
  const mismatches = comparisons
    .filter(([, expected, actual]) => clean(expected) !== clean(actual))
    .map(([field]) => field);
  if (mismatches.length) {
    fail("STORNO_SOURCE_TUPLE_MISMATCH", `STORNO must preserve the exact physical source accounting tuple: ${mismatches.join(", ")}`, { mismatches });
  }
}

export function createCanonicalPostingRow(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_CANONICAL_POSTING_ROW", "CanonicalPostingRow input must be an object");
  }
  if (
    upper(input.materialization_case?.action) === "ADD_ONE_SIDE"
    && upper(input.materialization_case?.output_route) !== "READY"
  ) {
    fail("DIRECTIONLESS_CASE", "ADD_ONE_SIDE is REVIEW_ONLY metadata and cannot create a CanonicalPostingRow");
  }
  const materializationCase = assertMaterializationCase(input.materialization_case);
  if (NON_FINANCIAL_ACTIONS.has(materializationCase.action)) {
    fail("NON_FINANCIAL_CASE", `${materializationCase.action} cannot create a CanonicalPostingRow`);
  }
  const operation = upper(input.operation);
  if (!OPERATION_SET.has(operation)) fail("INVALID_OPERATION", "operation must be STORNO or REPOST");
  if (materializationCase.action === "STORNO" && operation !== "STORNO") {
    fail("ACTION_OPERATION_MISMATCH", "Standalone STORNO cannot materialize as REPOST");
  }
  if (materializationCase.action === "REPOST" && operation !== "REPOST") {
    fail("ACTION_OPERATION_MISMATCH", "Standalone REPOST cannot materialize as STORNO");
  }

  const outputRoute = upper(input.output_route ?? materializationCase.output_route);
  if (outputRoute !== materializationCase.output_route) {
    fail("OUTPUT_ROUTE_MISMATCH", "Posting row output_route must equal its MaterializationCase route");
  }
  const materializationState = upper(input.materialization_state);
  if (ROUTE_STATE[outputRoute] !== materializationState) {
    fail("ROUTE_STATE_CONTRADICTION", `${outputRoute} requires ${ROUTE_STATE[outputRoute]}`, {
      output_route: outputRoute,
      materialization_state: materializationState,
    });
  }
  requireText(input.audit_identity, "audit_identity");
  const amount = finiteNumber(input.amount, "amount", { minimum: Number.MIN_VALUE });
  const resultAccounting = normalizeAccounting(input.result_accounting, "result_accounting");
  if (operation === "STORNO") {
    assertStornoPreservesSource(materializationCase.physical_source, resultAccounting);
  }
  const loader = normalizeLoaderMoneySigns(normalizeLoader(input.loader), operation);
  assertLoaderMatchesAccounting(loader, materializationCase.physical_source, resultAccounting, operation, amount);

  if (outputRoute === "READY") {
    assertCanonicalPhysicalSource(materializationCase.physical_source);
    for (const field of ["debit", "credit"]) {
      if (!clean(resultAccounting[field])) {
        fail("CANONICAL_TARGET_ACCOUNTING_INCOMPLETE", `Financial A:AA ${field} is required`, { field, operation, output_route: outputRoute });
      }
    }
    for (const field of ["СчетДт", "СчетКт", "ВидОперации", "ИдентификаторФинЗаписи"]) {
      if (!clean(loader[field])) fail("CANONICAL_LOADER_IDENTITY_INCOMPLETE", `Financial A:AA field ${field} is required`, { field, output_route: outputRoute });
    }
  }

  if (outputRoute === "SPORNO") {
    const source = materializationCase.physical_source;
    assertSpornoPhysicalSource(source);
    if (hasPhysicalSourceClaim(source)) {
      for (const field of ["debit", "credit"]) {
        if (!clean(resultAccounting[field])) {
          fail("CANONICAL_TARGET_ACCOUNTING_INCOMPLETE", `Financial A:AA ${field} is required`, { field, operation, output_route: outputRoute });
        }
      }
      for (const field of ["СчетДт", "СчетКт", "ВидОперации", "ИдентификаторФинЗаписи"]) {
        if (!clean(loader[field])) fail("CANONICAL_LOADER_IDENTITY_INCOMPLETE", `Financial A:AA field ${field} is required`, { field, output_route: outputRoute });
      }
    } else {
      if (hasAccountingClaim(resultAccounting)) {
        fail(
          "CANONICAL_PHYSICAL_IDENTITY_INCOMPLETE",
          "Sparse SPORNO cannot claim accounts, analytics or departments without a complete physical source",
        );
      }
      if (!clean(loader["ВидОперации"])) {
        fail("CANONICAL_LOADER_IDENTITY_INCOMPLETE", "Sparse SPORNO requires an explicit operation direction", {
          field: "ВидОперации",
          output_route: outputRoute,
        });
      }
    }
  }

  if (outputRoute === "READY") {
    assertReadyPhysicalSource(materializationCase.physical_source);
  }

  const row = {
    schema_version: CANONICAL_POSTING_ROW_SCHEMA,
    materialization_case: materializationCase,
    audit_identity: clean(input.audit_identity),
    case_id: materializationCase.case_id,
    pair_id: materializationCase.pair_id,
    operation,
    period: materializationCase.period,
    reconciliation_organization: materializationCase.reconciliation_organization,
    source_organization: materializationCase.physical_source.source_organization,
    source: { ...materializationCase.physical_source },
    result_accounting: resultAccounting,
    amount,
    proof_status: materializationCase.proof_status,
    correction_allowed: materializationCase.correction_allowed,
    correction_authority: materializationCase.correction_authority,
    materialization_state: materializationState,
    output_route: outputRoute,
    loader,
    loader_values: LOADER_A_AA_FIELDS.map((field) => loader[field]),
    safety: assertClosedSafety(input.safety),
  };
  return deepFreeze(row);
}
