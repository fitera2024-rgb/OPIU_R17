import assert from "node:assert/strict";
import test from "node:test";
import { bridgeR001DecisionsToMaterializationCases } from "./r001_materialization_bridge.mjs";
import { LOADER_A_AA_FIELDS } from "./r001_materialization_contract.mjs";
import {
  canonicalSpornoRowFromMaterializationCase,
  collectCanonicalFinancialOutput,
} from "./r001_canonical_output_contract.mjs";
import { rulesApplicationsToDisputedDecisions } from "./rules_application_handoff.mjs";

function safeApplication(overrides = {}) {
  return {
    application_id: "APP-1", candidate_id: "CAND-1", run_id: "RUN-1",
    organization_id: "ORG-1", organization_name: "Organization 1", period: "2025-01",
    result_status: "REVIEW", proof_status: "UNPROVEN", review_state: "NEEDS_REVIEW",
    output_route: "СПОРНО", disputed_only: true,
    execution_allowed: false, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false,
    amount: 125,
    candidate_snapshot: {
      candidate_id: "CAND-1", scope: { organization_id: "ORG-1" },
      action: { action_type: "STORNO_REPOST", condition_text: "Статья уточнена по сверке R005", parameters: { row_code: "R025", delta: 125 } },
      intalev: { article_code: "R025", article_name: "Мат помощь", amount: 1125 },
      erp: { article_code: "ERP-25", article_name: "Прочие выплаты", amount: 1000 },
      account_selection: { catalog_version_id: "ERP-CATALOG-1", debit_account_id: "ACC-26", credit_account_id: "ACC-791" },
      accounting: { debit_account: "26", credit_account: "79.1" },
      evidence: { proof_status: "PROVEN", evidence_rows: [{ debit: "20", credit: "60", article: "Мат помощь", registrar: "Документ 1", posting_number: "7", source_row: "15" }] },
    },
    ...overrides,
  };
}

