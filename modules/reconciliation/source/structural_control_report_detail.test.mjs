import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildStructuralControlReportDetail } from "./structural_control_report_detail.mjs";

test("renders separate exact Intalev and ERP member rows with totals and applied version", () => {
  const result = buildStructuralControlReportDetail({
    controls: [{
      control_set_id: "SET-MATERIALIZED",
      period: "2025-10",
      intalev_member_codes: ["R045", "R055"],
      erp_member_codes: ["R045", "R055"],
      intalev_control_total: -9761332.93,
      erp_control_total: -9761332.93,
      control_sum_delta: 0,
      control_reclass_status: "INTRA_CONTROL_SET_RECLASS_CLOSED",
      member_rows: [
        { code: "R045", intalev_amount: -15282645.33, erp_amount: -11318179.46 },
        { code: "R055", intalev_amount: 5521312.40, erp_amount: 1556846.53 },
      ],
    }],
    settingsAudit: {
      sets: [{ id: "SET-MATERIALIZED", name: "Финансовая и внереализационная деятельность" }],
      ui_fixed_registry: { applied_versions: [{
        materialized_set_id: "SET-MATERIALIZED", control_set_id: "FIXED-1", version: 3,
        origin_run_id: "RUN-OCT-ORIGIN",
      }] },
      current_hierarchy_binding: { bindings: [{
        period: "2025-10", control_set_id: "SET-MATERIALIZED",
        intalev: [
          { current_row_code: "R045", name: "Результат по финансовой деятельности", hierarchy_path: "Инталев / Финансы" },
          { current_row_code: "R055", name: "Результат по внереализационной деятельности", hierarchy_path: "Инталев / Внереализационные" },
        ],
        erp: [
          { current_row_code: "R045", name: "Итоги по финансовой деятельности", hierarchy_path: "ERP / Финансы" },
          { current_row_code: "R055", name: "Итоги по внереализационной деятельности", hierarchy_path: "ERP / Внереализационные" },
        ],
      }] },
    },
  });
  assert.equal(result.row_count, 4);
  assert.deepEqual(result.rows.map((row) => row[3]), ["Инталев", "Инталев", "ERP", "ERP"]);
  assert.deepEqual(result.rows.map((row) => row[4]), ["R045", "R055", "R045", "R055"]);
  assert.equal(result.rows[0][7], -15282645.33);
  assert.equal(result.rows[2][8], -11318179.46);
  assert.equal(result.rows[2][9], 11318179.46);
  assert.equal(result.rows[0][10], -9761332.93);
  assert.equal(result.rows[0][12], 0);
  assert.match(result.rows[0][14], /FIXED-1.*версия 3.*RUN-OCT-ORIGIN/);
  assert.equal(result.financial_rows, 0);
  assert.equal(result.posting_rows, 0);
});

test("keeps package-default controls visible when exact UI paths are absent", () => {
  const result = buildStructuralControlReportDetail({
    controls: [{
      control_set_id: "DEFAULT-R045-R055", period: "2025-10",
      intalev_member_codes: ["R045"], erp_member_codes: ["R055"],
      intalev_control_total: 100, erp_control_total: 100, control_sum_delta: 0,
      classification: "STRUCTURAL_GROUP_SUM_OK",
      member_rows: [
        { code: "R045", intalev_amount: 100, erp_amount: 0 },
        { code: "R055", intalev_amount: 0, erp_amount: 100 },
      ],
    }],
  });
  assert.equal(result.row_count, 2);
  assert.equal(result.rows[0][4], "R045");
  assert.equal(result.rows[1][4], "R055");
  assert.equal(result.rows[0][14], "Настройка комплекта по умолчанию");
});

test("07_Контроли keeps its summary and appends the business detail table", () => {
  const source = fs.readFileSync(new URL("./opiu_reconcile.mjs", import.meta.url), "utf8");
  assert.match(source, /buildStructuralControlReportDetail\(\{\s*controls: reportStructuralControlResults,\s*settingsAudit: structuralControlSettingsAudit,/s);
  assert.match(source, /structural_control_settings_binding: structuralControlSettingsAudit,/);
  assert.match(source, /codexInput\?\.structural_control_settings_binding \?\? structuralControlSettingsAudit,/);
  assert.doesNotMatch(source, /structural_control_settings_binding: structuralControlSettingsBinding\.audit,/);
  assert.doesNotMatch(source, /codexInput\?\.structural_control_settings_binding \?\? structuralControlSettingsBinding\.audit,/);
  assert.match(source, /Детали структурных групп — выбранные блоки Инталев и ERP/);
  assert.match(source, /STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS/);
  assert.match(source, /\["07_Контроли", `A1:O\$\{controlsEndRow\}`\]/);
  assert.match(source, /styleData\(controlsSheet\.getRange\(`A5:D\$\{summaryEndRow\}`\)\)/);
});
