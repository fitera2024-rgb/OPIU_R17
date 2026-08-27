import {
  EMPTY_ARTICLE_BINDING_CLASSIFICATION_MODE,
  EMPTY_ARTICLE_BINDING_DECISION_TYPE,
  normalizeEmptyArticleBindingPath,
  normalizeEmptyArticleBindingValue,
} from "./empty_article_binding_settings.mjs";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CLASSIFICATION = "SOURCE_CLASSIFICATION_GAP";
const MAPPING_DECISION = "UPDATE_MAPPING";
const BINDING_STATUS = "OWNER_APPROVED_BINDING";

function text(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blocked(code, detail = "") {
  throw new Error("BLOCKED_EMPTY_ARTICLE_BINDING_APPLICATION_" + code + (detail ? ":" + detail : ""));
}

function exactString(value, code) {
  if (typeof value !== "string") blocked(code);
  const result = text(value);
  if (!result) blocked(code);
  return result;
}

function monthNumber(value) {
  return Number(value.replace("-", ""));
}

function cents(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100)
    : 0;
}

function pathSegments(value, code, { missingAllowed = false } = {}) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (missingAllowed) return null;
      blocked(code);
    }
    return value.map((segment) => exactString(segment, code));
  }
  if (typeof value !== "string" || !text(value)) {
    if (missingAllowed) return null;
    blocked(code);
  }
  return text(value).split(/\s+\/\s+/u).map((segment) => exactString(segment, code));
}

function normalizedPath(value, code, options) {
  const segments = pathSegments(value, code, options);
  return segments ? normalizeEmptyArticleBindingPath(segments) : "";
}

function organizationScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    blocked("ORGANIZATION_SCOPE_INVALID");
  }
  return Object.freeze({
    organization_id: exactString(value.organization_id, "ORGANIZATION_ID_MISSING"),
    organization_name: exactString(value.organization_name, "ORGANIZATION_NAME_MISSING"),
    organization_hierarchy_path: pathSegments(
      value.organization_hierarchy_path,
      "ORGANIZATION_HIERARCHY_PATH_INVALID",
    ),
    normalized_organization_hierarchy_path: normalizedPath(
      value.organization_hierarchy_path,
      "ORGANIZATION_HIERARCHY_PATH_INVALID",
    ),
  });
}

function organizationScopeKey(value) {
  return [
    value.organization_id,
    value.organization_name,
    value.normalized_organization_hierarchy_path,
  ].join("\u001E");
}

function ruleTarget(rule, bindingId) {
  const target = rule?.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) blocked("TARGET_INVALID", bindingId);
  const targetCode = exactString(target.target_code, "TARGET_CODE_INVALID");
  const nodeIdentity = exactString(target.target_node_identity, "TARGET_NODE_IDENTITY_INVALID");
  const displayPath = pathSegments(target.display_path, "TARGET_DISPLAY_PATH_INVALID");
  const displayArticle = exactString(target.display_article, "TARGET_DISPLAY_ARTICLE_INVALID");
  const normalizedDisplayPath = normalizeEmptyArticleBindingPath(displayPath);
  const normalizedDisplayArticle = normalizeEmptyArticleBindingValue(displayArticle);
  if (normalizeEmptyArticleBindingValue(displayPath.at(-1)) !== normalizedDisplayArticle) {
    blocked("TARGET_DISPLAY_PATH_ARTICLE_MISMATCH", bindingId);
  }
  return Object.freeze({
    target_code: targetCode,
    target_node_identity: nodeIdentity,
    display_path: Object.freeze(displayPath),
    normalized_display_path: normalizedDisplayPath,
    display_article: displayArticle,
    normalized_display_article: normalizedDisplayArticle,
  });
}

