import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import {
  applyUkFinancialPresentationCoverage,
  applyVisibleHierarchyGroupRollups,
  resolveErpRows,
  resolveIntalevRow,
} from "./opiu_reconcile.mjs";
import { applyEmptyArticleBindingsToBlankArticleReporting } from "./empty_article_binding_application.mjs";
import { buildHierarchyPresentationRows } from "./r005_intalev_tree_presentation.mjs";
import { classifyProvenParentAccountFlows } from "./arbitrary_period_operation_evidence.mjs";

const PERIOD = "2026-02";
const ORGANIZATION = Object.freeze({
  organization_id: "ORG-SYNTHETIC-PIPELINE",
  organization_name: "Synthetic pipeline organization",
  organization_hierarchy_path: ["Synthetic consolidation", "Pipeline organization"],
});
const SOURCE_SHA = crypto.createHash("sha256").update("synthetic ERP report source").digest("hex").toUpperCase();
const JOURNAL_SHA = crypto.createHash("sha256").update("synthetic ERP journal source").digest("hex").toUpperCase();
const GRAPH_SHA = crypto.createHash("sha256").update("synthetic signed hierarchy graph").digest("hex").toUpperCase();
const TEMPLATE_SHA = crypto.createHash("sha256").update("synthetic signed template").digest("hex").toUpperCase();

function deterministicCents(label) {
  const digest = crypto.createHash("sha256").update(label).digest();
  return 1_000 + digest.readUInt16BE(0);
}

function sourceRow({ row, article, amount, catalogPath, fullPath, parentIndex = null }) {
  return {
    row,
    period: PERIOD,
    month: PERIOD,
    article,
    amount,
    catalog_path: catalogPath,
    full_path: fullPath,
    parent_index: parentIndex,
    sha256: SOURCE_SHA,
    sheet: "ERP",
    source_cell: `D${row}`,
    source_identity: `${SOURCE_SHA}|ERP|${row}`,
    source_identity_scope: `${SOURCE_SHA}|ERP|${PERIOD}`,
    period_header_trace: { period: PERIOD },
    source_tree_proof: { complete: true, status: "LEAF" },
  };
}

function sourceFixture() {
  const labels = ["Synthetic component alpha", "Synthetic component beta"];
  const amounts = labels.map((label) => deterministicCents(label) / 100);
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const root = "Synthetic report / Financial branch";
  const catalogPrefix = "Synthetic catalog / Parent summary";
  const rows = [
    sourceRow({
      row: 10,
      article: "Parent summary",
      amount: total,
      catalogPath: `${catalogPrefix} / Parent summary`,
      fullPath: `${root} / Parent summary`,
      parentIndex: 90,
    }),
    sourceRow({
      row: 11,
      article: "Alias summary",
      amount: total,
      catalogPath: `${catalogPrefix} / Alias summary / Alias summary`,
      fullPath: `${root} / Alias summary`,
      parentIndex: 90,
    }),
    ...labels.map((article, index) => sourceRow({
      row: 12 + index,
      article,
      amount: amounts[index],
      catalogPath: `${catalogPrefix} / ${article} | ${catalogPrefix} / Alias summary / ${article}`,
      fullPath: `${root} / ${article}`,
    })),
    sourceRow({
      row: 20,
      article: "Complete total",
      amount: total,
      catalogPath: "Synthetic catalog / Complete total",
      fullPath: "Synthetic report / Complete total",
    }),
  ];
  return { labels, amounts, total, rows };
}

function templateRow({ code, label, parentCode = "", outlineLevel = 0, pathCodes, pathLabels }) {
  return {
    code,
    intalev_label: label,
    erp_label: code === "R052" || code === "R053" ? label : "",
    intalev_reference_status: "PROVEN_APPROVED_TEMPLATE_GRAPH",
    intalev_reference_parent_code: parentCode,
    intalev_source_parent_code: parentCode,
    intalev_reference_outline_level: outlineLevel,
    intalev_source_outline_level: outlineLevel,
    intalev_source_outline_basis: "APPROVED_INTALEV_TEMPLATE_GRAPH",
    intalev_reference_path_codes: pathCodes,
    intalev_reference_path_labels: pathLabels,
    intalev_reference_graph_id: "SYNTHETIC-SIGNED-GRAPH",
    intalev_reference_graph_sha256: GRAPH_SHA,
    intalev_reference_template_sha256: TEMPLATE_SHA,
    intalev_reference_source_sheet: "Synthetic template",
    intalev_reference_source_row: outlineLevel + 1,
    intalev_reference_source_cell: `A${outlineLevel + 1}`,
  };
}

