import assert from "node:assert/strict";
import test from "node:test";
import {
  economicActionClass,
  materializeExactSourceRow,
  materializeOwnerEconomicDrafts,
  materializeSparseEconomicDrafts,
  parseCandidateTrace,
  selectExactSourceSubset,
} from "./r001_sporno_materialization.mjs";
import { LOADER_HEADERS, buildDisputedOwnerUploadFileName, candidateActionRows } from "./correction_engine_r001.mjs";
import { REPORT_ONLY_SAFETY, createMaterializationCase } from "./r001_materialization_contract.mjs";

const EXPECTED_HEADERS = [
  "СчетДт", "СчетКт", "ВалютаДт", "ВалютаКт", "ВидОперации", "ПодразделениеДт", "ПодразделениеКт",
  "НаправлениеДеятельностиДт", "НаправлениеДеятельностиКт", "СуммаВВалютеУчета", "СуммаВВалютеОтчетности",
  "СуммаВВалютеДт", "СуммаВВалютеКт", "КоличествоДт", "КоличествоКт", "Содержание", "СчетДтИсточник",
  "СчетКтИсточник", "ИдентификаторФинЗаписи", "ПравилоДт", "ПравилоКт", "СубконтоДт1", "СубконтоДт2",
  "СубконтоДт3", "СубконтоКт1", "СубконтоКт2", "СубконтоКт3",
];

function raw(overrides = {}) {
  return {
    source_range: "B100:AG100", source_row_id: "A".repeat(64), date: "30.11.2025 23:59:59",
    document: "Операция МСФО 1", posting_no: 7, activity: "Да", scenario: "Факт",
    debit: "26", credit: "70.1", debit_currency: "RUB", credit_currency: "RUB",
    debit_department: "ГК Административный отдел", credit_department: "ГК Административный отдел",
    debit_direction: "Основная", credit_direction: "Основная", amount_accounting: -8000, amount: -8000,
    debit_currency_amount: -8000, credit_currency_amount: -8000, debit_quantity: -2, credit_quantity: -2,
    operation_kind: "Трансляция", content: "Исходное содержание", organization: "ООО Источник",
    debit_analytics_1: "ФЗП", debit_analytics_2: "Проект 1", debit_analytics_3: "ЦФО 1",
    credit_analytics_1: "Сотрудник", credit_analytics_2: "Договор", credit_analytics_3: "ЦФО 2",
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    raw: raw(), operation: "REPOST", partCents: 800000, sourceCode: "R036", sourceLabel: "ФЗП",
    targetCode: "R035", targetLabel: "НДФЛ", reconciliationOrganization: "9 Управляющая компания",
    decision: { case_id: "CASE-1", pair_id: "PAIR-1", period: "2025-11", proof_status: "UNPROVEN", reason: "owner decision" },
    source: { archive_path: "erp.zip", archive_sha256: "B".repeat(64), journal_entry: "journal.xlsx", journal_sha256: "C".repeat(64), journal_sheet: "Лист_1" },
    subset: { unique: false, solution_count: 2 },
    ...overrides,
  };
}

test("1. action classes separate posting, delete, one-side and non-financial decisions", () => {
  assert.equal(economicActionClass("STORNO_REPOST"), "STORNO_REPOST");
  assert.equal(economicActionClass("DELETE_POSTING"), "DELETE");
  assert.equal(economicActionClass("ADD_ONE_SIDE"), "ONE_SIDE");
  assert.equal(economicActionClass("UPDATE_MAPPING"), "NO_FINANCIAL_POSTING");
});

test("2. candidate trace retains exact source identity fields", () => {
  const trace = parseCandidateTrace("Period=2025-11; ArticleOwners=R036; SourceRowID=ABC; JournalSHA=DEF; JournalInput=C:\\erp.zip; JournalEntry=journal.xlsx");
  assert.deepEqual(trace.articleOwners, ["R036"]);
  assert.equal(trace.SourceRowID, "ABC");
  assert.equal(trace.JournalInput, "C:\\erp.zip");
});

test("3. exact-cent selection rejects approximate sums", () => {
  const result = selectExactSourceSubset([{ amount: 10.01, source_ref: "B1" }, { amount: 9.98, source_ref: "B2" }], 20);
  assert.equal(result.rows.length, 0);
});

