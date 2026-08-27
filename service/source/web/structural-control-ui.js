const structuralState = {
  registryRevision: 0,
  organizationId: "",
	expectedOrganizationId: "",
	contextId: "",
	expectedContextId: "",
  runId: "",
  inventoryId: "",
  payload: null,
  currentDraftId: "",
  selectedControlSetId: "",
  editSourceControlSetId: "",
  editLineageId: "",
  declarationRequired: false,
  loadGeneration: 0,
  previewGeneration: 0,
};

function requireStructuralReportOnly(payload) {
  const safety = payload?.safety;
  if (!safety || safety.mode !== "REPORT_ONLY" || safety.report_only !== true ||
      safety.posting_rows !== 0 || safety.executed_posting_rows !== 0 ||
      safety.live_posting_rows !== 0 || safety.execution_allowed !== false ||
      safety.ready_to_upload !== false || safety.release_allowed !== false ||
      safety.live_1c_allowed !== false || safety.live_delete_allowed !== false) {
    throw new Error("Настройки групп остановлены: безопасный отчётный режим не подтверждён");
  }
}

function structuralCents(value) {
  if (!Number.isSafeInteger(Number(value))) return "—";
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) / 100);
}

function renderStructuralRunOptions(snapshot) {
  const select = byId("structural-run");
  if (!select) return;
  const previous = select.value;
  const runs = [...(snapshot.runs || [])].filter((run) => run.has_structural_inventory === true && (run.status === "COMPLETED_REPORT_ONLY" || run.status === "WAITING_USER_RULES"));
	const contexts = new Map((snapshot.contexts || []).map((context) => [context.id, context]));
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = runs.length ? "Выберите завершённый запуск" : "Завершённых запусков пока нет";
  select.append(empty);
  for (const run of runs) {
    const option = document.createElement("option");
    option.value = run.id;
	const context = contexts.get(run.context_id);
	option.dataset.contextId = run.context_id || "";
	option.dataset.organizationId = context?.organization_id || "";
    option.textContent = `${run.message || "Отчётный запуск"} · ${formatTime(run.started_at)}`;
    select.append(option);
  }
  if (runs.some((run) => run.id === previous)) select.value = previous;
  else if (runs.some((run) => run.id === structuralState.runId)) select.value = structuralState.runId;
	else if (structuralState.runId) {
		resetStructuralControlEditorState("");
		setStructuralInventoryStatus("Запуск больше не доступен для настройки");
	}
}

function selectedStructuralIdentities(side) {
  return [...document.querySelectorAll(`#structural-${side}-inventory input[type="checkbox"]:checked`)]
    .map((input) => ({ identity: input.value }));
}

function structuralSelectionPayload() {
  return {
    name: byId("structural-set-name").value.trim(),
    organization_id: structuralState.organizationId,
    run_id: structuralState.runId,
    inventory_id: structuralState.inventoryId,
    mode: "SUM_DELTA_ONLY",
    expected_control_delta: 0,
    tolerance_cents: 0,
    intalev_members: selectedStructuralIdentities("intalev"),
    erp_members: selectedStructuralIdentities("erp"),
    expected_registry_revision: structuralState.registryRevision,
    source_control_set_id: structuralState.editSourceControlSetId || undefined,
    lineage_id: structuralState.editLineageId || undefined,
    control_only_declaration: byId("structural-control-declaration").checked,
  };
}

function updateStructuralDeclarationActions() {
  const declaration = byId("structural-control-declaration");
  const accepted = !structuralState.declarationRequired || declaration.checked;
  byId("structural-save-draft").disabled = !accepted;
  byId("structural-fix-version").disabled = !structuralState.currentDraftId || !accepted;
}

function setStructuralInventoryStatus(text, kind = "") {
  const pill = byId("structural-inventory-status");
  pill.textContent = text;
  pill.className = `pill ${kind}`.trim();
}

