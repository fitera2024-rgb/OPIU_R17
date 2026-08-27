import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bindTemplateRowsToTrees,
  buildErpOutlineTree,
  buildIntalevParentTree,
  resolveHierarchyNodeFromPath,
  selectHierarchyTracePathForLabel,
} from "./hierarchy_tree.mjs";
import {
  attachCanonicalBindingStatuses,
  buildHierarchyPresentationRows,
} from "./r005_intalev_tree_presentation.mjs";
import {
  approvedIntalevTemplateGraphAppliesToProfile,
  attachApprovedIntalevTemplateGraph,
  loadApprovedIntalevTemplateGraph,
  validateApprovedIntalevTemplateGraph,
} from "./r005_intalev_template_graph.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(here, "config.json"), "utf8"));
const graphPath = path.join(here, "r005_intalev_template_graph.current.json");
const graphBytes = await fs.readFile(graphPath);
const graphDocument = JSON.parse(graphBytes.toString("utf8"));
const graphSha256 = crypto.createHash("sha256").update(graphBytes).digest("hex").toUpperCase();
const graphTemplateRows = graphDocument.nodes.map((node, index) => ({
  code: node.code,
  type: index % 2 === 0 ? "СТАТЬЯ" : "ДЕТАЛЬ",
  intalev_label_raw: `${" ".repeat(node.indent_units)}${node.label}`,
  intalev_label: node.label,
  erp_label: `ERP ${node.code}`,
  hierarchy_level_raw: 0,
  amount: index * 100.25,
  formula: `=${index + 1}+1`,
}));
const graphProof = validateApprovedIntalevTemplateGraph({
  document: graphDocument,
  graphPath,
  graphSha256,
  templatePath: "approved-template.xlsx",
  templateSha256: graphDocument.source.template_sha256,
  templateRows: graphTemplateRows,
});

function fixtureRows() {
  return attachApprovedIntalevTemplateGraph(graphTemplateRows, graphProof).map((row) => ({
    ...row,
    hierarchy_status: "BLOCKED_TEMPLATE_CATALOG_MISMATCH",
    hierarchy_period_consistent: true,
    hierarchy_node_id: "",
    hierarchy_parent_node_id: "",
    hierarchy_source_system: "INTALEV",
    hierarchy_path: [],
    intalev_hierarchy: { mapped: false },
    erp_hierarchy: { status: "UNPROVEN", parent_code: "R065" },
    intalev: { status: "MISSING" },
    erp: { status: "UNPROVEN" },
  }));
}

const ownerExpected = {
  R014: { parent: "R012", cell: "D20" },
  R015: { parent: "R012", cell: "D21" },
  R017: { parent: "R012", cell: "D23" },
  R018: { parent: "R012", cell: "D24" },
  R020: { parent: "R019", cell: "D26" },
  R022: { parent: "R019", cell: "D28" },
  R024: { parent: "R023", cell: "D30" },
  R031: { parent: "R029", cell: "D37" },
};

test("approved Intalev graph is pinned by config and contains no ERP authority", () => {
  assert.equal(graphSha256, config.intalev_template_graph_sha256);
  assert.equal(graphProof.status, "PASS_APPROVED_INTALEV_TEMPLATE_GRAPH");
  assert.equal(graphDocument.validation.erp_used, false);
  assert.equal(graphDocument.approval.rules_authority, false);
  assert.equal(graphDocument.approval.r001_authority, false);
  assert.equal(graphDocument.approval.financial_authority, false);
  assert.equal(graphDocument.nodes.length, 65);
  assert.equal(approvedIntalevTemplateGraphAppliesToProfile({ id: "UK_R005" }), true);
  assert.equal(approvedIntalevTemplateGraphAppliesToProfile({ id: "SAKHALIN" }), false);
});

