import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOADER_A_AA_FIELDS,
  MaterializationContractError,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import { bridgeR001DecisionsToMaterializationCases } from "./r001_materialization_bridge.mjs";
import { applyStandaloneStornoMaterialization } from "./owner_decision_r001.mjs";
import { materializeStandaloneStornoCases } from "./r001_standalone_storno_materialization.mjs";
import { routeOneSidedCorrections } from "./r005_review_routing.mjs";
import { ownerDecisionRows } from "../../reconciliation/source/owner_decision_projection.mjs";
import {
  buildIntalevSourceScopeDiagnostics,
  buildIntalevSourceScopeRowContract,
  relevantIntalevAbsenceProof,
} from "../../reconciliation/source/intalev_source_scope.mjs";

const ARCHIVE_SHA = "A".repeat(64);
const JOURNAL_SHA = "B".repeat(64);
const SOURCE_ROW_ID = "C".repeat(64);

function physical(overrides = {}) {
  return {
    source_organization: "ООО Физический источник",
    source_archive_path: "evidence/erp-source.zip",
    source_archive_sha256: ARCHIVE_SHA,
    journal_entry: "journal.xlsx",
    journal_sha256: JOURNAL_SHA,
    source_sheet: "Лист_1",
    source_range: "B42:AG42",
    source_row_id: SOURCE_ROW_ID,
    date: "15.10.2025 10:00:00",
    document: "Операция МСФО 42",
    posting_number: "7",
    debit: "26",
    credit: "60.01",
    debit_analytics: ["Исходная статья", "Проект", "ЦФО"],
    credit_analytics: ["Контрагент", "Договор", "ЦФО"],
    debit_department: "Администрация",
    credit_department: "Администрация",
    amount: 123.45,
    activity: "Да",
    scenario: "Факт",
    ...overrides,
  };
}

function canonicalCase(overrides = {}) {
  const source = overrides.physical_source ?? physical();
  return createMaterializationCase({
    case_id: overrides.case_id ?? "CASE-ERP-ONLY",
    pair_id: overrides.pair_id ?? "PAIR-ERP-ONLY",
    period: "2025-10",
    reconciliation_organization: "УК Отчётная",
    action: overrides.action ?? "STORNO",
    role: overrides.role ?? "STANDALONE",
    signed_economic_effect: overrides.signed_economic_effect ?? -123.45,
    correction_amount: overrides.correction_amount ?? 123.45,
    economic: {
      source_code: "ROW-SYNTHETIC",
      target_code: "",
      source_article: "Исходная статья",
      target_article: "",
    },
    proof_status: "ECONOMIC_CORRECTION_PROVEN",
    correction_allowed: overrides.correction_allowed ?? true,
    correction_authority: "ECONOMIC_CORRECTION_PROVEN",
    output_route: overrides.output_route ?? "SPORNO",
    physical_source: source,
    target_accounting: {},
    source_scope: overrides.source_scope ?? {
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_claimed: true,
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
    },
    blockers: overrides.blockers ?? ["EXACT_SOURCE_REOPEN_REQUIRED_FOR_READY"],
  });
}

