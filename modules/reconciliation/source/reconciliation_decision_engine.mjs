import {
  OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION,
  isOwnerPresentationBlockExempt,
} from "./owner_presentation_block_exemption.mjs";

const CONTROL_ROLES = new Set([
  "ИТОГ",
  "БЛОК",
  "ПОДБЛОК",
  "ГРУППА",
  "РОДИТЕЛЬ",
  "TOTAL",
  "GROUP",
  "PARENT",
]);

export const RECONCILIATION_DECISION_SCHEMA =
  "opiu-reconciliation-decision-engine-v1";

export const RECONCILIATION_DECISION_FIELDS = Object.freeze([
  "classification",
  "status_text",
  "effective_delta",
  "proof_status",
  "correction_allowed",
  "correction_route",
  "priority_stage",
  "binding_status",
  "internal_reclass_case_key",
  "cross_branch_case_key",
]);

// These are semantic stages, not accounting action types.  Accounting actions
// are intentionally last and are enabled only by exact source/target proof.
export const DECISION_PRIORITY = Object.freeze([
  "HIERARCHY_REPAIR",
  "EMPTY_ARTICLE",
  "BINDING_REPAIR",
  "INTERNAL_RECLASS",
  "CROSS_BRANCH_RECLASS",
  "EXACT_SOURCE_TARGET_PROOF",
  "FINANCIAL_CORRECTION",
  "ADD_ONE_SIDE",
  "STORNO_REPOST",
  "DELETE",
]);

const DECISION_PRIORITY_SET = new Set(DECISION_PRIORITY);

const STATUS_TEXT = Object.freeze({
  HIERARCHY_REPAIR: "СУММА СОШЛАСЬ / ИЕРАРХИЯ НЕ ДОКАЗАНА",
  EMPTY_ARTICLE: "СУММА ЕСТЬ / СТАТЬЯ НЕ УКАЗАНА",
  BINDING_REPAIR_CANDIDATE: "НУЖНА ПРИВЯЗКА ERP",
  BINDING_REPAIR_PROVEN: "ПРИВЯЗКА ERP ДОКАЗАНА",
  INTERNAL_RECLASS_CANDIDATE: "ВОЗМОЖЕН ПЕРЕСОРТ",
  CROSS_BRANCH_RECLASS_CANDIDATE: "ПЕРЕСОРТ НЕ ДОКАЗАН",
  FINANCIAL_CORRECTION_PROVEN: "ФИНАНСОВАЯ КОРРЕКТИРОВКА ДОКАЗАНА",
  OWNER_PRESENTATION_BLOCK_EXEMPT:
    "ПРЕЗЕНТАЦИОННЫЙ / КОНТРОЛЬНЫЙ БЛОК — БЕЗ КОРРЕКТИРОВКИ",
  STRUCTURAL_GROUP_ROOT_EXCEPTION:
    "НАСТРОЕННОЕ СТРУКТУРНОЕ ИСКЛЮЧЕНИЕ — БЕЗ КОРРЕКТИРОВКИ КОРНЯ",
  STRUCTURAL_GROUP_SUM_OK:
    "СТРУКТУРНАЯ ГРУППА СОШЛАСЬ — ВНУТРЕННИЕ ПРОВЕРКИ АКТИВНЫ",
  STRUCTURAL_GROUP_SUM_MISMATCH:
    "СТРУКТУРНАЯ ГРУППА НЕ СОШЛАСЬ — ТРЕБУЕТ ПРОВЕРКИ",
  CONTROL_ONLY: "КОНТРОЛЬНАЯ СТРУКТУРНАЯ СТРОКА",
  CONTROL_ONLY_ZERO_PARENT_WITH_CHILD_DELTAS:
    "НУЛЕВАЯ ГРУППА / ЕСТЬ ДЕЛЬТЫ ВНУТРИ",
  RECONCILED: "СОШЛОСЬ",
  UNPROVEN_FINANCIAL_DELTA: "ПЕРЕСОРТ НЕ ДОКАЗАН",
});

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cents(value) {
  return finite(value) ? Math.round(value * 100) : null;
}

