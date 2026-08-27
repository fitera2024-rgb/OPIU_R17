import { CONFIRMING_DECISIONS, USER_DECISIONS } from "./constants.mjs";
import { canonicalRule, ruleRevisionSetHash, semanticRuleHash, text } from "./normalize.mjs";
import { sha256Json, utcNow } from "./io.mjs";

function mergeDeep(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch ?? target;
  const out = { ...(target ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

function candidateToRule(candidate, context, existingRule = null, decision = "CONFIRMED") {
  const year = Number(String(context.period).slice(0, 4)) || new Date().getFullYear();
  const baseId = existingRule?.rule_id || candidate.existing_rule_id || `RULE-${sha256Json({ candidate: candidate.candidate_id, scope: candidate.scope, intalev: candidate.intalev, erp: candidate.erp, action: candidate.action }).slice(0, 12)}`;
  const content = {
    rule_id: baseId,
    origin_rule_id: existingRule?.origin_rule_id || baseId,
    revision_id: `REV-${baseId}-${sha256Json({ candidate, decision }).slice(0, 10)}`,
    parent_revision_id: existingRule?.revision_id ?? null,
    title: `${candidate.intalev.article_code || candidate.intalev.article_name || "Инталев"} → ${candidate.erp.article_code || candidate.erp.article_name || "ERP"}`,
    description: text(candidate.evidence?.explanation),
    rule_type: candidate.action.action_type,
    origin: candidate.evidence?.source_engine || "MANUAL",
    status: "ACTIVE",
    is_current: true,
    enabled: true,
    valid_from_year: year,
    valid_to_year: null,
    scope: candidate.scope,
    intalev: candidate.intalev,
    erp: candidate.erp,
    accounting: candidate.accounting,
    action: candidate.action,
    conditions: candidate.conditions ?? [],
    source: {
      source_type: candidate.evidence?.source_engine || "MANUAL",
      source_engine: candidate.evidence?.source_engine || null,
      source_run_id: context.run_id,
      source_file: candidate.evidence?.source_file || null,
      source_sha256: candidate.evidence?.source_sha256 || null,
      author: null,
    },
    created_at: existingRule?.created_at || utcNow(),
    updated_at: utcNow(),
  };
  content.content_hash = semanticRuleHash(content);
  return canonicalRule(content);
}

function findCurrentRule(registry, ruleId) {
  if (!ruleId) return { index: -1, rule: null };
  const index = registry.rules.findIndex((rule) => rule.rule_id === ruleId && rule.is_current !== false);
  return { index, rule: index >= 0 ? canonicalRule(registry.rules[index]) : null };
}

function appendUnique(list, item, key) {
  const value = item?.[key];
  const index = list.findIndex((current) => current?.[key] === value);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function linkedApplications(applications, candidate, rule, status = "CONFIRMED") {
  return applications.filter((item) => item.candidate_id === candidate.candidate_id).map((item) => ({
    ...structuredClone(item),
    rule_id: rule.rule_id,
    revision_id: rule.revision_id,
    result_status: status,
  }));
}

function addApproval(registry, rule, decisionsDoc) {
  const approval = {
    approval_id: `APPROVAL-${rule.scope.organization_id || "ALL"}-${rule.rule_id}-${rule.revision_id}`,
    rule_id: rule.rule_id,
    revision_id: rule.revision_id,
    decision: "ADOPTED",
    node_id: rule.scope.organization_id,
    node_name: rule.scope.organization_name,
    hierarchy_path: rule.scope.organization_path,
    include_descendants: rule.scope.include_descendants,
    author: decisionsDoc.author || "",
    created_at: utcNow(),
  };
  appendUnique(registry.approvals, approval, "approval_id");
}

export function registerMatchedApplications(registry, candidates, applications) {
  const next = structuredClone(registry);
  next.applications ??= [];
  const matched = new Map(candidates.filter((candidate) => ["EXISTING_RULE", "APPLICATION_ONLY"].includes(candidate.decision) && candidate.user_status === "CONFIRMED").map((candidate) => [candidate.candidate_id, candidate]));
  const current = (next.rules ?? []).map(canonicalRule);
  for (const application of applications) {
    const candidate = matched.get(application.candidate_id);
    if (!candidate) continue;
    const rule = current.find((item) => item.rule_id === candidate.existing_rule_id && item.revision_id === candidate.existing_revision_id);
    if (!rule) continue;
    appendUnique(next.applications, { ...structuredClone(application), rule_id: rule.rule_id, revision_id: rule.revision_id, result_status: "CONFIRMED" }, "application_id");
  }
  return next;
}

export function applyUserDecisions({ candidates, applications, registry, decisionsDoc, context }) {
  const decisionMap = new Map((decisionsDoc?.decisions ?? []).map((item) => [item.candidate_id, item]));
  const nextRegistry = structuredClone(registry);
  nextRegistry.rules ??= [];
  nextRegistry.revisions ??= [];
  nextRegistry.applications ??= [];
  nextRegistry.approvals ??= [];
  nextRegistry.evidence ??= [];
  const updatedCandidates = [];
  const updatedApplications = applications.map((item) => structuredClone(item));
  const audit = [];

  for (const original of candidates) {
    const userDecision = decisionMap.get(original.candidate_id);
    if (!userDecision) {
      updatedCandidates.push(original);
      continue;
    }
    if (!USER_DECISIONS.has(userDecision.decision)) throw new Error(`Unsupported user decision ${userDecision.decision}`);
    let candidate = mergeDeep(original, userDecision.edited_rule ?? {});
    candidate.user_decision = userDecision.decision;
    candidate.user_status = CONFIRMING_DECISIONS.has(userDecision.decision) ? "CONFIRMED" : userDecision.decision;
    candidate.user_comment = text(userDecision.comment);
    candidate.user_decided_at = userDecision.decided_at || utcNow();

    if (CONFIRMING_DECISIONS.has(userDecision.decision)) {
      const existingId = userDecision.existing_rule_id || candidate.existing_rule_id;
      const { index: currentIndex, rule: existingRule } = findCurrentRule(nextRegistry, existingId);
      if (["LINK_TO_EXISTING", "CREATE_REVISION"].includes(userDecision.decision) && !existingRule) {
        throw new Error(`${userDecision.decision} references missing current rule ${existingId}`);
      }
      const existingActive = existingRule && existingRule.enabled !== false && ["ACTIVE", "CONFIRMED"].includes(existingRule.status);
      const exactMatch = existingRule && semanticRuleHash(candidateToRule(candidate, context, existingRule, userDecision.decision)) === semanticRuleHash(existingRule);
      const linkOnly = existingActive && userDecision.decision !== "CREATE_REVISION" && (userDecision.decision === "LINK_TO_EXISTING" || exactMatch || ["EXISTING_RULE", "APPLICATION_ONLY"].includes(candidate.decision));

      if (linkOnly) {
        candidate.existing_rule_id = existingRule.rule_id;
        candidate.existing_revision_id = existingRule.revision_id;
        const linked = linkedApplications(updatedApplications, candidate, existingRule);
        candidate.decision = linked.length ? "APPLICATION_ONLY" : "EXISTING_RULE";
        for (const app of linked) {
          appendUnique(nextRegistry.applications, app, "application_id");
          const position = updatedApplications.findIndex((item) => item.application_id === app.application_id);
          if (position >= 0) updatedApplications[position] = app;
        }
        addApproval(nextRegistry, existingRule, decisionsDoc);
        audit.push({ candidate_id: candidate.candidate_id, action: candidate.decision, rule_id: existingRule.rule_id, revision_id: existingRule.revision_id });
      } else {
        const newRule = candidateToRule(candidate, context, existingRule, userDecision.decision);
        if (existingRule && currentIndex >= 0) {
          nextRegistry.rules[currentIndex] = { ...nextRegistry.rules[currentIndex], is_current: false, enabled: false, status: "INACTIVE", updated_at: utcNow() };
        }
        nextRegistry.rules.push(newRule);
        appendUnique(nextRegistry.revisions, structuredClone(newRule), "revision_id");
        candidate.existing_rule_id = newRule.rule_id;
        candidate.existing_revision_id = newRule.revision_id;
        candidate.decision = existingRule ? "NEW_REVISION" : "NEW_RULE";
        for (const app of linkedApplications(updatedApplications, candidate, newRule)) {
          appendUnique(nextRegistry.applications, app, "application_id");
          const position = updatedApplications.findIndex((item) => item.application_id === app.application_id);
          if (position >= 0) updatedApplications[position] = app;
        }
        addApproval(nextRegistry, newRule, decisionsDoc);
        audit.push({ candidate_id: candidate.candidate_id, action: candidate.decision, rule_id: newRule.rule_id, revision_id: newRule.revision_id });
      }
    } else {
      const status = userDecision.decision === "REJECTED" ? "REJECTED" : userDecision.decision === "ACCEPT_DIFFERENCE" ? "NO_ACTION" : "REVIEW";
      for (let index = 0; index < updatedApplications.length; index += 1) {
        if (updatedApplications[index].candidate_id === candidate.candidate_id) updatedApplications[index] = { ...updatedApplications[index], result_status: status };
      }
      audit.push({ candidate_id: candidate.candidate_id, action: userDecision.decision });
    }
    updatedCandidates.push(candidate);
  }

  nextRegistry.updated_at = utcNow();
  nextRegistry.rules_revision_set_hash = ruleRevisionSetHash(nextRegistry.rules.map(canonicalRule));
  return { candidates: updatedCandidates, applications: updatedApplications, registry: nextRegistry, audit };
}
