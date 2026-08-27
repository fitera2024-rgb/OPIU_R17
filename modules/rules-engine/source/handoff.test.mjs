import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHandoff } from "./handoff.mjs";

function safeDefaultCodex(reportSha256 = "") {
  return {
    report_sha256: reportSha256,
    report_only: true,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    structural_control_settings_binding: {
      status: "MISSING_DEFAULT_ALL_GROUPS",
      set_count: 0,
      correction_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      execution_allowed: false,
    },
    structural_group_control_results: [],
  };
}

test("R001 handoff carries the exact run organization and period", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-handoff-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "explicit-companion.json");
  await fs.writeFile(report, "report");
  await fs.writeFile(companion, JSON.stringify(safeDefaultCodex()));
  const result = await buildHandoff({
    workflow: { next_action: "PASS_TO_R001", state_fingerprint: "STATE" },
    context: {
      run_id: "RUN-1",
      period: "2025-01",
      organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false },
      paths: { handoff_root: path.join(root, "handoff"), r005_report: report, r005_codex_input: companion },
    },
    registry: { rules: [], applications: [] },
    candidates: [],
    outputDir: path.join(root, "output"),
  });
  const handoff = JSON.parse(await fs.readFile(result.handoff_path, "utf8"));
  assert.equal(handoff.run_id, "RUN-1");
  assert.deepEqual(handoff.organization, { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false });
  assert.equal(handoff.period, "2025-01");
  assert.equal(handoff.reconciliation.codex_input_path, companion);
  assert.equal(handoff.structural_control_proof.status, "NO_ACTIVE_DEFAULT_ALL_GROUPS");
  assert.deepEqual(handoff.structural_control_proof.applied_version_ids, []);
});

test("R001 handoff hashes active structural-control evidence and exact applied version ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-structural-proof-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "codex-input.json");
  await fs.writeFile(report, "report");
  await fs.writeFile(companion, JSON.stringify({
    ...safeDefaultCodex(),
    structural_control_settings_binding: {
      status: "ACTIVE_EXACT_ORGANIZATION_MONTH", set_count: 1,
      correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
      ui_fixed_registry: { control_set_ids: ["SET-VERSION-17"] },
    },
    structural_group_control_results: [{
      control_set_id: "SET-VERSION-17", financial_rows: 0, posting_rows: 0,
      execution_allowed: false, posting_allowed: false,
    }],
  }));
  const result = await buildHandoff({
    workflow: { next_action: "PASS_TO_R001", state_fingerprint: "STATE" },
    context: {
      run_id: "RUN-1", period: "2025-01",
      organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false },
      paths: { handoff_root: path.join(root, "handoff"), r005_report: report, r005_codex_input: companion },
    },
    registry: { rules: [] }, candidates: [], outputDir: path.join(root, "output"),
  });
  const handoff = JSON.parse(await fs.readFile(result.handoff_path, "utf8"));
  assert.equal(handoff.structural_control_proof.status, "ACTIVE_VERIFIED");
  assert.deepEqual(handoff.structural_control_proof.applied_version_ids, ["SET-VERSION-17"]);
  assert.match(handoff.structural_control_proof.settings_binding_sha256, /^[0-9A-F]{64}$/);
  assert.match(handoff.structural_control_proof.control_results_sha256, /^[0-9A-F]{64}$/);
  assert.equal(handoff.structural_control_proof.financial_rows, 0);
  assert.equal(handoff.structural_control_proof.posting_rows, 0);
});

test("R001 handoff rejects unsafe structural-control rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-unsafe-structural-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "codex-input.json");
  await fs.writeFile(report, "report");
  await fs.writeFile(companion, JSON.stringify({
    ...safeDefaultCodex(),
    structural_control_settings_binding: {
      status: "ACTIVE_EXACT_ORGANIZATION_MONTH", set_count: 1,
      correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
      sets: [{ id: "SET-1" }],
    },
    structural_group_control_results: [{ financial_rows: 0, posting_rows: 1, execution_allowed: false }],
  }));
  await assert.rejects(buildHandoff({
    workflow: { next_action: "PASS_TO_R001" },
    context: {
      run_id: "RUN-1", period: "2025-01",
      organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1" },
      paths: { handoff_root: path.join(root, "handoff"), r005_report: report, r005_codex_input: companion },
    },
    registry: { rules: [] }, outputDir: path.join(root, "output"),
  }), /STRUCTURAL_CONTROL_PROOF_UNSAFE_NONZERO/);
});

