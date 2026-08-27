import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHandoff } from "../../rules-engine/source/handoff.mjs";
import { verifiedR001HandoffInput } from "./r001_handoff_input.mjs";
import { rulesApplicationsToDisputedDecisions } from "./rules_application_handoff.mjs";

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}

test("unconfirmed Rules proposal reaches R001 as one SPORNO correction and never as posting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-r001-disputed-"));
  const report = path.join(root, "r005.xlsx");
  const companion = path.join(root, "r005.codex-input.json");
  await fs.writeFile(report, "registered R005 report");
  await fs.writeFile(companion, JSON.stringify({
    report_sha256: await sha256(report), report_only: true, posting_rows: 0,
    ready_to_upload: false, release_allowed: false,
    structural_control_settings_binding: {
      status: "MISSING_DEFAULT_ALL_GROUPS", set_count: 0,
      correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
    },
    structural_group_control_results: [],
  }));
  const context = {
    run_id: "RUN-1", period: "2025-01",
    organization: { id: "ORG-1", name: "Organization 1", path: "Holding / Organization 1", include_descendants: false },
    paths: { handoff_root: path.join(root, "handoff"), r005_report: report, r005_codex_input: companion },
  };
  const candidate = {
    candidate_id: "CAND-1", scope: { organization_id: "ORG-1" },
    action: { action_type: "STORNO_REPOST" },
    intalev: { article_code: "R025", article_name: "Мат помощь" },
    erp: { article_code: "ERP-25", article_name: "Мат помощь" },
    account_selection: { catalog_version_id: "ERP-CATALOG-1", debit_account_id: "ACC-26", credit_account_id: "ACC-791" },
    accounting: { debit_account: "26", credit_account: "79.1" },
    evidence: { proof_status: "PROVEN", evidence_rows: [{ debit: "20", credit: "60", registrar: "Документ 1", posting_number: "7", source_row: "15" }] },
  };
  const application = {
    application_id: "APP-1", candidate_id: "CAND-1", run_id: "RUN-1", organization_id: "ORG-1", organization_name: "Organization 1", period: "2025-01",
    result_status: "REVIEW", amount: 125, execution_allowed: false, ready_to_upload: false, release_allowed: false,
  };
  const built = await buildHandoff({
    workflow: { next_action: "PASS_TO_R001", state_fingerprint: "STATE" }, context,
    registry: { rules: [], applications: [] }, candidates: [candidate], applications: [application], outputDir: path.join(root, "output"),
  });
  const verified = await verifiedR001HandoffInput({
    handoffPath: built.handoff_path, requestedRunId: "RUN-1", requestedOrganizationId: "ORG-1", requestedOrganizationName: "Organization 1", requestedPeriod: "2025-01",
  });
  const payload = JSON.parse(await fs.readFile(verified.applicationsPath, "utf8"));
  const decisions = rulesApplicationsToDisputedDecisions(payload, { runId: "RUN-1", organizationId: "ORG-1", period: "2025-01" });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].approval_state, "ПРЕДЛОЖЕНО");
  assert.equal(decisions[0].target_dt, "26");
  assert.equal(decisions[0].target_kt, "79.1");
  assert.equal(decisions[0].execution_allowed, false);
  assert.equal(decisions[0].ready_to_upload, false);
  assert.equal(decisions[0].release_allowed, false);
  assert.equal(payload.safety.posting_rows, 0);
  assert.equal(payload.safety.live_1c_allowed, false);
});
