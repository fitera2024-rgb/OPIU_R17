import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import JSZip from "jszip";
import { unprovenOneSideReviews } from "./r005_review_routing.mjs";
import { aggregateAnnualMonthlyResults, buildAnalyticalContext } from "./r001_analytical_policy.mjs";
import { CORRECTION_SELF_DISCOVERY_POLICY } from "./correction_self_discovery_policy.mjs";
import {
  materializeOwnerEconomicDrafts,
  materializeSparseEconomicDrafts,
} from "./r001_sporno_materialization.mjs";
import { LOADER_A_AA_FIELDS } from "./r001_materialization_contract.mjs";
import {
  collectCanonicalFinancialOutput,
  verifyCanonicalOutputIntegrity,
} from "./r001_canonical_output_contract.mjs";
import {
  deriveCurrentRunCanonicalAuthority,
  stripExternalCanonicalAuthority,
} from "./r001_current_run_authority.mjs";
import { normalizeEmbeddedReconciliationDecisions } from "./r001_reconciliation_workbook_adapter.mjs";
import { catalogNodesFromReconciliationRows } from "./r001_group_scoped_posting_rule.mjs";
import { evaluateGroupScopedDecision } from "./r001_group_scoped_materialization.mjs";
import {
  deriveHierarchyExactAmountAuthority,
  hierarchyContextByCode,
} from "./r001_hierarchy_authority.mjs";

const ENGINE_VERSION = "opiu-correction-engine-r001";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_FILE = path.resolve(MODULE_DIR, "correction_engine_r001.mjs");
const ANALYTICAL_POLICY_FILE = path.resolve(MODULE_DIR, "r001_analytical_policy.mjs");
const SELF_DISCOVERY_POLICY_FILE = path.resolve(MODULE_DIR, "correction_self_discovery_policy.mjs");

const COLORS = Object.freeze({
  navy: "#1F4E78",
  teal: "#0F6B78",
  blue: "#5B9BD5",
  paleBlue: "#D9EAF7",
  paleGreen: "#E2F0D9",
  paleYellow: "#FFF2CC",
  paleOrange: "#FCE4D6",
  paleRed: "#F4CCCC",
  gray: "#E7E6E6",
  white: "#FFFFFF",
  border: "#B4C6E7",
  red: "#C00000",
  green: "#006100",
});

const AMOUNT_FORMAT = '#,##0.00;[Red]-#,##0.00;0.00';
const DATE_FORMAT = "dd.mm.yyyy";

const LOADER_HEADERS = LOADER_A_AA_FIELDS;

const OWNER_UPLOAD_TEMPLATE = "[ORGANIZATION][DATE]_ОПИУ_ГОТОВО.xlsx";
const DELETION_WORKBOOK_TEMPLATE = "Удаление_операций_ОПИУ_УК_YEAR_R005.xlsx";
const CORRECTIONS_REGISTRY_TEMPLATE = "Реестр_корректировок_ОПИУ_УК_YEAR_R005.xlsx";
const DISCREPANCY_REGISTRY_TEMPLATE = "Реестр_проводок_расхождений_ОПИУ_PERIOD_R005.xlsx";

const DECISION_FIELDS = [
  ["case_id", "CaseID"],
  ["decision_type", "Тип решения"],
  ["approval_state", "Решение владельца"],
  ["period", "Период"],
  ["reconciliation_row", "Строка сверки"],
  ["group", "Группа"],
  ["role", "Роль доказательства"],
  ["source_archive_path", "Архив источника ERP"],
  ["source_archive_sha256", "SHA256 архива источника ERP"],
  ["journal_entry", "Файл журнала внутри архива"],
  ["journal_sha256", "SHA256 журнала ERP"],
  ["source_sheet", "Лист источника ERP"],
  ["source_row_id", "SourceRowID ERP"],
  ["source_range", "ERP файл/лист/диапазон"],
  ["source_date", "Дата источника"],
  ["registrar", "Регистратор/документ"],
  ["posting_number", "№ проводки источника"],
  ["source_dt", "Дт источник"],
  ["source_analytics_dt1", "Аналитика Дт источник 1"],
  ["source_analytics_dt2", "Аналитика Дт источник 2"],
  ["source_analytics_dt3", "Аналитика Дт источник 3"],
  ["source_department_dt", "Подразделение Дт источник"],
  ["source_kt", "Кт источник"],
  ["source_analytics_kt1", "Аналитика Кт источник 1"],
  ["source_analytics_kt2", "Аналитика Кт источник 2"],
  ["source_analytics_kt3", "Аналитика Кт источник 3"],
  ["source_department_kt", "Подразделение Кт источник"],
  ["organization", "Организация"],
  ["reconciliation_organization", "Организация сверки"],
  ["source_organization", "Организация источника ERP"],
  ["materialization_state", "Статус материализации"],
  ["source_amount", "Физическая сумма источника"],
  ["correction_amount", "Сумма корректировки"],
  ["change_side", "Изменяемая сторона"],
  ["target_dt", "Дт целевой"],
  ["target_analytics_dt1", "Аналитика Дт целевая 1"],
  ["target_analytics_dt2", "Аналитика Дт целевая 2"],
  ["target_analytics_dt3", "Аналитика Дт целевая 3"],
  ["target_department_dt", "Подразделение Дт целевое"],
  ["target_kt", "Кт целевой"],
  ["target_analytics_kt1", "Аналитика Кт целевая 1"],
  ["target_analytics_kt2", "Аналитика Кт целевая 2"],
  ["target_analytics_kt3", "Аналитика Кт целевая 3"],
  ["target_department_kt", "Подразделение Кт целевое"],
  ["reason", "Причина"],
  ["solution", "Предлагаемое решение"],
  ["erp_source_sha256", "SHA256 первичного ERP источника"],
  ["evidence_state", "Статус доказательства"],
  ["proof_status", "Proof status"],
  ["original_proof_status", "Исходный proof status"],
  ["analytical_effect", "Аналитический эффект Инталев − ERP"],
  ["erp_current", "ERP_CURRENT"],
  ["intalev_target", "INTALEV_TARGET"],
  ["target_article", "Целевая статья analytical"],
  ["target_code", "Код целевой статьи"],
  ["target_subkonto_slot", "Слот целевой аналитики"],
  ["settlement_account", "Счет расчетов Инталев"],
  ["source_operating_account", "Счет доходов/расходов Инталев"],
  ["intalev_block", "Блок Инталев"],
  ["intalev_path", "Полный путь Инталев"],
  ["group_scoped_target_status", "Статус выбора статьи по блоку"],
  ["target_catalog_path", "Путь целевой статьи ERP"],
  ["target_operating_account", "Счет целевой статьи ERP"],
  ["group_scoped_target_blocker", "Блокер выбора статьи по блоку"],
  ["disclosure_group", "Группа раскрытия analytical"],
  ["target_side", "Целевая сторона analytical"],
  ["review_state", "Review state"],
  ["gap_evidence_ref", "Доказательство односторонней дельты"],
  ["delete_document_type", "Тип удаляемого документа"],
  ["delete_document_number", "Номер удаляемого документа"],
  ["delete_posting_number", "№ удаляемой проводки"],
  ["keep_document_number", "Номер сохраняемого документа"],
  ["source_rows", "Строки первичного журнала"],
  ["effect_sha256", "SHA256 эффекта/набора проводок"],
  ["pair_id", "PairID"],
  ["notes", "Комментарий"],
  ["source_article_missing", "Исходная статья отсутствует"],
  ["source_article", "Исходная статья"],
];

const DECISION_LABEL_TO_KEY = new Map(DECISION_FIELDS.map(([key, label]) => [label, key]));
const APPROVED = new Set(["ДОКАЗАНО_СВЕРКОЙ", "УТВЕРЖДЕНО", "APPROVED"]);
const ALLOWED_TYPES = new Set([
  "STORNO_REPOST", "ADD_ONE_SIDE", "DELETE_OPERATION", "DELETE_POSTING",
  "NO_POSTING", "UPDATE_MAPPING", "UPDATE_FORMULA",
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) args[key] = true;
    else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function clean(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function scopedManifestRunIdentity(sourceRunId, internalRunId) {
  const engineRunId = clean(internalRunId);
  return {
    run_id: clean(sourceRunId) || engineRunId,
    engine_run_id: engineRunId,
  };
}

function normalizedApproval(value) {
  return clean(value).toUpperCase();
}

function normalizedType(value) {
  return clean(value).toUpperCase();
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = clean(value).replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveMoney(value) {
  const amount = numberValue(value);
  if (amount === null || Math.abs(amount) < 0.0000001) return null;
  return Math.round((Math.abs(amount) + Number.EPSILON) * 100) / 100;
}

function formatMoneyText(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : "не определена";
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/i.test(clean(value));
}

function isExplicit(value) {
  return clean(value) !== "";
}

function firstExplicitValue(record, keys) {
  for (const key of keys) if (isExplicit(record?.[key])) return record[key];
  return null;
}

function normalizeDateText(value) {
  const text = clean(value);
  if (!text) return "";
  let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (match) return `${match[1]}.${match[2]}.${match[3]}`;
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1]}`;
  return text;
}

function inferPeriod(dateText, fallback = "") {
  const text = normalizeDateText(dateText);
  const match = text.match(/^\d{2}\.(\d{2})\.(\d{4})$/);
  return match ? `${match[2]}-${match[1]}` : fallback;
}

function accountingPeriods(period) {
  const value = clean(period);
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return [value];
  const quarter = value.match(/^(\d{4})-Q([1-4])$/);
  if (quarter) {
    const start = (Number(quarter[2]) - 1) * 3 + 1;
    return [0, 1, 2].map((offset) => `${quarter[1]}-${String(start + offset).padStart(2, "0")}`);
  }
  if (/^\d{4}$/.test(value)) return Array.from({ length: 12 }, (_, index) => `${value}-${String(index + 1).padStart(2, "0")}`);
  return [];
}

function periodEndDate(period) {
  const match = clean(period).match(/^(\d{4})-(\d{2})$/);
  if (!match) return clean(period);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(lastDay).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

function articleName(value) {
  const text = clean(value);
  return clean(text.replace(/\s*\[[^\]]+\]\s*$/, ""));
}

function stableId(prefix, payload, length = 20) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase();
  return `${prefix}-${hash.slice(0, length)}`;
}

function stableDecisionIdentity(decision) {
  return clean(decision?.embedded_decision_identity)
    || [clean(decision?.case_id), clean(decision?.pair_id), clean(decision?.reconciliation_row), clean(decision?.role)]
      .filter(Boolean).join("|")
    || stableId("CASE", decision);
}

function mergeProvidedAndAutonomousDecisions(providedDecisions, autonomousDecisions = []) {
  if (providedDecisions === null || providedDecisions === undefined) return null;
  const mergedByIdentity = new Map();
  for (const decision of providedDecisions) {
    mergedByIdentity.set(stableDecisionIdentity(decision), decision);
  }
  for (const decision of autonomousDecisions) {
    const identity = stableDecisionIdentity(decision);
    if (!mergedByIdentity.has(identity)) mergedByIdentity.set(identity, decision);
  }
  return [...mergedByIdentity.values()];
}

function excludeHierarchyCoveredEconomicRows(rows, coveredEconomicRouteCaseIds = []) {
  const covered = new Set(coveredEconomicRouteCaseIds.map((caseId) => clean(caseId)).filter(Boolean));
  return rows.filter((row) => !covered.has(clean(row.case_id)) && !covered.has(clean(row.pair_id)));
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function fileSafe(value) {
  return clean(value).replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, "_").slice(0, 90) || "MISSING";
}

function organizationForFile(value) {
  return clean(value)
    .replace(/[«»"„“]/g, " ")
    .replace(/[^\p{L}\p{N}() ._-]+/gu, " ")
    .replace(/\s{3,}/g, "  ")
    .trim()
  .slice(0, 90) || "ОРГАНИЗАЦИЯ НЕ ОПРЕДЕЛЕНА";
}

function ownerUploadOrganizationLabel(value) {
  const text = String(value ?? "").trim();
  if (!text) return "ИСТОЧНИК НЕ ОПРЕДЕЛЕН";
  return text
    .replace(/[«»"„“]/g, " ")
    .replace(/[<>:/\\|?*]/g, "_")
    .trim();
}

function ownerUploadDateLabel(rawPeriod) {
  const text = clean(rawPeriod);
  const monthGroups = text.match(/\d{4}-(0[1-9]|1[0-2])/g);
  const lastMonth = monthGroups && monthGroups.length > 0 ? monthGroups[monthGroups.length - 1] : text;
  return fileSafe(periodEndDate(lastMonth) || lastMonth || "ПЕРИОД");
}

function periodYearLabel(rawPeriod) {
  const text = clean(rawPeriod);
  const monthGroups = text.match(/\d{4}-(0[1-9]|1[0-2])/g);
  const lastMonth = monthGroups && monthGroups.length > 0 ? monthGroups[monthGroups.length - 1] : text;
  return (clean(lastMonth).match(/(\d{4})/) || ["", "MISSING_YEAR"])[1];
}

function deletionWorkbookYearLabel(rawPeriod) {
  const text = clean(rawPeriod);
  const monthGroups = text.match(/\d{4}-(0[1-9]|1[0-2])/g);
  const lastMonth = monthGroups && monthGroups.length > 0 ? monthGroups[monthGroups.length - 1] : text;
  return (clean(lastMonth).match(/(\d{4})/) || ["", "MISSING_YEAR"])[1];
}

function buildOwnerUploadFileName(context) {
  return OWNER_UPLOAD_TEMPLATE
    .replace("ORGANIZATION", ownerUploadOrganizationLabel(context.organization))
    .replace("DATE", ownerUploadDateLabel(context.sourceDate));
}

function buildDisputedOwnerUploadFileName(context) {
  return buildOwnerUploadFileName(context).replace(/\.xlsx$/i, "_СПОРНО.xlsx");
}

function buildDeletionWorkbookFileName(rawPeriod) {
  return DELETION_WORKBOOK_TEMPLATE.replace("YEAR", deletionWorkbookYearLabel(rawPeriod));
}

function buildCorrectionsRegistryFileName(rawPeriod) {
  return CORRECTIONS_REGISTRY_TEMPLATE.replace("YEAR", periodYearLabel(rawPeriod));
}

function buildDiscrepancyRegistryFileName(rawPeriod) {
  const text = clean(rawPeriod);
  const monthGroups = text.match(/\d{4}-(0[1-9]|1[0-2])/g);
  const lastMonth = monthGroups && monthGroups.length > 0 ? monthGroups[monthGroups.length - 1] : text;
  return DISCREPANCY_REGISTRY_TEMPLATE.replace("PERIOD", lastMonth || "2025-01");
}

function isPostingAllowedForDisputedDecision(decision) {
  return clean(decision?.proof_status || decision?.original_proof_status || decision?.evidence_state).toUpperCase() === "PROVEN";
}

function reconciliationDecisionBlocker(decision) {
  const classification = clean(decision?.classification).toUpperCase();
  if (!classification) return "";
  const correctionAllowed = decision?.correction_allowed === true
    && classification === "FINANCIAL_CORRECTION_PROVEN"
    && clean(decision?.proof_status).toUpperCase() === "PROVEN";
  return correctionAllowed
    ? ""
    : `reconciliation_decision=${classification}; сначала завершить hierarchy/binding/reclass/source proof`;
}

function timestampId() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Vladivostok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}${byType.month}${byType.day}-${byType.hour}${byType.minute}${byType.second}`;
}

function writeMatrix(sheet, rowIndex, columnIndex, rows) {
  if (!rows.length) return;
  sheet.getRangeByIndexes(rowIndex, columnIndex, rows.length, rows[0].length).values = rows;
}

function columnLetter(index) {
  let value = Number(index) + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function setWidths(sheet, widths) {
  for (const [indexText, width] of Object.entries(widths)) {
    const index = Number(indexText);
    const column = columnLetter(index);
    sheet.getRange(`${column}:${column}`).format.columnWidth = width;
  }
}

function styleTitle(sheet, rowIndex, colCount, title) {
  const range = sheet.getRangeByIndexes(rowIndex, 0, 1, colCount);
  range.merge();
  range.values = [[title]];
  range.format.fill = COLORS.navy;
  range.format.font = { bold: true, color: COLORS.white, size: 15 };
  range.format.rowHeight = 28;
  range.format.verticalAlignment = "center";
}

function styleNotice(sheet, rowIndex, colCount, text, fill = COLORS.paleYellow, fontColor = "#1F1F1F") {
  const range = sheet.getRangeByIndexes(rowIndex, 0, 1, colCount);
  range.merge();
  range.values = [[text]];
  range.format.fill = fill;
  range.format.font = { bold: true, color: fontColor, size: 10 };
  range.format.wrapText = true;
  range.format.rowHeight = 32;
  range.format.verticalAlignment = "center";
}

function styleHeader(range) {
  range.format.fill = COLORS.teal;
  range.format.font = { bold: true, color: COLORS.white, size: 9 };
  range.format.wrapText = true;
  range.format.verticalAlignment = "center";
  range.format.horizontalAlignment = "center";
  range.format.rowHeight = 40;
  range.format.borders = { preset: "all", style: "thin", color: COLORS.border };
}

function styleBody(range) {
  range.format.font = { size: 9, color: "#1F1F1F" };
  range.format.wrapText = true;
  range.format.verticalAlignment = "top";
  range.format.borders = { preset: "all", style: "thin", color: "#D9E2F3" };
}

function addSheet(workbook, name) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  return sheet;
}

async function saveWorkbook(workbook, filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await (await SpreadsheetFile.exportXlsx(workbook)).save(filePath);
}

function recordsFromMatrix(values, headerRowIndex, fieldMap = null) {
  const headers = values[headerRowIndex].map((value) => clean(value));
  const records = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] ?? [];
    if (row.every((value) => clean(value) === "")) continue;
    const record = { __row: rowIndex + 1 };
    headers.forEach((header, columnIndex) => {
      if (!header) return;
      const key = fieldMap?.get(header) ?? header;
      record[key] = row[columnIndex] ?? null;
    });
    records.push(record);
  }
  return records;
}

function embeddedCatalogContext(workbook, treeAllRecords) {
  const catalogSheet = workbook.worksheets.items.find((item) => /ERP.*стат/i.test(item.name));
  const catalogValues = catalogSheet?.getUsedRange()?.values ?? [];
  const catalogHeader = catalogValues.findIndex((row) =>
    row.some((value) => clean(value) === "Статья ERP")
    && row.some((value) => clean(value) === "Путь по справочнику ERP"));
  const catalogRecords = catalogHeader < 0 ? [] : recordsFromMatrix(catalogValues, catalogHeader);
  const erpCatalogNodes = catalogNodesFromReconciliationRows(catalogRecords);

  const intalevBlockByCode = hierarchyContextByCode(treeAllRecords);
  return Object.freeze({ erpCatalogNodes: Object.freeze(erpCatalogNodes), intalevBlockByCode });
}

