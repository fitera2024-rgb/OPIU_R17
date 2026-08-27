import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import JSZip from "jszip";

import {
  CROSS_JOURNAL_CORRECTION_HEADERS,
  CROSS_JOURNAL_DISCREPANCY_HEADERS,
  JOURNAL_OPERATION_HEADERS,
  MANDATORY_RECONCILIATION_SHEET_NAMES,
  OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME,
  createMandatoryWorkbookSheets,
  initializeMandatoryZeroWorkbookSheets,
  patchWorksheetOutline,
} from "./opiu_reconcile.mjs";
import {
  OWNER_DECISION_EXPLANATION_HEADERS,
  appendOwnerDecisionExplanationSheet,
} from "./owner_decision_xlsx.mjs";

const PERIOD = "2026-02";
const OWNER_SHEET = "08_Решения_обоснование";

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function zipMetadata(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const contentTypesXml = await zip.file("[Content_Types].xml").async("string");
  const sheets = [...workbookXml.matchAll(
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheet\b[^>]*\/?\s*>/g,
  )].map((match) => {
    const tag = match[0];
    const name = decodeXml(/\bname="([^"]+)"/.exec(tag)?.[1]);
    const sheetId = /\bsheetId="([^"]+)"/.exec(tag)?.[1] ?? "";
    const relId = /\br:id="([^"]+)"/.exec(tag)?.[1] ?? "";
    const relationship = [...relsXml.matchAll(
      /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Relationship\b[^>]*\/?\s*>/g,
    )].map((entry) => entry[0]).find((entry) =>
      /\bId="([^"]+)"/.exec(entry)?.[1] === relId);
    const rawTarget = /\bTarget="([^"]+)"/.exec(relationship ?? "")?.[1] ?? "";
    const normalizedTarget = rawTarget.replace(/^\//, "").replace(/^\.\//, "");
    const target = normalizedTarget.startsWith("xl/")
      ? normalizedTarget
      : `xl/${normalizedTarget}`;
    const partName = `/${target}`;
    const contentType = contentTypesXml.match(new RegExp(
      `<Override\\b(?=[^>]*PartName="${regexEscape(partName)}")(?=[^>]*ContentType="([^"]+)")[^>]*/\\s*>`,
    ))?.[1] ?? "";
    return { name, sheetId, relId, rawTarget, target, contentType };
  });
  return { zip, workbookXml, relsXml, contentTypesXml, sheets };
}

async function reopenedWorkbook(filePath) {
  return SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
}

async function assertNoFormulaErrors(workbook) {
  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    summary: "mandatory workbook formula scan",
  });
  assert.doesNotMatch(errors.ndjson, /#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/);
}

function assertSheetContract(workbook, sheetName, lastColumn, headers, infoCode) {
  const values = workbook.worksheets.getItem(sheetName).getRange(`A1:${lastColumn}5`).values;
  assert.ok(String(values[0][0] ?? "").trim(), `${sheetName} title row 1`);
  assert.match(String(values[1][0] ?? ""), /^REPORT_ONLY\b/);
  assert.deepEqual(values[3].slice(0, headers.length), [...headers]);
  assert.equal(values[4][0], infoCode);
}

async function createZeroWorkbook(directory, name, includeProvenOperations) {
  const workbook = Workbook.create();
  const sheets = createMandatoryWorkbookSheets(workbook, {
    periodLabel: PERIOD,
    includeProvenOperations,
  });
  initializeMandatoryZeroWorkbookSheets(sheets, PERIOD);
  const outputPath = path.join(directory, name);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  await patchWorksheetOutline({
    outputPath,
    sheetName: "01_Сверка_дерево",
    dataStartRow: 7,
    outlineLevels: [],
    rowKinds: [],
    activeTabIndex: 1,
    freezeRows: 6,
    freezeColumns: 3,
  });
  return outputPath;
}

