import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");
const script = readFileSync(join(web, "app.js"), "utf8");
const html = readFileSync(join(web, "index.html"), "utf8");

function helperContext() {
  const start = script.indexOf("/* STRUCTURAL_CONTROL_SET_LOGIC_START */");
  const end = script.indexOf("/* STRUCTURAL_CONTROL_SET_LOGIC_END */");
  assert.ok(start >= 0 && end > start, "structural control helper markers must exist");
  const source = script.slice(start, end);
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${source};this.structuralPreview=structuralPreview;this.structuralSetPayload=structuralSetPayload;`, context);
  return context;
}

test("owner UI has a dedicated organization-bound block-group editor", () => {
  assert.match(html, /data-view="structural-groups"/);
  assert.match(html, /id="view-structural-groups"/);
  assert.match(html, /Группы блоков/);
  assert.match(html, /id="structural-intalev-inventory"/);
  assert.match(html, /id="structural-erp-inventory"/);
  assert.match(html, /id="structural-control-set-list"/);
  assert.match(html, /id="structural-save-draft"/);
  assert.match(html, /id="structural-fix-version"/);
  assert.match(html, /Можно добавить несколько групп/);
});

test("preview keeps Intalev and ERP sides separate and computes the control delta", () => {
  const context = helperContext();
  const zero = context.structuralPreview(
    [{ identity: "I-FIN", amount: 120000 }, { identity: "I-OTHER", amount: 80000 }],
    [{ identity: "E-FIN", amount: 150000 }, { identity: "E-OTHER", amount: 50000 }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(zero)), {
    intalev_total: 200000,
    erp_total: 200000,
    control_delta: 0,
    status: "ZERO",
  });
  const open = context.structuralPreview(
    [{ identity: "I-FIN", amount: 200000 }],
    [{ identity: "E-FIN", amount: 199999.98 }],
  );
  assert.equal(open.control_delta, 0.02);
  assert.equal(open.status, "OPEN_INTERGROUP_RECLASS");
});

test("saved payload is versioned, scoped and uses typed member arrays", () => {
  const context = helperContext();
  const payload = context.structuralSetPayload({
    name: "Финансовые и внереализационные расходы",
    organization_id: "ORG-9",
    organization_name: "9 Управляющая компания",
    run_id: "RUN-OCT",
    author: "Экономист",
    intalev_members: [{ identity: "I-R045", code: "R045", amount: 120000 }],
    erp_members: [{ identity: "E-R055", code: "R055", amount: 120000 }],
  });
  assert.equal(payload.organization_id, "ORG-9");
  assert.equal(payload.run_id, "RUN-OCT");
  assert.equal(payload.intalev_members[0].identity, "I-R045");
  assert.equal(payload.erp_members[0].identity, "E-R055");
  assert.equal(payload.expected_control_delta, 0);
  assert.equal(payload.mode, "SUM_DELTA_ONLY");
  assert.equal(payload.author, "Экономист");
});

test("UI uses the settings API and explains zero/nonzero semantics in business language", () => {
  assert.match(script, /api\('\/api\/structural-control-sets/);
  assert.match(script, /\/api\/structural-control-sets\/preview/);
  assert.match(script, /\/api\/structural-control-sets\/fix/);
  assert.match(script, /renderStructuralControlSets/);
  assert.match(html, /Дочерние строки всё равно проверяются/);
  assert.match(html, /межгрупповой пересорт/);
  assert.doesNotMatch(html, /payload SHA|debug code|proof JSON|физическая проводка будет создана/i);
});

test("structural editor does not open posting or release safety gates", () => {
  assert.doesNotMatch(script, /ready_to_upload\s*:\s*true|release_allowed\s*:\s*true|live_1c_allowed\s*:\s*true|posting_rows\s*:\s*[1-9]/);
});
