import crypto from "node:crypto";
import { resolveEconomicHierarchyRelationship } from "./economic_hierarchy_mapping.mjs";
import {
  aggregateProvenRows,
  buildAggregationGrainIdentity,
} from "./aggregation_grain.mjs";

const DEFAULT_TOLERANCE = 0.01;

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

function pathParts(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value)
    .split(/\s+(?:\/|>|→)\s+/)
    .map(text)
    .filter(Boolean);
}

function pathKey(value) {
  return pathParts(value).map(normalized).join(" / ");
}

function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "да", "group", "группа"].includes(normalized(value));
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function parentReference(value) {
  const result = text(value);
  const compact = result.replace(/[{}\-\s]/g, "");
  return compact && /^0+$/.test(compact) ? "" : result;
}

function sourceTrace(row) {
  const source = row?.source ?? {};
  return {
    source_file: firstText(row?.source_file, source.source_file, source.file),
    sheet: firstText(row?.sheet, source.sheet),
    row: row?.row ?? row?.source_row ?? source.row ?? null,
    source_cell: firstText(row?.source_cell, source.source_cell, source.cell),
    sha256: firstText(row?.sha256, source.sha256),
  };
}

function stableNodeId(system, canonicalPath, physicalIdentity = "") {
  const identity = normalized(physicalIdentity);
  const identityMaterial = identity ? `SOURCE:${identity}` : `PATH:${canonicalPath}`;
  return `${normalized(system).toUpperCase()}:${crypto
    .createHash("sha256")
    .update(`${normalized(system)}\n${identityMaterial}`, "utf8")
    .digest("hex")}`;
}

const AGGREGATION_CONTRACTS = new Set([
  "ADDITIVE_CHILDREN",
  "OWN_VALUE_PLUS_CHILDREN",
  "PRESENTATION_ONLY",
  "CALCULATED_RESULT",
  "UNPROVEN",
]);

function aggregationContract(value) {
  const candidate = normalized(value).toUpperCase();
  return AGGREGATION_CONTRACTS.has(candidate) ? candidate : "UNPROVEN";
}

function makeBlocker(code, message, details = {}) {
  return { code, message, ...details };
}

function addBlocker(blockers, blocker) {
  const key = JSON.stringify(blocker);
  if (!blockers.some((item) => JSON.stringify(item) === key)) blockers.push(blocker);
}

