import assert from "node:assert/strict";
import test from "node:test";

import { mergeOwnerAndRuleDecisions } from "./owner_decision_r001.mjs";
import { bridgeR001DecisionsToMaterializationCases } from "./r001_materialization_bridge.mjs";
import { canonicalSpornoRowFromMaterializationCase } from "./r001_canonical_output_contract.mjs";
import { projectOwnerEconomicDecisions } from "../../reconciliation/source/owner_decision_projection.mjs";

const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);

function directionlessApplication() {
  return {
    application_id: "APP-DIRECTIONLESS",
    candidate_id: "CAND-DIRECTIONLESS",
    organization_id: "REPORT-ORG",
    organization_name: "Report organization",
    period: "2026-01",
    result_status: "REVIEW",
    proof_status: "UNPROVEN",
    review_state: "NEEDS_REVIEW",
    output_route: "СПОРНО",
    disputed_only: true,
    execution_allowed: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    amount: 25,
    candidate_snapshot: {
      action: { action_type: "ONE_SIDE", parameters: { delta: 25 } },
      evidence: { proof_status: "UNPROVEN", evidence_rows: [] },
    },
  };
}

function decision(overrides = {}) {
  return {
    case_id: "CASE-1",
    pair_id: "PAIR-1",
    decision_type: "STORNO",
    role: "STANDALONE",
    period: "2026-01",
    organization: "Report organization",
    reconciliation_row: "ROW-1",
    analytical_basis_id: "BASIS-1",
    analytical_effect: -25,
    correction_amount: 25,
    proof_status: "INCOMPLETE",
    correction_allowed: false,
    correction_authority: "ECONOMIC_DIRECTION_PROVEN",
    output_route: "SPORNO",
    source_organization: "",
    source_archive_path: "",
    source_archive_sha256: "",
    journal_entry: "",
    journal_sha256: "",
    source_sheet: "",
    source_range: "",
    source_row_id: "",
    source_date: "",
    registrar: "",
    posting_number: "",
    source_dt: "",
    source_kt: "",
    source_analytics_dt1: "",
    source_analytics_dt2: "",
    source_analytics_dt3: "",
    source_analytics_kt1: "",
    source_analytics_kt2: "",
    source_analytics_kt3: "",
    source_department_dt: "",
    source_department_kt: "",
    source_amount: 25,
    target_dt: "",
    target_kt: "",
    target_analytics_dt1: "",
    target_analytics_dt2: "",
    target_analytics_dt3: "",
    target_analytics_kt1: "",
    target_analytics_kt2: "",
    target_analytics_kt3: "",
    target_department_dt: "",
    target_department_kt: "",
    ...overrides,
  };
}

function reclassRow(code, delta, parent, branch, proof = {}) {
  return {
    code,
    row_id: code,
    organization: "Report organization",
    period: "2026-01",
    hierarchy_parent_code: parent,
    presentation_parent_code: parent,
    hierarchy_has_children: false,
    branch_key: branch,
    intalev_amount: delta > 0 ? delta : 0,
    erp_amount: delta < 0 ? Math.abs(delta) : 0,
    raw_delta: delta,
    delta,
    ...proof,
  };
}

test("merged pinned decisions cross one canonical materialization bridge", () => {
  const merged = mergeOwnerAndRuleDecisions({
    applicationsDocument: { applications: [directionlessApplication()] },
    projection: { cases: [], row_links: {}, presentation_block_exemptions: [] },
    organization: "Report organization",
    period: "2026-01",
  });

  assert.equal(merged.materialization_bridge.schema_version, "opiu-r001-materialization-bridge.v1");
  assert.equal(merged.materialization_bridge.review_only_cases.length, 1);
  assert.equal(merged.materialization_bridge.review_only_cases[0].action, "ADD_ONE_SIDE");
  assert.equal(merged.materialization_bridge.review_only_cases[0].output_route, "REVIEW_ONLY");
  assert.equal(merged.materialization_bridge.financial_cases.length, 0);
});

