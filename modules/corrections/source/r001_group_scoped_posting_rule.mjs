export const GROUP_SCOPED_POSTING_RULE_SCHEMA = "opiu-r001-group-scoped-posting-rule.v1";

export class GroupScopedPostingRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GroupScopedPostingRuleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new GroupScopedPostingRuleError(code, message, details);
}

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/^[\s_]*(?:\d+)[\s_.-]*/, "")
    .replace(/[«»“”„"]/g, "")
    .trim();
}

function pathSegments(value) {
  return text(value).split(/\s*\/\s*/).map(normalized).filter(Boolean);
}

function canonicalBlockSegment(value) {
  return normalized(value)
    .replace(/\s*(?:—|–|-)\s*(?:all[- ]?in\b.*|.*включая\b.*)$/i, "")
    .trim();
}

function unique(values) { return [...new Set(values)]; }

export function canonicalAccount(value) {
  const match = text(value).match(/(?:^|\s)(\d{2}(?:\.\d+)*)(?:\s|$)/);
  if (!match) return "";
  return match[1].split(".").map((part, index) => index === 0 ? part : String(Number(part))).join(".");
}

function accountMatches(expected, actual) {
  const expectedAccount = canonicalAccount(expected);
  const actualAccount = canonicalAccount(actual);
  return Boolean(expectedAccount && actualAccount && (
    actualAccount === expectedAccount || actualAccount.startsWith(`${expectedAccount}.`)
  ));
}

function isClosingAccount(value) {
  const account = canonicalAccount(value);
  return account === "99" || account.startsWith("99.");
}

function catalogEntries(node) {
  return (Array.isArray(node?.catalog_entries) ? node.catalog_entries : [])
    .map((entry) => ({
      ...entry,
      code: text(entry?.code),
      operating_account: canonicalAccount(entry?.account ?? entry?.operating_account),
    }))
    .filter((entry) => entry.code && entry.operating_account);
}

/**
 * Converts the embedded reconciliation sheet `04_ERP_статьи` into the
 * catalog-node shape used by the rule. Semantic column labels keep this
 * independent of reconciliation row codes and individual article names.
 */
export function catalogNodesFromReconciliationRows(rows = []) {
  const byPath = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = text(row?.["Статья ERP"] ?? row?.label);
    const fullPath = text(row?.["Путь по справочнику ERP"] ?? row?.full_path);
    const code = text(row?.["Код статьи"] ?? row?.code);
    const account = canonicalAccount(row?.["Счёт/признак счёта"] ?? row?.account ?? row?.operating_account);
    if (!label || !fullPath || !code || !account) continue;
    const key = normalized(fullPath);
    if (!byPath.has(key)) {
      const segments = fullPath.split(/\s*\/\s*/).filter(Boolean);
      byPath.set(key, {
        label,
        full_path: fullPath,
        parent_path: segments.slice(0, -1).join(" / "),
        source_row: Number(row?.__row ?? row?.source_row) || null,
        catalog_entries: [],
      });
    }
    const node = byPath.get(key);
    const signature = `${code}|${account}`;
    if (!node.catalog_entries.some((entry) => `${entry.code}|${entry.account}` === signature)) {
      node.catalog_entries.push({
        code,
        account,
        source_row: Number(row?.__row ?? row?.source_row) || null,
        functional_direction: text(row?.["Тип"] ?? row?.functional_direction),
      });
    }
  }
  return [...byPath.values()].map((node) => Object.freeze({
    ...node,
    catalog_entries: Object.freeze(node.catalog_entries.map((entry) => Object.freeze(entry))),
  }));
}

/**
 * Selects an ERP article only inside the block represented by the Intalev path.
 * Same-named articles from other blocks are intentionally ignored.
 */
