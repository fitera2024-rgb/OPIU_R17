import test from "node:test";
import assert from "node:assert/strict";

import { normalizeEmbeddedReconciliationDecisions } from "./r001_reconciliation_workbook_adapter.mjs";

test("actual-shaped reconciliation decisions inherit passport context and preserve disputed route", () => {
  const rows = [
    {
      "Код строки": "R033", "Статья": "ФЗП и компенсационные выплаты",
      CaseID: "GENERIC-RECLASS-1", PairID: "PAIR-1", "Класс решения": "FINANCIAL_RECLASS",
      decision_type: "STORNO_REPOST", "Статус": "DRAFT STORNO/REPOST _СПОРНО",
      Proof: "ECONOMIC_RECLASS_PROVEN", ECONOMIC_ROUTE_PROVEN: true,
      SOURCE_OPERATION_PROVEN: false, PHYSICAL_SOURCE_UNIQUE: false,
      ECONOMIC_CORRECTION_PROVEN: false, OWNER_REVIEW_REQUIRED: true,
      "Effective delta": -244745, "Роль": "RECLASS_SOURCE",
      "Почему": "economic source", "Что делать": "review only",
    },
    {
      "Код строки": "R023", "Статья": "Расходы на персонал",
      CaseID: "GENERIC-RECLASS-1", PairID: "PAIR-1", "Класс решения": "FINANCIAL_RECLASS",
      decision_type: "STORNO_REPOST", "Статус": "DRAFT STORNO/REPOST _СПОРНО",
      Proof: "ECONOMIC_RECLASS_PROVEN", ECONOMIC_ROUTE_PROVEN: true,
      SOURCE_OPERATION_PROVEN: false, PHYSICAL_SOURCE_UNIQUE: false,
      ECONOMIC_CORRECTION_PROVEN: false, OWNER_REVIEW_REQUIRED: true,
      "Effective delta": 244745, "Роль": "RECLASS_TARGET",
    },
    {
      "Код строки": "R012", "Статья": "Прочие административные расходы",
      CaseID: "CASE-REVIEW", "Класс решения": "EMPTY_ARTICLE", decision_type: "NO_POSTING",
      Proof: "UNPROVEN", ECONOMIC_ROUTE_PROVEN: false, "Effective delta": -39799, "Роль": "REVIEW",
    },
  ];

  const decisions = normalizeEmbeddedReconciliationDecisions(rows, {
    period: "2025-10",
    organization: "9 Управляющая компания",
  });
  assert.equal(decisions.length, 3);
  const source = decisions[0];
  const target = decisions[1];
  assert.equal(source.period, "2025-10");
  assert.equal(source.organization, "9 Управляющая компания");
  assert.equal(source.role, "RECLASS_SOURCE");
  assert.equal(source.economic_direction, "STORNO");
  assert.equal(source.analytical_effect, -244745);
  assert.equal(source.correction_amount, 244745);
  assert.equal(source.output_route, "SPORNO");
  assert.equal(source.accepted_economic_reclass, true);
  assert.equal(source.accepted_intergroup_reclass, true);
  assert.equal(source.accepted_intragroup_reclass, false);
  assert.equal(source.correction_allowed, false);
  assert.equal(source.economic_source_code, "R033");
  assert.equal(source.economic_target_code, "R023");
  assert.notEqual(source.embedded_decision_identity, target.embedded_decision_identity);
  assert.equal(source.target_article, "Расходы на персонал");
  assert.equal(target.economic_direction, "REPOST");
  assert.equal(target.analytical_effect, 244745);
  assert.equal(target.source_article, "ФЗП и компенсационные выплаты");
  assert.equal(decisions[2].decision_type, "NO_POSTING");
  assert.equal(decisions[2].accepted_intergroup_reclass, false);
  assert.equal(decisions[2].accepted_intragroup_reclass, false);
  assert.equal(decisions[2].output_route, "");
});

test("unproven financial-looking row never gains economic direction", () => {
  const [decision] = normalizeEmbeddedReconciliationDecisions([{
    "Код строки": "R999", CaseID: "CASE-UNPROVEN", "Класс решения": "FINANCIAL_RECLASS",
    "Тип решения": "STORNO_REPOST", Proof: "UNPROVEN", ECONOMIC_ROUTE_PROVEN: false,
    "Effective delta": -100, "Роль": "RECLASS_SOURCE",
  }], { period: "2025-10", organization: "ORG" });
  assert.equal(decision.accepted_intergroup_reclass, false);
  assert.equal(decision.accepted_intragroup_reclass, false);
  assert.equal(decision.economic_direction, "");
  assert.equal(decision.correction_allowed, false);
});

