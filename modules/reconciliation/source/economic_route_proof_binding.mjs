import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA = "opiu-economic-route-proofs.v1";
const PROOF_STATUS = "ECONOMIC_RECLASS_PROVEN";
const INTRAGROUP_ECONOMIC_STATUS = "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS";
const INTRAGROUP_ALLOCATION_STATUS = "BLOCKED_EXACT_ALLOCATION";
const INTRAGROUP_PHYSICAL_STATUS = "BLOCKED_PHYSICAL_ERP_PROOF";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const APPROVAL_TYPES = new Set(["OWNER_APPROVED", "BUSINESS_APPROVED"]);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function blocked(code, detail = "") {
  throw new Error(`BLOCKED_ECONOMIC_ROUTE_PROOF_${code}${detail ? `:${detail}` : ""}`);
}

function exactString(value, code) {
  const result = text(value);
  if (!result) blocked(code);
  return result;
}

function exactCodeList(value, code) {
  if (!Array.isArray(value) || value.length === 0) blocked(code);
  const result = value.map((item) => exactString(item, code));
  if (new Set(result).size !== result.length) blocked(`${code}_DUPLICATE`);
  return result;
}

function routeMemberSet(route) {
  const sourceCodes = [...route.source_codes].sort((left, right) => left.localeCompare(right, "en"));
  const targetCodes = [...route.target_codes].sort((left, right) => left.localeCompare(right, "en"));
  const canonical = JSON.stringify({
    source_codes: sourceCodes,
    target_codes: targetCodes,
  });
  return Object.freeze({
    source_codes: Object.freeze(sourceCodes),
    target_codes: Object.freeze(targetCodes),
    sha256: crypto.createHash("sha256").update(canonical).digest("hex").toUpperCase(),
  });
}

function descendantMemberSet(descendantCodes) {
  const codes = [...descendantCodes];
  const canonical = JSON.stringify({
    descendant_codes: [...codes].sort((left, right) => left.localeCompare(right, "en")),
  });
  return Object.freeze({
    codes: Object.freeze(codes),
    sha256: crypto.createHash("sha256").update(canonical).digest("hex").toUpperCase(),
  });
}

