import { sourceBusinessLabelKey } from "./source_driven_expense_presentation.mjs";

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function money(value) {
  const valueCents = cents(value);
  return valueCents === null ? null : valueCents / 100;
}

function rowLabelKeys(row) {
  return new Set([
    row?.intalev_label,
    row?.erp_label,
    ...(Array.isArray(row?.hierarchy_path) ? row.hierarchy_path.slice(-1) : []),
  ].map(sourceBusinessLabelKey).filter(Boolean));
}

function rowPathKeys(row, system) {
  const trace = Array.isArray(row?.[system]?.trace) ? row[system].trace : [];
  const values = [
    ...(Array.isArray(row?.hierarchy_path) ? row.hierarchy_path : []),
    ...trace.flatMap((item) => [item?.full_path, item?.catalog_path]
      .flatMap((value) => text(value).split(/\s*\/\s*/u))),
  ];
  return new Set(values.map(sourceBusinessLabelKey).filter(Boolean));
}

function findUniqueRow(rows, { article, block, system, excludeErpOnly = false }) {
  const articleKey = sourceBusinessLabelKey(article);
  const blockKey = sourceBusinessLabelKey(block);
  if (!articleKey || !blockKey) return { row: null, reason: "ARTICLE_OR_BLOCK_MISSING" };
  const candidates = rows.filter((row) => {
    if (excludeErpOnly && row?.erp_only_article_row === true) return false;
    if (!rowLabelKeys(row).has(articleKey)) return false;
    return rowPathKeys(row, system).has(blockKey);
  });
  if (candidates.length !== 1) {
    return {
      row: null,
      reason: candidates.length === 0 ? "ROW_NOT_FOUND" : "ROW_AMBIGUOUS",
      candidates: candidates.map((row) => text(row?.code)),
    };
  }
  return { row: candidates[0], reason: "UNIQUE" };
}

function cloneRow(row) {
  return {
    ...row,
    intalev: row?.intalev ? { ...row.intalev, trace: [...(row.intalev.trace ?? [])] } : row?.intalev,
    erp: row?.erp ? { ...row.erp, trace: [...(row.erp.trace ?? [])] } : row?.erp,
  };
}

function hasAmount(value) {
  return value !== null && value !== undefined && text(value) !== "" &&
    Number.isFinite(Number(value));
}

function placeJournalBoundRowsUnderParents(rows) {
  const boundRows = rows.filter((row) => row?.journal_structure_binding?.status === "PROVEN");
  if (boundRows.length === 0) return [...rows];
  const boundSet = new Set(boundRows);
  const grouped = new Map();
  for (const row of boundRows) {
    const parentCode = text(row?.presentation_parent_code);
    if (!parentCode) continue;
    if (!grouped.has(parentCode)) grouped.set(parentCode, []);
    grouped.get(parentCode).push(row);
  }
  const ordered = rows.filter((row) => !boundSet.has(row));
  const parentCodes = [...grouped.keys()].sort((left, right) =>
    ordered.findIndex((row) => text(row?.code) === left) -
      ordered.findIndex((row) => text(row?.code) === right));
  for (const parentCode of parentCodes) {
    const parentIndex = ordered.findIndex((row) => text(row?.code) === parentCode);
    if (parentIndex < 0) continue;
    const parentLevel = Number(ordered[parentIndex]?.presentation_outline_level ?? 0);
    let insertIndex = parentIndex + 1;
    while (
      insertIndex < ordered.length &&
      Number(ordered[insertIndex]?.presentation_outline_level ?? 0) > parentLevel
    ) {
      insertIndex += 1;
    }
    ordered.splice(insertIndex, 0, ...grouped.get(parentCode));
  }
  return ordered;
}

