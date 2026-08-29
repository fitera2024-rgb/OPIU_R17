import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { persistImmutableErpJournalEvidence } from "./run_workdir.mjs";

test("R005 journal survives temporary workDir cleanup for the Service handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-handoff-"));
  const workDir = path.join(root, "temporary-work");
  const runDir = path.join(root, "service-run", "r005");
  const journalPath = path.join(workDir, "erp_archives", "journal.xlsx");
  const journalBytes = Buffer.from("synthetic physical ERP journal\n", "utf8");
  const journalSHA256 = crypto.createHash("sha256").update(journalBytes).digest("hex").toUpperCase();
  const crossJournalEvidence = {
    applicable: true,
    organization: "9 Управляющая компания",
    period: "2025-10",
    sources: {
      erp: { path: journalPath, sha256: journalSHA256, sheet: "Лист_1" },
    },
  };

  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.writeFile(journalPath, journalBytes);
  const result = await persistImmutableErpJournalEvidence({
    workDir,
    outputPath: path.join(runDir, "reconciliation.xlsx"),
    crossJournalEvidence,
    operationEvidence: null,
  });

  assert.equal(result.sha256, journalSHA256);
  assert.equal(result.sheet, "Лист_1");
  assert.equal(crossJournalEvidence.sources.erp.path, result.path);
  assert.ok(result.path.startsWith(path.resolve(runDir)));
  assert.ok(!result.path.startsWith(path.resolve(workDir)));

  await fs.rm(workDir, { recursive: true, force: true });
  assert.equal(await fs.readFile(result.path, "utf8"), journalBytes.toString("utf8"));
  assert.equal(
    crypto.createHash("sha256").update(await fs.readFile(result.path)).digest("hex").toUpperCase(),
    journalSHA256,
  );
});
