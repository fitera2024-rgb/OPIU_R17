import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyStructuralControlProofDescriptor } from "../../rules-engine/source/structural_control_proof.mjs";

const SHA256 = /^[0-9a-f]{64}$/i;

function text(value) {
  return String(value ?? "").trim();
}

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function samePath(left, right) {
  if (!text(left) || !text(right)) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}

async function verifiedFile(section, pathKey, hashKey, label) {
  const filePath = text(section?.[pathKey]);
  const expectedHash = text(section?.[hashKey]).toUpperCase();
  if (!filePath) fail("R001_HANDOFF_PATH_REQUIRED", label);
  if (!SHA256.test(expectedHash)) fail("R001_HANDOFF_SHA256_REQUIRED", label);
  const resolvedPath = path.resolve(filePath);
  const actualHash = await sha256(resolvedPath).catch((error) => fail("R001_HANDOFF_FILE_UNREADABLE", `${label}: ${error.message}`));
  if (actualHash !== expectedHash) fail("R001_HANDOFF_HASH_MISMATCH", label);
  return { path: resolvedPath, sha256: actualHash };
}

function requireRequested(actual, requested, code) {
  if (text(requested) && text(requested) !== text(actual)) fail(code);
}

function requireRequestedPath(actual, requested, code) {
  if (text(requested) && !samePath(actual, requested)) fail(code);
}

function explicitlyFalse(value) {
  return value === false;
}

function validateDraftApplications(document, { runId, organizationId, period }) {
  if (document?.schema_version !== "opiu-rule-applications.v1" || text(document?.run_id) !== runId) fail("R001_HANDOFF_APPLICATIONS_SCHEMA_MISMATCH");
  const safety = document?.safety ?? {};
  if (safety.report_only !== true || Number(safety.posting_rows ?? 0) !== 0
    || !explicitlyFalse(safety.ready_to_upload) || !explicitlyFalse(safety.release_allowed) || !explicitlyFalse(safety.live_1c_allowed)) {
    fail("R001_HANDOFF_APPLICATIONS_SAFETY_MISMATCH");
  }
  const applicationIds = new Set();
  const candidateIds = new Set();
  for (const application of Array.isArray(document.applications) ? document.applications : []) {
    const applicationId = text(application?.application_id);
    const candidateId = text(application?.candidate_id);
    const candidate = application?.candidate_snapshot;
    if (!applicationId || !candidateId || applicationIds.has(applicationId) || candidateIds.has(candidateId) || text(candidate?.candidate_id) !== candidateId) fail("R001_HANDOFF_APPLICATION_IDENTITY_MISMATCH");
    applicationIds.add(applicationId);
    candidateIds.add(candidateId);
    if (text(application.run_id) !== runId || text(application.organization_id) !== organizationId || text(application.period) !== period || text(candidate?.scope?.organization_id) !== organizationId) fail("R001_HANDOFF_APPLICATION_CONTEXT_MISMATCH");
    if (!["STORNO_REPOST", "ONE_SIDE"].includes(text(candidate?.action?.action_type).toUpperCase())) fail("R001_HANDOFF_APPLICATION_ACTION_FORBIDDEN");
    const status = text(application.result_status).toUpperCase();
    if (!["PROPOSED", "REVIEW"].includes(status)) fail("R001_HANDOFF_APPLICATION_STATUS_FORBIDDEN");
    if (!explicitlyFalse(application.execution_allowed) || Number(application.posting_rows ?? 0) !== 0
      || !explicitlyFalse(application.ready_to_upload) || !explicitlyFalse(application.release_allowed) || !explicitlyFalse(application.live_1c_allowed)) {
      fail("R001_HANDOFF_APPLICATION_SAFETY_MISMATCH");
    }
    if (application.disputed_only !== true || text(application.output_route).toUpperCase() !== "СПОРНО"
      || text(application.proof_status).toUpperCase() !== "UNPROVEN" || text(application.review_state).toUpperCase() !== "NEEDS_REVIEW") {
      fail("R001_HANDOFF_DISPUTED_APPLICATION_MISMATCH");
    }
  }
}

