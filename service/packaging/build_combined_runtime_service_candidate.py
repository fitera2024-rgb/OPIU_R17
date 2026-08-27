#!/usr/bin/env python3
"""Build one fail-closed current-runtime plus rebuilt-Service candidate.

The exact owner archive is an immutable carrier only. Production runtime files
come from every Git blob under four reviewed roots at one exact clean head. The
Service comes from two byte-identical exact-Go builds at the same head.
Packaging success is not financial, release, upload, posting or live-1C proof.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import importlib.util
import json
import os
import re
import shutil
import stat
import tempfile
import tarfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


_BASE_PATH = Path(__file__).with_name("build_clean_source_service_candidate.py")
_BASE_SPEC = importlib.util.spec_from_file_location("opiu_clean_packaging_base", _BASE_PATH)
if _BASE_SPEC is None or _BASE_SPEC.loader is None:
    raise RuntimeError("CLEAN_PACKAGING_BASE_IMPORT_FAILED")
BASE = importlib.util.module_from_spec(_BASE_SPEC)
_BASE_SPEC.loader.exec_module(BASE)


WORK_ID = "OPIU-2026-08-25-COMBINED-RUNTIME-SERVICE-PACKAGING-001"
SCHEMA_VERSION = "opiu-combined-runtime-service-candidate.v1"
BASE_ARCHIVE_SHA256 = BASE.BASE_ARCHIVE_SHA256
BASE_SERVICE_EXE_SHA256 = BASE.BASE_SERVICE_EXE_SHA256
SERVICE_EXE_NAME = BASE.SERVICE_EXE_NAME
PRODUCT_ROOT_RELATIVE = Path("development/OPIU_1.9.4")
MANAGED_RUNTIME_ROOTS = (
    "modules/corrections/source",
    "modules/corrections/contracts",
    "modules/reconciliation/source",
    "user-settings",
)
RUNTIME_TARGET_ROOTS = MANAGED_RUNTIME_ROOTS[:-1]
GIT_BOUND_USER_SETTINGS = {
    "user-settings/КАК_НАСТРОИТЬ_ГРУППИРОВКУ.txt",
    "user-settings/Настройка_группировки_блоков.csv",
}
GIT_BOUND_RUNTIME_DATA_FILES = frozenset({
    "modules/corrections/contracts/schemas/service_r005_r001_handoff.schema.json",
    "modules/corrections/source/correction_rules.r001.json",
    "modules/reconciliation/source/catalog_descendants.current.json",
    "modules/reconciliation/source/config.json",
    "modules/reconciliation/source/external_reference/erp/ERP_Аналитики_ОПИУ.xlsx",
    "modules/reconciliation/source/external_reference/erp/ERP_Показатели_ОПИУ.xlsx",
    "modules/reconciliation/source/external_reference/erp/ERP_Формулы_ОПИУ.xlsx",
    "modules/reconciliation/source/external_reference/erp/StatD_R.xlsx",
    "modules/reconciliation/source/external_reference/erp/ИстчникиОтчетовЕРП.xlsx",
    "modules/reconciliation/source/external_reference/erp/ОПИУ_Структура_ерп.xlsx",
    "modules/reconciliation/source/external_reference/erp/ОПИУ_ФОРМУЛЫ_ерп.xlsx",
    "modules/reconciliation/source/external_reference/intalev/Z_J_X.mxl",
    "modules/reconciliation/source/external_reference/intalev/ОтчетПоСтруктуреОтчетов2.mxl",
    "modules/reconciliation/source/external_reference/intalev/отчетПоФильтрам2.mxl",
    "modules/reconciliation/source/organization_profiles.json",
    "modules/reconciliation/source/owner_decision_policy.json",
    "modules/reconciliation/source/owner_economic_route_proofs/uk9_2025_10_owner_approved.json",
    "modules/reconciliation/source/owner_empty_article_bindings/uk9_2025_fzp_owner_approved.json",
    "modules/reconciliation/source/r005_intalev_template_graph.current.json",
    "modules/reconciliation/source/reference_catalog_manifest.current.json",
    "modules/reconciliation/source/resources/UK_Актуальные_правила_сверки_2026-07-30_R005_CONSOLIDATED.xlsx",
    "modules/reconciliation/source/resources/ОПИУ_по_образцу_ШАБЛОН.xlsx",
    "modules/reconciliation/source/resources/khabarovsk_project.json",
    "modules/reconciliation/source/resources/СтатьиДоходовИРасходовЕРП.xlsx",
    "modules/reconciliation/source/testdata/structural-control-inventory-v3.fixture.json",
})
REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES = frozenset({
    "modules/corrections/source/correction_engine_r001.mjs",
    "modules/corrections/source/r001_handoff_input.mjs",
    "modules/corrections/source/service_r005_r001_handoff.mjs",
    "modules/corrections/source/service_r001_ready_authority.mjs",
    "modules/corrections/contracts/schemas/service_r005_r001_handoff.schema.json",
    "modules/corrections/source/service_r001_owner_wrapper.mjs",
    "modules/reconciliation/source/opiu_reconcile.mjs",
    "modules/reconciliation/source/service_r005_owner_wrapper.mjs",
    "modules/reconciliation/source/structural_control_authoritative_candidates.mjs",
    "modules/reconciliation/source/structural_control_current_hierarchy_binding.mjs",
    "modules/reconciliation/source/structural_control_groups.mjs",
    "modules/reconciliation/source/structural_control_inventory_v3.mjs",
    "modules/reconciliation/source/structural_control_report_detail.mjs",
    "modules/reconciliation/source/structural_control_settings_binding.mjs",
})
REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES = frozenset({
    "fail_soft_report_package.go",
    "pipeline.go",
    "results_api.go",
    "r001_service_handoff.go",
    "runtime_adapter.go",
    "structural_control_inventory_anchor.go",
    "structural_control_inventory_v3.go",
    "structural_control_pipeline_binding.go",
    "structural_control_proof_pipeline.go",
    "structural_control_sets.go",
})
MODULE_NAMES = ("corrections", "reconciliation")
LEGACY_RULES_RUNTIME_PATHS = (
    "runtime/modules/rules-engine",
    "runtime/rules",
    "runtime/data/defaults/rules.json",
)
MODULE_MANIFEST_PATHS = tuple(
    f"modules/{module}/MODULE_MANIFEST.json" for module in MODULE_NAMES
)
FIXED_ZIP_TIME = (2026, 8, 25, 0, 0, 0)

# These files have no clean-source counterpart. They are retained only as exact
# immutable carrier reference resources; path, size and SHA-256 all bind.
PRESERVED_CARRIER_RUNTIME_FILES: dict[str, tuple[int, str]] = {
    "node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node": (
        24231424, "4E5B185CCDFFCEEDE5468B47C4646E2CE66F4E85EC35A753007EC32CB8720498",
    ),
    "modules/reconciliation/source/external_reference/erp/StatD_R.xlsx": (
        22693, "95CE3A53F1FAC502B29CCCB30BF329A9EFBB6A1D034F0820FDF735BE76D39124",
    ),
    "modules/reconciliation/source/external_reference/erp/ИстчникиОтчетовЕРП.xlsx": (
        881007, "CCBDA86E5770E094EBA869FC1FB4A506856376D9BBC76FF76D9D94B0D69A1CE2",
    ),
    "modules/reconciliation/source/external_reference/erp/ОПИУ_Структура_ерп.xlsx": (
        12906, "707BD796E4774A3DCE2995D423C7D3665A406FFE4ACBCB7BA468D8AF0167ADD5",
    ),
    "modules/reconciliation/source/external_reference/erp/ОПИУ_ФОРМУЛЫ_ерп.xlsx": (
        22074, "EE729E13305DAFC34EA3AE45EF7EF6C6817301E4F64F7461AD3FFB93509DAE49",
    ),
    "modules/reconciliation/source/external_reference/intalev/Z_J_X.mxl": (
        1134223, "BE230E807B208ABB68B99E61D3AF161EB345420DBE95768BB480E94589E98329",
    ),
    "modules/reconciliation/source/external_reference/intalev/ОтчетПоСтруктуреОтчетов2.mxl": (
        5634274, "E2A4BD322D80D07F8C8E4EAB4629149EB3697F6FF47717DE2B79B328B594C96B",
    ),
    "modules/reconciliation/source/external_reference/intalev/отчетПоФильтрам2.mxl": (
        1300605, "F187AD4FA40149B6E8872EFF96C5998183C8702CAB9E9322ECF75CE15BF2FDDD",
    ),
    "modules/reconciliation/source/resources/UK_Актуальные_правила_сверки_2026-07-30_R005_CONSOLIDATED.xlsx": (
        32468, "AB1A59E9358B6EE93F2A437A7027CCF0F753D09C6E49182AB4076DF6B9E807E7",
    ),
    "modules/reconciliation/source/resources/khabarovsk_project.json": (
        3915, "D69CFF3CD0F00FA879BAA1E8862490690937202866218635043A2FE2460DD073",
    ),
    "modules/reconciliation/source/resources/ОПИУ_по_образцу_ШАБЛОН.xlsx": (
        207035, "796DE3D261F879ADDDA7C542595C58311C2895A27878D257E2D8EA214E5FE915",
    ),
    "modules/reconciliation/source/resources/СтатьиДоходовИРасходовЕРП.xlsx": (
        43563, "8C7CA0E3884BB78F610A95E01A935DEBF55871312D3193728B248E7C4A197BBF",
    ),
    "resources/reference/ОрганизациииерархияЕРП.xlsx": (
        106560, "3342603C0782FE12871AD55E7E19E778A97651E8CFF2E00F0CE6774295C57522",
    ),
    "resources/reference/ПланСчетов_ERP.mxl": (
        61223, "867E493B4458975D2EF798452F4AD5C249DB9DD378454E5332188D200755A1CD",
    ),
}
REMOVED_PRIVATE_CARRIER_FILES: dict[str, tuple[int, str]] = {
    "runtime/node_modules/jszip/.jekyll-metadata": (
        24628, "E51C201EFFBA98383BC00CA20C945550405B23CF431C1B8A80276CD0A8241565",
    ),
}
ACKNOWLEDGED_INHERITED_PRIVATE_PATHS: dict[str, tuple[int, str]] = {
    "runtime/node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node": (
        24231424, "4E5B185CCDFFCEEDE5468B47C4646E2CE66F4E85EC35A753007EC32CB8720498",
    ),
}

REPLACED_METADATA_PATHS = {
    "BUNDLE_MANIFEST.json",
    "BUNDLE_PROVENANCE.json",
    "QA52_PACKAGE_INFO.txt",
    "COMBINED_RUNTIME_SERVICE_CANDIDATE.json",
    "SERVICE_BUILD_PROVENANCE.json",
    "runtime/MANIFEST.json",
    "runtime/SAFETY.json",
    *(f"runtime/{path}" for path in MODULE_MANIFEST_PATHS),
}
FORBIDDEN_NEW_SUFFIXES = {
    ".zip", ".log", ".tmp", ".bak", ".xlsx", ".xls", ".xlsm", ".csv", ".mxl",
}
FORBIDDEN_PATH_PARTS = {
    ".git", "__pycache__", ".pytest_cache", "work", "tmp", "temp",
    "outputs", "runtime-cache", "runs", "cache",
}
RELATIVE_IMPORT_RE = re.compile(
    r'''(?:from\s+|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']''',
)
RELATIVE_URL_RE = re.compile(r'''new\s+URL\(\s*["'](\.[^"']+)["']''')
USER_PATH_PATTERNS = (
    re.compile(rb"(?i)[A-Z]:[\\/]Users[\\/]"),
    re.compile(rb"(?i)/Users/"),
    re.compile(rb"(?i)[A-Z]\x00:\x00[\\/]\x00U\x00s\x00e\x00r\x00s\x00[\\/]\x00"),
)


BuildError = BASE.BuildError


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def record_from_rows(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted((dict(row) for row in rows), key=lambda row: row["path"])
    payload = json.dumps(
        ordered, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    return {"file_count": len(ordered), "sha256": sha256_bytes(payload), "files": ordered}


def verify_structural_control_packaging_closure(
    runtime_inventory: dict[str, Any],
    service_source_inventory: dict[str, Any],
) -> dict[str, Any]:
    runtime_paths = {str(row.get("path", "")) for row in runtime_inventory.get("files", [])}
    service_paths = {str(row.get("path", "")) for row in service_source_inventory.get("files", [])}
    missing_runtime = sorted(REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES - runtime_paths)
    missing_service = sorted(REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES - service_paths)
    if missing_runtime:
        raise BuildError(
            "STRUCTURAL_CONTROL_RUNTIME_CLOSURE_MISSING:"
            + ",".join(missing_runtime)
        )
    if missing_service:
        raise BuildError(
            "STRUCTURAL_CONTROL_SERVICE_SOURCE_CLOSURE_MISSING:"
            + ",".join(missing_service)
        )
    return {
        "status": "VERIFIED_EXACT_GIT_HEAD_CLOSURE",
        "runtime_files": sorted(REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES),
        "runtime_file_count": len(REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES),
        "service_source_files": sorted(REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES),
        "service_source_file_count": len(REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES),
        "correction_authority": False,
        "financial_rows": 0,
        "posting_rows": 0,
    }


def is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def assert_outputs_outside_repository(repository: Path, *outputs: Path) -> None:
    for output in outputs:
        if is_under(output, repository):
            raise BuildError("OUTPUT_INSIDE_SOURCE_REPOSITORY")


def product_root_relative(repository: Path) -> Path:
    repository = repository.resolve()
    if all((repository / root).is_dir() for root in MANAGED_RUNTIME_ROOTS):
        return Path(".")
    return PRODUCT_ROOT_RELATIVE


def service_source_relative(repository: Path) -> Path:
    repository = repository.resolve()
    if (repository / "service" / "source").is_dir():
        return Path("service/source")
    return BASE.SERVICE_SOURCE_RELATIVE


def git_service_source_inventory(repository: Path, source_head: str) -> dict[str, Any]:
    source_relative = service_source_relative(repository)
    source_prefix = source_relative.as_posix().rstrip("/") + "/"
    result = BASE.run_process_bytes(
        ["git", "-C", str(repository), "archive", "--format=tar", source_head, "--", source_prefix],
        cwd=repository,
        env=dict(os.environ),
    )
    BASE.require_binary_process(result, "GIT_ARCHIVE_SOURCE")
    rows: list[dict[str, Any]] = []
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
            for member in archive.getmembers():
                normalized = PurePosixPath(member.name).as_posix()
                if member.isdir():
                    continue
                if not member.isfile() or not normalized.startswith(source_prefix):
                    raise BuildError(f"GIT_SOURCE_ENTRY_UNSAFE:{normalized}")
                relative = normalized[len(source_prefix):]
                pure = PurePosixPath(relative)
                if not relative or pure.is_absolute() or ".." in pure.parts:
                    raise BuildError(f"GIT_SOURCE_ENTRY_UNSAFE:{normalized}")
                stream = archive.extractfile(member)
                if stream is None:
                    raise BuildError(f"GIT_SOURCE_ENTRY_UNREADABLE:{relative}")
                data = stream.read()
                rows.append({"path": relative, "size": len(data), "sha256": sha256_bytes(data)})
    except (tarfile.TarError, OSError) as error:
        raise BuildError(f"GIT_SOURCE_ARCHIVE_INVALID:{error}") from error
    return BASE.inventory_record_from_rows(rows)


def exact_service_source_inventory(repository: Path, source_head: str) -> dict[str, Any]:
    source_root = repository / service_source_relative(repository)
    working = BASE.source_inventory(source_root)
    committed = git_service_source_inventory(repository, source_head)
    if working != committed:
        raise BuildError("SERVICE_SOURCE_NOT_EXACT_GIT_TREE")
    return working


def verify_service_source_unchanged(
    repository: Path,
    source_head: str,
    expected_inventory: dict[str, Any],
) -> None:
    BASE.verify_repository(repository, source_head)
    if exact_service_source_inventory(repository, source_head) != expected_inventory:
        raise BuildError("SERVICE_SOURCE_CHANGED_DURING_BUILD")


def parse_git_tree(repository: Path, source_head: str) -> dict[str, dict[str, str]]:
    product_relative = product_root_relative(repository)
    prefix = "" if product_relative == Path(".") else product_relative.as_posix().rstrip("/") + "/"
    paths = [f"{prefix}{root}" for root in MANAGED_RUNTIME_ROOTS]
    result = BASE.run_process_bytes(
        ["git", "-c", "core.quotePath=false", "-C", str(repository),
         "ls-tree", "-r", "-z", source_head, "--", *paths],
        cwd=repository,
        env=dict(os.environ),
    )
    BASE.require_binary_process(result, "GIT_RUNTIME_TREE")
    rows: dict[str, dict[str, str]] = {}
    for raw in result.stdout.split(b"\0"):
        if not raw:
            continue
        metadata, separator, raw_path = raw.partition(b"\t")
        if not separator:
            raise BuildError("GIT_RUNTIME_TREE_ROW_INVALID")
        parts = metadata.decode("ascii", "strict").split()
        if len(parts) != 3 or parts[1] != "blob" or parts[0] not in {"100644", "100755"}:
            raise BuildError("GIT_RUNTIME_TREE_ENTRY_UNSAFE")
        full_path = raw_path.decode("utf-8", "strict")
        if prefix and not full_path.startswith(prefix):
            raise BuildError("GIT_RUNTIME_TREE_SCOPE_ESCAPE")
        relative = PurePosixPath(full_path[len(prefix):]).as_posix()
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts or relative in rows:
            raise BuildError("GIT_RUNTIME_TREE_PATH_UNSAFE")
        rows[relative] = {"git_mode": parts[0], "git_blob": parts[2]}
    if not rows:
        raise BuildError("RUNTIME_OVERLAY_GIT_TREE_EMPTY")
    return rows


def git_blob_id(data: bytes, object_format: str) -> str:
    if object_format not in {"sha1", "sha256"}:
        raise BuildError("GIT_OBJECT_FORMAT_UNSUPPORTED")
    digest = hashlib.new(object_format)
    digest.update(f"blob {len(data)}\0".encode("ascii"))
    digest.update(data)
    return digest.hexdigest()


def exact_runtime_overlay_inventory(repository: Path, source_head: str) -> dict[str, Any]:
    repository = repository.resolve()
    product_root = repository / product_root_relative(repository)
    tree = parse_git_tree(repository, source_head)
    object_format = BASE.git_text(repository, "rev-parse", "--show-object-format").strip()
    working_paths: dict[str, Path] = {}
    for root_relative in MANAGED_RUNTIME_ROOTS:
        root = product_root / Path(root_relative)
        if not root.is_dir():
            raise BuildError(f"RUNTIME_OVERLAY_ROOT_MISSING:{root_relative}")
        for item in BASE.regular_files(root):
            relative = item.relative_to(product_root).as_posix()
            if relative in working_paths:
                raise BuildError("RUNTIME_OVERLAY_WORKING_PATH_DUPLICATE")
            working_paths[relative] = item
    expected_paths = set(tree)
    actual_paths = set(working_paths)
    if expected_paths != actual_paths:
        missing = sorted(expected_paths - actual_paths)
        extra = sorted(actual_paths - expected_paths)
        code = "RUNTIME_OVERLAY_WORKING_TREE_MISMATCH"
        raise BuildError(f"{code}:missing={len(missing)}:extra={len(extra)}")
    rows = []
    for relative in sorted(expected_paths):
        item = working_paths[relative]
        data = item.read_bytes()
        if git_blob_id(data, object_format) != tree[relative]["git_blob"]:
            raise BuildError(f"RUNTIME_OVERLAY_NOT_EXACT_GIT_BLOB:{relative}")
        rows.append({
            "path": relative,
            "size": len(data),
            "sha256": sha256_bytes(data),
            "git_blob": tree[relative]["git_blob"],
            "git_mode": tree[relative]["git_mode"],
        })
    record = record_from_rows(rows)
    actual_user_settings = {
        row["path"] for row in record["files"] if row["path"].startswith("user-settings/")
    }
    if actual_user_settings != GIT_BOUND_USER_SETTINGS:
        raise BuildError(
            "RUNTIME_OVERLAY_USER_SETTINGS_SET_MISMATCH:"
            f"missing={len(GIT_BOUND_USER_SETTINGS - actual_user_settings)}:"
            f"extra={len(actual_user_settings - GIT_BOUND_USER_SETTINGS)}"
        )
    forbidden = [
        row["path"] for row in record["files"]
        if PurePosixPath(row["path"]).suffix.lower() in FORBIDDEN_NEW_SUFFIXES
        and row["path"] not in GIT_BOUND_USER_SETTINGS
        and row["path"] not in GIT_BOUND_RUNTIME_DATA_FILES
    ]
    if forbidden:
        raise BuildError(f"RUNTIME_OVERLAY_BUSINESS_FILE_FORBIDDEN:{len(forbidden)}")
    record["managed_roots"] = list(MANAGED_RUNTIME_ROOTS)
    record["git_object_format"] = object_format
    record["dependency_scan"] = verify_relative_dependency_closure(product_root, record)
    return record


def verify_relative_dependency_closure(product_root: Path, record: dict[str, Any]) -> dict[str, Any]:
    paths = {row["path"] for row in record["files"]}
    missing: list[dict[str, str]] = []
    dependencies = 0
    for row in record["files"]:
        relative = row["path"]
        if PurePosixPath(relative).suffix.lower() not in {".mjs", ".js", ".cjs"}:
            continue
        source = (product_root / Path(relative)).read_text(encoding="utf-8-sig")
        specifiers = [*RELATIVE_IMPORT_RE.findall(source), *RELATIVE_URL_RE.findall(source)]
        for specifier in specifiers:
            clean = specifier.split("?", 1)[0].split("#", 1)[0]
            target = PurePosixPath(relative).parent.joinpath(clean)
            normalized_parts: list[str] = []
            for part in target.parts:
                if part in {"", "."}:
                    continue
                if part == "..":
                    if not normalized_parts:
                        missing.append({"source": relative, "specifier": specifier})
                        normalized_parts = []
                        break
                    normalized_parts.pop()
                else:
                    normalized_parts.append(part)
            if not normalized_parts:
                continue
            candidate = PurePosixPath(*normalized_parts).as_posix()
            candidates = [candidate]
            if not PurePosixPath(candidate).suffix:
                candidates.extend(
                    f"{candidate}{suffix}" for suffix in (".mjs", ".js", ".cjs", ".json")
                )
                candidates.extend(
                    f"{candidate}/index{suffix}" for suffix in (".mjs", ".js", ".cjs", ".json")
                )
            dependencies += 1
            if not any(value in paths for value in candidates):
                missing.append({"source": relative, "specifier": specifier})
    if missing:
        raise BuildError(f"RUNTIME_OVERLAY_DEPENDENCY_MISSING:{len(missing)}")
    return {"relative_dependency_count": dependencies, "missing": 0}


def bundle_relative_for_overlay(relative: str) -> str:
    if relative == "user-settings" or relative.startswith("user-settings/"):
        return relative
    return f"runtime/{relative}"


def overlay_target(bundle: Path, relative: str) -> Path:
    return bundle / Path(bundle_relative_for_overlay(relative))


def managed_candidate_inventory(bundle: Path) -> dict[str, Any]:
    rows = []
    for root_relative in MANAGED_RUNTIME_ROOTS:
        logical_root = PurePosixPath(root_relative)
        root = overlay_target(bundle, logical_root.as_posix())
        if not root.exists():
            continue
        for item in BASE.regular_files(root):
            rows.append({
                "path": logical_root.joinpath(item.relative_to(root).as_posix()).as_posix(),
                "size": item.stat().st_size,
                "sha256": BASE.sha256_file(item),
            })
    return record_from_rows(rows)


def verify_carrier_managed_closure(bundle: Path, overlay: dict[str, Any]) -> dict[str, Any]:
    actual = {row["path"]: row for row in managed_candidate_inventory(bundle)["files"]}
    overlay_paths = {row["path"] for row in overlay["files"]}
    carrier_only_paths = set(actual) - overlay_paths
    expected_carrier_only = {
        path for path in PRESERVED_CARRIER_RUNTIME_FILES
        if any(path == root or path.startswith(f"{root}/") for root in MANAGED_RUNTIME_ROOTS)
    }
    if carrier_only_paths != expected_carrier_only:
        raise BuildError(
            "CARRIER_RUNTIME_CLOSURE_MISMATCH:"
            f"missing={len(expected_carrier_only - carrier_only_paths)}:"
            f"extra={len(carrier_only_paths - expected_carrier_only)}"
        )
    rows = []
    for relative, (expected_size, expected_sha) in sorted(PRESERVED_CARRIER_RUNTIME_FILES.items()):
        target = overlay_target(bundle, relative)
        if (
            not target.is_file()
            or target.stat().st_size != expected_size
            or BASE.sha256_file(target) != expected_sha
        ):
            raise BuildError(f"CARRIER_REFERENCE_HASH_MISMATCH:{relative}")
        rows.append({
            "path": relative,
            "size": expected_size,
            "sha256": expected_sha,
            "source": "IMMUTABLE_CARRIER_REFERENCE",
        })
    return record_from_rows(rows)


def remove_exact_private_carrier_files(bundle: Path) -> dict[str, Any]:
    rows = []
    for relative, (expected_size, expected_sha) in sorted(REMOVED_PRIVATE_CARRIER_FILES.items()):
        target = bundle / Path(relative)
        if not is_under(target, bundle):
            raise BuildError("PRIVATE_CARRIER_REMOVAL_PATH_ESCAPE")
        if (
            not target.is_file()
            or target.stat().st_size != expected_size
            or BASE.sha256_file(target) != expected_sha
        ):
            raise BuildError(f"PRIVATE_CARRIER_REMOVAL_BINDING_MISMATCH:{relative}")
        target.unlink()
        if target.exists():
            raise BuildError(f"PRIVATE_CARRIER_REMOVAL_FAILED:{relative}")
        rows.append({
            "path": relative,
            "size": expected_size,
            "sha256": expected_sha,
            "source": "REMOVED_PRIVATE_PATH_CARRIER_ARTIFACT",
        })
    return record_from_rows(rows)


def remove_legacy_rules_runtime(bundle: Path) -> dict[str, Any]:
    rows = []
    for relative in LEGACY_RULES_RUNTIME_PATHS:
        target = bundle / Path(relative)
        if not is_under(target, bundle):
            raise BuildError("LEGACY_RULES_REMOVAL_PATH_ESCAPE")
        if target.is_dir():
            for item in BASE.regular_files(target):
                rows.append({"path": item.relative_to(bundle).as_posix(), "size": item.stat().st_size, "sha256": BASE.sha256_file(item)})
            shutil.rmtree(target)
        elif target.is_file():
            rows.append({"path": target.relative_to(bundle).as_posix(), "size": target.stat().st_size, "sha256": BASE.sha256_file(target)})
            target.unlink()
    if any((bundle / Path(relative)).exists() for relative in LEGACY_RULES_RUNTIME_PATHS):
        raise BuildError("LEGACY_RULES_RUNTIME_REMOVAL_FAILED")
    return record_from_rows(rows)


def apply_runtime_overlay(
    bundle: Path,
    product_root: Path,
    overlay: dict[str, Any],
) -> None:
    for row in overlay["files"]:
        relative = row["path"]
        source = product_root / Path(relative)
        target = overlay_target(bundle, relative)
        if not is_under(target, bundle):
            raise BuildError("RUNTIME_OVERLAY_TARGET_ESCAPE")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if target.stat().st_size != row["size"] or BASE.sha256_file(target) != row["sha256"]:
            raise BuildError(f"RUNTIME_OVERLAY_COPY_MISMATCH:{relative}")


def inventory_with_source(
    root: Path,
    *,
    excluded: set[str] | None = None,
) -> dict[str, Any]:
    excluded = excluded or set()
    return record_from_rows(
        row for row in BASE.inventory(root) if row["path"] not in excluded
    )


def write_module_manifests(
    runtime: Path,
    source_head: str,
    overlay: dict[str, Any],
    carrier_only: dict[str, Any],
) -> None:
    overlay_by_path = {row["path"]: row for row in overlay["files"]}
    carrier_by_path = {row["path"]: row for row in carrier_only["files"]}
    for module in MODULE_NAMES:
        module_root = runtime / "modules" / module
        manifest_relative = f"modules/{module}/MODULE_MANIFEST.json"
        rows = []
        for row in BASE.inventory(module_root, {"MODULE_MANIFEST.json"}):
            full_path = f"modules/{module}/{row['path']}"
            if full_path in overlay_by_path:
                source_row = overlay_by_path[full_path]
                rows.append({
                    "path": full_path,
                    "size": row["size"],
                    "sha256": row["sha256"],
                    "git_blob": source_row["git_blob"],
                    "git_mode": source_row["git_mode"],
                    "source": "EXACT_GIT_HEAD",
                })
            elif full_path in carrier_by_path:
                rows.append({**row, "path": full_path, "source": "IMMUTABLE_CARRIER_REFERENCE"})
            else:
                raise BuildError(f"MODULE_RUNTIME_FILE_UNBOUND:{full_path}")
        manifest = {
            "schema_version": "opiu-module-manifest.v2",
            "module": module,
            "source_head": source_head,
            "runtime_source_sha": source_head,
            "candidate_status": "REPORT_ONLY_REVIEW_CANDIDATE",
            "artifact_publication_authorized_by_owner": False,
            "release_approved": False,
            "live_1c_approved": False,
            "safety": closed_safety(source_head),
            "files": sorted(rows, key=lambda row: row["path"]),
        }
        target = runtime / Path(manifest_relative)
        target.write_bytes(canonical_json_bytes(manifest))


def closed_safety(source_head: str) -> dict[str, Any]:
    safety = BASE.closed_safety()
    safety.update({
        "schema_version": "opiu-runtime-safety.v2",
        "candidate_status": "REPORT_ONLY_REVIEW_CANDIDATE",
        "work_id": WORK_ID,
        "runtime_source_sha": source_head,
        "artifact_publication_authorized_by_owner": False,
        "artifact_published_by_builder": False,
        "release_approved": False,
        "live_1c_approved": False,
        "rules_service": False,
        "pipeline": "R005_SERVICE_HANDOFF_R001",
    })
    BASE.assert_report_only(safety)
    return safety


def private_path_hits(root: Path) -> dict[str, str]:
    hits: dict[str, str] = {}
    for item in BASE.regular_files(root):
        data = item.read_bytes()
        if any(pattern.search(data) for pattern in USER_PATH_PATTERNS):
            hits[item.relative_to(root).as_posix()] = sha256_bytes(data)
    return hits


def assert_private_path_free(
    bundle: Path,
    exact_markers: Iterable[Path],
) -> dict[str, Any]:
    hits = private_path_hits(bundle)
    acknowledged_hits: dict[str, str] = {}
    for relative, (expected_size, expected_sha) in ACKNOWLEDGED_INHERITED_PRIVATE_PATHS.items():
        if relative not in hits:
            continue
        target = bundle / Path(relative)
        if (
            not target.is_file()
            or target.stat().st_size != expected_size
            or hits[relative] != expected_sha
        ):
            raise BuildError(f"ACKNOWLEDGED_PRIVATE_PATH_BINDING_MISMATCH:{relative}")
        acknowledged_hits[relative] = hits[relative]
    unauthorized_hits = {
        relative: digest for relative, digest in hits.items()
        if relative not in acknowledged_hits
    }
    markers = []
    for marker in exact_markers:
        value = str(marker.resolve())
        markers.extend((
            value.encode("utf-8"),
            value.replace("\\", "/").encode("utf-8"),
            value.encode("utf-16le"),
            value.replace("\\", "/").encode("utf-16le"),
        ))
    exact_hits = []
    for item in BASE.regular_files(bundle):
        data = item.read_bytes()
        if any(marker and marker in data for marker in markers):
            exact_hits.append(item.relative_to(bundle).as_posix())
    if unauthorized_hits or exact_hits:
        raise BuildError(
            f"PRIVATE_PATH_LEAK:entries={len(unauthorized_hits)}:exact={len(exact_hits)}"
        )
    return {
        "whole_zip_user_profile_path_free": not acknowledged_hits,
        "new_build_user_profile_path_free": True,
        "inherited_carrier_user_profile_paths_present": bool(acknowledged_hits),
        "private_path_entry_count": len(acknowledged_hits),
        "private_path_entries": sorted(acknowledged_hits),
        "exact_build_path_hits": 0,
    }


def preserved_carrier_record(
    bundle: Path,
    before: dict[str, Any],
    replaced_paths: set[str],
) -> dict[str, Any]:
    rows = [row for row in before["files"] if row["path"] not in replaced_paths]
    for row in rows:
        target = bundle / Path(row["path"])
        if not target.is_file() or target.stat().st_size != row["size"] or BASE.sha256_file(target) != row["sha256"]:
            raise BuildError(f"PRESERVED_CARRIER_FILE_CHANGED:{row['path']}")
    return record_from_rows(rows)


def write_runtime_manifest(
    runtime: Path,
    source_head: str,
    overlay: dict[str, Any],
    carrier_only: dict[str, Any],
    preserved: dict[str, Any],
    toolchain: dict[str, Any],
    service_build: dict[str, Any],
) -> dict[str, Any]:
    files = BASE.inventory(runtime, {"MANIFEST.json"})
    manifest = {
        "schema_version": "opiu-runtime-manifest.v2",
        "work_id": WORK_ID,
        "source_head": source_head,
        "runtime_source_sha": source_head,
        "candidate_status": "REPORT_ONLY_REVIEW_CANDIDATE",
        "artifact_publication_authorized_by_owner": False,
        "artifact_published_by_builder": False,
        "release_approved": False,
        "live_1c_approved": False,
        "runtime_overlay_inventory": overlay,
        "preserved_carrier_reference_inventory": carrier_only,
        "preserved_carrier_inventory": preserved,
        "toolchain": toolchain,
        "service_build": service_build,
        "safety": closed_safety(source_head),
        "files": files,
        "file_count": len(files),
    }
    (runtime / "MANIFEST.json").write_bytes(canonical_json_bytes(manifest))
    return manifest


def replaced_paths_for(overlay: dict[str, Any], before: dict[str, Any]) -> set[str]:
    replaced = {
        SERVICE_EXE_NAME,
        *REPLACED_METADATA_PATHS,
        *(bundle_relative_for_overlay(row["path"]) for row in overlay["files"]),
        *REMOVED_PRIVATE_CARRIER_FILES,
    }
    before_paths = {row["path"] for row in before["files"]}
    replaced.update(path for path in before_paths if any(
        path == prefix or path.startswith(f"{prefix}/") for prefix in LEGACY_RULES_RUNTIME_PATHS
    ))
    return {path for path in replaced if path in before_paths}


def assemble_candidate(
    bundle: Path,
    repository: Path,
    source_head: str,
    service_exe: Path,
    source_inventory: dict[str, Any],
    overlay: dict[str, Any],
    toolchain: dict[str, Any],
    service_build: dict[str, Any],
    exact_private_markers: Iterable[Path],
) -> dict[str, Any]:
    bundle = bundle.resolve()
    runtime = bundle / "runtime"
    if not runtime.is_dir():
        raise BuildError("CARRIER_RUNTIME_MISSING")
    structural_control_packaging_proof = verify_structural_control_packaging_closure(
        overlay,
        source_inventory,
    )
    old_service = bundle / SERVICE_EXE_NAME
    if not old_service.is_file() or BASE.sha256_file(old_service) != BASE_SERVICE_EXE_SHA256:
        raise BuildError("BASE_SERVICE_EXE_MISMATCH")
    old_safety = BASE.load_json(runtime / "SAFETY.json")
    BASE.assert_report_only(old_safety)
    before = inventory_with_source(bundle)
    carrier_only = verify_carrier_managed_closure(bundle, overlay)
    removed_private = remove_exact_private_carrier_files(bundle)
    removed_rules = remove_legacy_rules_runtime(bundle)

    apply_runtime_overlay(bundle, repository / product_root_relative(repository), overlay)
    actual_overlay = {row["path"]: row for row in managed_candidate_inventory(bundle)["files"]}
    for expected in overlay["files"]:
        actual = actual_overlay.get(expected["path"])
        if not actual or actual["size"] != expected["size"] or actual["sha256"] != expected["sha256"]:
            raise BuildError(f"STALE_RUNTIME_OVERLAY:{expected['path']}")

    shutil.copyfile(service_exe, old_service)
    new_service_sha = BASE.sha256_file(old_service)
    if new_service_sha == BASE_SERVICE_EXE_SHA256:
        raise BuildError("STALE_SERVICE_EXE_NOT_REPLACED")
    if new_service_sha != service_build["first_sha256"] or new_service_sha != service_build["second_sha256"]:
        raise BuildError("SERVICE_EXE_BUILD_BINDING_MISMATCH")

    (runtime / "SAFETY.json").write_bytes(canonical_json_bytes(closed_safety(source_head)))
    write_module_manifests(runtime, source_head, overlay, carrier_only)
    replaced = replaced_paths_for(overlay, before)
    preserved = preserved_carrier_record(bundle, before, replaced)
    service_record = {
        "old_carrier_sha256": BASE_SERVICE_EXE_SHA256,
        "first_sha256": service_build["first_sha256"],
        "second_sha256": service_build["second_sha256"],
        "packaged_sha256": new_service_sha,
        "size": old_service.stat().st_size,
        "deterministic_double_build": True,
        "old_exe_replaced": True,
    }
    runtime_manifest = write_runtime_manifest(
        runtime, source_head, overlay, carrier_only, preserved, toolchain, service_record,
    )

    info = "\n".join((
        "OPIU_STABLE 1.9.4 — COMBINED REPORT_ONLY REVIEW CANDIDATE",
        f"WORK-ID: {WORK_ID}",
        f"SOURCE HEAD: {source_head}",
        "STATUS: REPORT_ONLY_REVIEW_CANDIDATE",
        "Artifact publication is not authorized by this builder.",
        "posting_rows=0; ready_to_upload=false; release_allowed=false; live_1c_allowed=false.",
        "",
    ))
    (bundle / "QA52_PACKAGE_INFO.txt").write_text(info, encoding="utf-8")
    candidate = {
        "schema_version": SCHEMA_VERSION,
        "work_id": WORK_ID,
        "source_head": source_head,
        "candidate_status": "REPORT_ONLY_REVIEW_CANDIDATE",
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "runtime_overlay_inventory": overlay,
        "preserved_carrier_reference_inventory": carrier_only,
        "removed_private_carrier_inventory": removed_private,
        "removed_legacy_rules_runtime_inventory": removed_rules,
        "preserved_carrier_inventory": preserved,
        "service_source_inventory": source_inventory,
        "structural_control_packaging_proof": structural_control_packaging_proof,
        "toolchain": toolchain,
        "service_build": service_record,
        "runtime_manifest_sha256": BASE.sha256_file(runtime / "MANIFEST.json"),
        "business_inputs_included": False,
        "business_outputs_included": False,
        "artifact_publication_authorized_by_owner": False,
        "artifact_published_by_builder": False,
        "release_approved": False,
        "live_1c_approved": False,
        "safety": closed_safety(source_head),
    }
    (bundle / "COMBINED_RUNTIME_SERVICE_CANDIDATE.json").write_bytes(
        canonical_json_bytes(candidate),
    )
    provenance = {
        **candidate,
        "runtime_file_count": runtime_manifest["file_count"],
        "full_year_financial_e2e_performed": False,
    }
    (bundle / "SERVICE_BUILD_PROVENANCE.json").write_bytes(canonical_json_bytes(provenance))
    (bundle / "BUNDLE_PROVENANCE.json").write_bytes(canonical_json_bytes(provenance))

    path_leakage = assert_private_path_free(bundle, exact_private_markers)
    provenance["path_leakage"] = path_leakage
    (bundle / "SERVICE_BUILD_PROVENANCE.json").write_bytes(canonical_json_bytes(provenance))
    (bundle / "BUNDLE_PROVENANCE.json").write_bytes(canonical_json_bytes(provenance))
    candidate["path_leakage"] = path_leakage
    (bundle / "COMBINED_RUNTIME_SERVICE_CANDIDATE.json").write_bytes(
        canonical_json_bytes(candidate),
    )

    old_manifest = bundle / "BUNDLE_MANIFEST.json"
    old_manifest.unlink(missing_ok=True)
    manifest_rows = BASE.inventory(bundle)
    bundle_manifest = {
        **candidate,
        "files": manifest_rows,
        "file_count": len(manifest_rows),
    }
    old_manifest.write_bytes(canonical_json_bytes(bundle_manifest))
    assert_private_path_free(bundle, exact_private_markers)
    verify_candidate_bundle(bundle, source_head, overlay, carrier_only, preserved, service_record)
    return candidate


def assert_closed_safety_document(value: dict[str, Any]) -> None:
    safety = value.get("safety", value)
    if not isinstance(safety, dict):
        raise BuildError("REPORT_ONLY_SAFETY_GATE_MISSING")
    BASE.assert_report_only(safety)
    for field in ("artifact_publication_authorized_by_owner", "release_approved", "live_1c_approved"):
        if value.get(field) is not False:
            raise BuildError(f"STALE_APPROVAL_CLAIM:{field}")
    if "RELEASE_ARTIFACT" in str(value.get("candidate_status", "")):
        raise BuildError("STALE_RELEASE_ARTIFACT_STATUS")


def verify_inventory_rows(root: Path, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        target = root / Path(row["path"])
        if not target.is_file() or target.stat().st_size != row["size"] or BASE.sha256_file(target) != row["sha256"]:
            raise BuildError(f"MANIFEST_FILE_MISMATCH:{row['path']}")


def verify_overlay_rows(bundle: Path, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        target = overlay_target(bundle, row["path"])
        if not target.is_file() or target.stat().st_size != row["size"] or BASE.sha256_file(target) != row["sha256"]:
            raise BuildError(f"OVERLAY_FILE_MISMATCH:{row['path']}")


def verify_candidate_bundle(
    bundle: Path,
    source_head: str,
    overlay: dict[str, Any],
    carrier_only: dict[str, Any],
    preserved: dict[str, Any],
    service_record: dict[str, Any],
) -> None:
    service = bundle / SERVICE_EXE_NAME
    if BASE.sha256_file(service) != service_record["packaged_sha256"]:
        raise BuildError("PACKAGED_SERVICE_EXE_DRIFT")
    if service_record["packaged_sha256"] == BASE_SERVICE_EXE_SHA256:
        raise BuildError("PACKAGED_SERVICE_EXE_STALE")
    runtime = bundle / "runtime"
    if any((bundle / Path(relative)).exists() for relative in LEGACY_RULES_RUNTIME_PATHS):
        raise BuildError("LEGACY_RULES_RUNTIME_PRESENT")
    safety = BASE.load_json(runtime / "SAFETY.json")
    assert_closed_safety_document(safety)
    if safety.get("rules_service") is not False or safety.get("pipeline") != "R005_SERVICE_HANDOFF_R001":
        raise BuildError("DIRECT_PIPELINE_SAFETY_DECLARATION_MISSING")
    if safety.get("runtime_source_sha") != source_head:
        raise BuildError("SAFETY_SOURCE_HEAD_MISMATCH")
    for module in MODULE_NAMES:
        manifest = BASE.load_json(runtime / "modules" / module / "MODULE_MANIFEST.json")
        assert_closed_safety_document(manifest)
        if manifest.get("source_head") != source_head or manifest.get("runtime_source_sha") != source_head:
            raise BuildError("MODULE_MANIFEST_SOURCE_HEAD_MISMATCH")
        verify_inventory_rows(runtime, manifest.get("files", []))
    runtime_manifest = BASE.load_json(runtime / "MANIFEST.json")
    assert_closed_safety_document(runtime_manifest)
    if runtime_manifest.get("source_head") != source_head or runtime_manifest.get("runtime_source_sha") != source_head:
        raise BuildError("RUNTIME_MANIFEST_SOURCE_HEAD_MISMATCH")
    expected_runtime = BASE.inventory(runtime, {"MANIFEST.json"})
    if runtime_manifest.get("files") != expected_runtime:
        raise BuildError("RUNTIME_MANIFEST_INVENTORY_MISMATCH")
    verify_overlay_rows(bundle, overlay["files"])
    verify_overlay_rows(bundle, carrier_only["files"])
    verify_inventory_rows(bundle, preserved["files"])
    bundle_manifest = BASE.load_json(bundle / "BUNDLE_MANIFEST.json")
    assert_closed_safety_document(bundle_manifest)
    metadata_paths = (
        "COMBINED_RUNTIME_SERVICE_CANDIDATE.json",
        "SERVICE_BUILD_PROVENANCE.json",
        "BUNDLE_PROVENANCE.json",
    )
    for relative in metadata_paths:
        document = BASE.load_json(bundle / relative)
        assert_closed_safety_document(document)
        if document.get("source_head") != source_head:
            raise BuildError(f"CANDIDATE_METADATA_SOURCE_HEAD_MISMATCH:{relative}")
        if document.get("runtime_overlay_inventory") != overlay:
            raise BuildError(f"CANDIDATE_METADATA_OVERLAY_MISMATCH:{relative}")
        if document.get("service_build", {}).get("packaged_sha256") != service_record["packaged_sha256"]:
            raise BuildError(f"CANDIDATE_METADATA_SERVICE_MISMATCH:{relative}")
        expected_structural_proof = verify_structural_control_packaging_closure(
            overlay,
            document.get("service_source_inventory", {}),
        )
        if document.get("structural_control_packaging_proof") != expected_structural_proof:
            raise BuildError(f"CANDIDATE_METADATA_STRUCTURAL_CLOSURE_MISMATCH:{relative}")
    expected_bundle = BASE.inventory(bundle, {"BUNDLE_MANIFEST.json"})
    if bundle_manifest.get("files") != expected_bundle:
        raise BuildError("BUNDLE_MANIFEST_INVENTORY_MISMATCH")
    initial_paths = {row["path"] for row in preserved["files"]}
    for item in BASE.regular_files(bundle):
        relative = item.relative_to(bundle).as_posix()
        parts = {part.lower() for part in PurePosixPath(relative).parts}
        if parts & FORBIDDEN_PATH_PARTS:
            raise BuildError(f"FORBIDDEN_PACKAGE_PATH:{relative}")
        if (
            item.suffix.lower() in FORBIDDEN_NEW_SUFFIXES
            and relative not in initial_paths
            and relative not in GIT_BOUND_USER_SETTINGS
        ):
            raise BuildError(f"FORBIDDEN_NEW_PACKAGE_FILE:{relative}")
    assert_private_path_free(bundle, ())


def validate_zip_entries(archive_path: Path, bundle: Path) -> None:
    expected = {
        f"OPIU/{row['path']}": row for row in BASE.inventory(bundle)
    }
    seen: set[str] = set()
    seen_casefold: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos if not info.is_dir()]
        if names != sorted(names):
            raise BuildError("OUTPUT_ZIP_ORDER_NOT_DETERMINISTIC")
        for info in infos:
            name = info.filename
            pure = PurePosixPath(name)
            if (
                pure.is_absolute() or ".." in pure.parts or "\\" in name
                or re.match(r"^[A-Za-z]:", name) or info.flag_bits & 0x1
            ):
                raise BuildError("OUTPUT_ZIP_ENTRY_UNSAFE")
            normalized = pure.as_posix().rstrip("/")
            folded = normalized.casefold()
            if normalized in seen or folded in seen_casefold:
                raise BuildError("OUTPUT_ZIP_ENTRY_DUPLICATE")
            seen.add(normalized)
            seen_casefold.add(folded)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise BuildError("OUTPUT_ZIP_SYMLINK_FORBIDDEN")
            if not info.is_dir() and tuple(info.date_time) != FIXED_ZIP_TIME:
                raise BuildError("OUTPUT_ZIP_TIMESTAMP_DRIFT")
        file_names = {info.filename for info in infos if not info.is_dir()}
        for name in file_names:
            parts = PurePosixPath(name).parts
            for index in range(1, len(parts)):
                prefix = PurePosixPath(*parts[:index]).as_posix()
                if prefix in file_names:
                    raise BuildError("OUTPUT_ZIP_FILE_DIRECTORY_COLLISION")
        if set(expected) != file_names:
            raise BuildError("OUTPUT_ZIP_INVENTORY_MISMATCH")
        if names.count(f"OPIU/{SERVICE_EXE_NAME}") != 1:
            raise BuildError("OUTPUT_ZIP_SERVICE_EXE_COUNT_INVALID")
        for name, row in expected.items():
            data = archive.read(name)
            if len(data) != row["size"] or sha256_bytes(data) != row["sha256"]:
                raise BuildError(f"OUTPUT_ZIP_FILE_HASH_MISMATCH:{name}")


def validate_carrier_entries(archive_path: Path) -> None:
    seen: set[str] = set()
    seen_casefold: set[str] = set()
    file_names: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            name = info.filename
            pure = PurePosixPath(name)
            if (
                not name or pure.is_absolute() or ".." in pure.parts or "\\" in name
                or re.match(r"^[A-Za-z]:", name) or info.flag_bits & 0x1
            ):
                raise BuildError("CARRIER_ZIP_ENTRY_UNSAFE")
            normalized = pure.as_posix().rstrip("/")
            folded = normalized.casefold()
            if not normalized or normalized in seen or folded in seen_casefold:
                raise BuildError("CARRIER_ZIP_ENTRY_DUPLICATE")
            seen.add(normalized)
            seen_casefold.add(folded)
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise BuildError("CARRIER_ZIP_SYMLINK_FORBIDDEN")
            if not info.is_dir():
                file_names.add(normalized)
        for name in file_names:
            parts = PurePosixPath(name).parts
            for index in range(1, len(parts)):
                prefix = PurePosixPath(*parts[:index]).as_posix()
                if prefix in file_names:
                    raise BuildError("CARRIER_ZIP_FILE_DIRECTORY_COLLISION")


def write_verified_zip_pair(bundle: Path, first: Path, second: Path) -> dict[str, Any]:
    first = first.resolve()
    second = second.resolve()
    if os.path.normcase(str(first)) == os.path.normcase(str(second)):
        raise BuildError("OUTPUT_PATHS_MUST_BE_DISTINCT")
    for output in (first, second):
        if output.exists():
            raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output.name}")
    temporary_paths: list[Path] = []
    promoted: list[Path] = []
    try:
        for output in (first, second):
            output.parent.mkdir(parents=True, exist_ok=True)
            descriptor, raw = tempfile.mkstemp(
                prefix=f".{output.name}.", suffix=".building", dir=output.parent,
            )
            os.close(descriptor)
            temporary = Path(raw)
            temporary.unlink()
            temporary_paths.append(temporary)
        BASE.write_deterministic_zip(bundle, temporary_paths[0])
        BASE.write_deterministic_zip(bundle, temporary_paths[1])
        validate_zip_entries(temporary_paths[0], bundle)
        validate_zip_entries(temporary_paths[1], bundle)
        first_hash = BASE.sha256_file(temporary_paths[0])
        second_hash = BASE.sha256_file(temporary_paths[1])
        if first_hash != second_hash or temporary_paths[0].read_bytes() != temporary_paths[1].read_bytes():
            raise BuildError("OUTPUT_ZIP_NONDETERMINISTIC")
        for temporary, output in zip(temporary_paths, (first, second), strict=True):
            os.link(temporary, output)
            promoted.append(output)
    except Exception:
        rollback_errors: list[str] = []
        for output in promoted:
            try:
                output.unlink(missing_ok=True)
            except OSError:
                rollback_errors.append(output.name)
        if rollback_errors:
            raise BuildError(f"OUTPUT_PAIR_ROLLBACK_FAILED:{','.join(rollback_errors)}")
        raise
    finally:
        for temporary in temporary_paths:
            temporary.unlink(missing_ok=True)
    return {
        "first_output_name": first.name,
        "second_output_name": second.name,
        "first_sha256": first_hash,
        "second_sha256": second_hash,
        "size": first.stat().st_size,
        "byte_identical": True,
        "zip_inventory_verified_before_promotion": True,
    }


def build(
    carrier_archive: Path,
    repository: Path,
    go_exe: Path,
    output_a: Path,
    output_b: Path,
    source_head: str,
) -> dict[str, Any]:
    carrier_archive = carrier_archive.resolve()
    repository = repository.resolve()
    output_a = output_a.resolve()
    output_b = output_b.resolve()
    assert_outputs_outside_repository(repository, output_a, output_b)
    if not carrier_archive.is_file() or BASE.sha256_file(carrier_archive) != BASE_ARCHIVE_SHA256:
        raise BuildError("BASE_ARCHIVE_HASH_MISMATCH")
    validate_carrier_entries(carrier_archive)
    verified_head = BASE.verify_repository(repository, source_head)
    service_source_root = repository / service_source_relative(repository)
    source_record = exact_service_source_inventory(repository, verified_head)
    overlay_record = exact_runtime_overlay_inventory(repository, verified_head)
    verify_structural_control_packaging_closure(overlay_record, source_record)
    with tempfile.TemporaryDirectory(prefix="opiu-combined-package-") as raw:
        temporary = Path(raw)
        built = BASE.test_and_build_service(go_exe, service_source_root, temporary / "go-build")
        verify_service_source_unchanged(repository, verified_head, source_record)
        BASE.verify_repository(repository, verified_head)
        if exact_runtime_overlay_inventory(repository, verified_head) != overlay_record:
            raise BuildError("RUNTIME_OVERLAY_CHANGED_DURING_BUILD")
        bundle = BASE.checked_extract(carrier_archive, temporary / "carrier")
        service_build = {
            "first_sha256": built["first_sha256"],
            "second_sha256": built["second_sha256"],
            "size": built["size"],
            "go_test_passed": built["go_test_passed"],
            "deterministic_double_build": built["deterministic_double_build"],
            "test_command": built["test_command"],
            "build_command": built["build_command"],
        }
        candidate = assemble_candidate(
            bundle,
            repository,
            verified_head,
            built["first_exe"],
            source_record,
            overlay_record,
            built["toolchain"],
            service_build,
            (repository, go_exe.parent.parent, temporary),
        )
        BASE.verify_source_unchanged(repository, verified_head, service_source_root, source_record)
        if exact_runtime_overlay_inventory(repository, verified_head) != overlay_record:
            raise BuildError("RUNTIME_OVERLAY_CHANGED_BEFORE_ZIP")
        outputs = write_verified_zip_pair(bundle, output_a, output_b)
    return {
        "status": "BUILT_REPORT_ONLY_REVIEW_CANDIDATE",
        "work_id": WORK_ID,
        "source_head": verified_head,
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "runtime_overlay_file_count": overlay_record["file_count"],
        "runtime_overlay_inventory_sha256": overlay_record["sha256"],
        "service_source_file_count": source_record["file_count"],
        "service_source_inventory_sha256": source_record["sha256"],
        "service_exe_sha256": candidate["service_build"]["packaged_sha256"],
        "go_test_passed": True,
        "deterministic_double_build": True,
        "full_year_financial_e2e_performed": False,
        "release_approved": False,
        "live_1c_approved": False,
        "safety": BASE.closed_safety(),
        **outputs,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--carrier", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--go-exe", type=Path, required=True)
    parser.add_argument("--output-a", type=Path, required=True)
    parser.add_argument("--output-b", type=Path, required=True)
    parser.add_argument("--source-head", required=True)
    arguments = parser.parse_args()
    try:
        result = build(
            arguments.carrier,
            arguments.repository,
            arguments.go_exe,
            arguments.output_a,
            arguments.output_b,
            arguments.source_head,
        )
    except BuildError as error:
        public_code = str(error).split(":", 1)[0] or "BUILD_BLOCKED"
        parser.exit(2, json.dumps({"status": "BUILD_BLOCKED", "error": public_code}) + "\n")
    except Exception:
        parser.exit(2, json.dumps({"status": "BUILD_BLOCKED", "error": "UNEXPECTED_BUILD_FAILURE"}) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
