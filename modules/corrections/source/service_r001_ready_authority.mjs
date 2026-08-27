import crypto from "node:crypto";
import { createCanonicalPostingRow } from "./r001_materialization_contract.mjs";

const BLOCKER_MISSING = "SERVICE_HANDOFF_SOURCE_ROW_ID_MISSING";
const BLOCKER_OUTSIDE = "SERVICE_HANDOFF_SOURCE_ROW_ID_OUTSIDE_EXACT_SET";
const BLOCKER_REUSED = "SERVICE_HANDOFF_SOURCE_ROW_ID_REUSED";
const BLOCKER_LEG_COUNT = "SERVICE_HANDOFF_PAIR_LEG_COUNT_INVALID";
const BLOCKER_MIXED_ROUTE = "SERVICE_HANDOFF_PAIR_MIXED_OUTPUT_ROUTE";
const BLOCKER_OPERATIONS = "SERVICE_HANDOFF_PAIR_OPERATIONS_INVALID";
const BLOCKER_MULTIPLE_IDS = "SERVICE_HANDOFF_PAIR_MULTIPLE_SOURCE_ROW_IDS";
const BLOCKER_UNBALANCED = "SERVICE_HANDOFF_PAIR_UNBALANCED_NON_FINANCIAL";
const NON_FINANCIAL_REVIEW_SCHEMA = "opiu-r001-non-financial-review.v1";

const BLOCKER_REASONS = Object.freeze({
  [BLOCKER_MISSING]: "Не указан точный SourceRowID физической строки ERP",
  [BLOCKER_OUTSIDE]: "SourceRowID отсутствует в точном Service handoff",
  [BLOCKER_REUSED]: "SourceRowID повторно использован другой парой",
  [BLOCKER_LEG_COUNT]: "Пара не содержит ровно две канонические строки",
  [BLOCKER_MIXED_ROUTE]: "Строки пары имеют смешанные маршруты READY и СПОРНО",
  [BLOCKER_OPERATIONS]: "Пара не содержит ровно одну операцию STORNO и одну REPOST",
  [BLOCKER_MULTIPLE_IDS]: "Пара ссылается более чем на один SourceRowID",
  [BLOCKER_UNBALANCED]: "Суммы STORNO и REPOST не равны",
});