function decision(overrides = {}) {
  return {
    case_id: "CASE-ERP-ONLY",
    pair_id: "PAIR-ERP-ONLY",
    classification: "ERP_ONLY",
    decision_type: "STORNO",
    action: "STORNO",
    role: "STANDALONE",
    intalev_source_scope_presence: "ABSENT_PROVEN",
    intalev_source_scope_absence_claimed: true,
    intalev_source_scope_absence_proven: true,
    intalev_source_scope_inventory_complete: true,
    intalev_source_scope_complete: true,
    intalev_source_amount_lost: false,
    ECONOMIC_ROUTE_PROVEN: true,
    ECONOMIC_CORRECTION_PROVEN: true,
    SOURCE_OPERATION_PROVEN: true,
    PHYSICAL_SOURCE_UNIQUE: true,
    correction_allowed: true,
    materialization_case: canonicalCase(),
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

function assertSparsePhysicalSporno(row) {
  assert.equal(row.output_route, "SPORNO");
  assert.equal(row.materialization_state, "MATERIALIZED_SPORNO");
  assert.equal(row.source_organization, "");
  assert.equal(row.source.source_row_id, "");
  assert.equal(row.source.source_archive_path, "");
  assert.equal(row.source.journal_sha256, "");
  for (const [index, field] of LOADER_A_AA_FIELDS.entries()) {
    if ([4, 9, 10, 15].includes(index)) continue;
    assert.equal(row.loader_values[index], null, field);
  }
}

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xlsxCell(reference, value) {
  return typeof value === "number"
    ? `<c r="${reference}"><v>${value}</v></c>`
    : `<c r="${reference}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
}

async function buildPinnedJournalArchive(targetDir) {
  const { default: JSZip } = await import("jszip");
  const headers = {
    B: "Дата", D: "Документ", E: "НомерСтроки", F: "Активность", G: "СчетДт",
    H: "СубконтоДт1", I: "СубконтоДт2", J: "СубконтоДт3", K: "ПодразделениеДт",
    L: "НаправлениеДеятельностиДт", M: "ВалютаДт", N: "СуммаВВалютеДт", O: "КоличествоДт",
    P: "СчетКт", Q: "СубконтоКт1", R: "СубконтоКт2", S: "СубконтоКт3",
    T: "ПодразделениеКт", U: "НаправлениеДеятельностиКт", V: "ВалютаКт",
    W: "СуммаВВалютеКт", X: "КоличествоКт", Y: "СуммаВВалютеУчета",
    Z: "СуммаВВалютеОтчетности", AA: "Организация", AB: "Сценарий", AC: "ВидОперации",
    AD: "Содержание", AE: "СтатьяДоходовИРасходов", AF: "ГруппаРаскрытия", AG: "Аналитика3",
  };
  const values = {
    B: "15.10.2025 10:00:00", D: "Операция МСФО 42", E: 7, F: "Да", G: "26",
    H: "Исходная статья", I: "Проект", J: "ЦФО", K: "Администрация", L: "Основная",
    M: "RUB", N: 123.45, O: 1, P: "60.01", Q: "Контрагент", R: "Договор", S: "ЦФО",
    T: "Администрация", U: "Основная", V: "RUB", W: 123.45, X: 1, Y: 123.45, Z: 123.45,
    AA: "ООО Физический источник", AB: "Факт", AC: "Трансляция", AD: "Синтетическая операция",
    AE: "Исходная статья", AF: "Расходы", AG: "ЦФО",
  };
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="B1:AG42"/><sheetData>
<row r="1">${Object.entries(headers).map(([column, value]) => xlsxCell(`${column}1`, value)).join("")}</row>
<row r="42">${Object.entries(values).map(([column, value]) => xlsxCell(`${column}42`, value)).join("")}</row>
</sheetData></worksheet>`;
  const workbook = new JSZip();
  workbook.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  workbook.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  workbook.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист_1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  workbook.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  workbook.file("xl/worksheets/sheet1.xml", sheet);
  const journalBuffer = await workbook.generateAsync({ type: "nodebuffer" });
  const journalSha = hash(journalBuffer);
  const sourceRowId = hash(Buffer.from(`${journalSha}|Лист_1|42`, "utf8"));
  const archive = new JSZip();
  archive.file("journal.xlsx", journalBuffer);
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer" });
  const archivePath = path.join(targetDir, "erp-source.zip");
  await fs.writeFile(archivePath, archiveBuffer);
  return { archivePath, archiveSha: hash(archiveBuffer), journalSha, sourceRowId };
}

test("genuine ERP-only exact source remains one proven SPORNO row after reopen", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => reopened(),
  });

  assert.equal(result.canonical_posting_rows.length, 1);
  const [row] = result.canonical_posting_rows;
  assert.equal(row.operation, "STORNO");
  assert.equal(row.output_route, "SPORNO");
  assert.equal(row.materialization_state, "MATERIALIZED_SPORNO");
  assert.equal(row.correction_allowed, false);
  assert.equal(row.source_organization, "ООО Физический источник");
  assert.notEqual(row.source_organization, row.reconciliation_organization);
  assert.equal(row.source.source_row_id, SOURCE_ROW_ID);
  assert.deepEqual(row.result_accounting.debit_analytics, ["Исходная статья", "Проект", "ЦФО"]);
  assert.equal(row.loader["Содержание"],
    "Операция STORNO | ERP: документ «Операция МСФО 42»; дата 15.10.2025 10:00:00; проводка № 7; Дт 26; Кт 60.01; сумма 123,45; организация «ООО Физический источник»; подразделение «Администрация» | Статья: «Исходная статья» | документ операций Инталев не представлен | Причина: односторонний STORNO требует сбалансированной пары STORNO/REPOST для подтверждённого результата");
  assert.equal(result.case_updates[0].materialization_case.economic.source_article, "Исходная статья");
  assert.equal(result.case_updates[0].result, "SPORNO");
  assert.ok(result.case_updates[0].blockers.includes("BALANCED_STORNO_REPOST_PAIR_REQUIRED_FOR_READY"));
  assert.equal(result.audit.ready_row_count, 0);
  assert.equal(result.audit.sporno_row_count, 1);
  assert.equal(result.safety.posting_rows, 0);
});

test("standalone SPORNO materializer exposes reuse as one additional sparse row", async () => {
  const second = decision({
    case_id: "CASE-ERP-ONLY-SECOND",
    pair_id: "PAIR-ERP-ONLY-SECOND",
    materialization_case: canonicalCase({
      case_id: "CASE-ERP-ONLY-SECOND",
      pair_id: "PAIR-ERP-ONLY-SECOND",
    }),
  });
  const result = await materializeStandaloneStornoCases([decision(), second], {
    reopenSource: async () => reopened(),
  });

  assert.equal(result.audit.ready_row_count, 0);
  assert.equal(result.audit.sporno_row_count, 2);
  assert.equal(result.canonical_posting_rows.length, 2);
  assert.equal(result.canonical_posting_rows[0].source.source_row_id, SOURCE_ROW_ID);
  assertSparsePhysicalSporno(result.canonical_posting_rows[1]);
  assert.equal(result.case_updates[1].result, "SPORNO");
  assert.ok(result.case_updates[1].blockers.includes("PHYSICAL_SOURCE_ALREADY_USED"));
  assert.ok(result.case_updates[1].blockers.includes("BALANCED_STORNO_REPOST_PAIR_REQUIRED_FOR_READY"));
  assert.match(result.canonical_posting_rows[1].loader["Содержание"], /физическая строка ERP уже использована другой корректировкой/);
});

