import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNoDirectR001Overrides, verifyServiceR001Handoff } from "./service_r005_r001_handoff.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE_SCRIPT = path.join(MODULE_DIR, "correction_engine_r001.mjs");

function text(value) { return String(value ?? "").trim(); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`R001_POSITIONAL_ARGUMENT_FORBIDDEN:${value}`);
    const key = value.slice(2);
    if (Object.hasOwn(result, key)) throw new Error(`R001_DUPLICATE_ARGUMENT_FORBIDDEN:${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

export async function prepareOwnerR001Input({ handoffPath, handoffSha256 } = {}) {
  return verifyServiceR001Handoff({ handoffPath, handoffSha256 });
}

function inheritedModuleResolutionArgs(argv = process.execArgv) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (["--experimental-loader", "--loader", "--import", "--require"].includes(value)) {
      result.push(value, argv[index + 1]);
      index += 1;
    } else if (/^--(?:experimental-loader|loader|import|require)=/u.test(value)) result.push(value);
  }
  return result;
}

export async function runCore(prepared, { outputDir } = {}) {
  const coreArgs = [
    "--handoff", prepared.handoffPath,
    "--handoff-sha256", prepared.handoffSha256,
    "--output", path.resolve(outputDir || "./outputs"),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...inheritedModuleResolutionArgs(), CORE_SCRIPT, ...coreArgs], {
      stdio: ["ignore", "pipe", "inherit"], env: process.env,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      const value = chunk.toString("utf8");
      stdout += value;
      process.stdout.write(value);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) return reject(new Error(`R001_CORE_FAILED:${signal || code}`));
      const marker = '{\n  "runDir"';
      const start = stdout.lastIndexOf(marker);
      if (start < 0) return reject(new Error("R001_CORE_RESULT_MISSING"));
      try { resolve(JSON.parse(stdout.slice(start).trim())); }
      catch (error) { reject(new Error(`R001_CORE_RESULT_INVALID:${error.message}`)); }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNoDirectR001Overrides(args);
  for (const key of Object.keys(args)) {
    if (!["handoff", "handoff-sha256", "output"].includes(key)) throw new Error(`R001_ARGUMENT_FORBIDDEN:${key}`);
  }
  const handoffPath = text(args.handoff || process.env.OPIU_R001_HANDOFF_PATH);
  const handoffSha256 = text(args["handoff-sha256"] || process.env.OPIU_R001_HANDOFF_SHA256);
  const outputDir = text(args.output) ? path.resolve(args.output) : path.resolve("./outputs");
  const prepared = await prepareOwnerR001Input({ handoffPath, handoffSha256 });
  // Verify again immediately before crossing the wrapper→core boundary.
  await verifyServiceR001Handoff({ handoffPath: prepared.handoffPath, handoffSha256: prepared.handoffSha256 });
  const coreResult = await runCore(prepared, { outputDir });
  console.log(JSON.stringify({
    owner_decision_wrapper: "R001_DIRECT_SERVICE_HANDOFF",
    source_run_id: prepared.sourceRunId,
    service_handoff: { path: prepared.handoffPath, sha256: prepared.handoffSha256 },
    posting_rows: coreResult.posting_rows,
    materialized_posting_rows: coreResult.materialized_posting_rows,
    executed_posting_rows: coreResult.executed_posting_rows,
    live_posting_rows: coreResult.live_posting_rows,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
  }));
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "")) await main();
