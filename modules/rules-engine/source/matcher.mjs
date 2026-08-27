import { canonicalRule, semanticRuleHash, semanticRulePayload, text, upper } from "./normalize.mjs";

function candidateAsRule(candidate, context) {
  return canonicalRule({
    rule_id: candidate.existing_rule_id || `CANDIDATE-${candidate.candidate_id}`,
    revision_id: candidate.existing_revision_id || `REV-${candidate.candidate_id}`,
    title: `${candidate.intalev.article_code || candidate.intalev.article_name} → ${candidate.erp.article_code || candidate.erp.article_name}`,
    description: candidate.evidence?.explanation || "",
    rule_type: candidate.action.action_type,
    origin: candidate.evidence?.source_engine || "MANUAL",
    status: "PENDING_REVIEW",
    is_current: true,
    enabled: false,
    valid_from_year: Number(String(context.period).slice(0, 4)) || new Date().getFullYear(),
    valid_to_year: null,
    scope: candidate.scope,
    intalev: candidate.intalev,
    erp: candidate.erp,
    accounting: candidate.accounting,
    action: candidate.action,
    conditions: candidate.conditions ?? [],
    source: { source_type: candidate.evidence?.source_engine || "MANUAL", source_engine: candidate.evidence?.source_engine || null, source_run_id: context.run_id, source_file: candidate.evidence?.source_file || null, source_sha256: candidate.evidence?.source_sha256 || null, author: null },
  });
}

function fieldScore(a, b) {
  if (!a || !b) return 0;
  return upper(a) === upper(b) ? 1 : 0;
}

function accountParts(value) {
  return text(value).split(/[,;|/]+/).map((item) => item.replace(/\s+/g, "")).filter(Boolean);
}

function accountGroupMatch(left, right) {
  const a = accountParts(left);
  const b = accountParts(right);
  if (!a.length || !b.length) return false;
  return a.some((source) => b.some((target) => (
    source === target || source.startsWith(`${target}.`) || target.startsWith(`${source}.`)
  )));
}

function isClosingDebit(value) {
  return accountParts(value).some((item) => item === "99" || item.startsWith("99."));
}

function articleIdentity(side) {
  return upper(side?.article_name || text(side?.article_path).split(/\s*\/\s*/).at(-1) || side?.article_code);
}

function disclosureIdentity(side) {
  return upper(side?.opiu_block_path || side?.opiu_block_name || side?.opiu_block_code);
}

function requiredIdentityMissing(rule) {
  const missing = [];
  if (rule.scope?.scope_type !== "ALL_ORGS" && !text(rule.scope?.organization_id || rule.scope?.organization_code || rule.scope?.organization_path)) {
    missing.push("organization_or_contour");
  }
  if (!articleIdentity(rule.erp) && !articleIdentity(rule.intalev)) missing.push("normalized_article_name");
  if (!text(rule.accounting?.debit_account)) missing.push("debit_account_or_account_group");
  if (!disclosureIdentity(rule.intalev) && !disclosureIdentity(rule.erp)) missing.push("opiu_disclosure_path_or_group");
  return missing;
}

function baseIdentityCompatible(candidate, rule) {
  const articlePairs = [
    [articleIdentity(candidate.intalev), articleIdentity(rule.intalev)],
    [articleIdentity(candidate.erp), articleIdentity(rule.erp)],
  ];
  if (articlePairs.some(([left, right]) => left && right && left !== right)) return false;
  if (!accountGroupMatch(candidate.accounting?.debit_account, rule.accounting?.debit_account)) return false;
  const disclosurePairs = [
    [disclosureIdentity(candidate.intalev), disclosureIdentity(rule.intalev)],
    [disclosureIdentity(candidate.erp), disclosureIdentity(rule.erp)],
  ];
  if (disclosurePairs.some(([left, right]) => left && right && left !== right)) return false;
  return disclosurePairs.some(([left, right]) => left && right);
}

function dimensionPayload(rule) {
  return {
    cfo_id: upper(rule.scope?.cfo_id),
    cfo: upper(rule.accounting?.cfo || rule.scope?.cfo_name || rule.scope?.cfo_path),
    debit_department: upper(rule.accounting?.debit_department),
  };
}

