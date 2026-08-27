function text(value) {
  return String(value ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function quoted(value) {
  const normalized = text(value);
  return normalized ? `«${normalized}»` : "";
}

function safeFileName(value) {
  const normalized = text(value);
  if (!normalized) return "";
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function safeHierarchyPath(value) {
  const normalized = text(value);
  if (!normalized) return "";
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(normalized)) return "";
  return normalized;
}

function money(value) {
  if (!text(value)) return "";
  const numeric = typeof value === "number"
    ? value
    : Number(text(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(numeric)) return "";
  const [integer, fraction] = Math.abs(numeric).toFixed(2).split(".");
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${fraction}`;
}

function structuredReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.proven === false || value.verified === false) return null;
  const reference = {
    code: text(value.code ?? value.article_code ?? value.row_code),
    file: safeFileName(value.source_file ?? value.file),
    sheet: text(value.sheet ?? value.source_sheet),
    cell: text(value.source_cell ?? value.cell),
    fullPath: safeHierarchyPath(value.full_path ?? value.hierarchy_path ?? value.path),
    document: text(value.document ?? value.registrar),
  };
  return Object.values(reference).some(Boolean) ? reference : null;
}

function structuredReferences(decision) {
  const containers = [
    decision?.intalev_references,
    decision?.intalev_sources,
    decision?.intalev_source_references,
    decision?.intalev_reference,
    decision?.intalev_source_reference,
  ];
  const references = [];
  for (const container of containers) {
    const values = Array.isArray(container) ? container : [container];
    for (const value of values) {
      const reference = structuredReference(value);
      if (reference) references.push(reference);
    }
  }
  return references;
}

function technicalReferences(value) {
  const source = text(value);
  if (!source) return [];
  const references = [];
  let current = null;
  const flush = () => {
    if (current && Object.values(current).some(Boolean)) references.push(current);
    current = null;
  };
  for (const segment of source.split(";").map(text).filter(Boolean)) {
    const location = segment.match(/^([^:]+):\s*([^!;]+)!([^!;]+)!([^!;]+)$/);
    if (location) {
      flush();
      current = {
        code: text(location[1]),
        file: safeFileName(location[2]),
        sheet: text(location[3]),
        cell: text(location[4]),
        fullPath: "",
        document: "",
      };
      continue;
    }
    const pathMatch = segment.match(/^путь\s+(.+)$/i);
    if (pathMatch && current) current.fullPath = safeHierarchyPath(pathMatch[1]);
  }
  flush();
  return references;
}

function distinctReferences(references) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function intalevDocumentUnavailable(decision, explicitValue) {
  if (explicitValue === true) return true;
  if (decision?.intalev_document_absent === true || decision?.intalev_registrar_absent === true) return true;
  const description = [decision?.intalev_reference, decision?.intalev_technical_reference]
    .filter((value) => typeof value === "string")
    .map(text)
    .join(" ");
  return /(?:регистратор|документ)\s+операций\s+Инталев.*(?:отсутств|не\s+(?:выгруж|представ))/i.test(description);
}

function formatIntalevReference(reference) {
  const parts = [];
  if (reference.file) parts.push(`файл ${quoted(reference.file)}`);
  if (reference.sheet) parts.push(`лист ${quoted(reference.sheet)}`);
  if (reference.cell) parts.push(`ячейка ${reference.cell}`);
  if (reference.fullPath) parts.push(`путь ${quoted(reference.fullPath)}`);
  if (reference.document) parts.push(`документ ${quoted(reference.document)}`);
  if (!parts.length) return "";
  return `${reference.code ? `${reference.code}: ` : ""}${parts.join(", ")}`;
}

function safeBusinessReason(value) {
  const normalized = text(value);
  if (!normalized) return "";
  if (/\b(?:CaseID|PairID|SourceRowID|UploadID|DraftID|AuditIdentity|Engine|JournalSHA|EffectSHA256|SHA-?256|REPORT_ONLY)\b/i.test(normalized)) return "";
  if (/\b(?:execution_allowed|ready_to_upload|release_allowed|live_1c_allowed|live_delete_allowed|posting_rows)\s*=/i.test(normalized)) return "";
  if (/(?:[A-Za-z]:[\\/]|\\\\)/.test(normalized)) return "";
  return normalized;
}

export function buildR001BusinessContent({
  operation,
  erp = {},
  economic = {},
  decision = {},
  reason,
  intalevDocumentNotPresented = false,
} = {}) {
  const segments = [`Операция ${text(operation).toUpperCase()}`];
  const erpParts = [];
  if (text(erp.document)) erpParts.push(`документ ${quoted(erp.document)}`);
  if (text(erp.date)) erpParts.push(`дата ${text(erp.date)}`);
  if (text(erp.postingNumber)) erpParts.push(`проводка № ${text(erp.postingNumber)}`);
  if (text(erp.debit)) erpParts.push(`Дт ${text(erp.debit)}`);
  if (text(erp.credit)) erpParts.push(`Кт ${text(erp.credit)}`);
  if (money(erp.amount)) erpParts.push(`сумма ${money(erp.amount)}`);
  if (text(erp.organization)) erpParts.push(`организация ${quoted(erp.organization)}`);
  const debitDepartment = text(erp.debitDepartment);
  const creditDepartment = text(erp.creditDepartment);
  if (debitDepartment && creditDepartment && debitDepartment === creditDepartment) {
    erpParts.push(`подразделение ${quoted(debitDepartment)}`);
  } else {
    if (debitDepartment) erpParts.push(`подразделение Дт ${quoted(debitDepartment)}`);
    if (creditDepartment) erpParts.push(`подразделение Кт ${quoted(creditDepartment)}`);
  }
  if (erpParts.length) segments.push(`ERP: ${erpParts.join("; ")}`);

  const sourceArticle = text(economic.sourceArticle);
  const targetArticle = text(economic.targetArticle);
  if (sourceArticle && targetArticle && sourceArticle !== targetArticle) {
    segments.push(`Статья: ${quoted(sourceArticle)} → ${quoted(targetArticle)}`);
  } else if (sourceArticle || targetArticle) {
    segments.push(`Статья: ${quoted(sourceArticle || targetArticle)}`);
  }

  const references = distinctReferences([
    ...structuredReferences(decision),
    ...technicalReferences(decision?.intalev_technical_reference),
  ]).map(formatIntalevReference).filter(Boolean);
  if (references.length) segments.push(`Инталев: ${references.join("; ")}`);
  if (!references.length || intalevDocumentUnavailable(decision, intalevDocumentNotPresented)) {
    segments.push("документ операций Инталев не представлен");
  }

  const businessReason = safeBusinessReason(reason ?? decision?.reason);
  if (businessReason) segments.push(`Причина: ${businessReason}`);
  return segments.join(" | ");
}
