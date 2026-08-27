import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runEngine } from "./engine.mjs";

const EXPECTED_SAFETY_PASSPORT = {
  report_only: true,
  creates_postings: false,
  modifies_source_files: false,
  auto_activates_rules: false,
  posting_rows: 0,
  ready_to_upload: false,
  release_allowed: false,
  live_1c_allowed: false,
};

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}

test("authoritative Rules outputs carry the complete immutable safety passport", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-rules-safety-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const registryPath = path.join(root, "rules.json");
  const r005Path = path.join(root, "reconciliation.codex-input.json");
  const reportPath = path.join(root, "reconciliation.xlsx");
  const outputDir = path.join(root, "rules-output");
  const contextPath = path.join(root, "rules-engine-context.json");

  await writeJson(registryPath, {
    schema_version: "opiu-rule-registry.v2",
    rules: [],
    revisions: [],
    applications: [],
    approvals: [],
    evidence: [],
  });
  await writeJson(r005Path, {
    schema: "opiu-codex-review-input-v1",
    organization: "Тестовая организация",
    organization_code: "TEST",
    period: "2025-11",
    report_only: true,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    structural_control_settings_binding: {
      status: "MISSING_DEFAULT_ALL_GROUPS", set_count: 0,
      correction_authority: false, financial_rows: 0, posting_rows: 0, execution_allowed: false,
    },
    structural_group_control_results: [],
    rows: [],
  });
  await fs.writeFile(reportPath, "report-only fixture", "utf8");
  await writeJson(contextPath, {
    schema_version: "opiu-rules-engine-context.v1",
    run_id: "RUN-SAFETY-PASSPORT",
    phase: "AFTER_R005",
    organization: {
      id: "ORG-SAFETY",
      name: "Тестовая организация",
      path: "Тестовая организация",
      include_descendants: false,
    },
    period: "2025-11",
    paths: {
      rules_registry: registryPath,
      r005_report: reportPath,
      r005_codex_input: r005Path,
      output_dir: outputDir,
      handoff_root: path.join(root, "handoff"),
    },
    options: {
      auto_activate_rules: false,
      modify_source_files: false,
      require_user_confirmation: true,
    },
  });

  const result = await runEngine({ contextPath });
  const applicationsPath = path.join(outputDir, "rule_applications.json");
  const manifestPath = path.join(outputDir, "engine_manifest.json");
  const applications = JSON.parse(await fs.readFile(applicationsPath, "utf8"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.deepEqual(applications.safety, EXPECTED_SAFETY_PASSPORT);
  assert.deepEqual(manifest.safety, EXPECTED_SAFETY_PASSPORT);
  assert.deepEqual(result.manifest.safety, EXPECTED_SAFETY_PASSPORT);
  assert.equal(Object.isFrozen(result.manifest.safety), true);
  assert.equal(manifest.output_hashes["rule_applications.json"], await sha256(applicationsPath));
});
