import assert from "node:assert/strict";
import test from "node:test";
import {
  LOADER_A_AA_FIELDS,
  MaterializationContractError,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";

const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);

function physical(overrides = {}) {
  return {
    source_organization: "3 Физическая ERP организация",
    source_archive_path: "evidence/erp.zip",
    source_archive_sha256: HASH_A,
    journal_entry: "journal.xlsx",
    journal_sha256: HASH_B,
    source_sheet: "Лист_1",
    source_range: "Лист_1!A42:AA42",
    source_row_id: "ERP-ROW-42",
    date: "15.10.2025",
    document: "Операция 000042",
    posting_number: "7",
    debit: "26",
    credit: "60",
    debit_analytics: ["Дт-А1", "Дт-А2", "Дт-А3"],
    credit_analytics: ["Кт-А1", "Кт-А2", "Кт-А3"],
    debit_department: "Дт подразделение",
    credit_department: "Кт подразделение",
    amount: 1250.5,
    activity: "Да",
    scenario: "Факт",
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    debit: "26",
    credit: "60",
    debit_analytics: ["Новый Дт-А1", "Новый Дт-А2", "Новый Дт-А3"],
    credit_analytics: ["Новый Кт-А1", "Новый Кт-А2", "Новый Кт-А3"],
    debit_department: "Новое Дт подразделение",
    credit_department: "Новое Кт подразделение",
    article: "Целевая статья",
    ...overrides,
  };
}

function stornoAccounting(source = physical(), overrides = {}) {
  return {
    debit: source.debit,
    credit: source.credit,
    debit_analytics: [...source.debit_analytics],
    credit_analytics: [...source.credit_analytics],
    debit_department: source.debit_department,
    credit_department: source.credit_department,
    article: "",
    ...overrides,
  };
}

function materializationCase(overrides = {}) {
  return createMaterializationCase({
    case_id: "CASE-1",
    pair_id: "PAIR-1",
    period: "2025-10",
    reconciliation_organization: "9 Управляющая компания",
    action: "STORNO_REPOST",
    role: "RECLASS_SOURCE",
    signed_economic_effect: -1250.5,
    correction_amount: 1250.5,
    economic: {
      source_code: "SOURCE",
      target_code: "TARGET",
      source_article: "Исходная статья",
      target_article: "Целевая статья",
    },
    proof_status: "PROVEN",
    correction_allowed: true,
    correction_authority: "ECONOMIC_CORRECTION_PROVEN",
    output_route: "READY",
    physical_source: physical(),
    target_accounting: target(),
    ...overrides,
  });
}

function loader(source = physical(), result = target(), operation = "STORNO") {
  return {
    СчетДт: result.debit,
    СчетКт: result.credit,
    ВалютаДт: null,
    ВалютаКт: null,
    ВидОперации: operation,
    ПодразделениеДт: result.debit_department,
    ПодразделениеКт: result.credit_department,
    НаправлениеДеятельностиДт: null,
    НаправлениеДеятельностиКт: null,
    СуммаВВалютеУчета: 1250.5,
    СуммаВВалютеОтчетности: 1250.5,
    СуммаВВалютеДт: null,
    СуммаВВалютеКт: null,
    КоличествоДт: null,
    КоличествоКт: null,
    Содержание: "REPORT_ONLY draft",
    СчетДтИсточник: source.debit,
    СчетКтИсточник: source.credit,
    ИдентификаторФинЗаписи: source.source_row_id,
    ПравилоДт: null,
    ПравилоКт: null,
    СубконтоДт1: result.debit_analytics[0],
    СубконтоДт2: result.debit_analytics[1],
    СубконтоДт3: result.debit_analytics[2],
    СубконтоКт1: result.credit_analytics[0],
    СубконтоКт2: result.credit_analytics[1],
    СубконтоКт3: result.credit_analytics[2],
  };
}

function postingRow(caseValue, overrides = {}) {
  const operation = overrides.operation ?? "STORNO";
  const result = overrides.result_accounting ?? (
    operation === "STORNO" ? stornoAccounting(caseValue.physical_source) : target()
  );
  return createCanonicalPostingRow({
    materialization_case: caseValue,
    operation,
    amount: 1250.5,
    materialization_state: caseValue.output_route === "READY"
      ? "MATERIALIZED_READY"
      : caseValue.output_route === "SPORNO" ? "MATERIALIZED_SPORNO" : "REVIEW_ONLY",
    audit_identity: `AUDIT-${operation}`,
    result_accounting: result,
    loader: loader(caseValue.physical_source, result, operation),
    ...overrides,
  });
}

