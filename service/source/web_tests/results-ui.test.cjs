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

test("UI-012 renders the archive and every canonical R001 result link", () => {
  const files = [
    { name: "OPIU/Решения.xlsx", kind: "decisions", size: 23726, url: "/result/file?path=decisions" },
    { name: "OPIU/СПОРНО/[ГК][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx", kind: "disputed", size: 6456, url: "/result/file?path=sporno-1" },
    { name: "OPIU/СПОРНО/[ООО Группа компаний Планета][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx", kind: "disputed", size: 7147, url: "/result/file?path=sporno-2" },
    { name: "OPIU/СПОРНО/[ООО Планета Инноваций][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx", kind: "disputed", size: 6146, url: "/result/file?path=sporno-3" },
  ];
  const archiveURL = "/api/runs/run-ui012/result/r001?archive=1";
  const box = stageBox("r001", {
    ready: true,
    verified_package_available: true,
    archive_url: archiveURL,
    files,
  });

  const links = descendants(box).filter((element) => element.tagName === "a");
  assert.deepEqual(links.map((link) => link.href), [archiveURL, ...files.map((file) => file.url)]);
  assert.deepEqual(links.slice(1).map((link) => link.title), files.map((file) => file.name));
  assert.equal(links[0].attributes.get("download"), "R001.zip");
  assert.ok(links.slice(1).every((link) => link.attributes.has("download")));
});
