import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ARTICLE_APPROVAL_SCHEMA = "opiu-article-approval.v1";
export const ARTICLE_APPROVAL_DECISIONS = Object.freeze([
  "УТВЕРЖДАЮ",
  "ИЗМЕНИТЬ",
  "ЗАПРЕТИТЬ",
  "НУЖНА ПРОВЕРКА",
  "ПРЕДЛОЖЕНО ДВИЖКОМ",
]);
export const ARTICLE_APPROVAL_COLUMNS = Object.freeze([
  "КлючОбласти",
  "КодОрганизацииERP",
  "ОрганизацияERP",
  "ПериодС",
  "БлокИнталев",
  "ПутьИнталев",
  "СтатьяИнталев",
  "СчетДоходовРасходов",
  "СчетРасчетов",
  "ПредлагаемыйБлокERP",
  "ПредлагаемаяСтатьяERP",
  "КодСтатьиERP",
  "Действие",
  "ОснованиеВыбора",
  "Уверенность",
  "ПримерыПроводок",
  "РешениеПользователя",
  "ПравильныйБлокERP",
  "ПравильнаяСтатьяERP",
  "ПравильныйКодСтатьиERP",
  "КомментарийПользователя",
]);

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DOMAIN_USER_PATTERN = /^[^\\/\s]+\\[^\\/\s]+$/;
const COLUMN_INDEX = new Map(ARTICLE_APPROVAL_COLUMNS.map((name, index) => [name, index]));
const ARTICLE_APPROVAL_SAFETY = Object.freeze({
  mode: "REPORT_ONLY",
  decision_type: "CLASSIFICATION_ONLY",
  financial_rows: 0,
  posting_rows: 0,
  ready_to_upload: false,
  release_allowed: false,
  live_1c_allowed: false,
});

function text(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function key(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»\"]/g, "");
}

function pathText(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" / ");
  return text(value);
}

function validSha256(value) {
  return /^[A-Fa-f0-9]{64}$/.test(text(value));
}

function month(value) {
  const result = text(value);
  return MONTH_PATTERN.test(result) ? result : "";
}

function splitCodes(value) {
  if (Array.isArray(value)) return value.flatMap(splitCodes);
  return text(value)
    .split(/[;,|]/u)
    .map(text)
    .filter(Boolean);
}

function transliterate(value) {
  const table = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
    ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
  };
  return [...text(value).toLocaleLowerCase("ru-RU")]
    .map((character) => table[character] ?? character)
    .join("");
}

export function articleApprovalOrganizationSlug({ organizationCode, organizationName }) {
  const code = transliterate(organizationCode).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  const name = transliterate(organizationName).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return [code, name].filter(Boolean).join("_") || "organization";
}

function sourceRows(input) {
  if (Array.isArray(input?.monthly) && input.monthly.length > 0) {
    return input.monthly.flatMap((monthValue) =>
      (monthValue?.rows ?? []).map((row) => ({ ...row, period: monthValue.period })),
    );
  }
  return input?.aggregateRows ?? input?.rows ?? [];
}

function hierarchyPath(row) {
  return pathText(row?.hierarchy_path ?? row?.intalev?.path ?? row?.intalev_path);
}

function intalevBlock(row) {
  const explicit = text(row?.intalev_block ?? row?.block_intalev ?? row?.source_block);
  if (explicit) return explicit;
  const parts = pathText(row?.hierarchy_path).split(" / ").filter(Boolean);
  return parts.at(-2) ?? parts.at(-1) ?? "";
}

function intalevArticle(row) {
  return text(row?.intalev_label ?? row?.intalev?.label ?? row?.article_intalev ?? row?.label);
}

function approvalScopeKey({ organizationId, period, block, article }) {
  return [text(organizationId), month(period), key(block), key(article)].join("|");
}

