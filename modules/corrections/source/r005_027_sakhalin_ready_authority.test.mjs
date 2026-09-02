import assert from "node:assert/strict";
import test from "node:test";

import { collectCanonicalFinancialOutput } from "./r001_canonical_output_contract.mjs";
import { evaluateGroupScopedDecision } from "./r001_group_scoped_materialization.mjs";
import { enforceServiceHandoffReadyAuthority } from "./service_r001_ready_authority.mjs";

const ERP_SOURCE_ROW_ID = "2748C4E6F44E8C9273AFE32A3D5B36DE99C1D6FD39FA972B3976D7550059C825";
const ERP_SOURCE_SHA256 = "B2F97D3A7F320EE3BE3A62D0423D4BFB7A215ED92D7ED6A1A771FC04EBCF89D1";
const JOURNAL_SHA256 = "776D566495175191D1B394C2545FE10B11173C755A51879FD18726A91A40A504";

function sakhalinDecision(overrides = {}) {
  return {
    case_id: "XJ-2748C4E6F44E8C9273AFE32A",
    pair_id: "PAIR-2748C4E6F44E8C9273AFE32A",
    decision_type: "STORNO_REPOST",
    period: "2025-01",
    organization: "3 Сахалин",
    reconciliation_organization: "3 Сахалин",
    reconciliation_row: "XJS-2748C4E6F44E8C9273AFE32A",
    group: "Проезд/доставка сотрудников",
    source_article: "Проезд/доставка сотрудников",
    target_article: "Проезд/доставка сотрудников",
    target_code: "00-000067",
    target_operating_account: "Счет затрат 26",
    target_catalog_path: "Административные расходы / Проезд/доставка сотрудников",
    correction_amount: 1854,
    source_amount: 1854,
    settlement_account: "76.5",
    source_operating_account: "44.3",
    target_subkonto_slot: 1,
    ECONOMIC_ROUTE_PROVEN: true,
    SOURCE_OPERATION_PROVEN: true,
    PHYSICAL_SOURCE_UNIQUE: true,
    ECONOMIC_CORRECTION_PROVEN: true,
    source_organization: "ПВ",
    source_archive_path: "evidence/erp-source.zip",
    source_archive_sha256: ERP_SOURCE_SHA256,
    journal_entry: "1С_ERP_Управление_холдингом_3 Сахалин_2025-01_01_Журнал_проводок_МСФО.xlsx",
    journal_sha256: JOURNAL_SHA256,
    source_sheet: "Лист_1",
    source_range: "B1617:AG1617",
    source_row_id: ERP_SOURCE_ROW_ID,
    source_date: "2025-01-31T00:00:00",
    registrar: "Трансляция 0000001782 от 19.03.2026 9:03:39",
    posting_number: "8",
    source_dt: "26",
    source_kt: "76.5",
    source_analytics_dt1: "Проезд/доставка сотрудников",
    source_analytics_dt2: "",
    source_analytics_dt3: "",
    source_analytics_kt1: "Служебный",
    source_analytics_kt2: "",
    source_analytics_kt3: "",
    source_department_dt: "Б_ПВ Отдел по управлению персоналом",
    source_department_kt: "Б_ПВ Отдел по управлению персоналом",
    ...overrides,
  };
}

test("R005-027 valid Sakhalin handoff preserves proven financial authority under no structural settings", () => {
  const structuralSelection = Object.freeze({
    authority: "service-none",
    status: "SERVICE_NO_SETTINGS",
    materialization_status: "PACKAGED_USER_CSV_NO_EXACT_SCOPE",
    correction_authority: false,
    financial_rows: 0,
    posting_rows: 0,
  });
  assert.equal(structuralSelection.correction_authority, false);
  assert.equal(structuralSelection.financial_rows, 0);

  const result = evaluateGroupScopedDecision({
    decision: sakhalinDecision(),
    catalogNodes: [],
    intalevBlock: "Административные расходы",
    intalevPath: "Расходы по основной деятельности / Административные расходы / Проезд/доставка сотрудников",
    verifiedHandoffSourceRowIDs: [ERP_SOURCE_ROW_ID],
  });

  assert.equal(result.status, "MATERIALIZED_GROUP_SCOPED_STORNO_REPOST", result.blockers.join("; "));
  assert.equal(result.canonical_posting_rows.length, 2);
  // First exact regression assertion: this is the first authority field lost
  // by caseFor() on the issue base, before final READY/SPORNO counts diverge.
  assert.equal(result.canonical_posting_rows[0].materialization_case.correction_allowed, true);
  assert.equal(result.canonical_posting_rows[0].materialization_case.proof_status, "PROVEN");
  assert.ok(result.canonical_posting_rows.every((row) => row.output_route === "READY"));
  assert.deepEqual(result.canonical_posting_rows.map((row) => row.operation), ["STORNO", "REPOST"]);
  assert.deepEqual(result.canonical_posting_rows.map((row) => row.loader["СуммаВВалютеОтчетности"]), [-1854, 1854]);
  assert.ok(result.canonical_posting_rows.every((row) => row.source.source_row_id === ERP_SOURCE_ROW_ID));
  assert.equal(result.target_article.article_code, "00-000067");
  assert.equal(result.target_article.operating_account, "Счет затрат 26");
});

