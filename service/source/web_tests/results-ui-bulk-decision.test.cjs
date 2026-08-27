const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyRuleDecisions,
  assignBulkRuleDecision,
  collectSelectedRuleDecisions,
  diagnosticResultFiles,
  rulesReviewPresentation,
  selectCandidateAfterDecision,
  stageBox,
  stageResultPresentation,
} = require("../web/results-ui.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function withFakeDocument(fn) {
  const previous = global.document;
  global.document = { createElement: (tagName) => new FakeElement(tagName) };
  try { return fn(); }
  finally { global.document = previous; }
}

function flattenElements(root) {
  return [root, ...(root.children || []).flatMap(flattenElements)];
}

function makeReviewBox(values) {
  const checkboxes = values.map((value) => ({
    checked: value.checked,
    dataset: { candidateId: value.id },
  }));
  const selects = values.map((value) => ({
    value: value.decision,
    dataset: { candidateId: value.id },
  }));
  const status = { textContent: "" };
  const button = { disabled: false };
  return {
    checkboxes,
    selects,
    status,
    button,
    box: {
      dataset: { dirty: "false" },
      querySelectorAll(selector) {
        if (selector === ".rules-review-choice:checked") return checkboxes.filter((item) => item.checked);
        if (selector === ".rules-review-decision") return selects;
        return [];
      },
      querySelector(selector) {
        if (selector === ".rules-review-status") return status;
        if (selector === ".rules-review-apply") return button;
        return null;
      },
    },
  };
}

test("selected MANUAL_REVIEW rows are not submitted and remain checked", async () => {
  const values = Array.from({ length: 11 }, (_, index) => ({
    id: `CAND-${index + 1}`,
    checked: true,
    decision: "MANUAL_REVIEW",
  }));
  const review = makeReviewBox(values);
  let requestCount = 0;

  await applyRuleDecisions({ id: "RUN-1" }, review.box, async () => {
    requestCount += 1;
  });

  assert.equal(requestCount, 0);
  assert.equal(review.button.disabled, false);
  assert.equal(review.checkboxes.every((item) => item.checked), true);
  assert.match(review.status.textContent, /11 выбранных строк/);
  assert.match(review.status.textContent, /Отметки сохранены/);
});

test("explicit selected decisions are submitted once and enter business RUNNING state", async () => {
  const review = makeReviewBox([
    { id: "CAND-R035", checked: true, decision: "CONFIRMED" },
  ]);
  const requests = [];

  await applyRuleDecisions({ id: "RUN-OWNER" }, review.box, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: "RUNNING", stage: "RULES_REVIEW" };
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/runs/RUN-OWNER/result/rules");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    author: "Пользователь",
    decisions: [{
      candidate_id: "CAND-R035",
      decision: "CONFIRMED",
      comment: "Решение принято в интерфейсе OPIU_STABLE",
    }],
  });
  assert.equal(review.button.disabled, true);
  assert.equal(review.box.dataset.dirty, "false");
  assert.match(review.status.textContent, /приняты в обработку/);
  assert.match(review.status.textContent, /повторное применение не требуется/);
});

test("bulk decision changes only checked rows and requires an explicit actionable value", () => {
  const review = makeReviewBox([
    { id: "CAND-1", checked: true, decision: "MANUAL_REVIEW" },
    { id: "CAND-2", checked: false, decision: "MANUAL_REVIEW" },
    { id: "CAND-3", checked: true, decision: "MANUAL_REVIEW" },
  ]);

  assert.equal(assignBulkRuleDecision(review.box, "MANUAL_REVIEW"), 0);
  assert.equal(assignBulkRuleDecision(review.box, ""), 0);
  assert.equal(review.selects.every((item) => item.value === "MANUAL_REVIEW"), true);

  assert.equal(assignBulkRuleDecision(review.box, "REJECTED"), 2);
  assert.deepEqual(review.selects.map((item) => item.value), ["REJECTED", "MANUAL_REVIEW", "REJECTED"]);
  assert.equal(review.box.dataset.dirty, "true");

  const collected = collectSelectedRuleDecisions(review.box);
  assert.deepEqual(collected.decisions.map((item) => item.decision), ["REJECTED", "REJECTED"]);
});

test("changing an individual decision checks its row", () => {
  const checkbox = { checked: false };
  const box = { dataset: { dirty: "false" } };
  const row = {
    querySelector(selector) {
      return selector === ".rules-review-choice" ? checkbox : null;
    },
  };
  const select = {
    closest(selector) {
      if (selector === ".rules-review-row") return row;
      if (selector === ".rules-review-box") return box;
      return null;
    },
  };

  selectCandidateAfterDecision(select);

  assert.equal(checkbox.checked, true);
  assert.equal(box.dataset.dirty, "true");
});

test("saved decisions are rendered read-only instead of looking unchecked", () => {
  const saved = rulesReviewPresentation(
    { status: "WAITING_USER_RULES" },
    { candidate_count: 11, pending_review_count: 0, next_action: "RERUN_R005" },
  );
  assert.equal(saved.canReview, false);
  assert.equal(saved.badge, "11 решений сохранено");
  assert.match(saved.note, /повторную сверку R005/);

  const disputed = rulesReviewPresentation(
    { status: "COMPLETED_REPORT_ONLY" },
    { candidate_count: 1, pending_review_count: 1, next_action: "PASS_TO_R001" },
  );
  assert.equal(disputed.canReview, false);
  assert.equal(disputed.badge, "1 спорное предложение");
});

