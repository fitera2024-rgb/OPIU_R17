import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { financialCoverageNonzeroRows } from "./r001_structural_root_coverage.mjs";

const PERIOD = "2025-10";
const ORGANIZATION = "ORG-SYNTHETIC";
const GROUP_ID = "CONTROL-SYNTHETIC";

function rootRow(code, delta) {
  return {
    code,
    organization: ORGANIZATION,
    period: PERIOD,
    delta,
    owner_presentation_block_exempt: true,
    owner_control_only: true,
    owner_posting_classification: "NON_POSTING",
    structural_group_control_enabled: true,
    structural_group_control_set_id: GROUP_ID,
    structural_control_group_id: GROUP_ID,
    structural_group_sum_status: "STRUCTURAL_GROUP_SUM_OK",
    structural_group_descendant_internal_checks_active: true,
    structural_group_control_financial_posting_rows: 0,
  };
}

function payload(overrides = {}) {
  return {
    organization: ORGANIZATION,
    period: PERIOD,
    structural_group_control_sets: [{
      id: GROUP_ID,
      organization: ORGANIZATION,
      enabled: true,
      members: ["R045", "R055"],
      mode: "SUM_DELTA_ONLY",
      tolerance: 0.01,
    }],
    structural_group_control_results: [{
      group_id: GROUP_ID,
      control_set_id: GROUP_ID,
      organization: ORGANIZATION,
      period: PERIOD,
      member_codes: ["R045", "R055"],
      classification: "STRUCTURAL_GROUP_SUM_OK",
      complete: true,
      review_only: false,
      blockers: [],
      control_sum_delta: 0,
      member_rows: [{ code: "R045" }, { code: "R055" }],
      structural_effect_consumed_once: true,
      control_residual_consumed_once: true,
      individual_parent_reclassification_allowed: false,
      descendant_internal_checks_active: true,
      structural_control_financial_posting_rows: 0,
      posting_rows: 0,
      posting_allowed: false,
      execution_allowed: false,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      report_only: true,
    }],
    period_rows: [{
      period: PERIOD,
      rows: [
        rootRow("R045", -100),
        rootRow("R055", 100),
        { code: "R046", organization: ORGANIZATION, period: PERIOD, delta: 10 },
      ],
    }],
    ...overrides,
  };
}

test("closed configured roots leave financial coverage while descendants remain", () => {
  assert.deepEqual(financialCoverageNonzeroRows(payload()), [
    { period: PERIOD, code: "R046" },
  ]);
});

test("mismatched or incomplete structural sets remain fail-closed", () => {
  const mismatch = payload();
  mismatch.structural_group_control_results[0] = {
    ...mismatch.structural_group_control_results[0],
    classification: "STRUCTURAL_GROUP_SUM_MISMATCH",
    control_sum_delta: 1,
  };
  assert.deepEqual(
    financialCoverageNonzeroRows(mismatch).map((row) => row.code),
    ["R045", "R055", "R046"],
  );

  const missingResult = payload({ structural_group_control_results: [] });
  assert.deepEqual(
    financialCoverageNonzeroRows(missingResult).map((row) => row.code),
    ["R045", "R055", "R046"],
  );
});

test("row flags alone cannot create an exemption without run-bound config", () => {
  const noConfig = payload({ structural_group_control_sets: [] });
  assert.deepEqual(
    financialCoverageNonzeroRows(noConfig).map((row) => row.code),
    ["R045", "R055", "R046"],
  );
});

test("wrapper consumes the run-bound structural coverage helper", () => {
  const wrapper = fs.readFileSync(path.resolve(
    "development/OPIU_1.9.4/modules/corrections/source/service_r001_owner_wrapper.mjs",
  ), "utf8");
  assert.match(wrapper, /financialCoverageNonzeroRows/u);
  assert.doesNotMatch(wrapper, /!isOwnerPresentationBlockExempt\(row\)/u);
});
