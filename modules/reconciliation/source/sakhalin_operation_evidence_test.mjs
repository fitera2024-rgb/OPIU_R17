import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_UK_OPERATION_BEARING_CODES,
  buildUnassignedOperationRow,
  loadArbitraryPeriodOperationEvidence,
  selectJournalRowsForExactProfile,
} from "./arbitrary_period_operation_evidence.mjs";
import { readOperationJournalRows } from "./full_operation_evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const journalPath = process.argv[2] || process.env.SAKHALIN_JOURNAL_XLSX;
const ukCompanionPath = process.argv[3] || process.env.UK_BASELINE_CODEX_INPUT;
const erpOpiuPath = process.argv[4] || process.env.SAKHALIN_ERP_OPIU_XLSX;
const erpArchivePath = process.argv[5] || process.env.SAKHALIN_ERP_ARCHIVE;
let sakhalinExactBoundRows = null;
let sakhalinExactBoundRCodes = [];
let syntheticExactBoundRows = null;

assert.ok(journalPath, "Pass the extracted Sakhalin journal XLSX as argument 1");

const profiles = JSON.parse(
  await fs.readFile(path.join(here, "organization_profiles.json"), "utf8"),
);
const sakhalin = profiles.profiles.find((profile) => profile.id === "ROOT_SAKHALIN_REVIEW");
const ukProfile = profiles.profiles.find((profile) => profile.id === "UK_R005");
assert.ok(sakhalin, "ROOT_SAKHALIN_REVIEW profile is required");
assert.deepEqual(sakhalin.journal_organization_aliases, ["Сахалин_Без ЮЛ"]);
assert.equal(sakhalin.show_unassigned_journal_rows, true);
assert.ok(sakhalin.operation_bearing_codes.length > 0);
assert.ok(ukProfile.journal_organization_aliases.length > 0, "Legacy UK display aliases remain profile data only");
assert.deepEqual(
  ukProfile.operation_bearing_codes,
  [...DEFAULT_UK_OPERATION_BEARING_CODES],
  "UK operation-bearing R-codes must remain unchanged",
);

const journal = await readOperationJournalRows({ journalPath });
const selected = selectJournalRowsForExactProfile(
  journal.rows,
  "2025-01",
  sakhalin.journal_organization_aliases,
);
assert.equal(selected.length, 39, "Sakhalin exact organization scope must contain 39 active fact rows");
assert.ok(selected.every((row) => row.organization === "Сахалин_Без ЮЛ"));

const prr = selected.filter((row) => row.article === "ПРР внешние");
assert.equal(prr.length, 21, "Expected 21 journal rows for ПРР внешние");
const debitSide = prr
  .filter((row) => row.debit === "44.2")
  .reduce((sum, row) => sum + Number(row.amount), 0);
const creditSide = prr
  .filter((row) => row.credit === "44.2")
  .reduce((sum, row) => sum + Number(row.amount), 0);
assert.equal(debitSide, 144000, "Debit side must be 144000 without mirror double count");
assert.equal(creditSide, 144000, "Credit side must be 144000 without mirror double count");

const excluded = buildUnassignedOperationRow(prr[0], "2025-01");
assert.equal(excluded.row_class, "CANDIDATE_EXCLUDED");
assert.equal(excluded.count_in_parent, false);
assert.equal(excluded.excluded_from_totals, true);
assert.match(excluded.comment, /posting_rows=0/);

