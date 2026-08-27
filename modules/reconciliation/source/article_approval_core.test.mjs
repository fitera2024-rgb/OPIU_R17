import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTICLE_APPROVAL_COLUMNS,
  ARTICLE_APPROVAL_DECISIONS,
  applyArticleApprovalRules,
  articleApprovalOrganizationSlug,
  buildArticleApprovalRows,
  buildArticleApprovalSheet,
  createArticleApprovalDocument,
  evaluateArticleApprovalFinancialGate,
  loadArticleApprovalDocument,
  persistArticleApprovalVersion,
  readArticleApprovalMatrix,
  validateArticleApprovalDocument,
  validateArticleApprovalRows,
} from "./article_approval_core.mjs";

const scope = {
  organizationId: "3",
  organizationName: "Сахалин",
  organizationHierarchyPath: "Холдинг / Сахалин",
  period: "2025-01",
};
const sha = "A".repeat(64);
const catalog = [{ code: "ERP-10", block: "Коммерческие расходы", article: "Реклама" }];
const productionCatalog = {
  nodes: [
    {
      label: "Реклама",
      parent_path: "Статьи ОПИУ / Коммерческие расходы",
      full_path: "Статьи ОПИУ / Коммерческие расходы / Реклама",
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: "ERP-10", account: "44.1" }],
    },
    {
      label: "Реклама",
      parent_path: "Статьи ОПИУ / Административные расходы",
      full_path: "Статьи ОПИУ / Административные расходы / Реклама",
      exact_catalog_entry_node: true,
      catalog_entries: [{ code: "ERP-20", account: "26" }],
    },
  ],
};

function sourceRow(overrides = {}) {
  return {
    code: "R-1",
    hierarchy_path: ["Статьи ОПИУ 2025", "Коммерческие расходы", "Реклама"],
    intalev_label: "Реклама",
    erp_label: "Реклама",
    erp: { catalog_targets: catalog.map((item) => ({ ...item })) },
    ...overrides,
  };
}

function approvalRow(overrides = {}) {
  return {
    КлючОбласти: "3|2025-01|коммерческие расходы|реклама",
    КодОрганизацииERP: "3",
    ОрганизацияERP: "Сахалин",
    ПериодС: "2025-01",
    БлокИнталев: "Коммерческие расходы",
    ПутьИнталев: "Статьи ОПИУ 2025 / Коммерческие расходы / Реклама",
    СтатьяИнталев: "Реклама",
    ПредлагаемыйБлокERP: "Коммерческие расходы",
    ПредлагаемаяСтатьяERP: "Реклама",
    КодСтатьиERP: "ERP-10",
    Действие: "КЛАССИФИКАЦИЯ",
    РешениеПользователя: "ПРЕДЛОЖЕНО ДВИЖКОМ",
    ...overrides,
  };
}

test("A17: 01_Правила has exact columns and only one valid candidate is proposed", () => {
  const rows = buildArticleApprovalRows({ ...scope, aggregateRows: [sourceRow()] , erpCatalog: catalog });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].РешениеПользователя, "ПРЕДЛОЖЕНО ДВИЖКОМ");
  assert.equal(buildArticleApprovalRows({ ...scope, aggregateRows: [sourceRow({ erp: { catalog_targets: [] } })], erpCatalog: [] })[0].РешениеПользователя, "НУЖНА ПРОВЕРКА");
  const fake = { values: {}, getRange(address) { const state = { merge() {}, get values() { return fake.values[address]; }, set values(value) { fake.values[address] = value; }, set format(_) {} }; return state; } };
  const audit = buildArticleApprovalSheet(fake, { ...scope, organization: scope.organizationName, aggregateRows: [sourceRow()], erpCatalog: catalog });
  assert.deepEqual(fake.values["A5:U5"], [ARTICLE_APPROVAL_COLUMNS]);
  assert.equal(audit.sheet, "01_Правила");
});