async function readReconciliation(reconciliationPath) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(reconciliationPath));
  const passport = workbook.worksheets.items.find((item) => /паспорт/i.test(item.name));
  const passportValues = passport?.getUsedRange()?.values ?? [];
  const passportMap = new Map();
  for (const row of passportValues) {
    const key = clean(row?.[0]);
    if (key) passportMap.set(key.toUpperCase(), row?.[1] ?? "");
  }
  const erpJournalPath = clean(passportMap.get("ERP ЖУРНАЛ"));
  const erpJournalSha = clean(passportMap.get("SHA-256 ERP ЖУРНАЛА")).toUpperCase();
  const reconciliationPeriod = clean(passportMap.get("ПЕРИОД"));
  const reconciliationOrganization = clean(passportMap.get("ОРГАНИЗАЦИЯ")) || clean(passportMap.get("ОРГАНИЗАЦИЯ ERP"));
  let erpJournalHashState = isSha256(erpJournalSha) ? "DECLARED_IN_RECONCILIATION" : "MISSING_IN_RECONCILIATION";
  let erpJournalActualSha = "";
  if (erpJournalPath) {
    try {
      erpJournalActualSha = await sha256(erpJournalPath);
      erpJournalHashState = erpJournalActualSha === erpJournalSha ? "VERIFIED_CURRENT_FILE" : "MISMATCH_CURRENT_FILE";
    } catch {
      // The reconciliation remains an immutable proof package even if the original path is offline.
    }
  }
  const embeddedDecisionRows = [];
  for (const candidateSheet of workbook.worksheets.items) {
    const candidateValues = candidateSheet.getUsedRange()?.values ?? [];
    const candidateHeader = candidateValues.findIndex((row) => row.some((value) => clean(value) === "CaseID") && row.some((value) => clean(value) === "Тип решения"));
    if (candidateHeader < 0) continue;
    for (const record of recordsFromMatrix(candidateValues, candidateHeader, DECISION_LABEL_TO_KEY)) {
      if (isExplicit(record.decision_type)) embeddedDecisionRows.push(record);
    }
  }
  const embeddedDecisions = normalizeEmbeddedReconciliationDecisions(embeddedDecisionRows, {
    period: reconciliationPeriod,
    organization: reconciliationOrganization,
  });
  const treeSheet = workbook.worksheets.items.find((item) => /сверка.*дерево/i.test(item.name));
  const treeValues = treeSheet?.getUsedRange()?.values ?? [];
  const treeHeader = treeValues.findIndex((row) => row.some((value) => clean(value) === "Код / PairID") && row.some((value) => clean(value) === "Тип строки") && row.some((value) => clean(value) === "Организация"));
  const treeAllRecords = treeHeader < 0 ? [] : recordsFromMatrix(treeValues, treeHeader);
  const catalogContext = embeddedCatalogContext(workbook, treeAllRecords);
  const treeRecords = treeAllRecords.filter((row) => {
    const type = clean(row["Тип строки"]).toUpperCase();
    const identityFields = ["Дата", "ERP строка", "Регистратор / документ", "№ проводки", "Дт", "Кт", "Организация", "Физическая сумма"];
    const identityCount = identityFields.filter((field) => isExplicit(row[field])).length;
    return identityCount >= 3 && /(SOURCE|CANDIDATE|ОПЕРАЦ)/i.test(type);
  });
  const sheet = workbook.worksheets.items.find((item) => /доказан.*операц/i.test(item.name));
  if (!sheet) {
    const blocker = embeddedDecisions.length
      ? ""
      : treeRecords.length
        ? `В текущем дереве найдено ERP-операций-кандидатов: ${treeRecords.length}; доказанных SOURCE-операций нет`
        : "Нет листа доказанных операций и ERP-операций в дереве";
    return { workbook, sheetName: treeSheet?.name ?? null, sourceRecords: [], treeRecords, treeAllRecords, embeddedDecisions, blocker, erpJournalPath, erpJournalSha, erpJournalActualSha, erpJournalHashState, reconciliationPeriod, reconciliationOrganization, erpSourcePackageSha: "", erpSourceSheet: "", ...catalogContext };
  }
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const headerRowIndex = values.findIndex((row) => row.some((value) => clean(value) === "PairID") && row.some((value) => clean(value) === "Регистратор"));
  if (headerRowIndex < 0) {
    return { workbook, sheetName: sheet.name, sourceRecords: [], treeRecords, treeAllRecords, embeddedDecisions, blocker: embeddedDecisions.length ? "" : "Не найдена строка заголовков доказанных операций", erpJournalPath, erpJournalSha, erpJournalActualSha, erpJournalHashState, reconciliationPeriod, reconciliationOrganization, erpSourcePackageSha: "", erpSourceSheet: "", ...catalogContext };
  }
  const records = recordsFromMatrix(values, headerRowIndex);
  const sourceRecords = records.filter((row) => clean(row["Роль"]).toUpperCase() === "SOURCE" && /PROVEN_CURRENT_SOURCE_CANDIDATE/i.test(clean(row["Статус"])));
  const sourcePackageHashes = [...new Set(sourceRecords.map((row) => clean(row["SHA-256 ERP пакета"]).toUpperCase()).filter(isSha256))];
  const sourceSheets = [...new Set(sourceRecords.map((row) => clean(row["Лист ERP журнала"])).filter(Boolean))];
  const blocker = sourceRecords.length === 0 && embeddedDecisions.length === 0
    ? "Нет доказанных SOURCE-кандидатов или встроенных решений"
    : erpJournalHashState === "MISMATCH_CURRENT_FILE"
      ? "SHA256 текущего ERP журнала не совпадает со сверкой"
      : !isSha256(erpJournalSha)
        ? "В паспорте сверки нет SHA256 ERP журнала"
        : "";
  return {
    workbook, sheetName: sheet.name, sourceRecords, treeRecords, treeAllRecords, embeddedDecisions, blocker,
    erpJournalPath, erpJournalSha, erpJournalActualSha, erpJournalHashState,
    reconciliationPeriod, reconciliationOrganization,
    erpSourcePackageSha: sourcePackageHashes.length === 1 ? sourcePackageHashes[0] : "",
    erpSourceSheet: sourceSheets.length === 1 ? sourceSheets[0] : "",
    ...catalogContext,
  };
}

function candidateFromSource(row, reconciliationSha, reconciliationEvidence, periodOverride = "", organizationOverride = "") {
  const sourceDate = normalizeDateText(row["Дата"]);
  const candidateAmount = positiveMoney(row["Сумма кандидата"]);
  const sourceArticle = clean(row["Исходная статья"]);
  const targetArticle = clean(row["Целевая статья"]);
  const organization = clean(organizationOverride) || clean(row["Организация"]);
  const period = inferPeriod(sourceDate, clean(periodOverride));
  const pairId = clean(row["PairID"]) || stableId("PAIR", [row["ERP диапазон"], row["№ проводки"], candidateAmount]);
  const storno = numberValue(row["STORNO"]);
  const repost = numberValue(row["REPOST"]);
  const decisionType = storno && repost ? "STORNO_REPOST" : (storno || repost) ? "ADD_ONE_SIDE" : "NO_POSTING";
  return {
    case_id: pairId,
    decision_type: decisionType,
    approval_state: reconciliationEvidence.blocker ? "БЛОКИРОВАНО_СВЕРКОЙ" : "ДОКАЗАНО_СВЕРКОЙ",
    period,
    reconciliation_row: clean(row["Строка сверки"]),
    group: clean(row["Группа"]),
    role: clean(row["Роль"]),
    source_range: clean(row["ERP диапазон"]),
    source_date: sourceDate,
    registrar: clean(row["Регистратор"]),
    posting_number: row["№ проводки"] ?? "",
    source_dt: clean(row["Дт"]),
    source_analytics_dt1: clean(row["Аналитики Дт"]),
    source_analytics_dt2: "—",
    source_analytics_dt3: "—",
    source_department_dt: clean(row["Подразделение Дт"]),
    source_kt: clean(row["Кт"]),
    source_analytics_kt1: clean(row["Аналитики Кт"]),
    source_analytics_kt2: "—",
    source_analytics_kt3: "—",
    source_department_kt: clean(row["Подразделение Кт"]),
    organization,
    source_amount: positiveMoney(row["Физическая сумма"]),
    correction_amount: candidateAmount,
    analytical_effect: numberValue(firstExplicitValue(row, ["Дельта", "Расхождение", "Инталев − ERP", "Инталев - ERP"])),
    analytical_basis_id: clean(row["Строка сверки"] || row["Код"] || pairId),
    erp_current: numberValue(firstExplicitValue(row, ["ERP", "ERP_CURRENT", "Сумма ERP"])),
    intalev_target: numberValue(firstExplicitValue(row, ["Инталев", "INTALEV_TARGET", "Сумма Инталев"])),
    change_side: "Дт",
    target_dt: clean(row["Дт"]),
    target_analytics_dt1: articleName(targetArticle),
    target_analytics_dt2: "—",
    target_analytics_dt3: "—",
    target_department_dt: clean(row["Подразделение Дт"]),
    target_kt: clean(row["Кт"]),
    target_analytics_kt1: clean(row["Аналитики Кт"]),
    target_analytics_kt2: "—",
    target_analytics_kt3: "—",
    target_department_kt: clean(row["Подразделение Кт"]),
    reason: clean(row["Причина"]),
    solution: clean(row["Предлагаемое решение"]),
    erp_source_sha256: reconciliationEvidence.erpJournalSha,
    evidence_state: clean(row["Статус"]),
    gap_evidence_ref: decisionType === "ADD_ONE_SIDE" ? clean(row["ERP диапазон"]) : "",
    delete_document_type: "",
    delete_document_number: "",
    delete_posting_number: "",
    keep_document_number: "",
    source_rows: clean(row["ERP диапазон"]),
    effect_sha256: "",
    pair_id: pairId,
    notes: `Источник сверки SHA256=${reconciliationSha}; ERP журнал SHA256=${reconciliationEvidence.erpJournalSha}; проверка пути=${reconciliationEvidence.erpJournalHashState}`,
  };
}

function candidateFromTree(row, reconciliationSha, reconciliationEvidence, periodOverride = "") {
  const sourceDate = normalizeDateText(row["Дата"]);
  const rowStatus = clean(row["Статус"]);
  const statusUpper = rowStatus.toUpperCase();
  const proven = statusUpper === "PROVEN_CURRENT_SOURCE_CANDIDATE" || statusUpper === "ДОКАЗАНО_СВЕРКОЙ";
  const storno = numberValue(row["STORNO"]);
  const repost = numberValue(row["REPOST"]);
  const sourceToTarget = clean(row["Источник → цель"]);
  const articleParts = sourceToTarget.split(/\s*(?:→|->)\s*/, 2);
  const sourceArticle = clean(articleParts[0]) || clean(row["Строка ОПИУ / операция"]);
  const targetArticle = clean(articleParts[1]);
  const hasExplicitMove = Boolean(targetArticle && sourceArticle && targetArticle !== sourceArticle);
  const decisionType = storno && repost
    ? "STORNO_REPOST"
    : (storno || repost)
      ? "ADD_ONE_SIDE"
      : hasExplicitMove
        ? "STORNO_REPOST"
        : "NO_POSTING";
  const organization = clean(row["Организация"]);
  const amount = positiveMoney(row["Физическая сумма"]);
  const pairId = clean(row["Код / PairID"]) || stableId("TREE", [row["ERP строка"], row["Регистратор / документ"], row["№ проводки"], organization, amount]);
  const evidenceComment = [clean(row["Где исправить"]), clean(row["Комментарий / доказательство"])].filter(Boolean).join(" | ");
  return {
    case_id: pairId,
    decision_type: decisionType,
    approval_state: proven ? "ДОКАЗАНО_СВЕРКОЙ" : "ПРЕДЛОЖЕНО",
    period: inferPeriod(sourceDate, clean(periodOverride)),
    reconciliation_row: clean(row["Код / PairID"]),
    group: clean(row["Строка ОПИУ / операция"]),
    role: clean(row["Тип строки"]),
    source_range: clean(row["ERP строка"]),
    source_date: sourceDate,
    registrar: clean(row["Регистратор / документ"]),
    posting_number: row["№ проводки"] ?? "",
    source_dt: clean(row["Дт"]),
    source_analytics_dt1: clean(row["Аналитики Дт"]) || sourceArticle,
    source_analytics_dt2: "—",
    source_analytics_dt3: "—",
    source_department_dt: clean(row["Подразделение Дт"]),
    source_kt: clean(row["Кт"]),
    source_analytics_kt1: clean(row["Аналитики Кт"]),
    source_analytics_kt2: "—",
    source_analytics_kt3: "—",
    source_department_kt: clean(row["Подразделение Кт"]),
    organization,
    source_amount: amount,
    correction_amount: positiveMoney(storno) || positiveMoney(repost) || amount,
    analytical_effect: numberValue(firstExplicitValue(row, ["Дельта", "Расхождение", "Инталев − ERP", "Инталев - ERP"])),
    analytical_basis_id: clean(row["Код / PairID"] || row["Строка сверки"] || pairId),
    erp_current: numberValue(firstExplicitValue(row, ["ERP", "ERP_CURRENT", "Сумма ERP"])),
    intalev_target: numberValue(firstExplicitValue(row, ["Инталев", "INTALEV_TARGET", "Сумма Инталев"])),
    change_side: "Дт",
    target_dt: clean(row["Дт"]),
    target_analytics_dt1: articleName(targetArticle) || clean(row["Аналитики Дт"]) || sourceArticle,
    target_analytics_dt2: "—",
    target_analytics_dt3: "—",
    target_department_dt: clean(row["Подразделение Дт"]),
    target_kt: clean(row["Кт"]),
    target_analytics_kt1: clean(row["Аналитики Кт"]),
    target_analytics_kt2: "—",
    target_analytics_kt3: "—",
    target_department_kt: clean(row["Подразделение Кт"]),
    reason: clean(row["Что исправить"]) || `ERP-операция из дерева сверки; статус: ${rowStatus}`,
    solution: clean(row["Как исправить"]) || "Подтвердить точную пару/правило в сверке; до подтверждения проводку не создавать",
    erp_source_sha256: reconciliationEvidence.erpJournalSha,
    evidence_state: rowStatus,
    gap_evidence_ref: decisionType === "ADD_ONE_SIDE" ? clean(row["ERP строка"]) : "",
    delete_document_type: "",
    delete_document_number: "",
    delete_posting_number: "",
    keep_document_number: "",
    source_rows: clean(row["ERP строка"]),
    effect_sha256: "",
    pair_id: pairId,
    notes: `${evidenceComment}${evidenceComment ? " | " : ""}Источник сверки SHA256=${reconciliationSha}; статус дерева=${rowStatus}`,
  };
}

async function readDecisionFile(decisionPath, options = {}) {
  if (!decisionPath) return null;
  if (path.extname(decisionPath).toLowerCase() === ".json") {
    const payload = JSON.parse(await fs.readFile(decisionPath, "utf8"));
    if (Array.isArray(payload?.applications)) {
      throw new Error("EXTERNAL_RULE_APPLICATIONS_DISABLED: движок использует только самостоятельный поиск по доказательной сверке");
    }
    const decisions = Array.isArray(payload) ? payload : payload.decisions;
    if (Array.isArray(decisions)) {
      Object.defineProperty(decisions, "analyticalContexts", {
        enumerable: false,
        value: Array.isArray(payload?.analytical_contexts)
          ? payload.analytical_contexts
          : payload?.analytical_context ? [payload.analytical_context] : [],
      });
    }
    return decisions;
  }
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(decisionPath));
  const sheet = workbook.worksheets.items.find((item) => /^Решения$/i.test(item.name)) ?? workbook.worksheets.items.find((item) => /решен/i.test(item.name));
  if (!sheet) throw new Error("В файле решений нет листа «Решения»");
  const values = sheet.getUsedRange()?.values ?? [];
  const headerRowIndex = values.findIndex((row) => row.some((value) => clean(value) === "CaseID"));
  if (headerRowIndex < 0) throw new Error("В листе «Решения» не найден заголовок CaseID");
  return recordsFromMatrix(values, headerRowIndex, DECISION_LABEL_TO_KEY);
}

function validateDecision(decision, reconciliationSha) {
  const errors = [];
  const type = normalizedType(decision.decision_type);
  const approved = APPROVED.has(normalizedApproval(decision.approval_state));
  const amount = positiveMoney(decision.correction_amount);
  const reconciliationBlocker = reconciliationDecisionBlocker(decision);
  const exactCommon = [
    ["period", "не указан период"],
    ["source_range", "нет точного первичного диапазона"],
    ["source_date", "нет даты источника"],
    ["registrar", "нет регистратора/документа"],
    ["posting_number", "нет номера проводки источника"],
    ["source_dt", "нет счета Дт источника"],
    ["source_analytics_dt1", "нет явной аналитики Дт источника"],
    ["source_department_dt", "нет подразделения Дт источника"],
    ["source_kt", "нет счета Кт источника"],
    ["source_analytics_kt1", "нет явной аналитики Кт источника"],
    ["source_department_kt", "нет подразделения Кт источника"],
    ["organization", "нет организации"],
    ["pair_id", "нет PairID"],
  ];

  if (!ALLOWED_TYPES.has(type)) errors.push("неизвестный тип решения");
  if (reconciliationBlocker) errors.push(reconciliationBlocker);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean(decision.period))) errors.push("период корректировки должен быть месяцем YYYY-MM; синтетический годовой период запрещён");
  if (!approved) errors.push("операция является кандидатом: решение не доказано и не утверждено сверкой");
    if (approved) {
    if (!isSha256(reconciliationSha)) errors.push("нет SHA256 сверки");
    if (!isSha256(decision.erp_source_sha256)) errors.push("нет SHA256 первичного ERP источника");
    if (!amount && !["DELETE_OPERATION", "DELETE_POSTING", "NO_POSTING", "UPDATE_MAPPING", "UPDATE_FORMULA"].includes(type)) errors.push("нет ненулевой суммы корректировки");
    if (["STORNO_REPOST", "ADD_ONE_SIDE"].includes(type)) {
      for (const [key, message] of exactCommon) {
        if (!isExplicit(decision[key])) errors.push(message);
      }
      for (const [key, message] of [
        ["target_dt", "нет целевого счета Дт"],
        ["target_analytics_dt1", "нет целевой аналитики Дт"],
        ["target_department_dt", "нет целевого подразделения Дт"],
        ["target_kt", "нет целевого счета Кт"],
        ["target_analytics_kt1", "нет целевой аналитики Кт"],
        ["target_department_kt", "нет целевого подразделения Кт"],
      ]) if (!isExplicit(decision[key])) errors.push(message);
    }
    if (type === "STORNO_REPOST") {
      const sourceSignature = [decision.source_dt, decision.source_analytics_dt1, decision.source_department_dt, decision.source_kt, decision.source_analytics_kt1, decision.source_department_kt].map(clean).join("|");
      const targetSignature = [decision.target_dt, decision.target_analytics_dt1, decision.target_department_dt, decision.target_kt, decision.target_analytics_kt1, decision.target_department_kt].map(clean).join("|");
      if (sourceSignature === targetSignature) errors.push("сторно/репост не изменяет счет, аналитику или подразделение");
    }
    if (type === "ADD_ONE_SIDE") {
      if (!isExplicit(decision.gap_evidence_ref)) errors.push("нет доказательства отсутствующей стороны");
      if (!/ONE[-_]?SIDE/i.test(clean(decision.pair_id))) errors.push("PairID односторонней проводки не содержит ONE_SIDE");
    }
    if (["DELETE_OPERATION", "DELETE_POSTING"].includes(type)) {
      if (clean(decision.delete_document_type).toUpperCase() !== "ОПЕРАЦИЯ МСФО") errors.push("удаление разрешено только для типа «Операция МСФО»");
      if (!isExplicit(decision.delete_document_number)) errors.push("нет номера удаляемого документа");
      if (!isExplicit(decision.keep_document_number)) errors.push("нет номера сохраняемого документа");
      if (!isExplicit(decision.source_date)) errors.push("нет даты удаляемого документа");
      if (!isExplicit(decision.organization)) errors.push("нет организации удаляемого документа");
      if (!isExplicit(decision.source_rows)) errors.push("нет строк первичного журнала");
      if (!isSha256(decision.effect_sha256)) errors.push("нет SHA256 точного эффекта/набора проводок");
      if (type === "DELETE_POSTING" && !isExplicit(decision.delete_posting_number)) errors.push("нет номера удаляемой проводки");
    }
  }

  const status = !approved
    ? "CANDIDATE_ONLY_NOT_APPROVED"
    : errors.length
      ? "BLOCKED_EVIDENCE_INCOMPLETE"
      : "DRAFT_ACTION_EXTERNAL_GATES_BLOCKED";
  return { type, approved, amount, errors, status, actionAllowed: approved && errors.length === 0 };
}

function decisionRowsForSheet(decisions) {
  return decisions.map((decision) => DECISION_FIELDS.map(([key]) => decision[key] ?? ""));
}

