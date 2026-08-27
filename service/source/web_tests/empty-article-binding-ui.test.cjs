const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const javascript = readFileSync(join(webRoot, "empty-article-binding-ui.js"), "utf8");
const app = readFileSync(join(webRoot, "app.js"), "utf8");

function bindingSection() {
  const start = html.indexOf('id="view-empty-article-bindings"');
  assert.ok(start >= 0, "built-in UI must contain the empty-article binding business view");
  const next = html.indexOf("<section", start + 1);
  return html.slice(start, next >= 0 ? next : html.length);
}

function catalogBuilder() {
  const start = javascript.indexOf("function emptyBindingNormalize");
  const end = javascript.indexOf("function emptyBindingFriendlyError", start);
  assert.ok(start >= 0 && end > start, "pure run-catalog builder must be extractable for behavior tests");
  return new Function(`${javascript.slice(start, end)}; return exactEmptyBindingRunCatalog;`)();
}

function catalogIdentityGuard() {
  const start = javascript.indexOf("function emptyBindingNormalize");
  const end = javascript.indexOf("function emptyBindingFriendlyError", start);
  return new Function(`${javascript.slice(start, end)}; return exactEmptyBindingCatalogIdentity;`)();
}

function actualRunBoundCatalogShape() {
  const period = "2025-07";
  const sourceScopePath = "Операционные расходы / Выплаты сотрудникам";
  const sourceParentPath = `${sourceScopePath} / <пустое значение>`;
  const sourceLabel = "Доплата за смену";
  const erpPath = "Расходы / Расчёты с персоналом / Оплата труда";
  return {
    schema: "opiu-codex-review-input-v1",
    organization: "Тестовая организация",
    period,
    periods: [period],
    report_only: true,
    posting_rows: 0,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    // This is the real problematic structural inventory shape: a verified
    // presentation node may have a blank code and is not an article catalog.
    structural_control_inventory: {
      intalev_members: [{ identity: "STRUCTURAL:1", code: "", name: "Выплаты сотрудникам", hierarchy_path: sourceScopePath }],
      erp_members: [{ identity: "STRUCTURAL:2", code: "", name: "Расходы", hierarchy_path: "Расходы" }],
    },
    intalev_source_scopes: [{
      unclassified_items: [{
        classification: "UNCLASSIFIED",
        article: "",
        amount: 12500,
        period,
        source_scope_role: "UNCLASSIFIED_DETAIL",
        contributes_to_unclassified_total: true,
        classification_basis: "EMPTY_ARTICLE_ANCESTOR",
        source_scope_id: "scope:actual:77",
        source_scope_path: sourceScopePath,
        blank_branch_source_path: sourceParentPath,
        source_parent_path: sourceParentPath,
        source_outline_level: 6,
        source_scope_relative_level: 1,
        source_is_leaf: true,
        source_path: `${sourceParentPath} / ${sourceLabel}`,
        source_label: sourceLabel,
      }],
    }],
    rows: [
      { code: "R777", intalev_label: "Выплаты сотрудникам", intalev_paths: [sourceScopePath], erp_paths: [] },
      { code: "R888", intalev_label: "Контроль", intalev_paths: [], erp_paths: [erpPath] },
    ],
    hierarchy_periods: [{
      period,
      intalev_tree: {
        status: "PASS",
        nodes: [{ node_id: "INTALEV:BLANK:77", label: "<пустое значение>", full_path: sourceParentPath, is_group: true }],
      },
      erp_tree: {
        status: "PASS",
        nodes: [{
          node_id: "ERP:ARTICLE:888",
          label: "Оплата труда",
          full_path: erpPath,
          is_group: false,
          immediate_children: [],
          source_row_role: "ARTICLE",
        }],
      },
    }],
  };
}

