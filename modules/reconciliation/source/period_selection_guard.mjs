import path from "node:path";

const REPORT_TYPE_RULES = Object.freeze([
  { code: "01", label: /(?:журнал|journal)/iu },
  { code: "03", label: /(?:опиу|опиу|opiu)/iu },
  { code: "04", label: /(?:осв|trial[\s_-]*balance)/iu },
]);

export const MAY_2025_PERIOD_SELECTION_RULE = Object.freeze({
  period: "2025-05",
  rule:
    "Select exactly one internal May 2025 header/column; filename tokens 01/03/04 before report-kind labels are report type codes, not months.",
  missing_or_duplicate_header: "BLOCKED_PERIOD_AMBIGUOUS",
  other_months_read: false,
});

export function reportTypePeriodTokens(filePath) {
  const name = path.basename(String(filePath ?? "")).toLocaleLowerCase("ru-RU");
  const tokens = [];
  for (const { code, label } of REPORT_TYPE_RULES) {
    const match = name.match(new RegExp(`(?:^|[_\\s-])(20\\d{2})[_\\s-]+${code}[_\\s-]+`, "u"));
    if (!match || !label.test(name.slice(match.index + match[0].length))) continue;
    tokens.push(`${match[1]}-${code}`);
  }
  return tokens;
}

export function removeReportTypeCodesFromPeriods(filePath, periods) {
  const reportTypeTokens = new Set(reportTypePeriodTokens(filePath));
  return [...new Set(periods ?? [])].filter((period) => !reportTypeTokens.has(period)).sort();
}

export function assertUniquePeriodHeader({ period, headers, sourceFile, sheet }) {
  if (!Array.isArray(headers) || headers.length !== 1) {
    const error = new Error(
      `BLOCKED_PERIOD_AMBIGUOUS: ${period} requires exactly one internal period header, found ${headers?.length ?? 0}`,
    );
    error.code = "BLOCKED_PERIOD_AMBIGUOUS";
    error.details = {
      period,
      source_file: sourceFile,
      sheet,
      header_count: headers?.length ?? 0,
      headers: headers ?? [],
    };
    throw error;
  }
  return headers[0];
}
