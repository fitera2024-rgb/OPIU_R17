#!/usr/bin/env python3
"""Read-only static verification for a Portable Service candidate ZIP."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path, PurePosixPath


CANDIDATE_NAME = "OPIU_Service_Portable_1.9.4_USER_DELIVERY_CANDIDATE"
EXE_NAME = "Автоматическая_сверка_ОПИУ_1.9.4.exe"
SOURCE_PRODUCT_HEAD = "a5d033be9aa2df583ed751e7959f7bcdf8429200"
OVERLAY_CHANGE_REQUEST = "CR-SVC-20260811-005"
EXPECTED_UI_OVERLAY = {
    "web/app.js": "AE95B97A638EEDEBC47C1668FD301823F8DC58369A1D528A70F21EC86CA3E4EA",
    "web/app.css": "46012D60EA6A61F6E22C73EBD86D89A177F39C0658D46A8B0D76B31198C9499E",
    "web/index.html": "E85AE9E101EDC2C25A109AC52009D4BB638F05E3E3EBC497DD24C99EA6F96484",
}
REQUIRED = {
    EXE_NAME,
    "PAYLOAD_MANIFEST.json",
    "USER_DELIVERY_CANDIDATE_MANIFEST.json",
    "README_CANDIDATE_REPORT_ONLY.txt",
    "README_ПЕРВЫЙ_ЗАПУСК.txt",
    "SHA256SUMS.txt",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--expected-head")
    parser.add_argument("--expected-source-head", default=SOURCE_PRODUCT_HEAD)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    if not candidate.is_file():
        fail("CANDIDATE_MISSING")

    payloads: dict[str, bytes] = {}
    with zipfile.ZipFile(candidate) as archive:
        names: set[str] = set()
        for info in archive.infolist():
            if info.is_dir():
                continue
            normalized = PurePosixPath(info.filename.replace("\\", "/"))
            if normalized.is_absolute() or ".." in normalized.parts:
                fail(f"UNSAFE_ARCHIVE_PATH:{info.filename}")
            if info.filename in names:
                fail(f"DUPLICATE_ARCHIVE_PATH:{info.filename}")
            names.add(info.filename)
            if len(normalized.parts) != 2 or normalized.parts[0] != CANDIDATE_NAME:
                fail(f"UNEXPECTED_ARCHIVE_LAYOUT:{info.filename}")
            payloads[normalized.name] = archive.read(info)

    missing = REQUIRED - set(payloads)
    if missing:
        fail(f"REQUIRED_FILES_MISSING:{sorted(missing)}")
    if len([name for name in payloads if name.lower().endswith(".pdf")]) != 2:
        fail("PDF_SET_INVALID")

    sums: dict[str, str] = {}
    for line in payloads["SHA256SUMS.txt"].decode("utf-8-sig").splitlines():
        match = re.fullmatch(r"([0-9A-F]{64}) \*(.+)", line)
        if not match:
            fail("SHA256SUMS_FORMAT_INVALID")
        sums[match.group(2)] = match.group(1)
    expected_sum_names = set(payloads) - {"SHA256SUMS.txt"}
    if set(sums) != expected_sum_names:
        fail("SHA256SUMS_FILE_SET_MISMATCH")
    for name, expected in sums.items():
        if digest(payloads[name]) != expected:
            fail(f"SHA256SUMS_MISMATCH:{name}")

    manifest = json.loads(payloads["USER_DELIVERY_CANDIDATE_MANIFEST.json"].decode("utf-8"))
    payload_manifest = json.loads(payloads["PAYLOAD_MANIFEST.json"].decode("utf-8"))
    if manifest.get("schema_version") != "opiu-user-delivery-candidate.v1":
        fail("CANDIDATE_MANIFEST_SCHEMA_INVALID")
    if manifest.get("version") != "1.9.4" or payload_manifest.get("version") != "1.9.4":
        fail("VERSION_INVALID")
    if args.expected_head and manifest.get("integration_head") != args.expected_head.lower():
        fail("INTEGRATION_HEAD_MISMATCH")
    if manifest.get("build_tooling_head") != manifest.get("integration_head"):
        fail("BUILD_TOOLING_HEAD_MISMATCH")
    if manifest.get("source_product_head") != args.expected_source_head.lower():
        fail("SOURCE_PRODUCT_HEAD_MISMATCH")
    if manifest.get("executable", {}).get("sha256") != digest(payloads[EXE_NAME]):
        fail("EXE_MANIFEST_HASH_MISMATCH")
    if manifest.get("payload", {}).get("manifest_sha256") != digest(payloads["PAYLOAD_MANIFEST.json"]):
        fail("PAYLOAD_MANIFEST_HASH_MISMATCH")
    required_gates = {
        "mode": "REPORT_ONLY",
        "report_only": True,
        "independent_qa_status": "INDEPENDENT_QA_PENDING",
        "posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
        "live_1c_allowed": False,
        "external_release_allowed": False,
    }
    for gate, expected in required_gates.items():
        if manifest.get("safety", {}).get(gate) != expected:
            fail(f"CANDIDATE_GATE_OPEN:{gate}")
    for gate, expected in {"posting_rows": 0, "ready_to_upload": False, "release_allowed": False}.items():
        if payload_manifest.get("safety", {}).get(gate) != expected:
            fail(f"PAYLOAD_GATE_OPEN:{gate}")
    ui = manifest.get("ui", {})
    if ui.get("changed_files") != len(EXPECTED_UI_OVERLAY):
        fail("UI_CHANGED_FILE_COUNT_INVALID")
    if manifest.get("service_source", {}).get("overlay_change_request") != OVERLAY_CHANGE_REQUEST:
        fail("BACKEND_OVERLAY_CR_MISMATCH")
    if ui.get("overlay_change_request") != OVERLAY_CHANGE_REQUEST:
        fail("UI_OVERLAY_CR_MISMATCH")
    if ui.get("overlay_hashes") != EXPECTED_UI_OVERLAY:
        fail("UI_OVERLAY_HASHES_MISMATCH")
    if ui.get("baseline_hash_set_sha256") == ui.get("packaged_hash_set_sha256"):
        fail("PR72_UI_CHANGE_MISSING")
    for path, expected in EXPECTED_UI_OVERLAY.items():
        if ui.get("hashes", {}).get(path) != expected:
            fail(f"PACKAGED_UI_HASH_MISMATCH:{path}")
    if not manifest.get("executable", {}).get("deterministic_double_build"):
        fail("DETERMINISTIC_BUILD_NOT_PROVEN")

    result = {
        "status": "PASS",
        "candidate_sha256": digest(candidate.read_bytes()),
        "candidate_manifest_sha256": digest(payloads["USER_DELIVERY_CANDIDATE_MANIFEST.json"]),
        "executable_sha256": digest(payloads[EXE_NAME]),
        "entry_count": len(payloads),
        "source_product_head": manifest["source_product_head"],
        "build_tooling_head": manifest["build_tooling_head"],
        "ui_changed_files": len(EXPECTED_UI_OVERLAY),
        "posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