function makeLoaderRow(decision, operation, uploadId, target, disputed = false) {
  const amount = positiveMoney(decision.correction_amount);
  const reason = clean(decision.reason) || "Причина не указана в сверке";
  const sourceDtAnalytics = [decision.source_analytics_dt1, decision.source_analytics_dt2, decision.source_analytics_dt3].map(clean).filter(Boolean).join("; ") || "не определены";
  const sourceKtAnalytics = [decision.source_analytics_kt1, decision.source_analytics_kt2, decision.source_analytics_kt3].map(clean).filter(Boolean).join("; ") || "не определены";
  const targetDtAnalytics = [target.analyticsDt1, target.analyticsDt2, target.analyticsDt3].map(clean).filter(Boolean).join("; ") || "не определены";
  const targetKtAnalytics = [target.analyticsKt1, target.analyticsKt2, target.analyticsKt3].map(clean).filter(Boolean).join("; ") || "не определены";
  const amountText = formatMoneyText(amount);
  const humanSourceRange = clean(decision.loader_source_range) || clean(decision.source_range) || "не определена";
  const sourceEvidence = clean(decision.source_evidence_summary) || `Исходная аналитика ERP: Дт ${clean(decision.source_dt) || "не определён"} [${sourceDtAnalytics}], подразделение ${clean(decision.source_department_dt) || "не определено"}; Кт ${clean(decision.source_kt) || "не определён"} [${sourceKtAnalytics}], подразделение ${clean(decision.source_department_kt) || "не определено"}`;
  const sourceArticle = clean(decision.source_article) || clean(decision.group) || "исходная статья ERP";
  const targetArticle = clean(decision.target_article) || clean(target.analyticsDt1) || clean(target.analyticsKt1) || "целевая статья ERP";
  const userAction = operation === "STORNO"
    ? `СТОРНО: снимаем ${amountText} со статьи «${sourceArticle}»`
    : `РЕПОСТ: относим ${amountText} на статью «${targetArticle}»`;
  const humanTrace = [
    userAction,
    `Причина: ${reason}`,
    `Источник Инталев: ${[
      clean(decision.reconciliation_row) ? `строка сверки ${clean(decision.reconciliation_row)}` : "",
      clean(decision.intalev_path) ? `путь «${clean(decision.intalev_path)}»` : "",
      clean(decision.intalev_reference) || "агрегат ОПИУ; регистратор операций не выгружен",
    ].filter(Boolean).join("; ")}`,
    `Источник ERP: ${clean(decision.registrar) || "документ не определён"}; проводка ${clean(decision.posting_number) || "не определена"}; строка ${humanSourceRange}`,
    sourceEvidence,
    `Проводка после переноса: Дт ${clean(target.dt) || "не определён"} [${targetDtAnalytics}], подразделение ${clean(target.departmentDt) || "не определено"}; Кт ${clean(target.kt) || "не определён"} [${targetKtAnalytics}], подразделение ${clean(target.departmentKt) || "не определено"}`,
    `Статус проверки: ${clean(decision.proof_reason) || (disputed ? "требуется подтверждение пользователя" : "доказано сверкой; выгрузка остаётся REPORT_ONLY")}`,
  ].join(" | ");
  const technicalTrace = [
    humanTrace,
    `PairID=${clean(decision.pair_id)}`,
    `UploadID=${uploadId}`,
    `Engine=${ENGINE_VERSION}`,
    `DecisionType=${normalizedType(decision.decision_type)}`,
    `Period=${clean(decision.period)}`,
    `Organization=${clean(decision.organization)}`,
    `ERPRange=${clean(decision.source_range)}`,
    `ERPRegistrar=${clean(decision.registrar)}`,
    `ERPPostingNo=${clean(decision.posting_number)}`,
    `ERPSourceSHA256=${clean(decision.erp_source_sha256).toUpperCase()}`,
    clean(decision.intalev_technical_reference) ? `IntalevTechnical=${clean(decision.intalev_technical_reference)}` : "",
    "execution_allowed=false",
    "ready_to_upload=false",
    "release_allowed=false",
  ].filter(Boolean).join(" | ");
  const sourceFinancialRecordId = clean(decision.source_financial_record_id) || clean(decision.source_row_id) || uploadId;
  const row = [
    clean(target.dt), clean(target.kt), null, null, operation,
    clean(target.departmentDt), clean(target.departmentKt), null, null,
    amount, amount, null, null, null, null, humanTrace,
    clean(decision.source_dt), clean(decision.source_kt), sourceFinancialRecordId,
    null, null,
    clean(target.analyticsDt1), clean(target.analyticsDt2), clean(target.analyticsDt3),
    clean(target.analyticsKt1), clean(target.analyticsKt2), clean(target.analyticsKt3),
  ];
  Object.defineProperty(row, "audit", {
    enumerable: false,
    value: {
      pairId: clean(decision.pair_id), uploadId, operation, period: clean(decision.period), organization: clean(decision.organization),
      sourceRange: clean(decision.source_range), registrar: clean(decision.registrar), postingNumber: clean(decision.posting_number),
      amount, loaderContent: humanTrace, technicalTrace,
    },
  });
  return row;
}

function candidateActionRows(decisions) {
  const uploadRows = [];
  const pairRows = [];
  const deletionOperations = [];
  const deletionPostings = [];
  const blockers = [];
  for (const decision of decisions) {
    const type = normalizedType(decision.decision_type);
    const amount = positiveMoney(decision.correction_amount);
    const pairId = clean(decision.pair_id) || stableId("PAIR-SPORNO", [decision.case_id, decision.source_range, decision.posting_number]);
    const proven = isPostingAllowedForDisputedDecision(decision);
    const reconciliationBlocker = reconciliationDecisionBlocker(decision);
    const missing = [];
    const proofNotes = proven ? [] : [`proof_status=${clean(decision.proof_status) || clean(decision.evidence_state) || "MISSING"}; исполнение запрещено, DRAFT=_СПОРНО`];
    if (reconciliationBlocker) proofNotes.push(reconciliationBlocker);
    if (!isExplicit(decision.organization)) missing.push("нет точной организации источника");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean(decision.period))) missing.push("нет точного периода YYYY-MM");
    if (!isExplicit(decision.source_range) || !isExplicit(decision.registrar) || !isExplicit(decision.posting_number)) missing.push("нет точной source identity строки/документа/проводки");
    if (!isExplicit(decision.source_financial_record_id) && !isExplicit(decision.source_row_id)) missing.push("нет исходного идентификатора финансовой записи");
    if (["STORNO_REPOST", "ADD_ONE_SIDE"].includes(type) && !amount) missing.push("нет суммы");
    if (type === "STORNO_REPOST") {
      if (!isExplicit(decision.source_dt) || !isExplicit(decision.source_kt)) missing.push("нет счетов источника");
      if ([
        decision.source_analytics_dt1,
        decision.source_analytics_kt1,
        decision.source_department_dt,
        decision.source_department_kt,
      ].some((value) => !isExplicit(value))) {
        missing.push("нет полных аналитик/подразделений источника");
      }
    }
    if (["STORNO_REPOST", "ADD_ONE_SIDE"].includes(type)) {
      if (!isExplicit(decision.target_dt) || !isExplicit(decision.target_kt)) missing.push("нет целевых счетов");
      if ([decision.target_analytics_dt1, decision.target_analytics_kt1, decision.target_department_dt, decision.target_department_kt].some((value) => !isExplicit(value))) {
        missing.push("нет полных целевых аналитик/подразделений");
      }
    }
    if (type === "ADD_ONE_SIDE" && !isExplicit(decision.gap_evidence_ref)) missing.push("нет точного доказательства отсутствующей стороны");
    if (["DELETE_OPERATION", "DELETE_POSTING"].includes(type)) {
      if (clean(decision.delete_document_type).toUpperCase() !== "ОПЕРАЦИЯ МСФО") missing.push("удаление допустимо только для «Операция МСФО»");
      if (!isExplicit(decision.delete_document_number) || !isExplicit(decision.keep_document_number)) missing.push("нет точных номеров удаляемого/сохраняемого документов");
      if (!isExplicit(decision.source_rows) || !isSha256(decision.effect_sha256)) missing.push("нет точных source rows/effect SHA256");
      if (type === "DELETE_POSTING" && !isExplicit(decision.delete_posting_number)) missing.push("нет номера удаляемой проводки");
    }
    const materialized = missing.length === 0 && ["STORNO_REPOST", "ADD_ONE_SIDE", "DELETE_OPERATION", "DELETE_POSTING"].includes(type);
    const row = [
      clean(decision.case_id), type, clean(decision.approval_state), pairId,
      clean(decision.period), clean(decision.organization), clean(decision.source_range),
      normalizeDateText(decision.source_date), clean(decision.registrar), clean(decision.posting_number),
      amount ?? "", clean(decision.reason), clean(decision.solution), materialized ? "MATERIALIZED_SPORNO" : "BLOCKED_REVIEW",
      [...proofNotes, ...missing].join("; "), false, false, false,
    ];
    pairRows.push(row);
    if (proofNotes.length || missing.length) blockers.push(row);
    if (!materialized) continue;
    if (type === "DELETE_OPERATION") {
      deletionOperations.push([
        "DELETE_OPERATION_СПОРНО", "Операция МСФО", clean(decision.delete_document_number), normalizeDateText(decision.source_date),
        clean(decision.organization), clean(decision.keep_document_number), clean(decision.source_rows), pairId,
        stableId("DEL-SPORNO-OP", [decision.delete_document_number, decision.effect_sha256]), clean(decision.effect_sha256).toUpperCase(),
        clean(decision.reason), "MATERIALIZED_SPORNO", false, false, false, "Только DRAFT; live delete запрещён",
      ]);
      continue;
    }
    if (type === "DELETE_POSTING") {
      deletionPostings.push([
        "DELETE_POSTING_СПОРНО", "Операция МСФО", clean(decision.delete_document_number), normalizeDateText(decision.source_date),
        clean(decision.organization), clean(decision.delete_posting_number), clean(decision.keep_document_number), clean(decision.source_rows),
        pairId, stableId("DEL-SPORNO-ROW", [decision.delete_document_number, decision.delete_posting_number, decision.effect_sha256]),
        clean(decision.effect_sha256).toUpperCase(), clean(decision.source_dt), clean(decision.source_analytics_dt1), clean(decision.source_kt),
        clean(decision.source_analytics_kt1), amount ?? "", clean(decision.reason), "MATERIALIZED_SPORNO",
        false, false, false, "Только DRAFT; live delete запрещён",
      ]);
      continue;
    }
    const sourceTarget = {
      dt: decision.source_dt, kt: decision.source_kt,
      analyticsDt1: decision.source_analytics_dt1, analyticsDt2: decision.source_analytics_dt2, analyticsDt3: decision.source_analytics_dt3,
      departmentDt: decision.source_department_dt,
      analyticsKt1: decision.source_analytics_kt1, analyticsKt2: decision.source_analytics_kt2, analyticsKt3: decision.source_analytics_kt3,
      departmentKt: decision.source_department_kt,
    };
    const repostTarget = {
      dt: decision.target_dt, kt: decision.target_kt,
      analyticsDt1: decision.target_analytics_dt1, analyticsDt2: decision.target_analytics_dt2, analyticsDt3: decision.target_analytics_dt3,
      departmentDt: decision.target_department_dt,
      analyticsKt1: decision.target_analytics_kt1, analyticsKt2: decision.target_analytics_kt2, analyticsKt3: decision.target_analytics_kt3,
      departmentKt: decision.target_department_kt,
    };
    if (type === "STORNO_REPOST") {
      uploadRows.push(makeLoaderRow(decision, "STORNO", stableId("UPL-SPORNO-S", [pairId, amount]), sourceTarget, true));
      uploadRows.push(makeLoaderRow(decision, "REPOST", stableId("UPL-SPORNO-P", [pairId, amount]), repostTarget, true));
    } else {
      uploadRows.push(makeLoaderRow(decision, "REPOST", stableId("UPL-SPORNO-ONE", [pairId, amount]), repostTarget, true));
    }
  }
  return { uploadRows, pairRows, oneSideRows: [], deletionOperations, deletionPostings, blockers };
}

function exactSubsetByCents(rows, targetAmount) {
  const target = Math.round(Number(targetAmount) * 100);
  if (!Number.isFinite(target) || target <= 0) return [];
  const chosenRow = new Int32Array(target + 1);
  const previousSum = new Int32Array(target + 1);
  chosenRow.fill(-2);
  previousSum.fill(-1);
  chosenRow[0] = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const cents = Math.round(Math.abs(Number(rows[index].amount) || 0) * 100);
    if (cents <= 0 || cents > target) continue;
    for (let sum = target; sum >= cents; sum -= 1) {
      if (chosenRow[sum] === -2 && chosenRow[sum - cents] !== -2) {
        chosenRow[sum] = index;
        previousSum[sum] = sum - cents;
      }
    }
    if (chosenRow[target] !== -2) break;
  }
  if (chosenRow[target] === -2) return [];
  const selected = [];
  let sum = target;
  while (sum > 0) {
    const index = chosenRow[sum];
    if (index < 0) return [];
    selected.push(rows[index]);
    sum = previousSum[sum];
  }
  return selected.reverse();
}

function analyticsParts(value) {
  const items = Array.isArray(value) ? value : isExplicit(value) ? [value] : [];
  return [clean(items[0]) || "—", clean(items[1]) || "—", clean(items[2]) || "—"];
}

function disclosureAccounts(row) {
  const tokens = [];
  for (const value of [row?.disclosure, row?.analytics3]) {
    for (const match of clean(value).matchAll(/\b\d{2}(?:\.\d+)?\b/g)) tokens.push(match[0]);
  }
  return [...new Set(tokens)];
}

function accountMatches(actual, expected) {
  const left = clean(actual);
  const right = clean(expected);
  return left === right || left.startsWith(`${right}.`);
}

function articleAccountProfile(operationRows, pair, code) {
  const period = clean(pair.period);
  const pairId = clean(pair.pair_id);
  const normalizedCode = clean(code);
  const periodRows = operationRows.filter((row) => clean(row.period) === period && clean(row.parent_code) === normalizedCode);
  const pairRows = periodRows.filter((row) => clean(row.pair_id) === pairId);
  const scopes = [pairRows, periodRows];

  for (const rows of scopes) {
    const profiles = new Map();
    for (const row of rows) {
      const debit = clean(row.debit);
      const credit = clean(row.credit);
      if (!debit || !credit || /^99(?:\.|$)/.test(debit) || /^99(?:\.|$)/.test(credit)) continue;
      const accounts = disclosureAccounts(row);
      if (accounts.length !== 1) continue;
      const account = accounts[0];
      const onDebit = accountMatches(debit, account);
      const onCredit = accountMatches(credit, account);
      if (onDebit === onCredit) continue;
      const normalSide = onDebit ? "DEBIT" : "CREDIT";
      const key = `${account}|${normalSide}`;
      if (!profiles.has(key)) profiles.set(key, {
        account,
        normalSide,
        disclosure: clean(row.disclosure),
        analytics3: clean(row.analytics3),
        evidenceRows: [],
      });
      profiles.get(key).evidenceRows.push(clean(row.source_range));
    }
    if (profiles.size === 1) return { ok: true, ...[...profiles.values()][0] };
    if (profiles.size > 1) return { ok: false, reason: `AMBIGUOUS_ACCOUNT_SIDE:${[...profiles.keys()].join(",")}` };
  }
  return { ok: false, reason: "NO_UNIQUE_ACCOUNT_SIDE_EVIDENCE" };
}

function globalDirectReclassificationPlan(operationRows, pair, policy = {}) {
  if (policy.enabled === false) return { ok: false, reason: "GLOBAL_RULE_DISABLED" };
  const sourceCodes = [...new Set((pair.source_codes ?? []).map(clean).filter(Boolean))];
  if (sourceCodes.length !== 1) return { ok: false, reason: `SOURCE_COUNT_${sourceCodes.length}` };
  const sourceCode = sourceCodes[0];
  const memberDeltas = new Map((pair.member_deltas ?? []).map((item) => [clean(item.code), Math.round(Number(item.delta || 0) * 100)]));
  const sourceCents = -(memberDeltas.get(sourceCode) ?? 0);
  const targetItems = [...new Set((pair.target_codes ?? []).map(clean).filter(Boolean))]
    .map((code) => ({ code, cents: memberDeltas.get(code) ?? 0 }))
    .filter((item) => item.cents > 0);
  const targetCents = targetItems.reduce((sum, item) => sum + item.cents, 0);
  const allCents = [...memberDeltas.values()].reduce((sum, value) => sum + value, 0);
  const candidateToleranceCents = Math.round(Math.abs(Number(policy.candidate_tolerance_rubles || 0)) * 100);
  if (sourceCents > 0 && targetItems.length && Math.abs(allCents) <= candidateToleranceCents && allCents !== 0) {
    return { ok: false, candidateOnly: true, residualCents: allCents, reason: `TOLERANCE_ONLY_RESIDUAL:${allCents}` };
  }
  if (sourceCents <= 0 || !targetItems.length || targetCents !== sourceCents || allCents !== 0) {
    return { ok: false, reason: `NOT_EXACT_ZERO_SUM:${sourceCents}:${targetCents}:${allCents}` };
  }

  const profileByCode = new Map();
  for (const code of [sourceCode, ...targetItems.map((item) => item.code)]) {
    const profile = articleAccountProfile(operationRows, pair, code);
    if (!profile.ok) return { ok: false, reason: `${code}:${profile.reason}` };
    profileByCode.set(code, profile);
  }
  const normalSides = new Set([...profileByCode.values()].map((profile) => profile.normalSide));
  if (normalSides.size !== 1) return { ok: false, reason: `MIXED_NORMAL_SIDES:${[...normalSides].join(",")}` };

  return {
    ok: true,
    sourceCode,
    sourceCents,
    targetItems,
    profileByCode,
    normalSide: [...normalSides][0],
  };
}

