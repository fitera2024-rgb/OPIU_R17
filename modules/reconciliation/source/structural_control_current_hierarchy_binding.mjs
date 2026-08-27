import crypto from "node:crypto";

import { projectAuthoritativeStructuralControlCandidates } from "./structural_control_authoritative_candidates.mjs";
import { structuralControlGroupsFromConfig } from "./structural_control_groups.mjs";

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function code(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function blocked(reason, detail = "") {
  throw new Error(`BLOCKED_STRUCTURAL_CONTROL_CURRENT_HIERARCHY_${reason}${detail ? `:${detail}` : ""}`);
}

function moneyCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100);
}

function treeNodes(tree, period, side) {
  if (!tree || !Array.isArray(tree.nodes) || text(tree.status) !== "PASS") {
    blocked("TREE_NOT_PROVEN", `${period}:${side}`);
  }
  return tree.nodes;
}

function treeHash(tree) {
  const nodes = (Array.isArray(tree?.nodes) ? tree.nodes : []).map((node) => ({
    node_id: text(node?.node_id),
    parent_node_id: text(node?.parent_node_id ?? node?.parent_id),
    code: code(node?.code),
    label: text(node?.label),
    full_path: text(node?.full_path),
    direct_total_cents: moneyCents(node?.direct_total),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  return crypto.createHash("sha256").update(JSON.stringify(nodes)).digest("hex").toUpperCase();
}

function uniqueTracePaths(trace) {
  return [...new Set((Array.isArray(trace) ? trace : []).map((item) => text(item?.full_path)).filter(Boolean))];
}

function resolveSide({ group, period, side, nodes, catalog, bindings, selectedNodes }) {
  const resolved = [];
  const localSelectors = new Set();
  for (const selector of bindings) {
    const originCode = code(selector?.code);
    const selectorPath = text(selector?.hierarchy_path);
    const originIdentity = text(selector?.origin_identity);
    const inventoryId = text(selector?.origin_inventory_id);
    if (!selectorPath || !originIdentity || !inventoryId) {
      blocked("SELECTOR_INCOMPLETE", `${period}:${side}:${text(group.id)}`);
    }
    const selectorKey = `${originIdentity}\u0000${selectorPath}`;
    if (localSelectors.has(selectorKey)) blocked("SELECTOR_DUPLICATE", `${period}:${side}:${text(group.id)}`);
    localSelectors.add(selectorKey);
    const pathNodes = nodes.filter((node) => text(node?.full_path) === selectorPath);
    if (pathNodes.length !== 1) {
      blocked(pathNodes.length === 0 ? "SELECTOR_NOT_FOUND" : "SELECTOR_AMBIGUOUS",
        `${period}:${side}:${text(group.id)}:${selectorPath}`);
    }
    const nodeId = text(pathNodes[0]?.node_id);
    const authority = catalog.filter((item) => item.node_id === nodeId && item.full_path === selectorPath);
    if (authority.length !== 1) {
      blocked(authority.length === 0 ? "ROW_REFERENCE_NOT_FOUND" : "ROW_REFERENCE_AMBIGUOUS",
        `${period}:${side}:${text(group.id)}:${nodeId}`);
    }
    if (originCode && originCode !== authority[0].reporting_code) {
      blocked("ORIGIN_CODE_DRIFT", `${period}:${side}:${text(group.id)}:${originCode}:${authority[0].reporting_code}`);
    }
    const selectedKey = `${side}\u0000${nodeId}`;
    const prior = selectedNodes.get(selectedKey);
    if (prior) blocked("SELECTED_NODE_OVERLAP", `${period}:${side}:${nodeId}:${prior}:${text(group.id)}`);
    selectedNodes.set(selectedKey, text(group.id));
    resolved.push(Object.freeze({
      code: originCode,
      hierarchy_path: selectorPath,
      current_row_code: authority[0].reporting_code,
      current_node_id: nodeId,
      current_parent_node_id: authority[0].parent_node_id,
      origin_identity: originIdentity,
      origin_inventory_id: inventoryId,
    }));
  }
  return Object.freeze(resolved);
}

function exactCodesBySelector(periodBindings, side) {
  const first = periodBindings[0]?.[side] ?? [];
  const codes = first.map((item) => item.current_row_code);
  for (const binding of periodBindings.slice(1)) {
    const candidate = (binding?.[side] ?? []).map((item) => item.current_row_code);
    if (JSON.stringify(candidate) !== JSON.stringify(codes)) {
      blocked("PERIOD_ROW_CODE_DRIFT", `${text(binding?.period)}:${text(binding?.control_set_id)}:${side}`);
    }
  }
  return codes;
}

export function bindStructuralControlGroupsToCurrentHierarchies(groups, monthly) {
  const configured = Array.isArray(groups) ? groups : [];
  const periods = Array.isArray(monthly) ? monthly : [];
  const typed = configured.filter((group) =>
    (group?.intalev_member_bindings?.length ?? 0) > 0 || (group?.erp_member_bindings?.length ?? 0) > 0);
  if (typed.length === 0) {
    return Object.freeze({ groups: Object.freeze(configured), audit: Object.freeze({
      status: "NO_TYPED_UI_FIXED_SELECTORS", set_count: 0,
      correction_authority: false, financial_rows: 0, posting_rows: 0,
    }) });
  }
  if (typed.length !== configured.length || periods.length === 0) blocked("TYPED_SELECTION_INCOMPLETE");
  const audits = [];
  const catalogAudits = [];
  for (const month of periods) {
    const period = text(month?.period);
    if (!period) blocked("PERIOD_MISSING");
    const intalevNodes = treeNodes(month?.intalev_hierarchy_tree, period, "INTALEV");
    const erpNodes = treeNodes(month?.erp_hierarchy_tree, period, "ERP");
    const authoritative = projectAuthoritativeStructuralControlCandidates({
      ...month,
      rows: (month?.rows ?? []).map((row) => ({
        ...row,
        intalev_amount: row?.intalev_amount ?? row?.intalev?.amount,
        erp_amount: row?.erp_amount ?? row?.erp?.amount,
        erp_paths: row?.erp_paths ?? uniqueTracePaths(row?.erp?.trace),
      })),
    });
    const intalevCatalog = authoritative.intalev_candidates;
    const erpCatalog = authoritative.erp_candidates;
    catalogAudits.push(authoritative);
    const selectedNodes = new Map();
    for (const group of configured) {
      const intalevBindings = group?.intalev_member_bindings ?? [];
      const erpBindings = group?.erp_member_bindings ?? [];
      if (intalevBindings.length === 0 || erpBindings.length === 0) {
        blocked("SIDE_SELECTOR_COUNT_MISMATCH", `${period}:${text(group.id)}`);
      }
      const intalev = resolveSide({ group, period, side: "INTALEV", nodes: intalevNodes,
        catalog: intalevCatalog, bindings: intalevBindings, selectedNodes });
      const erp = resolveSide({ group, period, side: "ERP", nodes: erpNodes,
        catalog: erpCatalog, bindings: erpBindings, selectedNodes });
      audits.push(Object.freeze({
        period, control_set_id: text(group.id),
        intalev_tree_sha256: treeHash(month.intalev_hierarchy_tree),
        erp_tree_sha256: treeHash(month.erp_hierarchy_tree),
        intalev, erp, descendant_internal_checks_active: true,
        correction_authority: false, financial_rows: 0, posting_rows: 0,
      }));
    }
  }
  const reboundEntries = configured.map((group) => {
    const groupBindings = audits.filter((item) => item.control_set_id === text(group.id));
    const intalevCodes = exactCodesBySelector(groupBindings, "intalev");
    const erpCodes = exactCodesBySelector(groupBindings, "erp");
    return {
      ...group,
      member_codes: [...new Set([...intalevCodes, ...erpCodes])],
      intalev_member_codes: intalevCodes,
      erp_member_codes: erpCodes,
      current_hierarchy_binding_verified: true,
    };
  });
  const rebound = structuralControlGroupsFromConfig({ structural_group_control_sets: reboundEntries });
  if (rebound.length !== configured.length) blocked("REBOUND_SET_COUNT_MISMATCH");
  return Object.freeze({
    groups: rebound,
    audit: Object.freeze({
      status: "ACTIVE_UI_FIXED_SELECTORS_BOUND_TO_CURRENT_HIERARCHIES",
      set_count: rebound.length, period_count: periods.length,
      authoritative_catalogs: Object.freeze(catalogAudits), bindings: Object.freeze(audits),
      descendant_internal_checks_active: true, correction_authority: false, financial_rows: 0, posting_rows: 0,
    }),
  });
}
