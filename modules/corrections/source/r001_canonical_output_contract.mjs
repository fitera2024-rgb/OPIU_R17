import crypto from "node:crypto";

import {
  LOADER_A_AA_FIELDS,
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
} from "./r001_materialization_contract.mjs";
import { buildR001BusinessContent } from "./r001_business_content.mjs";

export const R001_CANONICAL_OUTPUT_SCHEMA = "opiu-r001-canonical-output.v1";

export class CanonicalOutputContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CanonicalOutputContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new CanonicalOutputContractError(code, message, details);
}

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

function moneyText(value) {
  return Number(value ?? 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function userIntalevSource(materializationCase) {
  const source = materializationCase?.intalev_source ?? {};
  const reconciliationRow = text(source.reconciliation_row)
    || text(materializationCase?.analytical_basis?.reconciliation_row)
    || text(materializationCase?.economic?.source_code);
  const path = text(source.path);
  const block = text(source.block);
  const reference = text(source.source_reference);
  const parts = [
    reconciliationRow ? `строка сверки ${reconciliationRow}` : "",
    path ? `путь «${path}»` : (block ? `блок «${block}»` : ""),
    source.amount !== null && source.amount !== undefined ? `итог строки Инталев ${moneyText(source.amount)}` : "",
    reference ? `ячейка/агрегат: ${reference}` : "",
  ].filter(Boolean);
  return `Источник Инталев: ${parts.length ? parts.join("; ") : "строка и путь указаны в доказательной сверке ОПИУ"}`;
}

function userLoaderContent(materializationCase, operation, source) {
  const evidence = materializationCase?.business_evidence ?? {};
  const reason = text(materializationCase?.reason)
    || (materializationCase?.output_route === "SPORNO"
      ? "требуется ручная проверка: физическая строка ERP не доказана однозначно"
      : "");
  return buildR001BusinessContent({
    operation,
    erp: {
      document: source?.document,
      date: source?.date,
      postingNumber: source?.posting_number || source?.posting_no,
      debit: source?.debit,
      credit: source?.credit,
      amount: materializationCase?.correction_amount,
      organization: source?.source_organization,
      debitDepartment: source?.debit_department,
      creditDepartment: source?.credit_department,
    },
    economic: {
      sourceArticle: materializationCase?.economic?.source_article,
      targetArticle: materializationCase?.economic?.target_article,
    },
    decision: evidence,
    reason,
    intalevDocumentNotPresented: evidence.intalev_document_absent === true
      && materializationCase?.source_scope?.relevant_intalev_absence_proven === true,
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Fingerprint(value) {
  return crypto.createHash("sha256").update(fingerprint(value)).digest("hex").toUpperCase();
}

function periodEndDate(period) {
  const match = text(period).match(/^(\d{4})-(\d{2})$/);
  if (!match) fail("INVALID_CANONICAL_OUTPUT_PERIOD", "Canonical output period must be one concrete YYYY-MM month", { period });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(lastDay).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

function safeOrganizationLabel(value) {
  return (text(value) || "ИСТОЧНИК НЕ ОПРЕДЕЛЕН")
    .replace(/[«»"„“]/g, " ")
    .replace(/[<>:/\\|?*]/g, "_")
    .trim();
}

function shortOrganizationLabel(value) {
  const safe = safeOrganizationLabel(value).replace(/\s+/g, "_");
  if (safe.length <= 24) return safe;
  const suffix = crypto.createHash("sha256").update(safe).digest("hex").slice(0, 6).toUpperCase();
  return `${safe.slice(0, 17)}_${suffix}`;
}

export function canonicalOutputFilename({ output_route: outputRoute, source_organization: sourceOrganization, period }) {
  const outputDate = periodEndDate(period);
  const organization = safeOrganizationLabel(sourceOrganization);
  const disputedSuffix = outputRoute === "SPORNO" ? "_СПОРНО" : "";
  return `[${organization}][${outputDate}]_ОПИУ_ГОТОВО${disputedSuffix}.xlsx`;
}

function revalidateCanonicalRow(row) {
  if (!row || row.schema_version !== "opiu-canonical-posting-row.v1") {
    fail("NONCANONICAL_FINANCIAL_ROW", "Final financial output accepts only CanonicalPostingRow objects");
  }
  if (!row.materialization_case) {
    fail("CANONICAL_CASE_CONTEXT_MISSING", "CanonicalPostingRow must retain its validated MaterializationCase context", {
      audit_identity: row.audit_identity,
    });
  }
  const validated = createCanonicalPostingRow({
    materialization_case: row.materialization_case,
    operation: row.operation,
    output_route: row.output_route,
    materialization_state: row.materialization_state,
    audit_identity: row.audit_identity,
    amount: row.amount,
    result_accounting: row.result_accounting,
    loader: row.loader,
    safety: row.safety,
  });
  if (!(["READY", "SPORNO"].includes(validated.output_route))) {
    fail("REVIEW_ONLY_FINANCIAL_ROW", "REVIEW_ONLY cannot enter a financial A:AA output", {
      audit_identity: validated.audit_identity,
      output_route: validated.output_route,
    });
  }
  return validated;
}

export function canonicalSpornoRowFromMaterializationCase(materializationCase) {
  const operation = text(materializationCase?.action).toUpperCase();
  if (materializationCase?.schema_version !== "opiu-materialization-case.v1") {
    fail("CANONICAL_CASE_REQUIRED", "SPORNO adapter requires a validated MaterializationCase");
  }
  if (materializationCase.output_route !== "SPORNO" || !["STORNO", "REPOST"].includes(operation)) {
    fail("SPORNO_DIRECTIONAL_CASE_REQUIRED", "Only explicit STORNO/REPOST MaterializationCase objects may enter the SPORNO adapter", {
      action: materializationCase.action,
      output_route: materializationCase.output_route,
    });
  }
  const source = materializationCase.physical_source;
  const resultAccounting = operation === "STORNO" ? {
    debit: source.debit,
    credit: source.credit,
    debit_analytics: source.debit_analytics,
    credit_analytics: source.credit_analytics,
    debit_department: source.debit_department,
    credit_department: source.credit_department,
    article: materializationCase.economic.source_article,
  } : materializationCase.target_accounting;
  const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, null]));
  const targetCode = text(materializationCase.economic.target_code);
  let targetRuleSide = "";
  if (operation === "REPOST" && targetCode) {
    const article = normalized(materializationCase.economic.target_article);
    const debitHasArticle = article && resultAccounting.debit_analytics.some((value) => normalized(value) === article);
    const creditHasArticle = article && resultAccounting.credit_analytics.some((value) => normalized(value) === article);
    if (debitHasArticle !== creditHasArticle) targetRuleSide = debitHasArticle ? "DEBIT" : "CREDIT";
    else {
      const debitChanged = JSON.stringify(resultAccounting.debit_analytics) !== JSON.stringify(source.debit_analytics)
        || text(resultAccounting.debit) !== text(source.debit);
      const creditChanged = JSON.stringify(resultAccounting.credit_analytics) !== JSON.stringify(source.credit_analytics)
        || text(resultAccounting.credit) !== text(source.credit);
      if (debitChanged !== creditChanged) targetRuleSide = debitChanged ? "DEBIT" : "CREDIT";
    }
  }
  Object.assign(loader, {
    "СчетДт": resultAccounting.debit || null,
    "СчетКт": resultAccounting.credit || null,
    "ВидОперации": operation,
    "ПодразделениеДт": resultAccounting.debit_department || null,
    "ПодразделениеКт": resultAccounting.credit_department || null,
    "СуммаВВалютеУчета": materializationCase.correction_amount,
    "СуммаВВалютеОтчетности": materializationCase.correction_amount,
    "Содержание": userLoaderContent(materializationCase, operation, source),
    "СчетДтИсточник": source.debit || null,
    "СчетКтИсточник": source.credit || null,
    "ИдентификаторФинЗаписи": source.source_row_id || null,
    "ПравилоДт": targetRuleSide === "DEBIT" ? targetCode : null,
    "ПравилоКт": targetRuleSide === "CREDIT" ? targetCode : null,
    "СубконтоДт1": resultAccounting.debit_analytics[0] || null,
    "СубконтоДт2": resultAccounting.debit_analytics[1] || null,
    "СубконтоДт3": resultAccounting.debit_analytics[2] || null,
    "СубконтоКт1": resultAccounting.credit_analytics[0] || null,
    "СубконтоКт2": resultAccounting.credit_analytics[1] || null,
    "СубконтоКт3": resultAccounting.credit_analytics[2] || null,
  });
  const auditIdentity = `R001-SPORNO-${crypto.createHash("sha256").update(JSON.stringify([
    materializationCase.case_id,
    materializationCase.pair_id,
    materializationCase.role,
    operation,
    source.source_row_id,
    materializationCase.correction_amount,
  ])).digest("hex").slice(0, 24).toUpperCase()}`;
  return createCanonicalPostingRow({
    materialization_case: materializationCase,
    operation,
    output_route: "SPORNO",
    materialization_state: "MATERIALIZED_SPORNO",
    audit_identity: auditIdentity,
    amount: materializationCase.correction_amount,
    result_accounting: resultAccounting,
    loader,
    safety: REPORT_ONLY_SAFETY,
  });
}

function registryRow(row) {
  const materializationCase = row.materialization_case;
  return Object.freeze({
    audit_identity: row.audit_identity,
    case_id: row.case_id,
    pair_id: row.pair_id,
    operation: row.operation,
    period: row.period,
    reconciliation_organization: row.reconciliation_organization,
    source_organization: row.source_organization,
    source_row_id: row.source.source_row_id,
    source_archive_path: row.source.source_archive_path,
    source_archive_sha256: row.source.source_archive_sha256,
    journal_entry: row.source.journal_entry,
    journal_sha256: row.source.journal_sha256,
    source_sheet: row.source.source_sheet,
    source_range: row.source.source_range,
    source_date: row.source.date,
    document: row.source.document,
    posting_number: row.source.posting_number,
    output_route: row.output_route,
    materialization_state: row.materialization_state,
    proof_status: row.proof_status,
    correction_allowed: row.correction_allowed,
    correction_authority: row.correction_authority,
    amount: row.amount,
    reason: materializationCase.reason,
    blockers: Object.freeze([...(materializationCase.blockers ?? [])]),
    loader: Object.freeze({ ...row.loader }),
    loader_values: Object.freeze([...row.loader_values]),
  });
}

function sortRows(rows) {
  const operationOrder = (value) => text(value).toUpperCase() === "STORNO" ? "0" : "1";
  return [...rows].sort((left, right) => [
    left.output_route,
    left.source_organization,
    left.period,
    left.pair_id,
    operationOrder(left.operation),
    left.case_id,
    left.source.source_row_id,
    left.audit_identity,
  ].join("\u0000").localeCompare([
    right.output_route,
    right.source_organization,
    right.period,
    right.pair_id,
    operationOrder(right.operation),
    right.case_id,
    right.source.source_row_id,
    right.audit_identity,
  ].join("\u0000"), "en"));
}

function assertBalancedCorrectionPairs(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const pairId = text(row.pair_id);
    if (!byPair.has(pairId)) byPair.set(pairId, []);
    byPair.get(pairId).push(row);
  }
  for (const [pairId, pairRows] of byPair) {
    const operations = new Set(pairRows.map((row) => text(row.operation).toUpperCase()));
    const explicitlyPaired = operations.has("STORNO") && operations.has("REPOST")
      || pairRows.some((row) => text(row.materialization_case?.action).toUpperCase() === "STORNO_REPOST");
    if (!explicitlyPaired) continue;

    const stornoCents = pairRows
      .filter((row) => row.operation === "STORNO")
      .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    const repostCents = pairRows
      .filter((row) => row.operation === "REPOST")
      .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    const signedTotalCents = repostCents - stornoCents;
    if (stornoCents <= 0 || repostCents <= 0 || stornoCents !== repostCents || signedTotalCents !== 0) {
      const serviceHandoffQuarantine = pairRows.every((row) => row.output_route === "SPORNO"
        && row.materialization_case?.blockers?.some((blocker) => text(blocker).startsWith("SERVICE_HANDOFF_")));
      if (serviceHandoffQuarantine) continue;
      fail("UNBALANCED_CORRECTION_PAIR", "Paired correction requires equal absolute STORNO/REPOST amounts and zero signed total", {
        pair_id: pairId,
        storno_cents: stornoCents,
        repost_cents: repostCents,
        signed_total_cents: signedTotalCents,
      });
    }
  }
}

export function collectCanonicalFinancialOutput(rows = [], { filenameForRow = canonicalOutputFilename } = {}) {
  if (!Array.isArray(rows)) fail("INVALID_CANONICAL_ROW_SET", "Canonical output input must be an array");
  if (typeof filenameForRow !== "function") fail("INVALID_FILENAME_ROUTER", "filenameForRow must be a function");
  const byIdentity = new Map();
  const exactDuplicateIdentities = [];
  for (const candidate of rows) {
    const row = revalidateCanonicalRow(candidate);
    const identity = row.audit_identity;
    const payload = fingerprint(row);
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, { row, payload });
      continue;
    }
    if (previous.payload !== payload) {
      fail("CONFLICTING_CANONICAL_AUDIT_IDENTITY", "Duplicate canonical audit identity has conflicting payloads", {
        audit_identity: identity,
      });
    }
    exactDuplicateIdentities.push(identity);
  }

  const canonicalRows = Object.freeze(sortRows([...byIdentity.values()].map((item) => item.row)));
  const physicalSourcePairs = new Map();
  for (const row of canonicalRows) {
    if (!text(row.source?.source_row_id)) continue;
    const sourceKey = [
      row.source.source_archive_sha256,
      row.source.journal_sha256,
      row.source.source_sheet,
      row.source.source_range,
      row.source.source_row_id,
    ].map(text).join("\u0000");
    const previousPair = physicalSourcePairs.get(sourceKey);
    if (previousPair && previousPair !== row.pair_id) {
      fail("PHYSICAL_SOURCE_REUSED_ACROSS_PAIRS", "One physical ERP row cannot be materialized in more than one correction pair", {
        source_row_id: row.source.source_row_id,
        first_pair_id: previousPair,
        second_pair_id: row.pair_id,
      });
    }
    physicalSourcePairs.set(sourceKey, row.pair_id);
  }
  assertBalancedCorrectionPairs(canonicalRows);
  const canonicalRowSetSha256 = sha256Fingerprint(canonicalRows);
  const groupsByKey = new Map();
  for (const row of canonicalRows) {
    const destinationFilename = text(filenameForRow(row));
    if (!destinationFilename) fail("CANONICAL_DESTINATION_MISSING", "Canonical output destination filename is required", { audit_identity: row.audit_identity });
    const key = [row.output_route, row.source_organization, row.period, destinationFilename].join("\u0000");
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        output_route: row.output_route,
        source_organization: row.source_organization,
        period: row.period,
        destination_filename: destinationFilename,
        rows: [],
      });
    }
    groupsByKey.get(key).rows.push(row);
  }
  const groups = Object.freeze([...groupsByKey.values()]
    .sort((left, right) => [left.output_route, left.destination_filename].join("\u0000")
      .localeCompare([right.output_route, right.destination_filename].join("\u0000"), "en"))
    .map((group) => Object.freeze({ ...group, rows: Object.freeze(group.rows) })));
  const destinationKeys = groups.map((group) => [group.output_route, group.destination_filename].join("\u0000"));
  if (new Set(destinationKeys).size !== destinationKeys.length) {
    fail("CANONICAL_DESTINATION_COLLISION", "Different canonical source groups resolve to the same output filename");
  }
  const registryRows = Object.freeze(canonicalRows.map(registryRow));
  const readyRows = canonicalRows.filter((row) => row.output_route === "READY");
  const spornoRows = canonicalRows.filter((row) => row.output_route === "SPORNO");
  const counters = Object.freeze({
    canonical_financial_rows_total: canonicalRows.length,
    ready_financial_rows: readyRows.length,
    sporno_financial_rows: spornoRows.length,
    storno_rows: canonicalRows.filter((row) => row.operation === "STORNO").length,
    repost_rows: canonicalRows.filter((row) => row.operation === "REPOST").length,
    ready_financial_workbooks: groups.filter((group) => group.output_route === "READY").length,
    sporno_financial_workbooks: groups.filter((group) => group.output_route === "SPORNO").length,
    exact_duplicate_rows_suppressed: exactDuplicateIdentities.length,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
  });
  return Object.freeze({
    schema_version: R001_CANONICAL_OUTPUT_SCHEMA,
    headers: LOADER_A_AA_FIELDS,
    rows: canonicalRows,
    canonical_row_set_sha256: canonicalRowSetSha256,
    groups,
    registry_rows: registryRows,
    exact_duplicate_identities: Object.freeze(exactDuplicateIdentities),
    counters,
    safety: REPORT_ONLY_SAFETY,
  });
}

