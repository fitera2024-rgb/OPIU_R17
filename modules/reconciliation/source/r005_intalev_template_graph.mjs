import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const GRAPH_SCHEMA = "opiu-r005-approved-intalev-template-graph-v1";
const APPROVAL_STATUS = "APPROVED_R005_PRESENTATION_ONLY";
const WORK_ID = "OPIU-2026-08-17-R005-TREE-01";
const SHA256_PATTERN = /^[A-F0-9]{64}$/;

function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceIndentUnits(value) {
  let units = 0;
  for (const character of String(value ?? "")) {
    if (character === " " || character === "\u00a0") units += 1;
    else if (character === "\t") units += 2;
    else break;
  }
  return units;
}

function expectedR005Codes() {
  return Array.from(
    { length: 65 },
    (_, index) => `R${String(index + 1).padStart(3, "0")}`,
  );
}

export class ApprovedIntalevTemplateGraphError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "ApprovedIntalevTemplateGraphError";
    this.code = code;
    this.details = details;
  }
}

export function approvedIntalevTemplateGraphAppliesToProfile(profile) {
  return text(profile?.id) === "UK_R005";
}

function block(code, details = {}) {
  throw new ApprovedIntalevTemplateGraphError(code, details);
}

function exactArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => text(value) === text(expected[index]));
}

export function validateApprovedIntalevTemplateGraph({
  document,
  graphPath,
  graphSha256,
  templatePath,
  templateSha256,
  templateRows,
  expectedCodes = expectedR005Codes(),
}) {
  const normalizedGraphSha256 = text(graphSha256).toUpperCase();
  const normalizedTemplateSha256 = text(templateSha256).toUpperCase();
  if (!SHA256_PATTERN.test(normalizedGraphSha256)) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_HASH_INVALID", { graph_sha256: graphSha256 });
  }
  if (!SHA256_PATTERN.test(normalizedTemplateSha256)) {
    block("BLOCKED_INTALEV_REFERENCE_TEMPLATE_HASH_INVALID", {
      template_sha256: templateSha256,
    });
  }
  if (document?.schema !== GRAPH_SCHEMA) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_SCHEMA", { schema: document?.schema });
  }
  if (
    document?.approval?.status !== APPROVAL_STATUS ||
    document?.approval?.authority !== "OWNER_TASK_CONTRACT" ||
    document?.approval?.work_id !== WORK_ID ||
    document?.approval?.rules_authority !== false ||
    document?.approval?.r001_authority !== false ||
    document?.approval?.financial_authority !== false
  ) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_NOT_APPROVED", {
      approval: document?.approval ?? null,
    });
  }
  if (
    document?.source?.system !== "INTALEV" ||
    document?.source?.kind !== "REFERENCE_INTALEV_STRUCTURE" ||
    document?.source?.sheet !== "02_Месяц" ||
    document?.source?.range !== "B7:D71" ||
    document?.source?.structure_basis !== "INTALEV_LABEL_INDENT" ||
    document?.source?.template_sha256 !== normalizedTemplateSha256 ||
    document?.validation?.erp_used !== false ||
    document?.validation?.source_derived !== true ||
    document?.validation?.exact_code_set !== true
  ) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_SOURCE_MISMATCH", {
      source: document?.source ?? null,
      validation: document?.validation ?? null,
      template_sha256: normalizedTemplateSha256,
    });
  }
  if (
    !Array.isArray(templateRows) ||
    templateRows.length !== expectedCodes.length ||
    !Array.isArray(document.nodes) ||
    document.nodes.length !== expectedCodes.length ||
    Number(document?.validation?.node_count) !== expectedCodes.length
  ) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_INCOMPLETE", {
      expected_nodes: expectedCodes.length,
      template_rows: templateRows?.length ?? null,
      graph_nodes: document?.nodes?.length ?? null,
    });
  }

  const nodesByCode = new Map();
  const indentStack = [];
  for (let index = 0; index < expectedCodes.length; index += 1) {
    const expectedCode = expectedCodes[index];
    const sourceRow = index + 7;
    const templateRow = templateRows[index];
    const node = document.nodes[index];
    const actualIndentUnits = sourceIndentUnits(templateRow?.intalev_label_raw);
    while (
      indentStack.length > 0 &&
      Number(indentStack.at(-1).indent_units) >= actualIndentUnits
    ) {
      indentStack.pop();
    }
    const derivedParentNode = indentStack.at(-1) ?? null;
    const derivedParent = text(derivedParentNode?.code);
    const declaredParent = text(node.parent_code);
    const expectedParentPath = derivedParentNode
      ? [...derivedParentNode.path_codes, expectedCode]
      : [expectedCode];
    const expectedLabelPath = derivedParentNode
      ? [...derivedParentNode.path_labels, text(templateRow?.intalev_label)]
      : [text(templateRow?.intalev_label)];
    if (
      text(templateRow?.code) !== expectedCode ||
      text(node.code) !== expectedCode ||
      Number(node.order) !== index + 1 ||
      Number(node.source_row) !== sourceRow ||
      text(node.code_cell) !== `B${sourceRow}` ||
      text(node.label_cell) !== `D${sourceRow}` ||
      text(node.label) !== text(templateRow?.intalev_label) ||
      !Number.isInteger(Number(node.indent_units)) ||
      Number(node.indent_units) !== actualIndentUnits ||
      actualIndentUnits % 2 !== 0 ||
      !Number.isInteger(Number(node.outline_level)) ||
      Number(node.outline_level) !== actualIndentUnits / 2 ||
      declaredParent !== derivedParent ||
      !exactArray(node.path_codes, expectedParentPath) ||
      !exactArray(node.path_labels, expectedLabelPath)
    ) {
      block("BLOCKED_INTALEV_REFERENCE_GRAPH_NODE_MISMATCH", {
        index,
        expected_code: expectedCode,
        template_code: templateRow?.code ?? null,
        node,
        actual_indent_units: actualIndentUnits,
        derived_parent_code: derivedParent,
        declared_parent_code: declaredParent,
        expected_parent_path: expectedParentPath,
        expected_label_path: expectedLabelPath,
      });
    }
    if (
      derivedParentNode &&
      Number(node.outline_level) <= Number(derivedParentNode.outline_level)
    ) {
      block("BLOCKED_INTALEV_REFERENCE_GRAPH_OUTLINE_MISMATCH", {
        code: expectedCode,
        parent_code: derivedParent,
        parent_outline_level: derivedParentNode.outline_level,
        outline_level: node.outline_level,
      });
    }
    nodesByCode.set(expectedCode, node);
    indentStack.push(node);
  }

  return Object.freeze({
    status: "PASS_APPROVED_INTALEV_TEMPLATE_GRAPH",
    schema: document.schema,
    graph_id: text(document.graph_id),
    graph_path: path.resolve(graphPath),
    graph_sha256: normalizedGraphSha256,
    template_path: path.resolve(templatePath),
    template_sha256: normalizedTemplateSha256,
    source_sheet: document.source.sheet,
    source_range: document.source.range,
    source_basis: document.source.structure_basis,
    approval: Object.freeze({ ...document.approval }),
    nodes_by_code: nodesByCode,
  });
}

