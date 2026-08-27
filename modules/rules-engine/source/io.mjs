import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function readJson(filePath, { optional = false } = {}) {
  if (!filePath) {
    if (optional) return null;
    throw new Error("JSON path is required");
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw new Error(`Cannot read JSON ${filePath}: ${error.message}`);
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, filePath);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function exists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").toUpperCase();
}

export function sha256Json(value) {
  return sha256Text(stableStringify(value));
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function utcNow() {
  return new Date().toISOString();
}

export function safeId(value, fallbackPrefix = "ID") {
  const cleaned = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned) return cleaned;
  return `${fallbackPrefix}-${Date.now()}`;
}

export function resolveFrom(baseDir, maybeRelative) {
  if (!maybeRelative) return "";
  return path.isAbsolute(maybeRelative) ? path.normalize(maybeRelative) : path.resolve(baseDir, maybeRelative);
}
