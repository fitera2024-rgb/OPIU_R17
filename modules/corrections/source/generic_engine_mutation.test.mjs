import assert from "node:assert/strict";
import test from "node:test";

import { projectOwnerEconomicDecisions } from "../../reconciliation/source/owner_decision_projection.mjs";
import {
  buildOperationDisplayRow,
  selectJournalRowsForExactProfile,
} from "../../reconciliation/source/arbitrary_period_operation_evidence.mjs";
import { materializeExactSourceRow, selectExactSourceSubset } from "./r001_sporno_materialization.mjs";
import { mergeOwnerAndRuleDecisions } from "./owner_decision_r001.mjs";

function reclassRows(source, firstTarget, secondTarget) {
  return [
    { code: "R033", intalev_amount: 0, erp_amount: 0, delta: 0 },
    { code: "R034", presentation_parent_code: "R033", intalev_amount: secondTarget, erp_amount: 0, delta: secondTarget },
    { code: "R035", presentation_parent_code: "R033", intalev_amount: firstTarget, erp_amount: 0, delta: firstTarget },
    { code: "R036", presentation_parent_code: "R033", intalev_amount: 0, erp_amount: source, delta: -source },
  ];
}

test("amount, organization and period mutations use the same economic case path", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: "Организация X",
    period: "2025-03",
    rows: reclassRows(123456, 120000, 3456),
  });
  const candidates = projection.cases.filter((item) => item.member_rows.some((member) => member.code === "R036"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].amount, 123456);
  assert.equal(candidates[0].period, "2025-03");
  assert.equal(candidates[0].decision_type, "NO_POSTING");
  assert.equal(candidates[0].proof_status, "NUMERIC_ZERO_SUM_CANDIDATE_ONLY");
  assert.equal(candidates[0].correction_allowed, false);
  assert.equal(projection.organization, "Организация X");
  assert.deepEqual(candidates[0].member_rows.map((item) => item.effective_delta).sort((a, b) => a - b), [-123456, 3456, 120000]);
});

test("year projection keeps independent month-local cases", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: "Организация X",
    period: "2025",
    period_rows: [
      { period: "2025-03", rows: reclassRows(123456, 120000, 3456) },
      { period: "2025-11", rows: reclassRows(95088, 93588, 1500) },
    ],
  });
  const candidates = projection.cases.filter((item) => item.member_rows.some((member) => member.code === "R036"));
  assert.deepEqual(candidates.map((item) => [item.period, item.amount, item.decision_type]), [
    ["2025-03", 123456, "NO_POSTING"],
    ["2025-11", 95088, "NO_POSTING"],
  ]);
  assert.ok(projection.period_row_links["2025-03"].R036.length > 0);
  assert.ok(projection.period_row_links["2025-11"].R036.length > 0);
});

test("physical source proof survives a hierarchy blocker without authorizing a correction", () => {
  const operation = {
    source_row_id: "D".repeat(64), source_range: "B42:AG42", physical_row: 42,
    erp_input_sha256: "B".repeat(64), erp_opiu_sha256: "C".repeat(64),
    journal_sha256: "A".repeat(64), journal_sheet: "Лист_1",
    date: "01.03.2025 0:00:00", document: "Документ X", posting_no: 7,
    organization: "Организация X", debit: "26", credit: "70", amount: 123456,
    debit_analytics: ["ФЗП"], credit_analytics: [],
    article: "ФЗП", disclosure: "Счет затрат 26",
  };
  const row = buildOperationDisplayRow(operation, {
    code: "R036", period: "2025-03", expected: 123456,
    owner_codes: ["R036"], expected_accounts: ["26"],
    blocker: "BLOCKED_TEMPLATE_CATALOG_MISMATCH", pair_candidate: null,
  }, false, 42, new Set(), true);
  assert.equal(row.source_operation_proven, true);
  assert.equal(row.source_proof_status, "SOURCE_OPERATION_PROVEN");
  assert.equal(row.exact_article_bound, true);
  assert.equal(row.economic_correction_proven, false);
  assert.equal(row.economic_proof_status, "ECONOMIC_CORRECTION_UNPROVEN");
  assert.equal(row.row_class, "CANDIDATE_EXCLUDED");
  assert.equal(row.proof_status, "SOURCE_OPERATION_PROVEN");
  assert.equal(row.count_in_parent, false);
  assert.equal(row.excluded_from_totals, true);
  assert.match(row.source_operation_identity, /^[A-F0-9]{64}$/);
});