function clean(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function economicInputSourceRowID(row) {
  return clean(row?.materialization_case?.physical_source?.source_row_id)
    || clean(row?.source?.source_row_id);
}

function reviewReason(blockers) {
  return unique(blockers.map((blocker) => BLOCKER_REASONS[blocker] || blocker)).join("; ");
}

function nonFinancialReview(pairID, pairRows, blockers) {
  const sourceRowIDs = unique(pairRows.map(economicInputSourceRowID));
  return Object.freeze({
    schema_version: NON_FINANCIAL_REVIEW_SCHEMA,
    pair_id: pairID,
    source_row_id: sourceRowIDs.join("; "),
    operations: Object.freeze(pairRows.map((row) => clean(row?.operation).toUpperCase())),
    amounts: Object.freeze(pairRows.map((row) => Number(row?.amount ?? 0))),
    blocker_codes: Object.freeze([...blockers]),
    reason: reviewReason(blockers),
    report_only: true,
    correction_allowed: false,
    canonical_financial_rows: 0,
  });
}

export function nonFinancialReviewSetSHA256(reviews = []) {
  if (!Array.isArray(reviews)) throw new Error("NON_FINANCIAL_REVIEWS_INVALID_INPUT");
  const canonical = reviews.map((review) => ({
    schema_version: review.schema_version,
    pair_id: review.pair_id,
    source_row_id: review.source_row_id,
    operations: review.operations,
    amounts: review.amounts,
    blocker_codes: review.blocker_codes,
    reason: review.reason,
    report_only: review.report_only,
    correction_allowed: review.correction_allowed,
    canonical_financial_rows: review.canonical_financial_rows,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex").toUpperCase();
}

function quarantinePairRow(row, blockers) {
  const materializationCase = {
    ...row.materialization_case,
    correction_allowed: false,
    correction_authority: "SERVICE_HANDOFF_PHYSICAL_AUTHORITY_BLOCKED",
    output_route: "SPORNO",
    physical_proof: {
      ...row.materialization_case?.physical_proof,
      physical_source_unique: false,
      pinned_source_reopened: false,
      source_reuse_checked: false,
    },
    blockers: unique([...(row.materialization_case?.blockers ?? []), ...blockers]),
  };
  return createCanonicalPostingRow({
    materialization_case: materializationCase,
    operation: row.operation,
    output_route: "SPORNO",
    materialization_state: "MATERIALIZED_SPORNO",
    audit_identity: row.audit_identity,
    amount: row.amount,
    result_accounting: row.result_accounting,
    loader: row.loader,
    safety: row.safety,
  });
}

export function enforceServiceHandoffReadyAuthority(rows = [], sourceRowIDs = []) {
  if (!Array.isArray(rows) || !Array.isArray(sourceRowIDs)) {
    throw new Error("SERVICE_HANDOFF_READY_AUTHORITY_INVALID_INPUT");
  }
  const normalizedIDs = sourceRowIDs.map(clean);
  if (normalizedIDs.some((value) => !value) || new Set(normalizedIDs).size !== normalizedIDs.length) {
    throw new Error("SERVICE_HANDOFF_SOURCE_ROW_IDS_NOT_EXACT_UNIQUE");
  }
  const allowed = new Set(normalizedIDs);
  const rowsByPair = new Map();
  for (const row of rows) {
    const pairID = clean(row?.pair_id) || `AUDIT:${clean(row?.audit_identity)}`;
    if (!rowsByPair.has(pairID)) rowsByPair.set(pairID, []);
    rowsByPair.get(pairID).push(row);
  }

  const pairsBySourceRowID = new Map();
  for (const [pairID, pairRows] of rowsByPair) {
    for (const sourceRowID of unique(pairRows.map(economicInputSourceRowID))) {
      if (!pairsBySourceRowID.has(sourceRowID)) pairsBySourceRowID.set(sourceRowID, new Set());
      pairsBySourceRowID.get(sourceRowID).add(pairID);
    }
  }

  const blockersByPair = new Map();
  const nonFinancialPairIDs = new Set();
  for (const [pairID, pairRows] of rowsByPair) {
    if (!pairRows.some((row) => clean(row?.output_route).toUpperCase() === "READY")) continue;
    const blockers = [];
    const sourceRowIDsForPair = unique(pairRows.map(economicInputSourceRowID));
    const operations = pairRows.map((row) => clean(row?.operation).toUpperCase());
    if (pairRows.length !== 2) blockers.push(BLOCKER_LEG_COUNT);
    if (pairRows.some((row) => clean(row?.output_route).toUpperCase() !== "READY")) blockers.push(BLOCKER_MIXED_ROUTE);
    if (operations.length !== 2
      || operations.filter((operation) => operation === "STORNO").length !== 1
      || operations.filter((operation) => operation === "REPOST").length !== 1) {
      blockers.push(BLOCKER_OPERATIONS);
    }
    if (pairRows.some((row) => !economicInputSourceRowID(row))) blockers.push(BLOCKER_MISSING);
    if (sourceRowIDsForPair.length > 1) blockers.push(BLOCKER_MULTIPLE_IDS);
    if (sourceRowIDsForPair.some((sourceRowID) => !allowed.has(sourceRowID))) blockers.push(BLOCKER_OUTSIDE);
    if (sourceRowIDsForPair.some((sourceRowID) => (pairsBySourceRowID.get(sourceRowID)?.size ?? 0) !== 1)) {
      blockers.push(BLOCKER_REUSED);
    }
    const stornoCents = pairRows
      .filter((row) => clean(row?.operation).toUpperCase() === "STORNO")
      .reduce((sum, row) => sum + Math.round(Number(row?.amount ?? 0) * 100), 0);
    const repostCents = pairRows
      .filter((row) => clean(row?.operation).toUpperCase() === "REPOST")
      .reduce((sum, row) => sum + Math.round(Number(row?.amount ?? 0) * 100), 0);
    if (stornoCents <= 0 || repostCents <= 0 || stornoCents !== repostCents) blockers.push(BLOCKER_UNBALANCED);
    if (blockers.length) {
      if (blockers.some((blocker) => [BLOCKER_LEG_COUNT, BLOCKER_OPERATIONS, BLOCKER_UNBALANCED].includes(blocker))) {
        nonFinancialPairIDs.add(pairID);
      }
      blockersByPair.set(pairID, unique(blockers));
    }
  }

  const gatedRows = rows.flatMap((row) => {
    const pairID = clean(row?.pair_id) || `AUDIT:${clean(row?.audit_identity)}`;
    const blockers = blockersByPair.get(pairID);
    if (nonFinancialPairIDs.has(pairID)) return [];
    return [blockers ? quarantinePairRow(row, blockers) : row];
  });
  const nonFinancialReviews = [...nonFinancialPairIDs].map((pairID) => nonFinancialReview(
    pairID,
    rowsByPair.get(pairID) ?? [],
    blockersByPair.get(pairID) ?? [],
  ));
  const nonFinancialReviewSHA256 = nonFinancialReviewSetSHA256(nonFinancialReviews);
  return Object.freeze({
    rows: Object.freeze(gatedRows),
    audit: Object.freeze({
      exact_source_row_id_count: allowed.size,
      ready_rows_before_gate: rows.filter((row) => clean(row?.output_route).toUpperCase() === "READY").length,
      ready_rows_after_gate: gatedRows.filter((row) => row.output_route === "READY").length,
      blocked_pair_count: blockersByPair.size,
      non_financial_pair_count: nonFinancialReviews.length,
      non_financial_review_row_count: nonFinancialReviews.length,
      non_financial_review_set_sha256: nonFinancialReviewSHA256,
      non_financial_reviews: Object.freeze(nonFinancialReviews),
      blocker_codes: Object.freeze(unique([...blockersByPair.values()].flat())),
    }),
  });
}
