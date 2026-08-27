import { IMPACT } from "../constants.mjs";
import { account, array, code, deriveBlock, first, joinPath, text } from "../normalize.mjs";
import { sha256Json } from "../io.mjs";
import { isOwnerPresentationBlockExempt } from "../../../reconciliation/source/owner_presentation_block_exemption.mjs";
import { structuralControlGroupsFromConfig } from "../../../reconciliation/source/structural_control_groups.mjs";

function pairContainsOwnerPresentationBlock(pair, structuralControlGroups) {
  return [
    ...array(pair?.source_codes),
    ...array(pair?.target_codes),
    ...array(pair?.source_member_ids),
    ...array(pair?.target_member_ids),
    ...array(pair?.source_members).map((member) => member?.code ?? member?.row_id),
    ...array(pair?.target_members).map((member) => member?.code ?? member?.row_id),
    ...array(pair?.member_deltas).map((member) => member?.code ?? member?.row_code),
  ].some((value) => isOwnerPresentationBlockExempt(value, structuralControlGroups));
}

function rowByCode(payload) {
  return new Map(array(payload.rows).map((row) => [code(row.code), row]));
}

function evidenceRowsByCode(payload) {
  const result = new Map();
  for (const row of array(payload.operation_evidence?.rows)) {
    const keys = [...new Set([row.code, row.row_code, row.parent_code].map(code).filter(Boolean))];
    for (const key of keys) {
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    }
  }
  return result;
}

function normalizedEvidenceRow(row, payload) {
  return {
    date: text(row?.date || row?.period),
    source_row: text(row?.source_row || row?.source_range || row?.source_row_id || row?.physical_row),
    registrar: text(row?.registrar || row?.document),
    document: text(row?.document || row?.registrar),
    posting_number: text(row?.posting_number ?? row?.posting_no),
    source_file: text(row?.source_file || row?.journal_input_path || payload.operation_evidence?.journal_input_path),
    debit_account: account(row?.debit_account || row?.debit),
    credit_account: account(row?.credit_account || row?.credit),
    debit_analytics: array(row?.debit_analytics || row?.analytics_debit || row?.debit_analytics_values).map(text),
    credit_analytics: array(row?.credit_analytics || row?.analytics_credit || row?.credit_analytics_values).map(text),
    debit_department: text(row?.debit_department || row?.department_debit),
    credit_department: text(row?.credit_department || row?.department_credit),
    cfo: text(row?.cfo),
    article: text(row?.article || row?.erp_article || row?.catalog_path),
    amount: Number(row?.amount ?? row?.sum ?? 0),
    proof_status: text(row?.proof_status),
    row_class: text(row?.row_class),
  };
}

function evidenceIsProven(rawRow, normalized) {
  const proofStatus = text(rawRow?.proof_status).toUpperCase();
  const rowClass = text(rawRow?.row_class).toUpperCase();
  if ([proofStatus, rowClass].some((value) => /NOT_PROVEN|UNPROVEN|CANDIDATE|EXCLUDED|BLOCKED/.test(value))) return false;
  const hasExactTrace = Boolean(
    normalized.source_row
    && normalized.registrar
    && normalized.posting_number
    && normalized.debit_account
    && normalized.credit_account
  );
  if (!hasExactTrace) return false;
  if (/PROVEN|EXACT/.test(proofStatus)) return true;
  // Backward compatibility with the pre-1.8 sidecar contract.  A legacy row is
  // accepted only when all exact posting coordinates are present.
  return Boolean(rawRow?.code && rawRow?.source_row && rawRow?.registrar && rawRow?.posting_number != null);
}

function summarizeEvidence(rawRows, payload) {
  const rows = rawRows.map((row) => ({ ...normalizedEvidenceRow(row, payload), proven: evidenceIsProven(row, normalizedEvidenceRow(row, payload)) }));
  const provenRows = rows.filter((row) => row.proven);
  const operationalRows = provenRows.filter((row) => !/^99(?:\.|$)/.test(row.debit_account));
  return {
    rows,
    provenRows,
    primary: operationalRows[0] || (!provenRows.length ? rows.find((row) => !/^99(?:\.|$)/.test(row.debit_account)) : null) || {},
    proofStatus: provenRows.length ? "PROVEN" : "UNPROVEN",
  };
}