function amountFromCents(value) {
  return value === null ? null : value / 100;
}

function roundAmount(value) {
  return finite(value) ? Number(value.toFixed(10)) : null;
}

function array(value) {
  return Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
}

function firstNumber(...values) {
  return values.find(finite) ?? null;
}

function rowId(row, index) {
  return text(row?.row_id ?? row?.id ?? row?.code ?? `ROW-${index + 1}`);
}

function parentId(row) {
  return text(
    row?.parent_row_id ??
      row?.parent_id ??
      row?.hierarchy_parent_node_id ??
      row?.hierarchy_parent_code,
  );
}

function branchKey(row) {
  return text(
    row?.branch_key ??
      row?.branch ??
      (Array.isArray(row?.hierarchy_path) ? row.hierarchy_path.join(" / ") : row?.hierarchy_path),
  );
}

function hasArticle(value) {
  const normalized = upper(value);
  return Boolean(normalized) && !["<ПУСТОЕ ЗНАЧЕНИЕ>", "EMPTY", "UNCLASSIFIED"].includes(normalized);
}

function articleOf(row) {
  return text(
    row?.article ??
      row?.article_name ??
      row?.intalev_article ??
      row?.intalev_label ??
      row?.source_article,
  );
}

function sourceRowsOf(row) {
  return array(row?.source_rows ?? row?.intalev_source_rows ?? row?.intalev_sources);
}

function sourceAmountEvidence(row) {
  const sourceRows = sourceRowsOf(row);
  const explicit = firstNumber(row?.source_amount_present, row?.source_amount);
  let totalCents = explicit === null ? 0 : Math.round(explicit * 100);
  let present = explicit !== null && Math.abs(totalCents) > 0;
  let emptyArticle = explicit !== null && !hasArticle(articleOf(row));
  for (const source of sourceRows) {
    const amount = firstNumber(source?.amount, source?.source_amount, source?.value);
    if (amount === null || Math.abs(amount) <= 0) continue;
    totalCents += Math.round(amount * 100);
    present = true;
    const sourceArticle = text(
      source?.article ??
        source?.article_name ??
        source?.intalev_article ??
        source?.summary_label ??
        source?.label,
    );
    if (!hasArticle(sourceArticle)) emptyArticle = true;
  }
  return {
    present,
    amount: amountFromCents(totalCents),
    emptyArticle,
    classification: present && emptyArticle ? "UNCLASSIFIED" : "CLASSIFIED",
  };
}

function hierarchyProven(row) {
  if (row?.hierarchy_proven === false || row?.hierarchy_proof === false) return false;
  const status = upper(
    row?.hierarchy_status ??
      row?.intalev_hierarchy_status ??
      row?.hierarchy_proof?.status,
  );
  if (!status) return true;
  return ![
    "UNPROVEN",
    "MISMATCH",
    "BLOCKED",
    "HIERARCHY_UNPROVEN",
    "HIERARCHY_MISMATCH",
    "TEMPLATE_CATALOG_MISMATCH",
  ].some((blocked) => status.includes(blocked));
}

function explicitChildren(row) {
  return [
    ...array(row?.children),
    ...array(row?.child_ids),
    ...array(row?.children_ids),
  ].map((item) => (typeof item === "object" ? rowId(item, 0) : text(item))).filter(Boolean);
}

function isControlOnly(row, childIds) {
  if (row?.control_only === true || row?.structural_non_posting === true) return true;
  if (row?.correction_authority === false) return true;
  if (row?.hierarchy_has_children === true || childIds.length > 0) return true;
  const role = upper(row?.role ?? row?.row_kind ?? row?.group ?? row?.hierarchy_group);
  return CONTROL_ROLES.has(role);
}

