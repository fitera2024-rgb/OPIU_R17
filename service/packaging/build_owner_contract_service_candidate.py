#!/usr/bin/env python3
"""Build the accepted owner-contract REPORT_ONLY service candidate.

The exact REL-52L archive is used only as the verified Windows carrier for its
EXE, Node dependencies and reference catalogs.  Accepted CR-A/CR-B production
sources are overlaid from one exact Git head.  Business inputs and outputs are
never copied into the candidate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


WORK_ID = "OPIU-2026-08-25-PKG-SPORNO-FILES-FULL-YEAR-001"
SCHEMA_VERSION = "opiu-owner-contract-service-candidate.v1"
BASE_ARCHIVE_SHA256 = "7C7BA85806B3D609684FCFB30EDE57E50C73C0EE9A9AC0A544C64708C6B95A3A"
BASE_RUNTIME_SOURCE_SHA = "f36a35aea0e69832f20de6abbe4d3ff391267303"
BASE_SERVICE_EXE_SHA256 = "EE65F9BC1BA43173BAB7F552BDDCEA56F20676E2C5EAB97520D70AC770E7267C"
ACCEPTED_ECONOMIC_RESULT = "12283f9b5292b319030c67b28045f380849af34b"
ACCEPTED_RULES_HANDOFF_RESULT = "10491026005ce46d47c2b0187b5b60a0f7d588ce"
ACCEPTED_R001_SPORNO_RESULT = "3ac9ffbd58b904c8130854aed1bcf547d59beeb8"
FIXED_ZIP_TIME = (2026, 8, 24, 0, 0, 0)

PRODUCTION_OVERLAYS = (
    "modules/corrections/source/correction_engine_r001.mjs",
    "modules/corrections/source/r001_canonical_output_contract.mjs",
    "modules/corrections/source/r001_materialization_contract.mjs",
    "modules/corrections/source/rules_application_handoff.mjs",
    "modules/reconciliation/source/owner_decision_projection.mjs",
    "modules/reconciliation/source/owner_presentation_block_exemption.mjs",
    "modules/reconciliation/source/economic_route_proof_binding.mjs",
    "modules/reconciliation/source/generic_reclassification_detection.mjs",
    "modules/reconciliation/source/opiu_reconcile.mjs",
    "modules/reconciliation/source/service_r005_owner_wrapper.mjs",
    "modules/reconciliation/source/residual_allocation_proof.mjs",
    "modules/reconciliation/source/structural_control_groups.mjs",
    "modules/reconciliation/source/structural_control_settings_binding.mjs",
    "modules/reconciliation/source/owner_economic_route_proofs/uk9_2025_10_owner_approved.json",
    "modules/rules-engine/source/adapters/r005_adapter.mjs",
    "modules/rules-engine/source/handoff.mjs",
    "modules/rules-engine/source/workflow.mjs",
    "user-settings/Настройка_группировки_блоков.csv",
    "user-settings/КАК_НАСТРОИТЬ_ГРУППИРОВКУ.txt",
)

FORBIDDEN_PARTS = {
    ".git", "__pycache__", ".pytest_cache", "work", "tmp", "temp",
    "outputs", "runtime-cache",
}


class BuildError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise BuildError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def regular_files(root: Path) -> list[Path]:
    return sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.relative_to(root).as_posix())


def inventory(root: Path, excluded: set[str] | None = None) -> list[dict[str, Any]]:
    excluded = excluded or set()
    return [
        {"path": item.relative_to(root).as_posix(), "size": item.stat().st_size, "sha256": sha256(item)}
        for item in regular_files(root)
        if item.relative_to(root).as_posix() not in excluded
    ]


def checked_extract(archive: Path, target: Path) -> Path:
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            pure = PurePosixPath(member.filename)
            if pure.is_absolute() or ".." in pure.parts:
                raise BuildError(f"UNSAFE_ARCHIVE_ENTRY:{member.filename}")
        source.extractall(target)
    bundle = target / "OPIU"
    if not bundle.is_dir():
        raise BuildError("BASE_BUNDLE_ROOT_MISSING")
    return bundle


def git_output(repository: Path, arguments: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        text=True, encoding="utf-8", errors="strict",
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode != 0:
        raise BuildError(f"GIT_COMMAND_FAILED:{arguments[0]}:{result.stderr.strip()}")
    return result.stdout.strip()


def verify_lineage(repository: Path, source_head: str) -> None:
    actual = git_output(repository, ["rev-parse", "HEAD"]).lower()
    if actual != source_head.lower():
        raise BuildError(f"SOURCE_HEAD_MISMATCH:{actual}")
    for label, accepted_result in (
        ("ACCEPTED_ECONOMIC_RESULT", ACCEPTED_ECONOMIC_RESULT),
        ("ACCEPTED_RULES_HANDOFF_RESULT", ACCEPTED_RULES_HANDOFF_RESULT),
        ("ACCEPTED_R001_SPORNO_RESULT", ACCEPTED_R001_SPORNO_RESULT),
    ):
        result = subprocess.run(
            ["git", "-C", str(repository), "merge-base", "--is-ancestor", accepted_result, source_head],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            raise BuildError(f"{label}_NOT_ANCESTOR")


def assert_report_only(safety: dict[str, Any]) -> None:
    expected_false = (
        "ready_to_upload", "release_allowed", "execution_allowed",
        "live_1c_allowed", "live_delete_allowed",
    )
    if safety.get("mode") != "REPORT_ONLY" or safety.get("posting_rows") != 0:
        raise BuildError("BASE_SAFETY_NOT_REPORT_ONLY")
    if any(safety.get(key) is not False for key in expected_false if key in safety):
        raise BuildError("BASE_SAFETY_GATE_OPEN")


def update_runtime_manifest(runtime: Path, source_head: str, overlay_hashes: dict[str, str]) -> None:
    manifest_path = runtime / "MANIFEST.json"
    manifest = load_json(manifest_path)
    by_path = {row["path"]: row for row in manifest.get("files", []) if isinstance(row, dict) and row.get("path")}
    for relative, file_hash in overlay_hashes.items():
        target = runtime / relative
        by_path[relative] = {
            "path": relative,
            "size": target.stat().st_size,
            "sha256": file_hash,
            "classification": "RUNTIME_SOURCE",
            "source": f"{WORK_ID}: accepted source at {source_head}",
        }
    safety_path = runtime / "SAFETY.json"
    by_path["SAFETY.json"] = {
        "path": "SAFETY.json",
        "size": safety_path.stat().st_size,
        "sha256": sha256(safety_path),
        "classification": "RUNTIME_SAFETY",
        "source": f"{WORK_ID}: hard REPORT_ONLY safety",
    }
    manifest["files"] = [by_path[key] for key in sorted(by_path)]
    manifest["owner_contract_candidate"] = {
        "work_id": WORK_ID,
        "source_head": source_head,
        "accepted_economic_result": ACCEPTED_ECONOMIC_RESULT,
        "accepted_rules_handoff_result": ACCEPTED_RULES_HANDOFF_RESULT,
        "accepted_r001_sporno_result": ACCEPTED_R001_SPORNO_RESULT,
        "full_year_strategy": "TWELVE_MONTH_LOCAL_CONTEXTS",
        "cross_month_netting": False,
        "production_overlay_hashes": overlay_hashes,
    }
    manifest["safety"] = {
        "mode": "REPORT_ONLY", "report_only": True,
        "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
        "ready_to_upload": False, "release_allowed": False,
        "execution_allowed": False, "live_1c_allowed": False,
        "live_delete_allowed": False,
    }
    manifest_path.write_bytes(json_bytes(manifest))


def write_zip(bundle: Path, output: Path) -> None:
    if output.exists():
        raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in regular_files(bundle):
            relative = item.relative_to(bundle).as_posix()
            info = zipfile.ZipInfo(f"OPIU/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def assemble_bundle(bundle: Path, repository: Path, source_head: str, *, verify_git: bool = True) -> dict[str, Any]:
    if verify_git:
        verify_lineage(repository, source_head)
    provenance_path = bundle / "BUNDLE_PROVENANCE.json"
    provenance = load_json(provenance_path)
    if provenance.get("runtime_source_sha") != BASE_RUNTIME_SOURCE_SHA:
        raise BuildError("BASE_RUNTIME_SOURCE_MISMATCH")
    service = bundle / "OPIU_STABLE_Service.exe"
    if not service.is_file() or sha256(service) != BASE_SERVICE_EXE_SHA256:
        raise BuildError("BASE_SERVICE_EXE_MISMATCH")
    runtime = bundle / "runtime"
    safety_path = runtime / "SAFETY.json"
    safety = load_json(safety_path)
    assert_report_only(safety)

    overlay_hashes: dict[str, str] = {}
    for relative in PRODUCTION_OVERLAYS:
        source = repository / "development" / "OPIU_1.9.4" / relative
        if not source.is_file():
            raise BuildError(f"OVERLAY_SOURCE_MISSING:{relative}")
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        overlay_hashes[relative] = sha256(target)

    safety.update({
        "candidate_status": "OWNER_CONTRACT_REPORT_ONLY_CANDIDATE",
        "work_id": WORK_ID,
        "runtime_source_sha": source_head,
        "mode": "REPORT_ONLY", "report_only": True,
        "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
        "ready_to_upload": False, "release_allowed": False,
        "execution_allowed": False, "live_1c_allowed": False,
        "live_delete_allowed": False,
    })
    safety_path.write_bytes(json_bytes(safety))
    update_runtime_manifest(runtime, source_head, overlay_hashes)

    candidate = {
        "schema_version": SCHEMA_VERSION,
        "work_id": WORK_ID,
        "source_head": source_head,
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "base_runtime_source_sha": BASE_RUNTIME_SOURCE_SHA,
        "service_exe_sha256": BASE_SERVICE_EXE_SHA256,
        "accepted_economic_result": ACCEPTED_ECONOMIC_RESULT,
        "accepted_rules_handoff_result": ACCEPTED_RULES_HANDOFF_RESULT,
        "accepted_r001_sporno_result": ACCEPTED_R001_SPORNO_RESULT,
        "production_overlay_hashes": overlay_hashes,
        "full_year_strategy": "TWELVE_MONTH_LOCAL_CONTEXTS",
        "cross_month_netting": False,
        "business_inputs_included": False,
        "safety": {
            "mode": "REPORT_ONLY", "posting_rows": 0,
            "executed_posting_rows": 0, "live_posting_rows": 0,
            "ready_to_upload": False, "release_allowed": False,
            "execution_allowed": False, "live_1c_allowed": False,
        },
    }
    provenance["owner_contract_candidate"] = candidate
    provenance_path.write_bytes(json_bytes(provenance))
    (bundle / "OWNER_CONTRACT_CANDIDATE.json").write_bytes(json_bytes(candidate))
    (bundle / "OWNER_CONTRACT_PRODUCT_INFO.txt").write_text(
        "\n".join([
            "OPIU_STABLE 1.9.4 — OWNER CONTRACT REPORT_ONLY CANDIDATE",
            f"WORK-ID: {WORK_ID}",
            f"SOURCE HEAD: {source_head}",
            "READY: only complete exact physical ERP source.",
            "_СПОРНО: known direction with incomplete physical source; unknown fields stay empty.",
            "STORNO amounts are negative; REPOST amounts are positive.",
            "Full year is twelve isolated month contexts; cross-month netting is forbidden.",
            "posting_rows=0; ready_to_upload=false; release_allowed=false; live_1c_allowed=false.",
            "",
        ]),
        encoding="utf-8",
    )
    leaked = [
        item.relative_to(bundle).as_posix()
        for item in bundle.rglob("*")
        if any(part.lower() in FORBIDDEN_PARTS for part in item.relative_to(bundle).parts)
    ]
    if leaked:
        raise BuildError(f"FORBIDDEN_PACKAGE_PATHS:{leaked[:10]}")
    manifest = {**candidate, "files": inventory(bundle, {"BUNDLE_MANIFEST.json"})}
    manifest["file_count"] = len(manifest["files"])
    (bundle / "BUNDLE_MANIFEST.json").write_bytes(json_bytes(manifest))
    return candidate


def build(base_archive: Path, repository: Path, output: Path, source_head: str) -> dict[str, Any]:
    if not base_archive.is_file() or sha256(base_archive) != BASE_ARCHIVE_SHA256:
        raise BuildError("BASE_ARCHIVE_HASH_MISMATCH")
    with tempfile.TemporaryDirectory(prefix="opiu-owner-contract-candidate-") as temporary:
        bundle = checked_extract(base_archive, Path(temporary))
        candidate = assemble_bundle(bundle, repository, source_head, verify_git=True)
        write_zip(bundle, output)
    return {
        "status": "BUILT",
        "package": str(output),
        "size": output.stat().st_size,
        "sha256": sha256(output),
        **candidate,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-archive", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-head", required=True)
    args = parser.parse_args()
    result = build(
        args.base_archive.resolve(), args.repository.resolve(),
        args.output.resolve(), args.source_head.strip().lower(),
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
