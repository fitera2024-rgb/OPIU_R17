import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateActionRows,
  excludeHierarchyCoveredEconomicRows,
  mergeProvidedAndAutonomousDecisions,
} from "./correction_engine_r001.mjs";

function draftDecision(overrides = {}) {
  return {
    case_id: "CASE-PROVIDED",
    pair_id: "PAIR-PROVIDED",
    reconciliation_row: "R033",
    role: "RECLASS_SOURCE",
    decision_type: "STORNO_REPOST",
    approval_state: "OWNER_ACCEPTED",
    period: "2025-10",
    organization: "9 Управляющая компания",
    correction_amount: 244745,
    output_route: "SPORNO",
    ...overrides,
  };
}

test("provided Rules decisions retain missing hierarchy authority decisions without duplicates", () => {
  const supplied = draftDecision({ reason: "explicit Rules decision" });
  const hierarchyCollision = draftDecision({ reason: "rederived hierarchy collision" });
  const hierarchyOnly = draftDecision({
    case_id: "CASE-HIERARCHY",
    pair_id: "PAIR-HIERARCHY",
    reconciliation_row: "R050",
    reason: "independently rederived hierarchy decision",
  });

  const unrelatedAutonomous = draftDecision({
    case_id: "CASE-AUTONOMOUS",
    pair_id: "PAIR-AUTONOMOUS",
    reconciliation_row: "R022",
    role: "AUTONOMOUS_REVIEW",
    reason: "non-hierarchy autonomous candidate",
  });
  const merged = mergeProvidedAndAutonomousDecisions(
    [supplied, supplied],
    [hierarchyCollision, hierarchyOnly, hierarchyOnly, unrelatedAutonomous],
  );

  assert.equal(merged.length, 3);
  assert.equal(merged[0], supplied, "the explicit supplied decision wins the exact identity collision");
  assert.equal(merged[1], hierarchyOnly, "a missing hierarchy decision is appended");
  assert.equal(merged[2], unrelatedAutonomous, "a missing non-hierarchy autonomous candidate is appended");

  const actions = candidateActionRows(merged);
  assert.equal(actions.pairRows.length, 3, "supplied and every autonomous decision reach the action path");
  assert.deepEqual(actions.pairRows.map((row) => row[0]), ["CASE-PROVIDED", "CASE-HIERARCHY", "CASE-AUTONOMOUS"]);
});

test("absent Rules decisions preserve the existing candidate fallback", () => {
  assert.equal(mergeProvidedAndAutonomousDecisions(null, [draftDecision()]), null);
});

test("an explicitly empty Rules decision set still retains every autonomous candidate", () => {
  const candidates = [
    draftDecision({ case_id: "CASE-TREE", pair_id: "PAIR-TREE", role: "TREE" }),
    draftDecision({ case_id: "CASE-HIERARCHY", pair_id: "PAIR-HIERARCHY", role: "HIERARCHY" }),
  ];
  assert.deepEqual(mergeProvidedAndAutonomousDecisions([], candidates), candidates);
});

test("hierarchy physical authority replaces its covered economic draft in canonical output", () => {
  const rows = [
    { case_id: "OWNER-DECISION", pair_id: "OWNER-ROUTE", action: "STORNO" },
    { case_id: "OWNER-DECISION", pair_id: "OWNER-ROUTE", action: "REPOST" },
    { case_id: "PHYSICAL-PAIR", action: "STORNO" },
    { case_id: "PHYSICAL-PAIR", action: "REPOST" },
  ];
  assert.deepEqual(
    excludeHierarchyCoveredEconomicRows(rows, ["OWNER-ROUTE"]),
    rows.slice(2),
    "the independently rederived physical pair is canonical; the covered sparse economic pair is not emitted twice",
  );
});
