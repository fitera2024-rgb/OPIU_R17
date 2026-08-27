import crypto from "node:crypto";

export const PROOF_STATUSES = Object.freeze([
  "PROVEN",
  "INFERRED",
  "UNPROVEN",
  "USER_ACCEPTED",
]);

export const CORRECTION_FAMILIES = Object.freeze([
  "STORNO_REPOST",
  "ONE_SIDED",
  "DELETE_DRAFT",
  "DISPUTED_CORRECTION",
  "NO_CORRECTION_NEEDED",
]);

const PROOF_STATUS_SET = new Set(PROOF_STATUSES);
const NON_POSTING_DECISIONS = new Set(["UPDATE_MAPPING", "UPDATE_FORMULA"]);
const PENDING_REVIEW_STATES = new Set(["PENDING", "NEEDS_REVIEW", "REVIEW_REQUIRED"]);
const EPSILON = 0.000001;

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function finiteNumber(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const normalized = typeof value === "string" ? value.replace(/\s/g, "").replace(",", ".") : value;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function rounded(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && text(value) !== "");
}

function array(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined || text(value) === "" ? [] : [value];
}

function stableId(prefix, payload) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase();
  return `${prefix}-${digest.slice(0, 20)}`;
}

function isMonthlyPeriod(value) {
  const match = text(value).match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  return Boolean(match);
}

function isExplicitUserAcceptance(record) {
  const approval = upper(record?.approval_state);
  return record?.user_accepted === true
    || record?.owner_accepted === true
    || record?.user_acceptance?.accepted === true
    || ["USER_ACCEPTED", "ПРИНЯТО ПОЛЬЗОВАТЕЛЕМ", "ПРИНЯТО ВЛАДЕЛЬЦЕМ"].includes(approval);
}

export function normalizeCorrectionFamily(decisionType, proofStatus = "") {
  const type = upper(decisionType);
  if (type === "STORNO_REPOST") return "STORNO_REPOST";
  if (["ADD_ONE_SIDE", "ONE_SIDED"].includes(type)) return "ONE_SIDED";
  if (["DELETE_OPERATION", "DELETE_POSTING", "DELETE_DRAFT"].includes(type)) return "DELETE_DRAFT";
  if (type === "DISPUTED_CORRECTION") return "DISPUTED_CORRECTION";
  if (type === "NO_POSTING" || type === "NO_CORRECTION_NEEDED") return "NO_CORRECTION_NEEDED";
  return "";
}

export function deriveProofStatus(record = {}) {
  const requested = upper(first(record.proof_status, record.evidence_state));
  const explicitAcceptance = isExplicitUserAcceptance(record);
  if (requested === "USER_ACCEPTED" || explicitAcceptance) {
    if (explicitAcceptance) {
      return {
        proof_status: "USER_ACCEPTED",
        original_proof_status: [upper(record.original_proof_status), requested]
          .find((status) => PROOF_STATUS_SET.has(status) && status !== "USER_ACCEPTED") ?? "UNPROVEN",
        proof_status_trace: "USER_ACCEPTED_FROM_EXPLICIT_OWNER_STATE",
      };
    }
    return {
      proof_status: "UNPROVEN",
      original_proof_status: "UNPROVEN",
      proof_status_trace: "USER_ACCEPTED_REJECTED_WITHOUT_EXPLICIT_OWNER_STATE",
    };
  }
  if (["PROVEN", "INFERRED", "UNPROVEN"].includes(requested)) {
    return {
      proof_status: requested,
      original_proof_status: requested,
      proof_status_trace: `EXPLICIT_${requested}`,
    };
  }
  const approval = upper(record.approval_state);
  if (["ДОКАЗАНО_СВЕРКОЙ", "PROVEN"].includes(approval)) {
    return {
      proof_status: "PROVEN",
      original_proof_status: "PROVEN",
      proof_status_trace: "LEGACY_PROVEN_APPROVAL_STATE",
    };
  }
  return {
    proof_status: "UNPROVEN",
    original_proof_status: "UNPROVEN",
    proof_status_trace: "FAIL_CLOSED_DEFAULT_UNPROVEN",
  };
}