function normalizedRule(rule, runOrganization, period) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) blocked("RULE_INVALID");
  const bindingId = exactString(rule.binding_id, "BINDING_ID_MISSING");
  if (rule.mode !== EMPTY_ARTICLE_BINDING_CLASSIFICATION_MODE ||
      rule.decision_type !== EMPTY_ARTICLE_BINDING_DECISION_TYPE) {
    blocked("RULE_FINANCIAL_ACTION_FORBIDDEN", bindingId);
  }
  const ruleOrganization = organizationScope(rule.organization_scope);
  if (organizationScopeKey(ruleOrganization) !== organizationScopeKey(runOrganization)) {
    blocked("RULE_ORGANIZATION_SCOPE_MISMATCH", bindingId);
  }
  const validFrom = exactString(rule?.validity?.from, "RULE_VALID_FROM_INVALID");
  const validTo = exactString(rule?.validity?.to, "RULE_VALID_TO_INVALID");
  if (!MONTH_PATTERN.test(validFrom) || !MONTH_PATTERN.test(validTo) ||
      monthNumber(validFrom) > monthNumber(validTo) ||
      monthNumber(period) < monthNumber(validFrom) ||
      monthNumber(period) > monthNumber(validTo)) {
    blocked("RULE_PERIOD_SCOPE_MISMATCH", bindingId);
  }
  if (rule?.source?.blank_ancestor_required !== true) blocked("BLANK_ANCESTOR_REQUIRED", bindingId);
  const parentPath = pathSegments(rule?.source?.parent_path, "SOURCE_PARENT_PATH_INVALID");
  const parentPathKey = normalizeEmptyArticleBindingPath(parentPath);
  if (!Array.isArray(rule?.source?.leaf_labels) || rule.source.leaf_labels.length === 0) {
    blocked("SOURCE_LEAF_LABELS_INVALID", bindingId);
  }
  const leafLabels = rule.source.leaf_labels.map((label) =>
    exactString(label, "SOURCE_LEAF_LABEL_INVALID"));
  const normalizedLeafLabels = leafLabels.map(normalizeEmptyArticleBindingValue);
  if (new Set(normalizedLeafLabels).size !== normalizedLeafLabels.length) {
    blocked("SOURCE_LEAF_LABEL_DUPLICATE", bindingId);
  }
  return Object.freeze({
    binding_id: bindingId,
    organization_scope: ruleOrganization,
    validity: Object.freeze({ from: validFrom, to: validTo }),
    source: Object.freeze({
      parent_path: Object.freeze(parentPath),
      normalized_parent_path: parentPathKey,
      leaf_labels: Object.freeze(leafLabels),
      normalized_leaf_labels: Object.freeze(normalizedLeafLabels),
      blank_ancestor_required: true,
    }),
    target: ruleTarget(rule, bindingId),
    mode: EMPTY_ARTICLE_BINDING_CLASSIFICATION_MODE,
    decision_type: EMPTY_ARTICLE_BINDING_DECISION_TYPE,
  });
}

function targetFingerprint(target) {
  return [
    target.target_code,
    target.target_node_identity,
    target.normalized_display_path,
    target.normalized_display_article,
  ].join("\u001E");
}

function buildClaims(bindingRules, runOrganization, period) {
  if (!Array.isArray(bindingRules)) blocked("BINDING_RULES_INVALID");
  const rules = bindingRules.map((rule) => normalizedRule(rule, runOrganization, period));
  const claims = new Map();
  const targetByCode = new Map();
  const targetByNodeIdentity = new Map();
  for (const rule of rules) {
    const targetIdentity = targetFingerprint(rule.target);
    const byCode = targetByCode.get(rule.target.target_code);
    if (byCode && byCode !== targetIdentity) blocked("TARGET_CODE_IDENTITY_AMBIGUOUS", rule.target.target_code);
    targetByCode.set(rule.target.target_code, targetIdentity);
    const byNode = targetByNodeIdentity.get(rule.target.target_node_identity);
    if (byNode && byNode !== targetIdentity) {
      blocked("TARGET_NODE_IDENTITY_AMBIGUOUS", rule.target.target_node_identity);
    }
    targetByNodeIdentity.set(rule.target.target_node_identity, targetIdentity);
    for (let index = 0; index < rule.source.normalized_leaf_labels.length; index += 1) {
      const labelKey = rule.source.normalized_leaf_labels[index];
      const claimKey = rule.source.normalized_parent_path + "\u001D" + labelKey;
      if (claims.has(claimKey)) blocked("AMBIGUOUS_SOURCE_CLAIM", claimKey);
      claims.set(claimKey, Object.freeze({
        claim_key: claimKey,
        binding_id: rule.binding_id,
        source_parent_path: rule.source.parent_path,
        source_label: rule.source.leaf_labels[index],
        normalized_source_label: labelKey,
        target: rule.target,
      }));
    }
  }
  return Object.freeze({ rules: Object.freeze(rules), claims });
}

function pathIsWithin(candidateKey, ancestorKey) {
  return candidateKey === ancestorKey || candidateKey.startsWith(ancestorKey + "\u001F");
}

