function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalize(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\u00a0\s]+/g, " ")
    .trim();
}

function canonicalTemplateLabel(value) {
  return text(value).replace(/^\d+_/u, "").trim();
}

function pathParts(value) {
  return text(value).split(/\s*\/\s*/u).map(normalize).filter(Boolean);
}

function parentPath(value) {
  const parts = pathParts(value);
  return parts.slice(0, -1).join(" / ");
}

function pathEndsWithLabels(path, labels) {
  const parts = pathParts(path);
  const expected = labels.map(normalize).filter(Boolean);
  return expected.length > 0 && expected.length <= parts.length &&
    parts.slice(-expected.length).every((part, index) => part === expected[index]);
}

function exactPhysicalIdentity(row, period) {
  const sha256 = text(row?.sha256).toUpperCase();
  const sourceIdentity = text(row?.source_identity);
  const sourceScope = text(row?.source_identity_scope);
  const rowPeriod = text(row?.period_header_trace?.period ?? row?.period ?? period);
  return /^[A-F0-9]{64}$/.test(sha256) &&
    text(row?.sheet) !== "" &&
    /^[A-Z]+[1-9][0-9]*$/.test(text(row?.source_cell).toUpperCase()) &&
    sourceIdentity !== "" &&
    sourceScope !== "" &&
    rowPeriod === period;
}

function blocked(code, detail = {}) {
  return {
    status: code,
    amount: null,
    trace: [],
    component_rows: [],
    correction_authority: false,
    posting_rows: 0,
    blocker: { code, ...detail },
  };
}

function isCatalogDescendant(path, prefix) {
  const normalizedPath = normalize(path);
  const normalizedPrefix = normalize(prefix);
  return normalizedPath.startsWith(`${normalizedPrefix} / `);
}

function terminalCatalogRows(rows) {
  return rows.filter((candidate) => !rows.some((other) =>
    other !== candidate && isCatalogDescendant(other.catalog_path, candidate.catalog_path)));
}