test("R001 handoff carries unconfirmed corrections only as safe disputed drafts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-disputed-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "codex-input.json");
  await fs.writeFile(report, "report");
  await fs.writeFile(companion, JSON.stringify(safeDefaultCodex()));
  const context = {
    run_id: "RUN-1", period: "2025-01",
    organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false },
    paths: { handoff_root: path.join(root, "handoff"), r005_report: report, r005_codex_input: companion },
  };
  const correction = {
    candidate_id: "CAND-CORR", scope: { organization_id: "ORG-1" },
    action: { action_type: "STORNO_REPOST" }, accounting: { debit_account: "26", credit_account: "79.1" },
    evidence: { proof_status: "PROVEN", evidence_rows: [{ debit: "20", credit: "60" }] },
  };
  const mapping = { candidate_id: "CAND-MAP", scope: { organization_id: "ORG-1" }, action: { action_type: "MAP_ARTICLE" } };
  const groupControl = {
    candidate_id: "CAND-GROUP", scope: { organization_id: "ORG-1" },
    group_review_only: true,
    action: { action_type: "ONE_SIDE", parameters: { row_code: "R001", structural_non_posting: true } },
    evidence: { group_delta_breakdown: { mode: "GROUP_DRILLDOWN_REVIEW_ONLY", group_code: "R001" } },
  };
  const applications = [
    { application_id: "APP-CORR", candidate_id: "CAND-CORR", run_id: "RUN-1", organization_id: "ORG-1", period: "2025-01", result_status: "REVIEW", execution_allowed: false, ready_to_upload: false, release_allowed: false },
    { application_id: "APP-MAP", candidate_id: "CAND-MAP", run_id: "RUN-1", organization_id: "ORG-1", period: "2025-01", result_status: "REVIEW", execution_allowed: false, ready_to_upload: false, release_allowed: false },
    { application_id: "APP-NO", candidate_id: "CAND-CORR", run_id: "RUN-1", organization_id: "ORG-1", period: "2025-01", result_status: "NO_ACTION", execution_allowed: false, ready_to_upload: false, release_allowed: false },
    { application_id: "APP-CONFIRMED", candidate_id: "CAND-CORR", run_id: "RUN-1", organization_id: "ORG-1", period: "2025-01", result_status: "CONFIRMED", proof_status: "PROVEN", output_route: "ГОТОВО", execution_allowed: false, ready_to_upload: false, release_allowed: false },
    { application_id: "APP-GROUP", candidate_id: "CAND-GROUP", run_id: "RUN-1", organization_id: "ORG-1", period: "2025-01", result_status: "REVIEW", execution_allowed: false, ready_to_upload: false, release_allowed: false },
  ];
  const result = await buildHandoff({
    workflow: { next_action: "PASS_TO_R001", state_fingerprint: "STATE" }, context,
    registry: { rules: [], applications: [] }, candidates: [correction, mapping, groupControl], applications,
    outputDir: path.join(root, "output"),
  });
  assert.equal(path.basename(result.applications_path), "r001_rule_application_drafts.json");
  const document = JSON.parse(await fs.readFile(result.applications_path, "utf8"));
  assert.equal(document.applications.length, 1);
  assert.equal(document.applications[0].application_id, "APP-CORR");
  assert.equal(document.applications[0].output_route, "СПОРНО");
  assert.equal(document.applications[0].proof_status, "UNPROVEN");
  assert.equal(document.applications[0].review_state, "NEEDS_REVIEW");
  assert.equal(document.applications[0].execution_allowed, false);
  assert.equal(document.applications[0].posting_rows, 0);
  assert.equal(document.safety.live_1c_allowed, false);
  assert.match(result.handoff_sha256, /^[0-9A-F]{64}$/);
  assert.match(result.applications_sha256, /^[0-9A-F]{64}$/);
});

