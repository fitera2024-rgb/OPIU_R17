import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import {
  assessConfiguredStructuralControlGroups,
  isOwnerPresentationBlockExempt,
  ownerPresentationBlockExemption,
} from "../../reconciliation/source/owner_presentation_block_exemption.mjs";
import {
  structuralControlGroupForCode,
  structuralControlGroupsFromConfig,
} from "../../reconciliation/source/structural_control_groups.mjs";

export const CORRECTION_REGISTRY_SHEETS = Object.freeze([
  "00_Паспорт",
  "01_Месяцы",
  "02_Пары",
  "03_Удаления",
  "04_Блокеры",
  "05_Источники",
]);

export const DISCREPANCY_REGISTRY_SHEETS = Object.freeze([
  "Реестр",
  "Детали_проводок",
  "Источники_QA",
]);

export const AUDIT_REGISTRY_FILENAME_CONTRACT = Object.freeze({
  correction_registry: "Реестр_корректировок_ОПИУ_{period}_R001.xlsx",
  discrepancy_registry: "Реестр_проводок_расхождений_ОПИУ_{period}_R005.xlsx",
});

export function auditRegistryFilenames(periodToken) {
  const period = text(periodToken);
  if (!period) throw new Error("AUDIT_REGISTRY_PERIOD_TOKEN_REQUIRED");
  return {
    correction_registry: AUDIT_REGISTRY_FILENAME_CONTRACT.correction_registry.replace("{period}", period),
    discrepancy_registry: AUDIT_REGISTRY_FILENAME_CONTRACT.discrepancy_registry.replace("{period}", period),
  };
}

const SAFETY = Object.freeze({
  report_only: true,
  posting_rows: 0,
  execution_allowed: false,
  ready_to_upload: false,
  release_allowed: false,
  live_1c_allowed: false,
});

const COLORS = Object.freeze({
  navy: "#17365D",
  teal: "#0F6B78",
  blue: "#D9EAF7",
  green: "#E2F0D9",
  yellow: "#FFF2CC",
  orange: "#FCE4D6",
  red: "#F4CCCC",
  gray: "#E7E6E6",
  white: "#FFFFFF",
  border: "#B4C6E7",
  darkRed: "#9C0006",
});

const AMOUNT_FORMAT = '#,##0.00;[Red]-#,##0.00;0.00';
const NOT_EXPORTED = "НЕ ВЫГРУЖЕНО";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PROVEN = new Set(["PROVEN", "PROVEN_SOURCE_SET", "ДОКАЗАНО_СВЕРКОЙ"]);
const AMBIGUOUS = new Set(["AMBIGUOUS", "AMBIGUOUS_SOURCE_SET", "AMBIGUOUS_RECLASS"]);
const CONTROL_ROLES = new Set(["TOTAL", "ИТОГ", "BLOCK", "БЛОК", "GROUP", "ГРУППА", "PARENT"]);

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function list(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined || text(value) === "" ? [] : [value];
}

function finite(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const normalized = typeof value === "string" ? value.replace(/\s/g, "").replace(",", ".") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : null;
}

function cents(value) {
  const number = finite(value);
  return number === null ? null : Math.round(number * 100);
}

function joinUnique(values, separator = "; ") {
  return [...new Set(values.map(text).filter(Boolean))].join(separator);
}

function stableId(prefix, payload) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase();
  return `${prefix}-${digest.slice(0, 20)}`;
}

async function sha256IfReadable(filePath) {
  if (!text(filePath)) return "";
  try {
    return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
  } catch {
    return "";
  }
}

function normalizeProof(value, blockers = []) {
  const status = upper(value);
  if (PROVEN.has(status)) return "PROVEN_SOURCE_SET";
  if (status === "AMBIGUOUS_SOURCE_SET") return status;
  if (status === "AMBIGUOUS_RECLASS") return status;
  if (AMBIGUOUS.has(status)) return "AMBIGUOUS_RECLASS";
  if (status === "BLOCKED" || blockers.length > 0) return "BLOCKED";
  return "UNPROVEN";
}

function rowPath(row, system) {
  const direct = system === "INTALEV" ? row?.intalev_path : row?.erp_path;
  const plural = system === "INTALEV" ? row?.intalev_paths : row?.erp_paths;
  const hierarchy = list(row?.hierarchy_path).join(" / ");
  return text(direct) || joinUnique(list(plural)) || hierarchy;
}

function rowArticle(row, system = "INTALEV") {
  return text(system === "INTALEV" ? row?.intalev_label : row?.erp_label)
    || text(row?.article)
    || text(row?.code);
}

function rowBlock(row) {
  return text(row?.opiu_block || row?.opiu_block_name || row?.block || row?.parent_block)
    || text(row?.hierarchy_parent_code)
    || text(rowPath(row, "INTALEV").split(" / ")[0]);
}

function normalizedDelta(row) {
  for (const key of ["normalized_delta", "normalised_delta", "normalized_residual", "r005_normalized_delta"]) {
    const value = finite(row?.[key]);
    if (value !== null) return value;
  }
  const normalizedErp = finite(row?.erp_normalized_amount);
  const intalev = finite(row?.intalev_amount);
  return normalizedErp !== null && intalev !== null ? finite(intalev - normalizedErp) : null;
}

function reclassRowKey(organization, period, code) {
  const normalizedOrganization = text(organization);
  const normalizedPeriod = text(period);
  const normalizedCode = text(code);
  if (!normalizedOrganization || !MONTH_RE.test(normalizedPeriod) || !normalizedCode) return "";
  return [normalizedOrganization, normalizedPeriod, normalizedCode].join("\u0000");
}

function reclassMemberRow(rowByScope, pair, member, defaultOrganization) {
  const organization = text(member?.organization || pair?.organization || defaultOrganization);
  const period = text(member?.period || pair?.period);
  const code = text(member?.code);
  const key = reclassRowKey(organization, period, code);
  return (key && rowByScope.get(key)) || { organization, period, code };
}

function operationContextOrganization(row, defaultOrganization) {
  return text(row?.context_organization || row?.report_organization || defaultOrganization);
}

function isControlOnly(row, parentCodes, parentNodeIds) {
  if (row?.control_only === true || row?.structural_non_posting === true || row?.hierarchy_has_children === true) return true;
  const code = upper(row?.code || row?.row_code);
  const nodeId = text(row?.hierarchy_node_id || row?.node_id);
  if ((code && parentCodes.has(code)) || (nodeId && parentNodeIds.has(nodeId))) return true;
  return [row?.group, row?.hierarchy_group, row?.row_kind, row?.role]
    .map(upper)
    .some((value) => CONTROL_ROLES.has(value));
}

function sourceAndTargetMembers(pair, rowByScope, defaultOrganization) {
  const members = list(pair?.member_deltas ?? pair?.members).map((member) => ({
    ...member,
    organization: text(member?.organization || pair?.organization || defaultOrganization),
    code: text(member?.code || member?.row_code || member?.member_code || member?.member_id),
    delta: finite(member?.delta),
    period: text(member?.period || pair?.period),
  }));
  const sourceCodes = list(pair?.source_codes ?? pair?.source_member_ids).map(text).filter(Boolean);
  const targetCodes = list(pair?.target_codes ?? pair?.target_member_ids).map(text).filter(Boolean);
  if (members.length === 0) {
    const organization = text(pair?.organization || defaultOrganization);
    const period = text(pair?.period);
    for (const code of sourceCodes) {
      const row = rowByScope.get(reclassRowKey(organization, period, code));
      members.push({ organization, code, delta: normalizedDelta(row), period });
    }
    for (const code of targetCodes) {
      const row = rowByScope.get(reclassRowKey(organization, period, code));
      members.push({ organization, code, delta: normalizedDelta(row), period });
    }
  }
  const source = members.filter((member) => sourceCodes.includes(member.code) || (member.delta ?? 0) < 0);
  const targets = members.filter((member) => targetCodes.includes(member.code) || (member.delta ?? 0) > 0);
  return { source, targets };
}

function cardinality(sourceCount, targetCount, explicit) {
  const requested = upper(explicit);
  if (["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"].includes(requested)) return requested;
  if (sourceCount <= 1 && targetCount <= 1) return "ONE_TO_ONE";
  if (sourceCount <= 1) return "ONE_TO_MANY";
  if (targetCount <= 1) return "MANY_TO_ONE";
  return "MANY_TO_MANY";
}

