import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import JSZip from "jszip";

import { buildOperationTreePresentation } from "./operation_tree_presentation.mjs";
import { patchWorksheetOutline } from "./opiu_reconcile.mjs";

const SOURCE_ROW_ID =
  "2748C4E6F44E8C9273AFE32A3D5B36DE99C1D6FD39FA972B3976D7550059C825";
const INTALEV_NODE_ID =
  "INTALEV:d574fd8ed9203004329907d32080e6a002958ebcdbd75f84aaa23e1c43dabbfe";

function presentationRow({ code = "S148", nodeId = INTALEV_NODE_ID, article = "Проезд/доставка сотрудников" } = {}) {
  return {
    code,
    hierarchy_node_id: nodeId,
    intalev_label: article,
    intalev_amount: 1854,
    erp_amount: 0,
    delta: 1854,
  };
}

function anchorEvidence(overrides = {}) {
  return {
    row_type: "UNIQUE_PAIR",
    classification: "МЕЖГРУППОВОЙ ПЕРЕСОРТ",
    period: "2025-01",
    intalev_report_placement_status: "PROVEN_LIVE_REPORT_LEAF_ANALYTIC",
    intalev_report_node_id: INTALEV_NODE_ID,
    intalev_source_row_id:
      "49F314B1C167A69C21DAB409F8226D71FEAC1B1B2517848408888842D07A272A",
    erp_source_row_id: SOURCE_ROW_ID,
    article_erp: "Проезд/доставка сотрудников",
    source_article: "Проезд/доставка сотрудников",
    erp_document: "Трансляция 0000001782 от 19.03.2026 9:03:39",
    erp_rows: "1617",
    source_range: "B1617:AG1617",
    source_date: "31.01.2025",
    posting_number: "8",
    source_dt: "26",
    source_analytics_dt1: "Проезд/доставка сотрудников",
    source_department_dt: "Б_ПВ Отдел по управлению персоналом",
    source_kt: "76.5",
    source_analytics_kt1: "Служебный",
    source_department_kt: "Б_ПВ Отдел по управлению персоналом",
    source_amount: 1854,
    source_organization: "ПВ",
    financial_gate_status: "ДОКАЗАНО",
    reused: false,
    correction_rows: [
      { operation: "STORNO", amount: -1854, source_row_id: SOURCE_ROW_ID },
      { operation: "REPOST", amount: 1854, source_row_id: SOURCE_ROW_ID },
    ],
    ...overrides,
  };
}

function legacyUnassignedRows(count = 39) {
  return Array.from({ length: count }, (_, index) => ({
    row_class: "CANDIDATE_EXCLUDED",
    proof_status: "CANDIDATE_NOT_PROVEN",
    source_row_id: `LEGACY-${String(index + 1).padStart(2, "0")}`,
    physical_row: index + 1,
    article: `Legacy ${index + 1}`,
    amount: index + 1,
  }));
}

function buildTree({ rows = [presentationRow()], evidenceRows = [anchorEvidence()] } = {}) {
  return buildOperationTreePresentation({
    presentationRows: rows,
    financialOutlineLevels: rows.map(() => 3),
    operationEvidence: { rows: [], unassigned_rows: legacyUnassignedRows() },
    crossJournalEvidence: { rows: evidenceRows },
  });
}

function operationCells(operation, level) {
  const cells = Array(30).fill(null);
  cells[0] = operation.pair_id || `SRC-${operation.physical_row}`;
  cells[1] = `${level + 1} — ${operation.row_class}`;
  cells[2] = operation.article;
  cells[6] = operation.proof_status;
  cells[11] = operation.date;
  cells[12] = operation.source_range;
  cells[13] = operation.document;
  cells[14] = operation.posting_no;
  cells[15] = operation.debit;
  cells[16] = (operation.debit_analytics ?? []).join(" | ");
  cells[17] = operation.debit_department;
  cells[18] = operation.credit;
  cells[19] = (operation.credit_analytics ?? []).join(" | ");
  cells[20] = operation.credit_department;
  cells[21] = operation.organization;
  cells[22] = operation.amount;
  cells[27] = `SourceRowID=${operation.source_row_id}; ${operation.comment ?? ""}`;
  return cells;
}

async function materializeActualMainTree(directory, tree) {
  const workbook = Workbook.create();
  const sheet = workbook.worksheets.add("01_Сверка_дерево");
  sheet.getRange("A1:AD6").values = Array.from({ length: 6 }, () => Array(30).fill(null));
  const values = tree.displayRows.map((displayRow, index) => {
    if (displayRow.kind === "FINANCIAL") {
      const cells = Array(30).fill(null);
      cells[0] = displayRow.financial.code;
      cells[2] = displayRow.financial.intalev_label;
      cells[3] = displayRow.financial.intalev_amount;
      cells[4] = displayRow.financial.erp_amount;
      cells[5] = displayRow.financial.delta;
      cells[27] = `hierarchy_node_id=${displayRow.financial.hierarchy_node_id}`;
      return cells;
    }
    if (displayRow.kind === "OPERATION_REVIEW_HEADER") {
      const cells = Array(30).fill(null);
      cells[0] = "ЖУРНАЛ";
      cells[2] = "Операции журнала без доказанной связи";
      return cells;
    }
    return operationCells(displayRow.operation, tree.outlineLevels[index]);
  });
  if (values.length > 0) {
    sheet.getRangeByIndexes(6, 0, values.length, 30).values = values;
  }
  const outputPath = path.join(directory, "reconciliation.xlsx");
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  await patchWorksheetOutline({
    outputPath,
    sheetName: "01_Сверка_дерево",
    dataStartRow: 7,
    outlineLevels: tree.outlineLevels,
    rowKinds: tree.displayRows.map((row) => row.kind),
    activeTabIndex: 0,
  });
  return outputPath;
}

