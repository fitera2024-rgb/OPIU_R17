import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { structuralControlGroupsFromConfig } from "./structural_control_groups.mjs";

const SCHEMA = "opiu-structural-control-settings.v1";
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const CODE_PATTERN = /^[\p{L}\p{N}_.:/-]+$/u;
const LEGACY_CSV_HEADERS = Object.freeze([
  "Организация",
  "Название группы",
  "Коды верхних блоков",
  "Активна",
]);
const SPLIT_CSV_HEADERS = Object.freeze([
  "Организация",
  "Название группы",
  "Блоки Инталев",
  "Блоки ERP",
  "Активна",
]);
const UI_FIXED_TYPED_SOURCE_FORMAT = "UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1";

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function blocked(code, detail = "") {
  throw new Error(`BLOCKED_STRUCTURAL_CONTROL_SETTINGS_${code}${detail ? `:${detail}` : ""}`);
}

export function assertUniqueStructuralControlScopeArguments(tokens = []) {
  for (const key of ["structural-control-settings", "organization-id", "organization-name", "organization-path", "run-id", "context-id"]) {
    if ((Array.isArray(tokens) ? tokens : []).filter((token) => token === `--${key}`).length > 1) {
      blocked("DUPLICATE_ARGUMENT", key);
    }
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function parseCsvLine(line, rowNumber) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ";" && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) blocked("CSV_QUOTE_UNCLOSED", String(rowNumber));
  values.push(value);
  return values;
}

function activeValue(value, rowNumber) {
  const normalized = text(value).toLocaleLowerCase("ru-RU");
  if (["да", "true", "1", "yes"].includes(normalized)) return true;
  if (["нет", "false", "0", "no"].includes(normalized)) return false;
  blocked("CSV_ACTIVE_INVALID", `${rowNumber}:${text(value)}`);
}

function normalizedCodes(value, rowNumber, minimum = 2) {
  const codes = text(value)
    .split(/[\s,]+/u)
    .map((code) => code.toLocaleUpperCase("ru-RU"))
    .filter(Boolean);
  if (codes.length < minimum) blocked("CSV_MIN_CODES", `${rowNumber}:${minimum}`);
  if (codes.some((code) => !CODE_PATTERN.test(code))) blocked("CSV_CODE_INVALID", String(rowNumber));
  if (new Set(codes).size !== codes.length) blocked("CSV_CODE_DUPLICATE", String(rowNumber));
  return codes;
}

function groupId(organization, name, intalevCodes, erpCodes, splitSides) {
  const canonical = JSON.stringify(splitSides
    ? {
        organization,
        name,
        intalev_member_codes: intalevCodes,
        erp_member_codes: erpCodes,
      }
    : { organization, name, member_codes: intalevCodes });
  return `USER-STRUCTURAL-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20).toUpperCase()}`;
}

