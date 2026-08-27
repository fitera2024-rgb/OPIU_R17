import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

export const MANIFEST_SCHEMA = "opiu-full-operation-manifest-v1";
export const RESULT_SCHEMA = "opiu-full-operation-evidence-v1";
export const JULY_MANIFEST_SCHEMA = "opiu-july-operation-evidence-manifest-v1";

const RELEASE_STATUS = "BLOCKED_RELEASE_GATES_NOT_RUN";
const SOURCE_ROW_KEY_CONTRACT = "SHA256(journal_sha256|sheet|physical_row)";
const NODE_KINDS = new Set(["PARENT", "DIRECT_LEAF", "COMPUTED_NO_DIRECT_OPERATION"]);
const EVIDENCE_STATUSES = new Set(["PROVEN", "CANDIDATE_EXCLUDED"]);

export const HEADER_CONTRACT = Object.freeze({
  B: "Дата",
  D: "Документ",
  E: "НомерСтроки",
  F: "Активность",
  G: "СчетДт",
  H: "СубконтоДт1",
  I: "СубконтоДт2",
  J: "СубконтоДт3",
  K: "ПодразделениеДт",
  L: "НаправлениеДеятельностиДт",
  M: "ВалютаДт",
  N: "СуммаВВалютеДт",
  O: "КоличествоДт",
  P: "СчетКт",
  Q: "СубконтоКт1",
  R: "СубконтоКт2",
  S: "СубконтоКт3",
  T: "ПодразделениеКт",
  U: "НаправлениеДеятельностиКт",
  V: "ВалютаКт",
  W: "СуммаВВалютеКт",
  X: "КоличествоКт",
  Y: "СуммаВВалютеУчета",
  Z: "СуммаВВалютеОтчетности",
  AA: "Организация",
  AB: "Сценарий",
  AC: "ВидОперации",
  AD: "Содержание",
  AE: "СтатьяДоходовИРасходов",
  AF: "ГруппаРаскрытия",
  AG: "Аналитика3",
});

const EXACT_EXPECTED_FIELDS = Object.freeze([
  "source_row_id",
  "date",
  "document",
  "posting_no",
  "activity",
  "debit",
  "debit_analytics",
  "debit_department",
  "credit",
  "credit_analytics",
  "credit_department",
  "amount_accounting",
  "amount",
  "organization",
  "scenario",
  "operation_kind",
  "content",
  "article",
  "disclosure",
  "analytics3",
]);

const STRING_FIELDS = new Set([
  "source_row_id",
  "date",
  "document",
  "activity",
  "debit",
  "debit_department",
  "credit",
  "credit_department",
  "organization",
  "scenario",
  "operation_kind",
  "content",
  "article",
  "disclosure",
  "analytics3",
]);
const ARRAY_FIELDS = new Set(["debit_analytics", "credit_analytics"]);
const AMOUNT_FIELDS = new Set(["amount_accounting", "amount"]);

class ManifestBlockedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ManifestBlockedError";
    this.code = code;
    this.details = details;
  }
}

function block(code, message, details = {}) {
  throw new ManifestBlockedError(code, message, details);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function stableRowKey(journalSha256, sheet, physicalRow) {
  return sha256(Buffer.from(`${journalSha256}|${sheet}|${physicalRow}`, "utf8"));
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(fragment) {
  const result = {};
  for (const match of String(fragment ?? "").matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function extractTextNodes(xml) {
  return [...String(xml ?? "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)]
    .map((match) => extractTextNodes(match[1]));
}

function parseCellValue(type, body, sharedStrings) {
  if (type === "inlineStr") return extractTextNodes(body);
  const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/)?.[1];
  if (raw === undefined) return null;
  const decoded = decodeXml(raw);
  if (type === "s") {
    const index = Number(decoded);
    return Number.isInteger(index) && index >= 0 ? (sharedStrings[index] ?? null) : null;
  }
  if (type === "e") return null;
  if (type === "b") return decoded === "1";
  if (type === "str") return decoded;
  const numeric = Number(decoded);
  return decoded !== "" && Number.isFinite(numeric) ? numeric : decoded;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = new Map();
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)\/>|<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/g;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const rowAttributes = parseAttributes(rowMatch[1] ?? rowMatch[2]);
    const physicalRow = Number(rowAttributes.r);
    if (!Number.isInteger(physicalRow) || physicalRow < 1) continue;
    const cells = new Map();
    const rowBody = rowMatch[3] ?? "";
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\/>|<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>/g;
    for (const cellMatch of rowBody.matchAll(cellPattern)) {
      const attributes = parseAttributes(cellMatch[1] ?? cellMatch[2]);
      const reference = attributes.r;
      if (!reference) continue;
      const column = reference.match(/^([A-Z]+)/i)?.[1]?.toUpperCase();
      if (!column) continue;
      cells.set(column, parseCellValue(attributes.t, cellMatch[3] ?? "", sharedStrings));
    }
    rows.set(physicalRow, cells);
  }
  return rows;
}

function findSheetTarget(workbookXml, relationshipsXml, sheetName) {
  let relationshipId = null;
  for (const match of workbookXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.name === sheetName) {
      relationshipId = attributes["r:id"] ?? attributes.id;
      break;
    }
  }
  if (!relationshipId) block("BLOCKED_JOURNAL_SHEET_DRIFT", `Worksheet not found: ${sheetName}`, { sheet: sheetName });

  for (const match of relationshipsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.Id !== relationshipId) continue;
    const target = attributes.Target;
    if (!target) break;
    return target.startsWith("/")
      ? target.slice(1)
      : path.posix.normalize(path.posix.join("xl", target.replace(/^\.\//, "")));
  }
  block("BLOCKED_JOURNAL_SHEET_RELATIONSHIP_DRIFT", `Worksheet relationship not found: ${sheetName}`, {
    sheet: sheetName,
    relationship_id: relationshipId,
  });
}

async function loadWorksheetFromXlsx(buffer, sheetName) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    block("BLOCKED_JOURNAL_XLSX_PARSE", `Cannot parse journal XLSX: ${error.message}`);
  }
  const workbookEntry = zip.file("xl/workbook.xml");
  const relationshipsEntry = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relationshipsEntry) {
    block("BLOCKED_JOURNAL_XLSX_STRUCTURE", "Journal workbook metadata is missing");
  }
  const [workbookXml, relationshipsXml, sharedStringsXml] = await Promise.all([
    workbookEntry.async("string"),
    relationshipsEntry.async("string"),
    zip.file("xl/sharedStrings.xml")?.async("string") ?? Promise.resolve(""),
  ]);
  const worksheetEntry = findSheetTarget(workbookXml, relationshipsXml, sheetName);
  const worksheetXml = await zip.file(worksheetEntry)?.async("string");
  if (!worksheetXml) {
    block("BLOCKED_JOURNAL_XLSX_STRUCTURE", `Worksheet XML is missing: ${worksheetEntry}`);
  }
  return {
    entry: worksheetEntry,
    dimension: worksheetXml.match(/<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref="([^"]+)"/)?.[1] ?? null,
    rows: parseWorksheetRows(worksheetXml, parseSharedStrings(sharedStringsXml)),
  };
}

function cell(rows, row, column) {
  return rows.get(row)?.get(column) ?? null;
}

function textValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function numericValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return Number.NaN;
  }
  const result = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : Number.NaN;
}

function amountCents(value, label) {
  const numeric = numericValue(value);
  if (!Number.isFinite(numeric)) block("BLOCKED_MANIFEST_NUMBER", `${label} is not a finite number`, { value });
  return Math.round(numeric * 100);
}

function requireEqual(actual, expected, code, label, details = {}) {
  if (actual !== expected) {
    block(code, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, {
      ...details,
      label,
      expected,
      actual,
    });
  }
}

function requireArray(actual, expected, code, label, details = {}) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    block(code, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, {
      ...details,
      label,
      expected,
      actual,
    });
  }
}

function requireObject(value, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    block(code, `${label} must be an object`);
  }
  return value;
}

function requireOnlyKeys(value, allowed, code, label) {
  requireObject(value, code, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) block(code, `${label} contains unknown fields: ${unknown.join(", ")}`, { unknown });
}

function normalizedInput(options = {}) {
  return {
    manifestPath: typeof options.manifestPath === "string" ? path.resolve(options.manifestPath) : "",
    manifestExpectedSha256: textValue(options.manifestExpectedSha256).trim().toUpperCase(),
    journalPath: typeof options.journalPath === "string" && options.journalPath.trim()
      ? path.resolve(options.journalPath)
      : "",
    journalBuffer: Buffer.isBuffer(options.journalBuffer) ? options.journalBuffer : null,
    journalSourceLabel: textValue(options.journalSourceLabel).trim(),
    erpOpiuPath: typeof options.erpOpiuPath === "string" && options.erpOpiuPath.trim()
      ? path.resolve(options.erpOpiuPath)
      : "",
    organization: textValue(options.organization).trim(),
    mode: textValue(options.mode).trim().toLowerCase(),
    period: textValue(options.period).trim(),
    financialCodes: Array.isArray(options.financialCodes) ? options.financialCodes.map((code) => textValue(code).trim()) : null,
    baseOperationEvidence:
      options.baseOperationEvidence && typeof options.baseOperationEvidence === "object"
        ? options.baseOperationEvidence
        : null,
  };
}

