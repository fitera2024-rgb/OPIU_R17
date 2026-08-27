import fs from "node:fs/promises";
import JSZip from "jszip";

function text(value) { return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function xmlEscape(value) {
  return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function columnName(index) {
  let value = index;
  let result = "";
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}
function cellXml(row, column, value, style = 0) {
  const ref = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function rowXml(rowNumber, values, styleFor = () => 0) {
  return `<row r="${rowNumber}">${values.map((value, index) => cellXml(rowNumber, index + 1, value, styleFor(index, value))).join("")}</row>`;
}
function worksheetXml(rows, widths = []) {
  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  const maxRows = Math.max(1, rows.length);
  const cols = Array.from({ length: maxCols }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${widths[index] ?? 18}" customWidth="1"/>`).join("");
  const body = rows.map((row, index) => rowXml(
    index + 1,
    row,
    (column) => index === 0 || index === 3 ? 1 : [2,3,4,16].includes(column) ? 2 : 0,
  )).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${columnName(maxCols)}${maxRows}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${body}</sheetData><autoFilter ref="A4:${columnName(maxCols)}${maxRows}"/></worksheet>`;
}

export const OWNER_DECISION_EXPLANATION_HEADERS = Object.freeze([
  "Код строки", "Статья", "Инталев", "ERP", "Дельта raw", "CaseID", "PairID",
  "Класс решения", "Тип решения", "Статус", "Proof", "ECONOMIC_ROUTE_PROVEN",
  "SOURCE_OPERATION_PROVEN", "PHYSICAL_SOURCE_UNIQUE", "ECONOMIC_CORRECTION_PROVEN",
  "OWNER_REVIEW_REQUIRED", "Effective delta", "Роль", "Почему", "Что делать",
  "Исполнение",
]);

function worksheetPath(workbookXml, relsXml, sheetName) {
  const escapedName = sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sheet = workbookXml.match(new RegExp(
    `<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheet\\b[^>]*name="${escapedName}"[^>]*r:id="([^"]+)"[^>]*/\\s*>`,
  ));
  if (!sheet) return "";
  const relationship = relsXml.match(new RegExp(
    `<Relationship\\b(?=[^>]*Id="${sheet[1]}")(?=[^>]*Target="([^"]+)")[^>]*/\\s*>`,
  ));
  if (!relationship) return "";
  const target = relationship[1].replace(/^\//, "");
  return target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
}

function replaceInlineCell(rowXmlValue, column, rowNumber, value) {
  const ref = `${column}${rowNumber}`;
  const qName = "(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";
  const cellPattern = new RegExp(
    `<${qName}c\\b[^>]*\\br="${ref}"[^>]*(?:>[\\s\\S]*?<\\/${qName}c>|\\s*\\/>)`,
  );
  const current = rowXmlValue.match(cellPattern)?.[0] ?? "";
  const style = current.match(/\bs="([^"]+)"/)?.[1] ?? "";
  const currentPrefix = current.match(/^<([A-Za-z_][A-Za-z0-9_.-]*:)?c\b/)?.[1] ?? "";
  const rowPrefix = rowXmlValue.match(/^<([A-Za-z_][A-Za-z0-9_.-]*:)?row\b/)?.[1] ?? "";
  const prefix = currentPrefix || rowPrefix;
  const replacement = `<${prefix}c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">${xmlEscape(value)}</${prefix}t></${prefix}is></${prefix}c>`;
  if (current) return rowXmlValue.replace(cellPattern, replacement);
  return rowXmlValue.replace(
    new RegExp(`<\\/${qName}row>$`),
    `${replacement}</${prefix}row>`,
  );
}

function patchMainTreeRow(sheetXml, code, cells) {
  const qName = "(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";
  const rows = [...sheetXml.matchAll(new RegExp(
    `<${qName}row\\b[^>]*>[\\s\\S]*?<\\/${qName}row>`,
    "g",
  ))];
  const expected = xmlEscape(code);
  const target = rows.find((match) => new RegExp(
    `<${qName}c\\b[^>]*\\br="A(\\d+)"[^>]*>[\\s\\S]*?<${qName}(?:t|v)[^>]*>${expected}<\\/${qName}(?:t|v)>[\\s\\S]*?<\\/${qName}c>`,
  ).test(match[0]));
  if (!target) return sheetXml;
  const rowNumber = target[0].match(new RegExp(
    `<${qName}c\\b[^>]*\\br="A(\\d+)"`,
  ))?.[1];
  if (!rowNumber) return sheetXml;
  let rowXmlValue = target[0];
  for (const [column, value] of Object.entries(cells)) {
    rowXmlValue = replaceInlineCell(rowXmlValue, column, rowNumber, value);
  }
  return sheetXml.replace(target[0], rowXmlValue);
}

