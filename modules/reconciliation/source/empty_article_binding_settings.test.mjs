import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EMPTY_ARTICLE_BINDING_SETTINGS_SCHEMA,
  loadEmptyArticleBindingSettingsDocument,
  normalizeEmptyArticleBindingPath,
  normalizeEmptyArticleBindingValue,
  validateEmptyArticleBindingSettingsDocument,
} from "./empty_article_binding_settings.mjs";

const ORGANIZATION_SCOPE = Object.freeze({
  organization_id: "ORG-SYNTHETIC-ALPHA",
  organization_name: "Synthetic organization alpha",
  organization_hierarchy_path: ["Consolidation", "Synthetic alpha"],
});
const PERIOD = "2025-10";

function runScope(overrides = {}) {
  return { ...ORGANIZATION_SCOPE, period: PERIOD, ...overrides };
}

function authority(overrides = {}) {
  return {
    type: "OWNER_APPROVED",
    scope: "CLASSIFICATION_BINDING_ONLY",
    approval_id: "APPROVAL-SYNTHETIC-001",
    approved_by: "Synthetic owner",
    approved_at: "2026-08-25T00:00:00.000Z",
    evidence_ref: "synthetic-owner-instruction",
    ...overrides,
  };
}

function safety(overrides = {}) {
  return {
    mode: "REPORT_ONLY",
    classification_only: true,
    decision_type: "NO_POSTING",
    correction_authority: false,
    physical_posting_authority: false,
    financial_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    execution_allowed: false,
    live_1c_allowed: false,
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    binding_id: "BINDING-SYNTHETIC-001",
    validity: { from: "2025-01", to: "2025-12" },
    source: {
      parent_path: ["Personnel costs", "<blank ancestor>"],
      leaf_labels: ["Base remuneration", "Paid leave", "Incentive payment", "Medical leave"],
      blank_ancestor_required: true,
    },
    target: {
      target_code: "TARGET-SYNTHETIC-001",
      target_node_identity: "ERP-NODE-SYNTHETIC-001",
      display_path: ["Operating costs", "Personnel expense target"],
      display_article: "Personnel expense target",
    },
    mode: "CLASSIFICATION_ONLY",
    decision_type: "NO_POSTING",
    authority_ref: "APPROVAL-SYNTHETIC-001",
    ...overrides,
  };
}

function document(overrides = {}) {
  return {
    schema: EMPTY_ARTICLE_BINDING_SETTINGS_SCHEMA,
    settings_id: "SETTINGS-SYNTHETIC-001",
    organization_scope: ORGANIZATION_SCOPE,
    authority: authority(),
    safety: safety(),
    bindings: [binding()],
    ...overrides,
  };
}

