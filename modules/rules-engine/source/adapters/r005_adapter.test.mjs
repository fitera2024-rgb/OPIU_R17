import test from "node:test";
import assert from "node:assert/strict";
import { adaptR005 } from "./r005_adapter.mjs";

function evidence(debit, row) {
  return { code: "R033", source_row: row, registrar: `DOC-${row}`, posting_number: row, debit_account: debit, credit_account: "70", article: "ФЗП", proof_status: "PROVEN" };
}

const context = { run_id: "RUN-UK9", period: "2025", organization: { id: "UK9", name: "УК №9" }, paths: {}, source_hashes: {} };

test("R005 adapter uses an operational debit instead of debit 99 closing evidence", () => {
  const payload = {
    schema: "opiu-codex-review-input-v1", organization_code: "UK9", organization: "УК №9",
    rows: [{ code: "R033", is_discrepancy: true, delta: 1, intalev_label: "ФЗП", erp_label: "ФЗП", intalev_paths: ["Расходы / 1_Административные расходы / ФЗП"], erp_catalog_paths: ["Расходы / 1_Административные расходы / ФЗП"], article_codes: ["R033"] }],
    operation_evidence: { rows: [evidence("99", "900"), evidence("26", "260")] },
  };
  const result = adaptR005(payload, context);
  assert.equal(result.candidates[0].accounting.debit_account, "26");
  assert.equal(result.candidates[0].action.action_type, "ONE_SIDE");
  assert.equal(result.candidates[0].impact_class, "CORRECTION_ANALYTICS");
  assert.deepEqual(result.candidates[0].evidence.proven_source_rows, ["900", "260"]);
});

test("closing-only debit 99 evidence leaves the operational debit unresolved", () => {
  const payload = {
    schema: "opiu-codex-review-input-v1", organization_code: "UK9", organization: "УК №9",
    rows: [{ code: "R033", is_discrepancy: true, delta: 1, intalev_label: "ФЗП", erp_label: "ФЗП", intalev_paths: ["Расходы / 1_Административные расходы / ФЗП"], erp_catalog_paths: ["Расходы / 1_Административные расходы / ФЗП"], article_codes: ["R033"] }],
    operation_evidence: { rows: [evidence("99", "900")] },
  };
  const result = adaptR005(payload, context);
  assert.equal(result.candidates[0].accounting.debit_account, "");
  assert.equal(result.candidates[0].user_status, "PENDING_REVIEW");
});

test("configured R045/R055 never become Rules candidates while R046 remains independently actionable", () => {
  const payload = {
    schema: "opiu-codex-review-input-v1",
    organization_code: "UK9",
    organization: "УК №9",
    structural_group_control_sets: [{
      id: "test_presentation_exception",
      enabled: true,
      organization: "УК №9",
      members: ["R045", "R055"],
      mode: "SUM_DELTA_ONLY",
      tolerance: 0.01,
    }],
    rows: [
      { code: "R045", is_discrepancy: true, delta: -3964465.87 },
      { code: "R055", is_discrepancy: true, delta: 3964465.87 },
      {
        code: "R046",
        is_discrepancy: true,
        delta: -120,
        intalev_label: "Дочерняя статья",
        erp_label: "Дочерняя статья",
        intalev_paths: ["R045 / R046"],
        erp_catalog_paths: ["R045 / R046"],
        article_codes: ["R046"],
      },
    ],
    zero_sum_storno_repost_candidates: [{
      source_codes: ["R045"],
      target_codes: ["R055"],
      member_deltas: [
        { code: "R045", delta: -3964465.87 },
        { code: "R055", delta: 3964465.87 },
      ],
    }],
    operation_evidence: { rows: [] },
  };

  const result = adaptR005(payload, { ...context, period: "2025-10" });
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.action.parameters.row_code),
    ["R046"],
  );
  assert.equal(result.applications.every((application) => application.candidate_id.includes("R046")), true);
});

test("stale structural row metadata cannot suppress a Rules candidate with empty config", () => {
  const payload = {
    schema: "opiu-codex-review-input-v1",
    organization_code: "UK9",
    organization: "УК №9",
    structural_group_control_sets: [],
    rows: [{
      code: "STALE",
      is_discrepancy: true,
      delta: -100,
      structural_group_control_enabled: true,
      structural_group_control_set_id: "old_set",
      structural_group_sum_status: "STRUCTURAL_GROUP_SUM_OK",
      structural_control_effective_delta: 0,
      intalev_label: "Статья",
      erp_label: "Статья",
      intalev_paths: ["Блок / Статья"],
      erp_catalog_paths: ["Блок / Статья"],
      article_codes: ["STALE"],
    }],
    operation_evidence: { rows: [] },
  };
  const result = adaptR005(payload, { ...context, period: "2025-11" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].action.parameters.row_code, "STALE");
});