function renderStructuralMembers(side, members, selected = [], readOnly = false) {
  const root = byId(`structural-${side}-inventory`);
  root.replaceChildren();
  const selectedIds = new Set(selected.map((member) => member.identity));
  if (!members.length) {
    root.className = "structural-member-list empty";
    root.textContent = "Проверенные верхние блоки отсутствуют";
    return;
  }
  root.className = "structural-member-list";
  for (const member of members) {
    const label = document.createElement("label");
    label.className = "structural-member";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = member.identity;
    checkbox.checked = selectedIds.has(member.identity);
	checkbox.disabled = readOnly;
    checkbox.addEventListener("change", previewStructuralControlSet);
    const copy = document.createElement("span");
    copy.className = "structural-member-copy";
    const title = document.createElement("strong");
    title.textContent = `${member.code || "Без кода"} · ${member.name}`;
    const path = document.createElement("small");
    path.textContent = member.hierarchy_path || "Верхний уровень";
    copy.append(title, path);
    if (member.semantic_status === "BUSINESS_BLOCK_UNPROVEN") {
      const semantic = document.createElement("small");
      semantic.textContent = "Кандидат — блок объявляет пользователь";
      copy.append(semantic);
    }
    const amount = document.createElement("span");
    amount.className = "structural-member-amount";
    amount.textContent = structuralCents(member.amount_cents);
    label.append(checkbox, copy, amount);
    root.append(label);
  }
}

function renderStructuralControlSets(payload, selectedIntalev = [], selectedERP = []) {
  requireStructuralReportOnly(payload);
  structuralState.payload = payload;
  structuralState.registryRevision = Number(payload.registry_revision || 0);
  structuralState.organizationId = payload.organization?.id || "";
	structuralState.contextId = payload.context_id || "";
  structuralState.runId = payload.run_id || structuralState.runId;
  structuralState.inventoryId = payload.inventory_id || "";
  structuralState.declarationRequired = payload.user_declaration_required === true;

  const organization = byId("structural-organization");
  organization.replaceChildren();
  const option = document.createElement("option");
  option.value = structuralState.organizationId;
  option.textContent = payload.organization?.name || "Организация не подтверждена";
  organization.append(option);
  setStructuralInventoryStatus(payload.inventory_status === "VERIFIED" ? "Инвентарь проверен" : "Инвентарь не проверен", payload.inventory_status === "VERIFIED" ? "good" : "");

  const list = byId("structural-control-set-list");
  list.replaceChildren();
  const versions = payload.versions || [];
  const drafts = payload.drafts || [];
	const selectedVersion = versions.find((version) => version.control_set_id === structuralState.selectedControlSetId);
	const selectedDraft = drafts.find((draft) => draft.draft_id === structuralState.currentDraftId);
	const selectedVersionExact = selectedVersion && structuralControlVersionIsExact(selectedVersion);
	const declarationWrap = byId("structural-control-declaration-wrap");
	const declaration = byId("structural-control-declaration");
	declarationWrap.hidden = !structuralState.declarationRequired;
	declaration.checked = structuralState.declarationRequired && Boolean((selectedDraft || selectedVersion)?.control_only_declared);
	declaration.disabled = Boolean(selectedVersion);
	renderStructuralMembers("intalev", payload.intalev_members || [], selectedVersion?.intalev_members || selectedDraft?.intalev_members || selectedIntalev, Boolean(selectedVersion && !selectedVersionExact));
	renderStructuralMembers("erp", payload.erp_members || [], selectedVersion?.erp_members || selectedDraft?.erp_members || selectedERP, Boolean(selectedVersion && !selectedVersionExact));
  if (!versions.length && !drafts.length) {
    list.className = "list empty";
    list.textContent = "Групп пока нет";
  } else {
    list.className = "list";
    for (const version of versions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `structural-set-button${structuralState.selectedControlSetId === version.control_set_id ? " selected" : ""}`;
      button.setAttribute("data-structural-version", String(version.version));
      button.dataset.controlSetId = version.control_set_id;
      button.setAttribute("aria-pressed", structuralState.selectedControlSetId === version.control_set_id ? "true" : "false");
      const title = document.createElement("strong");
      title.textContent = `${version.name} · версия ${version.version}`;
      const summary = document.createElement("span");
      summary.className = "structural-set-summary";
	  const exactScope = structuralControlVersionIsExact(version);
	  const controlState = version.control_status === "INTRA_CONTROL_SET_RECLASS_CLOSED"
	    ? "структурный итог закрыт"
	    : version.control_status === "INTER_GROUP_RECLASS_OPEN"
	      ? "открытый межгрупповой пересорт"
	      : "контроль не рассчитан";
	  summary.textContent = `${version.intalev_members.length} Инталев ↔ ${version.erp_members.length} ERP · дельта ${structuralCents(version.control_delta_cents)} · ${controlState} · ${exactScope ? version.status : "история, только просмотр"}`;
      button.append(title, summary);
      button.addEventListener("click", () => selectStructuralControlSet(version.control_set_id));
      list.append(button);
    }
    for (const draft of drafts) {
	  const button = document.createElement("button");
	  button.type = "button";
	  button.className = "structural-set-button";
	  button.setAttribute("data-structural-draft-id", draft.draft_id);
	  button.dataset.intalevCount = String(draft.intalev_members.length);
	  button.dataset.erpCount = String(draft.erp_members.length);
	  const exactScope = draft.run_id === structuralState.runId && draft.inventory_id === structuralState.inventoryId && draft.status !== "HISTORICAL";
	  button.disabled = !exactScope;
	  button.textContent = `${draft.name} · ${exactScope ? "черновик" : "история, только просмотр"}`;
	  button.addEventListener("click", () => selectStructuralControlDraft(draft.draft_id));
	  list.append(button);
    }
  }
	updateStructuralDeclarationActions();
	byId("structural-edit-version").disabled = !selectedVersionExact;
	byId("structural-disable-set").disabled = !selectedVersionExact || selectedVersion.status !== "FIXED";
}