function buildGraph(inputRows, structuralControlGroups = []) {
  const rows = inputRows.map((source, index) => {
    const id = rowId(source, index);
    const explicitChildIds = explicitChildren(source);
    const intalevAmount = firstNumber(source?.intalev_amount, source?.source_amount);
    const erpAmount = firstNumber(source?.erp_amount);
    const rawDelta = firstNumber(
      source?.raw_delta,
      intalevAmount !== null && erpAmount !== null ? intalevAmount - erpAmount : null,
      source?.delta,
    );
    return {
      ...source,
      row_id: id,
      reporting_code: text(source?.reporting_code ?? source?.code ?? source?.row_code ?? id),
      parent_row_id: parentId(source),
      explicit_child_ids: explicitChildIds,
      intalev_amount: intalevAmount,
      erp_amount: erpAmount,
      raw_delta: roundAmount(rawDelta),
      branch_key: branchKey(source) || id,
      source_amount_evidence: sourceAmountEvidence(source),
      hierarchy_proven: hierarchyProven(source),
    };
  });
  const byId = new Map(rows.map((row) => [row.row_id, row]));
  const childrenById = new Map(rows.map((row) => [row.row_id, []]));
  for (const row of rows) {
    const parent = byId.get(row.parent_row_id);
    if (parent && !childrenById.get(parent.row_id).includes(row.row_id)) {
      childrenById.get(parent.row_id).push(row.row_id);
    }
    for (const childId of row.explicit_child_ids) {
      if (!byId.has(childId)) continue;
      const children = childrenById.get(row.row_id);
      if (!children.includes(childId)) children.push(childId);
    }
  }
  for (const row of rows) {
    row.child_ids = childrenById.get(row.row_id) ?? [];
    row.owner_presentation_block_exempt = isOwnerPresentationBlockExempt(
      row,
      structuralControlGroups,
    );
    row.control_only = isControlOnly(row, row.child_ids);
    row.correction_authority =
      row.owner_presentation_block_exempt !== true &&
      row.control_only !== true &&
      row.correction_authority !== false;
    row.financial_contribution =
      row.owner_presentation_block_exempt !== true &&
      row.financial_contribution !== false;
  }
  return { rows, byId, childrenById };
}

function directChildren(graph, row) {
  return (graph.childrenById.get(row.row_id) ?? [])
    .map((id) => graph.byId.get(id))
    .filter(Boolean);
}

const PROVEN_RESIDUAL_STATUSES = new Set([
  "PROVEN",
  "EXACT",
  "PROVEN_ALLOCATION",
  "ECONOMIC_CORRECTION_PROVEN",
  "REPORT_SOURCE_PROVEN",
]);

function residualProofStatus(row) {
  return upper(
    row?.residual_allocation_proof_status
    ?? row?.allocation_proof_status
    ?? row?.residual_proof_status
    ?? row?.proof_status
    ?? row?.evidence_state
    ?? row?.mapping_proof_status,
  );
}

function provenResidualAllocationCents(row) {
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

function descendants(graph, row) {
  const result = [];
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const childId of graph.childrenById.get(id) ?? []) {
      const child = graph.byId.get(childId);
      if (!child) continue;
      result.push(child);
      visit(child.row_id);
    }
    visiting.delete(id);
  };
  visit(row.row_id);
  return result;
}

function normalizedDelta(graph, row) {
  const supplied = firstNumber(row?.normalized_delta);
  const suppliedBasis = upper(row?.normalized_delta_basis ?? row?.residual_basis);
  const intalevRaw = firstNumber(row?.intalev_amount, row?.source_amount);
  const erpRaw = firstNumber(row?.erp_amount);
  const hasRawBasis = firstNumber(
    row?.raw_delta,
    intalevRaw !== null && erpRaw !== null ? intalevRaw - erpRaw : null,
    row?.delta,
  ) !== null;
  // A supplied normalized value is authoritative only when it is explicitly
  // marked as canonical, or when the row has no raw amount basis to recompute.
  // This prevents an old full-balance normalization from overriding the
  // immutable raw residual while preserving presentation-only imported rows.
  if (supplied !== null && (
    row?.canonical_normalization_applied === true
    || suppliedBasis === "CANONICAL_HIERARCHY_RESIDUAL"
    || !hasRawBasis
  )) return roundAmount(supplied);
  const amountScope = row?.amount_scope ?? {};
  const intalevIncludes = row?.intalev_includes_children === true ||
    upper(amountScope?.intalev) === "AGGREGATED";
  const erpIncludes = row?.erp_includes_children === true || upper(amountScope?.erp) === "AGGREGATED";
  if (!intalevIncludes && !erpIncludes) return row.raw_delta;
  const children = directChildren(graph, row);
  if (children.length === 0) return row.raw_delta;
  const allocations = children.map((child) => provenResidualAllocationCents(child));
  if (allocations.some((value) => value === null)) return row.raw_delta;
  const represented = allocations.reduce((sum, value) => sum + value, 0);
  const rawCents = cents(row.raw_delta);
  if (rawCents === null) return row.raw_delta;
  // A proven residual allocation can suppress the parent's decision only when
  // it exactly partitions the parent. Full child balances are never inputs to
  // this arithmetic.
  const remaining = rawCents - represented;
  return amountFromCents(Math.abs(remaining) <= 1 ? 0 : remaining);
}

