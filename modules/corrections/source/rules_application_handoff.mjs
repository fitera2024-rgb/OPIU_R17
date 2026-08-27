function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function first(...values) {
  return values.map(text).find(Boolean) ?? "";
}

function evidenceRows(candidate) {
  return Array.isArray(candidate?.evidence?.evidence_rows) ? candidate.evidence.evidence_rows : [];
}

function evidenceLine(row, index) {
  const analytics = [row?.debit_analytics, row?.credit_analytics, row?.article, row?.description]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(text)
    .filter(Boolean)
    .join("; ");
  return [
    `Источник ${index + 1}`,
    `регистратор ${first(row?.registrar, row?.document) || "не указан"}`,
    `проводка ${first(row?.posting_number, row?.posting_no) || "не указана"}`,
    `строка ${first(row?.source_row, row?.source_range) || "не указана"}`,
    `Дт ${first(row?.debit, row?.debit_account) || "не указан"}`,
    `Кт ${first(row?.credit, row?.credit_account) || "не указан"}`,
    analytics ? `аналитика/описание ${analytics}` : "аналитика/описание не указаны",
    Number.isFinite(Number(row?.amount)) ? `сумма ${Math.abs(Number(row.amount))}` : "",
  ].filter(Boolean).join(", ");
}

function amountText(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)
    : "не определена";
}

