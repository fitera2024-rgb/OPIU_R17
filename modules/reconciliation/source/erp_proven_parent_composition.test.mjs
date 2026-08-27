import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProvenErpCompositionAlias,
  resolveProvenErpPresentationParent,
  resolveProvenErpTemplateParentComposition,
} from "./erp_proven_parent_composition.mjs";

const SHA = "A".repeat(64);

function row({ period, row, article, summaryLabel, catalogPath, fullPath, amount }) {
  return {
    period,
    article,
    summary_label: summaryLabel,
    catalog_path: catalogPath,
    full_path: fullPath,
    amount,
    sha256: SHA,
    sheet: "ERP",
    source_cell: `${period.endsWith("10") ? "L" : "D"}${row}`,
    source_identity: `${SHA}|ERP|${row}`,
    source_identity_scope: `${SHA}|ERP|${period}`,
    period_header_trace: { period },
  };
}

function fixture({
  period,
  parentLabel,
  branchLabel,
  prefix,
  parentAmount,
  componentAmounts,
}) {
  const root = `Отчет / ${branchLabel}`;
  return {
    templateRow: {
      code: "R900",
      intalev_label: parentLabel,
      erp_label: "",
      intalev_reference_path_labels: [branchLabel, parentLabel],
    },
    parsed: {
      period,
      rows: [
        row({
          period,
          row: 10,
          article: parentLabel,
          catalogPath: `${prefix} | ${prefix} / ${parentLabel}`,
          fullPath: `${root} / ${parentLabel}`,
          amount: parentAmount,
        }),
        ...componentAmounts.map((amount, index) => row({
          period,
          row: 11 + index,
          article: `Компонент ${index + 1}`,
          catalogPath: `${prefix} / Компонент ${index + 1}`,
          fullPath: `${root} / Компонент ${index + 1}`,
          amount,
        })),
      ],
    },
  };
}

test("generic proven ERP parent composition reconstructs an October parent from terminal catalog rows", () => {
  const input = fixture({
    period: "2025-10",
    parentLabel: "Финансовые расходы",
    branchLabel: "Расходы по финансовой деятельности",
    prefix: "Административные расходы / Финансовые расходы",
    parentAmount: 19623,
    componentAmounts: [10644, 8979],
  });
  const result = resolveProvenErpTemplateParentComposition(input.templateRow, input.parsed);

  assert.equal(result.status, "PROVEN_ERP_PARENT_COMPOSITION");
  assert.equal(result.amount, 19623);
  assert.equal(result.trace[0].exact_parent_summary, true);
  assert.equal(result.component_rows.every((item) => item.exact_parent_component === true), true);
  assert.equal(result.correction_authority, false);
});

test("the same generic resolver works for a different organization-shaped branch and period", () => {
  const input = fixture({
    period: "2026-02",
    parentLabel: "Логистические расходы",
    branchLabel: "Реализационные расходы",
    prefix: "Центр Хабаровск / Логистика",
    parentAmount: 125.5,
    componentAmounts: [100.25, 25.25],
  });
  const result = resolveProvenErpTemplateParentComposition(input.templateRow, input.parsed);

  assert.equal(result.status, "PROVEN_ERP_PARENT_COMPOSITION");
  assert.equal(result.amount, 125.5);
  assert.equal(result.component_rows.length, 2);
  assert.equal(result.component_source_cells.every((cell) => cell.startsWith("D")), true);
});

test("generic resolver blocks duplicate summary and non-additive component composition", () => {
  const duplicate = fixture({
    period: "2026-02",
    parentLabel: "Логистика",
    branchLabel: "Реализационные расходы",
    prefix: "Блок / Логистика",
    parentAmount: 100,
    componentAmounts: [100],
  });
  duplicate.parsed.rows.push({
    ...duplicate.parsed.rows[0],
    source_cell: "D99",
    source_identity: `${SHA}|ERP|99`,
  });
  assert.equal(
    resolveProvenErpTemplateParentComposition(duplicate.templateRow, duplicate.parsed).status,
    "BLOCKED_ERP_PARENT_COMPOSITION_SUMMARY_NOT_EXACT",
  );

  const mismatch = fixture({
    period: "2026-02",
    parentLabel: "Логистика",
    branchLabel: "Реализационные расходы",
    prefix: "Блок / Логистика",
    parentAmount: 100,
    componentAmounts: [90],
  });
  assert.equal(
    resolveProvenErpTemplateParentComposition(mismatch.templateRow, mismatch.parsed).status,
    "BLOCKED_ERP_PARENT_COMPOSITION_AMOUNT_MISMATCH",
  );
});

