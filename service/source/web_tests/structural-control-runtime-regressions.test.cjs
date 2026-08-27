const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const script = readFileSync(join(webRoot, "structural-control-ui.js"), "utf8");
const html = readFileSync(join(webRoot, "index.html"), "utf8");

function functionSource(name) {
  const marker = `function ${name}`;
  const start = script.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = script.indexOf("{", start + marker.length);
  assert.ok(bodyStart >= 0, `${name} must have a body`);
  let depth = 0;
  for (let index = bodyStart; index < script.length; index += 1) {
    if (script[index] === "{") depth += 1;
    if (script[index] === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body is not balanced`);
}

test("render preserves the selected fixed version member arrays", () => {
  const render = functionSource("renderStructuralControlSets");
  assert.match(render,
    /renderStructuralMembers\(["']intalev["'][\s\S]*selectedVersion[\s\S]*intalev_members/,
    "registry re-render must retain the selected version's Intalev members");
  assert.match(render,
    /renderStructuralMembers\(["']erp["'][\s\S]*selectedVersion[\s\S]*erp_members/,
    "registry re-render must retain the selected version's ERP members");
});

test("GET drafts are selectable and restore their immutable server-bound composition", () => {
  assert.match(script, /function\s+selectStructuralControlDraft\b/,
    "persisted drafts need a restoration handler after reload");
  assert.match(script, /data-structural-draft-id/,
    "each draft in the registry list needs its server draft identity");
  const render = functionSource("renderStructuralControlSets");
  assert.match(render, /draft\.draft_id/);
  assert.match(render, /draft\.intalev_members/);
  assert.match(render, /draft\.erp_members/);
});

test("run switch and discovery failure clear every prior editor scope", () => {
  const resetMatch = script.match(/function\s+(resetStructuralControl(?:Run|Scope|Editor)State)\b/);
  assert.ok(resetMatch,
    "run-bound state must have one explicit fail-closed reset");
  const resetName = resetMatch[1];
  const reset = functionSource(resetName);
  for (const field of [
    "inventoryId",
    "payload",
    "currentDraftId",
    "selectedControlSetId",
    "editSourceControlSetId",
    "editLineageId",
  ]) {
    assert.match(reset, new RegExp(`structuralState\\.${field}\\s*=`), `${field} must be cleared`);
  }
  const load = functionSource("loadStructuralControlSets");
  const resetCall = load.indexOf(`${resetName}(`);
  const request = load.indexOf("await api(");
  assert.ok(resetCall >= 0 && request >= 0 && resetCall < request,
    "load must clear the old scope before discovery, which also keeps failures empty");
});

test("load and preview discard stale asynchronous responses", () => {
  const load = functionSource("loadStructuralControlSets");
  const preview = functionSource("previewStructuralControlSet");
  assert.ok(/loadGeneration|loadAbortController/.test(script),
    "load requests require a generation token or AbortController");
  assert.ok(/previewGeneration|previewAbortController/.test(script),
    "preview requests require an independent generation token or AbortController");
  assert.match(load, /loadGeneration|loadAbortController/);
  assert.match(preview, /previewGeneration|previewAbortController/);
  assert.match(load, /runId\s*!==\s*(?:structuralState\.runId|byId\(["']structural-run["']\)\.value)|signal\.aborted|generation\s*!==[\s\S]*loadGeneration/i,
    "a late run response must not overwrite the newly selected run");
});

test("REPORT_ONLY guard requires every safety gate to be explicitly false", () => {
  const guard = functionSource("requireStructuralReportOnly");
  assert.match(guard, /safety\.report_only\s*!==\s*true/);
  assert.match(guard, /safety\.ready_to_upload\s*!==\s*false/);
  assert.match(guard, /safety\.release_allowed\s*!==\s*false/);
  assert.match(guard, /safety\.live_1c_allowed\s*!==\s*false/);
  assert.match(guard, /safety\.posting_rows\s*!==\s*0/);
  assert.match(guard, /safety\.executed_posting_rows\s*!==\s*0/);
  assert.match(guard, /safety\.live_posting_rows\s*!==\s*0/);
  assert.match(guard, /safety\.execution_allowed\s*!==\s*false/);
  assert.match(guard, /safety\.live_delete_allowed\s*!==\s*false/);
});

test("client has no authority to close a nonzero cent delta", () => {
  const payload = functionSource("structuralSelectionPayload");
  assert.match(payload, /tolerance_cents\s*:\s*0\b/,
    "contract closure is exact zero, not plus or minus one cent");
  assert.doesNotMatch(payload, /tolerance_cents\s*:\s*[1-9]/);
});

test("run picker does not advertise failed or merely finished runs as eligible", () => {
  const options = functionSource("renderStructuralRunOptions");
  assert.doesNotMatch(options, /run\.finished_at\s*\|\|/,
    "finished_at is shared by failed and blocked runs and cannot prove R005 inventory");
  assert.match(options, /R005_COMPLETED|structural_inventory_(?:ready|verified)|has_structural_inventory/,
    "eligibility must be based on a proven structural inventory or completed R005 stage");
});

test("historical versions are visibly read-only outside their exact run and inventory", () => {
  const render = functionSource("renderStructuralControlSets");
  assert.match(script, /version\.run_id/);
  assert.match(script, /version\.inventory_id/);
  assert.match(script, /structuralState\.runId/);
  assert.match(script, /structuralState\.inventoryId/);
  assert.match(render, /истори|только просмотр|read.?only/iu,
    "old fixed versions need a business read-only explanation");
});

test("disable requires confirmation and a user-entered audit reason", () => {
  assert.match(html, /id=["']structural-disable-reason["']/,
    "disable reason must be an explicit business input");
  const disable = functionSource("disableStructuralControlSet");
  assert.match(disable, /\bconfirm\s*\(/,
    "a fixed lifecycle version must not be disabled by an accidental single click");
  assert.match(disable, /structural-disable-reason/);
  assert.doesNotMatch(disable, /reason\s*:\s*["']Отключено пользователем["']/,
    "a hardcoded reason is not an audit trail");
});

test("dynamic structural state is announced and selected buttons expose aria state", () => {
  assert.match(html,
    /id=["']structural-preview-message["'][^>]*(?:role=["']status["']|aria-live=["'](?:polite|assertive)["'])/i,
    "the changing zero/nonzero/error explanation must be a live status");
  assert.match(script, /aria-pressed|aria-current/,
    "the selected fixed version needs a programmatic accessibility state");
});
