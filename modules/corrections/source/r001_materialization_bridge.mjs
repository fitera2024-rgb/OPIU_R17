import {
  MaterializationContractError,
  REPORT_ONLY_SAFETY,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import {
  relevantIntalevAbsenceProof,
} from "../../reconciliation/source/intalev_source_scope.mjs";

export const R001_MATERIALIZATION_BRIDGE_SCHEMA =
  "opiu-r001-materialization-bridge.v1";

const FINANCIAL_ACTIONS = new Set(["STORNO", "REPOST"]);
const NON_FINANCIAL_ACTIONS = new Set([
  "NO_POSTING",
  "UPDATE_MAPPING",
  "UPDATE_FORMULA",
  "DELETE_OPERATION",
  "DELETE_POSTING",
]);

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) { return text(value).toUpperCase(); }

function number(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function first(...values) { return values.map(text).find(Boolean) ?? ""; }

function slots(decision, prefix) {
  const direct = decision?.[`${prefix}_analytics`];
  if (Array.isArray(direct)) return [0, 1, 2].map((index) => text(direct[index]));
  const [scope, side] = prefix.split("_");
  return [1, 2, 3].map((index) => first(
    decision?.[`${scope}_analytics_${side}${index}`],
    decision?.[`${prefix}_analytics_${index}`],
  ));
}

function decisionBlockers(decision) {
  const values = [
    ...(Array.isArray(decision?.blockers) ? decision.blockers : []),
    ...(Array.isArray(decision?.basis_contract_blockers) ? decision.basis_contract_blockers : []),
    ...(Array.isArray(decision?.missing_proof) ? decision.missing_proof : []),
    decision?.unproven_reason,
  ];
  return [...new Set(values.map(text).filter(Boolean))];
}

function economicAccepted(decision) {
  const authority = upper(decision?.correction_authority);
  return decision?.accepted_economic_reclass === true
    || decision?.accepted_intergroup_reclass === true
    || decision?.accepted_intragroup_reclass === true
    || decision?.ECONOMIC_CORRECTION_PROVEN === true
    || decision?.economic_correction_proven === true
    || decision?.correction_allowed === true
    || ["ECONOMIC_CORRECTION_PROVEN", "USER_ACCEPTED"].includes(authority);
}

function directionFor(decision) {
  const explicit = upper(decision?.economic_direction || decision?.action);
  if (FINANCIAL_ACTIONS.has(explicit)) return explicit;
  const type = upper(decision?.decision_type);
  if (FINANCIAL_ACTIONS.has(type)) return type;
  if (type !== "STORNO_REPOST" || !economicAccepted(decision)) return "";
  const role = upper(decision?.role);
  if (role === "RECLASS_SOURCE") return "STORNO";
  if (role === "RECLASS_TARGET") return "REPOST";
  return "";
}

function roleFor(decision) {
  const role = upper(decision?.role);
  if (["RECLASS_SOURCE", "RECLASS_TARGET", "STANDALONE"].includes(role)) return role;
  return "STANDALONE";
}

function physicalSource(decision) {
  return {
    // Deliberately no fallback to decision.organization: report organization
    // is not evidence of the legal organization of the physical ERP row.
    source_organization: first(
      decision?.source_organization,
      decision?.source_organization_alias_verified === true ? decision?.source_organization_raw : "",
    ),
    source_archive_path: first(decision?.source_archive_path, decision?.erp_source_archive_path),
    source_archive_sha256: first(decision?.source_archive_sha256, decision?.erp_source_archive_sha256),
    journal_entry: first(decision?.journal_entry, decision?.erp_journal_entry),
    journal_sha256: first(decision?.journal_sha256, decision?.erp_journal_sha256),
    source_sheet: first(decision?.source_sheet, decision?.erp_source_sheet),
    source_range: first(decision?.source_range, decision?.source_rows),
    source_row_id: first(decision?.source_row_id, decision?.source_financial_record_id),
    date: first(decision?.source_date, decision?.date),
    document: first(decision?.registrar, decision?.document),
    posting_number: first(decision?.posting_number, decision?.posting_no),
    debit: first(decision?.source_dt, decision?.debit),
    credit: first(decision?.source_kt, decision?.credit),
    debit_analytics: slots(decision, "source_dt"),
    credit_analytics: slots(decision, "source_kt"),
    debit_department: first(decision?.source_department_dt, decision?.debit_department),
    credit_department: first(decision?.source_department_kt, decision?.credit_department),
    amount: number(decision?.source_amount),
    activity: first(decision?.source_activity, decision?.activity),
    scenario: first(decision?.source_scenario, decision?.scenario),
  };
}

function targetAccounting(decision) {
  return {
    debit: first(decision?.target_dt),
    credit: first(decision?.target_kt),
    debit_analytics: slots(decision, "target_dt"),
    credit_analytics: slots(decision, "target_kt"),
    debit_department: first(decision?.target_department_dt),
    credit_department: first(decision?.target_department_kt),
    article: first(decision?.target_article, decision?.target_classification),
  };
}

function physicallyComplete(source) {
  const required = [
    source.source_organization,
    source.source_archive_path,
    source.source_archive_sha256,
    source.journal_entry,
    source.journal_sha256,
    source.source_range,
    source.source_row_id,
    source.date,
    source.document,
    source.posting_number,
    source.debit,
    source.credit,
    source.debit_department,
    source.credit_department,
  ];
  return required.every((value) => text(value))
    && source.debit_analytics.every((value) => text(value))
    && source.credit_analytics.every((value) => text(value))
    && number(source.amount) !== null;
}

function physicalProofAccepted(decision) {
  return decision?.SOURCE_OPERATION_PROVEN === true
    && decision?.PHYSICAL_SOURCE_UNIQUE === true;
}

function normalizedRequestedRoute(decision) {
  const route = upper(decision?.output_route);
  if (route === "СПОРНО") return "SPORNO";
  if (["READY", "SPORNO", "REVIEW_ONLY"].includes(route)) return route;
  return "";
}

function outputRoute(decision, action, source, blockers) {
  if (action === "ADD_ONE_SIDE") return "REVIEW_ONLY";
  const requested = normalizedRequestedRoute(decision);
  if (requested === "REVIEW_ONLY") return "REVIEW_ONLY";
  if (requested === "READY") {
    if (action === "STORNO" && relevantIntalevAbsenceProof(decision).proven) {
      // Upstream physical proof is necessary but not sufficient for this
      // standalone route. The exact-source verifier must reopen the pinned ERP source before it
      // can promote the canonical case to READY.
      blockers.push("EXACT_SOURCE_REOPEN_REQUIRED_FOR_READY");
      return "SPORNO";
    }
    if (decision?.correction_allowed === true
      && physicalProofAccepted(decision)
      && physicallyComplete(source)) return "READY";
    blockers.push("PHYSICAL_SOURCE_PROOF_INCOMPLETE_FOR_READY");
    return "SPORNO";
  }
  return "SPORNO";
}

function blankOrStructuralBlocker(decision) {
  const statuses = [
    decision?.classification,
    decision?.source_presence_classification,
    decision?.source_scope_status,
    decision?.evidence_state,
  ].map(upper);
  if (statuses.some((value) => value.startsWith("STRUCTURAL_GROUP_"))) {
    return "STRUCTURAL_CONTROL_NON_FINANCIAL";
  }
  if (statuses.some((value) => value.includes("EMPTY_ARTICLE") || value.includes("PRESENT_UNCLASSIFIED"))
    && !economicAccepted(decision)) {
    return "BLANK_UNCLASSIFIED_HAS_NO_FINANCIAL_AUTHORITY";
  }
  return "";
}

function skip(index, decision, blocker) {
  return Object.freeze({
    upstream_decision_index: index,
    case_id: text(decision?.case_id),
    pair_id: text(decision?.pair_id),
    decision_type: upper(decision?.decision_type),
    blocker,
  });
}

function bridgeOne(decision, index, provenance) {
  const type = upper(decision?.decision_type);
  const erpOnly = upper(decision?.classification) === "ERP_ONLY";
  const intalevAbsenceProof = erpOnly ? relevantIntalevAbsenceProof(decision) : null;
  const structuralOrBlank = blankOrStructuralBlocker(decision);
  if (structuralOrBlank) return { skipped: skip(index, decision, structuralOrBlank) };
  if (NON_FINANCIAL_ACTIONS.has(type)) {
    return { skipped: skip(index, decision, `${type || "NON_FINANCIAL"}_NON_FINANCIAL`) };
  }

  let action = directionFor(decision);
  if (!action && type === "ADD_ONE_SIDE") action = "ADD_ONE_SIDE";
  if (!action) {
    return { skipped: skip(index, decision, "ECONOMIC_DIRECTION_UNPROVEN") };
  }

  const correctionAmount = number(decision?.correction_amount)
    ?? Math.abs(number(decision?.analytical_effect) ?? 0);
  const upstreamEffect = number(decision?.analytical_effect)
    ?? number(decision?.accepted_intergroup_effect)
    ?? number(decision?.accepted_intragroup_effect);
  const signedEffect = upstreamEffect ?? (action === "STORNO"
    ? -Math.abs(correctionAmount)
    : action === "REPOST" ? Math.abs(correctionAmount) : 0);
  if (FINANCIAL_ACTIONS.has(action) && correctionAmount <= 0) {
    return { skipped: skip(index, decision, "NONPOSITIVE_CORRECTION_AMOUNT") };
  }
  if ((action === "STORNO" && signedEffect >= 0) || (action === "REPOST" && signedEffect <= 0)) {
    return { skipped: skip(index, decision, "ACTION_SIGNED_EFFECT_CONTRADICTION") };
  }
  const source = physicalSource(decision);
  const blockers = decisionBlockers(decision);
  if (erpOnly && !intalevAbsenceProof.proven) {
    blockers.push("GENUINE_INTALEV_ABSENCE_NOT_PROVEN", ...intalevAbsenceProof.blockers);
  }
  const route = erpOnly && !intalevAbsenceProof.proven
    ? "REVIEW_ONLY"
    : outputRoute(decision, action, source, blockers);
  const sourceCodes = first(decision?.economic_source_code, action === "STORNO" ? decision?.reconciliation_row : "");
  const targetCodes = first(decision?.economic_target_code, action === "REPOST" ? decision?.reconciliation_row : decision?.target_code);

  try {
    const materializationCase = createMaterializationCase({
      case_id: decision?.case_id,
      pair_id: decision?.pair_id,
      period: decision?.period,
      reconciliation_organization: decision?.organization || decision?.reconciliation_organization,
      action,
      role: roleFor(decision),
      signed_economic_effect: signedEffect,
      correction_amount: Math.abs(correctionAmount),
      economic: {
        source_code: sourceCodes,
        target_code: targetCodes,
        source_article: decision?.source_article,
        target_article: decision?.target_article || decision?.target_classification,
      },
      proof_status: erpOnly && !intalevAbsenceProof.proven
        ? "UNPROVEN"
        : first(decision?.proof_status, decision?.evidence_state, "UNPROVEN"),
      correction_allowed: erpOnly && !intalevAbsenceProof.proven
        ? false
        : decision?.correction_allowed === true,
      correction_authority: erpOnly && !intalevAbsenceProof.proven
        ? ""
        : decision?.correction_authority,
      output_route: route,
      physical_source: source,
      target_accounting: targetAccounting(decision),
      analytical_basis: {
        reconciliation_row: decision?.reconciliation_row,
        analytical_basis_id: decision?.analytical_basis_id,
        residual_atom_id: decision?.residual_atom_id,
        transformation_id: decision?.transformation_id,
        raw_delta: number(decision?.raw_delta),
        effective_delta: number(decision?.root_effective_delta ?? decision?.effective_delta),
      },
      intalev_source: {
        reconciliation_row: decision?.reconciliation_row,
        block: decision?.intalev_block,
        path: decision?.intalev_path,
        source_reference: decision?.intalev_reference,
        amount: number(decision?.intalev_target),
      },
      economic_route: {
        route_id: first(decision?.intergroup_reclass_id, decision?.economic_route_id),
        proof_status: first(decision?.intergroup_reclass_proof_status, decision?.proof_status),
        accepted: decision?.accepted_economic_reclass === true
          || decision?.accepted_intergroup_reclass === true
          || decision?.accepted_intragroup_reclass === true,
        accepted_amount: number(decision?.accepted_amount),
        accepted_effect: number(decision?.accepted_intergroup_effect)
          ?? number(decision?.accepted_intragroup_effect),
        root_effective_delta: number(decision?.root_effective_delta),
        processing_stage: decision?.processing_stage,
        stage_order: number(decision?.stage_order),
      },
      source_scope: {
        intalev_source_scope_presence: decision?.intalev_source_scope_presence,
        intalev_source_scope_absence_claimed: decision?.intalev_source_scope_absence_claimed === true
          || decision?.intalev_source_scope_absence_proven === true
          || upper(decision?.intalev_source_scope_presence) === "ABSENT_PROVEN",
        intalev_source_scope_absence_proven: decision?.intalev_source_scope_absence_proven === true,
        intalev_source_scope_inventory_complete: intalevAbsenceProof?.source_inventory_complete === true,
        intalev_source_scope_complete: intalevAbsenceProof?.source_scope_complete === true,
        intalev_source_amount_lost: intalevAbsenceProof?.source_amount_lost ?? null,
      },
      reason: first(decision?.reason, decision?.proof_reason),
      blockers,
      provenance: {
        source: first(decision?.bridge_source, provenance?.source),
        handoff_sha256: provenance?.handoff_sha256,
        applications_sha256: provenance?.applications_sha256,
        upstream_decision_index: index,
      },
      safety: REPORT_ONLY_SAFETY,
    });
    return action === "ADD_ONE_SIDE" || (erpOnly && !intalevAbsenceProof.proven)
      ? { reviewOnly: materializationCase }
      : { financial: materializationCase };
  } catch (error) {
    if (!(error instanceof MaterializationContractError)) throw error;
    return { skipped: skip(index, decision, `CANONICAL_CONTRACT_REJECTED:${error.code}`) };
  }
}

export function bridgeR001DecisionsToMaterializationCases(decisions = [], { provenance = {} } = {}) {
  if (!Array.isArray(decisions)) throw new TypeError("R001 bridge decisions must be an array");
  const financialCases = [];
  const reviewOnlyCases = [];
  const skipped = [];
  const caseLinks = [];
  decisions.forEach((decision, index) => {
    const result = bridgeOne(decision, index, provenance);
    if (result.financial) {
      financialCases.push(result.financial);
      caseLinks.push(Object.freeze({ upstream_decision_index: index, category: "FINANCIAL", materialization_case: result.financial }));
    } else if (result.reviewOnly) {
      reviewOnlyCases.push(result.reviewOnly);
      caseLinks.push(Object.freeze({ upstream_decision_index: index, category: "REVIEW_ONLY", materialization_case: result.reviewOnly }));
    } else if (result.skipped) skipped.push(result.skipped);
  });
  return Object.freeze({
    schema_version: R001_MATERIALIZATION_BRIDGE_SCHEMA,
    financial_cases: Object.freeze(financialCases),
    review_only_cases: Object.freeze(reviewOnlyCases),
    skipped: Object.freeze(skipped),
    canonical_posting_rows: Object.freeze([]),
    audit: Object.freeze({
      input_decision_count: decisions.length,
      financial_case_count: financialCases.length,
      review_only_case_count: reviewOnlyCases.length,
      skipped_count: skipped.length,
      canonical_posting_row_count: 0,
    }),
    case_links: Object.freeze(caseLinks),
    safety: REPORT_ONLY_SAFETY,
  });
}