function bindingCandidates(row, effectiveDelta, toleranceCents) {
  const targetCents = Math.abs(cents(effectiveDelta) ?? 0);
  if (!targetCents) return [];
  const context = text(row?.context_key ?? row?.branch_key);
  return array(row?.binding_candidates).filter((candidate) => {
    const amountCents = Math.abs(cents(firstNumber(candidate?.amount, candidate?.source_amount)) ?? 0);
    if (amountCents !== targetCents) return false;
    const candidateContext = text(candidate?.context_key ?? candidate?.branch_key);
    if (!context || !candidateContext || context !== candidateContext) return false;
    if (Math.abs(amountCents - targetCents) > toleranceCents) return false;
    return true;
  });
}

function proofStatus(value) {
  const status = upper(value);
  return status === "PROVEN" || status === "EXACT" ? "PROVEN" : "UNPROVEN";
}

function stageFor(classification) {
  if (classification === "HIERARCHY_REPAIR") return "HIERARCHY_REPAIR";
  if (classification === "EMPTY_ARTICLE") return "EMPTY_ARTICLE";
  if (classification.startsWith("BINDING_REPAIR")) return "BINDING_REPAIR";
  if (classification === "INTERNAL_RECLASS_CANDIDATE") return "INTERNAL_RECLASS";
  if (classification.startsWith("CROSS_BRANCH_RECLASS")) return "CROSS_BRANCH_RECLASS";
  if (classification === "FINANCIAL_CORRECTION_PROVEN") return "FINANCIAL_CORRECTION";
  if (classification === "UNPROVEN_FINANCIAL_DELTA") return "FINANCIAL_CORRECTION";
  if (classification === "DELETE") return "DELETE";
  return "EXACT_SOURCE_TARGET_PROOF";
}

function statusText(classification) {
  return STATUS_TEXT[classification] ?? "ТРЕБУЕТ ПРОВЕРКИ";
}

function sourceRowsForPipelineRow(row) {
  return array(
    row?.source_rows ??
      row?.intalev_source_rows ??
      row?.intalev_sources ??
      row?.intalev?.source_rows ??
      row?.intalev?.trace,
  );
}

function bindingCandidatesForPipelineRow(row) {
  return array(
    row?.binding_candidates ??
      row?.erp_binding_candidates ??
      row?.erp?.binding_candidates,
  );
}

