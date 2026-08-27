import test from "node:test";
import assert from "node:assert/strict";
import { adaptR005, hierarchyIdentityPath } from "./r005_identity_guard.mjs";

const context = {
  run_id: "RUN-GROUP",
  period: "2025-11",
  organization: { id: "UK9", name: "9 Управляющая компания" },
  paths: {},
  source_hashes: {},
};

function payload() {
  const groupPath = "Расходы / Административные расходы / Расходы на персонал / Прочие расходы на персонал";
  return {
    schema: "opiu-codex-review-input-v1",
    organization_code: "ERP-000000224",
    organization: "9 Управляющая компания",
    period: "2025-11",
    tolerance: 0.01,
    rows: [
      {
        code: "R028",
        group: "ДЕТАЛЬ",
        hierarchy_group: "ДЕТАЛЬ",
        hierarchy_parent_code: "R023",
        hierarchy_has_children: false,
        is_discrepancy: true,
        reconciliation_status: "DISCREPANCY",
        intalev_label: "Прочие расходы на персонал",
        erp_label: "Прочие расходы на персонал",
        intalev_amount: 50000,
        erp_amount: 49900,
        delta: 100,
        intalev_paths: [groupPath],
        erp_paths: ["ERP / Административные расходы / Прочие расходы на персонал"],
        erp_catalog_paths: ["Административные расходы / Расходы на персонал / Прочие расходы на персонал"],
        article_codes: ["00-000031"],
      },
    ],
    operation_evidence: {
      rows: [],
      unassigned_rows: [
        {
          article: "Аренда квартиры (Томчак)",
          registrar: "Операция 0001",
          posting_number: "7",
          source_row: "1250",
          debit_account: "26",
          credit_account: "60.01",
          amount: 100,
          proof_status: "CANDIDATE_NOT_PROVEN",
          row_class: "CANDIDATE_EXCLUDED",
        },
      ],
    },
    hierarchy_periods: [
      {
        period: "2025-11",
        intalev_tree: {
          nodes: [
            {
              node_id: "G",
              label: "Прочие расходы на персонал",
              full_path: groupPath,
              direct_total: 50000,
              immediate_children: [],
              is_group: false,
              hierarchy_status: "LEAF",
              source: { sheet: "TDSheet", row: 105, source_cell: "E105" },
            },
            {
              node_id: "C",
              label: "Аренда квартиры (Томчак)",
              full_path: `${groupPath} / Аренда квартиры (Томчак)`,
              direct_total: 50000,
              immediate_children: [],
              is_group: false,
              hierarchy_status: "LEAF",
              source: { sheet: "TDSheet", row: 106, source_cell: "E106" },
            },
          ],
        },
        erp_tree: { nodes: [] },
      },
    ],
  };
}

test("group discrepancy remains informational and creates neither a rule decision nor an R001 application", () => {
  const result = adaptR005(payload(), context);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.informational_controls.length, 1);
  const candidate = result.informational_controls[0];
  const breakdown = candidate.evidence.group_delta_breakdown;
  assert.ok(breakdown);
  assert.equal(breakdown.mode, "GROUP_DRILLDOWN_REVIEW_ONLY");
  assert.equal(breakdown.group_code, "R028");
  assert.equal(breakdown.group_delta, 100);
  assert.equal(breakdown.intalev_source_group.linkage, "EXACT_PATH_FALLBACK_REVIEW_ONLY");
  assert.equal(breakdown.intalev_source_group.children.length, 1);
  assert.equal(breakdown.intalev_source_group.children[0].label, "Аренда квартиры (Томчак)");
  assert.equal(breakdown.exact_article_review_rows.length, 1);
  assert.equal(breakdown.exact_article_review_rows[0].debit_account, "26");
  assert.equal(breakdown.exact_article_review_rows[0].credit_account, "60.01");
  assert.equal(candidate.group_review_only, true);
  assert.equal(candidate.action.action_type, "CONTROL_ONLY");
  assert.equal(candidate.impact_class, "CONTROL_ONLY");
  assert.equal(candidate.decision, "NO_RULE");
  assert.match(candidate.evidence.explanation, /саму группировку не корректировать/i);
  assert.equal(result.applications.length, 0);
});

test("presentation hierarchy_group is not embedded into business rule identity", () => {
  assert.equal(
    hierarchyIdentityPath("Административные расходы / НДФЛ", { hierarchy_group: "ДЕТАЛЬ" }),
    "Административные расходы / НДФЛ",
  );
  assert.equal(
    hierarchyIdentityPath("Административные расходы / НДФЛ", { disclosure_group: "Налоги с ФОТ" }),
    "Административные расходы / НДФЛ / DISCLOSURE::Налоги с ФОТ",
  );
});

function discrepancyRow(code, overrides = {}) {
  return {
    code,
    group: "СТАТЬЯ",
    hierarchy_group: "СТАТЬЯ",
    hierarchy_has_children: false,
    is_discrepancy: true,
    reconciliation_status: "DISCREPANCY",
    intalev_label: `Инталев ${code}`,
    erp_label: `ERP ${code}`,
    intalev_amount: 110,
    erp_amount: 100,
    delta: 10,
    intalev_paths: [`Расходы / ${code}`],
    erp_catalog_paths: [`Расходы / ${code}`],
    article_codes: [`ERP-${code}`],
    ...overrides,
  };
}

test("R001, R050/R051, and any other declared parent remain CONTROL_ONLY without materialized children", () => {
  const fixture = payload();
  fixture.rows = [
    discrepancyRow("R001", { group: "БЛОК", hierarchy_group: "БЛОК" }),
    discrepancyRow("R050", { group: "ПОДБЛОК", hierarchy_group: "ПОДБЛОК" }),
    discrepancyRow("R051", { hierarchy_has_children: true }),
    discrepancyRow("R020", { row_kind: "GROUP" }),
    discrepancyRow("R052"),
  ];
  fixture.operation_evidence = { rows: [], unassigned_rows: [] };
  fixture.hierarchy_periods = [];

  const result = adaptR005(fixture, context);
  const controlCodes = result.informational_controls
    .map((candidate) => candidate.action.parameters.row_code)
    .sort();

  assert.deepEqual(controlCodes, ["R001", "R020", "R050", "R051"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.action.parameters.row_code), ["R052"]);
  assert.equal(result.applications.length, 1);
  assert.match(result.applications[0].application_id, /R052$/);
  assert.equal(result.applications.some((application) => controlCodes.includes(application.application_id.split("-").at(-1))), false);
});

test("a parent/group member cannot turn a zero-sum pair into an application", () => {
  const fixture = payload();
  fixture.rows = [
    discrepancyRow("R050", { group: "ПОДБЛОК", hierarchy_group: "ПОДБЛОК", delta: -10 }),
    discrepancyRow("R052", { delta: 10 }),
  ];
  fixture.zero_sum_storno_repost_candidates = [{
    source_codes: ["R050"],
    target_codes: ["R052"],
    member_deltas: [{ code: "R050", delta: -10 }, { code: "R052", delta: 10 }],
  }];
  fixture.operation_evidence = { rows: [], unassigned_rows: [] };
  fixture.hierarchy_periods = [];

  const result = adaptR005(fixture, context);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.informational_controls.length, 1);
  assert.equal(result.informational_controls[0].action.action_type, "CONTROL_ONLY");
  assert.equal(result.applications.length, 0);
});
