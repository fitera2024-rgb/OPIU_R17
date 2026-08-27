const MISSING_PARENT_PREFIX = "__OPIU_MISSING_OUTLINE_PARENT__";

function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function outlineLevel(value) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 ? level : 0;
}

/**
 * Advance the physical Excel outline without serializing the hierarchy to a
 * delimiter-separated string.  Excel reports may skip an outline level; the
 * nearest preceding node at a lower level is then the only physical parent
 * evidenced by the source order.  Labels remain atomic, including labels that
 * contain " / " themselves.
 */
export function advanceIntalevOutlinePath(stack, { level, label, identity } = {}) {
  if (!Array.isArray(stack)) throw new Error("INTALEV_OUTLINE_STACK_INVALID");
  const exactLevel = outlineLevel(level);
  const exactLabel = text(label);
  const exactIdentity = text(identity);
  if (!exactLabel || !exactIdentity) throw new Error("INTALEV_OUTLINE_NODE_INVALID");

  stack.length = exactLevel + 1;
  const ancestors = stack
    .slice(0, exactLevel)
    .filter((node) => node && text(node.label) && text(node.identity));
  const parent = ancestors.at(-1) ?? null;
  const parentLevel = parent ? parent.level : null;
  const missingParent = exactLevel > 0 && !parent;
  const parentIdentity = parent
    ? parent.identity
    : missingParent
      ? `${MISSING_PARENT_PREFIX}:${exactIdentity}`
      : "";
  const parentPathParts = ancestors.map((node) => node.label);
  const pathParts = [...parentPathParts, exactLabel];
  const node = Object.freeze({
    level: exactLevel,
    label: exactLabel,
    identity: exactIdentity,
    path_parts: Object.freeze([...pathParts]),
  });
  stack[exactLevel] = node;

  return Object.freeze({
    level: exactLevel,
    label: exactLabel,
    identity: exactIdentity,
    parentIdentity,
    parentPathParts: Object.freeze([...parentPathParts]),
    pathParts: Object.freeze([...pathParts]),
    missingParent,
    outlineGapCollapsed:
      parentLevel !== null && exactLevel - Number(parentLevel) > 1,
  });
}

