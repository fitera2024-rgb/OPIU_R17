import path from "node:path";
import { IMPACT, NEXT_ACTIONS, USER_DECISIONS } from "./constants.mjs";

const PHASES = new Set(["AFTER_R005", "AFTER_USER_DECISIONS", "AFTER_R001"]);
const CANDIDATE_DECISIONS = new Set(["EXISTING_RULE", "NEW_RULE", "NEW_REVISION", "APPLICATION_ONLY", "NO_RULE", "UNRESOLVED"]);
const USER_STATUSES = new Set(["PENDING_REVIEW", "CONFIRMED", "REJECTED", "MANUAL_REVIEW", "ACCEPT_DIFFERENCE"]);
const RULE_TYPES = new Set(["MAP_ARTICLE", "STORNO_REPOST", "EXCLUDE", "ACCEPT_DIFFERENCE", "CONTROL_ONLY", "DO_NOT_CORRECT_TOTAL", "ONE_SIDE", "MANUAL_REVIEW", "CUSTOM"]);
const RULE_STATUSES = new Set(["DRAFT", "PENDING_REVIEW", "CONFIRMED", "REJECTED", "MANUAL_REVIEW", "ACTIVE", "INACTIVE", "ORGANIZATION_UNMAPPED", "CONFLICT"]);
const APPLICATION_STATUSES = new Set(["FOUND", "PROPOSED", "CONFIRMED", "APPLIED", "REVIEW", "NO_ACTION", "REJECTED", "FAILED"]);

