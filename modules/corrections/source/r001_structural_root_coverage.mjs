import {
  structuralControlGroupForCode,
  structuralControlGroupsFromConfig,
} from "../../reconciliation/source/structural_control_groups.mjs";

function text(value) {
  return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function upper(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function exactCode(value) {
  return upper(value);
}

function sameCodeSet(left = [], right = []) {
  const leftCodes = [...new Set(left.map(exactCode).filter(Boolean))].sort();
  const rightCodes = [...new Set(right.map(exactCode).filter(Boolean))].sort();
  return leftCodes.length === rightCodes.length
    && leftCodes.every((code, index) => code === rightCodes[index]);
}

function exactZeroWithin(value, tolerance) {
  return typeof value === "number"
    && Number.isFinite(value)
    && Math.abs(value) <= Number(tolerance ?? 0);
}

function matchingClosedControlResult(payload, row, partitionPeriod, group) {
  const groupId = text(group?.group_id ?? group?.id);
  const organization = text(payload?.organization);
  const period = text(partitionPeriod || payload?.period);
  const candidates = (Array.isArray(payload?.structural_group_control_results)
    ? payload.structural_group_control_results
    : []).filter((result) =>
    text(result?.group_id ?? result?.control_set_id) === groupId
      && text(result?.organization) === organization
      && text(result?.period) === period);
  if (candidates.length !== 1) return null;
  const result = candidates[0];
  const expectedMembers = group?.member_codes ?? [];
  const resultMembers = result?.member_codes ?? [];
  const resultRowMembers = Array.isArray(result?.member_rows)
    ? result.member_rows.map((member) => member?.code)
    : [];
  if (
    result?.complete !== true
    || upper(result?.classification) !== "STRUCTURAL_GROUP_SUM_OK"
    || result?.review_only !== false
    || !Array.isArray(result?.blockers)
    || result.blockers.length !== 0
    || !sameCodeSet(resultMembers, expectedMembers)
    || !sameCodeSet(resultRowMembers, expectedMembers)
    || !exactZeroWithin(result?.control_sum_delta, group?.tolerance)
    || result?.structural_effect_consumed_once !== true
    || result?.control_residual_consumed_once !== true
    || result?.individual_parent_reclassification_allowed !== false
    || result?.descendant_internal_checks_active !== true
    || Number(result?.structural_control_financial_posting_rows) !== 0
    || Number(result?.posting_rows) !== 0
    || result?.posting_allowed !== false
    || result?.execution_allowed !== false
    || result?.ready_to_upload !== false
    || result?.release_allowed !== false
    || result?.live_1c_allowed !== false
    || result?.report_only !== true
  ) return null;

  const rowGroupId = text(row?.structural_group_control_set_id ?? row?.structural_control_group_id);
  if (
    rowGroupId !== groupId
    || row?.owner_presentation_block_exempt !== true
    || row?.owner_control_only !== true
    || upper(row?.owner_posting_classification) !== "NON_POSTING"
    || row?.structural_group_control_enabled !== true
    || upper(row?.structural_group_sum_status) !== "STRUCTURAL_GROUP_SUM_OK"
    || row?.structural_group_descendant_internal_checks_active !== true
    || Number(row?.structural_group_control_financial_posting_rows) !== 0
  ) return null;
  return result;
}

export function isClosedStructuralRootForR001(payload, row, partitionPeriod = "") {
  const organization = text(payload?.organization);
  const groups = structuralControlGroupsFromConfig(payload, { organization });
  const group = structuralControlGroupForCode(row, groups, { organization });
  if (!group) return false;
  return matchingClosedControlResult(payload, row, partitionPeriod, group) !== null;
}

export function financialCoverageNonzeroRows(payload) {
  const partitions = Array.isArray(payload?.period_rows) && payload.period_rows.length > 0
    ? payload.period_rows
    : [{ period: text(payload?.period), rows: payload?.rows ?? [] }];
  return partitions.flatMap((partition) => (partition?.rows ?? [])
    .filter((row) =>
      !isClosedStructuralRootForR001(payload, row, partition?.period)
      && typeof row?.delta === "number"
      && Number.isFinite(row.delta)
      && Math.abs(row.delta) > 0.009)
    .map((row) => ({ period: text(partition?.period), code: text(row?.code) })));
}
