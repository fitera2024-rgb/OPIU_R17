import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { readOperationJournalRows } from "../../reconciliation/source/full_operation_evidence.mjs";
import {
  LOADER_A_AA_FIELDS,
  REPORT_ONLY_SAFETY,
  createCanonicalPostingRow,
  createMaterializationCase,
} from "./r001_materialization_contract.mjs";
import { buildR001BusinessContent } from "./r001_business_content.mjs";
import { canonicalSpornoRowFromMaterializationCase } from "./r001_canonical_output_contract.mjs";

const MONEY_EPSILON = 0.0000001;

function clean(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function numberValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(clean(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  const amount = numberValue(value);
  return amount === null ? null : Math.round(amount * 100);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function stableId(prefix, values) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex").toUpperCase();
  return `${prefix}-${digest.slice(0, 20)}`;
}

function sourceRowNumber(value) {
  const match = clean(value).match(/(?:^|!)[A-Z]+(\d+):[A-Z]+\1$/i);
  return match ? Number(match[1]) : null;
}

function normalizedDate(value) {
  const match = clean(value).match(/^(\d{2}\.\d{2}\.\d{4})/);
  return match?.[1] ?? clean(value);
}

function periodFromDate(value) {
  const match = normalizedDate(value).match(/^\d{2}\.(\d{2})\.(\d{4})$/);
  return match ? `${match[2]}-${match[1]}` : "";
}

export function economicActionClass(decisionType) {
  const type = clean(decisionType).toUpperCase();
  if (type === "STORNO_REPOST") return "STORNO_REPOST";
  if (["STORNO", "REPOST"].includes(type)) return type;
  if (["DELETE", "DELETE_OPERATION", "DELETE_POSTING"].includes(type)) return "DELETE";
  if (["ONE_SIDE", "ADD_ONE_SIDE"].includes(type)) return "ONE_SIDE";
  return "NO_FINANCIAL_POSTING";
}

export function parseCandidateTrace(value) {
  const text = clean(value);
  const result = {};
  for (const key of ["Period", "ERPExpected", "ArticleOwners", "ExpectedAccounts", "AccountSignature", "SourceRowID", "JournalSHA", "JournalInput", "JournalEntry"]) {
    const match = text.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`, "i"));
    result[key] = clean(match?.[1]);
  }
  result.articleOwners = result.ArticleOwners.split(/[,|]/).map(clean).filter(Boolean);
  return result;
}

function searchFixedDepth(rows, target, depth, limit) {
  const results = [];
  const selected = [];
  const amounts = rows.map((row) => Math.abs(cents(row.amount) ?? 0));
  const suffix = new Array(rows.length + 1).fill(0);
  for (let index = rows.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + amounts[index];

  function visit(start, remainingDepth, sum) {
    if (results.length >= limit) return;
    if (remainingDepth === 0) {
      if (sum === target) results.push(selected.map((index) => rows[index]));
      return;
    }
    if (rows.length - start < remainingDepth || sum > target || sum + suffix[start] < target) return;
    for (let index = start; index <= rows.length - remainingDepth; index += 1) {
      const next = sum + amounts[index];
      if (next > target) continue;
      selected.push(index);
      visit(index + 1, remainingDepth - 1, next);
      selected.pop();
      if (results.length >= limit) return;
    }
  }
  visit(0, depth, 0);
  return results;
}

/**
 * Deterministic exact-cents selector.  It searches sign-homogeneous source
 * sets and prefers the smallest row count, then lexicographic source range.
 * A second solution is retained only to mark the choice as disputed.
 */
export function selectExactSourceSubset(candidateRows, targetAmount, options = {}) {
  const target = Math.abs(cents(targetAmount) ?? 0);
  if (!target) return { rows: [], solution_count: 0, unique: false, sign: 0 };
  const normalized = candidateRows
    .map((row) => ({ ...row, amount: numberValue(row.amount), source_ref: clean(row.source_ref) }))
    .filter((row) => row.amount !== null && Math.abs(row.amount) > MONEY_EPSILON && Math.abs(cents(row.amount)) <= target)
    .sort((left, right) => left.source_ref.localeCompare(right.source_ref, "en"));
  const pools = [1, -1].map((sign) => ({ sign, rows: normalized.filter((row) => Math.sign(row.amount) === sign) }));
  const solutions = [];
  const maxDepth = Math.min(Number(options.maxDepth ?? 12), normalized.length);
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    for (const pool of pools) {
      if (pool.rows.length < depth) continue;
      for (const rows of searchFixedDepth(pool.rows, target, depth, 2)) {
        solutions.push({ rows, sign: pool.sign });
        if (solutions.length >= 2) break;
      }
      if (solutions.length >= 2) break;
    }
    if (solutions.length) break;
  }
  return {
    rows: solutions[0]?.rows ?? [],
    solution_count: solutions.length,
    unique: solutions.length === 1,
    sign: solutions[0]?.sign ?? 0,
  };
}

function targetLabel(treeRows, code) {
  const summaryLabels = [...new Set(treeRows
    .filter((row) => clean(row["Код / PairID"]) === code)
    .map((row) => clean(row["Строка ОПИУ / операция"]))
    .filter(Boolean))];
  if (summaryLabels.length === 1) return summaryLabels[0];
  const matches = treeRows.filter((row) => parseCandidateTrace(row["Комментарий / доказательство"]).articleOwners.includes(code));
  const labels = [...new Set(matches.map((row) => clean(row["Строка ОПИУ / операция"])).filter(Boolean))];
  return labels.length === 1 ? labels[0] : "";
}

function candidateRowsForCode(treeRows, code, period) {
  return treeRows.flatMap((row) => {
    const trace = parseCandidateTrace(row["Комментарий / доказательство"]);
    const amount = numberValue(row["Физическая сумма"]);
    const debit = clean(row["Дт"]);
    const credit = clean(row["Кт"]);
    if (!trace.articleOwners.includes(code) || trace.Period !== period || periodFromDate(row["Дата"]) !== period) return [];
    if (amount === null || Math.abs(amount) < MONEY_EPSILON || !clean(row["Организация"])) return [];
    if (debit === "99" || credit === "99" || debit.startsWith("99.") || credit.startsWith("99.")) return [];
    const physicalRow = sourceRowNumber(row["ERP строка"]);
    if (!physicalRow || !trace.SourceRowID || !trace.JournalSHA || !trace.JournalInput || !trace.JournalEntry) return [];
    return [{
      amount,
      source_ref: clean(row["ERP строка"]),
      physical_row: physicalRow,
      tree: row,
      trace,
    }];
  });
}

async function loadJournal(candidate, cache) {
  const key = `${candidate.trace.JournalInput}\u0000${candidate.trace.JournalEntry}`;
  if (cache.has(key)) return cache.get(key);
  const archivePath = path.resolve(candidate.trace.JournalInput);
  const archiveBuffer = await fs.readFile(archivePath);
  const archiveSha256 = sha256Buffer(archiveBuffer);
  let journalBuffer;
  if (/\.xlsx$/i.test(archivePath)) journalBuffer = archiveBuffer;
  else {
    const zip = await JSZip.loadAsync(archiveBuffer);
    const entry = zip.file(candidate.trace.JournalEntry);
    if (!entry) throw new Error(`ERP journal entry not found: ${candidate.trace.JournalEntry}`);
    journalBuffer = await entry.async("nodebuffer");
  }
  const actualJournalSha = sha256Buffer(journalBuffer);
  if (actualJournalSha !== candidate.trace.JournalSHA.toUpperCase()) {
    throw new Error(`ERP journal SHA mismatch: expected ${candidate.trace.JournalSHA}, got ${actualJournalSha}`);
  }
  const journal = await readOperationJournalRows({ journalBuffer, sheet: "Лист_1", journalSourceLabel: candidate.trace.JournalEntry });
  const loaded = {
    archive_path: archivePath,
    archive_sha256: archiveSha256,
    journal_entry: candidate.trace.JournalEntry,
    journal_sha256: actualJournalSha,
    journal_sheet: journal.journal_sheet,
    byPhysicalRow: new Map(journal.rows.map((row) => [row.physical_row, row])),
  };
  cache.set(key, loaded);
  return loaded;
}

function exactTreeVerification(candidate, raw) {
  const mismatches = [];
  const comparisons = [
    ["source row id", candidate.trace.SourceRowID.toUpperCase(), clean(raw.source_row_id).toUpperCase()],
    ["source range", candidate.source_ref, raw.source_range],
    ["period", candidate.trace.Period, raw.period],
    ["date", normalizedDate(candidate.tree["Дата"]), normalizedDate(raw.date)],
    ["document", clean(candidate.tree["Регистратор / документ"]), clean(raw.document)],
    ["posting", String(candidate.tree["№ проводки"] ?? ""), String(raw.posting_no ?? "")],
    ["debit", clean(candidate.tree["Дт"]), clean(raw.debit)],
    ["credit", clean(candidate.tree["Кт"]), clean(raw.credit)],
    ["organization", clean(candidate.tree["Организация"]), clean(raw.organization)],
    ["amount cents", String(cents(candidate.amount)), String(cents(raw.amount))],
    ["activity", "Да", clean(raw.activity)],
    ["scenario", "Факт", clean(raw.scenario)],
  ];
  for (const [field, expected, actual] of comparisons) if (expected !== actual) mismatches.push(`${field}: ${expected} != ${actual}`);
  return mismatches;
}

function classificationSlot(raw, sourceLabel) {
  const values = [
    ["СубконтоДт1", "debit_analytics_1"], ["СубконтоДт2", "debit_analytics_2"], ["СубконтоДт3", "debit_analytics_3"],
    ["СубконтоКт1", "credit_analytics_1"], ["СубконтоКт2", "credit_analytics_2"], ["СубконтоКт3", "credit_analytics_3"],
  ];
  const exact = values.filter(([, key]) => clean(raw[key]) === clean(sourceLabel));
  return exact.length === 1 ? exact[0] : null;
}

function scaled(value, ratio, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const power = 10 ** digits;
  return Math.round(Number(value) * ratio * power) / power;
}

function sourceLoaderValues(raw) {
  return [
    raw.debit, raw.credit, raw.debit_currency, raw.credit_currency, raw.operation_kind,
    raw.debit_department, raw.credit_department, raw.debit_direction, raw.credit_direction,
    raw.amount_accounting, raw.amount, raw.debit_currency_amount, raw.credit_currency_amount,
    raw.debit_quantity, raw.credit_quantity, raw.content, raw.debit, raw.credit, raw.source_row_id,
    null, null, raw.debit_analytics_1, raw.debit_analytics_2, raw.debit_analytics_3,
    raw.credit_analytics_1, raw.credit_analytics_2, raw.credit_analytics_3,
  ];
}

function canonicalReadyPhysicalComplete(raw, source) {
  return [
    raw.organization, source.archive_path, source.archive_sha256, source.journal_entry,
    source.journal_sha256, source.journal_sheet, raw.source_range, raw.source_row_id,
    raw.date, raw.document, raw.posting_no, raw.debit, raw.credit,
    raw.debit_department, raw.credit_department,
    raw.debit_analytics_1, raw.debit_analytics_2, raw.debit_analytics_3,
    raw.credit_analytics_1, raw.credit_analytics_2, raw.credit_analytics_3,
  ].every((value) => clean(value)) && numberValue(raw.amount) !== null;
}

export function materializeExactSourceRow({ raw, operation, partCents, sourceCode, sourceLabel, targetCode, targetLabel: newTargetLabel, decision, reconciliationOrganization, source, subset, outputRoute = "SPORNO" }) {
  const sourceCents = cents(raw.amount);
  const isStorno = operation === "STORNO";
  const signedPartCents = isStorno ? -Math.abs(sourceCents ?? partCents ?? 0) : Math.abs(partCents ?? 0);
  const ratio = sourceCents === 0 ? 1 : signedPartCents / sourceCents;
  const debitAnalytics = [raw.debit_analytics_1, raw.debit_analytics_2, raw.debit_analytics_3];
  const creditAnalytics = [raw.credit_analytics_1, raw.credit_analytics_2, raw.credit_analytics_3];
  const slot = isStorno ? null : (clean(sourceLabel) ? classificationSlot(raw, sourceLabel) : null);
  if (!isStorno && !slot) throw new Error(`Declared source classification '${sourceLabel}' is not an exact source subkonto at ${raw.source_range}`);
  if (slot?.[1].startsWith("debit_")) debitAnalytics[Number(slot[1].at(-1)) - 1] = newTargetLabel;
  if (slot?.[1].startsWith("credit_")) creditAnalytics[Number(slot[1].at(-1)) - 1] = newTargetLabel;
  const materializationId = stableId("MAT-R001", [decision.case_id, decision.pair_id, operation, raw.source_row_id, targetCode, signedPartCents]);
  const normalizedOutputRoute = clean(outputRoute).toUpperCase();
  const status = normalizedOutputRoute === "READY" ? "ГОТОВО" : "_СПОРНО";
  const baseContent = buildR001BusinessContent({
    operation,
    erp: {
      document: raw.document,
      date: raw.date,
      postingNumber: raw.posting_no,
      debit: raw.debit,
      credit: raw.credit,
      amount: Math.abs(signedPartCents) / 100,
      organization: raw.organization,
      debitDepartment: raw.debit_department,
      creditDepartment: raw.credit_department,
    },
    economic: {
      sourceArticle: sourceLabel,
      targetArticle: isStorno ? sourceLabel : newTargetLabel,
    },
    decision,
    caseId: decision.case_id,
    pairId: decision.pair_id,
    sourceRowId: raw.source_row_id,
  });
  const content = clean(decision.reason)
    ? baseContent.replace(" | REPORT_ONLY", ` | Причина: ${clean(decision.reason)} | REPORT_ONLY`)
    : baseContent;
  const row = [
    raw.debit, raw.credit, raw.debit_currency, raw.credit_currency, operation,
    raw.debit_department, raw.credit_department, raw.debit_direction, raw.credit_direction,
    scaled(raw.amount_accounting, ratio), signedPartCents / 100,
    scaled(raw.debit_currency_amount, ratio), scaled(raw.credit_currency_amount, ratio),
    scaled(raw.debit_quantity, ratio, 6), scaled(raw.credit_quantity, ratio, 6),
    content, raw.debit, raw.credit, raw.source_row_id, null, null,
    ...debitAnalytics, ...creditAnalytics,
  ];
  const oldValues = sourceLoaderValues(raw);
  const changedFields = [];
  for (let index = 0; index < row.length; index += 1) {
    if (JSON.stringify(row[index]) !== JSON.stringify(oldValues[index])) changedFields.push(index);
  }
  Object.defineProperty(row, "audit", {
    enumerable: false,
    value: {
      materializationId,
      caseId: clean(decision.case_id),
      pairId: clean(decision.pair_id),
      actionClass: "STORNO_REPOST",
      operation,
      status,
      outputRoute: normalizedOutputRoute,
      materializationState: normalizedOutputRoute === "READY" ? "MATERIALIZED_READY" : "MATERIALIZED_SPORNO",
      period: clean(decision.period),
      reconciliationOrganization: clean(reconciliationOrganization),
      sourceOrganization: raw.organization,
      sourceArchivePath: source.archive_path,
      sourceArchiveSha256: source.archive_sha256,
      sourceJournalEntry: source.journal_entry,
      sourceJournalSha256: source.journal_sha256,
      sourceSheet: source.journal_sheet,
      sourceRange: raw.source_range,
      sourceRowId: raw.source_row_id,
      sourceDate: raw.date,
      registrar: raw.document,
      postingNumber: raw.posting_no,
      sourceCode,
      targetCode: targetCode || sourceCode,
      sourceLabel,
      targetLabel: newTargetLabel || sourceLabel,
      sourceArticleMissing: decision?.source_article_missing === true,
      targetSubkontoSlot: slot?.[1] ?? "",
      amount: signedPartCents / 100,
      sourceAmount: raw.amount,
      proofStatus: clean(decision.proof_status) || clean(decision.evidence_state) || "UNPROVEN",
      reason: clean(decision.reason),
      subsetUnique: subset.unique,
      subsetSolutionCount: subset.solution_count,
      classificationField: slot?.[0] ?? "",
      changedFields,
      oldValues,
      newValues: [...row],
      executionAllowed: false,
      live1cAllowed: false,
    },
  });
  if (decision?.materialization_case?.schema_version === "opiu-materialization-case.v1") {
    const resultAccounting = {
      debit: clean(row[0]),
      credit: clean(row[1]),
      debit_department: clean(row[5]),
      credit_department: clean(row[6]),
      debit_analytics: row.slice(21, 24).map(clean),
      credit_analytics: row.slice(24, 27).map(clean),
      article: operation === "REPOST" ? clean(newTargetLabel) : clean(sourceLabel),
    };
    const physicalSource = {
      source_organization: clean(raw.organization),
      source_archive_path: clean(source.archive_path),
      source_archive_sha256: clean(source.archive_sha256),
      journal_entry: clean(source.journal_entry),
      journal_sha256: clean(source.journal_sha256),
      source_sheet: clean(source.journal_sheet),
      source_range: clean(raw.source_range),
      source_row_id: clean(raw.source_row_id),
      date: clean(raw.date),
      document: clean(raw.document),
      posting_number: clean(raw.posting_no),
      debit: clean(raw.debit),
      credit: clean(raw.credit),
      debit_analytics: [raw.debit_analytics_1, raw.debit_analytics_2, raw.debit_analytics_3].map(clean),
      credit_analytics: [raw.credit_analytics_1, raw.credit_analytics_2, raw.credit_analytics_3].map(clean),
      debit_department: clean(raw.debit_department),
      credit_department: clean(raw.credit_department),
      amount: Number(raw.amount),
      activity: clean(raw.activity),
      scenario: clean(raw.scenario),
    };
    const amount = Math.abs(signedPartCents) / 100;
    const materializationCase = createMaterializationCase({
      ...decision.materialization_case,
      action: operation,
      output_route: normalizedOutputRoute,
      signed_economic_effect: operation === "STORNO" ? -amount : amount,
      correction_amount: amount,
      economic: {
        ...decision.materialization_case.economic,
        source_code: clean(sourceCode),
        target_code: clean(targetCode || sourceCode),
        source_article: clean(sourceLabel),
        target_article: clean(newTargetLabel || sourceLabel),
      },
      physical_source: physicalSource,
      target_accounting: resultAccounting,
      physical_proof: {
        source_operation_proven: true,
        physical_source_unique: subset.unique === true,
        target_classification_proven: isStorno || Boolean(slot),
        pinned_source_reopened: true,
        source_reuse_checked: true,
      },
      business_evidence: {
        ...decision.materialization_case.business_evidence,
        intalev_references: decision.intalev_references
          ?? decision.materialization_case.business_evidence?.intalev_references,
        intalev_technical_reference: decision.intalev_technical_reference,
      },
      safety: REPORT_ONLY_SAFETY,
    });
    const loader = Object.fromEntries(LOADER_A_AA_FIELDS.map((field, index) => [field, row[index]]));
    const canonicalPostingRow = createCanonicalPostingRow({
      materialization_case: materializationCase,
      operation,
      output_route: normalizedOutputRoute,
      materialization_state: normalizedOutputRoute === "READY" ? "MATERIALIZED_READY" : "MATERIALIZED_SPORNO",
      audit_identity: materializationId,
      amount,
      result_accounting: resultAccounting,
      loader,
      safety: REPORT_ONLY_SAFETY,
    });
    Object.defineProperty(row, "canonical_posting_row", {
      enumerable: false,
      value: canonicalPostingRow,
    });
  }
  return row;
}

function addGroupRow(groups, row, disputed) {
  const audit = row.audit;
  const organization = clean(audit.sourceOrganization);
  const period = clean(audit.period);
  if (!organization) throw new Error(`Source organization is empty for ${audit.sourceRange}`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`Source period is invalid for ${audit.sourceRange}`);
  const key = `${disputed ? "SPORNO" : "READY"}\u0000${organization}\u0000${period}`;
  if (!groups.has(key)) groups.set(key, { organization, period, disputed, uploadRows: [] });
  groups.get(key).uploadRows.push(row);
}

export async function materializeOwnerEconomicDrafts({ decisions = [], treeRows = [], period = "", reconciliationOrganization = "" } = {}) {
  const groups = new Map();
  const rows = [];
  const blockers = [];
  const caseResults = [];
  const journalCache = new Map();
  const byCase = new Map();
  for (const decision of decisions) {
    if (!byCase.has(clean(decision.case_id))) byCase.set(clean(decision.case_id), []);
    byCase.get(clean(decision.case_id)).push(decision);
  }

  for (const [caseId, members] of byCase) {
    const actionClass = economicActionClass(members[0]?.decision_type);
    if (["STORNO", "REPOST"].includes(actionClass)) {
      const decision = members[0];
      caseResults.push({
        case_id: caseId,
        pair_id: clean(decision?.pair_id),
        action_class: actionClass,
        materialization_state: "BLOCKED_REVIEW",
        posting_rows: 0,
        storno_rows: 0,
        repost_rows: 0,
        source_organizations: [clean(decision?.source_organization)].filter(Boolean),
        execution_allowed: false,
        live_1c_allowed: false,
        blockers: [
          "ONE_SIDED_OWNER_DRAFT_REQUIRES_EXACT_PHYSICAL_MATERIALIZER",
          "NO_ERP_SOURCE_ROW_FABRICATION",
        ],
      });
      continue;
    }
    if (actionClass !== "STORNO_REPOST") {
      caseResults.push({
        case_id: caseId,
        pair_id: clean(members[0]?.pair_id),
        action_class: actionClass,
        materialization_state: "NO_FINANCIAL_POSTING",
        posting_rows: 0,
        storno_rows: 0,
        repost_rows: 0,
        source_organizations: [],
        execution_allowed: false,
        live_1c_allowed: false,
      });
      continue;
    }
    const sourceDecision = members.find((item) => clean(item.role).toUpperCase() === "RECLASS_SOURCE");
    const targetDecisions = members.filter((item) => clean(item.role).toUpperCase() === "RECLASS_TARGET");
    const sourceCode = clean(sourceDecision?.reconciliation_row);
    const casePeriod = clean(sourceDecision?.period || members[0]?.period || period);
    const sourceLabel = targetLabel(treeRows, sourceCode);
    const targets = targetDecisions.map((decision) => ({
      decision,
      code: clean(decision.reconciliation_row),
      label: targetLabel(treeRows, clean(decision.reconciliation_row)),
      cents: Math.abs(cents(decision.analytical_effect ?? decision.correction_amount) ?? 0),
    })).filter((item) => item.cents > 0);
    const targetAmountCents = Math.abs(cents(sourceDecision?.correction_amount ?? sourceDecision?.source_amount) ?? 0);
    const caseBlockers = [];
    if (!sourceDecision || !sourceCode || !sourceLabel) caseBlockers.push("Source decision/code/classification label is not exact");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(casePeriod)) caseBlockers.push("Economic case period must be one concrete month");
    if (!targets.length || targets.some((item) => !item.label)) caseBlockers.push("Target decision/code/classification label is not exact");
    if (targets.reduce((sum, item) => sum + item.cents, 0) !== targetAmountCents) caseBlockers.push("Target quotas do not equal the source correction amount in exact cents");
    const candidates = candidateRowsForCode(treeRows, sourceCode, casePeriod);
    const subset = selectExactSourceSubset(candidates, targetAmountCents / 100);
    if (!subset.rows.length) caseBlockers.push(`No exact-cent, sign-homogeneous ERP subset for ${sourceCode}/${targetAmountCents}`);

    const exactSources = [];
    if (!caseBlockers.length) {
      for (const candidate of subset.rows) {
        try {
          const source = await loadJournal(candidate, journalCache);
          const raw = source.byPhysicalRow.get(candidate.physical_row);
          if (!raw) throw new Error(`Physical row ${candidate.physical_row} is absent from the exact ERP journal`);
          const mismatches = exactTreeVerification(candidate, raw);
          if (mismatches.length) throw new Error(`Tree/journal mismatch at ${candidate.source_ref}: ${mismatches.join("; ")}`);
          exactSources.push({ candidate, source, raw });
        } catch (error) {
          caseBlockers.push(error.message);
        }
      }
    }
    if (!caseBlockers.length) {
      const disputed = members.some((item) => clean(item.proof_status).toUpperCase() !== "PROVEN")
        || !subset.unique
        || exactSources.some((item) => !canonicalReadyPhysicalComplete(item.raw, item.source));
      for (const item of exactSources) {
        const row = materializeExactSourceRow({
          raw: item.raw, operation: "STORNO", partCents: Math.abs(cents(item.raw.amount)),
          sourceCode, sourceLabel, targetCode: sourceCode, targetLabel: sourceLabel,
          decision: sourceDecision, reconciliationOrganization, source: item.source, subset,
          outputRoute: disputed ? "SPORNO" : "READY",
        });
        rows.push(row);
        addGroupRow(groups, row, disputed);
      }
      const remainingTargets = targets.map((item) => ({ ...item }));
      for (const item of exactSources) {
        let sourceRemaining = Math.abs(cents(item.raw.amount));
        while (sourceRemaining > 0) {
          const target = remainingTargets.find((candidate) => candidate.cents > 0);
          if (!target) {
            caseBlockers.push(`Allocation exhausted before source row ${item.raw.source_range}`);
            break;
          }
          const part = Math.min(sourceRemaining, target.cents);
          const row = materializeExactSourceRow({
            raw: item.raw, operation: "REPOST", partCents: part,
          sourceCode, sourceLabel, targetCode: target.code, targetLabel: target.label,
            decision: target.decision, reconciliationOrganization, source: item.source, subset,
            outputRoute: disputed ? "SPORNO" : "READY",
          });
          rows.push(row);
          addGroupRow(groups, row, disputed);
          sourceRemaining -= part;
          target.cents -= part;
        }
      }
      if (remainingTargets.some((target) => target.cents !== 0)) caseBlockers.push("Target quota remains after deterministic allocation");
    }
    blockers.push(...caseBlockers.map((message) => `${caseId}: ${message}`));
    const caseRows = rows.filter((row) => row.audit.caseId === caseId);
    caseResults.push({
      case_id: caseId,
      period: casePeriod,
      pair_id: clean(members[0]?.pair_id),
      action_class: actionClass,
      materialization_state: caseRows.length ? (caseRows.some((row) => row.audit.status === "_СПОРНО") ? "_СПОРНО" : "ГОТОВО") : "BLOCKED_REVIEW",
      posting_rows: caseRows.length,
      storno_rows: caseRows.filter((row) => row.audit.operation === "STORNO").length,
      repost_rows: caseRows.filter((row) => row.audit.operation === "REPOST").length,
      source_organizations: [...new Set(caseRows.map((row) => row.audit.sourceOrganization))],
      source_rows: [...new Set(caseRows.map((row) => row.audit.sourceRange))],
      source_subset_unique: subset.unique,
      blockers: caseBlockers,
    });
  }

  return {
    groups,
    rows,
    canonical_posting_rows: rows.map((row) => row.canonical_posting_row).filter(Boolean),
    blockers,
    cases: caseResults,
    posting_rows: rows.length,
    materialized_posting_rows: rows.length,
    storno_rows: rows.filter((row) => row.audit.operation === "STORNO").length,
    repost_rows: rows.filter((row) => row.audit.operation === "REPOST").length,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    execution_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
  };
}

/**
 * Materializes an owner-approved balanced economic route when the exact
 * physical ERP source is still unknown.  These are deliberately sparse
 * _СПОРНО rows: direction, amount, economic articles and evidence are kept;
 * accounts, organization, registrar and SourceRowID remain blank.
 */
export function materializeSparseEconomicDrafts({
  decisions = [],
  reconciliationOrganization = "",
  excludeCaseIds = [],
} = {}) {
  const excluded = new Set([...excludeCaseIds].map(clean).filter(Boolean));
  const byCase = new Map();
  for (const decision of decisions) {
    const caseId = clean(decision?.case_id);
    if (!caseId || !clean(decision?.embedded_decision_identity)) continue;
    if (!byCase.has(caseId)) byCase.set(caseId, []);
    byCase.get(caseId).push(decision);
  }
  const canonicalPostingRows = [];
  const cases = [];
  const blockers = [];
  for (const [caseId, members] of byCase) {
    if (excluded.has(caseId)) continue;
    const sources = members.filter((item) => clean(item?.role).toUpperCase() === "RECLASS_SOURCE");
    const targets = members.filter((item) => clean(item?.role).toUpperCase() === "RECLASS_TARGET");
    const financialMembers = [...sources, ...targets];
    const eligible = financialMembers.filter((item) =>
      item?.accepted_economic_reclass === true
      && item?.ECONOMIC_ROUTE_PROVEN === true
      && clean(item?.output_route).toUpperCase() === "SPORNO"
      && clean(item?.proof_status).toUpperCase() === "ECONOMIC_RECLASS_PROVEN");
    const sourceCents = sources.reduce((sum, item) => sum + (cents(item?.analytical_effect ?? item?.effective_delta) ?? 0), 0);
    const targetCents = targets.reduce((sum, item) => sum + (cents(item?.analytical_effect ?? item?.effective_delta) ?? 0), 0);
    const balanced = sources.length > 0 && targets.length > 0
      && eligible.length === financialMembers.length
      && sources.every((item) => (cents(item?.analytical_effect ?? item?.effective_delta) ?? 0) < 0)
      && targets.every((item) => (cents(item?.analytical_effect ?? item?.effective_delta) ?? 0) > 0)
      && sourceCents + targetCents === 0;
    if (!balanced) continue;
    const pairId = clean(members[0]?.pair_id || caseId);
    const period = clean(members[0]?.period);
    const sourceCodes = [...new Set(sources.map((item) => clean(item?.reconciliation_row)).filter(Boolean))];
    const targetCodes = [...new Set(targets.map((item) => clean(item?.reconciliation_row)).filter(Boolean))];
    const sourceArticles = [...new Set(sources.map((item) => clean(item?.source_article || item?.group)).filter(Boolean))];
    const targetArticles = [...new Set(targets.map((item) => clean(item?.target_article || item?.group)).filter(Boolean))];
    const caseRows = [];
    try {
      for (const member of [...sources, ...targets]) {
        const role = clean(member.role).toUpperCase();
        const action = role === "RECLASS_SOURCE" ? "STORNO" : "REPOST";
        const effect = (cents(member?.analytical_effect ?? member?.effective_delta) ?? 0) / 100;
        const amountValue = Math.abs(effect);
        const materializationCase = createMaterializationCase({
          case_id: caseId,
          pair_id: pairId,
          period,
          reconciliation_organization: clean(member?.reconciliation_organization || reconciliationOrganization || member?.organization),
          action,
          role,
          signed_economic_effect: effect,
          correction_amount: amountValue,
          economic: {
            source_code: sourceCodes.join("; "),
            target_code: targetCodes.join("; "),
            source_article: sourceArticles.join("; "),
            target_article: targetArticles.join("; "),
          },
          proof_status: "ECONOMIC_RECLASS_PROVEN",
          correction_allowed: false,
          correction_authority: "OWNER_APPROVED_ECONOMIC_ROUTE_PHYSICAL_PENDING",
          output_route: "SPORNO",
          physical_source: {
            source_organization: "",
            source_archive_path: "",
            source_archive_sha256: "",
            journal_entry: "",
            journal_sha256: "",
            source_sheet: "",
            source_range: "",
            source_row_id: "",
            date: "",
            document: "",
            posting_number: "",
            debit: "",
            credit: "",
            debit_analytics: ["", "", ""],
            credit_analytics: ["", "", ""],
            debit_department: "",
            credit_department: "",
            amount: null,
          },
          target_accounting: {
            debit: "",
            credit: "",
            debit_analytics: ["", "", ""],
            credit_analytics: ["", "", ""],
            debit_department: "",
            credit_department: "",
            article: action === "STORNO" ? sourceArticles.join("; ") : targetArticles.join("; "),
          },
          analytical_basis: {
            reconciliation_row: clean(member?.reconciliation_row),
            analytical_basis_id: clean(member?.analytical_basis_id || member?.reconciliation_row),
            transformation_id: caseId,
            effective_delta: effect,
          },
          economic_route: {
            route_id: clean(member?.economic_route_id || caseId),
            proof_status: "ECONOMIC_RECLASS_PROVEN",
            accepted: true,
            accepted_amount: amountValue,
            accepted_effect: effect,
            processing_stage: clean(member?.processing_stage || "INTERGROUP_ROOTS_FIRST"),
            stage_order: Number(member?.stage_order ?? 1),
          },
          source_scope: {},
          reason: clean(member?.reason) || `Доказанный экономический маршрут ${sourceCodes.join(", ")} → ${targetCodes.join(", ")}; физический источник не закреплён`,
          blockers: ["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY", "UNKNOWN_PHYSICAL_FIELDS_LEFT_BLANK"],
          provenance: { source: "EMBEDDED_RECONCILIATION_ECONOMIC_ROUTE" },
          safety: REPORT_ONLY_SAFETY,
        });
        caseRows.push(canonicalSpornoRowFromMaterializationCase(materializationCase));
      }
      canonicalPostingRows.push(...caseRows);
      cases.push(Object.freeze({
        case_id: caseId,
        pair_id: pairId,
        materialization_state: "_СПОРНО",
        posting_rows: caseRows.length,
        storno_rows: caseRows.filter((row) => row.operation === "STORNO").length,
        repost_rows: caseRows.filter((row) => row.operation === "REPOST").length,
        source_organizations: Object.freeze([]),
        blockers: Object.freeze(["PHYSICAL_SOURCE_INCOMPLETE_FOR_READY", "UNKNOWN_PHYSICAL_FIELDS_LEFT_BLANK"]),
      }));
    } catch (error) {
      blockers.push(`${caseId}: ${clean(error?.code || error?.message || "SPARSE_ECONOMIC_ROUTE_FAILED")}`);
    }
  }
  return Object.freeze({
    canonical_posting_rows: Object.freeze(canonicalPostingRows),
    cases: Object.freeze(cases),
    blockers: Object.freeze(blockers),
    audit: Object.freeze({
      materialized_case_count: cases.length,
      canonical_posting_row_count: canonicalPostingRows.length,
      storno_row_count: canonicalPostingRows.filter((row) => row.operation === "STORNO").length,
      repost_row_count: canonicalPostingRows.filter((row) => row.operation === "REPOST").length,
    }),
  });
}