export function resolveProvenErpTemplateParentComposition(templateRow, parsed, { tolerance = 0.01 } = {}) {
  const period = text(parsed?.period);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const label = canonicalTemplateLabel(templateRow?.erp_label || templateRow?.intalev_label);
  if (!label || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_INPUT_UNPROVEN", {
      code: text(templateRow?.code),
      label,
      period,
    });
  }
  const ancestorLabels = (Array.isArray(templateRow?.intalev_reference_path_labels)
    ? templateRow.intalev_reference_path_labels
    : [])
    .slice(0, -1)
    .map(canonicalTemplateLabel)
    .map(normalize)
    .filter(Boolean);
  const expectedPathLabels = [...ancestorLabels, normalize(label)];
  const candidates = rows.filter((row) => {
    const catalog = text(row?.catalog_path);
    return normalize(row?.article) === normalize(label) &&
      catalog.includes("|") &&
      typeof row?.amount === "number" &&
      exactPhysicalIdentity(row, period) &&
      pathEndsWithLabels(row?.full_path, expectedPathLabels);
  });
  if (candidates.length !== 1) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_SUMMARY_NOT_EXACT", {
      code: text(templateRow?.code),
      label,
      period,
      candidate_count: candidates.length,
      candidate_source_cells: candidates.map((row) => text(row?.source_cell)),
    });
  }

  const summary = candidates[0];
  const catalogPrefix = text(summary.catalog_path).split("|")[0].trim();
  const summaryParentPath = parentPath(summary.full_path);
  if (!catalogPrefix || !summaryParentPath) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_SUMMARY_SCOPE_UNPROVEN", {
      code: text(templateRow?.code),
      source_cell: text(summary.source_cell),
    });
  }
  const descendantCandidates = rows.filter((row) =>
    !text(row?.catalog_path).includes("|") &&
    isCatalogDescendant(row?.catalog_path, catalogPrefix) &&
    parentPath(row?.full_path) === summaryParentPath &&
    typeof row?.amount === "number" &&
    exactPhysicalIdentity(row, period) &&
    text(row?.source_identity_scope) === text(summary.source_identity_scope));
  const components = terminalCatalogRows(descendantCandidates);
  if (components.length === 0) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_COMPONENTS_MISSING", {
      code: text(templateRow?.code),
      catalog_prefix: catalogPrefix,
      source_cell: text(summary.source_cell),
    });
  }
  const componentIdentities = new Set(components.map((row) => text(row.source_identity)));
  if (componentIdentities.size !== components.length) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_COMPONENT_IDENTITY_CONFLICT", {
      code: text(templateRow?.code),
      component_source_cells: components.map((row) => text(row.source_cell)),
    });
  }
  const componentAmount = components.reduce((sum, row) => sum + row.amount, 0);
  if (Math.abs(componentAmount - summary.amount) > Math.abs(Number(tolerance))) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_AMOUNT_MISMATCH", {
      code: text(templateRow?.code),
      summary_amount: summary.amount,
      component_amount: componentAmount,
      summary_source_cell: text(summary.source_cell),
      component_source_cells: components.map((row) => text(row.source_cell)),
    });
  }

  const summaryTrace = { ...summary, exact_parent_summary: true };
  const componentTrace = components.map((row) => ({ ...row, exact_parent_component: true }));
  return {
    status: "PROVEN_ERP_PARENT_COMPOSITION",
    amount: Math.round((summary.amount + Number.EPSILON) * 100) / 100,
    trace: [summaryTrace, ...componentTrace],
    summary_row: summaryTrace,
    component_rows: componentTrace,
    component_source_cells: componentTrace.map((row) => text(row.source_cell)),
    catalog_prefix: catalogPrefix,
    correction_authority: false,
    posting_rows: 0,
    note:
      `ERP parent ${text(templateRow?.code) || label}: exact source summary ${text(summary.source_cell)} ` +
      `equals ${components.length} terminal catalog components; components consumed once.`,
  };
}

/**
 * Resolve a duplicated ERP presentation label only when the source itself
 * distinguishes exactly one parent row from one or more same-label leaves.
 * Template parenthood is supplied by the caller from the signed template
 * graph; amounts, periods, organizations and business labels are not
 * hardcoded here.
 */
export function resolveProvenErpPresentationParent(
  templateRow,
  parsed,
  { templateHasChildren = false } = {},
) {
  const period = text(parsed?.period);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const label = canonicalTemplateLabel(templateRow?.erp_label || templateRow?.intalev_label);
  const expectedPathLabels = (Array.isArray(templateRow?.intalev_reference_path_labels)
    ? templateRow.intalev_reference_path_labels
    : [])
    .map(canonicalTemplateLabel)
    .map(normalize)
    .filter(Boolean);
  if (
    !templateHasChildren || !label || expectedPathLabels.length === 0 ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  ) {
    return blocked("BLOCKED_ERP_PRESENTATION_PARENT_INPUT_UNPROVEN", {
      code: text(templateRow?.code),
      label,
      period,
      template_has_children: templateHasChildren === true,
    });
  }
  const candidates = rows.filter((row) =>
    normalize(row?.article || row?.summary_label) === normalize(label) &&
    typeof row?.amount === "number" &&
    exactPhysicalIdentity(row, period) &&
    pathEndsWithLabels(row?.full_path, expectedPathLabels));
  const parentCandidates = candidates.filter((row) =>
    Array.isArray(row?.child_indexes) && row.child_indexes.length > 0);
  const leafCandidates = candidates.filter((row) =>
    !Array.isArray(row?.child_indexes) || row.child_indexes.length === 0);
  if (candidates.length < 2 || parentCandidates.length !== 1 || leafCandidates.length === 0) {
    return blocked("BLOCKED_ERP_PRESENTATION_PARENT_NOT_EXACT", {
      code: text(templateRow?.code),
      label,
      period,
      candidate_count: candidates.length,
      parent_candidate_count: parentCandidates.length,
      leaf_candidate_count: leafCandidates.length,
      candidate_source_cells: candidates.map((row) => text(row?.source_cell)),
    });
  }
  const parent = parentCandidates[0];
  const children = parent.child_indexes.map((index) => rows[index]).filter(Boolean);
  if (
    children.length !== parent.child_indexes.length ||
    children.length === 0 ||
    children.some((row) =>
      !exactPhysicalIdentity(row, period) ||
      text(row?.source_identity_scope) !== text(parent?.source_identity_scope))
  ) {
    return blocked("BLOCKED_ERP_PRESENTATION_PARENT_CHILD_IDENTITY_UNPROVEN", {
      code: text(templateRow?.code),
      source_cell: text(parent?.source_cell),
      child_source_cells: children.map((row) => text(row?.source_cell)),
    });
  }
  return {
    status: "PROVEN_ERP_PRESENTATION_PARENT",
    amount: Math.round((parent.amount + Number.EPSILON) * 100) / 100,
    trace: [{ ...parent, exact_presentation_parent: true }],
    source_cell: text(parent.source_cell),
    child_source_cells: children.map((row) => text(row.source_cell)),
    correction_authority: false,
    posting_rows: 0,
    note:
      `ERP presentation parent ${text(templateRow?.code) || label}: exact source row ` +
      `${text(parent.source_cell)} selected over ${leafCandidates.length} same-label leaf row(s) ` +
      "because the signed template declares descendants and the source row has exact children.",
  };
}

