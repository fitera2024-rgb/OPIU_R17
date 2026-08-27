import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

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
import { enforceServiceHandoffReadyAuthority } from "./service_r001_ready_authority.mjs";

const SHA_A = "A".repeat(64);
const SHA_B = "B".repeat(64);

function physicalSource(overrides = {}) {
  return {
    source_organization: "Физическая организация ERP",
    source_archive_path: "erp.zip",
    source_archive_sha256: SHA_A,
    journal_entry: "journal.xlsx",
    journal_sha256: SHA_B,
    source_sheet: "Лист_1",
    source_range: "B12:AG12",
    source_row_id: "ROW-12",
    date: "31.01.2026",
    document: "Документ 12",
    posting_number: "4",
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Источник", "Проект", "ЦФО"],
    credit_analytics: ["Сотрудник", "Договор", "ЦФО"],
    debit_department: "Подразделение Дт",
    credit_department: "Подразделение Кт",
    amount: 125,
    activity: "Да",
    scenario: "Факт",
    ...overrides,
  };
}

function accountingFor(source, operation) {
  if (operation === "STORNO") return {
    debit: source.debit,
    credit: source.credit,
    debit_analytics: source.debit_analytics,
    credit_analytics: source.credit_analytics,
    debit_department: source.debit_department,
    credit_department: source.credit_department,
    article: source.debit_analytics[0],
  };
  return {
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Назначение", "Проект", "ЦФО"],
    credit_analytics: ["Сотрудник", "Договор", "ЦФО"],
    debit_department: "Подразделение Дт",
    credit_department: "Подразделение Кт",
    article: "Назначение",
  };
}

function loaderFor(source, accounting, operation, amount, overrides = {}) {
  const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, null]));
  Object.assign(loader, {
    "СчетДт": accounting.debit,
    "СчетКт": accounting.credit,
    "ВидОперации": operation,
    "ПодразделениеДт": accounting.debit_department,
    "ПодразделениеКт": accounting.credit_department,
    "СуммаВВалютеУчета": amount,
    "СуммаВВалютеОтчетности": amount,
    "Содержание": `Canonical ${operation}`,
    "СчетДтИсточник": source.debit,
    "СчетКтИсточник": source.credit,
    "ИдентификаторФинЗаписи": source.source_row_id || null,
    "СубконтоДт1": accounting.debit_analytics[0] || null,
    "СубконтоДт2": accounting.debit_analytics[1] || null,
    "СубконтоДт3": accounting.debit_analytics[2] || null,
    "СубконтоКт1": accounting.credit_analytics[0] || null,
    "СубконтоКт2": accounting.credit_analytics[1] || null,
    "СубконтоКт3": accounting.credit_analytics[2] || null,
    ...overrides,
  });
  return loader;
}

function canonicalRow({
  auditIdentity = "AUDIT-1",
  operation = "STORNO",
  route = "READY",
  amount = 125,
  sourceOverrides = {},
  caseOverrides = {},
  loaderOverrides = {},
} = {}) {
  const source = physicalSource(sourceOverrides);
  const accounting = accountingFor(source, operation);
  const materializationCase = createMaterializationCase({
    case_id: caseOverrides.case_id ?? `CASE-${auditIdentity}`,
    pair_id: caseOverrides.pair_id ?? `PAIR-${auditIdentity}`,
    period: caseOverrides.period ?? "2026-01",
    reconciliation_organization: caseOverrides.reconciliation_organization ?? "Организация отчёта",
    action: operation,
    role: operation === "STORNO" ? "RECLASS_SOURCE" : "RECLASS_TARGET",
    signed_economic_effect: operation === "STORNO" ? -amount : amount,
    correction_amount: amount,
    economic: { source_code: "SOURCE", target_code: "TARGET", source_article: "Источник", target_article: "Назначение" },
    proof_status: route === "READY" ? "PROVEN" : "INCOMPLETE",
    correction_allowed: route === "READY",
    correction_authority: route === "READY" ? "EXACT_SOURCE" : "REVIEW_REQUIRED",
    output_route: route,
    physical_source: source,
    target_accounting: accounting,
    physical_proof: {
      declared: true,
      source_operation_proven: true,
      physical_source_unique: true,
      pinned_source_reopened: true,
      source_reuse_checked: true,
      target_classification_proven: true,
    },
    analytical_basis: {},
    economic_route: {},
    source_scope: {},
    reason: "Проверяемая причина",
    blockers: route === "SPORNO" ? ["MANUAL_REVIEW_REQUIRED"] : [],
    provenance: { source: "FOCUSED_TEST" },
    safety: REPORT_ONLY_SAFETY,
    ...caseOverrides,
  });
  return createCanonicalPostingRow({
    materialization_case: materializationCase,
    operation,
    output_route: route,
    materialization_state: route === "READY" ? "MATERIALIZED_READY" : "MATERIALIZED_SPORNO",
    audit_identity: auditIdentity,
    amount,
    result_accounting: accounting,
    loader: loaderFor(source, accounting, operation, amount, loaderOverrides),
    safety: REPORT_ONLY_SAFETY,
  });
}