function normalizedDocument(document, source) {
  if (!document || typeof document !== "object" || Array.isArray(document)) blocked("DOCUMENT_INVALID");
  if (document.schema !== SCHEMA) blocked("SCHEMA_INVALID", text(document.schema));
  const runId = exactString(document.run_id, "RUN_ID_MISSING");
  const organization = exactString(document.organization, "ORGANIZATION_MISSING");
  const period = exactString(document.period, "PERIOD_MISSING");
  if (!MONTH_PATTERN.test(period)) blocked("PERIOD_INVALID", period);
  const authority = document.authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    blocked("AUTHORITY_MISSING");
  }
  const authorityType = exactString(authority.type, "AUTHORITY_TYPE_MISSING").toUpperCase();
  if (!APPROVAL_TYPES.has(authorityType)) blocked("AUTHORITY_TYPE_INVALID", authorityType);
  const approvalId = exactString(authority.approval_id, "APPROVAL_ID_MISSING");
  const approvedBy = exactString(authority.approved_by, "APPROVED_BY_MISSING");
  const approvedAt = exactString(authority.approved_at, "APPROVED_AT_MISSING");
  if (!Number.isFinite(Date.parse(approvedAt))) blocked("APPROVED_AT_INVALID", approvedAt);
  const evidenceRef = exactString(authority.evidence_ref, "EVIDENCE_REF_MISSING");
  if (!Array.isArray(document.routes) || document.routes.length === 0) blocked("ROUTES_MISSING");
  const routeIds = new Set();
  const claimedCodes = new Map();
  const routes = document.routes.map((route) => {
    if (!route || typeof route !== "object" || Array.isArray(route)) blocked("ROUTE_INVALID");
    const routeId = exactString(route.route_id, "ROUTE_ID_MISSING");
    if (routeIds.has(routeId)) blocked("ROUTE_ID_DUPLICATE", routeId);
    routeIds.add(routeId);
    if (text(route.organization) !== organization || text(route.period) !== period) {
      blocked("ROUTE_SCOPE_MISMATCH", routeId);
    }
    if (text(route.proof_status).toUpperCase() !== PROOF_STATUS) {
      blocked("STATUS_INVALID", routeId);
    }
    if (text(route.authority_ref) !== approvalId) blocked("AUTHORITY_REF_MISMATCH", routeId);
    const sourceCodes = exactCodeList(route.source_codes, "SOURCE_CODES_INVALID");
    const targetCodes = exactCodeList(route.target_codes, "TARGET_CODES_INVALID");
    if (sourceCodes.some((code) => targetCodes.includes(code))) blocked("SOURCE_TARGET_OVERLAP", routeId);
    for (const code of [...sourceCodes, ...targetCodes]) {
      if (claimedCodes.has(code)) blocked("ROUTE_MEMBER_CONFLICT", `${code}:${claimedCodes.get(code)}:${routeId}`);
      claimedCodes.set(code, routeId);
    }
    const amountSupplied = route.amount !== undefined && route.amount !== null && route.amount !== "";
    const amount = amountSupplied ? Number(route.amount) : null;
    if (amountSupplied && (!Number.isFinite(amount) || amount <= 0)) {
      blocked("AMOUNT_CONTROL_INVALID", routeId);
    }
    return Object.freeze({
      route_id: routeId,
      organization,
      period,
      proof_status: PROOF_STATUS,
      authority_ref: approvalId,
      source_codes: Object.freeze(sourceCodes),
      target_codes: Object.freeze(targetCodes),
      amount,
    });
  });
  const rawConfirmations = document.intragroup_confirmations ?? [];
  if (!Array.isArray(rawConfirmations)) blocked("INTRAGROUP_CONFIRMATIONS_INVALID");
  const confirmationIds = new Set();
  const intragroupConfirmations = rawConfirmations.map((confirmation) => {
    if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)) {
      blocked("INTRAGROUP_CONFIRMATION_INVALID");
    }
    const confirmationId = exactString(
      confirmation.confirmation_id, "INTRAGROUP_CONFIRMATION_ID_MISSING",
    );
    if (confirmationIds.has(confirmationId)) {
      blocked("INTRAGROUP_CONFIRMATION_ID_DUPLICATE", confirmationId);
    }
    confirmationIds.add(confirmationId);
    if (text(confirmation.organization) !== organization || text(confirmation.period) !== period) {
      blocked("INTRAGROUP_SCOPE_MISMATCH", confirmationId);
    }
    const authorityRef = exactString(
      confirmation.authority_ref, "INTRAGROUP_AUTHORITY_REF_MISSING",
    );
    if (authorityRef !== approvalId) {
      blocked("INTRAGROUP_AUTHORITY_REF_MISMATCH", confirmationId);
    }
    const routeId = exactString(
      confirmation.intergroup_route_id, "INTRAGROUP_ROUTE_ID_MISSING",
    );
    const parentRoute = routes.find((route) => route.route_id === routeId);
    if (!parentRoute) blocked("INTRAGROUP_ROUTE_ID_UNKNOWN", confirmationId);
    const rootCode = exactString(confirmation.root_code, "INTRAGROUP_ROOT_CODE_MISSING");
    if (![...parentRoute.source_codes, ...parentRoute.target_codes].includes(rootCode)) {
      blocked("INTRAGROUP_ROOT_ROUTE_MISMATCH", confirmationId);
    }
    const descendantCodes = exactCodeList(
      confirmation.descendant_codes, "INTRAGROUP_DESCENDANT_CODES_INVALID",
    );
    if (descendantCodes.includes(rootCode)) {
      blocked("INTRAGROUP_ROOT_DESCENDANT_OVERLAP", confirmationId);
    }
    if (confirmation.source_codes !== undefined || confirmation.target_codes !== undefined
      || confirmation.allocations !== undefined) {
      blocked("INTRAGROUP_EXACT_ALLOCATION_FORBIDDEN", confirmationId);
    }
    if (text(confirmation.economic_status) !== INTRAGROUP_ECONOMIC_STATUS
      || text(confirmation.exact_allocation_status) !== INTRAGROUP_ALLOCATION_STATUS
      || text(confirmation.physical_erp_status) !== INTRAGROUP_PHYSICAL_STATUS) {
      blocked("INTRAGROUP_STATUS_INVALID", confirmationId);
    }
    const memberSet = descendantMemberSet(descendantCodes);
    return Object.freeze({
      confirmation_id: confirmationId,
      organization,
      period,
      run_id: runId,
      authority_ref: approvalId,
      evidence_ref: evidenceRef,
      proof_input_sha256: source.sha256,
      intergroup_route_id: routeId,
      root_code: rootCode,
      descendant_codes: memberSet.codes,
      descendant_member_set_sha256: memberSet.sha256,
      economic_status: INTRAGROUP_ECONOMIC_STATUS,
      exact_allocation_status: INTRAGROUP_ALLOCATION_STATUS,
      physical_erp_status: INTRAGROUP_PHYSICAL_STATUS,
    });
  });
  return Object.freeze({
    schema: SCHEMA,
    run_id: runId,
    organization,
    period,
    authority: Object.freeze({
      type: authorityType,
      approval_id: approvalId,
      approved_by: approvedBy,
      approved_at: approvedAt,
      evidence_ref: evidenceRef,
    }),
    routes: Object.freeze(routes),
    intragroup_confirmations: Object.freeze(intragroupConfirmations),
    source: Object.freeze(source),
  });
}