test("business-content enrichment leaves every standalone physical loader value unchanged except Содержание", async () => {
  const baseline = await materializeStandaloneStornoCases([decision()], { reopenSource: async () => reopened() });
  const enriched = await materializeStandaloneStornoCases([decision({
    intalev_reference: "агрегат ОПИУ; регистратор операций Инталев в выгрузке ОПИУ отсутствует",
  })], { reopenSource: async () => reopened() });
  const baselineValues = [...baseline.canonical_posting_rows[0].loader_values];
  const enrichedValues = [...enriched.canonical_posting_rows[0].loader_values];
  baselineValues[15] = "<CONTENT>";
  enrichedValues[15] = "<CONTENT>";
  assert.deepEqual(enrichedValues, baselineValues);
  assert.deepEqual(enriched.canonical_posting_rows[0].source, baseline.canonical_posting_rows[0].source);
  assert.deepEqual(enriched.canonical_posting_rows[0].result_accounting, baseline.canonical_posting_rows[0].result_accounting);
});

test("default verifier reopens the pinned ZIP/XLSX and validates the exact row", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r001-49-"));
  try {
    const source = await buildPinnedJournalArchive(temporary);
    const exactPhysical = physical({
      source_archive_path: source.archivePath,
      source_archive_sha256: source.archiveSha,
      journal_sha256: source.journalSha,
      source_row_id: source.sourceRowId,
    });
    const input = decision({
      materialization_case: canonicalCase({ physical_source: exactPhysical }),
    });
    const result = await materializeStandaloneStornoCases([input]);
    assert.equal(result.canonical_posting_rows.length, 1);
    assert.equal(result.canonical_posting_rows[0].output_route, "SPORNO");
    assert.equal(result.canonical_posting_rows[0].source.source_row_id, source.sourceRowId);
    assert.equal(result.audit.ready_row_count, 0);
    assert.equal(result.audit.blocked_case_count, 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("absence flag cannot override incomplete relevant Intalev inventory", () => {
  const contract = buildIntalevSourceScopeRowContract({
    row: {
      period: "2025-10",
      erp_amount: 123.45,
      intalev_amount: null,
      intalev_source_scope_absence_proven: true,
    },
    sourceScopes: [{
      period: "2025-10",
      source_inventory_complete: false,
      source_scope_complete: false,
      source_amount_lost: true,
      unclassified_items: [],
    }],
  });
  assert.equal(contract.intalev_source_scope_presence, "ABSENCE_UNPROVEN");
  assert.equal(contract.intalev_source_scope_absence_claimed, true);
  assert.equal(contract.intalev_source_scope_absence_proven, false);
  assert.equal(contract.relevant_intalev_absence_proven, false);
  assert.ok(contract.relevant_intalev_absence_blockers.includes(
    "RELEVANT_INTALEV_SOURCE_INVENTORY_INCOMPLETE",
  ));
});

test("ABSENT_PROVEN text cannot override incomplete or lost relevant source scope", () => {
  for (const scope of [
    { source_inventory_complete: true, source_scope_complete: false, source_amount_lost: false },
    { source_inventory_complete: true, source_scope_complete: true, source_amount_lost: true },
  ]) {
    const contract = buildIntalevSourceScopeRowContract({
      row: {
        period: "2025-10",
        erp_amount: 123.45,
        intalev_amount: null,
        intalev_source_scope_presence: "ABSENT_PROVEN",
      },
      sourceScopes: [{ period: "2025-10", unclassified_items: [], ...scope }],
    });
    assert.equal(contract.intalev_source_scope_presence, "ABSENCE_UNPROVEN");
    assert.equal(contract.intalev_source_scope_absence_proven, false);
    assert.equal(contract.relevant_intalev_absence_proven, false);
  }
});

test("unresolved source amount is explicit source loss and cannot prove absence", () => {
  const diagnostics = buildIntalevSourceScopeDiagnostics({
    period: "2025-10",
    nodes: [{ period: "2025-10", level: 0, label: "Incomplete source", amount: null }],
  });
  assert.equal(diagnostics.source_inventory_complete, false);
  assert.equal(diagnostics.source_scope_complete, false);
  assert.equal(diagnostics.source_amount_lost, true);
  const contract = buildIntalevSourceScopeRowContract({
    row: {
      period: "2025-10",
      erp_amount: 123.45,
      intalev_amount: null,
      intalev_source_scope_absence_proven: true,
    },
    sourceScopes: [diagnostics],
  });
  assert.equal(contract.intalev_source_scope_presence, "ABSENCE_UNPROVEN");
  assert.equal(contract.relevant_intalev_absence_proven, false);
});

test("absence flag cannot promote unproven, blank, or noncanonical presence states", () => {
  for (const presence of ["ABSENCE_UNPROVEN", "", "ARBITRARY_ABSENCE_STATE"]) {
    const proof = relevantIntalevAbsenceProof({
      intalev_source_scope_presence: presence,
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
    });
    assert.equal(proof.proven, false, presence || "<blank>");
    assert.equal(proof.canonical_absence_state, false);
    assert.ok(proof.blockers.includes("RELEVANT_INTALEV_ABSENCE_STATE_NOT_ABSENT_PROVEN"));
    const contract = buildIntalevSourceScopeRowContract({
      row: {
        period: "2025-10",
        erp_amount: 123.45,
        intalev_amount: null,
        intalev_source_scope_presence: presence,
        intalev_source_scope_absence_proven: true,
      },
      sourceScopes: [{
        period: "2025-10",
        source_inventory_complete: true,
        source_scope_complete: true,
        source_amount_lost: false,
        unclassified_items: [],
      }],
    });
    assert.equal(contract.intalev_source_scope_presence, "ABSENCE_UNPROVEN");
    assert.equal(contract.relevant_intalev_absence_proven, false);
    if (!presence) {
      assert.ok(contract.relevant_intalev_absence_blockers.includes(
        "INTALEV_SOURCE_SCOPE_PRESENCE_MISSING",
      ));
    } else if (presence === "ARBITRARY_ABSENCE_STATE") {
      assert.ok(contract.relevant_intalev_absence_blockers.includes(
        "NONCANONICAL_INTALEV_SOURCE_SCOPE_PRESENCE",
      ));
    }
  }
});

test("ABSENT_PROVEN state still requires the explicit absence proof boolean", () => {
  const proof = relevantIntalevAbsenceProof({
    intalev_source_scope_presence: "ABSENT_PROVEN",
    intalev_source_scope_absence_proven: false,
    intalev_source_scope_inventory_complete: true,
    intalev_source_scope_complete: true,
    intalev_source_amount_lost: false,
  });
  assert.equal(proof.proven, false);
  assert.equal(proof.canonical_absence_state, true);
  assert.ok(proof.blockers.includes("RELEVANT_INTALEV_ABSENCE_NOT_EXPLICITLY_PROVEN"));
  const contract = buildIntalevSourceScopeRowContract({
    row: {
      period: "2025-10",
      erp_amount: 123.45,
      intalev_amount: null,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: false,
    },
    sourceScopes: [{
      period: "2025-10",
      source_inventory_complete: true,
      source_scope_complete: true,
      source_amount_lost: false,
      unclassified_items: [],
    }],
  });
  assert.equal(contract.intalev_source_scope_presence, "ABSENCE_UNPROVEN");
  assert.equal(contract.relevant_intalev_absence_proven, false);
});

test("invalid canonical presence stays REVIEW_ONLY and never reopens exact ERP source", async () => {
  const completeClaim = {
    intalev_source_scope_absence_claimed: true,
    intalev_source_scope_absence_proven: true,
    intalev_source_scope_inventory_complete: true,
    intalev_source_scope_complete: true,
    intalev_source_amount_lost: false,
  };
  for (const presence of ["ABSENCE_UNPROVEN", "", "ARBITRARY_ABSENCE_STATE"]) {
    const upstream = {
      ...decision({ ...completeClaim, intalev_source_scope_presence: presence }),
      materialization_case: undefined,
      period: "2025-10",
      organization: "УК Отчётная",
      reconciliation_row: "ROW-STATE-CONTRADICTION",
      correction_amount: 123.45,
      analytical_effect: -123.45,
      output_route: "READY",
    };
    const bridge = bridgeR001DecisionsToMaterializationCases([upstream]);
    assert.equal(bridge.financial_cases.length, 0, presence || "<blank>");
    assert.equal(bridge.review_only_cases.length, 1, presence || "<blank>");
    assert.equal(bridge.review_only_cases[0].output_route, "REVIEW_ONLY");
    assert.equal(bridge.review_only_cases[0].correction_allowed, false);
    assert.equal(bridge.canonical_posting_rows.length, 0);
  }

  let reopenCalls = 0;
  const standalone = await materializeStandaloneStornoCases([
    decision({
      ...completeClaim,
      intalev_source_scope_presence: "ABSENCE_UNPROVEN",
    }),
  ], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });
  assert.equal(reopenCalls, 0);
  assert.equal(standalone.canonical_posting_rows.length, 0);
  assert.equal(standalone.case_updates.length, 0);
  assert.ok(standalone.skipped[0].blockers.includes("GENUINE_INTALEV_ABSENCE_NOT_PROVEN"));
});

test("R005 one-sided routing grants zero authority to contradictory absence metadata", () => {
  const result = routeOneSidedCorrections({
    organization: "УК Отчётная",
    period: "2025-10",
    rows: [{
      code: "ROW-CONTRADICTORY",
      one_sided_type: "ERP_ONLY",
      erp_amount: 123.45,
      intalev_amount: null,
      economic_route_proven: true,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: false,
      intalev_source_scope_complete: false,
      intalev_source_amount_lost: true,
    }],
    residual_ledger: {
      rows: [{
        code: "ROW-CONTRADICTORY",
        integrity_status: "PASS",
        parent_unallocated_residual: -123.45,
      }],
    },
    operation_evidence: { rows: [] },
  });
  assert.deepEqual(result, []);
});

test("contradictory absence stays canonical REVIEW_ONLY across bridge and standalone", async () => {
  const source = physical();
  const upstream = {
    ...decision(),
    materialization_case: undefined,
    period: "2025-10",
    organization: "УК Отчётная",
    reconciliation_row: "ROW-CONTRADICTORY",
    correction_amount: 123.45,
    analytical_effect: -123.45,
    output_route: "READY",
    intalev_source_scope_presence: "ABSENT_PROVEN",
    intalev_source_scope_absence_claimed: true,
    intalev_source_scope_absence_proven: true,
    intalev_source_scope_inventory_complete: false,
    intalev_source_scope_complete: false,
    intalev_source_amount_lost: true,
    source_organization: source.source_organization,
    source_archive_path: source.source_archive_path,
    source_archive_sha256: source.source_archive_sha256,
    journal_entry: source.journal_entry,
    journal_sha256: source.journal_sha256,
    source_sheet: source.source_sheet,
    source_range: source.source_range,
    source_row_id: source.source_row_id,
    source_date: source.date,
    registrar: source.document,
    posting_number: source.posting_number,
    source_dt: source.debit,
    source_kt: source.credit,
    source_analytics_dt1: source.debit_analytics[0],
    source_analytics_dt2: source.debit_analytics[1],
    source_analytics_dt3: source.debit_analytics[2],
    source_analytics_kt1: source.credit_analytics[0],
    source_analytics_kt2: source.credit_analytics[1],
    source_analytics_kt3: source.credit_analytics[2],
    source_department_dt: source.debit_department,
    source_department_kt: source.credit_department,
    source_amount: source.amount,
    source_activity: source.activity,
    source_scenario: source.scenario,
  };
  const bridge = bridgeR001DecisionsToMaterializationCases([upstream]);
  assert.equal(bridge.financial_cases.length, 0);
  assert.equal(bridge.review_only_cases.length, 1);
  assert.equal(bridge.canonical_posting_rows.length, 0);
  assert.equal(bridge.review_only_cases[0].output_route, "REVIEW_ONLY");
  assert.equal(bridge.review_only_cases[0].correction_allowed, false);
  assert.equal(bridge.review_only_cases[0].source_scope.relevant_intalev_absence_proven, false);

  let reopenCalls = 0;
  const standalone = await materializeStandaloneStornoCases([{
    ...upstream,
    materialization_case: bridge.review_only_cases[0],
  }], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });
  assert.equal(reopenCalls, 0);
  assert.equal(standalone.canonical_posting_rows.length, 0);
  assert.equal(standalone.case_updates.length, 0);
  assert.ok(standalone.skipped[0].blockers.includes("GENUINE_INTALEV_ABSENCE_NOT_PROVEN"));
  assert.ok(standalone.skipped[0].blockers.includes("CANONICAL_INTALEV_ABSENCE_AUTHORITY_NOT_PROVEN"));
});

test("forged contradictory MaterializationCase source_scope cannot claim a financial route", () => {
  const valid = canonicalCase();
  for (const forged of [
    {
      output_route: "SPORNO",
      source_scope: {
        intalev_source_scope_presence: "ABSENT_PROVEN",
        intalev_source_scope_absence_claimed: true,
        intalev_source_scope_absence_proven: true,
        intalev_source_scope_inventory_complete: false,
        intalev_source_scope_complete: false,
        intalev_source_amount_lost: true,
      },
    },
    ...["SPORNO", "READY"].map((outputRoute) => ({
      output_route: outputRoute,
      source_scope: {
        intalev_source_scope_presence: "ABSENCE_UNPROVEN",
        intalev_source_scope_absence_claimed: true,
        intalev_source_scope_absence_proven: true,
        intalev_source_scope_inventory_complete: true,
        intalev_source_scope_complete: true,
        intalev_source_amount_lost: false,
      },
    })),
  ]) {
    assert.throws(
      () => createMaterializationCase({ ...valid, ...forged }),
      (error) => error instanceof MaterializationContractError
        && error.code === "RELEVANT_INTALEV_ABSENCE_AUTHORITY_UNPROVEN",
    );
  }
});

test("complete relevant inventory remains the only genuine absence positive authority", () => {
  const proof = relevantIntalevAbsenceProof({
    intalev_source_scope_presence: "ABSENT_PROVEN",
    intalev_source_scope_absence_proven: true,
    intalev_source_scope_inventory_complete: true,
    intalev_source_scope_complete: true,
    intalev_source_amount_lost: false,
  });
  assert.equal(proof.proven, true);
  assert.equal(proof.canonical_absence_state, true);
  assert.deepEqual(proof.blockers, []);
});

test("proven STORNO with incomplete physical source remains one SPORNO row with blanks", async () => {
  const incomplete = physical({
    source_organization: "",
    source_archive_path: "",
    source_archive_sha256: "",
    journal_entry: "",
    journal_sha256: "",
    source_sheet: "",
    source_range: "",
    source_row_id: "",
  });
  let reopenCalls = 0;
  const input = decision({
    SOURCE_OPERATION_PROVEN: false,
    PHYSICAL_SOURCE_UNIQUE: false,
    materialization_case: canonicalCase({ physical_source: incomplete, correction_allowed: false }),
  });
  const result = await materializeStandaloneStornoCases([input], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });

  assert.equal(reopenCalls, 0);
  assert.equal(result.canonical_posting_rows.length, 1);
  assert.equal(result.canonical_posting_rows[0].output_route, "SPORNO");
  assert.equal(result.canonical_posting_rows[0].source_organization, "");
  assert.equal(result.canonical_posting_rows[0].source.source_row_id, "");
  for (const [index, field] of LOADER_A_AA_FIELDS.entries()) {
    if ([4, 9, 10, 15].includes(index)) continue;
    assert.equal(result.canonical_posting_rows[0].loader_values[index], null, field);
  }
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /Причина: .*физическая строка ERP не доказана однозначно/);
  assert.equal(result.safety.execution_allowed, false);
  assert.equal(result.safety.ready_to_upload, false);
});

