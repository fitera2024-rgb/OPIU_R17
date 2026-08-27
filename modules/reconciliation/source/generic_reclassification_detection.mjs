import crypto from "node:crypto";

import {
  STRUCTURAL_CONTROL_GROUPS,
  structuralControlGroupForCode,
} from "./structural_control_groups.mjs";
import { isOwnerPresentationBlockExempt } from "./owner_presentation_block_exemption.mjs";
import {
  isDescendantAllocationCompatible,
  provenDescendantAllocation,
} from "./residual_allocation_proof.mjs";

export const GENERIC_RECLASSIFICATION_SCHEMA =
  "opiu-generic-reclassification-detection-v1";
export const GENERIC_NORMALIZATION_SCHEMA =
  "opiu-canonical-hierarchy-residuals-v1";
export const GENERIC_RECLASSIFICATION_MECHANISM =
  "INTERGROUP_ROOTS_FIRST_THEN_INTRAGROUP_DESCENDANTS";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_MAX_SUBSETS = 65_536;
const DEFAULT_MAX_CANDIDATES = 4_096;
const DEFAULT_MAX_COMPARISONS = 1_000_000;

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cents(value) {
  return finite(value) ? Math.round(value * 100) : null;
}

function money(value) {
  return value === null ? null : value / 100;
}

function array(value) {
  return Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
}

function rowCode(row) {
  return text(row?.code ?? row?.row_code ?? row?.reporting_code ?? row?.row_id ?? row?.id);
}

function rowId(row, index) {
  return text(row?.residual_id ?? row?.row_id ?? row?.id ?? rowCode(row)) || `ROW-${index + 1}`;
}

function parentId(row) {
  return text(
    row?.presentation_parent_code ??
      row?.hierarchy_parent_code ??
      row?.hierarchy_parent_node_id ??
      row?.parent_row_id ??
      row?.parent_id,
  );
}

function organizationOf(row) {
  // The run-bound business identity is the canonical partition key. ERP codes
  // remain evidence attributes and must not replace the selected organization.
  return [row?.organization, row?.organization_id, row?.organization_code]
    .map(text)
    .find(Boolean) ?? "";
}

function periodOf(row) {
  return [row?.month, row?.period_id, row?.period]
    .map(text)
    .find(Boolean) ?? "";
}

function explicitBranch(row) {
  const value =
    row?.economic_branch_id ??
    row?.economic_group_id ??
    row?.branch_key ??
    row?.branch_id ??
    row?.branch;
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(" / ") : text(value);
}

function rawDeltaCents(row) {
  const explicitRaw = cents(row?.raw_delta);
  if (explicitRaw !== null) return explicitRaw;
  const intalev = cents(row?.intalev_amount ?? row?.intalev?.amount);
  const erp = cents(row?.erp_amount ?? row?.erp?.amount);
  if (intalev !== null && erp !== null) return intalev - erp;
  return cents(row?.delta);
}

function provenMappingAdjustmentCents(row) {
  const adjustment = cents(row?.proven_mapping_adjustment);
  if (adjustment === null) return 0;
  const proofStatus = text(
    row?.mapping_proof_status ?? row?.proven_mapping_proof_status,
  ).toUpperCase();
  return row?.proven_mapping === true || proofStatus === "REPORT_SOURCE_PROVEN"
    ? adjustment
    : 0;
}

function canonicalDeltaCents(row) {
  if (provenMappingAdjustmentCents(row) !== 0) return null;
  if (row?.canonical_normalization_applied === true) return cents(row?.normalized_delta);
  const basis = text(row?.normalized_delta_basis ?? row?.residual_basis).toUpperCase();
  if (["CANONICAL_HIERARCHY_RESIDUAL", "LEAF_NORMALIZED_DELTA"].includes(basis)) {
    return cents(row?.normalized_delta);
  }
  return null;
}

function residualAtomId(row, organization, period, code) {
  return text(row?.residual_atom_id)
    || stableId("RESIDUAL-ATOM", [organization, period, code]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function traceIdentity(trace) {
  const exact = text(
    trace?.source_operation_identity ??
      trace?.source_row_id ??
      trace?.operation_identity,
  );
  if (exact) return `EXACT:${exact}`;
  const coordinates = [
    trace?.sha256,
    trace?.source_sha256,
    trace?.journal_sha256,
    trace?.sheet,
    trace?.journal_sheet,
    trace?.source_cell,
    trace?.source_range,
    trace?.physical_row,
    trace?.row,
  ].map(text);
  if (coordinates.some(Boolean)) return `COORD:${coordinates.join("|")}`;
  return `VALUE:${stableJson(trace)}`;
}

function dedupeTraces(values) {
  const groups = new Map();
  const result = [];
  for (const trace of values.flatMap(array)) {
    const identity = traceIdentity(trace);
    const fingerprint = stableJson(trace);
    const group = groups.get(identity);
    if (!group) {
      groups.set(identity, {
        fingerprints: new Set([fingerprint]),
        indexes: [result.length],
      });
      result.push(structuredClone(trace));
      continue;
    }
    if (group.fingerprints.has(fingerprint)) continue;

    // One physical identity cannot safely represent conflicting source rows.
    // Preserve every distinct version and mark the whole identity group so
    // proof routing fails closed instead of depending on input order.
    for (const index of group.indexes) {
      result[index].source_operation_identity_conflict = true;
    }
    const conflicting = structuredClone(trace);
    conflicting.source_operation_identity_conflict = true;
    group.fingerprints.add(fingerprint);
    group.indexes.push(result.length);
    result.push(conflicting);
  }
  return result;
}

function sourceTraces(row) {
  return dedupeTraces([
    row?.source_traces,
    row?.source_operations,
    row?.operation_evidence_rows,
    row?.erp_sources,
    row?.intalev_sources,
  ]);
}

function compareRows(left, right) {
  return left.organization.localeCompare(right.organization, "ru") ||
    left.period.localeCompare(right.period, "en") ||
    left.code.localeCompare(right.code, "en") ||
    left.row_id.localeCompare(right.row_id, "en");
}

function scopeKey(organization, period) {
  return `${organization}\u0000${period}`;
}

function stableId(prefix, parts) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map(text).join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return `${prefix}-${digest}`;
}

function directChildren(graph, node) {
  return (graph.childrenById.get(node.row_id) ?? [])
    .map((id) => graph.byId.get(id))
    .filter(Boolean);
}

function branchFor(node, graph) {
  if (node.explicit_branch) return node.explicit_branch;
  const immediateParent = graph.byCode.get(node.parent_id) ?? graph.byId.get(node.parent_id);
  const isProvenReportingRoot = (candidate) => {
    const depth = Number(candidate?.presentation_depth);
    const hierarchyStatus = text(candidate?.presentation_hierarchy_status).toUpperCase();
    const structuralProof = text(candidate?.presentation_structural_proof?.status).toUpperCase();
    return depth === 0
      && hierarchyStatus === "HIERARCHY_PROVEN"
      && structuralProof.startsWith("PROVEN_");
  };
  // The branch is the highest economic group immediately below the absolute
  // reporting root. Direct siblings must retain distinct branch identities;
  // assigning their common root would incorrectly collapse intergroup routes
  // into one intra pool. Descendants inherit that same top-group identity.
  // If the absolute root is not itself proven, preserve the legacy nearest-
  // parent fallback instead of guessing a reporting boundary.
  const seen = new Set([node.row_id]);
  let current = node;
  let parent = immediateParent;
  while (parent && !seen.has(parent.row_id)) {
    seen.add(parent.row_id);
    if (isProvenReportingRoot(parent)) {
      return current.code || current.row_id || node.code || node.row_id;
    }
    const grandparent = graph.byCode.get(parent.parent_id) ?? graph.byId.get(parent.parent_id);
    if (!grandparent) break;
    current = parent;
    parent = grandparent;
  }
  return immediateParent?.code || immediateParent?.row_id || node.code || node.row_id;
}

function economicContourFor(node, graph) {
  const seen = new Set([node.row_id]);
  let current = node;
  while (current.parent_id) {
    const parent = graph.byCode.get(current.parent_id) ?? graph.byId.get(current.parent_id);
    if (!parent || seen.has(parent.row_id)) break;
    seen.add(parent.row_id);
    current = parent;
  }
  return current.code || current.row_id;
}

function structuralExceptionRootFor(node, graph, structuralControlGroups) {
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.row_id)) {
    seen.add(current.row_id);
    const group = structuralControlGroupForCode(current.code, structuralControlGroups);
    if (group) {
      return {
        control_set_id: text(group.group_id ?? group.id),
        root_code: current.code,
      };
    }
    current = graph.byCode.get(current.parent_id) ?? graph.byId.get(current.parent_id);
  }
  return null;
}

