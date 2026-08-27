import crypto from "node:crypto";
import fs from "node:fs/promises";
import JSZip from "jszip";
import { readOperationJournalRows } from "../../reconciliation/source/full_operation_evidence.mjs";

export const HIERARCHY_AUTHORITY_SCHEMA = "opiu-r001-hierarchy-authority.v1";

function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[«»“”„"]/g, "");
}

function amount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(text(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(value) {
  const numeric = amount(value);
  return numeric === null ? null : Math.round(numeric * 100);
}

function levelOf(row) {
  return Number((text(row?.["Уровень"]).match(/^\d+/) ?? [99])[0]);
}

function structuralCode(row) {
  const code = text(row?.["Код / PairID"]);
  return /^R\d+$/i.test(code) ? code.toUpperCase() : "";
}

function physicalRow(row) {
  return /(SOURCE|CANDIDATE|ОПЕРАЦ)/i.test(text(row?.["Тип строки"]));
}

function first(row, labels) {
  for (const label of labels) if (text(row?.[label])) return row[label];
  return null;
}

function traceField(comment, field) {
  const match = text(comment).match(new RegExp(`(?:^|;\\s*)${field}=([^;]+)`, "i"));
  return text(match?.[1]);
}

function traceAccounts(comment) {
  return traceField(comment, "ExpectedAccounts")
    .split(/[,|]/)
    .map(text)
    .filter(Boolean);
}

function canonicalAccount(value) {
  const match = text(value).match(/(?:^|\s)(\d{2}(?:\.\d+)*)(?:\s|$)/);
  return match ? match[1].split(".").map((part, index) => index === 0 ? part : String(Number(part))).join(".") : "";
}

function accountMatches(expected, actual) {
  const left = canonicalAccount(expected);
  const right = canonicalAccount(actual);
  return Boolean(left && right && (left === right || right.startsWith(`${left}.`)));
}

function analyticsSlots(value) {
  const parts = text(value).split(/\s*\|\s*/).map(text).filter(Boolean).slice(0, 3);
  return [0, 1, 2].map((index) => parts[index] ?? "");
}

function stableId(prefix, payload) {
  return `${prefix}-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24).toUpperCase()}`;
}

const OVERLAPPING_AUTHORITY_REVIEW_LABELS = Object.freeze([
  "UNPROVEN",
  "_СПОРНО",
  "REVIEW_ONLY",
  "NO_POSTING",
  "NOT_RELEASE_AUTHORITY",
]);

function hierarchyEconomicBasis(decision) {
  return [
    text(decision?.period),
    normalized(decision?.reconciliation_organization || decision?.organization),
    text(decision?.analytical_basis_id || decision?.reconciliation_row).toUpperCase(),
    normalized(decision?.intalev_path),
    normalized(decision?.target_article),
  ].join("\u0000");
}

function provenNonOverlappingPartition(decisions) {
  const atoms = decisions.map((decision) => text(decision?.residual_atom_id)).filter(Boolean);
  return atoms.length === decisions.length
    && new Set(atoms).size === atoms.length
    && decisions.every((decision) => [
      decision?.allocation_status,
      decision?.residual_allocation_status,
    ].some((value) => text(value).toUpperCase() === "PROVEN_ALLOCATION"));
}

/**
 * Exact-amount and paired-liability discovery are independent physical proof
 * paths. When both paths close the same analytical residual, neither path is
 * economic authority unless a non-overlapping residual partition is explicit.
 * Both physical traces remain available for review, while financial authority
 * remains fail-closed so a single residual cannot be materialized twice.
 */
function arbitrateOverlappingHierarchyAuthority(decisions) {
  const byBasis = new Map();
  for (const decision of decisions) {
    if (!["HIERARCHY_EXACT_SOURCE", "HIERARCHY_PAIRED_LIABILITY_RECLASS"].includes(text(decision?.role))) continue;
    const key = hierarchyEconomicBasis(decision);
    if (!byBasis.has(key)) byBasis.set(key, []);
    byBasis.get(key).push(decision);
  }
  const suppressed = new Map();
  let overlapCases = 0;
  for (const [basis, candidates] of byBasis) {
    const exact = candidates.filter((decision) => text(decision?.role) === "HIERARCHY_EXACT_SOURCE");
    const paired = candidates.filter((decision) => text(decision?.role) === "HIERARCHY_PAIRED_LIABILITY_RECLASS");
    if (!exact.length || !paired.length || provenNonOverlappingPartition(candidates)) continue;
    const exactSourceRowIds = new Set(exact.map((decision) => text(decision?.source_row_id).toUpperCase()).filter(Boolean));
    const sharedPhysicalLiability = paired.some((decision) =>
      exactSourceRowIds.has(text(decision?.paired_liability_source_row_id).toUpperCase()));
    if (!sharedPhysicalLiability) continue;
    const exactCents = exact.reduce((sum, decision) => sum + Math.abs(cents(decision?.correction_amount) ?? 0), 0);
    const pairedCents = paired.reduce((sum, decision) => sum + Math.abs(cents(decision?.correction_amount) ?? 0), 0);
    if (!exactCents || exactCents !== pairedCents) continue;
    overlapCases += 1;
    const arbitrationId = stableId("HIERARCHY-AUTHORITY-OVERLAP", [basis, exactCents]);
    for (const decision of candidates) {
      suppressed.set(decision, Object.freeze({
        ...decision,
        approval_state: "_СПОРНО",
        proof_status: "UNPROVEN_OVERLAPPING_HIERARCHY_AUTHORITY",
        classification: "REVIEW_ONLY_OVERLAPPING_HIERARCHY_AUTHORITY",
        correction_allowed: false,
        accepted_economic_reclass: false,
        ECONOMIC_ROUTE_PROVEN: false,
        ECONOMIC_CORRECTION_PROVEN: false,
        financial_materialization_forbidden: true,
        labels: OVERLAPPING_AUTHORITY_REVIEW_LABELS,
        hierarchy_authority_arbitration_id: arbitrationId,
        hierarchy_authority_arbitration_status: "OVERLAPPING_PHYSICAL_PROOFS_REVIEW_ONLY",
        hierarchy_authority_competing_roles: Object.freeze([
          "HIERARCHY_EXACT_SOURCE",
          "HIERARCHY_PAIRED_LIABILITY_RECLASS",
        ]),
        reason: `${text(decision.reason)} | Два физических пути покрывают один остаток; экономическое распределение не доказано`,
      }));
    }
  }
  return Object.freeze({
    decisions: Object.freeze(decisions.map((decision) => suppressed.get(decision) ?? decision)),
    overlap_cases: overlapCases,
    review_only_decisions: suppressed.size,
  });
}

function targetDelta(row) {
  return amount(first(row, [
    "Дельта = Инталев − ERP",
    "Дельта = Инталев – ERP",
    "Дельта = Инталев - ERP",
    "Дельта",
  ]));
}

function sourceIdentity(row, defaults = {}) {
  const comment = text(row?.["Комментарий / доказательство"]);
  const where = text(row?.["Где исправить"]);
  const sourceSheet = text(where.split("!", 1)[0]) || text(defaults.sourceSheet);
  const sourceRange = text(row?.["ERP строка"]) || text(where.split("!").slice(1).join("!"));
  const debit = text(row?.["Дт"]);
  const credit = text(row?.["Кт"]);
  const debitAnalytics = analyticsSlots(row?.["Аналитики Дт"]);
  const creditAnalytics = analyticsSlots(row?.["Аналитики Кт"]);
  const article = text(defaults.article);
  const articleKey = normalized(article);
  const debitArticle = articleKey && debitAnalytics.some((value) => normalized(value).includes(articleKey));
  const creditArticle = articleKey && creditAnalytics.some((value) => normalized(value).includes(articleKey));
  const expectedAccounts = traceAccounts(comment);
  const debitExpected = expectedAccounts.some((value) => accountMatches(value, debit));
  const creditExpected = expectedAccounts.some((value) => accountMatches(value, credit));
  const operatingSide = debitArticle !== creditArticle
    ? (debitArticle ? "DEBIT" : "CREDIT")
    : debitExpected !== creditExpected
      ? (debitExpected ? "DEBIT" : "CREDIT")
      : "";
  const sourceOperatingAccount = operatingSide === "DEBIT" ? debit : operatingSide === "CREDIT" ? credit : "";
  const settlementAccount = operatingSide === "DEBIT" ? credit : operatingSide === "CREDIT" ? debit : "";
  return {
    source_archive_path: traceField(comment, "JournalInput"),
    source_archive_sha256: text(defaults.sourceArchiveSha256).toUpperCase(),
    journal_entry: traceField(comment, "JournalEntry"),
    journal_sha256: traceField(comment, "JournalSHA").toUpperCase(),
    source_sheet: sourceSheet,
    source_range: sourceRange,
    source_row_id: traceField(comment, "SourceRowID").toUpperCase(),
    source_date: text(row?.["Дата"]),
    registrar: text(row?.["Регистратор / документ"]),
    posting_number: text(row?.["№ проводки"]),
    source_dt: debit,
    source_analytics_dt1: debitAnalytics[0],
    source_analytics_dt2: debitAnalytics[1],
    source_analytics_dt3: debitAnalytics[2],
    source_department_dt: text(row?.["Подразделение Дт"]),
    source_kt: credit,
    source_analytics_kt1: creditAnalytics[0],
    source_analytics_kt2: creditAnalytics[1],
    source_analytics_kt3: creditAnalytics[2],
    source_department_kt: text(row?.["Подразделение Кт"]),
    source_organization: text(row?.["Организация"]),
    source_amount: Math.abs(amount(row?.["Физическая сумма"]) ?? 0),
    source_operating_account: sourceOperatingAccount,
    settlement_account: settlementAccount,
    operating_side: operatingSide,
    target_subkonto_slot: 1,
    complete: Boolean(
      text(defaults.sourceArchiveSha256).match(/^[A-F0-9]{64}$/i)
      && traceField(comment, "JournalInput")
      && traceField(comment, "JournalEntry")
      && traceField(comment, "JournalSHA").match(/^[A-F0-9]{64}$/i)
      && traceField(comment, "SourceRowID").match(/^[A-F0-9]{64}$/i)
      && sourceSheet && sourceRange && operatingSide
      && text(row?.["Дата"]) && text(row?.["Регистратор / документ"])
      && text(row?.["№ проводки"]) && debit && credit
      && text(row?.["Подразделение Дт"]) && text(row?.["Подразделение Кт"])
      && text(row?.["Организация"]) && Math.abs(amount(row?.["Физическая сумма"]) ?? 0) > 0
    ),
  };
}

function signedAmount(row) {
  return amount(row?.["Физическая сумма"]);
}

function nonClosing(row) {
  return ![row?.["Дт"], row?.["Кт"]].some((value) => canonicalAccount(value) === "99");
}

function physicalTopology(ordered) {
  const nodes = [];
  const physical = [];
  const stack = [];
  for (const row of ordered) {
    const code = structuralCode(row);
    if (code) {
      const level = levelOf(row);
      while (stack.length && stack.at(-1).level >= level) stack.pop();
      const node = {
        row,
        code,
        level,
        label: text(row?.["Строка ОПИУ / операция"]),
        parentCode: stack.at(-1)?.code ?? "",
      };
      nodes.push(node);
      stack.push(node);
      continue;
    }
    if (physicalRow(row) && stack.length) physical.push({ row, owner: stack.at(-1) });
  }
  return { nodes, physical };
}

function directChildren(topology, parentCode) {
  return topology.nodes.filter((node) => node.parentCode === parentCode);
}

function structuralCents(row, label) {
  return cents(row?.[label]);
}

function adjustedHierarchyResidualCents(topology, node) {
  const intalev = structuralCents(node.row, "Инталев");
  const erp = structuralCents(node.row, "ERP");
  if (intalev === null || erp === null) return null;
  const directErpComponents = directChildren(topology, node.code)
    .map((child) => structuralCents(child.row, "ERP"))
    .filter((value) => value !== null)
    .reduce((sum, value) => sum + value, 0);
  return intalev - erp - directErpComponents;
}

function settlementEmployeeFromTreeRow(row, operatingSide) {
  const values = operatingSide === "DEBIT"
    ? analyticsSlots(row?.["Аналитики Кт"])
    : operatingSide === "CREDIT"
      ? analyticsSlots(row?.["Аналитики Дт"])
      : [];
  return text(values.find(Boolean));
}

function rawAnalytics(raw, side) {
  return [1, 2, 3].map((index) => text(raw?.[`${side}_analytics_${index}`]));
}

function normalizedDateText(value) {
  return text(value).match(/^\d{2}\.\d{2}\.\d{4}/)?.[0] ?? text(value);
}

function rawSourceMatchesIdentity(raw, identity, period) {
  const expectedDebitAnalytics = [1, 2, 3].map((index) => normalized(identity?.[`source_analytics_dt${index}`]));
  const expectedCreditAnalytics = [1, 2, 3].map((index) => normalized(identity?.[`source_analytics_kt${index}`]));
  const actualDebitAnalytics = rawAnalytics(raw, "debit").map(normalized);
  const actualCreditAnalytics = rawAnalytics(raw, "credit").map(normalized);
  return text(raw?.source_row_id).toUpperCase() === text(identity?.source_row_id).toUpperCase()
    && text(raw?.source_range) === text(identity?.source_range)
    && text(raw?.period) === text(period)
    && normalizedDateText(raw?.date) === normalizedDateText(identity?.source_date)
    && text(raw?.document) === text(identity?.registrar)
    && text(raw?.posting_no) === text(identity?.posting_number)
    && canonicalAccount(raw?.debit) === canonicalAccount(identity?.source_dt)
    && canonicalAccount(raw?.credit) === canonicalAccount(identity?.source_kt)
    && normalized(raw?.organization) === normalized(identity?.source_organization)
    && cents(raw?.amount) === cents(identity?.source_amount)
    && normalized(raw?.debit_department) === normalized(identity?.source_department_dt)
    && normalized(raw?.credit_department) === normalized(identity?.source_department_kt)
    && actualDebitAnalytics.every((value, index) => value === expectedDebitAnalytics[index])
    && actualCreditAnalytics.every((value, index) => value === expectedCreditAnalytics[index]);
}

function cashOrBankAccount(value) {
  const account = canonicalAccount(value);
  return /^(50|51|52|55|57)(?:\.|$)/.test(account);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function loadVerifiedJournalFromTrace({ item, sourceArchiveSha256, sourceSheet, cache }) {
  const comment = text(item?.row?.["Комментарий / доказательство"]);
  const archivePath = traceField(comment, "JournalInput");
  const journalEntry = traceField(comment, "JournalEntry");
  const expectedJournalSha = traceField(comment, "JournalSHA").toUpperCase();
  const key = `${archivePath}\u0000${journalEntry}\u0000${expectedJournalSha}`;
  if (cache.has(key)) return cache.get(key);
  if (!archivePath || !journalEntry || !expectedJournalSha.match(/^[A-F0-9]{64}$/)) {
    throw new Error("HIERARCHY_RESIDUAL_JOURNAL_TRACE_INCOMPLETE");
  }
  const archiveBuffer = await fs.readFile(archivePath);
  const actualArchiveSha = sha256Buffer(archiveBuffer);
  if (text(sourceArchiveSha256).match(/^[A-F0-9]{64}$/i)
    && actualArchiveSha !== text(sourceArchiveSha256).toUpperCase()) {
    throw new Error("HIERARCHY_RESIDUAL_SOURCE_ARCHIVE_SHA_MISMATCH");
  }
  let journalBuffer;
  if (/\.xlsx$/i.test(archivePath)) journalBuffer = archiveBuffer;
  else {
    const archive = await JSZip.loadAsync(archiveBuffer);
    const entry = archive.file(journalEntry);
    if (!entry) throw new Error("HIERARCHY_RESIDUAL_JOURNAL_ENTRY_NOT_FOUND");
    journalBuffer = await entry.async("nodebuffer");
  }
  const actualJournalSha = sha256Buffer(journalBuffer);
  if (actualJournalSha !== expectedJournalSha) throw new Error("HIERARCHY_RESIDUAL_JOURNAL_SHA_MISMATCH");
  const journal = await readOperationJournalRows({
    journalBuffer,
    sheet: text(sourceSheet) || "Лист_1",
    journalSourceLabel: journalEntry,
  });
  const loaded = Object.freeze({
    rows: Object.freeze(journal.rows),
    by_source_row_id: new Map(journal.rows.map((row) => [text(row.source_row_id).toUpperCase(), row])),
    source_archive_path: archivePath,
    source_archive_sha256: actualArchiveSha,
    journal_entry: journalEntry,
    journal_sha256: actualJournalSha,
    source_sheet: journal.journal_sheet,
  });
  cache.set(key, loaded);
  return loaded;
}

function physicalSignature(row) {
  const debit = canonicalAccount(row?.["Дт"]);
  const credit = canonicalAccount(row?.["Кт"]);
  return debit && credit ? `${debit}|${credit}` : "";
}

function intergroupRouteRoots(topology) {
  const groups = new Map();
  for (const node of topology.nodes) {
    const comment = text(node.row?.["Комментарий / доказательство"]);
    const caseId = traceField(comment, "CaseID");
    const delta = targetDelta(node.row);
    if (!caseId || !/proof=ECONOMIC_RECLASS_PROVEN/i.test(comment) || !delta) continue;
    if (!groups.has(caseId)) groups.set(caseId, []);
    groups.get(caseId).push({ ...node, delta });
  }
  const routes = [];
  for (const [caseId, members] of groups) {
    const sources = members.filter((member) => member.delta < 0);
    const targets = members.filter((member) => member.delta > 0);
    if (sources.length !== 1 || targets.length !== 1) continue;
    if (Math.abs(cents(sources[0].delta)) !== Math.abs(cents(targets[0].delta))) continue;
    routes.push({ caseId, source: sources[0], target: targets[0], routeCents: Math.abs(cents(targets[0].delta)) });
  }
  return routes;
}

/**
 * Materializes an accepted inter-group hierarchy route from its exact physical
 * ERP source rows.  No row codes, article names or amounts are predefined.
 *
 * A route is authoritative only when:
 * - its source/target roots share one ECONOMIC_RECLASS_PROVEN CaseID;
 * - positive direct target children add exactly to the accepted route amount;
 * - one common accounting signature under direct source children yields one
 *   unique bucket-to-target assignment by exact amount;
 * - every row in the selected buckets has complete immutable ERP identity.
 */
function deriveIntergroupPhysicalReclassificationAuthority({
  ordered,
  contexts,
  period,
  reconciliationOrganization,
  sourceArchiveSha256,
  sourceSheet,
  reconciliationSha256,
}) {
  const topology = physicalTopology(ordered);
  const decisions = [];
  const blockers = [];
  const coveredRouteCaseIds = new Set();
  const consumedSourceRowIds = new Set();
  const satisfiedStructuralCodes = new Set();

  for (const route of intergroupRouteRoots(topology)) {
    const targetChildren = directChildren(topology, route.target.code).filter((node) => {
      const delta = targetDelta(node.row);
      return delta > 0 && /structural status=HIERARCHY_PROVEN/i.test(text(node.row?.["Комментарий / доказательство"]));
    });
    const targetTotal = targetChildren.reduce((sum, node) => sum + (cents(targetDelta(node.row)) ?? 0), 0);
    if (!targetChildren.length || targetTotal !== route.routeCents) {
      blockers.push(Object.freeze({
        economic_route_case_id: route.caseId,
        reason: "INTERGROUP_TARGET_DESCENDANTS_DO_NOT_CLOSE_ROUTE",
        route_amount: route.routeCents / 100,
        target_descendant_amount: targetTotal / 100,
      }));
      continue;
    }

    const sourceChildren = directChildren(topology, route.source.code);
    const sourceCodes = new Set(sourceChildren.map((node) => node.code));
    const sourceByCode = new Map(sourceChildren.map((node) => [node.code, node]));
    const bucketsByKey = new Map();
    for (const item of topology.physical) {
      if (!sourceCodes.has(item.owner.code) || !nonClosing(item.row) || !(signedAmount(item.row) > 0)) continue;
      const signature = physicalSignature(item.row);
      if (!signature) continue;
      const sourceArticle = item.owner.label;
      const identity = sourceIdentity(item.row, { article: sourceArticle, sourceArchiveSha256, sourceSheet });
      const key = `${item.owner.code}\u0000${signature}`;
      if (!bucketsByKey.has(key)) {
        bucketsByKey.set(key, { owner: sourceByCode.get(item.owner.code), signature, rows: [], totalCents: 0, complete: true });
      }
      const bucket = bucketsByKey.get(key);
      bucket.rows.push({ item, identity });
      bucket.totalCents += Math.abs(cents(item.row?.["Физическая сумма"]) ?? 0);
      bucket.complete = bucket.complete && identity.complete;
    }
    const validBuckets = [...bucketsByKey.values()].filter((bucket) => bucket.complete && bucket.totalCents > 0);
    const signatures = [...new Set(validBuckets.map((bucket) => bucket.signature))];
    const solutions = [];
    for (const signature of signatures) {
      const buckets = validBuckets.filter((bucket) => bucket.signature === signature);
      const visit = (targetIndex, used, assignment) => {
        if (solutions.length > 1) return;
        if (targetIndex >= targetChildren.length) {
          const total = assignment.reduce((sum, entry) => sum + entry.bucket.totalCents, 0);
          if (total === route.routeCents) solutions.push({ signature, assignment: [...assignment] });
          return;
        }
        const target = targetChildren[targetIndex];
        const targetCents = cents(targetDelta(target.row));
        for (const bucket of buckets) {
          if (used.has(bucket) || bucket.totalCents !== targetCents) continue;
          used.add(bucket);
          assignment.push({ target, bucket });
          visit(targetIndex + 1, used, assignment);
          assignment.pop();
          used.delete(bucket);
        }
      };
      visit(0, new Set(), []);
    }
    if (solutions.length !== 1) {
      blockers.push(Object.freeze({
        economic_route_case_id: route.caseId,
        reason: solutions.length ? "INTERGROUP_PHYSICAL_ASSIGNMENT_AMBIGUOUS" : "INTERGROUP_PHYSICAL_ASSIGNMENT_NOT_FOUND",
        solution_count: solutions.length,
        route_amount: route.routeCents / 100,
      }));
      continue;
    }

    const local = [];
    for (const { target, bucket } of solutions[0].assignment) {
      const targetContext = contexts.get(target.code) ?? { block: "", path: target.label };
      for (const { item, identity } of bucket.rows) {
        if (consumedSourceRowIds.has(identity.source_row_id)) {
          blockers.push(Object.freeze({
            economic_route_case_id: route.caseId,
            reason: "INTERGROUP_PHYSICAL_SOURCE_ALREADY_CONSUMED",
            source_row_id: identity.source_row_id,
          }));
          continue;
        }
        const correctionCents = Math.abs(cents(identity.source_amount) ?? 0);
        const pairId = stableId("PAIR-HIERARCHY-INTERGROUP", [route.caseId, target.code, identity.source_row_id, correctionCents]);
        local.push(Object.freeze({
          case_id: stableId("HIERARCHY-INTERGROUP", [pairId, route.caseId]),
          pair_id: pairId,
          decision_type: "STORNO_REPOST",
          approval_state: "ДОКАЗАНО_СВЕРКОЙ",
          period: text(period),
          reconciliation_row: target.code,
          group: bucket.owner.label,
          role: "HIERARCHY_INTERGROUP_PHYSICAL_RECLASS",
          organization: text(reconciliationOrganization),
          reconciliation_organization: text(reconciliationOrganization),
          ...identity,
          correction_amount: correctionCents / 100,
          analytical_effect: correctionCents / 100,
          effective_delta: correctionCents / 100,
          analytical_basis_id: target.code,
          source_article: bucket.owner.label,
          target_article: target.label,
          target_dt: identity.source_dt,
          target_analytics_dt1: target.label,
          target_analytics_dt2: identity.source_analytics_dt2,
          target_analytics_dt3: identity.source_analytics_dt3,
          target_department_dt: identity.source_department_dt,
          target_kt: identity.source_kt,
          target_analytics_kt1: identity.source_analytics_kt1,
          target_analytics_kt2: identity.source_analytics_kt2,
          target_analytics_kt3: identity.source_analytics_kt3,
          target_department_kt: identity.source_department_kt,
          intalev_block: targetContext.block,
          intalev_path: targetContext.path,
          erp_source_sha256: identity.journal_sha256,
          evidence_state: "HIERARCHY_INTERGROUP_PHYSICAL_ROUTE_PROVEN",
          proof_status: "PROVEN",
          classification: "FINANCIAL_CORRECTION_PROVEN",
          correction_authority: "HIERARCHY_INTERGROUP_PHYSICAL_SOURCE",
          correction_allowed: true,
          accepted_economic_reclass: true,
          accepted_amount: correctionCents / 100,
          intergroup_reclass_id: route.caseId,
          intergroup_reclass_source_code: route.source.code,
          intergroup_reclass_target_code: route.target.code,
          covered_economic_route_case_id: route.caseId,
          ECONOMIC_ROUTE_PROVEN: true,
          SOURCE_OPERATION_PROVEN: true,
          PHYSICAL_SOURCE_UNIQUE: true,
          ECONOMIC_CORRECTION_PROVEN: true,
          output_route: "SPORNO",
          processing_stage: "HIERARCHY_INTERGROUP_PHYSICAL_RECLASS",
          stage_order: 1,
          source_rows: identity.source_range,
          reason: `Маршрут ${route.source.code} → ${route.target.code}: физическая ERP-строка ${identity.source_range} входит в единственный полный набор ${route.routeCents / 100}`,
          solution: `STORNO со статьи ${bucket.owner.label}; REPOST на ${target.label} внутри блока ${targetContext.block}`,
          notes: `Источник сверки SHA256=${text(reconciliationSha256)}; route=${route.caseId}; source child=${bucket.owner.code}; target child=${target.code}; signature=${bucket.signature}`,
          source_article_missing: false,
        }));
      }
    }
    const localTotal = local.reduce((sum, decision) => sum + (cents(decision.correction_amount) ?? 0), 0);
    if (localTotal !== route.routeCents) {
      blockers.push(Object.freeze({
        economic_route_case_id: route.caseId,
        reason: "INTERGROUP_PHYSICAL_ROWS_DO_NOT_CLOSE_ROUTE",
        route_amount: route.routeCents / 100,
        physical_amount: localTotal / 100,
      }));
      continue;
    }
    for (const decision of local) consumedSourceRowIds.add(decision.source_row_id);
    for (const { target, bucket } of solutions[0].assignment) {
      satisfiedStructuralCodes.add(target.code);
      if (bucket.totalCents === Math.abs(cents(targetDelta(bucket.owner.row)) ?? 0)) {
        satisfiedStructuralCodes.add(bucket.owner.code);
      }
    }
    coveredRouteCaseIds.add(route.caseId);
    decisions.push(...local);
  }

  return {
    decisions,
    blockers,
    coveredRouteCaseIds,
    consumedSourceRowIds,
    satisfiedStructuralCodes,
  };
}

function analyticsKey(value) {
  return normalized(analyticsSlots(value).find(Boolean));
}

function pairedKey({ organization, employee, value, account: accountValue }) {
  return [normalized(organization), normalized(employee), cents(value), canonicalAccount(accountValue)].join("\u0000");
}

function authoritativeStructuralNode(node) {
  return Boolean(
    node?.code
    && structuralCents(node.row, "Инталев") !== null
    && structuralCents(node.row, "ERP") !== null
    && /structural status=HIERARCHY_PROVEN/i.test(text(node.row?.["Комментарий / доказательство"])),
  );
}

/**
 * Resolves a hierarchy reclassification hidden by different report nesting.
 * The route must close under one zero-delta parent in exact cents. A partial
 * source is accepted only when the raw journal has one exact settlement
 * payment for the same employee and that employee is absent from the already
 * classified target expense rows of the same accounting signature.
 */
async function deriveHierarchyResidualSettlementAuthority({
  ordered,
  contexts,
  period,
  reconciliationOrganization,
  sourceArchiveSha256,
  sourceSheet,
  reconciliationSha256,
}) {
  const topology = physicalTopology(ordered);
  const decisions = [];
  const blockers = [];
  const satisfiedStructuralCodes = new Set();
  const consumedSourceRowIds = new Set();
  const journalCache = new Map();

  for (const parent of topology.nodes.filter(authoritativeStructuralNode)) {
    if ((cents(targetDelta(parent.row)) ?? 0) !== 0) continue;
    const children = directChildren(topology, parent.code)
      .filter(authoritativeStructuralNode)
      .map((node) => ({ node, residualCents: adjustedHierarchyResidualCents(topology, node) }))
      .filter((item) => item.residualCents !== null && item.residualCents !== 0);
    const positive = children.filter((item) => item.residualCents > 0);
    const negative = children.filter((item) => item.residualCents < 0);
    const closedCents = children.reduce((sum, item) => sum + item.residualCents, 0);
    if (positive.length !== 1 || negative.length !== 1 || closedCents !== 0
      || positive[0].residualCents !== Math.abs(negative[0].residualCents)) continue;

    const target = positive[0].node;
    const source = negative[0].node;
    const routeCents = positive[0].residualCents;
    const sourceItems = topology.physical.filter((item) => item.owner.code === source.code
      && nonClosing(item.row) && (signedAmount(item.row) ?? 0) > 0);
    const targetItems = topology.physical.filter((item) => item.owner.code === target.code
      && nonClosing(item.row) && (signedAmount(item.row) ?? 0) > 0);
    const targetBySignature = new Map();
    for (const item of targetItems) {
      const identity = sourceIdentity(item.row, {
        article: target.label,
        sourceArchiveSha256,
        sourceSheet,
      });
      const signature = physicalSignature(item.row);
      const employee = settlementEmployeeFromTreeRow(item.row, identity.operating_side);
      if (!signature || !employee) continue;
      if (!targetBySignature.has(signature)) targetBySignature.set(signature, new Set());
      targetBySignature.get(signature).add(normalized(employee));
    }
    if (![...targetBySignature.values()].some((employees) => employees.size >= 2)) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: "HIERARCHY_RESIDUAL_TARGET_PATTERN_NOT_RECURRING",
        route_amount: routeCents / 100,
      }));
      continue;
    }

    const sourceCandidates = sourceItems.flatMap((item) => {
      const identity = sourceIdentity(item.row, {
        article: source.label,
        sourceArchiveSha256,
        sourceSheet,
      });
      const signature = physicalSignature(item.row);
      const employee = settlementEmployeeFromTreeRow(item.row, identity.operating_side);
      const targetEmployees = targetBySignature.get(signature);
      if (!identity.complete || !employee || !targetEmployees?.size
        || targetEmployees.has(normalized(employee))
        || Math.abs(cents(identity.source_amount) ?? 0) < routeCents) return [];
      return [{ item, identity, signature, employee }];
    });
    if (!sourceCandidates.length) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: "HIERARCHY_RESIDUAL_PHYSICAL_SOURCE_NOT_FOUND",
        route_amount: routeCents / 100,
      }));
      continue;
    }

    let journal;
    try {
      journal = await loadVerifiedJournalFromTrace({
        item: sourceCandidates[0].item,
        sourceArchiveSha256,
        sourceSheet,
        cache: journalCache,
      });
    } catch (error) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: text(error?.message || "HIERARCHY_RESIDUAL_JOURNAL_UNAVAILABLE"),
        route_amount: routeCents / 100,
      }));
      continue;
    }

    const verifiedSourceCandidates = sourceCandidates.filter((candidate) => {
      const sourceRowId = text(candidate.identity.source_row_id).toUpperCase();
      const rawSource = journal.by_source_row_id.get(sourceRowId);
      return rawSource && rawSourceMatchesIdentity(rawSource, candidate.identity, period);
    });
    if (!verifiedSourceCandidates.length) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: "HIERARCHY_RESIDUAL_EXACT_SOURCE_JOURNAL_MISMATCH",
        route_amount: routeCents / 100,
      }));
      continue;
    }

    const witnesses = [];
    for (const candidate of verifiedSourceCandidates) {
      const settlementAccount = canonicalAccount(candidate.identity.settlement_account);
      const candidateOrganization = normalized(candidate.identity.source_organization);
      const candidateEmployee = normalized(candidate.employee);
      for (const raw of journal.rows) {
        if (text(raw.period) !== text(period)
          || Math.abs(cents(raw.amount) ?? 0) !== routeCents
          || normalized(raw.organization) !== candidateOrganization
          || (text(raw.activity) && normalized(raw.activity) !== normalized("Да"))
          || (text(raw.scenario) && normalized(raw.scenario) !== normalized("Факт"))) continue;
        const debit = canonicalAccount(raw.debit);
        const credit = canonicalAccount(raw.credit);
        const settlementSide = debit === settlementAccount ? "debit" : credit === settlementAccount ? "credit" : "";
        const counterpart = settlementSide === "debit" ? raw.credit : settlementSide === "credit" ? raw.debit : "";
        if (!settlementSide || !cashOrBankAccount(counterpart)) continue;
        const witnessEmployee = normalized(rawAnalytics(raw, settlementSide).find(Boolean));
        if (!witnessEmployee || witnessEmployee !== candidateEmployee) continue;
        witnesses.push({ candidate, raw });
      }
    }
    const witnessKeys = new Set(witnesses.map(({ candidate, raw }) =>
      `${candidate.identity.source_row_id}\u0000${text(raw.source_row_id).toUpperCase()}`));
    if (witnesses.length !== 1 || witnessKeys.size !== 1) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: witnesses.length ? "HIERARCHY_RESIDUAL_SETTLEMENT_WITNESS_AMBIGUOUS" : "HIERARCHY_RESIDUAL_SETTLEMENT_WITNESS_NOT_FOUND",
        witness_count: witnesses.length,
        route_amount: routeCents / 100,
      }));
      continue;
    }

    const { candidate, raw } = witnesses[0];
    if (consumedSourceRowIds.has(candidate.identity.source_row_id)
      || !text(raw.source_row_id).match(/^[A-F0-9]{64}$/i)) {
      blockers.push(Object.freeze({
        reconciliation_row: target.code,
        reason: consumedSourceRowIds.has(candidate.identity.source_row_id)
          ? "HIERARCHY_RESIDUAL_SOURCE_ALREADY_CONSUMED"
          : "HIERARCHY_RESIDUAL_SETTLEMENT_IDENTITY_INCOMPLETE",
      }));
      continue;
    }

    const targetContext = contexts.get(target.code) ?? { block: "", path: target.label };
    const pairId = stableId("PAIR-HIERARCHY-RESIDUAL", [
      period, parent.code, source.code, target.code,
      candidate.identity.source_row_id, raw.source_row_id, routeCents,
    ]);
    decisions.push(Object.freeze({
      case_id: stableId("HIERARCHY-RESIDUAL", [pairId, target.code]),
      pair_id: pairId,
      decision_type: "STORNO_REPOST",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      period: text(period),
      reconciliation_row: target.code,
      group: source.label,
      role: "HIERARCHY_RESIDUAL_SETTLEMENT_RECLASS",
      organization: text(reconciliationOrganization),
      reconciliation_organization: text(reconciliationOrganization),
      ...candidate.identity,
      correction_amount: routeCents / 100,
      analytical_effect: routeCents / 100,
      effective_delta: routeCents / 100,
      analytical_basis_id: target.code,
      source_article: source.label,
      target_article: target.label,
      target_dt: candidate.identity.source_dt,
      target_analytics_dt1: target.label,
      target_analytics_dt2: candidate.identity.source_analytics_dt2,
      target_analytics_dt3: candidate.identity.source_analytics_dt3,
      target_department_dt: candidate.identity.source_department_dt,
      target_kt: candidate.identity.source_kt,
      target_analytics_kt1: candidate.identity.source_analytics_kt1,
      target_analytics_kt2: candidate.identity.source_analytics_kt2,
      target_analytics_kt3: candidate.identity.source_analytics_kt3,
      target_department_kt: candidate.identity.source_department_kt,
      intalev_block: targetContext.block,
      intalev_path: targetContext.path,
      erp_source_sha256: candidate.identity.journal_sha256,
      evidence_state: "HIERARCHY_RESIDUAL_SETTLEMENT_WITNESS_PROVEN",
      proof_status: "PROVEN",
      classification: "FINANCIAL_CORRECTION_PROVEN",
      correction_authority: "HIERARCHY_RESIDUAL_SETTLEMENT_WITNESS_SOURCE",
      correction_allowed: true,
      accepted_economic_reclass: true,
      accepted_amount: routeCents / 100,
      ECONOMIC_ROUTE_PROVEN: true,
      SOURCE_OPERATION_PROVEN: true,
      PHYSICAL_SOURCE_UNIQUE: true,
      ECONOMIC_CORRECTION_PROVEN: true,
      partial_source_amount_proven: true,
      hierarchy_residual_parent_code: parent.code,
      hierarchy_residual_source_code: source.code,
      hierarchy_residual_target_code: target.code,
      settlement_witness_source_row_id: text(raw.source_row_id).toUpperCase(),
      settlement_witness_source_range: text(raw.source_range),
      settlement_witness_amount: Math.abs(amount(raw.amount) ?? 0),
      settlement_witness_employee: candidate.employee,
      settlement_witness_account: candidate.identity.settlement_account,
      output_route: "SPORNO",
      processing_stage: "HIERARCHY_RESIDUAL_SETTLEMENT_RECLASS",
      stage_order: 1,
      source_rows: `${candidate.identity.source_range}; ${text(raw.source_range)}`,
      reason: `Иерархия ${parent.code}: после свёртки вложенных ERP-компонентов остаток ${source.code} → ${target.code} равен ${routeCents / 100}; точная выплата и расходная строка совпали по сотруднику и расчётному счёту`,
      solution: `Частичное STORNO из ${source.label}; REPOST в ${target.label} внутри блока ${targetContext.block}`,
      notes: `Источник сверки SHA256=${text(reconciliationSha256)}; source row=${candidate.identity.source_range}; settlement witness=${text(raw.source_range)}; employee=${candidate.employee}`,
      source_article_missing: false,
    }));
    consumedSourceRowIds.add(candidate.identity.source_row_id);
    satisfiedStructuralCodes.add(source.code);
    satisfiedStructuralCodes.add(target.code);
  }

  return { decisions, blockers, satisfiedStructuralCodes, consumedSourceRowIds };
}

