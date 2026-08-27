import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

import {
  hasIntalevParentChildEdge,
  intalevCatalogSourcesStatus,
  parseIntalevArticleCatalog,
  parseIntalevDeletionMark,
  selectIntalevWorkbookCatalogSheet,
} from "./opiu_reconcile.mjs";

function validSheet(sheet, sheetIndex, extra = {}) {
  return {
    source_file: "classifier.xlsx",
    sheet,
    sheet_index: sheetIndex,
    entries: [
      { identity: "ROOT", parent_identity: "", label: "Root" },
      { identity: "CHILD", parent_identity: "ROOT", label: "Child" },
    ],
    hierarchy_tree: { status: "PASS", blockers: [], nodes: [] },
    structured_parent_export: true,
    uid_schema_exported: true,
    deletion_status_exported: true,
    parent_child_edge_count: 1,
    excluded_deleted_rows: 0,
    semantic_schema_score: 5,
    ...extra,
  };
}

function invalidSheet(sheet, sheetIndex, extra = {}) {
  return {
    source_file: "classifier.xlsx",
    sheet,
    sheet_index: sheetIndex,
    entries: [],
    hierarchy_tree: {
      status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
      blockers: [{ code: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED" }],
      nodes: [],
    },
    structured_parent_export: false,
    uid_schema_exported: false,
    deletion_status_exported: false,
    parent_child_edge_count: 0,
    excluded_deleted_rows: 0,
    semantic_schema_score: 0,
    ...extra,
  };
}

function addValidClassifierSheet(workbook, name) {
  const sheet = workbook.worksheets.add(name);
  sheet.getRange("A1:D3").values = [
    ["UUID", "UUIDРодителя", "Наименование", "ПометкаУдаления"],
    ["ROOT", "", "Root", false],
    ["CHILD", "ROOT", "Child", false],
  ];
  return sheet;
}

async function withWorkbook(testBody) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-intalev-workbook-"));
  try {
    return await testBody(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function saveWorkbook(workbook, filePath) {
  await (await SpreadsheetFile.exportXlsx(workbook)).save(filePath);
}

test("workbook selection ignores invalid first sheet and selects the unique valid second sheet", () => {
  const result = selectIntalevWorkbookCatalogSheet([
    invalidSheet("Инструкция", 0),
    validSheet("Статьи БДР", 1),
  ], "classifier.xlsx");

  assert.equal(result.workbook_selection.status, "PASS_UNIQUE_SEMANTIC_CLASSIFIER_SHEET");
  assert.equal(result.workbook_selection.valid_sheet_count, 1);
  assert.equal(result.workbook_selection.selected_sheet, "Статьи БДР");
  assert.equal(result.sheet_index, 1);
  assert.equal(result.workbook_selection.inspected_sheets.length, 2);
});

test("parser inspects the complete workbook and accepts invalid-first/valid-second", async () => {
  await withWorkbook(async (directory) => {
    const workbook = Workbook.create();
    const cover = workbook.worksheets.add("Инструкция");
    cover.getRange("A1:B2").values = [["Описание", "Версия"], ["Не классификатор", "1"]];
    addValidClassifierSheet(workbook, "Статьи БДР");
    const filePath = path.join(directory, "classifier.xlsx");
    await saveWorkbook(workbook, filePath);

    const parsed = await parseIntalevArticleCatalog(directory, filePath, "invalid_first");
    assert.equal(parsed.sheet, "Статьи БДР");
    assert.equal(parsed.sheet_index, 1);
    assert.equal(parsed.structured_parent_export, true, JSON.stringify(parsed, null, 2));
    assert.equal(parsed.hierarchy_tree.status, "PASS");
    assert.equal(parsed.workbook_selection.inspected_sheets.length, 2);
  });
});

test("two valid sheets are ambiguous even when one is hidden", () => {
  const result = selectIntalevWorkbookCatalogSheet([
    validSheet("Статьи БДР", 0),
    validSheet("Скрытая копия", 1, { hidden: true }),
  ], "classifier.xlsx");

  assert.equal(result.workbook_selection.status, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE");
  assert.equal(result.workbook_selection.valid_sheet_count, 2);
  assert.equal(result.workbook_selection.selected_sheet, null);
  assert.equal(result.structured_parent_export, false);
  assert.equal(result.hierarchy_tree.status, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE");
  assert.deepEqual(
    result.hierarchy_tree.blockers[0].sheets.map((item) => item.sheet),
    ["Статьи БДР", "Скрытая копия"],
  );
});

test("parser counts a hidden valid sheet and blocks workbook ambiguity", async () => {
  await withWorkbook(async (directory) => {
    const workbook = Workbook.create();
    addValidClassifierSheet(workbook, "Статьи БДР");
    addValidClassifierSheet(workbook, "Скрытая копия");
    const filePath = path.join(directory, "classifier-hidden.xlsx");
    await saveWorkbook(workbook, filePath);
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    const workbookXml = await zip.file("xl/workbook.xml").async("string");
    const hiddenWorkbookXml = workbookXml.replace(
      /(<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*name="Скрытая копия"[^>]*?)(\s*\/>)/,
      '$1 state="hidden"$2',
    );
    assert.match(hiddenWorkbookXml, /name="Скрытая копия"[^>]*state="hidden"/);
    zip.file("xl/workbook.xml", hiddenWorkbookXml);
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

    const parsed = await parseIntalevArticleCatalog(directory, filePath, "hidden_ambiguity");
    assert.equal(
      parsed.workbook_selection.status,
      "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE",
      JSON.stringify(parsed, null, 2),
    );
    assert.equal(parsed.workbook_selection.valid_sheet_count, 2);
    assert.deepEqual(
      parsed.hierarchy_tree.blockers[0].sheets.map((item) => item.sheet),
      ["Статьи БДР", "Скрытая копия"],
    );
  });
});

test("a schema-shaped flat sheet is not a valid UID classifier", () => {
  const flat = validSheet("Flat", 0, {
    entries: [{ identity: "ROOT", parent_identity: "", label: "Root" }],
    parent_child_edge_count: 0,
  });
  const result = selectIntalevWorkbookCatalogSheet([flat], "classifier.xlsx");

  assert.equal(result.workbook_selection.valid_sheet_count, 0);
  assert.equal(result.workbook_selection.status, "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED");
  assert.equal(result.structured_parent_export, false);
});

test("parent-child proof requires a referenced active parent, not just a parent value", () => {
  assert.equal(hasIntalevParentChildEdge([
    { identity: "ROOT", parent_identity: "" },
    { identity: "CHILD", parent_identity: "ROOT" },
  ]), true);
  assert.equal(hasIntalevParentChildEdge([
    { identity: "ONLY", parent_identity: "MISSING" },
  ]), false);
  assert.equal(hasIntalevParentChildEdge([
    { identity: "ROOT", parent_identity: "00000000-0000-0000-0000-000000000000" },
  ]), false);
});

test("deletion status accepts explicit boolean conventions and rejects unknown values", () => {
  assert.deepEqual(parseIntalevDeletionMark(false), { valid: true, deleted: false });
  assert.deepEqual(parseIntalevDeletionMark("Нет"), { valid: true, deleted: false });
  assert.deepEqual(parseIntalevDeletionMark(1), { valid: true, deleted: true });
  assert.deepEqual(parseIntalevDeletionMark("Истина"), { valid: true, deleted: true });
  assert.deepEqual(parseIntalevDeletionMark("не определено"), {
    valid: false,
    deleted: null,
  });
});

test("parser blocks missing/unknown deletion status and excludes explicitly deleted rows", async () => {
  await withWorkbook(async (directory) => {
    const missingWorkbook = Workbook.create();
    const missing = missingWorkbook.worksheets.add("Missing deletion");
    missing.getRange("A1:C3").values = [
      ["UUID", "UUIDРодителя", "Наименование"],
      ["ROOT", "", "Root"],
      ["CHILD", "ROOT", "Child"],
    ];
    const missingPath = path.join(directory, "missing-deletion.xlsx");
    await saveWorkbook(missingWorkbook, missingPath);
    const missingParsed = await parseIntalevArticleCatalog(
      directory,
      missingPath,
      "missing_deletion",
    );
    assert.equal(missingParsed.structured_parent_export, false);
    assert.ok(
      missingParsed.hierarchy_tree.blockers.some(
        (item) => item.code === "BLOCKED_INTALEV_CATALOG_DELETION_MARK_NOT_EXPORTED",
      ),
    );

    const unknownWorkbook = Workbook.create();
    const unknown = unknownWorkbook.worksheets.add("Unknown deletion");
    unknown.getRange("A1:D3").values = [
      ["UUID", "UUIDРодителя", "Наименование", "ПометкаУдаления"],
      ["ROOT", "", "Root", false],
      ["CHILD", "ROOT", "Child", "не определено"],
    ];
    const unknownPath = path.join(directory, "unknown-deletion.xlsx");
    await saveWorkbook(unknownWorkbook, unknownPath);
    const unknownParsed = await parseIntalevArticleCatalog(
      directory,
      unknownPath,
      "unknown_deletion",
    );
    assert.equal(unknownParsed.structured_parent_export, false);
    assert.ok(
      unknownParsed.hierarchy_tree.blockers.some(
        (item) => item.code === "BLOCKED_INTALEV_CATALOG_DELETION_MARK_INVALID",
      ),
    );

    const deletedWorkbook = Workbook.create();
    const deleted = deletedWorkbook.worksheets.add("Deleted exclusion");
    deleted.getRange("A1:D4").values = [
      ["UUID", "UUIDРодителя", "Наименование", "ПометкаУдаления"],
      ["ROOT", "", "Root", false],
      ["ACTIVE", "ROOT", "Active", false],
      ["DELETED", "ROOT", "Deleted", true],
    ];
    const deletedPath = path.join(directory, "deleted-exclusion.xlsx");
    await saveWorkbook(deletedWorkbook, deletedPath);
    const deletedParsed = await parseIntalevArticleCatalog(
      directory,
      deletedPath,
      "deleted_exclusion",
    );
    assert.equal(deletedParsed.structured_parent_export, true);
    assert.equal(deletedParsed.excluded_deleted_rows, 1);
    assert.deepEqual(deletedParsed.entries.map((entry) => entry.identity), ["ROOT", "ACTIVE"]);
  });
});

test("Code and IsGroup are not silently promoted to UID-role requirements", () => {
  const withoutOptionalColumns = validSheet("Статьи БДР", 0);
  assert.equal("code" in withoutOptionalColumns, false);
  assert.equal("is_group" in withoutOptionalColumns, false);
  const result = selectIntalevWorkbookCatalogSheet([withoutOptionalColumns]);
  assert.equal(result.workbook_selection.status, "PASS_UNIQUE_SEMANTIC_CLASSIFIER_SHEET");
});

test("Sources status is fail-closed when discovery found zero semantic candidates", () => {
  const zeroCandidate = invalidSheet("Legacy", 0, {
    workbook_selection: {
      status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
      valid_sheet_count: 0,
    },
  });
  assert.equal(
    intalevCatalogSourcesStatus(zeroCandidate),
    "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
  );
  assert.equal(intalevCatalogSourcesStatus(validSheet("Статьи БДР", 0)),
    "ACTIVE_STRUCTURAL_CLASSIFIER");
});