function finiteNumber(value) {
  if (value === null || value === undefined || text(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function analyticsSlot(value, index) {
  if (Array.isArray(value)) return text(value[index]);
  return index === 0 ? text(value) : "";
}

function groupBreakdownNarrative(candidate) {
  const breakdown = candidate?.evidence?.group_delta_breakdown;
  if (!breakdown || typeof breakdown !== "object") return "";
  const parts = [];
  const groupName = first(breakdown.group_label, breakdown.group_code, "группировка");
  if (Number.isFinite(Number(breakdown.group_delta))) {
    parts.push(`Групповая дельта «${groupName}»: ${amountText(breakdown.group_delta)}. Саму группировку в проводку не превращать.`);
  } else {
    parts.push(`Расхождение относится к группировке «${groupName}». Саму группировку в проводку не превращать.`);
  }

  const financialChildren = Array.isArray(breakdown.financial_children) ? breakdown.financial_children : [];
  const childDeltas = financialChildren.filter((item) => Number.isFinite(Number(item?.delta)) && Math.abs(Number(item.delta)) > 0.000001);
  if (childDeltas.length) {
    parts.push(`Дочерние строки сверки с дельтой: ${childDeltas.slice(0, 12).map((item) => `${first(item.code)} ${first(item.label)} = ${amountText(item.delta)}`).join("; ")}.`);
  }

  const intalevChildren = Array.isArray(breakdown?.intalev_source_group?.children) ? breakdown.intalev_source_group.children : [];
  if (intalevChildren.length) {
    parts.push(`Инталев внутри группы: ${intalevChildren.slice(0, 12).map((item) => `${first(item.label)} = ${amountText(item.direct_total)}`).join("; ")}.`);
  }

  const erpChildren = Array.isArray(breakdown?.erp_source_group?.children) ? breakdown.erp_source_group.children : [];
  if (erpChildren.length) {
    parts.push(`ERP внутри группы: ${erpChildren.slice(0, 12).map((item) => `${first(item.label)} = ${amountText(item.direct_total)}`).join("; ")}.`);
  }

  const reviewRows = Array.isArray(breakdown.exact_article_review_rows) ? breakdown.exact_article_review_rows : [];
  if (reviewRows.length) {
    parts.push(`Исходные ERP-проводки для проверки: ${reviewRows.slice(0, 8).map((row) => {
      const where = [
        first(row?.registrar) ? `документ ${first(row.registrar)}` : "",
        first(row?.posting_number) ? `проводка ${first(row.posting_number)}` : "",
        first(row?.source_row) ? `строка ${first(row.source_row)}` : "",
        first(row?.debit_account) ? `Дт ${first(row.debit_account)}` : "",
        first(row?.credit_account) ? `Кт ${first(row.credit_account)}` : "",
        first(row?.article) ? `статья «${first(row.article)}»` : "",
        Number.isFinite(Number(row?.amount)) ? `сумма ${amountText(row.amount)}` : "",
      ].filter(Boolean).join(", ");
      return where;
    }).filter(Boolean).join(" | ")}. Эти строки остаются review-only до подтверждения связи.`);
  }

  if (first(breakdown.note)) parts.push(first(breakdown.note));
  return parts.join(" ");
}

export function applicationNarrative(application) {
  const candidate = application?.candidate_snapshot ?? {};
  const rows = evidenceRows(candidate);
  const reasons = [
    candidate?.evidence?.explanation,
    groupBreakdownNarrative(candidate),
    ...(Array.isArray(candidate?.confidence?.reasons) ? candidate.confidence.reasons : []),
    ...(Array.isArray(candidate?.required_user_actions) ? candidate.required_user_actions : []),
    ...(Array.isArray(candidate?.missing_fields) && candidate.missing_fields.length
      ? [`Не заполнены доказательные поля: ${candidate.missing_fields.join(", ")}`]
      : []),
    `Статус доказательств: ${first(application?.proof_status, candidate?.evidence?.proof_status) || "UNPROVEN"}`,
    `Маршрут: ${first(application?.output_route) || "СПОРНО"}`,
  ].map(text).filter(Boolean);
  return {
    reason: [...new Set(reasons)].join("; "),
    sourceEvidence: rows.length
      ? rows.map(evidenceLine).join(" | ")
      : "Исходные проводки/регистраторы не переданы Rules Engine; требуется проверка источника.",
    sourceRows: rows.map((row) => first(row?.source_row, row?.source_range)).filter(Boolean).join("; "),
    registrars: rows.map((row) => first(row?.registrar, row?.document)).filter(Boolean).join("; "),
    postingNumbers: rows.map((row) => first(row?.posting_number, row?.posting_no)).filter(Boolean).join("; "),
  };
}

function isSafeDisputedApplication(application, options) {
  const status = text(application?.result_status).toUpperCase();
  if (!["PROPOSED", "REVIEW"].includes(status)) return false;
  const candidate = application?.candidate_snapshot;
  const actionType = text(candidate?.action?.action_type).toUpperCase();
  if (!candidate || !["STORNO_REPOST", "ONE_SIDE"].includes(actionType)) return false;
  const parameters = candidate?.action?.parameters ?? {};
  const explicitControl = candidate?.group_review_only === true
    || candidate?.hierarchy_has_children === true
    || candidate?.has_children === true
    || parameters?.structural_non_posting === true
    || parameters?.hierarchy_has_children === true
    || text(candidate?.impact_class).toUpperCase() === "CONTROL_ONLY"
    || text(candidate?.decision).toUpperCase() === "NO_RULE";
  if (explicitControl) return false;
  const groupDiagnostic = text(candidate?.evidence?.group_delta_breakdown?.mode).toUpperCase() === "GROUP_DRILLDOWN_REVIEW_ONLY";
  if (groupDiagnostic && !acceptedGenericMemberLegs(application, candidate)) return false;
  if (options.runId && text(application?.run_id) !== text(options.runId)) return false;
  if (options.organizationId && text(application?.organization_id) !== text(options.organizationId)) return false;
  if (options.period && text(application?.period) !== text(options.period)) return false;
  if (application?.execution_allowed !== false || application?.ready_to_upload !== false || application?.release_allowed !== false || application?.live_1c_allowed !== false || Number(application?.posting_rows ?? 0) !== 0) return false;
  return application?.disputed_only === true
    && text(application?.output_route).toUpperCase() === "СПОРНО"
    && text(application?.proof_status).toUpperCase() === "UNPROVEN"
    && text(application?.review_state).toUpperCase() === "NEEDS_REVIEW";
}

function correctionReason({ candidate, primary, sourceArticle, targetArticle, sourceDebit, sourceCredit, targetDebit, targetCredit }) {
  const parts = [];
  const registrar = first(primary?.registrar, primary?.document);
  const posting = first(primary?.posting_number, primary?.posting_no);
  const sourceRow = first(primary?.source_row, primary?.source_range);
  const source = [
    registrar ? `документ ${registrar}` : "",
    posting ? `проводка ${posting}` : "",
    sourceRow ? `строка ${sourceRow}` : "",
    sourceDebit ? `Дт ${sourceDebit}` : "",
    sourceCredit ? `Кт ${sourceCredit}` : "",
  ].filter(Boolean).join(", ");
  if (source) parts.push(`Исходная проводка: ${source}.`);

  if (sourceArticle && targetArticle && sourceArticle !== targetArticle) {
    parts.push(`По сверке статья изменяется: «${sourceArticle}» → «${targetArticle}».`);
  } else if (sourceArticle) {
    parts.push(`Статья сохраняется из исходной проводки: «${sourceArticle}».`);
  } else if (targetArticle) {
    parts.push(`Целевая статья взята из сверки R005: «${targetArticle}».`);
  }

  const accountChanges = [];
  if (sourceDebit && targetDebit && sourceDebit !== targetDebit) accountChanges.push(`Дт ${sourceDebit} → ${targetDebit}`);
  if (sourceCredit && targetCredit && sourceCredit !== targetCredit) accountChanges.push(`Кт ${sourceCredit} → ${targetCredit}`);
  if (accountChanges.length) {
    parts.push(`Счета меняются только по отдельному доказанному выбору: ${accountChanges.join(", ")}.`);
  } else if (sourceDebit || sourceCredit) {
    const preserved = [sourceDebit ? `Дт ${sourceDebit}` : "", sourceCredit ? `Кт ${sourceCredit}` : ""].filter(Boolean).join(" / ");
    parts.push(`Счета ${preserved} сохраняются как в исходной ERP-проводке.`);
  }

  const condition = first(candidate?.action?.condition_text);
  if (condition) parts.push(`Основание R005: ${condition}.`);
  return parts.join(" ");
}

function moneyCents(value) {
  const amount = finiteNumber(value);
  return amount === null ? null : Math.round(amount * 100);
}

function exactCodeSet(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))].sort();
}

