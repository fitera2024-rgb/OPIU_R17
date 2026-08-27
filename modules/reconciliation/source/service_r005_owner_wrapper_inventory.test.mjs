import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authoritativeStructuralInventoryHierarchyPeriodsFromPayload,
  authoritativeStructuralInventoryPlanFromPayload,
  bindAuthoritativeStructuralInventoryPlan,
  bindFinalManifestCrossLinks,
  bindFinalReportCrossLinks,
} from "./service_r005_owner_wrapper.mjs";
import {
  materializeStructuralControlInventoryV3,
  planStructuralControlInventoryV3,
} from "./structural_control_inventory_v3.mjs";

const PRODUCTION_GROUPS = Object.freeze([
  Object.freeze({ code: "R033", label: "Коммерческие расходы", amount: 123456.78 }),
  Object.freeze({ code: "R034", label: "Расходы на транспортную логистику", amount: -2345.67 }),
  Object.freeze({ code: "R035", label: "Расходы на складскую логистику", amount: 890.12 }),
]);

function groupPath(side, label) {
  return side === "INTALEV"
    ? `Расходы / ${label}`
    : `Расходы / Отклонение / ${label}`;
}

function source(file, sha256, row) {
  return { file, sha256, sheet: "Отчёт", row, source_cell: `D${row}` };
}

function tree(side) {
  const prefix = side === "INTALEV" ? "I" : "E";
  const file = side === "INTALEV" ? "intalev-october.xlsx" : "erp-october.xlsx";
  const sha256 = side === "INTALEV" ? "A".repeat(64) : "B".repeat(64);
  const rootPath = "Расходы";
  const groupNodes = PRODUCTION_GROUPS.map((group, index) => ({
    node_id: `${prefix}-${group.code}`,
    parent_node_id: `${prefix}-ROOT`,
    immediate_children: [],
    full_path: groupPath(side, group.label),
    name: group.label,
    label: group.label,
    direct_total: group.amount,
    is_group: true,
    source_identity: `${prefix}-${group.code}-SOURCE`,
    source_identity_scope: "CURRENT_REPORT",
    source: source(file, sha256, 11 + index),
  }));
  return {
    schema: "opiu-hierarchy-tree-v1",
    status: "PASS",
    blockers: [],
    node_count: 1 + groupNodes.length,
    root_node_ids: [`${prefix}-ROOT`],
    nodes: [
      {
        node_id: `${prefix}-ROOT`, parent_node_id: "",
        immediate_children: groupNodes.map((node) => node.node_id),
        full_path: rootPath, name: "Расходы", label: "Расходы",
        direct_total: PRODUCTION_GROUPS.reduce((sum, group) => sum + group.amount, 0),
        is_group: false, source: source(file, sha256, 10),
      },
      ...groupNodes,
    ],
  };
}

function realWrapperPayload() {
  return JSON.parse(JSON.stringify({
    generated_at: "2026-08-26T00:00:00.000Z",
    organization: "9 Управляющая компания",
    period: "2025-10",
    period_rows: [{
      period: "2025-10",
      rows: PRODUCTION_GROUPS.map((group) => ({
        code: group.code,
        hierarchy_node_id: `I-${group.code}`,
        hierarchy_path: groupPath("INTALEV", group.label).split(" / "),
        presentation_structural_proof: {
          status: "PROVEN_LIVE_INTALEV",
          node_id: `I-${group.code}`,
          path: groupPath("INTALEV", group.label).split(" / "),
        },
        intalev: group.amount,
        erp: group.amount,
        erp_paths: [groupPath("ERP", group.label)],
        erp_presentation_parent_node_id: "E-ROOT",
        erp_label: group.label,
      })),
    }],
    hierarchy_periods: [{
      period: "2025-10",
      status: "PASS",
      source_hierarchy_status: "PASS",
      blockers: [],
      intalev_tree: tree("INTALEV"),
      erp_tree: tree("ERP"),
    }],
  }));
}

