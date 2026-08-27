import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";

import {
  IntalevCatalogBindingError,
  assertIntalevCatalogBindingUnchanged,
  discoverIntalevArticleCatalog,
  extractZipArchiveSafely,
} from "./intalev_catalog_binding.mjs";
import { bindRunIntalevUidCatalog } from "./reference_catalog_manifest.mjs";

function validCatalog() {
  return {
    structured_parent_export: true,
    sheet: "Статьи БДР",
    entries: [{ uuid: "ROOT", parent_uuid: "", name: "Расходы" }],
    hierarchy_tree: { status: "PASS", blockers: [] },
  };
}

async function probeWorkbook(filePath) {
  const marker = (await fs.readFile(filePath, "utf8")).trim();
  return marker === "VALID_UUID_PARENT_NAME_TREE" ? validCatalog() : {
    structured_parent_export: false,
    entries: [],
    hierarchy_tree: { status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED" },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opiu-intalev-catalog-binding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeZip(filePath, entries) {
  const zip = new JSZip();
  for (const [name, value] of entries) zip.file(name, value);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function syntheticOoxmlWorkbook(headers, { malformedWorksheet = false } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Arbitrary" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`);
  const cells = headers.map((header, index) => {
    const column = String.fromCharCode("A".charCodeAt(0) + index);
    return `<c r="${column}1" t="inlineStr"><is><t>${header}</t></is></c>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData><row r="1">${cells}</row></sheetData>
    </worksheet>`;
  zip.file(
    "xl/worksheets/sheet1.xml",
    malformedWorksheet ? worksheet.replace("</worksheet>", "") : worksheet,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex").toUpperCase();
}

function duplicateOnlyCentralDirectoryEntry(bytes) {
  const eocdOffset = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocdOffset), 0x06054b50);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  assert.equal(entryCount, 1);
  const local = bytes.subarray(0, centralOffset);
  const central = bytes.subarray(centralOffset, centralOffset + centralSize);
  const eocd = Buffer.from(bytes.subarray(eocdOffset));
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(centralSize * 2, 12);
  return Buffer.concat([local, central, central, eocd]);
}

function corruptFirstStoredEntry(bytes) {
  const result = Buffer.from(bytes);
  assert.equal(result.readUInt32LE(0), 0x04034b50);
  const compressedSize = result.readUInt32LE(18);
  const fileNameLength = result.readUInt16LE(26);
  const extraLength = result.readUInt16LE(28);
  const dataOffset = 30 + fileNameLength + extraLength;
  assert.ok(compressedSize > 0);
  result[dataOffset] ^= 0xff;
  return result;
}

function corruptFirstLocalHeader(bytes) {
  const result = Buffer.from(bytes);
  assert.equal(result.readUInt32LE(0), 0x04034b50);
  result.writeUInt32LE(0, 0);
  return result;
}

test("content scan binds exactly one structurally valid classifier and records nested archive provenance", async (t) => {
  const root = await fixture(t);
  const outerPath = path.join(root, "intalev.zip");
  const nested = new JSZip();
  nested.file("catalog.xlsx", "VALID_UUID_PARENT_NAME_TREE");
  const nestedBytes = await nested.generateAsync({ type: "nodebuffer" });
  await writeZip(outerPath, [
    ["report.xlsx", "NOT_A_CLASSIFIER"],
    ["nested/package.zip", nestedBytes],
  ]);
  const discovery = await discoverIntalevArticleCatalog({
    sourcePath: outerPath,
    workDir: path.join(root, "work"),
    probeWorkbook,
  });
  assert.equal(discovery.status, "PASS_EXACTLY_ONE_STRUCTURAL_CLASSIFIER");
  assert.equal(discovery.candidate_count, 1);
  assert.equal(discovery.selected.provenance.entry_path, "nested/package.zip!/catalog.xlsx");
  assert.equal(discovery.selected.provenance.archive_chain.length, 2);
  assert.equal(discovery.selected.provenance.archive_chain[0].source_path, outerPath);
  assert.equal(discovery.selected.provenance.archive_chain[0].entry_path, "intalev.zip");
  assert.equal(
    discovery.selected.provenance.archive_chain[0].sha256,
    discovery.selected.provenance.container.sha256,
  );
  assert.equal(
    discovery.selected.provenance.archive_chain[1].full_entry_path,
    "nested/package.zip",
  );
  assert.equal(discovery.selected.provenance.container.path, outerPath);
  assert.equal(discovery.selected.provenance.container.real_path, await fs.realpath(outerPath));
  assert.equal(discovery.selected.provenance.container.kind, "file");
  assert.match(discovery.selected.provenance.archive_sha256, /^[A-F0-9]{64}$/);
  const final = await assertIntalevCatalogBindingUnchanged(discovery);
  assert.equal(final.selected.provenance.status, "PASS_RUN_BOUND_INTALEV_UID_REHASHED");
  assert.equal(final.selected.provenance.sha256, final.selected.provenance.sha256_after);
  assert.equal(final.selected.provenance.container.status, "PASS_CONTAINER_REHASHED");
  assert.equal(
    final.selected.provenance.container.sha256,
    final.selected.provenance.container.sha256_after,
  );
  assert.equal(final.selected.provenance.container.hash_stable, true);
});

test("zero valid classifiers preserves the existing missing-export blocker", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "intalev.zip");
  await writeZip(archive, [["report.xlsx", "NOT_A_CLASSIFIER"]]);
  const result = await discoverIntalevArticleCatalog({
    sourcePath: archive,
    workDir: path.join(root, "work"),
    probeWorkbook,
  });
  assert.equal(result.status, "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED");
  assert.equal(result.candidate_count, 0);
});

test("two structurally valid classifiers fail closed as ambiguous", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "intalev.zip");
  await writeZip(archive, [
    ["first.xlsx", "VALID_UUID_PARENT_NAME_TREE"],
    ["second.xlsx", "VALID_UUID_PARENT_NAME_TREE"],
  ]);
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: archive,
      workDir: path.join(root, "work"),
      probeWorkbook,
    }),
    (error) => error instanceof IntalevCatalogBindingError &&
      error.code === "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE",
  );
});

