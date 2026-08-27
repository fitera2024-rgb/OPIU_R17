import { readOperationJournalRows } from "./full_operation_evidence.mjs";

const MARKER = "OPIU_POSTED_CORRECTION_V1=true";

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function key(value) {
  return text(value)
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100
    : null;
}

function fields(content) {
  const result = {};
  for (const part of text(content).split(/\s+\|\s+/u)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return result;
}

function overlayError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}; details=${JSON.stringify(details)}`);
  error.code = code;
  error.details = details;
  return error;
}

export async function loadPostedCorrectionJournalOverlay({
  journalPath,
  period,
  sheet = "Лист_1",
} = {}) {
  const journal = await readOperationJournalRows({ journalPath, sheet });
  const selected = [];
  for (const row of journal.rows) {
    if (!text(row.content).includes(MARKER)) continue;
    const metadata = fields(row.content);
    const rowPeriod = text(metadata.Period || row.period);
    if (rowPeriod !== period) continue;
    const operation = text(metadata.Operation).toUpperCase();
    const amount = money(row.amount);
    if (!new Set(["STORNO", "REPOST"]).has(operation)) {
      throw overlayError("POSTED_OVERLAY_OPERATION_INVALID", "Operation must be STORNO or REPOST", {
        physical_row: row.physical_row,
        operation,
      });
    }
    if (row.activity !== "Да" || row.scenario !== "Факт") {
      throw overlayError("POSTED_OVERLAY_ROW_INACTIVE", "Overlay row must be active Fact", {
        physical_row: row.physical_row,
        activity: row.activity,
        scenario: row.scenario,
      });
    }
    if (amount === null || (operation === "STORNO" && amount >= 0) || (operation === "REPOST" && amount <= 0)) {
      throw overlayError("POSTED_OVERLAY_SIGN_INVALID", "STORNO must be negative and REPOST positive", {
        physical_row: row.physical_row,
        operation,
        amount,
      });
    }
    const effectiveBlock = text(metadata.EffectiveBlock);
    const effectiveArticle = text(metadata.EffectiveArticle || row.article);
    const effectivePath = text(metadata.EffectivePath || [effectiveBlock, effectiveArticle].filter(Boolean).join(" / "));
    const pairId = text(metadata.PairID);
    if (!effectiveBlock || !effectiveArticle || !effectivePath || !pairId) {
      throw overlayError("POSTED_OVERLAY_IDENTITY_MISSING", "Block, article, path and PairID are required", {
        physical_row: row.physical_row,
      });
    }
    selected.push({
      ...row,
      operation,
      amount,
      pair_id: pairId,
      effective_block: effectiveBlock,
      effective_article: effectiveArticle,
      effective_path: effectivePath,
      effective_code: text(metadata.EffectiveCode),
      cfo: text(metadata.CFO || row.debit_department),
      source_row_id_original: text(metadata.SourceRowID),
      overlay_class: text(metadata.OverlayClass || "STORNO_REPOST"),
      force_synthetic: text(metadata.ForceSynthetic).toLocaleLowerCase("ru-RU") === "true",
      direct_summary_control:
        text(metadata.DirectSummaryControl).toLocaleLowerCase("ru-RU") === "true",
      journal_path: journal.source,
      journal_sha256: journal.journal_sha256,
      journal_sheet: journal.journal_sheet,
    });
  }

  const pairs = new Map();
  for (const row of selected) {
    if (!pairs.has(row.pair_id)) pairs.set(row.pair_id, []);
    pairs.get(row.pair_id).push(row);
  }
  for (const [pairId, rows] of pairs) {
    const oneSide = rows.every((row) => row.overlay_class === "ONE_SIDE_SPORNO");
    const balance = money(rows.reduce((sum, row) => sum + row.amount, 0));
    const roles = rows.map((row) => row.operation).sort().join("+");
    if (!oneSide && (rows.length !== 2 || roles !== "REPOST+STORNO" || Math.abs(balance) > 0.01)) {
      throw overlayError("POSTED_OVERLAY_PAIR_UNBALANCED", "Every ordinary pair must contain balanced STORNO and REPOST", {
        pair_id: pairId,
        row_count: rows.length,
        roles,
        balance,
      });
    }
    if (oneSide && rows.length !== 1) {
      throw overlayError("POSTED_OVERLAY_ONE_SIDE_INVALID", "ONE_SIDE_SPORNO must contain exactly one transparent test row", {
        pair_id: pairId,
        row_count: rows.length,
      });
    }
  }
  return {
    schema: "opiu-posted-correction-journal-overlay.v1",
    marker: MARKER,
    status: selected.length > 0 ? "APPLICABLE_TEST_JOURNAL" : "NOT_APPLICABLE_NO_MARKED_ROWS",
    applicable: selected.length > 0,
    period,
    journal_path: journal.source,
    journal_sha256: journal.journal_sha256,
    rows: selected,
    counts: {
      rows: selected.length,
      pairs: pairs.size,
      storno: selected.filter((row) => row.operation === "STORNO").length,
      repost: selected.filter((row) => row.operation === "REPOST").length,
    },
    report_only: true,
    live_1c_allowed: false,
  };
}

function catalogCodes(row) {
  return text(row?.catalog_codes).split(/\s*,\s*/u).filter(Boolean).map(key);
}

function rowMatches(row, overlayRow) {
  const rowLabel = key(row?.article || row?.summary_label);
  if (rowLabel !== key(overlayRow.effective_article)) return false;
  if (!key(row?.full_path).includes(key(overlayRow.effective_block))) return false;
  if (overlayRow.cfo && key(row?.cfo) && key(row?.cfo) !== key(overlayRow.cfo)) return false;
  return true;
}

function chooseCandidate(rows, overlayRow) {
  let candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => rowMatches(row, overlayRow));
  if (overlayRow.effective_path.includes("/")) {
    const exactPath = candidates.filter(
      ({ row }) => key(row?.full_path) === key(overlayRow.effective_path),
    );
    if (exactPath.length > 0) candidates = exactPath;
  }
  const directSummaryRequest = overlayRow.direct_summary_control === true || (
    !overlayRow.effective_path.includes("/") &&
    key(overlayRow.effective_block) === key(overlayRow.effective_article)
  );
  if (directSummaryRequest) {
    const summaryOnly = candidates.filter(
      ({ row }) => Boolean(text(row?.summary_label)) && !text(row?.article),
    );
    if (summaryOnly.length > 0) candidates = summaryOnly;
  }
  if (overlayRow.effective_code) {
    const byCode = candidates.filter(({ row }) => catalogCodes(row).includes(key(overlayRow.effective_code)));
    if (byCode.length > 0) candidates = byCode;
  }
  if (overlayRow.cfo) {
    const exactCfo = candidates.filter(({ row }) => key(row?.cfo) === key(overlayRow.cfo));
    if (exactCfo.length > 0) candidates = exactCfo;
  }
  return candidates;
}

function blockCandidate(rows, block) {
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      (key(row?.article) === key(block) || key(row?.summary_label) === key(block)) &&
      key(row?.full_path).includes(key(block)));
  const summary = candidates.filter(({ row }) => !text(row?.article));
  return (summary.length === 1 ? summary[0] : candidates.length === 1 ? candidates[0] : null);
}

function synthesizeRow(parsed, overlayRow) {
  const block = blockCandidate(parsed.rows, overlayRow.effective_block);
  if (!block) {
    throw overlayError("POSTED_OVERLAY_TARGET_BLOCK_NOT_UNIQUE", "Cannot synthesize target without one ERP block", {
      effective_block: overlayRow.effective_block,
      effective_article: overlayRow.effective_article,
    });
  }
  const donor = parsed.rows.find((row) =>
    text(row?.article) && key(row?.full_path).includes(key(overlayRow.effective_block))) ?? block.row;
  const index = parsed.rows.length;
  const sourceIdentity = `${parsed.sha256}|${parsed.sheet}|POSTED_OVERLAY|${overlayRow.source_row_id}`;
  const pathParts = overlayRow.effective_path.split(/\s+\/\s+/u).filter(Boolean);
  const fullPath = [block.row.full_path, ...pathParts.filter((part) => key(part) !== key(overlayRow.effective_block))]
    .filter(Boolean).join(" / ");
  parsed.rows.push({
    ...donor,
    article: overlayRow.effective_article,
    summary_label: "",
    amount: 0,
    raw_amount: 0,
    normalized_amount: 0,
    level: Number(block.row.level ?? 0) + 1,
    source_level: Number(block.row.source_level ?? 0) + 1,
    parent_index: block.index,
    child_indexes: [],
    child_sum: null,
    hierarchy_delta: null,
    hierarchy_status: "LEAF",
    full_path: fullPath,
    normalized_path: key(fullPath),
    cfo: overlayRow.cfo,
    organizational_dimensions: overlayRow.cfo ? [overlayRow.cfo] : [],
    source_identity: sourceIdentity,
    source_identity_scope: `${parsed.sha256}|${parsed.sheet}|${parsed.period}|POSTED_OVERLAY`,
    source_file: parsed.source_file,
    sheet: parsed.sheet,
    row: Number(overlayRow.physical_row),
    physical_row: Number(overlayRow.physical_row),
    source_cell: `Z${Number(overlayRow.physical_row)}`,
    catalog_status: overlayRow.effective_code ? "MATCHED_POSTED_OVERLAY" : "MATCHED_LABEL_PATH_POSTED_OVERLAY",
    catalog_codes: overlayRow.effective_code,
    catalog_path: overlayRow.effective_path,
    catalog_accounts: "",
    catalog_source_rows: "POSTED_JOURNAL",
    posted_correction_overlay_synthetic: true,
    posted_correction_journal_source: {
      path: overlayRow.journal_path,
      sha256: overlayRow.journal_sha256,
      sheet: overlayRow.journal_sheet,
      physical_row: Number(overlayRow.physical_row),
      source_cell: `Z${Number(overlayRow.physical_row)}`,
    },
  });
  return { row: parsed.rows[index], index };
}

function pathParentCandidates(rows, overlayRow) {
  const parts = overlayRow.effective_path.split(/\s+\/\s+/u).filter(Boolean);
  return parts.slice(0, -1).flatMap((part, partIndex) => {
    const prefix = parts.slice(0, partIndex + 1).map(key);
    const candidates = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const label = key(row?.article || row?.summary_label);
        const fullPath = key(row?.full_path);
        return label === key(part) && prefix.every((piece) => fullPath.includes(piece));
      });
    const withoutCfo = candidates.filter(({ row }) => !key(row?.cfo));
    return withoutCfo.length === 1 ? withoutCfo : candidates.length === 1 ? candidates : [];
  });
}

export function applyPostedCorrectionOverlayToErpParsed({ parsed, overlay } = {}) {
  if (!parsed || !Array.isArray(parsed.rows)) throw overlayError("POSTED_OVERLAY_ERP_PARSED_REQUIRED", "parsed.rows is required");
  if (!overlay?.applicable) {
    parsed.posted_correction_journal_overlay = overlay ?? null;
    return { applied_rows: 0, synthesized_rows: 0, touched_source_rows: 0 };
  }
  let synthesizedRows = 0;
  let undisclosedSourceRows = 0;
  const touched = new Set();
  for (const overlayRow of overlay.rows) {
    let candidates = overlayRow.force_synthetic
      ? [synthesizeRow(parsed, overlayRow)]
      : chooseCandidate(parsed.rows, overlayRow);
    if (overlayRow.force_synthetic) synthesizedRows += 1;
    if (candidates.length === 0 && overlayRow.operation === "REPOST") {
      candidates = [synthesizeRow(parsed, overlayRow)];
      synthesizedRows += 1;
    }
    if (candidates.length === 0 && overlayRow.operation === "STORNO") {
      const block = blockCandidate(parsed.rows, overlayRow.effective_block);
      if (block) {
        candidates = [{ ...block, undisclosed_source_carrier: true }];
        undisclosedSourceRows += 1;
      }
    }
    if (candidates.length !== 1) {
      throw overlayError("POSTED_OVERLAY_ARTICLE_NOT_UNIQUE", "Expected one ERP article row for marked posting", {
        operation: overlayRow.operation,
        effective_block: overlayRow.effective_block,
        effective_article: overlayRow.effective_article,
        cfo: overlayRow.cfo,
        candidate_count: candidates.length,
      });
    }
    const selected = candidates[0];
    const indexes = new Set([selected.index]);
    const directSummaryControl = Boolean(selected.row.summary_label) && !text(selected.row.article);
    if (!directSummaryControl) {
      for (const candidate of pathParentCandidates(parsed.rows, overlayRow)) indexes.add(candidate.index);
      let parentIndex = selected.row.parent_index;
      while (Number.isInteger(parentIndex) && parentIndex >= 0 && !indexes.has(parentIndex)) {
        indexes.add(parentIndex);
        parentIndex = parsed.rows[parentIndex]?.parent_index;
      }
    }
    for (const index of indexes) {
      const row = parsed.rows[index];
      row.amount = money(Number(row.amount ?? 0) + overlayRow.amount);
      if (typeof row.raw_amount === "number") row.raw_amount = money(row.raw_amount + overlayRow.amount);
      if (typeof row.normalized_amount === "number") row.normalized_amount = money(row.normalized_amount + overlayRow.amount);
      row.posted_correction_overlay = [
        ...(Array.isArray(row.posted_correction_overlay) ? row.posted_correction_overlay : []),
        {
          pair_id: overlayRow.pair_id,
          operation: overlayRow.operation,
          amount: overlayRow.amount,
          journal_row: overlayRow.physical_row,
          source_row_id: overlayRow.source_row_id,
          undisclosed_source_carrier: selected.undisclosed_source_carrier === true,
          direct_summary_control: directSummaryControl,
        },
      ];
      touched.add(index);
    }
  }
  parsed.posted_correction_journal_overlay = {
    ...overlay,
    rows: overlay.rows.map((row) => ({
      pair_id: row.pair_id,
      operation: row.operation,
      amount: row.amount,
      effective_block: row.effective_block,
      effective_article: row.effective_article,
      effective_path: row.effective_path,
      effective_code: row.effective_code,
      cfo: row.cfo,
      force_synthetic: row.force_synthetic === true,
      direct_summary_control: row.direct_summary_control === true,
      physical_row: row.physical_row,
      source_row_id: row.source_row_id,
    })),
  };
  return {
    applied_rows: overlay.rows.length,
    synthesized_rows: synthesizedRows,
    undisclosed_source_rows: undisclosedSourceRows,
    touched_source_rows: touched.size,
  };
}

export const POSTED_CORRECTION_JOURNAL_MARKER = MARKER;
