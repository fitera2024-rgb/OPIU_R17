import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { applyEmptyArticleBindingsToBlankArticleReporting } from "./empty_article_binding_application.mjs";
import {
  EMPTY_ARTICLE_BINDING_SETTINGS_SCHEMA,
  validateEmptyArticleBindingSettingsDocument,
} from "./empty_article_binding_settings.mjs";

const ORGANIZATION = Object.freeze({
  organization_id: "ORG-SYNTHETIC-ALPHA",
  organization_name: "Synthetic organization alpha",
  organization_hierarchy_path: ["Consolidation", "Synthetic alpha"],
});
const PERIOD = "2025-10";
const PARENT_PATH = Object.freeze(["Personnel costs", "<blank ancestor>"]);
const TARGET = Object.freeze({
  target_code: "TARGET-SYNTHETIC-001",
  target_node_identity: "ERP-NODE-SYNTHETIC-001",
  display_path: ["Operating costs", "Personnel expense target"],
  display_article: "Personnel expense target",
});
const CONFIGURED_LABELS = Object.freeze([
  "Base remuneration",
  "Paid leave",
  "Incentive payment",
  "Medical leave",
]);

function rules() {
  return validateEmptyArticleBindingSettingsDocument({
    schema: EMPTY_ARTICLE_BINDING_SETTINGS_SCHEMA,
    settings_id: "SETTINGS-SYNTHETIC-001",
    organization_scope: ORGANIZATION,
    authority: {
      type: "OWNER_APPROVED",
      scope: "CLASSIFICATION_BINDING_ONLY",
      approval_id: "APPROVAL-SYNTHETIC-001",
      approved_by: "Synthetic owner",
      approved_at: "2026-08-25T00:00:00.000Z",
      evidence_ref: "synthetic-owner-instruction",
    },
    safety: {
      mode: "REPORT_ONLY",
      report_only: true,
      classification_only: true,
      decision_type: "NO_POSTING",
      correction_authority: false,
      physical_posting_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      execution_allowed: false,
      live_1c_allowed: false,
      live_delete_allowed: false,
    },
    bindings: [{
      binding_id: "BINDING-SYNTHETIC-001",
      validity: { from: "2025-01", to: "2025-12" },
      source: {
        parent_path: PARENT_PATH,
        leaf_labels: CONFIGURED_LABELS,
        blank_ancestor_required: true,
      },
      target: TARGET,
      mode: "CLASSIFICATION_ONLY",
      decision_type: "NO_POSTING",
      authority_ref: "APPROVAL-SYNTHETIC-001",
    }],
  }, { ...ORGANIZATION, period: PERIOD }).rules;
}

function item(label, amount, overrides = {}) {
  const parentPath = PARENT_PATH.join(" / ");
  return {
    classification: "UNCLASSIFIED",
    article: "",
    amount,
    period: PERIOD,
    source_scope_role: "UNCLASSIFIED_DETAIL",
    classification_basis: "EMPTY_ARTICLE_ANCESTOR",
    source_parent_path: parentPath,
    source_path: parentPath + " / " + label,
    blank_branch_source_path: parentPath,
    source_label: label,
    source_is_leaf: true,
    target_code: "",
    erp_article: "",
    erp_amount: null,
    correction_allowed: false,
    financial_posting_rows: 0,
    ...overrides,
  };
}

function reportingFixture(overrides = {}) {
  return {
    rows: [{
      code: "SYNTHETIC-ROOT",
      intalev: { amount: 1000 },
      erp: { amount: 900 },
      delta: 100,
      effective_delta: 0,
      residual_atoms: [{ amount: 100, consumed: true }],
    }],
    bindings: [{ existing: true, amount: 100 }],
    display_scopes: [{
      source_scope_id: "SCOPE-SYNTHETIC-001",
      owner_code: "SYNTHETIC-ROOT",
      blank_amount: 1000,
      financial_posting_rows: 0,
      items: [
        item("Base remuneration", 700),
        item("Paid leave", 200),
        item("Withheld tax", 100),
      ],
    }],
    financial_posting_authority: 0,
    financial_posting_rows: 0,
    correction_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    ...overrides,
  };
}

