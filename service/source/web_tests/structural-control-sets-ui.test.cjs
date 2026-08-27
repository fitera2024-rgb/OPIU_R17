const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");

function builtInUI() {
  const html = readFileSync(join(webRoot, "index.html"), "utf8");
  const linkedScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']\/([^"']+\.js)["'][^>]*>/gi)]
    .map((match) => match[1]);
  assert.ok(linkedScripts.length > 0, "index.html must load built-in JavaScript assets");
  const javascript = linkedScripts
    .map((relativePath) => `\n/* ${relativePath} */\n${readFileSync(join(webRoot, relativePath), "utf8")}`)
    .join("\n");
  return { html, javascript, combined: `${html}\n${javascript}` };
}

function structuralSection(html) {
  const start = html.indexOf('id="view-structural-groups"');
  assert.ok(start >= 0, "built-in UI must contain the structural-groups business view");
  const next = html.indexOf('<section id="view-', start + 1);
  return html.slice(start, next >= 0 ? next : html.length);
}

test("built-in UI exposes an organization/run-bound block-group business section", () => {
  const { html } = builtInUI();
  assert.match(html, /data-view=["']structural-groups["']/);
  assert.match(html, /id=["']view-structural-groups["']/);
  assert.match(html, /Группы блоков Инталев и ERP/);
  assert.match(html, /Настройка для выбранной организации/);
  assert.match(html, /id=["']structural-organization["']/);
  assert.match(html, /id=["']structural-run["']/);
  assert.match(html, /id=["']structural-inventory-status["']/);
});

test("built-in UI keeps separate Intalev and ERP selectors and supports several sets", () => {
  const { html, javascript } = builtInUI();
  const section = structuralSection(html);
  assert.match(section, /id=["']structural-intalev-inventory["']/);
  assert.match(section, /Блоки Инталев/);
  assert.match(section, /id=["']structural-erp-inventory["']/);
  assert.match(section, /Блоки ERP/);
  assert.match(section, /id=["']structural-control-set-list["']/);
  assert.match(section, /id=["']structural-new-set["']/);
  assert.match(section, /Можно добавить несколько групп/);
  assert.match(javascript, /function\s+renderStructuralControlSets\b/);
  assert.match(javascript, /data-structural-version/);
  assert.match(javascript, /intalev_members/);
  assert.match(javascript, /erp_members/);
  assert.doesNotMatch(javascript, /member_codes/,
    "typed Intalev/ERP selections must not be collapsed into one untyped member_codes list");
});

test("fixed-set list exposes server integer-cent delta and structural status", () => {
  const { javascript } = builtInUI();
  const renderStart = javascript.indexOf("function renderStructuralControlSets");
  const renderEnd = javascript.indexOf("async function loadStructuralControlSets", renderStart);
  const render = javascript.slice(renderStart, renderEnd);
  assert.match(render, /version\.control_delta_cents/);
  assert.match(render, /version\.control_status/);
  assert.match(render, /структурный итог закрыт/);
  assert.match(render, /открытый межгрупповой пересорт/);
});

test("built-in UI provides draft, fix, edit-as-new-version and disable lifecycle", () => {
  const { html, javascript } = builtInUI();
  const section = structuralSection(html);
  for (const id of [
    "structural-save-draft",
    "structural-fix-version",
    "structural-edit-version",
    "structural-disable-set",
  ]) {
    assert.match(section, new RegExp(`id=["']${id}["']`), `${id} control is required`);
  }
  assert.match(section, /Сохранить черновик/);
  assert.match(section, /Зафиксировать версию/);
  assert.match(section, /Изменить новой версией/);
  assert.match(section, /Отключить/);

  assert.match(javascript, /function\s+(?:create|save)StructuralControlDraft\b/);
  assert.match(javascript, /function\s+fixStructuralControl(?:Set|Version)\b/);
  assert.match(javascript, /function\s+editStructuralControlSet\b/);
  assert.match(javascript, /function\s+disableStructuralControlSet\b/);
  assert.match(javascript, /expected_registry_revision/,
    "draft/fix/edit/disable must use optimistic registry revision control");
  assert.match(javascript, /source_control_set_id/,
    "editing a fixed set must create a new immutable version in the same lineage");
});

test("built-in UI calls the exact structural-control API with organization, run and inventory identity", () => {
  const { javascript } = builtInUI();
  assert.match(javascript, /function\s+loadStructuralControlSets\b/);
  assert.match(javascript, /["'`]\/api\/structural-control-sets["'`]/,
    "GET and draft POST use the collection endpoint");
  assert.match(javascript, /["'`]\/api\/structural-control-sets\/preview["'`]/);
  assert.match(javascript, /["'`]\/api\/structural-control-sets\/fix["'`]/);
  assert.match(javascript, /["'`]\/api\/structural-control-sets\/disable["'`]/);
  assert.match(javascript, /organization_id/);
  assert.match(javascript, /run_id/);
  assert.match(javascript, /inventory_id/);
  assert.doesNotMatch(javascript, /\/api\/structural-control-sets\/draft/,
    "draft POST belongs to /api/structural-control-sets, not an incompatible /draft route");
});

test("zero and nonzero previews use server cents and explain continued child checking", () => {
  const { html, javascript, combined } = builtInUI();
  const section = structuralSection(html);
  assert.match(section, /Итого Инталев/);
  assert.match(section, /Итого ERP/);
  assert.match(section, /Дельта контроля/);
  assert.match(javascript, /intalev_total_cents/);
  assert.match(javascript, /erp_total_cents/);
  assert.match(javascript, /control_delta_cents/);
  assert.match(javascript, /INTRA_CONTROL_SET_RECLASS_CLOSED/);
  assert.match(javascript, /INTER_GROUP_RECLASS_OPEN/);
  assert.match(combined, /Дочерние (?:строки|записи) (?:всё равно|остаются).*провер/iu,
    "zero closes only the structural effect; child records must still be checked");
  assert.match(combined, /(?:не равна нулю|остаток не закрыт).*межгрупповой пересорт/iu,
    "nonzero must be explained as an open inter-group reclassification");
});

test("structural UI remains REPORT_ONLY and exposes no READY or physical posting fields", () => {
  const { html, javascript } = builtInUI();
  const section = structuralSection(html);
  assert.match(html, /REPORT_ONLY/);
  assert.match(section, /не созда[её]т проводки/iu);
  assert.match(section, /не заполня[её]т неизвестные физические поля/iu);
  assert.match(section, /не разрешает загрузку в 1С/iu);
  assert.match(javascript, /REPORT_ONLY/,
    "structural API responses must be rejected unless the safety mode is REPORT_ONLY");
  assert.doesNotMatch(section, /\bREADY\b|SourceRowID|source_row_id|physical_source|debit_account|credit_account/i);
  assert.doesNotMatch(javascript, /\bREADY\b|SourceRowID|source_row_id|physical_source/);
  assert.doesNotMatch(javascript,
    /ready_to_upload\s*:\s*true|release_allowed\s*:\s*true|live_1c_allowed\s*:\s*true|posting_rows\s*:\s*[1-9]/);
  assert.doesNotMatch(javascript, /\/api\/(?:posting|postings|upload|live-1c)\b/i,
    "block-group settings must never call a posting, upload, or live 1C endpoint");
});
