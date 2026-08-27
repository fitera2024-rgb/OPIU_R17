import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function authorityError(code, message, detail = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.detail = detail;
  return error;
}

function normalizeSha256(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-F0-9]{64}$/.test(normalized) ? normalized : "";
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export async function verifyErpInputAuthority({
  sourcePath,
  expectedSha256,
  requirePin = false,
}) {
  const resolvedPath = path.resolve(String(sourcePath ?? ""));
  const expected = normalizeSha256(expectedSha256);
  if (requirePin && !expected) {
    throw authorityError(
      "BLOCKED_ERP_SOURCE_AUTHORITY_UNPINNED",
      "для расчета нужно явно закрепить SHA-256 текущего ERP-пакета через --erp-sha256",
      { input_path: resolvedPath },
    );
  }

  const stat = await fs.stat(resolvedPath);
  if (!stat.isFile()) {
    if (expected || requirePin) {
      throw authorityError(
        "BLOCKED_ERP_SOURCE_AUTHORITY_NOT_A_FILE",
        "закрепление SHA-256 поддерживается только для одного ERP-файла или ZIP-пакета",
        { input_path: resolvedPath },
      );
    }
    return {
      status: "UNPINNED_DIRECTORY_INPUT",
      input_path: resolvedPath,
      expected_sha256: "",
      actual_sha256: "",
      pinned: false,
    };
  }

  const actual = await sha256File(resolvedPath);
  if (expected && actual !== expected) {
    throw authorityError(
      "BLOCKED_ERP_SOURCE_HASH_MISMATCH",
      "SHA-256 выбранного ERP-источника не совпадает с закрепленным текущим пакетом",
      {
        input_path: resolvedPath,
        expected_sha256: expected,
        actual_sha256: actual,
      },
    );
  }

  return {
    status: expected ? "PASS_ERP_SOURCE_AUTHORITY_PINNED" : "UNPINNED_FILE_INPUT",
    input_path: resolvedPath,
    expected_sha256: expected,
    actual_sha256: actual,
    pinned: Boolean(expected),
  };
}

export function selectAuthoritativeErpCandidate({ period, candidates, metadataFor }) {
  const eligible = Array.isArray(candidates) ? candidates : [];
  if (eligible.length === 1) return eligible[0];

  const detail = eligible.map((candidate) => {
    const metadata = metadataFor(candidate) ?? {};
    return {
      source_file: candidate.sourceFile,
      input_path: metadata.inputPath ?? "",
      input_modified: metadata.inputModified ?? "",
      source_kind: metadata.sourceKind ?? "",
      periods: candidate.periods ?? [],
    };
  });
  if (eligible.length === 0) {
    throw authorityError(
      "BLOCKED_ERP_SOURCE_MISSING",
      `для ${period} не найден ERP ОПИУ с доказанной организацией и периодом`,
      { period, candidates: detail },
    );
  }
  throw authorityError(
    "BLOCKED_ERP_SOURCE_CONFLICT",
    `для ${period} найдено ${eligible.length} различных ERP ОПИУ; выбор по имени, месячности или дате файла запрещен`,
    { period, candidates: detail },
  );
}
