import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectOwnerEconomicDecisions } from "./owner_decision_projection.mjs";
import { appendOwnerDecisionExplanationSheet } from "./owner_decision_xlsx.mjs";
import { loadEconomicRouteProofDocument } from "./economic_route_proof_binding.mjs";
import { materializeStructuralControlSettingsForRun } from "./structural_control_settings_binding.mjs";
import { materializeStructuralControlInventoryV3 } from "./structural_control_inventory_v3.mjs";
import { buildAuthoritativeStructuralControlInventoryHierarchyPeriod } from "./structural_control_authoritative_candidates.mjs";
import {
  OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION,
  isOwnerPresentationBlockExempt,
} from "./owner_presentation_block_exemption.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_SCRIPT = path.join(MODULE_DIR, "opiu_reconcile.mjs");
const POLICY_PATH = path.join(MODULE_DIR, "owner_decision_policy.json");
const OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY = path.join(MODULE_DIR, "owner_economic_route_proofs");

export function resolveDefaultStructuralControlSettingsCsv(moduleDir = MODULE_DIR) {
  const moduleProductRoot = path.resolve(moduleDir, "..", "..", "..");
  const packageRoot = path.basename(moduleProductRoot).toLowerCase() === "runtime"
    ? path.dirname(moduleProductRoot)
    : moduleProductRoot;
  return path.join(packageRoot, "user-settings", "Настройка_группировки_блоков.csv");
}

const DEFAULT_STRUCTURAL_CONTROL_SETTINGS_CSV = resolveDefaultStructuralControlSettingsCsv();

function text(value) { return String(value ?? "").trim(); }
function normalizedText(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function uniqueTracePaths(trace) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(trace) ? trace : []) {
    const fullPath = normalizedText(item?.full_path);
    if (!fullPath || seen.has(fullPath)) continue;
    seen.add(fullPath);
    result.push(fullPath);
  }
  return result;
}

function blockedStructuralInventoryPeriod(period) {
  throw new Error(`BLOCKED_STRUCTURAL_CONTROL_INVENTORY_PERIOD_BINDING:${normalizedText(period)}`);
}

export function authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload = {}) {
  const hierarchyPeriods = Array.isArray(payload?.hierarchy_periods)
    ? payload.hierarchy_periods
    : [];
  const periodRows = Array.isArray(payload?.period_rows) ? payload.period_rows : [];
  const rowsByPeriod = new Map();
  for (const month of periodRows) {
    const period = normalizedText(month?.period);
    if (!period || rowsByPeriod.has(period)) blockedStructuralInventoryPeriod(period);
    rowsByPeriod.set(period, month);
  }

  const usedPeriods = new Set();
  const projection = hierarchyPeriods.map((hierarchyPeriod) => {
    const period = normalizedText(hierarchyPeriod?.period);
    const month = rowsByPeriod.get(period);
    if (!period || !month || usedPeriods.has(period)) blockedStructuralInventoryPeriod(period);
    usedPeriods.add(period);
    return buildAuthoritativeStructuralControlInventoryHierarchyPeriod({
      ...month,
      period,
      rows: (month.rows ?? []).map((row) => ({
        ...row,
        intalev_amount: row?.intalev_amount
          ?? (typeof row?.intalev === "number" ? row.intalev : row?.intalev?.amount),
        erp_amount: row?.erp_amount
          ?? (typeof row?.erp === "number" ? row.erp : row?.erp?.amount),
        erp_paths: row?.erp_paths ?? uniqueTracePaths(row?.erp?.trace),
      })),
    }, hierarchyPeriod);
  });

  const extraPeriod = [...rowsByPeriod.keys()].find((period) => !usedPeriods.has(period));
  if (extraPeriod) blockedStructuralInventoryPeriod(extraPeriod);
  return projection;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}