function sideFromRow(row, system) {
  const isIntalev = system === "intalev";
  const articlePath = isIntalev ? first(row?.intalev_paths) || joinPath(row?.hierarchy_path) : first(row?.erp_catalog_paths) || first(row?.erp_paths);
  const articleCode = isIntalev ? code(row?.code) : code(first(row?.article_codes));
  const articleName = text(isIntalev ? row?.intalev_label : row?.erp_label);
  // hierarchy_group is a presentation level (ИТОГ/БЛОК/СТАТЬЯ/ДЕТАЛЬ), not
  // a business disclosure identity.  The business parent path is already
  // carried by articlePath and remains part of the rule signature.
  const block = deriveBlock(articlePath);
  return {
    opiu_block_code: "",
    opiu_block_name: block.name,
    opiu_block_path: block.path,
    article_code: articleCode,
    article_name: articleName,
    article_path: articlePath,
    catalog_uid: text(isIntalev ? row?.intalev_catalog_uid : row?.erp_catalog_uid),
    parent_uid: text(isIntalev ? row?.intalev_parent_uid : row?.erp_parent_uid),
    amount: Number(isIntalev ? row?.intalev_amount : row?.erp_amount),
  };
}

function scopeFromPayload(payload, context) {
  return {
    scope_type: context?.organization?.include_descendants ? "ORG_WITH_DESCENDANTS" : "ORG_ONLY",
    organization_id: text(context?.organization?.id || payload.organization_code),
    organization_code: text(payload.organization_code),
    organization_name: text(context?.organization?.name || payload.organization),
    organization_path: text(context?.organization?.path || payload.organization),
    cfo_id: "",
    cfo_name: "",
    cfo_path: "",
    include_descendants: Boolean(context?.organization?.include_descendants),
    mapping_status: text(context?.organization?.id || payload.organization_code) ? "matched" : "unmatched",
  };
}

function accountingFromRows(sourceRow, targetRow, evidence) {
  const evidenceRow = evidence?.primary ?? evidence ?? {};
  const accounts = [...array(sourceRow?.accounts), ...array(targetRow?.accounts)].map(account).filter(Boolean);
  return {
    debit_account: account(evidenceRow.debit_account || accounts[0]),
    debit_account_name: "",
    credit_account: account(evidenceRow.credit_account || accounts[1]),
    credit_account_name: "",
    debit_analytics: array(evidenceRow.debit_analytics).map(text),
    credit_analytics: array(evidenceRow.credit_analytics).map(text),
    debit_department: text(evidenceRow.debit_department || first(sourceRow?.departments)),
    credit_department: text(evidenceRow.credit_department || first(sourceRow?.departments)),
    cfo: text(evidenceRow.cfo || first(sourceRow?.cfo)),
  };
}

function hasStableIdentity(side) {
  return Boolean(side?.article_code || side?.catalog_uid);
}

function missingFields(candidate) {
  const fields = [];
  if (!candidate.scope.organization_id) fields.push("scope.organization_id");
  if (!candidate.intalev.opiu_block_name && !candidate.intalev.opiu_block_path) fields.push("intalev.opiu_block");
  if (!hasStableIdentity(candidate.intalev)) fields.push("intalev.article");
  if (!candidate.erp.opiu_block_name && !candidate.erp.opiu_block_path) fields.push("erp.opiu_block");
  if (!hasStableIdentity(candidate.erp)) fields.push("erp.article");
  if (candidate.action.action_type === "STORNO_REPOST") {
    if (!candidate.accounting.debit_account) fields.push("accounting.debit_account");
    if (!candidate.accounting.credit_account) fields.push("accounting.credit_account");
  }
  return fields;
}