function throwsCode(callback, code) {
  assert.throws(callback, (error) => error instanceof MaterializationContractError && error.code === code);
}

test("standalone STORNO survives canonicalization without ADD_ONE_SIDE collapse", () => {
  const value = materializationCase({ action: "STORNO", role: "STANDALONE" });
  assert.equal(value.action, "STORNO");
  const row = postingRow(value);
  assert.equal(row.operation, "STORNO");
  assert.deepEqual(row.result_accounting, stornoAccounting(value.physical_source));
  assert.equal(row.loader.СчетДт, value.physical_source.debit);
  assert.equal(row.loader.СчетКт, value.physical_source.credit);
  assert.equal(row.loader.ПодразделениеДт, value.physical_source.debit_department);
  assert.equal(row.loader.ПодразделениеКт, value.physical_source.credit_department);
  assert.deepEqual(
    [row.loader.СубконтоДт1, row.loader.СубконтоДт2, row.loader.СубконтоДт3],
    value.physical_source.debit_analytics,
  );
  assert.deepEqual(
    [row.loader.СубконтоКт1, row.loader.СубконтоКт2, row.loader.СубконтоКт3],
    value.physical_source.credit_analytics,
  );
  throwsCode(() => postingRow(value, { operation: "REPOST" }), "ACTION_OPERATION_MISMATCH");
});

test("standalone REPOST survives canonicalization without ADD_ONE_SIDE collapse", () => {
  const value = materializationCase({ action: "REPOST", role: "STANDALONE" });
  assert.equal(value.action, "REPOST");
  assert.equal(postingRow(value, { operation: "REPOST" }).operation, "REPOST");
  throwsCode(() => postingRow(value, { operation: "STORNO" }), "ACTION_OPERATION_MISMATCH");
});

test("reconciliation and physical source organizations remain separate", () => {
  const value = materializationCase();
  const row = postingRow(value);
  assert.equal(value.reconciliation_organization, "9 Управляющая компания");
  assert.equal(value.physical_source.source_organization, "3 Физическая ERP организация");
  assert.equal(row.reconciliation_organization, "9 Управляющая компания");
  assert.equal(row.source_organization, "3 Физическая ERP организация");
});

test("SourceRowID cannot be replaced by generated loader identity", () => {
  const value = materializationCase();
  const result = stornoAccounting(value.physical_source);
  const badLoader = loader(value.physical_source, result, "STORNO");
  badLoader.ИдентификаторФинЗаписи = "GENERATED-UPLOAD-ID";
  throwsCode(() => postingRow(value, { loader: badLoader }), "SOURCE_IDENTITY_MISMATCH");
});

test("source and target analytics slots one through three survive unchanged", () => {
  const value = materializationCase();
  const row = postingRow(value, { operation: "REPOST" });
  assert.deepEqual(value.physical_source.debit_analytics, ["Дт-А1", "Дт-А2", "Дт-А3"]);
  assert.deepEqual(value.physical_source.credit_analytics, ["Кт-А1", "Кт-А2", "Кт-А3"]);
  assert.deepEqual(value.target_accounting.debit_analytics, ["Новый Дт-А1", "Новый Дт-А2", "Новый Дт-А3"]);
  assert.deepEqual(row.result_accounting.credit_analytics, ["Новый Кт-А1", "Новый Кт-А2", "Новый Кт-А3"]);
});

test("RECLASS_SOURCE and RECLASS_TARGET roles remain explicit contract data", () => {
  assert.equal(materializationCase({ role: "RECLASS_SOURCE" }).role, "RECLASS_SOURCE");
  assert.equal(materializationCase({ role: "RECLASS_TARGET" }).role, "RECLASS_TARGET");
});

test("READY posting row with incomplete physical identity fails closed", () => {
  throwsCode(() => materializationCase({ physical_source: physical({ source_row_id: "" }) }), "READY_PHYSICAL_IDENTITY_INCOMPLETE");
  throwsCode(() => materializationCase({ physical_source: physical({ journal_sha256: "" }) }), "READY_PHYSICAL_IDENTITY_INCOMPLETE");
  throwsCode(() => materializationCase({ correction_allowed: false }), "READY_AUTHORITY_MISSING");
});