function exactHierarchyBindingForPipelineRow(row, sourceRows) {
  const proofs = [
    row?.erp?.proven_presentation_parent,
    row?.erp?.proven_parent_composition,
    row?.erp?.proven_parent_composition_alias,
  ].filter(Boolean);
  if (proofs.length !== 1) return null;
  const [proof] = proofs;
  const accepted = new Set([
    "PROVEN_ERP_PARENT_COMPOSITION",
    "PROVEN_ERP_PARENT_COMPOSITION_ALIAS",
  ]);
  if (
    !proof ||
    !accepted.has(upper(proof.status)) ||
    proof.binding_repair_required !== true ||
    proof.correction_authority !== false ||
    Number(proof.posting_rows ?? -1) !== 0
  ) return null;
  const sourceCells = [...new Set((
    upper(proof.status) === "PROVEN_ERP_PRESENTATION_PARENT"
      ? [proof.source_cell]
      : upper(proof.status) === "PROVEN_ERP_PARENT_COMPOSITION"
        ? array(proof.component_source_cells)
        : [proof.alias_source_cell, ...array(proof.component_source_cells)]
  ).map(text).filter(Boolean))];
  const traceCells = new Set(sourceRows.map((source) => text(source?.source_cell)).filter(Boolean));
  if (sourceCells.length === 0 || sourceCells.some((cell) => !traceCells.has(cell))) return null;
  const sourceShas = [...new Set(sourceRows
    .filter((source) => sourceCells.includes(text(source?.source_cell)))
    .map((source) => upper(source?.sha256))
    .filter((sha) => /^[A-F0-9]{64}$/.test(sha)))];
  if (sourceShas.length !== 1) return null;
  return {
    ...proof,
    source_cells: sourceCells,
    source_sha256: sourceShas[0],
    proof_status: "PROVEN",
    decision_type: "UPDATE_MAPPING",
    correction_authority: false,
    posting_rows: 0,
  };
}

// This is the only adapter from the reconciliation aggregate row to the
// decision engine.  It deliberately forwards exact source traces and
// evidence-layer candidates; it does not discover or fuzzy-match evidence.
export function buildDecisionEngineRow(row = {}) {
  const hierarchyPath = Array.isArray(row?.hierarchy_path)
    ? row.hierarchy_path
    : row?.hierarchy_path;
  const sourceRows = sourceRowsForPipelineRow(row);
  const exactHierarchyBinding = exactHierarchyBindingForPipelineRow(
    row,
    array(row?.erp?.trace),
  );
  return {
    row_id: rowId(row, 0),
    reporting_code: text(row?.code ?? row?.row_code ?? rowId(row, 0)),
    parent_row_id: parentId(row),
    intalev_amount: firstNumber(row?.intalev_amount, row?.intalev?.amount),
    erp_amount: firstNumber(row?.erp_amount, row?.erp?.amount),
    raw_delta: firstNumber(row?.raw_delta, row?.delta),
    normalized_delta: firstNumber(row?.normalized_delta, row?.decision_normalized_delta),
    structural_group_control_enabled: row?.structural_group_control_enabled === true,
    structural_group_control_set_id: text(
      row?.structural_group_control_set_id ?? row?.structural_control_group_id,
    ),
    structural_group_sum_status: text(row?.structural_group_sum_status),
    structural_control_effective_delta: firstNumber(row?.structural_control_effective_delta),
    amount_scope: row?.amount_scope,
    intalev_includes_children: row?.intalev_includes_children === true,
    erp_includes_children: row?.erp_includes_children === true,
    hierarchy_has_children: row?.hierarchy_has_children,
    hierarchy_status: row?.hierarchy_status ?? row?.presentation_hierarchy_status,
    intalev_hierarchy_status: row?.intalev_hierarchy_status,
    control_only: row?.control_only === true || row?.hierarchy_has_children === true,
    branch_key: row?.branch_key ?? hierarchyPath,
    context_key:
      row?.context_key ??
      row?.decision_context_key ??
      row?.presentation_parent_code ??
      row?.hierarchy_parent_code,
    article: row?.article ?? row?.article_name ?? row?.intalev_label,
    source_rows: sourceRows,
    binding_candidates: bindingCandidatesForPipelineRow(row),
    mapping_proof_status: exactHierarchyBinding ? "BINDING_REPAIR_PROVEN" : "",
    mapping_decision_type: exactHierarchyBinding ? "UPDATE_MAPPING" : "",
    exact_hierarchy_binding: exactHierarchyBinding,
    // A proven exact trace is authoritative.  Do not add its total again when
    // a prior payload also carries the derived source_amount_present field.
    source_amount_present: sourceRows.length > 0 ? null : row?.source_amount_present,
    exact_source_target_proof: row?.exact_source_target_proof,
    source_target_proof: row?.source_target_proof,
    proof_status: row?.proof_status,
    source_proof: row?.source_proof,
    target_proof: row?.target_proof,
  };
}

