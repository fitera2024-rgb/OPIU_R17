#!/usr/bin/env python3
"""Independent, read-only verification of one or two OPIU R17 portable ZIPs."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


POLICY_PATH = Path(__file__).with_name("r17_portable_policy.json")
POLICY_SCHEMA = "opiu-r17-portable-policy.v1"
PACKAGE_SCHEMA = "opiu-r17-package-manifest.v1"
PROVENANCE_SCHEMA = "opiu-r17-build-provenance.v1"
RUNTIME_SCHEMA = "opiu-r17-runtime-manifest.v1"


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
    }
    if not required.issubset(policy):
        raise VerificationError("POLICY_FIELDS_MISSING")
    if not enforce_canonical:
        return
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
    profile = re.compile(rb"(?i)(?:[A-Z]:[\\/]Users[\\/]|/Users/|/home/)")
    runneradmin = re.compile(rb"(?i)runneradmin")
    drive_a = re.compile(rb"(?i)D:\\a\\")
    unauthorized: list[str] = []
    for relative, data in payloads.items():
        profile_hits = len(profile.findall(data))
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
    if provenance.get("source_head") != source_head or runtime_manifest.get("source_head") != source_head:
        raise VerificationError("SOURCE_HEAD_BINDING_MISMATCH")
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
    for document in (manifest, provenance):
        if document.get("privacy") != privacy or document.get("legacy_rules_gate") != legacy:
            raise VerificationError("AUDIT_EVIDENCE_MISMATCH")
    if runtime_manifest.get("legacy_rules_gate") != legacy or runtime_manifest.get("rules_service") is not False:
        raise VerificationError("RUNTIME_LEGACY_GATE_MISMATCH")
    return {
        "status": "PASS_REPORT_ONLY_CANDIDATE", "archive": archive_path.name,
        "sha256": sha256_file(archive_path), "size": archive_path.stat().st_size,
        "entry_count": len(payloads), "source_head": manifest.get("source_head"),
        "release_approved": False, "safety": policy["safety"],
        "legacy_rules_gate": legacy, "privacy": privacy,
    }


def verify_pair(
    archive_a: Path, archive_b: Path, policy: dict[str, Any], *, policy_sha256: str | None = None,
) -> dict[str, Any]:
    first = verify_archive(archive_a, policy, policy_sha256=policy_sha256)
    second = verify_archive(archive_b, policy, policy_sha256=policy_sha256)
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
    arguments = parser.parse_args()
    try:
        policy = load_policy(arguments.policy)
        policy_sha = sha256_file(arguments.policy)
        result = (
            verify_pair(arguments.archive_a, arguments.archive_b, policy, policy_sha256=policy_sha)
            if arguments.archive_b else
            verify_archive(arguments.archive_a, policy, policy_sha256=policy_sha)
        )
    except VerificationError as error:
        code = str(error).split(":", 1)[0] or "VERIFY_FAILED"
        parser.exit(2, json.dumps({"status": "VERIFY_FAILED", "error": code}) + "\n")
    except Exception:
        parser.exit(2, json.dumps({"status": "VERIFY_FAILED", "error": "UNEXPECTED_VERIFY_FAILURE"}) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
