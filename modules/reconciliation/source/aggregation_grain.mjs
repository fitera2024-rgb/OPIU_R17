const AGGREGATION_GRAIN_SCHEMA = "opiu-aggregation-grain-v1";

function text(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return text(value);
}

function key(value) {
  return JSON.stringify(canonical(value));
}

function sourceSystemOf(row, fallback) {
  return text(row?.source_system ?? row?.system ?? row?.source?.source_system ?? fallback).toUpperCase();
}

function sourceValue(row, ...names) {
  for (const name of names) {
    const value = row?.[name] ?? row?.source?.[name];
    if (value !== undefined && value !== null && text(value)) return value;
  }
  return "";
}

function sourceIdentityOf(row) {
  const explicit = row?.source_identity ?? row?.source_id ?? row?.identity ?? row?.id ?? row?.uuid;
  if (explicit && typeof explicit === "object") return `EXPLICIT:${key(explicit)}`;
  if (text(explicit)) return `EXPLICIT:${text(explicit)}`;

  const sha256 = text(sourceValue(row, "source_sha256", "input_sha256", "sha256")).toUpperCase();
  const sheet = text(sourceValue(row, "sheet"));
  const archiveEntry = text(sourceValue(row, "archive_entry"));
  const sourceCell = text(sourceValue(row, "source_cell"));
  const physicalRow = row?.physical_row ?? row?.source_row ?? row?.row ?? row?.source?.physical_row ?? row?.source?.source_row ?? row?.source?.row;
  const location = sourceCell || (Number.isInteger(Number(physicalRow)) ? `ROW:${Number(physicalRow)}` : "");
  if (sha256 && sheet && location) {
    return `TRACE:${sha256}|${archiveEntry}|${sheet}|${location}`;
  }
  return "";
}

function sourceScopeOf(row, sourceSystem) {
  const explicit = text(
    row?.source_identity_scope ??
      row?.aggregation_scope_id ??
      row?.source_scope_id ??
      row?.source_scope ??
      row?.source?.source_identity_scope,
  );
  if (explicit) return `EXPLICIT:${explicit}`;

  const sha256 = text(sourceValue(row, "source_sha256", "input_sha256", "sha256")).toUpperCase();
  const sheet = text(sourceValue(row, "sheet"));
  const archiveEntry = text(sourceValue(row, "archive_entry"));
  const period = text(row?.period ?? row?.month ?? row?.source?.period ?? row?.source?.month);
  if (sha256 && sheet) {
    return `TRACE:${sourceSystem}|${sha256}|${archiveEntry}|${sheet}|${period}`;
  }
  return "";
}