function catalogEntries(catalog) {
  if (Array.isArray(catalog)) return catalog.map((entry) => catalogTarget(entry));
  const nodes = Array.isArray(catalog?.nodes) ? catalog.nodes : [];
  if (nodes.length > 0) {
    const expanded = nodes.flatMap((node) => {
      const nodePath = pathText(node?.full_path ?? node?.path ?? node?.hierarchy_path);
      const pathParts = nodePath.split(" / ").filter(Boolean);
      const parentPath = pathText(node?.parent_path);
      const parentParts = parentPath.split(" / ").filter(Boolean);
      const block = text(node?.block ?? node?.parent_block ?? parentParts.at(-1) ?? pathParts.at(-2));
      const article = text(node?.article ?? node?.label ?? node?.name ?? pathParts.at(-1));
      return (Array.isArray(node?.catalog_entries) ? node.catalog_entries : []).map((entry) => ({
        block,
        article,
        code: text(entry?.code ?? entry?.target_code ?? entry?.catalog_code ?? entry?.erp_code),
        path: nodePath,
        exact: node?.exact_catalog_entry_node === true,
      }));
    }).filter((target) => target.code && target.block && target.article);
    const codesWithExactNodes = new Set(expanded.filter((target) => target.exact).map((target) => target.code));
    const authoritative = expanded.filter((target) => !codesWithExactNodes.has(target.code) || target.exact);
    return [...new Map(authoritative.map((target) => [
      [target.code, key(target.block), key(target.article), key(target.path)].join("|"),
      target,
    ])).values()];
  }
  return (catalog?.entries ?? catalog?.articles ?? []).map((entry) => catalogTarget(entry));
}

function catalogTarget(entry) {
  const targetPath = pathText(entry?.full_path ?? entry?.path ?? entry?.hierarchy_path);
  const parts = targetPath.split(" / ").filter(Boolean);
  return {
    block: text(entry?.block ?? entry?.parent_block ?? parts.at(-2)),
    article: text(entry?.article ?? entry?.name ?? entry?.label ?? entry?.article_name ?? parts.at(-1)),
    code: text(entry?.code ?? entry?.target_code ?? entry?.catalog_code ?? entry?.erp_code),
    path: targetPath,
  };
}

function candidateTargets(row, erpCatalog) {
  const candidates = [
    row?.erp?.candidates,
    row?.erp?.targets,
    row?.erp_targets,
    row?.erp_candidates,
    row?.catalog_targets,
    row?.erp?.catalog_targets,
  ].flatMap((value) => Array.isArray(value) ? value : []);
  const authoritativeCatalog = catalogEntries(erpCatalog);
  const hasCatalog = Array.isArray(erpCatalog)
    || Array.isArray(erpCatalog?.nodes)
    || Array.isArray(erpCatalog?.entries)
    || Array.isArray(erpCatalog?.articles);
  const explicit = candidates.map(catalogTarget).filter((target) => target.code);
  if (explicit.length > 0) {
    if (!hasCatalog) return explicit;
    return explicit.filter((target) => authoritativeCatalog.some((catalogTargetValue) =>
      catalogTargetValue.code === target.code
      && key(catalogTargetValue.block) === key(target.block)
      && key(catalogTargetValue.article) === key(target.article)));
  }

  const codes = splitCodes(
    row?.erp?.catalog_codes ?? row?.erp?.catalog_code ?? row?.catalog_codes ?? row?.catalog_code,
  );
  const label = key(row?.erp_label ?? row?.erp?.label);
  const block = key(intalevBlock(row));
  const catalogMatches = authoritativeCatalog
    .filter((target) => target.code && (!label || key(target.article) === label))
    .filter((target) => !block || !target.block || key(target.block) === block);
  if (codes.length > 0) {
    return codes.map((code) => ({
      code,
      block: text(row?.erp?.block ?? row?.erp_block ?? catalogMatches.find((item) => item.code === code)?.block),
      article: text(row?.erp_label ?? row?.erp?.label ?? catalogMatches.find((item) => item.code === code)?.article),
      path: catalogMatches.find((item) => item.code === code)?.path ?? "",
    }));
  }
  return catalogMatches;
}

function oneValidTarget(row, erpCatalog) {
  const targets = [...new Map(candidateTargets(row, erpCatalog)
    .filter((target) => target.code && target.article && target.block)
    .map((target) => [[target.code, key(target.block), key(target.article)].join("|"), target])).values()];
  return targets.length === 1 ? targets[0] : null;
}

function sourceHash(input) {
  const candidate = text(input?.sourceSha256 ?? input?.source_sha256);
  if (validSha256(candidate)) return candidate.toUpperCase();
  return crypto.createHash("sha256").update(JSON.stringify({
    organization: input?.organization,
    period: input?.periodLabel,
    sourceProvenance: input?.sourceProvenance ?? null,
  })).digest("hex").toUpperCase();
}

