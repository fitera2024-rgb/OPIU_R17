import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthoritativeErpEntryNode } from "./erp_exact_catalog_path.mjs";
import { resolveArticleApprovalCatalogTarget } from "./article_approval_core.mjs";

function outlineNode(level, label, sourceRow, parentLabels = []) {
  const pathParts = [...parentLabels, label];
  return {
    level,
    label,
    normalized_label: label.toLocaleLowerCase("ru-RU"),
    parent_path: parentLabels.join(" / "),
    full_path: pathParts.join(" / "),
    source_row: sourceRow,
  };
}

function entry({ article, code, account, sourceRow }) {
  return {
    cash_flow_article: article,
    code,
    account,
    source_row: sourceRow,
  };
}

test("R005-026 retains the full authoritative commercial NDFL parent chain", () => {
  const stack = [
    outlineNode(0, "Коммерческие расходы", 158),
    outlineNode(1, "ФЗП и компенсационные выплаты", 281, ["Коммерческие расходы"]),
    outlineNode(2, "НДФЛ", 286, ["Коммерческие расходы", "ФЗП и компенсационные выплаты"]),
  ];
  const physicalEntry = entry({
    article: "НДФЛ",
    code: "00-000121",
    account: "44.1",
    sourceRow: 287,
  });

  // This records the pre-fix projection and its exact observed shortening.
  const legacyProjection = `${stack[0].label} / ${physicalEntry.cash_flow_article}`;
  assert.equal(legacyProjection, "Коммерческие расходы / НДФЛ");

  const result = resolveAuthoritativeErpEntryNode({
    stack,
    entryLevel: 3,
    entry: physicalEntry,
    sourceFile: "СтатьиДоходовИРасходовЕРП.xlsx",
    sourceSheet: "Лист_1",
  });

  assert.equal(result.status, "PROVEN_EXACT_ERP_ENTRY_PARENT_CHAIN");
  assert.equal(result.node.block, "Коммерческие расходы");
  assert.equal(
    result.node.full_path,
    "Коммерческие расходы / ФЗП и компенсационные выплаты / НДФЛ",
  );
  assert.equal(result.node.parent_path, "Коммерческие расходы / ФЗП и компенсационные выплаты");
  assert.equal(result.node.catalog_entries[0].code, "00-000121");
  assert.equal(result.node.catalog_entries[0].account, "44.1");
  assert.deepEqual(result.node.authoritative_parent_chain.map((node) => node.source_row), [158, 281, 286]);

  const outlineParent = {
    ...stack.at(-1),
    catalog_entries: [physicalEntry],
  };
  const financialIdentity = resolveArticleApprovalCatalogTarget({
    block: "Коммерческие расходы",
    article: "НДФЛ",
    code: "00-000121",
    path: result.node.full_path,
  }, { nodes: [outlineParent, result.node] });
  assert.equal(financialIdentity.status, "UNIQUE");
  assert.equal(financialIdentity.count, 1);
  assert.equal(financialIdentity.target.code, "00-000121");
  assert.equal(financialIdentity.target.account, "44.1");
});

test("R005-026 applies the same full-path rule to a non-payroll entry", () => {
  const stack = [
    outlineNode(0, "Расходы на складскую логистику", 393),
    outlineNode(1, "Содержание складов", 458, ["Расходы на складскую логистику"]),
    outlineNode(2, "Страхование имущества", 467, ["Расходы на складскую логистику", "Содержание складов"]),
  ];
  const result = resolveAuthoritativeErpEntryNode({
    stack,
    entryLevel: 3,
    entry: entry({
      article: "Страхование имущества",
      code: "00-000158",
      account: "44.2",
      sourceRow: 468,
    }),
  });

  assert.equal(result.status, "PROVEN_EXACT_ERP_ENTRY_PARENT_CHAIN");
  assert.equal(
    result.node.full_path,
    "Расходы на складскую логистику / Содержание складов / Страхование имущества",
  );
});

test("R005-026 never selects the same article label from a different parent chain", () => {
  const commercial = [
    outlineNode(0, "Коммерческие расходы", 10),
    outlineNode(1, "Налоги коммерческого персонала", 11, ["Коммерческие расходы"]),
    outlineNode(2, "НДФЛ", 12, ["Коммерческие расходы", "Налоги коммерческого персонала"]),
  ];
  const administrative = [
    outlineNode(0, "Административные расходы", 20),
    outlineNode(1, "Налоги административного персонала", 21, ["Административные расходы"]),
    outlineNode(2, "НДФЛ", 22, ["Административные расходы", "Налоги административного персонала"]),
  ];

  const commercialResult = resolveAuthoritativeErpEntryNode({
    stack: commercial,
    entryLevel: 3,
    entry: entry({ article: "НДФЛ", code: "COMM", account: "44.1", sourceRow: 13 }),
  });
  const administrativeResult = resolveAuthoritativeErpEntryNode({
    stack: administrative,
    entryLevel: 3,
    entry: entry({ article: "НДФЛ", code: "ADMIN", account: "26", sourceRow: 23 }),
  });

  assert.equal(
    commercialResult.node.full_path,
    "Коммерческие расходы / Налоги коммерческого персонала / НДФЛ",
  );
  assert.equal(
    administrativeResult.node.full_path,
    "Административные расходы / Налоги административного персонала / НДФЛ",
  );
  assert.notEqual(commercialResult.node.full_path, administrativeResult.node.full_path);
});

for (const fixture of [
  {
    label: "missing intermediate chain node",
    stack: [
      outlineNode(0, "Коммерческие расходы", 1),
      undefined,
      outlineNode(2, "НДФЛ", 3, ["Коммерческие расходы", "Не доказано"]),
    ],
    article: "НДФЛ",
    status: "BLOCKED_ERP_ENTRY_PARENT_CHAIN_MISSING",
  },
  {
    label: "entry article disagrees with outline parent",
    stack: [
      outlineNode(0, "Коммерческие расходы", 1),
      outlineNode(1, "Прочие налоги", 2, ["Коммерческие расходы"]),
    ],
    article: "НДФЛ",
    status: "BLOCKED_ERP_ENTRY_PARENT_DISAGREEMENT",
  },
  {
    label: "stored outline path disagrees with its physical chain",
    stack: [
      outlineNode(0, "Коммерческие расходы", 1),
      {
        ...outlineNode(1, "НДФЛ", 2, ["Коммерческие расходы"]),
        full_path: "Административные расходы / НДФЛ",
      },
    ],
    article: "НДФЛ",
    status: "BLOCKED_ERP_ENTRY_PARENT_CHAIN_DISAGREEMENT",
  },
]) {
  test(`R005-026 fails closed for ${fixture.label}`, () => {
    const result = resolveAuthoritativeErpEntryNode({
      stack: fixture.stack,
      entryLevel: fixture.stack.length,
      entry: entry({ article: fixture.article, code: "X", account: "44.1", sourceRow: 9 }),
    });
    assert.equal(result.status, fixture.status);
    assert.equal(result.node, null);
    assert.ok(result.diagnostic);
  });
}
