import assert from "node:assert/strict";
import test from "node:test";
import { applyUserDecisions } from "./decisions.mjs";

test("accept difference creates no rule and no correction application", () => {
  const candidate = {
    candidate_id: "CAND-1",
    decision: "UNRESOLVED",
    user_status: "PENDING_REVIEW",
    scope: {}, intalev: {}, erp: {}, accounting: {}, action: { action_type: "ONE_SIDE" }, evidence: {},
  };
  const application = { application_id: "APP-1", candidate_id: "CAND-1", result_status: "REVIEW" };
  const result = applyUserDecisions({
    candidates: [candidate], applications: [application],
    registry: { rules: [], revisions: [], applications: [], approvals: [], evidence: [] },
    decisionsDoc: { author: "test", decisions: [{ candidate_id: "CAND-1", decision: "ACCEPT_DIFFERENCE" }] },
    context: { run_id: "RUN-1", period: "2025-01" },
  });
  assert.equal(result.candidates[0].user_status, "ACCEPT_DIFFERENCE");
  assert.equal(result.applications[0].result_status, "NO_ACTION");
  assert.equal(result.registry.rules.length, 0);
  assert.equal(result.registry.approvals.length, 0);
});
