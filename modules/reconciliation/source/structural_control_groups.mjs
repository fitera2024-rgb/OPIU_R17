/**
 * User-configured structural exception groups.
 *
 * The production default is deliberately empty: structural groups are an
 * exception to ordinary root-level checking, never a whitelist or a built-in
 * business-code policy. Descendants are not selected by this configuration.
 */
export const STRUCTURAL_CONTROL_GROUPS = Object.freeze([]);

function normalizedCode(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLocaleUpperCase("ru-RU");
}

function normalizedOrganization(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function configuredOrganization(entry) {
  return normalizedOrganization(
    entry?.reconciliation_organization_id
      ?? entry?.organization_id
      ?? entry?.reconciliation_organization
      ?? entry?.organization,
  );
}

function exactCentAmount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  const represented = cents / 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.abs(value - represented) <= tolerance ? cents : null;
}

function configError(reason) {
  throw new Error(`STRUCTURAL_GROUP_CONTROL_CONFIG_INVALID:${reason}`);
}

function configuredMembers(group) {
  if (Array.isArray(group?.member_codes)) return group.member_codes;
  if (Array.isArray(group?.members)) return group.members;
  const intalev = Array.isArray(group?.intalev_member_codes)
    ? group.intalev_member_codes
    : Array.isArray(group?.intalev_members)
      ? group.intalev_members
      : [];
  const erp = Array.isArray(group?.erp_member_codes)
    ? group.erp_member_codes
    : Array.isArray(group?.erp_members)
      ? group.erp_members
      : [];
  return [...new Set([...intalev, ...erp])];
}

function configuredSideMembers(group, side) {
  const codes = group?.[`${side}_member_codes`];
  if (Array.isArray(codes)) return codes;
  const members = group?.[`${side}_members`];
  return Array.isArray(members) ? members : null;
}

/**
 * Validates and normalizes the persisted config surface. Disabled entries are
 * retained in the user's config file but have no runtime effect.
 */
export function structuralControlGroupsFromConfig(config = {}, {
  organization = "",
} = {}) {
  const configured = config?.structural_group_control_sets;
  if (configured === undefined) return STRUCTURAL_CONTROL_GROUPS;
  if (!Array.isArray(configured)) configError("SETS_NOT_ARRAY");

  const active = [];
  const ids = new Set();
  const ownersByCode = new Map();
  const selectedOrganization = normalizedOrganization(organization);
  for (let index = 0; index < configured.length; index += 1) {
    const entry = configured[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      configError(`SET_NOT_OBJECT:${index}`);
    }
    if (typeof entry.enabled !== "boolean") configError(`ENABLED_NOT_BOOLEAN:${index}`);
    if (entry.enabled !== true) continue;

    const id = String(entry.id ?? entry.group_id ?? "").trim();
    if (!id) configError(`ID_MISSING:${index}`);
    const organizationIdentity = configuredOrganization(entry);
    if (!organizationIdentity) configError(`ORGANIZATION_MISSING:${id}`);
    const scopedId = `${organizationIdentity}\u0000${id}`;
    if (ids.has(scopedId)) configError(`DUPLICATE_ID:${organizationIdentity}:${id}`);
    ids.add(scopedId);

    const mode = String(entry.mode ?? "").trim().toLocaleUpperCase("en-US");
    if (mode !== "SUM_DELTA_ONLY") configError(`MODE_UNSUPPORTED:${id}:${mode || "MISSING"}`);

    const rawIntalevMembers = configuredSideMembers(entry, "intalev");
    const rawErpMembers = configuredSideMembers(entry, "erp");
    const explicitSides = rawIntalevMembers !== null || rawErpMembers !== null;
    if (explicitSides && (rawIntalevMembers === null || rawErpMembers === null)) {
      configError(`SIDE_MEMBERS_INCOMPLETE:${id}`);
    }
    const rawMembers = explicitSides
      ? [...rawIntalevMembers, ...rawErpMembers]
      : configuredMembers(entry);
    if (rawMembers.length < 2) configError(`MIN_TWO_MEMBERS:${id}`);
    const normalizedMembers = rawMembers.map(normalizedCode);
    if (normalizedMembers.some((code) => !code)) configError(`MEMBER_EMPTY:${id}`);
    if (!explicitSides && new Set(normalizedMembers).size !== normalizedMembers.length) {
      configError(`DUPLICATE_MEMBER:${id}`);
    }
    const intalevMembers = (explicitSides ? rawIntalevMembers : rawMembers).map(normalizedCode);
    const erpMembers = (explicitSides ? rawErpMembers : rawMembers).map(normalizedCode);
    if (intalevMembers.length === 0 || erpMembers.length === 0) {
      configError(`SIDE_MEMBERS_EMPTY:${id}`);
    }
    if (intalevMembers.some((code) => !code) || erpMembers.some((code) => !code)) {
      configError(`MEMBER_EMPTY:${id}`);
    }
    if (new Set(intalevMembers).size !== intalevMembers.length) {
      configError(`DUPLICATE_INTALEV_MEMBER:${id}`);
    }
    if (new Set(erpMembers).size !== erpMembers.length) {
      configError(`DUPLICATE_ERP_MEMBER:${id}`);
    }
    const members = [...new Set([...intalevMembers, ...erpMembers])];

    const tolerance = entry.tolerance === undefined
      ? Number(config?.tolerance ?? 0.01)
      : Number(entry.tolerance);
    const toleranceCents = exactCentAmount(tolerance);
    if (toleranceCents === null) configError(`TOLERANCE_NOT_EXACT_CENTS:${id}`);

    for (const code of members) {
      const scopedCode = `${organizationIdentity}\u0000${code}`;
      const prior = ownersByCode.get(scopedCode);
      if (prior) configError(`OVERLAPPING_ROOT:${code}:${prior}:${id}`);
      ownersByCode.set(scopedCode, id);
    }

    active.push(Object.freeze({
      id,
      organization: organizationIdentity,
      organization_id: organizationIdentity,
      reconciliation_organization: organizationIdentity,
      reconciliation_organization_id: organizationIdentity,
      enabled: true,
      mode,
      tolerance,
      tolerance_cents: toleranceCents,
      group_id: id,
      member_codes: Object.freeze(members),
      intalev_member_codes: Object.freeze(intalevMembers),
      erp_member_codes: Object.freeze(erpMembers),
      control_classification: "CONTROL_ONLY",
      posting_classification: "NON_POSTING",
      intalev_value_field: "intalev_amount",
      erp_value_field: "erp_amount",
    }));
  }
  return Object.freeze(selectedOrganization
    ? active.filter((group) => group.reconciliation_organization_id === selectedOrganization)
    : active);
}

