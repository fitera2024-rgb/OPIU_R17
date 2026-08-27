import { CONFIRMING_DECISIONS, NEXT_ACTIONS, R001_IMPACTS, R005_IMPACTS } from "./constants.mjs";
import { sha256Json } from "./io.mjs";
import { text } from "./normalize.mjs";

function isUnresolved(candidate) {
  return !["CONFIRMED", "REJECTED", "ACCEPT_DIFFERENCE"].includes(candidate.user_status);
}

function changesRule(candidate) {
  return ["NEW_RULE", "NEW_REVISION"].includes(candidate.decision) && (CONFIRMING_DECISIONS.has(candidate.user_decision) || candidate.user_status === "CONFIRMED");
}

function canProduceDisputedR001Draft(candidate, applicationsByCandidate) {
  if (!["STORNO_REPOST", "ONE_SIDE"].includes(text(candidate?.action?.action_type).toUpperCase())) return false;
  return (applicationsByCandidate.get(candidate.candidate_id) ?? []).some((application) => {
    const amount = Number(application?.amount);
    return ["PROPOSED", "REVIEW"].includes(text(application?.result_status).toUpperCase()) && Number.isFinite(amount) && amount !== 0;
  });
}

export function workflowStateFingerprint(state) {
  return sha256Json({
    r005_source_hash: text(state?.r005_source_hash),
    rules_revision_set_hash: text(state?.rules_revision_set_hash),
    user_decisions_hash: text(state?.user_decisions_hash),
    r005_result_hash: text(state?.r005_result_hash),
  });
}

export function decideWorkflow({ phase, runId, candidates, applications = [], rulesRevisionSetHash, previousState = null, currentState = null }) {
  const unresolved = candidates.filter(isUnresolved);
  const critical = unresolved.filter((candidate) => R005_IMPACTS.has(candidate.impact_class));
  const r001Only = unresolved.filter((candidate) => R001_IMPACTS.has(candidate.impact_class));
  const confirmedChanged = candidates.filter(changesRule);
  const confirmedR005 = confirmedChanged.filter((candidate) => R005_IMPACTS.has(candidate.impact_class));
  const confirmedR001 = confirmedChanged.filter((candidate) => R001_IMPACTS.has(candidate.impact_class));
  const applicationsByCandidate = new Map();
  for (const application of applications) {
    const candidateId = text(application?.candidate_id);
    if (!applicationsByCandidate.has(candidateId)) applicationsByCandidate.set(candidateId, []);
    applicationsByCandidate.get(candidateId).push(application);
  }
  const disputedDrafts = unresolved.filter((candidate) => canProduceDisputedR001Draft(candidate, applicationsByCandidate));
  const blockingUnresolved = unresolved.filter((candidate) => !canProduceDisputedR001Draft(candidate, applicationsByCandidate));
  const reasons = [];
  const requiredUserActions = [...new Set(unresolved.flatMap((candidate) => candidate.required_user_actions ?? []).map(text).filter(Boolean))];
  let nextAction;

  if (confirmedR005.length > 0) {
    nextAction = NEXT_ACTIONS.RERUN_R005;
    reasons.push(`Подтверждено ${confirmedR005.length} изменений, влияющих на сопоставление или результат R005.`);
  } else if (phase === "AFTER_R001" && confirmedR001.length > 0) {
    nextAction = NEXT_ACTIONS.RERUN_R001;
    reasons.push(`Подтверждено ${confirmedR001.length} изменений только для корректировочной аналитики R001.`);
  } else if (phase === "AFTER_R001" && unresolved.length > 0) {
    nextAction = NEXT_ACTIONS.WAIT_USER_RULES;
    reasons.push(`Нужно решение пользователя по ${unresolved.length} кандидатам.`);
  } else if (disputedDrafts.length > 0) {
    nextAction = NEXT_ACTIONS.PASS_TO_R001;
    reasons.push(`${disputedDrafts.length} неподтверждённых предложений передаются в R001 только как «СПОРНО / не доказано».`);
    if (blockingUnresolved.length > 0) {
      reasons.push(`${blockingUnresolved.length} независимых кандидатов остаются на ручной проверке и не входят в финансовый handoff.`);
    }
  } else if (blockingUnresolved.length > 0) {
    nextAction = NEXT_ACTIONS.WAIT_USER_RULES;
    reasons.push(`Нужно решение пользователя по ${blockingUnresolved.length} кандидатам, влияющим на R005 или контроль.`);
  } else if (phase === "AFTER_R001") {
    nextAction = NEXT_ACTIONS.COMPLETE;
    reasons.push("Обратная связь R001 зарегистрирована, новых решений не требуется.");
  } else {
    nextAction = NEXT_ACTIONS.PASS_TO_R001;
    reasons.push("Критические соответствия определены; можно передавать последнюю сверку и подтверждённые правила в R001.");
  }

  const state = { ...(currentState ?? {}), rules_revision_set_hash: rulesRevisionSetHash };
  const stateFingerprint = workflowStateFingerprint(state);
  if (previousState && nextAction === NEXT_ACTIONS.RERUN_R005) {
    const previousFingerprint = previousState.state_fingerprint || workflowStateFingerprint(previousState);
    if (previousFingerprint === stateFingerprint) {
      nextAction = NEXT_ACTIONS.FAILED_NO_STATE_CHANGE;
      reasons.length = 0;
      reasons.push("Повторный R005 запрещён: совпадают исходные файлы, набор редакций правил, решения пользователя и результат предыдущего R005.");
    }
  }

  return {
    schema_version: "opiu-rules-workflow-decision.v1",
    run_id: runId,
    phase,
    next_action: nextAction,
    reasons,
    required_user_actions: requiredUserActions,
    critical_unresolved_count: critical.length,
    r001_only_unresolved_count: r001Only.length,
    disputed_draft_count: disputedDrafts.length,
    blocking_unresolved_count: blockingUnresolved.length,
    confirmed_r005_change_count: confirmedR005.length,
    confirmed_r001_change_count: confirmedR001.length,
    rules_revision_set_hash: rulesRevisionSetHash,
    state_fingerprint: stateFingerprint,
    state,
    handoff: null,
    created_at: new Date().toISOString(),
  };
}
