import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveHierarchyExactAmountAuthority,
  hierarchyContextByCode,
} from "./r001_hierarchy_authority.mjs";
import { evaluateGroupScopedDecision } from "./r001_group_scoped_materialization.mjs";
import { collectCanonicalFinancialOutput } from "./r001_canonical_output_contract.mjs";

const SHA = "A".repeat(64);
const JOURNAL_SHA = "B".repeat(64);
const ROW_ID = "C".repeat(64);

function structural({ row, code, level, label, delta = null, type = "ДЕТАЛЬ", comment = "" }) {
  return {
    __row: row,
    "Код / PairID": code,
    "Уровень": `${level} — ${type}`,
    "Строка ОПИУ / операция": label,
    "Тип строки": type,
    "Дельта = Инталев − ERP": delta,
    "Комментарий / доказательство": comment || "structural status=HIERARCHY_PROVEN; proof status=PROVEN_LIVE_INTALEV",
  };
}

function physical({ row = 105, code = "SRC-10763", debit = "26", credit = "76.5", rowId = ROW_ID } = {}) {
  return {
    __row: row,
    "Код / PairID": code,
    "Уровень": "6 — CANDIDATE_EXCLUDED",
    "Строка ОПИУ / операция": "Компенсации",
    "Тип строки": "CANDIDATE_EXCLUDED",
    "Дата": "23.10.2025",
    "ERP строка": `B${row}:AG${row}`,
    "Где исправить": `Лист_1!B${row}:AG${row}`,
    "Регистратор / документ": "Трансляция 0001",
    "№ проводки": 11,
    "Дт": debit,
    "Аналитики Дт": debit === "99" ? "" : "Компенсации",
    "Подразделение Дт": "Административный отдел",
    "Кт": credit,
    "Аналитики Кт": credit === "26" ? "Компенсации" : "",
    "Подразделение Кт": "Административный отдел",
    "Организация": "ГК",
    "Физическая сумма": 750,
    "Статус": "КАНДИДАТ / НЕ ДОКАЗАНО — НЕ В ИТОГЕ",
    "Комментарий / доказательство": [
      "ExpectedAccounts=26",
      `SourceRowID=${rowId}`,
      `JournalSHA=${JOURNAL_SHA}`,
      "JournalInput=C:\\ERP\\source.zip",
      "JournalEntry=journal.xlsx",
    ].join("; "),
  };
}

function pairedPhysical({ row, level, amount, debit, credit, debitAnalytics, creditAnalytics, organization = "ООО Источник", rowId }) {
  return {
    __row: row,
    "Код / PairID": `SRC-${row}`,
    "Уровень": `${level} — CANDIDATE_EXCLUDED`,
    "Строка ОПИУ / операция": "Операция",
    "Тип строки": "CANDIDATE_EXCLUDED",
    "Дата": "31.10.2025",
    "ERP строка": `B${row}:AG${row}`,
    "Где исправить": `Лист_1!B${row}:AG${row}`,
    "Регистратор / документ": "Трансляция 1",
    "№ проводки": row,
    "Дт": debit,
    "Аналитики Дт": debitAnalytics,
    "Подразделение Дт": "Администрация",
    "Кт": credit,
    "Аналитики Кт": creditAnalytics,
    "Подразделение Кт": "Администрация",
    "Организация": organization,
    "Физическая сумма": amount,
    "Комментарий / доказательство": [
      "ExpectedAccounts=26",
      `SourceRowID=${rowId}`,
      `JournalSHA=${JOURNAL_SHA}`,
      "JournalInput=C:\\ERP\\source.zip",
      "JournalEntry=journal.xlsx",
    ].join("; "),
  };
}

function rows(extra = []) {
  return [
    structural({ row: 7, code: "R001", level: 2, label: "Административные расходы", type: "БЛОК" }),
    structural({ row: 103, code: "R033", level: 4, label: "ФЗП и компенсационные выплаты", type: "СТАТЬЯ" }),
    structural({ row: 104, code: "R034", level: 5, label: "Компенсации", delta: 750 }),
    physical({ row: 105 }),
    physical({ row: 112, code: "SRC-CLOSING", debit: "99", credit: "26", rowId: "D".repeat(64) }),
    ...extra,
  ];
}

test("hierarchy context retains the complete Intalev path", () => {
  const context = hierarchyContextByCode(rows()).get("R034");
  assert.equal(context.block, "Административные расходы");
  assert.equal(context.path, "Административные расходы / ФЗП и компенсационные выплаты / Компенсации");
});

