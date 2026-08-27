import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthoritativeStructuralControlInventoryHierarchyPeriod,
  projectAuthoritativeStructuralControlCandidates,
} from "./structural_control_authoritative_candidates.mjs";

const intalevPath = "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 1_Административные расходы / ФЗП";
const erpPath = "Прочие доходы / Отклонение / Расходы по основной деятельности ИТОГО / Административные расходы / ФЗП";

function fixture() {
  return {
    period: "2025-10",
    intalev_hierarchy_tree: {
      status: "PASS",
      nodes: [
        { node_id: "I-ROOT", full_path: "Расходы по основной деятельности ИТОГО", label: "Расходы по основной деятельности ИТОГО", direct_total: 100 },
        { node_id: "I-TECH", parent_node_id: "I-ROOT", full_path: "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025", label: "_Статьи ОПиУ 2025", direct_total: 100, is_group: true },
        { node_id: "I-R033", parent_node_id: "I-TECH", full_path: intalevPath, label: "ФЗП", direct_total: 100, is_group: true },
        { node_id: "I-DEEP", parent_node_id: "I-R033", full_path: `${intalevPath} / Премия`, label: "Премия", direct_total: 25, is_group: true },
      ],
    },
    erp_hierarchy_tree: {
      status: "PASS",
      nodes: [
        { node_id: "E-ROOT", full_path: "Прочие доходы", label: "Прочие доходы", direct_total: 100 },
        { node_id: "E-PARENT", parent_node_id: "E-ROOT", full_path: "Прочие доходы / Отклонение / Расходы по основной деятельности ИТОГО / Административные расходы", label: "Административные расходы", direct_total: 100, is_group: true },
        { node_id: "E-R033", parent_node_id: "E-PARENT", full_path: erpPath, label: "ФЗП", direct_total: 100, is_group: true },
        { node_id: "E-DEEP", parent_node_id: "E-R033", full_path: `${erpPath} / Премия`, label: "Премия", direct_total: 25, is_group: true },
      ],
    },
    rows: [{
      code: "R033",
      hierarchy_node_id: "I-R033",
      hierarchy_path: intalevPath.split(" / "),
      presentation_structural_proof: {
        status: "PROVEN_LIVE_INTALEV",
        node_id: "I-R033",
        path: intalevPath.split(" / "),
      },
      intalev_amount: 100,
      erp_amount: 100,
      erp_paths: [erpPath, `${erpPath} / Премия`],
      erp_presentation_parent_node_id: "E-PARENT",
      erp_label: "ФЗП",
    }],
  };
}

test("projects exact report-row mappings from realistic no-code October-shaped source trees", () => {
  const result = projectAuthoritativeStructuralControlCandidates(fixture());
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.intalev_candidate_count, 1);
  assert.equal(result.erp_candidate_count, 1);
  assert.deepEqual(result.intalev_candidates[0], {
    side: "INTALEV", reporting_code: "R033", node_id: "I-R033", parent_node_id: "I-TECH",
    full_path: intalevPath, name: "ФЗП", amount: 100, amount_cents: 10000,
  });
  assert.equal(result.erp_candidates[0].node_id, "E-R033");
  assert.equal(result.erp_candidates[0].full_path, erpPath);
  assert.equal(result.excluded_raw_tree_nodes.intalev, 3);
  assert.equal(result.excluded_raw_tree_nodes.erp, 3);
  assert.equal(result.financial_rows, 0);
  assert.equal(result.posting_rows, 0);
});

test("excludes deep and unmapped raw technical groups", () => {
  const month = fixture();
  month.rows.push({
    code: "R099",
    presentation_structural_proof: { status: "PROVEN_APPROVED_TEMPLATE_GRAPH" },
    intalev_amount: 25,
    erp_amount: 25,
    erp_paths: ["ERP / Не найдено"],
    erp_presentation_parent_node_id: "E-R033",
    erp_label: "Премия",
  });
  const result = projectAuthoritativeStructuralControlCandidates(month);
  assert.deepEqual(result.intalev_candidates.map((item) => item.reporting_code), ["R033"]);
  assert.deepEqual(result.erp_candidates.map((item) => item.reporting_code), ["R033"]);
});

