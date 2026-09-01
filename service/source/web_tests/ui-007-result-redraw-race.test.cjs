const assert = require("node:assert/strict");
const { join } = require("node:path");
const test = require("node:test");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = "";
    this.disabled = false;
    this.href = "";
    this.isConnected = false;
    this.textContent = "";
    this.title = "";
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      child.setConnected(this.isConnected);
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) {
      child.parentNode = null;
      child.setConnected(false);
    }
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
    this.setConnected(false);
  }

  setConnected(value) {
    this.isConnected = value;
    for (const child of this.children) child.setConnected(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  async click() {
    return this.listeners.get("click")?.();
  }

  matchesClass(selector) {
    if (!selector.startsWith(".")) return false;
    const wanted = selector.slice(1);
    return this.className.split(/\s+/).includes(wanted);
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesClass(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector === ":scope > .list-item") {
      return this.children.filter((child) => child.matchesClass(".list-item"));
    }
    return this.children.flatMap((child) => [
      ...(child.matchesClass(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

global.document = { createElement: (tagName) => new Element(tagName) };

const list = new Element("div");
list.setConnected(true);
global.byId = (id) => id === "runsList" ? list : null;
global.state = { snapshot: { runs: [] } };

const { __test } = require(join(__dirname, "..", "web", "results-ui.js"));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function itemFor(run) {
  const item = new Element("div");
  item.className = "list-item";
  item.dataset.runId = run.id;
  return item;
}

function redraw(run) {
  const item = itemFor(run);
  list.replaceChildren(item);
  __test.syncResults([run]);
  return item;
}

function resultText(item) {
  function collect(node) {
    return [node.textContent, ...node.children.flatMap(collect)].filter(Boolean);
  }
  return collect(item.querySelector(".run-results")).join(" | ");
}

function r005(ready = true) {
  return ready ? {
    ready: true,
    files: [{ name: "reconciliation.xlsx", kind: "reconciliation", url: "/r005.xlsx" }],
  } : { ready: false, files: [] };
}

function r001(ready = true) {
  return ready ? {
    ready: true,
    archive_url: "/r001.zip",
    files: [{ name: "technical/manifest.json", kind: "manifest", url: "/r001-manifest.json" }],
  } : { ready: false, files: [] };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function resetHarness() {
  list.replaceChildren();
  __test.expandedRunIds.clear();
  __test.resultCache.clear();
  __test.resultInflight.clear();
}

test("UI-007 opened result survives a same-status bootstrap redraw without duplicate fetches", async () => {
  resetHarness();
  const calls = [];
  const pending = [];
  global.api = (url) => {
    calls.push(url);
    const request = deferred();
    pending.push(request);
    return request.promise;
  };

  const run = { id: "run_same_status", status: "RUNNING", stage: "R005" };
  const original = redraw(run);
  assert.equal(calls.length, 0, "unopened historical results must remain lazy");

  const clicked = original.querySelector(".run-result-loader").click();
  await settle();
  assert.equal(calls.length, 2, "one click starts one R005/R001 request pair");

  const replacement = redraw(run);
  await settle();
  assert.equal(calls.length, 2, "same-status redraw must reuse the in-flight pair");
  assert.ok(replacement.querySelector(".run-results"), "replacement node owns a pending result holder");

  pending[0].resolve(r005());
  pending[1].resolve(r001(false));
  await clicked;
  await settle();
  assert.match(resultText(replacement), /Сверка R005 \| Готово/);

  const cachedReplacement = redraw(run);
  await settle();
  assert.equal(calls.length, 2, "same-status cached redraw must not refetch");
  assert.match(resultText(cachedReplacement), /Сверка R005 \| Готово/);
});

test("UI-007 terminal redraw starts a fresh pair and stale running response cannot poison it", async () => {
  resetHarness();
  const calls = [];
  const pending = [];
  global.api = (url) => {
    calls.push(url);
    const request = deferred();
    pending.push(request);
    return request.promise;
  };

  const running = { id: "run_status_change", status: "RUNNING", stage: "R001" };
  const original = redraw(running);
  const clicked = original.querySelector(".run-result-loader").click();
  await settle();
  assert.equal(calls.length, 2);

  const terminal = { ...running, status: "COMPLETED_REPORT_ONLY", stage: "DONE" };
  const terminalItem = redraw(terminal);
  await settle();
  assert.equal(calls.length, 4, "status transition requires a fresh R005/R001 pair");

  pending[2].resolve(r005());
  pending[3].resolve(r001());
  await settle();
  assert.match(resultText(terminalItem), /Сверка R005 \| Готово/);
  assert.match(resultText(terminalItem), /Результат R001 \| Готово/);

  pending[0].resolve(r005(false));
  pending[1].resolve(r001(false));
  await clicked;
  await settle();

  const finalReplacement = redraw(terminal);
  await settle();
  assert.equal(calls.length, 4, "late stale response must not invalidate terminal cache");
  assert.match(resultText(finalReplacement), /Сверка R005 \| Готово/);
  assert.match(resultText(finalReplacement), /Результат R001 \| Готово/);
});