async function sidecarDisputedGroups(sidecarPath, reconciliationSha, requestedPeriod, reportOrganization = "", discoveryPolicy = {}) {
  if (!clean(sidecarPath)) {
    return { sidecarPath: "", sidecarSha: "", groups: new Map(), unresolvedRows: [], reviewRows: [], analyticalDecisions: [], analyticalContexts: [], pairCount: 0, postingRows: 0, blockers: ["Нет явно переданного companion codex-input.json с pair_candidates"] };
  }
  sidecarPath = path.resolve(sidecarPath);
  try {
    await fs.access(sidecarPath);
  } catch {
    return { sidecarPath: "", sidecarSha: "", groups: new Map(), unresolvedRows: [], reviewRows: [], analyticalDecisions: [], analyticalContexts: [], pairCount: 0, postingRows: 0, blockers: ["Нет companion codex-input.json с pair_candidates"] };
  }
  const sidecarSha = await sha256(sidecarPath);
  const payload = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
  if (clean(payload.report_sha256).toUpperCase() !== clean(reconciliationSha).toUpperCase()) {
    return { sidecarPath, sidecarSha, groups: new Map(), unresolvedRows: [], reviewRows: [], analyticalDecisions: [], analyticalContexts: [], pairCount: 0, postingRows: 0, blockers: ["SHA256 companion JSON не совпадает с входной сверкой"] };
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(clean(requestedPeriod))) {
    return { sidecarPath, sidecarSha, groups: new Map(), unresolvedRows: [], reviewRows: [], analyticalDecisions: [], analyticalContexts: [], pairCount: 0, postingRows: 0, blockers: ["Период корректировки должен быть месяцем YYYY-MM; годовые строки _СПОРНО не создаются"] };
  }
  const evidence = payload.operation_evidence ?? {};
  const reclassificationPolicy = discoveryPolicy.zero_sum_internal_reclassification ?? {};
  const topLevelOrganization = clean(reportOrganization)
    || clean(payload.organization)
    || clean(reclassificationPolicy.organization_reference?.top_level_name);
  const pairs = (evidence.pair_candidates ?? []).filter((pair) => !requestedPeriod || clean(pair.period) === requestedPeriod);
  const operationRows = (evidence.rows ?? []).filter((row) =>
    clean(row.organization) === topLevelOrganization
    && clean(row.period) === clean(requestedPeriod));
  const groups = new Map();
  const unresolvedRows = [];
  const analyticalDecisions = [];
  const blockers = [];
  let postingRows = 0;
  const decisionByCode = new Map(
    (payload.rows ?? []).map((row) => [clean(row.code), row]),
  );
  const nonFinancialDecisionClasses = new Set([
    "HIERARCHY_REPAIR",
    "EMPTY_ARTICLE",
    "BINDING_REPAIR_CANDIDATE",
    "BINDING_REPAIR_PROVEN",
    "INTERNAL_RECLASS_CANDIDATE",
    "CROSS_BRANCH_RECLASS_CANDIDATE",
    "UNPROVEN_FINANCIAL_DELTA",
    "CONTROL_ONLY",
    "CONTROL_ONLY_ZERO_PARENT_WITH_CHILD_DELTAS",
  ]);
  const scopedReportRows = (payload.rows ?? []).filter((row) =>
    clean(row.organization) === topLevelOrganization
    && clean(row.period) === clean(requestedPeriod));
  const labelByCode = new Map(scopedReportRows.map((row) => [clean(row.code), clean(row.intalev_label) || clean(row.erp_label)]));
  const reportRowByCode = new Map();
  const reportRowSignatureByCode = new Map();
  const conflictingReportRowCodes = new Set();
  for (const row of scopedReportRows) {
    const code = clean(row.code);
    if (!code) continue;
    const cents = (value) => {
      const amount = numberValue(value);
      return amount === null ? "NULL" : String(Math.round(amount * 100));
    };
    const signature = [
      clean(row.analytical_basis_id || code),
      cents(row.erp_amount),
      cents(row.intalev_amount),
      cents(row.delta),
    ].join(":");
    if (reportRowSignatureByCode.has(code) && reportRowSignatureByCode.get(code) !== signature) {
      conflictingReportRowCodes.add(code);
      reportRowByCode.delete(code);
      continue;
    }
    if (conflictingReportRowCodes.has(code)) continue;
    reportRowSignatureByCode.set(code, signature);
    reportRowByCode.set(code, row);
  }

  function articleLabelForCode(code) {
    const normalizedCode = clean(code);
    const label = clean(labelByCode.get(normalizedCode));
    if (!label || /пустое значение/i.test(label)) {
      if (normalizedCode === "R036") return "ФЗП";
      return normalizedCode || "статья не определена";
    }
    return label;
  }

  function reclassificationRuleForPair(pair) {
    if (!reclassificationPolicy.enabled) return null;
    return (reclassificationPolicy.article_overrides ?? []).find((item) => clean(item.parent_code) === clean(pair.parent_code)) ?? null;
  }

  function intalevReferencesForCodes(codes, period) {
    const humanReferences = [];
    const technicalReferences = [];
    for (const code of codes) {
      const reportRow = reportRowByCode.get(clean(code));
      const sources = (reportRow?.intalev_sources ?? []).filter((source) => clean(source.month) === clean(period));
      const source = sources.find((item) => clean(item.source_cell)) || sources[0];
      if (!source) {
        humanReferences.push(`${articleLabelForCode(code)}: источник месяца не найден`);
        technicalReferences.push(`${clean(code)}: источник месяца не найден`);
        continue;
      }
      const sourceFile = clean(source.source_file) ? path.basename(clean(source.source_file)) : "файл не указан";
      const location = [sourceFile, clean(source.sheet), clean(source.source_cell)].filter(Boolean).join("!");
      const fullPath = clean(source.full_path) || clean(reportRow?.hierarchy_path?.join(" / "));
      const humanPath = clean(code) === "R036"
        ? fullPath.replace(/<пустое значение>/gi, "ФЗП")
        : fullPath;
      humanReferences.push(`${clean(code)} «${articleLabelForCode(code)}»${humanPath ? `; путь ${humanPath}` : ""}`);
      technicalReferences.push(`${clean(code)}: ${location}${fullPath ? `; путь ${fullPath}` : ""}`);
    }
    return {
      human: `${humanReferences.join("; ")}; регистратор операций Инталев в выгрузке ОПИУ отсутствует`,
      technical: `${technicalReferences.join("; ")}; регистратор операций Инталев в выгрузке ОПИУ отсутствует`,
    };
  }

  function append(groupKey, organization, sourceDate, row) {
    if (!groups.has(groupKey)) groups.set(groupKey, { organization, sourceDate, uploadRows: [] });
    groups.get(groupKey).uploadRows.push(row);
    postingRows += 1;
  }

  const pairAnalyticalBasisById = new Map();
  for (const pair of pairs) {
    const protectedRows = [...new Set([
      ...(pair.source_codes ?? []),
      ...(pair.target_codes ?? []),
    ])]
      .map((code) => decisionByCode.get(clean(code)))
      .filter((row) => row && nonFinancialDecisionClasses.has(clean(row.classification).toUpperCase())
        && row.correction_allowed !== true);
    if (protectedRows.length > 0) {
      blockers.push(`${clean(pair.pair_id)}: decision engine classified the case as ${[...new Set(protectedRows.map((row) => clean(row.classification)))].join(", ")}; no ADD_ONE_SIDE/STORNO/REPOST rows`);
      continue;
    }
    const sourceAmount = Math.round(Math.abs((pair.member_deltas ?? []).filter((item) => (pair.source_codes ?? []).includes(item.code)).reduce((sum, item) => sum + Number(item.delta || 0), 0)) * 100) / 100;
    const targetQuotas = (pair.member_deltas ?? [])
      .filter((item) => (pair.target_codes ?? []).includes(item.code) && Number(item.delta) > 0)
      .map((item) => ({ code: clean(item.code), label: articleLabelForCode(item.code), cents: Math.round(Number(item.delta) * 100) }));
    const pairIntalevReferences = intalevReferencesForCodes([...(pair.source_codes ?? []), ...(pair.target_codes ?? [])], clean(pair.period));
    for (const member of pair.member_deltas ?? []) {
      const signedDelta = numberValue(member.delta);
      if (signedDelta === null || Math.abs(signedDelta) < 0.0000001) continue;
      const code = clean(member.code);
      if (conflictingReportRowCodes.has(code)) {
        blockers.push(`${clean(pair.pair_id)}:${code}: CONFLICTING_R005_BASIS_TOTALS`);
        continue;
      }
      const reportRow = reportRowByCode.get(code);
      if (!reportRow) {
        blockers.push(`${clean(pair.pair_id)}:${code}: MISSING_SCOPED_R005_BASIS`);
        continue;
      }
      const analyticalBasisId = clean(reportRow.analytical_basis_id || code);
      const erpCurrent = numberValue(reportRow.erp_amount);
      const intalevTarget = numberValue(reportRow.intalev_amount);
      const reportDelta = numberValue(reportRow.delta);
      if (!analyticalBasisId || erpCurrent === null || intalevTarget === null) {
        blockers.push(`${clean(pair.pair_id)}:${code}: INCOMPLETE_R005_BASIS_TOTALS`);
        continue;
      }
      const signedDeltaCents = Math.round(signedDelta * 100);
      if (reportDelta === null
        || Math.round(reportDelta * 100) !== Math.round((intalevTarget - erpCurrent) * 100)
        || Math.round(reportDelta * 100) !== signedDeltaCents) {
        blockers.push(`${clean(pair.pair_id)}:${code}: INVALID_R005_SIGNED_DELTA`);
        continue;
      }
      const basisSignature = `${Math.round(erpCurrent * 100)}:${Math.round(intalevTarget * 100)}:${signedDeltaCents}`;
      if (pairAnalyticalBasisById.has(analyticalBasisId)) {
        const existingBasis = pairAnalyticalBasisById.get(analyticalBasisId);
        if (existingBasis.signature !== basisSignature) {
          blockers.push(`${clean(pair.pair_id)}:${code}: CONFLICTING_R005_BASIS_TOTALS`);
          const existingDecision = analyticalDecisions[existingBasis.index];
          existingDecision.erp_current = null;
          existingDecision.intalev_target = null;
          existingDecision.basis_contract_blockers = ["CONFLICTING_R005_BASIS_TOTALS"];
          existingBasis.conflicted = true;
        }
        continue;
      }
      analyticalDecisions.push({
        case_id: `${clean(pair.pair_id)}:${code}`,
        pair_id: `${clean(pair.pair_id)}:${code}`,
        decision_type: "DISPUTED_CORRECTION",
        proof_status: "INFERRED",
        original_proof_status: "INFERRED",
        approval_state: "ПРЕДЛОЖЕНО",
        period: clean(reportRow.period),
        organization: clean(reportRow.organization),
        analytical_effect: signedDelta,
        analytical_basis_id: analyticalBasisId,
        erp_current: erpCurrent,
        intalev_target: intalevTarget,
        target_article: articleLabelForCode(code),
        disclosure_group: clean(pair.parent_code),
        target_side: signedDelta > 0 ? "INCREASE_TO_INTALEV_TARGET" : "DECREASE_TO_INTALEV_TARGET",
        reason: `Аналитическая корректировка по дельте Инталев − ERP для ${code} «${articleLabelForCode(code)}» в группе ${clean(pair.parent_code)}`,
        evidence_references: [pairIntalevReferences.technical, clean(evidence.journal_sha256)].filter(Boolean),
        review_state: "NEEDS_REVIEW",
        execution_allowed: false,
        ready_to_upload: false,
        release_allowed: false,
      });
      pairAnalyticalBasisById.set(analyticalBasisId, {
        signature: basisSignature,
        index: analyticalDecisions.length - 1,
        conflicted: false,
      });
    }
    const globalPlan = globalDirectReclassificationPlan(operationRows, pair, {
      ...(reclassificationPolicy.global_rule ?? {}),
      enabled: reclassificationPolicy.enabled && reclassificationPolicy.global_rule?.enabled !== false,
    });
    if (globalPlan.ok) {
      blockers.push(`${clean(pair.pair_id)}: найден экономический профиль ${globalPlan.targetItems.length} целевых статей, но физический регистратор не доказан; A:AA-строки не созданы`);
      continue;
    }
    if (globalPlan.candidateOnly) {
      blockers.push(`${clean(pair.pair_id)}: диагностический кандидат в допуске до ${Number(reclassificationPolicy.global_rule?.candidate_tolerance_rubles || 0)} руб.; остаток ${(globalPlan.residualCents / 100).toFixed(2)} не превращён в проводку`);
      continue;
    }
    const candidates = operationRows.filter((row) =>
      clean(row.period) === clean(pair.period)
      && clean(row.pair_id) === clean(pair.pair_id)
      && clean(row.pair_role) === "STORNO_SOURCE_CANDIDATE"
      && !/^99(?:\.|$)/.test(clean(row.debit))
      && !/^99(?:\.|$)/.test(clean(row.credit))
      && Number(row.amount) > 0
    );
    const preferred = candidates.filter((row) => !/^Операция МСФО/i.test(clean(row.document)));
    const selected = exactSubsetByCents(preferred, sourceAmount);
    if (!selected.length || !targetQuotas.length) {
      const sourceCode = clean((pair.source_codes ?? [])[0]);
      const sourceLabel = articleLabelForCode(sourceCode);
      const pairDescription = `${sourceCode} «${sourceLabel}» −${formatMoneyText(sourceAmount)} → ${targetQuotas.map((quota) => `${quota.code} «${quota.label}» +${formatMoneyText(quota.cents / 100)}`).join("; ")}`;
      const reclassificationRule = reclassificationRuleForPair(pair);
      const ruleSource = reclassificationRule?.source ?? null;
      const ruleTargets = new Map((reclassificationRule?.targets ?? []).map((item) => [clean(item.code), item]));
      const directReclassificationAllowed = Boolean(
        reclassificationRule
        && clean(ruleSource?.code) === sourceCode
        && clean(reclassificationRule.account)
        && targetQuotas.length > 0
        && targetQuotas.every((quota) => ruleTargets.has(quota.code))
      );
      const commonDecision = {
        case_id: clean(pair.pair_id),
        decision_type: directReclassificationAllowed ? "ADD_ONE_SIDE" : "STORNO_REPOST",
        approval_state: "ПРЕДЛОЖЕНО",
        period: clean(pair.period),
        source_range: `SOURCE_CODES:${(pair.source_codes ?? []).join(",")}; TARGET_CODES:${(pair.target_codes ?? []).join(",")}`,
        loader_source_range: "не определена",
        source_date: periodEndDate(clean(pair.period)),
        registrar: "не определён",
        posting_number: "не определена",
        source_dt: "",
        source_analytics_dt1: "",
        source_department_dt: "",
        source_kt: "",
        source_department_kt: "",
        organization: topLevelOrganization || "НЕ ОПРЕДЕЛЕНА — ВЕРХНИЙ УРОВЕНЬ ОТЧЁТА",
        reason: `Корректировка блока ${clean(pair.parent_code)} «${clean(reclassificationRule?.group_label) || clean(pair.parent_code)}» по арифметике дельт: ${pairDescription}`,
        proof_reason: directReclassificationAllowed
          ? `Точный набор ERP-проводок на ${formatMoneyText(sourceAmount)} не найден. Счёт 26 и статьи подтверждены справочником ERP; организация взята из верхнего уровня сверки «${topLevelOrganization || "не определён"}». Иерархия Инталев и физический регистратор остаются недоказанными`
          : `Точный набор ERP-проводок на ${formatMoneyText(sourceAmount)}, организация, регистратор, Дт/Кт и аналитики не найдены; иерархия статей не доказана полностью. Строки сформированы как спорный макет корректировки блока`,
        intalev_reference: pairIntalevReferences.human,
        intalev_technical_reference: pairIntalevReferences.technical,
        erp_source_sha256: clean(evidence.journal_sha256),
        pair_id: clean(pair.pair_id),
      };
      if (directReclassificationAllowed) {
        const account = clean(reclassificationRule.account);
        blockers.push(`${clean(pair.pair_id)}: целевые статьи и счёт ${account} определены, но точный ERP subset на ${formatMoneyText(sourceAmount)} не найден; A:AA-строки не созданы`);
        continue;
      }
      blockers.push(`${clean(pair.pair_id)}: точный subset SOURCE на ${formatMoneyText(sourceAmount)} не найден; A:AA-строки не созданы`);
      continue;
    }
    let targetIndex = 0;
    for (const row of selected) {
      const sourceArticle = articleLabelForCode(row.parent_code) || clean(row.article) || analyticsParts(row.debit_analytics)[0];
      const sourceDt = analyticsParts(row.debit_analytics);
      const sourceKt = analyticsParts(row.credit_analytics);
      const baseDecision = {
        case_id: clean(row.source_row_id) || clean(row.source_range),
        decision_type: "STORNO_REPOST",
        approval_state: "ПРЕДЛОЖЕНО",
        period: clean(pair.period),
        source_range: clean(row.source_range),
        source_date: normalizeDateText(row.date),
        registrar: clean(row.document),
        posting_number: row.posting_no ?? "",
        source_dt: clean(row.debit),
        source_analytics_dt1: sourceDt[0], source_analytics_dt2: sourceDt[1], source_analytics_dt3: sourceDt[2],
        source_department_dt: clean(row.debit_department),
        source_kt: clean(row.credit),
        source_analytics_kt1: sourceKt[0], source_analytics_kt2: sourceKt[1], source_analytics_kt3: sourceKt[2],
        source_department_kt: clean(row.credit_department),
        organization: clean(row.organization),
        correction_amount: positiveMoney(row.amount),
        target_dt: clean(row.debit), target_analytics_dt1: sourceDt[0], target_analytics_dt2: sourceDt[1], target_analytics_dt3: sourceDt[2], target_department_dt: clean(row.debit_department),
        target_kt: clean(row.credit), target_analytics_kt1: sourceKt[0], target_analytics_kt2: sourceKt[1], target_analytics_kt3: sourceKt[2], target_department_kt: clean(row.credit_department),
        reason: `Перенос суммы внутри группы ${clean(pair.parent_code)} с нулевой итоговой дельтой: ${clean(row.parent_code)} «${sourceArticle}» → ${(pair.target_codes ?? []).map((code) => `${clean(code)} «${articleLabelForCode(code)}»`).join(", ")}`,
        proof_reason: `Иерархия ${clean(row.parent_code)} не доказана полным составом дочерних строк, кодом/UID и родительской связью. Pair-кандидат построен по равным противоположным дельтам; регистратор Инталев отсутствует в агрегатной выгрузке`,
        intalev_reference: pairIntalevReferences.human,
        intalev_technical_reference: pairIntalevReferences.technical,
        solution: "Кандидат STORNO/REPOST из companion JSON сверки; статус СПОРНО",
        erp_source_sha256: clean(row.journal_sha256),
        pair_id: clean(pair.pair_id),
      };
      const correctionDate = periodEndDate(clean(pair.period));
      const groupKey = `${baseDecision.organization}\u0000${correctionDate}`;
      const sourceTarget = {
        dt: baseDecision.source_dt, kt: baseDecision.source_kt,
        analyticsDt1: sourceDt[0], analyticsDt2: sourceDt[1], analyticsDt3: sourceDt[2], departmentDt: baseDecision.source_department_dt,
        analyticsKt1: sourceKt[0], analyticsKt2: sourceKt[1], analyticsKt3: sourceKt[2], departmentKt: baseDecision.source_department_kt,
      };
      append(groupKey, baseDecision.organization, correctionDate, makeLoaderRow(baseDecision, "STORNO", stableId("UPL-SPORNO-S", [pair.pair_id, row.source_range, row.amount]), sourceTarget, true));

      let remaining = Math.round(Number(row.amount) * 100);
      while (remaining > 0 && targetIndex < targetQuotas.length) {
        const quota = targetQuotas[targetIndex];
        const part = Math.min(remaining, quota.cents);
        const targetDecision = { ...baseDecision, correction_amount: part / 100 };
        const targetDt = [...sourceDt];
        const targetKt = [...sourceKt];
        const sourceOnDebit = targetDt.some((value) => clean(value) === sourceArticle) || clean(row.article) === sourceArticle;
        if (sourceOnDebit) targetDt[0] = quota.label;
        else targetKt[0] = quota.label;
        const repostTarget = {
          dt: baseDecision.target_dt, kt: baseDecision.target_kt,
          analyticsDt1: targetDt[0], analyticsDt2: targetDt[1], analyticsDt3: targetDt[2], departmentDt: baseDecision.target_department_dt,
          analyticsKt1: targetKt[0], analyticsKt2: targetKt[1], analyticsKt3: targetKt[2], departmentKt: baseDecision.target_department_kt,
        };
        append(groupKey, baseDecision.organization, correctionDate, makeLoaderRow(targetDecision, "REPOST", stableId("UPL-SPORNO-P", [pair.pair_id, row.source_range, quota.code, part]), repostTarget, true));
        remaining -= part;
        quota.cents -= part;
        if (quota.cents === 0) targetIndex += 1;
      }
      if (remaining > 0) blockers.push(`${clean(pair.pair_id)}: не распределено ${(remaining / 100).toFixed(2)} после TARGET`);
    }
  }

  const reviewRows = [];
  const oneSideReviews = unprovenOneSideReviews(payload, {
    period: requestedPeriod,
    organization: topLevelOrganization,
  });
  for (const review of oneSideReviews) {
    if (clean(review.period) !== clean(requestedPeriod)) {
      blockers.push(`${clean(review.caseId)}: BLOCKED_CONTEXT_ISOLATION; период ${clean(review.period) || "MISSING"} не равен выбранному ${clean(requestedPeriod)}`);
      continue;
    }
    if (review.reviewOnly === true || clean(review.correctionRoute).toUpperCase() !== "ADD_ONE_SIDE") {
      analyticalDecisions.push({
        case_id: review.caseId,
        decision_type: "CONTROL_ONLY",
        approval_state: "ПРЕДЛОЖЕНО",
        period: review.period,
        organization: review.organization,
        source_range: review.sourceRange,
        loader_source_range: review.sourceRange,
        source_date: periodEndDate(review.period),
        correction_amount: 0,
        reason: review.reason,
        proof_reason: review.blockers,
        proof_status: clean(review.proofStatus).toUpperCase() || "UNPROVEN",
        original_proof_status: clean(review.proofStatus).toUpperCase() || "UNPROVEN",
        analytical_effect: 0,
        analytical_basis_id: clean(review.analyticalBasisId),
        erp_current: review.basisContractValid ? numberValue(review.erpAmount) : null,
        intalev_target: review.basisContractValid ? numberValue(review.intalevAmount) : null,
        basis_contract_blockers: review.basisContractBlockers,
        target_article: clean(review.rowCode),
        disclosure_group: "Контроль",
        review_state: "NEEDS_REVIEW",
        correction_route: "REVIEW_ONLY",
      });
      reviewRows.push([
        review.caseId, "CONTROL_ONLY", "ПРОВЕРКА", review.pairId,
        review.period, review.organization, review.sourceRange, periodEndDate(review.period),
        review.registrar, review.postingNumber, 0, review.reason,
        "Оставить в review/control до exact source/target proof.",
        "REVIEW_ONLY", review.blockers, false, false, false,
      ]);
      blockers.push(`${review.caseId}: REVIEW_ONLY / CONTROL_ONLY; ADD_ONE_SIDE/STORNO/REPOST запрещены до exact source/target proof`);
      continue;
    }
    const decision = {
      case_id: review.caseId,
      decision_type: "ADD_ONE_SIDE",
      approval_state: "ПРЕДЛОЖЕНО",
      period: review.period,
      organization: review.organization,
      source_range: review.sourceRange,
      loader_source_range: review.sourceRange,
      source_date: periodEndDate(review.period),
      registrar: review.registrar,
      posting_number: review.postingNumber,
      source_dt: review.debitAccount,
      source_kt: review.creditAccount,
      correction_amount: review.amount,
      reason: review.reason,
      proof_reason: review.blockers,
      source_evidence_summary: `Трасса R005 ${review.rowCode}; proof_status=${review.proofStatus}; исходный файл ${review.sourceFile || "не определён"}.`,
      intalev_reference: `Строка ОПИУ ${review.rowCode}; ненулевая дельта ${review.delta}.`,
      intalev_technical_reference: `RowCode=${review.rowCode}; ReviewCategory=${review.reviewCategory}; OutputRoute=${review.outputRoute}`,
      pair_id: review.pairId,
      solution: "Проверить исходную проводку и выбрать целевую статью/счета; до подтверждения не загружать в 1С",
    };
    analyticalDecisions.push({
      ...decision,
      decision_type: "DISPUTED_CORRECTION",
      proof_status: clean(review.proofStatus).toUpperCase() || "UNPROVEN",
      original_proof_status: clean(review.proofStatus).toUpperCase() || "UNPROVEN",
      analytical_effect: numberValue(review.delta),
      analytical_basis_id: clean(review.analyticalBasisId),
      erp_current: review.basisContractValid ? numberValue(review.erpAmount) : null,
      intalev_target: review.basisContractValid ? numberValue(review.intalevAmount) : null,
      basis_contract_blockers: review.basisContractBlockers,
      target_article: clean(review.article || review.articleName || review.rowCode),
      disclosure_group: clean(review.group || review.reviewCategory),
      target_side: clean(review.targetSide || (review.debitAccount ? `DEBIT:${review.debitAccount}` : review.creditAccount ? `CREDIT:${review.creditAccount}` : "ANALYTICAL_DELTA")),
      evidence_references: [review.sourceRange, review.sourceFile, review.registrar, review.postingNumber].map(clean).filter(Boolean),
      review_state: "NEEDS_REVIEW",
    });
    reviewRows.push([
      review.caseId, "ADD_ONE_SIDE", "ПРЕДЛОЖЕНО", review.pairId,
      review.period, decision.organization, review.sourceRange, decision.source_date,
      review.registrar, review.postingNumber, review.amount, review.reason, decision.solution,
      "BLOCKED_REVIEW_INCOMPLETE_SOURCE_DIMENSIONS", `${review.blockers}; полная целевая A:AA структура отсутствует, пустая проводка не создаётся`, false, false, false,
    ]);
    blockers.push(`${review.caseId}: ADD_ONE_SIDE не материализован — нет полной точной A:AA структуры; значения не подставляются; ${review.blockers}`);
  }
  return {
    sidecarPath,
    sidecarSha,
    groups,
    unresolvedRows,
    reviewRows,
    analyticalDecisions,
    analyticalContexts: Array.isArray(payload.analytical_contexts)
      ? payload.analytical_contexts
      : payload.analytical_context ? [payload.analytical_context] : [],
    unresolvedOrganization: topLevelOrganization,
    unresolvedSourceDate: periodEndDate(clean(requestedPeriod)),
    pairCount: pairs.length,
    postingRows,
    blockers,
  };
}