/**
 * Produces exactly one residual contribution per hierarchy grain. A parent
 * contributes only the part of its raw delta that is not already represented
 * by its direct children. Repeating this bottom-up removes propagated
 * ancestor/descendant values and nested double counting without changing a
 * child's physical source traces.
 */
export function normalizeHierarchyResiduals(rows, {
  tolerance = 0.01,
  structural_control_groups: structuralControlGroups = STRUCTURAL_CONTROL_GROUPS,
} = {}) {
  const toleranceCents = Math.max(0, Math.round(Math.abs(Number(tolerance) || 0) * 100));
  const input = Array.isArray(rows) ? rows : [];
  const normalizedRows = input.map((row, index) => ({
    ...structuredClone(row),
    row_id: rowId(row, index),
    code: rowCode(row) || rowId(row, index),
    parent_id: parentId(row),
    organization: organizationOf(row),
    period: periodOf(row),
    explicit_branch: explicitBranch(row),
    economic_relationship_evidence: Boolean(
      explicitBranch(row) ||
      parentId(row) ||
      row?.economic_relationship_proven === true ||
      row?.classification_evidence === true,
    ),
    raw_delta_cents: rawDeltaCents(row),
    proven_mapping_adjustment_cents: provenMappingAdjustmentCents(row),
    supplied_canonical_delta_cents: canonicalDeltaCents(row),
    intalev_sources: structuredClone(array(row?.intalev_sources)),
    erp_sources: structuredClone(array(row?.erp_sources)),
    source_traces: sourceTraces(row),
  }));
  normalizedRows.sort(compareRows);

  const byScope = new Map();
  for (const node of normalizedRows) {
    const key = scopeKey(node.organization, node.period);
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(node);
  }

  const diagnostics = [];
  for (const scopeRows of byScope.values()) {
    const consumedResidualAtoms = new Set();
    const byId = new Map();
    const byCode = new Map();
    const duplicateIds = new Set();
    for (const node of scopeRows) {
      if (byId.has(node.row_id)) duplicateIds.add(node.row_id);
      else byId.set(node.row_id, node);
      if (!byCode.has(node.code)) byCode.set(node.code, node);
    }
    const childrenById = new Map([...byId.keys()].map((id) => [id, []]));
    for (const node of scopeRows) {
      const parent = byCode.get(node.parent_id) ?? byId.get(node.parent_id);
      if (parent && parent.row_id !== node.row_id) childrenById.get(parent.row_id).push(node.row_id);
    }
    for (const children of childrenById.values()) children.sort((left, right) => left.localeCompare(right, "en"));
    const graph = { byId, byCode, childrenById };
    const state = new Map();

    const evaluate = (node) => {
      if (state.get(node.row_id) === "DONE") return node.normalized_delta_cents;
      if (state.get(node.row_id) === "VISITING") {
        node.normalization_status = "BLOCKED_HIERARCHY_CYCLE";
        node.normalized_delta_cents = null;
        diagnostics.push({
          organization: node.organization,
          period: node.period,
          code: node.code,
          blocker: "BLOCKED_HIERARCHY_CYCLE",
        });
        return null;
      }
      state.set(node.row_id, "VISITING");
      const children = directChildren(graph, node);
      for (const child of children) evaluate(child);
      node.represented_descendant_ids = children.map((child) => child.row_id);
      node.branch_id = branchFor(node, graph);
      node.economic_contour_id = economicContourFor(node, graph);
      const structuralExceptionRoot = structuralExceptionRootFor(
        node,
        graph,
        structuralControlGroups,
      );
      node.structural_exception_control_set_id =
        structuralExceptionRoot?.control_set_id ?? "";
      node.structural_exception_root_code =
        structuralExceptionRoot?.root_code ?? "";
      node.residual_atom_id = residualAtomId(node, node.organization, node.period, node.code);
      const effectiveRawDelta = node.raw_delta_cents === null
        ? null
        : node.raw_delta_cents - node.proven_mapping_adjustment_cents;

      const canonicalMatchesRaw = node.supplied_canonical_delta_cents !== null &&
        (effectiveRawDelta === null || node.supplied_canonical_delta_cents === effectiveRawDelta);
      node.canonical_residual_conflict = node.supplied_canonical_delta_cents !== null &&
        effectiveRawDelta !== null &&
        node.supplied_canonical_delta_cents !== effectiveRawDelta;
      if (canonicalMatchesRaw) {
        node.normalized_delta_cents = node.supplied_canonical_delta_cents;
        node.normalization_status = "PRESERVED_CANONICAL_RESIDUAL";
      } else if (effectiveRawDelta === null) {
        node.normalized_delta_cents = null;
        node.normalization_status = "NON_NUMERIC_RESIDUAL";
      } else if (Math.abs(effectiveRawDelta) <= toleranceCents) {
        // A zero presentation/control parent with non-zero descendants is an
        // internal control, not the negative inverse of its children. Never
        // invent a residual by subtracting child deltas from an already-zero
        // parent total.
        node.normalized_delta_cents = 0;
        node.normalization_status = children.length > 0
          ? "CONTROL_ONLY_ZERO_PARENT_WITH_CHILD_RESIDUALS"
          : "LOWEST_UNIQUE_RESIDUAL";
      } else if (children.length === 0) {
        node.normalized_delta_cents = effectiveRawDelta;
        node.normalization_status = "LOWEST_UNIQUE_RESIDUAL";
      } else {
        const acceptedAllocations = [];
        let represented = 0;
        for (const child of children) {
          const allocation = provenDescendantAllocation(node, child, {
            // A fully represented child has no residual left for an ancestor;
            // never substitute that child's full raw balance upward.
            childEffectiveRawCents: child.normalized_delta_cents,
          });
          if (!allocation || allocation.amount_cents === 0) continue;

          if (!isDescendantAllocationCompatible({
            parentRawCents: effectiveRawDelta,
            representedCents: represented,
            allocation,
            toleranceCents,
          })) continue;

          const nextRepresented = represented + allocation.amount_cents;

          const atom = residualAtomId(child, node.organization, node.period, child.code);
          if (consumedResidualAtoms.has(atom)) {
            node.residual_integrity_blockers = [
              ...(node.residual_integrity_blockers ?? []),
              "RESIDUAL_ATOM_DOUBLE_CONSUMPTION",
            ];
            continue;
          }
          consumedResidualAtoms.add(atom);
          represented = nextRepresented;
          acceptedAllocations.push({
            child,
            amount_cents: allocation.amount_cents,
            proof: allocation.proof,
            transformation_id: allocation.transformation_id,
          });
        }
        const residual = effectiveRawDelta - represented;
        node.normalized_delta_cents = Math.abs(residual) <= toleranceCents ? 0 : residual;
        node.normalization_status = acceptedAllocations.length === 0
          ? "PARENT_RESIDUAL_NO_PROVEN_DESCENDANT_ALLOCATION"
          : node.normalized_delta_cents === 0
            ? "ANCESTOR_PROVEN_DESCENDANT_PARTITION_REMOVED"
            : "PARENT_PROVEN_DESCENDANT_RESIDUAL";
        node.accepted_descendant_allocations = acceptedAllocations.map((item) => ({
          child_code: item.child.code,
          allocated_amount: money(item.amount_cents),
          proof: item.proof,
          transformation_id: item.transformation_id || null,
          residual_atom_id: residualAtomId(item.child, node.organization, node.period, item.child.code),
        }));
      }
      const representedByChildren = node.normalized_delta_cents === null || children.length === 0
        ? 0
        : (effectiveRawDelta ?? 0) - node.normalized_delta_cents;
      node.consumed_by_mapping = money(node.proven_mapping_adjustment_cents);
      node.consumed_by_reclass = 0;
      node.consumed_by_descendants = money(representedByChildren);
      node.structural_control_effect = 0;
      node.transformation_id = representedByChildren !== 0
        ? stableId("TRANSFORM-HIERARCHY", [
            node.organization,
            node.period,
            node.code,
            ...children.map((child) => `${child.code}:${child.raw_delta_cents ?? "NULL"}`),
          ])
        : null;
      node.normalized_delta = money(node.normalized_delta_cents);
      node.raw_delta = money(node.raw_delta_cents);
      node.proven_mapping_adjustment = money(node.proven_mapping_adjustment_cents);
      node.erp_literal = node.erp_literal ?? node.erp_amount ?? null;
      node.erp_effective_after_proven_mapping = node.erp_literal === null
        ? null
        : Number(node.erp_literal) + node.proven_mapping_adjustment;
      node.effective_delta = node.normalized_delta;
      node.parent_unallocated_residual = node.effective_delta;
      node.normalized_delta_basis = "CANONICAL_HIERARCHY_RESIDUAL";
      node.residual_grain = children.length === 0 ? "LEAF" : "NORMALIZED_RESIDUAL";
      node.canonical_normalization_applied = true;
      node.owner_presentation_block_exempt = isOwnerPresentationBlockExempt(
        node.code,
        structuralControlGroups,
      );
      node.structural_control_group_id = structuralControlGroups
        .find((group) => (group?.member_codes ?? []).some((code) =>
          String(code).trim().toLocaleUpperCase("ru-RU") === node.code.toLocaleUpperCase("ru-RU")))
        ?.group_id ?? null;
      state.set(node.row_id, "DONE");
      return node.normalized_delta_cents;
    };

    for (const node of scopeRows) evaluate(node);
    if (duplicateIds.size > 0) {
      diagnostics.push({
        organization: scopeRows[0]?.organization ?? "",
        period: scopeRows[0]?.period ?? "",
        blocker: "BLOCKED_DUPLICATE_RESIDUAL_ID",
        duplicate_row_ids: [...duplicateIds].sort(),
      });
    }
  }

  for (const node of normalizedRows) {
    delete node.raw_delta_cents;
    delete node.proven_mapping_adjustment_cents;
    delete node.supplied_canonical_delta_cents;
    delete node.explicit_branch;
  }
  return Object.freeze({
    schema: GENERIC_NORMALIZATION_SCHEMA,
    rows: Object.freeze(normalizedRows.map(Object.freeze)),
    diagnostics: Object.freeze(diagnostics.map(Object.freeze)),
  });
}

