import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const REFERENCE_CATALOG_SCHEMA = "opiu-reference-catalog-manifest-v1";
export const REQUIRED_REFERENCE_CATALOG_ROLES = Object.freeze([
  "erp_structure",
  "erp_formula",
  "erp_source",
  "erp_uid",
  "intalev_structure",
  "intalev_formula",
  "intalev_source",
  "intalev_uid",
]);

const SHA256_PATTERN = /^[A-F0-9]{64}$/;
const REQUIRED_USAGE = Object.freeze(["calculation", "validation"]);
const DECLARED_MISSING_STATUS_BY_ROLE = Object.freeze({
  intalev_uid: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
});

export class ReferenceCatalogManifestError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "ReferenceCatalogManifestError";
    this.code = code;
    this.details = details;
  }
}

function block(code, details = {}) {
  throw new ReferenceCatalogManifestError(code, details);
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizedSha256(value) {
  return text(value).toUpperCase();
}

function canonicalPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function readEvidence(filePath, missingCode, details = {}) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) block(missingCode, { ...details, path: filePath, reason: "NOT_A_FILE" });
    const bytes = await fs.readFile(filePath);
    return { bytes, size: stat.size, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof ReferenceCatalogManifestError) throw error;
    block(missingCode, {
      ...details,
      path: filePath,
      reason: error?.code ?? "READ_FAILED",
    });
  }
}

function requireConfigured(value, field) {
  const normalized = text(value);
  if (!normalized) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_NOT_CONFIGURED", { field });
  }
  return normalized;
}

function validateRequiredRoles(manifestRoles, requiredRoles) {
  if (!Array.isArray(manifestRoles)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: "required_roles",
      reason: "NOT_AN_ARRAY",
    });
  }
  const normalized = manifestRoles.map(text);
  if (new Set(normalized).size !== normalized.length) {
    block("BLOCKED_REFERENCE_CATALOG_DUPLICATE", {
      field: "required_roles",
    });
  }
  const expected = [...requiredRoles].sort();
  const actual = [...normalized].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    block("BLOCKED_REFERENCE_CATALOG_REQUIRED_ROLES_MISMATCH", {
      expected,
      actual,
    });
  }
}

function validateCatalogShape(catalog, index, requiredRoleSet, allowedMissingRoleSet) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: `catalogs[${index}]`,
      reason: "NOT_AN_OBJECT",
    });
  }
  const id = text(catalog.id);
  const role = text(catalog.role);
  const catalogPath = text(catalog.path);
  const version = text(catalog.version);
  const status = text(catalog.status).toUpperCase();
  const usage = Array.isArray(catalog.usage) ? catalog.usage.map(text) : [];

  for (const [field, value] of Object.entries({ id, role, path: catalogPath, version, status })) {
    if (!value) {
      block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
        field: `catalogs[${index}].${field}`,
        reason: "EMPTY",
      });
    }
  }
  if (!requiredRoleSet.has(role)) {
    block("BLOCKED_REFERENCE_CATALOG_ROLE_UNEXPECTED", { id, role });
  }
  const declaredMissing = status === "MISSING" && allowedMissingRoleSet.has(role);
  if (status === "MISSING" && !declaredMissing) {
    block("BLOCKED_REFERENCE_CATALOG_MISSING", { id, role, path: catalogPath });
  }
  if (status !== "CURRENT" && !declaredMissing) {
    block("BLOCKED_REFERENCE_CATALOG_STALE", { id, role, status, version });
  }
  const expectedSha256 = normalizedSha256(catalog.sha256);
  if (!declaredMissing && !SHA256_PATTERN.test(expectedSha256)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: `catalogs[${index}].sha256`,
      id,
      role,
      reason: "INVALID_SHA256",
    });
  }
  for (const requiredUsage of REQUIRED_USAGE) {
    if (!usage.includes(requiredUsage)) {
      block("BLOCKED_REFERENCE_CATALOG_USAGE_MISSING", {
        id,
        role,
        required_usage: requiredUsage,
      });
    }
  }
  return {
    id,
    role,
    path: catalogPath,
    version,
    status,
    usage: [...new Set(usage)].sort(),
    expected_sha256: declaredMissing ? null : expectedSha256,
    declared_missing: declaredMissing,
  };
}

