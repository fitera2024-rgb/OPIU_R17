#!/usr/bin/env python3
"""Prepare the exact R005 UK9 REVIEW_ONLY runtime from the owner bundle.

The script accepts only the pinned owner ZIP, extracts its runtime safely,
verifies every file recorded by the original manifest, overlays the bounded
R005 correctness files from this repository, and regenerates the runtime
manifest. It does not compile, publish, release, upload, post, or invoke 1C.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


BASE_BUNDLE_SHA256 = "7AFA29573AE82FDC30DFC8528AA1F2678E82F05E13CCE95018C0F4456C786167"
BASE_COMMIT = "fe1891166367cabf7c8faf890f680ff4abe6b15a"
CHANGE_REQUEST = "CR-R005-20260815-UK9-001"
RESULT_COMMIT = "519857e383478a5ad6788dfd1b777366114d45c2"
FIXED_GENERATED_AT = "2026-08-16T00:00:00Z"
OVERLAY_FILES = (
    "modules/reconciliation/source/hierarchy_tree.mjs",
    "modules/reconciliation/source/opiu_reconcile.mjs",
    "modules/reconciliation/source/r005_erp_normalization.mjs",
    "modules/reconciliation/source/r005_intalev_diagnostic.mjs",
    "modules/reconciliation/source/r005_reconciliation_status.mjs",
)
OVERLAY_HASHES = {
    "modules/reconciliation/source/hierarchy_tree.mjs":
        "3A27831390795EA83D3D17815B97EE4DA596BE29DA682A042E688BE52E302F6D",
    "modules/reconciliation/source/opiu_reconcile.mjs":
        "9D74B9604D71B1EE3C70FC2B65D5CFC3ADDE68DF80AB0AF77F671871D83837D7",
    "modules/reconciliation/source/r005_erp_normalization.mjs":
        "CD35601E89A0E104701EFA983C467225162D06774B643B7ADDA392D664160E12",
    "modules/reconciliation/source/r005_intalev_diagnostic.mjs":
        "507E2EA69F7E836EFCD8EEDBC93708AF292BBC62F957628D5FA7EAF82066DB78",
    "modules/reconciliation/source/r005_reconciliation_status.mjs":
        "3A44BD7B311FA25B49B6BE539332FE4D6ACF466B653338FCA9BDF85D537FF356",
}
EXPECTED_BASE_MANIFEST_DRIFT = {
    "modules/corrections/source/rules_application_handoff.mjs":
        "CDA096B6A395C43BA8645D919F7F908B9120945196ABFDFEED148357C67C0B80",
    "modules/reconciliation/source/config.json":
        "22A9C87FDAB7D033713236D69F8CE8CF30E1E8CFB17A76F255716987B44062BE",
    "modules/reconciliation/source/hierarchy_tree.mjs":
        "6C2906C1ECFA3AFE77A7167B0976C5BA20B0D0942D9D9C22A55733408B9865D0",
    "modules/reconciliation/source/opiu_reconcile.mjs":
        "B7DD884CD4D5B81966E8FCC36F8016860F5E3E5A5672E85B34332F8628B3F97E",
    "modules/rules-engine/source/adapters/r005_adapter.mjs":
        "FC9CB1AA39B5FF7D3CFC6649EAC2E6D822F02B28A6241F0CCEE1106DFB05F49B",
    "modules/rules-engine/source/engine.mjs":
        "13FD773853388CF3158854048369E007F2AF2A6BBAE6902065E1ECB6FBBC8C9D",
    "modules/rules-engine/source/matcher.mjs":
        "031DE5B428C0740B89134C2CA6D0345CDFE54FF0D1FFDC00C1210C160FBC6DA5",
    "modules/rules-engine/source/normalize.mjs":
        "C5A9EC3FB788E740D533812F0E6433622642D6F5051D5F03075287760DC56C47",
}

REPO_ROOT = Path(__file__).resolve().parents[4]


class PrepareError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise PrepareError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def safe_runtime_relative(name: str) -> Path | None:
    normalized = PurePosixPath(name.replace("\\", "/"))
    if normalized.is_absolute() or ".." in normalized.parts:
        raise PrepareError(f"UNSAFE_ARCHIVE_PATH:{name}")
    if not normalized.parts or normalized.parts[0] != "runtime":
        return None
    if len(normalized.parts) == 1:
        return Path()
    return Path(*normalized.parts[1:])


def extract_runtime(bundle_zip: Path, runtime_root: Path) -> None:
    with zipfile.ZipFile(bundle_zip) as archive:
        for info in archive.infolist():
            relative = safe_runtime_relative(info.filename)
            if relative is None:
                continue
            unix_type = (info.external_attr >> 16) & 0o170000
            if unix_type == stat.S_IFLNK:
                raise PrepareError(f"ARCHIVE_SYMLINK_FORBIDDEN:{info.filename}")
            target = runtime_root / relative
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))


def manifest_rows(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = manifest.get("files")
    if not isinstance(rows, list):
        raise PrepareError("MANIFEST_FILES_REQUIRED")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not row.get("path"):
            raise PrepareError("MANIFEST_FILE_ROW_INVALID")
        path = str(row["path"]).replace("\\", "/")
        if path in result:
            raise PrepareError(f"MANIFEST_DUPLICATE_PATH:{path}")
        result[path] = row
    return result


def verify_recorded_inventory(runtime_root: Path, manifest: dict[str, Any]) -> None:
    for relative, row in manifest_rows(manifest).items():
        path = runtime_root / Path(relative)
        if not path.is_file() or path.is_symlink():
            raise PrepareError(f"MANIFEST_FILE_MISSING:{relative}")
        if path.stat().st_size != int(row["size"]):
            raise PrepareError(f"MANIFEST_SIZE_MISMATCH:{relative}")
        if sha256_file(path) != str(row["sha256"]).upper():
            raise PrepareError(f"MANIFEST_HASH_MISMATCH:{relative}")


def rebind_expected_base_manifest_drift(
    runtime_root: Path,
    manifest: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Repair only the eight exact stale rows in the pinned owner ZIP.

    The owner bundle SHA binds these bytes. Any added, removed, or differently
    hashed mismatch is rejected instead of being normalized silently.
    """
    drift: dict[str, dict[str, Any]] = {}
    rows = manifest_rows(manifest)
    for relative, row in rows.items():
        path = runtime_root / Path(relative)
        if not path.is_file() or path.is_symlink():
            raise PrepareError(f"MANIFEST_FILE_MISSING:{relative}")
        actual_hash = sha256_file(path)
        actual_size = path.stat().st_size
        recorded_hash = str(row["sha256"]).upper()
        recorded_size = int(row["size"])
        if actual_hash == recorded_hash and actual_size == recorded_size:
            continue
        expected_actual = EXPECTED_BASE_MANIFEST_DRIFT.get(relative)
        if expected_actual != actual_hash:
            raise PrepareError(
                f"UNEXPECTED_BASE_MANIFEST_DRIFT:{relative}:{actual_hash}"
            )
        drift[relative] = {
            "recorded_size": recorded_size,
            "actual_size": actual_size,
            "recorded_sha256": recorded_hash,
            "actual_sha256": actual_hash,
        }

    if set(drift) != set(EXPECTED_BASE_MANIFEST_DRIFT):
        missing = sorted(set(EXPECTED_BASE_MANIFEST_DRIFT) - set(drift))
        raise PrepareError(f"EXPECTED_BASE_MANIFEST_DRIFT_NOT_FOUND:{missing}")

    for relative, evidence in drift.items():
        row = rows[relative]
        row["size"] = evidence["actual_size"]
        row["sha256"] = evidence["actual_sha256"]
        row["source"] = (
            f"owner-bundle:{BASE_BUNDLE_SHA256}:manifest-drift-rebound"
        )
        row["previous_manifest_sha256"] = evidence["recorded_sha256"]
    return drift


