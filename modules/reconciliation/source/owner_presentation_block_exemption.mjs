import {
  STRUCTURAL_CONTROL_GROUPS,
  structuralControlGroupCodes,
  structuralControlGroupForCode,
} from "./structural_control_groups.mjs";

// Retain exported legacy names for downstream compatibility. Their semantics
// are now driven only by an enabled user-configured exception set.
export const OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION =
  "STRUCTURAL_GROUP_ROOT_EXCEPTION";

export const OWNER_PRESENTATION_BLOCK_EXEMPT_CODES = structuralControlGroupCodes();

export const OWNER_PRESENTATION_CONTROL_GROUP_SCHEMA =
  "opiu-structural-group-control-result-v1";

export const OWNER_PRESENTATION_CONTROL_GROUP_ID =
  "STRUCTURAL_GROUP_CONTROL:UNCONFIGURED";

const CONCRETE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function exactCode(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLocaleUpperCase("ru-RU");
}

export function ownerPresentationBlockCode(value) {
  if (value && typeof value === "object") {
    return exactCode(
      value.reporting_code
        ?? value.code
        ?? value.row_code
        ?? value.reconciliation_row,
    );
  }
  return exactCode(value);
}

export function isOwnerPresentationBlockExempt(value, groups = STRUCTURAL_CONTROL_GROUPS) {
  return structuralControlGroupForCode(
    value,
    Array.isArray(groups) ? groups : STRUCTURAL_CONTROL_GROUPS,
  ) !== null;
}

function scopeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowScopeContains(row, selectedOrganization, selectedPeriod) {
  const organizations = [
    row?.organization_id,
    row?.organization_code,
    row?.organization,
  ].map(scopeText).filter(Boolean);
  const periods = [row?.month, row?.period_id, row?.period]
    .map(scopeText)
    .filter(Boolean);
  return organizations.includes(selectedOrganization) && periods.includes(selectedPeriod);
}

function rowScopeConflicts(row, selectedOrganization, selectedPeriod) {
  const authoritativeOrganization = scopeText(row?.organization_id);
  const organizations = [row?.organization_code, row?.organization]
    .map(scopeText)
    .filter(Boolean);
  const authoritativePeriod = scopeText(row?.month ?? row?.period_id);
  const periods = [row?.period].map(scopeText).filter(Boolean);
  return Boolean(
    (authoritativeOrganization && authoritativeOrganization !== selectedOrganization
      && organizations.includes(selectedOrganization))
    || (authoritativePeriod && authoritativePeriod !== selectedPeriod
      && periods.includes(selectedPeriod)),
  );
}

