import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTemplateRowsToTrees,
  buildErpOutlineTree,
  buildIntalevParentTree,
} from "./hierarchy_tree.mjs";

const INTALEV_ROWS = [
  { uuid: "I-R001", name: "Расходы", full_path: "Расходы", amount: 100 },
  {
    uuid: "I-R002",
    parent_uuid: "I-R001",
    name: "ФЗП",
    full_path: "Расходы / ФЗП",
    amount: 100,
  },
  { uuid: "I-R003", name: "Прочее", full_path: "Прочее", amount: 0 },
];

const TEMPLATE_ROWS = [
  {
    code: "R001",
    intalev_label: "Расходы",
    intalev_node_path: "Расходы",
    erp_label: "Расходы ERP",
    erp_node_path: "Расходы ERP",
    intalev: { amount: 100 },
    erp: { amount: 100 },
  },
  {
    code: "R002",
    intalev_label: "ФЗП",
    intalev_node_path: "Расходы / ФЗП",
    erp_label: "ФЗП",
    erp_node_path: "Расходы ERP / ФЗП",
    intalev: { amount: 100 },
    erp: { amount: 100 },
  },
  {
    code: "R003",
    intalev_label: "Прочее",
    intalev_node_path: "Прочее",
    erp_label: "Прочее ERP",
    erp_node_path: "Прочее ERP",
    intalev: { amount: 0 },
    erp: { amount: 0 },
  },
];

function intalevTree() {
  return buildIntalevParentTree(INTALEV_ROWS, {
    requireIdentity: true,
    parentIdentityOnly: true,
  });
}

function erpTree(parentForR002) {
  const underR001 = parentForR002 === "R001";
  return buildErpOutlineTree([
    {
      label: "Расходы ERP",
      full_path: "Расходы ERP",
      outlineLevel: 0,
      amount: underR001 ? 100 : 0,
    },
    ...(underR001
      ? [{ label: "ФЗП", full_path: "Расходы ERP / ФЗП", outlineLevel: 1, amount: 100 }]
      : []),
    {
      label: "Прочее ERP",
      full_path: "Прочее ERP",
      outlineLevel: 0,
      amount: underR001 ? 0 : 100,
    },
    ...(!underR001
      ? [{ label: "ФЗП", full_path: "Прочее ERP / ФЗП", outlineLevel: 1, amount: 100 }]
      : []),
  ]);
}

function bind(rows, tree) {
  return bindTemplateRowsToTrees(rows, {
    erpTree: tree,
    intalevTree: intalevTree(),
    canonicalSystem: "INTALEV",
  }).rows;
}

test("UNPROVEN ERP must not change Intalev parent or outline level", () => {
  const proven = bind(TEMPLATE_ROWS, erpTree("R001"));
  const unproven = bind(
    TEMPLATE_ROWS.map((row) =>
      row.code === "R002"
        ? { ...row, erp_node_path: "Нет такого пути / ФЗП" }
        : row,
    ),
    erpTree("R001"),
  );
  const mismatch = bind(
    TEMPLATE_ROWS.map((row) =>
      row.code === "R002"
        ? { ...row, erp_node_path: "Прочее ERP / ФЗП" }
        : row,
    ),
    erpTree("R003"),
  );

  const pickR002 = (rows) => rows.find((row) => row.code === "R002");
  const variants = [pickR002(proven), pickR002(unproven), pickR002(mismatch)];

  assert.deepEqual(
    variants.map((row) => ({
      parent: row.hierarchy_parent_code,
      level: row.hierarchy_level,
      path: row.hierarchy_path,
      intalevAmount: row.intalev.amount,
      erpAmount: row.erp.amount,
    })),
    Array(3).fill({
      parent: "R001",
      level: 1,
      path: ["Расходы", "ФЗП"],
      intalevAmount: 100,
      erpAmount: 100,
    }),
  );
  assert.deepEqual(
    variants.map((row) => row.intalev_hierarchy_status),
    ["PROVEN", "PROVEN", "PROVEN"],
  );
  assert.deepEqual(
    variants.map((row) => row.erp_binding_status),
    ["UNPROVEN", "UNPROVEN", "UNPROVEN"],
  );
  assert.deepEqual(
    variants.map((row) => row.hierarchy_status),
    ["LEAF", "BLOCKED_TEMPLATE_CATALOG_MISMATCH", "LEAF"],
  );
});
