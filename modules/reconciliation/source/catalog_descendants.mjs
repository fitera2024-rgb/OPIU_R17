import crypto from "node:crypto";
import fs from "node:fs/promises";

const manifestUrl = new URL("./catalog_descendants.current.json", import.meta.url);

export const D04_CATALOG_MANIFEST = Object.freeze(
  JSON.parse(await fs.readFile(manifestUrl, "utf8")),
);

function text(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function label(value) {
  return text(value).replace(/^\d+_/, "").replace(/[«»"]/g, "").toLocaleLowerCase("ru-RU");
}

function blocked(status, note, details = {}) {
  return {
    status,
    note,
    leaf_count: 0,
    graph_sha256: "",
    records: [],
    by_parent: {},
    blockers: [note],
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    ...details,
  };
}

function graphRecord(record) {
  return [
    record.parent_code,
    record.parent_full_path,
    record.leaf_full_path,
    record.code,
    record.account,
  ].join("|");
}

function isNonPostingRole(node) {
  return ["parent", "group", "total", "итог", "группа", "родитель"].includes(
    label(node?.row_kind ?? node?.role ?? ""),
  );
}

export function buildCatalogCoverage({
  templateRows,
  erpCatalog,
  manifest = D04_CATALOG_MANIFEST,
  validateExpected = true,
}) {
  if (!erpCatalog || !Array.isArray(erpCatalog.nodes)) {
    return blocked(
      "BLOCKED_CATALOG_HIERARCHY_MISSING",
      "ERP catalog hierarchy is absent; D04 cannot derive descendants.",
    );
  }
  const targetParentCodes = [...new Set(manifest.target_parent_codes ?? [])];
  if (targetParentCodes.length === 0) {
    return blocked(
      "BLOCKED_CATALOG_TARGETS_MISSING",
      "D04 target parent codes are absent from the versioned manifest.",
    );
  }

  const records = [];
  const byParent = {};
  for (const parentCode of targetParentCodes) {
    const templateCandidates = (templateRows ?? []).filter((row) => row.code === parentCode);
    if (templateCandidates.length !== 1) {
      const status = templateCandidates.length === 0
        ? "BLOCKED_CATALOG_PARENT_TEMPLATE_MISSING"
        : "BLOCKED_CATALOG_PARENT_TEMPLATE_AMBIGUOUS";
      return blocked(status, `Template parent ${parentCode} is not uniquely proven (${templateCandidates.length}).`);
    }
    const expectedPath = [manifest.root_path, templateCandidates[0].erp_label]
      .map(text)
      .filter(Boolean)
      .join(" / ");
    const catalogParents = erpCatalog.nodes.filter(
      (node) => Number(node.level) === 1 && label(node.full_path) === label(expectedPath),
    );
    if (catalogParents.length !== 1) {
      const status = catalogParents.length === 0
        ? "BLOCKED_CATALOG_PARENT_MISSING"
        : "BLOCKED_CATALOG_PARENT_AMBIGUOUS";
      return blocked(status, `Catalog parent ${parentCode} / ${expectedPath} is not uniquely proven (${catalogParents.length}).`);
    }

    const catalogParent = catalogParents[0];
    const prefix = `${label(catalogParent.full_path)} / `;
    const parentRecords = [];
    for (const node of erpCatalog.nodes) {
      if (node === catalogParent || node.has_children || isNonPostingRole(node)) continue;
      if (!`${label(node.full_path)} `.startsWith(prefix)) continue;
      for (const entry of node.catalog_entries ?? []) {
        if (label(entry.account) !== label(manifest.required_account)) continue;
        parentRecords.push({
          parent_code: parentCode,
          parent_full_path: text(catalogParent.full_path),
          parent_source_row: Number(catalogParent.source_row ?? 0),
          leaf_full_path: text(node.full_path),
          leaf_source_row: Number(node.source_row ?? 0),
          entry_source_row: Number(entry.source_row ?? 0),
          code: text(entry.code),
          account: text(entry.account),
          row_kind: "LEAF",
          posting_eligible: false,
        });
      }
    }
    if (parentRecords.length === 0) {
      return blocked(
        "BLOCKED_CATALOG_DESCENDANTS_MISSING",
        `Catalog parent ${parentCode} has no proven leaf descendants for ${manifest.required_account}.`,
      );
    }
    parentRecords.sort((a, b) => graphRecord(a).localeCompare(graphRecord(b), "ru"));
    byParent[parentCode] = parentRecords;
    records.push(...parentRecords);
  }

  records.sort((a, b) => graphRecord(a).localeCompare(graphRecord(b), "ru"));
  const graphSha256 = crypto
    .createHash("sha256")
    .update(records.map(graphRecord).sort().join("\n"), "utf8")
    .digest("hex")
    .toUpperCase();
  const catalogSha256 = text(erpCatalog.sha256).toUpperCase();
  const expectedCatalogSha256 = text(manifest.runtime_catalog_sha256).toUpperCase();
  const details = { leaf_count: records.length, graph_sha256: graphSha256, records, by_parent: byParent };
  if (validateExpected && expectedCatalogSha256 && catalogSha256 !== expectedCatalogSha256) {
    return blocked(
      "BLOCKED_CATALOG_SOURCE_DRIFT",
      `ERP catalog SHA-256 changed: expected ${expectedCatalogSha256}, got ${catalogSha256 || "MISSING"}.`,
      details,
    );
  }
  if (
    validateExpected &&
    (records.length !== Number(manifest.expected_leaf_count) ||
      graphSha256 !== text(manifest.expected_graph_sha256).toUpperCase())
  ) {
    return blocked(
      "BLOCKED_CATALOG_MANIFEST_MISMATCH",
      `D04 catalog graph changed: expected ${manifest.expected_leaf_count}/${manifest.expected_graph_sha256}, got ${records.length}/${graphSha256}.`,
      details,
    );
  }
  return {
    status: "PASS_CATALOG_MANIFEST",
    note: `D04 catalog manifest covers ${records.length}/${manifest.expected_leaf_count} leaves.`,
    catalog_sha256: catalogSha256,
    blockers: [],
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    ...details,
  };
}

function failClosed(status, note, proof, trace = []) {
  return {
    amount: null,
    status,
    trace,
    note,
    d04_catalog_proof: proof,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

export function resolveCatalogFallback({ parentCode, currentResult, coverage, resolveLeaf, roundMoney }) {
  const round = roundMoney ?? ((value) => Math.round((value + Number.EPSILON) * 100) / 100);
  const proof = {
    status: coverage?.status ?? "BLOCKED_CATALOG_HIERARCHY_MISSING",
    leaf_count: coverage?.leaf_count ?? 0,
    graph_sha256: coverage?.graph_sha256 ?? "",
    catalog_sha256: coverage?.catalog_sha256 ?? "",
  };
  if (!coverage || coverage.status !== "PASS_CATALOG_MANIFEST") {
    return failClosed(
      coverage?.status ?? "BLOCKED_CATALOG_HIERARCHY_MISSING",
      coverage?.note ?? "D04 catalog coverage is missing.",
      proof,
    );
  }
  const leaves = coverage.by_parent[parentCode] ?? [];
  if (leaves.length === 0) {
    return failClosed("BLOCKED_CATALOG_DESCENDANTS_MISSING", `No catalog descendants were proven for ${parentCode}.`, proof);
  }
  if (currentResult && typeof currentResult.amount === "number" && currentResult.status !== "ZERO_NO_ACTIVITY") {
    return {
      ...currentResult,
      d04_catalog_proof: { ...proof, parent_code: parentCode, parent_leaf_count: leaves.length },
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    };
  }

  const resolvedLeaves = [];
  for (const leaf of leaves) {
    const resolved = resolveLeaf(leaf);
    if (!resolved || typeof resolved.amount !== "number" || /^(BLOCKED|AMBIGUOUS|MISSING)/.test(String(resolved.status ?? ""))) {
      return failClosed(
        "BLOCKED_CATALOG_DESCENDANT_SOURCE",
        `Leaf ${leaf.code} / ${leaf.leaf_full_path} is not uniquely resolved: ${resolved?.status ?? "MISSING"}.`,
        { ...proof, parent_code: parentCode, parent_leaf_count: leaves.length },
        resolved?.trace ?? [],
      );
    }
    resolvedLeaves.push({ leaf, resolved });
  }
  return {
    amount: round(resolvedLeaves.reduce((sum, item) => sum + item.resolved.amount, 0)),
    status: "AGGREGATED_HIERARCHY",
    trace: resolvedLeaves.flatMap((item) => item.resolved.trace ?? []),
    note: `Catalog hierarchy aggregated ${resolvedLeaves.length} leaves for ${parentCode}; graph ${coverage.graph_sha256}.`,
    d04_catalog_proof: {
      ...proof,
      parent_code: parentCode,
      parent_leaf_count: leaves.length,
      leaf_amounts: resolvedLeaves.map(({ leaf, resolved }) => ({
        code: leaf.code,
        full_path: leaf.leaf_full_path,
        amount: resolved.amount,
        posting_eligible: false,
      })),
    },
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}
