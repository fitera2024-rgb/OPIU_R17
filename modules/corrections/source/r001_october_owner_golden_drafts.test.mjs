import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

import { LOADER_HEADERS } from "./correction_engine_r001.mjs";
import { prepareOwnerR001Input, runCore } from "./service_r001_owner_wrapper.mjs";

const handoffPath = process.env.OPIU_R001_OCTOBER_GOLDEN_HANDOFF ?? "";
const handoffSha256 = process.env.OPIU_R001_OCTOBER_GOLDEN_HANDOFF_SHA256 ?? "";
const goldenAvailable = Boolean(handoffPath && handoffSha256);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function objectsFromMatrix(values, headerIndex = 0) {
  const headers = (values[headerIndex] ?? []).map(text);
  return values.slice(headerIndex + 1)
    .filter((row) => row.some((value) => text(value)))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null])));
}

test("October owner golden restores exact 16 report-only correction pairs", {
  skip: goldenAvailable ? false : "set the pinned October Service handoff path and SHA-256",
  timeout: 240_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-october-golden-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const prepared = await prepareOwnerR001Input({ handoffPath, handoffSha256 });
  const originalConsoleLog = console.log;
  console.log = () => {};
  let result;
  try {
    result = await runCore(prepared, { outputDir: root });
  } finally {
    console.log = originalConsoleLog;
  }
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const handoff = JSON.parse(await fs.readFile(handoffPath, "utf8"));

  assert.equal(result.canonical_financial_rows_total, 32);
  assert.equal(result.draft_posting_rows, 32);
  assert.equal(result.materialized_posting_rows, 32);
  assert.equal(result.sporno_financial_rows, 32);
  assert.equal(result.storno_rows, 16);
  assert.equal(result.repost_rows, 16);
  assert.equal(result.group_scoped_materialized_pairs, 16);
  assert.equal(result.hierarchy_intergroup_physical_decisions, 14);
  assert.equal(result.hierarchy_paired_liability_decisions, 2);
  assert.equal(result.hierarchy_total_authority_decisions, 16);

  const outputCounts = result.output_file_row_counts
    .map((record) => record.financial_rows)
    .sort((left, right) => left - right);
  assert.deepEqual(outputCounts, [8, 10, 14]);
  assert.equal(result.sporno_financial_workbooks, 3);
  assert.equal(result.ready_financial_workbooks, 0);

  const workbookPaths = result.outputFiles.filter((filePath) => /ОПИУ_ГОТОВО_СПОРНО\.xlsx$/iu.test(filePath));
  assert.equal(workbookPaths.length, 3);
  const allRows = [];
  for (const workbookPath of workbookPaths) {
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
    assert.deepEqual(workbook.worksheets.items.map((sheet) => sheet.name), ["Загрузка_A_AA"]);
    const values = workbook.worksheets.items[0].getUsedRange()?.values ?? [];
    assert.equal(values[0]?.length, 27);
    assert.deepEqual(values[0], LOADER_HEADERS);
    const rows = objectsFromMatrix(values);
    assert.ok([8, 10, 14].includes(rows.length));
    allRows.push(...rows);
  }

  assert.equal(allRows.length, 32);
  const stornoRows = allRows.filter((row) => text(row.ВидОперации).toUpperCase() === "STORNO");
  const repostRows = allRows.filter((row) => text(row.ВидОперации).toUpperCase() === "REPOST");
  const total = (rows) => rows.reduce((sum, row) => sum + Number(row.СуммаВВалютеОтчетности ?? 0), 0);
  assert.equal(stornoRows.length, 16);
  assert.equal(repostRows.length, 16);
  assert.equal(total(stornoRows), -364066);
  assert.equal(total(repostRows), 364066);
  assert.equal(total(allRows), 0);

  const workbookSourceRowCounts = new Map();
  for (const row of allRows) {
    const sourceRowId = text(row.ИдентификаторФинЗаписи);
    assert.ok(sourceRowId, "physical SourceRowID is required");
    workbookSourceRowCounts.set(sourceRowId, (workbookSourceRowCounts.get(sourceRowId) ?? 0) + 1);
  }
  assert.equal(workbookSourceRowCounts.size, 16);
  for (const count of workbookSourceRowCounts.values()) assert.equal(count, 2);

  const sourceRowToPairs = new Map();
  const pairOperations = new Map();
  for (const materializationCase of result.materialization_cases) {
    const sourceRowId = text(materializationCase.physical_source?.source_row_id);
    const pairId = text(materializationCase.pair_id);
    assert.ok(sourceRowId, "canonical materialization case requires physical SourceRowID");
    assert.ok(pairId, "canonical materialization case requires PairID");
    if (!sourceRowToPairs.has(sourceRowId)) sourceRowToPairs.set(sourceRowId, new Set());
    sourceRowToPairs.get(sourceRowId).add(pairId);
    if (!pairOperations.has(pairId)) pairOperations.set(pairId, []);
    pairOperations.get(pairId).push(text(materializationCase.action).toUpperCase());
  }
  assert.equal(sourceRowToPairs.size, 16);
  assert.equal(pairOperations.size, 16);
  assert.deepEqual([...workbookSourceRowCounts.keys()].sort(), [...sourceRowToPairs.keys()].sort());
  for (const pairIds of sourceRowToPairs.values()) assert.equal(pairIds.size, 1);
  for (const operations of pairOperations.values()) assert.deepEqual(operations.sort(), ["REPOST", "STORNO"]);

  assert.equal(result.canonical_output_integrity.result, "PASS");
  assert.equal(result.canonical_output_integrity.workbook_financial_rows, 32);
  assert.equal(result.canonical_output_integrity.registry_financial_rows, 32);
  assert.equal(result.canonical_output_integrity.canonical_financial_rows_total, 32);
  assert.equal(manifest.results.canonical_financial_rows_total, 32);

  const r005Workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(handoff.r005.workbook.path));
  const provenSheet = r005Workbook.worksheets.getItem("09_Доказанные_операции");
  const provenValues = provenSheet.getUsedRange()?.values ?? [];
  const provenHeaderIndex = provenValues.findIndex((row) => row.some((value) => text(value) === "PairID")
    && row.some((value) => text(value) === "Регистратор"));
  assert.notEqual(provenHeaderIndex, -1);
  const provenRows = objectsFromMatrix(provenValues, provenHeaderIndex).filter((row) =>
    text(row.Роль).toUpperCase() === "SOURCE"
    && /PROVEN_CURRENT_SOURCE_CANDIDATE/iu.test(text(row.Статус)));
  assert.equal(provenRows.length, 21);
  assert.equal(new Set(provenRows.map((row) => text(row.SourceRowID))).size, 21);

  assert.equal(manifest.inputs.self_discovery_policy.source, "BUILT_IN_NO_RULES_SERVICE");
  assert.equal(result.report_only, true);
  assert.equal(result.posting_rows, 0);
  assert.equal(result.executed_posting_rows, 0);
  assert.equal(result.live_posting_rows, 0);
  assert.equal(result.ready_to_upload, false);
  assert.equal(result.execution_allowed, false);
  assert.equal(result.release_allowed, false);
  assert.equal(result.live_1c_allowed, false);
  assert.equal(result.live_delete_allowed, false);
});