function blankAncestorProof(item, parentPathKey, sourceLabelKey) {
  const parentPath = pathSegments(item?.source_parent_path, "ITEM_SOURCE_PARENT_PATH_INVALID", {
    missingAllowed: true,
  });
  const sourcePath = pathSegments(item?.source_path, "ITEM_SOURCE_PATH_INVALID", {
    missingAllowed: true,
  });
  const blankBranchPath = pathSegments(
    item?.blank_branch_source_path,
    "ITEM_BLANK_BRANCH_PATH_INVALID",
    { missingAllowed: true },
  );
  if (!parentPath || !sourcePath || !blankBranchPath) return false;
  const actualParentKey = normalizeEmptyArticleBindingPath(parentPath);
  const actualSourceKey = normalizeEmptyArticleBindingPath(sourcePath);
  const blankBranchKey = normalizeEmptyArticleBindingPath(blankBranchPath);
  const expectedSourceKey = parentPathKey + "\u001F" + sourceLabelKey;
  return actualParentKey === parentPathKey &&
    actualSourceKey === expectedSourceKey &&
    pathIsWithin(actualParentKey, blankBranchKey) &&
    normalizeEmptyArticleBindingValue(item?.classification_basis) === "empty_article_ancestor" &&
    normalizeEmptyArticleBindingValue(item?.classification) === "unclassified" &&
    text(item?.article) === "" &&
    item?.source_is_leaf === true &&
    normalizeEmptyArticleBindingValue(item?.source_scope_role) === "unclassified_detail";
}

function preexistingTargetIsCompatible(item, target) {
  const existingCode = text(item?.target_code);
  const existingArticle = text(item?.erp_article);
  const existingNodeIdentity = text(item?.target_node_identity ?? item?.binding_target_node_identity);
  if (existingCode && existingCode !== target.target_code) return false;
  if (existingArticle &&
      normalizeEmptyArticleBindingValue(existingArticle) !== target.normalized_display_article) return false;
  if (existingNodeIdentity && existingNodeIdentity !== target.target_node_identity) return false;
  return true;
}

function annotateMatchedItem(item, claim) {
  if (!preexistingTargetIsCompatible(item, claim.target)) {
    blocked("PREEXISTING_TARGET_CONFLICT", claim.binding_id + ":" + claim.source_label);
  }
  if (Object.hasOwn(item ?? {}, "residual_consumption") && Number(item.residual_consumption) !== 0) {
    blocked("PREEXISTING_RESIDUAL_CONSUMPTION", claim.binding_id + ":" + claim.source_label);
  }
  return {
    ...item,
    target_code: claim.target.target_code,
    target_node_identity: claim.target.target_node_identity,
    target_display_path: claim.target.display_path,
    erp_article: claim.target.display_article,
    erp_amount: null,
    binding_id: claim.binding_id,
    binding_classification: CLASSIFICATION,
    binding_decision_type: MAPPING_DECISION,
    binding_posting_semantics: EMPTY_ARTICLE_BINDING_DECISION_TYPE,
    binding_status: BINDING_STATUS,
    binding_match_basis: "EXACT_SOURCE_PARENT_PATH_AND_LABEL_WITH_PROVEN_BLANK_ANCESTOR",
    residual_consumption: 0,
    correction_allowed: false,
    financial_posting_rows: 0,
  };
}

function unresolvedItem(item, configuredParentPaths) {
  const itemParentPath = normalizedPath(
    item?.source_parent_path,
    "ITEM_SOURCE_PARENT_PATH_INVALID",
    { missingAllowed: true },
  );
  if (!itemParentPath || !configuredParentPaths.has(itemParentPath)) return item;
  if (text(item?.target_code) || text(item?.erp_article)) return item;
  return {
    ...item,
    binding_status: "UNRESOLVED_REVIEW_ONLY",
    binding_posting_semantics: EMPTY_ARTICLE_BINDING_DECISION_TYPE,
    residual_consumption: 0,
    correction_allowed: false,
    financial_posting_rows: 0,
  };
}

function inactiveAudit(runOrganization, period) {
  return Object.freeze({
    schema: "opiu-empty-article-binding-application.v1",
    status: "INACTIVE_NO_BINDING_RULES",
    ...runOrganization,
    period,
    configured_leaf_count: 0,
    matched_item_count: 0,
    mapped_intalev_amount: 0,
    unresolved_item_count: 0,
    not_present: Object.freeze([]),
    erp_amount_distributed: 0,
    intergroup_effects_consumed: 0,
    correction_rows: 0,
    classification_only: true,
    correction_authority: false,
    physical_posting_authority: false,
    financial_rows: 0,
    posting_rows: 0,
    residual_consumption: 0,
    ready_to_upload: false,
    release_allowed: false,
    execution_allowed: false,
    live_1c_allowed: false,
  });
}

