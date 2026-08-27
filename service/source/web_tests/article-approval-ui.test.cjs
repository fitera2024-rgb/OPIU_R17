const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const webRoot = join(dirname(__filename), "..", "web");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const javascript = readFileSync(join(webRoot, "article-approval-ui.js"), "utf8");
const app = readFileSync(join(webRoot, "app.js"), "utf8");

const {
  ARTICLE_APPROVAL_DECISIONS,
  ARTICLE_APPROVAL_MAX_REQUEST_BYTES,
  applyArticleApprovalServerBulk,
  articleApprovalDecisionFingerprint,
  articleApprovalDecisionRows,
  articleApprovalHasDirtyIneligible,
  articleApprovalRequestBytes,
  buildArticleApprovalPayload,
  filterArticleApprovalRows,
  isArticleApprovalStaleResponse,
  mapArticleApprovalServerIssues,
  normalizeArticleApprovalQueue,
  requireArticleApprovalReportOnly,
  validateArticleApprovalDecisionRows,
} = require("../web/article-approval-ui.js");

const safety = {
  mode: "REPORT_ONLY",
  posting_rows: 0,
  ready_to_upload: false,
  release_allowed: false,
  live_1c_allowed: false,
};

function approvalRow(index, overrides = {}) {
  const code = index.toString(16).padStart(32, "0");
  return {
    row_id: `row_${code}`,
    block_intalev: `Блок ${index}`,
    path_intalev: `ОПИУ / Блок ${index} / Статья ${index}`,
    article_intalev: `Статья ${index}`,
    income_expense_account: "90.08",
    settlement_account: "60.01",
    proposed_block_erp: `ERP блок ${index}`,
    proposed_article_erp: `ERP статья ${index}`,
    proposed_code_erp: `ERP-${index}`,
    action: "Сопоставить",
    selection_reason: "Точная серверная цель",
    confidence: "HIGH",
    physical_examples: "Документ 1, строка 2",
    user_decision: index === 2 ? "НУЖНА ПРОВЕРКА" : "ПРЕДЛОЖЕНО ДВИЖКОМ",
    correct_block_erp: "",
    correct_article_erp: "",
    correct_code_erp: "",
    user_comment: "",
    bulk_approvable: index !== 2,
    bulk_approval_blockers: index === 2 ? ["ERP_TARGET_NOT_UNIQUE"] : [],
    ...overrides,
  };
}

function queueFixture(rows = [approvalRow(1), approvalRow(2)]) {
  return {
    status: "PASS",
    schema_version: "opiu-article-approval-queue.v1",
    run_id: "run_approval_1",
    queue_revision: "A".repeat(64),
    organization_scope: {
      organization_id: "9",
      organization_name: "Управляющая компания",
      organization_hierarchy_path: "Холдинг / 9 Управляющая компания",
      period: "2025-10",
    },
    actor: "FITERA\\reviewer",
    allowed_decisions: [...ARTICLE_APPROVAL_DECISIONS],
    rows,
    bulk_approvable: rows.filter((row) => row.bulk_approvable).length,
    safety,
  };
}

test("S05 loads a native Russian approval dialog with exactly five decisions", () => {
  assert.match(html, /<dialog\s+id="article-approval-dialog"/);
  assert.match(html, /id="openArticleApprovals"/);
  assert.match(html, /Утверждение соответствий статей/);
  assert.match(html, /НУЖНА ПРОВЕРКА/);
  assert.match(html, /Утвердить все однозначные/);
  assert.match(html, /Зафиксировать утверждения/);
  assert.match(html, /<script\s+src="\/article-approval-ui\.js"\s+defer>/);
  assert.deepEqual(ARTICLE_APPROVAL_DECISIONS, [
    "УТВЕРЖДАЮ",
    "ИЗМЕНИТЬ",
    "ЗАПРЕТИТЬ",
    "НУЖНА ПРОВЕРКА",
    "ПРЕДЛОЖЕНО ДВИЖКОМ",
  ]);
  for (const value of ARTICLE_APPROVAL_DECISIONS) assert.match(javascript, new RegExp(`"${value}"`));
});

