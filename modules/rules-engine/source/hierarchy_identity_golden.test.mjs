import assert from "node:assert/strict";
import test from "node:test";
import { hierarchyIdentityPath } from "./adapters/r005_identity_guard.mjs";
import { matchCandidates } from "./matcher.mjs";

function ruleLike({ id = "RULE-1", block, article = "ФЗП", debit = "26", cfo = "", department = "" } = {}) {
  return {
    rule_id: id,
    revision_id: `${id}-REV-1`,
    title: id,
    description: "",
    rule_type: "MAP_ARTICLE",
    origin: "MANUAL",
    status: "ACTIVE",
    is_current: true,
    enabled: true,
    valid_from_year: 2025,
    valid_to_year: null,
    scope: {
      scope_type: "ORG_ONLY",
      organization_id: "ORG-1",
      organization_code: "ORG-1",
      organization_name: "Организация",
      organization_path: "Организация",
      cfo_id: "",
      cfo_name: "",
      cfo_path: "",
      include_descendants: false,
      mapping_status: "matched",
    },
    intalev: {
      opiu_block_code: "",
      opiu_block_name: block,
      opiu_block_path: block,
      article_code: "",
      article_name: article,
      article_path: `${block} / ${article}`,
      catalog_uid: "INT-1",
      parent_uid: "INT-PARENT",
    },
    erp: {
      opiu_block_code: "",
      opiu_block_name: block,
      opiu_block_path: block,
      article_code: "",
      article_name: article,
      article_path: `${block} / ${article}`,
      catalog_uid: "ERP-1",
      parent_uid: "ERP-PARENT",
    },
    accounting: {
      debit_account: debit,
      debit_account_name: "",
      credit_account: "70.1",
      credit_account_name: "",
      debit_analytics: [],
      credit_analytics: [],
      debit_department: department,
      credit_department: "",
      cfo,
    },
    action: { action_type: "MAP_ARTICLE", parameters: {} },
    conditions: [],
    source: { source_type: "MANUAL" },
  };
}

function candidateFrom(rule) {
  return {
    candidate_id: "CAND-1",
    existing_rule_id: null,
    existing_revision_id: null,
    decision: "UNRESOLVED",
    impact_class: "RECONCILIATION_MAPPING",
    scope: structuredClone(rule.scope),
    intalev: structuredClone(rule.intalev),
    erp: structuredClone(rule.erp),
    accounting: structuredClone(rule.accounting),
    action: structuredClone(rule.action),
    evidence: { source_engine: "R005" },
    confidence: { level: "LOW", score: 0, reasons: [] },
    missing_fields: [],
    required_user_actions: [],
    user_status: "PENDING_REVIEW",
  };
}

const context = {
  period: "2025",
  run_id: "RUN-GOLDEN",
  organization: { id: "ORG-1", name: "Организация", path: "Организация" },
};

test("hierarchy identity path keeps disclosure and WP group", () => {
  const path = hierarchyIdentityPath("Административные расходы", {
    disclosure_group: "Административные расходы",
    wp_group: "WP-ADMIN",
  });
  assert.match(path, /DISCLOSURE::Административные расходы/);
  assert.match(path, /WP::WP-ADMIN/);
});

test("same article name in different disclosure groups never matches existing rule", () => {
  const existing = ruleLike({ block: "Административные расходы / DISCLOSURE::Административные расходы / WP::WP-ADMIN" });
  const candidate = candidateFrom(ruleLike({ block: "Коммерческие расходы / DISCLOSURE::Коммерческие расходы / WP::WP-COM" }));
  const [result] = matchCandidates([candidate], { rules: [existing] }, [], context);
  assert.notEqual(result.decision, "EXISTING_RULE");
  assert.notEqual(result.decision, "APPLICATION_ONLY");
  assert.equal(result.existing_rule_id, null);
});

test("same article name and disclosure but different WP group never matches", () => {
  const existing = ruleLike({ block: "Расходы / DISCLOSURE::ФОТ / WP::WP-ADMIN" });
  const candidate = candidateFrom(ruleLike({ block: "Расходы / DISCLOSURE::ФОТ / WP::WP-COM" }));
  const [result] = matchCandidates([candidate], { rules: [existing] }, [], context);
  assert.notEqual(result.decision, "EXISTING_RULE");
  assert.notEqual(result.decision, "APPLICATION_ONLY");
  assert.equal(result.existing_rule_id, null);
});

test("same full identity remains deterministic", () => {
  const existing = ruleLike({ block: "Расходы / DISCLOSURE::ФОТ / WP::WP-ADMIN" });
  const candidate = candidateFrom(existing);
  const [result] = matchCandidates([candidate], { rules: [existing] }, [], context);
  assert.equal(result.existing_rule_id, existing.rule_id);
  assert.ok(["EXISTING_RULE", "APPLICATION_ONLY"].includes(result.decision));
});

test("Dr99 candidate fails closed", () => {
  const existing = ruleLike({ block: "Расходы / DISCLOSURE::ФОТ / WP::WP-ADMIN", debit: "99" });
  const candidate = candidateFrom(existing);
  const [result] = matchCandidates([candidate], { rules: [existing] }, [], context);
  assert.equal(result.decision, "UNRESOLVED");
  assert.equal(result.user_status, "PENDING_REVIEW");
  assert.equal(result.existing_rule_id, null);
});
