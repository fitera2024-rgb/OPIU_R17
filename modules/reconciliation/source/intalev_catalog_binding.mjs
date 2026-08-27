import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { detectIntalevCatalogHeaders } from "./intalev_catalog_parser.mjs";

const DEFAULT_LIMITS = Object.freeze({
  max_entries: 10_000,
  max_uncompressed_bytes: 512 * 1024 * 1024,
  max_entry_uncompressed_bytes: 256 * 1024 * 1024,
  max_compression_ratio: 1_000,
  max_archive_depth: 4,
});

export class IntalevCatalogBindingError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${JSON.stringify(details)}`);
    this.name = "IntalevCatalogBindingError";
    this.code = code;
    this.details = details;
  }
}

function block(code, details = {}) {
  throw new IntalevCatalogBindingError(code, details);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex").toUpperCase();
}

function portable(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function safeArchivePath(value) {
  const raw = portable(value);
  const parts = raw.split("/");
  const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
  if (
    !raw ||
    raw.startsWith("/") ||
    /^[A-Za-z]:/.test(raw) ||
    parts.some((part) =>
      !part ||
      part === "." ||
      part === ".." ||
      /[<>:"|?*\u0000-\u001F]/.test(part) ||
      /[. ]$/.test(part) ||
      windowsReserved.test(part),
    )
  ) return null;
  return parts.join("/");
}

function canonicalEntryKey(value) {
  return portable(value).normalize("NFC").toLocaleLowerCase("en-US");
}

function normalizedLimits(limits = {}) {
  const result = { ...DEFAULT_LIMITS, ...limits };
  for (const field of ["max_entries", "max_uncompressed_bytes", "max_entry_uncompressed_bytes"]) {
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", { limit: field, reason: "INVALID_LIMIT" });
    }
  }
  if (
    typeof result.max_compression_ratio !== "number" ||
    !Number.isFinite(result.max_compression_ratio) ||
    result.max_compression_ratio < 1
  ) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
      limit: "max_compression_ratio",
      reason: "INVALID_LIMIT",
    });
  }
  if (!Number.isSafeInteger(result.max_archive_depth) || result.max_archive_depth < 0) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
      limit: "max_archive_depth",
      reason: "INVALID_LIMIT",
    });
  }
  return result;
}

function preflightCentralDirectory(bytes, archivePath, state, limits) {
  const minimumEocdSize = 22;
  const maximumCommentSize = 0xffff;
  const earliest = Math.max(0, bytes.length - minimumEocdSize - maximumCommentSize);
  let eocdOffset = -1;
  for (let offset = bytes.length - minimumEocdSize; offset >= earliest; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + minimumEocdSize + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      archive_path: archivePath,
      reason: "END_OF_CENTRAL_DIRECTORY_MISSING",
    });
  }
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const diskEntries = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      archive_path: archivePath,
      reason: "MULTI_DISK_OR_ZIP64_UNSUPPORTED",
    });
  }
  if (state.entries + totalEntries > limits.max_entries) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
      limit: "entries",
      archive_path: archivePath,
      phase: "CENTRAL_DIRECTORY_PREFLIGHT",
      actual: state.entries + totalEntries,
      maximum: limits.max_entries,
    });
  }
  const centralEnd = centralOffset + centralSize;
  if (centralOffset > eocdOffset || centralEnd !== eocdOffset) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      archive_path: archivePath,
      reason: "CENTRAL_DIRECTORY_BOUNDS_INVALID",
    });
  }
  let offset = centralOffset;
  let uncompressedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
        archive_path: archivePath,
        reason: "CENTRAL_DIRECTORY_ENTRY_INVALID",
        entry_index: index,
      });
    }
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
        archive_path: archivePath,
        reason: "ZIP64_ENTRY_UNSUPPORTED",
        entry_index: index,
      });
    }
    if (uncompressedSize > limits.max_entry_uncompressed_bytes) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
        limit: "entry_uncompressed_bytes",
        archive_path: archivePath,
        entry_index: index,
        actual: uncompressedSize,
        maximum: limits.max_entry_uncompressed_bytes,
      });
    }
    const ratio = compressedSize === 0
      ? (uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
      : uncompressedSize / compressedSize;
    if (ratio > limits.max_compression_ratio) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
        limit: "compression_ratio",
        archive_path: archivePath,
        entry_index: index,
        actual: ratio,
        maximum: limits.max_compression_ratio,
      });
    }
    uncompressedBytes += uncompressedSize;
    if (!Number.isSafeInteger(uncompressedBytes)) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
        limit: "uncompressed_bytes",
        archive_path: archivePath,
        reason: "SIZE_OVERFLOW",
      });
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
    if (offset > centralEnd) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
        archive_path: archivePath,
        reason: "CENTRAL_DIRECTORY_ENTRY_BOUNDS_INVALID",
        entry_index: index,
      });
    }
  }
  if (offset !== centralEnd) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      archive_path: archivePath,
      reason: "CENTRAL_DIRECTORY_SIZE_MISMATCH",
    });
  }
  state.entries += totalEntries;
  state.bytes += uncompressedBytes;
  assertLimits(state, limits, { archive_path: archivePath, phase: "CENTRAL_DIRECTORY_PREFLIGHT" });
  return { totalEntries, uncompressedBytes };
}

let crc32Table = null;

function crc32(bytes) {
  if (!crc32Table) {
    crc32Table = Array.from({ length: 256 }, (_, value) => {
      let current = value;
      for (let bit = 0; bit < 8; bit += 1) {
        current = (current >>> 1) ^ ((current & 1) ? 0xedb88320 : 0);
      }
      return current >>> 0;
    });
  }
  let result = 0xffffffff;
  for (const value of bytes) {
    result = (result >>> 8) ^ crc32Table[(result ^ value) & 0xff];
  }
  return (result ^ 0xffffffff) >>> 0;
}

function assertArchiveEntryCardinality(preflight, zip, archivePath) {
  const centralCount = preflight.totalEntries;
  const materializedCount = Object.keys(zip.files).length;
  if (centralCount !== materializedCount) {
    block("BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE", {
      reason: "ARCHIVE_DUPLICATE_ENTRY",
      archive_path: archivePath,
      central_directory_entries: centralCount,
      materialized_entries: materializedCount,
    });
  }
}

function validatedArchiveEntries(zip, archivePath) {
  const seen = new Map();
  const result = [];
  const entries = Object.entries(zip.files).sort(([left], [right]) =>
    left.localeCompare(right, "en"));
  for (const [entryName, entry] of entries) {
    const isDirectory = entry.dir || entryName.endsWith("/");
    const rawOriginalName = portable(entry.unsafeOriginalName ?? entryName);
    const rawNormalizedName = portable(entryName);
    const originalName = isDirectory && rawOriginalName.endsWith("/")
      ? rawOriginalName.slice(0, -1)
      : rawOriginalName;
    const normalizedName = isDirectory && rawNormalizedName.endsWith("/")
      ? rawNormalizedName.slice(0, -1)
      : rawNormalizedName;
    const safeName = safeArchivePath(originalName);
    if (!safeName || safeName !== normalizedName) {
      block("BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE", {
        reason: "ARCHIVE_TRAVERSAL_OR_REWRITE",
        archive_path: archivePath,
        entry_path: originalName,
        normalized_path: entryName,
      });
    }
    const parts = safeName.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index + 1).join("/");
      const key = canonicalEntryKey(prefix);
      const kind = index === parts.length - 1 && !isDirectory ? "file" : "directory";
      const previous = seen.get(key);
      if (previous && (previous.path !== prefix || previous.kind !== kind)) {
        block("BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE", {
          reason: "ARCHIVE_PATH_COLLISION",
          archive_path: archivePath,
          entries: [previous.path, prefix],
          kinds: [previous.kind, kind],
        });
      }
      if (!previous) seen.set(key, { path: prefix, kind });
    }
    if (isDirectory) continue;
    result.push({ entry, safeName });
  }
  return result;
}

function pathStaysWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function rejectReparsePoint(filePath, rootRealPath = null) {
  const lstat = await fs.lstat(filePath);
  if (lstat.isSymbolicLink()) {
    block("BLOCKED_SOURCE_PROOF_REPARSE_POINT", { path: filePath });
  }
  const realPath = await fs.realpath(filePath);
  if (rootRealPath && !pathStaysWithin(rootRealPath, realPath)) {
    block("BLOCKED_SOURCE_PROOF_REPARSE_POINT", {
      path: filePath,
      real_path: realPath,
      root_real_path: rootRealPath,
    });
  }
  return { lstat, realPath };
}

async function scanDirectory(root, limits) {
  const resolvedRoot = path.resolve(root);
  const rootEvidence = await rejectReparsePoint(resolvedRoot);
  if (!rootEvidence.lstat.isDirectory()) {
    block("BLOCKED_SOURCE_NOT_FILE_OR_DIRECTORY", { path: resolvedRoot });
  }
  const files = [];
  const records = [];
  const state = { entries: 0, bytes: 0 };
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      state.entries += 1;
      assertLimits(state, limits, { path: filePath, phase: "DIRECTORY_SCAN" });
      const evidence = await rejectReparsePoint(filePath, rootEvidence.realPath);
      const relative = portable(path.relative(resolvedRoot, filePath));
      if (evidence.lstat.isDirectory()) {
        records.push({ kind: "directory", relative });
        await visit(filePath);
      } else if (evidence.lstat.isFile()) {
        state.bytes += evidence.lstat.size;
        assertLimits(state, limits, { path: filePath, phase: "DIRECTORY_SCAN" });
        records.push({ kind: "file", relative, size: evidence.lstat.size });
        files.push(filePath);
      } else {
        block("BLOCKED_SOURCE_PROOF_REPARSE_POINT", {
          path: filePath,
          reason: "UNSUPPORTED_FILESYSTEM_ENTRY",
        });
      }
    }
  }
  await visit(resolvedRoot);
  return {
    files,
    records,
    entry_count: state.entries,
    file_count: files.length,
    size: state.bytes,
    real_path: rootEvidence.realPath,
  };
}

async function sourceDescriptor(sourcePath, limits) {
  const resolved = path.resolve(sourcePath);
  const evidence = await rejectReparsePoint(resolved);
  if (evidence.lstat.isFile()) {
    return {
      path: resolved,
      real_path: evidence.realPath,
      kind: "file",
      size: evidence.lstat.size,
      sha256: await sha256File(resolved),
    };
  }
  if (!evidence.lstat.isDirectory()) block("BLOCKED_SOURCE_NOT_FILE_OR_DIRECTORY", { path: resolved });
  const scan = await scanDirectory(resolved, limits);
  const aggregate = crypto.createHash("sha256");
  for (const record of scan.records) {
    if (record.kind === "directory") {
      aggregate.update(`directory\0${record.relative}\n`, "utf8");
      continue;
    }
    const filePath = path.join(resolved, ...record.relative.split("/"));
    const fileStat = await fs.stat(filePath);
    const hash = await sha256File(filePath);
    aggregate.update(`file\0${record.relative}\0${fileStat.size}\0${hash}\n`, "utf8");
  }
  return {
    path: resolved,
    real_path: scan.real_path,
    kind: "directory-tree-v1",
    size: scan.size,
    entry_count: scan.entry_count,
    file_count: scan.file_count,
    sha256: aggregate.digest("hex").toUpperCase(),
  };
}

function sameDescriptor(left, right) {
  return left?.kind === right?.kind && left?.size === right?.size && left?.sha256 === right?.sha256;
}

function assertLimits(state, limits, details) {
  if (state.entries > limits.max_entries) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", { limit: "entries", ...details });
  }
  if (state.bytes > limits.max_uncompressed_bytes) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", { limit: "uncompressed_bytes", ...details });
  }
}

async function readBoundedEntry(entry, details) {
  const declaredSize = Number(entry?._data?.uncompressedSize);
  const hasDeclaredSize = Number.isSafeInteger(declaredSize) && declaredSize >= 0;
  if (!hasDeclaredSize) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      reason: "UNCOMPRESSED_SIZE_MISSING",
      ...details,
    });
  }
  const bytes = await entry.async("nodebuffer");
  if (hasDeclaredSize && bytes.length !== declaredSize) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      reason: "UNCOMPRESSED_SIZE_MISMATCH",
      declared_size: declaredSize,
      actual_size: bytes.length,
      ...details,
    });
  }
  const declaredCrc32 = Number(entry?._data?.crc32);
  if (Number.isInteger(declaredCrc32) && crc32(bytes) !== (declaredCrc32 >>> 0)) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      reason: "CRC32_MISMATCH",
      ...details,
    });
  }
  return bytes;
}

const OOXML_PREFLIGHT = Object.freeze({
  POSSIBLE_SCHEMA: "POSSIBLE_SCHEMA",
  FULLY_DECODED_NO_SCHEMA: "FULLY_DECODED_NO_SCHEMA",
  UNKNOWN: "UNKNOWN",
});

const OOXML_PREFLIGHT_MAX_PART_BYTES = 128 * 1024 * 1024;
const OOXML_PREFLIGHT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function decodeXmlEntities(value) {
  const source = String(value ?? "");
  if (/&(?!#x[0-9a-f]+;|#[0-9]+;|amp;|apos;|gt;|lt;|quot;)/i.test(source)) {
    throw new Error("OOXML_ENTITY_UNSUPPORTED");
  }
  return source.replace(
    /&(?:#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi,
    (entity) => {
      const key = entity.slice(1, -1).toLocaleLowerCase("en-US");
      if (key === "amp") return "&";
      if (key === "apos") return "'";
      if (key === "gt") return ">";
      if (key === "lt") return "<";
      if (key === "quot") return '"';
      const codePoint = key.startsWith("#x")
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error("OOXML_ENTITY_UNSUPPORTED");
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function xmlAttribute(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(attributes ?? "").match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
  );
  return match ? decodeXmlEntities(match[2]) : null;
}

function xmlElements(xml, localName) {
  const prefix = "(?:[A-Za-z_][\\w.-]*:)?";
  const expression = new RegExp(
    `<${prefix}${localName}\\b([^>]*)\\/>|<${prefix}${localName}\\b([^>]*)>([\\s\\S]*?)<\\/${prefix}${localName}\\s*>`,
    "gi",
  );
  const result = [];
  let match;
  while ((match = expression.exec(xml)) !== null) {
    result.push({ attributes: match[1] ?? match[2] ?? "", body: match[3] ?? "" });
  }
  const openings = xml.match(new RegExp(`<${prefix}${localName}\\b`, "gi"))?.length ?? 0;
  return result.length === openings ? result : null;
}

function wellFormedSupportedXml(source) {
  const stack = [];
  const tag = /<([^>]+)>/g;
  let cursor = 0;
  let match;
  while ((match = tag.exec(source)) !== null) {
    decodeXmlEntities(source.slice(cursor, match.index));
    cursor = tag.lastIndex;
    const token = match[1].trim();
    if (/^\?xml\b[^?]*\?$/i.test(token)) continue;
    if (token.startsWith("?") || token.startsWith("!")) return false;
    const closing = token.startsWith("/");
    const selfClosing = !closing && token.endsWith("/");
    const body = token.slice(closing ? 1 : 0, selfClosing ? -1 : undefined).trim();
    const nameMatch = body.match(/^([A-Za-z_][\w.:-]*)([\s\S]*)$/);
    if (!nameMatch) return false;
    const name = nameMatch[1];
    if (closing) {
      if (nameMatch[2].trim() || stack.pop() !== name) return false;
      continue;
    }
    let attributes = nameMatch[2];
    const attribute = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/;
    while (attributes.length > 0) {
      if (!attributes.trim()) break;
      const attributeMatch = attributes.match(attribute);
      if (!attributeMatch) return false;
      decodeXmlEntities(attributeMatch[3]);
      attributes = attributes.slice(attributeMatch[0].length);
    }
    if (!selfClosing) stack.push(name);
  }
  decodeXmlEntities(source.slice(cursor));
  return stack.length === 0 && !source.slice(cursor).includes("<");
}

function supportedXmlDocument(xml, rootName) {
  const source = String(xml ?? "").replace(/^\uFEFF/, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return false;
  const declaration = source.match(/^\s*<\?xml\b([^?]*)\?>/i);
  const encoding = declaration ? xmlAttribute(declaration[1], "encoding") : null;
  if (encoding && !/^utf-?8$/i.test(encoding)) return false;
  const prefix = "(?:[A-Za-z_][\\w.-]*:)?";
  return wellFormedSupportedXml(source) &&
    new RegExp(`<${prefix}${rootName}\\b`, "i").test(source) &&
    new RegExp(`<\\/${prefix}${rootName}\\s*>`, "i").test(source);
}

function xmlTextNodes(fragment) {
  const elements = xmlElements(fragment, "t");
  if (!elements) return null;
  if (elements.some((item) => /<[^>]+>/.test(item.body))) return null;
  return elements.map((item) => decodeXmlEntities(item.body)).join("");
}

function sharedStringsFromXml(xml) {
  if (!supportedXmlDocument(xml, "sst")) return null;
  const items = xmlElements(xml, "si");
  if (!items) return null;
  const result = [];
  for (const item of items) {
    const value = xmlTextNodes(item.body);
    if (value === null) return null;
    result.push(value);
  }
  return result;
}

function rowContainsCatalogHeader(values) {
  return detectIntalevCatalogHeaders([values], 1).headerRowIndex === 0;
}

function worksheetCatalogPreflight(xml, sharedStrings) {
  if (!supportedXmlDocument(xml, "worksheet")) return OOXML_PREFLIGHT.UNKNOWN;
  const sheetData = xmlElements(xml, "sheetData");
  if (!sheetData || sheetData.length !== 1) return OOXML_PREFLIGHT.UNKNOWN;
  const rows = xmlElements(sheetData[0].body, "row");
  if (!rows) return OOXML_PREFLIGHT.UNKNOWN;
  let previousRow = 0;
  for (const row of rows) {
    const rowAttribute = xmlAttribute(row.attributes, "r");
    if (!/^\d+$/.test(rowAttribute ?? "")) return OOXML_PREFLIGHT.UNKNOWN;
    const rowNumber = Number.parseInt(rowAttribute, 10);
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= previousRow) {
      return OOXML_PREFLIGHT.UNKNOWN;
    }
    previousRow = rowNumber;
    if (rowNumber > 15) continue;
    const cells = xmlElements(row.body, "c");
    if (!cells) return OOXML_PREFLIGHT.UNKNOWN;
    const values = [];
    for (const cell of cells) {
      const type = xmlAttribute(cell.attributes, "t") ?? "n";
      const valueElements = xmlElements(cell.body, "v");
      if (!valueElements || valueElements.length > 1) return OOXML_PREFLIGHT.UNKNOWN;
      if (type === "s") {
        if (valueElements.length !== 1 || !sharedStrings) return OOXML_PREFLIGHT.UNKNOWN;
        const indexText = decodeXmlEntities(valueElements[0].body);
        if (!/^\d+$/.test(indexText)) return OOXML_PREFLIGHT.UNKNOWN;
        const index = Number.parseInt(indexText, 10);
        if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
          return OOXML_PREFLIGHT.UNKNOWN;
        }
        values.push(sharedStrings[index]);
      } else if (type === "inlineStr") {
        const inlineStrings = xmlElements(cell.body, "is");
        if (!inlineStrings || inlineStrings.length !== 1) return OOXML_PREFLIGHT.UNKNOWN;
        const value = xmlTextNodes(inlineStrings[0].body);
        if (value === null) return OOXML_PREFLIGHT.UNKNOWN;
        values.push(value);
      } else if (["str", "n", "b", "e", "d"].includes(type)) {
        if (valueElements.some((item) => /<[^>]+>/.test(item.body))) {
          return OOXML_PREFLIGHT.UNKNOWN;
        }
        values.push(valueElements.length === 1
          ? decodeXmlEntities(valueElements[0].body)
          : "");
      } else {
        return OOXML_PREFLIGHT.UNKNOWN;
      }
    }
    if (rowContainsCatalogHeader(values)) return OOXML_PREFLIGHT.POSSIBLE_SCHEMA;
  }
  return OOXML_PREFLIGHT.FULLY_DECODED_NO_SCHEMA;
}

function uniqueZipEntry(zip, lowerName) {
  const matches = Object.entries(zip.files).filter(([name, entry]) =>
    !entry.dir && portable(name).toLocaleLowerCase("en-US") === lowerName);
  return matches.length === 1 ? matches[0][1] : null;
}

async function readOoxmlXmlPart(entry, budget) {
  const declaredSize = Number(entry?._data?.uncompressedSize);
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize < 0 ||
    declaredSize > OOXML_PREFLIGHT_MAX_PART_BYTES ||
    budget.bytes + declaredSize > OOXML_PREFLIGHT_MAX_TOTAL_BYTES
  ) return null;
  budget.bytes += declaredSize;
  return entry.async("string");
}

async function intalevCatalogOoxmlPreflight(bytes) {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const contentTypes = uniqueZipEntry(zip, "[content_types].xml");
    const workbook = uniqueZipEntry(zip, "xl/workbook.xml");
    const workbookRelationships = uniqueZipEntry(zip, "xl/_rels/workbook.xml.rels");
    const worksheetEntries = Object.entries(zip.files)
      .filter(([name, entry]) =>
        !entry.dir && /^xl\/worksheets\/[^/]+\.xml$/i.test(portable(name)))
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    if (!contentTypes || !workbook || !workbookRelationships || worksheetEntries.length === 0) {
      return OOXML_PREFLIGHT.UNKNOWN;
    }
    const budget = { bytes: 0 };
    const [contentTypesXml, workbookXml, relationshipsXml] = await Promise.all([
      readOoxmlXmlPart(contentTypes, budget),
      readOoxmlXmlPart(workbook, budget),
      readOoxmlXmlPart(workbookRelationships, budget),
    ]);
    if (
      !supportedXmlDocument(contentTypesXml, "Types") ||
      !supportedXmlDocument(workbookXml, "workbook") ||
      !supportedXmlDocument(relationshipsXml, "Relationships")
    ) return OOXML_PREFLIGHT.UNKNOWN;
    const workbookSheets = xmlElements(workbookXml, "sheet");
    if (!workbookSheets || workbookSheets.length !== worksheetEntries.length) {
      return OOXML_PREFLIGHT.UNKNOWN;
    }
    const sharedStringsEntry = Object.entries(zip.files).find(([name, entry]) =>
      !entry.dir && portable(name).toLocaleLowerCase("en-US") === "xl/sharedstrings.xml")?.[1] ?? null;
    const sharedStringsXml = sharedStringsEntry
      ? await readOoxmlXmlPart(sharedStringsEntry, budget)
      : null;
    const sharedStrings = sharedStringsEntry ? sharedStringsFromXml(sharedStringsXml) : [];
    if (sharedStringsEntry && !sharedStrings) return OOXML_PREFLIGHT.UNKNOWN;
    for (const [, worksheetEntry] of worksheetEntries) {
      const worksheetXml = await readOoxmlXmlPart(worksheetEntry, budget);
      if (worksheetXml === null) return OOXML_PREFLIGHT.UNKNOWN;
      const result = worksheetCatalogPreflight(worksheetXml, sharedStrings);
      if (result !== OOXML_PREFLIGHT.FULLY_DECODED_NO_SCHEMA) return result;
    }
    return OOXML_PREFLIGHT.FULLY_DECODED_NO_SCHEMA;
  } catch {
    return OOXML_PREFLIGHT.UNKNOWN;
  }
}

async function writeCandidate(bytes, workDir, ordinal) {
  const hash = sha256(bytes);
  const target = path.join(workDir, `intalev_catalog_candidate_${String(ordinal).padStart(4, "0")}_${hash.slice(0, 12)}.xlsx`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx" });
  return { target, hash };
}

async function inspectWorkbook({ bytes, sourcePath, provenance, probeWorkbook, workDir, candidates, ordinal }) {
  const workbookBytes = bytes ?? await fs.readFile(sourcePath);
  const preflight = await intalevCatalogOoxmlPreflight(workbookBytes);
  if (preflight === OOXML_PREFLIGHT.FULLY_DECODED_NO_SCHEMA) return;
  const materialized = bytes
    ? await writeCandidate(workbookBytes, workDir, ordinal)
    : { target: sourcePath, hash: await sha256File(sourcePath) };
  const stat = await fs.stat(materialized.target);
  let parsed;
  try {
    parsed = await probeWorkbook(materialized.target, ordinal);
  } catch {
    return;
  }
  const afterHash = await sha256File(materialized.target);
  if (afterHash !== materialized.hash) {
    block("SOURCE_DRIFT", { phase: "CATALOG_PROBE", path: materialized.target });
  }
  if (
    parsed?.structured_parent_export === true &&
    parsed?.hierarchy_tree?.status === "PASS" &&
    parsed?.entries?.length > 0
  ) {
    candidates.push({
      source_path: materialized.target,
      parsed,
      provenance: {
        ...provenance,
        size: stat.size,
        sha256: materialized.hash,
        hash_stable: true,
        tree_status: parsed.hierarchy_tree.status,
        node_count: parsed.entries.length,
        sheet: parsed.sheet,
      },
    });
  }
}

async function scanArchive({
  bytes,
  archivePath,
  archiveChain,
  entryPathPrefix,
  depth,
  context,
}) {
  if (depth > context.limits.max_archive_depth) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", { limit: "archive_depth", archive_path: archivePath });
  }
  const archiveSha256 = sha256(bytes);
  const preflight = preflightCentralDirectory(
    bytes,
    archivePath,
    context.state,
    context.limits,
  );
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", { archive_path: archivePath, reason: error?.message });
  }
  assertArchiveEntryCardinality(preflight, zip, archivePath);
  for (const { entry, safeName } of validatedArchiveEntries(zip, archivePath)) {
    const entryBytes = await readBoundedEntry(
      entry,
      { archive_path: archivePath, entry_path: safeName },
    );
    const fullEntryPath = [...entryPathPrefix, safeName].join("!/");
    const lower = safeName.toLocaleLowerCase("en-US");
    if (lower.endsWith(".zip")) {
      await scanArchive({
        bytes: entryBytes,
        archivePath: fullEntryPath,
        archiveChain: [...archiveChain, {
          depth: archiveChain.length,
          entry_path: safeName,
          full_entry_path: fullEntryPath,
          size: entryBytes.length,
          sha256: sha256(entryBytes),
          archive_sha256: archiveSha256,
        }],
        entryPathPrefix: [...entryPathPrefix, safeName],
        depth: depth + 1,
        context,
      });
    } else if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
      context.ordinal += 1;
      await inspectWorkbook({
        bytes: entryBytes,
        provenance: {
          selection_mode: "AUTO_DETECTED_CONTAINER",
          source_kind: "ARCHIVE_ENTRY",
          entry_path: fullEntryPath,
          archive_entry_path: safeName,
          archive_sha256: archiveSha256,
          archive_chain: archiveChain,
        },
        probeWorkbook: context.probeWorkbook,
        workDir: context.workDir,
        candidates: context.candidates,
        ordinal: context.ordinal,
      });
    }
  }
}

export async function discoverIntalevArticleCatalog({ sourcePath, workDir, probeWorkbook, limits = {} }) {
  const resolved = path.resolve(sourcePath);
  const effectiveLimits = normalizedLimits(limits);
  const before = await sourceDescriptor(resolved, effectiveLimits);
  const container = {
    path: before.path,
    real_path: before.real_path,
    kind: before.kind,
    size: before.size,
    entry_count: before.entry_count ?? null,
    file_count: before.file_count ?? null,
    sha256: before.sha256,
  };
  const context = {
    limits: effectiveLimits,
    state: { entries: 0, bytes: 0 },
    probeWorkbook,
    workDir,
    candidates: [],
    ordinal: 0,
  };
  let directoryScan = null;
  const stat = await fs.stat(resolved);
  if (stat.isFile() && /\.zip$/i.test(resolved)) {
    if (stat.size > effectiveLimits.max_uncompressed_bytes) {
      block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
        limit: "compressed_container_bytes",
        path: resolved,
      });
    }
    const bytes = await fs.readFile(resolved);
    await scanArchive({
      bytes,
      archivePath: resolved,
      archiveChain: [{
        depth: 0,
        entry_path: path.basename(resolved),
        full_entry_path: path.basename(resolved),
        source_path: resolved,
        size: bytes.length,
        sha256: sha256(bytes),
        archive_sha256: null,
      }],
      entryPathPrefix: [],
      depth: 0,
      context,
    });
  } else if (stat.isDirectory()) {
    directoryScan = await scanDirectory(resolved, effectiveLimits);
    const { files } = directoryScan;
    for (const filePath of files) {
      const relative = portable(path.relative(resolved, filePath));
      const lower = relative.toLocaleLowerCase("en-US");
      if (lower.endsWith(".zip")) {
        const archiveStat = await fs.stat(filePath);
        if (archiveStat.size > effectiveLimits.max_uncompressed_bytes) {
          block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
            limit: "compressed_container_bytes",
            path: relative,
          });
        }
        const archiveBytes = await fs.readFile(filePath);
        await scanArchive({
          bytes: archiveBytes,
          archivePath: relative,
          archiveChain: [{
            depth: 0,
            entry_path: relative,
            full_entry_path: relative,
            source_path: filePath,
            size: archiveBytes.length,
            sha256: sha256(archiveBytes),
            archive_sha256: null,
          }],
          entryPathPrefix: [],
          depth: 0,
          context,
        });
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
        context.ordinal += 1;
        await inspectWorkbook({
          sourcePath: filePath,
          provenance: {
            selection_mode: "AUTO_DETECTED_CONTAINER",
            source_kind: "DIRECTORY_ENTRY",
            entry_path: relative,
            archive_entry_path: null,
            archive_sha256: null,
            archive_chain: [],
          },
          probeWorkbook,
          workDir,
          candidates: context.candidates,
          ordinal: context.ordinal,
        });
      }
    }
  }
  const after = await sourceDescriptor(resolved, effectiveLimits);
  if (!sameDescriptor(before, after)) {
    block("SOURCE_DRIFT", { phase: "CATALOG_CONTAINER_SCAN", before, after });
  }
  if (context.candidates.length > 1) {
    block("BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE", {
      role: "intalev_uid",
      candidates: context.candidates.map((candidate) => candidate.provenance),
    });
  }
  const selected = context.candidates[0]
    ? {
        ...context.candidates[0],
        provenance: {
          ...context.candidates[0].provenance,
          container,
        },
      }
    : null;
  return {
    status: context.candidates.length === 1
      ? "PASS_EXACTLY_ONE_STRUCTURAL_CLASSIFIER"
      : "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
    selected,
    candidate_count: context.candidates.length,
    container_before: before,
    scan_limits: effectiveLimits,
    scan_totals: directoryScan
      ? { entries: directoryScan.entry_count, bytes: directoryScan.size }
      : { ...context.state },
  };
}

export async function assertIntalevCatalogBindingUnchanged(discovery) {
  if (!discovery?.selected) return discovery;
  const selectedHash = await sha256File(discovery.selected.source_path);
  const containerAfter = await sourceDescriptor(
    discovery.container_before.path,
    normalizedLimits(discovery.scan_limits ?? {}),
  );
  if (
    selectedHash !== discovery.selected.provenance.sha256 ||
    !sameDescriptor(discovery.container_before, containerAfter)
  ) {
    block("SOURCE_DRIFT", {
      phase: "CATALOG_FINAL_REHASH",
      selected_before: discovery.selected.provenance.sha256,
      selected_after: selectedHash,
      container_before: discovery.container_before,
      container_after: containerAfter,
    });
  }
  return {
    ...discovery,
    status: "PASS_EXACTLY_ONE_STRUCTURAL_CLASSIFIER_REHASHED",
    selected: {
      ...discovery.selected,
      provenance: {
        ...discovery.selected.provenance,
        sha256_after: selectedHash,
        container_sha256: containerAfter.sha256,
        container_size: containerAfter.size,
        container: {
          ...discovery.selected.provenance.container,
          real_path_after: containerAfter.real_path,
          size_after: containerAfter.size,
          sha256_after: containerAfter.sha256,
          hash_stable: true,
          status: "PASS_CONTAINER_REHASHED",
        },
        status: "PASS_RUN_BOUND_INTALEV_UID_REHASHED",
      },
    },
  };
}

export async function extractZipArchiveSafely(sourcePath, destinationDir, limits = {}) {
  const effectiveLimits = normalizedLimits(limits);
  const sharedState = limits.state ?? { entries: 0, bytes: 0 };
  const sourceEvidence = await rejectReparsePoint(path.resolve(sourcePath));
  if (!sourceEvidence.lstat.isFile()) {
    block("BLOCKED_SOURCE_NOT_FILE_OR_DIRECTORY", { path: sourcePath });
  }
  const sourceStat = sourceEvidence.lstat;
  if (sourceStat.size > effectiveLimits.max_uncompressed_bytes) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT", {
      limit: "compressed_container_bytes",
      path: sourcePath,
    });
  }
  const bytes = await fs.readFile(sourcePath);
  const beforeHash = sha256(bytes);
  const preflight = preflightCentralDirectory(
    bytes,
    sourcePath,
    sharedState,
    effectiveLimits,
  );
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    block("BLOCKED_SOURCE_PROOF_ARCHIVE_INVALID", {
      archive_path: sourcePath,
      reason: error?.message,
    });
  }
  assertArchiveEntryCardinality(preflight, zip, sourcePath);
  const root = path.resolve(destinationDir);
  const extracted = [];
  const entries = validatedArchiveEntries(zip, sourcePath);
  await fs.mkdir(root, { recursive: true });
  for (const { entry, safeName } of entries) {
    const entryBytes = await readBoundedEntry(
      entry,
      { archive_path: sourcePath, entry_path: safeName },
    );
    const target = path.resolve(root, ...safeName.split("/"));
    if (!target.startsWith(`${root}${path.sep}`)) block("BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE", { entry_path: safeName });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entryBytes, { flag: "wx" });
    extracted.push(target);
  }
  if (await sha256File(sourcePath) !== beforeHash) block("SOURCE_DRIFT", { phase: "ARCHIVE_EXTRACTION", path: sourcePath });
  return extracted;
}