function enumerateSubsets(items, maxSubsets) {
  const subsets = [];
  const visit = (index, selected, sumCents) => {
    if (subsets.length > maxSubsets) return false;
    if (index === items.length) {
      if (selected.length > 0) subsets.push({ items: [...selected], sum_cents: sumCents });
      return subsets.length <= maxSubsets;
    }
    if (!visit(index + 1, selected, sumCents)) return false;
    selected.push(items[index]);
    const complete = visit(index + 1, selected, sumCents + Math.abs(items[index].delta_cents));
    selected.pop();
    return complete;
  };
  const complete = visit(0, [], 0);
  return { complete, subsets: complete ? subsets : [] };
}

function cardinality(sourceCount, targetCount) {
  if (sourceCount === 1 && targetCount === 1) return "ONE_TO_ONE";
  if (sourceCount === 1) return "ONE_TO_MANY";
  if (targetCount === 1) return "MANY_TO_ONE";
  return "MANY_TO_MANY";
}

function candidateKey(sourceItems, targetItems) {
  return `${sourceItems.map((item) => `${item.row_id}:${item.delta_cents}`).join("+")}=>${targetItems.map((item) => `${item.row_id}:${item.delta_cents}`).join("+")}`;
}

function memberIds(candidate) {
  return [...candidate.source_members, ...candidate.target_members].map((member) => member.row_id);
}

function isStrictSuperset(candidate, smaller) {
  const values = new Set(memberIds(candidate));
  const small = memberIds(smaller);
  return values.size > small.length && small.every((id) => values.has(id));
}

function removeCompositeSupersets(candidates) {
  const ordered = [...candidates].sort((left, right) =>
    memberIds(left).length - memberIds(right).length ||
    left.candidate_key.localeCompare(right.candidate_key, "en"));
  const result = [];
  for (const candidate of ordered) {
    const pinnedExplicitMemberSet = candidate.accepted_intergroup_reclass === true &&
      [...candidate.source_members, ...candidate.target_members].every((member) =>
        text(member?.intergroup_reclass_member_set_sha256));
    if (pinnedExplicitMemberSet ||
      !result.some((smaller) => isStrictSuperset(candidate, smaller))) result.push(candidate);
  }
  return result;
}

function candidateMember(item, economicDirection) {
  return Object.freeze({
    row_id: item.row_id,
    code: item.code,
    residual_atom_id: item.residual_atom_id ?? null,
    transformation_id: item.transformation_id ?? null,
    economic_contour_id: item.economic_contour_id ?? null,
    economic_relationship_evidence: item.economic_relationship_evidence === true,
    branch_id: item.branch_id,
    erp_literal: item.erp_literal ?? null,
    raw_delta: item.raw_delta ?? null,
    proven_mapping_adjustment: item.proven_mapping_adjustment ?? 0,
    erp_effective_after_proven_mapping: item.erp_effective_after_proven_mapping ?? null,
    effective_delta: money(item.delta_cents),
    root_effective_delta: item.accepted_intergroup_reclass === true ? 0 : money(item.delta_cents),
    accepted_intergroup_effect: item.accepted_intergroup_reclass === true ? money(item.delta_cents) : 0,
    economic_direction: economicDirection,
    intergroup_reclass_id: text(item?.intergroup_reclass_id) || null,
    intergroup_reclass_proof_status: text(item?.intergroup_reclass_proof_status) || null,
    intergroup_reclass_authority_type: text(item?.intergroup_reclass_authority_type) || null,
    intergroup_reclass_approval_id: text(item?.intergroup_reclass_approval_id) || null,
    intergroup_reclass_evidence_ref: text(item?.intergroup_reclass_evidence_ref) || null,
    intergroup_reclass_input_sha256: text(item?.intergroup_reclass_input_sha256) || null,
    intergroup_reclass_run_id: text(item?.intergroup_reclass_run_id) || null,
    intergroup_reclass_source_codes: Object.freeze(structuredClone(array(item?.intergroup_reclass_source_codes))),
    intergroup_reclass_target_codes: Object.freeze(structuredClone(array(item?.intergroup_reclass_target_codes))),
    intergroup_reclass_member_set_sha256: text(item?.intergroup_reclass_member_set_sha256) || null,
    mapping_proof_status: text(item?.mapping_proof_status),
    journal_operation_proof_status: text(item?.journal_operation_proof_status),
    normalized_delta: money(item.delta_cents),
    source_traces: Object.freeze(structuredClone(item.source_traces)),
    intalev_sources: Object.freeze(structuredClone(item.intalev_sources)),
    erp_sources: Object.freeze(structuredClone(item.erp_sources)),
    target_identity: item?.target_identity ? Object.freeze(structuredClone(item.target_identity)) : null,
    target_identities: Object.freeze(structuredClone(array(item?.target_identities))),
    target_classification_proven: item?.target_classification_proven === true,
    target_proof_status: text(item?.target_proof_status),
    deterministic_route: item?.deterministic_route === true || item?.route_unique === true,
  });
}

