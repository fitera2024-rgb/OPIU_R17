import assert from "node:assert/strict";
import test from "node:test";
import { applyJournalFirstPresentationAttribution } from "./journal_first_presentation_attribution.mjs";

function row(code, intalevLabel, erpLabel, amount, path, extra = {}) {
  return {
    code,
    intalev_label: intalevLabel,
    erp_label: erpLabel,
    hierarchy_path: path,
    intalev: { amount: 100, status: "MATCHED", trace: [{ full_path: path.join(" / ") }] },
    erp: { amount, status: "MATCHED", trace: [{ full_path: path.join(" / ") }] },
    ...extra,
  };
}

function movement(overrides = {}) {
  return {
    row_type: "UNIQUE_PAIR",
    classification: "ОДНА ОПЕРАЦИЯ / РАЗНЫЕ ГРУППЫ / МЕЖГРУППОВОЙ ПЕРЕСОРТ",
    confidence: 100,
    target_status: "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK",
    source_block_erp: "Административные расходы",
    target_block_intalev: "Коммерческие расходы",
    article_erp: "Абонентское обслуживание ПО",
    target_article_erp: "Прочие коммерческие расходы",
    source_amount: 25,
    amount: 25,
    erp_source_row_id: "ERP-1",
    erp_rows: "100",
    intalev_rows: "200",
    reused: false,
    ...overrides,
  };
}

test("moves only proven journal amounts and conserves the ERP total", () => {
  const result = applyJournalFirstPresentationAttribution([
    row("R012", "Прочие коммерческие расходы", "", 40, ["Коммерческие расходы", "Прочие коммерческие расходы"]),
    row("R020", "", "Абонентское обслуживание ПО", 60, ["Административные расходы", "Абонентское обслуживание ПО"], { erp_only_article_row: true }),
    row("S146", "Прочие административные расходы", "", 12, ["Расходы на складскую логистику", "Прочие административные расходы"]),
  ], { rows: [movement()], sources: { erp: { path: "journal.xlsx", sheet: "Лист_1" } } });
  assert.equal(result.rows.find((item) => item.code === "R012").erp.amount, 65);
  assert.equal(result.rows.find((item) => item.code === "R020").erp.amount, 35);
  assert.equal(result.audit.total_conserved, true);
  assert.equal(result.audit.applied_amount, 25);
});

test("does not move an operation when source and target already resolve to one presentation row", () => {
  const result = applyJournalFirstPresentationAttribution([
    row("R016", "Почтовые расходы", "Почтовые расходы", 31.82, ["Административные расходы", "Почтовые расходы"]),
  ], { rows: [movement({
    article_erp: "Почтовые расходы",
    target_article_erp: "Почтовые расходы",
  })] });
  assert.equal(result.rows[0].erp.amount, 31.82);
  assert.equal(result.audit.applied_pairs, 0);
  assert.equal(result.audit.total_conserved, true);
});

test("fails closed when a journal amount exceeds the report article", () => {
  const result = applyJournalFirstPresentationAttribution([
    row("R012", "Прочие коммерческие расходы", "", 40, ["Коммерческие расходы", "Прочие коммерческие расходы"]),
    row("R020", "", "Абонентское обслуживание ПО", 10, ["Административные расходы", "Абонентское обслуживание ПО"], { erp_only_article_row: true }),
  ], { rows: [movement({ source_amount: 25 })] });
  assert.equal(result.audit.applied_pairs, 0);
  assert.equal(result.unresolved[0].reason, "JOURNAL_AMOUNT_EXCEEDS_REPORT_ARTICLE");
});

test("rejects reuse of one physical ERP source row", () => {
  const result = applyJournalFirstPresentationAttribution([
    row("R012", "Прочие коммерческие расходы", "", 40, ["Коммерческие расходы", "Прочие коммерческие расходы"]),
    row("R020", "", "Абонентское обслуживание ПО", 60, ["Административные расходы", "Абонентское обслуживание ПО"], { erp_only_article_row: true }),
  ], { rows: [movement(), movement({ amount: 5, source_amount: 5 })] });
  assert.equal(result.audit.applied_operation_rows, 1);
  assert.equal(result.unresolved[0].reason, "ERP_SOURCE_ROW_REUSED");
});