function scopeForPair(pair, sourceRows, targetRows) {
  const explicit = upper(pair?.scope);
  if (["WITHIN_BLOCK", "CROSS_BLOCK"].includes(explicit)) return explicit;
  const sourceBlocks = new Set(sourceRows.map(rowBlock).filter(Boolean));
  const targetBlocks = new Set(targetRows.map(rowBlock).filter(Boolean));
  if (sourceBlocks.size > 0 && targetBlocks.size > 0) {
    return [...targetBlocks].some((block) => !sourceBlocks.has(block)) ? "CROSS_BLOCK" : "WITHIN_BLOCK";
  }
  return "WITHIN_BLOCK";
}

function evidenceRole(row) {
  const debit = upper(row?.debit || row?.dt);
  const credit = upper(row?.credit || row?.kt);
  const rowClass = upper(row?.row_class || row?.evidence_status);
  const pairRole = upper(row?.pair_role || row?.evidence_role);
  if (/^99(?:\.|$)/.test(debit) || /^99(?:\.|$)/.test(credit) || rowClass.includes("CLOSING")) return "CLOSING_ROW";
  if (["SOURCE_OPERATION", "STORNO_SOURCE", "STORNO_SOURCE_CANDIDATE"].includes(pairRole)) return "SOURCE_OPERATION";
  if (["TARGET_IDENTITY", "REPOST_TARGET"].includes(pairRole)) return "TARGET_IDENTITY";
  if (rowClass.includes("EXCLUDED") || rowClass.includes("CANDIDATE") || row?.exact_article_bound !== true) return "GENERIC_CANDIDATE";
  return "EXCLUDED";
}

function exactSourceOperation(row) {
  if (evidenceRole(row) !== "SOURCE_OPERATION") return false;
  const proof = upper(row?.proof_status || row?.evidence_status || row?.pair_status);
  return row?.exact_article_bound === true || PROVEN.has(proof) || proof.includes("PROVEN");
}

function sourceEvidenceForPair(pair, operationRows, organization, period, operationOrganization) {
  const pairIds = new Set([
    text(pair?.pair_id),
    text(pair?.case_id),
    text(pair?.group_id),
    text(pair?.reclass_id),
  ].filter(Boolean));
  return operationRows.filter((row) => {
    const ids = [row?.pair_id, row?.case_id, row?.group_id, row?.reclass_id].map(text).filter(Boolean);
    const rowOrganization = operationContextOrganization(row, operationOrganization);
    const rowPeriod = text(row?.period);
    return ids.some((id) => pairIds.has(id))
      && rowOrganization === organization
      && rowPeriod === period
      && exactSourceOperation(row);
  });
}

function pairProjection(
  pair,
  rowByScope,
  operationRows,
  blockers,
  defaultOrganization,
  operationOrganization,
  structuralControlGroups,
) {
  const { source, targets } = sourceAndTargetMembers(pair, rowByScope, defaultOrganization);
  if ([...source, ...targets].some((member) =>
    isOwnerPresentationBlockExempt(member, structuralControlGroups))) return null;
  const memberOrganizations = new Set([
    text(pair?.organization || defaultOrganization),
    ...[...source, ...targets].map((item) => text(item.organization)),
  ].filter(Boolean));
  if (memberOrganizations.size > 1) {
    blockers.push({
      period: text(pair?.period),
      case_id: text(pair?.case_id || pair?.pair_id || pair?.group_id),
      blocker_code: "BLOCKED_CROSS_ORGANIZATION_RECLASS",
      description: "Source и targets относятся к разным организациям; финансовый CASE не создан.",
      source: "R005 reclass candidate",
      missing: "organization + concrete month isolation",
      required: "Сформировать отдельный CASE для каждой организации",
      proof_status: "BLOCKED",
    });
    return null;
  }
  const memberPeriods = new Set([
    text(pair?.period),
    ...[...source, ...targets].map((item) => text(item.period)),
  ].filter(Boolean));
  if (memberPeriods.size > 1) {
    blockers.push({
      period: joinUnique([...memberPeriods]),
      case_id: text(pair?.case_id || pair?.pair_id || pair?.group_id),
      blocker_code: "BLOCKED_CROSS_MONTH_RECLASS",
      description: "Source и targets относятся к разным месяцам; финансовый CASE не создан.",
      source: "R005 reclass candidate",
      missing: "organization + concrete month isolation",
      required: "Сформировать отдельный CASE в каждом месяце",
      proof_status: "BLOCKED",
    });
    return null;
  }
  const period = text(pair?.period) || [...memberPeriods][0] || "";
  if (!MONTH_RE.test(period)) return null;
  const organization = [...memberOrganizations][0] || "";
  const sourceRows = source.map((item) => reclassMemberRow(rowByScope, pair, item, defaultOrganization));
  const targetRows = targets.map((item) => reclassMemberRow(rowByScope, pair, item, defaultOrganization));
  const pairBlockers = list(pair?.blockers).map(text).filter(Boolean);
  const proofStatus = normalizeProof(pair?.proof_status || pair?.source_set_proof_status || pair?.status, pairBlockers);
  const caseId = text(pair?.case_id) || stableId("CASE", [period, pair?.pair_id, pair?.group_id, source.map((item) => item.code), targets.map((item) => item.code)]);
  const pairId = text(pair?.pair_id || pair?.group_id) || stableId("PAIR", [caseId, period]);
  const reclassId = text(pair?.reclass_id) || stableId("RECLASS", [pairId, period]);
  const sourceOperations = sourceEvidenceForPair(pair, operationRows, organization, period, operationOrganization);
  const sourceAmount = finite(source.reduce((sum, item) => sum + Math.abs(item.delta ?? 0), 0)) ?? 0;
  const targetsAmount = finite(targets.reduce((sum, item) => sum + Math.abs(item.delta ?? 0), 0)) ?? 0;
  const netEffect = finite([...source, ...targets].reduce((sum, item) => sum + (item.delta ?? 0), 0)) ?? 0;
  const sourceCodes = source.map((item) => item.code).filter(Boolean);
  const targetCodes = targets.map((item) => item.code).filter(Boolean);
  const scope = scopeForPair(pair, sourceRows, targetRows);
  const rows = (targets.length ? targets : [{ code: "", delta: null }]).map((target) => {
    const targetRow = reclassMemberRow(rowByScope, pair, target, defaultOrganization);
    return {
      period,
      case_id: caseId,
      pair_id: pairId,
      reclass_id: reclassId,
      scope,
      cardinality: cardinality(source.length, targets.length, pair?.cardinality),
      source_r_code: joinUnique(sourceCodes),
      source_article: joinUnique(sourceRows.map((row) => rowArticle(row, "INTALEV"))),
      source_path: joinUnique(sourceRows.map((row) => rowPath(row, "INTALEV"))),
      source_normalized_delta: finite(-sourceAmount),
      target_r_code: target.code,
      target_article: rowArticle(targetRow, "INTALEV"),
      target_path: rowPath(targetRow, "INTALEV"),
      target_amount: finite(Math.abs(target.delta ?? 0)),
      source_sum: sourceAmount,
      targets_sum: targetsAmount,
      net_effect: netEffect,
      proof_status: proofStatus,
      source_operation_count: sourceOperations.length,
      erp_source_rows: joinUnique(sourceOperations.map((row) => row?.source_range || row?.physical_row)),
      erp_document: joinUnique(sourceOperations.map((row) => row?.document || row?.registrar)),
      posting_no: joinUnique(sourceOperations.map((row) => row?.posting_no || row?.posting_number)),
      dt: joinUnique(sourceOperations.map((row) => row?.debit || row?.dt)),
      kt: joinUnique(sourceOperations.map((row) => row?.credit || row?.kt)),
      department: joinUnique(sourceOperations.flatMap((row) => [row?.debit_department, row?.credit_department, row?.department])),
      analytics: joinUnique(sourceOperations.flatMap((row) => [...list(row?.debit_analytics), ...list(row?.credit_analytics), row?.analytics3])),
      source_sha: joinUnique(sourceOperations.map((row) => row?.journal_sha256 || row?.source_sha256)),
      reason: text(pair?.reason) || `Projection существующего ${text(pair?.decision_class) || "STORNO_REPOST"} case`,
      proposed_solution: text(pair?.proposed_solution || pair?.solution) || (proofStatus === "PROVEN_SOURCE_SET" ? "STORNO_REPOST" : "REVIEW_ONLY"),
      r001_route: text(pair?.r001_route) || (proofStatus === "PROVEN_SOURCE_SET" ? "STORNO_REPOST" : "REVIEW_ONLY"),
      execution_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      source_codes: sourceCodes,
      target_codes: targetCodes,
    };
  });
  return { organization, case_id: caseId, pair_id: pairId, reclass_id: reclassId, period, scope, proof_status: proofStatus, rows, source_codes: sourceCodes, target_codes: targetCodes };
}