function workbookRecords(output) {
  return output.groups.map((group) => ({
    output_route: group.output_route,
    source_organization: group.source_organization,
    period: group.period,
    destination_filename: group.destination_filename,
    rows: group.rows.map((row) => ({ audit_identity: row.audit_identity, loader_values: [...row.loader_values] })),
  }));
}

test("exact two-leg STORNO+REPOST pair with one handoff SourceRowID preserves READY", () => {
  const rows = [
    canonicalRow({ auditIdentity: "EXACT-S", caseOverrides: { pair_id: "PAIR-EXACT" } }),
    canonicalRow({ auditIdentity: "EXACT-R", operation: "REPOST", caseOverrides: { pair_id: "PAIR-EXACT" } }),
  ];
  const gate = enforceServiceHandoffReadyAuthority(rows, ["ROW-12"]);
  const output = collectCanonicalFinancialOutput(gate.rows);
  assert.deepEqual(output.headers, LOADER_A_AA_FIELDS);
  assert.equal(output.headers.length, 27);
  assert.equal(output.groups[0].rows[0].source_organization, "Физическая организация ERP");
  assert.equal(output.groups[0].rows[0].source.source_row_id, "ROW-12");
  assert.equal(output.counters.ready_financial_rows, 2);
  assert.equal(output.counters.storno_rows, 1);
  assert.equal(output.counters.repost_rows, 1);
  assert.equal(gate.audit.blocked_pair_count, 0);
});

test("canonical filenames follow section 12.2 for proven and unknown source organizations", () => {
  assert.equal(canonicalOutputFilename({
    output_route: "READY",
    source_organization: "ООО Источник",
    period: "2025-11",
  }), "[ООО Источник][30.11.2025]_ОПИУ_ГОТОВО.xlsx");
  assert.equal(canonicalOutputFilename({
    output_route: "SPORNO",
    source_organization: "",
    period: "2025-02",
  }), "[ИСТОЧНИК НЕ ОПРЕДЕЛЕН][28.02.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx");
});

test("empty Service handoff SourceRowID set demotes every READY row to SPORNO", () => {
  const gate = enforceServiceHandoffReadyAuthority([
    canonicalRow({ auditIdentity: "EMPTY-S", caseOverrides: { pair_id: "PAIR-EMPTY" } }),
    canonicalRow({ auditIdentity: "EMPTY-R", operation: "REPOST", caseOverrides: { pair_id: "PAIR-EMPTY" } }),
  ], []);
  const output = collectCanonicalFinancialOutput(gate.rows);
  assert.equal(output.rows[0].loader["СубконтоДт1"], null);
  assert.equal(output.rows[0].source.source_row_id, "");
  assert.equal(output.rows[0].output_route, "SPORNO");
  assert.equal(output.counters.ready_financial_rows, 0);
  assert.equal(output.counters.sporno_financial_rows, 2);
  assert.equal(output.counters.storno_rows, 1);
  assert.equal(output.counters.repost_rows, 1);
  assert.deepEqual(gate.audit.blocker_codes, ["SERVICE_HANDOFF_SOURCE_ROW_ID_OUTSIDE_EXACT_SET"]);
});