test("blank/unclassified source presence is never ERP-only STORNO authority", async () => {
  const inputs = [39_799, 5_700].map((amount, index) => decision({
    case_id: `BLANK-${index}`,
    classification: "PRESENT_UNCLASSIFIED_UNBOUND",
    intalev_source_scope_presence: "PRESENT_UNCLASSIFIED_UNBOUND",
    intalev_source_scope_absence_proven: false,
    materialization_case: canonicalCase({ case_id: `BLANK-${index}`, correction_amount: amount, signed_economic_effect: -amount }),
  }));
  const result = await materializeStandaloneStornoCases(inputs, { reopenSource: async () => reopened() });
  assert.equal(result.canonical_posting_rows.length, 0);
  assert.ok(result.skipped.every((item) => item.blockers.includes("GENUINE_INTALEV_ABSENCE_NOT_PROVEN")));
});

test("incomplete scope, sign-only direction, and ADD_ONE_SIDE create zero rows", async () => {
  const inputs = [
    decision({ intalev_source_scope_presence: "ABSENCE_UNPROVEN", intalev_source_scope_absence_proven: false }),
    decision({ case_id: "SIGN-ONLY", ECONOMIC_ROUTE_PROVEN: false, materialization_case: canonicalCase({ case_id: "SIGN-ONLY" }) }),
    decision({
      case_id: "DIRECTIONLESS",
      decision_type: "ADD_ONE_SIDE",
      action: "ADD_ONE_SIDE",
      materialization_case: canonicalCase({
        case_id: "DIRECTIONLESS",
        action: "ADD_ONE_SIDE",
        signed_economic_effect: 123.45,
        correction_allowed: false,
        output_route: "REVIEW_ONLY",
      }),
    }),
  ];
  const result = await materializeStandaloneStornoCases(inputs, { reopenSource: async () => reopened() });
  assert.equal(result.canonical_posting_rows.length, 0);
});

