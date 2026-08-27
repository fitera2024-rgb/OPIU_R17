import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGroupScopedStornoRepostPlan,
  catalogNodesFromReconciliationRows,
  selectGroupScopedErpArticle,
} from "./r001_group_scoped_posting_rule.mjs";

function catalogNode(block, account, code) {
  return {
    label: "ФЗП",
    full_path: `Расходы по основной деятельности / ${block} / ФЗП и компенсационные выплаты / ФЗП`,
    source_row: code === "00-000036" ? 125 : 288,
    catalog_entries: [{ code, account, source_row: code === "00-000036" ? 126 : 289 }],
  };
}

function operation(overrides = {}) {
  return {
    source_organization: "ООО УК",
    journal_sha256: "A".repeat(64),
    source_sheet: "Лист_1",
    source_range: "B120:AG120",
    source_row_id: "ROW-120",
    date: "31.10.2025 0:00:00",
    document: "Трансляция 1",
    posting_number: "15",
    debit: "44.1",
    credit: "70.1",
    debit_analytics: ["ФЗП", "Проект", "Направление"],
    credit_analytics: ["Сотрудник", "Договор", ""],
    debit_department: "Административный отдел",
    credit_department: "Административный отдел",
    article: "ФЗП",
    amount: 100000,
    ...overrides,
  };
}

test("same-named FZP is selected only inside the Intalev administrative block", () => {
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26 ФЗП", "00-000036"),
    catalogNode("Коммерческие расходы", "Счет затрат 44.1", "ЦБ-000250"),
  ], {
    intalevPath: "Расходы по основной деятельности / _Статьи ОПиУ 2025 / 1_Административные расходы / ФЗП и компенсационные выплаты / ФЗП",
    blockLabel: "Административные расходы",
    articleLabel: "ФЗП",
  });
  assert.equal(target.article_code, "00-000036");
  assert.equal(target.operating_account, "26");
  assert.match(target.catalog_path, /Административные расходы/);
});

test("presentation note on the Intalev block does not change its catalog identity", () => {
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26 ФЗП", "00-000036"),
  ], {
    intalevPath: "Административные расходы — all-in, включая пустые статьи / ФЗП и компенсационные выплаты / ФЗП",
    blockLabel: "Административные расходы — all-in, включая пустые статьи",
    articleLabel: "ФЗП",
  });
  assert.equal(target.article_code, "00-000036");
  assert.equal(target.operating_account, "26");
});

test("source FZP on account 44 is STORNO and REPOST to administrative FZP on account 26", () => {
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26 ФЗП", "00-000036"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" });
  const plan = buildGroupScopedStornoRepostPlan({
    operation: operation(),
    targetArticle: target,
    settlementAccount: "70",
    sourceOperatingAccount: "44",
  });
  assert.equal(plan.operating_side, "DEBIT");
  assert.equal(plan.target_article_code, "00-000036");
  assert.deepEqual(plan.storno, {
    debit: "44.1",
    credit: "70.1",
    debit_analytics: ["ФЗП", "Проект", "Направление"],
    credit_analytics: ["Сотрудник", "Договор", ""],
    debit_department: "Административный отдел",
    credit_department: "Административный отдел",
    article: "ФЗП",
  });
  assert.equal(plan.repost.debit, "26");
  assert.equal(plan.repost.credit, "70.1");
  assert.deepEqual(plan.repost.debit_analytics, ["ФЗП", "Проект", "Направление"]);
  assert.deepEqual(plan.repost.credit_analytics, ["Сотрудник", "Договор", ""]);
});

test("settlement side is inferred from the hierarchy-bound article analytics", () => {
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26 ФЗП", "00-000036"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" });
  const plan = buildGroupScopedStornoRepostPlan({
    operation: operation(),
    targetArticle: target,
  });
  assert.equal(plan.operating_side, "DEBIT");
  assert.equal(plan.settlement_account, "70.1");
  assert.equal(plan.repost.debit, "26");
});

test("actual direction is preserved when settlement is on debit", () => {
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26 ФЗП", "00-000036"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" });
  const plan = buildGroupScopedStornoRepostPlan({
    operation: operation({
      debit: "70.1",
      credit: "44.1",
      debit_analytics: ["Сотрудник", "Договор", ""],
      credit_analytics: ["ФЗП", "Проект", "Направление"],
    }),
    targetArticle: target,
    settlementAccount: "70",
    sourceOperatingAccount: "44",
  });
  assert.equal(plan.operating_side, "CREDIT");
  assert.equal(plan.repost.debit, "70.1");
  assert.equal(plan.repost.credit, "26");
  assert.deepEqual(plan.repost.credit_analytics, ["ФЗП", "Проект", "Направление"]);
});

test("wrong group, ambiguous target, incomplete physical source and Dt99 fail closed", () => {
  assert.throws(() => selectGroupScopedErpArticle([
    catalogNode("Коммерческие расходы", "Счет затрат 44.1", "ЦБ-000250"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" }), {
    code: "GROUP_SCOPED_ERP_ARTICLE_NOT_FOUND",
  });
  assert.throws(() => selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26", "A"),
    catalogNode("Административные расходы", "Счет затрат 26", "B"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" }), {
    code: "GROUP_SCOPED_ERP_ARTICLE_AMBIGUOUS",
  });
  const target = selectGroupScopedErpArticle([
    catalogNode("Административные расходы", "Счет затрат 26", "00-000036"),
  ], { blockLabel: "Административные расходы", articleLabel: "ФЗП" });
  assert.throws(() => buildGroupScopedStornoRepostPlan({
    operation: operation({ source_row_id: "" }), targetArticle: target, settlementAccount: "70",
  }), { code: "GROUP_SCOPED_PHYSICAL_SOURCE_INCOMPLETE" });
  assert.throws(() => buildGroupScopedStornoRepostPlan({
    operation: operation({ debit: "99" }), targetArticle: target, settlementAccount: "70",
  }), { code: "GROUP_SCOPED_DT99_EXCLUDED" });
});

test("embedded ERP catalog resolves any article by full block path, not a hardcoded FZP list", () => {
  const nodes = catalogNodesFromReconciliationRows([
    {
      __row: 200,
      "Тип": "DETAIL",
      "Статья ERP": "Командировочные",
      "Путь по справочнику ERP": "Административные расходы / Командировочные",
      "Код статьи": "ADMIN-TRAVEL",
      "Счёт/признак счёта": "Счет затрат 26",
    },
    {
      __row: 300,
      "Тип": "DETAIL",
      "Статья ERP": "Командировочные",
      "Путь по справочнику ERP": "Коммерческие расходы / Командировочные",
      "Код статьи": "SALES-TRAVEL",
      "Счёт/признак счёта": "Счет затрат 44.1",
    },
  ]);
  const selected = selectGroupScopedErpArticle(nodes, {
    intalevPath: "ОПИУ / Административные расходы / Командировочные",
    blockLabel: "Административные расходы",
    articleLabel: "Командировочные",
  });
  assert.equal(selected.article_code, "ADMIN-TRAVEL");
  assert.equal(selected.operating_account, "26");
  assert.equal(selected.entry_source_row, 200);
});