test("proven intragroup reclass gains a balanced disputed route after explicit proof", () => {
  const rows = [
    {
      "Код строки": "R034", "Статья": "Компенсации", CaseID: "INTRA-R033-1",
      "Класс решения": "INTRA_GROUP_RECLASS", "Тип решения": "STORNO_REPOST",
      Proof: "ECONOMIC_RECLASS_PROVEN", ECONOMIC_ROUTE_PROVEN: true,
      "Effective delta": -750, "Роль": "RECLASS_SOURCE",
    },
    {
      "Код строки": "R035", "Статья": "НДФЛ", CaseID: "INTRA-R033-1",
      "Класс решения": "INTRA_GROUP_RECLASS", "Тип решения": "STORNO_REPOST",
      Proof: "ECONOMIC_RECLASS_PROVEN", ECONOMIC_ROUTE_PROVEN: true,
      "Effective delta": 750, "Роль": "RECLASS_TARGET",
    },
  ];
  const decisions = normalizeEmbeddedReconciliationDecisions(rows, {
    period: "2025-10",
    organization: "9 Управляющая компания",
  });
  assert.deepEqual(decisions.map((item) => item.economic_direction), ["STORNO", "REPOST"]);
  assert.ok(decisions.every((item) => item.accepted_economic_reclass === true));
  assert.ok(decisions.every((item) => item.accepted_intergroup_reclass === false));
  assert.ok(decisions.every((item) => item.accepted_intragroup_reclass === true));
  assert.ok(decisions.every((item) => item.reclass_scope === "INTRA_GROUP"));
  assert.deepEqual(decisions.map((item) => item.accepted_intragroup_effect), [-750, 750]);
  assert.equal(decisions[0].economic_source_code, "R034");
  assert.equal(decisions[0].economic_target_code, "R035");
});

test("unbalanced route and intragroup reuse of an intergroup row fail closed", () => {
  const base = {
    "Тип решения": "STORNO_REPOST",
    Proof: "ECONOMIC_RECLASS_PROVEN",
    ECONOMIC_ROUTE_PROVEN: true,
  };
  const decisions = normalizeEmbeddedReconciliationDecisions([
    { ...base, "Код строки": "R100", CaseID: "INTER-1", "Класс решения": "FINANCIAL_RECLASS", "Effective delta": -100, "Роль": "RECLASS_SOURCE" },
    { ...base, "Код строки": "R200", CaseID: "INTER-1", "Класс решения": "FINANCIAL_RECLASS", "Effective delta": 100, "Роль": "RECLASS_TARGET" },
    { ...base, "Код строки": "R100", CaseID: "INTRA-REUSE", "Класс решения": "INTRA_GROUP_RECLASS", "Effective delta": -100, "Роль": "RECLASS_SOURCE" },
    { ...base, "Код строки": "R300", CaseID: "INTRA-REUSE", "Класс решения": "INTRA_GROUP_RECLASS", "Effective delta": 100, "Роль": "RECLASS_TARGET" },
    { ...base, "Код строки": "R400", CaseID: "INTRA-UNBALANCED", "Класс решения": "INTRA_GROUP_RECLASS", "Effective delta": -50, "Роль": "RECLASS_SOURCE" },
    { ...base, "Код строки": "R500", CaseID: "INTRA-UNBALANCED", "Класс решения": "INTRA_GROUP_RECLASS", "Effective delta": 49, "Роль": "RECLASS_TARGET" },
  ], { period: "2025-10", organization: "ORG" });
  assert.ok(decisions.slice(0, 2).every((item) => item.accepted_intergroup_reclass === true));
  assert.ok(decisions.slice(2).every((item) => item.accepted_economic_reclass === false));
  assert.ok(decisions.slice(2).every((item) => item.economic_direction === ""));
  assert.equal(decisions[2].unproven_reason, "ECONOMIC_ROW_ALREADY_CONSUMED_BY_EARLIER_ROUTE");
  assert.equal(decisions[4].unproven_reason, "BALANCED_SOURCE_TARGET_ROUTE_NOT_PROVEN");
});

test("balanced one-to-many intragroup route preserves every member code", () => {
  const base = {
    CaseID: "INTRA-ONE-TO-MANY",
    "Класс решения": "INTRA_GROUP_RECLASS",
    "Тип решения": "STORNO_REPOST",
    Proof: "ECONOMIC_RECLASS_PROVEN",
    ECONOMIC_ROUTE_PROVEN: true,
  };
  const decisions = normalizeEmbeddedReconciliationDecisions([
    { ...base, "Код строки": "R036", "Статья": "ФЗП", "Effective delta": -100, "Роль": "RECLASS_SOURCE" },
    { ...base, "Код строки": "R034", "Статья": "Компенсации", "Effective delta": 40, "Роль": "RECLASS_TARGET" },
    { ...base, "Код строки": "R035", "Статья": "НДФЛ", "Effective delta": 60, "Роль": "RECLASS_TARGET" },
  ], { period: "2025-10", organization: "ORG" });
  assert.ok(decisions.every((item) => item.accepted_intragroup_reclass === true));
  assert.ok(decisions.every((item) => item.economic_source_code === "R036"));
  assert.ok(decisions.every((item) => item.economic_target_code === "R034; R035"));
  assert.equal(decisions[0].target_article, "Компенсации; НДФЛ");
  assert.equal(decisions[1].source_article, "ФЗП");
});
