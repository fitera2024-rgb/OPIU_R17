import assert from "node:assert/strict";
import test from "node:test";

import {
  matchCrossJournalRows,
  normalizeBusinessText,
} from "./cross_journal_discrepancy_evidence.mjs";
import { createArticleApprovalDocument } from "./article_approval_core.mjs";

const intalevCatalogNodes = [{
  name: "Маркетинг, реклама",
  full_path: "Расходы / 3_Коммерческие расходы / Маркетинг, реклама",
}];
const erpCatalogNodes = [{
  name: "Прочее (реклама)",
  full_path: "Расходы / Коммерческие расходы / Прочее (реклама)",
  exact_catalog_entry_node: true,
  catalog_entries: [{ code: "COMM-AD", account: "44.1" }],
}];

function intalevRow(overrides = {}) {
  return {
    source_row_id: "I763",
    physical_row: 763,
    period: "2025-01",
    date: "10.01.2025 0:00:00",
    date_value: "2025-01-10",
    document: "Проформа 00000000071",
    posting_no: 3,
    scenario: "Факт",
    debit: "60",
    credit: "51",
    debit_analytics: ["пп 21", "ДНС Ритейл ООО", "Акции"],
    credit_analytics: ["ПВ", "ПВ_Сбербанк_0651", "Маркетинг, реклама"],
    amount: 15000,
    content: "Сертификаты (компенс.Инмарко)",
    department: "Коммерческий департамент",
    cfo: "ЦМД Сахалин",
    ...overrides,
  };
}

function erpRow(overrides = {}) {
  return {
    source_row_id: "E311",
    physical_row: 311,
    period: "2025-01",
    date: "10.01.2025 0:00:00",
    date_value: "2025-01-10",
    document: "Трансляция 0000001854",
    posting_no: 951,
    activity: "Да",
    scenario: "Факт",
    debit: "60",
    credit: "51",
    debit_analytics: ["ДНС РИТЕЙЛ ООО"],
    credit_analytics: ["Прочее (реклама)", "ПВ_Сбербанк_0651"],
    debit_department: "ПВ Коммерческий отдел",
    credit_department: "ПВ Коммерческий отдел",
    amount: 15000,
    content: "Сертификаты (компенс.Инмарко)",
    organization: "Сахалин",
    ...overrides,
  };
}

const approvalScope = {
  organizationId: "3",
  organizationName: "Сахалин",
  organizationHierarchyPath: "Холдинг / Сахалин",
  period: "2025-01",
};

function approvalDecision({
  block = "Коммерческие расходы",
  article = "ФЗП коммерческого персонала",
  decision = "УТВЕРЖДАЮ",
  proposedBlock = "Коммерческие расходы",
  proposedArticle = "ФЗП",
  proposedCode = "COMM-FZP",
  correctedBlock = "",
  correctedArticle = "",
  correctedCode = "",
  comment = "",
} = {}) {
  return {
    КлючОбласти: `3|2025-01|${normalizeBusinessText(block)}|${normalizeBusinessText(article)}`,
    КодОрганизацииERP: "3",
    ОрганизацияERP: "Сахалин",
    ПериодС: "2025-01",
    БлокИнталев: block,
    ПутьИнталев: `Статьи ОПИУ 2025 / ${block} / ${article}`,
    СтатьяИнталев: article,
    ПредлагаемыйБлокERP: proposedBlock,
    ПредлагаемаяСтатьяERP: proposedArticle,
    КодСтатьиERP: proposedCode,
    Действие: "КЛАССИФИКАЦИЯ",
    РешениеПользователя: decision,
    ПравильныйБлокERP: correctedBlock,
    ПравильнаяСтатьяERP: correctedArticle,
    ПравильныйКодСтатьиERP: correctedCode,
    КомментарийПользователя: comment,
  };
}

function approvalDocument(rows, catalogs) {
  return createArticleApprovalDocument({
    ...approvalScope,
    sourceSha256: "A".repeat(64),
    sourceXlsx: "source.xlsx",
    actor: "DOMAIN\\user",
    rows,
    erpCatalog: catalogs,
  });
}

