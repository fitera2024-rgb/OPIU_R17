export const UNAPPROVED_RECLASSIFICATION_STATUS =
  "UNAPPROVED_RECLASSIFICATION_CANDIDATE";

export function keepRawWithReclassificationCandidate(rawResult, candidateResult) {
  const current = rawResult ?? {
    amount: null,
    status: "MISSING",
    trace: [],
    note: "Литеральная строка ERP не найдена.",
  };
  return {
    ...current,
    raw_amount: typeof current.amount === "number" ? current.amount : null,
    normalized_amount:
      typeof candidateResult?.amount === "number" ? candidateResult.amount : null,
    normalization_status: UNAPPROVED_RECLASSIFICATION_STATUS,
    normalization_note: String(candidateResult?.note ?? ""),
    normalization_trace: Array.isArray(candidateResult?.trace)
      ? candidateResult.trace
      : [],
  };
}

export function useDerivedOnlyWhenRawMissing(rawResult, candidateResult) {
  if (typeof rawResult?.amount === "number") {
    return keepRawWithReclassificationCandidate(rawResult, candidateResult);
  }
  return {
    ...candidateResult,
    raw_amount: null,
    normalized_amount:
      typeof candidateResult?.amount === "number" ? candidateResult.amount : null,
    normalization_status: UNAPPROVED_RECLASSIFICATION_STATUS,
    normalization_note: String(candidateResult?.note ?? ""),
    normalization_trace: Array.isArray(candidateResult?.trace)
      ? candidateResult.trace
      : [],
  };
}