export function parseOutlineLevelsXml(xml) {
  const result = new Map();
  for (const match of String(xml ?? "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>/g)) {
    const attributes = match[1];
    const rowNumber = Number(
      attributes.match(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?r="(\d+)"/)?.[1] ?? 0,
    );
    if (!rowNumber) continue;
    const level = Number(
      attributes.match(/(?:^|\s)(?:[A-Za-z_][\w.-]*:)?outlineLevel="(\d+)"/)?.[1] ?? 0,
    );
    result.set(rowNumber, Number.isInteger(level) && level >= 0 ? level : 0);
  }
  return result;
}

function orderedUnique(values) {
  return [...new Set(values)];
}

function descendantsFor(nodeId, nodeById, visiting = new Set()) {
  if (visiting.has(nodeId)) return [];
  visiting.add(nodeId);
  const node = nodeById.get(nodeId);
  const result = [];
  for (const childId of node?.immediate_children ?? []) {
    result.push(childId, ...descendantsFor(childId, nodeById, visiting));
  }
  visiting.delete(nodeId);
  return orderedUnique(result);
}

function levelFor(nodeId, nodeById, blockers, visiting = new Set()) {
  if (visiting.has(nodeId)) {
    addBlocker(
      blockers,
      makeBlocker("CYCLE_DETECTED", "Обнаружен цикл parent-child.", { node_id: nodeId }),
    );
    return 0;
  }
  const node = nodeById.get(nodeId);
  if (!node?.parent_id) return 0;
  visiting.add(nodeId);
  const value = 1 + levelFor(node.parent_id, nodeById, blockers, visiting);
  visiting.delete(nodeId);
  return value;
}

function finalizeTree(system, drafts, blockers, options = {}) {
  const tolerance = Number(options.tolerance ?? DEFAULT_TOLERANCE);
  const requireAmounts = options.requireAmounts !== false;
  const duplicateCounts = new Map();
  const nodes = drafts.map((draft) => {
    const baseId = stableNodeId(system, draft.path_key, draft.source_identity);
    const duplicateSequence = duplicateCounts.get(baseId) ?? 0;
    duplicateCounts.set(baseId, duplicateSequence + 1);
    if (duplicateSequence > 0) {
      addBlocker(
        blockers,
        makeBlocker("DUPLICATE_NODE_IDENTITY", "Повторена stable identity узла.", {
          path: draft.full_path,
          input_index: draft.input_index,
        }),
      );
    }
    return {
      ...draft,
      node_id: duplicateSequence === 0 ? baseId : `${baseId}:DUPLICATE:${duplicateSequence}`,
      parent_id: null,
      immediate_children: [],
      recursive_descendants: [],
    };
  });
  const nodeByIndex = new Map(nodes.map((node) => [node.input_index, node]));
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));

  for (const node of nodes) {
    if (Number.isInteger(node.parent_input_index)) {
      const parent = nodeByIndex.get(node.parent_input_index);
      if (parent) node.parent_id = parent.node_id;
    }
  }
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const parent = nodeById.get(node.parent_id);
    if (!parent) {
      addBlocker(
        blockers,
        makeBlocker("ORPHAN_NODE", "Родитель узла отсутствует.", {
          node_id: node.node_id,
          path: node.full_path,
        }),
      );
      node.parent_id = null;
      continue;
    }
    parent.immediate_children.push(node.node_id);
  }

  for (const node of nodes) {
    node.level = levelFor(node.node_id, nodeById, blockers);
    node.immediate_children.sort(
      (left, right) =>
        nodeById.get(left).input_index - nodeById.get(right).input_index,
    );
    node.recursive_descendants = descendantsFor(node.node_id, nodeById);
  }
  if (
    options.requireNonFlat === true &&
    nodes.length > 1 &&
    new Set(nodes.map((node) => node.level)).size <= 1
  ) {
    addBlocker(
      blockers,
      makeBlocker(
        "HIERARCHY_LEVELS_FLAT",
        "Все source nodes имеют один уровень; иерархия не подтверждена.",
        { node_count: nodes.length },
      ),
    );
  }

  for (const node of nodes) {
    const children = node.immediate_children.map((nodeId) => nodeById.get(nodeId));
    const descendants = node.recursive_descendants.map((nodeId) => nodeById.get(nodeId));
    const suppliedContract = firstText(node.aggregation_contract);
    const legacyImplicitComposition =
      !suppliedContract && options.requireExplicitAggregationContract !== true;
    const contract = legacyImplicitComposition
      ? "ADDITIVE_CHILDREN"
      : aggregationContract(suppliedContract);
    const compositionGrainKey = legacyImplicitComposition
      ? firstText(node.source_identity)
      : firstText(node.composition_grain_key, node.aggregation_grain_key);
    const childCompositionKeys = children.map((child) =>
      firstText(child.composition_grain_key, child.aggregation_grain_key));
    const additiveGrainExplicit =
      contract === "ADDITIVE_CHILDREN" &&
      (legacyImplicitComposition || (
        Boolean(compositionGrainKey) &&
        childCompositionKeys.every((key) => key === compositionGrainKey)
      ));
    const aggregation = children.length === 0
      ? buildAggregationGrainIdentity(node, {
          sourceSystem: system,
          aggregationKey: firstText(node.aggregation_grain_key, node.source_identity),
        })
      : additiveGrainExplicit
        ? aggregateProvenRows(children, {
            sourceSystem: system,
            aggregationKey: legacyImplicitComposition ? node.source_identity : compositionGrainKey,
            amountProperty: "direct_total",
          })
        : aggregateProvenRows(children, {
            sourceSystem: system,
            aggregationKey: "",
            amountProperty: "direct_total",
          });
    node.aggregation_contract = contract;
    node.aggregation_contract_status = children.length === 0
      ? "NOT_APPLICABLE"
      : legacyImplicitComposition
        ? aggregation.status === "PROVEN" ? "PROVEN" : "REVIEW_ONLY"
      : contract === "ADDITIVE_CHILDREN"
        ? aggregation.status === "PROVEN"
          ? "PROVEN"
          : "BLOCKED_UNPROVEN"
        : contract === "UNPROVEN"
          ? "REVIEW_ONLY"
          : "NOT_APPLICABLE";
    node.correction_authority = false;
    node.aggregation_grain = aggregation;
    const numericChildren =
      children.length > 0 &&
      contract === "ADDITIVE_CHILDREN" &&
      aggregation.status === "PROVEN" &&
      Array.isArray(aggregation.selected)
        ? aggregation.selected.filter((child) => typeof child.direct_total === "number")
        : [];
    node.is_group = Boolean(node.explicit_group || children.length > 0);
    node.immediate_child_sum =
      children.length > 0 &&
      contract === "ADDITIVE_CHILDREN" &&
      aggregation.status === "PROVEN" &&
      Array.isArray(aggregation.selected) &&
      numericChildren.length === aggregation.selected.length
        ? money(aggregation.amount)
        : null;
    node.hierarchy_delta =
      typeof node.direct_total === "number" && typeof node.immediate_child_sum === "number"
        ? money(node.direct_total - node.immediate_child_sum)
        : null;
    const missingImmediate = children.filter((child) => typeof child.direct_total !== "number");
    const missingRecursive = descendants.filter(
      (descendant) => typeof descendant.direct_total !== "number",
    );
    node.coverage = {
      immediate_children: children.length,
      immediate_children_with_total: numericChildren.length,
      recursive_descendants: descendants.length,
      recursive_descendants_with_total: descendants.length - missingRecursive.length,
      structure_complete: true,
      amount_complete: missingRecursive.length === 0,
      complete: !requireAmounts || missingRecursive.length === 0,
    };
    if (
      children.length > 0 &&
      contract === "ADDITIVE_CHILDREN" &&
      !legacyImplicitComposition &&
      !additiveGrainExplicit
    ) {
      addBlocker(
        blockers,
        makeBlocker(
          "ADDITIVE_COMPOSITION_GRAIN_UNPROVEN",
          "ADDITIVE_CHILDREN requires one explicit source-backed composition grain on parent and children.",
          {
            node_id: node.node_id,
            composition_grain_key: compositionGrainKey,
            child_composition_grain_keys: childCompositionKeys,
          },
        ),
      );
    } else if (
      children.length > 0 &&
      contract === "ADDITIVE_CHILDREN" &&
      !legacyImplicitComposition &&
      aggregation.status === "REVIEW_ONLY"
    ) {
      addBlocker(
        blockers,
        makeBlocker("ADDITIVE_COMPOSITION_GRAIN_UNPROVEN", "Explicit additive composition grain is not source-proven.", {
          node_id: node.node_id,
          aggregation_grain: aggregation,
        }),
      );
    } else if (children.length > 0 && contract !== "ADDITIVE_CHILDREN") {
      node.aggregation_grain_review = {
        code: "AGGREGATION_GRAIN_UNPROVEN",
        review_status: "REVIEW_ONLY",
        aggregation_contract: contract,
        aggregation_grain: aggregation,
      };
    } else if (contract === "ADDITIVE_CHILDREN" && aggregation.status === "BLOCKED") {
      addBlocker(
        blockers,
        makeBlocker("PROVEN_COMPOSITION_CONTRADICTION", "Proven direct-child composition contradicts itself.", {
          node_id: node.node_id,
          aggregation_grain: aggregation,
        }),
      );
    } else if (contract === "ADDITIVE_CHILDREN" && requireAmounts && missingImmediate.length > 0) {
      addBlocker(
        blockers,
        makeBlocker("MISSING_DESCENDANT", "Не у всех прямых потомков есть direct total.", {
          node_id: node.node_id,
          missing_node_ids: missingImmediate.map((child) => child.node_id),
        }),
      );
    }
    if (
      typeof node.hierarchy_delta === "number" &&
      contract === "ADDITIVE_CHILDREN" &&
      Math.abs(node.hierarchy_delta) > tolerance
    ) {
      addBlocker(
        blockers,
        makeBlocker(
          "PARENT_DETAIL_MISMATCH",
          "Direct total родителя не равен сумме непосредственных потомков.",
          {
            node_id: node.node_id,
            direct_total: node.direct_total,
            immediate_child_sum: node.immediate_child_sum,
            hierarchy_delta: node.hierarchy_delta,
          },
        ),
      );
    }
    node.hierarchy_status =
      children.length === 0
        ? "LEAF"
        : legacyImplicitComposition && aggregation.status === "REVIEW_ONLY"
          ? "REVIEW_ONLY_AGGREGATION_GRAIN"
        : contract !== "ADDITIVE_CHILDREN"
          ? contract === "UNPROVEN"
            ? "REVIEW_ONLY_AGGREGATION_CONTRACT"
            : "PASS_NON_ADDITIVE_CONTRACT"
          : !additiveGrainExplicit || aggregation.status === "REVIEW_ONLY"
            ? "BLOCKED_ADDITIVE_COMPOSITION_GRAIN_UNPROVEN"
          : aggregation.status === "BLOCKED"
            ? "BLOCKED_PROVEN_COMPOSITION_CONTRADICTION"
        : requireAmounts && missingImmediate.length > 0
          ? "BLOCKED_MISSING_EVIDENCE"
          : typeof node.hierarchy_delta !== "number"
            ? "BLOCKED_MISSING_EVIDENCE"
            : Math.abs(node.hierarchy_delta) <= tolerance
              ? "PASS"
              : "BLOCKED_HIERARCHY_MISMATCH";
  }

  const expectedSha256 = normalized(options.expectedSha256).toUpperCase();
  for (const node of nodes) {
    const actualSha256 = normalized(node.source?.sha256).toUpperCase();
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      addBlocker(
        blockers,
        makeBlocker("SOURCE_DRIFT", "SHA узла не совпадает с зафиксированным SHA источника.", {
          node_id: node.node_id,
          expected_sha256: expectedSha256,
          actual_sha256: actualSha256,
        }),
      );
    }
    if (
      options.requireSourceTrace === true &&
      (!node.source?.source_file ||
        !node.source?.sheet ||
        !Number.isInteger(Number(node.source?.row)) ||
        !node.source?.source_cell ||
        !actualSha256)
    ) {
      addBlocker(
        blockers,
        makeBlocker("SOURCE_TRACE_INCOMPLETE", "У узла неполная row-level source trace.", {
          node_id: node.node_id,
          source: node.source,
        }),
      );
    }
  }

  const blockerNodeIds = new Set(
    blockers.flatMap((blocker) => [blocker.node_id, ...(blocker.missing_node_ids ?? [])]).filter(Boolean),
  );
  for (const node of nodes) {
    if (blockerNodeIds.has(node.node_id) && !node.hierarchy_status.startsWith("BLOCKED")) {
      node.hierarchy_status = "BLOCKED_STRUCTURE";
    }
    delete node.parent_input_index;
    delete node.explicit_group;
  }

  return {
    schema: "opiu-hierarchy-tree-v1",
    system: normalized(system).toUpperCase(),
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    ready_to_upload: false,
    release_allowed: false,
    blockers,
    roots: nodes.filter((node) => !node.parent_id).map((node) => node.node_id),
    nodes,
  };
}