function dimensionCompatible(candidate, rule) {
  const left = dimensionPayload(candidate);
  const right = dimensionPayload(rule);
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function dimensionKey(rule) {
  const value = dimensionPayload(rule);
  return `${value.cfo_id}|${value.cfo}|${value.debit_department}`;
}

function disclosureGroup(value) {
  const ignored = /^(?:_?статьи\s+опиу(?:\s+\d{4})?|расходы\s+по\s+основной\s+деятельности\s+итого|итого)$/i;
  const parts = text(value).split(/\s*\/\s*/)
    .map((part) => part.replace(/^\d+[_\s.-]*/, "").replace(/\s+/g, " ").trim())
    .filter((part) => part && !ignored.test(part));
  return upper(parts.at(-1) || "");
}

function disclosureGroupMatch(left, right) {
  const a = disclosureGroup(left);
  const b = disclosureGroup(right);
  return Boolean(a && b && a === b);
}

function businessRuleDiagnostics(candidate, existingRule = null) {
  const target = existingRule || candidate;
  const sourceGroup = candidate.intalev?.opiu_block_path || candidate.intalev?.opiu_block_name;
  const targetGroup = target.erp?.opiu_block_path || target.erp?.opiu_block_name;
  const sourceDebit = candidate.intalev?.debit_account
    || candidate.intalev?.accounting?.debit_account
    || candidate.accounting?.intalev_debit_account
    || candidate.accounting?.debit_account;
  const targetDebit = target.erp?.debit_account
    || target.erp?.accounting?.debit_account
    || target.accounting?.erp_debit_account
    || (existingRule ? target.accounting?.debit_account : "");
  const debitKnown = Boolean(text(sourceDebit) && text(targetDebit));
  const groupKnown = Boolean(disclosureGroup(sourceGroup) && disclosureGroup(targetGroup));
  const debitMatches = debitKnown && accountGroupMatch(sourceDebit, targetDebit);
  const groupMatches = groupKnown && disclosureGroupMatch(sourceGroup, targetGroup);
  const articleMatches = fieldScore(
    candidate.intalev?.article_code || candidate.intalev?.article_name,
    target.erp?.article_code || target.erp?.article_name,
  ) === 1;
  let status = "UNPROVEN";
  if ((debitKnown && !debitMatches) || (groupKnown && !groupMatches)) status = "RECLASS";
  else if (debitKnown && groupKnown && debitMatches && groupMatches) status = "MATCHED";
  return {
    status,
    debit_account_match: debitMatches,
    disclosure_group_match: groupMatches,
    article_match: articleMatches,
    intalev_debit_account: text(sourceDebit),
    erp_debit_account: text(targetDebit),
    intalev_disclosure_group: disclosureGroup(sourceGroup),
    erp_disclosure_group: disclosureGroup(targetGroup),
    explanation: status === "MATCHED"
      ? "Дт-счёт и группа раскрытия ОПИУ совпали."
      : status === "RECLASS"
        ? "Дт-счёт или группа раскрытия ОПИУ не совпали: требуется пересорт (STORNO/REPOST после подтверждения)."
        : "Для проверки правила не хватает Дт-счёта или группы раскрытия ОПИУ.",
  };
}

function similarity(candidateRule, existingRule) {
  const a = semanticRulePayload(candidateRule);
  const b = semanticRulePayload(existingRule);
  let score = 0;
  let weight = 0;
  const add = (left, right, w) => { weight += w; score += fieldScore(left, right) * w; };
  add(a.organization_id, b.organization_id, 1);
  add(a.intalev_article, b.intalev_article, 4);
  add(a.erp_article, b.erp_article, 4);
  add(a.action_type, b.action_type, 3);
  add(a.intalev_block, b.intalev_block, 2);
  add(a.erp_block, b.erp_block, 2);
  weight += 5;
  score += accountGroupMatch(a.debit_account, b.debit_account) ? 5 : 0;
  add(a.credit_account, b.credit_account, 1);
  const business = businessRuleDiagnostics(candidateRule, existingRule);
  weight += 6;
  score += business.disclosure_group_match ? 6 : 0;
  return weight ? score / weight : 0;
}

export function ruleAppliesToContext(rule, context) {
  const year = Number(String(context.period ?? "").slice(0, 4));
  if (year && rule.valid_from_year && year < rule.valid_from_year) return false;
  if (year && rule.valid_to_year && year > rule.valid_to_year) return false;
  const scope = rule.scope ?? {};
  const organization = context.organization ?? {};
  if (scope.scope_type === "ALL_ORGS") return true;
  if (scope.scope_type === "CFO_BRANCH") {
    return Boolean(scope.cfo_id && (scope.cfo_id === organization.cfo_id || String(organization.cfo_path ?? "").startsWith(`${scope.cfo_path} /`)));
  }
  if (scope.organization_id && scope.organization_id === organization.id) return true;
  if (scope.scope_type === "ORG_WITH_DESCENDANTS" && scope.organization_path) {
    const currentPath = String(organization.path ?? "");
    return currentPath === scope.organization_path || currentPath.startsWith(`${scope.organization_path} /`);
  }
  return false;
}

function isActive(rule, context) {
  return rule.is_current !== false && rule.enabled !== false && ["ACTIVE", "CONFIRMED"].includes(rule.status) && ruleAppliesToContext(rule, context);
}

export function matchCandidates(candidates, registry, applications, context) {
  const currentRules = (registry.rules ?? []).map(canonicalRule).filter((rule) => rule.is_current !== false);
  return candidates.map((candidate) => {
    const candidateBusiness = businessRuleDiagnostics(candidate);
    const explicitlyNotRule = candidate.decision === "NO_RULE"
      || candidate.action?.action_type === "MANUAL_REVIEW"
      || (candidate.action?.action_type === "CONTROL_ONLY" && candidate.impact_class === "CONTROL_ONLY");
    if (explicitlyNotRule) {
      return {
        ...candidate,
        business_rule: candidateBusiness,
        existing_rule_id: null,
        existing_revision_id: null,
        decision: "NO_RULE",
        user_status: candidate.user_status === "CONFIRMED" ? "CONFIRMED" : "MANUAL_REVIEW",
        match_score: 0,
        match_reasons: ["Контрольная или ручная проверка не является правилом сопоставления статей."],
      };
    }
    const candidateRule = candidateAsRule(candidate, context);
    if (isClosingDebit(candidateRule.accounting.debit_account)) {
      return {
        ...candidate,
        business_rule: { ...candidateBusiness, status: "CLOSING_ROW", closing_debit: true },
        existing_rule_id: null,
        existing_revision_id: null,
        decision: "UNRESOLVED",
        user_status: "PENDING_REVIEW",
        match_score: 0,
        match_reasons: ["Дт99 является закрывающей строкой и не определяет операционную идентичность статьи."],
      };
    }
    const missingIdentity = requiredIdentityMissing(candidateRule);
    if (missingIdentity.length) {
      return {
        ...candidate,
        business_rule: candidateBusiness,
        existing_rule_id: null,
        existing_revision_id: null,
        decision: "UNRESOLVED",
        user_status: "PENDING_REVIEW",
        match_score: 0,
        match_reasons: [`Не заполнена минимальная сигнатура правила: ${missingIdentity.join(", ")}.`],
      };
    }
    const candidateHash = semanticRuleHash(candidateRule);
    const applicableRules = currentRules.filter((rule) => ruleAppliesToContext(rule, context));
    const exact = applicableRules.find((rule) => isActive(rule, context) && semanticRuleHash(rule) === candidateHash);
    if (exact) {
      const business = businessRuleDiagnostics(candidate, exact);
      return {
        ...candidate,
        business_rule: business,
        existing_rule_id: exact.rule_id,
        existing_revision_id: exact.revision_id,
        decision: applications.some((app) => app.candidate_id === candidate.candidate_id) ? "APPLICATION_ONLY" : "EXISTING_RULE",
        user_status: "CONFIRMED",
        match_score: 1,
        match_reasons: ["Полная семантика активного правила совпадает; сумма не участвует в сравнении.", business.explanation],
      };
    }
    const inactiveExact = applicableRules.find((rule) => semanticRuleHash(rule) === candidateHash);
    if (inactiveExact) {
      const business = businessRuleDiagnostics(candidate, inactiveExact);
      return {
        ...candidate,
        business_rule: business,
        existing_rule_id: inactiveExact.rule_id,
        existing_revision_id: inactiveExact.revision_id,
        decision: "UNRESOLVED",
        user_status: "PENDING_REVIEW",
        match_score: 1,
        match_reasons: ["Семантика совпадает, но правило не является активным и применимым; нужно решение пользователя.", business.explanation],
      };
    }
    const baseCompatible = applicableRules.filter((rule) => baseIdentityCompatible(candidateRule, rule));
    const candidateDimensions = dimensionPayload(candidateRule);
    const dimensionVariants = new Set(baseCompatible.map(dimensionKey).filter((key) => key !== "||"));
    const compatibleRules = baseCompatible.filter((rule) => dimensionCompatible(candidateRule, rule));
    const candidateHasDimensions = Object.values(candidateDimensions).some(Boolean);
    if (dimensionVariants.size > 1 && (!candidateHasDimensions || compatibleRules.length !== 1)) {
      return {
        ...candidate,
        business_rule: candidateBusiness,
        existing_rule_id: null,
        existing_revision_id: null,
        decision: "UNRESOLVED",
        user_status: "PENDING_REVIEW",
        match_score: 0,
        match_reasons: ["Базовая сигнатура неоднозначна по ЦФО/подразделению; требуется точное измерение и решение пользователя."],
      };
    }
    const ranked = compatibleRules
      .filter((rule) => isActive(rule, context))
      .map((rule) => ({ rule, score: similarity(candidateRule, rule) }))
      .sort((a, b) => b.score - a.score || a.rule.rule_id.localeCompare(b.rule.rule_id));
    const best = ranked[0];
    if (best && best.score >= 0.72) {
      const business = businessRuleDiagnostics(candidate, best.rule);
      return {
        ...candidate,
        business_rule: business,
        existing_rule_id: best.rule.rule_id,
        existing_revision_id: best.rule.revision_id,
        decision: "NEW_REVISION",
        match_score: Number(best.score.toFixed(3)),
        match_reasons: [`Похоже на существующее правило ${best.rule.rule_id}; изменилась часть логики.`, business.explanation],
      };
    }
    return {
      ...candidate,
      business_rule: candidateBusiness,
      existing_rule_id: null,
      existing_revision_id: null,
      decision: "NEW_RULE",
      match_score: best ? Number(best.score.toFixed(3)) : 0,
      match_reasons: [
        ...(best ? [`Лучшее совпадение ${best.rule.rule_id} недостаточно точное.`] : ["Существующих правил нет."]),
        candidateBusiness.explanation,
      ],
    };
  });
}