function approvedIntergroupFixture() {
  const catalogs = [
    {
      label: "ФЗП",
      full_path: "Административные расходы / ФЗП",
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: "ADMIN-FZP", account: "26" }],
    },
    {
      label: "ФЗП",
      full_path: "Коммерческие расходы / ФЗП",
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: "COMM-FZP", account: "44.1" }],
    },
    {
      label: "Обучение сотрудников",
      full_path: "Коммерческие расходы / Обучение сотрудников",
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: "COMM-TRAINING", account: "44.1" }],
    },
  ];
  return {
    intalevRows: [intalevRow({
      source_row_id: "I-APPROVAL",
      physical_row: 700,
      debit: "44.1",
      credit: "70.1",
      debit_analytics: ["ФЗП коммерческого персонала", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      amount: 100,
      content: "Начисление сотруднику А",
    })],
    erpRows: [erpRow({
      source_row_id: "E-APPROVAL",
      physical_row: 900,
      debit: "26",
      credit: "70.1",
      debit_analytics: ["ФЗП", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      article: "ФЗП",
      disclosure: "Счет затрат 26",
      analytics3: "26 счет",
      amount: 100,
      content: "Начисление сотруднику А",
    })],
    intalevCatalogNodes: [{
      name: "ФЗП коммерческого персонала",
      full_path: "Расходы / 3_Коммерческие расходы / ФЗП коммерческого персонала",
    }],
    erpCatalogNodes: catalogs,
    period: "2025-01",
    articleApprovalScope: approvalScope,
    allowedPhysicalOrganizations: ["Сахалин"],
  };
}

test("normalizes Russian business text", () => {
  assert.equal(normalizeBusinessText("  Прочее (РЕКЛАМА)  "), "прочее реклама");
});

test("proves the Sakhalin advertising pair without using the article in the fingerprint", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow()],
    erpRows: [erpRow()],
    period: "2025-01",
    intalevCatalogNodes,
    erpCatalogNodes,
  });
  assert.equal(result.counts.unique_pairs, 1);
  assert.equal(result.counts.different_article_pairs, 0);
  assert.equal(result.counts.reused_intalev_rows, 0);
  assert.equal(result.counts.reused_erp_rows, 0);
  assert.equal(result.rows[0].confidence, 100);
  assert.match(result.rows[0].classification, /ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ/);
  assert.equal(result.rows[0].article_intalev, "Маркетинг, реклама");
  assert.equal(result.rows[0].article_erp, "Прочее (реклама)");
});

test("keeps the current ERP article inside one block and derives the Intalev report group from the physical journal analytic", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow({
      debit: "26",
      credit: "79.1",
      debit_analytics: [
        "Прочие административные расходы",
        "Контур.Диадок",
        "Абонентское обслуживание программ",
      ],
      credit_analytics: ["Фонд развития"],
      amount: 11465.3,
      content: "за декабрь",
      date: "31.01.2025 0:00:00",
      date_value: "2025-01-31",
    })],
    erpRows: [erpRow({
      debit: "26",
      credit: "79.1",
      debit_analytics: ["Абонентское обслуживание ПО (1С, Windows и пр)"],
      credit_analytics: ["Фонд развития"],
      article: "Абонентское обслуживание ПО (1С, Windows и пр)",
      amount: 11465.3,
      content: "за декабрь",
      date: "31.01.2025 0:00:00",
      date_value: "2025-01-31",
    })],
    period: "2025-01",
    intalevCatalogNodes: [{
      name: "Прочие административные расходы",
      full_path: "Расходы / 2_Административные расходы / Прочие административные расходы",
    }],
    intalevReportNodes: [
      {
        label: "Прочие административные расходы",
        full_path: "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 2_Административные расходы / Прочие административные расходы",
        direct_total: 27878.05,
      },
      {
        label: "Контур.Диадок",
        full_path: "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 2_Административные расходы / Расходы ИТ / <пустое значение> / Контур.Диадок",
        direct_total: 11465.3,
      },
    ],
    erpCatalogNodes: [
      {
        label: "Абонентское обслуживание ПО (1С, Windows и пр)",
        full_path: "Административные расходы / Абонентское обслуживание ПО (1С, Windows и пр)",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "ADMIN-SOURCE", account: "26" }],
      },
      {
        label: "Прочие административные расходы",
        full_path: "Административные расходы / Прочие административные расходы",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "ADMIN-TARGET", account: "26" }],
      },
    ],
  });
  const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
  assert.equal(pair.target_article_erp, "Абонентское обслуживание ПО (1С, Windows и пр)");
  assert.equal(pair.target_article_code_erp, "ADMIN-SOURCE");
  assert.equal(pair.intalev_report_group, "Расходы ИТ");
  assert.equal(pair.intalev_report_leaf, "Контур.Диадок");
  assert.equal(pair.intalev_report_placement_status, "PROVEN_LIVE_REPORT_LEAF_EXACT_AMOUNT");
  assert.equal(pair.article_approval_status, "NO_APPROVED_VERSION");
  assert.equal(pair.financial_gate_status, "СПОРНО");
  assert.equal(pair.financial_gate_reason, "APPROVAL_NOT_FINAL");
  assert.deepEqual(pair.correction_rows, []);
  assert.equal(pair.financial_pair_rows, 0);
  assert.match(pair.classification, /ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ/);
});