test("invalid classifier shape is not selected", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "intalev");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "looks-like-a-classifier.xlsx"), "INVALID_TREE");
  const result = await discoverIntalevArticleCatalog({
    sourcePath: directory,
    workDir: path.join(root, "work"),
    probeWorkbook,
  });
  assert.equal(result.candidate_count, 0);
});

test("directory discovery publishes the actual filesystem scan totals", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "intalev");
  const nested = path.join(directory, "nested");
  const classifier = "VALID_UUID_PARENT_NAME_TREE";
  const evidence = "supporting evidence";
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "catalog.xlsx"), classifier);
  await fs.writeFile(path.join(directory, "evidence.txt"), evidence);

  const result = await discoverIntalevArticleCatalog({
    sourcePath: directory,
    workDir: path.join(root, "work"),
    probeWorkbook,
  });

  assert.equal(result.status, "PASS_EXACTLY_ONE_STRUCTURAL_CLASSIFIER");
  assert.deepEqual(result.scan_totals, {
    entries: 3,
    bytes: Buffer.byteLength(classifier) + Buffer.byteLength(evidence),
  });
});

test("tri-state OOXML preflight reduces 67 and 7 file inventories to two full probes", async (t) => {
  for (const inventorySize of [67, 7]) {
    await t.test(`${inventorySize} XLSX`, async (t) => {
      const root = await fixture(t);
      const archive = path.join(root, `inventory-${inventorySize}.zip`);
      const noSchema = await syntheticOoxmlWorkbook(["Период", "Сумма"]);
      const possibleSchema = await syntheticOoxmlWorkbook([
        "UUID",
        "UUIDРодителя",
        "Наименование",
      ]);
      const skippedCount = inventorySize - 2;
      const entries = Array.from({ length: skippedCount }, (_, index) => [
        `a-report-${String(index + 1).padStart(3, "0")}.xlsx`,
        noSchema,
      ]);
      entries.push(["y-arbitrary-name.xlsx", possibleSchema]);
      entries.push(["z-unsupported.xlsx", "UNSUPPORTED_WORKBOOK_PROBE_REQUIRED"]);
      await writeZip(archive, entries);
      const observedOrdinals = [];
      const discovery = await discoverIntalevArticleCatalog({
        sourcePath: archive,
        workDir: path.join(root, "work"),
        probeWorkbook: async (_filePath, ordinal) => {
          observedOrdinals.push(ordinal);
          return ordinal === inventorySize - 1 ? validCatalog() : {
            structured_parent_export: false,
            entries: [],
            hierarchy_tree: { status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED" },
          };
        },
      });

      assert.deepEqual(observedOrdinals, [inventorySize - 1, inventorySize]);
      assert.equal(discovery.candidate_count, 1);
      assert.equal(discovery.selected.provenance.entry_path, "y-arbitrary-name.xlsx");
      assert.match(
        path.basename(discovery.selected.source_path),
        new RegExp(`candidate_${String(inventorySize - 1).padStart(4, "0")}_`),
      );
    });
  }
});

test("malformed and unsupported OOXML fall back to full probe while decoded no-schema skips", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "tri-state.zip");
  await writeZip(archive, [
    ["a-decoded-no-schema.xlsx", await syntheticOoxmlWorkbook(["Период", "Сумма"])],
    ["b-malformed.xlsx", await syntheticOoxmlWorkbook(["UUID"], { malformedWorksheet: true })],
    ["c-unsupported.xlsx", "NOT_AN_OOXML_PACKAGE"],
  ]);
  const observedOrdinals = [];
  const result = await discoverIntalevArticleCatalog({
    sourcePath: archive,
    workDir: path.join(root, "work"),
    probeWorkbook: async (_filePath, ordinal) => {
      observedOrdinals.push(ordinal);
      return {
        structured_parent_export: false,
        entries: [],
        hierarchy_tree: { status: "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED" },
      };
    },
  });
  assert.deepEqual(observedOrdinals, [2, 3]);
  assert.equal(result.candidate_count, 0);
});

