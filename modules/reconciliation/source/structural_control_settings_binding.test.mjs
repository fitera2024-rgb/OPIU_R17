import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertUniqueStructuralControlScopeArguments,
  loadStructuralControlSettingsDocument,
  materializeStructuralControlSettingsForRun,
  readStructuralControlSettingsCsv,
} from "./structural_control_settings_binding.mjs";

test("duplicate structural settings and run identity argv fail closed", () => {
  assert.doesNotThrow(() => assertUniqueStructuralControlScopeArguments([
    "--structural-control-settings", "one.json", "--organization-id", "ORG-9",
  ]));
  assert.throws(() => assertUniqueStructuralControlScopeArguments([
    "--structural-control-settings", "one.json", "--structural-control-settings", "two.json",
  ]), /DUPLICATE_ARGUMENT:structural-control-settings/);
  assert.throws(() => assertUniqueStructuralControlScopeArguments([
    "--organization-path", "A", "--organization-path", "B",
  ]), /DUPLICATE_ARGUMENT:organization-path/);
});

const HEADER = "Организация;Название группы;Блоки Инталев;Блоки ERP;Активна";
const ROWS = [
  "ORG-MULTI;Финансовая и внереализационная деятельность;I_FIN I_NON;E_FIN E_NON;да",
  "ORG-MULTI;Реализационные и административные расходы;I_SELL;E_ADMIN;да",
  "OTHER-ORG;Чужая группа;O_I;O_E;да",
];

async function temporaryCsv(t, lines = ROWS) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-structural-settings-"));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const csvPath = path.join(directory, "structural-settings.csv");
  await fs.writeFile(csvPath, [HEADER, ...lines, ""].join("\n"), "utf8");
  return { directory, csvPath };
}

test("split Intalev/ERP business CSV materializes and reloads two exact sets for all months", async (t) => {
  const { directory, csvPath } = await temporaryCsv(t);
  const parsed = await readStructuralControlSettingsCsv(csvPath);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0].intalev_member_codes, ["I_FIN", "I_NON"]);
  assert.deepEqual(parsed.rows[0].erp_member_codes, ["E_FIN", "E_NON"]);

  for (let month = 1; month <= 12; month += 1) {
    const period = `2025-${String(month).padStart(2, "0")}`;
    const outputPath = path.join(directory, `${period}.json`);
    const materialized = await materializeStructuralControlSettingsForRun({
      csvPath,
      organization: "ORG-MULTI",
      period,
      outputPath,
    });
    assert.equal(materialized.status, "EXACT_ORGANIZATION_MATERIALIZED");
    assert.equal(materialized.document.structural_group_control_sets.length, 2);
    const loaded = await loadStructuralControlSettingsDocument(outputPath, {
      organization: "ORG-MULTI",
      period,
    });
    assert.equal(loaded.audit.status, "ACTIVE_EXACT_ORGANIZATION_MONTH");
    assert.equal(loaded.audit.set_count, 2);
    assert.equal(loaded.groups.length, 2);
    assert.deepEqual(loaded.groups[0].intalev_member_codes, ["I_FIN", "I_NON"]);
    assert.deepEqual(loaded.groups[0].erp_member_codes, ["E_FIN", "E_NON"]);
  }
});

test("split settings reject cross-org, stale period, overlap and ambiguous duplicates", async (t) => {
  const { directory, csvPath } = await temporaryCsv(t);
  const other = await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: "MISSING-ORG",
    period: "2025-10",
    outputPath: path.join(directory, "missing.json"),
  });
  assert.equal(other.status, "NO_EXACT_ORGANIZATION");

  const outputPath = path.join(directory, "exact.json");
  await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: "ORG-MULTI",
    period: "2025-10",
    outputPath,
  });
  await assert.rejects(
    loadStructuralControlSettingsDocument(outputPath, {
      organization: "ORG-MULTI",
      period: "2025-11",
    }),
    /RUN_SCOPE_MISMATCH/,
  );

  const overlap = await temporaryCsv(t, [
    "ORG-MULTI;Первая;I1;E1;да",
    "ORG-MULTI;Вторая;I2;E1;да",
  ]);
  await assert.rejects(readStructuralControlSettingsCsv(overlap.csvPath), /CSV_CODE_OVERLAP/);
  const duplicate = await temporaryCsv(t, ["ORG-MULTI;Дубли;I1 I1;E1;да"]);
  await assert.rejects(readStructuralControlSettingsCsv(duplicate.csvPath), /CSV_CODE_DUPLICATE/);
});