test("excludes Intalev proof/tree drift and ERP tree ambiguity without losing unrelated candidates", () => {
  const intalevDrift = fixture();
  intalevDrift.rows[0].presentation_structural_proof.path = ["Иной", "Путь"];
  const drift = projectAuthoritativeStructuralControlCandidates(intalevDrift);
  assert.equal(drift.intalev_candidate_count, 0);
  assert.equal(drift.erp_candidate_count, 1);
  assert.equal(drift.excluded_candidates[0].code, "INTALEV_PROOF_TREE_MISMATCH");

  const erpAmbiguous = fixture();
  erpAmbiguous.erp_hierarchy_tree.nodes.push({
    ...erpAmbiguous.erp_hierarchy_tree.nodes[2],
    node_id: "E-R033-DUPLICATE",
  });
  const ambiguous = projectAuthoritativeStructuralControlCandidates(erpAmbiguous);
  assert.equal(ambiguous.erp_candidate_count, 0);
  assert.equal(ambiguous.excluded_candidates.some((item) => item.code === "ERP_TREE_MAPPING_AMBIGUOUS"), true);
});

test("excludes every claimant when two reporting rows claim the same exact source node", () => {
  const month = fixture();
  month.rows.push({ ...month.rows[0], code: "R034" });
  const intalevAmbiguous = projectAuthoritativeStructuralControlCandidates(month);
  assert.equal(intalevAmbiguous.intalev_candidate_count, 0);
  assert.equal(intalevAmbiguous.excluded_ambiguities[0].code, "INTALEV_NODE_AMBIGUOUS");

  const erpOnlyAmbiguity = fixture();
  erpOnlyAmbiguity.rows.push({
    ...erpOnlyAmbiguity.rows[0],
    code: "R034",
    hierarchy_node_id: "",
    hierarchy_path: [],
    presentation_structural_proof: { status: "UNPROVEN" },
  });
  const erpAmbiguous = projectAuthoritativeStructuralControlCandidates(erpOnlyAmbiguity);
  assert.equal(erpAmbiguous.erp_candidate_count, 0);
  assert.equal(erpAmbiguous.excluded_ambiguities[0].code, "ERP_NODE_AMBIGUOUS");
});

