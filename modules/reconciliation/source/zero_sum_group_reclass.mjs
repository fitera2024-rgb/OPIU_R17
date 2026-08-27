import { isOwnerPresentationBlockExempt } from "./owner_presentation_block_exemption.mjs";

const SHA256_PATTERN = /^[A-F0-9]{64}$/i;

export const ZERO_SUM_GROUP_RULE_ID = "zero_sum_group_storno_repost";
export const ZERO_SUM_GROUP_SCHEMA = "opiu-zero-sum-group-storno-repost-v1";

const RELEASE_GATES = Object.freeze([
  "duplicate_control_passed",
  "storno_source_sign_inversion_passed",
  "idempotency_control_passed",
  "live_1c_preflight_passed",
  "osv_control_passed",
]);

function normalizeText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundAmount(value) {
  return Number(value.toFixed(10));
}

export function buildStornoRepostAmounts(sourceAmount) {
  if (!finiteNumber(sourceAmount) || sourceAmount === 0) {
    return Object.freeze({
      status: "BLOCKED_SOURCE_AMOUNT_INVALID",
      source_amount: finiteNumber(sourceAmount) ? sourceAmount : null,
      storno_amount: null,
      repost_amount: null,
      pair_net_amount: null,
      posting_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
    });
  }
  const stornoAmount = roundAmount(-sourceAmount);
  const repostAmount = roundAmount(sourceAmount);
  return Object.freeze({
    status: "PASS_SOURCE_SIGN_PRESERVED",
    source_amount: sourceAmount,
    storno_amount: stornoAmount,
    repost_amount: repostAmount,
    pair_net_amount: roundAmount(stornoAmount + repostAmount),
    posting_allowed: false,
    candidate_generation_allowed: true,
    candidate_only: true,
    ready_to_upload: false,
    release_allowed: false,
  });
}