test("does not prove a pair when the ERP candidate is not unique", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow()],
    erpRows: [erpRow(), erpRow({ source_row_id: "E312", physical_row: 312 })],
    period: "2025-01",
    intalevCatalogNodes,
    erpCatalogNodes,
  });
  assert.equal(result.counts.unique_pairs, 0);
  assert.equal(result.counts.ambiguous_pairs, 1);
  assert.match(result.rows[0].classification, /НЕОДНОЗНАЧНО/);
});

test("technical 99 to 84 distribution rows do not enter matching", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow({ debit: "99", credit: "84", content: "Распределение остатков и оборотов" })],
    erpRows: [erpRow({ debit: "99", credit: "84", content: "Распределение остатков и оборотов" })],
    period: "2025-01",
    intalevCatalogNodes,
    erpCatalogNodes,
  });
  assert.equal(result.counts.intalev_scoped_rows, 0);
  assert.equal(result.counts.erp_scoped_rows, 0);
  assert.equal(result.counts.unique_pairs, 0);
});

for (const [targetArticle, intalevArticle] of [
  ["ФЗП", "ФЗП коммерческого персонала"],
  ["НДФЛ", "ФЗП коммерческого персонала"],
  ["Абонентское обслуживание ПО (1С, Windows и пр)", "Расходы ИТ"],
  ["Обучение сотрудников", "Расходы на персонал"],
]) {
  test(`uses the Intalev block and the ERP cost account for ${targetArticle}`, () => {
    const result = matchCrossJournalRows({
      intalevRows: [intalevRow({
        debit: "44.1.2",
        credit: "70",
        debit_analytics: [intalevArticle, targetArticle, "Сотрудник А"],
        credit_analytics: ["Сотрудник А"],
        amount: 12345.67,
        content: `Начисление ${targetArticle}`,
      })],
      erpRows: [erpRow({
        debit: "26",
        credit: "70.1",
        debit_analytics: [targetArticle, "Сотрудник А"],
        credit_analytics: ["Сотрудник А"],
        article: targetArticle,
        disclosure: "Счет затрат 26",
        analytics3: "26 счет",
        amount: 12345.67,
        content: `Начисление ${targetArticle}`,
      })],
      period: "2025-01",
      intalevCatalogNodes: [{
        name: intalevArticle,
        full_path: `Расходы / 3_Коммерческие расходы / ${intalevArticle}`,
      }],
      erpCatalogNodes: [
        {
          label: targetArticle,
          full_path: `Административные расходы / ${targetArticle}`,
          catalog_entries: [{ code: `ADMIN-${targetArticle}`, account: "Счет затрат 26" }],
        },
        {
          label: targetArticle,
          full_path: `Коммерческие расходы / ${targetArticle}`,
          catalog_entries: [{ code: `COMM-${targetArticle}`, account: "Счет затрат 44.1" }],
        },
      ],
    });
    assert.equal(result.counts.unique_pairs, 1);
    assert.equal(result.counts.proven_intergroup_reposts, 1);
    const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
    assert.equal(pair.source_block_erp, "административные расходы");
    assert.equal(pair.target_block_intalev, "коммерческие расходы");
    assert.equal(pair.target_article_erp, targetArticle);
    assert.match(pair.target_article_code_erp, /^COMM-/);
    assert.match(pair.classification, /МЕЖГРУППОВОЙ/);
    assert.match(pair.action, /STORNO.*REPOST/);
  });
}