function safeGates(overrides = {}) {
  return {
    report_only: true,
    manifest_verified: false,
    journal_verified: false,
    operation_coverage_complete: false,
    new_pair_candidates: 0,
    correction_operation_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    release_status: RELEASE_STATUS,
    ...overrides,
    report_only: true,
    correction_operation_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

function baseResult(status, applicable, input) {
  return {
    schema: RESULT_SCHEMA,
    status,
    applicable,
    input: {
      manifest_path: input.manifestPath || null,
      journal_source: input.journalPath || input.journalSourceLabel || (input.journalBuffer ? "BUFFER" : null),
      organization: input.organization,
      mode: input.mode,
      period: input.period,
    },
    manifest_id: null,
    manifest_sha256: null,
    journal_sha256: null,
    journal_sheet: null,
    source_contributor_rows: 0,
    display_operation_rows: 0,
    candidate_excluded_rows: 0,
    new_pair_candidates: 0,
    correction_operation_rows: 0,
    posting_rows: 0,
    report_only: true,
    ready_to_upload: false,
    release_allowed: false,
    rows: [],
    node_evidence: [],
    leaf_totals: {},
    counts: {
      financial_nodes: 0,
      parent_nodes: 0,
      direct_leaf_nodes: 0,
      computed_nodes: 0,
      blocked_direct_leaf_nodes: 0,
      journal_rows: 0,
      fact_rows: 0,
      active_rows: 0,
      inactive_rows: 0,
      source_contributor_rows: 0,
      candidate_excluded_rows: 0,
      display_operation_rows: 0,
      correction_operation_rows: 0,
      posting_rows: 0,
    },
    gates: safeGates(),
    source_trace: null,
  };
}

function blockedResult(error, input, trace = {}) {
  const code = error instanceof ManifestBlockedError ? error.code : "BLOCKED_OPERATION_EVIDENCE_UNEXPECTED";
  const result = baseResult(code, true, input);
  result.error = {
    code,
    message: error?.message ?? String(error),
    details: error instanceof ManifestBlockedError ? error.details : {},
  };
  result.source_trace = Object.keys(trace).length > 0 ? trace : null;
  return result;
}

function verifyHeaderContract(rows, headerRow) {
  for (const [column, expected] of Object.entries(HEADER_CONTRACT)) {
    requireEqual(textValue(cell(rows, headerRow, column)), expected, "BLOCKED_JOURNAL_HEADER_DRIFT", `header ${column}${headerRow}`, {
      cell: `${column}${headerRow}`,
    });
  }
}

function compactAnalytics(rows, physicalRow, columns) {
  return columns.map((column) => textValue(cell(rows, physicalRow, column))).filter(Boolean);
}

function operationFromRow(rows, physicalRow, journalSha256, sheet) {
  return {
    physical_row: physicalRow,
    source_range: `B${physicalRow}:AG${physicalRow}`,
    source_row_id: stableRowKey(journalSha256, sheet, physicalRow),
    date: textValue(cell(rows, physicalRow, "B")),
    document: textValue(cell(rows, physicalRow, "D")),
    posting_no: numericValue(cell(rows, physicalRow, "E")),
    activity: textValue(cell(rows, physicalRow, "F")),
    debit: textValue(cell(rows, physicalRow, "G")),
    debit_analytics: compactAnalytics(rows, physicalRow, ["H", "I", "J"]),
    debit_analytics_1: textValue(cell(rows, physicalRow, "H")),
    debit_analytics_2: textValue(cell(rows, physicalRow, "I")),
    debit_analytics_3: textValue(cell(rows, physicalRow, "J")),
    debit_department: textValue(cell(rows, physicalRow, "K")),
    debit_direction: textValue(cell(rows, physicalRow, "L")),
    debit_currency: textValue(cell(rows, physicalRow, "M")),
    debit_currency_amount: numericValue(cell(rows, physicalRow, "N")),
    debit_quantity: numericValue(cell(rows, physicalRow, "O")),
    credit: textValue(cell(rows, physicalRow, "P")),
    credit_analytics: compactAnalytics(rows, physicalRow, ["Q", "R", "S"]),
    credit_analytics_1: textValue(cell(rows, physicalRow, "Q")),
    credit_analytics_2: textValue(cell(rows, physicalRow, "R")),
    credit_analytics_3: textValue(cell(rows, physicalRow, "S")),
    credit_department: textValue(cell(rows, physicalRow, "T")),
    credit_direction: textValue(cell(rows, physicalRow, "U")),
    credit_currency: textValue(cell(rows, physicalRow, "V")),
    credit_currency_amount: numericValue(cell(rows, physicalRow, "W")),
    credit_quantity: numericValue(cell(rows, physicalRow, "X")),
    amount_accounting: numericValue(cell(rows, physicalRow, "Y")),
    amount: numericValue(cell(rows, physicalRow, "Z")),
    organization: textValue(cell(rows, physicalRow, "AA")),
    scenario: textValue(cell(rows, physicalRow, "AB")),
    operation_kind: textValue(cell(rows, physicalRow, "AC")),
    content: textValue(cell(rows, physicalRow, "AD")),
    article: textValue(cell(rows, physicalRow, "AE")),
    disclosure: textValue(cell(rows, physicalRow, "AF")),
    analytics3: textValue(cell(rows, physicalRow, "AG")),
  };
}

function journalPeriod(value) {
  const match = textValue(value).match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s|$)/);
  return match ? `${match[3]}-${match[2]}` : null;
}

function journalDateValue(value) {
  const match = textValue(value).match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
  return `${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:${second}`;
}

function validateScopeAndJournal(manifest) {
  requireOnlyKeys(manifest, new Set(["schema", "manifest_id", "source_row_key_contract", "scope", "journal", "tolerance", "nodes"]), "BLOCKED_MANIFEST_SCHEMA", "manifest");
  requireEqual(manifest.schema, MANIFEST_SCHEMA, "BLOCKED_MANIFEST_SCHEMA", "manifest schema");
  if (!textValue(manifest.manifest_id).trim()) block("BLOCKED_MANIFEST_SCHEMA", "manifest_id is required");
  requireEqual(manifest.source_row_key_contract, SOURCE_ROW_KEY_CONTRACT, "BLOCKED_MANIFEST_SCHEMA", "source row key contract");

  requireOnlyKeys(manifest.scope, new Set(["mode", "period", "organization", "allowed_journal_organizations", "financial_codes"]), "BLOCKED_MANIFEST_SCHEMA", "scope");
  if (textValue(manifest.scope.mode).toLowerCase() !== "month") block("BLOCKED_MANIFEST_SCOPE", "Only month manifests are supported");
  if (!/^\d{4}-\d{2}$/.test(textValue(manifest.scope.period))) block("BLOCKED_MANIFEST_SCOPE", "scope.period must be YYYY-MM");
  if (!textValue(manifest.scope.organization).trim()) block("BLOCKED_MANIFEST_SCOPE", "scope.organization is required");
  if (!Array.isArray(manifest.scope.allowed_journal_organizations) || manifest.scope.allowed_journal_organizations.length === 0) {
    block("BLOCKED_MANIFEST_SCOPE", "scope.allowed_journal_organizations must be a non-empty exact list");
  }
  if (new Set(manifest.scope.allowed_journal_organizations).size !== manifest.scope.allowed_journal_organizations.length) {
    block("BLOCKED_MANIFEST_SCOPE", "scope.allowed_journal_organizations contains duplicates");
  }
  if (!Array.isArray(manifest.scope.financial_codes) || manifest.scope.financial_codes.length === 0) {
    block("BLOCKED_MANIFEST_SCOPE", "scope.financial_codes must be a non-empty ordered list");
  }
  const invalidCodes = manifest.scope.financial_codes.filter((code) => !/^R\d{3}$/.test(textValue(code)));
  if (invalidCodes.length > 0 || new Set(manifest.scope.financial_codes).size !== manifest.scope.financial_codes.length) {
    block("BLOCKED_MANIFEST_SCOPE", "scope.financial_codes must contain unique Rnnn codes", { invalid_codes: invalidCodes });
  }

  requireOnlyKeys(manifest.journal, new Set(["sha256", "sheet", "header_row", "data_first_row", "data_last_row", "ooxml_dimension", "expected_counts"]), "BLOCKED_MANIFEST_SCHEMA", "journal");
  if (!/^[0-9A-F]{64}$/i.test(textValue(manifest.journal.sha256))) block("BLOCKED_MANIFEST_SCHEMA", "journal.sha256 must be SHA-256");
  if (!textValue(manifest.journal.sheet).trim()) block("BLOCKED_MANIFEST_SCHEMA", "journal.sheet is required");
  for (const key of ["header_row", "data_first_row", "data_last_row"]) {
    if (!Number.isInteger(manifest.journal[key]) || manifest.journal[key] < 1) block("BLOCKED_MANIFEST_SCHEMA", `journal.${key} must be a positive integer`);
  }
  if (manifest.journal.data_first_row <= manifest.journal.header_row || manifest.journal.data_last_row < manifest.journal.data_first_row) {
    block("BLOCKED_MANIFEST_SCHEMA", "journal row bounds are invalid");
  }
  requireOnlyKeys(manifest.journal.expected_counts, new Set(["dated_rows", "fact_rows", "active_rows", "inactive_rows"]), "BLOCKED_MANIFEST_SCHEMA", "journal.expected_counts");
  for (const key of ["dated_rows", "fact_rows", "active_rows", "inactive_rows"]) {
    if (!Number.isInteger(manifest.journal.expected_counts[key]) || manifest.journal.expected_counts[key] < 0) {
      block("BLOCKED_MANIFEST_SCHEMA", `journal.expected_counts.${key} must be a non-negative integer`);
    }
  }
  if (manifest.journal.expected_counts.active_rows + manifest.journal.expected_counts.inactive_rows !== manifest.journal.expected_counts.fact_rows) {
    block("BLOCKED_MANIFEST_SCHEMA", "active_rows + inactive_rows must equal fact_rows");
  }
  const tolerance = numericValue(manifest.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.01) block("BLOCKED_MANIFEST_SCHEMA", "tolerance must be between 0 and 0.01");
  if (!Array.isArray(manifest.nodes)) block("BLOCKED_MANIFEST_SCHEMA", "nodes must be an array");
}