/**
 * Finds a generic missing classification side without relying on a row code or
 * article name.  A target leaf is accepted only when:
 * - most rows prove the recurring pair `expense -> settlement` and
 *   `settlement -> liability` for the same organization/employee/amount;
 * - the unmatched liability rows add exactly to the positive hierarchy delta;
 * - every unmatched liability has exactly one complete physical expense row
 *   for the same organization/employee in the direct parent article.
 *
 * The parent expense may be larger than the classified part.  The liability
 * row proves the exact partial amount; the parent expense row proves the exact
 * source tuple that must be partially reclassified.
 */
function derivePairedLiabilityClassificationAuthority({
  ordered,
  contexts,
  period,
  reconciliationOrganization,
  sourceArchiveSha256,
  sourceSheet,
  reconciliationSha256,
}) {
  const topology = physicalTopology(ordered);
  const decisions = [];
  const blockers = [];
  for (const target of topology.nodes) {
    const delta = targetDelta(target.row);
    const proof = text(target.row?.["Комментарий / доказательство"]);
    if (!(delta > 0) || !/structural status=HIERARCHY_PROVEN/i.test(proof) || !target.parentCode) continue;
    const targetRows = topology.physical.filter((item) => item.owner.code === target.code && nonClosing(item.row)
      && (signedAmount(item.row) ?? 0) > 0);
    if (targetRows.length < 3) continue;

    const expenses = targetRows.filter((item) => {
      const debitAnalytics = analyticsSlots(item.row?.["Аналитики Дт"]);
      return debitAnalytics.some((value) => normalized(value) === normalized(target.label));
    });
    if (expenses.length < 2) continue;
    const expenseCounts = new Map();
    for (const item of expenses) {
      const key = pairedKey({
        organization: item.row?.["Организация"],
        employee: analyticsKey(item.row?.["Аналитики Кт"]),
        value: item.row?.["Физическая сумма"],
        account: item.row?.["Кт"],
      });
      expenseCounts.set(key, (expenseCounts.get(key) ?? 0) + 1);
    }

    const signatureGroups = new Map();
    for (const item of targetRows) {
      const debitAccount = canonicalAccount(item.row?.["Дт"]);
      const creditAccount = canonicalAccount(item.row?.["Кт"]);
      const employee = analyticsKey(item.row?.["Аналитики Дт"]);
      if (!debitAccount || !creditAccount || !employee || debitAccount === creditAccount) continue;
      const key = pairedKey({
        organization: item.row?.["Организация"],
        employee,
        value: item.row?.["Физическая сумма"],
        account: debitAccount,
      });
      const signature = `${debitAccount}|${creditAccount}`;
      if (!signatureGroups.has(signature)) signatureGroups.set(signature, { matched: [], unmatched: [] });
      const group = signatureGroups.get(signature);
      if ((expenseCounts.get(key) ?? 0) > 0) {
        expenseCounts.set(key, expenseCounts.get(key) - 1);
        group.matched.push(item);
      } else {
        group.unmatched.push(item);
      }
    }
    const eligibleGroups = [...signatureGroups.values()].filter((group) =>
      group.matched.length >= 2
      && group.unmatched.length > 0
      && group.unmatched.reduce((sum, item) => sum + (cents(item.row?.["Физическая сумма"]) ?? 0), 0) === cents(delta));
    if (eligibleGroups.length !== 1) continue;

    const group = eligibleGroups[0];
    const claimedSources = new Set();
    const local = [];
    for (const liability of group.unmatched) {
      const liabilityEmployee = analyticsKey(liability.row?.["Аналитики Дт"]);
      const liabilityOrganization = normalized(liability.row?.["Организация"]);
      const liabilityAmountCents = Math.abs(cents(liability.row?.["Физическая сумма"]) ?? 0);
      const settlementAccount = canonicalAccount(liability.row?.["Дт"]);
      const sourceMatches = topology.physical.filter((item) =>
        item.owner.code === target.parentCode
        && nonClosing(item.row)
        && (signedAmount(item.row) ?? 0) > 0
        && normalized(item.row?.["Организация"]) === liabilityOrganization
        && canonicalAccount(item.row?.["Кт"]) === settlementAccount
        && analyticsKey(item.row?.["Аналитики Кт"]) === liabilityEmployee
        && Math.abs(cents(item.row?.["Физическая сумма"]) ?? 0) >= liabilityAmountCents);
      if (sourceMatches.length !== 1) {
        blockers.push(Object.freeze({
          reconciliation_row: target.code,
          reason: sourceMatches.length ? "PAIRED_LIABILITY_PARENT_SOURCE_AMBIGUOUS" : "PAIRED_LIABILITY_PARENT_SOURCE_NOT_FOUND",
          liability_source_row_id: traceField(liability.row?.["Комментарий / доказательство"], "SourceRowID"),
          candidate_count: sourceMatches.length,
        }));
        continue;
      }
      const sourceMatch = sourceMatches[0];
      const sourceArticle = analyticsSlots(sourceMatch.row?.["Аналитики Дт"])[0]
        || analyticsSlots(sourceMatch.row?.["Аналитики Кт"])[0]
        || sourceMatch.owner.label;
      const identity = sourceIdentity(sourceMatch.row, {
        article: sourceArticle,
        sourceArchiveSha256,
        sourceSheet,
      });
      const liabilityRowId = traceField(liability.row?.["Комментарий / доказательство"], "SourceRowID").toUpperCase();
      const liabilityJournalSha = traceField(liability.row?.["Комментарий / доказательство"], "JournalSHA").toUpperCase();
      if (!identity.complete || !liabilityRowId.match(/^[A-F0-9]{64}$/) || !liabilityJournalSha.match(/^[A-F0-9]{64}$/)
        || claimedSources.has(identity.source_row_id)) {
        blockers.push(Object.freeze({
          reconciliation_row: target.code,
          reason: claimedSources.has(identity.source_row_id)
            ? "PAIRED_LIABILITY_SOURCE_ALREADY_CONSUMED"
            : "PAIRED_LIABILITY_EVIDENCE_INCOMPLETE",
          liability_source_row_id: liabilityRowId,
        }));
        continue;
      }
      claimedSources.add(identity.source_row_id);
      const context = contexts.get(target.code) ?? { block: "", path: target.label };
      const pairId = stableId("PAIR-HIERARCHY-PARTIAL", [period, target.code, identity.source_row_id, liabilityRowId, liabilityAmountCents]);
      local.push(Object.freeze({
        case_id: stableId("HIERARCHY-PARTIAL", [pairId, target.code]),
        pair_id: pairId,
        decision_type: "STORNO_REPOST",
        approval_state: "ДОКАЗАНО_СВЕРКОЙ",
        period: text(period),
        reconciliation_row: target.code,
        group: sourceArticle,
        role: "HIERARCHY_PAIRED_LIABILITY_RECLASS",
        organization: text(reconciliationOrganization),
        reconciliation_organization: text(reconciliationOrganization),
        ...identity,
        correction_amount: liabilityAmountCents / 100,
        analytical_effect: liabilityAmountCents / 100,
        effective_delta: liabilityAmountCents / 100,
        analytical_basis_id: target.code,
        source_article: sourceArticle,
        target_article: target.label,
        target_dt: identity.source_dt,
        target_analytics_dt1: target.label,
        target_analytics_dt2: identity.source_analytics_dt2,
        target_analytics_dt3: identity.source_analytics_dt3,
        target_department_dt: identity.source_department_dt,
        target_kt: identity.source_kt,
        target_analytics_kt1: identity.source_analytics_kt1,
        target_analytics_kt2: identity.source_analytics_kt2,
        target_analytics_kt3: identity.source_analytics_kt3,
        target_department_kt: identity.source_department_kt,
        intalev_block: context.block,
        intalev_path: context.path,
        erp_source_sha256: identity.journal_sha256,
        evidence_state: "HIERARCHY_PAIRED_LIABILITY_GAP_PROVEN",
        proof_status: "PROVEN",
        classification: "FINANCIAL_CORRECTION_PROVEN",
        correction_authority: "HIERARCHY_PAIRED_LIABILITY_SOURCE",
        correction_allowed: true,
        accepted_economic_reclass: true,
        accepted_amount: liabilityAmountCents / 100,
        ECONOMIC_ROUTE_PROVEN: true,
        SOURCE_OPERATION_PROVEN: true,
        PHYSICAL_SOURCE_UNIQUE: true,
        ECONOMIC_CORRECTION_PROVEN: true,
        partial_source_amount_proven: true,
        paired_liability_source_row_id: liabilityRowId,
        paired_liability_journal_sha256: liabilityJournalSha,
        paired_liability_source_range: text(liability.row?.["ERP строка"]),
        output_route: "SPORNO",
        processing_stage: "HIERARCHY_PAIRED_LIABILITY_RECLASS",
        stage_order: 1,
        source_rows: identity.source_range,
        reason: `Иерархия ${target.code}: отсутствующая классификация ${target.label} доказана парой расчётной и расходной проводок по организации, сотруднику и сумме`,
        solution: `Частичное STORNO из ${sourceArticle}; REPOST в ${target.label}; сумма подтверждена расчётной строкой ${liabilityRowId}`,
        notes: `Источник сверки SHA256=${text(reconciliationSha256)}; target row=${target.row.__row}; expense row=${sourceMatch.row.__row}; liability row=${liability.row.__row}`,
        source_article_missing: false,
      }));
    }
    if (local.length === group.unmatched.length
      && local.reduce((sum, item) => sum + cents(item.correction_amount), 0) === cents(delta)) {
      decisions.push(...local);
    }
  }
  return { decisions, blockers };
}