test("preflight scans every possible schema and preserves fail-closed ambiguity", async (t) => {
  const root = await fixture(t);
  const archive = path.join(root, "ambiguous-preflight.zip");
  const noSchema = await syntheticOoxmlWorkbook(["Период", "Сумма"]);
  const possibleSchema = await syntheticOoxmlWorkbook(["Ссылка", "Родитель", "Наименование"]);
  await writeZip(archive, [
    ["a-no-schema.xlsx", noSchema],
    ["b-first-arbitrary.xlsx", possibleSchema],
    ["c-second-arbitrary.xlsx", possibleSchema],
  ]);
  const observedOrdinals = [];
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: archive,
      workDir: path.join(root, "work"),
      probeWorkbook: async (_filePath, ordinal) => {
        observedOrdinals.push(ordinal);
        return validCatalog();
      },
    }),
    (error) => error instanceof IntalevCatalogBindingError &&
      error.code === "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE",
  );
  assert.deepEqual(observedOrdinals, [2, 3]);
});

test("real Intalev inputs preserve exact classifier semantics when their SHA-256 is pinned", async (t) => {
  const inputs = [
    {
      label: "9 UK",
      sourcePath: path.join(
        os.homedir(),
        "Desktop",
        "ЦД_ЦЗ Фонд развития_Архив_Инталев_20250101_20251231.zip",
      ),
      sourceSha256: "3FA5D75ECA20920BC70DE59F17EDF19F4A1720D9B675EE8AAAEEDACA0BE5A340",
      entryPath: "ЦД_ЦЗ Фонд развития_Статьи_Классификатор_Статьи БДР.xlsx",
      candidateSha256: "D74F4DB8C359D490FC1DE7AA440AE073ECE78C23F430D28691D629193E8F9A75",
      ordinal: 66,
      nodeCount: 220,
    },
    {
      label: "3 Sakhalin",
      sourcePath: path.join(
        os.homedir(),
        "Desktop",
        "САХАЛИН",
        "ЦМД Сахалин_Архив_Инталев_20250101_20250131.zip",
      ),
      sourceSha256: "AE230FB3E960D1E36C0D2288A33831D6D4D74772C769E7603D6E20916DB49DE0",
      entryPath: "ЦМД Сахалин_Статьи_Классификатор_Статьи БДР.xlsx",
      candidateSha256: "13F2BFBC47213A31EF22971F78B5791561AA60360DD8EE1A28FE874597B36228",
      ordinal: 6,
      nodeCount: 219,
    },
  ];
  for (const input of inputs) {
    await t.test(input.label, async (t) => {
      try {
        await fs.access(input.sourcePath);
      } catch {
        t.skip("real control input is unavailable");
        return;
      }
      const actualSha256 = await sha256File(input.sourcePath);
      if (actualSha256 !== input.sourceSha256) {
        t.skip(`real control input SHA-256 differs: ${actualSha256}`);
        return;
      }
      const root = await fixture(t);
      const { parseIntalevArticleCatalog } = await import("./opiu_reconcile.mjs");
      const probedOrdinals = [];
      const discovery = await discoverIntalevArticleCatalog({
        sourcePath: input.sourcePath,
        workDir: path.join(root, "candidates"),
        probeWorkbook: async (candidatePath, ordinal) => {
          probedOrdinals.push(ordinal);
          return parseIntalevArticleCatalog(root, candidatePath, `real_smoke_${ordinal}`);
        },
      });
      assert.equal(discovery.status, "PASS_EXACTLY_ONE_STRUCTURAL_CLASSIFIER");
      assert.equal(discovery.candidate_count, 1);
      assert.equal(discovery.selected.provenance.entry_path, input.entryPath);
      assert.equal(discovery.selected.provenance.sha256, input.candidateSha256);
      assert.equal(discovery.selected.provenance.node_count, input.nodeCount);
      assert.equal(discovery.selected.provenance.sheet, "TDSheet");
      assert.deepEqual(probedOrdinals, [input.ordinal, input.ordinal + 1]);
    });
  }
});

