import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