async function pathKind(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function readStructuralControlSettingsCsv(csvPath) {
  const resolved = path.resolve(text(csvPath));
  if (await pathKind(resolved) !== "file") blocked("CSV_UNREADABLE", resolved);
  const bytes = await fs.readFile(resolved);
  const content = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) blocked("CSV_EMPTY");
  const headers = parseCsvLine(lines[0], 1).map(text);
  const splitSides = JSON.stringify(headers) === JSON.stringify(SPLIT_CSV_HEADERS);
  const legacy = JSON.stringify(headers) === JSON.stringify(LEGACY_CSV_HEADERS);
  if (!splitSides && !legacy) blocked("CSV_HEADERS_INVALID");

  const rows = [];
  const scopedNames = new Set();
  const codeOwners = new Map();
  for (let index = 1; index < lines.length; index += 1) {
    const rowNumber = index + 1;
    const cells = parseCsvLine(lines[index], rowNumber);
    if (cells.length !== headers.length) blocked("CSV_COLUMN_COUNT", String(rowNumber));
    const organization = text(cells[0]);
    const name = text(cells[1]);
    if (!organization) blocked("CSV_ORGANIZATION_MISSING", String(rowNumber));
    if (!name) blocked("CSV_NAME_MISSING", String(rowNumber));
    const intalevMemberCodes = normalizedCodes(cells[2], rowNumber, splitSides ? 1 : 2);
    const erpMemberCodes = splitSides
      ? normalizedCodes(cells[3], rowNumber, 1)
      : intalevMemberCodes;
    const memberCodes = [...new Set([...intalevMemberCodes, ...erpMemberCodes])];
    if (memberCodes.length < 2) blocked("CSV_MIN_TWO_CODES", String(rowNumber));
    const enabled = activeValue(cells[splitSides ? 4 : 3], rowNumber);
    const scopedName = `${organization}\u0000${name}`;
    if (scopedNames.has(scopedName)) blocked("CSV_GROUP_DUPLICATE", `${organization}:${name}`);
    scopedNames.add(scopedName);
    if (enabled) {
      for (const code of memberCodes) {
        const scopedCode = `${organization}\u0000${code}`;
        if (codeOwners.has(scopedCode)) blocked("CSV_CODE_OVERLAP", `${organization}:${code}`);
        codeOwners.set(scopedCode, name);
      }
    }
    rows.push(Object.freeze({
      organization,
      name,
      enabled,
      member_codes: Object.freeze(memberCodes),
      intalev_member_codes: Object.freeze(intalevMemberCodes),
      erp_member_codes: Object.freeze(erpMemberCodes),
      split_sides: splitSides,
    }));
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    source: Object.freeze({
      path: resolved,
      filename: path.basename(resolved),
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      format: "BUSINESS_CSV_SEMICOLON_UTF8",
    }),
  });
}

function runDocument({ organization, period, source, selectedRows }) {
  const sets = selectedRows.map((row) => Object.freeze({
    id: groupId(
      organization,
      row.name,
      row.intalev_member_codes,
      row.erp_member_codes,
      row.split_sides,
    ),
    name: row.name,
    reconciliation_organization: organization,
    reconciliation_organization_id: organization,
    enabled: true,
    mode: "SUM_DELTA_ONLY",
    member_codes: row.member_codes,
    ...(row.split_sides ? {
      intalev_member_codes: row.intalev_member_codes,
      erp_member_codes: row.erp_member_codes,
    } : {}),
    expected_control_delta: 0,
    tolerance: 0.01,
  }));
  const binding = {
    organization,
    period,
    csv_sha256: source.sha256,
    structural_group_control_sets: sets.map((set) => ({
      id: set.id,
      member_codes: set.member_codes,
      ...(set.intalev_member_codes ? {
        intalev_member_codes: set.intalev_member_codes,
        erp_member_codes: set.erp_member_codes,
      } : {}),
    })),
  };
  return {
    schema: SCHEMA,
    settings_id: `STRUCTURAL-SETTINGS-${crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 24).toUpperCase()}`,
    organization,
    period,
    source,
    structural_group_control_sets: sets,
    safety: {
      mode: "REPORT_ONLY",
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
      execution_allowed: false,
      live_1c_allowed: false,
    },
  };
}

