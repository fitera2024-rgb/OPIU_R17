import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_LOCK_PATH = path.join(MODULE_DIR, "qa", "r002_source_lock.json");
const FIXTURE_PATH = path.join(MODULE_DIR, "qa", "r002_july_test_fixture.json");

const RESULT_SCHEMA = "opiu-r002-operation-evidence-v1";
const SUCCESS_STATUS = "PASS_R002_JULY_OPERATION_EVIDENCE_LOCKED_READ_ONLY";
const RELEASE_STATUS = "BLOCKED_RELEASE_GATES_NOT_RUN";

const HEADER_CONTRACT = Object.freeze({
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

class EvidenceBlockedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EvidenceBlockedError";
    this.code = code;
    this.details = details;
  }
}

function blocked(code, message, details = {}) {
  throw new EvidenceBlockedError(code, message, details);
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
  if (!relationshipId) blocked("BLOCKED_SHEET_NAME_DRIFT", `Worksheet not found: ${sheetName}`, { sheet: sheetName });

  for (const match of relationshipsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.Id !== relationshipId) continue;
    const target = attributes.Target;
    if (!target) break;
    return target.startsWith("/")
      ? target.slice(1)
      : path.posix.normalize(path.posix.join("xl", target.replace(/^\.\//, "")));
  }
  blocked("BLOCKED_SHEET_RELATIONSHIP_DRIFT", `Worksheet relationship not found: ${sheetName}`, {
    sheet: sheetName,
    relationship_id: relationshipId,
  });
}

async function loadWorksheetFromXlsx(buffer, sheetName) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    blocked("BLOCKED_INNER_XLSX_PARSE_ERROR", `Cannot parse XLSX: ${error.message}`);
  }
  const workbookEntry = zip.file("xl/workbook.xml");
  const relationshipsEntry = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relationshipsEntry) {
    blocked("BLOCKED_INNER_XLSX_STRUCTURE_DRIFT", "XLSX workbook metadata is missing");
  }
  const [workbookXml, relationshipsXml, sharedStringsXml] = await Promise.all([
    workbookEntry.async("string"),
    relationshipsEntry.async("string"),
    zip.file("xl/sharedStrings.xml")?.async("string") ?? Promise.resolve(""),
  ]);
  const sheetTarget = findSheetTarget(workbookXml, relationshipsXml, sheetName);
  const sheetEntry = zip.file(sheetTarget);
  if (!sheetEntry) {
    blocked("BLOCKED_SHEET_ENTRY_DRIFT", `Worksheet entry not found: ${sheetTarget}`, {
      sheet: sheetName,
      entry: sheetTarget,
    });
  }
  const worksheetXml = await sheetEntry.async("string");
  const sharedStrings = parseSharedStrings(sharedStringsXml);
  return {
    entry: sheetTarget,
    dimension: worksheetXml.match(/<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref="([^"]+)"/)?.[1] ?? null,
    rows: parseWorksheetRows(worksheetXml, sharedStrings),
  };
}

function cell(rows, row, column) {
  return rows.get(row)?.get(column) ?? null;
}

function textValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function numericValue(value) {
  const result = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(result) ? result : Number.NaN;
}

function cents(value) {
  return Math.round(numericValue(value) * 100);
}

function amountsEqual(actual, expected, tolerance = 0.01) {
  return Number.isFinite(numericValue(actual)) && Math.abs(numericValue(actual) - numericValue(expected)) <= tolerance;
}

function requireEqual(actual, expected, code, label, details = {}) {
  if (actual !== expected) {
    blocked(code, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, {
      ...details,
      label,
      expected,
      actual,
    });
  }
}

function requireAmount(actual, expected, tolerance, code, label, details = {}) {
  if (!amountsEqual(actual, expected, tolerance)) {
    blocked(code, `${label}: expected ${expected}, got ${actual}`, {
      ...details,
      label,
      expected,
      actual,
      tolerance,
    });
  }
}

function requireArray(actual, expected, code, label, details = {}) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    blocked(code, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, {
      ...details,
      label,
      expected,
      actual,
    });
  }
}

function normalizedInputs(options = {}) {
  const { erpPath, organization, mode, period } = options;
  return {
    erpPath: typeof erpPath === "string" ? erpPath.trim() : "",
    organization: typeof organization === "string" ? organization.trim() : "",
    mode: typeof mode === "string" ? mode.trim().toLowerCase() : "",
    period: typeof period === "string" ? period.trim() : "",
    diagnosticExtractedSet: options.diagnosticExtractedSet === true,
  };
}

