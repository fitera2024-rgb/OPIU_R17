function text(value) {
  return String(value ?? "").trim();
}

function signedDeltaCents(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function ruleDescriptor(decision) {
  return {
    source: decision,
    caseId: text(decision?.case_id),
    organization: text(decision?.organization),
    period: text(decision?.period),
    basisId: text(decision?.analytical_basis_id),
    deltaCents: signedDeltaCents(decision?.analytical_effect),
  };
}

function fallbackDescriptor(review) {
  return {
    source: review,
    organization: text(review?.organization),
    period: text(review?.period),
    basisId: text(review?.analyticalBasisId),
    deltaCents: signedDeltaCents(review?.delta),
  };
}

function signature(item) {
  if (!item.organization || !item.period || item.deltaCents === null) return "";
  return [item.organization, item.period, item.deltaCents].join("\u0000");
}

function groupedByBasis(items) {
  const result = new Map();
  for (const item of items) {
    if (!item.basisId) continue;
    if (!result.has(item.basisId)) result.set(item.basisId, []);
    result.get(item.basisId).push(item);
  }
  return result;
}

export function reconcileRulesApplicationsWithR005Fallbacks({
  rulesApplications = [],
  rawFallbacks = [],
} = {}) {
  const ruleDescriptors = rulesApplications.map(ruleDescriptor);
  const fallbackDescriptors = rawFallbacks.map(fallbackDescriptor);
  const rulesByBasis = groupedByBasis(ruleDescriptors);
  const fallbacksByBasis = groupedByBasis(fallbackDescriptors);
  const unmatchedFallbacks = fallbackDescriptors.filter((item) => !item.basisId).map((item) => item.source);
  const conflictingRuleCaseIds = new Set();
  const exactDuplicateBasisIds = [];
  const blockers = [];

  for (const [basisId, fallbacks] of fallbacksByBasis) {
    const rules = rulesByBasis.get(basisId) ?? [];
    if (!rules.length) {
      unmatchedFallbacks.push(...fallbacks.map((item) => item.source));
      continue;
    }

    const ruleSignatures = new Set(rules.map(signature));
    const fallbackSignatures = new Set(fallbacks.map(signature));
    const allSignatures = new Set([...ruleSignatures, ...fallbackSignatures]);
    const exactSingleApplication = rules.length === 1
      && !ruleSignatures.has("")
      && !fallbackSignatures.has("")
      && allSignatures.size === 1;

    if (exactSingleApplication) {
      exactDuplicateBasisIds.push(basisId);
      continue;
    }

    for (const rule of rules) if (rule.caseId) conflictingRuleCaseIds.add(rule.caseId);
    blockers.push({
      blocker_code: "CONFLICTING_R001_ANALYTICAL_BASIS",
      analytical_basis_id: basisId,
      rules_applications: rules.map((item) => ({
        case_id: item.caseId,
        organization: item.organization,
        period: item.period,
        signed_delta_cents: item.deltaCents,
      })),
      r005_fallbacks: fallbacks.map((item) => ({
        organization: item.organization,
        period: item.period,
        signed_delta_cents: item.deltaCents,
      })),
    });
  }

  return {
    unmatchedFallbacks,
    exactDuplicateBasisIds,
    conflictingRuleCaseIds: [...conflictingRuleCaseIds],
    blockers,
  };
}
