function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reportingCode(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function blocked(reason, detail = "") {
  throw new Error(
    `BLOCKED_STRUCTURAL_CONTROL_AUTHORITATIVE_CANDIDATES_${reason}${detail ? `:${detail}` : ""}`,
  );
}

function exactCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  const represented = cents / 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.abs(value - represented) <= tolerance ? cents : null;
}

function treeNodes(month, side) {
  const tree = month?.[`${side.toLocaleLowerCase("en-US")}_hierarchy_tree`];
  if (!tree || text(tree.status) !== "PASS" || !Array.isArray(tree.nodes)) {
    blocked("TREE_NOT_PROVEN", `${text(month?.period)}:${side}`);
  }
  const byID = new Map();
  const byPath = new Map();
  for (const node of tree.nodes) {
    const nodeID = text(node?.node_id);
    const fullPath = text(node?.full_path);
    if (!nodeID || !fullPath) continue;
    if (byID.has(nodeID)) blocked("TREE_NODE_ID_DUPLICATE", `${side}:${nodeID}`);
    byID.set(nodeID, node);
    const pathNodes = byPath.get(fullPath) ?? [];
    pathNodes.push(node);
    byPath.set(fullPath, pathNodes);
  }
  return Object.freeze({ tree, byID, byPath });
}

function nodeName(node) {
  return text(node?.name ?? node?.label);
}

function nodeLabel(node) {
  return text(node?.label ?? node?.name);
}

function nodeParentID(node) {
  return text(node?.parent_node_id ?? node?.parent_id);
}

function nodeAmountCents(node) {
  return exactCents(node?.direct_total ?? node?.amount);
}

function candidate({ side, code, node, amountCents }) {
  return Object.freeze({
    side,
    reporting_code: code,
    node_id: text(node?.node_id),
    parent_node_id: nodeParentID(node),
    full_path: text(node?.full_path),
    name: nodeName(node),
    amount: amountCents / 100,
    amount_cents: amountCents,
  });
}

function ambiguity(code, side, details = {}) {
  return Object.freeze({ code, side, ...details });
}

function excludeAmbiguousClaims(claims, side, period, ambiguities) {
  const byNode = new Map();
  const byCode = new Map();
  for (const claim of claims) {
    const nodeClaims = byNode.get(claim.node_id) ?? [];
    nodeClaims.push(claim);
    byNode.set(claim.node_id, nodeClaims);
    const codeClaims = byCode.get(claim.reporting_code) ?? [];
    codeClaims.push(claim);
    byCode.set(claim.reporting_code, codeClaims);
  }
  const excluded = new Set();
  for (const [nodeID, nodeClaims] of byNode) {
    if (nodeClaims.length < 2) continue;
    nodeClaims.forEach((claim) => excluded.add(claim));
    ambiguities.push(ambiguity(`${side}_NODE_AMBIGUOUS`, side, {
      period,
      node_id: nodeID,
      reporting_codes: Object.freeze(nodeClaims.map((claim) => claim.reporting_code)),
    }));
  }
  for (const [code, codeClaims] of byCode) {
    if (codeClaims.length < 2) continue;
    codeClaims.forEach((claim) => excluded.add(claim));
    ambiguities.push(ambiguity(`${side}_REPORTING_CODE_AMBIGUOUS`, side, {
      period,
      reporting_code: code,
      node_ids: Object.freeze(codeClaims.map((claim) => claim.node_id)),
    }));
  }
  return Object.freeze(claims.filter((claim) => !excluded.has(claim)));
}

