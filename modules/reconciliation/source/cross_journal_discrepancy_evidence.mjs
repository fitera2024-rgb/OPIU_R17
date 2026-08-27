import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { readOperationJournalRows } from "./full_operation_evidence.mjs";

export const CROSS_JOURNAL_SCHEMA = "opiu-cross-journal-discrepancy-evidence-v1";
const PROVEN_SCORE = 90;
const REVIEW_SCORE = 75;
const GENERIC_ANALYTICS = new Set([
  "факт", "руб", "рубль", "внешний", "внутренний", "служебный",
  "сахалин", "пв", "пх", "национальный план счетов",
]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function normalizeBusinessText(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»“”„"'`]/g, "")
    .replace(/[^0-9a-zа-я]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAccount(value) {
  return text(value).replace(",", ".").replace(/\.0+$/, "");
}

function amountCents(value) {
  const numeric = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function dateOnly(value) {
  const source = text(value);
  const isoMatch = source.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const match = source.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function periodOf(value) {
  return dateOnly(value).slice(0, 7);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function stableRowId(sourceSha256, sheet, physicalRow) {
  return sha256(Buffer.from(`${sourceSha256}|${sheet}|${physicalRow}`, "utf8"));
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(fragment) {
  const result = {};
  for (const match of String(fragment ?? "").matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function extractTextNodes(xml) {
  return [...String(xml ?? "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

function parseSharedStrings(xml) {
  return [...String(xml ?? "").matchAll(/<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)]
    .map((match) => extractTextNodes(match[1]));
}

function parseCellValue(type, body, sharedStrings) {
  if (type === "inlineStr") return extractTextNodes(body);
  const raw = body.match(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/)?.[1];
  if (raw === undefined) return null;
  const value = decodeXml(raw);
  if (type === "s") return sharedStrings[Number(value)] ?? null;
  if (type === "b") return value === "1";
  if (type === "str") return value;
  const numeric = Number(value);
  return value !== "" && Number.isFinite(numeric) ? numeric : value;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = new Map();
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)\/>|<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/g;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const physicalRow = Number(parseAttributes(rowMatch[1] ?? rowMatch[2]).r);
    if (!Number.isInteger(physicalRow) || physicalRow < 1) continue;
    const cells = new Map();
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\/>|<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>/g;
    for (const cellMatch of String(rowMatch[3] ?? "").matchAll(cellPattern)) {
      const attributes = parseAttributes(cellMatch[1] ?? cellMatch[2]);
      const column = attributes.r?.match(/^([A-Z]+)/i)?.[1]?.toUpperCase();
      if (!column) continue;
      cells.set(column, parseCellValue(attributes.t, cellMatch[3] ?? "", sharedStrings));
    }
    rows.set(physicalRow, cells);
  }
  return rows;
}

function cell(rows, row, column) {
  return rows.get(row)?.get(column) ?? null;
}

function compactCells(rows, physicalRow, columns) {
  return columns.map((column) => text(cell(rows, physicalRow, column))).filter(Boolean);
}

async function loadFirstWorksheet(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const findEntry = (wanted) => names.find((name) => name.toLowerCase() === wanted.toLowerCase());
  const workbookName = findEntry("xl/workbook.xml");
  const relsName = findEntry("xl/_rels/workbook.xml.rels");
  if (!workbookName || !relsName) throw new Error("INTALEV_JOURNAL_WORKBOOK_METADATA_MISSING");
  const [workbookXml, relsXml] = await Promise.all([
    zip.file(workbookName).async("string"),
    zip.file(relsName).async("string"),
  ]);
  const firstSheet = workbookXml.match(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/);
  const sheetAttributes = parseAttributes(firstSheet?.[1]);
  const relationshipId = sheetAttributes["r:id"] ?? sheetAttributes.id;
  const relationship = [...relsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/g)]
    .map((match) => parseAttributes(match[1]))
    .find((item) => item.Id === relationshipId);
  if (!relationship?.Target) throw new Error("INTALEV_JOURNAL_SHEET_RELATIONSHIP_MISSING");
  const target = relationship.Target.startsWith("/")
    ? relationship.Target.slice(1)
    : path.posix.normalize(path.posix.join("xl", relationship.Target.replace(/^\.\//, "")));
  const sheetName = findEntry(target);
  if (!sheetName) throw new Error(`INTALEV_JOURNAL_SHEET_XML_MISSING:${target}`);
  const sharedName = findEntry("xl/sharedStrings.xml");
  const [sheetXml, sharedXml] = await Promise.all([
    zip.file(sheetName).async("string"),
    sharedName ? zip.file(sharedName).async("string") : Promise.resolve(""),
  ]);
  return {
    sheet: text(sheetAttributes.name) || "TDSheet",
    entry: sheetName,
    rows: parseWorksheetRows(sheetXml, parseSharedStrings(sharedXml)),
  };
}

export async function readIntalevJournalRows({ journalPath }) {
  const resolved = path.resolve(journalPath);
  const buffer = await fs.readFile(resolved);
  const sourceSha256 = sha256(buffer);
  const worksheet = await loadFirstWorksheet(buffer);
  const headerRows = [...worksheet.rows.keys()].filter((row) =>
    text(cell(worksheet.rows, row, "D")) === "Период"
      && text(cell(worksheet.rows, row, "E")) === "Документ"
      && text(cell(worksheet.rows, row, "AU")) === "Сумма"
      && text(cell(worksheet.rows, row, "AW")) === "Содержание");
  if (headerRows.length !== 1) {
    throw new Error(`INTALEV_JOURNAL_HEADER_AMBIGUOUS:${headerRows.length}`);
  }
  const headerRow = headerRows[0];
  const operations = [...worksheet.rows.keys()]
    .filter((physicalRow) => physicalRow > headerRow)
    .sort((left, right) => left - right)
    .map((physicalRow) => {
      const debitAnalytics = compactCells(worksheet.rows, physicalRow, [
        "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y",
      ]);
      const creditAnalytics = compactCells(worksheet.rows, physicalRow, [
        "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AN", "AO",
      ]);
      const date = text(cell(worksheet.rows, physicalRow, "D"));
      const amount = Number(cell(worksheet.rows, physicalRow, "AU"));
      return {
        system: "INTALEV",
        physical_row: physicalRow,
        source_range: `B${physicalRow}:BG${physicalRow}`,
        source_row_id: stableRowId(sourceSha256, worksheet.sheet, physicalRow),
        date,
        date_value: dateOnly(date),
        period: periodOf(date),
        document: text(cell(worksheet.rows, physicalRow, "E")),
        posting_no: cell(worksheet.rows, physicalRow, "F"),
        scenario: text(cell(worksheet.rows, physicalRow, "G")),
        cfo: text(cell(worksheet.rows, physicalRow, "H")),
        debit: normalizeAccount(cell(worksheet.rows, physicalRow, "J")),
        debit_analytics: debitAnalytics,
        credit: normalizeAccount(cell(worksheet.rows, physicalRow, "Z")),
        credit_analytics: creditAnalytics,
        amount: Number.isFinite(amount) ? amount : null,
        operation_kind: text(cell(worksheet.rows, physicalRow, "AV")),
        content: text(cell(worksheet.rows, physicalRow, "AW")),
        department: text(cell(worksheet.rows, physicalRow, "BD")),
        organization: text(cell(worksheet.rows, physicalRow, "BE")),
        perimeter: text(cell(worksheet.rows, physicalRow, "BF")),
        company: text(cell(worksheet.rows, physicalRow, "BG")),
      };
    })
    .filter((row) => row.date || row.document || Number.isFinite(row.amount));
  return {
    source: resolved,
    source_sha256: sourceSha256,
    sheet: worksheet.sheet,
    worksheet_entry: worksheet.entry,
    header_row: headerRow,
    rows: operations,
  };
}

function canonicalAccount(value) {
  const match = text(value).replace(",", ".").match(/(?:^|\s)(\d{2}(?:\.\d+)*)(?:\s|$)/);
  if (!match) return "";
  return match[1].split(".").map((part, index) => index === 0 ? part : String(Number(part))).join(".");
}

function accountMatches(expected, actual) {
  const left = canonicalAccount(expected);
  const right = canonicalAccount(actual);
  return Boolean(left && right && (
    left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`)
  ));
}

function accountBlock(value) {
  const account = canonicalAccount(value);
  if (account === "26" || account.startsWith("26.")) return "административные расходы";
  if (account === "44.1" || account.startsWith("44.1.")) return "коммерческие расходы";
  if (account === "44.2" || account.startsWith("44.2.")) return "расходы на складскую логистику";
  if (account === "44.3" || account.startsWith("44.3.")) return "расходы на транспортную логистику";
  return "";
}

function rowAccounts(row) {
  const values = [
    row.disclosure,
    row.analytics3,
    row.debit,
    row.credit,
    row.income_expense_account,
    row.source_operating_account,
  ];
  return [...new Set(values.map(canonicalAccount).filter(Boolean))];
}

function businessBlockFromRow(row) {
  for (const account of rowAccounts(row)) {
    const block = accountBlock(account);
    if (block) return block;
  }
  return "";
}

function catalogArticleIndex(nodes = []) {
  const result = new Map();
  for (const node of nodes ?? []) {
    const name = text(node?.name ?? node?.label ?? node?.article);
    const key = normalizeBusinessText(name);
    if (!key || key.length < 3 || GENERIC_ANALYTICS.has(key)) continue;
    const fullPath = text(node?.full_path ?? node?.path ?? node?.fullPath);
    const entries = Array.isArray(node?.catalog_entries) ? node.catalog_entries : [];
    const accounts = new Set([
      node?.income_expense_account,
      node?.operating_account,
      ...entries.flatMap((entry) => [entry?.account, entry?.operating_account]),
    ].map(canonicalAccount).filter(Boolean));
    const codes = new Set(entries.map((entry) => text(entry?.code)).filter(Boolean));
    if (!result.has(key)) result.set(key, []);
    const exactEntry = node?.exact_catalog_entry_node === true;
    const signature = `${normalizeBusinessText(fullPath)}|${[...accounts].sort().join(",")}|${[...codes].sort().join(",")}|${exactEntry}`;
    if (result.get(key).some((candidate) => candidate.signature === signature)) continue;
    result.get(key).push({
      signature,
      name,
      path: fullPath,
      accounts,
      codes,
      entry_bound: entries.length > 0,
      exact_entry: exactEntry,
    });
  }
  return result;
}

function blockFromPaths(paths) {
  const joined = normalizeBusinessText(paths.join(" | "));
  const blocks = [
    ["коммерческие расходы", /коммерческ/],
    ["административные расходы", /административн/],
    ["расходы на транспортную логистику", /транспортн.*логист/],
    ["расходы на складскую логистику", /складск.*логист/],
    ["расходы ИТ", /расходы ит|информационн.*технолог/],
    ["расходы на персонал", /расходы на персонал/],
    ["ФЗП и компенсационные выплаты", /фзп|компенсационн.*выплат/],
    ["финансовые расходы", /финансовые расходы/],
    ["хозяйственные расходы", /хозяйственн.*расход/],
  ];
  return blocks.find(([, pattern]) => pattern.test(joined))?.[0] ?? "";
}

function intalevReportPlacementIndex(nodes = []) {
  const result = new Map();
  for (const node of nodes ?? []) {
    const label = text(node?.label ?? node?.name ?? node?.article);
    const key = normalizeBusinessText(label);
    const fullPath = text(node?.full_path ?? node?.path ?? node?.fullPath);
    const pathParts = fullPath.split(/\s+\/\s+/u).map(text).filter(Boolean);
    const normalizedParts = pathParts.map(normalizeBusinessText);
    const marker = normalizedParts.findIndex((part) => part === "статьи опиу 2025");
    if (!key || marker < 0 || marker + 1 >= pathParts.length) continue;
    const block = blockFromPaths([pathParts[marker + 1]]);
    if (!block) continue;
    const reportGroup = text(pathParts[marker + 2] ?? pathParts.at(-1));
    const amount = Number(node?.direct_total);
    const candidate = {
      label,
      path: fullPath,
      path_parts: pathParts,
      block,
      report_group: reportGroup,
      report_leaf: text(pathParts.at(-1)),
      node_id: text(node?.node_id),
      parent_node_id: text(node?.parent_node_id ?? node?.parent_id),
      direct_total: Number.isFinite(amount) ? amount : null,
      depth: pathParts.length,
      source: node?.source ?? null,
    };
    if (!result.has(key)) result.set(key, []);
    const signature = `${normalizeBusinessText(fullPath)}|${candidate.direct_total ?? ""}`;
    if (!result.get(key).some((item) => item.signature === signature)) {
      result.get(key).push({ ...candidate, signature });
    }
  }
  return result;
}

function inferIntalevReportPlacement(row, index) {
  const values = [
    row.article,
    ...(row.debit_analytics ?? []),
    ...(row.credit_analytics ?? []),
  ].map(text).filter(Boolean);
  const rowAmount = Math.abs(Number(row?.amount));
  const candidates = [];
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    const sourceValue = values[valueIndex];
    for (const candidate of index.get(normalizeBusinessText(sourceValue)) ?? []) {
      const directAmount = candidate.direct_total === null
        ? null
        : Math.abs(Number(candidate.direct_total));
      const exactAmount = Number.isFinite(rowAmount) && directAmount !== null
        && Math.abs(rowAmount - directAmount) <= 0.01;
      candidates.push({
        ...candidate,
        source_value: sourceValue,
        value_index: valueIndex,
        exact_amount: exactAmount,
      });
    }
  }
  if (candidates.length === 0) {
    return {
      status: "NOT_FOUND",
      block: "",
      report_group: "",
      report_leaf: "",
      path: "",
      node_id: "",
      parent_node_id: "",
      source_value: "",
      direct_total: null,
      source: null,
    };
  }
  candidates.sort((left, right) =>
    Number(right.exact_amount) - Number(left.exact_amount)
    || right.depth - left.depth
    || right.value_index - left.value_index
    || left.path.localeCompare(right.path, "ru"));
  const top = candidates[0];
  const equallyScoped = candidates.filter((candidate) =>
    candidate.exact_amount === top.exact_amount
    && candidate.depth === top.depth
    && candidate.value_index === top.value_index);
  const placementSignatures = [...new Set(equallyScoped.map((candidate) =>
    [candidate.block, candidate.report_group, candidate.report_leaf, candidate.path].join("|")))];
  const selected = placementSignatures.length === 1 ? top : null;
  return {
    status: selected
      ? top.exact_amount
        ? "PROVEN_LIVE_REPORT_LEAF_EXACT_AMOUNT"
        : "PROVEN_LIVE_REPORT_LEAF_ANALYTIC"
      : "AMBIGUOUS_LIVE_REPORT_PLACEMENT",
    block: selected?.block ?? "",
    report_group: selected?.report_group ?? "",
    report_leaf: selected?.report_leaf ?? "",
    path: selected?.path ?? "",
    node_id: selected?.node_id ?? "",
    parent_node_id: selected?.parent_node_id ?? "",
    source_value: selected?.source_value ?? "",
    direct_total: selected?.direct_total ?? null,
    source: selected?.source ?? null,
  };
}

function inferArticle(row, index, system = "") {
  const values = [
    row.article,
    ...(row.debit_analytics ?? []),
    ...(row.credit_analytics ?? []),
  ].map(text).filter(Boolean);
  const matches = [];
  const accounts = rowAccounts(row);
  for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    const value = values[valueIndex];
    const candidates = index.get(normalizeBusinessText(value)) ?? [];
    for (const candidate of candidates) {
      const accountMatched = [...candidate.accounts].some((expected) =>
        accounts.some((actual) => accountMatches(expected, actual)));
      matches.push({
        ...candidate,
        source_value: value,
        value_index: valueIndex,
        account_matched: accountMatched,
      });
    }
  }
  if (matches.length === 0) {
    return { article: "", paths: [], block: businessBlockFromRow(row), codes: [], accounts: [], status: "NOT_FOUND" };
  }
  const exactEntryBound = matches.filter((candidate) => candidate.entry_bound && candidate.exact_entry);
  const entryBound = exactEntryBound.length > 0
    ? exactEntryBound
    : matches.filter((candidate) => candidate.entry_bound);
  const scoped = system === "ERP" && entryBound.some((candidate) => candidate.account_matched)
    ? entryBound.filter((candidate) => candidate.account_matched)
    : entryBound.length > 0 && system === "ERP"
      ? entryBound
      : matches;
  scoped.sort((left, right) =>
    Number(right.account_matched) - Number(left.account_matched)
    || Number(right.entry_bound) - Number(left.entry_bound)
    || (system === "ERP" ? left.value_index - right.value_index : right.name.length - left.name.length)
    || left.path.localeCompare(right.path, "ru"));
  const top = scoped[0];
  const equallyScoped = scoped.filter((candidate) =>
    candidate.account_matched === top.account_matched
    && candidate.entry_bound === top.entry_bound
    && (system !== "ERP" || candidate.value_index === top.value_index)
    && normalizeBusinessText(candidate.name) === normalizeBusinessText(top.name));
  const uniquePaths = [...new Set(equallyScoped.map((candidate) => candidate.path).filter(Boolean))];
  const selected = equallyScoped.length === 1 || uniquePaths.length === 1 ? top : null;
  const paths = selected?.path ? [selected.path] : uniquePaths;
  const accountDerivedBlock = businessBlockFromRow(row);
  const pathDerivedBlock = blockFromPaths(paths);
  return {
    article: top.name,
    paths,
    block: accountDerivedBlock || pathDerivedBlock,
    codes: selected ? [...selected.codes] : [],
    accounts: selected ? [...selected.accounts] : [],
    operating_account: selected ? [...selected.accounts][0] ?? "" : "",
    status: selected ? (top.account_matched ? "MATCHED_BY_ACCOUNT" : "MATCHED_UNIQUE_PATH") : "AMBIGUOUS_PATH",
  };
}

function selectTargetArticle({ intalevRow, intalevArticle, erpArticle, erpIndex }) {
  const targetBlock = intalevArticle.block || businessBlockFromRow(intalevRow);
  const intalevTargetName = text(intalevArticle.article);
  const erpFallbackName = text(erpArticle.article);
  if (!targetBlock || (!intalevTargetName && !erpFallbackName)) {
    return {
      status: "BLOCKED_TARGET_INPUT",
      block: targetBlock,
      article: intalevTargetName || erpFallbackName,
      path: "",
      code: "",
      account: "",
      selection_basis: "TARGET_INPUT_MISSING",
    };
  }

  const select = (name) => {
    if (!name) return null;
    const allCandidates = (erpIndex.get(normalizeBusinessText(name)) ?? [])
      .filter((candidate) => candidate.entry_bound)
      .filter((candidate) =>
        normalizeBusinessText(blockFromPaths([candidate.path])) ===
          normalizeBusinessText(targetBlock));
    const exactCandidates = allCandidates.filter((candidate) => candidate.exact_entry);
    const candidates = exactCandidates.length > 0 ? exactCandidates : allCandidates;
    const signatures = [...new Set(candidates.map((candidate) => [
      candidate.path,
      [...candidate.codes].sort().join(","),
      [...candidate.accounts].sort().join(","),
    ].join("|")))];
    return { name, candidates, signatures };
  };

  const sameBlock = normalizeBusinessText(targetBlock)
    && normalizeBusinessText(targetBlock) === normalizeBusinessText(erpArticle.block);
  if (sameBlock && erpFallbackName) {
    const current = select(erpFallbackName);
    if (current?.signatures.length === 1) {
      const selected = current.candidates[0];
      return {
        status: "SAME_BLOCK_CURRENT_ARTICLE_CONFIRMED_BY_JOURNAL",
        block: targetBlock,
        article: selected.name,
        path: selected.path,
        code: [...selected.codes][0] ?? "",
        account: [...selected.accounts][0] ?? "",
        selection_basis: "ERP_CURRENT_ARTICLE_SAME_BLOCK",
      };
    }
  }

  const erpBlockSelection = select(erpFallbackName);
  if (erpBlockSelection?.signatures.length > 1) {
    return {
      status: "BLOCKED_TARGET_AMBIGUOUS",
      block: targetBlock,
      article: erpFallbackName,
      path: "",
      code: "",
      account: "",
      selection_basis: "ERP_SAME_ARTICLE_IN_INTALEV_BLOCK",
    };
  }
  const chosen = erpBlockSelection?.signatures.length === 1
    ? { ...erpBlockSelection, basis: "ERP_SAME_ARTICLE_IN_INTALEV_BLOCK" }
    : {
        ...(select(intalevTargetName) ?? {
          name: erpFallbackName,
          candidates: [],
          signatures: [],
        }),
        basis: "INTALEV_OPERATION_ARTICLE_FALLBACK",
      };

  if (chosen.signatures.length !== 1) {
    return {
      status: chosen.signatures.length > 1 ? "BLOCKED_TARGET_AMBIGUOUS" : "BLOCKED_TARGET_NOT_FOUND",
      block: targetBlock,
      article: chosen.name,
      path: "",
      code: "",
      account: "",
      selection_basis: chosen.basis,
    };
  }
  const selected = chosen.candidates[0];
  return {
    status: "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK",
    block: targetBlock,
    article: selected.name,
    path: selected.path,
    code: [...selected.codes][0] ?? "",
    account: [...selected.accounts][0] ?? "",
    selection_basis: chosen.basis,
  };
}

function personKey(row) {
  const values = [
    ...(row.debit_analytics ?? []),
    ...(row.credit_analytics ?? []),
  ].map(text).filter(Boolean);
  for (const value of values) {
    if (!/^[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2}$/u.test(value)) continue;
    const normalized = normalizeBusinessText(value);
    if (/^(финансовый|коммерческий|отдел|департамент|фонд|январь|фзп|ндфл)\b/.test(normalized)) continue;
    return normalized.split(" ").slice(0, 2).join(" ");
  }
  return "";
}

function isPayrollIntalevRow(row) {
  const values = [...(row.debit_analytics ?? []), ...(row.credit_analytics ?? [])]
    .map(normalizeBusinessText);
  return values.some((value) => value.startsWith("фзп ") || value === "фзп")
    && Boolean(businessBlockFromRow(row));
}

function isNdfLIntalevRow(row) {
  return [...(row.debit_analytics ?? []), ...(row.credit_analytics ?? [])]
    .some((value) => normalizeBusinessText(value) === "ндфл");
}

function physicalErpSource(row) {
  const debitAnalytics = Array.isArray(row?.debit_analytics) ? row.debit_analytics : [];
  const creditAnalytics = Array.isArray(row?.credit_analytics) ? row.credit_analytics : [];
  return {
    source_range: text(row?.source_range || `B${row?.physical_row}:AG${row?.physical_row}`),
    source_organization: text(row?.organization),
    source_date: text(row?.date),
    posting_number: text(row?.posting_no),
    source_dt: text(row?.debit),
    source_analytics_dt1: text(row?.debit_analytics_1 ?? debitAnalytics[0]),
    source_analytics_dt2: text(row?.debit_analytics_2 ?? debitAnalytics[1]),
    source_analytics_dt3: text(row?.debit_analytics_3 ?? debitAnalytics[2]),
    source_department_dt: text(row?.debit_department),
    source_kt: text(row?.credit),
    source_analytics_kt1: text(row?.credit_analytics_1 ?? creditAnalytics[0]),
    source_analytics_kt2: text(row?.credit_analytics_2 ?? creditAnalytics[1]),
    source_analytics_kt3: text(row?.credit_analytics_3 ?? creditAnalytics[2]),
    source_department_kt: text(row?.credit_department),
    source_amount: Math.abs(Number(row?.amount)),
    source_article: text(row?.article),
  };
}

function buildPayrollReclassificationRows({ intalev, erp, period, erpIndex, matchedIntalev, matchedErp }) {
  const payrollIntalev = intalev.filter((row) =>
    !matchedIntalev.has(row.source_row_id) && isPayrollIntalevRow(row) && personKey(row));
  const byPersonDateBlock = new Map();
  for (const row of payrollIntalev) {
    const key = [dateOnly(row.date_value || row.date), personKey(row), businessBlockFromRow(row)].join("|");
    if (!byPersonDateBlock.has(key)) byPersonDateBlock.set(key, []);
    byPersonDateBlock.get(key).push(row);
  }

  const rows = [];
  const usedIntalevSourceIds = new Set();
  const reuseConflicts = [];
  const add = ({ rowType, erpRow, members, reason }) => {
    const memberIds = members.map((member) => text(member?.source_row_id)).filter(Boolean);
    const duplicateMemberIds = memberIds.filter((sourceId, index) => memberIds.indexOf(sourceId) !== index);
    const alreadyUsedIds = memberIds.filter((sourceId) => usedIntalevSourceIds.has(sourceId));
    const conflictingIds = [...new Set([...duplicateMemberIds, ...alreadyUsedIds])];
    if (conflictingIds.length > 0) {
      reuseConflicts.push({
        erp_source_row_id: text(erpRow?.source_row_id),
        intalev_source_row_ids: conflictingIds,
        reason: "INTALEV_SOURCE_ROW_REUSED",
      });
      return;
    }
    const targetBlock = businessBlockFromRow(members[0]);
    if (!targetBlock || members.some((member) => businessBlockFromRow(member) !== targetBlock)) return;
    const targetArticle = selectTargetArticle({
      intalevRow: members[0],
      intalevArticle: { ...members[0].article_info, block: targetBlock },
      erpArticle: erpRow.article_info,
      erpIndex,
    });
    const sourceBlock = erpRow.article_info.block;
    if (!sourceBlock || normalizeBusinessText(sourceBlock) === normalizeBusinessText(targetBlock)) return;
    const articles = summarizeArticles(
      { ...members[0].article_info, block: targetBlock },
      erpRow.article_info,
      targetArticle,
    );
    rows.push({
      row_type: rowType,
      classification: articles.classification,
      confidence: 100,
      period,
      block_intalev: targetBlock,
      source_block_erp: sourceBlock,
      target_block_intalev: targetBlock,
      article_intalev: [...new Set(members.flatMap((member) =>
        (member.debit_analytics ?? []).slice(0, 2).map(text).filter(Boolean)))].join(" + "),
      article_erp: erpRow.article_info.article,
      source_article_code_erp: erpRow.article_info.codes.join(", "),
      source_operating_account: erpRow.article_info.operating_account
        || canonicalAccount(erpRow.disclosure)
        || canonicalAccount(erpRow.analytics3),
      target_article_erp: targetArticle.article,
      target_article_code_erp: targetArticle.code,
      target_operating_account: targetArticle.account,
      target_catalog_path: targetArticle.path,
      target_status: targetArticle.status,
      amount: Math.abs(Number(erpRow.amount)),
      date: erpRow.date_value || dateOnly(erpRow.date),
      debit: erpRow.debit,
      credit: erpRow.credit,
      analytics: `Сотрудник: ${personKey(erpRow)}; компоненты Инталев: ${members.length}`,
      content: erpRow.content || members.map((member) => member.content).filter(Boolean).join(" | "),
      intalev_document: [...new Set(members.map((member) => member.document))].join(" | "),
      intalev_rows: members.map((member) => member.physical_row).join(", "),
      erp_document: erpRow.document,
      erp_rows: String(erpRow.physical_row),
      reason,
      action: articles.action,
      reused: false,
      intalev_source_row_id: members.map((member) => member.source_row_id).join(" | "),
      erp_source_row_id: erpRow.source_row_id,
      intalev_path: [...new Set(members.flatMap((member) => member.article_info.paths))].join(" | "),
      erp_path: erpRow.article_info.paths.join(" | "),
      ...physicalErpSource(erpRow),
    });
    for (const sourceId of memberIds) usedIntalevSourceIds.add(sourceId);
  };

  for (const erpRow of erp) {
    if (matchedErp.has(erpRow.source_row_id) || !personKey(erpRow)) continue;
    const article = normalizeBusinessText(erpRow.article_info.article);
    if (article === "фзп") {
      const candidates = [...byPersonDateBlock.entries()]
        .filter(([key]) => key.startsWith(`${dateOnly(erpRow.date_value || erpRow.date)}|${personKey(erpRow)}|`))
        .map(([, members]) => members)
        .filter((members) => amountCents(members.reduce((sum, member) => sum + Number(member.amount ?? 0), 0)) === Math.abs(amountCents(erpRow.amount)));
      if (candidates.length === 1) {
        add({
          rowType: "PAYROLL_COMPOSITE_PAIR",
          erpRow,
          members: candidates[0],
          reason: `ФЗП ERP равна точной сумме ${candidates[0].length} компонентов Инталев по одному сотруднику, дате и расчётному счёту; группа назначения взята из счёта затрат Инталев.`,
        });
      }
    }
    if (article === "ндфл") {
      const candidates = payrollIntalev.filter((member) =>
        isNdfLIntalevRow(member)
        && dateOnly(member.date_value || member.date) === dateOnly(erpRow.date_value || erpRow.date)
        && personKey(member) === personKey(erpRow)
        && Math.abs(amountCents(member.amount)) === Math.abs(amountCents(erpRow.amount)));
      if (candidates.length === 1) {
        add({
          rowType: "PAYROLL_COMPONENT_PAIR",
          erpRow,
          members: candidates,
          reason: "НДФЛ связан по одному сотруднику, дате и точной сумме; группа назначения взята из расходной строки НДФЛ Инталев.",
        });
      }
    }
  }
  return { rows, reuse_conflicts: reuseConflicts };
}

function analyticsValues(row) {
  return [
    ...(row.debit_analytics ?? []),
    ...(row.credit_analytics ?? []),
    row.department,
    row.debit_department,
    row.credit_department,
    row.cfo,
    row.company,
  ].map(text).filter(Boolean);
}

function normalizedAnalytics(row) {
  return analyticsValues(row)
    .map(normalizeBusinessText)
    .filter((value) => value.length >= 3 && !GENERIC_ANALYTICS.has(value));
}

function meaningfulTokens(value) {
  return new Set(normalizeBusinessText(value).split(" ").filter((token) =>
    token.length >= 4 && !/^(ооо|ип|отдел|департамент|счет|затрат)$/.test(token)));
}

function tokenSimilarity(left, right) {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return common / new Set([...leftTokens, ...rightTokens]).size;
}

function analyticsOverlap(left, right) {
  const leftValues = normalizedAnalytics(left);
  const rightValues = normalizedAnalytics(right);
  const rightSet = new Set(rightValues);
  const exact = leftValues.filter((value) => rightSet.has(value));
  if (exact.length > 0) return { score: 15, values: [...new Set(exact)] };
  let best = null;
  for (const leftValue of leftValues) {
    for (const rightValue of rightValues) {
      const similarity = tokenSimilarity(leftValue, rightValue);
      if (similarity >= 0.75 && (!best || similarity > best.similarity)) {
        best = { similarity, leftValue, rightValue };
      }
    }
  }
  return best ? { score: 10, values: [`${best.leftValue} ≈ ${best.rightValue}`] } : { score: 0, values: [] };
}

function contentScore(left, right) {
  const leftContent = normalizeBusinessText(left.content);
  const rightContent = normalizeBusinessText(right.content);
  if (!leftContent || !rightContent) return { score: 0, reason: "содержание пусто" };
  if (leftContent === rightContent) return { score: 15, reason: "содержание совпало точно" };
  if (leftContent.includes(rightContent) || rightContent.includes(leftContent)) {
    return { score: 12, reason: "одно содержание входит в другое" };
  }
  const similarity = tokenSimilarity(leftContent, rightContent);
  if (similarity >= 0.75) return { score: 12, reason: "содержание почти совпало" };
  if (similarity >= 0.5) return { score: 8, reason: "содержание частично совпало" };
  return { score: 0, reason: "содержание различается" };
}

function departmentScore(left, right) {
  const intalev = [left.department, left.cfo].filter(Boolean).join(" ");
  const erp = [right.debit_department, right.credit_department].filter(Boolean).join(" ");
  return tokenSimilarity(intalev, erp) >= 0.25 ? 5 : 0;
}

function baseKey(row) {
  const debit = normalizeAccount(row.debit);
  const credit = normalizeAccount(row.credit);
  const debitOperating = Boolean(accountBlock(debit));
  const creditOperating = Boolean(accountBlock(credit));
  const accountRoute = debitOperating !== creditOperating
    ? debitOperating
      ? `EXPENSE_DEBIT|${canonicalAccount(credit).split(".")[0]}`
      : `EXPENSE_CREDIT|${canonicalAccount(debit).split(".")[0]}`
    : `${debit}|${credit}`;
  return [
    dateOnly(row.date_value || row.date),
    Math.abs(amountCents(row.amount) ?? 0),
    accountRoute,
  ].join("|");
}

function accountRouteScore(left, right) {
  const leftDebit = normalizeAccount(left.debit);
  const leftCredit = normalizeAccount(left.credit);
  const rightDebit = normalizeAccount(right.debit);
  const rightCredit = normalizeAccount(right.credit);
  if (leftDebit === rightDebit && leftCredit === rightCredit) {
    return { score: 20, reason: "счета Дт/Кт совпали" };
  }
  const leftDebitOperating = Boolean(accountBlock(leftDebit));
  const leftCreditOperating = Boolean(accountBlock(leftCredit));
  const rightDebitOperating = Boolean(accountBlock(rightDebit));
  const rightCreditOperating = Boolean(accountBlock(rightCredit));
  const sameExpenseRoute = leftDebitOperating && rightDebitOperating
    && !leftCreditOperating && !rightCreditOperating && accountMatches(leftCredit, rightCredit);
  const sameIncomeRoute = leftCreditOperating && rightCreditOperating
    && !leftDebitOperating && !rightDebitOperating && accountMatches(leftDebit, rightDebit);
  if (sameExpenseRoute || sameIncomeRoute) {
    return {
      score: 18,
      reason: `расчётная сторона совпала, счёт затрат различается (${leftDebit}/${leftCredit} → ${rightDebit}/${rightCredit})`,
    };
  }
  return { score: 0, reason: "маршрут счетов не совпал" };
}

function rowEligible(row, period, system) {
  if (row.period !== period) return false;
  if (normalizeBusinessText(row.scenario) !== "факт") return false;
  if (system === "ERP" && normalizeBusinessText(row.activity) !== "да") return false;
  if (!amountCents(row.amount)) return false;
  if (normalizeAccount(row.debit) === "99" && normalizeAccount(row.credit) === "84") return false;
  if (/распределение остатков и оборотов/i.test(text(row.content))) return false;
  return true;
}

function compareRows(intalev, erp) {
  const content = contentScore(intalev, erp);
  const analytics = analyticsOverlap(intalev, erp);
  const department = departmentScore(intalev, erp);
  const accountRoute = accountRouteScore(intalev, erp);
  const score = 30 + 15 + accountRoute.score + content.score + analytics.score + department;
  return {
    score,
    content,
    analytics,
    department,
    reason: [
      "сумма совпала",
      "дата совпала",
      accountRoute.reason,
      content.reason,
      analytics.values.length > 0
        ? `общие аналитики: ${analytics.values.join(", ")}`
        : "общая аналитика не найдена",
      department ? "подразделение совпало по смыслу" : "подразделение не подтвердило пару",
    ].join("; "),
  };
}

function summarizeArticles(intalevArticle, erpArticle, targetArticle) {
  const sameArticle = normalizeBusinessText(intalevArticle.article)
    && normalizeBusinessText(intalevArticle.article) === normalizeBusinessText(erpArticle.article);
  const sameBlock = normalizeBusinessText(targetArticle.block || intalevArticle.block)
    && normalizeBusinessText(targetArticle.block || intalevArticle.block) === normalizeBusinessText(erpArticle.block);
  if (targetArticle.status === "SAME_BLOCK_CURRENT_ARTICLE_CONFIRMED_BY_JOURNAL") {
    return {
      classification: "ОДНА ОПЕРАЦИЯ / СТАТЬЯ ERP ПРИВЯЗАНА К ГРУППЕ ИНТАЛЕВ",
      action: "Проводка не меняется; журнал подтверждает операцию, а фактический путь Инталев определяет её место в ОПИУ.",
    };
  }
  if (sameArticle && sameBlock) {
    return {
      classification: "ОДНА ОПЕРАЦИЯ / ОДНА СТАТЬЯ",
      action: "Корректировка не требуется; операция объясняет совпадающую часть журналов.",
    };
  }
  if (intalevArticle.article && erpArticle.article) {
    const targetProven = targetArticle.status === "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK";
    return {
      classification: sameBlock
        ? "ОДНА ОПЕРАЦИЯ / РАЗНЫЕ СТАТЬИ / ВНУТРИГРУППОВОЙ ПЕРЕСОРТ"
        : "ОДНА ОПЕРАЦИЯ / РАЗНЫЕ ГРУППЫ / МЕЖГРУППОВОЙ ПЕРЕСОРТ",
      action: targetProven && !sameBlock
        ? `STORNO с фактической статьи ERP блока «${erpArticle.block}»; REPOST на «${targetArticle.article}» блока «${targetArticle.block}».`
        : targetProven
          ? `STORNO с фактической статьи ERP; REPOST на «${targetArticle.article}» внутри блока «${targetArticle.block}».`
          : "Целевой путь ERP внутри блока Инталев не определён однозначно; проводку не формировать.",
    };
  }
  return {
    classification: "ОДНА ОПЕРАЦИЯ / СТАТЬЯ ОДНОЙ СТОРОНЫ НЕ РАСПОЗНАНА",
    action: "Проверить справочник статьи; проводку не формировать.",
  };
}

function duplicateRows(rows, system) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.article_info?.article) continue;
    const key = [
      baseKey(row),
      normalizeBusinessText(row.content),
      normalizeBusinessText(row.article_info.article),
      [...new Set(normalizedAnalytics(row))].sort().join("|"),
      Math.sign(Number(row.amount)),
    ].join("||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].filter((group) => group.length > 1).slice(0, 100).map((group) => ({
    row_type: "DUPLICATE_CANDIDATE",
    classification: `КАНДИДАТ НА ДУБЛЬ ${system}`,
    confidence: 0,
    period: group[0].period,
    block_intalev: system === "INTALEV" ? group[0].article_info.block : "",
    article_intalev: system === "INTALEV" ? group[0].article_info.article : "",
    article_erp: system === "ERP" ? group[0].article_info.article : "",
    amount: group[0].amount,
    date: group[0].date_value || group[0].date,
    debit: group[0].debit,
    credit: group[0].credit,
    analytics: analyticsValues(group[0]).join(" | "),
    content: group[0].content,
    intalev_document: system === "INTALEV" ? group.map((row) => row.document).join(" | ") : "",
    intalev_rows: system === "INTALEV" ? group.map((row) => row.physical_row).join(", ") : "",
    erp_document: system === "ERP" ? group.map((row) => row.document).join(" | ") : "",
    erp_rows: system === "ERP" ? group.map((row) => row.physical_row).join(", ") : "",
    reason: `${group.length} физические строки имеют одинаковый строгий бизнес-отпечаток. Это только кандидат: зеркальные и технические строки должны быть проверены.`,
    action: "Проверить документы и знаки; автоматически не удалять.",
    reused: false,
    intalev_source_row_id: system === "INTALEV" ? group.map((row) => row.source_row_id).join(" | ") : "",
    erp_source_row_id: system === "ERP" ? group.map((row) => row.source_row_id).join(" | ") : "",
    intalev_path: system === "INTALEV" ? group[0].article_info.paths.join(" | ") : "",
    erp_path: system === "ERP" ? group[0].article_info.paths.join(" | ") : "",
  }));
}

function unmatchedArticleRows(rows, matchedIds, system) {
  const groups = new Map();
  for (const row of rows) {
    if (matchedIds.has(row.source_row_id) || !row.article_info?.article) continue;
    const key = `${normalizeBusinessText(row.article_info.block)}|${normalizeBusinessText(row.article_info.article)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((group) => ({
    row_type: system === "INTALEV" ? "INTALEV_ONLY_AGGREGATE" : "ERP_ONLY_AGGREGATE",
    classification: system === "INTALEV" ? "ТОЛЬКО ИНТАЛЕВ" : "ТОЛЬКО ERP",
    confidence: 0,
    period: group[0].period,
    block_intalev: system === "INTALEV" ? group[0].article_info.block : "",
    article_intalev: system === "INTALEV" ? group[0].article_info.article : "",
    article_erp: system === "ERP" ? group[0].article_info.article : "",
    amount: Math.round(group.reduce((sum, row) => sum + Number(row.amount ?? 0), 0) * 100) / 100,
    date: "",
    debit: "",
    credit: "",
    analytics: `Строк: ${group.length}; примеры: ${group.slice(0, 3).map((row) => `${row.physical_row}:${analyticsValues(row).slice(0, 2).join("/")}`).join("; ")}`,
    content: group.slice(0, 3).map((row) => text(row.content)).filter(Boolean).join(" | "),
    intalev_document: system === "INTALEV" ? group.slice(0, 3).map((row) => row.document).join(" | ") : "",
    intalev_rows: system === "INTALEV" ? group.slice(0, 20).map((row) => row.physical_row).join(", ") : "",
    erp_document: system === "ERP" ? group.slice(0, 3).map((row) => row.document).join(" | ") : "",
    erp_rows: system === "ERP" ? group.slice(0, 20).map((row) => row.physical_row).join(", ") : "",
    reason: `После взаимно-уникального сопоставления ${group.length} строк статьи не получили доказанную пару.`,
    action: "Проверить фильтр, период, статью и возможное составное соответствие нескольких строк.",
    reused: false,
    intalev_source_row_id: "",
    erp_source_row_id: "",
    intalev_path: system === "INTALEV" ? group[0].article_info.paths.join(" | ") : "",
    erp_path: system === "ERP" ? group[0].article_info.paths.join(" | ") : "",
  }));
}

export function matchCrossJournalRows({
  intalevRows,
  erpRows,
  period,
  intalevCatalogNodes = [],
  intalevReportNodes = [],
  erpCatalogNodes = [],
}) {
  const intalevIndex = catalogArticleIndex(intalevCatalogNodes);
  const intalevReportIndex = intalevReportPlacementIndex(intalevReportNodes);
  const erpIndex = catalogArticleIndex(erpCatalogNodes);
  const intalev = (intalevRows ?? []).filter((row) => rowEligible(row, period, "INTALEV"))
    .map((row) => {
      const articleInfo = inferArticle(row, intalevIndex, "INTALEV");
      const reportPlacement = inferIntalevReportPlacement(row, intalevReportIndex);
      return {
        ...row,
        article_info: {
          ...articleInfo,
          block: reportPlacement.block || articleInfo.block,
          report_placement: reportPlacement,
        },
      };
    });
  const erp = (erpRows ?? []).filter((row) => rowEligible(row, period, "ERP"))
    .map((row) => ({
      ...row,
      system: "ERP",
      source_row_id: row.source_row_id,
      article_info: inferArticle(row, erpIndex, "ERP"),
    }));

  const erpByBase = new Map();
  for (const row of erp) {
    const key = baseKey(row);
    if (!erpByBase.has(key)) erpByBase.set(key, []);
    erpByBase.get(key).push(row);
  }
  const edges = [];
  for (const intalevRow of intalev) {
    for (const erpRow of erpByBase.get(baseKey(intalevRow)) ?? []) {
      const comparison = compareRows(intalevRow, erpRow);
      if (comparison.score >= REVIEW_SCORE) edges.push({ intalevRow, erpRow, ...comparison });
    }
  }
  const byIntalev = new Map();
  const byErp = new Map();
  for (const edge of edges) {
    if (!byIntalev.has(edge.intalevRow.source_row_id)) byIntalev.set(edge.intalevRow.source_row_id, []);
    if (!byErp.has(edge.erpRow.source_row_id)) byErp.set(edge.erpRow.source_row_id, []);
    byIntalev.get(edge.intalevRow.source_row_id).push(edge);
    byErp.get(edge.erpRow.source_row_id).push(edge);
  }
  const sortEdges = (items) => items.sort((left, right) => right.score - left.score);
  for (const items of byIntalev.values()) sortEdges(items);
  for (const items of byErp.values()) sortEdges(items);

  const accepted = [];
  const ambiguous = [];
  for (const [intalevId, candidates] of byIntalev.entries()) {
    const top = candidates[0];
    const reverse = byErp.get(top.erpRow.source_row_id) ?? [];
    const intalevUnique = candidates.length === 1 || top.score > candidates[1].score;
    const erpUnique = reverse.length === 1 || top.score > reverse[1].score;
    if (
      top.score >= PROVEN_SCORE
      && intalevUnique
      && erpUnique
      && reverse[0]?.intalevRow.source_row_id === intalevId
    ) {
      accepted.push(top);
    } else {
      ambiguous.push(top);
    }
  }

  const matchedIntalev = new Set(accepted.map((edge) => edge.intalevRow.source_row_id));
  const matchedErp = new Set(accepted.map((edge) => edge.erpRow.source_row_id));
  const pairRows = accepted.map((edge) => {
    const targetArticle = selectTargetArticle({
      intalevRow: edge.intalevRow,
      intalevArticle: edge.intalevRow.article_info,
      erpArticle: edge.erpRow.article_info,
      erpIndex,
    });
    const articles = summarizeArticles(edge.intalevRow.article_info, edge.erpRow.article_info, targetArticle);
    return {
      row_type: "UNIQUE_PAIR",
      classification: articles.classification,
      confidence: edge.score,
      period,
      block_intalev: edge.intalevRow.article_info.block,
      source_block_erp: edge.erpRow.article_info.block,
      target_block_intalev: targetArticle.block,
      article_intalev: edge.intalevRow.article_info.article,
      article_erp: edge.erpRow.article_info.article,
      source_article_code_erp: edge.erpRow.article_info.codes.join(", "),
      source_operating_account: edge.erpRow.article_info.operating_account
        || canonicalAccount(edge.erpRow.disclosure)
        || canonicalAccount(edge.erpRow.analytics3),
      target_article_erp: targetArticle.article,
      target_article_code_erp: targetArticle.code,
      target_operating_account: targetArticle.account,
      target_catalog_path: targetArticle.path,
      target_status: targetArticle.status,
      amount: Math.abs(Number(edge.erpRow.amount)),
      date: edge.erpRow.date_value || dateOnly(edge.erpRow.date),
      debit: edge.erpRow.debit,
      credit: edge.erpRow.credit,
      analytics: edge.analytics.values.join(" | "),
      content: edge.erpRow.content || edge.intalevRow.content,
      intalev_document: edge.intalevRow.document,
      intalev_rows: String(edge.intalevRow.physical_row),
      erp_document: edge.erpRow.document,
      erp_rows: String(edge.erpRow.physical_row),
      reason: edge.reason,
      action: articles.action,
      reused: false,
      intalev_source_row_id: edge.intalevRow.source_row_id,
      erp_source_row_id: edge.erpRow.source_row_id,
      intalev_path: edge.intalevRow.article_info.paths.join(" | "),
      intalev_report_placement_status:
        edge.intalevRow.article_info.report_placement?.status ?? "NOT_FOUND",
      intalev_report_block:
        edge.intalevRow.article_info.report_placement?.block ?? "",
      intalev_report_group:
        edge.intalevRow.article_info.report_placement?.report_group ?? "",
      intalev_report_leaf:
        edge.intalevRow.article_info.report_placement?.report_leaf ?? "",
      intalev_report_path:
        edge.intalevRow.article_info.report_placement?.path ?? "",
      intalev_report_node_id:
        edge.intalevRow.article_info.report_placement?.node_id ?? "",
      erp_path: edge.erpRow.article_info.paths.join(" | "),
      ...physicalErpSource(edge.erpRow),
    };
  });
  const payrollResult = buildPayrollReclassificationRows({
    intalev,
    erp,
    period,
    erpIndex,
    matchedIntalev,
    matchedErp,
  });
  const payrollRows = payrollResult.rows;
  for (const row of payrollRows) {
    for (const sourceId of String(row.intalev_source_row_id ?? "").split(/\s+\|\s+/).filter(Boolean)) {
      matchedIntalev.add(sourceId);
    }
    if (row.erp_source_row_id) matchedErp.add(row.erp_source_row_id);
  }
  const ambiguousRows = ambiguous.slice(0, 500).map((edge) => ({
    row_type: "AMBIGUOUS_PAIR",
    classification: "НЕОДНОЗНАЧНОЕ СОПОСТАВЛЕНИЕ",
    confidence: edge.score,
    period,
    block_intalev: edge.intalevRow.article_info.block,
    article_intalev: edge.intalevRow.article_info.article,
    article_erp: edge.erpRow.article_info.article,
    amount: Math.abs(Number(edge.erpRow.amount)),
    date: edge.erpRow.date_value || dateOnly(edge.erpRow.date),
    debit: edge.erpRow.debit,
    credit: edge.erpRow.credit,
    analytics: edge.analytics.values.join(" | "),
    content: edge.erpRow.content || edge.intalevRow.content,
    intalev_document: edge.intalevRow.document,
    intalev_rows: String(edge.intalevRow.physical_row),
    erp_document: edge.erpRow.document,
    erp_rows: String(edge.erpRow.physical_row),
    reason: `${edge.reason}; найдено несколько возможных кандидатов или нет взаимной уникальности.`,
    action: "Проверить вручную; проводку не формировать.",
    reused: false,
    intalev_source_row_id: edge.intalevRow.source_row_id,
    erp_source_row_id: edge.erpRow.source_row_id,
    intalev_path: edge.intalevRow.article_info.paths.join(" | "),
    erp_path: edge.erpRow.article_info.paths.join(" | "),
  }));
  const duplicates = [
    ...duplicateRows(intalev, "INTALEV"),
    ...duplicateRows(erp, "ERP"),
  ];
  const unmatched = [
    ...unmatchedArticleRows(intalev, matchedIntalev, "INTALEV"),
    ...unmatchedArticleRows(erp, matchedErp, "ERP"),
  ];
  const provenRows = [...pairRows, ...payrollRows];
  const rows = [...provenRows, ...ambiguousRows, ...duplicates, ...unmatched];
  const provenIntalevSourceIds = provenRows.flatMap((row) =>
    String(row.intalev_source_row_id ?? "").split(/\s+\|\s+/).filter(Boolean));
  const provenErpSourceIds = provenRows.map((row) => text(row.erp_source_row_id)).filter(Boolean);
  const reusedIntalev = provenIntalevSourceIds.length - new Set(provenIntalevSourceIds).size;
  const reusedErp = provenErpSourceIds.length - new Set(provenErpSourceIds).size;
  return {
    rows,
    counts: {
      intalev_scoped_rows: intalev.length,
      erp_scoped_rows: erp.length,
      candidate_edges: edges.length,
      unique_pairs: provenRows.length,
      direct_unique_pairs: pairRows.length,
      payroll_composite_pairs: payrollRows.filter((row) => row.row_type === "PAYROLL_COMPOSITE_PAIR").length,
      payroll_component_pairs: payrollRows.filter((row) => row.row_type === "PAYROLL_COMPONENT_PAIR").length,
      different_article_pairs: provenRows.filter((row) => row.classification.includes("ПЕРЕСОРТ")).length,
      same_article_pairs: provenRows.filter((row) => row.classification.includes("ОДНА СТАТЬЯ")).length,
      proven_intergroup_reposts: provenRows.filter((row) =>
        row.classification.includes("МЕЖГРУППОВОЙ")
        && row.target_status === "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK").length,
      ambiguous_pairs: ambiguousRows.length,
      duplicate_groups: duplicates.length,
      unmatched_article_groups: unmatched.length,
      payroll_intalev_reuse_conflicts: payrollResult.reuse_conflicts.length,
      reused_intalev_rows: reusedIntalev,
      reused_erp_rows: reusedErp,
    },
  };
}

export async function buildCrossJournalDiscrepancyEvidence({
  intalevJournalPath,
  erpJournalPath,
  period,
  organization,
  intalevCatalogNodes = [],
  intalevReportNodes = [],
  erpCatalogNodes = [],
  erpSourceArchivePath = "",
  erpSourceArchiveSha256 = "",
  erpJournalEntry = "",
}) {
  const [intalevJournal, erpJournal] = await Promise.all([
    readIntalevJournalRows({ journalPath: intalevJournalPath }),
    readOperationJournalRows({ journalPath: erpJournalPath, sheet: "Лист_1" }),
  ]);
  const result = matchCrossJournalRows({
    intalevRows: intalevJournal.rows,
    erpRows: erpJournal.rows,
    period,
    intalevCatalogNodes,
    intalevReportNodes,
    erpCatalogNodes,
  });
  const rows = result.rows.map((row) => ({
    ...row,
    source_archive_path: text(erpSourceArchivePath),
    source_archive_sha256: text(erpSourceArchiveSha256),
    journal_entry: text(erpJournalEntry),
    journal_sha256: erpJournal.journal_sha256,
    source_sheet: erpJournal.journal_sheet,
  }));
  const provenIntergroupRows = rows.filter((row) =>
    row.classification?.includes("МЕЖГРУППОВОЙ")
      && row.target_status === "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK"
      && normalizeBusinessText(row.source_block_erp) !== normalizeBusinessText(row.target_block_intalev));
  return {
    schema: CROSS_JOURNAL_SCHEMA,
    status: "READY_REPORT_ONLY",
    applicable: true,
    organization,
    period,
    sources: {
      intalev: {
        path: intalevJournal.source,
        sha256: intalevJournal.source_sha256,
        sheet: intalevJournal.sheet,
        header_row: intalevJournal.header_row,
      },
      erp: {
        path: path.resolve(erpJournalPath),
        sha256: erpJournal.journal_sha256,
        sheet: erpJournal.journal_sheet,
        header_row: erpJournal.header_row,
      },
    },
    ...result,
    rows,
    correction_decision_rows: provenIntergroupRows.length * 2,
    gates: {
      report_only: true,
      correction_authority: provenIntergroupRows.length > 0,
      posting_rows: provenIntergroupRows.length * 2,
      execution_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      physical_row_reuse_blocked:
        result.counts.reused_intalev_rows === 0 && result.counts.reused_erp_rows === 0,
    },
  };
}

export function unavailableCrossJournalEvidence({ organization, period, status, reason }) {
  return {
    schema: CROSS_JOURNAL_SCHEMA,
    status,
    applicable: false,
    organization,
    period,
    reason,
    sources: null,
    rows: [],
    counts: {
      intalev_scoped_rows: 0,
      erp_scoped_rows: 0,
      candidate_edges: 0,
      unique_pairs: 0,
      direct_unique_pairs: 0,
      payroll_composite_pairs: 0,
      payroll_component_pairs: 0,
      different_article_pairs: 0,
      same_article_pairs: 0,
      proven_intergroup_reposts: 0,
      ambiguous_pairs: 0,
      duplicate_groups: 0,
      unmatched_article_groups: 0,
      payroll_intalev_reuse_conflicts: 0,
      reused_intalev_rows: 0,
      reused_erp_rows: 0,
    },
    gates: {
      report_only: true,
      correction_authority: false,
      posting_rows: 0,
      execution_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      physical_row_reuse_blocked: true,
    },
  };
}