test("blocks an intergroup repost when the same ERP article is ambiguous in the Intalev target block", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow({
      debit: "44.1",
      credit: "70",
      debit_analytics: ["Маркетинг, реклама", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      amount: 100,
      content: "Начисление",
    })],
    erpRows: [erpRow({
      debit: "26",
      credit: "70.1",
      debit_analytics: ["ФЗП", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      article: "ФЗП",
      amount: 100,
      content: "Начисление",
    })],
    period: "2025-01",
    intalevCatalogNodes,
    erpCatalogNodes: [
      {
        label: "ФЗП",
        full_path: "Административные расходы / ФЗП",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "ADMIN-FZP", account: "26" }],
      },
      {
        label: "ФЗП",
        full_path: "Коммерческие расходы / ФЗП / вариант 1",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "COMM-FZP-1", account: "44.1" }],
      },
      {
        label: "ФЗП",
        full_path: "Коммерческие расходы / ФЗП / вариант 2",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "COMM-FZP-2", account: "44.1" }],
      },
      {
        label: "Маркетинг, реклама",
        full_path: "Коммерческие расходы / Маркетинг, реклама",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "COMM-MARKETING", account: "44.1" }],
      },
    ],
  });
  const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
  assert.equal(pair.target_status, "BLOCKED_TARGET_AMBIGUOUS");
  assert.equal(pair.target_article_erp, "ФЗП");
  assert.equal(pair.target_article_code_erp, "");
  assert.equal(result.counts.proven_intergroup_reposts, 0);
  assert.match(pair.action, /не определён однозначно/);
});

test("proves gross ERP FZP from exact Intalev employee components", () => {
  const catalogs = ["ФЗП", "НДФЛ"].flatMap((article) => [
    {
      label: article,
      full_path: `Административные расходы / ${article}`,
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: `ADMIN-${article}`, account: "Счет затрат 26" }],
    },
    {
      label: article,
      full_path: `Коммерческие расходы / ${article}`,
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: `COMM-${article}`, account: "Счет затрат 44.1" }],
    },
  ]);
  const salary = intalevRow({
    source_row_id: "I-SALARY",
    physical_row: 4224,
    date: "31.01.2025",
    date_value: "2025-01-31",
    debit: "26",
    credit: "70",
    debit_analytics: ["ФЗП АУП", "Заработная плата", "Отдел учета", "Январь"],
    credit_analytics: ["Январь", "Федонина Ирина", "Отдел учета"],
    amount: 49999.9,
    content: "",
  });
  const ndfl = intalevRow({
    ...salary,
    source_row_id: "I-NDFL",
    physical_row: 4225,
    debit_analytics: ["ФЗП АУП", "НДФЛ", "Отдел учета", "Январь"],
    amount: 6217,
  });
  const result = matchCrossJournalRows({
    intalevRows: [salary, ndfl],
    erpRows: [erpRow({
      source_row_id: "E-FZP",
      physical_row: 2151,
      date: "31.01.2025",
      date_value: "2025-01-31",
      debit: "26",
      credit: "70.1",
      debit_analytics: ["ФЗП"],
      credit_analytics: ["Федонина Ирина Валентиновна"],
      article: "ФЗП",
      disclosure: "Счет затрат 44.1",
      analytics3: "44.1 счет",
      amount: 56216.9,
      content: "",
    })],
    period: "2025-01",
    intalevCatalogNodes: [{ name: "ФЗП АУП", full_path: "Расходы / 2_Административные расходы / ФЗП АУП" }],
    erpCatalogNodes: catalogs,
  });
  assert.equal(result.counts.payroll_composite_pairs, 1);
  const pair = result.rows.find((row) => row.row_type === "PAYROLL_COMPOSITE_PAIR");
  assert.equal(pair.source_block_erp, "коммерческие расходы");
  assert.equal(pair.target_block_intalev, "административные расходы");
  assert.equal(pair.target_article_code_erp, "ADMIN-ФЗП");
  assert.equal(pair.amount, 56216.9);
});