async function sha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex").toUpperCase();
}
async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function pathKind(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function selectOwnerEconomicRouteProof({
  organization,
  period,
  directory = OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY,
} = {}) {
  const runOrganization = text(organization);
  const runPeriod = text(period);
  if (!runOrganization || !runPeriod) {
    return Object.freeze({ status: "RUN_SCOPE_INCOMPLETE", path: "", document: null });
  }
  const kind = await pathKind(directory);
  if (kind === "missing") {
    return Object.freeze({ status: "NO_CONFIG_DIRECTORY", path: "", document: null });
  }
  if (kind !== "directory") throw new Error(`OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY_INVALID:${path.resolve(directory)}`);
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const matches = [];
  for (const entry of entries) {
    const proofPath = path.join(directory, entry.name);
    const document = await loadEconomicRouteProofDocument(proofPath);
    if (document.organization === runOrganization && document.period === runPeriod) {
      matches.push({ path: path.resolve(proofPath), document });
    }
  }
  if (matches.length > 1) {
    throw new Error(`OWNER_ECONOMIC_ROUTE_PROOF_DUPLICATE_SCOPE:${runOrganization}|${runPeriod}`);
  }
  if (matches.length === 0) {
    return Object.freeze({ status: "NO_EXACT_SCOPE", path: "", document: null });
  }
  return Object.freeze({ status: "EXACT_SCOPE_SELECTED", ...matches[0] });
}

export async function coreArgsWithOwnerEconomicRouteProof(argv, {
  directory = OWNER_ECONOMIC_ROUTE_PROOF_DIRECTORY,
} = {}) {
  const args = parseArgs(argv);
  if (text(args["economic-route-proofs"])) {
    return Object.freeze({
      argv: Object.freeze([...argv]),
      selection: Object.freeze({ status: "EXPLICIT_CLI_PROOF", path: path.resolve(args["economic-route-proofs"]) }),
    });
  }
  const selection = await selectOwnerEconomicRouteProof({
    organization: args.organization,
    period: args.period,
    directory,
  });
  const result = [...argv];
  if (selection.path) result.push("--economic-route-proofs", selection.path);
  return Object.freeze({ argv: Object.freeze(result), selection });
}

export async function coreArgsWithUserStructuralControlSettings(argv, {
  csvPath = process.env.OPIU_STRUCTURAL_CONTROL_SETTINGS_CSV || DEFAULT_STRUCTURAL_CONTROL_SETTINGS_CSV,
} = {}) {
  const args = parseArgs(argv);
  if (text(args["structural-control-settings"])) {
    return Object.freeze({
      argv: Object.freeze([...argv]),
      selection: Object.freeze({ status: "EXPLICIT_CLI_SETTINGS", path: path.resolve(args["structural-control-settings"]) }),
    });
  }
  const kind = await pathKind(csvPath);
  if (kind === "missing") {
    return Object.freeze({ argv: Object.freeze([...argv]), selection: Object.freeze({ status: "NO_USER_CSV", path: "" }) });
  }
  if (kind !== "file") throw new Error(`STRUCTURAL_CONTROL_SETTINGS_CSV_INVALID:${path.resolve(csvPath)}`);
  const reportPath = text(args.output) ? path.resolve(args.output) : "";
  if (!reportPath) throw new Error("OWNER_DECISION_R005_OUTPUT_REQUIRED");
  const settingsPath = reportPath.replace(/\.xlsx$/i, ".structural-control-settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const selection = await materializeStructuralControlSettingsForRun({
    csvPath,
    organization: args.organization,
    period: args.period,
    outputPath: settingsPath,
  });
  const result = [...argv];
  if (selection.path) result.push("--structural-control-settings", selection.path);
  return Object.freeze({ argv: Object.freeze(result), selection });
}
function nonzeroRows(payload) {
  const structuralControlGroups = closedStructuralControlGroups(payload);
  const partitions = Array.isArray(payload?.period_rows) && payload.period_rows.length > 0
    ? payload.period_rows
    : [{ period: text(payload?.period), rows: payload?.rows ?? [] }];
  return partitions.flatMap((partition) => (partition?.rows ?? [])
    .filter((row) =>
      !isOwnerPresentationBlockExempt(row, structuralControlGroups) &&
      typeof row?.delta === "number" &&
      Number.isFinite(row.delta) &&
      Math.abs(row.delta) > 0.009)
    .map((row) => ({ period: text(partition.period), code: text(row.code) })));
}

