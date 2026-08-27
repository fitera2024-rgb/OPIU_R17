function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : null;
}

export function sourceBusinessLabelKey(value) {
  const normalized = text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/^\d+\s*[_:.-]+\s*/u, "")
    .replace(/^_+/u, "")
    .replace(/\bком\.?\s*расход(?:ы|ов)?\b/gu, "коммерческие расходы")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const exactAliases = new Map([
    ["фзп", "заработная плата"],
    ["тэу внутренние тк", "тэу внутренние"],
    ["прр внешние", "погрузочно разгрузочные работы"],
    ["орг техника и комплектующие", "мбп прочие"],
    ["прочее реклама", "реклама и прочий маркетинг"],
    ["проживание", "командировочные"],
    ["содержание погрузочных механизмов", "содержание оборудования"],
    ["содержание прочего оборудования", "содержание оборудования"],
    ["содержание хо установок", "содержание оборудования"],
  ]);
  return exactAliases.get(normalized) ?? normalized;
}

function nodesOf(parsed) {
  return Array.isArray(parsed?.hierarchy_tree?.nodes)
    ? parsed.hierarchy_tree.nodes
    : [];
}

function parentIdOf(node) {
  return text(node?.parent_node_id ?? node?.parent_id);
}

function indexTree(nodes) {
  const byId = new Map(nodes.map((node) => [text(node?.node_id), node]));
  const children = new Map(nodes.map((node) => [text(node?.node_id), []]));
  for (const node of nodes) {
    const parentId = parentIdOf(node);
    if (parentId && children.has(parentId)) children.get(parentId).push(node);
  }
  for (const values of children.values()) {
    values.sort((left, right) =>
      Number(left?.source?.row ?? 0) - Number(right?.source?.row ?? 0));
  }
  return { byId, children };
}

function ancestry(node, byId) {
  const result = [];
  let current = node;
  const visited = new Set();
  while (current && !visited.has(text(current?.node_id))) {
    visited.add(text(current?.node_id));
    result.unshift(current);
    current = byId.get(parentIdOf(current));
  }
  return result;
}

function isIntalevExpenseBlock(node, byId) {
  const key = sourceBusinessLabelKey(node?.label ?? node?.name);
  if (!key.includes("расход") || key.includes("итого")) return false;
  const parents = ancestry(node, byId).slice(0, -1).map((item) =>
    sourceBusinessLabelKey(item?.label ?? item?.name));
  return parents.includes("статьи опиу 2025") &&
    parents.includes("расходы по основной деятельности итого");
}

function intalevBlocks(parsed) {
  const nodes = nodesOf(parsed);
  const index = indexTree(nodes);
  return nodes
    .filter((node) => isIntalevExpenseBlock(node, index.byId))
    .filter((node) => {
      const parent = index.byId.get(parentIdOf(node));
      return sourceBusinessLabelKey(parent?.label ?? parent?.name) === "статьи опиу 2025";
    })
    .sort((left, right) =>
      Number(left?.source?.row ?? 0) - Number(right?.source?.row ?? 0));
}

function erpBlock(parsed, blockKey) {
  const nodes = nodesOf(parsed);
  const candidates = nodes
    .filter((node) => sourceBusinessLabelKey(node?.label) === blockKey)
    .filter((node) => node?.is_group === true)
    .filter((node) => sourceBusinessLabelKey(node?.full_path).includes("расход"))
    .sort((left, right) => {
      const leftPreferred = sourceBusinessLabelKey(left?.full_path)
        .includes("расходы по основной деятельности итого") ? 0 : 1;
      const rightPreferred = sourceBusinessLabelKey(right?.full_path)
        .includes("расходы по основной деятельности итого") ? 0 : 1;
      return leftPreferred - rightPreferred ||
        Number(left?.source?.row ?? 0) - Number(right?.source?.row ?? 0);
    });
  return candidates[0] ?? null;
}

function depthFirst(root, treeIndex) {
  const result = [];
  const append = (node, depth) => {
    result.push({ node, depth });
    for (const child of treeIndex.children.get(text(node?.node_id)) ?? []) {
      append(child, depth + 1);
    }
  };
  append(root, 0);
  return result;
}

function relativePathSignature(node, root, byId) {
  const chain = ancestry(node, byId);
  const rootIndex = chain.findIndex((item) => text(item?.node_id) === text(root?.node_id));
  return chain
    .slice(Math.max(0, rootIndex))
    .map((item) => sourceBusinessLabelKey(item?.label ?? item?.name))
    .join(" / ");
}

