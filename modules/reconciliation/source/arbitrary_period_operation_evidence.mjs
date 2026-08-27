import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readOperationJournalRows } from "./full_operation_evidence.mjs";

const RESULT_SCHEMA = "opiu-arbitrary-period-operation-evidence-v2";
const RELEASE_STATUS = "BLOCKED_RELEASE_GATES_NOT_RUN";

// Operation-bearing terminal codes are structural metadata of the approved
// 65-row UK template.  They come from the independently reviewed July manifest
// and do not carry any July amounts or physical journal rows.
export const DEFAULT_UK_OPERATION_BEARING_CODES = Object.freeze([
  "R003", "R004", "R005", "R006", "R007", "R008", "R009", "R010", "R011",
  "R013", "R014", "R015", "R016", "R017", "R020", "R021", "R022", "R024",
  "R025", "R026", "R027", "R030", "R032", "R034", "R035", "R036", "R038",
  "R040", "R042", "R043", "R047", "R048", "R052", "R054", "R056", "R058",
  "R063", "R064",
]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalize(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[\u00a0\s]+/g, " ")
    .replace(/[«»“”„"]/g, "\"")
    .trim();
}

function cents(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function unique(values) {
  return [...new Set(values)];
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function expectedPeriods(mode, period) {
  if (mode === "month" && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return [period];
  const quarter = period.match(/^(\d{4})-Q([1-4])$/);
  if (mode === "quarter" && quarter) {
    const start = (Number(quarter[2]) - 1) * 3 + 1;
    return [0, 1, 2].map((offset) => `${quarter[1]}-${String(start + offset).padStart(2, "0")}`);
  }
  if (mode === "year" && /^\d{4}$/.test(period)) {
    return Array.from({ length: 12 }, (_, index) => `${period}-${String(index + 1).padStart(2, "0")}`);
  }
  return null;
}

function isActiveFact(row) {
  return ["да", "true", "1"].includes(normalize(row.activity)) && normalize(row.scenario) === "факт";
}

export function selectJournalRowsForExactProfile(rows, period, allowedOrganizations) {
  const exactOrganizations = new Set(
    (Array.isArray(allowedOrganizations) ? allowedOrganizations : [])
      .map(text)
      .filter(Boolean),
  );
  return (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      text(row.period) === text(period) &&
      (exactOrganizations.size === 0 || exactOrganizations.has(text(row.organization))) &&
      isActiveFact(row),
  );
}

function sourceOperationIdentity(operation) {
  return sha256(Buffer.from([
    text(operation.erp_input_sha256), text(operation.erp_opiu_sha256),
    text(operation.journal_sha256), text(operation.journal_sheet),
    text(operation.source_range), text(operation.source_row_id),
    text(operation.date), text(operation.document), text(operation.posting_no),
    text(operation.organization), text(operation.debit), text(operation.credit),
    ...(operation.debit_analytics ?? []).map(text),
    text(operation.debit_department),
    ...(operation.credit_analytics ?? []).map(text),
    text(operation.credit_department),
    text(operation.amount),
  ].join("\u0000"), "utf8"));
}

function hasExactPhysicalSourceIdentity(operation) {
  return /^[A-F0-9]{64}$/.test(text(operation.erp_input_sha256).toUpperCase()) &&
    /^[A-F0-9]{64}$/.test(text(operation.erp_opiu_sha256).toUpperCase()) &&
    /^[A-F0-9]{64}$/.test(text(operation.journal_sha256).toUpperCase()) &&
    text(operation.journal_sheet) !== "" &&
    /^B\d+:AG\d+$/.test(text(operation.source_range)) &&
    /^[A-F0-9]{64}$/.test(text(operation.source_row_id).toUpperCase()) &&
    text(operation.date) !== "" &&
    text(operation.document) !== "" &&
    text(operation.posting_no) !== "" &&
    text(operation.organization) !== "" &&
    text(operation.debit) !== "" &&
    text(operation.credit) !== "" &&
    Array.isArray(operation.debit_analytics) &&
    Array.isArray(operation.credit_analytics) &&
    cents(operation.amount) !== null;
}

function parentCode(row) {
  const value = text(row?.presentation_parent_code || row?.hierarchy_parent_code);
  return /^R\d{3}$/.test(value) ? value : null;
}

function singleCatalogAccount(source) {
  if (text(source?.catalog_status) !== "MATCHED") return "";
  const accounts = unique(
    text(source?.catalog_accounts)
      .split(",")
      .map((value) => text(value))
      .filter(Boolean),
  );
  return accounts.length === 1 ? normalizeAccountIdentity(accounts[0]) : "";
}

function normalizeAccountIdentity(value) {
  const raw = text(value);
  return raw.match(/(?:^|\s)(\d{2}(?:\.\d+)?)(?:\s|$)/)?.[1] ?? "";
}

function exactTraceLeaves(row, period) {
  const seen = new Set();
  const leaves = [];
  for (const source of row?.erp?.trace ?? []) {
    const article = text(source?.article);
    const sourcePeriod = text(source?.month || source?.period_header_trace?.period);
    if (!article || (sourcePeriod && sourcePeriod !== period)) continue;
    const proof = source?.source_tree_proof;
    const key = [text(source?.sha256), text(source?.sheet), text(source?.source_cell), article].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    leaves.push({
      article,
      article_key: normalize(article),
      expected_account: singleCatalogAccount(source),
      source_tree_proven:
        proof?.complete === true && ["LEAF", "PASS"].includes(text(proof.status)),
      source_cell: text(source?.source_cell),
      source_path: text(source?.catalog_path || source?.full_path),
      source_amount: Number(source?.amount),
      exact_parent_summary: source?.exact_parent_summary === true,
      exact_parent_component: source?.exact_parent_component === true,
    });
  }
  return leaves;
}

function accountFlowBlocked(code, detail = {}) {
  return {
    status: code,
    correction_authority: false,
    posting_rows: 0,
    flows: [],
    blocker: { code, ...detail },
  };
}

function rowMap(financialRows) {
  const result = new Map();
  for (const row of financialRows) {
    const code = text(row?.code);
    if (!code) continue;
    result.set(code, [...(result.get(code) ?? []), row]);
  }
  return result;
}

/**
 * Prove physical account-flow chains for any exact ERP parent composition.
 * The parent and its component articles come from source-marked hierarchy
 * proof; no organization, period, R-code, article or amount is hardcoded.
 * Closing legs remain visible and non-additive.
 */
export function classifyProvenParentAccountFlows({
  financialRows,
  activeRows,
  period,
  allowedJournalOrganizations = new Set(),
  tolerance = 0.01,
} = {}) {
  const normalizedPeriod = text(period);
  const rows = Array.isArray(financialRows) ? financialRows : [];
  const journalRows = Array.isArray(activeRows) ? activeRows : [];
  const allowedOrganizations = asSet(allowedJournalOrganizations);
  const byCode = rowMap(rows);
  if ([...byCode.values()].some((matches) => matches.length !== 1)) {
    return accountFlowBlocked("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_DUPLICATE_CODE", {
      period: normalizedPeriod,
      duplicate_codes: [...byCode.entries()]
        .filter(([, matches]) => matches.length !== 1)
        .map(([code]) => code),
    });
  }
  const exactRows = new Map([...byCode.entries()].map(([code, matches]) => [code, matches[0]]));
  const isDescendant = (code, ancestor) => {
    const seen = new Set();
    let current = code;
    while (!seen.has(current)) {
      seen.add(current);
      const row = exactRows.get(current);
      const parent = parentCode(row);
      if (!parent) return false;
      if (parent === ancestor) return true;
      current = parent;
    }
    return false;
  };
  const depth = (code) => {
    let value = 0;
    const seen = new Set();
    let current = code;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentCode(exactRows.get(current));
      if (!parent) break;
      value += 1;
      current = parent;
    }
    return value;
  };
  const compositionRows = [...exactRows.values()].filter((row) =>
    exactTraceLeaves(row, normalizedPeriod).some((leaf) => leaf.exact_parent_component === true));
  if (compositionRows.length === 0) {
    return {
      status: "NOT_APPLICABLE_NO_PROVEN_PARENT_COMPOSITION",
      period: normalizedPeriod,
      flows: [],
      source_row_ids: [],
      operational_amount: 0,
      closing_amount_excluded: 0,
      consumed_amount_once: 0,
      correction_authority: false,
      posting_rows: 0,
    };
  }
  const grouped = new Map();
  for (const row of compositionRows) {
    const components = exactTraceLeaves(row, normalizedPeriod)
      .filter((leaf) => leaf.exact_parent_component === true)
      .sort((left, right) => left.source_cell.localeCompare(right.source_cell, "ru-RU"));
    const key = components.map((leaf) => `${leaf.source_cell}|${normalize(leaf.article)}|${cents(leaf.source_amount)}`).join("||");
    grouped.set(key, [...(grouped.get(key) ?? []), { row, components }]);
  }

  const parentGroups = [];
  const flowBlockers = [];
  for (const entries of grouped.values()) {
    const roots = entries.filter((candidate) => !entries.some((other) =>
      other !== candidate && isDescendant(text(candidate.row.code), text(other.row.code))));
    if (roots.length !== 1) {
      flowBlockers.push({
        code: "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_ROOT_AMBIGUOUS",
        period: normalizedPeriod,
        candidate_codes: entries.map((entry) => text(entry.row.code)),
      });
      continue;
    }
    parentGroups.push({ root: roots[0], aliases: entries });
  }

  const flows = [];
  const globallySelectedSourceRows = new Set();
  const toleranceCents = Math.max(0, Math.round(Math.abs(Number(tolerance)) * 100));
  for (const group of parentGroups) {
    const parentRow = group.root.row;
    const parentCodeValue = text(parentRow.code);
    const selectedLeaves = group.root.components;
    const groupFlows = [];
    const groupSelectedSourceRows = new Set();
    let groupBlocker = null;
    const blockGroup = (code, detail = {}) => {
      groupBlocker = { code, ...detail };
    };
    const componentTotalCents = selectedLeaves.reduce((sum, leaf) => sum + cents(leaf.source_amount), 0);
    if (cents(parentRow?.erp?.amount) !== componentTotalCents ||
        group.aliases.some(({ row }) => cents(row?.erp?.amount) !== componentTotalCents)) {
      blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_REPORT_TOTAL_MISMATCH", {
        period: normalizedPeriod,
        parent_code: parentCodeValue,
        component_total_cents: componentTotalCents,
        alias_amounts: group.aliases.map(({ row }) => ({ code: text(row.code), cents: cents(row?.erp?.amount) })),
      });
      flowBlockers.push(groupBlocker);
      continue;
    }
    for (const leaf of selectedLeaves) {
      if (leaf.source_tree_proven !== true || cents(leaf.source_amount) === null || text(leaf.source_cell) === "") {
        blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_REPORT_COMPONENT_UNPROVEN", {
          period: normalizedPeriod,
          parent_code: parentCodeValue,
          article: leaf.article,
          source_cell: leaf.source_cell,
        });
        break;
      }
      const possibleOwners = [...exactRows.values()]
        .filter((row) => text(row.code) === parentCodeValue || isDescendant(text(row.code), parentCodeValue))
        .filter((row) => cents(row?.erp?.amount) === cents(leaf.source_amount))
        .filter((row) => exactTraceLeaves(row, normalizedPeriod)
          .some((candidate) => normalize(candidate.article) === normalize(leaf.article)))
        .sort((left, right) => depth(text(right.code)) - depth(text(left.code)));
      const ownerRow = possibleOwners[0] ?? parentRow;
      const ownerCode = text(ownerRow.code);
      if (possibleOwners.length > 1 &&
          !possibleOwners.slice(1).every((row) => isDescendant(ownerCode, text(row.code)))) {
        blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_OWNER_AMBIGUOUS", {
          period: normalizedPeriod,
          parent_code: parentCodeValue,
          article: leaf.article,
          owner_codes: possibleOwners.map((row) => text(row.code)),
        });
        break;
      }
    const candidates = journalRows.filter((row) =>
      text(row?.period) === normalizedPeriod &&
      normalize(row?.article) === normalize(leaf.article) &&
      text(row?.organization) !== "" &&
      (allowedOrganizations.size === 0 || allowedOrganizations.has(text(row.organization))));
    if (candidates.length === 0 || candidates.some((row) => !hasExactPhysicalSourceIdentity(row))) {
      blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_PHYSICAL_IDENTITY_UNPROVEN", {
        period: normalizedPeriod,
        parent_code: parentCodeValue,
        article: leaf.article,
        candidate_source_row_ids: candidates.map((row) => text(row?.source_row_id)),
      });
      break;
    }
    const sourceRowIds = candidates.map((row) => text(row.source_row_id));
    if (new Set(sourceRowIds).size !== sourceRowIds.length ||
        sourceRowIds.some((sourceRowId) =>
          globallySelectedSourceRows.has(sourceRowId) || groupSelectedSourceRows.has(sourceRowId))) {
      blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_SOURCE_ROW_REUSED", {
        period: normalizedPeriod,
        parent_code: parentCodeValue,
        article: leaf.article,
        source_row_ids: sourceRowIds,
      });
      break;
    }
    const operational = candidates.filter((row) => text(row.debit) === "91.2" && text(row.credit) !== "99");
    const closing = candidates.filter((row) => text(row.debit) === "99" && text(row.credit) === "91.2");
    const classified = new Set([...operational, ...closing].map((row) => text(row.source_row_id)));
    const expectedCents = cents(leaf.source_amount);
    const operationalCents = operational.reduce((sum, row) => sum + cents(row.amount), 0);
    const closingCents = closing.reduce((sum, row) => sum + cents(row.amount), 0);
    if (
      operational.length === 0 ||
      closing.length === 0 ||
      classified.size !== candidates.length ||
      Math.abs(operationalCents - expectedCents) > toleranceCents ||
      Math.abs(closingCents - expectedCents) > toleranceCents
    ) {
      blockGroup("BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW_NOT_BALANCED", {
        period: normalizedPeriod,
        parent_code: parentCodeValue,
        article: leaf.article,
        expected_cents: expectedCents,
        operational_cents: operationalCents,
        closing_cents: closingCents,
        candidate_count: candidates.length,
        classified_count: classified.size,
      });
      break;
    }
    for (const sourceRowId of sourceRowIds) groupSelectedSourceRows.add(sourceRowId);
    const flowId = `R005-FIN-FLOW-${sha256(Buffer.from([
      normalizedPeriod,
      normalize(leaf.article),
      ...sourceRowIds.sort(),
    ].join("\u0000"), "utf8")).slice(0, 20)}`;
    groupFlows.push({
      flow_id: flowId,
      period: normalizedPeriod,
      article: leaf.article,
      owner_code: ownerCode,
      nested_codes: unique([
        ...group.aliases.map(({ row }) => text(row.code)),
        ownerCode,
      ]).sort((left, right) => depth(left) - depth(right)),
      composition_parent_code: parentCodeValue,
      report_source_cell: leaf.source_cell,
      report_source_amount: leaf.source_amount,
      report_source_amount_cents: expectedCents,
      operational_amount: operationalCents / 100,
      closing_amount: closingCents / 100,
      consumed_amount_once: operationalCents / 100,
      operational_rows: operational,
      closing_rows: closing,
      source_row_ids: sourceRowIds,
      status: "PROVEN_EXACT_ACCOUNT_FLOW_CONSUME_ONCE",
      closing_non_additive: true,
      correction_authority: false,
      posting_rows: 0,
    });
    }
    if (groupBlocker) {
      flowBlockers.push(groupBlocker);
      continue;
    }
    flows.push(...groupFlows);
    for (const sourceRowId of groupSelectedSourceRows) globallySelectedSourceRows.add(sourceRowId);
  }

  if (flows.length === 0 && flowBlockers.length > 0) {
    return {
      ...accountFlowBlocked(flowBlockers[0].code, Object.fromEntries(
        Object.entries(flowBlockers[0]).filter(([key]) => key !== "code"),
      )),
      blockers: flowBlockers,
    };
  }

  return {
    status: "PROVEN_PARENT_ACCOUNT_FLOWS",
    period: normalizedPeriod,
    flows,
    source_row_ids: [...globallySelectedSourceRows],
    operational_amount: flows.reduce((sum, flow) => sum + flow.operational_amount, 0),
    closing_amount_excluded: flows.reduce((sum, flow) => sum + flow.closing_amount, 0),
    consumed_amount_once: flows.reduce((sum, flow) => sum + flow.consumed_amount_once, 0),
    correction_authority: false,
    posting_rows: 0,
    blockers: flowBlockers,
    blocked_group_count: flowBlockers.length,
  };
}

