const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const app = readFileSync(join(webRoot, "app.js"), "utf8");
const diagnostics = readFileSync(join(webRoot, "diagnostics-ui.js"), "utf8");
const results = readFileSync(join(webRoot, "results-ui.js"), "utf8");

test("UI-007 bootstrap refresh is single-flight and polling pauses for mutations", () => {
  assert.match(app, /refreshPromise:\s*null/);
  assert.match(app, /if\s*\(state\.refreshPromise\)\s*return\s+state\.refreshPromise/);
  assert.match(app, /if\s*\(!force\)\s*return\s+state\.refreshPromise;[\s\S]*?await\s+state\.refreshPromise/,
    "a forced post-mutation refresh must wait for and then supersede an older in-flight snapshot");
  assert.match(app, /if\s*\(!force\s*&&\s*pollingPaused\(\)\)\s*return\s+state\.snapshot/);
  assert.match(app, /state\.refreshPromise\s*=\s*null/);
  assert.match(app, /mutationDepth:\s*0/);
  assert.match(app, /function\s+beginMutation\s*\(/);
  assert.match(app, /function\s+endMutation\s*\(/);
  assert.match(app, /if\s*\(!pollingPaused\(\)\s*&&\s*!state\.activeRunId\)\s*void\s+refresh\(\)/,
    "generic polling must remain paused while an exact run is being tracked");
  assert.match(app, /},\s*10000\s*\)/);
});

test("UI-007 upload reports ERP and Intalev as separate finite stages", () => {
  assert.match(app, /label:\s*"ERP"/);
  assert.match(app, /label:\s*"Инталев"/);
  assert.match(app, /`Загружаем \$\{stage\.label\} \(\$\{index \+ 1\} из \$\{stages\.length\}\)…`/);
  assert.match(app, /Переходим к следующему файлу/);
  assert.match(app, /Можно создавать контекст/);
  assert.match(app, /finally\s*\{[\s\S]*?button\.disabled\s*=\s*false;[\s\S]*?endMutation\(\)/);
});

test("UI-007 diagnostics consumes bootstrap events and owns no parallel runs poll", () => {
  assert.match(diagnostics, /addEventListener\("opiu:bootstrap-updated"/);
  assert.match(diagnostics, /renderDiagnosticRuns\(event\.detail\?\.runs\s*\|\|\s*\[\]\)/);
  assert.doesNotMatch(diagnostics, /fetch\("\/api\/runs"\)/);
  assert.doesNotMatch(diagnostics, /setInterval\s*\(/);
  assert.match(diagnostics, /\.slice\(0,\s*25\)/);
});

test("UI-007 historical results are lazy and fetched only from a user click", () => {
  assert.doesNotMatch(results, /new\s+MutationObserver\s*\(/);
  assert.match(results, /textContent\s*=\s*"Показать результаты"/);
  assert.match(results, /button\.addEventListener\("click",\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await\s+loadForItem\(item,\s*run\)/);
  const syncStart = results.indexOf("function syncResults");
  const exportStart = results.indexOf("if (typeof module", syncStart);
  assert.ok(syncStart >= 0 && exportStart > syncStart);
  assert.doesNotMatch(results.slice(syncStart, exportStart), /loadForItem\s*\(/,
    "a bootstrap render must not fetch every historical result");
  assert.match(results, /resultInflight\.get\(run\.id\)/);
  assert.match(results, /resultCache\.get\(run\.id\)/);
});
