import {
  aggregateProvenRows,
  buildAggregationGrainIdentity,
} from "./aggregation_grain.mjs";

const DEFAULT_TOLERANCE = 0.01;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundMoney(value) {
  if (!isFiniteNumber(value)) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nodeLabel(node) {
  return String(node?.label ?? node?.article ?? node?.summary_label ?? "").trim();
}

function directChildIndexes(nodes, parentIndex) {
  const parentLevel = Number(nodes[parentIndex]?.level);
  if (!Number.isInteger(parentLevel) || parentLevel < 0) return [];

  const result = [];
  for (let index = parentIndex + 1; index < nodes.length; index += 1) {
    const candidateLevel = Number(nodes[index]?.level);
    if (!Number.isInteger(candidateLevel) || candidateLevel <= parentLevel) break;
    if (candidateLevel === parentLevel + 1) result.push(index);
  }
  return result;
}

function proofReason({
  parentAmount,
  childAmounts,
  childAmountsComplete,
  delta,
  tolerance,
  descendantsComplete,
}) {
  if (!isFiniteNumber(parentAmount)) return "MISSING_PARENT_TOTAL";
  if (!childAmountsComplete) return "INCOMPLETE_CHILD_VALUES";
  if (
    Math.abs(parentAmount) <= tolerance &&
    childAmounts.some((value) => Math.abs(value) > tolerance)
  ) {
    return "ZERO_PARENT_NONZERO_CHILD";
  }
  if (!isFiniteNumber(delta) || Math.abs(delta) > tolerance) {
    return "CHILD_SUM_MISMATCH";
  }
  if (!descendantsComplete) return "DESCENDANT_PROOF_INCOMPLETE";
  return "";
}

/**
 * Add a recursive, fail-closed parent/child proof to an ordered outline tree.
 * The function intentionally mutates the source nodes so all existing trace
 * references keep the same object identity.
 */
export function annotateSourceTree(
  nodes,
  {
    amountKey,
    tolerance = DEFAULT_TOLERANCE,
    sourceSystem = "SOURCE",
  } = {},
) {
  if (!Array.isArray(nodes)) throw new TypeError("nodes must be an array");
  if (!amountKey) throw new TypeError("amountKey is required");
  const numericTolerance = Number(tolerance);
  if (!Number.isFinite(numericTolerance) || numericTolerance < 0) {
    throw new TypeError("tolerance must be a non-negative number");
  }

  const childIndexes = nodes.map((_, index) => directChildIndexes(nodes, index));
  const memo = new Map();
  const visiting = new Set();

  function evaluate(index) {
    if (memo.has(index)) return memo.get(index);
    const node = nodes[index];
    if (!node) {
      return {
        complete: false,
        traceIndexes: [],
        leafIndexes: [],
      };
    }
    if (visiting.has(index)) {
      node.child_indexes = childIndexes[index];
      node.child_sum = null;
      node.hierarchy_delta = null;
      node.hierarchy_status = "BLOCKED";
      node.hierarchy_reason = "CYCLE_DETECTED";
      node.source_tree_proof_complete = false;
      return {
        complete: false,
        traceIndexes: [index],
        leafIndexes: [],
      };
    }

    visiting.add(index);
    const children = childIndexes[index];
    const amount = node[amountKey];
    node.child_indexes = [...children];
    node.aggregation_grain = children.length === 0
      ? buildAggregationGrainIdentity(node, {
          sourceSystem,
          aggregationKey: node.source_identity ?? node.aggregation_grain_id ?? "",
        })
      : aggregateProvenRows(
          children.map((childIndex) => nodes[childIndex]),
          {
            sourceSystem,
            aggregationKey: node.source_identity ?? node.aggregation_grain_id ?? "",
            amountProperty: amountKey,
          },
        );

    if (children.length === 0) {
      const complete = isFiniteNumber(amount) && node.requires_child_proof !== true;
      const reason = node.requires_child_proof === true
        ? "DIRECT_TOTAL_ONLY"
        : isFiniteNumber(amount)
          ? ""
          : "MISSING_LEAF_VALUE";
      node.child_sum = null;
      node.hierarchy_delta = null;
      node.hierarchy_status = complete ? "LEAF" : "BLOCKED";
      node.hierarchy_reason = reason;
      node.source_tree_proof_complete = complete;
      node.source_tree_leaf_indexes = [index];
      node.source_tree_trace_indexes = [index];
      node.source_tree_proof = {
        source_system: sourceSystem,
        status: node.hierarchy_status,
        reason,
        complete,
        parent_total: isFiniteNumber(amount) ? roundMoney(amount) : null,
        child_sum: null,
        delta: null,
        child_count: 0,
        leaf_count: 1,
        covered_leaf_count: isFiniteNumber(amount) ? 1 : 0,
        full_path: String(node.full_path ?? ""),
        child_composition: [],
        aggregation_grain: node.aggregation_grain,
      };
      const result = {
        complete,
        traceIndexes: [index],
        leafIndexes: [index],
      };
      memo.set(index, result);
      visiting.delete(index);
      return result;
    }

    const childProofs = children.map(evaluate);
    const childAmounts = children.map((childIndex) => nodes[childIndex]?.[amountKey]);
    const childAmountsComplete = node.aggregation_grain.status === "PROVEN";
    const childSum = childAmountsComplete
      ? roundMoney(node.aggregation_grain.amount)
      : null;
    const delta = isFiniteNumber(amount) && isFiniteNumber(childSum)
      ? roundMoney(amount - childSum)
      : null;
    const descendantsComplete = childProofs.every((proof) => proof.complete);
    const reason = node.aggregation_grain.status === "REVIEW_ONLY"
      ? "AGGREGATION_GRAIN_UNPROVEN"
      : node.aggregation_grain.status === "BLOCKED"
        ? "PROVEN_COMPOSITION_CONTRADICTION"
        : proofReason({
            parentAmount: amount,
            childAmounts,
            childAmountsComplete,
            delta,
            tolerance: numericTolerance,
            descendantsComplete,
          });
    const complete = reason === "";
    const traceIndexes = [
      index,
      ...childProofs.flatMap((proof) => proof.traceIndexes),
    ];
    const leafIndexes = childProofs.flatMap((proof) => proof.leafIndexes);
    const coveredLeafCount = leafIndexes.filter((leafIndex) =>
      isFiniteNumber(nodes[leafIndex]?.[amountKey]),
    ).length;
    const childComposition = children.map((childIndex) => {
      const child = nodes[childIndex];
      return {
        index: childIndex,
        label: nodeLabel(child),
        full_path: String(child?.full_path ?? ""),
        source_cell: String(child?.source_cell ?? ""),
        row: child?.row ?? null,
        amount: isFiniteNumber(child?.[amountKey])
          ? roundMoney(child[amountKey])
          : null,
        has_children: childIndexes[childIndex].length > 0,
        proof_status: String(child?.hierarchy_status ?? ""),
        proof_reason: String(child?.hierarchy_reason ?? ""),
      };
    });

    node.child_sum = childSum;
    node.hierarchy_delta = delta;
    node.hierarchy_status = complete ? "PASS" : "BLOCKED";
    node.hierarchy_reason = reason;
    node.source_tree_proof_complete = complete;
    node.source_tree_leaf_indexes = [...leafIndexes];
    node.source_tree_trace_indexes = [...traceIndexes];
    node.source_tree_proof = {
      source_system: sourceSystem,
      status: node.hierarchy_status,
      reason,
      complete,
      parent_total: isFiniteNumber(amount) ? roundMoney(amount) : null,
      child_sum: childSum,
      delta,
      child_count: children.length,
      leaf_count: leafIndexes.length,
      covered_leaf_count: coveredLeafCount,
      full_path: String(node.full_path ?? ""),
      child_composition: childComposition,
      aggregation_grain: node.aggregation_grain,
    };

    const result = { complete, traceIndexes, leafIndexes };
    memo.set(index, result);
    visiting.delete(index);
    return result;
  }

  for (let index = nodes.length - 1; index >= 0; index -= 1) evaluate(index);
  return nodes;
}

export function sourceTreeTrace(nodes, nodeIndex) {
  const node = nodes?.[nodeIndex];
  if (!node) return [];
  const indexes = Array.isArray(node.source_tree_trace_indexes)
    ? node.source_tree_trace_indexes
    : [nodeIndex];
  return indexes.map((index) => nodes[index]).filter(Boolean);
}

export function serializeSourceTreeProof(node) {
  const proof = node?.source_tree_proof;
  if (!proof || typeof proof !== "object") return null;
  const aggregation = proof.aggregation_grain;
  const aggregationSummary = aggregation && typeof aggregation === "object"
    ? {
        schema: String(aggregation.schema ?? ""),
        status: String(aggregation.status ?? ""),
        reason_code: String(aggregation.reason_code ?? ""),
        amount: isFiniteNumber(aggregation.amount) ? aggregation.amount : null,
        source_system: String(aggregation.source_system ?? ""),
        source_identity_scope: String(aggregation.source_identity_scope ?? ""),
        aggregation_grain_id: String(aggregation.aggregation_grain_id ?? ""),
        selected_source_identity_count: Array.isArray(aggregation.selected)
          ? aggregation.selected.length
          : 0,
        ignored_source_identity_count: Array.isArray(aggregation.ignored)
          ? aggregation.ignored.length
          : 0,
        conflict_count: Array.isArray(aggregation.conflicts)
          ? aggregation.conflicts.length
          : 0,
        correction_authority: aggregation.correction_authority === true,
      }
    : null;
  return {
    source_system: String(proof.source_system ?? ""),
    status: String(proof.status ?? ""),
    reason: String(proof.reason ?? ""),
    complete: proof.complete === true,
    parent_total: isFiniteNumber(proof.parent_total) ? proof.parent_total : null,
    child_sum: isFiniteNumber(proof.child_sum) ? proof.child_sum : null,
    delta: isFiniteNumber(proof.delta) ? proof.delta : null,
    child_count: Number(proof.child_count ?? 0),
    leaf_count: Number(proof.leaf_count ?? 0),
    covered_leaf_count: Number(proof.covered_leaf_count ?? 0),
    full_path: String(proof.full_path ?? ""),
    child_composition: Array.isArray(proof.child_composition)
      ? proof.child_composition.map((child) => ({ ...child }))
      : [],
    aggregation_grain: aggregationSummary,
  };
}

function appendNote(note, extra) {
  return [String(note ?? "").trim(), extra].filter(Boolean).join(" ");
}

/**
 * Apply source-tree proof as an independent fail-closed gate to an existing
 * mapping/formula result without changing its financial calculation.
 */
export function gateResolvedResultBySourceTree(
  result,
  templateRow,
  nodes,
  { sourceSystem = "SOURCE" } = {},
) {
  const originalTrace = Array.isArray(result?.trace) ? result.trace : [];
  const tracedIndexes = originalTrace
    .map((item) => nodes.indexOf(item))
    .filter((index) => index >= 0);
  const parentIndexes = tracedIndexes.filter(
    (index) => (nodes[index]?.child_indexes ?? []).length > 0,
  );
  const expandedIndexes = [];
  for (const index of tracedIndexes) {
    const indexes = parentIndexes.includes(index)
      ? nodes[index].source_tree_trace_indexes ?? [index]
      : [index];
    for (const traceIndex of indexes) {
      if (!expandedIndexes.includes(traceIndex)) expandedIndexes.push(traceIndex);
    }
  }
  const expandedTrace = [
    ...expandedIndexes.map((index) => nodes[index]).filter(Boolean),
    ...originalTrace.filter((item) => !nodes.includes(item)),
  ];

  if (templateRow?.hierarchy_has_children === true && parentIndexes.length === 0) {
    return {
      ...result,
      status: "HIERARCHY_MISMATCH",
      trace: expandedTrace,
      note: appendNote(
        result?.note,
        `${sourceSystem}: прямой итог не подтверждён видимым составом детей (DIRECT_TOTAL_ONLY).`,
      ),
    };
  }

  const blockedParents = parentIndexes.filter(
    (index) => nodes[index]?.source_tree_proof_complete !== true,
  );
  if (blockedParents.length > 0) {
    const reasons = [...new Set(blockedParents.map(
      (index) => nodes[index]?.hierarchy_reason || "INCOMPLETE_SOURCE_TREE",
    ))].join(", ");
    return {
      ...result,
      status: "HIERARCHY_MISMATCH",
      trace: expandedTrace,
      note: appendNote(
        result?.note,
        `${sourceSystem}: parent-child proof заблокирован (${reasons}).`,
      ),
    };
  }

  return {
    ...result,
    trace: expandedTrace,
  };
}