function explicitIntergroupProofAssessment(items) {
  const routeIds = [...new Set(items.map((item) => text(item?.intergroup_reclass_id)).filter(Boolean))];
  const everyMemberProven = items.length > 0 && items.every((item) =>
    text(item?.intergroup_reclass_proof_status).toUpperCase() === "ECONOMIC_RECLASS_PROVEN"
      && text(item?.intergroup_reclass_id));
  const memberSetMetadataPresent = items.some((item) =>
    array(item?.intergroup_reclass_source_codes).length > 0 ||
    array(item?.intergroup_reclass_target_codes).length > 0 ||
    text(item?.intergroup_reclass_member_set_sha256));
  let exactMemberSet = true;
  if (memberSetMetadataPresent) {
    const declarations = items.map((item) => {
      const sourceCodes = array(item?.intergroup_reclass_source_codes).map(text).filter(Boolean)
        .sort((left, right) => left.localeCompare(right, "en"));
      const targetCodes = array(item?.intergroup_reclass_target_codes).map(text).filter(Boolean)
        .sort((left, right) => left.localeCompare(right, "en"));
      const memberSetSha256 = text(item?.intergroup_reclass_member_set_sha256).toUpperCase();
      const canonical = JSON.stringify({ source_codes: sourceCodes, target_codes: targetCodes });
      const calculatedSha256 = crypto.createHash("sha256").update(canonical).digest("hex").toUpperCase();
      return {
        sourceCodes,
        targetCodes,
        memberSetSha256,
        calculatedSha256,
      };
    });
    const first = declarations[0];
    const declarationValid = declarations.length > 0 && declarations.every((declaration) =>
      declaration.sourceCodes.length > 0 &&
      declaration.targetCodes.length > 0 &&
      declaration.memberSetSha256 === declaration.calculatedSha256 &&
      stableJson(declaration.sourceCodes) === stableJson(first.sourceCodes) &&
      stableJson(declaration.targetCodes) === stableJson(first.targetCodes) &&
      declaration.memberSetSha256 === first.memberSetSha256);
    const candidateSourceCodes = items.filter((item) => Number(item?.delta_cents) < 0)
      .map((item) => text(item?.code)).sort((left, right) => left.localeCompare(right, "en"));
    const candidateTargetCodes = items.filter((item) => Number(item?.delta_cents) > 0)
      .map((item) => text(item?.code)).sort((left, right) => left.localeCompare(right, "en"));
    exactMemberSet = declarationValid &&
      stableJson(candidateSourceCodes) === stableJson(first.sourceCodes) &&
      stableJson(candidateTargetCodes) === stableJson(first.targetCodes);
  }
  const proven = everyMemberProven && routeIds.length === 1 && exactMemberSet;
  return {
    proven,
    route_id: proven ? routeIds[0] : null,
    missing: proven ? [] : [memberSetMetadataPresent && !exactMemberSet
      ? "EXPLICIT_INTERGROUP_MEMBER_SET_EXACT"
      : "EXPLICIT_INTERGROUP_ECONOMIC_PROOF"],
  };
}

function physicalTraceLike(trace) {
  return trace?.source_operation_proven !== undefined ||
    text(trace?.source_proof_status) !== "" ||
    text(trace?.source_operation_identity) !== "";
}

function provenSourceAssessment(items, organization, period) {
  const missing = [];
  let provenTraceCount = 0;
  for (const item of items) {
    const traces = item.source_traces.filter(physicalTraceLike);
    if (traces.length === 0) {
      missing.push(`SOURCE_OPERATION_PROVEN:${item.code}`);
      continue;
    }
    if (traces.some((trace) => trace?.source_operation_identity_conflict === true)) {
      missing.push(`SOURCE_OPERATION_IDENTITY_CONFLICT:${item.code}`);
    }
    let memberAmountCents = 0;
    let memberAmountsComplete = true;
    for (const trace of traces) {
      const status = text(trace?.source_proof_status).toUpperCase();
      const identity = text(trace?.source_operation_identity);
      const traceOrganization = text(
        trace?.source_organization ?? trace?.organization_id ?? trace?.organization_code ?? trace?.organization,
      );
      const tracePeriod = text(trace?.month ?? trace?.period_id ?? trace?.period);
      if (trace?.source_operation_proven !== true || status !== "SOURCE_OPERATION_PROVEN") {
        missing.push(`SOURCE_OPERATION_PROVEN:${item.code}`);
      }
      if (!identity) missing.push(`SOURCE_OPERATION_IDENTITY:${item.code}`);
      if (!traceOrganization || traceOrganization !== organization) {
        missing.push(`SOURCE_ORGANIZATION_PRESERVED:${item.code}`);
      }
      if (!MONTH_PATTERN.test(tracePeriod) || tracePeriod !== period) {
        missing.push(`SOURCE_PERIOD_PRESERVED:${item.code}`);
      }
      const traceAmount = cents(trace?.amount ?? trace?.source_amount);
      if (traceAmount === null) memberAmountsComplete = false;
      else memberAmountCents += Math.abs(traceAmount);
      if (
        trace?.source_operation_proven === true &&
        status === "SOURCE_OPERATION_PROVEN" &&
        identity &&
        traceOrganization === organization &&
        tracePeriod === period
      ) provenTraceCount += 1;
    }
    if (!memberAmountsComplete || memberAmountCents !== Math.abs(item.delta_cents)) {
      missing.push(`SOURCE_AMOUNT_EXACT:${item.code}`);
    }
  }
  return { missing, proven_trace_count: provenTraceCount };
}

function targetIdentity(value) {
  const code = text(
    value?.uid ?? value?.article_uid ?? value?.article_code ??
      value?.catalog_code ?? value?.intalev_article_code ?? value?.code,
  );
  const path = text(
    value?.full_path ?? value?.catalog_path ?? value?.article_path ??
      value?.intalev_article_identity ?? value?.path,
  );
  return code && path ? { code, path } : null;
}

function provenTargetAssessment(items) {
  const missing = [];
  for (const item of items) {
    const status = text(item?.target_proof_status).toUpperCase();
    if (item?.target_classification_proven !== true || status !== "TARGET_CLASSIFICATION_PROVEN") {
      missing.push(`TARGET_CLASSIFICATION_PROVEN:${item.code}`);
    }
    const identities = [item?.target_identity, ...array(item?.target_identities)]
      .map(targetIdentity)
      .filter(Boolean);
    const uniqueIdentities = new Map(identities.map((identity) => [stableJson(identity), identity]));
    if (uniqueIdentities.size !== 1) missing.push(`TARGET_IDENTITY_UNIQUE:${item.code}`);
    const deterministic = item?.deterministic_route === true ||
      item?.route_unique === true || Number(item?.target_route_count) === 1;
    if (!deterministic) missing.push(`ONE_DETERMINISTIC_ROUTE:${item.code}`);
  }
  return { missing };
}

