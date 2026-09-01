const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");

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

const { stageBox } = require(join(__dirname, "..", "web", "results-ui.js"));

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function visibleText(element) {
  return descendants(element).map((item) => item.textContent).filter(Boolean).join(" ");
}

test("R005-016 shows retained R005 and the exact downstream R001 failure", () => {
  const run = {
    id: "run_sakhalin_forced_r001_failure",
    status: "FAILED",
    stage: "R001",
    message: "R001 не сформирован: принудительная проверочная ошибка после успешной R005",
  };
  const r005 = {
    stage: "R005",
    ready: true,
    verified_package_available: true,
    files: [
      { name: "reconciliation.xlsx", kind: "reconciliation", url: "/r005.xlsx" },
      { name: "reconciliation.codex-input.json", kind: "details", url: "/r005-details" },
      { name: "reconciliation.manifest.json", kind: "manifest", url: "/r005-manifest" },
    ],
  };
  const r001 = {
    stage: "R001",
    ready: false,
    verified_package_available: false,
    files: [],
  };

  const r005Box = stageBox("r005", r005, run);
  assert.match(visibleText(r005Box), /Сверка R005 Готово/);
  assert.deepEqual(
    descendants(r005Box).filter((item) => item.tagName === "a").map((item) => item.href),
    ["/r005.xlsx", "/r005-details", "/r005-manifest"],
  );

  const r001Text = visibleText(stageBox("r001", r001, run));
  assert.match(r001Text, /R001.*(?:ошиб|не сформирован)/i,
    "terminal R001 failure must not be presented as the ambiguous in-progress state");
  assert.match(r001Text, /принудительная проверочная ошибка после успешной R005/,
    "the R001 section must expose the exact downstream failure reason");
});

test("R005-016 reload shows anchored R005 after interrupted Service restart", () => {
  const run = {
    id: "run_sakhalin_interrupted_after_r005",
    status: "FAILED",
    stage: "INTERRUPTED_SERVICE_RESTART",
    message: "Предыдущий экземпляр OPIU завершился до окончания расчёта. Запустите сверку повторно",
    has_structural_inventory: true,
  };
  const r005 = {
    stage: "R005",
    ready: true,
    verified_package_available: true,
    files: [{ name: "reconciliation.xlsx", kind: "reconciliation", url: "/restart-r005.xlsx" }],
  };
  const r001 = { stage: "R001", ready: false, verified_package_available: false, files: [] };

  const r005Box = stageBox("r005", r005, run);
  assert.match(visibleText(r005Box), /Сверка R005 Готово/);
  assert.deepEqual(
    descendants(r005Box).filter((item) => item.tagName === "a").map((item) => item.href),
    ["/restart-r005.xlsx"],
  );
  const r001Box = stageBox("r001", r001, run);
  assert.match(visibleText(r001Box), /R001 не сформирован/);
  assert.match(visibleText(r001Box), /Предыдущий экземпляр OPIU завершился/);
  assert.deepEqual(
    descendants(r001Box).filter((item) => item.tagName === "a").map((item) => item.href),
    ["/api/runs/run_sakhalin_interrupted_after_r005/diagnostics"],
  );
});