export async function materializeStructuralControlSettingsForRun({
  csvPath,
  organization,
  period,
  outputPath,
} = {}) {
  const runOrganization = text(organization);
  const runPeriod = text(period);
  if (!runOrganization) {
    return Object.freeze({ status: "RUN_SCOPE_INCOMPLETE", path: "", document: null });
  }
  const source = await readStructuralControlSettingsCsv(csvPath);
  const matching = source.rows.filter((row) => row.organization === runOrganization);
  if (matching.length === 0) return Object.freeze({ status: "NO_EXACT_ORGANIZATION", path: "", document: null, source: source.source });
  const selected = matching.filter((row) => row.enabled);
  if (selected.length === 0) return Object.freeze({ status: "NO_ACTIVE_SETS", path: "", document: null, source: source.source });
  if (!MONTH_PATTERN.test(runPeriod)) blocked("RUN_PERIOD_NOT_CONCRETE_MONTH", runPeriod);
  const document = runDocument({ organization: runOrganization, period: runPeriod, source: source.source, selectedRows: selected });
  const requestedOutput = text(outputPath);
  if (!requestedOutput) blocked("OUTPUT_PATH_MISSING");
  const resolvedOutput = path.resolve(requestedOutput);
  await fs.writeFile(resolvedOutput, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return Object.freeze({ status: "EXACT_ORGANIZATION_MATERIALIZED", path: resolvedOutput, document });
}

export async function loadStructuralControlSettingsDocument(requestedPath, {
  organization,
  period,
  organizationId = "",
  organizationName = "",
  organizationPath = "",
  runId = "",
  contextId = "",
} = {}) {
  const requested = text(requestedPath);
  if (!requested) {
    return Object.freeze({
      groups: Object.freeze([]),
      audit: Object.freeze({
        schema: SCHEMA,
        status: "MISSING_DEFAULT_ALL_GROUPS",
        set_count: 0,
        correction_authority: false,
        financial_rows: 0,
        posting_rows: 0,
        execution_allowed: false,
      }),
    });
  }
  const resolved = path.resolve(requested);
  let bytes;
  try {
    bytes = await fs.readFile(resolved);
  } catch (error) {
    blocked("DOCUMENT_UNREADABLE", `${resolved}:${error.message}`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    blocked("DOCUMENT_JSON_INVALID", error.message);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) blocked("DOCUMENT_INVALID");
  if (document.schema !== SCHEMA) blocked("SCHEMA_INVALID", text(document.schema));
  const runOrganization = text(organization);
  const runPeriod = text(period);
  if (document.organization !== runOrganization || document.period !== runPeriod) {
    blocked("RUN_SCOPE_MISMATCH", `${runOrganization}|${runPeriod}`);
  }
  if (!MONTH_PATTERN.test(document.period)) blocked("PERIOD_INVALID", text(document.period));
  if (!text(document.settings_id)) blocked("SETTINGS_ID_MISSING");
  const uiFixedSource = document?.ui_fixed_registry !== undefined;
  if (!document.source || !["BUSINESS_CSV_SEMICOLON_UTF8", UI_FIXED_TYPED_SOURCE_FORMAT].includes(document.source.format) ||
      (uiFixedSource !== (document.source.format === UI_FIXED_TYPED_SOURCE_FORMAT))) blocked("SOURCE_INVALID");
  const sourcePath = path.resolve(text(document.source.path));
  let sourceBytes;
  try {
    sourceBytes = await fs.readFile(sourcePath);
  } catch (error) {
    blocked("SOURCE_UNREADABLE", error.message);
  }
  const sourceSha = sha256Bytes(sourceBytes);
  if (sourceSha !== text(document.source.sha256).toUpperCase() || sourceBytes.length !== Number(document.source.size)) {
    blocked("SOURCE_DRIFT");
  }
  const safety = document.safety;
  if (!safety || safety.mode !== "REPORT_ONLY" || safety.posting_rows !== 0 ||
      safety.ready_to_upload !== false || safety.release_allowed !== false ||
      safety.execution_allowed !== false || safety.live_1c_allowed !== false) {
    blocked("SAFETY_OPEN");
  }
  if (!Array.isArray(document.structural_group_control_sets) || document.structural_group_control_sets.length === 0) {
    blocked("SETS_MISSING");
  }
  let parsedSource = null;
  if (!uiFixedSource) {
    parsedSource = await readStructuralControlSettingsCsv(sourcePath);
    const sourceRows = parsedSource.rows.filter((row) => row.organization === runOrganization && row.enabled);
    if (sourceRows.length === 0) blocked("SOURCE_EXACT_ORGANIZATION_MISSING");
    const regenerated = runDocument({ organization: runOrganization, period: runPeriod,
      source: parsedSource.source, selectedRows: sourceRows });
    if (regenerated.settings_id !== document.settings_id ||
        JSON.stringify(regenerated.structural_group_control_sets) !== JSON.stringify(document.structural_group_control_sets)) {
      blocked("DOCUMENT_SOURCE_BINDING_MISMATCH");
    }
  }
  for (const set of document.structural_group_control_sets) {
    if (text(set.reconciliation_organization_id ?? set.reconciliation_organization) !== runOrganization) {
      blocked("SET_ORGANIZATION_MISMATCH", text(set.id));
    }
    if (set.expected_control_delta !== 0) blocked("EXPECTED_DELTA_NOT_ZERO", text(set.id));
  }
  let groups;
  if (uiFixedSource) {
    groups = Object.freeze(document.structural_group_control_sets.map((set) => Object.freeze({
      ...set,
      member_codes: Object.freeze([...(set.member_codes ?? [])]),
      intalev_member_codes: Object.freeze([...(set.intalev_member_codes ?? [])]),
      erp_member_codes: Object.freeze([...(set.erp_member_codes ?? [])]),
      intalev_member_bindings: Object.freeze((set.intalev_member_bindings ?? []).map((item) => Object.freeze({ ...item }))),
      erp_member_bindings: Object.freeze((set.erp_member_bindings ?? []).map((item) => Object.freeze({ ...item }))),
    })));
  } else {
    try {
      groups = structuralControlGroupsFromConfig(document, { organization: runOrganization });
    } catch (error) {
      blocked("GROUP_CONFIG_INVALID", error.message);
    }
  }
  if (groups.length !== document.structural_group_control_sets.length) blocked("SET_SELECTION_INCOMPLETE");
  const uiFixedRegistry = await validateUIFixedRegistry(document, {
    organizationId,
    organizationName,
    organizationPath,
    runId,
    contextId,
  });
  return Object.freeze({
    groups,
    document: Object.freeze(document),
    audit: Object.freeze({
      schema: SCHEMA,
      status: "ACTIVE_EXACT_ORGANIZATION_MONTH",
      settings_id: document.settings_id,
      organization: runOrganization,
      period: runPeriod,
      input_path: resolved,
      input_sha256: sha256Bytes(bytes),
      input_size: bytes.length,
      source_format: document.source.format,
      source_filename: document.source.filename,
      source_sha256: sourceSha,
      source_size: sourceBytes.length,
      set_count: groups.length,
      sets: Object.freeze(groups.map((group) => Object.freeze({
        id: group.id,
        name: document.structural_group_control_sets.find((set) => set.id === group.id)?.name ?? "",
        member_codes: group.member_codes,
        intalev_member_codes: group.intalev_member_codes,
        erp_member_codes: group.erp_member_codes,
        expected_control_delta: 0,
      }))),
      ...(uiFixedRegistry ? { ui_fixed_registry: uiFixedRegistry } : {}),
      correction_authority: false,
      financial_rows: 0,
      posting_rows: 0,
      execution_allowed: false,
    }),
  });
}

async function validateUIFixedRegistry(document, scope) {
  const origin = document?.ui_fixed_registry;
  if (origin === undefined) return null;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) blocked("UI_FIXED_ORIGIN_INVALID");
  const expected = {
    organization_id: text(scope.organizationId),
    organization_name: text(scope.organizationName),
    organization_path: text(scope.organizationPath),
    run_id: text(scope.runId),
    context_id: text(scope.contextId),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (!value || text(document[field]) !== value) blocked("UI_FIXED_RUN_SCOPE_MISMATCH", field);
  }
  if (text(origin.organization_id) !== expected.organization_id ||
      text(origin.organization_name) !== expected.organization_name ||
      text(origin.organization_path) !== expected.organization_path ||
      text(origin.run_id) !== expected.run_id || text(origin.context_id) !== expected.context_id) {
    blocked("UI_FIXED_ORIGIN_SCOPE_MISMATCH");
  }
  const registryPath = path.resolve(text(origin.registry_path));
  let registryBytes;
  try {
    registryBytes = await fs.readFile(registryPath);
  } catch (error) {
    blocked("UI_FIXED_REGISTRY_UNREADABLE", error.message);
  }
  if (registryBytes.length !== Number(origin.registry_size) ||
      sha256Bytes(registryBytes) !== text(origin.registry_sha256).toUpperCase()) {
    blocked("UI_FIXED_REGISTRY_DRIFT");
  }
  let registry;
  try {
    registry = JSON.parse(registryBytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    blocked("UI_FIXED_REGISTRY_JSON_INVALID", error.message);
  }
  if (registry?.schema_version !== "opiu-structural-control-registry.v1" ||
      Number(registry?.revision) !== Number(origin.registry_revision) ||
      !Array.isArray(registry?.versions) || !Array.isArray(registry?.lifecycle_events)) {
    blocked("UI_FIXED_REGISTRY_INVALID");
  }
  const terminal = new Set(registry.lifecycle_events
    .filter((event) => ["DISABLED", "SUPERSEDED"].includes(text(event?.action)))
    .map((event) => text(event?.control_set_id)));
  const fixedCounts = new Map();
  for (const event of registry.lifecycle_events) {
    if (text(event?.action) !== "FIXED") continue;
    const id = text(event?.control_set_id);
    fixedCounts.set(id, (fixedCounts.get(id) ?? 0) + 1);
  }
  const latestByLineage = new Map();
  for (const version of registry.versions) {
    if (text(version?.organization_id) !== expected.organization_id || terminal.has(text(version?.control_set_id))) continue;
    const lineage = text(version?.lineage_id);
    const prior = latestByLineage.get(lineage);
    if (!prior || Number(version?.version) > Number(prior?.version) ||
        (Number(version?.version) === Number(prior?.version) && text(version?.fixed_at) > text(prior?.fixed_at))) {
      latestByLineage.set(lineage, version);
    }
  }
  const activeVersions = [...latestByLineage.values()]
    .sort((left, right) => text(left?.control_set_id).localeCompare(text(right?.control_set_id), "en"));
  const refs = Array.isArray(origin.active_versions) ? origin.active_versions : [];
  if (refs.length === 0 || refs.length !== activeVersions.length ||
      refs.length !== document.structural_group_control_sets.length) {
    blocked("UI_FIXED_SET_COUNT_MISMATCH");
  }
  const versionsById = new Map(activeVersions.map((version) => [text(version?.control_set_id), version]));
  const setsById = new Map(document.structural_group_control_sets.map((set) => [text(set?.id), set]));
  if (document.structural_group_control_sets.some((set) => text(set?.exact_organization_id) !== expected.organization_id)) {
    blocked("UI_FIXED_SET_EXACT_ORGANIZATION_MISMATCH");
  }
  if (document.structural_group_control_sets.some((set) =>
    set?.enabled !== true || text(set?.mode).toUpperCase() !== "SUM_DELTA_ONLY" ||
    set?.expected_control_delta !== 0 || typeof set?.tolerance !== "number" ||
    !Number.isFinite(set.tolerance) || set.tolerance < 0 ||
    !Array.isArray(set?.intalev_member_bindings) || set.intalev_member_bindings.length === 0 ||
    !Array.isArray(set?.erp_member_bindings) || set.erp_member_bindings.length === 0)) {
    blocked("UI_FIXED_SET_CONTROL_INVARIANT_INVALID");
  }
  const refControlIDs = refs.map((ref) => text(ref?.control_set_id));
  const refSetIDs = refs.map((ref) => text(ref?.materialized_set_id));
  if (new Set(refControlIDs).size !== refs.length || new Set(refSetIDs).size !== refs.length ||
      versionsById.size !== activeVersions.length || setsById.size !== document.structural_group_control_sets.length) {
    blocked("UI_FIXED_REFERENCE_NOT_BIJECTIVE");
  }
  for (const ref of refs) {
    const controlSetId = text(ref?.control_set_id);
    const version = versionsById.get(controlSetId);
    const set = setsById.get(text(ref?.materialized_set_id));
    if (!version || !set || fixedCounts.get(controlSetId) !== 1 ||
        text(version?.organization_id) !== expected.organization_id ||
        text(version?.mode).toUpperCase() !== "SUM_DELTA_ONLY" ||
        Number(version?.expected_control_delta) !== 0 || version?.correction_authority === true ||
        text(version?.lineage_id) !== text(ref?.lineage_id) ||
        Number(version?.version) !== Number(ref?.version) ||
        text(version?.payload_sha256).toUpperCase() !== text(ref?.payload_sha256).toUpperCase() ||
        text(version?.run_id) !== text(ref?.origin_run_id) ||
        text(version?.context_id) !== text(ref?.origin_context_id) ||
        text(version?.inventory_id) !== text(ref?.origin_inventory_id) ||
        text(version?.inventory_binding_sha256).toUpperCase() !== text(ref?.origin_inventory_binding_sha256).toUpperCase()) {
      blocked("UI_FIXED_VERSION_BINDING_MISMATCH", controlSetId);
    }
    const intalevCodes = [...new Set((version.intalev_members ?? []).map((member) => text(member?.code).toLocaleUpperCase("ru-RU")).filter(Boolean))];
    const erpCodes = [...new Set((version.erp_members ?? []).map((member) => text(member?.code).toLocaleUpperCase("ru-RU")).filter(Boolean))];
    const intalevBindings = Array.isArray(set.intalev_member_bindings) ? set.intalev_member_bindings : [];
    const erpBindings = Array.isArray(set.erp_member_bindings) ? set.erp_member_bindings : [];
    if (text(set.name) !== text(version.name) ||
        JSON.stringify(set.intalev_member_codes) !== JSON.stringify(intalevCodes) ||
        JSON.stringify(set.erp_member_codes) !== JSON.stringify(erpCodes) ||
        !uiBindingsMatchVersion(intalevBindings, version.intalev_members, version.inventory_id) ||
        !uiBindingsMatchVersion(erpBindings, version.erp_members, version.inventory_id)) {
      blocked("UI_FIXED_MEMBER_BINDING_MISMATCH", controlSetId);
    }
  }
  return Object.freeze({
    status: "ACTIVE_UI_FIXED_REGISTRY_VERIFIED",
    registry_revision: Number(origin.registry_revision),
    registry_sha256: text(origin.registry_sha256).toUpperCase(),
    organization_id: expected.organization_id,
    run_id: expected.run_id,
    context_id: expected.context_id,
    set_count: refs.length,
    control_set_ids: Object.freeze(refs.map((ref) => text(ref.control_set_id))),
    applied_versions: Object.freeze(refs.map((ref) => Object.freeze({
      control_set_id: text(ref.control_set_id),
      materialized_set_id: text(ref.materialized_set_id),
      lineage_id: text(ref.lineage_id),
      version: Number(ref.version),
      payload_sha256: text(ref.payload_sha256).toUpperCase(),
      origin_run_id: text(ref.origin_run_id),
      origin_context_id: text(ref.origin_context_id),
      origin_inventory_id: text(ref.origin_inventory_id),
      origin_inventory_binding_sha256: text(ref.origin_inventory_binding_sha256).toUpperCase(),
    }))),
    correction_authority: false,
    financial_rows: 0,
    posting_rows: 0,
  });
}

function uiBindingsMatchVersion(bindings, members, inventoryId) {
  if (!Array.isArray(bindings) || !Array.isArray(members) || bindings.length !== members.length || bindings.length === 0) return false;
  return bindings.every((binding, index) =>
    text(binding?.code).toLocaleUpperCase("ru-RU") === text(members[index]?.code).toLocaleUpperCase("ru-RU") &&
    text(binding?.hierarchy_path) === text(members[index]?.hierarchy_path) &&
    text(binding?.origin_identity) !== "" && text(binding?.origin_identity) === text(members[index]?.identity) &&
    text(binding?.origin_inventory_id) === text(inventoryId));
}

export const STRUCTURAL_CONTROL_SETTINGS_SCHEMA = SCHEMA;
export const STRUCTURAL_CONTROL_SETTINGS_CSV_HEADERS = LEGACY_CSV_HEADERS;
export const STRUCTURAL_CONTROL_SETTINGS_SPLIT_CSV_HEADERS = SPLIT_CSV_HEADERS;