async function patchMainTreeOwnerDecisions(zip, workbookXml, relsXml, projection) {
  const sheetPath = worksheetPath(workbookXml, relsXml, "01_Сверка_дерево");
  if (!sheetPath || !zip.file(sheetPath)) return;
  let sheetXml = await zip.file(sheetPath).async("string");
  for (const decisionCase of projection?.cases ?? []) {
    for (const member of decisionCase?.member_rows ?? []) {
      const code = text(member?.code);
      if (!code) continue;
      if (
        decisionCase?.accepted_intergroup_reclass === true &&
        typeof member?.root_effective_delta === "number" &&
        typeof member?.accepted_intergroup_effect === "number"
      ) {
        const direction = text(member?.economic_direction) || "STORNO/REPOST";
        sheetXml = patchMainTreeRow(sheetXml, code, {
          G: `ЭКОНОМИЧЕСКИЙ ПЕРЕСОРТ ЗАКРЫТ / ${direction} / _СПОРНО`,
          H: `raw_delta=${member.raw_delta}; accepted_intergroup_effect=${member.accepted_intergroup_effect}; root_effective_delta=${member.root_effective_delta}; consumed_once=true.`,
          J: "Межгрупповой эффект потреблён один раз. Дочерние расхождения проверяются отдельно; третья корректировка запрещена.",
          AB: `CaseID=${decisionCase.case_id}; classification=${decisionCase.classification}; proof=${decisionCase.proof_status}; correction_authority=false; posting_rows=0.`,
        });
      } else if (
        decisionCase?.classification === "BINDING_REPAIR_PROVEN" &&
        decisionCase?.decision_type === "UPDATE_MAPPING"
      ) {
        sheetXml = patchMainTreeRow(sheetXml, code, {
          G: "BINDING_REPAIR_PROVEN / UPDATE_MAPPING / БЕЗ ПРОВОДКИ",
          H: `Точная ERP-привязка доказана: ${text(member?.source_ref)}; effective_delta=${member?.effective_delta ?? 0}.`,
          J: "Сохранить доказанный ERP-binding. Финансовую корректировку и проводку не создавать.",
          AB: `CaseID=${decisionCase.case_id}; classification=BINDING_REPAIR_PROVEN; decision_type=UPDATE_MAPPING; correction_authority=false; posting_rows=0.`,
        });
      }
    }
  }
  zip.file(sheetPath, sheetXml);
}
function projectionBusinessRows(payload, projection) {
  const byCase = new Map((projection.cases ?? []).map((decisionCase) => [decisionCase.case_id, decisionCase]));
  const byCode = new Map((payload.rows ?? []).map((row) => [text(row.code), row]));
  const result = [];
  const codes = new Set(Object.keys(projection.row_links ?? {}));
  for (const row of payload.rows ?? []) {
    const delta = typeof row.delta === "number" ? row.delta : null;
    if (delta !== null && Math.abs(delta) > 0.009) codes.add(text(row.code));
  }
  for (const code of [...codes]) {
    const row = byCode.get(code) ?? {};
    const caseIds = projection.row_links?.[code] ?? [];
    if (caseIds.length === 0) {
      // Keep the no-case row aligned with the separate proof columns.
      result.push([code, text(row.intalev_label || row.erp_label), row.intalev_amount ?? "", row.erp_amount ?? "", row.delta ?? "", "", "", "REVIEW_ONLY", "NO_POSTING", "ТРЕБУЕТ РЕШЕНИЯ", "UNPROVEN", row.delta ?? "", "CONTROL", "Ненулевая дельта не получила экономический CaseID.", "Проверить вручную; проводку не формировать.", "REPORT_ONLY"]);
      result[result.length - 1].splice(11, 0, false, false, false, false, true);
      continue;
    }
    for (const caseId of caseIds) {
      const decisionCase = byCase.get(caseId);
      if (!decisionCase) continue;
      const member = (decisionCase.member_rows ?? []).find((item) => item.code === code);
      result.push([
        code,
        text(row.intalev_label || row.erp_label),
        row.intalev_amount ?? "",
        row.erp_amount ?? "",
        row.delta ?? "",
        caseId,
        decisionCase.pair_id ?? "",
        decisionCase.classification,
        decisionCase.decision_type,
        decisionCase.status_text,
         decisionCase.proof_status,
         decisionCase.ECONOMIC_ROUTE_PROVEN === true,
         decisionCase.SOURCE_OPERATION_PROVEN === true,
         decisionCase.PHYSICAL_SOURCE_UNIQUE === true,
         decisionCase.ECONOMIC_CORRECTION_PROVEN === true,
         decisionCase.OWNER_REVIEW_REQUIRED === true,
         member?.root_effective_delta ?? member?.effective_delta ?? "",
        member?.role ?? "CONTROL_REFERENCE",
        decisionCase.reason,
        decisionCase.solution,
        "execution_allowed=false; posting_rows=0",
      ]);
    }
  }
  return result;
}