test("built-in UI loads a separate empty-article binding module and business view", () => {
  const section = bindingSection();
  assert.match(html, /<script\s+src=["']\/empty-article-binding-ui\.js["']\s+defer>/);
  assert.match(html, /id=["']openEmptyArticleBindings["']/);
  assert.match(section, /Привязки пустых статей Инталев/);
  assert.match(section, /организации верхнего уровня/iu);
  assert.match(app, /renderEmptyArticleBindingRunOptions\(snapshot\)/,
    "bootstrap refresh must update the reference-run catalog without coupling the module to engine code");
});

test("business form binds validity, exact Intalev parent, multiple leaf labels and exact ERP target", () => {
  const section = bindingSection();
  for (const id of [
    "empty-binding-organization",
    "empty-binding-run",
    "empty-binding-valid-from",
    "empty-binding-valid-through",
    "empty-binding-source-parent",
    "empty-binding-label-list",
    "empty-binding-erp-target",
  ]) assert.match(section, new RegExp(`id=["']${id}["']`), `${id} is required`);
  assert.match(section, /<select\s+id=["']empty-binding-source-parent["']/,
    "the exact source parent must be selected from a catalog, not typed freely");
  assert.match(section, /<select\s+id=["']empty-binding-erp-target["']/,
    "the exact ERP target must be selected from a catalog, not typed freely");
  assert.match(section, /фактически найденных строк/iu);
  assert.doesNotMatch(section, /empty-binding-label-input|empty-binding-add-label/,
    "blank leaves must come from the exact run result, never from free text");
  assert.match(javascript, /checkbox\.value\s*=\s*leaf\.identity/);
  assert.match(javascript, /source\.leaves\.some/,
    "saved labels must be members of the selected run-bound blank-leaf catalog");
});

test("only exact top-level organizations and exact R005 result catalogs can be saved", () => {
  assert.match(javascript, /\/api\/organizations/);
  assert.match(javascript, /node\.node_id\)\s*===\s*String\(node\.top_id/,
    "organization selector must be constrained to catalog top-level identity");
  assert.match(javascript, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/result\/r005/,
    "catalog must be loaded from the selected run's R005 result");
  assert.match(javascript, /file\?`|result\/r005\/file\?/,
    "catalog loader must require the exact R005 details-file URL");
  assert.match(javascript, /\/api\/structural-control-sets\?\$\{identityQuery\.toString\(\)\}/,
    "the service-verified run/inventory identity is loaded separately for immutable draft binding");
  assert.doesNotMatch(javascript, /verifiedCatalogPayload\.(?:intalev_members|erp_members)/,
    "structural block members must not be consumed as the exact blank-leaf or ERP article catalog");
  assert.match(javascript, /intalev_source_scopes/);
  assert.match(javascript, /hierarchy_periods/);
  assert.match(javascript, /source_row_role[^\n]*ARTICLE/);
  assert.match(javascript, /identities\.has\(identity\)\s*\|\|\s*fingerprints\.has\(fingerprint\)/,
    "duplicate identity or duplicate exact business fingerprint must block the catalog");
  assert.doesNotMatch(javascript, /R036|Заработная плата|Отпускные|Премия|Больничн|НДФЛ/iu,
    "the generic UI must not hardcode an owner code or owner leaf labels");
});

test("public catalog identity is exact, SHA-free and fail-closed", () => {
  const guard = catalogIdentityGuard();
  const safety = { mode: "REPORT_ONLY", posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false };
  const expected = { runId: "run-7", contextId: "ctx-7", organizationId: "org-7", organizationName: "Организация 7", organizationPath: "Холдинг / Организация 7" };
  const payload = {
    safety,
    catalog: { run_id: "run-7", context_id: "ctx-7", inventory_id: "inventory-7" },
    organization: { id: "org-7", name: "Организация 7", path: "Холдинг / Организация 7" },
  };
  assert.deepEqual(guard(payload, expected), payload.catalog);
  assert.throws(() => guard({ ...payload, catalog: { ...payload.catalog, run_id: "run-other" } }, expected), /не совпадает/);
  assert.throws(() => guard({ ...payload, catalog: { ...payload.catalog, inventory_id: "" } }, expected), /не совпадает/);
  assert.doesNotMatch(JSON.stringify(guard(payload, expected)), /sha|filesystem/i,
    "public draft-binding identity must not expose private SHA or filesystem proof");
});

test("real run-bound shape ignores blank-code structural inventory and builds exact blank-leaf and ERP article catalogs", () => {
  const build = catalogBuilder();
  const payload = actualRunBoundCatalogShape();
  const catalog = build(payload, { organizationName: payload.organization, period: payload.period });
  assert.deepEqual(catalog.intalev, [{
    identity: "INTALEV:BLANK:77",
    code: "R777",
    name: "Выплаты сотрудникам",
    hierarchy_path: "Операционные расходы / Выплаты сотрудникам / <пустое значение>",
    period: "2025-07",
    leaves: [{
      identity: "Операционные расходы / Выплаты сотрудникам / <пустое значение> / Доплата за смену",
      label: "Доплата за смену",
      hierarchy_path: "Операционные расходы / Выплаты сотрудникам / <пустое значение> / Доплата за смену",
      period: "2025-07",
    }],
  }]);
  assert.deepEqual(catalog.erp, [{
    identity: "ERP:ARTICLE:888",
    code: "R888",
    name: "Оплата труда",
    hierarchy_path: "Расходы / Расчёты с персоналом / Оплата труда",
    period: "2025-07",
  }]);
});

test("run-bound catalog fails closed when the exact ERP article catalog is missing or ambiguous", () => {
  const build = catalogBuilder();
  const missing = actualRunBoundCatalogShape();
  missing.hierarchy_periods[0].erp_tree.nodes = [];
  assert.throws(() => build(missing, { organizationName: missing.organization, period: missing.period }),
    /отсутствуют точные доступные строки|каталог/i);

  const ambiguous = actualRunBoundCatalogShape();
  ambiguous.rows.push({ code: "R999", intalev_label: "Другой контроль", intalev_paths: [], erp_paths: [ambiguous.rows[1].erp_paths[0]] });
  assert.throws(() => build(ambiguous, { organizationName: ambiguous.organization, period: ambiguous.period }),
    /отсутствуют точные доступные строки|каталог/i,
    "an ERP node shared by two R-codes must be excluded, leaving no selectable target");
});

test("UI supports several mappings and immutable draft, fix, edit-as-new-version and disable lifecycle", () => {
  const section = bindingSection();
  for (const id of [
    "empty-binding-new",
    "empty-binding-save-draft",
    "empty-binding-fix",
    "empty-binding-edit",
    "empty-binding-disable",
    "empty-binding-list",
  ]) assert.match(section, new RegExp(`id=["']${id}["']`), `${id} control is required`);
  assert.match(section, /Новое соответствие/);
  assert.match(section, /Сохранить черновик/);
  assert.match(section, /Зафиксировать/);
  assert.match(section, /Изменить новой версией/);
  assert.match(section, /Отключить/);
  assert.match(javascript, /["'`]\/api\/empty-article-bindings["'`]/);
  assert.match(javascript, /["'`]\/api\/empty-article-bindings\/fix["'`]/);
  assert.match(javascript, /["'`]\/api\/empty-article-bindings\/disable["'`]/);
  assert.match(javascript, /expected_registry_revision/);
  assert.match(javascript, /source_binding_id:\s*emptyBindingState\.editSourceBindingId/,
    "editing must create a new immutable version in the selected lineage");
  assert.match(javascript, /run_id:\s*draft\.catalog\.run_id/,
    "fix must replay the immutable draft catalog run, not the currently selected run");
  assert.match(javascript, /inventory_id:\s*draft\.catalog\.inventory_id/,
    "fix must replay the immutable draft inventory, not a fabricated client identity");
});

test("draft payload contains only required business identity and concurrency fields", () => {
  for (const field of [
    "organization_id",
    "organization_name",
    "organization_hierarchy_path",
    "valid_from_month",
    "valid_through_month",
    "run_id",
    "inventory_id",
    "source_parent",
    "source_labels",
    "erp_target",
    "expected_registry_revision",
  ]) assert.match(javascript, new RegExp(`${field}:`), `${field} must be sent`);
  assert.doesNotMatch(javascript, /payload_sha256|inventory_binding_sha256|input_hash|proof_json|filesystem_path|approval_status|approval_method|provenance\s*:/i,
    "business UI must not send or render SHA, filesystem, proof JSON, or technical approval/provenance fields");
});

test("UI states UPDATE_MAPPING / БЕЗ ПРОВОДКИ and preserves REPORT_ONLY fail-closed safety", () => {
  const section = bindingSection();
  assert.match(section, /UPDATE_MAPPING\s*\/\s*БЕЗ ПРОВОДКИ/);
  assert.match(section, /не созда[её]т STORNO\/REPOST/iu);
  assert.match(section, /не разрешает загрузку в 1С/iu);
  assert.match(javascript, /function\s+requireEmptyBindingReportOnly\b/);
  assert.match(javascript, /safety\.mode\s*!==\s*["']REPORT_ONLY["']/);
  assert.match(javascript, /safety\.posting_rows\s*!==\s*0/);
  assert.doesNotMatch(javascript, /\/api\/(?:posting|postings|upload|live-1c)\b/i);
  assert.doesNotMatch(javascript, /ready_to_upload\s*:\s*true|release_allowed\s*:\s*true|live_1c_allowed\s*:\s*true|posting_rows\s*:\s*[1-9]/);
});

test("binding API responses require an explicit false execution gate", () => {
  const start = javascript.indexOf("function requireEmptyBindingReportOnly");
  const end = javascript.indexOf("function emptyBindingNormalize", start);
  const source = start >= 0 && end > start ? javascript.slice(start, end) : "";
  assert.ok(source, "REPORT_ONLY guard must be available for behavior regression");
  const guard = new Function(`${source}; return requireEmptyBindingReportOnly;`)();
  const safety = { mode: "REPORT_ONLY", posting_rows: 0, ready_to_upload: false, release_allowed: false, live_1c_allowed: false };
  assert.throws(() => guard({ safety }), /безопасный отчётный режим/,
    "a binding response that omits execution_allowed=false must fail closed");
  assert.doesNotThrow(() => guard({ safety, execution_allowed: false }));
  assert.throws(() => guard({ safety, execution_allowed: true }), /безопасный отчётный режим/);
});
