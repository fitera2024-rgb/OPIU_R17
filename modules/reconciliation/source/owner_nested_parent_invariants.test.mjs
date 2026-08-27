import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  classifyProvenParentAccountFlows,
  provenParentAccountFlowNodeEvidence,
} from "./arbitrary_period_operation_evidence.mjs";
import { projectOwnerEconomicDecisions } from "./owner_decision_projection.mjs";

const SHA = "A".repeat(64);
const ORGANIZATION = "9 Управляющая компания";

function exactTrace(article, amount, cell) {
  return {
    article,
    amount,
    month: "2025-10",
    source_cell: cell,
    source_tree_proof: { complete: true, status: "LEAF" },
    exact_parent_component: true,
  };
}

function operation(row, { debit, credit }) {
  return {
    physical_row: row,
    source_range: `B${row}:AG${row}`,
    source_row_id: crypto.createHash("sha256").update(String(row)).digest("hex").toUpperCase(),
    date: "31.10.2025 23:59:59",
    document: row === 99 ? "Закрытие месяца" : "Операция МСФО",
    posting_no: row,
    organization: ORGANIZATION,
    debit,
    credit,
    debit_analytics: [],
    credit_analytics: [],
    amount: 10644,
    article: "Финансовые расходы",
    disclosure: "Счет затрат 91.2",
    period: "2025-10",
    erp_input_sha256: SHA,
    erp_opiu_sha256: SHA,
    journal_sha256: SHA,
    journal_sheet: "ERP",
  };
}

function routeMemberSet(sourceCodes, targetCodes) {
  return crypto.createHash("sha256").update(JSON.stringify({
    source_codes: [...sourceCodes].sort((left, right) => left.localeCompare(right, "en")),
    target_codes: [...targetCodes].sort((left, right) => left.localeCompare(right, "en")),
  })).digest("hex").toUpperCase();
}

function octoberRouteRow(code, delta, branch) {
  const sourceCodes = ["R033"];
  const targetCodes = ["R023"];
  return {
    code,
    organization: ORGANIZATION,
    period: "2025-10",
    economic_branch_id: branch,
    intalev_amount: delta < 0 ? 0 : delta,
    erp_amount: delta < 0 ? Math.abs(delta) : 0,
    delta,
    intergroup_root_delta: delta,
    intergroup_reclass_id: "OWNER-UK9-2025-10-R033-R023",
    intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
    intergroup_reclass_source_codes: sourceCodes,
    intergroup_reclass_target_codes: targetCodes,
    intergroup_reclass_member_set_sha256: routeMemberSet(sourceCodes, targetCodes),
  };
}

function ledgerByCode(projection) {
  return new Map(projection.residual_ledger.rows.map((row) => [row.code, row]));
}

test("October R049 closing posting 99 is visible but non-additive after the 10,644 flow is consumed once", () => {
  const component = exactTrace("Финансовые расходы", 10644, "D176");
  const financialRows = [
    { code: "R049", intalev_amount: 15303428.26, erp_amount: 15303428.26, delta: 0,
      erp: { amount: 10644, trace: [component] } },
    { code: "R050", presentation_parent_code: "R049", intalev_amount: 19623, erp_amount: 8979,
      delta: 10644, erp: { amount: 10644, trace: [component] } },
    { code: "R051", presentation_parent_code: "R050", intalev_amount: 19623, erp_amount: 8979,
      delta: 10644, erp: { amount: 10644, trace: [component] } },
  ];
  const proof = classifyProvenParentAccountFlows({
    financialRows,
    activeRows: [
      operation(98, { debit: "91.2", credit: "76" }),
      operation(99, { debit: "99", credit: "91.2" }),
    ],
    period: "2025-10",
    allowedJournalOrganizations: new Set([ORGANIZATION]),
  });

  assert.equal(financialRows.find((row) => row.code === "R049").delta, 0);
  assert.equal(financialRows.find((row) => row.code === "R050").delta, 10644);
  assert.equal(financialRows.find((row) => row.code === "R051").delta, 10644);
  assert.equal(proof.status, "PROVEN_PARENT_ACCOUNT_FLOWS");
  assert.equal(proof.flows.length, 1);
  assert.equal(proof.consumed_amount_once, 10644);
  assert.equal(proof.closing_amount_excluded, 10644);
  assert.equal(proof.flows[0].operational_rows[0].posting_no, 98);
  assert.equal(proof.flows[0].closing_rows[0].posting_no, 99);
  assert.equal(proof.flows[0].closing_non_additive, true);
  assert.equal(proof.correction_authority, false);
  assert.equal(proof.posting_rows, 0);
  const evidence = provenParentAccountFlowNodeEvidence(proof)[0];
  assert.equal(evidence.component_flows[0].consumed_amount_once, 10644);
  assert.equal(evidence.component_flows[0].closing_non_additive, true);
  assert.equal(evidence.component_flows[0].posting_rows, 0);
});

