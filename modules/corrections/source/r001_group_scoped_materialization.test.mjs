import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGroupScopedDecision } from "./r001_group_scoped_materialization.mjs";

const shaA = "A".repeat(64);
const shaB = "B".repeat(64);

function decision(overrides = {}) {
  return {
    case_id: "CASE-TRAVEL",
    pair_id: "PAIR-TRAVEL",
    decision_type: "STORNO_REPOST",
    period: "2025-10",
    organization: "ООО УК",
    reconciliation_organization: "ООО УК",
    reconciliation_row: "R100",
    group: "Командировочные",
    source_article: "Командировочные",
    correction_amount: 125,
    source_amount: 125,
    settlement_account: "71",
    source_operating_account: "44",
    target_subkonto_slot: 1,
    ECONOMIC_ROUTE_PROVEN: true,
    SOURCE_OPERATION_PROVEN: true,
    PHYSICAL_SOURCE_UNIQUE: true,
    ECONOMIC_CORRECTION_PROVEN: true,
    source_organization: "ООО УК",
    source_archive_path: "C:\\proof\\erp.zip",
    source_archive_sha256: shaA,
    journal_entry: "journal.xlsx",
    journal_sha256: shaB,
    source_sheet: "Лист_1",
    source_range: "B20:AG20",
    source_row_id: "ERP-20",
    source_date: "31.10.2025 0:00:00",
    registrar: "Авансовый отчет 1",
    posting_number: "2",
    source_dt: "44.1",
    source_kt: "71.1",
    source_analytics_dt1: "Командировочные",
    source_analytics_dt2: "Проект",
    source_analytics_dt3: "Направление",
    source_analytics_kt1: "Сотрудник",
    source_analytics_kt2: "Документ",
    source_analytics_kt3: "Расчеты",
    source_department_dt: "Администрация",
    source_department_kt: "Администрация",
    ...overrides,
  };
}

const catalogNodes = [
  {
    label: "Командировочные",
    full_path: "Административные расходы / Командировочные",
    catalog_entries: [{ code: "ADMIN-TRAVEL", account: "Счет затрат 26", source_row: 50 }],
  },
  {
    label: "Командировочные",
    full_path: "Коммерческие расходы / Командировочные",
    catalog_entries: [{ code: "SALES-TRAVEL", account: "Счет затрат 44.1", source_row: 60 }],
  },
];

test("generic group-scoped materialization creates sparse SPORNO STORNO and REPOST without FZP-specific code", () => {
  const result = evaluateGroupScopedDecision({
    decision: decision(),
    catalogNodes,
    intalevBlock: "Административные расходы",
    intalevPath: "ОПИУ / Административные расходы / Командировочные",
  });
  assert.equal(result.status, "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST");
  assert.deepEqual(result.canonical_posting_rows.map((row) => row.operation), ["STORNO", "REPOST"]);
  assert.ok(result.canonical_posting_rows.every((row) => row.output_route === "SPORNO"));
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["СчетДт"] === null));
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["СчетКт"] === null));
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["СубконтоДт1"] === null));
  assert.deepEqual(
    result.canonical_posting_rows.map((row) => row.loader["СуммаВВалютеОтчетности"]),
    [-125, 125],
  );
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["ПравилоДт"] === null));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /^Операция STORNO \| ERP:/);
  assert.match(result.canonical_posting_rows[1].loader["Содержание"], /^Операция REPOST \| ERP:/);
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["Содержание"].includes("документ операций Инталев не представлен")));
  assert.ok(result.canonical_posting_rows.every((row) => row.loader["Содержание"].includes("Причина:")));
  assert.ok(result.canonical_posting_rows.every((row) => row.source.source_row_id === ""));
});

test("resolved target remains review-only when exact physical authority is absent", () => {
  const result = evaluateGroupScopedDecision({
    decision: decision({ SOURCE_OPERATION_PROVEN: false, source_row_id: "" }),
    catalogNodes,
    intalevBlock: "Административные расходы",
    intalevPath: "ОПИУ / Административные расходы / Командировочные",
  });
  assert.equal(result.status, "TARGET_RESOLVED_REVIEW_ONLY");
  assert.equal(result.target_article.article_code, "ADMIN-TRAVEL");
  assert.equal(result.canonical_posting_rows.length, 0);
});

test("amount mismatch and wrong block fail closed with zero A:AA rows", () => {
  const mismatch = evaluateGroupScopedDecision({
    decision: decision({ source_amount: 124 }),
    catalogNodes,
    intalevBlock: "Административные расходы",
  });
  assert.equal(mismatch.status, "BLOCKED_PHYSICAL_MATERIALIZATION");
  assert.deepEqual(mismatch.blockers, ["GROUP_SCOPED_AMOUNT_MISMATCH"]);
  assert.equal(mismatch.canonical_posting_rows.length, 0);

  const wrongBlock = evaluateGroupScopedDecision({
    decision: decision(),
    catalogNodes,
    intalevBlock: "Производственные расходы",
  });
  assert.equal(wrongBlock.status, "BLOCKED_TARGET_SELECTION");
  assert.equal(wrongBlock.canonical_posting_rows.length, 0);
});

test("paired liability proof permits a sparse partial reclass without claiming un-reopened physical identity", () => {
  const result = evaluateGroupScopedDecision({
    decision: decision({
      target_article: "Командировочные",
      correction_amount: 25,
      source_amount: 125,
      partial_source_amount_proven: true,
    }),
    catalogNodes,
    intalevBlock: "Административные расходы",
    intalevPath: "ОПИУ / Административные расходы / Командировочные",
  });
  assert.equal(result.status, "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST");
  assert.deepEqual(result.canonical_posting_rows.map((row) => row.amount), [25, 25]);
  assert.ok(result.canonical_posting_rows.every((row) => row.output_route === "SPORNO"));
  assert.ok(result.canonical_posting_rows.every((row) => row.source.amount === null));
});
