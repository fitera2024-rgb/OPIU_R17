import assert from "node:assert/strict";
import test from "node:test";
import { buildIntalevParentTree } from "./hierarchy_tree.mjs";
import { advanceIntalevOutlinePath } from "./intalev_outline_path.mjs";

function sourceRow(stack, row, level, label, amount = 1) {
  const identity = `SOURCE|TDSheet|${row}`;
  const outline = advanceIntalevOutlinePath(stack, {
    level,
    label,
    identity,
  });
  return {
    identity,
    parent_identity: outline.parentIdentity,
    label,
    path_parts: outline.pathParts,
    parent_path_parts: outline.parentPathParts,
    outline_gap_collapsed: outline.outlineGapCollapsed,
    amount,
    source_file: "intalev.xlsx",
    sheet: "TDSheet",
    row,
    source_cell: `E${row}`,
    sha256: "A".repeat(64),
    outline,
  };
}

test("collapses an Excel outline gap to the nearest physical ancestor", () => {
  const stack = [];
  const root = sourceRow(stack, 15, 0, "Выручка", 100);
  const child = sourceRow(stack, 16, 2, "Опт", 100);
  assert.equal(child.outline.parentIdentity, root.identity);
  assert.equal(child.outline.outlineGapCollapsed, true);
  assert.deepEqual(child.outline.pathParts, ["Выручка", "Опт"]);

  const tree = buildIntalevParentTree([root, child], {
    expectedSha256: "A".repeat(64),
    requireSourceTrace: true,
    requireNonFlat: true,
  });
  assert.equal(tree.status, "PASS");
  assert.deepEqual(tree.blockers, []);
  const childNode = tree.nodes.find((node) => node.source_identity === child.identity);
  const rootNode = tree.nodes.find((node) => node.source_identity === root.identity);
  assert.equal(childNode.parent_id, rootNode.node_id);
  assert.equal(childNode.full_path, "Выручка / Опт");
  assert.equal(childNode.outline_gap_collapsed, true);
});

test("keeps a slash and an explicit blank article as atomic path segments", () => {
  const stack = [];
  const root = sourceRow(stack, 116, 0, "Расходы ИТ", 10);
  const blank = sourceRow(stack, 118, 4, "<пустое значение>", 10);
  const leaf = sourceRow(
    stack,
    119,
    5,
    "Контур.Edi / тариф Общий (для остальных ТС)",
    10,
  );
  assert.equal(blank.outline.parentIdentity, root.identity);
  assert.equal(blank.outline.outlineGapCollapsed, true);
  assert.deepEqual(leaf.outline.pathParts, [
    "Расходы ИТ",
    "<пустое значение>",
    "Контур.Edi / тариф Общий (для остальных ТС)",
  ]);

  const tree = buildIntalevParentTree([root, blank, leaf], {
    expectedSha256: "A".repeat(64),
    requireSourceTrace: true,
    requireNonFlat: true,
  });
  assert.equal(tree.status, "PASS");
  assert.deepEqual(tree.blockers, []);
  const leafNode = tree.nodes.find((node) => node.source_identity === leaf.identity);
  assert.equal(leafNode.label, "Контур.Edi / тариф Общий (для остальных ТС)");
  assert.equal(leafNode.level, 2);
});

test("keeps a leading nonzero outline level fail-closed", () => {
  const row = sourceRow([], 1, 3, "Сирота", 1);
  assert.equal(row.outline.missingParent, true);
  const tree = buildIntalevParentTree([row], {
    expectedSha256: "A".repeat(64),
    requireSourceTrace: true,
  });
  assert.equal(tree.status, "BLOCKED");
  assert.ok(tree.blockers.some((blocker) => blocker.code === "ORPHAN_NODE"));
});