test("loader binds exact organization identity and inclusive validity range", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-empty-binding-"));
  try {
    const filePath = path.join(directory, "settings.json");
    await fs.writeFile(filePath, JSON.stringify(document()), "utf8");
    const result = await loadEmptyArticleBindingSettingsDocument(filePath, runScope());

    assert.equal(result.audit.status, "ACTIVE_EXACT_ORGANIZATION_PERIOD");
    assert.equal(result.audit.organization_id, ORGANIZATION_SCOPE.organization_id);
    assert.equal(result.audit.organization_name, ORGANIZATION_SCOPE.organization_name);
    assert.deepEqual(
      result.audit.organization_hierarchy_path,
      ORGANIZATION_SCOPE.organization_hierarchy_path,
    );
    assert.equal(result.audit.rule_count, 1);
    assert.match(result.audit.input_sha256, /^[A-F0-9]{64}$/);
    assert.equal(result.audit.decision_type, "NO_POSTING");
    assert.equal(result.audit.correction_authority, false);
    assert.equal(result.audit.physical_posting_authority, false);
    assert.equal(result.audit.financial_rows, 0);
    assert.equal(result.audit.posting_rows, 0);

    const rule = result.rules[0];
    assert.equal(rule.source.blank_ancestor_required, true);
    assert.equal(rule.source.normalized_leaf_labels.length, 4);
    assert.equal(rule.target.target_code, "TARGET-SYNTHETIC-001");
    assert.equal(rule.target.target_node_identity, "ERP-NODE-SYNTHETIC-001");
    assert.equal(rule.target.normalized_display_article, "personnel expense target");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("organization id, name and hierarchy path are all exact run scope", () => {
  for (const mismatch of [
    { organization_id: "ORG-SYNTHETIC-BETA" },
    { organization_name: "Synthetic organization beta" },
    { organization_hierarchy_path: ["Consolidation", "Synthetic beta"] },
  ]) {
    assert.throws(
      () => validateEmptyArticleBindingSettingsDocument(document(), runScope(mismatch)),
      /RUN_ORGANIZATION_SCOPE_MISMATCH/,
    );
  }
});

test("normalization is deterministic and supports one concrete validity period", () => {
  assert.equal(normalizeEmptyArticleBindingValue("  ПРИМЕР\u00A0Ё  "), "пример е");
  assert.equal(
    normalizeEmptyArticleBindingPath(["  Parent  ", "Blank\u00A0ancestor"]),
    "parent\u001Fblank ancestor",
  );
  const result = validateEmptyArticleBindingSettingsDocument(document({
    organization_scope: {
      ...ORGANIZATION_SCOPE,
      organization_hierarchy_path: [" Consolidation ", "Synthetic   alpha"],
    },
    bindings: [binding({
      validity: { period: PERIOD },
      source: {
        parent_path: ["  Personnel   costs ", "<blank ancestor>"],
        leaf_labels: ["Base remuneration", "Paid leave"],
        blank_ancestor_required: true,
      },
    })],
  }), runScope());
  assert.equal(result.rules[0].source.normalized_parent_path, "personnel costs\u001F<blank ancestor>");
  assert.deepEqual(result.rules[0].validity, { from: PERIOD, to: PERIOD });
});

test("missing settings and an out-of-range period grant no classification authority", async () => {
  const missing = await loadEmptyArticleBindingSettingsDocument("", runScope());
  assert.equal(missing.audit.status, "MISSING_NO_CLASSIFICATION_BINDING");
  assert.equal(missing.rules.length, 0);
  assert.equal(missing.audit.posting_rows, 0);

  const outOfRange = validateEmptyArticleBindingSettingsDocument(
    document(),
    runScope({ period: "2026-01" }),
  );
  assert.equal(outOfRange.audit.status, "NO_ACTIVE_RULES_EXACT_ORGANIZATION_PERIOD");
  assert.equal(outOfRange.rules.length, 0);
});

test("invalid authority, safety or financial action fails closed", () => {
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      authority: authority({ type: "SELF_ASSERTED" }),
    }), runScope()),
    /AUTHORITY_TYPE_INVALID/,
  );
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      safety: safety({ posting_rows: 1 }),
    }), runScope()),
    /SAFETY_OPEN_OR_INVALID/,
  );
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding({ mode: "FINANCIAL_REPOST" })],
    }), runScope()),
    /BINDING_FINANCIAL_ACTION_FORBIDDEN/,
  );
});

test("overlapping sources and conflicting target identities fail closed", () => {
  const overlapping = binding({
    binding_id: "BINDING-SYNTHETIC-002",
    source: {
      parent_path: ["Personnel costs", "<blank ancestor>"],
      leaf_labels: ["Paid leave", "Additional synthetic leaf"],
      blank_ancestor_required: true,
    },
  });
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding(), overlapping],
    }), runScope()),
    /AMBIGUOUS_OVERLAPPING_SOURCE/,
  );

  const conflictingTarget = binding({
    binding_id: "BINDING-SYNTHETIC-003",
    source: {
      parent_path: ["Other costs", "<blank ancestor>"],
      leaf_labels: ["Other synthetic leaf"],
      blank_ancestor_required: true,
    },
    target: {
      target_code: "TARGET-SYNTHETIC-001",
      target_node_identity: "ERP-NODE-SYNTHETIC-CONFLICT",
      display_path: ["Operating costs", "Conflicting target"],
      display_article: "Conflicting target",
    },
  });
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding(), conflictingTarget],
    }), runScope()),
    /TARGET_CODE_IDENTITY_AMBIGUOUS/,
  );
});

test("blank ancestor and one complete ERP target identity are mandatory", () => {
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding({
        source: {
          parent_path: ["Personnel costs", "<blank ancestor>"],
          leaf_labels: ["Base remuneration"],
          blank_ancestor_required: false,
        },
      })],
    }), runScope()),
    /BLANK_ANCESTOR_REQUIRED/,
  );
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding({
        target: {
          target_code: "TARGET-SYNTHETIC-001",
          target_node_identity: "ERP-NODE-SYNTHETIC-001",
          display_path: ["Operating costs", "Personnel expense target"],
          display_article: "Personnel expense target",
          alternate_article: "Forbidden alternative",
        },
      })],
    }), runScope()),
    /TARGET_NOT_EXACTLY_ONE/,
  );
  assert.throws(
    () => validateEmptyArticleBindingSettingsDocument(document({
      bindings: [binding({
        target: {
          target_code: "TARGET-SYNTHETIC-001",
          target_node_identity: "ERP-NODE-SYNTHETIC-001",
          display_path: ["Operating costs", "Different final path node"],
          display_article: "Personnel expense target",
        },
      })],
    }), runScope()),
    /TARGET_DISPLAY_PATH_ARTICLE_MISMATCH/,
  );
});

test("production settings module has no business fixtures", async () => {
  const source = await fs.readFile(new URL("./empty_article_binding_settings.mjs", import.meta.url), "utf8");
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
  assert.equal(/\bamounts?\b/i.test(source), false);
});
