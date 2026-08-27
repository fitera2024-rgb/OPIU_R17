import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authoritativeStructuralInventoryHierarchyPeriodsFromPayload,
} from "./service_r005_owner_wrapper.mjs";
import {
  materializeStructuralControlInventoryV3,
  planStructuralControlInventoryV3,
} from "./structural_control_inventory_v3.mjs";

const INTALEV_PATH = "Расходы / Административные расходы / ФЗП";
const ERP_PATH = "Расходы / Отклонение / Административные расходы / ФЗП";

function source(file, sha256, row) {
  return { file, sha256, sheet: "Отчёт", row, source_cell: `D${row}` };
}

function tree(side) {
  const prefix = side === "INTALEV" ? "I" : "E";
  const file = side === "INTALEV" ? "intalev-october.xlsx" : "erp-october.xlsx";
  const sha256 = side === "INTALEV" ? "A".repeat(64) : "B".repeat(64);
  const rootPath = "Расходы";
  const technicalPath = side === "INTALEV"
    ? "Расходы / Административные расходы"
    : "Расходы / Отклонение / Административные расходы";
  const leafPath = side === "INTALEV" ? INTALEV_PATH : ERP_PATH;
  return {
    schema: "opiu-hierarchy-tree-v1",
    status: "PASS",
    blockers: [],
    node_count: 3,
    root_node_ids: [`${prefix}-ROOT`],
    nodes: [
      {
        node_id: `${prefix}-ROOT`, parent_node_id: "", immediate_children: [`${prefix}-TECH`],
        full_path: rootPath, name: "Расходы", label: "Расходы", direct_total: 100,
        is_group: false, source: source(file, sha256, 10),
      },
      {
        node_id: `${prefix}-TECH`, parent_node_id: `${prefix}-ROOT`, immediate_children: [`${prefix}-R033`],
        full_path: technicalPath, name: "Административные расходы", label: "Административные расходы",
        direct_total: 100, is_group: true, source_identity: `${prefix}-TECH-SOURCE`,
        source_identity_scope: "CURRENT_REPORT", source: source(file, sha256, 11),
      },
      {
        node_id: `${prefix}-R033`, parent_node_id: `${prefix}-TECH`, immediate_children: [],
        full_path: leafPath, name: "ФЗП", label: "ФЗП", direct_total: 100,
        is_group: true, source_identity: `${prefix}-R033-SOURCE`,
        source_identity_scope: "CURRENT_REPORT", source: source(file, sha256, 12),
      },
    ],
  };
}

function realWrapperPayload() {
  return {
    generated_at: "2026-08-26T00:00:00.000Z",
    organization: "9 Управляющая компания",
    period: "2025-10",
    period_rows: [{
      period: "2025-10",
      rows: [{
        code: "R033",
        hierarchy_node_id: "I-R033",
        hierarchy_path: INTALEV_PATH.split(" / "),
        presentation_structural_proof: {
          status: "PROVEN_LIVE_INTALEV",
          node_id: "I-R033",
          path: INTALEV_PATH.split(" / "),
        },
        intalev: { amount: 100 },
        erp: {
          amount: 100,
          trace: [{ full_path: ERP_PATH }, { full_path: ` ${ERP_PATH} ` }],
        },
        erp_presentation_parent_node_id: "E-TECH",
        erp_label: "ФЗП",
      }],
    }],
    hierarchy_periods: [{
      period: "2025-10",
      status: "PASS",
      source_hierarchy_status: "PASS",
      blockers: [],
      intalev_tree: tree("INTALEV"),
      erp_tree: tree("ERP"),
    }],
  };
}

function inventoryInput(payload, hierarchyPeriods) {
  return {
    runId: "OWNER-CONTRACT-20260824-UK9-2025-10",
    contextId: "CTX-OWNER-CONTRACT-20260824-UK9-2025-10",
    organization: {
      id: "ERP-000000224",
      name: payload.organization,
      path: payload.organization,
    },
    reconciliationOrganizationName: payload.organization,
    period: payload.period,
    hierarchyPeriods,
    generatedAt: payload.generated_at,
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

test("wrapper v3 materializer reuses the core authoritative projection for real period_rows format", async () => {
  const payload = realWrapperPayload();
  const rawPlan = planStructuralControlInventoryV3(
    inventoryInput(payload, payload.hierarchy_periods),
  );
  const authoritativePeriods = authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload);
  const embeddedPlan = planStructuralControlInventoryV3(
    inventoryInput(payload, authoritativePeriods),
  );
  payload.structural_control_inventory = embeddedPlan.audit;

  assert.notDeepEqual(rawPlan.audit.hierarchy_versions, embeddedPlan.audit.hierarchy_versions);
  assert.notDeepEqual(rawPlan.audit.member_hashes, embeddedPlan.audit.member_hashes);
  assert.equal(authoritativePeriods[0].intalev_tree.nodes[1].is_group, false);
  assert.equal(authoritativePeriods[0].erp_tree.nodes[1].is_group, false);
  assert.equal(authoritativePeriods[0].intalev_tree.nodes[2].code, "R033");
  assert.equal(authoritativePeriods[0].erp_tree.nodes[2].code, "R033");

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-wrapper-v3-scope-"));
  try {
    const reportPath = path.join(directory, "october.xlsx");
    const codexInputPath = path.join(directory, "october.codex-input.json");
    const manifestPath = path.join(directory, "october.manifest.json");
    const reportBytes = Buffer.from("real-format-report-placeholder", "utf8");
    await fs.writeFile(reportPath, reportBytes);
    const reportHash = sha256(reportBytes);
    const codexDocument = {
      organization: payload.organization,
      period: payload.period,
      structural_control_inventory: embeddedPlan.audit,
      report_path: reportPath,
      report_sha256: reportHash,
    };
    const codexBytes = Buffer.from(JSON.stringify(codexDocument), "utf8");
    await fs.writeFile(codexInputPath, codexBytes);
    const manifestDocument = {
      organization: payload.organization,
      period: payload.period,
      structural_control_inventory: embeddedPlan.audit,
      output_path: reportPath,
      output_sha256: reportHash,
      codex_input_path: codexInputPath,
      codex_input_sha256: sha256(codexBytes),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestDocument), "utf8");

    const result = await materializeStructuralControlInventoryV3({
      outputDirectory: directory,
      ...inventoryInput(payload, authoritativePeriods),
      currentRunFiles: { reportPath, codexInputPath, manifestPath },
    });
    assert.equal(result.status, "VERIFIED");
    assert.deepEqual(result.inventory.current_run_provenance.verification_blockers, []);
    assert.equal(result.inventory.inventory_id, embeddedPlan.inventory_id);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("wrapper authoritative projection remains fail-closed on period_rows scope drift", () => {
  const payload = realWrapperPayload();
  payload.period_rows[0].period = "2025-11";
  assert.throws(
    () => authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload),
    /BLOCKED_STRUCTURAL_CONTROL_INVENTORY_PERIOD_BINDING:2025-10/,
  );
});