function safeGates(overrides = {}) {
  return {
    report_only: true,
    source_verified: false,
    new_pair_candidates: 0,
    correction_operation_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    release_status: RELEASE_STATUS,
    ...overrides,
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
    input,
    source_contributor_rows: 0,
    display_operation_rows: 0,
    new_pair_candidates: 0,
    correction_operation_rows: 0,
    posting_rows: 0,
    report_only: true,
    ready_to_upload: false,
    release_allowed: false,
    journal_sha256: null,
    rows: [],
    counts: {
      journal_rows: 0,
      fact_rows: 0,
      active_rows: 0,
      inactive_rows: 0,
      source_contributor_rows: 0,
      display_operation_rows: 0,
      existing_pair_rows: 0,
      existing_pair_active_rows: 0,
      existing_pair_inactive_rows: 0,
      duplicate_inactive_rows: 0,
      new_pair_candidates: 0,
      correction_operation_rows: 0,
      posting_rows: 0,
    },
    gates: safeGates(),
    source_trace: null,
  };
}

function blockedResult(error, input) {
  const code = error instanceof EvidenceBlockedError ? error.code : "BLOCKED_UNEXPECTED_ERROR";
  const result = baseResult(code, true, input);
  result.error = {
    code,
    message: error?.message ?? String(error),
    details: error instanceof EvidenceBlockedError ? error.details : {},
  };
  return result;
}

async function readPinnedJson() {
  let lock;
  let fixture;
  try {
    const parsePinnedJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ""));
    [lock, fixture] = await Promise.all([
      fs.readFile(SOURCE_LOCK_PATH, "utf8").then(parsePinnedJson),
      fs.readFile(FIXTURE_PATH, "utf8").then(parsePinnedJson),
    ]);
  } catch (error) {
    blocked("BLOCKED_PINNED_QA_CONFIG", `Cannot read pinned R002 QA JSON: ${error.message}`);
  }
  requireEqual(lock.schema, "opiu-r002-july-source-lock-v1", "BLOCKED_SOURCE_LOCK_DRIFT", "source lock schema");
  requireEqual(fixture.schema, "opiu-r002-july-test-fixture-v1", "BLOCKED_FIXTURE_DRIFT", "fixture schema");
  requireEqual(lock.organization, fixture.organization, "BLOCKED_PIN_MISMATCH", "organization pin");
  requireEqual(lock.period, fixture.period, "BLOCKED_PIN_MISMATCH", "period pin");
  requireEqual(lock.mode, "month", "BLOCKED_PIN_MISMATCH", "mode pin");
  requireEqual(lock.erp_zip.sha256, fixture.source_pins.erp_zip_sha256, "BLOCKED_PIN_MISMATCH", "outer ZIP SHA pin");
  requireEqual(lock.erp_journal.sha256, fixture.source_pins.erp_journal_sha256, "BLOCKED_PIN_MISMATCH", "journal SHA pin");
  requireEqual(lock.erp_opiu.sha256, fixture.source_pins.erp_opiu_sha256, "BLOCKED_PIN_MISMATCH", "ERP OPIU SHA pin");
  requireEqual(lock.erp_journal.sheet, fixture.journal_expected.sheet, "BLOCKED_PIN_MISMATCH", "journal sheet pin");
  requireEqual(lock.erp_journal.header_range, fixture.journal_expected.header_range, "BLOCKED_PIN_MISMATCH", "journal header range pin");
  requireEqual(lock.erp_journal.data_range, fixture.journal_expected.logical_data_range, "BLOCKED_PIN_MISMATCH", "journal data range pin");
  requireEqual(lock.erp_journal.ooxml_dimension_ignored, fixture.journal_expected.observed_ooxml_dimension, "BLOCKED_PIN_MISMATCH", "journal dimension pin");
  requireEqual(fixture.source_row_key_contract, "SHA256(journal_sha256|sheet|physical_row)", "BLOCKED_FIXTURE_DRIFT", "source row key contract");
  requireEqual(lock.expected.journal_rows, fixture.journal_expected.dated_row_count, "BLOCKED_PIN_MISMATCH", "journal row count pin");
  requireEqual(lock.expected.fact_rows, fixture.journal_expected.scenario_fact_count, "BLOCKED_PIN_MISMATCH", "Fact row count pin");
  requireEqual(lock.expected.active_rows, fixture.journal_expected.active_count, "BLOCKED_PIN_MISMATCH", "active row count pin");
  requireEqual(lock.expected.inactive_rows, fixture.journal_expected.inactive_count, "BLOCKED_PIN_MISMATCH", "inactive row count pin");
  requireEqual(lock.expected.source_contributor_rows, fixture.contributors.length, "BLOCKED_PIN_MISMATCH", "contributor count pin");
  requireAmount(lock.expected.r002_amount, fixture.leaf_totals.R002, fixture.tolerance, "BLOCKED_PIN_MISMATCH", "R002 amount pin");
  requireAmount(lock.expected.r002_delta, 0, fixture.tolerance, "BLOCKED_PIN_MISMATCH", "R002 delta pin");
  requireEqual(lock.expected.new_pair_candidates, fixture.final_gates.new_pair_candidates, "BLOCKED_PIN_MISMATCH", "new pair count pin");
  requireEqual(lock.expected.correction_operation_rows, fixture.final_gates.correction_operation_rows, "BLOCKED_PIN_MISMATCH", "correction row count pin");
  requireEqual(lock.expected.posting_rows, fixture.final_gates.posting_rows, "BLOCKED_PIN_MISMATCH", "posting row count pin");
  requireEqual(lock.expected.report_only, fixture.final_gates.report_only, "BLOCKED_PIN_MISMATCH", "report_only pin");
  requireEqual(lock.expected.ready_to_upload, fixture.final_gates.ready_to_upload, "BLOCKED_PIN_MISMATCH", "ready_to_upload pin");
  requireEqual(lock.expected.release_allowed, fixture.final_gates.release_allowed, "BLOCKED_PIN_MISMATCH", "release_allowed pin");
  requireEqual(fixture.final_gates.posting_rows, 0, "BLOCKED_FIXTURE_UNSAFE", "fixture posting_rows");
  requireEqual(fixture.final_gates.ready_to_upload, false, "BLOCKED_FIXTURE_UNSAFE", "fixture ready_to_upload");
  requireEqual(fixture.final_gates.release_allowed, false, "BLOCKED_FIXTURE_UNSAFE", "fixture release_allowed");
  return { lock, fixture };
}