test("reserves physical Intalev payroll rows and does not reuse one composite for duplicate ERP rows", () => {
  const salary = intalevRow({
    source_row_id: "I-SALARY",
    physical_row: 4224,
    date: "31.01.2025",
    date_value: "2025-01-31",
    debit: "26",
    credit: "70",
    debit_analytics: ["ФЗП АУП", "Заработная плата", "Отдел учета", "Январь"],
    credit_analytics: ["Январь", "Федонина Ирина", "Отдел учета"],
    amount: 49999.9,
    content: "",
  });
  const ndfl = intalevRow({
    ...salary,
    source_row_id: "I-NDFL",
    physical_row: 4225,
    debit_analytics: ["ФЗП АУП", "НДФЛ", "Отдел учета", "Январь"],
    amount: 6217,
  });
  const erpSalary = erpRow({
    source_row_id: "E-FZP-1",
    physical_row: 2151,
    date: "31.01.2025",
    date_value: "2025-01-31",
    debit: "44.1",
    credit: "70.1",
    debit_analytics: ["ФЗП"],
    credit_analytics: ["Федонина Ирина Валентиновна"],
    article: "ФЗП",
    amount: 56216.9,
    content: "",
  });
  const result = matchCrossJournalRows({
    intalevRows: [salary, ndfl],
    erpRows: [
      erpSalary,
      { ...erpSalary, source_row_id: "E-FZP-2", physical_row: 2152 },
    ],
    period: "2025-01",
    intalevCatalogNodes: [{
      name: "ФЗП АУП",
      full_path: "Расходы / 2_Административные расходы / ФЗП АУП",
    }],
    erpCatalogNodes: [
      {
        label: "ФЗП",
        full_path: "Административные расходы / ФЗП",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "ADMIN-FZP", account: "26" }],
      },
      {
        label: "ФЗП",
        full_path: "Коммерческие расходы / ФЗП",
        exact_catalog_entry_node: true,
        catalog_entries: [{ code: "COMM-FZP", account: "44.1" }],
      },
    ],
  });
  const payrollPairs = result.rows.filter((row) => row.row_type === "PAYROLL_COMPOSITE_PAIR");
  assert.equal(payrollPairs.length, 1);
  assert.equal(payrollPairs[0].intalev_source_row_id, "I-SALARY | I-NDFL");
  assert.equal(result.counts.payroll_intalev_reuse_conflicts, 1);
  assert.equal(result.counts.reused_intalev_rows, 0);
  assert.equal(result.counts.reused_erp_rows, 0);
});