export function applyEmptyArticleBindingsToBlankArticleReporting({
  organization,
  period,
  reporting,
  bindingRules,
} = {}) {
  const runOrganization = organizationScope(organization);
  const runPeriod = exactString(period, "PERIOD_MISSING");
  if (!MONTH_PATTERN.test(runPeriod)) blocked("PERIOD_INVALID", runPeriod);
  if (!reporting || typeof reporting !== "object" || Array.isArray(reporting)) {
    blocked("REPORTING_INVALID");
  }
  if (!Array.isArray(reporting.display_scopes)) blocked("DISPLAY_SCOPES_INVALID");
  if (!Array.isArray(bindingRules)) blocked("BINDING_RULES_INVALID");
  if (bindingRules.length === 0) {
    return Object.freeze({ reporting, audit: inactiveAudit(runOrganization, runPeriod) });
  }

  const { claims } = buildClaims(bindingRules, runOrganization, runPeriod);
  const configuredParentPaths = new Set(
    [...claims.values()].map((claim) => normalizeEmptyArticleBindingPath(claim.source_parent_path)),
  );
  const matchedClaims = new Set();
  const mappedItems = [];
  let unresolvedCount = 0;
  const displayScopes = reporting.display_scopes.map((scope) => ({
    ...scope,
    items: (Array.isArray(scope?.items) ? scope.items : []).map((item) => {
      const parentPathKey = normalizedPath(
        item?.source_parent_path,
        "ITEM_SOURCE_PARENT_PATH_INVALID",
        { missingAllowed: true },
      );
      const sourceLabelKey = normalizeEmptyArticleBindingValue(item?.source_label);
      const claimKey = parentPathKey && sourceLabelKey
        ? parentPathKey + "\u001D" + sourceLabelKey
        : "";
      const claim = claims.get(claimKey);
      if (!claim) {
        const unresolved = unresolvedItem(item, configuredParentPaths);
        if (unresolved !== item) unresolvedCount += 1;
        return unresolved;
      }
      if (!blankAncestorProof(item, parentPathKey, sourceLabelKey)) {
        blocked("BLANK_ANCESTOR_NOT_PROVEN", claim.binding_id + ":" + claim.source_label);
      }
      matchedClaims.add(claim.claim_key);
      mappedItems.push(Object.freeze({
        binding_id: claim.binding_id,
        source_parent_path: claim.source_parent_path,
        source_label: claim.source_label,
        target_code: claim.target.target_code,
        target_node_identity: claim.target.target_node_identity,
        target_article: claim.target.display_article,
        intalev_amount: typeof item?.amount === "number" && Number.isFinite(item.amount)
          ? item.amount
          : null,
        status: BINDING_STATUS,
      }));
      return annotateMatchedItem(item, claim);
    }),
  }));
  const notPresent = [...claims.values()]
    .filter((claim) => !matchedClaims.has(claim.claim_key))
    .map((claim) => Object.freeze({
      binding_id: claim.binding_id,
      source_parent_path: claim.source_parent_path,
      source_label: claim.source_label,
      target_code: claim.target.target_code,
      target_node_identity: claim.target.target_node_identity,
      target_article: claim.target.display_article,
      status: "NOT_PRESENT_THIS_PERIOD",
    }));
  const resultReporting = {
    ...reporting,
    display_scopes: displayScopes,
  };
  const status = mappedItems.length === 0
    ? "NO_CONFIGURED_LEAF_PRESENT_THIS_PERIOD"
    : notPresent.length > 0
      ? "ACTIVE_WITH_NOT_PRESENT_THIS_PERIOD"
      : "ACTIVE_ALL_CONFIGURED_LEAVES_PRESENT";
  return Object.freeze({
    reporting: resultReporting,
    audit: Object.freeze({
      schema: "opiu-empty-article-binding-application.v1",
      status,
      ...runOrganization,
      period: runPeriod,
      configured_leaf_count: claims.size,
      matched_item_count: mappedItems.length,
      mapped_intalev_amount: mappedItems.reduce(
        (sum, item) => sum + cents(item.intalev_amount),
        0,
      ) / 100,
      unresolved_item_count: unresolvedCount,
      mapped_items: Object.freeze(mappedItems),
      not_present: Object.freeze(notPresent),
      binding_classification: CLASSIFICATION,
      binding_decision_type: MAPPING_DECISION,
      binding_posting_semantics: EMPTY_ARTICLE_BINDING_DECISION_TYPE,
      erp_amount_distributed: 0,
      intergroup_effects_consumed: 0,
      correction_rows: 0,
      classification_only: true,
      correction_authority: false,
      physical_posting_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      residual_consumption: 0,
      ready_to_upload: false,
      release_allowed: false,
      execution_allowed: false,
      live_1c_allowed: false,
    }),
  });
}

export const EMPTY_ARTICLE_BINDING_APPLICATION_CLASSIFICATION = CLASSIFICATION;
export const EMPTY_ARTICLE_BINDING_APPLICATION_DECISION = MAPPING_DECISION;
export const EMPTY_ARTICLE_BINDING_APPLICATION_STATUS = BINDING_STATUS;
