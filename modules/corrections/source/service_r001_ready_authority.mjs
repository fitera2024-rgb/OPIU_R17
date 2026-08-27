import { createCanonicalPostingRow } from "./r001_materialization_contract.mjs";

const BLOCKER_MISSING = "SERVICE_HANDOFF_SOURCE_ROW_ID_MISSING";
const BLOCKER_OUTSIDE = "SERVICE_HANDOFF_SOURCE_ROW_ID_OUTSIDE_EXACT_SET";
const BLOCKER_REUSED = "SERVICE_HANDOFF_SOURCE_ROW_ID_REUSED";

function clean(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function demoteReadyRow(row, blockers) {
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
  const readyByPair = new Map();
  for (const row of rows) {
    if (clean(row?.output_route).toUpperCase() !== "READY") continue;
    const pairID = clean(row?.pair_id) || `AUDIT:${clean(row?.audit_identity)}`;
    if (!readyByPair.has(pairID)) readyByPair.set(pairID, []);
    readyByPair.get(pairID).push(row);
  }

  const pairsBySourceRowID = new Map();
  for (const [pairID, pairRows] of readyByPair) {
    for (const sourceRowID of unique(pairRows.map((row) => row?.source?.source_row_id))) {
      if (!pairsBySourceRowID.has(sourceRowID)) pairsBySourceRowID.set(sourceRowID, new Set());
      pairsBySourceRowID.get(sourceRowID).add(pairID);
    }
  }

  const blockersByPair = new Map();
  for (const [pairID, pairRows] of readyByPair) {
    const blockers = [];
    const sourceRowIDsForPair = unique(pairRows.map((row) => row?.source?.source_row_id));
    if (pairRows.some((row) => !clean(row?.source?.source_row_id))) blockers.push(BLOCKER_MISSING);
    if (sourceRowIDsForPair.some((sourceRowID) => !allowed.has(sourceRowID))) blockers.push(BLOCKER_OUTSIDE);
    if (sourceRowIDsForPair.some((sourceRowID) => (pairsBySourceRowID.get(sourceRowID)?.size ?? 0) !== 1)) {
      blockers.push(BLOCKER_REUSED);
    }
    if (blockers.length) blockersByPair.set(pairID, blockers);
  }

  const gatedRows = rows.map((row) => {
    if (clean(row?.output_route).toUpperCase() !== "READY") return row;
    const pairID = clean(row?.pair_id) || `AUDIT:${clean(row?.audit_identity)}`;
    const blockers = blockersByPair.get(pairID);
    return blockers ? demoteReadyRow(row, blockers) : row;
  });
  return Object.freeze({
    rows: Object.freeze(gatedRows),
    audit: Object.freeze({
      exact_source_row_id_count: allowed.size,
      ready_rows_before_gate: readyByPair.size
        ? [...readyByPair.values()].reduce((sum, pairRows) => sum + pairRows.length, 0)
        : 0,
      ready_rows_after_gate: gatedRows.filter((row) => row.output_route === "READY").length,
      blocked_pair_count: blockersByPair.size,
      blocker_codes: Object.freeze(unique([...blockersByPair.values()].flat())),
    }),
  });
}
