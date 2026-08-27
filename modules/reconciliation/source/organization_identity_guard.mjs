import crypto from "node:crypto";

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalized(value) {
  return text(value).replace(/[«»"]/g, "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

export function dimensionRoleForHeader(value) {
  const header = normalized(value);
  if (
    header === "организация" ||
    header.startsWith("организация ") ||
    header.includes("юридическое лицо")
  ) return "organization";
  if (
    header === "цфо" ||
    header.startsWith("цфо ") ||
    header.startsWith("цфо(") ||
    header.includes("центр финансовой ответственности")
  ) return "cfo";
  if (
    header.includes("подраздел") ||
    header.includes("структурная единица")
  ) return "department";
  return null;
}

export function buildRoleBoundDimensionIdentity({ organizationCode, cfo, department }) {
  const organization = text(organizationCode);
  if (!organization) {
    return {
      status: "BLOCKED_ORGANIZATION_CODE_MISSING",
      identity: "",
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    };
  }
  const payload = {
    organization_code: normalized(organization),
    cfo: normalized(cfo),
    department: normalized(department),
  };
  return {
    status: "PASS",
    identity: crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex").toUpperCase(),
    roles: payload,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

function containsIdentityToken(evidence, token) {
  const haystack = ` ${normalized(evidence).replace(/[^a-zа-я0-9]+/g, " ")} `;
  const needle = ` ${normalized(token).replace(/[^a-zа-я0-9]+/g, " ")} `;
  return needle.trim().length > 0 && haystack.includes(needle);
}

export function proveRequestedOrganization({ requestedOrganization, aliases = [], evidence = [] }) {
  const requested = text(requestedOrganization);
  if (!requested) {
    return {
      status: "BLOCKED_ORGANIZATION_REQUIRED",
      requested_organization: "",
      matched_alias: "",
      evidence: [],
    };
  }
  const tokens = [...new Set([requested, ...aliases].map(text).filter(Boolean))];
  const matches = [];
  for (const item of evidence.map(text).filter(Boolean)) {
    for (const token of tokens) {
      if (containsIdentityToken(item, token)) matches.push({ token, evidence: item });
    }
  }
  if (matches.length === 0) {
    return {
      status: "BLOCKED_ORGANIZATION_NOT_PROVEN",
      requested_organization: requested,
      matched_alias: "",
      evidence: evidence.map(text).filter(Boolean),
    };
  }
  return {
    status: "PASS_ORGANIZATION_PROVEN",
    requested_organization: requested,
    matched_alias: matches[0].token,
    evidence: [...new Set(matches.map((match) => match.evidence))],
  };
}

export function scopeOrganizationCandidates({ requestedOrganization, aliases = [], candidates = [] }) {
  const scoped = [];
  const proofs = [];
  for (const candidate of candidates) {
    const proof = proveRequestedOrganization({
      requestedOrganization,
      aliases,
      evidence: candidate.identity_evidence ?? [],
    });
    if (proof.status === "PASS_ORGANIZATION_PROVEN") {
      scoped.push(candidate);
      proofs.push(proof);
    }
  }
  if (scoped.length === 0) {
    return {
      status: "BLOCKED_ORGANIZATION_NOT_PROVEN",
      candidates: [],
      proofs: [],
      unscoped_fallback_used: false,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    };
  }
  return {
    status: "PASS_ORGANIZATION_SCOPED",
    candidates: scoped,
    proofs,
    unscoped_fallback_used: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export function buildIntalevArticleIdentity({ organizationCode, articleCode, articleName = "" }) {
  const organization = text(organizationCode);
  const code = text(articleCode);
  if (!organization || !code) {
    return {
      status: !organization
        ? "BLOCKED_ORGANIZATION_CODE_MISSING"
        : "BLOCKED_INTALEV_ARTICLE_CODE_MISSING",
      identity: "",
      organization_code: organization,
      article_code: code,
      article_name: text(articleName),
    };
  }
  return {
    status: "PASS",
    identity: `${normalized(organization)}|${normalized(code)}`,
    organization_code: organization,
    article_code: code,
    article_name: text(articleName),
  };
}

export function buildIntalevCatalogIdentityEvidence({
  status,
  sourceFile,
  sheet,
  sha256,
  entries = [],
}) {
  const source = text(sourceFile);
  const sheetName = text(sheet);
  const sourceSha256 = text(sha256).toUpperCase();
  const candidates = entries.map((entry) => ({
    organization_code: text(entry.organization_code),
    article_code: text(entry.code),
    article_name: text(entry.label),
    organization_article_identity: text(entry.organization_article_identity),
    identity_status: text(entry.organization_article_identity_status),
    full_path: text(entry.full_path),
    physical_row: Number(entry.source_row ?? 0),
    source_cell: text(entry.source_cell),
  }));
  const baseComplete =
    Boolean(source) &&
    Boolean(sheetName) &&
    /^[A-F0-9]{64}$/.test(sourceSha256) &&
    candidates.every(
      (candidate) =>
        Number.isInteger(candidate.physical_row) &&
        candidate.physical_row > 0 &&
        Boolean(candidate.source_cell),
    );
  return {
    status: baseComplete ? text(status) : "BLOCKED_INTALEV_CATALOG_EVIDENCE_INCOMPLETE",
    source_file: source,
    sheet: sheetName,
    sha256: sourceSha256,
    candidates,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