function verifyHeaders(rows) {
  for (const [column, expected] of Object.entries(HEADER_CONTRACT)) {
    requireEqual(textValue(cell(rows, 4, column)), expected, "BLOCKED_JOURNAL_HEADER_DRIFT", `header ${column}4`, {
      cell: `${column}4`,
      observed_row4: Object.fromEntries(rows.get(4) ?? []),
    });
  }
}

function operationFromRow(rows, physicalRow, journalSha256, sheet) {
  const compact = (columns) => columns.map((column) => textValue(cell(rows, physicalRow, column))).filter(Boolean);
  return {
    physical_row: physicalRow,
    source_range: `B${physicalRow}:AG${physicalRow}`,
    source_row_id: stableRowKey(journalSha256, sheet, physicalRow),
    date: textValue(cell(rows, physicalRow, "B")),
    document: textValue(cell(rows, physicalRow, "D")),
    posting_no: numericValue(cell(rows, physicalRow, "E")),
    activity: textValue(cell(rows, physicalRow, "F")),
    debit: textValue(cell(rows, physicalRow, "G")),
    debit_analytics: compact(["H", "I", "J"]),
    debit_department: textValue(cell(rows, physicalRow, "K")),
    credit: textValue(cell(rows, physicalRow, "P")),
    credit_analytics: compact(["Q", "R", "S"]),
    credit_department: textValue(cell(rows, physicalRow, "T")),
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

function journalDateValue(value) {
  const match = textValue(value).match(
    /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/,
  );
  if (!match) return null;
  const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
  return `${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:${second}`;
}

function operationPresentationFields({
  operation,
  rowClass,
  parentCode,
  displayOrder,
  displayDepthOffset,
  countInParent,
  partnerRange = null,
}) {
  const pairComment = operation.pair_id
    ? [
        `PairID=${operation.pair_id}`,
        `Status=${operation.pair_status}`,
        `Role=${operation.pair_role}`,
        partnerRange ? `Partner=${partnerRange}` : "",
        operation.excluded_from_totals ? "EXCLUDED_FROM_TOTAL" : "",
      ].filter(Boolean).join("; ")
    : "";
  return {
    row_class: rowClass,
    parent_code: parentCode,
    display_order: displayOrder,
    display_depth_offset: displayDepthOffset,
    count_in_parent: countInParent,
    count_in_r002: countInParent,
    date_value: journalDateValue(operation.date),
    partner_range: partnerRange,
    reason:
      rowClass === "INACTIVE_DUPLICATE_HISTORY"
        ? "Неактивная история дубля; исключена из итогов."
        : rowClass === "LINKED_STORNO"
          ? "Связанная активная строка STORNO существующей пары; в R008 не входит."
          : "Точная строка ERP-журнала, составляющая сумму статьи.",
    comment: pairComment,
  };
}

function verifyContributor(actual, expected, defaults, tolerance) {
  const details = { physical_row: expected.physical_row };
  requireEqual(actual.source_row_id, expected.source_row_id, "BLOCKED_SOURCE_ROW_KEY_DRIFT", "source_row_id", details);
  requireEqual(actual.date, expected.date, "BLOCKED_CONTRIBUTOR_DRIFT", "date", details);
  requireEqual(actual.document, expected.document, "BLOCKED_CONTRIBUTOR_DRIFT", "document", details);
  requireEqual(actual.posting_no, expected.posting_no, "BLOCKED_CONTRIBUTOR_DRIFT", "posting_no", details);
  requireEqual(actual.activity, defaults.activity, "BLOCKED_CONTRIBUTOR_DRIFT", "activity", details);
  requireEqual(actual.scenario, defaults.scenario, "BLOCKED_CONTRIBUTOR_DRIFT", "scenario", details);
  requireEqual(actual.debit, defaults.debit, "BLOCKED_CONTRIBUTOR_DRIFT", "debit", details);
  requireEqual(actual.debit_analytics[0] ?? "", expected.article, "BLOCKED_CONTRIBUTOR_DRIFT", "debit article", details);
  requireEqual(actual.article, expected.article, "BLOCKED_CONTRIBUTOR_DRIFT", "article", details);
  requireEqual(actual.organization, expected.organization, "BLOCKED_CONTRIBUTOR_DRIFT", "organization", details);
  requireEqual(actual.debit_department, expected.debit_department, "BLOCKED_CONTRIBUTOR_DRIFT", "debit_department", details);
  requireEqual(actual.credit, expected.credit, "BLOCKED_CONTRIBUTOR_DRIFT", "credit", details);
  requireArray(actual.credit_analytics, expected.credit_analytics, "BLOCKED_CONTRIBUTOR_DRIFT", "credit_analytics", details);
  requireEqual(actual.credit_department, expected.credit_department, "BLOCKED_CONTRIBUTOR_DRIFT", "credit_department", details);
  requireEqual(actual.disclosure, defaults.disclosure, "BLOCKED_CONTRIBUTOR_DRIFT", "disclosure", details);
  requireEqual(actual.analytics3, defaults.analytics3, "BLOCKED_CONTRIBUTOR_DRIFT", "analytics3", details);
  requireAmount(actual.amount_accounting, expected.amount, tolerance, "BLOCKED_CONTRIBUTOR_DRIFT", "accounting amount", details);
  requireAmount(actual.amount, expected.amount, tolerance, "BLOCKED_CONTRIBUTOR_DRIFT", "reporting amount", details);
}

function verifyPairRow(actual, expected, defaults, tolerance) {
  const details = { physical_row: expected.physical_row };
  requireEqual(actual.activity, expected.activity, "BLOCKED_PAIR_DRIFT", "pair activity", details);
  requireEqual(actual.posting_no, expected.posting_no, "BLOCKED_PAIR_DRIFT", "pair posting_no", details);
  requireEqual(actual.article, expected.article, "BLOCKED_PAIR_DRIFT", "pair article", details);
  requireAmount(actual.amount, expected.amount, tolerance, "BLOCKED_PAIR_DRIFT", "pair amount", details);
  requireAmount(actual.amount_accounting, expected.amount, tolerance, "BLOCKED_PAIR_DRIFT", "pair accounting amount", details);
  requireEqual(actual.scenario, defaults.scenario, "BLOCKED_PAIR_DRIFT", "pair scenario", details);
  requireEqual(actual.debit, defaults.debit, "BLOCKED_PAIR_DRIFT", "pair debit", details);
  const derivedRole = actual.amount < 0 ? "STORNO" : "REPOST";
  requireEqual(derivedRole, expected.role, "BLOCKED_PAIR_DRIFT", "pair role", details);
}

function sumByParent(contributors) {
  const result = {};
  for (const row of contributors) result[row.parent_code] = (result[row.parent_code] ?? 0) + cents(row.amount);
  result.R002 = Object.values(result).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value / 100]));
}