function makeScope(input) {
  const organizationId = text(input?.organizationId ?? input?.organization_id ?? input?.organizationCode);
  const organizationName = text(input?.organizationName ?? input?.organization_name ?? input?.organization);
  const organizationPath = pathText(input?.organizationHierarchyPath ?? input?.organization_hierarchy_path);
  return {
    organization_id: organizationId,
    organization_name: organizationName,
    organization_hierarchy_path: organizationPath,
    period: month(input?.period ?? input?.periodLabel),
  };
}

function rowFromSource(row, input) {
  const scope = makeScope({
    ...input,
    period: row?.period ?? input?.periodLabel ?? input?.period,
  });
  const block = intalevBlock(row);
  const article = intalevArticle(row);
  const target = oneValidTarget(row, input?.erpCatalog);
  const trace = row?.erp?.trace ?? row?.erp_trace ?? row?.physical_examples ?? [];
  const traceText = Array.isArray(trace) ? trace.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("; ") : text(trace);
  return {
    КлючОбласти: approvalScopeKey({
      organizationId: scope.organization_id,
      period: scope.period,
      block,
      article,
    }),
    КодОрганизацииERP: scope.organization_id,
    ОрганизацияERP: scope.organization_name,
    ПериодС: scope.period,
    БлокИнталев: block,
    ПутьИнталев: hierarchyPath(row),
    СтатьяИнталев: article,
    СчетДоходовРасходов: text(row?.intalev?.account ?? row?.intalev_account ?? row?.income_expense_account),
    СчетРасчетов: text(row?.intalev?.settlement_account ?? row?.settlement_account),
    ПредлагаемыйБлокERP: target?.block ?? text(row?.erp?.block ?? row?.erp_block),
    ПредлагаемаяСтатьяERP: target?.article ?? text(row?.erp_label ?? row?.erp?.label),
    КодСтатьиERP: target?.code ?? "",
    Действие: target ? "КЛАССИФИКАЦИЯ" : "НУЖНА ПРОВЕРКА",
    ОснованиеВыбора: text(row?.erp?.normalization_note ?? row?.erp?.note ?? row?.selection_reason ?? "Автоматическая структурная и справочная проверка"),
    Уверенность: text(row?.confidence ?? row?.erp?.confidence ?? (target ? "ВЫСОКАЯ" : "НЕТ")),
    ПримерыПроводок: traceText,
    РешениеПользователя: target ? "ПРЕДЛОЖЕНО ДВИЖКОМ" : "НУЖНА ПРОВЕРКА",
    ПравильныйБлокERP: "",
    ПравильнаяСтатьяERP: "",
    ПравильныйКодСтатьиERP: "",
    КомментарийПользователя: "",
  };
}

export function buildArticleApprovalRows(input = {}) {
  const scope = makeScope(input);
  const rows = sourceRows(input).map((row) => rowFromSource(row, input));
  const unique = new Map();
  for (const row of rows) {
    if (!row.ПериодС || !row.СтатьяИнталев) continue;
    unique.set(row.КлючОбласти, row);
  }
  return [...unique.values()].map((row) => ({
    ...row,
    КодОрганизацииERP: row.КодОрганизацииERP || scope.organization_id,
    ОрганизацияERP: row.ОрганизацияERP || scope.organization_name,
  }));
}

function effectiveTarget(row) {
  const decision = text(row.РешениеПользователя);
  if (decision === "ИЗМЕНИТЬ") {
    return {
      block: text(row.ПравильныйБлокERP),
      article: text(row.ПравильнаяСтатьяERP),
      code: text(row.ПравильныйКодСтатьиERP),
    };
  }
  return {
    block: text(row.ПредлагаемыйБлокERP),
    article: text(row.ПредлагаемаяСтатьяERP),
    code: text(row.КодСтатьиERP),
  };
}