test("accepted intergroup economics bridge to source STORNO and target REPOST with shared proof", () => {
  const proof = {
    intergroup_reclass_id: "ROUTE-ACCEPTED-1",
    intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
  };
  const projection = projectOwnerEconomicDecisions({
    organization: "Report organization",
    period: "2026-01",
    hierarchy_graph_validated: true,
    rows: [
      reclassRow("TOP", 0, "", "TOP"),
      reclassRow("SOURCE_ROOT", -100, "TOP", "SOURCE", proof),
      reclassRow("TARGET_ROOT", 100, "TOP", "TARGET", proof),
    ],
  });
  const merged = mergeOwnerAndRuleDecisions({
    projection,
    organization: "Report organization",
    period: "2026-01",
  });
  const cases = merged.materialization_bridge.financial_cases;

  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map((item) => [item.action, item.role]), [
    ["STORNO", "RECLASS_SOURCE"],
    ["REPOST", "RECLASS_TARGET"],
  ]);
  assert.ok(cases.every((item) => item.output_route === "SPORNO"));
  assert.ok(cases.every((item) => item.economic_route.route_id === "ROUTE-ACCEPTED-1"));
  assert.deepEqual(cases.map((item) => item.signed_economic_effect), [-100, 100]);
  assert.deepEqual(cases.map((item) => item.economic_route.accepted_effect), [-100, 100]);
  assert.ok(cases.every((item) => item.economic_route.root_effective_delta === 0));
  assert.ok(cases.every((item) => item.physical_source.source_organization === ""));
  assert.ok(merged.decisions.every((item) => item.materialization_case));
});

test("explicit Rules direction preserves role, source organization, SourceRowID and three analytics slots", () => {
  const application = directionlessApplication();
  application.candidate_snapshot.action = {
    action_type: "STORNO_REPOST",
    parameters: { delta: -25, direction: "STORNO", role: "RECLASS_SOURCE" },
  };
  application.candidate_snapshot.evidence.evidence_rows = [{
    source_organization: "Rules physical ERP organization",
    source_row_id: "RULES-ROW-25",
    source_archive_path: "rules-source.zip",
    source_archive_sha256: HASH_A,
    journal_entry: "rules-journal.xlsx",
    journal_sha256: HASH_B,
    source_sheet: "Journal",
    source_range: "Journal!A25:AA25",
    date: "25.01.2026",
    document: "Rules document",
    posting_number: "2",
    debit: "20",
    credit: "60",
    debit_analytics: ["RD1", "RD2", "RD3"],
    credit_analytics: ["RC1", "RC2", "RC3"],
    debit_department: "Rules debit department",
    credit_department: "Rules credit department",
    amount: 25,
  }];
  const merged = mergeOwnerAndRuleDecisions({
    applicationsDocument: { applications: [application] },
    projection: { cases: [], row_links: {}, presentation_block_exemptions: [] },
    organization: "Report organization",
    period: "2026-01",
  });
  const [materializationCase] = merged.materialization_bridge.financial_cases;

  assert.equal(materializationCase.action, "STORNO");
  assert.equal(materializationCase.role, "RECLASS_SOURCE");
  assert.equal(materializationCase.reconciliation_organization, "Report organization");
  assert.equal(materializationCase.physical_source.source_organization, "Rules physical ERP organization");
  assert.equal(materializationCase.physical_source.source_row_id, "RULES-ROW-25");
  assert.deepEqual(materializationCase.physical_source.debit_analytics, ["RD1", "RD2", "RD3"]);
  assert.deepEqual(materializationCase.physical_source.credit_analytics, ["RC1", "RC2", "RC3"]);
  assert.equal(materializationCase.provenance.source, "RULES_APPLICATION");
  assert.equal(materializationCase.output_route, "SPORNO");
});

