import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

import {
  LOADER_A_AA_FIELDS,
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import {
  canonicalOutputFilename,
  canonicalSpornoRowFromMaterializationCase,
  collectCanonicalFinancialOutput,
  verifyCanonicalOutputIntegrity,
} from "./r001_canonical_output_contract.mjs";
import {
  buildDisputedOwnerUploadFileName,
  buildStrictUploadWorkbook,
} from "./correction_engine_r001.mjs";

const SHA_A = "A".repeat(64);
const SHA_B = "B".repeat(64);
const EXPECTED_HEADERS = Object.freeze([
  "СчетДт", "СчетКт", "ВалютаДт", "ВалютаКт", "ВидОперации",
  "ПодразделениеДт", "ПодразделениеКт", "НаправлениеДеятельностиДт",
  "НаправлениеДеятельностиКт", "СуммаВВалютеУчета",
  "СуммаВВалютеОтчетности", "СуммаВВалютеДт", "СуммаВВалютеКт",
  "КоличествоДт", "КоличествоКт", "Содержание", "СчетДтИсточник",
  "СчетКтИсточник", "ИдентификаторФинЗаписи", "ПравилоДт", "ПравилоКт",
  "СубконтоДт1", "СубконтоДт2", "СубконтоДт3", "СубконтоКт1",
  "СубконтоКт2", "СубконтоКт3",
]);

function physicalSource(overrides = {}) {
  return {
    source_organization: "Точная ERP организация",
    source_archive_path: "erp.zip",
    source_archive_sha256: SHA_A,
    journal_entry: "journal.xlsx",
    journal_sha256: SHA_B,
    source_sheet: "Лист_1",
    source_range: "B12:AG12",
    source_row_id: "ERP-ROW-12",
    date: "31.01.2025",
    document: "Документ 12",
    posting_number: "4",
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Статья", "Проект", "ЦФО"],
    credit_analytics: ["Сотрудник", "Договор", "ЦФО"],
    debit_department: "Подразделение Дт",
    credit_department: "Подразделение Кт",
    amount: 125,
    activity: "Да",
    scenario: "Факт",
    ...overrides,
  };
}

function accounting(source, operation) {
  if (operation === "STORNO") return {
    debit: source.debit ?? "",
    credit: source.credit ?? "",
    debit_analytics: source.debit_analytics ?? ["", "", ""],
    credit_analytics: source.credit_analytics ?? ["", "", ""],
    debit_department: source.debit_department ?? "",
    credit_department: source.credit_department ?? "",
    article: "",
  };
  return {
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Целевая статья", "Проект", "ЦФО"],
    credit_analytics: ["Сотрудник", "Договор", "ЦФО"],
    debit_department: "Подразделение Дт",
    credit_department: "Подразделение Кт",
    article: "Целевая статья",
  };
}

function materializationCase({
  operation = "STORNO",
  route = "READY",
  source = physicalSource(),
  id = "A",
} = {}) {
  return createMaterializationCase({
    case_id: `CASE-${id}`,
    pair_id: `PAIR-${id}`,
    period: "2025-01",
    reconciliation_organization: "9 Управляющая компания",
    action: operation,
    role: operation === "STORNO" ? "RECLASS_SOURCE" : "RECLASS_TARGET",
    signed_economic_effect: operation === "STORNO" ? -125 : 125,
    correction_amount: 125,
    economic: {
      source_code: "SOURCE",
      target_code: "TARGET",
      source_article: "Исходная статья",
      target_article: "Целевая статья",
    },
    proof_status: route === "READY" ? "PROVEN" : "PHYSICAL_SOURCE_INCOMPLETE",
    correction_allowed: route === "READY",
    correction_authority: route === "READY" ? "EXACT_SOURCE" : "REVIEW_REQUIRED",
    output_route: route,
    physical_source: source,
    target_accounting: accounting(source, operation),
    physical_proof: {
      declared: true,
      source_operation_proven: true,
      physical_source_unique: true,
      pinned_source_reopened: true,
      source_reuse_checked: true,
      target_classification_proven: true,
    },
    analytical_basis: {},
    economic_route: { accepted: true, proof_status: "ECONOMIC_RECLASS_PROVEN" },
    source_scope: {},
    reason: "Owner contract physical output test",
    blockers: route === "SPORNO" ? ["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY"] : [],
    provenance: { source: "OWNER_CONTRACT_GOLDEN" },
    safety: REPORT_ONLY_SAFETY,
  });
}

function loaderFor(materialization, operation) {
  const source = materialization.physical_source;
  const result = accounting(source, operation);
  const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, null]));
  Object.assign(loader, {
    "СчетДт": result.debit || null,
    "СчетКт": result.credit || null,
    "ВидОперации": operation,
    "ПодразделениеДт": result.debit_department || null,
    "ПодразделениеКт": result.credit_department || null,
    "СуммаВВалютеУчета": 125,
    "СуммаВВалютеОтчетности": 125,
    "Содержание": `Операция ${operation}: исправление доказанной классификации ERP`,
    "СчетДтИсточник": source.debit || null,
    "СчетКтИсточник": source.credit || null,
    "ИдентификаторФинЗаписи": source.source_row_id || null,
    "СубконтоДт1": result.debit_analytics[0] || null,
    "СубконтоДт2": result.debit_analytics[1] || null,
    "СубконтоДт3": result.debit_analytics[2] || null,
    "СубконтоКт1": result.credit_analytics[0] || null,
    "СубконтоКт2": result.credit_analytics[1] || null,
    "СубконтоКт3": result.credit_analytics[2] || null,
  });
  return { loader, result };
}

