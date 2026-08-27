function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function provenOperationWorkbookRows(operationEvidence = {}) {
  const provenRows = (operationEvidence?.rows ?? []).filter(
    (row) => row.source_operation_proven === true &&
      row.source_proof_status === "SOURCE_OPERATION_PROVEN",
  );
  const rows = provenRows.map((row) => [
    row.source_operation_identity,
    row.parent_code,
    "SOURCE_OPERATION_PROVEN",
    "SOURCE",
    row.source_range,
    String(row.date ?? "").replace(/\s+(?:0|00):00:00$/, ""),
    row.document,
    row.posting_no,
    row.debit,
    (row.debit_analytics ?? []).filter(Boolean).join(" | "),
    row.debit_department,
    row.credit,
    (row.credit_analytics ?? []).filter(Boolean).join(" | "),
    row.credit_department,
    row.organization,
    row.amount,
    null,
    null,
    null,
    row.article,
    null,
    null,
    "Физическая ERP-операция доказана независимо от hierarchy/catalog proof; экономическая корректировка не утверждена.",
    "Сохранить SOURCE proof. STORNO/REPOST разрешать только при ECONOMIC_CORRECTION_PROVEN.",
    "PROVEN_CURRENT_SOURCE_CANDIDATE / SOURCE_OPERATION_PROVEN / ECONOMIC_REVIEW_ONLY",
    row.erp_input_sha256,
    row.erp_opiu_sha256,
    row.journal_sha256,
    row.journal_sheet,
    row.source_row_id,
  ]);
  const blockerNodes = (operationEvidence?.node_evidence ?? []).filter(
    (node) => node?.node_kind === "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER",
  );
  for (const [index, node] of blockerNodes.entries()) {
    const blocker = node?.blocker ?? {};
    const reason = Object.entries(blocker)
      .filter(([key, value]) => key !== "code" && value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
      .join("; ");
    rows.push([
      `FLOW-BLOCKER:${text(node?.period)}:${text(node?.code)}:${index + 1}`,
      text(node?.code),
      "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER",
      "CONTROL",
      "", "", "", "", "", "", "", "", "", "", "",
      null, null, null, null,
      text(blocker?.article),
      null,
      null,
      `Группа физического account-flow заблокирована: ${text(node?.node_status)}.${reason ? ` ${reason}.` : ""}`,
      "Ручная проверка exact ERP source; correction_authority=false; posting_rows=0.",
      `${text(node?.node_status)} / REPORT_ONLY / CORRECTION_AUTHORITY_FALSE / POSTING_ROWS_0`,
      "", "", "", "", "",
    ]);
  }
  return {
    rows,
    proven_count: provenRows.length,
    blocker_count: blockerNodes.length,
  };
}