async function loadStructuralControlSets(options) {
	options = options || {};
  const runId = byId("structural-run").value;
	const selectedOption = byId("structural-run").selectedOptions[0];
	const expectedContextId = selectedOption?.dataset.contextId || "";
	const expectedOrganizationId = selectedOption?.dataset.organizationId || "";
	const generation = ++structuralState.loadGeneration;
	if (options?.preserveSelection !== true) resetStructuralControlEditorState(runId);
  structuralState.runId = runId;
	structuralState.expectedContextId = expectedContextId;
	structuralState.expectedOrganizationId = expectedOrganizationId;
  if (!runId) {
    setStructuralInventoryStatus("Выберите запуск");
    return;
  }
  setStructuralInventoryStatus("Проверяем инвентарь");
  try {
    const payload = await api(`/api/structural-control-sets?run_id=${encodeURIComponent(runId)}`);
	if (generation !== structuralState.loadGeneration || byId("structural-run").value !== runId) return;
	if (payload.run_id !== runId || payload.context_id !== expectedContextId || payload.organization?.id !== expectedOrganizationId) {
	  throw new Error("Ответ настроек не совпадает с выбранным запуском");
	}
    renderStructuralControlSets(payload);
  } catch (error) {
	if (generation !== structuralState.loadGeneration) return;
    setStructuralInventoryStatus("Инвентарь недоступен");
	clearStructuralControlVisuals();
	byId("structural-preview-message").className = "notice error structural-message";
    byId("structural-preview-message").textContent = `${error.message}. Настройку нельзя фиксировать без точного проверенного инвентаря R005.`;
  }
}

async function previewStructuralControlSet() {
	const generation = ++structuralState.previewGeneration;
  const payload = structuralSelectionPayload();
  if (!payload.intalev_members.length || !payload.erp_members.length || !structuralState.inventoryId) {
    byId("structural-intalev-total").textContent = "—";
    byId("structural-erp-total").textContent = "—";
    byId("structural-control-delta").textContent = "—";
	const message = byId("structural-preview-message");
	message.className = "notice structural-message";
	message.textContent = "Выберите блоки с обеих сторон для серверной проверки.";
    return;
  }
  try {
    const preview = await api("/api/structural-control-sets/preview", { method: "POST", body: JSON.stringify(payload) });
	if (generation !== structuralState.previewGeneration) return;
    requireStructuralReportOnly(preview);
    byId("structural-intalev-total").textContent = structuralCents(preview.intalev_total_cents);
    byId("structural-erp-total").textContent = structuralCents(preview.erp_total_cents);
    byId("structural-control-delta").textContent = structuralCents(preview.control_delta_cents);
    const message = byId("structural-preview-message");
    if (preview.status === "INTRA_CONTROL_SET_RECLASS_CLOSED") {
      message.className = "notice good structural-message";
      message.textContent = "Сумма дельт равна нулю: структурный пересорт закрыт. Дочерние строки остаются на полной проверке расхождений.";
    } else if (preview.status === "INTER_GROUP_RECLASS_OPEN") {
      message.className = "notice warn structural-message";
      message.textContent = "Сумма дельт не равна нулю: остаток не закрыт, это открытый межгрупповой пересорт.";
    }
  } catch (error) {
	if (generation !== structuralState.previewGeneration) return;
    byId("structural-preview-message").className = "notice error structural-message";
    byId("structural-preview-message").textContent = error.message;
  }
}

