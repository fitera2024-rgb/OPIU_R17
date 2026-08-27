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

function approvedRuntime(overrides = {}) {
  return {
    article_approval_status: "APPROVED_EXACT_SCOPE",
    article_approval_decision: "УТВЕРЖДАЮ",
    article_approval_target: {
      block: "Коммерческие расходы",
      article: "Реклама",
      code: "ERP-10",
    },
    article_approval_scope: {
      scope_key: approvalRow().КлючОбласти,
      organization_id: "3",
      organization_name: "Сахалин",
      organization_hierarchy_path: "Холдинг / Сахалин",
      period: "2025-01",
      block_intalev: "Коммерческие расходы",
      article_intalev: "Реклама",
    },
    ...overrides,
  };
}

function physicalErpRow(overrides = {}) {
  return {
    source_row_id: "ERP-ROW-1",
    physical_row: 42,
    source_range: "B42:AG42",
    period: "2025-01",
    date: "15.01.2025 0:00:00",
    date_value: "2025-01-15",
    organization: "Сахалин",
    document: "Операция МСФО 0001",
    posting_no: 7,
    activity: "Да",
    scenario: "Факт",
    debit: "26",
    credit: "70.1",
    debit_analytics: ["Реклама", "Отдел продаж"],
    credit_analytics: ["Сотрудник А"],
    debit_department: "Административный отдел",
    credit_department: "Административный отдел",
    amount: 100.12,
    amount_accounting: 100.12,
    article: "Старая статья",
    content: "Физическая операция",
    ...overrides,
  };
}

function physicalMatchProof(overrides = {}) {
  return {
    status: "PROVEN_CROSS_JOURNAL_MATCH",
    mutually_unique: true,
    erp_source_row_id: "ERP-ROW-1",
    intalev_source_row_ids: ["INTALEV-ROW-1"],
    period: "2025-01",
    amount: 100.12,
    ...overrides,
  };
}

