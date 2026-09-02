import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ORGANIZATION_CATALOG_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "..",
  "..",
  "data",
  "defaults",
  "organizations.json",
);
export const DEFAULT_ORGANIZATION_AUTHORITY_PATH = path.resolve(
  MODULE_DIR,
  "..",
  "..",
  "..",
  "resources",
  "reference",
  "ОрганизациииерархияЕРП.xlsx",
);

function text(value) {
  return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function key(value) {
  return text(value).toLocaleLowerCase("ru-RU");
}

function blocked(...blockerCodes) {
  return {
    status: "BLOCKED_PHYSICAL_ORGANIZATION_SCOPE",
    member_names: [],
    member_identities: [],
    blocker_codes: [...new Set(blockerCodes.map(text).filter(Boolean))],
  };
}

function normalizedNode(raw) {
  return {
    raw,
    id: text(raw?.node_id),
    code: text(raw?.code ?? raw?.node_code),
    name: text(raw?.name ?? raw?.node_name),
    path: text(raw?.path ?? raw?.hierarchy_path),
    parentId: text(raw?.parent_id),
    topId: text(raw?.top_id),
    topName: text(raw?.top_name),
    depth: Number(raw?.depth),
    nodeType: text(raw?.node_type).toUpperCase(),
    sourceVerified: raw?.source_verified === true,
    inn: text(raw?.metadata?.inn),
  };
}

function stableHierarchyIdentity(node) {
  return Boolean(
    node.id
      && node.name
      && node.path
      && Number.isInteger(node.depth)
      && node.depth >= 0,
  );
}

function stableMemberIdentity(node) {
  return stableHierarchyIdentity(node) && Boolean(node.code);
}

function exactRoot(node) {
  return stableMemberIdentity(node)
    && node.sourceVerified
    && node.nodeType === "ORGANIZATION"
    && node.depth === 0
    && !node.parentId
    && key(node.topId) === key(node.id)
    && key(node.topName) === key(node.name)
    && key(node.path) === key(node.name);
}

function provenEntity(node) {
  // INN is a positive legal-entity identity supplied by the pinned ERP source.
  // It deliberately does not infer role from a label, prefix, department name,
  // path depth, or fuzzy similarity.
  return stableMemberIdentity(node)
    && node.sourceVerified
    && node.nodeType === "ORGANIZATION"
    && Boolean(node.inn);
}

function validateMemberChain(node, root, byId) {
  const seen = new Set();
  let current = node;
  while (key(current.id) !== key(root.id)) {
    const currentKey = key(current.id);
    if (!currentKey || seen.has(currentKey)) return "ORGANIZATION_HIERARCHY_CYCLE";
    seen.add(currentKey);
    if (!stableHierarchyIdentity(current) || !current.sourceVerified) {
      return "ORGANIZATION_HIERARCHY_IDENTITY_UNPROVEN";
    }
    if (key(current.topId) !== key(root.id) || key(current.topName) !== key(root.name)) {
      return "ORGANIZATION_HIERARCHY_ROOT_MISMATCH";
    }
    const parent = byId.get(key(current.parentId));
    if (!parent) return "ORGANIZATION_HIERARCHY_PARENT_MISSING";
    if (current.depth !== parent.depth + 1) return "ORGANIZATION_HIERARCHY_DEPTH_MISMATCH";
    if (key(current.path) !== key(`${parent.path} / ${current.name}`)) {
      return "ORGANIZATION_HIERARCHY_PATH_MISMATCH";
    }
    current = parent;
  }
  return exactRoot(current) ? "" : "ORGANIZATION_HIERARCHY_ROOT_UNPROVEN";
}

export async function loadAuthoritativeOrganizationHierarchy({
  catalogPath = process.env.OPIU_ORGANIZATION_CATALOG || DEFAULT_ORGANIZATION_CATALOG_PATH,
  authoritySourcePath = DEFAULT_ORGANIZATION_AUTHORITY_PATH,
  expectedSourceSha256,
} = {}) {
  const expectedSha = text(expectedSourceSha256).toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(expectedSha)) {
    throw new Error("PHYSICAL_ORGANIZATION_HIERARCHY_SOURCE_PIN_INVALID");
  }
  let authorityBytes;
  try {
    authorityBytes = await fs.readFile(path.resolve(authoritySourcePath));
  } catch (error) {
    throw new Error(`PHYSICAL_ORGANIZATION_HIERARCHY_SOURCE_LOAD_FAILED:${error?.message ?? error}`);
  }
  const actualSourceSha = crypto.createHash("sha256").update(authorityBytes).digest("hex").toUpperCase();
  if (actualSourceSha !== expectedSha) {
    throw new Error("PHYSICAL_ORGANIZATION_HIERARCHY_SOURCE_SHA256_MISMATCH");
  }
  let document;
  try {
    document = JSON.parse(await fs.readFile(path.resolve(catalogPath), "utf8"));
  } catch (error) {
    throw new Error(`PHYSICAL_ORGANIZATION_HIERARCHY_LOAD_FAILED:${error?.message ?? error}`);
  }
  if (text(document?.schema_version) !== "opiu-organizations.v1"
    || text(document?.source?.sha256).toUpperCase() !== expectedSha
    || !Array.isArray(document?.nodes)
    || document.nodes.length === 0) {
    throw new Error("PHYSICAL_ORGANIZATION_HIERARCHY_AUTHORITY_INVALID");
  }
  return document;
}