test("explicit SPORNO STORNO and REPOST stay in SPORNO only with exact route/state", () => {
  const rows = [
    canonicalRow({ auditIdentity: "SP-S", route: "SPORNO", caseOverrides: { pair_id: "PAIR-SP" } }),
    canonicalRow({ auditIdentity: "SP-P", route: "SPORNO", operation: "REPOST", caseOverrides: { pair_id: "PAIR-SP" } }),
  ];
  const output = collectCanonicalFinancialOutput(rows);
  assert.equal(output.counters.ready_financial_rows, 0);
  assert.equal(output.counters.sporno_financial_rows, 2);
  assert.equal(output.groups.length, 1);
  assert.ok(output.rows.every((row) => row.output_route === "SPORNO" && row.materialization_state === "MATERIALIZED_SPORNO"));
});

test("accepted intergroup source STORNO and target REPOST remain separate canonical SPORNO rows when physical identity is incomplete", () => {
  const cases = [
    ["STORNO", "RECLASS_SOURCE", -125],
    ["REPOST", "RECLASS_TARGET", 125],
  ].map(([action, role, effect]) => createMaterializationCase({
    case_id: "CASE-INTERGROUP",
    pair_id: "PAIR-INTERGROUP",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action,
    role,
    signed_economic_effect: effect,
    correction_amount: 125,
    economic: { source_code: "SOURCE", target_code: "TARGET", source_article: "Источник", target_article: "Назначение" },
    proof_status: "PROVEN_ECONOMIC_ROUTE",
    correction_allowed: false,
    correction_authority: "PHYSICAL_SOURCE_INCOMPLETE",
    output_route: "SPORNO",
    physical_source: { source_organization: "", source_row_id: "" },
    target_accounting: accountingFor(physicalSource(), action),
    analytical_basis: {},
    economic_route: { accepted: true },
    source_scope: {},
    reason: "economic route accepted; physical source incomplete",
    blockers: ["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY"],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  }));
  const output = collectCanonicalFinancialOutput(cases.map(canonicalSpornoRowFromMaterializationCase));
  assert.deepEqual(output.rows.map((row) => row.operation).sort(), ["REPOST", "STORNO"]);
  assert.ok(output.rows.every((row) => row.output_route === "SPORNO"));
  assert.ok(output.rows.every((row) => row.source.source_row_id === ""));
  assert.ok(output.rows.every((row) => row.loader["ИдентификаторФинЗаписи"] === null));
  assert.ok(output.rows.every((row) => row.loader["Содержание"].startsWith(`Операция ${row.operation}`)));
  assert.ok(output.rows.every((row) => row.loader["Содержание"].includes("сумма 125,00")));
  assert.ok(output.rows.every((row) => !/(?:REPORT_ONLY|CaseID|PairID|SourceRowID)/.test(row.loader["Содержание"])));
  assert.match(output.rows.find((row) => row.operation === "REPOST").loader["Содержание"], /Статья: «Источник» → «Назначение»/);
  assert.match(output.rows.find((row) => row.operation === "STORNO").loader["Содержание"], /Статья: «Источник»/);
});

test("canonical SPORNO content exposes only known ERP physical fields in business language", () => {
  const source = physicalSource();
  const materialization = createMaterializationCase({
    case_id: "CASE-BUSINESS-CONTENT",
    pair_id: "PAIR-BUSINESS-CONTENT",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action: "REPOST",
    role: "RECLASS_TARGET",
    signed_economic_effect: 125,
    correction_amount: 125,
    economic: { source_code: "SOURCE", target_code: "TARGET", source_article: "Источник", target_article: "Назначение" },
    proof_status: "PROVEN_ECONOMIC_ROUTE",
    correction_allowed: false,
    correction_authority: "PHYSICAL_SOURCE_INCOMPLETE",
    output_route: "SPORNO",
    physical_source: source,
    target_accounting: accountingFor(source, "REPOST"),
    physical_proof: {
      declared: true,
      source_operation_proven: true,
      physical_source_unique: true,
      target_classification_proven: true,
      pinned_source_reopened: true,
      source_reuse_checked: true,
    },
    analytical_basis: {},
    economic_route: { accepted: true },
    source_scope: {},
    reason: "economic route accepted; physical source incomplete",
    blockers: ["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY"],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  });
  const row = canonicalSpornoRowFromMaterializationCase(materialization);
  assert.match(row.loader["Содержание"], /^Операция REPOST \| ERP: документ «Документ 12»; дата 31\.01\.2026; проводка № 4; Дт 26; Кт 70\.1; сумма 125,00; организация «Физическая организация ERP»;/);
  assert.match(row.loader["Содержание"], /Статья: «Источник» → «Назначение»/);
  assert.match(row.loader["Содержание"], /Причина: economic route accepted; physical source incomplete$/);
  assert.doesNotMatch(row.loader["Содержание"], /REPORT_ONLY|CaseID|PairID|SourceRowID/);
});