test("4. exact subset prefers the minimum row count", () => {
  const result = selectExactSourceSubset([{ amount: 40, source_ref: "B1" }, { amount: 60, source_ref: "B2" }, { amount: 100, source_ref: "B3" }], 100);
  assert.deepEqual(result.rows.map((row) => row.source_ref), ["B3"]);
});

test("5. ambiguous exact subsets are materializable but never marked unique", () => {
  const result = selectExactSourceSubset([{ amount: 40, source_ref: "B1" }, { amount: 60, source_ref: "B2" }, { amount: 30, source_ref: "B3" }, { amount: 70, source_ref: "B4" }], 100);
  assert.equal(result.rows.length, 2);
  assert.equal(result.unique, false);
  assert.equal(result.solution_count, 2);
});

test("6. source selection never mixes opposite signs", () => {
  const result = selectExactSourceSubset([{ amount: -80, source_ref: "B1" }, { amount: 20, source_ref: "B2" }, { amount: 60, source_ref: "B3" }], 100);
  assert.equal(result.rows.length, 0);
});

test("7. owner upload schema is exactly A:AA with no technical columns", () => {
  assert.equal(LOADER_HEADERS.length, 27);
  assert.deepEqual(LOADER_HEADERS, EXPECTED_HEADERS);
});

test("8. positive-source STORNO emits negative loader measures and uses operation kind", () => {
  const source = raw({ amount_accounting: 8000, amount: 8000, debit_currency_amount: 8000, credit_currency_amount: 8000, debit_quantity: 2, credit_quantity: 2 });
  const row = materializeExactSourceRow(context({ raw: source, operation: "STORNO", targetCode: "R036", targetLabel: "ФЗП" }));
  assert.equal(row[4], "STORNO");
  assert.deepEqual([row[9], row[10], row[11], row[12], row[13], row[14]], [-8000, -8000, -8000, -8000, -2, -2]);
});

test("9. negative-source STORNO preserves negative loader measures without changing source dimensions", () => {
  const row = materializeExactSourceRow(context({ operation: "STORNO", targetCode: "R036", targetLabel: "ФЗП" }));
  assert.deepEqual([row[9], row[10], row[11], row[12], row[13], row[14]], [-8000, -8000, -8000, -8000, -2, -2]);
});

test("9a. one physical STORNO and its REPOST close to exact zero", () => {
  const source = raw({ amount_accounting: 8000, amount: 8000, debit_currency_amount: 8000, credit_currency_amount: 8000 });
  const storno = materializeExactSourceRow(context({ raw: source, operation: "STORNO", targetCode: "R036", targetLabel: "ФЗП" }));
  const repost = materializeExactSourceRow(context({ raw: source, operation: "REPOST", partCents: 800000, targetCode: "R035", targetLabel: "НДФЛ" }));
  for (const index of [9, 10, 11, 12]) assert.equal(storno[index] + repost[index], 0);
});

test("10. STORNO preserves accounts, currencies, directions, departments and all subkontos", () => {
  const row = materializeExactSourceRow(context({ operation: "STORNO", targetCode: "R036", targetLabel: "ФЗП" }));
  assert.deepEqual([row[0], row[1], row[2], row[3], row[5], row[6], row[7], row[8]], ["26", "70.1", "RUB", "RUB", "ГК Административный отдел", "ГК Административный отдел", "Основная", "Основная"]);
  assert.deepEqual(row.slice(21), ["ФЗП", "Проект 1", "ЦФО 1", "Сотрудник", "Договор", "ЦФО 2"]);
});

test("11. REPOST changes only the declared classification among accounting dimensions", () => {
  const row = materializeExactSourceRow(context());
  assert.equal(row[21], "НДФЛ");
  assert.deepEqual(row.slice(22), ["Проект 1", "ЦФО 1", "Сотрудник", "Договор", "ЦФО 2"]);
  assert.deepEqual([row[0], row[1], row[5], row[6], row[7], row[8]], ["26", "70.1", "ГК Административный отдел", "ГК Административный отдел", "Основная", "Основная"]);
});

test("12. split REPOST preserves the source identity and allocates exact positive correction cents", () => {
  const row = materializeExactSourceRow(context({ partCents: 150000, targetCode: "R034", targetLabel: "Компенсации" }));
  assert.equal(row[10], 1500);
  assert.equal(row[18], "A".repeat(64));
  assert.equal(row.audit.sourceAmount, -8000);
});