test("user hierarchy selects the business row instead of a common technical wrapper", () => {
  const trace = [
    { full_path: "Расходы / _Статьи ОПиУ 2025 / Административные расходы / Прочие административные расходы" },
    { full_path: "Расходы / _Статьи ОПиУ 2025 / Административные расходы / Прочие административные расходы / _Допаналитика 2025" },
    { full_path: "Расходы / _Статьи ОПиУ 2025 / Административные расходы / Прочие административные расходы / Статьи расходов / Прочие административные расходы" },
  ];
  assert.equal(
    selectHierarchyTracePathForLabel(
      trace,
      "Прочие административные расходы",
    ),
    "Расходы / _Статьи ОПиУ 2025 / Административные расходы / Прочие административные расходы",
  );
});

test("duplicate mapped subtotal uses the stronger structural role as parent anchor", () => {
  const intalevTree = buildErpOutlineTree([
    { label: "Расходы", outline_level: 0 },
    { label: "Административные расходы", outline_level: 1 },
    { label: "Расходы ИТ", outline_level: 2 },
  ], { requireAmounts: false, system: "INTALEV" });
  const rows = [
    { code: "R001", type: "БЛОК", intalev_node_path: "Расходы / Административные расходы" },
    { code: "R050", type: "ПОДБЛОК", intalev_node_path: "Расходы / Административные расходы" },
    { code: "R019", type: "СТАТЬЯ", intalev_node_path: "Расходы / Административные расходы / Расходы ИТ" },
  ];
  const result = bindTemplateRowsToTrees(rows, {
    intalevTree,
    erpTree: intalevTree,
    canonicalSystem: "INTALEV",
  });
  assert.equal(result.rows[2].hierarchy_parent_code, "R001");
  assert.equal(
    resolveHierarchyNodeFromPath(
      "Расходы / Административные расходы / Расходы ИТ",
      intalevTree,
    ).status,
    "PROVEN_EXACT_PRESENTATION_PATH",
  );
});

test("ambiguous amount match may still prove an exact business hierarchy node", () => {
  const rows = fixtureRows();
  const row = rows.find((item) => item.code === "R012");
  row.intalev.status = "AMBIGUOUS";
  row.intalev_label = "Прочие административные расходы";
  row.hierarchy_path = [
    "Расходы по основной деятельности ИТОГО",
    "_Статьи ОПиУ 2025",
    "2_Административные расходы",
    "Прочие административные расходы",
  ];
  row.hierarchy_level = 3;
  row.hierarchy_parent_code = "R001";
  row.hierarchy_node_id = "INTALEV:R012";
  row.hierarchy_parent_node_id = "INTALEV:R001";
  row.intalev_hierarchy = { mapped: true };
  row.hierarchy_source_system = "INTALEV";

  const presented = buildHierarchyPresentationRows(rows).find(
    (item) => item.code === "R012",
  );
  assert.equal(presented.presentation_parent_code, "R001");
  assert.equal(presented.presentation_hierarchy_status, "HIERARCHY_PROVEN");
  assert.equal(presented.presentation_structural_proof.status, "PROVEN_LIVE_INTALEV");
});

test("approved graph parent and path are derived independently from source indentation", () => {
  const tampered = structuredClone(graphDocument);
  const r014 = tampered.nodes.find((node) => node.code === "R014");
  r014.parent_code = "R001";
  r014.path_codes = ["R001", "R014"];
  r014.path_labels = [tampered.nodes[0].label, r014.label];

  assert.throws(
    () => validateApprovedIntalevTemplateGraph({
      document: tampered,
      graphPath,
      graphSha256,
      templatePath: "approved-template.xlsx",
      templateSha256: graphDocument.source.template_sha256,
      templateRows: graphTemplateRows,
    }),
    /BLOCKED_INTALEV_REFERENCE_GRAPH_NODE_MISMATCH/,
  );
});