async function saveStructuralControlDraft() {
  const payload = structuralSelectionPayload();
  if (!payload.name) {
    byId("structural-preview-message").textContent = "Укажите название группы.";
    return;
  }
  if (structuralState.declarationRequired && !payload.control_only_declaration) {
    showStructuralControlError(new Error("Подтвердите, что выбранные строки объявляются контрольными блоками только для этой сверки."));
    return;
  }
  try {
    const result = await api("/api/structural-control-sets", { method: "POST", body: JSON.stringify(payload) });
    requireStructuralReportOnly(result);
    structuralState.registryRevision = Number(result.registry_revision);
    structuralState.currentDraftId = result.draft.draft_id;
    byId("structural-fix-version").disabled = false;
	await loadStructuralControlSets({ preserveSelection: true });
  } catch (error) {
	showStructuralControlError(error);
  }
}

async function fixStructuralControlVersion() {
  if (!structuralState.currentDraftId || (structuralState.declarationRequired && !byId("structural-control-declaration").checked)) return;
  try {
    const result = await api("/api/structural-control-sets/fix", {
      method: "POST",
      body: JSON.stringify({
        draft_id: structuralState.currentDraftId,
        organization_id: structuralState.organizationId,
        run_id: structuralState.runId,
        inventory_id: structuralState.inventoryId,
        expected_registry_revision: structuralState.registryRevision,
      }),
    });
    requireStructuralReportOnly(result);
    structuralState.currentDraftId = "";
    structuralState.selectedControlSetId = result.fixed_version.control_set_id;
    structuralState.editSourceControlSetId = "";
    structuralState.editLineageId = "";
	await loadStructuralControlSets({ preserveSelection: true });
  } catch (error) {
	showStructuralControlError(error);
  }
}

function selectStructuralControlSet(controlSetId) {
  structuralState.selectedControlSetId = controlSetId;
  const version = (structuralState.payload?.versions || []).find((item) => item.control_set_id === controlSetId);
  if (!version) return;
  byId("structural-set-name").value = version.name;
	structuralState.currentDraftId = "";
	structuralState.editSourceControlSetId = "";
	structuralState.editLineageId = "";
  renderStructuralControlSets(structuralState.payload, version.intalev_members, version.erp_members);
	if (!structuralControlVersionIsExact(version)) {
		byId("structural-preview-message").className = "notice structural-message";
		byId("structural-preview-message").textContent = "Историческая версия показана только для просмотра.";
		return;
	}
  previewStructuralControlSet();
}

function structuralControlVersionIsExact(version) {
	return Boolean(version && version.organization_id === structuralState.organizationId &&
		version.context_id === structuralState.contextId && version.run_id === structuralState.runId &&
		version.inventory_id === structuralState.inventoryId && version.status === "FIXED");
}

function selectStructuralControlDraft(draftId) {
	const draft = (structuralState.payload?.drafts || []).find((item) => item.draft_id === draftId);
	if (!draft) return;
	if (draft.run_id !== structuralState.runId || draft.inventory_id !== structuralState.inventoryId || draft.status === "HISTORICAL") {
		showStructuralControlError(new Error("Исторический черновик доступен только для просмотра в своём исходном запуске."));
		return;
	}
	structuralState.currentDraftId = draft.draft_id;
	structuralState.selectedControlSetId = "";
	structuralState.editSourceControlSetId = draft.source_control_set_id || "";
	structuralState.editLineageId = draft.lineage_id || "";
	byId("structural-set-name").value = draft.name;
	renderStructuralControlSets(structuralState.payload, draft.intalev_members, draft.erp_members);
	byId("structural-fix-version").disabled = false;
	previewStructuralControlSet();
}

function editStructuralControlSet() {
  const version = (structuralState.payload?.versions || []).find((item) => item.control_set_id === structuralState.selectedControlSetId);
  if (!version) return;
  structuralState.currentDraftId = "";
  structuralState.editSourceControlSetId = version.control_set_id;
  structuralState.editLineageId = version.lineage_id;
  byId("structural-set-name").value = `${version.name} — уточнение`;
  const declaration = byId("structural-control-declaration");
  declaration.checked = false;
  declaration.disabled = false;
  updateStructuralDeclarationActions();
  byId("structural-preview-message").textContent = "Изменения будут сохранены новым черновиком и новой неизменяемой версией.";
}