function validateNodeGraph(manifest, financialCodes) {
  const allowedNodeKeys = new Set(["code", "node_kind", "expected_erp_amount", "child_codes", "aggregation", "operations"]);
  const allowedOperationKeys = new Set(["physical_row", "evidence_status", "exclusion_code", "exclusion_reason", "expected", "presentation", "pair"]);
  const allowedPresentationKeys = new Set(["display_order", "display_depth_offset", "reason", "comment"]);
  const allowedPairKeys = new Set(["pair_id", "upload_id", "pair_role", "pair_status", "partner_physical_row"]);
  const nodeByCode = new Map();

  for (const node of manifest.nodes) {
    requireOnlyKeys(node, allowedNodeKeys, "BLOCKED_MANIFEST_NODE_SCHEMA", `node ${textValue(node?.code) || "MISSING"}`);
    if (!/^R\d{3}$/.test(textValue(node.code))) block("BLOCKED_MANIFEST_NODE_SCHEMA", `Invalid node code: ${node.code}`);
    if (nodeByCode.has(node.code)) block("BLOCKED_MANIFEST_NODE_DUPLICATE", `Duplicate node: ${node.code}`);
    if (!NODE_KINDS.has(node.node_kind)) block("BLOCKED_MANIFEST_NODE_SCHEMA", `Invalid node_kind for ${node.code}: ${node.node_kind}`);
    if (node.expected_erp_amount !== null && !Number.isFinite(numericValue(node.expected_erp_amount))) {
      block("BLOCKED_MANIFEST_NODE_SCHEMA", `expected_erp_amount must be numeric or null for ${node.code}`);
    }
    if (!Array.isArray(node.child_codes) || !Array.isArray(node.operations)) block("BLOCKED_MANIFEST_NODE_SCHEMA", `child_codes and operations must be arrays for ${node.code}`);
    if (new Set(node.child_codes).size !== node.child_codes.length) block("BLOCKED_MANIFEST_NODE_SCHEMA", `Duplicate child_codes for ${node.code}`);
    if (node.node_kind === "PARENT") {
      if (node.child_codes.length === 0) block("BLOCKED_PARENT_CONTRACT", `Parent ${node.code} must have children`);
      if (node.operations.length !== 0) block("BLOCKED_PARENT_DIRECT_OPERATION", `Parent ${node.code} must not have direct operations`);
      if (!["NONE", "SUM_CHILDREN"].includes(node.aggregation)) block("BLOCKED_PARENT_CONTRACT", `Parent ${node.code} needs aggregation NONE or SUM_CHILDREN`);
    } else {
      if (node.child_codes.length !== 0) block("BLOCKED_LEAF_CONTRACT", `${node.node_kind} ${node.code} must not have children`);
      if (node.aggregation !== "NONE") block("BLOCKED_LEAF_CONTRACT", `${node.node_kind} ${node.code} must use aggregation NONE`);
      if (node.node_kind === "COMPUTED_NO_DIRECT_OPERATION" && node.operations.length !== 0) {
        block("BLOCKED_COMPUTED_DIRECT_OPERATION", `Computed node ${node.code} must not have operations`);
      }
    }

    for (const operation of node.operations) {
      requireOnlyKeys(operation, allowedOperationKeys, "BLOCKED_MANIFEST_OPERATION_SCHEMA", `operation ${node.code}`);
      if (!Number.isInteger(operation.physical_row) || operation.physical_row < manifest.journal.data_first_row || operation.physical_row > manifest.journal.data_last_row) {
        block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `physical_row out of journal bounds for ${node.code}`, { physical_row: operation.physical_row });
      }
      if (!EVIDENCE_STATUSES.has(operation.evidence_status)) block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `Invalid evidence_status for ${node.code}`);
      requireObject(operation.expected, "BLOCKED_MANIFEST_OPERATION_SCHEMA", `expected ${node.code}/${operation.physical_row}`);
      requireOnlyKeys(operation.expected, new Set(EXACT_EXPECTED_FIELDS), "BLOCKED_MANIFEST_OPERATION_SCHEMA", `expected ${node.code}/${operation.physical_row}`);
      for (const field of EXACT_EXPECTED_FIELDS) {
        if (!Object.hasOwn(operation.expected, field)) block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `Missing expected.${field} for ${node.code}/${operation.physical_row}`);
      }
      for (const field of STRING_FIELDS) {
        if (typeof operation.expected[field] !== "string") block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `expected.${field} must be string for ${node.code}/${operation.physical_row}`);
      }
      for (const field of ARRAY_FIELDS) {
        if (!Array.isArray(operation.expected[field]) || operation.expected[field].some((value) => typeof value !== "string")) {
          block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `expected.${field} must be a string array for ${node.code}/${operation.physical_row}`);
        }
      }
      if (!Number.isFinite(numericValue(operation.expected.posting_no))) block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `expected.posting_no must be numeric for ${node.code}/${operation.physical_row}`);
      for (const field of AMOUNT_FIELDS) amountCents(operation.expected[field], `expected.${field}`);
      requireOnlyKeys(operation.presentation, allowedPresentationKeys, "BLOCKED_MANIFEST_OPERATION_SCHEMA", `presentation ${node.code}/${operation.physical_row}`);
      if (!Number.isInteger(operation.presentation.display_order) || operation.presentation.display_order < 1) block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `display_order must be positive for ${node.code}/${operation.physical_row}`);
      if (![1, 2].includes(operation.presentation.display_depth_offset)) block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `display_depth_offset must be 1 or 2 for ${node.code}/${operation.physical_row}`);
      if (typeof operation.presentation.reason !== "string" || typeof operation.presentation.comment !== "string") block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `presentation reason/comment must be strings for ${node.code}/${operation.physical_row}`);
      if (operation.evidence_status === "PROVEN") {
        if (operation.exclusion_code !== null || operation.exclusion_reason !== null) {
          block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `PROVEN operation must have null exclusion fields for ${node.code}/${operation.physical_row}`);
        }
      } else if (!textValue(operation.exclusion_code).trim() || !textValue(operation.exclusion_reason).trim()) {
        block("BLOCKED_MANIFEST_OPERATION_SCHEMA", `CANDIDATE_EXCLUDED requires exclusion_code and exclusion_reason for ${node.code}/${operation.physical_row}`);
      }
      if (operation.pair !== null) {
        requireOnlyKeys(operation.pair, allowedPairKeys, "BLOCKED_MANIFEST_OPERATION_SCHEMA", `pair ${node.code}/${operation.physical_row}`);
      }
    }
    nodeByCode.set(node.code, node);
  }

  requireArray([...nodeByCode.keys()], financialCodes, "BLOCKED_MANIFEST_FINANCIAL_CODE_DRIFT", "manifest node order");
  const parentOf = new Map();
  for (const node of manifest.nodes) {
    for (const child of node.child_codes) {
      if (!nodeByCode.has(child)) block("BLOCKED_MANIFEST_GRAPH", `Unknown child ${child} under ${node.code}`);
      if (parentOf.has(child)) block("BLOCKED_MANIFEST_GRAPH", `Multiple parents for ${child}: ${parentOf.get(child)}, ${node.code}`);
      parentOf.set(child, node.code);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(code) {
    if (visiting.has(code)) block("BLOCKED_MANIFEST_GRAPH_CYCLE", `Cycle at ${code}`);
    if (visited.has(code)) return;
    visiting.add(code);
    for (const child of nodeByCode.get(code).child_codes) visit(child);
    visiting.delete(code);
    visited.add(code);
  }
  for (const code of financialCodes) visit(code);

  for (const node of manifest.nodes.filter((candidate) => candidate.node_kind === "PARENT" && candidate.aggregation === "SUM_CHILDREN")) {
    if (node.expected_erp_amount === null || node.child_codes.some((child) => nodeByCode.get(child).expected_erp_amount === null)) {
      block("BLOCKED_PARENT_SUM_CONTRACT", `SUM_CHILDREN requires numeric amounts for ${node.code} and all direct children`);
    }
    const childCents = node.child_codes.reduce((sum, child) => sum + amountCents(nodeByCode.get(child).expected_erp_amount, `${child}.expected_erp_amount`), 0);
    requireEqual(childCents, amountCents(node.expected_erp_amount, `${node.code}.expected_erp_amount`), "BLOCKED_PARENT_SUM_MISMATCH", `parent sum ${node.code}`);
  }
  return nodeByCode;
}

function verifyExactRow(actual, expected, tolerance, nodeCode) {
  const details = { code: nodeCode, physical_row: actual.physical_row };
  for (const field of EXACT_EXPECTED_FIELDS) {
    if (ARRAY_FIELDS.has(field)) {
      requireArray(actual[field], expected[field], "BLOCKED_EXACT_ROW_DRIFT", `${nodeCode}/${actual.physical_row} ${field}`, details);
    } else if (AMOUNT_FIELDS.has(field)) {
      const difference = Math.abs(numericValue(actual[field]) - numericValue(expected[field]));
      if (!Number.isFinite(difference) || difference > tolerance) {
        block("BLOCKED_EXACT_ROW_DRIFT", `${nodeCode}/${actual.physical_row} ${field}: expected ${expected[field]}, got ${actual[field]}`, {
          ...details,
          field,
          expected: expected[field],
          actual: actual[field],
          tolerance,
        });
      }
    } else if (field === "posting_no") {
      requireEqual(actual[field], numericValue(expected[field]), "BLOCKED_EXACT_ROW_DRIFT", `${nodeCode}/${actual.physical_row} ${field}`, details);
    } else {
      requireEqual(actual[field], expected[field], "BLOCKED_EXACT_ROW_DRIFT", `${nodeCode}/${actual.physical_row} ${field}`, details);
    }
  }
}

function countJournalRows(rows, journal) {
  const datePattern = /^\d{2}\.\d{2}\.\d{4}(?:\s|$)/;
  const logicalRows = [...rows.entries()].filter(([physicalRow, cells]) =>
    physicalRow >= journal.data_first_row &&
    physicalRow <= journal.data_last_row &&
    datePattern.test(textValue(cells.get("B"))),
  );
  const factRows = logicalRows.filter(([, cells]) => textValue(cells.get("AB")) === "Факт");
  const activeRows = factRows.filter(([, cells]) => textValue(cells.get("F")) === "Да");
  const inactiveRows = factRows.filter(([, cells]) => textValue(cells.get("F")) === "Нет");
  return { logicalRows, factRows, activeRows, inactiveRows };
}

function verifyJournalCounts(counts, expected) {
  requireEqual(counts.logicalRows.length, expected.dated_rows, "BLOCKED_JOURNAL_COUNT_DRIFT", "dated journal rows");
  requireEqual(counts.factRows.length, expected.fact_rows, "BLOCKED_JOURNAL_COUNT_DRIFT", "Fact journal rows");
  requireEqual(counts.activeRows.length, expected.active_rows, "BLOCKED_JOURNAL_COUNT_DRIFT", "active journal rows");
  requireEqual(counts.inactiveRows.length, expected.inactive_rows, "BLOCKED_JOURNAL_COUNT_DRIFT", "inactive journal rows");
  requireEqual(counts.activeRows.length + counts.inactiveRows.length, counts.factRows.length, "BLOCKED_JOURNAL_ACTIVITY_DOMAIN", "active + inactive Fact rows");
}

function operationPresentation(operation, manifestOperation, nodeCode) {
  const candidate = manifestOperation.evidence_status === "CANDIDATE_EXCLUDED";
  const pair = manifestOperation.pair ?? null;
  const partnerRange = Number.isInteger(pair?.partner_physical_row)
    ? `B${pair.partner_physical_row}:AG${pair.partner_physical_row}`
    : null;
  const generatedComment = [
    `Evidence=${manifestOperation.evidence_status}`,
    candidate ? `Excluded=${manifestOperation.exclusion_code}` : "",
    pair?.pair_id ? `PairID=${pair.pair_id}` : "",
    pair?.pair_status ? `PairStatus=${pair.pair_status}` : "",
    pair?.pair_role ? `PairRole=${pair.pair_role}` : "",
    partnerRange ? `Partner=${partnerRange}` : "",
    manifestOperation.presentation.comment,
  ].filter(Boolean).join("; ");
  return {
    ...operation,
    evidence_status: manifestOperation.evidence_status,
    row_class: candidate ? "CANDIDATE_EXCLUDED" : "SOURCE_CONTRIBUTOR",
    parent_code: nodeCode,
    display_order: manifestOperation.presentation.display_order,
    display_depth_offset: manifestOperation.presentation.display_depth_offset,
    count_in_parent: !candidate,
    count_in_r002: !candidate,
    excluded_from_totals: candidate,
    exclusion_code: candidate ? manifestOperation.exclusion_code : null,
    exclusion_reason: candidate ? manifestOperation.exclusion_reason : null,
    reason: candidate ? manifestOperation.exclusion_reason : manifestOperation.presentation.reason,
    comment: generatedComment,
    date_value: journalDateValue(operation.date),
    pair_id: pair?.pair_id ?? null,
    upload_id: pair?.upload_id ?? null,
    pair_role: pair?.pair_role ?? null,
    pair_status: pair?.pair_status ?? null,
    partner_range: partnerRange,
  };
}

function coordinateParts(coordinate) {
  const match = textValue(coordinate).toUpperCase().match(/^([A-Z]+)([1-9][0-9]*)$/);
  if (!match) block("BLOCKED_JULY_MANIFEST_SCHEMA", `Invalid cell coordinate: ${coordinate}`);
  return { column: match[1], row: Number(match[2]) };
}

function exactExpectedFromExternalRow(row) {
  const result = {
    source_row_id: textValue(row.source_row_id),
    date: textValue(row.date),
    document: textValue(row.document),
    posting_no: numericValue(row.posting_no),
    activity: textValue(row.activity),
    debit: textValue(row.debit),
    debit_analytics: Array.isArray(row.debit_analytics) ? row.debit_analytics.map(textValue) : [],
    debit_department: textValue(row.debit_department),
    credit: textValue(row.credit),
    credit_analytics: Array.isArray(row.credit_analytics) ? row.credit_analytics.map(textValue) : [],
    credit_department: textValue(row.credit_department),
    amount_accounting: numericValue(row.amount_accounting ?? row.amount),
    amount: numericValue(row.amount),
    organization: textValue(row.organization),
    scenario: textValue(row.scenario),
    operation_kind: textValue(row.operation_kind),
    content: textValue(row.content),
    article: textValue(row.article),
    disclosure: textValue(row.disclosure),
    analytics3: textValue(row.analytics3),
  };
  for (const field of EXACT_EXPECTED_FIELDS) {
    if (ARRAY_FIELDS.has(field)) continue;
    if (AMOUNT_FIELDS.has(field) || field === "posting_no") {
      if (!Number.isFinite(result[field])) block("BLOCKED_JULY_MANIFEST_SCHEMA", `External row ${row.physical_row}: ${field} is not numeric`);
    } else if (typeof result[field] !== "string") {
      block("BLOCKED_JULY_MANIFEST_SCHEMA", `External row ${row.physical_row}: ${field} is not text`);
    }
  }
  return result;
}

function pairFromBaseRow(row) {
  if (!row.pair_id && !row.upload_id && !row.pair_role && !row.pair_status && !row.partner_range) return null;
  const partner = textValue(row.partner_range).match(/^B([1-9][0-9]*):AG\1$/i);
  return {
    pair_id: row.pair_id ?? null,
    upload_id: row.upload_id ?? null,
    pair_role: row.pair_role ?? null,
    pair_status: row.pair_status ?? null,
    partner_physical_row: partner ? Number(partner[1]) : null,
  };
}

function canonicalOperation({
  row,
  evidenceStatus,
  exclusionCode = null,
  exclusionReason = null,
  displayOrder,
  displayDepthOffset = 1,
  reason,
  comment = "",
  pair = null,
}) {
  return {
    physical_row: Number(row.physical_row),
    evidence_status: evidenceStatus,
    exclusion_code: exclusionCode,
    exclusion_reason: exclusionReason,
    expected: exactExpectedFromExternalRow(row),
    presentation: {
      display_order: displayOrder,
      display_depth_offset: displayDepthOffset,
      reason: textValue(reason),
      comment: textValue(comment),
    },
    pair,
  };
}

function adaptJulyManifest(raw, input) {
  requireObject(raw, "BLOCKED_JULY_MANIFEST_SCHEMA", "July manifest");
  requireEqual(raw.schema, JULY_MANIFEST_SCHEMA, "BLOCKED_JULY_MANIFEST_SCHEMA", "July manifest schema");
  const safety = requireObject(raw.safety, "BLOCKED_JULY_MANIFEST_SCHEMA", "July safety");
  requireEqual(safety.report_only, true, "BLOCKED_JULY_MANIFEST_UNSAFE", "July report_only");
  requireEqual(safety.posting_rows, 0, "BLOCKED_JULY_MANIFEST_UNSAFE", "July posting_rows");
  requireEqual(safety.ready_to_upload, false, "BLOCKED_JULY_MANIFEST_UNSAFE", "July ready_to_upload");
  requireEqual(safety.release_allowed, false, "BLOCKED_JULY_MANIFEST_UNSAFE", "July release_allowed");
  requireEqual(raw.period, "2025-07", "BLOCKED_JULY_MANIFEST_SCOPE", "July period");
  requireEqual(raw.organization_scope, "9 Управляющая компания", "BLOCKED_JULY_MANIFEST_SCOPE", "July organization scope");

  const proven = Array.isArray(raw.proven_rows) ? raw.proven_rows : block("BLOCKED_JULY_MANIFEST_SCHEMA", "proven_rows must be an array");
  const blockedBranches = Array.isArray(raw.blocked_branches) ? raw.blocked_branches : block("BLOCKED_JULY_MANIFEST_SCHEMA", "blocked_branches must be an array");
  const coverage = requireObject(raw.coverage, "BLOCKED_JULY_MANIFEST_SCHEMA", "July coverage");
  requireEqual(proven.length, Number(coverage.proven_exact_rows), "BLOCKED_JULY_MANIFEST_COVERAGE", "proven branch count");
  requireEqual(blockedBranches.length, Number(coverage.blocked_branches), "BLOCKED_JULY_MANIFEST_COVERAGE", "blocked branch count");
  requireEqual(proven.length + blockedBranches.length, Number(coverage.operation_bearing_terminal_rows), "BLOCKED_JULY_MANIFEST_COVERAGE", "operation-bearing terminal count");
  const provenCodes = proven.map((entry) => textValue(entry.r_code));
  const blockedCodes = blockedBranches.map((entry) => textValue(entry.r_code));
  if (new Set(provenCodes).size !== provenCodes.length || new Set(blockedCodes).size !== blockedCodes.length) {
    block("BLOCKED_JULY_MANIFEST_COVERAGE", "Duplicate R-code in July evidence sets");
  }
  if (provenCodes.some((code) => blockedCodes.includes(code))) {
    block("BLOCKED_JULY_MANIFEST_COVERAGE", "R-code appears in proven and blocked July sets");
  }
  const operationCodes = [...provenCodes, ...blockedCodes].sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
  );
  if (operationCodes.some((code) => !/^R\d{3}$/.test(code))) {
    block("BLOCKED_JULY_MANIFEST_COVERAGE", "Invalid July operation-bearing R-code");
  }
  if (input.financialCodes) {
    requireEqual(input.financialCodes.length, Number(coverage.report_rows_total), "BLOCKED_RUNTIME_FINANCIAL_CODE_DRIFT", "runtime July report row count");
    const runtimeSet = new Set(input.financialCodes);
    const missing = operationCodes.filter((code) => !runtimeSet.has(code));
    if (missing.length > 0) block("BLOCKED_RUNTIME_FINANCIAL_CODE_DRIFT", `Runtime report misses July operation-bearing codes: ${missing.join(", ")}`);
  }

  const base = input.baseOperationEvidence;
  if (!base) block("BLOCKED_R002_BASE_EVIDENCE_REQUIRED", "July manifest adapter requires verified R002 baseOperationEvidence");
  if (!textValue(base.status).startsWith("PASS")) {
    block("BLOCKED_R002_BASE_EVIDENCE", `R002 base evidence is not PASS: ${base.status}`);
  }
  requireEqual(base.report_only, true, "BLOCKED_R002_BASE_EVIDENCE", "R002 base report_only");
  requireEqual(base.posting_rows, 0, "BLOCKED_R002_BASE_EVIDENCE", "R002 base posting_rows");
  requireEqual(base.ready_to_upload, false, "BLOCKED_R002_BASE_EVIDENCE", "R002 base ready_to_upload");
  requireEqual(base.release_allowed, false, "BLOCKED_R002_BASE_EVIDENCE", "R002 base release_allowed");

  const pinned = requireObject(raw.pinned_sources, "BLOCKED_JULY_MANIFEST_SCHEMA", "pinned_sources");
  const journalMeta = requireObject(pinned.journal, "BLOCKED_JULY_MANIFEST_SCHEMA", "pinned_sources.journal");
  const erpMeta = requireObject(pinned.erp_opiu, "BLOCKED_JULY_MANIFEST_SCHEMA", "pinned_sources.erp_opiu");
  requireEqual(textValue(base.journal_sha256).toUpperCase(), textValue(journalMeta.sha256).toUpperCase(), "BLOCKED_R002_BASE_EVIDENCE", "R002 base journal SHA");
  requireEqual(base.source_contributor_rows, 9, "BLOCKED_R002_BASE_EVIDENCE", "R002 base contributor count");
  requireEqual(base.display_operation_rows, 14, "BLOCKED_R002_BASE_EVIDENCE", "R002 base display count");
  if (!input.journalPath && !input.journalBuffer) input.journalPath = path.resolve(textValue(journalMeta.path));
  if (!input.erpOpiuPath) input.erpOpiuPath = path.resolve(textValue(erpMeta.path));

  const bounds = textValue(journalMeta.data_bounds).match(/^B([1-9][0-9]*):AG([1-9][0-9]*)$/i);
  if (!bounds) block("BLOCKED_JULY_MANIFEST_SCHEMA", `Unsupported journal data_bounds: ${journalMeta.data_bounds}`);
  const headerRows = Object.keys(requireObject(journalMeta.headers, "BLOCKED_JULY_MANIFEST_SCHEMA", "journal headers"))
    .map((coordinate) => coordinateParts(coordinate).row);
  if (new Set(headerRows).size !== 1) block("BLOCKED_JULY_MANIFEST_SCHEMA", "Journal headers are not on one row");

  const nodes = new Map(operationCodes.map((code) => [code, {
    code,
    node_kind: "DIRECT_LEAF",
    expected_erp_amount: null,
    child_codes: [],
    aggregation: "NONE",
    operations: [],
  }]));
  const seenPhysicalRows = new Map();
  const deduplications = [];

  for (const entry of [...proven].sort((a, b) => Number(a.r_code.slice(1)) - Number(b.r_code.slice(1)))) {
    const code = textValue(entry.r_code);
    requireEqual(entry.status, "PROVEN_EXACT_SOURCE_OPERATIONS", "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} status`);
    requireEqual(entry.count_in_parent, true, "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} count_in_parent`);
    const node = nodes.get(code);
    node.expected_erp_amount = numericValue(entry.erp?.expected_amount);
    const embeddedRows = entry.journal?.rows;
    if (!Array.isArray(embeddedRows)) block("BLOCKED_JULY_MANIFEST_SCHEMA", `${code} journal.rows is missing`);
    requireArray(entry.journal.physical_rows.map(Number), embeddedRows.map((row) => Number(row.physical_row)), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} journal row order`);
    requireEqual(embeddedRows.length, Number(entry.journal.row_count), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} journal row_count`);
    requireEqual(amountCents(entry.journal.expected_sum, `${code}.journal.expected_sum`), amountCents(node.expected_erp_amount, `${code}.erp.expected_amount`), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} journal-to-ERP manifest sum`);
    let displayOrder = 0;
    for (const row of embeddedRows) {
      displayOrder += 1;
      const physicalRow = Number(row.physical_row);
      if (seenPhysicalRows.has(physicalRow)) block("BLOCKED_JULY_PROVEN_ROW_DUPLICATE", `Physical row ${physicalRow} is assigned to ${seenPhysicalRows.get(physicalRow)} and ${code}`);
      seenPhysicalRows.set(physicalRow, code);
      node.operations.push(canonicalOperation({
        row,
        evidenceStatus: "PROVEN",
        displayOrder,
        reason: "Точная строка ERP-журнала, составляющая сумму статьи.",
        comment: `JulyManifest=${code}`,
      }));
    }
  }

  for (const entry of [...blockedBranches].sort((a, b) => Number(a.r_code.slice(1)) - Number(b.r_code.slice(1)))) {
    const code = textValue(entry.r_code);
    requireEqual(entry.count_in_parent, false, "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} blocked count_in_parent`);
    const node = nodes.get(code);
    node.expected_erp_amount = numericValue(entry.erp?.expected_amount);
    const branchRows = new Map();
    for (const group of entry.candidate_groups ?? []) {
      requireEqual(group.count_in_parent, false, "BLOCKED_JULY_MANIFEST_SCHEMA", `${code}/${group.id} count_in_parent`);
      requireArray(group.physical_rows.map(Number), group.rows.map((row) => Number(row.physical_row)), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code}/${group.id} row order`);
      const groupSum = group.rows.reduce((sum, row) => sum + amountCents(row.amount, `${code}/${group.id}/${row.physical_row}`), 0);
      requireEqual(groupSum, amountCents(group.expected_sum, `${code}/${group.id}.expected_sum`), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code}/${group.id} manifest sum`);
      for (const row of group.rows) {
        const physicalRow = Number(row.physical_row);
        const existing = branchRows.get(physicalRow);
        if (!existing) branchRows.set(physicalRow, { row, groups: [`${group.id}/${group.role}`] });
        else existing.groups.push(`${group.id}/${group.role}`);
      }
    }
    requireArray([...branchRows.keys()].sort((a, b) => a - b), entry.candidate_physical_rows.map(Number).sort((a, b) => a - b), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} candidate row union`);
    requireEqual(branchRows.size, Number(entry.candidate_row_count), "BLOCKED_JULY_MANIFEST_SCHEMA", `${code} candidate_row_count`);
    let displayOrder = 0;
    for (const [physicalRow, candidate] of branchRows) {
      const existingOwner = seenPhysicalRows.get(physicalRow);
      if (existingOwner) {
        deduplications.push({ physical_row: physicalRow, kept_under: existingOwner, omitted_from: code, source: "JULY_BLOCKED_CROSS_BRANCH" });
        continue;
      }
      displayOrder += 1;
      seenPhysicalRows.set(physicalRow, code);
      node.operations.push(canonicalOperation({
        row: candidate.row,
        evidenceStatus: "CANDIDATE_EXCLUDED",
        exclusionCode: textValue(entry.status) || "BLOCKED_JULY_BRANCH",
        exclusionReason: `${textValue(entry.blocker)} Группы: ${candidate.groups.join(", ")}.`,
        displayOrder,
        reason: "",
        comment: `RequiredResolution=${textValue(entry.required_resolution)}`,
      }));
    }
  }

  const julyBaseCodes = new Set(["R003", "R004", "R005", "R006", "R007", "R008", "R009"]);
  const canonicalProvenById = new Map();
  for (const node of nodes.values()) {
    for (const operation of node.operations.filter((candidate) => candidate.evidence_status === "PROVEN")) {
      canonicalProvenById.set(operation.expected.source_row_id, { code: node.code, operation });
    }
  }
  for (const row of base.rows ?? []) {
    if (!julyBaseCodes.has(textValue(row.parent_code))) continue;
    const existing = canonicalProvenById.get(textValue(row.source_row_id));
    if (row.count_in_parent === true) {
      if (!existing || existing.code !== row.parent_code) {
        block("BLOCKED_R002_BASE_PROVEN_DRIFT", `R002 base PROVEN row ${row.physical_row} is absent or moved in July manifest`, {
          parent_code: row.parent_code,
        });
      }
      deduplications.push({ physical_row: row.physical_row, kept_under: existing.code, omitted_from: row.parent_code, source: "R002_BASE_PROVEN_DUPLICATE" });
      continue;
    }
    const physicalRow = Number(row.physical_row);
    const existingOwner = seenPhysicalRows.get(physicalRow);
    if (existingOwner) {
      const existingNode = nodes.get(existingOwner);
      const existingIndex = existingNode?.operations.findIndex(
        (operation) => operation.physical_row === physicalRow,
      ) ?? -1;
      const existingOperation = existingIndex >= 0 ? existingNode.operations[existingIndex] : null;
      if (!existingOperation) {
        block("BLOCKED_R002_BASE_CANDIDATE_CONFLICT", `R002 base candidate row ${physicalRow} cannot be found under ${existingOwner}`);
      }
      const pair = pairFromBaseRow(row);
      if (pair) existingOperation.pair = pair;
      existingOperation.presentation.comment = [
        existingOperation.presentation.comment,
        `R002BaseContext=${row.parent_code}`,
        `R002BaseExcluded=true`,
        textValue(row.reason),
      ].filter(Boolean).join("; ");
      deduplications.push({
        physical_row: physicalRow,
        kept_under: existingOwner,
        omitted_from: row.parent_code,
        source: "R002_BASE_CONTEXT_DEDUP",
      });
      continue;
    }
    const node = nodes.get(row.parent_code);
    if (!node) block("BLOCKED_R002_BASE_PARENT_DRIFT", `R002 base candidate parent is not operation-bearing: ${row.parent_code}`);
    seenPhysicalRows.set(physicalRow, row.parent_code);
    node.operations.push(canonicalOperation({
      row,
      evidenceStatus: "CANDIDATE_EXCLUDED",
      exclusionCode: textValue(row.row_class) || "R002_BASE_EXCLUDED",
      exclusionReason: textValue(row.reason) || "R002 base display row is excluded from the leaf total.",
      displayOrder: Math.max(0, ...node.operations.map((operation) => operation.presentation.display_order)) + 1,
      displayDepthOffset: Number(row.display_depth_offset ?? 2),
      reason: "",
      comment: textValue(row.comment),
      pair: pairFromBaseRow(row),
    }));
  }

  const allowedOrganizations = [...new Set(
    [...nodes.values()].flatMap((node) => node.operations.map((operation) => operation.expected.organization)),
  )].sort();
  const canonical = {
    schema: MANIFEST_SCHEMA,
    manifest_id: `ADAPTED:${textValue(raw.generated_at_utc) || "JULY-2025"}`,
    source_row_key_contract: SOURCE_ROW_KEY_CONTRACT,
    scope: {
      mode: "month",
      period: raw.period,
      organization: raw.organization_scope,
      allowed_journal_organizations: allowedOrganizations,
      financial_codes: operationCodes,
    },
    journal: {
      sha256: textValue(journalMeta.sha256).toUpperCase(),
      sheet: textValue(journalMeta.sheet),
      header_row: headerRows[0],
      data_first_row: Number(bounds[1]),
      data_last_row: Number(bounds[2]),
      ooxml_dimension: base.source_trace?.journal?.observed_ooxml_dimension ?? null,
      expected_counts: {
        dated_rows: Number(base.counts?.journal_rows),
        fact_rows: Number(base.counts?.fact_rows),
        active_rows: Number(base.counts?.active_rows),
        inactive_rows: Number(base.counts?.inactive_rows),
      },
    },
    tolerance: 0.01,
    nodes: operationCodes.map((code) => nodes.get(code)),
  };
  return {
    manifest: canonical,
    raw,
    trace: {
      source_schema: JULY_MANIFEST_SCHEMA,
      adapted_schema: MANIFEST_SCHEMA,
      report_rows_total: Number(coverage.report_rows_total),
      operation_bearing_terminal_rows: operationCodes.length,
      proven_r_codes: provenCodes.length,
      blocked_r_codes: blockedCodes.length,
      proven_manifest_rows: proven.reduce((sum, entry) => sum + entry.journal.rows.length, 0),
      candidate_manifest_occurrences: blockedBranches.reduce(
        (sum, entry) => sum + entry.candidate_groups.reduce((groupSum, group) => groupSum + group.rows.length, 0),
        0,
      ),
      unique_display_rows_after_dedup: seenPhysicalRows.size,
      deduplications,
    },
    journalExpectedSize: Number(journalMeta.size),
    erpExpectedSize: Number(erpMeta.size),
  };
}

async function verifyJulyErpOpiu(adapter, input, trace) {
  const raw = adapter.raw;
  const meta = raw.pinned_sources.erp_opiu;
  if (!input.erpOpiuPath) block("BLOCKED_ERP_OPIU_PATH_REQUIRED", "erpOpiuPath is required for July manifest verification");
  let buffer;
  try {
    buffer = await fs.readFile(input.erpOpiuPath);
  } catch (error) {
    block("BLOCKED_ERP_OPIU_NOT_FOUND", `Cannot read ERP OPIU: ${input.erpOpiuPath}`, { cause: error.code ?? error.message });
  }
  requireEqual(buffer.length, adapter.erpExpectedSize, "BLOCKED_ERP_OPIU_SIZE_DRIFT", "ERP OPIU size");
  const actualSha256 = sha256(buffer);
  requireEqual(actualSha256, textValue(meta.sha256).toUpperCase(), "BLOCKED_ERP_OPIU_HASH_DRIFT", "ERP OPIU SHA-256");
  const worksheet = await loadWorksheetFromXlsx(buffer, meta.sheet);
  for (const [coordinate, expected] of Object.entries(meta.headers ?? {})) {
    const { column, row } = coordinateParts(coordinate);
    requireEqual(textValue(cell(worksheet.rows, row, column)), textValue(expected), "BLOCKED_ERP_OPIU_HEADER_DRIFT", `ERP OPIU ${coordinate}`);
  }
  for (const entry of [...raw.proven_rows, ...raw.blocked_branches]) {
    const basisRows = new Set(entry.erp.amount_basis_physical_rows.map(Number));
    const seenBasis = new Set();
    let basisCents = 0;
    for (const source of entry.erp.source_trace) {
      const { column, row } = coordinateParts(source.cell);
      requireEqual(row, Number(source.physical_row), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP physical row`);
      const actualCents = amountCents(cell(worksheet.rows, row, column), `${entry.r_code} ${source.cell}`);
      requireEqual(actualCents, amountCents(source.amount, `${entry.r_code} ${source.cell} expected`), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP ${source.cell}`);
      const counted = source.count_in_expected_sum === true;
      requireEqual(counted, basisRows.has(row), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP basis flag ${source.cell}`);
      if (counted) {
        basisCents += actualCents;
        seenBasis.add(row);
      }
    }
    requireArray([...seenBasis].sort((a, b) => a - b), [...basisRows].sort((a, b) => a - b), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP basis rows`);
    requireEqual(basisCents, amountCents(entry.erp.expected_amount, `${entry.r_code} ERP expected amount`), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP basis sum`);
    for (const source of entry.erp.context_sources ?? []) {
      const { column, row } = coordinateParts(source.cell);
      requireEqual(amountCents(cell(worksheet.rows, row, column), `${entry.r_code} context ${source.cell}`), amountCents(source.amount, `${entry.r_code} context expected ${source.cell}`), "BLOCKED_ERP_OPIU_TRACE_DRIFT", `${entry.r_code} ERP context ${source.cell}`);
    }
  }
  trace.erp_opiu = {
    path: input.erpOpiuPath,
    sha256: actualSha256,
    bytes: buffer.length,
    sheet: meta.sheet,
    worksheet_entry: worksheet.entry,
    verified: true,
  };
}

