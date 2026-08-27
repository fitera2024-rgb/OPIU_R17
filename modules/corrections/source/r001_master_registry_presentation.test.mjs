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

test("master registry writes canonical loader P to 06 and one exact display row to 02", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-master-registry-presentation-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const outputPath = path.join(root, "registry.xlsx");
  const row = decisionRow();
  const audit = materializationAudit();
  await buildMasterRegistry(
    [],
    { pairRows: [row, [...row]], blockers: [], deletionOperations: [], deletionPostings: [] },
    {
      runId: "RUN-1", sourceCount: 1, reconciliationSha: SHA, decisionSha: "", rulesSha: SHA,
      reconciliationPath: "reconciliation.xlsx", decisionPath: "", sourceSheet: "01_Сверка_дерево",
      engineSha: SHA, analyticalPolicySha: SHA,
    },
    outputPath,
    [],
    [],
    { contexts: [], counts: {} },
    [audit],
  );

  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const decisions = workbook.worksheets.getItem("02_STORNO_REPOST").getUsedRange().values;
  assert.equal(decisions.filter((item) => item[0] === "CASE-1" && item[3] === "PAIR-1").length, 1);
  const trace = workbook.worksheets.getItem("06_Трасса_СПОРНО").getUsedRange().values;
  const traceRow = trace.find((item) => item[1] === "AUDIT-1");
  assert.equal(traceRow[2], "REPOST");
  assert.equal(traceRow[9], BUSINESS_CONTENT);
  assert.notEqual(traceRow[9], audit.reason);
});
