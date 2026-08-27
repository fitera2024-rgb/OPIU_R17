const emptyBindingState = {
  snapshot: null,
  registry: null,
  registryRevision: 0,
  organizationId: "",
  catalogRunId: "",
  catalogIdentity: null,
  catalog: { intalev: [], erp: [] },
  labels: [],
  mode: "NEW",
  currentDraftId: "",
  selectedBindingId: "",
  editSourceBindingId: "",
  editLineageId: "",
  loadGeneration: 0,
};

function emptyBindingOrganization() {
  const option = byId("empty-binding-organization")?.selectedOptions?.[0];
  return {
    id: option?.value || "",
    name: option?.dataset.organizationName || "",
    hierarchyPath: option?.dataset.organizationPath || "",
  };
}

function requireEmptyBindingReportOnly(payload) {
  const safety = payload?.safety;
  if (!safety || safety.mode !== "REPORT_ONLY" || safety.posting_rows !== 0 || safety.ready_to_upload !== false || safety.release_allowed !== false || safety.live_1c_allowed !== false || payload?.execution_allowed !== false) {
    throw new Error("Настройки остановлены: безопасный отчётный режим не подтверждён.");
  }
}

function emptyBindingNormalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleUpperCase("ru-RU");
}

function emptyBindingPathParts(value) {
  return String(value || "").split(" / ").map((part) => part.trim()).filter(Boolean);
}

function emptyBindingSamePath(left, right) {
  return emptyBindingNormalize(emptyBindingPathParts(left).join(" / ")) ===
    emptyBindingNormalize(emptyBindingPathParts(right).join(" / "));
}

function requireEmptyBindingCodexReportOnly(payload) {
  if (payload?.schema !== "opiu-codex-review-input-v1" || payload?.report_only !== true ||
      payload?.posting_rows !== 0 || payload?.execution_allowed !== false ||
      payload?.ready_to_upload !== false || payload?.release_allowed !== false ||
      payload?.live_1c_allowed !== false) {
    throw new Error("Точный справочник остановлен: безопасный отчётный результат R005 не подтверждён.");
  }
}

function exactEmptyBindingCatalogIdentity(payload, expected = {}) {
  const safety = payload?.safety;
  if (!safety || safety.mode !== "REPORT_ONLY" || safety.posting_rows !== 0 ||
      safety.ready_to_upload !== false || safety.release_allowed !== false || safety.live_1c_allowed !== false) {
    throw new Error("Точный справочник остановлен: безопасный проверенный каталог не подтверждён.");
  }
  const source = payload?.catalog && typeof payload.catalog === "object" ? payload.catalog : payload;
  const catalog = {
    run_id: String(source?.run_id || "").trim(),
    context_id: String(source?.context_id || "").trim(),
    inventory_id: String(source?.inventory_id || "").trim(),
  };
  if (!catalog.run_id || !catalog.context_id || !catalog.inventory_id ||
      catalog.run_id !== String(expected.runId || "") || catalog.context_id !== String(expected.contextId || "")) {
    throw new Error("Проверенный каталог не совпадает с выбранным запуском и контекстом.");
  }
  const organization = payload?.organization;
  if (organization && (String(organization.id || "") !== String(expected.organizationId || "") ||
      String(organization.name || "") !== String(expected.organizationName || "") ||
      String(organization.path || "") !== String(expected.organizationPath || ""))) {
    throw new Error("Проверенный каталог не совпадает с выбранной организацией.");
  }
  return catalog;
}

function emptyBindingRowsForPeriod(payload, period) {
  if (String(payload?.period || "") === period && Array.isArray(payload?.rows)) return payload.rows;
  const matches = (payload?.period_rows || []).filter((item) => String(item?.period || "") === period);
  if (matches.length !== 1 || !Array.isArray(matches[0]?.rows)) return [];
  return matches[0].rows;
}

function emptyBindingSourceScopes(payload) {
  const scopes = Array.isArray(payload?.intalev_source_scopes)
    ? payload.intalev_source_scopes
    : payload?.intalev_source_scope ? [payload.intalev_source_scope] : [];
  return scopes.filter((scope) => scope && typeof scope === "object");
}

