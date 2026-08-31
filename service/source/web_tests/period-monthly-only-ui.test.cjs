const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const app = readFileSync(join(webRoot, "app.js"), "utf8");

test("PERIOD-002 UI offers one concrete monthly calculation scope", () => {
  assert.match(html, /<label>Месяц расчёта\s*<input id="period" type="month">/);
  assert.equal((html.match(/id="period"/g) || []).length, 1,
    "the calculation form must expose exactly one period control");
  assert.doesNotMatch(html, /id="period"[^>]+type="(?:date|text|number)"/,
    "the calculation period must not offer a year, range, or free-form control");
  assert.match(app, /if\s*\(!period\)\s*throw new Error\("Выберите месяц"\)/);
});
