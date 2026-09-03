#!/usr/bin/env python3
"""Build a review-only bundle for the new OPIU_STABLE Service implementation.

The script consumes two explicit inputs:
- a verified source executable built from development/OPIU_1.9.4/service/source;
- the already-reviewed 1.9.4 REPORT_ONLY runtime payload extracted from the
  pinned owner-validation package.

It does not reconstruct the deleted historical Go source and does not grant
release or live-1C authority.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

# Keep the archive root intentionally short. Windows Explorer still applies
# legacy full-path limits while extracting ZIP files into a user-selected
# destination, and the pinned spreadsheet runtime contains necessary nested
# dependency paths.
BUNDLE_NAME = "OPIU"
REQUIRED_RUNTIME_FILES = (
    "MANIFEST.json",
    "SAFETY.json",
    "runtime/node/node.exe",
    "modules/reconciliation/source/opiu_reconcile.mjs",
    "modules/corrections/source/correction_engine_r001.mjs",
)
LEGACY_RULES_RUNTIME_PATHS = (
    "modules/rules-engine",
    "data/defaults/rules.json",
)
RUNTIME_DIRS = (
    "modules",
    "data/defaults",
    "resources/reference",
    "runtime",
)
ROOT_METADATA = (
    "MANIFEST.json",
    "SAFETY.json",
    "VERSION.txt",
)
FIXED_ZIP_TIME = (2026, 8, 13, 0, 0, 0)
INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION = (
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_CONTROLS_R001_RESULT_CONTRACT_FIX"
)
INTEGRATED_R001_DEDUP_IMPLEMENTATION = (
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_CONTROLS_R001_RESULT_DEDUP_FIX"
)
INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION = (
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_CONTROLS_R001_RESULT_DEDUP_"
    "R005_CATALOG_BINDING_TEST_REPORT_ONLY"
)
SERVICE_IMPLEMENTATIONS = {
    "NEW_COMPATIBLE_IMPLEMENTATION",
    "OWNER_GREEN_SERVICE_EXACT",
    "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

GREEN_UI_IMPLEMENTATIONS = {
    "OWNER_GREEN_SERVICE_EXACT",
    "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

SOURCE_PERSISTENCE_IMPLEMENTATIONS = {
    "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

RULES_UI_CHANGED_IMPLEMENTATIONS = {
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

RULES_BULK_DECISION_IMPLEMENTATIONS = {
    "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

# The historical Rules-engine implementation was retired. These compatibility
# fields remain false in bundle evidence and carry no source/hash expectations.
RULES_REPORT_CONTROLS_IMPLEMENTATIONS: set[str] = set()

R001_RESULT_CONTRACT_IMPLEMENTATIONS = {
    INTEGRATED_RESULT_CONTRACT_IMPLEMENTATION,
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

R001_CROSS_SOURCE_DEDUP_IMPLEMENTATIONS = {
    INTEGRATED_R001_DEDUP_IMPLEMENTATION,
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

RULES_OUTPUT_SAFETY_PASSPORT_IMPLEMENTATIONS: set[str] = set()

R005_CATALOG_BINDING_IMPLEMENTATIONS = {
    INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
}

EXPECTED_PREPARED_R005_MANIFEST_SHA256 = (
    "4151120FC9B022A57FB7090B4BA7E9AB0C478936235026C5502D536223334AF3"
)
EXPECTED_R005_CATALOG_PREPARED_R005_MANIFEST_SHA256 = (
    "C6B41BC5F5CD832B68668172BFBD664F7623738B86D5D794B738797166DA9E30"
)
EXPECTED_RESULT_CONTRACT_MATERIALIZED_PAYLOAD_FILE_COUNT = 417
EXPECTED_RESULT_CONTRACT_MATERIALIZED_PAYLOAD_INVENTORY_SHA256 = (
    "B0CD437F87041F04E4C230DA2821F3961D391E4BEEA94FA645628B599FA417D9"
)
EXPECTED_MATERIALIZED_PAYLOAD_FILE_COUNT = 419
EXPECTED_MATERIALIZED_PAYLOAD_INVENTORY_SHA256 = (
    "ACFED48D9F17D65C84D704F6D358D0ECED6E3B26CB0696C1BD8E9BEC1CB6D2A6"
)
EXPECTED_INTEGRATED_RUNTIME_MANIFEST_SHA256 = (
    "1C086A240F2FCD53DAC70459F0433907C3B8FE3CFC99310D81D4CDD67826F393"
)
EXPECTED_INTEGRATED_RUNTIME_SAFETY_SHA256 = (
    "CA5BBC6BCF93A0F9611F5BD3781E62E425F28E7ADA4F0908DB38448D6672EB73"
)
EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_FILE_COUNT = 432
EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_INVENTORY_SHA256 = (
    "379EE57BCAC7FC6FE80BB3002CCCAE92E46E93037F5BD327E5595F70D61EF4A3"
)
EXPECTED_R005_CATALOG_RUNTIME_MANIFEST_SHA256 = (
    "C8EAD69EA82C3808C484B63E624DE9953AF0FEBA613A6493401441E475F69B84"
)
EXPECTED_R005_CATALOG_RUNTIME_SAFETY_SHA256 = (
    "A89CAFD1602DB04BFA30EFA72377306132AE3B76332E7A0BDBA7F22E294937D1"
)
EXPECTED_R005_CATALOG_OWNER_BUNDLE_SHA256 = (
    "7AFA29573AE82FDC30DFC8528AA1F2678E82F05E13CCE95018C0F4456C786167"
)
EXPECTED_R005_CATALOG_OWNER_MANIFEST_DRIFT = {
    "modules/corrections/source/rules_application_handoff.mjs": {
        "recorded_size": 7702,
        "actual_size": 13851,
        "recorded_sha256":
            "DCD3A40D42E06BE0D15BB93BA1AB9A2E2C40EB82A7FF4FFDC2870C117A29C0B8",
        "actual_sha256":
            "CDA096B6A395C43BA8645D919F7F908B9120945196ABFDFEED148357C67C0B80",
    },
    "modules/reconciliation/source/config.json": {
        "recorded_size": 1389,
        "actual_size": 1462,
        "recorded_sha256":
            "B19A8AF953D963450702CB30BC22B4E9B192B8A72537CB65EDE31B48F22B987E",
        "actual_sha256":
            "22A9C87FDAB7D033713236D69F8CE8CF30E1E8CFB17A76F255716987B44062BE",
    },
    "modules/reconciliation/source/hierarchy_tree.mjs": {
        "recorded_size": 25248,
        "actual_size": 30149,
        "recorded_sha256":
            "450457A2B660684FAF832A8AB7BBC7C7F1757C132E4987715262C129E4A29216",
        "actual_sha256":
            "6C2906C1ECFA3AFE77A7167B0976C5BA20B0D0942D9D9C22A55733408B9865D0",
    },
    "modules/reconciliation/source/opiu_reconcile.mjs": {
        "recorded_size": 262189,
        "actual_size": 263721,
        "recorded_sha256":
            "FF83F015DABFACD0EA271E7EE781A14061CCBF09FA2339042A9352E2E2648B67",
        "actual_sha256":
            "B7DD884CD4D5B81966E8FCC36F8016860F5E3E5A5672E85B34332F8628B3F97E",
    },
    "modules/rules-engine/source/adapters/r005_adapter.mjs": {
        "recorded_size": 18688,
        "actual_size": 18868,
        "recorded_sha256":
            "7FFFAE4861E0260D2F8E87DC0D051AF061C2A5ED4B74D9AD1DEA81F704E06942",
        "actual_sha256":
            "FC9CB1AA39B5FF7D3CFC6649EAC2E6D822F02B28A6241F0CCEE1106DFB05F49B",
    },
    "modules/rules-engine/source/engine.mjs": {
        "recorded_size": 11284,
        "actual_size": 11291,
        "recorded_sha256":
            "B9FF7C6CC82439DC0365C80F0E4D6B82C36BCCBCDA9A4103276958AE5BF6C82D",
        "actual_sha256":
            "13FD773853388CF3158854048369E007F2AF2A6BBAE6902065E1ECB6FBBC8C9D",
    },
    "modules/rules-engine/source/matcher.mjs": {
        "recorded_size": 10398,
        "actual_size": 15129,
        "recorded_sha256":
            "1F90A80111CAB722297B4EA7E11AA15F31D46CFD3CC2EF410353EC67112848A5",
        "actual_sha256":
            "031DE5B428C0740B89134C2CA6D0345CDFE54FF0D1FFDC00C1210C160FBC6DA5",
    },
    "modules/rules-engine/source/normalize.mjs": {
        "recorded_size": 11232,
        "actual_size": 11548,
        "recorded_sha256":
            "B7727530C1D418AA75EDA84F19239DC4C9D7EF96400EFACF0C1DA004C1063727",
        "actual_sha256":
            "C5A9EC3FB788E740D533812F0E6433622642D6F5051D5F03075287760DC56C47",
    },
}
EXPECTED_RESULT_CONTRACT_CHANGE_REQUESTS = [
    "CR-R005-20260815-UK9-001",
    "CR-R001-20260816-CROSS-SOURCE-DEDUP-001",
]
EXPECTED_INTEGRATED_CHANGE_REQUESTS = [
    "CR-R005-20260815-UK9-001",
    "CR-R001-20260816-CROSS-SOURCE-DEDUP-001",
]
EXPECTED_R005_CATALOG_CHANGE_REQUESTS = [
    "CR-R005-20260815-UK9-001",
    "CR-R001-20260816-CROSS-SOURCE-DEDUP-001",
    "CR-R005-20260817-INTALEV-CATALOG-AUTO-BINDING-001",
]
EXPECTED_R001_BASE_COMMIT = "6d1386e5d9a10a22a75c483845f62ce28ce6b496"
EXPECTED_R001_RESULT_COMMIT = "da024306c7edb515df1ae57a1ee219067b06faed"
EXPECTED_R005_CATALOG_BASE_COMMIT = "8789974ed0bdd4a5c18c3c3973ceff2ae787f064"
EXPECTED_R005_CATALOG_RESULT_COMMIT = "0848141cbe67b7f891f547cce9e25fcf8dea017d"
EXPECTED_R005_CATALOG_HANDOFF_HEAD = "ee78a5fed6fd897dbf4c9da4bd0da1a2f41b9185"
# Compatibility metadata for the separate exact-owner golden test. It is not
# used as a current overlay source or validation requirement.
EXPECTED_INTEGRATION_RELEASE_BASE_COMMIT = (
    "7dc94e1cb9102f2e7effd974b94f6f6a64840903"
)
EXPECTED_RULES_REPORT_CONTROLS_HASHES: dict[str, str] = {}

EXPECTED_R001_CORRECTIONS_HASHES = {
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

EXPECTED_RULES_OUTPUT_SAFETY_HASHES: dict[str, str] = {}

EXPECTED_R005_CATALOG_HASHES = {
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

EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES: dict[str, str] = {}

BYTE_IDENTICAL_GREEN_UI_IMPLEMENTATIONS = {
    "OWNER_GREEN_SERVICE_EXACT",
    "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
}


class BundleError(RuntimeError):
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
        raise BundleError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def require_regular(path: Path, label: str) -> None:
    if not path.is_file() or path.is_symlink():
        raise BundleError(f"{label}_MISSING:{path}")


def validate_payload(payload_root: Path) -> dict[str, Any]:
    for relative in LEGACY_RULES_RUNTIME_PATHS:
        if (payload_root / Path(relative)).exists():
            raise BundleError(f"LEGACY_RULES_RUNTIME_PRESENT:{relative}")
    for relative in REQUIRED_RUNTIME_FILES:
        require_regular(payload_root / Path(relative), "RUNTIME")

    safety = load_json(payload_root / "SAFETY.json")
    if (
        safety.get("mode") != "REPORT_ONLY"
        or safety.get("posting_rows") != 0
        or safety.get("ready_to_upload") is not False
        or safety.get("release_allowed") is not False
        or safety.get("one_c_actions_executed") is not False
        or safety.get("live_1c_allowed") is not False
    ):
        raise BundleError("RUNTIME_SAFETY_CONTRACT_FAILED")

    manifest = load_json(payload_root / "MANIFEST.json")
    if manifest.get("schema") != "opiu-package-manifest.v2":
        raise BundleError("RUNTIME_MANIFEST_SCHEMA_MISMATCH")
    if manifest.get("package_id") != "OPIU_SERVICE_PAYLOAD_1.9.4":
        raise BundleError("RUNTIME_PACKAGE_ID_MISMATCH")
    manifest_safety = manifest.get("safety") or {}
    if (
        manifest_safety.get("mode") != "REPORT_ONLY"
        or manifest_safety.get("posting_rows") != 0
        or manifest_safety.get("ready_to_upload") is not False
        or manifest_safety.get("release_allowed") is not False
        or manifest_safety.get("live_1c_allowed") is not False
    ):
        raise BundleError("RUNTIME_MANIFEST_SAFETY_FAILED")

    expected = {
        str(item["path"]): str(item["sha256"]).upper()
        for item in manifest.get("files", [])
        if isinstance(item, dict) and item.get("path") and item.get("sha256")
    }
    for relative in REQUIRED_RUNTIME_FILES:
        if relative not in expected:
            # The payload manifest intentionally excludes the manifest itself
            # and the Node executable. They are still required, inventoried and
            # bound by the resulting bundle manifest.
            if relative in {"MANIFEST.json", "runtime/node/node.exe"}:
                continue
            raise BundleError(f"RUNTIME_FILE_NOT_IN_MANIFEST:{relative}")
        actual = sha256_file(payload_root / Path(relative))
        if actual != expected[relative]:
            raise BundleError(f"RUNTIME_HASH_MISMATCH:{relative}:{actual}:{expected[relative]}")
    return manifest


def materialized_payload_inventory_rows(payload_root: Path) -> list[dict[str, Any]]:
    """List every source byte materialize_runtime copies, excluding MANIFEST."""
    sources: dict[str, Path] = {}
    for relative in ROOT_METADATA:
        if relative == "MANIFEST.json":
            continue
        path = payload_root / relative
        require_regular(path, "MATERIALIZED_ROOT")
        sources[relative] = path

    for relative in RUNTIME_DIRS:
        source = payload_root / Path(relative)
        if not source.is_dir() or source.is_symlink():
            raise BundleError(f"MATERIALIZED_DIRECTORY_MISSING:{relative}")
        for root, dirs, files in os.walk(source):
            dirs[:] = sorted(
                item
                for item in dirs
                if not (relative == "modules" and item == "node_modules")
            )
            root_path = Path(root)
            for name in sorted(files):
                path = root_path / name
                require_regular(path, "MATERIALIZED_FILE")
                destination = path.relative_to(payload_root).as_posix()
                sources[destination] = path

    shared_modules = payload_root / "modules/corrections/source/node_modules"
    if not shared_modules.is_dir() or shared_modules.is_symlink():
        raise BundleError("SHARED_NODE_MODULES_MISSING")
    for root, dirs, files in os.walk(shared_modules):
        dirs[:] = sorted(dirs)
        root_path = Path(root)
        for name in sorted(files):
            path = root_path / name
            require_regular(path, "MATERIALIZED_FILE")
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
    return rows


def materialized_payload_inventory(payload_root: Path) -> dict[str, Any]:
    """Hash every source byte materialize_runtime copies, excluding MANIFEST."""
    rows = materialized_payload_inventory_rows(payload_root)
    payload = (json.dumps(
        rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n").encode("utf-8")
    return {
        "file_count": len(rows),
        "sha256": sha256_bytes(payload),
    }


def validate_r005_catalog_materialized_provenance(
    *,
    owner_bundle_sha256: object,
    owner_manifest_drift: object,
    file_count: object,
    inventory_sha256: object,
    manifest_sha256: object,
    safety_sha256: object,
) -> None:
    """Validate the exact OWNER-derived final-builder provenance pins."""
    if owner_bundle_sha256 != EXPECTED_R005_CATALOG_OWNER_BUNDLE_SHA256:
        raise BundleError("INTEGRATED_RUNTIME_OWNER_BUNDLE_SHA256_MISMATCH")
    if owner_manifest_drift != EXPECTED_R005_CATALOG_OWNER_MANIFEST_DRIFT:
        raise BundleError("INTEGRATED_RUNTIME_OWNER_MANIFEST_DRIFT_MISMATCH")
    if file_count != EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_FILE_COUNT:
        raise BundleError("INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH")
    if inventory_sha256 != EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_INVENTORY_SHA256:
        raise BundleError("INTEGRATED_RUNTIME_INVENTORY_PROVENANCE_MISMATCH")
    if manifest_sha256 != EXPECTED_R005_CATALOG_RUNTIME_MANIFEST_SHA256:
        raise BundleError(
            f"INTEGRATED_RUNTIME_MANIFEST_SHA256_MISMATCH:{manifest_sha256}"
        )
    if safety_sha256 != EXPECTED_R005_CATALOG_RUNTIME_SAFETY_SHA256:
        raise BundleError("INTEGRATED_RUNTIME_R001_SAFETY_SHA256_MISMATCH")


def service_source_inventory(source_root: Path) -> dict[str, Any]:
    """Inventory the Go build, embedded web, and local regression inputs."""
    source_root = source_root.resolve()
    if not source_root.is_dir() or source_root.is_symlink():
        raise BundleError(f"SERVICE_SOURCE_ROOT_MISSING:{source_root}")
    paths: list[Path] = []
    for path in sorted(source_root.glob("*.go")):
        require_regular(path, "SERVICE_SOURCE")
        paths.append(path)
    for name in ("go.mod", "go.sum", "IMPLEMENTATION_PROVENANCE.json"):
        path = source_root / name
        if path.exists():
            require_regular(path, "SERVICE_SOURCE")
            paths.append(path)
    for relative in ("web", "web_tests"):
        root = source_root / relative
        if not root.is_dir() or root.is_symlink():
            raise BundleError(f"SERVICE_SOURCE_DIRECTORY_MISSING:{relative}")
        for path in sorted(item for item in root.rglob("*") if item.is_file()):
            require_regular(path, "SERVICE_SOURCE")
            paths.append(path)
    if not paths:
        raise BundleError("SERVICE_SOURCE_INVENTORY_EMPTY")

    rows = [
        {
            "path": path.relative_to(source_root).as_posix(),
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        for path in sorted(set(paths))
    ]
    payload = (json.dumps(
        rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n").encode("utf-8")
    results_ui = source_root / "web/results-ui.js"
    require_regular(results_ui, "EMBEDDED_RESULTS_UI")
    return {
        "file_count": len(rows),
        "sha256": sha256_bytes(payload),
        "embedded_results_ui_sha256": sha256_file(results_ui),
    }


def verify_source_commit(source_root: Path, claimed_commit: str) -> str:
    head = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "HEAD"],
        text=True,
        encoding="utf-8",
        errors="strict",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if head.returncode != 0:
        raise BundleError("SERVICE_SOURCE_GIT_HEAD_UNAVAILABLE")
    actual_commit = head.stdout.strip().lower()
    if actual_commit != claimed_commit:
        raise BundleError(f"SERVICE_SOURCE_COMMIT_MISMATCH:{actual_commit}:{claimed_commit}")
    status = subprocess.run(
        ["git", "-C", str(source_root), "status", "--porcelain", "--", "."],
        text=True,
        encoding="utf-8",
        errors="strict",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if status.returncode != 0:
        raise BundleError("SERVICE_SOURCE_GIT_STATUS_UNAVAILABLE")
    if status.stdout.strip():
        raise BundleError("SERVICE_SOURCE_WORKTREE_NOT_CLEAN")
    return actual_commit


def validate_service_build_provenance(
    implementation: str,
    service_exe: Path,
    service_exe_second: Path | None,
    service_source_root: Path | None,
    source_commit: str,
) -> dict[str, Any]:
    provenance_requested = service_source_root is not None or bool(source_commit.strip())
    if implementation not in R001_RESULT_CONTRACT_IMPLEMENTATIONS and not provenance_requested:
        return {
            "source_commit": "",
            "source_file_count": 0,
            "source_inventory_sha256": "",
            "embedded_results_ui_sha256": "",
            "deterministic_double_build": False,
        }
    if service_exe_second is None:
        raise BundleError("SECOND_SERVICE_EXE_REQUIRED")
    service_exe_second = service_exe_second.resolve()
    require_regular(service_exe_second, "SECOND_SERVICE_EXE")
    if service_exe_second == service_exe:
        raise BundleError("SECOND_SERVICE_EXE_MUST_BE_DISTINCT")
    first_hash = sha256_file(service_exe)
    second_hash = sha256_file(service_exe_second)
    if first_hash != second_hash:
        raise BundleError(f"SERVICE_EXE_NONDETERMINISTIC:{first_hash}:{second_hash}")
    if service_source_root is None:
        raise BundleError("SERVICE_SOURCE_ROOT_REQUIRED")
    normalized_commit = source_commit.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", normalized_commit):
        raise BundleError("SERVICE_SOURCE_COMMIT_INVALID")
    normalized_commit = verify_source_commit(service_source_root, normalized_commit)
    source = service_source_inventory(service_source_root)
    return {
        "source_commit": normalized_commit,
        "source_file_count": source["file_count"],
        "source_inventory_sha256": source["sha256"],
        "embedded_results_ui_sha256": source["embedded_results_ui_sha256"],
        "deterministic_double_build": True,
        "second_service_exe_sha256": second_hash,
    }


def validate_implementation_payload(
    payload_root: Path,
    manifest: dict[str, Any],
    implementation: str,
) -> None:
    if implementation not in R001_RESULT_CONTRACT_IMPLEMENTATIONS:
        return

    r001_dedup = implementation in R001_CROSS_SOURCE_DEDUP_IMPLEMENTATIONS
    r005_catalog = implementation in R005_CATALOG_BINDING_IMPLEMENTATIONS
    expected_change_requests = (
        EXPECTED_R005_CATALOG_CHANGE_REQUESTS
        if r005_catalog
        else (
            EXPECTED_INTEGRATED_CHANGE_REQUESTS
            if r001_dedup
            else EXPECTED_RESULT_CONTRACT_CHANGE_REQUESTS
        )
    )
    expected_file_count = (
        EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_FILE_COUNT
        if r005_catalog
        else (
            EXPECTED_MATERIALIZED_PAYLOAD_FILE_COUNT
            if r001_dedup
            else EXPECTED_RESULT_CONTRACT_MATERIALIZED_PAYLOAD_FILE_COUNT
        )
    )
    expected_inventory_sha256 = (
        EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_INVENTORY_SHA256
        if r005_catalog
        else (
            EXPECTED_MATERIALIZED_PAYLOAD_INVENTORY_SHA256
            if r001_dedup
            else EXPECTED_RESULT_CONTRACT_MATERIALIZED_PAYLOAD_INVENTORY_SHA256
        )
    )
    expected_prepared_r005_manifest_sha256 = (
        EXPECTED_R005_CATALOG_PREPARED_R005_MANIFEST_SHA256
        if r005_catalog
        else EXPECTED_PREPARED_R005_MANIFEST_SHA256
    )

    change = manifest.get("integrated_review_change")
    if not isinstance(change, dict):
        raise BundleError("INTEGRATED_RUNTIME_PROVENANCE_REQUIRED")
    if change.get("schema_version") != "opiu-integrated-runtime-review.v1":
        raise BundleError("INTEGRATED_RUNTIME_PROVENANCE_SCHEMA_MISMATCH")
    if (
        change.get("prepared_r005_manifest_sha256")
        != expected_prepared_r005_manifest_sha256
    ):
        raise BundleError("INTEGRATED_RUNTIME_R005_BASE_MISMATCH")
    if change.get("change_requests") != expected_change_requests:
        raise BundleError("INTEGRATED_RUNTIME_CHANGE_REQUESTS_MISMATCH")
    if change.get("rules_overlay_hashes") != EXPECTED_RULES_REPORT_CONTROLS_HASHES:
        raise BundleError("INTEGRATED_RUNTIME_RULES_HASH_SET_MISMATCH")
    if change.get("rules_safety_overlay_hashes") != EXPECTED_RULES_OUTPUT_SAFETY_HASHES:
        raise BundleError("INTEGRATED_RUNTIME_RULES_SAFETY_HASH_SET_MISMATCH")
    if (
        change.get("integration_release_overlay_hashes")
        != EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES
    ):
        raise BundleError("INTEGRATED_RUNTIME_RELEASE_HASH_SET_MISMATCH")
    if change.get("integration_release_packaging_only") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RELEASE_SCOPE_INVALID")
    if change.get("rules_report_controls_fix") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_CONTROLS_FIX_INVALID")
    if change.get("rules_output_safety_passport_fix") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_SAFETY_FIX_INVALID")
    if change.get("rules_financial_logic_changed") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_FINANCIAL_SCOPE_INVALID")
    if change.get("materialized_payload_file_count") != expected_file_count:
        raise BundleError("INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH")
    if (
        change.get("materialized_payload_inventory_sha256")
        != expected_inventory_sha256
    ):
        raise BundleError("INTEGRATED_RUNTIME_INVENTORY_PROVENANCE_MISMATCH")

    if r001_dedup:
        manifest_hash = sha256_file(payload_root / "MANIFEST.json")
        expected_manifest_hash = (
            EXPECTED_R005_CATALOG_RUNTIME_MANIFEST_SHA256
            if r005_catalog
            else EXPECTED_INTEGRATED_RUNTIME_MANIFEST_SHA256
        )
        if manifest_hash != expected_manifest_hash:
            raise BundleError(
                f"INTEGRATED_RUNTIME_MANIFEST_SHA256_MISMATCH:{manifest_hash}"
            )
        if change.get("r001_base_commit") != EXPECTED_R001_BASE_COMMIT:
            raise BundleError("INTEGRATED_RUNTIME_R001_BASE_COMMIT_MISMATCH")
        if change.get("r001_result_commit") != EXPECTED_R001_RESULT_COMMIT:
            raise BundleError("INTEGRATED_RUNTIME_R001_RESULT_COMMIT_MISMATCH")
        if change.get("corrections_overlay_hashes") != EXPECTED_R001_CORRECTIONS_HASHES:
            raise BundleError("INTEGRATED_RUNTIME_CORRECTIONS_HASH_SET_MISMATCH")
        if change.get("r001_cross_source_dedup_fix") is not True:
            raise BundleError("INTEGRATED_RUNTIME_R001_DEDUP_FIX_MISSING")
        if change.get("r001_financial_logic_changed") is not True:
            raise BundleError("INTEGRATED_RUNTIME_R001_FINANCIAL_SCOPE_MISSING")
        if change.get("financial_correctness_verified") is not False:
            raise BundleError("INTEGRATED_RUNTIME_FINANCIAL_QA_CLAIM_INVALID")

    if r005_catalog:
        if change.get("r005_catalog_base_commit") != EXPECTED_R005_CATALOG_BASE_COMMIT:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_BASE_COMMIT_MISMATCH")
        if change.get("r005_catalog_result_commit") != EXPECTED_R005_CATALOG_RESULT_COMMIT:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_RESULT_COMMIT_MISMATCH")
        if change.get("r005_catalog_handoff_head") != EXPECTED_R005_CATALOG_HANDOFF_HEAD:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_HANDOFF_HEAD_MISMATCH")
        if change.get("r005_catalog_overlay_hashes") != EXPECTED_R005_CATALOG_HASHES:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_HASH_SET_MISMATCH")
        if change.get("r005_intalev_catalog_auto_binding") is not True:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_FIX_MISSING")
        if change.get("r005_catalog_financial_logic_changed") is not False:
            raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_FINANCIAL_SCOPE_INVALID")
        if change.get("r005_organization_crosswalk_verified") is not False:
            raise BundleError("INTEGRATED_RUNTIME_R005_CROSSWALK_CLAIM_INVALID")
        if change.get("uk9_2025_twelve_month_final_audit") != "PENDING":
            raise BundleError("INTEGRATED_RUNTIME_R005_FINAL_AUDIT_CLAIM_INVALID")
        if change.get("package_bound_crosswalk") != "NOT_INCLUDED":
            raise BundleError("INTEGRATED_RUNTIME_R005_CROSSWALK_SCOPE_INVALID")
        if change.get("distribution_status") != "TEST_REPORT_ONLY":
            raise BundleError("INTEGRATED_RUNTIME_DISTRIBUTION_STATUS_INVALID")
        if change.get("user_delivery_approved") is not False:
            raise BundleError("INTEGRATED_RUNTIME_USER_DELIVERY_CLAIM_INVALID")

    manifest_rows = {
        str(row.get("path")): str(row.get("sha256", "")).upper()
        for row in manifest.get("files", [])
        if isinstance(row, dict) and row.get("path")
    }
    expected_materialized_rules_hashes = dict(EXPECTED_RULES_REPORT_CONTROLS_HASHES)
    for relative, expected_hash in expected_materialized_rules_hashes.items():
        if relative in EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES:
            continue
        if manifest_rows.get(relative) != expected_hash:
            raise BundleError(f"INTEGRATED_RUNTIME_MANIFEST_HASH_MISMATCH:{relative}")
        actual_hash = sha256_file(payload_root / Path(relative))
        if actual_hash != expected_hash:
            raise BundleError(f"INTEGRATED_RUNTIME_FILE_HASH_MISMATCH:{relative}")

    if r001_dedup:
        for relative, expected_hash in EXPECTED_R001_CORRECTIONS_HASHES.items():
            if relative in EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES:
                continue
            if manifest_rows.get(relative) != expected_hash:
                raise BundleError(
                    f"INTEGRATED_RUNTIME_CORRECTIONS_MANIFEST_HASH_MISMATCH:{relative}"
                )
            actual_hash = sha256_file(payload_root / Path(relative))
            if actual_hash != expected_hash:
                raise BundleError(
                    f"INTEGRATED_RUNTIME_CORRECTIONS_FILE_HASH_MISMATCH:{relative}"
                )

    if r005_catalog:
        for relative, expected_hash in EXPECTED_R005_CATALOG_HASHES.items():
            if relative in EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES:
                continue
            if manifest_rows.get(relative) != expected_hash:
                raise BundleError(
                    f"INTEGRATED_RUNTIME_R005_CATALOG_MANIFEST_HASH_MISMATCH:{relative}"
                )
            actual_hash = sha256_file(payload_root / Path(relative))
            if actual_hash != expected_hash:
                raise BundleError(
                    f"INTEGRATED_RUNTIME_R005_CATALOG_FILE_HASH_MISMATCH:{relative}"
                )

    for relative, expected_hash in EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES.items():
        if manifest_rows.get(relative) != expected_hash:
            raise BundleError(
                f"INTEGRATED_RUNTIME_RELEASE_MANIFEST_HASH_MISMATCH:{relative}"
            )
        actual_hash = sha256_file(payload_root / Path(relative))
        if actual_hash != expected_hash:
            raise BundleError(
                f"INTEGRATED_RUNTIME_RELEASE_FILE_HASH_MISMATCH:{relative}"
            )

    if r005_catalog:
        review_change = manifest.get("review_change")
        if not isinstance(review_change, dict):
            raise BundleError("INTEGRATED_RUNTIME_OWNER_PROVENANCE_REQUIRED")
        validate_r005_catalog_materialized_provenance(
            owner_bundle_sha256=review_change.get("base_bundle_sha256"),
            owner_manifest_drift=review_change.get("base_manifest_drift"),
            file_count=change.get("materialized_payload_file_count"),
            inventory_sha256=change.get("materialized_payload_inventory_sha256"),
            manifest_sha256=sha256_file(payload_root / "MANIFEST.json"),
            safety_sha256=sha256_file(payload_root / "SAFETY.json"),
        )

    materialized = materialized_payload_inventory(payload_root)
    if materialized["file_count"] != expected_file_count:
        raise BundleError("INTEGRATED_RUNTIME_MATERIALIZED_FILE_COUNT_MISMATCH")
    if materialized["sha256"] != expected_inventory_sha256:
        raise BundleError("INTEGRATED_RUNTIME_MATERIALIZED_INVENTORY_MISMATCH")

    safety = manifest.get("safety") or {}
    if (
        safety.get("mode") != "REPORT_ONLY"
        or safety.get("posting_rows") != 0
        or safety.get("execution_allowed") is not False
        or safety.get("ready_to_upload") is not False
        or safety.get("release_allowed") is not False
        or safety.get("live_1c_allowed") is not False
        or safety.get("rules_financial_logic_changed") is not False
    ):
        raise BundleError("INTEGRATED_RUNTIME_MANIFEST_SAFETY_FAILED")
    if r001_dedup and (
        safety.get("r001_cross_source_dedup_fix") is not True
        or safety.get("r001_financial_logic_changed") is not True
        or safety.get("financial_correctness_verified") is not False
    ):
        raise BundleError("INTEGRATED_RUNTIME_R001_MANIFEST_SAFETY_FAILED")
    if safety.get("rules_report_controls_changed") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_CONTROLS_MANIFEST_FAILED")
    if safety.get("rules_output_safety_passport_fix") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_SAFETY_MANIFEST_FAILED")
    if r005_catalog and (
        safety.get("r005_intalev_catalog_auto_binding") is not True
        or safety.get("r005_catalog_financial_logic_changed") is not False
        or safety.get("r005_organization_crosswalk_verified") is not False
        or safety.get("uk9_2025_twelve_month_final_audit_passed") is not False
    ):
        raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_MANIFEST_SAFETY_FAILED")

    runtime_safety = load_json(payload_root / "SAFETY.json")
    expected_safety_hash = (
        EXPECTED_R005_CATALOG_RUNTIME_SAFETY_SHA256
        if r005_catalog
        else EXPECTED_INTEGRATED_RUNTIME_SAFETY_SHA256
    )
    if r001_dedup and sha256_file(payload_root / "SAFETY.json") != expected_safety_hash:
        raise BundleError("INTEGRATED_RUNTIME_R001_SAFETY_SHA256_MISMATCH")
    if r001_dedup and (
        runtime_safety.get("execution_allowed") is not False
        or
        runtime_safety.get("r001_cross_source_dedup_fix") is not True
        or runtime_safety.get("r001_financial_logic_changed") is not True
        or runtime_safety.get("r001_change_request")
        != "CR-R001-20260816-CROSS-SOURCE-DEDUP-001"
    ):
        raise BundleError("INTEGRATED_RUNTIME_R001_SAFETY_PASSPORT_FAILED")
    if runtime_safety.get("rules_report_controls_changed") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_CONTROLS_PASSPORT_FAILED")
    if runtime_safety.get("rules_output_safety_passport_fix") is not False:
        raise BundleError("INTEGRATED_RUNTIME_RULES_SAFETY_PASSPORT_FAILED")
    if r005_catalog and (
        runtime_safety.get("r005_intalev_catalog_auto_binding") is not True
        or runtime_safety.get("r005_catalog_financial_logic_changed") is not False
        or runtime_safety.get("r005_organization_crosswalk_verified") is not False
        or runtime_safety.get("uk9_2025_twelve_month_final_audit_passed") is not False
        or runtime_safety.get("r005_catalog_change_request")
        != "CR-R005-20260817-INTALEV-CATALOG-AUTO-BINDING-001"
    ):
        raise BundleError("INTEGRATED_RUNTIME_R005_CATALOG_SAFETY_PASSPORT_FAILED")


def copy_file(source: Path, destination: Path) -> None:
    require_regular(source, "SOURCE")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes())
    os.chmod(destination, stat.S_IRUSR | stat.S_IWUSR)


def copy_tree(source: Path, destination: Path, *, skip_node_modules: bool = False) -> None:
    if not source.is_dir() or source.is_symlink():
        raise BundleError(f"SOURCE_DIRECTORY_MISSING:{source}")
    for root, dirs, files in os.walk(source):
        root_path = Path(root)
        dirs[:] = sorted(
            item
            for item in dirs
            if not (skip_node_modules and item == "node_modules")
        )
        relative_root = root_path.relative_to(source)
        for name in sorted(files):
            src = root_path / name
            if src.is_symlink():
                raise BundleError(f"SOURCE_SYMLINK_FORBIDDEN:{src}")
            copy_file(src, destination / relative_root / name)


def materialize_runtime(payload_root: Path, runtime_root: Path) -> None:
    for relative in ROOT_METADATA:
        copy_file(payload_root / relative, runtime_root / relative)
    for relative in RUNTIME_DIRS:
        source = payload_root / Path(relative)
        destination = runtime_root / Path(relative)
        copy_tree(source, destination, skip_node_modules=relative == "modules")

    source_modules = payload_root / "modules/corrections/source/node_modules"
    destination_modules = runtime_root / "node_modules"
    copy_tree(source_modules, destination_modules)


def inventory(root: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        data = path.read_bytes()
        rows.append({
            "path": relative,
            "size": len(data),
            "sha256": sha256_bytes(data),
        })
    return rows


def write_deterministic_zip(root: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(item for item in root.rglob("*") if item.is_file()):
            relative = PurePosixPath(BUNDLE_NAME) / PurePosixPath(path.relative_to(root).as_posix())
            info = zipfile.ZipInfo(relative.as_posix(), FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.flag_bits |= 0x800
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def build(
    payload_root: Path,
    service_exe: Path,
    output_root: Path,
    implementation: str = "NEW_COMPATIBLE_IMPLEMENTATION",
    service_exe_second: Path | None = None,
    service_source_root: Path | None = None,
    source_commit: str = "",
) -> dict[str, Any]:
    payload_root = payload_root.resolve()
    service_exe = service_exe.resolve()
    output_root = output_root.resolve()
    require_regular(service_exe, "SERVICE_EXE")
    if implementation not in SERVICE_IMPLEMENTATIONS:
        raise BundleError(f"SERVICE_IMPLEMENTATION_INVALID:{implementation}")
    manifest = validate_payload(payload_root)
    validate_implementation_payload(payload_root, manifest, implementation)
    service_build = validate_service_build_provenance(
        implementation,
        service_exe,
        service_exe_second,
        service_source_root,
        source_commit,
    )

    if output_root.exists():
        shutil.rmtree(output_root)
    bundle_root = output_root / BUNDLE_NAME
    runtime_root = bundle_root / "runtime"
    bundle_root.mkdir(parents=True)

    copy_file(service_exe, bundle_root / "OPIU_STABLE_Service.exe")
    materialize_runtime(payload_root, runtime_root)
    launcher = (
        "@echo off\r\n"
        "setlocal\r\n"
        "cd /d \"%~dp0\"\r\n"
        "start \"OPIU_STABLE\" \"%~dp0OPIU_STABLE_Service.exe\"\r\n"
    ).encode("utf-8-sig")
    (bundle_root / "ЗАПУСТИТЬ_OPIU_STABLE.cmd").write_bytes(launcher)

    integrated_change = manifest.get("integrated_review_change") or {}
    evidence = {
        "schema_version": "opiu-stable-review-bundle.v1",
        "implementation": implementation,
        "historical_go_source_identity": False,
        "green_ui_preserved": implementation in GREEN_UI_IMPLEMENTATIONS,
        "green_theme_preserved": implementation in GREEN_UI_IMPLEMENTATIONS,
        "green_ui_assets_identical": implementation in BYTE_IDENTICAL_GREEN_UI_IMPLEMENTATIONS,
        "rules_ui_preserved": implementation in GREEN_UI_IMPLEMENTATIONS,
        "source_persistence_fix": implementation in SOURCE_PERSISTENCE_IMPLEMENTATIONS,
        "rules_ui_changed": implementation in RULES_UI_CHANGED_IMPLEMENTATIONS,
        "rules_bulk_decision_fix": implementation in RULES_BULK_DECISION_IMPLEMENTATIONS,
        "rules_report_controls_fix": implementation in RULES_REPORT_CONTROLS_IMPLEMENTATIONS,
        "rules_output_safety_passport_fix": implementation in RULES_OUTPUT_SAFETY_PASSPORT_IMPLEMENTATIONS,
        "r001_result_contract_fix": implementation in R001_RESULT_CONTRACT_IMPLEMENTATIONS,
        "r001_result_readiness_fix": implementation in R001_RESULT_CONTRACT_IMPLEMENTATIONS,
        "r001_cross_source_dedup_fix": implementation in R001_CROSS_SOURCE_DEDUP_IMPLEMENTATIONS,
        "r001_financial_logic_changed": implementation in R001_CROSS_SOURCE_DEDUP_IMPLEMENTATIONS,
        "r005_intalev_catalog_auto_binding": implementation in R005_CATALOG_BINDING_IMPLEMENTATIONS,
        "r005_catalog_financial_logic_changed": False,
        "r005_organization_crosswalk_verified": integrated_change.get(
            "r005_organization_crosswalk_verified", False
        ),
        "uk9_2025_twelve_month_final_audit": integrated_change.get(
            "uk9_2025_twelve_month_final_audit", "NOT_APPLICABLE"
        ),
        "package_bound_crosswalk": integrated_change.get(
            "package_bound_crosswalk", "NOT_APPLICABLE"
        ),
        "distribution_status": integrated_change.get(
            "distribution_status", "REVIEW_ONLY"
        ),
        "user_delivery_approved": integrated_change.get(
            "user_delivery_approved", False
        ),
        "review_output_download_capability_preserved": (
            implementation in GREEN_UI_IMPLEMENTATIONS
        ),
        "embedded_web_assets_changed": implementation in RULES_UI_CHANGED_IMPLEMENTATIONS,
        "runtime_rules_changed": implementation in RULES_REPORT_CONTROLS_IMPLEMENTATIONS,
        "runtime_change_requests": integrated_change.get("change_requests", []),
        "runtime_rules_overlay_hashes": integrated_change.get("rules_overlay_hashes", {}),
        "runtime_rules_safety_overlay_hashes": integrated_change.get(
            "rules_safety_overlay_hashes", {}
        ),
        "runtime_corrections_overlay_hashes": integrated_change.get("corrections_overlay_hashes", {}),
        "runtime_r005_catalog_overlay_hashes": integrated_change.get(
            "r005_catalog_overlay_hashes", {}
        ),
        "runtime_integration_release_work_id": integrated_change.get(
            "integration_release_work_id", ""
        ),
        "runtime_integration_release_base_commit": integrated_change.get(
            "integration_release_base_commit", ""
        ),
        "runtime_integration_release_overlay_hashes": integrated_change.get(
            "integration_release_overlay_hashes", {}
        ),
        "r001_base_commit": integrated_change.get("r001_base_commit", ""),
        "r001_result_commit": integrated_change.get("r001_result_commit", ""),
        "rules_safety_result_commit": integrated_change.get(
            "rules_safety_result_commit", ""
        ),
        "r005_catalog_result_commit": integrated_change.get(
            "r005_catalog_result_commit", ""
        ),
        "r005_catalog_handoff_head": integrated_change.get(
            "r005_catalog_handoff_head", ""
        ),
        "runtime_package_id": manifest["package_id"],
        "runtime_version": manifest["version"],
        "runtime_manifest_sha256": sha256_file(payload_root / "MANIFEST.json"),
        "service_exe_sha256": sha256_file(service_exe),
        "service_build": service_build,
        "safety": {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": False,
            "live_1c_allowed": False,
            "upload_to_1c_executed": False,
        },
        "financial_correctness_verified": False,
        "rules_completeness_verified": False,
        "performance_accepted": False,
        "independent_qa": "REQUIRED",
    }
    (bundle_root / "BUNDLE_PROVENANCE.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    rows = inventory(bundle_root)
    bundle_manifest = {**evidence, "file_count": len(rows), "files": rows}
    (bundle_root / "BUNDLE_MANIFEST.json").write_text(
        json.dumps(bundle_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    zip_path = output_root / f"{BUNDLE_NAME}.zip"
    write_deterministic_zip(bundle_root, zip_path)
    result = {
        "bundle_root": str(bundle_root),
        "zip_path": str(zip_path),
        "zip_sha256": sha256_file(zip_path),
        "file_count": len(inventory(bundle_root)),
        "service_exe_sha256": evidence["service_exe_sha256"],
        "runtime_manifest_sha256": evidence["runtime_manifest_sha256"],
        "safety": evidence["safety"],
    }
    (output_root / "BUILD_RESULT.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-root", required=True, type=Path)
    parser.add_argument("--service-exe", required=True, type=Path)
    parser.add_argument("--service-exe-second", type=Path)
    parser.add_argument("--service-source-root", type=Path)
    parser.add_argument("--source-commit", default="")
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument(
        "--implementation",
        choices=sorted(SERVICE_IMPLEMENTATIONS),
        default="NEW_COMPATIBLE_IMPLEMENTATION",
    )
    args = parser.parse_args()
    print(json.dumps(
        build(
            args.payload_root,
            args.service_exe,
            args.output_root,
            args.implementation,
            args.service_exe_second,
            args.service_source_root,
            args.source_commit,
        ),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    try:
        main()
    except (BundleError, OSError, ValueError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from error
