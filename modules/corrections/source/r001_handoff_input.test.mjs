import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNoDirectR001Overrides, verifiedR001HandoffInput } from "./r001_handoff_input.mjs";

const hashBytes = (value) => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
const hashFile = async (filePath) => hashBytes(await fs.readFile(filePath));
const safety = {
  mode: "REPORT_ONLY", posting_rows: 0, ready_to_upload: false,
  release_allowed: false, execution_allowed: false, live_1c_allowed: false,
};

async function serviceHandoffFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-service-handoff-"));
  const files = {};
  const write = async (name, value) => {
    const filePath = path.join(root, name);
    const bytes = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
    await fs.writeFile(filePath, bytes);
    const stat = await fs.stat(filePath);
    files[name] = { path: filePath, size: stat.size, sha256: await hashFile(filePath) };
    return files[name];
  };
  const erp = await write("erp-package.xlsx", "pinned ERP package\n");
  const intalev = await write("intalev.xlsx", "pinned Intalev source\n");
  const workbook = await write("reconciliation.xlsx", "R005 workbook\n");
  const journal = await write("erp-journal.xlsx", "ERP journal\n");
  const inventory = await write("structural-control-inventory.json", { inventory_id: "INV-1" });
  const inventoryBinding = await write("structural-control-inventory.binding.json", {
    run_id: "RUN-1", context_id: "CTX-1", organization_id: "ORG-1", organization_name: "Organization 1",
    organization_path: "Holding / Organization 1", period: "2025-01", verified: true, sha256: inventory.sha256,
  });
  const proof = await write("structural-control-proof.json", {
    schema_version: "opiu-structural-control-proof.v1", report_only: true, financial_rows: 0,
    posting_rows: 0, correction_authority: false, execution_allowed: false,
  });
  const codex = await write("reconciliation.codex-input.json", {
    schema: "opiu-codex-review-input-v1", organization: "Organization 1", organization_code: "ORG-1", period: "2025-01",
    report_path: workbook.path, report_sha256: workbook.sha256,
    report_only: true, posting_rows: 0, executed_posting_rows: 0, live_posting_rows: 0,
    execution_allowed: false, ready_to_upload: false, release_allowed: false, live_1c_allowed: false, live_delete_allowed: false,
    operation_evidence: {
      journal_sha256: journal.sha256, journal_sheet: "Journal", input: { journal_source: journal.path },
      rows: [{ source_row_id: "ROW-A", evidence_status: "PROVEN" }],
    },
  });
  const manifest = await write("reconciliation.manifest.json", {
    schema: "opiu-auto-reconciliation-run-v3", organization: "Organization 1", organization_code: "ORG-1", period: "2025-01",
    output_path: workbook.path, output_sha256: workbook.sha256, codex_input_path: codex.path, codex_input_sha256: codex.sha256,
    report_only: true, posting_rows: 0, executed_posting_rows: 0, live_posting_rows: 0,
    execution_allowed: false, ready_to_upload: false, release_allowed: false, live_1c_allowed: false, live_delete_allowed: false,
  });
  const proofBinding = await write("structural-control-proof.binding.json", {
    schema_version: "opiu-service-structural-control-proof-binding.v1", run_id: "RUN-1", context_id: "CTX-1",
    organization_id: "ORG-1", organization_name: "Organization 1", organization_path: "Holding / Organization 1", period: "2025-01",
    codex_input: codex, proof,
  });
  const sourceRowIDs = ["ROW-A"];
  const handoff = {
    schema_version: "opiu-service-r005-r001-handoff.v1", artifact_type: "R005_R001_SERVICE_HANDOFF",
    run_id: "RUN-1", source_run_id: "RUN-1", context_id: "CTX-1",
    organization: { id: "ORG-1", name: "Organization 1", hierarchy_path: "Holding / Organization 1" }, period: "2025-01",
    sources: { erp, intalev }, r005: { workbook, codex_input: codex, manifest },
    structural: { inventory, inventory_binding: inventoryBinding, proof, proof_binding: proofBinding },
    physical_evidence: {
      status: "VERIFIED_JOURNAL_REPORT_ONLY", erp_package: erp, erp_journal: { ...journal, sheet: "Journal" },
      source_row_ids: sourceRowIDs, source_row_ids_sha256: hashBytes(JSON.stringify(sourceRowIDs)), unique_count: 1, reuse_count: 0,
    },
    cross_checks: {
      manifest_schema: "opiu-auto-reconciliation-run-v3", codex_input_schema: "opiu-codex-review-input-v1",
      scope_verified: true, source_hashes_verified: true, r005_hashes_verified: true,
      structural_inventory_verified: true, structural_proof_verified: true, physical_evidence_bound: true,
    },
    safety,
  };
  const handoffPath = path.join(root, "handoff", "r005-r001-service-handoff.json");
  await fs.mkdir(path.dirname(handoffPath), { recursive: true });
  const rewrite = async (raw = `${JSON.stringify(handoff)}\n`) => {
    await fs.writeFile(handoffPath, raw);
    const handoffSha256 = await hashFile(handoffPath);
    await fs.writeFile(`${handoffPath}.sha256`, `${handoffSha256}\n`);
    return handoffSha256;
  };
  const handoffSha256 = await rewrite();
  return { root, files, handoff, handoffPath, handoffSha256, rewrite };
}