test("owner eight parents come from approved source cells, not R-code logic", () => {
  const rows = fixtureRows();
  const financialBefore = new Map(rows.map((row) => [row.code, [row.amount, row.formula]]));
  const presentation = buildHierarchyPresentationRows(rows);
  const byCode = new Map(presentation.map((row) => [row.code, row]));

  assert.equal(presentation.length, 65);
  assert.equal(new Set(presentation.map((row) => row.code)).size, 65);
  for (const [code, expected] of Object.entries(ownerExpected)) {
    const row = byCode.get(code);
    assert.equal(row.presentation_parent_code, expected.parent);
    assert.equal(row.presentation_parent_basis, "APPROVED_INTALEV_TEMPLATE_GRAPH");
    assert.equal(row.presentation_source_outline_level, 4);
    assert.equal(row.presentation_outline_level, row.presentation_depth);
    assert.equal(row.presentation_hierarchy_status, "HIERARCHY_PROVEN");
    assert.equal(row.presentation_structural_proof.status, "PROVEN_APPROVED_TEMPLATE_GRAPH");
    assert.equal(row.presentation_structural_proof.source_cell, expected.cell);
    assert.equal(row.presentation_structural_proof.template_sha256, graphDocument.source.template_sha256);
    assert.equal(row.presentation_structural_proof.graph_sha256, graphSha256);
    assert.equal(row.presentation_structural_proof.erp_used, false);
  }
  assert.deepEqual(
    new Map(presentation.map((row) => [row.code, [row.amount, row.formula]])),
    financialBefore,
  );
});

test("ERP MATCHED, UNPROVEN and MISMATCH cannot change an Intalev reference parent", () => {
  for (const state of ["MATCHED", "UNPROVEN", "MISMATCH"]) {
    const rows = fixtureRows();
    const target = rows.find((row) => row.code === "R024");
    target.erp_hierarchy = { status: state, parent_code: state === "MATCHED" ? "R001" : "R065" };
    target.erp.status = state;
    target.hierarchy_path = [
      "Административные расходы",
      "Прочие административные расходы",
      "Корпоративные мероприятия",
    ];
    const diagnosticParent = rows.find((row) => row.code === "R012");
    diagnosticParent.hierarchy_path = [
      "Административные расходы",
      "Прочие административные расходы",
    ];

    const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R024");
    assert.equal(row.presentation_parent_code, "R023");
    assert.equal(row.presentation_parent_basis, "APPROVED_INTALEV_TEMPLATE_GRAPH");
    assert.match(row.presentation_reason, /REPORT_PATH_PARENT_DIFFERS:R012->R023/);
  }
});

test("ambiguous report-path parents are diagnostics only and never select a first candidate", () => {
  const rows = fixtureRows();
  const target = rows.find((row) => row.code === "R024");
  target.hierarchy_path = ["Административные расходы", "Одинаковый путь", "Лист"];
  for (const code of ["R012", "R019"]) {
    rows.find((row) => row.code === code).hierarchy_path = [
      "Административные расходы",
      "Одинаковый путь",
    ];
  }

  const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R024");
  assert.equal(row.presentation_parent_code, "R023");
  assert.equal(row.presentation_parent_basis, "APPROVED_INTALEV_TEMPLATE_GRAPH");
  assert.match(row.presentation_reason, /REPORT_PATH_PARENT_AMBIGUOUS:R012,R019->R023/);
  assert.doesNotMatch(row.presentation_reason, /REPORT_PATH_PARENT_DIFFERS/);
});

