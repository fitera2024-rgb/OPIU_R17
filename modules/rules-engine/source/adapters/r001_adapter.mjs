import { array, canonicalRule, normalizeAccounting, normalizeScope, normalizeSide, text } from "../normalize.mjs";

function normalizeCandidate(candidate, context) {
  return {
    ...structuredClone(candidate),
    candidate_id: text(candidate.candidate_id),
    existing_rule_id: candidate.existing_rule_id ?? null,
    existing_revision_id: candidate.existing_revision_id ?? null,
    decision: text(candidate.decision || "UNRESOLVED"),
    impact_class: text(candidate.impact_class || "CORRECTION_ANALYTICS"),
    scope: normalizeScope(candidate.scope ?? { organization_id: context.organization?.id, organization_name: context.organization?.name, include_descendants: context.organization?.include_descendants }),
    intalev: normalizeSide(candidate.intalev ?? {}),
    erp: normalizeSide(candidate.erp ?? {}),
    accounting: normalizeAccounting(candidate.accounting ?? {}),
    action: typeof candidate.action === "string" ? { action_type: candidate.action, parameters: {} } : candidate.action ?? { action_type: "MANUAL_REVIEW", parameters: {} },
    evidence: { ...(candidate.evidence ?? {}), source_engine: "R001", source_run_id: context.run_id },
    confidence: candidate.confidence ?? { level: "LOW", score: 0, reasons: ["R001 feedback без оценки"] },
    missing_fields: array(candidate.missing_fields).map(text),
    required_user_actions: array(candidate.required_user_actions).map(text),
    user_status: text(candidate.user_status || "PENDING_REVIEW"),
  };
}

function normalizeApplication(application, context) {
  return {
    ...structuredClone(application),
    application_id: text(application.application_id),
    rule_id: application.rule_id ?? null,
    revision_id: application.revision_id ?? null,
    candidate_id: application.candidate_id ?? null,
    run_id: text(application.run_id || context.run_id),
    organization_id: text(application.organization_id || context.organization?.id),
    organization_name: text(application.organization_name || context.organization?.name),
    period: text(application.period || context.period),
    amount: Number(application.amount || 0),
    currency: text(application.currency || "RUB"),
    source: { ...(application.source ?? {}), engine: "R001" },
    result_status: text(application.result_status || "REVIEW"),
  };
}

export function adaptR001(payload, context) {
  if (payload?.schema_version !== "opiu-rule-feedback.v1") throw new Error(`Unsupported R001 feedback schema: ${payload?.schema_version}`);
  return {
    candidates: array(payload.candidates).map((item) => normalizeCandidate(item, context)),
    applications: array(payload.applications).map((item) => normalizeApplication(item, context)),
    rules_used: array(payload.rules_used).map((item) => {
      try { return canonicalRule(item); } catch { return structuredClone(item); }
    }),
    warnings: array(payload.warnings),
    errors: array(payload.errors),
    source: { engine: "R001", schema: payload.schema_version },
  };
}
