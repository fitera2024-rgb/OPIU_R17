import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";

const args = parseArgs(process.argv.slice(2));

try {
  if (!args.input) fail("Укажите --input с файлом *.codex-input.json.");
  if (!args.output) fail("Укажите --output с папкой пакета Codex.");
  const result = await buildPackage({
    inputPath: path.resolve(args.input),
    decisionsPath: args.decisions ? path.resolve(args.decisions) : "",
    rulesPath: args.rules ? path.resolve(args.rules) : "",
    outputDir: path.resolve(args.output),
  });
  console.log(`Пакет Codex создан: ${result.outputDir}`);
  console.log(`Промпт: ${result.promptPath}`);
  console.log(`Данные: ${result.reviewPath}`);
  console.log(`Модель: ${result.modelPath}`);
  console.log(`В обработке: ${result.includedCount}`);
  console.log(`Принято пользователем: ${result.acceptedCount}`);
  console.log("ready_to_upload: FALSE");
  console.log("release_allowed: FALSE");
} catch (error) {
  console.error(`ОШИБКА: ${error?.message ?? error}`);
  process.exitCode = 1;
}

function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function fail(message) {
  throw new Error(message);
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase("ru-RU");
}

function ruleMatchKey(input, row) {
  const organization = text(input.organization_code || input.organization);
  const hierarchyPath = Array.isArray(row.hierarchy_path)
    ? row.hierarchy_path.join(" / ")
    : text(row.hierarchy_path);
  return `${organization}|${text(row.code)}|${normalized(row.intalev_label)}|${normalized(hierarchyPath)}`;
}

function findConfiguredRule(input, row, rules) {
  const exactKey = ruleMatchKey(input, row);
  const exact = rules.find((rule) => text(rule.match_key) === exactKey && rule.active !== false);
  if (exact) return exact;
  const organizationCode = text(input.organization_code);
  return rules.find(
    (rule) =>
      rule.active !== false &&
      text(rule.organization_code) === organizationCode &&
      text(rule.source_code) === text(row.code),
  ) ?? null;
}

