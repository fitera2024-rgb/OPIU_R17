from __future__ import annotations

import copy
import importlib.util
import json
import os
import tempfile
import zipfile
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("verify_r17_portable.py")
SPEC = importlib.util.spec_from_file_location("r17_portable_verifier", SCRIPT)
VERIFIER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFIER)

POLICY_SHA = "A" * 64
SOURCE_HEAD = "b" * 40


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def synthetic_policy() -> dict[str, object]:
    policy = copy.deepcopy(VERIFIER.load_policy())
    contract = b"synthetic canonical contract"
    setting_a = "инструкция".encode("utf-8")
    setting_b = "группа;значение\r\n".encode("utf-8")
    exception_data = b"runneradmin D:\\a\\"
    policy["contract"]["sha256"] = VERIFIER.sha256_bytes(contract)
    policy["unicode_settings"] = [
        {"path": "user-settings/КАК_НАСТРОИТЬ_ГРУППИРОВКУ.txt", "sha256": VERIFIER.sha256_bytes(setting_a)},
        {"path": "user-settings/Настройка_группировки_блоков.csv", "sha256": VERIFIER.sha256_bytes(setting_b)},
    ]
    policy["privacy"]["allowed_upstream_debug_exception"].update({
        "size": len(exception_data), "sha256": VERIFIER.sha256_bytes(exception_data),
        "runneradmin_hits": 1, "d_drive_a_hits": 1,
    })
    node = b"synthetic-node"
    node_row = [{"path": "node.exe", "size": len(node), "sha256": VERIFIER.sha256_bytes(node)}]
    node_inventory = VERIFIER.inventory_record({"node.exe": node})
    policy["toolchains"]["node"].update({
        "node_exe_sha256": VERIFIER.sha256_bytes(node), "node_exe_size": len(node),
        "file_count": 1, "inventory_sha256": node_inventory["inventory_sha256"],
    })
    module_payloads = {
        "jszip/package.json": json_bytes({"version": "3.10.1"}),
        "@oai/artifact-tool/package.json": json_bytes({"version": "2.8.31"}),
        "@oai/artifact-tool/node_modules/skia-canvas/package.json": json_bytes({"version": "3.0.8"}),
        "@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node": exception_data,
    }
    modules_inventory = VERIFIER.inventory_record(module_payloads)
    policy["toolchains"]["node_modules"].update({
        "file_count": modules_inventory["file_count"], "total_size": modules_inventory["total_size"],
        "inventory_sha256": modules_inventory["inventory_sha256"],
    })
    policy["_fixture"] = {
        "contract": contract, "setting_a": setting_a, "setting_b": setting_b,
        "exception": exception_data, "node": node, "modules": module_payloads,
    }
    return policy


