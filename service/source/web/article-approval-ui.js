(() => {
  const ARTICLE_APPROVAL_QUEUE_SCHEMA = "opiu-article-approval-queue.v1";
  const ARTICLE_APPROVAL_SCHEMA = "opiu-article-approval.v1";
  const ARTICLE_APPROVAL_DECISIONS = Object.freeze([
    "УТВЕРЖДАЮ",
    "ИЗМЕНИТЬ",
    "ЗАПРЕТИТЬ",
    "НУЖНА ПРОВЕРКА",
    "ПРЕДЛОЖЕНО ДВИЖКОМ",
  ]);
  const ARTICLE_APPROVAL_LABELS = Object.freeze({
    "УТВЕРЖДАЮ": "Утвердить",
    "ИЗМЕНИТЬ": "Изменить",
    "ЗАПРЕТИТЬ": "Запретить",
    "НУЖНА ПРОВЕРКА": "Нужна проверка",
    "ПРЕДЛОЖЕНО ДВИЖКОМ": "Оставить предложением",
  });
  const ARTICLE_APPROVAL_MAX_REQUEST_BYTES = 1 << 20;
  const ARTICLE_APPROVAL_STALE_CODES = new Set([
    "ARTICLE_APPROVAL_QUEUE_REVISION_STALE",
    "ARTICLE_APPROVAL_R005_ANCHOR_INVALID",
    "ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH",
    "ARTICLE_APPROVAL_SOURCE_SIZE_MISMATCH",
  ]);

  function approvalText(value) {
    return String(value ?? "").trim();
  }

  function requireArticleApprovalReportOnly(safety) {
    if (!safety || typeof safety !== "object" || Array.isArray(safety)) {
      throw new Error("Сервис не подтвердил безопасный отчётный режим");
    }
    const keys = Object.keys(safety).sort();
    const expected = ["live_1c_allowed", "mode", "posting_rows", "ready_to_upload", "release_allowed"].sort();
    if (keys.length !== expected.length || expected.some((key, index) => key !== keys[index]) ||
        safety.mode !== "REPORT_ONLY" || safety.posting_rows !== 0 || safety.ready_to_upload !== false ||
        safety.release_allowed !== false || safety.live_1c_allowed !== false) {
      throw new Error("Сервис не подтвердил безопасный отчётный режим");
    }
    return safety;
  }

  function exactArticleApprovalDecisions(values) {
    if (!Array.isArray(values) || values.length !== ARTICLE_APPROVAL_DECISIONS.length) return false;
    const unique = new Set(values);
    return unique.size === ARTICLE_APPROVAL_DECISIONS.length && ARTICLE_APPROVAL_DECISIONS.every((value) => unique.has(value));
  }

  function normalizeArticleApprovalQueue(payload, expectedRunID = "") {
    if (!payload || payload.status !== "PASS" || payload.schema_version !== ARTICLE_APPROVAL_QUEUE_SCHEMA) {
      throw new Error("Сервер вернул очередь неизвестной версии");
    }
    const runID = approvalText(payload.run_id);
    if (!runID || (expectedRunID && runID !== expectedRunID)) throw new Error("Очередь относится к другому запуску");
    const revision = approvalText(payload.queue_revision);
    if (!/^[A-Fa-f0-9]{64}$/.test(revision)) throw new Error("Сервер не подтвердил ревизию очереди");
    if (!exactArticleApprovalDecisions(payload.allowed_decisions)) throw new Error("Сервер вернул не пять допустимых решений");
    requireArticleApprovalReportOnly(payload.safety);

    const scope = payload.organization_scope;
    if (!scope || !approvalText(scope.organization_id) || !approvalText(scope.organization_name) ||
        !approvalText(scope.organization_hierarchy_path) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(approvalText(scope.period))) {
      throw new Error("Сервер не подтвердил точную организацию и период");
    }
    const actor = approvalText(payload.actor);
    if (!/^[^\\/\s]+\\[^\\/\s]+$/.test(actor)) throw new Error("Сервер не подтвердил системного пользователя");
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) throw new Error("Сервер вернул пустую очередь утверждений");

    const seen = new Set();
    const rows = payload.rows.map((source) => {
      const rowID = approvalText(source?.row_id);
      if (!/^row_[a-f0-9]{32}$/.test(rowID) || seen.has(rowID)) throw new Error("Сервер вернул неверный идентификатор строки");
      seen.add(rowID);
      const decision = approvalText(source.user_decision);
      if (!ARTICLE_APPROVAL_DECISIONS.includes(decision)) throw new Error("Строка содержит недопустимое решение");
      if (typeof source.bulk_approvable !== "boolean" || !Array.isArray(source.bulk_approval_blockers)) {
        throw new Error("Сервер не подтвердил массовое утверждение строки");
      }
      return {
        row_id: rowID,
        block_intalev: approvalText(source.block_intalev),
        path_intalev: approvalText(source.path_intalev),
        article_intalev: approvalText(source.article_intalev),
        income_expense_account: approvalText(source.income_expense_account),
        settlement_account: approvalText(source.settlement_account),
        proposed_block_erp: approvalText(source.proposed_block_erp),
        proposed_article_erp: approvalText(source.proposed_article_erp),
        proposed_code_erp: approvalText(source.proposed_code_erp),
        action: approvalText(source.action),
        selection_reason: approvalText(source.selection_reason),
        confidence: approvalText(source.confidence),
        physical_examples: approvalText(source.physical_examples),
        user_decision: decision,
        correct_block_erp: approvalText(source.correct_block_erp),
        correct_article_erp: approvalText(source.correct_article_erp),
        correct_code_erp: approvalText(source.correct_code_erp),
        user_comment: approvalText(source.user_comment),
        bulk_approvable: source.bulk_approvable,
        bulk_approval_blockers: source.bulk_approval_blockers.map(approvalText),
      };
    });
    const bulkCount = Number(payload.bulk_approvable);
    if (!Number.isInteger(bulkCount) || bulkCount < 0 || bulkCount !== rows.filter((row) => row.bulk_approvable).length) {
      throw new Error("Счётчик однозначных строк не совпадает с серверной очередью");
    }
    return {
      status: "PASS",
      schema_version: ARTICLE_APPROVAL_QUEUE_SCHEMA,
      run_id: runID,
      queue_revision: revision.toUpperCase(),
      organization_scope: {
        organization_id: approvalText(scope.organization_id),
        organization_name: approvalText(scope.organization_name),
        organization_hierarchy_path: approvalText(scope.organization_hierarchy_path),
        period: approvalText(scope.period),
      },
      actor,
      allowed_decisions: [...ARTICLE_APPROVAL_DECISIONS],
      rows,
      bulk_approvable: bulkCount,
      safety: payload.safety,
    };
  }

  function articleApprovalDecisionRows(queue) {
    return queue.rows.map((row, sourceIndex) => ({
      ...row,
      source_index: sourceIndex,
      original_decision: {
        user_decision: row.user_decision,
        correct_block_erp: row.correct_block_erp,
        correct_article_erp: row.correct_article_erp,
        correct_code_erp: row.correct_code_erp,
        user_comment: row.user_comment,
      },
    }));
  }

  function articleApprovalDecisionChanged(row) {
    const original = row.original_decision || {};
    return row.user_decision !== original.user_decision || row.correct_block_erp !== original.correct_block_erp ||
      row.correct_article_erp !== original.correct_article_erp || row.correct_code_erp !== original.correct_code_erp ||
      row.user_comment !== original.user_comment;
  }

  function articleApprovalHasDirtyIneligible(rows) {
    return rows.some((row) => !row.bulk_approvable && articleApprovalDecisionChanged(row));
  }

  function articleApprovalDecisionFingerprint(rows) {
    return JSON.stringify(rows.map((row) => [
      row.row_id, row.user_decision, row.correct_block_erp, row.correct_article_erp, row.correct_code_erp, row.user_comment,
    ]));
  }

  function buildArticleApprovalPayload(queue, rows, bulkApprove = false) {
    if (!queue || !Array.isArray(rows) || rows.length !== queue.rows.length) throw new Error("Нужен полный набор решений");
    const sourceIDs = new Set(queue.rows.map((row) => row.row_id));
    const decisions = rows.map((row) => {
      if (!sourceIDs.has(row.row_id)) throw new Error("Строка не входит в серверную очередь");
      return {
        row_id: row.row_id,
        user_decision: approvalText(row.user_decision),
        correct_block_erp: approvalText(row.correct_block_erp),
        correct_article_erp: approvalText(row.correct_article_erp),
        correct_code_erp: approvalText(row.correct_code_erp),
        user_comment: approvalText(row.user_comment),
      };
    });
    if (new Set(decisions.map((row) => row.row_id)).size !== queue.rows.length) throw new Error("Нужен полный набор уникальных строк");
    return { run_id: queue.run_id, revision: queue.queue_revision, bulk_approve: bulkApprove === true, decisions };
  }

  function validateArticleApprovalDecisionRows(rows, skipBulkEligible = false) {
    const issues = [];
    rows.forEach((row, index) => {
      if (skipBulkEligible && row.bulk_approvable) return;
      if (!ARTICLE_APPROVAL_DECISIONS.includes(row.user_decision)) {
        issues.push({ row: index + 1, code: "DECISION_INVALID", field: "user_decision", message: "Выберите одно из пяти решений" });
        return;
      }
      if (row.user_decision === "ИЗМЕНИТЬ") {
        for (const [field, message] of [
          ["correct_block_erp", "Укажите правильный блок ERP"],
          ["correct_article_erp", "Укажите правильную статью ERP"],
          ["correct_code_erp", "Укажите правильный код статьи ERP"],
          ["user_comment", "Добавьте комментарий к изменению"],
        ]) {
          if (!approvalText(row[field])) issues.push({ row: index + 1, code: "CHANGE_FIELDS_REQUIRED", field, message });
        }
      }
    });
    return issues;
  }

  function applyArticleApprovalServerBulk(rows) {
    return rows.map((row) => row.bulk_approvable ? {
      ...row,
      user_decision: "УТВЕРЖДАЮ",
      correct_block_erp: "",
      correct_article_erp: "",
      correct_code_erp: "",
      user_comment: "",
    } : { ...row });
  }

  function filterArticleApprovalRows(rows, filter) {
    return filter === "ВСЕ" ? [...rows] : rows.filter((row) =>
      (row.original_decision?.user_decision || row.user_decision) === "НУЖНА ПРОВЕРКА");
  }

  function mapArticleApprovalServerIssues(queue, issues) {
    const rowErrors = {};
    const globalErrors = [];
    for (const issue of Array.isArray(issues) ? issues : []) {
      const rowNumber = Number(issue?.row);
      const normalized = {
        code: approvalText(issue?.code) || "ARTICLE_APPROVAL_VALIDATION_FAILED",
        field: approvalText(issue?.field),
        message: approvalText(issue?.message) || "Решение не прошло серверную проверку",
      };
      if (Number.isInteger(rowNumber) && rowNumber > 0 && queue?.rows?.[rowNumber - 1]) {
        const rowID = queue.rows[rowNumber - 1].row_id;
        if (!rowErrors[rowID]) rowErrors[rowID] = [];
        rowErrors[rowID].push(normalized);
      } else {
        globalErrors.push(normalized);
      }
    }
    return { rowErrors, globalErrors };
  }

  function articleApprovalErrorCodes(payload) {
    const codes = [];
    if (approvalText(payload?.error)) codes.push(approvalText(payload.error));
    for (const issue of Array.isArray(payload?.errors) ? payload.errors : []) {
      if (approvalText(issue?.code)) codes.push(approvalText(issue.code));
    }
    return codes;
  }

  function isArticleApprovalStaleResponse(status, payload) {
    return status === 409 || articleApprovalErrorCodes(payload).some((code) => ARTICLE_APPROVAL_STALE_CODES.has(code));
  }

  function articleApprovalRequestBytes(payload) {
    const data = JSON.stringify(payload);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(data).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(data, "utf8");
    return unescape(encodeURIComponent(data)).length;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ARTICLE_APPROVAL_DECISIONS,
      ARTICLE_APPROVAL_MAX_REQUEST_BYTES,
      applyArticleApprovalServerBulk,
      articleApprovalDecisionChanged,
      articleApprovalDecisionFingerprint,
      articleApprovalDecisionRows,
      articleApprovalHasDirtyIneligible,
      articleApprovalRequestBytes,
      buildArticleApprovalPayload,
      exactArticleApprovalDecisions,
      filterArticleApprovalRows,
      isArticleApprovalStaleResponse,
      mapArticleApprovalServerIssues,
      normalizeArticleApprovalQueue,
      requireArticleApprovalReportOnly,
      validateArticleApprovalDecisionRows,
    };
    return;
  }

  const approvalState = {
    mode: "CLOSED",
    queue: null,
    rows: [],
    rowErrors: {},
    globalErrors: [],
    filter: "НУЖНА ПРОВЕРКА",
    validatedFingerprint: "",
    approved: null,
    statusMessage: "Выберите завершённую сверку.",
    statusKind: "",
    opener: null,
  };

  const approvalByID = (id) => document.getElementById(id);

  function friendlyArticleApprovalError(code) {
    return ({
      ARTICLE_APPROVAL_QUEUE_REVISION_STALE: "Очередь устарела. Загрузите её заново и повторите решение.",
      ARTICLE_APPROVAL_R005_ANCHOR_INVALID: "Проверенный результат R005 изменился или больше не доступен.",
      ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH: "Исходная сверка изменилась после открытия очереди.",
      ARTICLE_APPROVAL_SOURCE_SIZE_MISMATCH: "Размер исходной сверки изменился после открытия очереди.",
      ARTICLE_APPROVAL_RUN_NOT_FOUND: "Выбранный запуск не найден.",
      ARTICLE_APPROVAL_RUN_NOT_COMPLETED: "Выбранный запуск ещё не завершён.",
      ARTICLE_APPROVAL_HOST_ACTOR_UNAVAILABLE: "Сервис не смог определить учётную запись Windows.",
      ARTICLE_APPROVAL_REQUEST_INVALID: "Запрос не соответствует точной схеме утверждений.",
      ARTICLE_APPROVAL_NETWORK_ERROR: "Нет связи с локальным сервисом. Повторите действие после восстановления соединения.",
    })[code] || code || "Операция не выполнена";
  }

  async function articleApprovalFetch(url, options = {}) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
      });
      const payload = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, payload };
    } catch {
      return { ok: false, status: 0, payload: { error: "ARTICLE_APPROVAL_NETWORK_ERROR" } };
    }
  }

  function setArticleApprovalStatus(message, kind = "") {
    approvalState.statusMessage = message;
    approvalState.statusKind = kind;
    const status = approvalByID("article-approval-status");
    status.textContent = message;
    status.className = `notice ${kind}`.trim();
  }

  function clearArticleApprovalErrors() {
    approvalState.rowErrors = {};
    approvalState.globalErrors = [];
  }

  function appendArticleApprovalValue(parent, label, value) {
    const box = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const content = document.createElement("strong");
    content.textContent = approvalText(value) || "—";
    box.append(caption, content);
    parent.append(box);
  }

  function renderArticleApprovalScope() {
    const holder = approvalByID("article-approval-scope");
    holder.replaceChildren();
    holder.hidden = !approvalState.queue;
    if (!approvalState.queue) return;
    const scope = approvalState.queue.organization_scope;
    appendArticleApprovalValue(holder, "Организация", `${scope.organization_id} · ${scope.organization_name}`);
    appendArticleApprovalValue(holder, "Путь организации", scope.organization_hierarchy_path);
    appendArticleApprovalValue(holder, "Период", scope.period);
    appendArticleApprovalValue(holder, "Пользователь", approvalState.queue.actor);
  }

  function renderArticleApprovalCounters() {
    const holder = approvalByID("article-approval-counters");
    holder.replaceChildren();
    if (!approvalState.queue) return;
    const values = [
      ["Всего", approvalState.rows.length],
      ["Нужна проверка", approvalState.rows.filter((row) => row.user_decision === "НУЖНА ПРОВЕРКА").length],
      ["Однозначные", approvalState.rows.filter((row) => row.bulk_approvable).length],
    ];
    for (const [label, count] of values) {
      const item = document.createElement("span");
      item.className = "article-approval-counter";
      item.textContent = `${label}: ${count}`;
      holder.append(item);
    }
  }

  function renderArticleApprovalGlobalErrors() {
    const holder = approvalByID("article-approval-errors");
    holder.replaceChildren();
    holder.hidden = approvalState.globalErrors.length === 0;
    if (!approvalState.globalErrors.length) return;
    const title = document.createElement("strong");
    title.textContent = "Исправьте ошибки перед фиксацией:";
    const list = document.createElement("ul");
    for (const error of approvalState.globalErrors) {
      const item = document.createElement("li");
      item.textContent = `${error.message} (${error.code})`;
      list.append(item);
    }
    holder.append(title, list);
  }

  function appendArticleApprovalDetail(parent, label, value) {
    const wrapper = document.createElement("div");
    wrapper.className = "article-approval-detail";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = approvalText(value) || "—";
    wrapper.append(term, description);
    parent.append(wrapper);
  }

  function articleApprovalInput(row, labelText, field, maxLength, multiline = false) {
    const label = document.createElement("label");
    if (field === "user_comment") label.className = "article-approval-comment";
    label.append(document.createTextNode(labelText));
    const control = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) control.type = "text";
    control.value = row[field];
    control.maxLength = maxLength;
    control.required = true;
    control.dataset.rowId = row.row_id;
    control.dataset.approvalField = field;
    const hasFieldError = (approvalState.rowErrors[row.row_id] || []).some((error) => error.field === field);
    if (hasFieldError) control.setAttribute("aria-invalid", "true");
    label.append(control);
    return label;
  }

  function renderArticleApprovalRow(row) {
    const errors = approvalState.rowErrors[row.row_id] || [];
    const card = document.createElement("article");
    card.className = `article-approval-row ${errors.length ? "has-error" : ""}`.trim();
    card.dataset.rowId = row.row_id;
    card.tabIndex = -1;

    const heading = document.createElement("div");
    heading.className = "article-approval-row-title";
    const title = document.createElement("strong");
    title.textContent = `${row.block_intalev || "Без названия блока"} · ${row.article_intalev || "Без названия статьи"}`;
    const rowID = document.createElement("code");
    rowID.textContent = row.row_id;
    heading.append(title, rowID);

    const evidence = document.createElement("div");
    evidence.className = "article-approval-evidence";
    const intalev = document.createElement("div");
    const intalevLabel = document.createElement("span");
    intalevLabel.textContent = "Инталев — фактический путь";
    const intalevValue = document.createElement("strong");
    intalevValue.textContent = row.path_intalev || "—";
    intalev.append(intalevLabel, intalevValue);
    const erp = document.createElement("div");
    const erpLabel = document.createElement("span");
    erpLabel.textContent = "Предложенная цель ERP";
    const erpValue = document.createElement("strong");
    erpValue.textContent = [row.proposed_block_erp, row.proposed_article_erp, row.proposed_code_erp].filter(Boolean).join(" · ") || "—";
    const bulk = document.createElement("small");
    bulk.textContent = row.bulk_approvable ? "Однозначная строка по проверке сервера" :
      `Массовое утверждение недоступно${row.bulk_approval_blockers.length ? `: ${row.bulk_approval_blockers.join(", ")}` : ""}`;
    erp.append(erpLabel, erpValue, bulk);
    evidence.append(intalev, erp);

    const details = document.createElement("dl");
    details.className = "article-approval-details";
    appendArticleApprovalDetail(details, "Счёт доходов/расходов", row.income_expense_account);
    appendArticleApprovalDetail(details, "Счёт расчётов", row.settlement_account);
    appendArticleApprovalDetail(details, "Действие", row.action);
    appendArticleApprovalDetail(details, "Уверенность", row.confidence);
    appendArticleApprovalDetail(details, "Основание выбора", row.selection_reason);
    appendArticleApprovalDetail(details, "Примеры проводок", row.physical_examples);

    const decisions = document.createElement("fieldset");
    decisions.className = "article-approval-decisions";
    const legend = document.createElement("legend");
    legend.textContent = "Решение пользователя";
    decisions.append(legend);
    const choices = document.createElement("div");
    choices.className = "article-approval-choice-grid";
    for (const decision of ARTICLE_APPROVAL_DECISIONS) {
      const label = document.createElement("label");
      label.className = "article-approval-choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `article-approval-decision-${row.row_id}`;
      input.value = decision;
      input.checked = row.user_decision === decision;
      input.dataset.rowId = row.row_id;
      input.dataset.approvalDecision = decision;
      const copy = document.createElement("span");
      copy.textContent = ARTICLE_APPROVAL_LABELS[decision];
      label.append(input, copy);
      choices.append(label);
    }
    decisions.append(choices);

    card.append(heading, evidence, details, decisions);
    if (row.user_decision === "ИЗМЕНИТЬ") {
      const change = document.createElement("div");
      change.className = "article-approval-change-fields";
      change.append(
        articleApprovalInput(row, "Правильный блок ERP", "correct_block_erp", 300),
        articleApprovalInput(row, "Правильная статья ERP", "correct_article_erp", 300),
        articleApprovalInput(row, "Правильный код статьи ERP", "correct_code_erp", 200),
        articleApprovalInput(row, "Комментарий пользователя", "user_comment", 1000, true),
      );
      card.append(change);
    }
    if (errors.length) {
      const holder = document.createElement("div");
      holder.className = "article-approval-row-errors";
      const list = document.createElement("ul");
      for (const error of errors) {
        const item = document.createElement("li");
        item.textContent = `${error.message} (${error.code})`;
        list.append(item);
      }
      holder.append(list);
      card.append(holder);
    }
    return card;
  }

  function renderArticleApprovalRows() {
    const holder = approvalByID("article-approval-rows");
    holder.replaceChildren();
    if (!approvalState.queue) return;
    const rows = filterArticleApprovalRows(approvalState.rows, approvalState.filter);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "article-approval-empty";
      empty.textContent = approvalState.filter === "НУЖНА ПРОВЕРКА"
        ? "Строк со статусом «НУЖНА ПРОВЕРКА» нет. Выберите «Все строки», чтобы увидеть полный реестр."
        : "В очереди нет строк.";
      holder.append(empty);
      return;
    }
    for (const row of rows) holder.append(renderArticleApprovalRow(row));
  }

  function renderArticleApprovalResult() {
    const holder = approvalByID("article-approval-result");
    holder.replaceChildren();
    holder.hidden = !approvalState.approved;
    if (!approvalState.approved) return;
    const title = document.createElement("strong");
    title.textContent = `Создана approved-версия v${String(approvalState.approved.version).padStart(3, "0")}`;
    const files = document.createElement("div");
    files.textContent = `${approvalState.approved.file_name} · ${approvalState.approved.integrity_file_name}`;
    holder.append(title, files);
  }

  function renderArticleApprovalControls() {
    const busy = ["LOADING", "VALIDATING", "PUBLISHING"].includes(approvalState.mode);
    const blocked = !approvalState.queue || busy || ["STALE", "PUBLISHED", "PUBLICATION_UNKNOWN"].includes(approvalState.mode);
    const dirtyIneligible = approvalState.queue && articleApprovalHasDirtyIneligible(approvalState.rows);
    const bulk = approvalByID("article-approval-bulk");
    bulk.disabled = blocked || approvalState.queue.bulk_approvable === 0 || dirtyIneligible;
    bulk.textContent = approvalState.queue ? `Утвердить все однозначные (${approvalState.queue.bulk_approvable})` : "Утвердить все однозначные";
    bulk.title = dirtyIneligible ? "Сначала проверьте или сбросьте ручные изменения неоднозначных строк" : "";
    approvalByID("article-approval-validate").disabled = blocked;
    approvalByID("article-approval-fix").disabled = blocked ||
      approvalState.validatedFingerprint !== articleApprovalDecisionFingerprint(approvalState.rows);
    approvalByID("article-approval-reload").disabled = busy || !approvalByID("article-approval-run").value;
    approvalByID("article-approval-load").disabled = busy || !approvalByID("article-approval-run").value;
    approvalByID("article-approval-filter").disabled = !approvalState.queue || busy;
    approvalByID("article-approval-workspace").hidden = !approvalState.queue;
    setArticleApprovalStatus(approvalState.statusMessage, approvalState.statusKind);
  }

  function renderArticleApproval() {
    renderArticleApprovalScope();
    renderArticleApprovalCounters();
    renderArticleApprovalGlobalErrors();
    renderArticleApprovalRows();
    renderArticleApprovalResult();
    renderArticleApprovalControls();
  }

  function setArticleApprovalMode(mode, message, kind = "") {
    approvalState.mode = mode;
    approvalState.statusMessage = message;
    approvalState.statusKind = kind;
  }

  function markArticleApprovalDirty() {
    clearArticleApprovalErrors();
    approvalState.approved = null;
    approvalState.validatedFingerprint = "";
    setArticleApprovalMode("READY_DIRTY", "Решения изменены. Выполните серверную проверку.", "warn");
  }

  function articleApprovalUnsaved() {
    return ["READY_DIRTY", "VALIDATED", "ROW_ERRORS"].includes(approvalState.mode) &&
      approvalState.rows.some(articleApprovalDecisionChanged);
  }

  function confirmArticleApprovalDiscard() {
    return !articleApprovalUnsaved() || window.confirm("Есть незафиксированные решения. Продолжить?");
  }

  function syncArticleApprovalRuns(runs) {
    const select = approvalByID("article-approval-run");
    const previous = select.value;
    const completed = (Array.isArray(runs) ? runs : []).filter((run) =>
      approvalText(run?.id) && run.status === "COMPLETED_REPORT_ONLY" && ["DONE", "R005_COMPLETED"].includes(run.stage));
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = completed.length ? "Выберите завершённую сверку" : "Нет завершённых сверок";
    select.append(empty);
    for (const run of completed) {
      const option = document.createElement("option");
      option.value = run.id;
      option.textContent = approvalText(run.message) || run.id;
      select.append(option);
    }
    if (completed.some((run) => run.id === previous)) select.value = previous;
    else if (completed.length) select.value = completed[0].id;
    renderArticleApprovalControls();
  }

  function applyArticleApprovalFailure(status, payload) {
    approvalState.validatedFingerprint = "";
    if (isArticleApprovalStaleResponse(status, payload)) {
      const code = articleApprovalErrorCodes(payload)[0] || "ARTICLE_APPROVAL_QUEUE_REVISION_STALE";
      approvalState.globalErrors = [{ code, message: friendlyArticleApprovalError(code) }];
      approvalState.rowErrors = {};
      setArticleApprovalMode("STALE", `${friendlyArticleApprovalError(code)} Решения заблокированы до явной перезагрузки.`, "error");
      renderArticleApproval();
      return;
    }
    const mapped = mapArticleApprovalServerIssues(approvalState.queue, payload?.errors);
    approvalState.rowErrors = mapped.rowErrors;
    approvalState.globalErrors = mapped.globalErrors;
    const code = approvalText(payload?.error);
    if (code) approvalState.globalErrors.push({ code, message: friendlyArticleApprovalError(code) });
    if (!approvalState.globalErrors.length && !Object.keys(approvalState.rowErrors).length) {
      approvalState.globalErrors.push({ code: "ARTICLE_APPROVAL_REQUEST_FAILED", message: "Сервер не принял решения" });
    }
    if (!approvalState.queue) {
      const visible = approvalState.globalErrors[0];
      setArticleApprovalMode("ERROR", visible ? `${visible.message} (${visible.code})` : "Сервер не вернул очередь утверждений.", "error");
      renderArticleApproval();
      return;
    }
    if (Object.keys(approvalState.rowErrors).length) approvalState.filter = "ВСЕ";
    approvalByID("article-approval-filter").value = approvalState.filter;
    setArticleApprovalMode("ROW_ERRORS", "Сервер отклонил часть решений. Исправьте отмеченные строки.", "error");
    renderArticleApproval();
    focusFirstArticleApprovalError();
  }

  function focusFirstArticleApprovalError() {
    const rowID = Object.keys(approvalState.rowErrors)[0];
    if (!rowID) {
      approvalByID("article-approval-errors").focus?.();
      return;
    }
    const issue = approvalState.rowErrors[rowID][0];
    const field = issue.field;
    const input = field ? document.querySelector(`[data-row-id="${rowID}"][data-approval-field="${field}"]`) : null;
    (input || document.querySelector(`.article-approval-row[data-row-id="${rowID}"]`))?.focus();
  }

  function applyLocalArticleApprovalIssues(issues) {
    const mapped = mapArticleApprovalServerIssues(approvalState.queue, issues);
    approvalState.rowErrors = mapped.rowErrors;
    approvalState.globalErrors = mapped.globalErrors;
    if (Object.keys(approvalState.rowErrors).length) approvalState.filter = "ВСЕ";
    approvalByID("article-approval-filter").value = approvalState.filter;
    approvalState.validatedFingerprint = "";
    setArticleApprovalMode("ROW_ERRORS", "Заполните обязательные поля перед серверной проверкой.", "error");
    renderArticleApproval();
    focusFirstArticleApprovalError();
  }

  function requireArticleApprovalRequestSize(payload) {
    if (articleApprovalRequestBytes(payload) > ARTICLE_APPROVAL_MAX_REQUEST_BYTES) {
      approvalState.globalErrors = [{
        code: "ARTICLE_APPROVAL_REQUEST_TOO_LARGE",
        message: "Полный набор решений превышает допустимый размер. Уменьшите комментарии или обратитесь к администратору.",
      }];
      setArticleApprovalMode("ROW_ERRORS", "Очередь слишком велика для безопасной фиксации одним запросом.", "error");
      renderArticleApproval();
      return false;
    }
    return true;
  }

  async function loadArticleApprovalQueue() {
    if (!confirmArticleApprovalDiscard()) return;
    const runID = approvalByID("article-approval-run").value;
    if (!runID) return;
    approvalState.queue = null;
    approvalState.rows = [];
    approvalState.validatedFingerprint = "";
    approvalState.approved = null;
    clearArticleApprovalErrors();
    setArticleApprovalMode("LOADING", "Загружаем проверенную очередь из результата R005…");
    renderArticleApproval();
    const response = await articleApprovalFetch(`/api/article-approvals?run_id=${encodeURIComponent(runID)}`);
    if (!response.ok) {
      applyArticleApprovalFailure(response.status, response.payload);
      return;
    }
    try {
      approvalState.queue = normalizeArticleApprovalQueue(response.payload, runID);
      approvalState.rows = articleApprovalDecisionRows(approvalState.queue);
      approvalState.filter = "НУЖНА ПРОВЕРКА";
      approvalByID("article-approval-filter").value = approvalState.filter;
      setArticleApprovalMode("READY_CLEAN", "Очередь загружена. Проверьте решения пользователя.", "good");
      renderArticleApproval();
    } catch (error) {
      approvalState.globalErrors = [{ code: "ARTICLE_APPROVAL_QUEUE_INVALID", message: error.message }];
      setArticleApprovalMode("ERROR", `Серверная очередь не прошла безопасную проверку: ${error.message}`, "error");
      renderArticleApproval();
    }
  }

  async function validateArticleApproval() {
    clearArticleApprovalErrors();
    const issues = validateArticleApprovalDecisionRows(approvalState.rows);
    if (issues.length) {
      applyLocalArticleApprovalIssues(issues);
      return;
    }
    const payload = buildArticleApprovalPayload(approvalState.queue, approvalState.rows, false);
    if (!requireArticleApprovalRequestSize(payload)) return;
    setArticleApprovalMode("VALIDATING", "Сервер проверяет полный набор решений…");
    renderArticleApprovalControls();
    const response = await articleApprovalFetch("/api/article-approvals/validate", { method: "POST", body: JSON.stringify(payload) });
    if (!response.ok || response.payload?.status !== "PASS") {
      applyArticleApprovalFailure(response.status, response.payload);
      return;
    }
    try {
      requireArticleApprovalReportOnly(response.payload.safety);
    } catch (error) {
      approvalState.globalErrors = [{ code: "ARTICLE_APPROVAL_SAFETY_INVALID", message: error.message }];
      setArticleApprovalMode("ERROR", "Проверка остановлена: безопасный режим не подтверждён.", "error");
      renderArticleApproval();
      return;
    }
    approvalState.validatedFingerprint = articleApprovalDecisionFingerprint(approvalState.rows);
    setArticleApprovalMode("VALIDATED", "Все решения прошли серверную проверку. Можно зафиксировать новую версию.", "good");
    renderArticleApproval();
  }

  async function bulkApproveArticleApproval() {
    if (articleApprovalHasDirtyIneligible(approvalState.rows)) {
      approvalState.globalErrors = [{
        code: "ARTICLE_APPROVAL_BULK_ROW_NOT_ELIGIBLE",
        message: "Массовое действие недоступно, пока изменены неоднозначные строки.",
      }];
      setArticleApprovalMode("ROW_ERRORS", "Сначала проверьте или перезагрузите ручные изменения.", "warn");
      renderArticleApproval();
      return;
    }
    clearArticleApprovalErrors();
    const expectedRows = applyArticleApprovalServerBulk(approvalState.rows);
    const issues = validateArticleApprovalDecisionRows(expectedRows, true);
    if (issues.length) {
      applyLocalArticleApprovalIssues(issues);
      return;
    }
    const payload = buildArticleApprovalPayload(approvalState.queue, approvalState.rows, true);
    if (!requireArticleApprovalRequestSize(payload)) return;
    setArticleApprovalMode("VALIDATING", "Сервер проверяет однозначные строки для массового утверждения…");
    renderArticleApprovalControls();
    const response = await articleApprovalFetch("/api/article-approvals/validate", { method: "POST", body: JSON.stringify(payload) });
    if (!response.ok || response.payload?.status !== "PASS") {
      applyArticleApprovalFailure(response.status, response.payload);
      return;
    }
    try {
      requireArticleApprovalReportOnly(response.payload.safety);
    } catch (error) {
      approvalState.globalErrors = [{ code: "ARTICLE_APPROVAL_SAFETY_INVALID", message: error.message }];
      setArticleApprovalMode("ERROR", "Массовое утверждение остановлено: безопасный режим не подтверждён.", "error");
      renderArticleApproval();
      return;
    }
    approvalState.rows = expectedRows;
    approvalState.validatedFingerprint = articleApprovalDecisionFingerprint(approvalState.rows);
    setArticleApprovalMode("VALIDATED", "Сервер подтвердил массовое действие только для однозначных строк.", "good");
    renderArticleApproval();
  }

  async function fixArticleApproval() {
    const fingerprint = articleApprovalDecisionFingerprint(approvalState.rows);
    if (!approvalState.validatedFingerprint || approvalState.validatedFingerprint !== fingerprint) return;
    const payload = buildArticleApprovalPayload(approvalState.queue, approvalState.rows, false);
    if (!requireArticleApprovalRequestSize(payload)) return;
    clearArticleApprovalErrors();
    setArticleApprovalMode("PUBLISHING", "Сервис повторно проверяет очередь и атомарно создаёт approved-версию…");
    renderArticleApprovalControls();
    const response = await articleApprovalFetch("/api/article-approvals/fix", { method: "POST", body: JSON.stringify(payload) });
    if (!response.ok || response.payload?.status !== "PASS") {
      if (response.status === 0) {
        approvalState.validatedFingerprint = "";
        approvalState.globalErrors = [{
          code: "ARTICLE_APPROVAL_PUBLICATION_UNKNOWN",
          message: "Соединение прервалось во время фиксации. Не повторяйте публикацию, пока не проверите список approved-версий.",
        }];
        setArticleApprovalMode("PUBLICATION_UNKNOWN", "Результат фиксации неизвестен; повторная отправка заблокирована.", "error");
        renderArticleApproval();
        return;
      }
      applyArticleApprovalFailure(response.status, response.payload);
      return;
    }
    const approved = response.payload.approved;
    try {
      if (!approved || approved.schema_version !== ARTICLE_APPROVAL_SCHEMA || !Number.isInteger(approved.version) || approved.version < 1 ||
          !approvalText(approved.file_name) || !approvalText(approved.integrity_file_name) || approved.posting_rows !== 0) {
        throw new Error("Сервис не вернул имя созданной approved-версии");
      }
      requireArticleApprovalReportOnly(approved.safety);
    } catch (error) {
      approvalState.validatedFingerprint = "";
      approvalState.globalErrors = [{ code: "ARTICLE_APPROVAL_PUBLICATION_INVALID", message: error.message }];
      setArticleApprovalMode("PUBLICATION_UNKNOWN", "Ответ фиксации не прошёл проверку; повторная отправка заблокирована.", "error");
      renderArticleApproval();
      return;
    }
    approvalState.approved = {
      version: approved.version,
      file_name: approvalText(approved.file_name),
      integrity_file_name: approvalText(approved.integrity_file_name),
    };
    approvalState.validatedFingerprint = "";
    setArticleApprovalMode("PUBLISHED", "Утверждения зафиксированы. Предыдущие approved-версии не изменены.", "good");
    renderArticleApproval();
  }

  function updateArticleApprovalField(target) {
    const rowID = target.dataset.rowId;
    const row = approvalState.rows.find((item) => item.row_id === rowID);
    if (!row) return;
    if (target.dataset.approvalDecision) {
      row.user_decision = target.dataset.approvalDecision;
      markArticleApprovalDirty();
      renderArticleApproval();
      if (row.user_decision === "ИЗМЕНИТЬ") {
        document.querySelector(`[data-row-id="${rowID}"][data-approval-field="correct_block_erp"]`)?.focus();
      }
      return;
    }
    const field = target.dataset.approvalField;
    if (field && ["correct_block_erp", "correct_article_erp", "correct_code_erp", "user_comment"].includes(field)) {
      row[field] = target.value;
      markArticleApprovalDirty();
      renderArticleApprovalGlobalErrors();
      renderArticleApprovalControls();
    }
  }

  function openArticleApprovalDialog() {
    const dialog = approvalByID("article-approval-dialog");
    approvalState.opener = document.activeElement;
    if (!dialog.open) dialog.showModal();
    if (!approvalState.queue && approvalByID("article-approval-run").value) loadArticleApprovalQueue();
  }

  function closeArticleApprovalDialog() {
    if (!confirmArticleApprovalDiscard()) return;
    approvalByID("article-approval-dialog").close();
  }

  function initializeArticleApprovalUI() {
    const dialog = approvalByID("article-approval-dialog");
    approvalByID("openArticleApprovals").addEventListener("click", openArticleApprovalDialog);
    approvalByID("article-approval-close").addEventListener("click", closeArticleApprovalDialog);
    approvalByID("article-approval-load").addEventListener("click", loadArticleApprovalQueue);
    approvalByID("article-approval-reload").addEventListener("click", loadArticleApprovalQueue);
    approvalByID("article-approval-bulk").addEventListener("click", bulkApproveArticleApproval);
    approvalByID("article-approval-validate").addEventListener("click", validateArticleApproval);
    approvalByID("article-approval-fix").addEventListener("click", fixArticleApproval);
    approvalByID("article-approval-filter").addEventListener("change", (event) => {
      approvalState.filter = event.target.value === "ВСЕ" ? "ВСЕ" : "НУЖНА ПРОВЕРКА";
      renderArticleApprovalRows();
    });
    approvalByID("article-approval-run").addEventListener("change", () => {
      if (!confirmArticleApprovalDiscard()) {
        approvalByID("article-approval-run").value = approvalState.queue?.run_id || "";
        return;
      }
      approvalState.queue = null;
      approvalState.rows = [];
      approvalState.approved = null;
      approvalState.validatedFingerprint = "";
      clearArticleApprovalErrors();
      setArticleApprovalMode("SELECT_RUN", "Нажмите «Открыть очередь» для выбранной сверки.");
      renderArticleApproval();
    });
    approvalByID("article-approval-rows").addEventListener("change", (event) => {
      if (event.target.dataset.approvalDecision) updateArticleApprovalField(event.target);
    });
    approvalByID("article-approval-rows").addEventListener("input", (event) => {
      if (event.target.dataset.approvalField) updateArticleApprovalField(event.target);
    });
    dialog.addEventListener("cancel", (event) => {
      if (!confirmArticleApprovalDiscard()) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      approvalState.mode = approvalState.queue ? approvalState.mode : "CLOSED";
      approvalState.opener?.focus?.();
    });
    window.addEventListener("opiu:bootstrap-updated", (event) => syncArticleApprovalRuns(event.detail?.runs));
    syncArticleApprovalRuns(window.opiuArticleApprovalRuns || []);
    renderArticleApprovalControls();
  }

  window.addEventListener("DOMContentLoaded", initializeArticleApprovalUI);
})();