function actionRows(decisions, reconciliationSha) {
  const uploadRows = [];
  const pairRows = [];
  const oneSideRows = [];
  const deletionOperations = [];
  const deletionPostings = [];
  const blockers = [];

  for (const decision of decisions) {
    const result = validateDecision(decision, reconciliationSha);
    const pairId = clean(decision.pair_id) || stableId("PAIR", [decision.case_id, decision.source_range, decision.posting_number]);
    const base = [
      clean(decision.case_id), result.type, clean(decision.approval_state), pairId,
      clean(decision.period), clean(decision.organization), clean(decision.source_range),
      normalizeDateText(decision.source_date), clean(decision.registrar), clean(decision.posting_number),
      result.amount ?? "", clean(decision.reason), clean(decision.solution), result.status,
      result.errors.join("; "), false, false, false,
    ];
    pairRows.push(base);
    if (result.errors.length || !result.approved) blockers.push(base);
    if (!result.actionAllowed) continue;

    if (result.type === "STORNO_REPOST") {
      const sourceTarget = {
        dt: decision.source_dt, kt: decision.source_kt,
        analyticsDt1: decision.source_analytics_dt1, analyticsDt2: decision.source_analytics_dt2, analyticsDt3: decision.source_analytics_dt3,
        departmentDt: decision.source_department_dt,
        analyticsKt1: decision.source_analytics_kt1, analyticsKt2: decision.source_analytics_kt2, analyticsKt3: decision.source_analytics_kt3,
        departmentKt: decision.source_department_kt,
      };
      const repostTarget = {
        dt: decision.target_dt, kt: decision.target_kt,
        analyticsDt1: decision.target_analytics_dt1, analyticsDt2: decision.target_analytics_dt2, analyticsDt3: decision.target_analytics_dt3,
        departmentDt: decision.target_department_dt,
        analyticsKt1: decision.target_analytics_kt1, analyticsKt2: decision.target_analytics_kt2, analyticsKt3: decision.target_analytics_kt3,
        departmentKt: decision.target_department_kt,
      };
      const stornoId = stableId("UPL-S", [pairId, decision.source_range, result.amount, "STORNO"]);
      const repostId = stableId("UPL-P", [pairId, decision.source_range, result.amount, "REPOST"]);
      uploadRows.push(makeLoaderRow(decision, "STORNO", stornoId, sourceTarget));
      uploadRows.push(makeLoaderRow(decision, "REPOST", repostId, repostTarget));
    } else if (result.type === "ADD_ONE_SIDE") {
      const target = {
        dt: decision.target_dt, kt: decision.target_kt,
        analyticsDt1: decision.target_analytics_dt1, analyticsDt2: decision.target_analytics_dt2, analyticsDt3: decision.target_analytics_dt3,
        departmentDt: decision.target_department_dt,
        analyticsKt1: decision.target_analytics_kt1, analyticsKt2: decision.target_analytics_kt2, analyticsKt3: decision.target_analytics_kt3,
        departmentKt: decision.target_department_kt,
      };
      const uploadId = stableId("UPL-ONE-SIDE", [pairId, decision.gap_evidence_ref, result.amount]);
      uploadRows.push(makeLoaderRow(decision, "REPOST", uploadId, target));
      oneSideRows.push([...base, clean(decision.gap_evidence_ref), uploadId]);
    } else if (result.type === "DELETE_OPERATION") {
      deletionOperations.push([
        "DELETE_OPERATION", "Операция МСФО", clean(decision.delete_document_number), normalizeDateText(decision.source_date),
        clean(decision.organization), clean(decision.keep_document_number), clean(decision.source_rows), pairId,
        stableId("DEL-OP", [decision.delete_document_number, decision.effect_sha256]), clean(decision.effect_sha256).toUpperCase(),
        clean(decision.reason), result.status, false, false, false, "Требуются live preflight и явное разрешение; движок не удаляет",
      ]);
    } else if (result.type === "DELETE_POSTING") {
      deletionPostings.push([
        "DELETE_POSTING", "Операция МСФО", clean(decision.delete_document_number), normalizeDateText(decision.source_date),
        clean(decision.organization), clean(decision.delete_posting_number), clean(decision.keep_document_number), clean(decision.source_rows),
        pairId, stableId("DEL-ROW", [decision.delete_document_number, decision.delete_posting_number, decision.effect_sha256]),
        clean(decision.effect_sha256).toUpperCase(), clean(decision.source_dt), clean(decision.source_analytics_dt1), clean(decision.source_kt),
        clean(decision.source_analytics_kt1), result.amount ?? "", clean(decision.reason), result.status,
        false, false, false, "Требуются live preflight и явное разрешение; движок не удаляет",
      ]);
    }
  }
  return { uploadRows, pairRows, oneSideRows, deletionOperations, deletionPostings, blockers };
}

function formatDecisionSheet(sheet, rowCount) {
  const colCount = DECISION_FIELDS.length;
  styleTitle(sheet, 0, colCount, "Решения по корректировкам ОПИУ — ввод владельца");
  styleNotice(sheet, 1, colCount, "Заполняйте только доказанные решения. Значение «УТВЕРЖДЕНО» разрешает лишь создание DRAFT-файла; загрузка в 1С и удаление остаются запрещены до внешних проверок.", COLORS.paleRed, COLORS.red);
  writeMatrix(sheet, 3, 0, [DECISION_FIELDS.map(([, label]) => label)]);
  styleHeader(sheet.getRangeByIndexes(3, 0, 1, colCount));
  if (rowCount) {
    styleBody(sheet.getRangeByIndexes(4, 0, rowCount, colCount));
    sheet.getRangeByIndexes(4, 22, rowCount, 2).format.numberFormat = AMOUNT_FORMAT;
    sheet.getRangeByIndexes(4, 9, rowCount, 2).format.numberFormat = "@";
    sheet.getRangeByIndexes(4, 41, rowCount, 4).format.numberFormat = "@";
    sheet.getRangeByIndexes(4, 2, rowCount, 1).format.fill = COLORS.paleYellow;
    sheet.getRangeByIndexes(4, 37, rowCount, 2).format.fill = COLORS.paleOrange;
  }
  setWidths(sheet, Object.fromEntries(Array.from({ length: colCount }, (_, index) => [index, [0, 1, 2, 7, 9, 35, 36, 47].includes(index) ? 30 : 18])));
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(3);
}

async function buildDecisionWorkbook(decisions, metadata, outputPath) {
  const workbook = Workbook.create();
  const instruction = addSheet(workbook, "Инструкция");
  styleTitle(instruction, 0, 8, "Движок корректировок ОПИУ R001 — инструкция");
  styleNotice(instruction, 1, 8, "Сверка является доказательным пакетом. Если в ней есть SHA256 ERP журнала и точная SOURCE-строка, движок автоматически формирует DRAFT-проводки; загрузка в 1С всё равно запрещена до внешних gates.", COLORS.paleRed, COLORS.red);
  writeMatrix(instruction, 3, 0, [["Шаг", "Действие", "Обязательно", "Результат", "execution_allowed", "ready_to_upload", "release_allowed", "Комментарий"]]);
  styleHeader(instruction.getRange("A4:H4"));
  const rows = [
    [1, "Проверить строку SOURCE и первичный ERP-журнал", "ДА", "Точное доказательство", false, false, false, "Сумма и название сами по себе недостаточны"],
    [2, "Проверить SHA256 первичного ERP файла, перенесённый из паспорта сверки", "ДА", "Фиксация версии источника", false, false, false, "Ручной ввод не нужен, если хеш уже есть в сверке"],
    [3, "Выбрать тип решения", "ДА", "Один из 7 типов", false, false, false, "STORNO_REPOST / ADD_ONE_SIDE / DELETE_* / NO_POSTING / UPDATE_*"],
    [4, "Заполнить целевые счета, аналитики и подразделения", "Для проводок", "Полная будущая проводка", false, false, false, "Пустые аналитики блокируют"],
    [5, "Для удаления указать сохраняемый документ и effect SHA", "Для удаления", "Точное действие", false, false, false, "Только Операция МСФО"],
    [6, "Для доказанных SOURCE используется ДОКАЗАНО_СВЕРКОЙ; ручные решения помечаются УТВЕРЖДЕНО", "По ситуации", "DRAFT действия", false, false, false, "Это еще не разрешение на 1С"],
  ];
  writeMatrix(instruction, 4, 0, rows);
  styleBody(instruction.getRange("A5:H10"));
  setWidths(instruction, { 0: 8, 1: 42, 2: 18, 3: 28, 4: 16, 5: 16, 6: 16, 7: 55 });
  instruction.freezePanes.freezeRows(4);

  const decisionsSheet = addSheet(workbook, "Решения");
  writeMatrix(decisionsSheet, 4, 0, decisionRowsForSheet(decisions));
  formatDecisionSheet(decisionsSheet, decisions.length);

  const sources = addSheet(workbook, "Источники");
  styleTitle(sources, 0, 6, "Источники и идентичность запуска");
  writeMatrix(sources, 2, 0, [["Тип", "Путь", "SHA256", "Лист", "Количество SOURCE", "Статус"]]);
  styleHeader(sources.getRange("A3:F3"));
  writeMatrix(sources, 3, 0, [
    ["Сверка", metadata.reconciliationPath, metadata.reconciliationSha, metadata.sourceSheet ?? "НЕ НАЙДЕН", metadata.sourceCount, metadata.sourceBlocker || "OK"],
    ["Политика автопоиска", SELF_DISCOVERY_POLICY_FILE, metadata.discoveryPolicySha, "BUILT_IN", "", "PINNED"],
    ["Движок", ENGINE_FILE, metadata.engineSha, ENGINE_VERSION, "", "PINNED"],
  ]);
  styleBody(sources.getRange("A4:F6"));
  setWidths(sources, { 0: 15, 1: 90, 2: 68, 3: 28, 4: 18, 5: 35 });
  sources.freezePanes.freezeRows(3);
  await saveWorkbook(workbook, outputPath);
}

async function buildUploadWorkbook(actions, metadata, outputPath) {
  const workbook = Workbook.create();
  const warning = addSheet(workbook, "НЕ_ЗАГРУЖАТЬ");
  styleTitle(warning, 0, 8, "ПРОЕКТ КОРРЕКТИРОВОК — НЕ ЗАГРУЖАТЬ В 1С");
  styleNotice(warning, 1, 8, "Файл сформирован для проверки структуры. Все внешние gates ложны: execution_allowed=false; ready_to_upload=false; release_allowed=false.", COLORS.paleRed, COLORS.red);
  writeMatrix(warning, 3, 0, [["Показатель", "Значение", "Пояснение", "Сверка SHA256", "ERP SHA доказан", "Live preflight", "Проверка дублей", "Разрешение"]]);
  styleHeader(warning.getRange("A4:H4"));
  const provenErpCount = actions.pairRows.filter((row) => isSha256(row[18])).length;
  writeMatrix(warning, 4, 0, [
    ["posting_rows", actions.uploadRows.length, "DRAFT строки, не разрешение", metadata.reconciliationSha, provenErpCount, false, false, false],
    ["storno_repost_pairs", actions.uploadRows.filter((row) => row[4] === "STORNO").length, "Пары с точным источником", "", "", false, false, false],
    ["one_side_rows", actions.oneSideRows.length, "Только с доказательством отсутствующей стороны", "", "", false, false, false],
  ]);
  styleBody(warning.getRange("A5:H7"));
  warning.getRange("A5:H7").format.fill = COLORS.paleRed;
  setWidths(warning, { 0: 24, 1: 18, 2: 48, 3: 68, 4: 18, 5: 18, 6: 18, 7: 18 });

  const loader = addSheet(workbook, "Загрузка_A_AA");
  writeMatrix(loader, 0, 0, [LOADER_HEADERS]);
  styleHeader(loader.getRange("A1:AA1"));
  if (actions.uploadRows.length) {
    writeMatrix(loader, 1, 0, actions.uploadRows);
    styleBody(loader.getRangeByIndexes(1, 0, actions.uploadRows.length, LOADER_HEADERS.length));
    loader.getRangeByIndexes(1, 9, actions.uploadRows.length, 4).format.numberFormat = AMOUNT_FORMAT;
    loader.getRangeByIndexes(1, 15, actions.uploadRows.length, 1).format.font = { size: 8, color: "#203040" };
  }
  setWidths(loader, Object.fromEntries(Array.from({ length: 27 }, (_, index) => [index, index === 15 ? 85 : [5, 6, 21, 24].includes(index) ? 28 : 14])));
  loader.freezePanes.freezeRows(1);
  loader.freezePanes.freezeColumns(2);

  const registry = addSheet(workbook, "Реестр");
  const headers = ["CaseID", "Тип", "Решение", "PairID", "Период", "Организация", "Источник", "Дата", "Регистратор", "№ проводки", "Сумма", "Причина", "Решение", "Статус", "Блокеры", "execution_allowed", "ready_to_upload", "release_allowed"];
  styleTitle(registry, 0, headers.length, "Реестр сформированных и заблокированных решений");
  writeMatrix(registry, 2, 0, [headers]);
  styleHeader(registry.getRangeByIndexes(2, 0, 1, headers.length));
  if (actions.pairRows.length) {
    writeMatrix(registry, 3, 0, actions.pairRows);
    styleBody(registry.getRangeByIndexes(3, 0, actions.pairRows.length, headers.length));
    registry.getRangeByIndexes(3, 10, actions.pairRows.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(registry, Object.fromEntries(headers.map((_, index) => [index, [6, 8, 11, 12, 14].includes(index) ? 42 : 18])));
  registry.freezePanes.freezeRows(3);
  registry.freezePanes.freezeColumns(4);

  const controls = addSheet(workbook, "Контроль");
  styleTitle(controls, 0, 6, "Контроли DRAFT-пакета");
  writeMatrix(controls, 2, 0, [["Контроль", "Факт", "Ожидание", "Результат", "Блокирует 1С", "Комментарий"]]);
  styleHeader(controls.getRange("A3:F3"));
  const stornoCount = actions.uploadRows.filter((row) => row[4] === "STORNO").length;
  const repostCount = actions.uploadRows.filter((row) => row[4] === "REPOST").length;
  const controlRows = [
    ["Схема A:AA", LOADER_HEADERS.length, 27, LOADER_HEADERS.length === 27 ? "PASS" : "FAIL", true, "Только структурный контроль"],
    ["STORNO/REPOST", `${stornoCount}/${repostCount}`, "равное число для пар", stornoCount === repostCount ? "PASS" : "CHECK_ONE_SIDE", true, "Односторонние учитываются отдельно"],
    ["ready_to_upload", false, false, "PASS_FAIL_CLOSED", true, "Снимается только отдельным release-процессом"],
    ["release_allowed", false, false, "PASS_FAIL_CLOSED", true, "Явное разрешение пользователя отсутствует"],
    ["posting_rows", actions.uploadRows.length, "DRAFT", "INFORMATION", true, "Наличие строк не означает готовность"],
  ];
  writeMatrix(controls, 3, 0, controlRows);
  styleBody(controls.getRange("A4:F8"));
  controls.getRange("D4:D8").format.fill = COLORS.paleYellow;
  setWidths(controls, { 0: 28, 1: 20, 2: 24, 3: 24, 4: 18, 5: 60 });

  const sources = addSheet(workbook, "Источники");
  styleTitle(sources, 0, 5, "Источники DRAFT-пакета");
  writeMatrix(sources, 2, 0, [["Тип", "Путь", "SHA256", "Версия", "Статус"]]);
  styleHeader(sources.getRange("A3:E3"));
  writeMatrix(sources, 3, 0, [
    ["Сверка", metadata.reconciliationPath, metadata.reconciliationSha, "immutable input", "PINNED"],
    ["Решения", metadata.decisionPath || "Внутренний кандидат", metadata.decisionSha || "", "owner input", metadata.decisionPath ? "PINNED" : "NOT_PROVIDED"],
    ["Политика автопоиска", SELF_DISCOVERY_POLICY_FILE, metadata.discoveryPolicySha, ENGINE_VERSION, "PINNED"],
    ["Движок", ENGINE_FILE, metadata.engineSha, ENGINE_VERSION, "PINNED"],
  ]);
  styleBody(sources.getRange("A4:E7"));
  setWidths(sources, { 0: 18, 1: 90, 2: 68, 3: 22, 4: 25 });
  await saveWorkbook(workbook, outputPath);
}

async function buildStrictUploadWorkbook(canonicalRows, outputPath) {
  if (!Array.isArray(canonicalRows) || canonicalRows.some((row) =>
    row?.schema_version !== "opiu-canonical-posting-row.v1"
    || !Array.isArray(row.loader_values)
      || row.loader_values.length !== LOADER_HEADERS.length)) {
    throw new Error("CANONICAL_POSTING_ROWS_REQUIRED_FOR_A_AA_OUTPUT");
  }
  const writerBoundary = collectCanonicalFinancialOutput(canonicalRows, {
    filenameForRow: () => path.basename(outputPath),
  });
  if (writerBoundary.groups.length !== 1) throw new Error("ONE_CANONICAL_OUTPUT_GROUP_REQUIRED_PER_WORKBOOK");
  const validatedRows = writerBoundary.groups[0].rows;
  const uploadRows = validatedRows.map((row) => [...row.loader_values]);
  const workbook = Workbook.create();
  const loader = addSheet(workbook, "Загрузка_A_AA");
  writeMatrix(loader, 0, 0, [LOADER_HEADERS]);
  styleHeader(loader.getRangeByIndexes(0, 0, 1, LOADER_HEADERS.length));
  setWidths(loader, {
    0: 12, 1: 12, 2: 12, 3: 12, 4: 15,
    5: 28, 6: 28, 7: 24, 8: 24,
    9: 18, 10: 21, 11: 18, 12: 18, 13: 14, 14: 14,
    15: 70, 16: 18, 17: 18, 18: 28, 19: 18, 20: 18,
    21: 32, 22: 26, 23: 26, 24: 32, 25: 26, 26: 26,
  });
  loader.freezePanes.freezeRows(1);
  if (uploadRows.length) {
    writeMatrix(loader, 1, 0, uploadRows);
    const dataRange = loader.getRangeByIndexes(1, 0, uploadRows.length, LOADER_HEADERS.length);
    styleBody(dataRange);
    dataRange.format.rowHeight = 54;
    loader.getRangeByIndexes(1, 9, uploadRows.length, 4).format.numberFormat = AMOUNT_FORMAT;
    validatedRows.forEach((row, index) => {
      const rowRange = loader.getRangeByIndexes(index + 1, 0, 1, LOADER_HEADERS.length);
      const operation = clean(row?.operation).toUpperCase();
      rowRange.format.fill = operation === "STORNO" ? COLORS.paleOrange : COLORS.paleGreen;
      loader.getRangeByIndexes(index + 1, 4, 1, 1).format.font = {
        bold: true,
        color: operation === "STORNO" ? COLORS.red : COLORS.green,
        size: 9,
      };
    });
  }
  await saveWorkbook(workbook, outputPath);
  const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const reopenedValues = reopened.worksheets.getItem("Загрузка_A_AA").getUsedRange().values;
  if (JSON.stringify(reopenedValues[0]) !== JSON.stringify([...LOADER_HEADERS])) {
    throw new Error("CANONICAL_A_AA_HEADERS_DRIFT_AFTER_WRITE");
  }
  const reopenedRows = reopenedValues.slice(1);
  if (JSON.stringify(reopenedRows) !== JSON.stringify(uploadRows)) {
    throw new Error("CANONICAL_A_AA_VALUES_DRIFT_AFTER_WRITE");
  }
  return {
    path: outputPath,
    rows: validatedRows.map((row, index) => ({
      audit_identity: row.audit_identity,
      loader_values: [...reopenedRows[index]],
    })),
  };
}

async function createRunArchive(runDir, archivePath) {
  const zip = new JSZip();
  const rootName = path.basename(runDir);
  zip.folder(rootName);
  async function addDirectory(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const relativeDirectory = path.relative(runDir, absolute).split(path.sep).join("/");
        zip.folder(`${rootName}/${relativeDirectory}`);
        await addDirectory(absolute);
      }
      else if (entry.isFile()) {
        const relative = path.relative(runDir, absolute).split(path.sep).join("/");
        zip.file(`${rootName}/${relative}`, await fs.readFile(absolute));
      }
    }
  }
  await addDirectory(runDir);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await fs.writeFile(archivePath, bytes);
  return sha256(archivePath);
}