function analyticalEffect(record) {
  for (const key of ["analytical_effect", "correction_effect", "delta"]) {
    const value = finiteNumber(record?.[key]);
    if (value !== null) return { value: rounded(value), trace: `SIGNED_${key.toUpperCase()}` };
  }
  const signedAmount = finiteNumber(first(record?.amount, record?.correction_amount));
  if (signedAmount === null) return { value: null, trace: "MISSING_AMOUNT_OR_EFFECT" };
  if (signedAmount < 0) return { value: rounded(signedAmount), trace: "SIGNED_NEGATIVE_AMOUNT" };
  const direction = upper(first(record?.effect_direction, record?.analytical_direction));
  if (["INCREASE", "PLUS", "+", "УВЕЛИЧЕНИЕ"].includes(direction)) {
    return { value: rounded(Math.abs(signedAmount)), trace: "AMOUNT_WITH_INCREASE_DIRECTION" };
  }
  if (["DECREASE", "MINUS", "-", "УМЕНЬШЕНИЕ"].includes(direction)) {
    return { value: rounded(-Math.abs(signedAmount)), trace: "AMOUNT_WITH_DECREASE_DIRECTION" };
  }
  return { value: null, trace: "UNSIGNED_AMOUNT_REQUIRES_ANALYTICAL_DIRECTION" };
}

function evidenceReferences(record) {
  const values = [
    ...array(record?.evidence_references),
    ...array(record?.evidence_refs),
    record?.source_range,
    record?.registrar,
    record?.posting_number,
    record?.erp_source_sha256,
    record?.gap_evidence_ref,
  ].map((value) => value && typeof value === "object" ? JSON.stringify(value) : text(value)).filter(Boolean);
  return [...new Set(values)];
}

function targetDescription(record) {
  return {
    target_article: text(first(
      record?.target_article,
      record?.target_analytics_dt1,
      record?.target_analytics_kt1,
    )),
    disclosure_group: text(first(record?.disclosure_group, record?.group)),
    target_side: text(first(
      record?.target_side,
      record?.direction,
      record?.change_side,
      record?.target_dt ? `DEBIT:${text(record.target_dt)}` : "",
      record?.target_kt ? `CREDIT:${text(record.target_kt)}` : "",
    )),
  };
}

function optionalAnalytics(record) {
  const fields = {
    target_account_dt: record?.target_dt,
    target_account_kt: record?.target_kt,
    target_analytics_dt1: record?.target_analytics_dt1,
    target_analytics_dt2: record?.target_analytics_dt2,
    target_analytics_dt3: record?.target_analytics_dt3,
    target_analytics_kt1: record?.target_analytics_kt1,
    target_analytics_kt2: record?.target_analytics_kt2,
    target_analytics_kt3: record?.target_analytics_kt3,
    target_department_dt: record?.target_department_dt,
    target_department_kt: record?.target_department_kt,
  };
  const analytics = {};
  const missing = [];
  for (const [key, value] of Object.entries(fields)) {
    analytics[key] = text(value) || "UNKNOWN";
    if (!text(value)) missing.push(key);
  }
  return { analytics, missing };
}

function blocker(code, record, details, effect = null) {
  return {
    blocker_code: code,
    organization: text(record?.organization),
    period: text(record?.period),
    trace_id: text(first(record?.pair_id, record?.draft_id, record?.upload_id, record?.case_id)),
    unresolved_effect: effect,
    details: array(details).map(text).filter(Boolean),
  };
}