function verifyLeafTotals(actual, expected, tolerance) {
  requireArray(Object.keys(actual).sort(), Object.keys(expected).sort(), "BLOCKED_LEAF_TOTAL_DRIFT", "leaf total keys");
  for (const [code, expectedAmount] of Object.entries(expected)) {
    requireAmount(actual[code], expectedAmount, tolerance, "BLOCKED_LEAF_TOTAL_DRIFT", `leaf total ${code}`, { code });
  }
}

function requiredEntries(fixture) {
  return {
    journal: {
      name: fixture.source_pins.erp_journal_entry,
      sha256: fixture.source_pins.erp_journal_sha256,
    },
    opiu: {
      name: fixture.source_pins.erp_opiu_entry,
      sha256: fixture.source_pins.erp_opiu_sha256,
    },
    passport: {
      name: fixture.source_pins.erp_passport_entry,
      sha256: fixture.source_pins.erp_passport_sha256,
    },
  };
}

function verifyPinnedBuffers(buffers, entryTrace, fixture) {
  for (const [key, pin] of Object.entries(requiredEntries(fixture))) {
    const buffer = buffers[key];
    if (!Buffer.isBuffer(buffer)) {
      blocked("BLOCKED_ENTRY_NAME_DRIFT", `Required ERP entry is missing: ${pin.name}`, {
        entry_role: key,
        expected_entry: pin.name,
      });
    }
    const actualSha = sha256(buffer);
    requireEqual(actualSha, pin.sha256, "BLOCKED_INNER_HASH_DRIFT", `${key} SHA256`, {
      entry_role: key,
      entry: pin.name,
    });
    entryTrace[key] = { entry: pin.name, sha256: actualSha, bytes: buffer.length };
  }
  try {
    JSON.parse(buffers.passport.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    blocked("BLOCKED_PASSPORT_PARSE_ERROR", `Pinned ERP passport is not valid JSON: ${error.message}`);
  }
}

async function verifyOuterZip(outerBuffer, fixture, { requireOuterHash = true } = {}) {
  const actualOuterSha = sha256(outerBuffer);
  if (requireOuterHash) {
    requireEqual(actualOuterSha, fixture.source_pins.erp_zip_sha256, "BLOCKED_OUTER_HASH_DRIFT", "outer ZIP SHA256");
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(outerBuffer);
  } catch (error) {
    blocked("BLOCKED_OUTER_ZIP_PARSE_ERROR", `Cannot parse ERP ZIP: ${error.message}`);
  }
  const pins = requiredEntries(fixture);
  const buffers = {};
  const trace = {};
  for (const [key, pin] of Object.entries(pins)) {
    const entry = zip.file(pin.name);
    if (!entry || entry.dir) {
      blocked("BLOCKED_ENTRY_NAME_DRIFT", `Required ERP ZIP entry not found: ${pin.name}`, {
        entry_role: key,
        expected_entry: pin.name,
      });
    }
    const buffer = await entry.async("nodebuffer");
    buffers[key] = buffer;
  }
  verifyPinnedBuffers(buffers, trace, fixture);
  return {
    container_verified: requireOuterHash,
    container_status: requireOuterHash
      ? "PASS_OUTER_ZIP_SHA256"
      : "DIAGNOSTIC_REPACKED_PINNED_INNER_SET_OUTER_SHA_NOT_AUTHORITATIVE",
    outer_sha256: actualOuterSha,
    entry_names: Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort(),
    buffers,
    trace,
  };
}

async function verifyPinnedExtractedSet(directoryPath, fixture, lock) {
  const diagnostic = lock.diagnostic_extracted_set;
  if (!diagnostic || diagnostic.allowed_use !== "DEVELOPMENT_AND_REPORT_ONLY_QA") {
    blocked("BLOCKED_DIAGNOSTIC_SOURCE_LOCK", "Pinned diagnostic extracted-set contract is missing");
  }
  const actualPath = path.resolve(directoryPath);
  const expectedPath = path.resolve(diagnostic.path);
  requireEqual(
    actualPath.toLocaleLowerCase("ru-RU"),
    expectedPath.toLocaleLowerCase("ru-RU"),
    "BLOCKED_DIAGNOSTIC_PATH_DRIFT",
    "diagnostic extracted-set path",
  );
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(actualPath, { withFileTypes: true });
  } catch (error) {
    blocked("BLOCKED_SOURCE_NOT_FOUND", `Pinned extracted ERP set cannot be read: ${actualPath}`, {
      erp_path: actualPath,
      cause: error.code ?? error.message,
    });
  }
  const fileNames = directoryEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const pins = requiredEntries(fixture);
  const buffers = {};
  const trace = {};
  for (const [key, pin] of Object.entries(pins)) {
    if (!fileNames.includes(pin.name)) {
      blocked("BLOCKED_ENTRY_NAME_DRIFT", `Required extracted ERP file not found: ${pin.name}`, {
        entry_role: key,
        expected_entry: pin.name,
      });
    }
    buffers[key] = await fs.readFile(path.join(actualPath, pin.name));
  }
  verifyPinnedBuffers(buffers, trace, fixture);
  const allHashes = [];
  for (const fileName of fileNames) {
    const buffer = await fs.readFile(path.join(actualPath, fileName));
    allHashes.push({ entry: fileName, sha256: sha256(buffer), bytes: buffer.length });
  }
  for (const [label, expectedHash] of [
    ["OSV", diagnostic.osv_sha256],
    ["export log", diagnostic.export_log_sha256],
    ["passport", diagnostic.passport_sha256],
  ]) {
    if (!allHashes.some((entry) => entry.sha256 === expectedHash)) {
      blocked("BLOCKED_DIAGNOSTIC_INNER_SET_DRIFT", `Pinned extracted ${label} hash is absent`, {
        expected_sha256: expectedHash,
      });
    }
  }
  return {
    container_verified: false,
    container_status: diagnostic.status,
    outer_sha256: null,
    entry_names: fileNames,
    buffers,
    trace,
    all_hashes: allHashes,
  };
}

