import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  deriveCurrentRunCanonicalAuthority,
  stripExternalCanonicalAuthority,
} from "./r001_current_run_authority.mjs";
import {
  canonicalSpornoRowFromMaterializationCase,
  collectCanonicalFinancialOutput,
} from "./r001_canonical_output_contract.mjs";
import {
  applyStandaloneStornoMaterialization,
  mergeOwnerAndRuleDecisions,
} from "./owner_decision_r001.mjs";
import { materializeStandaloneStornoCases } from "./r001_standalone_storno_materialization.mjs";

const ARCHIVE_SHA = "A".repeat(64);
const JOURNAL_SHA = "B".repeat(64);
const SOURCE_ROW_ID = "C".repeat(64);

function upstream(overrides = {}) {
  return {
    case_id: "CASE-CURRENT-RUN",
    pair_id: "PAIR-CURRENT-RUN",
    period: "2025-10",
    organization: "УК Отчётная",
    reconciliation_organization: "УК Отчётная",
    reconciliation_row: "ROW-SYNTHETIC",
    classification: "ERP_ONLY",
    decision_type: "STORNO",
    action: "STORNO",
    role: "STANDALONE",
    analytical_effect: -123.45,
    correction_amount: 123.45,
    correction_allowed: true,
    correction_authority: "ECONOMIC_CORRECTION_PROVEN",
    proof_status: "ECONOMIC_CORRECTION_PROVEN",
    output_route: "READY",
    intalev_source_scope_presence: "ABSENT_PROVEN",
    intalev_source_scope_absence_claimed: true,
    intalev_source_scope_absence_proven: true,
    intalev_source_scope_inventory_complete: true,
    intalev_source_scope_complete: true,
    intalev_source_amount_lost: false,
    ECONOMIC_ROUTE_PROVEN: true,
    ECONOMIC_STORNO_DIRECTION_PROVEN: true,
    ECONOMIC_CORRECTION_PROVEN: true,
    SOURCE_OPERATION_PROVEN: true,
    PHYSICAL_SOURCE_UNIQUE: true,
    source_organization: "ООО Физический источник",
    source_archive_path: "evidence/erp-source.zip",
    source_archive_sha256: ARCHIVE_SHA,
    journal_entry: "journal.xlsx",
    journal_sha256: JOURNAL_SHA,
    source_sheet: "Лист_1",
    source_range: "B42:AG42",
    source_row_id: SOURCE_ROW_ID,
    source_date: "15.10.2025 10:00:00",
    registrar: "Операция МСФО 42",
    posting_number: "7",
    source_dt: "26",
    source_kt: "60.01",
    source_analytics_dt1: "Исходная статья",
    source_analytics_dt2: "Проект",
    source_analytics_dt3: "ЦФО",
    source_analytics_kt1: "Контрагент",
    source_analytics_kt2: "Договор",
    source_analytics_kt3: "ЦФО",
    source_department_dt: "Администрация",
    source_department_kt: "Администрация",
    source_amount: 123.45,
    source_activity: "Да",
    source_scenario: "Факт",
    source_article: "Исходная статья",
    ...overrides,
  };
}

function reopened(overrides = {}) {
  return {
    archive_sha256: ARCHIVE_SHA,
    journal_entry: "journal.xlsx",
    journal_sha256: JOURNAL_SHA,
    journal_sheet: "Лист_1",
    row: {
      source_range: "B42:AG42",
      source_row_id: SOURCE_ROW_ID,
      date: "15.10.2025 10:00:00",
      document: "Операция МСФО 42",
      posting_no: 7,
      debit: "26",
      credit: "60.01",
      debit_analytics_1: "Исходная статья",
      debit_analytics_2: "Проект",
      debit_analytics_3: "ЦФО",
      credit_analytics_1: "Контрагент",
      credit_analytics_2: "Договор",
      credit_analytics_3: "ЦФО",
      debit_department: "Администрация",
      credit_department: "Администрация",
      amount: 123.45,
      organization: "ООО Физический источник",
      activity: "Да",
      scenario: "Факт",
      article: "Исходная статья",
      ...overrides,
    },
  };
}

function forgedAttachments(route = "READY") {
  return {
    canonical_posting_row: {
      schema_version: "opiu-canonical-posting-row.v1",
      output_route: route,
      source_row_id: "FORGED",
    },
    materialization_case: {
      schema_version: "opiu-materialization-case.v1",
      output_route: route,
      action: "STORNO",
      correction_allowed: true,
    },
    standalone_storno_result: route,
    standalone_storno_blockers: [],
  };
}