export function buildErpOutlineTree(rows, options = {}) {
  const system = options.system ?? "ERP";
  const blockers = [];
  const prepared = (rows ?? []).map((row, inputIndex) => ({ row, inputIndex })).filter(
    ({ row }) => firstText(row?.label, row?.name, row?.article, row?.summary_label),
  );
  const rawLevels = prepared.map(({ row }) => {
    const raw = Number(row.outlineLevel ?? row.outline_level ?? row.source_level ?? row.level ?? 0);
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
  });
  const minimumLevel = rawLevels.length > 0 ? Math.min(...rawLevels) : 0;
  const stack = [];
  const drafts = [];

  prepared.forEach(({ row, inputIndex }, preparedIndex) => {
    const label = firstText(row.label, row.name, row.article, row.summary_label);
    const level = rawLevels[preparedIndex] - minimumLevel;
    const explicitParentRaw = row.parentInputIndex ?? row.parent_input_index ?? row.parent_index;
    const explicitParentIndex = Number(explicitParentRaw);
    const hasExplicitParentIndex =
      explicitParentRaw !== null &&
      explicitParentRaw !== undefined &&
      explicitParentRaw !== "" &&
      Number.isInteger(explicitParentIndex) &&
      explicitParentIndex >= 0;
    let parent = hasExplicitParentIndex
      ? drafts.find((candidate) => candidate.input_index === explicitParentIndex) ?? null
      : null;
    if (!hasExplicitParentIndex && level > 0) parent = stack[level - 1] ?? null;
    if (hasExplicitParentIndex && !parent) {
      addBlocker(
        blockers,
        makeBlocker("ORPHAN_NODE", "Explicit parent_index does not identify a prior source row.", {
          input_index: inputIndex,
          parent_input_index: explicitParentIndex,
          label,
        }),
      );
    }
    if (level > 0 && !parent) {
      addBlocker(
        blockers,
        makeBlocker("ORPHAN_NODE", "outlineLevel указывает на отсутствующего родителя.", {
          input_index: inputIndex,
          label,
          outline_level: level,
        }),
      );
    }
    const derivedParts = [...(parent?.path_parts ?? []), label];
    const suppliedParts = pathParts(row.full_path ?? row.path);
    if (suppliedParts.length > 0 && pathKey(suppliedParts) !== pathKey(derivedParts)) {
      addBlocker(
        blockers,
        makeBlocker(
          "FULL_PATH_PARENT_MISMATCH",
          "full path не согласован с outlineLevel/parent.",
          {
            input_index: inputIndex,
            supplied_path: suppliedParts.join(" / "),
            derived_path: derivedParts.join(" / "),
          },
        ),
      );
    }
    const parts = derivedParts;
    const draft = {
      input_index: inputIndex,
      label,
      code: firstText(row.code, row.catalog_code),
      source_identity: firstText(row.identity, row.id, row.uuid),
      source_identity_scope: firstText(row.source_identity_scope, row.aggregation_scope_id),
      dimension_key: firstText(row.dimension_key),
      dimension_identity_status: firstText(row.dimension_identity_status),
      dimension_roles: row.dimension_roles && typeof row.dimension_roles === "object"
        ? structuredClone(row.dimension_roles)
        : null,
      source_row_role: firstText(row.source_row_role),
      composition_grain_key: firstText(row.composition_grain_key),
      aggregation_grain_key: firstText(row.aggregation_grain_key),
      aggregation_contract: firstText(row.aggregation_contract),
      semantic_type: firstText(row.semantic_type),
      semantic_type_status: firstText(row.semantic_type_status),
      path_parts: parts,
      full_path: parts.join(" / "),
      path_key: pathKey(parts),
      parent_input_index: parent?.input_index ?? null,
      explicit_group: bool(row.is_group ?? row.group_flag),
      direct_total: money(row.amount ?? row.value ?? row.direct_total),
      source: sourceTrace(row),
      correction_authority: false,
    };
    drafts.push(draft);
    stack[level] = draft;
    stack.length = level + 1;
  });

  return finalizeTree(system, drafts, blockers, options);
}