test("R005-027 incomplete or handoff-unbound proof remains fail-closed", () => {
  const incomplete = evaluateGroupScopedDecision({
    decision: sakhalinDecision({ ECONOMIC_CORRECTION_PROVEN: false }),
    catalogNodes: [],
    intalevBlock: "Административные расходы",
    verifiedHandoffSourceRowIDs: [ERP_SOURCE_ROW_ID],
  });
  assert.equal(incomplete.status, "BLOCKED_TARGET_SELECTION");
  assert.equal(incomplete.canonical_posting_rows.length, 0);

  const outsideHandoff = evaluateGroupScopedDecision({
    decision: sakhalinDecision(),
    catalogNodes: [],
    intalevBlock: "Административные расходы",
    verifiedHandoffSourceRowIDs: [],
  });
  assert.ok(outsideHandoff.canonical_posting_rows.every((row) => row.output_route === "SPORNO"));
  assert.ok(outsideHandoff.canonical_posting_rows.every((row) => row.correction_allowed === false));
  assert.ok(outsideHandoff.canonical_posting_rows.every((row) => row.materialization_case.proof_status === "GROUP_SCOPED_ARTICLE_REPLACEMENT_PROVEN"));

  const missingIdentity = evaluateGroupScopedDecision({
    decision: sakhalinDecision({ source_sheet: "" }),
    catalogNodes: [],
    intalevBlock: "Административные расходы",
    verifiedHandoffSourceRowIDs: [ERP_SOURCE_ROW_ID],
  });
  assert.equal(missingIdentity.status, "BLOCKED_PHYSICAL_MATERIALIZATION");
  assert.deepEqual(missingIdentity.blockers, ["GROUP_SCOPED_PHYSICAL_SOURCE_INCOMPLETE"]);
});

test("R005-027 duplicate SourceRowID and unbalanced pairs remain blocked after READY promotion", () => {
  const evaluate = (overrides = {}) => evaluateGroupScopedDecision({
    decision: sakhalinDecision(overrides),
    catalogNodes: [],
    intalevBlock: "Административные расходы",
    verifiedHandoffSourceRowIDs: [ERP_SOURCE_ROW_ID],
  });
  const first = evaluate().canonical_posting_rows;
  const reused = evaluate({ case_id: "XJ-REUSED", pair_id: "PAIR-REUSED" }).canonical_posting_rows;
  const duplicateGate = enforceServiceHandoffReadyAuthority([...first, ...reused], [ERP_SOURCE_ROW_ID]);
  const duplicateOutput = collectCanonicalFinancialOutput(duplicateGate.rows);
  assert.equal(duplicateOutput.counters.ready_financial_rows, 0);
  assert.equal(duplicateOutput.counters.sporno_financial_rows, 4);
  assert.ok(duplicateGate.audit.blocker_codes.includes("SERVICE_HANDOFF_SOURCE_ROW_ID_REUSED"));

  const unbalanced = first.map((row) => row.operation === "REPOST" ? { ...row, amount: 1800 } : row);
  const unbalancedGate = enforceServiceHandoffReadyAuthority(unbalanced, [ERP_SOURCE_ROW_ID]);
  assert.equal(unbalancedGate.rows.length, 0);
  assert.equal(unbalancedGate.audit.non_financial_pair_count, 1);
  assert.ok(unbalancedGate.audit.blocker_codes.includes("SERVICE_HANDOFF_PAIR_UNBALANCED_NON_FINANCIAL"));
});
