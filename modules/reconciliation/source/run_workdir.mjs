import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[A-F0-9]{64}$/u;

function text(value) {
  return String(value ?? "").trim();
}

function normalizedPath(value) {
  return path.resolve(text(value));
}

function pathInside(root, candidate) {
  const relative = path.relative(normalizedPath(root), normalizedPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function writeImmutableBytes(filePath, bytes) {
  const resolved = normalizedPath(filePath);
  const existing = await fs.lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("R005 persistent ERP journal target is not a regular file");
    }
    const existingBytes = await fs.readFile(resolved);
    if (existingBytes.equals(bytes)) return;
    throw new Error("R005 persistent ERP journal immutable copy already differs");
  }

  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("R005 persistent ERP journal directory is not canonical");
  }
  const temporary = path.join(parent, `.erp-journal-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    const handle = await fs.open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, resolved);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const racedBytes = await fs.readFile(resolved);
      if (!racedBytes.equals(bytes)) {
        throw new Error("R005 persistent ERP journal immutable copy already differs");
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function journalCandidate(crossJournalEvidence, operationEvidence) {
  if (crossJournalEvidence?.applicable === true) {
    const source = crossJournalEvidence.sources?.erp;
    if (!source) throw new Error("R005 physical ERP journal binding is missing");
    return {
      path: source.path,
      sha256: source.sha256,
      sheet: source.sheet,
      sourceKind: "cross_journal_discrepancy_evidence",
    };
  }
  const journals = operationEvidence?.source_trace?.journals ?? operationEvidence?.journals;
  const journal = journals?.length === 1 ? journals[0] : null;
  if (journal) {
    return {
      path: journal.path,
      sha256: journal.sha256 ?? journal.journal_sha256,
      sheet: journal.sheet ?? journal.journal_sheet,
      sourceKind: "operation_evidence",
    };
  }
  const input = operationEvidence?.input;
  return operationEvidence?.journal_sha256 && input?.journal_source
    ? {
        path: input.journal_source,
        sha256: operationEvidence.journal_sha256,
        sheet: operationEvidence.journal_sheet,
        sourceKind: "operation_evidence",
      }
    : null;
}

function rebindJournalEvidencePaths(crossJournalEvidence, operationEvidence, sourcePath, targetPath) {
  const replace = (value) => normalizedPath(value) === sourcePath ? targetPath : value;
  if (crossJournalEvidence?.sources?.erp?.path) {
    crossJournalEvidence.sources.erp.path = replace(crossJournalEvidence.sources.erp.path);
  }
  if (operationEvidence?.input?.journal_source) {
    operationEvidence.input.journal_source = replace(operationEvidence.input.journal_source);
  }
  for (const journal of operationEvidence?.journals ?? []) {
    if (journal?.path) journal.path = replace(journal.path);
  }
  for (const journal of operationEvidence?.source_trace?.journals ?? []) {
    if (journal?.path) journal.path = replace(journal.path);
  }
  for (const binding of operationEvidence?.source_bindings ?? []) {
    if (binding?.journal_path) binding.journal_path = replace(binding.journal_path);
  }
  for (const binding of operationEvidence?.source_trace?.source_bindings ?? []) {
    if (binding?.journal_path) binding.journal_path = replace(binding.journal_path);
  }
  for (const row of operationEvidence?.rows ?? []) {
    if (row?.journal_source) row.journal_source = replace(row.journal_source);
  }
  for (const row of operationEvidence?.unassigned_rows ?? []) {
    if (row?.journal_source) row.journal_source = replace(row.journal_source);
  }
}

export async function createUniqueRunWorkDir(workRoot, dependencies = {}) {
  const resolvedRoot = path.resolve(workRoot);
  const now = dependencies.now ?? new Date();
  const pid = dependencies.pid ?? process.pid;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const runId = `${timestamp}_${pid}_${randomUUID()}`;
  const workDir = path.join(resolvedRoot, runId);

  await fs.mkdir(resolvedRoot, { recursive: true });
  await fs.mkdir(workDir, { recursive: false });

  return { runId, workDir };
}

export async function persistImmutableErpJournalEvidence({
  workDir,
  outputPath,
  crossJournalEvidence,
  operationEvidence,
} = {}) {
  const candidate = journalCandidate(crossJournalEvidence, operationEvidence);
  if (!candidate) return null;

  const sourcePath = normalizedPath(candidate.path);
  const expectedSHA256 = text(candidate.sha256).toUpperCase();
  const expectedSheet = text(candidate.sheet);
  if (!SHA256.test(expectedSHA256) || !expectedSheet) {
    throw new Error("R005 physical ERP journal proof is incomplete");
  }
  const sourceStat = await fs.lstat(sourcePath).catch(() => null);
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("R005 physical ERP journal source is missing or not regular");
  }
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceSHA256 = await sha256Bytes(sourceBytes);
  if (sourceSHA256 !== expectedSHA256) {
    throw new Error("R005 physical ERP journal source SHA-256 mismatch");
  }

  const targetPath = normalizedPath(path.join(path.dirname(normalizedPath(outputPath)), "physical-evidence", "erp-journal.xlsx"));
  if (pathInside(workDir, targetPath)) {
    throw new Error("R005 persistent ERP journal target is inside temporary workDir");
  }
  await writeImmutableBytes(targetPath, sourceBytes);
  const persistedBytes = await fs.readFile(targetPath);
  const persistedSHA256 = await sha256Bytes(persistedBytes);
  if (persistedSHA256 !== expectedSHA256 || !persistedBytes.equals(sourceBytes)) {
    throw new Error("R005 persistent ERP journal copy SHA-256 mismatch");
  }
  rebindJournalEvidencePaths(
    crossJournalEvidence,
    operationEvidence,
    sourcePath,
    targetPath,
  );
  return {
    path: targetPath,
    size: persistedBytes.length,
    sha256: persistedSHA256,
    sheet: expectedSheet,
    source_kind: candidate.sourceKind,
  };
}
