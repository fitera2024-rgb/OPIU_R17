import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveReconciliationStatus,
  erpHierarchyBlockedControlFormula,
  intalevHierarchyBlockedControlFormula,
  requiresReconciliationReview,
  summaryStatusFormula,
} from "./r005_reconciliation_status.mjs";

test("blocked and aggregated zero-residual rows remain review-only", () => {
  const base = {
    comparisonMode: "",
    intalevAmount: 100,
    erpAmount: 100,
    delta: 0,
    tolerance: 0.01,
  };
  assert.equal(deriveReconciliationStatus({
    ...base,
    intalevStatus: "MATCHED",
    erpStatus: "HIERARCHY_MISMATCH",
  }), "REQUIRES_CLARIFICATION");
  assert.equal(deriveReconciliationStatus({
    ...base,
    intalevStatus: "MATCHED",
    erpStatus: "AGGREGATED_RULE",
  }), "REQUIRES_CLARIFICATION");
  assert.equal(requiresReconciliationReview("BLOCKED_SOURCE+MATCHED"), true);
});

test("direct matched rows distinguish reconciled and discrepancy", () => {
  assert.equal(deriveReconciliationStatus({
    comparisonMode: "",
    intalevStatus: "MATCHED",
    erpStatus: "MATCHED_DUPLICATE_EXACT_IDENTITY",
    intalevAmount: 100,
    erpAmount: 100,
    delta: 0,
    tolerance: 0.01,
  }), "RECONCILED");
  assert.equal(deriveReconciliationStatus({
    comparisonMode: "",
    intalevStatus: "MATCHED",
    erpStatus: "MATCHED",
    intalevAmount: 100,
    erpAmount: 90,
    delta: 10,
    tolerance: 0.01,
  }), "DISCREPANCY");
});

test("ERP binding status independently keeps a numeric row in review", () => {
  const base = {
    comparisonMode: "",
    intalevStatus: "MATCHED",
    erpStatus: "MATCHED",
    intalevAmount: 100,
    erpAmount: 100,
    delta: 0,
    tolerance: 0.01,
  };
  assert.equal(deriveReconciliationStatus({
    ...base,
    erpBindingStatus: "UNPROVEN",
  }), "REQUIRES_CLARIFICATION");
  assert.equal(deriveReconciliationStatus({
    ...base,
    erpBindingStatus: "MISMATCH",
  }), "REQUIRES_CLARIFICATION");
  assert.equal(deriveReconciliationStatus({
    ...base,
    erpBindingStatus: "PROVEN",
  }), "RECONCILED");
});

test("workbook formulas fail closed on controls and every non-PASS/LEAF status", () => {
  const status = summaryStatusFormula(7);
  assert.match(status, /LEFT\(K7,7\)="MATCHED"/);
  assert.match(status, /LEFT\(L7,16\)="ZERO_NO_ACTIVITY"/);
  assert.match(status, /R7<>"PROVEN"/);
  assert.match(status, /ТРЕБУЕТ ПРОВЕРКИ/);
  assert.equal(
    intalevHierarchyBlockedControlFormula(5, 224),
    `=220-COUNTIF('03_Инталев_узлы'!$I$5:$I$224,"PASS")-COUNTIF('03_Инталев_узлы'!$I$5:$I$224,"LEAF")`,
  );
  assert.equal(
    erpHierarchyBlockedControlFormula(5, 214),
    `=210-COUNTIF('04_ERP_статьи'!$V$5:$V$214,"PASS")-COUNTIF('04_ERP_статьи'!$V$5:$V$214,"LEAF")`,
  );
});