test("proves NDFL group by employee, date and exact amount", () => {
  const result = matchCrossJournalRows({
    intalevRows: [intalevRow({
      source_row_id: "I-COM-NDFL",
      physical_row: 4280,
      date: "31.01.2025",
      date_value: "2025-01-31",
      debit: "44.1.1",
      credit: "70",
      debit_analytics: ["ФЗП коммерческого персонала", "НДФЛ", "Коммерческий отдел", "Январь"],
      credit_analytics: ["Январь", "Саитова Анна Сергеевна", "Коммерческий отдел"],
      amount: 9507,
      content: "",
    })],
    erpRows: [erpRow({
      source_row_id: "E-NDFL",
      physical_row: 2982,
      date: "31.01.2025",
      date_value: "2025-01-31",
      debit: "70.1",
      credit: "68.2",
      debit_analytics: ["Саитова Анна Сергеевна"],
      credit_analytics: ["НДФЛ", "Налог на доходы физических лиц"],
      article: "НДФЛ",
      disclosure: "Счет затрат 26",
      analytics3: "26 счет",
      amount: 9507,
      content: "",
    })],
    period: "2025-01",
    intalevCatalogNodes: [{ name: "ФЗП коммерческого персонала", full_path: "Расходы / 3_Коммерческие расходы / ФЗП коммерческого персонала" }],
    erpCatalogNodes: [
      { label: "НДФЛ", full_path: "Административные расходы / НДФЛ", exact_catalog_entry_node: true, catalog_entries: [{ code: "ADMIN-NDFL", account: "26" }] },
      { label: "НДФЛ", full_path: "Коммерческие расходы / НДФЛ", exact_catalog_entry_node: true, catalog_entries: [{ code: "COMM-NDFL", account: "44.1" }] },
    ],
  });
  assert.equal(result.counts.payroll_component_pairs, 1);
  const pair = result.rows.find((row) => row.row_type === "PAYROLL_COMPONENT_PAIR");
  assert.equal(pair.source_block_erp, "административные расходы");
  assert.equal(pair.target_block_intalev, "коммерческие расходы");
  assert.equal(pair.target_article_code_erp, "COMM-NDFL");
});

test("APPROVAL-003: УТВЕРЖДАЮ overrides the automatic target before production A22 selection", () => {
  const fixture = approvedIntergroupFixture();
  const document = approvalDocument([
    approvalDecision({
      proposedArticle: "Обучение сотрудников",
      proposedCode: "COMM-TRAINING",
    }),
  ], fixture.erpCatalogNodes);
  const result = matchCrossJournalRows({
    ...fixture,
    articleApprovalDocument: document,
  });
  const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
  assert.equal(pair.article_approval_status, "APPROVED_EXACT_SCOPE");
  assert.equal(pair.target_article_erp, "Обучение сотрудников");
  assert.equal(pair.target_article_code_erp, "COMM-TRAINING");
  assert.equal(pair.target_status, "APPROVED_EXACT_SCOPE_TARGET");
  assert.equal(pair.financial_gate_status, "ДОКАЗАНО");
  assert.deepEqual(pair.correction_rows.map((row) => row.amount), [-100, 100]);
  assert.deepEqual(pair.correction_rows.map((row) => row.article_code), ["ADMIN-FZP", "COMM-TRAINING"]);
  assert.equal(pair.posting_rows, 0);
  assert.equal(pair.live_rows, 0);
  assert.equal(pair.executed_rows, 0);
  assert.equal(result.counts.approved_balanced_pairs, 1);
});

test("APPROVAL-003: ИЗМЕНИТЬ uses only the exact corrected target", () => {
  const fixture = approvedIntergroupFixture();
  const document = approvalDocument([
    approvalDecision({
      decision: "ИЗМЕНИТЬ",
      correctedBlock: "Коммерческие расходы",
      correctedArticle: "Обучение сотрудников",
      correctedCode: "COMM-TRAINING",
      comment: "Исправлено пользователем",
    }),
  ], fixture.erpCatalogNodes);
  const result = matchCrossJournalRows({
    ...fixture,
    articleApprovalDocument: document,
  });
  const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
  assert.equal(pair.article_approval_decision, "ИЗМЕНИТЬ");
  assert.equal(pair.target_article_code_erp, "COMM-TRAINING");
  assert.equal(pair.financial_gate_status, "ДОКАЗАНО");
});

