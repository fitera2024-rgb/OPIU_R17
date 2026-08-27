import { sha256Json } from "./io.mjs";

export function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function upper(value) {
  return text(value).toUpperCase();
}

export function code(value) {
  const raw = upper(value);
  const match = raw.match(/R\s*0*(\d{1,3})/);
  return match ? `R${String(Number(match[1])).padStart(3, "0")}` : raw;
}

export function account(value) {
  return text(value).replace(/\s+/g, "");
}

export function array(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

export function first(value) {
  return text(array(value)[0]);
}

export function splitPath(value) {
  const raw = Array.isArray(value) ? value.map(text).filter(Boolean) : text(value).split(/\s*\/\s*/).map(text).filter(Boolean);
  return raw;
}

export function joinPath(value) {
  return splitPath(value).join(" / ");
}

export function deriveBlock(articlePath, fallbackName = "", fallbackPath = "") {
  const parts = splitPath(articlePath);
  if (parts.length >= 2) {
    return {
      code: "",
      name: parts.at(-2),
      path: parts.slice(0, -1).join(" / "),
    };
  }
  return { code: "", name: text(fallbackName), path: joinPath(fallbackPath) };
}

function mapScopeType(value, includeDescendants = false) {
  const raw = upper(value);
  if (raw === "ALL_ORGS") return "ALL_ORGS";
  if (raw === "CFO_BRANCH") return "CFO_BRANCH";
  if (["ORG_WITH_DESCENDANTS", "ORG_OR_BRANCH"].includes(raw) || includeDescendants) return "ORG_WITH_DESCENDANTS";
  return "ORG_ONLY";
}

function mapAction(value) {
  const raw = upper(value);
  if (["STORNO_REPOST", "PROCESS_AS_PAIR"].includes(raw)) return "STORNO_REPOST";
  if (["CONTROL_ONLY", "CONTROL_PENDING_CONFIRMATION"].includes(raw)) return "CONTROL_ONLY";
  if (["EXCLUDE"].includes(raw)) return "EXCLUDE";
  if (["ACCEPT_DIFFERENCE"].includes(raw)) return "ACCEPT_DIFFERENCE";
  if (["DO_NOT_CORRECT_TOTAL"].includes(raw)) return "DO_NOT_CORRECT_TOTAL";
  if (["DIRECT_DELTA", "ONE_SIDE"].includes(raw)) return "ONE_SIDE";
  if (["MANUAL_REVIEW"].includes(raw)) return "MANUAL_REVIEW";
  if (["MAP_ARTICLE", "MAPPING"].includes(raw)) return "MAP_ARTICLE";
  return "CUSTOM";
}

function mapOrigin(value) {
  const raw = upper(value);
  if (raw === "BASE") return "BASE";
  if (["IMPORTED", "IMPORT"].includes(raw)) return "IMPORTED";
  if (["R005", "R001", "MANUAL", "LOCAL"].includes(raw)) return raw;
  return "LOCAL";
}

function mapStatus(value, enabled = true) {
  const raw = upper(value);
  if (["CURRENT", "PUBLISHED"].includes(raw)) return enabled ? "ACTIVE" : "INACTIVE";
  if (raw === "REVIEW") return "PENDING_REVIEW";
  if (raw === "ORGANIZATION_UNMATCHED") return "ORGANIZATION_UNMAPPED";
  if (["DRAFT", "PENDING_REVIEW", "CONFIRMED", "REJECTED", "MANUAL_REVIEW", "ACTIVE", "INACTIVE", "ORGANIZATION_UNMAPPED", "CONFLICT"].includes(raw)) return raw;
  return enabled ? "ACTIVE" : "DRAFT";
}

function parseAccountPair(value) {
  const parts = text(value).split(/[\/|;]/).map(account).filter(Boolean);
  return { debit: parts[0] ?? "", credit: parts[1] ?? "" };
}

export function canonicalRule(input) {
  if (!input || typeof input !== "object") throw new Error("Rule must be an object");
  if (input.intalev && input.erp && input.action) {
    const result = structuredClone(input);
    delete result.amount;
    delete result.amounts;
    delete result.applications;
    result.action = typeof result.action === "string" ? { action_type: mapAction(result.action), parameters: {} } : { ...result.action, action_type: mapAction(result.action.action_type) };
    result.scope = normalizeScope(result.scope ?? {});
    result.intalev = normalizeSide(result.intalev ?? {});
    result.erp = normalizeSide(result.erp ?? {});
    result.accounting = normalizeAccounting(result.accounting ?? {});
    result.rule_type = mapAction(result.rule_type || result.action.action_type);
    result.origin = mapOrigin(result.origin || result.source?.source_engine || result.source?.source_type);
    result.title = text(result.title || result.name || result.rule_id);
    result.description = text(result.description);
    result.valid_from_year = Number(result.valid_from_year || new Date().getFullYear());
    result.valid_to_year = result.valid_to_year ? Number(result.valid_to_year) : null;
    result.is_current = result.is_current !== false;
    result.enabled = result.enabled !== false;
    result.status = mapStatus(result.status || "PENDING_REVIEW", result.enabled !== false);
    result.source = result.source ?? { source_type: "MIGRATION" };
    return result;
  }

  const mapping = input.mapping ?? {};
  const source = mapping.intalev_source ?? {};
  const target = mapping.intalev_target ?? {};
  const erpSource = mapping.erp_source ?? {};
  const erpTarget = mapping.erp_target ?? {};
  const actionType = mapAction(input.action);
  const targetIsRuleTarget = actionType === "STORNO_REPOST" && (target.code || target.article || target.path);
  const erpArticle = targetIsRuleTarget
    ? { code: target.code, article: target.article || erpTarget.article, path: target.path || erpTarget.path }
    : { code: erpTarget.code || erpSource.code || source.code, article: erpTarget.article || erpSource.article, path: erpTarget.path || erpSource.path };
  const sourceBlock = deriveBlock(source.path, mapping.opiu_block, mapping.opiu_block);
  const erpBlock = deriveBlock(erpArticle.path, mapping.opiu_block, mapping.opiu_block);
  const pair = parseAccountPair(erpTarget.account || erpSource.account);
  const legacyStatus = upper(input.status);
  return {
    rule_id: text(input.rule_id),
    origin_rule_id: text(input.origin_rule_id || input.rule_id),
    revision_id: text(input.revision_id),
    parent_revision_id: input.parent_revision_id ?? null,
    title: text(input.name || input.title || input.rule_id),
    description: text(input.description),
    rule_type: actionType,
    origin: mapOrigin(input.rule_type),
    status: mapStatus(legacyStatus || "DRAFT", input.enabled !== false),
    is_current: input.is_current !== false,
    enabled: input.enabled !== false,
    valid_from_year: Number(input.valid_from_year || new Date().getFullYear()),
    valid_to_year: input.valid_to_year ? Number(input.valid_to_year) : null,
    scope: normalizeScope(input.scope ?? {}),
    intalev: {
      opiu_block_code: sourceBlock.code,
      opiu_block_name: sourceBlock.name,
      opiu_block_path: sourceBlock.path,
      article_code: code(source.code),
      article_name: text(source.article),
      article_path: joinPath(source.path),
    },
    erp: {
      opiu_block_code: erpBlock.code,
      opiu_block_name: erpBlock.name,
      opiu_block_path: erpBlock.path,
      article_code: code(erpArticle.code),
      article_name: text(erpArticle.article),
      article_path: joinPath(erpArticle.path),
    },
    accounting: {
      debit_account: pair.debit,
      debit_account_name: "",
      credit_account: pair.credit,
      credit_account_name: "",
      debit_analytics: [],
      credit_analytics: [],
      debit_department: "",
      credit_department: "",
      cfo: "",
    },
    action: { action_type: actionType, condition_text: text(input.condition_text), parameters: {} },
    conditions: [],
    source: {
      source_type: upper(input.source?.kind || "MIGRATION"),
      source_engine: null,
      source_run_id: null,
      source_file: text(input.source?.reference),
      source_sha256: null,
      author: text(input.author),
    },
    content_hash: text(input.content_hash),
    created_at: input.created_at ?? null,
    updated_at: input.updated_at ?? null,
  };
}

export function normalizeScope(scope) {
  const includeDescendants = Boolean(scope.include_descendants);
  return {
    scope_type: mapScopeType(scope.scope_type, includeDescendants),
    organization_id: text(scope.organization_id || scope.node_id),
    organization_code: text(scope.organization_code),
    organization_name: text(scope.organization_name || scope.node_name),
    organization_path: text(scope.organization_path || scope.hierarchy_path),
    cfo_id: text(scope.cfo_id),
    cfo_name: text(scope.cfo_name),
    cfo_path: text(scope.cfo_path),
    include_descendants: includeDescendants,
    mapping_status: text(scope.mapping_status || "matched"),
  };
}

export function normalizeSide(side) {
  return {
    opiu_block_code: code(side.opiu_block_code),
    opiu_block_name: text(side.opiu_block_name),
    opiu_block_path: joinPath(side.opiu_block_path),
    article_code: code(side.article_code || side.code),
    article_name: text(side.article_name || side.article),
    article_path: joinPath(side.article_path || side.path),
    catalog_uid: text(side.catalog_uid),
    parent_uid: text(side.parent_uid),
  };
}

export function normalizeAccounting(value) {
  return {
    debit_account: account(value.debit_account),
    debit_account_name: text(value.debit_account_name),
    credit_account: account(value.credit_account),
    credit_account_name: text(value.credit_account_name),
    debit_analytics: array(value.debit_analytics).map(text),
    credit_analytics: array(value.credit_analytics).map(text),
    debit_department: text(value.debit_department),
    credit_department: text(value.credit_department),
    cfo: text(value.cfo),
  };
}

export function semanticRulePayload(ruleLike) {
  const rule = canonicalRule(ruleLike);
  return {
    scope_type: rule.scope.scope_type,
    organization_id: rule.scope.organization_id,
    organization_code: upper(rule.scope.organization_code),
    organization_path: upper(rule.scope.organization_path),
    cfo_id: rule.scope.cfo_id,
    cfo_name: upper(rule.scope.cfo_name),
    cfo_path: upper(rule.scope.cfo_path),
    include_descendants: rule.scope.include_descendants,
    intalev_block: upper(rule.intalev.opiu_block_code || rule.intalev.opiu_block_path || rule.intalev.opiu_block_name),
    intalev_article: upper(rule.intalev.article_code || rule.intalev.article_path || rule.intalev.article_name),
    intalev_article_name: upper(rule.intalev.article_name),
    erp_block: upper(rule.erp.opiu_block_code || rule.erp.opiu_block_path || rule.erp.opiu_block_name),
    erp_article: upper(rule.erp.article_code || rule.erp.article_path || rule.erp.article_name),
    erp_article_name: upper(rule.erp.article_name),
    debit_account: account(rule.accounting.debit_account),
    credit_account: account(rule.accounting.credit_account),
    debit_analytics: [...(rule.accounting.debit_analytics ?? [])].map(upper).sort(),
    credit_analytics: [...(rule.accounting.credit_analytics ?? [])].map(upper).sort(),
    debit_department: upper(rule.accounting.debit_department),
    credit_department: upper(rule.accounting.credit_department),
    accounting_cfo: upper(rule.accounting.cfo),
    action_type: upper(rule.action.action_type),
    action_parameters: rule.action.parameters ?? {},
    conditions: rule.conditions ?? [],
  };
}

export function semanticRuleHash(ruleLike) {
  return sha256Json(semanticRulePayload(ruleLike));
}

export function ruleRevisionSetHash(rules) {
  const current = rules.filter((rule) => rule.is_current !== false && rule.enabled !== false).map((rule) => ({ rule_id: rule.rule_id, revision_id: rule.revision_id, semantic_hash: semanticRuleHash(rule) })).sort((a, b) => `${a.rule_id}|${a.revision_id}`.localeCompare(`${b.rule_id}|${b.revision_id}`));
  return sha256Json(current);
}