async function readManifest(input) {
  if (!input.manifestPath) block("BLOCKED_MANIFEST_PATH_REQUIRED", "manifestPath is required");
  if (!/^[0-9A-F]{64}$/.test(input.manifestExpectedSha256)) {
    block("BLOCKED_MANIFEST_HASH_PIN_REQUIRED", "manifestExpectedSha256 is required and must be SHA-256");
  }
  let buffer;
  try {
    buffer = await fs.readFile(input.manifestPath);
  } catch (error) {
    block("BLOCKED_MANIFEST_NOT_FOUND", `Cannot read manifest: ${input.manifestPath}`, { cause: error.code ?? error.message });
  }
  const actualSha256 = sha256(buffer);
  requireEqual(actualSha256, input.manifestExpectedSha256, "BLOCKED_MANIFEST_HASH_DRIFT", "manifest SHA-256", { manifest_path: input.manifestPath });
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    block("BLOCKED_MANIFEST_JSON", `Cannot parse manifest JSON: ${error.message}`);
  }
  return { buffer, actualSha256, manifest };
}

async function readJournal(input) {
  if (input.journalBuffer && input.journalPath) block("BLOCKED_JOURNAL_SOURCE_AMBIGUOUS", "Provide journalPath or journalBuffer, not both");
  if (input.journalBuffer) return { buffer: input.journalBuffer, source: input.journalSourceLabel || "BUFFER" };
  if (!input.journalPath) block("BLOCKED_JOURNAL_PATH_REQUIRED", "journalPath or journalBuffer is required");
  try {
    return { buffer: await fs.readFile(input.journalPath), source: input.journalPath };
  } catch (error) {
    block("BLOCKED_JOURNAL_NOT_FOUND", `Cannot read journal: ${input.journalPath}`, { cause: error.code ?? error.message });
  }
}