for (const [decision, expectedStatus, expectedReason] of [
  ["ЗАПРЕТИТЬ", "FORBIDDEN", "APPROVAL_FORBIDDEN"],
  ["НУЖНА ПРОВЕРКА", "APPROVAL_NOT_FINAL", "APPROVAL_NOT_FINAL"],
  ["ПРЕДЛОЖЕНО ДВИЖКОМ", "APPROVAL_NOT_FINAL", "APPROVAL_NOT_FINAL"],
]) {
  test(`APPROVAL-003: ${decision} creates visible СПОРНО and zero financial pair`, () => {
    const fixture = approvedIntergroupFixture();
    const document = approvalDocument([
      approvalDecision({ decision }),
    ], fixture.erpCatalogNodes);
    const result = matchCrossJournalRows({
      ...fixture,
      articleApprovalDocument: document,
    });
    const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
    assert.equal(pair.article_approval_status, expectedStatus);
    assert.equal(pair.financial_gate_status, "СПОРНО");
    assert.equal(pair.financial_gate_reason, expectedReason);
    assert.match(pair.classification, /^СПОРНО \/ /u);
    assert.deepEqual(pair.correction_rows, []);
    assert.equal(result.counts.approved_balanced_pairs, 0);
    assert.equal(result.counts.financial_pair_rows, 0);
    assert.equal(result.counts.posting_rows, 0);
  });
}