export function decideReconciliationPipelineRows({
  rows = [],
  tolerance = 0.01,
  structural_control_groups: structuralControlGroups = [],
} = {}) {
  return decideReconciliationRows({
    rows: (Array.isArray(rows) ? rows : []).map(buildDecisionEngineRow),
    tolerance,
    structural_control_groups: structuralControlGroups,
  });
}

export function projectDecisionContract(decision = {}) {
  return Object.fromEntries(
    RECONCILIATION_DECISION_FIELDS.map((field) => [field, decision[field] ?? null]),
  );
}

export function buildReportDecision(engineDecision, { delta = null, where = "" } = {}) {
  const status = text(engineDecision?.status_text);
  if (!status) return null;
  const caseKey = text(
    engineDecision?.internal_reclass_case_key || engineDecision?.cross_branch_case_key,
  );
  const proof = text(engineDecision?.proof_status) || "UNPROVEN";
  const correction = engineDecision?.correction_allowed === true
    ? "Только отчётный кандидат; posting_rows=0."
    : "Проводка/удаление запрещены до exact source/target proof.";
  return {
    status,
    what: `${text(engineDecision?.classification) || "DECISION"}; effective delta=${engineDecision?.effective_delta ?? "—"}; proof=${proof}.${caseKey ? ` case=${caseKey}.` : ""}`,
    where,
    how: correction,
    delta,
  };
}

function proofForFinancialCorrection(row) {
  return row?.exact_source_target_proof === true ||
    row?.source_target_proof === true ||
    proofStatus(row?.proof_status) === "PROVEN";
}

function zeroGroups(graph, toleranceCents) {
  const groups = [];
  const groupRows = graph.rows.filter((row) => {
    const deltaCents = cents(row.raw_delta);
    return row.control_only === true && deltaCents !== null && Math.abs(deltaCents) <= toleranceCents;
  });
  for (const group of groupRows) {
    const members = descendants(graph, group).filter(
      (row) => {
        const deltaCents = cents(normalizedDelta(graph, row));
        return row.financial_contribution !== false && deltaCents !== null && deltaCents !== 0;
      },
    );
    if (members.length < 2) continue;
    const netCents = members.reduce((sum, row) => sum + (cents(normalizedDelta(graph, row)) ?? 0), 0);
    if (Math.abs(netCents) > toleranceCents) continue;
    groups.push({
      group_id: group.row_id,
      classification: "INTERNAL_RECLASS_CANDIDATE",
      member_ids: members.map((row) => row.row_id),
      components: members.map((row) => ({
        row_id: row.row_id,
        delta: normalizedDelta(graph, row),
        correction_authority: row.correction_authority,
      })),
      net_delta: amountFromCents(netCents),
      proof_status: "UNPROVEN",
      correction_allowed: false,
      posting_rows: 0,
    });
  }
  // The highest/outermost zero group is the economic case. Nested groups are
  // evidence detail and must not create a second case.
  return groups.filter((candidate, index) => !groups.some((other, otherIndex) =>
    otherIndex !== index &&
    other.member_ids.length > candidate.member_ids.length &&
    candidate.member_ids.every((id) => other.member_ids.includes(id)),
  ));
}