function descendants(root, treeIndex) {
  return depthFirst(root, treeIndex).map((item) => item.node);
}

function sourceTrace(node, period, system) {
  const source = node?.source ?? {};
  return {
    period,
    source_system: system,
    source_file: text(source.file ?? source.source_file),
    sheet: text(source.sheet),
    row: Number(source.row ?? 0) || null,
    source_cell: text(source.source_cell),
    full_path: text(node?.full_path),
    amount: money(node?.direct_total),
  };
}

function aggregateNodes(entries, system) {
  const numeric = entries
    .map((entry) => money(entry?.node?.direct_total))
    .filter((value) => value !== null);
  return {
    amount: entries.length > 0 && numeric.length === entries.length
      ? money(numeric.reduce((sum, value) => sum + value, 0))
      : null,
    trace: entries.map((entry) => sourceTrace(entry.node, entry.period, system)),
  };
}

function periodBlock(parsed, blockKey, system) {
  if (system === "INTALEV") {
    return intalevBlocks(parsed).find((node) =>
      sourceBusinessLabelKey(node?.label ?? node?.name) === blockKey) ?? null;
  }
  return erpBlock(parsed, blockKey);
}

function matchingIntalevNodes(parsed, blockKey, relativeSignature) {
  const root = periodBlock(parsed, blockKey, "INTALEV");
  if (!root) return [];
  const index = indexTree(nodesOf(parsed));
  return descendants(root, index).filter((node) =>
    relativePathSignature(node, root, index.byId) === relativeSignature);
}

function erpLeavesByKey(parsed, blockKey) {
  const root = periodBlock(parsed, blockKey, "ERP");
  if (!root) return new Map();
  const index = indexTree(nodesOf(parsed));
  const result = new Map();
  for (const node of descendants(root, index).slice(1)) {
    if (node?.is_group === true) continue;
    const key = sourceBusinessLabelKey(node?.label);
    if (!key) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(node);
  }
  return result;
}

function uniqueUnclassifiedIntalevEntries(intalevParsed, erpEntries, articleKey) {
  const erpByPeriod = new Map();
  for (const entry of erpEntries) {
    const period = text(entry?.period);
    const amount = money(entry?.node?.direct_total);
    if (!period || amount === null) return [];
    erpByPeriod.set(period, money((erpByPeriod.get(period) ?? 0) + amount));
  }
  const result = [];
  for (const [period, erpAmount] of erpByPeriod.entries()) {
    const parsed = intalevParsed.find((item) => text(item?.period) === period);
    if (!parsed) return [];
    const nodes = nodesOf(parsed);
    const index = indexTree(nodes);
    const candidates = nodes.filter((node) => {
      if (node?.is_group === true) return false;
      if ((index.children.get(text(node?.node_id)) ?? []).length > 0) return false;
      if (sourceBusinessLabelKey(node?.label ?? node?.name) !== articleKey) return false;
      if (sourceBusinessLabelKey(node?.full_path).includes("статьи опиу 2025")) return false;
      const amount = money(node?.direct_total);
      return amount !== null && amount === erpAmount;
    });
    if (candidates.length !== 1) return [];
    result.push({ node: candidates[0], period });
  }
  return result;
}

function proofFor(node, parentCode, depth) {
  return {
    status: "PROVEN_LIVE_INTALEV",
    system: "INTALEV",
    basis: "LIVE_INTALEV_SOURCE_EXPENSE_TREE",
    node_id: text(node?.node_id),
    parent_node_id: parentIdOf(node),
    parent_code: parentCode,
    outline_level: depth,
    path: text(node?.full_path).split(/\s+\/\s+/u).filter(Boolean),
    source: node?.source ?? null,
    erp_used: false,
  };
}

function rowCode(index) {
  return `S${String(index).padStart(3, "0")}`;
}

/**
 * Adds expense branches that exist in the live Intalev and ERP reports but
 * are absent from the legacy R001-R065 correction template.  These rows are
 * presentation/control-only: they never enter the posting decision engine.
 */