function canonicalApprovalRow(original) {
  if (original && Object.hasOwn(original, "КлючОбласти")) return original;
  const fields = {
    "КлючОбласти": "scope_key",
    "КодОрганизацииERP": "organization_id",
    "ОрганизацияERP": "organization_name",
    "ПериодС": "period",
    "БлокИнталев": "block_intalev",
    "ПутьИнталев": "path_intalev",
    "СтатьяИнталев": "article_intalev",
    "СчетДоходовРасходов": "income_expense_account",
    "СчетРасчетов": "settlement_account",
    "ПредлагаемыйБлокERP": "proposed_block_erp",
    "ПредлагаемаяСтатьяERP": "proposed_article_erp",
    "КодСтатьиERP": "proposed_code_erp",
    "Действие": "action",
    "ОснованиеВыбора": "selection_reason",
    "Уверенность": "confidence",
    "ПримерыПроводок": "physical_examples",
    "РешениеПользователя": "user_decision",
    "ПравильныйБлокERP": "correct_block_erp",
    "ПравильнаяСтатьяERP": "correct_article_erp",
    "ПравильныйКодСтатьиERP": "correct_code_erp",
    "КомментарийПользователя": "user_comment",
  };
  return Object.fromEntries(Object.entries(fields).map(([column, field]) => [column, original?.[field] ?? ""]));
}

function findCatalogTargets(code, catalog) {
  return catalogEntries(catalog).filter((target) => target.code === code);
}

export function validateArticleApprovalRows(rows, options = {}) {
  const scope = makeScope(options);
  const errors = [];
  const sourceSha256 = text(options.sourceSha256 ?? options.source_sha256);
  if (!scope.organization_id) errors.push({ row: 0, code: "ORGANIZATION_ID_REQUIRED", message: "Код организации ERP не заполнен" });
  if (!scope.organization_name) errors.push({ row: 0, code: "ORGANIZATION_NAME_REQUIRED", message: "Организация ERP не заполнена" });
  if (!scope.organization_hierarchy_path) errors.push({ row: 0, code: "ORGANIZATION_PATH_REQUIRED", message: "Путь организации не заполнен" });
  if (!scope.period) errors.push({ row: 0, code: "PERIOD_INVALID", message: "ПериодС должен иметь формат ГГГГ-ММ" });
  if (!validSha256(sourceSha256)) errors.push({ row: 0, code: "SOURCE_SHA256_INVALID", message: "SHA-256 исходной сверки повреждён или отсутствует" });
  const seenTargets = new Map();
  for (const [index, original] of (Array.isArray(rows) ? rows : []).entries()) {
    const rowNumber = index + 1;
    const row = Object.fromEntries(ARTICLE_APPROVAL_COLUMNS.map((column) => [column, text(canonicalApprovalRow(original)?.[column])]));
    for (const required of ["КлючОбласти", "КодОрганизацииERP", "ОрганизацияERP", "ПериодС", "БлокИнталев", "ПутьИнталев", "СтатьяИнталев", "РешениеПользователя"]) {
      if (!row[required]) errors.push({ row: rowNumber, code: "REQUIRED_FIELD_MISSING", field: required, message: `Не заполнено поле ${required}` });
    }
    if (row.КодОрганизацииERP !== scope.organization_id || row.ОрганизацияERP !== scope.organization_name) {
      errors.push({ row: rowNumber, code: "ORGANIZATION_SCOPE_MISMATCH", message: "Строка относится к другой организации" });
    }
    if (row.ПериодС !== scope.period || !MONTH_PATTERN.test(row.ПериодС)) {
      errors.push({ row: rowNumber, code: "PERIOD_SCOPE_MISMATCH", message: "Строка относится к другому или неверному месяцу" });
    }
    const calculatedScopeKey = approvalScopeKey({
      organizationId: row.КодОрганизацииERP,
      period: row.ПериодС,
      block: row.БлокИнталев,
      article: row.СтатьяИнталев,
    });
    if (row.КлючОбласти !== calculatedScopeKey) {
      errors.push({ row: rowNumber, code: "SCOPE_KEY_MISMATCH", message: "КлючОбласти не соответствует организации, периоду, блоку и статье" });
    }
    if (!ARTICLE_APPROVAL_DECISIONS.includes(row.РешениеПользователя)) {
      errors.push({ row: rowNumber, code: "DECISION_INVALID", message: "Допустимы ровно пять решений карточки S04" });
      continue;
    }
    if (row.РешениеПользователя === "ИЗМЕНИТЬ" && [row.ПравильныйБлокERP, row.ПравильнаяСтатьяERP, row.ПравильныйКодСтатьиERP, row.КомментарийПользователя].some((value) => !value)) {
      errors.push({ row: rowNumber, code: "CHANGE_FIELDS_REQUIRED", message: "Для ИЗМЕНИТЬ обязательны блок, статья, код и комментарий" });
    }
    const target = effectiveTarget(row);
    if (target.code) {
      const catalogTargets = findCatalogTargets(target.code, options.erpCatalog);
      const hasCatalog = Array.isArray(options.erpCatalog)
        || Array.isArray(options.erpCatalog?.nodes)
        || Array.isArray(options.erpCatalog?.entries)
        || Array.isArray(options.erpCatalog?.articles);
      if (hasCatalog && catalogTargets.length === 0) {
        errors.push({ row: rowNumber, code: "ERP_CODE_UNKNOWN", message: `Код ERP не найден: ${target.code}` });
      } else if (catalogTargets.length > 0 && !catalogTargets.some((catalogTargetValue) =>
        key(catalogTargetValue.block) === key(target.block)
        && key(catalogTargetValue.article) === key(target.article))) {
        errors.push({ row: rowNumber, code: "ERP_TARGET_BLOCK_OR_ARTICLE_MISMATCH", message: "ERP-статья не принадлежит выбранному блоку" });
      }
    }
    if (["УТВЕРЖДАЮ", "ИЗМЕНИТЬ"].includes(row.РешениеПользователя) && (!target.block || !target.article || !target.code)) {
      errors.push({ row: rowNumber, code: "APPROVED_TARGET_REQUIRED", message: "Утверждаемая цель ERP неполна" });
    }
    if (["УТВЕРЖДАЮ", "ИЗМЕНИТЬ"].includes(row.РешениеПользователя)) {
      const previous = seenTargets.get(row.КлючОбласти);
      const targetKey = [key(target.block), key(target.article), target.code].join("|");
      if (previous && previous !== targetKey) {
        errors.push({ row: rowNumber, code: "CONFLICTING_TARGETS", message: "В одной области указаны две разные ERP-цели" });
      }
      seenTargets.set(row.КлючОбласти, targetKey);
    }
  }
  return errors.length > 0
    ? { status: "FAIL", errors }
    : { status: "PASS", errors: [], rows: (rows ?? []).map((original) => {
      const row = Object.fromEntries(ARTICLE_APPROVAL_COLUMNS.map((column) => [column, text(canonicalApprovalRow(original)[column])]));
      return {
        ...row,
        КлючОбласти: approvalScopeKey({
          organizationId: row.КодОрганизацииERP,
          period: row.ПериодС,
          block: row.БлокИнталев,
          article: row.СтатьяИнталев,
        }),
      };
    }) };
}

