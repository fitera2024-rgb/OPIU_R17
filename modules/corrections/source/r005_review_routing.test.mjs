import assert from "node:assert/strict";
import test from "node:test";

import { unprovenOneSideReviews } from "./r005_review_routing.mjs";

const ORGANIZATION = "9 Управляющая компания";
const PERIOD = "2025-10";

function basisRow(overrides = {}) {
  return {
    code: "QA-BASIS-001",
    organization: ORGANIZATION,
    period: PERIOD,
    is_discrepancy: true,
    hierarchy_has_children: false,
    structural_non_posting: false,
    erp_amount: 1_000,
    intalev_amount: 1_010,
    delta: 10,
    ...overrides,
  };
}

function reviews(rows) {
  return reviewsWithEvidence(rows, []);
}

function reviewsWithEvidence(rows, evidenceRows) {
  return unprovenOneSideReviews({
    organization: ORGANIZATION,
    period: PERIOD,
    tolerance: 0.01,
    rows,
    operation_evidence: { rows: evidenceRows, pair_candidates: [] },
  }, { organization: ORGANIZATION, period: PERIOD });
}

function reviewsFromPayload(payload) {
  return unprovenOneSideReviews({
    organization: ORGANIZATION,
    period: PERIOD,
    tolerance: 0.01,
    operation_evidence: { rows: [], pair_candidates: [] },
    ...payload,
  }, { organization: ORGANIZATION, period: PERIOD });
}

function provenEvidence(overrides = {}) {
  return {
    code: "QA-BASIS-001",
    organization: ORGANIZATION,
    period: PERIOD,
    source_row: "SYNTHETIC:1",
    registrar: "SYNTHETIC-DOC",
    posting_number: 1,
    debit_account: "QA-DEBIT",
    credit_account: "QA-CREDIT",
    proof_status: "PROVEN",
    ...overrides,
  };
}