function addAlias(index, alias, inputIndex) {
  const key = normalized(alias);
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(inputIndex);
}

export function buildIntalevParentTree(rows, options = {}) {
  const system = options.system ?? "INTALEV";
  const blockers = [];
  const drafts = [];
  const identities = new Map();
  const pathIndexes = new Map();

  for (let inputIndex = 0; inputIndex < (rows ?? []).length; inputIndex += 1) {
    const row = rows[inputIndex];
    const label = firstText(row?.label, row?.name, row?.article, row?.summary_label);
    if (!label) {
      const sourceIdentity = firstText(row?.identity, row?.id, row?.uuid);
      const parentIdentity = parentReference(firstText(
        row?.parent_identity,
        row?.parent_id,
        row?.parent_uuid,
        row?.parent_code,
        row?.parent,
      ));
      const parentPath = firstText(row?.parent_path);
      const suppliedPath = firstText(row?.full_path, row?.path);
      if (sourceIdentity || parentIdentity || suppliedPath) {
        addBlocker(
          blockers,
          makeBlocker("MISSING_NAME", "У узла Инталев есть identity/path, но отсутствует наименование; строка требует ручной проверки.", {
            input_index: inputIndex,
            source_identity: sourceIdentity,
            parent_identity: parentIdentity,
            parent_path: parentPath,
            full_path: suppliedPath,
            source: sourceTrace(row),
            review_status: "PENDING_REVIEW",
          }),
        );
      }
      continue;
    }
    let parts = pathParts(row.path_parts ?? row.full_path ?? row.path);
    const pathWasSupplied = parts.length > 0;
    const group = firstText(row.group_path, row.group);
    const parentIdentityRef = parentReference(firstText(
      row.parent_identity,
      row.parent_id,
      row.parent_uuid,
      row.parent_code,
      row.parent,
    ));
    const parentPathParts = pathParts(row.parent_path_parts ?? row.parent_path);
    const parentPathRef = parentPathParts.length > 0 ? parentPathParts.join(" / ") : "";
    const parentRef = parentIdentityRef || parentPathRef;
    if (parts.length === 0 && !parentRef) {
      parts = group && normalized(group) !== normalized(label) ? [group, label] : [label];
    }
    const sourceIdentity = firstText(row.identity, row.id, row.uuid);
    const draft = {
      input_index: inputIndex,
      label,
      name: label,
      normalized_name: normalized(label),
      code: firstText(row.code, row.catalog_code),
      source_identity: sourceIdentity,
      source_identity_scope: firstText(row.source_identity_scope, row.aggregation_scope_id),
      composition_grain_key: firstText(row.composition_grain_key),
      aggregation_grain_key: firstText(row.aggregation_grain_key),
      aggregation_contract: firstText(row.aggregation_contract),
      semantic_type: firstText(row.semantic_type),
      semantic_type_status: firstText(row.semantic_type_status),
      outline_gap_collapsed: bool(row.outline_gap_collapsed),
      uuid: sourceIdentity,
      parent_uuid: parentRef,
      path_parts: parts,
      full_path: parts.join(" / "),
      path_key: pathKey(parts),
      path_was_supplied: pathWasSupplied,
      parent_input_index: null,
      parent_ref: parentRef,
      parent_path_parts: parentPathParts,
      parent_ref_kind: parentIdentityRef ? "IDENTITY" : parentPathRef ? "PATH" : "",
      explicit_group: bool(row.is_group ?? row.group_flag),
      direct_total: money(row.amount ?? row.value ?? row.direct_total),
      source: sourceTrace(row),
      correction_authority: false,
    };
    drafts.push(draft);
    if (options.requireIdentity === true && !draft.source_identity) {
      addBlocker(
        blockers,
        makeBlocker("MISSING_UUID", "Узел классификатора не содержит обязательный UUID.", {
          input_index: draft.input_index,
          name: draft.label,
          path: draft.full_path,
        }),
      );
    }
    if (
      draft.path_was_supplied &&
      normalized(draft.path_parts.at(-1)) !== normalized(draft.label)
    ) {
      addBlocker(
        blockers,
        makeBlocker("BROKEN_PATH", "Последний элемент ПолныйПуть не совпадает с именем узла.", {
          input_index: draft.input_index,
          path: draft.full_path,
          name: draft.label,
        }),
      );
    }
    addAlias(identities, draft.source_identity, inputIndex);
    if (!pathIndexes.has(draft.path_key)) pathIndexes.set(draft.path_key, []);
    pathIndexes.get(draft.path_key).push(inputIndex);
  }

  for (const [identity, inputIndexes] of identities) {
    if (inputIndexes.length <= 1) continue;
    addBlocker(
      blockers,
      makeBlocker("DUPLICATE_UUID", "UUID узла повторяется в классификаторе.", {
        uuid: drafts.find((draft) => draft.input_index === inputIndexes[0])?.source_identity ?? identity,
        input_indexes: inputIndexes,
      }),
    );
  }
  for (const [canonicalPath, inputIndexes] of pathIndexes) {
    if (!canonicalPath || inputIndexes.length <= 1) continue;
    addBlocker(
      blockers,
      makeBlocker("AMBIGUOUS_NODE", "Полный путь соответствует нескольким узлам.", {
        path: drafts.find((draft) => draft.path_key === canonicalPath)?.full_path ?? canonicalPath,
        input_indexes: inputIndexes,
      }),
    );
  }

  const draftByInput = new Map(drafts.map((draft) => [draft.input_index, draft]));
  for (const draft of drafts) {
    const expectedParentKey = pathKey(draft.path_parts.slice(0, -1));
    let candidates = [];
    if (draft.parent_ref_kind === "IDENTITY") {
      if (normalized(draft.parent_ref) === normalized(draft.source_identity)) {
        addBlocker(
          blockers,
          makeBlocker("SELF_PARENT", "UUIDРодителя совпадает с UUID узла.", {
            input_index: draft.input_index,
            uuid: draft.source_identity,
          }),
        );
        continue;
      }
      candidates = identities.get(normalized(draft.parent_ref)) ?? [];
    } else if (draft.parent_ref_kind === "PATH") {
      candidates = pathIndexes.get(pathKey(draft.parent_path_parts)) ?? [];
    } else if (expectedParentKey && options.parentIdentityOnly !== true) {
      candidates = pathIndexes.get(expectedParentKey) ?? [];
    }
    candidates = orderedUnique(candidates).filter((inputIndex) => inputIndex !== draft.input_index);
    if (candidates.length > 1) {
      addBlocker(
        blockers,
        makeBlocker("AMBIGUOUS_PARENT", "Parent reference соответствует нескольким узлам.", {
          input_index: draft.input_index,
          parent_ref: draft.parent_ref || expectedParentKey,
          parent_ref_kind: draft.parent_ref_kind || "DERIVED_PATH",
          candidate_input_indexes: candidates,
        }),
      );
      continue;
    }
    if (candidates.length === 0) {
      if (draft.parent_ref || (expectedParentKey && options.parentIdentityOnly !== true)) {
        addBlocker(
          blockers,
          makeBlocker("ORPHAN_NODE", "Не найден parent для неродительского узла.", {
            input_index: draft.input_index,
            path: draft.full_path,
            parent_ref: draft.parent_ref || expectedParentKey,
            parent_ref_kind: draft.parent_ref_kind || "DERIVED_PATH",
          }),
        );
      }
      continue;
    }
    const parent = draftByInput.get(candidates[0]);
    draft.parent_input_index = parent?.input_index ?? null;
    const derivedPath = parent ? [...parent.path_parts, draft.label] : [];
    if (parent && draft.path_was_supplied && pathKey(draft.path_parts) !== pathKey(derivedPath)) {
      addBlocker(
        blockers,
        makeBlocker(
          "FULL_PATH_PARENT_MISMATCH",
          "Explicit parent находится в другой full-path ветке.",
          {
            input_index: draft.input_index,
            path: draft.full_path,
            parent_path: parent.full_path,
            expected_path: derivedPath.join(" / "),
          },
        ),
      );
    }
  }

  if (options.parentIdentityOnly === true) {
    for (const draft of drafts) {
      if (!draft.parent_ref && draft.path_was_supplied && draft.path_parts.length > 1) {
        addBlocker(
          blockers,
          makeBlocker(
            "FULL_PATH_PARENT_MISMATCH",
            "ПолныйПуть содержит parent chain, но UUIDРодителя не задан.",
            { input_index: draft.input_index, uuid: draft.source_identity, path: draft.full_path },
          ),
        );
      }
    }
  }

  const resolvingPaths = new Set();
  const resolvedPaths = new Set();
  function resolveParentPath(draft) {
    if (resolvedPaths.has(draft.input_index)) return;
    if (resolvingPaths.has(draft.input_index)) return;
    resolvingPaths.add(draft.input_index);
    const parent = Number.isInteger(draft.parent_input_index)
      ? draftByInput.get(draft.parent_input_index)
      : null;
    if (parent) {
      resolveParentPath(parent);
      if (!draft.path_was_supplied) {
        draft.path_parts = [...parent.path_parts, draft.label];
        draft.full_path = draft.path_parts.join(" / ");
        draft.path_key = pathKey(draft.path_parts);
      }
    }
    resolvingPaths.delete(draft.input_index);
    resolvedPaths.add(draft.input_index);
  }
  drafts.forEach(resolveParentPath);

  for (const draft of drafts) {
    if (!draft.full_path) {
      addBlocker(
        blockers,
        makeBlocker("UNRESOLVED_FULL_PATH", "Полный путь нельзя восстановить без однозначной parent chain.", {
          input_index: draft.input_index,
          uuid: draft.source_identity,
          parent_uuid: draft.parent_ref,
        }),
      );
    }
  }

  for (const draft of drafts) {
    delete draft.parent_ref;
    delete draft.parent_path_parts;
    delete draft.path_was_supplied;
  }
  const tree = finalizeTree(system, drafts, blockers, options);
  const nodeById = new Map(tree.nodes.map((node) => [node.node_id, node]));
  const blockerIndexes = new Set(
    blockers.flatMap((blocker) => [blocker.input_index, ...(blocker.input_indexes ?? [])])
      .filter(Number.isInteger),
  );
  const blockerNodeIds = new Set(
    blockers.flatMap((blocker) => [blocker.node_id, ...(blocker.missing_node_ids ?? [])])
      .filter(Boolean),
  );
  for (const node of tree.nodes) {
    let root = node;
    const visited = new Set();
    while (root.parent_id && !visited.has(root.node_id)) {
      visited.add(root.node_id);
      root = nodeById.get(root.parent_id) ?? root;
    }
    node.depth = node.level;
    node.root_uuid = root.source_identity || "";
    node.is_leaf = node.immediate_children.length === 0;
    node.validation_status = blockerIndexes.has(node.input_index) || blockerNodeIds.has(node.node_id) || !node.full_path
      ? "UNRESOLVED"
      : "VALID";
  }
  return tree;
}

