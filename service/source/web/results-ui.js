(() => {
  const resultCache = new Map();
  const resultInflight = new Map();
  const expandedRunIds = new Set();

  function resultStateKey(run) {
    return `${run.id}\u0000${run.status || ""}`;
  }

  const labels = {
    r005: {
      title: "Сверка R005",
      reconciliation: "R005.xlsx",
      details: "Детали",
      manifest: "Manifest",
      file: "Файл R005",
    },
    r001: {
      title: "Результат R001",
      diagnostics: "Ошибки и причины",
      journal: "Журнал действий",
      registry: "Реестр файлов",
      manifest: "Паспорт пакета",
      file: "Файл R001",
    },
  };

  function diagnosticResultFiles(files) {
    return (files || []).filter((file) => {
      const name = String(file?.name || "").replaceAll("\\", "/").toLowerCase();
      return name.startsWith("service-report-package/technical/");
    });
  }

  function makeButton(file, stage) {
    const a = document.createElement("a");
    a.className = file.kind === "reconciliation" || file.kind === "decisions" ? "primary result-download" : "secondary result-download";
    a.href = file.url;
    a.textContent = labels[stage][file.kind] || labels[stage].file;
    a.setAttribute("download", "");
    a.title = file.name;
    return a;
  }

  function makeArchiveButton(result) {
    const a = document.createElement("a");
    a.className = "primary result-download";
    a.href = result.archive_url;
    a.textContent = "Скачать R001.zip";
    a.setAttribute("download", "R001.zip");
    a.title = "Все файлы R001 одним архивом";
    return a;
  }

  function makeRunDiagnosticsButton(run) {
    const a = document.createElement("a");
    a.className = "secondary result-download";
    a.href = `/api/runs/${encodeURIComponent(run.id)}/diagnostics`;
    a.textContent = "Скачать диагностику запуска";
    a.setAttribute("download", "");
    a.title = "Точная причина остановки и технический журнал запуска";
    return a;
  }

  function terminalDownstreamR001Failure(run) {
    const status = String(run?.status || "");
    const stage = String(run?.stage || "").toUpperCase();
    const retainedR005 = Boolean(run?.has_structural_inventory || run?.retained_r005_ready);
    return status === "FAILED" && (stage.startsWith("R001") || (stage === "INTERRUPTED_SERVICE_RESTART" && retainedR005));
  }

  function r001FailureNote(run) {
    const reason = String(run?.message || "").trim();
    if (!reason) return "R001 не сформирован: точная причина сохранена в диагностике запуска.";
    return /^R001\s+не\s+сформирован\s*:/i.test(reason) ? reason : `R001 не сформирован: ${reason}`;
  }

  function stageResultPresentation(stage, result, run) {
    if (result?.ready && result?.files?.length) {
      return { ready: true, badge: "Готово", note: "" };
    }
    if (stage === "r001" && terminalDownstreamR001Failure(run)) {
      return {
        ready: false,
        failed: true,
        diagnostic: Boolean(result?.verified_package_available && diagnosticResultFiles(result?.files).length),
        badge: "Не сформирован",
        note: r001FailureNote(run),
      };
    }
    if (stage === "r001" && result?.verified_package_available && diagnosticResultFiles(result?.files).length) {
      return {
        ready: false,
        diagnostic: true,
        badge: "Диагностика доступна",
        note: "Проверенные журналы доступны для скачивания. Финальный комплект R001 не готов и не разрешён к загрузке.",
      };
    }
    return {
      ready: false,
      badge: "Нет результата",
      note: stage === "r001" ? "R001 ещё не готов" : "Сверка ещё не готова",
    };
  }

  function stageBox(stage, result, run) {
    const box = document.createElement("div");
    box.className = "run-result-box";

    const presentation = stageResultPresentation(stage, result, run);

    const heading = document.createElement("div");
    heading.className = "run-result-heading";
    const title = document.createElement("strong");
    title.textContent = labels[stage].title;
    const badge = document.createElement("span");
    badge.className = `status ${presentation.ready ? "good" : ""}`.trim();
    badge.textContent = presentation.badge;
    heading.append(title, badge);
    box.append(heading);

    if (!presentation.ready && !presentation.diagnostic && !presentation.failed) {
      const empty = document.createElement("span");
      empty.className = "list-meta";
      empty.textContent = presentation.note;
      box.append(empty);
      return box;
    }

    if (presentation.failed) {
      const failure = document.createElement("span");
      failure.className = "list-meta";
      failure.textContent = presentation.note;
      box.append(failure);
    }

    const visibleFiles = presentation.failed
      ? (presentation.diagnostic ? diagnosticResultFiles(result?.files) : [])
      : presentation.diagnostic ? diagnosticResultFiles(result?.files) : (result?.files || []);
    const actions = document.createElement("div");
    actions.className = "run-result-actions";
    if (presentation.ready && stage === "r001" && result.archive_url) actions.append(makeArchiveButton(result));
    for (const file of visibleFiles) actions.append(makeButton(file, stage));
    if (presentation.failed && run?.id) actions.append(makeRunDiagnosticsButton(run));
    box.append(actions);

    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = presentation.failed
      ? `R001 готов к загрузке: нет. Проверенных диагностических файлов: ${visibleFiles.length}.`
      : presentation.diagnostic
      ? `Проверенных диагностических файлов: ${visibleFiles.length}. Готовность к загрузке: нет.`
      : stage === "r001" ? `В архиве: ${result.files.length} файлов` : `Файлов: ${result.files.length}`;
    box.append(meta);
    return box;
  }

  async function loadForItem(item, run) {
    if (!item) return;
    const existing = item.querySelector(".run-results");
    if (existing?.dataset.runId === run.id && existing?.dataset.runStatus === (run.status || "")) return;
    if (existing) existing.remove();
    const holder = document.createElement("div");
    holder.className = "run-results";
    holder.dataset.runId = run.id;
    holder.dataset.runStatus = run.status || "";
    const pending = document.createElement("span");
    pending.className = "list-meta";
    pending.textContent = "Загружаем результаты…";
    holder.append(pending);
    item.append(holder);
    try {
      const stateKey = resultStateKey(run);
      const cached = resultCache.get(stateKey);
      let results;
      if (cached) {
        results = cached;
      } else {
        let request = resultInflight.get(stateKey);
        if (!request) {
          request = Promise.all([
            api(`/api/runs/${encodeURIComponent(run.id)}/result/r005`),
            api(`/api/runs/${encodeURIComponent(run.id)}/result/r001`),
          ]).finally(() => resultInflight.delete(stateKey));
          resultInflight.set(stateKey, request);
        }
        results = await request;
        resultCache.set(stateKey, results);
      }
      const [r005, r001] = results;
      const downstreamRun = { ...run, retained_r005_ready: Boolean(r005?.ready) };
      const boxes = [stageBox("r005", r005, run), stageBox("r001", r001, downstreamRun)];
      holder.replaceChildren(...boxes);
    } catch (error) {
      holder.replaceChildren();
      const failed = document.createElement("span");
      failed.className = "list-meta";
      failed.textContent = `Результаты недоступны: ${error.message}`;
      holder.append(failed);
    }
  }

  function addResultLoader(item, run) {
    const existing = item.querySelector(".run-result-loader");
    if (existing) return existing;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary compact-button run-result-loader";
    button.textContent = "Показать результаты";
    button.addEventListener("click", async () => {
      expandedRunIds.add(run.id);
      button.disabled = true;
      button.textContent = "Открываем результаты…";
      await loadForItem(item, run);
      button.disabled = false;
      button.textContent = "Обновить результаты";
    });
    item.append(button);
    return button;
  }

  function syncResults(runs = state.snapshot?.runs || []) {
    const list = byId("runsList");
    if (!list || !runs.length) return;
    const items = [...list.querySelectorAll(":scope > .list-item")];
    const runsById = new Map(runs.map((run) => [String(run.id || ""), run]));
    for (const item of items) {
      const run = runsById.get(item.dataset.runId || "");
      if (!run) continue;
      const existing = item.querySelector(".run-results");
      if (existing && existing.dataset.runStatus !== (run.status || "")) existing.remove();
      const button = addResultLoader(item, run);
      if (!expandedRunIds.has(run.id)) continue;
      button.disabled = true;
      button.textContent = "Открываем результаты…";
      void loadForItem(item, run).finally(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.textContent = "Обновить результаты";
      });
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      diagnosticResultFiles,
      stageBox,
      stageResultPresentation,
      __test: {
        addResultLoader,
        expandedRunIds,
        loadForItem,
        resultCache,
        resultInflight,
        resultStateKey,
        syncResults,
      },
    };
    return;
  }

  window.addEventListener("opiu:bootstrap-updated", (event) => {
    syncResults(event.detail?.runs || []);
  });

  window.addEventListener("DOMContentLoaded", () => {
    syncResults();
  });
})();