export async function loadEconomicRouteProofDocument(requestedPath) {
  const requested = text(requestedPath);
  if (!requested) return null;
  const resolved = path.resolve(requested);
  let bytes;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    blocked("RESOURCE_UNREADABLE", `${resolved}:${error.message}`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    blocked("JSON_INVALID", error.message);
  }
  return normalizedDocument(document, {
    path: resolved,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    size: bytes.length,
  });
}

function amountFor(row) {
  const value = row?.effective_delta ?? row?.normalized_delta ?? row?.delta ?? row?.raw_delta;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function bindEconomicRouteProofs(rows, {
  organization,
  period,
  document = null,
  tolerance = 0.01,
} = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  if (!document) {
    return {
      rows: inputRows,
      audit: Object.freeze({
        schema: SCHEMA,
        status: "MISSING_REVIEW_ONLY",
        route_count: 0,
        intragroup_confirmation_count: 0,
        bound_member_count: 0,
        correction_authority: false,
      }),
    };
  }
  const runOrganization = text(organization);
  const runPeriod = text(period);
  if (document.organization !== runOrganization || document.period !== runPeriod) {
    blocked("RUN_SCOPE_MISMATCH", `${runOrganization}|${runPeriod}`);
  }
  const byCode = new Map();
  for (const row of inputRows) {
    const code = text(row?.code ?? row?.row_id);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }
  const bindings = new Map();
  const routeAudits = [];
  const toleranceValue = Number.isFinite(Number(tolerance)) ? Math.abs(Number(tolerance)) : 0.01;
  for (const route of document.routes) {
    const sourceRows = route.source_codes.map((code) => {
      const matches = byCode.get(code) ?? [];
      if (matches.length === 0) blocked("MEMBER_MISSING", `${route.route_id}:${code}`);
      if (matches.length !== 1) blocked("MEMBER_DUPLICATE", `${route.route_id}:${code}`);
      return matches[0];
    });
    const targetRows = route.target_codes.map((code) => {
      const matches = byCode.get(code) ?? [];
      if (matches.length === 0) blocked("MEMBER_MISSING", `${route.route_id}:${code}`);
      if (matches.length !== 1) blocked("MEMBER_DUPLICATE", `${route.route_id}:${code}`);
      return matches[0];
    });
    for (const row of [...sourceRows, ...targetRows]) {
      if (text(row.organization) && text(row.organization) !== runOrganization) {
        blocked("MEMBER_ORGANIZATION_MISMATCH", `${route.route_id}:${text(row.code)}`);
      }
      if (text(row.period) && text(row.period) !== runPeriod) {
        blocked("MEMBER_PERIOD_MISMATCH", `${route.route_id}:${text(row.code)}`);
      }
      const existingId = text(row.intergroup_reclass_id);
      const existingStatus = text(row.intergroup_reclass_proof_status).toUpperCase();
      if ((existingId && existingId !== route.route_id) || (existingStatus && existingStatus !== PROOF_STATUS)) {
        blocked("PREEXISTING_PROOF_CONFLICT", `${route.route_id}:${text(row.code)}`);
      }
    }
    const sourceAmounts = sourceRows.map(amountFor);
    const targetAmounts = targetRows.map(amountFor);
    if (sourceAmounts.some((amount) => amount === null) || targetAmounts.some((amount) => amount === null)) {
      blocked("MEMBER_AMOUNT_MISSING", route.route_id);
    }
    if (sourceAmounts.some((amount) => amount >= -toleranceValue)) blocked("SOURCE_SIGN_CONTRADICTION", route.route_id);
    if (targetAmounts.some((amount) => amount <= toleranceValue)) blocked("TARGET_SIGN_CONTRADICTION", route.route_id);
    const sourceTotal = -sourceAmounts.reduce((sum, amount) => sum + amount, 0);
    const targetTotal = targetAmounts.reduce((sum, amount) => sum + amount, 0);
    if (Math.abs(sourceTotal - targetTotal) > toleranceValue) blocked("ROUTE_NOT_CLOSED", route.route_id);
    if (route.amount !== null && Math.abs(sourceTotal - route.amount) > toleranceValue) {
      blocked("AMOUNT_CONTROL_MISMATCH", route.route_id);
    }
    for (const row of sourceRows) bindings.set(row, route);
    for (const row of targetRows) bindings.set(row, route);
    routeAudits.push(Object.freeze({
      route_id: route.route_id,
      source_codes: route.source_codes,
      target_codes: route.target_codes,
      verified_amount: sourceTotal,
      supplied_amount_control: route.amount,
      member_count: sourceRows.length + targetRows.length,
      status: "BOUND_ECONOMIC_RECLASS_PROVEN",
    }));
  }
  const boundRows = inputRows.map((row) => {
    const route = bindings.get(row);
    if (!route) return row;
    const memberSet = routeMemberSet(route);
    return {
      ...row,
      intergroup_reclass_id: route.route_id,
      intergroup_reclass_proof_status: PROOF_STATUS,
      intergroup_reclass_authority_type: document.authority.type,
      intergroup_reclass_approval_id: document.authority.approval_id,
      intergroup_reclass_evidence_ref: document.authority.evidence_ref,
      intergroup_reclass_input_sha256: document.source.sha256,
      intergroup_reclass_run_id: document.run_id,
      intergroup_reclass_source_codes: memberSet.source_codes,
      intergroup_reclass_target_codes: memberSet.target_codes,
      intergroup_reclass_member_set_sha256: memberSet.sha256,
    };
  });
  return {
    rows: boundRows,
    audit: Object.freeze({
      schema: SCHEMA,
      status: "ACTIVE_EXPLICIT_RUN_BOUND_PROOF",
      run_id: document.run_id,
      organization: document.organization,
      period: document.period,
      authority_type: document.authority.type,
      approval_id: document.authority.approval_id,
      evidence_ref: document.authority.evidence_ref,
      input_sha256: document.source.sha256,
      input_size: document.source.size,
      route_count: routeAudits.length,
      intragroup_confirmation_count: document.intragroup_confirmations.length,
      intragroup_confirmation_ids: Object.freeze(
        document.intragroup_confirmations.map((confirmation) => confirmation.confirmation_id),
      ),
      bound_member_count: bindings.size,
      routes: Object.freeze(routeAudits),
      amount_used_as_consistency_control_only: true,
      correction_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      execution_allowed: false,
    }),
  };
}

export const ECONOMIC_ROUTE_PROOF_SCHEMA = SCHEMA;
export const ECONOMIC_ROUTE_PROOF_STATUS = PROOF_STATUS;
