function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value) {
  return text(value)
    .replace(/[«»"]/g, "")
    .toLocaleLowerCase("ru-RU");
}

function sourceIndentLevel(value) {
  let units = 0;
  for (const character of String(value ?? "")) {
    if (character === " " || character === "\u00a0") {
      units += 1;
    } else if (character === "\t") {
      units += 2;
    } else {
      break;
    }
  }
  if (units % 2 !== 0) {
    throw new Error(`Нечётный отступ иерархии Инталева: ${units}.`);
  }
  return units / 2;
}

function validOutlineLevel(value) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= 7 ? level : 0;
}

function validSha256(value) {
  return /^[A-F0-9]{64}$/.test(text(value).toUpperCase());
}

const EXACT_LIVE_INTALEV_STRUCTURAL_STATUSES = new Set([
  "MATCHED",
  "MATCHED_DUPLICATE_EXACT_IDENTITY",
  "MATCHED_DUPLICATE_HIERARCHY",
  "HIERARCHY_MISMATCH",
  "ZERO_NO_ACTIVITY",
  "ZERO_NO_ACTIVITY_DUPLICATE_PROVEN",
]);

function businessLabel(value) {
  return normalized(value)
    .replace(/^\d+[_\s.-]*/u, "")
    .replace(/^_+/u, "")
    .replace(/^(?:адм|ком|скл|лог)[_\s.-]+/u, "")
    .trim();
}

function provenLiveIntalevStructure(row) {
  const financialStatus = text(row.intalev?.status);
  const exactBusinessNode =
    financialStatus === "AMBIGUOUS" &&
    businessLabel(row.hierarchy_path?.at?.(-1)) === businessLabel(row.intalev_label);
  return row.intalev_hierarchy?.mapped === true &&
    normalized(row.hierarchy_source_system) === "intalev" &&
    (EXACT_LIVE_INTALEV_STRUCTURAL_STATUSES.has(financialStatus) || exactBusinessNode) &&
    text(row.hierarchy_node_id) &&
    Array.isArray(row.hierarchy_path) &&
    row.hierarchy_path.length > 0 &&
    Number.isInteger(Number(row.hierarchy_level));
}

function provenReferenceStructure(row) {
  return row.intalev_reference_status === "PROVEN_APPROVED_TEMPLATE_GRAPH" &&
    text(row.intalev_reference_graph_id) &&
    validSha256(row.intalev_reference_graph_sha256) &&
    validSha256(row.intalev_reference_template_sha256) &&
    text(row.intalev_reference_source_sheet) &&
    text(row.intalev_reference_source_cell) &&
    Array.isArray(row.intalev_reference_path_codes) &&
    row.intalev_reference_path_codes.at(-1) === text(row.code) &&
    text(row.intalev_reference_parent_code) === text(row.intalev_source_parent_code) &&
    Number(row.intalev_reference_outline_level) === Number(row.intalev_source_outline_level) &&
    text(row.intalev_source_outline_basis) === "APPROVED_INTALEV_TEMPLATE_GRAPH";
}

export function attachIntalevSourceHierarchy(rows) {
  const values = rows ?? [];
  const outlineLevels = values.map((row) => validOutlineLevel(row.hierarchy_level_raw));
  const useExcelOutline = outlineLevels.some((level) => level > 0);
  const stack = [];

  return values.map((row, index) => {
    const sourceLevel = useExcelOutline
      ? outlineLevels[index]
      : sourceIndentLevel(row.intalev_label_raw);
    while (stack.length > 0 && stack.at(-1).level >= sourceLevel) stack.pop();
    const parentCode = stack.at(-1)?.code ?? "";
    const enriched = {
      ...row,
      intalev_source_parent_code: parentCode,
      intalev_source_outline_level: sourceLevel,
      intalev_source_outline_basis: useExcelOutline
        ? "EXCEL_OUTLINE"
        : "INTALEV_LABEL_INDENT",
    };
    stack.push({ code: text(row.code), level: sourceLevel });
    return enriched;
  });
}

function pathParts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalized).filter(Boolean);
}

function expectedR005Codes() {
  return Array.from(
    { length: 65 },
    (_, index) => `R${String(index + 1).padStart(3, "0")}`,
  );
}