test("RUNNING rules review hides stale waiting state and repeat apply controls", () => {
  const running = rulesReviewPresentation(
    { status: "RUNNING", stage: "RULES_REVIEW" },
    {
      candidate_count: 1,
      pending_review_count: 1,
      next_action: "WAIT_USER_RULES",
      reasons: ["Нужно решение пользователя по 1 кандидату."],
      registry_persisted: false,
      registry_persisted_count: 0,
    },
  );

  assert.equal(running.canReview, false);
  assert.equal(running.badge, "Решения обрабатываются");
  assert.match(running.note, /приняты в обработку/);
  assert.match(running.note, /повторное применение не требуется/);
  assert.doesNotMatch(running.reason, /Нужно решение пользователя/);
});

test("durably persisted registry is acknowledged during R001 and after completion", () => {
  const processing = rulesReviewPresentation(
    { status: "RUNNING", stage: "R001" },
    {
      candidate_count: 1,
      pending_review_count: 0,
      next_action: "PASS_TO_R001",
      registry_persisted: true,
      registry_persisted_count: 1,
    },
  );
  assert.equal(processing.canReview, false);
  assert.equal(processing.badge, "1 правило сохранено");
  assert.match(processing.note, /сохранено в библиотеке правил/);
  assert.match(processing.note, /формирует итоговый R001/);

  const complete = rulesReviewPresentation(
    { status: "COMPLETED_REPORT_ONLY", stage: "DONE" },
    {
      candidate_count: 1,
      pending_review_count: 0,
      next_action: "PASS_TO_R001",
      registry_persisted: true,
      registry_persisted_count: 1,
    },
  );
  assert.equal(complete.canReview, false);
  assert.equal(complete.registryPersisted, true);
  assert.equal(complete.registryPersistedCount, 1);
  assert.equal(complete.badge, "1 правило сохранено");
  assert.match(complete.note, /сохранено в библиотеке правил/);
  assert.match(complete.note, /повторная отправка не требуется/i);
});

test("completed PASS_TO_R001 shows a ready final result only with a ready API result", () => {
  const complete = stageResultPresentation(
    "r001",
    { ready: true, files: [{ kind: "manifest" }, { kind: "decisions" }, { kind: "registry" }] },
    { status: "COMPLETED_REPORT_ONLY" },
    { next_action: "PASS_TO_R001" },
  );
  assert.deepEqual(complete, { ready: true, badge: "Готово", note: "" });

  const partial = stageResultPresentation(
    "r001",
    { ready: false, files: [{ kind: "manifest" }] },
    { status: "COMPLETED_REPORT_ONLY" },
    { next_action: "PASS_TO_R001" },
  );
  assert.equal(partial.badge, "Неполный результат");
  assert.match(partial.note, /без полного комплекта R001/);
});

test("old RERUN_R005 waiting state does not imply that R001 is still running", () => {
  const presentation = stageResultPresentation(
    "r001",
    { ready: false, files: [] },
    { status: "WAITING_USER_RULES" },
    { next_action: "RERUN_R005" },
  );
  assert.equal(presentation.ready, false);
  assert.equal(presentation.badge, "Не запускался");
  assert.match(presentation.note, /сначала требуется повторная сверка R005/);
});

test("verified fail-soft R001 package exposes only diagnostic downloads without final-ready wording", () => {
  const files = [
    { kind: "diagnostics", name: "service-report-package/technical/diagnostics.json", url: "/diagnostics" },
    { kind: "journal", name: "service-report-package/technical/action-journal.json", url: "/journal" },
    { kind: "registry", name: "service-report-package/technical/artifact-registry.json", url: "/registry" },
    { kind: "disputed", name: "КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ СПОРНО/draft.xlsx", url: "/draft" },
  ];
  assert.deepEqual(diagnosticResultFiles(files).map((file) => file.url), ["/diagnostics", "/journal", "/registry"]);

  const presentation = stageResultPresentation(
    "r001",
    { ready: false, verified_package_available: true, files },
    { status: "FAILED", stage: "R001" },
    { next_action: "PASS_TO_R001" },
  );
  assert.equal(presentation.ready, false);
  assert.equal(presentation.diagnostic, true);
  assert.equal(presentation.badge, "Диагностика доступна");
  assert.match(presentation.note, /не готов и не разрешён к загрузке/);

  const box = withFakeDocument(() => stageBox(
    "r001",
    { ready: false, verified_package_available: true, files, archive_url: "/must-not-appear.zip" },
    { status: "FAILED", stage: "R001" },
    { next_action: "PASS_TO_R001" },
  ));
  const elements = flattenElements(box);
  const links = elements.filter((item) => item.tagName === "A");
  assert.deepEqual(links.map((item) => item.href), ["/diagnostics", "/journal", "/registry"]);
  assert.equal(links.some((item) => item.href === "/must-not-appear.zip" || item.href === "/draft"), false);
  assert.match(elements.map((item) => item.textContent).join(" "), /Готовность к загрузке: нет/);
  assert.doesNotMatch(elements.map((item) => item.textContent).join(" "), /Скачать R001\.zip/);
});