test("canonical SPORNO column P carries only normalized verified Intalev business evidence", () => {
  const row = canonicalSpornoRowFromMaterializationCase(createMaterializationCase({
    case_id: "CASE-INTALEV-EVIDENCE",
    pair_id: "PAIR-INTALEV-EVIDENCE",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action: "REPOST",
    role: "RECLASS_TARGET",
    signed_economic_effect: 125,
    correction_amount: 125,
    economic: { source_code: "R033", target_code: "R023", source_article: "ФЗП", target_article: "Расходы на персонал" },
    proof_status: "PROVEN_ECONOMIC_ROUTE",
    correction_allowed: false,
    correction_authority: "PHYSICAL_SOURCE_INCOMPLETE",
    output_route: "SPORNO",
    physical_source: physicalSource({ source_row_id: "", source_organization: "" }),
    target_accounting: accountingFor(physicalSource(), "REPOST"),
    physical_proof: {},
    analytical_basis: {},
    economic_route: { accepted: true },
    source_scope: {},
    business_evidence: {
      intalev_references: [{
        code: "R999",
        source_file: "invented.xlsx",
        sheet: "Fake",
        source_cell: "A1",
        verified: false,
      }],
      intalev_technical_reference: `R033: C:\\private\\intalev.xlsx!TDSheet!E103; путь Расходы / ФЗП; JournalSHA=${SHA_A}; R404: UNKNOWN!UNKNOWN!UNKNOWN`,
    },
    reason: "economic route only",
    blockers: ["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY"],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  }));

  const content = row.loader_values[15];
  assert.match(content, /Инталев: R033: файл «intalev\.xlsx», лист «TDSheet», ячейка E103, путь «Расходы \/ ФЗП»/);
  assert.doesNotMatch(content, /R999|invented\.xlsx|JournalSHA|[A-F0-9]{64}|C:\\private|UNKNOWN/);
  assert.doesNotMatch(content, /документ операций Инталев не представлен/);
});

test("canonical SPORNO reports absent Intalev document only from complete proven source scope", () => {
  const row = canonicalSpornoRowFromMaterializationCase(createMaterializationCase({
    case_id: "CASE-INTALEV-ABSENCE",
    pair_id: "PAIR-INTALEV-ABSENCE",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action: "STORNO",
    role: "STANDALONE",
    signed_economic_effect: -125,
    correction_amount: 125,
    economic: { source_code: "R033", target_code: "", source_article: "ФЗП", target_article: "" },
    proof_status: "PROVEN",
    correction_allowed: false,
    correction_authority: "MANUAL_REVIEW",
    output_route: "SPORNO",
    physical_source: physicalSource({ source_row_id: "", source_organization: "" }),
    target_accounting: accountingFor(physicalSource(), "STORNO"),
    physical_proof: {},
    analytical_basis: {},
    economic_route: {},
    source_scope: {
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_claimed: true,
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
    },
    business_evidence: { intalev_document_absent: true },
    reason: "complete absence proof",
    blockers: [],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  }));

  assert.match(row.loader["Содержание"], /документ операций Инталев не представлен/);
});