def audit_evidence(policy: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    privacy = {
        "local_customer_build_paths_absent": True, "local_customer_build_path_hits": 0,
        "only_allowed_upstream_debug_exception_present": True,
        "allowed_upstream_debug_exception": {
            "path": policy["privacy"]["allowed_upstream_debug_exception"]["path"],
            "size": policy["privacy"]["allowed_upstream_debug_exception"]["size"],
            "sha256": policy["privacy"]["allowed_upstream_debug_exception"]["sha256"],
            "username_occurrences": policy["privacy"]["allowed_upstream_debug_exception"]["runneradmin_hits"],
            "debug_root_occurrences": policy["privacy"]["allowed_upstream_debug_exception"]["d_drive_a_hits"],
        },
        "whole_zip_user_profile_path_free": False,
    }
    legacy = {
        "status": "PASS", "rules_service": False, "violations": 0,
        "immutable_r001_exception": policy["legacy_rules_gate"]["immutable_r001_exception"],
    }
    return privacy, legacy


def rebuild_manifests(payloads: dict[str, bytes], policy: dict[str, object]) -> None:
    privacy, legacy = audit_evidence(policy)
    runtime_record = VERIFIER.inventory_record(payloads, prefix="runtime/", excluded=("runtime/MANIFEST.json",))
    payloads["runtime/MANIFEST.json"] = json_bytes({
        "schema_version": VERIFIER.RUNTIME_SCHEMA, "source_head": SOURCE_HEAD,
        "policy_sha256": POLICY_SHA, "safety": policy["safety"], "rules_service": False,
        "legacy_rules_gate": legacy, **runtime_record,
    })
    if "R17_BUILD_PROVENANCE.json" not in payloads:
        service = payloads["OPIU_R17.exe"]
        go_policy = policy["toolchains"]["go"]
        payloads["R17_BUILD_PROVENANCE.json"] = json_bytes({
            "schema_version": VERIFIER.PROVENANCE_SCHEMA, "source_head": SOURCE_HEAD,
            "policy_sha256": POLICY_SHA, "candidate_status": "REPORT_ONLY_ARCH_GATED",
            "release_approved": False, "safety": policy["safety"],
            "production_runtime_modified": False, "independent_complete_build": True,
            "go_build": {
                "toolchain": {
                    "version": go_policy["version"], "platform": go_policy["platform"],
                    "go_exe_sha256": go_policy["go_exe_sha256"],
                    "toolchain_file_count": go_policy["file_count"],
                    "toolchain_inventory_sha256": go_policy["inventory_sha256"],
                },
                "go_test_passed": True, "deterministic_double_build": True,
                "first_sha256": VERIFIER.sha256_bytes(service),
                "second_sha256": VERIFIER.sha256_bytes(service), "size": len(service),
            },
            "privacy": privacy, "legacy_rules_gate": legacy,
        })
    package_record = VERIFIER.inventory_record(payloads, excluded=("R17_PACKAGE_MANIFEST.json",))
    payloads["R17_PACKAGE_MANIFEST.json"] = json_bytes({
        "schema_version": VERIFIER.PACKAGE_SCHEMA, "archive_name": policy["archive_name"],
        "archive_root": policy["archive_root"], "executable_name": policy["executable_name"],
        "source_head": SOURCE_HEAD, "policy_sha256": POLICY_SHA,
        "candidate_status": "REPORT_ONLY_ARCH_GATED", "release_approved": False,
        "safety": policy["safety"], "privacy": privacy, "legacy_rules_gate": legacy,
        "contract": policy["contract"], "unicode_settings": policy["unicode_settings"],
        "toolchains": policy["toolchains"], "self_excluded_from_inventory": True,
        **package_record,
    })


def valid_payloads(policy: dict[str, object]) -> dict[str, bytes]:
    fixture = policy.pop("_fixture")
    payloads = {
        "OPIU_R17.exe": b"MZ synthetic service",
        "runtime/node/node.exe": fixture["node"],
        "runtime/modules/corrections/source/safe.mjs": b"export const reportOnly = true;\n",
        policy["contract"]["package_path"]: fixture["contract"],
        policy["unicode_settings"][0]["path"]: fixture["setting_a"],
        policy["unicode_settings"][1]["path"]: fixture["setting_b"],
        "runtime/SAFETY.json": json_bytes(policy["safety"]),
        "CONTRACT_SHA256.txt": (
            f"{policy['contract']['sha256']} *{policy['contract']['package_path']}\r\n".encode("ascii")
        ),
        "README_RU.txt": "Переносимый пакет REPORT_ONLY".encode("utf-8"),
    }
    for relative, data in fixture["modules"].items():
        payloads[f"runtime/node_modules/{relative}"] = data
    rebuild_manifests(payloads, policy)
    return payloads


def write_archive(
    path: Path, payloads: dict[str, bytes], policy: dict[str, object], *,
    timestamp_override: tuple[int, int, int, int, int, int] | None = None,
    mode_override: dict[str, int] | None = None, extra_entries: dict[str, bytes] | None = None,
) -> None:
    entries = {f"{policy['archive_root']}/{relative}": data for relative, data in payloads.items()}
    entries.update(extra_entries or {})
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            relative = name.split("/", 1)[1] if "/" in name else name
            info = zipfile.ZipInfo(name, timestamp_override or tuple(policy["fixed_zip_time"]))
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o100755 if relative in {
                policy["executable_name"], policy["toolchains"]["node"]["package_path"],
            } else 0o100644
            if mode_override and relative in mode_override:
                mode = mode_override[relative]
            info.external_attr = mode << 16
            info.create_system = 3
            archive.writestr(info, entries[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def make_valid(root: Path) -> tuple[Path, dict[str, object], dict[str, bytes]]:
    policy = synthetic_policy()
    payloads = valid_payloads(policy)
    archive = root / "OPIU_R17.zip"
    write_archive(archive, payloads, policy)
    return archive, policy, payloads


def test_verifier_is_independent_of_the_builder_and_existing_packaging_base() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "build_r17_portable" not in source
    assert "build_clean_source_service_candidate" not in source


def test_positive_static_verification_and_identical_pair() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        archive, policy, payloads = make_valid(root / "A")
        report = VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)
        assert report["status"] == "PASS_REPORT_ONLY_CANDIDATE"
        assert report["privacy"]["whole_zip_user_profile_path_free"] is False
        second = root / "B" / "OPIU_R17.zip"
        write_archive(second, payloads, policy)
        pair = VERIFIER.verify_pair(archive, second, policy, policy_sha256=POLICY_SHA)
        assert pair["byte_identical"] is True
        assert pair["release_approved"] is False


@pytest.mark.parametrize("mutation", ["contract", "unicode", "safety", "privacy", "toolchain"])
def test_manifest_and_payload_mutations_fail_closed(mutation: str) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        if mutation == "contract":
            payloads[policy["contract"]["package_path"]] += b"tamper"
        elif mutation == "unicode":
            payloads[policy["unicode_settings"][0]["path"]] += b"tamper"
        elif mutation == "safety":
            opened = copy.deepcopy(policy["safety"])
            opened["release_allowed"] = True
            payloads["runtime/SAFETY.json"] = json_bytes(opened)
        elif mutation == "privacy":
            manifest = json.loads(payloads["R17_PACKAGE_MANIFEST.json"])
            manifest["privacy"]["whole_zip_user_profile_path_free"] = True
            payloads["R17_PACKAGE_MANIFEST.json"] = json_bytes(manifest)
        else:
            manifest = json.loads(payloads["R17_PACKAGE_MANIFEST.json"])
            manifest["toolchains"]["node"]["version_line"] = "v0.0.0"
            payloads["R17_PACKAGE_MANIFEST.json"] = json_bytes(manifest)
        archive = root / mutation / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_legacy_rules_runtime_mutation_is_rejected_even_with_honest_inventories() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        payloads["runtime/modules/corrections/source/safe.mjs"] = b'export const env = "OPIU_RULES_CMD_JSON";\n'
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        archive = root / "legacy" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match="LEGACY_RULES_GATE_BLOCKED"):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


@pytest.mark.parametrize("kind", ["traversal", "casefold", "collision", "timestamp", "mode"])
def test_zip_structure_mutations_are_rejected(kind: str) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        archive = root / kind / "OPIU_R17.zip"
        kwargs = {}
        if kind == "traversal":
            kwargs["extra_entries"] = {"OPIU_R17/../escape.txt": b"x"}
        elif kind == "casefold":
            kwargs["extra_entries"] = {"OPIU_R17/readme_ru.TXT": b"x"}
        elif kind == "collision":
            kwargs["extra_entries"] = {"OPIU_R17/runtime": b"x"}
        elif kind == "timestamp":
            kwargs["timestamp_override"] = (2026, 8, 26, 0, 0, 0)
        else:
            kwargs["mode_override"] = {"README_RU.txt": 0o100755}
        write_archive(archive, payloads, policy, **kwargs)
        with pytest.raises(VERIFIER.VerificationError):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_pair_rejects_two_individually_valid_but_different_archives() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        first, policy, payloads = make_valid(root / "A")
        payloads["README_RU.txt"] += b"\nsecond build drift"
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        second = root / "B" / "OPIU_R17.zip"
        write_archive(second, payloads, policy)
        assert VERIFIER.verify_archive(second, policy, policy_sha256=POLICY_SHA)["status"].startswith("PASS")
        with pytest.raises(VERIFIER.VerificationError, match="INDEPENDENT_ARCHIVES_NOT_BYTE_IDENTICAL"):
            VERIFIER.verify_pair(first, second, policy, policy_sha256=POLICY_SHA)


@pytest.mark.skipif(os.name != "nt", reason="Windows integration")
def test_full_path_budget_is_checked_against_c_short_root() -> None:
    policy = synthetic_policy()
    policy.pop("_fixture")
    tightened = copy.deepcopy(policy)
    tightened["path_limits"]["full_path_max"] = 30
    with pytest.raises(VERIFIER.VerificationError, match="ARCHIVE_FULL_PATH_TOO_LONG"):
        VERIFIER.validate_relative_path("runtime/file.txt", tightened)