async function buildDeletionWorkbook(actions, metadata, outputPath) {
  const workbook = Workbook.create();
  const reportOrganization = clean(metadata.organization) || "ОРГАНИЗАЦИЯ НЕ ОПРЕДЕЛЕНА";
  const opHeaders = ["ВидДействия", "ТипДокумента", "НомерОперации", "ДатаОперации", "Организация", "ОставитьНомерОперации", "СтрокиЖурнала", "PairID", "DeleteID", "EffectSHA256", "Основание", "Статус", "execution_allowed", "ready_to_upload", "release_allowed", "Блокер"];
  const operationSheet = addSheet(workbook, "Удаление_операций");
  styleTitle(operationSheet, 0, opHeaders.length, `Проект удаления лишних операций МСФО — ${reportOrganization} — НЕ ИСПОЛНЯТЬ`);
  styleNotice(operationSheet, 1, opHeaders.length, `Организация отчёта: ${reportOrganization}. Движок не удаляет документы. Лист содержит только точные кандидаты с сохраняемой операцией и полным доказательством.`, COLORS.paleRed, COLORS.red);
  writeMatrix(operationSheet, 3, 0, [opHeaders]);
  styleHeader(operationSheet.getRangeByIndexes(3, 0, 1, opHeaders.length));
  if (actions.deletionOperations.length) {
    writeMatrix(operationSheet, 4, 0, actions.deletionOperations);
    styleBody(operationSheet.getRangeByIndexes(4, 0, actions.deletionOperations.length, opHeaders.length));
  }
  setWidths(operationSheet, Object.fromEntries(opHeaders.map((_, index) => [index, [6, 9, 10, 15].includes(index) ? 42 : 20])));
  operationSheet.freezePanes.freezeRows(4);

  const postingHeaders = ["ВидДействия", "ТипДокумента", "НомерОперации", "ДатаОперации", "Организация", "№Проводки", "ОставитьНомерОперации", "СтрокиЖурнала", "PairID", "DeleteID", "EffectSHA256", "Дт", "АналитикаДт", "Кт", "АналитикаКт", "Сумма", "Основание", "Статус", "execution_allowed", "ready_to_upload", "release_allowed", "Блокер"];
  const postingSheet = addSheet(workbook, "Удаление_проводок");
  styleTitle(postingSheet, 0, postingHeaders.length, `Проект удаления отдельных проводок документа «Операция МСФО» — ${reportOrganization} — НЕ ИСПОЛНЯТЬ`);
  styleNotice(postingSheet, 1, postingHeaders.length, `Организация отчёта: ${reportOrganization}. Каждая строка требует точного номера документа, номера проводки, источника и эффекта. Агрегатное совпадение суммы недостаточно.`, COLORS.paleRed, COLORS.red);
  writeMatrix(postingSheet, 3, 0, [postingHeaders]);
  styleHeader(postingSheet.getRangeByIndexes(3, 0, 1, postingHeaders.length));
  if (actions.deletionPostings.length) {
    writeMatrix(postingSheet, 4, 0, actions.deletionPostings);
    styleBody(postingSheet.getRangeByIndexes(4, 0, actions.deletionPostings.length, postingHeaders.length));
    postingSheet.getRangeByIndexes(4, 15, actions.deletionPostings.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(postingSheet, Object.fromEntries(postingHeaders.map((_, index) => [index, [7, 10, 16, 21].includes(index) ? 42 : 20])));
  postingSheet.freezePanes.freezeRows(4);

  const evidence = addSheet(workbook, "Проводки_доказательство");
  const evidenceHeaders = ["CaseID", "PairID", "Роль", "Дата", "Регистратор", "№ проводки", "Дт", "Аналитика Дт", "Подразделение Дт", "Кт", "Аналитика Кт", "Подразделение Кт", "Организация", "Сумма", "Источник", "ERP SHA256", "Effect SHA256", "Статус"];
  styleTitle(evidence, 0, evidenceHeaders.length, `Доказательства решений на удаление — ${reportOrganization}`);
  writeMatrix(evidence, 2, 0, [evidenceHeaders]);
  styleHeader(evidence.getRangeByIndexes(2, 0, 1, evidenceHeaders.length));
  const deletionPairs = actions.pairRows.filter((row) => ["DELETE_OPERATION", "DELETE_POSTING"].includes(row[1]));
  if (deletionPairs.length) {
    const evidenceRows = deletionPairs.map((row) => [row[0], row[3], "DELETE_CANDIDATE", row[7], row[8], row[9], "см. решения", "см. решения", "см. решения", "см. решения", "см. решения", "см. решения", row[5], row[10], row[6], "см. решения", "см. решения", row[13]]);
    writeMatrix(evidence, 3, 0, evidenceRows);
    styleBody(evidence.getRangeByIndexes(3, 0, evidenceRows.length, evidenceHeaders.length));
  }
  setWidths(evidence, Object.fromEntries(evidenceHeaders.map((_, index) => [index, [4, 14, 15, 16, 17].includes(index) ? 45 : 20])));
  evidence.freezePanes.freezeRows(3);

  const control = addSheet(workbook, "Контроль");
  styleTitle(control, 0, 6, `Контроль удаления — ${reportOrganization}`);
  writeMatrix(control, 2, 0, [["Показатель", "Операции", "Проводки", "execution_allowed", "release_allowed", "Итог"]]);
  styleHeader(control.getRange("A3:F3"));
  writeMatrix(control, 3, 0, [["Количество кандидатов", actions.deletionOperations.length, actions.deletionPostings.length, false, false, "НЕ ИСПОЛНЯТЬ"]]);
  styleBody(control.getRange("A4:F4"));
  control.getRange("A4:F4").format.fill = COLORS.paleRed;
  setWidths(control, { 0: 30, 1: 18, 2: 18, 3: 18, 4: 18, 5: 35 });

  const idCheck = addSheet(workbook, "Проверка_ID");
  styleTitle(idCheck, 0, 2, `Проверка ID — ${reportOrganization}`);
  writeMatrix(idCheck, 2, 0, [["PairID", "DeleteID", "Комментарий"]]);
  styleHeader(idCheck.getRangeByIndexes(2, 0, 1, 3));
  const idCheckRows = [...actions.deletionOperations, ...actions.deletionPostings].map((row) => [row[7], row[8], row[13]]);
  if (idCheckRows.length) {
    writeMatrix(idCheck, 3, 0, idCheckRows);
    styleBody(idCheck.getRangeByIndexes(3, 0, idCheckRows.length, 3));
  }
  setWidths(idCheck, { 0: 40, 1: 48, 2: 110 });
  idCheck.freezePanes.freezeRows(3);

  const inactive = addSheet(workbook, "Уже_неактивны");
  styleTitle(inactive, 0, 2, `Подозрительные уже неактивные строки — ${reportOrganization}`);
  writeMatrix(inactive, 2, 0, [["PairID", "Организация", "Комментарий"]]);
  styleHeader(inactive.getRangeByIndexes(2, 0, 1, 3));
  setWidths(inactive, { 0: 40, 1: 36, 2: 150 });
  inactive.freezePanes.freezeRows(3);

  const sources = addSheet(workbook, "Источники");
  styleTitle(sources, 0, 4, `Источники проекта удаления — ${reportOrganization}`);
  writeMatrix(sources, 2, 0, [["Путь", "SHA256", "Тип", "Статус"]]);
  styleHeader(sources.getRange("A3:D3"));
  writeMatrix(sources, 3, 0, [[metadata.reconciliationPath, metadata.reconciliationSha, "Сверка", "PINNED"], [SELF_DISCOVERY_POLICY_FILE, metadata.discoveryPolicySha, "Политика автопоиска", "PINNED"], [ENGINE_FILE, metadata.engineSha, "Движок", "PINNED"]]);
  styleBody(sources.getRange("A4:D6"));
  setWidths(sources, { 0: 90, 1: 68, 2: 20, 3: 25 });
  await saveWorkbook(workbook, outputPath);
}

function nestedAnalyticalNumber(item, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], item);
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function analyticalTotals(item) {
  return {
    erp: nestedAnalyticalNumber(item, ["erp_current", "ERP_CURRENT", "scenario.ERP_CURRENT"]),
    intalev: nestedAnalyticalNumber(item, ["intalev_target", "INTALEV_TARGET", "scenario.INTALEV_TARGET"]),
  };
}

function correctionAnalyticalIdentity(correction, defaultOrganization, defaultPeriod) {
  const role = clean(correction.role).toUpperCase();
  const exactPhysicalSource = correction.SOURCE_OPERATION_PROVEN === true
    && correction.PHYSICAL_SOURCE_UNIQUE === true
    && clean(correction.source_row_id);
  const discriminator = correction.partial_source_amount_proven === true || exactPhysicalSource
    ? clean(correction.source_row_id || correction.case_id)
    : ["RECLASS_SOURCE", "RECLASS_TARGET"].includes(role) && correction.accepted_economic_reclass === true
      ? role
      : "";
  return [
    clean(correction.organization) || defaultOrganization,
    clean(correction.period) || defaultPeriod,
    clean(correction.analytical_basis_id || correction.pair_id || correction.draft_id || correction.case_id),
    clean(correction.target_article || correction.target_analytics_dt1 || correction.target_analytics_kt1 || correction.group),
    discriminator,
  ].join("\u0000");
}

function proofRank(correction) {
  return ({ UNPROVEN: 1, INFERRED: 2, PROVEN: 3, USER_ACCEPTED: 4 })[clean(correction.proof_status || correction.evidence_state).toUpperCase()] ?? 0;
}

function mergeEquivalentAnalyticalCorrections(left, right) {
  const preferred = proofRank(right) > proofRank(left) ? right : left;
  const secondary = preferred === left ? right : left;
  const evidence = [...new Set([
    ...(Array.isArray(left.evidence_references) ? left.evidence_references : []),
    ...(Array.isArray(right.evidence_references) ? right.evidence_references : []),
  ].map((item) => typeof item === "string" ? item : JSON.stringify(item)))];
  const proofHistory = [...new Set([
    ...(Array.isArray(left.proof_history) ? left.proof_history : []),
    ...(Array.isArray(right.proof_history) ? right.proof_history : []),
    clean(left.original_proof_status), clean(left.proof_status),
    clean(right.original_proof_status), clean(right.proof_status),
  ].map((item) => clean(item).toUpperCase()).filter(Boolean))];
  return {
    ...secondary,
    ...preferred,
    evidence_references: evidence,
    proof_history: proofHistory,
    original_proof_status: clean(preferred.original_proof_status || secondary.original_proof_status || "UNPROVEN").toUpperCase(),
  };
}

function deduplicateAnalyticalCorrections(corrections, defaultOrganization, defaultPeriod) {
  const byIdentity = new Map();
  const blockers = [];
  for (const correction of corrections) {
    const identity = correctionAnalyticalIdentity(correction, defaultOrganization, defaultPeriod);
    const effect = nestedAnalyticalNumber(correction, ["analytical_effect", "correction_effect", "delta"]);
    const fingerprint = JSON.stringify([effect, analyticalTotals(correction)]);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, { correction, fingerprint, effect });
      continue;
    }
    const previous = byIdentity.get(identity);
    if (previous.fingerprint !== fingerprint) {
      previous.conflicted = true;
      blockers.push({
        blocker_code: "CONFLICTING_ANALYTICAL_IDENTITY",
        identity,
        previous_effect: previous.effect,
        conflicting_effect: effect,
        unresolved_effects: [previous.effect, effect].filter((value) => value !== null),
      });
    } else {
      previous.correction = mergeEquivalentAnalyticalCorrections(previous.correction, correction);
    }
  }
  return { corrections: [...byIdentity.values()].filter((item) => !item.conflicted).map((item) => item.correction), blockers };
}

function resolveAnalyticalContextTotals(group, matchingMetadata) {
  const blockers = [];
  const contextCandidates = [
    ...matchingMetadata,
    ...group.corrections.filter((item) => !clean(item.analytical_basis_id)),
  ].map((item) => ({ item, ...analyticalTotals(item) }))
    .filter((item) => item.erp !== null || item.intalev !== null);
  for (const candidate of contextCandidates) {
    if (candidate.erp === null || candidate.intalev === null) {
      blockers.push({ blocker_code: "INCOMPLETE_CONTEXT_TOTALS", organization: group.organization, period: group.period });
    }
  }
  if (blockers.some((item) => item.blocker_code === "INCOMPLETE_CONTEXT_TOTALS")) {
    return { erp: null, intalev: null, trace: "INCOMPLETE_CONTEXT_TOTALS", blockers };
  }
  const completeContextCandidates = contextCandidates.filter((item) => item.erp !== null && item.intalev !== null);
  const distinctContextTotals = new Map(completeContextCandidates.map((item) => [
    `${Math.round(item.erp * 100)}:${Math.round(item.intalev * 100)}`,
    item,
  ]));
  if (distinctContextTotals.size > 1) {
    blockers.push({ blocker_code: "BLOCKED_CONTEXT_TOTAL_CONFLICT", organization: group.organization, period: group.period, totals: [...distinctContextTotals.keys()] });
    return { erp: null, intalev: null, trace: "CONFLICT", blockers };
  }
  if (distinctContextTotals.size === 1) {
    const selected = [...distinctContextTotals.values()][0];
    return { erp: selected.erp, intalev: selected.intalev, trace: "EXPLICIT_SCOPED_CONTEXT_TOTALS", blockers };
  }

  const basisById = new Map();
  let invalidBasisContract = false;
  for (const correction of group.corrections) {
    const basisId = clean(correction.analytical_basis_id);
    if (!basisId) continue;
    const basisContractBlockers = Array.isArray(correction.basis_contract_blockers)
      ? correction.basis_contract_blockers.map(clean).filter(Boolean)
      : [];
    if (basisContractBlockers.length) {
      invalidBasisContract = true;
      for (const blockerCode of basisContractBlockers) {
        blockers.push({
          blocker_code: blockerCode,
          organization: group.organization,
          period: group.period,
          analytical_basis_id: basisId,
        });
      }
      continue;
    }
    const totals = analyticalTotals(correction);
    if (totals.erp === null || totals.intalev === null) {
      blockers.push({ blocker_code: "INCOMPLETE_R005_BASIS_TOTALS", organization: group.organization, period: group.period, analytical_basis_id: basisId });
      continue;
    }
    const signature = `${Math.round(totals.erp * 100)}:${Math.round(totals.intalev * 100)}`;
    if (basisById.has(basisId) && basisById.get(basisId).signature !== signature) {
      blockers.push({ blocker_code: "CONFLICTING_R005_BASIS_TOTALS", organization: group.organization, period: group.period, analytical_basis_id: basisId });
      continue;
    }
    basisById.set(basisId, { ...totals, signature });
  }
  if (!basisById.size || invalidBasisContract || blockers.some((item) => /BASIS_TOTALS/.test(item.blocker_code))) {
    return { erp: null, intalev: null, trace: "MISSING_OR_CONFLICTING_R005_BASIS", blockers };
  }
  const erpCents = [...basisById.values()].reduce((sum, item) => sum + Math.round(item.erp * 100), 0);
  const intalevCents = [...basisById.values()].reduce((sum, item) => sum + Math.round(item.intalev * 100), 0);
  return { erp: erpCents / 100, intalev: intalevCents / 100, trace: "SUM_UNIQUE_R005_ANALYTICAL_BASIS_ROWS", blockers };
}

function buildAnalyticalPolicyReport(decisions, disputedSidecar, metadata, period, annualRequested = false) {
  const defaultOrganization = clean(metadata.organization);
  const defaultPeriod = clean(period);
  const annualYear = defaultPeriod.match(/^(\d{4})(?:$|-)/)?.[1] || "";
  const deduplicated = deduplicateAnalyticalCorrections(
    [...decisions, ...(disputedSidecar.analyticalDecisions ?? [])],
    defaultOrganization,
    defaultPeriod,
  );
  const corrections = deduplicated.corrections;
  const contextMetadata = [
    ...(decisions?.analyticalContexts ?? []),
    ...(disputedSidecar.analyticalContexts ?? []),
  ];
  const reportBlockers = [...deduplicated.blockers];
  for (const item of contextMetadata) {
    if (!clean(item.organization) || !/^(\d{4})-(0[1-9]|1[0-2])$/.test(clean(item.period))) {
      reportBlockers.push({
        blocker_code: "UNSCOPED_ANALYTICAL_CONTEXT_METADATA",
        organization: clean(item.organization),
        period: clean(item.period),
      });
    }
  }
  const grouped = new Map();
  const addGroup = (organization, correctionPeriod) => {
    const key = `${organization}\u0000${correctionPeriod}`;
    if (!grouped.has(key)) grouped.set(key, { organization, period: correctionPeriod, corrections: [] });
    return grouped.get(key);
  };
  if (annualRequested) {
    for (const item of contextMetadata) {
      const organization = clean(item.organization);
      const itemPeriod = clean(item.period);
      if (!organization || !new RegExp(`^${annualYear}-(0[1-9]|1[0-2])$`).test(itemPeriod)) continue;
      addGroup(organization, itemPeriod);
    }
  } else addGroup(defaultOrganization, defaultPeriod);
  for (const correction of corrections) {
    const organization = clean(correction.organization) || defaultOrganization;
    const correctionPeriod = clean(correction.period) || defaultPeriod;
    if (annualRequested) {
      if (!organization || !new RegExp(`^${annualYear}-(0[1-9]|1[0-2])$`).test(correctionPeriod)) {
        reportBlockers.push({ blocker_code: "INVALID_ANNUAL_CONTEXT", organization, period: correctionPeriod, year: annualYear });
        continue;
      }
      addGroup(organization, correctionPeriod).corrections.push(correction);
    } else addGroup(defaultOrganization, defaultPeriod).corrections.push(correction);
  }
  const contexts = [];
  for (const group of grouped.values()) {
    const matchingMetadata = contextMetadata.filter((item) =>
      clean(item.organization) === group.organization && clean(item.period) === group.period);
    const totals = resolveAnalyticalContextTotals(group, matchingMetadata);
    const context = buildAnalyticalContext({
      organization: group.organization,
      period: group.period,
      erp_current: totals.erp,
      intalev_target: totals.intalev,
      corrections: group.corrections,
    });
    context.context_totals_trace = totals.trace;
    context.blockers.push(...totals.blockers);
    context.counts.blockers = context.blockers.length;
    contexts.push(context);
  }
  const annualSummaries = [];
  if (annualRequested) {
    for (const organization of [...new Set(contexts.map((item) => item.organization))]) {
      annualSummaries.push(aggregateAnnualMonthlyResults(
        contexts.filter((item) => item.organization === organization && item.period.startsWith(`${annualYear}-`)),
        { organization, year: annualYear },
      ));
    }
  }
  const annualBlockerCount = annualSummaries.reduce((sum, item) => sum + (item.blockers?.length ?? 0), 0);
  return {
    schema_version: "r001-analytical-policy-report-1.0.0",
    contexts,
    annual_summaries: annualSummaries,
    blockers: reportBlockers,
    counts: {
      analytical_draft_corrections: contexts.reduce((sum, item) => sum + item.counts.analytical_draft_corrections, 0),
      review_required: contexts.reduce((sum, item) => sum + item.counts.review_required, 0),
      analytical_blockers: reportBlockers.length + annualBlockerCount + contexts.reduce((sum, item) => sum + item.counts.blockers, 0),
      structurally_generated_loader_draft_rows: 0,
      live_executable_rows: 0,
    },
    safety: {
      execution_allowed: false,
      live_posting_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      live_delete_allowed: false,
      live_1c_allowed: false,
    },
  };
}