export async function requireVerifiedHandoffForRulesApplications({ applicationsPath = "", handoffPath = "" } = {}) {
  if (!text(applicationsPath) || text(handoffPath) || path.extname(applicationsPath).toLowerCase() !== ".json") return;
  let document;
  try {
    document = JSON.parse((await fs.readFile(applicationsPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  if (Array.isArray(document?.applications)) fail("R001_RULE_APPLICATIONS_REQUIRE_VERIFIED_HANDOFF");
}

export async function verifiedR001HandoffInput({
  handoffPath,
  requestedRunId = "",
  requestedOrganizationId = "",
  requestedOrganizationName = "",
  requestedPeriod = "",
  reconciliationPath = "",
  codexInputPath = "",
  applicationsPath = "",
} = {}) {
  if (!text(handoffPath)) fail("R001_HANDOFF_REQUIRED");
  const resolvedHandoffPath = path.resolve(handoffPath);
  const handoffText = await fs.readFile(resolvedHandoffPath, "utf8").catch((error) => fail("R001_HANDOFF_UNREADABLE", error.message));
  let handoff;
  try {
    handoff = JSON.parse(handoffText.replace(/^\uFEFF/, ""));
  } catch (error) {
    fail("R001_HANDOFF_JSON_INVALID", error.message);
  }
  if (handoff?.schema_version !== "opiu-r001-handoff.v1") fail("R001_HANDOFF_SCHEMA_MISMATCH");

  const runId = text(handoff.run_id);
  if (!runId || text(handoff.source_r005_run_id) !== runId) fail("R001_HANDOFF_RUN_MISMATCH");
  requireRequested(runId, requestedRunId, "R001_HANDOFF_REQUEST_RUN_MISMATCH");

  const organization = handoff.organization ?? {};
  const organizationId = text(organization.id);
  const organizationName = text(organization.name);
  const organizationPath = text(organization.path);
  const period = text(handoff.period);
  if (!organizationId || !organizationName || !organizationPath) fail("R001_HANDOFF_ORGANIZATION_REQUIRED");
  if (!period) fail("R001_HANDOFF_PERIOD_REQUIRED");
  requireRequested(organizationId, requestedOrganizationId, "R001_HANDOFF_REQUEST_ORGANIZATION_ID_MISMATCH");
  requireRequested(organizationName, requestedOrganizationName, "R001_HANDOFF_REQUEST_ORGANIZATION_MISMATCH");
  requireRequested(period, requestedPeriod, "R001_HANDOFF_REQUEST_PERIOD_MISMATCH");

  const reconciliation = await verifiedFile(handoff.reconciliation, "path", "sha256", "reconciliation");
  const codexInput = await verifiedFile(handoff.reconciliation, "codex_input_path", "codex_input_sha256", "codex_input");
  const rules = await verifiedFile(handoff.rules, "path", "sha256", "rules");
  const applications = await verifiedFile(handoff.applications, "path", "sha256", "applications");
  requireRequestedPath(reconciliation.path, reconciliationPath, "R001_HANDOFF_REQUEST_RECONCILIATION_MISMATCH");
  requireRequestedPath(codexInput.path, codexInputPath, "R001_HANDOFF_REQUEST_CODEX_INPUT_MISMATCH");
  requireRequestedPath(applications.path, applicationsPath, "R001_HANDOFF_REQUEST_APPLICATIONS_MISMATCH");

  const codexPayload = JSON.parse((await fs.readFile(codexInput.path, "utf8")).replace(/^\uFEFF/, ""));
  if (text(codexPayload.report_sha256).toUpperCase() !== reconciliation.sha256) {
    fail("R001_HANDOFF_REPORT_CODEX_INPUT_HASH_MISMATCH");
  }
  const structuralControlProof = verifyStructuralControlProofDescriptor(
    handoff.structural_control_proof,
    codexPayload,
  );
  for (const [label, source] of [["rules", rules], ["applications", applications]]) {
    const document = JSON.parse((await fs.readFile(source.path, "utf8")).replace(/^\uFEFF/, ""));
    if (text(document.run_id) !== runId) fail(`R001_HANDOFF_${label.toUpperCase()}_RUN_MISMATCH`);
    if (label === "applications") validateDraftApplications(document, { runId, organizationId, period });
  }

  return {
    handoffPath: resolvedHandoffPath,
    handoffSha256: await sha256(resolvedHandoffPath),
    runId,
    organizationId,
    organizationName,
    organizationPath,
    period,
    reconciliationPath: reconciliation.path,
    reconciliationSha256: reconciliation.sha256,
    codexInputPath: codexInput.path,
    codexInputSha256: codexInput.sha256,
    rulesPath: rules.path,
    rulesSha256: rules.sha256,
    applicationsPath: applications.path,
    applicationsSha256: applications.sha256,
    rulesRevisionSetHash: text(handoff.rules?.rules_revision_set_hash),
    structuralControlProof,
  };
}