test("unproven SPORNO candidate analytics are suppressed from physical A:AA fields", () => {
  const materialization = createMaterializationCase({
    case_id: "CASE-UNPROVEN-PHYSICAL",
    pair_id: "PAIR-UNPROVEN-PHYSICAL",
    period: "2026-01",
    reconciliation_organization: "Организация отчёта",
    action: "REPOST",
    role: "RECLASS_TARGET",
    signed_economic_effect: 125,
    correction_amount: 125,
    economic: { source_code: "R033", target_code: "R023", source_article: "ФЗП", target_article: "Расходы на персонал" },
    proof_status: "UNPROVEN",
    correction_allowed: false,
    correction_authority: "PHYSICAL_SOURCE_INCOMPLETE",
    output_route: "SPORNO",
    physical_source: physicalSource({ source_row_id: "", source_organization: "" }),
    target_accounting: accountingFor(physicalSource(), "REPOST"),
    physical_proof: {
      source_operation_proven: false,
      physical_source_unique: false,
      target_classification_proven: false,
    },
    analytical_basis: {},
    economic_route: { accepted: true },
    source_scope: {},
    reason: "economic route only",
    blockers: ["SOURCE_OPERATION_UNPROVEN", "TARGET_CLASSIFICATION_UNPROVEN"],
    provenance: {},
    safety: REPORT_ONLY_SAFETY,
  });
  const row = canonicalSpornoRowFromMaterializationCase(materialization);
  for (const field of [
    "СчетДт", "СчетКт", "ПодразделениеДт", "ПодразделениеКт",
    "СчетДтИсточник", "СчетКтИсточник", "ИдентификаторФинЗаписи",
    "СубконтоДт1", "СубконтоДт2", "СубконтоДт3", "СубконтоКт1", "СубконтоКт2", "СубконтоКт3",
  ]) assert.equal(row.loader[field], null, field);
  assert.match(row.loader["Содержание"], /Статья: «ФЗП» → «Расходы на персонал»/);
  assert.doesNotMatch(row.loader["Содержание"], /REPORT_ONLY|CaseID|PairID|SourceRowID/);
});

test("REVIEW_ONLY, mapping-only, structural and directionless inputs create zero final financial rows", () => {
  const output = collectCanonicalFinancialOutput([]);
  assert.equal(output.counters.canonical_financial_rows_total, 0);
  assert.equal(output.groups.length, 0);
  assert.throws(() => collectCanonicalFinancialOutput([["legacy", "A:AA"]]), { code: "NONCANONICAL_FINANCIAL_ROW" });
});

test("generated UploadID cannot impersonate a missing physical SourceRowID", () => {
  assert.throws(() => canonicalRow({
    route: "SPORNO",
    sourceOverrides: { source_row_id: "" },
    loaderOverrides: { "ИдентификаторФинЗаписи": "GENERATED-UPLOAD-ID" },
  }), { code: "SOURCE_IDENTITY_MISMATCH" });
});

test("output grouping and registry use physical source organization and preserve report organization separately", () => {
  const row = canonicalRow({ caseOverrides: { reconciliation_organization: "Отчётная организация" } });
  const output = collectCanonicalFinancialOutput([row]);
  assert.match(output.groups[0].destination_filename, /^\[Физическая организация ERP\]/);
  assert.equal(output.registry_rows[0].source_organization, "Физическая организация ERP");
  assert.equal(output.registry_rows[0].reconciliation_organization, "Отчётная организация");
});

test("independent canonical producers targeting one READY filename merge before one write", () => {
  const output = collectCanonicalFinancialOutput([
    canonicalRow({ auditIdentity: "PRODUCER-A" }),
    canonicalRow({
      auditIdentity: "PRODUCER-B",
      operation: "REPOST",
      sourceOverrides: { source_row_id: "ROW-13", source_range: "B13:AG13", posting_number: "5" },
    }),
  ]);
  assert.equal(output.groups.length, 1);
  assert.equal(output.groups[0].rows.length, 2);
  assert.equal(output.counters.ready_financial_workbooks, 1);
});

test("independent canonical producers targeting one SPORNO filename merge before one write", () => {
  const output = collectCanonicalFinancialOutput([
    canonicalRow({ auditIdentity: "SPORNO-A", route: "SPORNO" }),
    canonicalRow({
      auditIdentity: "SPORNO-B",
      route: "SPORNO",
      operation: "REPOST",
      sourceOverrides: { source_row_id: "ROW-13", source_range: "B13:AG13", posting_number: "5" },
    }),
  ]);
  assert.equal(output.groups.length, 1);
  assert.equal(output.groups[0].rows.length, 2);
  assert.equal(output.counters.sporno_financial_workbooks, 1);
});