export function buildSourceDrivenExpensePresentationRows({
  coreRows = [],
  intalevParsed = [],
  erpParsed = [],
} = {}) {
  const representedBlockKeys = new Set(
    coreRows
      .filter((row) => text(row?.hierarchy_node_id))
      .map((row) => {
        const sourceKey = sourceBusinessLabelKey(row?.hierarchy_path?.at?.(-1));
        const visibleKey = sourceBusinessLabelKey(row?.intalev_label);
        return sourceKey && sourceKey === visibleKey ? sourceKey : "";
      })
      .filter(Boolean),
  );
  const candidateByKey = new Map();
  const discoveredBlockKeys = new Set();
  const legacyWholeBlockCoverage = new Set(["административные расходы"]);
  for (const parsed of intalevParsed) {
    for (const block of intalevBlocks(parsed)) {
      const key = sourceBusinessLabelKey(block?.label ?? block?.name);
      if (key) discoveredBlockKeys.add(key);
      const wholeBlockAlreadyVisible =
        legacyWholeBlockCoverage.has(key) && representedBlockKeys.has(key);
      if (!key || wholeBlockAlreadyVisible || candidateByKey.has(key)) continue;
      candidateByKey.set(key, { parsed, block });
    }
  }

  const rows = [];
  const audit = [];
  let sequence = 1;
  for (const [blockKey, base] of candidateByKey) {
    const baseNodes = nodesOf(base.parsed);
    const baseIndex = indexTree(baseNodes);
    const ordered = depthFirst(base.block, baseIndex);
    const codesByNodeId = new Map();
    const orderedByNodeId = new Map(
      ordered.map((entry) => [text(entry.node?.node_id), entry]),
    );
    const intalevCandidatesByKey = new Map();
    for (const entry of ordered.slice(1)) {
      const key = sourceBusinessLabelKey(entry.node?.label ?? entry.node?.name);
      if (!key) continue;
      if (!intalevCandidatesByKey.has(key)) intalevCandidatesByKey.set(key, []);
      intalevCandidatesByKey.get(key).push(entry);
    }
    const erpEntriesByKey = new Map();
    for (let periodIndex = 0; periodIndex < erpParsed.length; periodIndex += 1) {
      const parsed = erpParsed[periodIndex];
      for (const [key, nodes] of erpLeavesByKey(parsed, blockKey)) {
        if (!erpEntriesByKey.has(key)) erpEntriesByKey.set(key, []);
        for (const node of nodes) {
          erpEntriesByKey.get(key).push({
            node,
            period: parsed?.period ?? intalevParsed[periodIndex]?.period ?? "",
          });
        }
      }
    }
    // ERP stores expense articles as leaves, while Intalev may show the same
    // business article above its physical details. Bind each ERP article to
    // the nearest (shallowest) unambiguous same-name Intalev node and roll the
    // amount through that node's real Intalev ancestors. This keeps the two
    // source trees separate but makes parent/article totals comparable.
    const erpEntriesAssignedToIntalevNode = new Map();
    const erpAssignmentByKey = new Map();
    for (const [key, entries] of erpEntriesByKey) {
      const candidates = intalevCandidatesByKey.get(key) ?? [];
      if (candidates.length === 0) continue;
      const minimumDepth = Math.min(...candidates.map((entry) => entry.depth));
      const shallowest = candidates.filter((entry) => entry.depth === minimumDepth);
      if (shallowest.length !== 1) continue;
      const nodeId = text(shallowest[0].node?.node_id);
      erpEntriesAssignedToIntalevNode.set(nodeId, entries);
      erpAssignmentByKey.set(key, nodeId);
    }

    const erpEntriesForIntalevNode = (node) => {
      const nodeId = text(node?.node_id);
      const entries = [];
      const seen = new Set();
      for (const [assignedNodeId, assignedEntries] of erpEntriesAssignedToIntalevNode) {
        let current = orderedByNodeId.get(assignedNodeId)?.node ?? null;
        let belongs = false;
        const visited = new Set();
        while (current && !visited.has(text(current?.node_id))) {
          const currentId = text(current?.node_id);
          visited.add(currentId);
          if (currentId === nodeId) {
            belongs = true;
            break;
          }
          current = baseIndex.byId.get(parentIdOf(current));
        }
        if (!belongs) continue;
        for (const entry of assignedEntries) {
          const identity = `${text(entry.period)}|${text(entry.node?.node_id)}|${text(entry.node?.source?.row)}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          entries.push(entry);
        }
      }
      return entries;
    };
    const consumedErpKeys = new Set();
    const exactUnclassifiedMatchedKeys = new Set();
    let rootCode = "";
    for (const { node, depth } of ordered) {
      const code = rowCode(sequence++);
      if (depth === 0) rootCode = code;
      codesByNodeId.set(text(node?.node_id), code);
      const parentCode = depth === 0
        ? ""
        : codesByNodeId.get(parentIdOf(node)) ?? rootCode;
      const relativeSignature = relativePathSignature(
        node,
        base.block,
        baseIndex.byId,
      );
      const intalevEntries = [];
      for (const parsed of intalevParsed) {
        for (const candidate of matchingIntalevNodes(parsed, blockKey, relativeSignature)) {
          intalevEntries.push({ node: candidate, period: parsed?.period ?? "" });
        }
      }
      const intalev = aggregateNodes(intalevEntries, "INTALEV");
      const key = sourceBusinessLabelKey(node?.label ?? node?.name);
      let erpEntries = [];
      if (depth === 0) {
        for (const parsed of erpParsed) {
          const root = periodBlock(parsed, blockKey, "ERP");
          if (root) erpEntries.push({ node: root, period: parsed?.period ?? "" });
        }
      } else {
        erpEntries = erpEntriesForIntalevNode(node);
        for (const [assignedKey, assignedNodeId] of erpAssignmentByKey) {
          let current = orderedByNodeId.get(assignedNodeId)?.node ?? null;
          const visited = new Set();
          while (current && !visited.has(text(current?.node_id))) {
            const currentId = text(current?.node_id);
            visited.add(currentId);
            if (currentId === text(node?.node_id)) {
              consumedErpKeys.add(assignedKey);
              break;
            }
            current = baseIndex.byId.get(parentIdOf(current));
          }
        }
      }
      const erp = aggregateNodes(erpEntries, "ERP");
      const erpLabel = erpEntries.length > 0
        ? text(erpEntries[0]?.node?.label)
        : "";
      rows.push({
        code,
        type: depth === 0
          ? "БЛОК РАСХОДОВ ИЗ ИСХОДНЫХ ОТЧЁТОВ"
          : "СТРОКА ДЕРЕВА ИНТАЛЕВ ИЗ ИСХОДНОГО ОТЧЁТА",
        intalev_label: text(node?.label ?? node?.name),
        erp_label: erpLabel,
        intalev: {
          amount: intalev.amount,
          status: intalev.amount === null ? "MISSING" : "MATCHED",
          trace: intalev.trace,
          note: "Фактическая строка дерева выбранного архива Инталев; не входит в старое ограничение R001-R065.",
        },
        erp: {
          amount: erp.amount,
          status: erp.amount === null
            ? "MISSING"
            : erpEntries.length > 1
              ? "MATCHED_DUPLICATE_HIERARCHY"
              : "MATCHED",
          trace: erp.trace,
          note: erp.amount === null
            ? "Точная одноимённая строка внутри соответствующего блока ERP не найдена."
            : "ERP сопоставлен внутри одноимённого блока по точному нормализованному названию статьи и свёрнут вверх только по фактическим родителям Инталев.",
        },
        hierarchy_node_id: text(node?.node_id),
        hierarchy_parent_node_id: parentIdOf(node),
        hierarchy_path: ancestry(node, baseIndex.byId)
          .map((item) => text(item?.label ?? item?.name))
          .filter(Boolean),
        hierarchy_level: Number(node?.level ?? depth),
        intalev_hierarchy: {
          mapped: true,
          status: "MATCHED",
          source: node?.source ?? null,
          node_id: text(node?.node_id),
          parent_node_id: parentIdOf(node),
          direct_total: money(node?.direct_total),
        },
        erp_hierarchy: erpEntries.length > 0
          ? {
              mapped: true,
              status: "MATCHED",
              source: erpEntries[0]?.node?.source ?? null,
              node_id: text(erpEntries[0]?.node?.node_id),
              parent_node_id: parentIdOf(erpEntries[0]?.node),
              direct_total: erp.amount,
            }
          : { mapped: false, status: "UNPROVEN" },
        presentation_source_index: Number(node?.source?.row ?? sequence) - 1,
        presentation_parent_code: parentCode,
        presentation_parent_basis: "LIVE_INTALEV_SOURCE_EXPENSE_TREE",
        presentation_depth: Math.min(7, depth),
        presentation_source_outline_level: Number(node?.level ?? depth),
        presentation_outline_level: Math.min(7, depth),
        presentation_hierarchy_status: "HIERARCHY_PROVEN",
        presentation_structural_proof: proofFor(node, parentCode, depth),
        presentation_reason: "Добавлено из полного фактического дерева расходов; correction_authority=false.",
        intalev_live_hierarchy_status: "PROVEN",
        intalev_hierarchy_status: "PROVEN",
        erp_binding_status: erp.amount === null ? "UNPROVEN" : "PROVEN",
        source_driven_expense_row: true,
        correction_authority: false,
        posting_rows: 0,
        ready_to_upload: false,
        release_allowed: false,
      });
    }

    for (const [key, entries] of [...erpEntriesByKey.entries()]
      .filter(([key]) => !consumedErpKeys.has(key))
      .sort((left, right) =>
        Number(left[1][0]?.node?.source?.row ?? 0) -
        Number(right[1][0]?.node?.source?.row ?? 0))) {
      const erp = aggregateNodes(entries, "ERP");
      const code = rowCode(sequence++);
      const unclassifiedIntalevEntries = uniqueUnclassifiedIntalevEntries(
        intalevParsed,
        entries,
        key,
      );
      if (unclassifiedIntalevEntries.length > 0) {
        const intalev = aggregateNodes(unclassifiedIntalevEntries, "INTALEV");
        const sourceNode = unclassifiedIntalevEntries[0].node;
        const sourcePath = text(sourceNode?.full_path)
          .split(/\s+\/\s+/u)
          .filter(Boolean);
        exactUnclassifiedMatchedKeys.add(key);
        rows.push({
          code,
          type: "СТАТЬЯ ИНТАЛЕВ ИЗ НЕРАЗМЕЧЕННОЙ ВЕТКИ, СОПОСТАВЛЕНА С ERP",
          intalev_label: text(sourceNode?.label ?? sourceNode?.name),
          erp_label: text(entries[0]?.node?.label),
          intalev: {
            amount: intalev.amount,
            status: "MATCHED_OUTSIDE_ARTICLE_TREE",
            trace: intalev.trace,
            note: "Строка найдена в архиве Инталев вне ветки _Статьи ОПиУ 2025 и однозначно сопоставлена по названию и точной сумме.",
          },
          erp: {
            amount: erp.amount,
            status: entries.length > 1 ? "MATCHED_DUPLICATE_HIERARCHY" : "MATCHED",
            trace: erp.trace,
            note: "ERP-статья и сумма точно совпали с единственной физической строкой Инталев; блок взят из исходной структуры ERP.",
          },
          hierarchy_node_id: text(sourceNode?.node_id),
          hierarchy_parent_node_id: parentIdOf(sourceNode),
          hierarchy_path: sourcePath,
          hierarchy_level: Number(sourceNode?.level ?? 1),
          intalev_hierarchy: {
            mapped: true,
            status: "MATCHED_OUTSIDE_ARTICLE_TREE",
            source: sourceNode?.source ?? null,
            node_id: text(sourceNode?.node_id),
            parent_node_id: parentIdOf(sourceNode),
            direct_total: intalev.amount,
          },
          erp_hierarchy: {
            mapped: true,
            status: "MATCHED",
            source: entries[0]?.node?.source ?? null,
            node_id: text(entries[0]?.node?.node_id),
            parent_node_id: parentIdOf(entries[0]?.node),
            direct_total: erp.amount,
          },
          presentation_source_index: Number(entries[0]?.node?.source?.row ?? sequence) - 1,
          presentation_parent_code: rootCode,
          presentation_parent_basis: "UNIQUE_LABEL_AND_EXACT_AMOUNT_OUTSIDE_ARTICLE_TREE",
          presentation_depth: 1,
          presentation_source_outline_level: 1,
          presentation_outline_level: 1,
          presentation_hierarchy_status: "HIERARCHY_PROVEN_BY_CROSS_SOURCE_EXACT_MATCH",
          presentation_structural_proof: {
            status: "PROVEN_UNIQUE_LABEL_AND_EXACT_AMOUNT",
            system: "INTALEV+ERP_REPORTS",
            basis: "UNIQUE_LABEL_AND_EXACT_AMOUNT_OUTSIDE_ARTICLE_TREE",
            parent_code: rootCode,
            outline_level: 1,
            path: sourcePath,
            source: sourceNode?.source ?? null,
            erp_used: true,
          },
          presentation_reason: "Инталев: строка вне _Статьи ОПиУ 2025; ERP: одноимённая статья и точная сумма внутри блока. Проводка не требуется.",
          intalev_live_hierarchy_status: "PROVEN_SOURCE_OUTSIDE_ARTICLE_TREE",
          intalev_hierarchy_status: "PROVEN_SOURCE_OUTSIDE_ARTICLE_TREE",
          erp_binding_status: "PROVEN",
          source_driven_expense_row: true,
          unclassified_exact_match_binding: true,
          correction_authority: false,
          posting_rows: 0,
          ready_to_upload: false,
          release_allowed: false,
        });
        continue;
      }
      rows.push({
        code,
        type: "СТАТЬЯ ERP БЕЗ ТОЧНОГО УЗЛА В ДЕРЕВЕ ИНТАЛЕВ",
        intalev_label: "",
        erp_label: text(entries[0]?.node?.label),
        intalev: {
          amount: null,
          status: "MISSING",
          trace: [],
          note: "В фактическом дереве Инталев одноимённый узел не найден.",
        },
        erp: {
          amount: erp.amount,
          status: entries.length > 1 ? "MATCHED_DUPLICATE_HIERARCHY" : "MATCHED",
          trace: erp.trace,
          note: "Физические строки ERP объединены только по точному названию внутри одного блока расходов.",
        },
        hierarchy_node_id: "",
        hierarchy_parent_node_id: "",
        hierarchy_path: [],
        hierarchy_level: 1,
        intalev_hierarchy: { mapped: false, status: "UNPROVEN" },
        erp_hierarchy: {
          mapped: true,
          status: "MATCHED",
          source: entries[0]?.node?.source ?? null,
          node_id: text(entries[0]?.node?.node_id),
          parent_node_id: parentIdOf(entries[0]?.node),
          direct_total: erp.amount,
        },
        presentation_source_index: Number(entries[0]?.node?.source?.row ?? sequence) - 1,
        presentation_parent_code: rootCode,
        presentation_parent_basis: "ERP_ARTICLE_WITHOUT_EXACT_INTALEV_NODE",
        presentation_depth: 1,
        presentation_source_outline_level: 1,
        presentation_outline_level: 1,
        presentation_hierarchy_status: "HIERARCHY_UNPROVEN",
        presentation_structural_proof: {
          status: "HIERARCHY_UNPROVEN",
          system: "INTALEV",
          basis: "ERP_ARTICLE_WITHOUT_EXACT_INTALEV_NODE",
          parent_code: rootCode,
          outline_level: 1,
          erp_used: false,
        },
        presentation_reason: "Статья ERP показана серым под соответствующим блоком; это не операция и не основание для проводки.",
        intalev_live_hierarchy_status: "UNPROVEN",
        intalev_hierarchy_status: "UNPROVEN",
        erp_binding_status: "UNPROVEN",
        source_driven_expense_row: true,
        erp_only_article_row: true,
        correction_authority: false,
        posting_rows: 0,
        ready_to_upload: false,
        release_allowed: false,
      });
    }
    audit.push({
      block_key: blockKey,
      root_code: rootCode,
      intalev_rows: ordered.length,
      erp_only_article_groups: [...erpEntriesByKey.keys()]
        .filter((key) =>
          !consumedErpKeys.has(key) && !exactUnclassifiedMatchedKeys.has(key)).length,
      exact_unclassified_article_bindings: exactUnclassifiedMatchedKeys.size,
      correction_authority: false,
      posting_rows: 0,
    });
  }
  return {
    rows,
    audit,
    discovery: {
      discovered_block_keys: [...discoveredBlockKeys],
      represented_block_keys: [...representedBlockKeys],
      candidate_block_keys: [...candidateByKey.keys()],
    },
  };
}

export function insertSourceDrivenExpenseRows(coreRows = [], supplementalRows = [], anchorCode = "R001") {
  if (supplementalRows.length === 0) return [...coreRows];
  const anchorIndex = coreRows.findIndex((row) => text(row?.code) === anchorCode);
  if (anchorIndex < 0) return [...coreRows, ...supplementalRows];
  const anchorLevel = Number(coreRows[anchorIndex]?.presentation_outline_level ?? 0);
  let insertIndex = coreRows.length;
  for (let index = anchorIndex + 1; index < coreRows.length; index += 1) {
    if (Number(coreRows[index]?.presentation_outline_level ?? 0) <= anchorLevel) {
      insertIndex = index;
      break;
    }
  }
  return [
    ...coreRows.slice(0, insertIndex),
    ...supplementalRows,
    ...coreRows.slice(insertIndex),
  ];
}
