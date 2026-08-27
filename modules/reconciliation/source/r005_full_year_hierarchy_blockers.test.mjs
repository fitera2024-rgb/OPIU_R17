import assert from "node:assert/strict";
import test from "node:test";

import {
  buildErpOutlineTree,
  resolveHierarchyNodeFromTrace,
} from "./hierarchy_tree.mjs";
import { buildStructuralControlInventoryV3 } from "./structural_control_inventory_v3.mjs";

const SOURCE_SHA = "F".repeat(64);

function sourceRow({ row, label, level, amount, dimensionKey, identity, aggregationContract, compositionKey = "" }) {
  return {
    label,
    outlineLevel: level,
    amount,
    identity,
    source_identity_scope: `${SOURCE_SHA}|Лист_1|2025-10`,
    dimension_key: dimensionKey,
    dimension_identity_status: "PROVEN_ROLE_BOUND",
    dimension_roles: { organization: ["9 Управляющая компания"], cfo: [], department: [] },
    source_row_role: level === 0 ? "SUMMARY" : "ARTICLE",
    aggregation_contract: aggregationContract,
    composition_grain_key: compositionKey,
    aggregation_grain_key: compositionKey,
    source_file: "erp-opiu.xlsx",
    sheet: "Лист_1",
    row,
    source_cell: `L${row}`,
    sha256: SOURCE_SHA,
    period: "2025-10",
  };
}

function compact(tree) {
  return {
    schema: tree.schema,
    status: tree.status,
    node_count: tree.nodes.length,
    root_node_ids: [...tree.roots],
    blockers: tree.blockers.map((item) => ({ ...item })),
    nodes: tree.nodes.map((node) => ({
      ...node,
      parent_node_id: node.parent_id ?? "",
    })),
  };
}

function inventoryInput(tree) {
  return {
    runId: "run-2025-10",
    contextId: "context-2025-10",
    organization: {
      id: "ORG-9-UK",
      name: "9 Управляющая компания",
      path: "Холдинг / 9 Управляющая компания",
    },
    period: "2025-10",
    deferCurrentRunProvenance: true,
    hierarchyPeriods: [{
      period: "2025-10",
      status: "PASS",
      source_hierarchy_status: "PASS",
      intalev_hierarchy_status: "PROVEN",
      intalev_tree: tree,
      erp_tree: tree,
    }],
  };
}

test("different ERP physical rows on the same presentation path are not duplicate node identities", () => {
  const tree = buildErpOutlineTree([
    sourceRow({
      row: 199,
      label: "Прочие внереализационные доходы",
      level: 0,
      amount: 0,
      dimensionKey: "ORG:9|ROLE:SUMMARY",
      identity: `${SOURCE_SHA}|Лист_1|199`,
      aggregationContract: "UNPROVEN",
    }),
    sourceRow({
      row: 200,
      label: "Прочие внереализационные доходы",
      level: 0,
      amount: 0,
      dimensionKey: "ORG:9|ROLE:ARTICLE",
      identity: `${SOURCE_SHA}|Лист_1|200`,
      aggregationContract: "UNPROVEN",
    }),
  ], { requireSourceTrace: true });

  assert.equal(tree.status, "PASS");
  assert.equal(tree.nodes.length, 2);
  assert.equal(new Set(tree.nodes.map((node) => node.node_id)).size, 2);
  assert.equal(tree.blockers.some((item) => item.code === "DUPLICATE_NODE_IDENTITY"), false);
  assert.deepEqual(tree.nodes.map((node) => node.dimension_key), [
    "ORG:9|ROLE:SUMMARY",
    "ORG:9|ROLE:ARTICLE",
  ]);
});

test("a forged repeated exact physical source identity remains blocked", () => {
  const repeated = sourceRow({
    row: 199,
    label: "Прочие внереализационные доходы",
    level: 0,
    amount: 0,
    dimensionKey: "ORG:9|ROLE:SUMMARY",
    identity: `${SOURCE_SHA}|Лист_1|199`,
    aggregationContract: "UNPROVEN",
  });
  const tree = buildErpOutlineTree([repeated, { ...repeated }], { requireSourceTrace: true });

  assert.equal(tree.status, "BLOCKED");
  assert.equal(tree.blockers.some((item) => item.code === "DUPLICATE_NODE_IDENTITY"), true);
});

test("exact source trace selects one physical node even when presentation paths coincide", () => {
  const rows = [199, 200].map((row) => sourceRow({
    row,
    label: "Прочие внереализационные доходы",
    level: 0,
    amount: 0,
    dimensionKey: `ORG:9|ROW:${row}`,
    identity: `${SOURCE_SHA}|Лист_1|${row}`,
    aggregationContract: "UNPROVEN",
  })).map((row) => ({ ...row, full_path: "Прочие внереализационные доходы" }));
  const tree = buildErpOutlineTree(rows, { requireSourceTrace: true });
  const binding = resolveHierarchyNodeFromTrace({ trace: [rows[1]] }, tree);

  assert.equal(binding.status, "PROVEN_EXACT_SOURCE_TRACE");
  assert.equal(binding.node_id, tree.nodes[1].node_id);
  assert.deepEqual(binding.candidate_node_ids, [tree.nodes[1].node_id]);
  assert.equal(binding.correction_authority, false);
});