function commonPath(paths) {
  if (paths.length === 0) return [];
  const first = paths[0];
  let length = first.length;
  for (const candidate of paths.slice(1)) {
    let index = 0;
    while (
      index < length &&
      index < candidate.length &&
      normalized(first[index]) === normalized(candidate[index])
    ) {
      index += 1;
    }
    length = index;
  }
  return first.slice(0, length);
}

export function selectHierarchyTracePath(trace, fields = ["full_path"]) {
  const candidates = [];
  for (const item of trace ?? []) {
    for (const field of fields) {
      const parts = pathParts(item?.[field]);
      if (parts.length > 0) candidates.push(parts);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const parts of candidates) {
    const key = pathKey(parts);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(parts);
  }
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0].join(" / ");
  return commonPath(unique).join(" / ");
}

function businessPathLabel(value) {
  return normalized(value)
    .replace(/^\d+[_\s.-]*/u, "")
    .replace(/^_+/u, "")
    .replace(/^(?:адм|ком|скл|лог)[_\s.-]+/u, "")
    .trim();
}

/**
 * Presentation-only path selector.  A financial row may contain the whole
 * source subtree in trace.  The ordinary selector deliberately returns the
 * common ancestor in that case, which is safe for calculations but misleading
 * in the user tree.  For display we select the unique shallowest source node
 * whose final path segment is the requested business label.  Ambiguity remains
 * fail-closed and falls back to the common path.
 */