test("core emits the exact mandatory 15-sheet workbook contract for zero rows", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-mandatory-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = await createZeroWorkbook(directory, "zero.xlsx", false);
  const metadata = await zipMetadata(outputPath);

  assert.deepEqual(metadata.sheets.map((sheet) => sheet.name), [
    ...MANDATORY_RECONCILIATION_SHEET_NAMES,
  ]);
  assert.equal(new Set(metadata.sheets.map((sheet) => sheet.name)).size, 15);
  assert.match(metadata.workbookXml, /\bactiveTab="1"/);
  assert.equal(metadata.sheets.every((sheet) => sheet.sheetId && sheet.relId && sheet.rawTarget), true);
  assert.equal(metadata.sheets.every((sheet) =>
    sheet.contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"), true);

  assert.equal(CROSS_JOURNAL_DISCREPANCY_HEADERS.length, 33);
  assert.equal(CROSS_JOURNAL_CORRECTION_HEADERS.length, 55);
  assert.equal(JOURNAL_OPERATION_HEADERS.length, 17);
  assert.equal(OWNER_DECISION_EXPLANATION_HEADERS.length, 21);

  const reopened = await reopenedWorkbook(outputPath);
  assertSheetContract(
    reopened,
    "04A_Расхождения_проводок",
    "AG",
    CROSS_JOURNAL_DISCREPANCY_HEADERS,
    "INFO_NO_CROSS_JOURNAL_ROWS",
  );
  assertSheetContract(
    reopened,
    "04B_R001_решения",
    "BC",
    CROSS_JOURNAL_CORRECTION_HEADERS,
    "INFO_NO_R001_DECISION_ROWS",
  );
  assertSheetContract(
    reopened,
    "08_Операции_журнала",
    "Q",
    JOURNAL_OPERATION_HEADERS,
    "INFO_NO_JOURNAL_OPERATION_ROWS",
  );
  assertSheetContract(
    reopened,
    OWNER_SHEET,
    "U",
    OWNER_DECISION_EXPLANATION_HEADERS,
    "INFO_NO_OWNER_DECISIONS",
  );
  await assertNoFormulaErrors(reopened);
});

test("optional proven operations is exactly sheet 16", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-optional-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = await createZeroWorkbook(directory, "optional.xlsx", true);
  const metadata = await zipMetadata(outputPath);
  assert.deepEqual(metadata.sheets.map((sheet) => sheet.name), [
    ...MANDATORY_RECONCILIATION_SHEET_NAMES,
    OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME,
  ]);
  assert.equal(metadata.sheets[15].name, OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME);
  await assertNoFormulaErrors(await reopenedWorkbook(outputPath));
});

test("owner wrapper replaces the exact placeholder XML in place and is idempotent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-wrapper-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = await createZeroWorkbook(directory, "wrapper.xlsx", true);
  const before = await zipMetadata(outputPath);
  const beforeOwner = before.sheets.find((sheet) => sheet.name === OWNER_SHEET);
  assert.ok(beforeOwner);

  const payload = {
    rows: [{
      code: "R-SYNTHETIC",
      intalev_label: "Synthetic owner decision",
      intalev_amount: 1,
      erp_amount: 0,
      delta: 1,
    }],
  };
  const projection = { cases: [], row_links: {} };
  const first = await appendOwnerDecisionExplanationSheet(outputPath, payload, projection);
  assert.equal(first.rows, 1);
  const afterFirst = await zipMetadata(outputPath);
  const afterFirstOwner = afterFirst.sheets.find((sheet) => sheet.name === OWNER_SHEET);

  assert.deepEqual(afterFirst.sheets.map((sheet) => sheet.name), before.sheets.map((sheet) => sheet.name));
  assert.deepEqual(afterFirstOwner, beforeOwner);
  assert.equal(afterFirst.workbookXml, before.workbookXml);
  assert.equal(afterFirst.relsXml, before.relsXml);
  assert.equal(afterFirst.contentTypesXml, before.contentTypesXml);
  assert.equal(afterFirst.sheets.length, 16);
  assert.match(afterFirst.workbookXml, /\bactiveTab="1"/);

  const firstOwnerXml = await afterFirst.zip.file(afterFirstOwner.target).async("string");
  const second = await appendOwnerDecisionExplanationSheet(outputPath, payload, projection);
  assert.equal(second.rows, 1);
  const afterSecond = await zipMetadata(outputPath);
  const secondOwner = afterSecond.sheets.find((sheet) => sheet.name === OWNER_SHEET);
  const secondOwnerXml = await afterSecond.zip.file(secondOwner.target).async("string");
  assert.deepEqual(secondOwner, beforeOwner);
  assert.equal(secondOwnerXml, firstOwnerXml);
  assert.equal(afterSecond.workbookXml, before.workbookXml);
  assert.equal(afterSecond.relsXml, before.relsXml);
  assert.equal(afterSecond.contentTypesXml, before.contentTypesXml);

  const reopened = await reopenedWorkbook(outputPath);
  const values = reopened.worksheets.getItem(OWNER_SHEET).getRange("A1:U5").values;
  assert.match(String(values[1][0]), /^REPORT_ONLY\b/);
  assert.deepEqual(values[3], [...OWNER_DECISION_EXPLANATION_HEADERS]);
  assert.equal(values[4][0], "R-SYNTHETIC");
  await assertNoFormulaErrors(reopened);
});

test("owner wrapper fails closed when the mandatory placeholder is missing", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-missing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "missing.xlsx");
  const workbook = Workbook.create();
  workbook.worksheets.add("00_Паспорт");
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  const beforeSha = crypto.createHash("sha256").update(await fs.readFile(outputPath)).digest("hex");

  await assert.rejects(
    appendOwnerDecisionExplanationSheet(outputPath, { rows: [] }, { cases: [], row_links: {} }),
    /OWNER_DECISION_PLACEHOLDER_MISSING:08_Решения_обоснование/,
  );
  const afterSha = crypto.createHash("sha256").update(await fs.readFile(outputPath)).digest("hex");
  assert.equal(afterSha, beforeSha);
});