test("an unproven presentation aggregation contract is review-only, not a false additive mismatch", () => {
  const tree = buildErpOutlineTree([
    sourceRow({
      row: 182,
      label: "Расходы по финансовой деятельности",
      level: 0,
      amount: 15303428.26,
      dimensionKey: "ORG:9|ROLE:SUMMARY",
      identity: `${SOURCE_SHA}|Лист_1|182`,
      aggregationContract: "UNPROVEN",
    }),
    sourceRow({
      row: 183,
      label: "Административные расходы",
      level: 1,
      amount: 15283805.26,
      dimensionKey: "ORG:9|ROLE:ARTICLE",
      identity: `${SOURCE_SHA}|Лист_1|183`,
      aggregationContract: "UNPROVEN",
    }),
  ], { requireSourceTrace: true });

  assert.equal(tree.status, "PASS");
  assert.equal(tree.blockers.some((item) => item.code === "PARENT_DETAIL_MISMATCH"), false);
  assert.equal(tree.nodes[0].aggregation_contract, "UNPROVEN");
  assert.equal(tree.nodes[0].aggregation_contract_status, "REVIEW_ONLY");
  assert.equal(tree.nodes[0].hierarchy_status, "REVIEW_ONLY_AGGREGATION_CONTRACT");
  assert.equal(tree.nodes[0].correction_authority, false);
});

test("an explicit ADDITIVE_CHILDREN mismatch still blocks", () => {
  const tree = buildErpOutlineTree([
    sourceRow({
      row: 10,
      label: "Explicit additive parent",
      level: 0,
      amount: 100,
      dimensionKey: "ORG:9|ROLE:SUMMARY",
      identity: `${SOURCE_SHA}|Лист_1|10`,
      aggregationContract: "ADDITIVE_CHILDREN",
      compositionKey: "ERP:EXACT-ADDITIVE-GRAIN-10",
    }),
    sourceRow({
      row: 11,
      label: "Explicit additive child",
      level: 1,
      amount: 90,
      dimensionKey: "ORG:9|ROLE:ARTICLE",
      identity: `${SOURCE_SHA}|Лист_1|11`,
      aggregationContract: "ADDITIVE_CHILDREN",
      compositionKey: "ERP:EXACT-ADDITIVE-GRAIN-10",
    }),
  ], { requireSourceTrace: true });

  assert.equal(tree.status, "BLOCKED");
  assert.equal(tree.blockers.some((item) => item.code === "PARENT_DETAIL_MISMATCH"), true);
});

test("structural inventory emits exact group candidates without declaring raw roots to be business blocks", () => {
  const tree = buildErpOutlineTree([
    {
      ...sourceRow({
        row: 84,
        label: "ОПИУ глобальный итог",
        level: 0,
        amount: 100,
        dimensionKey: "ORG:9|ROLE:CALCULATED",
        identity: `${SOURCE_SHA}|Лист_1|84`,
        aggregationContract: "UNPROVEN",
      }),
      semantic_type: "CALCULATED_RESULT",
      semantic_type_status: "PROVEN_SOURCE_EXPLICIT",
    },
    {
      ...sourceRow({
        row: 99,
        label: "Административные расходы",
        level: 1,
        amount: 100,
        dimensionKey: "ORG:9|ROLE:SUMMARY",
        identity: `${SOURCE_SHA}|Лист_1|99`,
        aggregationContract: "UNPROVEN",
      }),
      is_group: true,
      semantic_type: "BUSINESS_BLOCK",
      semantic_type_status: "PROVEN_SOURCE_EXPLICIT",
    },
  ], { requireSourceTrace: true });
  const result = buildStructuralControlInventoryV3(inventoryInput(compact(tree)));

  assert.equal(result.status, "ELIGIBLE_PENDING_CURRENT_RUN_PROVENANCE");
  assert.deepEqual(result.inventory.erp_members.map((item) => item.identity), [tree.nodes[1].node_id]);
  assert.equal(result.inventory.erp_members.every((item) => item.selectable_root === false), true);
  assert.equal(result.inventory.erp_members.every((item) => item.candidate_selectable === true), true);
  assert.equal(result.inventory.erp_members.every((item) => item.business_block_declared === false), true);
  assert.equal(result.inventory.erp_members.every((item) => item.semantic_status === "BUSINESS_BLOCK_UNPROVEN"), true);
  assert.equal(result.inventory.erp_members.every((item) => item.requires_user_declaration === true), true);
  assert.equal(result.inventory.erp_members[0].parent_identity, tree.nodes[0].node_id);
});

test("an exact raw root is absent from the selectable candidate catalog", () => {
  const tree = buildErpOutlineTree([
    {
      ...sourceRow({
        row: 84,
        label: "ОПИУ глобальный итог",
        level: 0,
        amount: 100,
        dimensionKey: "ORG:9|ROLE:CALCULATED",
        identity: `${SOURCE_SHA}|Лист_1|84`,
        aggregationContract: "UNPROVEN",
      }),
      semantic_type: "CALCULATED_RESULT",
      semantic_type_status: "PROVEN_SOURCE_EXPLICIT",
    },
  ], { requireSourceTrace: true });
  const result = buildStructuralControlInventoryV3(inventoryInput(compact(tree)));

  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.inventory.erp_members, []);
  assert.equal(
    result.inventory.blockers.some((item) => item.code === "STRUCTURAL_INVENTORY_SOURCE_HIERARCHY_CANDIDATES_MISSING"),
    true,
  );
});