const PROVEN_CANONICAL_INTALEV_PROOFS = new Set([
  "PROVEN_LIVE_INTALEV",
  "PROVEN_APPROVED_TEMPLATE_GRAPH",
]);

export function attachCanonicalBindingStatuses(rows) {
  return rows.map((row) => {
    const liveIntalevStatus = text(
      row.intalev_live_hierarchy_status || row.intalev_hierarchy_status,
    ) || "UNPROVEN";
    const structuralProof = row.presentation_structural_proof ?? {};
    const canonicalIntalevProven =
      row.presentation_hierarchy_status === "HIERARCHY_PROVEN" &&
      PROVEN_CANONICAL_INTALEV_PROOFS.has(text(structuralProof.status)) &&
      structuralProof.erp_used !== true;

    const erpBindingStatus = text(row.erp_binding_status) || "UNPROVEN";

    return {
      ...row,
      intalev_live_hierarchy_status: liveIntalevStatus,
      intalev_hierarchy_status: canonicalIntalevProven ? "PROVEN" : "UNPROVEN",
      erp_binding_status: erpBindingStatus,
    };
  });
}

export function buildHierarchyPresentationRows(rows, options = {}) {
  const expectedCodes = options.expectedCodes ?? expectedR005Codes();
  if (
    rows.length !== expectedCodes.length ||
    !rows.every((row, index) => text(row.code) === expectedCodes[index])
  ) {
    throw new Error("Иерархическое представление требует полный набор R001–R065.");
  }

  const byCode = new Map(
    rows.map((row, sourceIndex) => [text(row.code), { row, sourceIndex }]),
  );
  const parentByCode = new Map();
  const parentBasisByCode = new Map();
  const sourceLevelByCode = new Map();
  const structuralProofByCode = new Map();
  const issuesByCode = new Map(
    expectedCodes.map((code) => [code, new Set()]),
  );
  const diagnosticsByCode = new Map(
    expectedCodes.map((code) => [code, new Set()]),
  );
  const pathByCode = new Map(
    expectedCodes.map((code) => [code, pathParts(byCode.get(code).row.hierarchy_path)]),
  );
  const isProperPathPrefix = (candidate, value) =>
    candidate.length > 0 &&
    candidate.length < value.length &&
    candidate.every((item, index) => item === value[index]);

  for (const code of expectedCodes) {
    const row = byCode.get(code).row;
    const reportParentProven = provenLiveIntalevStructure(row);
    const referenceParentProven = !reportParentProven && provenReferenceStructure(row);
    const sourceParent = reportParentProven
      ? text(row.hierarchy_parent_code)
      : referenceParentProven
        ? text(row.intalev_reference_parent_code)
        : "";
    const sourceLevel = validOutlineLevel(
      reportParentProven
        ? row.hierarchy_level
        : referenceParentProven
          ? row.intalev_reference_outline_level
          : 0,
    );
    parentBasisByCode.set(code, reportParentProven
      ? "INTALEV_REPORT_PARENT"
      : referenceParentProven
        ? "APPROVED_INTALEV_TEMPLATE_GRAPH"
        : "INTALEV_REFERENCE_PROOF_MISSING");
    structuralProofByCode.set(code, reportParentProven
      ? {
          status: "PROVEN_LIVE_INTALEV",
          system: "INTALEV",
          basis: "LIVE_INTALEV_TREE",
          node_id: text(row.hierarchy_node_id),
          parent_node_id: text(row.hierarchy_parent_node_id),
          parent_code: sourceParent,
          outline_level: sourceLevel,
          path: Array.isArray(row.hierarchy_path) ? [...row.hierarchy_path] : [],
          source: row.intalev_hierarchy?.source ?? null,
          erp_used: false,
        }
      : referenceParentProven
        ? {
            status: "PROVEN_APPROVED_TEMPLATE_GRAPH",
            system: "INTALEV",
            basis: "APPROVED_INTALEV_TEMPLATE_GRAPH",
            parent_code: sourceParent,
            outline_level: sourceLevel,
            path_codes: [...row.intalev_reference_path_codes],
            path_labels: Array.isArray(row.intalev_reference_path_labels)
              ? [...row.intalev_reference_path_labels]
              : [],
            graph_id: text(row.intalev_reference_graph_id),
            graph_sha256: text(row.intalev_reference_graph_sha256).toUpperCase(),
            template_sha256: text(row.intalev_reference_template_sha256).toUpperCase(),
            source_sheet: text(row.intalev_reference_source_sheet),
            source_row: Number(row.intalev_reference_source_row),
            source_cell: text(row.intalev_reference_source_cell),
            erp_used: false,
          }
        : {
            status: "HIERARCHY_UNPROVEN",
            system: "INTALEV",
            basis: "REFERENCE_PROOF_MISSING",
            parent_code: "",
            outline_level: 0,
            erp_used: false,
          });
    sourceLevelByCode.set(code, sourceLevel);
    if (!reportParentProven && !referenceParentProven) {
      issuesByCode.get(code).add("REFERENCE_INTALEV_STRUCTURE_UNPROVEN");
    }
    if (sourceParent === code) {
      parentByCode.set(code, "");
      issuesByCode.get(code).add("SOURCE_SELF_PARENT");
    } else if (sourceParent && !byCode.has(sourceParent)) {
      parentByCode.set(code, "");
      issuesByCode.get(code).add(`SOURCE_PARENT_MISSING:${sourceParent}`);
    } else {
      parentByCode.set(code, sourceParent);
    }

    if (sourceParent && byCode.has(sourceParent)) {
      const parentRow = byCode.get(sourceParent).row;
      const parentReportProven = provenLiveIntalevStructure(parentRow);
      const parentReferenceProven = !parentReportProven && provenReferenceStructure(parentRow);
      const parentLevel = validOutlineLevel(
        parentReportProven
          ? parentRow.hierarchy_level
          : parentReferenceProven
            ? parentRow.intalev_reference_outline_level
            : 0,
      );
      if (sourceLevel <= parentLevel) {
        const reason = `SOURCE_OUTLINE_NOT_DEEPER:${parentLevel}->${sourceLevel}`;
        issuesByCode.get(code).add(reason);
        parentByCode.set(code, "");
        parentBasisByCode.set(code, "INTALEV_REFERENCE_PROOF_CONFLICT");
        structuralProofByCode.set(code, {
          ...structuralProofByCode.get(code),
          status: "HIERARCHY_UNPROVEN",
          basis: "SOURCE_OUTLINE_CONFLICT",
          parent_code: "",
          reasons: [reason],
          erp_used: false,
        });
      }
    }

    const childPath = pathByCode.get(code);
    const pathCandidates = expectedCodes.filter((candidateCode) =>
      candidateCode !== code &&
      isProperPathPrefix(pathByCode.get(candidateCode), childPath),
    );
    if (pathCandidates.length > 0) {
      const longestPath = Math.max(
        ...pathCandidates.map((candidateCode) => pathByCode.get(candidateCode).length),
      );
      const closestCandidates = pathCandidates.filter(
        (candidateCode) => pathByCode.get(candidateCode).length === longestPath,
      );
      if (closestCandidates.length > 1) {
        diagnosticsByCode.get(code).add(
          `REPORT_PATH_PARENT_AMBIGUOUS:${closestCandidates.slice().sort().join(",")}->${sourceParent || "ROOT"}`,
        );
      }
      const reportPathParent = closestCandidates.length === 1 ? closestCandidates[0] : "";
      if (reportPathParent && reportPathParent !== sourceParent) {
        diagnosticsByCode.get(code).add(
          `REPORT_PATH_PARENT_DIFFERS:${reportPathParent}->${sourceParent || "ROOT"}`,
        );
      }
    }
  }

  const state = new Map();
  const stack = [];
  const cycleMembers = new Set();
  const detectCycle = (code) => {
    if (state.get(code) === 2) return;
    if (state.get(code) === 1) {
      const cycleStart = stack.indexOf(code);
      for (const member of stack.slice(Math.max(0, cycleStart))) {
        cycleMembers.add(member);
      }
      return;
    }
    state.set(code, 1);
    stack.push(code);
    const parent = parentByCode.get(code);
    if (parent) detectCycle(parent);
    stack.pop();
    state.set(code, 2);
  };
  for (const code of expectedCodes) detectCycle(code);
  for (const code of cycleMembers) {
    parentByCode.set(code, "");
    issuesByCode.get(code).add("SOURCE_CYCLE_BROKEN");
    parentBasisByCode.set(code, "INTALEV_REFERENCE_PROOF_MISSING");
    structuralProofByCode.set(code, {
      status: "HIERARCHY_UNPROVEN",
      system: "INTALEV",
      basis: "SOURCE_CYCLE_BROKEN",
      parent_code: "",
      outline_level: 0,
      erp_used: false,
    });
  }

  const childrenByCode = new Map(
    expectedCodes.map((code) => [code, []]),
  );
  const roots = [];
  for (const code of expectedCodes) {
    const parent = parentByCode.get(code);
    if (parent) childrenByCode.get(parent).push(code);
    else roots.push(code);
  }
  const sourceIndexOf = (code) => byCode.get(code).sourceIndex;
  roots.sort((left, right) => sourceIndexOf(left) - sourceIndexOf(right));
  for (const children of childrenByCode.values()) {
    children.sort((left, right) => sourceIndexOf(left) - sourceIndexOf(right));
  }

  const presentationRows = [];
  const append = (code, depth, ancestorUnproven = false) => {
    if (depth > 7) throw new Error(`Слишком глубокая иерархия ОПИУ: ${code}=${depth}.`);
    const { row, sourceIndex } = byCode.get(code);
    const structuralReasons = [...issuesByCode.get(code)];
    const diagnostics = [...diagnosticsByCode.get(code)];
    const intalevHierarchyStatus = text(row.intalev_hierarchy_status);
    if (intalevHierarchyStatus !== "PROVEN") {
      const sourceStatus = text(row.intalev_hierarchy?.status);
      diagnostics.push(`CURRENT_INTALEV_STATUS:${sourceStatus || "UNPROVEN"}`);
    }
    if (row.hierarchy_period_consistent !== true) {
      diagnostics.push("CURRENT_PERIOD_HIERARCHY_DRIFT");
    }
    if (!text(row.hierarchy_node_id)) diagnostics.push("CURRENT_NODE_ID_MISSING");
    if (!Array.isArray(row.hierarchy_path) || row.hierarchy_path.length === 0) {
      diagnostics.push("CURRENT_HIERARCHY_PATH_MISSING");
    }
    if (ancestorUnproven) structuralReasons.push("ANCESTOR_HIERARCHY_UNPROVEN");
    const unproven = structuralReasons.length > 0;
    const proof = structuralProofByCode.get(code);
    const sourceOutlineLevel = sourceLevelByCode.get(code);
    // The physical workbook contains only the matched R-rows, not every
    // technical wrapper from the source report.  Use the visible parent graph
    // for indentation; retain the original source depth in the separate audit
    // field so nothing is lost.
    const physicalOutlineLevel = unproven && !parentByCode.get(code)
      ? 0
      : depth;

    presentationRows.push({
      ...row,
      presentation_source_index: sourceIndex,
      presentation_parent_code: parentByCode.get(code),
      presentation_parent_basis: parentBasisByCode.get(code),
      presentation_depth: depth,
      presentation_source_outline_level: sourceOutlineLevel,
      presentation_outline_level: physicalOutlineLevel,
      presentation_hierarchy_status: unproven
        ? "HIERARCHY_UNPROVEN"
        : "HIERARCHY_PROVEN",
      presentation_structural_proof: unproven
        ? { ...proof, status: "HIERARCHY_UNPROVEN", reasons: structuralReasons }
        : proof,
      presentation_reason: [...structuralReasons, ...diagnostics].join("; "),
    });
    for (const child of childrenByCode.get(code)) {
      append(child, depth + 1, unproven);
    }
  };
  for (const root of roots) append(root, 0);

  if (
    presentationRows.length !== expectedCodes.length ||
    new Set(presentationRows.map((row) => row.code)).size !== expectedCodes.length ||
    expectedCodes.some((code) => !presentationRows.some((row) => row.code === code))
  ) {
    throw new Error("Иерархическое представление потеряло строки R001–R065.");
  }
  return presentationRows;
}
