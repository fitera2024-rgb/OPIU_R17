const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const javascript = readFileSync(join(webRoot, "structural-control-ui.js"), "utf8");

test("v3 candidates require an accessible explicit control-only declaration", () => {
  assert.match(html, /id=["']structural-control-declaration["']/);
  assert.match(html, /aria-describedby=["']structural-control-declaration-help["']/);
  assert.match(html, /Объявляю выбранные строки контрольными блоками/);
  assert.match(html, /не признаны бизнес-блоками автоматически/);
  assert.match(html, /не создаёт проводок и не даёт права на корректировку/);
  assert.match(javascript, /control_only_declaration\s*:/);
  assert.match(javascript, /user_declaration_required\s*===\s*true/);
  assert.match(javascript, /structural-save-draft["']\)\.disabled\s*=\s*!accepted/);
  assert.match(javascript, /structural-fix-version["']\)\.disabled\s*=\s*!structuralState\.currentDraftId\s*\|\|\s*!accepted/);
});

test("v3 declaration is reset across a new run or version and private proof stays hidden", () => {
  assert.match(javascript, /structural-control-declaration["']\)\.checked\s*=\s*false/g);
  assert.match(javascript, /function\s+resetStructuralControlEditorState\b/);
  assert.match(javascript, /function\s+editStructuralControlSet\b[\s\S]*?declaration\.checked\s*=\s*false/);
  assert.match(javascript, /Кандидат — блок объявляет пользователь/);
  assert.doesNotMatch(html + javascript, /source_identity|source_identity_scope|source_cell|current_run_provenance|sha256/i);
});

test("v3 declaration never grants correction or posting authority", () => {
  assert.match(html, /только как контроль структуры/);
  assert.doesNotMatch(javascript, /correction_authority\s*:\s*true/);
  assert.doesNotMatch(javascript, /ready_to_upload\s*:\s*true|release_allowed\s*:\s*true|live_1c_allowed\s*:\s*true/);
});
