import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requireVerifiedHandoffForRulesApplications, verifiedR001HandoffInput } from "./r001_handoff_input.mjs";
import { structuralControlProofFromCodexPayload } from "../../rules-engine/source/structural_control_proof.mjs";

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-handoff-"));
  const report = path.join(root, "registered-report.xlsx");
  const companion = path.join(root, "not-derived-name.json");
  const rules = path.join(root, "engine_rules.json");
  const applications = path.join(root, "r001_rule_application_drafts.json");
  await fs.writeFile(report, "verified report");
  const reportHash = await sha256(report);
  const codexPayload = {
    report_sha256: reportHash, operation_evidence: { pair_candidates: [] },
    report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false,
    structural_control_settings_binding: {
      status: "ACTIVE_EXACT_ORGANIZATION_MONTH", set_count: 1,
      correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
      ui_fixed_registry: { control_set_ids: ["SET-VERSION-1"] },
    },
    structural_group_control_results: [{
      control_set_id: "SET-VERSION-1", financial_rows: 0, posting_rows: 0,
      execution_allowed: false, posting_allowed: false,
    }],
  };
  await fs.writeFile(companion, JSON.stringify(codexPayload));
  await fs.writeFile(rules, JSON.stringify({ run_id: "RUN-ACTIVE", rules: [] }));
  await fs.writeFile(applications, JSON.stringify({
    schema_version: "opiu-rule-applications.v1", run_id: "RUN-ACTIVE", applications: [],
    safety: { report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false },
  }));
  const handoff = {
    schema_version: "opiu-r001-handoff.v1",
    run_id: "RUN-ACTIVE",
    source_r005_run_id: "RUN-ACTIVE",
    organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1" },
    period: "2025-01",
    reconciliation: { path: report, sha256: reportHash, codex_input_path: companion, codex_input_sha256: await sha256(companion) },
    rules: { path: rules, sha256: await sha256(rules), rules_revision_set_hash: "RULESET-1" },
    applications: { path: applications, sha256: await sha256(applications) },
    structural_control_proof: structuralControlProofFromCodexPayload(codexPayload),
  };
  const handoffPath = path.join(root, "r001_handoff.json");
  await fs.writeFile(handoffPath, JSON.stringify(handoff));
  return { root, report, companion, rules, applications, handoff, handoffPath };
}

test("binds R001 to the explicit verified handoff files", async () => {
  const item = await fixture();
  const result = await verifiedR001HandoffInput({
    handoffPath: item.handoffPath,
    requestedRunId: "RUN-ACTIVE",
    requestedOrganizationId: "ORG-1",
    requestedOrganizationName: "Organization 1",
    requestedPeriod: "2025-01",
    reconciliationPath: item.report,
    codexInputPath: item.companion,
    applicationsPath: item.applications,
  });
  assert.equal(result.codexInputPath, path.resolve(item.companion));
  assert.equal(result.runId, "RUN-ACTIVE");
  assert.deepEqual(result.structuralControlProof.applied_version_ids, ["SET-VERSION-1"]);
});

test("fails closed on run, organization, and period mismatch", async () => {
  const item = await fixture();
  for (const request of [
    { requestedRunId: "RUN-OTHER" },
    { requestedOrganizationId: "ORG-OTHER" },
    { requestedPeriod: "2025-02" },
  ]) {
    await assert.rejects(
      verifiedR001HandoffInput({ handoffPath: item.handoffPath, ...request }),
      /R001_HANDOFF_REQUEST_/,
    );
  }
});

test("fails closed when any handoff-bound file hash changes", async () => {
  const item = await fixture();
  await fs.appendFile(item.companion, "tampered");
  await assert.rejects(
    verifiedR001HandoffInput({ handoffPath: item.handoffPath }),
    /R001_HANDOFF_HASH_MISMATCH/,
  );
});

test("fails closed when a rehashed handoff tampers with structural-control proof", async () => {
  const item = await fixture();
  item.handoff.structural_control_proof = {
    ...item.handoff.structural_control_proof,
    control_result_count: 99,
  };
  await fs.writeFile(item.handoffPath, JSON.stringify(item.handoff));
  await assert.rejects(
    verifiedR001HandoffInput({ handoffPath: item.handoffPath }),
    /STRUCTURAL_CONTROL_PROOF_DESCRIPTOR_MISMATCH/,
  );
});