test("queue authority is exact and fails closed on schema, safety, decisions, IDs, revision and bulk count", () => {
  const queue = normalizeArticleApprovalQueue(queueFixture(), "run_approval_1");
  assert.equal(queue.rows.length, 2);
  assert.equal(queue.actor, "FITERA\\reviewer");
  assert.equal(queue.bulk_approvable, 1);

  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), schema_version: "v2" }), /неизвестной версии/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), queue_revision: "A".repeat(63) }), /ревизию/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), allowed_decisions: ARTICLE_APPROVAL_DECISIONS.slice(0, 4) }), /не пять/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), allowed_decisions: [...ARTICLE_APPROVAL_DECISIONS, "ШЕСТОЕ"] }), /не пять/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), safety: { ...safety, live_1c_allowed: true } }), /безопасный/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), rows: [approvalRow(1), approvalRow(1)], bulk_approvable: 2 }), /идентификатор/);
  assert.throws(() => normalizeArticleApprovalQueue({ ...queueFixture(), bulk_approvable: 2 }), /Счётчик/);
  assert.throws(() => requireArticleApprovalReportOnly({ ...safety, extra: false }), /безопасный/);
});

test("POST payload is the full exact decision set and contains no client authority", () => {
  const queue = normalizeArticleApprovalQueue(queueFixture());
  const rows = articleApprovalDecisionRows(queue);
  rows[1].user_decision = "ЗАПРЕТИТЬ";
  const payload = buildArticleApprovalPayload(queue, rows, false);

  assert.deepEqual(Object.keys(payload).sort(), ["bulk_approve", "decisions", "revision", "run_id"]);
  assert.equal(payload.decisions.length, queue.rows.length);
  assert.deepEqual(Object.keys(payload.decisions[0]).sort(), [
    "correct_article_erp",
    "correct_block_erp",
    "correct_code_erp",
    "row_id",
    "user_comment",
    "user_decision",
  ]);
  const encoded = JSON.stringify(payload);
  for (const forbidden of ["actor", "organization_scope", "scope_key", "source_xlsx", "source_sha256", "path", "catalog"]) {
    assert.doesNotMatch(encoded, new RegExp(forbidden));
  }
  assert.throws(() => buildArticleApprovalPayload(queue, rows.slice(0, 1)), /полный набор/);
});

test("all five decisions are accepted locally and ИЗМЕНИТЬ requires all four fields", () => {
  const queue = normalizeArticleApprovalQueue(queueFixture([approvalRow(1)]));
  for (const decision of ARTICLE_APPROVAL_DECISIONS) {
    const rows = articleApprovalDecisionRows(queue);
    rows[0].user_decision = decision;
    if (decision === "ИЗМЕНИТЬ") {
      rows[0].correct_block_erp = "Коммерческие расходы";
      rows[0].correct_article_erp = "Реклама";
      rows[0].correct_code_erp = "ERP-77";
      rows[0].user_comment = "Исправлено по решению пользователя";
    }
    assert.deepEqual(validateArticleApprovalDecisionRows(rows), [], decision);
  }

  const changed = articleApprovalDecisionRows(queue);
  changed[0].user_decision = "ИЗМЕНИТЬ";
  assert.deepEqual(validateArticleApprovalDecisionRows(changed).map((issue) => issue.field), [
    "correct_block_erp",
    "correct_article_erp",
    "correct_code_erp",
    "user_comment",
  ]);
  changed[0].user_decision = "ШЕСТОЕ";
  assert.equal(validateArticleApprovalDecisionRows(changed)[0].code, "DECISION_INVALID");
});

test("bulk changes only server-eligible rows and preserves every factual block in the full payload", () => {
  const names = [
    "Административные расходы",
    "Коммерческие расходы",
    "Расходы на транспортную логистику",
    "Расходы на складскую логистику",
    "Прочий фактический блок",
  ];
  const sourceRows = names.map((name, index) => approvalRow(index + 1, {
    block_intalev: name,
    user_decision: index === 2 ? "НУЖНА ПРОВЕРКА" : "ПРЕДЛОЖЕНО ДВИЖКОМ",
    bulk_approvable: index !== 2,
    bulk_approval_blockers: index === 2 ? ["ERP_TARGET_NOT_UNIQUE"] : [],
  }));
  const queue = normalizeArticleApprovalQueue(queueFixture(sourceRows));
  const rows = articleApprovalDecisionRows(queue);
  const bulk = applyArticleApprovalServerBulk(rows);
  assert.equal(bulk[2].user_decision, "НУЖНА ПРОВЕРКА");
  assert.equal(bulk.filter((row) => row.user_decision === "УТВЕРЖДАЮ").length, 4);
  assert.deepEqual(bulk.map((row) => row.block_intalev), names);
  assert.equal(filterArticleApprovalRows(bulk, "НУЖНА ПРОВЕРКА").length, 1);
  bulk[2].user_decision = "ИЗМЕНИТЬ";
  assert.equal(filterArticleApprovalRows(bulk, "НУЖНА ПРОВЕРКА").length, 1,
    "a row from the review queue must remain visible while its replacement fields are edited");
  assert.equal(buildArticleApprovalPayload(queue, bulk).decisions.length, names.length);
  assert.equal(buildArticleApprovalPayload(queue, rows, true).bulk_approve, true,
    "the bulk validation call must exercise the server-owned eligibility gate");

  assert.equal(articleApprovalHasDirtyIneligible(rows), false);
  rows[2].user_comment = "ручное изменение неоднозначной строки";
  assert.equal(articleApprovalHasDirtyIneligible(rows), true);
});

