#!/usr/bin/env python3
"""Prepare the integrated REPORT_ONLY runtime from current R17 sources.

The first stage delegates to the pinned R005 UK9 runtime preparer. This
second, bounded stage overlays the current R001 and R005 source authorities
from this repository and rebinds the payload manifest. The deleted legacy
Rules-engine overlay is intentionally not materialized or required.
It does not compile the Service, change business inputs, release, post, upload,
or invoke 1C.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
from typing import Any


R005_PREPARER_PATH = Path(__file__).with_name("prepare_r005_uk9_review_runtime.py")
R005_SPEC = importlib.util.spec_from_file_location("opiu_r005_runtime_preparer", R005_PREPARER_PATH)
if R005_SPEC is None or R005_SPEC.loader is None:  # pragma: no cover - import bootstrap guard
    raise RuntimeError("R005_PREPARER_IMPORT_FAILED")
R005 = importlib.util.module_from_spec(R005_SPEC)
R005_SPEC.loader.exec_module(R005)

R001_CHANGE_REQUEST = "CR-R001-20260816-CROSS-SOURCE-DEDUP-001"
R001_BASE_COMMIT = "6d1386e5d9a10a22a75c483845f62ce28ce6b496"
R001_RESULT_COMMIT = "da024306c7edb515df1ae57a1ee219067b06faed"
R005_CATALOG_CHANGE_REQUEST = "CR-R005-20260817-INTALEV-CATALOG-AUTO-BINDING-001"
R005_CATALOG_BASE_COMMIT = "8789974ed0bdd4a5c18c3c3973ceff2ae787f064"
R005_CATALOG_RESULT_COMMIT = "0848141cbe67b7f891f547cce9e25fcf8dea017d"
R005_CATALOG_HANDOFF_HEAD = "ee78a5fed6fd897dbf4c9da4bd0da1a2f41b9185"
EXPECTED_PREPARED_R005_MANIFEST_SHA256 = (
    "C6B41BC5F5CD832B68668172BFBD664F7623738B86D5D794B738797166DA9E30"
)
FIXED_GENERATED_AT = "2026-08-16T00:00:00Z"
MATERIALIZED_ROOT_FILES = ("SAFETY.json", "VERSION.txt")
MATERIALIZED_RUNTIME_DIRS = (
    "modules",
    "data/defaults",
    "resources/reference",
    "runtime",
)

# Kept as explicit empty records so old manifest consumers cannot silently
# reintroduce the retired Rules-engine source authority.
RULES_OVERLAY_HASHES: dict[str, str] = {}
RULES_SAFETY_OVERLAY_HASHES: dict[str, str] = {}

CORRECTIONS_OVERLAY_HASHES = {
    "modules/corrections/source/correction_engine_r001.mjs":
        "C8CDF64603C129E0102154402309A7EE82A8E605A246FA42237748169ED87C8B",
    "modules/corrections/source/r001_cross_source_dedup.mjs":
        "95ACE2F283B5086943D78F58785B64185C6F3C3487F85BE18ACBE2B4423A3EAC",
    "modules/corrections/source/r001_cross_source_dedup.test.mjs":
        "6D8BF7DDAF51EDA2F627F91AA1AC760C7B8B2775426CE204D0D5F32FB38DC010",
    "modules/corrections/source/rules_application_handoff.mjs":
        "189332AAFF98DD1321A29F4F17534F82F65505A14E972F65AA13185375F66932",
    "modules/corrections/source/rules_application_handoff.test.mjs":
        "4FEE124783EEE3EFADD5AA9B22E6EE6DC53EF21CAFE39CACC264FA7849EC1709",
}

R005_CATALOG_OVERLAY_HASHES = {
    "modules/reconciliation/source/opiu_reconcile.mjs":
        "66C2587238D4CD2BACE280AD857E917D088851228477C547702D2F247328FD80",
    "modules/reconciliation/source/reference_catalog_manifest.mjs":
        "85094D961FE12895A122B1EEE5EF9DC502D46E791A4406921FB2158B993C6748",
    "modules/reconciliation/source/intalev_catalog_binding.mjs":
        "DB7D3B97711227ACDE8A1D5396EFE919A4E4042563C2C1A688D50F05247DE4B4",
    "modules/reconciliation/source/intalev_catalog_binding.test.mjs":
        "5ABCF2632CC14AE559282E84AE6A5EA4F9795AB00946227CA8F32E1E562888E6",
    "modules/reconciliation/source/intalev_catalog_workbook_semantics.test.mjs":
        "00C55C1B4671FA7722F5084BE37E63BAFE74B3F62406A836C067037C28B22F82",
}

# No historical integration-release carrier overlay is accepted here. The
# package must be assembled from the current authoritative R001/R005 sources.
INTEGRATION_RELEASE_OVERLAY_HASHES: dict[str, str] = {}

SOURCE_ROOT = Path(__file__).resolve().parents[2]
class IntegratedPrepareError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise IntegratedPrepareError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def materialized_payload_inventory(runtime_root: Path) -> dict[str, Any]:
    """Hash every byte the final bundle builder copies, excluding MANIFEST.

    MANIFEST.json is excluded to avoid a circular self-hash. Its SHA-256 is
    recorded separately by the final bundle provenance.
    """
    sources: dict[str, Path] = {}
    for relative in MATERIALIZED_ROOT_FILES:
        path = runtime_root / relative
        if path.is_file() and not path.is_symlink():
            sources[relative] = path

    for relative in MATERIALIZED_RUNTIME_DIRS:
        source = runtime_root / Path(relative)
        if not source.is_dir() or source.is_symlink():
            raise IntegratedPrepareError(f"MATERIALIZED_DIRECTORY_MISSING:{relative}")
        for root, dirs, files in os.walk(source):
            dirs[:] = sorted(
                item
                for item in dirs
                if not (relative == "modules" and item == "node_modules")
            )
            root_path = Path(root)
            for name in sorted(files):
                path = root_path / name
                if path.is_symlink():
                    raise IntegratedPrepareError(f"MATERIALIZED_SYMLINK_FORBIDDEN:{path}")
                destination = path.relative_to(runtime_root).as_posix()
                sources[destination] = path

    shared_modules = runtime_root / "modules/corrections/source/node_modules"
    if not shared_modules.is_dir() or shared_modules.is_symlink():
        raise IntegratedPrepareError("SHARED_NODE_MODULES_MISSING")
    for root, dirs, files in os.walk(shared_modules):
        dirs[:] = sorted(dirs)
        root_path = Path(root)
        for name in sorted(files):
            path = root_path / name
            if path.is_symlink():
                raise IntegratedPrepareError(f"MATERIALIZED_SYMLINK_FORBIDDEN:{path}")
            destination = (
                Path("node_modules") / path.relative_to(shared_modules)
            ).as_posix()
            sources[destination] = path

    rows = [
        {
            "path": destination,
            "size": source.stat().st_size,
            "sha256": sha256_file(source),
        }
        for destination, source in sorted(sources.items())
    ]
    payload = (json.dumps(
        rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n").encode("utf-8")
    return {
        "file_count": len(rows),
        "sha256": hashlib.sha256(payload).hexdigest().upper(),
    }


def overlay_integrated_changes(runtime_root: Path) -> dict[str, Any]:
    """Overlay current authoritative R001/R005 files into the R005 runtime."""
    runtime_root = runtime_root.resolve()
    manifest_path = runtime_root / "MANIFEST.json"
    safety_path = runtime_root / "SAFETY.json"
    manifest = load_json(manifest_path)
    safety = load_json(safety_path)

    if manifest.get("schema") != "opiu-package-manifest.v2":
        raise IntegratedPrepareError("MANIFEST_SCHEMA_MISMATCH")
    if manifest.get("package_id") != "OPIU_SERVICE_PAYLOAD_1.9.4":
        raise IntegratedPrepareError("PACKAGE_ID_MISMATCH")
    if not re.fullmatch(r"[0-9a-f]{40}", R005_CATALOG_RESULT_COMMIT):
        raise IntegratedPrepareError("R005_CATALOG_RESULT_COMMIT_NOT_PINNED")
    review_change = manifest.get("review_change") or {}
    if review_change.get("change_request") != R005.CHANGE_REQUEST:
        raise IntegratedPrepareError("R005_REVIEW_CHANGE_REQUIRED")
    if review_change.get("base_bundle_sha256") != R005.BASE_BUNDLE_SHA256:
        raise IntegratedPrepareError("R005_BASE_BUNDLE_BINDING_MISMATCH")
    if (
        safety.get("mode") != "REPORT_ONLY"
        or safety.get("posting_rows") != 0
        or safety.get("ready_to_upload") is not False
        or safety.get("release_allowed") is not False
        or safety.get("one_c_actions_executed") is not False
        or safety.get("live_1c_allowed") is not False
    ):
        raise IntegratedPrepareError("RUNTIME_SAFETY_CONTRACT_FAILED")

    R005.verify_recorded_inventory(runtime_root, manifest)
    base_manifest_sha256 = sha256_file(manifest_path)
    if base_manifest_sha256 != EXPECTED_PREPARED_R005_MANIFEST_SHA256:
        raise IntegratedPrepareError(
            f"PREPARED_R005_MANIFEST_MISMATCH:{base_manifest_sha256}"
        )

    # The legacy Rules-engine source authority was removed from the current
    # repository. Keep these fields empty for schema compatibility, but never
    # attempt to materialize or validate that retired runtime.
    applied_hashes: dict[str, str] = {}
    applied_rules_safety_hashes: dict[str, str] = {}

    applied_corrections_hashes: dict[str, str] = {}
    for relative, expected_hash in CORRECTIONS_OVERLAY_HASHES.items():
        source = SOURCE_ROOT / Path(relative)
        if not source.is_file() or source.is_symlink():
            raise IntegratedPrepareError(
                f"CORRECTIONS_OVERLAY_SOURCE_MISSING:{relative}"
            )
        actual_source_hash = sha256_file(source)
        if actual_source_hash != expected_hash:
            raise IntegratedPrepareError(
                "CORRECTIONS_OVERLAY_SOURCE_HASH_MISMATCH:"
                f"{relative}:{actual_source_hash}"
            )
        target = runtime_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        applied_corrections_hashes[relative] = sha256_file(target)
        R005.upsert_manifest_file(
            manifest,
            relative,
            target,
            source=f"{R001_CHANGE_REQUEST}:{R001_RESULT_COMMIT}:{relative}",
        )

    applied_r005_catalog_hashes: dict[str, str] = {}
    for relative, expected_hash in R005_CATALOG_OVERLAY_HASHES.items():
        source = SOURCE_ROOT / Path(relative)
        if not source.is_file() or source.is_symlink():
            raise IntegratedPrepareError(
                f"R005_CATALOG_OVERLAY_SOURCE_MISSING:{relative}"
            )
        actual_source_hash = sha256_file(source)
        if actual_source_hash != expected_hash:
            raise IntegratedPrepareError(
                "R005_CATALOG_OVERLAY_SOURCE_HASH_MISMATCH:"
                f"{relative}:{actual_source_hash}"
            )
        target = runtime_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        applied_r005_catalog_hashes[relative] = sha256_file(target)
        R005.upsert_manifest_file(
            manifest,
            relative,
            target,
            source=(
                f"{R005_CATALOG_CHANGE_REQUEST}:"
                f"{R005_CATALOG_RESULT_COMMIT}:{relative}"
            ),
        )

    applied_integration_release_hashes: dict[str, str] = {}

    for item in manifest.get("protected_core", []):
        relative = str(item.get("path", ""))
        if relative in applied_r005_catalog_hashes:
            item["sha256"] = applied_r005_catalog_hashes[relative]

    safety.update({
        "mode": "REPORT_ONLY",
        "posting_rows": 0,
        "execution_allowed": False,
        "ready_to_upload": False,
        "release_allowed": False,
        "one_c_actions_executed": False,
        "live_1c_allowed": False,
        "rules_report_controls_changed": False,
        "rules_financial_logic_changed": False,
        "rules_output_safety_passport_fix": False,
        "r001_cross_source_dedup_fix": True,
        "r001_financial_logic_changed": True,
        "r001_change_request": R001_CHANGE_REQUEST,
        "r005_intalev_catalog_auto_binding": True,
        "r005_catalog_financial_logic_changed": False,
        "r005_organization_crosswalk_verified": False,
        "uk9_2025_twelve_month_final_audit_passed": False,
        "r005_catalog_change_request": R005_CATALOG_CHANGE_REQUEST,
    })
    write_json(safety_path, safety)
    R005.upsert_manifest_file(
        manifest,
        "SAFETY.json",
        safety_path,
        source=(
            f"{R001_CHANGE_REQUEST}+{R005_CATALOG_CHANGE_REQUEST}:"
            "safety-passport"
        ),
    )

    materialized_inventory = materialized_payload_inventory(runtime_root)
    manifest["generated_at"] = FIXED_GENERATED_AT
    manifest["integrated_review_change"] = {
        "schema_version": "opiu-integrated-runtime-review.v1",
        "source_authority": "CURRENT_R17_REPOSITORY_SOURCES",
        "prepared_r005_manifest_sha256": base_manifest_sha256,
        "change_requests": [
            R005.CHANGE_REQUEST,
            R001_CHANGE_REQUEST,
            R005_CATALOG_CHANGE_REQUEST,
        ],
        "rules_overlay_hashes": applied_hashes,
        "rules_safety_overlay_hashes": applied_rules_safety_hashes,
        "r001_base_commit": R001_BASE_COMMIT,
        "r001_result_commit": R001_RESULT_COMMIT,
        "corrections_overlay_hashes": applied_corrections_hashes,
        "r005_catalog_base_commit": R005_CATALOG_BASE_COMMIT,
        "r005_catalog_result_commit": R005_CATALOG_RESULT_COMMIT,
        "r005_catalog_handoff_head": R005_CATALOG_HANDOFF_HEAD,
        "r005_catalog_overlay_hashes": applied_r005_catalog_hashes,
        "integration_release_overlay_hashes": applied_integration_release_hashes,
        "integration_release_packaging_only": False,
        "materialized_payload_file_count": materialized_inventory["file_count"],
        "materialized_payload_inventory_sha256": materialized_inventory["sha256"],
        "rules_report_controls_fix": False,
        "rules_output_safety_passport_fix": False,
        "rules_financial_logic_changed": False,
        "r001_cross_source_dedup_fix": True,
        "r001_financial_logic_changed": True,
        "r005_intalev_catalog_auto_binding": True,
        "r005_catalog_financial_logic_changed": False,
        "r005_organization_crosswalk_verified": False,
        "uk9_2025_twelve_month_final_audit": "PENDING",
        "package_bound_crosswalk": "NOT_INCLUDED",
        "distribution_status": "TEST_REPORT_ONLY",
        "user_delivery_approved": False,
        "financial_correctness_verified": False,
        "independent_qa": "REQUIRED",
        "release_approved": False,
        "live_1c_approved": False,
    }
    manifest_safety = manifest.setdefault("safety", {})
    manifest_safety.update({
        "mode": "REPORT_ONLY",
        "posting_rows": 0,
        "execution_allowed": False,
        "ready_to_upload": False,
        "release_allowed": False,
        "live_1c_allowed": False,
        "rules_financial_logic_changed": False,
        "rules_report_controls_changed": False,
        "rules_output_safety_passport_fix": False,
        "r001_cross_source_dedup_fix": True,
        "r001_financial_logic_changed": True,
        "r005_intalev_catalog_auto_binding": True,
        "r005_catalog_financial_logic_changed": False,
        "r005_organization_crosswalk_verified": False,
        "uk9_2025_twelve_month_final_audit_passed": False,
        "financial_correctness_verified": False,
    })
    qa = manifest.setdefault("qa", {})
    qa.update({
        "rules_report_controls": "NOT_APPLICABLE_LEGACY_RULES_ENGINE_RETIRED",
        "rules_output_safety_passport": "NOT_APPLICABLE_LEGACY_RULES_ENGINE_RETIRED",
        "r001_cross_source_dedup": "PASS_EXACT_GOLDEN_AND_NEGATIVE_CASES",
        "r005_intalev_catalog_auto_binding": "IMPLEMENTED_AWAITING_INDEPENDENT_QA",
        "uk9_2025_twelve_month_final_audit": "PENDING",
        "package_bound_crosswalk": "NOT_INCLUDED",
        "integrated_service_qa": "PENDING_INDEPENDENT_QA",
    })
    write_json(manifest_path, manifest)
    R005.verify_recorded_inventory(runtime_root, manifest)

    return {
        "status": "PASS_INTEGRATED_REVIEW_RUNTIME_PREPARED",
        "runtime_root": str(runtime_root),
        "base_manifest_sha256": base_manifest_sha256,
        "manifest_sha256": sha256_file(manifest_path),
        "safety_sha256": sha256_file(safety_path),
        "rules_overlay_hashes": applied_hashes,
        "rules_safety_overlay_hashes": applied_rules_safety_hashes,
        "corrections_overlay_hashes": applied_corrections_hashes,
        "r005_catalog_overlay_hashes": applied_r005_catalog_hashes,
        "integration_release_overlay_hashes": applied_integration_release_hashes,
        "materialized_payload_file_count": materialized_inventory["file_count"],
        "materialized_payload_inventory_sha256": materialized_inventory["sha256"],
        "safety": {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "execution_allowed": False,
            "ready_to_upload": False,
            "release_allowed": False,
            "live_1c_allowed": False,
        },
    }


def overlay_rules_controls(runtime_root: Path) -> dict[str, Any]:
    """Compatibility entrypoint for the fully integrated overlay stage."""
    return overlay_integrated_changes(runtime_root)


def prepare(base_bundle: Path, output_root: Path) -> dict[str, Any]:
    base_result = R005.prepare(base_bundle, output_root)
    result = overlay_integrated_changes(output_root)
    result["base_bundle_sha256"] = base_result["base_bundle_sha256"]
    write_json(output_root / "INTEGRATED_RUNTIME_PREPARE_RESULT.json", result)
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
    except (
        IntegratedPrepareError,
        R005.PrepareError,
        OSError,
        ValueError,
    ) as error:
        raise SystemExit(str(error)) from error