test("a displayed residual normalized to zero remains an explicit non-financial review", () => {
  const payload = {
    organization: "Организация X",
    period: "2026-04",
    rows: [
      { code: "R001", intalev_amount: 0, erp_amount: 0, delta: 0 },
      { code: "R002", presentation_parent_code: "R001", intalev_amount: 100, erp_amount: 50, delta: 50 },
      { code: "R003", presentation_parent_code: "R002", intalev_amount: 50, erp_amount: 0, delta: 50 },
    ],
  };
  payload.rows[1].intalev_sources = [{ sha256: "A".repeat(64), sheet: "I", source_cell: "A2", amount: 100 }];
  payload.rows[2].intalev_sources = payload.rows[1].intalev_sources;
  const projection = projectOwnerEconomicDecisions(payload);
  const review = projection.cases.find((item) => item.member_rows.some((member) => member.code === "R002"));
  assert.equal(review?.classification, "REVIEW_ONLY");
  assert.equal(review?.decision_type, "NO_POSTING");
  assert.equal(review?.correction_allowed, false);
});

test("owner REVIEW_ONLY suppresses a weaker Rules one-side fallback for the same row", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: "Организация X",
    period: "2026-04",
    rows: [{ code: "R035", intalev_amount: 100, erp_amount: 0, delta: 100 }],
  });
  const merged = mergeOwnerAndRuleDecisions({
    applicationsDocument: {
      applications: [{
        application_id: "APPLICATION-X-R035",
        candidate_id: "CANDIDATE-X-R035",
        proof_status: "UNPROVEN",
        candidate_snapshot: { action_type: "ONE_SIDE", reconciliation_row_code: "R035" },
      }],
    },
    projection,
    organization: "Организация X",
    period: "2026-04",
  });
  assert.deepEqual(merged.filtered_application_ids, ["APPLICATION-X-R035"]);
  assert.equal(merged.retained_application_count, 0);
  assert.equal(merged.decisions.some((item) => item.decision_type === "ADD_ONE_SIDE"), false);
});

test("year-scoped owner row links suppress the same Rules one-side fallback", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: "Организация X",
    period: "2026",
    period_rows: [{
      period: "2026-04",
      rows: [{ code: "R035", intalev_amount: 100, erp_amount: 0, delta: 100 }],
    }],
  });
  const merged = mergeOwnerAndRuleDecisions({
    applicationsDocument: {
      applications: [{
        application_id: "APPLICATION-X-R035",
        candidate_id: "CANDIDATE-X-R035",
        proof_status: "UNPROVEN",
        candidate_snapshot: { action_type: "ONE_SIDE", reconciliation_row_code: "R035" },
      }],
    },
    projection,
    organization: "Организация X",
    period: "2026",
  });
  assert.deepEqual(merged.filtered_application_ids, ["APPLICATION-X-R035"]);
  assert.equal(merged.retained_application_count, 0);
});

test("source organization is input data and mutated amounts propagate", () => {
  const rows = selectJournalRowsForExactProfile([{
    period: "2025-03", organization: "Организация X", activity: "Да", scenario: "Факт",
  }], "2025-03", []);
  assert.equal(rows.length, 1);
  const subset = selectExactSourceSubset([{ amount: 120000, source_ref: "B1:AG1" }, { amount: 3456, source_ref: "B2:AG2" }], 123456);
  assert.equal(subset.rows.reduce((sum, row) => sum + row.amount, 0), 123456);

  const raw = {
    amount: 123456, amount_accounting: 123456, organization: "Организация X",
    source_range: "B42:AG42", source_row_id: "ROW-X", date: "01.03.2025 0:00:00",
    document: "Документ X", posting_no: 7, debit: "26", credit: "70",
    operation_kind: "Операция", debit_analytics_1: "ФЗП", debit_analytics_2: "", debit_analytics_3: "",
    credit_analytics_1: "", credit_analytics_2: "", credit_analytics_3: "",
    debit_department: "ЦФО X", credit_department: "ЦФО X", content: "",
  };
  const row = materializeExactSourceRow({
    raw, operation: "REPOST", partCents: 12000000, sourceCode: "R036", sourceLabel: "ФЗП",
    targetCode: "R035", targetLabel: "НДФЛ",
    decision: { case_id: "CASE-X", pair_id: "PAIR-X", period: "2025-03", proof_status: "PROVEN" },
    reconciliationOrganization: "9 Управляющая компания",
    source: { archive_path: "erp.zip", archive_sha256: "B".repeat(64), journal_entry: "journal.xlsx", journal_sha256: "A".repeat(64), journal_sheet: "Лист_1" },
    subset: { unique: true, solution_count: 1 },
  });
  assert.equal(row.audit.sourceOrganization, "Организация X");
  assert.equal(row.audit.period, "2025-03");
  assert.equal(row.audit.amount, 120000);
});