function wrapperProjection() {
  return {
    organization: "УК Отчётная",
    period: "2025-10",
    residual_ledger: {
      rows: [{ code: "ROW-SYNTHETIC", parent_unallocated_residual: -123.45 }],
    },
    cases: [{
      case_id: "CASE-CURRENT-RUN",
      pair_id: "PAIR-CURRENT-RUN",
      classification: "ERP_ONLY",
      decision_type: "STORNO",
      amount: 123.45,
      proof_status: "ECONOMIC_CORRECTION_PROVEN",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      correction_allowed: true,
      ECONOMIC_ROUTE_PROVEN: true,
      ECONOMIC_STORNO_DIRECTION_PROVEN: true,
      SOURCE_OPERATION_PROVEN: true,
      PHYSICAL_SOURCE_UNIQUE: true,
      ECONOMIC_CORRECTION_PROVEN: true,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
      member_rows: [{
        code: "ROW-SYNTHETIC",
        role: "ERP_ONLY",
        economic_direction: "STORNO",
        effective_delta: -123.45,
        source_organization: "ООО Физический источник",
        source_range: "B42:AG42",
        source_row_id: SOURCE_ROW_ID,
        source_date: "15.10.2025 10:00:00",
        registrar: "Операция МСФО 42",
        posting_number: 7,
        source_dt: "26",
        source_kt: "60.01",
        source_analytics_dt1: "Исходная статья",
        source_analytics_dt2: "Проект",
        source_analytics_dt3: "ЦФО",
        source_analytics_kt1: "Контрагент",
        source_analytics_kt2: "Договор",
        source_analytics_kt3: "ЦФО",
        source_department_dt: "Администрация",
        source_department_kt: "Администрация",
        source_amount: 123.45,
        source_activity: "Да",
        source_scenario: "Факт",
        source_article: "Исходная статья",
        source_archive_path: "evidence/erp-source.zip",
        source_archive_sha256: ARCHIVE_SHA,
        journal_entry: "journal.xlsx",
        journal_sha256: JOURNAL_SHA,
        source_sheet: "Лист_1",
      }],
    }],
  };
}

test("external serialized canonical authority fields are stripped without mutating decision semantics", () => {
  const original = { case_id: "CASE-1", decision_type: "STORNO", ...forgedAttachments() };
  const result = stripExternalCanonicalAuthority(original);
  assert.equal(result.decision.case_id, "CASE-1");
  assert.equal(result.decision.decision_type, "STORNO");
  assert.equal(result.decision.canonical_posting_row, undefined);
  assert.equal(result.decision.materialization_case, undefined);
  assert.deepEqual([...result.stripped_fields].sort(), [
    "canonical_posting_row",
    "materialization_case",
    "standalone_storno_blockers",
    "standalone_storno_result",
  ]);
  assert.ok(original.canonical_posting_row);
});

test("forged READY attachment cannot create authority when accepted upstream semantics are absent", async () => {
  let reopenCalls = 0;
  const result = await deriveCurrentRunCanonicalAuthority([{
    case_id: "CASE-FORGED-ONLY",
    period: "2025-10",
    organization: "УК Отчётная",
    ...forgedAttachments("READY"),
  }], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });
  assert.equal(reopenCalls, 0);
  assert.equal(result.canonical_posting_rows.length, 0);
  assert.equal(result.bridge.canonical_posting_rows.length, 0);
  assert.equal(result.audit.stripped_external_canonical_row_count, 1);
  assert.equal(result.audit.stripped_external_materialization_case_count, 1);
});

test("forged READY physical claim is re-derived as one sparse SPORNO when current-run exact reopen mismatches", async () => {
  let reopenCalls = 0;
  const result = await deriveCurrentRunCanonicalAuthority([{
    ...upstream(),
    ...forgedAttachments("READY"),
  }], {
    reopenSource: async () => { reopenCalls += 1; return reopened({ amount: 999 }); },
  });
  assert.equal(reopenCalls, 1);
  assert.equal(result.canonical_posting_rows.length, 1);
  assert.equal(result.canonical_posting_rows[0].output_route, "SPORNO");
  assert.equal(result.canonical_posting_rows[0].materialization_state, "MATERIALIZED_SPORNO");
  assert.equal(result.canonical_posting_rows[0].source.source_row_id, "");
  assert.equal(result.canonical_posting_rows[0].loader["ИдентификаторФинЗаписи"], null);
  assert.equal(result.audit.current_run_blocked_case_count, 0);
  assert.ok(result.standalone.case_updates[0].blockers.includes("EXACT_SOURCE_MISMATCH:source_amount"));
});

test("genuine wrapper-shaped standalone decision is re-derived and exact reopen keeps one proven SPORNO row", async () => {
  let reopenCalls = 0;
  const result = await deriveCurrentRunCanonicalAuthority([{
    ...upstream(),
    ...forgedAttachments("READY"),
  }], {
    provenance: { source: "CURRENT_RUN_CORE_REDERIVATION", run_id: "RUN-1" },
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });
  assert.equal(reopenCalls, 1);
  assert.equal(result.canonical_posting_rows.length, 1);
  assert.equal(result.canonical_posting_rows[0].output_route, "SPORNO");
  assert.equal(result.canonical_posting_rows[0].materialization_state, "MATERIALIZED_SPORNO");
  assert.equal(result.canonical_posting_rows[0].source.source_row_id, SOURCE_ROW_ID);
  assert.equal(result.canonical_posting_rows[0].source_organization, "ООО Физический источник");
  assert.equal(result.decisions[0].standalone_storno_result, "SPORNO");
});