function crossBranchGroups(graph, internalMemberIds, toleranceCents) {
  const leaves = graph.rows.filter((row) =>
    row.correction_authority === true &&
    row.financial_contribution !== false &&
    !internalMemberIds.has(row.row_id) &&
    cents(normalizedDelta(graph, row) ?? 0) !== 0,
  );
  const candidates = [];
  const seen = new Set();
  for (const source of leaves) {
    const sourceCents = cents(normalizedDelta(graph, source));
    if (sourceCents === null || sourceCents >= 0) continue;
    for (const target of leaves) {
      const targetCents = cents(normalizedDelta(graph, target));
      if (targetCents === null || targetCents <= 0) continue;
      if (text(source.branch_key) === text(target.branch_key)) continue;
      if (Math.abs(Math.abs(sourceCents) - targetCents) > toleranceCents) continue;
      const caseKey = [source.row_id, target.row_id, Math.abs(sourceCents)].sort().join("|");
      if (seen.has(caseKey)) continue;
      seen.add(caseKey);
      const proven = source.source_proof === true && target.target_proof === true;
      candidates.push({
        case_key: caseKey,
        classification: proven ? "FINANCIAL_CORRECTION_PROVEN" : "CROSS_BRANCH_RECLASS_CANDIDATE",
        candidate_amount: amountFromCents(Math.abs(sourceCents)),
        source_row_id: source.row_id,
        target_row_id: target.row_id,
        source_branch: source.branch_key,
        target_branch: target.branch_key,
        proof_status: proven ? "PROVEN" : "UNPROVEN",
        correction_allowed: proven,
        posting_rows: 0,
      });
    }
  }
  return candidates;
}

function classifyRows(graph, groups, crossBranches, toleranceCents) {
  const internalByRow = new Map();
  for (const group of groups) for (const rowIdValue of group.member_ids) internalByRow.set(rowIdValue, group);
  const crossByRow = new Map();
  for (const candidate of crossBranches) {
    crossByRow.set(candidate.source_row_id, candidate);
    crossByRow.set(candidate.target_row_id, candidate);
  }
  return graph.rows.map((row) => {
    const computedNormalized = normalizedDelta(graph, row);
    const normalized = row.owner_presentation_block_exempt
      ? amountFromCents(cents(computedNormalized))
      : computedNormalized;
    const normalizedCents = cents(normalized);
    const source = row.source_amount_evidence;
    let classification = "RECONCILED";
    let stage = "EXACT_SOURCE_TARGET_PROOF";
    let bindingStatus = "NOT_APPLICABLE";
    let effectiveDelta = normalized;
    let binding = null;
    let group = internalByRow.get(row.row_id) ?? null;
    let cross = crossByRow.get(row.row_id) ?? null;
    if (row.owner_presentation_block_exempt) {
      classification = row.structural_group_sum_status
        || OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION;
      effectiveDelta = row.structural_control_effective_delta ?? normalized;
      stage = "EXACT_SOURCE_TARGET_PROOF";
    } else if (
      row.mapping_proof_status === "BINDING_REPAIR_PROVEN" &&
      row.mapping_decision_type === "UPDATE_MAPPING" &&
      row.exact_hierarchy_binding?.proof_status === "PROVEN"
    ) {
      classification = "BINDING_REPAIR_PROVEN";
      stage = "BINDING_REPAIR";
      bindingStatus = "PROVEN";
      binding = row.exact_hierarchy_binding;
      effectiveDelta = normalized;
    } else if (!row.hierarchy_proven) {
      classification = "HIERARCHY_REPAIR";
      stage = "HIERARCHY_REPAIR";
    } else if (source.present && source.emptyArticle) {
      classification = "EMPTY_ARTICLE";
      stage = "EMPTY_ARTICLE";
    } else {
      const candidates = bindingCandidates(row, normalized, toleranceCents);
      if (candidates.length > 0) {
        binding = candidates.length === 1 ? candidates[0] : null;
        const proven = candidates.length === 1 && proofStatus(candidates[0]?.proof_status) === "PROVEN";
        bindingStatus = proven ? "PROVEN" : "ERP_BINDING_UNPROVEN";
        classification = proven ? "BINDING_REPAIR_PROVEN" : "BINDING_REPAIR_CANDIDATE";
        stage = "BINDING_REPAIR";
        if (proven && binding) {
          const adjustment = Math.abs(cents(firstNumber(binding.amount, binding.source_amount)) ?? 0);
          const signed = (normalizedCents ?? 0) - Math.sign(normalizedCents ?? 0) * adjustment;
          effectiveDelta = amountFromCents(Math.abs(signed) <= toleranceCents ? 0 : signed);
        }
      } else if (group) {
        classification = "INTERNAL_RECLASS_CANDIDATE";
        stage = "INTERNAL_RECLASS";
      } else if (cross) {
        classification = cross.classification;
        stage = classification === "FINANCIAL_CORRECTION_PROVEN" ? "FINANCIAL_CORRECTION" : "CROSS_BRANCH_RECLASS";
      } else if (Math.abs(normalizedCents ?? 0) > toleranceCents) {
        classification = proofForFinancialCorrection(row)
          ? "FINANCIAL_CORRECTION_PROVEN"
          : "UNPROVEN_FINANCIAL_DELTA";
        stage = "FINANCIAL_CORRECTION";
      } else if (row.control_only && descendants(graph, row).some((child) => Math.abs(cents(normalizedDelta(graph, child)) ?? 0) > toleranceCents)) {
        classification = "CONTROL_ONLY_ZERO_PARENT_WITH_CHILD_DELTAS";
        stage = "INTERNAL_RECLASS";
      } else if (row.control_only) {
        classification = "CONTROL_ONLY";
        stage = "EXACT_SOURCE_TARGET_PROOF";
      }
    }
    const correctionAllowed = classification === "FINANCIAL_CORRECTION_PROVEN";
    return {
      ...row,
      raw_delta: row.raw_delta,
      normalized_delta: normalized,
      effective_delta: roundAmount(effectiveDelta),
      source_amount_present: source.present ? source.amount : null,
      amount_presence: source.present ? "PROVEN" : "UNPROVEN",
      article_classification: source.classification,
      classification,
      status_text: statusText(classification),
      priority_stage: stage,
      priority_index: decisionPriorityIndex(stage),
      binding_status: bindingStatus,
      binding_candidate: binding,
      internal_reclass_case_key: group?.group_id ?? null,
      cross_branch_case_key: cross?.case_key ?? null,
      correction_authority: row.correction_authority,
      correction_allowed: correctionAllowed,
      correction_route: correctionAllowed ? "FINANCIAL_CORRECTION" : "NONE",
      proof_status: correctionAllowed || bindingStatus === "PROVEN" ? "PROVEN" : "UNPROVEN",
      posting_rows: 0,
      ...(row.owner_presentation_block_exempt
        ? {
            financial_rows: 0,
            posting_allowed: false,
            execution_allowed: false,
          }
        : {}),
    };
  });
}