test("READY ADD_ONE_SIDE cannot choose either STORNO or REPOST without explicit direction", () => {
  throwsCode(
    () => materializationCase({ action: "ADD_ONE_SIDE", role: "STANDALONE" }),
    "READY_ACTION_DIRECTION_MISSING",
  );
  const forgedDirectionless = { ...materializationCase(), action: "ADD_ONE_SIDE", role: "STANDALONE" };
  for (const operation of ["STORNO", "REPOST"]) {
    throwsCode(
      () => postingRow(forgedDirectionless, { operation }),
      "READY_ACTION_DIRECTION_MISSING",
    );
  }
});

test("ADD_ONE_SIDE cannot use the financial SPORNO route", () => {
  throwsCode(
    () => materializationCase({
      action: "ADD_ONE_SIDE",
      role: "STANDALONE",
      output_route: "SPORNO",
      correction_allowed: false,
      proof_status: "INCOMPLETE",
    }),
    "FINANCIAL_ACTION_DIRECTION_MISSING",
  );
});

test("ADD_ONE_SIDE remains REVIEW_ONLY metadata and cannot create a posting row", () => {
  const value = materializationCase({
    action: "ADD_ONE_SIDE",
    role: "STANDALONE",
    output_route: "REVIEW_ONLY",
    correction_allowed: false,
    proof_status: "INCOMPLETE",
  });
  assert.equal(value.action, "ADD_ONE_SIDE");
  assert.equal(value.output_route, "REVIEW_ONLY");
  for (const operation of ["STORNO", "REPOST"]) {
    throwsCode(
      () => postingRow(value, { operation }),
      "DIRECTIONLESS_CASE",
    );
  }
});

test("posting-row boundary rejects ADD_ONE_SIDE for every operation and route", () => {
  for (const outputRoute of ["READY", "SPORNO", "REVIEW_ONLY"]) {
    const valid = materializationCase({
      output_route: outputRoute,
      correction_allowed: outputRoute === "READY",
      proof_status: outputRoute === "READY" ? "PROVEN" : "INCOMPLETE",
    });
    const forgedDirectionless = { ...valid, action: "ADD_ONE_SIDE", role: "STANDALONE" };
    for (const operation of ["STORNO", "REPOST"]) {
      throwsCode(
        () => postingRow(forgedDirectionless, { operation }),
        outputRoute === "READY" ? "READY_ACTION_DIRECTION_MISSING" : "DIRECTIONLESS_CASE",
      );
    }
  }
});

test("explicit STORNO and REPOST remain valid SPORNO rows with incomplete evidence", () => {
  const incompleteSource = physical({
    source_organization: "",
    source_archive_path: "",
    source_archive_sha256: "",
    journal_entry: "",
    journal_sha256: "",
    source_range: "",
    source_row_id: "",
    date: "",
    document: "",
    posting_number: "",
  });
  for (const action of ["STORNO", "REPOST"]) {
    const value = materializationCase({
      action,
      role: "STANDALONE",
      output_route: "SPORNO",
      correction_allowed: false,
      proof_status: "INCOMPLETE",
      physical_source: incompleteSource,
    });
    const row = postingRow(value, { operation: action });
    assert.equal(row.operation, action);
    assert.equal(row.output_route, "SPORNO");
    assert.equal(row.source.source_row_id, "");
    assert.equal(row.safety.posting_rows, 0);
  }
});

test("STORNO cannot replace the exact physical source accounting tuple", () => {
  const value = materializationCase({ action: "STORNO", role: "STANDALONE" });
  const changed = target({
    debit: "44",
    credit: "71",
    debit_analytics: ["Подмена Дт-1", "Подмена Дт-2", "Подмена Дт-3"],
    credit_analytics: ["Подмена Кт-1", "Подмена Кт-2", "Подмена Кт-3"],
    debit_department: "Подмена Дт подразделения",
    credit_department: "Подмена Кт подразделения",
  });
  throwsCode(
    () => postingRow(value, { result_accounting: changed, loader: loader(value.physical_source, changed, "STORNO") }),
    "STORNO_SOURCE_TUPLE_MISMATCH",
  );
});

