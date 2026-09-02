import assert from "node:assert/strict";
import test from "node:test";

import { evaluateArticleApprovalFinancialGate } from "./article_approval_core.mjs";
import {
  derivePhysicalOrganizationScope,
  loadAuthoritativeOrganizationHierarchy,
} from "./physical_organization_scope.mjs";

function node(overrides = {}) {
  return {
    node_id: "",
    code: "",
    name: "",
    path: "",
    parent_id: "",
    top_id: "",
    top_name: "",
    depth: 0,
    node_type: "ORGANIZATION",
    source_verified: true,
    metadata: { inn: "", kpp: "", full_legal_name: "", functional_direction: "" },
    ...overrides,
  };
}

function hierarchy({ duplicatePhysicalName = false } = {}) {
  const nodes = [
    node({
      node_id: "ROOT-A", code: "A", name: "3 Сахалин", path: "3 Сахалин",
      top_id: "ROOT-A", top_name: "3 Сахалин", depth: 0,
    }),
    node({
      node_id: "TRADE-A", code: "A-TRADE", name: "Торговая компания",
      path: "3 Сахалин / Торговая компания", parent_id: "ROOT-A",
      top_id: "ROOT-A", top_name: "3 Сахалин", depth: 1, node_type: "GROUP", code: "",
    }),
    node({
      node_id: "PV-A", code: "A-PV", name: "ПВ",
      path: "3 Сахалин / Торговая компания / ПВ", parent_id: "TRADE-A",
      top_id: "ROOT-A", top_name: "3 Сахалин", depth: 2,
      metadata: { inn: "650118233", kpp: "650101001", full_legal_name: "ООО Планета Витаминов", functional_direction: "" },
    }),
    node({
      node_id: "DEPT-A", code: "A-DEPT", name: "Б_ПВ Отдел по управлению персоналом",
      path: "3 Сахалин / Торговая компания / ПВ / Б_ПВ Отдел по управлению персоналом",
      parent_id: "PV-A", top_id: "ROOT-A", top_name: "3 Сахалин", depth: 3,
      metadata: { inn: "", kpp: "", full_legal_name: "Б_ПВ Отдел по управлению персоналом", functional_direction: "Департамент по управлению персоналом" },
    }),
    node({
      node_id: "ROOT-B", code: "B", name: "4 Владивосток", path: "4 Владивосток",
      top_id: "ROOT-B", top_name: "4 Владивосток", depth: 0,
    }),
    node({
      node_id: "TRADE-B", code: "B-TRADE", name: "Торговая компания",
      path: "4 Владивосток / Торговая компания", parent_id: "ROOT-B",
      top_id: "ROOT-B", top_name: "4 Владивосток", depth: 1, node_type: "GROUP",
    }),
    node({
      node_id: "FOREIGN-B", code: "B-FOREIGN", name: "ЧУЖАЯ",
      path: "4 Владивосток / Торговая компания / ЧУЖАЯ", parent_id: "TRADE-B",
      top_id: "ROOT-B", top_name: "4 Владивосток", depth: 2,
      metadata: { inn: "250000001", kpp: "250001001", full_legal_name: "ООО Чужая", functional_direction: "" },
    }),
  ];
  if (duplicatePhysicalName) {
    nodes.push(node({
      node_id: "PV-B", code: "B-PV", name: "ПВ",
      path: "4 Владивосток / Торговая компания / ПВ", parent_id: "TRADE-B",
      top_id: "ROOT-B", top_name: "4 Владивосток", depth: 2,
      metadata: { inn: "250000002", kpp: "250001002", full_legal_name: "ООО Другая ПВ", functional_direction: "" },
    }));
  }
  return { schema_version: "opiu-organizations.v1", source: { sha256: "A".repeat(64) }, nodes };
}

function scopeFor(authoritativeHierarchy = hierarchy()) {
  return derivePhysicalOrganizationScope({
    selectedOrganizationId: "ROOT-A",
    selectedOrganizationName: "3 Сахалин",
    selectedOrganizationPath: "3 Сахалин",
    authoritativeHierarchy,
  });
}