function financialGateInput(overrides = {}) {
  return {
    approval: approvedRuntime(),
    physicalRows: [physicalErpRow()],
    amount: 100.12,
    sourceId: "ERP-ROW-1",
    usedSourceIds: new Set(),
    scope: {
      organizationId: "3",
      period: "2025-01",
      block: "Коммерческие расходы",
      article: "Реклама",
      sourceBlock: "Административные расходы",
    },
    erpCatalog: catalog,
    physicalProof: physicalMatchProof(),
    allowedPhysicalOrganizations: ["Сахалин"],
    sourceArticleCode: "ERP-OLD",
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

test("A19/A21: an approved ERP target must exist exactly once in the authoritative catalog", () => {
  const duplicateTargetCatalog = [
    { code: "ERP-10", block: "Коммерческие расходы", article: "Реклама", path: "ERP / Коммерческие расходы / Реклама / 1" },
    { code: "ERP-10", block: "Коммерческие расходы", article: "Реклама", path: "ERP / Коммерческие расходы / Реклама / 2" },
  ];
  const validation = validateArticleApprovalRows([
    approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" }),
  ], { ...scope, sourceSha256: sha, erpCatalog: duplicateTargetCatalog });
  assert.equal(validation.status, "FAIL");
  assert.ok(validation.errors.some((error) => error.code === "ERP_TARGET_NOT_UNIQUE"));

  const duplicateExactNode = {
    nodes: [{
      label: "Реклама",
      parent_path: "Статьи ОПИУ / Коммерческие расходы",
      full_path: "Статьи ОПИУ / Коммерческие расходы / Реклама",
      exact_catalog_entry_node: true,
      catalog_entries: [
        { code: "ERP-10", account: "44.1" },
        { code: "ERP-10", account: "44.1" },
      ],
    }],
  };
  const exactNodeValidation = validateArticleApprovalRows([
    approvalRow({ РешениеПользователя: "УТВЕРЖДАЮ" }),
  ], { ...scope, sourceSha256: sha, erpCatalog: duplicateExactNode });
  assert.equal(exactNodeValidation.status, "FAIL");
  assert.ok(exactNodeValidation.errors.some((error) => error.code === "ERP_TARGET_NOT_UNIQUE"));
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

test("A21: УТВЕРЖДАЮ uses only proposed target and ИЗМЕНИТЬ uses only corrected target", () => {
  const targets = [
    ...catalog,
    { code: "ERP-11", block: "Коммерческие расходы", article: "Обучение" },
  ];
  const approvedDocument = createArticleApprovalDocument({
    ...scope,
    sourceSha256: sha,
    sourceXlsx: "source.xlsx",
    actor: "DOMAIN\\user",
    rows: [approvalRow({
      РешениеПользователя: "УТВЕРЖДАЮ",
      ПравильныйБлокERP: "Коммерческие расходы",
      ПравильнаяСтатьяERP: "Обучение",
      ПравильныйКодСтатьиERP: "ERP-11",
      КомментарийПользователя: "Не должен применяться",
    })],
    erpCatalog: targets,
  });
  const runtimeRow = { block: "Коммерческие расходы", article: "Реклама" };
  assert.deepEqual(
    applyArticleApprovalRules([runtimeRow], approvedDocument, { ...scope, erpCatalog: targets })[0].article_approval_target,
    { block: "Коммерческие расходы", article: "Реклама", code: "ERP-10" },
  );

  const changedDocument = createArticleApprovalDocument({
    ...scope,
    sourceSha256: sha,
    sourceXlsx: "source.xlsx",
    actor: "DOMAIN\\user",
    rows: [approvalRow({
      РешениеПользователя: "ИЗМЕНИТЬ",
      ПравильныйБлокERP: "Коммерческие расходы",
      ПравильнаяСтатьяERP: "Обучение",
      ПравильныйКодСтатьиERP: "ERP-11",
      КомментарийПользователя: "Исправлено пользователем",
    })],
    erpCatalog: targets,
  });
  assert.deepEqual(
    applyArticleApprovalRules([runtimeRow], changedDocument, { ...scope, erpCatalog: targets })[0].article_approval_target,
    { block: "Коммерческие расходы", article: "Обучение", code: "ERP-11" },
  );
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

test("A22: approved metadata is not physical proof; one reopened raw ERP row yields one balanced REPORT_ONLY pair", () => {
  const blocked = evaluateArticleApprovalFinancialGate(financialGateInput({
    physicalRows: [],
    approval: approvedRuntime({ physical_row_id: "ERP-ROW-1", physical_proof: true }),
  }));
  assert.equal(blocked.status, "СПОРНО");
  assert.equal(blocked.reason, "PHYSICAL_ERP_ROW_NOT_UNIQUE");
  assert.equal(blocked.posting_rows, 0);
  const usedSourceIds = new Set();
  const proven = evaluateArticleApprovalFinancialGate(financialGateInput({ usedSourceIds }));
  assert.equal(proven.status, "ДОКАЗАНО");
  assert.deepEqual(proven.correction_rows.map((row) => row.amount), [-100.12, 100.12]);
  assert.deepEqual(proven.correction_rows.map((row) => row.article), ["Старая статья", "Реклама"]);
  assert.deepEqual(proven.correction_rows.map((row) => row.article_code), ["ERP-OLD", "ERP-10"]);
  for (const field of ["date", "organization", "document", "posting_no", "debit", "credit", "debit_analytics", "credit_analytics"]) {
    assert.deepEqual(proven.correction_rows[0][field], proven.correction_rows[1][field], field);
  }
  assert.equal(proven.financial_pair_rows, 2);
  assert.equal(proven.posting_rows, 0);
  assert.equal(proven.live_rows, 0);
  assert.equal(proven.executed_rows, 0);
  const reused = evaluateArticleApprovalFinancialGate(financialGateInput({ usedSourceIds }));
  assert.equal(reused.reason, "PHYSICAL_ERP_ROW_ALREADY_USED");
});

test("A22: exact physical identity, match proof, period, organization, amount and shared reuse set are mandatory", () => {
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ sourceId: "ERP-ROW-2" })).reason, "PHYSICAL_ERP_ROW_NOT_UNIQUE");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ physicalRows: [physicalErpRow(), physicalErpRow()] })).reason, "PHYSICAL_ERP_ROW_NOT_UNIQUE");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ physicalProof: null })).reason, "PHYSICAL_MATCH_PROOF_REQUIRED");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ physicalRows: [physicalErpRow({ period: "2024-12", date: "31.12.2024" })] })).reason, "PHYSICAL_PERIOD_SCOPE_MISMATCH");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ allowedPhysicalOrganizations: ["Чужая"] })).reason, "PHYSICAL_ORGANIZATION_SCOPE_MISMATCH");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ amount: 80 })).reason, "PHYSICAL_AMOUNT_MISMATCH");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ usedSourceIds: null })).reason, "PHYSICAL_REUSE_GUARD_REQUIRED");
  assert.equal(evaluateArticleApprovalFinancialGate(financialGateInput({ approval: { article_approval_status: "FORBIDDEN" } })).reason, "APPROVAL_FORBIDDEN");
});

test("matrix reader keeps round-trip header and rows", () => {
  const row = approvalRow();
  const matrix = [["SHA-256 исходной сверки", sha], [], ARTICLE_APPROVAL_COLUMNS, ARTICLE_APPROVAL_COLUMNS.map((column) => row[column])];
  const parsed = readArticleApprovalMatrix(matrix);
  assert.equal(parsed.sourceSha256, sha);
  assert.equal(parsed.rows[0].КлючОбласти, row.КлючОбласти);
  assert.equal(articleApprovalOrganizationSlug({ organizationCode: "3", organizationName: "Сахалин" }), "3_sakhalin");
});
