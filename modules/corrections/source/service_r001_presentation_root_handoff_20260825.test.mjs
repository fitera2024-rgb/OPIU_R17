import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

import { financialCoverageNonzeroRows } from "./r001_structural_root_coverage.mjs";
import { prepareOwnerR001Input, runCore } from "./service_r001_owner_wrapper.mjs";

const PERIOD = "2025-10";
const ORGANIZATION = "ORG-SYNTHETIC";
const GROUP_ID = "CONTROL-SYNTHETIC";

function rootRow(code, delta) {
  return {
    code,
    organization: ORGANIZATION,
    period: PERIOD,
    delta,
    owner_presentation_block_exempt: true,
    owner_control_only: true,
    owner_posting_classification: "NON_POSTING",
    structural_group_control_enabled: true,
    structural_group_control_set_id: GROUP_ID,
    structural_control_group_id: GROUP_ID,
    structural_group_sum_status: "STRUCTURAL_GROUP_SUM_OK",
    structural_group_descendant_internal_checks_active: true,
    structural_group_control_financial_posting_rows: 0,
  };
}

function payload(overrides = {}) {
  return {
    organization: ORGANIZATION,
    period: PERIOD,
    structural_group_control_sets: [{
      id: GROUP_ID,
      organization: ORGANIZATION,
      enabled: true,
      members: ["R045", "R055"],
      mode: "SUM_DELTA_ONLY",
      tolerance: 0.01,
    }],
    structural_group_control_results: [{
      group_id: GROUP_ID,
      control_set_id: GROUP_ID,
      organization: ORGANIZATION,
      period: PERIOD,
      member_codes: ["R045", "R055"],
      classification: "STRUCTURAL_GROUP_SUM_OK",
      complete: true,
      review_only: false,
      blockers: [],
      control_sum_delta: 0,
      member_rows: [{ code: "R045" }, { code: "R055" }],
      structural_effect_consumed_once: true,
      control_residual_consumed_once: true,
      individual_parent_reclassification_allowed: false,
      descendant_internal_checks_active: true,
      structural_control_financial_posting_rows: 0,
      posting_rows: 0,
      posting_allowed: false,
      execution_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      report_only: true,
    }],
    period_rows: [{
      period: PERIOD,
      rows: [
        rootRow("R045", -100),
        rootRow("R055", 100),
        { code: "R046", organization: ORGANIZATION, period: PERIOD, delta: 10 },
      ],
    }],
    ...overrides,
  };
}

test("closed configured roots leave financial coverage while descendants remain", () => {
  assert.deepEqual(financialCoverageNonzeroRows(payload()), [
    { period: PERIOD, code: "R046" },
  ]);
});

test("mismatched or incomplete structural sets remain fail-closed", () => {
  const mismatch = payload();
  mismatch.structural_group_control_results[0] = {
    ...mismatch.structural_group_control_results[0],
    classification: "STRUCTURAL_GROUP_SUM_MISMATCH",
    control_sum_delta: 1,
  };
  assert.deepEqual(
    financialCoverageNonzeroRows(mismatch).map((row) => row.code),
    ["R045", "R055", "R046"],
  );

  const missingResult = payload({ structural_group_control_results: [] });
  assert.deepEqual(
    financialCoverageNonzeroRows(missingResult).map((row) => row.code),
    ["R045", "R055", "R046"],
  );
});

test("row flags alone cannot create an exemption without run-bound config", () => {
  const noConfig = payload({ structural_group_control_sets: [] });
  assert.deepEqual(
    financialCoverageNonzeroRows(noConfig).map((row) => row.code),
    ["R045", "R055", "R046"],
  );
});

