#!/usr/bin/env python3
"""Build two identical REPORT_ONLY service candidates from exact clean source.

The pinned REL-52L ZIP is a carrier only. Its runtime subtree is preserved
byte-for-byte; its embedded Service EXE is replaced by an exact Go 1.22.12
Windows build from one clean Git head. Packaging success is not financial,
full-year, release, upload, posting, or live-1C approval.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence


WORK_ID = "OPIU-2026-08-25-SERVICE-PACKAGING-BUILD-001"
SCHEMA_VERSION = "opiu-clean-source-service-candidate.v1"
BASE_ARCHIVE_SHA256 = "7C7BA85806B3D609684FCFB30EDE57E50C73C0EE9A9AC0A544C64708C6B95A3A"
BASE_SERVICE_EXE_SHA256 = "EE65F9BC1BA43173BAB7F552BDDCEA56F20676E2C5EAB97520D70AC770E7267C"
EXPECTED_GO_VERSION_LINE = "go version go1.22.12 windows/amd64"
EXPECTED_GO_EXE_SHA256 = "08CFBE81F1BF519874CE8E6670EA98768D18CC0D16B9FF9D67EB785EC9A15CF9"
EXPECTED_GO_TOOLCHAIN_FILE_COUNT = 12900
EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256 = "FC5948968417E9FAF0FE7172F70CAC33E131056D7225EB00F4B4EA9A3B69268E"
FIXED_ZIP_TIME = (2026, 8, 25, 0, 0, 0)
SERVICE_SOURCE_RELATIVE = Path("development/OPIU_1.9.4/service/source")
SERVICE_EXE_NAME = "OPIU_STABLE_Service.exe"

SAFETY_ZERO_FIELDS = (
    "posting_rows",
    "executed_posting_rows",
    "live_posting_rows",
)
SAFETY_FALSE_FIELDS = (
    "ready_to_upload",
    "release_allowed",
    "execution_allowed",
    "live_1c_allowed",
    "live_delete_allowed",
)


class BuildError(RuntimeError):
    pass


FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise BuildError(f"JSON_READ_FAILED:{path.name}:{error}") from error
    if not isinstance(value, dict):
        raise BuildError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def is_reparse_point(path: Path) -> bool:
    try:
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError as error:
        raise BuildError(f"PATH_METADATA_FAILED:{path.name}:{error}") from error
    return bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)


def has_reparse_ancestor(path: Path) -> bool:
    current = path.absolute()
    while True:
        if is_reparse_point(current):
            return True
        if current.parent == current:
            return False
        current = current.parent


def regular_files(root: Path) -> list[Path]:
    root = root.absolute()
    if not root.is_dir() or root.is_symlink() or is_reparse_point(root):
        raise BuildError(f"INVENTORY_ROOT_INVALID:{root}")
    paths: list[Path] = []
    for item in root.rglob("*"):
        if item.is_symlink() or is_reparse_point(item):
            raise BuildError(f"SYMLINK_NOT_ALLOWED:{item.relative_to(root).as_posix()}")
        if item.is_file():
            paths.append(item)
    return sorted(paths, key=lambda item: item.relative_to(root).as_posix())


def inventory(
    root: Path,
    excluded: Iterable[str] = (),
    *,
    parallel: bool = False,
) -> list[dict[str, Any]]:
    root = root.absolute()
    excluded_paths = set(excluded)
    paths = [
        item for item in regular_files(root)
        if item.relative_to(root).as_posix() not in excluded_paths
    ]

    def row(item: Path) -> dict[str, Any]:
        return {
            "path": item.relative_to(root).as_posix(),
            "size": item.stat().st_size,
            "sha256": sha256_file(item),
        }
    if parallel and len(paths) > 1:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(paths))) as pool:
            return list(pool.map(row, paths))
    return [row(item) for item in paths]


def inventory_record_from_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rows = sorted(rows, key=lambda row: row["path"])
    payload = (
        json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    return {
        "file_count": len(rows),
        "sha256": sha256_bytes(payload),
        "files": rows,
    }


def inventory_record(
    root: Path,
    excluded: Iterable[str] = (),
    *,
    parallel: bool = False,
) -> dict[str, Any]:
    return inventory_record_from_rows(inventory(root, excluded, parallel=parallel))


def source_inventory(source_root: Path) -> dict[str, Any]:
    result = inventory_record(source_root)
    if result["file_count"] == 0:
        raise BuildError("SERVICE_SOURCE_INVENTORY_EMPTY")
    required = {"go.mod", "main.go"}
    actual = {row["path"] for row in result["files"]}
    missing = sorted(required - actual)
    if missing:
        raise BuildError(f"SERVICE_SOURCE_REQUIRED_FILE_MISSING:{','.join(missing)}")
    return result


def run_process(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    normalized = [os.fspath(value) for value in command]
    try:
        return subprocess.run(
            normalized,
            cwd=str(cwd),
            env=env,
            text=True,
            encoding="utf-8",
            errors="strict",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        raise BuildError(f"PROCESS_START_FAILED:{normalized[0]}:{error}") from error


def run_process_bytes(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[bytes]:
    normalized = [os.fspath(value) for value in command]
    try:
        return subprocess.run(
            normalized,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        raise BuildError(f"PROCESS_START_FAILED:{normalized[0]}:{error}") from error


def require_process(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise BuildError(f"{label}_FAILED:{result.returncode}:{details}")


def require_binary_process(result: subprocess.CompletedProcess[bytes], label: str) -> None:
    if result.returncode != 0:
        details = (result.stderr or result.stdout).decode("utf-8", "replace").strip()
        raise BuildError(f"{label}_FAILED:{result.returncode}:{details}")


def git_text(repository: Path, *arguments: str) -> str:
    result = run_process(
        ["git", "-C", str(repository), *arguments],
        cwd=repository,
        env=dict(os.environ),
    )
    require_process(result, f"GIT_{arguments[0].upper().replace('-', '_')}")
    return result.stdout.strip()


def verify_repository(repository: Path, expected_head: str) -> str:
    repository = repository.resolve()
    expected_head = expected_head.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", expected_head):
        raise BuildError("SOURCE_HEAD_INVALID")
    actual_root = Path(git_text(repository, "rev-parse", "--show-toplevel")).resolve()
    if os.path.normcase(str(actual_root)) != os.path.normcase(str(repository)):
        raise BuildError(f"SOURCE_REPOSITORY_ROOT_MISMATCH:{actual_root}")
    actual_head = git_text(repository, "rev-parse", "HEAD").lower()
    if actual_head != expected_head:
        raise BuildError(f"SOURCE_HEAD_MISMATCH:{actual_head}:{expected_head}")
    status = git_text(
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    )
    if status:
        raise BuildError("SOURCE_REPOSITORY_NOT_CLEAN")
    return actual_head


def git_source_inventory(repository: Path, expected_head: str) -> dict[str, Any]:
    source_prefix = SERVICE_SOURCE_RELATIVE.as_posix().rstrip("/") + "/"
    result = run_process_bytes(
        ["git", "-C", str(repository), "archive", "--format=tar", expected_head, "--", source_prefix],
        cwd=repository,
        env=dict(os.environ),
    )
    require_binary_process(result, "GIT_ARCHIVE_SOURCE")
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
    return inventory_record_from_rows(rows)


def exact_source_inventory(repository: Path, expected_head: str, source_root: Path) -> dict[str, Any]:
    working = source_inventory(source_root)
    committed = git_source_inventory(repository, expected_head)
    if working != committed:
        raise BuildError("SERVICE_SOURCE_NOT_EXACT_GIT_TREE")
    return working


def verify_source_unchanged(
    repository: Path,
    expected_head: str,
    source_root: Path,
    expected_inventory: dict[str, Any],
) -> None:
    verify_repository(repository, expected_head)
    if exact_source_inventory(repository, expected_head, source_root) != expected_inventory:
        raise BuildError("SERVICE_SOURCE_CHANGED_DURING_BUILD")


def closed_go_environment(build_root: Path) -> dict[str, str]:
    build_root.mkdir(parents=True, exist_ok=True)
    cache = build_root / "gocache"
    modcache = build_root / "gomodcache"
    gopath = build_root / "gopath"
    temporary = build_root / "temp"
    for path in (cache, modcache, gopath, temporary):
        path.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment.update(
        {
            "GOTOOLCHAIN": "local",
            "GOENV": "off",
            "GOOS": "windows",
            "GOARCH": "amd64",
            "CGO_ENABLED": "0",
            "GOFLAGS": "-mod=readonly",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOCACHE": str(cache.resolve()),
            "GOMODCACHE": str(modcache.resolve()),
            "GOPATH": str(gopath.resolve()),
            "TEMP": str(temporary.resolve()),
            "TMP": str(temporary.resolve()),
            "TZ": "UTC",
        }
    )
    return environment


def verify_toolchain_files(go_exe: Path) -> dict[str, Any]:
    supplied = go_exe.absolute()
    if not supplied.is_file() or supplied.is_symlink() or has_reparse_ancestor(supplied):
        raise BuildError("GO_EXECUTABLE_NOT_PINNED_REGULAR_FILE")
    toolchain_root = supplied.parent.parent
    if toolchain_root.is_symlink() or has_reparse_ancestor(toolchain_root):
        raise BuildError("GO_TOOLCHAIN_ROOT_REPARSE_NOT_ALLOWED")
    expected_executable = toolchain_root / "bin" / "go.exe"
    if os.path.normcase(str(supplied)) != os.path.normcase(str(expected_executable)):
        raise BuildError("GO_EXECUTABLE_LAYOUT_INVALID")
    executable_sha = sha256_file(supplied)
    if executable_sha != EXPECTED_GO_EXE_SHA256:
        raise BuildError("GO_EXECUTABLE_SHA256_MISMATCH")
    record = inventory_record(toolchain_root, parallel=True)
    if (
        record["file_count"] != EXPECTED_GO_TOOLCHAIN_FILE_COUNT
        or record["sha256"] != EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256
    ):
        raise BuildError("GO_TOOLCHAIN_INVENTORY_MISMATCH")
    return {
        "go_exe_sha256": executable_sha,
        "toolchain_file_count": record["file_count"],
        "toolchain_inventory_sha256": record["sha256"],
    }


def run_pinned_go(
    go_exe: Path,
    arguments: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    env: dict[str, str],
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    binding = verify_toolchain_files(go_exe)
    return run_process([str(go_exe), *arguments], cwd=cwd, env=env), binding


def verify_toolchain(go_exe: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="opiu-go-version-") as raw:
        root = Path(raw)
        result, binding = run_pinned_go(
            go_exe,
            ["version"],
            cwd=root,
            env=closed_go_environment(root / "environment"),
        )
    require_process(result, "GO_VERSION")
    actual = result.stdout.strip()
    if actual != EXPECTED_GO_VERSION_LINE:
        raise BuildError(f"GO_TOOLCHAIN_MISMATCH:{actual}:{EXPECTED_GO_VERSION_LINE}")
    return {
        "version": "go1.22.12",
        "platform": "windows/amd64",
        "gotoolchain": "local",
        "cgo_enabled": "0",
        **binding,
    }


def verified_test_node_modules_inventory(root: Path) -> dict[str, Any]:
    try:
        record = inventory_record(root, parallel=True)
    except BuildError as error:
        raise BuildError("TEST_NODE_MODULES_INVENTORY_MISMATCH") from error
    return {
        "file_count": record["file_count"],
        "total_size": sum(row["size"] for row in record["files"]),
        "inventory_sha256": record["sha256"],
    }


def require_test_node_modules_inventory(root: Path, expected: dict[str, Any]) -> None:
    actual = verified_test_node_modules_inventory(root)
    required = ("file_count", "total_size", "inventory_sha256")
    if any(actual[key] != expected.get(key) for key in required):
        raise BuildError("TEST_NODE_MODULES_INVENTORY_MISMATCH")


def materialize_test_node_modules(
    source_root: Path, node_modules: Path, expected_inventory: dict[str, Any],
) -> Path:
    """Copy verified dependencies beside the extracted repository test tree."""
    source_root = source_root.resolve()
    supplied = node_modules.absolute()
    if not supplied.is_dir() or supplied.is_symlink() or is_reparse_point(supplied):
        raise BuildError("TEST_NODE_MODULES_INVENTORY_MISMATCH")
    # Enumerating first rejects every nested symlink/reparse before copying.
    require_test_node_modules_inventory(supplied, expected_inventory)
    target = source_root.parent.parent / "node_modules"
    if os.path.lexists(target):
        raise BuildError("TEST_NODE_MODULES_TARGET_COLLISION")
    try:
        shutil.copytree(supplied, target, copy_function=shutil.copyfile)
    except OSError as error:
        shutil.rmtree(target, ignore_errors=True)
        raise BuildError("TEST_NODE_MODULES_COPY_FAILED") from error
    try:
        require_test_node_modules_inventory(target, expected_inventory)
    except BuildError:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return target


def remove_test_node_modules(source_root: Path, target: Path) -> None:
    expected = source_root.resolve().parent.parent / "node_modules"
    if target != expected or not target.is_dir() or target.is_symlink() or is_reparse_point(target):
        raise BuildError("TEST_NODE_MODULES_CLEANUP_TARGET_INVALID")
    try:
        shutil.rmtree(target)
    except OSError as error:
        raise BuildError("TEST_NODE_MODULES_CLEANUP_FAILED") from error


def test_and_build_service(
    go_exe: Path, source_root: Path, build_root: Path, *,
    test_node_exe: Path | None = None, test_node_modules: Path | None = None,
    expected_test_node_modules_inventory: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_root = source_root.resolve()
    build_root = build_root.resolve()
    build_root.mkdir(parents=True, exist_ok=True)
    toolchain = verify_toolchain(go_exe)
    test_environment = closed_go_environment(build_root / "test-environment")
    if test_node_exe is not None:
        pinned_node = test_node_exe.resolve()
        if not pinned_node.is_file() or pinned_node.is_symlink() or has_reparse_ancestor(pinned_node):
            raise BuildError("TEST_NODE_EXECUTABLE_NOT_PINNED_REGULAR_FILE")
        test_environment.update({
            "PATH": str(pinned_node.parent) + os.pathsep + test_environment.get("PATH", ""),
            "NODE_OPTIONS": "", "NODE_PATH": "", "NODE_ENV": "production",
        })
    test_command = [str(go_exe), "test", "-count=1", "./..."]
    test_modules_target: Path | None = None
    test_error: Exception | None = None
    try:
        if test_node_modules is not None:
            if expected_test_node_modules_inventory is None:
                raise BuildError("TEST_NODE_MODULES_INVENTORY_MISMATCH")
            test_modules_target = materialize_test_node_modules(
                source_root, test_node_modules, expected_test_node_modules_inventory,
            )
        test_result, _ = run_pinned_go(
            go_exe,
            test_command[1:],
            cwd=source_root,
            env=test_environment,
        )
        require_process(test_result, "GO_TEST")
        if test_modules_target is not None:
            require_test_node_modules_inventory(
                test_modules_target, expected_test_node_modules_inventory,
            )
    except Exception as error:
        test_error = error
    if test_modules_target is not None:
        try:
            remove_test_node_modules(source_root, test_modules_target)
        except BuildError:
            if test_error is None:
                raise
    if test_error is not None:
        raise test_error

    first = build_root / "first" / SERVICE_EXE_NAME
    second = build_root / "second" / SERVICE_EXE_NAME
    first.parent.mkdir(parents=True, exist_ok=True)
    second.parent.mkdir(parents=True, exist_ok=True)
    build_prefix = [
        str(go_exe),
        "build",
        "-trimpath",
        "-mod=readonly",
        "-buildvcs=false",
        "-ldflags=-s -w -buildid=",
    ]
    first_result, _ = run_pinned_go(
        go_exe,
        [*build_prefix[1:], "-o", str(first), "."],
        cwd=source_root,
        env=closed_go_environment(build_root / "first-environment"),
    )
    require_process(first_result, "GO_BUILD_FIRST")
    second_result, _ = run_pinned_go(
        go_exe,
        [*build_prefix[1:], "-o", str(second), "."],
        cwd=source_root,
        env=closed_go_environment(build_root / "second-environment"),
    )
    require_process(second_result, "GO_BUILD_SECOND")
    if not first.is_file() or not second.is_file():
        raise BuildError("SERVICE_EXE_BUILD_OUTPUT_MISSING")
    first_hash = sha256_file(first)
    second_hash = sha256_file(second)
    if first_hash != second_hash or first.read_bytes() != second.read_bytes():
        raise BuildError(f"SERVICE_EXE_NONDETERMINISTIC:{first_hash}:{second_hash}")
    return {
        "toolchain": toolchain,
        "test_command": ["go", "test", "-count=1", "./..."],
        "build_command": [
            "go", "build", "-trimpath", "-mod=readonly", "-buildvcs=false",
            "-ldflags=-s -w -buildid=", "-o", SERVICE_EXE_NAME, ".",
        ],
        "go_test_passed": True,
        "deterministic_double_build": True,
        "first_exe": first,
        "second_exe": second,
        "first_sha256": first_hash,
        "second_sha256": second_hash,
        "size": first.stat().st_size,
    }


def assert_report_only(safety: dict[str, Any]) -> None:
    if safety.get("mode") != "REPORT_ONLY":
        raise BuildError("REPORT_ONLY_SAFETY_GATE_INVALID:mode")
    for field in SAFETY_ZERO_FIELDS:
        if safety.get(field) != 0:
            raise BuildError(f"REPORT_ONLY_SAFETY_GATE_INVALID:{field}")
    for field in SAFETY_FALSE_FIELDS:
        if safety.get(field) is not False:
            raise BuildError(f"REPORT_ONLY_SAFETY_GATE_INVALID:{field}")


def closed_safety() -> dict[str, Any]:
    return {
        "mode": "REPORT_ONLY",
        "report_only": True,
        "posting_rows": 0,
        "executed_posting_rows": 0,
        "live_posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
        "execution_allowed": False,
        "live_1c_allowed": False,
        "live_delete_allowed": False,
    }


def user_profile_path_evidence(root: Path) -> dict[str, str]:
    ascii_pattern = re.compile(rb"(?i)[A-Z]:\\Users\\")
    utf16_pattern = re.compile(rb"(?i)[A-Z]\x00:\x00\\\x00U\x00s\x00e\x00r\x00s\x00\\\x00")
    hits: dict[str, str] = {}
    for item in regular_files(root):
        data = item.read_bytes()
        if ascii_pattern.search(data) or utf16_pattern.search(data):
            hits[item.relative_to(root).as_posix()] = sha256_bytes(data)
    return hits


def path_leakage_record(
    inherited_evidence: dict[str, str],
    candidate_evidence: dict[str, str],
) -> dict[str, Any]:
    introduced = sorted(
        path for path, digest in candidate_evidence.items()
        if inherited_evidence.get(path) != digest
    )
    if introduced:
        raise BuildError("NEW_BUILD_USER_PROFILE_PATH_LEAK")
    inherited_present = sorted(candidate_evidence)
    return {
        "whole_zip_user_profile_path_free": not candidate_evidence,
        "new_build_user_profile_path_free": True,
        "inherited_carrier_user_profile_paths_present": bool(inherited_present),
        "inherited_carrier_entry_count": len(inherited_present),
        "inherited_carrier_entries": inherited_present,
    }


def checked_extract(archive_path: Path, target: Path) -> Path:
    target = target.resolve()
    target.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            name = member.filename
            pure = PurePosixPath(name)
            normalized = pure.as_posix()
            if (
                not name
                or "\\" in name
                or pure.is_absolute()
                or ".." in pure.parts
                or (pure.parts and ":" in pure.parts[0])
            ):
                raise BuildError(f"UNSAFE_ARCHIVE_ENTRY:{name}")
            key = normalized.rstrip("/").casefold()
            if key in seen:
                raise BuildError(f"DUPLICATE_ARCHIVE_ENTRY:{name}")
            seen.add(key)
            unix_mode = (member.external_attr >> 16) & 0xFFFF
            if unix_mode and stat.S_ISLNK(unix_mode):
                raise BuildError(f"ARCHIVE_SYMLINK_NOT_ALLOWED:{name}")
        archive.extractall(target)
    bundle = target / "OPIU"
    if not bundle.is_dir() or bundle.is_symlink():
        raise BuildError("BASE_BUNDLE_ROOT_MISSING")
    return bundle


def assemble_candidate(
    bundle: Path,
    new_service_exe: Path,
    source_head: str,
    toolchain: dict[str, Any],
    source_record: dict[str, Any],
    build_record: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bundle = bundle.resolve()
    service = bundle / SERVICE_EXE_NAME
    runtime = bundle / "runtime"
    if not service.is_file() or sha256_file(service) != BASE_SERVICE_EXE_SHA256:
        raise BuildError("BASE_SERVICE_EXE_MISMATCH")
    if not new_service_exe.is_file():
        raise BuildError("BUILT_SERVICE_EXE_MISSING")
    safety = load_json(runtime / "SAFETY.json")
    assert_report_only(safety)
    runtime_manifest = load_json(runtime / "MANIFEST.json")
    manifest_safety = runtime_manifest.get("safety")
    if not isinstance(manifest_safety, dict):
        raise BuildError("RUNTIME_MANIFEST_SAFETY_MISSING")
    assert_report_only(manifest_safety)
    runtime_before = inventory_record(runtime)
    inherited_path_evidence = user_profile_path_evidence(bundle)
    old_service_hash = sha256_file(service)
    shutil.copyfile(new_service_exe, service)
    new_service_hash = sha256_file(service)
    if new_service_hash == old_service_hash:
        raise BuildError("SERVICE_EXE_NOT_REPLACED")
    safety_contract = closed_safety()
    leakage = path_leakage_record(
        inherited_path_evidence,
        user_profile_path_evidence(bundle),
    )
    provenance = {
        "schema_version": SCHEMA_VERSION,
        "work_id": WORK_ID,
        "source_head": source_head,
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "old_service_exe_sha256": old_service_hash,
        "service_exe_sha256": new_service_hash,
        "service_exe_size": service.stat().st_size,
        "toolchain": toolchain,
        "service_build": build_record or {
            "go_test_passed": True,
            "deterministic_double_build": True,
            "first_sha256": new_service_hash,
            "second_sha256": new_service_hash,
        },
        "go_test_passed": True,
        "deterministic_double_build": True,
        "source_inventory": source_record,
        "runtime_inventory": runtime_before,
        "runtime_preserved_byte_for_byte": True,
        "full_year_financial_e2e_performed": False,
        "release_approved": False,
        "live_1c_approved": False,
        "safety": safety_contract,
        "path_leakage": leakage,
    }
    (bundle / "SERVICE_BUILD_PROVENANCE.json").write_bytes(
        canonical_json_bytes(provenance)
    )
    if inventory_record(runtime) != runtime_before:
        raise BuildError("RUNTIME_OVERLAY_INVENTORY_CHANGED")
    files = inventory(bundle, {"BUNDLE_MANIFEST.json"})
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "work_id": WORK_ID,
        "source_head": source_head,
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "old_service_exe_sha256": old_service_hash,
        "service_exe_sha256": new_service_hash,
        "source_inventory_sha256": source_record["sha256"],
        "source_file_count": source_record["file_count"],
        "runtime_inventory_sha256": runtime_before["sha256"],
        "runtime_file_count": runtime_before["file_count"],
        "runtime_preserved_byte_for_byte": True,
        "deterministic_double_build": True,
        "full_year_financial_e2e_performed": False,
        "release_approved": False,
        "live_1c_approved": False,
        "safety": safety_contract,
        "path_leakage": leakage,
        "file_count": len(files),
        "files": files,
    }
    (bundle / "BUNDLE_MANIFEST.json").write_bytes(canonical_json_bytes(manifest))
    final_leakage = path_leakage_record(
        inherited_path_evidence,
        user_profile_path_evidence(bundle),
    )
    if final_leakage != leakage:
        raise BuildError("PACKAGE_PATH_LEAKAGE_RECORD_CHANGED")
    return provenance


def write_deterministic_zip(bundle: Path, output: Path) -> None:
    output = output.resolve()
    if output.exists():
        raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output.name}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        output,
        "x",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for item in regular_files(bundle):
            relative = item.relative_to(bundle).as_posix()
            info = zipfile.ZipInfo(f"OPIU/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(
                info,
                item.read_bytes(),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            )


def write_identical_zip_pair(bundle: Path, output_a: Path, output_b: Path) -> dict[str, Any]:
    first = output_a.resolve()
    second = output_b.resolve()
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
            descriptor, raw_path = tempfile.mkstemp(
                prefix=f".{output.name}.", suffix=".building", dir=output.parent,
            )
            os.close(descriptor)
            temporary = Path(raw_path)
            temporary.unlink()
            temporary_paths.append(temporary)
        write_deterministic_zip(bundle, temporary_paths[0])
        write_deterministic_zip(bundle, temporary_paths[1])
        first_hash = sha256_file(temporary_paths[0])
        second_hash = sha256_file(temporary_paths[1])
        if first_hash != second_hash or temporary_paths[0].read_bytes() != temporary_paths[1].read_bytes():
            raise BuildError(f"OUTPUT_ZIP_NONDETERMINISTIC:{first_hash}:{second_hash}")
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
    if os.path.normcase(str(output_a)) == os.path.normcase(str(output_b)):
        raise BuildError("OUTPUT_PATHS_MUST_BE_DISTINCT")
    for output in (output_a, output_b):
        if output.exists():
            raise BuildError(f"OUTPUT_ALREADY_EXISTS:{output.name}")
    if not carrier_archive.is_file() or sha256_file(carrier_archive) != BASE_ARCHIVE_SHA256:
        raise BuildError("BASE_ARCHIVE_HASH_MISMATCH")
    verified_head = verify_repository(repository, source_head)
    source_root = repository / SERVICE_SOURCE_RELATIVE
    source_record = exact_source_inventory(repository, verified_head, source_root)
    with tempfile.TemporaryDirectory(prefix="opiu-clean-source-package-") as raw:
        temporary = Path(raw)
        bundle = checked_extract(carrier_archive, temporary / "carrier")
        built = test_and_build_service(go_exe, source_root, temporary / "go-build")
        verify_source_unchanged(
            repository,
            verified_head,
            source_root,
            source_record,
        )
        provenance = assemble_candidate(
            bundle,
            built["first_exe"],
            verified_head,
            {
                **built["toolchain"],
                "test_command": built["test_command"],
                "build_command": built["build_command"],
            },
            source_record,
            {
                "go_test_passed": built["go_test_passed"],
                "deterministic_double_build": built["deterministic_double_build"],
                "test_command": built["test_command"],
                "build_command": built["build_command"],
                "first_sha256": built["first_sha256"],
                "second_sha256": built["second_sha256"],
                "size": built["size"],
            },
        )
        outputs = write_identical_zip_pair(bundle, output_a, output_b)
    return {
        "status": "BUILT_REPORT_ONLY_CANDIDATE",
        "work_id": WORK_ID,
        "source_head": verified_head,
        "base_archive_sha256": BASE_ARCHIVE_SHA256,
        "old_service_exe_sha256": provenance["old_service_exe_sha256"],
        "service_exe_sha256": provenance["service_exe_sha256"],
        "service_exe_size": provenance["service_exe_size"],
        "source_file_count": source_record["file_count"],
        "source_inventory_sha256": source_record["sha256"],
        "runtime_file_count": provenance["runtime_inventory"]["file_count"],
        "runtime_inventory_sha256": provenance["runtime_inventory"]["sha256"],
        "go_test_passed": True,
        "deterministic_double_build": True,
        "runtime_preserved_byte_for_byte": True,
        "full_year_financial_e2e_performed": False,
        "release_approved": False,
        "live_1c_approved": False,
        "safety": closed_safety(),
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
