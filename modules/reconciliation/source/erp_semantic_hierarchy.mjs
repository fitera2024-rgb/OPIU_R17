export function selectErpSemanticParent({
  article,
  lastSummaryRowIndex,
  rows,
  semanticStack,
  sourceLevel,
}) {
  let parentIndex = null;

  if (article && Number.isInteger(lastSummaryRowIndex)) {
    parentIndex = lastSummaryRowIndex;
  } else {
    while (
      semanticStack.length > 0 &&
      semanticStack.at(-1).source_level >= sourceLevel
    ) {
      semanticStack.pop();
    }
    parentIndex = semanticStack.at(-1)?.row_index ?? null;
  }

  const parent = Number.isInteger(parentIndex) ? rows[parentIndex] ?? null : null;
  return {
    parent,
    parentIndex: parent ? parentIndex : null,
    level: parent ? parent.level + 1 : 0,
    parentPath: parent?.full_path ?? "",
  };
}