test("conflicting duplicate canonical audit identity fails closed while exact duplicate is auditable and not counted twice", () => {
  const first = canonicalRow({ auditIdentity: "DUPLICATE" });
  const exact = collectCanonicalFinancialOutput([first, first]);
  assert.equal(exact.rows.length, 1);
  assert.deepEqual(exact.exact_duplicate_identities, ["DUPLICATE"]);
  assert.throws(() => collectCanonicalFinancialOutput([
    first,
    canonicalRow({ auditIdentity: "DUPLICATE", amount: 126 }),
  ]), { code: "CONFLICTING_CANONICAL_AUDIT_IDENTITY" });
});

test("manifest counters, workbook rows and registry identities reconcile to the same canonical set", () => {
  const output = collectCanonicalFinancialOutput([
    canonicalRow({ auditIdentity: "READY-S" }),
    canonicalRow({
      auditIdentity: "READY-P",
      operation: "REPOST",
      sourceOverrides: { source_row_id: "ROW-13", source_range: "B13:AG13", posting_number: "5" },
    }),
    canonicalRow({
      auditIdentity: "SPORNO-S",
      route: "SPORNO",
      sourceOverrides: { source_row_id: "ROW-14", source_range: "B14:AG14", posting_number: "6" },
    }),
  ]);
  assert.deepEqual({
    total: output.counters.canonical_financial_rows_total,
    ready: output.counters.ready_financial_rows,
    sporno: output.counters.sporno_financial_rows,
    storno: output.counters.storno_rows,
    repost: output.counters.repost_rows,
    posting: output.counters.posting_rows,
    executed: output.counters.executed_posting_rows,
    live: output.counters.live_posting_rows,
  }, { total: 3, ready: 2, sporno: 1, storno: 2, repost: 1, posting: 0, executed: 0, live: 0 });
  assert.match(output.canonical_row_set_sha256, /^[A-F0-9]{64}$/);
  assert.deepEqual(verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords(output) }), {
    result: "PASS",
    canonical_financial_rows_total: 3,
    workbook_financial_rows: 3,
    registry_financial_rows: 3,
    canonical_row_set_sha256: output.canonical_row_set_sha256,
    ...REPORT_ONLY_SAFETY,
    safety: REPORT_ONLY_SAFETY,
  });
});

test("canonical integrity exposes full explicit service REPORT_ONLY safety without changing rows", () => {
  const output = collectCanonicalFinancialOutput([
    canonicalRow({ auditIdentity: "SAFETY-S" }),
    canonicalRow({
      auditIdentity: "SAFETY-P",
      operation: "REPOST",
      route: "SPORNO",
      sourceOverrides: { source_row_id: "ROW-13", source_range: "B13:AG13", posting_number: "5" },
    }),
  ]);
  const beforeRows = structuredClone(output.rows);
  const beforeGroups = structuredClone(output.groups);
  const integrity = verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords(output) });
  assert.deepEqual(Object.fromEntries(Object.keys(REPORT_ONLY_SAFETY).map((key) => [key, integrity[key]])), REPORT_ONLY_SAFETY);
  assert.deepEqual(output.rows, beforeRows);
  assert.deepEqual(output.groups, beforeGroups);
  assert.equal(integrity.canonical_financial_rows_total, 2);
  assert.equal(integrity.workbook_financial_rows, 2);
  assert.equal(integrity.registry_financial_rows, 2);
});

