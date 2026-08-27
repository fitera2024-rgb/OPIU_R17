import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

import {
  buildMasterRegistry,
  canonicalLoaderContent,
  disputedTraceRow,
  exactUniqueDecisionRows,
} from "./correction_engine_r001.mjs";
import {
  enforceServiceHandoffReadyAuthority,
  nonFinancialReviewSetSHA256,
} from "./service_r001_ready_authority.mjs";

const SHA = "A".repeat(64);
const BUSINESS_CONTENT = "Операция REPOST | ERP: документ «Документ 12»; проводка № 4; сумма 125,00 | REPORT_ONLY";

function decisionRow(caseId = "CASE-1", pairId = "PAIR-1") {
  return [
    caseId, "STORNO_REPOST", "_СПОРНО", pairId, "2025-10", "9 Управляющая компания",
    "B12:AG12", "31.10.2025", "Документ 12", 4, 125, "Экономический пересорт",
    "STORNO/REPOST", "MATERIALIZED_SPORNO", "SOURCE_ROW_ID_MISSING", false, false, false,
  ];
}

function materializationAudit() {
  const loaderValues = Array(27).fill("");
  loaderValues[15] = BUSINESS_CONTENT;
  return {
    audit_identity: "AUDIT-1",
    case_id: "CASE-1",
    pair_id: "PAIR-1",
    operation: "REPOST",
    period: "2025-10",
    reconciliation_organization: "9 Управляющая компания",
    source_organization: "ГК",
    source_row_id: "",
    source_archive_path: "erp.zip",
    source_archive_sha256: SHA,
    journal_entry: "journal.xlsx",
    journal_sha256: SHA,
    source_sheet: "Лист_1",
    source_range: "B12:AG12",
    source_date: "31.10.2025",
    document: "Документ 12",
    posting_number: 4,
    output_route: "SPORNO",
    materialization_state: "DRAFT_SPORNO",
    proof_status: "DIRECTION_PROVEN_PHYSICAL_SOURCE_INCOMPLETE",
    correction_allowed: false,
    correction_authority: "NONE_REPORT_ONLY",
    amount: 125,
    reason: "Это причина решения, а не содержание загрузочной строки",
    blockers: ["SOURCE_ROW_ID_MISSING"],
    loader: { "Содержание": "неавторитетная копия" },
    loader_values: loaderValues,
  };
}

function readyAuthorityRow(pairID, operation, amount, sourceRowID, suffix) {
  return {
    pair_id: pairID,
    audit_identity: `${pairID}-${suffix}`,
    operation,
    amount,
    output_route: "READY",
    materialization_case: { physical_source: { source_row_id: sourceRowID } },
  };
}

test("SPORNO trace presents exact canonical loader column P instead of decision reason", () => {
  const audit = materializationAudit();
  assert.equal(canonicalLoaderContent(audit), BUSINESS_CONTENT);
  const row = disputedTraceRow(audit);
  assert.equal(row[9], BUSINESS_CONTENT);
  assert.notEqual(row[9], audit.reason);
  assert.equal(row[2], "REPOST", "operation identity remains explicit in the trace");
});

test("STORNO_REPOST display removes only exact duplicates and preserves first-seen order", () => {
  const first = decisionRow();
  const same = [...first];
  const distinctCase = decisionRow("CASE-2", "PAIR-1");
  const distinctPair = decisionRow("CASE-1", "PAIR-2");
  assert.deepEqual(exactUniqueDecisionRows([first, same, distinctCase, distinctPair]), [first, distinctCase, distinctPair]);
});

