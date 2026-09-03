#!/usr/bin/env python3
"""Prepare the integrated REPORT_ONLY runtime for the current review bundle.

The first stage delegates to the pinned R005 UK9 runtime preparer.  This
second, bounded stage then overlays the five reviewed Rules Engine files from
CR-RULES-20260816-REPORT-CONTROLS-001 and the five reviewed R001 files from
CR-R001-20260816-CROSS-SOURCE-DEDUP-001, then rebinds the payload manifest.
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
import subprocess
from pathlib import Path
from typing import Any


R005_PREPARER_PATH = Path(__file__).with_name("prepare_r005_uk9_review_runtime.py")
R005_SPEC = importlib.util.spec_from_file_location("opiu_r005_runtime_preparer", R005_PREPARER_PATH)
if R005_SPEC is None or R005_SPEC.loader is None:  # pragma: no cover - import bootstrap guard
    raise RuntimeError("R005_PREPARER_IMPORT_FAILED")
R005 = importlib.util.module_from_spec(R005_SPEC)
R005_SPEC.loader.exec_module(R005)

RULES_CHANGE_REQUEST = "CR-RULES-20260816-REPORT-CONTROLS-001"
RULES_RESULT_COMMIT = "bf3e2f073648269e6dd31645994967ff179d2942"
INTEGRATION_BASE_COMMIT = "a15b330734de7fb8dfd6691407a09d432e76f450"
R001_CHANGE_REQUEST = "CR-R001-20260816-CROSS-SOURCE-DEDUP-001"
R001_BASE_COMMIT = "6d1386e5d9a10a22a75c483845f62ce28ce6b496"
R001_RESULT_COMMIT = "da024306c7edb515df1ae57a1ee219067b06faed"
RULES_SAFETY_CHANGE_REQUEST = "CR-RULES-20260817-OUTPUT-SAFETY-PASSPORT-001"
RULES_SAFETY_BASE_COMMIT = "e09022d2b27b4f0f668d4fc8351231b4ab2c0c1d"
RULES_SAFETY_RESULT_COMMIT = "349e57a2c07aa25f645a8d5b1cdc16181f2739d3"
R005_CATALOG_CHANGE_REQUEST = "CR-R005-20260817-INTALEV-CATALOG-AUTO-BINDING-001"
R005_CATALOG_BASE_COMMIT = "8789974ed0bdd4a5c18c3c3973ceff2ae787f064"
R005_CATALOG_RESULT_COMMIT = "0848141cbe67b7f891f547cce9e25fcf8dea017d"
R005_CATALOG_HANDOFF_HEAD = "ee78a5fed6fd897dbf4c9da4bd0da1a2f41b9185"
INTEGRATION_RELEASE_WORK_ID = "OPIU-2026-08-17-INTEGRATION-RELEASE-READINESS-19"
INTEGRATION_RELEASE_BASE_COMMIT = "7dc94e1cb9102f2e7effd974b94f6f6a64840903"
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

RULES_OVERLAY_HASHES = {
    "modules/rules-engine/source/adapters/r005_adapter.mjs":
        "CD0B329BE8962D16017293FA02B4F7ED870E791CA45FCD2912C7AA721ADD84CF",
    "modules/rules-engine/source/adapters/r005_adapter.test.mjs":
        "7A797262A9343A8F62CEB77EC6F1BE1CBBCD85C4874E98E9111D19A7598572A0",
    "modules/rules-engine/source/adapters/r005_identity_guard.mjs":
        "4E4F99A37E3000E40859FBA6E66ABEF0B03DADB0E300DCE232921AFA5FD0D864",
    "modules/rules-engine/source/adapters/r005_identity_guard.test.mjs":
        "A9819E7C6689838FAB7462C542A770E3CB479B8B917015C84C4B8C6963A13604",
    "modules/rules-engine/source/engine.mjs":
        "2B9FF9B73C46591D9250281DD3721998C9B66BB57B5A398343EE37F4D08D8075",
}

RULES_SAFETY_OVERLAY_HASHES = {
    "modules/rules-engine/source/engine.mjs":
        "2A7276CF0D4062CAC54FC1F0FFD6010B8F1E898611EDADC2874700F33A38025D",
    "modules/rules-engine/source/engine.safety.test.mjs":
        "C9CF94B03C0CF9A61C0B7FB5F21E69923DB179BE130400E2D2A3AD4E959ACA73",
}

CORRECTIONS_OVERLAY_HASHES = {
    "modules/corrections/source/correction_engine_r001.mjs":
        "D124B195834938001CBF4EAAEA6EB8C2B543287D16572B416BC54D3B3AD939A7",
    "modules/corrections/source/r001_cross_source_dedup.mjs":
        "95ACE2F283B5086943D78F58785B64185C6F3C3487F85BE18ACBE2B4423A3EAC",
    "modules/corrections/source/r001_cross_source_dedup.test.mjs":
        "6D8BF7DDAF51EDA2F627F91AA1AC760C7B8B2775426CE204D0D5F32FB38DC010",
    "modules/corrections/source/rules_application_handoff.mjs":
        "3C839F6CBE334D877DBE15D3D9D3524B9C4DE4491A81086AF8F4E4DC5B8AB3E4",
    "modules/corrections/source/rules_application_handoff.test.mjs":
        "76F46727970D0C18A7FA9AEAE19D298E9A1F577C2E065E6DC2D4840EA931FF4B",
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

# The package snapshot predates the accepted hierarchy/binding/group integration
# and PR #54. Keep the historical per-CR pins above as provenance, then apply one
# final exact overlay for the accepted integration baseline. This makes later
# superseding bytes explicit instead of silently rewriting the earlier pins.
INTEGRATION_RELEASE_OVERLAY_HASHES = {
    "modules/corrections/source/correction_engine_r001.mjs":
        "85C1C8514B5B49F17D43EF97C2754CBAFDEB2E64867569200917BEC34D5F86C9",
    "modules/corrections/source/r001_audit_registry_export.mjs":
        "39B20D821B18D9CAAAB70C72B1216CB9F707C3D80748ECEBB543A912D774E006",
    "modules/corrections/source/r001_audit_registry_export.test.mjs":
        "4C1172D58F8DF87B54B6F6FC66D4E78D6ABAE5B2AE8F942FDB5EB050777E3FFF",
    "modules/corrections/source/r005_review_routing.mjs":
        "A17B7456F405CBE77A538B3C7BA2DE746EEA7CF38E8E24C7CBAF655DB8400A57",
    "modules/corrections/source/r005_review_routing.test.mjs":
        "65DCDF9784DD817D3E35732BD6930C9ADEB5B1CF7DD06D6A65FE63401DB55FCD",
    "modules/corrections/source/rules_application_handoff.mjs":
        "88999EE1BE36377331A5B0E8DBBB96B38B599549F9F9EB172A725FB39D0399EE",
    "modules/corrections/source/rules_application_handoff.test.mjs":
        "202EEDCCD40FCAF03CDDAE6513D2C93CEDD28E1CF76D4F32BB41F47224D564B4",
    "modules/reconciliation/source/config.json":
        "C9971819ABF97C1883692ED6F5B1DCB9E8FA076B1DF8286F7251765A8E1DEC23",
    "modules/reconciliation/source/hierarchy_tree.mjs":
        "9637061D0AA78D2207158080E475FB514222EE766ACC5CF04E4DF54957F57824",
    "modules/reconciliation/source/opiu_reconcile.mjs":
        "E87A4C2415216C6DA688A6A98B7FF1AC0D95C7E0ADAE75BD447C12DB21E90990",
    "modules/reconciliation/source/reconciliation_decision_engine.mjs":
        "AD4BDA2E5F96D1F67F0ED2851DC2C9475D8CFC25A50BA3DAF879D790164A74C0",
    "modules/reconciliation/source/r005_binding_status.test.mjs":
        "797FF7337DBAFDD4634FF61362B9927822E216BD3FD2CFB511BCB60CF1B6F266",
    "modules/reconciliation/source/r005_intalev_template_graph.current.json":
        "6013C269E395F09230B078A17ECDFA808F6F53F1B7603001B5FCCAD1D54B7F7C",
    "modules/reconciliation/source/r005_intalev_template_graph.mjs":
        "AA3A3FB21BF94A087FEE5C14D0941A80C9C6AB6EDCB40A75F5C977B7F51CC4E5",
    "modules/reconciliation/source/r005_intalev_tree_presentation.mjs":
        "2C0FB29265ACE472EA9C943EE2CEF574FE18E36FDF61049ACC44C3102A5B2987",
    "modules/reconciliation/source/r005_reconciliation_status.mjs":
        "5233D02AD3F6E4D98EAD61F1E6E85B6478EFF1D33E4286019829866AC8D41ED2",
    "modules/reconciliation/source/r005_reconciliation_status.test.mjs":
        "97B461972F7EE2BB2BC93A915EACD98CF5C913E5DD5140712FB33A6C49389FE0",
    "modules/reconciliation/source/r005_tree_hierarchy.test.mjs":
        "23D2C16CA2163900275A3F602BFD54A79069A329C819C31F53CBF201A8080CE9",
    "modules/reconciliation/source/source_trace_guard.mjs":
        "DB1F95C056107ED7D0A55F1727B4E4CF2EC99C9495688013652D6B4BB430D404",
    "modules/rules-engine/source/adapters/r005_adapter.mjs":
        "B5547B2DED7C07B83318850DBF2ECFD98173DEC906831C13F215A5C0AF816EDB",
    "modules/rules-engine/source/adapters/r005_identity_guard.test.mjs":
        "658779035A285CBBE97BE764A4733264CD6E3C4AA88910C8F1B335C87F096215",
    "modules/rules-engine/source/engine.mjs":
        "C3688C8C72B6873B5BD67BE13B835A4D76D8C7848D0EF72AF9DB1BD2DD72A875",
    "modules/rules-engine/source/handoff.mjs":
        "EB4E8E7AD3B65149E72F574103D6E4568D16F751965BCFD660ED821E42CC281C",
    "modules/rules-engine/source/handoff.test.mjs":
        "544ED66F6609878D92AC1581601DF3B9371A6891E76BB25A0A88EB7350E17E66",
}

SOURCE_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(__file__).resolve().parents[4]


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


def git_blob_bytes(commit: str, relative: str) -> bytes:
    repo_relative = (
        Path("development") / "OPIU_1.9.4" / Path(relative)
    ).as_posix()
    result = subprocess.run(
        ["git", "show", f"{commit}:{repo_relative}"],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise IntegratedPrepareError(
            "INTEGRATION_RELEASE_OVERLAY_BLOB_READ_ERROR:"
            f"{commit}:{relative}:{stderr}"
        )
    return result.stdout


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
    """Overlay the exact reviewed Rules and R001 files into the R005 runtime."""
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
    if not re.fullmatch(r"[0-9a-f]{40}", INTEGRATION_RELEASE_BASE_COMMIT):
        raise IntegratedPrepareError("INTEGRATION_RELEASE_BASE_COMMIT_NOT_PINNED")
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

    applied_hashes: dict[str, str] = {}
    for relative, expected_hash in RULES_OVERLAY_HASHES.items():
        if (
            relative in RULES_SAFETY_OVERLAY_HASHES
            or relative in INTEGRATION_RELEASE_OVERLAY_HASHES
        ):
            # The later accepted Rules safety CR supersedes this materialized
            # file. Keep the earlier reviewed hash in provenance, but only
            # materialize and verify the later exact result below.
            applied_hashes[relative] = expected_hash
            continue
        source = SOURCE_ROOT / Path(relative)
        if not source.is_file() or source.is_symlink():
            raise IntegratedPrepareError(f"RULES_OVERLAY_SOURCE_MISSING:{relative}")
        actual_source_hash = sha256_file(source)
        if actual_source_hash != expected_hash:
            raise IntegratedPrepareError(
                f"RULES_OVERLAY_SOURCE_HASH_MISMATCH:{relative}:{actual_source_hash}"
            )
        target = runtime_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        applied_hashes[relative] = sha256_file(target)
        R005.upsert_manifest_file(
            manifest,
            relative,
            target,
            source=f"{RULES_CHANGE_REQUEST}:{RULES_RESULT_COMMIT}:{relative}",
        )

    applied_rules_safety_hashes: dict[str, str] = {}
    for relative, expected_hash in RULES_SAFETY_OVERLAY_HASHES.items():
        if relative in INTEGRATION_RELEASE_OVERLAY_HASHES:
            applied_rules_safety_hashes[relative] = expected_hash
            continue
        source = SOURCE_ROOT / Path(relative)
        if not source.is_file() or source.is_symlink():
            raise IntegratedPrepareError(
                f"RULES_SAFETY_OVERLAY_SOURCE_MISSING:{relative}"
            )
        actual_source_hash = sha256_file(source)
        if actual_source_hash != expected_hash:
            raise IntegratedPrepareError(
                "RULES_SAFETY_OVERLAY_SOURCE_HASH_MISMATCH:"
                f"{relative}:{actual_source_hash}"
            )
        target = runtime_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
        applied_rules_safety_hashes[relative] = sha256_file(target)
        R005.upsert_manifest_file(
            manifest,
            relative,
            target,
            source=(
                f"{RULES_SAFETY_CHANGE_REQUEST}:"
                f"{RULES_SAFETY_RESULT_COMMIT}:{relative}"
            ),
        )

    applied_corrections_hashes: dict[str, str] = {}
    for relative, expected_hash in CORRECTIONS_OVERLAY_HASHES.items():
        if relative in INTEGRATION_RELEASE_OVERLAY_HASHES:
            applied_corrections_hashes[relative] = expected_hash
            continue
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
        if relative in INTEGRATION_RELEASE_OVERLAY_HASHES:
            applied_r005_catalog_hashes[relative] = expected_hash
            continue
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
    for relative, expected_hash in INTEGRATION_RELEASE_OVERLAY_HASHES.items():
        data = git_blob_bytes(INTEGRATION_RELEASE_BASE_COMMIT, relative)
        actual_source_hash = hashlib.sha256(data).hexdigest().upper()
        if actual_source_hash != expected_hash:
            raise IntegratedPrepareError(
                "INTEGRATION_RELEASE_OVERLAY_SOURCE_HASH_MISMATCH:"
                f"{relative}:{actual_source_hash}"
            )
        target = runtime_root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        applied_integration_release_hashes[relative] = sha256_file(target)
        R005.upsert_manifest_file(
            manifest,
            relative,
            target,
            source=(
                f"{INTEGRATION_RELEASE_WORK_ID}:"
                f"{INTEGRATION_RELEASE_BASE_COMMIT}:{relative}"
            ),
        )

    for item in manifest.get("protected_core", []):
        relative = str(item.get("path", ""))
        if relative in applied_integration_release_hashes:
            item["sha256"] = applied_integration_release_hashes[relative]
        elif relative in applied_r005_catalog_hashes:
            item["sha256"] = applied_r005_catalog_hashes[relative]

    safety.update({
        "mode": "REPORT_ONLY",
        "posting_rows": 0,
        "execution_allowed": False,
        "ready_to_upload": False,
        "release_allowed": False,
        "one_c_actions_executed": False,
        "live_1c_allowed": False,
        "rules_report_controls_changed": True,
        "rules_financial_logic_changed": False,
        "rules_change_request": RULES_CHANGE_REQUEST,
        "rules_output_safety_passport_fix": True,
        "rules_safety_change_request": RULES_SAFETY_CHANGE_REQUEST,
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
            f"{RULES_CHANGE_REQUEST}+{R001_CHANGE_REQUEST}+"
            f"{RULES_SAFETY_CHANGE_REQUEST}+{R005_CATALOG_CHANGE_REQUEST}:"
            "safety-passport"
        ),
    )

    materialized_inventory = materialized_payload_inventory(runtime_root)
    manifest["generated_at"] = FIXED_GENERATED_AT
    manifest["integrated_review_change"] = {
        "schema_version": "opiu-integrated-runtime-review.v1",
        "integration_base_commit": INTEGRATION_BASE_COMMIT,
        "prepared_r005_manifest_sha256": base_manifest_sha256,
        "change_requests": [
            R005.CHANGE_REQUEST,
            RULES_CHANGE_REQUEST,
            R001_CHANGE_REQUEST,
            RULES_SAFETY_CHANGE_REQUEST,
            R005_CATALOG_CHANGE_REQUEST,
        ],
        "rules_result_commit": RULES_RESULT_COMMIT,
        "rules_overlay_hashes": applied_hashes,
        "rules_safety_base_commit": RULES_SAFETY_BASE_COMMIT,
        "rules_safety_result_commit": RULES_SAFETY_RESULT_COMMIT,
        "rules_safety_overlay_hashes": applied_rules_safety_hashes,
        "r001_base_commit": R001_BASE_COMMIT,
        "r001_result_commit": R001_RESULT_COMMIT,
        "corrections_overlay_hashes": applied_corrections_hashes,
        "r005_catalog_base_commit": R005_CATALOG_BASE_COMMIT,
        "r005_catalog_result_commit": R005_CATALOG_RESULT_COMMIT,
        "r005_catalog_handoff_head": R005_CATALOG_HANDOFF_HEAD,
        "r005_catalog_overlay_hashes": applied_r005_catalog_hashes,
        "integration_release_work_id": INTEGRATION_RELEASE_WORK_ID,
        "integration_release_base_commit": INTEGRATION_RELEASE_BASE_COMMIT,
        "integration_release_overlay_hashes": applied_integration_release_hashes,
        "integration_release_packaging_only": True,
        "materialized_payload_file_count": materialized_inventory["file_count"],
        "materialized_payload_inventory_sha256": materialized_inventory["sha256"],
        "rules_report_controls_fix": True,
        "rules_output_safety_passport_fix": True,
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
        "rules_output_safety_passport_fix": True,
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
        "rules_report_controls": "PASS_30_OF_30",
        "rules_output_safety_passport": "PASS_31_OF_31",
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