function proofRouting(scope, sourceItems, targetItems, organization, period) {
  const allItems = [...sourceItems, ...targetItems];
  const explicitIntergroup = scope === "INTER_GROUP"
    ? explicitIntergroupProofAssessment(allItems)
    : { proven: false, route_id: null, missing: [] };
  const presentationFlags = allItems.filter((item) => item?.presentation_regrouping === true).length;
  if (presentationFlags === allItems.length && allItems.length > 0) {
    return {
      classification: "PRESENTATION_REGROUPING",
      decision: "UPDATE_MAPPING",
      proof_status: "PRESENTATION_REGROUPING_PROVEN",
      economic_correction_proven: false,
      correction_allowed: false,
      missing_proof: [],
      proven_source_trace_count: 0,
      financial_route: "UPDATE_MAPPING",
      economic_route_proven: false,
      economic_reclass_proven: false,
      accepted_intergroup_reclass: false,
      intergroup_reclass_id: null,
      source_operation_proven: false,
      physical_source_unique: false,
      owner_review_required: false,
      proof_reason: "Exact reporting placement flag routes the zero-sum case to mapping only; no accounting rows are authorized.",
      route_status: "PRESENTATION_REGROUPING_ONLY",
    };
  }
  const source = provenSourceAssessment(sourceItems, organization, period);
  const target = provenTargetAssessment(targetItems);
  const missing = [
    ...(presentationFlags > 0 ? ["PRESENTATION_REGROUPING_SCOPE_INCONSISTENT"] : []),
    ...source.missing,
    ...target.missing,
  ];
  const uniqueMissing = [...new Set(missing)].sort();
  if (uniqueMissing.length === 0) {
    return {
      classification: "FINANCIAL_RECLASS",
      decision: "STORNO_REPOST",
      proof_status: "ECONOMIC_CORRECTION_PROVEN",
      economic_correction_proven: true,
      correction_allowed: true,
      missing_proof: [],
      proven_source_trace_count: source.proven_trace_count,
      financial_route: "STORNO_REPOST",
      economic_route_proven: true,
      economic_reclass_proven: scope === "INTER_GROUP",
      accepted_intergroup_reclass: scope === "INTER_GROUP",
      intergroup_reclass_id: explicitIntergroup.route_id,
      source_operation_proven: true,
      physical_source_unique: true,
      owner_review_required: false,
      proof_reason: "Every source member preserves exact SOURCE_OPERATION_PROVEN identity, organization, month and amount; every target has one deterministic TARGET_CLASSIFICATION_PROVEN identity.",
      route_status: "ECONOMIC_CORRECTION_PROVEN_REPORT_ONLY",
    };
  }
  if (explicitIntergroup.proven) {
    return {
      classification: "FINANCIAL_RECLASS",
      decision: "REVIEW_ONLY",
      proof_status: "ECONOMIC_RECLASS_PROVEN",
      economic_correction_proven: false,
      correction_allowed: false,
      missing_proof: uniqueMissing,
      proven_source_trace_count: source.proven_trace_count,
      financial_route: "STORNO_REPOST_REVIEW_ONLY",
      economic_route_proven: true,
      economic_reclass_proven: true,
      accepted_intergroup_reclass: true,
      intergroup_reclass_id: explicitIntergroup.route_id,
      source_operation_proven: source.missing.length === 0,
      physical_source_unique: source.missing.length === 0,
      owner_review_required: true,
      proof_reason: "An explicit shared intergroup economic route proves source STORNO and target REPOST semantics; incomplete physical source or target proof remains review-only.",
      route_status: "ECONOMIC_RECLASS_PROVEN_PHYSICAL_REVIEW_ONLY",
    };
  }
  return {
    classification: null,
    decision: "REVIEW_ONLY",
    proof_status: "NUMERIC_ZERO_SUM_CANDIDATE_ONLY",
    economic_correction_proven: false,
    correction_allowed: false,
    missing_proof: uniqueMissing,
    proven_source_trace_count: source.proven_trace_count,
    financial_route: "NONE",
    economic_route_proven: false,
    economic_reclass_proven: false,
    accepted_intergroup_reclass: false,
    intergroup_reclass_id: null,
    source_operation_proven: source.missing.length === 0,
    physical_source_unique: source.missing.length === 0,
    owner_review_required: true,
    proof_reason: "Numeric zero-sum is only a candidate; at least one exact source, target, scope or deterministic-route proof is missing.",
    route_status: "NUMERIC_CANDIDATE_ONLY",
  };
}

function buildCandidate(scope, organization, period, sourceItems, targetItems) {
  const sources = [...sourceItems].sort(compareRows);
  const targets = [...targetItems].sort(compareRows);
  const key = candidateKey(sources, targets);
  const sourceCents = sources.reduce((sum, item) => sum + Math.abs(item.delta_cents), 0);
  const targetCents = targets.reduce((sum, item) => sum + Math.abs(item.delta_cents), 0);
  const routing = proofRouting(scope, sources, targets, organization, period);
  const numericClassification = scope === "INTRA_GROUP"
    ? "INTRA_GROUP_RECLASS"
    : "INTER_GROUP_RECLASS";
  return {
    schema: GENERIC_RECLASSIFICATION_SCHEMA,
    mechanism: GENERIC_RECLASSIFICATION_MECHANISM,
    candidate_id: stableId("GENERIC-RECLASS", [
      organization,
      period,
      scope,
      key,
      sourceCents,
      targetCents,
    ]),
    candidate_key: key,
    organization,
    period,
    scope,
    classification: routing.classification ?? numericClassification,
    cardinality: cardinality(sources.length, targets.length),
    source_members: Object.freeze(sources.map((item) => candidateMember({
      ...item,
      accepted_intergroup_reclass: routing.accepted_intergroup_reclass,
    }, "STORNO"))),
    target_members: Object.freeze(targets.map((item) => candidateMember({
      ...item,
      accepted_intergroup_reclass: routing.accepted_intergroup_reclass,
    }, "REPOST"))),
    source_branches: Object.freeze([...new Set(sources.map((item) => item.branch_id))].sort()),
    target_branches: Object.freeze([...new Set(targets.map((item) => item.branch_id))].sort()),
    candidate_amount: money(sourceCents),
    source_amount: money(sourceCents),
    target_amount: money(targetCents),
    net_amount: money(targetCents - sourceCents),
    decision: routing.decision,
    proof_status: routing.proof_status,
    proof_reason: routing.proof_reason,
    missing_proof: Object.freeze(routing.missing_proof),
    proven_source_trace_count: routing.proven_source_trace_count,
    economic_correction_proven: routing.economic_correction_proven,
    economic_reclass_proven: routing.economic_reclass_proven,
    accepted_intergroup_reclass: routing.accepted_intergroup_reclass,
    intergroup_reclass_id: routing.intergroup_reclass_id,
    accepted_amount: routing.accepted_intergroup_reclass ? money(sourceCents) : 0,
    structural_suppression_status: "NOT_STRUCTURALLY_SUPPRESSED",
    processing_stage: scope === "INTER_GROUP"
      ? "INTERGROUP_ROOTS_FIRST"
      : "INTRAGROUP_DESCENDANTS_SECOND",
    stage_order: scope === "INTER_GROUP" ? 1 : 2,
    unproven_reason: routing.accepted_intergroup_reclass ? null : routing.proof_reason,
    financial_route: routing.financial_route,
    economic_route_proven: routing.economic_route_proven,
    source_operation_proven: routing.source_operation_proven,
    physical_source_unique: routing.physical_source_unique,
    owner_review_required: routing.owner_review_required,
    financial_candidate: routing.economic_correction_proven,
    ambiguous: false,
    ambiguity_group_id: null,
    route_status: routing.route_status,
    correction_allowed: routing.correction_allowed,
    execution_allowed: false,
    financial_rows: 0,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
  };
}

