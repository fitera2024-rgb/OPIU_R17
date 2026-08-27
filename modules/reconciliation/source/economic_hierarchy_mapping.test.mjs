import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTemplateRowsToTrees,
  buildErpOutlineTree,
  buildIntalevParentTree,
} from "./hierarchy_tree.mjs";
import {
  MAPPING_SCHEMA,
  resolveEconomicHierarchyRelationship,
  validateEconomicHierarchyMapping,
} from "./economic_hierarchy_mapping.mjs";

const intalevRows = [
  { uuid: "I-ROOT", name: "Расходы", full_path: "Расходы", amount: 100 },
  { uuid: "I-R002", parent_uuid: "I-ROOT", name: "ФЗП", full_path: "Расходы / ФЗП", amount: 100 },
];

function intalevTree() {
  return buildIntalevParentTree(intalevRows, {
    requireIdentity: true,
    parentIdentityOnly: true,
    requireAmounts: false,
  });
}

function erpTree(parent = "ERP root") {
  return buildErpOutlineTree([
    { label: "ERP root", full_path: "ERP root", outline_level: 0, amount: 100 },
    ...(parent === "ERP root"
      ? [{ label: "ФЗП", full_path: "ERP root / ФЗП", outline_level: 1, amount: 100 }]
      : []),
    ...(parent === "Other ERP"
      ? [
          { label: "Other ERP", full_path: "Other ERP", outline_level: 0, amount: 100 },
          { label: "ФЗП", full_path: "Other ERP / ФЗП", outline_level: 1, amount: 100 },
        ]
      : []),
  ], { requireAmounts: false });
}

function rows({ differentPresentationParent = false, postingParent = "" } = {}) {
  return [{
    code: "REL-1",
    economic_relationship_key: "explicit-rel-1",
    intalev_node_path: "Расходы / ФЗП",
    erp_node_path: differentPresentationParent ? "Other ERP / ФЗП" : "ERP root / ФЗП",
    amount: 100,
    posting_parent: postingParent,
    posting_parent_proven: Boolean(postingParent),
  }];
}

function mappingFor({ differentPresentationParent = false, contradiction = false } = {}) {
  const erp = erpTree(differentPresentationParent ? "Other ERP" : "ERP root");
  const intalev = intalevTree();
  const erpNode = erp.nodes.find((node) => node.full_path.endsWith("/ ФЗП"));
  const intalevNode = intalev.nodes.find((node) => node.full_path === "Расходы / ФЗП");
  return {
    schema: MAPPING_SCHEMA,
    entries: [{
      mapping_id: "MAP-1",
      relationship_key: "explicit-rel-1",
      economic_parent: "ECONOMIC:PAYROLL",
      erp_parent_node_id: contradiction ? "ERP:unexpected-parent" : erpNode.parent_id,
      intalev_parent_node_id: intalevNode.parent_id,
      proof: { status: "PROVEN", source: "fixture-explicit-proof" },
    }],
  };
}

function bindCase(options = {}, mapping = null) {
  const erp = erpTree(options.differentPresentationParent ? "Other ERP" : "ERP root");
  return bindTemplateRowsToTrees(rows(options), {
    erpTree: erp,
    intalevTree: intalevTree(),
    economicHierarchyMapping: mapping,
  }).rows[0];
}

