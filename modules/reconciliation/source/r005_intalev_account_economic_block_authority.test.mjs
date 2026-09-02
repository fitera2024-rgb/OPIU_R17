import assert from "node:assert/strict";
import test from "node:test";

import { matchCrossJournalRows } from "./cross_journal_discrepancy_evidence.mjs";

const PERIOD = "2025-01";
const ARTICLE = "ARTICLE_X";
const AMOUNT = 1854;

const BLOCKS = {
  admin: "административные расходы",
  commercial: "коммерческие расходы",
  transport: "расходы на транспортную логистику",
  warehouse: "расходы на складскую логистику",
};

const ERP_CATALOG = [
  ["Административные расходы", "ADMIN-X", "26"],
  ["Коммерческие расходы", "COMM-X", "44.1"],
  ["Расходы на транспортную логистику", "TRANSPORT-X", "44.3"],
  ["Расходы на складскую логистику", "WAREHOUSE-X", "44.2"],
].map(([block, code, account]) => ({
  label: ARTICLE,
  full_path: `${block} / ${ARTICLE}`,
  exact_catalog_entry_node: true,
  catalog_entries: [{ code, account }],
}));

function intalevRow({ debit, credit }) {
  return {
    system: "INTALEV",
    source_row_id: "INTALEV-ROW",
    physical_row: 4082,
    period: PERIOD,
    date: "31.01.2025 0:00:00",
    date_value: "2025-01-31",
    document: "Проформа 00000001234",
    posting_no: 1,
    scenario: "Факт",
    debit,
    credit,
    debit_analytics: [ARTICLE, "Операционист"],
    credit_analytics: ["Контрагент"],
    amount: AMOUNT,
    content: "Проезд/доставка сотрудников",
    department: "Коммерческий отдел",
    cfo: "ЦМД Сахалин",
    organization: "ПВ",
  };
}

function erpRow({ debit, credit }) {
  return {
    system: "ERP",
    source_row_id: "ERP-ROW",
    physical_row: 1617,
    period: PERIOD,
    date: "31.01.2025 0:00:00",
    date_value: "2025-01-31",
    document: "Трансляция 0000001782",
    posting_no: 1,
    scenario: "Факт",
    activity: "Да",
    debit,
    credit,
    debit_analytics: [ARTICLE, "Операционист"],
    credit_analytics: ["Контрагент"],
    article: ARTICLE,
    amount: AMOUNT,
    content: "Проезд/доставка сотрудников",
    debit_department: "Коммерческий отдел",
    credit_department: "Коммерческий отдел",
    organization: "Сахалин",
  };
}

function runFixture({
  intalevDebit,
  intalevCredit,
  erpDebit = intalevDebit,
  erpCredit = intalevCredit,
  presentationBlock = "Расходы на складскую логистику",
}) {
  return matchCrossJournalRows({
    intalevRows: [intalevRow({ debit: intalevDebit, credit: intalevCredit })],
    erpRows: [erpRow({ debit: erpDebit, credit: erpCredit })],
    period: PERIOD,
    intalevCatalogNodes: [{
      label: ARTICLE,
      full_path: `Расходы / ${ARTICLE}`,
    }],
    intalevReportNodes: [{
      label: ARTICLE,
      full_path: `Расходы / _Статьи ОПиУ 2025 / ${presentationBlock} / ${ARTICLE}`,
      direct_total: AMOUNT,
    }],
    erpCatalogNodes: ERP_CATALOG,
    allowedPhysicalOrganizations: ["Сахалин"],
  });
}

function uniquePair(result) {
  assert.equal(result.counts.direct_unique_pairs, 1);
  return result.rows.find((row) => row.row_type === "UNIQUE_PAIR");
}