test("missing or ambiguous SourceRowID cannot become READY", async () => {
  const missing = physical({ source_row_id: "" });
  const input = decision({
    SOURCE_OPERATION_PROVEN: false,
    PHYSICAL_SOURCE_UNIQUE: false,
    materialization_case: canonicalCase({ physical_source: missing, correction_allowed: false }),
  });
  const result = await materializeStandaloneStornoCases([input], { reopenSource: async () => reopened() });
  assert.equal(result.canonical_posting_rows.length, 1);
  assert.equal(result.canonical_posting_rows[0].output_route, "SPORNO");
  assert.equal(result.audit.ready_row_count, 0);
});

test("report organization never fills a blank physical source organization", async () => {
  const input = decision({
    SOURCE_OPERATION_PROVEN: false,
    PHYSICAL_SOURCE_UNIQUE: false,
    materialization_case: canonicalCase({ physical_source: physical({ source_organization: "" }), correction_allowed: false }),
  });
  const result = await materializeStandaloneStornoCases([input], { reopenSource: async () => reopened() });
  assert.equal(result.canonical_posting_rows[0].source_organization, "");
  assert.notEqual(result.canonical_posting_rows[0].source_organization, "УК Отчётная");
});

test("claimed closing physical source remains one sparse SPORNO row without reopen", async () => {
  let reopenCalls = 0;
  const input = decision({
    materialization_case: canonicalCase({ physical_source: physical({ debit: "99" }) }),
  });
  const result = await materializeStandaloneStornoCases([input], {
    reopenSource: async () => { reopenCalls += 1; return reopened(); },
  });

  assert.equal(reopenCalls, 0);
  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.ok(result.case_updates[0].blockers.includes("CLOSING_ROW_NOT_ECONOMIC_SOURCE"));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /закрывающей и не доказывает/);
});

