import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  LOADER_A_AA_FIELDS,
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import {
  relevantIntalevAbsenceProof,
} from "../../reconciliation/source/intalev_source_scope.mjs";
import { buildR001BusinessContent } from "./r001_business_content.mjs";

export const R001_STANDALONE_STORNO_SCHEMA =
  "opiu-r001-standalone-storno-materialization.v1";

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) { return text(value).toUpperCase(); }

function cents(value) {
  const numeric = typeof value === "number" ? value : Number(text(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function unique(values) { return [...new Set(values.map(text).filter(Boolean))]; }

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function stableId(prefix, values) {
  const digest = sha256(Buffer.from(JSON.stringify(values), "utf8"));
  return `${prefix}-${digest.slice(0, 24)}`;
}

function sourceSlots(row, side) {
  return [1, 2, 3].map((index) => text(row?.[`${side}_analytics_${index}`]));
}

function isClosingAccount(value) {
  const account = text(value);
  return account === "99" || account.startsWith("99.");
}

function economicDirectionProven(decision) {
  return decision?.ECONOMIC_STORNO_DIRECTION_PROVEN === true
    || decision?.economic_storno_direction_proven === true
    || decision?.ECONOMIC_ROUTE_PROVEN === true
    || decision?.economic_route_proven === true;
}

function standaloneEligibility(decision) {
  const materializationCase = decision?.materialization_case;
  const blockers = [];
  if (!materializationCase || materializationCase.schema_version !== "opiu-materialization-case.v1") {
    blockers.push("CANONICAL_MATERIALIZATION_CASE_REQUIRED");
    return blockers;
  }
  if (upper(materializationCase.action) !== "STORNO" || upper(materializationCase.role) !== "STANDALONE") {
    blockers.push("EXPLICIT_STANDALONE_STORNO_REQUIRED");
  }
  if (upper(decision?.classification) !== "ERP_ONLY") blockers.push("GENUINE_ERP_ONLY_CLASSIFICATION_REQUIRED");
  const upstreamAbsenceProof = relevantIntalevAbsenceProof(decision);
  if (!upstreamAbsenceProof.proven) {
    blockers.push("GENUINE_INTALEV_ABSENCE_NOT_PROVEN", ...upstreamAbsenceProof.blockers);
  }
  const canonicalAbsenceProof = relevantIntalevAbsenceProof(materializationCase.source_scope);
  if (!canonicalAbsenceProof.proven) {
    blockers.push("CANONICAL_INTALEV_ABSENCE_AUTHORITY_NOT_PROVEN", ...canonicalAbsenceProof.blockers);
  }
  if (!economicDirectionProven(decision)) blockers.push("ECONOMIC_STORNO_DIRECTION_NOT_PROVEN");
  if ((cents(materializationCase.signed_economic_effect) ?? 0) >= 0) blockers.push("STORNO_EFFECT_SIGN_NOT_PROVEN");
  if ((cents(materializationCase.correction_amount) ?? 0) <= 0) blockers.push("NONPOSITIVE_CORRECTION_AMOUNT");
  return unique(blockers);
}

function exactPhysicalClaimComplete(source) {
  const required = [
    source?.source_organization,
    source?.source_archive_path,
    source?.source_archive_sha256,
    source?.journal_entry,
    source?.journal_sha256,
    source?.source_sheet,
    source?.source_range,
    source?.source_row_id,
    source?.date,
    source?.document,
    source?.posting_number,
    source?.debit,
    source?.credit,
    source?.debit_department,
    source?.credit_department,
    source?.activity,
    source?.scenario,
  ];
  return required.every((value) => text(value))
    && /^[A-F0-9]{64}$/i.test(text(source?.source_archive_sha256))
    && /^[A-F0-9]{64}$/i.test(text(source?.journal_sha256))
    && Array.isArray(source?.debit_analytics)
    && source.debit_analytics.length === 3
    && source.debit_analytics.every((value) => text(value))
    && Array.isArray(source?.credit_analytics)
    && source.credit_analytics.length === 3
    && source.credit_analytics.every((value) => text(value))
    && cents(source?.amount) !== null;
}

function rowNumber(sourceRange) {
  const match = text(sourceRange).match(/^B(\d+):AG\1$/i);
  return match ? Number(match[1]) : null;
}

async function reopenPinnedSource({ materialization_case: materializationCase }) {
  const source = materializationCase.physical_source;
  const archivePath = path.resolve(source.source_archive_path);
  const archiveBuffer = await fs.readFile(archivePath);
  const archiveSha256 = sha256(archiveBuffer);
  if (archiveSha256 !== upper(source.source_archive_sha256)) {
    const error = new Error(`Pinned ERP archive SHA mismatch: ${archiveSha256}`);
    error.code = "PINNED_ARCHIVE_HASH_MISMATCH";
    throw error;
  }
  let journalBuffer = archiveBuffer;
  let journalEntry = text(source.journal_entry);

  if (!/\.xlsx$/i.test(archivePath)) {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(archiveBuffer);
    const entry = zip.file(journalEntry);
    if (!entry) {
      const error = new Error(`Pinned journal entry is absent: ${journalEntry}`);
      error.code = "PINNED_JOURNAL_ENTRY_MISSING";
      throw error;
    }
    journalBuffer = await entry.async("nodebuffer");
  } else {
    const expectedName = path.basename(archivePath);
    if (path.basename(journalEntry) !== expectedName) {
      const error = new Error(`Direct XLSX journal entry mismatch: ${journalEntry} != ${expectedName}`);
      error.code = "PINNED_JOURNAL_ENTRY_MISMATCH";
      throw error;
    }
    journalEntry = expectedName;
  }

  const journalSha256 = sha256(journalBuffer);
  if (journalSha256 !== upper(source.journal_sha256)) {
    const error = new Error(`Pinned ERP journal SHA mismatch: ${journalSha256}`);
    error.code = "PINNED_JOURNAL_HASH_MISMATCH";
    throw error;
  }

  const { readOperationJournalRows } = await import("../../reconciliation/source/full_operation_evidence.mjs");
  const journal = await readOperationJournalRows({
    journalBuffer,
    sheet: source.source_sheet,
    journalSourceLabel: journalEntry,
  });
  const physicalRow = rowNumber(source.source_range);
  const matches = journal.rows.filter((row) =>
    row.physical_row === physicalRow
    && upper(row.source_row_id) === upper(source.source_row_id));
  if (matches.length !== 1) {
    const error = new Error(`Expected one exact ERP source row, got ${matches.length}`);
    error.code = matches.length > 1 ? "PINNED_SOURCE_ROW_AMBIGUOUS" : "PINNED_SOURCE_ROW_MISSING";
    throw error;
  }
  return {
    archive_sha256: archiveSha256,
    journal_entry: journalEntry,
    journal_sha256: journal.journal_sha256,
    journal_sheet: journal.journal_sheet,
    row: matches[0],
  };
}

function compareExactSource(materializationCase, reopened) {
  const source = materializationCase.physical_source;
  const row = reopened?.row ?? {};
  const mismatches = [];
  const compare = (field, expected, actual, { insensitive = false } = {}) => {
    const left = insensitive ? upper(expected) : text(expected);
    const right = insensitive ? upper(actual) : text(actual);
    if (left !== right) mismatches.push(`EXACT_SOURCE_MISMATCH:${field}`);
  };
  compare("archive_sha256", source.source_archive_sha256, reopened?.archive_sha256, { insensitive: true });
  compare("journal_entry", source.journal_entry, reopened?.journal_entry);
  compare("journal_sha256", source.journal_sha256, reopened?.journal_sha256, { insensitive: true });
  compare("source_sheet", source.source_sheet, reopened?.journal_sheet);
  compare("source_range", source.source_range, row.source_range);
  compare("source_row_id", source.source_row_id, row.source_row_id, { insensitive: true });
  compare("date", source.date, row.date);
  compare("document", source.document, row.document);
  compare("posting_number", source.posting_number, row.posting_no);
  compare("debit", source.debit, row.debit);
  compare("credit", source.credit, row.credit);
  compare("source_organization", source.source_organization, row.organization);
  compare("debit_department", source.debit_department, row.debit_department);
  compare("credit_department", source.credit_department, row.credit_department);
  compare("activity", source.activity, row.activity);
  compare("scenario", source.scenario, row.scenario);
  source.debit_analytics.forEach((value, index) => compare(`debit_analytics[${index}]`, value, sourceSlots(row, "debit")[index]));
  source.credit_analytics.forEach((value, index) => compare(`credit_analytics[${index}]`, value, sourceSlots(row, "credit")[index]));
  if (cents(source.amount) !== cents(row.amount)) mismatches.push("EXACT_SOURCE_MISMATCH:source_amount");
  if (cents(materializationCase.correction_amount) !== Math.abs(cents(row.amount) ?? 0)) {
    mismatches.push("EXACT_SOURCE_AMOUNT_MISMATCH");
  }
  const sourceArticle = text(materializationCase.economic?.source_article);
  const actualArticle = text(row.article);
  const actualAnalytics = [...sourceSlots(row, "debit"), ...sourceSlots(row, "credit")];
  if (sourceArticle && actualArticle && sourceArticle !== actualArticle) {
    mismatches.push("EXACT_SOURCE_MISMATCH:source_article");
  } else if (sourceArticle && !actualArticle && !actualAnalytics.includes(sourceArticle)) {
    mismatches.push("EXACT_SOURCE_MISMATCH:source_article");
  }
  if (isClosingAccount(row.debit) || isClosingAccount(row.credit)) mismatches.push("CLOSING_ROW_NOT_ECONOMIC_SOURCE");
  return unique(mismatches);
}

function verifiedPhysicalSource(claim, reopened) {
  const row = reopened.row;
  return {
    source_organization: text(row.organization),
    source_archive_path: claim.source_archive_path,
    source_archive_sha256: upper(reopened.archive_sha256),
    journal_entry: text(reopened.journal_entry),
    journal_sha256: upper(reopened.journal_sha256),
    source_sheet: text(reopened.journal_sheet),
    source_range: text(row.source_range),
    source_row_id: upper(row.source_row_id),
    date: text(row.date),
    document: text(row.document),
    posting_number: text(row.posting_no),
    debit: text(row.debit),
    credit: text(row.credit),
    debit_analytics: sourceSlots(row, "debit"),
    credit_analytics: sourceSlots(row, "credit"),
    debit_department: text(row.debit_department),
    credit_department: text(row.credit_department),
    amount: Number(row.amount),
    activity: text(row.activity),
    scenario: text(row.scenario),
  };
}

function materializationCaseWith(materializationCase, { route, physicalSource, sourceArticle, blockers }) {
  return createMaterializationCase({
    ...materializationCase,
    output_route: route,
    physical_source: physicalSource ?? materializationCase.physical_source,
    economic: {
      ...materializationCase.economic,
      source_article: sourceArticle ?? materializationCase.economic.source_article,
    },
    blockers: unique(blockers),
    safety: REPORT_ONLY_SAFETY,
  });
}

function loaderForStorno(materializationCase, decision) {
  const source = materializationCase.physical_source;
  const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field) => [field, null]));
  Object.assign(loader, {
    "СчетДт": source.debit || null,
    "СчетКт": source.credit || null,
    "ВидОперации": "STORNO",
    "ПодразделениеДт": source.debit_department || null,
    "ПодразделениеКт": source.credit_department || null,
    "СуммаВВалютеУчета": materializationCase.correction_amount,
    "СуммаВВалютеОтчетности": materializationCase.correction_amount,
    "Содержание": buildR001BusinessContent({
      operation: "STORNO",
      erp: {
        document: source.document,
        date: source.date,
        postingNumber: source.posting_number,
        debit: source.debit,
        credit: source.credit,
        amount: materializationCase.correction_amount,
        organization: source.source_organization,
        debitDepartment: source.debit_department,
        creditDepartment: source.credit_department,
      },
      economic: {
        sourceArticle: materializationCase.economic.source_article,
        targetArticle: materializationCase.economic.target_article,
      },
      decision: materializationCase.business_evidence,
      caseId: materializationCase.case_id,
      pairId: materializationCase.pair_id,
      sourceRowId: source.source_row_id,
      intalevDocumentNotPresented: materializationCase.business_evidence.intalev_document_absent === true,
    }),
    "СчетДтИсточник": source.debit || null,
    "СчетКтИсточник": source.credit || null,
    "ИдентификаторФинЗаписи": source.source_row_id || null,
    "СубконтоДт1": source.debit_analytics[0] || null,
    "СубконтоДт2": source.debit_analytics[1] || null,
    "СубконтоДт3": source.debit_analytics[2] || null,
    "СубконтоКт1": source.credit_analytics[0] || null,
    "СубконтоКт2": source.credit_analytics[1] || null,
    "СубконтоКт3": source.credit_analytics[2] || null,
  });
  return loader;
}