function safeFileName(value) {
  return text(value).replace(/[<>:"/\\|?*]/g, "_").replace(/\.+$/g, "");
}

function numberText(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function normalizeTechnicalStatus(value) {
  const status = text(value);
  if (status === "BLOCKED_MAPPING_OR_VALUE") return "REQUIRES_CLARIFICATION";
  return status || "READY_FOR_ANALYSIS";
}

function requiresClarification(value) {
  return normalizeTechnicalStatus(value) === "REQUIRES_CLARIFICATION";
}

function technicalStatusLabel(value) {
  return requiresClarification(value) ? "ТРЕБУЕТ УТОЧНЕНИЯ" : "ГОТОВО К АНАЛИЗУ";
}

async function readJson(filePath, required = true) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw new Error(`Не удалось прочитать JSON ${filePath}: ${error.message}`);
  }
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function buildPackage({ inputPath, decisionsPath, rulesPath, outputDir }) {
  const input = await readJson(inputPath);
  if (input.schema !== "opiu-codex-review-input-v1") {
    fail(`Неподдерживаемая схема входных данных: ${input.schema ?? "не указана"}.`);
  }
  const decisionsDoc = decisionsPath ? await readJson(decisionsPath, false) : null;
  const rulesDoc = rulesPath ? await readJson(rulesPath, false) : null;
  const configuredRules = (rulesDoc?.rules ?? []).filter((rule) => rule.active !== false);
  const decisionMap = new Map(
    (decisionsDoc?.decisions ?? []).map((item) => [text(item.decision_key), item]),
  );

  const sourceRows = (input.rows ?? []).filter(
    (row) => row.is_discrepancy !== false && row.reconciliation_status !== "RECONCILED",
  );
  const reviewedRows = sourceRows.map((row) => {
    const saved = decisionMap.get(text(row.decision_key));
    const includeInTask = saved?.include_in_task !== false;
    const configuredRule = findConfiguredRule(input, row, configuredRules);
    return {
      ...row,
      is_discrepancy: true,
      technical_status: normalizeTechnicalStatus(row.technical_status),
      include_in_task: includeInTask,
      decision: includeInTask ? "PROCESS" : "ACCEPTED",
      user_comment: text(saved?.user_comment),
      codex_comment: text(saved?.codex_comment),
      decision_updated_at: text(saved?.updated_at),
      configured_rule: configuredRule
        ? {
            rule_id: text(configuredRule.rule_id),
            intalev_article_code: text(configuredRule.intalev_article_code),
            intalev_article_name: text(configuredRule.intalev_article_name),
            intalev_hierarchy_path: text(configuredRule.intalev_hierarchy_path),
            erp_article_code: text(configuredRule.erp_article_code),
            erp_article_name: text(configuredRule.erp_article_name),
            erp_group_disclosure: text(configuredRule.erp_group_disclosure),
            erp_hierarchy_path: text(configuredRule.erp_hierarchy_path),
            correction_method: text(configuredRule.correction_method),
            debit_account: text(configuredRule.debit_account),
            credit_account: text(configuredRule.credit_account),
            analytic_1: text(configuredRule.analytic_1),
            analytic_2: text(configuredRule.analytic_2),
            comment: text(configuredRule.comment),
          }
        : null,
    };
  });
  const included = reviewedRows.filter((row) => row.include_in_task);
  const accepted = reviewedRows.filter((row) => !row.include_in_task);

  await fs.mkdir(outputDir, { recursive: true });
  const promptPath = path.join(outputDir, "ПРОМПТ_ДЛЯ_CODEX.md");
  const reviewPath = path.join(outputDir, "Расхождения_для_CODEX.json");
  const modelPath = path.join(outputDir, "Модель_корректировок.xlsx");
  const decisionsSlicePath = path.join(outputDir, "Память_решений_срез.json");
  const rulesSlicePath = path.join(outputDir, "Пользовательские_правила_срез.json");

  const packageDoc = {
    schema: "opiu-codex-adjustment-package-v1",
    generated_at: new Date().toISOString(),
    source_input_path: inputPath,
    report_path: input.report_path,
    report_sha256: input.report_sha256,
    organization: input.organization,
    organization_code: input.organization_code,
    profile_id: input.profile_id,
    project_rules: input.project_rules,
    mode: input.mode,
    period: input.period,
    periods: input.periods,
    report_only: true,
    ready_to_upload: false,
    release_allowed: false,
    hierarchy_rows_count: (input.rows ?? []).length,
    discrepancy_rows_count: reviewedRows.length,
    included_count: included.length,
    accepted_count: accepted.length,
    configured_rules_count: reviewedRows.filter((row) => row.configured_rule).length,
    rows: reviewedRows,
  };

  await fs.writeFile(promptPath, `\uFEFF${buildPrompt(input, included, accepted)}`, "utf8");
  await fs.writeFile(reviewPath, JSON.stringify(packageDoc, null, 2), "utf8");
  await fs.writeFile(
    decisionsSlicePath,
    JSON.stringify(
      {
        schema: "opiu-reconciliation-decisions-slice-v1",
        organization: input.organization,
        period: input.period,
        decisions: reviewedRows.map((row) => ({
          decision_key: row.decision_key,
          code: row.code,
          include_in_task: row.include_in_task,
          decision: row.decision,
          user_comment: row.user_comment,
          codex_comment: row.codex_comment,
          updated_at: row.decision_updated_at,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    rulesSlicePath,
    JSON.stringify(
      {
        schema: "opiu-reconciliation-rules-slice-v1",
        organization: input.organization,
        organization_code: input.organization_code,
        source_rules_path: rulesPath,
        rules: reviewedRows
          .filter((row) => row.configured_rule)
          .map((row) => ({ decision_key: row.decision_key, code: row.code, ...row.configured_rule })),
      },
      null,
      2,
    ),
    "utf8",
  );
  await createCorrectionModel(modelPath, input, included, accepted);

  return {
    outputDir,
    promptPath,
    reviewPath,
    modelPath,
    includedCount: included.length,
    acceptedCount: accepted.length,
  };
}

function buildPrompt(input, included, accepted) {
  const lines = [
    "# Задание для Codex: анализ расхождений ОПИУ и корректировочная модель",
    "",
    `Организация: **${input.organization}**`,
    `Период: **${input.period}**`,
    `Профиль: **${input.profile_id}**`,
    `Правила: **${input.project_rules}**`,
    `Исходный отчёт сверки: \`${input.report_path}\``,
    `Строк в обработке: **${included.length}**. Принято пользователем: **${accepted.length}**.`,
    "",
    "## Обязательные ограничения",
    "",
    "1. Работай только со строками из файла `Расхождения_для_CODEX.json`, у которых `include_in_task=true`.",
    "2. Строки с `decision=ACCEPTED` не корректируй и не включай в техническое задание на исправление.",
    "3. Строки с `technical_status=REQUIRES_CLARIFICATION` остаются в обработке. Сначала уточни сопоставление или значение и явно укажи, каких данных не хватает.",
    "4. Если у строки заполнено `configured_rule`, используй его как пользовательскую настройку статьи, группы раскрытия и Дт/Кт. Проверь правило по журналу проводок; не заменяй его молча.",
    "5. Инталев является целевым ОПИУ. Не используй текущие суммы ERP как целевые и не сторнируй сценарий «Факт».",
    "6. Не подгоняй родительские итоги. Проверяй дочерние строки, полные пути, счета, организацию и аналитику. Подразделение/ЦФО не является измерением этой сверки: суммы уже схлопнуты по статье ОПИУ.",
    "7. Не используй цвет ячеек как доказательство.",
    "8. Корректировочная модель остаётся диагностической: `ready_to_upload=false`, `release_allowed=false`.",
    "9. Не загружай данные в 1С и не выполняй проводки автоматически.",
    "",
    "## Что нужно сделать",
    "",
    "Для каждой обрабатываемой строки:",
    "- объясни вероятную причину расхождения;",
    "- проверь доступный журнал проводок и расшифровки;",
    "- укажи доказательства: файл, лист, строку, счёт и аналитику; подразделение используй только как справочную трассировку;",
    "- предложи корректировочную модель: дебет, кредит, сумма, статья, аналитики и период; не дроби сумму по подразделениям без отдельного указания пользователя;",
    "- при недостатке данных установи статус модели `ТРЕБУЕТ ПРОВЕРКИ` и перечисли, какой файл или расшифровка нужны;",
    "- заполни файл `Модель_корректировок.xlsx`, не меняя исходный отчёт сверки.",
    "",
    "## Расхождения в обработке",
    "",
    "| Код | Статья Инталев | Статья ERP | Инталев | ERP | Дельта | Правило | Тех. статус | Комментарий пользователя | Указание Codex |",
    "|---|---|---|---:|---:|---:|---|---|---|---|",
  ];
  for (const row of included) {
    lines.push(
      `| ${escapeMd(row.code)} | ${escapeMd(row.intalev_label)} | ${escapeMd(row.erp_label)} | ${numberText(row.intalev_amount)} | ${numberText(row.erp_amount)} | ${numberText(row.delta)} | ${escapeMd(row.configured_rule ? `${row.configured_rule.intalev_article_name || row.intalev_label} → ${row.configured_rule.erp_article_name}; Дт ${row.configured_rule.debit_account}; Кт ${row.configured_rule.credit_account}` : "не настроено")} | ${escapeMd(row.technical_status)} | ${escapeMd(row.user_comment)} | ${escapeMd(row.codex_comment)} |`,
    );
  }
  if (included.length === 0) lines.push("| — | Нет строк для обработки | — | — | — | — | — | — | — | — |");
  lines.push("", "## Принятые расхождения — не корректировать", "");
  if (accepted.length === 0) {
    lines.push("Нет.");
  } else {
    for (const row of accepted) {
      lines.push(
        `- ${row.code} — ${row.intalev_label}; дельта ${numberText(row.delta)}; комментарий: ${row.user_comment || "не указан"}.`,
      );
    }
  }
  lines.push(
    "",
    "## Формат итогового ответа",
    "",
    "1. Краткий итог по количеству обработанных и принятых строк; отдельно перечисли строки, требующие уточнения.",
    "2. Таблица причин расхождений.",
    "3. Таблица предложенной корректировочной модели.",
    "4. Перечень недостающих журналов или расшифровок.",
    "5. Явное подтверждение, что исходные файлы не изменены и загрузка в 1С не выполнялась.",
    "",
  );
  return lines.join("\r\n");
}

function escapeMd(value) {
  return text(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function createCorrectionModel(outputPath, input, included, accepted) {
  const workbook = {
    sheets: [
      buildPassportSheet(input, included, accepted),
      buildDiscrepanciesSheet(included),
      buildModelSheet(included),
      buildAcceptedSheet(accepted),
      buildRulesSheet(input, included),
    ],
  };
  const zip = createWorkbookZip(workbook);
  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(outputPath, content);
  await fs.writeFile(
    `${outputPath}.sha256`,
    `${await sha256File(outputPath)}  ${path.basename(outputPath)}\r\n`,
    "utf8",
  );
}

function s(v, style = 0) {
  return { v: v ?? "", t: "s", style };
}
function n(v, style = 7) {
  return typeof v === "number" && Number.isFinite(v)
    ? { v, t: "n", style }
    : { v: "", t: "s", style };
}
function blank(style = 0) {
  return { v: "", t: "blank", style };
}

function buildPassportSheet(input, included, accepted) {
  return {
    name: "00_Паспорт",
    widths: [30, 70, 24, 70],
    freezeRows: 5,
    merges: ["A1:D1", "A2:D2"],
    rows: [
      [s(`Корректировочная модель ОПИУ — ${input.organization} — ${input.period}`, 1), blank(1), blank(1), blank(1)],
      [s("Диагностический шаблон. Проводки не подтверждены, загрузка в 1С запрещена.", 5), blank(5), blank(5), blank(5)],
      [],
      [s("Параметр", 2), s("Значение", 2), s("Статус", 2), s("Комментарий", 2)],
      [s("Организация", 6), s(input.organization, 3), s("INPUT", 6), s("Из отчёта сверки.", 6)],
      [s("Код организации", 6), s(input.organization_code, 3), s("INPUT", 6), s("Из профиля.", 6)],
      [s("Период", 6), s(input.period, 3), s("INPUT", 6), s((input.periods ?? []).join(", "), 6)],
      [s("Профиль", 6), s(input.profile_id, 3), s("INPUT", 6), s(input.project_rules, 6)],
      [s("Исходный отчёт", 6), s(input.report_path, 3), s("SOURCE", 6), s(input.report_sha256, 6)],
      [s("Строк в обработке", 6), n(included.length, 6), s("REVIEW", 6), s("По умолчанию обрабатываются все расхождения.", 6)],
      [s("Принято пользователем", 6), n(accepted.length, 6), s("ACCEPTED", 6), s("В корректировки не включать.", 6)],
      [s("ready_to_upload", 6), s("FALSE", 5), s("ПРОВЕРКА", 5), s("Требуется подтверждение пользователем.", 5)],
      [s("release_allowed", 6), s("FALSE", 5), s("ПРОВЕРКА", 5), s("Нужна проверка журналов и аналитик.", 5)],
    ],
  };
}

function buildDiscrepanciesSheet(rows) {
  const data = [
    [
      s("Ключ", 2), s("Код", 2), s("Группа", 2), s("Статья Инталев", 2), s("Статья ERP", 2),
      s("Инталев", 2), s("ERP", 2), s("Дельта", 2), s("Тех. статус", 2), s("Статус решения", 2),
      s("Комментарий пользователя", 2), s("Указание Codex", 2), s("Пути Инталев", 2), s("Пути ERP", 2),
      s("Подразделения (справочно, схлопнуты)", 2), s("Счета", 2),
    ],
  ];
  for (const row of rows) {
    const warningStyle = requiresClarification(row.technical_status) ? 5 : 3;
    data.push([
      s(row.decision_key, 6), s(row.code, 6), s(row.group, 6), s(row.intalev_label, 3), s(row.erp_label, 3),
      n(row.intalev_amount, 7), n(row.erp_amount, 7), n(row.delta, 8), s(technicalStatusLabel(row.technical_status), warningStyle), s(row.decision, warningStyle),
      s(row.user_comment, 9), s(row.codex_comment, 9), s((row.intalev_paths ?? []).join(" | "), 9), s((row.erp_paths ?? []).join(" | "), 9),
      s((row.cfo ?? []).join(" | "), 9), s((row.accounts ?? []).join(" | "), 9),
    ]);
  }
  if (rows.length === 0) data.push([s("Нет строк в обработке.", 6)]);
  return {
    name: "01_Расхождения",
    widths: [18, 10, 20, 38, 38, 16, 16, 16, 24, 18, 36, 36, 55, 55, 28, 22],
    freezeRows: 1,
    autoFilter: `A1:P${Math.max(1, data.length)}`,
    rows: data,
  };
}

function buildModelSheet(rows) {
  const headers = [
    "Ключ расхождения", "Код строки", "Организация", "Период", "Статья Инталев", "Статья ERP в сверке", "Дельта",
    "Предлагаемая сумма", "Дебет", "Кредит", "Статья корректировки", "Код статьи ERP", "Группа раскрытия", "Иерархическая папка ERP",
    "Подразделение (необязательно)", "Аналитика 1", "Аналитика 2", "Основание", "Файл-доказательство", "Лист/строка", "Статус модели", "Комментарий проверки",
  ];
  const data = [headers.map((item) => s(item, 2))];
  for (const row of rows) {
    const rule = row.configured_rule ?? {};
    data.push([
      s(row.decision_key, 6), s(row.code, 6), s(row.organization, 6), s(row.period, 6), s(row.intalev_label, 3), s(row.erp_label, 3), n(row.delta, 8),
      blank(4), s(rule.debit_account, 4), s(rule.credit_account, 4), s(rule.erp_article_name, 4), s(rule.erp_article_code, 4),
      s(rule.erp_group_disclosure, 4), s(rule.erp_hierarchy_path, 4), blank(4), s(rule.analytic_1, 4), s(rule.analytic_2, 4),
      s(rule.comment, 4), blank(4), blank(4), s("ТРЕБУЕТ ПРОВЕРКИ", 5), s(row.codex_comment, 9),
    ]);
  }
  if (rows.length === 0) data.push([s("Нет строк для формирования модели.", 6)]);
  return {
    name: "02_Модель_корректировок",
    widths: [18, 11, 26, 14, 36, 36, 16, 18, 18, 18, 34, 18, 28, 55, 24, 28, 28, 45, 45, 24, 26, 42],
    freezeRows: 1,
    autoFilter: `A1:V${Math.max(1, data.length)}`,
    rows: data,
  };
}

function buildAcceptedSheet(rows) {
  const data = [[
    s("Ключ", 2), s("Код", 2), s("Статья", 2), s("Дельта", 2), s("Комментарий пользователя", 2), s("Комментарий Codex", 2),
  ]];
  for (const row of rows) {
    data.push([
      s(row.decision_key, 6), s(row.code, 6), s(row.intalev_label, 3), n(row.delta, 7), s(row.user_comment, 9), s(row.codex_comment, 9),
    ]);
  }
  if (rows.length === 0) data.push([s("Принятых расхождений нет.", 6)]);
  return {
    name: "03_Принятые",
    widths: [18, 10, 42, 16, 55, 55],
    freezeRows: 1,
    autoFilter: `A1:F${Math.max(1, data.length)}`,
    rows: data,
  };
}

function buildRulesSheet(input, rows) {
  const data = [
    [s("Правило", 2), s("Требование / значение", 2), s("Статья ОПИУ", 2), s("Статья ERP", 2), s("Группа раскрытия", 2), s("Папка ERP", 2), s("Дт", 2), s("Кт", 2)],
    [s("Целевая сумма", 6), s("Всегда Инталев; ERP не используется как целевое значение.", 6)],
    [s("Сценарий", 6), s("Не сторнировать существующий сценарий «Факт». Корректировки рассматриваются для отдельного сценария.", 6)],
    [s("Иерархия", 6), s("Проверять дочерние строки независимо от нулевого расхождения родителя.", 6)],
    [s("Доказательства", 6), s("Код статьи, полный путь, счёт, организация, аналитика и журнал проводок. Подразделение — только справочно.", 6)],
    [s("Автоматические проводки", 6), s("Запрещены. Не загружать данные в 1С.", 5)],
    [s("Статус", 6), s("ready_to_upload=false; release_allowed=false.", 5)],
    [s("Активные правила проекта", 6), s(input.project_rules, 6)],
    [],
  ];
  const configured = rows.filter((row) => row.configured_rule);
  data.push([s("Пользовательские настройки", 2), s(`Настроено строк: ${configured.length}`, 2), s("Статья ОПИУ", 2), s("Статья ERP", 2), s("Группа раскрытия", 2), s("Папка ERP", 2), s("Дт", 2), s("Кт", 2)]);
  for (const row of configured) {
    const rule = row.configured_rule;
    data.push([
      s(rule.correction_method, 6), s(rule.comment, 6), s(rule.intalev_article_name || row.intalev_label, 3), s(`${rule.erp_article_name} [${rule.erp_article_code}]`, 3),
      s(rule.erp_group_disclosure, 6), s(rule.erp_hierarchy_path, 6), s(rule.debit_account, 4), s(rule.credit_account, 4),
    ]);
  }
  if (configured.length === 0) data.push([s("Пользовательские правила для текущих строк не настроены.", 6)]);
  return {
    name: "04_Правила",
    widths: [30, 52, 38, 42, 28, 58, 16, 16],
    freezeRows: 1,
    rows: data,
  };
}

function createWorkbookZip(workbook) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(workbook.sheets.length));
  zip.folder("_rels").file(".rels", rootRelsXml());
  zip.folder("docProps").file("app.xml", appXml(workbook.sheets));
  zip.folder("docProps").file("core.xml", coreXml());
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbookXml(workbook.sheets));
  xl.folder("_rels").file("workbook.xml.rels", workbookRelsXml(workbook.sheets.length));
  xl.file("styles.xml", stylesXml());
  const worksheetFolder = xl.folder("worksheets");
  workbook.sheets.forEach((sheet, index) => {
    worksheetFolder.file(`sheet${index + 1}.xml`, worksheetXml(sheet));
  });
  return zip;
}

function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(number) {
  let n = number;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function cellXml(cell, rowNumber, columnNumber) {
  const ref = `${columnName(columnNumber)}${rowNumber}`;
  const style = Number.isInteger(cell?.style) ? ` s="${cell.style}"` : "";
  if (!cell || cell.t === "blank") return `<c r="${ref}"${style}/>`;
  if (cell.t === "n") return `<c r="${ref}"${style}><v>${cell.v}</v></c>`;
  const value = String(cell.v ?? "");
  const preserve = /^\s|\s$|\n|\r/.test(value) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${style}><is><t${preserve}>${xml(value)}</t></is></c>`;
}

function worksheetXml(sheet) {
  const maxCols = Math.max(1, ...sheet.rows.map((row) => row.length));
  const maxRows = Math.max(1, sheet.rows.length);
  const cols = (sheet.widths ?? []).map(
    (width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join("");
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => cellXml(cell, rowIndex + 1, columnIndex + 1)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const merges = (sheet.merges ?? []).length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  const freeze = sheet.freezeRows
    ? `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/>`
    : '<selection activeCell="A1" sqref="A1"/>';
  const filter = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${columnName(maxCols)}${maxRows}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ""}
<sheetData>${rows}</sheetData>
${filter}${merges}
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function contentTypesXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
<sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`;
}

function workbookRelsXml(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red](#,##0.00);-"/></numFmts>
<fonts count="5">
<font><sz val="10"/><name val="Segoe UI"/><family val="2"/></font>
<font><b/><color rgb="FFFFFFFF"/><sz val="14"/><name val="Segoe UI"/></font>
<font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Segoe UI"/></font>
<font><color rgb="FF008000"/><sz val="10"/><name val="Segoe UI"/></font>
<font><color rgb="FF0000FF"/><sz val="10"/><name val="Segoe UI"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF4CCCC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9E2F3"/></left><right style="thin"><color rgb="FFD9E2F3"/></right><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="3" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function coreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Автоматическая сверка ОПИУ</dc:creator><cp:lastModifiedBy>Автоматическая сверка ОПИУ</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Автоматическая сверка ОПИУ</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Листы</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>
<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((sheet) => `<vt:lpstr>${xml(sheet.name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>
<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion>
</Properties>`;
}