test("READY requires source analytics, departments, and amount", () => {
  for (const physicalSource of [
    physical({ debit_analytics: ["", "Дт-А2", "Дт-А3"] }),
    physical({ debit_analytics: ["Дт-А1", "", "Дт-А3"] }),
    physical({ debit_analytics: ["Дт-А1", "Дт-А2", ""] }),
    physical({ credit_analytics: ["", "Кт-А2", "Кт-А3"] }),
    physical({ credit_analytics: ["Кт-А1", "", "Кт-А3"] }),
    physical({ credit_analytics: ["Кт-А1", "Кт-А2", ""] }),
    physical({ debit_department: "" }),
    physical({ credit_department: "" }),
    physical({ amount: null }),
  ]) {
    throwsCode(
      () => materializationCase({ physical_source: physicalSource }),
      "READY_PHYSICAL_IDENTITY_INCOMPLETE",
    );
  }
});

test("posting-row boundary revalidates forged MaterializationCase authority", () => {
  const valid = materializationCase();
  const invalidAction = { ...valid, action: "DELETE" };
  throwsCode(() => postingRow(invalidAction), "INVALID_ACTION");

  const missingAuthority = { ...valid, correction_allowed: false };
  throwsCode(() => postingRow(missingAuthority), "READY_AUTHORITY_MISSING");
});

test("SPORNO and REVIEW_ONLY remain report-only without fabricated source identity", () => {
  for (const outputRoute of ["SPORNO", "REVIEW_ONLY"]) {
    const source = physical({ source_row_id: "", source_archive_path: "", source_archive_sha256: "", journal_entry: "", journal_sha256: "" });
    const value = materializationCase({
      output_route: outputRoute,
      correction_allowed: false,
      proof_status: "UNPROVEN",
      physical_source: source,
    });
    const result = stornoAccounting(source);
    const rowLoader = loader(source, result, "STORNO");
    const row = postingRow(value, { result_accounting: result, loader: rowLoader });
    assert.equal(row.output_route, outputRoute);
    assert.equal(row.source.source_row_id, "");
    assert.deepEqual(row.safety, {
      report_only: true,
      execution_allowed: false,
      ready_to_upload: false,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      release_allowed: false,
      live_1c_allowed: false,
      live_delete_allowed: false,
    });
  }
});

test("UPDATE_MAPPING and NO_POSTING cannot create financial posting rows", () => {
  for (const action of ["UPDATE_MAPPING", "NO_POSTING"]) {
    const value = materializationCase({ action, output_route: "REVIEW_ONLY", correction_allowed: false });
    throwsCode(() => postingRow(value), "NON_FINANCIAL_CASE");
  }
});

test("output route and materialization state cannot contradict", () => {
  const value = materializationCase({ output_route: "SPORNO", correction_allowed: false, proof_status: "UNPROVEN" });
  throwsCode(() => postingRow(value, { materialization_state: "MATERIALIZED_READY" }), "ROUTE_STATE_CONTRADICTION");
});

test("normalization rejects every safety elevation", () => {
  throwsCode(() => materializationCase({ safety: { execution_allowed: true } }), "SAFETY_ELEVATION");
  const value = materializationCase();
  throwsCode(() => postingRow(value, { safety: { live_1c_allowed: true } }), "SAFETY_ELEVATION");
});

test("canonical posting row carries the exact ordered A:AA loader contract", () => {
  const row = postingRow(materializationCase());
  assert.equal(LOADER_A_AA_FIELDS.length, 27);
  assert.equal(row.loader_values.length, 27);
  assert.deepEqual(row.loader_values, LOADER_A_AA_FIELDS.map((field) => row.loader[field]));
  assert.equal(row.loader.ИдентификаторФинЗаписи, row.source.source_row_id);
  const mismatchedAmount = loader(row.source, row.result_accounting, "STORNO");
  mismatchedAmount.СуммаВВалютеОтчетности = 1;
  throwsCode(() => postingRow(materializationCase(), { loader: mismatchedAmount }), "LOADER_AMOUNT_MISMATCH");
});

test("signed economic effect and correction amount stay distinct", () => {
  const value = materializationCase({ signed_economic_effect: -500, correction_amount: 500 });
  assert.equal(value.signed_economic_effect, -500);
  assert.equal(value.correction_amount, 500);
});