test("exact source leaves receive display-only classification annotations", () => {
  const reporting = reportingFixture();
  const financialRowsBefore = structuredClone(reporting.rows);
  const existingBindingsBefore = structuredClone(reporting.bindings);
  const result = applyEmptyArticleBindingsToBlankArticleReporting({
    organization: ORGANIZATION,
    period: PERIOD,
    reporting,
    bindingRules: rules(),
  });

  assert.equal(result.reporting.rows, reporting.rows);
  assert.deepEqual(result.reporting.rows, financialRowsBefore);
  assert.equal(result.reporting.bindings, reporting.bindings);
  assert.deepEqual(result.reporting.bindings, existingBindingsBefore);
  assert.equal(result.reporting.financial_posting_rows, 0);
  assert.equal(result.reporting.display_scopes[0].blank_amount, 1000);

  for (const mapped of result.reporting.display_scopes[0].items.slice(0, 2)) {
    assert.equal(mapped.target_code, TARGET.target_code);
    assert.equal(mapped.target_node_identity, TARGET.target_node_identity);
    assert.equal(mapped.erp_article, TARGET.display_article);
    assert.equal(mapped.erp_amount, null);
    assert.equal(mapped.binding_classification, "SOURCE_CLASSIFICATION_GAP");
    assert.equal(mapped.binding_decision_type, "UPDATE_MAPPING");
    assert.equal(mapped.binding_posting_semantics, "NO_POSTING");
    assert.equal(mapped.binding_status, "OWNER_APPROVED_BINDING");
    assert.equal(mapped.residual_consumption, 0);
    assert.equal(mapped.correction_allowed, false);
    assert.equal(mapped.financial_posting_rows, 0);
    assert.equal(mapped.article, "");
  }

  const unconfigured = result.reporting.display_scopes[0].items[2];
  assert.equal(unconfigured.source_label, "Withheld tax");
  assert.equal(unconfigured.target_code, "");
  assert.equal(unconfigured.erp_article, "");
  assert.equal(unconfigured.binding_status, "UNRESOLVED_REVIEW_ONLY");
  assert.equal(unconfigured.residual_consumption, 0);

  assert.equal(result.audit.status, "ACTIVE_WITH_NOT_PRESENT_THIS_PERIOD");
  assert.equal(result.audit.configured_leaf_count, 4);
  assert.equal(result.audit.matched_item_count, 2);
  assert.equal(result.audit.mapped_intalev_amount, 900);
  assert.equal(result.audit.unresolved_item_count, 1);
  assert.equal(result.audit.not_present.length, 2);
  assert.ok(result.audit.not_present.every((entry) => entry.status === "NOT_PRESENT_THIS_PERIOD"));
  assert.equal(result.audit.financial_rows, 0);
  assert.equal(result.audit.posting_rows, 0);
  assert.equal(result.audit.residual_consumption, 0);
  assert.equal(result.audit.erp_amount_distributed, 0);
  assert.equal(result.audit.intergroup_effects_consumed, 0);
  assert.equal(result.audit.correction_rows, 0);
});

test("normalized case and whitespace match, but a different parent path does not", () => {
  const reporting = reportingFixture({
    display_scopes: [{
      items: [
        item("  BASE   REMUNERATION ", 700, {
          source_path: " Personnel   costs / <blank ancestor> / BASE REMUNERATION ",
        }),
        item("Paid leave", 200, {
          source_parent_path: "Different parent / <blank ancestor>",
          source_path: "Different parent / <blank ancestor> / Paid leave",
          blank_branch_source_path: "Different parent / <blank ancestor>",
        }),
      ],
    }],
  });
  const result = applyEmptyArticleBindingsToBlankArticleReporting({
    organization: ORGANIZATION,
    period: PERIOD,
    reporting,
    bindingRules: rules(),
  });
  assert.equal(result.reporting.display_scopes[0].items[0].binding_status, "OWNER_APPROVED_BINDING");
  assert.equal(result.reporting.display_scopes[0].items[1].target_code, "");
  assert.equal(result.audit.matched_item_count, 1);
  assert.equal(result.audit.not_present.length, 3);
});

test("configured leaves absent in a month are audit-only NOT_PRESENT_THIS_PERIOD", () => {
  const reporting = reportingFixture({ display_scopes: [] });
  const result = applyEmptyArticleBindingsToBlankArticleReporting({
    organization: ORGANIZATION,
    period: PERIOD,
    reporting,
    bindingRules: rules(),
  });
  assert.equal(result.audit.status, "NO_CONFIGURED_LEAF_PRESENT_THIS_PERIOD");
  assert.equal(result.audit.not_present.length, CONFIGURED_LABELS.length);
  assert.equal(result.reporting.rows, reporting.rows);
  assert.equal(result.audit.posting_rows, 0);
});

