function normalized(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU");
}

export const R021_BINDING = Object.freeze({
  code: "R021",
  intalev_label: "Обслуживание орг.техники",
  erp_label: "Обслуживание орг.техники",
  rejected_intalev_alias: "Обслуживание компьютерной техники (СПб)",
  comparison_mode: "",
  covered_by_code: "",
});

export function selectR021ExactIntalevNodes(nodes) {
  const expected = normalized(R021_BINDING.intalev_label);
  return (nodes ?? []).filter((node) => normalized(node?.label) === expected);
}

export function validateR021IndependentTrace({ intalevResult, erpResult }) {
  const intalevTrace = intalevResult?.trace ?? [];
  const erpTrace = erpResult?.trace ?? [];
  const intalevExact = intalevTrace.length > 0 && intalevTrace.every(
    (row) => normalized(row.label) === normalized(R021_BINDING.intalev_label),
  );
  const rejectedAliasUsed = intalevTrace.some(
    (row) => normalized(row.label) === normalized(R021_BINDING.rejected_intalev_alias),
  );
  const inheritedR020 = erpTrace.some((row) => row.template_code === "R020" || row.code === "R020");
  return {
    status: intalevExact && !rejectedAliasUsed && !inheritedR020
      ? "PASS_R021_EXACT_INDEPENDENT_SOURCE"
      : "BLOCKED_R021_SOURCE_IDENTITY",
    intalev_exact: intalevExact,
    rejected_alias_used: rejectedAliasUsed,
    inherited_r020_trace: inheritedR020,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