export function closedStructuralControlGroups(payload = {}) {
  const closedIds = new Set((Array.isArray(payload?.structural_group_control_results)
    ? payload.structural_group_control_results
    : [])
    .filter((result) => text(result?.classification) === "STRUCTURAL_GROUP_SUM_OK")
    .map((result) => text(result?.group_id ?? result?.control_set_id))
    .filter(Boolean));
  return (Array.isArray(payload?.structural_group_control_sets)
    ? payload.structural_group_control_sets
    : [])
    .filter((group) => closedIds.has(text(group?.group_id ?? group?.id)));
}
function linkedCaseIds(projection, period, code) {
  return projection?.period_row_links?.[period]?.[code]
    ?? projection?.row_links?.[code]
    ?? projection?.row_links?.[`${period}|${code}`]
    ?? [];
}
function rowCoverage(projection, period, code) {
  return projection?.period_row_coverage?.[period]?.[code]
    ?? projection?.owner_projection_coverage?.[code]
    ?? projection?.owner_projection_coverage?.[`${period}|${code}`]
    ?? null;
}
function explicitlyBlockedNonfinancial(projection, period, code) {
  const coverage = rowCoverage(projection, period, code);
  return coverage?.coverage_status === "EXPLICIT_NONFINANCIAL_BLOCKED"
    && Boolean(text(coverage?.causal_blocker))
    && coverage?.financial_rows === 0
    && coverage?.posting_rows === 0;
}
function nonzeroCodes(payload) {
  return nonzeroRows(payload).map((row) => `${row.period}|${row.code}`);
}
function caseSummary(projection) {
  return (projection?.cases ?? []).map((decisionCase) => ({
    case_id: decisionCase.case_id,
    pair_id: decisionCase.pair_id,
    classification: decisionCase.classification,
    decision_type: decisionCase.decision_type,
    amount: decisionCase.amount,
    status_text: decisionCase.status_text,
    proof_status: decisionCase.proof_status,
    period: decisionCase.period,
    member_rows: decisionCase.member_rows,
  }));
}