export function createArticleApprovalDocument(input = {}) {
  const validation = validateArticleApprovalRows(input.rows, input);
  if (validation.status !== "PASS") {
    const error = new Error("ARTICLE_APPROVAL_VALIDATION_FAILED");
    error.validation = validation;
    throw error;
  }
  const scope = makeScope(input);
  const fixedAt = text(input.fixedAt ?? input.fixed_at) || new Date().toISOString();
  if (!DOMAIN_USER_PATTERN.test(text(input.actor ?? input.user))) {
    throw new Error("ARTICLE_APPROVAL_ACTOR_INVALID");
  }
  const sourceXlsx = text(input.sourceXlsx ?? input.source_xlsx);
  if (!sourceXlsx || !/\.xlsx$/iu.test(sourceXlsx)) {
    throw new Error("ARTICLE_APPROVAL_SOURCE_XLSX_INVALID");
  }
  return {
    schema_version: ARTICLE_APPROVAL_SCHEMA,
    version: Number(input.version ?? 1),
    approval_id: text(input.approvalId ?? input.approval_id) || `article_approval_${crypto.randomBytes(8).toString("hex")}`,
    organization_scope: {
      organization_id: scope.organization_id,
      organization_name: scope.organization_name,
      organization_hierarchy_path: scope.organization_hierarchy_path,
    },
    validity: { from: scope.period, to: scope.period },
    source: {
      xlsx: sourceXlsx,
      sha256: text(input.sourceSha256 ?? input.source_sha256).toUpperCase(),
    },
    actor: text(input.actor ?? input.user),
    fixed_at: fixedAt,
    decisions: validation.rows,
    safety: { ...ARTICLE_APPROVAL_SAFETY },
  };
}