function correctionByBasis(analyticalPolicy) {
  const result = new Map();
  for (const context of list(analyticalPolicy?.contexts)) {
    for (const draft of list(context?.analytical_draft_corrections)) {
      const keys = [draft?.analytical_basis_id, draft?.target_article, draft?.pair_id, draft?.trace_id].map(text).filter(Boolean);
      for (const key of keys) result.set(`${text(context?.period)}\u0000${key}`, draft);
    }
  }
  return result;
}

function discrepancyClass(row, controlOnly, coveredByReclass) {
  if (controlOnly) return "CONTROL_ONLY";
  if (coveredByReclass) return "RECLASS";
  const requested = upper(row?.discrepancy_class || row?.decision_class || row?.default_decision);
  if (requested.includes("MAPPING")) return "MAPPING";
  if (requested.includes("AMBIGUOUS")) return "AMBIGUOUS";
  if (requested.includes("ONE_SIDE")) return "ONE_SIDE";
  if (requested === "RECLASS" || requested.includes("STORNO_REPOST")) return "RECLASS";
  return "UNPROVEN";
}

function proposedSolution(row, klass, proofStatus) {
  const explicit = upper(row?.proposed_solution || row?.solution);
  if (["STORNO_REPOST", "UPDATE_MAPPING", "EXCLUSION", "CONTROL_ONLY", "REVIEW_ONLY"].includes(explicit)) return explicit;
  if (klass === "CONTROL_ONLY") return "CONTROL_ONLY";
  if (klass === "MAPPING") return "UPDATE_MAPPING";
  if (klass === "RECLASS" && proofStatus === "PROVEN_SOURCE_SET") return "STORNO_REPOST";
  return "REVIEW_ONLY";
}

function projectDiscrepancies(
  rows,
  pairs,
  analyticalPolicy,
  defaultOrganization,
  structuralControlGroups,
  structuralControlResultForRow,
) {
  const parentCodes = new Set();
  const parentNodeIds = new Set();
  for (const row of rows) {
    if (text(row?.hierarchy_parent_code)) parentCodes.add(upper(row.hierarchy_parent_code));
    if (text(row?.hierarchy_parent_node_id)) parentNodeIds.add(text(row.hierarchy_parent_node_id));
  }
  const covered = new Map();
  for (const pair of pairs) {
    for (const code of [...pair.source_codes, ...pair.target_codes]) {
      covered.set(reclassRowKey(pair.organization, pair.period, code), pair);
    }
  }
  const analytical = correctionByBasis(analyticalPolicy);
  return rows.filter((row) => {
    const structuralControl = structuralControlResultForRow(row);
    if (isOwnerPresentationBlockExempt(row, structuralControlGroups)
      && structuralControl?.classification === "STRUCTURAL_GROUP_SUM_OK") return false;
    const raw = finite(row?.delta);
    const normalized = normalizedDelta(row);
    return row?.is_discrepancy === true || (raw !== null && raw !== 0) || (normalized !== null && normalized !== 0);
  }).map((row) => {
    const period = text(row?.period);
    const organization = text(row?.organization || defaultOrganization);
    const code = text(row?.code || row?.row_code);
    const pair = covered.get(reclassRowKey(organization, period, code));
    const structuralControl = structuralControlResultForRow(row);
    const structuralReview = isOwnerPresentationBlockExempt(row, structuralControlGroups)
      && structuralControl?.classification !== "STRUCTURAL_GROUP_SUM_OK";
    const structuralMember = structuralControl?.member_rows
      ?.find((member) => upper(member?.code) === upper(code)) ?? null;
    const controlOnly = structuralReview || isControlOnly(row, parentCodes, parentNodeIds);
    const klass = structuralReview
      ? structuralControl?.classification ?? "STRUCTURAL_GROUP_CONTROL_RESULT_MISSING"
      : discrepancyClass(row, controlOnly, Boolean(pair));
    const proofStatus = structuralReview ? "REVIEW_ONLY" : pair?.proof_status
      || normalizeProof(row?.proof_status || row?.evidence_status || row?.technical_status, list(row?.blockers));
    const draft = analytical.get(`${period}\u0000${text(row?.analytical_basis_id || code)}`)
      || analytical.get(`${period}\u0000${rowArticle(row, "INTALEV")}`);
    const correctionDelta = pair
      ? pair.rows.find((item) => item.target_r_code === code)?.target_amount ?? pair.rows[0]?.source_normalized_delta ?? null
      : finite(draft?.analytical_effect);
    const rawDelta = finite(row?.delta);
    const normalized = normalizedDelta(row);
    const parent = text(row?.parent || row?.hierarchy_parent_code || rowBlock(row));
    return {
      case_id: pair?.case_id || text(row?.case_id) || `R005-${period}-${code}`,
      period,
      organization,
      r_code: code,
      article: rowArticle(row, "INTALEV"),
      parent_block: parent,
      intalev_amount: finite(row?.intalev_amount),
      erp_amount: finite(row?.erp_amount ?? row?.erp_raw_amount),
      raw_delta: rawDelta,
      normalized_delta: normalized,
      correction_delta: structuralReview ? null : correctionDelta,
      control_only: controlOnly,
      class: klass,
      scope: pair?.scope || "N/A",
      reason: structuralReview
        ? `Structural control ${text(structuralControl?.control_set_id ?? structuralControl?.group_id)}: ${klass}; aggregate=${structuralControl?.control_sum_delta ?? "—"}; tolerance=${structuralControl?.tolerance ?? "—"}.`
        : text(row?.reason || row?.technical_status || row?.reconciliation_status) || "Требуется audit review",
      proposed_solution: structuralReview ? "REVIEW_ONLY" : proposedSolution(row, klass, proofStatus),
      proof_status: proofStatus,
      financial_posting_needed: structuralReview
        ? "НЕТ — STRUCTURAL CONTROL REVIEW_ONLY"
        : controlOnly ? "НЕТ — CONTROL_ONLY" : proofStatus === "PROVEN_SOURCE_SET" ? "REVIEW_REQUIRED" : "НЕ ДОКАЗАНО",
      proven_source_operation_count: pair?.rows[0]?.source_operation_count ?? 0,
      missing_evidence: structuralReview
        ? "Structural aggregate mismatch/configuration review; no STORNO/REPOST authority"
        : proofStatus === "PROVEN_SOURCE_SET" ? "" : text(row?.missing_evidence) || "Точная source operation / target identity / proof set",
      structural_group_control_set_id: structuralControl?.control_set_id
        ?? structuralControl?.group_id
        ?? null,
      structural_group_member_codes: structuralControl?.member_codes ?? [],
      structural_group_member_rows: structuralControl?.member_rows ?? [],
      structural_group_control_sum_delta: structuralControl?.control_sum_delta ?? null,
      structural_group_control_tolerance: structuralControl?.tolerance ?? null,
      structural_group_control_status: structuralControl?.classification ?? null,
      structural_root_effective_delta: structuralMember?.effective_delta ?? null,
      structural_descendant_internal_checks_active:
        structuralControl?.descendant_internal_checks_active ?? null,
      structural_financial_rows: 0,
      structural_posting_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      source_row: row,
    };
  });
}