async function disableStructuralControlSet() {
  if (!structuralState.selectedControlSetId) return;
	if (!window.confirm("Отключить выбранную группу? История версий будет сохранена.")) return;
	const reason = byId("structural-disable-reason").value.trim();
	if (!reason) {
		showStructuralControlError(new Error("Укажите причину отключения группы."));
		return;
	}
  try {
    const result = await api("/api/structural-control-sets/disable", {
      method: "POST",
      body: JSON.stringify({
        control_set_id: structuralState.selectedControlSetId,
        organization_id: structuralState.organizationId,
        run_id: structuralState.runId,
        inventory_id: structuralState.inventoryId,
		reason,
        expected_registry_revision: structuralState.registryRevision,
      }),
    });
    requireStructuralReportOnly(result);
    structuralState.selectedControlSetId = "";
	byId("structural-disable-reason").value = "";
	await loadStructuralControlSets({ preserveSelection: true });
  } catch (error) {
	showStructuralControlError(error);
  }
}

function resetStructuralControlEditor() {
  structuralState.currentDraftId = "";
  structuralState.selectedControlSetId = "";
  structuralState.editSourceControlSetId = "";
  structuralState.editLineageId = "";
  byId("structural-set-name").value = "";
	byId("structural-disable-reason").value = "";
	byId("structural-control-declaration").checked = false;
	byId("structural-control-declaration").disabled = false;
  renderStructuralMembers("intalev", structuralState.payload?.intalev_members || []);
  renderStructuralMembers("erp", structuralState.payload?.erp_members || []);
  byId("structural-fix-version").disabled = true;
  byId("structural-edit-version").disabled = true;
  byId("structural-disable-set").disabled = true;
  updateStructuralDeclarationActions();
  previewStructuralControlSet();
}

function clearStructuralControlVisuals() {
	const organization = byId("structural-organization");
	organization.replaceChildren();
	const organizationPlaceholder = document.createElement("option");
	organizationPlaceholder.value = "";
	organizationPlaceholder.textContent = "Определяется по запуску";
	organization.append(organizationPlaceholder);
	for (const id of ["structural-intalev-inventory", "structural-erp-inventory"]) {
		const root = byId(id);
		root.replaceChildren();
		root.className = "structural-member-list empty";
		root.textContent = "Нет проверенного инвентаря";
	}
	byId("structural-control-set-list").replaceChildren();
	byId("structural-control-set-list").textContent = "Групп пока нет";
	for (const id of ["structural-intalev-total", "structural-erp-total", "structural-control-delta"]) byId(id).textContent = "—";
	for (const id of ["structural-fix-version", "structural-edit-version", "structural-disable-set"]) byId(id).disabled = true;
	const message = byId("structural-preview-message");
	message.className = "notice structural-message";
	message.textContent = "Выберите блоки с обеих сторон для серверной проверки.";
}

function resetStructuralControlEditorState(runId) {
	structuralState.registryRevision = 0;
	structuralState.organizationId = "";
	structuralState.expectedOrganizationId = "";
	structuralState.contextId = "";
	structuralState.expectedContextId = "";
	structuralState.runId = runId;
	structuralState.inventoryId = "";
	structuralState.payload = null;
	structuralState.currentDraftId = "";
	structuralState.selectedControlSetId = "";
	structuralState.editSourceControlSetId = "";
	structuralState.editLineageId = "";
	structuralState.declarationRequired = false;
	structuralState.previewGeneration++;
	byId("structural-set-name").value = "";
	byId("structural-disable-reason").value = "";
	byId("structural-control-declaration").checked = false;
	byId("structural-control-declaration").disabled = false;
	byId("structural-control-declaration-wrap").hidden = true;
	clearStructuralControlVisuals();
}

function showStructuralControlError(error) {
	const message = byId("structural-preview-message");
	message.className = "notice error structural-message";
	message.textContent = error.message;
}

byId("openStructuralGroups").addEventListener("click", () => {
	const section = byId("view-structural-groups");
	section.scrollIntoView({ behavior: "smooth" });
	byId("structural-run").focus();
});
byId("structural-run").addEventListener("change", loadStructuralControlSets);
byId("structural-new-set").addEventListener("click", resetStructuralControlEditor);
byId("structural-save-draft").addEventListener("click", saveStructuralControlDraft);
byId("structural-fix-version").addEventListener("click", fixStructuralControlVersion);
byId("structural-edit-version").addEventListener("click", editStructuralControlSet);
byId("structural-disable-set").addEventListener("click", disableStructuralControlSet);
byId("structural-control-declaration").addEventListener("change", updateStructuralDeclarationActions);