export function hierarchyContextByCode(treeRows = []) {
  const result = new Map();
  const stack = [];
  let currentBlock = "";
  for (const row of [...treeRows].sort((left, right) => Number(left?.__row ?? 0) - Number(right?.__row ?? 0))) {
    const code = structuralCode(row);
    if (!code) continue;
    const level = levelOf(row);
    const label = text(row?.["Строка ОПИУ / операция"]);
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (/БЛОК/i.test(text(row?.["Уровень"])) || text(row?.["Тип строки"]).toUpperCase() === "БЛОК") currentBlock = label;
    const path = [...stack.map((item) => item.label), label].filter(Boolean).join(" / ");
    const correctionLocation = text(row?.["Где исправить"]);
    const intalevReference = text(correctionLocation.match(/(?:^|\|)\s*Инталев:\s*(.*?)(?=\s*\|\s*ERP:|$)/i)?.[1]);
    result.set(code, Object.freeze({
      block: currentBlock,
      path,
      level,
      label,
      intalevReference,
      intalevAmount: amount(row?.["Инталев"]),
    }));
    stack.push({ level, label, code });
  }
  return result;
}

/**
 * The hierarchy sheet is authoritative only for an indisputable case:
 * a positive structural delta has exactly one direct, non-closing physical ERP
 * child with the same exact amount and complete immutable source identity.
 */