test("13. reconciliation organization and exact ERP source organization never collapse", () => {
  const row = materializeExactSourceRow(context());
  assert.equal(row.audit.reconciliationOrganization, "9 Управляющая компания");
  assert.equal(row.audit.sourceOrganization, "ООО Источник");
  assert.notEqual(row.audit.reconciliationOrganization, row.audit.sourceOrganization);
});

test("14. absent source rules stay blank and are never invented", () => {
  const row = materializeExactSourceRow(context());
  assert.equal(row[19], null);
  assert.equal(row[20], null);
});

test("15. disputed state is visible in filename, content, audit and all live gates remain false", () => {
  const row = materializeExactSourceRow(context());
  assert.match(buildDisputedOwnerUploadFileName({ organization: "ООО Источник", sourceDate: "2025-11" }), /_ОПИУ_ГОТОВО_СПОРНО\.xlsx$/);
  assert.match(row[15], /^Операция REPOST \| ERP:/);
  assert.match(row[15], /Статья: «ФЗП» → «НДФЛ»/);
  assert.doesNotMatch(row[15], /REPORT_ONLY|CaseID|PairID|SourceRowID/);
  assert.equal(row.audit.status, "_СПОРНО");
  assert.equal(row.audit.executionAllowed, false);
  assert.equal(row.audit.live1cAllowed, false);
});

test("15a. adding proven Intalev references changes only business content, never physical loader fields", () => {
  const baseline = materializeExactSourceRow(context());
  const enriched = materializeExactSourceRow(context({
    decision: {
      ...context().decision,
      intalev_references: [{
        proven: true,
        code: "R036",
        source_file: "C:\\proof\\intalev.xlsx",
        sheet: "TDSheet",
        source_cell: "E113",
        full_path: "Расходы на персонал / ФЗП",
      }],
    },
  }));
  assert.notEqual(enriched[15], baseline[15]);
  const withoutContent = (row) => row.map((value, index) => index === 15 ? "<CONTENT>" : value);
  assert.deepEqual(withoutContent(enriched), withoutContent(baseline));
  assert.match(enriched[15], /Инталев: R036: файл «intalev\.xlsx», лист «TDSheet», ячейка E113, путь «Расходы на персонал \/ ФЗП»/);
});

test("16. missing exact source classification blocks instead of inventing a target slot", () => {
  assert.throws(() => materializeExactSourceRow(context({ raw: raw({ debit_analytics_1: "Другая статья" }) })), /not an exact source subkonto/);
});

test("17. R022 UPDATE_MAPPING never creates correction-engine posting rows", () => {
  const decision = {
    case_id: "CASE-R022", pair_id: "PAIR-R022", decision_type: "UPDATE_MAPPING",
    classification: "SOURCE_CLASSIFICATION_GAP", approval_state: "УТВЕРЖДЕНО", proof_status: "PROVEN",
    period: "2025-11", organization: "ООО Источник", source_range: "B100:AG100",
    registrar: "Операция МСФО 1", posting_number: 7, source_row_id: "A".repeat(64),
    source_article_missing: false, source_article: "Орг.техника и комплектующие",
    target_code: "R022", target_article: "Орг.техника и комплектующие",
  };
  const result = candidateActionRows([decision]);
  assert.equal(result.uploadRows.length, 0);
  assert.equal(result.deletionOperations.length, 0);
  assert.equal(result.deletionPostings.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0][14], /SOURCE_CLASSIFICATION_GAP/);
});

test("18. R022 UPDATE_MAPPING materialization is explicitly non-financial", async () => {
  const decision = {
    case_id: "CASE-R022", pair_id: "PAIR-R022", decision_type: "UPDATE_MAPPING",
    classification: "SOURCE_CLASSIFICATION_GAP", source_article_missing: false,
    source_article: "Орг.техника и комплектующие", target_code: "R022",
    target_article: "Орг.техника и комплектующие",
  };
  const result = await materializeOwnerEconomicDrafts({ decisions: [decision] });
  assert.equal(result.materialized_posting_rows, 0);
  assert.equal(result.storno_rows, 0);
  assert.equal(result.repost_rows, 0);
  assert.equal(result.cases[0].materialization_state, "NO_FINANCIAL_POSTING");
  assert.equal(result.cases[0].posting_rows, 0);
  assert.equal(result.cases[0].storno_rows, 0);
  assert.equal(result.cases[0].repost_rows, 0);
  assert.equal(result.execution_allowed, false);
  assert.equal(result.live_1c_allowed, false);
});

