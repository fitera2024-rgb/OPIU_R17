const state = {
  erpFileId: "",
  intalevFileId: "",
  snapshot: null,
  organizationsLoaded: false,
};

const byId = (id) => document.getElementById(id);

async function api(url, options = {}) {
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

function selectedFileName(id) {
  return state.snapshot?.files?.find((item) => item.id === id)?.name || "";
}

async function loadOrganizations() {
  if (state.organizationsLoaded) return;
  const select = byId("organization");
  const status = byId("organizationStatus");
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
  }
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
  if (typeof renderStructuralRunOptions === "function") renderStructuralRunOptions(snapshot);
  if (typeof renderEmptyArticleBindingRunOptions === "function") renderEmptyArticleBindingRunOptions(snapshot);
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
  byId("runButton").disabled = !select.value;

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
    const row = document.createElement("div");
    row.className = "list-row";
    const title = document.createElement("span");
    title.className = "list-title";
    title.textContent = run.message || "Отчётный запуск";
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = run.status;
    row.append(title, status);
    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = `${run.stage} · ${formatTime(run.started_at)}`;
    item.append(row, meta);
    list.append(item);
  }
}

async function refresh() {
  try {
    render(await api("/api/bootstrap"));
  } catch (error) {
    setNotice(error.message, "error");
  }
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
  status.textContent = "Загружаем файлы…";
  try {
    const erpInput = byId("erpFile");
    const intalevInput = byId("intalevFile");
    if (!erpInput.files?.[0] && !intalevInput.files?.[0]) throw new Error("Выберите хотя бы один файл");
    const erpId = await uploadOne(erpInput, "erp");
    const intalevId = await uploadOne(intalevInput, "intalev");
    if (erpId) state.erpFileId = erpId;
    if (intalevId) state.intalevFileId = intalevId;
    status.textContent = "Файлы загружены";
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}

async function createContext() {
  const status = byId("contextStatus");
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
    status.textContent = "Контекст создан";
    await refresh();
    byId("contextSelect").value = context.id;
    byId("runButton").disabled = false;
  } catch (error) {
    status.textContent = error.message;
  }
}

async function archiveContext(id) {
  try {
    await api(`/api/contexts/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" });
    await refresh();
  } catch (error) {
    setNotice(error.message, "error");
  }
}

async function startRun() {
  const status = byId("runStatus");
  const contextId = byId("contextSelect").value;
  if (!contextId) return;
  status.textContent = "Запуск поставлен в очередь…";
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ context_id: contextId }) });
    status.textContent = `Запуск ${run.status}`;
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
}

byId("uploadButton").addEventListener("click", uploadSources);
byId("contextButton").addEventListener("click", createContext);
byId("runButton").addEventListener("click", startRun);
byId("contextSelect").addEventListener("change", (event) => { byId("runButton").disabled = !event.target.value; });
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
  if (!rulesReviewEditing()) refresh();
}, 3000);