function fail(message) {
  throw new Error(`VALIDATION_FAILED: ${message}`);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required`);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
}

function containsAmountKey(value, trail = "rule") {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    const next = `${trail}.${key}`;
    if (["amount", "amounts"].includes(key.toLowerCase())) return next;
    const nested = containsAmountKey(child, next);
    if (nested) return nested;
  }
  return "";
}

export function validateContext(context) {
  requireObject(context, "context");
  if (context.schema_version !== "opiu-rules-engine-context.v1") fail("unsupported context schema");
  requireText(context.run_id, "context.run_id");
  if (!PHASES.has(context.phase)) fail(`unsupported phase ${context.phase}`);
  requireObject(context.organization, "context.organization");
  requireText(context.organization.id, "context.organization.id");
  requireText(context.organization.name, "context.organization.name");
  requireText(context.period, "context.period");
  requireObject(context.paths, "context.paths");
  requireText(context.paths.rules_registry, "context.paths.rules_registry");
  requireText(context.paths.output_dir, "context.paths.output_dir");
  if (["AFTER_R005", "AFTER_USER_DECISIONS"].includes(context.phase)) requireText(context.paths.r005_codex_input, "context.paths.r005_codex_input");
  if (context.phase === "AFTER_R001") requireText(context.paths.r001_feedback, "context.paths.r001_feedback");
  const options = context.options ?? {};
  if (options.auto_activate_rules === true) fail("auto_activate_rules must remain false");
  if (options.modify_source_files === true) fail("modify_source_files must remain false");
  if (options.require_user_confirmation === false) fail("require_user_confirmation must remain true");
  return context;
}

export function validateRuntimePaths(context, dataRoot = "") {
  if (!dataRoot) return;
  const root = path.resolve(dataRoot);
  for (const [name, value] of Object.entries(context.paths ?? {})) {
    if (!value || typeof value !== "string") continue;
    const resolved = path.resolve(value);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) continue;
    fail(`context path ${name} leaves OPIU_DATA_ROOT`);
  }
}

export function validateRule(rule) {
  requireObject(rule, "rule");
  requireText(rule.rule_id, "rule.rule_id");
  requireText(rule.revision_id, "rule.revision_id");
  requireText(rule.title, "rule.title");
  if (!RULE_TYPES.has(rule.rule_type)) fail(`unsupported rule_type ${rule.rule_type}`);
  if (!RULE_STATUSES.has(rule.status)) fail(`unsupported rule status ${rule.status}`);
  if (typeof rule.is_current !== "boolean") fail("rule.is_current must be boolean");
  if (!Number.isInteger(rule.valid_from_year) || rule.valid_from_year < 2000 || rule.valid_from_year > 2200) fail("rule.valid_from_year is invalid");
  requireObject(rule.scope, "rule.scope");
  requireObject(rule.intalev, "rule.intalev");
  requireObject(rule.erp, "rule.erp");
  requireObject(rule.accounting, "rule.accounting");
  requireObject(rule.action, "rule.action");
  if (!RULE_TYPES.has(rule.action.action_type)) fail(`unsupported rule action ${rule.action.action_type}`);
  requireObject(rule.source, "rule.source");
  const forbidden = containsAmountKey(rule);
  if (forbidden) fail(`amount belongs to an application, not ${forbidden}`);
  return rule;
}

export function validateCandidate(candidate) {
  requireObject(candidate, "candidate");
  requireText(candidate.candidate_id, "candidate.candidate_id");
  if (!CANDIDATE_DECISIONS.has(candidate.decision)) fail(`unsupported candidate decision ${candidate.decision}`);
  if (!Object.values(IMPACT).includes(candidate.impact_class)) fail(`unsupported impact ${candidate.impact_class}`);
  for (const field of ["scope", "intalev", "erp", "accounting", "action", "evidence", "confidence"]) requireObject(candidate[field], `candidate.${field}`);
  if (!USER_STATUSES.has(candidate.user_status)) fail(`unsupported user_status ${candidate.user_status}`);
  const score = Number(candidate.confidence.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) fail("candidate confidence score is invalid");
  return candidate;
}

export function validateApplication(application) {
  requireObject(application, "application");
  requireText(application.application_id, "application.application_id");
  requireText(application.run_id, "application.run_id");
  requireText(application.organization_id, "application.organization_id");
  requireText(application.period, "application.period");
  if (!Number.isFinite(Number(application.amount))) fail("application.amount must be finite");
  requireText(application.currency, "application.currency");
  requireObject(application.source, "application.source");
  if (!APPLICATION_STATUSES.has(application.result_status)) fail(`unsupported application status ${application.result_status}`);
  return application;
}

export function validateRegistry(registry) {
  requireObject(registry, "registry");
  for (const rule of registry.rules ?? []) validateRule(rule);
  for (const application of registry.applications ?? []) validateApplication(application);
  return registry;
}

export function validateDecisions(doc, context, candidates) {
  requireObject(doc, "user decisions");
  if (doc.schema_version !== "opiu-user-rule-decisions.v1") fail("unsupported user decisions schema");
  if (doc.run_id !== context.run_id) fail("user decisions run_id does not match context");
  if (!Array.isArray(doc.decisions)) fail("user decisions must be an array");
  const known = new Set(candidates.map((item) => item.candidate_id));
  const seen = new Set();
  for (const item of doc.decisions) {
    requireText(item.candidate_id, "decision.candidate_id");
    if (!known.has(item.candidate_id)) fail(`unknown candidate ${item.candidate_id}`);
    if (seen.has(item.candidate_id)) fail(`duplicate decision for ${item.candidate_id}`);
    seen.add(item.candidate_id);
    if (!USER_DECISIONS.has(item.decision)) fail(`unsupported user decision ${item.decision}`);
    if (["LINK_TO_EXISTING", "CREATE_REVISION"].includes(item.decision) && !item.existing_rule_id) fail(`${item.decision} requires existing_rule_id`);
  }
  return doc;
}

export function validateWorkflow(workflow) {
  requireObject(workflow, "workflow");
  if (workflow.schema_version !== "opiu-rules-workflow-decision.v1") fail("unsupported workflow schema");
  if (!Object.values(NEXT_ACTIONS).includes(workflow.next_action)) fail(`unsupported next_action ${workflow.next_action}`);
  if (!Array.isArray(workflow.reasons) || !Array.isArray(workflow.required_user_actions)) fail("workflow reasons/actions must be arrays");
  return workflow;
}

export function validateEngineOutputs({ candidates, applications, registry, workflow }) {
  candidates.forEach(validateCandidate);
  applications.forEach(validateApplication);
  validateRegistry(registry);
  validateWorkflow(workflow);
}
