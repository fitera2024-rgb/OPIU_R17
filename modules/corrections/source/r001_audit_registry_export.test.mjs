import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import {
  auditRegistryFilenames,
  AUDIT_REGISTRY_FILENAME_CONTRACT,
  buildAuditRegistryProjection,
  buildAuditRegistryWorkbooks,
  CORRECTION_REGISTRY_SHEETS,
  DISCREPANCY_REGISTRY_SHEETS,
} from "./r001_audit_registry_export.mjs";

const SHA = {
  reconciliation: "A".repeat(64),
  sidecar: "B".repeat(64),
  erp: "C".repeat(64),
  intalev: "D".repeat(64),
  journal: "E".repeat(64),
};

function periods(count) {
  return Array.from({ length: count }, (_, index) => `2025-${String(index + 1).padStart(2, "0")}`);
}

function fixture(periodCount = 12, { crossMonth = false } = {}) {
  const selectedPeriods = periods(periodCount);
  const payrollPeriod = selectedPeriods.includes("2025-11") ? "2025-11" : selectedPeriods.at(-1);
  const targetPeriod = crossMonth ? "2025-12" : payrollPeriod;
  const baseRows = selectedPeriods.flatMap((period, index) => [{
    organization: "9 Управляющая компания",
    period,
    code: `R9${String(index).padStart(2, "0")}`,
    intalev_label: `UNPROVEN ${period}`,
    intalev_amount: 1000 + index,
    erp_amount: 975 + index,
    delta: 25,
    normalized_delta: 25,
    is_discrepancy: true,
    default_decision: "PROCESS",
    proof_status: "UNPROVEN",
    hierarchy_has_children: false,
    intalev_sources: [{ source_file: `intalev-${period}.xlsx`, sheet: "TDSheet", source_cell: "E10", physical_row: 10, amount: 1000 + index, sha256: SHA.intalev, month: period, full_path: `Блок / UNPROVEN ${period}` }],
    erp_sources: [{ source_file: `erp-${period}.xlsx`, sheet: "Лист_1", source_cell: "M10", physical_row: 10, amount: 975 + index, sha256: SHA.erp, month: period, full_path: `Блок / UNPROVEN ${period}` }],
  }]);
  const payrollRows = [
    {
      organization: "9 Управляющая компания", period: payrollPeriod, code: "R036", intalev_label: "ФЗП",
      intalev_amount: 904912, erp_amount: 1000000, delta: -95088, normalized_delta: -95088,
      is_discrepancy: true, default_decision: "STORNO_REPOST", hierarchy_has_children: false,
      opiu_block: "Расходы на персонал", intalev_paths: ["Расходы на персонал / ФЗП"],
      intalev_sources: [{ source_file: "intalev-payroll.xlsx", sheet: "TDSheet", source_cell: "E113", physical_row: 113, amount: 904912, sha256: SHA.intalev, month: payrollPeriod, full_path: "Расходы на персонал / ФЗП" }],
      erp_sources: [{ source_file: "erp-payroll.xlsx", sheet: "Лист_1", source_cell: "M137", physical_row: 137, amount: 1000000, sha256: SHA.erp, month: payrollPeriod, full_path: "Расходы на персонал / ФЗП" }],
    },
    {
      organization: "9 Управляющая компания", period: payrollPeriod, code: "R035", intalev_label: "НДФЛ",
      intalev_amount: 93588, erp_amount: 0, delta: 93588, normalized_delta: 93588,
      is_discrepancy: true, default_decision: "ONE_SIDE", hierarchy_has_children: false,
      opiu_block: "Налоги", intalev_paths: ["Налоги / НДФЛ"],
      intalev_sources: [{ source_file: "intalev-payroll.xlsx", sheet: "TDSheet", source_cell: "E118", physical_row: 118, amount: 93588, sha256: SHA.intalev, month: payrollPeriod, full_path: "Налоги / НДФЛ" }],
      erp_sources: [{ source_file: "erp-payroll.xlsx", sheet: "Лист_1", source_cell: "M139", physical_row: 139, amount: 0, sha256: SHA.erp, month: payrollPeriod, full_path: "Налоги / НДФЛ" }],
    },
    {
      organization: "9 Управляющая компания", period: payrollPeriod, code: "R034", intalev_label: "Компенсации",
      intalev_amount: 1500, erp_amount: 0, delta: 1500, normalized_delta: 1500,
      is_discrepancy: true, default_decision: "ONE_SIDE", hierarchy_has_children: false,
      opiu_block: "Компенсации", intalev_paths: ["Компенсации / Выплаты"],
      intalev_sources: [{ source_file: "intalev-payroll.xlsx", sheet: "TDSheet", source_cell: "E117", physical_row: 117, amount: 1500, sha256: SHA.intalev, month: payrollPeriod, full_path: "Компенсации / Выплаты" }],
      erp_sources: [{ source_file: "erp-payroll.xlsx", sheet: "Лист_1", source_cell: "M138", physical_row: 138, amount: 0, sha256: SHA.erp, month: payrollPeriod, full_path: "Компенсации / Выплаты" }],
    },
    {
      organization: "9 Управляющая компания", period: payrollPeriod, code: "R001", intalev_label: "Административные расходы",
      intalev_amount: 2000000, erp_amount: 1900000, delta: 100000, normalized_delta: 0,
      is_discrepancy: true, default_decision: "PROCESS", hierarchy_has_children: true,
      opiu_block: "Административные расходы", intalev_paths: ["Административные расходы"],
    },
  ];
  const pair = {
    case_id: "CASE-PAYROLL-2025",
    pair_id: "PAIR-PAYROLL-2025",
    reclass_id: "RECLASS-PAYROLL-2025",
    period: payrollPeriod,
    scope: "CROSS_BLOCK",
    cardinality: "ONE_TO_MANY",
    decision_class: "STORNO_REPOST",
    proof_status: "PROVEN_SOURCE_SET",
    source_codes: ["R036"],
    target_codes: ["R035", "R034"],
    member_deltas: [
      { code: "R036", delta: -95088, period: payrollPeriod },
      { code: "R035", delta: 93588, period: targetPeriod },
      { code: "R034", delta: 1500, period: payrollPeriod },
    ],
    reason: "Payroll golden reclassification projection",
    proposed_solution: "STORNO_REPOST",
    r001_route: "STORNO_REPOST",
  };
  const contexts = selectedPeriods.map((period, index) => ({
    organization: "9 Управляющая компания",
    period,
    scenario: {
      ERP_CURRENT: 975 + index,
      INTALEV_TARGET: 1000 + index,
      ANALYTICAL_DRAFT_CORRECTIONS: 25,
      ERP_AFTER_CORRECTIONS: 1000 + index,
      RESIDUAL_DELTA: 0,
    },
    analytical_draft_corrections: [],
    review_required: [],
    blockers: [],
    proof_status_counts: { PROVEN: 0, INFERRED: 0, UNPROVEN: 1, USER_ACCEPTED: 0 },
  }));
  return {
    metadata: {
      runId: "RUN-AUDIT-REGISTRY-GOLDEN",
      sourceRunId: "RUN-R005-RULES-R001-GOLDEN",
      organization: "9 Управляющая компания",
      reconciliationPath: "reconciliation.xlsx",
      reconciliationSha: SHA.reconciliation,
      sourceSheet: "01_Сверка_дерево",
    },
    analyticalPolicy: { contexts, blockers: [], counts: { analytical_draft_corrections: 0, review_required: 0, analytical_blockers: 0 } },
    actions: { deletionOperations: [], deletionPostings: [] },
    sidecarPayload: {
      schema: "synthetic-golden-r005-results-v1",
      organization: "9 Управляющая компания",
      period: payrollPeriod,
      periods: selectedPeriods,
      report_sha256: SHA.reconciliation,
      report_only: true,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      rows: [...baseRows, ...payrollRows],
      zero_sum_storno_repost_candidates: [pair],
      erp_input_authority: { actual_sha256: SHA.erp },
      source_provenance: { status: "PASS_ALL_REGISTERED_SOURCES_REHASHED" },
      operation_evidence: {
        status: "PASS_EXACT_BOUND_SOURCE_SET",
        journal_verified: true,
        journal_sha256: SHA.journal,
        journal_sheet: "Лист_1",
        rows: [
          { pair_id: pair.pair_id, period: payrollPeriod, organization: "ГК", exact_bound_r_code: "R036", source_range: "B100:AG100", physical_row: 100, document: "Трансляция 1", posting_no: 7, debit: "26", credit: "70", amount: 95088, article: "ФЗП", debit_department: "Администрация", debit_analytics: ["ФЗП"], journal_sha256: SHA.journal, pair_role: "SOURCE_OPERATION", exact_article_bound: true, proof_status: "PROVEN" },
          { pair_id: pair.pair_id, period: payrollPeriod, source_range: "B101:AG101", physical_row: 101, document: "Закрытие месяца", posting_no: 8, debit: "99", credit: "26", amount: 95088, article: "ФЗП", journal_sha256: SHA.journal, pair_role: "SOURCE_OPERATION", exact_article_bound: true, proof_status: "PROVEN" },
          { period: payrollPeriod, source_range: "B102:AG102", physical_row: 102, document: "Кандидат", posting_no: 9, debit: "26", credit: "76", amount: 777, article: "Неопределённый кандидат", journal_sha256: SHA.journal, row_class: "CANDIDATE_EXCLUDED", exact_article_bound: false, proof_status: "CANDIDATE_NOT_PROVEN" },
        ],
        source_trace: {
          journals: [{ data_bounds: "B5:AG102" }],
          source_bindings: [{ period: payrollPeriod, journal_path: "journal.xlsx", journal_sha256: SHA.journal }],
        },
      },
    },
  };
}