if (erpOpiuPath && erpArchivePath) {
  const sha256File = async (filePath) =>
    crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
  const journalSha = await sha256File(journalPath);
  const erpOpiuSha = await sha256File(erpOpiuPath);
  const authoritySha = await sha256File(erpArchivePath);
  const evidence = await loadArbitraryPeriodOperationEvidence({
    organization: "3 Сахалин",
    mode: "month",
    period: "2025-01",
    periods: ["2025-01"],
    allowedJournalOrganizations: sakhalin.journal_organization_aliases,
    operationBearingCodes: sakhalin.operation_bearing_codes,
    includeUnassignedRows: true,
    genericExactArticleBinding: true,
    resolvedRowsByPeriod: [{ period: "2025-01", rows: [] }],
    sourceSets: [{
      period: "2025-01",
      journalPath,
      journalExpectedSha256: journalSha,
      journalOrigin: { inputPath: erpArchivePath, sha256: journalSha },
      erpOpiuPath,
      erpOpiuExpectedSha256: erpOpiuSha,
      erpOpiuOrigin: { inputPath: erpArchivePath, sha256: erpOpiuSha },
      erpInputAuthorityPath: erpArchivePath,
      erpInputAuthoritySha256: authoritySha,
    }],
  });
  assert.equal(evidence.status, "BLOCKED_GENERIC_OPERATION_EVIDENCE_REVIEW_REQUIRED");
  assert.equal(evidence.journal_verified, true);
  assert.equal(evidence.counts.selected_period_rows, 39);
  assert.equal(evidence.counts.unassigned_operation_rows, 39);
  assert.equal(evidence.unassigned_rows.length, 39);
  assert.equal(evidence.exact_bound_operation_rows, 0);
  assert.deepEqual(evidence.exact_bound_r_codes, []);
  sakhalinExactBoundRows = evidence.exact_bound_operation_rows;
  sakhalinExactBoundRCodes = evidence.exact_bound_r_codes;
  assert.ok(evidence.unassigned_rows.every((row) => row.row_class === "CANDIDATE_EXCLUDED"));
  assert.ok(evidence.unassigned_rows.every((row) => row.count_in_parent === false));
  assert.equal(evidence.posting_rows, 0);
  assert.equal(evidence.ready_to_upload, false);
  assert.equal(evidence.release_allowed, false);

  const exactBoundEvidence = await loadArbitraryPeriodOperationEvidence({
    organization: "3 Сахалин",
    mode: "month",
    period: "2025-01",
    periods: ["2025-01"],
    allowedJournalOrganizations: sakhalin.journal_organization_aliases,
    operationBearingCodes: ["R003"],
    includeUnassignedRows: true,
    genericExactArticleBinding: true,
    resolvedRowsByPeriod: [{
      period: "2025-01",
      rows: [{
        code: "R003",
        hierarchy_status: "PASS",
        erp: {
          amount: 144000,
          status: "MATCHED",
          trace: [{
            article: "ПРР внешние",
            month: "2025-01",
            sha256: erpOpiuSha,
            sheet: "Лист_1",
            source_cell: "D10",
            amount: 144000,
            source_tree_proof: { complete: true, status: "LEAF" },
          }],
        },
      }],
    }],
    sourceSets: [{
      period: "2025-01",
      journalPath,
      journalExpectedSha256: journalSha,
      journalOrigin: { inputPath: erpArchivePath, sha256: journalSha },
      erpOpiuPath,
      erpOpiuExpectedSha256: erpOpiuSha,
      erpOpiuOrigin: { inputPath: erpArchivePath, sha256: erpOpiuSha },
      erpInputAuthorityPath: erpArchivePath,
      erpInputAuthoritySha256: authoritySha,
    }],
  });
  assert.equal(exactBoundEvidence.exact_bound_operation_rows, 21);
  syntheticExactBoundRows = exactBoundEvidence.exact_bound_operation_rows;
  assert.deepEqual(exactBoundEvidence.exact_bound_r_codes, ["R003"]);
  assert.equal(exactBoundEvidence.rows.length, 21);
  assert.equal(exactBoundEvidence.unassigned_rows.length, 18);
  assert.ok(exactBoundEvidence.rows.every((row) => row.parent_code === "R003"));
  assert.ok(exactBoundEvidence.rows.every((row) => row.exact_article_bound === true));
  assert.ok(exactBoundEvidence.rows.every((row) => row.count_in_parent === false));
  assert.ok(exactBoundEvidence.rows.every((row) => row.excluded_from_totals === true));
  assert.equal(
    new Set([
      ...exactBoundEvidence.rows.map((row) => row.source_row_id),
      ...exactBoundEvidence.unassigned_rows.map((row) => row.source_row_id),
    ]).size,
    39,
    "Every exact-organization journal row must appear once in either the R-bound or unassigned contour",
  );
  assert.equal(exactBoundEvidence.posting_rows, 0);
  assert.equal(exactBoundEvidence.correction_operation_rows, 0);
  assert.equal(exactBoundEvidence.ready_to_upload, false);
  assert.equal(exactBoundEvidence.release_allowed, false);
}

if (ukCompanionPath) {
  const uk = JSON.parse(await fs.readFile(ukCompanionPath, "utf8"));
  assert.equal(uk.operation_evidence?.display_operation_rows, 320);
  assert.equal(uk.operation_evidence?.source_contributor_rows, 0);
  assert.equal(uk.operation_evidence?.posting_rows, 0);
  assert.equal(uk.operation_evidence?.ready_to_upload, false);
  assert.equal(uk.operation_evidence?.release_allowed, false);
}

console.log(JSON.stringify({
  status: "PASS_SAKHALIN_OPERATION_EVIDENCE_SCOPE",
  journal_rows: journal.rows.length,
  selected_exact_organization_rows: selected.length,
  prr_external_rows: prr.length,
  prr_external_debit_44_2: debitSide,
  prr_external_credit_44_2: creditSide,
  candidate_only: true,
  posting_rows: 0,
  uk_baseline_checked: Boolean(ukCompanionPath),
  generic_source_binding_checked: Boolean(erpOpiuPath && erpArchivePath),
  sakhalin_exact_bound_rows: sakhalinExactBoundRows,
  sakhalin_exact_bound_r_codes: sakhalinExactBoundRCodes,
  exact_binding_fixture_rows: syntheticExactBoundRows,
}, null, 2));
