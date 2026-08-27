function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function upper(value) { return text(value).toUpperCase(); }

function bool(value) {
  if (value === true || value === false) return value;
  return ["TRUE", "1", "ДА", "YES"].includes(upper(value));
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = text(value).replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function first(...values) { return values.map(text).find(Boolean) ?? ""; }

function joined(values) { return [...new Set(values.map(text).filter(Boolean))].join("; "); }

function normalizedEmbeddedDecision(row, { period, organization }) {
  const decisionType = upper(first(row.decision_type, row["Тип решения"]));
  const role = upper(first(row.role, row["Роль"], row["Роль доказательства"]));
  const proof = upper(first(row.proof_status, row["Proof"], row["Статус доказательства"]));
  const classification = upper(first(row.classification, row["Класс решения"]));
  const status = first(row.approval_state, row["Статус"], row["Решение владельца"]);
  const effectiveDelta = number(row.effective_delta ?? row["Effective delta"] ?? row["Дельта raw"]);
  const economicRouteProven = bool(row.ECONOMIC_ROUTE_PROVEN ?? row["ECONOMIC_ROUTE_PROVEN"]);
  const sourceOperationProven = bool(row.SOURCE_OPERATION_PROVEN ?? row["SOURCE_OPERATION_PROVEN"]);
  const physicalSourceUnique = bool(row.PHYSICAL_SOURCE_UNIQUE ?? row["PHYSICAL_SOURCE_UNIQUE"]);
  const economicCorrectionProven = bool(row.ECONOMIC_CORRECTION_PROVEN ?? row["ECONOMIC_CORRECTION_PROVEN"]);
  const ownerReviewRequired = bool(row.OWNER_REVIEW_REQUIRED ?? row["OWNER_REVIEW_REQUIRED"]);
  const financialRole = ["RECLASS_SOURCE", "RECLASS_TARGET"].includes(role);
  const reclassScope = upper(first(row.reclass_scope, row.scope, row["Контур пересорта"]));
  const intragroupClassification = classification === "INTRA_GROUP_RECLASS"
    || reclassScope === "INTRA_GROUP";
  const financialClassification = classification === "FINANCIAL_RECLASS"
    || intragroupClassification;
  const acceptedEconomicDraft = decisionType === "STORNO_REPOST"
    && financialClassification
    && economicRouteProven
    && proof === "ECONOMIC_RECLASS_PROVEN"
    && financialRole
    && effectiveDelta !== null
    && effectiveDelta !== 0;
  const explicitApproval = first(row.approval_state, row["Решение владельца"]);
  const provenNonFinancial = proof.endsWith("PROVEN") && !proof.includes("UNPROVEN") && decisionType !== "NO_POSTING";
  const approvalState = explicitApproval || (acceptedEconomicDraft || provenNonFinancial
    ? "ДОКАЗАНО_СВЕРКОЙ"
    : "ПРЕДЛОЖЕНО");
  const reconciliationRow = first(row.reconciliation_row, row["Код строки"], row["Строка сверки"]);
  const article = first(row.article, row["Статья"]);
  const caseId = first(row.case_id, row.CaseID, row["CaseID"]);
  const pairId = first(row.pair_id, row.PairID, row["PairID"]);

  return {
    ...row,
    case_id: caseId,
    pair_id: pairId,
    embedded_decision_identity: [caseId, pairId, reconciliationRow, role].join("|"),
    decision_type: decisionType,
    approval_state: approvalState,
    period: first(row.period, row["Период"], period),
    organization: first(row.organization, row["Организация"], organization),
    reconciliation_organization: first(row.reconciliation_organization, organization),
    reconciliation_row: reconciliationRow,
    group: first(row.group, row["Группа"], article),
    role,
    classification,
    reclass_scope: intragroupClassification ? "INTRA_GROUP" : (reclassScope || "INTER_GROUP"),
    proof_status: proof,
    evidence_state: proof,
    correction_amount: effectiveDelta === null ? null : Math.abs(effectiveDelta),
    analytical_effect: effectiveDelta,
    effective_delta: effectiveDelta,
    raw_delta: number(row.raw_delta ?? row["Дельта raw"]),
    reason: first(row.reason, row["Почему"]),
    solution: first(row.solution, row["Что делать"]),
    execution_note: first(row.execution_note, row["Исполнение"]),
    route_candidate_eligible: acceptedEconomicDraft,
    output_route: acceptedEconomicDraft ? "" : first(row.output_route),
    accepted_economic_reclass: false,
    accepted_intergroup_reclass: false,
    accepted_intragroup_reclass: false,
    economic_route_id: first(row.economic_route_id),
    intergroup_reclass_id: first(row.intergroup_reclass_id),
    intergroup_reclass_proof_status: first(row.intergroup_reclass_proof_status),
    accepted_amount: number(row.accepted_amount),
    accepted_intergroup_effect: number(row.accepted_intergroup_effect),
    accepted_intragroup_effect: number(row.accepted_intragroup_effect),
    economic_direction: acceptedEconomicDraft ? "" : first(row.economic_direction),
    correction_allowed: economicCorrectionProven,
    correction_authority: economicCorrectionProven ? "ECONOMIC_CORRECTION_PROVEN" : first(row.correction_authority),
    ECONOMIC_ROUTE_PROVEN: economicRouteProven,
    SOURCE_OPERATION_PROVEN: sourceOperationProven,
    PHYSICAL_SOURCE_UNIQUE: physicalSourceUnique,
    ECONOMIC_CORRECTION_PROVEN: economicCorrectionProven,
    OWNER_REVIEW_REQUIRED: ownerReviewRequired,
    source_article: role === "RECLASS_SOURCE" ? article : first(row.source_article),
    target_article: role === "RECLASS_TARGET" ? article : first(row.target_article),
    embedded_status: status,
  };
}

export function normalizeEmbeddedReconciliationDecisions(rows = [], context = {}) {
  const normalized = rows
    .filter((row) => text(row?.decision_type ?? row?.["Тип решения"]))
    .map((row) => normalizedEmbeddedDecision(row, context));
  const byCase = new Map();
  for (const decision of normalized) {
    if (!decision.case_id) continue;
    if (!byCase.has(decision.case_id)) byCase.set(decision.case_id, []);
    byCase.get(decision.case_id).push(decision);
  }
  const routeCases = [...byCase.entries()].map(([caseId, members]) => {
    const eligible = members.filter((item) => item.route_candidate_eligible === true);
    const sourceMembers = eligible.filter((item) => item.role === "RECLASS_SOURCE");
    const targetMembers = eligible.filter((item) => item.role === "RECLASS_TARGET");
    const scopes = new Set(eligible.map((item) => item.reclass_scope));
    const identities = eligible.map((item) => item.reconciliation_row || item.embedded_decision_identity);
    const uniqueIdentities = new Set(identities);
    const sourceCents = sourceMembers.reduce((sum, item) => sum + Math.round(item.effective_delta * 100), 0);
    const targetCents = targetMembers.reduce((sum, item) => sum + Math.round(item.effective_delta * 100), 0);
    const signsValid = sourceMembers.every((item) => item.effective_delta < 0)
      && targetMembers.every((item) => item.effective_delta > 0);
    const balanced = sourceCents < 0 && targetCents > 0 && sourceCents + targetCents === 0;
    const complete = eligible.length >= 2
      && eligible.length === sourceMembers.length + targetMembers.length
      && sourceMembers.length > 0
      && targetMembers.length > 0
      && scopes.size === 1
      && uniqueIdentities.size === identities.length
      && signsValid
      && balanced;
    const intragroup = scopes.size === 1 && scopes.has("INTRA_GROUP");
    return { caseId, members, eligible, identities, complete, intragroup };
  }).sort((left, right) => Number(left.intragroup) - Number(right.intragroup)
    || left.caseId.localeCompare(right.caseId, "en"));

  const acceptedCases = new Map();
  const consumedRows = new Set();
  for (const routeCase of routeCases) {
    const overlapsEarlierRoute = routeCase.identities.some((identity) => consumedRows.has(identity));
    const accepted = routeCase.complete && !overlapsEarlierRoute;
    acceptedCases.set(routeCase.caseId, {
      accepted,
      intragroup: routeCase.intragroup,
      blocker: routeCase.complete
        ? (overlapsEarlierRoute ? "ECONOMIC_ROW_ALREADY_CONSUMED_BY_EARLIER_ROUTE" : "")
        : "BALANCED_SOURCE_TARGET_ROUTE_NOT_PROVEN",
    });
    if (accepted) routeCase.identities.forEach((identity) => consumedRows.add(identity));
  }

  return normalized.map((decision) => {
    const route = acceptedCases.get(decision.case_id);
    const accepted = decision.route_candidate_eligible === true && route?.accepted === true;
    if (!accepted) {
      return Object.freeze({
        ...decision,
        correction_allowed: false,
        correction_authority: "",
        ECONOMIC_CORRECTION_PROVEN: false,
        unproven_reason: decision.route_candidate_eligible ? route?.blocker : first(decision.unproven_reason),
      });
    }
    const members = byCase.get(decision.case_id) ?? [];
    const sources = members.filter((item) => item.role === "RECLASS_SOURCE");
    const targets = members.filter((item) => item.role === "RECLASS_TARGET");
    const intragroup = route.intragroup;
    return Object.freeze({
      ...decision,
      output_route: "SPORNO",
      accepted_economic_reclass: true,
      accepted_intergroup_reclass: !intragroup,
      accepted_intragroup_reclass: intragroup,
      economic_route_id: decision.case_id,
      intergroup_reclass_id: decision.case_id,
      intergroup_reclass_proof_status: decision.proof_status,
      accepted_amount: Math.abs(decision.effective_delta),
      accepted_intergroup_effect: intragroup ? null : decision.effective_delta,
      accepted_intragroup_effect: intragroup ? decision.effective_delta : null,
      economic_direction: decision.role === "RECLASS_SOURCE" ? "STORNO" : "REPOST",
      processing_stage: intragroup ? "INTRAGROUP_DESCENDANTS_SECOND" : "INTERGROUP_ROOTS_FIRST",
      stage_order: intragroup ? 2 : 1,
      economic_source_code: joined(sources.map((item) => item.reconciliation_row)),
      economic_target_code: joined(targets.map((item) => item.reconciliation_row)),
      source_article: decision.role === "RECLASS_SOURCE"
        ? decision.source_article
        : joined(sources.map((item) => item.source_article)),
      target_article: decision.role === "RECLASS_TARGET"
        ? decision.target_article
        : joined(targets.map((item) => item.target_article)),
    });
  });
}