function normalizeAllowedMissingRoles(value, requiredRoleSet) {
  if (value == null) return new Set();
  if (!Array.isArray(value)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: "allowedMissingRoles",
      reason: "NOT_AN_ARRAY",
    });
  }
  const normalized = value.map(text);
  if (normalized.some((role) => !requiredRoleSet.has(role))) {
    block("BLOCKED_REFERENCE_CATALOG_ROLE_UNEXPECTED", {
      roles: normalized.filter((role) => !requiredRoleSet.has(role)),
    });
  }
  if (normalized.some((role) => !Object.hasOwn(DECLARED_MISSING_STATUS_BY_ROLE, role))) {
    block("BLOCKED_REFERENCE_CATALOG_MISSING_ROLE_NOT_ALLOWLISTED", {
      roles: normalized.filter(
        (role) => !Object.hasOwn(DECLARED_MISSING_STATUS_BY_ROLE, role),
      ),
    });
  }
  return new Set(normalized);
}

export async function verifyReferenceCatalogManifest({
  manifestPath,
  expectedVersion,
  expectedManifestSha256,
  requiredRoles = REQUIRED_REFERENCE_CATALOG_ROLES,
  allowedMissingRoles = [],
} = {}) {
  const configuredManifestPath = requireConfigured(
    manifestPath,
    "reference_catalog_manifest_path",
  );
  const configuredVersion = requireConfigured(
    expectedVersion,
    "reference_catalog_manifest_version",
  );
  const configuredManifestSha256 = normalizedSha256(
    requireConfigured(expectedManifestSha256, "reference_catalog_manifest_sha256"),
  );
  if (!SHA256_PATTERN.test(configuredManifestSha256)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_NOT_CONFIGURED", {
      field: "reference_catalog_manifest_sha256",
      reason: "INVALID_SHA256",
    });
  }

  const resolvedManifestPath = path.resolve(configuredManifestPath);
  const manifestEvidence = await readEvidence(
    resolvedManifestPath,
    "BLOCKED_REFERENCE_CATALOG_MANIFEST_MISSING",
  );
  if (manifestEvidence.sha256 !== configuredManifestSha256) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_HASH_DRIFT", {
      path: resolvedManifestPath,
      expected_sha256: configuredManifestSha256,
      actual_sha256: manifestEvidence.sha256,
    });
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestEvidence.bytes.toString("utf8"));
  } catch (error) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      path: resolvedManifestPath,
      reason: "INVALID_JSON",
      error: error?.message ?? String(error),
    });
  }
  if (manifest.schema !== REFERENCE_CATALOG_SCHEMA) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: "schema",
      expected: REFERENCE_CATALOG_SCHEMA,
      actual: manifest.schema,
    });
  }
  if (text(manifest.version) !== configuredVersion) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_STALE", {
      expected_version: configuredVersion,
      actual_version: text(manifest.version),
    });
  }

  const roleList = requiredRoles.map(text);
  const requiredRoleSet = new Set(roleList);
  if (requiredRoleSet.size !== roleList.length || requiredRoleSet.has("")) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: "requiredRoles",
      reason: "INVALID_CALLER_REQUIREMENTS",
    });
  }
  const allowedMissingRoleSet = normalizeAllowedMissingRoles(
    allowedMissingRoles,
    requiredRoleSet,
  );
  validateRequiredRoles(manifest.required_roles, roleList);
  if (!Array.isArray(manifest.catalogs)) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_INVALID", {
      field: "catalogs",
      reason: "NOT_AN_ARRAY",
    });
  }

  const ids = new Set();
  const roles = new Set();
  const paths = new Set();
  const catalogs = [];
  const manifestDir = path.dirname(resolvedManifestPath);
  for (let index = 0; index < manifest.catalogs.length; index += 1) {
    const shaped = validateCatalogShape(
      manifest.catalogs[index],
      index,
      requiredRoleSet,
      allowedMissingRoleSet,
    );
    const resolvedPath = path.isAbsolute(shaped.path)
      ? path.resolve(shaped.path)
      : path.resolve(manifestDir, shaped.path);
    const pathKey = canonicalPathKey(resolvedPath);
    const duplicate = ids.has(shaped.id)
      ? { field: "id", value: shaped.id }
      : roles.has(shaped.role)
        ? { field: "role", value: shaped.role }
        : paths.has(pathKey)
          ? { field: "path", value: resolvedPath }
          : null;
    if (duplicate) {
      block("BLOCKED_REFERENCE_CATALOG_DUPLICATE", {
        ...duplicate,
        id: shaped.id,
        role: shaped.role,
      });
    }
    ids.add(shaped.id);
    roles.add(shaped.role);
    paths.add(pathKey);

    if (shaped.declared_missing) {
      catalogs.push({
        ...shaped,
        path: resolvedPath,
        size: null,
        sha256_before: null,
        status: "MISSING_DECLARED_FAIL_CLOSED",
      });
    } else {
      const evidence = await readEvidence(
        resolvedPath,
        "BLOCKED_REFERENCE_CATALOG_MISSING",
        { id: shaped.id, role: shaped.role },
      );
      if (evidence.sha256 !== shaped.expected_sha256) {
        block("BLOCKED_REFERENCE_CATALOG_HASH_DRIFT", {
          id: shaped.id,
          role: shaped.role,
          path: resolvedPath,
          expected_sha256: shaped.expected_sha256,
          actual_sha256: evidence.sha256,
        });
      }
      catalogs.push({
        ...shaped,
        path: resolvedPath,
        size: evidence.size,
        sha256_before: evidence.sha256,
      });
    }
  }

  const missingRoles = roleList.filter((role) => !roles.has(role));
  if (missingRoles.length > 0) {
    block("BLOCKED_REFERENCE_CATALOG_ROLE_MISSING", { roles: missingRoles });
  }
  const declaredMissingRoles = catalogs
    .filter((catalog) => catalog.declared_missing)
    .map((catalog) => catalog.role)
    .sort();
  const manifestStatus = text(manifest.status).toUpperCase();
  if (declaredMissingRoles.length === 0 && manifestStatus !== "CURRENT") {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_NOT_CURRENT", { status: manifestStatus });
  }
  if (declaredMissingRoles.length > 0) {
    const expectedStatuses = declaredMissingRoles.map(
      (role) => DECLARED_MISSING_STATUS_BY_ROLE[role],
    );
    if (expectedStatuses.length !== 1 || manifestStatus !== expectedStatuses[0]) {
      block("BLOCKED_REFERENCE_CATALOG_MANIFEST_DEGRADED_STATUS_MISMATCH", {
        status: manifestStatus,
        declared_missing_roles: declaredMissingRoles,
        expected_statuses: expectedStatuses,
      });
    }
  }

  catalogs.sort((left, right) => left.role.localeCompare(right.role));
  const bindingPayload = {
    schema: REFERENCE_CATALOG_SCHEMA,
    manifest_version: configuredVersion,
    manifest_sha256: manifestEvidence.sha256,
    catalogs: catalogs.map((catalog) => ({
      id: catalog.id,
      role: catalog.role,
      path: catalog.path,
      version: catalog.version,
      sha256: catalog.sha256_before,
      size: catalog.size,
      usage: catalog.usage,
      status: catalog.status,
    })),
  };
  return {
    schema: REFERENCE_CATALOG_SCHEMA,
    status: declaredMissingRoles.length > 0
      ? "PASS_REFERENCE_CATALOGS_BOUND_WITH_DECLARED_MISSING_ROLES"
      : "PASS_REFERENCE_CATALOGS_BOUND",
    version: configuredVersion,
    manifest_path: resolvedManifestPath,
    manifest_sha256_before: manifestEvidence.sha256,
    manifest_size: manifestEvidence.size,
    required_roles: roleList,
    catalogs,
    declared_missing_roles: declaredMissingRoles,
    release_blockers: declaredMissingRoles.map(
      (role) => DECLARED_MISSING_STATUS_BY_ROLE[role],
    ),
    binding_sha256: sha256(Buffer.from(JSON.stringify(bindingPayload), "utf8")),
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export function bindCalculationPayload(payload, referenceCatalogs) {
  if (!referenceCatalogs?.binding_sha256 || !Array.isArray(referenceCatalogs.catalogs)) {
    block("BLOCKED_REFERENCE_CATALOG_BINDING_MISSING");
  }
  const missingCalculationRoles = referenceCatalogs.catalogs
    .filter((catalog) => !catalog.usage?.includes("calculation"))
    .map((catalog) => catalog.role);
  if (missingCalculationRoles.length > 0) {
    block("BLOCKED_REFERENCE_CATALOG_USAGE_MISSING", {
      required_usage: "calculation",
      roles: missingCalculationRoles,
    });
  }
  return {
    ...payload,
    reference_catalog_binding: {
      manifest_version: referenceCatalogs.version,
      manifest_sha256: referenceCatalogs.manifest_sha256_before,
      binding_sha256: referenceCatalogs.binding_sha256,
      status: referenceCatalogs.status,
      declared_missing_roles: referenceCatalogs.declared_missing_roles ?? [],
      release_blockers: referenceCatalogs.release_blockers ?? [],
      catalogs: referenceCatalogs.catalogs.map((catalog) => ({
        role: catalog.role,
        version: catalog.version,
        sha256: catalog.sha256_before,
        status: catalog.status,
      })),
    },
  };
}

export function bindRunIntalevUidCatalog(
  referenceCatalogs,
  discovery,
  selectionMode = "AUTO_DETECTED_CONTAINER",
) {
  const staticManifest = structuredClone(referenceCatalogs);
  const runBound = discovery?.selected?.provenance ?? {
    selection_mode: selectionMode,
    status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
    candidate_count: discovery?.candidate_count ?? 0,
    container: discovery?.container_before ?? null,
    scan_totals: discovery?.scan_totals ?? null,
  };
  if (!discovery?.selected) {
    return {
      ...referenceCatalogs,
      static_manifest: staticManifest,
      run_bound: { intalev_uid: runBound },
    };
  }
  const selected = discovery.selected;
  if (
    selected.parsed?.structured_parent_export !== true ||
    selected.parsed?.hierarchy_tree?.status !== "PASS" ||
    selected.provenance?.hash_stable !== true ||
    !SHA256_PATTERN.test(selected.provenance?.sha256 ?? "")
  ) {
    block("BLOCKED_RUN_BOUND_REFERENCE_CATALOG_INVALID", { role: "intalev_uid" });
  }
  const catalogs = referenceCatalogs.catalogs.map((catalog) =>
    catalog.role === "intalev_uid"
      ? {
          ...catalog,
          path: selected.source_path,
          version: `run-bound:${selected.provenance.sha256.slice(0, 16)}`,
          size: selected.provenance.size,
          sha256_before: selected.provenance.sha256,
          expected_sha256: selected.provenance.sha256,
          declared_missing: false,
          status: "PASS_RUN_BOUND_INTALEV_UID",
        }
      : catalog,
  );
  const declaredMissingRoles = (referenceCatalogs.declared_missing_roles ?? [])
    .filter((role) => role !== "intalev_uid");
  const releaseBlockers = (referenceCatalogs.release_blockers ?? [])
    .filter((code) => code !== "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED");
  const bindingSha256 = sha256(Buffer.from(JSON.stringify({
    static_binding_sha256: referenceCatalogs.binding_sha256,
    role: "intalev_uid",
    sha256: selected.provenance.sha256,
    size: selected.provenance.size,
    entry_path: selected.provenance.entry_path,
    archive_sha256: selected.provenance.archive_sha256,
  }), "utf8"));
  return {
    ...referenceCatalogs,
    status: declaredMissingRoles.length > 0
      ? "PASS_REFERENCE_CATALOGS_BOUND_WITH_DECLARED_MISSING_ROLES"
      : "PASS_REFERENCE_CATALOGS_BOUND",
    binding_sha256: bindingSha256,
    catalogs,
    declared_missing_roles: declaredMissingRoles,
    release_blockers: releaseBlockers,
    static_manifest: staticManifest,
    run_bound: { intalev_uid: runBound },
  };
}

export async function rehashReferenceCatalogManifest(referenceCatalogs) {
  if (!referenceCatalogs?.manifest_path || !Array.isArray(referenceCatalogs.catalogs)) {
    block("BLOCKED_REFERENCE_CATALOG_BINDING_MISSING");
  }
  const manifestEvidence = await readEvidence(
    referenceCatalogs.manifest_path,
    "BLOCKED_REFERENCE_CATALOG_MANIFEST_MISSING",
  );
  if (manifestEvidence.sha256 !== referenceCatalogs.manifest_sha256_before) {
    block("BLOCKED_REFERENCE_CATALOG_MANIFEST_SOURCE_DRIFT", {
      path: referenceCatalogs.manifest_path,
      before_sha256: referenceCatalogs.manifest_sha256_before,
      after_sha256: manifestEvidence.sha256,
    });
  }

  const catalogs = [];
  for (const catalog of referenceCatalogs.catalogs) {
    if (catalog.declared_missing) {
      catalogs.push({
        id: catalog.id,
        role: catalog.role,
        path: catalog.path,
        version: catalog.version,
        usage: catalog.usage,
        size: null,
        sha256_before: null,
        sha256_after: null,
        status: "BLOCKED_REFERENCE_CATALOG_DECLARED_MISSING",
        declared_missing: true,
      });
      continue;
    }
    const evidence = await readEvidence(
      catalog.path,
      "BLOCKED_REFERENCE_CATALOG_MISSING",
      { id: catalog.id, role: catalog.role },
    );
    if (evidence.sha256 !== catalog.sha256_before) {
      block("BLOCKED_REFERENCE_CATALOG_SOURCE_DRIFT", {
        id: catalog.id,
        role: catalog.role,
        path: catalog.path,
        before_sha256: catalog.sha256_before,
        after_sha256: evidence.sha256,
      });
    }
    catalogs.push({
      id: catalog.id,
      role: catalog.role,
      path: catalog.path,
      version: catalog.version,
      usage: catalog.usage,
      size: evidence.size,
      sha256_before: catalog.sha256_before,
      sha256_after: evidence.sha256,
      status: "PASS_NO_SOURCE_DRIFT",
    });
  }
  const declaredMissingRoles = catalogs
    .filter((catalog) => catalog.declared_missing)
    .map((catalog) => catalog.role)
    .sort();
  return {
    status: declaredMissingRoles.length > 0
      ? "PASS_NO_AVAILABLE_REFERENCE_DRIFT_WITH_DECLARED_MISSING_ROLES"
      : "PASS_NO_REFERENCE_DRIFT",
    manifest: {
      path: referenceCatalogs.manifest_path,
      version: referenceCatalogs.version,
      size: manifestEvidence.size,
      sha256_before: referenceCatalogs.manifest_sha256_before,
      sha256_after: manifestEvidence.sha256,
      status: "PASS_NO_SOURCE_DRIFT",
    },
    catalogs,
    declared_missing_roles: declaredMissingRoles,
  };
}

export function buildReferenceCatalogTrace(referenceCatalogs, finalRehash) {
  if (
    ![
      "PASS_NO_REFERENCE_DRIFT",
      "PASS_NO_AVAILABLE_REFERENCE_DRIFT_WITH_DECLARED_MISSING_ROLES",
    ].includes(finalRehash?.status) ||
    finalRehash.catalogs?.length !== referenceCatalogs.catalogs?.length
  ) {
    block("BLOCKED_REFERENCE_CATALOG_FINAL_REHASH_MISSING");
  }
  return {
    schema: REFERENCE_CATALOG_SCHEMA,
    status: referenceCatalogs.declared_missing_roles?.length > 0
      ? "PASS_AVAILABLE_REFERENCE_CATALOGS_REHASHED_WITH_DECLARED_MISSING_ROLES"
      : "PASS_REFERENCE_CATALOGS_BOUND_AND_REHASHED",
    version: referenceCatalogs.version,
    binding_sha256: referenceCatalogs.binding_sha256,
    required_roles: referenceCatalogs.required_roles,
    manifest: finalRehash.manifest,
    catalogs: finalRehash.catalogs,
    declared_missing_roles: referenceCatalogs.declared_missing_roles ?? [],
    release_blockers: referenceCatalogs.release_blockers ?? [],
    static_manifest: referenceCatalogs.static_manifest ?? null,
    run_bound: referenceCatalogs.run_bound ?? null,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