export function selectHierarchyTracePathForLabel(
  trace,
  label,
  fields = ["full_path"],
) {
  const requested = businessPathLabel(label);
  if (!requested) return selectHierarchyTracePath(trace, fields);
  const candidates = [];
  const seen = new Set();
  for (const item of trace ?? []) {
    for (const field of fields) {
      const parts = pathParts(item?.[field]);
      if (parts.length === 0) continue;
      if (businessPathLabel(parts.at(-1)) !== requested) continue;
      const key = pathKey(parts);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(parts);
    }
  }
  if (candidates.length === 0) return selectHierarchyTracePath(trace, fields);
  const minimumDepth = Math.min(...candidates.map((parts) => parts.length));
  const shallowest = candidates.filter((parts) => parts.length === minimumDepth);
  return shallowest.length === 1
    ? shallowest[0].join(" / ")
    : selectHierarchyTracePath(trace, fields);
}

export function resolveHierarchyNodeFromPath(fullPath, tree) {
  const pathIdentity = pathKey(fullPath);
  if (!pathIdentity) {
    return {
      status: "MISSING_PRESENTATION_PATH",
      node_id: "",
      full_path: "",
      candidate_node_ids: [],
      correction_authority: false,
    };
  }
  const candidates = (tree?.nodes ?? []).filter(
    (node) => node.path_key === pathIdentity,
  );
  return {
    status: candidates.length === 1
      ? "PROVEN_EXACT_PRESENTATION_PATH"
      : candidates.length === 0
        ? "BLOCKED_PRESENTATION_NODE_NOT_FOUND"
        : "BLOCKED_PRESENTATION_NODE_AMBIGUOUS",
    node_id: candidates.length === 1 ? candidates[0].node_id : "",
    full_path: String(fullPath ?? ""),
    candidate_node_ids: candidates.map((node) => node.node_id),
    correction_authority: false,
  };
}

function exactSourceTraceKey(value) {
  const source = value?.source ?? {};
  const file = firstText(value?.source_file, source.source_file, source.file);
  const sheet = firstText(value?.sheet, source.sheet);
  const row = Number(value?.row ?? value?.physical_row ?? value?.source_row ?? source.row);
  const sourceCell = firstText(value?.source_cell, source.source_cell, source.cell);
  const sha256 = firstText(value?.sha256, source.sha256).toUpperCase();
  if (!file || !sheet || !Number.isInteger(row) || !sourceCell || !sha256) return "";
  return JSON.stringify([normalized(file), normalized(sheet), row, normalized(sourceCell), sha256]);
}