async function mainTreeXml(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const sheetTag = [...workbookXml.matchAll(
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheet\b[^>]*\/?\s*>/g,
  )]
    .map((match) => match[0])
    .find((tag) => /name="01_Сверка_дерево"/.test(tag));
  assert.ok(sheetTag, "main tree relationship must exist");
  const relId = /r:id="([^"]+)"/.exec(sheetTag)?.[1];
  const relTag = [...relsXml.matchAll(
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Relationship\b[^>]*\/?\s*>/g,
  )]
    .map((match) => match[0])
    .find((tag) => new RegExp(`\\bId="${relId}"`).test(tag));
  const target = /Target="([^"]+)"/.exec(relTag)?.[1]
    .replace(/^\//, "")
    .replace(/^\.\//, "");
  const sheetPath = target.startsWith("xl/") ? target : path.posix.join("xl", target);
  return zip.file(sheetPath).async("string");
}

test("R005-025 actual XLSX contains the bound physical source child and valid outline XML", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-025-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tree = buildTree();
  const outputPath = await materializeActualMainTree(directory, tree);
  const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const values = reopened.worksheets.getItem("01_Сверка_дерево").getRange("A7:AD8").values;

  assert.equal(values[0][0], "S148", "the exact presentation parent remains the financial row");
  assert.match(String(values[0][27]), new RegExp(INTALEV_NODE_ID));
  assert.equal(values[1][13], "Трансляция 0000001782 от 19.03.2026 9:03:39");
  assert.equal(String(values[1][14]), "8");
  assert.equal(values[1][12], "B1617:AG1617");
  assert.equal(values[1][22], 1854);
  assert.match(String(values[1][27]), new RegExp(SOURCE_ROW_ID));

  const xml = await mainTreeXml(outputPath);
  const parent = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?row\b[^>]*\br="7"[^>]*>/.exec(xml)?.[0] ?? "";
  const child = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?row\b[^>]*\br="8"[^>]*>/.exec(xml)?.[0] ?? "";
  assert.match(xml, /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?outlinePr\b[^>]*summaryBelow="0"/);
  assert.match(xml, /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheetView\b[^>]*showOutlineSymbols="1"/);
  assert.match(parent, /outlineLevel="3"/);
  assert.match(parent, /collapsed="1"/);
  assert.doesNotMatch(parent, /hidden="1"/);
  assert.match(child, /outlineLevel="4"/);
  assert.match(child, /hidden="1"/);
});

test("R005-025 binding is exact, proven, fail-closed and deduplicated without losing legacy rows", () => {
  const exact = buildTree({ evidenceRows: [anchorEvidence(), anchorEvidence()] });
  const physical = exact.displayRows.filter((row) =>
    row.kind === "OPERATION" && row.operation.source_row_id === SOURCE_ROW_ID);
  assert.equal(physical.length, 1, "STORNO/REPOST references display one physical source child");
  assert.equal(
    exact.displayRows.filter((row) => row.kind === "OPERATION_REVIEW_HEADER").length,
    1,
  );
  assert.equal(
    exact.displayRows.filter((row) =>
      row.kind === "OPERATION" && String(row.operation.source_row_id).startsWith("LEGACY-"))
      .length,
    39,
    "all legacy unassigned operations remain visible",
  );

  const sameArticleDifferentBranches = buildTree({
    rows: [
      presentationRow({ code: "S-FIRST", nodeId: "INTALEV:OTHER" }),
      presentationRow({ code: "S-BOUND", nodeId: INTALEV_NODE_ID }),
    ],
  });
  const boundIndex = sameArticleDifferentBranches.displayRows.findIndex((row) =>
    row.kind === "OPERATION" && row.operation.source_row_id === SOURCE_ROW_ID);
  assert.equal(sameArticleDifferentBranches.displayRows[boundIndex - 1].financial.code, "S-BOUND");

  const unproven = buildTree({ evidenceRows: [anchorEvidence({ row_type: "AMBIGUOUS_PAIR" })] });
  assert.equal(unproven.displayRows.some((row) => row.operation?.source_row_id === SOURCE_ROW_ID), false);

  const ambiguousIdentity = buildTree({
    rows: [presentationRow({ code: "S-A" }), presentationRow({ code: "S-B" })],
  });
  assert.equal(
    ambiguousIdentity.displayRows.some((row) => row.operation?.source_row_id === SOURCE_ROW_ID),
    false,
    "a non-unique presentation identity remains unbound",
  );
});