function canonicalStornoRow(materializationCase, decision) {
  const source = materializationCase.physical_source;
  return createCanonicalPostingRow({
    materialization_case: materializationCase,
    operation: "STORNO",
    output_route: materializationCase.output_route,
    materialization_state: materializationCase.output_route === "READY"
      ? "MATERIALIZED_READY"
      : "MATERIALIZED_SPORNO",
    audit_identity: stableId("R001-STANDALONE-STORNO", [
      materializationCase.case_id,
      materializationCase.pair_id,
      source.source_row_id,
      materializationCase.correction_amount,
      materializationCase.output_route,
    ]),
    amount: materializationCase.correction_amount,
    result_accounting: {
      debit: source.debit,
      credit: source.credit,
      debit_analytics: source.debit_analytics,
      credit_analytics: source.credit_analytics,
      debit_department: source.debit_department,
      credit_department: source.credit_department,
      article: materializationCase.economic.source_article,
    },
    loader: loaderForStorno(materializationCase, decision),
    safety: REPORT_ONLY_SAFETY,
  });
}

function blockedCase(materializationCase, blockers) {
  return materializationCaseWith(materializationCase, {
    route: materializationCase.output_route === "REVIEW_ONLY" ? "REVIEW_ONLY" : "SPORNO",
    blockers: [...materializationCase.blockers, ...blockers],
  });
}