test("safe review application becomes one non-executable SPORNO decision with explicitly selected target accounts", () => {
  const decisions = rulesApplicationsToDisputedDecisions({ applications: [safeApplication()] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approval_state, "ПРЕДЛОЖЕНО");
  assert.equal(decisions[0].source_dt, "20");
  assert.equal(decisions[0].source_kt, "60");
  assert.equal(decisions[0].target_dt, "26");
  assert.equal(decisions[0].target_kt, "79.1");
  assert.match(decisions[0].reason, /Мат помощь/);
  assert.match(decisions[0].reason, /Прочие выплаты/);
  assert.match(decisions[0].reason, /Кт 60 → 79\.1/);
  assert.equal(decisions[0].analytical_basis_id, "R025");
  assert.equal(decisions[0].analytical_effect, 125);
  assert.equal(decisions[0].erp_current, 1000);
  assert.equal(decisions[0].intalev_target, 1125);
  assert.deepEqual(decisions[0].basis_contract_blockers, []);
  assert.equal(decisions[0].rules_application_review, true);
  assert.equal(decisions[0].execution_allowed, false);
  assert.equal(decisions[0].ready_to_upload, false);
  assert.equal(decisions[0].release_allowed, false);
});

test("an inconsistent signed R005 basis remains fail-closed", () => {
  const application = safeApplication();
  application.candidate_snapshot.action.parameters.delta = 124;
  const decisions = rulesApplicationsToDisputedDecisions({ applications: [application] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions[0].analytical_basis_id, "R025");
  assert.deepEqual(decisions[0].basis_contract_blockers, ["INVALID_R005_SIGNED_DELTA"]);
  assert.equal(decisions[0].execution_allowed, false);
});

test("without an explicit account replacement target accounts inherit the exact source posting", () => {
  const application = safeApplication();
  delete application.candidate_snapshot.account_selection;
  application.candidate_snapshot.accounting = { debit_account: "20", credit_account: "60" };
  const decisions = rulesApplicationsToDisputedDecisions({ applications: [application] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].source_dt, "20");
  assert.equal(decisions[0].source_kt, "60");
  assert.equal(decisions[0].target_dt, "20");
  assert.equal(decisions[0].target_kt, "60");
  assert.match(decisions[0].reason, /Счета Дт 20 \/ Кт 60 сохраняются/);
  assert.match(decisions[0].solution, /Сохранить исходные счета ERP без замены/);
  assert.equal(decisions[0].approval_state, "ПРЕДЛОЖЕНО");
});

test("a blank ERP article inherits the source posting article while staying review-only", () => {
  const application = safeApplication();
  delete application.candidate_snapshot.account_selection;
  application.candidate_snapshot.erp = { article_code: "", article_name: "", article_path: "" };
  application.candidate_snapshot.accounting = { debit_account: "20", credit_account: "60" };
  const decisions = rulesApplicationsToDisputedDecisions({ applications: [application] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions[0].target_analytics_dt1, "Мат помощь");
  assert.equal(decisions[0].target_dt, "20");
  assert.equal(decisions[0].target_kt, "60");
  assert.equal(decisions[0].execution_allowed, false);
});

test("group-only delta cannot become an R001 correction decision", () => {
  const application = safeApplication();
  delete application.candidate_snapshot.account_selection;
  application.candidate_snapshot.action = { action_type: "ONE_SIDE", condition_text: "Дельта видна на группировке" };
  application.candidate_snapshot.intalev = { article_code: "R028", article_name: "Прочие расходы на персонал" };
  application.candidate_snapshot.erp = { article_code: "00-000031", article_name: "Прочие расходы на персонал" };
  application.candidate_snapshot.accounting = { debit_account: "26", credit_account: "60.01" };
  application.candidate_snapshot.evidence = {
    proof_status: "UNPROVEN",
    evidence_rows: [],
    group_delta_breakdown: {
      mode: "GROUP_DRILLDOWN_REVIEW_ONLY",
      group_code: "R028",
      group_label: "Прочие расходы на персонал",
      group_delta: 100,
      note: "Дельта группировки не является проводкой.",
      financial_children: [
        { code: "R028A", label: "Аренда квартиры (Томчак)", delta: 100 },
      ],
      intalev_source_group: {
        children: [{ label: "Аренда квартиры (Томчак)", direct_total: 50000 }],
      },
      exact_article_review_rows: [
        { registrar: "Операция 0001", posting_number: "7", source_row: "1250", debit_account: "26", credit_account: "60.01", article: "Аренда квартиры (Томчак)", amount: 100 },
      ],
    },
  };
  application.candidate_snapshot.group_review_only = true;
  const decisions = rulesApplicationsToDisputedDecisions({ applications: [application] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions.length, 0);
});

test("unsafe, non-correction, and no-action applications create no disputed decisions", () => {
  const cases = [
    safeApplication({ result_status: "NO_ACTION" }),
    safeApplication({ result_status: "CONFIRMED", proof_status: "PROVEN", output_route: "ГОТОВО", disputed_only: false }),
    safeApplication({ result_status: "APPLIED", proof_status: "PROVEN", output_route: "ГОТОВО", disputed_only: false }),
    safeApplication({ live_1c_allowed: true }),
    safeApplication({ output_route: "ГОТОВО" }),
    safeApplication({ candidate_snapshot: { ...safeApplication().candidate_snapshot, action: { action_type: "MAP_ARTICLE" } } }),
    safeApplication({ candidate_snapshot: null }),
  ];
  for (const application of cases) {
    assert.equal(rulesApplicationsToDisputedDecisions({ applications: [application] }, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" }).length, 0);
  }
});

test("accepted generic economic legs become exactly two sparse signed SPORNO A:AA rows", () => {
  const application = safeApplication({
    application_id: "APP-OCTOBER",
    candidate_id: "GENERIC-OCTOBER",
    period: "2025-10",
    amount: 244745,
    economic_proof_status: "ECONOMIC_RECLASS_PROVEN",
    economic_route_id: "ROUTE-R033-R023",
    candidate_snapshot: {
      candidate_id: "GENERIC-OCTOBER",
      scope: { organization_id: "ORG-1", organization_name: "Organization 1" },
      action: {
        action_type: "STORNO_REPOST",
        condition_text: "Экономический маршрут доказан; физические реквизиты неполны.",
        parameters: {
          reclass_scope: "INTER_GROUP",
          proof_status: "ECONOMIC_RECLASS_PROVEN",
          review_only: true,
          economic_reclass_proven: true,
          accepted_intergroup_reclass: true,
          intergroup_reclass_id: "ROUTE-R033-R023",
          accepted_amount: 244745,
          source_codes: ["R033"],
          target_codes: ["R023"],
          member_legs: [{
            code: "R033", role: "RECLASS_SOURCE", economic_direction: "STORNO",
            correction_amount: 244745, raw_delta: -244745, effective_delta: -244745,
            root_effective_delta: 0, accepted_intergroup_effect: -244745,
            residual_atom_id: "ATOM-R033", article_code: "R033",
            article_name: "ФЗП и компенсационные выплаты",
            article_path: "Административные расходы / ФЗП и компенсационные выплаты",
            accepted_intergroup_reclass: true,
            intergroup_reclass_id: "ROUTE-R033-R023",
            intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
            processing_stage: "INTERGROUP_ROOTS_FIRST", stage_order: 1,
          }, {
            code: "R023", role: "RECLASS_TARGET", economic_direction: "REPOST",
            correction_amount: 244745, raw_delta: 244745, effective_delta: 244745,
            root_effective_delta: 0, accepted_intergroup_effect: 244745,
            residual_atom_id: "ATOM-R023", article_code: "R023",
            article_name: "Расходы на персонал",
            article_path: "Административные расходы / Расходы на персонал",
            accepted_intergroup_reclass: true,
            intergroup_reclass_id: "ROUTE-R033-R023",
            intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
            processing_stage: "INTERGROUP_ROOTS_FIRST", stage_order: 1,
          }],
        },
      },
      intalev: { article_code: "R033", article_name: "ФЗП и компенсационные выплаты" },
      erp: { article_code: "R023", article_name: "Расходы на персонал" },
      accounting: { debit_account: "", credit_account: "" },
      evidence: {
        proof_status: "UNPROVEN",
        evidence_rows: [],
        group_delta_breakdown: { mode: "GROUP_DRILLDOWN_REVIEW_ONLY", group_code: "R033" },
      },
      missing_fields: ["SOURCE_OPERATION_PROVEN:R033", "TARGET_CLASSIFICATION_PROVEN:R023"],
    },
  });

  const decisions = rulesApplicationsToDisputedDecisions(
    { applications: [application] },
    { runId: "RUN-1", organizationId: "ORG-1", period: "2025-10" },
  );
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((decision) => [
    decision.case_id,
    decision.reconciliation_row,
    decision.role,
    decision.economic_direction,
    decision.analytical_effect,
    decision.root_effective_delta,
  ]), [
    ["ROUTE-R033-R023", "R033", "RECLASS_SOURCE", "STORNO", -244745, 0],
    ["ROUTE-R033-R023", "R023", "RECLASS_TARGET", "REPOST", 244745, 0],
  ]);
  assert.equal(decisions.every((decision) => decision.source_organization === ""), true);
  assert.equal(decisions.every((decision) => decision.source_row_id === ""), true);
  assert.equal(decisions.every((decision) => decision.source_dt === "" && decision.source_kt === ""), true);

  const bridge = bridgeR001DecisionsToMaterializationCases(decisions);
  assert.equal(bridge.financial_cases.length, 2);
  assert.deepEqual(bridge.financial_cases.map((item) => item.action), ["STORNO", "REPOST"]);
  assert.equal(bridge.financial_cases.every((item) => item.output_route === "SPORNO"), true);
  assert.equal(bridge.financial_cases.every((item) => item.physical_source.source_row_id === ""), true);

  const rows = bridge.financial_cases.map(canonicalSpornoRowFromMaterializationCase);
  assert.equal(rows[0].loader["СуммаВВалютеОтчетности"], -244745);
  assert.equal(rows[1].loader["СуммаВВалютеОтчетности"], 244745);
  assert.equal(rows[0].loader["ИдентификаторФинЗаписи"], null);
  assert.equal(rows[0].loader["СчетДт"], null);
  assert.equal(rows[0].loader["СчетКт"], null);
  assert.deepEqual(Object.keys(rows[0].loader), LOADER_A_AA_FIELDS);

  const output = collectCanonicalFinancialOutput(rows);
  assert.equal(output.rows.length, 2);
  assert.equal(output.groups.length, 1);
  assert.equal(output.counters.sporno_financial_rows, 2);
  assert.equal(output.counters.storno_rows, 1);
  assert.equal(output.counters.repost_rows, 1);

  for (const mutate of [
    (value) => { value.candidate_snapshot.action.parameters.member_legs[0].root_effective_delta = -1; },
    (value) => { value.candidate_snapshot.action.parameters.accepted_amount = 244744; },
    (value) => { value.candidate_snapshot.action.parameters.member_legs[1].accepted_intergroup_effect = 244744; },
    (value) => { value.candidate_snapshot.action.parameters.member_legs[1].intergroup_reclass_id = "OTHER-ROUTE"; },
    (value) => { value.candidate_snapshot.action.parameters.target_codes = ["R999"]; },
  ]) {
    const rejectedApplication = structuredClone(application);
    mutate(rejectedApplication);
    const rejected = rulesApplicationsToDisputedDecisions(
      { applications: [rejectedApplication] },
      { runId: "RUN-1", organizationId: "ORG-1", period: "2025-10" },
    );
    assert.equal(rejected.length, 0);
    const rejectedBridge = bridgeR001DecisionsToMaterializationCases(rejected);
    assert.equal(rejectedBridge.financial_cases.length, 0);
  }
});
