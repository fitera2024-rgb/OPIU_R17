import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregate2025MonthlyResults,
  buildAnalyticalContext,
  deriveProofStatus,
  normalizeCorrectionFamily,
} from "./r001_analytical_policy.mjs";

const ORG = "9 Управляющая компания";
const PERIOD = "2025-01";

function correction(overrides = {}) {
  return {
    organization: ORG,
    period: PERIOD,
    decision_type: "STORNO_REPOST",
    proof_status: "PROVEN",
    analytical_effect: 10,
    target_article: "Административные расходы",
    target_side: "DEBIT:26",
    reason: "Историческая классификация требует корректировки",
    pair_id: "PAIR-001",
    evidence_references: ["ERP.xlsx/Лист1/42"],
    target_dt: "26",
    target_kt: "60",
    target_analytics_dt1: "Административные расходы",
    target_analytics_kt1: "Контрагент",
    target_department_dt: "АУП",
    target_department_kt: "АУП",
    ...overrides,
  };
}

test("legacy correction families normalize without changing rules/config", () => {
  assert.equal(normalizeCorrectionFamily("STORNO_REPOST", "PROVEN"), "STORNO_REPOST");
  assert.equal(normalizeCorrectionFamily("ADD_ONE_SIDE", "PROVEN"), "ONE_SIDED");
  assert.equal(normalizeCorrectionFamily("ADD_ONE_SIDE", "INFERRED"), "ONE_SIDED");
  assert.equal(normalizeCorrectionFamily("ONE_SIDED", "UNPROVEN"), "ONE_SIDED");
  assert.equal(normalizeCorrectionFamily("DELETE_OPERATION", "PROVEN"), "DELETE_DRAFT");
  assert.equal(normalizeCorrectionFamily("DELETE_POSTING", "PROVEN"), "DELETE_DRAFT");
  assert.equal(normalizeCorrectionFamily("NO_POSTING", "PROVEN"), "NO_CORRECTION_NEEDED");
  assert.equal(normalizeCorrectionFamily("DELETE_POSTING", "UNPROVEN"), "DELETE_DRAFT");
  assert.equal(normalizeCorrectionFamily("DISPUTED_CORRECTION", "PROVEN"), "DISPUTED_CORRECTION");
  assert.equal(normalizeCorrectionFamily("UNSUPPORTED", "UNPROVEN"), "");
});

test("engine retains proven STORNO/REPOST generation and hard live gates", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction()],
  });

  assert.equal(result.analytical_draft_corrections.length, 1);
  const draft = result.analytical_draft_corrections[0];
  assert.equal(draft.correction_family, "STORNO_REPOST");
  assert.equal(draft.reason, "Историческая классификация требует корректировки");
  assert.deepEqual(draft.evidence_references, ["ERP.xlsx/Лист1/42"]);
  assert.equal(draft.executable, false);
  assert.equal(result.counts.live_executable_rows, 0);
  assert.deepEqual(result.safety, {
    execution_allowed: false,
    live_posting_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_delete_allowed: false,
    live_1c_allowed: false,
  });
});

test("proven STORNO_REPOST remains analytical and traceable", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction()],
  });
  assert.equal(result.analytical_draft_corrections[0].correction_family, "STORNO_REPOST");
  assert.deepEqual(result.analytical_draft_corrections[0].evidence_references, ["ERP.xlsx/Лист1/42"]);
  assert.equal(result.scenario.ERP_AFTER_CORRECTIONS, 100);
  assert.equal(result.scenario.RESIDUAL_DELTA, 0);
});

test("legacy one-sided and deletion records preserve canonical draft-only families", () => {
  const oneSide = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ decision_type: "ADD_ONE_SIDE" })],
  });
  assert.equal(oneSide.analytical_draft_corrections[0].correction_family, "ONE_SIDED");
  assert.equal(oneSide.analytical_draft_corrections[0].proof_status, "PROVEN");
  const deletion = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ decision_type: "DELETE_POSTING" })],
  });
  assert.equal(deletion.analytical_draft_corrections[0].correction_family, "DELETE_DRAFT");
  assert.equal(deletion.analytical_draft_corrections[0].live_delete_allowed, false);
  assert.equal(deletion.counts.live_executable_rows, 0);
});

test("NO_POSTING and UPDATE types never become postings or source changes", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 100,
    intalev_target: 100,
    corrections: [
      correction({ decision_type: "NO_POSTING", analytical_effect: 0, pair_id: "NO-1" }),
      correction({ decision_type: "UPDATE_MAPPING", pair_id: "MAP-1" }),
      correction({ decision_type: "UPDATE_FORMULA", pair_id: "FORMULA-1" }),
    ],
  });
  assert.equal(result.no_correction_needed[0].correction_family, "NO_CORRECTION_NEEDED");
  assert.equal(result.historical_non_posting_decisions.length, 2);
  for (const item of result.historical_non_posting_decisions) {
    assert.equal(item.posting_created, false);
    assert.equal(item.mapping_changed, false);
    assert.equal(item.formulas_changed, false);
  }
  assert.equal(result.analytical_draft_corrections.length, 0);
});