// Backward-compatible named adapter for the accepted R005 regression. The
// implementation itself is generic and derives parents/components from proof.
export const classifyR005FinancialExpenseAccountFlows = classifyProvenParentAccountFlows;

export function provenParentAccountFlowNodeEvidence(proof) {
  const blockers = Array.isArray(proof?.blockers)
    ? proof.blockers
    : proof?.blocker ? [proof.blocker] : [];
  const summary = {
    code: proof?.flows?.[0]?.composition_parent_code ?? blockers[0]?.parent_code ?? null,
    period: proof?.period ?? blockers[0]?.period ?? null,
    node_kind: "PROVEN_PARENT_ACCOUNT_FLOW",
    node_status: proof?.status ?? "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW",
    component_flows: (proof?.flows ?? []).map((flow) => ({
      flow_id: flow.flow_id,
      article: flow.article,
      owner_code: flow.owner_code,
      nested_codes: flow.nested_codes,
      report_source_cell: flow.report_source_cell,
      report_source_amount: flow.report_source_amount,
      operational_source_row_ids: flow.operational_rows.map((row) => row.source_row_id),
      closing_source_row_ids: flow.closing_rows.map((row) => row.source_row_id),
      consumed_amount_once: flow.consumed_amount_once,
      closing_non_additive: true,
      correction_authority: false,
      posting_rows: 0,
    })),
    blocker: blockers.length === 1 ? blockers[0] : null,
    blockers,
  };
  return [
    summary,
    ...blockers.map((blocker) => ({
      code: blocker?.parent_code ?? null,
      period: blocker?.period ?? proof?.period ?? null,
      node_kind: "PROVEN_PARENT_ACCOUNT_FLOW_BLOCKER",
      node_status: blocker?.code ?? "BLOCKED_PROVEN_PARENT_ACCOUNT_FLOW",
      component_flows: [],
      blocker,
      correction_authority: false,
      posting_rows: 0,
    })),
  ];
}