test("traversal, case-collision, and archive limits are rejected before extraction", async (t) => {
  const root = await fixture(t);
  const traversal = path.join(root, "traversal.zip");
  await writeZip(traversal, [["../catalog.xlsx", "VALID_UUID_PARENT_NAME_TREE"]]);
  await assert.rejects(
    extractZipArchiveSafely(traversal, path.join(root, "extract-traversal")),
    /BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE/,
  );

  const collision = path.join(root, "collision.zip");
  await writeZip(collision, [["A.xlsx", "A"], ["a.xlsx", "B"]]);
  const collisionTarget = path.join(root, "extract-collision");
  await assert.rejects(
    extractZipArchiveSafely(collision, collisionTarget),
    /ARCHIVE_PATH_COLLISION/,
  );
  await assert.rejects(fs.stat(collisionTarget), /ENOENT/);

  const parentCollision = path.join(root, "parent-collision.zip");
  await writeZip(parentCollision, [["A/one.xlsx", "A"], ["a/two.xlsx", "B"]]);
  await assert.rejects(
    extractZipArchiveSafely(parentCollision, path.join(root, "extract-parent-collision")),
    /ARCHIVE_PATH_COLLISION/,
  );

  const limited = path.join(root, "limited.zip");
  await writeZip(limited, [["one.xlsx", "1"], ["two.xlsx", "2"]]);
  await assert.rejects(
    extractZipArchiveSafely(limited, path.join(root, "extract-limited"), { max_entries: 1 }),
    /BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT/,
  );

  const directoryLimited = path.join(root, "directory-limited.zip");
  const directoryZip = new JSZip();
  directoryZip.folder("one");
  directoryZip.folder("two");
  await fs.writeFile(directoryLimited, await directoryZip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(
    extractZipArchiveSafely(
      directoryLimited,
      path.join(root, "extract-directory-limited"),
      { max_entries: 1 },
    ),
    /BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT/,
  );

  const byteLimited = path.join(root, "byte-limited.zip");
  await writeZip(byteLimited, [["large.xlsx", "12345"]]);
  await assert.rejects(
    extractZipArchiveSafely(
      byteLimited,
      path.join(root, "extract-byte-limited"),
      { max_uncompressed_bytes: 4 },
    ),
    /BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT/,
  );

  await assert.rejects(
    extractZipArchiveSafely(
      byteLimited,
      path.join(root, "extract-entry-limited"),
      { max_entry_uncompressed_bytes: 4 },
    ),
    /entry_uncompressed_bytes/,
  );

  const ratioLimited = path.join(root, "ratio-limited.zip");
  const ratioZip = new JSZip();
  ratioZip.file("compressible.xlsx", Buffer.alloc(16 * 1024), {
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await fs.writeFile(ratioLimited, await ratioZip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(
    extractZipArchiveSafely(
      ratioLimited,
      path.join(root, "extract-ratio-limited"),
      { max_compression_ratio: 10 },
    ),
    /compression_ratio/,
  );

  const corruptBeforeLoad = path.join(root, "preflight-before-load.zip");
  const preflightZip = new JSZip();
  preflightZip.file("one.xlsx", "1", { compression: "STORE" });
  preflightZip.file("two.xlsx", "2", { compression: "STORE" });
  await fs.writeFile(
    corruptBeforeLoad,
    corruptFirstLocalHeader(await preflightZip.generateAsync({ type: "nodebuffer" })),
  );
  await assert.rejects(
    extractZipArchiveSafely(
      corruptBeforeLoad,
      path.join(root, "extract-preflight-before-load"),
      { max_entries: 1 },
    ),
    (error) => error instanceof IntalevCatalogBindingError &&
      error.code === "BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT" &&
      error.details.phase === "CENTRAL_DIRECTORY_PREFLIGHT",
  );

  const nested = new JSZip();
  nested.file("catalog.xlsx", "VALID_UUID_PARENT_NAME_TREE");
  const depthLimited = path.join(root, "depth-limited.zip");
  await writeZip(depthLimited, [[
    "nested.zip",
    await nested.generateAsync({ type: "nodebuffer" }),
  ]]);
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: depthLimited,
      workDir: path.join(root, "depth-work"),
      probeWorkbook,
      limits: { max_archive_depth: 0 },
    }),
    /BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT/,
  );
});

test("duplicate central-directory names and CRC drift fail closed", async (t) => {
  const root = await fixture(t);
  const original = new JSZip();
  original.file("same.xlsx", "VALID_UUID_PARENT_NAME_TREE", { compression: "STORE" });
  const originalBytes = await original.generateAsync({ type: "nodebuffer" });

  const duplicate = path.join(root, "duplicate.zip");
  await fs.writeFile(duplicate, duplicateOnlyCentralDirectoryEntry(originalBytes));
  await assert.rejects(
    extractZipArchiveSafely(duplicate, path.join(root, "duplicate-output")),
    /ARCHIVE_DUPLICATE_ENTRY/,
  );

  const corrupted = path.join(root, "crc-corrupted.zip");
  await fs.writeFile(corrupted, corruptFirstStoredEntry(originalBytes));
  await assert.rejects(
    extractZipArchiveSafely(corrupted, path.join(root, "crc-output")),
    /CRC32_MISMATCH/,
  );
});

test("container mutation during probe is detected as source drift", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "intalev");
  const candidate = path.join(directory, "catalog.xlsx");
  await fs.mkdir(directory);
  await fs.writeFile(candidate, "VALID_UUID_PARENT_NAME_TREE");
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: directory,
      workDir: path.join(root, "work"),
      probeWorkbook: async (filePath) => {
        const result = await probeWorkbook(filePath);
        await fs.writeFile(path.join(directory, "drift.txt"), "changed");
        return result;
      },
    }),
    /SOURCE_DRIFT/,
  );
});