export async function loadR002OperationEvidence(options = {}) {
  const input = normalizedInputs(options);
  try {
    try {
      await Promise.all([fs.access(SOURCE_LOCK_PATH), fs.access(FIXTURE_PATH)]);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const result = baseResult(
          "NOT_APPLICABLE_LEGACY_R002_QA_NOT_PACKAGED",
          false,
          input,
        );
        result.note =
          "Legacy pinned July QA files are optional and are not a runtime dependency. Current-source journal evidence is handled by the generic operation reader.";
        return result;
      }
      throw error;
    }
    const { lock, fixture } = await readPinnedJson();
    const applicable =
      input.mode === lock.mode &&
      input.period === lock.period &&
      input.organization === lock.organization;
    if (!applicable) {
      const result = baseResult("NOT_APPLICABLE", false, input);
      result.expected_scope = {
        mode: lock.mode,
        period: lock.period,
        organization: lock.organization,
      };
      return result;
    }
    if (!input.erpPath) blocked("BLOCKED_SOURCE_PATH_REQUIRED", "erpPath is required for pinned R002 evidence");

    let sourceStat;
    try {
      sourceStat = await fs.stat(input.erpPath);
    } catch (error) {
      blocked("BLOCKED_SOURCE_NOT_FOUND", `Pinned ERP ZIP cannot be read: ${input.erpPath}`, {
        erp_path: input.erpPath,
        cause: error.code ?? error.message,
      });
    }
    let sourcePackage;
    if (sourceStat.isDirectory()) {
      if (!input.diagnosticExtractedSet) {
        blocked(
          "BLOCKED_SOURCE_CONTAINER_REQUIRED",
          "Extracted ERP directory is allowed only with the explicit diagnosticExtractedSet report-only flag",
          { erp_path: input.erpPath },
        );
      }
      sourcePackage = await verifyPinnedExtractedSet(input.erpPath, fixture, lock);
    } else if (sourceStat.isFile()) {
      sourcePackage = await verifyOuterZip(await fs.readFile(input.erpPath), fixture, {
        requireOuterHash: !input.diagnosticExtractedSet,
      });
    } else {
      blocked("BLOCKED_SOURCE_TYPE", `Unsupported ERP source type: ${input.erpPath}`);
    }

    const journal = await loadWorksheetFromXlsx(sourcePackage.buffers.journal, fixture.journal_expected.sheet);
    requireEqual(journal.dimension, fixture.journal_expected.observed_ooxml_dimension, "BLOCKED_JOURNAL_DIMENSION_DRIFT", "journal OOXML dimension");
    requireEqual(lock.erp_journal.ooxml_dimension_ignored, journal.dimension, "BLOCKED_JOURNAL_DIMENSION_DRIFT", "ignored OOXML dimension pin");
    verifyHeaders(journal.rows);

    const logicalStart = 5;
    const logicalEnd = 1201;
    const datePattern = /^\d{2}\.\d{2}\.\d{4}(?:\s|$)/;
    const datedRowsAll = [...journal.rows.entries()].filter(([, cells]) => datePattern.test(textValue(cells.get("B"))));
    const logicalRows = datedRowsAll.filter(([row]) => row >= logicalStart && row <= logicalEnd);
    requireEqual(datedRowsAll.length, fixture.journal_expected.dated_row_count, "BLOCKED_JOURNAL_COUNT_DRIFT", "dated journal rows");
    requireEqual(logicalRows.length, fixture.journal_expected.dated_row_count, "BLOCKED_JOURNAL_RANGE_DRIFT", "logical dated journal rows");
    const factRows = logicalRows.filter(([, cells]) => textValue(cells.get("AB")) === "Факт");
    const activeRows = factRows.filter(([, cells]) => textValue(cells.get("F")) === "Да");
    const inactiveRows = factRows.filter(([, cells]) => textValue(cells.get("F")) === "Нет");
    requireEqual(factRows.length, fixture.journal_expected.scenario_fact_count, "BLOCKED_JOURNAL_COUNT_DRIFT", "Fact rows");
    requireEqual(activeRows.length, fixture.journal_expected.active_count, "BLOCKED_JOURNAL_COUNT_DRIFT", "active rows");
    requireEqual(inactiveRows.length, fixture.journal_expected.inactive_count, "BLOCKED_JOURNAL_COUNT_DRIFT", "inactive rows");
    requireEqual(activeRows.length + inactiveRows.length, factRows.length, "BLOCKED_ACTIVITY_DOMAIN_DRIFT", "active plus inactive rows");

    const tolerance = fixture.tolerance;
    const contributorRows = fixture.contributors.map((expected) => {
      const actual = operationFromRow(journal.rows, expected.physical_row, fixture.source_pins.erp_journal_sha256, fixture.journal_expected.sheet);
      verifyContributor(actual, expected, fixture.contributor_defaults, tolerance);
      const row = {
        ...actual,
        parent_code: expected.parent_code,
        pair_id: expected.pair_id ?? null,
        upload_id: expected.upload_id ?? null,
        pair_role: expected.pair_role ?? null,
        pair_status: expected.pair_id ? fixture.existing_pair.derived_status : null,
        excluded_from_totals: false,
      };
      return {
        ...row,
        ...operationPresentationFields({
          operation: row,
          rowClass: "SOURCE_CONTRIBUTOR",
          parentCode: expected.parent_code,
          displayOrder: expected.physical_row === 1089 ? 1 : expected.physical_row,
          displayDepthOffset: 1,
          countInParent: true,
          partnerRange: expected.physical_row === 1089 ? "B1088:AG1088" : null,
        }),
      };
    });
    const actualLeafTotals = sumByParent(contributorRows);
    verifyLeafTotals(actualLeafTotals, fixture.leaf_totals, tolerance);

    const pairRows = fixture.existing_pair.entries.map((expected) => {
      const actual = operationFromRow(journal.rows, expected.physical_row, fixture.source_pins.erp_journal_sha256, fixture.journal_expected.sheet);
      verifyPairRow(actual, expected, fixture.contributor_defaults, tolerance);
      const row = {
        ...actual,
        pair_id: fixture.existing_pair.pair_id,
        upload_id: `${fixture.existing_pair.pair_id}:${expected.role}`,
        pair_role: expected.role,
        pair_status: fixture.existing_pair.derived_status,
        excluded_from_totals: !expected.count_in_r002,
      };
      const partnerRows = new Map([
        [1088, 1089],
        [1089, 1088],
        [1090, 1091],
        [1091, 1090],
        [1092, 1093],
        [1093, 1092],
      ]);
      const rowClass =
        expected.physical_row === 1089
          ? "SOURCE_CONTRIBUTOR"
          : expected.activity === "Да"
            ? "LINKED_STORNO"
            : "INACTIVE_DUPLICATE_HISTORY";
      const displayOrderByRow = new Map([
        [1089, 1],
        [1088, 2],
        [1090, 3],
        [1091, 4],
        [1092, 5],
        [1093, 6],
      ]);
      return {
        ...row,
        ...operationPresentationFields({
          operation: row,
          rowClass,
          parentCode: "R008",
          displayOrder: displayOrderByRow.get(expected.physical_row),
          displayDepthOffset: expected.physical_row === 1089 ? 1 : 2,
          countInParent: expected.count_in_r002,
          partnerRange: `B${partnerRows.get(expected.physical_row)}:AG${partnerRows.get(expected.physical_row)}`,
        }),
      };
    });
    const activePairRows = pairRows.filter((row) => row.activity === "Да");
    const inactivePairRows = pairRows.filter((row) => row.activity === "Нет");
    requireEqual(activePairRows.length, 2, "BLOCKED_PAIR_DRIFT", "active pair rows");
    requireEqual(inactivePairRows.length, 4, "BLOCKED_PAIR_DRIFT", "inactive pair rows");
    requireAmount(activePairRows.reduce((sum, row) => sum + row.amount, 0), fixture.existing_pair.active_net, tolerance, "BLOCKED_PAIR_DRIFT", "active pair net");
    requireAmount(pairRows.reduce((sum, row) => sum + row.amount, 0), 0, tolerance, "BLOCKED_PAIR_DRIFT", "all pair rows net");
    const inactiveUploadIdCounts = Object.fromEntries(
      [...new Set(inactivePairRows.map((row) => row.upload_id))].sort().map((uploadId) => [
        uploadId,
        inactivePairRows.filter((row) => row.upload_id === uploadId).length,
      ]),
    );
    requireArray(Object.values(inactiveUploadIdCounts).sort(), [2, 2], "BLOCKED_PAIR_DUPLICATE_DRIFT", "inactive duplicate UploadID counts");

    const ignoreActivityR008 = pairRows
      .filter((row) => row.pair_role === "REPOST")
      .reduce((sum, row) => sum + row.amount, 0);
    const ignoreActivityR002 = fixture.leaf_totals.R002 + ignoreActivityR008 - fixture.leaf_totals.R008;
    requireAmount(ignoreActivityR008, fixture.negative_test.ignore_activity_r008, tolerance, "BLOCKED_NEGATIVE_CONTROL_DRIFT", "ignore-activity R008");
    requireAmount(ignoreActivityR002, fixture.negative_test.ignore_activity_r002, tolerance, "BLOCKED_NEGATIVE_CONTROL_DRIFT", "ignore-activity R002");

    const opiu = await loadWorksheetFromXlsx(sourcePackage.buffers.opiu, "Лист_1");
    const opiuR002 = numericValue(cell(opiu.rows, 101, "C"));
    requireAmount(opiuR002, fixture.leaf_totals.R002, tolerance, "BLOCKED_ERP_OPIU_TOTAL_DRIFT", "ERP OPIU Лист_1!C101");

    const extraPairRows = pairRows.filter((row) => row.physical_row !== 1089);
    const displayRows = [...contributorRows, ...extraPairRows].sort((left, right) => left.physical_row - right.physical_row);
    requireEqual(displayRows.length, fixture.final_gates.display_operation_rows, "BLOCKED_DISPLAY_ROW_COUNT_DRIFT", "display operation rows");
    requireEqual(new Set(displayRows.map((row) => row.source_row_id)).size, displayRows.length, "BLOCKED_SOURCE_ROW_DUPLICATE", "unique display source rows");

    return {
      schema: RESULT_SCHEMA,
      status: sourcePackage.container_verified
        ? SUCCESS_STATUS
        : sourcePackage.outer_sha256
          ? "PASS_DIAGNOSTIC_REPACKED_PINNED_INNER_SET_OUTER_SHA_NOT_AUTHORITATIVE"
          : "PASS_DIAGNOSTIC_PINNED_INNER_SET_OUTER_CONTAINER_MISSING",
      applicable: true,
      input,
      fixture_id: fixture.fixture_id,
      period: fixture.period,
      organization: fixture.organization,
      mode: lock.mode,
      journal_entry: fixture.source_pins.erp_journal_entry,
      journal_sha256: fixture.source_pins.erp_journal_sha256,
      journal_sheet: fixture.journal_expected.sheet,
      source_contributor_rows: contributorRows.length,
      display_operation_rows: displayRows.length,
      new_pair_candidates: 0,
      correction_operation_rows: 0,
      posting_rows: 0,
      report_only: true,
      ready_to_upload: false,
      release_allowed: false,
      rows: displayRows,
      leaf_totals: actualLeafTotals,
      negative_control: {
        ignore_activity_r008: ignoreActivityR008,
        ignore_activity_r002: ignoreActivityR002,
        must_fail_if_activity_ignored: fixture.negative_test.must_fail,
      },
      pair: {
        pair_id: fixture.existing_pair.pair_id,
        status: fixture.existing_pair.derived_status,
        new_pair_candidate: false,
        active_net: activePairRows.reduce((sum, row) => sum + row.amount, 0),
        row_count: pairRows.length,
        active_rows: activePairRows.length,
        inactive_rows: inactivePairRows.length,
        inactive_duplicate_rows: inactivePairRows.length,
        inactive_upload_id_counts: inactiveUploadIdCounts,
      },
      counts: {
        journal_rows: logicalRows.length,
        fact_rows: factRows.length,
        active_rows: activeRows.length,
        inactive_rows: inactiveRows.length,
        source_contributor_rows: contributorRows.length,
        display_operation_rows: displayRows.length,
        existing_pair_rows: pairRows.length,
        existing_pair_active_rows: activePairRows.length,
        existing_pair_inactive_rows: inactivePairRows.length,
        duplicate_inactive_rows: inactivePairRows.length,
        new_pair_candidates: 0,
        correction_operation_rows: 0,
        posting_rows: 0,
      },
      gates: safeGates({
        source_verified: sourcePackage.container_verified,
        inner_files_verified: true,
        source_container_status: sourcePackage.container_status,
        report_only: fixture.final_gates.report_only,
        source_contributor_rows: contributorRows.length,
        display_operation_rows: displayRows.length,
        new_pair_candidates: fixture.final_gates.new_pair_candidates,
        correction_operation_rows: fixture.final_gates.correction_operation_rows,
        release_status: fixture.final_gates.release_status,
      }),
      source_trace: {
        outer_zip: {
          path: input.erpPath,
          sha256: sourcePackage.outer_sha256,
          status: sourcePackage.container_status,
          verified: sourcePackage.container_verified,
          entry_names: sourcePackage.entry_names,
        },
        entries: sourcePackage.trace,
        diagnostic_all_hashes: sourcePackage.all_hashes ?? null,
        journal: {
          sheet: fixture.journal_expected.sheet,
          worksheet_entry: journal.entry,
          header_range: lock.erp_journal.header_range,
          logical_data_range: lock.erp_journal.data_range,
          observed_ooxml_dimension: journal.dimension,
          ignored_ooxml_dimension: lock.erp_journal.ooxml_dimension_ignored,
        },
        erp_opiu: {
          sheet: "Лист_1",
          worksheet_entry: opiu.entry,
          cell: "C101",
          value: opiuR002,
        },
        source_lock_path: SOURCE_LOCK_PATH,
        fixture_path: FIXTURE_PATH,
      },
    };
  } catch (error) {
    return blockedResult(error, input);
  }
}
