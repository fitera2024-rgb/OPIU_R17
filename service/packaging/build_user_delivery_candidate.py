#!/usr/bin/env python3
"""Build the bounded REPORT_ONLY Portable Service 1.9.4 candidate.

The builder accepts only pinned source/materialization inputs, assembles the
embedded payload through the reviewed 1.9.4 allowlist tooling, proves UI byte
identity, compiles twice, and creates a deterministic outer ZIP.  It never
uploads, releases, merges, or invokes 1C.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PINNED_RC_SHA256 = "718055406962DE9A41B57CF5BA5107F40C34B9D545B32AEE231F924051A6C4A7"
PINNED_PACKAGE_COMMON_SHA256 = "050657CC7590882E8C6C6F8DEE01D01A9CA6DD7D89C87D1B1C63491899E8075F"
PINNED_PAYLOAD_POLICY_SHA256 = "6F00559C834EA90621D67CA70D23BAA4622477138AAABE098A4B5794B959BA1B"
PINNED_BASE_HEAD = "FFAAA4B0493D2A6DDD454CBDBFCF5D4085D58A98"
PINNED_SLOT1_PRODUCT = "02EB8CAF08CCAC156A2FDDA944CF5B06FC3F7C3B"
PINNED_SLOT1_PUBLISHED = "589C10BBFA3FE120038FCCC1709F05C9F743C2EC"
PINNED_SLOT2_PRODUCT = "6DCFC4DED8143A44D1528F5060172B673399AD17"
PINNED_SLOT2_PUBLISHED = "6637FB6149B6712B2482ABE2184FDC3E6B923D24"
SOURCE_PRODUCT_HEAD = "A5D033BE9AA2DF583ED751E7959F7BCDF8429200"
PINNED_BACKEND_PROVENANCE_SHA256 = "87BE9FDFA37819238DE3698A89DEE95F9BA1FE52A20DC891F208DA0AEACB6236"
PINNED_UI_PROVENANCE_SHA256 = "0ECB738BFB43289863376B62B5D583F26EC3ECCA69002B890E10083D2B922230"
FIXED_ZIP_TIME = (2026, 8, 11, 0, 0, 0)
CANDIDATE_NAME = "OPIU_Service_Portable_1.9.4_USER_DELIVERY_CANDIDATE"
EXE_NAME = "Автоматическая_сверка_ОПИУ_1.9.4.exe"

REPO_ROOT = Path(__file__).resolve().parents[4]
PACKAGING_ROOT = Path(__file__).resolve().parent
SOURCE_BASELINE = PACKAGING_ROOT / "SERVICE_SOURCE_BASELINE.json"
OVERLAY_ROOT = REPO_ROOT / "development" / "OPIU_1.9.4" / "service" / "backend_overlay"
BACKEND_PROVENANCE = OVERLAY_ROOT / "BASELINE_PROVENANCE.json"
UI_OVERLAY_ROOT = REPO_ROOT / "development" / "OPIU_1.9.4" / "service" / "ui_overlay"
UI_PROVENANCE = UI_OVERLAY_ROOT / "BASELINE_PROVENANCE.json"

EXPECTED_OVERLAY = {
    "main.go": "217AEBAD986ABE9219C1CD437F490DF1594E935A9FA38D37756EDA10404C45A6",
    "hotfix_045_test.go": "27C78947D39E8B0E3DFB88FC19672DF7552038C5D55D3563FDD14D75D29646AC",
    "platform_other.go": "13F193388E26CA0CF9A7A02D8282A614C21D2006E0B483A39D850D5D7E8B1E38",
    "platform_windows.go": "EACD2D900F69C4ED44FDC1B0E45E88ED48008F4B417C411DEFE4F6BE0CD407F5",
    "pre_run_source_proof.go": "083903E0731185AF840188FB2581D875A979E675A96CD1EAA339332FCE178F00",
    "pre_run_source_proof_test.go": "616624C64A900245B53BD9C3E1087C3FF0BDCC134E7FCD1C30D766B6269F762B",
    "pre_run_source_proof_ui.go": "5F9D1B5FC37A2515EA356FD8854CB39A15627B2E5CDC41053B5F6A2CFC590C46",
    "pre_run_source_proof_ui_test.go": "C56E6B4CA20456F4867CC04A8CDA21454242B303A016DBD7AA26034D30A873B2",
    "r001_handoff_binding.go": "BA0BA3AFE24AE445F4F2FFF2F67E20A5298F408BE8D2C31E668801172F4A8B5E",
    "r001_handoff_binding_test.go": "07FF52C08D1A2E2210DD3FB3DA0319B44A1072E4FD99A5FE7AC41D6F475D863C",
    "rules_engine_bridge.go": "CF105B491E21D5E54AB3B2FFE5CDB373F732FF29AF0CEFD988AC61E752F8D20B",
    "ux_v180_test.go": "4F6B3E61BC3BB9C18F81C1EC8F611DD7A44CA4C926D21DA7EF09905EA0151EC8",
    "v041.go": "046D7A85B0A907197EA8CCA6F8B2A4F769666AE02848C2B0E08C1C14FC73DCD1",
}

EXPECTED_UI_BASELINE = {
    "web/app.js": "2BCC2DCB51144109DADBB718A059F9FD57220E667068DED0FE3198AC2E117114",
    "web/app.css": "C8D36FB521B1A92E5483013254D81E5A6F9EBA74370CC076E95577DD7CF13317",
    "web/index.html": "B40F84F67A9A9974061BCE8D9C350F893F11B089F31B4E43423EEA509369DD59",
}

EXPECTED_UI_OVERLAY = {
    "web/app.js": "AE95B97A638EEDEBC47C1668FD301823F8DC58369A1D528A70F21EC86CA3E4EA",
    "web/app.css": "46012D60EA6A61F6E22C73EBD86D89A177F39C0658D46A8B0D76B31198C9499E",
    "web/index.html": "E85AE9E101EDC2C25A109AC52009D4BB638F05E3E3EBC497DD24C99EA6F96484",
}

ALLOWED_RELEASE_DIFFS = (
    "development/OPIU_1.9.4/service/packaging/",
    "governance/changes/CR-REL-20260811-005.md",
    "governance/decisions/DEC-REL-20260811-005.md",
    "governance/handoffs/CR-REL-20260811-005-HANDOFF.md",
    "governance/releases/REL-OPIU-1.9.4-OWNER-VALIDATION-005.md",
    "governance/work/OPIU-2026-08-11-REL-005.md",
)

RUNTIME_SOURCE_PINS = {
    "modules/corrections/source/correction_engine_r001.mjs":
        "03E42E2041D3D0CAD98871BCAF842223C538466711FA41D043DEA7BE54643CF9",
    "modules/corrections/source/r001_analytical_policy.mjs":
        "1120BE079AC08050A18AE23C018B3260179B75AEA19C6C0977AB367B6AD5B51E",
    "modules/corrections/source/r001_handoff_input.mjs":
        "86E36F91D5955F0E7495CE26C4AFDF0490257326195F98846647E7D5F1F3FEBC",
    "modules/corrections/source/r005_review_routing.mjs":
        "18CA4C89DF5FA8167C18EAF16409ED89A3BA3074A17AB032E2A82E2A9B3C691A",
    "modules/corrections/source/correction_rules.r001.json":
        "DD3F563B5972B0EE0718FADF158399DF6D5BDC7FD2791BBBE0F1AF09995EBCBA",
    "modules/corrections/source/КОНТРАКТ_ДВИЖКА_R001.md":
        "BD89FC5A58CF19D4467C7AA60A581C6589D4CDC54ED713A101CB9F711356F226",
    "modules/rules-engine/contracts/schemas/r001_handoff.schema.json":
        "1720A9B5CB31684A02CD5F12EF373B2EF199279F1E6F39101A24C26D874DB42C",
    "modules/rules-engine/source/handoff.mjs":
        "2ACA1FB00B79F1076C3E4D9A39E7044649B0DF56A1E39E9EB527787B3FA30A4D",
}

GO_TEST_NONPAYLOAD_PINS = {
    "build_payload.py": "05621AECD07C6E66096F675D74BCE80194E66155CF74471ED50A1072083FB3B2",
    "web/preview-data-044.js": "EAECCF983F05BBD75B11EC8735DFBC5BBF1A0B89A369ACBF869F2FAC070871D7",
    "modules/reconciliation/source/data/reconciliation_decisions.json":
        "39FD31CA648D72878CF785459F3B1EB73F185770F8B70C3D72FF066F8627388F",
}

class BuildError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def current_git_head() -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        text=True,
        encoding="utf-8",
        errors="strict",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise BuildError("GIT_HEAD_UNAVAILABLE")
    return result.stdout.strip().lower()


def git_output(arguments: list[str]) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO_ROOT), *arguments],
        text=True,
        encoding="utf-8",
        errors="strict",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise BuildError(f"GIT_COMMAND_FAILED:{arguments[0]}")
    return result.stdout


def release_path_allowed(path: str) -> bool:
    for allowed in ALLOWED_RELEASE_DIFFS:
        if allowed.endswith("/"):
            if path.startswith(allowed):
                return True
        elif path == allowed:
            return True
    return False


def verify_source_lineage(integration_head: str) -> list[str]:
    result = subprocess.run(
        [
            "git", "-C", str(REPO_ROOT), "merge-base", "--is-ancestor",
            SOURCE_PRODUCT_HEAD.lower(), integration_head.lower(),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise BuildError("SOURCE_PRODUCT_HEAD_NOT_ANCESTOR")
    changed = [
        line.strip().replace("\\", "/")
        for line in git_output([
            "diff", "--name-only", f"{SOURCE_PRODUCT_HEAD.lower()}..{integration_head.lower()}"
        ]).splitlines()
        if line.strip()
    ]
    unexpected = [
        path for path in changed
        if not release_path_allowed(path)
    ]
    if unexpected:
        raise BuildError(f"UNAUTHORIZED_RELEASE_DIFF:{unexpected}")
    return changed


def require_hash(path: Path, expected: str, label: str) -> None:
    if not path.is_file():
        raise BuildError(f"{label}_MISSING:{path.name}")
    actual = sha256_file(path)
    if actual != expected.upper():
        raise BuildError(f"{label}_HASH_MISMATCH:{path.name}:{actual}")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise BuildError(f"JSON_OBJECT_REQUIRED:{path.name}")
    return value


def verify_backend_overlay() -> dict[str, Any]:
    require_hash(BACKEND_PROVENANCE, PINNED_BACKEND_PROVENANCE_SHA256, "BACKEND_PROVENANCE")
    provenance = load_json(BACKEND_PROVENANCE)
    if provenance.get("change_request") != "CR-SVC-20260811-005":
        raise BuildError("BACKEND_PROVENANCE_CR_MISMATCH")
    if provenance.get("overlay_files") != EXPECTED_OVERLAY:
        raise BuildError("BACKEND_PROVENANCE_FILE_SET_MISMATCH")
    for name, expected in EXPECTED_OVERLAY.items():
        require_hash(OVERLAY_ROOT / name, expected, "BACKEND_OVERLAY")
    return provenance


def load_ui_overlay_provenance() -> dict[str, Any]:
    require_hash(UI_PROVENANCE, PINNED_UI_PROVENANCE_SHA256, "UI_PROVENANCE")
    provenance = load_json(UI_PROVENANCE)
    if provenance.get("change_request") != "CR-SVC-20260811-005":
        raise BuildError("UI_PROVENANCE_CR_MISMATCH")
    files = provenance.get("files")
    if not isinstance(files, list):
        raise BuildError("UI_PROVENANCE_FILES_INVALID")
    actual_baseline = {item.get("path"): item.get("baseline_sha256") for item in files}
    actual_overlay = {item.get("path"): item.get("overlay_sha256") for item in files}
    if actual_baseline != EXPECTED_UI_BASELINE or actual_overlay != EXPECTED_UI_OVERLAY:
        raise BuildError("UI_PROVENANCE_FILE_SET_MISMATCH")
    for relative, expected in EXPECTED_UI_OVERLAY.items():
        require_hash(UI_OVERLAY_ROOT / Path(relative), expected, "UI_OVERLAY")
    return provenance


def verify_source_baseline(source_root: Path) -> dict[str, Any]:
    baseline = load_json(SOURCE_BASELINE)
    expected = {item["path"]: item for item in baseline["files"]}
    actual_names = {
        item.name for item in source_root.iterdir()
        if item.is_file() and (item.suffix == ".go" or item.name == "go.mod")
    }
    if actual_names != set(expected):
        raise BuildError(
            f"SOURCE_FILE_SET_MISMATCH:missing={sorted(set(expected)-actual_names)}:"
            f"extra={sorted(actual_names-set(expected))}"
        )
    for name, item in expected.items():
        path = source_root / name
        require_hash(path, item["sha256"], "SOURCE_BASELINE")
        if path.stat().st_size != item["size"]:
            raise BuildError(f"SOURCE_SIZE_MISMATCH:{name}")
    return baseline


def import_packaging_common(source_root: Path) -> Any:
    common_path = source_root / "packaging" / "package_common_180.py"
    policy_path = source_root / "packaging" / "payload_policy_1.8.0.json"
    require_hash(common_path, PINNED_PACKAGE_COMMON_SHA256, "PACKAGE_COMMON")
    require_hash(policy_path, PINNED_PAYLOAD_POLICY_SHA256, "PAYLOAD_POLICY")
    spec = importlib.util.spec_from_file_location("opiu_package_common_180", common_path)
    if spec is None or spec.loader is None:
        raise BuildError("PACKAGE_COMMON_IMPORT_FAILED")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def verify_and_stage_runtime(
    app_root: Path,
    staging_app: Path,
    common: Any,
    policy: dict[str, Any],
) -> tuple[dict[str, str], int, list[str]]:
    staging_app.mkdir(parents=True)
    allowlisted = common.expand_allowlist(app_root, policy)
    for relative, item in allowlisted.items():
        target = staging_app / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(item.data)
    transform_source_paths: list[str] = []
    resolved_app_root = app_root.resolve()
    for transform in policy.get("transforms", []):
        relative = safe_archive_name(str(transform["path"]))
        source = app_root / Path(relative)
        if not source.is_file():
            continue
        if source.is_symlink():
            raise BuildError(f"TRANSFORM_SOURCE_SYMLINK_FORBIDDEN:{relative}")
        try:
            source.resolve().relative_to(resolved_app_root)
        except ValueError as error:
            raise BuildError(f"TRANSFORM_SOURCE_OUTSIDE_ROOT:{relative}") from error
        target = staging_app / Path(relative)
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            transform_source_paths.append(relative)
    result: dict[str, str] = {}
    for relative, expected in RUNTIME_SOURCE_PINS.items():
        source = REPO_ROOT / "development" / "OPIU_1.9.4" / Path(relative)
        require_hash(source, expected, "RUNTIME_SOURCE")
        target = staging_app / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        result[relative] = sha256_file(target)
    return result, len(allowlisted), transform_source_paths


def make_candidate_policy(baseline_policy: dict[str, Any]) -> dict[str, Any]:
    candidate_policy = json.loads(json.dumps(baseline_policy, ensure_ascii=False))
    candidate_policy["source_globs"] = list(candidate_policy["source_globs"]) + [
        "modules/corrections/source/r001_analytical_policy.mjs",
        "modules/corrections/source/r001_handoff_input.mjs",
    ]
    if "transforms" in candidate_policy:
        transforms = candidate_policy["transforms"]
        retained = [
            item for item in transforms
            if not (
                item.get("path") == "web/index.html"
                and item.get("type") == "sanitize_web_index"
            )
        ]
        if len(transforms) - len(retained) != 1:
            raise BuildError("WEB_INDEX_BASELINE_TRANSFORM_NOT_EXACT")
        candidate_policy["transforms"] = retained
    return candidate_policy


def verify_candidate_runtime_tree(staging_app: Path) -> None:
    for relative, expected in RUNTIME_SOURCE_PINS.items():
        require_hash(staging_app / Path(relative), expected, "STAGED_RUNTIME")


def web_hashes(root: Path) -> dict[str, str]:
    web_root = root / "web"
    return {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(web_root.rglob("*")) if path.is_file()
    }


def verify_and_stage_ui_overlay(
    pinned_ui_root: Path,
    staging_app: Path,
    common: Any,
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    load_ui_overlay_provenance()
    baseline_web = web_hashes(pinned_ui_root)
    expected_packaged_web = dict(baseline_web)
    staged_overlay: dict[str, str] = {}
    for relative, baseline_sha256 in EXPECTED_UI_BASELINE.items():
        require_hash(pinned_ui_root / Path(relative), baseline_sha256, "PINNED_UI_BASELINE")
        target = staging_app / Path(relative)
        if relative == "web/index.html":
            sanitized, _audit = common._sanitize_web_index(staging_app)
            if sha256_bytes(sanitized) != baseline_sha256:
                raise BuildError("STAGED_UI_BASELINE_TRANSFORM_MISMATCH:web/index.html")
        else:
            require_hash(target, baseline_sha256, "STAGED_UI_BASELINE")
        overlay = UI_OVERLAY_ROOT / Path(relative)
        expected_overlay_sha256 = EXPECTED_UI_OVERLAY[relative]
        require_hash(overlay, expected_overlay_sha256, "UI_OVERLAY")
        shutil.copy2(overlay, target)
        require_hash(target, expected_overlay_sha256, "STAGED_UI_OVERLAY")
        expected_packaged_web[relative] = expected_overlay_sha256
        staged_overlay[relative] = expected_overlay_sha256
    return baseline_web, expected_packaged_web, staged_overlay


def staging_layout(staging_root: Path) -> tuple[Path, Path]:
    return (
        staging_root / "OPIU_User_Service_Green_0.4.5",
        staging_root / "OPIU_Service_Installer_0.4.5_Source",
    )


def copy_pinned_test_support(
    root: Path,
    relative: str,
    target: Path,
    expected_sha256: str,
) -> None:
    source = root / Path(relative)
    if source.is_symlink():
        raise BuildError(f"GO_TEST_SUPPORT_SYMLINK_FORBIDDEN:{relative}")
    try:
        source.resolve().relative_to(root.resolve())
    except ValueError as error:
        raise BuildError(f"GO_TEST_SUPPORT_OUTSIDE_ROOT:{relative}") from error
    require_hash(source, expected_sha256, "GO_TEST_SUPPORT")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def stage_go_test_support(
    source_root: Path,
    app_root: Path,
    staging_source: Path,
    staging_app: Path,
    ) -> int:
    """Add exactly three pinned legacy fixtures after payload assembly.

    The candidate file map and payload ZIP are already frozen before this call,
    so these fixtures cannot leak into the package.  Full Go tests then run on
    the same minimal exact-overlay source/app layout used for compilation.
    """
    copy_pinned_test_support(
        source_root,
        "build_payload.py",
        staging_source / "build_payload.py",
        GO_TEST_NONPAYLOAD_PINS["build_payload.py"],
    )
    for relative in (
        "web/preview-data-044.js",
        "modules/reconciliation/source/data/reconciliation_decisions.json",
    ):
        copy_pinned_test_support(
            app_root,
            relative,
            staging_app / Path(relative),
            GO_TEST_NONPAYLOAD_PINS[relative],
        )
    forbidden_prefixes = (
        "modules/reconciliation/source/work/",
        "data/runs/", "data/inputs/", "data/outputs/", "data/logs/", "uploads/",
    )
    for path in staging_app.rglob("*"):
        if path.is_file():
            relative = path.relative_to(staging_app).as_posix().lower()
            if any(relative.startswith(prefix) for prefix in forbidden_prefixes):
                raise BuildError(f"GO_TEST_FORBIDDEN_RUNTIME_DATA:{relative}")
    return len(GO_TEST_NONPAYLOAD_PINS)


def go_environment(staging_root: Path) -> tuple[dict[str, str], Path, Path]:
    go_cache = staging_root / "go-cache"
    go_temp = staging_root / "go-temp"
    environment = os.environ.copy()
    environment.update({
        "GOOS": "windows",
        "GOARCH": "amd64",
        "CGO_ENABLED": "0",
        "GOCACHE": str(go_cache),
        "GOTMPDIR": str(go_temp),
    })
    return environment, go_cache, go_temp


def run_checked(
    label: str,
    command: list[str],
    cwd: Path,
    env: dict[str, str] | None = None,
    *,
    include_stdout_hash: bool = True,
) -> dict[str, Any]:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    evidence = {
        "exit_code": result.returncode,
        "stderr_sha256": sha256_bytes(result.stderr.encode("utf-8")),
    }
    if include_stdout_hash or result.returncode != 0:
        evidence["stdout_sha256"] = sha256_bytes(result.stdout.encode("utf-8"))
    if result.returncode != 0:
        raise BuildError(f"{label}_FAILED:{json.dumps(evidence, sort_keys=True)}")
    return evidence


def safe_archive_name(name: str) -> str:
    normalized = PurePosixPath(name.replace("\\", "/"))
    if normalized.is_absolute() or ".." in normalized.parts:
        raise BuildError(f"UNSAFE_RC_ARCHIVE_PATH:{name}")
    return normalized.as_posix()


def retained_rc_documents(rc_zip: Path) -> dict[str, bytes]:
    retained: dict[str, bytes] = {}
    with zipfile.ZipFile(rc_zip) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            safe_name = safe_archive_name(info.filename)
            leaf = PurePosixPath(safe_name).name
            if leaf.lower().endswith(".pdf") or leaf == "README_ПЕРВЫЙ_ЗАПУСК.txt":
                retained[leaf] = archive.read(info)
    if len([name for name in retained if name.lower().endswith(".pdf")]) != 2:
        raise BuildError("PINNED_RC_PDF_SET_INVALID")
    if "README_ПЕРВЫЙ_ЗАПУСК.txt" not in retained:
        raise BuildError("PINNED_RC_README_MISSING")
    return retained


def write_deterministic_outer(files: dict[str, bytes], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, data in sorted(files.items()):
            info = zipfile.ZipInfo(f"{CANDIDATE_NAME}/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.flag_bits |= 0x800
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    temp.replace(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--baseline-app-root", required=True, type=Path)
    parser.add_argument("--pinned-ui-root", required=True, type=Path)
    parser.add_argument("--pinned-rc-zip", required=True, type=Path)
    parser.add_argument("--go-exe", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--integration-head", required=True)
    parser.add_argument("--generated-at", default="2026-08-11T00:00:00Z")
    args = parser.parse_args()

    source_root = args.source_root.resolve()
    app_root = args.baseline_app_root.resolve()
    pinned_ui_root = args.pinned_ui_root.resolve()
    output_root = args.output_root.resolve()
    if output_root.exists():
        raise BuildError(f"OUTPUT_ROOT_ALREADY_EXISTS:{output_root.name}")
    if not app_root.is_dir():
        raise BuildError("BASELINE_APP_ROOT_MISSING")
    if not pinned_ui_root.is_dir():
        raise BuildError("PINNED_UI_ROOT_MISSING")
    if len(args.integration_head) != 40:
        raise BuildError("INTEGRATION_HEAD_MUST_BE_EXACT_SHA")
    if args.integration_head.lower() != current_git_head():
        raise BuildError("INTEGRATION_HEAD_MISMATCH")
    release_diff_paths = verify_source_lineage(args.integration_head)
    require_hash(args.pinned_rc_zip.resolve(), PINNED_RC_SHA256, "PINNED_RC")
    source_baseline = verify_source_baseline(source_root)
    common = import_packaging_common(source_root)
    backend_provenance = verify_backend_overlay()

    staging_root = output_root / "staging"
    staging_app, staging_source = staging_layout(staging_root)
    dist_root = output_root / "dist"
    staging_source.mkdir(parents=True)
    for item in source_baseline["files"]:
        shutil.copy2(source_root / item["path"], staging_source / item["path"])
    for name in EXPECTED_OVERLAY:
        shutil.copy2(OVERLAY_ROOT / name, staging_source / name)

    baseline_policy = load_json(source_root / "packaging" / "payload_policy_1.8.0.json")
    candidate_policy = make_candidate_policy(baseline_policy)
    staged_runtime, raw_allowlisted_file_count, transform_source_paths = verify_and_stage_runtime(
        app_root,
        staging_app,
        common,
        baseline_policy,
    )
    baseline_web, expected_packaged_web, staged_ui_overlay = verify_and_stage_ui_overlay(
        pinned_ui_root,
        staging_app,
        common,
    )
    verify_candidate_runtime_tree(staging_app)
    common.PROTECTED_HASHES["modules/corrections/source/correction_engine_r001.mjs"] = (
        RUNTIME_SOURCE_PINS["modules/corrections/source/correction_engine_r001.mjs"]
    )
    files, payload_manifest = common.assemble_package(
        staging_app,
        candidate_policy,
        args.generated_at,
        windows_runtime_tested=False,
    )
    payload_zip = staging_source / "payload.zip"
    common.write_deterministic_zip(files, payload_zip)
    payload_sha = sha256_file(payload_zip)

    packaged_web = {
        path: sha256_bytes(item.data)
        for path, item in sorted(files.items()) if path.startswith("web/")
    }
    if expected_packaged_web != packaged_web:
        raise BuildError("UI_HASH_SET_NOT_EXACT_PR72")
    if any(".test." in path.lower() for path in files):
        raise BuildError("TEST_FILE_LEAKED_INTO_PAYLOAD")
    for gate, expected in {
        "posting_rows": 0,
        "ready_to_upload": False,
        "release_allowed": False,
    }.items():
        if payload_manifest.get("safety", {}).get(gate) != expected:
            raise BuildError(f"PAYLOAD_SAFETY_GATE_OPEN:{gate}")

    go_env, go_cache, go_temp = go_environment(staging_root)
    go_cache.mkdir(parents=True)
    go_temp.mkdir(parents=True)
    go_test_support_count = stage_go_test_support(
        source_root, app_root, staging_source, staging_app,
    )
    go_test = run_checked(
        "GO_TEST",
        [str(args.go_exe.resolve()), "test", "./..."],
        staging_source,
        go_env,
        include_stdout_hash=False,
    )
    build_args = [
        str(args.go_exe.resolve()), "build", "-trimpath", "-buildvcs=false",
        "-ldflags=-s -w -X main.defaultPortable=true -buildid=",
    ]
    exe_first = staging_root / "build-1.exe"
    exe_second = staging_root / "build-2.exe"
    build_one = run_checked("GO_BUILD_1", [*build_args, "-o", str(exe_first), "."], staging_source, go_env)
    build_two = run_checked("GO_BUILD_2", [*build_args, "-o", str(exe_second), "."], staging_source, go_env)
    exe_sha = sha256_file(exe_first)
    if exe_sha != sha256_file(exe_second):
        raise BuildError("NONDETERMINISTIC_EXE_BUILD")
    source_path_bytes = str(source_root).encode("utf-8")
    source_path_utf16 = str(source_root).encode("utf-16le")
    exe_bytes = exe_first.read_bytes()
    if source_path_bytes in exe_bytes or source_path_utf16 in exe_bytes:
        raise BuildError("BUILD_SOURCE_PATH_LEAKED_INTO_EXE")

    outer_files = retained_rc_documents(args.pinned_rc_zip.resolve())
    outer_files[EXE_NAME] = exe_bytes
    outer_files["PAYLOAD_MANIFEST.json"] = files[candidate_policy["manifest_name"]].data
    outer_files["README_CANDIDATE_REPORT_ONLY.txt"] = (
        "USER_DELIVERY_CANDIDATE 1.9.4\r\n"
        "REPORT_ONLY. posting_rows=0. ready_to_upload=false. release_allowed=false.\r\n"
        "No merge, upload, live 1C, posting, or external release is authorized.\r\n"
    ).encode("utf-8")

    candidate_manifest = {
        "schema_version": "opiu-user-delivery-candidate.v1",
        "candidate": CANDIDATE_NAME,
        "version": "1.9.4",
        "generated_at": args.generated_at,
        "integration_head": args.integration_head.lower(),
        "source_product_head": SOURCE_PRODUCT_HEAD.lower(),
        "build_tooling_head": args.integration_head.lower(),
        "release_diff_paths": release_diff_paths,
        "base_head": PINNED_BASE_HEAD.lower(),
        "integrated_commits": {
            "slot1_product": PINNED_SLOT1_PRODUCT.lower(),
            "slot1_published_head": PINNED_SLOT1_PUBLISHED.lower(),
            "slot2_product": PINNED_SLOT2_PRODUCT.lower(),
            "slot2_published_head": PINNED_SLOT2_PUBLISHED.lower(),
        },
        "pinned_rc": {"sha256": PINNED_RC_SHA256},
        "service_source": {
            "inventory_sha256": sha256_file(SOURCE_BASELINE),
            "file_count": len(source_baseline["files"]),
            "overlay_hashes": EXPECTED_OVERLAY,
            "overlay_provenance_sha256": sha256_file(BACKEND_PROVENANCE),
            "overlay_change_request": backend_provenance["change_request"],
        },
        "runtime_source_pins": staged_runtime,
        "payload": {
            "sha256": payload_sha,
            "manifest_sha256": sha256_bytes(files[candidate_policy["manifest_name"]].data),
            "file_count": len(files),
            "raw_allowlisted_file_count": raw_allowlisted_file_count,
            "transform_source_file_count": len(transform_source_paths),
            "transform_source_paths": transform_source_paths,
            "security_scan": "PASS_WITH_EXACT_BASELINE_APPROVALS",
        },
        "executable": {
            "name": EXE_NAME,
            "sha256": exe_sha,
            "deterministic_double_build": True,
            "source_path_leak": False,
        },
        "ui": {
            "changed_files": len(staged_ui_overlay),
            "overlay_change_request": "CR-SVC-20260811-005",
            "overlay_provenance_sha256": sha256_file(UI_PROVENANCE),
            "overlay_hashes": staged_ui_overlay,
            "baseline_overlay_hashes": EXPECTED_UI_BASELINE,
            "baseline_hash_set_sha256": sha256_bytes(canonical_json(baseline_web)),
            "packaged_hash_set_sha256": sha256_bytes(canonical_json(packaged_web)),
            "hashes": packaged_web,
        },
        "qa": {
            "go_test_scope": "MINIMAL_CANDIDATE_STAGING_PLUS_3_PINNED_FIXTURES",
            "go_test_support_file_count": go_test_support_count,
            "go_test_forbidden_runtime_data_files": 0,
            "candidate_build_scope": "ALLOWLIST_CLEAN_STAGING",
            "go_test": go_test,
            "go_build_1": build_one,
            "go_build_2": build_two,
        },
        "safety": {
            "mode": "REPORT_ONLY",
            "report_only": True,
            "independent_qa_status": "INDEPENDENT_QA_PENDING",
            "posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": False,
            "live_1c_allowed": False,
            "external_release_allowed": False,
        },
    }
    outer_files["USER_DELIVERY_CANDIDATE_MANIFEST.json"] = canonical_json(candidate_manifest)
    sums = [f"{sha256_bytes(data)} *{name}" for name, data in sorted(outer_files.items())]
    outer_files["SHA256SUMS.txt"] = ("\r\n".join(sums) + "\r\n").encode("utf-8")

    candidate_zip = dist_root / f"{CANDIDATE_NAME}.zip"
    write_deterministic_outer(outer_files, candidate_zip)
    candidate_zip_second = staging_root / "outer-second.zip"
    write_deterministic_outer(outer_files, candidate_zip_second)
    if sha256_file(candidate_zip) != sha256_file(candidate_zip_second):
        raise BuildError("NONDETERMINISTIC_OUTER_ZIP")
    sidecar_manifest = dist_root / "USER_DELIVERY_CANDIDATE_MANIFEST.json"
    sidecar_manifest.write_bytes(canonical_json(candidate_manifest))
    result = {
        "status": "PASS",
        "candidate_zip": str(candidate_zip),
        "candidate_zip_sha256": sha256_file(candidate_zip),
        "candidate_manifest": str(sidecar_manifest),
        "candidate_manifest_sha256": sha256_file(sidecar_manifest),
        "payload_sha256": payload_sha,
        "executable_sha256": exe_sha,
        "source_product_head": SOURCE_PRODUCT_HEAD.lower(),
        "build_tooling_head": args.integration_head.lower(),
        "ui_changed_files": len(staged_ui_overlay),
        "payload_file_count": len(files),
        "safety": candidate_manifest["safety"],
    }
    (dist_root / "BUILD_RESULT.json").write_bytes(canonical_json(result))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (BuildError, OSError, ValueError, zipfile.BadZipFile) as error:
        raise SystemExit(str(error)) from error