test("equal opposite roots without accepted proof create no financial canonical case", () => {
  const projection = projectOwnerEconomicDecisions({
    organization: "Report organization",
    period: "2026-01",
    hierarchy_graph_validated: true,
    rows: [
      reclassRow("SOURCE_ROOT", -100, "", "SOURCE"),
      reclassRow("TARGET_ROOT", 100, "", "TARGET"),
    ],
  });
  const merged = mergeOwnerAndRuleDecisions({ projection, organization: "Report organization", period: "2026-01" });

  assert.equal(merged.materialization_bridge.financial_cases.length, 0);
  assert.equal(merged.materialization_bridge.canonical_posting_rows.length, 0);
  assert.ok(merged.materialization_bridge.skipped.every((item) =>
    ["NO_POSTING_NON_FINANCIAL", "ECONOMIC_DIRECTION_UNPROVEN"].includes(item.blocker)));
});

test("explicit STORNO and REPOST stay directional SPORNO with unknown physical fields blank", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([
    decision({ case_id: "STORNO-CASE", pair_id: "PAIR-X", decision_type: "STORNO", analytical_effect: -25 }),
    decision({ case_id: "REPOST-CASE", pair_id: "PAIR-X", decision_type: "REPOST", analytical_effect: 25 }),
  ]);

  assert.deepEqual(bridge.financial_cases.map((item) => item.action), ["STORNO", "REPOST"]);
  assert.ok(bridge.financial_cases.every((item) => item.output_route === "SPORNO"));
  assert.ok(bridge.financial_cases.every((item) => item.physical_source.source_organization === ""));
  assert.ok(bridge.financial_cases.every((item) => item.physical_source.source_row_id === ""));
  assert.equal(bridge.canonical_posting_rows.length, 0);
});

test("exact ERP organization and SourceRowID provenance never collapse into report organization", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([decision({
    output_route: "READY",
    correction_allowed: true,
    SOURCE_OPERATION_PROVEN: true,
    PHYSICAL_SOURCE_UNIQUE: true,
    proof_status: "ECONOMIC_CORRECTION_PROVEN",
    correction_authority: "ECONOMIC_CORRECTION_PROVEN",
    source_organization: "Physical ERP organization",
    source_archive_path: "evidence/erp.zip",
    source_archive_sha256: HASH_A,
    journal_entry: "journal.xlsx",
    journal_sha256: HASH_B,
    source_sheet: "Journal",
    source_range: "Journal!A42:AA42",
    source_row_id: "ERP-ROW-42",
    source_date: "15.01.2026",
    registrar: "Document 42",
    posting_number: "7",
    source_dt: "26",
    source_kt: "60",
    source_analytics_dt1: "D1",
    source_analytics_dt2: "D2",
    source_analytics_dt3: "D3",
    source_analytics_kt1: "C1",
    source_analytics_kt2: "C2",
    source_analytics_kt3: "C3",
    source_department_dt: "Debit department",
    source_department_kt: "Credit department",
  })], { provenance: { handoff_sha256: HASH_A, applications_sha256: HASH_B } });
  const [materializationCase] = bridge.financial_cases;

  assert.equal(materializationCase.output_route, "READY");
  assert.equal(materializationCase.reconciliation_organization, "Report organization");
  assert.equal(materializationCase.physical_source.source_organization, "Physical ERP organization");
  assert.equal(materializationCase.physical_source.source_row_id, "ERP-ROW-42");
  assert.equal(materializationCase.physical_source.source_archive_sha256, HASH_A);
  assert.equal(materializationCase.physical_source.journal_sha256, HASH_B);
  assert.equal(materializationCase.provenance.handoff_sha256, HASH_A);
  assert.deepEqual(materializationCase.physical_source.debit_analytics, ["D1", "D2", "D3"]);
});

test("blank and unclassified source amounts do not become STORNO from blankness", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([
    decision({ case_id: "BLANK-39799", correction_amount: 39799, analytical_effect: -39799, classification: "PRESENT_UNCLASSIFIED_UNBOUND" }),
    decision({ case_id: "BLANK-5700", correction_amount: 5700, analytical_effect: -5700, source_scope_status: "EMPTY_ARTICLE" }),
  ]);

  assert.equal(bridge.financial_cases.length, 0);
  assert.ok(bridge.skipped.every((item) => item.blocker === "BLANK_UNCLASSIFIED_HAS_NO_FINANCIAL_AUTHORITY"));
});