test("Dt/Kt99 reopen mismatch cannot stand in for the economic source and remains sparse SPORNO", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => reopened({ debit: "99" }),
  });
  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.ok(result.case_updates[0].blockers.includes("CLOSING_ROW_NOT_ECONOMIC_SOURCE"));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /при повторной проверке не совпала/);
});

test("forged or stale pinned provenance remains one sparse SPORNO row", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => ({ ...reopened(), archive_sha256: "D".repeat(64) }),
  });
  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.ok(result.case_updates[0].blockers.includes("EXACT_SOURCE_MISMATCH:archive_sha256"));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /при повторной проверке не совпала/);
});

test("stale SourceRowID cannot bind a different exact ERP row and remains sparse SPORNO", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => reopened({ source_row_id: "D".repeat(64) }),
  });
  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.ok(result.case_updates[0].blockers.includes("EXACT_SOURCE_MISMATCH:source_row_id"));
});

test("source amount mismatch remains one sparse SPORNO row, not an ERP balance", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => reopened({ amount: 500 }),
  });
  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.ok(result.case_updates[0].blockers.includes("EXACT_SOURCE_AMOUNT_MISMATCH"));
});

test("reopen error preserves the economic direction as one sparse SPORNO row", async () => {
  const result = await materializeStandaloneStornoCases([decision()], {
    reopenSource: async () => {
      const error = new Error("synthetic reopen failure");
      error.code = "PINNED_SOURCE_REOPEN_FAILED";
      throw error;
    },
  });

  assert.equal(result.canonical_posting_rows.length, 1);
  assertSparsePhysicalSporno(result.canonical_posting_rows[0]);
  assert.equal(result.case_updates[0].result, "SPORNO");
  assert.ok(result.case_updates[0].blockers.includes("PINNED_SOURCE_REOPEN_FAILED"));
  assert.match(result.canonical_posting_rows[0].loader["Содержание"], /не удалось повторно открыть и проверить/);
});

