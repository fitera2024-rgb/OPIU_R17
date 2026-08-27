import crypto from "node:crypto";
import {
  assessConfiguredStructuralControlGroups,
  isOwnerPresentationBlockExempt,
  ownerPresentationBlockExemption,
} from "./owner_presentation_block_exemption.mjs";
import {
  serializeStructuralControlGroups,
  structuralControlGroupForCode,
  structuralControlGroupsFromConfig,
} from "./structural_control_groups.mjs";
import { detectGenericReclassifications } from "./generic_reclassification_detection.mjs";
import {
  isDescendantAllocationCompatible,
  isProvenResidualStatus,
  provenDescendantAllocation,
  residualProofStatus,
} from "./residual_allocation_proof.mjs";
import { routeOneSidedCorrections } from "../../corrections/source/r005_review_routing.mjs";
import { relevantIntalevAbsenceProof } from "./intalev_source_scope.mjs";

const EMPTY_LABELS = new Set(["", "<ПУСТОЕ ЗНАЧЕНИЕ>", "EMPTY", "UNCLASSIFIED"]);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
function upper(value) { return text(value).toLocaleUpperCase("ru-RU"); }
function norm(value) {
  return text(value).replace(/^\d+_/, "").replace(/[«»"]/g, "").toLocaleLowerCase("ru-RU");
}
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function cents(value) { const n = number(value); return n === null ? null : Math.round(n * 100); }
function money(value) { return value === null ? null : value / 100; }
function absoluteEqual(left, right, toleranceCents = 1) {
  return left !== null && right !== null && Math.abs(Math.abs(left) - Math.abs(right)) <= toleranceCents;
}
function stable(prefix, parts) {
  const digest = crypto.createHash("sha256").update(parts.map((part) => text(part)).join("|")).digest("hex").slice(0, 12).toUpperCase();
  return `${prefix}-${digest}`;
}
function rowCode(row) { return text(row?.code ?? row?.row_id); }
function parentCode(row) { return text(row?.presentation_parent_code ?? row?.hierarchy_parent_code ?? row?.parent_row_id); }
function rowMatchesScope(row, organization, period) {
  const authoritativeOrganization = text(row?.organization_id);
  if (authoritativeOrganization && authoritativeOrganization !== organization) return false;
  const organizations = [row?.organization_code, row?.organization].map(text).filter(Boolean);
  if (!authoritativeOrganization && organizations.length > 0 && !organizations.includes(organization)) return false;
  const authoritativePeriod = text(row?.month ?? row?.period_id);
  if (authoritativePeriod && authoritativePeriod !== period) return false;
  const periods = [row?.period].map(text).filter(Boolean);
  if (!authoritativePeriod && periods.length > 0 && !periods.includes(period)) return false;
  return true;
}
function sourceIdentity(source) {
  return [text(source?.sha256), text(source?.sheet), text(source?.source_cell ?? source?.row)].join("|");
}
function pathParts(value) { return text(value).split("/").map(norm).filter(Boolean); }
function pathLeaf(value) {
  const parts = text(value).split("/").map(text).filter(Boolean);
  return parts.at(-1) ?? "";
}
function suffixMatch(longPath, shortPath) {
  const longParts = pathParts(longPath);
  const shortParts = pathParts(shortPath);
  if (longParts.length === 0 || shortParts.length === 0 || shortParts.length > longParts.length) return false;
  for (let index = 1; index <= shortParts.length; index += 1) {
    if (longParts[longParts.length - index] !== shortParts[shortParts.length - index]) return false;
  }
  return true;
}
function rawDeltaCents(row) {
  const explicitRaw = cents(row?.raw_delta);
  if (explicitRaw !== null) return explicitRaw;
  const intalev = cents(row?.intalev_amount);
  const erp = cents(row?.erp_amount);
  if (intalev !== null && erp !== null) return intalev - erp;
  return cents(row?.delta);
}

function scenarioResidualAllocationCents(row) {
  const allocation = row?.residual_allocation;
  const explicit = [
    row?.scenario_hypothetical_consumption,
    row?.hypothetical_residual_allocation,
    typeof allocation === "object" ? allocation?.amount : null,
  ].map(cents).find((value) => value !== null);
  if (explicit === undefined || isProvenResidualStatus(row)) return null;
  const status = residualProofStatus(row);
  return status.includes("СПОРНО") || status.includes("DISPUT") || status.includes("UNPROVEN")
    ? explicit
    : null;
}

function buildGraph(rows) {
  const byCode = new Map(rows.map((row) => [rowCode(row), row]));
  const childrenByCode = new Map(rows.map((row) => [rowCode(row), []]));
  for (const row of rows) {
    const parent = parentCode(row);
    if (parent && byCode.has(parent)) childrenByCode.get(parent).push(rowCode(row));
  }
  function descendants(code) {
    const result = [];
    const visit = (current) => {
      for (const child of childrenByCode.get(current) ?? []) {
        result.push(child);
        visit(child);
      }
    };
    visit(code);
    return result;
  }
  return { byCode, childrenByCode, descendants };
}

function ownerConfirmedIntragroupScope(payload, organization, period, graph) {
  const confirmations = Array.isArray(payload?.owner_economic_intragroup_confirmations)
    ? payload.owner_economic_intragroup_confirmations
    : [];
  const proofBinding = payload?.economic_route_proof_binding;
  if (!proofBinding || typeof proofBinding !== "object" || Array.isArray(proofBinding)
    || text(proofBinding.status) !== "ACTIVE_EXPLICIT_RUN_BOUND_PROOF"
    || text(proofBinding.organization) !== organization
    || text(proofBinding.period) !== period
    || !text(proofBinding.run_id)
    || !text(proofBinding.approval_id)
    || !text(proofBinding.evidence_ref)
    || !/^[A-F0-9]{64}$/.test(text(proofBinding.input_sha256).toUpperCase())) {
    return [];
  }
  const scoped = confirmations.filter((confirmation) =>
    text(confirmation?.organization) === organization
      && text(confirmation?.period) === period);
  const idCounts = new Map();
  for (const confirmation of confirmations) {
    const id = text(confirmation?.confirmation_id);
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  return scoped.filter((confirmation) => {
    const id = text(confirmation?.confirmation_id);
    const rootCode = text(confirmation?.root_code);
    const descendantCodes = Array.isArray(confirmation?.descendant_codes)
      ? confirmation.descendant_codes.map(text).filter(Boolean)
      : [];
    const descendantMemberSetSha256 = crypto.createHash("sha256")
      .update(JSON.stringify({
        descendant_codes: [...descendantCodes]
          .sort((left, right) => left.localeCompare(right, "en")),
      }))
      .digest("hex")
      .toUpperCase();
    const routeId = text(confirmation?.intergroup_route_id);
    const routeBound = (proofBinding.routes ?? []).some((route) =>
      text(route?.route_id) === routeId
        && text(route?.status) === "BOUND_ECONOMIC_RECLASS_PROVEN");
    return Boolean(
      id
      && idCounts.get(id) === 1
      && rootCode
      && graph.byCode.has(rootCode)
      && descendantCodes.length > 0
      && new Set(descendantCodes).size === descendantCodes.length
      && !descendantCodes.includes(rootCode)
      && descendantCodes.every((code) => graph.byCode.has(code))
      && text(confirmation?.descendant_member_set_sha256).toUpperCase()
        === descendantMemberSetSha256
      && routeId
      && routeBound
      && text(confirmation?.run_id) === text(proofBinding.run_id)
      && text(confirmation?.authority_ref) === text(proofBinding.approval_id)
      && text(confirmation?.evidence_ref) === text(proofBinding.evidence_ref)
      && text(confirmation?.proof_input_sha256).toUpperCase()
        === text(proofBinding.input_sha256).toUpperCase()
      && text(confirmation?.economic_status) === "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS"
      && text(confirmation?.exact_allocation_status) === "BLOCKED_EXACT_ALLOCATION"
      && text(confirmation?.physical_erp_status) === "BLOCKED_PHYSICAL_ERP_PROOF",
    );
  });
}

function residualAtomId(row, organization, period) {
  return text(row?.residual_atom_id)
    || text(typeof row?.residual_allocation === "object" ? row.residual_allocation?.residual_atom_id : "")
    || stable("RESIDUAL-ATOM", [organization, period, rowCode(row)]);
}

function provenChildAllocation(parent, child, childEffectiveRawCents = rawDeltaCents(child)) {
  return provenDescendantAllocation(parent, child, {
    childEffectiveRawCents,
  });
}

function buildResidualLedger({
  rows,
  graph,
  authoritativeEffective,
  structuralControlEffects,
  intergroupReclassEffects,
  organization,
  period,
  toleranceCents,
}) {
  const records = new Map(rows.map((row) => {
    const code = rowCode(row);
    const raw = rawDeltaCents(row);
    const preIntergroup = authoritativeEffective.get(code) ?? raw;
    const structural = structuralControlEffects.get(code) ?? null;
    const structuralAmount = structural?.amount_cents ?? 0;
    const intergroup = intergroupReclassEffects.get(code) ?? null;
    const intergroupAmount = intergroup?.amount_cents ?? 0;
    const authoritative = preIntergroup === null ? null : preIntergroup - intergroupAmount;
    const mapping = raw !== null && authoritative !== null
      ? raw - structuralAmount - intergroupAmount - authoritative
      : 0;
    const intalevLiteral = cents(row?.intalev_amount);
    const erpLiteral = cents(row?.erp_amount);
    return [code, {
      residual_atom_id: residualAtomId(row, organization, period),
      code,
      transformation_id: intergroup?.candidate_id ?? null,
      intalev_literal: intalevLiteral === null ? null : money(intalevLiteral),
      erp_literal: erpLiteral === null ? null : money(erpLiteral),
      raw_delta: raw === null ? null : money(raw),
      consumed_by_proven_mapping: money(mapping),
      consumed_by_proven_reclass: 0,
      consumed_by_reclass: 0,
      consumed_by_proven_one_sided: 0,
      other_proven_consumption: 0,
      structural_control_effect: money(structuralAmount),
      structural_control_set_id: structural?.control_set_id ?? null,
      structural_control_classification: structural?.classification ?? null,
      consumed_by_intergroup_reclass: money(intergroupAmount),
      intergroup_reclass_effect: money(intergroupAmount),
      intergroup_reclass_candidate_id: intergroup?.candidate_id ?? null,
      intergroup_reclass_id: intergroup?.intergroup_reclass_id ?? null,
      intergroup_reclass_proof_status: intergroup?.proof_status ?? null,
      intergroup_reclass_role: intergroup?.role ?? null,
      intergroup_reclass_accepted_amount: intergroup?.accepted_amount_cents === undefined
        ? 0
        : money(intergroup.accepted_amount_cents),
      authoritative_effective_residual: authoritative === null ? null : money(authoritative),
      effective_delta: authoritative === null ? null : money(authoritative),
      consumed_by_descendants: 0,
      descendant_represented_residual: 0,
      parent_unallocated_residual: authoritative === null ? null : money(authoritative),
      scenario_hypothetical_consumption: 0,
      scenario_residual: authoritative === null ? null : money(authoritative),
      consumption_allocations: [],
      integrity_status: raw === null || authoritative === null
        || raw - mapping - structuralAmount - intergroupAmount === authoritative
        ? "PASS"
        : "RESIDUAL_INTEGRITY_FAILURE",
      blockers: [],
    }];
  }));
  const consumedAtoms = new Map();
  for (const record of records.values()) {
    if (record.consumed_by_proven_mapping !== 0) consumedAtoms.set(record.residual_atom_id, "PROVEN_MAPPING");
    if (record.consumed_by_intergroup_reclass !== 0) {
      consumedAtoms.set(record.residual_atom_id, `INTERGROUP:${record.intergroup_reclass_candidate_id}`);
    }
  }
  const decisionResidual = new Map([...records].map(([code, record]) => [
    code,
    cents(record.authoritative_effective_residual),
  ]));
  const representedParents = new Set();

  for (const parent of rows) {
    const parentRecord = records.get(rowCode(parent));
    if (!parentRecord) continue;
    const children = (graph.childrenByCode.get(rowCode(parent)) ?? [])
      .map((code) => graph.byCode.get(code))
      .filter(Boolean);
    if (children.length === 0 || parentRecord.authoritative_effective_residual === null) continue;
    const parentRaw = cents(parentRecord.authoritative_effective_residual);
    const structurallyClosed = parentRecord.structural_control_classification === "STRUCTURAL_GROUP_SUM_OK"
      && parentRaw === 0;
    const intergroupClosed = parentRecord.intergroup_reclass_candidate_id
      && parentRecord.intergroup_reclass_proof_status
      && parentRaw === 0;
    if (structurallyClosed || intergroupClosed) continue;
    const provenAllocations = [];
    let represented = 0;
    for (const child of children) {
      const childRaw = rawDeltaCents(child);
      const childAuthoritative = decisionResidual.get(rowCode(child)) ?? childRaw;
      const allocation = provenChildAllocation(parent, child, childAuthoritative);
      const scenario = scenarioResidualAllocationCents(child);
      if (scenario !== null) {
        parentRecord.scenario_hypothetical_consumption += money(scenario);
        parentRecord.scenario_residual = money(
          Math.round(Number(parentRecord.authoritative_effective_residual * 100) - scenario) / 100,
        );
      }
      if (!allocation) continue;
      if (!isDescendantAllocationCompatible({
        parentRawCents: parentRaw,
        representedCents: represented,
        allocation,
        toleranceCents,
      })) continue;
      const childRecord = records.get(rowCode(child));
      const atom = childRecord?.residual_atom_id;
      if (!childRecord || !atom) continue;
      if (consumedAtoms.has(atom)) {
        parentRecord.blockers.push("RESIDUAL_ATOM_DOUBLE_CONSUMPTION");
        continue;
      }
      consumedAtoms.set(atom, `DESCENDANT:${rowCode(parent)}`);
      represented += allocation.amount_cents;
      provenAllocations.push({
        child,
        childRecord,
        amount_cents: allocation.amount_cents,
        proof: allocation.proof,
        transformation_id: allocation.transformation_id,
      });
    }
    if (provenAllocations.length === 0) continue;
    const explicitTransformationIds = [...new Set(
      provenAllocations.map((item) => text(item.transformation_id)).filter(Boolean),
    )];
    const transformationId = explicitTransformationIds.length === 1
      ? explicitTransformationIds[0]
      : stable("TRANSFORM-RESIDUAL-PARTITION", [organization, period, rowCode(parent), ...provenAllocations.map((item) => `${rowCode(item.child)}:${item.amount_cents}`)]);
    parentRecord.transformation_id = transformationId;
    parentRecord.consumed_by_descendants = money(represented);
    parentRecord.descendant_represented_residual = money(represented);
    parentRecord.parent_unallocated_residual = money(parentRaw - represented);
    parentRecord.effective_delta = money(parentRaw - represented);
    parentRecord.consumption_allocations = provenAllocations.map((item) => ({
      transformation_id: transformationId,
      residual_atom_id: item.childRecord.residual_atom_id,
      child_code: rowCode(item.child),
      allocated_amount: money(item.amount_cents),
      proof: item.proof,
    }));
    if (Math.abs(parentRaw - represented) <= toleranceCents) {
      parentRecord.parent_unallocated_residual = 0;
      parentRecord.effective_delta = 0;
      decisionResidual.set(rowCode(parent), 0);
      representedParents.add(rowCode(parent));
    } else {
      decisionResidual.set(rowCode(parent), parentRaw - represented);
    }
  }
  for (const record of records.values()) {
    const raw = cents(record.raw_delta);
    const mapping = cents(record.consumed_by_proven_mapping) ?? 0;
    const reclass = cents(record.consumed_by_reclass) ?? 0;
    const descendants = cents(record.consumed_by_descendants) ?? 0;
    const structural = cents(record.structural_control_effect) ?? 0;
    const intergroup = cents(record.consumed_by_intergroup_reclass) ?? 0;
    const effective = cents(record.effective_delta);
    if (raw !== null && effective !== null
      && raw - mapping - reclass - intergroup - descendants - structural !== effective) {
      record.integrity_status = "RESIDUAL_INTEGRITY_FAILURE";
      record.blockers.push("RAW_RESIDUAL_CONSERVATION_MISMATCH");
    }
  }
  return {
    schema: "opiu-authoritative-residual-ledger.v1",
    rows: [...records.values()],
    decisionResidual,
    representedParents,
  };
}

export function assertResidualDecisionIntegrity({ amount, residual_amount, tolerance = 0.01 } = {}) {
  const amountCents = cents(amount);
  const residualCents = cents(residual_amount);
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const ok = amountCents !== null && residualCents !== null
    && Math.abs(amountCents - residualCents) <= toleranceCents;
  return ok
    ? { ok: true, classification: "PASS" }
    : {
        ok: false,
        classification: "RESIDUAL_INTEGRITY_FAILURE",
        financial_materialization_forbidden: true,
        blocker: "OWNER_DECISION_AMOUNT_DOES_NOT_RECONCILE_TO_RESIDUAL_LEDGER",
      };
}

// Owner arithmetic operates on residual allocations, never on a child's full
// Intalev/ERP balance. A parent is normalized to zero only after the child
// residual allocations form an exact, proven partition. Source overlap is
// accepted as evidence for the child's raw residual, not for its full balance.
function normalizedDeltaCents(row, graph) {
  const raw = rawDeltaCents(row);
  // Keep the authoritative residual immutable. The owner decision layer
  // records descendant representation separately and suppresses only the
  // parent's financial action when that representation is valid.
  return raw;
}

function findUnclassifiedNode(payload, period, amountCents) {
  const periodTree = (payload?.hierarchy_periods ?? []).find((item) => text(item?.period) === period);
  const nodes = periodTree?.intalev_tree?.nodes ?? [];
  return nodes.find((node) => {
    if (!EMPTY_LABELS.has(upper(node?.name ?? node?.label))) return false;
    if (cents(node?.direct_total) !== amountCents) return false;
    const status = upper(node?.hierarchy_status ?? node?.validation_status ?? node?.status);
    return !status || ["PASS", "LEAF", "VALID", "PROVEN"].some((token) => status.includes(token));
  }) ?? null;
}

function exactSourceRowId(value) {
  return text(
    value?.source_row_id
      ?? value?.source_operation_identity
      ?? value?.operation_identity,
  );
}

function provenBlankArticleClassificationCases(rows) {
  const result = [];
  for (const row of rows) {
    const presence = upper(row?.intalev_source_scope_presence);
    if (!["PRESENT_UNCLASSIFIED", "PRESENT_UNCLASSIFIED_UNBOUND"].includes(presence)) continue;
    const erpAmountCents = cents(row?.erp_amount);
    if (erpAmountCents === null || Math.abs(erpAmountCents) === 0) continue;
    const blankCandidates = (Array.isArray(row?.unclassified_offset_candidates)
      ? row.unclassified_offset_candidates
      : [])
      .filter((candidate) => cents(candidate?.amount) === Math.abs(erpAmountCents)
        && EMPTY_LABELS.has(upper(candidate?.article)));
    if (blankCandidates.length !== 1) continue;

    const proof = row?.same_erp_posting_proof;
    if (upper(proof?.status) !== "SAME_ERP_POSTING_PROVEN") continue;
    const proofSourceRowId = exactSourceRowId(proof);
    if (!proofSourceRowId) continue;

    const exactErpSources = (Array.isArray(row?.erp_sources) ? row.erp_sources : [])
      .filter((source) => {
        const status = upper(source?.source_proof_status ?? source?.proof_status);
        return exactSourceRowId(source) === proofSourceRowId
          && cents(source?.amount) === Math.abs(erpAmountCents)
          && source?.source_operation_proven === true
          && ["SOURCE_OPERATION_PROVEN", "PROVEN"].includes(status)
          && text(source?.article ?? row?.erp_article);
      });
    const uniqueErpSources = new Map(exactErpSources.map((source) => [
      exactSourceRowId(source), source,
    ]));
    if (uniqueErpSources.size !== 1) continue;

    const source = [...uniqueErpSources.values()][0];
    const candidate = blankCandidates[0];
    const code = rowCode(row);
    const raw = rawDeltaCents(row);
    const erpArticle = text(source?.article ?? row?.erp_article);
    const intalevAmount = money(Math.abs(erpAmountCents));
    result.push({
      case_id: stable("CASE-BLANK-ARTICLE-SAME-ERP-POSTING", [
        row?.organization,
        row?.period,
        code,
        proofSourceRowId,
        erpAmountCents,
      ]),
      pair_id: stable("PAIR-BLANK-ARTICLE-SAME-ERP-POSTING", [
        row?.period,
        code,
        proofSourceRowId,
      ]),
      classification: "SOURCE_CLASSIFICATION_GAP",
      decision_type: "NO_POSTING",
      status_text: "ИНТАЛЕВ: ПУСТАЯ СТАТЬЯ / ERP: СТАТЬЯ ЗАПОЛНЕНА / БЕЗ ПРОВОДКИ",
      amount: intalevAmount,
      proof_status: "SAME_ERP_POSTING_PROVEN",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      correction_allowed: false,
      execution_allowed: false,
      financial_rows: 0,
      posting_rows: 0,
      intalev_article: "",
      intalev_amount: intalevAmount,
      intalev_source_path: text(candidate?.source_path ?? candidate?.full_path),
      intalev_source_row: candidate?.source_row ?? candidate?.row ?? null,
      erp_article: erpArticle,
      erp_amount: intalevAmount,
      source_row_id: proofSourceRowId,
      same_erp_posting_proven: true,
      reason: `Инталев: статья пустая, сумма ${intalevAmount}; ERP: статья ${erpArticle}, сумма ${intalevAmount}; та же ERP-проводка ${proofSourceRowId} доказана.`,
      solution: "Сохранить классификационное расхождение в отчёте; финансовую корректировку не создавать.",
      mapping_effects: raw === null ? [] : [{ code, amount_cents: raw }],
      member_rows: [{
        code,
        role: "INTALEV_EMPTY_ARTICLE_MAPPING",
        raw_delta: raw === null ? null : money(raw),
        effective_delta: 0,
        intalev_article: "",
        intalev_amount: intalevAmount,
        intalev_source_path: text(candidate?.source_path ?? candidate?.full_path),
        intalev_source_row: candidate?.source_row ?? candidate?.row ?? null,
        erp_article: erpArticle,
        erp_amount: intalevAmount,
        source_row_id: proofSourceRowId,
        source_operation_identity: proofSourceRowId,
        source_organization: text(
          source?.source_organization ?? source?.organization_id ?? source?.organization,
        ),
      }],
    });
  }
  return result;
}

function acceptedClassificationCases(payload, rows, ownerAcceptancePolicy) {
  const organization = text(payload?.organization);
  const period = text(payload?.period);
  const result = [];
  for (const policy of ownerAcceptancePolicy ?? []) {
    if (text(policy?.organization) !== organization || text(policy?.period) !== period) continue;
    if (upper(policy?.decision) !== "ACCEPT_ERP_CLASSIFICATION") continue;
    const amountCents = cents(policy?.amount);
    if (amountCents === null) continue;
    const unclassified = findUnclassifiedNode(payload, period, amountCents);
    if (!unclassified) continue;
    const matches = [];
    for (const row of rows) {
      if (cents(row?.erp_amount) !== amountCents || number(row?.intalev_amount) !== null) continue;
      const exactSources = (row?.erp_sources ?? []).filter((source) =>
        cents(source?.amount) === amountCents && norm(source?.catalog_path) === norm(policy?.erp_catalog_path),
      );
      const unique = new Map(exactSources.map((source) => [sourceIdentity(source), source]));
      if (unique.size === 1) matches.push({ row, source: [...unique.values()][0] });
    }
    if (matches.length !== 1) continue;
    const { row, source } = matches[0];
    const code = rowCode(row);
    const targetArticle = pathLeaf(source?.catalog_path || policy?.erp_catalog_path);
    const classification = upper(policy?.classification) || "ACCEPTED_CLASSIFICATION";
    const decisionType = upper(policy?.decision_type) || "NO_POSTING";
    const mappingGap = classification === "SOURCE_CLASSIFICATION_GAP" && decisionType === "UPDATE_MAPPING";
    const erpArticle = text(row?.erp_article) || targetArticle;
    const intalevCurrentClassification = text(row?.intalev_current_classification)
      || text(unclassified?.name ?? unclassified?.label)
      || text(policy?.intalev_article);
    const targetClassification = text(source?.catalog_path || policy?.erp_catalog_path);
    result.push({
      case_id: stable("CASE-ACCEPTED-CLASSIFICATION", [organization, period, amountCents, policy?.erp_catalog_path]),
      pair_id: stable("PAIR-ACCEPTED", [period, amountCents, policy?.erp_catalog_path]),
      classification,
      decision_type: decisionType,
      status_text: mappingGap ? `ИСПРАВИТЬ КЛАССИФИКАЦИЮ ИНТАЛЕВ → ${text(policy?.target_code) || code}` : "ПРИНЯТОЕ РАСХОЖДЕНИЕ / БЕЗ КОРРЕКТИРОВКИ",
      amount: money(amountCents),
      proof_status: "PROVEN",
      approval_state: "УТВЕРЖДЕНО",
      correction_allowed: false,
      execution_allowed: false,
      reason: text(policy?.reason) || "В ERP сумма уже отражена по правильной статье, а в Инталев находится в <пустое значение>. Требуется исправить только классификацию Инталев.",
      solution: text(policy?.solution) || "Перенести классификацию Инталев в целевую статью; ERP-проводки не изменять.",
      source_article_missing: false,
      source_article: erpArticle,
      target_article: targetArticle,
      target_code: text(policy?.target_code) || code,
      erp_article: erpArticle,
      intalev_current_classification: intalevCurrentClassification,
      target_classification: targetClassification,
      erp_source_sha256: text(source?.sha256).toUpperCase(),
      member_rows: [{
        code,
        role: mappingGap ? "INTALEV_MAPPING_TARGET" : "ACCEPTED_ERP_CLASSIFICATION",
        effective_delta: 0,
        source_amount: money(amountCents),
        source_ref: `${text(source?.sheet)}!${text(source?.source_cell)}`,
        source_article_missing: false,
        source_article: erpArticle,
        target_article: targetArticle,
        target_code: text(policy?.target_code) || code,
        erp_article: erpArticle,
        intalev_current_classification: intalevCurrentClassification,
        target_classification: targetClassification,
      }],
      accepted_adjustments: [{ code, amount_cents: amountCents, parent_code: parentCode(row) }],
    });
  }
  return result;
}

function exactBindingHit(row, rows, effectiveDeltaCents, toleranceCents) {
  if (effectiveDeltaCents === null || Math.abs(effectiveDeltaCents) <= toleranceCents) return null;
  const target = Math.abs(effectiveDeltaCents);
  const intalevCandidates = (row?.intalev_sources ?? []).filter((source) =>
    cents(source?.amount) === target && text(source?.full_path),
  );
  if (intalevCandidates.length === 0) return null;

  // Search only already-reconciled rows. The exact source identity and exact structural suffix
  // must be unique. This is a binding proof, not a name/amount fuzzy match.
  const hits = [];
  for (const evidenceRow of rows) {
    const evidenceDelta = rawDeltaCents(evidenceRow);
    if (evidenceDelta === null || Math.abs(evidenceDelta) > toleranceCents) continue;
    for (const erpSource of evidenceRow?.erp_sources ?? []) {
      if (cents(erpSource?.amount) !== target || !text(erpSource?.catalog_path)) continue;
      const intalevSource = intalevCandidates.find((source) => suffixMatch(source?.full_path, erpSource?.catalog_path));
      if (!intalevSource) continue;
      hits.push({ evidenceRow, erpSource, intalevSource });
    }
  }
  const byIdentity = new Map(hits.map((hit) => [sourceIdentity(hit.erpSource), hit]));
  if (byIdentity.size !== 1) return null;
  const hit = [...byIdentity.values()][0];
  return {
    row_code: rowCode(row),
    amount_cents: target,
    source_identity: sourceIdentity(hit.erpSource),
    erp_source_sha256: text(hit.erpSource?.sha256).toUpperCase(),
    source_ref: `${text(hit.erpSource?.sheet)}!${text(hit.erpSource?.source_cell)}`,
    catalog_path: text(hit.erpSource?.catalog_path),
    evidence_row_code: rowCode(hit.evidenceRow),
    intalev_path: text(hit.intalevSource?.full_path),
  };
}

function exactSourceHierarchyBindingProof(row, toleranceCents) {
  const proof = row?.erp_hierarchy_binding_proof;
  const acceptedStatuses = new Set([
    "PROVEN_ERP_PRESENTATION_PARENT",
    "PROVEN_ERP_PARENT_COMPOSITION",
    "PROVEN_ERP_PARENT_COMPOSITION_ALIAS",
  ]);
  if (
    text(row?.mapping_proof_status) !== "BINDING_REPAIR_PROVEN" ||
    text(row?.mapping_decision_type) !== "UPDATE_MAPPING" ||
    !acceptedStatuses.has(text(proof?.status)) ||
    proof?.binding_repair_required !== true ||
    proof?.correction_authority !== false ||
    Number(proof?.posting_rows) !== 0
  ) return null;
  const rawDelta = rawDeltaCents(row);
  const intalev = cents(row?.intalev_amount);
  const erp = cents(row?.erp_amount);
  if (
    rawDelta === null || Math.abs(rawDelta) > toleranceCents ||
    intalev === null || erp === null || intalev !== erp
  ) return null;
  const sourceCells = [...new Set([
    proof?.source_cell,
    proof?.alias_source_cell,
    ...(proof?.component_source_cells ?? []),
  ].map(text).filter(Boolean))];
  if (sourceCells.length === 0 || sourceCells.some((cell) => !/^[A-Z]+\d+$/.test(cell))) {
    return null;
  }
  const exactSources = [
    ...(row?.erp_sources ?? []),
    ...(row?.erp_normalization_sources ?? []),
  ];
  const availableCells = new Set(exactSources.map((source) => text(source?.source_cell)).filter(Boolean));
  if (sourceCells.some((cell) => !availableCells.has(cell))) return null;
  const sourceSHA256 = [...new Set(exactSources
    .filter((source) => sourceCells.includes(text(source?.source_cell)))
    .map((source) => text(source?.sha256).toUpperCase())
    .filter((sha) => /^[0-9A-F]{64}$/.test(sha)))];
  if (sourceSHA256.length !== 1) return null;
  return {
    status: text(proof.status),
    source_cells: sourceCells,
    source_sha256: sourceSHA256[0],
  };
}

function integrityForDecisionCase(decisionCase, projection) {
  const members = decisionCase?.member_rows ?? [];
  if (decisionCase?.decision_type === "UPDATE_MAPPING") return { ok: true, classification: "PASS" };
  const ledgerRows = new Map((projection?.residual_ledger?.rows ?? []).map((item) => [item.code, item]));
  if (decisionCase?.accepted_intergroup_reclass === true
    && decisionCase?.reclass_scope === "INTER_GROUP") {
    const effects = members.map((member) => {
      const ledger = ledgerRows.get(rowCode(member));
      return {
        effect: cents(member?.accepted_intergroup_effect),
        ledgerEffect: cents(ledger?.consumed_by_intergroup_reclass),
        rootEffective: cents(member?.root_effective_delta),
        ledgerEffective: cents(ledger?.effective_delta),
      };
    });
    if (effects.some((item) => item.effect === null || item.ledgerEffect === null
      || item.rootEffective === null || item.ledgerEffective === null
      || item.effect !== item.ledgerEffect || item.rootEffective !== item.ledgerEffective)) {
      return {
        ok: false,
        classification: "RESIDUAL_INTEGRITY_FAILURE",
        financial_materialization_forbidden: true,
        blocker: "INTERGROUP_EFFECT_DOES_NOT_RECONCILE_TO_RESIDUAL_LEDGER",
      };
    }
    const sourceAmount = effects
      .filter((item) => item.effect < 0)
      .reduce((sum, item) => sum - item.effect, 0);
    return assertResidualDecisionIntegrity({
      amount: decisionCase?.amount,
      residual_amount: money(sourceAmount),
    });
  }
  if (["STORNO", "REPOST"].includes(decisionCase?.decision_type) && members.length === 1) {
    const ledger = ledgerRows.get(rowCode(members[0]));
    return assertResidualDecisionIntegrity({
      amount: decisionCase?.amount,
      residual_amount: ledger?.parent_unallocated_residual === null
        || ledger?.parent_unallocated_residual === undefined
        ? ledger?.parent_unallocated_residual
        : Math.abs(ledger.parent_unallocated_residual),
    });
  }
  if (members.length === 1 && members[0]?.role === "REVIEW") {
    const ledger = ledgerRows.get(rowCode(members[0]));
    return assertResidualDecisionIntegrity({
      amount: decisionCase?.amount,
      residual_amount: ledger?.parent_unallocated_residual === null
        || ledger?.parent_unallocated_residual === undefined
        ? ledger?.parent_unallocated_residual
        : Math.abs(ledger.parent_unallocated_residual),
    });
  }
  if (members.length === 0) return { ok: true, classification: "PASS" };
  const signedResiduals = members.map((member) => {
    const ledger = ledgerRows.get(rowCode(member));
    const residual = cents(ledger?.parent_unallocated_residual);
    const memberDelta = cents(member?.effective_delta ?? member?.normalized_delta);
    return { residual, memberDelta };
  });
  if (signedResiduals.some((item) => item.residual === null || item.memberDelta === null
    || Math.abs(item.residual - item.memberDelta) > 1)) {
    return {
      ok: false,
      classification: "RESIDUAL_INTEGRITY_FAILURE",
      financial_materialization_forbidden: true,
      blocker: "OWNER_DECISION_MEMBER_DOES_NOT_RECONCILE_TO_RESIDUAL_LEDGER",
    };
  }
  const sourceAmount = signedResiduals
    .filter((item) => item.memberDelta < 0)
    .reduce((sum, item) => sum - item.memberDelta, 0);
  return assertResidualDecisionIntegrity({
    amount: decisionCase?.amount,
    residual_amount: money(sourceAmount),
  });
}

function dedupeParentSameDelta(candidates, graph) {
  const byCode = new Map(candidates.map((candidate) => [candidate.code, candidate]));
  const skip = new Set();
  for (const candidate of candidates) {
    for (const descendant of graph.descendants(candidate.code)) {
      const child = byCode.get(descendant);
      if (child && child.delta_cents === candidate.delta_cents) {
        skip.add(candidate.code);
        break;
      }
    }
  }
  return candidates.filter((candidate) => !skip.has(candidate.code));
}

function sourceOnlyCandidates(rows, graph, effective, toleranceCents) {
  const result = [];
  for (const row of rows) {
    if (number(row?.intalev_amount) !== null) continue;
    const erpCents = cents(row?.erp_amount);
    if (erpCents === null || Math.abs(erpCents) <= toleranceCents) continue;
    const parent = graph.byCode.get(parentCode(row));
    if (!parent) continue;
    const parentDelta = effective.get(rowCode(parent));
    if (parentDelta === null || Math.abs(parentDelta) <= toleranceCents) continue;
    if (!absoluteEqual(parentDelta, erpCents, toleranceCents) || Math.sign(parentDelta) !== -Math.sign(erpCents)) continue;
    const exactErpSources = (row?.erp_sources ?? []).filter((source) => cents(source?.amount) === erpCents);
    const unique = new Map(exactErpSources.map((source) => [sourceIdentity(source), source]));
    if (unique.size !== 1) continue;
    result.push({
      code: rowCode(row),
      delta_cents: -erpCents,
      row,
      detection_only: true,
      source_ref: `${text([...unique.values()][0]?.sheet)}!${text([...unique.values()][0]?.source_cell)}`,
    });
  }
  return result;
}

function existingReconciledAmountRow(rows, amountCents, toleranceCents) {
  return rows.find((row) =>
    Math.abs(rawDeltaCents(row) ?? Number.MAX_SAFE_INTEGER) <= toleranceCents
      && cents(row?.intalev_amount) === amountCents
      && cents(row?.erp_amount) === amountCents,
  ) ?? null;
}

export function projectOwnerEconomicDecisions(payload, {
  ownerAcceptancePolicy = [],
  tolerance = 0.01,
} = {}) {
  const selectedOrganization = text(payload?.organization);
  const structuralControlGroups = structuralControlGroupsFromConfig({
    tolerance,
    structural_group_control_sets: payload?.structural_group_control_sets ?? [],
  }, { organization: selectedOrganization });
  const selectedPeriod = text(payload?.period);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedPeriod) && Array.isArray(payload?.period_rows)) {
    const periodGroups = new Map();
    for (const item of payload.period_rows) {
      const period = text(item?.period);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !Array.isArray(item?.rows)) continue;
      if (!periodGroups.has(period)) periodGroups.set(period, []);
      periodGroups.get(period).push(item);
    }
    const partitions = [...periodGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([period, entries]) => {
        const duplicate = entries.length !== 1;
        const projected = projectOwnerEconomicDecisions({
        ...payload,
        period,
        periods: [period],
        rows: duplicate ? [] : entries[0].rows,
        period_rows: undefined,
        intalev_source_scope: duplicate ? null : entries[0].intalev_source_scope ?? null,
        intalev_source_scopes: duplicate
          ? []
          : [entries[0].intalev_source_scope].filter(Boolean),
        }, { ownerAcceptancePolicy, tolerance });
        if (!duplicate) return projected;
        projected.owner_control_groups = projected.owner_control_groups.map((control) => ({
          ...control,
          classification: "OWNER_CONTROL_GROUP_DUPLICATE_PERIOD_PARTITION",
          complete: false,
          blockers: [...new Set([...(control.blockers ?? []), "OWNER_CONTROL_PERIOD_PARTITION_DUPLICATE"])],
        }));
        return projected;
      });
    const periodRowLinks = Object.fromEntries(partitions.map((item) => [item.period, item.row_links]));
    const periodRowCoverage = Object.fromEntries(
      partitions.map((item) => [item.period, item.owner_projection_coverage ?? {}]));
    const genericCandidates = partitions.flatMap(
      (item) => item.generic_reclassification?.candidates ?? [],
    );
    return {
      schema: "opiu-owner-economic-decisions.v2",
      organization: text(payload?.organization),
      period: selectedPeriod,
      periods: partitions.map((item) => item.period),
      intalev_source_scopes: partitions
        .map((item) => item.intalev_source_scope)
        .filter(Boolean),
      cases: partitions.flatMap((item) => item.cases),
      residual_ledger: {
        schema: "opiu-authoritative-residual-ledger.v1",
        rows: partitions.flatMap((item) => item.residual_ledger?.rows ?? []),
      },
      integrity_failures: partitions.flatMap((item) => item.integrity_failures ?? []),
      generic_reclassification: {
        schema: "opiu-generic-reclassification-detection-v1",
        mechanism: "INTERGROUP_ROOTS_FIRST_THEN_INTRAGROUP_DESCENDANTS",
        candidates: genericCandidates,
        partitions: partitions.flatMap(
          (item) => item.generic_reclassification?.partitions ?? [],
        ),
        unmatched_residuals: partitions.flatMap(
          (item) => item.generic_reclassification?.unmatched_residuals ?? [],
        ),
        audit: {
          processing_order: ["INTERGROUP_ROOTS_FIRST", "INTRAGROUP_DESCENDANTS_SECOND"],
          accepted_intergroup_count: genericCandidates.filter((candidate) =>
            candidate.accepted_intergroup_reclass === true).length,
          duplicate_root_correction_count: partitions.reduce((sum, item) =>
            sum + Number(item.generic_reclassification?.audit?.duplicate_root_correction_count ?? 0), 0),
        },
        safety: {
          report_only: true, correction_allowed: false, financial_rows: 0,
          posting_rows: 0, add_one_side_rows: 0, storno_rows: 0,
          repost_rows: 0, ready_to_upload: false, release_allowed: false,
          live_1c_allowed: false,
        },
      },
      owner_control_groups: partitions.flatMap(
        (item) => item.owner_control_groups ?? [],
      ),
      structural_group_control_sets:
        serializeStructuralControlGroups(structuralControlGroups),
      structural_group_control_results: partitions.flatMap(
        (item) => item.structural_group_control_results ?? item.owner_control_groups ?? [],
      ),
      owner_confirmed_intragroup_reviews: partitions.flatMap(
        (item) => item.owner_confirmed_intragroup_reviews ?? [],
      ),
      presentation_block_exemptions: partitions.flatMap(
        (item) => item.presentation_block_exemptions ?? [],
      ),
      row_links: Object.fromEntries(partitions.flatMap((item) =>
        Object.entries(item.row_links).map(([code, ids]) => [`${item.period}|${code}`, ids]))),
      period_row_links: periodRowLinks,
      owner_projection_coverage: Object.fromEntries(partitions.flatMap((item) =>
        Object.entries(item.owner_projection_coverage ?? {}).map(
          ([code, coverage]) => [`${item.period}|${code}`, coverage]))),
      period_row_coverage: periodRowCoverage,
      safety: {
        report_only: true, posting_rows: 0, add_one_side_rows: 0,
        storno_rows: 0, repost_rows: 0, execution_allowed: false,
        executed_posting_rows: 0, live_posting_rows: 0,
        presentation_block_exempt_financial_rows: 0,
        owner_control_group_financial_rows: 0,
        ready_to_upload: false, release_allowed: false, live_1c_allowed: false,
        live_delete_allowed: false,
      },
    };
  }
  const inputRows = Array.isArray(payload?.rows) ? payload.rows : [];
  const rows = /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedPeriod)
    ? inputRows.filter((row) => rowMatchesScope(row, selectedOrganization, selectedPeriod))
    : inputRows;
  const graph = buildGraph(rows);
  let ownerControlGroups = [...assessConfiguredStructuralControlGroups(
    rows.map((row) => ({
      ...row,
      organization: text(row?.organization) || selectedOrganization,
      period: text(row?.period) || selectedPeriod,
    })),
    {
      organization: selectedOrganization,
      period: selectedPeriod,
      tolerance,
      groups: structuralControlGroups,
    },
  )];
  const outOfScopeParentRows = inputRows.filter((row) =>
    isOwnerPresentationBlockExempt(row, structuralControlGroups) &&
    !rowMatchesScope(row, selectedOrganization, selectedPeriod));
  if (outOfScopeParentRows.length > 0) {
    ownerControlGroups = ownerControlGroups.map((control) => ({
      ...control,
      classification: "STRUCTURAL_GROUP_CONFIG_INVALID",
      control_reclass_status: "STRUCTURAL_GROUP_CONFIG_INVALID",
      complete: false,
      blockers: [...new Set([
        ...(control.blockers ?? []),
        "STRUCTURAL_GROUP_SCOPE_CONFLICT",
      ])],
      financial_rows: 0,
      posting_rows: 0,
      posting_allowed: false,
      execution_allowed: false,
    }));
  }
  const closedControlSetIds = new Set(ownerControlGroups
    .filter((control) => control?.classification === "STRUCTURAL_GROUP_SUM_OK")
    .map((control) => text(control?.control_set_id ?? control?.group_id)));
  const closedStructuralControlGroups = structuralControlGroups.filter((group) =>
    closedControlSetIds.has(text(group?.group_id ?? group?.id)));
  const structuralExceptionRootForCode = (code) => {
    const seen = new Set();
    let current = graph.byCode.get(code);
    while (current && !seen.has(rowCode(current))) {
      seen.add(rowCode(current));
      const group = structuralControlGroupForCode(current, closedStructuralControlGroups);
      if (group) {
        return {
          control_set_id: text(group.group_id ?? group.id),
          root_code: rowCode(current),
        };
      }
      current = graph.byCode.get(parentCode(current));
    }
    return null;
  };
  const crossesStructuralExceptionRoots = (leftCode, rightCode) => {
    const left = structuralExceptionRootForCode(leftCode);
    const right = structuralExceptionRootForCode(rightCode);
    return Boolean(
      left && right
      && left.control_set_id === right.control_set_id
      && left.root_code !== right.root_code,
    );
  };
  const hierarchyGraphValidated = payload?.hierarchy_graph_validated
    ?? payload?.hierarchy_validation?.graph_validated
    ?? true;
  const toleranceCents = Math.max(1, Math.round(Math.abs(Number(tolerance) || 0.01) * 100));
  const cases = [];
  const rowLinks = new Map();
  const addCase = (decisionCase) => {
    if ((decisionCase?.member_rows ?? []).some((member) =>
      isOwnerPresentationBlockExempt(member?.code, closedStructuralControlGroups))) return;
    const scopedCase = { ...decisionCase, period: selectedPeriod };
    cases.push(scopedCase);
    for (const member of scopedCase?.member_rows ?? []) {
      if (!rowLinks.has(member.code)) rowLinks.set(member.code, []);
      rowLinks.get(member.code).push(scopedCase.case_id);
    }
  };

  const acceptedPolicyCases = acceptedClassificationCases(
    payload,
    rows,
    ownerAcceptancePolicy,
  );
  acceptedPolicyCases.forEach(addCase);
  const blankArticleCases = provenBlankArticleClassificationCases(rows)
    .filter((decisionCase) => !(decisionCase?.member_rows ?? [])
      .some((member) => rowLinks.has(member.code)));
  blankArticleCases.forEach(addCase);
  const accepted = [...acceptedPolicyCases, ...blankArticleCases];
  const acceptedByAncestor = new Map();
  const acceptedClassificationEffects = new Map();
  for (const decisionCase of accepted) {
    for (const adjustment of decisionCase?.accepted_adjustments ?? []) {
      let parent = adjustment.parent_code;
      const seen = new Set();
      while (parent && graph.byCode.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        acceptedByAncestor.set(parent, (acceptedByAncestor.get(parent) ?? 0) + adjustment.amount_cents);
        parent = parentCode(graph.byCode.get(parent));
      }
    }
    for (const effect of decisionCase?.mapping_effects ?? []) {
      const code = text(effect?.code);
      const amount = Number(effect?.amount_cents);
      if (code && Number.isInteger(amount)) acceptedClassificationEffects.set(code, amount);
    }
  }

  const effective = new Map();
  const intergroupRootEffective = new Map();
  for (const row of rows) {
    let delta = normalizedDeltaCents(row, graph);
    let rootDelta = rawDeltaCents(row);
    const acceptedAmount = acceptedByAncestor.get(rowCode(row)) ?? 0;
    const classificationEffect = acceptedClassificationEffects.get(rowCode(row)) ?? 0;
    if (delta !== null && acceptedAmount !== 0) delta += acceptedAmount;
    if (rootDelta !== null && acceptedAmount !== 0) rootDelta += acceptedAmount;
    if (delta !== null && classificationEffect !== 0) delta -= classificationEffect;
    if (rootDelta !== null && classificationEffect !== 0) rootDelta -= classificationEffect;
    effective.set(rowCode(row), delta);
    intergroupRootEffective.set(rowCode(row), rootDelta);
  }
  const presentationBlockExemptions = rows
    .filter((row) => isOwnerPresentationBlockExempt(row, closedStructuralControlGroups))
    .map((row) => ownerPresentationBlockExemption(row, {
      period: selectedPeriod,
      normalizedDelta: money(effective.get(rowCode(row))),
      groups: closedStructuralControlGroups,
      controlResult: ownerControlGroups
        .find((control) => (control?.member_codes ?? []).includes(rowCode(row))) ?? null,
    }));
  const structuralControlEffects = new Map();
  for (const control of ownerControlGroups) {
    for (const member of control?.member_rows ?? []) {
      const effectiveDelta = cents(member?.effective_delta);
      const priorEffective = effective.get(member.code);
      if (control?.classification === "STRUCTURAL_GROUP_SUM_OK"
        && effectiveDelta !== null && priorEffective !== null && priorEffective !== undefined) {
        structuralControlEffects.set(member.code, {
          amount_cents: priorEffective - effectiveDelta,
          control_set_id: text(control?.control_set_id ?? control?.group_id),
          classification: control.classification,
        });
      }
      if (effectiveDelta !== null) {
        effective.set(member.code, effectiveDelta);
        intergroupRootEffective.set(member.code, effectiveDelta);
      }
    }
  }

  // Binding detection precedes hierarchy execution blockers. Multiple presentation rows may share
  // the same exact ERP source identity; they are one economic binding case.
  for (const row of rows) {
    const code = rowCode(row);
    if (!code || rowLinks.has(code) || isOwnerPresentationBlockExempt(code, closedStructuralControlGroups)) continue;
    const proof = exactSourceHierarchyBindingProof(row, toleranceCents);
    if (!proof) continue;
    const caseId = stable("CASE-SOURCE-HIERARCHY-BINDING", [
      selectedOrganization,
      selectedPeriod,
      code,
      proof.status,
      proof.source_sha256,
      ...proof.source_cells,
    ]);
    addCase({
      case_id: caseId,
      pair_id: stable("PAIR-SOURCE-HIERARCHY-BINDING", [selectedPeriod, code, ...proof.source_cells]),
      classification: "BINDING_REPAIR_PROVEN",
      decision_type: "UPDATE_MAPPING",
      status_text: "ПРИВЯЗКА ERP ДОКАЗАНА",
      amount: number(row?.erp_amount),
      proof_status: "PROVEN_SOURCE_HIERARCHY_BINDING",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      correction_allowed: false,
      execution_allowed: false,
      financial_rows: 0,
      posting_rows: 0,
      reason: `Текущий источник ERP доказал точную структурную привязку ${code}: ${proof.source_cells.join(", ")}.`,
      solution: `Сохранить UPDATE_MAPPING для ${code}; финансовую корректировку и проводку не создавать.`,
      mapping_evidence: [{
        code,
        erp_literal: number(row?.erp_amount),
        raw_delta: number(row?.delta),
        effective_delta: 0,
        mapping_proof_status: "BINDING_REPAIR_PROVEN",
        source_binding_status: proof.status,
        source_cells: proof.source_cells,
        source_sha256: proof.source_sha256,
      }],
      member_rows: [{
        code,
        role: "BINDING_TARGET",
        raw_delta: number(row?.delta),
        effective_delta: 0,
        source_amount: number(row?.erp_amount),
        source_ref: proof.source_cells.join(", "),
        mapping_proof_status: "BINDING_REPAIR_PROVEN",
        source_binding_status: proof.status,
      }],
      binding: {
        source_identity: `${proof.source_sha256}|${proof.source_cells.join("|")}`,
        source_cells: proof.source_cells,
        source_sha256: proof.source_sha256,
      },
    });
    effective.set(code, 0);
    intergroupRootEffective.set(code, 0);
  }
  const bindingHits = [];
  const provenMappingAdjustments = new Map(acceptedClassificationEffects);
  for (const row of rows) {
    const code = rowCode(row);
    if (isOwnerPresentationBlockExempt(code, closedStructuralControlGroups)) continue;
    if (rowLinks.has(code)) continue;
    const hit = exactBindingHit(row, rows, effective.get(code), toleranceCents);
    if (hit) bindingHits.push(hit);
  }
  const bindingGroups = new Map();
  for (const hit of bindingHits) {
    const key = `${hit.source_identity}|${hit.amount_cents}`;
    if (!bindingGroups.has(key)) bindingGroups.set(key, []);
    bindingGroups.get(key).push(hit);
  }
  for (const hits of bindingGroups.values()) {
    const uniqueRows = [...new Map(hits.map((hit) => [hit.row_code, hit])).values()];
    if (uniqueRows.length === 0) continue;
    const first = uniqueRows[0];
    const memberCodes = uniqueRows.map((hit) => hit.row_code).sort();
    const mappingDetails = uniqueRows.map((hit) => {
      const row = rows.find((item) => rowCode(item) === hit.row_code);
      const rawDelta = rawDeltaCents(row);
      const adjustment = effective.get(hit.row_code) ?? 0;
      const erpLiteral = cents(row?.erp_amount);
      return {
        code: hit.row_code,
        erp_literal: erpLiteral === null ? null : money(erpLiteral),
        raw_delta: rawDelta === null ? null : money(rawDelta),
        proven_mapping_adjustment: money(adjustment),
        erp_effective_after_proven_mapping: erpLiteral === null
          ? null
          : money(erpLiteral + adjustment),
        effective_delta: rawDelta === null ? null : money(rawDelta - adjustment),
        mapping_proof_status: "REPORT_SOURCE_PROVEN",
        journal_operation_proof_status: "UNPROVEN",
      };
    });
    const caseId = stable("CASE-BINDING", [text(payload?.organization), text(payload?.period), first.source_identity, first.amount_cents, ...memberCodes]);
    addCase({
      case_id: caseId,
      pair_id: stable("PAIR-BINDING", [text(payload?.period), first.source_identity, first.amount_cents, ...memberCodes]),
      classification: "BINDING_REPAIR_PROVEN",
      decision_type: "UPDATE_MAPPING",
      status_text: "ПРИВЯЗКА ERP ДОКАЗАНА",
      amount: money(first.amount_cents),
      proof_status: "PROVEN",
      approval_state: "ДОКАЗАНО_СВЕРКОЙ",
      correction_allowed: false,
      execution_allowed: false,
      erp_source_sha256: first.erp_source_sha256,
      reason: `В уже сошедшемся контрольном блоке найдена единственная точная ERP-строка ${money(first.amount_cents)} (${first.catalog_path}, ${first.source_ref}). Она структурно совпадает с точной веткой Инталев, но не была привязана к строкам ${memberCodes.join(", ")}.`,
      solution: `Исправить только ERP-binding для ${memberCodes.join(", ")}. После привязки effective delta = 0; финансовую проводку не создавать.`,
      mapping_evidence: mappingDetails,
      member_rows: uniqueRows.map((hit) => ({
        ...mappingDetails.find((item) => item.code === hit.row_code),
        role: "BINDING_TARGET",
        effective_delta: 0,
        source_amount: money(hit.amount_cents),
        source_ref: hit.source_ref,
      })),
      binding: {
        source_identity: first.source_identity,
        catalog_path: first.catalog_path,
        evidence_row_codes: [...new Set(uniqueRows.map((hit) => hit.evidence_row_code))].sort(),
      },
    });
    for (const hit of uniqueRows) {
      const adjustment = effective.get(hit.row_code);
      if (adjustment !== null) provenMappingAdjustments.set(hit.row_code, adjustment);
      effective.set(hit.row_code, 0);
      intergroupRootEffective.set(hit.row_code, 0);
    }
  }

  // Root-level intergroup discovery runs before descendant consumption. The
  // detector receives the authoritative post-mapping/post-structural root
  // residual while retaining raw rows for the second descendant stage.
  const detectionRows = rows.map((row) => {
    const code = rowCode(row);
    const adjustment = provenMappingAdjustments.get(code) ?? 0;
    const rawDelta = rawDeltaCents(row);
    const erpLiteral = cents(row?.erp_amount);
    return {
      ...row,
      organization: text(row?.organization) || selectedOrganization,
      period: text(row?.period) || selectedPeriod,
      intergroup_root_delta: intergroupRootEffective.get(code) === null
        ? null
        : money(intergroupRootEffective.get(code)),
      ...(adjustment === 0 ? {} : {
        erp_literal: erpLiteral === null ? null : money(erpLiteral),
        raw_delta: rawDelta === null ? null : money(rawDelta),
        proven_mapping_adjustment: money(adjustment),
        mapping_proof_status: "REPORT_SOURCE_PROVEN",
        journal_operation_proof_status: "UNPROVEN",
        erp_effective_after_proven_mapping: erpLiteral === null
          ? null
          : money(erpLiteral + adjustment),
      }),
    };
  });
  const genericDetection = detectGenericReclassifications(detectionRows, {
    tolerance,
    hierarchy_graph_validated: hierarchyGraphValidated === true,
    structural_control_groups: closedStructuralControlGroups,
  });
  const nonReclassCovered = new Set(rowLinks.keys());
  const detectedCandidates = genericDetection.candidates.filter((candidate) => {
    const members = [...candidate.source_members, ...candidate.target_members];
    return !members.some((member) => nonReclassCovered.has(member.code));
  });
  const intergroupReclassEffects = new Map();
  if ((genericDetection.audit?.duplicate_root_correction_count ?? 0) === 0) {
    for (const candidate of detectedCandidates.filter((item) =>
      item.scope === "INTER_GROUP" && item.accepted_intergroup_reclass === true)) {
      for (const member of [...candidate.source_members, ...candidate.target_members]) {
        const amountCents = cents(member.accepted_intergroup_effect);
        if (amountCents === null || amountCents === 0 || intergroupReclassEffects.has(member.code)) continue;
        intergroupReclassEffects.set(member.code, {
          amount_cents: amountCents,
          accepted_amount_cents: cents(candidate.accepted_amount) ?? Math.abs(amountCents),
          candidate_id: candidate.candidate_id,
          intergroup_reclass_id: candidate.intergroup_reclass_id,
          proof_status: candidate.proof_status,
          role: member.economic_direction,
        });
      }
    }
  }

  // The authoritative ledger consumes an accepted intergroup effect once at
  // its roots. Descendants remain separate records and run through the second
  // detector stage without being subtracted into an already closed root.
  const residualLedger = buildResidualLedger({
    rows,
    graph,
    authoritativeEffective: effective,
    structuralControlEffects,
    intergroupReclassEffects,
    organization: selectedOrganization,
    period: selectedPeriod,
    toleranceCents,
  });
  const decisionResidual = residualLedger.decisionResidual;
  for (const parentCodeValue of residualLedger.representedParents) {
    if (!rowLinks.has(parentCodeValue)) rowLinks.set(parentCodeValue, []);
    nonReclassCovered.add(parentCodeValue);
  }

  // An owner-confirmed economic intragroup effect is a business fact, but it
  // is not an allocation proof. Publish the still-independent descendants as
  // one explicit nonfinancial review without inventing source/target legs or
  // consuming any residual atom. The already closed intergroup parent remains
  // closed exactly once.
  const ownerConfirmedIntragroupReviewDrafts = [];
  for (const confirmation of ownerConfirmedIntragroupScope(
    payload, selectedOrganization, selectedPeriod, graph,
  )) {
    const rootCodeValue = text(confirmation.root_code);
    const rootLedger = residualLedger.rows.find((item) => item.code === rootCodeValue);
    const rootRow = graph.byCode.get(rootCodeValue);
    const parentClosedOnce = cents(rootLedger?.effective_delta) === 0
      && Math.abs(cents(rootLedger?.consumed_by_intergroup_reclass) ?? 0) > toleranceCents
      && cents(rootLedger?.consumed_by_descendants) === 0
      && text(rootLedger?.intergroup_reclass_id) === text(confirmation.intergroup_route_id)
      && text(rootRow?.intergroup_reclass_id) === text(confirmation.intergroup_route_id)
      && text(rootRow?.intergroup_reclass_run_id) === text(confirmation.run_id)
      && text(rootRow?.intergroup_reclass_approval_id) === text(confirmation.authority_ref)
      && text(rootRow?.intergroup_reclass_input_sha256).toUpperCase()
        === text(confirmation.proof_input_sha256).toUpperCase();
    if (!parentClosedOnce) continue;
    const members = confirmation.descendant_codes
      .map((code) => residualLedger.rows.find((item) => item.code === code))
      .filter((record) => record
        && Math.abs(cents(record.effective_delta) ?? 0) > toleranceCents
        && cents(record.consumed_by_intergroup_reclass) === 0
        && cents(record.consumed_by_descendants) === 0)
      .map((record) => ({
        code: record.code,
        role: "UNALLOCATED_DESCENDANT_RESIDUAL",
        effective_delta: record.effective_delta,
        allocated_amount: 0,
        residual_atom_id: record.residual_atom_id,
        transformation_id: null,
        economic_direction: "",
      }));
    if (members.length === 0) continue;
    const review = {
      case_id: stable("CASE-OWNER-INTRAGROUP-REVIEW", [
        selectedOrganization,
        selectedPeriod,
        confirmation.confirmation_id,
        rootCodeValue,
        ...members.map((member) => `${member.code}:${cents(member.effective_delta)}`),
      ]),
      pair_id: "",
      confirmation_id: text(confirmation.confirmation_id),
      organization: selectedOrganization,
      period: selectedPeriod,
      run_id: text(confirmation.run_id),
      authority_ref: text(confirmation.authority_ref),
      evidence_ref: text(confirmation.evidence_ref),
      proof_input_sha256: text(confirmation.proof_input_sha256).toUpperCase(),
      intergroup_route_id: text(confirmation.intergroup_route_id),
      descendant_member_set_sha256:
        text(confirmation.descendant_member_set_sha256).toUpperCase(),
      classification: "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS",
      economic_status: "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS",
      exact_allocation_status: "BLOCKED_EXACT_ALLOCATION",
      physical_erp_status: "BLOCKED_PHYSICAL_ERP_PROOF",
      root_code: rootCodeValue,
      decision_type: "NO_POSTING",
      status_text: "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS / BLOCKED_EXACT_ALLOCATION / BLOCKED_PHYSICAL_ERP_PROOF",
      amount: 0,
      proof_status: "OWNER_CONFIRMED_ECONOMIC_INTRA_RECLASS",
      approval_state: "ЭКОНОМИКА ПОДТВЕРЖДЕНА / АЛЛОКАЦИЯ НЕ ДОКАЗАНА",
      correction_allowed: false,
      execution_allowed: false,
      financial_rows: 0,
      posting_rows: 0,
      owner_review_required: true,
      missing_proof: ["EXACT_DESCENDANT_ALLOCATION", "EXACT_PHYSICAL_ERP_SOURCE"],
      reason: `Внутригрупповой пересорт внутри ${rootCodeValue} подтверждён владельцем, но точное распределение между дочерними строками и физический ERP-источник не доказаны. Родительский межгрупповой эффект уже потреблён один раз.`,
      solution: "Показать дочерние остатки раздельно как REVIEW_ONLY. Не назначать STORNO/REPOST, не уменьшать родительскую дельту повторно и не заполнять неизвестные физические поля.",
      member_rows: members,
    };
    ownerConfirmedIntragroupReviewDrafts.push(review);
  }

  const genericCandidates = detectedCandidates.filter((candidate) => {
    const members = [...candidate.source_members, ...candidate.target_members];
    return !members.some((member) => nonReclassCovered.has(member.code));
  });
  const genericUnmatchedResiduals = genericDetection.unmatched_residuals
    .filter((item) => !nonReclassCovered.has(item.code));
  const genericCoveredCodes = new Set(genericCandidates.flatMap((candidate) =>
    [...candidate.source_members, ...candidate.target_members].map((member) => member.code)));

  // Internal zero-net groups, such as payroll. Detection is independent of execution proof.
  // Preserve the accepted zero-parent internal owner contour (notably the
  // November payroll draft). It is explicitly UNPROVEN/report-only and does
  // not use an inferred cross-branch hierarchy route.
  for (const parent of rows) {
    const parentRawDelta = rawDeltaCents(parent);
    if (parentRawDelta === null || Math.abs(parentRawDelta) > toleranceCents) continue;
    let candidates = graph.descendants(rowCode(parent))
      .map((code) => ({ code, delta_cents: decisionResidual.get(code) }))
      .filter((candidate) => candidate.delta_cents !== null
        && Math.abs(candidate.delta_cents) > toleranceCents
        && !isOwnerPresentationBlockExempt(candidate.code, closedStructuralControlGroups)
        && !genericCoveredCodes.has(candidate.code)
        && !rowLinks.has(candidate.code));
    candidates = dedupeParentSameDelta(candidates, graph);
    if (candidates.length < 2) continue;
    if (!candidates.some((candidate) => candidate.delta_cents > 0)
      || !candidates.some((candidate) => candidate.delta_cents < 0)) continue;
    const net = candidates.reduce((sum, candidate) => sum + candidate.delta_cents, 0);
    if (Math.abs(net) > toleranceCents) continue;
    const amountCents = candidates.filter((candidate) => candidate.delta_cents < 0)
      .reduce((sum, candidate) => sum + Math.abs(candidate.delta_cents), 0);
    const caseId = stable("CASE-INTERNAL-RECLASS", [text(payload?.organization), text(payload?.period), rowCode(parent), ...candidates.map((candidate) => `${candidate.code}:${candidate.delta_cents}`)]);
    addCase({
      case_id: caseId,
      pair_id: stable("PAIR-INTERNAL", [text(payload?.period), rowCode(parent), ...candidates.map((candidate) => `${candidate.code}:${candidate.delta_cents}`)]),
      classification: "INTERNAL_RECLASS_CANDIDATE",
      decision_type: "STORNO_REPOST",
      status_text: "ВОЗМОЖЕН ПЕРЕСОРТ",
      amount: money(amountCents),
      proof_status: "UNPROVEN",
      approval_state: "ПРЕДЛОЖЕНО",
      correction_allowed: false,
      execution_allowed: false,
      reason: `Родительская группа ${rowCode(parent)} сходится в ноль. После исключения вложенного двойного счёта по точным source traces остаются встречные effective delta: ${candidates.map((candidate) => `${candidate.code} ${money(candidate.delta_cents)}`).join("; ")}. Сумма компонентов = 0.`,
      solution: "Показать один процесс внутреннего пересорта со всеми компонентами. До exact source operation proof STORNO/REPOST не формировать.",
      member_rows: candidates.map((candidate) => ({
        code: candidate.code,
        role: candidate.delta_cents < 0 ? "RECLASS_SOURCE" : "RECLASS_TARGET",
        effective_delta: money(candidate.delta_cents),
      })),
    });
  }

  // Add only exact ERP-only leaf candidates that explain their own numeric parent's delta.
  // Missing values are never globally converted to zero/delta.
  const detectionOnlySources = sourceOnlyCandidates(rows, graph, decisionResidual, toleranceCents)
    .filter((candidate) =>
      !isOwnerPresentationBlockExempt(candidate.code, closedStructuralControlGroups)
      && !genericCoveredCodes.has(candidate.code)
      && !rowLinks.has(candidate.code));

  let residual = rows
    .map((row) => ({ code: rowCode(row), delta_cents: decisionResidual.get(rowCode(row)), row, detection_only: false }))
    .filter((candidate) => candidate.delta_cents !== null
      && Math.abs(candidate.delta_cents) > toleranceCents
      && !isOwnerPresentationBlockExempt(candidate.code, closedStructuralControlGroups)
      && !genericCoveredCodes.has(candidate.code)
      && !rowLinks.has(candidate.code));
  residual.push(...detectionOnlySources);
  residual = dedupeParentSameDelta(residual, graph);

  const used = new Set();
  for (const left of residual) {
    if (used.has(left.code)) continue;
    const matches = residual.filter((right) =>
      right.code !== left.code
        && !used.has(right.code)
        && left.delta_cents * right.delta_cents < 0
        && !crossesStructuralExceptionRoots(left.code, right.code)
        && absoluteEqual(left.delta_cents, right.delta_cents, toleranceCents),
    );
    if (matches.length !== 1) continue;
    const right = matches[0];
    // With an unvalidated hierarchy, retain only the accepted ERP-only exact
    // source contour. Purely inferred numeric cross-branch pairs are owned by
    // the canonical REVIEW_ONLY detector and never reach this legacy draft.
    if (hierarchyGraphValidated !== true && !left.detection_only && !right.detection_only) continue;
    used.add(left.code);
    used.add(right.code);
    const source = left.delta_cents < 0 ? left : right;
    const target = left.delta_cents > 0 ? left : right;
    const amountCents = Math.abs(source.delta_cents);
    const existingRow = existingReconciledAmountRow(rows, amountCents, toleranceCents);
    const existingNote = existingRow
      ? ` Та же сумма ${money(amountCents)} уже полностью сходится в обеих системах на ${rowCode(existingRow)}, поэтому это не новая финансовая сумма.`
      : "";
    const decisionType = existingRow ? "UPDATE_MAPPING" : "STORNO_REPOST";
    const caseId = stable("CASE-CROSS-RECLASS", [text(payload?.organization), text(payload?.period), source.code, target.code, amountCents]);
    addCase({
      case_id: caseId,
      pair_id: stable("PAIR-CROSS", [text(payload?.period), source.code, target.code, amountCents]),
      classification: "CROSS_BRANCH_RECLASS_CANDIDATE",
      decision_type: decisionType,
      status_text: "ПЕРЕСОРТ НЕ ДОКАЗАН",
      amount: money(amountCents),
      proof_status: "UNPROVEN",
      approval_state: "ПРЕДЛОЖЕНО",
      correction_allowed: false,
      execution_allowed: false,
      reason: `Найдены точные встречные остатки ${source.code} ${money(source.delta_cents)} и ${target.code} ${money(target.delta_cents)}.${existingNote}`,
      solution: existingRow
        ? "Рассматривать как один межветочный hierarchy/binding case. Проверить точную привязку источника и цели; новую финансовую сумму и проводку не создавать."
        : "Рассматривать как один межветочный пересорт. До exact source/target proof проводку не формировать.",
      member_rows: [
        { code: source.code, role: "RECLASS_SOURCE", effective_delta: money(source.delta_cents), source_ref: source.source_ref ?? "" },
        { code: target.code, role: "RECLASS_TARGET", effective_delta: money(target.delta_cents), source_ref: target.source_ref ?? "" },
      ],
      reconciled_amount_row: existingRow ? rowCode(existingRow) : null,
    });
  }

  // Publish canonical cases after the compatibility passes have skipped every
  // canonical member. Accepted owner/binding cases remain excluded; ambiguous
  // canonical alternatives stay visible together and never authorize posting.
  for (const candidate of genericCandidates) {
    const members = [...candidate.source_members, ...candidate.target_members];
    const r001MaterializationSupported = candidate.source_members.length === 1
      && (candidate.source_members[0]?.source_traces?.length ?? 0) === 1;
    const financialRouteAuthorized = candidate.classification === "FINANCIAL_RECLASS"
      && r001MaterializationSupported;
    const disputedEconomicRoute = candidate.economic_route_proven === true
      && candidate.economic_correction_proven !== true
      && candidate.classification !== "PRESENTATION_REGROUPING";
    const decisionType = financialRouteAuthorized
      ? "STORNO_REPOST"
      : disputedEconomicRoute
        ? "STORNO_REPOST"
      : candidate.classification === "PRESENTATION_REGROUPING"
        ? "UPDATE_MAPPING"
        : "NO_POSTING";
    const statusText = financialRouteAuthorized
      ? "ФИНАНСОВАЯ ПЕРЕКЛАССИФИКАЦИЯ ДОКАЗАНА"
      : disputedEconomicRoute
        ? "DRAFT STORNO/REPOST _СПОРНО"
      : candidate.classification === "FINANCIAL_RECLASS"
        ? "ЭКОНОМИЧЕСКИЙ МАРШРУТ ДОКАЗАН / R001 MULTI-SOURCE MATERIALIZATION BLOCKED"
      : candidate.classification === "PRESENTATION_REGROUPING"
        ? "ИЗМЕНИТЬ ГРУППИРОВКУ ОТЧЁТА / БЕЗ ПРОВОДКИ"
        : "ПЕРЕКЛАССИФИКАЦИЯ ТРЕБУЕТ ДОКАЗАТЕЛЬСТВ / REVIEW_ONLY";
    addCase({
      case_id: candidate.candidate_id,
      pair_id: stable("PAIR-GENERIC-RECLASS", [candidate.candidate_id]),
      classification: candidate.classification === "NUMERIC_ZERO_SUM_CANDIDATE_ONLY"
        ? candidate.scope === "INTRA_GROUP"
          ? "INTERNAL_RECLASS_CANDIDATE"
          : "CROSS_BRANCH_RECLASS_CANDIDATE"
        : candidate.classification,
      reclass_scope: candidate.scope,
      cardinality: candidate.cardinality,
      decision_type: decisionType,
      status_text: statusText,
      amount: candidate.candidate_amount,
      normalized_delta: candidate.net_amount,
      proof_status: candidate.proof_status,
      approval_state: financialRouteAuthorized ? "ДОКАЗАНО_СВЕРКОЙ" : "ПРЕДЛОЖЕНО",
      correction_allowed: financialRouteAuthorized,
      execution_allowed: false,
      financial_rows: financialRouteAuthorized ? candidate.financial_rows : 0,
      economic_route_proven: candidate.economic_route_proven === true,
      source_operation_proven: candidate.source_operation_proven === true,
      physical_source_unique: candidate.physical_source_unique === true,
      economic_correction_proven: candidate.economic_correction_proven === true,
      economic_reclass_proven: candidate.economic_reclass_proven === true,
      accepted_intergroup_reclass: candidate.accepted_intergroup_reclass === true,
      accepted_amount: candidate.accepted_amount,
      intergroup_reclass_id: candidate.intergroup_reclass_id,
      structural_suppression_status: candidate.structural_suppression_status,
      processing_stage: candidate.processing_stage,
      stage_order: candidate.stage_order,
      unproven_reason: candidate.unproven_reason,
      duplicate_root_correction_count: genericDetection.audit?.duplicate_root_correction_count ?? 0,
      owner_review_required: candidate.owner_review_required === true || disputedEconomicRoute,
      ECONOMIC_ROUTE_PROVEN: candidate.economic_route_proven === true,
      SOURCE_OPERATION_PROVEN: candidate.source_operation_proven === true,
      PHYSICAL_SOURCE_UNIQUE: candidate.physical_source_unique === true,
      ECONOMIC_CORRECTION_PROVEN: candidate.economic_correction_proven === true,
      OWNER_REVIEW_REQUIRED: candidate.owner_review_required === true || disputedEconomicRoute,
      source_proof_status: candidate.source_operation_proven === true
        ? "SOURCE_OPERATION_PROVEN"
        : "SOURCE_OPERATION_UNPROVEN",
      physical_source_completeness: candidate.physical_source_unique === true ? "COMPLETE" : "PARTIAL_OR_INCOMPLETE",
      disputed: disputedEconomicRoute,
      ambiguous: candidate.ambiguous,
      ambiguity_group_id: candidate.ambiguity_group_id,
      missing_proof: [
        ...candidate.missing_proof,
        ...(candidate.classification === "FINANCIAL_RECLASS" && !r001MaterializationSupported
          ? ["R001_MULTI_SOURCE_MATERIALIZATION_NOT_AUTHORIZED"]
          : []),
      ],
      reason: candidate.proof_reason,
      solution: decisionType === "STORNO_REPOST"
        ? "Сохранить один детерминированный сбалансированный STORNO/REPOST route как REPORT_ONLY draft."
        : decisionType === "UPDATE_MAPPING"
          ? "Изменить только reporting mapping; финансовые строки не создавать."
          : "Оставить REVIEW_ONLY до получения всего missing proof; ADD_ONE_SIDE/STORNO/REPOST не создавать.",
      member_rows: [
        ...candidate.source_members.map((member) => ({
          code: member.code,
          role: "RECLASS_SOURCE",
          effective_delta: member.normalized_delta,
          raw_delta: member.raw_delta,
          root_effective_delta: member.root_effective_delta,
          accepted_intergroup_effect: member.accepted_intergroup_effect,
          economic_direction: member.economic_direction,
          intergroup_reclass_id: member.intergroup_reclass_id,
          intergroup_reclass_proof_status: member.intergroup_reclass_proof_status,
          residual_atom_id: member.residual_atom_id ?? null,
          transformation_id: member.transformation_id ?? null,
          economic_contour_id: member.economic_contour_id ?? null,
          source_ref: candidate.source_operation_proven === true
            && candidate.physical_source_unique === true
            ? member.source_traces?.[0]?.source_range ?? ""
            : "",
          source_traces: member.source_traces,
        })),
        ...candidate.target_members.map((member) => ({
          code: member.code,
          role: "RECLASS_TARGET",
          effective_delta: member.normalized_delta,
          raw_delta: member.raw_delta,
          root_effective_delta: member.root_effective_delta,
          accepted_intergroup_effect: member.accepted_intergroup_effect,
          economic_direction: member.economic_direction,
          intergroup_reclass_id: member.intergroup_reclass_id,
          intergroup_reclass_proof_status: member.intergroup_reclass_proof_status,
          residual_atom_id: member.residual_atom_id ?? null,
          transformation_id: member.transformation_id ?? null,
          economic_contour_id: member.economic_contour_id ?? null,
          target_identity: member.target_identity ?? null,
        })),
      ],
    });
  }

  // One-sided routing is deliberately after mapping, structural controls,
  // residual representation and canonical reclass publication. A disputed
  // reclass remains visible but cannot consume this ledger.
  const oneSidedCases = routeOneSidedCorrections({
    organization: selectedOrganization,
    period: selectedPeriod,
    rows,
    residual_ledger: residualLedger,
    operation_evidence: payload?.operation_evidence,
    excluded_codes: new Set([...genericCoveredCodes, ...rowLinks.keys()]),
    tolerance,
  });
  for (const decisionCase of oneSidedCases) {
    addCase(decisionCase);
    if (decisionCase.ECONOMIC_CORRECTION_PROVEN === true) {
      const code = rowCode(decisionCase.member_rows?.[0]);
      const ledgerRecord = residualLedger.rows.find((item) => item.code === code);
      if (ledgerRecord) ledgerRecord.consumed_by_proven_one_sided = decisionCase.member_rows[0].effective_delta;
    }
  }

  // Publish the owner-confirmed summary only after independently proven
  // generic and one-sided operations have retained their normal eligibility.
  // The summary owns only still-uncovered descendant atoms; if every atom has
  // its own case, a zero-valued root marker keeps the owner fact visible
  // without suppressing or duplicating a financial member.
  const ownerConfirmedIntragroupReviews = [];
  for (const draft of ownerConfirmedIntragroupReviewDrafts) {
    const coveredMembers = draft.member_rows.filter((member) => rowLinks.has(member.code));
    const uncoveredMembers = draft.member_rows.filter((member) => !rowLinks.has(member.code));
    const coveredCaseIds = [...new Set(coveredMembers.flatMap(
      (member) => rowLinks.get(member.code) ?? [],
    ))].sort();
    const review = {
      ...draft,
      covered_descendant_codes: coveredMembers.map((member) => member.code),
      covered_descendant_case_ids: coveredCaseIds,
      member_rows: uncoveredMembers.length > 0
        ? uncoveredMembers
        : [{
            code: draft.root_code,
            role: "CONFIRMED_SCOPE_ROOT",
            effective_delta: 0,
            allocated_amount: 0,
            residual_atom_id: null,
            transformation_id: null,
            economic_direction: "",
          }],
    };
    ownerConfirmedIntragroupReviews.push(review);
    addCase(review);
  }

  // Map parent/control presentation rows to the economic case(s) below them.
  for (const row of rows) {
    const code = rowCode(row);
    if (isOwnerPresentationBlockExempt(code, closedStructuralControlGroups)) continue;
    if (rowLinks.has(code)) continue;
    const raw = rawDeltaCents(row);
    if (raw === null || Math.abs(raw) <= toleranceCents) continue;
    const descendantCases = [...new Set(graph.descendants(code).flatMap((descendant) => rowLinks.get(descendant) ?? []))];
    if (descendantCases.length > 0) rowLinks.set(code, descendantCases);
  }

  // Any original numeric nonzero row still uncovered is explicit REVIEW_ONLY.
  // A structural normalization to zero explains why no financial route exists,
  // but it must not make the original displayed discrepancy disappear.
  // Null-side leaf rows are not converted into fake discrepancies.
  for (const row of rows) {
    const code = rowCode(row);
    if (isOwnerPresentationBlockExempt(code, closedStructuralControlGroups)) continue;
    const raw = rawDeltaCents(row);
    const delta = decisionResidual.get(code);
    if (raw === null || Math.abs(raw) < 1 || rowLinks.has(code)) continue;
    const reviewDelta = delta !== null && Math.abs(delta) > toleranceCents ? delta : raw;
    const sourceScopePresence = text(row?.intalev_source_scope_presence).toLocaleUpperCase("ru-RU");
    const unclassifiedSourcePresent = sourceScopePresence === "PRESENT_UNCLASSIFIED"
      || sourceScopePresence === "PRESENT_UNCLASSIFIED_UNBOUND";
    const unclassifiedCandidate = (Array.isArray(row?.unclassified_offset_candidates)
      ? row.unclassified_offset_candidates
      : []).find((candidate) => cents(candidate?.amount) === Math.abs(reviewDelta)) ?? null;
    const visibleIntalevAmount = unclassifiedSourcePresent
      ? number(unclassifiedCandidate?.amount) ?? money(Math.abs(reviewDelta))
      : null;
    const visibleErpAmount = number(row?.erp_amount);
    const visibleErpArticle = text(row?.erp_article);
    addCase({
      case_id: stable("CASE-REVIEW", [text(payload?.organization), text(payload?.period), code, reviewDelta]),
      pair_id: "",
      classification: unclassifiedSourcePresent ? "EMPTY_ARTICLE" : "REVIEW_ONLY",
      decision_type: "NO_POSTING",
      status_text: unclassifiedSourcePresent
        ? "INTALEV EMPTY_ARTICLE / UNCLASSIFIED — БЕЗ STORNO"
        : "ТРЕБУЕТ РЕШЕНИЯ / REVIEW_ONLY",
      amount: money(Math.abs(reviewDelta)),
      proof_status: "UNPROVEN",
      approval_state: "ПРЕДЛОЖЕНО",
      correction_allowed: false,
      execution_allowed: false,
      financial_rows: 0,
      intalev_article: unclassifiedSourcePresent ? "" : null,
      intalev_amount: visibleIntalevAmount,
      intalev_source_path: text(unclassifiedCandidate?.source_path ?? unclassifiedCandidate?.full_path),
      intalev_source_row: unclassifiedCandidate?.source_row ?? unclassifiedCandidate?.row ?? null,
      erp_article: visibleErpArticle,
      erp_amount: visibleErpAmount,
      same_erp_posting_proven: false,
      reason: unclassifiedSourcePresent
        ? `Строка ${code} имеет Intalev-present blank/unclassified source evidence без доказанной привязки к статье; отсутствие статьи не является ERP_ONLY.`
        : delta !== null && Math.abs(delta) <= toleranceCents
          ? `Строка ${code} имеет исходную delta ${money(raw)}, которая нормализуется структурой до ${money(delta)}, но должна остаться видимым REVIEW_ONLY контролем без финансовой проводки.`
          : `После structural, binding и reclass-проверок строка ${code} сохраняет ненулевую effective delta ${money(reviewDelta)} без единственного доказанного экономического маршрута.`,
      solution: unclassifiedSourcePresent
        ? "Показать EMPTY_ARTICLE / UNCLASSIFIED как source-data review; не создавать STORNO/REPOST без отдельного доказательства классификации или source-scope absence."
        : "Оставить как явный контрольный процесс; не создавать ADD_ONE_SIDE/STORNO/REPOST до exact proof.",
      member_rows: [{
        code,
        role: "REVIEW",
        effective_delta: money(reviewDelta),
        intalev_article: unclassifiedSourcePresent ? "" : null,
        intalev_amount: visibleIntalevAmount,
        intalev_source_path: text(unclassifiedCandidate?.source_path ?? unclassifiedCandidate?.full_path),
        intalev_source_row: unclassifiedCandidate?.source_row ?? unclassifiedCandidate?.row ?? null,
        erp_article: visibleErpArticle,
        erp_amount: visibleErpAmount,
      }],
    });
  }

  const normalizedLinks = Object.fromEntries([...rowLinks].map(([code, ids]) => [code, [...new Set(ids)]]));
  const residualLedgerByCode = new Map(
    (residualLedger.rows ?? []).map((record) => [record.code, record]));
  const ownerProjectionCoverage = Object.fromEntries(rows
    .filter((row) => {
      const raw = rawDeltaCents(row);
      return raw !== null && Math.abs(raw) > toleranceCents;
    })
    .map((row) => {
      const code = rowCode(row);
      const caseIds = normalizedLinks[code] ?? [];
      const ledgerRecord = residualLedgerByCode.get(code);
      const presentationExempt = isOwnerPresentationBlockExempt(
        code, closedStructuralControlGroups);
      if (caseIds.length > 0) {
        return [code, {
          coverage_status: "MAPPED_OWNER_CASE",
          decision_case_ids: caseIds,
          causal_blocker: null,
          classification: "OWNER_DECISION_MAPPED",
          financial_rows: 0,
          posting_rows: 0,
        }];
      }
      const descendantRepresented = residualLedger.representedParents.has(code)
        || Math.abs(cents(ledgerRecord?.consumed_by_descendants) ?? 0) > toleranceCents;
      const sourceScopeBlocked = row?.intalev_source_amount_lost === true
        || row?.intalev_source_scope_complete === false;
      const causalBlocker = presentationExempt
        ? "OWNER_PRESENTATION_BLOCK_EXEMPT"
        : descendantRepresented
          ? "DESCENDANT_RESIDUAL_REPRESENTED_NONFINANCIAL"
          : sourceScopeBlocked
            ? "BLOCKED_INTALEV_SOURCE_SCOPE_INCOMPLETE"
            : hierarchyGraphValidated !== true
              ? "BLOCKED_HIERARCHY_GRAPH_NOT_VALIDATED"
              : "OWNER_DECISION_COVERAGE_MISSING";
      const explicitlyBlocked = presentationExempt
        || descendantRepresented
        || sourceScopeBlocked
        || hierarchyGraphValidated !== true;
      return [code, {
        coverage_status: explicitlyBlocked
          ? "EXPLICIT_NONFINANCIAL_BLOCKED"
          : "UNCOVERED_OWNER_PROJECTION",
        decision_case_ids: [],
        causal_blocker: causalBlocker,
        classification: presentationExempt
          ? "PRESENTATION_ONLY_NONFINANCIAL"
          : descendantRepresented
            ? "DESCENDANT_REPRESENTATION_NONFINANCIAL"
            : explicitlyBlocked
              ? "REVIEW_ONLY_NONFINANCIAL"
              : "OWNER_PROJECTION_COVERAGE_MISSING",
        financial_rows: 0,
        posting_rows: 0,
      }];
    }));
  const integrityFailures = cases
    .map((decisionCase) => ({ decisionCase, integrity: integrityForDecisionCase(decisionCase, { residual_ledger: residualLedger }) }))
    .filter((item) => !item.integrity.ok)
    .map((item) => ({
      case_id: item.decisionCase.case_id,
      classification: item.integrity.classification,
      blocker: item.integrity.blocker,
    }));
  return {
    schema: "opiu-owner-economic-decisions.v1",
    organization: text(payload?.organization),
    period: text(payload?.period),
    intalev_source_scope: payload?.intalev_source_scope ?? null,
    intalev_source_scopes: Array.isArray(payload?.intalev_source_scopes)
      ? payload.intalev_source_scopes
      : [payload?.intalev_source_scope].filter(Boolean),
    cases,
    residual_ledger: residualLedger,
    generic_reclassification: {
      schema: genericDetection.schema,
      mechanism: genericDetection.mechanism,
      normalization: genericDetection.normalization,
      candidates: genericCandidates,
      partitions: genericDetection.partitions,
      unmatched_residuals: genericUnmatchedResiduals,
      ignored: genericDetection.ignored,
      audit: genericDetection.audit,
      safety: genericDetection.safety,
    },
    owner_control_groups: ownerControlGroups,
    structural_group_control_sets:
      serializeStructuralControlGroups(structuralControlGroups),
    structural_group_control_results: ownerControlGroups,
    owner_confirmed_intragroup_reviews: ownerConfirmedIntragroupReviews,
    presentation_block_exemptions: presentationBlockExemptions,
    row_links: normalizedLinks,
    owner_projection_coverage: ownerProjectionCoverage,
    integrity_failures: integrityFailures,
    safety: {
      report_only: true,
      posting_rows: 0,
      executed_posting_rows: 0,
      live_posting_rows: 0,
      add_one_side_rows: 0,
      storno_rows: 0,
      repost_rows: 0,
      execution_allowed: false,
      presentation_block_exempt_financial_rows: 0,
      owner_control_group_financial_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      live_1c_allowed: false,
      live_delete_allowed: false,
    },
  };
}