function buildR005ExactAccountFlowDisplayRow(operation, flow, role, displayOrder) {
  const sourceOperationProven = hasExactPhysicalSourceIdentity(operation);
  return {
    ...operation,
    parent_code: flow.owner_code,
    period: flow.period,
    evidence_status: sourceOperationProven ? "SOURCE_OPERATION_PROVEN" : "CANDIDATE_EXCLUDED",
    row_class: "CANDIDATE_EXCLUDED",
    proof_status: sourceOperationProven ? "SOURCE_OPERATION_PROVEN" : "CANDIDATE_NOT_PROVEN",
    source_proof_status: sourceOperationProven ? "SOURCE_OPERATION_PROVEN" : "SOURCE_OPERATION_UNPROVEN",
    local_operation_proof_level: sourceOperationProven
      ? LOCAL_OPERATION_PROOF_LEVELS.PROVEN
      : LOCAL_OPERATION_PROOF_LEVELS.AMBIGUOUS_OR_UNPROVEN,
    local_operation_binding_status: sourceOperationProven
      ? LOCAL_OPERATION_PROOF_LEVELS.PROVEN
      : LOCAL_OPERATION_PROOF_LEVELS.AMBIGUOUS_OR_UNPROVEN,
    local_operation_binding_reason: sourceOperationProven ? null : "PHYSICAL_IDENTITY_INCOMPLETE",
    local_operation_binding_checks: {
      period_match: true,
      source_organization_match: true,
      article_match: true,
      local_owner_match: true,
      amount_match: true,
      account_match: true,
      account_side_match: true,
      physical_identity_complete: sourceOperationProven,
    },
    economic_proof_status: "ECONOMIC_CORRECTION_UNPROVEN",
    exact_article_bound: sourceOperationProven,
    exact_article_key: sourceOperationProven ? normalize(operation.article) : null,
    article_candidate_bound: true,
    article_candidate_key: normalize(operation.article),
    exact_bound_r_code: sourceOperationProven ? flow.owner_code : null,
    source_operation_proven: sourceOperationProven,
    source_operation_identity: sourceOperationProven ? sourceOperationIdentity(operation) : null,
    economic_correction_proven: false,
    display_order: displayOrder,
    display_depth_offset: 1,
    count_in_parent: false,
    count_in_r002: false,
    excluded_from_totals: true,
    account_flow_id: flow.flow_id,
    account_flow_role: role,
    account_flow_status: flow.status,
    account_flow_nested_codes: [...flow.nested_codes],
    account_flow_report_source_cell: flow.report_source_cell,
    account_flow_report_source_amount: flow.report_source_amount,
    account_flow_consumed_amount_once: flow.consumed_amount_once,
    account_flow_closing_non_additive: role === "CLOSING_NON_ADDITIVE",
    reason: role === "CLOSING_NON_ADDITIVE"
      ? "Закрывающая строка Дт 99 / Кт 91.2 доказана физически, но не прибавляется второй раз."
      : "Операционная сторона account-flow; сумма потребляется один раз.",
    comment:
      `${flow.status}; Role=${role}; ReportCell=${flow.report_source_cell}; ` +
      `ConsumedOnce=${flow.consumed_amount_once}; ClosingNonAdditive=${role === "CLOSING_NON_ADDITIVE"}; ` +
      "SOURCE_OPERATION_PROVEN; ECONOMIC_CORRECTION_UNPROVEN; NO_POSTING; EXCLUDED_FROM_TOTAL",
    pair_id: null,
    upload_id: null,
    pair_role: null,
    pair_status: null,
    partner_range: null,
    pair_analysis_status: "BLOCKED_PAIR_ANALYSIS_NOT_APPLICABLE",
  };
}

function sourceAccountIdentity(row) {
  const disclosure = text(row.disclosure);
  const account = normalizeAccountIdentity(disclosure);
  const debit = text(row.debit);
  const credit = text(row.credit);
  const side = account && debit === account
    ? "DT"
    : account && credit === account
      ? "KT"
      : "UNPROVEN_SIDE";
  return {
    account,
    side,
    key: [normalize(row.article), normalize(disclosure), account, side].join("|"),
  };
}

export const LOCAL_OPERATION_PROOF_LEVELS = Object.freeze({
  PROVEN: "LOCAL_OPERATION_PROVEN",
  PLAUSIBLE: "LOCAL_OPERATION_PLAUSIBLE",
  AMBIGUOUS_OR_UNPROVEN: "AMBIGUOUS / UNPROVEN",
});

function asSet(values) {
  return values instanceof Set
    ? values
    : new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean));
}

/**
 * Classify only the local physical operation evidence. This deliberately does
 * not consult hierarchy_status, structure_ok, or source_tree_proven: those
 * are global/catalog proof and cannot erase an exact physical ERP row.
 */
export function classifyLocalOperationBinding(operation, assignment, options = {}) {
  const allowedOrganizations = asSet(options.allowedJournalOrganizations);
  const expectedAccounts = unique(
    (assignment?.expected_accounts ?? []).map(normalizeAccountIdentity).filter(Boolean),
  );
  const expectedSides = unique((assignment?.expected_sides ?? []).map(text).filter(Boolean));
  const operationArticleKey = normalize(operation?.article);
  const targetArticleKeys = unique((assignment?.article_keys ?? []).map(normalize).filter(Boolean));
  const ownerCodes = unique((assignment?.owner_codes ?? []).map(text).filter(Boolean));
  const sourceAccount = sourceAccountIdentity(operation ?? {});
  const periodMatch = text(operation?.period) !== "" && text(operation?.period) === text(assignment?.period);
  const organizationPresent = text(operation?.organization) !== "";
  const organizationMatch = organizationPresent &&
    (allowedOrganizations.size === 0 || allowedOrganizations.has(text(operation.organization)));
  const articleMatch = operationArticleKey !== "" && targetArticleKeys.includes(operationArticleKey);
  const uniqueLocalOwner = ownerCodes.length === 1 && ownerCodes[0] === text(assignment?.code);
  const expectedAmountCents = Number.isFinite(Number(assignment?.expected_cents))
    ? Number(assignment.expected_cents)
    : cents(assignment?.expected);
  const expectedSourceAmountCents = unique(
    (assignment?.expected_source_amount_cents ?? [])
      .map((value) => Number(value))
      .filter(Number.isFinite),
  );
  const amountMatch = cents(operation?.amount) !== null &&
    (expectedSourceAmountCents.length > 0
      ? expectedSourceAmountCents.includes(cents(operation.amount))
      : expectedAmountCents !== null && cents(operation.amount) === expectedAmountCents);
  // When global ERP/catalog metadata does not expose an account, the local
  // journal row still proves its own account and side. If an expected account
  // is present, it must match exactly.
  const accountMatch = sourceAccount.account !== "" &&
    (expectedAccounts.length === 0 || (expectedAccounts.length === 1 && expectedAccounts[0] === sourceAccount.account));
  const sideMatch = sourceAccount.side !== "UNPROVEN_SIDE" &&
    (expectedSides.length === 0 || expectedSides.includes(sourceAccount.side));
  const physicalIdentity = hasExactPhysicalSourceIdentity(operation ?? {});

  const hardBlock = !periodMatch || !organizationMatch || !articleMatch || !uniqueLocalOwner;
  const proofLevel = hardBlock
    ? LOCAL_OPERATION_PROOF_LEVELS.AMBIGUOUS_OR_UNPROVEN
    : amountMatch && accountMatch && sideMatch && physicalIdentity
      ? LOCAL_OPERATION_PROOF_LEVELS.PROVEN
      : LOCAL_OPERATION_PROOF_LEVELS.PLAUSIBLE;

  const reasons = [];
  if (!periodMatch) reasons.push("PERIOD_MISMATCH");
  if (!organizationMatch) reasons.push("SOURCE_ORGANIZATION_MISMATCH");
  if (!articleMatch) reasons.push("ARTICLE_MISMATCH");
  if (!uniqueLocalOwner) reasons.push(ownerCodes.length > 1 ? "ARTICLE_OWNER_AMBIGUOUS" : "LOCAL_OWNER_UNPROVEN");
  if (!amountMatch) reasons.push("AMOUNT_NOT_EXACT");
  if (!accountMatch) reasons.push("ACCOUNT_NOT_EXACT");
  if (!sideMatch) reasons.push("ACCOUNT_SIDE_NOT_EXACT");
  if (!physicalIdentity) reasons.push("PHYSICAL_IDENTITY_INCOMPLETE");

  return {
    proof_level: proofLevel,
    local_operation_proven: proofLevel === LOCAL_OPERATION_PROOF_LEVELS.PROVEN,
    local_operation_plausible: proofLevel === LOCAL_OPERATION_PROOF_LEVELS.PLAUSIBLE,
    local_operation_ambiguous_or_unproven: proofLevel === LOCAL_OPERATION_PROOF_LEVELS.AMBIGUOUS_OR_UNPROVEN,
    period_match: periodMatch,
    source_organization_match: organizationMatch,
    article_match: articleMatch,
    local_owner_match: uniqueLocalOwner,
    amount_match: amountMatch,
    account_match: accountMatch,
    account_side_match: sideMatch,
    physical_identity_complete: physicalIdentity,
    reason_codes: reasons,
  };
}