test("row errors map by the original one-based full-set index and stale responses fail closed", () => {
  const queue = normalizeArticleApprovalQueue(queueFixture());
  const mapped = mapArticleApprovalServerIssues(queue, [
    { row: 2, code: "CHANGE_FIELDS_REQUIRED", field: "user_comment", message: "Добавьте комментарий" },
    { code: "GLOBAL", message: "Общая ошибка" },
  ]);
  assert.equal(mapped.rowErrors[queue.rows[1].row_id][0].field, "user_comment");
  assert.equal(mapped.globalErrors[0].code, "GLOBAL");
  assert.equal(isArticleApprovalStaleResponse(409, { error: "ARTICLE_APPROVAL_QUEUE_REVISION_STALE" }), true);
  assert.equal(isArticleApprovalStaleResponse(400, { errors: [{ code: "ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH" }] }), true);
  assert.equal(isArticleApprovalStaleResponse(400, { errors: [{ code: "CHANGE_FIELDS_REQUIRED" }] }), false);
});

test("approval module adds no polling, session stream, Rules endpoint or unsafe HTML rendering", () => {
  assert.doesNotMatch(javascript, /setInterval\s*\(/);
  assert.doesNotMatch(javascript, /new\s+EventSource\s*\(/);
  assert.doesNotMatch(javascript, /\/api\/[^"'`]*rules/i);
  assert.doesNotMatch(javascript, /Rules Service/i);
  assert.doesNotMatch(javascript, /innerHTML/);
  assert.doesNotMatch(javascript, /Административные расходы|Коммерческие расходы|транспортн|складск/iu,
    "the UI must never reduce the queue to a hardcoded block dictionary");
  assert.match(javascript, /textContent/);
  assert.match(javascript, /setArticleApprovalMode\("STALE"/);
  assert.match(javascript, /approved\.file_name/);
  assert.match(javascript, /approved\.integrity_file_name/);
  assert.match(app, /CustomEvent\("opiu:bootstrap-updated"/);
  assert.match(app, /window\.opiuArticleApprovalRuns\s*=\s*\(snapshot\.runs\s*\|\|\s*\[\]\)\.map/);
  assert.match(javascript, /syncArticleApprovalRuns\(window\.opiuArticleApprovalRuns\s*\|\|\s*\[\]\)/);
  const hookStart = app.indexOf("window.opiuArticleApprovalRuns =");
  const hookEnd = app.indexOf("window.dispatchEvent", hookStart);
  const hook = app.slice(hookStart, hookEnd);
  assert.ok(hookStart >= 0 && hookEnd > hookStart);
  assert.doesNotMatch(hook, /organization|scope|path|sha|catalog/i,
    "bootstrap hook may provide only safe run summaries; the queue remains server-owned");
});

test("full-set request size is checked against the service one MiB limit", () => {
  const queue = normalizeArticleApprovalQueue(queueFixture([approvalRow(1)]));
  const payload = buildArticleApprovalPayload(queue, articleApprovalDecisionRows(queue));
  assert.ok(articleApprovalRequestBytes(payload) < ARTICLE_APPROVAL_MAX_REQUEST_BYTES);
  payload.decisions[0].user_comment = "Я".repeat(ARTICLE_APPROVAL_MAX_REQUEST_BYTES);
  assert.ok(articleApprovalRequestBytes(payload) > ARTICLE_APPROVAL_MAX_REQUEST_BYTES);
  assert.equal(typeof articleApprovalDecisionFingerprint(articleApprovalDecisionRows(queue)), "string");
});
