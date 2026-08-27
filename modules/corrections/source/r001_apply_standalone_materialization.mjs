export function applyStandaloneStornoMaterialization(merged, standalone) {
  const updates = new Map((standalone?.case_updates ?? []).map((item) => [
    item.upstream_decision_index,
    item,
  ]));
  const decisions = (merged?.decisions ?? []).map((decision, index) => {
    const update = updates.get(index);
    if (!update) return decision;
    return {
      ...decision,
      materialization_case: update.materialization_case,
      canonical_posting_row: update.canonical_posting_row,
      standalone_storno_result: update.result,
      standalone_storno_blockers: update.blockers,
    };
  });
  const bridge = merged?.materialization_bridge ?? {};
  const caseLinks = (bridge.case_links ?? []).map((link) => {
    const update = updates.get(link.upstream_decision_index);
    return update ? { ...link, materialization_case: update.materialization_case } : link;
  });
  const financialCases = caseLinks
    .filter((link) => link.category === "FINANCIAL")
    .map((link) => link.materialization_case);
  const reviewOnlyCases = caseLinks
    .filter((link) => link.category === "REVIEW_ONLY")
    .map((link) => link.materialization_case);
  const canonicalPostingRows = [
    ...(bridge.canonical_posting_rows ?? []),
    ...(standalone?.canonical_posting_rows ?? []),
  ];
  return {
    ...merged,
    decisions,
    materialization_bridge: {
      ...bridge,
      financial_cases: financialCases,
      review_only_cases: reviewOnlyCases,
      canonical_posting_rows: canonicalPostingRows,
      standalone_storno: standalone,
      audit: {
        ...(bridge.audit ?? {}),
        financial_case_count: financialCases.length,
        review_only_case_count: reviewOnlyCases.length,
        canonical_posting_row_count: canonicalPostingRows.length,
        standalone_storno_ready_row_count: standalone?.audit?.ready_row_count ?? 0,
        standalone_storno_sporno_row_count: standalone?.audit?.sporno_row_count ?? 0,
        standalone_storno_blocked_case_count: standalone?.audit?.blocked_case_count ?? 0,
      },
    },
  };
}