function projectIntalev(rows, catalog, period, exclusions) {
  const claims = [];
  for (const row of rows) {
    const proof = row?.presentation_structural_proof;
    if (text(proof?.status) !== "PROVEN_LIVE_INTALEV") continue;
    const code = reportingCode(row?.code);
    const nodeID = text(proof?.node_id);
    const proofPath = Array.isArray(proof?.path)
      ? proof.path.map(text).filter(Boolean).join(" / ")
      : text(proof?.path);
    if (!code || !nodeID || !proofPath) {
      exclusions.push(ambiguity("INTALEV_PROOF_INCOMPLETE", "INTALEV", {
        period, reporting_code: code,
      }));
      continue;
    }
    const node = catalog.byID.get(nodeID);
    if (!node || text(node.full_path) !== proofPath) {
      exclusions.push(ambiguity("INTALEV_PROOF_TREE_MISMATCH", "INTALEV", {
        period, reporting_code: code, node_id: nodeID, full_path: proofPath,
      }));
      continue;
    }
    if (node.is_group !== true) {
      exclusions.push(ambiguity("INTALEV_NODE_NOT_SELECTABLE_GROUP", "INTALEV", {
        period, node_id: nodeID, reporting_codes: Object.freeze([code]),
      }));
      continue;
    }
    const rowPath = Array.isArray(row?.hierarchy_path)
      ? row.hierarchy_path.map(text).filter(Boolean).join(" / ")
      : text(row?.hierarchy_path);
    if (rowPath !== proofPath || text(row?.hierarchy_node_id) !== nodeID) {
      exclusions.push(ambiguity("INTALEV_ROW_PROOF_MISMATCH", "INTALEV", {
        period, reporting_code: code, node_id: nodeID, full_path: proofPath,
      }));
      continue;
    }
    const amountCents = exactCents(row?.intalev?.amount ?? row?.intalev_amount);
    if (amountCents === null) {
      exclusions.push(ambiguity("INTALEV_AMOUNT_NOT_EXACT_CENTS", "INTALEV", {
        period, reporting_code: code, node_id: nodeID,
      }));
      continue;
    }
    const treeAmountCents = nodeAmountCents(node);
    if (treeAmountCents !== null && treeAmountCents !== amountCents) {
      exclusions.push(ambiguity("INTALEV_AMOUNT_TREE_MISMATCH", "INTALEV", {
        period, reporting_code: code, node_id: nodeID,
        report_amount_cents: amountCents, tree_amount_cents: treeAmountCents,
      }));
      continue;
    }
    claims.push(candidate({ side: "INTALEV", code, node, amountCents }));
  }
  return excludeAmbiguousClaims(claims, "INTALEV", period, exclusions);
}

function projectERP(rows, catalog, period, exclusions) {
  const claims = [];
  for (const row of rows) {
    const code = reportingCode(row?.code);
    const paths = Array.isArray(row?.erp_paths) ? row.erp_paths.map(text).filter(Boolean) : [];
    if (!code || paths.length === 0) continue;
    const fullPath = paths[0];
    const expectedParentID = text(row?.erp_presentation_parent_node_id);
    const expectedLabel = text(row?.erp_label);
    const amountCents = exactCents(row?.erp?.amount ?? row?.erp_amount);
    if (!expectedParentID || !expectedLabel || amountCents === null) {
      exclusions.push(ambiguity("ERP_ROW_BINDING_INCOMPLETE", "ERP", {
        period, reporting_code: code, full_path: fullPath,
      }));
      continue;
    }
    const candidates = (catalog.byPath.get(fullPath) ?? []).filter((node) =>
      nodeParentID(node) === expectedParentID
        && nodeLabel(node) === expectedLabel
        && nodeAmountCents(node) === amountCents);
    if (candidates.length > 1) {
      exclusions.push(ambiguity("ERP_TREE_MAPPING_AMBIGUOUS", "ERP", {
        period, reporting_code: code, full_path: fullPath,
        node_ids: Object.freeze(candidates.map((node) => text(node.node_id))),
      }));
      continue;
    }
    if (candidates.length === 0) {
      exclusions.push(ambiguity("ERP_TREE_MAPPING_NOT_EXACT", "ERP", {
        period, reporting_code: code, full_path: fullPath,
        parent_node_id: expectedParentID, label: expectedLabel,
        amount_cents: amountCents,
      }));
      continue;
    }
    const node = candidates[0];
    if (node.is_group !== true) {
      exclusions.push(ambiguity("ERP_NODE_NOT_SELECTABLE_GROUP", "ERP", {
        period, node_id: text(node.node_id), reporting_codes: Object.freeze([code]),
      }));
      continue;
    }
    claims.push(candidate({ side: "ERP", code, node, amountCents }));
  }
  return excludeAmbiguousClaims(claims, "ERP", period, exclusions);
}