function acceptedGenericMemberLegs(application, candidate) {
  const parameters = candidate?.action?.parameters ?? {};
  if (text(candidate?.action?.action_type).toUpperCase() !== "STORNO_REPOST") return null;
  if (text(parameters?.reclass_scope).toUpperCase() !== "INTER_GROUP") return null;
  if (parameters?.economic_reclass_proven !== true || parameters?.accepted_intergroup_reclass !== true) return null;
  if (text(parameters?.proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return null;
  if (text(application?.economic_proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return null;
  const routeId = first(parameters?.intergroup_reclass_id, application?.economic_route_id);
  if (!routeId) return null;
  const acceptedCents = moneyCents(parameters?.accepted_amount);
  if (acceptedCents === null || acceptedCents <= 0 || moneyCents(application?.amount) !== acceptedCents) return null;

  const legs = Array.isArray(parameters?.member_legs) ? parameters.member_legs : [];
  if (legs.length < 2) return null;
  const normalized = [];
  const identities = new Set();
  for (const leg of legs) {
    const code = text(leg?.code);
    const role = text(leg?.role).toUpperCase();
    const expectedDirection = role === "RECLASS_SOURCE" ? "STORNO" : role === "RECLASS_TARGET" ? "REPOST" : "";
    const direction = text(leg?.economic_direction).toUpperCase();
    const effect = finiteNumber(leg?.accepted_intergroup_effect);
    const effectCents = moneyCents(effect);
    const identity = `${role}\u0000${code}`;
    if (!code || !expectedDirection || direction !== expectedDirection || identities.has(identity)) return null;
    if (effectCents === null || (role === "RECLASS_SOURCE" ? effectCents >= 0 : effectCents <= 0)) return null;
    if (moneyCents(leg?.correction_amount) !== Math.abs(effectCents)) return null;
    if (moneyCents(leg?.root_effective_delta) !== 0) return null;
    if (leg?.accepted_intergroup_reclass !== true) return null;
    if (text(leg?.intergroup_reclass_id) !== routeId) return null;
    if (text(leg?.intergroup_reclass_proof_status).toUpperCase() !== "ECONOMIC_RECLASS_PROVEN") return null;
    identities.add(identity);
    normalized.push({ ...leg, code, role, economic_direction: direction, accepted_intergroup_effect: effect });
  }

  const sources = normalized.filter((leg) => leg.role === "RECLASS_SOURCE");
  const targets = normalized.filter((leg) => leg.role === "RECLASS_TARGET");
  if (!sources.length || !targets.length) return null;
  const sourceTotal = sources.reduce((sum, leg) => sum + Math.abs(moneyCents(leg.accepted_intergroup_effect)), 0);
  const targetTotal = targets.reduce((sum, leg) => sum + moneyCents(leg.accepted_intergroup_effect), 0);
  if (sourceTotal !== acceptedCents || targetTotal !== acceptedCents) return null;
  if (JSON.stringify(exactCodeSet(parameters?.source_codes)) !== JSON.stringify(exactCodeSet(sources.map((leg) => leg.code)))) return null;
  if (JSON.stringify(exactCodeSet(parameters?.target_codes)) !== JSON.stringify(exactCodeSet(targets.map((leg) => leg.code)))) return null;
  return { routeId, acceptedAmount: acceptedCents / 100, sources, targets, legs: normalized };
}

function memberArticle(leg) {
  return first(leg?.article_path, leg?.article_name, leg?.article_code, leg?.code);
}

export function rulesApplicationsToDisputedDecisions(payload, options = {}) {
  const applications = Array.isArray(payload?.applications) ? payload.applications : [];
  return applications
    .filter((application) => isSafeDisputedApplication(application, options))
    .flatMap((application) => {
      const candidate = application?.candidate_snapshot ?? {};
      const rows = evidenceRows(candidate);
      const primary = rows[0] ?? {};
      const narrative = applicationNarrative(application);
      const actionType = text(candidate?.action?.action_type).toUpperCase();
      const decisionType = actionType === "STORNO_REPOST" ? "STORNO_REPOST" : "ADD_ONE_SIDE";
      const sourceArticle = first(primary?.article, candidate?.intalev?.article_path, candidate?.intalev?.article_name, candidate?.intalev?.article_code);
      const targetArticle = first(candidate?.erp?.article_path, candidate?.erp?.article_name, candidate?.erp?.article_code, sourceArticle);
      const sourceDebit = first(primary?.debit, primary?.debit_account, candidate?.accounting?.debit_account);
      const sourceCredit = first(primary?.credit, primary?.credit_account, candidate?.accounting?.credit_account);
      const exactTargetSelection = text(candidate?.account_selection?.catalog_version_id)
        && (text(candidate?.account_selection?.debit_account_id) || text(candidate?.account_selection?.credit_account_id));
      const targetDebit = exactTargetSelection ? first(candidate?.accounting?.debit_account, sourceDebit) : sourceDebit;
      const targetCredit = exactTargetSelection ? first(candidate?.accounting?.credit_account, sourceCredit) : sourceCredit;
      const topOrganization = first(options.organization, application?.organization_name, candidate?.scope?.organization_name, "НЕ ОПРЕДЕЛЕНА — ВЕРХНИЙ УРОВЕНЬ ОТЧЁТА");
      const businessReason = correctionReason({ candidate, primary, sourceArticle, targetArticle, sourceDebit, sourceCredit, targetDebit, targetCredit });
      const analyticalBasisId = first(candidate?.action?.parameters?.row_code);
      const analyticalEffect = finiteNumber(candidate?.action?.parameters?.delta ?? application?.amount);
      const erpCurrent = finiteNumber(candidate?.erp?.amount);
      const intalevTarget = finiteNumber(candidate?.intalev?.amount);
      const basisContractBlockers = [];
      if (analyticalBasisId && (erpCurrent === null || intalevTarget === null)) {
        basisContractBlockers.push("INCOMPLETE_R005_BASIS_TOTALS");
      } else if (analyticalBasisId && analyticalEffect !== null
        && Math.round(analyticalEffect * 100) !== Math.round((intalevTarget - erpCurrent) * 100)) {
        basisContractBlockers.push("INVALID_R005_SIGNED_DELTA");
      }
      const decision = {
        case_id: first(application?.application_id, application?.candidate_id),
        pair_id: first(application?.candidate_id, application?.application_id),
        decision_type: decisionType,
        role: ["RECLASS_SOURCE", "RECLASS_TARGET", "STANDALONE"].includes(
          text(candidate?.action?.parameters?.role).toUpperCase(),
        ) ? text(candidate.action.parameters.role).toUpperCase() : "",
        economic_direction: ["STORNO", "REPOST"].includes(
          text(candidate?.action?.parameters?.direction ?? candidate?.action?.parameters?.operation).toUpperCase(),
        ) ? text(candidate?.action?.parameters?.direction ?? candidate?.action?.parameters?.operation).toUpperCase() : "",
        approval_state: "ПРЕДЛОЖЕНО",
        period: first(options.period, application?.period),
        organization: topOrganization,
        source_range: narrative.sourceRows || first(application?.source_row),
        source_date: first(primary?.date),
        registrar: narrative.registrars || first(application?.registrar),
        posting_number: narrative.postingNumbers || first(application?.posting_number),
        source_dt: sourceDebit,
        source_kt: sourceCredit,
        source_analytics_dt1: analyticsSlot(primary?.debit_analytics, 0) || sourceArticle,
        source_analytics_dt2: analyticsSlot(primary?.debit_analytics, 1),
        source_analytics_dt3: analyticsSlot(primary?.debit_analytics, 2),
        source_analytics_kt1: analyticsSlot(primary?.credit_analytics, 0),
        source_analytics_kt2: analyticsSlot(primary?.credit_analytics, 1),
        source_analytics_kt3: analyticsSlot(primary?.credit_analytics, 2),
        source_department_dt: first(primary?.debit_department),
        source_department_kt: first(primary?.credit_department),
        source_organization: first(primary?.source_organization, primary?.organization),
        source_archive_path: first(primary?.source_archive_path),
        source_archive_sha256: first(primary?.source_archive_sha256),
        journal_entry: first(primary?.journal_entry),
        journal_sha256: first(primary?.journal_sha256),
        source_sheet: first(primary?.source_sheet),
        source_row_id: first(primary?.source_row_id, primary?.source_financial_record_id),
        source_amount: finiteNumber(primary?.amount),
        correction_amount: Math.abs(Number(application?.amount ?? candidate?.action?.parameters?.delta ?? 0)),
        analytical_basis_id: analyticalBasisId,
        analytical_effect: analyticalEffect,
        erp_current: erpCurrent,
        intalev_target: intalevTarget,
        basis_contract_blockers: basisContractBlockers,
        target_dt: targetDebit,
        target_kt: targetCredit,
        target_analytics_dt1: targetArticle || sourceArticle,
        target_analytics_dt2: analyticsSlot(candidate?.accounting?.debit_analytics, 1),
        target_analytics_dt3: analyticsSlot(candidate?.accounting?.debit_analytics, 2),
        target_analytics_kt1: analyticsSlot(candidate?.accounting?.credit_analytics ?? primary?.credit_analytics, 0),
        target_analytics_kt2: analyticsSlot(candidate?.accounting?.credit_analytics ?? primary?.credit_analytics, 1),
        target_analytics_kt3: analyticsSlot(candidate?.accounting?.credit_analytics ?? primary?.credit_analytics, 2),
        target_department_dt: first(candidate?.accounting?.debit_department, primary?.debit_department),
        target_department_kt: first(candidate?.accounting?.credit_department, primary?.credit_department),
        reason: [businessReason, narrative.reason].filter(Boolean).join(" "),
        proof_reason: [businessReason, narrative.reason].filter(Boolean).join(" "),
        source_evidence_summary: narrative.sourceEvidence,
        intalev_reference: sourceArticle || "Иерархия Инталев не передана",
        solution: exactTargetSelection
          ? "Сохранить исходную проводку как доказательство; применить только отдельно выбранную замену счетов/аналитики после ручного подтверждения."
          : "Сохранить исходные счета ERP без замены; менять только доказанную сверкой статью/аналитику после ручного подтверждения.",
        evidence_state: first(application?.proof_status, candidate?.evidence?.proof_status, "UNPROVEN"),
        proof_status: first(application?.proof_status, candidate?.evidence?.proof_status, "UNPROVEN"),
        correction_allowed: false,
        correction_authority: "",
        output_route: decisionType === "ADD_ONE_SIDE" ? "REVIEW_ONLY" : "SPORNO",
        blockers: basisContractBlockers,
        rules_application_review: true,
        execution_allowed: false,
        ready_to_upload: false,
        release_allowed: false,
      };

      const generic = acceptedGenericMemberLegs(application, candidate);
      if (!generic) return [decision];
      const genericSourceArticle = memberArticle(generic.sources[0]);
      const economicSourceCodes = generic.sources.map((leg) => leg.code).join("+");
      const economicTargetCodes = generic.targets.map((leg) => leg.code).join("+");
      const physicalBlockers = [
        ...(Array.isArray(candidate?.missing_fields) ? candidate.missing_fields.map(text).filter(Boolean) : []),
        "PHYSICAL_SOURCE_INCOMPLETE_FOR_READY",
      ];
      return generic.legs.map((leg) => {
        const targetArticle = leg.role === "RECLASS_TARGET" ? memberArticle(leg) : genericSourceArticle;
        return {
          ...decision,
          case_id: generic.routeId,
          pair_id: first(application?.candidate_id, generic.routeId),
          decision_type: "STORNO_REPOST",
          role: leg.role,
          economic_direction: leg.economic_direction,
          reconciliation_row: leg.code,
          correction_amount: Math.abs(leg.accepted_intergroup_effect),
          analytical_basis_id: leg.code,
          analytical_effect: leg.accepted_intergroup_effect,
          accepted_intergroup_effect: leg.accepted_intergroup_effect,
          raw_delta: finiteNumber(leg?.raw_delta),
          effective_delta: finiteNumber(leg?.effective_delta),
          root_effective_delta: finiteNumber(leg?.root_effective_delta),
          residual_atom_id: text(leg?.residual_atom_id),
          transformation_id: text(leg?.transformation_id),
          source_article: genericSourceArticle,
          target_article: targetArticle,
          source_analytics_dt1: genericSourceArticle,
          target_analytics_dt1: targetArticle,
          source_amount: null,
          economic_source_code: economicSourceCodes,
          economic_target_code: economicTargetCodes,
          accepted_intergroup_reclass: true,
          intergroup_reclass_id: generic.routeId,
          intergroup_reclass_proof_status: "ECONOMIC_RECLASS_PROVEN",
          accepted_amount: generic.acceptedAmount,
          processing_stage: text(leg?.processing_stage),
          stage_order: finiteNumber(leg?.stage_order),
          proof_status: "UNPROVEN",
          original_proof_status: "UNPROVEN",
          correction_allowed: false,
          correction_authority: "",
          output_route: "SPORNO",
          blockers: [...new Set([...(decision.blockers ?? []), ...physicalBlockers])],
          basis_contract_blockers: [],
          rules_application_review: true,
          execution_allowed: false,
          ready_to_upload: false,
          release_allowed: false,
        };
      });
    });
}