test("wrapper delegates the pinned Service handoff through the actual core", async (t) => {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const wrapper = fsSync.readFileSync(
    path.join(sourceDirectory, "service_r001_owner_wrapper.mjs"),
    "utf8",
  );
  assert.match(wrapper, /verifyServiceR001Handoff/u);
  assert.match(wrapper, /"--handoff-sha256"/u);
  assert.doesNotMatch(wrapper, /--decisions|--applications|rules-engine\/source/u);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-wrapper-core-e2e-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const artifact = async (filePath) => {
    const bytes = await fs.readFile(filePath);
    return { path: filePath, size: bytes.length, sha256: digest(bytes) };
  };
  const writeJSON = async (name, value) => {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
    return artifact(filePath);
  };
  const writeText = async (name, value) => {
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, value);
    return artifact(filePath);
  };

  const journal = await writeText("erp-journal.xlsx", "pinned journal\n");
  const erp = await writeText("erp-package.xlsx", "pinned ERP package\n");
  const intalev = await writeText("intalev.xlsx", "pinned Intalev source\n");
  const workbookPath = path.join(root, "reconciliation.xlsx");
  const workbook = Workbook.create();
  const passport = workbook.worksheets.add("00_Паспорт");
  passport.getRange("A1:B4").values = [
    ["ПЕРИОД", PERIOD], ["ОРГАНИЗАЦИЯ", "Organization 1"],
    ["ERP ЖУРНАЛ", journal.path], ["SHA-256 ERP ЖУРНАЛА", journal.sha256],
  ];
  await (await SpreadsheetFile.exportXlsx(workbook)).save(workbookPath);
  const workbookRef = await artifact(workbookPath);
  const inventory = await writeJSON("structural-control-inventory.json", { inventory_id: "INV-E2E" });
  const inventoryBinding = await writeJSON("structural-control-inventory.binding.json", {
    run_id: "RUN-E2E", context_id: "CTX-E2E", organization_id: "ORG-1", organization_name: "Organization 1",
    organization_path: "Holding / Organization 1", period: PERIOD, verified: true, sha256: inventory.sha256,
  });
  const proof = await writeJSON("structural-control-proof.json", {
    schema_version: "opiu-structural-control-proof.v1", report_only: true, financial_rows: 0,
    posting_rows: 0, correction_authority: false, execution_allowed: false,
  });
  const codex = await writeJSON("reconciliation.codex-input.json", {
    schema: "opiu-codex-review-input-v1", organization: "Organization 1", organization_code: "ORG-1", period: PERIOD,
    report_path: workbookRef.path, report_sha256: workbookRef.sha256,
    report_only: true, posting_rows: 0, executed_posting_rows: 0, live_posting_rows: 0,
    execution_allowed: false, ready_to_upload: false, release_allowed: false, live_1c_allowed: false, live_delete_allowed: false,
    operation_evidence: { journal_sha256: journal.sha256, journal_sheet: "Journal", input: { journal_source: journal.path }, rows: [] },
  });
  const manifest = await writeJSON("reconciliation.manifest.json", {
    schema: "opiu-auto-reconciliation-run-v3", organization: "Organization 1", organization_code: "ORG-1", period: PERIOD,
    output_path: workbookRef.path, output_sha256: workbookRef.sha256,
    codex_input_path: codex.path, codex_input_sha256: codex.sha256,
    report_only: true, posting_rows: 0, executed_posting_rows: 0, live_posting_rows: 0,
    execution_allowed: false, ready_to_upload: false, release_allowed: false, live_1c_allowed: false, live_delete_allowed: false,
  });
  const proofBinding = await writeJSON("structural-control-proof.binding.json", {
    schema_version: "opiu-service-structural-control-proof-binding.v1", run_id: "RUN-E2E", context_id: "CTX-E2E",
    organization_id: "ORG-1", organization_name: "Organization 1", organization_path: "Holding / Organization 1", period: PERIOD,
    codex_input: { ...codex, path: path.relative(root, codex.path) },
    proof: { ...proof, path: path.relative(root, proof.path) },
  });
  const emptyIDs = [];
  const handoff = {
    schema_version: "opiu-service-r005-r001-handoff.v1", artifact_type: "R005_R001_SERVICE_HANDOFF",
    run_id: "RUN-E2E", source_run_id: "RUN-E2E", context_id: "CTX-E2E",
    organization: { id: "ORG-1", name: "Organization 1", hierarchy_path: "Holding / Organization 1" }, period: PERIOD,
    sources: { erp, intalev }, r005: { workbook: workbookRef, codex_input: codex, manifest },
    structural: { inventory, inventory_binding: inventoryBinding, proof, proof_binding: proofBinding },
    physical_evidence: {
      status: "VERIFIED_JOURNAL_REPORT_ONLY", erp_package: erp, erp_journal: { ...journal, sheet: "Journal" },
      source_row_ids: emptyIDs, source_row_ids_sha256: digest(Buffer.from(JSON.stringify(emptyIDs))), unique_count: 0, reuse_count: 0,
    },
    cross_checks: {
      manifest_schema: "opiu-auto-reconciliation-run-v3", codex_input_schema: "opiu-codex-review-input-v1",
      scope_verified: true, source_hashes_verified: true, r005_hashes_verified: true,
      structural_inventory_verified: true, structural_proof_verified: true, physical_evidence_bound: true,
    },
    safety: { mode: "REPORT_ONLY", posting_rows: 0, ready_to_upload: false, release_allowed: false, execution_allowed: false, live_1c_allowed: false },
  };
  const handoffPath = path.join(root, "handoff", "r005-r001-service-handoff.json");
  await fs.mkdir(path.dirname(handoffPath), { recursive: true });
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff)}\n`);
  const handoffSha256 = (await artifact(handoffPath)).sha256;
  await fs.writeFile(`${handoffPath}.sha256`, `${handoffSha256}\n`);

  const prepared = await prepareOwnerR001Input({ handoffPath, handoffSha256 });
  const result = await runCore(prepared, { outputDir: path.join(root, "outputs") });
  const coreManifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(coreManifest.run_id, "RUN-E2E");
  assert.equal(coreManifest.inputs.source_run_id, "RUN-E2E");
  assert.deepEqual(coreManifest.inputs.service_handoff, { path: handoffPath, sha256: handoffSha256 });
  assert.equal(coreManifest.results.report_only, true);
});