test("one exact non-closing physical child becomes authoritative despite the old review label", async () => {
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: rows(),
    period: "2025-10",
    reconciliationOrganization: "9 Управляющая компания",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
    reconciliationSha256: "E".repeat(64),
  });
  assert.equal(result.decisions.length, 1);
  const decision = result.decisions[0];
  assert.equal(decision.reconciliation_row, "R034");
  assert.equal(decision.correction_amount, 750);
  assert.equal(decision.source_row_id, ROW_ID);
  assert.equal(decision.source_organization, "ГК");
  assert.equal(decision.source_archive_sha256, SHA);
  assert.equal(decision.settlement_account, "76.5");
  assert.equal(decision.source_operating_account, "26");
  assert.equal(decision.ECONOMIC_CORRECTION_PROVEN, true);
  assert.equal(decision.PHYSICAL_SOURCE_UNIQUE, true);
  assert.equal(decision.intalev_path, "Административные расходы / ФЗП и компенсационные выплаты / Компенсации");
});

test("two non-closing exact children remain blocked as ambiguous", async () => {
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: rows([physical({ row: 106, code: "SRC-SECOND", rowId: "F".repeat(64) })]),
    period: "2025-10",
    reconciliationOrganization: "9 Управляющая компания",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
  });
  assert.equal(result.decisions.length, 0);
  assert.equal(result.blockers.find((item) => item.reconciliation_row === "R034")?.reason, "HIERARCHY_EXACT_AMOUNT_SOURCE_AMBIGUOUS");
});

