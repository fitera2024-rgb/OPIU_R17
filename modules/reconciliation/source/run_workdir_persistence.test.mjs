import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { persistImmutableErpJournalEvidence } from "./run_workdir.mjs";

function journalEvidence(journalPath, sha256) {
  return {
    applicable: true,
    organization: "9 Управляющая компания",
    period: "2025-10",
    sources: { erp: { path: journalPath, sha256, sheet: "Лист_1" } },
  };
}

test("R005 journal survives temporary workDir cleanup for the Service handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-handoff-"));
  const workDir = path.join(root, "temporary-work");
  const runDir = path.join(root, "service-run", "r005");
  const journalPath = path.join(workDir, "erp_archives", "journal.xlsx");
  const journalBytes = Buffer.from("synthetic physical ERP journal\n", "utf8");
  const journalSHA256 = crypto.createHash("sha256").update(journalBytes).digest("hex").toUpperCase();
  const crossJournalEvidence = journalEvidence(journalPath, journalSHA256);

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

test("R005 journal persistence rejects conflicting immutable bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-r005-handoff-conflict-"));
  const runDir = path.join(root, "service-run", "r005");
  const outputPath = path.join(runDir, "reconciliation.xlsx");
  const firstWorkDir = path.join(root, "first-work");
  const firstJournalPath = path.join(firstWorkDir, "erp_archives", "journal.xlsx");
  const firstBytes = Buffer.from("first immutable ERP journal\n", "utf8");
  const firstSHA256 = crypto.createHash("sha256").update(firstBytes).digest("hex").toUpperCase();
  await fs.mkdir(path.dirname(firstJournalPath), { recursive: true });
  await fs.writeFile(firstJournalPath, firstBytes);
  await persistImmutableErpJournalEvidence({
    workDir: firstWorkDir,
    outputPath,
    crossJournalEvidence: journalEvidence(firstJournalPath, firstSHA256),
    operationEvidence: null,
  });

  const secondWorkDir = path.join(root, "second-work");
  const secondJournalPath = path.join(secondWorkDir, "erp_archives", "journal.xlsx");
  const secondBytes = Buffer.from("conflicting ERP journal\n", "utf8");
  const secondSHA256 = crypto.createHash("sha256").update(secondBytes).digest("hex").toUpperCase();
  await fs.mkdir(path.dirname(secondJournalPath), { recursive: true });
  await fs.writeFile(secondJournalPath, secondBytes);
  await assert.rejects(
    () => persistImmutableErpJournalEvidence({
      workDir: secondWorkDir,
      outputPath,
      crossJournalEvidence: journalEvidence(secondJournalPath, secondSHA256),
      operationEvidence: null,
    }),
    /immutable copy already differs/,
  );
  assert.equal(await fs.readFile(path.join(runDir, "physical-evidence", "erp-journal.xlsx"), "utf8"), firstBytes.toString("utf8"));
});
