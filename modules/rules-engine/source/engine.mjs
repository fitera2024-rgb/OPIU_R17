import path from "node:path";
import { adaptR005 } from "./adapters/r005_identity_guard.mjs";
import { adaptR001 } from "./adapters/r001_adapter.mjs";
import { applyUserDecisions, registerMatchedApplications } from "./decisions.mjs";
import { buildHandoff } from "./handoff.mjs";
import { readJson, writeJson, ensureDir, sha256File, sha256Json, utcNow } from "./io.mjs";
import { matchCandidates } from "./matcher.mjs";
import { canonicalRule, ruleRevisionSetHash, text } from "./normalize.mjs";
import { writeMatchingCsv } from "./report.mjs";
import { writeMatchingXlsx } from "./xlsx.mjs";
import { decideWorkflow } from "./workflow.mjs";
import { SCHEMAS, NEXT_ACTIONS } from "./constants.mjs";
import { validateApplication, validateContext, validateDecisions, validateEngineOutputs, validateRuntimePaths } from "./validation.mjs";

const RULES_SAFETY_PASSPORT = Object.freeze({
  report_only: true,
  creates_postings: false,
  modifies_source_files: false,
  auto_activates_rules: false,
  posting_rows: 0,
  ready_to_upload: false,
  release_allowed: false,
  live_1c_allowed: false,
});

function canonicalApplication(application) {
  const source = application?.source && typeof application.source === "object" ? structuredClone(application.source) : { engine: text(application?.source || "MIGRATION") };
  const resultStatus = text(application?.result_status || application?.decision || "REVIEW").toUpperCase();
  return {
    ...structuredClone(application),
    application_id: text(application?.application_id),
    rule_id: application?.rule_id ?? null,
    revision_id: application?.revision_id ?? null,
    candidate_id: application?.candidate_id ?? null,
    run_id: text(application?.run_id),
    organization_id: text(application?.organization_id || application?.node_id),
    organization_name: text(application?.organization_name || application?.node_name),
    period: text(application?.period),
    amount: Number(application?.amount ?? 0),
    currency: text(application?.currency || "RUB"),
    source,
    result_status: ["FOUND", "PROPOSED", "CONFIRMED", "APPLIED", "REVIEW", "NO_ACTION", "REJECTED", "FAILED"].includes(resultStatus) ? resultStatus : "REVIEW",
  };
}

function normalizeRegistry(registry) {
  return {
    schema_version: registry.schema_version || "opiu-rule-registry.v2",
    library_id: registry.library_id ?? null,
    rules: (registry.rules ?? []).map(canonicalRule),
    revisions: (registry.revisions ?? []).map((rule) => {
      try { return canonicalRule(rule); } catch { return structuredClone(rule); }
    }),
    applications: (registry.applications ?? []).map(canonicalApplication),
    approvals: registry.approvals ?? [],
    evidence: registry.evidence ?? [],
    created_at: registry.created_at ?? null,
    updated_at: registry.updated_at ?? null,
  };
}

