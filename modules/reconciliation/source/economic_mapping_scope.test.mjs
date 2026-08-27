import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexInputPayload } from "./opiu_reconcile.mjs";

function payloadOptions(overrides = {}) {
  return {
    organization: "9 Управляющая компания",
    profile: {
      id: "UK_R005",
      organizationCode: "UK9",
      projectRules: "UK_PROJECT_RULES_R005",
    },
    machinePolicy: null,
    mode: "month",
    periodLabel: "2025-10",
    periods: ["2025-10"],
    aggregateRows: [],
    presentationRows: [],
    monthly: [],
    outputPath: "reconciliation.xlsx",
    outputSha256: "",
    generatedAt: "2026-08-21T00:00:00.000Z",
    tolerance: 0.01,
    referenceCatalogs: [],
    referenceCatalogTrace: [],
    sourceProvenance: {},
    intalevTemplateGraph: null,
    erpInputAuthority: null,
    operationEvidence: {},
    ...overrides,
  };
}

test("missing economic mapping stays review-only without ReferenceError", () => {
  const result = buildCodexInputPayload(payloadOptions());
  assert.deepEqual(result.economic_hierarchy_mapping, {
    schema: "opiu-economic-hierarchy-mapping-v1",
    status: "MISSING_REVIEW_ONLY",
    entry_count: 0,
    correction_authority: false,
  });
});

test("supplied economic mapping metadata is preserved", () => {
  const result = buildCodexInputPayload(payloadOptions({
    economicHierarchyMapping: { entries: [{ id: "mapping-1" }] },
  }));
  assert.deepEqual(result.economic_hierarchy_mapping, {
    schema: "opiu-economic-hierarchy-mapping-v1",
    status: "ACTIVE_EXPLICIT_MAPPING",
    entry_count: 1,
    correction_authority: false,
  });
});

test("recursive monthly payload propagation does not throw", () => {
  assert.doesNotThrow(() => buildCodexInputPayload(payloadOptions({
    periods: ["2025-10", "2025-11"],
    monthly: [
      { period: "2025-10", rows: [] },
      { period: "2025-11", rows: [] },
    ],
    economicHierarchyMapping: { entries: [{ id: "mapping-1" }] },
  })));
});
