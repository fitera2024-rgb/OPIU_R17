export const INTALEV_SOURCE_SCOPE_SCHEMA = "opiu-intalev-source-scope.v1";

const UNCLASSIFIED_LABELS = new Set([
  "",
  "<ПУСТОЕ ЗНАЧЕНИЕ>",
  "<ПУСТАЯ СТАТЬЯ>",
  "EMPTY",
  "UNCLASSIFIED",
]);

const INTALEV_SOURCE_SCOPE_PRESENCE_STATES = new Set([
  "ABSENT_PROVEN",
  "ABSENCE_UNPROVEN",
  "PRESENT_CLASSIFIED",
  "PRESENT_UNCLASSIFIED",
  "PRESENT_UNCLASSIFIED_UNBOUND",
]);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function booleanEvidence(input, canonicalField, legacyField) {
  if (Object.hasOwn(input ?? {}, canonicalField)) return input?.[canonicalField] === true;
  return input?.[legacyField] === true;
}

function lossEvidence(input) {
  if (Object.hasOwn(input ?? {}, "intalev_source_amount_lost")) {
    return input?.intalev_source_amount_lost;
  }
  return input?.source_amount_lost;
}

export function relevantIntalevAbsenceProof(input = {}) {
  const presence = upper(input?.intalev_source_scope_presence);
  const canonicalAbsenceState = presence === "ABSENT_PROVEN";
  const absenceExplicitlyProven = input?.intalev_source_scope_absence_proven === true;
  const sourceInventoryComplete = booleanEvidence(
    input,
    "intalev_source_scope_inventory_complete",
    "source_inventory_complete",
  );
  const sourceScopeComplete = booleanEvidence(
    input,
    "intalev_source_scope_complete",
    "source_scope_complete",
  );
  const sourceAmountLost = lossEvidence(input);
  const blockers = [];
  if (!presence) blockers.push("INTALEV_SOURCE_SCOPE_PRESENCE_MISSING");
  else if (!INTALEV_SOURCE_SCOPE_PRESENCE_STATES.has(presence)) {
    blockers.push("NONCANONICAL_INTALEV_SOURCE_SCOPE_PRESENCE");
  }
  if (presence.startsWith("PRESENT_")) blockers.push("INTALEV_ECONOMIC_PRESENCE_PROVEN");
  if (!canonicalAbsenceState) blockers.push("RELEVANT_INTALEV_ABSENCE_STATE_NOT_ABSENT_PROVEN");
  if (!sourceInventoryComplete) blockers.push("RELEVANT_INTALEV_SOURCE_INVENTORY_INCOMPLETE");
  if (!sourceScopeComplete) blockers.push("RELEVANT_INTALEV_SOURCE_SCOPE_INCOMPLETE");
  if (sourceAmountLost !== false) blockers.push("RELEVANT_INTALEV_SOURCE_AMOUNT_LOST_OR_UNKNOWN");
  if (!absenceExplicitlyProven) blockers.push("RELEVANT_INTALEV_ABSENCE_NOT_EXPLICITLY_PROVEN");
  return Object.freeze({
    proven: blockers.length === 0,
    presence,
    canonical_absence_state: canonicalAbsenceState,
    absence_explicitly_proven: absenceExplicitlyProven,
    source_inventory_complete: sourceInventoryComplete,
    source_scope_complete: sourceScopeComplete,
    source_amount_lost: sourceAmountLost === true
      ? true
      : sourceAmountLost === false ? false : null,
    blockers: Object.freeze(blockers),
  });
}

