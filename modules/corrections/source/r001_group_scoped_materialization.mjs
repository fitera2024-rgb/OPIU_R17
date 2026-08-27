import {
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import { canonicalSpornoRowFromMaterializationCase } from "./r001_canonical_output_contract.mjs";
import {
  buildGroupScopedStornoRepostPlan,
  selectGroupScopedErpArticle,
} from "./r001_group_scoped_posting_rule.mjs";

export const GROUP_SCOPED_MATERIALIZATION_SCHEMA = "opiu-r001-group-scoped-materialization.v1";

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(text(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value) {
  if (value === true || value === false) return value;
  return ["TRUE", "1", "ДА", "YES"].includes(text(value).toUpperCase());
}

function slots(decision, prefix) {
  return [1, 2, 3].map((index) => text(decision?.[`${prefix}${index}`]));
}

function physicalOperation(decision) {
  return {
    source_organization: text(decision?.source_organization),
    source_archive_path: text(decision?.source_archive_path),
    source_archive_sha256: text(decision?.source_archive_sha256),
    journal_entry: text(decision?.journal_entry),
    journal_sha256: text(decision?.journal_sha256 || decision?.erp_source_sha256),
    source_sheet: text(decision?.source_sheet),
    source_range: text(decision?.source_range),
    source_row_id: text(decision?.source_row_id),
    date: text(decision?.source_date),
    document: text(decision?.registrar),
    posting_number: text(decision?.posting_number),
    debit: text(decision?.source_dt),
    credit: text(decision?.source_kt),
    debit_analytics: slots(decision, "source_analytics_dt"),
    credit_analytics: slots(decision, "source_analytics_kt"),
    debit_department: text(decision?.source_department_dt),
    credit_department: text(decision?.source_department_kt),
    amount: number(decision?.source_amount),
    article: text(decision?.source_article || decision?.group),
  };
}

function exactFinancialAuthority(decision) {
  return text(decision?.decision_type).toUpperCase() === "STORNO_REPOST"
    && bool(decision?.ECONOMIC_ROUTE_PROVEN)
    && bool(decision?.SOURCE_OPERATION_PROVEN)
    && bool(decision?.PHYSICAL_SOURCE_UNIQUE)
    && bool(decision?.ECONOMIC_CORRECTION_PROVEN);
}

function canonicalGroupScopedRow(materializationCase, plan, targetArticle) {
  const canonical = canonicalSpornoRowFromMaterializationCase(materializationCase);
  if (canonical.operation !== "REPOST") return canonical;
  const loader = {
    ...canonical.loader,
    "ПравилоДт": plan.operating_side === "DEBIT" ? targetArticle.article_code : null,
    "ПравилоКт": plan.operating_side === "CREDIT" ? targetArticle.article_code : null,
  };
  return createCanonicalPostingRow({
    materialization_case: canonical.materialization_case,
    operation: canonical.operation,
    output_route: canonical.output_route,
    materialization_state: canonical.materialization_state,
    audit_identity: canonical.audit_identity,
    amount: canonical.amount,
    result_accounting: canonical.result_accounting,
    loader,
    safety: REPORT_ONLY_SAFETY,
  });
}

function caseFor({ decision, action, role, operation, targetAccounting, targetArticle, amount, reason }) {
  return createMaterializationCase({
    case_id: `${text(decision.case_id)}-GROUP-${action}`,
    pair_id: text(decision.pair_id || decision.case_id),
    period: text(decision.period),
    reconciliation_organization: text(decision.reconciliation_organization || decision.organization),
    action,
    role,
    signed_economic_effect: action === "STORNO" ? -amount : amount,
    correction_amount: amount,
    economic: {
      source_code: text(decision.reconciliation_row),
      target_code: targetArticle.article_code,
      source_article: operation.article,
      target_article: targetArticle.article,
    },
    proof_status: "GROUP_SCOPED_ARTICLE_REPLACEMENT_PROVEN",
    correction_allowed: false,
    correction_authority: "GROUP_SCOPED_ARTICLE_REPLACEMENT",
    output_route: "SPORNO",
    physical_source: operation,
    target_accounting: targetAccounting,
    physical_proof: {
      source_operation_proven: true,
      physical_source_unique: true,
      target_classification_proven: true,
    },
    analytical_basis: {
      reconciliation_row: text(decision.reconciliation_row),
      analytical_basis_id: text(decision.case_id),
      effective_delta: action === "STORNO" ? -amount : amount,
    },
    economic_route: {
      route_id: text(decision.pair_id || decision.case_id),
      proof_status: "PROVEN",
      accepted: true,
      accepted_amount: amount,
      accepted_effect: action === "STORNO" ? -amount : amount,
      processing_stage: text(decision.processing_stage || "GROUP_SCOPED_ARTICLE_REPLACEMENT"),
      stage_order: number(decision.stage_order) ?? 1,
    },
    source_scope: {},
    business_evidence: {
      intalev_references: [
        ...(Array.isArray(decision?.intalev_references) ? decision.intalev_references : []),
        ...(Array.isArray(decision?.intalev_sources) ? decision.intalev_sources : []),
      ],
      intalev_technical_reference: text(decision?.intalev_technical_reference),
      intalev_document_absent: decision?.intalev_document_absent === true,
    },
    reason,
    blockers: [],
    provenance: { source: "CURRENT_RUN_GROUP_SCOPED_RULE" },
    safety: REPORT_ONLY_SAFETY,
  });
}

/**
 * Evaluates every article generically. A unique target can be reported even
 * when the physical source is incomplete, but A:AA rows are created only when
 * all current-run economic and physical authority gates pass.
 */
export function evaluateGroupScopedDecision({
  decision,
  catalogNodes = [],
  intalevBlock = "",
  intalevPath = "",
} = {}) {
  const articleLabel = text(decision?.target_article || decision?.source_article || decision?.group);
  let targetArticle;
  try {
    targetArticle = selectGroupScopedErpArticle(catalogNodes, {
      intalevPath,
      blockLabel: intalevBlock,
      articleLabel,
    });
  } catch (error) {
    return Object.freeze({
      schema_version: GROUP_SCOPED_MATERIALIZATION_SCHEMA,
      status: "BLOCKED_TARGET_SELECTION",
      target_article: null,
      canonical_posting_rows: Object.freeze([]),
      blockers: Object.freeze([text(error?.code || error?.message || "GROUP_SCOPED_TARGET_SELECTION_FAILED")]),
    });
  }

  if (!exactFinancialAuthority(decision)) {
    return Object.freeze({
      schema_version: GROUP_SCOPED_MATERIALIZATION_SCHEMA,
      status: "TARGET_RESOLVED_REVIEW_ONLY",
      target_article: targetArticle,
      canonical_posting_rows: Object.freeze([]),
      blockers: Object.freeze(["EXACT_ECONOMIC_AND_PHYSICAL_AUTHORITY_REQUIRED"]),
    });
  }

  try {
    const operation = physicalOperation(decision);
    const correctionAmount = number(decision?.correction_amount);
    const partialAmountProven = bool(decision?.partial_source_amount_proven);
    const correctionCents = Math.round(Math.abs(correctionAmount ?? 0) * 100);
    const operationCents = Math.round(Math.abs(operation.amount ?? 0) * 100);
    if (correctionAmount === null || operation.amount === null
      || correctionCents <= 0
      || (partialAmountProven ? correctionCents > operationCents : correctionCents !== operationCents)) {
      const mismatch = new Error(partialAmountProven
        ? "Proven partial correction amount must not exceed the physical source amount"
        : "Exact physical amount must equal the accepted correction amount");
      mismatch.code = "GROUP_SCOPED_AMOUNT_MISMATCH";
      throw mismatch;
    }
    const plan = buildGroupScopedStornoRepostPlan({
      operation,
      targetArticle,
      settlementAccount: decision?.settlement_account,
      sourceOperatingAccount: decision?.source_operating_account,
      articleAnalyticsSlot: number(decision?.target_subkonto_slot) ?? 1,
      correctionAmount,
    });
    const reason = [
      "Одноимённая статья ERP выбрана только внутри блока Инталев",
      `Блок=${intalevBlock}`,
      `Каталог=${targetArticle.catalog_path}`,
      `Сторно=${plan.source_operating_account}`,
      `Репост=${plan.target_operating_account}`,
    ].join(" | ");
    const stornoCase = caseFor({
      decision,
      action: "STORNO",
      role: "RECLASS_SOURCE",
      operation,
      targetAccounting: plan.storno,
      targetArticle,
      amount: plan.amount,
      reason,
    });
    const repostCase = caseFor({
      decision,
      action: "REPOST",
      role: "RECLASS_TARGET",
      operation,
      targetAccounting: plan.repost,
      targetArticle,
      amount: plan.amount,
      reason,
    });
    return Object.freeze({
      schema_version: GROUP_SCOPED_MATERIALIZATION_SCHEMA,
      status: "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST",
      target_article: targetArticle,
      plan,
      canonical_posting_rows: Object.freeze([
        canonicalGroupScopedRow(stornoCase, plan, targetArticle),
        canonicalGroupScopedRow(repostCase, plan, targetArticle),
      ]),
      blockers: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      schema_version: GROUP_SCOPED_MATERIALIZATION_SCHEMA,
      status: "BLOCKED_PHYSICAL_MATERIALIZATION",
      target_article: targetArticle,
      canonical_posting_rows: Object.freeze([]),
      blockers: Object.freeze([text(error?.code || error?.message || "GROUP_SCOPED_MATERIALIZATION_FAILED")]),
    });
  }
}
