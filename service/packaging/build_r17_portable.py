#!/usr/bin/env python3
"""Build two independent, byte-identical, ARCH-gated OPIU R17 portable ZIPs.

This builder is deliberately release-incompetent: every produced document is
REPORT_ONLY and all release, execution, upload, posting and live-1C gates stay
closed.  The current pre-ARCH baseline is expected to stop at the legacy Rules
gate before a Go build or archive write occurs.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable


POLICY_PATH = Path(__file__).with_name("r17_portable_policy.json")
_BASE_PATH = Path(__file__).with_name("build_clean_source_service_candidate.py")
_INDEPENDENT_VERIFIER_PATH = Path(__file__).with_name("verify_r17_portable.py")
_BASE_SPEC = importlib.util.spec_from_file_location("opiu_r17_packaging_base", _BASE_PATH)
if _BASE_SPEC is None or _BASE_SPEC.loader is None:
    raise RuntimeError("CLEAN_PACKAGING_BASE_IMPORT_FAILED")
BASE = importlib.util.module_from_spec(_BASE_SPEC)
_BASE_SPEC.loader.exec_module(BASE)
BuildError = BASE.BuildError

SCHEMA_VERSION = "opiu-r17-package-manifest.v1"
PROVENANCE_SCHEMA = "opiu-r17-build-provenance.v1"
RUNTIME_SCHEMA = "opiu-r17-runtime-manifest.v1"
POLICY_SCHEMA = "opiu-r17-portable-policy.v1"
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
RUNTIME_LOGICAL_ROOT = "runtime"
RUNTIME_EDGE_PATH_FORMAT = "POSIX_RELATIVE_TO_LOGICAL_ROOT"
EXPECTED_POLICY_VALUE_SHA256 = "71F45E284FBD39FDBA6DAD79A7FEF50EC862E48D82B9C6C989219C72D44D85EB"
RELATIVE_IMPORT_PATTERNS = (
    re.compile(r'''(?:from\s+|import\s*\(\s*|require\s*\(\s*|new\s+URL\s*\(\s*)["'](\.[^"']+)["']'''),
    re.compile(r'''\bimport\s*["'](\.[^"']+)["']'''),
)
GENERIC_PROFILE_PATTERNS = (
    re.compile(rb"(?i)(?:[A-Z]:[\\/]Users[\\/]|/Users/|/home/)"),
    re.compile(rb"(?i)(?:[A-Z]\x00:\x00[\\/]\x00U\x00s\x00e\x00r\x00s\x00[\\/]\x00|/\x00U\x00s\x00e\x00r\x00s\x00/\x00|/\x00h\x00o\x00m\x00e\x00/\x00)"),
    re.compile(rb"(?i)(?:\x00[A-Z]\x00:\x00[\\/]\x00U\x00s\x00e\x00r\x00s\x00[\\/]|\x00/\x00U\x00s\x00e\x00r\x00s\x00/|\x00/\x00h\x00o\x00m\x00e\x00/)"),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    return BASE.sha256_file(path)


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def materialize_runtime_safety(stage: Path, policy: dict[str, Any]) -> dict[str, Any]:
    """Create the fail-closed runtime safety gate with exact canonical bytes."""
    safety = dict(policy["safety"])
    assert_closed_safety(safety, policy["safety"])
    target = stage / "runtime" / "SAFETY.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = canonical_json(safety)
    if target.is_symlink() or (target.exists() and is_reparse(target)):
        raise BuildError("RUNTIME_SAFETY_PATH_UNSAFE")
    if target.exists() and target.read_bytes() != expected:
        raise BuildError("RUNTIME_SAFETY_PREEXISTING_CONFLICT")
    target.write_bytes(expected)
    actual = target.read_bytes()
    if actual != expected:
        raise BuildError("RUNTIME_SAFETY_CANONICAL_WRITE_MISMATCH")
    return {
        "path": "runtime/SAFETY.json",
        "size": len(actual),
        "sha256": sha256_bytes(actual),
    }


def policy_value_sha256(value: dict[str, Any]) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(payload)


def load_policy(path: Path = POLICY_PATH) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise BuildError(f"POLICY_READ_FAILED:{error}") from error
    if not isinstance(value, dict):
        raise BuildError("POLICY_OBJECT_REQUIRED")
    validate_policy(value)
    return value


def validate_policy(policy: dict[str, Any]) -> None:
    if policy_value_sha256(policy) != EXPECTED_POLICY_VALUE_SHA256:
        raise BuildError("POLICY_VALUE_SET_NOT_EXACT")
    exact = {
        "schema_version": POLICY_SCHEMA,
        "archive_name": "OPIU_R17.zip",
        "archive_root": "OPIU_R17",
        "executable_name": "OPIU_R17.exe",
        "fixed_zip_time": [2026, 8, 27, 0, 0, 0],
        "compression": "DEFLATE9",
    }
    for field, expected in exact.items():
        if policy.get(field) != expected:
            raise BuildError(f"POLICY_CANONICAL_VALUE_INVALID:{field}")
    contract = policy.get("contract", {})
    if contract != {
        "source": "contracts/Контракт_ОПИУ_v0.5_зафиксированный.docx",
        "package_path": "contract/OPIU_v0.5.docx",
        "sha256": "B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A",
    }:
        raise BuildError("POLICY_CONTRACT_BINDING_INVALID")
    go = policy.get("toolchains", {}).get("go", {})
    if (
        go.get("go_exe_sha256") != BASE.EXPECTED_GO_EXE_SHA256
        or go.get("file_count") != BASE.EXPECTED_GO_TOOLCHAIN_FILE_COUNT
        or go.get("inventory_sha256") != BASE.EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256
    ):
        raise BuildError("POLICY_GO_BINDING_INVALID")
    node = policy.get("toolchains", {}).get("node", {})
    if (
        node.get("version_line") != "v24.14.0"
        or node.get("node_exe_sha256") != "63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088"
        or node.get("node_exe_size") != 91380224
        or node.get("inventory_sha256") != "EA2AF5CAFD6DACC3C9EFAC1FA03627053ECC8B54040202FCC7EA04ADCE261837"
    ):
        raise BuildError("POLICY_NODE_BINDING_INVALID")
    modules = policy.get("toolchains", {}).get("node_modules", {})
    if (
        modules.get("file_count") != 294
        or modules.get("total_size") != 50570254
        or modules.get("inventory_sha256") != "9A31C6F4FCCA4DDDB93DFC1E50DC06B03F2EBAB5B7575DDF7EF6CCE5502F1059"
        or modules.get("packages") != {
            "jszip": "3.10.1", "@oai/artifact-tool": "2.8.31", "skia-canvas": "3.0.8",
        }
    ):
        raise BuildError("POLICY_NODE_MODULES_BINDING_INVALID")
    assert_closed_safety(policy.get("safety"))
    privacy = policy.get("privacy", {})
    exception = privacy.get("allowed_upstream_debug_exception", {})
    if (
        privacy.get("whole_zip_user_profile_path_free") is not False
        or exception.get("path") != "runtime/node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node"
        or exception.get("size") != 24231424
        or exception.get("sha256") != "4E5B185CCDFFCEEDE5468B47C4646E2CE66F4E85EC35A753007EC32CB8720498"
        or exception.get("runneradmin_hits") != 160
        or exception.get("d_drive_a_hits") != 3
    ):
        raise BuildError("POLICY_PRIVACY_EXCEPTION_INVALID")
    if policy.get("runtime_exact_files") != expected_runtime_exact_files():
        raise BuildError("POLICY_RUNTIME_EXACT_FILES_BINDING_INVALID")
    if "data/defaults" not in policy.get("runtime_source_roots", []):
        raise BuildError("POLICY_RUNTIME_ORGANIZATIONS_ROOT_MISSING")


def assert_closed_safety(value: Any, expected: dict[str, Any] | None = None) -> None:
    required = expected or {
        "mode": "REPORT_ONLY", "report_only": True, "rules_service": False,
        "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
        "ready_to_upload": False, "release_allowed": False,
        "external_release_allowed": False, "execution_allowed": False,
        "live_1c_allowed": False, "live_delete_allowed": False,
        "automatic_1c_upload_allowed": False, "automatic_1c_posting_allowed": False,
        "artifact_publication_authorized": False,
    }
    if not isinstance(value, dict) or value != required:
        raise BuildError("REPORT_ONLY_SAFETY_GATES_NOT_EXACT")


def expected_runtime_exact_files() -> list[dict[str, Any]]:
    return [{
        "role": "organizations",
        "source_path": "data/defaults/organizations.json",
        "package_path": "runtime/data/defaults/organizations.json",
        "size": 653773,
        "sha256": "FA28B10504520A8EF5BD47ADED85401F2B521938479E4E895BCE37861AA6DE1B",
    }]


def is_reparse(path: Path) -> bool:
    try:
        return bool(getattr(os.lstat(path), "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError as error:
        raise BuildError(f"PATH_METADATA_FAILED:{path.name}") from error


def safe_files(root: Path) -> list[Path]:
    root = root.absolute()
    if not root.is_dir() or root.is_symlink() or is_reparse(root):
        raise BuildError("TREE_ROOT_UNSAFE")
    result: list[Path] = []
    for item in root.rglob("*"):
        if item.is_symlink() or is_reparse(item):
            raise BuildError(f"SYMLINK_OR_REPARSE_FORBIDDEN:{item.relative_to(root).as_posix()}")
        if item.is_file():
            result.append(item)
    return sorted(result, key=lambda item: item.relative_to(root).as_posix())


def inventory_rows(root: Path, excluded: Iterable[str] = ()) -> list[dict[str, Any]]:
    excluded_set = set(excluded)
    return [
        {"path": item.relative_to(root).as_posix(), "size": item.stat().st_size, "sha256": sha256_file(item)}
        for item in safe_files(root)
        if item.relative_to(root).as_posix() not in excluded_set
    ]


def inventory_record(root: Path, excluded: Iterable[str] = ()) -> dict[str, Any]:
    rows = inventory_rows(root, excluded)
    return inventory_record_from_rows(rows)


def inventory_record_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rows = sorted((dict(row) for row in rows), key=lambda row: row["path"])
    payload = (json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    return {
        "file_count": len(rows), "total_size": sum(row["size"] for row in rows),
        "inventory_sha256": sha256_bytes(payload), "files": rows,
    }


def _git_output_bytes(repository: Path, *arguments: str) -> bytes:
    result = BASE.run_process_bytes(
        ["git", "-c", "core.quotePath=false", "-C", str(repository), *arguments],
        cwd=repository, env=dict(os.environ),
    )
    BASE.require_binary_process(result, f"GIT_{arguments[0].upper().replace('-', '_')}")
    return result.stdout


def source_scope_paths(policy: dict[str, Any]) -> list[str]:
    values = [
        "service/source", *policy["runtime_source_roots"], policy["contract"]["source"],
        *(row["path"] for row in policy["unicode_settings"]),
    ]
    return sorted(set(values))


def _git_tree(repository: Path, source_head: str, scopes: list[str]) -> dict[str, dict[str, str]]:
    raw = _git_output_bytes(repository, "ls-tree", "-r", "-z", source_head, "--", *scopes)
    rows: dict[str, dict[str, str]] = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, separator, raw_path = record.partition(b"\t")
        if not separator:
            raise BuildError("GIT_TREE_ROW_INVALID")
        parts = metadata.decode("ascii", "strict").split()
        if len(parts) != 3 or parts[1] != "blob" or parts[0] not in {"100644", "100755"}:
            raise BuildError("GIT_TREE_ENTRY_UNSAFE")
        relative = raw_path.decode("utf-8", "strict")
        pure = PurePosixPath(relative)
        if pure.is_absolute() or ".." in pure.parts or relative in rows:
            raise BuildError("GIT_TREE_PATH_UNSAFE")
        rows[relative] = {"git_mode": parts[0], "git_blob": parts[2]}
    if not rows:
        raise BuildError("GIT_SOURCE_SCOPE_EMPTY")
    return rows


def _git_blob_id(data: bytes, object_format: str) -> str:
    if object_format not in {"sha1", "sha256"}:
        raise BuildError("GIT_OBJECT_FORMAT_UNSUPPORTED")
    digest = hashlib.new(object_format)
    digest.update(f"blob {len(data)}\0".encode("ascii"))
    digest.update(data)
    return digest.hexdigest()


def _working_scope_files(repository: Path, scopes: list[str]) -> dict[str, Path]:
    rows: dict[str, Path] = {}
    for scope in scopes:
        target = repository / Path(scope)
        if target.is_file():
            candidates = [target]
        elif target.is_dir():
            candidates = safe_files(target)
        else:
            raise BuildError(f"SOURCE_SCOPE_MISSING:{scope}")
        for item in candidates:
            if item.is_symlink() or is_reparse(item):
                raise BuildError(f"SOURCE_SCOPE_LINK_FORBIDDEN:{scope}")
            relative = item.relative_to(repository).as_posix()
            if relative in rows and rows[relative] != item:
                raise BuildError("SOURCE_SCOPE_DUPLICATE")
            rows[relative] = item
    return rows


def exact_git_source_inventory(
    repository: Path, source_head: str, policy: dict[str, Any],
) -> dict[str, Any]:
    repository = repository.resolve()
    verified_head = BASE.verify_repository(repository, source_head)
    scopes = source_scope_paths(policy)
    tree = _git_tree(repository, verified_head, scopes)
    working = _working_scope_files(repository, scopes)
    expected_paths, actual_paths = set(tree), set(working)
    if expected_paths != actual_paths:
        missing = len(expected_paths - actual_paths)
        extra = len(actual_paths - expected_paths)
        raise BuildError(f"SOURCE_SCOPE_INJECTION_OR_MISSING:missing={missing}:extra={extra}")
    object_format = BASE.git_text(repository, "rev-parse", "--show-object-format").strip()
    rows: list[dict[str, Any]] = []
    for relative in sorted(tree):
        data = working[relative].read_bytes()
        if _git_blob_id(data, object_format) != tree[relative]["git_blob"]:
            raise BuildError(f"SOURCE_TRACKED_BLOB_DRIFT:{relative}")
        rows.append({
            "path": relative, "size": len(data), "sha256": sha256_bytes(data),
            "git_blob": tree[relative]["git_blob"], "git_mode": tree[relative]["git_mode"],
        })
    record = inventory_record_from_rows(rows)
    record.update({
        "source_head": verified_head, "git_object_format": object_format,
        "scopes": scopes, "exact_git_blobs": True, "ignored_injection_checked": True,
    })
    return record


def _git_blob_bytes(repository: Path, row: dict[str, Any]) -> bytes:
    data = _git_output_bytes(repository, "cat-file", "blob", row["git_blob"])
    if len(data) != row["size"] or sha256_bytes(data) != row["sha256"]:
        raise BuildError(f"GIT_BLOB_READ_MISMATCH:{row['path']}")
    return data


def source_subrecord(source_record: dict[str, Any], prefixes: Iterable[str]) -> dict[str, Any]:
    normalized = tuple(prefix.rstrip("/") for prefix in prefixes)
    rows = [
        dict(row) for row in source_record["files"]
        if any(row["path"] == prefix or row["path"].startswith(prefix + "/") for prefix in normalized)
    ]
    if not rows:
        raise BuildError("SOURCE_SUBRECORD_EMPTY")
    return inventory_record_from_rows(rows)


def extract_git_tree(
    repository: Path, source_record: dict[str, Any], prefix: str, target: Path,
    *, policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    prefix = prefix.rstrip("/")
    written: list[dict[str, Any]] = []
    for row in source_record["files"]:
        if not row["path"].startswith(prefix + "/"):
            continue
        local = row["path"][len(prefix) + 1:]
        if policy is not None and _excluded(row["path"], policy):
            continue
        destination = target / Path(local)
        if destination.exists():
            raise BuildError(f"GIT_EXTRACTION_COLLISION:{row['path']}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(_git_blob_bytes(repository, row))
        written.append({
            "path": row["path"], "size": row["size"], "sha256": row["sha256"],
            "git_blob": row["git_blob"], "git_mode": row["git_mode"],
        })
    if not written:
        raise BuildError(f"GIT_EXTRACTION_EMPTY:{prefix}")
    return inventory_record_from_rows(written)


def extract_service_test_tree(
    repository: Path, source_record: dict[str, Any], target: Path, policy: dict[str, Any],
) -> tuple[Path, dict[str, Any], dict[str, dict[str, Any]]]:
    """Recreate the Git-bound repository topology required by cross-runtime Go tests."""
    service_source = target / "service" / "source"
    service_record = extract_git_tree(
        repository, source_record, "service/source", service_source,
    )
    support_records: dict[str, dict[str, Any]] = {}
    for root_relative in policy["runtime_source_roots"]:
        support_records[root_relative] = extract_git_tree(
            repository, source_record, root_relative, target / Path(root_relative),
        )
    return service_source, service_record, support_records


def extract_git_file(
    repository: Path, source_record: dict[str, Any], relative: str, target: Path,
) -> None:
    row = next((item for item in source_record["files"] if item["path"] == relative), None)
    if row is None:
        raise BuildError(f"GIT_SOURCE_FILE_NOT_BOUND:{relative}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(_git_blob_bytes(repository, row))


def validate_relative_path(relative: str, policy: dict[str, Any], *, include_root: bool = True) -> None:
    if not relative or "\\" in relative or relative.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", relative):
        raise BuildError(f"PACKAGE_PATH_UNSAFE:{relative}")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        raise BuildError(f"PACKAGE_PATH_UNSAFE:{relative}")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise BuildError(f"PACKAGE_PATH_UNSAFE:{relative}")
    limits = policy["path_limits"]
    if any(len(part) > limits["component_max"] for part in pure.parts):
        raise BuildError(f"PACKAGE_COMPONENT_TOO_LONG:{relative}")
    if len(relative) > limits["relative_max"]:
        raise BuildError(f"PACKAGE_RELATIVE_PATH_TOO_LONG:{relative}")
    archive_relative = f"{policy['archive_root']}/{relative}" if include_root else relative
    full = limits["full_path_prefix"].rstrip("\\/") + "\\" + archive_relative.replace("/", "\\")
    if len(full) > limits["full_path_max"]:
        raise BuildError(f"PACKAGE_FULL_PATH_TOO_LONG:{relative}")


def validate_tree_paths(root: Path, policy: dict[str, Any]) -> None:
    seen: set[str] = set()
    for item in safe_files(root):
        relative = item.relative_to(root).as_posix()
        validate_relative_path(relative, policy)
        folded = relative.casefold()
        if folded in seen:
            raise BuildError(f"PACKAGE_PATH_CASEFOLD_DUPLICATE:{relative}")
        seen.add(folded)


def _resolve_relative_dependency(source: str, specifier: str) -> list[str]:
    clean = specifier.split("?", 1)[0].split("#", 1)[0]
    raw_parts = [*PurePosixPath(source).parent.parts, *PurePosixPath(clean).parts]
    parts: list[str] = []
    for part in raw_parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not parts:
                return []
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        return []
    candidate = PurePosixPath(*parts).as_posix()
    candidates = [candidate]
    if not PurePosixPath(candidate).suffix:
        candidates.extend(candidate + suffix for suffix in (".mjs", ".js", ".cjs", ".json"))
        candidates.extend(candidate + "/index" + suffix for suffix in (".mjs", ".js", ".cjs", ".json"))
    return candidates


def verify_runtime_dependency_closure(root: Path) -> dict[str, Any]:
    files = {item.relative_to(root).as_posix(): item for item in safe_files(root)}
    scan_files = {
        relative: item for relative, item in files.items()
        if not relative.startswith("node_modules/")
    }
    directories = {
        parent.as_posix()
        for relative in files
        for parent in PurePosixPath(relative).parents
        if parent.as_posix() not in {"", "."}
    }
    checked = 0
    edges: list[dict[str, str]] = []
    for relative, item in sorted(scan_files.items()):
        if PurePosixPath(relative).suffix.lower() not in {".mjs", ".js", ".cjs"}:
            continue
        try:
            text = item.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError as error:
            raise BuildError(f"RUNTIME_SOURCE_ENCODING_INVALID:{relative}") from error
        specifiers = []
        for pattern in RELATIVE_IMPORT_PATTERNS:
            specifiers.extend(pattern.findall(text))
        for specifier in sorted(set(specifiers)):
            checked += 1
            candidates = _resolve_relative_dependency(relative, specifier)
            matched = next((candidate for candidate in candidates if candidate in files), None)
            if matched is None and specifier.split("?", 1)[0].split("#", 1)[0].endswith("/"):
                directory = next((candidate for candidate in candidates[:1] if candidate in directories), None)
                if directory is not None:
                    matched = directory + "/"
            if matched is None:
                raise BuildError(f"RUNTIME_RELATIVE_IMPORT_MISSING:{relative}:{specifier}")
            edges.append({"source": relative, "specifier": specifier, "target": matched})
    return {
        "status": "PASS", "logical_root": RUNTIME_LOGICAL_ROOT,
        "edge_paths": RUNTIME_EDGE_PATH_FORMAT,
        "excluded_exact_inventory_roots": ["node_modules"],
        "relative_dependency_count": checked, "edges": edges,
    }


def _production_scan_files(repository: Path) -> list[Path]:
    roots = [repository / "service" / "source", repository / "modules"]
    files: list[Path] = []
    for root in roots:
        if root.is_dir():
            files.extend(safe_files(root))
    return [
        item for item in files
        if not item.name.endswith(("_test.go", ".test.mjs", ".test.cjs"))
        and "web_tests" not in item.parts and item.name.lower() not in {"readme.md", "readme_ru.md"}
    ]


def audit_legacy_rules_repository(repository: Path, policy: dict[str, Any]) -> dict[str, Any]:
    gate = policy["legacy_rules_gate"]
    violations: list[str] = []
    for relative in gate["forbidden_repository_paths"]:
        if (repository / Path(relative)).exists():
            violations.append(f"path:{relative}")
    immutable = gate["immutable_r001_exception"]
    tokens = [(category, token) for category, values in gate["forbidden_tokens"].items() for token in values]
    for item in _production_scan_files(repository):
        relative = item.relative_to(repository).as_posix()
        if relative == immutable:
            continue
        try:
            text = item.read_text(encoding="utf-8-sig")
        except (UnicodeDecodeError, OSError):
            continue
        for category, token in tokens:
            if token.casefold() in text.casefold():
                violations.append(f"{category}:{relative}:{token}")
    if violations:
        raise BuildError(f"LEGACY_RULES_GATE_BLOCKED:{len(set(violations))}")
    return {
        "status": "PASS", "rules_service": False, "violations": 0,
        "immutable_r001_exception": immutable,
    }


def _excluded(relative: str, policy: dict[str, Any]) -> bool:
    pure = PurePosixPath(relative)
    if any(part in set(policy["runtime_excluded_names"]) for part in pure.parts):
        return True
    return any(relative.endswith(suffix) for suffix in policy["runtime_excluded_suffixes"])


def copy_runtime_sources(
    repository: Path, source_record: dict[str, Any], stage: Path, policy: dict[str, Any],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for root_relative in policy["runtime_source_roots"]:
        target_root = stage / "runtime" / Path(root_relative)
        record = extract_git_tree(
            repository, source_record, root_relative, target_root, policy=policy,
        )
        rows.extend(record["files"])
    if not rows:
        raise BuildError("RUNTIME_SOURCE_SET_EMPTY")
    return {"status": "EXACT_GIT_BLOB_EXTRACTION", **inventory_record_from_rows(rows)}


def verify_node(node_exe: Path, node_modules: Path, policy: dict[str, Any]) -> dict[str, Any]:
    node_policy = policy["toolchains"]["node"]
    if (
        not node_exe.is_file() or node_exe.is_symlink() or is_reparse(node_exe)
        or node_exe.stat().st_size != node_policy["node_exe_size"]
        or sha256_file(node_exe) != node_policy["node_exe_sha256"]
    ):
        raise BuildError("NODE_EXECUTABLE_BINDING_MISMATCH")
    node_record = inventory_record(node_exe.parent, excluded=(
        item.relative_to(node_exe.parent).as_posix() for item in safe_files(node_exe.parent) if item != node_exe
    ))
    if node_record["file_count"] != 1 or node_record["inventory_sha256"] != node_policy["inventory_sha256"]:
        raise BuildError("NODE_INVENTORY_MISMATCH")
    environment = dict(os.environ)
    environment.update({"NODE_OPTIONS": "", "NODE_PATH": "", "NODE_ENV": "production", "TZ": "UTC"})
    try:
        result = subprocess.run(
            [str(node_exe), "--version"], cwd=str(node_exe.parent), env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", check=False,
        )
    except OSError as error:
        raise BuildError("NODE_VERSION_PROCESS_FAILED") from error
    if result.returncode != 0 or result.stdout.strip() != node_policy["version_line"]:
        raise BuildError("NODE_VERSION_MISMATCH")
    modules_policy = policy["toolchains"]["node_modules"]
    modules_record = inventory_record(node_modules)
    if (
        modules_record["file_count"] != modules_policy["file_count"]
        or modules_record["total_size"] != modules_policy["total_size"]
        or modules_record["inventory_sha256"] != modules_policy["inventory_sha256"]
    ):
        raise BuildError("NODE_MODULES_INVENTORY_MISMATCH")
    for package, version in modules_policy["packages"].items():
        manifest = node_modules / Path(package) / "package.json"
        if package == "skia-canvas" and not manifest.is_file():
            manifest = node_modules / "@oai" / "artifact-tool" / "node_modules" / "skia-canvas" / "package.json"
        try:
            actual = json.loads(manifest.read_text(encoding="utf-8-sig")).get("version")
        except (OSError, json.JSONDecodeError) as error:
            raise BuildError(f"NODE_PACKAGE_MANIFEST_INVALID:{package}") from error
        if actual != version:
            raise BuildError(f"NODE_PACKAGE_VERSION_MISMATCH:{package}")
    return {"node": node_record, "node_modules": modules_record, "packages": dict(modules_policy["packages"])}


def verify_contract_and_settings(source_record: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    by_path = {row["path"]: row for row in source_record["files"]}
    contract = by_path.get(policy["contract"]["source"])
    if not contract or contract["sha256"] != policy["contract"]["sha256"]:
        raise BuildError("CONTRACT_SHA256_MISMATCH")
    settings = []
    for row in policy["unicode_settings"]:
        source = by_path.get(row["path"])
        if not source or source["sha256"] != row["sha256"]:
            raise BuildError(f"UNICODE_SETTING_SHA256_MISMATCH:{row['path']}")
        settings.append(dict(row))
    exact_files = []
    for row in policy["runtime_exact_files"]:
        source = by_path.get(row["source_path"])
        if source is None:
            raise BuildError(f"RUNTIME_EXACT_FILE_MISSING:{row['role']}")
        if source["size"] != row["size"]:
            raise BuildError(f"RUNTIME_EXACT_FILE_SIZE_MISMATCH:{row['role']}")
        if source["sha256"] != row["sha256"]:
            raise BuildError(f"RUNTIME_EXACT_FILE_SHA256_MISMATCH:{row['role']}")
        exact_files.append(dict(row))
    return {
        "contract": dict(policy["contract"]), "unicode_settings": settings,
        "runtime_exact_files": exact_files,
    }


def verify_staged_runtime_exact_files(stage: Path, policy: dict[str, Any]) -> list[dict[str, Any]]:
    exact_files = []
    for row in policy["runtime_exact_files"]:
        target = stage / Path(row["package_path"])
        if not target.is_file():
            raise BuildError(f"RUNTIME_EXACT_FILE_MISSING:{row['role']}")
        if target.stat().st_size != row["size"]:
            raise BuildError(f"RUNTIME_EXACT_FILE_SIZE_MISMATCH:{row['role']}")
        if sha256_file(target) != row["sha256"]:
            raise BuildError(f"RUNTIME_EXACT_FILE_SHA256_MISMATCH:{row['role']}")
        exact_files.append(dict(row))
    return exact_files


def _copy_verified_tree(source: Path, target: Path) -> None:
    for item in safe_files(source):
        relative = item.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, destination)


def _privacy_markers(paths: Iterable[Path]) -> list[bytes]:
    markers: list[bytes] = []
    for path in paths:
        raw = str(path.resolve())
        for value in {raw, raw.replace("\\", "/")}:
            markers.extend((value.encode("utf-8"), value.encode("utf-16le"), value.encode("utf-16be")))
    return [marker for marker in markers if marker]


def audit_privacy(root: Path, policy: dict[str, Any], local_paths: Iterable[Path]) -> dict[str, Any]:
    exception = policy["privacy"]["allowed_upstream_debug_exception"]
    exception_path = exception["path"]
    exact_modules_prefix = policy["toolchains"]["node_modules"]["package_path"].rstrip("/") + "/"
    local_markers = _privacy_markers(local_paths)
    unauthorized: list[str] = []
    drive_a = re.compile(rb"(?i)D:\\a\\")
    runneradmin = re.compile(rb"(?i)runneradmin")
    found_exception = False
    for item in safe_files(root):
        relative = item.relative_to(root).as_posix()
        data = item.read_bytes()
        if any(marker in data for marker in local_markers):
            unauthorized.append(relative)
        profile_hits = 0 if relative.startswith(exact_modules_prefix) else sum(
            len(pattern.findall(data)) for pattern in GENERIC_PROFILE_PATTERNS
        )
        drive_hits = len(drive_a.findall(data))
        runner_hits = len(runneradmin.findall(data))
        if relative == exception_path:
            found_exception = True
            if (
                item.stat().st_size != exception["size"] or sha256_bytes(data) != exception["sha256"]
                or runner_hits != exception["runneradmin_hits"] or drive_hits != exception["d_drive_a_hits"]
            ):
                raise BuildError("UPSTREAM_DEBUG_EXCEPTION_BINDING_MISMATCH")
        elif profile_hits or drive_hits or runner_hits:
            unauthorized.append(relative)
    if not found_exception:
        raise BuildError("UPSTREAM_DEBUG_EXCEPTION_MISSING")
    if unauthorized:
        raise BuildError(f"LOCAL_CUSTOMER_BUILD_PATH_LEAK:{len(set(unauthorized))}")
    return {
        "local_customer_build_paths_absent": True,
        "local_customer_build_path_hits": 0,
        "exact_inventory_node_modules_generic_profile_scan_exempt": True,
        "only_allowed_upstream_debug_exception_present": True,
        "allowed_upstream_debug_exception": {
            "path": exception["path"], "size": exception["size"], "sha256": exception["sha256"],
            "username_occurrences": exception["runneradmin_hits"],
            "debug_root_occurrences": exception["d_drive_a_hits"],
        },
        "whole_zip_user_profile_path_free": False,
    }


def audit_legacy_rules_package(root: Path, policy: dict[str, Any]) -> dict[str, Any]:
    gate = policy["legacy_rules_gate"]
    immutable = gate["immutable_r001_exception"]
    violations: list[str] = []
    tokens = [(category, token) for category, values in gate["forbidden_tokens"].items() for token in values]
    for item in safe_files(root):
        relative = item.relative_to(root).as_posix()
        wrapped = f"/{relative}/"
        if any(fragment.casefold() in wrapped.casefold() for fragment in gate["forbidden_package_path_fragments"]):
            violations.append(f"path:{relative}")
        if relative == f"runtime/{immutable}":
            continue
        try:
            text = item.read_text(encoding="utf-8-sig")
        except (UnicodeDecodeError, OSError):
            continue
        for category, token in tokens:
            if token.casefold() in text.casefold():
                violations.append(f"{category}:{relative}:{token}")
    if violations:
        raise BuildError(f"PACKAGED_LEGACY_RULES_GATE_BLOCKED:{len(set(violations))}")
    return {"status": "PASS", "rules_service": False, "violations": 0, "immutable_r001_exception": immutable}


def _readme(source_head: str) -> bytes:
    text = (
        "OPIU R17 — переносимый пакет REPORT_ONLY\r\n"
        "\r\n"
        "Запуск: OPIU_R17.exe. Пакет работает локально и не загружает и не проводит данные в 1С.\r\n"
        "Внешний сервис правил отсутствует (rules_service=false). Финансовые строки требуют доказанной физической строки.\r\n"
        f"Источник сборки: Git commit {source_head}.\r\n"
        "Статус релиза: НЕ УТВЕРЖДЁН; выпуск и публикация запрещены.\r\n"
    )
    return text.encode("utf-8")


def _write_metadata(
    stage: Path, policy: dict[str, Any], source_head: str, policy_sha: str,
    go_build: dict[str, Any], node_record: dict[str, Any], source_binding: dict[str, Any],
    privacy: dict[str, Any], legacy: dict[str, Any], dependency_closure: dict[str, Any],
) -> None:
    safety = dict(policy["safety"])
    materialize_runtime_safety(stage, policy)
    runtime_manifest_path = stage / "runtime" / "MANIFEST.json"
    runtime_record = inventory_record(stage / "runtime", excluded=("MANIFEST.json",))
    runtime_manifest = {
        "schema_version": RUNTIME_SCHEMA, "source_head": source_head,
        "policy_sha256": policy_sha, "safety": safety, "rules_service": False,
        "legacy_rules_gate": legacy, "dependency_closure": dependency_closure,
        "runtime_exact_files": list(policy["runtime_exact_files"]), **runtime_record,
    }
    runtime_manifest_path.write_bytes(canonical_json(runtime_manifest))
    (stage / "CONTRACT_SHA256.txt").write_bytes(
        f"{policy['contract']['sha256']} *{policy['contract']['package_path']}\r\n".encode("ascii")
    )
    (stage / "README_RU.txt").write_bytes(_readme(source_head))
    provenance = {
        "schema_version": PROVENANCE_SCHEMA, "source_head": source_head,
        "baseline_source_commit": policy["baseline_source_commit"], "policy_sha256": policy_sha,
        "candidate_status": "REPORT_ONLY_ARCH_GATED", "release_approved": False,
        "production_runtime_modified": False, "independent_complete_build": True,
        "go_build": {
            "toolchain": go_build["toolchain"], "go_test_passed": go_build["go_test_passed"],
            "deterministic_double_build": go_build["deterministic_double_build"],
            "first_sha256": go_build["first_sha256"], "second_sha256": go_build["second_sha256"],
            "size": go_build["size"], "build_command": go_build["build_command"],
            "test_command": go_build["test_command"],
        },
        "node": node_record, "source_binding": source_binding,
        "contract": dict(policy["contract"]), "unicode_settings": list(policy["unicode_settings"]),
        "runtime_exact_files": list(policy["runtime_exact_files"]),
        "legacy_rules_gate": legacy, "privacy": privacy,
        "dependency_closure": dependency_closure, "safety": safety,
    }
    (stage / "R17_BUILD_PROVENANCE.json").write_bytes(canonical_json(provenance))
    package_record = inventory_record(stage, excluded=("R17_PACKAGE_MANIFEST.json",))
    package_manifest = {
        "schema_version": SCHEMA_VERSION, "archive_name": policy["archive_name"],
        "archive_root": policy["archive_root"], "executable_name": policy["executable_name"],
        "source_head": source_head, "policy_sha256": policy_sha,
        "candidate_status": "REPORT_ONLY_ARCH_GATED", "release_approved": False,
        "safety": safety, "legacy_rules_gate": legacy, "privacy": privacy,
        "dependency_closure": dependency_closure,
        "contract": dict(policy["contract"]), "unicode_settings": list(policy["unicode_settings"]),
        "runtime_exact_files": list(policy["runtime_exact_files"]),
        "toolchains": policy["toolchains"], "self_excluded_from_inventory": True,
        **package_record,
    }
    (stage / "R17_PACKAGE_MANIFEST.json").write_bytes(canonical_json(package_manifest))


def write_deterministic_zip(stage: Path, output: Path, policy: dict[str, Any]) -> None:
    if output.exists():
        raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output.name}")
    validate_tree_paths(stage, policy)
    files = safe_files(stage)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in files:
            relative = item.relative_to(stage).as_posix()
            name = f"{policy['archive_root']}/{relative}"
            info = zipfile.ZipInfo(name, tuple(policy["fixed_zip_time"]))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o100755 if relative in {policy["executable_name"], policy["toolchains"]["node"]["package_path"]} else 0o100644
            info.external_attr = mode << 16
            info.create_system = 3
            archive.writestr(info, item.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_with_independent_verifier(
    archive_path: Path, policy: dict[str, Any], policy_sha: str, source_head: str,
    source_inventory_sha256: str,
) -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location("opiu_r17_independent_verifier", _INDEPENDENT_VERIFIER_PATH)
    if spec is None or spec.loader is None:
        raise BuildError("INDEPENDENT_VERIFIER_IMPORT_FAILED")
    verifier = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(verifier)
        report = verifier.verify_archive(
            archive_path, policy, policy_sha256=policy_sha,
            expected_source_head=source_head,
            expected_source_inventory_sha256=source_inventory_sha256,
        )
    except Exception as error:
        raise BuildError(f"INDEPENDENT_ARCHIVE_VERIFICATION_FAILED:{type(error).__name__}") from error
    if report.get("status") != "PASS_REPORT_ONLY_CANDIDATE" or report.get("release_approved") is not False:
        raise BuildError("INDEPENDENT_ARCHIVE_VERIFICATION_RESULT_INVALID")
    return report


def promote_independent_pair(
    output_a: Path, output_b: Path, producer: Callable[[int, Path], None], archive_name: str,
    archive_verifier: Callable[[int, Path], dict[str, Any]],
) -> dict[str, Any]:
    first, second = output_a.resolve(), output_b.resolve()
    if first.name != archive_name or second.name != archive_name:
        raise BuildError("OUTPUT_NAME_MUST_BE_OPIU_R17_ZIP")
    if os.path.normcase(str(first)) == os.path.normcase(str(second)):
        raise BuildError("OUTPUT_PATHS_MUST_BE_DISTINCT")
    for output in (first, second):
        if output.exists():
            raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output.name}")
    temporaries: list[Path] = []
    temporary_directories: list[tempfile.TemporaryDirectory[str]] = []
    promoted: list[Path] = []
    try:
        for index, output in enumerate((first, second)):
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary_directory = tempfile.TemporaryDirectory(
                prefix=".opiu-r17-publish-", dir=output.parent,
            )
            temporary_directories.append(temporary_directory)
            temporary = Path(temporary_directory.name) / archive_name
            temporaries.append(temporary)
            producer(index, temporary)
        verification_reports: list[dict[str, Any]] = []
        verification_errors: list[tuple[int, Exception]] = []
        for index, temporary in enumerate(temporaries):
            try:
                verification_reports.append(archive_verifier(index, temporary))
            except Exception as error:
                verification_errors.append((index, error))
        if verification_errors:
            indexes = ",".join(str(index + 1) for index, _error in verification_errors)
            raise BuildError(f"INDEPENDENT_ARCHIVE_PAIR_VERIFICATION_FAILED:{indexes}") from verification_errors[0][1]
        hashes = [sha256_file(path) for path in temporaries]
        if hashes[0] != hashes[1] or temporaries[0].read_bytes() != temporaries[1].read_bytes():
            raise BuildError("INDEPENDENT_OUTPUTS_NONDETERMINISTIC")
        for temporary, output in zip(temporaries, (first, second), strict=True):
            os.link(temporary, output)
            promoted.append(output)
    except Exception:
        for output in promoted:
            output.unlink(missing_ok=True)
        raise
    finally:
        for temporary_directory in reversed(temporary_directories):
            temporary_directory.cleanup()
    return {
        "archive_name": archive_name, "first_sha256": hashes[0], "second_sha256": hashes[1],
        "size": first.stat().st_size, "byte_identical": True,
        "independent_complete_builds": 2, "atomic_no_overwrite": True,
        "independent_verification_before_promotion": True,
        "verified_archive_count": len(verification_reports),
    }


def assert_publish_paths_outside_repository(
    repository: Path, output_a: Path, output_b: Path, archive_name: str,
) -> None:
    repository = repository.resolve()
    outputs = [output_a.resolve(), output_b.resolve()]
    if os.path.normcase(str(outputs[0])) == os.path.normcase(str(outputs[1])):
        raise BuildError("OUTPUT_PATHS_MUST_BE_DISTINCT")
    for output in outputs:
        if output.name != archive_name:
            raise BuildError("OUTPUT_NAME_MUST_BE_OPIU_R17_ZIP")
        try:
            output.relative_to(repository)
        except ValueError:
            pass
        else:
            raise BuildError("OUTPUT_OR_PUBLISH_PATH_INSIDE_REPOSITORY")
    temporary_root = Path(tempfile.gettempdir()).resolve()
    try:
        temporary_root.relative_to(repository)
    except ValueError:
        pass
    else:
        raise BuildError("BUILD_TEMP_ROOT_INSIDE_REPOSITORY")


def _build_one(
    index: int, output: Path, repository: Path, source_head: str, go_exe: Path,
    node_exe: Path, node_modules: Path, policy: dict[str, Any], policy_sha: str,
    expected_source_record: dict[str, Any],
) -> None:
    with tempfile.TemporaryDirectory(prefix=f"opiu-r17-independent-{index + 1}-") as raw:
        work = Path(raw)
        before = exact_git_source_inventory(repository, source_head, policy)
        if before != expected_source_record:
            raise BuildError("SOURCE_CHANGED_BEFORE_INDEPENDENT_BUILD")
        service_source, service_source_record, _test_support_records = extract_service_test_tree(
            repository, expected_source_record, work / "source", policy,
        )
        go_build = BASE.test_and_build_service(
            go_exe, service_source, work / "go", test_node_exe=node_exe,
            test_node_modules=node_modules,
            expected_test_node_modules_inventory=policy["toolchains"]["node_modules"],
        )
        if exact_git_source_inventory(repository, source_head, policy) != expected_source_record:
            raise BuildError("SOURCE_CHANGED_AFTER_GO_BUILD")
        stage = work / policy["archive_root"]
        stage.mkdir()
        source_binding = copy_runtime_sources(repository, expected_source_record, stage, policy)
        verify_staged_runtime_exact_files(stage, policy)
        source_binding["service_source"] = service_source_record
        source_binding["complete_source_scope"] = expected_source_record
        shutil.copyfile(go_build["first_exe"], stage / policy["executable_name"])
        node_target = stage / Path(policy["toolchains"]["node"]["package_path"])
        node_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(node_exe, node_target)
        modules_target = stage / Path(policy["toolchains"]["node_modules"]["package_path"])
        _copy_verified_tree(node_modules, modules_target)
        contract_target = stage / Path(policy["contract"]["package_path"])
        contract_target.parent.mkdir(parents=True, exist_ok=True)
        extract_git_file(
            repository, expected_source_record, policy["contract"]["source"], contract_target,
        )
        for row in policy["unicode_settings"]:
            target = stage / Path(row["path"])
            extract_git_file(repository, expected_source_record, row["path"], target)
        node_record = verify_node(node_target, modules_target, policy)
        legacy = audit_legacy_rules_package(stage, policy)
        dependency_closure = verify_runtime_dependency_closure(stage / "runtime")
        privacy = audit_privacy(
            stage, policy, (repository, go_exe.parent.parent, node_exe.parent, node_modules, output.parent, work),
        )
        _write_metadata(
            stage, policy, source_head, policy_sha, go_build, node_record,
            source_binding, privacy, legacy, dependency_closure,
        )
        validate_tree_paths(stage, policy)
        if sha256_file(contract_target) != policy["contract"]["sha256"]:
            raise BuildError("STAGED_CONTRACT_SHA256_MISMATCH")
        audit_legacy_rules_package(stage, policy)
        final_privacy = audit_privacy(
            stage, policy, (repository, go_exe.parent.parent, node_exe.parent, node_modules, output.parent, work),
        )
        if final_privacy != privacy:
            raise BuildError("PRIVACY_EVIDENCE_CHANGED_AFTER_MANIFESTS")
        if exact_git_source_inventory(repository, source_head, policy) != expected_source_record:
            raise BuildError("SOURCE_CHANGED_BEFORE_ARCHIVE_WRITE")
        write_deterministic_zip(stage, output, policy)
        if exact_git_source_inventory(repository, source_head, policy) != expected_source_record:
            raise BuildError("SOURCE_CHANGED_AFTER_ARCHIVE_WRITE")


def build(
    repository: Path, source_head: str, go_exe: Path, node_exe: Path, node_modules: Path,
    output_a: Path, output_b: Path, policy_path: Path = POLICY_PATH,
) -> dict[str, Any]:
    repository = repository.resolve()
    policy_path = policy_path.resolve()
    policy = load_policy(policy_path)
    assert_publish_paths_outside_repository(
        repository, output_a, output_b, policy["archive_name"],
    )
    policy_sha = sha256_file(policy_path)
    verified_head = BASE.verify_repository(repository, source_head)
    source_record = exact_git_source_inventory(repository, verified_head, policy)
    legacy = audit_legacy_rules_repository(repository, policy)
    verify_contract_and_settings(source_record, policy)
    verify_node(node_exe.resolve(), node_modules.resolve(), policy)
    if BASE.verify_toolchain(go_exe.resolve())["go_exe_sha256"] != policy["toolchains"]["go"]["go_exe_sha256"]:
        raise BuildError("GO_POLICY_BINDING_MISMATCH")

    def producer(index: int, temporary_output: Path) -> None:
        _build_one(
            index, temporary_output, repository, verified_head, go_exe.resolve(),
            node_exe.resolve(), node_modules.resolve(), policy, policy_sha, source_record,
        )

    def archive_verifier(index: int, temporary_output: Path) -> dict[str, Any]:
        report = verify_with_independent_verifier(
            temporary_output, policy, policy_sha, verified_head,
            source_record["inventory_sha256"],
        )
        if report.get("archive") != policy["archive_name"]:
            raise BuildError(f"INDEPENDENT_ARCHIVE_{index + 1}_IDENTITY_INVALID")
        return report

    outputs = promote_independent_pair(
        output_a, output_b, producer, policy["archive_name"], archive_verifier,
    )
    return {
        "status": "BUILT_REPORT_ONLY_ARCH_GATED_CANDIDATE", "source_head": verified_head,
        "policy_sha256": policy_sha, "legacy_rules_gate": legacy,
        "source_inventory_sha256": source_record["inventory_sha256"],
        "source_file_count": source_record["file_count"],
        "release_approved": False, "safety": policy["safety"], **outputs,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--source-head", required=True)
    parser.add_argument("--go-exe", type=Path, required=True)
    parser.add_argument("--node-exe", type=Path, required=True)
    parser.add_argument("--node-modules", type=Path, required=True)
    parser.add_argument("--output-a", type=Path, required=True)
    parser.add_argument("--output-b", type=Path, required=True)
    parser.add_argument("--policy", type=Path, default=POLICY_PATH)
    arguments = parser.parse_args()
    try:
        result = build(
            arguments.repository, arguments.source_head, arguments.go_exe, arguments.node_exe,
            arguments.node_modules, arguments.output_a, arguments.output_b, arguments.policy,
        )
    except BuildError as error:
        code = str(error).split(":", 1)[0] or "BUILD_BLOCKED"
        parser.exit(2, json.dumps({"status": "BUILD_BLOCKED", "error": code}) + "\n")
    except Exception:
        parser.exit(2, json.dumps({"status": "BUILD_BLOCKED", "error": "UNEXPECTED_BUILD_FAILURE"}) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
