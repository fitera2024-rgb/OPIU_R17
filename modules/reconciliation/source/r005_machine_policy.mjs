import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ACTIVE_R005_POLICY_ID = "UK_PROJECT_RULES_R005_20260730";
export const R005_MACHINE_POLICY_SCHEMA = "uk-opiu-r005-machine-policy-v1";

const REQUIRED_SHEETS = Object.freeze({
  passport: "00_Паспорт",
  gates: "04_Гейт_R005",
  correctionRules: "05_Правила_корректировок",
  versionHistory: "07_История_версий",
});

const REQUIRED_GATE_FIELDS = Object.freeze([
  "schema + policy_id",
  "intalev_visible_nodes_coverage_percent",
  "erp_turnover_articles_coverage_percent",
  "traceability_intalev_percent / traceability_erp_percent",
  "top_down_pass / bottom_up_pass",
  "all_parents_child_sum_checked",
  "zero_delta_branches_scanned",
  "decision_classes_separated",
  "exact_article_identity_complete / source_trace_complete",
  "osv_control_passed / duplicate_control_passed",
  "storno_source_sign_inversion_passed",
  "idempotency_control_passed / live_1c_preflight_passed",
  "unresolved/open counts and amount",
  "all_visible_groupings_expanded_to_leaves",
  "current_month_inputs_override_prior_month_decisions",
]);

const REQUIRED_CORRECTION_RULES = Object.freeze([
  "formula_mapping",
  "publication",
  "all_groupings_expand_to_leaves",
  "current_month_inputs_override_history",
  "zero_sum_group_storno_repost",
]);

export class R005MachinePolicyError extends Error {
  constructor(code, message, options = undefined) {
    super(`${code}: ${message}`, options);
    this.name = "R005MachinePolicyError";
    this.code = code;
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLocaleLowerCase("ru-RU");
}

function failPolicy(code, message, options = undefined) {
  throw new R005MachinePolicyError(code, message, options);
}

async function loadSpreadsheetRuntime() {
  try {
    return await import("@oai/artifact-tool");
  } catch (error) {
    failPolicy(
      "BLOCKED_R005_POLICY_RUNTIME_UNAVAILABLE",
      "Workbook machine policy requires the approved spreadsheet runtime",
      { cause: error },
    );
  }
}

async function sha256File(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
  } catch (error) {
    if (error?.code === "ENOENT") {
      failPolicy(
        "BLOCKED_R005_POLICY_MISSING",
        `Не найден workbook machine policy: ${filePath}`,
        { cause: error },
      );
    }
    failPolicy(
      "BLOCKED_R005_POLICY_UNREADABLE",
      `Не удалось прочитать workbook machine policy: ${filePath}`,
      { cause: error },
    );
  }
}

export function assertStableR005PolicySource(beforeSha256, afterSha256) {
  if (!beforeSha256 || !afterSha256 || beforeSha256 !== afterSha256) {
    failPolicy(
      "BLOCKED_R005_POLICY_DRIFT",
      `SHA-256 policy изменился во время чтения: ${beforeSha256 || "<missing>"} -> ${afterSha256 || "<missing>"}`,
    );
  }
}

function readSheetValues(workbook, sheetName) {
  let sheet;
  try {
    sheet = workbook.worksheets.getItem(sheetName);
  } catch (error) {
    failPolicy(
      "BLOCKED_R005_POLICY_CORRUPT",
      `В workbook отсутствует обязательный лист ${sheetName}`,
      { cause: error },
    );
  }
  const usedRange = sheet.getUsedRange(true);
  if (!usedRange) {
    failPolicy(
      "BLOCKED_R005_POLICY_CORRUPT",
      `Обязательный лист ${sheetName} пуст`,
    );
  }
  return usedRange.values;
}

function uniquePair(rows, key, keyColumn, valueColumn) {
  const expected = normalizeKey(key);
  const matches = rows.filter((row) => normalizeKey(row[keyColumn]) === expected);
  if (matches.length === 0) {
    failPolicy(
      "BLOCKED_R005_POLICY_CORRUPT",
      `В policy отсутствует обязательное поле «${key}»`,
    );
  }
  if (matches.length !== 1) {
    failPolicy(
      "BLOCKED_R005_POLICY_AMBIGUOUS",
      `Поле «${key}» встречается ${matches.length} раз`,
    );
  }
  return normalizeText(matches[0][valueColumn]);
}