test("UI-fixed split settings bind a later exact run to active origin versions and reject drift", async (t) => {
  const { directory, csvPath } = await temporaryCsv(t, [
    "9 Управляющая компания;Финансовые и внереализационные расходы;R045 R055;R045 R055;да",
  ]);
  const outputPath = path.join(directory, "ui-fixed.json");
  const materialized = await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: "9 Управляющая компания",
    period: "2025-11",
    outputPath,
  });
  const set = materialized.document.structural_group_control_sets[0];
  const oldVersion = {
    control_set_id: "SC-OLD",
    lineage_id: "LINEAGE-FIN",
    version: 1,
    name: set.name,
    organization_id: "ORG-9",
    run_id: "RUN-OCT",
    context_id: "CTX-OCT",
    inventory_id: "INV-OCT",
    inventory_binding_sha256: "B".repeat(64),
    payload_sha256: "C".repeat(64),
    mode: "SUM_DELTA_ONLY",
    expected_control_delta: 0,
    correction_authority: false,
    fixed_at: "2026-08-25T00:00:00Z",
    intalev_members: [{ code: "" }, { code: "" }],
    erp_members: [{ code: "" }, { code: "" }],
  };
  const currentVersion = {
    ...oldVersion,
    control_set_id: "SC-CURRENT",
    version: 2,
    payload_sha256: "D".repeat(64),
    fixed_at: "2026-08-25T01:00:00Z",
  };
  const registry = {
    schema_version: "opiu-structural-control-registry.v1",
    revision: 4,
    drafts: [],
    versions: [oldVersion, currentVersion],
    lifecycle_events: [
      { action: "FIXED", control_set_id: oldVersion.control_set_id },
      { action: "SUPERSEDED", control_set_id: oldVersion.control_set_id },
      { action: "FIXED", control_set_id: currentVersion.control_set_id },
    ],
  };
  const registryPath = path.join(directory, "structural-control-sets.json");
  const registryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.writeFile(registryPath, registryBytes);
  const document = {
    ...materialized.document,
    source: { ...materialized.document.source, format: "UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1" },
    organization_id: "ORG-9",
    organization_name: "9 Управляющая компания",
    organization_path: "Холдинг / 9 Управляющая компания",
    run_id: "RUN-NOV",
    context_id: "CTX-NOV",
    structural_group_control_sets: materialized.document.structural_group_control_sets.map((candidate) => ({
      ...candidate,
      exact_organization_id: "ORG-9",
      member_codes: [],
      intalev_member_codes: [],
      erp_member_codes: [],
      intalev_member_bindings: currentVersion.intalev_members.map((member, index) => ({
        code: member.code,
        hierarchy_path: `ОПИУ / Инталев / Блок ${index + 1}`,
        origin_identity: `I-${index}`,
        origin_inventory_id: currentVersion.inventory_id,
      })),
      erp_member_bindings: currentVersion.erp_members.map((member, index) => ({
        code: member.code,
        hierarchy_path: `ОПИУ / ERP / Блок ${index + 1}`,
        origin_identity: `E-${index}`,
        origin_inventory_id: currentVersion.inventory_id,
      })),
    })),
    ui_fixed_registry: {
      schema_version: registry.schema_version,
      registry_path: registryPath,
      registry_sha256: crypto.createHash("sha256").update(registryBytes).digest("hex").toUpperCase(),
      registry_size: registryBytes.length,
      registry_revision: registry.revision,
      organization_id: "ORG-9",
      organization_name: "9 Управляющая компания",
      organization_path: "Холдинг / 9 Управляющая компания",
      run_id: "RUN-NOV",
      context_id: "CTX-NOV",
      active_versions: [{
        control_set_id: currentVersion.control_set_id,
        lineage_id: currentVersion.lineage_id,
        version: currentVersion.version,
        payload_sha256: currentVersion.payload_sha256,
        materialized_set_id: set.id,
        origin_run_id: currentVersion.run_id,
        origin_context_id: currentVersion.context_id,
        origin_inventory_id: currentVersion.inventory_id,
        origin_inventory_binding_sha256: currentVersion.inventory_binding_sha256,
      }],
    },
  };
  currentVersion.intalev_members = document.structural_group_control_sets[0].intalev_member_bindings.map((binding) => ({
    code: binding.code, hierarchy_path: binding.hierarchy_path, identity: binding.origin_identity,
  }));
  currentVersion.erp_members = document.structural_group_control_sets[0].erp_member_bindings.map((binding) => ({
    code: binding.code, hierarchy_path: binding.hierarchy_path, identity: binding.origin_identity,
  }));
  const typedCsvPath = path.join(directory, "structural-control-settings.ui-fixed.csv");
  const typedCsvBytes = Buffer.from([
    "Организация;Название группы;Пути блоков Инталев;Пути блоков ERP;Активна",
    [
      document.organization,
      set.name,
      document.structural_group_control_sets[0].intalev_member_bindings.map((binding) => binding.hierarchy_path).join(" | "),
      document.structural_group_control_sets[0].erp_member_bindings.map((binding) => binding.hierarchy_path).join(" | "),
      "Да",
    ].join(";"),
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(typedCsvPath, typedCsvBytes);
  document.source = {
    path: typedCsvPath,
    filename: path.basename(typedCsvPath),
    size: typedCsvBytes.length,
    sha256: crypto.createHash("sha256").update(typedCsvBytes).digest("hex").toUpperCase(),
    format: "UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1",
  };
  registry.versions[1] = currentVersion;
  const reboundRegistryBytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await fs.writeFile(registryPath, reboundRegistryBytes);
  document.ui_fixed_registry.registry_sha256 = crypto.createHash("sha256").update(reboundRegistryBytes).digest("hex").toUpperCase();
  document.ui_fixed_registry.registry_size = reboundRegistryBytes.length;
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const exactScope = {
    organization: document.organization,
    period: document.period,
    organizationId: document.organization_id,
    organizationName: document.organization_name,
    organizationPath: document.organization_path,
    runId: document.run_id,
    contextId: document.context_id,
  };
  const loaded = await loadStructuralControlSettingsDocument(outputPath, exactScope);
  assert.equal(loaded.audit.ui_fixed_registry.status, "ACTIVE_UI_FIXED_REGISTRY_VERIFIED");
  assert.deepEqual(loaded.audit.ui_fixed_registry.control_set_ids, [currentVersion.control_set_id]);
  assert.deepEqual(loaded.audit.ui_fixed_registry.applied_versions, [{
    control_set_id: currentVersion.control_set_id,
    materialized_set_id: set.id,
    lineage_id: currentVersion.lineage_id,
    version: currentVersion.version,
    payload_sha256: currentVersion.payload_sha256,
    origin_run_id: currentVersion.run_id,
    origin_context_id: currentVersion.context_id,
    origin_inventory_id: currentVersion.inventory_id,
    origin_inventory_binding_sha256: currentVersion.inventory_binding_sha256,
  }]);
  assert.deepEqual(loaded.groups[0].intalev_member_codes, []);
  assert.deepEqual(loaded.groups[0].erp_member_codes, []);
  assert.equal(loaded.audit.correction_authority, false);
  assert.equal(loaded.audit.financial_rows, 0);
  assert.equal(loaded.audit.posting_rows, 0);

  const tamperedPathBytes = Buffer.from(typedCsvBytes.toString("utf8").replace("ОПИУ / Инталев / Блок 1", "ОПИУ / Инталев / Чужой блок"), "utf8");
  await fs.writeFile(typedCsvPath, tamperedPathBytes);
  const tamperedPathDocument = structuredClone(document);
  tamperedPathDocument.source.size = tamperedPathBytes.length;
  tamperedPathDocument.source.sha256 = crypto.createHash("sha256").update(tamperedPathBytes).digest("hex").toUpperCase();
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedPathDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_SOURCE_PATH_BINDING_MISMATCH/);
  await fs.writeFile(typedCsvPath, typedCsvBytes);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const tamperedHeaderBytes = Buffer.from(typedCsvBytes.toString("utf8").replace("Пути блоков ERP", "Блоки ERP"), "utf8");
  await fs.writeFile(typedCsvPath, tamperedHeaderBytes);
  const tamperedHeaderDocument = structuredClone(document);
  tamperedHeaderDocument.source.size = tamperedHeaderBytes.length;
  tamperedHeaderDocument.source.sha256 = crypto.createHash("sha256").update(tamperedHeaderBytes).digest("hex").toUpperCase();
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedHeaderDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /CSV_HEADERS_INVALID/);
  await fs.writeFile(typedCsvPath, typedCsvBytes);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const tamperedIdentityDocument = structuredClone(document);
  tamperedIdentityDocument.structural_group_control_sets[0].intalev_member_bindings[0].origin_identity = "I-TAMPERED";
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedIdentityDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_MEMBER_BINDING_MISMATCH/);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const tamperedFormatDocument = structuredClone(document);
  tamperedFormatDocument.source.format = "BUSINESS_CSV_SEMICOLON_UTF8";
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedFormatDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /SOURCE_INVALID/);
  const tamperedCodeDocument = structuredClone(document);
  tamperedCodeDocument.structural_group_control_sets[0].intalev_member_bindings[0].code = "R999";
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedCodeDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_MEMBER_BINDING_MISMATCH/);
  const tamperedInventoryDocument = structuredClone(document);
  tamperedInventoryDocument.structural_group_control_sets[0].erp_member_bindings[0].origin_inventory_id = "INV-TAMPERED";
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedInventoryDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_MEMBER_BINDING_MISMATCH/);
  const tamperedSizeDocument = structuredClone(document);
  tamperedSizeDocument.source.size += 1;
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedSizeDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /SOURCE_DRIFT/);
  const tamperedSHADocument = structuredClone(document);
  tamperedSHADocument.source.sha256 = "0".repeat(64);
  await fs.writeFile(outputPath, `${JSON.stringify(tamperedSHADocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /SOURCE_DRIFT/);
  const reorderedPathBytes = Buffer.from(typedCsvBytes.toString("utf8")
    .replace("ОПИУ / Инталев / Блок 1 | ОПИУ / Инталев / Блок 2", "ОПИУ / Инталев / Блок 2 | ОПИУ / Инталев / Блок 1"), "utf8");
  await fs.writeFile(typedCsvPath, reorderedPathBytes);
  const reorderedPathDocument = structuredClone(document);
  reorderedPathDocument.source.size = reorderedPathBytes.length;
  reorderedPathDocument.source.sha256 = crypto.createHash("sha256").update(reorderedPathBytes).digest("hex").toUpperCase();
  await fs.writeFile(outputPath, `${JSON.stringify(reorderedPathDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_SOURCE_PATH_BINDING_MISMATCH/);
  const duplicatePathBytes = Buffer.from(typedCsvBytes.toString("utf8")
    .replace("ОПИУ / Инталев / Блок 1 | ОПИУ / Инталев / Блок 2", "ОПИУ / Инталев / Блок 1 | ОПИУ / Инталев / Блок 1"), "utf8");
  await fs.writeFile(typedCsvPath, duplicatePathBytes);
  const duplicatePathDocument = structuredClone(document);
  duplicatePathDocument.source.size = duplicatePathBytes.length;
  duplicatePathDocument.source.sha256 = crypto.createHash("sha256").update(duplicatePathBytes).digest("hex").toUpperCase();
  await fs.writeFile(outputPath, `${JSON.stringify(duplicatePathDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /CSV_TYPED_PATH_DUPLICATE/);
  await fs.writeFile(typedCsvPath, typedCsvBytes);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  await assert.rejects(
    loadStructuralControlSettingsDocument(outputPath, { ...exactScope, organizationPath: "Холдинг / Другая" }),
    /UI_FIXED_RUN_SCOPE_MISMATCH:organization_path/,
  );
  const duplicateReferenceDocument = structuredClone(document);
  duplicateReferenceDocument.ui_fixed_registry.active_versions.push({
    ...duplicateReferenceDocument.ui_fixed_registry.active_versions[0],
  });
  await fs.writeFile(outputPath, `${JSON.stringify(duplicateReferenceDocument, null, 2)}\n`, "utf8");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_SET_COUNT_MISMATCH|UI_FIXED_REFERENCE_NOT_BIJECTIVE/);
  await fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  await assert.rejects(
    loadStructuralControlSettingsDocument(outputPath, { ...exactScope, runId: "RUN-WRONG" }),
    /UI_FIXED_RUN_SCOPE_MISMATCH/,
  );
  await fs.appendFile(registryPath, " ");
  await assert.rejects(loadStructuralControlSettingsDocument(outputPath, exactScope), /UI_FIXED_REGISTRY_DRIFT/);
});
