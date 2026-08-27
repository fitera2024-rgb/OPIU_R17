import fs from "node:fs/promises";
import path from "node:path";

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export const MATCHING_HEADERS = [
    "candidate_id", "organization", "cfo", "intalev_block", "intalev_article", "intalev_path",
    "erp_block", "erp_article", "erp_path", "debit_account", "credit_account", "action_type",
    "existing_rule_id", "proposed_decision", "impact_class", "confidence", "missing_fields",
    "required_user_actions", "source_engine", "explanation", "user_status",
];

export function matchingRows(candidates) {
  return candidates.map((c) => [
    c.candidate_id, c.scope?.organization_name, c.accounting?.cfo,
    c.intalev?.opiu_block_name, `${c.intalev?.article_code || ""} ${c.intalev?.article_name || ""}`.trim(), c.intalev?.article_path,
    c.erp?.opiu_block_name, `${c.erp?.article_code || ""} ${c.erp?.article_name || ""}`.trim(), c.erp?.article_path,
    c.accounting?.debit_account, c.accounting?.credit_account, c.action?.action_type,
    c.existing_rule_id, c.decision, c.impact_class, `${c.confidence?.level || ""} ${c.confidence?.score ?? ""}`.trim(),
    c.missing_fields, c.required_user_actions, c.evidence?.source_engine, c.evidence?.explanation, c.user_status,
  ]);
}

export async function writeMatchingCsv(filePath, candidates) {
  const rows = matchingRows(candidates);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const csv = [MATCHING_HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  await fs.writeFile(filePath, `\ufeff${csv}\r\n`, "utf8");
}
