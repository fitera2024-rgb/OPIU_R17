import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRulesApplicationsWithR005Fallbacks } from "./r001_cross_source_dedup.mjs";

function rule(overrides = {}) {
  return {
    case_id: "APPLICATION-1",
    pair_id: "CANDIDATE-WITH-UNRELATED-ID",
    organization: "Organization 1",
    period: "2025-11",
    analytical_basis_id: "R035",
    analytical_effect: 93588,
    target_article: "Full business path / NDFL",
    ...overrides,
  };
}

function fallback(overrides = {}) {
  return {
    caseId: "R005-UNPROVEN-R035",
    pairId: "ONE_SIDE-R035",
    organization: "Organization 1",
    period: "2025-11",
    analyticalBasisId: "R035",
    delta: 93588,
    articleName: "Different presentation name",
    ...overrides,
  };
}

test("exact Rules/R005 duplicate keeps the Rules application and suppresses the raw fallback", () => {
  const result = reconcileRulesApplicationsWithR005Fallbacks({
    rulesApplications: [rule()],
    rawFallbacks: [fallback()],
  });
  assert.deepEqual(result.unmatchedFallbacks, []);
  assert.deepEqual(result.exactDuplicateBasisIds, ["R035"]);
  assert.deepEqual(result.conflictingRuleCaseIds, []);
  assert.deepEqual(result.blockers, []);
});

test("a fallback without a Rules application is preserved", () => {
  const raw = fallback();
  const result = reconcileRulesApplicationsWithR005Fallbacks({ rawFallbacks: [raw] });
  assert.deepEqual(result.unmatchedFallbacks, [raw]);
  assert.deepEqual(result.exactDuplicateBasisIds, []);
});

test("equal amount and article name do not deduplicate different explicit bases", () => {
  const raw = fallback({ analyticalBasisId: "R036", articleName: "Full business path / NDFL" });
  const result = reconcileRulesApplicationsWithR005Fallbacks({
    rulesApplications: [rule()],
    rawFallbacks: [raw],
  });
  assert.deepEqual(result.unmatchedFallbacks, [raw]);
  assert.deepEqual(result.exactDuplicateBasisIds, []);
  assert.deepEqual(result.blockers, []);
});

test("the same basis with a different signed delta fails closed", () => {
  for (const rawDelta of [93587.99, -93588]) {
    const result = reconcileRulesApplicationsWithR005Fallbacks({
      rulesApplications: [rule()],
      rawFallbacks: [fallback({ delta: rawDelta })],
    });
    assert.deepEqual(result.unmatchedFallbacks, []);
    assert.deepEqual(result.conflictingRuleCaseIds, ["APPLICATION-1"]);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].blocker_code, "CONFLICTING_R001_ANALYTICAL_BASIS");
    assert.equal(result.blockers[0].analytical_basis_id, "R035");
    assert.equal(result.blockers[0].rules_applications[0].signed_delta_cents, 9358800);
    assert.equal(result.blockers[0].r005_fallbacks[0].signed_delta_cents, Math.round(rawDelta * 100));
  }
});

test("the same basis with a different organization or period fails closed", () => {
  for (const changedContext of [
    { organization: "Organization 2" },
    { period: "2025-12" },
  ]) {
    const result = reconcileRulesApplicationsWithR005Fallbacks({
      rulesApplications: [rule()],
      rawFallbacks: [fallback(changedContext)],
    });
    assert.deepEqual(result.unmatchedFallbacks, []);
    assert.deepEqual(result.conflictingRuleCaseIds, ["APPLICATION-1"]);
    assert.equal(result.blockers[0].blocker_code, "CONFLICTING_R001_ANALYTICAL_BASIS");
  }
});
