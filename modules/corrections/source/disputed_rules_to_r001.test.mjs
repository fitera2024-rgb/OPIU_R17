import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("production R001 entrypoints have no Rules application or decision authority", async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const [wrapper, core, facade] = await Promise.all([
    fs.readFile(path.join(sourceDir, "service_r001_owner_wrapper.mjs"), "utf8"),
    fs.readFile(path.join(sourceDir, "correction_engine_r001.mjs"), "utf8"),
    fs.readFile(path.join(sourceDir, "r001_handoff_input.mjs"), "utf8"),
  ]);
  for (const source of [wrapper, core]) {
    assert.doesNotMatch(source, /rules-engine\/source|--applications|--decisions|--rules/u);
  }
  assert.match(wrapper, /--handoff/u);
  assert.match(wrapper, /--handoff-sha256/u);
  assert.match(core, /args\.handoff/u);
  assert.match(core, /args\["handoff-sha256"\]/u);
  assert.match(facade, /R001_APPLICATIONS_INPUT_FORBIDDEN/u);
});