test("invalid full-pair shapes and SourceRowID bindings demote every READY leg", () => {
  const readyPair = (pairID, prefix, sourceRowID = "ROW-12") => [
    canonicalRow({ auditIdentity: `${prefix}-S`, sourceOverrides: { source_row_id: sourceRowID }, caseOverrides: { pair_id: pairID } }),
    canonicalRow({ auditIdentity: `${prefix}-R`, operation: "REPOST", sourceOverrides: { source_row_id: sourceRowID }, caseOverrides: { pair_id: pairID } }),
  ];
  const cases = [
    {
      name: "mixed READY+SPORNO",
      rows: [
        canonicalRow({ auditIdentity: "MIX-S", caseOverrides: { pair_id: "PAIR-MIX" } }),
        canonicalRow({ auditIdentity: "MIX-R", operation: "REPOST", route: "SPORNO", caseOverrides: { pair_id: "PAIR-MIX" } }),
      ],
      allowed: ["ROW-12"],
      blocker: "SERVICE_HANDOFF_PAIR_MIXED_OUTPUT_ROUTE",
    },
    { name: "one leg", rows: readyPair("PAIR-ONE", "ONE").slice(0, 1), allowed: ["ROW-12"], blocker: "SERVICE_HANDOFF_PAIR_LEG_COUNT_INVALID" },
    { name: "three legs", rows: [...readyPair("PAIR-THREE", "THREE"), canonicalRow({ auditIdentity: "THREE-X", caseOverrides: { pair_id: "PAIR-THREE" } })], allowed: ["ROW-12"], blocker: "SERVICE_HANDOFF_PAIR_LEG_COUNT_INVALID" },
    { name: "four legs", rows: [...readyPair("PAIR-FOUR", "FOUR-A"), ...readyPair("PAIR-FOUR", "FOUR-B")], allowed: ["ROW-12"], blocker: "SERVICE_HANDOFF_PAIR_LEG_COUNT_INVALID" },
    {
      name: "duplicate operation",
      rows: [
        canonicalRow({ auditIdentity: "DUP-A", caseOverrides: { pair_id: "PAIR-DUP" } }),
        canonicalRow({ auditIdentity: "DUP-B", caseOverrides: { pair_id: "PAIR-DUP" } }),
      ],
      allowed: ["ROW-12"],
      blocker: "SERVICE_HANDOFF_PAIR_OPERATIONS_INVALID",
    },
    {
      name: "two allowed IDs",
      rows: [
        canonicalRow({ auditIdentity: "TWO-S", caseOverrides: { pair_id: "PAIR-TWO" } }),
        canonicalRow({ auditIdentity: "TWO-R", operation: "REPOST", sourceOverrides: { source_row_id: "ROW-13", source_range: "B13:AG13" }, caseOverrides: { pair_id: "PAIR-TWO" } }),
      ],
      allowed: ["ROW-12", "ROW-13"],
      blocker: "SERVICE_HANDOFF_PAIR_MULTIPLE_SOURCE_ROW_IDS",
    },
    { name: "outside ID", rows: readyPair("PAIR-OUT", "OUT", "ROW-OUTSIDE"), allowed: ["ROW-12"], blocker: "SERVICE_HANDOFF_SOURCE_ROW_ID_OUTSIDE_EXACT_SET" },
    {
      name: "missing ID",
      rows: readyPair("PAIR-MISSING", "MISSING").map((row) => ({
        ...row,
        source: { ...row.source, source_row_id: "" },
        loader: { ...row.loader, "ИдентификаторФинЗаписи": null },
        materialization_case: {
          ...row.materialization_case,
          physical_source: { ...row.materialization_case.physical_source, source_row_id: "" },
        },
      })),
      allowed: ["ROW-12"],
      blocker: "SERVICE_HANDOFF_SOURCE_ROW_ID_MISSING",
    },
    {
      name: "reuse across pairs",
      rows: [...readyPair("PAIR-REUSE-A", "REUSE-A"), ...readyPair("PAIR-REUSE-B", "REUSE-B")],
      allowed: ["ROW-12"],
      blocker: "SERVICE_HANDOFF_SOURCE_ROW_ID_REUSED",
    },
  ];
  for (const scenario of cases) {
    const gate = enforceServiceHandoffReadyAuthority(scenario.rows, scenario.allowed);
    const output = collectCanonicalFinancialOutput(gate.rows);
    assert.equal(output.counters.ready_financial_rows, 0, scenario.name);
    assert.equal(output.counters.sporno_financial_rows, scenario.rows.length, scenario.name);
    assert.ok(gate.audit.blocker_codes.includes(scenario.blocker), scenario.name);
    assert.ok(output.rows.every((row) => row.output_route === "SPORNO"), scenario.name);
  }
});

