const DIRECT_RECONCILIATION_STATUSES = Object.freeze([
  "MATCHED",
  "MATCHED_DUPLICATE_SAME_VALUE",
  "MATCHED_DUPLICATE_EXACT_IDENTITY",
  "MATCHED_DUPLICATE_HIERARCHY",
  "ZERO_NO_ACTIVITY",
  "ZERO_NO_ACTIVITY_DUPLICATE_PROVEN",
]);

const DIRECT_RECONCILIATION_STATUS_SET = new Set(DIRECT_RECONCILIATION_STATUSES);

function tokens(status) {
  return String(status ?? "")
    .split("+")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function requiresReconciliationReview(status) {
  const items = tokens(status);
  if (items.length === 0) return true;
  if (items.length === 1 && items[0] === "INFORMATIONAL_COVERED") return false;
  return items.some((item) => !DIRECT_RECONCILIATION_STATUS_SET.has(item));
}

export function deriveReconciliationStatus({
  comparisonMode,
  intalevStatus,
  erpStatus,
  intalevAmount,
  erpAmount,
  delta,
  tolerance,
  erpBindingStatus,
}) {
  if (erpBindingStatus && erpBindingStatus !== "PROVEN") {
    return "REQUIRES_CLARIFICATION";
  }
  if (
    comparisonMode === "INFORMATIONAL_COVERED" ||
    erpStatus === "INFORMATIONAL_COVERED"
  ) {
    return "INFORMATIONAL_COVERED";
  }
  if (
    typeof intalevAmount !== "number" ||
    typeof erpAmount !== "number" ||
    typeof delta !== "number" ||
    requiresReconciliationReview(intalevStatus) ||
    requiresReconciliationReview(erpStatus)
  ) {
    return "REQUIRES_CLARIFICATION";
  }
  return Math.abs(delta) > Number(tolerance)
    ? "DISCREPANCY"
    : "RECONCILED";
}

export function summaryStatusFormula(row, toleranceRef = "'00_Паспорт'!$B$18") {
  const directIntalev = `OR(LEFT(K${row},7)="MATCHED",LEFT(K${row},16)="ZERO_NO_ACTIVITY")`;
  const directErp = `OR(LEFT(L${row},7)="MATCHED",LEFT(L${row},16)="ZERO_NO_ACTIVITY")`;
  return `=IF(R${row}<>"PROVEN","ТРЕБУЕТ ПРОВЕРКИ",IF(L${row}="INFORMATIONAL_COVERED","СПРАВОЧНО",IF(OR(NOT(ISNUMBER(D${row})),NOT(ISNUMBER(E${row})),NOT(${directIntalev}),NOT(${directErp})),"ТРЕБУЕТ ПРОВЕРКИ",IF(ABS(I${row})<=${toleranceRef},"СОШЛОСЬ","РАСХОЖДЕНИЕ"))))`;
}

function hierarchyBlockedControlFormula(sheet, column, startRow, endRow) {
  const rowCount = endRow - startRow + 1;
  const range = `'${sheet}'!$${column}$${startRow}:$${column}$${endRow}`;
  return `=${rowCount}-COUNTIF(${range},"PASS")-COUNTIF(${range},"LEAF")`;
}

export function intalevHierarchyBlockedControlFormula(startRow, endRow) {
  return hierarchyBlockedControlFormula(
    "03_Инталев_узлы",
    "I",
    startRow,
    endRow,
  );
}

export function erpHierarchyBlockedControlFormula(startRow, endRow) {
  return hierarchyBlockedControlFormula(
    "04_ERP_статьи",
    "V",
    startRow,
    endRow,
  );
}

export { DIRECT_RECONCILIATION_STATUSES };
