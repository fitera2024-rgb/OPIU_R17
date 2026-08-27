import test from "node:test";
import assert from "node:assert/strict";
import { applyPostedCorrectionOverlayToErpParsed } from "./posted_correction_journal_overlay.mjs";

function sourceRow({ article, block, amount, parentIndex, cfo = "" }) {
  return {
    period: "2025-01",
    article,
    summary_label: "",
    amount,
    raw_amount: amount,
    normalized_amount: amount,
    full_path: `Расходы по основной деятельности ИТОГО / ${block} / ${article}`,
    level: 2,
    source_level: 2,
    parent_index: parentIndex,
    cfo,
    child_indexes: [],
    source_identity: `${block}|${article}|${cfo}`,
    catalog_codes: "",
  };
}

test("balanced marked pair moves an expense between ERP blocks and synthesizes a missing target", () => {
  const parsed = {
    sha256: "A".repeat(64),
    sheet: "Лист_1",
    period: "2025-01",
    rows: [
      {
        period: "2025-01",
        article: "",
        summary_label: "Административные расходы",
        amount: 100,
        full_path: "Расходы по основной деятельности ИТОГО / Административные расходы",
        level: 1,
        source_level: 1,
        parent_index: null,
        cfo: "",
        source_identity: "ADMIN",
      },
      sourceRow({ article: "НДФЛ", block: "Административные расходы", amount: 100, parentIndex: 0, cfo: "КО" }),
      {
        period: "2025-01",
        article: "",
        summary_label: "Коммерческие расходы",
        amount: 0,
        full_path: "Расходы по основной деятельности ИТОГО / Коммерческие расходы",
        level: 1,
        source_level: 1,
        parent_index: null,
        cfo: "",
        source_identity: "COMM",
      },
    ],
  };
  const common = {
    pair_id: "PAIR-1",
    effective_article: "НДФЛ",
    cfo: "КО",
    source_row_id: "ROW",
    physical_row: 99,
  };
  const overlay = {
    applicable: true,
    rows: [
      { ...common, operation: "STORNO", amount: -40, effective_block: "Административные расходы", effective_path: "Административные расходы / НДФЛ", effective_code: "" },
      { ...common, operation: "REPOST", amount: 40, effective_block: "Коммерческие расходы", effective_path: "Коммерческие расходы / НДФЛ", effective_code: "C-001" },
    ],
  };
  const result = applyPostedCorrectionOverlayToErpParsed({ parsed, overlay });
  assert.equal(result.applied_rows, 2);
  assert.equal(result.synthesized_rows, 1);
  assert.equal(parsed.rows[0].amount, 60);
  assert.equal(parsed.rows[1].amount, 60);
  assert.equal(parsed.rows[2].amount, 40);
  const target = parsed.rows.at(-1);
  assert.equal(target.article, "НДФЛ");
  assert.equal(target.amount, 40);
  assert.equal(target.catalog_codes, "C-001");
});

test("unmarked overlay is a no-op", () => {
  const parsed = { rows: [{ article: "ФЗП", amount: 10 }] };
  const result = applyPostedCorrectionOverlayToErpParsed({
    parsed,
    overlay: { applicable: false, rows: [] },
  });
  assert.deepEqual(result, { applied_rows: 0, synthesized_rows: 0, touched_source_rows: 0 });
  assert.equal(parsed.rows[0].amount, 10);
});

test("forced synthetic one-side rows transparently adjust an article without choosing an arbitrary CFO row", () => {
  const parsed = {
    sha256: "B".repeat(64),
    sheet: "Лист_1",
    period: "2025-01",
    rows: [
      {
        period: "2025-01",
        article: "",
        summary_label: "Административные расходы",
        amount: 100,
        raw_amount: 100,
        normalized_amount: 100,
        full_path: "Расходы по основной деятельности ИТОГО / Административные расходы",
        level: 1,
        source_level: 1,
        parent_index: null,
        cfo: "",
        source_identity: "ADMIN",
      },
      sourceRow({ article: "Расходы ИТ", block: "Административные расходы", amount: 60, parentIndex: 0, cfo: "ИТ-1" }),
      sourceRow({ article: "Расходы ИТ", block: "Административные расходы", amount: 40, parentIndex: 0, cfo: "ИТ-2" }),
    ],
  };
  const overlay = {
    applicable: true,
    rows: [{
      pair_id: "SPORNO-1",
      operation: "STORNO",
      amount: -15,
      effective_block: "Административные расходы",
      effective_article: "Расходы ИТ",
      effective_path: "Административные расходы / Расходы ИТ",
      effective_code: "",
      cfo: "",
      source_row_id: "SPORNO-1",
      physical_row: 100,
      force_synthetic: true,
    }],
  };
  const result = applyPostedCorrectionOverlayToErpParsed({ parsed, overlay });
  assert.equal(result.synthesized_rows, 1);
  assert.equal(parsed.rows[0].amount, 85);
  assert.equal(parsed.rows[1].amount, 60);
  assert.equal(parsed.rows[2].amount, 40);
  assert.equal(parsed.rows.at(-1).article, "Расходы ИТ");
  assert.equal(parsed.rows.at(-1).amount, -15);
});

test("direct summary control changes only the selected reported total", () => {
  const parsed = {
    rows: [
      {
        period: "2025-01",
        article: "",
        summary_label: "EBITDA",
        amount: 120,
        raw_amount: 120,
        normalized_amount: 120,
        full_path: "ОПИУ / EBITDA",
        parent_index: 1,
        catalog_codes: "",
      },
      {
        period: "2025-01",
        article: "",
        summary_label: "ОПИУ",
        amount: 120,
        raw_amount: 120,
        normalized_amount: 120,
        full_path: "ОПИУ",
        parent_index: null,
        catalog_codes: "",
      },
    ],
  };
  const overlay = {
    applicable: true,
    rows: [{
      pair_id: "SPORNO-SUM-1",
      operation: "STORNO",
      amount: -20,
      effective_block: "EBITDA",
      effective_article: "EBITDA",
      effective_path: "EBITDA",
      effective_code: "R041",
      cfo: "",
      source_row_id: "SPORNO-SUM-1",
      physical_row: 101,
      force_synthetic: false,
    }],
  };
  applyPostedCorrectionOverlayToErpParsed({ parsed, overlay });
  assert.equal(parsed.rows[0].amount, 100);
  assert.equal(parsed.rows[1].amount, 120);
  assert.equal(parsed.rows[0].posted_correction_overlay[0].direct_summary_control, true);
});