test("an exact live Intalev parent takes precedence over the approved reference graph", () => {
  const rows = fixtureRows();
  const r035 = rows.find((row) => row.code === "R035");
  r035.intalev_hierarchy = {
    mapped: true,
    source: { source_file: "live-intalev.xlsx", source_cell: "A50" },
  };
  r035.hierarchy_source_system = "INTALEV";
  r035.hierarchy_parent_code = "R036";
  r035.hierarchy_parent_node_id = "INTALEV:R036";
  r035.hierarchy_level = 5;
  r035.hierarchy_node_id = "INTALEV:R035";
  r035.hierarchy_path = ["Административные расходы", "ФЗП", "НДФЛ"];
  r035.intalev.status = "MATCHED";

  const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R035");
  assert.equal(row.presentation_parent_code, "R036");
  assert.equal(row.presentation_parent_basis, "INTALEV_REPORT_PARENT");
  assert.equal(row.presentation_structural_proof.status, "PROVEN_LIVE_INTALEV");
  assert.equal(row.presentation_structural_proof.erp_used, false);
});

test("MISSING or identity-blocked Intalev rows cannot masquerade as exact live proof", () => {
  for (const status of ["MISSING", "BLOCKED_INTALEV_CODE_IDENTITY_NOT_PROVEN"]) {
    const rows = fixtureRows();
    const r024 = rows.find((row) => row.code === "R024");
    r024.intalev_hierarchy = {
      mapped: true,
      source: { source_file: "live-intalev.xlsx", source_cell: "A50" },
    };
    r024.hierarchy_source_system = "INTALEV";
    r024.hierarchy_parent_code = "R001";
    r024.hierarchy_parent_node_id = "INTALEV:R001";
    r024.hierarchy_level = 2;
    r024.hierarchy_node_id = "INTALEV:R024";
    r024.hierarchy_path = ["Административные расходы", "Корпоративные мероприятия"];
    r024.intalev.status = status;

    const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R024");
    assert.equal(row.presentation_parent_code, "R023");
    assert.equal(row.presentation_parent_basis, "APPROVED_INTALEV_TEMPLATE_GRAPH");
    assert.equal(row.presentation_structural_proof.status, "PROVEN_APPROVED_TEMPLATE_GRAPH");
  }
});

test("mixed live/reference outline conflict stays ROOT and HIERARCHY_UNPROVEN", () => {
  const rows = fixtureRows();
  const r055 = rows.find((row) => row.code === "R055");
  r055.intalev_hierarchy = { mapped: true };
  r055.hierarchy_source_system = "INTALEV";
  r055.hierarchy_parent_code = "";
  r055.hierarchy_level = 1;
  r055.hierarchy_node_id = "INTALEV:R055";
  r055.hierarchy_path = ["Итоги по внереализационной деятельности"];
  r055.intalev.status = "HIERARCHY_MISMATCH";

  const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R059");
  assert.equal(row.presentation_parent_code, "");
  assert.equal(row.presentation_parent_basis, "INTALEV_REFERENCE_PROOF_CONFLICT");
  assert.equal(row.presentation_hierarchy_status, "HIERARCHY_UNPROVEN");
  assert.equal(row.presentation_source_outline_level, 1);
  assert.equal(row.presentation_outline_level, 0);
  assert.match(row.presentation_reason, /SOURCE_OUTLINE_NOT_DEEPER:1->1/);
});

test("missing exact structural proof remains HIERARCHY_UNPROVEN and is not guessed", () => {
  const rows = fixtureRows();
  const target = rows.find((row) => row.code === "R024");
  target.intalev_reference_status = "HIERARCHY_UNPROVEN";
  target.intalev_reference_graph_sha256 = "";
  target.intalev_source_parent_code = "R023";
  target.erp_hierarchy = { status: "MATCHED", parent_code: "R001" };

  const row = buildHierarchyPresentationRows(rows).find((item) => item.code === "R024");
  assert.equal(row.presentation_parent_code, "");
  assert.equal(row.presentation_parent_basis, "INTALEV_REFERENCE_PROOF_MISSING");
  assert.equal(row.presentation_hierarchy_status, "HIERARCHY_UNPROVEN");
  assert.equal(row.presentation_structural_proof.status, "HIERARCHY_UNPROVEN");
  assert.match(row.presentation_reason, /REFERENCE_INTALEV_STRUCTURE_UNPROVEN/);
});

