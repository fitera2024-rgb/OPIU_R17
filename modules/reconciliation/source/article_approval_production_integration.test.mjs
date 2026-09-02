import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const reconciliationSource = fs.readFileSync(
  new URL("./opiu_reconcile.mjs", import.meta.url),
  "utf8",
);
const crossJournalSource = fs.readFileSync(
  new URL("./cross_journal_discrepancy_evidence.mjs", import.meta.url),
  "utf8",
);

test("APPROVAL-003 production: approved JSON is loaded before cross-journal target selection", () => {
  const loadApproval = reconciliationSource.indexOf(
    "articleApprovalDocument = await loadArticleApprovalDocument",
  );
  const selectCrossJournal = reconciliationSource.indexOf(
    "crossJournalEvidence = await buildCrossJournalDiscrepancyEvidence",
  );
  const loadHierarchy = reconciliationSource.indexOf(
    "await loadAuthoritativeOrganizationHierarchy",
  );
  const derivePhysicalScope = reconciliationSource.indexOf(
    "physicalOrganizationScope = derivePhysicalOrganizationScope",
  );
  assert.ok(loadApproval >= 0, "production approved loader is missing");
  assert.ok(selectCrossJournal >= 0, "production cross-journal builder is missing");
  assert.ok(loadApproval < selectCrossJournal, "approved JSON must load before cross-journal selection");
  assert.ok(loadHierarchy >= 0 && loadHierarchy < selectCrossJournal);
  assert.ok(derivePhysicalScope >= 0 && derivePhysicalScope < selectCrossJournal);

  const call = reconciliationSource.slice(
    selectCrossJournal,
    reconciliationSource.indexOf("});", selectCrossJournal) + 3,
  );
  assert.match(call, /articleApprovalDocument/u);
  assert.match(call, /articleApprovalScope/u);
  assert.match(
    call,
    /allowedPhysicalOrganizations: physicalOrganizationScope\.member_names/u,
  );
  assert.doesNotMatch(call, /journalOrganizationAliases/u);
  assert.doesNotMatch(call, /allowedPhysicalOrganizations: unique\(/u);
});

test("APPROVAL-003 production: cross-journal invokes A22 and keeps one shared reuse set", () => {
  assert.match(crossJournalSource, /evaluateArticleApprovalFinancialGate\(\{/u);
  assert.match(
    crossJournalSource,
    /const sharedUsedSourceIds = usedSourceIds instanceof Set \? usedSourceIds : new Set\(\);/u,
  );
  assert.match(crossJournalSource, /usedSourceIds: sharedUsedSourceIds/u);
  assert.match(crossJournalSource, /usedSourceIds,\s+allowedPhysicalOrganizations,/u);
});

test("APPROVAL-003 production: exact-scope approval resolves before every automatic target selector", () => {
  const automaticSelections = [...crossJournalSource.matchAll(
    /const automaticTarget = \["APPROVED_EXACT_SCOPE", "FORBIDDEN"\]\.includes\(/gu,
  )];
  assert.equal(automaticSelections.length, 2);
  for (const selection of automaticSelections) {
    const precedingApproval = crossJournalSource.lastIndexOf(
      "const approval = resolveApprovalForScopes",
      selection.index,
    );
    assert.ok(precedingApproval >= 0 && precedingApproval < selection.index);
  }
  assert.equal(
    (crossJournalSource.match(/\? null\s+: selectTargetArticle\(\{/gu) ?? []).length,
    2,
  );
  assert.match(
    crossJournalSource,
    /status: "APPROVAL_FORBIDDEN",[\s\S]*?selection_basis: "APPROVAL_FORBIDDEN"/u,
  );
});

test("APPROVAL-003 production: 04B is created and populated only from successful gate rows", () => {
  assert.match(
    reconciliationSource,
    /crossJournalEvidence\?\.correction_decision_rows \?\? 0/u,
  );
  assert.match(
    reconciliationSource,
    /filter\(\(row\) => row\.financial_gate_status === "ДОКАЗАНО"\)/u,
  );
  assert.match(
    reconciliationSource,
    /Array\.isArray\(row\.correction_rows\) && row\.correction_rows\.length === 2/u,
  );
  for (const physicalField of [
    "source_row_id", "date", "document", "posting_no", "debit", "credit", "organization",
  ]) {
    assert.match(
      reconciliationSource,
      new RegExp(`sourceCorrection\\.${physicalField}`, "u"),
    );
  }
  assert.match(reconciliationSource, /sourceCorrection\.debit_analytics/u);
  assert.match(reconciliationSource, /sourceCorrection\.credit_analytics/u);
});

test("APPROVAL-003 production: REPORT_ONLY counters never promote gate rows to posting/live/executed", () => {
  for (const field of ["posting_rows", "live_rows", "executed_rows"]) {
    assert.match(crossJournalSource, new RegExp(`${field}: 0`, "u"));
  }
  assert.doesNotMatch(crossJournalSource, /posting_rows:\s*approvedFinancialRows\.length/u);
  assert.match(crossJournalSource, /live_1c_allowed: false/u);
  assert.match(crossJournalSource, /execution_allowed: false/u);
});
