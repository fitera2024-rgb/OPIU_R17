import assert from "node:assert/strict";
import test from "node:test";

import { compactHierarchyTreeForCodex } from "./opiu_reconcile.mjs";


test("codex hierarchy keeps decision fields and removes repeated heavy trace", () => {
  const heavy = "X".repeat(2_000_000);
  const tree = {
    schema: "tree.v1",
    status: "PASS",
    period: "2025-10",
    node_count: 2,
    root_node_ids: ["N1"],
    level_counts: { 1: 1, 2: 1 },
    blockers: [],
    nodes: [
      {
        node_id: "N1",
        name: "Группа",
        full_path: "Группа",
        is_group: true,
        immediate_children: ["N2"],
        direct_total: 125,
        immediate_child_sum: 125,
        hierarchy_delta: 0,
        hierarchy_status: "PASS",
        source: { sheet: "ОПИУ", row: 8, source_cell: "D8", unused_payload: heavy },
        operation_rows: [{ payload: heavy }],
      },
      {
        node_id: "N2",
        parent_node_id: "N1",
        name: "",
        full_path: "Группа /",
        direct_total: 125,
        hierarchy_status: "LEAF",
        article_classification: "EMPTY",
        source_outline_level: 2,
        outline_gap_collapsed: true,
        raw_trace: heavy,
      },
    ],
    raw_workbook_trace: heavy,
  };

  const compact = compactHierarchyTreeForCodex(tree);
  assert.equal(compact.status, "PASS");
  assert.equal(compact.nodes.length, 2);
  assert.deepEqual(compact.nodes[0].immediate_children, ["N2"]);
  assert.equal(compact.nodes[0].source.sheet, "ОПИУ");
  assert.equal(compact.nodes[1].article_classification, "EMPTY");
  assert.equal(compact.nodes[1].outline_gap_collapsed, true);
  assert.equal(compact.codex_compaction.physical_operation_evidence_location, "operation_evidence");
  assert.equal(Object.hasOwn(compact.nodes[0], "operation_rows"), false);
  assert.equal(Object.hasOwn(compact.nodes[1], "raw_trace"), false);
  assert.ok(JSON.stringify(compact).length < 5_000);
});
