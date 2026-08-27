function defaultNormalize(value) {
  return String(value ?? "").trim();
}

function defaultFail(message) {
  throw new Error(message);
}

// Presentation-only expansion. It never changes financial amounts, evidence
// classes, correction rows or release gates; it only places already-read
// journal rows into the review tree.
export function buildOperationTreePresentation({
  presentationRows,
  financialOutlineLevels,
  operationEvidence,
  normalize = defaultNormalize,
  fail = defaultFail,
}) {
  const operations = Array.isArray(operationEvidence?.rows)
    ? operationEvidence.rows
    : [];
  const unassignedOperations = Array.isArray(operationEvidence?.unassigned_rows)
    ? operationEvidence.unassigned_rows
    : [];
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

  const knownCodes = new Set(presentationRows.map((row) => row.code));
  const unknownParents = [...byParent.keys()].filter((code) => !knownCodes.has(code));
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
    presentationRows.length + operations.length + unassignedOperations.length +
    (unassignedOperations.length > 0 ? 1 : 0);
  if (displayRows.length !== expectedLength) {
    fail("Иерархическое представление потеряло строки операций.");
  }
  return { displayRows, outlineLevels, financialIndexes };
}