function nestedWrapperPayload() {
  const payload = structuredClone(realWrapperPayload());
  payload.period_rows[0].rows = payload.period_rows[0].rows.map((row) => {
    const { erp_paths: erpPaths, ...rowWithoutErpPaths } = row;
    return {
      ...rowWithoutErpPaths,
      intalev: { amount: row.intalev },
      erp: {
        amount: row.erp,
        trace: erpPaths.flatMap((fullPath) => [
          { full_path: fullPath },
          { full_path: ` ${fullPath} ` },
        ]),
      },
    };
  });
  return payload;
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

test("wrapper binds Codex input to the final owner-enriched report", () => {
  const reportPath = path.resolve("final-owner-report.xlsx");
  const reportSha256 = "c".repeat(64);
  const document = bindFinalReportCrossLinks({ organization: "9 Управляющая компания" }, {
    reportPath,
    reportSha256,
  });
  assert.equal(document.report_path, reportPath);
  assert.equal(document.output_path, reportPath);
  assert.equal(document.report_sha256, reportSha256.toUpperCase());
  assert.equal(document.output_sha256, reportSha256.toUpperCase());
  assert.throws(
    () => bindFinalReportCrossLinks({}, { reportPath, reportSha256: "NOT-A-SHA" }),
    /R005_CURRENT_RUN_REPORT_BINDING_INVALID/,
  );

  const codexInputPath = path.resolve("final-owner-report.codex-input.json");
  const codexInputSha256 = "d".repeat(64);
  const manifest = bindFinalManifestCrossLinks({}, {
    reportPath,
    reportSha256,
    codexInputPath,
    codexInputSha256,
  });
  assert.equal(manifest.output_path, reportPath);
  assert.equal(manifest.output_sha256, reportSha256.toUpperCase());
  assert.equal(manifest.codex_input_path, codexInputPath);
  assert.equal(manifest.codex_input_sha256, codexInputSha256.toUpperCase());
  assert.throws(
    () => bindFinalManifestCrossLinks({}, {
      reportPath,
      reportSha256,
      codexInputPath,
      codexInputSha256: "NOT-A-SHA",
    }),
    /R005_CURRENT_RUN_CODEX_BINDING_INVALID/,
  );
});

test("wrapper preserves production numeric period_rows as exact selectable inventory groups", async () => {
  const payload = realWrapperPayload();
  assert.equal(
    payload.period_rows[0].rows.every((row) =>
      typeof row.intalev === "number"
        && typeof row.erp === "number"
        && Array.isArray(row.erp_paths)),
    true,
  );
  const rawPlan = planStructuralControlInventoryV3(
    inventoryInput(payload, payload.hierarchy_periods),
  );
  payload.structural_control_inventory = rawPlan.audit;
  const preparedPlan = authoritativeStructuralInventoryPlanFromPayload(payload);
  const authoritativePeriods = preparedPlan.input.hierarchyPeriods;

  assert.notEqual(rawPlan.inventory_id, preparedPlan.plan.inventory_id);
  assert.notDeepEqual(rawPlan.audit.hierarchy_versions, preparedPlan.plan.audit.hierarchy_versions);
  assert.notDeepEqual(rawPlan.audit.member_hashes, preparedPlan.plan.audit.member_hashes);
  const authoritativeProjection = authoritativePeriods[0]
    .structural_control_authoritative_projection;
  const expectedCents = [12345678, -234567, 89012];
  assert.equal(authoritativeProjection.intalev_candidate_count, 3);
  assert.equal(authoritativeProjection.erp_candidate_count, 3);
  assert.equal(authoritativeProjection.exclusion_count, 0);
  assert.deepEqual(
    authoritativeProjection.intalev_candidates.map((candidate) => candidate.amount_cents),
    expectedCents,
  );
  assert.deepEqual(
    authoritativeProjection.erp_candidates.map((candidate) => candidate.amount_cents),
    expectedCents,
  );
  assert.equal(
    authoritativePeriods[0].intalev_tree.nodes
      .filter((node) => node.code)
      .every((node) => node.is_group === true),
    true,
  );
  assert.equal(
    authoritativePeriods[0].erp_tree.nodes
      .filter((node) => node.code)
      .every((node) => node.is_group === true),
    true,
  );

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
      structural_control_inventory: rawPlan.audit,
      report_path: reportPath,
      report_sha256: reportHash,
    };
    const codexBytes = Buffer.from(JSON.stringify(codexDocument), "utf8");
    await fs.writeFile(codexInputPath, codexBytes);
    const manifestDocument = {
      organization: payload.organization,
      period: payload.period,
      structural_control_inventory: rawPlan.audit,
      output_path: reportPath,
      output_sha256: reportHash,
      codex_input_path: codexInputPath,
      codex_input_sha256: sha256(codexBytes),
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestDocument), "utf8");

    const blockedRawPlan = await materializeStructuralControlInventoryV3({
      outputDirectory: directory,
      ...preparedPlan.input,
      currentRunFiles: { reportPath, codexInputPath, manifestPath },
    });
    assert.equal(blockedRawPlan.status, "BLOCKED");
    assert.equal(blockedRawPlan.audit.verified_binding_written, false);
    assert.ok(blockedRawPlan.inventory.current_run_provenance.verification_blockers.includes(
      "CODEX_INPUT_STRUCTURAL_PLAN_SCOPE_MISMATCH",
    ));
    assert.ok(blockedRawPlan.inventory.current_run_provenance.verification_blockers.includes(
      "MANIFEST_STRUCTURAL_PLAN_SCOPE_MISMATCH",
    ));

    bindAuthoritativeStructuralInventoryPlan(payload, preparedPlan);
    bindAuthoritativeStructuralInventoryPlan(codexDocument, preparedPlan);
    const authoritativeCodexBytes = Buffer.from(JSON.stringify(codexDocument), "utf8");
    await fs.writeFile(codexInputPath, authoritativeCodexBytes);
    bindAuthoritativeStructuralInventoryPlan(manifestDocument, preparedPlan);
    manifestDocument.codex_input_sha256 = sha256(authoritativeCodexBytes);
    await fs.writeFile(manifestPath, JSON.stringify(manifestDocument), "utf8");

    const result = await materializeStructuralControlInventoryV3({
      outputDirectory: directory,
      ...preparedPlan.input,
      currentRunFiles: { reportPath, codexInputPath, manifestPath },
    });
    assert.equal(result.status, "VERIFIED");
    assert.deepEqual(result.inventory.current_run_provenance.verification_blockers, []);
    assert.equal(result.inventory.inventory_id, preparedPlan.plan.inventory_id);
    assert.deepEqual(payload.structural_control_inventory, preparedPlan.plan.audit);
    assert.deepEqual(codexDocument.structural_control_inventory, preparedPlan.plan.audit);
    assert.deepEqual(manifestDocument.structural_control_inventory, preparedPlan.plan.audit);
    assert.equal(result.inventory.intalev_members.length, 3);
    assert.equal(result.inventory.erp_members.length, 3);
    assert.deepEqual(
      result.inventory.intalev_members.map((member) => member.amount_cents),
      expectedCents,
    );
    assert.deepEqual(
      result.inventory.erp_members.map((member) => member.amount_cents),
      expectedCents,
    );
    assert.equal(
      result.inventory.intalev_members.every((member) =>
        member.is_group === true && member.candidate_selectable === true),
      true,
    );
    assert.equal(
      result.inventory.erp_members.every((member) =>
        member.is_group === true && member.candidate_selectable === true),
      true,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("wrapper keeps foreign reconciliation scope blocked after authoritative plan binding", async () => {
  const payload = realWrapperPayload();
  const rawPlan = planStructuralControlInventoryV3(
    inventoryInput(payload, payload.hierarchy_periods),
  );
  payload.structural_control_inventory = rawPlan.audit;
  const preparedPlan = authoritativeStructuralInventoryPlanFromPayload(payload);
  bindAuthoritativeStructuralInventoryPlan(payload, preparedPlan);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-wrapper-v3-foreign-scope-"));
  try {
    const reportPath = path.join(directory, "october.xlsx");
    const codexInputPath = path.join(directory, "october.codex-input.json");
    const manifestPath = path.join(directory, "october.manifest.json");
    const reportBytes = Buffer.from("real-format-report-placeholder", "utf8");
    await fs.writeFile(reportPath, reportBytes);
    const reportHash = sha256(reportBytes);
    const codexDocument = bindAuthoritativeStructuralInventoryPlan({
      organization: payload.organization,
      period: payload.period,
      report_path: reportPath,
      report_sha256: reportHash,
    }, preparedPlan);
    const codexBytes = Buffer.from(JSON.stringify(codexDocument), "utf8");
    await fs.writeFile(codexInputPath, codexBytes);
    const manifestDocument = bindAuthoritativeStructuralInventoryPlan({
      organization: "3 Сахалин",
      period: payload.period,
      output_path: reportPath,
      output_sha256: reportHash,
      codex_input_path: codexInputPath,
      codex_input_sha256: sha256(codexBytes),
    }, preparedPlan);
    await fs.writeFile(manifestPath, JSON.stringify(manifestDocument), "utf8");

    const result = await materializeStructuralControlInventoryV3({
      outputDirectory: directory,
      ...preparedPlan.input,
      currentRunFiles: { reportPath, codexInputPath, manifestPath },
    });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.audit.verified_binding_written, false);
    assert.ok(result.inventory.current_run_provenance.verification_blockers.includes(
      "MANIFEST_RECONCILIATION_SCOPE_MISMATCH",
    ));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("wrapper keeps the explicit nested amount compatibility shape", () => {
  const numericProjection = authoritativeStructuralInventoryHierarchyPeriodsFromPayload(
    realWrapperPayload(),
  );
  const nestedProjection = authoritativeStructuralInventoryHierarchyPeriodsFromPayload(
    nestedWrapperPayload(),
  );
  assert.deepEqual(
    nestedProjection[0].structural_control_authoritative_projection,
    numericProjection[0].structural_control_authoritative_projection,
  );
});

test("wrapper authoritative projection remains fail-closed on period_rows scope drift", () => {
  const payload = realWrapperPayload();
  payload.period_rows[0].period = "2025-11";
  assert.throws(
    () => authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload),
    /BLOCKED_STRUCTURAL_CONTROL_INVENTORY_PERIOD_BINDING:2025-10/,
  );
});

test("wrapper does not turn a NOT_PASS source hierarchy into an authoritative plan", () => {
  const payload = realWrapperPayload();
  payload.hierarchy_periods[0].source_hierarchy_status = "BLOCKED";
  payload.hierarchy_periods[0].intalev_tree.status = "BLOCKED";
  const rawPlan = planStructuralControlInventoryV3(
    inventoryInput(payload, payload.hierarchy_periods),
  );
  payload.structural_control_inventory = rawPlan.audit;

  assert.equal(rawPlan.status, "BLOCKED");
  assert.throws(
    () => authoritativeStructuralInventoryPlanFromPayload(payload),
    /BLOCKED_STRUCTURAL_CONTROL_AUTHORITATIVE_CANDIDATES_TREE_NOT_PROVEN:2025-10:INTALEV/,
  );
});