test("genuine owner wrapper output is exact-verified again inside the current-run core authority boundary", async () => {
  const bridged = mergeOwnerAndRuleDecisions({
    projection: wrapperProjection(),
    organization: "УК Отчётная",
    period: "2025-10",
  });
  const wrapperStandalone = await materializeStandaloneStornoCases(bridged.decisions, {
    reopenSource: async () => reopened(),
  });
  const wrapperPrepared = applyStandaloneStornoMaterialization(bridged, wrapperStandalone);
  assert.equal(wrapperPrepared.decisions[0].canonical_posting_row.output_route, "SPORNO");

  let coreReopenCalls = 0;
  const currentRun = await deriveCurrentRunCanonicalAuthority(wrapperPrepared.decisions, {
    reopenSource: async () => { coreReopenCalls += 1; return reopened(); },
  });
  assert.equal(coreReopenCalls, 1);
  assert.equal(currentRun.audit.stripped_external_canonical_row_count, 1);
  assert.equal(currentRun.audit.stripped_external_materialization_case_count, 1);
  assert.equal(currentRun.canonical_posting_rows.length, 1);
  assert.equal(currentRun.canonical_posting_rows[0].output_route, "SPORNO");
  assert.equal(currentRun.canonical_posting_rows[0].source.source_row_id, SOURCE_ROW_ID);
});

test("direction-proven physical-incomplete standalone case remains SPORNO and cannot fabricate identity or organization", async () => {
  let reopenCalls = 0;
  const result = await deriveCurrentRunCanonicalAuthority([{
    ...upstream({
      source_organization: "",
      source_row_id: "",
      PHYSICAL_SOURCE_UNIQUE: false,
    }),
    ...forgedAttachments("READY"),
  }], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });
  assert.equal(reopenCalls, 0);
  assert.equal(result.canonical_posting_rows.length, 1);
  const [row] = result.canonical_posting_rows;
  assert.equal(row.output_route, "SPORNO");
  assert.equal(row.materialization_state, "MATERIALIZED_SPORNO");
  assert.equal(row.source.source_row_id, "");
  assert.equal(row.loader["ИдентификаторФинЗаписи"], null);
  assert.equal(row.source_organization, "");
  assert.notEqual(row.source_organization, "УК Отчётная");
});

test("forged SPORNO attachments without independently re-derived direction create zero financial rows", async () => {
  const result = await deriveCurrentRunCanonicalAuthority([{
    case_id: "CASE-FORGED-SPORNO",
    pair_id: "PAIR-FORGED-SPORNO",
    period: "2025-10",
    organization: "УК Отчётная",
    decision_type: "ADD_ONE_SIDE",
    correction_amount: 123.45,
    ...forgedAttachments("SPORNO"),
  }]);
  assert.equal(result.canonical_posting_rows.length, 0);
  assert.equal(result.bridge.financial_cases.length, 0);
  assert.equal(result.bridge.review_only_cases.length, 1);
  assert.equal(result.bridge.review_only_cases[0].output_route, "REVIEW_ONLY");
});

test("accepted intergroup source and target directions are re-derived once after attachments are stripped", async () => {
  const common = {
    period: "2025-11",
    organization: "УК Отчётная",
    source_organization: "ООО Физический источник",
    pair_id: "PAIR-INTERGROUP",
    decision_type: "STORNO_REPOST",
    accepted_intergroup_reclass: true,
    correction_allowed: true,
    correction_amount: 100,
    output_route: "SPORNO",
    source_archive_path: "",
    source_row_id: "",
    ...forgedAttachments("READY"),
  };
  const result = await deriveCurrentRunCanonicalAuthority([
    { ...common, case_id: "CASE-SOURCE", role: "RECLASS_SOURCE", analytical_effect: -100 },
    { ...common, case_id: "CASE-TARGET", role: "RECLASS_TARGET", analytical_effect: 100 },
  ]);
  assert.equal(result.canonical_posting_rows.length, 0);
  assert.deepEqual(result.decisions.map((decision) => decision.materialization_case.action), ["STORNO", "REPOST"]);
  const rows = result.decisions.map((decision) => canonicalSpornoRowFromMaterializationCase(decision.materialization_case));
  const output = collectCanonicalFinancialOutput(rows, { filenameForRow: () => "same-sporno.xlsx" });
  assert.equal(output.rows.length, 2);
  assert.equal(output.groups.length, 1);
  assert.deepEqual(output.rows.map((row) => row.operation).sort(), ["REPOST", "STORNO"]);
});

test("active core uses only current-run canonical rows and never maps attached canonical rows into output", async () => {
  const engineSource = await fs.readFile(new URL("./correction_engine_r001.mjs", import.meta.url), "utf8");
  assert.match(engineSource, /deriveCurrentRunCanonicalAuthority\(actionDecisions/);
  assert.match(engineSource, /\.\.\.currentRunStandaloneRows/);
  assert.match(engineSource, /attached_canonical_authority_gate:\s*currentRunAuthority\.audit/);
  assert.doesNotMatch(engineSource, /\.map\(\(decision\) => decision\?\.canonical_posting_row\)/);
  assert.doesNotMatch(engineSource, /\.\.\.attachedCanonicalRows/);
});