function parseYesNo(value, label) {
  const normalized = normalizeKey(value);
  if (["да", "true", "1"].includes(normalized)) return true;
  if (["нет", "false", "0"].includes(normalized)) return false;
  failPolicy(
    "BLOCKED_R005_POLICY_CORRUPT",
    `Поле «${label}» содержит недопустимое логическое значение «${normalizeText(value)}»`,
  );
}

function parseGateTable(rows) {
  const records = rows
    .filter((row) => /^BLK-R005-/i.test(normalizeText(row[0])))
    .map((row) => ({
      code: normalizeText(row[0]),
      evidence_field: normalizeText(row[1]),
      requirement: normalizeText(row[2]),
      failure_status: normalizeText(row[3]),
      check_type: normalizeText(row[4]),
      enforced_by_engine: parseYesNo(row[5], `${normalizeText(row[0])}.enforced_by_engine`),
      comment: normalizeText(row[6]),
    }));

  const seen = new Map();
  for (const gate of records) {
    const key = normalizeKey(gate.evidence_field);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (normalizeKey(gate.failure_status) !== "blocked" || !gate.enforced_by_engine) {
      failPolicy(
        "BLOCKED_R005_POLICY_CORRUPT",
        `Gate ${gate.code} не является обязательным fail-closed контролем`,
      );
    }
  }

  for (const requiredField of REQUIRED_GATE_FIELDS) {
    const count = seen.get(normalizeKey(requiredField)) ?? 0;
    if (count === 0) {
      failPolicy(
        "BLOCKED_R005_POLICY_CORRUPT",
        `В 04_Гейт_R005 отсутствует обязательный gate «${requiredField}»`,
      );
    }
    if (count !== 1) {
      failPolicy(
        "BLOCKED_R005_POLICY_AMBIGUOUS",
        `Gate «${requiredField}» встречается ${count} раз`,
      );
    }
  }
  return records;
}

function parseCorrectionRules(rows) {
  const records = rows
    .filter((row) => /^[a-z][a-z0-9_]+$/i.test(normalizeText(row[0])))
    .map((row) => ({
      rule_id: normalizeText(row[0]),
      revision: normalizeText(row[1]),
      blocks: parseYesNo(row[2], `${normalizeText(row[0])}.blocks`),
      note: normalizeText(row[3]),
    }));

  const byId = new Map();
  for (const rule of records) {
    const key = normalizeKey(rule.rule_id);
    if (byId.has(key)) {
      failPolicy(
        "BLOCKED_R005_POLICY_AMBIGUOUS",
        `Правило «${rule.rule_id}» определено более одного раза`,
      );
    }
    byId.set(key, rule);
  }
  for (const ruleId of REQUIRED_CORRECTION_RULES) {
    if (!byId.has(normalizeKey(ruleId))) {
      failPolicy(
        "BLOCKED_R005_POLICY_CORRUPT",
        `В 05_Правила_корректировок отсутствует «${ruleId}»`,
      );
    }
  }
  return Object.fromEntries([...byId.entries()]);
}

function validateVersionHistory(rows) {
  const records = rows
    .filter((row) => normalizeText(row[0]) && normalizeText(row[1]) && normalizeText(row[2]))
    .map((row) => ({
      version: normalizeText(row[0]),
      type: normalizeText(row[1]),
      status: normalizeText(row[2]),
      purpose: normalizeText(row[3]),
      successor: normalizeText(row[4]),
      application: normalizeText(row[5]),
    }));
  const activeProjectRules = records.filter(
    (row) => normalizeKey(row.type) === normalizeKey("Правила проекта") && normalizeKey(row.status) === "active",
  );
  if (activeProjectRules.length !== 1) {
    failPolicy(
      "BLOCKED_R005_POLICY_AMBIGUOUS",
      `Ожидалась одна ACTIVE версия правил проекта, найдено ${activeProjectRules.length}`,
    );
  }
  if (normalizeKey(activeProjectRules[0].version) !== "r005") {
    failPolicy(
      "BLOCKED_R005_POLICY_R006_SUBSTITUTION",
      `Активная версия правил проекта — ${activeProjectRules[0].version}, требуется R005`,
    );
  }
  const invalidMonthlySubstitute = records.find(
    (row) => /r006|v07/i.test(row.version) && normalizeKey(row.type) === normalizeKey("Правила проекта"),
  );
  if (invalidMonthlySubstitute) {
    failPolicy(
      "BLOCKED_R005_POLICY_R006_SUBSTITUTION",
      `${invalidMonthlySubstitute.version} ошибочно объявлена правилами проекта`,
    );
  }
  return records;
}