function exactObjectMatches(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((item, index) => item === expectedKeys[index])
    && expectedKeys.every((item) => actual[item] === expected[item]);
}

export function validateArticleApprovalDocument(document, options = {}) {
  if (!document || document.schema_version !== ARTICLE_APPROVAL_SCHEMA) {
    return { status: "FAIL", errors: [{ code: "SCHEMA_INVALID", message: "Версия схемы approved-файла не поддерживается" }] };
  }
  const scope = makeScope({
    organizationId: document.organization_scope?.organization_id,
    organizationName: document.organization_scope?.organization_name,
    organizationHierarchyPath: document.organization_scope?.organization_hierarchy_path,
    period: document.validity?.from,
  });
  const expected = makeScope(options);
  const errors = [];
  if (scope.organization_id !== expected.organization_id || scope.organization_name !== expected.organization_name || scope.organization_hierarchy_path !== expected.organization_hierarchy_path || scope.period !== expected.period) {
    errors.push({ code: "APPROVAL_SCOPE_MISMATCH", message: "Approved-файл относится к другой организации или периоду" });
  }
  if (!document.validity
    || Object.keys(document.validity).sort().join("|") !== "from|to"
    || !MONTH_PATTERN.test(text(document.validity.from))
    || document.validity.from !== document.validity.to
    || document.validity.from !== expected.period) {
    errors.push({ code: "APPROVAL_VALIDITY_INVALID", message: "Период действия approved-файла должен точно совпадать с проверяемым месяцем" });
  }
  const expectedSha = text(options.sourceSha256 ?? options.source_sha256);
  if (expectedSha && text(document.source?.sha256).toUpperCase() !== expectedSha.toUpperCase()) {
    errors.push({ code: "SOURCE_SHA256_MISMATCH", message: "SHA-256 исходной сверки не совпадает" });
  }
  const expectedXlsx = text(options.sourceXlsx ?? options.source_xlsx);
  if (!text(document.source?.xlsx) || !/\.xlsx$/iu.test(text(document.source?.xlsx))) {
    errors.push({ code: "SOURCE_XLSX_INVALID", message: "Approved-файл не содержит точный исходный XLSX" });
  } else if (expectedXlsx && text(document.source.xlsx) !== expectedXlsx) {
    errors.push({ code: "SOURCE_XLSX_MISMATCH", message: "Исходный XLSX approved-файла не совпадает с текущей сверкой" });
  }
  if (!exactObjectMatches(document.safety, ARTICLE_APPROVAL_SAFETY)) {
    errors.push({ code: "APPROVAL_SAFETY_INVALID", message: "Approved-файл обязан сохранять точный режим REPORT_ONLY" });
  }
  if (!validSha256(document.source?.sha256) || !DOMAIN_USER_PATTERN.test(text(document.actor)) || !Number.isInteger(document.version) || document.version < 1) {
    errors.push({ code: "APPROVAL_METADATA_INVALID", message: "Метаданные approved-файла неполны" });
  }
  const rows = validateArticleApprovalRows(document.decisions, {
    ...expected,
    sourceSha256: document.source?.sha256,
    erpCatalog: options.erpCatalog,
  });
  if (rows.status !== "PASS") errors.push(...rows.errors);
  return errors.length > 0 ? { status: "FAIL", errors } : { status: "PASS", errors: [], document };
}

export function readArticleApprovalMatrix(values) {
  const matrix = Array.isArray(values) ? values : [];
  const headerIndex = matrix.findIndex((row) => Array.isArray(row) && ARTICLE_APPROVAL_COLUMNS.every((column, index) => text(row[index]) === column));
  if (headerIndex < 0) throw new Error("ARTICLE_APPROVAL_HEADER_INVALID");
  const rows = [];
  for (const row of matrix.slice(headerIndex + 1)) {
    if (!Array.isArray(row) || row.every((value) => !text(value))) continue;
    rows.push(Object.fromEntries(ARTICLE_APPROVAL_COLUMNS.map((column, index) => [column, text(row[index])] )));
  }
  const sourceShaRow = matrix.find((row) => Array.isArray(row) && text(row[0]) === "SHA-256 исходной сверки");
  return { headerIndex, sourceSha256: text(sourceShaRow?.[1]), rows };
}