test("payroll golden projects one cross-block case and suppresses standalone R035 one-side", () => {
  const input = fixture(12);
  const projection = buildAuditRegistryProjection({ ...input, sidecarPath: "reconciliation.codex-input.json", sidecarSha: SHA.sidecar, generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.equal(projection.pairs.length, 1);
  assert.equal(projection.pairs[0].scope, "CROSS_BLOCK");
  assert.equal(projection.pairs[0].proof_status, "PROVEN_SOURCE_SET");
  assert.equal(projection.pair_rows.length, 2);
  assert.equal(projection.pair_rows[0].source_normalized_delta, -95088);
  assert.equal(projection.pair_rows.find((row) => row.target_r_code === "R035").target_amount, 93588);
  assert.equal(projection.pair_rows.find((row) => row.target_r_code === "R034").target_amount, 1500);
  assert.equal(projection.pair_rows[0].net_effect, 0);
  assert.equal(projection.pair_rows[0].source_operation_count, 1, "closing row must not count as a source operation");
  const r035 = projection.discrepancies.find((row) => row.r_code === "R035");
  assert.equal(r035.class, "RECLASS");
  assert.equal(projection.discrepancies.some((row) => row.r_code === "R035" && row.class === "ONE_SIDE"), false);
  assert.equal(projection.discrepancies.some((row) => row.class === "UNPROVEN"), true);
  assert.equal(projection.discrepancies.find((row) => row.r_code === "R001").control_only, true);
  assert.equal(projection.evidence.some((row) => row.evidence_role === "CLOSING_ROW" && row.proof_status === "EXCLUDED_CLOSING_ROW"), true);
  assert.equal(projection.evidence.some((row) => row.evidence_role === "GENERIC_CANDIDATE" && row.proof_status === "EXCLUDED"), true);
  const intalev = projection.evidence.find((row) => row.evidence_system === "INTALEV" && row.case_id === r035.case_id);
  assert.equal(intalev.document, "НЕ ВЫГРУЖЕНО");
  assert.equal(intalev.posting_no, "НЕ ВЫГРУЖЕНО");
  assert.equal(intalev.dt, "НЕ ВЫГРУЖЕНО");
  assert.equal(intalev.kt, "НЕ ВЫГРУЖЕНО");
  assert.deepEqual(projection.safety, { report_only: true, posting_rows: 0, execution_allowed: false, ready_to_upload: false, release_allowed: false, live_1c_allowed: false });
});

test("period projection supports 1, 3, and 12 months without synthetic reclass TOTAL", () => {
  for (const count of [1, 3, 12]) {
    const input = fixture(count);
    const projection = buildAuditRegistryProjection(input);
    assert.equal(projection.periods.length, count);
    assert.equal(projection.months.length, count);
    assert.equal(projection.months.some((row) => row.period === "TOTAL"), false);
  }
});

test("cross-month reclassification is blocked and never projected as a financial case", () => {
  const input = fixture(12, { crossMonth: true });
  const projection = buildAuditRegistryProjection(input);
  assert.equal(projection.pairs.length, 0);
  assert.equal(projection.blockers.some((row) => row.blocker_code === "BLOCKED_CROSS_MONTH_RECLASS"), true);
});

test("R045/R055 are absent from discrepancy and pair registries while R046 remains analyzed", () => {
  const input = fixture(1);
  const period = input.sidecarPayload.period;
  input.sidecarPayload.structural_group_control_sets = [{
    id: "fixture_presentation_exception",
    enabled: true,
    organization: input.sidecarPayload.organization,
    members: ["R045", "R055"],
    mode: "SUM_DELTA_ONLY",
    tolerance: 0.01,
  }];
  input.sidecarPayload.rows.push(
    { organization: input.sidecarPayload.organization, period, code: "R045", intalev_amount: 0, erp_amount: 3964465.87, delta: -3964465.87, normalized_delta: -3964465.87, is_discrepancy: true },
    { organization: input.sidecarPayload.organization, period, code: "R055", intalev_amount: 3964465.87, erp_amount: 0, delta: 3964465.87, normalized_delta: 3964465.87, is_discrepancy: true },
    { organization: input.sidecarPayload.organization, period, code: "R046", hierarchy_parent_code: "R045", delta: -120, normalized_delta: -120, is_discrepancy: true },
  );
  input.sidecarPayload.zero_sum_storno_repost_candidates.push({
    case_id: "CASE-R045-R055-FORBIDDEN",
    pair_id: "PAIR-R045-R055-FORBIDDEN",
    period,
    source_codes: ["R045"],
    target_codes: ["R055"],
    member_deltas: [
      { code: "R045", delta: -3964465.87, period },
      { code: "R055", delta: 3964465.87, period },
    ],
  });

  const projection = buildAuditRegistryProjection(input);
  assert.equal(projection.pairs.some((pair) => pair.case_id === "CASE-R045-R055-FORBIDDEN"), false);
  assert.equal(projection.pair_rows.some((row) => /R045|R055/.test(`${row.source_r_code}|${row.target_r_code}`)), false);
  assert.equal(projection.discrepancies.some((row) => ["R045", "R055"].includes(row.r_code)), false);
  assert.equal(projection.discrepancies.some((row) => row.r_code === "R046"), true);
  assert.deepEqual(
    projection.presentation_block_exemptions.map((item) => [item.code, item.financial_rows]),
    [["R045", 0], ["R055", 0]],
  );
});

test("stale structural metadata cannot suppress an R001 discrepancy with empty config", () => {
  const input = fixture(1);
  const period = input.sidecarPayload.period;
  input.sidecarPayload.structural_group_control_sets = [];
  input.sidecarPayload.rows.push({
    organization: input.sidecarPayload.organization,
    period,
    code: "STALE",
    delta: -100,
    normalized_delta: -100,
    is_discrepancy: true,
    structural_group_control_enabled: true,
    structural_group_control_set_id: "old_set",
    structural_group_sum_status: "STRUCTURAL_GROUP_SUM_OK",
    structural_control_effective_delta: 0,
  });
  const projection = buildAuditRegistryProjection(input);
  assert.equal(projection.discrepancies.some((row) => row.r_code === "STALE"), true);
  assert.equal(projection.presentation_block_exemptions.some((row) => row?.code === "STALE"), false);
});

test("configured structural mismatch stays REVIEW_ONLY with complete R001 audit diagnostics", () => {
  const input = fixture(1);
  const period = input.sidecarPayload.period;
  input.sidecarPayload.structural_group_control_sets = [{
    id: "mismatch_set",
    enabled: true,
    organization: input.sidecarPayload.organization,
    members: ["P1", "P2"],
    mode: "SUM_DELTA_ONLY",
    tolerance: 0.01,
  }];
  input.sidecarPayload.rows.push(
    { organization: input.sidecarPayload.organization, period, code: "P1", intalev_amount: 0, erp_amount: 100, delta: -100, normalized_delta: -100, is_discrepancy: true },
    { organization: input.sidecarPayload.organization, period, code: "P2", intalev_amount: 90, erp_amount: 0, delta: 90, normalized_delta: 90, is_discrepancy: true },
  );
  const projection = buildAuditRegistryProjection(input);
  const mismatchRows = projection.discrepancies.filter((row) => ["P1", "P2"].includes(row.r_code));
  assert.equal(mismatchRows.length, 2);
  assert.equal(mismatchRows.every((row) => row.class === "STRUCTURAL_GROUP_SUM_MISMATCH"), true);
  assert.equal(mismatchRows.every((row) => row.proposed_solution === "REVIEW_ONLY"), true);
  assert.equal(mismatchRows.every((row) => row.structural_group_control_set_id === "mismatch_set"), true);
  assert.equal(mismatchRows.every((row) => row.structural_group_control_sum_delta === -10), true);
  assert.equal(mismatchRows.every((row) => row.structural_group_control_tolerance === 0.01), true);
  assert.deepEqual(mismatchRows.map((row) => row.structural_root_effective_delta), [-100, 90]);
  assert.equal(mismatchRows.every((row) => row.structural_descendant_internal_checks_active === true), true);
  assert.equal(mismatchRows.every((row) => row.structural_financial_rows === 0), true);
  assert.equal(mismatchRows.every((row) => row.structural_posting_allowed === false), true);
  assert.equal(projection.presentation_block_exemptions.every((row) =>
    row.classification === "STRUCTURAL_GROUP_SUM_MISMATCH"
      && row.control_sum_delta === -10
      && row.financial_rows === 0), true);
  assert.equal(projection.safety.posting_rows, 0);
  assert.equal(projection.safety.execution_allowed, false);
  assert.equal(projection.safety.ready_to_upload, false);
});

test("structural mismatch diagnostics survive discrepancy workbook export and reopen", async (t) => {
  const input = fixture(1);
  const period = input.sidecarPayload.period;
  input.sidecarPayload.structural_group_control_sets = [{
    id: "mismatch_export",
    enabled: true,
    organization: input.sidecarPayload.organization,
    members: ["P1", "P2"],
    mode: "SUM_DELTA_ONLY",
    tolerance: 0.01,
  }];
  input.sidecarPayload.rows.push(
    { organization: input.sidecarPayload.organization, period, code: "P1", intalev_amount: 0, erp_amount: 100, delta: -100, normalized_delta: -100, is_discrepancy: true },
    { organization: input.sidecarPayload.organization, period, code: "P2", intalev_amount: 90, erp_amount: 0, delta: 90, normalized_delta: 90, is_discrepancy: true },
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-structural-mismatch-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const names = auditRegistryFilenames(period);
  const discrepancyRegistryPath = path.join(root, names.discrepancy_registry);
  await buildAuditRegistryWorkbooks({
    ...input,
    actions: {},
    correctionRegistryPath: path.join(root, names.correction_registry),
    discrepancyRegistryPath,
    sidecarPath: "",
    sidecarSha: SHA.sidecar,
    generatedAt: "2026-08-23T00:00:00.000Z",
  });
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(discrepancyRegistryPath));
  const values = workbook.worksheets.getItem("Реестр").getUsedRange().values;
  assert.equal(values.some((row) => row.includes("Structural control set") && row.includes("Structural aggregate")), true);
  assert.equal(values.some((row) => row.includes("P1") && row.includes("mismatch_export") && row.includes(-10) && row.includes("STRUCTURAL_GROUP_SUM_MISMATCH")), true);
  assert.equal(values.some((row) => row.includes("P2") && row.includes("mismatch_export") && row.includes(90) && row.includes(false)), true);
});

test("reclass lookup is isolated by organization, concrete month, and R-code", () => {
  const input = fixture(12);
  const organization = input.sidecarPayload.organization;
  input.sidecarPayload.rows.push(
    { organization, period: "2025-12", code: "R036", intalev_label: "DEC source", delta: -10, normalized_delta: -10, is_discrepancy: true, default_decision: "ONE_SIDE" },
    { organization, period: "2025-12", code: "R035", intalev_label: "DEC target", delta: 10, normalized_delta: 10, is_discrepancy: true, default_decision: "ONE_SIDE" },
    { organization: "Другая организация", period: "2025-11", code: "R036", intalev_label: "OTHER ORG source", delta: -30, normalized_delta: -30, is_discrepancy: true, default_decision: "ONE_SIDE" },
    { organization: "Другая организация", period: "2025-11", code: "R035", intalev_label: "OTHER ORG target", delta: 30, normalized_delta: 30, is_discrepancy: true, default_decision: "ONE_SIDE" },
  );
  input.sidecarPayload.operation_evidence.rows.push({
    organization,
    pair_id: "PAIR-PAYROLL-2025",
    period: "2025-12",
    source_range: "B200:AG200",
    physical_row: 200,
    document: "December operation",
    debit: "26",
    credit: "70",
    amount: 10,
    pair_role: "SOURCE_OPERATION",
    exact_article_bound: true,
    proof_status: "PROVEN",
  });
  input.sidecarPayload.operation_evidence.rows.push({
    organization: "Другая организация journal legal entity",
    context_organization: "Другая организация",
    pair_id: "PAIR-PAYROLL-2025",
    period: "2025-11",
    source_range: "B300:AG300",
    physical_row: 300,
    document: "Other organization operation",
    debit: "26",
    credit: "70",
    amount: 30,
    pair_role: "SOURCE_OPERATION",
    exact_article_bound: true,
    proof_status: "PROVEN",
  });

  const projection = buildAuditRegistryProjection(input);
  const novemberPair = projection.pair_rows.find((row) => row.period === "2025-11" && row.target_r_code === "R035");
  assert.equal(novemberPair.source_article, "ФЗП");
  assert.equal(novemberPair.target_article, "НДФЛ");
  assert.equal(novemberPair.source_operation_count, 1);
  assert.equal(novemberPair.erp_source_rows, "B100:AG100");
  assert.equal(projection.evidence.find((row) => row.physical_row === "B100:AG100").case_id, "CASE-PAYROLL-2025");
  assert.equal(projection.discrepancies.find((row) => row.period === "2025-12" && row.r_code === "R035").class, "ONE_SIDE");

  const mixedOrganizationInput = fixture(12);
  mixedOrganizationInput.sidecarPayload.zero_sum_storno_repost_candidates[0].member_deltas[1].organization = "Другая организация";
  const mixedOrganization = buildAuditRegistryProjection(mixedOrganizationInput);
  assert.equal(mixedOrganization.pairs.length, 0);
  assert.equal(mixedOrganization.blockers.some((row) => row.blocker_code === "BLOCKED_CROSS_ORGANIZATION_RECLASS"), true);
});

test("delete capability distinguishes missing integration from an inactive included capability", () => {
  const missingInput = fixture(1);
  missingInput.actions = {};
  const missing = buildAuditRegistryProjection(missingInput);
  assert.equal(missing.delete_capability_state, "NOT_INCLUDED_IN_THIS_BUILD");
  assert.equal(missing.deletions[0].status, "NOT_INCLUDED_IN_THIS_BUILD");
  assert.equal(missing.deletions[0].proof_status, "NOT_APPLICABLE");

  const included = buildAuditRegistryProjection(fixture(1));
  assert.equal(included.delete_capability_state, "INCLUDED");
  assert.equal(included.deletions[0].status, "NO_ACTION_INACTIVE");
});

test("registry filename contract keeps correction R001 and discrepancy R005 suffixes", () => {
  assert.deepEqual(AUDIT_REGISTRY_FILENAME_CONTRACT, {
    correction_registry: "Реестр_корректировок_ОПИУ_{period}_R001.xlsx",
    discrepancy_registry: "Реестр_проводок_расхождений_ОПИУ_{period}_R005.xlsx",
  });
  assert.deepEqual(auditRegistryFilenames("2025-03"), {
    correction_registry: "Реестр_корректировок_ОПИУ_2025-03_R001.xlsx",
    discrepancy_registry: "Реестр_проводок_расхождений_ОПИУ_2025-03_R005.xlsx",
  });
});

test("both workbooks reopen with exact sheet order, zero formula errors, and a display-only TOTAL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-audit-registry-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const registryNames = auditRegistryFilenames("2025-03");
  const correctionRegistryPath = path.join(root, registryNames.correction_registry);
  const discrepancyRegistryPath = path.join(root, registryNames.discrepancy_registry);
  const result = await buildAuditRegistryWorkbooks({
    ...fixture(12),
    actions: {},
    correctionRegistryPath,
    discrepancyRegistryPath,
    sidecarPath: "",
    sidecarSha: SHA.sidecar,
    generatedAt: "2026-08-17T00:00:00.000Z",
  });
  assert.equal(result.correction_registry.sheet_count, 6);
  assert.equal(result.discrepancy_registry.sheet_count, 3);
  assert.equal(result.correction_registry.formula_errors, 0);
  assert.equal(result.discrepancy_registry.formula_errors, 0);
  assert.equal(path.basename(result.correction_registry.path), "Реестр_корректировок_ОПИУ_2025-03_R001.xlsx");
  assert.equal(path.basename(result.discrepancy_registry.path), "Реестр_проводок_расхождений_ОПИУ_2025-03_R005.xlsx");
  const corrections = await SpreadsheetFile.importXlsx(await FileBlob.load(correctionRegistryPath));
  const discrepancies = await SpreadsheetFile.importXlsx(await FileBlob.load(discrepancyRegistryPath));
  assert.deepEqual(corrections.worksheets.items.map((sheet) => sheet.name), [...CORRECTION_REGISTRY_SHEETS]);
  assert.deepEqual(discrepancies.worksheets.items.map((sheet) => sheet.name), [...DISCREPANCY_REGISTRY_SHEETS]);
  const monthSheet = corrections.worksheets.getItem("01_Месяцы");
  const used = monthSheet.getUsedRange();
  assert.equal(used.values.at(-1)[0], "TOTAL");
  assert.match(used.formulas.at(-1)[1], /^=SUM\('01_Месяцы'!/);
  const pairValues = corrections.worksheets.getItem("02_Пары").getUsedRange().values;
  assert.equal(pairValues.some((row) => row.includes(-95088) && row.includes(93588) && row.includes(0)), true);
  const deletionValues = corrections.worksheets.getItem("03_Удаления").getUsedRange().values;
  assert.equal(deletionValues.some((row) => row.includes("NOT_INCLUDED_IN_THIS_BUILD")), true);
  const qaSourceValues = discrepancies.worksheets.getItem("Источники_QA").getUsedRange().values;
  assert.equal(qaSourceValues.some((row) => row.includes("Source file") && row.includes("SHA256")), true);
  assert.equal(qaSourceValues.some((row) => row.includes("intalev-payroll.xlsx") && row.includes(SHA.intalev)), true);
  const formulaErrors = await corrections.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 300 } });
  assert.match(formulaErrors.ndjson, /matched 0 entries/i);
});
