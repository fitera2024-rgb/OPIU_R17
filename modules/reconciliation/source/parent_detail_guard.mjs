export const BLOCKED_PARENT_DETAIL_MISMATCH = "BLOCKED_PARENT_DETAIL_MISMATCH";
export const REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN = "REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN";

const MONEY_SCALE = 100;

function toMinorUnits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * MONEY_SCALE);
}

function fromMinorUnits(value) {
  return value === null ? null : value / MONEY_SCALE;
}

function aggregationSummary(aggregation) {
  if (!aggregation || typeof aggregation !== "object") return null;
  return {
    schema: String(aggregation.schema ?? ""),
    status: String(aggregation.status ?? ""),
    reason_code: String(aggregation.reason_code ?? ""),
    amount: typeof aggregation.amount === "number" ? aggregation.amount : null,
    source_system: String(aggregation.source_system ?? ""),
    source_identity_scope: String(aggregation.source_identity_scope ?? ""),
    aggregation_grain_id: String(aggregation.aggregation_grain_id ?? ""),
    selected_source_identity_count: Array.isArray(aggregation.selected)
      ? aggregation.selected.length
      : 0,
    ignored_source_identity_count: Array.isArray(aggregation.ignored)
      ? aggregation.ignored.length
      : 0,
    conflict_count: Array.isArray(aggregation.conflicts)
      ? aggregation.conflicts.length
      : 0,
    correction_authority: aggregation.correction_authority === true,
  };
}

export function evaluateParentDetailConsistency({
  parentTotal,
  detailSum,
  tolerance = 0.01,
  parentTrace = [],
  detailTrace = [],
  parentAggregation = null,
  detailAggregation = null,
}) {
  const parentUnits = toMinorUnits(parentTotal);
  const detailUnits = toMinorUnits(detailSum);
  const toleranceUnits = toMinorUnits(Math.abs(tolerance));
  const sourceTrace = { parent_total: [...parentTrace], detail: [...detailTrace] };
  let reasonCode = "";
  if (parentUnits === null) reasonCode = "MISSING_PARENT_TOTAL";
  if (detailUnits === null) reasonCode = "MISSING_DETAIL_SUM";
  const differenceUnits = parentUnits === null || detailUnits === null
    ? null
    : parentUnits - detailUnits;
  const grainProven = parentAggregation?.status === "PROVEN" && detailAggregation?.status === "PROVEN" &&
    parentAggregation.aggregation_grain_id === detailAggregation.aggregation_grain_id &&
    parentAggregation.source_identity_scope === detailAggregation.source_identity_scope &&
    parentAggregation.source_system === detailAggregation.source_system;
  const grainStatus = grainProven
    ? "PASS"
    : parentAggregation?.status === "BLOCKED" || detailAggregation?.status === "BLOCKED"
      ? BLOCKED_PARENT_DETAIL_MISMATCH
      : REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN;
  const withinTolerance = grainStatus === "PASS" && differenceUnits !== null && Math.abs(differenceUnits) <= (toleranceUnits ?? 1);
  const result = {
    status: withinTolerance ? "PASS" : grainStatus,
    reason_code: withinTolerance
      ? "WITHIN_TOLERANCE"
      : grainStatus === REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN
        ? "AGGREGATION_GRAIN_UNPROVEN"
        : reasonCode || "VALUE_MISMATCH",
    parent_total: fromMinorUnits(parentUnits),
    detail_sum: fromMinorUnits(detailUnits),
    difference: fromMinorUnits(differenceUnits),
    tolerance: fromMinorUnits(toleranceUnits ?? 1),
    within_tolerance: withinTolerance,
    source_trace: sourceTrace,
    parent_aggregation: parentAggregation,
    detail_aggregation: detailAggregation,
    correction_authority: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
  return result;
}

export function buildParentDetailBlockedResult(control) {
  if (![BLOCKED_PARENT_DETAIL_MISMATCH, REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN].includes(control?.status)) {
    throw new Error("Parent/detail result requires a blocked or review-only control.");
  }
  const parentTrace = control.source_trace?.parent_total ?? [];
  const detailTrace = control.source_trace?.detail ?? [];
  const shown = (value) => typeof value === "number" ? value.toFixed(2) : "null";
  const safeControl = {
    ...control,
    parent_aggregation: aggregationSummary(control.parent_aggregation),
    detail_aggregation: aggregationSummary(control.detail_aggregation),
  };
  return {
    amount: null,
    status: control.status,
    trace: [...parentTrace, ...detailTrace],
    note:
      `ERP parent/detail ${control.status === REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN ? "оставлен на проверку" : "заблокирован"} (${control.reason_code}): ` +
      `parent_total=${shown(control.parent_total)}, detail_sum=${shown(control.detail_sum)}, ` +
      `difference=${shown(control.difference)}, tolerance=${shown(control.tolerance)}.`,
    parent_detail_control: safeControl,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
