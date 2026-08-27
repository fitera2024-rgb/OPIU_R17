import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateSide,
  uniqueExactHierarchyBindingProof,
} from "./opiu_reconcile.mjs";
import { decideReconciliationPipelineRows } from "./reconciliation_decision_engine.mjs";

const proof = {
  status: "PROVEN_ERP_PARENT_COMPOSITION",
  component_source_cells: ["D11", "D12"],
  binding_repair_required: true,
  correction_authority: false,
  posting_rows: 0,
};

function record(bindingProof) {
  return {
    erp: {
      amount: 15,
      status: "MATCHED",
      trace: [],
      proven_parent_composition: bindingProof,
    },
  };
}

test("aggregate preserves only unanimous byte-identical hierarchy binding proof", () => {
  const result = aggregateSide([
    record(proof),
    record(JSON.parse(JSON.stringify(proof))),
  ], "erp");

  assert.equal(result.amount, 30);
  assert.deepEqual(result.proven_parent_composition, proof);
});

test("aggregate fails closed when hierarchy binding proof differs by period", () => {
  const changed = { ...proof, component_source_cells: ["E11", "E12"] };
  const result = aggregateSide([record(proof), record(changed)], "erp");

  assert.equal(result.amount, 30);
  assert.equal(result.proven_parent_composition, null);
});

test("aggregate fails closed when any period lacks hierarchy binding proof", () => {
  const result = aggregateSide([record(proof), record(null)], "erp");

  assert.equal(result.amount, 30);
  assert.equal(result.proven_parent_composition, null);
});

test("decision engine records an exact zero-delta hierarchy repair as non-posting UPDATE_MAPPING", () => {
  const sha256 = "A".repeat(64);
  const aggregated = aggregateSide([record(proof)], "erp");
  aggregated.trace = proof.component_source_cells.map((source_cell) => ({
    source_cell,
    sha256,
    amount: source_cell === "D11" ? 10 : 5,
  }));
  const result = decideReconciliationPipelineRows({
    rows: [{
      code: "R900",
      hierarchy_status: "HIERARCHY_UNPROVEN",
      intalev: { amount: 15, trace: [] },
      erp: aggregated,
      raw_delta: 0,
    }],
    tolerance: 0.01,
  });

  assert.equal(result.binding_repairs.length, 1);
  assert.equal(result.binding_repairs[0].classification, "BINDING_REPAIR_PROVEN");
  assert.equal(result.binding_repairs[0].binding_candidate.decision_type, "UPDATE_MAPPING");
  assert.equal(result.binding_repairs[0].effective_delta, 0);
  assert.equal(result.binding_repairs[0].correction_allowed, false);
  assert.equal(result.binding_repairs[0].posting_rows, 0);
});

test("simultaneous hierarchy proof kinds fail closed in decision and codex projections", () => {
  const sha256 = "A".repeat(64);
  const erp = {
    amount: 15,
    status: "MATCHED",
    trace: proof.component_source_cells.map((source_cell) => ({ source_cell, sha256 })),
    proven_parent_composition: proof,
    proven_presentation_parent: {
      status: "PROVEN_ERP_PRESENTATION_PARENT",
      source_cell: "D11",
      binding_repair_required: true,
      correction_authority: false,
      posting_rows: 0,
    },
  };
  const result = decideReconciliationPipelineRows({
    rows: [{
      code: "R901",
      hierarchy_status: "HIERARCHY_UNPROVEN",
      intalev: { amount: 15, trace: [] },
      erp,
      raw_delta: 0,
    }],
    tolerance: 0.01,
  });

  assert.equal(uniqueExactHierarchyBindingProof(erp), null);
  assert.equal(result.binding_repairs.length, 0);
  assert.equal(result.rows[0].classification, "HIERARCHY_REPAIR");
});