test("bridge requires explicit absence and defers ERP-only READY until exact reopen", async () => {
  const source = physical();
  const upstream = {
    ...decision(),
    materialization_case: undefined,
    period: "2025-10",
    organization: "УК Отчётная",
    reconciliation_row: "ROW-SYNTHETIC",
    correction_amount: 123.45,
    analytical_effect: -123.45,
    output_route: "READY",
    source_organization: source.source_organization,
    source_archive_path: source.source_archive_path,
    source_archive_sha256: source.source_archive_sha256,
    journal_entry: source.journal_entry,
    journal_sha256: source.journal_sha256,
    source_sheet: source.source_sheet,
    source_range: source.source_range,
    source_row_id: source.source_row_id,
    source_date: source.date,
    registrar: source.document,
    posting_number: source.posting_number,
    source_dt: source.debit,
    source_kt: source.credit,
    source_analytics_dt1: source.debit_analytics[0],
    source_analytics_dt2: source.debit_analytics[1],
    source_analytics_dt3: source.debit_analytics[2],
    source_analytics_kt1: source.credit_analytics[0],
    source_analytics_kt2: source.credit_analytics[1],
    source_analytics_kt3: source.credit_analytics[2],
    source_department_dt: source.debit_department,
    source_department_kt: source.credit_department,
    source_amount: source.amount,
    source_activity: source.activity,
    source_scenario: source.scenario,
    source_article: "Исходная статья",
  };
  const bridge = bridgeR001DecisionsToMaterializationCases([upstream]);
  assert.equal(bridge.financial_cases.length, 1);
  assert.equal(bridge.financial_cases[0].output_route, "SPORNO");
  assert.ok(bridge.financial_cases[0].blockers.includes("EXACT_SOURCE_REOPEN_REQUIRED_FOR_READY"));
  assert.equal(bridge.financial_cases[0].source_scope.intalev_source_scope_presence, "ABSENT_PROVEN");

  const inputs = [{ ...upstream, materialization_case: bridge.financial_cases[0] }];
  const standalone = await materializeStandaloneStornoCases(inputs, { reopenSource: async () => reopened() });
  const merged = applyStandaloneStornoMaterialization({
    decisions: inputs,
    materialization_bridge: bridge,
  }, standalone);
  assert.equal(merged.materialization_bridge.canonical_posting_rows.length, 1);
  assert.equal(merged.materialization_bridge.audit.standalone_storno_ready_row_count, 0);
  assert.equal(merged.materialization_bridge.audit.standalone_storno_sporno_row_count, 1);
  assert.equal(merged.decisions[0].standalone_storno_result, "SPORNO");
});

test("ERP-only label without accepted absence proof remains canonical REVIEW_ONLY", () => {
  const upstream = {
    case_id: "CASE-ABSENCE-UNPROVEN",
    pair_id: "PAIR-ABSENCE-UNPROVEN",
    period: "2025-10",
    organization: "УК Отчётная",
    reconciliation_row: "ROW-SYNTHETIC",
    classification: "ERP_ONLY",
    decision_type: "STORNO",
    action: "STORNO",
    correction_amount: 123.45,
    analytical_effect: -123.45,
    correction_allowed: true,
    output_route: "READY",
    intalev_source_scope_presence: "ABSENCE_UNPROVEN",
    intalev_source_scope_absence_proven: false,
  };
  const bridge = bridgeR001DecisionsToMaterializationCases([upstream]);
  assert.equal(bridge.financial_cases.length, 0);
  assert.equal(bridge.review_only_cases.length, 1);
  assert.equal(bridge.review_only_cases[0].output_route, "REVIEW_ONLY");
  assert.equal(bridge.review_only_cases[0].correction_allowed, false);
  assert.ok(bridge.review_only_cases[0].blockers.includes("GENUINE_INTALEV_ABSENCE_NOT_PROVEN"));
  assert.equal(bridge.canonical_posting_rows.length, 0);
});