export async function readArticleApprovalSheet(sheet) {
  const range = sheet?.getUsedRange?.();
  return readArticleApprovalMatrix(range?.values ?? []);
}

function columnName(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function buildArticleApprovalSheet(sheet, input = {}) {
  const rows = buildArticleApprovalRows(input);
  const sourceSha256 = sourceHash(input);
  const endColumn = columnName(ARTICLE_APPROVAL_COLUMNS.length);
  sheet.getRange(`A1:${endColumn}1`).merge();
  sheet.getRange("A1").values = [[`01_Правила — утверждение статей — ${text(input.organization) || "организация не определена"} — ${text(input.periodLabel)}`]];
  sheet.getRange(`A2:B2`).values = [["SHA-256 исходной сверки", sourceSha256]];
  sheet.getRange(`A3:${endColumn}3`).merge();
  sheet.getRange("A3").values = [["Допустимы ровно пять решений. Утверждение направления поиска не заменяет физическую строку ERP; REPORT_ONLY сохраняется."]];
  sheet.getRange(`A5:${endColumn}5`).values = [ARTICLE_APPROVAL_COLUMNS];
  sheet.getRange(`A6:${endColumn}${5 + rows.length}`).values = rows.map((row) => ARTICLE_APPROVAL_COLUMNS.map((column) => row[column] ?? ""));
  sheet.getRange(`A1:${endColumn}1`).format = { fill: "#1F4E78", font: { color: "#FFFFFF", bold: true }, wrapText: true };
  sheet.getRange(`A2:B2`).format = { fill: "#FFF2CC", wrapText: true };
  sheet.getRange(`A3:${endColumn}3`).format = { fill: "#D9EAF7", font: { bold: true }, wrapText: true };
  sheet.getRange(`A5:${endColumn}5`).format = { fill: "#5B9BD5", font: { color: "#FFFFFF", bold: true }, wrapText: true };
  if (rows.length > 0) sheet.getRange(`A6:${endColumn}${5 + rows.length}`).format = { wrapText: true };
  return {
    schema_version: ARTICLE_APPROVAL_SCHEMA,
    sheet: "01_Правила",
    source_sha256: sourceSha256,
    row_count: rows.length,
    organization_id: text(input.organizationId ?? input.organizationCode),
    organization: text(input.organization),
    period: text(input.periodLabel),
    decisions: ARTICLE_APPROVAL_DECISIONS,
    approved_version: input.articleApprovalDocument?.version ?? null,
    active_approval_status: input.articleApprovalDocument ? "ACTIVE_EXACT_SCOPE" : "NO_APPROVED_VERSION",
    report_only: true,
    posting_rows: 0,
  };
}

export function applyArticleApprovalRules(rows, document, scope = {}) {
  const expected = makeScope(scope);
  if (!document) return (rows ?? []).map((row) => ({ ...row, article_approval_status: "NO_APPROVED_VERSION" }));
  const validation = validateArticleApprovalDocument(document, scope);
  if (validation.status !== "PASS") throw new Error("ARTICLE_APPROVAL_DOCUMENT_REJECTED");
  const decisions = new Map((document.decisions ?? []).map((row) => {
    const canonical = canonicalApprovalRow(row);
    return [canonical.КлючОбласти, canonical];
  }));
  return (rows ?? []).map((row) => {
    const block = text(row?.БлокИнталев ?? row?.block ?? row?.intalev_block ?? intalevBlock(row));
    const article = text(row?.СтатьяИнталев ?? row?.article ?? row?.intalev_label ?? intalevArticle(row));
    const rowKey = approvalScopeKey({
      organizationId: expected.organization_id,
      period: expected.period,
      block,
      article,
    });
    const declaredKey = text(row?.КлючОбласти ?? row?.scope_key);
    if (declaredKey && declaredKey !== rowKey) throw new Error("ARTICLE_APPROVAL_SCOPE_KEY_REJECTED");
    const decision = decisions.get(rowKey);
    if (!decision) return { ...row, article_approval_status: "NO_MATCHING_APPROVAL" };
    const target = effectiveTarget(decision);
    if (decision.РешениеПользователя === "ЗАПРЕТИТЬ") return { ...row, article_approval_status: "FORBIDDEN", article_approval_target: null, article_approval_version: document.version };
    if (["УТВЕРЖДАЮ", "ИЗМЕНИТЬ"].includes(decision.РешениеПользователя)) return { ...row, article_approval_status: "APPROVED_EXACT_SCOPE", article_approval_target: target, article_approval_version: document.version };
    return { ...row, article_approval_status: decision.РешениеПользователя, article_approval_target: null, article_approval_version: document.version };
  });
}

function moneyCents(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.abs(numeric) * 100);
}