test("presentation parents are retained separately and do not form an economic blocker", () => {
  const row = resolveEconomicHierarchyRelationship({
    row: { economic_relationship_key: "explicit-rel-1" },
    erp: {
      mapped: true,
      parent_code: "ERP-PARENT",
      parent_node_id: "ERP:parent",
    },
    intalev: {
      mapped: true,
      parent_code: "INTALEV-PARENT",
      parent_node_id: "INTALEV:parent",
    },
    mapping: {
      ...mappingFor({ differentPresentationParent: true }),
      entries: [{
        ...mappingFor({ differentPresentationParent: true }).entries[0],
        erp_parent_node_id: "ERP:parent",
        intalev_parent_node_id: "INTALEV:parent",
      }],
    },
  });
  assert.equal(row.erp_presentation_parent, "ERP-PARENT");
  assert.equal(row.intalev_presentation_parent, "INTALEV-PARENT");
  assert.equal(row.presentation_parent_match, false);
  assert.equal(row.economic_parent, "ECONOMIC:PAYROLL");
  assert.equal(row.economic_parent_proven, true);
  assert.equal(row.economic_parent_match, true);
  assert.equal(row.evidence_category, "ECONOMIC_MAPPING_OVERRIDES_PRESENTATION_DIFFERENCE");
  assert.equal(row.evidence_severity, "INFO");
  assert.equal(row.correction_authority, false);
});

test("same presentation parent without an explicit mapping is review-only", () => {
  const row = bindCase();
  assert.equal(row.presentation_parent_match, true);
  assert.equal(row.economic_parent, "");
  assert.equal(row.economic_parent_proven, false);
  assert.equal(row.economic_parent_match, false);
  assert.equal(row.evidence_category, "MISSING_ECONOMIC_MAPPING");
  assert.equal(row.evidence_status, "REVIEW_ONLY");
  assert.equal(row.erp_binding_status, "UNPROVEN");
  assert.equal(row.hierarchy_status, "LEAF");
  assert.equal(row.correction_authority, false);
});

test("explicit economic mapping proves equivalence deterministically", () => {
  const row = bindCase({}, mappingFor());
  assert.equal(row.economic_parent_proven, true);
  assert.equal(row.economic_parent_match, true);
  assert.equal(row.evidence_status, "PASS");
  assert.equal(row.erp_binding_status, "PROVEN");
  assert.equal(row.correction_authority, false);
});

test("explicit mapping contradiction remains blocked", () => {
  const row = bindCase({}, mappingFor({ contradiction: true }));
  assert.equal(row.evidence_category, "EXPLICIT_MAPPING_CONTRADICTION");
  assert.equal(row.evidence_severity, "BLOCKED");
  assert.equal(row.economic_parent_match, false);
  assert.equal(row.erp_binding_status, "MISMATCH");
  assert.equal(row.hierarchy_status, "BLOCKED_TEMPLATE_CATALOG_MISMATCH");
});

test("equal amount and equal R-code do not prove economic parent", () => {
  const row = bindCase();
  assert.equal(row.economic_parent_proven, false);
  assert.equal(row.evidence_status, "REVIEW_ONLY");
  assert.equal(row.correction_authority, false);
});

test("posting parent is independent evidence and never inferred from presentation", () => {
  const row = bindCase({ postingParent: "POSTING:26" });
  assert.equal(row.posting_parent, "POSTING:26");
  assert.equal(row.posting_parent_proven, true);
  assert.equal(row.presentation_parent, "");
  assert.equal(row.hierarchy_status, "LEAF");
});

test("mapping contract rejects fabricated or ambiguous proof", () => {
  assert.equal(validateEconomicHierarchyMapping(null).status, "REVIEW_ONLY");
  assert.equal(validateEconomicHierarchyMapping({ schema: MAPPING_SCHEMA, entries: [
    { relationship_key: "x", economic_parent: "E", erp_parent_node_id: "ERP:P", intalev_parent_node_id: "I:P" },
  ] }).status, "REVIEW_ONLY");
  assert.equal(validateEconomicHierarchyMapping({ schema: MAPPING_SCHEMA, entries: [
    { relationship_key: "x", economic_parent: "E", erp_parent_node_id: "ERP:P", intalev_parent_node_id: "I:P", proof: { status: "PROVEN", source: "s" } },
    { relationship_key: "x", economic_parent: "E", erp_parent_node_id: "ERP:P", intalev_parent_node_id: "I:P", proof: { status: "PROVEN", source: "s" } },
  ] }).reason, "MAPPING_KEY_AMBIGUOUS");
});