function rowDeltaCents(row) {
  const intalev = cents(row?.intalev?.amount);
  const erp = cents(row?.erp?.amount);
  return intalev === null || erp === null ? null : intalev - erp;
}

/**
 * Select a journal row for the display/evidence contour. Exact article owners
 * narrow the contour when they are proven; an article with no proven owner is
 * still visible as a candidate. Visibility must not be used as an exact-proof
 * or economic-correction gate.
 */
export function isOperationEvidenceDisplayCandidate(operation, assignment, options = {}) {
  const operationArticleKey = normalize(operation?.article);
  const targetArticleKeys = unique((assignment?.article_keys ?? []).map(normalize).filter(Boolean));
  if (!operationArticleKey || !targetArticleKeys.includes(operationArticleKey)) return false;
  if (options.genericExactArticleBinding !== true) return true;
  const owners = options.owners instanceof Map ? options.owners : new Map();
  const ownerCodes = unique((owners.get(operationArticleKey) ?? []).map(text).filter(Boolean));
  return ownerCodes.length === 0 || ownerCodes.includes(text(assignment?.code));
}

export function detectCodeBasedPairCandidates(monthly, periods, tolerance) {
  const toleranceCents = Math.max(0, Math.round(Math.abs(Number(tolerance ?? 0.01)) * 100));
  const candidates = [];
  const byCodePeriod = new Map();
  for (const selectedPeriod of periods) {
    const month = monthly.find((item) => text(item?.period) === selectedPeriod);
    const financialRows = Array.isArray(month?.rows)
      ? month.rows.filter((row) => /^R\d{3}$/.test(text(row.code)))
      : [];
    const rowsByCode = new Map();
    const children = new Map();
    for (const row of financialRows) {
      const code = text(row.code);
      const list = rowsByCode.get(code) ?? [];
      list.push(row);
      rowsByCode.set(code, list);
      const parent = parentCode(row);
      if (parent) children.set(parent, [...(children.get(parent) ?? []), code]);
    }
    const leafCache = new Map();
    const descendantLeaves = (code, trail = new Set()) => {
      if (leafCache.has(code)) return leafCache.get(code);
      if (trail.has(code)) return null;
      const nextTrail = new Set(trail).add(code);
      const direct = unique(children.get(code) ?? []);
      if (direct.length === 0) return [code];
      const leaves = [];
      for (const child of direct) {
        const childLeaves = descendantLeaves(child, nextTrail);
        if (!childLeaves) return null;
        leaves.push(...childLeaves);
      }
      const result = unique(leaves);
      leafCache.set(code, result);
      return result;
    };
    const depthOf = (code) => {
      let depth = 0;
      let current = code;
      const seen = new Set();
      while (!seen.has(current)) {
        seen.add(current);
        const row = (rowsByCode.get(current) ?? [])[0];
        const parent = parentCode(row);
        if (!parent) break;
        depth += 1;
        current = parent;
      }
      return depth;
    };
    const coveredLeafCodes = new Set();
    const parents = [...children.keys()].sort((left, right) => depthOf(right) - depthOf(left));
    for (const parent of parents) {
      const parentRows = rowsByCode.get(parent) ?? [];
      const leafCodes = descendantLeaves(parent);
      if (parentRows.length !== 1 || !leafCodes || leafCodes.length < 2) continue;
      const leafRows = leafCodes.map((code) => rowsByCode.get(code) ?? []);
      if (leafRows.some((rows) => rows.length !== 1)) continue;
      const parentRow = parentRows[0];
      const leaves = leafRows.map((rows) => rows[0]);
      const parentDelta = rowDeltaCents(parentRow);
      const leafDeltas = leaves.map(rowDeltaCents);
      if (leafDeltas.some((value) => value === null)) continue;
      const fullLeafSum = leafDeltas.reduce((sum, value) => sum + value, 0);
      if (Math.abs(fullLeafSum) > toleranceCents) continue;
      if (
        parentDelta !== null &&
        (Math.abs(parentDelta) > toleranceCents || Math.abs(fullLeafSum - parentDelta) > toleranceCents)
      ) continue;
      const nonZero = leaves
        .map((row, index) => ({ code: text(row.code), delta_cents: leafDeltas[index] }))
        .filter(
          (member) =>
            !coveredLeafCodes.has(member.code) &&
            Math.abs(member.delta_cents) > toleranceCents,
        );
      const sourceCodes = nonZero.filter((member) => member.delta_cents < 0).map((member) => member.code);
      const targetCodes = nonZero.filter((member) => member.delta_cents > 0).map((member) => member.code);
      const memberSum = nonZero.reduce((sum, member) => sum + member.delta_cents, 0);
      if (
        nonZero.length < 2 ||
        sourceCodes.length === 0 ||
        targetCodes.length === 0 ||
        Math.abs(memberSum) > toleranceCents
      ) continue;
      const pairId = `PAIR-CAND-${selectedPeriod}-${parent}`;
      const candidate = {
        pair_id: pairId,
        period: selectedPeriod,
        parent_code: parent,
        descendant_leaf_codes: leafCodes,
        descendant_leaf_sum: fullLeafSum / 100,
        parent_delta: parentDelta === null ? null : parentDelta / 100,
        source_codes: sourceCodes,
        target_codes: targetCodes,
        member_deltas: nonZero.map((member) => ({
          code: member.code,
          delta: member.delta_cents / 100,
        })),
        status: "CANDIDATE_CODE_BASED_ZERO_SUM_GROUP",
        candidate_only: true,
        posting_rows: 0,
        ready_to_upload: false,
        release_allowed: false,
      };
      candidates.push(candidate);
      for (const code of [...sourceCodes, ...targetCodes]) coveredLeafCodes.add(code);
      for (const code of [...sourceCodes, ...targetCodes]) {
        byCodePeriod.set(`${selectedPeriod}|${code}`, candidate);
      }
    }

    const ancestorChain = (code) => {
      const result = [];
      const seen = new Set();
      let current = code;
      while (!seen.has(current)) {
        seen.add(current);
        const row = (rowsByCode.get(current) ?? [])[0];
        const parent = parentCode(row);
        if (!parent) break;
        result.push(parent);
        current = parent;
      }
      return result;
    };
    const commonZeroAncestor = (leftCode, rightCode) => {
      const rightAncestors = new Set(ancestorChain(rightCode));
      return ancestorChain(leftCode).find((code) => {
        if (!rightAncestors.has(code)) return false;
        const rows = rowsByCode.get(code) ?? [];
        const delta = rows.length === 1 ? rowDeltaCents(rows[0]) : null;
        return delta !== null && Math.abs(delta) <= toleranceCents;
      }) ?? null;
    };
    const unmatchedByAbsoluteDelta = new Map();
    for (const [code, codeRows] of rowsByCode.entries()) {
      if (codeRows.length !== 1 || (children.get(code) ?? []).length > 0 || coveredLeafCodes.has(code)) continue;
      const delta = rowDeltaCents(codeRows[0]);
      if (delta === null || Math.abs(delta) <= toleranceCents) continue;
      const key = Math.abs(delta);
      unmatchedByAbsoluteDelta.set(key, [
        ...(unmatchedByAbsoluteDelta.get(key) ?? []),
        { code, delta_cents: delta },
      ]);
    }
    for (const [absoluteDelta, members] of unmatchedByAbsoluteDelta.entries()) {
      const sources = members.filter((member) => member.delta_cents < 0);
      const targets = members.filter((member) => member.delta_cents > 0);
      if (sources.length !== 1 || targets.length !== 1) continue;
      const parent = commonZeroAncestor(sources[0].code, targets[0].code);
      if (!parent) continue;
      const pairId = `PAIR-CAND-${selectedPeriod}-${parent}-${sources[0].code}-${targets[0].code}`;
      const candidate = {
        pair_id: pairId,
        period: selectedPeriod,
        parent_code: parent,
        descendant_leaf_codes: [sources[0].code, targets[0].code],
        descendant_leaf_sum: 0,
        parent_delta: 0,
        source_codes: [sources[0].code],
        target_codes: [targets[0].code],
        member_deltas: [
          { code: sources[0].code, delta: -absoluteDelta / 100 },
          { code: targets[0].code, delta: absoluteDelta / 100 },
        ],
        status: "CANDIDATE_CODE_BASED_EQUAL_AND_OPPOSITE",
        candidate_only: true,
        posting_rows: 0,
        ready_to_upload: false,
        release_allowed: false,
      };
      candidates.push(candidate);
      for (const code of [sources[0].code, targets[0].code]) {
        coveredLeafCodes.add(code);
        byCodePeriod.set(`${selectedPeriod}|${code}`, candidate);
      }
    }
  }
  return { candidates, byCodePeriod };
}

