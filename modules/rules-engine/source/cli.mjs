#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runEngine } from "./engine.mjs";

function argsMap(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(value);
  }
  return out;
}

async function selfTest() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const sourceFixtures = path.join(here, "tests", "fixtures");
  const fixtureDir = await fs.access(sourceFixtures).then(() => sourceFixtures).catch(() => path.join(root, "tests", "fixtures"));
  const tempDir = path.join(root, ".self-test-output");
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  const context = JSON.parse(await fs.readFile(path.join(fixtureDir, "engine_context_after_r005.json"), "utf8"));
  context.paths.rules_registry = path.join(fixtureDir, "rules_registry.json");
  context.paths.r005_codex_input = path.join(fixtureDir, "r005_unknown_erp.codex-input.json");
  context.paths.r005_report = path.join(tempDir, "reconciliation.xlsx");
  context.paths.output_dir = tempDir;
  await fs.writeFile(context.paths.r005_report, "self-test reconciliation placeholder");
  const contextPath = path.join(tempDir, "context.json");
  await fs.writeFile(contextPath, JSON.stringify(context, null, 2));
  const result = await runEngine({ contextPath });
  if (result.workflow.next_action !== "WAIT_USER_RULES") throw new Error(`Expected WAIT_USER_RULES, got ${result.workflow.next_action}`);
  if (!result.candidates.length) throw new Error("No candidates produced");
  console.log(JSON.stringify({ ok: true, candidates: result.candidates.length, applications: result.applications.length, next_action: result.workflow.next_action, output: result.outputDir }, null, 2));
}

async function main() {
  const args = argsMap(process.argv.slice(2));
  const command = args._[0];
  if (command === "self-test") return selfTest();
  if (command === "run") {
    if (!args.context) throw new Error("Usage: node src/cli.mjs run --context <rules_engine_context.json> [--out <dir>]");
    const result = await runEngine({ contextPath: args.context, outputDirOverride: args.out || "" });
    console.log(JSON.stringify({ ok: true, next_action: result.workflow.next_action, output: result.outputDir, candidates: result.candidates.length, applications: result.applications.length }, null, 2));
    return;
  }
  console.log("Commands:\n  self-test\n  run --context <file> [--out <dir>]");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