function markAmbiguity(candidates) {
  const parents = candidates.map((_, index) => index);
  const find = (index) => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstByMember = new Map();
  const firstByExplicitRoute = new Map();
  candidates.forEach((candidate, index) => {
    for (const id of memberIds(candidate)) {
      if (firstByMember.has(id)) union(index, firstByMember.get(id));
      else firstByMember.set(id, index);
    }
    const routeId = text(candidate.intergroup_reclass_id);
    if (routeId) {
      if (firstByExplicitRoute.has(routeId)) union(index, firstByExplicitRoute.get(routeId));
      else firstByExplicitRoute.set(routeId, index);
    }
  });
  const components = new Map();
  candidates.forEach((_, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(index);
  });
  const ambiguityByIndex = new Map();
  const supersededByIndex = new Map();
  for (const indexes of components.values()) {
    if (indexes.length < 2) continue;
    const explicitAccepted = indexes.filter((index) =>
      candidates[index].accepted_intergroup_reclass === true &&
      text(candidates[index].intergroup_reclass_id));
    // A single explicit, scope-bound route is the authority. Numeric subset
    // alternatives remain visible for review but cannot invalidate or replace
    // it. Multiple explicit routes over the same residual atom remain a
    // conflict and fail closed below.
    if (explicitAccepted.length === 1) {
      const authority = candidates[explicitAccepted[0]];
      for (const index of indexes) {
        if (index !== explicitAccepted[0]) {
          supersededByIndex.set(index, text(authority.intergroup_reclass_id));
        }
      }
      continue;
    }
    const groupId = stableId("AMBIGUOUS-RECLASS", indexes.map((index) => candidates[index].candidate_id).sort());
    for (const index of indexes) ambiguityByIndex.set(index, groupId);
  }
  return candidates.map((candidate, index) => {
    const groupId = ambiguityByIndex.get(index) ?? null;
    const supersededBy = supersededByIndex.get(index) ?? null;
    const blocked = Boolean(groupId || supersededBy);
    return Object.freeze({
      ...candidate,
      classification: blocked ? "REVIEW_ONLY" : candidate.classification,
      ambiguous: Boolean(groupId),
      ambiguity_group_id: groupId,
      superseded_by_intergroup_reclass_id: supersededBy,
      route_status: groupId
        ? "AMBIGUOUS_ROUTE_REVIEW_ONLY"
        : supersededBy
          ? "NUMERIC_ROUTE_SUPERSEDED_BY_EXPLICIT_PROOF"
          : candidate.route_status,
      decision: blocked ? "REVIEW_ONLY" : candidate.decision,
      proof_status: groupId
        ? "AMBIGUOUS_ECONOMIC_ROUTE"
        : supersededBy
          ? "NUMERIC_CANDIDATE_SUPERSEDED"
          : candidate.proof_status,
      economic_correction_proven: blocked ? false : candidate.economic_correction_proven,
      economic_reclass_proven: blocked ? false : candidate.economic_reclass_proven,
      accepted_intergroup_reclass: blocked ? false : candidate.accepted_intergroup_reclass,
      accepted_amount: blocked ? 0 : candidate.accepted_amount,
      source_members: Object.freeze(blocked
        ? candidate.source_members.map((member) => Object.freeze({
            ...member,
            accepted_intergroup_effect: 0,
            root_effective_delta: member.effective_delta,
          }))
        : candidate.source_members),
      target_members: Object.freeze(blocked
        ? candidate.target_members.map((member) => Object.freeze({
            ...member,
            accepted_intergroup_effect: 0,
            root_effective_delta: member.effective_delta,
          }))
        : candidate.target_members),
      financial_route: blocked ? "NONE" : candidate.financial_route,
      financial_candidate: blocked ? false : candidate.financial_candidate,
      missing_proof: Object.freeze(blocked
        ? [...new Set([
            ...(candidate.missing_proof ?? []),
            groupId ? "ONE_DETERMINISTIC_ROUTE" : "EXPLICIT_ROUTE_SUPERSEDED_NUMERIC_CANDIDATE",
          ])].sort()
        : [...(candidate.missing_proof ?? [])]),
      correction_allowed: blocked ? false : candidate.correction_allowed,
      financial_rows: 0,
    });
  });
}

