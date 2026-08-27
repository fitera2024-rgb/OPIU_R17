import test from "node:test";
import assert from "node:assert/strict";
import { matchCandidates } from "./matcher.mjs";

const ADMIN = "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 1_Административные расходы";
const SALES = "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 2_Коммерческие расходы";

function rule({ id, debit = "26", path = ADMIN, cfo = "УК9", department = "Администрация", organization = "UK9" }) {
  return {
    rule_id: id, revision_id: `REV-${id}`, title: id, rule_type: "MAP_ARTICLE", origin: "R005",
    status: "ACTIVE", is_current: true, enabled: true, valid_from_year: 2025, valid_to_year: null,
    scope: { scope_type: "ORG_ONLY", organization_id: organization },
    intalev: { opiu_block_path: path, article_name: "ФЗП", article_path: `${path} / ФЗП` },
    erp: { opiu_block_path: path, article_name: "ФЗП", article_path: `${path} / ФЗП` },
    accounting: { debit_account: debit, credit_account: "70", cfo, debit_department: department },
    action: { action_type: "MAP_ARTICLE", parameters: {} }, conditions: [], source: { source_type: "R005" },
  };
}

function candidate(overrides = {}) {
  const base = rule({ id: "CANDIDATE", ...overrides });
  return {
    candidate_id: "CAND-1", decision: "UNRESOLVED", impact_class: "RECONCILIATION_MAPPING",
    scope: base.scope, intalev: base.intalev, erp: base.erp, accounting: base.accounting, action: base.action,
    conditions: [], evidence: { source_engine: "R005" }, confidence: { level: "LOW", score: 0 },
    missing_fields: [], required_user_actions: [], user_status: "PENDING_REVIEW",
  };
}

const context = { run_id: "RUN-UK9", period: "2025", organization: { id: "UK9", path: "УК9" } };

test("same article with a different debit account is not linked", () => {
  const result = matchCandidates([candidate({ debit: "44" })], { rules: [rule({ id: "RULE-26" })] }, [], context)[0];
  assert.equal(result.decision, "NEW_RULE");
  assert.ok(!result.existing_rule_id);
});

test("same article and debit with a different disclosure path is not linked", () => {
  const result = matchCandidates([candidate({ path: SALES })], { rules: [rule({ id: "RULE-ADMIN" })] }, [], context)[0];
  assert.equal(result.decision, "NEW_RULE");
  assert.ok(!result.existing_rule_id);
});

test("same article debit and path with a different CFO or department is not linked", () => {
  for (const changed of [{ cfo: "Логистика" }, { department: "Склад" }]) {
    const result = matchCandidates([candidate(changed)], { rules: [rule({ id: "RULE-ADMIN" })] }, [], context)[0];
    assert.equal(result.decision, "NEW_RULE");
    assert.ok(!result.existing_rule_id);
  }
});

test("an identical UK9 signature remains an exact existing rule", () => {
  const existing = rule({ id: "RULE-ADMIN" });
  const result = matchCandidates([candidate()], { rules: [existing] }, [], context)[0];
  assert.equal(result.decision, "EXISTING_RULE");
  assert.equal(result.existing_rule_id, "RULE-ADMIN");
});

test("debit 99 closing rows do not identify an operational rule", () => {
  const result = matchCandidates([candidate({ debit: "99" })], { rules: [rule({ id: "RULE-ADMIN", debit: "99" })] }, [], context)[0];
  assert.equal(result.decision, "UNRESOLVED");
  assert.equal(result.user_status, "PENDING_REVIEW");
  assert.ok(!result.existing_rule_id);
});
