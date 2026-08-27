import assert from "node:assert/strict";
import test from "node:test";

import { bindStructuralControlGroupsToCurrentHierarchies } from "./structural_control_current_hierarchy_binding.mjs";

const group = Object.freeze({
  id: "SET-1", organization: "ORG-TEST", reconciliation_organization: "ORG-TEST",
  reconciliation_organization_id: "ORG-TEST", enabled: true, mode: "SUM_DELTA_ONLY",
  tolerance: 0.01, expected_control_delta: 0,
  member_codes: [], intalev_member_codes: [], erp_member_codes: [],
  intalev_member_bindings: [{ code: "", hierarchy_path: "ОПИУ / Финансы", origin_identity: "I-OLD", origin_inventory_id: "INV-OLD" }],
  erp_member_bindings: [{ code: "", hierarchy_path: "ERP / Внереализационные", origin_identity: "E-OLD", origin_inventory_id: "INV-OLD" }],
});

function month(intalevNodes, erpNodes, rows = []) {
  return [{ period: "2025-11", rows,
    intalev_hierarchy_tree: { status: "PASS", nodes: intalevNodes },
    erp_hierarchy_tree: { status: "PASS", nodes: erpNodes } }];
}

const exactRows = Object.freeze([
  {
    code: "R045", hierarchy_node_id: "I-CURRENT", hierarchy_path: ["ОПИУ", "Финансы"],
    intalev_hierarchy: { mapped: true, node_id: "I-CURRENT" },
    presentation_structural_proof: { status: "PROVEN_LIVE_INTALEV", node_id: "I-CURRENT", path: ["ОПИУ", "Финансы"], erp_used: false },
    intalev_amount: 45,
    erp_label: "Другая ветка", erp_amount: 1,
    erp_presentation_parent_node_id: "E-ROOT", erp: { trace: [{ full_path: "ERP / Другая ветка" }] },
  },
  {
    code: "R055", hierarchy_node_id: "I-OTHER", hierarchy_path: ["ОПИУ", "Другая ветка"],
    intalev_hierarchy: { mapped: true, node_id: "I-OTHER" },
    presentation_structural_proof: { status: "PROVEN_LIVE_INTALEV", node_id: "I-OTHER", path: ["ОПИУ", "Другая ветка"], erp_used: false },
    intalev_amount: 55,
    erp_label: "Внереализационные", erp_amount: 55,
    erp_presentation_parent_node_id: "E-ROOT", erp: { trace: [{ full_path: "ERP / Внереализационные" }] },
  },
]);

test("empty-code inventory selectors bind by origin identity+exact path and derive current R codes from exact side row nodes", () => {
  const result = bindStructuralControlGroupsToCurrentHierarchies([group], month(
    [{ node_id: "I-CURRENT", is_group: true, code: "", full_path: "ОПИУ / Финансы" }, { node_id: "I-OTHER", is_group: true, code: "R045", full_path: "ОПИУ / Другая ветка" }],
    [{ node_id: "E-CURRENT", is_group: true, parent_id: "E-ROOT", code: "", label: "Внереализационные", direct_total: 55, full_path: "ERP / Внереализационные" }, { node_id: "E-OTHER", is_group: true, parent_id: "E-ROOT", code: "R055", label: "Другая ветка", direct_total: 1, full_path: "ERP / Другая ветка" }], exactRows));
  assert.equal(result.audit.status, "ACTIVE_UI_FIXED_SELECTORS_BOUND_TO_CURRENT_HIERARCHIES");
  assert.equal(result.audit.bindings[0].intalev[0].current_node_id, "I-CURRENT");
  assert.equal(result.audit.bindings[0].intalev[0].origin_identity, "I-OLD");
  assert.equal(result.audit.bindings[0].intalev[0].current_row_code, "R045");
  assert.equal(result.audit.bindings[0].erp[0].current_node_id, "E-CURRENT");
  assert.equal(result.audit.bindings[0].erp[0].current_row_code, "R055");
  assert.deepEqual(result.groups[0].intalev_member_codes, ["R045"]);
  assert.deepEqual(result.groups[0].erp_member_codes, ["R055"]);
  assert.deepEqual(result.groups[0].member_codes, ["R045", "R055"]);
  assert.equal(result.audit.bindings[0].descendant_internal_checks_active, true);
  assert.equal(result.audit.financial_rows, 0); assert.equal(result.audit.posting_rows, 0);
});

test("typed selectors fail closed on missing/ambiguous path and non-bijective current row references", () => {
  const exactIntalev = [{ node_id: "I-CURRENT", is_group: true, code: "", full_path: "ОПИУ / Финансы" }];
  const exactERP = [{ node_id: "E-CURRENT", is_group: true, parent_id: "E-ROOT", code: "", label: "Внереализационные", direct_total: 55, full_path: "ERP / Внереализационные" }];
  const otherIntalev = { node_id: "I-OTHER", is_group: true, full_path: "ОПИУ / Другая ветка" };
  const otherERP = { node_id: "E-OTHER", is_group: true, parent_id: "E-ROOT", label: "Другая ветка", direct_total: 1, full_path: "ERP / Другая ветка" };
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([group], month([], [...exactERP, otherERP], exactRows)), /SELECTOR_NOT_FOUND/);
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([group], month([...exactIntalev, otherIntalev, { ...exactIntalev[0], node_id: "I2" }], [...exactERP, otherERP], exactRows)), /SELECTOR_AMBIGUOUS/);
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([group], month([...exactIntalev, otherIntalev], [...exactERP, otherERP], [...exactRows, { ...exactRows[0], code: "R046" }])), /ROW_REFERENCE_NOT_FOUND/);
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([group], month([...exactIntalev, otherIntalev], [...exactERP, otherERP], exactRows.filter((row) => row.code !== "R045"))), /ROW_REFERENCE_NOT_FOUND/);
});

test("optional origin code is only a consistency check and side swaps fail closed", () => {
  const coded = { ...group, intalev_member_bindings: [{ ...group.intalev_member_bindings[0], code: "R099" }] };
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([coded], month(
    [{ node_id: "I-CURRENT", is_group: true, code: "", full_path: "ОПИУ / Финансы" }, { node_id: "I-OTHER", is_group: true, full_path: "ОПИУ / Другая ветка" }],
    [{ node_id: "E-CURRENT", is_group: true, parent_id: "E-ROOT", code: "", label: "Внереализационные", direct_total: 55, full_path: "ERP / Внереализационные" }, { node_id: "E-OTHER", is_group: true, parent_id: "E-ROOT", label: "Другая ветка", direct_total: 1, full_path: "ERP / Другая ветка" }], exactRows)), /ORIGIN_CODE_DRIFT/);
  assert.throws(() => bindStructuralControlGroupsToCurrentHierarchies([group], month(
    [{ node_id: "E-CURRENT", code: "", full_path: "ERP / Внереализационные" }],
    [{ node_id: "I-CURRENT", code: "", full_path: "ОПИУ / Финансы" }], exactRows)), /SELECTOR_NOT_FOUND/);
});
