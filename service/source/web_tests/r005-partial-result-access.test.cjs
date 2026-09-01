const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const app = readFileSync(join(dirname(__filename), "..", "web", "app.js"), "utf8");
const results = readFileSync(join(dirname(__filename), "..", "web", "results-ui.js"), "utf8");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.href = "";
    this.textContent = "";
    this.title = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

global.document = { createElement: (tagName) => new Element(tagName) };

const { stageBox } = require(join(dirname(__filename), "..", "web", "results-ui.js"));

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

test("R005-016 keeps top-level access for terminal R001 failure", () => {
  assert.match(app, /run\.status\s*===\s*"FAILED"[\s\S]*?startsWith\("R001"\)/);
  assert.match(app, /INTERRUPTED_SERVICE_RESTART"\s*&&\s*run\.has_structural_inventory/);
  assert.match(app, /Открыть доступные результаты/);
});

test("R005-016 passes terminal run context to both independent result sections", () => {
  assert.match(results, /stageBox\("r005",\s*r005,\s*run\)/);
  assert.match(results, /retained_r005_ready:\s*Boolean\(r005\?\.ready\)/);
  assert.match(results, /stageBox\("r001",\s*r001,\s*downstreamRun\)/);
  assert.match(results, /\/api\/runs\/\$\{encodeURIComponent\(run\.id\)\}\/diagnostics/);
});

test("R005-016 never exposes unverified R001 files after failure", () => {
  const box = stageBox("r001", {
    ready: false,
    verified_package_available: false,
    files: [{ name: "unverified.xlsx", kind: "decisions", url: "/must-not-be-exposed" }],
  }, {
    id: "run_invalid_r001",
    status: "FAILED",
    stage: "R001",
    message: "R001 не сформирован: выходной комплект R001 не прошёл проверку целостности",
  });
  const links = descendants(box).filter((element) => element.tagName === "a");
  assert.deepEqual(links.map((link) => link.href), ["/api/runs/run_invalid_r001/diagnostics"]);
});

test("R005-016 failed R001 exposes only verified technical diagnostics", () => {
  const box = stageBox("r001", {
    ready: false,
    verified_package_available: true,
    files: [
      {
        name: "service-report-package/technical/diagnostics.json",
        kind: "diagnostics",
        url: "/verified-r001-diagnostics",
      },
      {
        name: "OPIU/Решения.xlsx",
        kind: "decisions",
        url: "/must-not-expose-decisions",
      },
    ],
  }, {
    id: "run_failed_with_diagnostic_package",
    status: "FAILED",
    stage: "R001",
    message: "R001 не сформирован: процесс R001 завершился ошибкой",
  });
  const links = descendants(box).filter((element) => element.tagName === "a");
  assert.deepEqual(links.map((link) => link.href), [
    "/verified-r001-diagnostics",
    "/api/runs/run_failed_with_diagnostic_package/diagnostics",
  ]);
  assert.ok(!links.some((link) => link.href === "/must-not-expose-decisions"));
});