function parseR005PolicyWorkbook(workbook, provenance, configuredPolicyId) {
  const passportRows = readSheetValues(workbook, REQUIRED_SHEETS.passport);
  const gateRows = readSheetValues(workbook, REQUIRED_SHEETS.gates);
  const correctionRuleRows = readSheetValues(workbook, REQUIRED_SHEETS.correctionRules);
  const versionRows = readSheetValues(workbook, REQUIRED_SHEETS.versionHistory);

  const policyId = uniquePair(passportRows, "Версия правил проекта", 0, 1);
  if (configuredPolicyId !== ACTIVE_R005_POLICY_ID) {
    failPolicy(
      "BLOCKED_R005_POLICY_CONFIG_DRIFT",
      `В config выбрана версия ${configuredPolicyId || "<missing>"}; разрешена только ${ACTIVE_R005_POLICY_ID}`,
    );
  }
  if (policyId !== ACTIVE_R005_POLICY_ID) {
    failPolicy(
      "BLOCKED_R005_POLICY_ID_MISMATCH",
      `Workbook объявляет ${policyId}; требуется ${ACTIVE_R005_POLICY_ID}`,
    );
  }

  const policyStatus = uniquePair(passportRows, "Статус политики", 0, 1);
  if (policyStatus !== "ACTIVE_FAIL_CLOSED") {
    failPolicy(
      "BLOCKED_R005_POLICY_INACTIVE",
      `Статус policy — ${policyStatus}; требуется ACTIVE_FAIL_CLOSED`,
    );
  }
  const releaseStatus = uniquePair(passportRows, "Статус выпуска", 0, 1);
  if (!releaseStatus.startsWith("BLOCKED_")) {
    failPolicy(
      "BLOCKED_R005_POLICY_RELEASE_OPEN",
      `R005 workbook не сохранил fail-closed статус выпуска: ${releaseStatus}`,
    );
  }
  const readyToUpload = parseYesNo(
    uniquePair(passportRows, "ready_to_upload", 3, 4),
    "ready_to_upload",
  );
  const releaseAllowed = parseYesNo(
    uniquePair(passportRows, "release_allowed", 3, 4),
    "release_allowed",
  );
  if (readyToUpload || releaseAllowed) {
    failPolicy(
      "BLOCKED_R005_POLICY_RELEASE_OPEN",
      "R005 workbook должен сохранять ready_to_upload=false и release_allowed=false",
    );
  }

  const gates = parseGateTable(gateRows);
  const correctionRules = parseCorrectionRules(correctionRuleRows);
  const versionHistory = validateVersionHistory(versionRows);
  const effectiveDate = uniquePair(passportRows, "Дата действия", 0, 1);

  return Object.freeze({
    schema: R005_MACHINE_POLICY_SCHEMA,
    policy_id: policyId,
    policy_status: policyStatus,
    effective_date: effectiveDate,
    release_status: releaseStatus,
    report_only: true,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    source: Object.freeze({ ...provenance }),
    gates: Object.freeze(gates),
    correction_rules: Object.freeze(correctionRules),
    version_history: Object.freeze(versionHistory),
  });
}

export async function loadR005MachinePolicy({
  configuredPath,
  configuredPolicyId,
  expectedSha256 = null,
}) {
  if (!configuredPath) {
    failPolicy(
      "BLOCKED_R005_POLICY_MISSING",
      "В config отсутствует путь к workbook machine policy",
    );
  }
  const resolvedPath = path.resolve(configuredPath);
  const sha256Before = await sha256File(resolvedPath);
  if (expectedSha256 && sha256Before !== String(expectedSha256).toUpperCase()) {
    failPolicy(
      "BLOCKED_R005_POLICY_EXPECTED_SHA_MISMATCH",
      `Текущий SHA-256 ${sha256Before} не совпадает с ожидаемым ${String(expectedSha256).toUpperCase()}`,
    );
  }

  const { FileBlob, SpreadsheetFile } = await loadSpreadsheetRuntime();
  let workbook;
  try {
    workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(resolvedPath));
  } catch (error) {
    failPolicy(
      "BLOCKED_R005_POLICY_CORRUPT",
      `Workbook machine policy не удалось импортировать: ${resolvedPath}`,
      { cause: error },
    );
  }
  const sha256After = await sha256File(resolvedPath);
  assertStableR005PolicySource(sha256Before, sha256After);

  return parseR005PolicyWorkbook(
    workbook,
    {
      path: resolvedPath,
      sha256: sha256After,
      selected_version: ACTIVE_R005_POLICY_ID,
    },
    normalizeText(configuredPolicyId),
  );
}