function draftFromCorrection(record, selectedOrganization, selectedPeriod) {
  const organization = text(record?.organization);
  const period = text(record?.period);
  const decisionType = upper(record?.decision_type);
  const proof = deriveProofStatus(record);
  const family = normalizeCorrectionFamily(
    decisionType,
    proof.proof_status === "USER_ACCEPTED" ? proof.original_proof_status : proof.proof_status,
  );
  const effect = analyticalEffect(record);
  const target = targetDescription(record);
  const reason = text(first(record?.reason, record?.explanation, record?.proof_reason));
  const traceId = text(first(record?.pair_id, record?.draft_id, record?.upload_id, record?.case_id))
    || stableId("DRAFT", [organization, period, decisionType, target, effect.value, reason]);

  if ((organization && organization !== selectedOrganization) || (period && period !== selectedPeriod)) {
    return {
      ignored: true,
      blocker: blocker("CONTEXT_ISOLATION", { ...record, pair_id: traceId }, [
        `Expected ${selectedOrganization}/${selectedPeriod}`,
        `Received ${organization || "MISSING"}/${period || "MISSING"}`,
      ], effect.value),
    };
  }
  if (NON_POSTING_DECISIONS.has(decisionType)) {
    return {
      ignored: true,
      historicalDecision: {
        decision_type: decisionType,
        correction_family: "",
        trace_id: traceId,
        posting_created: false,
        mapping_changed: false,
        formulas_changed: false,
      },
    };
  }
  if (family === "NO_CORRECTION_NEEDED") {
    return {
      noCorrection: {
        organization,
        period,
        correction_family: family,
        proof_status: proof.proof_status,
        trace_id: traceId,
        analytical_effect: 0,
        posting_created: false,
      },
    };
  }

  const missing = [];
  if (!organization) missing.push("organization");
  if (!isMonthlyPeriod(period)) missing.push("period_YYYY_MM");
  if (!target.target_article && !target.disclosure_group) missing.push("target_article_or_disclosure_group");
  if (effect.value === null || Math.abs(effect.value) < EPSILON) missing.push("signed_amount_or_effect");
  if (!target.target_side) missing.push("target_side_or_direction");
  if (!PROOF_STATUS_SET.has(proof.proof_status)) missing.push("proof_status");
  if (!reason) missing.push("reason_or_explanation");
  if (!family) missing.push("supported_correction_family");
  if (missing.length) {
    return {
      blocker: blocker(
        "MISSING_MINIMUM_TARGET_ATTRIBUTES",
        { ...record, pair_id: traceId },
        [...missing, effect.trace],
        effect.value,
      ),
    };
  }

  const optional = optionalAnalytics(record);
  const reviewState = text(record?.review_state)
    || (proof.proof_status === "USER_ACCEPTED" ? "ACCEPTED" : ["INFERRED", "UNPROVEN"].includes(proof.proof_status) ? "NEEDS_REVIEW" : "NOT_REQUIRED");
  const draft = {
    draft_id: text(record?.draft_id) || stableId("DRAFT", [traceId, organization, period, family, effect.value]),
    pair_id: text(record?.pair_id),
    upload_id: text(record?.upload_id),
    trace_id: traceId,
    organization,
    period,
    correction_family: family,
    legacy_decision_type: decisionType,
    analytical_effect: effect.value,
    analytical_effect_trace: effect.trace,
    proof_status: proof.proof_status,
    original_proof_status: proof.original_proof_status,
    proof_status_trace: proof.proof_status_trace,
    proof_history: [...new Set([
      ...array(record?.proof_history).map(upper).filter(Boolean),
      proof.original_proof_status,
      proof.proof_status,
    ])],
    ...target,
    analytics: optional.analytics,
    missing_or_unknown_analytics: optional.missing,
    analytics_review_state: optional.missing.length ? "NEEDS_REVIEW" : "COMPLETE",
    reason,
    evidence_references: evidenceReferences(record),
    review_state: reviewState,
    analytical_only: true,
    loader_row_created: false,
    executable: false,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_delete_allowed: false,
    live_1c_allowed: false,
  };
  const reviewRequired = ["INFERRED", "UNPROVEN"].includes(proof.proof_status)
    || (proof.proof_status === "USER_ACCEPTED" && PENDING_REVIEW_STATES.has(upper(reviewState)));
  const review = reviewRequired ? {
    organization,
    period,
    correction_family: family,
    analytical_effect: effect.value,
    proof_status: proof.proof_status,
    original_proof_status: proof.original_proof_status,
    target_side: target.target_side,
    target_article: target.target_article,
    disclosure_group: target.disclosure_group,
    missing_or_unknown_analytics: optional.missing,
    reason,
    evidence_references: draft.evidence_references,
    pair_id: draft.pair_id,
    draft_id: draft.draft_id,
    upload_id: draft.upload_id,
    trace_id: traceId,
    review_state: reviewState,
    executable: false,
  } : null;
  return { draft, review };
}