test("generic presentation-parent resolver selects the unique source parent over a same-label leaf", () => {
  const period = "2025-10";
  const leaf = row({
    period,
    row: 175,
    article: "Расходы по финансовой деятельности",
    catalogPath: "Финансовые расходы",
    fullPath: "Отчет / Итоги / Расходы по финансовой деятельности",
    amount: -15283805.26,
  });
  leaf.child_indexes = [];
  const parent = row({
    period,
    row: 182,
    article: "",
    summaryLabel: "Расходы по финансовой деятельности",
    catalogPath: "Финансовые расходы",
    fullPath: "Отчет / Итоги / Расходы по финансовой деятельности",
    amount: 15303428.26,
  });
  parent.child_indexes = [2, 3];
  const childOne = row({
    period,
    row: 183,
    article: "Административные расходы",
    catalogPath: "Административные расходы",
    fullPath: "Отчет / Итоги / Расходы по финансовой деятельности / Административные расходы",
    amount: 19623,
  });
  const childTwo = row({
    period,
    row: 187,
    article: "Расходы по финансовой деятельности",
    catalogPath: "Расходы по финансовой деятельности",
    fullPath: "Отчет / Итоги / Расходы по финансовой деятельности / Расходы по финансовой деятельности",
    amount: 15283805.26,
  });
  const parsed = { period, rows: [leaf, parent, childOne, childTwo] };
  const result = resolveProvenErpPresentationParent(
    {
      code: "R900",
      intalev_label: "Расходы по финансовой деятельности",
      intalev_reference_path_labels: ["Итоги", "Расходы по финансовой деятельности"],
    },
    parsed,
    { templateHasChildren: true },
  );
  assert.equal(result.status, "PROVEN_ERP_PRESENTATION_PARENT");
  assert.equal(result.amount, 15303428.26);
  assert.equal(result.source_cell, "L182");
  assert.equal(result.correction_authority, false);
});

test("presentation-parent resolver stays generic for a second period and blocks two source parents", () => {
  const period = "2026-02";
  const leaf = row({
    period,
    row: 20,
    article: "Логистические расходы",
    catalogPath: "Логистика",
    fullPath: "Отчет / Реализационные расходы / Логистические расходы",
    amount: -50,
  });
  leaf.child_indexes = [];
  const parent = row({
    period,
    row: 30,
    article: "Логистические расходы",
    catalogPath: "Логистика",
    fullPath: "Отчет / Реализационные расходы / Логистические расходы",
    amount: 125.5,
  });
  parent.child_indexes = [2];
  const child = row({
    period,
    row: 31,
    article: "Доставка",
    catalogPath: "Логистика / Доставка",
    fullPath: "Отчет / Реализационные расходы / Логистические расходы / Доставка",
    amount: 125.5,
  });
  const parsed = { period, rows: [leaf, parent, child] };
  const template = {
    code: "R901",
    intalev_label: "Логистические расходы",
    intalev_reference_path_labels: ["Реализационные расходы", "Логистические расходы"],
  };
  assert.equal(
    resolveProvenErpPresentationParent(template, parsed, { templateHasChildren: true }).amount,
    125.5,
  );
  parsed.rows.push({ ...parent, source_cell: "D40", source_identity: `${SHA}|ERP|40` });
  assert.equal(
    resolveProvenErpPresentationParent(template, parsed, { templateHasChildren: true }).status,
    "BLOCKED_ERP_PRESENTATION_PARENT_NOT_EXACT",
  );
});

test("composition alias shares one exact component set without a second economic consumption", () => {
  const input = fixture({
    period: "2026-02",
    parentLabel: "Административные расходы",
    branchLabel: "Расходы по финансовой деятельности",
    prefix: "Административные расходы / Финансовые расходы",
    parentAmount: 125.5,
    componentAmounts: [100.25, 25.25],
  });
  input.parsed.rows.forEach((item, index) => {
    item.parent_index = index === 0 ? 9 : 10;
  });
  const parent = resolveProvenErpTemplateParentComposition(input.templateRow, input.parsed);
  const alias = row({
    period: "2026-02",
    row: 50,
    article: "Финансовые расходы",
    catalogPath: "Финансовые расходы | Административные расходы / Финансовые расходы",
    fullPath: "Отчет / Расходы по финансовой деятельности / Финансовые расходы",
    amount: 125.5,
  });
  alias.parent_index = 9;
  input.parsed.rows.push(alias);
  const result = resolveProvenErpCompositionAlias(
    { code: "R902", intalev_label: "Финансовые расходы" },
    input.parsed,
    parent,
  );
  assert.equal(result.status, "PROVEN_ERP_PARENT_COMPOSITION_ALIAS");
  assert.equal(result.amount, 125.5);
  assert.equal(result.alias_source_cell, "D50");
  assert.deepEqual(result.component_source_cells, parent.component_source_cells);
  assert.equal(result.correction_authority, false);
});