test("paired correction rejects unequal STORNO and REPOST amounts", () => {
  assert.throws(() => collectCanonicalFinancialOutput([
    canonicalRow({
      auditIdentity: "UNBALANCED-STORNO",
      amount: 100,
      caseOverrides: { pair_id: "PAIR-UNBALANCED" },
    }),
    canonicalRow({
      auditIdentity: "UNBALANCED-REPOST",
      operation: "REPOST",
      amount: 80,
      caseOverrides: { pair_id: "PAIR-UNBALANCED" },
    }),
  ]), (error) => error?.code === "UNBALANCED_CORRECTION_PAIR"
    && error.details.storno_cents === 10000
    && error.details.repost_cents === 8000
    && error.details.signed_total_cents === -2000);
});

test("column P excludes technical audit data while registry keeps it separately", () => {
  const output = collectCanonicalFinancialOutput([canonicalSpornoRowFromMaterializationCase(
    createMaterializationCase({
      ...canonicalRow({ route: "SPORNO" }).materialization_case,
      action: "STORNO",
      output_route: "SPORNO",
    }),
  )]);
  const [row] = output.rows;
  const [audit] = output.registry_rows;
  assert.doesNotMatch(row.loader["Содержание"], /REPORT_ONLY|CaseID|PairID|SourceRowID|execution_allowed|ready_to_upload/);
  assert.equal(audit.case_id, row.case_id);
  assert.equal(audit.pair_id, row.pair_id);
  assert.equal(audit.source_row_id, row.source.source_row_id);
});

test("integrity gate rejects loader drift, missing workbook row and missing registry row", () => {
  const output = collectCanonicalFinancialOutput([canonicalRow()]);
  const records = workbookRecords(output);
  records[0].rows[0].loader_values[0] = "DRIFT";
  assert.throws(() => verifyCanonicalOutputIntegrity(output, { workbook_records: records }), { code: "CANONICAL_LOADER_VALUES_DRIFT" });
  assert.throws(() => verifyCanonicalOutputIntegrity(output, { workbook_records: [] }), { code: "CANONICAL_WORKBOOK_SET_MISMATCH" });
  assert.throws(() => verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords(output), registry_rows: [] }), { code: "CANONICAL_REGISTRY_ROW_MISSING" });
  const driftedRegistry = output.registry_rows.map((row) => ({ ...row, reason: "DRIFT" }));
  assert.throws(() => verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords(output), registry_rows: driftedRegistry }), { code: "CANONICAL_REGISTRY_ROW_DRIFT" });
  assert.throws(() => verifyCanonicalOutputIntegrity({ ...output, canonical_row_set_sha256: "0".repeat(64) }, {
    workbook_records: workbookRecords(output),
  }), { code: "CANONICAL_ROW_SET_HASH_MISMATCH" });
});

test("canonical registry retains source provenance, authority, reason and blockers exactly once", () => {
  const output = collectCanonicalFinancialOutput([canonicalRow({ route: "SPORNO" })]);
  assert.equal(output.registry_rows.length, output.rows.length);
  const [audit] = output.registry_rows;
  assert.equal(audit.source_archive_sha256, SHA_A);
  assert.equal(audit.journal_sha256, SHA_B);
  assert.equal(audit.correction_authority, "REVIEW_REQUIRED");
  assert.equal(audit.reason, "Проверяемая причина");
  assert.deepEqual(audit.blockers, ["MANUAL_REVIEW_REQUIRED"]);
});

test("active core writer accepts only the merged canonical group and legacy row arrays are excluded", async () => {
  const engineSource = await fs.readFile(new URL("./correction_engine_r001.mjs", import.meta.url), "utf8");
  const strictWriterCalls = [...engineSource.matchAll(/await\s+buildStrictUploadWorkbook\(([^,]+),/g)].map((match) => match[1].trim());
  assert.deepEqual(strictWriterCalls, ["group.rows"]);
  assert.match(engineSource, /enforceServiceHandoffReadyAuthority\(\[/);
  assert.match(engineSource, /collectCanonicalFinancialOutput\(serviceHandoffAuthority\.rows,/);
  assert.doesNotMatch(engineSource, /await\s+buildStrictUploadWorkbook\((?:actions|applicationReview|disputedSidecar|materialization)\./);
  assert.match(engineSource, /posting_rows:\s*0,/);
});