function projectEvidence(discrepancies, operationEvidence, operationOrganization) {
  const result = [];
  const caseByScope = new Map(discrepancies.map((item) => [reclassRowKey(item.organization, item.period, item.r_code), item.case_id]));
  for (const row of list(operationEvidence?.rows)) {
    const period = text(row?.period);
    const organization = operationContextOrganization(row, operationOrganization);
    const code = text(row?.exact_bound_r_code || row?.parent_code || row?.r_code);
    const role = evidenceRole(row);
    const caseId = caseByScope.get(reclassRowKey(organization, period, code)) || `ERP-${text(row?.source_row_id || row?.physical_row)}`;
    result.push({
      case_id: caseId,
      period,
      evidence_system: "ERP",
      evidence_role: role,
      physical_row: text(row?.source_range || row?.physical_row),
      document: text(row?.document || row?.registrar),
      posting_no: text(row?.posting_no || row?.posting_number),
      dt: text(row?.debit || row?.dt),
      kt: text(row?.credit || row?.kt),
      amount: finite(row?.amount_accounting ?? row?.amount),
      article: text(row?.article),
      department: joinUnique([row?.debit_department, row?.credit_department, row?.department]),
      analytics: joinUnique([...list(row?.debit_analytics), ...list(row?.credit_analytics), row?.analytics3]),
      source_sha: text(row?.journal_sha256 || row?.source_sha256),
      proof_status: role === "SOURCE_OPERATION" && exactSourceOperation(row)
        ? "PROVEN_SOURCE_SET"
        : role === "CLOSING_ROW" ? "EXCLUDED_CLOSING_ROW" : "EXCLUDED",
    });
  }
  for (const discrepancy of discrepancies) {
    for (const source of list(discrepancy.source_row?.intalev_sources)) {
      result.push({
        case_id: discrepancy.case_id,
        period: discrepancy.period,
        evidence_system: "INTALEV",
        evidence_role: "TARGET_IDENTITY",
        physical_row: text(source?.source_cell || source?.physical_row || source?.row),
        document: text(source?.registrar) || NOT_EXPORTED,
        posting_no: text(source?.posting_no) || NOT_EXPORTED,
        dt: text(source?.dt || source?.debit) || NOT_EXPORTED,
        kt: text(source?.kt || source?.credit) || NOT_EXPORTED,
        amount: finite(source?.amount),
        article: discrepancy.article,
        department: text(source?.department),
        analytics: text(source?.full_path),
        source_sha: text(source?.sha256),
        proof_status: text(source?.proof_status) || "TARGET_IDENTITY_ONLY",
      });
    }
  }
  return result;
}

function projectSources(payload, metadata, sidecarPath, sidecarSha) {
  const sources = [];
  const add = (record) => {
    const key = [record.source_type, record.file, record.sha256, record.sheet, record.physical_range, record.period].map(text).join("\u0000");
    if (sources.some((item) => item.__key === key)) return;
    sources.push({ ...record, __key: key });
  };
  add({
    source_type: "R005_RECONCILIATION",
    file: text(metadata?.reconciliationPath),
    sha256: text(metadata?.reconciliationSha || payload?.report_sha256),
    sheet: text(metadata?.sourceSheet),
    physical_range: "workbook",
    organization: text(payload?.organization || metadata?.organization),
    period: joinUnique(list(payload?.periods ?? payload?.period)),
    run_id: text(metadata?.sourceRunId || metadata?.runId),
    manifest_status: "PINNED",
    evidence_status: "R005_OUTPUT",
  });
  if (text(sidecarPath)) add({
    source_type: "R005_SIDECAR",
    file: sidecarPath,
    sha256: sidecarSha,
    sheet: "JSON",
    physical_range: "payload",
    organization: text(payload?.organization),
    period: joinUnique(list(payload?.periods ?? payload?.period)),
    run_id: text(metadata?.sourceRunId || metadata?.runId),
    manifest_status: text(payload?.source_provenance?.status) || "PINNED",
    evidence_status: "AUDIT_PROJECTION_SOURCE",
  });
  for (const row of list(payload?.rows)) {
    for (const [system, rowSources] of [["INTALEV", row?.intalev_sources], ["ERP", row?.erp_sources]]) {
      for (const source of list(rowSources)) add({
        source_type: `${system}_OPIU`,
        file: text(source?.source_file || source?.input_origin),
        sha256: text(source?.sha256),
        sheet: text(source?.sheet),
        physical_range: text(source?.source_cell || source?.physical_row || source?.row),
        organization: text(row?.organization || source?.organization),
        period: text(source?.month || row?.period),
        run_id: text(metadata?.sourceRunId || metadata?.runId),
        manifest_status: text(payload?.source_provenance?.status) || "UNKNOWN",
        evidence_status: text(system === "INTALEV" ? row?.intalev_status : row?.erp_status),
      });
    }
  }
  for (const binding of list(payload?.operation_evidence?.source_trace?.source_bindings)) add({
    source_type: "ERP_JOURNAL",
    file: text(binding?.journal_path || binding?.journal_input_path),
    sha256: text(binding?.journal_sha256),
    sheet: text(payload?.operation_evidence?.journal_sheet),
    physical_range: text(payload?.operation_evidence?.source_trace?.journals?.[0]?.data_bounds),
    organization: text(payload?.organization),
    period: text(binding?.period),
    run_id: text(metadata?.sourceRunId || metadata?.runId),
    manifest_status: payload?.operation_evidence?.journal_verified === true ? "VERIFIED" : "NOT_VERIFIED",
    evidence_status: text(payload?.operation_evidence?.status),
  });
  return sources.map(({ __key, ...item }) => item);
}

function projectDeletions(actions, metadata) {
  const capabilityIncluded = Object.prototype.hasOwnProperty.call(actions ?? {}, "deletionOperations")
    && Object.prototype.hasOwnProperty.call(actions ?? {}, "deletionPostings");
  const capabilityState = capabilityIncluded ? "INCLUDED" : "NOT_INCLUDED_IN_THIS_BUILD";
  const rows = [];
  for (const row of list(actions?.deletionOperations)) rows.push({
    period: text(metadata?.period), delete_id: text(row?.[8]), pair_id: text(row?.[7]), upload_id: "",
    keep_operation: text(row?.[5]), delete_operation: text(row?.[2]), document_type: text(row?.[1]),
    keep_posting_no: "", delete_posting_no: "", keep_journal_rows: "", delete_journal_rows: text(row?.[6]),
    row_count: list(text(row?.[6]).split(";")).filter(Boolean).length, effect_sha: text(row?.[9]),
    basis: "EXACT_EFFECT_DUPLICATE", proof_status: text(row?.[11]) || "UNPROVEN", status: "DELETE_OPERATION",
    execution_allowed: false, ready_to_upload: false, release_allowed: false,
  });
  for (const row of list(actions?.deletionPostings)) rows.push({
    period: text(metadata?.period), delete_id: text(row?.[9]), pair_id: text(row?.[8]), upload_id: "",
    keep_operation: text(row?.[6]), delete_operation: text(row?.[2]), document_type: text(row?.[1]),
    keep_posting_no: "", delete_posting_no: text(row?.[5]), keep_journal_rows: "", delete_journal_rows: text(row?.[7]),
    row_count: list(text(row?.[7]).split(";")).filter(Boolean).length, effect_sha: text(row?.[10]),
    basis: "EXACT_EFFECT_DUPLICATE", proof_status: text(row?.[17]) || "UNPROVEN", status: "DELETE_OPERATION",
    execution_allowed: false, ready_to_upload: false, release_allowed: false,
  });
  if (rows.length === 0) rows.push({
    period: text(metadata?.period), delete_id: "", pair_id: "", upload_id: "", keep_operation: "", delete_operation: "",
    document_type: "", keep_posting_no: "", delete_posting_no: "", keep_journal_rows: "", delete_journal_rows: "",
    row_count: 0, effect_sha: "", basis: capabilityState,
    proof_status: capabilityIncluded ? "UNPROVEN" : "NOT_APPLICABLE",
    status: capabilityIncluded ? "NO_ACTION_INACTIVE" : "NOT_INCLUDED_IN_THIS_BUILD",
    execution_allowed: false, ready_to_upload: false, release_allowed: false,
  });
  return { rows, capability_state: capabilityState };
}