test("master registry writes one visible non-financial review per malformed pair without loader authority", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-master-registry-presentation-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "registry.xlsx");
  const row = decisionRow();
  const audit = materializationAudit();
  const scenarios = [
    { pairID: "PAIR-UNBALANCED", sourceRowID: "ROW-12", legs: [["STORNO", 100], ["REPOST", 80]] },
    { pairID: "PAIR-ONE", sourceRowID: "ROW-13", legs: [["STORNO", 100]] },
    { pairID: "PAIR-THREE", sourceRowID: "ROW-14", legs: [["STORNO", 100], ["REPOST", 100], ["STORNO", 100]] },
    { pairID: "PAIR-FOUR", sourceRowID: "ROW-15", legs: [["STORNO", 100], ["REPOST", 100], ["STORNO", 100], ["REPOST", 100]] },
    { pairID: "PAIR-DUPLICATE", sourceRowID: "ROW-16", legs: [["STORNO", 100], ["STORNO", 100]] },
  ];
  const nonFinancialReviews = scenarios.map((scenario) => {
    const rows = scenario.legs.map(([operation, amount], index) => readyAuthorityRow(
      scenario.pairID, operation, amount, scenario.sourceRowID, index,
    ));
    const gate = enforceServiceHandoffReadyAuthority(rows, [scenario.sourceRowID]);
    assert.equal(gate.rows.length, 0, scenario.pairID);
    assert.equal(gate.audit.non_financial_reviews.length, 1, scenario.pairID);
    return gate.audit.non_financial_reviews[0];
  });
  const nonFinancialReviewSHA256 = nonFinancialReviewSetSHA256(nonFinancialReviews);
  await buildMasterRegistry(
    [],
    { pairRows: [row, [...row]], blockers: [], deletionOperations: [], deletionPostings: [] },
    {
      runId: "RUN-1", sourceCount: 1, reconciliationSha: SHA, decisionSha: "", rulesSha: SHA,
      reconciliationPath: "reconciliation.xlsx", decisionPath: "", sourceSheet: "01_Сверка_дерево",
      engineSha: SHA, analyticalPolicySha: SHA,
      serviceHandoffReadyAuthority: { non_financial_review_set_sha256: nonFinancialReviewSHA256 },
    },
    outputPath,
    [],
    [],
    { contexts: [], counts: {} },
    [audit],
    nonFinancialReviews,
  );

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const decisions = workbook.worksheets.getItem("02_STORNO_REPOST").getUsedRange().values;
  assert.equal(decisions.filter((item) => item[0] === "CASE-1" && item[3] === "PAIR-1").length, 1);
  const trace = workbook.worksheets.getItem("06_Трасса_СПОРНО").getUsedRange().values;
  const traceRow = trace.find((item) => item[1] === "AUDIT-1");
  assert.equal(traceRow[2], "REPOST");
  assert.equal(traceRow[9], BUSINESS_CONTENT);
  assert.notEqual(traceRow[9], audit.reason);
  const blockers = workbook.worksheets.getItem("05_Блокеры").getUsedRange().values;
  const reviewRows = blockers.filter((item) => item[1] === "NON_FINANCIAL_REVIEW");
  assert.equal(reviewRows.length, scenarios.length);
  for (const scenario of scenarios) {
    assert.equal(reviewRows.filter((item) => item[3] === scenario.pairID).length, 1, scenario.pairID);
  }
  const unequalReviewRow = reviewRows.find((item) => item[3] === "PAIR-UNBALANCED");
  assert.equal(unequalReviewRow[6], "SourceRowID=ROW-12");
  assert.equal(unequalReviewRow[10], "STORNO=100; REPOST=80");
  assert.equal(unequalReviewRow[11], nonFinancialReviews[0].reason);
  assert.equal(unequalReviewRow[14], "SERVICE_HANDOFF_PAIR_UNBALANCED_NON_FINANCIAL");
  assert.deepEqual(unequalReviewRow.slice(15, 18), [false, false, false]);
  const passport = workbook.worksheets.getItem("00_Паспорт").getUsedRange().values;
  const reviewSummary = passport.find((item) => item[0] === "Non-financial reviews");
  assert.deepEqual(reviewSummary, ["Non-financial reviews", 5, "Review rows", 5, "Review SHA256", nonFinancialReviewSHA256, "Financial authority", false]);
  assert.deepEqual(workbook.worksheets.items.map((sheet) => sheet.name), [
    "00_Паспорт", "01_Решения", "02_STORNO_REPOST", "03_Односторонние", "04_Удаления",
    "05_Блокеры", "06_Трасса_СПОРНО", "07_Источники", "08_Аналитические", "09_На_проверку", "10_Материализация",
  ]);
});
