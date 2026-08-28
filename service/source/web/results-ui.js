(() => {
  const resultCache = new Map();
  const resultInflight = new Map();

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

  function stageResultPresentation(stage, result) {
    if (result?.ready && result?.files?.length) {
      return { ready: true, badge: "Готово", note: "" };
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

  function stageBox(stage, result) {
    const box = document.createElement("div");
    box.className = "run-result-box";

    const presentation = stageResultPresentation(stage, result);

    const heading = document.createElement("div");
    heading.className = "run-result-heading";
    const title = document.createElement("strong");
    title.textContent = labels[stage].title;
    const badge = document.createElement("span");
    badge.className = `status ${presentation.ready ? "good" : ""}`.trim();
    badge.textContent = presentation.badge;
    heading.append(title, badge);
    box.append(heading);

    if (!presentation.ready && !presentation.diagnostic) {
      const empty = document.createElement("span");
      empty.className = "list-meta";
      empty.textContent = presentation.note;
      box.append(empty);
      return box;
    }

    const visibleFiles = presentation.diagnostic ? diagnosticResultFiles(result.files) : result.files;
    const actions = document.createElement("div");
    actions.className = "run-result-actions";
    if (presentation.ready && stage === "r001" && result.archive_url) actions.append(makeArchiveButton(result));
    else for (const file of visibleFiles) actions.append(makeButton(file, stage));
    box.append(actions);

    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = presentation.diagnostic
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
      const cached = resultCache.get(run.id);
      let results;
      if (cached?.status === (run.status || "")) {
        results = cached.results;
      } else {
        let request = resultInflight.get(run.id);
        if (!request) {
          request = Promise.all([
            api(`/api/runs/${encodeURIComponent(run.id)}/result/r005`),
            api(`/api/runs/${encodeURIComponent(run.id)}/result/r001`),
          ]).finally(() => resultInflight.delete(run.id));
          resultInflight.set(run.id, request);
        }
        results = await request;
        resultCache.set(run.id, { status: run.status || "", results });
      }
      const [r005, r001] = results;
      const boxes = [stageBox("r005", r005), stageBox("r001", r001)];
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
    if (item.querySelector(".run-result-loader")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary compact-button run-result-loader";
    button.textContent = "Показать результаты";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Открываем результаты…";
      await loadForItem(item, run);
      button.disabled = false;
      button.textContent = "Обновить результаты";
    });
    item.append(button);
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
      addResultLoader(item, run);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      diagnosticResultFiles,
      stageBox,
      stageResultPresentation,
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