function blockerRows(analyticalPolicy, payload, pairBlockers) {
  const result = [...pairBlockers];
  const add = (record) => {
    const item = {
      period: text(record?.period || payload?.period),
      case_id: text(record?.trace_id || record?.case_id || record?.r_code || record?.code),
      blocker_code: text(record?.blocker_code || record?.code || record?.status) || "BLOCKED",
      description: text(record?.description || record?.reason || record?.details),
      source: text(record?.source) || "R005/R001",
      missing: text(record?.missing || record?.details),
      required: text(record?.required) || "Точное доказательство и review",
      proof_status: "BLOCKED",
    };
    const key = [item.period, item.case_id, item.blocker_code, item.description].join("\u0000");
    if (!result.some((existing) => [existing.period, existing.case_id, existing.blocker_code, existing.description].map(text).join("\u0000") === key)) result.push(item);
  };
  for (const record of list(analyticalPolicy?.blockers)) add(record);
  for (const context of list(analyticalPolicy?.contexts)) for (const record of list(context?.blockers)) add({ ...record, period: context?.period });
  const operationStatus = upper(payload?.operation_evidence?.status);
  if (operationStatus.startsWith("BLOCKED")) add({
    period: payload?.period,
    blocker_code: operationStatus,
    description: "Operation evidence не прошло exact-bound proof gate.",
    source: "R005 operation_evidence",
    missing: "Exact source operation binding",
    required: "Доказать source set без generic/closing rows",
  });
  return result;
}

function monthRows(periods, payload, analyticalPolicy, discrepancies, pairs, blockers) {
  const contexts = new Map(list(analyticalPolicy?.contexts).map((context) => [text(context?.period), context]));
  const explicitMonthly = new Map(list(payload?.monthly_summary ?? payload?.monthly_summaries).map((item) => [text(item?.period), item]));
  return periods.map((period) => {
    const context = contexts.get(period);
    const explicit = explicitMonthly.get(period);
    const scenario = context?.scenario ?? {};
    const intalev = finite(explicit?.intalev ?? explicit?.intalev_amount ?? scenario?.INTALEV_TARGET);
    const erp = finite(explicit?.erp ?? explicit?.erp_amount ?? scenario?.ERP_CURRENT);
    const rawDelta = finite(explicit?.raw_delta ?? (intalev !== null && erp !== null ? intalev - erp : null));
    const normalized = finite(explicit?.normalized_delta ?? scenario?.RESIDUAL_DELTA);
    const monthDiscrepancies = discrepancies.filter((item) => item.period === period);
    const monthPairs = pairs.filter((item) => item.period === period);
    const proofCounts = (status) => monthPairs.filter((item) => item.proof_status === status).length;
    const monthBlockers = blockers.filter((item) => !text(item.period) || text(item.period).split(";").includes(period));
    const unproven = proofCounts("UNPROVEN");
    const ambiguous = monthPairs.filter((item) => item.proof_status.startsWith("AMBIGUOUS")).length;
    return {
      period,
      intalev,
      erp,
      raw_delta: rawDelta,
      normalized_delta: normalized,
      discrepancy_count: monthDiscrepancies.length,
      reclass_cases: monthPairs.length,
      within_block: monthPairs.filter((item) => item.scope === "WITHIN_BLOCK").length,
      cross_block: monthPairs.filter((item) => item.scope === "CROSS_BLOCK").length,
      proven: proofCounts("PROVEN_SOURCE_SET"),
      unproven,
      ambiguous,
      status: monthBlockers.length ? "BLOCKED" : (unproven || ambiguous) ? "REVIEW" : normalized === 0 ? "OK" : "REVIEW",
    };
  });
}

export function buildAuditRegistryProjection({
  metadata = {},
  decisions = [],
  actions = {},
  analyticalPolicy = null,
  sidecarPayload = {},
  sidecarPath = "",
  sidecarSha = "",
  generatedAt = new Date().toISOString(),
} = {}) {
  const payload = sidecarPayload ?? {};
  const structuralControlGroups = structuralControlGroupsFromConfig({
    tolerance: Number(payload?.tolerance ?? 0.01),
    structural_group_control_sets: payload?.structural_group_control_sets ?? [],
  });
  const rows = list(payload?.rows);
  const projectionOrganization = text(payload?.organization || metadata?.organization);
  const structuralControlResults = [];
  const structuralControlByScope = new Map();
  for (const row of rows) {
    const group = structuralControlGroupForCode(row, structuralControlGroups);
    if (!group) continue;
    const organization = text(row?.organization || projectionOrganization);
    const period = text(row?.period || payload?.period);
    const groupId = text(group?.group_id ?? group?.id);
    const key = `${organization}\u0000${period}\u0000${groupId}`;
    if (structuralControlByScope.has(key)) continue;
    const [control] = assessConfiguredStructuralControlGroups(rows.map((item) => ({
      ...item,
      organization: text(item?.organization || projectionOrganization),
      period: text(item?.period || payload?.period),
    })), {
      organization,
      period,
      tolerance: group?.tolerance,
      groups: [group],
    });
    structuralControlByScope.set(key, control);
    structuralControlResults.push(control);
  }
  const structuralControlResultForRow = (row) => {
    const group = structuralControlGroupForCode(row, structuralControlGroups);
    if (!group) return null;
    const key = `${text(row?.organization || projectionOrganization)}\u0000${text(row?.period || payload?.period)}\u0000${text(group?.group_id ?? group?.id)}`;
    return structuralControlByScope.get(key) ?? null;
  };
  const operationOrganization = text(
    payload?.operation_evidence?.context_organization
      || payload?.operation_evidence?.report_organization
      || payload?.operation_evidence?.expected_scope?.organization
      || payload?.operation_evidence?.scope?.organization
      || payload?.operation_evidence?.input?.organization
      || projectionOrganization,
  );
  const rowByScope = new Map();
  for (const row of rows) {
    const key = reclassRowKey(row?.organization || projectionOrganization, row?.period, row?.code || row?.row_code);
    if (key) rowByScope.set(key, row);
  }
  const operationRows = list(payload?.operation_evidence?.rows);
  const pairBlockers = [];
  const rawPairs = list(payload?.zero_sum_storno_repost_candidates).length
    ? list(payload.zero_sum_storno_repost_candidates)
    : list(payload?.operation_evidence?.pair_candidates);
  const pairs = rawPairs.map((pair) => pairProjection(
    pair,
    rowByScope,
    operationRows,
    pairBlockers,
    projectionOrganization,
    operationOrganization,
    structuralControlGroups,
  )).filter(Boolean);
  const discrepancies = projectDiscrepancies(
    rows,
    pairs,
    analyticalPolicy,
    projectionOrganization,
    structuralControlGroups,
    structuralControlResultForRow,
  );
  const presentationBlockExemptions = rows
    .filter((row) => isOwnerPresentationBlockExempt(row, structuralControlGroups))
    .map((row) => ownerPresentationBlockExemption(row, {
      period: text(row?.period || payload?.period),
      normalizedDelta: normalizedDelta(row) ?? finite(row?.delta),
      groups: structuralControlGroups,
      controlResult: structuralControlResultForRow(row),
    }));
  const evidence = projectEvidence(discrepancies, payload?.operation_evidence, operationOrganization);
  const sources = projectSources(payload, metadata, sidecarPath, sidecarSha);
  const deletionProjection = projectDeletions(actions, { ...metadata, period: text(payload?.period || metadata?.period) });
  const deletions = deletionProjection.rows;
  const blockers = blockerRows(analyticalPolicy, payload, pairBlockers);
  const periods = [...new Set([
    ...list(payload?.periods ?? payload?.period).map(text),
    ...list(analyticalPolicy?.contexts).map((item) => text(item?.period)),
    ...rows.map((item) => text(item?.period)),
  ].filter((period) => MONTH_RE.test(period)))].sort();
  const months = monthRows(periods, payload, analyticalPolicy, discrepancies, pairs, blockers);
  const pairRows = pairs.flatMap((pair) => pair.rows);
  const proofCounts = {
    proven: pairs.filter((item) => item.proof_status === "PROVEN_SOURCE_SET").length,
    unproven: pairs.filter((item) => item.proof_status === "UNPROVEN").length,
    ambiguous: pairs.filter((item) => item.proof_status.startsWith("AMBIGUOUS")).length,
  };
  const sourceByType = (prefix) => sources.filter((item) => item.source_type.startsWith(prefix));
  return {
    schema_version: "r001-owner-audit-registry-projection-1.0.0",
    organization: projectionOrganization,
    period_start: periods[0] || text(payload?.period || metadata?.period),
    period_end: periods.at(-1) || text(payload?.period || metadata?.period),
    periods,
    run_id: text(metadata?.sourceRunId || metadata?.runId || payload?.run_id),
    generated_at: generatedAt,
    source_shas: {
      r005: text(metadata?.reconciliationSha || payload?.report_sha256),
      erp: joinUnique(sourceByType("ERP_OPIU").map((item) => item.sha256)) || text(payload?.erp_input_authority?.actual_sha256),
      intalev: joinUnique(sourceByType("INTALEV_OPIU").map((item) => item.sha256)),
      reconciliation: text(metadata?.reconciliationSha || payload?.report_sha256),
      sidecar: sidecarSha,
      manifest: text(metadata?.r005ManifestSha),
      journal: text(payload?.operation_evidence?.journal_sha256),
    },
    safety: { ...SAFETY },
    counts: {
      reclass_cases: pairs.length,
      within_block: pairs.filter((item) => item.scope === "WITHIN_BLOCK").length,
      cross_block: pairs.filter((item) => item.scope === "CROSS_BLOCK").length,
      proven: proofCounts.proven,
      unproven: proofCounts.unproven,
      ambiguous: proofCounts.ambiguous,
      blocked: blockers.length,
      delete_cases: deletions.filter((item) => item.status === "DELETE_OPERATION").length,
      discrepancy_cases: discrepancies.length,
      exact_bound_operations: operationRows.filter(exactSourceOperation).length,
      generic_candidates: evidence.filter((item) => item.evidence_system === "ERP" && item.evidence_role === "GENERIC_CANDIDATE").length,
    },
    months,
    pairs,
    pair_rows: pairRows,
    deletions,
    delete_capability_state: deletionProjection.capability_state,
    blockers,
    sources,
    discrepancies,
    structural_group_control_results: structuralControlResults,
    presentation_block_exemptions: presentationBlockExemptions,
    evidence,
    qa: {
      source_files: sources.length,
      row_counts: {
        correction_months: months.length,
        correction_pairs: pairRows.length,
        correction_deletions: deletions.length,
        correction_blockers: blockers.length,
        correction_sources: sources.length,
        discrepancy_registry: discrepancies.length,
        posting_details: evidence.length,
      },
      exact_bound_operations: operationRows.filter(exactSourceOperation).length,
      generic_candidates: evidence.filter((item) => item.evidence_system === "ERP" && item.evidence_role === "GENERIC_CANDIDATE").length,
      reclass_cases: pairs.length,
      proven: proofCounts.proven,
      unproven: proofCounts.unproven,
      ambiguous: proofCounts.ambiguous,
      delete_capability_state: deletionProjection.capability_state,
      formula_errors: 0,
      report_only: true,
      decisions_seen: decisions.length,
    },
  };
}