function finiteAmount(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function amountCents(value) {
  if (!finiteAmount(value)) return null;
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  const represented = rounded / 100;
  const representationTolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.abs(value - represented) <= representationTolerance ? rounded : null;
}

function amountFromCents(value) {
  return value === null ? null : value / 100;
}

function controlValue(row, field, fallback) {
  const configured = field ? row?.[field] : undefined;
  return configured ?? row?.[fallback]?.amount ?? row?.[fallback];
}

function rawDeltaValue(row, group) {
  const direct = row?.raw_delta ?? row?.delta ?? row?.normalized_delta;
  if (direct !== undefined && direct !== null) return direct;
  const intalev = controlValue(row, group?.intalev_value_field, "intalev");
  const erp = controlValue(row, group?.erp_value_field, "erp");
  return finiteAmount(intalev) && finiteAmount(erp) ? intalev - erp : null;
}

function sideMemberCodes(group, side) {
  const configured = group?.[`${side}_member_codes`];
  return (Array.isArray(configured) ? configured : group?.member_codes ?? [])
    .map(exactCode);
}

function controlMember(row, group, { sumOk = false } = {}) {
  const rawDeltaCents = amountCents(rawDeltaValue(row, group));
  const intalevCents = amountCents(controlValue(row, group?.intalev_value_field, "intalev"));
  const erpCents = amountCents(controlValue(row, group?.erp_value_field, "erp"));
  const code = ownerPresentationBlockCode(row);
  const intalevIncluded = sideMemberCodes(group, "intalev").includes(code);
  const erpIncluded = sideMemberCodes(group, "erp").includes(code);
  const contributionCents = (intalevIncluded ? intalevCents ?? 0 : 0)
    - (erpIncluded ? erpCents ?? 0 : 0);
  return Object.freeze({
    code,
    classification: sumOk ? "STRUCTURAL_GROUP_SUM_OK" : "STRUCTURAL_GROUP_SUM_MISMATCH",
    structural_group_control_enabled: true,
    structural_group_control_set_id: group?.group_id ?? null,
    structural_control_group_id: group?.group_id ?? null,
    raw_delta: amountFromCents(rawDeltaCents),
    effective_delta: sumOk ? 0 : amountFromCents(rawDeltaCents),
    intalev_amount: amountFromCents(intalevCents),
    erp_amount: amountFromCents(erpCents),
    intalev_control_member: intalevIncluded,
    erp_control_member: erpIncluded,
    control_contribution: amountFromCents(contributionCents),
    descendants_checked: true,
    descendant_internal_checks_active: true,
    descendant_policy: "ORDINARY_ALL_GROUP_CHECK",
    child_cross_netting_allowed: true,
    correction_amount: 0,
    financial_rows: 0,
    posting_allowed: false,
    execution_allowed: false,
  });
}

export function ownerPresentationBlockExemption(value, {
  period = "",
  normalizedDelta = null,
  groups = STRUCTURAL_CONTROL_GROUPS,
  controlResult = null,
} = {}) {
  const group = structuralControlGroupForCode(value, groups);
  if (!group) return null;
  const code = ownerPresentationBlockCode(value);
  const member = controlResult?.member_rows?.find((item) => item.code === code) ?? null;
  const memberRows = (controlResult?.member_rows ?? []).map((item) => Object.freeze({
    code: ownerPresentationBlockCode(item),
    raw_delta: item?.raw_delta ?? null,
    effective_delta: item?.effective_delta ?? null,
  }));
  return Object.freeze({
    code,
    period: String(period ?? "").trim(),
    classification: controlResult?.classification ?? OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION,
    sum_status: controlResult?.sum_status ?? controlResult?.classification ?? null,
    control_reclass_status: controlResult?.control_reclass_status ?? null,
    review_only: controlResult?.review_only ?? null,
    control_classification: "CONTROL_ONLY",
    posting_classification: "NON_POSTING",
    structural_group_control_enabled: true,
    structural_group_control_set_id: group.group_id,
    structural_control_group_id: group.group_id,
    member_codes: Object.freeze([...(controlResult?.member_codes ?? group.member_codes ?? [])]),
    member_rows: Object.freeze(memberRows),
    mode: group.mode ?? "SUM_DELTA_ONLY",
    control_only: true,
    non_posting: true,
    raw_delta: member?.raw_delta
      ?? (typeof normalizedDelta === "number" && Number.isFinite(normalizedDelta)
        ? normalizedDelta
        : null),
    effective_delta: member?.effective_delta ?? null,
    root_effective_delta: member?.effective_delta ?? null,
    control_sum_delta: controlResult?.control_sum_delta ?? null,
    control_sum_delta_cents: controlResult?.control_sum_delta_cents ?? null,
    tolerance: controlResult?.tolerance ?? group?.tolerance ?? null,
    control_tolerance_cents: controlResult?.control_tolerance_cents
      ?? group?.tolerance_cents
      ?? null,
    descendant_internal_checks_active: true,
    descendant_policy: "ORDINARY_ALL_GROUP_CHECK",
    child_cross_netting_allowed: true,
    correction_amount: 0,
    financial_rows: 0,
    structural_control_financial_posting_rows: 0,
    posting_rows: 0,
    posting_allowed: false,
    execution_allowed: false,
  });
}

function safeControlResult({
  organization,
  period,
  group,
  tolerance,
  toleranceCents,
  classification,
  complete,
  blockers,
  memberRows,
  controlSumDeltaCents = null,
  intalevControlTotalCents = null,
  erpControlTotalCents = null,
  ignoredOutOfScopeParentRows = 0,
}) {
  const sumOk = classification === "STRUCTURAL_GROUP_SUM_OK";
  const reviewOnly = classification !== "STRUCTURAL_GROUP_SUM_OK";
  const allMemberDeltasZero = complete === true && memberRows.length > 0
    && memberRows.every((member) => {
      const raw = amountCents(member?.raw_delta);
      return raw !== null && Math.abs(raw) <= (toleranceCents ?? 0);
    });
  const controlReclassStatus = complete !== true
    ? "STRUCTURAL_GROUP_CONFIG_INVALID"
    : sumOk
      ? allMemberDeltasZero
        ? "CONTROL_SET_MATCHED_NO_RECLASS"
        : "INTRA_CONTROL_SET_RECLASS_CLOSED"
      : "INTER_GROUP_RECLASS_OPEN";
  const intalevMemberCodes = sideMemberCodes(group, "intalev");
  const erpMemberCodes = sideMemberCodes(group, "erp");
  const intergroupReclassCandidate = complete === true && !sumOk
    ? Object.freeze({
        schema: "opiu-structural-control-intergroup-candidate.v1",
        control_set_id: group?.group_id ?? OWNER_PRESENTATION_CONTROL_GROUP_ID,
        organization,
        period,
        classification: "INTER_GROUP_RECLASS_CONTROL",
        decision: "REVIEW_ONLY",
        physical_proof_status: "UNPROVEN",
        control_delta: amountFromCents(controlSumDeltaCents),
        control_delta_cents: controlSumDeltaCents,
        intalev_member_codes: Object.freeze(intalevMemberCodes),
        erp_member_codes: Object.freeze(erpMemberCodes),
        financial_candidate: false,
        correction_authority: false,
        financial_rows: 0,
        posting_rows: 0,
        execution_allowed: false,
      })
    : null;
  return Object.freeze({
    schema: OWNER_PRESENTATION_CONTROL_GROUP_SCHEMA,
    group_id: group?.group_id ?? OWNER_PRESENTATION_CONTROL_GROUP_ID,
    control_set_id: group?.group_id ?? OWNER_PRESENTATION_CONTROL_GROUP_ID,
    organization,
    period,
    mode: group?.mode ?? "SUM_DELTA_ONLY",
    member_codes: Object.freeze([...(group?.member_codes ?? [])]),
    intalev_member_codes: Object.freeze(intalevMemberCodes),
    erp_member_codes: Object.freeze(erpMemberCodes),
    classification,
    sum_status: classification,
    control_reclass_status: controlReclassStatus,
    expected_control_delta: 0,
    expected_control_delta_cents: 0,
    complete,
    review_only: reviewOnly,
    visible_control: true,
    blockers: Object.freeze([...new Set(blockers)]),
    tolerance,
    control_tolerance_cents: toleranceCents,
    control_sum_delta: amountFromCents(controlSumDeltaCents),
    control_sum_delta_cents: controlSumDeltaCents,
    control_delta: amountFromCents(controlSumDeltaCents),
    control_delta_cents: controlSumDeltaCents,
    intalev_control_total: amountFromCents(intalevControlTotalCents),
    intalev_control_total_cents: intalevControlTotalCents,
    erp_control_total: amountFromCents(erpControlTotalCents),
    erp_control_total_cents: erpControlTotalCents,
    intergroup_reclass_candidate: intergroupReclassCandidate,
    member_rows: Object.freeze(memberRows.map((member) => Object.freeze({
      ...member,
      control_reclass_status: controlReclassStatus,
      descendant_policy: "ORDINARY_ALL_GROUP_CHECK",
      child_cross_netting_allowed: true,
    }))),
    ignored_out_of_scope_parent_rows: ignoredOutOfScopeParentRows,
    individual_parent_reclassification_allowed: false,
    structural_effect_consumed_once: sumOk,
    control_residual_consumed_once: sumOk,
    intergroup_search_required: complete === true && !sumOk,
    intergroup_search_scope: complete === true && !sumOk
      ? "ALL_OTHER_ELIGIBLE_GROUPS_SAME_ORGANIZATION_MONTH"
      : null,
    descendant_internal_checks_active: true,
    descendants_checked: true,
    child_cross_netting_allowed: true,
    correction_amount: 0,
    financial_rows: 0,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    structural_control_financial_posting_rows: 0,
    posting_allowed: false,
    execution_allowed: false,
    report_only: true,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
  });
}

/**
 * Assess one enabled SUM_DELTA_ONLY exception in one exact organization/month.
 * Missing roots, duplicate roots, invalid cents and scope conflicts remain
 * visible configuration failures and never grant financial authority.
 */
export function assessOwnerPresentationControlGroup(rows, {
  organization = "",
  period = "",
  tolerance = null,
  group = null,
} = {}) {
  const selectedOrganization = scopeText(organization);
  const selectedPeriod = scopeText(period);
  const numericTolerance = tolerance === null
    ? Number(group?.tolerance ?? 0.01)
    : Number(tolerance);
  const toleranceCents = amountCents(numericTolerance);
  const blockers = [];
  const explicitSidesValid = Array.isArray(group?.intalev_member_codes) && group.intalev_member_codes.length > 0 &&
    Array.isArray(group?.erp_member_codes) && group.erp_member_codes.length > 0;
  if (!group || !Array.isArray(group?.member_codes) ||
      (!explicitSidesValid && group.member_codes.length < 2) || group.member_codes.length === 0) {
    blockers.push("STRUCTURAL_GROUP_CONFIG_MISSING_OR_INVALID");
  }
  if (!selectedOrganization) blockers.push("STRUCTURAL_GROUP_ORGANIZATION_MISSING");
  if (!CONCRETE_MONTH_PATTERN.test(selectedPeriod)) blockers.push("STRUCTURAL_GROUP_PERIOD_NOT_CONCRETE_MONTH");
  if (toleranceCents === null || numericTolerance < 0) blockers.push("STRUCTURAL_GROUP_TOLERANCE_NOT_EXACT_CENTS");

  const inputRows = Array.isArray(rows) ? rows : [];
  const exactParents = inputRows.filter((row) => structuralControlGroupForCode(row, [group]));
  if (exactParents.some((row) => rowScopeConflicts(row, selectedOrganization, selectedPeriod))) {
    blockers.push("STRUCTURAL_GROUP_SCOPE_CONFLICT");
  }
  const selectedParents = exactParents.filter((row) =>
    rowScopeContains(row, selectedOrganization, selectedPeriod));
  const ignoredOutOfScopeParentRows = exactParents.length - selectedParents.length;
  const memberCodes = [...(group?.member_codes ?? [])];
  const intalevMemberCodes = sideMemberCodes(group, "intalev");
  const erpMemberCodes = sideMemberCodes(group, "erp");
  const byCode = new Map(memberCodes.map((code) => [exactCode(code), []]));
  for (const row of selectedParents) {
    const code = ownerPresentationBlockCode(row);
    if (byCode.has(code)) byCode.get(code).push(row);
  }

  for (const code of memberCodes.map(exactCode)) {
    const members = byCode.get(code) ?? [];
    if (members.length === 0) blockers.push(`STRUCTURAL_GROUP_MEMBER_UNKNOWN:${code}`);
    if (members.length > 1) blockers.push(`STRUCTURAL_GROUP_MEMBER_DUPLICATE:${code}`);
    for (const member of members) {
      const delta = rawDeltaValue(member, group);
      if (!finiteAmount(delta)) blockers.push(`STRUCTURAL_GROUP_RAW_DELTA_NON_NUMERIC:${code}`);
      else if (amountCents(delta) === null) blockers.push(`STRUCTURAL_GROUP_RAW_DELTA_NOT_EXACT_CENTS:${code}`);
    }
  }
  for (const code of intalevMemberCodes) {
    const members = byCode.get(code) ?? [];
    for (const member of members) {
      const amount = controlValue(member, group?.intalev_value_field, "intalev");
      if (!finiteAmount(amount)) blockers.push(`STRUCTURAL_GROUP_INTALEV_NON_NUMERIC:${code}`);
      else if (amountCents(amount) === null) blockers.push(`STRUCTURAL_GROUP_INTALEV_NOT_EXACT_CENTS:${code}`);
    }
  }
  for (const code of erpMemberCodes) {
    const members = byCode.get(code) ?? [];
    for (const member of members) {
      const amount = controlValue(member, group?.erp_value_field, "erp");
      if (!finiteAmount(amount)) blockers.push(`STRUCTURAL_GROUP_ERP_NON_NUMERIC:${code}`);
      else if (amountCents(amount) === null) blockers.push(`STRUCTURAL_GROUP_ERP_NOT_EXACT_CENTS:${code}`);
    }
  }

  const selectedUniqueRows = memberCodes
    .map(exactCode)
    .flatMap((code) => (byCode.get(code) ?? []).slice(0, 1));
  if (blockers.length > 0) {
    return safeControlResult({
      organization: selectedOrganization,
      period: selectedPeriod,
      group,
      tolerance: toleranceCents === null ? null : numericTolerance,
      toleranceCents,
      classification: "STRUCTURAL_GROUP_CONFIG_INVALID",
      complete: false,
      blockers,
      memberRows: selectedUniqueRows.map((row) => controlMember(row, group)),
      ignoredOutOfScopeParentRows,
    });
  }

  const selectedByCode = new Map(selectedUniqueRows.map((row) => [ownerPresentationBlockCode(row), row]));
  const intalevControlTotalCents = intalevMemberCodes.reduce((sum, code) =>
    sum + amountCents(controlValue(selectedByCode.get(code), group?.intalev_value_field, "intalev")), 0);
  const erpControlTotalCents = erpMemberCodes.reduce((sum, code) =>
    sum + amountCents(controlValue(selectedByCode.get(code), group?.erp_value_field, "erp")), 0);
  const controlSumDeltaCents = intalevControlTotalCents - erpControlTotalCents;
  const sumOk = Math.abs(controlSumDeltaCents) <= toleranceCents;
  const classification = sumOk
    ? "STRUCTURAL_GROUP_SUM_OK"
    : "STRUCTURAL_GROUP_SUM_MISMATCH";
  return safeControlResult({
    organization: selectedOrganization,
    period: selectedPeriod,
    group,
    tolerance: numericTolerance,
    toleranceCents,
    classification,
    complete: true,
    blockers: [],
    memberRows: selectedUniqueRows.map((row) => controlMember(row, group, { sumOk })),
    controlSumDeltaCents,
    intalevControlTotalCents,
    erpControlTotalCents,
    ignoredOutOfScopeParentRows,
  });
}

export function assessConfiguredStructuralControlGroups(rows, {
  organization = "",
  period = "",
  tolerance = null,
  groups = STRUCTURAL_CONTROL_GROUPS,
} = {}) {
  return Object.freeze((Array.isArray(groups) ? groups : [])
    .map((group) => assessOwnerPresentationControlGroup(rows, {
      organization,
      period,
      tolerance: group?.tolerance ?? tolerance,
      group,
    })));
}