export function relevantIntalevAbsenceProven(input = {}) {
  return relevantIntalevAbsenceProof(input).proven;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cents(value) {
  return finite(value) ? Math.round(value * 100) : null;
}

function amount(value) {
  return value === null ? null : value / 100;
}

function nodeAmountCents(node) {
  for (const value of [node?.amount, node?.value, node?.source_amount]) {
    const result = cents(value);
    if (result !== null) return result;
  }
  return null;
}

function physicalSourceRow(node) {
  if (Object.hasOwn(node ?? {}, "physical_row")) return node.physical_row;
  if (Object.hasOwn(node ?? {}, "row")) return node.row;
  return undefined;
}

function provenNonContributingSourceNode(node) {
  const physicalRow = physicalSourceRow(node);
  return nodeAmountCents(node) === null
    && node?.source_cell_present === true
    && upper(node?.source_value_kind) === "BLANK"
    && Boolean(text(node?.source_cell))
    && typeof physicalRow === "number"
    && Number.isFinite(physicalRow)
    && Number.isInteger(physicalRow)
    && physicalRow > 0;
}

function sourceNodeInventoryStatus(nodes, childrenByIndex, index) {
  if (inferAmountCents(nodes, childrenByIndex, index) !== null) {
    return "ECONOMIC_AMOUNT_ACCOUNTED";
  }
  if (provenNonContributingSourceNode(nodes[index])) {
    return "PHYSICAL_BLANK_NONCONTRIBUTING";
  }
  return "BLOCKED_ECONOMIC_AMOUNT_MISSING";
}

function sourceArticleLabel(node) {
  if (Object.hasOwn(node ?? {}, "article")) return text(node.article);
  if (Object.hasOwn(node ?? {}, "source_article")) return text(node.source_article);
  if (Object.hasOwn(node ?? {}, "source_label_raw")) return text(node.source_label_raw);
  return text(node?.label);
}

export function isBlankIntalevArticleLabel(value) {
  return UNCLASSIFIED_LABELS.has(upper(value));
}

export function classifyIntalevArticleLabel(value) {
  return isBlankIntalevArticleLabel(value) ? "UNCLASSIFIED" : "CLASSIFIED";
}

function nodeIsUnclassified(node) {
  const explicit = upper(node?.article_classification ?? node?.classification);
  if (["UNCLASSIFIED", "EMPTY_ARTICLE"].includes(explicit)) return true;
  if (explicit === "CLASSIFIED") return false;
  return isBlankIntalevArticleLabel(sourceArticleLabel(node));
}

function buildHierarchy(nodes) {
  const parentByIndex = new Map();
  const childrenByIndex = new Map(nodes.map((_, index) => [index, []]));
  const stack = [];
  nodes.forEach((node, index) => {
    const level = Number.isInteger(Number(node?.level)) && Number(node.level) >= 0
      ? Number(node.level)
      : 0;
    while (stack.length > level) stack.pop();
    const parentIndex = level > 0 ? stack[level - 1] : undefined;
    if (Number.isInteger(parentIndex)) {
      parentByIndex.set(index, parentIndex);
      childrenByIndex.get(parentIndex).push(index);
    }
    stack[level] = index;
    stack.length = level + 1;
  });
  return { parentByIndex, childrenByIndex };
}

function inferAmountCents(nodes, childrenByIndex, index, visiting = new Set()) {
  const direct = nodeAmountCents(nodes[index]);
  if (direct !== null) return direct;
  if (visiting.has(index)) return null;
  visiting.add(index);
  const children = childrenByIndex.get(index) ?? [];
  if (children.length === 0) return null;
  const values = children.map((childIndex) =>
    inferAmountCents(nodes, childrenByIndex, childIndex, visiting));
  visiting.delete(index);
  return values.some((value) => value === null)
    ? null
    : values.reduce((sum, value) => sum + value, 0);
}

function subtreeIndexes(nodes, rootIndex) {
  const rootLevel = Number(nodes[rootIndex]?.level ?? 0);
  const result = [rootIndex];
  for (let index = rootIndex + 1; index < nodes.length; index += 1) {
    if (Number(nodes[index]?.level ?? 0) <= rootLevel) break;
    result.push(index);
  }
  return result;
}

function sourceEvidence(node) {
  return {
    source_file: text(node?.source_file),
    sheet: text(node?.sheet),
    source_cell: text(node?.source_cell),
    source_row: node?.physical_row ?? node?.row ?? null,
    source_path: text(node?.full_path),
    source_label: text(node?.source_label_raw ?? node?.label),
    source_sha256: text(node?.sha256),
  };
}

function unclassifiedItem(node, {
  branchRoot = false,
  inherited = false,
  sourceScopeId = "",
  sourceScopePath = "",
  branchRootSourcePath = "",
  branchRootLevel = 0,
  sourceIsLeaf = false,
} = {}) {
  const value = nodeAmountCents(node);
  if (value === null) return null;
  const sourceOutlineLevel = Number(node?.level ?? 0);
  return {
    classification: "UNCLASSIFIED",
    article: "",
    amount: amount(value),
    period: text(node?.period ?? node?.month),
    source_scope_role: branchRoot ? "UNCLASSIFIED_BRANCH" : "UNCLASSIFIED_DETAIL",
    contributes_to_unclassified_total: branchRoot,
    classification_basis: inherited ? "EMPTY_ARTICLE_ANCESTOR" : "EMPTY_ARTICLE",
    source_scope_id: sourceScopeId,
    source_scope_path: sourceScopePath,
    blank_branch_source_path: branchRootSourcePath,
    source_parent_path: text(node?.parent_path),
    source_outline_level: sourceOutlineLevel,
    source_scope_relative_level: Math.max(0, sourceOutlineLevel - branchRootLevel),
    source_is_leaf: sourceIsLeaf,
    ...sourceEvidence(node),
  };
}

function scopeForParent({ nodes, parentIndex, blankIndexes, childrenByIndex, toleranceCents }) {
  const children = childrenByIndex.get(parentIndex) ?? [];
  const blankSet = new Set(blankIndexes);
  const classifiedIndexes = children.filter((index) => !blankSet.has(index));
  const allInCents = inferAmountCents(nodes, childrenByIndex, parentIndex);
  const blankValues = blankIndexes.map((index) => inferAmountCents(nodes, childrenByIndex, index));
  const classifiedValues = classifiedIndexes.map((index) =>
    inferAmountCents(nodes, childrenByIndex, index));
  const complete = allInCents !== null
    && blankValues.every((value) => value !== null)
    && classifiedValues.every((value) => value !== null);
  const blankCents = blankValues.every((value) => value !== null)
    ? blankValues.reduce((sum, value) => sum + value, 0)
    : null;
  const classifiedCents = classifiedValues.every((value) => value !== null)
    ? classifiedValues.reduce((sum, value) => sum + value, 0)
    : null;
  const deltaCents = complete ? allInCents - blankCents - classifiedCents : null;
  const status = !complete
    ? "BLOCKED_UNEXPLAINED_LOSS"
    : Math.abs(deltaCents) <= toleranceCents
      ? "PASS"
      : "BLOCKED_UNEXPLAINED_LOSS";
  return {
    source_scope_id: [
      text(nodes[parentIndex]?.period),
      text(nodes[parentIndex]?.source_identity ?? nodes[parentIndex]?.full_path),
      nodes[parentIndex]?.physical_row ?? nodes[parentIndex]?.row ?? parentIndex,
    ].join("|"),
    source_scope_path: text(nodes[parentIndex]?.full_path),
    intalev_all_in_control_total: amount(allInCents),
    intalev_classified_subtotal: amount(classifiedCents),
    intalev_blank_unclassified_total: amount(blankCents),
    explicitly_represented_other_total: 0,
    arithmetic_preservation_delta: amount(deltaCents),
    arithmetic_preservation_status: status,
    source_amount_lost: status !== "PASS",
    all_in_control_source: sourceEvidence(nodes[parentIndex]),
    classified_sources: classifiedIndexes.map((index) => sourceEvidence(nodes[index])),
    blank_branch_sources: blankIndexes.map((index) => sourceEvidence(nodes[index])),
  };
}

export function buildIntalevSourceScopeDiagnostics({
  period = "",
  nodes = [],
  tolerance = 0.01,
} = {}) {
  const sourceNodes = Array.isArray(nodes) ? nodes : [];
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const { parentByIndex, childrenByIndex } = buildHierarchy(sourceNodes);
  const unclassifiedIndexes = sourceNodes
    .map((node, index) => nodeIsUnclassified(node) ? index : -1)
    .filter((index) => index >= 0);
  const topmostBlankIndexes = unclassifiedIndexes.filter((index) => {
    let parentIndex = parentByIndex.get(index);
    while (Number.isInteger(parentIndex)) {
      if (nodeIsUnclassified(sourceNodes[parentIndex])) return false;
      parentIndex = parentByIndex.get(parentIndex);
    }
    return true;
  });
  const blankByParent = new Map();
  for (const index of topmostBlankIndexes) {
    const parentIndex = parentByIndex.get(index);
    if (!Number.isInteger(parentIndex)) continue;
    if (!blankByParent.has(parentIndex)) blankByParent.set(parentIndex, []);
    blankByParent.get(parentIndex).push(index);
  }
  const scopeEntries = [...blankByParent.entries()].map(([parentIndex, blankIndexes]) => ({
    parentIndex,
    blankIndexes,
    scope: scopeForParent({
      nodes: sourceNodes,
      parentIndex,
      blankIndexes,
      childrenByIndex,
      toleranceCents,
    }),
  }));
  const scopes = scopeEntries.map((entry) => entry.scope);
  const scopeByParent = new Map(
    scopeEntries.map((entry) => [entry.parentIndex, entry.scope]),
  );
  const rankedScopes = [...scopes].sort((left, right) => {
    const statusOrder = Number(right.arithmetic_preservation_status === "PASS")
      - Number(left.arithmetic_preservation_status === "PASS");
    if (statusOrder !== 0) return statusOrder;
    return Math.abs(right.intalev_all_in_control_total ?? 0)
      - Math.abs(left.intalev_all_in_control_total ?? 0);
  });
  const primary = rankedScopes[0] ?? null;
  const items = [];
  const seenItems = new Set();
  for (const rootIndex of topmostBlankIndexes) {
    const parentIndex = parentByIndex.get(rootIndex);
    const scope = scopeByParent.get(parentIndex);
    const branchRootLevel = Number(sourceNodes[rootIndex]?.level ?? 0);
    for (const index of subtreeIndexes(sourceNodes, rootIndex)) {
      const item = unclassifiedItem(sourceNodes[index], {
        branchRoot: index === rootIndex,
        inherited: index !== rootIndex,
        sourceScopeId: scope?.source_scope_id ?? "",
        sourceScopePath: scope?.source_scope_path ?? "",
        branchRootSourcePath: text(sourceNodes[rootIndex]?.full_path),
        branchRootLevel,
        sourceIsLeaf: (childrenByIndex.get(index) ?? []).length === 0,
      });
      if (!item) continue;
      const key = [
        item.source_sha256,
        item.sheet,
        item.source_cell,
        item.source_row,
        item.amount,
      ].join("|");
      if (seenItems.has(key)) continue;
      seenItems.add(key);
      items.push(item);
    }
  }
  const blockedScopes = scopes.filter(
    (scope) => scope.arithmetic_preservation_status !== "PASS");
  const sourceInventory = sourceNodes.map((node, index) => ({
    index,
    status: sourceNodeInventoryStatus(sourceNodes, childrenByIndex, index),
    ...sourceEvidence(node),
  }));
  const sourceInventoryComplete = sourceNodes.length > 0
    && sourceInventory.every((item) => item.status !== "BLOCKED_ECONOMIC_AMOUNT_MISSING");
  return {
    schema: INTALEV_SOURCE_SCOPE_SCHEMA,
    period: text(period || sourceNodes[0]?.period),
    source_inventory_complete: sourceInventoryComplete,
    status: !sourceInventoryComplete || blockedScopes.length > 0
      ? "BLOCKED_UNEXPLAINED_LOSS"
      : items.length > 0
        ? "UNCLASSIFIED_PRESERVED"
        : "NO_UNCLASSIFIED_SOURCE",
    source_scope_complete: sourceInventoryComplete && blockedScopes.length === 0,
    source_inventory: {
      accounted_economic_nodes: sourceInventory.filter(
        (item) => item.status === "ECONOMIC_AMOUNT_ACCOUNTED").length,
      proven_noncontributing_nodes: sourceInventory.filter(
        (item) => item.status === "PHYSICAL_BLANK_NONCONTRIBUTING").length,
      blocked_missing_amount_nodes: sourceInventory.filter(
        (item) => item.status === "BLOCKED_ECONOMIC_AMOUNT_MISSING"),
    },
    intalev_all_in_control_total: primary?.intalev_all_in_control_total ?? null,
    intalev_classified_subtotal: primary?.intalev_classified_subtotal ?? null,
    intalev_blank_unclassified_total: primary?.intalev_blank_unclassified_total ?? 0,
    arithmetic_preservation_delta: primary?.arithmetic_preservation_delta ?? null,
    arithmetic_preservation_status: primary?.arithmetic_preservation_status
      ?? (items.length > 0 ? "NOT_AVAILABLE" : "NOT_APPLICABLE"),
    source_amount_lost: !sourceInventoryComplete || blockedScopes.length > 0,
    unclassified_items: items,
    source_scopes: scopes,
    financial_posting_authority: 0,
    financial_posting_rows: 0,
    storno_authorized: false,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
  };
}

function reportingPath(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function pathIsWithin(candidate, ancestor) {
  const normalizedCandidate = reportingPath(candidate);
  const normalizedAncestor = reportingPath(ancestor);
  return Boolean(normalizedCandidate && normalizedAncestor) && (
    normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(`${normalizedAncestor} / `)
  );
}

function rowTraceMatchesPaths(row, paths) {
  const ancestors = (Array.isArray(paths) ? paths : [paths])
    .map(reportingPath)
    .filter(Boolean);
  if (ancestors.length === 0) return false;
  return (row?.intalev?.trace ?? []).some((trace) => {
    const candidate = reportingPath(trace?.full_path ?? trace?.source_path);
    return ancestors.some((ancestor) => pathIsWithin(candidate, ancestor));
  });
}

function itemReportingKey(item) {
  return [
    text(item?.source_sha256),
    text(item?.sheet),
    text(item?.source_cell),
    item?.source_row ?? "",
    item?.amount ?? "",
  ].join("|");
}

function itemAsTrace(item) {
  return {
    full_path: text(item?.source_path),
    source_path: text(item?.source_path),
    parent_path: text(item?.source_parent_path),
    article: "",
    article_classification: "UNCLASSIFIED",
    amount: item?.amount,
    value: item?.amount,
    period: text(item?.period),
    month: text(item?.period),
    source_file: text(item?.source_file),
    sheet: text(item?.sheet),
    source_cell: text(item?.source_cell),
    row: item?.source_row ?? null,
    physical_row: item?.source_row ?? null,
    sha256: text(item?.source_sha256),
  };
}

function uniqueRows(rows) {
  return rows.length === 1 ? rows[0] : null;
}

function reportingOwnerForScope(rows, scope, toleranceCents) {
  const allInCents = cents(scope?.intalev_all_in_control_total);
  const classifiedCents = cents(scope?.intalev_classified_subtotal);
  const scopePath = text(scope?.all_in_control_source?.source_path ?? scope?.source_scope_path);
  const classifiedPaths = (scope?.classified_sources ?? [])
    .map((source) => source?.source_path)
    .filter(Boolean);
  const numericRows = rows.filter((row) => cents(row?.intalev?.amount) !== null);
  const allInCandidates = numericRows.filter((row) =>
    allInCents !== null &&
    Math.abs(cents(row.intalev.amount) - allInCents) <= toleranceCents &&
    rowTraceMatchesPaths(row, scopePath));
  const allInOwner = uniqueRows(allInCandidates);
  if (allInOwner) return { row: allInOwner, mode: "ALL_IN_ALREADY_REPRESENTED" };

  const classifiedCandidates = numericRows.filter((row) =>
    classifiedCents !== null &&
    Math.abs(cents(row.intalev.amount) - classifiedCents) <= toleranceCents &&
    rowTraceMatchesPaths(row, classifiedPaths));
  const classifiedOwner = uniqueRows(classifiedCandidates);
  if (classifiedOwner) return { row: classifiedOwner, mode: "CLASSIFIED_REQUIRES_ALL_IN" };

  const amountOnlyAllIn = uniqueRows(numericRows.filter((row) =>
    allInCents !== null &&
    Math.abs(cents(row.intalev.amount) - allInCents) <= toleranceCents));
  return amountOnlyAllIn
    ? { row: amountOnlyAllIn, mode: "ALL_IN_ALREADY_REPRESENTED" }
    : null;
}

function reportingDescendantOf(code, ownerCode, parentByCode) {
  let current = text(code);
  const owner = text(ownerCode);
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (current === owner) return true;
    visited.add(current);
    current = text(parentByCode.get(current));
  }
  return false;
}

function appendUniqueTrace(existing, item) {
  const key = itemReportingKey(item);
  const result = Array.isArray(existing) ? [...existing] : [];
  const alreadyPresent = result.some((trace) => itemReportingKey({
    source_sha256: trace?.sha256 ?? trace?.source_sha256,
    sheet: trace?.sheet,
    source_cell: trace?.source_cell,
    source_row: trace?.physical_row ?? trace?.row ?? trace?.source_row,
    amount: trace?.amount ?? trace?.value,
  }) === key);
  if (!alreadyPresent) result.push(itemAsTrace(item));
  return result;
}

export function applyIntalevBlankArticleReporting({
  rows = [],
  sourceScope = null,
  tolerance = 0.01,
} = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const reportingRows = sourceRows.map((row) => ({
    ...row,
    intalev: {
      ...(row?.intalev ?? {}),
      trace: [...(row?.intalev?.trace ?? [])],
    },
    erp: { ...(row?.erp ?? {}) },
  }));
  const rowByCode = new Map(reportingRows.map((row) => [text(row?.code), row]));
  const parentByCode = new Map(
    reportingRows.map((row) => [
      text(row?.code),
      text(row?.presentation_parent_code ?? row?.parent_code),
    ]),
  );
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const scopes = sourceScope?.source_scopes ?? [];
  const allItems = sourceScope?.unclassified_items ?? [];
  const bindings = [];
  const displayScopes = [];
  const adjustmentByCode = new Map();

  for (const scope of scopes) {
    if (scope?.arithmetic_preservation_status !== "PASS") continue;
    const owner = reportingOwnerForScope(reportingRows, scope, toleranceCents);
    if (!owner?.row?.code) continue;
    const ownerCode = text(owner.row.code);
    const scopeItems = allItems.filter(
      (item) => text(item?.source_scope_id) === text(scope?.source_scope_id),
    );
    const leafItems = scopeItems.filter(
      (item) => item?.source_is_leaf === true && item?.contributes_to_unclassified_total !== true,
    );
    const blankCents = cents(scope?.intalev_blank_unclassified_total) ?? 0;
    const leafTotalCents = leafItems.reduce((sum, item) => sum + (cents(item?.amount) ?? 0), 0);
    const bindingItems = leafItems.length > 0 && Math.abs(leafTotalCents - blankCents) <= toleranceCents
      ? leafItems
      : scopeItems.filter((item) => item?.contributes_to_unclassified_total === true);
    const scopeBindings = [];

    if (owner.mode === "CLASSIFIED_REQUIRES_ALL_IN") {
      const itemsByAmount = new Map();
      for (const item of bindingItems) {
        const key = cents(item?.amount);
        if (key === null) continue;
        if (!itemsByAmount.has(key)) itemsByAmount.set(key, []);
        itemsByAmount.get(key).push(item);
      }
      const erpRowsByAmount = new Map();
      for (const row of reportingRows) {
        const code = text(row?.code);
        const erpCents = cents(row?.erp?.amount);
        if (
          !code || code === ownerCode || erpCents === null ||
          cents(row?.intalev?.amount) !== null ||
          !reportingDescendantOf(code, ownerCode, parentByCode)
        ) continue;
        if (!erpRowsByAmount.has(erpCents)) erpRowsByAmount.set(erpCents, []);
        erpRowsByAmount.get(erpCents).push(row);
      }
      for (const [bindingCents, candidates] of itemsByAmount.entries()) {
        const targetRows = erpRowsByAmount.get(bindingCents) ?? [];
        if (candidates.length !== 1 || targetRows.length !== 1) continue;
        const item = candidates[0];
        const target = targetRows[0];
        const binding = {
          source_scope_id: text(scope?.source_scope_id),
          owner_code: ownerCode,
          target_code: text(target?.code),
          amount: amount(bindingCents),
          article: "",
          erp_article: text(target?.erp_label),
          source_path: text(item?.source_path),
          source_file: text(item?.source_file),
          source_sheet: text(item?.sheet),
          source_cell: text(item?.source_cell),
          source_row: item?.source_row ?? null,
          source_sha256: text(item?.source_sha256),
          match_basis: "EXACT_UNIQUE_REPORT_AMOUNT_WITHIN_ALL_IN_OWNER",
          physical_posting_proven: false,
          physical_posting_fields_invented: false,
          classification: "UNCLASSIFIED / EMPTY_ARTICLE",
          correction_allowed: false,
          financial_posting_rows: 0,
        };
        bindings.push(binding);
        scopeBindings.push(binding);
        let code = text(target?.code);
        const visited = new Set();
        while (code && !visited.has(code)) {
          visited.add(code);
          if (!adjustmentByCode.has(code)) adjustmentByCode.set(code, []);
          adjustmentByCode.get(code).push({ binding, item, cents: bindingCents });
          if (code === ownerCode) break;
          code = text(parentByCode.get(code));
        }
      }
    }

    const displayItems = scopeItems.some(
      (item) => item?.contributes_to_unclassified_total !== true)
      ? scopeItems.filter((item) => item?.contributes_to_unclassified_total !== true)
      : scopeItems;
    const bindingByItem = new Map(
      scopeBindings.map((binding) => [
        itemReportingKey({
          source_sha256: binding.source_sha256,
          sheet: binding.source_sheet,
          source_cell: binding.source_cell,
          source_row: binding.source_row,
          amount: binding.amount,
        }),
        binding,
      ]),
    );
    displayScopes.push({
      source_scope_id: text(scope?.source_scope_id),
      source_scope_path: text(scope?.source_scope_path),
      owner_code: ownerCode,
      owner_mode: owner.mode,
      blank_amount: scope?.intalev_blank_unclassified_total ?? 0,
      all_in_amount: scope?.intalev_all_in_control_total ?? null,
      classified_amount: scope?.intalev_classified_subtotal ?? null,
      classification: "UNCLASSIFIED / EMPTY_ARTICLE",
      financial_posting_rows: 0,
      items: displayItems.map((item) => {
        const binding = bindingByItem.get(itemReportingKey(item));
        const descendantBindings = binding
          ? []
          : scopeBindings.filter((candidate) =>
              pathIsWithin(candidate?.source_path, item?.source_path));
        const descendantAmount = descendantBindings.reduce(
          (sum, candidate) => sum + Number(candidate?.amount ?? 0),
          0,
        );
        const descendantRollupMatched =
          descendantBindings.length > 0 &&
          cents(item?.amount) !== null &&
          Math.abs(cents(descendantAmount) - cents(item.amount)) <= toleranceCents;
        const rollupCodes = [...new Set(
          descendantBindings.map((candidate) => candidate.target_code).filter(Boolean),
        )];
        const rollupArticles = [...new Set(
          descendantBindings.map((candidate) => candidate.erp_article).filter(Boolean),
        )];
        return {
          ...item,
          target_code: binding?.target_code ?? (descendantRollupMatched
            ? rollupCodes.join(", ")
            : ""),
          erp_article: binding?.erp_article ?? (descendantRollupMatched
            ? rollupArticles.join("; ")
            : ""),
          erp_amount: binding?.amount ?? (descendantRollupMatched
            ? item.amount
            : null),
          match_basis: binding?.match_basis ?? (descendantRollupMatched
            ? "BOUND_DESCENDANT_ROLLUP"
            : "UNBOUND_VISIBLE_SOURCE"),
          correction_allowed: false,
          financial_posting_rows: 0,
        };
      }),
    });
  }

  for (const [code, adjustments] of adjustmentByCode.entries()) {
    const row = rowByCode.get(code);
    if (!row) continue;
    const originalCents = cents(row?.intalev?.amount) ?? 0;
    const adjustmentCents = adjustments.reduce((sum, item) => sum + item.cents, 0);
    const reportingCents = originalCents + adjustmentCents;
    row.intalev_original_amount = cents(row?.intalev?.amount) === null
      ? null
      : amount(originalCents);
    row.intalev_reporting_adjustment = amount(adjustmentCents);
    row.intalev.amount = amount(reportingCents);
    row.intalev.trace = adjustments.reduce(
      (trace, item) => appendUniqueTrace(trace, item.item),
      row.intalev.trace,
    );
    row.blank_article_bindings = adjustments.map((item) => item.binding);
    if (adjustments.length === 1 && adjustments[0].binding.target_code === code) {
      row.blank_article_binding = adjustments[0].binding;
    }
    if (
      cents(row?.erp?.amount) !== null &&
      Math.abs(cents(row.erp.amount) - reportingCents) <= toleranceCents
    ) {
      row.intalev.status = "MATCHED";
    }
    row.intalev.note = [
      text(row?.intalev?.note),
      `EMPTY_ARTICLE_REPORTING_ADJUSTMENT=${amount(adjustmentCents)}`,
      "UNCLASSIFIED_SOURCE_VISIBLE; correction_allowed=false; financial_posting_rows=0",
    ].filter(Boolean).join("; ");
  }

  for (const displayScope of displayScopes) {
    if (displayScope.owner_mode !== "CLASSIFIED_REQUIRES_ALL_IN") continue;
    const ownerRow = rowByCode.get(displayScope.owner_code);
    const allInCents = cents(displayScope.all_in_amount);
    if (!ownerRow || allInCents === null) continue;
    ownerRow.intalev.amount = amount(allInCents);
    ownerRow.intalev_all_in_reporting = {
      source_scope_id: displayScope.source_scope_id,
      classified_amount: displayScope.classified_amount,
      blank_amount: displayScope.blank_amount,
      all_in_amount: displayScope.all_in_amount,
      financial_posting_rows: 0,
    };
    if (
      cents(ownerRow?.erp?.amount) !== null &&
      Math.abs(cents(ownerRow.erp.amount) - allInCents) <= toleranceCents
    ) {
      ownerRow.intalev.status = "MATCHED";
    }
  }

  return {
    rows: reportingRows,
    bindings,
    display_scopes: displayScopes,
    unbound_items: displayScopes.flatMap((scope) =>
      scope.items.filter((item) => !item.target_code)),
    financial_posting_authority: 0,
    financial_posting_rows: 0,
    correction_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
  };
}

function itemKey(item) {
  return [
    text(item?.source_sha256),
    text(item?.sheet),
    text(item?.source_cell),
    item?.source_row ?? "",
    item?.amount ?? "",
  ].join("|");
}

export function buildIntalevSourceScopeRowContract({
  row = {},
  decision = null,
  sourceScopes = [],
  tolerance = 0.01,
} = {}) {
  const period = text(row?.period);
  const scopes = (Array.isArray(sourceScopes) ? sourceScopes : [sourceScopes])
    .filter(Boolean)
    .filter((scope) => !period || !text(scope?.period) || text(scope.period) === period);
  const targetCents = Math.abs(cents(row?.erp_amount ?? row?.delta) ?? 0);
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const candidates = new Map();
  for (const scope of scopes) {
    for (const item of scope?.unclassified_items ?? []) {
      const itemCents = Math.abs(cents(item?.amount) ?? 0);
      if (!targetCents || Math.abs(itemCents - targetCents) > toleranceCents) continue;
      candidates.set(itemKey(item), item);
    }
  }
  const unclassifiedCandidates = [...candidates.values()];
  const decisionClassification = upper(decision?.classification);
  const articleClassification = upper(decision?.article_classification);
  const intalevAmountPresent = finite(row?.intalev_amount);
  const sourceInventoryComplete = scopes.length > 0
    && scopes.every((scope) => scope?.source_inventory_complete === true);
  const sourceScopeComplete = scopes.length > 0
    && scopes.every((scope) => scope?.source_scope_complete === true);
  const sourceAmountLost = scopes.length === 0
    ? null
    : scopes.some((scope) => scope?.source_amount_lost === true)
      ? true
      : scopes.every((scope) => scope?.source_amount_lost === false) ? false : null;
  const sourceInventoryProvesAbsence = sourceInventoryComplete
    && sourceScopeComplete
    && sourceAmountLost === false
    && !intalevAmountPresent
    && unclassifiedCandidates.length === 0;
  const inputPresence = upper(row?.intalev_source_scope_presence);
  const presenceMetadataProvided = Object.hasOwn(row ?? {}, "intalev_source_scope_presence");
  const absenceFlagMetadataProvided = Object.hasOwn(
    row ?? {},
    "intalev_source_scope_absence_proven",
  );
  const absenceClaimed = row?.intalev_source_scope_absence_proven === true
    || inputPresence === "ABSENT_PROVEN"
    || sourceInventoryProvesAbsence;
  let presence = "ABSENCE_UNPROVEN";
  let inputMetadataProof = null;
  if (decisionClassification === "EMPTY_ARTICLE" || articleClassification === "UNCLASSIFIED") {
    presence = "PRESENT_UNCLASSIFIED";
  } else if (intalevAmountPresent) {
    presence = "PRESENT_CLASSIFIED";
  } else if (unclassifiedCandidates.length > 0) {
    presence = "PRESENT_UNCLASSIFIED_UNBOUND";
  } else if (presenceMetadataProvided || absenceFlagMetadataProvided) {
    inputMetadataProof = relevantIntalevAbsenceProof({
      intalev_source_scope_presence: inputPresence,
      intalev_source_scope_absence_proven:
        row?.intalev_source_scope_absence_proven === true,
      intalev_source_scope_inventory_complete: sourceInventoryComplete,
      intalev_source_scope_complete: sourceScopeComplete,
      intalev_source_amount_lost: sourceAmountLost,
    });
    if (INTALEV_SOURCE_SCOPE_PRESENCE_STATES.has(inputPresence)
      && inputPresence !== "ABSENT_PROVEN") {
      presence = inputPresence;
    }
    if (inputMetadataProof.proven) presence = "ABSENT_PROVEN";
  } else if (sourceInventoryProvesAbsence) {
    presence = "ABSENT_PROVEN";
  }
  const absenceProof = relevantIntalevAbsenceProof({
    intalev_source_scope_presence: presence,
    intalev_source_scope_absence_proven: presence === "ABSENT_PROVEN",
    intalev_source_scope_inventory_complete: sourceInventoryComplete,
    intalev_source_scope_complete: sourceScopeComplete,
    intalev_source_amount_lost: sourceAmountLost,
  });
  const absenceBlockers = [...new Set([
    ...absenceProof.blockers,
    ...(inputMetadataProof?.proven === false ? inputMetadataProof.blockers : []),
  ])];
  return {
    intalev_source_scope_presence: presence,
    intalev_source_scope_absence_claimed: absenceClaimed,
    intalev_source_scope_absence_proven: absenceProof.proven,
    intalev_source_scope_inventory_complete: sourceInventoryComplete,
    intalev_source_scope_complete: sourceScopeComplete,
    intalev_source_amount_lost: sourceAmountLost,
    relevant_intalev_absence_proven: absenceProof.proven,
    relevant_intalev_absence_blockers: absenceBlockers,
    intalev_source_scope_classification: presence.startsWith("PRESENT_UNCLASSIFIED")
      ? "UNCLASSIFIED"
      : presence === "PRESENT_CLASSIFIED"
        ? "CLASSIFIED"
        : "UNPROVEN",
    unclassified_offset_candidates: unclassifiedCandidates,
    blank_article_financial_posting_authority: 0,
    blank_article_storno_authorized: false,
  };
}

export function buildIntalevSourceScopePayloadContract(sourceScopes = []) {
  const scopes = (Array.isArray(sourceScopes) ? sourceScopes : [sourceScopes]).filter(Boolean);
  return {
    intalev_source_scope: scopes.length === 1 ? scopes[0] : null,
    intalev_source_scopes: scopes,
    blank_article_financial_posting_authority: 0,
    blank_article_financial_posting_rows: 0,
  };
}
