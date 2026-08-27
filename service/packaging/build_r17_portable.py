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


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    return BASE.sha256_file(path)


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


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
    if contract.get("package_path") != "contract/OPIU_v0.4.docx" or contract.get("sha256") != (
        "09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD"
    ):
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


def copy_runtime_sources(repository: Path, stage: Path, policy: dict[str, Any]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for root_relative in policy["runtime_source_roots"]:
        source_root = repository / Path(root_relative)
        if not source_root.is_dir():
            raise BuildError(f"RUNTIME_SOURCE_ROOT_MISSING:{root_relative}")
        target_root = stage / "runtime" / Path(root_relative)
        for source in safe_files(source_root):
            local = source.relative_to(source_root).as_posix()
            logical = PurePosixPath(root_relative).joinpath(local).as_posix()
            if _excluded(logical, policy):
                continue
            target = target_root / Path(local)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            if sha256_file(source) != sha256_file(target):
                raise BuildError(f"RUNTIME_SOURCE_COPY_MISMATCH:{logical}")
            rows.append({"path": logical, "size": target.stat().st_size, "sha256": sha256_file(target)})
    if not rows:
        raise BuildError("RUNTIME_SOURCE_SET_EMPTY")
    return {"status": "EXACT_CLEAN_WORKTREE_COPY", **inventory_record_from_rows(rows)}


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


def verify_contract_and_settings(repository: Path, policy: dict[str, Any]) -> dict[str, Any]:
    contract = repository / Path(policy["contract"]["source"])
    if not contract.is_file() or sha256_file(contract) != policy["contract"]["sha256"]:
        raise BuildError("CONTRACT_SHA256_MISMATCH")
    settings = []
    for row in policy["unicode_settings"]:
        source = repository / Path(row["path"])
        if not source.is_file() or sha256_file(source) != row["sha256"]:
            raise BuildError(f"UNICODE_SETTING_SHA256_MISMATCH:{row['path']}")
        settings.append(dict(row))
    return {"contract": dict(policy["contract"]), "unicode_settings": settings}


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
            markers.extend((value.encode("utf-8"), value.encode("utf-16le")))
    return [marker for marker in markers if marker]


def audit_privacy(root: Path, policy: dict[str, Any], local_paths: Iterable[Path]) -> dict[str, Any]:
    exception = policy["privacy"]["allowed_upstream_debug_exception"]
    exception_path = exception["path"]
    local_markers = _privacy_markers(local_paths)
    unauthorized: list[str] = []
    generic_profile = re.compile(rb"(?i)(?:[A-Z]:[\\/]Users[\\/]|/Users/|/home/)")
    drive_a = re.compile(rb"(?i)D:\\a\\")
    runneradmin = re.compile(rb"(?i)runneradmin")
    found_exception = False
    for item in safe_files(root):
        relative = item.relative_to(root).as_posix()
        data = item.read_bytes()
        if any(marker in data for marker in local_markers):
            unauthorized.append(relative)
        profile_hits = len(generic_profile.findall(data))
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
    privacy: dict[str, Any], legacy: dict[str, Any],
) -> None:
    safety = dict(policy["safety"])
    assert_closed_safety(safety, policy["safety"])
    (stage / "runtime" / "SAFETY.json").write_bytes(canonical_json(safety))
    runtime_manifest_path = stage / "runtime" / "MANIFEST.json"
    runtime_record = inventory_record(stage / "runtime", excluded=("MANIFEST.json",))
    runtime_manifest = {
        "schema_version": RUNTIME_SCHEMA, "source_head": source_head,
        "policy_sha256": policy_sha, "safety": safety, "rules_service": False,
        "legacy_rules_gate": legacy, **runtime_record,
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
        "legacy_rules_gate": legacy, "privacy": privacy, "safety": safety,
    }
    (stage / "R17_BUILD_PROVENANCE.json").write_bytes(canonical_json(provenance))
    package_record = inventory_record(stage, excluded=("R17_PACKAGE_MANIFEST.json",))
    package_manifest = {
        "schema_version": SCHEMA_VERSION, "archive_name": policy["archive_name"],
        "archive_root": policy["archive_root"], "executable_name": policy["executable_name"],
        "source_head": source_head, "policy_sha256": policy_sha,
        "candidate_status": "REPORT_ONLY_ARCH_GATED", "release_approved": False,
        "safety": safety, "legacy_rules_gate": legacy, "privacy": privacy,
        "contract": dict(policy["contract"]), "unicode_settings": list(policy["unicode_settings"]),
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


def promote_independent_pair(
    output_a: Path, output_b: Path, producer: Callable[[int, Path], None], archive_name: str,
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
    promoted: list[Path] = []
    try:
        for index, output in enumerate((first, second)):
            output.parent.mkdir(parents=True, exist_ok=True)
            descriptor, raw = tempfile.mkstemp(prefix=f".{archive_name}.", suffix=".building", dir=output.parent)
            os.close(descriptor)
            temporary = Path(raw)
            temporary.unlink()
            temporaries.append(temporary)
            producer(index, temporary)
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
        for temporary in temporaries:
            temporary.unlink(missing_ok=True)
    return {
        "archive_name": archive_name, "first_sha256": hashes[0], "second_sha256": hashes[1],
        "size": first.stat().st_size, "byte_identical": True,
        "independent_complete_builds": 2, "atomic_no_overwrite": True,
    }


def _build_one(
    index: int, output: Path, repository: Path, source_head: str, go_exe: Path,
    node_exe: Path, node_modules: Path, policy: dict[str, Any], policy_sha: str,
) -> None:
    with tempfile.TemporaryDirectory(prefix=f"opiu-r17-independent-{index + 1}-") as raw:
        work = Path(raw)
        go_build = BASE.test_and_build_service(go_exe, repository / "service" / "source", work / "go")
        BASE.verify_repository(repository, source_head)
        stage = work / policy["archive_root"]
        stage.mkdir()
        source_binding = copy_runtime_sources(repository, stage, policy)
        source_binding["service_source"] = BASE.inventory_record(repository / "service" / "source")
        shutil.copyfile(go_build["first_exe"], stage / policy["executable_name"])
        node_target = stage / Path(policy["toolchains"]["node"]["package_path"])
        node_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(node_exe, node_target)
        modules_target = stage / Path(policy["toolchains"]["node_modules"]["package_path"])
        _copy_verified_tree(node_modules, modules_target)
        contract_target = stage / Path(policy["contract"]["package_path"])
        contract_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repository / Path(policy["contract"]["source"]), contract_target)
        for row in policy["unicode_settings"]:
            target = stage / Path(row["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(repository / Path(row["path"]), target)
        node_record = verify_node(node_target, modules_target, policy)
        legacy = audit_legacy_rules_package(stage, policy)
        privacy = audit_privacy(
            stage, policy, (repository, go_exe.parent.parent, node_exe.parent, node_modules, output.parent, work),
        )
        _write_metadata(
            stage, policy, source_head, policy_sha, go_build, node_record,
            source_binding, privacy, legacy,
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
        BASE.verify_repository(repository, source_head)
        write_deterministic_zip(stage, output, policy)


def build(
    repository: Path, source_head: str, go_exe: Path, node_exe: Path, node_modules: Path,
    output_a: Path, output_b: Path, policy_path: Path = POLICY_PATH,
) -> dict[str, Any]:
    repository = repository.resolve()
    policy_path = policy_path.resolve()
    policy = load_policy(policy_path)
    policy_sha = sha256_file(policy_path)
    verified_head = BASE.verify_repository(repository, source_head)
    legacy = audit_legacy_rules_repository(repository, policy)
    verify_contract_and_settings(repository, policy)
    verify_node(node_exe.resolve(), node_modules.resolve(), policy)
    if BASE.verify_toolchain(go_exe.resolve())["go_exe_sha256"] != policy["toolchains"]["go"]["go_exe_sha256"]:
        raise BuildError("GO_POLICY_BINDING_MISMATCH")

    def producer(index: int, temporary_output: Path) -> None:
        _build_one(
            index, temporary_output, repository, verified_head, go_exe.resolve(),
            node_exe.resolve(), node_modules.resolve(), policy, policy_sha,
        )

    outputs = promote_independent_pair(output_a, output_b, producer, policy["archive_name"])
    return {
        "status": "BUILT_REPORT_ONLY_ARCH_GATED_CANDIDATE", "source_head": verified_head,
        "policy_sha256": policy_sha, "legacy_rules_gate": legacy,
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