export function resolveHierarchyNodeFromTrace(result, tree) {
  const trace = Array.isArray(result?.trace) ? result.trace : [];
  const fullPath = selectHierarchyTracePath(trace, ["full_path"]);
  const traceKeys = new Set(trace.map(exactSourceTraceKey).filter(Boolean));
  if (!fullPath || traceKeys.size === 0) {
    return {
      status: "MISSING_SOURCE_TRACE",
      node_id: "",
      full_path: fullPath,
      candidate_node_ids: [],
      correction_authority: false,
    };
  }
  const pathIdentity = pathKey(fullPath);
  const candidates = (tree?.nodes ?? []).filter((node) =>
    node.path_key === pathIdentity && traceKeys.has(exactSourceTraceKey(node)));
  return {
    status: candidates.length === 1
      ? "PROVEN_EXACT_SOURCE_TRACE"
      : candidates.length === 0
        ? "BLOCKED_SOURCE_NODE_NOT_FOUND"
        : "BLOCKED_SOURCE_NODE_AMBIGUOUS",
    node_id: candidates.length === 1 ? candidates[0].node_id : "",
    full_path: fullPath,
    candidate_node_ids: candidates.map((node) => node.node_id),
    correction_authority: false,
  };
}

function bindingForRow(row, tree, system) {
  if (!tree) return { mapped: false, system, status: "BLOCKED_TREE_MISSING" };
  const systemKey = normalized(system);
  const pathHint = firstText(row?.[`${systemKey}_node_path`], row?.node_path);
  const explicitNodeId = firstText(row?.[`${systemKey}_node_id`]);
  let candidates = explicitNodeId
    ? tree.nodes.filter((node) => node.node_id === explicitNodeId)
    : [];
  if (candidates.length === 0 && pathHint) {
    const key = pathKey(pathHint);
    candidates = tree.nodes.filter((node) => node.path_key === key);
  }
  if (candidates.length !== 1) {
    return {
      mapped: false,
      system,
      status: candidates.length === 0 ? "TEMPLATE_CATALOG_MISMATCH" : "AMBIGUOUS_TEMPLATE_NODE",
      path_hint: pathHint,
      candidate_node_ids: candidates.map((node) => node.node_id),
    };
  }
  const node = candidates[0];
  return {
    mapped: true,
    system,
    status: node.hierarchy_status,
    node_id: node.node_id,
    parent_node_id: node.parent_id,
    level: node.level,
    is_group: node.is_group,
    immediate_children: node.immediate_children,
    recursive_descendants: node.recursive_descendants,
    full_path: node.full_path,
    path: node.path_parts,
    source: node.source,
    direct_total: node.direct_total,
    immediate_child_sum: node.immediate_child_sum,
    hierarchy_delta: node.hierarchy_delta,
    coverage: node.coverage,
    aggregation_grain: node.aggregation_grain ?? null,
    aggregation_grain_review: node.aggregation_grain_review ?? null,
  };
}

function intalevHierarchyStatus(binding) {
  return binding?.mapped === true && [
    "PASS",
    "LEAF",
    "PASS_NON_ADDITIVE_CONTRACT",
    "REVIEW_ONLY_AGGREGATION_CONTRACT",
  ].includes(text(binding.status))
    ? "PROVEN"
    : "UNPROVEN";
}

function addNearestMappedParent(bindings, rows, tree) {
  const mappedByNode = new Map();
  bindings.forEach((binding, index) => {
    if (!binding.mapped) return;
    if (!mappedByNode.has(binding.node_id)) mappedByNode.set(binding.node_id, []);
    mappedByNode.get(binding.node_id).push(index);
  });
  const nodeById = new Map(tree.nodes.map((node) => [node.node_id, node]));
  const structuralRolePriority = (row) => {
    const role = normalized(row?.type ?? row?.group ?? row?.hierarchy_group);
    if (role.includes("итог")) return 50;
    if (role === "блок" || role.endsWith(" блок")) return 40;
    if (role.includes("подблок")) return 30;
    if (role.includes("статья")) return 20;
    if (role.includes("деталь")) return 10;
    return 0;
  };
  const uniqueStructuralAnchor = (indexes) => {
    if (indexes.length === 1) return indexes[0];
    const ranked = indexes
      .map((index) => ({ index, priority: structuralRolePriority(rows[index]) }))
      .sort((left, right) => right.priority - left.priority);
    return ranked.length > 0 &&
      ranked[0].priority > ranked[1].priority &&
      ranked[0].priority > 0
      ? ranked[0].index
      : null;
  };
  bindings.forEach((binding) => {
    if (!binding.mapped) return;
    let parentId = binding.parent_node_id;
    binding.parent_code = "";
    while (parentId) {
      const mappedIndexes = mappedByNode.get(parentId) ?? [];
      const anchorIndex = uniqueStructuralAnchor(mappedIndexes);
      if (anchorIndex !== null) {
        binding.parent_code = text(rows[anchorIndex]?.code);
        break;
      }
      parentId = nodeById.get(parentId)?.parent_id ?? null;
    }
  });
}