export function ownerDecisionRows(projection) {
  const result = [];
  for (const decisionCase of projection?.cases ?? []) {
    const integrity = integrityForDecisionCase(decisionCase, projection);
    const safeCase = integrity.ok
      ? decisionCase
      : {
          ...decisionCase,
          classification: "RESIDUAL_INTEGRITY_FAILURE",
          decision_type: "NO_POSTING",
          correction_allowed: false,
          execution_allowed: false,
          financial_materialization_forbidden: true,
          status_text: "RESIDUAL_INTEGRITY_FAILURE",
          reason: `${decisionCase.reason ?? "Owner decision"}; ${integrity.blocker}`,
        };
    const intalevAbsenceProof = relevantIntalevAbsenceProof(safeCase);
    for (const member of safeCase?.member_rows ?? []) {
      const exactPhysicalSourceProven = safeCase.SOURCE_OPERATION_PROVEN === true
        && safeCase.PHYSICAL_SOURCE_UNIQUE === true;
      const traces = member?.role === "RECLASS_SOURCE" && exactPhysicalSourceProven
        && Array.isArray(member?.source_traces) && member.source_traces.length > 0
        ? member.source_traces
        : [null];
      for (const trace of traces) {
        const memberDelta = number(member?.effective_delta) ?? 0;
        const traceAmount = number(trace?.amount ?? trace?.source_amount);
        const standaloneErpOnly = safeCase.classification === "ERP_ONLY"
          && member?.role === "ERP_ONLY";
        const effectiveDelta = traceAmount === null
          ? memberDelta
          : Math.sign(memberDelta || -1) * Math.abs(traceAmount);
        result.push({
        case_id: safeCase.case_id,
        classification: safeCase.classification,
         decision_type: safeCase.decision_type,
        economic_direction: member?.economic_direction ?? (member?.role === "RECLASS_SOURCE"
          ? "STORNO"
          : member?.role === "RECLASS_TARGET" ? "REPOST" : ""),
         approval_state: safeCase.approval_state,
        period: safeCase.period || projection.period,
        reconciliation_row: member.code,
        group: safeCase.classification,
        role: member.role,
        source_range: trace?.source_range ?? trace?.source_ref
          ?? (exactPhysicalSourceProven ? member?.source_range ?? member?.source_ref ?? "" : ""),
        source_date: trace?.source_date ?? trace?.date ?? member?.source_date ?? "",
        registrar: trace?.registrar ?? trace?.document ?? member?.registrar ?? "",
        posting_number: trace?.posting_number ?? trace?.posting_no ?? member?.posting_number ?? "",
        source_dt: trace?.dt ?? trace?.debit ?? trace?.source_dt ?? member?.source_dt ?? "",
        source_analytics_dt1: trace?.analytics_dt1 ?? trace?.debit_analytics?.[0] ?? trace?.source_analytics_dt1 ?? member?.source_analytics_dt1 ?? "",
        source_analytics_dt2: trace?.analytics_dt2 ?? trace?.debit_analytics?.[1] ?? trace?.source_analytics_dt2 ?? member?.source_analytics_dt2 ?? "",
        source_analytics_dt3: trace?.analytics_dt3 ?? trace?.debit_analytics?.[2] ?? trace?.source_analytics_dt3 ?? member?.source_analytics_dt3 ?? "",
        source_department_dt: trace?.department_dt ?? trace?.source_department_dt ?? member?.source_department_dt ?? "",
        source_kt: trace?.kt ?? trace?.credit ?? trace?.source_kt ?? member?.source_kt ?? "",
        source_analytics_kt1: trace?.analytics_kt1 ?? trace?.credit_analytics?.[0] ?? trace?.source_analytics_kt1 ?? member?.source_analytics_kt1 ?? "",
        source_analytics_kt2: trace?.analytics_kt2 ?? trace?.credit_analytics?.[1] ?? trace?.source_analytics_kt2 ?? member?.source_analytics_kt2 ?? "",
        source_analytics_kt3: trace?.analytics_kt3 ?? trace?.credit_analytics?.[2] ?? trace?.source_analytics_kt3 ?? member?.source_analytics_kt3 ?? "",
        source_department_kt: trace?.department_kt ?? trace?.source_department_kt ?? member?.source_department_kt ?? "",
        organization: projection.organization,
        source_amount: traceAmount ?? number(member?.source_amount)
          ?? (standaloneErpOnly ? null : safeCase.amount ?? 0),
        source_activity: trace?.activity ?? trace?.source_activity ?? member?.source_activity ?? safeCase.source_activity ?? "",
        source_scenario: trace?.scenario ?? trace?.source_scenario ?? member?.source_scenario ?? safeCase.source_scenario ?? "",
        correction_amount: ["STORNO_REPOST", "STORNO", "REPOST"].includes(safeCase.decision_type)
          ? Math.abs(effectiveDelta)
          : 0,
        change_side: "",
        target_dt: member?.target_dt ?? trace?.target_dt ?? safeCase.target_dt ?? "",
        target_analytics_dt1: member?.target_analytics_dt1 ?? trace?.target_analytics_dt1 ?? safeCase.target_analytics_dt1 ?? "",
        target_analytics_dt2: member?.target_analytics_dt2 ?? trace?.target_analytics_dt2 ?? safeCase.target_analytics_dt2 ?? "",
        target_analytics_dt3: member?.target_analytics_dt3 ?? trace?.target_analytics_dt3 ?? safeCase.target_analytics_dt3 ?? "",
        target_department_dt: member?.target_department_dt ?? trace?.target_department_dt ?? safeCase.target_department_dt ?? "",
        target_kt: member?.target_kt ?? trace?.target_kt ?? safeCase.target_kt ?? "",
        target_analytics_kt1: member?.target_analytics_kt1 ?? trace?.target_analytics_kt1 ?? safeCase.target_analytics_kt1 ?? "",
        target_analytics_kt2: member?.target_analytics_kt2 ?? trace?.target_analytics_kt2 ?? safeCase.target_analytics_kt2 ?? "",
        target_analytics_kt3: member?.target_analytics_kt3 ?? trace?.target_analytics_kt3 ?? safeCase.target_analytics_kt3 ?? "",
        target_department_kt: member?.target_department_kt ?? trace?.target_department_kt ?? safeCase.target_department_kt ?? "",
        reason: safeCase.reason,
        solution: safeCase.solution,
        erp_source_sha256: safeCase.erp_source_sha256 ?? "",
        evidence_state: safeCase.proof_status,
        proof_status: safeCase.proof_status,
        original_proof_status: safeCase.proof_status,
        analytical_effect: effectiveDelta,
        erp_current: member?.erp_article ?? safeCase.erp_article ?? member?.source_article ?? safeCase.source_article ?? "",
        intalev_target: member?.target_classification ?? safeCase.target_classification ?? member?.target_article ?? safeCase.target_article ?? "",
        intalev_current_classification: member?.intalev_current_classification ?? safeCase.intalev_current_classification ?? "",
        target_classification: member?.target_classification ?? safeCase.target_classification ?? "",
        source_article_missing: member?.source_article_missing ?? safeCase.source_article_missing ?? false,
        source_article: member?.source_article ?? safeCase.source_article ?? "",
        target_article: member?.target_article ?? safeCase.target_article ?? "",
        target_code: member?.target_code ?? safeCase.target_code ?? "",
        source_organization: trace?.source_organization ?? trace?.organization
          ?? member?.source_organization ?? safeCase.source_organization ?? "",
        source_organization_raw: trace?.source_organization_raw ?? trace?.organization ?? "",
        source_organization_alias_verified: trace?.source_organization_alias_verified === true,
        source_archive_path: trace?.source_archive_path ?? member?.source_archive_path ?? safeCase.source_archive_path ?? "",
        source_archive_sha256: trace?.source_archive_sha256 ?? member?.source_archive_sha256 ?? safeCase.source_archive_sha256 ?? "",
        journal_entry: trace?.journal_entry ?? member?.journal_entry ?? safeCase.journal_entry ?? "",
        journal_sha256: trace?.journal_sha256 ?? member?.journal_sha256 ?? safeCase.journal_sha256 ?? "",
        source_sheet: trace?.source_sheet ?? member?.source_sheet ?? safeCase.source_sheet ?? "",
        target_subkonto_slot: member?.target_subkonto_slot || safeCase.target_subkonto_slot || "",
        disclosure_group: "",
        target_side: "",
        review_state: safeCase.proof_status === "ECONOMIC_CORRECTION_PROVEN"
          || safeCase.proof_status === "PROVEN" ? "PROVEN_CONTROL" : "NEEDS_REVIEW",
        gap_evidence_ref: "",
        delete_document_type: "",
        delete_document_number: "",
        delete_posting_number: "",
        keep_document_number: "",
        source_rows: trace?.source_range
          ?? (exactPhysicalSourceProven ? member?.source_range ?? member?.source_ref ?? "" : ""),
        source_row_id: member?.source_row_id ?? trace?.source_row_id ?? "",
        correction_allowed: safeCase.correction_allowed === true,
        correction_authority: safeCase.correction_authority
          ?? (safeCase.ECONOMIC_CORRECTION_PROVEN === true
            ? "ECONOMIC_CORRECTION_PROVEN"
            : safeCase.accepted_intergroup_reclass === true ? "ECONOMIC_RECLASS_PROVEN" : ""),
        output_route: ["STORNO_REPOST", "STORNO", "REPOST"].includes(safeCase.decision_type)
          ? (safeCase.correction_allowed === true ? "READY" : "SPORNO")
          : "REVIEW_ONLY",
        economic_source_code: (safeCase?.member_rows ?? [])
          .filter((item) => item?.role === "RECLASS_SOURCE").map((item) => item.code).join(";"),
        economic_target_code: (safeCase?.member_rows ?? [])
          .filter((item) => item?.role === "RECLASS_TARGET").map((item) => item.code).join(";"),
        economic_route_id: safeCase.intergroup_reclass_id ?? member?.intergroup_reclass_id ?? "",
        intergroup_reclass_id: safeCase.intergroup_reclass_id ?? member?.intergroup_reclass_id ?? "",
        intergroup_reclass_proof_status: member?.intergroup_reclass_proof_status
          ?? safeCase.proof_status ?? "",
        accepted_intergroup_reclass: safeCase.accepted_intergroup_reclass === true,
        accepted_amount: safeCase.accepted_amount ?? 0,
        accepted_intergroup_effect: member?.accepted_intergroup_effect ?? 0,
        raw_delta: member?.raw_delta ?? null,
        root_effective_delta: member?.root_effective_delta ?? member?.effective_delta ?? null,
        effective_delta: member?.effective_delta ?? null,
        residual_atom_id: member?.residual_atom_id ?? "",
        transformation_id: member?.transformation_id ?? "",
        processing_stage: safeCase.processing_stage ?? "",
        stage_order: safeCase.stage_order ?? null,
        blockers: [
          ...(Array.isArray(safeCase?.missing_proof) ? safeCase.missing_proof : []),
          ...(safeCase?.unproven_reason ? [safeCase.unproven_reason] : []),
        ],
        effect_sha256: "",
        pair_id: safeCase.pair_id,
        integrity_status: integrity.classification,
        financial_materialization_forbidden: integrity.ok ? false : true,
        notes: `${safeCase.status_text}; execution_allowed=false; posting_rows=0`,
        source_operation_identity: member?.source_operation_identity ?? trace?.source_operation_identity ?? "",
        source_proof_status: trace?.source_proof_status ?? safeCase.proof_status,
        source_operation_proof_status: safeCase.SOURCE_OPERATION_PROVEN === true
          ? "SOURCE_OPERATION_PROVEN"
          : "SOURCE_OPERATION_UNPROVEN",
        intalev_source_scope_presence: safeCase.intalev_source_scope_presence ?? "",
        intalev_source_scope_absence_claimed: safeCase.intalev_source_scope_absence_claimed === true,
        intalev_source_scope_absence_proven: intalevAbsenceProof.proven,
        intalev_source_scope_inventory_complete: intalevAbsenceProof.source_inventory_complete,
        intalev_source_scope_complete: intalevAbsenceProof.source_scope_complete,
        intalev_source_amount_lost: intalevAbsenceProof.source_amount_lost,
        relevant_intalev_absence_proven: intalevAbsenceProof.proven,
        relevant_intalev_absence_blockers: [...intalevAbsenceProof.blockers],
        ECONOMIC_ROUTE_PROVEN: safeCase.ECONOMIC_ROUTE_PROVEN === true,
        ECONOMIC_STORNO_DIRECTION_PROVEN: safeCase.ECONOMIC_STORNO_DIRECTION_PROVEN === true,
        SOURCE_OPERATION_PROVEN: safeCase.SOURCE_OPERATION_PROVEN === true,
        PHYSICAL_SOURCE_UNIQUE: safeCase.PHYSICAL_SOURCE_UNIQUE === true,
        ECONOMIC_CORRECTION_PROVEN: safeCase.ECONOMIC_CORRECTION_PROVEN === true,
        OWNER_REVIEW_REQUIRED: safeCase.OWNER_REVIEW_REQUIRED === true,
        });
      }
    }
  }
  return result;
}

export function coveredRowCodes(projection) {
  return new Set([
    ...Object.keys(projection?.row_links ?? {}),
    ...(projection?.presentation_block_exemptions ?? []).map((item) => rowCode(item)),
  ]);
}