function applyJournalParentRollups(rows) {
  const byParent = new Map();
  for (const row of rows) {
    if (row?.journal_structure_binding?.status !== "PROVEN") continue;
    const parentCode = text(row?.presentation_parent_code);
    if (!parentCode || !hasAmount(row?.erp?.amount)) continue;
    if (!byParent.has(parentCode)) byParent.set(parentCode, []);
    byParent.get(parentCode).push(row);
  }
  const applied = [];
  for (const [parentCode, children] of byParent.entries()) {
    const parent = rows.find((row) => text(row?.code) === parentCode);
    if (!parent || hasAmount(parent?.erp?.amount)) continue;
    const amount = money(children.reduce((sum, child) => sum + Number(child.erp.amount), 0));
    if (!hasAmount(amount)) continue;
    parent.erp = parent.erp ?? { amount: null, status: "MISSING", trace: [] };
    parent.erp.raw_amount = parent.erp.raw_amount ?? null;
    parent.erp.amount = amount;
    parent.erp.normalized_amount = amount;
    parent.erp.status = "JOURNAL_STRUCTURE_CHILDREN_SUM";
    parent.erp.note = [
      text(parent.erp.note),
      `ERP восстановлена как сумма журнально привязанных статей: ${children.map((child) =>
        `${text(child.erp_label || child.intalev_label)} ${money(child.erp.amount)}`).join("; ")}.`,
    ].filter(Boolean).join(" ");
    parent.erp.presentation_group_rollups = [
      ...(Array.isArray(parent.erp.presentation_group_rollups)
        ? parent.erp.presentation_group_rollups
        : []),
      {
        basis: "JOURNAL_STRUCTURE_CHILDREN_SUM",
        amount,
        child_codes: children.map((child) => text(child.code)),
      },
    ];
    parent.journal_structure_rollup = {
      status: "PROVEN",
      amount,
      child_codes: children.map((child) => text(child.code)),
      child_articles: children.map((child) => text(child.erp_label || child.intalev_label)),
      correction_authority: false,
    };
    applied.push({
      parent_code: parentCode,
      amount,
      child_codes: parent.journal_structure_rollup.child_codes,
    });
  }
  return applied;
}

function provenMovementRows(evidence) {
  return (Array.isArray(evidence?.rows) ? evidence.rows : []).filter((row) =>
    ["UNIQUE_PAIR", "PAYROLL_COMPOSITE_PAIR", "PAYROLL_COMPONENT_PAIR"].includes(text(row?.row_type)) &&
    text(row?.classification).includes("МЕЖГРУППОВОЙ ПЕРЕСОРТ") &&
    sourceBusinessLabelKey(row?.source_block_erp) !==
      sourceBusinessLabelKey(row?.target_block_intalev) &&
    text(row?.target_status) === "PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK" &&
    Number(row?.confidence ?? 0) >= 90 &&
    row?.reused !== true);
}

function provenStructureRows(evidence) {
  return (Array.isArray(evidence?.rows) ? evidence.rows : []).filter((row) =>
    text(row?.row_type) === "UNIQUE_PAIR" &&
    text(row?.intalev_report_placement_status).startsWith("PROVEN_LIVE_REPORT_") &&
    text(row?.intalev_report_group) &&
    text(row?.article_erp) &&
    sourceBusinessLabelKey(row?.source_block_erp) ===
      sourceBusinessLabelKey(row?.intalev_report_block) &&
    Number(row?.confidence ?? 0) >= 90 &&
    row?.reused !== true);
}