test("19. exact reclass adapter crosses the canonical posting-row boundary before output", () => {
  const materializationCase = createMaterializationCase({
    case_id: "CASE-1",
    pair_id: "PAIR-1",
    period: "2025-11",
    reconciliation_organization: "9 Управляющая компания",
    action: "REPOST",
    role: "RECLASS_TARGET",
    signed_economic_effect: 8000,
    correction_amount: 8000,
    economic: { source_code: "R036", target_code: "R035", source_article: "ФЗП", target_article: "НДФЛ" },
    proof_status: "PROVEN",
    correction_allowed: true,
    correction_authority: "EXACT_SOURCE",
    output_route: "SPORNO",
    physical_source: {},
    target_accounting: {},
    analytical_basis: {},
    economic_route: {},
    source_scope: {},
    reason: "accepted reclass",
    blockers: [],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  });
  const row = materializeExactSourceRow(context({
    outputRoute: "READY",
    decision: { ...context().decision, proof_status: "PROVEN", correction_allowed: true, materialization_case: materializationCase },
    subset: { unique: true, solution_count: 1 },
  }));
  assert.equal(row.canonical_posting_row.schema_version, "opiu-canonical-posting-row.v1");
  assert.equal(row.canonical_posting_row.output_route, "READY");
  assert.equal(row.canonical_posting_row.materialization_state, "MATERIALIZED_READY");
  assert.equal(row.canonical_posting_row.source_organization, "ООО Источник");
  assert.equal(row.canonical_posting_row.loader_values.length, 27);
  assert.equal(row.canonical_posting_row.loader_values[18], "A".repeat(64));
});

test("20. sparse economic route keeps business content, signed STORNO and blank unproven physical fields", () => {
  const common = {
    case_id: "CASE-SPARSE",
    pair_id: "PAIR-SPARSE",
    period: "2025-10",
    organization: "9 Управляющая компания",
    reconciliation_organization: "9 Управляющая компания",
    decision_type: "STORNO_REPOST",
    approval_state: "ДОКАЗАНО_СВЕРКОЙ",
    accepted_economic_reclass: true,
    ECONOMIC_ROUTE_PROVEN: true,
    output_route: "SPORNO",
    proof_status: "ECONOMIC_RECLASS_PROVEN",
    economic_route_id: "CASE-SPARSE",
  };
  const result = materializeSparseEconomicDrafts({
    decisions: [
      {
        ...common,
        embedded_decision_identity: "CASE-SPARSE|SOURCE",
        role: "RECLASS_SOURCE",
        reconciliation_row: "R100",
        group: "Источник",
        source_article: "Источник",
        analytical_effect: -125,
      },
      {
        ...common,
        embedded_decision_identity: "CASE-SPARSE|TARGET",
        role: "RECLASS_TARGET",
        reconciliation_row: "R200",
        group: "Назначение",
        target_article: "Назначение",
        analytical_effect: 125,
      },
    ],
    reconciliationOrganization: "9 Управляющая компания",
  });
  assert.equal(result.audit.materialized_case_count, 1);
  assert.deepEqual(result.canonical_posting_rows.map((row) => row.operation), ["STORNO", "REPOST"]);
  assert.deepEqual(
    result.canonical_posting_rows.map((row) => row.loader["СуммаВВалютеОтчетности"]),
    [-125, 125],
  );
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["ИдентификаторФинЗаписи"] === null));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /^Операция STORNO \| .*Статья:/);
  assert.match(result.canonical_posting_rows[1].loader["Содержание"], /^Операция REPOST \| .*Статья:/);
  assert.ok(result.canonical_posting_rows.every((row) => !/REPORT_ONLY|CaseID|PairID|SourceRowID/.test(row.loader["Содержание"])));
  assert.ok(result.canonical_posting_rows.every((row) => row.safety.posting_rows === 0));
});
