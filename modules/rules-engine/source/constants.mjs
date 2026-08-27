export const SCHEMAS = Object.freeze({
  context: "opiu-rules-engine-context.v1",
  candidates: "opiu-rule-candidates.v1",
  applications: "opiu-rule-applications.v1",
  workflow: "opiu-rules-workflow-decision.v1",
  manifest: "opiu-rules-engine-manifest.v1",
  feedback: "opiu-rule-feedback.v1",
  engineRules: "opiu-engine-rules.v2",
  r001Handoff: "opiu-r001-handoff.v1",
});

export const NEXT_ACTIONS = Object.freeze({
  WAIT_USER_RULES: "WAIT_USER_RULES",
  RERUN_R005: "RERUN_R005",
  PASS_TO_R001: "PASS_TO_R001",
  RERUN_R001: "RERUN_R001",
  COMPLETE: "COMPLETE",
  FAILED_NO_STATE_CHANGE: "FAILED_NO_STATE_CHANGE",
  FAILED: "FAILED",
});

export const IMPACT = Object.freeze({
  RECONCILIATION_MAPPING: "RECONCILIATION_MAPPING",
  RECONCILIATION_FORMULA: "RECONCILIATION_FORMULA",
  CORRECTION_RECLASS: "CORRECTION_RECLASS",
  CORRECTION_ANALYTICS: "CORRECTION_ANALYTICS",
  CONTROL_ONLY: "CONTROL_ONLY",
});

export const USER_DECISIONS = new Set([
  "CONFIRMED",
  "REJECTED",
  "MANUAL_REVIEW",
  "ACCEPT_DIFFERENCE",
  "LINK_TO_EXISTING",
  "CREATE_REVISION",
]);

export const CONFIRMING_DECISIONS = new Set([
  "CONFIRMED",
  "LINK_TO_EXISTING",
  "CREATE_REVISION",
]);

export const R005_IMPACTS = new Set([
  IMPACT.RECONCILIATION_MAPPING,
  IMPACT.RECONCILIATION_FORMULA,
]);

export const R001_IMPACTS = new Set([
  IMPACT.CORRECTION_RECLASS,
  IMPACT.CORRECTION_ANALYTICS,
]);