function applyJournalStructureBindings(rows, evidence) {
  const grouped = new Map();
  for (const proof of provenStructureRows(evidence)) {
    const key = [
      sourceBusinessLabelKey(proof?.source_block_erp),
      sourceBusinessLabelKey(proof?.article_erp),
    ].join("|");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(proof);
  }
  const applied = [];
  const unresolved = [];
  for (const proofs of grouped.values()) {
    const groupKeys = [...new Set(proofs.map((proof) =>
      sourceBusinessLabelKey(proof?.intalev_report_group)).filter(Boolean))];
    if (groupKeys.length !== 1) {
      unresolved.push({
        article_erp: text(proofs[0]?.article_erp),
        source_block_erp: text(proofs[0]?.source_block_erp),
        reason: "ERP_ARTICLE_MAPS_TO_MULTIPLE_INTALEV_GROUPS",
        target_groups: [...new Set(proofs.map((proof) => text(proof?.intalev_report_group)))],
      });
      continue;
    }
    const sourceMatch = findUniqueRow(rows, {
      article: proofs[0]?.article_erp,
      block: proofs[0]?.source_block_erp,
      system: "erp",
    });
    const targetMatch = findUniqueRow(rows, {
      article: proofs[0]?.intalev_report_group,
      block: proofs[0]?.intalev_report_block,
      system: "intalev",
      excludeErpOnly: true,
    });
    if (!sourceMatch.row || !targetMatch.row || sourceMatch.row === targetMatch.row) {
      unresolved.push({
        article_erp: text(proofs[0]?.article_erp),
        source_block_erp: text(proofs[0]?.source_block_erp),
        target_group_intalev: text(proofs[0]?.intalev_report_group),
        reason: !sourceMatch.row
          ? `SOURCE_${sourceMatch.reason}`
          : !targetMatch.row
            ? `TARGET_${targetMatch.reason}`
            : "SOURCE_ALREADY_EQUALS_TARGET",
        source_candidates: sourceMatch.candidates ?? [],
        target_candidates: targetMatch.candidates ?? [],
      });
      continue;
    }
    const source = sourceMatch.row;
    const target = targetMatch.row;
    const targetDepth = Number(target?.presentation_outline_level ?? target?.presentation_depth ?? 0);
    const sourceLabel = text(source?.erp_label || source?.intalev_label);
    source.presentation_parent_code = text(target?.code);
    source.presentation_parent_basis = "JOURNAL_OPERATION_TO_LIVE_INTALEV_GROUP";
    source.presentation_depth = Math.min(7, targetDepth + 1);
    source.presentation_source_outline_level = source.presentation_depth;
    source.presentation_outline_level = source.presentation_depth;
    source.presentation_hierarchy_status = "HIERARCHY_PROVEN";
    source.presentation_structural_proof = {
      status: "PROVEN_JOURNAL_OPERATION_TO_LIVE_INTALEV_GROUP",
      system: "INTALEV+ERP_JOURNALS",
      basis: "MUTUALLY_UNIQUE_OPERATION_AND_LIVE_INTALEV_REPORT_PATH",
      parent_code: text(target?.code),
      outline_level: source.presentation_depth,
      path: [
        ...(Array.isArray(target?.hierarchy_path) ? target.hierarchy_path : []),
        sourceLabel,
      ],
      source_report_paths: [...new Set(proofs.map((proof) => text(proof?.intalev_report_path)))],
      intalev_source_row_ids: proofs.map((proof) => text(proof?.intalev_source_row_id)),
      erp_source_row_ids: proofs.map((proof) => text(proof?.erp_source_row_id)),
      erp_used: true,
      correction_authority: false,
    };
    source.hierarchy_path = source.presentation_structural_proof.path;
    source.type = "СТАТЬЯ ERP / ДЕТАЛЬ ПОД ГРУППОЙ ИНТАЛЕВ ПО ЖУРНАЛУ";
    source.erp_binding_status = "PROVEN";
    source.journal_structure_binding = {
      status: "PROVEN",
      parent_code: text(target?.code),
      parent_article: text(target?.intalev_label),
      article_erp: sourceLabel,
      operation_count: proofs.length,
      amount_proven: money(proofs.reduce((sum, proof) =>
        sum + Math.abs(Number(proof?.source_amount ?? proof?.amount ?? 0)), 0)),
      correction_authority: false,
    };
    applied.push({
      code: text(source?.code),
      article_erp: sourceLabel,
      parent_code: text(target?.code),
      parent_article: text(target?.intalev_label),
      operation_count: proofs.length,
      amount_proven: source.journal_structure_binding.amount_proven,
      source_report_paths: source.presentation_structural_proof.source_report_paths,
    });
  }
  return { applied, unresolved };
}

