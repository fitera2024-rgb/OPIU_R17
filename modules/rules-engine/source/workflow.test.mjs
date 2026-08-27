import assert from "node:assert/strict";
import test from "node:test";
import { NEXT_ACTIONS } from "./constants.mjs";
import { decideWorkflow } from "./workflow.mjs";

function candidate({ id = "CAND-1", action = "ONE_SIDE", impact = "CORRECTION_ANALYTICS", status = "PENDING_REVIEW", decision = "UNRESOLVED", userDecision = "" } = {}) {
  return {
    candidate_id: id,
    action: { action_type: action },
    impact_class: impact,
    user_status: status,
    decision,
    user_decision: userDecision,
    required_user_actions: ["Проверить предложение"],
  };
}

function application(candidateId = "CAND-1") {
  return { application_id: `APP-${candidateId}`, candidate_id: candidateId, amount: 1, result_status: "REVIEW" };
}

test("unconfirmed correction proposal passes to R001 only as disputed draft", () => {
  const result = decideWorkflow({ phase: "AFTER_R005", runId: "RUN-1", candidates: [candidate()], applications: [application()], rulesRevisionSetHash: "RULES" });
  assert.equal(result.next_action, NEXT_ACTIONS.PASS_TO_R001);
  assert.equal(result.disputed_draft_count, 1);
  assert.equal(result.blocking_unresolved_count, 0);
});

test("correction candidate without a nonzero application remains blocked", () => {
  const result = decideWorkflow({ phase: "AFTER_R005", runId: "RUN-1", candidates: [candidate()], applications: [], rulesRevisionSetHash: "RULES" });
  assert.equal(result.next_action, NEXT_ACTIONS.WAIT_USER_RULES);
  assert.equal(result.disputed_draft_count, 0);
});

test("unresolved mapping and control proposals still block R001", () => {
  for (const current of [
    candidate({ action: "MAP_ARTICLE", impact: "RECONCILIATION_MAPPING" }),
    candidate({ action: "CONTROL_ONLY", impact: "CONTROL_ONLY" }),
  ]) {
    const result = decideWorkflow({ phase: "AFTER_R005", runId: "RUN-1", candidates: [current], rulesRevisionSetHash: "RULES" });
    assert.equal(result.next_action, NEXT_ACTIONS.WAIT_USER_RULES);
    assert.equal(result.blocking_unresolved_count, 1);
  }
});

test("independent blockers stay visible while a known-direction disputed draft reaches R001", () => {
  const blocking = candidate({
    id: "CAND-BLOCKING",
    action: "MANUAL_REVIEW",
    impact: "RECONCILIATION_FORMULA",
  });
  const disputed = candidate({ id: "CAND-SPORNO" });
  const result = decideWorkflow({
    phase: "AFTER_R005",
    runId: "RUN-1",
    candidates: [blocking, disputed],
    applications: [application("CAND-SPORNO")],
    rulesRevisionSetHash: "RULES",
  });
  assert.equal(result.next_action, NEXT_ACTIONS.PASS_TO_R001);
  assert.equal(result.disputed_draft_count, 1);
  assert.equal(result.blocking_unresolved_count, 1);
  assert.deepEqual(result.required_user_actions, ["Проверить предложение"]);
  assert.match(result.reasons.join(" "), /остаются на ручной проверке/);
});

test("confirmed R005-changing rule reruns R005 before any disputed handoff", () => {
  const confirmed = candidate({ id: "CAND-MAP", action: "MAP_ARTICLE", impact: "RECONCILIATION_MAPPING", status: "CONFIRMED", decision: "NEW_RULE", userDecision: "CONFIRMED" });
  const result = decideWorkflow({ phase: "AFTER_R005", runId: "RUN-1", candidates: [confirmed, candidate()], applications: [application()], rulesRevisionSetHash: "RULES" });
  assert.equal(result.next_action, NEXT_ACTIONS.RERUN_R005);
});

test("confirmed R005-changing rule keeps precedence after R001", () => {
  const r005 = candidate({ id: "CAND-R005", action: "MAP_ARTICLE", impact: "RECONCILIATION_MAPPING", status: "CONFIRMED", decision: "NEW_RULE", userDecision: "CONFIRMED" });
  const r001 = candidate({ id: "CAND-R001", action: "ONE_SIDE", impact: "CORRECTION_ANALYTICS", status: "CONFIRMED", decision: "NEW_RULE", userDecision: "CONFIRMED" });
  const result = decideWorkflow({ phase: "AFTER_R001", runId: "RUN-1", candidates: [r005, r001], applications: [], rulesRevisionSetHash: "RULES" });
  assert.equal(result.next_action, NEXT_ACTIONS.RERUN_R005);
  assert.equal(result.confirmed_r005_change_count, 1);
});

test("AFTER_R001 unresolved behavior remains fail closed", () => {
  const result = decideWorkflow({ phase: "AFTER_R001", runId: "RUN-1", candidates: [candidate()], applications: [application()], rulesRevisionSetHash: "RULES" });
  assert.equal(result.next_action, NEXT_ACTIONS.WAIT_USER_RULES);
});