/**
 * Read the exact ERP journal selected by the current run without requiring a
 * pre-built evidence manifest.  This is intentionally a parser only: callers
 * still have to prove ownership of every row before it can contribute to an
 * OPIU line.
 */
export async function readOperationJournalRows(options = {}) {
  const journalPath = typeof options.journalPath === "string" && options.journalPath.trim()
    ? path.resolve(options.journalPath)
    : "";
  const journalBuffer = Buffer.isBuffer(options.journalBuffer) ? options.journalBuffer : null;
  if (journalPath && journalBuffer) {
    block("BLOCKED_JOURNAL_SOURCE_AMBIGUOUS", "Provide journalPath or journalBuffer, not both");
  }
  if (!journalPath && !journalBuffer) {
    block("BLOCKED_JOURNAL_PATH_REQUIRED", "journalPath or journalBuffer is required");
  }

  const buffer = journalBuffer ?? await fs.readFile(journalPath);
  const journalSha256 = sha256(buffer);
  const sheet = textValue(options.sheet || "Лист_1").trim();
  const worksheet = await loadWorksheetFromXlsx(buffer, sheet);
  const candidateHeaderRows = [...worksheet.rows.keys()].filter((row) =>
    textValue(cell(worksheet.rows, row, "B")) === HEADER_CONTRACT.B &&
    textValue(cell(worksheet.rows, row, "D")) === HEADER_CONTRACT.D &&
    textValue(cell(worksheet.rows, row, "AG")) === HEADER_CONTRACT.AG
  );
  if (candidateHeaderRows.length !== 1) {
    block(
      "BLOCKED_JOURNAL_HEADER_AMBIGUOUS",
      `Expected one exact journal header row, got ${candidateHeaderRows.length}`,
      { candidate_header_rows: candidateHeaderRows },
    );
  }
  const headerRow = candidateHeaderRows[0];
  verifyHeaderContract(worksheet.rows, headerRow);
  const physicalRows = [...worksheet.rows.keys()]
    .filter((row) => row > headerRow)
    .sort((left, right) => left - right);
  const operations = physicalRows
    .map((physicalRow) => operationFromRow(worksheet.rows, physicalRow, journalSha256, sheet))
    .filter((row) => row.date || row.document || Number.isFinite(row.amount));
  for (const row of operations) {
    row.period = journalPeriod(row.date);
    row.date_value = journalDateValue(row.date);
  }
  return {
    source: journalPath || textValue(options.journalSourceLabel) || "BUFFER",
    journal_sha256: journalSha256,
    journal_sheet: sheet,
    worksheet_entry: worksheet.entry,
    ooxml_dimension: worksheet.dimension,
    header_row: headerRow,
    data_first_row: physicalRows[0] ?? null,
    data_last_row: physicalRows.at(-1) ?? null,
    rows: operations,
  };
}