export function buildAnalyticalContext({
  organization,
  period,
  erp_current: erpCurrentInput,
  intalev_target: intalevTargetInput,
  corrections = [],
} = {}) {
  const selectedOrganization = text(organization);
  const selectedPeriod = text(period);
  const erpCurrent = finiteNumber(erpCurrentInput);
  const intalevTarget = finiteNumber(intalevTargetInput);
  const drafts = [];
  const reviewList = [];
  const blockers = [];
  const ignoredContextRows = [];
  const historicalNonPostingDecisions = [];
  const noCorrectionNeeded = [];
  const seenDraftIds = new Set();

  if (!selectedOrganization) blockers.push(blocker("MISSING_CONTEXT_ORGANIZATION", {}, "organization is required"));
  if (!isMonthlyPeriod(selectedPeriod)) blockers.push(blocker("MISSING_OR_INVALID_CONTEXT_PERIOD", {}, "period must be YYYY-MM"));
  if (erpCurrent === null) blockers.push(blocker("MISSING_ERP_CURRENT", { organization, period }, "ERP_CURRENT must be numeric"));
  if (intalevTarget === null) blockers.push(blocker("MISSING_INTALEV_TARGET", { organization, period }, "INTALEV_TARGET must be numeric"));

  for (const correction of array(corrections)) {
    const result = draftFromCorrection(correction, selectedOrganization, selectedPeriod);
    if (result.draft && seenDraftIds.has(result.draft.draft_id)) {
      blockers.push(blocker("DUPLICATE_ANALYTICAL_DRAFT", result.draft, `Duplicate DraftID ${result.draft.draft_id}`));
    } else if (result.draft) {
      seenDraftIds.add(result.draft.draft_id);
      drafts.push(result.draft);
      if (result.review) reviewList.push(result.review);
    }
    if (result.blocker) blockers.push(result.blocker);
    if (result.ignored && result.blocker) ignoredContextRows.push(result.blocker);
    if (result.historicalDecision) historicalNonPostingDecisions.push(result.historicalDecision);
    if (result.noCorrection) noCorrectionNeeded.push(result.noCorrection);
  }

  const analyticalEffectCents = drafts.reduce((sum, item) => sum + Math.round(item.analytical_effect * 100), 0);
  const analyticalEffect = analyticalEffectCents / 100;
  const erpCurrentCents = erpCurrent === null ? null : Math.round(erpCurrent * 100);
  const intalevTargetCents = intalevTarget === null ? null : Math.round(intalevTarget * 100);
  const erpAfterCents = erpCurrentCents === null ? null : erpCurrentCents + analyticalEffectCents;
  const residualCents = erpAfterCents === null || intalevTargetCents === null ? null : intalevTargetCents - erpAfterCents;
  const erpAfter = erpAfterCents === null ? null : erpAfterCents / 100;
  const residual = residualCents === null ? null : residualCents / 100;
  const proofStatusCounts = Object.fromEntries(PROOF_STATUSES.map((status) => [status, 0]));
  for (const draft of drafts) proofStatusCounts[draft.proof_status] += 1;
  const unresolvedEffect = blockers
    .filter((item) => item.blocker_code !== "CONTEXT_ISOLATION")
    .reduce((sum, item) => sum + Math.round((finiteNumber(item.unresolved_effect) ?? 0) * 100), 0) / 100;

  return {
    schema_version: "r001-analytical-policy-1.0.0",
    organization: selectedOrganization,
    period: selectedPeriod,
    scenario: {
      ERP_CURRENT: erpCurrent === null ? null : rounded(erpCurrent),
      INTALEV_TARGET: intalevTarget === null ? null : rounded(intalevTarget),
      ANALYTICAL_DRAFT_CORRECTIONS: analyticalEffect,
      ERP_AFTER_CORRECTIONS: erpAfter,
      RESIDUAL_DELTA: residual,
      UNRESOLVED_BLOCKED_EFFECT: unresolvedEffect,
      identity_holds: erpAfterCents === null ? false : erpCurrentCents + analyticalEffectCents === erpAfterCents,
      target_closed: residualCents === null ? false : residualCents === 0,
    },
    analytical_draft_corrections: drafts,
    review_required: reviewList,
    blockers,
    ignored_context_rows: ignoredContextRows,
    historical_non_posting_decisions: historicalNonPostingDecisions,
    no_correction_needed: noCorrectionNeeded,
    counts: {
      analytical_draft_corrections: drafts.length,
      review_required: reviewList.length,
      blockers: blockers.length,
      ignored_context_rows: ignoredContextRows.length,
      structurally_generated_loader_draft_rows: 0,
      live_executable_rows: 0,
    },
    proof_status_counts: proofStatusCounts,
    safety: {
      execution_allowed: false,
      live_posting_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      live_delete_allowed: false,
      live_1c_allowed: false,
    },
  };
}

