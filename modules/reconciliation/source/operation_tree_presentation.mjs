function defaultNormalize(value) {
  return String(value ?? "").trim();
}

function defaultFail(message) {
  throw new Error(message);
}

function physicalRowNumber(row) {
  const value = String(row?.erp_rows ?? "").trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

function physicalAmount(row) {
  const value = Number(row?.source_amount ?? row?.amount);
  return Number.isFinite(value) && Math.abs(value) > 0 ? Math.abs(value) : null;
}

function provenCrossJournalSource(row, normalize) {
  const physicalRow = physicalRowNumber(row);
  const amount = physicalAmount(row);
  return normalize(row?.row_type) === "UNIQUE_PAIR" &&
    normalize(row?.intalev_report_placement_status) ===
      "PROVEN_LIVE_REPORT_LEAF_ANALYTIC" &&
    Boolean(normalize(row?.intalev_report_node_id)) &&
    Boolean(normalize(row?.erp_source_row_id)) &&
    row?.reused !== true &&
    Number.isInteger(physicalRow) &&
    physicalRow > 0 &&
    Boolean(normalize(row?.erp_document)) &&
    Boolean(normalize(row?.source_date ?? row?.date)) &&
    Boolean(normalize(row?.posting_number)) &&
    Boolean(normalize(row?.source_dt ?? row?.debit)) &&
    Boolean(normalize(row?.source_kt ?? row?.credit)) &&
    amount !== null &&
    Boolean(normalize(row?.source_organization));
}

function sourceAnalytics(row, prefix, normalize) {
  return [1, 2, 3]
    .map((index) => normalize(row?.[`${prefix}${index}`]))
    .filter(Boolean);
}

// Project only already-proven physical cross-journal evidence. Presentation
// identity is the exact live Intalev node id; article, amount, S-code and Excel
// row number never participate in binding. Missing/duplicate identities remain
// unbound review evidence instead of being attached heuristically.
export function projectCrossJournalSourceDrilldown({
  presentationRows,
  crossJournalEvidence,
  normalize = defaultNormalize,
}) {
  const rowsByIdentity = new Map();
  for (const presentationRow of presentationRows ?? []) {
    const identity = normalize(presentationRow?.hierarchy_node_id);
    if (!identity) continue;
    const rows = rowsByIdentity.get(identity) ?? [];
    rows.push(presentationRow);
    rowsByIdentity.set(identity, rows);
  }

  const projectedRows = [];
  const seenPhysicalSources = new Set();
  let provenCandidateRows = 0;
  let unprovenRows = 0;
  let unboundRows = 0;
  let duplicateRows = 0;
  const evidenceRows = Array.isArray(crossJournalEvidence?.rows)
    ? crossJournalEvidence.rows
    : [];
  for (const row of evidenceRows) {
    if (!provenCrossJournalSource(row, normalize)) {
      unprovenRows += 1;
      continue;
    }
    provenCandidateRows += 1;
    const parentIdentity = normalize(row.intalev_report_node_id);
    const parents = rowsByIdentity.get(parentIdentity) ?? [];
    if (parents.length !== 1) {
      unboundRows += 1;
      continue;
    }
    const sourceRowId = normalize(row.erp_source_row_id);
    const deduplicationKey = `${parentIdentity}\u0000${sourceRowId}`;
    if (seenPhysicalSources.has(deduplicationKey)) {
      duplicateRows += 1;
      continue;
    }
    seenPhysicalSources.add(deduplicationKey);

    const parent = parents[0];
    const parentCode = normalize(parent.code);
    if (!parentCode) {
      unboundRows += 1;
      continue;
    }
    const physicalRow = physicalRowNumber(row);
    const amount = physicalAmount(row);
    const idSuffix = sourceRowId.slice(0, 24);
    projectedRows.push({
      parent_code: parentCode,
      parent_identity: parentIdentity,
      row_class: "ERP_SOURCE_EVIDENCE",
      proof_status: "PROVEN_CROSS_JOURNAL_SOURCE",
      evidence_status: normalize(row.financial_gate_status) || "PROVEN_UNIQUE_PAIR",
      exact_article_bound: false,
      count_in_parent: false,
      excluded_from_totals: true,
      correction_operation_rows: 0,
      posting_rows: 0,
      live_rows: 0,
      executed_rows: 0,
      display_depth_offset: 1,
      display_order: physicalRow,
      source_row_id: sourceRowId,
      physical_row: physicalRow,
      source_range: normalize(row.source_range) || `B${physicalRow}:AG${physicalRow}`,
      date: normalize(row.source_date ?? row.date),
      document: normalize(row.erp_document),
      posting_no: normalize(row.posting_number),
      debit: normalize(row.source_dt ?? row.debit),
      debit_analytics: sourceAnalytics(row, "source_analytics_dt", normalize),
      debit_department: normalize(row.source_department_dt),
      credit: normalize(row.source_kt ?? row.credit),
      credit_analytics: sourceAnalytics(row, "source_analytics_kt", normalize),
      credit_department: normalize(row.source_department_kt),
      organization: normalize(row.source_organization),
      amount,
      article: normalize(row.source_article ?? row.article_erp),
      reason:
        "Доказанная физическая ERP-строка cross-journal; показана по exact presentation identity.",
      source_to_target: [
        normalize(row.source_block_erp),
        normalize(row.target_block_intalev),
      ].filter(Boolean).join(" → "),
      cross_journal_case_id: `XJ-${idSuffix}`,
      cross_journal_pair_id: `PAIR-${idSuffix}`,
      intalev_source_row_id: normalize(row.intalev_source_row_id),
      intalev_report_node_id: parentIdentity,
      comment: [
        "ERP SOURCE EVIDENCE",
        `BindingIdentity=${parentIdentity}`,
        `CrossJournalCaseID=XJ-${idSuffix}`,
        `CrossJournalPairID=PAIR-${idSuffix}`,
        "EXCLUDED_FROM_TOTAL",
        "correction_operation_rows=0",
        "posting_rows=0",
      ].join("; "),
    });
  }

  return {
    rows: projectedRows,
    audit: {
      schema: "R005_MAIN_TREE_CROSS_JOURNAL_DRILLDOWN_V1",
      binding: "EXISTING_STABLE_PRESENTATION_IDENTITY",
      binding_field: "intalev_report_node_id=hierarchy_node_id",
      evidence_rows: Array.isArray(crossJournalEvidence?.rows)
        ? crossJournalEvidence.rows.length
        : 0,
      proven_candidate_rows: provenCandidateRows,
      display_rows: projectedRows.length,
      unique_physical_source_row_ids: new Set(
        projectedRows.map((row) => row.source_row_id),
      ).size,
      duplicate_rows: duplicateRows,
      unbound_rows: unboundRows,
      unproven_rows: unprovenRows,
      financial_authority: false,
      correction_operation_rows: 0,
      posting_rows: 0,
    },
  };
}

// Presentation-only expansion. It never changes financial amounts, evidence
// classes, correction rows or release gates; it only places already-read
// journal rows into the review tree.
export function buildOperationTreePresentation({
  presentationRows,
  financialOutlineLevels,
  operationEvidence,
  crossJournalEvidence,
  normalize = defaultNormalize,
  fail = defaultFail,
}) {
  const operations = Array.isArray(operationEvidence?.rows)
    ? operationEvidence.rows
    : [];
  const unassignedOperations = Array.isArray(operationEvidence?.unassigned_rows)
    ? operationEvidence.unassigned_rows
    : [];
  const crossJournalDrilldown = projectCrossJournalSourceDrilldown({
    presentationRows,
    crossJournalEvidence,
    normalize,
  });
  const byParent = new Map();
  for (const operation of operations) {
    const parentCode = normalize(operation.parent_code);
    if (!/^R\d{3}$/.test(parentCode)) {
      fail(`Операция без допустимого parent_code: ${parentCode || "MISSING"}.`);
    }
    const list = byParent.get(parentCode) ?? [];
    list.push(operation);
    byParent.set(parentCode, list);
  }
  for (const operation of crossJournalDrilldown.rows) {
    const parentCode = normalize(operation.parent_code);
    const list = byParent.get(parentCode) ?? [];
    list.push(operation);
    byParent.set(parentCode, list);
  }

  const displayRows = [];
  const outlineLevels = [];
  const financialIndexes = new Map();
  for (let index = 0; index < presentationRows.length; index += 1) {
    const financial = presentationRows[index];
    const financialLevel = financialOutlineLevels[index];
    financialIndexes.set(financial.code, displayRows.length);
    displayRows.push({ kind: "FINANCIAL", financial });
    outlineLevels.push(financialLevel);

    const children = [...(byParent.get(financial.code) ?? [])].sort(
      (left, right) =>
        Number(left.display_order ?? left.physical_row ?? 0) -
          Number(right.display_order ?? right.physical_row ?? 0),
    );
    for (const operation of children) {
      const depthOffset = Number(operation.display_depth_offset ?? 1);
      if (!Number.isInteger(depthOffset) || depthOffset < 1 || depthOffset > 2) {
        fail(
          `Недопустимая глубина операции ${operation.source_row_id || operation.physical_row}: ${depthOffset}.`,
        );
      }
      const level = financialLevel + depthOffset;
      if (level > 7) {
        fail(
          `Операция ${operation.source_row_id || operation.physical_row} превышает Excel outlineLevel=7.`,
        );
      }
      displayRows.push({ kind: "OPERATION", operation });
      outlineLevels.push(level);
    }
  }

  const knownCodes = new Set(presentationRows.map((row) => normalize(row.code)));
  const legacyParentCodes = new Set(operations.map((row) => normalize(row.parent_code)));
  const unknownParents = [...legacyParentCodes].filter((code) => !knownCodes.has(code));
  if (unknownParents.length > 0) {
    fail(`Операции с неизвестными родителями: ${unknownParents.join(", ")}.`);
  }

  // If the journal has no article/R-code evidence, retain every registrar in
  // the main tree under one explicit review branch. Rows remain unassigned and
  // excluded from totals, rather than disappearing from the workbook.
  if (unassignedOperations.length > 0) {
    displayRows.push({
      kind: "OPERATION_REVIEW_HEADER",
      operationCount: unassignedOperations.length,
    });
    outlineLevels.push(0);
    for (const operation of unassignedOperations) {
      displayRows.push({ kind: "OPERATION", operation });
      outlineLevels.push(1);
    }
  }

  const expectedLength =
    presentationRows.length + operations.length + crossJournalDrilldown.rows.length +
    unassignedOperations.length +
    (unassignedOperations.length > 0 ? 1 : 0);
  if (displayRows.length !== expectedLength) {
    fail("Иерархическое представление потеряло строки операций.");
  }
  return {
    displayRows,
    outlineLevels,
    financialIndexes,
    crossJournalDrilldown: crossJournalDrilldown.audit,
  };
}