function searchZeroSum(items, {
  organization,
  period,
  scope,
  toleranceCents,
  maxSubsets,
  maxCandidates,
  maxComparisons,
  candidateFilter = () => true,
}) {
  const sources = items.filter((item) => item.delta_cents < -toleranceCents);
  const targets = items.filter((item) => item.delta_cents > toleranceCents);
  if (sources.length === 0 || targets.length === 0) return { complete: true, candidates: [] };
  const sourceSubsets = enumerateSubsets(sources, maxSubsets);
  const targetSubsets = enumerateSubsets(targets, maxSubsets);
  if (!sourceSubsets.complete || !targetSubsets.complete) {
    return { complete: false, blocker: "BLOCKED_RECLASS_SUBSET_LIMIT_EXCEEDED", candidates: [] };
  }
  const targetsBySum = new Map();
  for (const subset of targetSubsets.subsets) {
    if (!targetsBySum.has(subset.sum_cents)) targetsBySum.set(subset.sum_cents, []);
    targetsBySum.get(subset.sum_cents).push(subset);
  }
  const keys = new Set();
  const rawCandidates = [];
  const targetSums = [...targetsBySum.keys()].sort((left, right) => left - right);
  const lowerBound = (needle) => {
    let low = 0;
    let high = targetSums.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (targetSums[middle] < needle) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let comparisons = 0;
  for (const sourceSubset of sourceSubsets.subsets) {
    const minimumTargetSum = sourceSubset.sum_cents - toleranceCents;
    const maximumTargetSum = sourceSubset.sum_cents + toleranceCents;
    for (
      let targetIndex = lowerBound(minimumTargetSum);
      targetIndex < targetSums.length && targetSums[targetIndex] <= maximumTargetSum;
      targetIndex += 1
    ) {
      const targetSubsetsForSum = targetsBySum.get(targetSums[targetIndex]) ?? [];
      for (const targetSubset of targetSubsetsForSum) {
        comparisons += 1;
        if (comparisons > maxComparisons) {
          return {
            complete: false,
            blocker: "BLOCKED_RECLASS_COMPARISON_LIMIT_EXCEEDED",
            candidates: [],
          };
        }
        if (!candidateFilter(sourceSubset.items, targetSubset.items)) continue;
        const key = candidateKey(sourceSubset.items, targetSubset.items);
        if (keys.has(key)) continue;
        keys.add(key);
        rawCandidates.push(buildCandidate(
          scope,
          organization,
          period,
          sourceSubset.items,
          targetSubset.items,
        ));
        if (rawCandidates.length > maxCandidates) {
          return { complete: false, blocker: "BLOCKED_RECLASS_CANDIDATE_LIMIT_EXCEEDED", candidates: [] };
        }
    }
    }
  }
  return {
    complete: true,
    candidates: markAmbiguity(removeCompositeSupersets(rawCandidates)),
  };
}

function candidateOrder(left, right) {
  return left.organization.localeCompare(right.organization, "ru") ||
    left.period.localeCompare(right.period, "en") ||
    (left.stage_order ?? 0) - (right.stage_order ?? 0) ||
    left.candidate_key.localeCompare(right.candidate_key, "en");
}

function hierarchyReviewOnly(candidate) {
  if (candidate.scope === "INTER_GROUP"
    && candidate.accepted_intergroup_reclass === true
    && candidate.economic_reclass_proven === true) {
    return Object.freeze({
      ...candidate,
      hierarchy_independent_economic_route: true,
      descendant_allocation_allowed: false,
      review_blockers: Object.freeze(["HIERARCHY_GRAPH_VALIDATED"]),
    });
  }
  const missingProof = [...new Set([
    ...candidate.missing_proof,
    "HIERARCHY_GRAPH_VALIDATED",
  ])].sort();
  return Object.freeze({
    ...candidate,
    classification: candidate.scope === "INTRA_GROUP"
      ? "INTRA_GROUP_RECLASS"
      : "INTER_GROUP_RECLASS",
    decision: "REVIEW_ONLY",
    proof_status: "NUMERIC_ZERO_SUM_CANDIDATE_ONLY",
    proof_reason: "Numeric zero-sum candidate remains visible, but hierarchy graph validation is missing; economic promotion and every legacy financial route are blocked.",
    missing_proof: Object.freeze(missingProof),
    economic_correction_proven: false,
    economic_reclass_proven: false,
    accepted_intergroup_reclass: false,
    accepted_amount: 0,
    source_members: Object.freeze(candidate.source_members.map((member) => Object.freeze({
      ...member,
      accepted_intergroup_effect: 0,
      root_effective_delta: member.effective_delta,
    }))),
    target_members: Object.freeze(candidate.target_members.map((member) => Object.freeze({
      ...member,
      accepted_intergroup_effect: 0,
      root_effective_delta: member.effective_delta,
    }))),
    economic_route_proven: false,
    owner_review_required: true,
    financial_candidate: false,
    financial_route: "NONE",
    correction_allowed: false,
    route_status: "HIERARCHY_GRAPH_UNPROVEN_REVIEW_ONLY",
    financial_rows: 0,
    posting_rows: 0,
  });
}

/**
 * Partitions exact organizations and concrete months, searches the highest
 * nonzero group residual in each branch for intergroup routes first, reserves
 * those root candidates, and then searches remaining normalized descendants
 * within each branch. Economic acceptance remains separate from physical
 * posting proof, and no result from this module has execution authority.
 */
export function detectGenericReclassifications(rows, {
  tolerance = 0.01,
  hierarchy_graph_validated: hierarchyGraphValidated = true,
  structural_control_groups: structuralControlGroups = STRUCTURAL_CONTROL_GROUPS,
  max_subsets: maxSubsets = DEFAULT_MAX_SUBSETS,
  max_candidates: maxCandidates = DEFAULT_MAX_CANDIDATES,
  max_comparisons: maxComparisons = DEFAULT_MAX_COMPARISONS,
} = {}) {
  const toleranceCents = Math.max(0, Math.round(Math.abs(Number(tolerance) || 0) * 100));
  const safeMaxSubsets = Number.isInteger(Number(maxSubsets)) && Number(maxSubsets) > 0
    ? Number(maxSubsets)
    : DEFAULT_MAX_SUBSETS;
  const safeMaxCandidates = Number.isInteger(Number(maxCandidates)) && Number(maxCandidates) > 0
    ? Number(maxCandidates)
    : DEFAULT_MAX_CANDIDATES;
  const safeMaxComparisons = Number.isInteger(Number(maxComparisons)) && Number(maxComparisons) > 0
    ? Number(maxComparisons)
    : DEFAULT_MAX_COMPARISONS;
  const normalized = normalizeHierarchyResiduals(rows, {
    tolerance,
    structural_control_groups: structuralControlGroups,
  });
  const normalizationBlockers = new Map();
  for (const diagnostic of normalized.diagnostics) {
    if (!text(diagnostic?.blocker).startsWith("BLOCKED_")) continue;
    const key = scopeKey(text(diagnostic?.organization), text(diagnostic?.period));
    if (!normalizationBlockers.has(key)) normalizationBlockers.set(key, []);
    normalizationBlockers.get(key).push(text(diagnostic.blocker));
  }
  const ignored = { invalid_period: 0, organization_missing: 0, non_numeric: 0, zero: 0 };
  const exemptRows = [];
  const eligible = [];
  const normalizedByPartition = new Map();
  for (const row of normalized.rows) {
    if (isOwnerPresentationBlockExempt(row.code, structuralControlGroups)) {
      exemptRows.push(Object.freeze({
        code: row.code,
        row_id: row.row_id,
        organization: row.organization,
        period: row.period,
        classification: "OWNER_PRESENTATION_BLOCK_EXEMPT",
        control_classification: "CONTROL_ONLY",
        posting_classification: "NON_POSTING",
        structural_control_group_id: row.structural_control_group_id,
        control_only: true,
        non_posting: true,
        candidate_generation_allowed: false,
        structural_suppression_status: "ACTIVE_CONFIG_ROOT_SUPPRESSED",
        normalized_delta: row.normalized_delta,
        financial_rows: 0,
      }));
      continue;
    }
    if (!MONTH_PATTERN.test(row.period)) { ignored.invalid_period += 1; continue; }
    if (!row.organization) { ignored.organization_missing += 1; continue; }
    const key = scopeKey(row.organization, row.period);
    if (!normalizedByPartition.has(key)) normalizedByPartition.set(key, []);
    normalizedByPartition.get(key).push(row);
    const deltaCents = cents(row.normalized_delta);
    if (deltaCents === null) { ignored.non_numeric += 1; continue; }
    if (Math.abs(deltaCents) <= toleranceCents) { ignored.zero += 1; continue; }
    eligible.push({
      ...row,
      delta_cents: deltaCents,
      branch_id: text(row.branch_id) || row.code,
    });
  }
  eligible.sort(compareRows);

  const byPartition = new Map();
  for (const item of eligible) {
    const key = scopeKey(item.organization, item.period);
    if (!byPartition.has(key)) byPartition.set(key, []);
    byPartition.get(key).push(item);
  }
  // Keep empty but valid partitions visible so cross-org/cross-period negatives
  // are auditable rather than disappearing from the detector result.
  for (const key of normalizedByPartition.keys()) {
    if (!byPartition.has(key)) byPartition.set(key, []);
  }

  const partitions = [];
  const candidates = [];
  const reserved = new Set();
  const sortedPartitions = [...byPartition.entries()].sort(([left], [right]) => left.localeCompare(right, "ru"));
  for (const [partitionKey, partitionItems] of sortedPartitions) {
    const representative = partitionItems[0];
    const [organization = "", period = ""] = partitionItems.length > 0
      ? [representative.organization, representative.period]
      : ["", ""];
    // Recover identity for an empty valid partition from the map key.
    const [partitionOrganization, partitionPeriod] = partitionKey.split("\u0000");
    const effectiveOrganization = organization || partitionOrganization;
    const effectivePeriod = period || partitionPeriod;
    const hierarchyBlockers = [...new Set(normalizationBlockers.get(partitionKey) ?? [])];
    const searchBlockers = [];
    const partitionCandidates = [];
    const allPartitionRows = normalizedByPartition.get(partitionKey) ?? [];
    const hierarchyByCode = new Map(allPartitionRows.map((item) => [item.code, item]));
    const isDescendantOf = (item, ancestorCode) => {
      const seen = new Set();
      let current = item;
      while (current?.parent_id) {
        if (seen.has(current.code)) return false;
        seen.add(current.code);
        if (current.parent_id === ancestorCode) return true;
        current = hierarchyByCode.get(current.parent_id);
      }
      return false;
    };
    const hierarchyRelationshipAllowed = (sourceItems, targetItems) =>
      sourceItems.every((source) => targetItems.every((target) =>
        !isDescendantOf(source, target.code) && !isDescendantOf(target, source.code)));
    const structuralExceptionDescendantNettingAllowed = (sourceItems, targetItems) => {
      const rootsBySet = new Map();
      for (const item of [...sourceItems, ...targetItems]) {
        const setId = text(item.structural_exception_control_set_id);
        const rootCode = text(item.structural_exception_root_code);
        if (!setId || !rootCode || item.code === rootCode) continue;
        if (!rootsBySet.has(setId)) rootsBySet.set(setId, new Set());
        rootsBySet.get(setId).add(rootCode);
      }
      return [...rootsBySet.values()].every((roots) => roots.size <= 1);
    };
    const candidateRelationshipAllowed = (sourceItems, targetItems) =>
      hierarchyRelationshipAllowed(sourceItems, targetItems)
      && structuralExceptionDescendantNettingAllowed(sourceItems, targetItems);
    const preDescendantDeltaCents = (item) => {
      const explicit = cents(item?.intergroup_root_delta);
      if (explicit !== null) return explicit;
      const raw = cents(item?.raw_delta);
      const mapping = cents(item?.proven_mapping_adjustment) ?? 0;
      return raw === null ? null : raw - mapping;
    };
    const hasNonzeroAncestor = (item) => {
      const seen = new Set([item.code]);
      let current = hierarchyByCode.get(item.parent_id);
      while (current && !seen.has(current.code)) {
        seen.add(current.code);
        const ancestorDelta = preDescendantDeltaCents(current);
        if (ancestorDelta !== null && Math.abs(ancestorDelta) > toleranceCents) return true;
        current = hierarchyByCode.get(current.parent_id);
      }
      return false;
    };
    const intergroupRoots = allPartitionRows
      .filter((item) => !text(item.structural_exception_control_set_id))
      .map((item) => ({
        ...item,
        delta_cents: preDescendantDeltaCents(item),
        branch_id: text(item.branch_id) || item.code,
      }))
      .filter((item) => item.delta_cents !== null
        && Math.abs(item.delta_cents) > toleranceCents
        && (Math.abs(cents(item.normalized_delta) ?? 0) > toleranceCents
          || text(item.intergroup_reclass_proof_status).toUpperCase() === "ECONOMIC_RECLASS_PROVEN")
        && (text(item.intergroup_reclass_proof_status).toUpperCase() === "ECONOMIC_RECLASS_PROVEN"
          || !hasNonzeroAncestor(item)));
    const inter = searchZeroSum(intergroupRoots, {
      organization: effectiveOrganization,
      period: effectivePeriod,
      scope: "INTER_GROUP",
      toleranceCents,
      maxSubsets: safeMaxSubsets,
      maxCandidates: safeMaxCandidates,
      maxComparisons: safeMaxComparisons,
      candidateFilter: (sourceItems, targetItems) => {
        const branches = new Set([...sourceItems, ...targetItems].map((item) => item.branch_id));
        const explicitRoute = explicitIntergroupProofAssessment(
          [...sourceItems, ...targetItems]).proven;
        return explicitRoute || (branches.size > 1
          && (hierarchyGraphValidated !== true
            || [...sourceItems, ...targetItems].every(
              (item) => item.economic_relationship_evidence === true))
          && candidateRelationshipAllowed(sourceItems, targetItems));
      },
    });
    if (!inter.complete) {
      searchBlockers.push(inter.blocker);
      partitionCandidates.length = 0;
      for (const item of partitionItems) {
        reserved.delete(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${item.row_id}`);
      }
    }
    for (const candidate of inter.candidates) {
      partitionCandidates.push(candidate);
      for (const id of memberIds(candidate)) reserved.add(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${id}`);
    }

    const intergroupResiduals = partitionItems.filter((item) =>
      !reserved.has(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${item.row_id}`));
    const descendantSearchComplete = hierarchyBlockers.length === 0
      && searchBlockers.length === 0;
    const residualInter = !descendantSearchComplete ? { complete: true, candidates: [] } : searchZeroSum(intergroupResiduals, {
      organization: effectiveOrganization,
      period: effectivePeriod,
      scope: "INTER_GROUP",
      toleranceCents,
      maxSubsets: safeMaxSubsets,
      maxCandidates: safeMaxCandidates,
      maxComparisons: safeMaxComparisons,
      candidateFilter: (sourceItems, targetItems) => {
        const branches = new Set([...sourceItems, ...targetItems].map((item) => item.branch_id));
        const explicitRoute = explicitIntergroupProofAssessment(
          [...sourceItems, ...targetItems]).proven;
        return explicitRoute || (branches.size > 1 && (
          hierarchyGraphValidated !== true ||
          [...sourceItems, ...targetItems].every((item) => item.economic_relationship_evidence === true)
        ) && candidateRelationshipAllowed(sourceItems, targetItems));
      },
    });
    if (!residualInter.complete) searchBlockers.push(residualInter.blocker);
    for (const candidate of residualInter.candidates) {
      partitionCandidates.push(Object.freeze({
        ...candidate,
        processing_stage: "INTERGROUP_RESIDUALS_FIRST",
      }));
      for (const id of memberIds(candidate)) reserved.add(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${id}`);
    }

    const byBranch = new Map();
    for (const item of partitionItems.filter((candidate) =>
      !reserved.has(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${candidate.row_id}`))) {
      if (!byBranch.has(item.branch_id)) byBranch.set(item.branch_id, []);
      byBranch.get(item.branch_id).push(item);
    }
    for (const [branch, branchItems] of !descendantSearchComplete || searchBlockers.length > 0
      ? []
      : [...byBranch.entries()].sort(([left], [right]) => left.localeCompare(right, "ru"))) {
      const searched = searchZeroSum(branchItems, {
        organization: effectiveOrganization,
        period: effectivePeriod,
        scope: "INTRA_GROUP",
        toleranceCents,
        maxSubsets: safeMaxSubsets,
        maxCandidates: safeMaxCandidates,
        maxComparisons: safeMaxComparisons,
        candidateFilter: candidateRelationshipAllowed,
      });
      if (!searched.complete) searchBlockers.push(`${branch}:${searched.blocker}`);
      for (const candidate of searched.candidates) {
        partitionCandidates.push(candidate);
        for (const id of memberIds(candidate)) reserved.add(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${id}`);
      }
    }
    if (searchBlockers.length > 0) {
      partitionCandidates.length = 0;
      for (const item of allPartitionRows) {
        reserved.delete(scopeKey(effectiveOrganization, effectivePeriod) + `\u0000${item.row_id}`);
      }
    }
    const publishedCandidates = (hierarchyGraphValidated === true
      ? partitionCandidates
      : partitionCandidates.map(hierarchyReviewOnly))
      .sort(candidateOrder);
    candidates.push(...publishedCandidates);
    partitions.push(Object.freeze({
      organization: effectiveOrganization,
      period: effectivePeriod,
      eligible_residual_count: partitionItems.length,
      candidate_count: publishedCandidates.length,
      intra_candidate_count: publishedCandidates.filter((candidate) => candidate.scope === "INTRA_GROUP").length,
      inter_candidate_count: publishedCandidates.filter((candidate) => candidate.scope === "INTER_GROUP").length,
      accepted_intergroup_count: publishedCandidates.filter((candidate) =>
        candidate.accepted_intergroup_reclass === true).length,
      processing_order: Object.freeze([
        "INTERGROUP_ROOTS_FIRST",
        "INTRAGROUP_DESCENDANTS_SECOND",
      ]),
      status: searchBlockers.length > 0
        ? "BLOCKED_BOUNDED_SEARCH_INCOMPLETE"
        : (hierarchyGraphValidated !== true || hierarchyBlockers.length > 0)
          && publishedCandidates.some(
          (candidate) => candidate.accepted_intergroup_reclass === true)
          ? "INTERGROUP_ROUTE_PROVEN_DESCENDANTS_BLOCKED"
        : hierarchyGraphValidated !== true && publishedCandidates.length > 0
          ? "HIERARCHY_GRAPH_UNPROVEN_REVIEW_ONLY"
        : publishedCandidates.some((candidate) => candidate.ambiguous)
          ? "AMBIGUOUS_RECLASS_REVIEW_ONLY"
          : publishedCandidates.length > 0
            ? "RECLASS_CANDIDATES_FOUND"
            : "NO_RECLASS_CANDIDATES",
      blockers: Object.freeze(searchBlockers),
      review_blockers: Object.freeze([...new Set([
        ...hierarchyBlockers,
        ...(hierarchyGraphValidated === true ? [] : ["HIERARCHY_GRAPH_VALIDATED"]),
      ])]),
    }));
  }
  candidates.sort(candidateOrder);
  const unmatched = eligible
    .filter((item) => !reserved.has(scopeKey(item.organization, item.period) + `\u0000${item.row_id}`))
    .map((item) => Object.freeze({
      row_id: item.row_id,
      code: item.code,
      organization: item.organization,
      period: item.period,
      branch_id: item.branch_id,
      normalized_delta: money(item.delta_cents),
      decision: "REVIEW_ONLY",
      financial_rows: 0,
      source_traces: Object.freeze(structuredClone(item.source_traces)),
    }));
  const acceptedRootCounts = new Map();
  for (const candidate of candidates.filter((item) => item.accepted_intergroup_reclass === true)) {
    for (const member of [...candidate.source_members, ...candidate.target_members]) {
      const key = scopeKey(candidate.organization, candidate.period) + `\u0000${member.row_id}`;
      acceptedRootCounts.set(key, (acceptedRootCounts.get(key) ?? 0) + 1);
    }
  }
  const duplicateRootCorrectionCount = [...acceptedRootCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count - 1, 0);

  return Object.freeze({
    schema: GENERIC_RECLASSIFICATION_SCHEMA,
    mechanism: GENERIC_RECLASSIFICATION_MECHANISM,
    normalization: normalized,
    candidates: Object.freeze(candidates),
    partitions: Object.freeze(partitions),
    exempt_rows: Object.freeze(exemptRows.sort((left, right) => left.code.localeCompare(right.code, "en"))),
    unmatched_residuals: Object.freeze(unmatched),
    ignored: Object.freeze(ignored),
    audit: Object.freeze({
      processing_order: Object.freeze([
        "INTERGROUP_ROOTS_FIRST",
        "INTRAGROUP_DESCENDANTS_SECOND",
      ]),
      accepted_intergroup_count: candidates.filter((candidate) =>
        candidate.accepted_intergroup_reclass === true).length,
      duplicate_root_correction_count: duplicateRootCorrectionCount,
    }),
    safety: Object.freeze({
      report_only: true,
      correction_allowed: false,
      financial_rows: 0,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      execution_allowed: false,
      add_one_side_rows: 0,
      storno_rows: 0,
      repost_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      live_delete_allowed: false,
    }),
  });
}