test("explicit DISPUTED_CORRECTION remains disputed and review-required", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ decision_type: "DISPUTED_CORRECTION", proof_status: "UNPROVEN", target_kt: "", target_analytics_kt1: "", target_department_kt: "" })],
  });
  const draft = result.analytical_draft_corrections[0];
  assert.equal(draft.correction_family, "DISPUTED_CORRECTION");
  assert.equal(draft.analytical_effect, 10);
  assert.equal(draft.analytics.target_account_kt, "UNKNOWN");
  assert.equal(draft.analytics_review_state, "NEEDS_REVIEW");
  assert.equal(result.review_required.length, 1);
  assert.equal(result.scenario.target_closed, true);
  assert.equal(draft.executable, false);
});

test("INFERRED participates analytically while preserving missing-proof trace", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ proof_status: "INFERRED", evidence_references: [] })],
  });
  assert.equal(result.analytical_draft_corrections[0].proof_status, "INFERRED");
  assert.equal(result.analytical_draft_corrections[0].proof_status_trace, "EXPLICIT_INFERRED");
  assert.deepEqual(result.analytical_draft_corrections[0].evidence_references, []);
  assert.equal(result.scenario.ANALYTICAL_DRAFT_CORRECTIONS, 10);
  assert.equal(result.review_required.length, 1);
});

test("QA defect reproduction keeps inferred ADD_ONE_SIDE canonical and non-executable", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({
      decision_type: "ADD_ONE_SIDE",
      proof_status: "INFERRED",
      pair_id: "PAIR-QA-ONE_SIDE-INFERRED",
    })],
  });
  const draft = result.analytical_draft_corrections[0];
  assert.equal(draft.legacy_decision_type, "ADD_ONE_SIDE");
  assert.equal(draft.proof_status, "INFERRED");
  assert.equal(draft.correction_family, "ONE_SIDED");
  assert.equal(draft.review_state, "NEEDS_REVIEW");
  assert.equal(draft.executable, false);
  assert.equal(result.review_required.length, 1);
  assert.equal(result.scenario.ERP_AFTER_CORRECTIONS, 100);
  assert.equal(result.counts.live_executable_rows, 0);
});

test("unproven ADD_ONE_SIDE keeps family and proof as independent dimensions", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ decision_type: "ADD_ONE_SIDE", proof_status: "UNPROVEN" })],
  });
  const draft = result.analytical_draft_corrections[0];
  assert.equal(draft.correction_family, "ONE_SIDED");
  assert.equal(draft.proof_status, "UNPROVEN");
  assert.equal(draft.review_state, "NEEDS_REVIEW");
  assert.equal(draft.executable, false);
  assert.equal(result.review_required.length, 1);
  assert.equal(result.scenario.ERP_AFTER_CORRECTIONS, 100);
});

test("missing minimum target attributes leave an explicit unresolved residual", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({ target_article: "", target_analytics_dt1: "", target_analytics_kt1: "", group: "" })],
  });
  assert.equal(result.analytical_draft_corrections.length, 0);
  assert.equal(result.blockers.some((item) => item.blocker_code === "MISSING_MINIMUM_TARGET_ATTRIBUTES"), true);
  assert.equal(result.scenario.RESIDUAL_DELTA, 10);
  assert.equal(result.scenario.UNRESOLVED_BLOCKED_EFFECT, 10);
});

test("unsigned amount is not guessed and remains blocked", () => {
  const item = correction({ analytical_effect: undefined, correction_amount: 10, effect_direction: "" });
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [item],
  });
  assert.equal(result.analytical_draft_corrections.length, 0);
  assert.equal(result.blockers[0].details.includes("UNSIGNED_AMOUNT_REQUIRES_ANALYTICAL_DIRECTION"), true);
});

test("USER_ACCEPTED is never auto-generated and explicit acceptance preserves history", () => {
  const rejected = deriveProofStatus({ proof_status: "USER_ACCEPTED" });
  assert.equal(rejected.proof_status, "UNPROVEN");
  const explicit = deriveProofStatus({ proof_status: "UNPROVEN", user_accepted: true });
  assert.equal(explicit.proof_status, "USER_ACCEPTED");
  assert.equal(explicit.original_proof_status, "UNPROVEN");
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({
      decision_type: "ADD_ONE_SIDE",
      proof_status: "USER_ACCEPTED",
      original_proof_status: "INFERRED",
      user_accepted: true,
      review_state: "ACCEPTED",
    })],
  });
  const draft = result.analytical_draft_corrections[0];
  assert.equal(draft.proof_status, "USER_ACCEPTED");
  assert.equal(draft.original_proof_status, "INFERRED");
  assert.deepEqual(draft.proof_history, ["INFERRED", "USER_ACCEPTED"]);
  assert.equal(draft.correction_family, "ONE_SIDED");
  assert.equal(result.review_required.length, 0);
  assert.equal(draft.execution_allowed, false);
});

test("explicit accepted row may remain pending review", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({
      proof_status: "USER_ACCEPTED",
      original_proof_status: "UNPROVEN",
      user_accepted: true,
      review_state: "NEEDS_REVIEW",
    })],
  });
  assert.equal(result.review_required.length, 1);
  assert.equal(result.review_required[0].original_proof_status, "UNPROVEN");
});