test("accepts the exact Service-owned neutral handoff", async () => {
  const item = await serviceHandoffFixture();
  const result = await verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: item.handoffSha256 });
  assert.equal(result.sourceRunId, "RUN-1");
  assert.deepEqual(result.sourceRowIDs, ["ROW-A"]);
});

test("requires both canonical handoff path and pinned SHA", async () => {
  const item = await serviceHandoffFixture();
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath }), /SERVICE_HANDOFF_SHA256_REQUIRED/u);
  await assert.rejects(verifiedR001HandoffInput({ handoffSha256: item.handoffSha256 }), /SERVICE_HANDOFF_PATH_REQUIRED/u);
});

test("rejects handoff byte tamper against the Service-computed SHA", async () => {
  const item = await serviceHandoffFixture();
  await fs.appendFile(item.handoffPath, " ");
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: item.handoffSha256 }), /SERVICE_HANDOFF_HASH_MISMATCH/u);
});

test("rejects drift in every handoff-bound artifact", async () => {
  const item = await serviceHandoffFixture();
  await fs.appendFile(item.files["reconciliation.codex-input.json"].path, "tamper");
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: item.handoffSha256 }), /SERVICE_HANDOFF_ARTIFACT_DRIFT/u);
});

test("rejects unknown handoff keys under the exact schema", async () => {
  const item = await serviceHandoffFixture();
  item.handoff.unknown_authority = true;
  const sha = await item.rewrite();
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: sha }), /SERVICE_HANDOFF_EXACT_SCHEMA_MISMATCH/u);
});

test("rejects duplicate JSON keys before JSON.parse can collapse them", async () => {
  const item = await serviceHandoffFixture();
  const raw = `${JSON.stringify(item.handoff).replace('"run_id":"RUN-1"', '"run_id":"STALE","run_id":"RUN-1"')}\n`;
  const sha = await item.rewrite(raw);
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: sha }), /SERVICE_HANDOFF_DUPLICATE_KEY/u);
});

test("rejects duplicate, stale-digest, or reused physical SourceRowIDs", async () => {
  for (const mutate of [
    (physical) => { physical.source_row_ids = ["ROW-A", "ROW-A"]; physical.unique_count = 2; },
    (physical) => { physical.source_row_ids_sha256 = "A".repeat(64); },
    (physical) => { physical.reuse_count = 1; },
  ]) {
    const item = await serviceHandoffFixture();
    mutate(item.handoff.physical_evidence);
    const sha = await item.rewrite();
    await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: sha }), /SERVICE_HANDOFF_PHYSICAL/u);
  }
});

test("rejects rehashed scope drift against pinned R005 inputs", async () => {
  const item = await serviceHandoffFixture();
  item.handoff.organization.name = "Other Organization";
  const sha = await item.rewrite();
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: sha }), /SERVICE_HANDOFF_R005_SCOPE_MISMATCH/u);
});

test("forbids decisions, rules, applications, and all direct source overrides", async () => {
  for (const key of ["decisions", "rules", "applications", "reconciliation", "codex-input", "period", "organization", "run-id"]) {
    assert.throws(() => assertNoDirectR001Overrides({ [key]: "value" }), /R001_DIRECT_SOURCE_OVERRIDE_FORBIDDEN/u);
  }
  const item = await serviceHandoffFixture();
  await assert.rejects(verifiedR001HandoffInput({ handoffPath: item.handoffPath, handoffSha256: item.handoffSha256, applicationsPath: "rules.json" }), /R001_DIRECT_SOURCE_OVERRIDE_FORBIDDEN/u);
});
