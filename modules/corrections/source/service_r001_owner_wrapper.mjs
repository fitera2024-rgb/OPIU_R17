import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifiedR001HandoffInput } from "./r001_handoff_input.mjs";
import { projectOwnerEconomicDecisions } from "../../reconciliation/source/owner_decision_projection.mjs";
import { applyStandaloneStornoMaterialization, mergeOwnerAndRuleDecisions } from "./owner_decision_r001.mjs";
import { materializeStandaloneStornoCases } from "./r001_standalone_storno_materialization.mjs";
import { financialCoverageNonzeroRows } from "./r001_structural_root_coverage.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_SCRIPT = path.join(MODULE_DIR, "correction_engine_r001.mjs");
const POLICY_PATH = path.resolve(MODULE_DIR, "../../reconciliation/source/owner_decision_policy.json");

function text(value) { return String(value ?? "").trim(); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}
async function writeJson(filePath, value) { await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function caseIdSet(projection) { return new Set((projection?.cases ?? []).map((decisionCase) => text(decisionCase.case_id)).filter(Boolean)); }
function sameSet(left, right) { return left.size === right.size && [...left].every((value) => right.has(value)); }
function linkedCaseIds(projection, period, code) {
  return projection?.period_row_links?.[period]?.[code]
    ?? projection?.row_links?.[code]
    ?? projection?.row_links?.[`${period}|${code}`]
    ?? [];
}

export async function prepareOwnerR001Input({ handoffPath, requestedRunId = "", requestedOrganizationId = "", requestedOrganizationName = "", requestedPeriod = "", outputDir, policyPath = POLICY_PATH } = {}) {
  if (!handoffPath) throw new Error("OWNER_DECISION_R001_HANDOFF_REQUIRED");
  const verified = await verifiedR001HandoffInput({
    handoffPath,
    requestedRunId,
    requestedOrganizationId,
    requestedOrganizationName,
    requestedPeriod,
  });
  const [payloadText, policyText, applicationsText] = await Promise.all([
    fs.readFile(verified.codexInputPath, "utf8"),
    fs.readFile(policyPath, "utf8"),
    fs.readFile(verified.applicationsPath, "utf8"),
  ]);
  const payload = JSON.parse(payloadText.replace(/^\uFEFF/, ""));
  const policy = JSON.parse(policyText.replace(/^\uFEFF/, ""));
  const applicationsDocument = JSON.parse(applicationsText.replace(/^\uFEFF/, ""));
  const projection = projectOwnerEconomicDecisions(payload, { ownerAcceptancePolicy: policy?.accepted_classification_gaps ?? [] });
  const recorded = new Set((payload?.owner_decisions?.cases ?? []).map((decisionCase) => text(decisionCase.case_id)).filter(Boolean));
  if (recorded.size > 0 && !sameSet(recorded, caseIdSet(projection))) throw new Error("OWNER_DECISION_R001_PROJECTION_DRIFT");
  const missing = financialCoverageNonzeroRows(payload)
    .filter((row) => !linkedCaseIds(projection, row.period, row.code).length);
  if (missing.length) throw new Error(`OWNER_DECISION_R001_UNMAPPED_NONZERO:${missing.map((row) => `${row.period}|${row.code}`).join(",")}`);

  const bridged = mergeOwnerAndRuleDecisions({
    applicationsDocument,
    projection,
    organization: verified.organizationName,
    period: verified.period,
    provenance: { handoff_sha256: verified.handoffSha256, applications_sha256: verified.applicationsSha256 },
  });
  const standaloneStorno = await materializeStandaloneStornoCases(bridged.decisions);
  const merged = applyStandaloneStornoMaterialization(bridged, standaloneStorno);
  const targetDir = path.resolve(outputDir || ".");
  await fs.mkdir(targetDir, { recursive: true });
  const decisionsPath = path.join(targetDir, `.owner_decisions_${verified.runId}.json`);
  const auditPath = path.join(targetDir, `.owner_decision_projection_${verified.runId}.json`);
  const structuralControlProofPath = path.join(targetDir, `.structural_control_proof_${verified.runId}.json`);
  await writeJson(decisionsPath, merged.decisions);
  await writeJson(structuralControlProofPath, verified.structuralControlProof);
  await writeJson(auditPath, {
    schema: "opiu-owner-decision-r001-wrapper.v1",
    run_id: verified.runId,
    organization: { id: verified.organizationId, name: verified.organizationName, path: verified.organizationPath },
    period: verified.period,
    source_handoff: { path: verified.handoffPath, sha256: verified.handoffSha256 },
    source_applications: { path: verified.applicationsPath, sha256: verified.applicationsSha256 },
    filtered_application_ids: merged.filtered_application_ids,
    retained_application_count: merged.retained_application_count,
    owner_decision_count: merged.owner_decision_count,
    rule_decision_count: merged.rule_decision_count,
    materialization_bridge: merged.materialization_bridge,
    projection,
  });
  return { verified, projection, merged, decisionsPath, auditPath, structuralControlProofPath };
}

async function runCore(prepared, args) {
  const coreArgs = [
    "--reconciliation", prepared.verified.reconciliationPath,
    "--codex-input", prepared.verified.codexInputPath,
    "--decisions", prepared.decisionsPath,
    "--output", path.resolve(args.output),
    "--period", prepared.verified.period,
    "--organization", prepared.verified.organizationName,
    "--run-id", prepared.verified.runId,
    "--organization-id", prepared.verified.organizationId,
    "--structural-control-proof", prepared.structuralControlProofPath,
  ];
  const env = { ...process.env, OPIU_R001_HANDOFF_PATH: "" };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE_SCRIPT, ...coreArgs], { stdio: ["inherit", "pipe", "inherit"], env });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stdout += value;
      process.stdout.write(value);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) return reject(new Error(`R001_CORE_FAILED:${signal || code}`));
      const marker = '{\n  "runDir"';
      const start = stdout.lastIndexOf(marker);
      if (start < 0) return reject(new Error("R001_CORE_RESULT_MISSING"));
      try { resolve(JSON.parse(stdout.slice(start).trim())); }
      catch (error) { reject(new Error(`R001_CORE_RESULT_INVALID:${error.message}`)); }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handoffPath = text(args.handoff || process.env.OPIU_R001_HANDOFF_PATH);
  const outputDir = text(args.output) ? path.resolve(args.output) : path.resolve("./outputs");
  const prepared = await prepareOwnerR001Input({
    handoffPath,
    requestedRunId: text(args["run-id"] || process.env.OPIU_R001_RUN_ID),
    requestedOrganizationId: text(args["organization-id"] || process.env.OPIU_R001_ORGANIZATION_ID),
    requestedOrganizationName: text(args.organization || process.env.OPIU_R001_ORGANIZATION_NAME),
    requestedPeriod: text(args.period),
    outputDir,
  });
  const coreResult = await runCore(prepared, { ...args, output: outputDir });
  const addOneSide = prepared.merged.decisions.filter((decision) => text(decision.decision_type).toUpperCase() === "ADD_ONE_SIDE").length;
  console.log(JSON.stringify({
    owner_decision_wrapper: "R001",
    cases: prepared.projection.cases.length,
    owner_decision_rows: prepared.merged.owner_decision_count,
    filtered_rule_applications: prepared.merged.filtered_application_ids,
    retained_rule_applications: prepared.merged.retained_application_count,
    add_one_side_decisions: addOneSide,
    canonical_financial_cases: prepared.merged.materialization_bridge.audit.financial_case_count,
    canonical_review_only_cases: prepared.merged.materialization_bridge.audit.review_only_case_count,
    canonical_posting_rows: prepared.merged.materialization_bridge.audit.canonical_posting_row_count,
    posting_rows: coreResult.posting_rows,
    materialized_posting_rows: coreResult.materialized_posting_rows,
    executed_posting_rows: coreResult.executed_posting_rows,
    live_posting_rows: coreResult.live_posting_rows,
    storno_rows: coreResult.storno_rows,
    repost_rows: coreResult.repost_rows,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
  }));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) await main();