export function validateStornoRepostAmounts({
  source_amount: sourceAmount,
  storno_amount: stornoAmount,
  repost_amount: repostAmount,
  tolerance = 0.01,
} = {}) {
  const normalizedTolerance = Math.abs(Number(tolerance));
  const numeric = [sourceAmount, stornoAmount, repostAmount].every(finiteNumber);
  const validTolerance = finiteNumber(normalizedTolerance);
  const signPreserved =
    numeric &&
    validTolerance &&
    Math.abs(stornoAmount + sourceAmount) <= normalizedTolerance &&
    Math.abs(repostAmount - sourceAmount) <= normalizedTolerance &&
    Math.abs(stornoAmount + repostAmount) <= normalizedTolerance;
  return Object.freeze({
    status: signPreserved
      ? "PASS_SOURCE_SIGN_PRESERVED"
      : "BLOCKED_STORNO_REPOST_SIGN_OR_NET_INVALID",
    source_amount: numeric ? sourceAmount : null,
    storno_amount: numeric ? stornoAmount : null,
    repost_amount: numeric ? repostAmount : null,
    pair_net_amount: numeric ? roundAmount(stornoAmount + repostAmount) : null,
    posting_allowed: false,
    candidate_generation_allowed: signPreserved,
    ready_to_upload: false,
    release_allowed: false,
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function sourceTraceComplete(trace) {
  const physicalRow = trace?.physical_row ?? trace?.row;
  const period = trace?.month ?? trace?.period;
  return Boolean(
    normalizeText(trace?.source_file) &&
      SHA256_PATTERN.test(normalizeText(trace?.sha256)) &&
      normalizeText(trace?.sheet) &&
      Number.isInteger(Number(physicalRow)) &&
      Number(physicalRow) > 0 &&
      normalizeText(trace?.source_cell) &&
      normalizeText(period),
  );
}

function targetIdentityComplete(identity) {
  const immutableCode =
    identity?.uid ??
    identity?.article_uid ??
    identity?.article_code ??
    identity?.catalog_code ??
    identity?.intalev_article_code;
  const fullPath =
    identity?.full_path ??
    identity?.catalog_path ??
    identity?.article_path ??
    identity?.intalev_article_identity;
  return Boolean(normalizeText(immutableCode) && normalizeText(fullPath));
}

function blockedResult({ groupId, members, tolerance, blockers, deltaSum = null }) {
  return Object.freeze({
    schema: ZERO_SUM_GROUP_SCHEMA,
    rule_id: ZERO_SUM_GROUP_RULE_ID,
    group_id: normalizeText(groupId),
    decision_class: "BLOCKED",
    status: blockers[0] ?? "BLOCKED_ZERO_SUM_GROUP_UNPROVEN",
    blockers: Object.freeze([...new Set(blockers)]),
    member_count: Array.isArray(members) ? members.length : 0,
    delta_sum: deltaSum,
    tolerance,
    posting_allowed: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    required_release_gates: RELEASE_GATES,
  });
}

/**
 * Classifies an explicitly supplied set of hierarchy leaves under the
 * INTALEV_MINUS_ERP delta convention.  It never builds accounting rows.
 * Negative members are the ERP source side and therefore require exact source
 * traces. Positive members are target articles and require immutable target
 * identities (code/UID plus full path).
 */
export function classifyZeroSumGroupStornoRepost({
  group_id: groupId,
  members,
  tolerance = 0.01,
  delta_convention: deltaConvention = "INTALEV_MINUS_ERP",
} = {}) {
  const normalizedTolerance = Math.abs(Number(tolerance));
  const blockers = [];
  if (!normalizeText(groupId)) blockers.push("BLOCKED_GROUP_ID_MISSING");
  if (!finiteNumber(normalizedTolerance)) blockers.push("BLOCKED_TOLERANCE_INVALID");
  if (deltaConvention !== "INTALEV_MINUS_ERP") {
    blockers.push("BLOCKED_DELTA_CONVENTION_UNSUPPORTED");
  }
  if (!Array.isArray(members) || members.length < 2) {
    blockers.push("BLOCKED_EXPLICIT_MEMBERS_MISSING");
    return blockedResult({
      groupId,
      members,
      tolerance: normalizedTolerance,
      blockers,
    });
  }

  const ids = members.map((member) => normalizeText(member?.member_id));
  if (ids.some((memberId) => !memberId)) blockers.push("BLOCKED_MEMBER_ID_MISSING");
  if (new Set(ids).size !== ids.length) blockers.push("BLOCKED_DUPLICATE_MEMBER_ID");
  if (members.some((member) => member?.member_explicit !== true)) {
    blockers.push("BLOCKED_MEMBERS_NOT_EXPLICIT");
  }
  if (members.some((member) => member?.is_leaf !== true)) {
    blockers.push("BLOCKED_MEMBER_NOT_LEAF");
  }
  if (members.some((member) => !finiteNumber(member?.delta))) {
    blockers.push("BLOCKED_NON_NUMERIC_DELTA");
    return blockedResult({
      groupId,
      members,
      tolerance: normalizedTolerance,
      blockers,
    });
  }

  const negativeMembers = members.filter((member) => member.delta < 0);
  const positiveMembers = members.filter((member) => member.delta > 0);
  if (negativeMembers.length === 0 || positiveMembers.length === 0) {
    blockers.push("BLOCKED_POSITIVE_AND_NEGATIVE_MEMBERS_REQUIRED");
  }

  const deltaSum = roundAmount(members.reduce((sum, member) => sum + member.delta, 0));
  if (Math.abs(deltaSum) > normalizedTolerance) {
    blockers.push("BLOCKED_GROUP_DELTA_NOT_ZERO");
  }

  const incompleteSources = negativeMembers
    .filter((member) => {
      const traces = asArray(member.source_traces ?? member.source_trace);
      return member.source_trace_complete !== true || traces.length === 0 || !traces.every(sourceTraceComplete);
    })
    .map((member) => normalizeText(member.member_id));
  if (incompleteSources.length > 0) blockers.push("BLOCKED_SOURCE_TRACE_INCOMPLETE");

  const incompleteTargets = positiveMembers
    .filter((member) => {
      const identities = asArray(member.target_identities ?? member.target_identity);
      return (
        member.target_identity_complete !== true ||
        identities.length === 0 ||
        !identities.every(targetIdentityComplete)
      );
    })
    .map((member) => normalizeText(member.member_id));
  if (incompleteTargets.length > 0) blockers.push("BLOCKED_TARGET_IDENTITY_INCOMPLETE");

  if (blockers.length > 0) {
    return Object.freeze({
      ...blockedResult({
        groupId,
        members,
        tolerance: normalizedTolerance,
        blockers,
        deltaSum,
      }),
      incomplete_source_member_ids: Object.freeze(incompleteSources),
      incomplete_target_member_ids: Object.freeze(incompleteTargets),
    });
  }

  return Object.freeze({
    schema: ZERO_SUM_GROUP_SCHEMA,
    rule_id: ZERO_SUM_GROUP_RULE_ID,
    group_id: normalizeText(groupId),
    decision_class: "STORNO_REPOST_CANDIDATE",
    status: "PASS_ZERO_SUM_GROUP_STORNO_REPOST_CANDIDATE",
    blockers: Object.freeze([]),
    member_count: members.length,
    source_member_ids: Object.freeze(negativeMembers.map((member) => normalizeText(member.member_id))),
    target_member_ids: Object.freeze(positiveMembers.map((member) => normalizeText(member.member_id))),
    delta_sum: deltaSum,
    tolerance: normalizedTolerance,
    posting_allowed: false,
    candidate_generation_allowed: true,
    candidate_only: true,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    required_release_gates: RELEASE_GATES,
  });
}

function targetIdentitiesFromRow(row) {
  return (row?.intalev_sources ?? [])
    .map((source) => ({
      intalev_article_code: source?.intalev_article_code,
      intalev_article_identity: source?.intalev_article_identity,
      full_path: source?.full_path,
    }))
    .filter(targetIdentityComplete);
}

export function assessZeroSumHierarchyGroups(
  rows,
  {
    hierarchy_graph_validated: hierarchyGraphValidated,
    tolerance = 0.01,
    structural_control_groups: structuralControlGroups = [],
  } = {},
) {
  if (hierarchyGraphValidated !== true) {
    return Object.freeze({
      schema: ZERO_SUM_GROUP_SCHEMA,
      rule_id: ZERO_SUM_GROUP_RULE_ID,
      status: "BLOCKED_HIERARCHY_GRAPH_NOT_VALIDATED",
      assessed_group_count: 0,
      candidate_count: 0,
      assessments: Object.freeze([]),
      candidates: Object.freeze([]),
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    });
  }

  const byParent = new Map();
  for (const row of rows ?? []) {
    if (isOwnerPresentationBlockExempt(row, structuralControlGroups)) continue;
    const parentId = normalizeText(row?.hierarchy_parent_node_id);
    if (!parentId || row?.hierarchy_has_children === true || !finiteNumber(row?.delta)) continue;
    if (Math.abs(row.delta) <= Math.abs(Number(tolerance))) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(row);
  }

  const assessments = [];
  for (const [parentId, groupRows] of byParent.entries()) {
    if (groupRows.length < 2) continue;
    const members = groupRows.map((row) => {
      const sourceTraces = row.delta < 0 ? asArray(row.erp_sources) : [];
      const targetIdentities = row.delta > 0 ? targetIdentitiesFromRow(row) : [];
      return {
        member_id: normalizeText(row.hierarchy_node_id) || normalizeText(row.code),
        member_explicit: true,
        is_leaf: row.hierarchy_has_children === false,
        delta: row.delta,
        source_trace_complete:
          row.delta >= 0 || (sourceTraces.length > 0 && sourceTraces.every(sourceTraceComplete)),
        source_traces: sourceTraces,
        target_identity_complete:
          row.delta <= 0 || targetIdentities.length > 0,
        target_identities: targetIdentities,
      };
    });
    assessments.push(
      classifyZeroSumGroupStornoRepost({
        group_id: parentId,
        members,
        tolerance,
      }),
    );
  }

  const candidates = assessments.filter(
    (assessment) => assessment.decision_class === "STORNO_REPOST_CANDIDATE",
  );
  return Object.freeze({
    schema: ZERO_SUM_GROUP_SCHEMA,
    rule_id: ZERO_SUM_GROUP_RULE_ID,
    status: candidates.length > 0
      ? "STORNO_REPOST_CANDIDATES_FOUND"
      : "NO_PROVEN_ZERO_SUM_GROUP_CANDIDATES",
    assessed_group_count: assessments.length,
    candidate_count: candidates.length,
    assessments: Object.freeze(assessments),
    candidates: Object.freeze(candidates),
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  });
}