export function selectGroupScopedErpArticle(catalogNodes = [], {
  intalevPath = "",
  blockLabel = "",
  articleLabel = "",
} = {}) {
  const expectedArticle = normalized(articleLabel);
  const intalevSegments = pathSegments(intalevPath);
  const expectedBlock = canonicalBlockSegment(blockLabel)
    || canonicalBlockSegment(intalevSegments.find((segment) => /расход|доход|себестоим|логист/.test(segment)));
  if (!expectedBlock || !expectedArticle) {
    fail("GROUP_SCOPED_RULE_INPUT_INCOMPLETE", "Intalev block and article are required", {
      intalev_path: intalevPath,
      block_label: blockLabel,
      article_label: articleLabel,
    });
  }

  const candidates = (Array.isArray(catalogNodes) ? catalogNodes : []).flatMap((node) => {
    if (normalized(node?.label) !== expectedArticle) return [];
    const nodePath = pathSegments(node?.full_path || [node?.parent_path, node?.label].filter(Boolean).join(" / "));
    if (!nodePath.map(canonicalBlockSegment).includes(expectedBlock)) return [];
    return catalogEntries(node).map((entry) => ({
      block: expectedBlock,
      article: text(node.label),
      article_code: entry.code,
      operating_account: entry.operating_account,
      functional_direction: text(entry.functional_direction),
      catalog_path: text(node.full_path),
      article_source_row: Number(node.source_row) || null,
      entry_source_row: Number(entry.source_row) || null,
    }));
  });
  const signatures = unique(candidates.map((candidate) => [
    candidate.article_code,
    candidate.operating_account,
    normalized(candidate.catalog_path),
  ].join("|")));
  if (signatures.length !== 1) {
    fail(
      signatures.length > 1
        ? "GROUP_SCOPED_ERP_ARTICLE_AMBIGUOUS"
        : "GROUP_SCOPED_ERP_ARTICLE_NOT_FOUND",
      `Expected one ERP article ${articleLabel} inside block ${blockLabel || expectedBlock}, got ${signatures.length}`,
      { candidate_count: signatures.length, candidates },
    );
  }
  return Object.freeze({
    schema_version: GROUP_SCOPED_POSTING_RULE_SCHEMA,
    status: "PASS_UNIQUE_GROUP_SCOPED_ERP_ARTICLE",
    ...candidates[0],
  });
}

function exactSlots(value) {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) => text(source[index]));
}

function accountingFromOperation(operation) {
  return {
    debit: text(operation?.debit),
    credit: text(operation?.credit),
    debit_analytics: exactSlots(operation?.debit_analytics),
    credit_analytics: exactSlots(operation?.credit_analytics),
    debit_department: text(operation?.debit_department),
    credit_department: text(operation?.credit_department),
    article: text(operation?.article),
  };
}

function assertPhysicalSource(operation) {
  const required = [
    "source_organization", "journal_sha256", "source_sheet", "source_range", "source_row_id",
    "date", "document", "posting_number", "debit", "credit", "amount",
  ];
  const missing = required.filter((field) => !text(operation?.[field]));
  if (missing.length) {
    fail("GROUP_SCOPED_PHYSICAL_SOURCE_INCOMPLETE", `Exact ERP source is required: ${missing.join(", ")}`, { missing });
  }
}

/**
 * STORNO keeps the exact source tuple. REPOST keeps the physical D/K route and
 * replaces the OPIU article code with the unique article selected inside the
 * Intalev business block.  The catalog account is classification metadata: it
 * must not overwrite the journal account when ERP posted the right D/K but
 * selected a same-named article from another group.
 */
