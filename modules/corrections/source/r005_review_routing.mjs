import { decideReconciliationPipelineRows } from "../../reconciliation/source/reconciliation_decision_engine.mjs";
import {
  relevantIntalevAbsenceProof,
} from "../../reconciliation/source/intalev_source_scope.mjs";
import { isOwnerPresentationBlockExempt } from "../../reconciliation/source/owner_presentation_block_exemption.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return clean(value).toLocaleUpperCase("ru-RU");
}

function amountCents(value) {
  const number = typeof value === "number" ? value : Number(clean(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function normalized(value) {
  return clean(value).replace(/[«»"]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

function fileName(value) {
  return clean(value).split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function exactSourceIdentity(row) {
  return [
    clean(row?.source_row_id || row?.source_row),
    clean(row?.source_range),
    clean(row?.document || row?.registrar),
    clean(row?.posting_no ?? row?.posting_number),
  ].join("|");
}

function sourceRowId(row) {
  return clean(row?.source_row_id || row?.source_row);
}

function sourceCodeKeys(row) {
  return new Set([
    row?.code,
    row?.row_code,
    row?.exact_bound_r_code,
    row?.reconciliation_row,
    row?.reconciliation_row_code,
    row?.parent_code,
  ].map(clean).filter(Boolean));
}

function physicalIdentityComplete(row) {
  const sha = (value) => /^[A-F0-9]{64}$/i.test(clean(value));
  return sha(row?.erp_input_sha256)
    && sha(row?.erp_opiu_sha256)
    && sha(row?.journal_sha256)
    && clean(row?.journal_sheet)
    && /^B\d+:AG\d+$/i.test(clean(row?.source_range))
    && sha(sourceRowId(row))
    && clean(row?.date)
    && clean(row?.document || row?.registrar)
    && clean(row?.posting_no ?? row?.posting_number)
    && clean(row?.organization)
    && clean(row?.debit || row?.debit_account)
    && clean(row?.credit || row?.credit_account)
    && Array.isArray(row?.debit_analytics)
    && Array.isArray(row?.credit_analytics)
    && amountCents(row?.amount) !== null;
}

function operationRowsFor(payload, row) {
  const inline = [
    row?.operation_evidence_rows,
    row?.physical_source_rows,
    row?.source_operations,
    row?.source_operation,
  ].flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
  const rowIds = new Set([
    sourceRowId(row),
    ...(Array.isArray(row?.source_row_ids) ? row.source_row_ids : []),
  ].map(clean).filter(Boolean));
  const code = clean(row?.code || row?.row_code);
  const linked = (payload?.operation_evidence?.rows ?? []).filter((candidate) => {
    const keys = sourceCodeKeys(candidate);
    return (code && keys.has(code)) || (rowIds.size > 0 && rowIds.has(sourceRowId(candidate)));
  });
  const unique = new Map();
  for (const candidate of [...inline, ...linked]) {
    const identity = exactSourceIdentity(candidate);
    if (identity !== "|||") unique.set(identity, candidate);
  }
  return [...unique.values()];
}

function operationIsInPeriod(operation, period) {
  return !clean(operation?.period) || clean(operation.period) === clean(period);
}

function sourceMatchesRow(operation, row) {
  const expectedAmount = amountCents(row?.erp_amount ?? row?.intalev_amount ?? row?.delta);
  const actualAmount = amountCents(operation?.amount);
  if (expectedAmount !== null && actualAmount !== expectedAmount && actualAmount !== Math.abs(expectedAmount)) return false;
  const expectedArticle = clean(row?.erp_article || row?.article || row?.source_article);
  const actualArticle = clean(operation?.article || operation?.erp_article);
  if (expectedArticle && actualArticle && normalized(expectedArticle) !== normalized(actualArticle)) return false;
  return true;
}

function structuralRouteProven(row) {
  if (row?.economic_route_proven !== undefined) return row.economic_route_proven === true;
  if (row?.ECONOMIC_ROUTE_PROVEN !== undefined) return row.ECONOMIC_ROUTE_PROVEN === true;
  return row?.structural_non_posting !== true
    && row?.hierarchy_has_children !== true
    && row?.has_children !== true
    && row?.economic_route_blocked !== true;
}

function targetTemplateProof(row) {
  const template = row?.posting_template || row?.target_posting_template || {};
  const targetClassificationProven = row?.target_classification_proven === true
    || [row?.target_proof_status, row?.classification_proof_status, row?.target_classification_proof?.status]
      .some((value) => ["PROVEN", "EXACT"].includes(upper(value)));
  const templateProven = row?.posting_template_proven === true
    || row?.target_template_proven === true
    || [row?.posting_template_proof_status, row?.template_proof_status, row?.posting_template_proof?.status]
      .some((value) => ["PROVEN", "EXACT"].includes(upper(value)));
  const dt = clean(template.dt || template.debit || template.debit_account || row?.target_dt);
  const kt = clean(template.kt || template.credit || template.credit_account || row?.target_kt);
  const debitAnalytics = template.debit_analytics ?? template.analytics_dt ?? row?.target_debit_analytics;
  const creditAnalytics = template.credit_analytics ?? template.analytics_kt ?? row?.target_credit_analytics;
  const complete = Boolean(
    clean(row?.target_classification)
    && dt
    && kt
    && Array.isArray(debitAnalytics)
    && Array.isArray(creditAnalytics),
  );
  return {
    proven: targetClassificationProven && templateProven && complete,
    target_classification_proven: targetClassificationProven,
    posting_template_proven: templateProven,
    target_classification: clean(row?.target_classification),
    posting_template: complete ? { dt, kt, debit_analytics: debitAnalytics, credit_analytics: creditAnalytics } : null,
  };
}

/**
 * Route only the actionable parent residual left after mapping, structure and
 * reclass handling.  This is a draft route: it never creates posting rows.
 * Physical source proof follows the WORK-27 contract and is deliberately
 * matched by row identity, never by amount alone.
 */
export function routeOneSidedCorrections({
  organization = "",
  period = "",
  rows = [],
  residual_ledger: residualLedger = {},
  operation_evidence: operationEvidence = {},
  excluded_codes: excludedCodes = new Set(),
  tolerance = 0.01,
} = {}) {
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const ledgerRows = new Map((residualLedger?.rows ?? []).map((item) => [clean(item.code), item]));
  const excluded = excludedCodes instanceof Set ? excludedCodes : new Set(excludedCodes ?? []);
  const result = [];

  for (const row of rows) {
    const code = clean(row?.code || row?.row_code);
    if (!code || excluded.has(code) || row?.structural_non_posting === true || row?.hierarchy_has_children === true || row?.has_children === true) continue;
    const ledger = ledgerRows.get(code);
    const residual = amountCents(ledger?.parent_unallocated_residual);
    if (!ledger || ledger.integrity_status !== "PASS" || residual === null || Math.abs(residual) <= toleranceCents) continue;

    const explicitKind = upper(row?.one_sided_type || row?.correction_route);
    const kind = explicitKind === "ERP_ONLY" || row?.erp_only === true
      ? "ERP_ONLY"
      : explicitKind === "INTALEV_ONLY" || row?.intalev_only === true
        ? "INTALEV_ONLY"
        : row?.intalev_amount == null && row?.erp_amount != null
          ? "ERP_ONLY"
          : row?.erp_amount == null && row?.intalev_amount != null
            ? "INTALEV_ONLY"
            : "";
    if (!kind) continue;
    if (kind === "ERP_ONLY" && residual >= 0) continue;
    if (kind === "INTALEV_ONLY" && residual <= 0) continue;
    // Missing article classification is not proof that the economic amount is
    // absent from Intalev. ERP_ONLY requires a separate, explicit source-scope
    // absence proof; blank/unclassified source evidence remains non-financial.
    const intalevAbsenceProof = kind === "ERP_ONLY"
      ? relevantIntalevAbsenceProof(row)
      : null;
    if (kind === "ERP_ONLY" && !intalevAbsenceProof.proven) continue;
    const routeProven = structuralRouteProven(row);
    if (!routeProven) continue;

    const candidates = operationRowsFor({ operation_evidence: operationEvidence }, row)
      .filter((candidate) => operationIsInPeriod(candidate, period))
      .filter((candidate) => sourceMatchesRow(candidate, row));
    const exactCandidates = candidates.filter((candidate) =>
      candidate?.source_operation_proven === true
      && physicalIdentityComplete(candidate)
      && !/UNPROVEN|DISPUTED|CANDIDATE|BLOCKED/i.test(`${candidate?.proof_status ?? ""} ${candidate?.source_proof_status ?? ""}`),
    );
    const uniqueSourceIds = new Set(exactCandidates.map(sourceRowId));
    const physicalUnique = uniqueSourceIds.size === 1 && exactCandidates.length === 1;
    const sourceOperationProven = physicalUnique;
    const template = kind === "INTALEV_ONLY" ? targetTemplateProof(row) : null;
    const economicStornoDirectionProven = kind === "ERP_ONLY"
      && routeProven
      && intalevAbsenceProof.proven;
    const economicCorrectionProven = kind === "ERP_ONLY"
      ? economicStornoDirectionProven && sourceOperationProven
      : routeProven && template.proven;
    const physicalSourceDisputed = kind === "ERP_ONLY" && !sourceOperationProven;
    const disputed = !economicCorrectionProven || physicalSourceDisputed;
    const selected = physicalUnique ? exactCandidates[0] : null;
    const action = kind === "ERP_ONLY" ? "STORNO" : "REPOST";
    const caseId = `CASE-${kind}-${organization}-${period}-${code}`;
    const member = {
      code,
      role: kind,
      effective_delta: residual / 100,
      source_organization: selected?.organization || "",
      source_row_id: selected ? sourceRowId(selected) : undefined,
      source_range: selected?.source_range || "",
      source_date: selected?.date || "",
      registrar: selected?.document || selected?.registrar || "",
      posting_number: selected?.posting_no ?? selected?.posting_number ?? "",
      source_dt: selected?.debit || selected?.debit_account || "",
      source_kt: selected?.credit || selected?.credit_account || "",
      source_analytics_dt1: selected?.debit_analytics?.[0] || selected?.debit_analytics_1 || "",
      source_analytics_dt2: selected?.debit_analytics?.[1] || selected?.debit_analytics_2 || "",
      source_analytics_dt3: selected?.debit_analytics?.[2] || selected?.debit_analytics_3 || "",
      source_analytics_kt1: selected?.credit_analytics?.[0] || selected?.credit_analytics_1 || "",
      source_analytics_kt2: selected?.credit_analytics?.[1] || selected?.credit_analytics_2 || "",
      source_analytics_kt3: selected?.credit_analytics?.[2] || selected?.credit_analytics_3 || "",
      source_department_dt: selected?.debit_department || "",
      source_department_kt: selected?.credit_department || "",
      source_amount: selected?.amount ?? null,
      source_activity: selected?.activity || "",
      source_scenario: selected?.scenario || "",
      source_article: selected?.article || selected?.erp_article || "",
      source_archive_path: selected?.journal_input_path || "",
      source_archive_sha256: selected?.erp_input_sha256 || "",
      journal_entry: selected?.journal_archive_entry || fileName(selected?.journal_source || selected?.journal_input_path),
      journal_sha256: selected?.journal_sha256 || "",
      source_sheet: selected?.journal_sheet || "",
      economic_direction: action,
      target_classification: template?.target_classification || clean(row?.target_classification),
      posting_template: template?.posting_template || null,
    };
    const decision = {
      case_id: caseId,
      pair_id: `ONE_SIDE-${organization}-${period}-${code}`,
      classification: kind,
      decision_type: action,
      action,
      correction_route: action,
      status_text: disputed ? `DRAFT ${action} _СПОРНО` : `DRAFT ${action}`,
      amount: Math.abs(residual) / 100,
      correction_amount: Math.abs(residual) / 100,
      proof_status: economicCorrectionProven ? "ECONOMIC_CORRECTION_PROVEN" : "_СПОРНО",
      approval_state: economicCorrectionProven ? "ДОКАЗАНО_СВЕРКОЙ" : "ПРЕДЛОЖЕНО",
      correction_allowed: economicCorrectionProven,
      execution_allowed: false,
      review_only: kind === "ERP_ONLY" ? !economicStornoDirectionProven : !economicCorrectionProven,
      output_route: kind === "ERP_ONLY" && economicStornoDirectionProven && physicalSourceDisputed
        ? "SPORNO"
        : !economicCorrectionProven ? "REVIEW_ONLY" : "DRAFT",
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      financial_materialization_forbidden: kind === "ERP_ONLY"
        ? !economicStornoDirectionProven
        : !economicCorrectionProven,
      owner_review_required: disputed,
      OWNER_REVIEW_REQUIRED: disputed,
      economic_route_proven: routeProven,
      ECONOMIC_ROUTE_PROVEN: routeProven,
      source_operation_proven: sourceOperationProven,
      SOURCE_OPERATION_PROVEN: sourceOperationProven,
      physical_source_unique: physicalUnique,
      PHYSICAL_SOURCE_UNIQUE: physicalUnique,
      economic_correction_proven: economicCorrectionProven,
      ECONOMIC_CORRECTION_PROVEN: economicCorrectionProven,
      economic_storno_direction_proven: economicStornoDirectionProven,
      ECONOMIC_STORNO_DIRECTION_PROVEN: economicStornoDirectionProven,
      intalev_source_scope_presence: clean(row?.intalev_source_scope_presence),
      intalev_source_scope_absence_claimed: row?.intalev_source_scope_absence_claimed === true,
      intalev_source_scope_absence_proven: intalevAbsenceProof?.proven === true,
      intalev_source_scope_inventory_complete: intalevAbsenceProof?.source_inventory_complete === true,
      intalev_source_scope_complete: intalevAbsenceProof?.source_scope_complete === true,
      intalev_source_amount_lost: intalevAbsenceProof?.source_amount_lost ?? null,
      relevant_intalev_absence_proven: intalevAbsenceProof?.proven === true,
      relevant_intalev_absence_blockers: intalevAbsenceProof?.blockers ?? [],
      residual_integrity_status: ledger.integrity_status,
      reason: kind === "ERP_ONLY"
        ? physicalSourceDisputed
          ? `ERP_ONLY ${code}: экономический маршрут доказан, но единственный физический источник не подтверждён.`
          : `ERP_ONLY ${code}: отрицательный authoritative residual подтверждён единственной физической ERP-операцией.`
        : disputed
          ? `INTALEV_ONLY ${code}: точная целевая классификация и шаблон проводки не доказаны.`
          : `INTALEV_ONLY ${code}: положительный authoritative residual подтверждён точной целевой классификацией и шаблоном.` ,
      solution: kind === "ERP_ONLY" && economicStornoDirectionProven && physicalSourceDisputed
        ? `Сохранить явный DRAFT ${action} _СПОРНО без READY до точной проверки физического ERP-источника; posting_rows=0.`
        : !economicCorrectionProven
          ? `Оставить ${action} в REVIEW_ONLY; posting_rows=0.`
          : `Сохранить DRAFT ${action} в REPORT_ONLY; posting_rows=0 до отдельного owner gate.`,
      member_rows: [member],
    };
    result.push(decision);
  }
  return result;
}

export const routeGenericOneSidedCorrections = routeOneSidedCorrections;

function normalizedEvidence(row, payload) {
  return {
    sourceRange: clean(row?.source_row || row?.source_range || row?.source_row_id || row?.physical_row),
    registrar: clean(row?.registrar || row?.document),
    postingNumber: clean(row?.posting_number ?? row?.posting_no),
    debitAccount: clean(row?.debit_account || row?.debit),
    creditAccount: clean(row?.credit_account || row?.credit),
    sourceFile: clean(row?.source_file || row?.journal_input_path || payload.operation_evidence?.journal_input_path),
    proofStatus: clean(row?.proof_status),
    rowClass: clean(row?.row_class),
  };
}

function evidenceIsProven(rawRow, row) {
  const status = `${row.proofStatus} ${row.rowClass}`.toUpperCase();
  if (/NOT_PROVEN|UNPROVEN|CANDIDATE|EXCLUDED|BLOCKED/.test(status)) return false;
  const exact = Boolean(row.sourceRange && row.registrar && row.postingNumber && row.debitAccount && row.creditAccount);
  if (!exact) return false;
  if (/PROVEN|EXACT/.test(status)) return true;
  return Boolean(rawRow?.code && rawRow?.source_row && rawRow?.registrar && rawRow?.posting_number != null);
}

function evidenceByCode(payload, { organization, period }) {
  const result = new Map();
  for (const rawRow of payload.operation_evidence?.rows ?? []) {
    if (clean(rawRow.organization) !== organization || clean(rawRow.period) !== period) continue;
    const keys = [...new Set([rawRow.code, rawRow.row_code, rawRow.parent_code].map(clean).filter(Boolean))];
    const row = normalizedEvidence(rawRow, payload);
    row.proven = evidenceIsProven(rawRow, row);
    for (const key of keys) {
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    }
  }
  return result;
}

function toleranceFor(payload) {
  const tolerance = Number(payload.tolerance_rubles ?? payload.tolerance ?? 0.01);
  return Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.01;
}

function finiteAmount(value) {
  if (value === null || value === undefined || clean(value) === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function moneyCents(value) {
  const amount = finiteAmount(value);
  return amount === null ? null : Math.round(amount * 100);
}

const CONTROL_ONLY_ROLES = new Set([
  "ИТОГ",
  "БЛОК",
  "ПОДБЛОК",
  "ГРУППА",
  "РОДИТЕЛЬ",
  "TOTAL",
  "GROUP",
  "PARENT",
]);

function pathParts(value) {
  return clean(value).split("/").map((part) => clean(part).toLocaleLowerCase("ru-RU")).filter(Boolean);
}

function pathKey(value) {
  return pathParts(value).join("/");
}

function sourceTreeParentPaths(payload, selectedPeriod) {
  const periods = Array.isArray(payload?.hierarchy_periods) ? payload.hierarchy_periods : [];
  const exactPeriods = periods.filter((item) => clean(item?.period) === selectedPeriod);
  const hierarchyPeriod = exactPeriods.length === 1 ? exactPeriods[0] : null;
  const result = new Set();
  for (const tree of [hierarchyPeriod?.intalev_tree, hierarchyPeriod?.erp_tree]) {
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const nodePaths = new Set(nodes.map((node) => pathKey(node?.full_path)).filter(Boolean));
    for (const node of nodes) {
      const key = pathKey(node?.full_path);
      if (!key) continue;
      if (node?.is_group === true || hasChildren(node?.immediate_children)) result.add(key);
      const parts = pathParts(node?.full_path);
      const parentKey = parts.slice(0, -1).join("/");
      if (parentKey && nodePaths.has(parentKey)) result.add(parentKey);
    }
  }
  return result;
}

function structuralIndex(rows, payload, selectedPeriod) {
  const parentCodes = new Set();
  const parentNodeIds = new Set();
  for (const row of rows) {
    const parentCode = clean(row?.hierarchy_parent_code || row?.parent_code).toUpperCase();
    if (parentCode) parentCodes.add(parentCode);
    const parentNodeId = clean(row?.hierarchy_parent_node_id || row?.parent_node_id);
    if (parentNodeId) parentNodeIds.add(parentNodeId);
  }
  return {
    parentCodes,
    parentNodeIds,
    parentPaths: sourceTreeParentPaths(payload, selectedPeriod),
  };
}

function hasChildren(value) {
  return Array.isArray(value) && value.length > 0;
}

function unambiguousPath(value) {
  const values = Array.isArray(value) ? value : [value];
  const keys = [...new Set(values.map(pathKey).filter(Boolean))];
  return keys.length === 1 ? keys[0] : "";
}

function isControlOnlyRow(row, index) {
  if (
    row?.structural_non_posting === true
    || row?.hierarchy_has_children === true
    || row?.has_children === true
    || hasChildren(row?.hierarchy_immediate_children)
    || hasChildren(row?.immediate_children)
    || hasChildren(row?.child_codes)
    || hasChildren(row?.children)
  ) return true;

  const rowCode = clean(row?.code || row?.row_code).toUpperCase();
  if (rowCode && index.parentCodes.has(rowCode)) return true;
  const nodeId = clean(row?.hierarchy_node_id || row?.node_id);
  if (nodeId && index.parentNodeIds.has(nodeId)) return true;
  const rowPaths = [
    unambiguousPath(row?.intalev_paths),
    unambiguousPath(row?.erp_paths),
    pathKey(Array.isArray(row?.hierarchy_path) ? row.hierarchy_path.join(" / ") : row?.hierarchy_path),
  ].filter(Boolean);
  if (rowPaths.some((value) => index.parentPaths.has(value))) return true;

  return [row?.group, row?.hierarchy_group, row?.row_kind, row?.role]
    .map((value) => clean(value).toLocaleUpperCase("ru-RU"))
    .some((value) => CONTROL_ONLY_ROLES.has(value));
}

export function unprovenOneSideReviews(payload, options = {}) {
  const selectedOrganization = clean(options.organization || payload?.organization);
  const selectedPeriod = clean(options.period || payload?.period);
  const byCode = evidenceByCode(payload ?? {}, {
    organization: selectedOrganization,
    period: selectedPeriod,
  });
  const covered = new Set();
  const pairs = payload?.zero_sum_storno_repost_candidates?.length
    ? payload.zero_sum_storno_repost_candidates
    : payload?.operation_evidence?.pair_candidates ?? [];
  for (const pair of pairs) {
    for (const rowCode of [...(pair.source_codes ?? []), ...(pair.target_codes ?? [])]) covered.add(clean(rowCode));
  }

  const tolerance = toleranceFor(payload ?? {});
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const structure = structuralIndex(rows, payload, selectedPeriod);
  const decisionPlan = decideReconciliationPipelineRows({ rows, tolerance });
  const decisionByRowId = new Map(
    decisionPlan.rows.map((item) => [clean(item.row_id), item]),
  );
  const nonOneSidedClassifications = new Set([
    "HIERARCHY_REPAIR",
    "EMPTY_ARTICLE",
    "BINDING_REPAIR_CANDIDATE",
    "BINDING_REPAIR_PROVEN",
    "INTERNAL_RECLASS_CANDIDATE",
    "CROSS_BRANCH_RECLASS_CANDIDATE",
    "FINANCIAL_CORRECTION_PROVEN",
    "OWNER_PRESENTATION_BLOCK_EXEMPT",
    "CONTROL_ONLY",
    "CONTROL_ONLY_ZERO_PARENT_WITH_CHILD_DELTAS",
    "RECONCILED",
  ]);
  const result = [];
  const resultByBasis = new Map();
  for (const row of rows) {
    if (isOwnerPresentationBlockExempt(row)) continue;
    const rowCode = clean(row.code);
    const period = clean(row.period);
    const organization = clean(row.organization);
    if (!organization || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) continue;
    if (selectedOrganization && organization !== selectedOrganization) continue;
    if (selectedPeriod && period !== selectedPeriod) continue;

    const analyticalBasisId = clean(row.analytical_basis_id || rowCode);
    const erpAmount = finiteAmount(row.erp_amount);
    const intalevAmount = finiteAmount(row.intalev_amount);
    const delta = finiteAmount(row.delta);
    if (!row.is_discrepancy || !rowCode || covered.has(rowCode) || !Number.isFinite(delta) || Math.abs(delta) <= tolerance) continue;
    if (isControlOnlyRow(row, structure)) continue;
    const decision = decisionByRowId.get(rowCode);
    if (decision && nonOneSidedClassifications.has(decision.classification)) continue;
    const evidenceRows = byCode.get(rowCode) ?? [];
    if (evidenceRows.some((item) => item.proven)) continue;
    const trace = evidenceRows[0] ?? {};
    const sourceRanges = [...new Set(evidenceRows.map((item) => item.sourceRange).filter(Boolean))];
    const registrars = [...new Set(evidenceRows.map((item) => item.registrar).filter(Boolean))];
    const postingNumbers = [...new Set(evidenceRows.map((item) => item.postingNumber).filter(Boolean))];
    const basisContractBlockers = [];
    if (!analyticalBasisId) basisContractBlockers.push("MISSING_ANALYTICAL_BASIS_ID");
    if (erpAmount === null || intalevAmount === null) {
      basisContractBlockers.push("INCOMPLETE_R005_BASIS_TOTALS");
    } else if (moneyCents(delta) !== moneyCents(intalevAmount - erpAmount)) {
      basisContractBlockers.push("INVALID_R005_SIGNED_DELTA");
    }
    const basisContractValid = basisContractBlockers.length === 0;
    const basisSignature = [moneyCents(erpAmount), moneyCents(intalevAmount), moneyCents(delta)].join(":");
    const review = {
      rowCode,
      analyticalBasisId,
      caseId: `R005-UNPROVEN-${rowCode}`,
      pairId: `ONE_SIDE-${rowCode}`,
      period,
      organization,
      amount: Math.abs(delta),
      delta,
      erpAmount: basisContractValid ? erpAmount : null,
      intalevAmount: basisContractValid ? intalevAmount : null,
      basisContractValid,
      basisContractBlockers,
      sourceRange: sourceRanges.join(";") || `ROW:${rowCode}`,
      registrar: registrars.join(";") || "не определён",
      postingNumber: postingNumbers.join(";") || "не определён",
      debitAccount: trace.debitAccount || "",
      creditAccount: trace.creditAccount || "",
      sourceFile: trace.sourceFile || "",
      proofStatus: "UNPROVEN",
      reviewCategory: "Контроль",
      outputRoute: "КОНТРОЛЬ",
      reason: `Ненулевая дельта строки ${rowCode} (${delta}) не подтверждена точной исходной проводкой ERP.`,
      blockers: "нет доказанной строки ERP, регистратора, номера проводки, Дт/Кт и аналитик; пользовательское решение не получено",
      evidenceRows,
      classification: clean(decision?.classification) || "UNPROVEN_FINANCIAL_DELTA",
      correctionRoute: "REVIEW_ONLY",
      reviewOnly: true,
      executionAllowed: false,
      readyToUpload: false,
      releaseAllowed: false,
    };

    const existingBasis = resultByBasis.get(analyticalBasisId);
    if (existingBasis !== undefined) {
      const existing = result[existingBasis.index];
      if (existingBasis.signature === basisSignature
        && existing.organization === review.organization
        && existing.period === review.period) continue;
      existing.erpAmount = null;
      existing.intalevAmount = null;
      existing.basisContractValid = false;
      existing.basisContractBlockers = [...new Set([
        ...existing.basisContractBlockers,
        "CONFLICTING_R005_BASIS_TOTALS",
      ])];
      continue;
    }
    resultByBasis.set(analyticalBasisId, { index: result.length, signature: basisSignature });
    result.push(review);
  }
  return result;
}
