import test from "node:test";
import assert from "node:assert/strict";

import { applyUkFinancialPresentationCoverage } from "./opiu_reconcile.mjs";

function row(code, intalev, erp) {
  return {
    code,
    intalev: { amount: intalev, trace: [{ full_path: `Инталев / ${code}` }] },
    erp: { amount: erp, trace: [{ full_path: `ERP / ${code}` }] },
  };
}

test("covers duplicated UK R050/R051 presentation levels when R052 and R053 are closed", () => {
  const result = applyUkFinancialPresentationCoverage([
    row("R050", 12023, 3800),
    row("R051", 12023, 3800),
    row("R052", 3800, 3800),
    row("R053", 14608736.8, 14608736.8),
  ], { profileId: "UK_R005" });

  assert.equal(result.audit.length, 1);
  for (const code of ["R050", "R051"]) {
    const covered = result.rows.find((item) => item.code === code);
    assert.equal(covered.erp.raw_amount, 3800);
    assert.equal(covered.erp.amount, 12023);
    assert.equal(
      covered.erp.normalization_status,
      "STRUCTURAL_PRESENTATION_COVERED_BY_R053",
    );
    assert.equal(covered.structural_presentation_coverage.raw_delta, 8223);
    assert.equal(covered.structural_presentation_coverage.financial_posting_rows, 0);
  }
});

test("does not cover the presentation levels while the R053 total is open", () => {
  const result = applyUkFinancialPresentationCoverage([
    row("R050", 12023, 3800),
    row("R051", 12023, 3800),
    row("R052", 3800, 3800),
    row("R053", 14608736.8, 14600000),
  ], { profileId: "UK_R005" });

  assert.equal(result.audit.length, 0);
  assert.equal(result.rows.find((item) => item.code === "R050").erp.amount, 3800);
});

test("does not apply the UK-only coverage to another profile", () => {
  const result = applyUkFinancialPresentationCoverage([
    row("R050", 12023, 3800),
    row("R051", 12023, 3800),
    row("R052", 3800, 3800),
    row("R053", 14608736.8, 14608736.8),
  ], { profileId: "SAKHALIN_R005" });

  assert.equal(result.audit.length, 0);
  assert.equal(result.rows.find((item) => item.code === "R050").erp.amount, 3800);
});
