import assert from "node:assert/strict";
import test from "node:test";
import { buildIntalevParentTree } from "./hierarchy_tree.mjs";
import { detectIntalevCatalogHeaders } from "./intalev_catalog_parser.mjs";

const options = { requireAmounts: false, requireIdentity: true, parentIdentityOnly: true };

function blockerCodes(tree) {
  return tree.blockers.map((blocker) => blocker.code);
}

test("normal UUID hierarchy uses authoritative paths and derives missing paths", () => {
  const tree = buildIntalevParentTree([
    { uuid: "ROOT", name: "Расходы", full_path: "Расходы" },
    { uuid: "GROUP", parent_uuid: "ROOT", name: "Персонал", full_path: "Расходы / Персонал" },
    { uuid: "LEAF", parent_uuid: "GROUP", name: "ФЗП", full_path: "" },
  ], options);
  assert.equal(tree.status, "PASS");
  const leaf = tree.nodes.find((node) => node.uuid === "LEAF");
  assert.equal(leaf.full_path, "Расходы / Персонал / ФЗП");
  assert.equal(leaf.depth, 2);
  assert.equal(leaf.root_uuid, "ROOT");
  assert.equal(leaf.is_leaf, true);
  assert.equal(leaf.validation_status, "VALID");
});

test("report parent_path is resolved through the path index, not the UUID index", () => {
  const tree = buildIntalevParentTree([
    {
      identity: "SOURCE|TDSheet|11",
      label: "Расходы",
      full_path: "Расходы",
      parent_path: "",
      amount: 100,
    },
    {
      identity: "SOURCE|TDSheet|12",
      label: "Персонал",
      full_path: "Расходы / Персонал",
      parent_path: "Расходы",
      amount: 100,
    },
    {
      identity: "SOURCE|TDSheet|13",
      label: "ФЗП",
      full_path: "Расходы / Персонал / ФЗП",
      parent_path: "Расходы / Персонал",
      amount: 100,
    },
  ], {
    ...options,
    requireNonFlat: true,
  });

  const root = tree.nodes.find((node) => node.label === "Расходы");
  const group = tree.nodes.find((node) => node.label === "Персонал");
  const leaf = tree.nodes.find((node) => node.label === "ФЗП");
  assert.equal(group.parent_id, root.node_id);
  assert.equal(leaf.parent_id, group.node_id);
  assert.equal(group.level, 1);
  assert.equal(leaf.level, 2);
  assert.deepEqual(blockerCodes(tree), []);
});

test("orphan parent UUID and unresolved full path are explicit", () => {
  const tree = buildIntalevParentTree([
    { uuid: "LEAF", parent_uuid: "MISSING", name: "ФЗП", full_path: "" },
  ], options);
  assert.deepEqual(blockerCodes(tree), ["ORPHAN_NODE", "UNRESOLVED_FULL_PATH"]);
  assert.equal(tree.nodes[0].validation_status, "UNRESOLVED");
});

test("UUID mode does not infer a missing parent from ПолныйПуть", () => {
  const tree = buildIntalevParentTree([
    { uuid: "ROOT", name: "Root", full_path: "Root" },
    { uuid: "LEAF", name: "Leaf", full_path: "Root / Leaf" },
  ], options);
  const leaf = tree.nodes.find((node) => node.uuid === "LEAF");
  assert.equal(leaf.parent_id, null);
  assert.ok(blockerCodes(tree).includes("FULL_PATH_PARENT_MISMATCH"));
});

test("missing UUID is explicit", () => {
  const tree = buildIntalevParentTree([{ name: "Root", full_path: "Root" }], options);
  assert.deepEqual(blockerCodes(tree), ["MISSING_UUID"]);
});

test("duplicate UUID is explicit", () => {
  const tree = buildIntalevParentTree([
    { uuid: "DUP", name: "A", full_path: "A" },
    { uuid: "DUP", name: "B", full_path: "B" },
  ], options);
  assert.ok(blockerCodes(tree).includes("DUPLICATE_UUID"));
});

test("self-parent is not downgraded to orphan", () => {
  const tree = buildIntalevParentTree([
    { uuid: "SELF", parent_uuid: "SELF", name: "A", full_path: "A" },
  ], options);
  assert.deepEqual(blockerCodes(tree), ["SELF_PARENT"]);
});

test("cycle is explicit", () => {
  const tree = buildIntalevParentTree([
    { uuid: "A", parent_uuid: "B", name: "A", full_path: "" },
    { uuid: "B", parent_uuid: "A", name: "B", full_path: "" },
  ], options);
  assert.ok(blockerCodes(tree).includes("CYCLE_DETECTED"));
});

test("authoritative full path conflicting with UUID tree is preserved and blocked", () => {
  const tree = buildIntalevParentTree([
    { uuid: "ROOT", name: "Root", full_path: "Root" },
    { uuid: "LEAF", parent_uuid: "ROOT", name: "Leaf", full_path: "Other / Leaf" },
  ], options);
  const leaf = tree.nodes.find((node) => node.uuid === "LEAF");
  assert.equal(leaf.full_path, "Other / Leaf");
  assert.ok(blockerCodes(tree).includes("FULL_PATH_PARENT_MISMATCH"));
});

test("broken path and ambiguous node are explicit", () => {
  const tree = buildIntalevParentTree([
    { uuid: "A", name: "First", full_path: "Shared / Wrong" },
    { uuid: "B", name: "Second", full_path: "Shared / Wrong" },
  ], options);
  assert.ok(blockerCodes(tree).includes("AMBIGUOUS_NODE"));
  assert.ok(blockerCodes(tree).includes("BROKEN_PATH"));
});

test("UUID and legacy headers remain supported", () => {
  const uuid = detectIntalevCatalogHeaders([
    ["UUID", "UUIDРодителя", "Наименование", "ПолныйПуть"],
  ]);
  assert.equal(uuid.format, "UUID");
  assert.deepEqual(uuid.columns, {
    uuid: 0,
    parent_uuid: 1,
    name: 2,
    full_path: 3,
    deletion_mark: null,
    is_group: null,
    code: null,
    order: null,
    kind: null,
    formula: null,
  });

  const legacy = detectIntalevCatalogHeaders([
    ["Ссылка", "Родитель", "Объект.Наименование", "Полный путь", "Объект.Код"],
  ]);
  assert.equal(legacy.format, "LEGACY");
  assert.equal(legacy.columns.uuid, 0);
  assert.equal(legacy.columns.parent_uuid, 1);
  assert.equal(legacy.columns.name, 2);
  assert.equal(legacy.columns.full_path, 3);
  assert.equal(legacy.columns.code, 4);
});