test("binds an ERP article under the proven live Intalev group without moving its amount", () => {
  const result = applyJournalFirstPresentationAttribution([
    row("R019", "Расходы ИТ", "", 41147.36, ["Административные расходы", "Расходы ИТ"], {
      presentation_outline_level: 1,
    }),
    row("R020", "", "Абонентское обслуживание ПО", 22574.31, ["Административные расходы", "Абонентское обслуживание ПО"]),
  ], { rows: [movement({
    classification: "ОДНА ОПЕРАЦИЯ / СТАТЬЯ ERP ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ",
    source_block_erp: "Административные расходы",
    target_block_intalev: "Административные расходы",
    intalev_report_block: "Административные расходы",
    intalev_report_group: "Расходы ИТ",
    intalev_report_leaf: "Контур.Диадок",
    intalev_report_path: "Расходы / _Статьи ОПиУ 2025 / 2_Административные расходы / Расходы ИТ / Контур.Диадок",
    intalev_report_placement_status: "PROVEN_LIVE_REPORT_LEAF_EXACT_AMOUNT",
    article_erp: "Абонентское обслуживание ПО",
    target_article_erp: "Абонентское обслуживание ПО",
    source_amount: 11465.3,
  })] });
  const bound = result.rows.find((item) => item.code === "R020");
  assert.equal(bound.erp.amount, 22574.31);
  assert.equal(bound.presentation_parent_code, "R019");
  assert.equal(bound.journal_structure_binding.status, "PROVEN");
  assert.equal(result.audit.structure_bindings_applied, 1);
  assert.equal(result.audit.applied_amount, 0);
});

test("physically places journal-bound ERP articles inside their Intalev parent and rolls up missing ERP", () => {
  const proof = (article, sourceId, amount) => movement({
    classification: "ОДНА ОПЕРАЦИЯ / СТАТЬЯ ERP ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ",
    source_block_erp: "Административные расходы",
    target_block_intalev: "Административные расходы",
    intalev_report_block: "Административные расходы",
    intalev_report_group: "Расходы ИТ",
    intalev_report_leaf: article,
    intalev_report_path: `Расходы / _Статьи ОПиУ 2025 / Административные расходы / Расходы ИТ / ${article}`,
    intalev_report_placement_status: "PROVEN_LIVE_REPORT_LEAF_EXACT_AMOUNT",
    article_erp: article,
    target_article_erp: article,
    source_amount: amount,
    erp_source_row_id: sourceId,
  });
  const result = applyJournalFirstPresentationAttribution([
    row("R019", "Расходы ИТ", "", null, ["Административные расходы", "Расходы ИТ"], {
      presentation_outline_level: 1,
    }),
    row("R023", "Расходы на персонал", "", 24, ["Административные расходы", "Расходы на персонал"], {
      presentation_outline_level: 1,
    }),
    row("R020", "", "Абонентское обслуживание ПО", 22.57, ["Административные расходы", "Абонентское обслуживание ПО"]),
    row("R021", "", "Обслуживание орг.техники", 18.6, ["Административные расходы", "Обслуживание орг.техники"]),
  ], { rows: [
    proof("Абонентское обслуживание ПО", "ERP-20", 11.46),
    proof("Обслуживание орг.техники", "ERP-21", 6.5),
  ] });
  assert.deepEqual(result.rows.map((item) => item.code), ["R019", "R020", "R021", "R023"]);
  assert.equal(result.rows.find((item) => item.code === "R019").erp.amount, 41.17);
  assert.equal(result.rows.find((item) => item.code === "R019").erp.status, "JOURNAL_STRUCTURE_CHILDREN_SUM");
  assert.equal(result.audit.journal_parent_rollups_applied, 1);
  assert.equal(result.audit.total_conserved, true);
});
