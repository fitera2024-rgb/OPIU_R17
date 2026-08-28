import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  coreArgsWithUserStructuralControlSettings,
  verifyServiceStructuralControlSettings,
} from "./service_r005_owner_wrapper.mjs";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-014-"));
  const csvPath = path.join(directory, "groups.csv");
  const outputPath = path.join(directory, "reconciliation.xlsx");
  await fs.writeFile(csvPath, [
    "Организация;Название группы;Коды верхних блоков;Активна",
    "9 Управляющая компания;Финансовые и внереализационные расходы;R045,R055;Да",
    "",
  ].join("\n"), "utf8");
  return { directory, csvPath, outputPath };
}

function baseArgs(outputPath) {
  return [
    "run",
    "--organization", "9 Управляющая компания",
    "--period", "2025-10",
    "--output", outputPath,
  ];
}

test("service-none suppresses an existing packaged/default CSV", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  const result = await coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-none",
  ], { csvPath: item.csvPath });
  assert.equal(result.selection.authority, "service-none");
  assert.equal(result.selection.status, "SERVICE_NO_SETTINGS");
  assert.equal(result.argv.includes("--structural-control-settings"), false);
  assert.equal(result.argv.includes("--structural-control-authority"), false);
  await assert.rejects(fs.stat(item.outputPath.replace(/\.xlsx$/i, ".structural-control-settings.json")), /ENOENT/);
});

test("service-csv materializes only the exact explicit run-owned CSV", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  const result = await coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-csv",
    "--structural-control-settings-csv", item.csvPath,
  ], { csvPath: path.join(item.directory, "must-not-be-used.csv") });
  assert.equal(result.selection.authority, "service-csv");
  assert.equal(result.selection.status, "EXACT_ORGANIZATION_MATERIALIZED");
  const index = result.argv.indexOf("--structural-control-settings");
  assert.notEqual(index, -1);
  assert.equal(result.argv[index + 1], result.selection.path);
  assert.equal(result.argv.includes("--structural-control-authority"), false);
  assert.equal(result.argv.includes("--structural-control-settings-csv"), false);
  const document = JSON.parse(await fs.readFile(result.selection.path, "utf8"));
  assert.equal(document.organization, "9 Управляющая компания");
  assert.equal(document.period, "2025-10");
  assert.equal(document.source.path, path.resolve(item.csvPath));
  assert.equal(document.structural_group_control_sets.length, 1);
});

test("service-json preserves exactly one explicit settings document", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  const settingsPath = path.join(item.directory, "fixed.json");
  const argv = [
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-json",
    "--structural-control-settings", settingsPath,
  ];
  const result = await coreArgsWithUserStructuralControlSettings(argv, { csvPath: item.csvPath });
  assert.deepEqual(result.argv, [
    ...baseArgs(item.outputPath),
    "--structural-control-settings", settingsPath,
  ]);
  assert.equal(result.selection.authority, "service-json");
  assert.equal(result.selection.status, "EXPLICIT_CLI_SETTINGS");
  assert.equal(result.selection.path, path.resolve(settingsPath));
});

test("service authority rejects mixed, duplicate, and missing arguments", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-none",
    "--structural-control-settings-csv", item.csvPath,
  ]), /SERVICE_NONE_ARGUMENT_INVALID/);
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-csv",
  ]), /SERVICE_CSV_ARGUMENT_INVALID/);
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-json",
    "--structural-control-settings", "one.json",
    "--structural-control-settings", "two.json",
  ]), /AUTHORITY_DUPLICATE/);
});

test("standalone mode retains the legacy packaged CSV fallback", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  const result = await coreArgsWithUserStructuralControlSettings(baseArgs(item.outputPath), { csvPath: item.csvPath });
  assert.equal(result.selection.authority, "standalone");
  assert.equal(result.selection.status, "EXACT_ORGANIZATION_MATERIALIZED");
  assert.equal(result.argv.includes("--structural-control-settings"), true);
});