export async function loadApprovedIntalevTemplateGraph({
  graphPath,
  expectedGraphSha256,
  templatePath,
  templateSha256,
  templateRows,
}) {
  const resolvedGraphPath = path.resolve(graphPath);
  const bytes = await fs.readFile(resolvedGraphPath);
  const actualGraphSha256 = crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex")
    .toUpperCase();
  const expected = text(expectedGraphSha256).toUpperCase();
  if (!SHA256_PATTERN.test(expected) || actualGraphSha256 !== expected) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_DRIFT", {
      graph_path: resolvedGraphPath,
      expected_sha256: expected,
      actual_sha256: actualGraphSha256,
    });
  }
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_JSON", {
      graph_path: resolvedGraphPath,
      reason: error?.message ?? "INVALID_JSON",
    });
  }
  return validateApprovedIntalevTemplateGraph({
    document,
    graphPath: resolvedGraphPath,
    graphSha256: actualGraphSha256,
    templatePath,
    templateSha256,
    templateRows,
  });
}

export function attachApprovedIntalevTemplateGraph(templateRows, graphProof) {
  if (graphProof?.status !== "PASS_APPROVED_INTALEV_TEMPLATE_GRAPH") {
    block("BLOCKED_INTALEV_REFERENCE_GRAPH_NOT_VALIDATED", {
      status: graphProof?.status ?? null,
    });
  }
  return templateRows.map((row) => {
    const node = graphProof.nodes_by_code.get(text(row.code));
    if (!node) {
      const { intalev_label_raw: _raw, ...cleanRow } = row;
      return {
        ...cleanRow,
        intalev_reference_status: "HIERARCHY_UNPROVEN",
        intalev_reference_reason: "REFERENCE_GRAPH_NODE_MISSING",
      };
    }
    const { intalev_label_raw: _raw, ...cleanRow } = row;
    return {
      ...cleanRow,
      intalev_source_parent_code: text(node.parent_code),
      intalev_source_outline_level: Number(node.outline_level),
      intalev_source_outline_basis: "APPROVED_INTALEV_TEMPLATE_GRAPH",
      intalev_reference_status: "PROVEN_APPROVED_TEMPLATE_GRAPH",
      intalev_reference_parent_code: text(node.parent_code),
      intalev_reference_outline_level: Number(node.outline_level),
      intalev_reference_path_codes: [...node.path_codes],
      intalev_reference_path_labels: [...node.path_labels],
      intalev_reference_graph_id: graphProof.graph_id,
      intalev_reference_graph_sha256: graphProof.graph_sha256,
      intalev_reference_template_sha256: graphProof.template_sha256,
      intalev_reference_source_sheet: graphProof.source_sheet,
      intalev_reference_source_row: Number(node.source_row),
      intalev_reference_source_cell: text(node.label_cell),
      intalev_reference_code_cell: text(node.code_cell),
      intalev_reference_basis: graphProof.source_basis,
    };
  });
}

export function serializeApprovedIntalevTemplateGraph(graphProof) {
  if (!graphProof) return null;
  return {
    status: graphProof.status,
    schema: graphProof.schema,
    graph_id: graphProof.graph_id,
    graph_path: graphProof.graph_path,
    graph_sha256: graphProof.graph_sha256,
    template_path: graphProof.template_path,
    template_sha256: graphProof.template_sha256,
    source_sheet: graphProof.source_sheet,
    source_range: graphProof.source_range,
    source_basis: graphProof.source_basis,
    approval: { ...graphProof.approval },
    nodes: graphProof.nodes_by_code.size,
    erp_used: false,
  };
}