test("upstream keeps economic STORNO proof separate from incomplete physical proof", () => {
  const result = routeOneSidedCorrections({
    organization: "УК Отчётная",
    period: "2025-10",
    rows: [{
      code: "ROW-SYNTHETIC",
      one_sided_type: "ERP_ONLY",
      erp_amount: 123.45,
      intalev_amount: null,
      economic_route_proven: true,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
    }],
    residual_ledger: {
      rows: [{ code: "ROW-SYNTHETIC", integrity_status: "PASS", parent_unallocated_residual: -123.45 }],
    },
    operation_evidence: { rows: [] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].decision_type, "STORNO");
  assert.equal(result[0].ECONOMIC_STORNO_DIRECTION_PROVEN, true);
  assert.equal(result[0].ECONOMIC_CORRECTION_PROVEN, false);
  assert.equal(result[0].SOURCE_OPERATION_PROVEN, false);
  assert.equal(result[0].PHYSICAL_SOURCE_UNIQUE, false);
  assert.equal(result[0].correction_allowed, false);
  assert.equal(result[0].output_route, "SPORNO");
  assert.equal(result[0].financial_materialization_forbidden, false);
});

test("upstream exact source carries pinned tuple and article without report-org fallback", () => {
  const result = routeOneSidedCorrections({
    organization: "УК Отчётная",
    period: "2025-10",
    rows: [{
      code: "ROW-SYNTHETIC",
      one_sided_type: "ERP_ONLY",
      erp_amount: 123.45,
      intalev_amount: null,
      erp_article: "Исходная статья",
      economic_route_proven: true,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
    }],
    residual_ledger: {
      rows: [{ code: "ROW-SYNTHETIC", integrity_status: "PASS", parent_unallocated_residual: -123.45 }],
    },
    operation_evidence: { rows: [{
      code: "ROW-SYNTHETIC",
      organization: "ООО Физический источник",
      period: "2025-10",
      source_operation_proven: true,
      proof_status: "PROVEN",
      source_row_id: SOURCE_ROW_ID,
      source_range: "B42:AG42",
      date: "15.10.2025 10:00:00",
      document: "Операция МСФО 42",
      posting_no: 7,
      debit: "26",
      credit: "60.01",
      debit_analytics: ["Исходная статья", "Проект", "ЦФО"],
      credit_analytics: ["Контрагент", "Договор", "ЦФО"],
      debit_department: "Администрация",
      credit_department: "Администрация",
      amount: 123.45,
      activity: "Да",
      scenario: "Факт",
      article: "Исходная статья",
      erp_input_sha256: ARCHIVE_SHA,
      erp_opiu_sha256: "D".repeat(64),
      journal_sha256: JOURNAL_SHA,
      journal_sheet: "Лист_1",
      journal_input_path: "evidence/erp-source.zip",
      journal_archive_entry: "journal.xlsx",
    }] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].SOURCE_OPERATION_PROVEN, true);
  assert.equal(result[0].PHYSICAL_SOURCE_UNIQUE, true);
  const [member] = result[0].member_rows;
  assert.equal(member.source_organization, "ООО Физический источник");
  assert.notEqual(member.source_organization, "УК Отчётная");
  assert.equal(member.source_row_id, SOURCE_ROW_ID);
  assert.equal(member.source_archive_sha256, ARCHIVE_SHA);
  assert.equal(member.journal_entry, "journal.xlsx");
  assert.equal(member.source_article, "Исходная статья");
  assert.deepEqual([
    member.source_analytics_dt1,
    member.source_analytics_dt2,
    member.source_analytics_dt3,
  ], ["Исходная статья", "Проект", "ЦФО"]);
});

test("owner projection serialization preserves standalone absence and exact-source provenance", () => {
  const [row] = ownerDecisionRows({
    organization: "УК Отчётная",
    period: "2025-10",
    residual_ledger: {
      rows: [{ code: "ROW-SYNTHETIC", parent_unallocated_residual: -123.45 }],
    },
    cases: [{
      case_id: "CASE-ERP-ONLY",
      pair_id: "PAIR-ERP-ONLY",
      classification: "ERP_ONLY",
      decision_type: "STORNO",
      amount: 123.45,
      proof_status: "ECONOMIC_CORRECTION_PROVEN",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      correction_allowed: true,
      ECONOMIC_ROUTE_PROVEN: true,
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
  });
  assert.equal(row.source_organization, "ООО Физический источник");
  assert.equal(row.organization, "УК Отчётная");
  assert.equal(row.source_row_id, SOURCE_ROW_ID);
  assert.equal(row.source_archive_sha256, ARCHIVE_SHA);
  assert.equal(row.source_amount, 123.45);
  assert.equal(row.source_activity, "Да");
  assert.equal(row.source_scenario, "Факт");
  assert.equal(row.source_article, "Исходная статья");
  assert.equal(row.intalev_source_scope_presence, "ABSENT_PROVEN");
  assert.equal(row.intalev_source_scope_absence_proven, true);
  assert.equal(row.intalev_source_scope_inventory_complete, true);
  assert.equal(row.intalev_source_scope_complete, true);
  assert.equal(row.intalev_source_amount_lost, false);
  assert.equal(row.relevant_intalev_absence_proven, true);
  assert.deepEqual(row.relevant_intalev_absence_blockers, []);
});

test("owner projection does not fabricate an ERP_ONLY physical amount from the case balance", () => {
  const [row] = ownerDecisionRows({
    organization: "УК Отчётная",
    period: "2025-10",
    residual_ledger: {
      rows: [{ code: "ROW-AMBIGUOUS", parent_unallocated_residual: -123.45 }],
    },
    cases: [{
      case_id: "CASE-AMBIGUOUS",
      classification: "ERP_ONLY",
      decision_type: "STORNO",
      amount: 123.45,
      proof_status: "ECONOMIC_STORNO_DIRECTION_PROVEN",
      approval_state: "ТРЕБУЕТ_ПРОВЕРКИ",
      correction_allowed: false,
      ECONOMIC_ROUTE_PROVEN: true,
      ECONOMIC_STORNO_DIRECTION_PROVEN: true,
      SOURCE_OPERATION_PROVEN: false,
      PHYSICAL_SOURCE_UNIQUE: false,
      intalev_source_scope_presence: "ABSENT_PROVEN",
      intalev_source_scope_absence_proven: true,
      intalev_source_scope_inventory_complete: true,
      intalev_source_scope_complete: true,
      intalev_source_amount_lost: false,
      member_rows: [{
        code: "ROW-AMBIGUOUS",
        role: "ERP_ONLY",
        economic_direction: "STORNO",
        effective_delta: -123.45,
      }],
    }],
  });
  assert.equal(row.source_amount, null);
  assert.equal(row.source_organization, "");
  assert.equal(row.source_row_id, "");
  assert.equal(row.source_article, "");
  assert.equal(row.correction_amount, 123.45);
  assert.equal(row.output_route, "SPORNO");
});