function impactFor(candidate) {
  if (candidate.action.action_type === "CONTROL_ONLY") return IMPACT.CONTROL_ONLY;
  if (candidate.action.action_type === "MANUAL_REVIEW") return IMPACT.RECONCILIATION_FORMULA;
  // ONE_SIDE is an R001 correction draft.  Confirming it must not request an
  // R005 rematch because it does not change article matching or an R005 formula.
  if (candidate.action.action_type === "ONE_SIDE") return IMPACT.CORRECTION_ANALYTICS;
  if (candidate.action.action_type === "STORNO_REPOST" && (!candidate.accounting.debit_account || !candidate.accounting.credit_account)) return IMPACT.CORRECTION_ANALYTICS;
  if (candidate.action.action_type === "STORNO_REPOST") return IMPACT.CORRECTION_RECLASS;
  return IMPACT.RECONCILIATION_MAPPING;
}

function confidenceFor(candidate) {
  const missing = missingFields(candidate);
  const reasons = [];
  let score = 0.1;
  if (candidate.scope.organization_id) score += 0.05;
  if (hasStableIdentity(candidate.intalev)) score += 0.2;
  if (hasStableIdentity(candidate.erp)) score += 0.2;
  if (candidate.intalev.article_path) score += 0.08;
  if (candidate.erp.article_path) score += 0.08;
  if (candidate.evidence.proof_status === "PROVEN") {
    score += 0.29;
    reasons.push("Точная строка, регистратор, номер проводки и счета ERP доказаны");
  } else {
    reasons.push("Трасса ERP не доказана: кандидат не может стать проводкой или правилом автоматически");
  }
  if (missing.length) {
    score -= Math.min(0.4, missing.length * 0.08);
    reasons.push(`Не заполнены устойчивые поля: ${missing.join(", ")}`);
  }
  if (candidate.intalev.article_path) reasons.push("Есть полный путь Инталев");
  if (candidate.erp.article_path) reasons.push("Есть полный путь ERP");
  if (candidate.evidence.proof_status !== "PROVEN" || !hasStableIdentity(candidate.erp)) score = Math.min(score, 0.49);
  score = Math.max(0, Math.min(1, score));
  return { level: score >= 0.85 ? "HIGH" : score >= 0.55 ? "MEDIUM" : "LOW", score: Number(score.toFixed(2)), reasons };
}

function candidateEvidence(summary, payload, context, explanation) {
  return {
    source_engine: "R005",
    source_run_id: context.run_id,
    source_file: text(context.paths?.r005_codex_input || payload.report_path),
    source_sha256: text(context.source_hashes?.r005_codex_input || payload.report_sha256),
    source_rows: [...new Set(summary.rows.map((row) => row.source_row).filter(Boolean))],
    registrars: [...new Set(summary.rows.map((row) => row.registrar).filter(Boolean))],
    posting_numbers: [...new Set(summary.rows.map((row) => row.posting_number).filter(Boolean))],
    evidence_rows: summary.rows,
    proven_source_rows: summary.provenRows.map((row) => row.source_row),
    proof_status: summary.proofStatus,
    explanation,
  };
}

function applicationFor({ amount, candidateId, context, payload, summary, suffix, reviewOnly = false }) {
  if (!Number.isFinite(amount) || amount === 0) return null;
  const evidenceRow = summary.primary ?? {};
  // A proved source trace may support the review, but R005 never turns a
  // one-sided or mapping delta into an executable correction.  User decisions
  // keep the application in the safe СПОРНО/Односторонние contour.
  const proven = summary.proofStatus === "PROVEN" && !reviewOnly;
  return {
    application_id: `APPLICATION-${context.run_id}-${suffix}`,
    rule_id: null,
    revision_id: null,
    candidate_id: candidateId,
    run_id: context.run_id,
    organization_id: text(context.organization?.id || payload.organization_code),
    organization_name: text(context.organization?.name || payload.organization),
    period: text(context.period),
    amount: Math.abs(amount),
    currency: "RUB",
    registrar: text(evidenceRow.registrar),
    posting_number: text(evidenceRow.posting_number),
    source_file: text(evidenceRow.source_file || context.paths?.r005_codex_input || payload.report_path),
    source_row: text(evidenceRow.source_row),
    storno: null,
    repost: null,
    proof_status: summary.proofStatus,
    review_category: proven ? null : "Односторонние",
    output_route: proven ? null : "СПОРНО",
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    source: {
      engine: "R005",
      report_sha256: text(context.source_hashes?.r005_report || payload.report_sha256),
      codex_input_sha256: text(context.source_hashes?.r005_codex_input),
    },
    result_status: proven ? "PROPOSED" : "REVIEW",
    created_at: new Date().toISOString(),
  };
}