export async function loadFullOperationEvidence(options = {}) {
  const input = normalizedInput(options);
  const trace = {};
  try {
    const { actualSha256: manifestSha256, manifest: rawManifest } = await readManifest(input);
    trace.manifest = { path: input.manifestPath, sha256: manifestSha256, verified: true };
    const adapter = rawManifest.schema === JULY_MANIFEST_SCHEMA
      ? adaptJulyManifest(rawManifest, input)
      : null;
    const manifest = adapter?.manifest ?? rawManifest;
    if (adapter) trace.adapter = adapter.trace;
    validateScopeAndJournal(manifest);
    const applicable =
      input.mode === textValue(manifest.scope.mode).toLowerCase() &&
      input.period === manifest.scope.period &&
      input.organization === manifest.scope.organization;
    if (!applicable) {
      const result = baseResult("NOT_APPLICABLE", false, input);
      result.manifest_id = manifest.manifest_id;
      result.manifest_sha256 = manifestSha256;
      result.expected_scope = {
        mode: manifest.scope.mode,
        period: manifest.scope.period,
        organization: manifest.scope.organization,
      };
      result.source_trace = trace;
      return result;
    }

    const financialCodes = adapter
      ? manifest.scope.financial_codes
      : (input.financialCodes ?? manifest.scope.financial_codes);
    if (!adapter) {
      requireArray(financialCodes, manifest.scope.financial_codes, "BLOCKED_RUNTIME_FINANCIAL_CODE_DRIFT", "runtime financial codes");
    }
    const nodeByCode = validateNodeGraph(manifest, financialCodes);

    const journalSource = await readJournal(input);
    if (adapter) requireEqual(journalSource.buffer.length, adapter.journalExpectedSize, "BLOCKED_JOURNAL_SIZE_DRIFT", "journal size");
    const journalSha256 = sha256(journalSource.buffer);
    requireEqual(journalSha256, textValue(manifest.journal.sha256).toUpperCase(), "BLOCKED_JOURNAL_HASH_DRIFT", "journal SHA-256", { journal_source: journalSource.source });
    trace.journal = { source: journalSource.source, sha256: journalSha256, verified: true };
    const journalSheet = await loadWorksheetFromXlsx(journalSource.buffer, manifest.journal.sheet);
    if (manifest.journal.ooxml_dimension !== null) {
      requireEqual(journalSheet.dimension, manifest.journal.ooxml_dimension, "BLOCKED_JOURNAL_DIMENSION_DRIFT", "journal OOXML dimension");
    }
    verifyHeaderContract(journalSheet.rows, manifest.journal.header_row);
    const journalCounts = countJournalRows(journalSheet.rows, manifest.journal);
    verifyJournalCounts(journalCounts, manifest.journal.expected_counts);
    trace.journal.sheet = manifest.journal.sheet;
    trace.journal.worksheet_entry = journalSheet.entry;
    trace.journal.header_range = `B${manifest.journal.header_row}:AG${manifest.journal.header_row}`;
    trace.journal.data_range = `B${manifest.journal.data_first_row}:AG${manifest.journal.data_last_row}`;
    trace.journal.ooxml_dimension = journalSheet.dimension;
    trace.header_contract_sha256 = sha256(Buffer.from(JSON.stringify(HEADER_CONTRACT), "utf8"));
    if (adapter) await verifyJulyErpOpiu(adapter, input, trace);

    const allowedOrganizations = new Set(manifest.scope.allowed_journal_organizations);
    const tolerance = numericValue(manifest.tolerance);
    const seenPhysicalRows = new Set();
    const rows = [];
    const nodeEvidence = [];
    const leafTotals = {};

    for (const code of financialCodes) {
      const node = nodeByCode.get(code);
      if (node.node_kind !== "DIRECT_LEAF") {
        nodeEvidence.push({
          code,
          node_kind: node.node_kind,
          node_status: node.node_kind === "PARENT" ? "NO_DIRECT_OPERATION_PARENT" : "NO_DIRECT_OPERATION_COMPUTED",
          expected_erp_amount: node.expected_erp_amount,
          proven_amount: null,
          proven_rows: 0,
          candidate_excluded_rows: 0,
          child_codes: [...node.child_codes],
        });
        continue;
      }

      const nodeRows = [];
      for (const manifestOperation of node.operations) {
        if (seenPhysicalRows.has(manifestOperation.physical_row)) {
          block("BLOCKED_SOURCE_ROW_DUPLICATE", `Journal row ${manifestOperation.physical_row} is listed more than once`, { code });
        }
        seenPhysicalRows.add(manifestOperation.physical_row);
        const actual = operationFromRow(journalSheet.rows, manifestOperation.physical_row, journalSha256, manifest.journal.sheet);
        verifyExactRow(actual, manifestOperation.expected, tolerance, code);
        requireEqual(journalPeriod(actual.date), manifest.scope.period, "BLOCKED_OPERATION_PERIOD_DRIFT", `${code}/${actual.physical_row} period`);
        if (!allowedOrganizations.has(actual.organization)) {
          block("BLOCKED_OPERATION_ORGANIZATION_SCOPE", `${code}/${actual.physical_row} organization is outside manifest scope`, {
            organization: actual.organization,
          });
        }
        if (manifestOperation.evidence_status === "PROVEN") {
          requireEqual(actual.activity, "Да", "BLOCKED_PROVEN_ROW_INACTIVE", `${code}/${actual.physical_row} activity`);
          requireEqual(actual.scenario, "Факт", "BLOCKED_PROVEN_ROW_SCENARIO", `${code}/${actual.physical_row} scenario`);
        }
        nodeRows.push(operationPresentation(actual, manifestOperation, code));
      }

      const provenRows = nodeRows.filter((row) => row.evidence_status === "PROVEN");
      const candidates = nodeRows.filter((row) => row.evidence_status === "CANDIDATE_EXCLUDED");
      const provenCents = provenRows.reduce((sum, row) => sum + amountCents(row.amount, `${code}/${row.physical_row}.amount`), 0);
      if (provenRows.length > 0) {
        if (node.expected_erp_amount === null) block("BLOCKED_LEAF_TOTAL_MISSING", `${code} has PROVEN rows but expected_erp_amount is null`);
        requireEqual(provenCents, amountCents(node.expected_erp_amount, `${code}.expected_erp_amount`), "BLOCKED_LEAF_TOTAL_MISMATCH", `PROVEN leaf total ${code}`);
      }
      const nodeStatus = provenRows.length > 0 ? "PROVEN" : "BLOCKED_NO_PROVEN_ROWS";
      leafTotals[code] = provenCents / 100;
      nodeEvidence.push({
        code,
        node_kind: node.node_kind,
        node_status: nodeStatus,
        expected_erp_amount: node.expected_erp_amount,
        proven_amount: provenCents / 100,
        proven_rows: provenRows.length,
        candidate_excluded_rows: candidates.length,
        child_codes: [],
      });
      rows.push(...nodeRows);
    }

    rows.sort((left, right) => {
      const codeOrder = financialCodes.indexOf(left.parent_code) - financialCodes.indexOf(right.parent_code);
      if (codeOrder !== 0) return codeOrder;
      return Number(left.display_order) - Number(right.display_order) || left.physical_row - right.physical_row;
    });
    const provenRows = rows.filter((row) => row.evidence_status === "PROVEN");
    const candidateRows = rows.filter((row) => row.evidence_status === "CANDIDATE_EXCLUDED");
    const blockedLeaves = nodeEvidence.filter((node) => node.node_kind === "DIRECT_LEAF" && node.node_status !== "PROVEN");
    const coverageComplete = blockedLeaves.length === 0;
    const status = coverageComplete
      ? "PASS_OPERATION_EVIDENCE_MANIFEST_VERIFIED_READ_ONLY"
      : "BLOCKED_OPERATION_COVERAGE_INCOMPLETE";

    return {
      schema: RESULT_SCHEMA,
      status,
      applicable: true,
      input: {
        manifest_path: input.manifestPath,
        journal_source: journalSource.source,
        organization: input.organization,
        mode: input.mode,
        period: input.period,
      },
      manifest_id: manifest.manifest_id,
      manifest_sha256: manifestSha256,
      journal_sha256: journalSha256,
      journal_sheet: manifest.journal.sheet,
      source_contributor_rows: provenRows.length,
      display_operation_rows: rows.length,
      candidate_excluded_rows: candidateRows.length,
      new_pair_candidates: 0,
      correction_operation_rows: 0,
      posting_rows: 0,
      report_only: true,
      ready_to_upload: false,
      release_allowed: false,
      rows,
      node_evidence: nodeEvidence,
      leaf_totals: leafTotals,
      counts: {
        financial_nodes: nodeEvidence.length,
        parent_nodes: nodeEvidence.filter((node) => node.node_kind === "PARENT").length,
        direct_leaf_nodes: nodeEvidence.filter((node) => node.node_kind === "DIRECT_LEAF").length,
        computed_nodes: nodeEvidence.filter((node) => node.node_kind === "COMPUTED_NO_DIRECT_OPERATION").length,
        blocked_direct_leaf_nodes: blockedLeaves.length,
        journal_rows: journalCounts.logicalRows.length,
        fact_rows: journalCounts.factRows.length,
        active_rows: journalCounts.activeRows.length,
        inactive_rows: journalCounts.inactiveRows.length,
        source_contributor_rows: provenRows.length,
        candidate_excluded_rows: candidateRows.length,
        display_operation_rows: rows.length,
        correction_operation_rows: 0,
        posting_rows: 0,
      },
      gates: safeGates({
        manifest_verified: true,
        journal_verified: true,
        operation_coverage_complete: coverageComplete,
      }),
      source_trace: trace,
      coverage: adapter ? adapter.raw.coverage : null,
      adapter: adapter ? adapter.trace : null,
    };
  } catch (error) {
    return blockedResult(error, input, trace);
  }
}