export function derivePhysicalOrganizationScope({
  selectedOrganizationId,
  selectedOrganizationName,
  selectedOrganizationPath,
  authoritativeHierarchy,
} = {}) {
  if (text(authoritativeHierarchy?.schema_version) !== "opiu-organizations.v1"
    || !Array.isArray(authoritativeHierarchy?.nodes)
    || authoritativeHierarchy.nodes.length === 0) {
    return blocked("ORGANIZATION_HIERARCHY_MISSING");
  }

  const nodes = authoritativeHierarchy.nodes.map(normalizedNode);
  const byId = new Map();
  for (const node of nodes) {
    if (!node.id) return blocked("ORGANIZATION_HIERARCHY_IDENTITY_UNPROVEN");
    const nodeKey = key(node.id);
    if (byId.has(nodeKey)) return blocked("ORGANIZATION_HIERARCHY_ID_AMBIGUOUS");
    byId.set(nodeKey, node);
  }

  const selectedId = key(selectedOrganizationId);
  const selectedName = key(selectedOrganizationName);
  const selectedPath = key(selectedOrganizationPath);
  if (!selectedId || !selectedName || !selectedPath) {
    return blocked("SELECTED_ORGANIZATION_ROOT_IDENTITY_INCOMPLETE");
  }
  const roots = nodes.filter(exactRoot).filter((node) => {
    if (key(node.id) !== selectedId) return false;
    if (key(node.name) !== selectedName) return false;
    if (key(node.path) !== selectedPath) return false;
    return true;
  });
  if (roots.length !== 1) return blocked("SELECTED_ORGANIZATION_ROOT_UNPROVEN");
  const root = roots[0];

  const relevantNodes = nodes.filter(
    (node) => key(node.id) === key(root.id) || key(node.topId) === key(root.id),
  );
  for (const node of relevantNodes) {
    const blocker = validateMemberChain(node, root, byId);
    if (blocker) return blocked(blocker);
  }

  const entityNameCounts = new Map();
  for (const node of nodes) {
    if (!exactRoot(node) && !provenEntity(node)) continue;
    const nameKey = key(node.name);
    entityNameCounts.set(nameKey, (entityNameCounts.get(nameKey) ?? 0) + 1);
  }

  const members = relevantNodes
    .filter((node) => key(node.id) === key(root.id) || provenEntity(node))
    .filter((node) => entityNameCounts.get(key(node.name)) === 1)
    .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path, "ru"));

  return {
    status: "PROVEN_PHYSICAL_ORGANIZATION_SCOPE",
    selected_root: {
      node_id: root.id,
      code: root.code,
      name: root.name,
      path: root.path,
    },
    member_names: members.map((node) => node.name),
    member_identities: members.map((node) => ({
      node_id: node.id,
      code: node.code,
      name: node.name,
      path: node.path,
      top_id: node.topId,
      source_verified: node.sourceVerified,
      role_proof: key(node.id) === key(root.id) ? "EXACT_SELECTED_ROOT" : "ERP_LEGAL_ENTITY_INN",
    })),
    blocker_codes: [],
  };
}