function physicalRow(overrides = {}) {
  return {
    source_row_id: "ERP-ROW-1", physical_row: 1617, period: "2025-01",
    date: "15.01.2025", document: "Трансляция 0001", posting_no: 7,
    organization: "ПВ", debit: "26", credit: "76.5",
    debit_analytics: ["Проезд/доставка сотрудников"], credit_analytics: ["Сотрудник"],
    amount: 1854, article: "Проезд/доставка сотрудников", content: "Физическая операция",
    ...overrides,
  };
}

function gateInput(allowedPhysicalOrganizations, overrides = {}) {
  return {
    approval: {
      article_approval_status: "APPROVED_EXACT_SCOPE",
      article_approval_target: { block: "Склад", article: "Проезд/доставка сотрудников", code: "ERP-10" },
      article_approval_scope: {
        organization_id: "ROOT-A", period: "2025-01",
        block_intalev: "Склад", article_intalev: "Проезд/доставка сотрудников",
      },
    },
    physicalRows: [physicalRow()], amount: 1854, sourceId: "ERP-ROW-1",
    usedSourceIds: new Set(),
    scope: { organizationId: "ROOT-A", period: "2025-01", block: "Склад", article: "Проезд/доставка сотрудников" },
    erpCatalog: [{ block: "Склад", article: "Проезд/доставка сотрудников", code: "ERP-10" }],
    physicalProof: {
      status: "PROVEN_CROSS_JOURNAL_MATCH", mutually_unique: true,
      erp_source_row_id: "ERP-ROW-1", intalev_source_row_ids: ["INTALEV-ROW-1"],
      period: "2025-01", amount: 1854,
    },
    allowedPhysicalOrganizations,
    sourceArticleCode: "ERP-OLD",
    ...overrides,
  };
}

test("R005-022: proven entity descendant enters the exact selected physical perimeter", () => {
  const scope = scopeFor();
  assert.equal(scope.status, "PROVEN_PHYSICAL_ORGANIZATION_SCOPE");
  assert.deepEqual(scope.member_names, ["3 Сахалин", "ПВ"]);
  const usedSourceIds = new Set();
  const gate = evaluateArticleApprovalFinancialGate(gateInput(scope.member_names, { usedSourceIds }));
  assert.equal(gate.status, "ДОКАЗАНО");
  assert.equal(gate.reason, "UNIQUE_PHYSICAL_ERP_ROW");
  assert.equal(gate.financial_pair_rows, 2);
  assert.equal(gate.correction_rows.reduce((sum, row) => sum + row.amount, 0), 0);
  assert.equal(Math.abs(gate.correction_rows[0].amount), gate.correction_rows[1].amount);
  assert.deepEqual([...usedSourceIds], ["ERP-ROW-1"]);
  for (const row of gate.correction_rows) {
    assert.equal(row.source_row_id, "ERP-ROW-1");
    assert.equal(row.organization, "ПВ");
    assert.equal(row.date, "15.01.2025");
    assert.equal(row.document, "Трансляция 0001");
    assert.equal(row.posting_no, 7);
    assert.equal(row.debit, "26");
    assert.equal(row.credit, "76.5");
  }
  assert.equal(gate.posting_rows, 0);
  assert.equal(gate.live_rows, 0);
  assert.equal(gate.executed_rows, 0);
});

test("R005-022: entity under another root and non-entity descendant stay outside", () => {
  const scope = scopeFor();
  assert.ok(!scope.member_names.includes("ЧУЖАЯ"));
  assert.ok(!scope.member_names.includes("Б_ПВ Отдел по управлению персоналом"));
  for (const organization of ["ЧУЖАЯ", "Б_ПВ Отдел по управлению персоналом"]) {
    const gate = evaluateArticleApprovalFinancialGate(gateInput(scope.member_names, {
      physicalRows: [physicalRow({ organization })],
    }));
    assert.equal(gate.reason, "PHYSICAL_ORGANIZATION_SCOPE_MISMATCH");
  }
});

test("R005-022: same visible entity name under another root is ambiguous and grants no membership", () => {
  const scope = scopeFor(hierarchy({ duplicatePhysicalName: true }));
  assert.equal(scope.status, "PROVEN_PHYSICAL_ORGANIZATION_SCOPE");
  assert.ok(!scope.member_names.includes("ПВ"));
  assert.equal(
    evaluateArticleApprovalFinancialGate(gateInput(scope.member_names)).reason,
    "PHYSICAL_ORGANIZATION_SCOPE_MISMATCH",
  );
});