function templateRows(fixture) {
  return [
    templateRow({
      code: "R050",
      label: "Parent summary",
      pathCodes: ["R050"],
      pathLabels: ["Financial branch", "Parent summary"],
    }),
    templateRow({
      code: "R051",
      label: "Alias summary",
      parentCode: "R050",
      outlineLevel: 1,
      pathCodes: ["R050", "R051"],
      pathLabels: ["Financial branch", "Parent summary", "Alias summary"],
    }),
    templateRow({
      code: "R052",
      label: fixture.labels[1],
      parentCode: "R051",
      outlineLevel: 2,
      pathCodes: ["R050", "R051", "R052"],
      pathLabels: ["Financial branch", "Parent summary", "Alias summary", fixture.labels[1]],
    }),
    templateRow({
      code: "R053",
      label: "Complete total",
      pathCodes: ["R053"],
      pathLabels: ["Complete total"],
    }),
  ];
}

function hierarchyRows(fixture) {
  const templates = templateRows(fixture);
  const resolved = resolveErpRows(templates, { period: PERIOD, rows: fixture.rows });
  const intalevAmounts = new Map([
    ["R050", fixture.total],
    ["R051", fixture.total],
    ["R052", fixture.amounts[1]],
    ["R053", fixture.total],
  ]);
  return buildHierarchyPresentationRows(
    templates.map((template) => ({
      ...template,
      hierarchy_path: template.intalev_reference_path_labels,
      hierarchy_period_consistent: true,
      intalev: { amount: intalevAmounts.get(template.code), status: "MATCHED", trace: [] },
      erp: resolved.get(template.code),
    })),
    { expectedCodes: templates.map((row) => row.code) },
  );
}

function bindingRule(label) {
  return {
    binding_id: "BINDING-SYNTHETIC-PIPELINE",
    organization_scope: ORGANIZATION,
    validity: { from: "2026-01", to: "2026-12" },
    source: {
      parent_path: ["Synthetic personnel", "<blank ancestor>"],
      leaf_labels: [label],
      blank_ancestor_required: true,
    },
    target: {
      target_code: "TARGET-SYNTHETIC-PIPELINE",
      target_node_identity: "ERP-NODE-SYNTHETIC-PIPELINE",
      display_path: ["Synthetic target", "Classified component"],
      display_article: "Classified component",
    },
    mode: "CLASSIFICATION_ONLY",
    decision_type: "NO_POSTING",
  };
}

function bindingItem(label, amount) {
  const parentPath = "Synthetic personnel / <blank ancestor>";
  return {
    classification: "UNCLASSIFIED",
    article: "",
    amount,
    period: PERIOD,
    source_scope_role: "UNCLASSIFIED_DETAIL",
    classification_basis: "EMPTY_ARTICLE_ANCESTOR",
    source_parent_path: parentPath,
    source_path: `${parentPath} / ${label}`,
    blank_branch_source_path: parentPath,
    source_label: label,
    source_is_leaf: true,
    target_code: "",
    erp_article: "",
    erp_amount: null,
    correction_allowed: false,
    financial_posting_rows: 0,
  };
}

function operation({ row, article, amount, debit, credit }) {
  const identity = [PERIOD, ORGANIZATION.organization_id, row, article, amount, debit, credit].join("\u0000");
  return {
    physical_row: row,
    source_range: `B${row}:AG${row}`,
    source_row_id: crypto.createHash("sha256").update(identity).digest("hex").toUpperCase(),
    date: "28.02.2026 0:00:00",
    document: `Synthetic document ${row}`,
    posting_no: row,
    organization: ORGANIZATION.organization_name,
    debit,
    credit,
    debit_analytics: [],
    credit_analytics: [],
    amount,
    article,
    disclosure: "Synthetic account-flow proof",
    period: PERIOD,
    erp_input_sha256: SOURCE_SHA,
    erp_opiu_sha256: SOURCE_SHA,
    journal_sha256: JOURNAL_SHA,
    journal_sheet: "ERP journal",
  };
}

