(() => {
  const loaded = new Set();
  const ruleDecisionValues = ["MANUAL_REVIEW", "ACCEPT_DIFFERENCE", "REJECTED", "CONFIRMED"];
  const actionableRuleDecisions = new Set(["ACCEPT_DIFFERENCE", "REJECTED", "CONFIRMED"]);

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

  function stageResultPresentation(stage, result, run, rules) {
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
    if (stage === "r001" && rules?.next_action === "RERUN_R005") {
      return {
        ready: false,
        badge: "Не запускался",
        note: "R001 не запускался: сначала требуется повторная сверка R005.",
      };
    }
    if (stage === "r001" && run?.status === "COMPLETED_REPORT_ONLY" && rules?.next_action === "PASS_TO_R001") {
      return {
        ready: false,
        badge: "Неполный результат",
        note: "Отчётный маршрут завершён без полного комплекта R001.",
      };
    }
    return {
      ready: false,
      badge: "Нет результата",
      note: stage === "r001" ? "R001 ещё не готов" : "Сверка ещё не готова",
    };
  }

  function stageBox(stage, result, run, rules) {
    const box = document.createElement("div");
    box.className = "run-result-box";

    const presentation = stageResultPresentation(stage, result, run, rules);

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

  function businessText(value) {
    return String(value ?? "").trim();
  }

  function nested(value, ...keys) {
    let current = value;
    for (const key of keys) {
      if (!current || typeof current !== "object") return "";
      current = current[key];
    }
    return businessText(current);
  }

  function markRulesReviewDirty(control) {
    const box = control?.closest?.(".rules-review-box");
    if (box) box.dataset.dirty = "true";
  }

  function selectCandidateAfterDecision(control) {
    const checkbox = control?.closest?.(".rules-review-row")?.querySelector?.(".rules-review-choice");
    if (checkbox) checkbox.checked = true;
    markRulesReviewDirty(control);
  }

  function candidateTitle(candidate) {
    const left = nested(candidate, "intalev", "article_name") || nested(candidate, "intalev", "article_code") || "Инталев";
    const right = nested(candidate, "erp", "article_name") || nested(candidate, "erp", "article_code") || "ERP";
    return `${left} → ${right}`;
  }

  function candidateMeta(candidate) {
    const parts = [];
    const impact = businessText(candidate.impact_class);
    const action = nested(candidate, "action", "action_type");
    const scoreRaw = Number(candidate?.confidence?.score);
    if (impact) parts.push(impact);
    if (action) parts.push(action);
    if (Number.isFinite(scoreRaw)) parts.push(`уверенность ${(scoreRaw * 100).toFixed(0)}%`);
    return parts.join(" · ");
  }

  function decisionLabel(value) {
    return ({
      MANUAL_REVIEW: "СПОРНО / ручная проверка",
      ACCEPT_DIFFERENCE: "Принять расхождение",
      REJECTED: "Отклонить предложение",
      CONFIRMED: "Подтвердить правило",
    })[value] || value;
  }

  function makeDecisionSelect(candidate) {
    const select = document.createElement("select");
    select.className = "rules-review-decision";
    select.dataset.candidateId = businessText(candidate.candidate_id);
    for (const value of ruleDecisionValues) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = decisionLabel(value);
      select.append(option);
    }
    const current = businessText(candidate.user_status).toUpperCase();
    if (["ACCEPT_DIFFERENCE", "REJECTED", "CONFIRMED"].includes(current)) select.value = current;
    else select.value = "MANUAL_REVIEW";
    select.addEventListener("change", () => selectCandidateAfterDecision(select));
    return select;
  }

  function makeCandidateRow(candidate) {
    const row = document.createElement("div");
    row.className = "list-item rules-review-row";
    row.style.gap = "8px";

    const head = document.createElement("div");
    head.className = "list-row";
    const left = document.createElement("label");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "8px";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "rules-review-choice";
    checkbox.dataset.candidateId = businessText(candidate.candidate_id);
    checkbox.addEventListener("change", () => markRulesReviewDirty(checkbox));
    const title = document.createElement("strong");
    title.textContent = candidateTitle(candidate);
    left.append(checkbox, title);
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = businessText(candidate.user_status) || "PENDING_REVIEW";
    head.append(left, status);
    row.append(head);

    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = candidateMeta(candidate);
    row.append(meta);

    const explanation = nested(candidate, "evidence", "explanation");
    if (explanation) {
      const note = document.createElement("span");
      note.className = "list-meta";
      note.textContent = explanation;
      row.append(note);
    }

    row.append(makeDecisionSelect(candidate));
    return row;
  }

  function makeCandidateSummaryRow(candidate) {
    const row = document.createElement("div");
    row.className = "list-item rules-review-row";
    const head = document.createElement("div");
    head.className = "list-row";
    const title = document.createElement("strong");
    title.textContent = candidateTitle(candidate);
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = businessText(candidate.user_status) || "PENDING_REVIEW";
    head.append(title, status);
    row.append(head);
    const meta = document.createElement("span");
    meta.className = "list-meta";
    meta.textContent = candidateMeta(candidate);
    row.append(meta);
    const explanation = nested(candidate, "evidence", "explanation");
    if (explanation) {
      const note = document.createElement("span");
      note.className = "list-meta";
      note.textContent = explanation;
      row.append(note);
    }
    return row;
  }

  function rulesReviewPresentation(run, result) {
    const candidateCount = Number(result?.candidate_count ?? result?.candidates?.length ?? 0) || 0;
    const pendingCount = Number(result?.pending_review_count ?? 0) || 0;
    const registryPersistedCount = Number(result?.registry_persisted_count ?? 0) || 0;
    const registryPersisted = result?.registry_persisted === true && registryPersistedCount > 0;
    const canReview = run?.status === "WAITING_USER_RULES"
      && result?.next_action === "WAIT_USER_RULES"
      && pendingCount > 0;
    let badge = `${candidateCount} предложений`;
    let note = "Предложения сохранены в отчётном маршруте.";
    let reason = (result?.reasons || []).join(" ") || "Требуется решение пользователя перед продолжением R001.";
    if (canReview) {
      badge = pendingCount === 1 ? "1 к решению" : `${pendingCount} к решению`;
      note = "Выберите явное решение для строк, которые готовы отправить.";
    } else if (run?.status === "RUNNING") {
      if (registryPersisted) {
        badge = registryPersistedCount === 1 ? "1 правило сохранено" : `Сохранено правил: ${registryPersistedCount}`;
        note = registryPersistedCount === 1
          ? "Правило подтверждено и сохранено в библиотеке правил. Сервис формирует итоговый R001; повторное применение не требуется."
          : `Подтверждённые правила сохранены в библиотеке: ${registryPersistedCount}. Сервис формирует итоговый R001; повторное применение не требуется.`;
      } else {
        badge = "Решения обрабатываются";
        note = "Решения приняты в обработку. Сервис проверяет их и продолжает отчётный маршрут; повторное применение не требуется.";
      }
      reason = note;
    } else if (registryPersisted) {
      badge = registryPersistedCount === 1 ? "1 правило сохранено" : `Сохранено правил: ${registryPersistedCount}`;
      if (["PASS_TO_R001", "RERUN_R001"].includes(result?.next_action) && run?.status === "COMPLETED_REPORT_ONLY") {
        note = registryPersistedCount === 1
          ? "Правило подтверждено и сохранено в библиотеке правил. Повторная отправка не требуется."
          : `Подтверждённые правила сохранены в библиотеке: ${registryPersistedCount}. Повторная отправка не требуется.`;
      } else if (result?.next_action === "RERUN_R005") {
        note = "Правила сохранены в библиотеке. Для продолжения отчётного маршрута требуется повторная сверка R005.";
      } else {
        note = "Правила подтверждены и сохранены в библиотеке; повторная отправка не требуется.";
      }
      reason = note;
    } else if (pendingCount === 0 && candidateCount > 0) {
      badge = candidateCount === 1 ? "1 решение сохранено" : `${candidateCount} решений сохранено`;
      note = result?.next_action === "RERUN_R005"
        ? "Решения сохранены. Требуется продолжение отчётного маршрута через повторную сверку R005."
        : "Решения сохранены; повторная отправка не требуется.";
    } else if (pendingCount > 0) {
      badge = pendingCount === 1 ? "1 спорное предложение" : `${pendingCount} спорных предложений`;
      note = "Спорные предложения переданы дальше только как неисполняемые черновики; повторная отправка здесь не требуется.";
    }
    return { candidateCount, pendingCount, registryPersisted, registryPersistedCount, canReview, badge, note, reason };
  }

  function decisionSelectFor(box, candidateId) {
    return [...box.querySelectorAll(".rules-review-decision")].find((item) => item.dataset.candidateId === candidateId);
  }

  function collectSelectedRuleDecisions(box) {
    const selected = [...box.querySelectorAll(".rules-review-choice:checked")];
    const decisions = selected.map((checkbox) => {
      const candidateId = checkbox.dataset.candidateId || "";
      const select = decisionSelectFor(box, candidateId);
      return {
        candidate_id: candidateId,
        decision: select?.value || "MANUAL_REVIEW",
        comment: "Решение принято в интерфейсе OPIU_STABLE",
      };
    });
    return { selected, decisions };
  }

  function assignBulkRuleDecision(box, decision) {
    if (!actionableRuleDecisions.has(decision)) return 0;
    const selected = [...box.querySelectorAll(".rules-review-choice:checked")];
    let changed = 0;
    for (const checkbox of selected) {
      const select = decisionSelectFor(box, checkbox.dataset.candidateId || "");
      if (!select) continue;
      select.value = decision;
      changed += 1;
    }
    if (changed) box.dataset.dirty = "true";
    return changed;
  }

  async function applyRuleDecisions(run, box, request) {
    const { selected, decisions } = collectSelectedRuleDecisions(box);
    if (!selected.length) {
      const status = box.querySelector(".rules-review-status");
      if (status) status.textContent = "Отметьте предложения, по которым принимаете решение.";
      return;
    }
    const button = box.querySelector(".rules-review-apply");
    const status = box.querySelector(".rules-review-status");
    const unresolved = decisions.filter((item) => item.decision === "MANUAL_REVIEW");
    if (unresolved.length) {
      if (status) {
        status.textContent = `Решения не отправлены: у ${unresolved.length} выбранных строк осталось «СПОРНО / ручная проверка». Выберите для них решение массово или построчно. Отметки сохранены.`;
      }
      return;
    }
    if (button) button.disabled = true;
    if (status) status.textContent = "Сохраняем решения и продолжаем отчётный маршрут…";
    try {
      const send = request || api;
      await send(`/api/runs/${encodeURIComponent(run.id)}/result/rules`, {
        method: "POST",
        body: JSON.stringify({ author: "Пользователь", decisions }),
      });
      box.dataset.dirty = "false";
      if (status) status.textContent = "Решения приняты в обработку. Сервис проверяет их и продолжает отчётный маршрут; повторное применение не требуется.";
      loaded.delete(run.id);
      if (!request) setTimeout(() => refresh(), 250);
    } catch (error) {
      if (button) button.disabled = false;
      if (status) status.textContent = `Не удалось применить решения: ${error.message}`;
    }
  }

  function rulesReviewBox(run, result) {
    const box = document.createElement("div");
    box.className = "run-result-box rules-review-box";
    box.dataset.rulesRunId = run.id;
    box.dataset.dirty = "false";

    const heading = document.createElement("div");
    heading.className = "run-result-heading";
    const title = document.createElement("strong");
    title.textContent = "Предложения правил";
    const badge = document.createElement("span");
    badge.className = `status ${result.ready ? "good" : ""}`.trim();
    const presentation = rulesReviewPresentation(run, result);
    badge.textContent = result.ready ? presentation.badge : "Готовятся";
    heading.append(title, badge);
    box.append(heading);

    if (!result.ready) {
      const empty = document.createElement("span");
      empty.className = "list-meta";
      empty.textContent = "Движок правил ещё готовит список предложений. Обновление произойдёт автоматически.";
      box.append(empty);
      return box;
    }

    const reason = document.createElement("span");
    reason.className = "list-meta";
    reason.textContent = presentation.reason;
    box.append(reason);

    if (!presentation.canReview) {
      const list = document.createElement("div");
      list.className = "list";
      for (const candidate of result.candidates || []) list.append(makeCandidateSummaryRow(candidate));
      box.append(list);
      const status = document.createElement("span");
      status.className = "list-meta rules-review-status";
      status.textContent = presentation.note;
      box.append(status);
      return box;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "run-result-actions";
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "secondary";
    selectAll.textContent = "Выбрать все";
    selectAll.addEventListener("click", () => {
      for (const checkbox of box.querySelectorAll(".rules-review-choice")) checkbox.checked = true;
      box.dataset.dirty = "true";
    });
    const clearAll = document.createElement("button");
    clearAll.type = "button";
    clearAll.className = "secondary";
    clearAll.textContent = "Снять выбор";
    clearAll.addEventListener("click", () => {
      for (const checkbox of box.querySelectorAll(".rules-review-choice")) checkbox.checked = false;
      box.dataset.dirty = "true";
    });
    const bulkDecision = document.createElement("select");
    bulkDecision.className = "rules-review-bulk-decision";
    bulkDecision.setAttribute("aria-label", "Общее решение для выбранных предложений");
    const bulkPlaceholder = document.createElement("option");
    bulkPlaceholder.value = "";
    bulkPlaceholder.textContent = "Решение для выбранных…";
    bulkDecision.append(bulkPlaceholder);
    for (const value of actionableRuleDecisions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = decisionLabel(value);
      bulkDecision.append(option);
    }
    const assignBulk = document.createElement("button");
    assignBulk.type = "button";
    assignBulk.className = "secondary";
    assignBulk.textContent = "Назначить выбранным";
    assignBulk.addEventListener("click", () => {
      const status = box.querySelector(".rules-review-status");
      const selectedCount = box.querySelectorAll(".rules-review-choice:checked").length;
      if (!selectedCount) {
        if (status) status.textContent = "Сначала отметьте предложения, которым нужно назначить общее решение.";
        return;
      }
      if (!bulkDecision.value) {
        if (status) status.textContent = "Выберите явное решение для отмеченных предложений.";
        return;
      }
      const changed = assignBulkRuleDecision(box, bulkDecision.value);
      if (status) {
        status.textContent = `${decisionLabel(bulkDecision.value)} назначено строкам: ${changed}. Проверьте решения и нажмите «Применить выбранные решения».`;
      }
    });
    toolbar.append(selectAll, clearAll, bulkDecision, assignBulk);
    box.append(toolbar);

    const list = document.createElement("div");
    list.className = "list";
    for (const candidate of result.candidates || []) list.append(makeCandidateRow(candidate));
    box.append(list);

    const actions = document.createElement("div");
    actions.className = "run-result-actions";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary rules-review-apply";
    apply.textContent = "Применить выбранные решения";
    apply.disabled = false;
    apply.addEventListener("click", () => applyRuleDecisions(run, box));
    const status = document.createElement("span");
    status.className = "list-meta rules-review-status";
    status.textContent = "Выбор удерживается на экране до отправки. Нажмите «Применить выбранные решения»; допустимость продолжения проверит сервис.";
    actions.append(apply, status);
    box.append(actions);
    return box;
  }

  async function loadForItem(item, run) {
    if (!item || loaded.has(run.id)) return;
    loaded.add(run.id);
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
      const [r005, r001, rules] = await Promise.all([
        api(`/api/runs/${encodeURIComponent(run.id)}/result/r005`),
        api(`/api/runs/${encodeURIComponent(run.id)}/result/r001`),
        api(`/api/runs/${encodeURIComponent(run.id)}/result/rules`),
      ]);
      const boxes = [stageBox("r005", r005, run, rules), stageBox("r001", r001, run, rules)];
      if (rules?.ready || run.status === "WAITING_USER_RULES") boxes.push(rulesReviewBox(run, rules));
      holder.replaceChildren(...boxes);
    } catch (error) {
      loaded.delete(run.id);
      holder.replaceChildren();
      const failed = document.createElement("span");
      failed.className = "list-meta";
      failed.textContent = `Результаты недоступны: ${error.message}`;
      holder.append(failed);
    }
  }

  function syncResults() {
    const runs = state.snapshot?.runs || [];
    const list = byId("runsList");
    if (!list || !runs.length) return;
    const items = [...list.querySelectorAll(":scope > .list-item")];
    runs.forEach((run, index) => {
      if (!items[index]) return;
      const existing = items[index].querySelector(`.run-results[data-run-id="${run.id}"]`);
      if (existing && existing.dataset.runStatus === (run.status || "")) return;
      if (existing) existing.remove();
      loaded.delete(run.id);
      loadForItem(items[index], run);
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      applyRuleDecisions,
      assignBulkRuleDecision,
      collectSelectedRuleDecisions,
      diagnosticResultFiles,
      rulesReviewPresentation,
      selectCandidateAfterDecision,
      stageBox,
      stageResultPresentation,
    };
    return;
  }

  const observer = new MutationObserver(() => {
    for (const id of [...loaded]) {
      if (!document.querySelector(`.run-results[data-run-id="${id}"]`)) loaded.delete(id);
    }
    syncResults();
  });

  window.addEventListener("DOMContentLoaded", () => {
    const list = byId("runsList");
    if (list) observer.observe(list, { childList: true });
    syncResults();
  });
})();