test("R005-022: missing or malformed hierarchy proof remains fail-closed", () => {
  const missing = scopeFor({ schema_version: "opiu-organizations.v1", source: { sha256: "A".repeat(64) }, nodes: [] });
  assert.equal(missing.status, "BLOCKED_PHYSICAL_ORGANIZATION_SCOPE");
  assert.deepEqual(missing.member_names, []);

  const malformedHierarchy = hierarchy();
  malformedHierarchy.nodes.push({ ...malformedHierarchy.nodes[2] });
  const malformed = scopeFor(malformedHierarchy);
  assert.equal(malformed.status, "BLOCKED_PHYSICAL_ORGANIZATION_SCOPE");
  assert.deepEqual(malformed.member_names, []);
  assert.equal(
    evaluateArticleApprovalFinancialGate(gateInput(malformed.member_names)).reason,
    "PHYSICAL_ORGANIZATION_SCOPE_MISMATCH",
  );

  const incompleteRootIdentity = derivePhysicalOrganizationScope({
    selectedOrganizationName: "3 Сахалин",
    selectedOrganizationPath: "3 Сахалин",
    authoritativeHierarchy: hierarchy(),
  });
  assert.equal(incompleteRootIdentity.status, "BLOCKED_PHYSICAL_ORGANIZATION_SCOPE");
  assert.deepEqual(incompleteRootIdentity.blocker_codes, [
    "SELECTED_ORGANIZATION_ROOT_IDENTITY_INCOMPLETE",
  ]);
});

test("R005-022: pinned real ERP hierarchy proves ПВ and excludes its department", async () => {
  const authoritativeHierarchy = await loadAuthoritativeOrganizationHierarchy({
    expectedSourceSha256: "3342603C0782FE12871AD55E7E19E778A97651E8CFF2E00F0CE6774295C57522",
  });
  const scope = derivePhysicalOrganizationScope({
    selectedOrganizationId: "ERP-000000076",
    selectedOrganizationName: "3 Сахалин",
    selectedOrganizationPath: "3 Сахалин",
    authoritativeHierarchy,
  });
  assert.equal(scope.status, "PROVEN_PHYSICAL_ORGANIZATION_SCOPE");
  assert.ok(scope.member_names.includes("ПВ"));
  assert.ok(!scope.member_names.includes("Б_ПВ Отдел по управлению персоналом"));
  assert.deepEqual(
    scope.member_identities.find((member) => member.name === "ПВ"),
    {
      node_id: "ERP-000000011",
      code: "000000011",
      name: "ПВ",
      path: "3 Сахалин / Торговая компания / ПВ",
      top_id: "ERP-000000076",
      source_verified: true,
      role_proof: "ERP_LEGAL_ENTITY_INN",
    },
  );
});

test("R005-022: exact period, SourceRowID, amount, uniqueness and reuse guards remain unchanged", () => {
  const allowed = scopeFor().member_names;
  const cases = [
    ["period", { physicalRows: [physicalRow({ period: "2024-12" })] }, "PHYSICAL_PERIOD_SCOPE_MISMATCH"],
    ["source id mandatory", { sourceId: "" }, "PHYSICAL_REUSE_GUARD_REQUIRED"],
    ["source row unique", { physicalRows: [physicalRow(), physicalRow()] }, "PHYSICAL_ERP_ROW_NOT_UNIQUE"],
    ["amount", { amount: 1 }, "PHYSICAL_AMOUNT_MISMATCH"],
  ];
  for (const [label, overrides, reason] of cases) {
    assert.equal(evaluateArticleApprovalFinancialGate(gateInput(allowed, overrides)).reason, reason, label);
  }
  const usedSourceIds = new Set(["ERP-ROW-1"]);
  assert.equal(
    evaluateArticleApprovalFinancialGate(gateInput(allowed, { usedSourceIds })).reason,
    "PHYSICAL_ERP_ROW_ALREADY_USED",
  );
});
