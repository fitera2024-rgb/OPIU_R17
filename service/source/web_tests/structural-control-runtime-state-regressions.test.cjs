const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const script = readFileSync(join(webRoot, "structural-control-ui.js"), "utf8");

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

test("scope reset clears the prior organization and preview text plus semantic class", () => {
  const reset = functionSource("resetStructuralControlEditorState");
  const visuals = functionSource("clearStructuralControlVisuals");
  const combinedReset = `${reset}\n${visuals}`;
  assert.match(combinedReset,
    /structural-organization[\s\S]*(?:replaceChildren|\.value\s*=)/,
    "a run switch or failed discovery must remove the previous organization from the visible scope");
  assert.match(combinedReset,
    /structural-preview-message[\s\S]*(?:textContent|replaceChildren)/,
    "a run switch or failed discovery must replace the previous zero/nonzero explanation");
  assert.match(combinedReset,
    /structural-preview-message[\s\S]*(?:className|classList)/,
    "a run switch or failed discovery must remove the previous good/warn/error class");

  const preview = functionSource("previewStructuralControlSet");
  const incompleteSelection = preview.match(/if\s*\([^)]*(?:intalev_members|erp_members|inventoryId)[\s\S]*?\)\s*\{([\s\S]*?)\n\s*return;/);
  assert.ok(incompleteSelection, "preview must have an explicit incomplete-selection branch");
  assert.match(incompleteSelection[1], /(?:className|classList)/,
    "the neutral choose-both-sides message must not retain a prior good/warn/error class");
});

test("action reload has an explicit option that preserves the returned draft or fixed version", () => {
  const load = functionSource("loadStructuralControlSets");
  assert.match(load, /(?:options|preserve)/i,
    "reload must expose an explicit preservation option instead of always resetting action state");

  const save = functionSource("saveStructuralControlDraft");
  assert.match(save, /loadStructuralControlSets\s*\(\s*\{[\s\S]*preserv/i,
    "after save, reload must preserve and reselect the server-returned draft");

  const fix = functionSource("fixStructuralControlVersion");
  assert.match(fix, /loadStructuralControlSets\s*\(\s*\{[\s\S]*preserv/i,
    "after fix, reload must preserve and reselect the server-returned immutable version");
});

test("snapshot refresh resets the editor when its selected run disappears from eligibility", () => {
  const options = functionSource("renderStructuralRunOptions");
  assert.match(options, /resetStructuralControlEditorState\s*\(|loadStructuralControlSets\s*\(/,
    "removing the selected run from the picker must actively clear the old run-bound editor");
  assert.match(options, /structuralState\.runId/,
    "eligibility loss must be checked against the editor's server-bound run, not only the select element");
});

test("historical drafts are read-only outside their exact run and inventory", () => {
  const render = functionSource("renderStructuralControlSets");
  assert.match(render, /draft\.run_id\s*===\s*structuralState\.runId|structuralState\.runId\s*===\s*draft\.run_id/,
    "draft lifecycle actions require the exact server-bound run");
  assert.match(render, /draft\.inventory_id\s*===\s*structuralState\.inventoryId|structuralState\.inventoryId\s*===\s*draft\.inventory_id/,
    "draft lifecycle actions require the exact server-bound inventory");
  assert.match(render, /истори|только просмотр|read.?only/iu,
    "a stale draft needs a visible business read-only explanation");

  const select = functionSource("selectStructuralControlDraft");
  assert.match(select, /draft\.run_id[\s\S]*structuralState\.runId/,
    "selecting a stale draft must not enable Fix under another run");
  assert.match(select, /draft\.inventory_id[\s\S]*structuralState\.inventoryId/,
    "selecting a stale draft must not enable Fix under another inventory");
});

test("disable reason is explained when empty and cleared after use or scope reset", () => {
  const disable = functionSource("disableStructuralControlSet");
  assert.match(disable,
    /if\s*\(\s*!reason\s*\)\s*\{[\s\S]*(?:structural-preview-message|showStructuralControlError)[\s\S]*return[\s\S]*\}/,
    "an empty required reason must produce a visible business explanation");
  assert.match(disable,
    /structural-disable-reason[\s\S]*\.value\s*=\s*["']{2}/,
    "a successfully used reason must be cleared instead of being reused for another set");

  const newSet = functionSource("resetStructuralControlEditor");
  assert.match(newSet, /structural-disable-reason[\s\S]*\.value\s*=\s*["']{2}/,
    "starting a new set must clear the previous audit reason");
  const resetScope = functionSource("resetStructuralControlEditorState");
  assert.match(resetScope, /structural-disable-reason[\s\S]*\.value\s*=\s*["']{2}/,
    "switching run scope must clear the previous audit reason");
});

test("server response and fixed versions require the exact organization context run and inventory", () => {
  const load = functionSource("loadStructuralControlSets");
  assert.match(load, /payload\.run_id\s*!==\s*runId/,
    "the selected run must match the returned registry scope");
  assert.match(load, /payload\.context_id\s*!==\s*expectedContextId/,
    "the selected context must match the returned registry scope");
  assert.match(load, /payload\.organization\?\.id\s*!==\s*expectedOrganizationId/,
    "the stable organization id must match the returned registry scope");
  assert.match(load, /throw\s+new\s+Error/,
    "a mismatched scope response must be rejected instead of rendered");

  const exact = functionSource("structuralControlVersionIsExact");
  for (const field of ["organization_id", "context_id", "run_id", "inventory_id", "status"]) {
    assert.match(exact, new RegExp(`version\\.${field}`), `${field} must participate in exact fixed-version scope`);
  }

  const select = functionSource("selectStructuralControlSet");
  assert.match(select, /structuralControlVersionIsExact[\s\S]*return/,
    "a historical selection must return before server preview");
});