function ownerDecisionWorksheetRows(payload, projection) {
  const businessRows = projectionBusinessRows(payload, projection);
  const statusRow = businessRows.length > 0
    ? businessRows
    : [[
        "INFO_NO_OWNER_DECISIONS", "", "", "", "", "", "", "REVIEW_ONLY",
        "NO_POSTING", "INFO", "UNPROVEN", false, false, false, false, true, "",
        "CONTROL", "Решения владельца отсутствуют.",
        "Лист сохранён как обязательный REPORT_ONLY placeholder.",
        "execution_allowed=false; posting_rows=0",
      ]];
  return {
    businessRows,
    rows: [
      ["Обоснование решений владельца"],
      ["REPORT_ONLY — лист не разрешает загрузку, проведение или финансовую корректировку."],
      [],
      [...OWNER_DECISION_EXPLANATION_HEADERS],
      ...statusRow,
    ],
  };
}

export async function appendOwnerDecisionExplanationSheet(xlsxPath, payload, projection, sheetName = "08_Решения_обоснование") {
  const input = await fs.readFile(xlsxPath);
  const zip = await JSZip.loadAsync(input);
  const workbookPath = "xl/workbook.xml";
  const relsPath = "xl/_rels/workbook.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  let workbookXml = await zip.file(workbookPath).async("string");
  let relsXml = await zip.file(relsPath).async("string");
  let contentTypesXml = await zip.file(contentTypesPath).async("string");
  const projectionResult = ownerDecisionWorksheetRows(payload, projection);
  const sheetXml = worksheetXml(projectionResult.rows, [14,48,18,18,18,34,34,34,22,38,16,22,22,22,24,22,18,22,90,90,34]);

  const escapedName = sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingSheet = workbookXml.match(new RegExp(`<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheet\\b[^>]*name="${escapedName}"[^>]*r:id="([^"]+)"[^>]*/\\s*>`));
  if (!existingSheet) throw new Error(`OWNER_DECISION_PLACEHOLDER_MISSING:${sheetName}`);
  const relId = existingSheet[1];
  const relMatch = relsXml.match(new RegExp(`<Relationship\\b(?=[^>]*Id="${relId}")(?=[^>]*Target="([^"]+)")[^>]*/\\s*>`));
  if (!relMatch) throw new Error(`OWNER_DECISION_SHEET_RELATIONSHIP_MISSING:${sheetName}`);
  const target = relMatch[1].replace(/^\//, "");
  const targetPath = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
  if (!zip.file(targetPath)) throw new Error(`OWNER_DECISION_SHEET_TARGET_MISSING:${targetPath}`);
  const partName = `/${targetPath.replace(/^\//, "")}`;
  const escapedPartName = partName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contentType = contentTypesXml.match(new RegExp(
    `<Override\\b(?=[^>]*PartName="${escapedPartName}")(?=[^>]*ContentType="([^"]+)")[^>]*/\\s*>`,
  ))?.[1];
  if (contentType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml") {
    throw new Error(`OWNER_DECISION_SHEET_CONTENT_TYPE_MISSING:${partName}`);
  }
  zip.file(targetPath, sheetXml);
  await patchMainTreeOwnerDecisions(zip, workbookXml, relsXml, projection);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await fs.writeFile(xlsxPath, output);
  return { sheet_name: sheetName, rows: projectionResult.businessRows.length };
}