test("service verifier binds exact canonical CSV semantics and rejects same-count JSON tamper", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  await fs.writeFile(item.csvPath, [
    "Организация;Название группы;Блоки Инталев;Блоки ERP;Активна",
    "9 Управляющая компания;Финансовые и внереализационные расходы;R045;R055;Да",
    "",
  ].join("\n"), "utf8");
  const materialized = await coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-csv",
    "--structural-control-settings-csv", item.csvPath,
  ]);
  const settingsPath = materialized.selection.path;
  const verificationPath = path.join(item.directory, "verification.json");
  const verification = await verifyServiceStructuralControlSettings({
    csvPath: item.csvPath,
    settingsPath,
    organization: "9 Управляющая компания",
    period: "2025-10",
    outputPath: verificationPath,
  });
  assert.equal(verification.status, "EXACT_ORGANIZATION_MATERIALIZED");
  assert.equal(verification.settings_path, path.resolve(settingsPath));
  assert.equal(verification.set_count, 1);
  assert.deepEqual(verification.set_ids, [materialized.selection.document.structural_group_control_sets[0].id]);

  const serviceBound = await coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-json",
    "--structural-control-settings", settingsPath,
    "--structural-control-selection-proof", verificationPath,
  ]);
  assert.equal(serviceBound.selection.path, path.resolve(settingsPath));
  assert.equal(serviceBound.selection.verified_settings_sha256, verification.settings_sha256);
  assert.deepEqual(serviceBound.selection.verified_set_ids, verification.set_ids);

  const original = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const mutators = {
    name: (document) => { document.structural_group_control_sets[0].name = "Подменённая группа"; },
    member: (document) => { document.structural_group_control_sets[0].member_codes[0] = "R999"; },
    split: (document) => { document.structural_group_control_sets[0].intalev_member_codes[0] = "R999"; },
    id: (document) => { document.structural_group_control_sets[0].id = "USER-STRUCTURAL-00000000000000000000"; },
  };
  for (const [label, mutate] of Object.entries(mutators)) {
    const document = structuredClone(original);
    mutate(document);
    const tamperedPath = path.join(item.directory, `tampered-${label}.json`);
    await fs.writeFile(tamperedPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await assert.rejects(verifyServiceStructuralControlSettings({
      csvPath: item.csvPath,
      settingsPath: tamperedPath,
      organization: "9 Управляющая компания",
      period: "2025-10",
      outputPath: path.join(item.directory, `tampered-${label}.verification.json`),
    }), /DOCUMENT_SOURCE_BINDING_MISMATCH/);
  }
});

test("service selection proof read is bounded, reparse-safe, and exact-path bound", async (t) => {
  const item = await fixture();
  t.after(() => fs.rm(item.directory, { recursive: true, force: true }));
  const oversized = path.join(item.directory, "oversized-proof.json");
  await fs.writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-none",
    "--structural-control-selection-proof", oversized,
  ]), /SELECTION_PROOF_UNSAFE/);

  const materialized = await coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-csv",
    "--structural-control-settings-csv", item.csvPath,
  ]);
  const verificationPath = path.join(item.directory, "exact-proof.json");
  await verifyServiceStructuralControlSettings({
    csvPath: item.csvPath,
    settingsPath: materialized.selection.path,
    organization: "9 Управляющая компания",
    period: "2025-10",
    outputPath: verificationPath,
  });
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-json",
    "--structural-control-settings", path.join(item.directory, "other-settings.json"),
    "--structural-control-selection-proof", verificationPath,
  ]), /SELECTION_PROOF_SETTINGS_INVALID/);

  const symlinkPath = path.join(item.directory, "proof-link.json");
  try {
    await fs.symlink(verificationPath, symlinkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.diagnostic(`symlink regression skipped: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(coreArgsWithUserStructuralControlSettings([
    ...baseArgs(item.outputPath),
    "--structural-control-authority", "service-json",
    "--structural-control-settings", materialized.selection.path,
    "--structural-control-selection-proof", symlinkPath,
  ]), /SELECTION_PROOF_UNSAFE/);
});