export async function materializeStandaloneStornoCases(decisions = [], { reopenSource = reopenPinnedSource } = {}) {
  if (!Array.isArray(decisions)) throw new TypeError("Standalone STORNO decisions must be an array");
  if (typeof reopenSource !== "function") throw new TypeError("reopenSource must be a function");
  const canonicalPostingRows = [];
  const caseUpdates = [];
  const skipped = [];

  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const eligibilityBlockers = standaloneEligibility(decision);
    if (eligibilityBlockers.length) {
      skipped.push(Object.freeze({
        upstream_decision_index: index,
        case_id: text(decision?.case_id),
        blockers: Object.freeze(eligibilityBlockers),
      }));
      continue;
    }

    const originalCase = decision.materialization_case;
    const source = originalCase.physical_source;
    if (isClosingAccount(source.debit) || isClosingAccount(source.credit)) {
      const blockers = ["CLOSING_ROW_NOT_ECONOMIC_SOURCE"];
      caseUpdates.push(Object.freeze({
        upstream_decision_index: index,
        result: "BLOCKED",
        blockers: Object.freeze(blockers),
        materialization_case: blockedCase(originalCase, blockers),
      }));
      continue;
    }

    const canAttemptReady = decision?.SOURCE_OPERATION_PROVEN === true
      && decision?.PHYSICAL_SOURCE_UNIQUE === true
      && originalCase.correction_allowed === true
      && exactPhysicalClaimComplete(source);

    if (!canAttemptReady) {
      const blockers = ["EXACT_PHYSICAL_SOURCE_INCOMPLETE_OR_AMBIGUOUS"];
      const materializationCase = materializationCaseWith(originalCase, {
        route: "SPORNO",
        blockers: [...originalCase.blockers, ...blockers],
      });
      const canonicalPostingRow = canonicalStornoRow(materializationCase, decision);
      canonicalPostingRows.push(canonicalPostingRow);
      caseUpdates.push(Object.freeze({
        upstream_decision_index: index,
        result: "SPORNO",
        blockers: Object.freeze(blockers),
        materialization_case: materializationCase,
        canonical_posting_row: canonicalPostingRow,
      }));
      continue;
    }

    try {
      const reopened = await reopenSource({ decision, materialization_case: originalCase });
      const blockers = compareExactSource(originalCase, reopened);
      if (blockers.length) {
        caseUpdates.push(Object.freeze({
          upstream_decision_index: index,
          result: "BLOCKED",
          blockers: Object.freeze(blockers),
          materialization_case: blockedCase(originalCase, blockers),
        }));
        continue;
      }
      const verifiedSource = verifiedPhysicalSource(source, reopened);
      const sourceArticle = text(reopened.row.article) || originalCase.economic.source_article;
      const materializationCase = materializationCaseWith(originalCase, {
        route: "READY",
        physicalSource: verifiedSource,
        sourceArticle,
        blockers: originalCase.blockers.filter((item) => text(item) !== "EXACT_SOURCE_REOPEN_REQUIRED_FOR_READY"),
      });
      const canonicalPostingRow = canonicalStornoRow(materializationCase, decision);
      canonicalPostingRows.push(canonicalPostingRow);
      caseUpdates.push(Object.freeze({
        upstream_decision_index: index,
        result: "READY",
        blockers: Object.freeze([]),
        materialization_case: materializationCase,
        canonical_posting_row: canonicalPostingRow,
      }));
    } catch (error) {
      const blocker = text(error?.code) || `EXACT_SOURCE_REOPEN_FAILED:${text(error?.message) || "UNKNOWN"}`;
      caseUpdates.push(Object.freeze({
        upstream_decision_index: index,
        result: "BLOCKED",
        blockers: Object.freeze([blocker]),
        materialization_case: blockedCase(originalCase, [blocker]),
      }));
    }
  }

  const readyRows = canonicalPostingRows.filter((row) => row.output_route === "READY");
  const spornoRows = canonicalPostingRows.filter((row) => row.output_route === "SPORNO");
  return Object.freeze({
    schema_version: R001_STANDALONE_STORNO_SCHEMA,
    canonical_posting_rows: Object.freeze(canonicalPostingRows),
    case_updates: Object.freeze(caseUpdates),
    skipped: Object.freeze(skipped),
    audit: Object.freeze({
      input_decision_count: decisions.length,
      eligible_case_count: caseUpdates.length,
      canonical_posting_row_count: canonicalPostingRows.length,
      ready_row_count: readyRows.length,
      sporno_row_count: spornoRows.length,
      blocked_case_count: caseUpdates.filter((item) => item.result === "BLOCKED").length,
      skipped_count: skipped.length,
    }),
    safety: REPORT_ONLY_SAFETY,
  });
}
