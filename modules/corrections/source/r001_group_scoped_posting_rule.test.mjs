import assert from "node:assert/strict";
import test from "node:test";

import { buildGroupScopedStornoRepostPlan } from "./r001_group_scoped_posting_rule.mjs";

function operation(overrides = {}) {
  return {
    source_organization: "ООО Планета Витаминов",
    journal_sha256: "A".repeat(64),
    source_sheet: "Лист_1",
    source_range: "B22:AG22",
    source_row_id: "B".repeat(64),
    date: "04.01.2025 0:00:00",
    document: "Трансляция 1",
    posting_number: "441",
    debit: "44.1",
    credit: "76.5",
    debit_analytics: ["Орг.техника и комплектующие", "", ""],
    credit_analytics: ["Поставщик", "", ""],
    debit_department: "ПВ ИТ Отдел",
    credit_department: "ПВ ИТ Отдел",
    amount: 10_948,
    article: "Орг.техника и комплектующие",
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    status: "PASS_UNIQUE_GROUP_SCOPED_ERP_ARTICLE",
    article: "Орг.техника и комплектующие",
    article_code: "ЦБ-000247",
    operating_account: "44.1",
    catalog_path: "Коммерческие расходы / Орг.техника и комплектующие",
    ...overrides,
  };
}

test("same-named article from another block changes the code, not the physical D/K route", () => {
  const plan = buildGroupScopedStornoRepostPlan({
    operation: operation(),
    targetArticle: target(),
    sourceOperatingAccount: "26",
    correctionAmount: 10_948,
  });
  assert.equal(plan.storno.debit, "44.1");
  assert.equal(plan.storno.credit, "76.5");
  assert.equal(plan.repost.debit, "44.1");
  assert.equal(plan.repost.credit, "76.5");
  assert.equal(plan.target_article_code, "ЦБ-000247");
});

test("NDFL can be reclassified by article code while D70.1/K68.2 remains exact", () => {
  const plan = buildGroupScopedStornoRepostPlan({
    operation: operation({
      debit: "70.1",
      credit: "68.2",
      debit_analytics: ["Сотрудник", "", ""],
      credit_analytics: ["НДФЛ", "Налог на доходы физических лиц", ""],
      amount: 7_741,
      article: "НДФЛ",
    }),
    targetArticle: target({
      article: "НДФЛ",
      article_code: "00-000121",
      catalog_path: "Коммерческие расходы / НДФЛ",
    }),
    sourceOperatingAccount: "26",
    correctionAmount: 7_741,
  });
  assert.equal(plan.repost.debit, "70.1");
  assert.equal(plan.repost.credit, "68.2");
  assert.equal(plan.target_article_code, "00-000121");
});
