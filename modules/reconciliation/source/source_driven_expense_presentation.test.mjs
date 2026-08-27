import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceDrivenExpensePresentationRows,
  insertSourceDrivenExpenseRows,
  sourceBusinessLabelKey,
} from "./source_driven_expense_presentation.mjs";

function node({ id, parent = "", label, total, row, group = false }) {
  return {
    node_id: id,
    parent_node_id: parent,
    label,
    name: label,
    full_path: label,
    level: 0,
    is_group: group,
    direct_total: total,
    source: {
      file: "source.xlsx",
      sheet: "TDSheet",
      row,
      source_cell: `E${row}`,
    },
  };
}

function parsed(period, nodes) {
  return { period, hierarchy_tree: { nodes } };
}

test("normalizes numbered Intalev block names to ERP block names", () => {
  assert.equal(
    sourceBusinessLabelKey("3_Коммерческие расходы"),
    sourceBusinessLabelKey("Коммерческие расходы"),
  );
  assert.equal(sourceBusinessLabelKey("ФЗП"), sourceBusinessLabelKey("Заработная плата"));
  assert.equal(sourceBusinessLabelKey("ТЭУ (внутренние)"), sourceBusinessLabelKey("ТЭУ (внутренние) ТК"));
  assert.equal(sourceBusinessLabelKey("ПРР внешние"), sourceBusinessLabelKey("Погрузочно-разгрузочные работы"));
});

test("adds a missing commercial branch and applies proven business aliases", () => {
  const intalevNodes = [
    node({ id: "i-root", label: "Расходы по основной деятельности ИТОГО", total: 1000, row: 1, group: true }),
    node({ id: "i-articles", parent: "i-root", label: "_Статьи ОПиУ 2025", total: 1000, row: 2, group: true }),
    node({ id: "i-admin", parent: "i-articles", label: "2_Административные расходы", total: 300, row: 3, group: true }),
    node({ id: "i-commercial", parent: "i-articles", label: "3_Коммерческие расходы", total: 700, row: 4, group: true }),
    node({ id: "i-marketing", parent: "i-commercial", label: "Реклама и прочий маркетинг", total: 100, row: 5, group: true }),
    node({ id: "i-banner", parent: "i-marketing", label: "Баннер", total: 100, row: 6 }),
    node({ id: "i-tax", parent: "i-commercial", label: "Налоги зарплатные", total: 600, row: 7 }),
  ];
  const erpNodes = [
    node({ id: "e-root", label: "Расходы по основной деятельности ИТОГО", total: 950, row: 10, group: true }),
    node({ id: "e-commercial", parent: "e-root", label: "Коммерческие расходы", total: 650, row: 11, group: true }),
    node({ id: "e-banner", parent: "e-commercial", label: "Баннер", total: 90, row: 12 }),
    node({ id: "e-tax-1", parent: "e-commercial", label: "Налоги зарплатные", total: 500, row: 13 }),
    node({ id: "e-tax-2", parent: "e-commercial", label: "Налоги зарплатные", total: 50, row: 14 }),
    node({ id: "e-only", parent: "e-commercial", label: "Прочее (реклама)", total: 10, row: 15 }),
  ];
  const result = buildSourceDrivenExpensePresentationRows({
    coreRows: [{
      code: "R001",
      hierarchy_node_id: "i-admin",
      hierarchy_path: ["Расходы по основной деятельности ИТОГО", "_Статьи ОПиУ 2025", "2_Административные расходы"],
    }],
    intalevParsed: [parsed("2025-01", intalevNodes)],
    erpParsed: [parsed("2025-01", erpNodes)],
  });

  const commercial = result.rows.find((row) => row.intalev_label === "3_Коммерческие расходы");
  assert.ok(commercial);
  assert.equal(commercial.intalev.amount, 700);
  assert.equal(commercial.erp.amount, 650);
  assert.equal(commercial.correction_authority, false);

  const banner = result.rows.find((row) => row.intalev_label === "Баннер");
  assert.equal(banner.intalev.amount, 100);
  assert.equal(banner.erp.amount, 90);
  assert.equal(banner.erp_binding_status, "PROVEN");

  const taxes = result.rows.find((row) => row.intalev_label === "Налоги зарплатные");
  assert.equal(taxes.erp.amount, 550);
  assert.equal(taxes.erp.status, "MATCHED_DUPLICATE_HIERARCHY");

  const marketing = result.rows.find((row) => row.intalev_label === "Реклама и прочий маркетинг");
  assert.ok(marketing);
  assert.equal(marketing.erp.amount, 100);
  assert.equal(marketing.erp_binding_status, "PROVEN");
  assert.equal(result.rows.some((row) => row.erp_only_article_row), false);
  assert.equal(result.audit[0].posting_rows, 0);
});