function safeGates(overrides = {}) {
  return {
    report_only: true,
    source_binding_verified: false,
    erp_sources_verified: false,
    journal_verified: false,
    operation_coverage_complete: false,
    candidate_rows_excluded_from_totals: true,
    correction_operation_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    release_status: RELEASE_STATUS,
    ...overrides,
    report_only: true,
    source_binding_verified: false,
    operation_coverage_complete: false,
    correction_operation_rows: 0,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

function baseResult({ status, organization, mode, period, periods }) {
  return {
    schema: RESULT_SCHEMA,
    status,
    applicable: true,
    input: { organization, mode, period, periods: [...periods] },
    manifest_verified: false,
    journal_verified: false,
    source_operation_proof_verified: false,
    journal_sha256: null,
    journal_sheet: null,
    source_contributor_rows: 0,
    display_operation_rows: 0,
    exact_bound_operation_rows: 0,
    exact_bound_r_codes: [],
    candidate_excluded_rows: 0,
    economic_correction_proven_rows: 0,
    new_pair_candidates: 0,
    pair_analysis_status: "BLOCKED_PAIR_ANALYSIS_NOT_PERFORMED",
    pair_candidates: [],
    correction_operation_rows: 0,
    posting_rows: 0,
    report_only: true,
    ready_to_upload: false,
    release_allowed: false,
    rows: [],
    unassigned_rows: [],
    node_evidence: [],
    leaf_totals: {},
    proven_r_codes: [],
    blocked_direct_leaf_nodes: [],
    proven_r_code_count: 0,
    operation_bearing_terminal_rows: 0,
    operation_coverage_complete: false,
    counts: {
      journal_rows: 0,
      selected_period_rows: 0,
      active_fact_rows: 0,
      missing_amount_rows: 0,
      terminal_direct_nodes: 0,
      source_contributor_rows: 0,
      candidate_excluded_rows: 0,
      economic_correction_proven_rows: 0,
      display_operation_rows: 0,
      exact_bound_operation_rows: 0,
      unassigned_operation_rows: 0,
      correction_operation_rows: 0,
      posting_rows: 0,
    },
    gates: safeGates(),
    source_trace: null,
  };
}

export function buildOperationDisplayRow(
  operation,
  assignment,
  proven,
  displayOrder,
  allowedJournalOrganizations = new Set(),
  exactArticleBound = false,
  localBinding = null,
) {
  const accountIdentity = sourceAccountIdentity(operation);
  const organizationAllowed = allowedJournalOrganizations.size === 0 || allowedJournalOrganizations.has(text(operation.organization));
  const binding = localBinding ?? classifyLocalOperationBinding(
    operation,
    assignment,
    { allowedJournalOrganizations },
  );
  const sourceOperationProven = binding.local_operation_proven === true ||
    (exactArticleBound && hasExactPhysicalSourceIdentity(operation));
  const economicCorrectionProven = sourceOperationProven && proven;
  const articleCandidateBound = normalize(operation.article) !== "" &&
    (assignment.article_keys ?? []).includes(normalize(operation.article));
  const pair = assignment.pair_candidate ?? null;
  const pairRole = pair?.source_codes?.includes(assignment.code)
    ? "STORNO_SOURCE_CANDIDATE"
    : pair?.target_codes?.includes(assignment.code)
      ? "REPOST_TARGET_CANDIDATE"
      : null;
  return {
    ...operation,
    parent_code: assignment.code,
    period: assignment.period,
    evidence_status: economicCorrectionProven
      ? "ECONOMIC_CORRECTION_PROVEN"
      : sourceOperationProven
        ? "SOURCE_OPERATION_PROVEN"
        : "CANDIDATE_EXCLUDED",
    // row_class remains the economic/totals classification. Physical source
    // proof is intentionally independent and is carried by source_proof_status.
    row_class: economicCorrectionProven ? "SOURCE_CONTRIBUTOR" : "CANDIDATE_EXCLUDED",
    proof_status: economicCorrectionProven
      ? "ECONOMIC_CORRECTION_PROVEN"
      : sourceOperationProven
        ? "SOURCE_OPERATION_PROVEN"
        : "CANDIDATE_NOT_PROVEN",
    source_proof_status: sourceOperationProven
      ? "SOURCE_OPERATION_PROVEN"
      : "SOURCE_OPERATION_UNPROVEN",
    local_operation_proof_level: sourceOperationProven
      ? LOCAL_OPERATION_PROOF_LEVELS.PROVEN
      : binding.proof_level,
    local_operation_binding_status: binding.proof_level,
    local_operation_binding_reason: binding.reason_codes.join(",") || null,
    local_operation_binding_checks: {
      period_match: binding.period_match,
      source_organization_match: binding.source_organization_match,
      article_match: binding.article_match,
      local_owner_match: binding.local_owner_match,
      amount_match: binding.amount_match,
      account_match: binding.account_match,
      account_side_match: binding.account_side_match,
      physical_identity_complete: binding.physical_identity_complete,
    },
    economic_proof_status: economicCorrectionProven
      ? "ECONOMIC_CORRECTION_PROVEN"
      : "ECONOMIC_CORRECTION_UNPROVEN",
    exact_article_bound: sourceOperationProven,
    exact_article_key: sourceOperationProven ? normalize(operation.article) : null,
    article_candidate_bound: articleCandidateBound,
    article_candidate_key: articleCandidateBound ? normalize(operation.article) : null,
    exact_bound_r_code: sourceOperationProven ? assignment.code : null,
    source_operation_proven: sourceOperationProven,
    source_operation_identity: sourceOperationProven ? sourceOperationIdentity(operation) : null,
    economic_correction_proven: economicCorrectionProven,
    display_order: displayOrder,
    display_depth_offset: 1,
    count_in_parent: economicCorrectionProven,
    count_in_r002: false,
    excluded_from_totals: !economicCorrectionProven,
    reason: economicCorrectionProven
      ? "Точная статья, утверждённый счёт и организация; полная группа журнала равна строке ERP ОПИУ."
      : sourceOperationProven
        ? "Физическая строка ERP доказана точными SHA, листом/диапазоном, регистратором, организацией, Дт/Кт, аналитиками и суммой; экономический маршрут остаётся только для проверки."
        : assignment.blocker,
    comment: [
      `Period=${assignment.period}`,
      `ERPExpected=${assignment.expected ?? "MISSING"}`,
      `ArticleOwners=${assignment.owner_codes.join(",") || assignment.code}`,
      `ExpectedAccounts=${assignment.expected_accounts.join(",") || "MISSING"}`,
      `AccountSignature=${accountIdentity.key}`,
      `OrganizationAllowed=${organizationAllowed}`,
      pair ? `PairCandidate=${pair.pair_id}` : "PairCandidate=NONE",
      pair ? `SourceCodes=${pair.source_codes.join(",")}` : "",
      pair ? `TargetCodes=${pair.target_codes.join(",")}` : "",
      exactArticleBound ? `ExactArticleBound=${assignment.code}` : "",
      sourceOperationProven ? "SOURCE_OPERATION_PROVEN" : "SOURCE_OPERATION_UNPROVEN",
      economicCorrectionProven ? "ECONOMIC_CORRECTION_PROVEN; COUNT_IN_PARENT=true" : "ECONOMIC_CORRECTION_UNPROVEN; EXCLUDED_FROM_TOTAL",
      sourceOperationProven ? "posting_rows=0; correction_operation_rows=0" : "",
    ].join("; "),
    pair_id: pair?.pair_id ?? null,
    upload_id: null,
    pair_role: pairRole,
    pair_status: pair ? "CANDIDATE_REVIEW_REQUIRED" : null,
    partner_range: pair
      ? `SOURCE_CODES:${pair.source_codes.join(",")}; TARGET_CODES:${pair.target_codes.join(",")}`
      : null,
    pair_analysis_status: pair
      ? pair.status
      : "BLOCKED_PAIR_ANALYSIS_NOT_APPLICABLE",
  };
}

export function buildUnassignedOperationRow(operation, period) {
  return {
    ...operation,
    period,
    parent_code: null,
    evidence_status: "CANDIDATE_EXCLUDED",
    row_class: "CANDIDATE_EXCLUDED",
    proof_status: "CANDIDATE_NOT_ASSIGNED_TO_R_CODE",
    count_in_parent: false,
    count_in_r002: false,
    excluded_from_totals: true,
    reason: "Строка журнала относится к выбранной организации и периоду, но точная связь с R-кодом ОПИУ не доказана.",
    comment: "CANDIDATE_EXCLUDED; UNASSIGNED_TO_R_CODE; EXCLUDED_FROM_TOTAL; posting_rows=0",
    pair_id: null,
    upload_id: null,
    pair_role: null,
    pair_status: null,
    partner_range: null,
    pair_analysis_status: "BLOCKED_PAIR_ANALYSIS_NOT_APPLICABLE",
  };
}

export async function loadArbitraryPeriodOperationEvidence(options = {}) {
  const organization = text(options.organization);
  const mode = text(options.mode).toLowerCase();
  const period = text(options.period);
  const periods = Array.isArray(options.periods) ? options.periods.map(text).filter(Boolean) : [];
  const allowedJournalOrganizations = new Set(
    (Array.isArray(options.allowedJournalOrganizations)
      ? options.allowedJournalOrganizations
      : [])
      .map(text)
      .filter(Boolean),
  );
  const operationBearingCodes = new Set(
    (Array.isArray(options.operationBearingCodes)
      ? options.operationBearingCodes
      : DEFAULT_UK_OPERATION_BEARING_CODES)
      .map(text)
      .filter((value) => /^R\d{3}$/.test(value)),
  );
  const includeUnassignedRows = options.includeUnassignedRows === true;
  const genericExactArticleBinding = options.genericExactArticleBinding === true;
  const result = baseResult({
    status: "BLOCKED_GENERIC_OPERATION_EVIDENCE",
    organization,
    mode,
    period,
    periods,
  });

  try {
    const expected = expectedPeriods(mode, period);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(periods)) {
      throw new Error(`BLOCKED_OPERATION_PERIOD_SCOPE: ${mode}/${period} does not equal ${JSON.stringify(periods)}`);
    }
    if (operationBearingCodes.size === 0) {
      throw new Error("BLOCKED_OPERATION_CODE_SCOPE: operation-bearing R-codes are required");
    }

    const sourceSets = Array.isArray(options.sourceSets) ? options.sourceSets : [];
    if (sourceSets.length !== periods.length) {
      throw new Error(`BLOCKED_OPERATION_SOURCE_SCOPE: expected ${periods.length} source bindings, got ${sourceSets.length}`);
    }
    const byPeriod = new Map();
    const authorityShaByPath = new Map();
    for (const source of sourceSets) {
      const sourcePeriod = text(source.period);
      if (!periods.includes(sourcePeriod) || byPeriod.has(sourcePeriod)) {
        throw new Error(`BLOCKED_OPERATION_SOURCE_BIJECTION: invalid or duplicate binding ${sourcePeriod || "MISSING"}`);
      }
      const rawJournalPath = text(source.journalPath);
      const expectedJournalSha = text(source.journalExpectedSha256).toUpperCase();
      const rawErpOpiuPath = text(source.erpOpiuPath);
      const expectedErpSha = text(source.erpOpiuExpectedSha256).toUpperCase();
      const rawAuthorityPath = text(source.erpInputAuthorityPath);
      const expectedAuthoritySha = text(source.erpInputAuthoritySha256).toUpperCase();
      if (
        !rawJournalPath ||
        !/^[0-9A-F]{64}$/.test(expectedJournalSha) ||
        !rawErpOpiuPath ||
        !expectedErpSha ||
        !rawAuthorityPath ||
        !expectedAuthoritySha
      ) {
        throw new Error(`BLOCKED_OPERATION_SOURCE_BINDING: incomplete binding for ${sourcePeriod}`);
      }
      const journalPath = path.resolve(rawJournalPath);
      const erpOpiuPath = path.resolve(rawErpOpiuPath);
      const authorityPath = path.resolve(rawAuthorityPath);
      const journalOriginInput = text(source?.journalOrigin?.inputPath);
      const journalOriginSha = text(source?.journalOrigin?.sha256).toUpperCase();
      const erpOpiuOriginInput = text(source?.erpOpiuOrigin?.inputPath);
      if (!/^[0-9A-F]{64}$/.test(journalOriginSha) || journalOriginSha !== expectedJournalSha) {
        throw new Error(`BLOCKED_OPERATION_JOURNAL_SOURCE_METADATA_MISMATCH: ${sourcePeriod}`);
      }
      if (
        !journalOriginInput ||
        !erpOpiuOriginInput ||
        path.resolve(journalOriginInput).toLocaleLowerCase("ru-RU") !== authorityPath.toLocaleLowerCase("ru-RU") ||
        path.resolve(erpOpiuOriginInput).toLocaleLowerCase("ru-RU") !== authorityPath.toLocaleLowerCase("ru-RU")
      ) {
        throw new Error(`BLOCKED_OPERATION_SOURCE_ORIGIN_MISMATCH: ${sourcePeriod}`);
      }
      if (!authorityShaByPath.has(authorityPath)) {
        authorityShaByPath.set(authorityPath, await sha256File(authorityPath));
      }
      const actualAuthoritySha = authorityShaByPath.get(authorityPath);
      if (actualAuthoritySha !== expectedAuthoritySha) {
        throw new Error(
          `BLOCKED_OPERATION_ERP_INPUT_HASH_DRIFT: ${sourcePeriod} expected ${expectedAuthoritySha}, got ${actualAuthoritySha}`,
        );
      }
      const actualErpSha = await sha256File(erpOpiuPath);
      if (actualErpSha !== expectedErpSha) {
        throw new Error(`BLOCKED_OPERATION_ERP_HASH_DRIFT: ${sourcePeriod} expected ${expectedErpSha}, got ${actualErpSha}`);
      }
      byPeriod.set(sourcePeriod, {
        ...source,
        journalPath,
        erpOpiuPath,
        authorityPath,
        expectedJournalSha,
        journalOriginSha,
        actualAuthoritySha,
        actualErpSha,
      });
    }

    const journalByPath = new Map();
    for (const source of byPeriod.values()) {
      if (!journalByPath.has(source.journalPath)) {
        journalByPath.set(
          source.journalPath,
          await readOperationJournalRows({ journalPath: source.journalPath, sheet: "Лист_1" }),
        );
      }
    }
    const journals = [...journalByPath.values()];
    for (const [sourcePeriod, source] of byPeriod.entries()) {
      const journal = journalByPath.get(source.journalPath);
      if (journal.journal_sha256 !== source.expectedJournalSha) {
        throw new Error(
          `BLOCKED_OPERATION_JOURNAL_HASH_DRIFT: ${sourcePeriod} expected ${source.expectedJournalSha}, got ${journal.journal_sha256}`,
        );
      }
    }
    result.journal_sha256 = journals.length === 1
      ? journals[0].journal_sha256
      : `MULTI:${sha256(Buffer.from(journals.map((journal) => journal.journal_sha256).sort().join("|"), "utf8"))}`;
    result.journal_sheet = journals.length === 1 ? journals[0].journal_sheet : "MULTI";
    result.counts.journal_rows = journals.reduce((sum, journal) => sum + journal.rows.length, 0);

    const activeRowsByPeriod = new Map();
    const missingAmountsByPeriod = new Map();
    const selectedSourceRowIds = new Set();
    for (const selectedPeriod of periods) {
      const source = byPeriod.get(selectedPeriod);
      const journal = journalByPath.get(source.journalPath);
      const periodRows = journal.rows.filter((row) => row.period === selectedPeriod);
      const selectedRows = periodRows
        .filter((row) => allowedJournalOrganizations.size === 0 || allowedJournalOrganizations.has(text(row.organization)))
        .map((row) => ({
          ...row,
          journal_sha256: journal.journal_sha256,
          journal_source: journal.source,
          journal_sheet: journal.journal_sheet,
          erp_input_sha256: source.actualAuthoritySha,
          erp_opiu_sha256: source.actualErpSha,
          journal_input_path: source.journalOrigin.inputPath,
          journal_archive_entry: source.journalOrigin.archiveEntry ?? null,
          journal_source_kind: source.journalOrigin.sourceKind ?? null,
        }));
      if (selectedRows.length === 0) {
        throw new Error(`BLOCKED_OPERATION_JOURNAL_EMPTY_SCOPE: ${selectedPeriod}`);
      }
      const activeFactRows = selectJournalRowsForExactProfile(
        selectedRows,
        selectedPeriod,
        [...allowedJournalOrganizations],
      );
      const missingAmounts = activeFactRows.filter((row) => cents(row.amount) === null);
      const activeRows = activeFactRows;
      if (activeRows.length === 0) {
        throw new Error(`BLOCKED_OPERATION_JOURNAL_NO_ACTIVE_FACT: ${selectedPeriod}`);
      }
      for (const row of activeRows) {
        if (selectedSourceRowIds.has(row.source_row_id)) {
          throw new Error(`BLOCKED_OPERATION_SOURCE_ROW_DUPLICATE: ${row.source_row_id}`);
        }
        selectedSourceRowIds.add(row.source_row_id);
      }
      activeRowsByPeriod.set(selectedPeriod, activeRows);
      missingAmountsByPeriod.set(selectedPeriod, missingAmounts);
      result.counts.selected_period_rows += selectedRows.length;
      result.counts.active_fact_rows += activeRows.length;
      result.counts.missing_amount_rows += missingAmounts.length;
    }

    const monthly = Array.isArray(options.resolvedRowsByPeriod) ? options.resolvedRowsByPeriod : [];
    const monthlyByPeriod = new Map(monthly.map((month) => [text(month.period), month]));
    const pairReview = detectCodeBasedPairCandidates(
      monthly,
      periods,
      Number(options.tolerance ?? 0.01),
    );
    const assignments = [];
    const computedNodeEvidence = [];
    const provenParentAccountFlowProofs = [];
    for (const selectedPeriod of periods) {
      const month = monthlyByPeriod.get(selectedPeriod);
      if (!month || !Array.isArray(month.rows)) {
        throw new Error(`BLOCKED_OPERATION_MONTH_RESOLUTION_MISSING: ${selectedPeriod}`);
      }
      const financialRows = month.rows.filter((row) => /^R\d{3}$/.test(text(row.code)));
      const accountFlowProof = classifyProvenParentAccountFlows({
        financialRows,
        activeRows: activeRowsByPeriod.get(selectedPeriod) ?? [],
        period: selectedPeriod,
        allowedJournalOrganizations,
        tolerance: Number(options.tolerance ?? 0.01),
      });
      if (accountFlowProof.status !== "NOT_APPLICABLE_NO_PROVEN_PARENT_COMPOSITION") {
        provenParentAccountFlowProofs.push(accountFlowProof);
      }
      const children = new Map();
      for (const row of financialRows) {
        const parent = parentCode(row);
        if (!parent) continue;
        const list = children.get(parent) ?? [];
        list.push(text(row.code));
        children.set(parent, list);
      }
      const terminal = financialRows.filter((row) => !(children.get(text(row.code))?.length));
      const directTargets = [];
      for (const row of terminal) {
        if (!operationBearingCodes.has(text(row.code))) {
          computedNodeEvidence.push({
            code: text(row.code),
            period: selectedPeriod,
            node_kind: "COMPUTED_NO_DIRECT_OPERATION",
            node_status: "NO_DIRECT_OPERATION_COMPUTED",
            expected_erp_amount: cents(row?.erp?.amount) === null ? null : Number(row.erp.amount),
          });
        }
      }
      for (const code of operationBearingCodes) {
        const matches = financialRows.filter((candidate) => text(candidate.code) === code);
        const row = matches[0] ?? null;
        const leaves = row ? exactTraceLeaves(row, selectedPeriod) : [];
        const childCodes = row ? (children.get(code) ?? []) : [];
        const structureOk =
          matches.length === 1 &&
          childCodes.length === 0 &&
          ["PASS", "LEAF"].includes(text(row?.hierarchy_status));
        directTargets.push({
          code,
          period: selectedPeriod,
          expected: cents(row?.erp?.amount) === null ? null : Number(row.erp.amount),
          expected_cents: cents(row?.erp?.amount),
          erp_status: text(row?.erp?.status),
          structure_ok: structureOk,
          structure_blocker: matches.length !== 1
            ? `Ожидалась одна строка ${code}, найдено ${matches.length}.`
            : childCodes.length > 0
              ? `Строка ${code} не конечная; дочерние коды: ${childCodes.join(", ")}.`
              : !["PASS", "LEAF"].includes(text(row?.hierarchy_status))
                ? `Иерархия ${code} не доказана: ${text(row?.hierarchy_status) || "MISSING"}.`
                : null,
          leaves,
          article_keys: unique(leaves.map((leaf) => leaf.article_key).filter(Boolean)),
          exact_bindable_article_keys:
            ["MATCHED", "ZERO_NO_ACTIVITY"].some((status) => text(row?.erp?.status).startsWith(status))
            ? unique(
                leaves
                  .map((leaf) => leaf.article_key)
                  .filter(Boolean),
              )
            : [],
          expected_accounts: unique(leaves.map((leaf) => text(leaf.expected_account)).filter(Boolean)),
          expected_source_amount_cents: unique(
            leaves
              .map((leaf) => cents(leaf.source_amount))
              .filter((amount) => amount !== null),
          ),
        });
      }

      const owners = new Map();
      for (const target of directTargets) {
        const ownedArticleKeys = genericExactArticleBinding
          ? target.exact_bindable_article_keys
          : target.article_keys;
        for (const articleKey of ownedArticleKeys) {
          const list = owners.get(articleKey) ?? [];
          list.push(target.code);
          owners.set(articleKey, unique(list));
        }
      }

      for (const target of directTargets) {
        const ownerCodes = unique(target.article_keys.flatMap((articleKey) => owners.get(articleKey) ?? []));
        const ambiguousArticles = target.article_keys.filter((articleKey) => (owners.get(articleKey) ?? []).length !== 1);
        const candidates = (activeRowsByPeriod.get(selectedPeriod) ?? []).filter((operation) =>
          isOperationEvidenceDisplayCandidate(operation, target, {
            genericExactArticleBinding,
            owners,
          }),
        );
        const targetMissingAmounts = candidates.filter((row) => cents(row.amount) === null);
        const proven = false;
        const selectedIds = new Set();
        const localBindings = new Map(
          candidates.map((operation) => [
            operation.source_row_id,
            classifyLocalOperationBinding(
              operation,
              {
                ...target,
                // Ownership is per article, not per target's complete leaf
                // set. A target with two distinct articles must not make each
                // otherwise unique article look ambiguous.
                owner_codes: owners.get(normalize(operation.article)) ?? [],
              },
              { allowedJournalOrganizations },
            ),
          ]),
        );
        const blocker = !target.structure_ok
          ? target.structure_blocker
          : target.expected_cents === null
          ? "ERP-сумма конечной строки не доказана."
          : !(target.erp_status === "MATCHED" || target.erp_status.startsWith("ZERO_NO_ACTIVITY"))
            ? `Статус ERP не допускает доказательство операций: ${target.erp_status || "MISSING"}.`
          : target.leaves.length === 0
            ? "Нет точного ERP trace до исходной статьи."
            : target.leaves.some((leaf) => leaf.source_tree_proven !== true)
              ? "Дерево исходных статей ERP не доказано полностью."
            : ambiguousArticles.length > 0
              ? `Статья ERP принадлежит нескольким конечным строкам: ${ownerCodes.join(", ")}.`
              : target.article_keys.length !== 1
                ? "Конечная строка содержит несколько исходных статей; автоматическое распределение запрещено."
                : target.expected_accounts.length !== 1
                  ? "В ERP trace отсутствует один утверждённый счёт статьи."
                  : targetMissingAmounts.length > 0
                    ? `В журнале отсутствует сумма у операций строк ${targetMissingAmounts.map((row) => row.physical_row).join(", ")}; ветвь оставлена кандидатом.`
                    : "Автосопоставление статьи и счёта требует утверждённого account/side manifest; операции показаны только как кандидаты."
        assignments.push({
          ...target,
          owner_codes: ownerCodes,
          candidates,
          selected_ids: selectedIds,
          local_bindings: localBindings,
          exact_bound_ids: new Set(
            [...localBindings.entries()]
              .filter(([, binding]) => binding.local_operation_proven === true)
              .map(([sourceRowId]) => sourceRowId),
          ),
          proven,
          zero_without_operations: false,
          missing_amount_source_row_ids: targetMissingAmounts.map((row) => row.source_row_id),
          pair_candidate: pairReview.byCodePeriod.get(`${selectedPeriod}|${target.code}`) ?? null,
          blocker,
        });
      }
    }

    const canonicalOwner = new Map();
    for (const assignment of assignments) {
      for (const operation of assignment.candidates) {
        const current = canonicalOwner.get(operation.source_row_id);
        if (!current || Number(assignment.code.slice(1)) < Number(current.code.slice(1))) {
          canonicalOwner.set(operation.source_row_id, assignment);
        }
      }
    }

    const rows = [];
    const nodeEvidence = [...computedNodeEvidence];
    const periodOrder = new Map(periods.map((value, index) => [value, index]));
    for (const assignment of assignments) {
      let provenRows = 0;
      let candidateRows = 0;
      const sharedCandidateIds = [];
      for (const operation of assignment.candidates) {
        if (canonicalOwner.get(operation.source_row_id) !== assignment) {
          sharedCandidateIds.push(operation.source_row_id);
          continue;
        }
        const proven = assignment.proven && assignment.selected_ids.has(operation.source_row_id);
        const exactArticleBound = assignment.exact_bound_ids.has(operation.source_row_id);
        const localBinding = assignment.local_bindings?.get(operation.source_row_id) ?? null;
        if (proven) provenRows += 1;
        else candidateRows += 1;
        rows.push(buildOperationDisplayRow(
          operation,
          assignment,
          proven,
          (periodOrder.get(assignment.period) ?? 0) * 1_000_000 + Number(operation.physical_row),
          allowedJournalOrganizations,
          exactArticleBound,
          localBinding,
        ));
      }
      nodeEvidence.push({
        code: assignment.code,
        period: assignment.period,
        node_kind: "DIRECT_LEAF",
        node_status: assignment.proven
          ? assignment.zero_without_operations
            ? "PROVEN_ZERO_NO_DIRECT_OPERATION"
            : "PROVEN"
          : "CANDIDATE_EXCLUDED",
        expected_erp_amount: assignment.expected,
        proven_amount: assignment.proven && !assignment.zero_without_operations
          ? assignment.candidates
              .filter((row) => assignment.selected_ids.has(row.source_row_id))
              .reduce((sum, row) => sum + Number(row.amount), 0)
          : assignment.zero_without_operations ? 0 : null,
        proven_rows: provenRows,
        candidate_excluded_rows: candidateRows,
        shared_candidate_source_row_ids: sharedCandidateIds,
        article_keys: assignment.article_keys,
        expected_accounts: assignment.expected_accounts,
        missing_amount_source_row_ids: assignment.missing_amount_source_row_ids,
        exact_bound_rows: assignment.exact_bound_ids.size,
        exact_bound_source_row_ids: [...assignment.exact_bound_ids],
        blocker: assignment.proven ? null : assignment.blocker,
      });
    }

    const exactAccountFlowRows = provenParentAccountFlowProofs
      .filter((proof) => proof.status === "PROVEN_PARENT_ACCOUNT_FLOWS")
      .flatMap((proof) => proof.flows.flatMap((flow) => [
        ...flow.operational_rows.map((operation) =>
          buildR005ExactAccountFlowDisplayRow(operation, flow, "OPERATIONAL_CONSUMED_ONCE", Number(operation.physical_row))),
        ...flow.closing_rows.map((operation) =>
          buildR005ExactAccountFlowDisplayRow(operation, flow, "CLOSING_NON_ADDITIVE", Number(operation.physical_row))),
      ]));
    const exactAccountFlowSourceRowIds = new Set(
      exactAccountFlowRows.map((row) => text(row.source_row_id)),
    );
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (exactAccountFlowSourceRowIds.has(text(rows[index].source_row_id))) rows.splice(index, 1);
    }
    rows.push(...exactAccountFlowRows);
    for (const proof of provenParentAccountFlowProofs) {
      nodeEvidence.push(...provenParentAccountFlowNodeEvidence(proof));
    }

    const unassignedRows = includeUnassignedRows
      ? periods.flatMap((selectedPeriod) =>
          (activeRowsByPeriod.get(selectedPeriod) ?? [])
            .filter((operation) =>
              !canonicalOwner.has(operation.source_row_id) &&
              !exactAccountFlowSourceRowIds.has(text(operation.source_row_id)))
            .map((operation) => buildUnassignedOperationRow(operation, selectedPeriod)),
        )
      : [];
    const sourceRows = rows.filter((row) => row.source_operation_proven === true);
    const economicRows = rows.filter((row) => row.economic_correction_proven === true);
    const exactBoundRows = rows.filter((row) => row.exact_article_bound === true);
    const candidateRows = rows.filter((row) => row.economic_correction_proven !== true);
    const allCandidateRows = [...candidateRows, ...unassignedRows];
    const directEvidence = nodeEvidence.filter((entry) => entry.node_kind === "DIRECT_LEAF");
    const byCode = new Map();
    for (const evidence of directEvidence) {
      const list = byCode.get(evidence.code) ?? [];
      list.push(evidence);
      byCode.set(evidence.code, list);
    }
    const provenCodes = [...byCode.entries()]
      .filter(([, evidence]) => evidence.length === periods.length && evidence.every((entry) => entry.node_status.startsWith("PROVEN")))
      .map(([code]) => code)
      .sort();
    const blockedCodes = [...byCode.entries()]
      .filter(([, evidence]) => evidence.length !== periods.length || evidence.some((entry) => !entry.node_status.startsWith("PROVEN")))
      .map(([code]) => code)
      .sort();

    result.status = "BLOCKED_GENERIC_OPERATION_EVIDENCE_REVIEW_REQUIRED";
    result.pair_analysis_status = pairReview.candidates.length > 0
      ? "CANDIDATE_CODE_BASED_ZERO_SUM_GROUPS_FOUND"
      : "NO_CODE_BASED_ZERO_SUM_GROUP_CANDIDATES";
    result.pair_candidates = pairReview.candidates;
    result.new_pair_candidates = pairReview.candidates.length;
    result.proven_parent_account_flows = provenParentAccountFlowProofs;
    result.rows = rows.sort((left, right) => left.display_order - right.display_order);
    result.unassigned_rows = unassignedRows.sort(
      (left, right) =>
        (periodOrder.get(left.period) ?? 0) - (periodOrder.get(right.period) ?? 0) ||
        Number(left.physical_row) - Number(right.physical_row),
    );
    result.node_evidence = nodeEvidence;
    result.source_contributor_rows = sourceRows.length;
    result.source_operation_proof_verified = sourceRows.length > 0;
    result.candidate_excluded_rows = allCandidateRows.length;
    result.economic_correction_proven_rows = economicRows.length;
    result.display_operation_rows = rows.length + unassignedRows.length;
    result.exact_bound_operation_rows = exactBoundRows.length;
    result.exact_bound_r_codes = unique(exactBoundRows.map((row) => row.parent_code)).sort();
    result.proven_r_codes = provenCodes;
    result.blocked_direct_leaf_nodes = blockedCodes;
    result.proven_r_code_count = provenCodes.length;
    result.operation_bearing_terminal_rows = directEvidence.length;
    result.operation_coverage_complete = false;
    for (const code of byCode.keys()) {
      result.leaf_totals[code] = economicRows
        .filter((row) => row.parent_code === code)
        .reduce((sum, row) => sum + Number(row.amount), 0);
    }
    Object.assign(result.counts, {
      terminal_direct_nodes: directEvidence.length,
      source_contributor_rows: sourceRows.length,
      candidate_excluded_rows: allCandidateRows.length,
      economic_correction_proven_rows: economicRows.length,
      display_operation_rows: rows.length + unassignedRows.length,
      exact_bound_operation_rows: exactBoundRows.length,
      unassigned_operation_rows: unassignedRows.length,
    });
    result.gates = safeGates({
      erp_sources_verified: true,
      journal_verified: true,
      candidate_rows_excluded_from_totals: allCandidateRows.every(
        (row) => row.count_in_parent === false && row.excluded_from_totals === true,
      ),
    });
    result.journal_verified = true;
    result.source_trace = {
      strategy: "MONTH_FIRST_EXACT_ARTICLE_ACCOUNT_ORGANIZATION_GROUP",
      review_required: true,
      pair_candidate_rule: "MONTH_FIRST_CODE_BASED_ZERO_SUM_GROUP_CANDIDATE_ONLY",
      selected_periods: periods,
      period_blockers: periods
        .map((selectedPeriod) => ({
          period: selectedPeriod,
          code: "BLOCKED_OPERATION_JOURNAL_AMOUNT_MISSING",
          source_row_ids: (missingAmountsByPeriod.get(selectedPeriod) ?? []).map((row) => row.source_row_id),
          physical_rows: (missingAmountsByPeriod.get(selectedPeriod) ?? []).map((row) => row.physical_row),
        }))
        .filter((entry) => entry.source_row_ids.length > 0),
      allowed_journal_organizations: [...allowedJournalOrganizations],
      organization_scope: allowedJournalOrganizations.size > 0
        ? "EXPLICIT_SOURCE_SCOPE"
        : "ALL_ACCOUNTING_ORGANIZATIONS_PRESENT_IN_VERIFIED_ERP_JOURNAL",
      operation_bearing_codes: [...operationBearingCodes],
      generic_exact_article_binding: genericExactArticleBinding,
      source_operation_proof_status: sourceRows.length > 0
        ? "SOURCE_OPERATION_PROVEN"
        : "SOURCE_OPERATION_UNPROVEN",
      source_operation_proven_rows: sourceRows.length,
      economic_correction_proven_rows: economicRows.length,
      exact_bound_operation_rows: exactBoundRows.length,
      exact_bound_r_codes: result.exact_bound_r_codes,
      unassigned_rows_in_separate_safe_contour: includeUnassignedRows,
      journals: journals.map((journal) => ({
        path: journal.source,
        sha256: journal.journal_sha256,
        sheet: journal.journal_sheet,
        header_row: journal.header_row,
        data_bounds: `B${journal.data_first_row}:AG${journal.data_last_row}`,
        ooxml_dimension: journal.ooxml_dimension,
      })),
      source_bindings: periods.map((selectedPeriod) => {
        const source = byPeriod.get(selectedPeriod);
        const journal = journalByPath.get(source.journalPath);
        return {
          period: selectedPeriod,
          journal_path: source.journalPath,
          journal_sha256: journal.journal_sha256,
          journal_input_path: source.journalOrigin.inputPath,
          journal_archive_entry: source.journalOrigin.archiveEntry ?? null,
          erp_opiu_path: source.erpOpiuPath,
          erp_opiu_sha256: source.actualErpSha,
          erp_opiu_input_path: source.erpOpiuOrigin.inputPath,
          erp_opiu_archive_entry: source.erpOpiuOrigin.archiveEntry ?? null,
          erp_input_authority_path: source.authorityPath,
          erp_input_authority_sha256: source.actualAuthoritySha,
        };
      }),
    };
    return result;
  } catch (error) {
    result.status = text(error?.message).split(":")[0] || "BLOCKED_GENERIC_OPERATION_EVIDENCE";
    result.error = { message: error?.message ?? String(error) };
    result.gates = safeGates();
    return result;
  }
}
