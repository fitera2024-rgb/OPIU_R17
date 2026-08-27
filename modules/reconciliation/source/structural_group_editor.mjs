import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStructuralControlSettingsCsv } from "./structural_control_settings_binding.mjs";

const SPLIT_HEADERS = Object.freeze([
  "Организация",
  "Название группы",
  "Блоки Инталев",
  "Блоки ERP",
  "Активна",
]);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim();
}

function upper(value) {
  return text(value).toLocaleUpperCase("ru-RU");
}

function parseArgs(tokens) {
  const args = { _: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function parseCodes(value) {
  return [...new Set(text(value).split(/[\s,]+/u).map(upper).filter(Boolean))];
}

function finiteAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function cents(value) {
  return Math.round((finiteAmount(value) + Number.EPSILON) * 100);
}

function displayLabel(row) {
  const hierarchyPath = Array.isArray(row?.hierarchy_path)
    ? row.hierarchy_path.map(text).filter(Boolean)
    : [];
  return text(row?.intalev_label)
    || text(row?.erp_label)
    || hierarchyPath.at(-1)
    || upper(row?.code);
}

function normalizedArticle(value) {
  return upper(value)
    .replace(/^\d+[._\-\s]+/u, "")
    .replace(/[«»"']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sourceIdentity(source = {}) {
  const sha256 = upper(source?.sha256);
  const sheet = text(source?.sheet);
  const row = Number(source?.row);
  return sha256 && sheet && Number.isFinite(row) ? `${sha256}|${sheet}|${row}` : "";
}

function sourceLastLabel(source = {}) {
  return text(source?.full_path).split(/\s+\/\s+/u).map(text).filter(Boolean).at(-1) || "";
}

function primaryErpSource(row = {}) {
  const sources = Array.isArray(row?.erp_sources) ? row.erp_sources : [];
  const wantedLabel = normalizedArticle(row?.erp_label);
  const wantedCents = cents(row?.erp_amount ?? row?.erp?.amount);
  return sources
    .map((source, index) => {
      const labels = [source?.summary_label, source?.label, sourceLastLabel(source)]
        .map(normalizedArticle)
        .filter(Boolean);
      let score = -index / 1000;
      if (cents(source?.amount) === wantedCents) score += 8;
      if (wantedLabel && labels.includes(wantedLabel)) score += 10;
      if (wantedLabel && labels.some((label) => label.includes(wantedLabel) || wantedLabel.includes(label))) score += 3;
      return { source, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.source ?? null;
}

function sourcePathParts(value) {
  return (Array.isArray(value) ? value : text(value).split(/\s+\/\s+/u))
    .map(text)
    .filter(Boolean);
}

function sourcePathIdentity(value) {
  return sourcePathParts(value).map(normalizedArticle).join(" / ");
}

function isExpenseBlockLabel(value) {
  const label = normalizedArticle(value);
  return /РАСХОД|ЗАТРАТ|СЕБЕСТОИМ/u.test(label)
    && !/ИТОГО|ПРИБЫЛ|РЕЗУЛЬТАТ|ДОХОД|ВЫРУЧ|ЧИСТАЯ/u.test(label);
}

// A business block is the immediate child of "_Статьи ОПиУ 2025" in the
// physical Intalev tree.  Articles such as FZP, NDFL and IT expenses are
// descendants and must never appear as independent blocks in this editor.
function isSourceExpenseBlockNode(node = {}) {
  const parts = sourcePathParts(node?.full_path);
  if (!isExpenseBlockLabel(node?.label ?? node?.name)) return false;
  const marker = parts.findIndex((part) => normalizedArticle(part) === "СТАТЬИ ОПИУ 2025");
  if (marker >= 0) return marker === parts.length - 2;
  // Compatibility for old, already produced sidecars with a shortened tree.
  return parts.length === 2 && /РАСХОД/u.test(normalizedArticle(parts[0]));
}

function hierarchyPeriod(payload = {}) {
  const periods = Array.isArray(payload?.hierarchy_periods) ? payload.hierarchy_periods : [];
  return periods.find((entry) => text(entry?.period) === text(payload?.period)) ?? periods[0] ?? {};
}

function compactSourceItem(node, code = "") {
  const source = node?.source ?? {};
  return {
    node_id: text(node?.node_id),
    parent_node_id: text(node?.parent_node_id),
    label: text(node?.label ?? node?.name),
    path: text(node?.full_path).split(/\s+\/\s+/u).map(text).filter(Boolean),
    level: Number.isFinite(Number(node?.level)) ? Number(node.level) : 0,
    amount: finiteAmount(node?.direct_total),
    is_group: node?.is_group === true,
    code: upper(code),
    selectable: Boolean(code),
    source_file: text(source?.file) ? path.basename(text(source.file)) : "",
    source_sheet: text(source?.sheet),
    source_cell: text(source?.source_cell),
    source_row: Number.isFinite(Number(source?.row)) ? Number(source.row) : null,
  };
}

function visibleSourceItems(nodes, codeByNodeId) {
  const byId = new Map(nodes.map((node) => [text(node?.node_id), node]));
  const visibleIds = new Set();
  for (const nodeId of codeByNodeId.keys()) {
    let currentId = nodeId;
    const seen = new Set();
    while (currentId && byId.has(currentId) && !seen.has(currentId)) {
      seen.add(currentId);
      visibleIds.add(currentId);
      currentId = text(byId.get(currentId)?.parent_node_id);
    }
  }
  return nodes
    .filter((node) => visibleIds.has(text(node?.node_id)))
    .map((node) => compactSourceItem(node, codeByNodeId.get(text(node?.node_id))));
}

export function sourceInventoriesFromPayload(payload = {}) {
  const period = hierarchyPeriod(payload);
  const intalevNodes = Array.isArray(period?.intalev_tree?.nodes) ? period.intalev_tree.nodes : [];
  const erpNodes = Array.isArray(period?.erp_tree?.nodes) ? period.erp_tree.nodes : [];
  const blocks = sourceExpenseBlockCatalog(payload);
  const intalevCodeByNodeId = new Map(blocks.map((block) => [block.intalev_node_id, block.code]));
  const erpCodeByNodeId = new Map(blocks
    .filter((block) => block.erp_node_id)
    .map((block) => [block.erp_node_id, block.code]));

  return {
    intalev_items: visibleSourceItems(intalevNodes, intalevCodeByNodeId),
    erp_items: visibleSourceItems(erpNodes, erpCodeByNodeId),
  };
}

function sourceExpenseBlockCatalog(payload = {}) {
  const period = hierarchyPeriod(payload);
  const intalevNodes = Array.isArray(period?.intalev_tree?.nodes) ? period.intalev_tree.nodes : [];
  const erpNodes = Array.isArray(period?.erp_tree?.nodes) ? period.erp_tree.nodes : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const sourceDrivenRoots = (payload?.source_driven_expense_coverage?.rows ?? [])
    .filter((row) => !text(row?.parent_code))
    .filter((row) => /БЛОК РАСХОДОВ/iu.test(text(row?.type)));
  const erpByPath = new Map(erpNodes.map((node) => [sourcePathIdentity(node?.full_path), node]));
  const erpGroupsByLabel = new Map();
  for (const node of erpNodes.filter((item) => item?.is_group === true)) {
    const key = normalizedArticle(node?.label ?? node?.name);
    if (!erpGroupsByLabel.has(key)) erpGroupsByLabel.set(key, []);
    erpGroupsByLabel.get(key).push(node);
  }

  return intalevNodes
    .filter(isSourceExpenseBlockNode)
    .sort((left, right) => Number(left?.source?.row ?? 0) - Number(right?.source?.row ?? 0))
    .map((node) => {
      const intalevPathIdentity = sourcePathIdentity(node?.full_path);
      const sourceDriven = sourceDrivenRoots.find((row) =>
        (row?.intalev_paths ?? []).some((candidate) => sourcePathIdentity(candidate) === intalevPathIdentity));
      const coreCandidates = rows
        .filter((row) => text(row?.hierarchy_node_id) === text(node?.node_id))
        .sort((left, right) => {
          const score = (row) =>
            (text(row?.erp_label) ? 20 : 0)
            + (typeof (row?.erp_amount ?? row?.erp?.amount) === "number" ? 10 : 0)
            + (normalizedArticle(row?.intalev_label) === normalizedArticle(node?.label) ? 5 : 0);
          return score(right) - score(left)
            || upper(left?.code).localeCompare(upper(right?.code), "ru-RU", { numeric: true });
        });
      const core = coreCandidates[0] ?? null;
      const code = upper(sourceDriven?.code ?? core?.code);
      if (!code) return null;

      const exactErpPath = (sourceDriven?.erp_paths ?? [])
        .map((candidate) => erpByPath.get(sourcePathIdentity(candidate)))
        .find(Boolean);
      const labelKey = normalizedArticle(sourceDriven?.erp_label || core?.erp_label || node?.label);
      const labelCandidates = erpGroupsByLabel.get(labelKey) ?? [];
      const erpNode = exactErpPath ?? labelCandidates
        .sort((left, right) => Number(left?.source?.row ?? 0) - Number(right?.source?.row ?? 0))[0] ?? null;
      return {
        code,
        label: text(node?.label ?? node?.name),
        level: Number.isFinite(Number(node?.level)) ? Number(node.level) : 0,
        path: sourcePathParts(node?.full_path),
        intalev_cents: cents(sourceDriven?.intalev_amount ?? core?.intalev_amount ?? core?.intalev?.amount ?? node?.direct_total),
        erp_cents: cents(sourceDriven?.erp_amount ?? core?.erp_amount ?? core?.erp?.amount ?? erpNode?.direct_total),
        intalev_node_id: text(node?.node_id),
        erp_node_id: text(erpNode?.node_id),
      };
    })
    .filter(Boolean);
}

export function inventoryFromPayload(payload = {}) {
  return sourceExpenseBlockCatalog(payload)
    .map((item) => ({
      ...item,
      intalev_amount: item.intalev_cents / 100,
      erp_amount: item.erp_cents / 100,
    }))
    .sort((left, right) => left.code.localeCompare(right.code, "ru-RU", { numeric: true }));
}

function inventoryIndex(payload) {
  return new Map(inventoryFromPayload(payload).map((row) => [row.code, row]));
}

export function previewStructuralGroup(payload, intalevCodes, erpCodes) {
  const intalev = parseCodes(intalevCodes);
  const erp = parseCodes(erpCodes);
  if (intalev.length < 1) throw new Error("Выберите хотя бы один блок Инталев.");
  if (erp.length < 1) throw new Error("Выберите хотя бы один блок ERP.");
  if (new Set([...intalev, ...erp]).size < 2) {
    throw new Error("В группе должны участвовать минимум два разных блока.");
  }
  const index = inventoryIndex(payload);
  const missing = [...new Set([...intalev, ...erp])].filter((code) => !index.has(code));
  if (missing.length) throw new Error(`Коды отсутствуют в выбранной сверке: ${missing.join(", ")}`);
  const intalevTotalCents = intalev.reduce((sum, code) => sum + index.get(code).intalev_cents, 0);
  const erpTotalCents = erp.reduce((sum, code) => sum + index.get(code).erp_cents, 0);
  const deltaCents = intalevTotalCents - erpTotalCents;
  return {
    intalev_codes: intalev,
    erp_codes: erp,
    intalev_total: intalevTotalCents / 100,
    erp_total: erpTotalCents / 100,
    control_delta: deltaCents / 100,
    control_delta_cents: deltaCents,
    classification: deltaCents === 0
      ? "STRUCTURAL_GROUP_SUM_OK"
      : "STRUCTURAL_GROUP_SUM_MISMATCH",
    intergroup_reclass: deltaCents === 0 ? "EXCLUDED" : "OPEN",
  };
}

function csvCells(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("В CSV не закрыта кавычка.");
  cells.push(value);
  return cells;
}

function boolValue(value) {
  return ["да", "true", "1", "yes"].includes(text(value).toLocaleLowerCase("ru-RU"));
}

export async function readEditableSettings(settingsPath) {
  try {
    const content = (await fs.readFile(settingsPath, "utf8")).replace(/^\uFEFF/u, "");
    const lines = content.split(/\r?\n/u).filter((line) => line.trim() !== "");
    if (!lines.length) return [];
    const headers = csvCells(lines[0]).map(text);
    const split = JSON.stringify(headers) === JSON.stringify(SPLIT_HEADERS);
    const legacy = headers.length === 4 && headers[2] === "Коды верхних блоков";
    if (!split && !legacy) throw new Error("Формат файла групп не поддерживается.");
    return lines.slice(1).map((line, index) => {
      const cells = csvCells(line);
      if (cells.length !== headers.length) throw new Error(`Неверное число колонок в строке ${index + 2}.`);
      const intalev = parseCodes(cells[2]);
      return {
        organization: text(cells[0]),
        name: text(cells[1]),
        intalev_codes: intalev,
        erp_codes: split ? parseCodes(cells[3]) : [...intalev],
        enabled: boolValue(cells[split ? 4 : 3]),
      };
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function quoteCsv(value) {
  const normalized = text(value);
  return /[;"\r\n]/u.test(normalized)
    ? `"${normalized.replace(/"/gu, '""')}"`
    : normalized;
}

function validateActiveGroups(rows) {
  const names = new Set();
  const owners = new Map();
  for (const row of rows) {
    const nameKey = `${row.organization}\u0000${row.name}`;
    if (names.has(nameKey)) throw new Error(`Группа уже существует: ${row.name}`);
    names.add(nameKey);
    if (!row.intalev_codes.length || !row.erp_codes.length) throw new Error(`В группе «${row.name}» пустая сторона.`);
    if (new Set([...row.intalev_codes, ...row.erp_codes]).size < 2) throw new Error(`В группе «${row.name}» меньше двух разных блоков.`);
    if (!row.enabled) continue;
    for (const code of new Set([...row.intalev_codes, ...row.erp_codes])) {
      const key = `${row.organization}\u0000${code}`;
      if (owners.has(key)) throw new Error(`Блок ${code} уже включён в активную группу «${owners.get(key)}».`);
      owners.set(key, row.name);
    }
  }
}

async function writeSettings(settingsPath, rows) {
  validateActiveGroups(rows);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  try {
    await fs.access(settingsPath);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
    await fs.copyFile(settingsPath, `${settingsPath}.bak-${stamp}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = [SPLIT_HEADERS.map(quoteCsv).join(";")];
  for (const row of rows) {
    lines.push([
      row.organization,
      row.name,
      row.intalev_codes.join(","),
      row.erp_codes.join(","),
      row.enabled ? "Да" : "Нет",
    ].map(quoteCsv).join(";"));
  }
  const temporaryPath = `${settingsPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${lines.join("\r\n")}\r\n`, "utf8");
  await fs.copyFile(temporaryPath, settingsPath);
  await fs.unlink(temporaryPath);
  await readStructuralControlSettingsCsv(settingsPath);
}

export async function saveStructuralGroup({ settingsPath, payload, name, intalevCodes, erpCodes }) {
  const organization = text(payload?.organization);
  const period = text(payload?.period);
  const groupName = text(name);
  if (!organization) throw new Error("В сверке не указана организация.");
  if (!period) throw new Error("В сверке не указан период.");
  if (!groupName) throw new Error("Введите название группы.");
  const preview = previewStructuralGroup(payload, intalevCodes, erpCodes);
  if (preview.control_delta_cents !== 0) {
    throw new Error(`Активировать группу нельзя: контрольная дельта ${preview.control_delta.toFixed(2)}, требуется 0.00.`);
  }
  const rows = await readEditableSettings(settingsPath);
  const sameGroup = rows.find((row) => row.organization === organization && row.name === groupName);
  if (sameGroup) {
    sameGroup.intalev_codes = preview.intalev_codes;
    sameGroup.erp_codes = preview.erp_codes;
    sameGroup.enabled = true;
  } else {
    rows.push({
      organization,
      name: groupName,
      intalev_codes: preview.intalev_codes,
      erp_codes: preview.erp_codes,
      enabled: true,
    });
  }
  await writeSettings(settingsPath, rows);
  return { organization, period, name: groupName, enabled: true, settings_path: path.resolve(settingsPath), ...preview };
}

export async function disableStructuralGroup({ settingsPath, organization, name }) {
  const rows = await readEditableSettings(settingsPath);
  const target = rows.find((row) => row.organization === text(organization) && row.name === text(name));
  if (!target) throw new Error(`Группа «${text(name)}» не найдена.`);
  target.enabled = false;
  await writeSettings(settingsPath, rows);
  return { organization: target.organization, name: target.name, enabled: false, settings_path: path.resolve(settingsPath) };
}

async function loadPayload(sidecarPath) {
  const payload = JSON.parse((await fs.readFile(path.resolve(sidecarPath), "utf8")).replace(/^\uFEFF/u, ""));
  if (!Array.isArray(payload?.rows)) throw new Error("Выбранный файл не является доказательным .codex-input.json сверки R005.");
  return payload;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function selfTest() {
  const payload = {
    organization: "9 Управляющая компания",
    period: "2025-10",
    rows: [
      { code: "R023", hierarchy_node_id: "INTALEV:R023", hierarchy_has_children: true, hierarchy_level: 3, hierarchy_path: ["Расходы", "Расходы на персонал"], intalev_label: "Расходы на персонал", erp_label: "Расходы на персонал", intalev_amount: 420145, erp_amount: 175400, erp_sources: [{ sha256: "ERP-SHA", sheet: "API", row: 23, amount: 175400, full_path: "Расходы / Расходы на персонал" }] },
      { code: "R033", hierarchy_node_id: "INTALEV:R033", hierarchy_has_children: true, hierarchy_level: 1, hierarchy_path: ["Расходы", "Коммерческие расходы"], intalev_label: "Коммерческие расходы", erp_label: "Коммерческие расходы", intalev_amount: 10774370.78, erp_amount: 11019115.78, erp_sources: [{ sha256: "ERP-SHA", sheet: "API", row: 33, amount: 11019115.78, full_path: "Расходы / Коммерческие расходы" }] },
      { code: "R045", hierarchy_node_id: "INTALEV:R045", hierarchy_has_children: true, hierarchy_level: 1, hierarchy_path: ["Операционная прибыль", "Результат по финансовой деятельности"], intalev_label: "Результат по финансовой деятельности", erp_label: "Итоги по финансовой деятельности", intalev_amount: -16687038.98, erp_amount: -14088621.34, erp_sources: [{ sha256: "ERP-SHA", sheet: "API", row: 45, amount: -14088621.34, full_path: "Итоги по финансовой деятельности" }] },
      { code: "R055", hierarchy_node_id: "INTALEV:R055", hierarchy_has_children: true, hierarchy_level: 2, hierarchy_path: ["Операционная прибыль", "Результат по инвестиционной и внереализационной деятельности"], intalev_label: "Результат по инвестиционной и внереализационной деятельности", erp_label: "Итоги по внереализационной деятельности", intalev_amount: 3433967.17, erp_amount: 835549.53, erp_sources: [{ sha256: "ERP-SHA", sheet: "API", row: 55, amount: 835549.53, full_path: "Итоги по финансовой деятельности / Итоги по внереализационной деятельности" }] },
      { code: "R058", hierarchy_node_id: "INTALEV:R058", hierarchy_has_children: true, hierarchy_level: 5, hierarchy_path: ["Операционная прибыль", "Результат по инвестиционной и внереализационной деятельности", "Прочие внереализационные расходы"], intalev_label: "Прочие внереализационные расходы", erp_label: "Прочие внереализационные расходы", intalev_amount: 24496.47, erp_amount: 24496.47, erp_sources: [{ sha256: "ERP-SHA", sheet: "API", row: 58, amount: 24496.47, full_path: "Итоги по финансовой деятельности / Итоги по внереализационной деятельности / Прочие внереализационные расходы" }] },
    ],
    hierarchy_periods: [{
      period: "2025-10",
      intalev_tree: { nodes: [
        { node_id: "INTALEV:ROOT", label: "Расходы", full_path: "Расходы", level: 0, is_group: true, direct_total: 11194515.78 },
        { node_id: "INTALEV:R023", parent_node_id: "INTALEV:ROOT", label: "Расходы на персонал", full_path: "Расходы / Расходы на персонал", level: 1, is_group: true, direct_total: 420145, source: { file: "intalev.zip", sheet: "TDSheet", row: 23, source_cell: "E23" } },
        { node_id: "INTALEV:R033", parent_node_id: "INTALEV:ROOT", label: "Коммерческие расходы", full_path: "Расходы / Коммерческие расходы", level: 1, is_group: true, direct_total: 10774370.78, source: { file: "intalev.zip", sheet: "TDSheet", row: 33, source_cell: "E33" } },
        { node_id: "INTALEV:R045", parent_node_id: "INTALEV:ROOT", label: "Результат по финансовой деятельности", full_path: "Операционная прибыль / Результат по финансовой деятельности", level: 1, is_group: true, direct_total: -16687038.98, source: { file: "intalev.zip", sheet: "TDSheet", row: 45, source_cell: "E45" } },
        { node_id: "INTALEV:R055", parent_node_id: "INTALEV:R045", label: "Результат по инвестиционной и внереализационной деятельности", full_path: "Операционная прибыль / Результат по инвестиционной и внереализационной деятельности", level: 2, is_group: true, direct_total: 3433967.17, source: { file: "intalev.zip", sheet: "TDSheet", row: 55, source_cell: "E55" } },
        { node_id: "INTALEV:R058", parent_node_id: "INTALEV:R055", label: "Прочие внереализационные расходы", full_path: "Операционная прибыль / Результат по инвестиционной и внереализационной деятельности / Прочие внереализационные расходы", level: 5, is_group: true, direct_total: 24496.47, source: { file: "intalev.zip", sheet: "TDSheet", row: 58, source_cell: "E58" } },
      ] },
      erp_tree: { nodes: [
        { node_id: "ERP:ROOT", label: "Расходы", full_path: "Расходы", level: 0, is_group: true, direct_total: 11194515.78 },
        { node_id: "ERP:R023", parent_node_id: "ERP:ROOT", label: "Расходы на персонал", full_path: "Расходы / Расходы на персонал", level: 1, is_group: true, direct_total: 175400, source_identity: "ERP-SHA|API|23", source: { file: "erp-api.xlsx", sheet: "API", row: 23, source_cell: "M23" } },
        { node_id: "ERP:R033", parent_node_id: "ERP:ROOT", label: "Коммерческие расходы", full_path: "Расходы / Коммерческие расходы", level: 1, is_group: true, direct_total: 11019115.78, source_identity: "ERP-SHA|API|33", source: { file: "erp-api.xlsx", sheet: "API", row: 33, source_cell: "M33" } },
        { node_id: "ERP:R045", parent_node_id: "ERP:ROOT", label: "Итоги по финансовой деятельности", full_path: "Итоги по финансовой деятельности", level: 1, is_group: true, direct_total: -14088621.34, source_identity: "ERP-SHA|API|45", source: { file: "erp-api.xlsx", sheet: "API", row: 45, source_cell: "M45" } },
        { node_id: "ERP:R055", parent_node_id: "ERP:R045", label: "Итоги по внереализационной деятельности", full_path: "Итоги по финансовой деятельности / Итоги по внереализационной деятельности", level: 2, is_group: true, direct_total: 835549.53, source_identity: "ERP-SHA|API|55", source: { file: "erp-api.xlsx", sheet: "API", row: 55, source_cell: "M55" } },
        { node_id: "ERP:R058", parent_node_id: "ERP:R055", label: "Прочие внереализационные расходы", full_path: "Итоги по финансовой деятельности / Итоги по внереализационной деятельности / Прочие внереализационные расходы", level: 5, is_group: true, direct_total: 24496.47, source_identity: "ERP-SHA|API|58", source: { file: "erp-api.xlsx", sheet: "API", row: 58, source_cell: "M58" } },
      ] },
    }],
  };
  const preview = previewStructuralGroup(payload, "R023,R033", "R023,R033");
  if (preview.control_delta_cents !== 0 || preview.intergroup_reclass !== "EXCLUDED") throw new Error("ZERO_GROUP_SELF_TEST_FAILED");
  const mismatch = previewStructuralGroup(payload, "R023", "R033");
  if (mismatch.control_delta_cents === 0 || mismatch.intergroup_reclass !== "OPEN") throw new Error("NONZERO_GROUP_SELF_TEST_FAILED");
  const sources = sourceInventoriesFromPayload(payload);
  for (const requiredCode of ["R023", "R033"]) {
    if (!sources.intalev_items.some((item) => item.selectable && item.code === requiredCode)) throw new Error(`INTALEV_SOURCE_TREE_SELF_TEST_FAILED:${requiredCode}`);
    if (!sources.erp_items.some((item) => item.selectable && item.code === requiredCode)) throw new Error(`ERP_SOURCE_TREE_SELF_TEST_FAILED:${requiredCode}`);
  }
  return { self_test: "PASS", zero: preview, nonzero: mismatch, source_trees: sources };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["self-test"]) return printJson(await selfTest());
  const command = text(args._[0]);
  const settingsPath = args.settings ? path.resolve(args.settings) : "";
  if (command === "inventory") {
    const payload = await loadPayload(args.sidecar);
    return printJson({ organization: text(payload.organization), period: text(payload.period), items: inventoryFromPayload(payload), ...sourceInventoriesFromPayload(payload) });
  }
  if (command === "groups") {
    return printJson({ rows: await readEditableSettings(settingsPath) });
  }
  if (command === "preview") {
    const payload = await loadPayload(args.sidecar);
    return printJson(previewStructuralGroup(payload, args.intalev, args.erp));
  }
  if (command === "save") {
    const payload = await loadPayload(args.sidecar);
    return printJson(await saveStructuralGroup({ settingsPath, payload, name: args.name, intalevCodes: args.intalev, erpCodes: args.erp }));
  }
  if (command === "disable") {
    return printJson(await disableStructuralGroup({ settingsPath, organization: args.organization, name: args.name }));
  }
  throw new Error("Укажите команду inventory, groups, preview, save или disable.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