test("graph SHA or template identity drift blocks reference proof", async () => {
  await assert.rejects(
    loadApprovedIntalevTemplateGraph({
      graphPath,
      expectedGraphSha256: "0".repeat(64),
      templatePath: "approved-template.xlsx",
      templateSha256: graphDocument.source.template_sha256,
      templateRows: graphTemplateRows,
    }),
    /BLOCKED_INTALEV_REFERENCE_GRAPH_DRIFT/,
  );
  assert.throws(
    () => validateApprovedIntalevTemplateGraph({
      document: graphDocument,
      graphPath,
      graphSha256,
      templatePath: "wrong-template.xlsx",
      templateSha256: "F".repeat(64),
      templateRows: graphTemplateRows,
    }),
    /BLOCKED_INTALEV_REFERENCE_GRAPH_SOURCE_MISMATCH/,
  );
});

test("canonical Intalev binding never falls back to a mapped ERP node", () => {
  const erpTree = buildErpOutlineTree([
    { label: "ERP root", outline_level: 0 },
    { label: "Only ERP", outline_level: 1 },
  ], { requireAmounts: false });
  const intalevTree = buildIntalevParentTree([
    { uuid: "ROOT", name: "Intalev root", full_path: "Intalev root" },
  ], { requireAmounts: false, requireIdentity: true, parentIdentityOnly: true });
  const result = bindTemplateRowsToTrees([{
    code: "R001",
    erp_label: "Only ERP",
    erp_node_path: "ERP root / Only ERP",
    intalev_label: "Missing Intalev",
    intalev_reference_status: "HIERARCHY_UNPROVEN",
  }], { erpTree, intalevTree, canonicalSystem: "INTALEV" });
  const row = result.rows[0];

  assert.equal(row.erp_hierarchy.mapped, true);
  assert.equal(row.intalev_hierarchy.mapped, false);
  assert.equal(row.hierarchy_source_system, "INTALEV");
  assert.equal(row.hierarchy_node_id, "");
  assert.equal(row.hierarchy_parent_code, "");
  assert.equal(row.hierarchy_status, "BLOCKED_TEMPLATE_CATALOG_MISMATCH");
});

test("approved Intalev graph proves canonical hierarchy while ERP binding stays separate", () => {
  const rows = fixtureRows();
  const cases = [
    ["R024", { mapped: true, parent_code: "R023" }, "PROVEN"],
    ["R031", { mapped: true, parent_code: "R001" }, "MISMATCH"],
    ["R014", { mapped: false, parent_code: "R012" }, "UNPROVEN"],
  ];

  for (const [code, erpHierarchy] of cases) {
    rows.find((row) => row.code === code).erp_hierarchy = erpHierarchy;
  }
  const before = new Map(
    rows.map((row) => [row.code, [row.amount, row.formula]]),
  );
  const byCode = new Map(
    attachCanonicalBindingStatuses(buildHierarchyPresentationRows(rows)).map(
      (row) => [row.code, row],
    ),
  );

  for (const [code, , expectedErpStatus] of cases) {
    const row = byCode.get(code);
    assert.equal(row.intalev_live_hierarchy_status, "UNPROVEN");
    assert.equal(row.intalev_hierarchy_status, "PROVEN");
    assert.equal(row.erp_binding_status, "UNPROVEN");
    assert.equal(row.economic_parent_proven, undefined);
    assert.equal(row.presentation_structural_proof.erp_used, false);
  }
  assert.equal(byCode.get("R024").presentation_parent_code, "R023");
  assert.equal(byCode.get("R024").presentation_source_outline_level, 4);
  assert.equal(
    byCode.get("R024").presentation_outline_level,
    byCode.get("R024").presentation_depth,
  );
  assert.equal(byCode.get("R031").presentation_parent_code, "R029");
  assert.deepEqual(
    new Map([...byCode].map(([code, row]) => [code, [row.amount, row.formula]])),
    before,
  );
});