function columnLetter(index) {
  let value = Number(index) + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function writeMatrix(sheet, rowIndex, columnIndex, rows) {
  if (!rows.length) return;
  sheet.getRangeByIndexes(rowIndex, columnIndex, rows.length, rows[0].length).values = rows;
}

function addSheet(workbook, name) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  return sheet;
}

function styleTitle(sheet, columnCount, title) {
  const range = sheet.getRangeByIndexes(0, 0, 1, columnCount);
  range.merge();
  range.values = [[title]];
  range.format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 15 },
    rowHeight: 28,
    verticalAlignment: "center",
  };
}

function styleNotice(sheet, columnCount, notice) {
  const range = sheet.getRangeByIndexes(1, 0, 1, columnCount);
  range.merge();
  range.values = [[notice]];
  range.format = {
    fill: COLORS.red,
    font: { bold: true, color: COLORS.darkRed, size: 10 },
    wrapText: true,
    rowHeight: 34,
    verticalAlignment: "center",
  };
}

function styleHeader(range) {
  range.format = {
    fill: COLORS.teal,
    font: { bold: true, color: COLORS.white, size: 9 },
    wrapText: true,
    verticalAlignment: "center",
    horizontalAlignment: "center",
    rowHeight: 44,
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
}

function styleBody(range) {
  range.format = {
    font: { size: 9, color: "#1F1F1F" },
    wrapText: true,
    verticalAlignment: "top",
    borders: { preset: "all", style: "thin", color: "#D9E2F3" },
  };
}

function setWidths(sheet, widths) {
  for (const [index, width] of widths.entries()) {
    const column = columnLetter(index);
    sheet.getRange(`${column}:${column}`).format.columnWidth = width;
  }
}

function tableSheet(workbook, { name, title, notice, headers, rows, amountColumns = [], wideColumns = [], statusColumn = -1 }) {
  const sheet = addSheet(workbook, name);
  styleTitle(sheet, headers.length, title);
  styleNotice(sheet, headers.length, notice);
  writeMatrix(sheet, 3, 0, [headers]);
  styleHeader(sheet.getRangeByIndexes(3, 0, 1, headers.length));
  if (rows.length) {
    writeMatrix(sheet, 4, 0, rows);
    styleBody(sheet.getRangeByIndexes(4, 0, rows.length, headers.length));
    for (const index of amountColumns) sheet.getRangeByIndexes(4, index, rows.length, 1).format.numberFormat = AMOUNT_FORMAT;
    if (statusColumn >= 0) {
      const statusRange = sheet.getRangeByIndexes(4, statusColumn, rows.length, 1);
      statusRange.conditionalFormats.add("containsText", { text: "BLOCKED", format: { fill: COLORS.red, font: { color: COLORS.darkRed, bold: true } } });
      statusRange.conditionalFormats.add("containsText", { text: "PROVEN", format: { fill: COLORS.green, font: { color: "#006100", bold: true } } });
      statusRange.conditionalFormats.add("containsText", { text: "UNPROVEN", format: { fill: COLORS.yellow, font: { color: "#9C6500", bold: true } } });
    }
  }
  setWidths(sheet, headers.map((_, index) => wideColumns.includes(index) ? 42 : amountColumns.includes(index) ? 16 : 20));
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(Math.min(3, headers.length));
  return sheet;
}

function correctionWorkbook(projection) {
  const workbook = Workbook.create();
  const passport = addSheet(workbook, "00_Паспорт");
  styleTitle(passport, 8, "Реестр корректировок ОПиУ — OWNER / AUDIT");
  styleNotice(passport, 8, "AUDIT/REVIEW output. Не является разрешением на posting, upload, delete execution или live 1C.");
  writeMatrix(passport, 3, 0, [["Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение"]]);
  styleHeader(passport.getRange("A4:H4"));
  const c = projection.counts;
  writeMatrix(passport, 4, 0, [
    ["organization", projection.organization, "period_start", projection.period_start, "period_end", projection.period_end, "periods[]", projection.periods.join(", ")],
    ["run_id", projection.run_id, "generated_at", text(projection.generated_at).replace("T", " ").replace(/\.000Z$/, " UTC"), "R005 source SHA", projection.source_shas.r005, "ERP source SHA", projection.source_shas.erp],
    ["Intalev source SHA", projection.source_shas.intalev, "REPORT_ONLY", true, "posting_rows", 0, "ready_to_upload", false],
    ["release_allowed", false, "live_1c_allowed", false, "execution_allowed", false, "reclass cases", c.reclass_cases],
    ["WITHIN_BLOCK", c.within_block, "CROSS_BLOCK", c.cross_block, "PROVEN", c.proven, "UNPROVEN", c.unproven],
    ["AMBIGUOUS", c.ambiguous, "blocked", c.blocked, "delete cases", c.delete_cases, "discrepancies", c.discrepancy_cases],
  ]);
  styleBody(passport.getRange("A5:H10"));
  passport.getRange("A7:H10").format.fill = COLORS.yellow;
  setWidths(passport, [24, 44, 24, 44, 24, 44, 24, 44]);
  passport.freezePanes.freezeRows(4);

  const monthHeaders = ["Период", "Intalev", "ERP", "RAW delta", "NORMALIZED delta", "Количество расхождений", "Reclass cases", "WITHIN_BLOCK", "CROSS_BLOCK", "PROVEN", "UNPROVEN", "AMBIGUOUS", "Статус"];
  const monthRowsData = projection.months.map((item) => [item.period, item.intalev, item.erp, item.raw_delta, item.normalized_delta, item.discrepancy_count, item.reclass_cases, item.within_block, item.cross_block, item.proven, item.unproven, item.ambiguous, item.status]);
  const months = tableSheet(workbook, {
    name: "01_Месяцы", title: "Помесячный OWNER/AUDIT обзор", notice: "TOTAL ниже — только отображение. Reclassification ищется строго внутри organization + concrete month.",
    headers: monthHeaders, rows: monthRowsData, amountColumns: [1, 2, 3, 4], statusColumn: 12,
  });
  const totalRowIndex = 4 + monthRowsData.length;
  const excelRowStart = 5;
  const excelRowEnd = 4 + monthRowsData.length;
  if (monthRowsData.length) {
    months.getRangeByIndexes(totalRowIndex, 0, 1, monthHeaders.length).values = [["TOTAL", null, null, null, null, null, null, null, null, null, null, null, "DISPLAY_ONLY"]];
    for (let column = 1; column <= 11; column += 1) {
      const letter = columnLetter(column);
      months.getRangeByIndexes(totalRowIndex, column, 1, 1).formulas = [[`=SUM('${months.name}'!${letter}${excelRowStart}:${letter}${excelRowEnd})`]];
    }
    styleBody(months.getRangeByIndexes(totalRowIndex, 0, 1, monthHeaders.length));
    months.getRangeByIndexes(totalRowIndex, 0, 1, monthHeaders.length).format = { fill: COLORS.blue, font: { bold: true, color: "#17365D" }, borders: { preset: "doubleBottom", style: "thin", color: COLORS.navy } };
    months.getRangeByIndexes(totalRowIndex, 1, 1, 4).format.numberFormat = AMOUNT_FORMAT;
  }

  const pairHeaders = ["Период", "CaseID", "PairID", "ReclassID", "Scope", "Cardinality", "Источник R-code", "Источник статья", "Источник путь", "Источник NORMALIZED delta", "Цель R-code", "Цель статья", "Цель путь", "Цель amount", "Сумма source", "Сумма targets", "NET EFFECT", "Proof status", "Количество source operations", "ERP source rows", "ERP document/registrar", "posting_no", "Dt", "Kt", "department", "analytics", "Source SHA", "Причина", "Предлагаемое решение", "R001 route", "execution_allowed", "ready_to_upload", "release_allowed"];
  const pairRows = projection.pair_rows.map((item) => [item.period, item.case_id, item.pair_id, item.reclass_id, item.scope, item.cardinality, item.source_r_code, item.source_article, item.source_path, item.source_normalized_delta, item.target_r_code, item.target_article, item.target_path, item.target_amount, item.source_sum, item.targets_sum, item.net_effect, item.proof_status, item.source_operation_count, item.erp_source_rows, item.erp_document, item.posting_no, item.dt, item.kt, item.department, item.analytics, item.source_sha, item.reason, item.proposed_solution, item.r001_route, false, false, false]);
  tableSheet(workbook, {
    name: "02_Пары", title: "Обнаруженные STORNO_REPOST cases", notice: "Projection существующих cases. Parent/path различие не скрывает CROSS_BLOCK. Любая строка остаётся non-executable.",
    headers: pairHeaders, rows: pairRows, amountColumns: [9, 13, 14, 15, 16], wideColumns: [8, 12, 19, 20, 24, 25, 26, 27, 28], statusColumn: 17,
  });

  const deletionHeaders = ["Период", "DeleteID", "PairID", "UploadID", "KEEP operation", "DELETE operation", "Тип документа", "Номер операции KEEP", "Номер операции DELETE", "KEEP journal rows", "DELETE journal rows", "Количество строк", "Effect SHA", "Основание", "Proof status", "Status", "execution_allowed", "ready_to_upload", "release_allowed"];
  const deletionRows = projection.deletions.map((item) => [item.period, item.delete_id, item.pair_id, item.upload_id, item.keep_operation, item.delete_operation, item.document_type, item.keep_posting_no, item.delete_posting_no, item.keep_journal_rows, item.delete_journal_rows, item.row_count, item.effect_sha, item.basis, item.proof_status, item.status, false, false, false]);
  tableSheet(workbook, {
    name: "03_Удаления", title: "Audit information по DELETE OWNER contract",
    notice: projection.delete_capability_state === "NOT_INCLUDED_IN_THIS_BUILD"
      ? "DELETE integration отсутствует в этой сборке: NOT_INCLUDED_IN_THIS_BUILD. DELETE НЕ ВЫПОЛНЯЕТСЯ."
      : "DELETE НЕ ВЫПОЛНЯЕТСЯ. При активной integration без доказанных delete cases показан NO_ACTION_INACTIVE.",
    headers: deletionHeaders, rows: deletionRows, wideColumns: [4, 5, 9, 10, 12, 13], statusColumn: 15,
  });

  const blockerHeaders = ["Период", "CaseID / R-code", "Blocker code", "Описание", "Источник", "Что отсутствует", "Что требуется для доказательства", "Proof status"];
  const blockerData = projection.blockers.map((item) => [item.period, item.case_id, item.blocker_code, item.description, item.source, item.missing, item.required, item.proof_status]);
  tableSheet(workbook, {
    name: "04_Блокеры", title: "Незакрытые blockers", notice: "Отсутствующее evidence не заполняется догадками.",
    headers: blockerHeaders, rows: blockerData, wideColumns: [3, 4, 5, 6], statusColumn: 7,
  });

  const sourceHeaders = ["Тип источника", "Файл", "SHA256", "Sheet", "Physical row/range", "Organization", "Period", "RunID", "Manifest status", "Evidence status"];
  const sourceRows = projection.sources.map((item) => [item.source_type, item.file, item.sha256, item.sheet, item.physical_range, item.organization, item.period, item.run_id, item.manifest_status, item.evidence_status]);
  tableSheet(workbook, {
    name: "05_Источники", title: "Exact provenance", notice: "Пути и SHA показаны только в audit workbook; source bytes не изменяются.",
    headers: sourceHeaders, rows: sourceRows, wideColumns: [1, 2, 4, 9], statusColumn: 9,
  });
  return workbook;
}

function discrepancyWorkbook(projection) {
  const workbook = Workbook.create();
  const headers = ["ID случая", "Период", "Organization", "R-code", "Статья", "Parent / block", "Intalev amount", "ERP amount", "RAW delta", "NORMALIZED delta", "CORRECTION delta", "CONTROL_ONLY", "Класс", "Scope", "Причина", "Предлагаемое решение", "Proof status", "Нужна ли финансовая проводка", "Количество доказанных source operations", "Недостающие доказательства", "Structural control set", "Structural members", "Structural member raw deltas", "Structural aggregate", "Structural tolerance", "Structural status", "Structural root effective delta", "Descendants active", "Structural financial rows", "Structural posting allowed", "ready_to_upload", "release_allowed"];
  const rows = projection.discrepancies.map((item) => [item.case_id, item.period, item.organization, item.r_code, item.article, item.parent_block, item.intalev_amount, item.erp_amount, item.raw_delta, item.normalized_delta, item.correction_delta, item.control_only, item.class, item.scope, item.reason, item.proposed_solution, item.proof_status, item.financial_posting_needed, item.proven_source_operation_count, item.missing_evidence, item.structural_group_control_set_id, joinUnique(item.structural_group_member_codes ?? []), joinUnique((item.structural_group_member_rows ?? []).map((member) => `${text(member?.code)}:${member?.raw_delta ?? ""}`)), item.structural_group_control_sum_delta, item.structural_group_control_tolerance, item.structural_group_control_status, item.structural_root_effective_delta, item.structural_descendant_internal_checks_active, item.structural_financial_rows, item.structural_posting_allowed, false, false]);
  tableSheet(workbook, {
    name: "Реестр", title: "Реестр проводок расхождений — OWNER / AUDIT", notice: "Показаны все значимые расхождения, включая UNPROVEN. RAW delta не является correction authority.",
    headers, rows, amountColumns: [6, 7, 8, 9, 10, 23, 24, 26], wideColumns: [4, 5, 14, 17, 19, 20, 21, 22, 25], statusColumn: 16,
  });

  const evidenceHeaders = ["CaseID", "Период", "EvidenceSystem", "EvidenceRole", "Physical row", "Document/registrar", "posting_no", "Dt", "Kt", "Amount", "Article", "Department", "Analytics", "Source SHA", "Proof status"];
  const evidenceRows = projection.evidence.map((item) => [item.case_id, item.period, item.evidence_system, item.evidence_role, item.physical_row, item.document, item.posting_no, item.dt, item.kt, item.amount, item.article, item.department, item.analytics, item.source_sha, item.proof_status]);
  tableSheet(workbook, {
    name: "Детали_проводок", title: "Evidence по source system", notice: `ERP source, closing и generic rows разделены. Для отсутствующих реквизитов INTALEV используется «${NOT_EXPORTED}».`,
    headers: evidenceHeaders, rows: evidenceRows, amountColumns: [9], wideColumns: [4, 5, 10, 11, 12, 13], statusColumn: 14,
  });

  const qa = addSheet(workbook, "Источники_QA");
  styleTitle(qa, 8, "Источники и QA passport");
  styleNotice(qa, 8, "REPORT_ONLY. Formula errors проверяются до и после повторного открытия workbook.");
  writeMatrix(qa, 3, 0, [["Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение", "Параметр", "Значение"]]);
  styleHeader(qa.getRange("A4:H4"));
  writeMatrix(qa, 4, 0, [
    ["run_id", projection.run_id, "period_start", projection.period_start, "period_end", projection.period_end, "periods[]", projection.periods.join(", ")],
    ["reconciliation workbook SHA", projection.source_shas.reconciliation, "sidecar SHA", projection.source_shas.sidecar, "manifest SHA", projection.source_shas.manifest, "journal SHA", projection.source_shas.journal],
    ["source files", projection.qa.source_files, "registry rows", projection.qa.row_counts.discrepancy_registry, "details rows", projection.qa.row_counts.posting_details, "exact-bound operations", projection.qa.exact_bound_operations],
    ["generic candidates", projection.qa.generic_candidates, "reclass cases", projection.qa.reclass_cases, "PROVEN", projection.qa.proven, "UNPROVEN", projection.qa.unproven],
    ["AMBIGUOUS", projection.qa.ambiguous, "formula errors", 0, "REPORT_ONLY", true, "posting_rows", 0],
    ["ready_to_upload", false, "release_allowed", false, "live_1c_allowed", false, "execution_allowed", false],
  ]);
  styleBody(qa.getRange("A5:H10"));
  qa.getRange("A9:H10").format.fill = COLORS.yellow;
  const sourceTitle = qa.getRange("A12:H12");
  sourceTitle.merge();
  sourceTitle.values = [["Source files + SHA256"]];
  sourceTitle.format = { fill: COLORS.teal, font: { bold: true, color: COLORS.white }, rowHeight: 24, verticalAlignment: "center" };
  const qaSourceHeaders = ["Source type", "Source file", "SHA256", "Period", "Organization", "Sheet", "Physical row/range", "Evidence status"];
  writeMatrix(qa, 12, 0, [qaSourceHeaders]);
  styleHeader(qa.getRange("A13:H13"));
  const qaSourceRows = projection.sources.map((item) => [item.source_type, item.file, item.sha256, item.period, item.organization, item.sheet, item.physical_range, item.evidence_status]);
  if (qaSourceRows.length) {
    writeMatrix(qa, 13, 0, qaSourceRows);
    styleBody(qa.getRangeByIndexes(13, 0, qaSourceRows.length, qaSourceHeaders.length));
  }
  setWidths(qa, [28, 48, 28, 48, 28, 48, 28, 48]);
  qa.freezePanes.freezeRows(4);
  return workbook;
}

async function scanFormulaErrors(workbook, summary) {
  const result = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary,
  });
  const output = text(result?.ndjson);
  if (!output || /matched 0 entries/i.test(output)) return 0;
  return output.split(/\r?\n/).filter((line) => line.includes('"kind":"match"')).length || 1;
}