test("keeps unique R045/R055 groups while excluding the actual R049/R053 shared Intalev node class", () => {
  const month = fixture();
  const addMapped = (code, suffix, amount, sharedNode = "") => {
    const intalevNodeID = sharedNode || `I-${code}`;
    const intalevFullPath = `${intalevPath} / ${suffix}`;
    if (!month.intalev_hierarchy_tree.nodes.some((node) => node.node_id === intalevNodeID)) {
      month.intalev_hierarchy_tree.nodes.push({
        node_id: intalevNodeID, parent_node_id: "I-TECH", full_path: intalevFullPath,
        label: suffix, direct_total: amount, is_group: true,
      });
    }
    const erpNodeID = `E-${code}`;
    const erpFullPath = `${erpPath} / ${suffix}`;
    month.erp_hierarchy_tree.nodes.push({
      node_id: erpNodeID, parent_node_id: "E-PARENT", full_path: erpFullPath,
      label: suffix, direct_total: amount, is_group: true,
    });
    month.rows.push({
      code, hierarchy_node_id: intalevNodeID, hierarchy_path: intalevFullPath.split(" / "),
      presentation_structural_proof: {
        status: "PROVEN_LIVE_INTALEV", node_id: intalevNodeID,
        path: intalevFullPath.split(" / "),
      },
      intalev_amount: amount, erp_amount: amount, erp_paths: [erpFullPath],
      erp_presentation_parent_node_id: "E-PARENT", erp_label: suffix,
    });
  };
  addMapped("R045", "Финансовые расходы", 45);
  addMapped("R055", "Внереализационные расходы", 55);
  addMapped("R049", "Общий финансовый узел", 49, "I-SHARED-R049-R053");
  const sharedPath = `${intalevPath} / Общий финансовый узел`;
  const r053ERPPath = `${erpPath} / Другой ERP узел R053`;
  month.erp_hierarchy_tree.nodes.push({
    node_id: "E-R053", parent_node_id: "E-PARENT", full_path: r053ERPPath,
    label: "Другой ERP узел R053", direct_total: 49, is_group: true,
  });
  month.rows.push({
    code: "R053", hierarchy_node_id: "I-SHARED-R049-R053", hierarchy_path: sharedPath.split(" / "),
    presentation_structural_proof: {
      status: "PROVEN_LIVE_INTALEV", node_id: "I-SHARED-R049-R053", path: sharedPath.split(" / "),
    },
    intalev_amount: 49, erp_amount: 49, erp_paths: [r053ERPPath],
    erp_presentation_parent_node_id: "E-PARENT", erp_label: "Другой ERP узел R053",
  });
  const result = projectAuthoritativeStructuralControlCandidates(month);
  assert.equal(result.status, "VERIFIED_WITH_CANDIDATES_EXCLUDED");
  assert.equal(result.intalev_candidates.some((item) => item.reporting_code === "R045"), true);
  assert.equal(result.intalev_candidates.some((item) => item.reporting_code === "R055"), true);
  assert.equal(result.intalev_candidates.some((item) => ["R049", "R053"].includes(item.reporting_code)), false);
  const shared = result.excluded_ambiguities.find((item) => item.node_id === "I-SHARED-R049-R053");
  assert.deepEqual(shared.reporting_codes, ["R049", "R053"]);
});

test("requires proven current trees but excludes candidate-specific non-cent amounts", () => {
  const blockedTree = fixture();
  blockedTree.erp_hierarchy_tree.status = "BLOCKED";
  assert.throws(() => projectAuthoritativeStructuralControlCandidates(blockedTree), /TREE_NOT_PROVEN/);

  const fractional = fixture();
  fractional.rows[0].erp_amount = 100.001;
  const result = projectAuthoritativeStructuralControlCandidates(fractional);
  assert.equal(result.intalev_candidate_count, 1);
  assert.equal(result.erp_candidate_count, 0);
  assert.equal(result.excluded_candidates.some((item) => item.code === "ERP_ROW_BINDING_INCOMPLETE"), true);
});

test("known empty-article amount mismatch excludes only that candidate and preserves R045/R055", () => {
  const month = fixture();
  const addUnique = (code, sideName, amount) => {
    const intalevFullPath = `${intalevPath} / ${sideName}`;
    const erpFullPath = `${erpPath} / ${sideName}`;
    month.intalev_hierarchy_tree.nodes.push({
      node_id: `I-${code}`, parent_node_id: "I-TECH", full_path: intalevFullPath,
      label: sideName, direct_total: amount, is_group: true,
    });
    month.erp_hierarchy_tree.nodes.push({
      node_id: `E-${code}`, parent_node_id: "E-PARENT", full_path: erpFullPath,
      label: sideName, direct_total: amount, is_group: true,
    });
    month.rows.push({
      code, hierarchy_node_id: `I-${code}`, hierarchy_path: intalevFullPath.split(" / "),
      presentation_structural_proof: {
        status: "PROVEN_LIVE_INTALEV", node_id: `I-${code}`, path: intalevFullPath.split(" / "),
      },
      intalev_amount: amount, erp_amount: amount, erp_paths: [erpFullPath],
      erp_presentation_parent_node_id: "E-PARENT", erp_label: sideName,
    });
  };
  addUnique("R045", "Финансовые расходы", 45);
  addUnique("R055", "Внереализационные расходы", 55);
  month.rows[0].intalev_amount = 99.99;
  const result = projectAuthoritativeStructuralControlCandidates(month);
  assert.equal(result.intalev_candidates.some((item) => item.reporting_code === "R033"), false);
  assert.equal(result.intalev_candidates.some((item) => item.reporting_code === "R045"), true);
  assert.equal(result.intalev_candidates.some((item) => item.reporting_code === "R055"), true);
  const mismatch = result.excluded_candidates.find((item) => item.code === "INTALEV_AMOUNT_TREE_MISMATCH");
  assert.equal(mismatch.reporting_code, "R033");
  assert.equal(mismatch.report_amount_cents, 9999);
  assert.equal(mismatch.tree_amount_cents, 10000);
});

