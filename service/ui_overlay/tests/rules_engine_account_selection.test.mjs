import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "..", "web", "app.js"), "utf8");
const index = readFileSync(join(here, "..", "web", "index.html"), "utf8");
const correctionUi = readFileSync(join(here, "..", "..", "..", "modules", "corrections", "source", "correction_ui.ps1"), "utf8");
const start = script.indexOf("function rulesEngineAccountingView");
const end = script.indexOf("function renderRulesEngineDecisionTable");
assert.ok(start >= 0 && end > start, "rules account helpers must exist");

function context() {
  const calls = [];
  const value = {
    state: {
      data: { settings: { active_run_id: "RUN-1" } },
      ruleCatalogs: { ERP: [], ERP_ACCOUNTS: [], ERP_ACCOUNT_VERSION: "" },
      rulesEngineAccountDrafts: new Map(),
      rulesEngineResult: { run_id: "RUN-1" },
    },
    arr: (input) => Array.isArray(input) ? input : [],
    cleanValue: (input) => String(input ?? "").trim(),
    esc: (input) => String(input ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    api: async (url) => {
      calls.push(url);
      if (url.includes("CHART_OF_ACCOUNTS")) return {
        catalog_version_id: "ERP-CATALOG-1",
        items: [
          { account_id: "ACC-26", code: "26", name: "Общехозяйственные расходы" },
          { account_id: "ACC-791", code: "79.1", name: "Внутрихозяйственные расчёты" },
        ],
      };
      return { items: [{ code: "R025", name: "Мат помощь", path: "Расходы / Мат помощь" }] };
    },
    activeRunCapabilities: () => ({ r001: true }),
    calls,
  };
  vm.createContext(value);
  vm.runInContext(script.slice(start, end), value);
  return value;
}

test("ERP account choices come from the separate exact chart, not article fields", async () => {
  const current = context();
  await current.ensureRulesEngineERPCatalog();
  assert.deepEqual(current.calls, [
    "/api/rule-catalog?system=ERP",
    "/api/rule-catalog?system=ERP&catalog=CHART_OF_ACCOUNTS",
  ]);
  const row = { candidate_id: "CAND-1", accounting: {} };
  const debit = current.rulesEngineAccountOptions(row, "debit");
  assert.match(debit, /value="ACC-26"/);
  assert.match(debit, /26 · Общехозяйственные расходы/);
  assert.match(debit, /79\.1 · Внутрихозяйственные расчёты/);
  assert.doesNotMatch(debit, /R025|Мат помощь/);
});

test("chosen opaque account IDs survive a rules result rerender", async () => {
  const current = context();
  await current.ensureRulesEngineERPCatalog();
  const row = { candidate_id: "CAND-1", candidate_revision_id: "CRV-1", accounting: {} };
  current.state.rulesEngineAccountDrafts.set(current.rulesEngineAccountDraftKey(row), { debit_account_id: "ACC-26", credit_account_id: "ACC-791" });
  assert.match(current.rulesEngineAccountOptions(row, "debit"), /value="ACC-26" selected/);
  assert.match(current.rulesEngineAccountOptions(row, "credit"), /value="ACC-791" selected/);
  assert.match(current.rulesEngineAccountOptions(row, "debit"), /value="ACC-26" selected/);
});

test("account drafts are invalidated by run, candidate revision, and catalog revision", async () => {
  const current = context();
  await current.ensureRulesEngineERPCatalog();
  const row = { candidate_id: "CAND-1", candidate_revision_id: "CRV-1", accounting: {} };
  current.state.rulesEngineAccountDrafts.set(current.rulesEngineAccountDraftKey(row), { debit_account_id: "ACC-26" });
  assert.match(current.rulesEngineAccountOptions(row, "debit"), /value="ACC-26" selected/);
  assert.doesNotMatch(current.rulesEngineAccountOptions({ ...row, candidate_revision_id: "CRV-2" }, "debit"), /value="ACC-26" selected/);
  current.state.ruleCatalogs.ERP_ACCOUNT_VERSION = "ERP-CATALOG-2";
  assert.doesNotMatch(current.rulesEngineAccountOptions(row, "debit"), /value="ACC-26" selected/);
  current.state.ruleCatalogs.ERP_ACCOUNT_VERSION = "ERP-CATALOG-1";
  current.state.rulesEngineResult = { run_id: "RUN-2" };
  assert.doesNotMatch(current.rulesEngineAccountOptions(row, "debit"), /value="ACC-26" selected/);
});

test("R001 call to action follows the business workflow", () => {
  const current = context();
  const disputed = current.rulesEngineR001ActionView({ run_id: "RUN-1", workflow: { next_action: "PASS_TO_R001", disputed_draft_count: 2 } });
  assert.equal(disputed.enabled, true);
  assert.match(disputed.label, /СПОРНО/);
  assert.equal(current.rulesEngineR001ActionView({ run_id: "RUN-1", workflow: { next_action: "WAIT_USER_RULES" } }).enabled, false);
  assert.match(current.rulesEngineR001ActionView({ run_id: "RUN-1", workflow: { next_action: "RERUN_R005" } }).label, /R005/);
  assert.equal(current.rulesEngineR001ActionView({ run_id: "OTHER", workflow: { next_action: "PASS_TO_R001" } }).enabled, false);
});

test("apply payload carries candidate revision and opaque catalog selection only", () => {
  const apply = script.slice(script.indexOf("async function applyRulesEngineDecisions"), script.indexOf("async function decideRules"));
  assert.match(apply, /candidate_revision_id:cleanValue\(row\.candidate_revision_id\)/);
  assert.doesNotMatch(apply, /source_payload_hash|candidate_source_hash/);
  assert.match(apply, /account_selection:\{catalog_version_id:state\.ruleCatalogs\.ERP_ACCOUNT_VERSION,debit_account_id:debitAccountId,credit_account_id:creditAccountId\}/);
  assert.doesNotMatch(apply, /debit_account:debitAccountId|credit_account:creditAccountId/);
  assert.match(apply, /\/api\/rules-engine\/apply-decisions/);
  const draftIndex = script.indexOf("state.rulesEngineAccountDrafts.set(key,draft)");
  assert.ok(draftIndex > 0, "account draft change handler must exist");
  const accountHandler = script.slice(draftIndex - 700, draftIndex + 100);
  assert.match(accountHandler, /data-rules-candidate-erp-debit/);
  assert.doesNotMatch(accountHandler, /api\(|fetch\(|modules\/open|engine\/prepare/);
});

test("manual rule editor also saves pinned opaque ERP account selection", () => {
  const payload = script.slice(script.indexOf("function rulePayload"), script.indexOf("async function saveContext"));
  assert.match(index, /<select id="rule-erp-debit-account">/);
  assert.match(index, /<select id="rule-erp-credit-account">/);
  assert.doesNotMatch(index, /<input id="rule-erp-(?:debit|credit)-account"/);
  assert.match(script, /api\('\/api\/rule-catalog\?system=ERP&catalog=CHART_OF_ACCOUNTS'\)/);
  assert.match(payload, /account_selection:\{catalog_version_id:state\.ruleCatalogs\.ERP_ACCOUNT_VERSION,debit_account_id:erpDebitAccountId,credit_account_id:erpCreditAccountId\}/);
  assert.doesNotMatch(payload, /erp_debit_account:erpDebitAccountId|erp_credit_account:erpCreditAccountId|debit_account:erpDebitAccountId|credit_account:erpCreditAccountId/);
  assert.match(payload, /Для активной парной корректировки выберите счета Дт и Кт из плана ERP/);
});

test("normal rules UI labels unconfirmed correction as SPORNO and hides local source paths", () => {
  const table = script.slice(script.indexOf("function rulesEngineEvidenceTable"), script.indexOf("async function decideRules"));
  const evidence = script.slice(script.indexOf("function ruleEvidence"), script.indexOf("function ruleCard"));
  assert.match(table, /Создать черновик СПОРНО для R001/);
  assert.match(table, /правило не активируется/i);
  assert.match(table, /загрузка в 1С запрещена/i);
  assert.doesNotMatch(table, /item\.source_file|evidence\.source_file/);
  assert.doesNotMatch(evidence, /source_file|source\.file|Файл \/ строка|SHA-?256/i);
  assert.doesNotMatch(evidence, /source\.kind|source\.status|engine_feedback/);
  assert.match(evidence, /source\.source_bound/);
  const payload = script.slice(script.indexOf("function rulePayload"), script.indexOf("async function saveContext"));
  assert.doesNotMatch(payload, /state\.currentRule\?\.source/);
  assert.match(index, /ОПИУ и иерархия Инталев вместе с проводками ERP/);
  assert.match(index, /Журнал проводок Инталев в этом сценарии не используется/);
  assert.doesNotMatch(index, /Из проводок Инталев/);
  assert.match(correctionUi, /1\.9\.4/);
  assert.match(correctionUi, /черновиками «СПОРНО»/);
  assert.doesNotMatch(correctionUi, /SHA-?256|SHA ERP|SOURCE-операции|REPORT_ONLY|1\.9\.3/);
});

test("normal Journal renders only curated event fields", () => {
  const journal = script.slice(script.indexOf("async function loadEvents"), script.indexOf("function bundleFilename"));
  assert.match(journal, /e\.timestamp/);
  assert.match(journal, /e\.label/);
  assert.doesNotMatch(journal, /Object\.entries|JSON\.stringify|e\.type|technical_error|path|sha256/i);
});