export function evaluateArticleApprovalFinancialGate({
  approval,
  physicalRows = [],
  amount = 0,
  sourceId = "",
  usedSourceIds,
} = {}) {
  if (approval?.article_approval_status === "FORBIDDEN" || approval?.article_approval_status !== "APPROVED_EXACT_SCOPE") {
    return { status: "СПОРНО", reason: "APPROVAL_NOT_FINAL", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  const exactSourceId = String(sourceId ?? "");
  if (!exactSourceId || !(usedSourceIds instanceof Set)) {
    return { status: "СПОРНО", reason: "PHYSICAL_REUSE_GUARD_REQUIRED", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  const matches = physicalRows.filter((row) => String(row?.id ?? row?.sourceId ?? row?.source_id ?? "") === exactSourceId);
  if (matches.length !== 1) {
    return { status: "СПОРНО", reason: "PHYSICAL_ERP_ROW_NOT_UNIQUE", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  const physicalRow = matches[0];
  if (physicalRow.unique !== true
    || physicalRow.proven !== true
    || physicalRow.reopened !== true
    || physicalRow.reuse_checked !== true) {
    return { status: "СПОРНО", reason: "PHYSICAL_ERP_PROOF_INCOMPLETE", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  const valueCents = moneyCents(amount);
  const physicalCents = moneyCents(physicalRow.amount);
  if (!valueCents || !physicalCents || valueCents !== physicalCents) {
    return { status: "СПОРНО", reason: "PHYSICAL_AMOUNT_MISMATCH", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  if (usedSourceIds.has(exactSourceId)) {
    return { status: "СПОРНО", reason: "PHYSICAL_ERP_ROW_ALREADY_USED", correction_rows: [], posting_rows: 0, ready_to_upload: false, release_allowed: false };
  }
  usedSourceIds.add(exactSourceId);
  const value = valueCents / 100;
  return {
    status: "ДОКАЗАНО",
    reason: "UNIQUE_PHYSICAL_ERP_ROW",
    correction_rows: [
      { operation: "STORNO", amount: -value, physical_row_id: exactSourceId },
      { operation: "REPOST", amount: value, physical_row_id: exactSourceId },
    ],
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export async function persistArticleApprovalVersion(directory, input = {}) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const slug = articleApprovalOrganizationSlug({ organizationCode: input.organizationId ?? input.organizationCode, organizationName: input.organizationName ?? input.organization });
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const versionPattern = new RegExp(`^article_registry_${escapedSlug}_v(\\d+)\\.approved\\.json$`, "u");
  const versions = entries
    .map((entry) => versionPattern.exec(entry.name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const document = createArticleApprovalDocument({ ...input, version: Math.max(0, ...versions) + 1 });
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  const digest = crypto.createHash("sha256").update(bytes, "utf8").digest("hex").toUpperCase();
  const filePath = path.join(directory, `article_registry_${slug}_v${String(document.version).padStart(3, "0")}.approved.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.writeFile(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
  return { document, path: filePath, sha256: digest };
}

export async function loadArticleApprovalDocument(filePath, options = {}) {
  const bytes = await fs.readFile(filePath);
  const sidecar = await fs.readFile(`${filePath}.sha256`, "utf8");
  const actualSha = crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const declaredSha = /^([A-Fa-f0-9]{64})\s+/u.exec(sidecar)?.[1]?.toUpperCase();
  if (!declaredSha || declaredSha !== actualSha) throw new Error("ARTICLE_APPROVAL_SHA256_INVALID");
  const document = JSON.parse(bytes.toString("utf8"));
  const validation = validateArticleApprovalDocument(document, {
    ...options,
    sourceSha256: options.sourceSha256 ?? options.source_sha256 ?? document.source?.sha256,
  });
  if (validation.status !== "PASS") throw new Error(`ARTICLE_APPROVAL_DOCUMENT_REJECTED:${validation.errors.map((item) => item.code).join(",")}`);
  return document;
}
