import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateProvenRows,
  combineProvenAggregations,
} from "./aggregation_grain.mjs";
import {
  buildParentDetailBlockedResult,
  evaluateParentDetailConsistency,
  REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN,
} from "./parent_detail_guard.mjs";
import {
  annotateSourceTree,
  serializeSourceTreeProof,
} from "./source_tree_proof.mjs";
import { buildErpOutlineTree } from "./hierarchy_tree.mjs";

function row({ id, amount, path = "Parent / Child", system = "ERP", scope = "SCOPE-1" }) {
  return {
    source_identity: id,
    source_identity_scope: scope,
    source_system: system,
    aggregation_grain_id: "PARENT-1",
    full_path: path,
    amount,
  };
}

test("same child materialized three times contributes once", () => {
  const result = aggregateProvenRows([
    row({ id: "child-1", amount: 100 }),
    row({ id: "child-1", amount: 100 }),
    row({ id: "child-1", amount: 100 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  assert.equal(result.status, "PROVEN");
  assert.equal(result.amount, 100);
  assert.equal(result.ignored.length, 2);
});

test("same presentation path with different source identities is retained", () => {
  const result = aggregateProvenRows([
    row({ id: "child-1", amount: 100 }),
    row({ id: "child-2", amount: 100 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  assert.equal(result.status, "PROVEN");
  assert.equal(result.amount, 200);
  assert.equal(result.ignored.length, 0);
});

test("same amount does not prove duplicate", () => {
  const result = aggregateProvenRows([
    row({ id: "source-a", amount: 250 }),
    row({ id: "source-b", amount: 250 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  assert.equal(result.amount, 500);
  assert.equal(result.reason_code, "PROVEN_COMPOSITION");
});

test("cross-system representation is not double-counted", () => {
  const result = aggregateProvenRows([
    row({ id: "erp-1", amount: 100, system: "ERP" }),
    row({ id: "intalev-1", amount: 100, system: "INTALEV" }),
  ], { aggregationKey: "PARENT-1" });
  assert.equal(result.status, "REVIEW_ONLY");
  assert.equal(result.reason_code, "CROSS_SYSTEM_SCOPE");
  assert.equal(result.amount, null);
});

test("missing aggregation proof stays review-only and has no authority", () => {
  const result = aggregateProvenRows([
    { amount: 100, full_path: "Parent / Child" },
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  assert.equal(result.status, "REVIEW_ONLY");
  assert.equal(result.reason_code, "AGGREGATION_GRAIN_UNPROVEN");
  assert.equal(result.correction_authority, false);
  assert.equal(result.posting_rows, 0);
});

test("contradictory proven composition is blocked", () => {
  const result = aggregateProvenRows([
    row({ id: "child-1", amount: 100 }),
    row({ id: "child-1", amount: 101 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reason_code, "PROVEN_COMPOSITION_CONTRADICTION");
});

test("source-tree parent detail uses the proven grain instead of physical fanout", () => {
  const nodes = [
    { level: 0, value: 100, source_identity: "parent", source_identity_scope: "SCOPE-1", source_system: "INTALEV", full_path: "Parent" },
    { level: 1, value: 100, source_identity: "child", source_identity_scope: "SCOPE-1", source_system: "INTALEV", full_path: "Parent / Child" },
    { level: 1, value: 100, source_identity: "child", source_identity_scope: "SCOPE-1", source_system: "INTALEV", full_path: "Parent / Child" },
    { level: 1, value: 100, source_identity: "child", source_identity_scope: "SCOPE-1", source_system: "INTALEV", full_path: "Parent / Child" },
  ];
  annotateSourceTree(nodes, { amountKey: "value", sourceSystem: "INTALEV" });
  assert.equal(nodes[0].child_sum, 100);
  assert.equal(nodes[0].hierarchy_status, "PASS");
  assert.equal(nodes[0].aggregation_grain.ignored.length, 2);
  assert.doesNotThrow(() => JSON.stringify(serializeSourceTreeProof(nodes[0])));
});

test("parent/detail authority requires matching proven grain", () => {
  const parent = aggregateProvenRows([
    row({ id: "parent", amount: 244745 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  const detail = aggregateProvenRows([
    row({ id: "detail-a", amount: 100000 }),
    row({ id: "detail-b", amount: 144745 }),
  ], { sourceSystem: "ERP", aggregationKey: "PARENT-1" });
  const control = evaluateParentDetailConsistency({
    parentTotal: parent.amount,
    detailSum: detail.amount,
    parentAggregation: parent,
    detailAggregation: combineProvenAggregations(parent, detail),
  });
  assert.equal(control.status, "PASS");
  assert.equal(control.difference, 0);
  assert.equal(control.correction_authority, false);
  assert.equal(control.posting_rows, 0);
});

test("parent/detail without proof is review-only, not correction authority", () => {
  const control = evaluateParentDetailConsistency({ parentTotal: 10, detailSum: 10 });
  assert.equal(control.status, REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN);
  const result = buildParentDetailBlockedResult(control);
  assert.equal(result.amount, null);
  assert.equal(result.posting_rows, 0);
  assert.equal(result.ready_to_upload, false);
});

function treeSource(label, amount, id, outline_level) {
  return {
    label,
    amount,
    id,
    outline_level,
    sha256: "A".repeat(64),
    sheet: "Source",
    source_cell: `A${outline_level + 1}`,
  };
}

test("proven leaf identity without selected array does not throw", () => {
  assert.doesNotThrow(() => {
    const tree = buildErpOutlineTree([
      treeSource("Leaf", 100, "leaf-1", 0),
    ], { requireAmounts: false });
    assert.equal(tree.nodes[0].aggregation_grain.status, "PROVEN");
    assert.equal(tree.nodes[0].aggregation_grain.selected, undefined);
    assert.deepEqual(tree.nodes[0].immediate_children, []);
  });
});

test("leaf aggregation fails closed without an invented child sum", () => {
  const tree = buildErpOutlineTree([
    treeSource("Leaf", 100, "leaf-1", 0),
  ], { requireAmounts: false });
  assert.equal(tree.nodes[0].immediate_child_sum, null);
  assert.equal(tree.nodes[0].coverage.immediate_children_with_total, 0);
});

test("proven parent aggregation keeps existing child sum behavior", () => {
  const tree = buildErpOutlineTree([
    treeSource("Parent", 300, "parent-1", 0),
    treeSource("Child A", 100, "child-a", 1),
    treeSource("Child B", 200, "child-b", 1),
  ], { requireAmounts: false });
  const parent = tree.nodes[0];
  assert.equal(parent.aggregation_grain.status, "PROVEN");
  assert.equal(parent.aggregation_grain.selected.length, 2);
  assert.equal(parent.immediate_child_sum, 300);
  assert.equal(parent.hierarchy_status, "PASS");
});