export function buildGroupScopedStornoRepostPlan({
  operation,
  targetArticle,
  settlementAccount,
  sourceOperatingAccount = "",
  articleAnalyticsSlot = 1,
  correctionAmount = null,
} = {}) {
  assertPhysicalSource(operation);
  if (targetArticle?.status !== "PASS_UNIQUE_GROUP_SCOPED_ERP_ARTICLE") {
    fail("GROUP_SCOPED_TARGET_ARTICLE_REQUIRED", "A unique group-scoped ERP target article is required");
  }
  const targetOperatingAccount = canonicalAccount(targetArticle.operating_account);
  let settlement = canonicalAccount(settlementAccount);
  if (!targetOperatingAccount) {
    fail("GROUP_SCOPED_ACCOUNT_RULE_INCOMPLETE", "Target operating account is required");
  }
  if ([operation.debit, operation.credit, targetOperatingAccount].some(isClosingAccount)) {
    fail("GROUP_SCOPED_DT99_EXCLUDED", "Closing account 99 cannot be used for article replacement");
  }
  const slot = Number(articleAnalyticsSlot) - 1;
  if (![0, 1, 2].includes(slot)) fail("GROUP_SCOPED_ARTICLE_SLOT_INVALID", "articleAnalyticsSlot must be 1, 2 or 3");

  const storno = accountingFromOperation(operation);
  const repost = accountingFromOperation(operation);
  const articleKey = normalized(operation.article);
  const debitSlots = exactSlots(operation.debit_analytics);
  const creditSlots = exactSlots(operation.credit_analytics);
  const debitArticleSlot = debitSlots.findIndex((value) => articleKey && normalized(value).includes(articleKey));
  const creditArticleSlot = creditSlots.findIndex((value) => articleKey && normalized(value).includes(articleKey));
  const articleOnDebit = debitArticleSlot >= 0;
  const articleOnCredit = creditArticleSlot >= 0;
  const targetOnDebit = accountMatches(targetOperatingAccount, operation.debit);
  const targetOnCredit = accountMatches(targetOperatingAccount, operation.credit);
  const sourceOnDebit = accountMatches(sourceOperatingAccount, operation.debit);
  const sourceOnCredit = accountMatches(sourceOperatingAccount, operation.credit);
  const operatingSide = articleOnDebit !== articleOnCredit
    ? (articleOnDebit ? "DEBIT" : "CREDIT")
    : targetOnDebit !== targetOnCredit
      ? (targetOnDebit ? "DEBIT" : "CREDIT")
      : sourceOnDebit !== sourceOnCredit
        ? (sourceOnDebit ? "DEBIT" : "CREDIT")
        : "ARTICLE_ONLY";
  if (!settlement && operatingSide === "DEBIT") settlement = canonicalAccount(operation.credit);
  if (!settlement && operatingSide === "CREDIT") settlement = canonicalAccount(operation.debit);
  if (articleOnDebit !== articleOnCredit) {
    const articleSlot = articleOnDebit ? debitArticleSlot : creditArticleSlot;
    if (articleOnDebit) repost.debit_analytics[articleSlot] = targetArticle.article;
    else repost.credit_analytics[articleSlot] = targetArticle.article;
  }
  repost.article = targetArticle.article;
  const physicalAmount = Math.abs(Number(operation.amount));
  const requestedAmount = correctionAmount === null || correctionAmount === undefined || correctionAmount === ""
    ? physicalAmount
    : Math.abs(Number(correctionAmount));
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > physicalAmount) {
    fail("GROUP_SCOPED_CORRECTION_AMOUNT_INVALID", "Correction amount must be positive and no greater than the physical source amount", {
      correction_amount: correctionAmount,
      physical_amount: physicalAmount,
    });
  }

  return Object.freeze({
    schema_version: GROUP_SCOPED_POSTING_RULE_SCHEMA,
    status: "PASS_GROUP_SCOPED_STORNO_REPOST",
    physical_source_row_id: text(operation.source_row_id),
    operating_side: operatingSide,
    source_operating_account: canonicalAccount(sourceOperatingAccount)
      || canonicalAccount(operatingSide === "DEBIT" ? operation.debit : operation.credit),
    settlement_account: settlement,
    target_article_code: targetArticle.article_code,
    target_article: targetArticle.article,
    target_operating_account: targetOperatingAccount,
    amount: requestedAmount,
    physical_source_amount: physicalAmount,
    storno: Object.freeze(storno),
    repost: Object.freeze(repost),
  });
}