test("selected R005 basis preserves exact scope, totals, and signed delta", () => {
  const result = reviews([
    basisRow({ organization: "Foreign organization", erp_amount: 1, intalev_amount: 91, delta: 90 }),
    basisRow({ period: "2025-09", erp_amount: 5, intalev_amount: 85, delta: 80 }),
    basisRow(),
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual({
    organization: result[0].organization,
    period: result[0].period,
    analyticalBasisId: result[0].analyticalBasisId,
    erpAmount: result[0].erpAmount,
    intalevAmount: result[0].intalevAmount,
    delta: result[0].delta,
    basisContractValid: result[0].basisContractValid,
  }, {
    organization: ORGANIZATION,
    period: PERIOD,
    analyticalBasisId: "QA-BASIS-001",
    erpAmount: 1_000,
    intalevAmount: 1_010,
    delta: 10,
    basisContractValid: true,
  });
  assert.equal(Math.round(result[0].delta * 100), Math.round((result[0].intalevAmount - result[0].erpAmount) * 100));
});

test("missing scope is rejected instead of borrowing selected context", () => {
  assert.equal(reviews([basisRow({ organization: "" })]).length, 0);
  assert.equal(reviews([basisRow({ period: "" })]).length, 0);
});

test("foreign or unscoped evidence cannot suppress or trace the selected basis", () => {
  const [review] = reviewsWithEvidence([basisRow()], [
    provenEvidence({ organization: "Foreign organization" }),
    provenEvidence({ organization: "" }),
    provenEvidence({ period: "2025-09" }),
    provenEvidence({ period: "" }),
  ]);
  assert.equal(review.basisContractValid, true);
  assert.deepEqual(review.evidenceRows, []);
  assert.equal(review.sourceRange, "ROW:QA-BASIS-001");
});

test("exact selected proven evidence suppresses an unproven review", () => {
  assert.equal(reviewsWithEvidence([basisRow()], [provenEvidence()]).length, 0);
});

test("incomplete basis remains fail-closed", () => {
  const [review] = reviews([basisRow({ erp_amount: null })]);
  assert.equal(review.basisContractValid, false);
  assert.equal(review.erpAmount, null);
  assert.equal(review.intalevAmount, null);
  assert.deepEqual(review.basisContractBlockers, ["INCOMPLETE_R005_BASIS_TOTALS"]);
});

test("signed delta mismatch remains fail-closed", () => {
  const [review] = reviews([basisRow({ delta: 9.99 })]);
  assert.equal(review.basisContractValid, false);
  assert.equal(review.erpAmount, null);
  assert.equal(review.intalevAmount, null);
  assert.deepEqual(review.basisContractBlockers, ["INVALID_R005_SIGNED_DELTA"]);
});

test("identical duplicate basis is counted once", () => {
  const result = reviews([basisRow(), basisRow()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].basisContractValid, true);
});

test("conflicting duplicate basis remains fail-closed", () => {
  const result = reviews([
    basisRow(),
    basisRow({ erp_amount: 1_001, intalev_amount: 1_011 }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].basisContractValid, false);
  assert.equal(result[0].erpAmount, null);
  assert.equal(result[0].intalevAmount, null);
  assert.deepEqual(result[0].basisContractBlockers, ["CONFLICTING_R005_BASIS_TOTALS"]);
});

test("R001, R050/R051, and other parent/group deltas never become raw R001 correction fallbacks", () => {
  const result = reviews([
    basisRow({ code: "R001", group: "БЛОК", hierarchy_group: "БЛОК" }),
    basisRow({ code: "R050", group: "ПОДБЛОК", hierarchy_group: "ПОДБЛОК" }),
    basisRow({ code: "R051", hierarchy_has_children: true }),
    basisRow({ code: "R020", row_kind: "GROUP" }),
    basisRow({ code: "R052" }),
  ]);

  assert.deepEqual(result.map((review) => review.rowCode), ["R052"]);
  assert.equal(result.filter((review) => ["R001", "R020", "R050", "R051"].includes(review.rowCode)).length, 0);
});

test("a row referenced as a parent by another row remains CONTROL_ONLY even when its flag is missing", () => {
  const result = reviews([
    basisRow({ code: "QA-PARENT", hierarchy_has_children: false }),
    basisRow({ code: "QA-CHILD", hierarchy_parent_code: "QA-PARENT" }),
  ]);

  assert.deepEqual(result.map((review) => review.rowCode), ["QA-CHILD"]);
});

test("source-tree parent proof suppresses a raw R001 fallback when the row flag is stale", () => {
  const groupPath = "Расходы / ФЗП и компенсационные выплаты";
  const result = reviewsFromPayload({
    rows: [
      basisRow({ code: "R036", intalev_paths: [groupPath], hierarchy_has_children: false }),
      basisRow({ code: "R035", intalev_paths: [`${groupPath} / НДФЛ`] }),
    ],
    hierarchy_periods: [{
      period: PERIOD,
      intalev_tree: {
        nodes: [
          { node_id: "G", full_path: groupPath, immediate_children: [], is_group: false },
          { node_id: "C", full_path: `${groupPath} / НДФЛ`, immediate_children: [], is_group: false },
        ],
      },
      erp_tree: { nodes: [] },
    }],
  });

  assert.deepEqual(result.map((review) => review.rowCode), ["R035"]);
});

test("source-tree proof never falls back to the first non-selected period", () => {
  const groupPath = "Расходы / ФЗП и компенсационные выплаты";
  const result = reviewsFromPayload({
    rows: [basisRow({ code: "R036", intalev_paths: [groupPath] })],
    hierarchy_periods: [{
      period: "2025-09",
      intalev_tree: {
        nodes: [{ node_id: "G", full_path: groupPath, immediate_children: ["C"], is_group: true }],
      },
      erp_tree: { nodes: [] },
    }],
  });

  assert.deepEqual(result.map((review) => review.rowCode), ["R036"]);
});

test("duplicate exact hierarchy periods are ambiguous and grant no control-only authority", () => {
  const groupPath = "Расходы / ФЗП и компенсационные выплаты";
  const periodTree = {
    period: PERIOD,
    intalev_tree: {
      nodes: [{ node_id: "G", full_path: groupPath, immediate_children: ["C"], is_group: true }],
    },
    erp_tree: { nodes: [] },
  };
  const result = reviewsFromPayload({
    rows: [basisRow({ code: "R036", intalev_paths: [groupPath] })],
    hierarchy_periods: [periodTree, structuredClone(periodTree)],
  });

  assert.deepEqual(result.map((review) => review.rowCode), ["R036"]);
});

test("multiple distinct row paths are ambiguous and never select the first path", () => {
  const groupPath = "Расходы / ФЗП и компенсационные выплаты";
  const result = reviewsFromPayload({
    rows: [basisRow({ code: "R036", intalev_paths: [groupPath, "Расходы / Другой путь"] })],
    hierarchy_periods: [{
      period: PERIOD,
      intalev_tree: {
        nodes: [{ node_id: "G", full_path: groupPath, immediate_children: ["C"], is_group: true }],
      },
      erp_tree: { nodes: [] },
    }],
  });

  assert.deepEqual(result.map((review) => review.rowCode), ["R036"]);
});

test("zero-sum internal reclass is not routed as two ADD_ONE_SIDE reviews", () => {
  const result = reviewsFromPayload({
    rows: [
      basisRow({
        code: "PAYROLL-GROUP",
        delta: 0,
        intalev_amount: 100,
        erp_amount: 100,
        control_only: true,
        hierarchy_has_children: true,
      }),
      basisRow({
        code: "PAYROLL-SOURCE",
        hierarchy_parent_code: "PAYROLL-GROUP",
        delta: -10,
        erp_amount: 10,
        intalev_amount: 0,
        branch_key: "PAYROLL",
      }),
      basisRow({
        code: "PAYROLL-TARGET",
        hierarchy_parent_code: "PAYROLL-GROUP",
        delta: 10,
        erp_amount: 0,
        intalev_amount: 10,
        branch_key: "PAYROLL",
      }),
    ],
  });

  assert.deepEqual(result, []);
});

test("cross-branch reclass candidate is not routed as two one-sided corrections", () => {
  const result = reviewsFromPayload({
    rows: [
      basisRow({
        code: "ADMIN-LEAF",
        delta: -10,
        erp_amount: 10,
        intalev_amount: 0,
        branch_key: "ADMIN",
      }),
      basisRow({
        code: "IT-LEAF",
        delta: 10,
        erp_amount: 0,
        intalev_amount: 10,
        branch_key: "IT",
      }),
    ],
  });

  assert.deepEqual(result, []);
});

test("ordinary unproven financial delta remains review/control and never becomes one-sided correction", () => {
  const [review] = reviews([basisRow()]);

  assert.equal(review.classification, "UNPROVEN_FINANCIAL_DELTA");
  assert.equal(review.reviewOnly, true);
  assert.equal(review.reviewCategory, "Контроль");
  assert.equal(review.outputRoute, "КОНТРОЛЬ");
  assert.equal(review.correctionRoute, "REVIEW_ONLY");
  assert.equal(review.executionAllowed, false);
  assert.equal(review.readyToUpload, false);
  assert.equal(review.releaseAllowed, false);
});
