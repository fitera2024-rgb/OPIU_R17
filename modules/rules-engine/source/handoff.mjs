import path from "node:path";
import fs from "node:fs/promises";
import { writeJson, sha256File, sha256Json, ensureDir, utcNow } from "./io.mjs";
import { canonicalRule, ruleRevisionSetHash } from "./normalize.mjs";
import { ruleAppliesToContext } from "./matcher.mjs";
import { NEXT_ACTIONS, SCHEMAS } from "./constants.mjs";
import { structuralControlProofFromCodexPayload } from "./structural_control_proof.mjs";

function currentEnabledRules(registry, context) {
  return (registry.rules ?? []).map(canonicalRule).filter((rule) => rule.is_current !== false && rule.enabled !== false && ["ACTIVE", "CONFIRMED"].includes(rule.status) && ruleAppliesToContext(rule, context));
}

function executionId(context, rulesHash) {
  if (context.rules_execution_id) return context.rules_execution_id;
  return `ITER-${Number(context.iteration_number || 1) + 1}-${rulesHash.slice(0, 10)}`;
}

function text(value) {
  return String(value ?? "").trim();
}

function moneyCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function exactCodes(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].sort();
}

function acceptedIntergroupHandoffCandidate(candidate, application) {
  const parameters = candidate?.action?.parameters ?? {};
  if (text(candidate?.impact_class).toUpperCase() !== "CORRECTION_ANALYTICS") return false;
  if (text(candidate?.action?.action_type).toUpperCase() !== "STORNO_REPOST") return false;
  if (text(parameters?.reclass_scope).toUpperCase() !== "INTER_GROUP") return false;
  if (parameters?.review_only !== true) return false;
  if (parameters?.accepted_intergroup_reclass !== true || parameters?.economic_reclass_proven !== true) return false;
  if (text(parameters?.proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return false;
  if (text(application?.economic_proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return false;
  if (text(application?.output_route).toUpperCase() !== "СПОРНО") return false;
  if (application?.execution_allowed !== false || application?.ready_to_upload !== false || application?.release_allowed !== false) return false;
  const routeId = text(parameters?.intergroup_reclass_id);
  if (!routeId || text(application?.economic_route_id) !== routeId) return false;
  const acceptedCents = moneyCents(parameters?.accepted_amount);
  if (acceptedCents === null || acceptedCents <= 0 || moneyCents(application?.amount) !== acceptedCents) return false;

  const legs = Array.isArray(parameters?.member_legs) ? parameters.member_legs : [];
  if (legs.length < 2) return false;
  const identities = new Set();
  const sources = [];
  const targets = [];
  for (const leg of legs) {
    const code = text(leg?.code);
    const role = text(leg?.role).toUpperCase();
    const expectedDirection = role === "RECLASS_SOURCE" ? "STORNO" : role === "RECLASS_TARGET" ? "REPOST" : "";
    const effectCents = moneyCents(leg?.accepted_intergroup_effect);
    const identity = `${role}\u0000${code}`;
    if (!code || !expectedDirection || text(leg?.economic_direction).toUpperCase() !== expectedDirection || identities.has(identity)) return false;
    if (effectCents === null || (role === "RECLASS_SOURCE" ? effectCents >= 0 : effectCents <= 0)) return false;
    if (moneyCents(leg?.correction_amount) !== Math.abs(effectCents)) return false;
    if (moneyCents(leg?.root_effective_delta) !== 0) return false;
    if (leg?.accepted_intergroup_reclass !== true) return false;
    if (text(leg?.intergroup_reclass_id) !== routeId) return false;
    if (text(leg?.intergroup_reclass_proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return false;
    identities.add(identity);
    (role === "RECLASS_SOURCE" ? sources : targets).push({ code, effectCents });
  }
  if (!sources.length || !targets.length) return false;
  if (sources.reduce((sum, leg) => sum + Math.abs(leg.effectCents), 0) !== acceptedCents) return false;
  if (targets.reduce((sum, leg) => sum + leg.effectCents, 0) !== acceptedCents) return false;
  if (JSON.stringify(exactCodes(parameters?.source_codes)) !== JSON.stringify(exactCodes(sources.map((leg) => leg.code)))) return false;
  if (JSON.stringify(exactCodes(parameters?.target_codes)) !== JSON.stringify(exactCodes(targets.map((leg) => leg.code)))) return false;
  return true;
}

function isControlOnlyCandidate(candidate, application) {
  const parameters = candidate?.action?.parameters ?? {};
  const explicitControl = candidate?.group_review_only === true
    || candidate?.hierarchy_has_children === true
    || candidate?.has_children === true
    || parameters?.structural_non_posting === true
    || parameters?.hierarchy_has_children === true
    || String(candidate?.action?.action_type || "").toUpperCase() === "CONTROL_ONLY"
    || String(candidate?.impact_class || "").toUpperCase() === "CONTROL_ONLY"
    || String(candidate?.decision || "").toUpperCase() === "NO_RULE";
  if (explicitControl) return true;
  const groupDiagnostic = String(candidate?.evidence?.group_delta_breakdown?.mode || "").toUpperCase() === "GROUP_DRILLDOWN_REVIEW_ONLY";
  return groupDiagnostic && !acceptedIntergroupHandoffCandidate(candidate, application);
}

export async function buildHandoff({ workflow, context, registry, candidates = [], applications: runApplications = [], outputDir }) {
  const rules = currentEnabledRules(registry, context);
  const rulesHash = ruleRevisionSetHash(rules);
  const handoffRoot = context.paths.handoff_root || path.join(path.dirname(outputDir), "handoff");
  if (workflow.next_action === NEXT_ACTIONS.RERUN_R005) {
    const dir = await ensureDir(path.join(handoffRoot, "r005-rerun"));
    const rulesPath = path.join(dir, "engine_rules.json");
    const contextPath = path.join(dir, "run_context.json");
    const requestPath = path.join(dir, "rerun_request.json");
    const iterationId = executionId(context, rulesHash);
    const nextIteration = Number(context.iteration_number || 1) + 1;
    await writeJson(rulesPath, { schema_version: SCHEMAS.engineRules, run_id: context.run_id, parent_run_id: context.run_id, iteration_id: iterationId, iteration_number: nextIteration, rules_revision_set_hash: rulesHash, rules });
    await writeJson(contextPath, { ...context, phase: "AFTER_R005", parent_run_id: context.run_id, iteration_id: iterationId, iteration_number: nextIteration });
    await writeJson(requestPath, {
      schema_version: "opiu-r005-rerun-request.v1",
      parent_run_id: context.run_id,
      iteration_id: iterationId,
      iteration_number: nextIteration,
      reason: workflow.reasons,
      use_same_source_files: true,
      source_hashes: context.source_hashes ?? {},
      rules_path: rulesPath,
      rules_revision_set_hash: rulesHash,
      workflow_state_fingerprint: workflow.state_fingerprint,
      created_at: utcNow(),
    });
    return { target: "R005", directory: dir, iteration_id: iterationId, rules_path: rulesPath, context_path: contextPath, request_path: requestPath };
  }
  if ([NEXT_ACTIONS.PASS_TO_R001, NEXT_ACTIONS.RERUN_R001].includes(workflow.next_action)) {
    const dir = await ensureDir(path.join(handoffRoot, "r001"));
    const rulesPath = path.join(dir, "engine_rules.json");
    const appsPath = path.join(dir, "r001_rule_application_drafts.json");
    const handoffPath = path.join(dir, "r001_handoff.json");
    const checksumsPath = path.join(dir, "source_checksums.json");
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
    const applications = runApplications
      .filter((app) => app.run_id === context.run_id && app.organization_id === context.organization.id && app.period === context.period)
      .filter((app) => ["PROPOSED", "REVIEW"].includes(app.result_status))
      .map((app) => ({ app, candidate: candidateById.get(app.candidate_id) ?? null }))
      .filter(({ app, candidate }) => candidate
        && !isControlOnlyCandidate(candidate, app)
        && ["STORNO_REPOST", "ONE_SIDE"].includes(String(candidate?.action?.action_type || "").toUpperCase()))
      .map(({ app, candidate }) => {
        return {
          ...structuredClone(app),
          candidate_snapshot: structuredClone(candidate),
          result_status: app.result_status,
          proof_status: "UNPROVEN",
          original_proof_status: app.original_proof_status || app.proof_status || candidate?.evidence?.proof_status || "UNPROVEN",
          review_state: "NEEDS_REVIEW",
          output_route: "СПОРНО",
          disputed_only: true,
          execution_allowed: false,
          posting_rows: 0,
          ready_to_upload: false,
          release_allowed: false,
          live_1c_allowed: false,
        };
      });
    await writeJson(rulesPath, { schema_version: SCHEMAS.engineRules, run_id: context.run_id, rules_revision_set_hash: rulesHash, rules });
    await writeJson(appsPath, {
      schema_version: SCHEMAS.applications,
      run_id: context.run_id,
      applications,
      safety: { report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false },
    });
    const reportPath = context.paths.r005_report;
    const sidecarPath = context.paths.r005_codex_input;
    const reportSha = reportPath ? await sha256File(reportPath) : "";
    const sidecarSha = sidecarPath ? await sha256File(sidecarPath) : "";
    if (!reportPath || !reportSha || !sidecarPath || !sidecarSha) throw new Error("R001 handoff requires registered R005 report and codex-input with SHA-256");
    let sidecar;
    try {
      sidecar = JSON.parse((await fs.readFile(sidecarPath, "utf8")).replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`R001_HANDOFF_CODEX_INPUT_INVALID:${error.message}`);
    }
    const structuralControlProof = structuralControlProofFromCodexPayload(sidecar);
    const rulesSha = await sha256File(rulesPath);
    const appsSha = await sha256File(appsPath);
    const handoff = {
      schema_version: SCHEMAS.r001Handoff,
      run_id: context.run_id,
      source_r005_run_id: context.run_id,
      organization: {
        id: context.organization.id,
        name: context.organization.name,
        path: context.organization.path,
        include_descendants: context.organization.include_descendants === true,
      },
      period: context.period,
      reconciliation: { path: reportPath, sha256: reportSha, codex_input_path: sidecarPath, codex_input_sha256: sidecarSha },
      rules: { path: rulesPath, sha256: rulesSha, rules_revision_set_hash: rulesHash },
      applications: { path: appsPath, sha256: appsSha },
      structural_control_proof: structuralControlProof,
      user_decisions_sha256: context.paths.user_decisions ? await sha256File(context.paths.user_decisions).catch(() => "") : "",
      created_at: utcNow(),
    };
    await writeJson(handoffPath, handoff);
    const handoffSha = await sha256File(handoffPath);
    await writeJson(checksumsPath, {
      schema_version: "opiu-source-checksums.v1",
      files: {
        [reportPath]: reportSha,
        [sidecarPath]: sidecarSha,
        [rulesPath]: rulesSha,
        [appsPath]: appsSha,
      },
      manifest_hash: sha256Json(handoff),
    });
    return {
      target: "R001",
      directory: dir,
      handoff_path: handoffPath,
      handoff_sha256: handoffSha,
      rules_path: rulesPath,
      rules_sha256: rulesSha,
      applications_path: appsPath,
      applications_sha256: appsSha,
      checksums_path: checksumsPath,
      application_count: applications.length,
      disputed_application_count: applications.filter((item) => item.disputed_only === true).length,
      safety: { report_only: true, posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false },
    };
  }
  return null;
}