function operationsFor(fixture) {
  const alphaCents = Math.round(fixture.amounts[0] * 100);
  const alphaFirst = Math.floor(alphaCents / 2) / 100;
  const alphaSecond = (alphaCents - Math.floor(alphaCents / 2)) / 100;
  return [
    operation({ row: 1001, article: fixture.labels[0], amount: alphaFirst, debit: "91.2", credit: "60" }),
    operation({ row: 1002, article: fixture.labels[0], amount: alphaSecond, debit: "91.2", credit: "71.1" }),
    operation({ row: 1003, article: fixture.labels[0], amount: fixture.amounts[0], debit: "99", credit: "91.2" }),
    operation({ row: 1004, article: fixture.labels[1], amount: fixture.amounts[1], debit: "91.2", credit: "79.1" }),
    operation({ row: 1005, article: fixture.labels[1], amount: fixture.amounts[1], debit: "99", credit: "91.2" }),
  ];
}

test("resolve to operation evidence preserves exact composition and keeps blank binding classification-only", () => {
  const fixture = sourceFixture();

  const taxAmount = deterministicCents("Synthetic tax child") / 100;
  const fzpContainerAmount = fixture.total + taxAmount;
  const r036 = resolveIntalevRow(
    { code: "R036", intalev_label: "Synthetic FZP", erp_label: "" },
    {
      nodes: [
        {
          label: "<пустое значение>",
          normalized_label: "<пустое значение>",
          normalized_path: "фзп и компенсационные выплаты / <пустое значение>",
          parent_path: "ФЗП и компенсационные выплаты",
          value: fzpContainerAmount,
        },
        {
          label: "НДФЛ",
          normalized_label: "ндфл",
          normalized_path: "фзп и компенсационные выплаты / <пустое значение> / ндфл",
          parent_path: "ФЗП и компенсационные выплаты / <пустое значение>",
          value: taxAmount,
        },
      ],
    },
    { id: "SYNTHETIC", restrictAdministrativePath: false },
    { entries: [] },
  );
  assert.equal(r036.status, "MATCHED");
  assert.equal(r036.amount, fzpContainerAmount);

  const hierarchy = hierarchyRows(fixture);
  const resolvedParent = hierarchy.find((row) => row.code === "R050");
  const resolvedAlias = hierarchy.find((row) => row.code === "R051");
  assert.equal(resolvedParent.erp.proven_parent_composition.status, "PROVEN_ERP_PARENT_COMPOSITION");
  assert.equal(resolvedAlias.erp.proven_parent_composition_alias.status, "PROVEN_ERP_PARENT_COMPOSITION_ALIAS");
  assert.equal(
    resolvedParent.erp.trace.filter((row) => row.exact_parent_component === true).length,
    fixture.labels.length,
  );
  const exactTraceBeforeBinding = structuredClone(resolvedParent.erp.trace);

  const reporting = {
    rows: hierarchy,
    display_scopes: [{
      source_scope_id: "SCOPE-SYNTHETIC-PIPELINE",
      owner_code: "R050",
      blank_amount: fixture.amounts[0],
      financial_posting_rows: 0,
      items: [bindingItem(fixture.labels[0], fixture.amounts[0])],
    }],
    financial_posting_authority: 0,
    financial_posting_rows: 0,
    correction_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
  };
  const binding = applyEmptyArticleBindingsToBlankArticleReporting({
    organization: ORGANIZATION,
    period: PERIOD,
    reporting,
    bindingRules: [bindingRule(fixture.labels[0])],
  });
  assert.equal(binding.reporting.rows, reporting.rows);
  assert.deepEqual(binding.reporting.rows.find((row) => row.code === "R050").erp.trace, exactTraceBeforeBinding);
  assert.equal(binding.audit.classification_only, true);
  assert.equal(binding.audit.financial_rows, 0);
  assert.equal(binding.audit.posting_rows, 0);
  assert.equal(binding.audit.residual_consumption, 0);

  const missingBinding = applyEmptyArticleBindingsToBlankArticleReporting({
    organization: ORGANIZATION,
    period: PERIOD,
    reporting,
    bindingRules: [],
  });
  assert.equal(missingBinding.audit.status, "INACTIVE_NO_BINDING_RULES");
  assert.equal(missingBinding.audit.release_allowed, false);
  assert.equal(missingBinding.audit.posting_rows, 0);
  assert.equal(missingBinding.reporting.rows, reporting.rows);

  const rollup = applyVisibleHierarchyGroupRollups(binding.reporting.rows);
  const coverage = applyUkFinancialPresentationCoverage(rollup.rows, { profileId: "UK_R005" });
  const parentAfterCoverage = coverage.rows.find((row) => row.code === "R050");
  assert.deepEqual(parentAfterCoverage.erp.trace, exactTraceBeforeBinding);

  const normalizationOnlyArticle = "Normalization trace must not authorize an operation";
  parentAfterCoverage.erp.normalization_trace = [{
    ...sourceRow({
      row: 99,
      article: normalizationOnlyArticle,
      amount: fixture.total,
      catalogPath: `Synthetic catalog / ${normalizationOnlyArticle}`,
      fullPath: `Synthetic report / ${normalizationOnlyArticle}`,
    }),
    exact_parent_component: true,
  }];
  const normalizationOnlyOperations = [
    operation({ row: 1098, article: normalizationOnlyArticle, amount: fixture.total, debit: "91.2", credit: "60" }),
    operation({ row: 1099, article: normalizationOnlyArticle, amount: fixture.total, debit: "99", credit: "91.2" }),
  ];
  const physicalOperations = operationsFor(fixture);
  const proof = classifyProvenParentAccountFlows({
    financialRows: coverage.rows,
    activeRows: [...physicalOperations, ...normalizationOnlyOperations],
    period: PERIOD,
    allowedJournalOrganizations: new Set([ORGANIZATION.organization_name]),
  });
  const expectedIds = physicalOperations.map((row) => row.source_row_id).sort();
  assert.equal(proof.status, "PROVEN_PARENT_ACCOUNT_FLOWS");
  assert.equal(proof.source_row_ids.length, 5);
  assert.deepEqual([...proof.source_row_ids].sort(), expectedIds);
  assert.equal(new Set(proof.source_row_ids).size, proof.source_row_ids.length);
  assert.equal(proof.operational_amount, fixture.total);
  assert.equal(proof.consumed_amount_once, fixture.total);
  assert.equal(proof.closing_amount_excluded, fixture.total);
  assert.equal(proof.flows.every((flow) => flow.closing_non_additive === true), true);
  assert.equal(
    normalizationOnlyOperations.some((row) => proof.source_row_ids.includes(row.source_row_id)),
    false,
  );

  const drifted = structuredClone(fixture);
  drifted.rows.find((row) => row.article === fixture.labels[0]).source_identity_scope += "|DRIFT";
  const driftTemplates = templateRows(drifted);
  const driftResolved = resolveErpRows(
    driftTemplates,
    { period: PERIOD, rows: drifted.rows },
  ).get("R050");
  assert.equal(driftResolved.proven_parent_composition, undefined);
  assert.equal(
    driftResolved.trace.some((row) => row?.exact_parent_component === true),
    false,
  );
});