export function applyJournalFirstPresentationAttribution(rows = [], evidence = null) {
  const output = rows.map(cloneRow);
  const byCode = new Map(output.map((row) => [text(row?.code), row]));
  const structure = applyJournalStructureBindings(output, evidence);
  const accepted = [];
  const unresolved = [...structure.unresolved];
  const usedErpSourceIds = new Set();
  const movements = provenMovementRows(evidence);

  for (const movement of movements) {
    const sourceId = text(movement?.erp_source_row_id);
    if (!sourceId || usedErpSourceIds.has(sourceId)) {
      unresolved.push({
        erp_source_row_id: sourceId,
        reason: sourceId ? "ERP_SOURCE_ROW_REUSED" : "ERP_SOURCE_ROW_ID_MISSING",
      });
      continue;
    }
    const sourceMatch = findUniqueRow(output, {
      article: movement?.article_erp,
      block: movement?.source_block_erp,
      system: "erp",
    });
    const targetMatch = findUniqueRow(output, {
      article: movement?.target_article_erp,
      block: movement?.target_block_intalev,
      system: "intalev",
      excludeErpOnly: true,
    });
    const moveCents = cents(Math.abs(Number(movement?.source_amount ?? movement?.amount)));
    if (!sourceMatch.row || !targetMatch.row || !moveCents) {
      unresolved.push({
        erp_source_row_id: sourceId,
        source_article: text(movement?.article_erp),
        target_article: text(movement?.target_article_erp),
        amount: moveCents === null ? null : moveCents / 100,
        reason: !sourceMatch.row
          ? `SOURCE_${sourceMatch.reason}`
          : !targetMatch.row
            ? `TARGET_${targetMatch.reason}`
            : "AMOUNT_MISSING",
        source_candidates: sourceMatch.candidates ?? [],
        target_candidates: targetMatch.candidates ?? [],
      });
      continue;
    }
    accepted.push({
      ...movement,
      source_code: text(sourceMatch.row.code),
      target_code: text(targetMatch.row.code),
      movement_cents: moveCents,
    });
    usedErpSourceIds.add(sourceId);
  }

  const grouped = new Map();
  for (const movement of accepted) {
    if (movement.source_code === movement.target_code) continue;
    const key = `${movement.source_code}|${movement.target_code}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(movement);
  }

  const applied = [];
  for (const movementsForPair of grouped.values()) {
    const source = byCode.get(movementsForPair[0].source_code);
    const target = byCode.get(movementsForPair[0].target_code);
    const requestedCents = movementsForPair.reduce((sum, item) => sum + item.movement_cents, 0);
    const sourceCents = cents(source?.erp?.amount);
    const targetCents = cents(target?.erp?.amount) ?? 0;
    if (sourceCents === null || sourceCents < 0 || requestedCents > sourceCents) {
      unresolved.push({
        source_code: text(source?.code),
        target_code: text(target?.code),
        requested_amount: requestedCents / 100,
        available_amount: sourceCents === null ? null : sourceCents / 100,
        reason: sourceCents === null
          ? "SOURCE_REPORT_AMOUNT_MISSING"
          : sourceCents < 0
            ? "NEGATIVE_SOURCE_REQUIRES_REVIEW"
            : "JOURNAL_AMOUNT_EXCEEDS_REPORT_ARTICLE",
      });
      continue;
    }

    const sourceBefore = sourceCents;
    const targetBefore = targetCents;
    source.erp.raw_amount = money(source.erp.raw_amount ?? source.erp.amount);
    source.erp.amount = (sourceCents - requestedCents) / 100;
    source.erp.normalized_amount = source.erp.amount;
    source.erp.status = "JOURNAL_FIRST_NORMALIZED";
    source.erp.note = [
      text(source.erp.note),
      `По уникальным парам журнала ${requestedCents / 100} перенесено на статью «${text(target.intalev_label)}»; остаток ${source.erp.amount}.`,
    ].filter(Boolean).join(" ");
    target.erp = target.erp ?? { amount: null, status: "MISSING", trace: [] };
    target.erp.raw_amount = money(target.erp.raw_amount ?? target.erp.amount);
    target.erp.amount = (targetCents + requestedCents) / 100;
    target.erp.normalized_amount = target.erp.amount;
    target.erp.status = "JOURNAL_FIRST_NORMALIZED";
    target.erp.note = [
      text(target.erp.note),
      `Добавлено ${requestedCents / 100} по ${movementsForPair.length} взаимно-уникальным операциям журналов Инталев ↔ ERP.`,
    ].filter(Boolean).join(" ");
    const proofRows = movementsForPair.map((item) => ({
      period: text(item.period),
      source_system: "ERP_JOURNAL",
      source_file: text(evidence?.sources?.erp?.path),
      sheet: text(evidence?.sources?.erp?.sheet),
      row: Number(String(item.erp_rows ?? "").split(",")[0]) || null,
      full_path: text(item.erp_path),
      amount: item.movement_cents / 100,
      intalev_row: text(item.intalev_rows),
      intalev_path: text(item.intalev_path),
      content: text(item.content),
      reason: text(item.reason),
      erp_source_row_id: text(item.erp_source_row_id),
    }));
    source.erp.trace.push(...proofRows);
    target.erp.trace.push(...proofRows);
    source.journal_first_attribution = {
      role: "SOURCE_REMAINDER",
      actual_amount: sourceBefore / 100,
      moved_amount: requestedCents / 100,
      normalized_amount: source.erp.amount,
      operation_count: movementsForPair.length,
      target_code: text(target.code),
      target_article: text(target.intalev_label),
    };
    target.journal_first_attribution = {
      role: "TARGET_RECOVERED",
      actual_amount: targetBefore / 100,
      recovered_amount: requestedCents / 100,
      normalized_amount: target.erp.amount,
      operation_count: movementsForPair.length,
      source_code: text(source.code),
      source_article: text(source.erp_label),
    };
    applied.push({
      source_code: text(source.code),
      source_article: text(source.erp_label),
      target_code: text(target.code),
      target_article: text(target.intalev_label),
      amount: requestedCents / 100,
      operation_count: movementsForPair.length,
      source_before: sourceBefore / 100,
      source_after: source.erp.amount,
      target_before: targetBefore / 100,
      target_after: target.erp.amount,
      erp_source_row_ids: movementsForPair.map((item) => text(item.erp_source_row_id)),
    });
  }

  const conserved = applied.every((item) =>
    cents(item.source_before + item.target_before) ===
      cents(item.source_after + item.target_after));
  const parentRollups = applyJournalParentRollups(output);
  const orderedRows = placeJournalBoundRowsUnderParents(output);
  return {
    rows: orderedRows,
    audit: {
      schema: "opiu-journal-first-presentation-attribution.v1",
      status: conserved ? "READY_REPORT_ONLY" : "BLOCKED_TOTAL_NOT_CONSERVED",
      candidate_movements: movements.length,
      structure_binding_candidates: provenStructureRows(evidence).length,
      structure_bindings_applied: structure.applied.length,
      journal_parent_rollups_applied: parentRollups.length,
      applied_operation_rows: applied.reduce((sum, item) => sum + item.operation_count, 0),
      applied_pairs: applied.length,
      applied_amount: money(applied.reduce((sum, item) => sum + item.amount, 0)),
      unresolved_rows: unresolved.length,
      total_conserved: conserved,
      correction_authority: false,
      posting_rows: 0,
    },
    structure_bindings: structure.applied,
    parent_rollups: parentRollups,
    applied,
    unresolved,
  };
}