test("paired liability gap generically reclassifies exact employee parts from the direct parent article", async () => {
  const sourceA = "1".repeat(64);
  const sourceB = "2".repeat(64);
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: [
      structural({ row: 1, code: "R001", level: 2, label: "Административные расходы", type: "БЛОК" }),
      structural({ row: 10, code: "R100", level: 5, label: "Базовая статья" }),
      pairedPhysical({ row: 11, level: 6, amount: 500, debit: "26", credit: "70.1", debitAnalytics: "Базовая статья", creditAnalytics: "Сотрудник А", rowId: sourceA }),
      pairedPhysical({ row: 12, level: 6, amount: 400, debit: "26", credit: "70.1", debitAnalytics: "Базовая статья", creditAnalytics: "Сотрудник Б", rowId: sourceB }),
      structural({ row: 20, code: "R101", level: 6, label: "Целевая классификация", delta: 120 }),
      pairedPhysical({ row: 21, level: 7, amount: 10, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация", creditAnalytics: "Сотрудник В", rowId: "3".repeat(64) }),
      pairedPhysical({ row: 22, level: 7, amount: 10, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник В", creditAnalytics: "", rowId: "4".repeat(64) }),
      pairedPhysical({ row: 23, level: 7, amount: 20, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация", creditAnalytics: "Сотрудник Г", rowId: "5".repeat(64) }),
      pairedPhysical({ row: 24, level: 7, amount: 20, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник Г", creditAnalytics: "", rowId: "6".repeat(64) }),
      pairedPhysical({ row: 25, level: 7, amount: 70, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник А", creditAnalytics: "", rowId: "7".repeat(64) }),
      pairedPhysical({ row: 26, level: 7, amount: 50, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник Б", creditAnalytics: "", rowId: "8".repeat(64) }),
    ],
    period: "2025-10",
    reconciliationOrganization: "УК",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
    reconciliationSha256: "E".repeat(64),
  });
  const paired = result.decisions.filter((item) => item.partial_source_amount_proven === true);
  assert.deepEqual(paired.map((item) => item.correction_amount).sort((a, b) => a - b), [50, 70]);
  assert.deepEqual(paired.map((item) => item.source_row_id).sort(), [sourceA, sourceB]);
  assert.ok(paired.every((item) => item.source_article === "Базовая статья"));
  assert.ok(paired.every((item) => item.target_article === "Целевая классификация"));
  assert.ok(paired.every((item) => item.ECONOMIC_CORRECTION_PROVEN === true));
});

test("competing exact and paired-liability proofs for one residual remain review evidence without financial pairs", async () => {
  const exactSource = "9".repeat(64);
  const parentSourceA = "1".repeat(64);
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: [
      structural({ row: 1, code: "R001", level: 2, label: "Административные расходы", type: "БЛОК" }),
      structural({ row: 10, code: "R100", level: 5, label: "Базовая статья" }),
      pairedPhysical({ row: 11, level: 6, amount: 500, debit: "26", credit: "70.1", debitAnalytics: "Базовая статья", creditAnalytics: "Сотрудник А", rowId: parentSourceA }),
      structural({ row: 20, code: "R101", level: 6, label: "Целевая классификация", delta: 120 }),
      pairedPhysical({ row: 21, level: 7, amount: 10, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация", creditAnalytics: "Сотрудник В", rowId: "3".repeat(64) }),
      pairedPhysical({ row: 22, level: 7, amount: 10, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник В", creditAnalytics: "Целевая классификация", rowId: "4".repeat(64) }),
      pairedPhysical({ row: 23, level: 7, amount: 20, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация", creditAnalytics: "Сотрудник Г", rowId: "5".repeat(64) }),
      pairedPhysical({ row: 24, level: 7, amount: 20, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник Г", creditAnalytics: "Целевая классификация", rowId: "6".repeat(64) }),
      pairedPhysical({ row: 25, level: 7, amount: 120, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник А", creditAnalytics: "Целевая классификация", rowId: exactSource }),
    ],
    period: "2025-11",
    reconciliationOrganization: "УК",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
    reconciliationSha256: "E".repeat(64),
  });
  assert.equal(result.audit.overlapping_authority_cases, 1);
  assert.equal(result.audit.overlapping_authority_review_only_decisions, 2);
  assert.equal(result.audit.hierarchy_physical_evidence_decisions, 2);
  assert.equal(result.audit.actionable_hierarchy_authority_decisions, 0);
  assert.equal(result.audit.review_only_hierarchy_authority_decisions, 2);
  assert.equal(result.audit.total_hierarchy_authority_decisions, 0);
  assert.equal(result.decisions.length, 2);
  assert.deepEqual(
    result.decisions.map((item) => item.source_row_id).sort(),
    [exactSource, parentSourceA].sort(),
  );
  const exactDecision = result.decisions.find((item) => item.role === "HIERARCHY_EXACT_SOURCE");
  const pairedDecision = result.decisions.find((item) => item.role === "HIERARCHY_PAIRED_LIABILITY_RECLASS");
  assert.equal(exactDecision.source_row_id, pairedDecision.paired_liability_source_row_id);
  assert.ok(result.decisions.every((item) => item.proof_status === "UNPROVEN_OVERLAPPING_HIERARCHY_AUTHORITY"));
  assert.ok(result.decisions.every((item) => item.ECONOMIC_ROUTE_PROVEN === false));
  assert.ok(result.decisions.every((item) => item.ECONOMIC_CORRECTION_PROVEN === false));
  assert.ok(result.decisions.every((item) => item.financial_materialization_forbidden === true));
  assert.ok(result.decisions.every((item) => item.labels.includes("_СПОРНО")));

  const catalogNodes = [{
    label: "Целевая классификация",
    full_path: "Административные расходы / Целевая классификация",
    catalog_entries: [{ code: "ERP-TARGET", account: "26" }],
  }];
  const canonicalRows = result.decisions.flatMap((decision) => evaluateGroupScopedDecision({
    decision,
    catalogNodes,
    intalevBlock: decision.intalev_block,
    intalevPath: decision.intalev_path,
  }).canonical_posting_rows);
  assert.equal(canonicalRows.length, 0);
  const canonicalOutput = collectCanonicalFinancialOutput(canonicalRows);
  assert.equal(canonicalOutput.rows.length, 0);
  assert.equal(canonicalOutput.groups.length, 0);
  assert.equal(canonicalOutput.registry_rows.length, 0);
  assert.equal(canonicalOutput.counters.canonical_financial_rows_total, 0);
  assert.equal(canonicalOutput.counters.posting_rows, 0);
});

test("exact and paired-liability authorities on different analytical bases remain independently financial", async () => {
  const exact = rows();
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: [
      ...exact,
      structural({ row: 200, code: "R200", level: 5, label: "Базовая статья 2" }),
      pairedPhysical({ row: 201, level: 6, amount: 500, debit: "26", credit: "70.1", debitAnalytics: "Базовая статья 2", creditAnalytics: "Сотрудник А", rowId: "1".repeat(64) }),
      pairedPhysical({ row: 202, level: 6, amount: 400, debit: "26", credit: "70.1", debitAnalytics: "Базовая статья 2", creditAnalytics: "Сотрудник Б", rowId: "2".repeat(64) }),
      structural({ row: 210, code: "R201", level: 6, label: "Целевая классификация 2", delta: 120 }),
      pairedPhysical({ row: 211, level: 7, amount: 10, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация 2", creditAnalytics: "Сотрудник В", rowId: "3".repeat(64) }),
      pairedPhysical({ row: 212, level: 7, amount: 10, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник В", creditAnalytics: "", rowId: "4".repeat(64) }),
      pairedPhysical({ row: 213, level: 7, amount: 20, debit: "26", credit: "70.1", debitAnalytics: "Целевая классификация 2", creditAnalytics: "Сотрудник Г", rowId: "5".repeat(64) }),
      pairedPhysical({ row: 214, level: 7, amount: 20, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник Г", creditAnalytics: "", rowId: "6".repeat(64) }),
      pairedPhysical({ row: 215, level: 7, amount: 70, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник А", creditAnalytics: "", rowId: "7".repeat(64) }),
      pairedPhysical({ row: 216, level: 7, amount: 50, debit: "70.1", credit: "68.2", debitAnalytics: "Сотрудник Б", creditAnalytics: "", rowId: "8".repeat(64) }),
    ],
    period: "2025-10",
    reconciliationOrganization: "УК",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
  });
  assert.equal(result.audit.overlapping_authority_cases, 0);
  assert.equal(result.decisions.length, 3);
  assert.equal(result.audit.actionable_hierarchy_authority_decisions, 3);
  assert.equal(result.audit.review_only_hierarchy_authority_decisions, 0);
  assert.equal(result.audit.total_hierarchy_authority_decisions, 3);
  assert.ok(result.decisions.every((item) => item.ECONOMIC_CORRECTION_PROVEN === true));
  assert.deepEqual(new Set(result.decisions.map((item) => item.reconciliation_row)), new Set(["R034", "R201"]));
});

test("accepted intergroup hierarchy route uses the one exact common-signature physical ERP set", async () => {
  const routeId = "GENERIC-RECLASS-ROUTE-1";
  const payrollA = "9".repeat(64);
  const payrollB = "A".repeat(64);
  const compensation = "B".repeat(64);
  const result = await deriveHierarchyExactAmountAuthority({
    treeRows: [
      structural({ row: 1, code: "R001", level: 2, label: "Административные расходы", type: "БЛОК" }),
      structural({
        row: 10, code: "R023", level: 4, label: "Расходы на персонал", delta: 244745,
        comment: `CaseID=${routeId}; classification=FINANCIAL_RECLASS; proof=ECONOMIC_RECLASS_PROVEN`,
      }),
      structural({ row: 11, code: "R025", level: 5, label: "Мат помощь и прочие выплаты", delta: 243995 }),
      structural({ row: 12, code: "R028", level: 5, label: "Прочие расходы на персонал", delta: 750 }),
      structural({
        row: 20, code: "R033", level: 4, label: "ФЗП и компенсационные выплаты", delta: -244745,
        comment: `CaseID=${routeId}; classification=FINANCIAL_RECLASS; proof=ECONOMIC_RECLASS_PROVEN`,
      }),
      structural({ row: 21, code: "R034", level: 5, label: "Компенсации", delta: 750 }),
      pairedPhysical({ row: 22, level: 6, amount: 750, debit: "26", credit: "76.5", debitAnalytics: "Компенсации", creditAnalytics: "", rowId: compensation }),
      structural({ row: 30, code: "R036", level: 5, label: "ФЗП", delta: 831254 }),
      pairedPhysical({ row: 31, level: 6, amount: 200000, debit: "26", credit: "76.5", debitAnalytics: "ФЗП", creditAnalytics: "", rowId: payrollA }),
      pairedPhysical({ row: 32, level: 6, amount: 43995, debit: "26", credit: "76.5", debitAnalytics: "ФЗП", creditAnalytics: "", rowId: payrollB }),
      pairedPhysical({ row: 33, level: 6, amount: 500000, debit: "26", credit: "70.1", debitAnalytics: "ФЗП", creditAnalytics: "Сотрудник", rowId: "C".repeat(64) }),
    ],
    period: "2025-10",
    reconciliationOrganization: "УК",
    sourceArchiveSha256: SHA,
    sourceSheet: "Лист_1",
    reconciliationSha256: "E".repeat(64),
  });
  const intergroup = result.decisions.filter((item) => item.role === "HIERARCHY_INTERGROUP_PHYSICAL_RECLASS");
  assert.equal(result.audit.intergroup_physical_route_cases, 1);
  assert.equal(result.audit.intergroup_physical_decisions, 3);
  assert.deepEqual(result.covered_economic_route_case_ids, [routeId]);
  assert.deepEqual(intergroup.map((item) => item.source_row_id).sort(), [payrollA, payrollB, compensation].sort());
  assert.equal(intergroup.reduce((sum, item) => sum + item.correction_amount, 0), 244745);
  assert.deepEqual(
    intergroup.map((item) => [item.source_article, item.target_article, item.correction_amount]).sort((a, b) => a[2] - b[2]),
    [
      ["Компенсации", "Прочие расходы на персонал", 750],
      ["ФЗП", "Мат помощь и прочие выплаты", 43995],
      ["ФЗП", "Мат помощь и прочие выплаты", 200000],
    ],
  );
  assert.equal(result.decisions.some((item) => item.role === "HIERARCHY_EXACT_SOURCE" && item.source_row_id === compensation), false);
});