function uniqueIdentityMap(items, identityField, conflictCode) {
  const result = new Map();
  for (const item of items) {
    const identity = text(item?.[identityField]);
    if (!identity) fail("OUTPUT_IDENTITY_MISSING", `${identityField} is required`);
    if (result.has(identity)) fail(conflictCode, `${identityField} must appear exactly once`, { audit_identity: identity });
    result.set(identity, item);
  }
  return result;
}

export function verifyCanonicalOutputIntegrity(output, { workbook_records: workbookRecords = [], registry_rows: registryRows = output?.registry_rows ?? [] } = {}) {
  if (output?.schema_version !== R001_CANONICAL_OUTPUT_SCHEMA) fail("INVALID_CANONICAL_OUTPUT", "Canonical output plan is required");
  const expectedRowSetSha256 = sha256Fingerprint(output.rows);
  if (!/^[A-F0-9]{64}$/.test(text(output.canonical_row_set_sha256))
    || output.canonical_row_set_sha256 !== expectedRowSetSha256) {
    fail("CANONICAL_ROW_SET_HASH_MISMATCH", "Canonical row-set SHA-256 is missing or differs from the canonical rows", {
      expected: expectedRowSetSha256,
      actual: output.canonical_row_set_sha256 ?? null,
    });
  }
  const expected = uniqueIdentityMap(output.rows, "audit_identity", "DUPLICATE_EXPECTED_CANONICAL_ROW");
  const expectedWorkbookKeys = new Set(output.groups.map((group) => [
    group.output_route,
    group.source_organization,
    group.period,
    group.destination_filename,
  ].join("\u0000")));
  const actualWorkbookKeys = workbookRecords.map((workbook) => [
    workbook.output_route,
    workbook.source_organization,
    workbook.period,
    workbook.destination_filename,
  ].join("\u0000"));
  if (new Set(actualWorkbookKeys).size !== actualWorkbookKeys.length) {
    fail("CANONICAL_DESTINATION_WRITTEN_MORE_THAN_ONCE", "Each canonical destination workbook must be written exactly once");
  }
  if (actualWorkbookKeys.length !== expectedWorkbookKeys.size
    || actualWorkbookKeys.some((key) => !expectedWorkbookKeys.has(key))) {
    fail("CANONICAL_WORKBOOK_SET_MISMATCH", "Written workbook destinations do not equal the canonical grouped destinations");
  }
  const workbookRows = workbookRecords.flatMap((workbook) => (workbook.rows ?? []).map((row) => ({
    ...row,
    output_route: workbook.output_route,
    source_organization: workbook.source_organization,
    period: workbook.period,
    destination_filename: workbook.destination_filename,
  })));
  const actualWorkbook = uniqueIdentityMap(workbookRows, "audit_identity", "CANONICAL_ROW_WRITTEN_MORE_THAN_ONCE");
  const actualRegistry = uniqueIdentityMap(registryRows, "audit_identity", "CANONICAL_REGISTRY_ROW_DUPLICATED");
  for (const [identity, row] of expected) {
    const written = actualWorkbook.get(identity);
    if (!written) fail("CANONICAL_ROW_NOT_WRITTEN", "Canonical financial row is absent from READY/SPORNO workbook output", { audit_identity: identity });
    if (fingerprint(written.loader_values) !== fingerprint(row.loader_values)) {
      fail("CANONICAL_LOADER_VALUES_DRIFT", "Written A:AA values differ from CanonicalPostingRow.loader_values", { audit_identity: identity });
    }
    for (const field of ["output_route", "source_organization", "period"]) {
      if (text(written[field]) !== text(row[field])) fail("CANONICAL_GROUP_IDENTITY_DRIFT", `Workbook ${field} differs from canonical row`, { audit_identity: identity, field });
    }
    const registered = actualRegistry.get(identity);
    if (!registered) fail("CANONICAL_REGISTRY_ROW_MISSING", "Canonical financial row is absent from registry/audit", { audit_identity: identity });
    if (fingerprint(registered) !== fingerprint(registryRow(row))) {
      fail("CANONICAL_REGISTRY_ROW_DRIFT", "Registry/audit representation differs from the canonical financial row", { audit_identity: identity });
    }
  }
  if (actualWorkbook.size !== expected.size) fail("UNEXPECTED_WORKBOOK_FINANCIAL_ROW", "Workbook contains a row outside the canonical row set");
  if (actualRegistry.size !== expected.size) fail("UNEXPECTED_REGISTRY_FINANCIAL_ROW", "Registry contains a row outside the canonical row set");
  const workbookCount = workbookRecords.reduce((sum, item) => sum + (item.rows?.length ?? 0), 0);
  if (workbookCount !== output.counters.canonical_financial_rows_total) {
    fail("CANONICAL_OUTPUT_COUNT_MISMATCH", "Workbook row count does not reconcile to canonical row count");
  }
  return Object.freeze({
    result: "PASS",
    canonical_financial_rows_total: expected.size,
    workbook_financial_rows: actualWorkbook.size,
    registry_financial_rows: actualRegistry.size,
    canonical_row_set_sha256: expectedRowSetSha256,
    ...REPORT_ONLY_SAFETY,
    safety: REPORT_ONLY_SAFETY,
  });
}