export function decisionPriorityIndex(stage) {
  const index = DECISION_PRIORITY.indexOf(stage);
  return index >= 0 ? index : DECISION_PRIORITY.length;
}

export function decideReconciliationRows({
  rows = [],
  tolerance = 0.01,
  structural_control_groups: structuralControlGroups = [],
} = {}) {
  const toleranceCents = Math.round(Math.abs(Number(tolerance)) * 100);
  const graph = buildGraph(Array.isArray(rows) ? rows : [], structuralControlGroups);
  for (const row of graph.rows) row.normalized_delta = normalizedDelta(graph, row);
  const groups = zeroGroups(graph, toleranceCents);
  const internalMemberIds = new Set(groups.flatMap((group) => group.member_ids));
  const crossBranches = crossBranchGroups(graph, internalMemberIds, toleranceCents);
  const decisions = classifyRows(graph, groups, crossBranches, toleranceCents);
  const emptyArticleSources = decisions.filter((row) => row.classification === "EMPTY_ARTICLE");
  const bindingRepairs = decisions.filter((row) => row.priority_stage === "BINDING_REPAIR");
  const financialCorrections = decisions.filter((row) => row.correction_allowed);
  return {
    schema: RECONCILIATION_DECISION_SCHEMA,
    decision_priority: DECISION_PRIORITY,
    rows: decisions,
    internal_reclass_candidates: groups,
    cross_branch_reclass_candidates: crossBranches,
    empty_article_sources: emptyArticleSources,
    binding_repairs: bindingRepairs,
    financial_correction_candidates: financialCorrections,
    safety: {
      report_only: true,
      execution_allowed: false,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      owner_upload_rows: 0,
      add_one_side_rows: 0,
      storno_rows: 0,
      repost_rows: 0,
      financial_correction_rows: financialCorrections.length,
      delete_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      live_delete_allowed: false,
    },
  };
}

export { STATUS_TEXT };