export async function enrichOwnerDecisionOutputs({ reportPath, codexPath, manifestPath = "", policyPath = POLICY_PATH } = {}) {
  if (!reportPath || !codexPath) throw new Error("OWNER_DECISION_OUTPUT_PATH_REQUIRED");
  const [payloadText, policyText] = await Promise.all([fs.readFile(codexPath, "utf8"), fs.readFile(policyPath, "utf8")]);
  const payload = JSON.parse(payloadText.replace(/^\uFEFF/, ""));
  const policy = JSON.parse(policyText.replace(/^\uFEFF/, ""));
  const projection = projectOwnerEconomicDecisions(payload, { ownerAcceptancePolicy: policy?.accepted_classification_gaps ?? [] });
  const missing = nonzeroRows(payload).filter((row) =>
    !linkedCaseIds(projection, row.period, row.code).length
      && !explicitlyBlockedNonfinancial(projection, row.period, row.code));
  if (missing.length) {
    throw new Error(`OWNER_DECISION_UNCOVERED_NONZERO:${missing.map((row) =>
      `${row.period}|${row.code}`).join(",")}`);
  }
  if (projection.safety?.posting_rows !== 0 || projection.safety?.add_one_side_rows !== 0 || projection.safety?.storno_rows !== 0 || projection.safety?.repost_rows !== 0 || projection.safety?.execution_allowed !== false) {
    throw new Error("OWNER_DECISION_SAFETY_NOT_FAIL_CLOSED");
  }

  const worksheet = await appendOwnerDecisionExplanationSheet(reportPath, payload, projection);
  const reportSha = await sha256(reportPath);
  const byCase = new Map((projection.cases ?? []).map((decisionCase) => [decisionCase.case_id, decisionCase]));
  payload.owner_decisions = {
    ...projection,
    policy_sha256: crypto.createHash("sha256").update(policyText).digest("hex").toUpperCase(),
    explanation_sheet: worksheet.sheet_name,
  };
  const closedGroups = closedStructuralControlGroups(payload);
  payload.rows = (payload.rows ?? []).map((row) => {
    const presentationBlockExempt = isOwnerPresentationBlockExempt(
      row,
      closedGroups,
    );
    const caseIds = [...new Set((projection.cases ?? [])
      .filter((decisionCase) => (decisionCase.member_rows ?? []).some((member) => text(member.code) === text(row.code)))
      .map((decisionCase) => decisionCase.case_id))];
    const cases = caseIds.map((caseId) => byCase.get(caseId)).filter(Boolean);
    const coverage = rowCoverage(projection, text(row?.period), text(row?.code));
    return {
      ...row,
      owner_presentation_block_exempt: presentationBlockExempt,
      owner_control_classification: presentationBlockExempt
        ? OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION
        : "",
      owner_case_ids: caseIds,
      owner_decision_classes: cases.map((decisionCase) => decisionCase.classification),
      owner_decision_statuses: cases.map((decisionCase) => decisionCase.status_text),
      owner_decision_proof_statuses: cases.map((decisionCase) => decisionCase.proof_status),
      owner_decision_reasons: cases.map((decisionCase) => decisionCase.reason),
      owner_decision_solutions: cases.map((decisionCase) => decisionCase.solution),
      owner_projection_coverage_status: coverage?.coverage_status ?? "",
      owner_projection_causal_blocker: coverage?.causal_blocker ?? "",
    };
  });
  payload.report_sha256 = reportSha;
  await writeJson(codexPath, payload);
  const codexSha = await sha256(codexPath);

  let structuralInventory = null;
  if (manifestPath) {
    try {
      const manifest = JSON.parse((await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
      manifest.output_sha256 = reportSha;
      manifest.codex_input_sha256 = codexSha;
      manifest.owner_decisions = {
        schema: projection.schema,
        case_count: projection.cases.length,
        mapped_nonzero_rows: nonzeroRows(payload).length,
        owner_case_mapped_nonzero_rows: nonzeroRows(payload).filter((row) =>
          linkedCaseIds(projection, row.period, row.code).length > 0).length,
        explicitly_blocked_nonfinancial_rows: nonzeroRows(payload).filter((row) =>
          explicitlyBlockedNonfinancial(projection, row.period, row.code)).length,
        owner_projection_coverage: projection.owner_projection_coverage,
        presentation_block_exempt_rows:
          projection.presentation_block_exemptions?.length ?? 0,
        cases: caseSummary(projection),
        safety: projection.safety,
        explanation_sheet: worksheet.sheet_name,
      };
      await writeJson(manifestPath, manifest);
      const structuralPlan = payload?.structural_control_inventory;
      if (text(structuralPlan?.schema_version) === "opiu-structural-control-inventory.v3") {
        structuralInventory = await materializeStructuralControlInventoryV3({
          outputDirectory: path.dirname(reportPath),
          runId: structuralPlan.run_id,
          contextId: structuralPlan.context_id,
          organization: structuralPlan.organization,
          reconciliationOrganizationName: payload.organization,
          period: payload.period,
          hierarchyPeriods: authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload),
          generatedAt: payload.generated_at,
          currentRunFiles: {
            reportPath,
            codexInputPath: codexPath,
            manifestPath,
          },
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    projection,
    report_sha256: reportSha,
    codex_sha256: codexSha,
    explanation_sheet: worksheet.sheet_name,
    structural_control_inventory: structuralInventory?.audit ?? null,
  };
}

async function runCore(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CORE_SCRIPT, ...argv], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`R005_CORE_FAILED:${signal || code}`)));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const reportPath = text(args.output) ? path.resolve(args.output) : "";
  if (!reportPath) throw new Error("OWNER_DECISION_R005_OUTPUT_REQUIRED");
  const proofInput = await coreArgsWithOwnerEconomicRouteProof(argv);
  const structuralInput = await coreArgsWithUserStructuralControlSettings(proofInput.argv);
  await runCore(structuralInput.argv);
  const codexPath = reportPath.replace(/\.xlsx$/i, ".codex-input.json");
  const manifestPath = reportPath.replace(/\.xlsx$/i, ".manifest.json");
  const result = await enrichOwnerDecisionOutputs({ reportPath, codexPath, manifestPath });
  console.log(JSON.stringify({
    owner_decision_wrapper: "R005",
    cases: result.projection.cases.length,
    mapped_nonzero_rows: nonzeroCodes(JSON.parse(await fs.readFile(codexPath, "utf8"))).length,
    presentation_block_exempt_rows:
      result.projection.presentation_block_exemptions?.length ?? 0,
    add_one_side_rows: 0,
    posting_rows: 0,
    report_sha256: result.report_sha256,
    codex_sha256: result.codex_sha256,
    explanation_sheet: result.explanation_sheet,
    structural_control_inventory: result.structural_control_inventory,
    economic_route_proof_selection: {
      status: proofInput.selection.status,
      path: proofInput.selection.path || "",
    },
    structural_control_settings_selection: {
      status: structuralInput.selection.status,
      path: structuralInput.selection.path || "",
    },
  }));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) {
  await main();
}
