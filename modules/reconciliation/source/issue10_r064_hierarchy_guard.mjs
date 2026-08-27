function numeric(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function exactTraceComplete(node) {
  return Boolean(
    node?.source_file &&
    node?.sha256 &&
    node?.sheet &&
    (Number.isInteger(Number(node?.physical_row)) || Number.isInteger(Number(node?.row))) &&
    node?.source_cell &&
    (node?.month || node?.period),
  );
}

export function proveR064CandidateAmount(candidate, nodes, visited = new Set()) {
  const index = nodes.indexOf(candidate);
  if (index < 0 || visited.has(index) || !exactTraceComplete(candidate)) {
    return { status: "BLOCKED_ZERO_NOT_PROVEN", amount: null, trace: candidate ? [candidate] : [] };
  }
  if (numeric(candidate.value)) {
    return { status: "PASS_EXPLICIT_NUMBER", amount: candidate.value, trace: [candidate] };
  }
  visited.add(index);
  const childIndexes = Array.isArray(candidate.child_indexes) ? candidate.child_indexes : [];
  if (childIndexes.length === 0) {
    visited.delete(index);
    const blankLeafProven =
      candidate.source_cell_present === true &&
      candidate.source_value_kind === "BLANK" &&
      candidate.row_kind === "LEAF";
    return blankLeafProven
      ? { status: "PASS_EXACT_BLANK_LEAF_ZERO", amount: 0, trace: [candidate] }
      : { status: "BLOCKED_ZERO_NOT_PROVEN", amount: null, trace: [candidate] };
  }
  const children = childIndexes.map((childIndex) => nodes[childIndex]).filter(Boolean);
  if (children.length !== childIndexes.length) {
    visited.delete(index);
    return { status: "BLOCKED_ZERO_NOT_PROVEN", amount: null, trace: [candidate, ...children] };
  }
  const proofs = children.map((child) => proveR064CandidateAmount(child, nodes, visited));
  visited.delete(index);
  if (proofs.some((proof) => !numeric(proof.amount))) {
    return {
      status: "BLOCKED_ZERO_NOT_PROVEN",
      amount: null,
      trace: [candidate, ...proofs.flatMap((proof) => proof.trace)],
    };
  }
  return {
    status: "PASS_EXACT_CHILD_SUM",
    amount: proofs.reduce((sum, proof) => sum + proof.amount, 0),
    trace: [candidate, ...proofs.flatMap((proof) => proof.trace)],
  };
}

export function resolveR064DuplicateNull({ candidates, nodes }) {
  const values = (candidates ?? []).map((candidate) => candidate?.value);
  const hasNull = values.some((value) => value === null || value === undefined);
  const hasNumeric = values.some(numeric);
  if (!hasNull) return { status: "NOT_APPLICABLE_NUMERIC", amount: null, trace: [] };
  if (hasNumeric) {
    return {
      status: "BLOCKED_ZERO_NOT_PROVEN",
      amount: null,
      trace: [...candidates],
      note: "Mixed null/numeric duplicate candidates are not equivalent exact evidence.",
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    };
  }
  const proofs = candidates.map((candidate) => proveR064CandidateAmount(candidate, nodes));
  const amounts = proofs.map((proof) => proof.amount);
  if (proofs.some((proof) => !numeric(proof.amount)) || !amounts.every((amount) => amount === 0)) {
    return {
      status: "BLOCKED_ZERO_NOT_PROVEN",
      amount: null,
      trace: proofs.flatMap((proof) => proof.trace),
      proofs,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    };
  }
  return {
    status: "ZERO_NO_ACTIVITY_DUPLICATE_PROVEN",
    amount: 0,
    trace: proofs.flatMap((proof) => proof.trace),
    proofs,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export function aggregateAnnualProvenMonths(months) {
  if (!Array.isArray(months) || months.length !== 12 || !months.every((month) => numeric(month?.amount))) {
    return { status: "BLOCKED_ANNUAL_MONTH_EVIDENCE", amount: null };
  }
  return {
    status: "PASS_12_MONTHS",
    amount: months.reduce((sum, month) => sum + month.amount, 0),
  };
}

export function classifyHierarchyResidual({ parentTotal, childSum, tolerance = 0.01 }) {
  if (!numeric(parentTotal) || !numeric(childSum)) {
    return { status: "BLOCKED_MISSING_EVIDENCE", residual: null };
  }
  const residual = Number((parentTotal - childSum).toFixed(10));
  return {
    status: Math.abs(residual) <= Math.abs(tolerance)
      ? "PASS"
      : "BLOCKED_HIERARCHY_MISMATCH",
    residual,
  };
}

export function postingEligibility(row) {
  const role = String(row?.row_kind ?? row?.type ?? row?.role ?? "").toLocaleLowerCase("ru-RU");
  const structural =
    row?.hierarchy_has_children === true ||
    row?.has_children === true ||
    ["parent", "group", "total", "блок", "группа", "итог", "родитель"].includes(role);
  return {
    posting_eligible: false,
    structural_non_posting: structural,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