const goldenPath = process.env.OPIU_R005_OCT_GOLDEN_CODEX_INPUT;
const currentPath = process.env.OPIU_R005_OCT_CURRENT_CODEX_INPUT;

test("real October golden retains all top rows and its five exact physical account-flow rows", {
  skip: !(goldenPath && currentPath),
}, async () => {
  const [golden, current] = await Promise.all(
    [goldenPath, currentPath].map(async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"))),
  );
  const goldenRows = golden.period_rows?.[0]?.rows ?? [];
  const currentRows = current.period_rows?.[0]?.rows ?? [];
  const financialSignature = (rows) => rows
    .map((row) => [row.code, row.intalev_amount, row.erp_amount, row.delta])
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(
    financialSignature(currentRows),
    financialSignature(goldenRows),
  );

  const currentR036 = currentRows.find((row) => row.code === "R036");
  assert.equal(currentR036.intalev_amount, currentR036.intalev_sources[0].amount);
  assert.equal(currentR036.intalev_status, "MATCHED");

  const goldenFlow = golden.operation_evidence?.proven_parent_account_flows?.[0];
  const currentFlow = current.operation_evidence?.proven_parent_account_flows?.[0];
  assert.ok(goldenFlow);
  assert.ok(currentFlow);
  assert.equal(goldenFlow.source_row_ids.length, 5);
  assert.deepEqual([...currentFlow.source_row_ids].sort(), [...goldenFlow.source_row_ids].sort());
  assert.equal(currentFlow.operational_amount, goldenFlow.operational_amount);
  assert.equal(currentFlow.consumed_amount_once, goldenFlow.consumed_amount_once);
  assert.equal(currentFlow.closing_amount_excluded, goldenFlow.closing_amount_excluded);
  assert.equal(new Set(currentFlow.source_row_ids).size, currentFlow.source_row_ids.length);
  assert.equal(
    current.operation_evidence.counts.exact_bound_operation_rows,
    golden.operation_evidence.counts.exact_bound_operation_rows,
  );
});
