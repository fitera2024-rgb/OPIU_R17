#!/usr/bin/env python3
"""Independent, read-only verification of one or two OPIU R17 portable ZIPs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


POLICY_PATH = Path(__file__).with_name("r17_portable_policy.json")
POLICY_SCHEMA = "opiu-r17-portable-policy.v1"
PACKAGE_SCHEMA = "opiu-r17-package-manifest.v1"
PROVENANCE_SCHEMA = "opiu-r17-build-provenance.v1"
RUNTIME_SCHEMA = "opiu-r17-runtime-manifest.v1"
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
RUNTIME_LOGICAL_ROOT = "runtime"
RUNTIME_EDGE_PATH_FORMAT = "POSIX_RELATIVE_TO_LOGICAL_ROOT"
EXPECTED_POLICY_VALUE_SHA256 = "26A3B809C1B1D77E56C293BEB5287A4771590D96BC690636DAC678FEA3685576"
RELATIVE_IMPORT_PATTERNS = (
    re.compile(r'''(?:from\s+|import\s*\(\s*|require\s*\(\s*|new\s+URL\s*\(\s*)["'](\.[^"']+)["']'''),
    re.compile(r'''\bimport\s*["'](\.[^"']+)["']'''),
)
GENERIC_PROFILE_PATTERNS = (
    re.compile(rb"(?i)(?:[A-Z]:[\\/]Users[\\/]|/Users/|/home/)"),
    re.compile(rb"(?i)(?:[A-Z]\x00:\x00[\\/]\x00U\x00s\x00e\x00r\x00s\x00[\\/]\x00|/\x00U\x00s\x00e\x00r\x00s\x00/\x00|/\x00h\x00o\x00m\x00e\x00/\x00)"),
    re.compile(rb"(?i)(?:\x00[A-Z]\x00:\x00[\\/]\x00U\x00s\x00e\x00r\x00s\x00[\\/]|\x00/\x00U\x00s\x00e\x00r\x00s\x00/|\x00/\x00h\x00o\x00m\x00e\x00/)"),
)


class VerificationError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def policy_value_sha256(value: dict[str, Any]) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(payload)


def _json_object(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"JSON_INVALID:{label}") from error
    if not isinstance(value, dict):
        raise VerificationError(f"JSON_OBJECT_REQUIRED:{label}")
    return value


def load_policy(path: Path = POLICY_PATH, *, enforce_canonical: bool = True) -> dict[str, Any]:
    try:
        policy = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError("POLICY_READ_FAILED") from error
    if not isinstance(policy, dict):
        raise VerificationError("POLICY_OBJECT_REQUIRED")
    validate_policy(policy, enforce_canonical=enforce_canonical)
    return policy


def validate_policy(policy: dict[str, Any], *, enforce_canonical: bool = True) -> None:
    required = {
        "schema_version", "archive_name", "archive_root", "executable_name",
        "fixed_zip_time", "contract", "required_metadata", "safety", "toolchains",
        "unicode_settings", "legacy_rules_gate", "privacy", "path_limits",
        "source_integrity", "runtime_dependency_closure", "relocation_smoke",
        "build_verification",
    }
    if not required.issubset(policy):
        raise VerificationError("POLICY_FIELDS_MISSING")
    if not enforce_canonical:
        return
    if policy_value_sha256(policy) != EXPECTED_POLICY_VALUE_SHA256:
        raise VerificationError("POLICY_VALUE_SET_NOT_EXACT")
    expected = {
        "schema_version": POLICY_SCHEMA, "archive_name": "OPIU_R17.zip",
        "archive_root": "OPIU_R17", "executable_name": "OPIU_R17.exe",
        "fixed_zip_time": [2026, 8, 27, 0, 0, 0], "compression": "DEFLATE9",
    }
    for field, value in expected.items():
        if policy.get(field) != value:
            raise VerificationError(f"POLICY_CANONICAL_VALUE_INVALID:{field}")
    if policy["contract"] != {
        "source": "contracts/Контракт_ОПИУ_v0.4_зафиксированный.docx",
        "package_path": "contract/OPIU_v0.4.docx",
        "sha256": "09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD",
    }:
        raise VerificationError("POLICY_CONTRACT_BINDING_INVALID")
    go = policy["toolchains"]["go"]
    node = policy["toolchains"]["node"]
    modules = policy["toolchains"]["node_modules"]
    if (
        go.get("go_exe_sha256") != "08CFBE81F1BF519874CE8E6670EA98768D18CC0D16B9FF9D67EB785EC9A15CF9"
        or go.get("file_count") != 12900
        or go.get("inventory_sha256") != "FC5948968417E9FAF0FE7172F70CAC33E131056D7225EB00F4B4EA9A3B69268E"
        or node.get("version_line") != "v24.14.0"
        or node.get("node_exe_sha256") != "63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088"
        or node.get("node_exe_size") != 91380224
        or node.get("inventory_sha256") != "EA2AF5CAFD6DACC3C9EFAC1FA03627053ECC8B54040202FCC7EA04ADCE261837"
        or modules.get("file_count") != 294 or modules.get("total_size") != 50570254
        or modules.get("inventory_sha256") != "9A31C6F4FCCA4DDDB93DFC1E50DC06B03F2EBAB5B7575DDF7EF6CCE5502F1059"
        or modules.get("packages") != {
            "jszip": "3.10.1", "@oai/artifact-tool": "2.8.31", "skia-canvas": "3.0.8",
        }
    ):
        raise VerificationError("POLICY_TOOLCHAIN_BINDING_INVALID")
    exception = policy["privacy"]["allowed_upstream_debug_exception"]
    if (
        policy["privacy"].get("whole_zip_user_profile_path_free") is not False
        or exception != {
            "path": "runtime/node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node",
            "size": 24231424,
            "sha256": "4E5B185CCDFFCEEDE5468B47C4646E2CE66F4E85EC35A753007EC32CB8720498",
            "runneradmin_hits": 160,
            "d_drive_a_hits": 3,
        }
    ):
        raise VerificationError("POLICY_PRIVACY_BINDING_INVALID")


def assert_safety(value: Any, expected: dict[str, Any]) -> None:
    if not isinstance(value, dict) or value != expected:
        raise VerificationError("REPORT_ONLY_SAFETY_GATES_NOT_EXACT")


def validate_relative_path(relative: str, policy: dict[str, Any]) -> None:
    if not relative or "\\" in relative or relative.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", relative):
        raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{relative}")
    if any(part in {"", ".", ".."} for part in relative.split("/")):
        raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{relative}")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{relative}")
    limits = policy["path_limits"]
    if any(len(part) > limits["component_max"] for part in pure.parts):
        raise VerificationError(f"ARCHIVE_COMPONENT_TOO_LONG:{relative}")
    if len(relative) > limits["relative_max"]:
        raise VerificationError(f"ARCHIVE_RELATIVE_PATH_TOO_LONG:{relative}")
    full = limits["full_path_prefix"].rstrip("\\/") + "\\" + (
        policy["archive_root"] + "/" + relative
    ).replace("/", "\\")
    if len(full) > limits["full_path_max"]:
        raise VerificationError(f"ARCHIVE_FULL_PATH_TOO_LONG:{relative}")


def inventory_record(payloads: dict[str, bytes], *, prefix: str = "", excluded: Iterable[str] = ()) -> dict[str, Any]:
    excluded_set = set(excluded)
    rows = []
    for path in sorted(payloads):
        if path in excluded_set or (prefix and not path.startswith(prefix)):
            continue
        logical = path[len(prefix):] if prefix else path
        if not logical:
            continue
        data = payloads[path]
        rows.append({"path": logical, "size": len(data), "sha256": sha256_bytes(data)})
    encoded = (json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    return {
        "file_count": len(rows), "total_size": sum(row["size"] for row in rows),
        "inventory_sha256": sha256_bytes(encoded), "files": rows,
    }


def _git_inventory_record_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    normalized = sorted((dict(row) for row in rows), key=lambda row: row["path"])
    encoded = (
        json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    return {
        "file_count": len(normalized),
        "total_size": sum(row["size"] for row in normalized),
        "inventory_sha256": sha256_bytes(encoded), "files": normalized,
    }


def _git_blob_id(data: bytes, object_format: str) -> str:
    digest = hashlib.new(object_format)
    digest.update(f"blob {len(data)}\0".encode("ascii"))
    digest.update(data)
    return digest.hexdigest()


def _validate_git_inventory(value: Any, label: str, object_format: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("files"), list):
        raise VerificationError(f"SOURCE_BINDING_INVENTORY_INVALID:{label}")
    rows = value["files"]
    if not rows:
        raise VerificationError(f"SOURCE_BINDING_INVENTORY_EMPTY:{label}")
    expected_blob_length = 40 if object_format == "sha1" else 64
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"path", "size", "sha256", "git_blob", "git_mode"}:
            raise VerificationError(f"SOURCE_BINDING_ROW_INVALID:{label}")
        path = row.get("path")
        if not isinstance(path, str):
            raise VerificationError(f"SOURCE_BINDING_PATH_INVALID:{label}")
        try:
            validate_relative_path(path, {
                "path_limits": {"component_max": 255, "relative_max": 4096,
                                "full_path_prefix": "C:\\S", "full_path_max": 8192},
                "archive_root": "source",
            })
        except VerificationError as error:
            raise VerificationError(f"SOURCE_BINDING_PATH_INVALID:{label}") from error
        if path in seen:
            raise VerificationError(f"SOURCE_BINDING_PATH_DUPLICATE:{label}")
        seen.add(path)
        if (
            not isinstance(row.get("size"), int) or isinstance(row.get("size"), bool)
            or row["size"] < 0
            or not isinstance(row.get("sha256"), str)
            or not re.fullmatch(r"[0-9A-F]{64}", row["sha256"])
            or not isinstance(row.get("git_blob"), str)
            or not re.fullmatch(rf"[0-9a-f]{{{expected_blob_length}}}", row["git_blob"])
            or row.get("git_mode") not in {"100644", "100755"}
        ):
            raise VerificationError(f"SOURCE_BINDING_ROW_INVALID:{label}")
    calculated = _git_inventory_record_from_rows(rows)
    for field in ("file_count", "total_size", "inventory_sha256", "files"):
        if value.get(field) != calculated[field]:
            raise VerificationError(f"SOURCE_BINDING_INVENTORY_MISMATCH:{label}:{field}")
    return calculated


def _source_scope_paths(policy: dict[str, Any]) -> list[str]:
    return sorted(set([
        "service/source", *policy["runtime_source_roots"], policy["contract"]["source"],
        *(row["path"] for row in policy["unicode_settings"]),
    ]))


def _source_excluded(relative: str, policy: dict[str, Any]) -> bool:
    pure = PurePosixPath(relative)
    if any(part in set(policy["runtime_excluded_names"]) for part in pure.parts):
        return True
    return any(relative.endswith(suffix) for suffix in policy["runtime_excluded_suffixes"])


def _verify_source_binding(
    value: Any, payloads: dict[str, bytes], policy: dict[str, Any], source_head: str,
    expected_inventory_sha256: str | None,
) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("status") != "EXACT_GIT_BLOB_EXTRACTION":
        raise VerificationError("SOURCE_BINDING_MISSING_OR_STATUS_INVALID")
    complete = value.get("complete_source_scope")
    if not isinstance(complete, dict):
        raise VerificationError("SOURCE_BINDING_COMPLETE_INVENTORY_MISSING")
    object_format = complete.get("git_object_format")
    if object_format not in {"sha1", "sha256"}:
        raise VerificationError("SOURCE_BINDING_OBJECT_FORMAT_INVALID")
    if (
        complete.get("source_head") != source_head
        or complete.get("scopes") != _source_scope_paths(policy)
        or complete.get("exact_git_blobs") is not True
        or complete.get("ignored_injection_checked") is not True
    ):
        raise VerificationError("SOURCE_BINDING_COMPLETE_CLAIMS_INVALID")
    complete_record = _validate_git_inventory(complete, "complete_source_scope", object_format)
    if (
        expected_inventory_sha256 is not None
        and complete_record["inventory_sha256"] != expected_inventory_sha256
    ):
        raise VerificationError("SOURCE_BINDING_EXPECTED_INVENTORY_MISMATCH")
    runtime_record = _validate_git_inventory(value, "runtime_sources", object_format)
    service_record = _validate_git_inventory(value.get("service_source"), "service_source", object_format)
    complete_by_path = {row["path"]: row for row in complete_record["files"]}
    expected_runtime_rows = sorted([
        row for row in complete_record["files"]
        if any(
            row["path"].startswith(prefix.rstrip("/") + "/")
            for prefix in policy["runtime_source_roots"]
        ) and not _source_excluded(row["path"], policy)
    ], key=lambda row: row["path"])
    expected_service_rows = sorted([
        row for row in complete_record["files"]
        if row["path"].startswith("service/source/")
    ], key=lambda row: row["path"])
    if runtime_record["files"] != expected_runtime_rows:
        raise VerificationError("SOURCE_BINDING_RUNTIME_SET_NOT_EXACT")
    if service_record["files"] != expected_service_rows:
        raise VerificationError("SOURCE_BINDING_SERVICE_SET_NOT_EXACT")
    for label, record, prefixes in (
        ("runtime_sources", runtime_record, policy["runtime_source_roots"]),
        ("service_source", service_record, ["service/source"]),
    ):
        for row in record["files"]:
            if not any(row["path"].startswith(prefix.rstrip("/") + "/") for prefix in prefixes):
                raise VerificationError(f"SOURCE_BINDING_SCOPE_INVALID:{label}")
            if complete_by_path.get(row["path"]) != row:
                raise VerificationError(f"SOURCE_BINDING_SUBSET_MISMATCH:{label}")
    for row in runtime_record["files"]:
        packaged = RUNTIME_LOGICAL_ROOT + "/" + row["path"]
        if (
            packaged not in payloads or len(payloads[packaged]) != row["size"]
            or sha256_bytes(payloads[packaged]) != row["sha256"]
            or _git_blob_id(payloads[packaged], object_format) != row["git_blob"]
        ):
            raise VerificationError(f"SOURCE_BINDING_PACKAGED_RUNTIME_MISMATCH:{row['path']}")
    bound_files = [
        (policy["contract"]["source"], policy["contract"]["package_path"]),
        *((row["path"], row["path"]) for row in policy["unicode_settings"]),
    ]
    for source_path, package_path in bound_files:
        row = complete_by_path.get(source_path)
        if row is None or package_path not in payloads:
            raise VerificationError(f"SOURCE_BINDING_PACKAGED_FILE_MISSING:{source_path}")
        if (
            len(payloads[package_path]) != row["size"]
            or sha256_bytes(payloads[package_path]) != row["sha256"]
            or _git_blob_id(payloads[package_path], object_format) != row["git_blob"]
        ):
            raise VerificationError(f"SOURCE_BINDING_PACKAGED_FILE_MISMATCH:{source_path}")
    return {
        "status": "PASS", "source_head": source_head,
        "file_count": complete_record["file_count"],
        "inventory_sha256": complete_record["inventory_sha256"],
        "exact_git_blobs": True,
    }


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


def verify_runtime_dependency_closure(payloads: dict[str, bytes]) -> dict[str, Any]:
    prefix = RUNTIME_LOGICAL_ROOT + "/"
    runtime_payloads = {
        relative[len(prefix):]: data
        for relative, data in payloads.items()
        if relative.startswith(prefix)
    }
    paths = set(runtime_payloads)
    scan_paths = {relative for relative in paths if not relative.startswith("node_modules/")}
    directories = {
        parent.as_posix()
        for relative in paths
        for parent in PurePosixPath(relative).parents
        if parent.as_posix() not in {"", "."}
    }
    checked = 0
    edges: list[dict[str, str]] = []
    for relative in sorted(scan_paths):
        if PurePosixPath(relative).suffix.lower() not in {".mjs", ".js", ".cjs"}:
            continue
        try:
            text = runtime_payloads[relative].decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise VerificationError(f"RUNTIME_SOURCE_ENCODING_INVALID:{relative}") from error
        specifiers = []
        for pattern in RELATIVE_IMPORT_PATTERNS:
            specifiers.extend(pattern.findall(text))
        for specifier in sorted(set(specifiers)):
            checked += 1
            candidates = _resolve_relative_dependency(relative, specifier)
            matched = next((candidate for candidate in candidates if candidate in paths), None)
            if matched is None and specifier.split("?", 1)[0].split("#", 1)[0].endswith("/"):
                directory = next((candidate for candidate in candidates[:1] if candidate in directories), None)
                if directory is not None:
                    matched = directory + "/"
            if matched is None:
                raise VerificationError(f"RUNTIME_RELATIVE_IMPORT_MISSING:{relative}:{specifier}")
            edges.append({"source": relative, "specifier": specifier, "target": matched})
    return {
        "status": "PASS", "logical_root": RUNTIME_LOGICAL_ROOT,
        "edge_paths": RUNTIME_EDGE_PATH_FORMAT,
        "excluded_exact_inventory_roots": ["node_modules"],
        "relative_dependency_count": checked, "edges": edges,
    }


def _read_archive(archive_path: Path, policy: dict[str, Any]) -> tuple[dict[str, bytes], dict[str, zipfile.ZipInfo]]:
    if not archive_path.is_file() or archive_path.name != policy["archive_name"]:
        raise VerificationError("ARCHIVE_NAME_OR_FILE_INVALID")
    payloads: dict[str, bytes] = {}
    infos_by_relative: dict[str, zipfile.ZipInfo] = {}
    seen: set[str] = set()
    seen_folded: set[str] = set()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if names != sorted(names):
                raise VerificationError("ARCHIVE_ORDER_NOT_SORTED")
            for info in infos:
                if info.is_dir():
                    raise VerificationError("ARCHIVE_DIRECTORY_ENTRY_FORBIDDEN")
                name = info.filename
                if "\\" in name or name.startswith(("/", "//")) or re.match(r"^[A-Za-z]:", name):
                    raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{name}")
                if any(part in {"", ".", ".."} for part in name.split("/")):
                    raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{name}")
                pure = PurePosixPath(name)
                if pure.is_absolute() or ".." in pure.parts or len(pure.parts) < 2:
                    raise VerificationError(f"ARCHIVE_PATH_UNSAFE:{name}")
                if pure.parts[0] != policy["archive_root"]:
                    raise VerificationError("ARCHIVE_ROOT_INVALID")
                relative = PurePosixPath(*pure.parts[1:]).as_posix()
                validate_relative_path(relative, policy)
                folded = name.casefold()
                if name in seen or folded in seen_folded:
                    raise VerificationError(f"ARCHIVE_DUPLICATE_PATH:{name}")
                seen.add(name)
                seen_folded.add(folded)
                if info.flag_bits & 0x1:
                    raise VerificationError("ARCHIVE_ENCRYPTED_ENTRY_FORBIDDEN")
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise VerificationError("ARCHIVE_SYMLINK_ENTRY_FORBIDDEN")
                expected_mode = 0o100755 if relative in {
                    policy["executable_name"], policy["toolchains"]["node"]["package_path"],
                } else 0o100644
                if mode != expected_mode:
                    raise VerificationError(f"ARCHIVE_MODE_INVALID:{relative}")
                if tuple(info.date_time) != tuple(policy["fixed_zip_time"]):
                    raise VerificationError(f"ARCHIVE_TIMESTAMP_INVALID:{relative}")
                if info.compress_type != zipfile.ZIP_DEFLATED:
                    raise VerificationError(f"ARCHIVE_COMPRESSION_INVALID:{relative}")
                payloads[relative] = archive.read(info)
                infos_by_relative[relative] = info
            relative_names = set(payloads)
            for relative in relative_names:
                parts = relative.split("/")
                if any("/".join(parts[:index]) in relative_names for index in range(1, len(parts))):
                    raise VerificationError("ARCHIVE_FILE_DIRECTORY_COLLISION")
    except zipfile.BadZipFile as error:
        raise VerificationError("ARCHIVE_INVALID") from error
    return payloads, infos_by_relative


def _verify_privacy(payloads: dict[str, bytes], policy: dict[str, Any]) -> dict[str, Any]:
    exception = policy["privacy"]["allowed_upstream_debug_exception"]
    exception_path = exception["path"]
    runneradmin = re.compile(rb"(?i)runneradmin")
    drive_a = re.compile(rb"(?i)D:\\a\\")
    unauthorized: list[str] = []
    for relative, data in payloads.items():
        profile_hits = sum(len(pattern.findall(data)) for pattern in GENERIC_PROFILE_PATTERNS)
        runner_hits = len(runneradmin.findall(data))
        drive_hits = len(drive_a.findall(data))
        if relative == exception_path:
            if (
                len(data) != exception["size"] or sha256_bytes(data) != exception["sha256"]
                or runner_hits != exception["runneradmin_hits"] or drive_hits != exception["d_drive_a_hits"]
            ):
                raise VerificationError("UPSTREAM_DEBUG_EXCEPTION_BINDING_MISMATCH")
        elif profile_hits or runner_hits or drive_hits:
            unauthorized.append(relative)
    if exception_path not in payloads:
        raise VerificationError("UPSTREAM_DEBUG_EXCEPTION_MISSING")
    if unauthorized:
        raise VerificationError(f"LOCAL_CUSTOMER_BUILD_PATH_LEAK:{len(unauthorized)}")
    return {
        "local_customer_build_paths_absent": True, "local_customer_build_path_hits": 0,
        "only_allowed_upstream_debug_exception_present": True,
        "allowed_upstream_debug_exception": {
            "path": exception["path"], "size": exception["size"], "sha256": exception["sha256"],
            "username_occurrences": exception["runneradmin_hits"],
            "debug_root_occurrences": exception["d_drive_a_hits"],
        },
        "whole_zip_user_profile_path_free": False,
    }


def _verify_legacy(payloads: dict[str, bytes], policy: dict[str, Any]) -> dict[str, Any]:
    gate = policy["legacy_rules_gate"]
    immutable = f"runtime/{gate['immutable_r001_exception']}"
    tokens = [(category, token) for category, values in gate["forbidden_tokens"].items() for token in values]
    violations: list[str] = []
    metadata = set(policy["required_metadata"])
    for relative, data in payloads.items():
        wrapped = f"/{relative}/"
        if any(fragment.casefold() in wrapped.casefold() for fragment in gate["forbidden_package_path_fragments"]):
            violations.append(f"path:{relative}")
        if relative == immutable or relative in metadata:
            continue
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            continue
        for category, token in tokens:
            if token.casefold() in text.casefold():
                violations.append(f"{category}:{relative}:{token}")
    if violations:
        raise VerificationError(f"LEGACY_RULES_GATE_BLOCKED:{len(set(violations))}")
    return {"status": "PASS", "rules_service": False, "violations": 0, "immutable_r001_exception": gate["immutable_r001_exception"]}


def verify_archive(
    archive_path: Path, policy: dict[str, Any], *, policy_sha256: str | None = None,
    expected_source_head: str | None = None,
    expected_source_inventory_sha256: str | None = None,
    run_smoke: bool = False, smoke_parent: Path | None = None, smoke_timeout: float = 20.0,
) -> dict[str, Any]:
    payloads, _ = _read_archive(archive_path, policy)
    required = set(policy["required_metadata"])
    missing = sorted(required - set(payloads))
    if missing:
        raise VerificationError(f"REQUIRED_METADATA_MISSING:{','.join(missing)}")
    if policy["executable_name"] not in payloads:
        raise VerificationError("EXECUTABLE_MISSING")
    exe_paths = [path for path in payloads if path.casefold().endswith(".exe")]
    expected_exes = {policy["executable_name"], policy["toolchains"]["node"]["package_path"]}
    if set(exe_paths) != expected_exes:
        raise VerificationError("EXECUTABLE_SET_INVALID")
    expected_node_files = {policy["toolchains"]["node"]["package_path"]}
    actual_node_files = {path for path in payloads if path.startswith("runtime/node/")}
    if actual_node_files != expected_node_files:
        raise VerificationError("RUNTIME_NODE_FILE_SET_INVALID")
    expected_settings = {row["path"] for row in policy["unicode_settings"]}
    actual_settings = {path for path in payloads if path.startswith("user-settings/")}
    if actual_settings != expected_settings:
        raise VerificationError("UNICODE_SETTINGS_FILE_SET_INVALID")
    manifest = _json_object(payloads["R17_PACKAGE_MANIFEST.json"], "R17_PACKAGE_MANIFEST.json")
    provenance = _json_object(payloads["R17_BUILD_PROVENANCE.json"], "R17_BUILD_PROVENANCE.json")
    runtime_manifest = _json_object(payloads["runtime/MANIFEST.json"], "runtime/MANIFEST.json")
    runtime_safety = _json_object(payloads["runtime/SAFETY.json"], "runtime/SAFETY.json")
    if manifest.get("schema_version") != PACKAGE_SCHEMA or provenance.get("schema_version") != PROVENANCE_SCHEMA:
        raise VerificationError("TOP_LEVEL_SCHEMA_INVALID")
    if runtime_manifest.get("schema_version") != RUNTIME_SCHEMA:
        raise VerificationError("RUNTIME_SCHEMA_INVALID")
    source_head = manifest.get("source_head")
    if not isinstance(source_head, str) or not re.fullmatch(r"[0-9a-f]{40}", source_head):
        raise VerificationError("SOURCE_HEAD_INVALID")
    if expected_source_head is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", expected_source_head):
        raise VerificationError("EXPECTED_SOURCE_HEAD_INVALID")
    if expected_source_head is not None and source_head != expected_source_head.lower():
        raise VerificationError("EXPECTED_SOURCE_HEAD_MISMATCH")
    if (
        expected_source_inventory_sha256 is not None
        and not re.fullmatch(r"[0-9A-F]{64}", expected_source_inventory_sha256)
    ):
        raise VerificationError("EXPECTED_SOURCE_INVENTORY_SHA256_INVALID")
    if provenance.get("source_head") != source_head or runtime_manifest.get("source_head") != source_head:
        raise VerificationError("SOURCE_HEAD_BINDING_MISMATCH")
    source_binding = _verify_source_binding(
        provenance.get("source_binding"), payloads, policy, source_head,
        expected_source_inventory_sha256,
    )
    for document in (manifest, provenance, runtime_manifest):
        assert_safety(document.get("safety"), policy["safety"])
        if document.get("release_approved") not in {None, False}:
            raise VerificationError("RELEASE_APPROVAL_CLAIM_FORBIDDEN")
    assert_safety(runtime_safety, policy["safety"])
    expected_policy_sha = policy_sha256 or manifest.get("policy_sha256")
    if not isinstance(expected_policy_sha, str) or not re.fullmatch(r"[0-9A-F]{64}", expected_policy_sha):
        raise VerificationError("POLICY_SHA256_INVALID")
    if any(document.get("policy_sha256") != expected_policy_sha for document in (manifest, provenance, runtime_manifest)):
        raise VerificationError("POLICY_SHA256_MISMATCH")
    if manifest.get("archive_name") != policy["archive_name"] or manifest.get("archive_root") != policy["archive_root"]:
        raise VerificationError("PACKAGE_IDENTITY_MISMATCH")
    if (
        manifest.get("candidate_status") != "REPORT_ONLY_ARCH_GATED"
        or provenance.get("candidate_status") != "REPORT_ONLY_ARCH_GATED"
        or manifest.get("release_approved") is not False
        or provenance.get("release_approved") is not False
        or manifest.get("self_excluded_from_inventory") is not True
        or provenance.get("production_runtime_modified") is not False
        or provenance.get("independent_complete_build") is not True
    ):
        raise VerificationError("REPORT_ONLY_PROVENANCE_CLAIM_INVALID")
    assert_safety(manifest.get("safety"), policy["safety"])
    if manifest.get("toolchains") != policy["toolchains"]:
        raise VerificationError("TOOLCHAIN_POLICY_MISMATCH")
    go_policy = policy["toolchains"]["go"]
    go_build = provenance.get("go_build", {})
    go_toolchain = go_build.get("toolchain", {}) if isinstance(go_build, dict) else {}
    if (
        go_toolchain.get("version") != go_policy["version"]
        or go_toolchain.get("platform") != go_policy["platform"]
        or go_toolchain.get("go_exe_sha256") != go_policy["go_exe_sha256"]
        or go_toolchain.get("toolchain_file_count") != go_policy["file_count"]
        or go_toolchain.get("toolchain_inventory_sha256") != go_policy["inventory_sha256"]
        or go_build.get("go_test_passed") is not True
        or go_build.get("deterministic_double_build") is not True
        or go_build.get("first_sha256") != sha256_bytes(payloads[policy["executable_name"]])
        or go_build.get("second_sha256") != go_build.get("first_sha256")
        or go_build.get("size") != len(payloads[policy["executable_name"]])
    ):
        raise VerificationError("GO_BUILD_PROVENANCE_INVALID")
    node_policy = policy["toolchains"]["node"]
    node_path = node_policy["package_path"]
    if (
        node_path not in payloads or len(payloads[node_path]) != node_policy["node_exe_size"]
        or sha256_bytes(payloads[node_path]) != node_policy["node_exe_sha256"]
    ):
        raise VerificationError("NODE_EXECUTABLE_BINDING_MISMATCH")
    node_inventory = inventory_record({"node.exe": payloads[node_path]})
    if (
        node_inventory["file_count"] != node_policy["file_count"]
        or node_inventory["inventory_sha256"] != node_policy["inventory_sha256"]
    ):
        raise VerificationError("NODE_INVENTORY_MISMATCH")
    modules_policy = policy["toolchains"]["node_modules"]
    modules_record = inventory_record(payloads, prefix=modules_policy["package_path"].rstrip("/") + "/")
    if (
        modules_record["file_count"] != modules_policy["file_count"]
        or modules_record["total_size"] != modules_policy["total_size"]
        or modules_record["inventory_sha256"] != modules_policy["inventory_sha256"]
    ):
        raise VerificationError("NODE_MODULES_INVENTORY_MISMATCH")
    for package, version in modules_policy["packages"].items():
        package_path = f"{modules_policy['package_path']}/{package}/package.json"
        if package == "skia-canvas" and package_path not in payloads:
            package_path = (
                f"{modules_policy['package_path']}/@oai/artifact-tool/"
                "node_modules/skia-canvas/package.json"
            )
        if package_path not in payloads:
            raise VerificationError(f"NODE_PACKAGE_MANIFEST_MISSING:{package}")
        package_manifest = _json_object(payloads[package_path], package_path)
        if package_manifest.get("version") != version:
            raise VerificationError(f"NODE_PACKAGE_VERSION_MISMATCH:{package}")
    contract = policy["contract"]
    if contract["package_path"] not in payloads or sha256_bytes(payloads[contract["package_path"]]) != contract["sha256"]:
        raise VerificationError("CONTRACT_SHA256_MISMATCH")
    expected_contract_line = f"{contract['sha256']} *{contract['package_path']}\r\n".encode("ascii")
    if payloads["CONTRACT_SHA256.txt"] != expected_contract_line:
        raise VerificationError("CONTRACT_SHA256_SIDECAR_INVALID")
    for row in policy["unicode_settings"]:
        if row["path"] not in payloads or sha256_bytes(payloads[row["path"]]) != row["sha256"]:
            raise VerificationError(f"UNICODE_SETTING_MISMATCH:{row['path']}")
    if manifest.get("contract") != contract or manifest.get("unicode_settings") != policy["unicode_settings"]:
        raise VerificationError("PACKAGE_BINDINGS_MISMATCH")
    package_record = inventory_record(payloads, excluded=("R17_PACKAGE_MANIFEST.json",))
    for field in ("file_count", "total_size", "inventory_sha256", "files"):
        if manifest.get(field) != package_record[field]:
            raise VerificationError(f"PACKAGE_INVENTORY_MISMATCH:{field}")
    runtime_record = inventory_record(payloads, prefix="runtime/", excluded=("runtime/MANIFEST.json",))
    for field in ("file_count", "total_size", "inventory_sha256", "files"):
        if runtime_manifest.get(field) != runtime_record[field]:
            raise VerificationError(f"RUNTIME_INVENTORY_MISMATCH:{field}")
    privacy = _verify_privacy(payloads, policy)
    legacy = _verify_legacy(payloads, policy)
    dependency_closure = verify_runtime_dependency_closure(payloads)
    for document in (manifest, provenance):
        if document.get("privacy") != privacy or document.get("legacy_rules_gate") != legacy:
            raise VerificationError("AUDIT_EVIDENCE_MISMATCH")
    if runtime_manifest.get("legacy_rules_gate") != legacy or runtime_manifest.get("rules_service") is not False:
        raise VerificationError("RUNTIME_LEGACY_GATE_MISMATCH")
    for document in (manifest, provenance, runtime_manifest):
        if document.get("dependency_closure") != dependency_closure:
            raise VerificationError("RUNTIME_DEPENDENCY_CLOSURE_EVIDENCE_MISMATCH")
    report = {
        "status": "PASS_REPORT_ONLY_CANDIDATE", "archive": archive_path.name,
        "sha256": sha256_file(archive_path), "size": archive_path.stat().st_size,
        "entry_count": len(payloads), "source_head": manifest.get("source_head"),
        "release_approved": False, "safety": policy["safety"],
        "legacy_rules_gate": legacy, "privacy": privacy,
        "dependency_closure": dependency_closure,
        "source_binding": source_binding,
    }
    if run_smoke:
        report["relocation_smoke"] = _run_two_relocation_smokes_after_static(
            archive_path, policy, smoke_parent=smoke_parent, timeout=smoke_timeout,
        )
    return report


def _http_json(url: str, timeout: float) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                raise VerificationError(f"SMOKE_HTTP_STATUS_INVALID:{response.status}")
            data = response.read(1024 * 1024 + 1)
    except (OSError, urllib.error.URLError) as error:
        raise VerificationError("SMOKE_HTTP_REQUEST_FAILED") from error
    if len(data) > 1024 * 1024:
        raise VerificationError("SMOKE_HTTP_RESPONSE_TOO_LARGE")
    return _json_object(data, url)


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _is_reparse(path: Path) -> bool:
    try:
        return bool(getattr(os.lstat(path), "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError as error:
        raise VerificationError("SMOKE_PATH_METADATA_FAILED") from error


def _wait_port_released(port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind(("127.0.0.1", port))
            return
        except OSError:
            time.sleep(0.1)
    raise VerificationError("SMOKE_PORT_NOT_RELEASED")


def _run_relocation_smoke_after_static(
    archive_path: Path, policy: dict[str, Any], *, smoke_parent: Path | None, timeout: float,
) -> dict[str, Any]:
    if os.name != "nt":
        raise VerificationError("SMOKE_WINDOWS_REQUIRED")
    if timeout <= 0 or timeout > 120:
        raise VerificationError("SMOKE_TIMEOUT_INVALID")
    parent = smoke_parent.resolve() if smoke_parent is not None else None
    if parent is not None:
        parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="opiu-r17-relocated-", dir=parent) as raw:
        extraction = Path(raw).resolve()
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(extraction)
        package_root = (extraction / policy["archive_root"]).resolve()
        try:
            package_root.relative_to(extraction)
        except ValueError as error:
            raise VerificationError("SMOKE_EXTRACTION_ROOT_ESCAPE") from error
        if not package_root.is_dir():
            raise VerificationError("SMOKE_PACKAGE_ROOT_MISSING")
        for item in package_root.rglob("*"):
            if item.is_symlink() or _is_reparse(item):
                raise VerificationError("SMOKE_EXTRACTED_SYMLINK_FORBIDDEN")
            try:
                item.resolve().relative_to(package_root)
            except ValueError as error:
                raise VerificationError("SMOKE_EXTRACTED_PATH_ESCAPE") from error
        initial_files = {
            item.relative_to(package_root).as_posix()
            for item in package_root.rglob("*") if item.is_file()
        }

        executable = package_root / policy["executable_name"]
        node = package_root / Path(policy["toolchains"]["node"]["package_path"])
        modules = package_root / Path(policy["toolchains"]["node_modules"]["package_path"])
        environment = dict(os.environ)
        private_root = package_root / "smoke-private"
        temp_root = private_root / "temp"
        for directory in (private_root, temp_root):
            directory.mkdir(parents=True, exist_ok=True)
        environment.update({
            "OPIU_RUNTIME_ROOT": str(package_root / "runtime"),
            "OPIU_NODE_PATH": str(node),
            "APPDATA": str(private_root / "appdata"),
            "LOCALAPPDATA": str(private_root / "localappdata"),
            "TEMP": str(temp_root), "TMP": str(temp_root),
            "OPIU_ALLOW_LIVE_1C": "0", "OPIU_READY_TO_UPLOAD": "0",
            "OPIU_RELEASE_ALLOWED": "0", "OPIU_ENABLE_POSTING": "0",
            "NODE_OPTIONS": "", "NODE_PATH": "", "NODE_ENV": "production", "TZ": "UTC",
        })
        try:
            version = subprocess.run(
                [str(node), "--version"], cwd=package_root, env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                encoding="utf-8", errors="replace", timeout=timeout, check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise VerificationError("SMOKE_NODE_VERSION_FAILED") from error
        if version.returncode != 0 or version.stdout.strip() != policy["toolchains"]["node"]["version_line"]:
            raise VerificationError("SMOKE_NODE_VERSION_INVALID")
        node_script = r'''
const path = require("path");
const {createRequire} = require("module");
const {pathToFileURL} = require("url");
const modules = process.argv[1];
const localRequire = createRequire(path.join(modules, "__opiu_smoke__.cjs"));
(async () => {
  const specs = [
    "jszip",
    "@oai/artifact-tool",
    path.join(modules, "@oai", "artifact-tool", "node_modules", "skia-canvas"),
  ];
  let skia;
  for (const spec of specs) {
    const resolved = localRequire.resolve(spec);
    const loaded = await import(pathToFileURL(resolved).href);
    if (spec === specs[2]) skia = loaded;
  }
  const Canvas = skia.Canvas || (skia.default && skia.default.Canvas);
  if (typeof Canvas !== "function") throw new Error("skia Canvas export missing");
  const canvas = new Canvas(2, 2);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("skia Canvas context unavailable");
  context.fillStyle = "#123456";
  context.fillRect(0, 0, 2, 2);
  process.stdout.write("NODE_RUNTIME_LOAD_AND_CANVAS_PASS");
})().catch((error) => { process.stderr.write(String(error)); process.exit(9); });
'''
        try:
            loaded = subprocess.run(
                [str(node), "-e", node_script, str(modules)], cwd=package_root, env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                encoding="utf-8", errors="replace", timeout=timeout, check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise VerificationError("SMOKE_NODE_RUNTIME_LOAD_FAILED") from error
        if loaded.returncode != 0 or loaded.stdout.strip() != "NODE_RUNTIME_LOAD_AND_CANVAS_PASS":
            raise VerificationError("SMOKE_NODE_RUNTIME_LOAD_INVALID")

        port = _free_loopback_port()
        data_dir = package_root / "smoke-output"
        process: subprocess.Popen[str] | None = None
        health: dict[str, Any] | None = None
        bootstrap: dict[str, Any] | None = None
        try:
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            process = subprocess.Popen(
                [str(executable), "-addr", f"127.0.0.1:{port}", "-data-dir", str(data_dir), "-no-open"],
                cwd=package_root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", creationflags=creationflags,
            )
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise VerificationError(f"SMOKE_SERVICE_EXITED_EARLY:{process.returncode}")
                try:
                    health = _http_json(f"http://127.0.0.1:{port}/api/health", 1.0)
                    break
                except VerificationError:
                    time.sleep(0.1)
            if health is None:
                raise VerificationError("SMOKE_HEALTH_TIMEOUT")
            bootstrap = _http_json(f"http://127.0.0.1:{port}/api/bootstrap", 2.0)
            expected_public_safety = {
                "mode": "REPORT_ONLY", "posting_rows": 0, "ready_to_upload": False,
                "release_allowed": False, "live_1c_allowed": False,
            }
            if (
                health.get("status") != "ok" or health.get("service") != "OPIU_STABLE"
                or health.get("safety") != expected_public_safety
            ):
                raise VerificationError("SMOKE_HEALTH_CONTRACT_INVALID")
            if (
                not str(bootstrap.get("service_version", "")).startswith("1.9.4")
                or bootstrap.get("safety") != expected_public_safety
                or bootstrap.get("engine_adapter_ready") is not True
            ):
                raise VerificationError("SMOKE_BOOTSTRAP_CONTRACT_INVALID")
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        _wait_port_released(port, min(timeout, 10.0))
        output_files = []
        for item in package_root.rglob("*"):
            if item.is_symlink() or _is_reparse(item):
                raise VerificationError("SMOKE_OUTPUT_LINK_FORBIDDEN")
            if not item.is_file():
                continue
            try:
                relative = item.resolve().relative_to(package_root).as_posix()
            except ValueError as error:
                raise VerificationError("SMOKE_OUTPUT_OUTSIDE_EXTRACTED_ROOT") from error
            if relative not in initial_files:
                output_files.append(relative)
        return {
            "status": "PASS", "relocated": True, "node_version_verified": True,
            "jszip_loaded": True, "artifact_tool_loaded": True, "skia_canvas_loaded": True,
            "skia_canvas_constructed": True,
            "health_verified": True, "bootstrap_verified": True, "port_released": True,
            "all_outputs_under_extracted_root": True, "output_file_count": len(output_files),
            "localhost_only": True, "release_approved": False,
        }


def _run_two_relocation_smokes_after_static(
    archive_path: Path, policy: dict[str, Any], *, smoke_parent: Path | None, timeout: float,
) -> dict[str, Any]:
    parents: list[Path | None]
    if smoke_parent is None:
        parents = [None, None]
    else:
        resolved = smoke_parent.resolve()
        parents = [resolved / "relocation-a", resolved / "relocation-b"]
    relocations = [
        _run_relocation_smoke_after_static(
            archive_path, policy, smoke_parent=parent, timeout=timeout,
        )
        for parent in parents
    ]
    if len(relocations) != 2 or any(report.get("status") != "PASS" for report in relocations):
        raise VerificationError("SMOKE_TWO_RELOCATION_ROOTS_REQUIRED")
    boolean_fields = (
        "relocated", "node_version_verified", "jszip_loaded", "artifact_tool_loaded",
        "skia_canvas_loaded", "skia_canvas_constructed", "health_verified",
        "bootstrap_verified", "port_released", "all_outputs_under_extracted_root",
        "localhost_only",
    )
    if any(report.get(field) is not True for report in relocations for field in boolean_fields):
        raise VerificationError("SMOKE_RELOCATION_REPORT_INVALID")
    return {
        "status": "PASS", "relocation_root_count": 2, "relocations": relocations,
        "skia_canvas_constructed_in_both": True, "port_released_in_both": True,
        "all_outputs_under_each_extracted_root": True, "release_approved": False,
    }


def verify_archive_relocation_smoke(
    archive_path: Path, policy: dict[str, Any], *, policy_sha256: str | None = None,
    expected_source_head: str | None = None,
    expected_source_inventory_sha256: str | None = None,
    smoke_parent: Path | None = None, timeout: float = 20.0,
) -> dict[str, Any]:
    verify_archive(
        archive_path, policy, policy_sha256=policy_sha256,
        expected_source_head=expected_source_head,
        expected_source_inventory_sha256=expected_source_inventory_sha256,
    )
    return _run_two_relocation_smokes_after_static(
        archive_path, policy, smoke_parent=smoke_parent, timeout=timeout,
    )


def verify_pair(
    archive_a: Path, archive_b: Path, policy: dict[str, Any], *, policy_sha256: str | None = None,
    expected_source_head: str | None = None,
    expected_source_inventory_sha256: str | None = None,
) -> dict[str, Any]:
    first = verify_archive(
        archive_a, policy, policy_sha256=policy_sha256,
        expected_source_head=expected_source_head,
        expected_source_inventory_sha256=expected_source_inventory_sha256,
    )
    second = verify_archive(
        archive_b, policy, policy_sha256=policy_sha256,
        expected_source_head=expected_source_head,
        expected_source_inventory_sha256=expected_source_inventory_sha256,
    )
    if first["sha256"] != second["sha256"] or archive_a.read_bytes() != archive_b.read_bytes():
        raise VerificationError("INDEPENDENT_ARCHIVES_NOT_BYTE_IDENTICAL")
    if first["source_head"] != second["source_head"]:
        raise VerificationError("INDEPENDENT_ARCHIVES_SOURCE_HEAD_MISMATCH")
    return {
        "status": "PASS_REPORT_ONLY_CANDIDATE_PAIR", "archive_name": policy["archive_name"],
        "sha256": first["sha256"], "size": first["size"], "byte_identical": True,
        "independent_complete_builds": 2, "source_head": first["source_head"],
        "release_approved": False, "safety": policy["safety"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-a", type=Path, required=True)
    parser.add_argument("--archive-b", type=Path)
    parser.add_argument("--policy", type=Path, default=POLICY_PATH)
    parser.add_argument("--expected-source-head", required=True)
    parser.add_argument("--expected-source-inventory-sha256", required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--smoke-parent", type=Path)
    parser.add_argument("--smoke-timeout", type=float, default=20.0)
    arguments = parser.parse_args()
    try:
        policy = load_policy(arguments.policy)
        policy_sha = sha256_file(arguments.policy)
        result = (
            verify_pair(
                arguments.archive_a, arguments.archive_b, policy, policy_sha256=policy_sha,
                expected_source_head=arguments.expected_source_head,
                expected_source_inventory_sha256=arguments.expected_source_inventory_sha256,
            )
            if arguments.archive_b else
            verify_archive(
                arguments.archive_a, policy, policy_sha256=policy_sha,
                expected_source_head=arguments.expected_source_head,
                expected_source_inventory_sha256=arguments.expected_source_inventory_sha256,
                run_smoke=arguments.smoke, smoke_parent=arguments.smoke_parent,
                smoke_timeout=arguments.smoke_timeout,
            )
        )
        if arguments.archive_b and arguments.smoke:
            result["relocation_smoke"] = verify_archive_relocation_smoke(
                arguments.archive_a, policy, policy_sha256=policy_sha,
                expected_source_head=arguments.expected_source_head,
                expected_source_inventory_sha256=arguments.expected_source_inventory_sha256,
                smoke_parent=arguments.smoke_parent, timeout=arguments.smoke_timeout,
            )
    except VerificationError as error:
        code = str(error).split(":", 1)[0] or "VERIFY_FAILED"
        parser.exit(2, json.dumps({"status": "VERIFY_FAILED", "error": code}) + "\n")
    except Exception:
        parser.exit(2, json.dumps({"status": "VERIFY_FAILED", "error": "UNEXPECTED_VERIFY_FAILURE"}) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
