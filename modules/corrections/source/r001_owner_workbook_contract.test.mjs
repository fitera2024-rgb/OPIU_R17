import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

import {
  CORRECTIONS_REGISTRY_TEMPLATE,
  LOADER_HEADERS,
  DISCREPANCY_REGISTRY_TEMPLATE,
  buildCorrectionsRegistryFileName,
  buildDeletionWorkbookFileName,
  buildOwnerUploadFileName,
  buildDisputedOwnerUploadFileName,
  buildDiscrepancyRegistryFileName,
  buildStrictUploadWorkbook,
  candidateActionRows,
  ownerUploadDateLabel,
} from "./correction_engine_r001.mjs";
import {
  LOADER_A_AA_FIELDS,
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";

const engineSource = fs.readFileSync(new URL("./correction_engine_r001.mjs", import.meta.url), "utf8");

test("owner-facing filename for UK9 November keeps exact organization and final-day date", () => {
  const fileName = buildOwnerUploadFileName({
    organization: "ООО Группа компаний Планета",
    sourceDate: "2025-11",
  });
  assert.equal(fileName, "[ООО Группа компаний Планета][30.11.2025]_ОПИУ_ГОТОВО.xlsx");
});

test("owner-facing disputed filenames replace organization quotes with spaces character-for-character", () => {
  assert.equal(
    buildDisputedOwnerUploadFileName({ organization: 'ООО "Группа компаний "Планета"', sourceDate: "2025-11" }),
    "[ООО  Группа компаний  Планета][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
  );
  assert.equal(
    buildDisputedOwnerUploadFileName({ organization: 'ООО "Планета Инноваций"', sourceDate: "2025-11" }),
    "[ООО  Планета Инноваций][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
  );
  assert.equal(
    buildDisputedOwnerUploadFileName({ organization: "ГК", sourceDate: "2025-11" }),
    "[ГК][30.11.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
  );
});

test("owner upload filename for ranged periods uses final month end date", () => {
  assert.equal(ownerUploadDateLabel("2025-09..2025-11"), "30.11.2025");
  assert.equal(ownerUploadDateLabel("2025-11"), "30.11.2025");
});

test("owner upload workbook preserves ZAGRUZKA_AA sheet and A:AA contract headers", () => {
  assert.match(engineSource, /addSheet\(workbook, "Загрузка_A_AA"\)/);
  assert.match(engineSource, /writeMatrix\(loader, 0, 0, \[LOADER_HEADERS\]\)/);
  assert.equal(LOADER_HEADERS.length, 27);
});

test("strict workbook writer rejects legacy arrays and reopens with exact canonical headers and values", async () => {
  const source = {
    source_organization: "ООО Источник",
    source_row_id: "ERP-ROW-1",
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Статья", "Проект", "ЦФО"],
    credit_analytics: ["Сотрудник", "Договор", "ЦФО"],
    debit_department: "Подразделение Дт",
    credit_department: "Подразделение Кт",
    amount: 125,
  };
  const accounting = {
    debit: source.debit,
    credit: source.credit,
    debit_analytics: source.debit_analytics,
    credit_analytics: source.credit_analytics,
    debit_department: source.debit_department,
    credit_department: source.credit_department,
    article: "Статья",
  };
  const materializationCase = createMaterializationCase({
    case_id: "CASE-WRITER",
    pair_id: "PAIR-WRITER",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action: "STORNO",
    role: "STANDALONE",
    signed_economic_effect: -125,
    correction_amount: 125,
    economic: {},
    proof_status: "INCOMPLETE",
    correction_allowed: false,
    correction_authority: "REVIEW_REQUIRED",
    output_route: "SPORNO",
    physical_source: source,
    target_accounting: accounting,
    analytical_basis: {},
    economic_route: {},
    source_scope: {},
    reason: "writer contract",
    blockers: ["REVIEW_REQUIRED"],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  });
  const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, null]));
  Object.assign(loader, {
    "СчетДт": "26",
    "СчетКт": "70.1",
    "ВидОперации": "STORNO",
    "ПодразделениеДт": "Подразделение Дт",
    "ПодразделениеКт": "Подразделение Кт",
    "СуммаВВалютеУчета": 125,
    "СуммаВВалютеОтчетности": 125,
    "Содержание": "Canonical writer test",
    "СчетДтИсточник": "26",
    "СчетКтИсточник": "70.1",
    "ИдентификаторФинЗаписи": "ERP-ROW-1",
    "СубконтоДт1": "Статья",
    "СубконтоДт2": "Проект",
    "СубконтоДт3": "ЦФО",
    "СубконтоКт1": "Сотрудник",
    "СубконтоКт2": "Договор",
    "СубконтоКт3": "ЦФО",
  });
  const canonicalRow = createCanonicalPostingRow({
    materialization_case: materializationCase,
    operation: "STORNO",
    output_route: "SPORNO",
    materialization_state: "MATERIALIZED_SPORNO",
    audit_identity: "AUDIT-WRITER",
    amount: 125,
    result_accounting: accounting,
    loader,
    safety: REPORT_ONLY_SAFETY,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opiu-r001-canonical-writer-"));
  const outputPath = path.join(root, "canonical.xlsx");
  try {
    await assert.rejects(buildStrictUploadWorkbook([["legacy"]], outputPath), /CANONICAL_POSTING_ROWS_REQUIRED/);
    const record = await buildStrictUploadWorkbook([canonicalRow], outputPath);
    assert.deepEqual(record.rows[0].loader_values, canonicalRow.loader_values);
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
    const values = workbook.worksheets.getItem("Загрузка_A_AA").getUsedRange().values;
    assert.deepEqual(values[0], [...LOADER_A_AA_FIELDS]);
    assert.deepEqual(values[1], canonicalRow.loader_values);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner-facing upload filename does not use technical numeric prefixes", () => {
  const fileName = buildOwnerUploadFileName({
    organization: "ООО Группа компаний Планета",
    sourceDate: "2025-11",
  });
  assert.match(fileName, /^\[/);
  assert.doesNotMatch(fileName, /^[0-9]{2}_/);
  assert.doesNotMatch(fileName, /(^|\b)(01|02|04|08|10)_/);
});

test("deletion workbook filename uses exact owner-facing R005 contract", () => {
  const fileName = buildDeletionWorkbookFileName("2025-11");
  assert.equal(fileName, "Удаление_операций_ОПИУ_УК_2025_R005.xlsx");
  assert.match(fileName, /^Удаление_операций_ОПИУ_УК_\d{4}_R005\.xlsx$/);
  assert.doesNotMatch(fileName, /^[0-9]{2}_/);
  assert.doesNotMatch(fileName, /\.[0-9]{2}\.[0-9]{2}\.[0-9]{4}/);
  assert.doesNotMatch(fileName, /delete\.xlsx$/i);
  assert.doesNotMatch(fileName, /_DRAFT_R001/);
});

test("owner-facing report path still keeps hard report-only gates", () => {
  assert.match(engineSource, /posting_rows:\s*0/);
  assert.match(engineSource, /live_executable_rows:\s*0/);
  assert.match(engineSource, /execution_allowed:\s*false/);
  assert.match(engineSource, /ready_to_upload:\s*false/);
  assert.match(engineSource, /release_allowed:\s*false/);
  assert.match(engineSource, /live_1c_allowed:\s*false/);
});

test("rules application UNPROVEN with exact source structure produces SPORNO draft rows only", () => {
  const result = candidateActionRows([
    {
      decision_type: "STORNO_REPOST",
      proof_status: "UNPROVEN",
      approval_state: "ПРЕДЛОЖЕНО",
      case_id: "CASE-1",
      pair_id: "PAIR-1",
      period: "2025-11",
      organization: "ООО Группа компаний Планета",
      source_range: "Документ/Лист/15",
      source_date: "30.11.2025",
      registrar: "Документ 1",
      posting_number: "7",
      source_row_id: "ERP-FIN-CASE-1",
      source_dt: "68.2",
      source_kt: "51",
      source_analytics_dt1: "Аналитика",
      source_analytics_kt1: "Аналитика",
      source_department_dt: "ДЕП",
      source_department_kt: "ДЕП",
      target_dt: "68.1",
      target_kt: "70.02",
      target_analytics_dt1: "Тарг",
      target_analytics_kt1: "Тарг",
      target_department_dt: "ДЕП",
      target_department_kt: "ДЕП",
      correction_amount: 93588,
      reason: "Тест",
      solution: "Тест",
    },
  ]);
  assert.equal(result.uploadRows.length, 2);
  assert.equal(result.uploadRows[0][18], "ERP-FIN-CASE-1");
  assert.match(result.uploadRows[0][15], /Статус проверки: требуется подтверждение пользователя/i);
  assert.equal(result.blockers.length, 1);
});

test("rules application PROVEN keeps disputed posting rows", () => {
  const result = candidateActionRows([
    {
      decision_type: "STORNO_REPOST",
      proof_status: "PROVEN",
      approval_state: "ПРЕДЛОЖЕНО",
      case_id: "CASE-2",
      pair_id: "PAIR-2",
      period: "2025-11",
      organization: "ООО Группа компаний Планета",
      source_range: "Документ/Лист/15",
      source_date: "30.11.2025",
      registrar: "Документ 1",
      posting_number: "7",
      source_row_id: "ERP-FIN-CASE-2",
      source_dt: "68.2",
      source_kt: "51",
      source_analytics_dt1: "Аналитика",
      source_analytics_kt1: "Аналитика",
      source_department_dt: "ДЕП",
      source_department_kt: "ДЕП",
      target_dt: "68.1",
      target_kt: "70.02",
      target_analytics_dt1: "Тарг",
      target_analytics_kt1: "Тарг",
      target_department_dt: "ДЕП",
      target_department_kt: "ДЕП",
      correction_amount: 93588,
      reason: "Тест",
      solution: "Тест",
    },
  ]);
  assert.equal(result.uploadRows.length, 2);
});

test("unproven one-side without exact financial identity is blocked without an invented row", () => {
  const result = candidateActionRows([{
    decision_type: "ADD_ONE_SIDE", proof_status: "UNPROVEN", approval_state: "ПРЕДЛОЖЕНО",
    case_id: "CASE-ONE", pair_id: "PAIR-ONE_SIDE-1", period: "2025-11",
    organization: "ООО Источник", source_range: "B15:AG15", source_date: "30.11.2025",
    registrar: "Документ 1", posting_number: "7", correction_amount: 125,
    target_dt: "26", target_kt: "76.5", target_analytics_dt1: "Статья",
    target_analytics_kt1: "Контрагент", target_department_dt: "ДЕП", target_department_kt: "ДЕП",
    gap_evidence_ref: "GAP-1",
  }]);
  assert.equal(result.uploadRows.length, 0);
  assert.match(result.pairRows[0][14], /идентификатора финансовой записи/);
});

test("unproven exact DELETE is materialized only in the SPORNO deletion registry", () => {
  const result = candidateActionRows([{
    decision_type: "DELETE_POSTING", proof_status: "UNPROVEN", approval_state: "ПРЕДЛОЖЕНО",
    case_id: "CASE-DEL", pair_id: "PAIR-DEL-1", period: "2025-11",
    organization: "ООО Источник", source_range: "B15:AG15", source_rows: "B15:AG15",
    source_row_id: "ERP-FIN-DEL-1", source_date: "30.11.2025", registrar: "Операция МСФО 1",
    posting_number: "7", delete_document_type: "Операция МСФО", delete_document_number: "1",
    keep_document_number: "2", delete_posting_number: "7", effect_sha256: "A".repeat(64),
    source_dt: "26", source_kt: "76.5", source_analytics_dt1: "Статья",
    source_analytics_kt1: "Контрагент", correction_amount: 125, reason: "Дубликат",
  }]);
  assert.equal(result.uploadRows.length, 0);
  assert.equal(result.deletionPostings.length, 1);
  assert.equal(result.deletionPostings[0][0], "DELETE_POSTING_СПОРНО");
  assert.equal(result.deletionPostings[0][18], false);
  assert.equal(result.deletionPostings[0][19], false);
  assert.equal(result.deletionPostings[0][20], false);
});

test("owner-facing registry names for R005", () => {
  assert.equal(buildCorrectionsRegistryFileName("2025-11"), "Реестр_корректировок_ОПИУ_УК_2025_R005.xlsx");
  assert.equal(CORRECTIONS_REGISTRY_TEMPLATE, "Реестр_корректировок_ОПИУ_УК_YEAR_R005.xlsx");
  assert.equal(buildDiscrepancyRegistryFileName("2025-11"), "Реестр_проводок_расхождений_ОПИУ_2025-11_R005.xlsx");
  assert.equal(DISCREPANCY_REGISTRY_TEMPLATE, "Реестр_проводок_расхождений_ОПИУ_PERIOD_R005.xlsx");
});

test("deletion workbook contract keeps mandatory sheets", () => {
  assert.match(engineSource, /addSheet\(workbook, "Удаление_операций"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Удаление_проводок"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Проводки_доказательство"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Контроль"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Проверка_ID"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Уже_неактивны"\)/);
  assert.match(engineSource, /addSheet\(workbook, "Источники"\)/);
});