test("a configured source item without proven blank ancestry fails closed", () => {
  for (const proofLoss of [
    { classification_basis: "EMPTY_ARTICLE" },
    { blank_branch_source_path: "" },
    { article: "Physical article is not blank" },
    { source_is_leaf: false },
  ]) {
    const reporting = reportingFixture({
      display_scopes: [{ items: [item("Base remuneration", 700, proofLoss)] }],
    });
    assert.throws(
      () => applyEmptyArticleBindingsToBlankArticleReporting({
        organization: ORGANIZATION,
        period: PERIOD,
        reporting,
        bindingRules: rules(),
      }),
      /BLANK_ANCESTOR_NOT_PROVEN/,
    );
  }
});

test("scope mismatch, preexisting target conflict and malformed target fail closed", () => {
  assert.throws(
    () => applyEmptyArticleBindingsToBlankArticleReporting({
      organization: { ...ORGANIZATION, organization_id: "ORG-SYNTHETIC-BETA" },
      period: PERIOD,
      reporting: reportingFixture(),
      bindingRules: rules(),
    }),
    /RULE_ORGANIZATION_SCOPE_MISMATCH/,
  );
  assert.throws(
    () => applyEmptyArticleBindingsToBlankArticleReporting({
      organization: ORGANIZATION,
      period: PERIOD,
      reporting: reportingFixture({
        display_scopes: [{ items: [item("Base remuneration", 700, {
          target_code: "CONFLICTING-TARGET",
        })] }],
      }),
      bindingRules: rules(),
    }),
    /PREEXISTING_TARGET_CONFLICT/,
  );
  const malformed = structuredClone(rules());
  malformed[0].target.target_node_identity = "";
  assert.throws(
    () => applyEmptyArticleBindingsToBlankArticleReporting({
      organization: ORGANIZATION,
      period: PERIOD,
      reporting: reportingFixture(),
      bindingRules: malformed,
    }),
    /TARGET_NODE_IDENTITY_INVALID/,
  );
});

test("duplicate source claim and target identity ambiguity fail closed", () => {
  const duplicate = structuredClone(rules());
  const second = structuredClone(duplicate[0]);
  second.binding_id = "BINDING-SYNTHETIC-002";
  duplicate.push(second);
  assert.throws(
    () => applyEmptyArticleBindingsToBlankArticleReporting({
      organization: ORGANIZATION,
      period: PERIOD,
      reporting: reportingFixture(),
      bindingRules: duplicate,
    }),
    /AMBIGUOUS_SOURCE_CLAIM/,
  );

  const conflictingTarget = structuredClone(rules());
  const secondTarget = structuredClone(conflictingTarget[0]);
  secondTarget.binding_id = "BINDING-SYNTHETIC-003";
  secondTarget.source.parent_path = ["Other costs", "<blank ancestor>"];
  secondTarget.source.leaf_labels = ["Other synthetic leaf"];
  secondTarget.source.normalized_leaf_labels = ["other synthetic leaf"];
  secondTarget.target.target_node_identity = "ERP-NODE-SYNTHETIC-CONFLICT";
  secondTarget.target.display_path = ["Operating costs", "Conflicting target"];
  secondTarget.target.display_article = "Conflicting target";
  conflictingTarget.push(secondTarget);
  assert.throws(
    () => applyEmptyArticleBindingsToBlankArticleReporting({
      organization: ORGANIZATION,
      period: PERIOD,
      reporting: reportingFixture(),
      bindingRules: conflictingTarget,
    }),
    /TARGET_CODE_IDENTITY_AMBIGUOUS/,
  );
});

test("production application module contains no business fixtures", async () => {
  const source = await fs.readFile(new URL("./empty_article_binding_application.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    "9 Управляющая компания",
    "244745",
    "R033",
    "R023",
    "ФЗП",
    "Заработная плата",
    "Отпускные",
    "Премия",
    "Больничный лист",
    "НДФЛ",
  ]) {
    assert.equal(source.includes(forbidden), false, "production fixture leaked: " + forbidden);
  }
  assert.equal(/\bR\d{3}\b/.test(source), false);
});
