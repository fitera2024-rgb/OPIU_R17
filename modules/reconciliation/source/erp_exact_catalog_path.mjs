function text(value) {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function labelIdentity(value) {
  return text(value)
    .replace(/^\d+_/, "")
    .replace(/[«»"]/g, "")
    .toLocaleLowerCase("ru-RU");
}

function pathParts(value) {
  return text(value).split(/\s+\/\s+/u).map(text).filter(Boolean);
}

function blocked(status, entry, details = {}) {
  return {
    status,
    node: null,
    diagnostic: {
      status,
      entry_source_row: Number(entry?.source_row ?? 0),
      entry_code: text(entry?.code),
      entry_account: text(entry?.account),
      entry_article: text(entry?.cash_flow_article),
      ...details,
    },
  };
}

/**
 * Resolve one physical ERP catalog entry strictly through the outline nodes
 * that physically precede it. No label search or inferred parent is allowed.
 */
export function resolveAuthoritativeErpEntryNode({
  stack,
  entryLevel,
  entry,
  sourceFile = "",
  sourceSheet = "",
} = {}) {
  const level = Number(entryLevel);
  const article = text(entry?.cash_flow_article);
  if (!Number.isInteger(level) || level <= 0 || !article) {
    return blocked("BLOCKED_ERP_ENTRY_PARENT_CHAIN_MISSING", entry, {
      entry_level: Number.isFinite(level) ? level : null,
      reason: article ? "ENTRY_LEVEL_MISSING" : "ENTRY_ARTICLE_MISSING",
    });
  }

  const sourceStack = Array.isArray(stack) ? stack : [];
  const chain = sourceStack.slice(0, level);
  if (chain.length !== level || chain.some((node) => !node)) {
    return blocked("BLOCKED_ERP_ENTRY_PARENT_CHAIN_MISSING", entry, {
      entry_level: level,
      proven_chain_length: chain.filter(Boolean).length,
      reason: "OUTLINE_CHAIN_NOT_CONTIGUOUS",
    });
  }

  const labels = [];
  for (let index = 0; index < chain.length; index += 1) {
    const node = chain[index];
    const nodeLabel = text(node?.label);
    const nodeLevel = Number(node?.level);
    if (!nodeLabel || nodeLevel !== index) {
      return blocked("BLOCKED_ERP_ENTRY_PARENT_CHAIN_MISSING", entry, {
        entry_level: level,
        chain_index: index,
        node_level: Number.isFinite(nodeLevel) ? nodeLevel : null,
        reason: nodeLabel ? "OUTLINE_LEVEL_DISCONTINUITY" : "OUTLINE_LABEL_MISSING",
      });
    }
    labels.push(nodeLabel);
    const expectedPath = labels.join(" / ");
    if (text(node?.full_path) !== expectedPath) {
      return blocked("BLOCKED_ERP_ENTRY_PARENT_CHAIN_DISAGREEMENT", entry, {
        entry_level: level,
        chain_index: index,
        expected_path: expectedPath,
        observed_path: text(node?.full_path),
        reason: "OUTLINE_NODE_PATH_DISAGREES_WITH_PHYSICAL_CHAIN",
      });
    }
  }

  const parent = chain.at(-1);
  if (labelIdentity(parent?.label) !== labelIdentity(article)) {
    return blocked("BLOCKED_ERP_ENTRY_PARENT_DISAGREEMENT", entry, {
      entry_level: level,
      outline_parent: text(parent?.label),
      outline_parent_path: text(parent?.full_path),
      reason: "ENTRY_ARTICLE_DISAGREES_WITH_IMMEDIATE_OUTLINE_PARENT",
    });
  }

  const canonicalPath = text(parent.full_path);
  const canonicalParts = pathParts(canonicalPath);
  const authoritativeParentChain = chain.map((node) => ({
    level: Number(node.level),
    label: text(node.label),
    full_path: text(node.full_path),
    source_row: Number(node.source_row ?? 0),
  }));
  return {
    status: "PROVEN_EXACT_ERP_ENTRY_PARENT_CHAIN",
    node: {
      // Preserve the legacy selection rank. The physical outline depth is
      // recorded separately and is used only for presentation/audit proof.
      level: 1,
      authoritative_outline_level: Number(parent.level),
      label: article,
      normalized_label: labelIdentity(article),
      block: canonicalParts[0],
      parent_path: canonicalParts.slice(0, -1).join(" / "),
      full_path: canonicalPath,
      catalog_entries: [{ ...entry }],
      source_row: Number(entry.source_row ?? 0),
      exact_catalog_entry_node: true,
      exact_parent_chain_status: "PROVEN_EXACT_ERP_ENTRY_PARENT_CHAIN",
      authoritative_parent_chain: authoritativeParentChain,
      source_file: text(sourceFile),
      source_sheet: text(sourceSheet),
    },
    diagnostic: null,
  };
}