test("R005-024 uses debit 26 as economic authority when live-report placement says warehouse", () => {
  const pair = uniquePair(runFixture({
    intalevDebit: "26",
    intalevCredit: "76",
    erpDebit: "44.2",
    erpCredit: "76",
  }));

  assert.equal(pair.target_block_intalev, BLOCKS.admin);
  assert.equal(pair.target_article_code_erp, "ADMIN-X");
  assert.notEqual(pair.target_article_code_erp, "WAREHOUSE-X");
  assert.equal(pair.intalev_expense_account, "26");
  assert.equal(pair.intalev_expense_account_side, "DEBIT");
  assert.equal(pair.intalev_economic_block_status, "PROVEN_EXPENSE_ACCOUNT");
  assert.equal(pair.intalev_economic_block, BLOCKS.admin);
  assert.equal(pair.intalev_presentation_block, BLOCKS.warehouse);
  assert.equal(pair.intalev_report_block, BLOCKS.warehouse);
  assert.equal(pair.block_intalev, BLOCKS.admin);
  assert.match(pair.target_catalog_path, /^Административные расходы\s*\//u);
});

for (const fixture of [
  {
    label: "debit 44.1",
    intalevDebit: "44.1",
    intalevCredit: "76",
    erpDebit: "26",
    erpCredit: "76",
    expenseAccount: "44.1",
    expenseSide: "DEBIT",
    economicBlock: BLOCKS.commercial,
    targetCode: "COMM-X",
  },
  {
    label: "credit-side 44.3 reversal",
    intalevDebit: "76",
    intalevCredit: "44.3",
    erpDebit: "76",
    erpCredit: "26",
    expenseAccount: "44.3",
    expenseSide: "CREDIT",
    economicBlock: BLOCKS.transport,
    targetCode: "TRANSPORT-X",
  },
  {
    label: "existing debit 44.2 warehouse mapping",
    intalevDebit: "44.2",
    intalevCredit: "76",
    erpDebit: "26",
    erpCredit: "76",
    expenseAccount: "44.2",
    expenseSide: "DEBIT",
    economicBlock: BLOCKS.warehouse,
    targetCode: "WAREHOUSE-X",
  },
]) {
  test(`R005-024 maps ${fixture.label} from the physical expense side`, () => {
    const pair = uniquePair(runFixture(fixture));
    assert.equal(pair.target_block_intalev, fixture.economicBlock);
    assert.equal(pair.target_article_code_erp, fixture.targetCode);
    assert.equal(pair.intalev_expense_account, fixture.expenseAccount);
    assert.equal(pair.intalev_expense_account_side, fixture.expenseSide);
    assert.equal(pair.intalev_economic_block_status, "PROVEN_EXPENSE_ACCOUNT");
    assert.equal(pair.intalev_economic_block, fixture.economicBlock);
  });
}

test("R005-024 fails closed when neither physical journal side is an expense account", () => {
  const pair = uniquePair(runFixture({
    intalevDebit: "60",
    intalevCredit: "76",
  }));

  assert.equal(pair.target_status, "BLOCKED_TARGET_INPUT");
  assert.equal(pair.target_block_intalev, "");
  assert.equal(pair.intalev_expense_account, "");
  assert.equal(pair.intalev_economic_block, "");
  assert.equal(pair.intalev_economic_block_status, "NO_RECOGNIZED_EXPENSE_ACCOUNT");
  assert.equal(pair.financial_pair_rows, 0);
});

test("R005-024 fails closed when physical journal accounts imply conflicting expense blocks", () => {
  const pair = uniquePair(runFixture({
    intalevDebit: "26",
    intalevCredit: "44.1",
  }));

  assert.equal(pair.target_status, "BLOCKED_TARGET_INPUT");
  assert.equal(pair.target_block_intalev, "");
  assert.equal(pair.intalev_expense_account, "");
  assert.equal(pair.intalev_economic_block, "");
  assert.equal(pair.intalev_economic_block_status, "CONFLICTING_EXPENSE_BLOCKS");
  assert.equal(pair.financial_pair_rows, 0);
});
