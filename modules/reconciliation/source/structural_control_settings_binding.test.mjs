import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadStructuralControlSettingsDocument,
  materializeStructuralControlSettingsForRun,
  readStructuralControlSettingsCsv,
} from "./structural_control_settings_binding.mjs";

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
