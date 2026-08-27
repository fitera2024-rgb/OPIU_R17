import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateSide,
  applyVisibleHierarchyGroupRollups,
  calculateVisibleGroupDeltaResiduals,
} from "./opiu_reconcile.mjs";

function row(code, parent, depth, intalev, erp, hierarchy = {}) {
  return {
    code,
    presentation_parent_code: parent,
    presentation_depth: depth,
    intalev: { trace: [], ...intalev },
    erp: { trace: [], ...erp },
    intalev_hierarchy: hierarchy.intalev ?? null,
    erp_hierarchy: hierarchy.erp ?? null,
  };
}

test("missing ERP group total is collected from the same visible Intalev children", () => {
  const source = [
    row("R002", "R001", 1, { amount: 116060.58, status: "MATCHED" }, { amount: null, status: "BLOCKED_CATALOG_DESCENDANT_SOURCE" }),
    row("R006", "R002", 2, { amount: 16120.42, status: "MATCHED" }, { amount: 16120.42, status: "MATCHED" }),
    row("R008", "R002", 2, { amount: 26504, status: "MATCHED" }, { amount: 37930, status: "MATCHED" }),
    row("R009", "R002", 2, { amount: 73436.16, status: "MATCHED" }, { amount: 73436.16, status: "MATCHED" }),
  ];
  const result = applyVisibleHierarchyGroupRollups(source);
  const group = result.rows.find((item) => item.code === "R002");

  assert.equal(group.erp.amount, 127486.58);
  assert.equal(group.erp.status, "PRESENTATION_GROUP_ROLLUP");
  assert.equal(group.erp.presentation_group_rollup.basis, "DIRECT_VISIBLE_CHILDREN_SUM");
  assert.deepEqual(group.erp.presentation_group_rollup.child_codes, ["R006", "R008", "R009"]);
  assert.equal(group.erp.presentation_group_rollup.correction_authority, false);
  assert.equal(group.erp.presentation_group_rollup.posting_rows, 0);
  assert.equal(Number((group.intalev.amount - group.erp.amount).toFixed(2)), -11426);
});

test("exact source node total is preferred to an incomplete visible display branch", () => {
  const source = [
    row(
      "R012",
      "R001",
      1,
      { amount: null, status: "AMBIGUOUS" },
      { amount: null, status: "MISSING" },
      { intalev: { mapped: true, direct_total: 27878.05 } },
    ),
    row("R013", "R012", 2, { amount: 22936.05, status: "MATCHED" }, { amount: 42632.1, status: "MATCHED" }),
    row("R016", "R012", 2, { amount: 1942, status: "MATCHED" }, { amount: 3182, status: "MATCHED" }),
  ];
  const result = applyVisibleHierarchyGroupRollups(source);
  const group = result.rows.find((item) => item.code === "R012");

  assert.equal(group.intalev.amount, 27878.05);
  assert.equal(group.intalev.presentation_group_rollup.basis, "EXACT_SOURCE_NODE_TOTAL");
  assert.equal(group.intalev.presentation_group_rollup.visible_child_total, 24878.05);
});

test("existing group totals and missing leaf articles are not overwritten", () => {
  const source = [
    row("R001", "", 0, { amount: 100, status: "MATCHED" }, { amount: 90, status: "MATCHED" }),
    row("R002", "R001", 1, { amount: null, status: "MISSING" }, { amount: 90, status: "MATCHED" }),
  ];
  const result = applyVisibleHierarchyGroupRollups(source);
  assert.equal(result.rows[0].intalev.amount, 100);
  assert.equal(result.rows[0].erp.amount, 90);
  assert.equal(result.rows[1].intalev.amount, null);
  assert.equal(result.audits.length, 0);
});

test("monthly presentation rollup remains review-only after aggregation", () => {
  const monthly = {
    amount: 127486.58,
    status: "PRESENTATION_GROUP_ROLLUP",
    trace: [],
    presentation_group_rollup: {
      basis: "DIRECT_VISIBLE_CHILDREN_SUM",
      correction_authority: false,
      posting_rows: 0,
    },
  };
  const aggregate = aggregateSide([{ erp: monthly }], "erp");
  assert.equal(aggregate.amount, 127486.58);
  assert.equal(aggregate.status, "PRESENTATION_GROUP_ROLLUP");
  assert.equal(aggregate.presentation_group_rollups.length, 1);
  assert.equal(aggregate.presentation_group_rollups[0].correction_authority, false);
});

test("a non-zero parent delta is conserved as child deltas plus a visible residual", () => {
  const rows = [
    row("R001", "", 0, { amount: 1821209.67 }, { amount: 2431440.65 }),
    row("R002", "R001", 1, { amount: 116060.58 }, { amount: 127486.58 }),
    row("R011", "R001", 1, { amount: 307803.58 }, { amount: 1927755.16 }),
    row("R012", "R001", 1, { amount: null }, { amount: 45814.1 }),
  ];
  const [control] = calculateVisibleGroupDeltaResiduals(rows, 0.01);
  assert.equal(control.code, "R001");
  assert.equal(control.group_delta, -610230.98);
  assert.equal(control.known_child_delta_sum, -1631377.58);
  assert.equal(control.residual, 1021146.6);
  assert.deepEqual(control.incomplete_child_codes, ["R012"]);
  assert.equal(control.display_residual, true);
  assert.equal(control.correction_authority, false);
});