function appendMaterializationSheet(workbook, sheetName, materializationRows) {
  const headers = [
    "AuditIdentity", "CaseID", "PairID", "Операция", "Период", "Организация сверки",
    "Организация источника ERP", "SourceRowID", "ERP архив", "SHA256 ERP архива",
    "ERP файл в архиве", "SHA256 ERP файла", "Лист", "ERP строка", "Дата источника",
    "Регистратор/документ", "№ проводки", "Output route", "Статус материализации",
    "Proof status", "Correction allowed", "Correction authority", "Сумма", "Причина",
    "Блокеры", "A:AA JSON", "execution_allowed", "ready_to_upload", "live_1c_allowed",
  ];
  const sheet = addSheet(workbook, sheetName);
  styleTitle(sheet, 0, headers.length, "Единый реестр CanonicalPostingRow: A:AA → аудит → manifest");
  styleNotice(sheet, 1, headers.length, "Каждая строка соответствует ровно одной строке READY/SPORNO A:AA. REPORT_ONLY: execution_allowed=false; ready_to_upload=false; live_1c_allowed=false.", COLORS.paleRed, COLORS.red);
  writeMatrix(sheet, 3, 0, [headers]);
  styleHeader(sheet.getRangeByIndexes(3, 0, 1, headers.length));
  const values = materializationRows.map((audit) => [
    audit.audit_identity, audit.case_id, audit.pair_id, audit.operation, audit.period,
    audit.reconciliation_organization, audit.source_organization, audit.source_row_id,
    audit.source_archive_path, audit.source_archive_sha256, audit.journal_entry, audit.journal_sha256,
    audit.source_sheet, audit.source_range, audit.source_date, audit.document, audit.posting_number,
    audit.output_route, audit.materialization_state, audit.proof_status, audit.correction_allowed,
    audit.correction_authority, audit.amount, audit.reason, (audit.blockers ?? []).join("; "),
    JSON.stringify(audit.loader_values), false, false, false,
  ]);
  if (values.length) {
    writeMatrix(sheet, 4, 0, values);
    styleBody(sheet.getRangeByIndexes(4, 0, values.length, headers.length));
    sheet.getRangeByIndexes(4, 22, values.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(sheet, Object.fromEntries(headers.map((_, index) => [index, [8, 10, 15, 23, 24, 25].includes(index) ? 70 : 20])));
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(3);
  return sheet;
}

async function buildEnrichedReconciliation(workbook, materializationRows, outputPath) {
  appendMaterializationSheet(workbook, "10_R001_Материализация", materializationRows);
  await saveWorkbook(workbook, outputPath);
}

function exactUniqueDecisionRows(rows = []) {
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const identity = JSON.stringify(row);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(row);
  }
  return unique;
}

function canonicalLoaderContent(audit = {}) {
  if (Array.isArray(audit.loader_values) && audit.loader_values.length > 15) {
    return audit.loader_values[15] ?? "";
  }
  return audit.loader?.["Содержание"] ?? "";
}

function disputedTraceRow(audit) {
  return [
    audit.pair_id, audit.audit_identity, audit.operation, audit.period, audit.source_organization,
    audit.source_range, audit.document, audit.posting_number, audit.amount,
    canonicalLoaderContent(audit), [
      `AuditIdentity=${audit.audit_identity}`,
      `CaseID=${audit.case_id}`,
      `SourceRowID=${audit.source_row_id}`,
      `SourceArchiveSHA256=${audit.source_archive_sha256}`,
      `JournalSHA256=${audit.journal_sha256}`,
      `Route=${audit.output_route}`,
      `State=${audit.materialization_state}`,
      `Blockers=${(audit.blockers ?? []).join(",")}`,
    ].join(" | "),
  ];
}

async function buildMasterRegistry(decisions, actions, metadata, outputPath, disputedRows = [], reviewRows = [], analyticalPolicy = null, materializationRows = []) {
  const workbook = Workbook.create();
  const allDecisionRows = exactUniqueDecisionRows([...actions.pairRows, ...reviewRows]);
  const allBlockerRows = [...actions.blockers, ...reviewRows];
  const passport = addSheet(workbook, "00_Паспорт");
  styleTitle(passport, 0, 8, "Реестр движка корректировок ОПИУ R001");
  styleNotice(passport, 1, 8, "Артефакт QA, не разрешение на загрузку или удаление. execution_allowed=false; ready_to_upload=false; release_allowed=false.", COLORS.paleRed, COLORS.red);
  writeMatrix(passport, 3, 0, [["Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение"]]);
  styleHeader(passport.getRange("A4:H4"));
  writeMatrix(passport, 4, 0, [
    ["Engine", ENGINE_VERSION, "RunID", metadata.runId, "SOURCE кандидаты", metadata.sourceCount, "Решения", decisions.length + reviewRows.length],
    ["Canonical financial rows", materializationRows.length, "Удаление операций", actions.deletionOperations.length, "Удаление проводок", actions.deletionPostings.length, "Блокеры", allBlockerRows.length],
    ["execution_allowed", false, "ready_to_upload", false, "release_allowed", false, "1С", "НЕ ЗАГРУЖАТЬ"],
    ["Сверка SHA256", metadata.reconciliationSha, "Решения SHA256", metadata.decisionSha || "ВНУТРЕННИЙ АВТОПОИСК", "Автопоиск SHA256", metadata.discoveryPolicySha, "Статус", "REPORT_ONLY"],
    ["Analytical drafts", analyticalPolicy?.counts?.analytical_draft_corrections ?? 0, "Review required", analyticalPolicy?.counts?.review_required ?? 0, "Live rows", 0, "Analytical gate", "REPORT_ONLY"],
  ]);
  styleBody(passport.getRange("A5:H9"));
  passport.getRange("A7:H8").format.fill = COLORS.paleRed;
  setWidths(passport, { 0: 24, 1: 44, 2: 24, 3: 44, 4: 24, 5: 44, 6: 24, 7: 32 });
  passport.freezePanes.freezeRows(4);

  const headers = ["CaseID", "Тип", "Решение", "PairID", "Период", "Организация", "Источник", "Дата", "Регистратор", "№ проводки", "Сумма", "Причина", "Предлагаемое решение", "Статус", "Блокеры", "execution_allowed", "ready_to_upload", "release_allowed"];
  const all = addSheet(workbook, "01_Решения");
  styleTitle(all, 0, headers.length, "Все решения и кандидаты");
  writeMatrix(all, 2, 0, [headers]);
  styleHeader(all.getRangeByIndexes(2, 0, 1, headers.length));
  if (allDecisionRows.length) {
    writeMatrix(all, 3, 0, allDecisionRows);
    styleBody(all.getRangeByIndexes(3, 0, allDecisionRows.length, headers.length));
    all.getRangeByIndexes(3, 10, allDecisionRows.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(all, Object.fromEntries(headers.map((_, index) => [index, [6, 8, 11, 12, 14].includes(index) ? 42 : 18])));
  all.freezePanes.freezeRows(3);
  all.freezePanes.freezeColumns(4);

  for (const [sheetName, typeMatcher, title] of [
    ["02_STORNO_REPOST", new Set(["STORNO_REPOST"]), "Решения STORNO/REPOST"],
    ["03_Односторонние", new Set(["ADD_ONE_SIDE"]), "Решения на закрытие односторонних расхождений"],
    ["04_Удаления", new Set(["DELETE_OPERATION", "DELETE_POSTING"]), "Решения на удаление операций и проводок"],
  ]) {
    const sheet = addSheet(workbook, sheetName);
    styleTitle(sheet, 0, headers.length, title);
    writeMatrix(sheet, 2, 0, [headers]);
    styleHeader(sheet.getRangeByIndexes(2, 0, 1, headers.length));
    const rows = allDecisionRows.filter((row) => typeMatcher.has(row[1]));
    if (rows.length) {
      writeMatrix(sheet, 3, 0, rows);
      styleBody(sheet.getRangeByIndexes(3, 0, rows.length, headers.length));
      sheet.getRangeByIndexes(3, 10, rows.length, 1).format.numberFormat = AMOUNT_FORMAT;
    }
    setWidths(sheet, Object.fromEntries(headers.map((_, index) => [index, [6, 8, 11, 12, 14].includes(index) ? 42 : 18])));
    sheet.freezePanes.freezeRows(3);
  }

  const blockerSheet = addSheet(workbook, "05_Блокеры");
  styleTitle(blockerSheet, 0, headers.length, "Незакрытые блокеры");
  writeMatrix(blockerSheet, 2, 0, [headers]);
  styleHeader(blockerSheet.getRangeByIndexes(2, 0, 1, headers.length));
  if (allBlockerRows.length) {
    writeMatrix(blockerSheet, 3, 0, allBlockerRows);
    styleBody(blockerSheet.getRangeByIndexes(3, 0, allBlockerRows.length, headers.length));
    blockerSheet.getRangeByIndexes(3, 0, allBlockerRows.length, headers.length).format.fill = COLORS.paleOrange;
  }
  setWidths(blockerSheet, Object.fromEntries(headers.map((_, index) => [index, [6, 8, 11, 12, 14].includes(index) ? 42 : 18])));
  blockerSheet.freezePanes.freezeRows(3);

  const disputedTraceHeaders = ["PairID", "UploadID", "Операция", "Период", "Организация", "ERP диапазон", "Регистратор ERP", "№ проводки", "Сумма", "Комментарий загрузочного файла", "Полная техническая трасса"];
  const disputedTrace = addSheet(workbook, "06_Трасса_СПОРНО");
  styleTitle(disputedTrace, 0, disputedTraceHeaders.length, "Полная трасса спорных загрузочных строк");
  writeMatrix(disputedTrace, 2, 0, [disputedTraceHeaders]);
  styleHeader(disputedTrace.getRangeByIndexes(2, 0, 1, disputedTraceHeaders.length));
  const disputedTraceRows = materializationRows
    .filter((row) => row.output_route === "SPORNO")
    .map(disputedTraceRow);
  if (disputedTraceRows.length) {
    writeMatrix(disputedTrace, 3, 0, disputedTraceRows);
    styleBody(disputedTrace.getRangeByIndexes(3, 0, disputedTraceRows.length, disputedTraceHeaders.length));
    disputedTrace.getRangeByIndexes(3, 8, disputedTraceRows.length, 1).format.numberFormat = AMOUNT_FORMAT;
    disputedTrace.getRangeByIndexes(3, 9, disputedTraceRows.length, 2).format.wrapText = true;
  }
  setWidths(disputedTrace, { 0: 34, 1: 34, 2: 16, 3: 14, 4: 34, 5: 38, 6: 48, 7: 16, 8: 18, 9: 90, 10: 110 });
  disputedTrace.freezePanes.freezeRows(3);
  disputedTrace.freezePanes.freezeColumns(2);

  const sources = addSheet(workbook, "07_Источники");
  styleTitle(sources, 0, 6, "Источники и хеши");
  writeMatrix(sources, 2, 0, [["Тип", "Путь", "SHA256", "Лист", "Записей", "Статус"]]);
  styleHeader(sources.getRange("A3:F3"));
  writeMatrix(sources, 3, 0, [
    ["Сверка", metadata.reconciliationPath, metadata.reconciliationSha, metadata.sourceSheet ?? "", metadata.sourceCount, metadata.sourceBlocker || "OK"],
    ["Решения", metadata.decisionPath || "Внутренние кандидаты", metadata.decisionSha || "", "Решения", decisions.length, metadata.decisionPath ? "PINNED" : "NOT_PROVIDED"],
    ["Политика автопоиска", SELF_DISCOVERY_POLICY_FILE, metadata.discoveryPolicySha, "BUILT_IN", "", "PINNED"],
    ["Движок", ENGINE_FILE, metadata.engineSha, ENGINE_VERSION, "", "PINNED"],
    ["Analytical policy", ANALYTICAL_POLICY_FILE, metadata.analyticalPolicySha, "R001 pure helper", "", "PINNED"],
  ]);
  styleBody(sources.getRange("A4:F8"));
  setWidths(sources, { 0: 18, 1: 90, 2: 68, 3: 32, 4: 16, 5: 30 });

  const analyticalHeaders = ["DraftID", "PairID", "Организация", "Период", "Семейство", "Эффект", "Proof status", "Исходный proof", "Целевая статья", "Группа", "Целевая сторона", "Неизвестные аналитики", "Review state", "Причина", "Доказательства", "execution_allowed", "ready_to_upload", "release_allowed"];
  const analyticalSheet = addSheet(workbook, "08_Аналитические");
  styleTitle(analyticalSheet, 0, analyticalHeaders.length, "Неисполняемые аналитические черновики R001");
  writeMatrix(analyticalSheet, 2, 0, [analyticalHeaders]);
  styleHeader(analyticalSheet.getRangeByIndexes(2, 0, 1, analyticalHeaders.length));
  const analyticalRows = (analyticalPolicy?.contexts ?? []).flatMap((context) => context.analytical_draft_corrections.map((draft) => [
    draft.draft_id, draft.pair_id, draft.organization, draft.period, draft.correction_family,
    draft.analytical_effect, draft.proof_status, draft.original_proof_status, draft.target_article,
    draft.disclosure_group, draft.target_side, draft.missing_or_unknown_analytics.join("; "),
    draft.review_state, draft.reason, draft.evidence_references.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("; "),
    false, false, false,
  ]));
  if (analyticalRows.length) {
    writeMatrix(analyticalSheet, 3, 0, analyticalRows);
    styleBody(analyticalSheet.getRangeByIndexes(3, 0, analyticalRows.length, analyticalHeaders.length));
    analyticalSheet.getRangeByIndexes(3, 5, analyticalRows.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(analyticalSheet, Object.fromEntries(analyticalHeaders.map((_, index) => [index, [11, 13, 14].includes(index) ? 55 : 20])));
  analyticalSheet.freezePanes.freezeRows(3);

  const reviewSheet = addSheet(workbook, "09_На_проверку");
  styleTitle(reviewSheet, 0, analyticalHeaders.length, "INFERRED / UNPROVEN — отдельный список проверки");
  writeMatrix(reviewSheet, 2, 0, [analyticalHeaders]);
  styleHeader(reviewSheet.getRangeByIndexes(2, 0, 1, analyticalHeaders.length));
  const reviewPolicyRows = (analyticalPolicy?.contexts ?? []).flatMap((context) => context.review_required.map((item) => [
    item.draft_id, item.pair_id, item.organization, item.period, item.correction_family,
    item.analytical_effect, item.proof_status, item.original_proof_status, item.target_article,
    item.disclosure_group, item.target_side, item.missing_or_unknown_analytics.join("; "),
    item.review_state, item.reason, item.evidence_references.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join("; "),
    false, false, false,
  ]));
  if (reviewPolicyRows.length) {
    writeMatrix(reviewSheet, 3, 0, reviewPolicyRows);
    styleBody(reviewSheet.getRangeByIndexes(3, 0, reviewPolicyRows.length, analyticalHeaders.length));
    reviewSheet.getRangeByIndexes(3, 5, reviewPolicyRows.length, 1).format.numberFormat = AMOUNT_FORMAT;
  }
  setWidths(reviewSheet, Object.fromEntries(analyticalHeaders.map((_, index) => [index, [11, 13, 14].includes(index) ? 55 : 20])));
  reviewSheet.freezePanes.freezeRows(3);
  appendMaterializationSheet(workbook, "10_Материализация", materializationRows);
  await saveWorkbook(workbook, outputPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serviceOrganizationName = clean(args.organization);
  if (!args.reconciliation) {
    throw new Error("Usage: node correction_engine_r001.mjs --reconciliation <xlsx> [--codex-input <json>] [--output <folder>] [--period YYYY-MM] [--organization name]");
  }
  if (args.handoff || args.decisions) {
    throw new Error("EXTERNAL_RULES_DISABLED: передайте только доказательную сверку; R001 сам определяет корректировки");
  }
  const reconciliationPath = path.resolve(args.reconciliation);
  const codexInputPath = args["codex-input"] ? path.resolve(args["codex-input"]) : "";
  const decisionPath = "";
  const baseOutput = args.output ? path.resolve(args.output) : path.resolve("./outputs");
  const runId = timestampId();
  const runDir = path.join(baseOutput, `CORR_${runId}`);
  await fs.mkdir(runDir, { recursive: true });

  const [reconciliationSha, discoveryPolicySha, engineSha, analyticalPolicySha] = await Promise.all([
    sha256(reconciliationPath),
    sha256(SELF_DISCOVERY_POLICY_FILE),
    sha256(ENGINE_FILE),
    sha256(ANALYTICAL_POLICY_FILE),
  ]);
  const discoveryPolicy = CORRECTION_SELF_DISCOVERY_POLICY;
  const reconciliation = await readReconciliation(reconciliationPath);
  const requestedPeriod = clean(args.period);
  const requestedAccountingPeriods = new Set(accountingPeriods(requestedPeriod));
  const hierarchyAuthority = await deriveHierarchyExactAmountAuthority({
    treeRows: reconciliation.treeAllRecords ?? [],
    period: requestedPeriod || reconciliation.reconciliationPeriod || "",
    reconciliationOrganization: serviceOrganizationName || reconciliation.reconciliationOrganization || "",
    sourceArchiveSha256: reconciliation.erpSourcePackageSha,
    sourceSheet: reconciliation.erpSourceSheet,
    reconciliationSha256: reconciliationSha,
  });
  const sourceRowsForPeriod = reconciliation.sourceRecords.filter((row) => !requestedPeriod || !isExplicit(row["Дата"]) || requestedAccountingPeriods.has(inferPeriod(row["Дата"])));
  // A semantic decision sheet owns the economic decisions for this workbook.
  // Proven ERP rows remain evidence and must not become duplicate decisions.
  const sourceCandidates = reconciliation.embeddedDecisions?.length
    ? []
    : sourceRowsForPeriod.map((row) => candidateFromSource(row, reconciliationSha, reconciliation, requestedPeriod || reconciliation.reconciliationPeriod || "", serviceOrganizationName));
  const treeRowsForPeriod = (reconciliation.treeRecords ?? []).filter((row) => !requestedPeriod || !isExplicit(row["Дата"]) || requestedAccountingPeriods.has(inferPeriod(row["Дата"])));
  const treeCandidates = sourceCandidates.length || reconciliation.embeddedDecisions?.length
    ? []
    : treeRowsForPeriod.map((row) => candidateFromTree(row, reconciliationSha, reconciliation, requestedPeriod || reconciliation.reconciliationPeriod || ""));
  const candidatesById = new Map();
  for (const decision of [
    ...sourceCandidates,
    ...treeCandidates,
    ...(reconciliation.embeddedDecisions ?? []),
    ...(hierarchyAuthority.decisions ?? []),
  ]) {
    // A semantic reconciliation case can contain several member legs and a
    // control reference.  CaseID alone is therefore not a row identity.
    const key = clean(decision.embedded_decision_identity)
      || [clean(decision.case_id), clean(decision.pair_id), clean(decision.reconciliation_row), clean(decision.role)]
        .filter(Boolean).join("|")
      || stableId("CASE", decision);
    candidatesById.set(key, decision);
  }
  const candidates = [...candidatesById.values()];
  const providedDecisions = await readDecisionFile(decisionPath, {
    organization: serviceOrganizationName || reconciliation.reconciliationOrganization,
    period: requestedPeriod || reconciliation.reconciliationPeriod || "",
  });
  const decisions = mergeProvidedAndAutonomousDecisions(
    providedDecisions,
    candidates,
  ) ?? candidates;
  const decisionSha = decisionPath ? await sha256(decisionPath) : "";
  const selectedOrganization = serviceOrganizationName || reconciliation.reconciliationOrganization || clean(discoveryPolicy.zero_sum_internal_reclassification?.organization_reference?.top_level_name);
  const selectedPeriod = requestedPeriod || reconciliation.reconciliationPeriod || clean(decisions[0]?.period);
  const selectedAccountingPeriods = new Set(accountingPeriods(selectedPeriod));
  const actionDecisions = decisions.filter((decision) =>
    clean(decision.organization) === selectedOrganization
    && selectedAccountingPeriods.has(clean(decision.period))
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(clean(decision.period)));
  const inputIsolatedDecisions = decisions.filter((decision) => !actionDecisions.includes(decision));

  const currentRunAuthority = await deriveCurrentRunCanonicalAuthority(actionDecisions, {
    provenance: {
      source: "CURRENT_RUN_CORE_REDERIVATION",
      decision_sha256: decisionSha,
      reconciliation_sha256: reconciliationSha,
      run_id: runId,
    },
  });
  const trustedActionDecisions = currentRunAuthority.decisions;
  const trustedByInputDecision = new Map(actionDecisions.map((decision, index) => [
    decision,
    trustedActionDecisions[index],
  ]));
  const trustedDecisions = decisions.map((decision) => trustedByInputDecision.get(decision)
    ?? stripExternalCanonicalAuthority(decision).decision);
  const isolatedDecisions = inputIsolatedDecisions.map((decision) => stripExternalCanonicalAuthority(decision).decision);

  const groupScopedEvaluationByDecision = new Map();
  for (const decision of trustedActionDecisions) {
    if (clean(decision.role).toUpperCase() !== "RECLASS_SOURCE") continue;
    const embeddedContext = reconciliation.intalevBlockByCode?.get(clean(decision.reconciliation_row));
    const context = embeddedContext?.block
      ? embeddedContext
      : {
          block: clean(decision.intalev_block),
          path: clean(decision.intalev_path),
          intalevReference: clean(decision.intalev_source_reference),
          intalevAmount: numberValue(decision.intalev_amount),
        };
    if (!context?.block || !clean(decision.group || decision.source_article)) continue;
    groupScopedEvaluationByDecision.set(decision, evaluateGroupScopedDecision({
      decision,
      catalogNodes: reconciliation.erpCatalogNodes ?? [],
      intalevBlock: context.block,
      intalevPath: context.path,
      intalevReference: context.intalevReference,
      intalevAmount: context.intalevAmount,
    }));
  }
  const groupScopedCanonicalRows = [...groupScopedEvaluationByDecision.values()]
    .flatMap((evaluation) => evaluation.canonical_posting_rows ?? []);
  const groupScopedMaterializedCaseIds = new Set([...groupScopedEvaluationByDecision.entries()]
    .filter(([, evaluation]) => (evaluation.canonical_posting_rows ?? []).length > 0)
    .map(([decision]) => clean(decision.case_id))
    .filter(Boolean));

  const metadata = {
    runId,
    organization: selectedOrganization,
    reconciliationPath,
    reconciliationSha,
    sourceSheet: reconciliation.sheetName,
    sourceCount: sourceRowsForPeriod.length,
    candidateOperationCount: treeRowsForPeriod.length,
    sourceBlocker: reconciliation.blocker,
    erpJournalPath: reconciliation.erpJournalPath,
    erpJournalSha: reconciliation.erpJournalSha,
    erpJournalActualSha: reconciliation.erpJournalActualSha,
    erpJournalHashState: reconciliation.erpJournalHashState,
    decisionPath,
    decisionSha,
    discoveryPolicySha,
    engineSha,
    analyticalPolicySha,
    r001HandoffPath: "",
    r001HandoffSha: "",
    sourceRunId: "",
    currentRunCanonicalAuthority: currentRunAuthority.audit,
    hierarchyAuthority: hierarchyAuthority.audit,
  };
  const actions = actionRows(trustedActionDecisions, reconciliationSha);
  const hasOwnerEconomicCases = trustedActionDecisions.some((decision) => clean(decision.role).toUpperCase() === "RECLASS_SOURCE")
    && trustedActionDecisions.some((decision) => clean(decision.role).toUpperCase() === "RECLASS_TARGET");
  const materialization = hasOwnerEconomicCases
    ? await materializeOwnerEconomicDrafts({
        decisions: trustedActionDecisions,
        treeRows: reconciliation.treeAllRecords ?? treeRowsForPeriod,
        period: selectedAccountingPeriods.size === 1 ? selectedPeriod : "",
        reconciliationOrganization: selectedOrganization,
      })
      : {
        groups: new Map(), rows: [], canonical_posting_rows: [], blockers: [], cases: [], posting_rows: 0, materialized_posting_rows: 0,
        storno_rows: 0, repost_rows: 0, executed_posting_rows: 0, live_posting_rows: 0,
        execution_allowed: false, live_1c_allowed: false, live_delete_allowed: false,
      };
  const failedExactCaseIds = new Set(materialization.cases
    .filter((item) => Array.isArray(item.blockers) && item.blockers.length > 0)
    .map((item) => clean(item.case_id))
    .filter(Boolean));
  const exactCanonicalRows = excludeHierarchyCoveredEconomicRows(
    materialization.canonical_posting_rows ?? [],
    hierarchyAuthority.covered_economic_route_case_ids ?? [],
  )
    .filter((row) => !failedExactCaseIds.has(clean(row.case_id)))
    .filter((row) => !groupScopedMaterializedCaseIds.has(clean(row.case_id)));
  const currentRunStandaloneRows = currentRunAuthority.canonical_posting_rows
    .filter((row) => !groupScopedMaterializedCaseIds.has(clean(row.case_id)));
  const alreadyMaterializedCaseIds = new Set([
    ...groupScopedMaterializedCaseIds,
    ...exactCanonicalRows.map((row) => clean(row.case_id)),
    ...currentRunStandaloneRows.map((row) => clean(row.case_id)),
    ...(hierarchyAuthority.covered_economic_route_case_ids ?? []),
  ].filter(Boolean));
  const sparseEconomicMaterialization = materializeSparseEconomicDrafts({
    decisions: trustedActionDecisions,
    reconciliationOrganization: selectedOrganization,
    excludeCaseIds: alreadyMaterializedCaseIds,
  });
  const sparseEconomicRows = sparseEconomicMaterialization.canonical_posting_rows ?? [];
  const sparseEconomicCaseIds = new Set(sparseEconomicMaterialization.cases.map((item) => clean(item.case_id)).filter(Boolean));
  const canonicalOutput = collectCanonicalFinancialOutput([
    ...currentRunStandaloneRows,
    ...exactCanonicalRows,
    ...groupScopedCanonicalRows,
    ...sparseEconomicRows,
  ], {
    filenameForRow: (row) => row.output_route === "READY"
      ? buildOwnerUploadFileName({ organization: row.source_organization, sourceDate: row.period })
      : buildDisputedOwnerUploadFileName({ organization: row.source_organization, sourceDate: row.period }),
  });
  metadata.materializedPostingRows = canonicalOutput.counters.canonical_financial_rows_total;
  metadata.sparseEconomicMaterialization = sparseEconomicMaterialization.audit;
  const materializationByCase = new Map([
    ...materialization.cases,
    ...sparseEconomicMaterialization.cases,
  ].map((item) => [clean(item.case_id), item]));
  const canonicalRowsByCase = new Map();
  for (const row of canonicalOutput.rows) {
    if (!canonicalRowsByCase.has(row.case_id)) canonicalRowsByCase.set(row.case_id, []);
    canonicalRowsByCase.get(row.case_id).push(row);
  }
  const outputDecisions = trustedDecisions.map((decision) => {
    const result = materializationByCase.get(clean(decision.case_id));
    const canonicalRows = canonicalRowsByCase.get(clean(decision.case_id)) ?? [];
    const groupScoped = groupScopedEvaluationByDecision.get(decision);
    const groupTarget = groupScoped?.target_article;
    const embeddedIntalevContext = reconciliation.intalevBlockByCode?.get(clean(decision.reconciliation_row));
    const intalevContext = embeddedIntalevContext?.block
      ? embeddedIntalevContext
      : { block: clean(decision.intalev_block), path: clean(decision.intalev_path) };
    return {
      ...decision,
      target_code: groupTarget?.article_code || clean(decision.target_code),
      intalev_block: intalevContext?.block || clean(decision.intalev_block),
      intalev_path: intalevContext?.path || clean(decision.intalev_path),
      group_scoped_target_status: groupScoped?.status || "",
      target_catalog_path: groupTarget?.catalog_path || clean(decision.target_catalog_path),
      target_operating_account: groupTarget?.operating_account || clean(decision.target_operating_account),
      group_scoped_target_blocker: (groupScoped?.blockers ?? []).join("; "),
      reconciliation_organization: selectedOrganization,
      source_organization: [...new Set(canonicalRows.map((row) => row.source_organization).filter(Boolean))].join("; ")
        || result?.source_organizations?.join("; ")
        || clean(decision.source_organization),
      materialization_state: groupScoped?.canonical_posting_rows?.length
        ? "MATERIALIZED_GROUP_SCOPED_SPORNO_REPOST"
        : [...new Set(canonicalRows.map((row) => row.materialization_state))].join("; ")
        || (Number(result?.posting_rows ?? 0) > 0 ? "BLOCKED_CANONICAL_OUTPUT_EXCLUDED" : result?.materialization_state)
        || "NO_FINANCIAL_POSTING",
    };
  });
  for (const blocker of materialization.blockers) {
    if ([...sparseEconomicCaseIds].some((caseId) => clean(blocker).startsWith(`${caseId}:`))) continue;
    actions.blockers.push([
      "MATERIALIZATION", "STORNO_REPOST", "ПРЕДЛОЖЕНО", "", selectedPeriod, selectedOrganization,
      "", "", "", "", "", "Материализация точных строк ERP", "Проверить источник и повторить",
      "BLOCKED_REVIEW", blocker, false, false, false,
    ]);
  }
  for (const [decision, evaluation] of groupScopedEvaluationByDecision) {
    if (normalizedType(decision.decision_type) !== "STORNO_REPOST"
      || evaluation.status === "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST"
      || sparseEconomicCaseIds.has(clean(decision.case_id))) continue;
    actions.blockers.push([
      clean(decision.case_id), "STORNO_REPOST", clean(decision.approval_state), clean(decision.pair_id),
      clean(decision.period), clean(decision.organization), clean(decision.source_range), normalizeDateText(decision.source_date),
      clean(decision.registrar), clean(decision.posting_number), positiveMoney(decision.correction_amount) ?? "",
      "Правило одноимённой статьи внутри блока Инталев",
      "Найти и однозначно закрепить физическую проводку ERP; затем выполнить точное STORNO и REPOST на статью выбранного блока",
      "BLOCKED_GROUP_SCOPED_RULE", (evaluation.blockers ?? []).join("; "), false, false, false,
    ]);
  }
  for (const decision of isolatedDecisions) {
    actions.blockers.push([
      clean(decision.case_id), normalizedType(decision.decision_type), clean(decision.approval_state), clean(decision.pair_id),
      clean(decision.period), clean(decision.organization), clean(decision.source_range), normalizeDateText(decision.source_date),
      clean(decision.registrar), clean(decision.posting_number), positiveMoney(decision.correction_amount) ?? "", clean(decision.reason),
      "Создать отдельный запуск для организации/месяца решения", "BLOCKED_CONTEXT_ISOLATION",
      `Выбран ${selectedOrganization}/${selectedPeriod}; решение относится к ${clean(decision.organization) || "MISSING"}/${clean(decision.period) || "MISSING"}`,
      false, false, false,
    ]);
  }
  if (reconciliation.blocker) {
    actions.blockers.unshift([
      "SOURCE-CONTRACT", "NO_POSTING", "АВТОМАТИЧЕСКИ", "", clean(args.period) || reconciliation.reconciliationPeriod || "",
      reconciliation.reconciliationOrganization || "", reconciliationPath, "", "", "", "",
      "Входная сверка не содержит полного доказательного контракта", "Пересобрать сверку в формате июльского дерева с паспортом и листом доказанных операций",
      "BLOCKED_SOURCE_CONTRACT", reconciliation.blocker, false, false, false,
    ]);
  }

  const decisionFile = path.join(runDir, "Решения.xlsx");
  const uploadDir = path.join(runDir, "ЗАГРУЗКА");
  const disputedDir = path.join(runDir, "СПОРНО");
  const disputedOneSideDir = path.join(disputedDir, "Односторонние");
  const deletionDir = path.join(runDir, "УДАЛЕНИЕ");
  const registryDir = path.join(runDir, "РЕЕСТР");
  const technicalDir = path.join(runDir, "technical");
  const period = selectedPeriod || "ПЕРИОД_НЕ_ОПРЕДЕЛЕН";
  const correctionsRegistryFile = path.join(registryDir, buildCorrectionsRegistryFileName(period));
  const discrepancyRegistryFile = path.join(registryDir, buildDiscrepancyRegistryFileName(period));
  await fs.mkdir(technicalDir, { recursive: true });

  await buildDecisionWorkbook(outputDecisions, metadata, decisionFile);
  const uploadFiles = [];
  const disputedFiles = [];
  const canonicalWorkbookRecords = [];
  await Promise.all([fs.mkdir(uploadDir, { recursive: true }), fs.mkdir(disputedDir, { recursive: true })]);
  for (const group of canonicalOutput.groups) {
    const outputDirectory = group.output_route === "READY" ? uploadDir : disputedDir;
    const outputFile = path.join(outputDirectory, group.destination_filename);
    const written = await buildStrictUploadWorkbook(group.rows, outputFile);
    const record = {
      ...written,
      output_route: group.output_route,
      source_organization: group.source_organization,
      period: group.period,
      destination_filename: group.destination_filename,
    };
    canonicalWorkbookRecords.push(record);
    if (group.output_route === "READY") uploadFiles.push(outputFile);
    else disputedFiles.push(outputFile);
  }
  const disputedSidecar = await sidecarDisputedGroups(
    codexInputPath,
    reconciliationSha,
    requestedPeriod || period,
    serviceOrganizationName || reconciliation.reconciliationOrganization,
    discoveryPolicy,
  );
  const disputedPostingRows = canonicalOutput.counters.sporno_financial_rows;
  const deletionFiles = [];
  const deletionWorkbookRows = {
    deletionOperations: [],
    deletionPostings: [],
    pairRows: [],
  };
  let deletionWorkbookOrganization = metadata.organization || "ОРГАНИЗАЦИЯ НЕ ОПРЕДЕЛЕНА";
  const deletionOrganizations = new Map();
  for (const row of [...actions.deletionOperations, ...actions.deletionPostings]) {
    const organization = clean(row[4]) || metadata.organization || "ОРГАНИЗАЦИЯ НЕ ОПРЕДЕЛЕНА";
    if (!deletionOrganizations.has(organization)) deletionOrganizations.set(organization, { deletionOperations: [], deletionPostings: [], pairRows: [] });
  }
  if (!deletionOrganizations.size) deletionOrganizations.set(deletionWorkbookOrganization, { deletionOperations: [], deletionPostings: [], pairRows: [] });
  [deletionWorkbookOrganization] = deletionOrganizations.keys();
  for (const [organization, organizationActions] of deletionOrganizations) {
    organizationActions.deletionOperations = actions.deletionOperations.filter((row) => (clean(row[4]) || metadata.organization) === organization);
    organizationActions.deletionPostings = actions.deletionPostings.filter((row) => (clean(row[4]) || metadata.organization) === organization);
    organizationActions.pairRows = actions.pairRows.filter((row) => ["DELETE_OPERATION", "DELETE_POSTING"].includes(row[1]) && (clean(row[5]) || metadata.organization) === organization);
    deletionWorkbookRows.deletionOperations.push(...organizationActions.deletionOperations);
    deletionWorkbookRows.deletionPostings.push(...organizationActions.deletionPostings);
    deletionWorkbookRows.pairRows.push(...organizationActions.pairRows);
  }
  const deletionWorkbookFile = path.join(deletionDir, buildDeletionWorkbookFileName(period));
  await buildDeletionWorkbook(deletionWorkbookRows, { ...metadata, organization: deletionWorkbookOrganization }, deletionWorkbookFile);
  deletionFiles.push(deletionWorkbookFile);
  const disputedRowsForRegistry = [];
  const annualSummaryRequested = args["annual-summary"] === true || clean(args["annual-summary"]).toLowerCase() === "true";
  const analyticalPolicy = buildAnalyticalPolicyReport(
    annualSummaryRequested ? trustedDecisions : trustedActionDecisions,
    disputedSidecar,
    metadata,
    requestedPeriod || period,
    annualSummaryRequested,
  );
  analyticalPolicy.counts.structurally_generated_loader_draft_rows = canonicalOutput.counters.canonical_financial_rows_total;
  await buildMasterRegistry(outputDecisions, actions, metadata, correctionsRegistryFile, disputedRowsForRegistry, disputedSidecar.reviewRows, analyticalPolicy, canonicalOutput.registry_rows);
  await buildMasterRegistry(outputDecisions, actions, metadata, discrepancyRegistryFile, disputedRowsForRegistry, disputedSidecar.reviewRows, analyticalPolicy, canonicalOutput.registry_rows);
  const enrichedReconciliationFile = path.join(runDir, "Сверка.xlsx");
  await buildEnrichedReconciliation(reconciliation.workbook, canonicalOutput.registry_rows, enrichedReconciliationFile);
  const canonicalOutputIntegrity = verifyCanonicalOutputIntegrity(canonicalOutput, {
    workbook_records: canonicalWorkbookRecords,
    registry_rows: canonicalOutput.registry_rows,
  });

  const outputFiles = [
    decisionFile,
    ...uploadFiles,
    ...disputedFiles,
    ...deletionFiles,
    correctionsRegistryFile,
    discrepancyRegistryFile,
    enrichedReconciliationFile,
  ];
  const outputHashes = {};
  for (const filePath of outputFiles) outputHashes[path.relative(runDir, filePath)] = await sha256(filePath);
  const generatedPostingRows = canonicalOutput.counters.canonical_financial_rows_total;
  const manifest = {
    schema_version: "correction-engine-run-1.0.0",
    engine_version: ENGINE_VERSION,
    ...scopedManifestRunIdentity(metadata.sourceRunId, runId),
    inputs: {
      period,
      source_run_id: metadata.sourceRunId || null,
      service_handoff: metadata.r001HandoffPath ? { path: metadata.r001HandoffPath, sha256: metadata.r001HandoffSha } : null,
      reconciliation: { path: reconciliationPath, sha256: reconciliationSha, source_sheet: reconciliation.sheetName, proven_source_rows: sourceRowsForPeriod.length, candidate_operation_rows: treeRowsForPeriod.length },
      candidate_sidecar: disputedSidecar.sidecarPath ? { path: disputedSidecar.sidecarPath, sha256: disputedSidecar.sidecarSha, pair_candidates: disputedSidecar.pairCount } : null,
      decisions: decisionPath ? { path: decisionPath, sha256: decisionSha } : null,
      self_discovery_policy: { path: SELF_DISCOVERY_POLICY_FILE, sha256: discoveryPolicySha, source: "BUILT_IN_NO_RULES_SERVICE" },
      engine: { path: ENGINE_FILE, sha256: engineSha },
      analytical_policy: { path: ANALYTICAL_POLICY_FILE, sha256: analyticalPolicySha },
    },
    results: {
      decisions: outputDecisions.length,
      upload_files: canonicalOutput.counters.ready_financial_workbooks,
      disputed_files: canonicalOutput.counters.sporno_financial_workbooks,
      draft_posting_rows: generatedPostingRows,
      materialized_posting_rows: generatedPostingRows,
      disputed_posting_rows: disputedPostingRows,
      canonical_financial_rows_total: canonicalOutput.counters.canonical_financial_rows_total,
      ready_financial_rows: canonicalOutput.counters.ready_financial_rows,
      sporno_financial_rows: canonicalOutput.counters.sporno_financial_rows,
      ready_financial_workbooks: canonicalOutput.counters.ready_financial_workbooks,
      sporno_financial_workbooks: canonicalOutput.counters.sporno_financial_workbooks,
      storno_rows: canonicalOutput.counters.storno_rows,
      repost_rows: canonicalOutput.counters.repost_rows,
      canonical_row_set_sha256: canonicalOutput.canonical_row_set_sha256,
      canonical_financial_audit_identities: canonicalOutput.registry_rows.map((row) => row.audit_identity),
      output_file_row_counts: canonicalOutput.groups.map((group) => ({
        output_route: group.output_route,
        source_organization: group.source_organization,
        period: group.period,
        destination_filename: group.destination_filename,
        financial_rows: group.rows.length,
      })),
      canonical_output_integrity: canonicalOutputIntegrity,
      attached_canonical_authority_gate: currentRunAuthority.audit,
      hierarchy_exact_authority_decisions: metadata.hierarchyAuthority?.exact_authority_decisions ?? 0,
      hierarchy_intergroup_physical_decisions: metadata.hierarchyAuthority?.intergroup_physical_decisions ?? 0,
      hierarchy_intergroup_physical_route_cases: metadata.hierarchyAuthority?.intergroup_physical_route_cases ?? 0,
      hierarchy_residual_settlement_decisions: metadata.hierarchyAuthority?.hierarchy_residual_settlement_decisions ?? 0,
      hierarchy_paired_liability_decisions: metadata.hierarchyAuthority?.paired_liability_decisions ?? 0,
      hierarchy_total_authority_decisions: metadata.hierarchyAuthority?.total_hierarchy_authority_decisions ?? 0,
      hierarchy_unresolved_positive_deltas: metadata.hierarchyAuthority?.unresolved_positive_deltas ?? 0,
      sparse_economic_route_cases: sparseEconomicMaterialization.audit.materialized_case_count,
      sparse_economic_route_rows: sparseEconomicMaterialization.audit.canonical_posting_row_count,
      group_scoped_targets_resolved: [...groupScopedEvaluationByDecision.values()]
        .filter((evaluation) => evaluation.target_article).length,
      group_scoped_materialized_pairs: [...groupScopedEvaluationByDecision.values()]
        .filter((evaluation) => evaluation.status === "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST").length,
      group_scoped_blocked_or_review: [...groupScopedEvaluationByDecision.values()]
        .filter((evaluation) => evaluation.status !== "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST").length,
      disputed_pair_candidates: disputedSidecar.pairCount,
      disputed_one_side_candidates: disputedSidecar.reviewRows.length,
      disputed_blockers: disputedSidecar.blockers,
      deletion_operations: actions.deletionOperations.length,
      deletion_postings: actions.deletionPostings.length,
      blockers: actions.blockers.length,
      analytical_draft_corrections: analyticalPolicy.counts.analytical_draft_corrections,
      review_required_rows: analyticalPolicy.counts.review_required,
      analytical_blockers: analyticalPolicy.counts.analytical_blockers,
      structurally_generated_loader_draft_rows: analyticalPolicy.counts.structurally_generated_loader_draft_rows,
      live_executable_rows: 0,
      report_only: true,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      materialization_cases: canonicalOutput.rows.map((row) => row.materialization_case),
      analytical_policy: analyticalPolicy,
      execution_allowed: false,
      live_posting_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      live_delete_allowed: false,
      live_1c_allowed: false,
    },
    archive: args.archive ? { requested: true, name: `${path.basename(runDir)}.zip` } : { requested: false },
    outputs: outputHashes,
  };
  const manifestPath = path.join(technicalDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  let archivePath = "";
  let archiveSha256 = "";
  if (args.archive) {
    archivePath = `${runDir}.zip`;
    archiveSha256 = await createRunArchive(runDir, archivePath);
  }
  console.log(JSON.stringify({ runDir, manifestPath, archivePath, archiveSha256, ...manifest.results, outputFiles: [...outputFiles, ...(archivePath ? [archivePath] : [])] }, null, 2));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
  // artifact-tool can keep background handles alive after every output file is
  // already closed.  Flush the result consumed by the desktop UI and terminate
  // explicitly so the UI cannot remain forever in the "reading evidence" state.
  await new Promise((resolve, reject) => {
    process.stdout.write("", (error) => (error ? reject(error) : resolve()));
  });
  process.exit(0);
}

export {
  LOADER_HEADERS,
  OWNER_UPLOAD_TEMPLATE,
  DELETION_WORKBOOK_TEMPLATE,
  CORRECTIONS_REGISTRY_TEMPLATE,
  DISCREPANCY_REGISTRY_TEMPLATE,
  buildOwnerUploadFileName,
  buildDisputedOwnerUploadFileName,
  buildDeletionWorkbookFileName,
  buildCorrectionsRegistryFileName,
  buildDiscrepancyRegistryFileName,
  buildMasterRegistry,
  buildStrictUploadWorkbook,
  canonicalLoaderContent,
  candidateActionRows,
  disputedTraceRow,
  deletionWorkbookYearLabel,
  exactUniqueDecisionRows,
  periodYearLabel,
  ownerUploadOrganizationLabel,
  ownerUploadDateLabel,
  isPostingAllowedForDisputedDecision,
  excludeHierarchyCoveredEconomicRows,
  mergeProvidedAndAutonomousDecisions,
  sidecarDisputedGroups,
  scopedManifestRunIdentity,
};