test("mixed proof statuses close mathematically while proof reviews remain", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 70,
    intalev_target: 100,
    corrections: [
      correction({ pair_id: "P-1", analytical_effect: 10, proof_status: "PROVEN" }),
      correction({ pair_id: "P-2", analytical_effect: 10, proof_status: "INFERRED" }),
      correction({ pair_id: "P-3", analytical_effect: 10, proof_status: "UNPROVEN" }),
    ],
  });
  assert.equal(result.scenario.identity_holds, true);
  assert.equal(result.scenario.ERP_CURRENT + result.scenario.ANALYTICAL_DRAFT_CORRECTIONS, result.scenario.ERP_AFTER_CORRECTIONS);
  assert.equal(result.scenario.ERP_AFTER_CORRECTIONS, result.scenario.INTALEV_TARGET);
  assert.equal(result.scenario.RESIDUAL_DELTA, 0);
  assert.equal(result.review_required.length, 2);
  assert.equal(result.proof_status_counts.PROVEN, 1);
  assert.equal(result.proof_status_counts.INFERRED, 1);
  assert.equal(result.proof_status_counts.UNPROVEN, 1);
});

test("organization and month contexts never transfer corrections", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [
      correction({ organization: "1 Хабаровск", pair_id: "OTHER-ORG" }),
      correction({ period: "2025-02", pair_id: "OTHER-MONTH" }),
    ],
  });
  assert.equal(result.analytical_draft_corrections.length, 0);
  assert.equal(result.ignored_context_rows.length, 2);
  assert.equal(result.scenario.RESIDUAL_DELTA, 10);
});

test("duplicate stable drafts are not applied twice", () => {
  const duplicate = correction({ pair_id: "SAME", draft_id: "DRAFT-SAME" });
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [duplicate, { ...duplicate }],
  });
  assert.equal(result.analytical_draft_corrections.length, 1);
  assert.equal(result.scenario.ANALYTICAL_DRAFT_CORRECTIONS, 10);
  assert.equal(result.blockers.some((item) => item.blocker_code === "DUPLICATE_ANALYTICAL_DRAFT"), true);
});

test("all live safety gates remain closed even when analytical target closes", () => {
  const result = buildAnalyticalContext({
    organization: ORG,
    period: PERIOD,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction()],
  });
  assert.deepEqual(result.safety, {
    execution_allowed: false,
    live_posting_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_delete_allowed: false,
    live_1c_allowed: false,
  });
  assert.equal(result.counts.live_executable_rows, 0);
});

function reconciledMonth(month, amount = 10) {
  return buildAnalyticalContext({
    organization: ORG,
    period: `2025-${String(month).padStart(2, "0")}`,
    erp_current: 90,
    intalev_target: 100,
    corrections: [correction({
      period: `2025-${String(month).padStart(2, "0")}`,
      pair_id: `PAIR-${month}`,
      analytical_effect: amount,
    })],
  });
}

test("twelve distinct reconciled 2025 months aggregate exactly without annual correction", () => {
  const annual = aggregate2025MonthlyResults(
    Array.from({ length: 12 }, (_, index) => reconciledMonth(index + 1)),
    { organization: ORG },
  );
  assert.equal(annual.ready, true);
  assert.equal(annual.source_months.length, 12);
  assert.equal(annual.annual_summary.ERP_CURRENT, 1080);
  assert.equal(annual.annual_summary.ANALYTICAL_DRAFT_CORRECTIONS, 120);
  assert.equal(annual.annual_summary.ERP_AFTER_CORRECTIONS, 1200);
  assert.equal(annual.annual_summary.INTALEV_TARGET, 1200);
  assert.equal(annual.annual_summary.RESIDUAL_DELTA, 0);
  assert.deepEqual(annual.synthetic_annual_corrections, []);
});

test("fewer than twelve months produce a blocker and no synthetic annual correction", () => {
  const annual = aggregate2025MonthlyResults(
    Array.from({ length: 11 }, (_, index) => reconciledMonth(index + 1)),
    { organization: ORG },
  );
  assert.equal(annual.ready, false);
  assert.equal(annual.annual_summary, null);
  assert.deepEqual(annual.synthetic_annual_corrections, []);
  assert.equal(annual.blockers.some((item) => item.blocker_code === "ANNUAL_REQUIRES_12_RECONCILED_MONTHS"), true);
});

test("twelve residual-only month shells cannot masquerade as an annual reconciliation", () => {
  const annual = aggregate2025MonthlyResults(
    Array.from({ length: 12 }, (_, index) => ({
      organization: ORG,
      period: `2025-${String(index + 1).padStart(2, "0")}`,
      scenario: { RESIDUAL_DELTA: 0 },
    })),
    { organization: ORG },
  );
  assert.equal(annual.ready, false);
  assert.equal(annual.annual_summary, null);
  assert.equal(annual.blockers.some((item) => item.blocker_code === "MONTH_SCENARIO_INCOMPLETE"), true);
});