test("October R033/R023 consumes 244,745 at intergroup roots before leaving descendants independent", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: ORGANIZATION,
    period: "2025-10",
    rows: [
      octoberRouteRow("R033", -244745, "PAYROLL"),
      { code: "R034", presentation_parent_code: "R033", organization: ORGANIZATION,
        period: "2025-10", economic_branch_id: "PAYROLL", intalev_amount: 17434.79,
        erp_amount: 16684.79, delta: 750 },
      { code: "R036", presentation_parent_code: "R033", organization: ORGANIZATION,
        period: "2025-10", economic_branch_id: "PAYROLL", intalev_amount: 10756935.99,
        erp_amount: 9925681.99, delta: 831254 },
      { code: "R035", presentation_parent_code: "R036", organization: ORGANIZATION,
        period: "2025-10", economic_branch_id: "PAYROLL", intalev_amount: 1196070,
        erp_amount: 1076749, delta: 119321 },
      octoberRouteRow("R023", 244745, "PERSONNEL"),
    ],
  });
  const ledger = ledgerByCode(projection);
  const route = projection.generic_reclassification.candidates.find((candidate) =>
    candidate.intergroup_reclass_id === "OWNER-UK9-2025-10-R033-R023"
      && candidate.accepted_intergroup_reclass === true);

  assert.ok(route);
  assert.equal(route.processing_stage, "INTERGROUP_ROOTS_FIRST");
  assert.equal(route.accepted_amount, 244745);
  assert.deepEqual(route.source_members.map((member) => [member.code, member.root_effective_delta]), [["R033", 0]]);
  assert.deepEqual(route.target_members.map((member) => [member.code, member.root_effective_delta]), [["R023", 0]]);
  assert.equal(ledger.get("R033").effective_delta, 0);
  assert.equal(ledger.get("R033").consumed_by_intergroup_reclass, -244745);
  assert.equal(ledger.get("R023").effective_delta, 0);
  assert.equal(ledger.get("R023").consumed_by_intergroup_reclass, 244745);
  for (const [code, expected] of [["R034", 750], ["R036", 831254], ["R035", 119321]]) {
    assert.equal(ledger.get(code).effective_delta, expected);
    assert.equal(ledger.get(code).consumed_by_intergroup_reclass, 0);
  }
  assert.equal(projection.generic_reclassification.audit.duplicate_root_correction_count, 0);
  assert.equal(projection.safety.posting_rows, 0);
  assert.equal(projection.safety.storno_rows, 0);
  assert.equal(projection.safety.repost_rows, 0);
});

test("November R033 remains zero while 1,500, 1,110,730 and nested 93,588 stay visible without 95,088", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: ORGANIZATION,
    period: "2025-11",
    rows: [
      { code: "R033", organization: ORGANIZATION, period: "2025-11",
        intalev_amount: 12356000.90, erp_amount: 12356000.90, delta: 0 },
      { code: "R034", presentation_parent_code: "R033", organization: ORGANIZATION,
        period: "2025-11", intalev_amount: 23000, erp_amount: 21500, delta: 1500 },
      { code: "R036", presentation_parent_code: "R033", organization: ORGANIZATION,
        period: "2025-11", intalev_amount: 12333000.90, erp_amount: 11222270.90, delta: 1110730 },
      { code: "R035", presentation_parent_code: "R036", organization: ORGANIZATION,
        period: "2025-11", intalev_amount: 1205818, erp_amount: 1112230, delta: 93588 },
    ],
  });
  const ledger = ledgerByCode(projection);

  assert.equal(ledger.get("R033").effective_delta, 0);
  assert.equal(ledger.get("R033").consumed_by_descendants, 0);
  assert.equal(ledger.get("R034").effective_delta, 1500);
  assert.equal(ledger.get("R036").effective_delta, 1110730);
  assert.equal(ledger.get("R035").effective_delta, 93588);
  assert.equal(projection.residual_ledger.rows.some((row) =>
    [row.raw_delta, row.effective_delta, row.consumed_by_descendants].includes(95088)), false);
  assert.equal(projection.cases.some((decisionCase) => decisionCase.amount === 95088), false);
  assert.equal(projection.safety.posting_rows, 0);
  assert.equal(projection.safety.storno_rows, 0);
  assert.equal(projection.safety.repost_rows, 0);
  assert.equal(projection.safety.ready_to_upload, false);
});