test("APPROVAL-003: non-final decisions stay terminal when source and automatic target are identical", () => {
  const catalogs = [{
    label: "ФЗП",
    full_path: "Коммерческие расходы / ФЗП",
    exact_catalog_entry_node: true,
    catalog_entries: [{ code: "COMM-FZP", account: "44.1" }],
  }];
  const fixture = {
    intalevRows: [intalevRow({
      source_row_id: "I-SAME-TARGET",
      physical_row: 1700,
      debit: "44.1",
      credit: "70.1",
      debit_analytics: ["ФЗП", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      amount: 100,
      content: "Начисление сотруднику А",
    })],
    erpRows: [erpRow({
      source_row_id: "E-SAME-TARGET",
      physical_row: 1900,
      debit: "44.1",
      credit: "70.1",
      debit_analytics: ["ФЗП", "Сотрудник А"],
      credit_analytics: ["Сотрудник А"],
      article: "ФЗП",
      disclosure: "Счет затрат 44.1",
      analytics3: "44.1 счет",
      amount: 100,
      content: "Начисление сотруднику А",
    })],
    period: "2025-01",
    intalevCatalogNodes: [{
      name: "ФЗП",
      full_path: "Расходы / 3_Коммерческие расходы / ФЗП",
    }],
    erpCatalogNodes: catalogs,
    articleApprovalScope: approvalScope,
    allowedPhysicalOrganizations: ["Сахалин"],
  };
  for (const [decision, expectedStatus, expectedReason] of [
    ["ЗАПРЕТИТЬ", "FORBIDDEN", "APPROVAL_FORBIDDEN"],
    ["НУЖНА ПРОВЕРКА", "APPROVAL_NOT_FINAL", "APPROVAL_NOT_FINAL"],
    ["ПРЕДЛОЖЕНО ДВИЖКОМ", "APPROVAL_NOT_FINAL", "APPROVAL_NOT_FINAL"],
  ]) {
    const document = approvalDocument([
      approvalDecision({
        block: "Коммерческие расходы",
        article: "ФЗП",
        decision,
      }),
    ], catalogs);
    const result = matchCrossJournalRows({
      ...fixture,
      articleApprovalDocument: document,
    });
    const pair = result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
    assert.equal(pair.article_approval_status, expectedStatus, decision);
    assert.equal(pair.financial_gate_status, "СПОРНО", decision);
    assert.equal(pair.financial_gate_reason, expectedReason, decision);
    assert.match(pair.classification, /^СПОРНО \/ /u, decision);
    assert.deepEqual(pair.correction_rows, [], decision);
    assert.equal(pair.financial_pair_rows, 0, decision);
    assert.equal(result.counts.approved_balanced_pairs, 0, decision);
    assert.equal(result.counts.financial_pair_rows, 0, decision);
    if (decision === "ЗАПРЕТИТЬ") {
      assert.equal(pair.target_status, "APPROVAL_FORBIDDEN");
      assert.equal(pair.target_selection_basis, "APPROVAL_FORBIDDEN");
      assert.equal(pair.target_block_intalev, "");
      assert.equal(pair.target_article_erp, "");
      assert.equal(pair.target_article_code_erp, "");
      assert.equal(pair.target_catalog_path, "");
      assert.equal(pair.target_operating_account, "");
      assert.equal(
        pair.action,
        "СПОРНО: сопоставление запрещено пользователем; автоматическая цель не применяется",
      );
      assert.doesNotMatch(pair.classification, /ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ/u);
      assert.doesNotMatch(pair.action, /подтверж|автоматическая цель применяется/iu);
    }
  }
});

test("APPROVAL-003: composite physical proof requires one consistent approved target", () => {
  const catalogs = [
    { label: "ФЗП", full_path: "Административные расходы / ФЗП", exact_catalog_entry_node: true, catalog_entries: [{ code: "ADMIN-FZP", account: "26" }] },
    { label: "ФЗП", full_path: "Коммерческие расходы / ФЗП", exact_catalog_entry_node: true, catalog_entries: [{ code: "COMM-FZP", account: "44.1" }] },
    { label: "НДФЛ", full_path: "Административные расходы / НДФЛ", exact_catalog_entry_node: true, catalog_entries: [{ code: "ADMIN-NDFL", account: "26" }] },
  ];
  const salary = intalevRow({
    source_row_id: "I-COMP-SALARY",
    physical_row: 1001,
    date: "31.01.2025",
    date_value: "2025-01-31",
    debit: "26",
    credit: "70",
    debit_analytics: ["ФЗП АУП Зарплата", "Заработная плата"],
    credit_analytics: ["Иванов Иван"],
    amount: 80,
    content: "",
  });
  const tax = intalevRow({
    ...salary,
    source_row_id: "I-COMP-TAX",
    physical_row: 1002,
    debit_analytics: ["ФЗП АУП НДФЛ", "НДФЛ"],
    amount: 20,
  });
  const decisions = [
    approvalDecision({
      block: "Административные расходы",
      article: "ФЗП АУП Зарплата",
      proposedBlock: "Административные расходы",
      proposedArticle: "ФЗП",
      proposedCode: "ADMIN-FZP",
    }),
    approvalDecision({
      block: "Административные расходы",
      article: "ФЗП АУП НДФЛ",
      proposedBlock: "Административные расходы",
      proposedArticle: "НДФЛ",
      proposedCode: "ADMIN-NDFL",
    }),
  ];
  const document = approvalDocument(decisions, catalogs);
  const result = matchCrossJournalRows({
    intalevRows: [salary, tax],
    erpRows: [erpRow({
      source_row_id: "E-COMP",
      physical_row: 2001,
      date: "31.01.2025",
      date_value: "2025-01-31",
      debit: "44.1",
      credit: "70.1",
      debit_analytics: ["ФЗП"],
      credit_analytics: ["Иванов Иван"],
      article: "ФЗП",
      disclosure: "Счет затрат 44.1",
      analytics3: "44.1 счет",
      amount: 100,
      content: "",
    })],
    period: "2025-01",
    intalevCatalogNodes: [
      { name: "ФЗП АУП Зарплата", full_path: "Расходы / 2_Административные расходы / ФЗП АУП Зарплата" },
      { name: "ФЗП АУП НДФЛ", full_path: "Расходы / 2_Административные расходы / ФЗП АУП НДФЛ" },
    ],
    erpCatalogNodes: catalogs,
    articleApprovalDocument: document,
    articleApprovalScope: approvalScope,
    allowedPhysicalOrganizations: ["Сахалин"],
  });
  const pair = result.rows.find((row) => row.row_type === "PAYROLL_COMPOSITE_PAIR");
  assert.equal(pair.article_approval_status, "APPROVAL_COMPOSITE_TARGET_CONFLICT");
  assert.equal(pair.financial_gate_reason, "APPROVAL_COMPOSITE_TARGET_CONFLICT");
  assert.deepEqual(pair.correction_rows, []);
  assert.equal(result.counts.approved_balanced_pairs, 0);
});