function readyRow({ operation = "STORNO", id = "READY" } = {}) {
  const materialization = materializationCase({ operation, id });
  const { loader, result } = loaderFor(materialization, operation);
  return createCanonicalPostingRow({
    materialization_case: materialization,
    operation,
    output_route: "READY",
    materialization_state: "MATERIALIZED_READY",
    audit_identity: `AUDIT-${id}`,
    amount: 125,
    result_accounting: result,
    loader,
    safety: REPORT_ONLY_SAFETY,
  });
}

function workbookRecords(output) {
  return output.groups.map((group) => ({
    output_route: group.output_route,
    source_organization: group.source_organization,
    period: group.period,
    destination_filename: group.destination_filename,
    rows: group.rows.map((row) => ({
      audit_identity: row.audit_identity,
      loader_values: [...row.loader_values],
    })),
  }));
}

test("complete exact physical ERP source is READY while every live/posting gate stays closed", () => {
  const row = readyRow();
  assert.equal(row.output_route, "READY");
  assert.equal(row.source.source_row_id, "ERP-ROW-12");
  assert.equal(row.loader["ИдентификаторФинЗаписи"], "ERP-ROW-12");
  assert.deepEqual(row.safety, REPORT_ONLY_SAFETY);
  assert.equal(row.safety.posting_rows, 0);
  assert.equal(row.safety.ready_to_upload, false);
});

test("STORNO is the negative inversion in A:AA while REPOST stays positive", () => {
  const storno = readyRow({ operation: "STORNO", id: "STORNO" });
  const repost = readyRow({ operation: "REPOST", id: "REPOST" });
  assert.equal(storno.loader["СуммаВВалютеУчета"], -125);
  assert.equal(storno.loader["СуммаВВалютеОтчетности"], -125);
  assert.equal(repost.loader["СуммаВВалютеУчета"], 125);
  assert.equal(repost.loader["СуммаВВалютеОтчетности"], 125);
});

test("known-direction incomplete source becomes SPORNO with missing physical fields still empty", () => {
  const source = physicalSource({
    source_organization: "",
    source_row_id: "",
    debit: "",
    credit: "",
    debit_analytics: ["", "", ""],
    credit_analytics: ["", "", ""],
    debit_department: "",
    credit_department: "",
  });
  const materialization = materializationCase({ route: "SPORNO", source, id: "INCOMPLETE" });
  const row = canonicalSpornoRowFromMaterializationCase(materialization);
  assert.equal(row.operation, "STORNO");
  assert.equal(row.output_route, "SPORNO");
  assert.equal(row.source_organization, "");
  assert.equal(row.source.source_row_id, "");
  assert.equal(row.loader["ИдентификаторФинЗаписи"], null);
  assert.equal(row.loader["СчетДт"], null);
  assert.equal(row.loader["СчетКт"], null);
  assert.equal(row.reconciliation_organization, "9 Управляющая компания");
  assert.equal(row.source_organization === row.reconciliation_organization, false);
});

test("unknown source organization uses the exact owner-visible filename label and never report scope", () => {
  assert.equal(canonicalOutputFilename({ output_route: "SPORNO", source_organization: "", period: "2025-01" }),
    "[ИСТОЧНИК НЕ ОПРЕДЕЛЕН][31.01.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx");
  assert.equal(buildDisputedOwnerUploadFileName({ organization: "", sourceDate: "2025-01" }),
    "[ИСТОЧНИК НЕ ОПРЕДЕЛЕН][31.01.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx");
});

test("directionless ADD_ONE_SIDE cannot become a STORNO or REPOST row", () => {
  assert.throws(() => createMaterializationCase({
    ...materializationCase({ route: "SPORNO", id: "DIRECTIONLESS" }),
    action: "ADD_ONE_SIDE",
  }), { code: "FINANCIAL_ACTION_DIRECTION_MISSING" });
});

test("READY and SPORNO are separate canonical destinations with one immutable row set hash", () => {
  const ready = readyRow();
  const sporno = canonicalSpornoRowFromMaterializationCase(materializationCase({
    operation: "REPOST",
    route: "SPORNO",
    source: physicalSource({
      source_range: "B13:AG13",
      source_row_id: "ERP-ROW-13",
      posting_number: "5",
    }),
    id: "SPORNO",
  }));
  const output = collectCanonicalFinancialOutput([ready, sporno]);
  assert.deepEqual(output.headers, EXPECTED_HEADERS);
  assert.equal(output.groups.length, 2);
  assert.deepEqual(output.groups.map((group) => group.output_route).sort(), ["READY", "SPORNO"]);
  assert.match(output.canonical_row_set_sha256, /^[A-F0-9]{64}$/);
  assert.equal(output.counters.posting_rows, 0);
  assert.equal(output.counters.canonical_financial_rows_total, 2);
  assert.equal(verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords(output) }).result, "PASS");
});

test("actual READY and SPORNO workbooks reopen with one sheet, exact A:AA headers and numeric money", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-owner-output-contract-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const ready = readyRow();
  const sporno = canonicalSpornoRowFromMaterializationCase(materializationCase({
    operation: "REPOST",
    route: "SPORNO",
    id: "SPORNO-XLSX",
  }));
  for (const [name, row] of [["ready.xlsx", ready], ["sporno.xlsx", sporno]]) {
    const outputPath = path.join(root, name);
    await buildStrictUploadWorkbook([row], outputPath);
    const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
    assert.deepEqual(reopened.worksheets.items.map((sheet) => sheet.name), ["Загрузка_A_AA"]);
    const values = reopened.worksheets.getItem("Загрузка_A_AA").getUsedRange().values;
    assert.deepEqual(values[0], EXPECTED_HEADERS);
    assert.equal(typeof values[1][9], "number");
    assert.equal(typeof values[1][10], "number");
  }
});