export function bindTemplateRowsToTrees(
  rows,
  {
    erpTree = null,
    intalevTree = null,
    canonicalSystem = "INTALEV",
    economicHierarchyMapping = null,
  } = {},
) {
  const blockers = [];
  const erpBindings = (rows ?? []).map((row) => bindingForRow(row, erpTree, "ERP"));
  const intalevBindings = (rows ?? []).map((row) =>
    bindingForRow(row, intalevTree, "INTALEV"),
  );
  if (erpTree) addNearestMappedParent(erpBindings, rows, erpTree);
  if (intalevTree) addNearestMappedParent(intalevBindings, rows, intalevTree);

  if (normalized(canonicalSystem) !== "intalev") {
    throw new Error("R005 hierarchy parent must use the Intalev source tree.");
  }
  const enrichedRows = (rows ?? []).map((row, index) => {
    const erp = erpBindings[index];
    const intalev = intalevBindings[index];
    // Canonical presentation structure is Intalev-only. ERP is retained as an
    // independent binding control and never supplies parent, path, or outline.
    const canonical = intalev;
    const intalevStatus = intalevHierarchyStatus(intalev);
    const economic = resolveEconomicHierarchyRelationship({
      row,
      erp,
      intalev,
      mapping: economicHierarchyMapping,
    });
    const erpStatus = economic.evidence_category === "EXPLICIT_MAPPING_CONTRADICTION"
      ? "MISMATCH"
      : economic.economic_parent_proven
        ? "PROVEN"
        : "UNPROVEN";
    if (!erp.mapped) {
      addBlocker(
        blockers,
        makeBlocker(erp.status, "Template row не привязан к ERP tree.", {
          code: text(row.code),
          path_hint: erp.path_hint,
        }),
      );
    }
    if (!intalev.mapped) {
      addBlocker(
        blockers,
        makeBlocker(intalev.status, "Template row не привязан к Intalev tree.", {
          code: text(row.code),
          path_hint: intalev.path_hint,
        }),
      );
    }
    if (economic.evidence_severity === "BLOCKED") {
      addBlocker(
        blockers,
        makeBlocker("ECONOMIC_PARENT_CONTRADICTION", "Фактический parent противоречит явному economic mapping.", {
          code: text(row.code),
          ...economic,
        }),
      );
    }
    const hierarchyHardBlocked = !erp.mapped || !intalev.mapped || economic.evidence_severity === "BLOCKED";
    return {
      ...row,
      erp_hierarchy: erp,
      intalev_hierarchy: intalev,
      ...economic,
      hierarchy_node_id: canonical.node_id ?? "",
      hierarchy_parent_node_id: canonical.parent_node_id ?? "",
      hierarchy_parent_code: canonical.parent_code ?? "",
      hierarchy_level: canonical.level ?? 0,
      hierarchy_has_children: Boolean(canonical.immediate_children?.length),
      hierarchy_immediate_children: canonical.immediate_children ?? [],
      hierarchy_recursive_descendants: canonical.recursive_descendants ?? [],
      hierarchy_path: canonical.path ?? [],
      hierarchy_source_system: canonical.system ?? "",
      // Preserve the legacy combined fail-closed gate for downstream
      // financial/operation consumers. Presentation reads the two explicit
      // statuses below and never derives its parent from this combined field.
      hierarchy_status: hierarchyHardBlocked
        ? "BLOCKED_TEMPLATE_CATALOG_MISMATCH"
        : canonical.status,
      intalev_hierarchy_status: intalevStatus,
      erp_binding_status: erpStatus,
    };
  });

  for (const blocker of erpTree?.blockers ?? []) addBlocker(blockers, blocker);
  for (const blocker of intalevTree?.blockers ?? []) addBlocker(blockers, blocker);
  return {
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    ready_to_upload: false,
    release_allowed: false,
    blockers,
    rows: enrichedRows,
    template_graph: {
      schema: "opiu-template-hierarchy-binding-v1",
      version: "2026-08-01",
      canonical_system: normalized(canonicalSystem).toUpperCase(),
      nodes: enrichedRows.map((row) => ({
        code: text(row.code),
        canonical_node_id: text(row.hierarchy_node_id),
        canonical_parent_node_id: text(row.hierarchy_parent_node_id),
        canonical_parent_code: text(row.hierarchy_parent_code),
        erp_node_id: text(row.erp_hierarchy?.node_id),
        erp_parent_node_id: text(row.erp_hierarchy?.parent_node_id),
        erp_parent_code: text(row.erp_hierarchy?.parent_code),
        erp_binding_status: text(row.erp_binding_status),
        erp_presentation_parent: text(row.erp_presentation_parent),
        erp_presentation_parent_node_id: text(row.erp_presentation_parent_node_id),
        intalev_node_id: text(row.intalev_hierarchy?.node_id),
        intalev_parent_node_id: text(row.intalev_hierarchy?.parent_node_id),
        intalev_parent_code: text(row.intalev_hierarchy?.parent_code),
        intalev_presentation_parent: text(row.intalev_presentation_parent),
        intalev_presentation_parent_node_id: text(row.intalev_presentation_parent_node_id),
        presentation_parent_match: row.presentation_parent_match === true,
        economic_parent: text(row.economic_parent),
        economic_parent_proven: row.economic_parent_proven === true,
        economic_parent_match: row.economic_parent_match === true,
        evidence_category: text(row.evidence_category),
        evidence_severity: text(row.evidence_severity),
        evidence_status: text(row.evidence_status),
        correction_authority: row.correction_authority === true,
        posting_parent: text(row.posting_parent),
        posting_parent_proven: row.posting_parent_proven === true,
        intalev_hierarchy_status: text(row.intalev_hierarchy_status),
        intalev_source_parent_code: text(row.intalev_source_parent_code),
        intalev_source_outline_level: Number(row.intalev_source_outline_level ?? 0),
        intalev_source_outline_basis: text(row.intalev_source_outline_basis),
        intalev_reference_status: text(row.intalev_reference_status),
        intalev_reference_parent_code: text(row.intalev_reference_parent_code),
        intalev_reference_outline_level: Number(row.intalev_reference_outline_level ?? 0),
        intalev_reference_graph_id: text(row.intalev_reference_graph_id),
        intalev_reference_graph_sha256: text(row.intalev_reference_graph_sha256),
        intalev_reference_template_sha256: text(row.intalev_reference_template_sha256),
        intalev_reference_source_sheet: text(row.intalev_reference_source_sheet),
        intalev_reference_source_row: Number(row.intalev_reference_source_row ?? 0),
        intalev_reference_source_cell: text(row.intalev_reference_source_cell),
        erp_used_for_canonical_parent: false,
        erp_aggregation_grain: row.erp_hierarchy?.aggregation_grain ?? null,
        intalev_aggregation_grain: row.intalev_hierarchy?.aggregation_grain ?? null,
      })),
    },
  };
}