function exactEmptyBindingRunCatalog(payload, expected = {}) {
  requireEmptyBindingCodexReportOnly(payload);
  if (!String(expected.organizationName || "") || String(payload.organization || "") !== String(expected.organizationName)) {
    throw new Error("Результат R005 не совпадает с выбранной организацией верхнего уровня.");
  }
  const resultPeriods = new Set((payload.periods || [payload.period]).map((period) => String(period || "")).filter(Boolean));
  if (expected.period && /^\d{4}-\d{2}$/.test(expected.period) && !resultPeriods.has(expected.period)) {
    throw new Error("Результат R005 не совпадает с выбранным периодом.");
  }

  const hierarchyByPeriod = new Map();
  for (const periodEntry of payload.hierarchy_periods || []) {
    const period = String(periodEntry?.period || "");
    if (!/^\d{4}-\d{2}$/.test(period) || hierarchyByPeriod.has(period) ||
        periodEntry?.intalev_tree?.status !== "PASS" || periodEntry?.erp_tree?.status !== "PASS" ||
        !Array.isArray(periodEntry?.intalev_tree?.nodes) || !Array.isArray(periodEntry?.erp_tree?.nodes)) {
      throw new Error("В результате R005 отсутствует точный проверенный каталог узлов Инталев/ERP.");
    }
    hierarchyByPeriod.set(period, periodEntry);
  }
  if (!hierarchyByPeriod.size) throw new Error("В результате R005 отсутствует точный проверенный каталог узлов Инталев/ERP.");

  const sourceGroups = new Map();
  for (const scope of emptyBindingSourceScopes(payload)) {
    for (const item of scope.unclassified_items || []) {
      if (item?.classification !== "UNCLASSIFIED" || String(item?.article ?? "") !== "" ||
          item?.source_scope_role !== "UNCLASSIFIED_DETAIL" ||
          item?.classification_basis !== "EMPTY_ARTICLE_ANCESTOR" || item?.source_is_leaf !== true) continue;
      const period = String(item.period || "");
      const sourceScopePath = String(item.source_scope_path || "").trim();
      const sourceParentPath = String(item.source_parent_path || "").trim();
      const blankBranchPath = String(item.blank_branch_source_path || "").trim();
      const sourcePath = String(item.source_path || "").trim();
      const sourceLabel = String(item.source_label || "").trim();
      const sourceScopeId = String(item.source_scope_id || "").trim();
      if (!/^\d{4}-\d{2}$/.test(period) || !sourceScopeId || !sourceScopePath || !sourceParentPath ||
          !blankBranchPath || !sourcePath || !sourceLabel || !emptyBindingSamePath(sourcePath, `${sourceParentPath} / ${sourceLabel}`)) {
        throw new Error("В каталоге пустых строк Инталев есть строка без точной идентификации.");
      }
      if (expected.period && /^\d{4}-\d{2}$/.test(expected.period) && period !== expected.period) continue;
      const periodHierarchy = hierarchyByPeriod.get(period);
      if (!periodHierarchy) throw new Error("Для пустой строки Инталев отсутствует точное дерево её периода.");
      const blankNodes = periodHierarchy.intalev_tree.nodes.filter((node) =>
        String(node?.node_id || "") && emptyBindingSamePath(node?.full_path, sourceParentPath));
      if (blankNodes.length !== 1) throw new Error("Родитель пустой строки Инталев неоднозначен.");
      const scopeLeaf = emptyBindingPathParts(sourceScopePath).at(-1) || "";
      const ownerRows = emptyBindingRowsForPeriod(payload, period).filter((row) =>
        String(row?.code || "").trim() && String(row?.intalev_label || "").trim() &&
        emptyBindingNormalize(row.intalev_label) === emptyBindingNormalize(scopeLeaf) &&
        (row.intalev_paths || []).some((path) => emptyBindingSamePath(path, sourceScopePath)));
      // An unclassified branch outside a unique OPIU article remains visible in R005,
      // but is not offered as a mapping authority in this settings UI.
      if (ownerRows.length === 0) continue;
      if (ownerRows.length !== 1) throw new Error("Экономический родитель пустой строки Инталев неоднозначен.");
      const owner = ownerRows[0];
      const groupKey = [period, blankNodes[0].node_id, owner.code, sourceParentPath]
        .map(emptyBindingNormalize).join("|");
      if (!sourceGroups.has(groupKey)) {
        sourceGroups.set(groupKey, {
          identity: String(blankNodes[0].node_id),
          code: String(owner.code).trim(),
          name: String(owner.intalev_label).trim(),
          hierarchy_path: sourceParentPath,
          period,
          leaves: [],
        });
      }
      const group = sourceGroups.get(groupKey);
      if (group.leaves.some((leaf) => emptyBindingNormalize(leaf.label) === emptyBindingNormalize(sourceLabel))) {
        throw new Error("Пустая строка Инталев неоднозначно повторяется у одного родителя.");
      }
      group.leaves.push({ identity: sourcePath, label: sourceLabel, hierarchy_path: sourcePath, period });
    }
  }
  const intalev = [...sourceGroups.values()].filter((group) => group.leaves.length).map((group) => ({
    ...group,
    leaves: group.leaves.sort((left, right) => left.label.localeCompare(right.label, "ru")),
  }));

  const erp = [];
  for (const [period, periodHierarchy] of hierarchyByPeriod) {
    if (expected.period && /^\d{4}-\d{2}$/.test(expected.period) && period !== expected.period) continue;
    const rows = emptyBindingRowsForPeriod(payload, period);
    for (const node of periodHierarchy.erp_tree.nodes) {
      const identity = String(node?.node_id || "").trim();
      const name = String(node?.label || node?.name || "").trim();
      const hierarchyPath = String(node?.full_path || "").trim();
      if (!identity || !name || !hierarchyPath || node?.is_group !== false ||
          (Array.isArray(node?.immediate_children) && node.immediate_children.length) ||
          String(node?.source_row_role || "") !== "ARTICLE") continue;
      const owners = rows.filter((row) => String(row?.code || "").trim() &&
        (row.erp_paths || []).some((path) => emptyBindingSamePath(path, hierarchyPath)));
      if (owners.length === 0) continue;
      // A physical ERP node covered by several presentation rows has no exact
      // R-code target identity. Exclude that node instead of guessing a row.
      if (owners.length !== 1) continue;
      erp.push({ identity, code: String(owners[0].code).trim(), name, hierarchy_path: hierarchyPath, period });
    }
  }

  const assertUnique = (members, side) => {
    const identities = new Set();
    const fingerprints = new Set();
    for (const member of members) {
      const identity = emptyBindingNormalize(member.identity);
      const fingerprint = [member.period, member.code, member.name, member.hierarchy_path]
        .map(emptyBindingNormalize).join("|");
      if (identities.has(identity) || fingerprints.has(fingerprint)) {
        throw new Error(`Точный каталог ${side} неоднозначен.`);
      }
      identities.add(identity);
      fingerprints.add(fingerprint);
    }
  };
  assertUnique(intalev, "Инталев");
  assertUnique(erp, "ERP");
  if (!intalev.length || !erp.length) {
    throw new Error("В результате R005 отсутствуют точные доступные строки Инталев или статьи ERP.");
  }
  return {
    intalev: intalev.sort((left, right) => `${left.period} ${left.code} ${left.hierarchy_path}`.localeCompare(`${right.period} ${right.code} ${right.hierarchy_path}`, "ru")),
    erp: erp.sort((left, right) => `${left.period} ${left.code} ${left.hierarchy_path}`.localeCompare(`${right.period} ${right.code} ${right.hierarchy_path}`, "ru")),
  };
}