/**
 * Projects only current report rows that have an exact, side-specific binding
 * to the current source hierarchy. Raw hierarchy groups without this proof are
 * deliberately excluded from the user-selectable structural-control catalog.
 */
export function projectAuthoritativeStructuralControlCandidates(month = {}) {
  const period = text(month?.period);
  if (!period) blocked("PERIOD_MISSING");
  if (!Array.isArray(month?.rows)) blocked("REPORT_ROWS_MISSING", period);
  const intalevCatalog = treeNodes(month, "INTALEV");
  const erpCatalog = treeNodes(month, "ERP");
  const exclusions = [];
  const intalev = projectIntalev(month.rows, intalevCatalog, period, exclusions);
  const erp = projectERP(month.rows, erpCatalog, period, exclusions);
  const ambiguityExclusions = exclusions.filter((item) => item.code.includes("AMBIGUOUS"));
  return Object.freeze({
    schema_version: "opiu-structural-control-authoritative-candidates.v1",
    status: exclusions.length === 0
      ? "VERIFIED"
      : "VERIFIED_WITH_CANDIDATES_EXCLUDED",
    period,
    intalev_candidates: intalev,
    erp_candidates: erp,
    intalev_candidate_count: intalev.length,
    erp_candidate_count: erp.length,
    exclusion_count: exclusions.length,
    excluded_candidates: Object.freeze(exclusions),
    ambiguity_count: ambiguityExclusions.length,
    excluded_ambiguities: Object.freeze(ambiguityExclusions),
    excluded_raw_tree_nodes: Object.freeze({
      intalev: Math.max(0, intalevCatalog.tree.nodes.length - intalev.length),
      erp: Math.max(0, erpCatalog.tree.nodes.length - erp.length),
    }),
    correction_authority: false,
    financial_rows: 0,
    posting_rows: 0,
  });
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function inventoryTree(tree, candidates, side, period) {
  if (!tree || text(tree.status) !== "PASS" || !Array.isArray(tree.nodes)) {
    blocked("TREE_NOT_PROVEN", `${period}:${side}`);
  }
  const reportingCodeByNodeID = new Map(
    candidates.map((item) => [text(item.node_id), reportingCode(item.reporting_code)]),
  );
  const cloned = cloneValue(tree);
  cloned.nodes = cloned.nodes.map((node) => {
    const exactReportingCode = reportingCodeByNodeID.get(text(node?.node_id)) ?? "";
    return {
      ...node,
      is_group: Boolean(exactReportingCode),
      code: exactReportingCode,
    };
  });
  return cloned;
}

/**
 * Creates an inventory-only hierarchy-period clone. It preserves the complete
 * source trees and their edges/traces, but grants group/candidate semantics
 * only to exact report-row mappings produced by this module.
 */
export function buildAuthoritativeStructuralControlInventoryHierarchyPeriod(
  month = {},
  compactHierarchyPeriod = {},
) {
  const monthPeriod = text(month?.period);
  const hierarchyPeriod = text(compactHierarchyPeriod?.period);
  if (!monthPeriod || !hierarchyPeriod || monthPeriod !== hierarchyPeriod) {
    blocked("HIERARCHY_PERIOD_SCOPE_MISMATCH", `${monthPeriod}:${hierarchyPeriod}`);
  }
  const projectionInput = {
    ...month,
    period: hierarchyPeriod,
    intalev_hierarchy_tree: compactHierarchyPeriod.intalev_tree,
    erp_hierarchy_tree: compactHierarchyPeriod.erp_tree,
  };
  const projection = projectAuthoritativeStructuralControlCandidates(projectionInput);
  const cloned = cloneValue(compactHierarchyPeriod);
  cloned.intalev_tree = inventoryTree(
    compactHierarchyPeriod.intalev_tree,
    projection.intalev_candidates,
    "INTALEV",
    hierarchyPeriod,
  );
  cloned.erp_tree = inventoryTree(
    compactHierarchyPeriod.erp_tree,
    projection.erp_candidates,
    "ERP",
    hierarchyPeriod,
  );
  cloned.structural_control_authoritative_projection = cloneValue(projection);
  return deepFreeze(cloned);
}
