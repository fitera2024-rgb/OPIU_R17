const diagnosticUI = {
  latestRunId: "",
  events: [],
  maxEvents: 500,
};

function pushDiagnosticEvent(type, detail = {}, level = "info") {
  diagnosticUI.events.push({
    at: new Date().toISOString(),
    type,
    level,
    detail,
  });
  if (diagnosticUI.events.length > diagnosticUI.maxEvents) {
    diagnosticUI.events.splice(0, diagnosticUI.events.length - diagnosticUI.maxEvents);
  }
}

function safeElementSummary(target) {
  if (!(target instanceof Element)) return {};
  const summary = {
    tag: target.tagName,
    id: target.id || "",
    name: target.getAttribute("name") || "",
    type: target.getAttribute("type") || "",
  };
  if (target instanceof HTMLInputElement && target.type === "file") {
    summary.files = [...(target.files || [])].map((file) => ({ name: file.name, size: file.size, type: file.type }));
  }
  if (target instanceof HTMLButtonElement) summary.text = (target.textContent || "").trim().slice(0, 120);
  return summary;
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async function instrumentedFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input?.url || String(input);
  const method = String(init?.method || (typeof input !== "string" ? input?.method : "GET") || "GET").toUpperCase();
  const started = performance.now();
  pushDiagnosticEvent("api.request", { method, url });
  try {
    const response = await nativeFetch(input, init);
    const detail = { method, url, status: response.status, ok: response.ok, duration_ms: Math.round(performance.now() - started) };
    pushDiagnosticEvent("api.response", detail, response.ok ? "info" : "error");
    return response;
  } catch (error) {
    pushDiagnosticEvent("api.fetch_failed", {
      method,
      url,
      duration_ms: Math.round(performance.now() - started),
      message: error?.message || String(error),
      online: navigator.onLine,
      page: location.href,
    }, "error");
    throw error;
  }
};

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (button) pushDiagnosticEvent("ui.click", safeElementSummary(button));
}, true);

document.addEventListener("change", (event) => {
  pushDiagnosticEvent("ui.change", safeElementSummary(event.target));
}, true);

window.addEventListener("error", (event) => {
  pushDiagnosticEvent("window.error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  }, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  pushDiagnosticEvent("window.unhandled_rejection", {
    message: event.reason?.message || String(event.reason || "unknown rejection"),
  }, "error");
});

window.addEventListener("online", () => pushDiagnosticEvent("browser.online", { online: true }));
window.addEventListener("offline", () => pushDiagnosticEvent("browser.offline", { online: false }, "warn"));
pushDiagnosticEvent("page.open", { page: location.href, user_agent: navigator.userAgent, online: navigator.onLine });

function diagnosticKind(run) {
  if (run.status === "FAILED" || String(run.status).startsWith("BLOCKED_")) return "error";
  if (run.status === "WAITING_USER_RULES" || String(run.status).includes("REPASS") || String(run.status).includes("REVIEW")) return "warn";
  return "";
}

function diagnosticStatusLabel(run) {
  if (run.status === "WAITING_USER_RULES") return "Требуется решение по правилам";
  if (run.status === "FAILED") return "Ошибка";
  if (String(run.status).includes("REPASS")) return "Требуется следующий этап проверки";
  if (String(run.status).startsWith("BLOCKED_")) return "Остановлено безопасно";
  return run.status;
}

function diagnosticTime(value) {
  if (!value) return "";
  try { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

async function loadDiagnosticRuns() {
  const list = document.getElementById("diagnosticsList");
  if (!list) return;
  try {
    const response = await fetch("/api/runs");
    const runs = await response.json();
    if (!response.ok) throw new Error("Не удалось загрузить журнал");
    const orderedRuns = [...(Array.isArray(runs) ? runs : [])].sort((left, right) => {
      const leftTime = Date.parse(left?.started_at || "");
      const rightTime = Date.parse(right?.started_at || "");
      const timeDelta = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      return timeDelta || String(right?.id || "").localeCompare(String(left?.id || ""));
    });
    diagnosticUI.latestRunId = orderedRuns[0]?.id || "";
    const relevant = orderedRuns.filter((run) => diagnosticKind(run));
    list.replaceChildren();
    if (!relevant.length) {
      list.className = "list empty";
      list.textContent = "Ошибок и ожидающих решений пока нет. Локальный журнал действий уже ведётся.";
      return;
    }
    list.className = "list";
    for (const run of relevant) {
      const item = document.createElement("div");
      item.className = `diagnostic-item ${diagnosticKind(run)}`;
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = run.message || diagnosticStatusLabel(run);
      const meta = document.createElement("div");
      meta.className = "list-meta";
      meta.textContent = `${run.stage} · ${run.status} · ${diagnosticTime(run.started_at)}`;
      body.append(title, meta);
      const action = document.createElement("button");
      action.type = "button";
      action.className = "secondary compact-button";
      action.textContent = "Скачать диагностику запуска";
      action.addEventListener("click", () => downloadRunDiagnostics(run.id));
      item.append(body, action);
      list.append(item);
    }
  } catch (error) {
    list.className = "list empty";
    list.textContent = `${error.message}. Локальный журнал действий всё равно можно выгрузить.`;
  }
}

async function downloadRunDiagnostics(runId) {
  const status = document.getElementById("diagnosticsStatus");
  status.textContent = "Формируем подробный журнал запуска…";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/diagnostics`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Не удалось выгрузить диагностику запуска");
    }
    const blob = await response.blob();
    downloadBlob(blob, `OPIU_DIAGNOSTICS_${runId}.json`);
    status.textContent = "Диагностика запуска скачана.";
  } catch (error) {
    pushDiagnosticEvent("diagnostics.run_download_failed", { run_id: runId, message: error.message }, "error");
    status.textContent = `${error.message}. Можно выгрузить локальные ошибки и журнал действий.`;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function localDiagnosticPayload(kind) {
  const events = kind === "errors"
    ? diagnosticUI.events.filter((event) => event.level === "error" || event.level === "warn")
    : diagnosticUI.events;
  return {
    schema_version: "opiu-stable-browser-journal.v1",
    generated_at: new Date().toISOString(),
    service: "OPIU_STABLE 1.9.4",
    export_kind: kind,
    page: location.href,
    online: navigator.onLine,
    latest_run_id: diagnosticUI.latestRunId || null,
    safety: { mode: "REPORT_ONLY", posting_rows: 0, live_1c_allowed: false },
    note: "Журнал браузера. Значения текстовых полей и содержимое файлов не записываются.",
    events,
  };
}

function downloadLocalJournal(kind) {
  const payload = localDiagnosticPayload(kind);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = kind === "errors" ? `OPIU_ERRORS_${stamp}.json` : `OPIU_ACTION_JOURNAL_${stamp}.json`;
  downloadBlob(blob, filename);
  const status = document.getElementById("diagnosticsStatus");
  status.textContent = kind === "errors" ? "Ошибки скачаны." : "Журнал действий скачан.";
}

document.getElementById("downloadLatestDiagnostics")?.addEventListener("click", () => downloadLocalJournal("errors"));
document.getElementById("downloadActionJournal")?.addEventListener("click", () => downloadLocalJournal("actions"));

loadDiagnosticRuns();
setInterval(loadDiagnosticRuns, 3000);