async function saveAndVerify(workbook, outputPath, expectedSheets, previewDir = "") {
  const actualSheets = workbook.worksheets.items.map((item) => item.name);
  if (JSON.stringify(actualSheets) !== JSON.stringify(expectedSheets)) throw new Error(`AUDIT_REGISTRY_SHEET_ORDER_MISMATCH: ${actualSheets.join("|")}`);
  const beforeErrors = await scanFormulaErrors(workbook, `${path.basename(outputPath)} pre-export formula scan`);
  if (beforeErrors !== 0) throw new Error(`AUDIT_REGISTRY_FORMULA_ERRORS_PRE_EXPORT:${beforeErrors}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await (await SpreadsheetFile.exportXlsx(workbook)).save(outputPath);
  const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const reopenedSheets = reopened.worksheets.items.map((item) => item.name);
  if (JSON.stringify(reopenedSheets) !== JSON.stringify(expectedSheets)) throw new Error(`AUDIT_REGISTRY_REOPENED_SHEET_ORDER_MISMATCH: ${reopenedSheets.join("|")}`);
  const afterErrors = await scanFormulaErrors(reopened, `${path.basename(outputPath)} reopened formula scan`);
  if (afterErrors !== 0) throw new Error(`AUDIT_REGISTRY_FORMULA_ERRORS_REOPENED:${afterErrors}`);
  if (text(previewDir)) {
    await fs.mkdir(previewDir, { recursive: true });
    for (const sheet of reopened.worksheets.items) {
      const used = sheet.getUsedRange();
      const rows = Math.min(used?.rowCount ?? 20, 24);
      const cols = Math.min(used?.columnCount ?? 8, 14);
      const end = `${columnLetter(Math.max(0, cols - 1))}${Math.max(1, rows)}`;
      const preview = await reopened.render({ sheetName: sheet.name, range: `A1:${end}`, scale: 1, format: "png" });
      const safeName = sheet.name.replace(/[<>:"/\\|?*]/g, "_");
      await fs.writeFile(path.join(previewDir, `${safeName}.png`), new Uint8Array(await preview.arrayBuffer()));
    }
  }
  return { sheet_count: reopenedSheets.length, formula_errors: 0 };
}

export async function buildAuditRegistryWorkbooks({
  correctionRegistryPath,
  discrepancyRegistryPath,
  metadata = {},
  decisions = [],
  actions = {},
  analyticalPolicy = null,
  sidecarPayload = null,
  sidecarPath = "",
  sidecarSha = "",
  previewDir = "",
  generatedAt,
} = {}) {
  if (!text(correctionRegistryPath) || !text(discrepancyRegistryPath)) throw new Error("AUDIT_REGISTRY_OUTPUT_PATHS_REQUIRED");
  const payload = sidecarPayload ?? (text(sidecarPath) ? JSON.parse(await fs.readFile(sidecarPath, "utf8")) : {});
  const actualSidecarSha = text(sidecarSha) || await sha256IfReadable(sidecarPath);
  const manifestPath = text(metadata?.r005ManifestPath)
    || (text(sidecarPath).endsWith(".codex-input.json") ? sidecarPath.replace(/\.codex-input\.json$/i, ".manifest.json") : "");
  const projection = buildAuditRegistryProjection({
    metadata: { ...metadata, r005ManifestPath: manifestPath, r005ManifestSha: text(metadata?.r005ManifestSha) || await sha256IfReadable(manifestPath) },
    decisions,
    actions,
    analyticalPolicy,
    sidecarPayload: payload,
    sidecarPath,
    sidecarSha: actualSidecarSha,
    generatedAt,
  });
  const correction = correctionWorkbook(projection);
  const discrepancy = discrepancyWorkbook(projection);
  const correctionVerification = await saveAndVerify(correction, correctionRegistryPath, CORRECTION_REGISTRY_SHEETS, text(previewDir) ? path.join(previewDir, "correction_registry") : "");
  const discrepancyVerification = await saveAndVerify(discrepancy, discrepancyRegistryPath, DISCREPANCY_REGISTRY_SHEETS, text(previewDir) ? path.join(previewDir, "discrepancy_registry") : "");
  return {
    projection,
    correction_registry: { path: correctionRegistryPath, sha256: await sha256IfReadable(correctionRegistryPath), ...correctionVerification },
    discrepancy_registry: { path: discrepancyRegistryPath, sha256: await sha256IfReadable(discrepancyRegistryPath), ...discrepancyVerification },
  };
}
