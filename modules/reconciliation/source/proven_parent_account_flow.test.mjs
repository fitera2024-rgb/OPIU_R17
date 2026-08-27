import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {
  classifyProvenParentAccountFlows,
  provenParentAccountFlowNodeEvidence,
} from "./arbitrary_period_operation_evidence.mjs";
import { provenOperationWorkbookRows } from "./operation_evidence_workbook_projection.mjs";

const SHA = "B".repeat(64);

function source(article, amount, cell, component = false) {
  return {
    article,
    amount,
    month: "2026-02",
    source_cell: cell,
    source_tree_proof: { complete: true, status: "LEAF" },
    exact_parent_component: component,
  };
}

function financialRows() {
  const composition = [
    source("Компонент А", 40, "D11", true),
    source("Компонент Б", 60, "D12", true),
  ];
  return [
    { code: "R100", erp: { amount: 100, trace: composition } },
    { code: "R101", presentation_parent_code: "R100", erp: { amount: 100, trace: composition } },
    {
      code: "R102",
      presentation_parent_code: "R101",
      erp: { amount: 60, trace: [source("Компонент Б", 60, "D12")] },
    },
  ];
}

function operation({ row, article, amount, debit, credit }) {
  return {
    physical_row: row,
    source_range: `B${row}:AG${row}`,
    source_row_id: String(row).padStart(64, "A").slice(-64),
    date: "28.02.2026 0:00:00",
    document: `Документ ${row}`,
    posting_no: row,
    organization: "Тестовая организация",
    debit,
    credit,
    debit_analytics: [],
    credit_analytics: [],
    amount,
    article,
    disclosure: "Счет затрат 91.2",
    period: "2026-02",
    erp_input_sha256: SHA,
    erp_opiu_sha256: SHA,
    journal_sha256: SHA,
    journal_sheet: "ERP",
  };
}

function operations() {
  return [
    operation({ row: 1001, article: "Компонент А", amount: 15, debit: "91.2", credit: "60" }),
    operation({ row: 1002, article: "Компонент А", amount: 25, debit: "91.2", credit: "71.1" }),
    operation({ row: 1003, article: "Компонент А", amount: 40, debit: "99", credit: "91.2" }),
    operation({ row: 1004, article: "Компонент Б", amount: 60, debit: "91.2", credit: "79.1" }),
    operation({ row: 1005, article: "Компонент Б", amount: 60, debit: "99", credit: "91.2" }),
  ];
}

test("generic account-flow proof consumes operational legs once and keeps closing legs non-additive", () => {
  const result = classifyProvenParentAccountFlows({
    financialRows: financialRows(),
    activeRows: operations(),
    period: "2026-02",
    allowedJournalOrganizations: new Set(["Тестовая организация"]),
  });

  assert.equal(result.status, "PROVEN_PARENT_ACCOUNT_FLOWS");
  assert.equal(result.flows.length, 2);
  assert.equal(result.operational_amount, 100);
  assert.equal(result.closing_amount_excluded, 100);
  assert.equal(result.consumed_amount_once, 100);
  assert.equal(result.source_row_ids.length, 5);
  assert.equal(result.flows.every((flow) => flow.closing_non_additive === true), true);
  assert.equal(result.flows.every((flow) => flow.correction_authority === false), true);
  assert.equal(result.flows.find((flow) => flow.article === "Компонент Б").owner_code, "R102");
});

test("generic account-flow proof blocks an unmatched closing flow", () => {
  const rows = operations().map((row) =>
    row.physical_row === 1003 ? { ...row, amount: 39 } : row);
  const result = classifyProvenParentAccountFlows({
    financialRows: financialRows(),
    activeRows: rows,
    period: "2026-02",
    allowedJournalOrganizations: new Set(["Тестовая организация"]),
  });

  assert.equal(result.status, "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED");
  assert.equal(result.flows.length, 0);
  assert.equal(result.correction_authority, false);
  assert.equal(result.posting_rows, 0);
  const evidence = provenParentAccountFlowNodeEvidence(result);
  assert.equal(evidence[0].component_flows.length, 0);
  assert.equal(evidence[0].blockers.length, 1);
  assert.equal(evidence[1].node_kind, "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER");
  assert.equal(evidence[1].node_status, "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED");
});

test("a blocked independent composition remains visible while a later proven account flow survives", async () => {
  const blockedComponent = source("Заблокированный компонент", 30, "D5", true);
  const blockedFinancialRows = [
    { code: "R090", erp: { amount: 30, trace: [blockedComponent] } },
    ...financialRows(),
  ];
  const rows = [
    operation({ row: 901, article: "Заблокированный компонент", amount: 30, debit: "91.2", credit: "60" }),
    operation({ row: 902, article: "Заблокированный компонент", amount: 29, debit: "99", credit: "91.2" }),
    ...operations(),
  ];
  const result = classifyProvenParentAccountFlows({
    financialRows: blockedFinancialRows,
    activeRows: rows,
    period: "2026-02",
    allowedJournalOrganizations: new Set(["Тестовая организация"]),
  });

  assert.equal(result.status, "PROVEN_PARENT_ACCOUNT_FLOWS");
  assert.equal(result.flows.length, 2);
  assert.equal(result.operational_amount, 100);
  assert.equal(result.closing_amount_excluded, 100);
  assert.equal(result.consumed_amount_once, 100);
  assert.equal(result.blocked_group_count, 1);
  assert.equal(result.blockers[0].code, "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED");
  assert.equal(result.source_row_ids.includes(rows[0].source_row_id), false);
  assert.equal(result.source_row_ids.includes(rows[1].source_row_id), false);
  assert.equal(result.correction_authority, false);
  assert.equal(result.posting_rows, 0);
  const evidence = provenParentAccountFlowNodeEvidence(result);
  assert.equal(evidence[0].component_flows.length, 2);
  assert.equal(evidence[0].blockers.length, 1);
  assert.equal(evidence[1].node_kind, "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER");
  assert.equal(evidence[1].node_status, "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED");
  const projected = provenOperationWorkbookRows({ rows: [], node_evidence: evidence });
  assert.equal(projected.blocker_count, 1);
  assert.equal(projected.rows.length, 1);
  assert.equal(projected.rows[0][2], "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER");
  assert.match(projected.rows[0][22], /BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED/);
  assert.match(projected.rows[0][23], /correction_authority=false; posting_rows=0/);

  const escape = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const columnName = (index) => {
    let value = index;
    let result = "";
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  };
  const cells = projected.rows[0].map((value, column) =>
    `<x:c r="${columnName(column + 1)}1" t="inlineStr"><x:is><x:t>${escape(value)}</x:t></x:is></x:c>`).join("");
  const zip = new JSZip();
  zip.file("xl/worksheets/sheet1.xml", `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1">${cells}</x:row></x:sheetData></x:worksheet>`);
  const reopened = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
  const xml = await reopened.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(xml, /PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER/);
  assert.match(xml, /BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED/);
  assert.match(xml, /correction_authority=false; posting_rows=0/);
});