test("inventory hierarchy clone grants is_group/code only to authoritative mapped candidates", () => {
  const month = fixture();
  month.intalev_hierarchy_tree.node_count = month.intalev_hierarchy_tree.nodes.length;
  month.intalev_hierarchy_tree.root_node_ids = ["I-ROOT"];
  month.intalev_hierarchy_tree.nodes[2].source = { file: "intalev.xlsx", row: 33, trace: ["kept"] };
  month.erp_hierarchy_tree.node_count = month.erp_hierarchy_tree.nodes.length;
  month.erp_hierarchy_tree.root_node_ids = ["E-ROOT"];
  month.erp_hierarchy_tree.nodes[2].source = { file: "erp.xlsx", row: 44, trace: ["kept"] };
  const compact = {
    period: month.period,
    status: "PASS",
    source_hierarchy_status: "PASS",
    blockers: [],
    intalev_tree: month.intalev_hierarchy_tree,
    erp_tree: month.erp_hierarchy_tree,
  };
  const original = JSON.stringify(compact);
  const result = buildAuthoritativeStructuralControlInventoryHierarchyPeriod(month, compact);
  assert.equal(JSON.stringify(compact), original, "source compact hierarchy period was mutated");
  assert.notEqual(result, compact);
  assert.notEqual(result.intalev_tree, compact.intalev_tree);
  assert.equal(result.intalev_tree.nodes.length, compact.intalev_tree.nodes.length);
  assert.deepEqual(result.intalev_tree.root_node_ids, ["I-ROOT"]);
  assert.deepEqual(result.intalev_tree.nodes[2].source, { file: "intalev.xlsx", row: 33, trace: ["kept"] });
  assert.deepEqual(result.erp_tree.nodes[2].source, { file: "erp.xlsx", row: 44, trace: ["kept"] });
  for (const [side, exactNodeID] of [["intalev_tree", "I-R033"], ["erp_tree", "E-R033"]]) {
    for (const node of result[side].nodes) {
      assert.equal(node.is_group, node.node_id === exactNodeID);
      assert.equal(node.code, node.node_id === exactNodeID ? "R033" : "");
    }
  }
  assert.equal(result.structural_control_authoritative_projection.status, "VERIFIED");
  assert.equal(result.structural_control_authoritative_projection.financial_rows, 0);
  assert.equal(result.structural_control_authoritative_projection.posting_rows, 0);
  assert.equal(Object.isFrozen(result), true);
});

test("inventory hierarchy clone removes group/code authority from ambiguous shared nodes", () => {
  const month = fixture();
  month.rows.push({ ...month.rows[0], code: "R053" });
  const compact = {
    period: month.period,
    source_hierarchy_status: "PASS",
    intalev_tree: month.intalev_hierarchy_tree,
    erp_tree: month.erp_hierarchy_tree,
  };
  const result = buildAuthoritativeStructuralControlInventoryHierarchyPeriod(month, compact);
  const sharedIntalev = result.intalev_tree.nodes.find((node) => node.node_id === "I-R033");
  const sharedERP = result.erp_tree.nodes.find((node) => node.node_id === "E-R033");
  assert.deepEqual({ is_group: sharedIntalev.is_group, code: sharedIntalev.code },
    { is_group: false, code: "" });
  assert.deepEqual({ is_group: sharedERP.is_group, code: sharedERP.code },
    { is_group: false, code: "" });
  assert.equal(result.structural_control_authoritative_projection.ambiguity_count, 2);
});