test("mapping and structural root controls create no financial cases while descendants stay independent", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([
    decision({ case_id: "MAPPING", decision_type: "UPDATE_MAPPING" }),
    decision({ case_id: "STRUCTURAL-OK", classification: "STRUCTURAL_GROUP_SUM_OK" }),
    decision({ case_id: "STRUCTURAL-MISMATCH", classification: "STRUCTURAL_GROUP_SUM_MISMATCH" }),
    decision({ case_id: "DESCENDANT", pair_id: "DESC-PAIR", reconciliation_row: "CHILD", decision_type: "REPOST", analytical_effect: 10, correction_amount: 10 }),
  ]);

  assert.equal(bridge.financial_cases.length, 1);
  assert.equal(bridge.financial_cases[0].case_id, "DESCENDANT");
  assert.equal(bridge.skipped.length, 3);
});

test("hierarchy arithmetic negatives remain non-financial without accepted proof", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([
    decision({ case_id: "NOVEMBER-95088", decision_type: "STORNO_REPOST", role: "RECLASS_SOURCE", correction_amount: 95088, analytical_effect: -95088, correction_authority: "" }),
    decision({ case_id: "NOVEMBER-36398", decision_type: "STORNO_REPOST", role: "RECLASS_TARGET", correction_amount: 36398.45, analytical_effect: 36398.45, correction_authority: "" }),
  ]);

  assert.equal(bridge.financial_cases.length, 0);
  assert.ok(bridge.skipped.every((item) => item.blocker === "ECONOMIC_DIRECTION_UNPROVEN"));
});

test("bridge keeps analytical basis, authority, reason, blockers and REPORT_ONLY safety", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([decision({
    analytical_basis_id: "EXACT-BASIS",
    residual_atom_id: "ATOM-1",
    transformation_id: "TRANSFORM-1",
    raw_delta: -25,
    effective_delta: 0,
    reason: "Explicit economic decision",
    blockers: ["PHYSICAL_SOURCE_MISSING"],
  })]);
  const [materializationCase] = bridge.financial_cases;

  assert.equal(materializationCase.analytical_basis.analytical_basis_id, "EXACT-BASIS");
  assert.equal(materializationCase.analytical_basis.residual_atom_id, "ATOM-1");
  assert.equal(materializationCase.analytical_basis.transformation_id, "TRANSFORM-1");
  assert.equal(materializationCase.correction_authority, "ECONOMIC_DIRECTION_PROVEN");
  assert.equal(materializationCase.reason, "Explicit economic decision");
  assert.deepEqual(materializationCase.blockers, ["PHYSICAL_SOURCE_MISSING"]);
  assert.equal(bridge.audit.canonical_posting_row_count, 0);
  assert.deepEqual(bridge.safety, {
    report_only: true,
    execution_allowed: false,
    ready_to_upload: false,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
  });
});

test("bridge preserves verified Intalev evidence into canonical column P without technical leakage", () => {
  const bridge = bridgeR001DecisionsToMaterializationCases([decision({
    intalev_references: [{
      code: "R999",
      source_file: "invented.xlsx",
      sheet: "Fake",
      source_cell: "A1",
      verified: false,
    }],
    intalev_technical_reference: `R033: C:\\audit\\intalev-october.xlsx!TDSheet!E103; путь Расходы / ФЗП; JournalSHA=${HASH_A}`,
  })]);
  const materializationCase = bridge.financial_cases[0];
  const row = canonicalSpornoRowFromMaterializationCase(materializationCase);

  assert.deepEqual(materializationCase.business_evidence.intalev_references, [{
    code: "R033",
    source_file: "intalev-october.xlsx",
    sheet: "TDSheet",
    source_cell: "E103",
    full_path: "Расходы / ФЗП",
    document: "",
    verified: true,
  }]);
  assert.match(row.loader_values[15], /Инталев: R033: файл «intalev-october\.xlsx», лист «TDSheet», ячейка E103, путь «Расходы \/ ФЗП»/);
  assert.doesNotMatch(row.loader_values[15], /invented\.xlsx|JournalSHA|[A-F0-9]{64}|C:\\audit|UNKNOWN/);
});