/**
 * Bind a signed-template descendant to the same exact source composition as
 * its proven parent only when the ERP source exposes a unique same-total
 * sibling summary under the same physical parent and source scope. This is a
 * presentation alias; the component rows remain one shared economic set.
 */
export function resolveProvenErpCompositionAlias(templateRow, parsed, parentResult) {
  const period = text(parsed?.period);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const label = canonicalTemplateLabel(templateRow?.erp_label || templateRow?.intalev_label);
  const parentTrace = Array.isArray(parentResult?.trace) ? parentResult.trace : [];
  const parentSummary = parentTrace.find((row) => row?.exact_parent_summary === true);
  const components = parentTrace.filter((row) => row?.exact_parent_component === true);
  if (
    !label || !parentSummary || components.length === 0 ||
    typeof parentResult?.amount !== "number" ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)
  ) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_ALIAS_INPUT_UNPROVEN", {
      code: text(templateRow?.code),
      label,
      period,
    });
  }
  const candidates = rows.filter((row) =>
    row !== parentSummary &&
    normalize(row?.article) === normalize(label) &&
    text(row?.catalog_path).includes("|") &&
    typeof row?.amount === "number" &&
    Math.abs(row.amount - parentResult.amount) <= 0.01 &&
    row?.parent_index === parentSummary?.parent_index &&
    text(row?.source_identity_scope) === text(parentSummary?.source_identity_scope) &&
    exactPhysicalIdentity(row, period));
  if (candidates.length !== 1) {
    return blocked("BLOCKED_ERP_PARENT_COMPOSITION_ALIAS_NOT_EXACT", {
      code: text(templateRow?.code),
      label,
      period,
      candidate_count: candidates.length,
      candidate_source_cells: candidates.map((row) => text(row?.source_cell)),
    });
  }
  const alias = { ...candidates[0], exact_parent_alias_summary: true };
  return {
    status: "PROVEN_ERP_PARENT_COMPOSITION_ALIAS",
    amount: parentResult.amount,
    trace: [alias, ...components],
    alias_source_cell: text(alias.source_cell),
    component_source_cells: components.map((row) => text(row.source_cell)),
    correction_authority: false,
    posting_rows: 0,
    note:
      `ERP composition alias ${text(templateRow?.code) || label}: exact sibling source summary ` +
      `${text(alias.source_cell)} shares the proven parent component set; components are not consumed twice.`,
  };
}
