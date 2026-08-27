import { adaptR005 as adaptBaseR005 } from "./r005_adapter.mjs";

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).toLocaleLowerCase("ru-RU");
}

function code(value) {
  const raw = text(value).toUpperCase();
  const match = raw.match(/R\s*0*(\d{1,3})/);
  return match ? `R${String(Number(match[1])).padStart(3, "0")}` : raw;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function firstArrayValue(value) {
  return Array.isArray(value) ? firstText(...value) : firstText(value);
}

function rowDisclosureGroup(row = {}) {
  return firstText(
    row.disclosure_group_path,
    row.disclosure_group,
    row.group_disclosure,
    row.opiu_group_path,
    row.opiu_group,
    row["Группа раскрытия"],
    row["ГруппаРаскрытия"],
  );
}

function rowWpGroup(row = {}) {
  return firstText(
    row.wp_group_path,
    row.wp_group,
    row.group_wp,
    row.wp,
    row.wp_path,
    row["Группа WP"],
    row["ГруппаWP"],
    row["WP группа"],
  );
}

export function hierarchyIdentityPath(basePath, row = {}) {
  const disclosure = rowDisclosureGroup(row);
  const wp = rowWpGroup(row);
  const segments = [];
  const base = text(basePath);
  if (base) segments.push(base);
  if (disclosure) segments.push(`DISCLOSURE::${disclosure}`);
  if (wp) segments.push(`WP::${wp}`);
  return [...new Set(segments)].join(" / ");
}

function financialRows(payload) {
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function rowIndex(payload) {
  const map = new Map();
  for (const row of financialRows(payload)) {
    const keys = [row?.code, row?.row_code, ...(Array.isArray(row?.article_codes) ? row.article_codes : [])]
      .map(code)
      .filter(Boolean);
    for (const key of keys) if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function candidateRootCode(candidate) {
  return code(
    candidate?.action?.parameters?.row_code
      || candidate?.action?.parameters?.source_code
      || candidate?.intalev?.article_code,
  );
}

function candidateRows(candidate, rows) {
  const sourceCode = code(candidate?.action?.parameters?.source_code || candidate?.intalev?.article_code);
  const targetCode = code(candidate?.action?.parameters?.target_code || candidate?.erp?.article_code || candidate?.action?.parameters?.row_code);
  return {
    source: rows.get(sourceCode) || {},
    target: rows.get(targetCode) || rows.get(sourceCode) || {},
  };
}

function evidenceRows(candidate) {
  return Array.isArray(candidate?.evidence?.evidence_rows) ? candidate.evidence.evidence_rows : [];
}

function primaryEvidence(candidate) {
  const rows = evidenceRows(candidate);
  return rows.find((row) => row?.proven === true && !/^99(?:\.|$)/.test(text(row?.debit_account)))
    || rows.find((row) => row?.proven === true)
    || rows.find((row) => !/^99(?:\.|$)/.test(text(row?.debit_account)))
    || rows[0]
    || {};
}

function safeEvidenceRow(row = {}) {
  return {
    parent_code: code(row?.parent_code || row?.code || row?.row_code),
    date: firstText(row?.date, row?.period),
    source_row: firstText(row?.source_row, row?.source_range, row?.source_row_id, row?.physical_row),
    registrar: firstText(row?.registrar, row?.document),
    posting_number: firstText(row?.posting_number, row?.posting_no),
    debit_account: firstText(row?.debit_account, row?.debit),
    credit_account: firstText(row?.credit_account, row?.credit),
    debit_analytics: Array.isArray(row?.debit_analytics) ? row.debit_analytics.map(text).filter(Boolean) : [],
    credit_analytics: Array.isArray(row?.credit_analytics) ? row.credit_analytics.map(text).filter(Boolean) : [],
    article: firstText(row?.article, row?.erp_article, row?.catalog_path),
    amount: numberOrNull(row?.amount ?? row?.sum),
    proof_status: firstText(row?.proof_status),
    row_class: firstText(row?.row_class),
  };
}

function operationRows(payload) {
  return Array.isArray(payload?.operation_evidence?.rows) ? payload.operation_evidence.rows : [];
}

function unassignedOperationRows(payload) {
  return Array.isArray(payload?.operation_evidence?.unassigned_rows) ? payload.operation_evidence.unassigned_rows : [];
}

function operationRowsForCode(payload, rowCode) {
  const target = code(rowCode);
  if (!target) return [];
  return operationRows(payload)
    .filter((row) => [row?.parent_code, row?.code, row?.row_code].map(code).includes(target))
    .slice(0, 50)
    .map(safeEvidenceRow);
}

function exactArticleReviewRows(payload, labels) {
  const targets = new Set(labels.map(normalized).filter(Boolean));
  if (!targets.size) return [];
  const matches = [];
  for (const row of unassignedOperationRows(payload)) {
    const values = [row?.article, row?.erp_article, row?.catalog_path, row?.article_path]
      .map(text)
      .filter(Boolean);
    const exact = values.some((value) => {
      const whole = normalized(value);
      if (targets.has(whole)) return true;
      return value.split("/").map(normalized).some((segment) => targets.has(segment));
    });
    if (exact) matches.push(safeEvidenceRow(row));
    if (matches.length >= 50) break;
  }
  return matches;
}

function hardenSide(side, row) {
  if (!side || typeof side !== "object") return side;
  return {
    ...side,
    opiu_block_path: hierarchyIdentityPath(side.opiu_block_path || side.opiu_block_name, row),
  };
}

function sourcePostingText(evidence) {
  const parts = [];
  const registrar = firstText(evidence?.registrar, evidence?.document);
  const posting = firstText(evidence?.posting_number, evidence?.posting_no);
  const sourceRow = firstText(evidence?.source_row, evidence?.source_range);
  const debit = firstText(evidence?.debit_account, evidence?.debit);
  const credit = firstText(evidence?.credit_account, evidence?.credit);
  const article = firstText(evidence?.article);
  if (registrar) parts.push(`документ ${registrar}`);
  if (posting) parts.push(`проводка ${posting}`);
  if (sourceRow) parts.push(`строка ${sourceRow}`);
  if (debit) parts.push(`Дт ${debit}`);
  if (credit) parts.push(`Кт ${credit}`);
  if (article) parts.push(`статья «${article}»`);
  return parts.length ? `Исходная проводка: ${parts.join(", ")}.` : "";
}

function sourcePreservationExplanation(candidate, originalErp, evidence) {
  const parts = [];
  const base = text(candidate?.evidence?.explanation);
  if (base) parts.push(base);
  const posting = sourcePostingText(evidence);
  if (posting) parts.push(posting);

  const sourceArticle = firstText(evidence?.article);
  const originalTargetArticle = firstText(originalErp?.article_path, originalErp?.article_name);
  const finalTargetArticle = firstText(candidate?.erp?.article_path, candidate?.erp?.article_name);
  if (sourceArticle && !originalTargetArticle) {
    parts.push(`В сверке ERP-статья не заполнена; сохраняем статью из исходной проводки: «${sourceArticle}».`);
  } else if (sourceArticle && originalTargetArticle && sourceArticle !== originalTargetArticle) {
    parts.push(`По сверке статья изменяется: «${sourceArticle}» → «${originalTargetArticle}».`);
  } else if (sourceArticle && finalTargetArticle) {
    parts.push(`Статья ERP сохраняется как в исходной проводке: «${sourceArticle}».`);
  }

  const debit = firstText(evidence?.debit_account, evidence?.debit, candidate?.accounting?.debit_account);
  const credit = firstText(evidence?.credit_account, evidence?.credit, candidate?.accounting?.credit_account);
  if (debit || credit) {
    const accounts = [debit ? `Дт ${debit}` : "", credit ? `Кт ${credit}` : ""].filter(Boolean).join(" / ");
    parts.push(`Счета ${accounts} берём из исходной проводки и не заменяем без отдельного доказанного правила.`);
  }
  return [...new Set(parts)].join(" ");
}

function directFinancialChildren(payload, parentCode) {
  const target = code(parentCode);
  if (!target) return [];
  return financialRows(payload).filter((row) => code(row?.hierarchy_parent_code) === target);
}

function financialGroupBreakdown(payload, parentCode) {
  const children = directFinancialChildren(payload, parentCode);
  if (!children.length) return null;
  return children.map((row) => {
    const delta = numberOrNull(row?.delta);
    return {
      code: code(row?.code),
      label: firstText(row?.intalev_label, row?.erp_label, row?.code),
      intalev_amount: numberOrNull(row?.intalev_amount),
      erp_amount: numberOrNull(row?.erp_amount),
      delta,
      is_discrepancy: Boolean(row?.is_discrepancy),
      reconciliation_status: firstText(row?.reconciliation_status),
      hierarchy_path: Array.isArray(row?.hierarchy_path) ? row.hierarchy_path.map(text).filter(Boolean) : [],
      source_postings: operationRowsForCode(payload, row?.code),
    };
  });
}

function selectedHierarchyPeriod(payload) {
  const periods = Array.isArray(payload?.hierarchy_periods) ? payload.hierarchy_periods : [];
  return periods.find((item) => text(item?.period) === text(payload?.period)) || periods[0] || null;
}

function pathParts(value) {
  return text(value).split("/").map(text).filter(Boolean);
}

function exactPathEqual(left, right) {
  const a = pathParts(left).map(normalized);
  const b = pathParts(right).map(normalized);
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function directPathChild(parentPath, childPath) {
  const parent = pathParts(parentPath).map(normalized);
  const child = pathParts(childPath).map(normalized);
  return child.length === parent.length + 1 && parent.every((part, index) => part === child[index]);
}

function sourceTreeGroup(tree, fullPath) {
  if (!tree || !Array.isArray(tree.nodes) || !text(fullPath)) return null;
  const node = tree.nodes.find((item) => exactPathEqual(item?.full_path, fullPath));
  if (!node) return null;
  const byId = new Map(tree.nodes.map((item) => [text(item?.node_id), item]));
  let children = Array.isArray(node?.immediate_children)
    ? node.immediate_children.map((id) => byId.get(text(id))).filter(Boolean)
    : [];
  let linkage = "PARENT_GRAPH";
  if (!children.length) {
    children = tree.nodes.filter((item) => item !== node && directPathChild(node.full_path, item?.full_path));
    if (children.length) linkage = "EXACT_PATH_FALLBACK_REVIEW_ONLY";
  }
  if (!children.length && !node?.is_group) return null;
  return {
    label: firstText(node?.label, node?.name),
    full_path: firstText(node?.full_path),
    direct_total: numberOrNull(node?.direct_total),
    immediate_child_sum: numberOrNull(node?.immediate_child_sum),
    hierarchy_delta: numberOrNull(node?.hierarchy_delta),
    hierarchy_status: firstText(node?.hierarchy_status, node?.validation_status),
    linkage,
    source: node?.source && typeof node.source === "object"
      ? { sheet: firstText(node.source.sheet), row: numberOrNull(node.source.row), source_cell: firstText(node.source.source_cell) }
      : null,
    children: children.slice(0, 50).map((child) => ({
      label: firstText(child?.label, child?.name),
      full_path: firstText(child?.full_path),
      direct_total: numberOrNull(child?.direct_total),
      hierarchy_delta: numberOrNull(child?.hierarchy_delta),
      hierarchy_status: firstText(child?.hierarchy_status, child?.validation_status),
      source: child?.source && typeof child.source === "object"
        ? { sheet: firstText(child.source.sheet), row: numberOrNull(child.source.row), source_cell: firstText(child.source.source_cell) }
        : null,
    })),
  };
}

function groupDeltaBreakdown(candidate, payload, resolved) {
  const rootCode = candidateRootCode(candidate);
  const rootRow = resolved.source && Object.keys(resolved.source).length ? resolved.source : resolved.target;
  const financialChildren = financialGroupBreakdown(payload, rootCode);
  const hierarchyPeriod = selectedHierarchyPeriod(payload);
  const intalevPath = firstArrayValue(rootRow?.intalev_paths) || firstText(candidate?.intalev?.article_path);
  const erpPath = firstArrayValue(rootRow?.erp_paths);
  const intalevSource = sourceTreeGroup(hierarchyPeriod?.intalev_tree, intalevPath);
  const erpSource = sourceTreeGroup(hierarchyPeriod?.erp_tree, erpPath);
  const attached = evidenceRows(candidate);
  const articleReviewRows = attached.length
    ? []
    : exactArticleReviewRows(payload, [
        candidate?.erp?.article_name,
        candidate?.intalev?.article_name,
        intalevSource?.label,
        erpSource?.label,
        ...(intalevSource?.children ?? []).map((item) => item.label),
      ]);
  if (!financialChildren && !intalevSource && !erpSource && !articleReviewRows.length) return null;
  const rootDelta = numberOrNull(rootRow?.delta ?? candidate?.action?.parameters?.delta);
  return {
    mode: "GROUP_DRILLDOWN_REVIEW_ONLY",
    group_code: rootCode,
    group_label: firstText(candidate?.intalev?.article_name, candidate?.erp?.article_name, rootCode),
    group_delta: rootDelta,
    note: "Дельта группировки не является проводкой. Саму группировку не корректировать; причину искать в дочерних строках и исходных ERP-проводках.",
    financial_children: financialChildren ?? [],
    intalev_source_group: intalevSource,
    erp_source_group: erpSource,
    exact_article_review_rows: articleReviewRows,
  };
}

function groupReviewOnly(breakdown, actionType) {
  if (!breakdown || text(actionType).toUpperCase() !== "ONE_SIDE") return false;
  const financialChildren = Array.isArray(breakdown.financial_children) ? breakdown.financial_children.length : 0;
  const intalevChildren = Array.isArray(breakdown?.intalev_source_group?.children) ? breakdown.intalev_source_group.children.length : 0;
  const erpChildren = Array.isArray(breakdown?.erp_source_group?.children) ? breakdown.erp_source_group.children.length : 0;
  return financialChildren + intalevChildren + erpChildren > 0;
}

function groupExplanation(breakdown) {
  if (!breakdown) return "";
  const parts = [breakdown.note];
  const children = Array.isArray(breakdown?.intalev_source_group?.children) ? breakdown.intalev_source_group.children : [];
  if (children.length) {
    parts.push(`Дочерние узлы Инталев: ${children.slice(0, 8).map((item) => {
      const amount = numberOrNull(item?.direct_total);
      return `${firstText(item?.label)}${amount === null ? "" : ` = ${amount}`}`;
    }).join("; ")}.`);
  }
  const financial = Array.isArray(breakdown.financial_children) ? breakdown.financial_children : [];
  const deltas = financial.filter((item) => numberOrNull(item?.delta) !== null && Math.abs(Number(item.delta)) > 0.000001);
  if (deltas.length) parts.push(`Дочерние дельты сверки: ${deltas.slice(0, 8).map((item) => `${firstText(item.code)} ${firstText(item.label)} = ${item.delta}`).join("; ")}.`);
  const postings = Array.isArray(breakdown.exact_article_review_rows) ? breakdown.exact_article_review_rows : [];
  if (postings.length) {
    parts.push(`Исходные ERP-проводки для проверки: ${postings.slice(0, 5).map((item) => [
      firstText(item.registrar) ? `документ ${firstText(item.registrar)}` : "",
      firstText(item.posting_number) ? `проводка ${firstText(item.posting_number)}` : "",
      firstText(item.debit_account) ? `Дт ${firstText(item.debit_account)}` : "",
      firstText(item.credit_account) ? `Кт ${firstText(item.credit_account)}` : "",
      firstText(item.article) ? `статья «${firstText(item.article)}»` : "",
    ].filter(Boolean).join(", ")).join(" | ")}.`);
  }
  return parts.filter(Boolean).join(" ");
}

function hardenCandidate(candidate, rows, payload) {
  const resolved = candidateRows(candidate, rows);
  const evidence = primaryEvidence(candidate);
  const originalErp = candidate?.erp && typeof candidate.erp === "object" ? { ...candidate.erp } : {};
  let erp = hardenSide(candidate.erp, resolved.target);
  const sourceArticle = firstText(evidence?.article);
  if (erp && typeof erp === "object" && sourceArticle) {
    if (!text(erp.article_name)) erp.article_name = sourceArticle;
    if (!text(erp.article_path)) erp.article_path = sourceArticle;
  }
  let next = {
    ...candidate,
    intalev: hardenSide(candidate.intalev, resolved.source),
    erp,
  };
  const breakdown = groupDeltaBreakdown(next, payload, resolved);
  const reviewOnly = groupReviewOnly(breakdown, next?.action?.action_type);
  if (reviewOnly) {
    next = {
      ...next,
      group_review_only: true,
      decision: "NO_RULE",
      impact_class: "CONTROL_ONLY",
      action: {
        ...(next.action ?? {}),
        action_type: "CONTROL_ONLY",
        condition_text: [
          firstText(next?.action?.condition_text),
          "Групповая дельта: корректировка разрешена только после разложения до конкретной дочерней статьи/исходной проводки.",
        ].filter(Boolean).join(" "),
      },
      required_user_actions: [
        "Разобрать групповую дельту до конкретной дочерней статьи и исходной ERP-проводки; саму группировку не корректировать",
      ],
    };
  }
  if (next.evidence && typeof next.evidence === "object") {
    const explanations = [
      sourcePreservationExplanation(next, originalErp, evidence),
      reviewOnly ? groupExplanation(breakdown) : "",
    ].filter(Boolean);
    next.evidence = {
      ...next.evidence,
      explanation: [...new Set(explanations)].join(" "),
      group_delta_breakdown: breakdown,
    };
  }
  return next;
}

export function adaptR005(payload, context) {
  const adapted = adaptBaseR005(payload, context);
  const rows = rowIndex(payload);
  const reviewed = (adapted.candidates ?? []).map((candidate) => hardenCandidate(candidate, rows, payload));
  const informationalControls = reviewed.filter((candidate) => (
    candidate.group_review_only === true
    || (candidate.decision === "NO_RULE" && candidate.impact_class === "CONTROL_ONLY")
  ));
  const informationalIds = new Set(informationalControls.map((candidate) => candidate.candidate_id));
  const candidates = reviewed.filter((candidate) => !informationalIds.has(candidate.candidate_id));
  return {
    ...adapted,
    candidates,
    informational_controls: informationalControls,
    applications: (adapted.applications ?? []).filter((application) => !informationalIds.has(application.candidate_id)),
    warnings: [
      ...(adapted.warnings ?? []),
      "Business disclosure/WP identity guard active; presentation hierarchy levels are not rule identity.",
      "ERP source-preservation guard active: proven source accounts/article are retained unless a separate explicit target rule exists.",
      "Group-delta drill-down active: report controls remain informational and never become rule decisions or R001 applications.",
    ],
  };
}