function emptyBindingFriendlyError(error) {
  const message = String(error?.message || "");
  if (message.includes("REGISTRY_REVISION_CONFLICT")) return "Настройки уже изменились в другом окне. Список обновлён; повторите действие.";
  if (message.includes("SCOPE_OVERLAP")) return "Для этого родителя, строки и периода уже есть пересекающееся соответствие.";
  if (message.includes("SOURCE_LABEL_DUPLICATE")) return "Одно и то же наименование строки добавлено несколько раз.";
  if (message.includes("SOURCE_LABEL")) return "Добавьте одно или несколько точных наименований пустых строк Инталев.";
  if (message.includes("ORGANIZATION_MISMATCH") || message.includes("ORGANIZATION_REQUIRED")) return "Организация не совпадает с выбранной организацией верхнего уровня.";
  if (message.includes("SOURCE_PARENT_INVALID") || message.includes("ERP_TARGET_INVALID")) return "Выберите точного родителя Инталев и точную статью ERP из проверенного справочника.";
  if (message.includes("VALIDITY")) return "Проверьте начало и окончание периода действия.";
  if (message.includes("VERSION_INACTIVE")) return "Это соответствие уже отключено.";
  if (message.includes("DRAFT_NOT_FOUND") || message.includes("VERSION_NOT_FOUND")) return "Выбранная версия больше недоступна. Список обновлён.";
  if (/^[A-Z0-9_]+$/.test(message)) return "Операция не выполнена. Обновите список и проверьте выбранные бизнес-поля.";
  return message || "Операция не выполнена.";
}

function showEmptyBindingMessage(message, kind = "") {
  const root = byId("empty-binding-message");
  root.className = `notice empty-binding-message ${kind}`.trim();
  root.textContent = message;
}

function emptyBindingTopLevelOrganizations(nodes) {
  const candidates = (Array.isArray(nodes) ? nodes : []).filter((node) =>
    node?.selectable === true &&
    String(node.node_id || "") !== "" && String(node.name || "") !== "" && String(node.path || "") !== "" &&
    (String(node.node_id) === String(node.top_id || "") || (Number(node.depth) === 0 && !String(node.parent_id || "")))
  );
  const identities = new Set();
  const fingerprints = new Set();
  for (const node of candidates) {
    const identity = emptyBindingNormalize(node.node_id);
    const fingerprint = [node.name, node.path].map(emptyBindingNormalize).join("|");
    if (identities.has(identity) || fingerprints.has(fingerprint)) {
      throw new Error("Справочник организаций неоднозначен: настройка заблокирована.");
    }
    identities.add(identity);
    fingerprints.add(fingerprint);
  }
  return candidates;
}