export function applyR005MachinePolicyToProfile(profile, policy) {
  if (profile?.id !== "UK_R005") {
    failPolicy(
      "BLOCKED_R005_POLICY_PROFILE_MISMATCH",
      `Machine policy R005 нельзя применить к профилю ${profile?.id || "<missing>"}`,
    );
  }
  if (policy?.policy_id !== ACTIVE_R005_POLICY_ID) {
    failPolicy(
      "BLOCKED_R005_POLICY_ID_MISMATCH",
      "Профиль нельзя рассчитать без валидной активной R005 policy",
    );
  }
  return {
    ...profile,
    projectRules: policy.policy_id,
    status: policy.release_status,
    rulesPath: policy.source.path,
    rulesNote: `Machine policy ${policy.policy_id} загружена fail-closed; SHA-256 ${policy.source.sha256}.`,
    machinePolicy: policy,
    allGroupingsExpandToLeaves:
      policy.correction_rules.all_groupings_expand_to_leaves?.blocks === true,
    currentMonthInputsOverrideHistory:
      policy.correction_rules.current_month_inputs_override_history?.blocks === true,
  };
}

export function evaluateR005DecisionClass(policy, decisionClass) {
  if (policy?.policy_id !== ACTIVE_R005_POLICY_ID) {
    failPolicy(
      "BLOCKED_R005_POLICY_MISSING",
      "Класс решения нельзя оценить без валидной R005 policy",
    );
  }
  const normalizedClass = normalizeText(decisionClass).toUpperCase();
  const formulaOrMapping = ["UPDATE_FORMULA", "UPDATE_MAPPING"].includes(normalizedClass);
  const stornoRepost = ["STORNO_REPOST", "STORNO_REPOST_CANDIDATE"].includes(
    normalizedClass,
  );
  const mustNotPost =
    formulaOrMapping && policy.correction_rules.formula_mapping?.blocks === true;
  const zeroSumRuleEnforced =
    policy.correction_rules.zero_sum_group_storno_repost?.blocks === true;
  if (stornoRepost) {
    return Object.freeze({
      decision_class: normalizedClass,
      policy_applied: true,
      policy_id: policy.policy_id,
      posting_allowed: false,
      candidate_generation_allowed: zeroSumRuleEnforced,
      candidate_only: true,
      posting_rows: 0,
      classification_gate: zeroSumRuleEnforced
        ? "STORNO_REPOST_CANDIDATE_GATED"
        : "BLOCKED_STORNO_REPOST_RULE_NOT_ENFORCED",
      required_release_gates: Object.freeze([
        "duplicate_control_passed",
        "storno_source_sign_inversion_passed",
        "idempotency_control_passed",
        "live_1c_preflight_passed",
        "osv_control_passed",
      ]),
      ready_to_upload: false,
      release_allowed: false,
    });
  }
  return Object.freeze({
    decision_class: normalizedClass,
    policy_applied: true,
    policy_id: policy.policy_id,
    posting_allowed: false,
    posting_rows: 0,
    classification_gate: mustNotPost ? "FORMULA_MAPPING_NO_POSTING" : "REPORT_ONLY_NO_POSTING",
    ready_to_upload: false,
    release_allowed: false,
  });
}

export function r005PolicyTrace(policy) {
  if (policy?.policy_id !== ACTIVE_R005_POLICY_ID || !policy?.source?.path || !policy?.source?.sha256) {
    failPolicy(
      "BLOCKED_R005_POLICY_MISSING",
      "Нельзя сериализовать provenance неполной R005 policy",
    );
  }
  return Object.freeze({
    schema: policy.schema,
    policy_id: policy.policy_id,
    policy_status: policy.policy_status,
    effective_date: policy.effective_date,
    release_status: policy.release_status,
    path: policy.source.path,
    sha256: policy.source.sha256,
    selected_version: policy.source.selected_version,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  });
}
