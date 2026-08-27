import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildErpOutlineTree } from "./hierarchy_tree.mjs";
import { compactHierarchyTreeForCodex } from "./opiu_reconcile.mjs";
import {
  buildStructuralControlInventoryV3,
  materializeStructuralControlInventoryV3,
  planStructuralControlInventoryV3,
} from "./structural_control_inventory_v3.mjs";

function producerTree({ file, sha256, root = "Root", child = "Child", amount = 100.01 }) {
  return buildErpOutlineTree([
    {
      label: root,
      outlineLevel: 0,
      amount,
      source_file: file,
      sheet: "ОПИУ",
      row: 7,
      source_cell: "D7",
      sha256,
      identity: `${sha256}|ОПИУ|7`,
      source_identity_scope: `${sha256}|ОПИУ|2025-10`,
    },
    {
      label: child,
      outlineLevel: 1,
      amount,
      is_group: true,
      source_file: file,
      sheet: "ОПИУ",
      row: 8,
      source_cell: "D8",
      sha256,
      identity: `${sha256}|ОПИУ|8`,
      source_identity_scope: `${sha256}|ОПИУ|2025-10`,
    },
  ], { requireSourceTrace: true });
}

function verifiedInput(overrides = {}) {
  const period = "2025-10";
  const intalevTree = compactHierarchyTreeForCodex(producerTree({
    file: "intalev.xlsx",
    sha256: "A".repeat(64),
    root: "Финансовые расходы",
    child: "Проценты",
  }));
  const erpTree = compactHierarchyTreeForCodex(producerTree({
    file: "erp.xlsx",
    sha256: "B".repeat(64),
    root: "Финансовые расходы ERP",
    child: "Проценты ERP",
  }));
  return {
    runId: "run-2025-10",
    contextId: "context-2025-10",
    organization: {
      id: "ORG-9-UK",
      name: "9 Управляющая компания",
      path: "Холдинг / 9 Управляющая компания",
    },
    period,
    generatedAt: "2026-08-25T00:00:00.000Z",
    currentRunProvenance: {
      report: { file: "report.xlsx", sha256: "C".repeat(64) },
      codex_input: { file: "report.codex-input.json", sha256: "D".repeat(64) },
      manifest: { file: "report.manifest.json", sha256: "E".repeat(64) },
      scope_verified: true,
      verification_blockers: [],
    },
    hierarchyPeriods: [{
      period,
      status: "PASS",
      source_hierarchy_status: "PASS",
      intalev_hierarchy_status: "PROVEN",
      intalev_tree: intalevTree,
      erp_tree: erpTree,
    }],
    ...overrides,
  };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

async function writeCurrentRunFiles(directory, input) {
  await fs.mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "reconciliation.xlsx");
  const codexInputPath = path.join(directory, "reconciliation.codex-input.json");
  const manifestPath = path.join(directory, "reconciliation.manifest.json");
  const reportBytes = Buffer.from("exact report bytes", "utf8");
  await fs.writeFile(reportPath, reportBytes);
  const reportSHA256 = sha256(reportBytes);
  const plan = planStructuralControlInventoryV3(input);
  const codexDocument = {
    organization: input.organization.name,
    period: input.period,
    report_path: reportPath,
    report_sha256: reportSHA256,
    structural_control_inventory: plan.audit,
  };
  const codexBytes = Buffer.from(`${JSON.stringify(codexDocument, null, 2)}\n`, "utf8");
  await fs.writeFile(codexInputPath, codexBytes);
  const manifestDocument = {
    organization: input.organization.name,
    period: input.period,
    output_path: reportPath,
    output_sha256: reportSHA256,
    structural_control_inventory: plan.audit,
    codex_input_path: codexInputPath,
    codex_input_sha256: sha256(codexBytes),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifestDocument, null, 2)}\n`, "utf8");
  return { reportPath, codexInputPath, manifestPath };
}

test("v3 producer-to-Service fixture is byte-bound and semantically control-only", async () => {
  const fixturePath = new URL("./testdata/structural-control-inventory-v3.fixture.json", import.meta.url);
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const inventoryBytes = Buffer.from(`${JSON.stringify(fixture.inventory, null, 2)}\n`, "utf8");
  const provenanceSHA256 = sha256(Buffer.from(
    JSON.stringify(canonicalValue(fixture.inventory.current_run_provenance)),
    "utf8",
  ));

  assert.equal(fixture.inventory.schema_version, "opiu-structural-control-inventory.v3");
  assert.equal(fixture.binding.schema_version, "opiu-structural-control-inventory-binding.v3");
  assert.equal(fixture.binding.sha256, sha256(inventoryBytes));
  assert.equal(fixture.binding.current_run_provenance_sha256, provenanceSHA256);
  assert.equal(fixture.inventory.intalev_members.every((item) => item.parent_identity), true);
  assert.equal(fixture.inventory.intalev_members.every((item) => item.is_group === true), true);
  assert.equal(fixture.inventory.intalev_members.every((item) => item.candidate_selectable === true), true);
  assert.equal(fixture.inventory.intalev_members.every((item) => item.selectable_root === false), true);
  assert.equal(fixture.inventory.intalev_members.every((item) => item.business_block_declared === false), true);
  assert.equal(fixture.inventory.correction_authority, false);
  assert.equal(fixture.binding.correction_authority, false);
});

test("actual hierarchy producer roots and parent edges survive Codex compaction", () => {
  const produced = buildErpOutlineTree([
    {
      label: "Root",
      outlineLevel: 0,
      amount: 100,
      source_file: "erp.xlsx",
      sheet: "ОПИУ",
      physical_row: 7,
      source_cell: "D7",
      sha256: "A".repeat(64),
    },
    {
      label: "Child",
      outlineLevel: 1,
      amount: 100,
      source_file: "erp.xlsx",
      sheet: "ОПИУ",
      physical_row: 8,
      source_cell: "D8",
      sha256: "A".repeat(64),
    },
  ], { requireSourceTrace: true });

  assert.equal(produced.status, "PASS");
  assert.equal(produced.roots.length, 1);
  const rootID = produced.roots[0];
  const producedChild = produced.nodes.find((node) => node.label === "Child");
  assert.equal(producedChild.parent_id, rootID);

  const compact = compactHierarchyTreeForCodex(produced);
  assert.deepEqual(compact.root_node_ids, [rootID]);
  const compactChild = compact.nodes.find((node) => node.label === "Child");
  assert.equal(compactChild.parent_node_id, rootID);
});

test("conflicting producer and canonical hierarchy fields block rather than guess", () => {
  const tree = producerTree({ file: "erp.xlsx", sha256: "C".repeat(64) });
  tree.root_node_ids = ["forged-root"];
  tree.nodes[1].parent_node_id = "forged-parent";

  const compact = compactHierarchyTreeForCodex(tree);
  assert.equal(compact.status, "BLOCKED");
  assert.deepEqual(compact.root_node_ids, []);
  assert.equal(compact.nodes[1].parent_node_id, undefined);
  assert.deepEqual(
    compact.blockers.map((item) => item.code).sort(),
    ["PARENT_FIELD_CONFLICT", "ROOT_FIELD_CONFLICT"],
  );
});

test("fully verified exact hierarchy creates canonical v3 candidate inventory without changing default processing", () => {
  const first = buildStructuralControlInventoryV3(verifiedInput());
  const second = buildStructuralControlInventoryV3(verifiedInput({
    generatedAt: "2026-08-25T01:00:00.000Z",
  }));

  assert.equal(first.status, "VERIFIED");
  assert.equal(first.inventory.schema_version, "opiu-structural-control-inventory.v3");
  assert.equal(first.inventory.inventory_id, second.inventory.inventory_id);
  assert.equal(first.inventory.organization.id, "ORG-9-UK");
  assert.equal(first.inventory.organization.path, "Холдинг / 9 Управляющая компания");
  assert.equal(first.inventory.intalev_members.length, 1);
  assert.equal(first.inventory.erp_members.length, 1);
  assert.equal(first.inventory.intalev_members[0].amount_cents, 10001);
  assert.equal(first.inventory.intalev_members[0].source_identity, `${"A".repeat(64)}|ОПИУ|8`);
  assert.equal(first.inventory.intalev_members[0].source.source_cell, "D8");
  assert.equal(first.inventory.intalev_members.every((item) => item.selectable_root === false), true);
  assert.equal(first.inventory.intalev_members.every((item) => item.candidate_selectable === true), true);
  assert.equal(first.inventory.intalev_members.every((item) => item.business_block_declared === false), true);
  assert.equal(first.inventory.intalev_members.every((item) => item.requires_user_declaration === true), true);
  assert.equal(first.inventory.candidate_semantics, "USER_DECLARED_CONTROL_ONLY");
  assert.equal(first.inventory.automatic_business_block_classification, false);
  assert.equal(first.inventory.user_declaration_required, true);
  assert.equal(first.inventory.default_behavior, "PROCESS_ALL_DISCREPANCIES");
  assert.equal(first.inventory.optional_control_only, true);
  assert.equal(first.inventory.correction_authority, false);
  assert.equal(first.inventory.financial_rows, 0);
  assert.deepEqual(first.inventory.safety, {
    mode: "REPORT_ONLY",
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    execution_allowed: false,
    live_1c_allowed: false,
  });
});

test("missing exact organization identity is blocked while observed members remain diagnostic-only", () => {
  const input = verifiedInput();
  input.organization = { name: input.organization.name, path: input.organization.path };
  const result = buildStructuralControlInventoryV3(input);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.inventory.intalev_members.length, 1);
  assert.equal(result.inventory.erp_members.length, 1);
  assert.equal(result.inventory.correction_authority, false);
  assert.equal(result.inventory.safety.posting_rows, 0);
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_ORGANIZATION_ID_MISSING"));
  assert.equal(result.inventory.default_behavior, "PROCESS_ALL_DISCREPANCIES");
});

test("organization display-name scope drift is blocked", () => {
  const result = buildStructuralControlInventoryV3({
    ...verifiedInput(),
    reconciliationOrganizationName: "1 Хабаровск",
  });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_ORGANIZATION_NAME_SCOPE_MISMATCH"));
});

test("a year command cannot create one cross-month inventory", () => {
  const october = verifiedInput();
  const november = verifiedInput({ period: "2025-11" });
  november.hierarchyPeriods[0].period = "2025-11";
  const result = buildStructuralControlInventoryV3({
    ...october,
    period: "2025",
    hierarchyPeriods: [october.hierarchyPeriods[0], november.hierarchyPeriods[0]],
  });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_CONCRETE_MONTH_REQUIRED"));
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_EXACT_PERIOD_HIERARCHY_MISSING"));
  assert.equal(result.inventory.default_behavior, "PROCESS_ALL_DISCREPANCIES");
});

test("duplicate exact hierarchy identity is blocked while unique observed members remain diagnostic-only", () => {
  const input = verifiedInput();
  input.hierarchyPeriods[0].erp_tree.nodes.push({ ...input.hierarchyPeriods[0].erp_tree.nodes[0] });
  const result = buildStructuralControlInventoryV3(input);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.inventory.erp_members.length, 1);
  assert.equal(result.inventory.correction_authority, false);
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_NODE_ID_DUPLICATE" && item.side === "ERP"));
});

test("conflicting source scope hashes are blocked while observed members remain diagnostic-only", () => {
  const input = verifiedInput();
  input.hierarchyPeriods[0].erp_tree.nodes[1].source.sha256 = "D".repeat(64);
  const result = buildStructuralControlInventoryV3(input);

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.inventory.erp_members.length, 1);
  assert.equal(result.inventory.correction_authority, false);
  assert.ok(result.inventory.blockers.some((item) =>
    item.code === "STRUCTURAL_INVENTORY_SOURCE_FILE_HASH_CONFLICT" && item.side === "ERP"));
});

test("materializer binds exact verified inventory bytes and writes no binding for blocked inventory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-inventory-"));
  const verifiedDirectory = path.join(tempRoot, "verified");
  try {
    const verified = await materializeStructuralControlInventoryV3({
      outputDirectory: verifiedDirectory,
      ...verifiedInput(),
      currentRunFiles: await writeCurrentRunFiles(verifiedDirectory, verifiedInput()),
    });
    const inventoryBytes = await fs.readFile(path.join(
      verifiedDirectory,
      "structural-control-inventory.json",
    ));
    const bindingBytes = await fs.readFile(path.join(
      verifiedDirectory,
      "structural-control-inventory.binding.json",
    ));
    const binding = JSON.parse(bindingBytes.toString("utf8"));
    assert.equal(binding.sha256, sha256(inventoryBytes));
    assert.equal(verified.audit.inventory_sha256, sha256(inventoryBytes));
    assert.equal(verified.audit.binding_sha256, sha256(bindingBytes));
    assert.equal(binding.inventory_id, verified.inventory.inventory_id);
    assert.equal(binding.organization_name, "9 Управляющая компания");
    assert.equal(binding.organization_path, "Холдинг / 9 Управляющая компания");
    assert.equal(binding.period, "2025-10");
    assert.deepEqual(binding.input_hashes, verified.inventory.input_hashes);
    assert.deepEqual(binding.hierarchy_versions, verified.inventory.hierarchy_versions);
    assert.deepEqual(binding.member_hashes, verified.inventory.member_hashes);
    assert.equal(binding.report.sha256, verified.inventory.current_run_provenance.report.sha256);
    assert.equal(binding.codex_input.sha256, verified.inventory.current_run_provenance.codex_input.sha256);
    assert.equal(binding.manifest.sha256, verified.inventory.current_run_provenance.manifest.sha256);

    const verifiedAgain = await materializeStructuralControlInventoryV3({
      outputDirectory: verifiedDirectory,
      ...verifiedInput({ generatedAt: "2026-08-25T02:00:00.000Z" }),
      currentRunFiles: await writeCurrentRunFiles(
        verifiedDirectory,
        verifiedInput({ generatedAt: "2026-08-25T02:00:00.000Z" }),
      ),
    });
    assert.equal(verifiedAgain.status, "VERIFIED");
    assert.equal(verifiedAgain.inventory.inventory_id, verified.inventory.inventory_id);

    const staleInput = verifiedInput({ runId: "run-stale-rewrap" });
    const stale = await materializeStructuralControlInventoryV3({
      outputDirectory: path.join(tempRoot, "stale"),
      ...staleInput,
      currentRunFiles: {
        reportPath: path.join(verifiedDirectory, "reconciliation.xlsx"),
        codexInputPath: path.join(verifiedDirectory, "reconciliation.codex-input.json"),
        manifestPath: path.join(verifiedDirectory, "reconciliation.manifest.json"),
      },
    });
    assert.equal(stale.status, "BLOCKED");
    assert.equal(stale.audit.verified_binding_written, false);
    assert.ok(stale.inventory.current_run_provenance.verification_blockers.includes(
      "CODEX_INPUT_STRUCTURAL_PLAN_SCOPE_MISMATCH",
    ));
    assert.ok(stale.inventory.current_run_provenance.verification_blockers.includes(
      "MANIFEST_STRUCTURAL_PLAN_SCOPE_MISMATCH",
    ));

    const blockedInput = verifiedInput();
    blockedInput.hierarchyPeriods[0].source_hierarchy_status = "BLOCKED";
    const blocked = await materializeStructuralControlInventoryV3({
      outputDirectory: verifiedDirectory,
      ...blockedInput,
      currentRunFiles: await writeCurrentRunFiles(verifiedDirectory, blockedInput),
    });
    assert.equal(blocked.status, "BLOCKED");
    await fs.access(path.join(verifiedDirectory, "structural-control-inventory.blocked.json"));
    await assert.rejects(fs.access(path.join(
      verifiedDirectory,
      "structural-control-inventory.json",
    )));
    await assert.rejects(fs.access(path.join(
      verifiedDirectory,
      "structural-control-inventory.binding.json",
    )));
    assert.equal(blocked.audit.verified_binding_written, false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