export function aggregateAnnualMonthlyResults(monthlyResults = [], { organization = "", year = "" } = {}) {
  const selectedYear = text(year) || text(monthlyResults?.[0]?.period).match(/^(\d{4})-/)?.[1] || "";
  const expectedMonths = /^\d{4}$/.test(selectedYear)
    ? Array.from({ length: 12 }, (_, index) => `${selectedYear}-${String(index + 1).padStart(2, "0")}`)
    : [];
  const selectedOrganization = text(organization) || text(monthlyResults?.[0]?.organization);
  const blockers = [];
  if (!expectedMonths.length) blockers.push({ blocker_code: "ANNUAL_YEAR_REQUIRED", year: selectedYear });
  const byPeriod = new Map();
  for (const result of array(monthlyResults)) {
    const resultOrganization = text(result?.organization);
    const resultPeriod = text(result?.period);
    if (resultOrganization !== selectedOrganization) {
      blockers.push({ blocker_code: "ANNUAL_ORGANIZATION_ISOLATION", organization: resultOrganization, period: resultPeriod });
      continue;
    }
    if (!expectedMonths.includes(resultPeriod)) {
      blockers.push({ blocker_code: "ANNUAL_REQUIRES_SELECTED_YEAR_MONTH_PERIOD", organization: resultOrganization, period: resultPeriod, year: selectedYear });
      continue;
    }
    if (byPeriod.has(resultPeriod)) {
      blockers.push({ blocker_code: "DUPLICATE_MONTH", organization: resultOrganization, period: resultPeriod });
      continue;
    }
    byPeriod.set(resultPeriod, result);
  }
  const missingMonths = expectedMonths.filter((month) => !byPeriod.has(month));
  if (missingMonths.length) blockers.push({ blocker_code: "ANNUAL_REQUIRES_12_RECONCILED_MONTHS", missing_months: missingMonths });
  for (const month of expectedMonths) {
    const result = byPeriod.get(month);
    if (!result) continue;
    const requiredScenarioFields = [
      "ERP_CURRENT",
      "INTALEV_TARGET",
      "ANALYTICAL_DRAFT_CORRECTIONS",
      "ERP_AFTER_CORRECTIONS",
      "RESIDUAL_DELTA",
    ];
    const scenarioValues = Object.fromEntries(requiredScenarioFields.map((field) => [field, finiteNumber(result?.scenario?.[field])]));
    const missingFields = requiredScenarioFields.filter((field) => scenarioValues[field] === null);
    if (missingFields.length) {
      blockers.push({ blocker_code: "MONTH_SCENARIO_INCOMPLETE", organization: selectedOrganization, period: month, missing_fields: missingFields });
      continue;
    }
    const identityHolds = Math.round(scenarioValues.ERP_CURRENT * 100)
      + Math.round(scenarioValues.ANALYTICAL_DRAFT_CORRECTIONS * 100)
      === Math.round(scenarioValues.ERP_AFTER_CORRECTIONS * 100);
    const targetHolds = Math.round(scenarioValues.ERP_AFTER_CORRECTIONS * 100)
      === Math.round(scenarioValues.INTALEV_TARGET * 100)
      && Math.round(scenarioValues.RESIDUAL_DELTA * 100) === 0;
    if (!identityHolds || !targetHolds) {
      blockers.push({ blocker_code: "MONTH_NOT_RECONCILED", organization: selectedOrganization, period: month, residual_delta: scenarioValues.RESIDUAL_DELTA });
    }
  }
  if (blockers.length) {
    return {
      schema_version: "r001-annual-1.0.0",
      organization: selectedOrganization,
      year: selectedYear,
      annual_summary: null,
      synthetic_annual_corrections: [],
      blockers,
      ready: false,
    };
  }
  const totalCents = {
    ERP_CURRENT: 0,
    INTALEV_TARGET: 0,
    ANALYTICAL_DRAFT_CORRECTIONS: 0,
    ERP_AFTER_CORRECTIONS: 0,
    RESIDUAL_DELTA: 0,
  };
  for (const month of expectedMonths) {
    const scenario = byPeriod.get(month).scenario;
    for (const key of Object.keys(totalCents)) totalCents[key] += Math.round((finiteNumber(scenario[key]) ?? 0) * 100);
  }
  const totals = Object.fromEntries(Object.entries(totalCents).map(([key, value]) => [key, value / 100]));
  return {
    schema_version: "r001-annual-1.0.0",
    organization: selectedOrganization,
    year: selectedYear,
    source_months: expectedMonths,
    annual_summary: totals,
    synthetic_annual_corrections: [],
    blockers: [],
    ready: true,
  };
}

// Backward-compatible export for the accepted 2025 baseline callers.
export function aggregate2025MonthlyResults(monthlyResults = [], options = {}) {
  return aggregateAnnualMonthlyResults(monthlyResults, { ...options, year: "2025" });
}