function amountOf(row, amountProperty) {
  const amount = row?.[amountProperty];
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

function grainKeyOf(row, aggregationKey) {
  const explicit = text(aggregationKey ?? row?.aggregation_grain_id ?? row?.aggregation_key);
  return explicit || "";
}

export function buildAggregationGrainIdentity(
  row,
  { sourceSystem = "", aggregationKey = "" } = {},
) {
  const system = sourceSystemOf(row, sourceSystem);
  const sourceIdentity = sourceIdentityOf(row);
  const sourceIdentityScope = sourceScopeOf(row, system);
  const grainKey = grainKeyOf(row, aggregationKey);
  const aggregationGrainId = system && sourceIdentityScope && grainKey
    ? `${system}|${sourceIdentityScope}|GRAIN:${grainKey}`
    : "";
  const proven = Boolean(system && sourceIdentity && sourceIdentityScope && grainKey && aggregationGrainId);
  return {
    schema: AGGREGATION_GRAIN_SCHEMA,
    status: proven ? "PROVEN" : "REVIEW_ONLY",
    source_system: system,
    source_identity: sourceIdentity,
    source_identity_scope: sourceIdentityScope,
    aggregation_grain_key: grainKey,
    aggregation_grain_id: aggregationGrainId,
    correction_authority: false,
  };
}

function reviewResult(reasonCode, rows, identities) {
  return {
    schema: AGGREGATION_GRAIN_SCHEMA,
    status: "REVIEW_ONLY",
    reason_code: reasonCode,
    amount: null,
    selected: [],
    ignored: [],
    rows: [...rows],
    identities,
    aggregation_grain_id: "",
    source_identity_scope: "",
    source_system: "",
    correction_authority: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

function blockedResult(reasonCode, rows, identities, conflicts) {
  return {
    ...reviewResult(reasonCode, rows, identities),
    status: "BLOCKED",
    conflicts,
  };
}

/**
 * Sum only a proven source-backed aggregation grain. Presentation paths and
 * equal amounts are deliberately not identity evidence.
 */
export function aggregateProvenRows(
  rows,
  {
    sourceSystem = "",
    aggregationKey = "",
    amountProperty = "amount",
  } = {},
) {
  const values = Array.isArray(rows) ? rows : [];
  if (values.length === 0) {
    return reviewResult("NO_ROWS", values, []);
  }
  const identities = values.map((row) => buildAggregationGrainIdentity(row, {
    sourceSystem,
    aggregationKey,
  }));
  if (identities.some((identity) => identity.status !== "PROVEN")) {
    return reviewResult(
      "AGGREGATION_GRAIN_UNPROVEN",
      values,
      identities,
    );
  }
  const systems = new Set(identities.map((identity) => identity.source_system));
  if (systems.size !== 1) {
    return reviewResult("CROSS_SYSTEM_SCOPE", values, identities);
  }
  const scopes = new Set(identities.map((identity) => identity.source_identity_scope));
  const grainIds = new Set(identities.map((identity) => identity.aggregation_grain_id));
  if (scopes.size !== 1 || grainIds.size !== 1) {
    return reviewResult("AGGREGATION_GRAIN_SCOPE_CONFLICT", values, identities);
  }
  if (values.some((row) => amountOf(row, amountProperty) === null)) {
    return reviewResult("AMOUNT_UNPROVEN", values, identities);
  }

  const groups = new Map();
  identities.forEach((identity, index) => {
    if (!groups.has(identity.source_identity)) groups.set(identity.source_identity, []);
    groups.get(identity.source_identity).push(index);
  });
  const selected = [];
  const ignored = [];
  const conflicts = [];
  for (const [sourceIdentity, indexes] of groups) {
    const amounts = indexes.map((index) => amountOf(values[index], amountProperty));
    const first = amounts[0];
    if (!amounts.every((amount) => amount === first)) {
      conflicts.push({
        source_identity: sourceIdentity,
        indexes,
        amounts,
      });
      continue;
    }
    selected.push(values[indexes[0]]);
    ignored.push(...indexes.slice(1).map((index) => values[index]));
  }
  if (conflicts.length > 0) {
    return blockedResult("PROVEN_COMPOSITION_CONTRADICTION", values, identities, conflicts);
  }
  return {
    schema: AGGREGATION_GRAIN_SCHEMA,
    status: "PROVEN",
    reason_code: ignored.length > 0 ? "EXACT_SOURCE_IDENTITY_DEDUPLICATED" : "PROVEN_COMPOSITION",
    amount: selected.reduce((sum, row) => sum + amountOf(row, amountProperty), 0),
    selected,
    ignored,
    rows: [...values],
    identities,
    aggregation_grain_id: identities[0].aggregation_grain_id,
    source_identity_scope: identities[0].source_identity_scope,
    source_system: identities[0].source_system,
    correction_authority: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export function combineProvenAggregations(parent, detail) {
  const parentAggregation = parent ?? {};
  const detailAggregation = detail ?? {};
  const fields = ["status", "aggregation_grain_id", "source_identity_scope", "source_system"];
  if (parentAggregation.status !== "PROVEN" || detailAggregation.status !== "PROVEN") {
    return {
      ...reviewResult("AGGREGATION_GRAIN_UNPROVEN", [], []),
      parent: parentAggregation,
      detail: detailAggregation,
    };
  }
  if (fields.some((field) => field !== "status" && parentAggregation[field] !== detailAggregation[field])) {
    return {
      ...reviewResult("PARENT_DETAIL_GRAIN_CONFLICT", [], []),
      parent: parentAggregation,
      detail: detailAggregation,
    };
  }
  return {
    ...detailAggregation,
    status: "PROVEN",
    reason_code: "PARENT_DETAIL_GRAIN_MATCHED",
    parent: parentAggregation,
    detail: detailAggregation,
  };
}

export { AGGREGATION_GRAIN_SCHEMA };
