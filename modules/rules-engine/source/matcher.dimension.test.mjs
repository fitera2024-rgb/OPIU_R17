import assert from "node:assert/strict";
import test from "node:test";

import { matchCandidates } from "./matcher.mjs";

const context = {
  run_id: "RUN-SAKHALIN-RULE-MATCHING",
  period: "2025-01",
  organization: { id: "ORG-PV", name: "ООО Планета Витаминов", path: "3 Сахалин" },
};

function accounting(overrides = {}) {
  return {
    debit_account: "26",
    credit_account: "70.1",
    debit_analytics: [],
    credit_analytics: [],
    debit_department: "ПВ Финансовый отдел",
    credit_department: "ПВ Финансовый отдел",
    cfo: "ЦМД Сахалин",
    ...overrides,
  };
}

function side(path, article = "ФЗП") {
  return {
    opiu_block_code: "",
    opiu_block_name: "ФЗП и компенсационные выплаты",
    opiu_block_path: path,
    article_code: "",
    article_name: article,
    article_path: `${path} / ${article}`,
  };
}

function rule(id, overrides = {}) {
  const path = overrides.path ?? "Расходы / 2_Административные расходы / ФЗП и компенсационные выплаты";
  return {
    rule_id: id,
    revision_id: `REV-${id}`,
    title: id,
    rule_type: "MAP_ARTICLE",
    origin: "MANUAL",
    status: "ACTIVE",
    is_current: true,
    enabled: true,
    valid_from_year: 2025,
    valid_to_year: null,
    scope: { scope_type: "ORG_ONLY", organization_id: overrides.organizationId ?? "ORG-PV" },
    intalev: side(path, overrides.article ?? "ФЗП"),
    erp: side(path, overrides.article ?? "ФЗП"),
    accounting: accounting(overrides.accounting),
    action: { action_type: "MAP_ARTICLE", parameters: {} },
    conditions: [],
    source: { source_type: "MANUAL" },
  };
}

function candidate(id, overrides = {}) {
  const base = rule(`SOURCE-${id}`, overrides);
  return {
    candidate_id: id,
    decision: "UNRESOLVED",
    user_status: "PENDING_REVIEW",
    impact_class: "RECONCILIATION_MAPPING",
    scope: base.scope,
    intalev: base.intalev,
    erp: base.erp,
    accounting: base.accounting,
    action: base.action,
    conditions: [],
    evidence: { source_engine: "R005", proof_status: "PROVEN" },
    confidence: { level: "HIGH", score: 1, reasons: [] },
  };
}

function match(oneCandidate, rules) {
  return matchCandidates([oneCandidate], { rules }, [], context)[0];
}

test("same normalized article with different debit accounts is not merged", () => {
  const result = match(
    candidate("DT44", { accounting: { debit_account: "44.1" } }),
    [rule("DT26")],
  );
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "NEW_RULE");
});

test("same article and debit with different disclosure paths is not merged", () => {
  const commercial = "Расходы / 3_Коммерческие расходы / ФЗП и компенсационные выплаты";
  const result = match(candidate("COMMERCIAL", { path: commercial }), [rule("ADMIN")]);
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "NEW_RULE");
});

test("same base signature with different CFO or department remains distinct", () => {
  const result = match(
    candidate("OTHER-DIM", { accounting: { debit_department: "ПВ ИТ Отдел", cfo: "ЦФО ИТ" } }),
    [rule("FINANCE-DIM")],
  );
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "NEW_RULE");
});

test("exact organization, article, debit, path and dimensions match deterministically", () => {
  const result = match(candidate("EXACT"), [rule("EXACT-RULE")]);
  assert.equal(result.existing_rule_id, "EXACT-RULE");
  assert.equal(result.decision, "EXISTING_RULE");
  assert.equal(result.user_status, "CONFIRMED");
});

test("missing required dimension is ambiguous and stays pending review", () => {
  const withoutDimension = candidate("AMBIGUOUS", {
    accounting: { debit_department: "", credit_department: "", cfo: "" },
  });
  const rules = [
    rule("FINANCE"),
    rule("ADMIN", { accounting: { debit_department: "ПВ Административный отдел", credit_department: "ПВ Административный отдел", cfo: "ЦМД Сахалин" } }),
  ];
  const result = match(withoutDimension, rules);
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "UNRESOLVED");
  assert.equal(result.user_status, "PENDING_REVIEW");
});

test("dimensionless candidate does not reuse a dimension-bound rule", () => {
  const result = match(
    candidate("MISSING-DIM", { accounting: { debit_department: "", credit_department: "", cfo: "" } }),
    [rule("DIMENSION-BOUND")],
  );
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "NEW_RULE");
  assert.equal(result.user_status, "PENDING_REVIEW");
});

test("debit 99 is closing evidence and never identifies an operating rule", () => {
  const closing = candidate("CLOSING", { accounting: { debit_account: "99", credit_account: "26" } });
  const result = match(closing, [rule("CLOSING-RULE", { accounting: { debit_account: "99", credit_account: "26" } })]);
  assert.equal(result.existing_rule_id, null);
  assert.equal(result.decision, "UNRESOLVED");
  assert.equal(result.user_status, "PENDING_REVIEW");
});
