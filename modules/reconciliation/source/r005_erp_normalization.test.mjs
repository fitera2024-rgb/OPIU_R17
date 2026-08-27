import assert from "node:assert/strict";
import test from "node:test";
import {
  keepRawWithReclassificationCandidate,
  useDerivedOnlyWhenRawMissing,
} from "./r005_erp_normalization.mjs";

test("literal ERP remains authoritative when a reclassification candidate exists", () => {
  const result = keepRawWithReclassificationCandidate(
    { amount: 1605037.75, status: "MATCHED", trace: ["raw"], note: "raw" },
    { amount: 35347.99, status: "AGGREGATED_RULE", trace: ["candidate"], note: "candidate" },
  );
  assert.equal(result.amount, 1605037.75);
  assert.equal(result.raw_amount, 1605037.75);
  assert.equal(result.normalized_amount, 35347.99);
  assert.deepEqual(result.trace, ["raw"]);
  assert.deepEqual(result.normalization_trace, ["candidate"]);
});

test("derived amount is review-only when no literal ERP row exists", () => {
  const result = useDerivedOnlyWhenRawMissing(
    { amount: null, status: "MISSING", trace: [] },
    { amount: 3800, status: "AGGREGATED_RULE", trace: ["source"], note: "derived" },
  );
  assert.equal(result.amount, 3800);
  assert.equal(result.raw_amount, null);
  assert.equal(result.normalized_amount, 3800);
  assert.equal(result.status, "AGGREGATED_RULE");
});