def upsert_manifest_file(
    manifest: dict[str, Any],
    relative: str,
    path: Path,
    *,
    source: str,
) -> None:
    rows = manifest_rows(manifest)
    row = rows.get(relative)
    replacement = {
        "path": relative,
        "size": path.stat().st_size,
        "sha256": sha256_file(path),
        "classification": str(row.get("classification")) if row else "ENGINE_RUNTIME",
        "source": source,
    }
    if row is None:
        manifest["files"].append(replacement)
    else:
        row.clear()
        row.update(replacement)
    manifest["files"].sort(key=lambda item: str(item["path"]))


def pinned_overlay_bytes(relative: str) -> bytes:
    repo_relative = (
        Path("development") / "OPIU_1.9.4" / Path(relative)
    ).as_posix()
    result = subprocess.run(
        ["git", "show", f"{RESULT_COMMIT}:{repo_relative}"],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise PrepareError(f"PINNED_OVERLAY_GIT_READ_FAILED:{relative}")
    expected_hash = OVERLAY_HASHES.get(relative)
    actual_hash = sha256_bytes(result.stdout)
    if expected_hash != actual_hash:
        raise PrepareError(
            f"PINNED_OVERLAY_HASH_MISMATCH:{relative}:{actual_hash}"
        )
    return result.stdout


def prepare(base_bundle: Path, output_root: Path) -> dict[str, Any]:
    base_bundle = base_bundle.resolve()
    output_root = output_root.resolve()
    if not base_bundle.is_file():
        raise PrepareError("BASE_BUNDLE_MISSING")
    actual_base_hash = sha256_file(base_bundle)
    if actual_base_hash != BASE_BUNDLE_SHA256:
        raise PrepareError(f"BASE_BUNDLE_HASH_MISMATCH:{actual_base_hash}")

    if output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True)
    extract_runtime(base_bundle, output_root)

    manifest_path = output_root / "MANIFEST.json"
    manifest = load_json(manifest_path)
    if manifest.get("schema") != "opiu-package-manifest.v2":
        raise PrepareError("MANIFEST_SCHEMA_MISMATCH")
    if manifest.get("package_id") != "OPIU_SERVICE_PAYLOAD_1.9.4":
        raise PrepareError("PACKAGE_ID_MISMATCH")
    base_manifest_drift = rebind_expected_base_manifest_drift(
        output_root,
        manifest,
    )
    verify_recorded_inventory(output_root, manifest)

    overlay_hashes: dict[str, str] = {}
    for relative in OVERLAY_FILES:
        source_bytes = pinned_overlay_bytes(relative)
        target = output_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source_bytes)
        overlay_hashes[relative] = sha256_file(target)
        upsert_manifest_file(
            manifest,
            relative,
            target,
            source=f"{CHANGE_REQUEST}:{relative}",
        )

    safety_path = output_root / "SAFETY.json"
    safety = load_json(safety_path)
    safety.update({
        "mode": "REPORT_ONLY",
        "posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
        "posting_generation_allowed": False,
        "reconciliation_calculation_entrypoint_modified": True,
        "one_c_actions_executed": False,
        "live_1c_allowed": False,
        "change_request": CHANGE_REQUEST,
    })
    write_json(safety_path, safety)
    upsert_manifest_file(
        manifest,
        "SAFETY.json",
        safety_path,
        source=f"{CHANGE_REQUEST}:safety-passport",
    )

    for item in manifest.get("protected_core", []):
        if item.get("path") == "modules/reconciliation/source/opiu_reconcile.mjs":
            item["sha256"] = overlay_hashes[item["path"]]

    manifest["generated_at"] = FIXED_GENERATED_AT
    manifest["review_change"] = {
        "change_request": CHANGE_REQUEST,
        "source_base_commit": BASE_COMMIT,
        "source_commit": RESULT_COMMIT,
        "base_bundle_sha256": actual_base_hash,
        "base_manifest_drift": base_manifest_drift,
        "overlay_hashes": overlay_hashes,
        "november_expectation": "NOVEMBER_EXPECTATION_UNPROVEN",
        "november_golden": "NOT_RELEASE_AUTHORITY",
        "erp_control": "PASS_UK9_R005_ERP_CONTROL_199_OF_199",
        "independent_qa": "REQUIRED",
        "financial_release": "NOT_APPROVED",
    }
    manifest_safety = manifest.setdefault("safety", {})
    manifest_safety.update({
        "mode": "REPORT_ONLY",
        "posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
        "posting_generation_allowed": False,
        "financial_engine_logic_changed": True,
        "live_1c_allowed": False,
    })
    qa = manifest.setdefault("qa", {})
    qa.update({
        "uk9_november_golden": "UNPROVEN",
        "uk9_erp_control_199_of_199": "PASS",
        "windows_runtime_tested": False,
        "final_distribution_integration": "PENDING_INDEPENDENT_QA",
    })
    write_json(manifest_path, manifest)
    verify_recorded_inventory(output_root, manifest)

    result = {
        "status": "PASS_R005_UK9_RUNTIME_PREPARED",
        "runtime_root": str(output_root),
        "base_bundle_sha256": actual_base_hash,
        "base_manifest_drift": base_manifest_drift,
        "manifest_sha256": sha256_file(manifest_path),
        "safety_sha256": sha256_file(safety_path),
        "overlay_hashes": overlay_hashes,
        "safety": {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": False,
            "live_1c_allowed": False,
        },
    }
    write_json(output_root / "R005_UK9_RUNTIME_PREPARE_RESULT.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-bundle", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(
        prepare(args.base_bundle, args.output_root),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    try:
        main()
    except (PrepareError, OSError, ValueError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from error