function finiteAmount(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function moneyCents(value) {
  const amount = finiteAmount(value);
  return amount === null ? null : Math.round(amount * 100);
}

function acceptedEconomicGenericDraft(generic, sourceMembers, targetMembers) {
  if (text(generic?.classification).toUpperCase() === "PRESENTATION_REGROUPING") return false;
  if (text(generic?.scope).toUpperCase() !== "INTER_GROUP") return false;
  if (text(generic?.proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return false;
  if (generic?.accepted_intergroup_reclass !== true || generic?.economic_reclass_proven !== true) return false;
  if (generic?.correction_allowed === true) return false;
  if (!/STORNO_REPOST.*REVIEW_ONLY/.test(text(generic?.financial_route).toUpperCase())) return false;
  if (!text(generic?.intergroup_reclass_id)) return false;

  const sources = sourceMembers.map((member) => moneyCents(member?.accepted_intergroup_effect));
  const targets = targetMembers.map((member) => moneyCents(member?.accepted_intergroup_effect));
  const accepted = moneyCents(generic?.accepted_amount);
  if (sources.some((amount) => amount === null || amount >= 0)) return false;
  if (targets.some((amount) => amount === null || amount <= 0)) return false;
  if (sourceMembers.some((member) => text(member?.economic_direction).toUpperCase() !== "STORNO")) return false;
  if (targetMembers.some((member) => text(member?.economic_direction).toUpperCase() !== "REPOST")) return false;
  if ([...sourceMembers, ...targetMembers].some((member) => moneyCents(member?.root_effective_delta) !== 0)) return false;

  const sourceTotal = sources.reduce((sum, amount) => sum + Math.abs(amount), 0);
  const targetTotal = targets.reduce((sum, amount) => sum + amount, 0);
  return accepted !== null && accepted > 0 && sourceTotal === accepted && targetTotal === accepted;
}

function genericMemberLeg(member, row, role, generic) {
  const side = sideFromRow(row, "intalev");
  const effect = finiteAmount(member?.accepted_intergroup_effect);
  return {
    code: code(member?.code ?? member?.row_id),
    role,
    economic_direction: role === "RECLASS_SOURCE" ? "STORNO" : "REPOST",
    correction_amount: effect === null ? null : Math.abs(effect),
    raw_delta: finiteAmount(member?.raw_delta),
    effective_delta: finiteAmount(member?.effective_delta),
    root_effective_delta: finiteAmount(member?.root_effective_delta),
    accepted_intergroup_effect: effect,
    residual_atom_id: text(member?.residual_atom_id),
    transformation_id: text(member?.transformation_id),
    article_code: side.article_code,
    article_name: side.article_name,
    article_path: side.article_path,
    accepted_intergroup_reclass: true,
    intergroup_reclass_id: text(member?.intergroup_reclass_id || generic?.intergroup_reclass_id),
    intergroup_reclass_proof_status: text(member?.intergroup_reclass_proof_status || generic?.proof_status),
    processing_stage: text(generic?.processing_stage),
    stage_order: finiteAmount(generic?.stage_order),
  };
}

const STRUCTURAL_ROLES = new Set([
  "ИТОГ",
  "БЛОК",
  "ПОДБЛОК",
  "ГРУППА",
  "РОДИТЕЛЬ",
  "TOTAL",
  "GROUP",
  "PARENT",
]);

function nonEmptyChildren(value) {
  return Array.isArray(value) && value.length > 0;
}

function structuralIndex(payload) {
  const parentCodes = new Set();
  const parentNodeIds = new Set();
  for (const row of array(payload?.rows)) {
    const parentCode = code(row?.hierarchy_parent_code || row?.parent_code);
    if (parentCode) parentCodes.add(parentCode);
    const parentNodeId = text(row?.hierarchy_parent_node_id || row?.parent_node_id);
    if (parentNodeId) parentNodeIds.add(parentNodeId);
  }
  return { parentCodes, parentNodeIds };
}

function isStructural(row, index = { parentCodes: new Set(), parentNodeIds: new Set() }) {
  if (
    row?.structural_non_posting === true
    || row?.hierarchy_has_children === true
    || row?.has_children === true
    || nonEmptyChildren(row?.hierarchy_immediate_children)
    || nonEmptyChildren(row?.immediate_children)
    || nonEmptyChildren(row?.child_codes)
    || nonEmptyChildren(row?.children)
  ) return true;

  const rowCode = code(row?.code || row?.row_code);
  if (rowCode && index.parentCodes.has(rowCode)) return true;
  const nodeId = text(row?.hierarchy_node_id || row?.node_id);
  if (nodeId && index.parentNodeIds.has(nodeId)) return true;

  const groups = [row?.group, row?.hierarchy_group, row?.row_kind, row?.role]
    .map((value) => text(value).toLocaleUpperCase("ru-RU"))
    .filter(Boolean);
  return groups.some((value) => STRUCTURAL_ROLES.has(value));
}

function isMappingGap(row) {
  const statuses = [row?.intalev_status, row?.erp_status, row?.reconciliation_status, row?.technical_status]
    .map((value) => text(value).toUpperCase());
  return statuses.some((value) => /NOT_MAPPED|UNMAPPED|MISSING_ARTICLE|UNKNOWN_ARTICLE/.test(value));
}

function toleranceFor(payload) {
  const value = Number(payload?.tolerance_rubles ?? payload?.tolerance ?? 0.01);
  return Number.isFinite(value) && value >= 0 ? value : 0.01;
}

export function adaptR005(payload, context) {
  if (payload?.schema !== "opiu-codex-review-input-v1") throw new Error(`Unsupported R005 schema: ${payload?.schema}`);
  const structuralControlGroups = structuralControlGroupsFromConfig({
    tolerance: toleranceFor(payload),
    structural_group_control_sets: payload?.structural_group_control_sets ?? [],
  });
  const rows = rowByCode(payload);
  const evidenceRows = evidenceRowsByCode(payload);
  const scope = scopeFromPayload(payload, context);
  const candidates = [];
  const applications = [];
  const warnings = [];
  const covered = new Set();
  const structure = structuralIndex(payload);
  const genericCandidates = array(payload.generic_reclassification_candidates);
  const pairs = array(payload.zero_sum_storno_repost_candidates).length ? array(payload.zero_sum_storno_repost_candidates) : array(payload.operation_evidence?.pair_candidates);

  // Canonical generic cases are already classified by R005 with their full
  // N:M membership.  Represent them as one review object and cover every
  // member so the adapter cannot degrade the remaining components into
  // unrelated ONE_SIDE candidates. Only an already accepted economic route
  // with zero post-consumption root effects may become one disputed
  // application; Rules still does not invent or materialize physical rows.
  for (const generic of genericCandidates) {
    if (pairContainsOwnerPresentationBlock(generic, structuralControlGroups)) continue;
    const sourceMembers = array(generic?.source_members);
    const targetMembers = array(generic?.target_members);
    const sourceCodes = sourceMembers
      .map((member) => code(member?.code ?? member?.row_id))
      .filter(Boolean);
    const targetCodes = targetMembers
      .map((member) => code(member?.code ?? member?.row_id))
      .filter(Boolean);
    const memberCodes = [...new Set([...sourceCodes, ...targetCodes])];
    if (sourceCodes.length === 0 || targetCodes.length === 0) continue;
    const sourceRow = rows.get(sourceCodes[0]) ?? {};
    const targetRow = rows.get(targetCodes[0]) ?? {};
    const summary = summarizeEvidence(
      sourceCodes.flatMap((sourceCode) => evidenceRows.get(sourceCode) ?? []),
      payload,
    );
    const presentationOnly = text(generic?.classification).toUpperCase() === "PRESENTATION_REGROUPING";
    const acceptedEconomicDraft = acceptedEconomicGenericDraft(generic, sourceMembers, targetMembers);
    const memberLegs = acceptedEconomicDraft ? [
      ...sourceMembers.map((member) => genericMemberLeg(member, rows.get(code(member?.code ?? member?.row_id)) ?? {}, "RECLASS_SOURCE", generic)),
      ...targetMembers.map((member) => genericMemberLeg(member, rows.get(code(member?.code ?? member?.row_id)) ?? {}, "RECLASS_TARGET", generic)),
    ] : [];
    const candidateId = text(generic?.candidate_id) || `CAND-R005-GENERIC-${sourceCodes.join("-")}-${targetCodes.join("-")}`;
    const candidate = {
      candidate_id: candidateId,
      existing_rule_id: null,
      existing_revision_id: null,
      decision: "UNRESOLVED",
      impact_class: presentationOnly
        ? IMPACT.RECONCILIATION_MAPPING
        : acceptedEconomicDraft ? IMPACT.CORRECTION_ANALYTICS : IMPACT.RECONCILIATION_FORMULA,
      scope: structuredClone(scope),
      intalev: sideFromRow(sourceRow, "intalev"),
      erp: sideFromRow(targetRow, "erp"),
      accounting: accountingFromRows(sourceRow, targetRow, summary),
      action: {
        action_type: presentationOnly ? "MAP_ARTICLE" : acceptedEconomicDraft ? "STORNO_REPOST" : "MANUAL_REVIEW",
        condition_text: presentationOnly
          ? "Изменение только reporting placement; финансовые строки запрещены."
          : acceptedEconomicDraft
            ? "Экономический межгрупповой маршрут доказан и потреблён в R005; физические реквизиты ERP неполны, поэтому допустим только draft СПОРНО."
            : "Один generic zero-sum N:M case; решение закрыто до exact economic proof.",
        parameters: {
          source_codes: sourceCodes,
          target_codes: targetCodes,
          reclass_scope: text(generic?.scope),
          cardinality: text(generic?.cardinality),
          proof_status: text(generic?.proof_status),
          review_only: generic?.correction_allowed !== true,
          economic_reclass_proven: acceptedEconomicDraft,
          accepted_intergroup_reclass: acceptedEconomicDraft,
          intergroup_reclass_id: acceptedEconomicDraft ? text(generic?.intergroup_reclass_id) : "",
          accepted_amount: acceptedEconomicDraft ? finiteAmount(generic?.accepted_amount) : null,
          member_legs: memberLegs,
        },
      },
      evidence: candidateEvidence(
        summary,
        payload,
        context,
        `R005 сформировал один generic ${text(generic?.scope)} ${text(generic?.cardinality)} case: ${sourceCodes.join(" + ")} → ${targetCodes.join(" + ")}. ${text(generic?.proof_reason)}`,
      ),
      confidence: { level: "LOW", score: 0, reasons: [] },
      missing_fields: array(generic?.missing_proof).map(text).filter(Boolean),
      required_user_actions: array(generic?.missing_proof).map((field) => `Доказать ${text(field)}`),
      user_status: acceptedEconomicDraft ? "PENDING_REVIEW" : "MANUAL_REVIEW",
      source_payload_hash: sha256Json(generic),
    };
    candidate.confidence = confidenceFor(candidate);
    if (candidate.required_user_actions.length === 0) {
      candidate.required_user_actions.push("Проверить единый маршрут переклассификации");
    }
    candidates.push(candidate);
    if (acceptedEconomicDraft) {
      const application = applicationFor({
        amount: finiteAmount(generic?.accepted_amount),
        candidateId,
        context,
        payload,
        summary,
        suffix: `GENERIC-${sha256Json({ candidateId, route: generic?.intergroup_reclass_id }).slice(0, 12)}`,
        reviewOnly: true,
      });
      if (application) {
        applications.push({
          ...application,
          review_category: "Межгрупповой пересорт",
          economic_proof_status: text(generic?.proof_status),
          economic_route_id: text(generic?.intergroup_reclass_id),
        });
      }
    }
    memberCodes.forEach((memberCode) => covered.add(memberCode));
  }

  for (const pair of pairs) {
    if (pairContainsOwnerPresentationBlock(pair, structuralControlGroups)) continue;
    const sourceCode = code(array(pair.source_codes)[0]);
    const targetCode = code(array(pair.target_codes)[0]);
    if (!sourceCode || !targetCode) continue;
    // Any overlap with a canonical N:M case is a conflict, not an independent
    // legacy route. The canonical case already carries every member and keeps
    // the whole route fail-closed for review.
    if (covered.has(sourceCode) || covered.has(targetCode)) {
      covered.add(sourceCode);
      covered.add(targetCode);
      continue;
    }
    const sourceRow = rows.get(sourceCode) ?? {};
    const targetRow = rows.get(targetCode) ?? {};
    const structuralPair = isStructural(sourceRow, structure) || isStructural(targetRow, structure);
    const summary = summarizeEvidence(evidenceRows.get(sourceCode) ?? [], payload);
    const candidateId = `CAND-R005-${sourceCode}-${targetCode}`;
    const candidate = {
      candidate_id: candidateId,
      existing_rule_id: null,
      existing_revision_id: null,
      decision: structuralPair ? "NO_RULE" : "UNRESOLVED",
      impact_class: structuralPair ? IMPACT.CONTROL_ONLY : IMPACT.CORRECTION_RECLASS,
      scope: structuredClone(scope),
      intalev: sideFromRow(sourceRow, "intalev"),
      erp: sideFromRow(targetRow, "erp"),
      accounting: accountingFromRows(sourceRow, targetRow, summary),
      action: {
        action_type: structuralPair ? "CONTROL_ONLY" : "STORNO_REPOST",
        condition_text: structuralPair
          ? "Родительская/групповая строка не является источником корректировки; требуется конкретная дочерняя строка и доказанная исходная операция ERP."
          : "Перенос внутри группы с нулевой итоговой дельтой",
        parameters: {
          source_code: sourceCode,
          target_code: targetCode,
          ...(structuralPair ? { structural_non_posting: true } : {}),
        },
      },
      evidence: candidateEvidence(summary, payload, context, `R005 сформировал парный кандидат ${sourceCode} → ${targetCode}; требуется подтверждение пользователя.`),
      confidence: { level: "LOW", score: 0, reasons: [] },
      missing_fields: [],
      required_user_actions: [],
      user_status: structuralPair ? "MANUAL_REVIEW" : "PENDING_REVIEW",
      source_payload_hash: sha256Json(pair),
    };
    candidate.missing_fields = missingFields(candidate);
    candidate.impact_class = impactFor(candidate);
    candidate.required_user_actions = structuralPair
      ? ["Раскрыть parent/group до конкретной дочерней строки и доказанной ERP source operation; саму группу не корректировать"]
      : candidate.missing_fields.map((field) => `Заполнить ${field}`);
    if (!candidate.required_user_actions.length) candidate.required_user_actions.push("Подтвердить правило для организации");
    candidate.confidence = confidenceFor(candidate);
    candidates.push(candidate);
    const sourceMember = array(pair.member_deltas).find((item) => code(item.code) === sourceCode);
    const amount = Math.abs(Number(sourceMember?.delta ?? sourceRow?.delta ?? 0));
    if (!structuralPair) {
      const application = applicationFor({ amount, candidateId, context, payload, summary, suffix: `${sourceCode}-${targetCode}` });
      if (application) applications.push(application);
    }
    covered.add(sourceCode);
    covered.add(targetCode);
  }

  for (const row of array(payload.rows)) {
    const rowCode = code(row.code);
    if (isOwnerPresentationBlockExempt(row, structuralControlGroups)) continue;
    if (covered.has(rowCode) || !row.is_discrepancy) continue;
    const delta = Number(row.delta ?? 0);
    if (!Number.isFinite(delta)) {
      warnings.push(`Строка ${rowCode}: дельта не является числом; кандидат не создан.`);
      continue;
    }
    if (Math.abs(delta) <= toleranceFor(payload)) {
      continue;
    }

    const structural = isStructural(row, structure);
    const mappingGap = !structural && isMappingGap(row);
    const actionType = structural ? "CONTROL_ONLY" : mappingGap ? "MAP_ARTICLE" : "ONE_SIDE";
    const decision = structural ? "NO_RULE" : "UNRESOLVED";
    const userStatus = structural ? "MANUAL_REVIEW" : "PENDING_REVIEW";
    const summary = summarizeEvidence(evidenceRows.get(rowCode) ?? [], payload);
    const candidateId = `CAND-R005-${rowCode}-${sha256Json({ path: first(row.erp_catalog_paths), label: row.erp_label, delta }).slice(0, 8)}`;
    const candidate = {
      candidate_id: candidateId,
      existing_rule_id: null,
      existing_revision_id: null,
      decision,
      impact_class: structural ? IMPACT.CONTROL_ONLY : mappingGap ? IMPACT.RECONCILIATION_MAPPING : IMPACT.RECONCILIATION_FORMULA,
      scope: structuredClone(scope),
      intalev: sideFromRow(row, "intalev"),
      erp: sideFromRow(row, "erp"),
      accounting: accountingFromRows(row, row, summary),
      action: {
        action_type: actionType,
        condition_text: text(row.erp_note || row.intalev_note),
        parameters: { row_code: rowCode, structural_non_posting: structural, delta },
      },
      evidence: candidateEvidence(summary, payload, context, `Строка ${rowCode}: ${text(row.reconciliation_status)}; дельта ${delta}.`),
      confidence: { level: "LOW", score: 0, reasons: [] },
      missing_fields: [],
      required_user_actions: [],
      user_status: userStatus,
      source_payload_hash: sha256Json(row),
    };
    candidate.missing_fields = missingFields(candidate);
    candidate.impact_class = impactFor(candidate);
    if (structural) {
      candidate.required_user_actions = ["Проверить расхождение итоговой/структурной строки; не создавать правило статьи"];
    } else if (mappingGap) {
      candidate.required_user_actions = candidate.missing_fields.map((field) => `Заполнить ${field}`);
      if (!candidate.required_user_actions.length) candidate.required_user_actions.push("Подтвердить сопоставление статей");
    } else if (actionType === "ONE_SIDE") {
      candidate.required_user_actions = ["Проверить состав операций и формулу строки; выбрать решение по одностороннему расхождению"];
    } else {
      candidate.required_user_actions = ["Проверить строку и выбрать решение пользователя"];
    }
    candidate.confidence = confidenceFor(candidate);
    candidates.push(candidate);

    if (!structural) {
      const application = applicationFor({
        amount: Math.abs(delta),
        candidateId,
        context,
        payload,
        summary,
        suffix: rowCode,
        reviewOnly: true,
      });
      if (application) applications.push(application);
    }
  }

  const unassignedEvidenceRows = array(payload.operation_evidence?.unassigned_rows)
    .map((row) => ({ ...normalizedEvidenceRow(row, payload), proven: false }));
  return {
    candidates,
    applications,
    warnings,
    unassigned_evidence_rows: unassignedEvidenceRows,
    source: { engine: "R005", schema: payload.schema },
  };
}
