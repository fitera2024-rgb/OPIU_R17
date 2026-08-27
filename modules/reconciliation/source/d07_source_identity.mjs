const REQUIRED = [
  { name: "source_file", aliases: ["input_origin", "source_file"] },
  { name: "source_sha256", aliases: ["input_sha256", "sha256"] },
  { name: "sheet", aliases: ["sheet"] },
  { name: "row", aliases: ["physical_row", "row"] },
  { name: "registrar", aliases: ["registrar"] },
  { name: "posting_number", aliases: ["posting_number", "posting_no", "posting"] },
  { name: "article_code", aliases: ["article_code", "catalog_code", "catalog_codes", "intalev_article_code", "code"] },
  { name: "article_full_path", aliases: ["article_full_path", "full_path", "catalog_path"] },
  { name: "account", aliases: ["account", "catalog_account", "catalog_accounts", "income_expense_account"] },
  { name: "organization", aliases: ["organization_code", "legal_organization", "organization"] },
  { name: "cfo", aliases: ["cfo"] },
  { name: "department", aliases: ["department"] },
  { name: "analytics", aliases: ["analytics", "organizational_dimensions"], allowExplicitEmpty: true },
];

const OPTIONAL = [
  { name: "archive_entry", aliases: ["archive_entry"] },
  { name: "source_cell", aliases: ["source_cell"] },
  { name: "period", aliases: ["period", "month"] },
  { name: "period_column", aliases: ["period_column"] },
  { name: "operation_id", aliases: ["operation_identity", "operation_id", "document_id"] },
];

function own(object, property) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, property);
}

function canonicalText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalValue)
      .filter((item) => item !== "" && item !== null)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return canonicalText(value);
}

function component(source, definition) {
  for (const alias of definition.aliases) {
    if (!own(source, alias)) continue;
    const value = canonicalValue(source[alias]);
    const explicitEmpty = definition.allowExplicitEmpty && Array.isArray(source[alias]) && source[alias].length === 0;
    const present = explicitEmpty || (Array.isArray(value) ? value.length > 0 : value !== "" && value !== null);
    if (present) return { found: true, value };
  }
  return { found: false, value: null };
}

export function exactSourceIdentity(source) {
  const identity = {};
  const missing = [];
  for (const definition of REQUIRED) {
    const value = component(source, definition);
    if (!value.found) missing.push(definition.name);
    else identity[definition.name] = value.value;
  }
  for (const definition of OPTIONAL) {
    const value = component(source, definition);
    if (value.found) identity[definition.name] = value.value;
  }
  if (identity.registrar !== undefined && identity.posting_number !== undefined) {
    identity.operation_identity = {
      registrar: identity.registrar,
      posting_number: identity.posting_number,
      operation_id: identity.operation_id ?? "",
    };
  }
  return {
    complete: missing.length === 0,
    missing,
    identity,
    key: missing.length === 0 ? JSON.stringify(identity) : null,
  };
}

function amount(source, property) {
  const value = source?.[property];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function analyzeExactSourceIdentityDuplicates(sources, { amountProperty = "amount" } = {}) {
  const candidates = Array.isArray(sources) ? sources : [];
  if (candidates.length === 0) {
    return { status: "NO_CANDIDATES", selected: [], duplicates: [], conflicts: [], incomplete: [] };
  }
  const described = candidates.map((source) => ({ source, exact: exactSourceIdentity(source) }));
  const incomplete = described.filter((item) => !item.exact.complete);
  if (incomplete.length > 0) {
    return { status: "INCOMPLETE_IDENTITY", selected: [], duplicates: [], conflicts: [], incomplete };
  }

  const byIdentity = new Map();
  for (const item of described) {
    if (!byIdentity.has(item.exact.key)) byIdentity.set(item.exact.key, []);
    byIdentity.get(item.exact.key).push(item);
  }
  const selected = [];
  const duplicates = [];
  const conflicts = [];
  for (const [identityKey, group] of byIdentity.entries()) {
    if (group.length === 1) {
      selected.push(group[0].source);
      continue;
    }
    const amounts = group.map((item) => amount(item.source, amountProperty));
    const reference = amounts[0];
    const amountPass = reference !== null && amounts.every(
      (value) => value !== null && Math.sign(value) === Math.sign(reference) && value === reference,
    );
    if (!amountPass) {
      conflicts.push({
        identity_key: identityKey,
        identity: group[0].exact.identity,
        sources: group.map((item) => item.source),
        amounts,
      });
      continue;
    }
    selected.push(group[0].source);
    duplicates.push(...group.slice(1).map((item) => item.source));
  }
  if (conflicts.length > 0) {
    return { status: "IDENTITY_CONFLICT", selected: [], duplicates, conflicts, incomplete: [] };
  }
  if (byIdentity.size === 1 && duplicates.length > 0) {
    return { status: "EXACT_DUPLICATE", selected, duplicates, conflicts: [], incomplete: [] };
  }
  return {
    status: byIdentity.size === 1 ? "SINGLE_SOURCE" : "DISTINCT_SOURCES",
    selected,
    duplicates,
    conflicts: [],
    incomplete: [],
  };
}