test("accepts explicit no-active structural settings as default all-groups proof", async () => {
  const item = await fixture();
  const codexPayload = JSON.parse(await fs.readFile(item.companion, "utf8"));
  codexPayload.structural_control_settings_binding = {
    status: "MISSING_DEFAULT_ALL_GROUPS", set_count: 0,
    correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
  };
  codexPayload.structural_group_control_results = [];
  await fs.writeFile(item.companion, JSON.stringify(codexPayload));
  item.handoff.reconciliation.codex_input_sha256 = await sha256(item.companion);
  item.handoff.structural_control_proof = structuralControlProofFromCodexPayload(codexPayload);
  await fs.writeFile(item.handoffPath, JSON.stringify(item.handoff));
  const result = await verifiedR001HandoffInput({ handoffPath: item.handoffPath });
  assert.equal(result.structuralControlProof.status, "NO_ACTIVE_DEFAULT_ALL_GROUPS");
  assert.deepEqual(result.structuralControlProof.applied_version_ids, []);
});

test("does not derive a companion from the reconciliation filename", async () => {
  const item = await fixture();
  await assert.rejects(
    verifiedR001HandoffInput({
      handoffPath: item.handoffPath,
      codexInputPath: item.report.replace(/\.xlsx$/i, ".codex-input.json"),
    }),
    /R001_HANDOFF_REQUEST_CODEX_INPUT_MISMATCH/,
  );
});

test("rejects a hash-valid applications file with an unsafe disputed row", async () => {
  const item = await fixture();
  const unsafe = {
    schema_version: "opiu-rule-applications.v1", run_id: "RUN-ACTIVE",
    safety: { report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false },
    applications: [{
      application_id: "APP-1", candidate_id: "CAND-1", run_id: "RUN-ACTIVE", organization_id: "ORG-1", period: "2025-01",
      result_status: "REVIEW", disputed_only: true, output_route: "СПОРНО", proof_status: "UNPROVEN", review_state: "NEEDS_REVIEW",
      execution_allowed: false, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: true,
      candidate_snapshot: { candidate_id: "CAND-1", scope: { organization_id: "ORG-1" }, action: { action_type: "STORNO_REPOST" } },
    }],
  };
  await fs.writeFile(item.applications, JSON.stringify(unsafe));
  item.handoff.applications.sha256 = await sha256(item.applications);
  await fs.writeFile(item.handoffPath, JSON.stringify(item.handoff));
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath }), /R001_HANDOFF_APPLICATION_SAFETY_MISMATCH/);
});

test("rejects confirmed or applied rows in the disputed-drafts handoff", async () => {
  for (const resultStatus of ["CONFIRMED", "APPLIED"]) {
    const item = await fixture();
    const document = {
      schema_version: "opiu-rule-applications.v1", run_id: "RUN-ACTIVE",
      safety: { report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false },
      applications: [{
        application_id: "APP-1", candidate_id: "CAND-1", run_id: "RUN-ACTIVE", organization_id: "ORG-1", period: "2025-01",
        result_status: resultStatus, disputed_only: false, output_route: "ГОТОВО", proof_status: "PROVEN", review_state: "NOT_REQUIRED",
        execution_allowed: false, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false,
        candidate_snapshot: { candidate_id: "CAND-1", scope: { organization_id: "ORG-1" }, action: { action_type: "STORNO_REPOST" } },
      }],
    };
    await fs.writeFile(item.applications, JSON.stringify(document));
    item.handoff.applications.sha256 = await sha256(item.applications);
    await fs.writeFile(item.handoffPath, JSON.stringify(item.handoff));
    await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath }), /R001_HANDOFF_APPLICATION_STATUS_FORBIDDEN/);
  }
});

test("direct Rules application JSON requires a verified handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-direct-apps-"));
  const applicationsPath = path.join(root, "r001_rule_application_drafts.json");
  await fs.writeFile(applicationsPath, JSON.stringify({ schema_version: "opiu-rule-applications.v1", applications: [] }));
  await assert.rejects(
    requireVerifiedHandoffForRulesApplications({ applicationsPath }),
    /R001_RULE_APPLICATIONS_REQUIRE_VERIFIED_HANDOFF/,
  );
  await assert.doesNotReject(requireVerifiedHandoffForRulesApplications({ applicationsPath, handoffPath: path.join(root, "r001_handoff.json") }));
});