test("accepted intergroup economics bypasses only the attached group diagnostic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-accepted-intergroup-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "codex-input.json");
  await fs.writeFile(report, "report");
  await fs.writeFile(companion, JSON.stringify(safeDefaultCodex()));
  const context = {
    run_id: "RUN-OCTOBER", period: "2025-10",
    organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false },
    paths: { handoff_root: path.join(root, "accepted"), r005_report: report, r005_codex_input: companion },
  };
  const candidate = {
    candidate_id: "GENERIC-OCTOBER",
    decision: "UNRESOLVED",
    impact_class: "CORRECTION_ANALYTICS",
    action: {
      action_type: "STORNO_REPOST",
      parameters: {
        reclass_scope: "INTER_GROUP",
        proof_status: "ECONOMIC_RECLASS_PROVEN",
        review_only: true,
        accepted_intergroup_reclass: true,
        economic_reclass_proven: true,
        intergroup_reclass_id: "ROUTE-R033-R023",
        accepted_amount: 244745,
        source_codes: ["R033"],
        target_codes: ["R023"],
        member_legs: [{
          code: "R033", role: "RECLASS_SOURCE", economic_direction: "STORNO",
          correction_amount: 244745, accepted_intergroup_effect: -244745,
          root_effective_delta: 0, accepted_intergroup_reclass: true,
          intergroup_reclass_id: "ROUTE-R033-R023",
          intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
        }, {
          code: "R023", role: "RECLASS_TARGET", economic_direction: "REPOST",
          correction_amount: 244745, accepted_intergroup_effect: 244745,
          root_effective_delta: 0, accepted_intergroup_reclass: true,
          intergroup_reclass_id: "ROUTE-R033-R023",
          intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
        }],
      },
    },
    evidence: {
      proof_status: "UNPROVEN",
      group_delta_breakdown: { mode: "GROUP_DRILLDOWN_REVIEW_ONLY", group_code: "R033" },
    },
  };
  const application = {
    application_id: "APP-OCTOBER", candidate_id: candidate.candidate_id,
    run_id: context.run_id, organization_id: context.organization.id, period: context.period,
    amount: 244745, result_status: "REVIEW", proof_status: "UNPROVEN",
    economic_proof_status: "ECONOMIC_RECLASS_PROVEN", economic_route_id: "ROUTE-R033-R023",
    output_route: "СПОРНО", execution_allowed: false, ready_to_upload: false, release_allowed: false,
  };
  const build = async (candidateValue, applicationValue, suffix) => buildHandoff({
    workflow: { next_action: "PASS_TO_R001", state_fingerprint: `STATE-${suffix}` },
    context: { ...context, paths: { ...context.paths, handoff_root: path.join(root, suffix) } },
    registry: { rules: [], applications: [] },
    candidates: [candidateValue], applications: [applicationValue], outputDir: path.join(root, `output-${suffix}`),
  });

  const accepted = await build(candidate, application, "accepted");
  const acceptedDoc = JSON.parse(await fs.readFile(accepted.applications_path, "utf8"));
  assert.equal(acceptedDoc.applications.length, 1);
  assert.equal(acceptedDoc.applications[0].application_id, application.application_id);
  assert.deepEqual(acceptedDoc.applications[0].candidate_snapshot.action.parameters.member_legs.map((leg) => [
    leg.code, leg.role, leg.economic_direction, leg.accepted_intergroup_effect, leg.root_effective_delta,
  ]), [
    ["R033", "RECLASS_SOURCE", "STORNO", -244745, 0],
    ["R023", "RECLASS_TARGET", "REPOST", 244745, 0],
  ]);
  assert.equal(acceptedDoc.applications[0].output_route, "СПОРНО");
  assert.equal(acceptedDoc.applications[0].posting_rows, 0);

  const mutations = [
    ["explicit-control", (c) => { c.group_review_only = true; }, () => {}],
    ["unaccepted", (c) => { c.action.parameters.accepted_intergroup_reclass = false; }, () => {}],
    ["root-not-closed", (c) => { c.action.parameters.member_legs[0].root_effective_delta = -1; }, () => {}],
    ["amount-mismatch", (c) => { c.action.parameters.accepted_amount = 244744; }, () => {}],
    ["route-mismatch", () => {}, (a) => { a.economic_route_id = "OTHER-ROUTE"; }],
    ["code-set-mismatch", (c) => { c.action.parameters.target_codes = ["R999"]; }, () => {}],
  ];
  for (const [suffix, mutateCandidate, mutateApplication] of mutations) {
    const rejectedCandidate = structuredClone(candidate);
    const rejectedApplication = structuredClone(application);
    mutateCandidate(rejectedCandidate);
    mutateApplication(rejectedApplication);
    const rejected = await build(rejectedCandidate, rejectedApplication, suffix);
    const rejectedDoc = JSON.parse(await fs.readFile(rejected.applications_path, "utf8"));
    assert.equal(rejectedDoc.applications.length, 0, suffix);
  }
});