export async function deriveHierarchyExactAmountAuthority({
  treeRows = [],
  period = "",
  reconciliationOrganization = "",
  sourceArchiveSha256 = "",
  sourceSheet = "",
  reconciliationSha256 = "",
} = {}) {
  const ordered = [...treeRows].sort((left, right) => Number(left?.__row ?? 0) - Number(right?.__row ?? 0));
  const contexts = hierarchyContextByCode(ordered);
  const decisions = [];
  const blockers = [];
  const intergroupAuthority = deriveIntergroupPhysicalReclassificationAuthority({
    ordered,
    contexts,
    period,
    reconciliationOrganization,
    sourceArchiveSha256,
    sourceSheet,
    reconciliationSha256,
  });
  decisions.push(...intergroupAuthority.decisions);
  blockers.push(...intergroupAuthority.blockers);
  const residualAuthority = await deriveHierarchyResidualSettlementAuthority({
    ordered,
    contexts,
    period,
    reconciliationOrganization,
    sourceArchiveSha256,
    sourceSheet,
    reconciliationSha256,
  });
  decisions.push(...residualAuthority.decisions);
  blockers.push(...residualAuthority.blockers);
  for (let index = 0; index < ordered.length; index += 1) {
    const parent = ordered[index];
    const code = structuralCode(parent);
    const delta = targetDelta(parent);
    const parentLevel = levelOf(parent);
    const parentProof = text(parent?.["Комментарий / доказательство"]);
    if (!code || !(delta > 0) || !/structural status=HIERARCHY_PROVEN/i.test(parentProof)
      || intergroupAuthority.satisfiedStructuralCodes.has(code)
      || residualAuthority.satisfiedStructuralCodes.has(code)) continue;
    const article = text(parent?.["Строка ОПИУ / операция"]);
    const exact = [];
    for (let childIndex = index + 1; childIndex < ordered.length; childIndex += 1) {
      const child = ordered[childIndex];
      const childCode = structuralCode(child);
      const childLevel = levelOf(child);
      if (childCode && childLevel <= parentLevel) break;
      if (!physicalRow(child) || childLevel !== parentLevel + 1) continue;
      if ([child?.["Дт"], child?.["Кт"]].some((value) => canonicalAccount(value) === "99")) continue;
      if (Math.abs(cents(child?.["Физическая сумма"]) ?? 0) !== cents(delta)) continue;
      const identity = sourceIdentity(child, { article, sourceArchiveSha256, sourceSheet });
      if (identity.complete
        && !intergroupAuthority.consumedSourceRowIds.has(identity.source_row_id)
        && !residualAuthority.consumedSourceRowIds.has(identity.source_row_id)) exact.push({ row: child, identity });
    }
    if (exact.length !== 1) {
      blockers.push(Object.freeze({
        reconciliation_row: code,
        reason: exact.length ? "HIERARCHY_EXACT_AMOUNT_SOURCE_AMBIGUOUS" : "HIERARCHY_EXACT_AMOUNT_SOURCE_NOT_FOUND",
        candidate_count: exact.length,
      }));
      continue;
    }
    const { row, identity } = exact[0];
    const context = contexts.get(code) ?? { block: "", path: article };
    const pairId = stableId("PAIR-HIERARCHY", [period, code, identity.source_row_id, cents(delta)]);
    decisions.push(Object.freeze({
      case_id: stableId("HIERARCHY", [pairId, code]),
      pair_id: pairId,
      decision_type: "STORNO_REPOST",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      period: text(period),
      reconciliation_row: code,
      group: article,
      role: "HIERARCHY_EXACT_SOURCE",
      organization: text(reconciliationOrganization),
      reconciliation_organization: text(reconciliationOrganization),
      ...identity,
      correction_amount: Math.abs(delta),
      analytical_effect: delta,
      effective_delta: delta,
      analytical_basis_id: code,
      source_article: article,
      target_article: article,
      target_dt: identity.source_dt,
      target_analytics_dt1: identity.source_analytics_dt1,
      target_analytics_dt2: identity.source_analytics_dt2,
      target_analytics_dt3: identity.source_analytics_dt3,
      target_department_dt: identity.source_department_dt,
      target_kt: identity.source_kt,
      target_analytics_kt1: identity.source_analytics_kt1,
      target_analytics_kt2: identity.source_analytics_kt2,
      target_analytics_kt3: identity.source_analytics_kt3,
      target_department_kt: identity.source_department_kt,
      intalev_block: context.block,
      intalev_path: context.path,
      erp_source_sha256: identity.journal_sha256,
      evidence_state: "HIERARCHY_EXACT_AMOUNT_PROVEN",
      proof_status: "PROVEN",
      original_proof_status: text(row?.["Статус"]),
      classification: "FINANCIAL_CORRECTION_PROVEN",
      correction_authority: "HIERARCHY_EXACT_AMOUNT_SOURCE",
      correction_allowed: true,
      accepted_economic_reclass: true,
      accepted_amount: Math.abs(delta),
      ECONOMIC_ROUTE_PROVEN: true,
      SOURCE_OPERATION_PROVEN: true,
      PHYSICAL_SOURCE_UNIQUE: true,
      ECONOMIC_CORRECTION_PROVEN: true,
      output_route: "SPORNO",
      processing_stage: "HIERARCHY_EXACT_AMOUNT",
      stage_order: 1,
      source_rows: identity.source_range,
      reason: `Иерархия ${code}: дельта ${delta} точно равна единственной физической строке ERP ${identity.source_range}`,
      solution: `STORNO точной строки ${identity.source_row_id}; REPOST на одноимённую статью внутри блока ${context.block}`,
      notes: `Источник сверки SHA256=${text(reconciliationSha256)}; hierarchy row=${parent.__row}; physical row=${row.__row}`,
      source_article_missing: false,
    }));
  }
  const exactAmountDecisionCount = decisions.length
    - intergroupAuthority.decisions.length
    - residualAuthority.decisions.length;
  const pairedAuthority = derivePairedLiabilityClassificationAuthority({
    ordered,
    contexts,
    period,
    reconciliationOrganization,
    sourceArchiveSha256,
    sourceSheet,
    reconciliationSha256,
  });
  decisions.push(...pairedAuthority.decisions);
  blockers.push(...pairedAuthority.blockers);
  const arbitration = arbitrateOverlappingHierarchyAuthority(decisions);
  const actionableAuthorityCount = arbitration.decisions.filter((decision) =>
    decision?.ECONOMIC_CORRECTION_PROVEN === true && decision?.correction_allowed === true).length;
  return Object.freeze({
    schema_version: HIERARCHY_AUTHORITY_SCHEMA,
    decisions: arbitration.decisions,
    blockers: Object.freeze(blockers),
    covered_economic_route_case_ids: Object.freeze([...intergroupAuthority.coveredRouteCaseIds]),
    audit: Object.freeze({
      structural_rows_checked: ordered.filter((row) => structuralCode(row)).length,
      intergroup_physical_decisions: intergroupAuthority.decisions.length,
      intergroup_physical_route_cases: intergroupAuthority.coveredRouteCaseIds.size,
      hierarchy_residual_settlement_decisions: residualAuthority.decisions.length,
      exact_authority_decisions: exactAmountDecisionCount,
      paired_liability_decisions: pairedAuthority.decisions.length,
      hierarchy_physical_evidence_decisions: decisions.length,
      actionable_hierarchy_authority_decisions: actionableAuthorityCount,
      review_only_hierarchy_authority_decisions: decisions.length - actionableAuthorityCount,
      total_hierarchy_authority_decisions: actionableAuthorityCount,
      overlapping_authority_cases: arbitration.overlap_cases,
      overlapping_authority_review_only_decisions: arbitration.review_only_decisions,
      unresolved_positive_deltas: blockers.length,
    }),
  });
}
