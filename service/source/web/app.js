const state = {
  erpFileId: "",
  intalevFileId: "",
  snapshot: null,
  organizationsLoaded: false,
  organizationsPromise: null,
  refreshPromise: null,
  mutationDepth: 0,
  activeRunId: "",
  activeRunPollPromise: null,
  activeRunPollTimer: null,
};

const ACTIVE_RUN_STATUSES = new Set(["QUEUED", "PREFLIGHT", "RUNNING"]);

const byId = (id) => document.getElementById(id);

function dispatchMutationState() {
  window.dispatchEvent(new CustomEvent("opiu:mutation-state", {
    detail: { active: state.mutationDepth > 0 },
  }));
}

function beginMutation() {
  state.mutationDepth += 1;
  dispatchMutationState();
}

function endMutation() {
  state.mutationDepth = Math.max(0, state.mutationDepth - 1);
  dispatchMutationState();
}

function mutationActive() {
  return state.mutationDepth > 0;
}

function pollingPaused() {
  return mutationActive() || document.hidden || rulesReviewEditing();
}

window.opiuUIActivity = {
  beginMutation,
  endMutation,
  isMutationActive: mutationActive,
  isPollingPaused: pollingPaused,
};

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const tracksMutation = method !== "GET" && method !== "HEAD";
  if (tracksMutation) beginMutation();
  try {
    const response = await fetch(url, {
      ...options,
      headers: options.body instanceof FormData ? options.headers : {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Операция не выполнена");
    return payload;
  } finally {
    if (tracksMutation) endMutation();
  }
}

function setNotice(text, kind = "") {
  const notice = byId("serviceNotice");
  notice.textContent = text;
  notice.className = `notice ${kind}`.trim();
}

function formatTime(value) {
  if (!value) return "";
  try { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

function runIsTerminal(run) {
  return Boolean(run?.status) && !ACTIVE_RUN_STATUSES.has(String(run.status));
}

function runStageLabel(run) {
  const status = String(run?.status || "");
  const stage = String(run?.stage || "").toUpperCase();
  if (status === "COMPLETED_REPORT_ONLY") return "Готово";
  if (status === "FAILED") return "Запуск завершился ошибкой";
  if (status.startsWith("BLOCKED_")) return "Запуск остановлен безопасно";
  if (status === "QUEUED") return "В очереди";
  if (status === "PREFLIGHT" || stage === "PREFLIGHT") return "Проверяем входные данные";
  if (stage.includes("INVENTORY") || stage.includes("PROOF") || stage.includes("HANDOFF") || stage.includes("VALIDATION")) {
    return "Проверяем структуру и доказательства";
  }
  if (stage.startsWith("R001")) return "R001 — формируем комплект корректировок";
  if (stage.startsWith("R005")) return "R005 — формируем сверку";
  return "Выполняем расчёт";
}

function updateRunButtonState() {
  const button = byId("runButton");
  if (!button) return;
  button.disabled = Boolean(state.activeRunId) || !byId("contextSelect")?.value || mutationActive();
}

function stopActiveRunPolling() {
  if (state.activeRunPollTimer) clearTimeout(state.activeRunPollTimer);
  state.activeRunPollTimer = null;
}

function renderActiveRunStatus(run) {
  if (!run || !state.activeRunId || run.id !== state.activeRunId) return;
  const status = byId("runStatus");
  const terminal = runIsTerminal(run);
  const time = terminal ? run.finished_at : run.started_at;
  const timeLabel = time ? `${terminal ? "завершён" : "начат"} ${formatTime(time)}` : "время уточняется";
  const reason = terminal && run.message ? ` Причина: ${run.message}.` : "";
  status.replaceChildren(document.createTextNode(
    `${runStageLabel(run)}.${reason} Запуск ${run.id} · ${timeLabel}.`
  ));
  if (run.status === "COMPLETED_REPORT_ONLY") {
    const link = document.createElement("a");
    link.href = `#run-${run.id}`;
    link.textContent = " Открыть результат";
    status.append(link);
  }
  if (terminal) {
    stopActiveRunPolling();
    state.activeRunId = "";
  }
  updateRunButtonState();
}

function scheduleActiveRunPoll(delay = 1000) {
  stopActiveRunPolling();
  if (!state.activeRunId) return;
  state.activeRunPollTimer = setTimeout(() => {
    state.activeRunPollTimer = null;
    void pollActiveRun();
  }, delay);
}

async function pollActiveRun() {
  if (!state.activeRunId) return null;
  if (pollingPaused()) {
    scheduleActiveRunPoll(500);
    return null;
  }
  if (state.activeRunPollPromise) return state.activeRunPollPromise;
  const exactRunId = state.activeRunId;
  state.activeRunPollPromise = (async () => {
    try {
      const run = await api(`/api/runs/${encodeURIComponent(exactRunId)}`);
      if (state.activeRunId !== exactRunId) return run;
      const terminal = runIsTerminal(run);
      renderActiveRunStatus(run);
      if (terminal) await refresh({ force: true });
      return run;
    } catch (error) {
      if (state.activeRunId === exactRunId) {
        byId("runStatus").textContent = `Не удалось обновить запуск ${exactRunId}: ${error.message}. Повторяем проверку…`;
      }
      return null;
    } finally {
      state.activeRunPollPromise = null;
      if (state.activeRunId === exactRunId) scheduleActiveRunPoll(1500);
    }
  })();
  return state.activeRunPollPromise;
}

function syncActiveRunFromSnapshot(runs) {
  const available = Array.isArray(runs) ? runs : [];
  if (state.activeRunId) {
    const exact = available.find((run) => run.id === state.activeRunId);
    if (exact) renderActiveRunStatus(exact);
    return;
  }
  const active = available.find((run) => ACTIVE_RUN_STATUSES.has(String(run.status)));
  if (!active) return;
  state.activeRunId = active.id;
  renderActiveRunStatus(active);
  scheduleActiveRunPoll(250);
}

function selectedFileName(id) {
  return state.snapshot?.files?.find((item) => item.id === id)?.name || "";
}

async function loadOrganizations() {
  if (state.organizationsLoaded) return;
  if (state.organizationsPromise) return state.organizationsPromise;
  const select = byId("organization");
  const status = byId("organizationStatus");
  state.organizationsPromise = (async () => {
    try {
      const nodes = await api("/api/organizations");
      const current = select.value;
      select.replaceChildren();
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Выберите организацию";
      select.append(empty);
      for (const node of nodes) {
        const option = document.createElement("option");
        option.value = node.node_id;
        option.dataset.organizationName = node.name;
        option.dataset.organizationPath = node.path;
        const indent = "— ".repeat(Math.max(0, Number(node.depth || 0)));
        option.textContent = `${indent}${node.name || node.path || node.node_id}`;
        option.disabled = node.selectable === false;
        select.append(option);
      }
      if ([...select.options].some((option) => option.value === current)) select.value = current;
      state.organizationsLoaded = true;
      status.textContent = `Загружена иерархия: ${nodes.length} узлов`;
    } catch (error) {
      select.replaceChildren();
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Иерархия организаций недоступна";
      select.append(empty);
      status.textContent = error.message;
    } finally {
      state.organizationsPromise = null;
    }
  })();
  return state.organizationsPromise;
}

function render(snapshot) {
  state.snapshot = snapshot;
  const safety = snapshot.safety || {};
  if (safety.mode !== "REPORT_ONLY" || safety.posting_rows !== 0 || safety.live_1c_allowed !== false) {
    setNotice("Сервис остановлен: не подтверждён безопасный режим.", "error");
  } else if (snapshot.engine_adapter_ready) {
    setNotice("Сервис готов к отчётному запуску. Запись в 1С отключена.", "good");
  } else {
    setNotice("Файлы и контексты доступны. Подключение расчётных движков проходит проверку.", "warn");
  }

  const adapter = byId("adapterState");
  adapter.textContent = snapshot.engine_adapter_ready ? "Движки готовы" : "Подключение движков";
  adapter.className = snapshot.engine_adapter_ready ? "pill good" : "pill";

  if (state.erpFileId && !snapshot.files.some((file) => file.id === state.erpFileId)) state.erpFileId = "";
  if (state.intalevFileId && !snapshot.files.some((file) => file.id === state.intalevFileId)) state.intalevFileId = "";
  if (!state.erpFileId) state.erpFileId = snapshot.files.find((file) => file.kind === "erp")?.id || "";
  if (!state.intalevFileId) state.intalevFileId = snapshot.files.find((file) => file.kind === "intalev")?.id || "";
  byId("erpSelected").textContent = selectedFileName(state.erpFileId) || "Файл не выбран";
  byId("intalevSelected").textContent = selectedFileName(state.intalevFileId) || "Файл не выбран";

  renderContexts(snapshot.contexts || []);
  renderRuns(snapshot.runs || []);
  syncActiveRunFromSnapshot(snapshot.runs || []);
  if (typeof renderStructuralRunOptions === "function") renderStructuralRunOptions(snapshot);
  if (typeof renderEmptyArticleBindingRunOptions === "function") renderEmptyArticleBindingRunOptions(snapshot);
  window.opiuArticleApprovalRuns = (snapshot.runs || []).map((run) => ({
    id: run.id,
    status: run.status,
    stage: run.stage,
    message: run.message,
    started_at: run.started_at,
    finished_at: run.finished_at,
  }));
  window.dispatchEvent(new CustomEvent("opiu:bootstrap-updated", {
    detail: { runs: window.opiuArticleApprovalRuns },
  }));
}

function renderContexts(contexts) {
  const active = contexts.filter((item) => !item.archived);
  const select = byId("contextSelect");
  const previous = select.value;
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = active.length ? "Выберите контекст" : "Контекст пока не создан";
  select.append(empty);
  for (const context of active) {
    const option = document.createElement("option");
    option.value = context.id;
    option.textContent = `${context.organization} — ${context.period}${context.cfo ? ` — ${context.cfo}` : ""}`;
    select.append(option);
  }
  if (active.some((item) => item.id === previous)) select.value = previous;
  else if (active.length) select.value = active[0].id;
  updateRunButtonState();

  const list = byId("contextsList");
  list.replaceChildren();
  if (!contexts.length) {
    list.className = "list empty";
    list.textContent = "Контекстов пока нет";
    return;
  }
  list.className = "list";
  for (const context of contexts) {
    const item = document.createElement("div");
    item.className = "list-item";
    const row = document.createElement("div");
    row.className = "list-row";
    const title = document.createElement("span");
    title.className = "list-title";
    title.textContent = `${context.organization} — ${context.period}`;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = context.archived ? "Архив" : "Активен";
    row.append(title, status);
    item.append(row);
    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = `${context.cfo || "Без ЦФО"} · создан ${formatTime(context.created_at)}`;
    item.append(meta);
    if (!context.archived) {
      const archive = document.createElement("button");
      archive.type = "button";
      archive.className = "danger-link";
      archive.textContent = "Архивировать";
      archive.addEventListener("click", () => archiveContext(context.id));
      item.append(archive);
    }
    list.append(item);
  }
}

function renderRuns(runs) {
  const list = byId("runsList");
  list.replaceChildren();
  if (!runs.length) {
    list.className = "list empty";
    list.textContent = "Запусков пока нет";
    return;
  }
  list.className = "list";
  for (const run of runs) {
    const item = document.createElement("div");
    item.className = "list-item";
    item.id = `run-${run.id}`;
    item.dataset.runId = run.id || "";
    item.dataset.runStatus = run.status || "";
    const row = document.createElement("div");
    row.className = "list-row";
    const title = document.createElement("span");
    title.className = "list-title";
    title.textContent = run.message || "Отчётный запуск";
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = runStageLabel(run);
    row.append(title, status);
    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = `${run.stage} · ${formatTime(run.started_at)}`;
    item.append(row, meta);
    list.append(item);
  }
}

async function refresh(options = {}) {
  const force = options.force === true;
  if (!force && pollingPaused()) return state.snapshot;
  if (state.refreshPromise) {
    if (!force) return state.refreshPromise;
    await state.refreshPromise;
    if (state.refreshPromise) return state.refreshPromise;
  }
  state.refreshPromise = (async () => {
    try {
      const snapshot = await api("/api/bootstrap");
      render(snapshot);
      return snapshot;
    } catch (error) {
      setNotice(error.message, "error");
      return state.snapshot;
    } finally {
      state.refreshPromise = null;
    }
  })();
  return state.refreshPromise;
}

function rulesReviewEditing() {
  return Boolean(
    document.querySelector('.rules-review-box[data-dirty="true"]') ||
    document.querySelector(".rules-review-box:focus-within")
  );
}

async function uploadOne(input, kind) {
  if (!input.files?.[0]) return "";
  const data = new FormData();
  data.append("file", input.files[0]);
  const result = await api(`/api/files?kind=${kind}`, { method: "POST", body: data });
  return result.id;
}

async function uploadSources() {
  const status = byId("uploadStatus");
  const button = byId("uploadButton");
  if (mutationActive()) {
    status.textContent = "Дождитесь завершения текущей операции.";
    return;
  }
  beginMutation();
  button.disabled = true;
  try {
    const erpInput = byId("erpFile");
    const intalevInput = byId("intalevFile");
    if (!erpInput.files?.[0] && !intalevInput.files?.[0]) throw new Error("Выберите хотя бы один файл");
    const stages = [];
    if (erpInput.files?.[0]) stages.push({ input: erpInput, kind: "erp", label: "ERP" });
    if (intalevInput.files?.[0]) stages.push({ input: intalevInput, kind: "intalev", label: "Инталев" });
    const completed = [];
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      status.textContent = `Загружаем ${stage.label} (${index + 1} из ${stages.length})…`;
      const id = await uploadOne(stage.input, stage.kind);
      if (stage.kind === "erp") state.erpFileId = id;
      if (stage.kind === "intalev") state.intalevFileId = id;
      completed.push(stage.label);
      status.textContent = `${stage.label} загружен. ${index + 1 < stages.length ? "Переходим к следующему файлу…" : "Обновляем данные…"}`;
    }
    await refresh({ force: true });
    status.textContent = `${completed.join(" и ")} загружены. Можно создавать контекст.`;
  } catch (error) {
    status.textContent = `Загрузка остановлена: ${error.message}`;
  } finally {
    button.disabled = false;
    endMutation();
  }
}

async function createContext() {
  const status = byId("contextStatus");
  if (mutationActive()) {
    status.textContent = "Дождитесь завершения текущей операции.";
    return;
  }
  beginMutation();
  status.textContent = "Создаём контекст…";
  try {
    if (!state.erpFileId || !state.intalevFileId) throw new Error("Сначала загрузите оба источника");
    const organizationOption = byId("organization").selectedOptions[0];
    const organization = organizationOption?.value || "";
	const organizationName = organizationOption?.dataset.organizationName || "";
	const organizationPath = organizationOption?.dataset.organizationPath || "";
    const period = byId("period").value;
    if (!organization) throw new Error("Выберите организацию из иерархии");
    if (!period) throw new Error("Выберите месяц");
    const context = await api("/api/contexts", {
      method: "POST",
      body: JSON.stringify({
		organization: organizationName,
		organization_id: organization,
		organization_name: organizationName,
		organization_path: organizationPath,
        cfo: byId("cfo").value,
        period,
        erp_file_id: state.erpFileId,
        intalev_file_id: state.intalevFileId,
      }),
    });
    await refresh({ force: true });
    status.textContent = "Контекст создан";
    byId("contextSelect").value = context.id;
    byId("runButton").disabled = false;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    endMutation();
  }
}

async function archiveContext(id) {
  if (mutationActive()) return;
  beginMutation();
  try {
    await api(`/api/contexts/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" });
    await refresh({ force: true });
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    endMutation();
  }
}

async function startRun() {
  const status = byId("runStatus");
  const contextId = byId("contextSelect").value;
  if (!contextId) return;
  if (state.activeRunId) {
    status.textContent = `Запуск ${state.activeRunId} ещё выполняется. Дождитесь его завершения.`;
    updateRunButtonState();
    return;
  }
  if (mutationActive()) {
    status.textContent = "Дождитесь завершения текущей операции.";
    return;
  }
  beginMutation();
  status.textContent = "Запуск поставлен в очередь…";
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ context_id: contextId }) });
    state.activeRunId = run.id;
    renderActiveRunStatus(run);
    await refresh({ force: true });
  } catch (error) {
    status.textContent = error.message;
  } finally {
    endMutation();
    updateRunButtonState();
    if (state.activeRunId) scheduleActiveRunPoll(250);
  }
}

byId("uploadButton").addEventListener("click", uploadSources);
byId("contextButton").addEventListener("click", createContext);
byId("runButton").addEventListener("click", startRun);
byId("contextSelect").addEventListener("change", updateRunButtonState);
byId("reselectButton").addEventListener("click", () => {
  state.erpFileId = "";
  state.intalevFileId = "";
  byId("erpFile").value = "";
  byId("intalevFile").value = "";
  byId("erpSelected").textContent = "Файл не выбран";
  byId("intalevSelected").textContent = "Файл не выбран";
  byId("erpFile").focus();
});
byId("refreshContexts").addEventListener("click", refresh);
byId("refreshRuns").addEventListener("click", refresh);

Promise.all([refresh(), loadOrganizations()]);
const uiSession = new EventSource("/api/ui-session");
window.addEventListener("pagehide", () => uiSession.close(), { once: true });
setInterval(() => {
  if (!pollingPaused() && !state.activeRunId) void refresh();
}, 10000);
