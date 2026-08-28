const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const app = readFileSync(join(dirname(__filename), "..", "web", "app.js"), "utf8");

test("UI-009 stores the exact POST run ID and polls only that run", () => {
  assert.match(app, /activeRunId:\s*""/);
  assert.match(app, /state\.activeRunId\s*=\s*run\.id;[\s\S]*?renderActiveRunStatus\(run\)/);
  assert.match(app, /const exactRunId\s*=\s*state\.activeRunId/);
  assert.match(app, /api\(`\/api\/runs\/\$\{encodeURIComponent\(exactRunId\)\}`\)/);
  assert.match(app, /activeRunPollPromise/);
  assert.doesNotMatch(app, /pollActiveRun[\s\S]*?api\("\/api\/runs"\)/,
    "the active lifecycle must never infer state from the whole run list");
});

test("UI-009 maps the lifecycle to Russian user-visible stages", () => {
  for (const label of [
    "В очереди",
    "Проверяем входные данные",
    "R005 — формируем сверку",
    "Проверяем структуру и доказательства",
    "R001 — формируем комплект корректировок",
    "Готово",
    "Запуск остановлен безопасно",
    "Запуск завершился ошибкой",
  ]) assert.match(app, new RegExp(label));
  assert.match(app, /Причина:\s*\$\{run\.message\}/);
  assert.match(app, /run\.finished_at/);
  assert.match(app, /Запуск \$\{run\.id\} · \$\{timeLabel\}/);
});

test("UI-009 blocks duplicate starts and stops exact polling at terminal state", () => {
  assert.match(app, /const ACTIVE_RUN_STATUSES = new Set\(\["QUEUED", "PREFLIGHT", "RUNNING"\]\)/);
  assert.match(app, /button\.disabled\s*=\s*Boolean\(state\.activeRunId\)/);
  assert.match(app, /if\s*\(state\.activeRunId\)\s*\{[\s\S]*?ещё выполняется/);
  assert.match(app, /if\s*\(terminal\)\s*\{[\s\S]*?stopActiveRunPolling\(\);[\s\S]*?state\.activeRunId\s*=\s*""/);
  assert.match(app, /if\s*\(terminal\)\s*await\s+refresh\(\{ force: true \}\)/);
  assert.match(app, /if\s*\(!pollingPaused\(\)\s*&&\s*!state\.activeRunId\)\s*void\s+refresh\(\)/);
});

test("UI-009 completed runs expose a stable result link", () => {
  assert.match(app, /item\.id\s*=\s*`run-\$\{run\.id\}`/);
  assert.match(app, /run\.status\s*===\s*"COMPLETED_REPORT_ONLY"/);
  assert.match(app, /link\.href\s*=\s*`#run-\$\{run\.id\}`/);
  assert.match(app, /link\.textContent\s*=\s*" Открыть результат"/);
});