test("directory roots and descendants reject symlink or junction reparse points", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  const selected = path.join(root, "selected");
  await fs.mkdir(outside);
  await fs.mkdir(selected);
  await fs.writeFile(path.join(outside, "catalog.xlsx"), "VALID_UUID_PARENT_NAME_TREE");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const nestedLink = path.join(selected, "linked");
  try {
    await fs.symlink(outside, nestedLink, linkType);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`reparse point creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: selected,
      workDir: path.join(root, "nested-link-work"),
      probeWorkbook,
    }),
    (error) => error instanceof IntalevCatalogBindingError &&
      error.code === "BLOCKED_SOURCE_PROOF_REPARSE_POINT",
  );

  const rootLink = path.join(root, "selected-link");
  await fs.symlink(outside, rootLink, linkType);
  await assert.rejects(
    discoverIntalevArticleCatalog({
      sourcePath: rootLink,
      workDir: path.join(root, "root-link-work"),
      probeWorkbook,
    }),
    (error) => error instanceof IntalevCatalogBindingError &&
      error.code === "BLOCKED_SOURCE_PROOF_REPARSE_POINT",
  );
});

test("effective binding clears only intalev_uid and retains the immutable static manifest", () => {
  const catalogSha = "A".repeat(64);
  const referenceCatalogs = {
    status: "PASS_REFERENCE_CATALOGS_BOUND_WITH_DECLARED_MISSING_ROLES",
    binding_sha256: "B".repeat(64),
    declared_missing_roles: ["intalev_uid", "unrelated_identity"],
    release_blockers: [
      "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
      "BLOCKED_ORGANIZATION_IDENTITY_UNPROVEN",
    ],
    catalogs: [
      { role: "intalev_uid", declared_missing: true, usage: ["calculation", "validation"] },
      { role: "erp_uid", declared_missing: false, usage: ["calculation", "validation"] },
    ],
  };
  const bound = bindRunIntalevUidCatalog(referenceCatalogs, {
    selected: {
      source_path: "C:/run/catalog.xlsx",
      parsed: validCatalog(),
      provenance: {
        selection_mode: "AUTO_DETECTED_CONTAINER",
        entry_path: "catalog.xlsx",
        archive_sha256: "C".repeat(64),
        size: 123,
        sha256: catalogSha,
        hash_stable: true,
      },
    },
  });
  assert.deepEqual(bound.declared_missing_roles, ["unrelated_identity"]);
  assert.deepEqual(bound.release_blockers, ["BLOCKED_ORGANIZATION_IDENTITY_UNPROVEN"]);
  assert.deepEqual(bound.static_manifest.declared_missing_roles, ["intalev_uid", "unrelated_identity"]);
  assert.equal(bound.catalogs.find((item) => item.role === "intalev_uid").sha256_before, catalogSha);
});