test("A17/A24: production nodes[].catalog_entries resolve only in the authoritative parent block", () => {
  const rows = buildArticleApprovalRows({ ...scope, aggregateRows: [sourceRow()], erpCatalog: productionCatalog });
  assert.equal(rows[0].РешениеПользователя, "ПРЕДЛОЖЕНО ДВИЖКОМ");
  assert.equal(rows[0].КодСтатьиERP, "ERP-10");

  const wrongParent = validateArticleApprovalRows([
    approvalRow({
      ПредлагаемыйБлокERP: "Административные расходы",
      РешениеПользователя: "УТВЕРЖДАЮ",
    }),
  ], { ...scope, sourceSha256: sha, erpCatalog: productionCatalog });
  assert.equal(wrongParent.status, "FAIL");
  assert.ok(wrongParent.errors.some((error) => error.code === "ERP_TARGET_BLOCK_OR_ARTICLE_MISMATCH"));
});

test("A18: exactly five decisions are accepted and ИЗМЕНИТЬ requires four fields", () => {
  assert.equal(ARTICLE_APPROVAL_DECISIONS.length, 5);
  assert.equal(validateArticleApprovalRows([approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" })], { ...scope, sourceSha256: sha, erpCatalog: catalog }).status, "PASS");
  const invalid = validateArticleApprovalRows([approvalRow({ РешениеПользователя: "ШЕСТОЕ РЕШЕНИЕ" })], { ...scope, sourceSha256: sha, erpCatalog: catalog });
  assert.equal(invalid.status, "FAIL");
  assert.ok(invalid.errors.some((error) => error.code === "DECISION_INVALID"));
  const changed = validateArticleApprovalRows([approvalRow({ РешениеПользователя: "ИЗМЕНИТЬ" })], { ...scope, sourceSha256: sha, erpCatalog: catalog });
  assert.ok(changed.errors.some((error) => error.code === "CHANGE_FIELDS_REQUIRED"));
});

test("A19: conflicts, unknown codes, foreign scope and bad period fail row by row", () => {
  const conflict = validateArticleApprovalRows([
    approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" }),
    approvalRow({ КодСтатьиERP: "ERP-11", ПредлагаемаяСтатьяERP: "Другая", РешениеПользователя: "УТВЕРЖДАЮ" }),
  ], { ...scope, sourceSha256: sha, erpCatalog: [...catalog, { code: "ERP-11", block: "Коммерческие расходы", article: "Другая" }] });
  assert.ok(conflict.errors.some((error) => error.code === "CONFLICTING_TARGETS"));
  const bad = validateArticleApprovalRows([approvalRow({ КодСтатьиERP: "NOPE", ОрганизацияERP: "Чужая", ПериодС: "2025-Q1" })], { ...scope, sourceSha256: sha, erpCatalog: catalog });
  assert.ok(bad.errors.some((error) => error.code === "ERP_CODE_UNKNOWN"));
  assert.ok(bad.errors.some((error) => error.code === "ORGANIZATION_SCOPE_MISMATCH"));
  assert.ok(bad.errors.some((error) => error.code === "PERIOD_SCOPE_MISMATCH"));
});

test("A19: КлючОбласти is recalculated and a forged key is rejected", () => {
  const forged = validateArticleApprovalRows([
    approvalRow({ КлючОбласти: "3|2025-01|административные расходы|реклама" }),
  ], { ...scope, sourceSha256: sha, erpCatalog: catalog });
  assert.equal(forged.status, "FAIL");
  assert.ok(forged.errors.some((error) => error.code === "SCOPE_KEY_MISMATCH"));
});

test("A20: v001 stays byte-identical after v002 and both have independent SHA sidecars", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-article-approval-"));
  try {
    const input = { ...scope, sourceSha256: sha, sourceXlsx: "reconciliation.xlsx", actor: "DOMAIN\\user", rows: [approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" })], erpCatalog: catalog };
    const first = await persistArticleApprovalVersion(directory, input);
    const firstBytes = await fs.readFile(first.path);
    const second = await persistArticleApprovalVersion(directory, { ...input, rows: [approvalRow({ РешениеПользователя: "ЗАПРЕТИТЬ" })] });
    assert.equal(path.basename(first.path), "article_registry_3_sakhalin_v001.approved.json");
    assert.equal(path.basename(second.path), "article_registry_3_sakhalin_v002.approved.json");
    assert.deepEqual(await fs.readFile(first.path), firstBytes);
    assert.match(await fs.readFile(first.path + ".sha256", "utf8"), /^[A-F0-9]{64}/);
    assert.match(await fs.readFile(second.path + ".sha256", "utf8"), /^[A-F0-9]{64}/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("A21: exact organization/month applies, ЗАПРЕТИТЬ blocks, damaged SHA rejects", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-article-approval-"));
  try {
    const created = await persistArticleApprovalVersion(directory, { ...scope, sourceSha256: sha, sourceXlsx: "source.xlsx", actor: "DOMAIN\\user", rows: [approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" })], erpCatalog: catalog });
    const loaded = await loadArticleApprovalDocument(created.path, { ...scope, sourceSha256: sha, erpCatalog: catalog });
    const runtimeRow = { block: "Коммерческие расходы", article: "Реклама", КлючОбласти: approvalRow().КлючОбласти };
    assert.equal(applyArticleApprovalRules([runtimeRow], loaded, scope)[0].article_approval_status, "APPROVED_EXACT_SCOPE");
    assert.throws(() => applyArticleApprovalRules([{ ...runtimeRow, КлючОбласти: "FORGED" }], loaded, scope), /SCOPE_KEY_REJECTED/);
    const denied = await persistArticleApprovalVersion(directory, { ...scope, sourceSha256: sha, sourceXlsx: "source.xlsx", actor: "DOMAIN\\user", rows: [approvalRow({ РешениеПользователя: "ЗАПРЕТИТЬ" })], erpCatalog: catalog });
    const deniedLoaded = await loadArticleApprovalDocument(denied.path, { ...scope, sourceSha256: sha, erpCatalog: catalog });
    assert.equal(applyArticleApprovalRules([runtimeRow], deniedLoaded, scope)[0].article_approval_status, "FORBIDDEN");
    await fs.writeFile(denied.path + ".sha256", "0".repeat(64) + "  broken\n", "utf8");
    await assert.rejects(() => loadArticleApprovalDocument(denied.path, scope), /SHA256_INVALID/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("A20/A21: approved document rejects non-exact safety, source.xlsx, validity and source SHA", () => {
  const document = createArticleApprovalDocument({
    ...scope,
    sourceSha256: sha,
    sourceXlsx: "source.xlsx",
    actor: "DOMAIN\\user",
    rows: [approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" })],
    erpCatalog: catalog,
  });
  const options = { ...scope, sourceSha256: sha, sourceXlsx: "source.xlsx", erpCatalog: catalog };
  assert.equal(validateArticleApprovalDocument(document, options).status, "PASS");

  const unsafe = structuredClone(document);
  unsafe.safety.mode = "LIVE";
  assert.ok(validateArticleApprovalDocument(unsafe, options).errors.some((error) => error.code === "APPROVAL_SAFETY_INVALID"));
  const missingSafetyKey = structuredClone(document);
  delete missingSafetyKey.safety.live_1c_allowed;
  assert.ok(validateArticleApprovalDocument(missingSafetyKey, options).errors.some((error) => error.code === "APPROVAL_SAFETY_INVALID"));
  const missingSource = structuredClone(document);
  missingSource.source.xlsx = "";
  assert.ok(validateArticleApprovalDocument(missingSource, options).errors.some((error) => error.code === "SOURCE_XLSX_INVALID"));
  const foreignXlsx = structuredClone(document);
  foreignXlsx.source.xlsx = "foreign.xlsx";
  assert.ok(validateArticleApprovalDocument(foreignXlsx, options).errors.some((error) => error.code === "SOURCE_XLSX_MISMATCH"));
  const foreignValidity = structuredClone(document);
  foreignValidity.validity.to = "2025-02";
  assert.ok(validateArticleApprovalDocument(foreignValidity, options).errors.some((error) => error.code === "APPROVAL_VALIDITY_INVALID"));
  const foreignSource = structuredClone(document);
  foreignSource.source.sha256 = "B".repeat(64);
  assert.ok(validateArticleApprovalDocument(foreignSource, options).errors.some((error) => error.code === "SOURCE_SHA256_MISMATCH"));
});

test("A22: no unique physical row is СПОРНО; one proven row yields equal candidate pair and zero posting", () => {
  const approval = { article_approval_status: "APPROVED_EXACT_SCOPE" };
  const usedSourceIds = new Set();
  const blocked = evaluateArticleApprovalFinancialGate({ approval, physicalRows: [], amount: 100, sourceId: "ERP-1", usedSourceIds });
  assert.equal(blocked.status, "СПОРНО");
  assert.equal(blocked.posting_rows, 0);
  const physicalRow = { id: "ERP-1", amount: 100.12, unique: true, proven: true, reopened: true, reuse_checked: true };
  const proven = evaluateArticleApprovalFinancialGate({ approval, physicalRows: [physicalRow], amount: 100.12, sourceId: "ERP-1", usedSourceIds });
  assert.equal(proven.status, "ДОКАЗАНО");
  assert.deepEqual(proven.correction_rows.map((row) => row.amount), [-100.12, 100.12]);
  assert.equal(proven.posting_rows, 0);
  const reused = evaluateArticleApprovalFinancialGate({ approval, physicalRows: [physicalRow], amount: 100.12, sourceId: "ERP-1", usedSourceIds });
  assert.equal(reused.reason, "PHYSICAL_ERP_ROW_ALREADY_USED");
});

test("A22: exact sourceId, all proof flags, amount match and shared reuse set are mandatory", () => {
  const approval = { article_approval_status: "APPROVED_EXACT_SCOPE" };
  const usedSourceIds = new Set();
  const row = { id: "ERP-1", amount: -100, unique: true, proven: true, reopened: true, reuse_checked: true };
  assert.equal(evaluateArticleApprovalFinancialGate({ approval, physicalRows: [row], amount: 100, sourceId: "ERP-2", usedSourceIds }).reason, "PHYSICAL_ERP_ROW_NOT_UNIQUE");
  assert.equal(evaluateArticleApprovalFinancialGate({ approval, physicalRows: [row, { ...row }], amount: 100, sourceId: "ERP-1", usedSourceIds }).reason, "PHYSICAL_ERP_ROW_NOT_UNIQUE");
  assert.equal(evaluateArticleApprovalFinancialGate({ approval, physicalRows: [{ ...row, reopened: false }], amount: 100, sourceId: "ERP-1", usedSourceIds }).reason, "PHYSICAL_ERP_PROOF_INCOMPLETE");
  assert.equal(evaluateArticleApprovalFinancialGate({ approval, physicalRows: [row], amount: 80, sourceId: "ERP-1", usedSourceIds }).reason, "PHYSICAL_AMOUNT_MISMATCH");
  assert.equal(evaluateArticleApprovalFinancialGate({ approval, physicalRows: [row], amount: 100, sourceId: "ERP-1" }).reason, "PHYSICAL_REUSE_GUARD_REQUIRED");
  assert.equal(usedSourceIds.size, 0);
});

test("matrix reader keeps round-trip header and rows", () => {
  const row = approvalRow();
  const matrix = [["SHA-256 исходной сверки", sha], [], ARTICLE_APPROVAL_COLUMNS, ARTICLE_APPROVAL_COLUMNS.map((column) => row[column])];
  const parsed = readArticleApprovalMatrix(matrix);
  assert.equal(parsed.sourceSha256, sha);
  assert.equal(parsed.rows[0].КлючОбласти, row.КлючОбласти);
  assert.equal(articleApprovalOrganizationSlug({ organizationCode: "3", organizationName: "Сахалин" }), "3_sakhalin");
});