export function serializeStructuralControlGroups(groups = STRUCTURAL_CONTROL_GROUPS) {
  return Object.freeze((Array.isArray(groups) ? groups : []).map((group) => Object.freeze({
    id: String(group?.id ?? group?.group_id ?? "").trim(),
    organization: configuredOrganization(group),
    enabled: true,
    members: Object.freeze(configuredMembers(group).map(normalizedCode).filter(Boolean)),
    intalev_members: Object.freeze((configuredSideMembers(group, "intalev")
      ?? configuredMembers(group)).map(normalizedCode).filter(Boolean)),
    erp_members: Object.freeze((configuredSideMembers(group, "erp")
      ?? configuredMembers(group)).map(normalizedCode).filter(Boolean)),
    mode: String(group?.mode ?? "SUM_DELTA_ONLY"),
    tolerance: Number(group?.tolerance ?? 0.01),
  })));
}

export function structuralControlGroupForCode(value, groups = STRUCTURAL_CONTROL_GROUPS, {
  organization = "",
} = {}) {
  const code = normalizedCode(value && typeof value === "object"
    ? value.reporting_code ?? value.code ?? value.row_code ?? value.reconciliation_row
    : value);
  const organizationIdentity = normalizedOrganization(organization || (
    value && typeof value === "object"
      ? value.organization_id ?? value.organization ?? value.organization_code
      : ""
  ));
  const candidates = (Array.isArray(groups) ? groups : []).filter((group) =>
    configuredMembers(group).some((member) => normalizedCode(member) === code)
      && (!organizationIdentity
        || configuredOrganization(group) === organizationIdentity),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function isStructuralControlGroupMember(value, groups = STRUCTURAL_CONTROL_GROUPS) {
  return structuralControlGroupForCode(value, groups) !== null;
}

export function structuralControlGroupCodes(groups = STRUCTURAL_CONTROL_GROUPS) {
  return Object.freeze([...new Set((Array.isArray(groups) ? groups : [])
    .flatMap(configuredMembers)
    .map(normalizedCode)
    .filter(Boolean))]);
}