function appendUnique(list, item, key) {
  const index = list.findIndex((current) => current?.[key] === item?.[key]);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function registerR001Feedback(registry, adapted, context) {
  const next = structuredClone(registry);
  next.applications ??= [];
  next.evidence ??= [];
  for (const application of adapted.applications ?? []) appendUnique(next.applications, canonicalApplication(application), "application_id");
  for (const used of adapted.rules_used ?? []) {
    const ruleId = text(used.rule_id);
    const revisionId = text(used.revision_id);
    if (!ruleId) continue;
    const evidence = {
      evidence_id: `EVIDENCE-${sha256Json({ run_id: context.run_id, rule_id: ruleId, revision_id: revisionId, used }).slice(0, 16)}`,
      rule_id: ruleId,
      revision_id: revisionId || null,
      run_id: context.run_id,
      source_engine: "R001",
      source_file: context.paths.r001_feedback,
      source_sha256: context.source_hashes?.r001_feedback || "",
      details: structuredClone(used),
      created_at: utcNow(),
    };
    appendUnique(next.evidence, evidence, "evidence_id");
  }
  return next;
}

async function sourceHashes(context) {
  const mapping = {
    rules_registry: context.paths.rules_registry,
    r005_report: context.paths.r005_report,
    r005_codex_input: context.paths.r005_codex_input,
    r001_feedback: context.paths.r001_feedback,
    user_decisions: context.paths.user_decisions,
  };
  const hashes = {};
  for (const [key, filePath] of Object.entries(mapping)) {
    if (!filePath) continue;
    hashes[key] = await sha256File(filePath);
    const expected = text(context.source_hashes?.[key]).toUpperCase();
    if (expected && expected !== hashes[key]) throw new Error(`SOURCE_HASH_MISMATCH: ${key}`);
  }
  return hashes;
}

function finalRunApplications(registry, adaptedApplications, runId, informationalControls = []) {
  const controlIds = new Set(informationalControls.map((item) => item?.candidate_id).filter(Boolean));
  const map = new Map(adaptedApplications.map((item) => [item.application_id, canonicalApplication(item)]));
  for (const item of registry.applications ?? []) if (item.run_id === runId) map.set(item.application_id, canonicalApplication(item));
  return [...map.values()].filter((item) => !controlIds.has(item.candidate_id));
}

export async function runEngine({ contextPath, outputDirOverride = "" }) {
  const contextDir = path.dirname(path.resolve(contextPath));
  const context = validateContext(await readJson(contextPath));
  const resolve = (value) => value && (path.isAbsolute(value) ? path.normalize(value) : path.resolve(contextDir, value));
  const outputDir = outputDirOverride ? path.resolve(outputDirOverride) : resolve(context.paths.output_dir);
  context.paths = Object.fromEntries(Object.entries(context.paths).map(([key, value]) => [key, typeof value === "string" ? resolve(value) : value]));
  context.paths.output_dir = outputDir;
  validateRuntimePaths(context, process.env.OPIU_DATA_ROOT || "");
  await ensureDir(outputDir);
  const hashes = await sourceHashes(context);
  context.source_hashes = { ...(context.source_hashes ?? {}), ...hashes };
  const registry = normalizeRegistry(await readJson(context.paths.rules_registry));
  registry.rules.forEach((rule) => {
    if ("amount" in rule || "amounts" in rule) throw new Error(`RULE_AMOUNT_FORBIDDEN: ${rule.rule_id}`);
  });

  let adapted;
  if (context.phase === "AFTER_R005" || context.phase === "AFTER_USER_DECISIONS") {
    adapted = adaptR005(await readJson(context.paths.r005_codex_input), context);
  } else if (context.phase === "AFTER_R001") {
    adapted = adaptR001(await readJson(context.paths.r001_feedback), context);
  } else {
    throw new Error(`Unsupported phase: ${context.phase}`);
  }

  let candidates = matchCandidates(adapted.candidates, registry, adapted.applications, context);
  let nextRegistry = registerMatchedApplications(registry, candidates, adapted.applications);
  if (context.phase === "AFTER_R001") nextRegistry = registerR001Feedback(nextRegistry, adapted, context);
  let decisionAudit = [];
  let decisionApplications = adapted.applications.map(canonicalApplication);
  const decisionsDoc = await readJson(context.paths.user_decisions, { optional: true });
  if (decisionsDoc) {
    validateDecisions(decisionsDoc, context, candidates);
    const applied = applyUserDecisions({ candidates, applications: decisionApplications, registry: nextRegistry, decisionsDoc, context });
    candidates = applied.candidates;
    decisionApplications = applied.applications;
    nextRegistry = applied.registry;
    decisionAudit = applied.audit;
  }

  const revisionHash = ruleRevisionSetHash((nextRegistry.rules ?? []).map(canonicalRule));
  const currentState = {
    r005_source_hash: text(context.source_hashes?.r005_sources || context.source_hashes?.sources_manifest),
    rules_revision_set_hash: revisionHash,
    user_decisions_hash: hashes.user_decisions || "",
    r005_result_hash: hashes.r005_codex_input || "",
  };
  const runApplications = finalRunApplications(
    nextRegistry,
    decisionApplications,
    context.run_id,
    adapted.informational_controls ?? [],
  );
  const workflow = decideWorkflow({ phase: context.phase, runId: context.run_id, candidates, applications: runApplications, rulesRevisionSetHash: revisionHash, previousState: context.previous_state ?? null, currentState });
  if ((adapted.errors ?? []).length) {
    workflow.next_action = NEXT_ACTIONS.FAILED;
    workflow.reasons = [`Исходный движок вернул ${adapted.errors.length} ошибок; автоматическая передача остановлена.`];
  }
  runApplications.forEach(validateApplication);
  validateEngineOutputs({ candidates, applications: runApplications, registry: nextRegistry, workflow });
  const handoff = await buildHandoff({ workflow, context, registry: nextRegistry, candidates, applications: runApplications, outputDir });
  workflow.handoff = handoff;

  const candidatesDoc = { schema_version: SCHEMAS.candidates, run_id: context.run_id, source_engine: adapted.source.engine, candidates };
  const applicationsDoc = {
    schema_version: SCHEMAS.applications,
    run_id: context.run_id,
    applications: runApplications,
    safety: RULES_SAFETY_PASSPORT,
  };
  const feedbackDoc = {
    schema_version: SCHEMAS.feedback,
    source_engine: adapted.source.engine,
    run_id: context.run_id,
    candidates,
    informational_controls: adapted.informational_controls ?? [],
    applications: runApplications,
    rules_used: adapted.rules_used ?? [],
    unassigned_evidence_rows: adapted.unassigned_evidence_rows ?? [],
    warnings: adapted.warnings ?? [],
    errors: adapted.errors ?? [],
  };
  const registryPatch = { schema_version: "opiu-rule-registry-result.v1", run_id: context.run_id, base_registry_sha256: hashes.rules_registry, registry: nextRegistry, decision_audit: decisionAudit };
  const conversionLog = { schema_version: "opiu-rules-conversion-log.v1", run_id: context.run_id, decision_audit: decisionAudit, warnings: adapted.warnings ?? [], errors: adapted.errors ?? [] };
  const outputDocs = {
    "rule_candidates.json": candidatesDoc,
    "rule_applications.json": applicationsDoc,
    "rule_feedback.json": feedbackDoc,
    "workflow_decision.json": workflow,
    "registry_result.json": registryPatch,
    "conversion_log.json": conversionLog,
  };
  for (const [name, doc] of Object.entries(outputDocs)) await writeJson(path.join(outputDir, name), doc);
  await writeMatchingCsv(path.join(outputDir, "matching_report.csv"), candidates);
  await writeMatchingXlsx(path.join(outputDir, "matching_report.xlsx"), candidates);

  const outputHashes = {};
  for (const name of [...Object.keys(outputDocs), "matching_report.csv", "matching_report.xlsx"]) outputHashes[name] = await sha256File(path.join(outputDir, name));
  const manifest = {
    schema_version: SCHEMAS.manifest,
    engine_version: "0.1.0",
    run_id: context.run_id,
    rules_execution_id: context.rules_execution_id ?? null,
    phase: context.phase,
    created_at: utcNow(),
    input_hash: sha256Json({ context, source_hashes: hashes }),
    registry_input_sha256: hashes.rules_registry,
    source_hashes: hashes,
    output_hashes: outputHashes,
    rules_revision_set_hash: revisionHash,
    workflow_state_fingerprint: workflow.state_fingerprint,
    counts: {
      candidates: candidates.length,
      informational_controls: (adapted.informational_controls ?? []).length,
      applications: runApplications.length,
      pending_review: candidates.filter((candidate) => candidate.user_status === "PENDING_REVIEW" || candidate.user_status === "MANUAL_REVIEW").length,
    },
    next_action: workflow.next_action,
    safety: RULES_SAFETY_PASSPORT,
  };
  await writeJson(path.join(outputDir, "engine_manifest.json"), manifest);

  return { context, candidates, applications: runApplications, registry: nextRegistry, workflow, manifest, outputDir };
}