test("rolls an ERP leaf through the real Intalev article ancestors", () => {
  const intalevNodes = [
    node({ id: "i-root", label: "Расходы по основной деятельности ИТОГО", total: 700, row: 1, group: true }),
    node({ id: "i-articles", parent: "i-root", label: "_Статьи ОПиУ 2025", total: 700, row: 2, group: true }),
    node({ id: "i-commercial", parent: "i-articles", label: "3_Коммерческие расходы", total: 700, row: 3, group: true }),
    node({ id: "i-payroll", parent: "i-commercial", label: "ФЗП и компенсационные выплаты", total: 700, row: 4, group: true }),
    node({ id: "i-blank", parent: "i-payroll", label: "<пустое значение>", total: 700, row: 5, group: true }),
    node({ id: "i-ndfl", parent: "i-blank", label: "НДФЛ", total: 200, row: 6 }),
    node({ id: "i-salary", parent: "i-blank", label: "Заработная плата", total: 500, row: 7 }),
  ];
  const erpNodes = [
    node({ id: "e-root", label: "Расходы по основной деятельности ИТОГО", total: 680, row: 10, group: true }),
    node({ id: "e-commercial", parent: "e-root", label: "Коммерческие расходы", total: 680, row: 11, group: true }),
    node({ id: "e-ndfl", parent: "e-commercial", label: "НДФЛ", total: 180, row: 12 }),
    node({ id: "e-salary", parent: "e-commercial", label: "Заработная плата", total: 500, row: 13 }),
  ];
  const result = buildSourceDrivenExpensePresentationRows({
    coreRows: [],
    intalevParsed: [parsed("2025-01", intalevNodes)],
    erpParsed: [parsed("2025-01", erpNodes)],
  });
  const payroll = result.rows.find((row) => row.intalev_label === "ФЗП и компенсационные выплаты");
  const blank = result.rows.find((row) => row.intalev_label === "<пустое значение>");
  const ndfl = result.rows.find((row) => row.intalev_label === "НДФЛ");
  assert.equal(payroll.erp.amount, 680);
  assert.equal(blank.erp.amount, 680);
  assert.equal(ndfl.erp.amount, 180);
});

test("inserts source-driven blocks after the complete R001 subtree", () => {
  const core = [
    { code: "R001", presentation_outline_level: 0 },
    { code: "R002", presentation_outline_level: 1 },
    { code: "R003", presentation_outline_level: 2 },
    { code: "R043", presentation_outline_level: 0 },
  ];
  const supplemental = [{ code: "S001", presentation_outline_level: 0 }];
  assert.deepEqual(
    insertSourceDrivenExpenseRows(core, supplemental).map((row) => row.code),
    ["R001", "R002", "R003", "S001", "R043"],
  );
});

test("matches a unique same-name same-amount Intalev leaf outside the article tree to the ERP block", () => {
  const intalevRoot = node({ id: "i-root", label: "Расходы по основной деятельности ИТОГО", total: 23_299.34, row: 1, group: true });
  const unclassifiedParent = node({ id: "i-empty", parent: "i-root", label: "<пустое значение>", total: 23_299.34, row: 2, group: true });
  const unclassifiedLeaf = node({ id: "i-defect", parent: "i-empty", label: "Брак с торговой точки", total: 23_299.34, row: 3 });
  unclassifiedLeaf.full_path = "Расходы по основной деятельности ИТОГО / <пустое значение> / Брак с торговой точки";
  const articles = node({ id: "i-articles", parent: "i-root", label: "_Статьи ОПиУ 2025", total: 0, row: 4, group: true });
  const commercial = node({ id: "i-commercial", parent: "i-articles", label: "3_Коммерческие расходы", total: 0, row: 5, group: true });
  const erpRoot = node({ id: "e-root", label: "Расходы по основной деятельности ИТОГО", total: 23_299.34, row: 10, group: true });
  const erpCommercial = node({ id: "e-commercial", parent: "e-root", label: "Коммерческие расходы", total: 23_299.34, row: 11, group: true });
  const erpDefect = node({ id: "e-defect", parent: "e-commercial", label: "Брак с торговой точки", total: 23_299.34, row: 12 });
  const result = buildSourceDrivenExpensePresentationRows({
    coreRows: [],
    intalevParsed: [parsed("2025-01", [intalevRoot, unclassifiedParent, unclassifiedLeaf, articles, commercial])],
    erpParsed: [parsed("2025-01", [erpRoot, erpCommercial, erpDefect])],
  });
  const matched = result.rows.find((row) => row.erp_label === "Брак с торговой точки");
  assert.equal(matched.intalev.amount, 23_299.34);
  assert.equal(matched.erp.amount, 23_299.34);
  assert.equal(matched.unclassified_exact_match_binding, true);
  assert.equal(matched.erp_binding_status, "PROVEN");
  assert.equal(matched.erp_only_article_row, undefined);
  assert.equal(result.audit[0].exact_unclassified_article_bindings, 1);
  assert.equal(result.audit[0].erp_only_article_groups, 0);
});
