const MAPPING_SCHEMA = "opiu-economic-hierarchy-mapping-v1";
const ACCEPTED_PROOF_STATUSES = new Set(["ACCEPTED", "PASS", "PROVEN"]);

function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function root(value) {
  return text(value) || "ROOT";
}

function mappingEntries(mapping) {
  if (Array.isArray(mapping)) return mapping;
  return Array.isArray(mapping?.entries) ? mapping.entries : [];
}

function rowKey(row) {
  return text(row?.economic_relationship_key ?? row?.economic_mapping_key);
}

function proofIsExplicit(entry) {
  const proof = entry?.proof;
  if (!proof || typeof proof !== "object") return false;
  const status = text(proof.status).toUpperCase();
  const source = text(proof.source ?? proof.source_ref ?? proof.evidence_id);
  return ACCEPTED_PROOF_STATUSES.has(status) && Boolean(source);
}

function invalidMapping(reason, details = {}) {
  return {
    schema: MAPPING_SCHEMA,
    status: "REVIEW_ONLY",
    entries: [],
    reason,
    ...details,
  };
}

export function validateEconomicHierarchyMapping(mapping) {
  if (mapping == null) {
    return invalidMapping("MISSING_MAPPING");
  }
  if (Array.isArray(mapping)) {
    return invalidMapping("MAPPING_SCHEMA_MISSING");
  }
  if (text(mapping.schema) !== MAPPING_SCHEMA) {
    return invalidMapping("MAPPING_SCHEMA_MISMATCH");
  }
  const entries = mappingEntries(mapping);
  const keys = new Map();
  const invalid = [];
  for (const entry of entries) {
    const key = text(entry?.relationship_key ?? entry?.economic_relationship_key);
    const economicParent = text(entry?.economic_parent);
    const erpParent = text(entry?.erp_parent_node_id);
    const intalevParent = text(entry?.intalev_parent_node_id);
    if (!key || !economicParent || !erpParent || !intalevParent || !proofIsExplicit(entry)) {
      invalid.push({ mapping_id: text(entry?.mapping_id), relationship_key: key });
      continue;
    }
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(entry);
  }
  if (invalid.length > 0) {
    return invalidMapping("MAPPING_ENTRY_INVALID", { invalid_entries: invalid });
  }
  const duplicateKeys = [...keys.entries()]
    .filter(([, values]) => values.length !== 1)
    .map(([key]) => key);
  if (duplicateKeys.length > 0) {
    return invalidMapping("MAPPING_KEY_AMBIGUOUS", { duplicate_keys: duplicateKeys });
  }
  return {
    schema: MAPPING_SCHEMA,
    status: "PASS",
    entries,
  };
}

function reviewResult(category, details = {}) {
  return {
    evidence_category: category,
    evidence_severity: "REVIEW",
    evidence_status: "REVIEW_ONLY",
    economic_parent: "",
    economic_parent_proven: false,
    economic_parent_match: false,
    correction_authority: false,
    ...details,
  };
}

export function resolveEconomicHierarchyRelationship({ row, erp, intalev, mapping }) {
  const presentationParentMatch = erp?.mapped === true && intalev?.mapped === true
    ? text(erp.parent_code) === text(intalev.parent_code)
    : false;
  const base = {
    parent_code: text(intalev?.parent_code),
    presentation_parent: text(intalev?.parent_code),
    erp_presentation_parent: text(erp?.parent_code),
    intalev_presentation_parent: text(intalev?.parent_code),
    erp_presentation_parent_node_id: erp?.mapped === true ? text(erp.parent_node_id) : "",
    intalev_presentation_parent_node_id: intalev?.mapped === true ? text(intalev.parent_node_id) : "",
    presentation_parent_match: presentationParentMatch,
    posting_parent: row?.posting_parent_proven === true ? text(row.posting_parent) : "",
    posting_parent_proven: row?.posting_parent_proven === true && Boolean(text(row.posting_parent)),
  };
  const validation = validateEconomicHierarchyMapping(mapping);
  const key = rowKey(row);
  if (validation.status !== "PASS") {
    return {
      ...base,
      ...reviewResult(
        validation.reason === "MISSING_MAPPING" || !key
          ? "MISSING_ECONOMIC_MAPPING"
          : "INVALID_ECONOMIC_MAPPING",
        { mapping_status: validation.reason ?? validation.status, economic_relationship_key: key },
      ),
    };
  }
  const entry = validation.entries.find(
    (candidate) => text(candidate.relationship_key ?? candidate.economic_relationship_key) === key,
  );
  if (!key || !entry) {
    return {
      ...base,
      ...reviewResult("MISSING_ECONOMIC_MAPPING", { economic_relationship_key: key }),
    };
  }
  if (erp?.mapped !== true || intalev?.mapped !== true) {
    return {
      ...base,
      ...reviewResult("PRESENTATION_BINDING_UNPROVEN", {
        mapping_id: text(entry.mapping_id),
        economic_relationship_key: key,
      }),
    };
  }
  const actualErpParent = root(erp.parent_node_id);
  const actualIntalevParent = root(intalev.parent_node_id);
  const expectedErpParent = root(entry.erp_parent_node_id);
  const expectedIntalevParent = root(entry.intalev_parent_node_id);
  if (actualErpParent !== expectedErpParent || actualIntalevParent !== expectedIntalevParent) {
    return {
      ...base,
      evidence_category: "EXPLICIT_MAPPING_CONTRADICTION",
      evidence_severity: "BLOCKED",
      evidence_status: "BLOCKED",
      economic_parent: text(entry.economic_parent),
      economic_parent_proven: false,
      economic_parent_match: false,
      correction_authority: false,
      mapping_id: text(entry.mapping_id),
      economic_relationship_key: key,
      expected_erp_parent_node_id: expectedErpParent,
      expected_intalev_parent_node_id: expectedIntalevParent,
      actual_erp_parent_node_id: actualErpParent,
      actual_intalev_parent_node_id: actualIntalevParent,
    };
  }
  return {
    ...base,
    evidence_category: presentationParentMatch
      ? "EXPLICIT_ECONOMIC_MAPPING"
      : "ECONOMIC_MAPPING_OVERRIDES_PRESENTATION_DIFFERENCE",
    evidence_severity: "INFO",
    evidence_status: "PASS",
    economic_parent: text(entry.economic_parent),
    economic_parent_proven: true,
    economic_parent_match: true,
    correction_authority: false,
    mapping_id: text(entry.mapping_id),
    economic_relationship_key: key,
  };
}

export { MAPPING_SCHEMA };
