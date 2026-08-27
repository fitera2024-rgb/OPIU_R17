function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function code(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sideBindings(control, binding, side) {
  const key = side === "INTALEV" ? "intalev" : "erp";
  const exact = Array.isArray(binding?.[key]) ? binding[key] : [];
  if (exact.length > 0) return exact;
  const codes = side === "INTALEV"
    ? control?.intalev_member_codes
    : control?.erp_member_codes;
  return (Array.isArray(codes) ? codes : []).map((item) => ({ current_row_code: code(item) }));
}

function appliedVersion(settingsAudit, controlSetID) {
  const registry = settingsAudit?.ui_fixed_registry ?? {};
  const refs = registry.applied_versions ?? registry.active_versions ?? [];
  return (Array.isArray(refs) ? refs : []).find((item) =>
    text(item?.materialized_set_id) === controlSetID || text(item?.control_set_id) === controlSetID) ?? null;
}

function versionLabel(ref) {
  if (!ref) return "Настройка комплекта по умолчанию";
  const version = Number.isInteger(Number(ref.version)) ? `версия ${Number(ref.version)}` : "версия не указана";
  const origin = text(ref.origin_run_id) ? `исходный запуск ${text(ref.origin_run_id)}` : "";
  return [text(ref.control_set_id), version, origin].filter(Boolean).join(" · ");
}

export const STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS = Object.freeze([
  "Группа",
  "Название группы",
  "Версия",
  "Сторона",
  "Код",
  "Наименование блока",
  "Полный путь",
  "Сумма Инталев",
  "Сумма ERP",
  "Вклад в дельту",
  "Итого Инталев",
  "Итого ERP",
  "Дельта группы",
  "Статус",
  "Источник настройки",
]);

/**
 * Produces business-readable, non-posting rows for the 07_Контроли sheet.
 * Exact UI-fixed bindings are preferred; legacy package settings remain visible
 * by reporting code when no identity/path proof exists.
 */
export function buildStructuralControlReportDetail({ controls = [], settingsAudit = {} } = {}) {
  const results = Array.isArray(controls) ? controls : [];
  const bindings = settingsAudit?.current_hierarchy_binding?.bindings ?? [];
  const settingSets = settingsAudit?.sets ?? [];
  const rows = [];
  for (const control of results) {
    const controlSetID = text(control?.control_set_id ?? control?.group_id);
    const period = text(control?.period);
    const binding = (Array.isArray(bindings) ? bindings : []).find((item) =>
      text(item?.control_set_id) === controlSetID && text(item?.period) === period) ?? null;
    const setting = (Array.isArray(settingSets) ? settingSets : []).find((item) => text(item?.id) === controlSetID);
    const ref = appliedVersion(settingsAudit, controlSetID);
    const memberRows = Array.isArray(control?.member_rows) ? control.member_rows : [];
    for (const side of ["INTALEV", "ERP"]) {
      for (const selector of sideBindings(control, binding, side)) {
        const rowCode = code(selector?.current_row_code ?? selector?.code);
        const member = memberRows.find((item) => code(item?.code) === rowCode) ?? {};
        const intalevAmount = side === "INTALEV" ? numeric(member?.intalev_amount) : null;
        const erpAmount = side === "ERP" ? numeric(member?.erp_amount) : null;
        const amount = side === "INTALEV" ? intalevAmount : erpAmount;
        rows.push(Object.freeze([
          controlSetID,
          text(setting?.name ?? control?.name),
          ref ? Number(ref.version) : null,
          side === "INTALEV" ? "Инталев" : "ERP",
          rowCode,
          text(selector?.name),
          text(selector?.hierarchy_path ?? selector?.full_path),
          intalevAmount,
          erpAmount,
          amount === null ? null : side === "INTALEV" ? amount : -amount,
          numeric(control?.intalev_control_total),
          numeric(control?.erp_control_total),
          numeric(control?.control_sum_delta ?? control?.control_delta),
          text(control?.control_reclass_status ?? control?.classification),
          versionLabel(ref),
        ]));
      }
    }
  }
  return Object.freeze({
    schema: "opiu-structural-control-report-detail.v1",
    headers: STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS,
    rows: Object.freeze(rows),
    row_count: rows.length,
    correction_authority: false,
    financial_rows: 0,
    posting_rows: 0,
  });
}
