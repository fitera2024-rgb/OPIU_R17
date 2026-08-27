const PROVEN_RESIDUAL_STATUSES = new Set([
  "PROVEN",
  "EXACT",
  "PROVEN_ALLOCATION",
  "ECONOMIC_CORRECTION_PROVEN",
  "REPORT_SOURCE_PROVEN",
]);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function cents(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100)
    : null;
}

export function residualProofStatus(row) {
  return upper(
    row?.residual_allocation_proof_status
    ?? row?.allocation_proof_status
    ?? row?.residual_proof_status
    ?? row?.proof_status
    ?? row?.evidence_state
    ?? row?.mapping_proof_status,
  );
}

export function isProvenResidualStatus(row) {
  return PROVEN_RESIDUAL_STATUSES.has(residualProofStatus(row));
}

export function provenResidualAllocationCents(row) {
  const allocation = row?.residual_allocation;
  const explicit = [
    row?.residual_allocation_amount,
    row?.allocated_residual_amount,
    row?.proven_residual_amount,
    row?.allocated_amount,
    typeof allocation === "number" ? allocation : allocation?.amount,
  ].map(cents).find((value) => value !== null);
  if (explicit === undefined || !PROVEN_RESIDUAL_STATUSES.has(residualProofStatus(row))) return null;
  return explicit;
}

/**
 * Returns only an accepted economic descendant allocation. Hierarchy is
 * established by the caller; this predicate supplies the common proof rule
 * used by generic normalization and the authoritative owner ledger.
 */
export function provenDescendantAllocation(parent, child, {
  childEffectiveRawCents = null,
} = {}) {
  const explicit = provenResidualAllocationCents(child);
  if (explicit !== null) {
    return {
      amount_cents: explicit,
      proof: "EXPLICIT_PROVEN_ALLOCATION",
      transformation_id: text(child?.transformation_id)
        || text(typeof child?.residual_allocation === "object"
          ? child.residual_allocation?.transformation_id
          : ""),
      explicit: true,
    };
  }

  // A source trace that appears under a parent on only one side proves a
  // presentation-structure difference, not an authoritative residual
  // allocation. Treating that XOR as financial proof caused nested rows to be
  // subtracted from an already closed parent (the historical nested-residual defect).
  // Only an explicit accepted allocation can consume a descendant atom.
  void parent;
  void childEffectiveRawCents;
  return null;
}

export function isDescendantAllocationCompatible({
  parentRawCents,
  representedCents = 0,
  allocation,
  toleranceCents = 1,
} = {}) {
  if (!allocation || allocation.amount_cents === 0 || parentRawCents === null) return false;
  const sameSign = allocation.explicit
    || Math.sign(allocation.amount_cents) === Math.sign(parentRawCents);
  if (!sameSign) return false;
  return Math.abs(representedCents + allocation.amount_cents)
    <= Math.abs(parentRawCents) + Math.max(0, toleranceCents);
}