async function loadEmptyBindingOrganizations() {
  const select = byId("empty-binding-organization");
  try {
    const nodes = await api("/api/organizations");
    const organizations = emptyBindingTopLevelOrganizations(nodes);
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = organizations.length ? "Выберите организацию верхнего уровня" : "Организации верхнего уровня не найдены";
    select.append(empty);
    for (const organization of organizations) {
      const option = document.createElement("option");
      option.value = organization.node_id;
      option.dataset.organizationName = organization.name;
      option.dataset.organizationPath = organization.path;
      option.textContent = organization.name;
      select.append(option);
    }
    if (organizations.length === 1) {
      select.value = organizations[0].node_id;
      await changeEmptyBindingOrganization();
    } else {
      renderEmptyArticleBindingRunOptions(emptyBindingState.snapshot || { runs: [], contexts: [] });
    }
  } catch (error) {
    select.replaceChildren();
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Справочник организаций недоступен";
    select.append(option);
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

function renderEmptyArticleBindingRunOptions(snapshot) {
  emptyBindingState.snapshot = snapshot;
  const select = byId("empty-binding-run");
  if (!select) return;
  const organization = emptyBindingOrganization();
  const previous = select.value;
  const contexts = new Map((snapshot?.contexts || []).map((context) => [context.id, context]));
  const runs = (snapshot?.runs || []).filter((run) => {
    const context = contexts.get(run.context_id);
    return organization.id && context?.organization_id === organization.id &&
      (run.status === "COMPLETED_REPORT_ONLY" || run.status === "WAITING_USER_RULES");
  });
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = organization.id ? (runs.length ? "Выберите проверенный запуск" : "Для организации нет проверенных запусков") : "Сначала выберите организацию";
  select.append(empty);
  for (const run of runs) {
    const context = contexts.get(run.context_id);
    const option = document.createElement("option");
    option.value = run.id;
    option.dataset.contextId = run.context_id || "";
    option.dataset.organizationId = context?.organization_id || "";
    option.dataset.period = context?.period || "";
    option.textContent = `${run.message || "Отчётный запуск"} · ${formatTime(run.started_at)}`;
    select.append(option);
  }
  if (runs.some((run) => run.id === previous)) select.value = previous;
  else if (runs.some((run) => run.id === emptyBindingState.catalogRunId)) select.value = emptyBindingState.catalogRunId;
  else if (emptyBindingState.catalogRunId) clearEmptyBindingCatalog("Выбранный справочник больше не доступен.");
}

function clearEmptyBindingCatalog(message = "Выберите организацию и проверенный запуск для точного справочника.") {
  emptyBindingState.catalogRunId = "";
  emptyBindingState.catalogIdentity = null;
  emptyBindingState.catalog = { intalev: [], erp: [] };
  if (emptyBindingState.mode === "NEW" || emptyBindingState.mode === "EDIT") emptyBindingState.labels = [];
  renderEmptyBindingCatalogSelect("source-parent", []);
  renderEmptyBindingCatalogSelect("erp-target", []);
  renderEmptyBindingLabels();
  byId("empty-binding-catalog-status").textContent = message;
  updateEmptyBindingActions();
}

function renderEmptyBindingCatalogSelect(kind, members, selectedIdentity = "") {
  const select = byId(`empty-binding-${kind}`);
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = members.length ? "Выберите точную строку" : "Точный справочник не загружен";
  select.append(placeholder);
  for (const member of members) {
    const option = document.createElement("option");
    option.value = member.identity;
    option.textContent = `${member.period} · ${member.code} · ${member.name} · ${member.hierarchy_path}`;
    select.append(option);
  }
  select.disabled = !members.length || emptyBindingState.mode === "VIEW" || emptyBindingState.mode === "DRAFT";
  if (members.some((member) => member.identity === selectedIdentity)) select.value = selectedIdentity;
}

async function loadEmptyBindingCatalog() {
  const runSelect = byId("empty-binding-run");
  const runId = runSelect.value;
  const selectedRun = runSelect.selectedOptions?.[0];
  const organization = emptyBindingOrganization();
  const generation = ++emptyBindingState.loadGeneration;
  clearEmptyBindingCatalog(runId ? "Проверяем точный справочник…" : undefined);
  if (!runId) return;
  try {
    const identityQuery = new URLSearchParams({ organization_id: organization.id, run_id: runId });
    const [result, verifiedCatalogPayload] = await Promise.all([
      api(`/api/runs/${encodeURIComponent(runId)}/result/r005`),
      api(`/api/structural-control-sets?${identityQuery.toString()}`),
    ]);
    if (generation !== emptyBindingState.loadGeneration || byId("empty-binding-run").value !== runId) return;
    const catalogIdentity = exactEmptyBindingCatalogIdentity(verifiedCatalogPayload, {
      runId,
      contextId: selectedRun?.dataset.contextId || "",
      organizationId: organization.id,
      organizationName: organization.name,
      organizationPath: organization.hierarchyPath,
    });
    const detailFiles = (result?.files || []).filter((file) => file?.kind === "details" && String(file?.url || ""));
    const expectedURLPrefix = `/api/runs/${encodeURIComponent(runId)}/result/r005/file?`;
    if (result?.stage !== "R005" || result?.ready !== true || detailFiles.length !== 1 ||
        !String(detailFiles[0].url).startsWith(expectedURLPrefix) || selectedRun?.dataset.organizationId !== organization.id) {
      throw new Error("Проверенный справочник не совпадает с выбранной организацией и запуском.");
    }
    const details = await api(detailFiles[0].url);
    if (generation !== emptyBindingState.loadGeneration || byId("empty-binding-run").value !== runId) return;
    const catalog = exactEmptyBindingRunCatalog(details, {
      organizationName: organization.name,
      period: selectedRun?.dataset.period || "",
    });
    const { intalev, erp } = catalog;
    emptyBindingState.catalogRunId = runId;
    emptyBindingState.catalogIdentity = catalogIdentity;
    emptyBindingState.catalog = { intalev, erp };
    renderEmptyBindingCatalogSelect("source-parent", intalev);
    renderEmptyBindingCatalogSelect("erp-target", erp);
    renderEmptyBindingLabels(false);
    const period = selectedRun?.dataset.period || "";
    if (/^\d{4}-\d{2}$/.test(period)) {
      if (!byId("empty-binding-valid-from").value) byId("empty-binding-valid-from").value = period;
      if (!byId("empty-binding-valid-through").value) byId("empty-binding-valid-through").value = period;
    }
    byId("empty-binding-catalog-status").textContent = `Точный справочник результата R005 загружен: ${intalev.length} родителей пустых строк Инталев, ${erp.length} статей ERP.`;
    updateEmptyBindingActions();
  } catch (error) {
    if (generation !== emptyBindingState.loadGeneration) return;
    clearEmptyBindingCatalog("Точный справочник недоступен. Сохранение и фиксация заблокированы.");
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

function selectedEmptyBindingNode(side) {
  const kind = side === "intalev" ? "source-parent" : "erp-target";
  const identity = byId(`empty-binding-${kind}`).value;
  const member = emptyBindingState.catalog[side].find((candidate) => candidate.identity === identity);
  if (!member) return null;
  return { identity: member.identity, code: member.code, hierarchy_path: member.hierarchy_path, article: member.name };
}

function exactEmptyBindingNodeAvailable(node, side) {
  if (!node) return false;
  return emptyBindingState.catalog[side].some((member) => member.identity === node.identity && member.code === node.code && member.name === node.article && member.hierarchy_path === node.hierarchy_path);
}

function selectedEmptyBindingSourceMember() {
  const identity = byId("empty-binding-source-parent").value;
  return emptyBindingState.catalog.intalev.find((candidate) => candidate.identity === identity) || null;
}

function renderEmptyBindingLabels(readOnly = emptyBindingState.mode === "VIEW" || emptyBindingState.mode === "DRAFT") {
  const root = byId("empty-binding-label-list");
  root.replaceChildren();
  const source = selectedEmptyBindingSourceMember();
  if (!source) {
    root.className = "empty-binding-label-list empty";
    if (!emptyBindingState.labels.length) {
      root.textContent = "Сначала выберите точного родителя Инталев из результата R005.";
    } else {
      root.className = "empty-binding-label-list";
      for (const label of emptyBindingState.labels) {
        const item = document.createElement("span");
        item.className = "empty-binding-label unavailable";
        item.textContent = `${label} · отсутствует в выбранном результате R005`;
        root.append(item);
      }
    }
    return;
  }
  root.className = "empty-binding-label-list";
  for (const leaf of source.leaves) {
    const item = document.createElement("label");
    item.className = "empty-binding-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = leaf.identity;
    checkbox.checked = emptyBindingState.labels.some((label) => emptyBindingNormalize(label) === emptyBindingNormalize(leaf.label));
    checkbox.disabled = readOnly;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (!emptyBindingState.labels.some((label) => emptyBindingNormalize(label) === emptyBindingNormalize(leaf.label))) {
          emptyBindingState.labels.push(leaf.label);
        }
      } else {
        emptyBindingState.labels = emptyBindingState.labels.filter((label) => emptyBindingNormalize(label) !== emptyBindingNormalize(leaf.label));
      }
      updateEmptyBindingActions();
    });
    const text = document.createElement("span");
    text.textContent = leaf.label;
    item.append(checkbox, text);
    root.append(item);
  }
  if (!source.leaves.length) {
    root.className = "empty-binding-label-list empty";
    root.textContent = "У выбранного родителя нет точных пустых дочерних строк.";
  }
}

function changeEmptyBindingSourceParent() {
  if (emptyBindingState.mode !== "NEW" && emptyBindingState.mode !== "EDIT") return;
  emptyBindingState.labels = [];
  const source = selectedEmptyBindingSourceMember();
  const targets = source
    ? emptyBindingState.catalog.erp.filter((member) => member.period === source.period)
    : emptyBindingState.catalog.erp;
  renderEmptyBindingCatalogSelect("erp-target", targets);
  renderEmptyBindingLabels(false);
  updateEmptyBindingActions();
}

function emptyBindingDefinitionPayload() {
  const organization = emptyBindingOrganization();
  const sourceParent = selectedEmptyBindingNode("intalev");
  const erpTarget = selectedEmptyBindingNode("erp");
  return {
    name: byId("empty-binding-name").value.trim(),
    organization_id: organization.id,
    organization_name: organization.name,
    organization_hierarchy_path: organization.hierarchyPath,
    valid_from_month: byId("empty-binding-valid-from").value,
    valid_through_month: byId("empty-binding-valid-through").value,
    run_id: emptyBindingState.catalogIdentity?.run_id || "",
    inventory_id: emptyBindingState.catalogIdentity?.inventory_id || "",
    source_parent: sourceParent,
    source_labels: [...emptyBindingState.labels],
    erp_target: erpTarget,
    source_binding_id: emptyBindingState.editSourceBindingId || undefined,
    expected_registry_revision: emptyBindingState.registryRevision,
  };
}

function emptyBindingPeriodsOverlap(left, right) {
  return left.from_month <= right.through_month && right.from_month <= left.through_month;
}

function emptyBindingClientConflict(definition) {
  const candidates = [
    ...(emptyBindingState.registry?.versions || []).filter((version) => version.status === "FIXED"),
    ...(emptyBindingState.registry?.drafts || []),
  ];
  for (const candidate of candidates) {
    if (candidate.lineage_id && candidate.lineage_id === emptyBindingState.editLineageId) continue;
    const existing = candidate.definition;
    if (!existing || existing.source_parent?.identity !== definition.source_parent?.identity || !emptyBindingPeriodsOverlap(existing.validity, definition.validity)) continue;
    const labels = new Set((existing.source_labels || []).map(emptyBindingNormalize));
    if ((definition.source_labels || []).some((label) => labels.has(emptyBindingNormalize(label)))) {
      return "Для этого родителя, строки и периода уже есть соответствие. Неоднозначность заблокирована.";
    }
  }
  return "";
}

function validateEmptyBindingDraftPayload(payload) {
  if (!payload.organization_id || !payload.organization_name || !payload.organization_hierarchy_path) throw new Error("Выберите организацию верхнего уровня.");
  if (!emptyBindingState.catalogRunId || !payload.run_id || !payload.inventory_id || payload.run_id !== emptyBindingState.catalogRunId ||
      !payload.source_parent || !payload.erp_target) throw new Error("Выберите точного родителя Инталев и точную статью ERP из проверенного справочника.");
  if (!payload.valid_from_month || !payload.valid_through_month || payload.valid_from_month > payload.valid_through_month) throw new Error("Проверьте начало и окончание периода действия.");
  if (!payload.source_labels.length) throw new Error("Добавьте одно или несколько точных наименований пустых строк Инталев.");
  const source = selectedEmptyBindingSourceMember();
  const target = emptyBindingState.catalog.erp.find((member) => member.identity === byId("empty-binding-erp-target").value) || null;
  if (!source || !target || source.period !== target.period || source.period < payload.valid_from_month || source.period > payload.valid_through_month ||
      payload.source_labels.some((label) => !source.leaves.some((leaf) => emptyBindingNormalize(leaf.label) === emptyBindingNormalize(label)))) {
    throw new Error("Выберите точные строки одного периода R005; период действия должен включать этот период.");
  }
  const definition = {
    validity: { from_month: payload.valid_from_month, through_month: payload.valid_through_month },
    source_parent: payload.source_parent,
    source_labels: payload.source_labels,
  };
  const conflict = emptyBindingClientConflict(definition);
  if (conflict) throw new Error(conflict);
}

async function saveEmptyBindingDraft() {
  if (emptyBindingState.mode !== "NEW" && emptyBindingState.mode !== "EDIT") return;
  try {
    const payload = emptyBindingDefinitionPayload();
    validateEmptyBindingDraftPayload(payload);
    const result = await api("/api/empty-article-bindings", { method: "POST", body: JSON.stringify(payload) });
    requireEmptyBindingReportOnly(result);
    emptyBindingState.registryRevision = Number(result.registry_revision || 0);
    emptyBindingState.currentDraftId = result.draft?.draft_id || "";
    await loadEmptyBindingRegistry({ preserveSelection: true });
    selectEmptyBindingDraft(emptyBindingState.currentDraftId);
    showEmptyBindingMessage("Черновик сохранён. Чтобы настройка начала действовать, явно нажмите «Зафиксировать».", "good");
  } catch (error) {
    await reloadEmptyBindingRegistryOnConflict(error);
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

async function fixEmptyBindingVersion() {
  if (emptyBindingState.mode !== "DRAFT" || !emptyBindingState.currentDraftId) return;
  const organization = emptyBindingOrganization();
  const draft = (emptyBindingState.registry?.drafts || []).find((candidate) => candidate.draft_id === emptyBindingState.currentDraftId);
  if (!draft?.catalog?.run_id || !draft?.catalog?.inventory_id) {
    showEmptyBindingMessage("Черновик не связан с точным проверенным каталогом. Фиксация заблокирована.", "error");
    return;
  }
  try {
    const result = await api("/api/empty-article-bindings/fix", {
      method: "POST",
      body: JSON.stringify({
        draft_id: emptyBindingState.currentDraftId,
        organization_id: organization.id,
        organization_name: organization.name,
        organization_hierarchy_path: organization.hierarchyPath,
        run_id: draft.catalog.run_id,
        inventory_id: draft.catalog.inventory_id,
        expected_registry_revision: emptyBindingState.registryRevision,
      }),
    });
    requireEmptyBindingReportOnly(result);
    const bindingId = result.fixed_version?.binding_id || "";
    emptyBindingState.currentDraftId = "";
    await loadEmptyBindingRegistry({ preserveSelection: true });
    selectEmptyBindingVersion(bindingId);
    showEmptyBindingMessage("Версия зафиксирована: UPDATE_MAPPING / БЕЗ ПРОВОДКИ.", "good");
  } catch (error) {
    await reloadEmptyBindingRegistryOnConflict(error);
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

async function disableEmptyBindingVersion() {
  if (emptyBindingState.mode !== "VIEW" || !emptyBindingState.selectedBindingId) return;
  const reason = byId("empty-binding-disable-reason").value.trim();
  if (!reason) {
    showEmptyBindingMessage("Укажите бизнес-причину отключения.", "warn");
    return;
  }
  const organization = emptyBindingOrganization();
  try {
    const result = await api("/api/empty-article-bindings/disable", {
      method: "POST",
      body: JSON.stringify({
        binding_id: emptyBindingState.selectedBindingId,
        organization_id: organization.id,
        organization_name: organization.name,
        organization_hierarchy_path: organization.hierarchyPath,
        reason,
        expected_registry_revision: emptyBindingState.registryRevision,
      }),
    });
    requireEmptyBindingReportOnly(result);
    await loadEmptyBindingRegistry();
    resetEmptyBindingEditor();
    showEmptyBindingMessage("Соответствие отключено. Новые запуски его не применяют.", "good");
  } catch (error) {
    await reloadEmptyBindingRegistryOnConflict(error);
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

async function reloadEmptyBindingRegistryOnConflict(error) {
  if (String(error?.message || "").includes("REGISTRY_REVISION_CONFLICT")) {
    try { await loadEmptyBindingRegistry(); } catch { /* основная ошибка уже показана */ }
  }
}

async function loadEmptyBindingRegistry(options = {}) {
  const organization = emptyBindingOrganization();
  if (!organization.id) {
    emptyBindingState.registry = null;
    emptyBindingState.registryRevision = 0;
    renderEmptyBindingRegistry();
    return;
  }
  const query = new URLSearchParams({
    organization_id: organization.id,
    organization_name: organization.name,
    organization_hierarchy_path: organization.hierarchyPath,
  });
  const payload = await api(`/api/empty-article-bindings?${query.toString()}`);
  requireEmptyBindingReportOnly(payload);
  if (payload.organization?.organization_id !== organization.id || payload.organization?.organization_name !== organization.name || payload.organization?.organization_hierarchy_path !== organization.hierarchyPath) {
    throw new Error("Ответ настроек не совпадает с выбранной организацией верхнего уровня.");
  }
  emptyBindingState.registry = payload;
  emptyBindingState.registryRevision = Number(payload.registry_revision || 0);
  renderEmptyBindingRegistry();
  if (!options.preserveSelection) updateEmptyBindingActions();
}

function emptyBindingDefinitionSummary(definition) {
  const labels = (definition?.source_labels || []).join(", ");
  return `${definition?.source_parent?.code || ""} ${definition?.source_parent?.article || ""}: ${labels} → ${definition?.erp_target?.code || ""} ${definition?.erp_target?.article || ""}`.trim();
}

function renderEmptyBindingRegistry() {
  const root = byId("empty-binding-list");
  root.replaceChildren();
  const versions = emptyBindingState.registry?.versions || [];
  const drafts = emptyBindingState.registry?.drafts || [];
  if (!versions.length && !drafts.length) {
    root.className = "list empty";
    root.textContent = "Соответствий пока нет";
    return;
  }
  root.className = "list";
  for (const version of versions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `empty-binding-item${emptyBindingState.selectedBindingId === version.binding_id ? " selected" : ""}`;
    button.dataset.emptyBindingId = version.binding_id;
    const title = document.createElement("strong");
    title.textContent = `${version.definition?.name || "Соответствие"} · версия ${version.version}`;
    const summary = document.createElement("span");
    summary.className = "empty-binding-summary";
    summary.textContent = `${emptyBindingDefinitionSummary(version.definition)} · ${version.status === "FIXED" ? "зафиксировано" : "отключено"}`;
    button.append(title, summary);
    button.addEventListener("click", () => selectEmptyBindingVersion(version.binding_id));
    root.append(button);
  }
  for (const draft of drafts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `empty-binding-item${emptyBindingState.currentDraftId === draft.draft_id ? " selected" : ""}`;
    button.dataset.emptyBindingDraftId = draft.draft_id;
    const title = document.createElement("strong");
    title.textContent = `${draft.definition?.name || "Соответствие"} · черновик`;
    const summary = document.createElement("span");
    summary.className = "empty-binding-summary";
    summary.textContent = emptyBindingDefinitionSummary(draft.definition);
    button.append(title, summary);
    button.addEventListener("click", () => selectEmptyBindingDraft(draft.draft_id));
    root.append(button);
  }
}

function populateEmptyBindingDefinition(definition) {
  byId("empty-binding-name").value = definition?.name || "";
  byId("empty-binding-valid-from").value = definition?.validity?.from_month || "";
  byId("empty-binding-valid-through").value = definition?.validity?.through_month || "";
  emptyBindingState.labels = [...(definition?.source_labels || [])];
  renderEmptyBindingCatalogSelect("source-parent", emptyBindingState.catalog.intalev, definition?.source_parent?.identity || "");
  renderEmptyBindingCatalogSelect("erp-target", emptyBindingState.catalog.erp, definition?.erp_target?.identity || "");
  renderEmptyBindingLabels();
  const readOnly = emptyBindingState.mode === "VIEW" || emptyBindingState.mode === "DRAFT";
  for (const id of ["empty-binding-name", "empty-binding-valid-from", "empty-binding-valid-through"]) byId(id).disabled = readOnly;
}

function emptyBindingDefinitionInCatalog(definition) {
  const source = emptyBindingState.catalog.intalev.find((member) => member.identity === definition?.source_parent?.identity &&
    member.code === definition?.source_parent?.code && member.name === definition?.source_parent?.article &&
    member.hierarchy_path === definition?.source_parent?.hierarchy_path);
  return Boolean(source && exactEmptyBindingNodeAvailable(definition?.erp_target, "erp") &&
    (definition?.source_labels || []).length &&
    (definition?.source_labels || []).every((label) => source.leaves.some((leaf) => emptyBindingNormalize(leaf.label) === emptyBindingNormalize(label))));
}

function emptyBindingPublicCatalogMatchesCurrent(catalog) {
  return Boolean(catalog && emptyBindingState.catalogIdentity &&
    catalog.run_id === emptyBindingState.catalogIdentity.run_id &&
    catalog.context_id === emptyBindingState.catalogIdentity.context_id &&
    catalog.inventory_id === emptyBindingState.catalogIdentity.inventory_id);
}

function selectEmptyBindingVersion(bindingId) {
  const version = (emptyBindingState.registry?.versions || []).find((candidate) => candidate.binding_id === bindingId);
  if (!version) return;
  emptyBindingState.mode = "VIEW";
  emptyBindingState.selectedBindingId = bindingId;
  emptyBindingState.currentDraftId = "";
  emptyBindingState.editSourceBindingId = "";
  emptyBindingState.editLineageId = "";
  populateEmptyBindingDefinition(version.definition);
  renderEmptyBindingRegistry();
  updateEmptyBindingActions();
  if (!emptyBindingDefinitionInCatalog(version.definition) || !emptyBindingPublicCatalogMatchesCurrent(version.catalog)) {
    showEmptyBindingMessage("Версия показана только для просмотра: её точные строки отсутствуют в выбранном справочнике.", "warn");
  } else {
    showEmptyBindingMessage(`Версия ${version.status === "FIXED" ? "зафиксирована" : "отключена"}: UPDATE_MAPPING / БЕЗ ПРОВОДКИ.`, version.status === "FIXED" ? "good" : "");
  }
}

function selectEmptyBindingDraft(draftId) {
  const draft = (emptyBindingState.registry?.drafts || []).find((candidate) => candidate.draft_id === draftId);
  if (!draft) return;
  emptyBindingState.mode = "DRAFT";
  emptyBindingState.currentDraftId = draftId;
  emptyBindingState.selectedBindingId = "";
  emptyBindingState.editSourceBindingId = draft.source_binding_id || "";
  emptyBindingState.editLineageId = draft.lineage_id || "";
  populateEmptyBindingDefinition(draft.definition);
  renderEmptyBindingRegistry();
  updateEmptyBindingActions();
  if (!emptyBindingDefinitionInCatalog(draft.definition) || !emptyBindingPublicCatalogMatchesCurrent(draft.catalog)) {
    showEmptyBindingMessage("Черновик нельзя зафиксировать: точные строки отсутствуют в выбранном справочнике.", "error");
  } else {
    showEmptyBindingMessage("Черновик ожидает явной фиксации. До фиксации он не применяется.", "warn");
  }
}

function editEmptyBindingVersion() {
  const version = (emptyBindingState.registry?.versions || []).find((candidate) => candidate.binding_id === emptyBindingState.selectedBindingId && candidate.status === "FIXED");
  if (!version || !emptyBindingDefinitionInCatalog(version.definition) || !emptyBindingPublicCatalogMatchesCurrent(version.catalog)) return;
  emptyBindingState.mode = "EDIT";
  emptyBindingState.editSourceBindingId = version.binding_id;
  emptyBindingState.editLineageId = version.lineage_id;
  emptyBindingState.selectedBindingId = "";
  emptyBindingState.currentDraftId = "";
  populateEmptyBindingDefinition(version.definition);
  renderEmptyBindingRegistry();
  updateEmptyBindingActions();
  showEmptyBindingMessage("Изменения будут сохранены отдельным черновиком и начнут действовать только после фиксации.", "warn");
}

function resetEmptyBindingEditor() {
  emptyBindingState.mode = "NEW";
  emptyBindingState.currentDraftId = "";
  emptyBindingState.selectedBindingId = "";
  emptyBindingState.editSourceBindingId = "";
  emptyBindingState.editLineageId = "";
  emptyBindingState.labels = [];
  byId("empty-binding-name").value = "";
  byId("empty-binding-disable-reason").value = "";
  for (const id of ["empty-binding-name", "empty-binding-valid-from", "empty-binding-valid-through"]) byId(id).disabled = false;
  renderEmptyBindingCatalogSelect("source-parent", emptyBindingState.catalog.intalev);
  renderEmptyBindingCatalogSelect("erp-target", emptyBindingState.catalog.erp);
  renderEmptyBindingLabels(false);
  renderEmptyBindingRegistry();
  updateEmptyBindingActions();
  showEmptyBindingMessage("Новое соответствие: UPDATE_MAPPING / БЕЗ ПРОВОДКИ.");
}

function updateEmptyBindingActions() {
  const catalogReady = Boolean(emptyBindingState.catalogRunId && emptyBindingState.catalogIdentity?.run_id === emptyBindingState.catalogRunId &&
    emptyBindingState.catalogIdentity?.inventory_id && emptyBindingState.catalog.intalev.length && emptyBindingState.catalog.erp.length);
  const draft = (emptyBindingState.registry?.drafts || []).find((candidate) => candidate.draft_id === emptyBindingState.currentDraftId);
  const version = (emptyBindingState.registry?.versions || []).find((candidate) => candidate.binding_id === emptyBindingState.selectedBindingId);
  byId("empty-binding-save-draft").disabled = !catalogReady || (emptyBindingState.mode !== "NEW" && emptyBindingState.mode !== "EDIT");
  byId("empty-binding-fix").disabled = emptyBindingState.mode !== "DRAFT" || !draft || !emptyBindingDefinitionInCatalog(draft.definition) || !emptyBindingPublicCatalogMatchesCurrent(draft.catalog);
  byId("empty-binding-edit").disabled = emptyBindingState.mode !== "VIEW" || version?.status !== "FIXED" || !emptyBindingDefinitionInCatalog(version?.definition) || !emptyBindingPublicCatalogMatchesCurrent(version?.catalog);
  byId("empty-binding-disable").disabled = emptyBindingState.mode !== "VIEW" || version?.status !== "FIXED";
}

async function changeEmptyBindingOrganization() {
  const organization = emptyBindingOrganization();
  emptyBindingState.organizationId = organization.id;
  emptyBindingState.registry = null;
  emptyBindingState.registryRevision = 0;
  emptyBindingState.loadGeneration++;
  byId("empty-binding-run").value = "";
  clearEmptyBindingCatalog();
  resetEmptyBindingEditor();
  renderEmptyArticleBindingRunOptions(emptyBindingState.snapshot || { runs: [], contexts: [] });
  if (!organization.id) return;
  try {
    await loadEmptyBindingRegistry();
  } catch (error) {
    showEmptyBindingMessage(emptyBindingFriendlyError(error), "error");
  }
}

byId("openEmptyArticleBindings").addEventListener("click", () => {
  byId("view-empty-article-bindings").scrollIntoView({ behavior: "smooth" });
  byId("empty-binding-organization").focus();
});
byId("empty-binding-organization").addEventListener("change", changeEmptyBindingOrganization);
byId("empty-binding-run").addEventListener("change", loadEmptyBindingCatalog);
byId("empty-binding-source-parent").addEventListener("change", changeEmptyBindingSourceParent);
byId("empty-binding-erp-target").addEventListener("change", updateEmptyBindingActions);
byId("empty-binding-new").addEventListener("click", resetEmptyBindingEditor);
byId("empty-binding-save-draft").addEventListener("click", saveEmptyBindingDraft);
byId("empty-binding-fix").addEventListener("click", fixEmptyBindingVersion);
byId("empty-binding-edit").addEventListener("click", editEmptyBindingVersion);
byId("empty-binding-disable").addEventListener("click", disableEmptyBindingVersion);

loadEmptyBindingOrganizations();
