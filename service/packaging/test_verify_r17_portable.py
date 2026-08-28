from __future__ import annotations

import copy
import hashlib
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
BUILDER_SCRIPT = Path(__file__).with_name("build_r17_portable.py")
BUILDER_SPEC = importlib.util.spec_from_file_location("r17_portable_builder_for_e2e", BUILDER_SCRIPT)
BUILDER = importlib.util.module_from_spec(BUILDER_SPEC)
assert BUILDER_SPEC.loader is not None
BUILDER_SPEC.loader.exec_module(BUILDER)

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
    organizations = json_bytes({
        "schema_version": "opiu-organizations.v1", "source": {}, "nodes": [],
    })
    policy["runtime_exact_files"][0].update({
        "size": len(organizations), "sha256": VERIFIER.sha256_bytes(organizations),
    })
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
        "organizations": organizations,
    }
    return policy


def audit_evidence(policy: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    privacy = {
        "local_customer_build_paths_absent": True, "local_customer_build_path_hits": 0,
        "exact_inventory_node_modules_generic_profile_scan_exempt": True,
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


def git_blob_row(path: str, data: bytes) -> dict[str, object]:
    digest = hashlib.sha1()
    digest.update(f"blob {len(data)}\0".encode("ascii"))
    digest.update(data)
    return {
        "path": path, "size": len(data), "sha256": VERIFIER.sha256_bytes(data),
        "git_blob": digest.hexdigest(), "git_mode": "100644",
    }


def source_binding(payloads: dict[str, bytes], policy: dict[str, object]) -> dict[str, object]:
    service_rows = [git_blob_row("service/source/main.go", b"package main\nfunc main() {}\n")]
    runtime_rows = [
        git_blob_row(path.removeprefix("runtime/"), data)
        for path, data in payloads.items()
        if any(
            path.startswith("runtime/" + root.rstrip("/") + "/")
            for root in policy["runtime_source_roots"]
        )
    ]
    bound_rows = [
        git_blob_row(policy["contract"]["source"], payloads[policy["contract"]["package_path"]]),
        *(
            git_blob_row(row["path"], payloads[row["path"]])
            for row in policy["unicode_settings"]
        ),
    ]
    complete_rows = service_rows + runtime_rows + bound_rows
    runtime_record = VERIFIER._git_inventory_record_from_rows(runtime_rows)
    service_record = VERIFIER._git_inventory_record_from_rows(service_rows)
    complete_record = VERIFIER._git_inventory_record_from_rows(complete_rows)
    complete_record.update({
        "source_head": SOURCE_HEAD, "git_object_format": "sha1",
        "scopes": VERIFIER._source_scope_paths(policy),
        "exact_git_blobs": True, "ignored_injection_checked": True,
    })
    return {
        "status": "EXACT_GIT_BLOB_EXTRACTION", **runtime_record,
        "service_source": service_record, "complete_source_scope": complete_record,
    }


def rebuild_manifests(
    payloads: dict[str, bytes], policy: dict[str, object], *,
    closure_override: dict[str, object] | None = None,
) -> None:
    privacy, legacy = audit_evidence(policy)
    dependency_closure = (
        closure_override
        if closure_override is not None
        else VERIFIER.verify_runtime_dependency_closure(payloads)
    )
    binding = source_binding(payloads, policy)
    runtime_record = VERIFIER.inventory_record(payloads, prefix="runtime/", excluded=("runtime/MANIFEST.json",))
    payloads["runtime/MANIFEST.json"] = json_bytes({
        "schema_version": VERIFIER.RUNTIME_SCHEMA, "source_head": SOURCE_HEAD,
        "policy_sha256": POLICY_SHA, "safety": policy["safety"], "rules_service": False,
        "legacy_rules_gate": legacy, "dependency_closure": dependency_closure,
        "runtime_exact_files": policy["runtime_exact_files"], **runtime_record,
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
            "dependency_closure": dependency_closure,
            "runtime_exact_files": policy["runtime_exact_files"],
            "source_binding": binding,
        })
    package_record = VERIFIER.inventory_record(payloads, excluded=("R17_PACKAGE_MANIFEST.json",))
    payloads["R17_PACKAGE_MANIFEST.json"] = json_bytes({
        "schema_version": VERIFIER.PACKAGE_SCHEMA, "archive_name": policy["archive_name"],
        "archive_root": policy["archive_root"], "executable_name": policy["executable_name"],
        "source_head": SOURCE_HEAD, "policy_sha256": POLICY_SHA,
        "candidate_status": "REPORT_ONLY_ARCH_GATED", "release_approved": False,
        "safety": policy["safety"], "privacy": privacy, "legacy_rules_gate": legacy,
        "dependency_closure": dependency_closure,
        "contract": policy["contract"], "unicode_settings": policy["unicode_settings"],
        "runtime_exact_files": policy["runtime_exact_files"],
        "toolchains": policy["toolchains"], "self_excluded_from_inventory": True,
        **package_record,
    })


def valid_payloads(policy: dict[str, object]) -> dict[str, bytes]:
    fixture = policy.pop("_fixture")
    payloads = {
        "OPIU_R17.exe": b"MZ synthetic service",
        "runtime/node/node.exe": fixture["node"],
        "runtime/modules/corrections/source/safe.mjs": (
            b'import {reportOnly} from "./dependency.mjs";\nexport {reportOnly};\n'
        ),
        "runtime/modules/corrections/source/dependency.mjs": b"export const reportOnly = true;\n",
        "runtime/data/defaults/organizations.json": fixture["organizations"],
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


@pytest.mark.parametrize("mutation", ["rules_token", "rules_fragment", "organizations_binding", "component", "relative", "full"])
def test_canonical_policy_value_set_is_immutable(mutation: str) -> None:
    policy = VERIFIER.load_policy()
    changed = copy.deepcopy(policy)
    if mutation == "rules_token":
        changed["legacy_rules_gate"]["forbidden_tokens"]["env"].clear()
    elif mutation == "rules_fragment":
        changed["legacy_rules_gate"]["forbidden_package_path_fragments"].pop()
    elif mutation == "organizations_binding":
        changed["runtime_exact_files"][0]["sha256"] = "0" * 64
    else:
        key = {"component": "component_max", "relative": "relative_max", "full": "full_path_max"}[mutation]
        changed["path_limits"][key] += 1
    with pytest.raises(VERIFIER.VerificationError, match="POLICY_VALUE_SET_NOT_EXACT"):
        VERIFIER.validate_policy(changed)


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


def test_builder_closure_round_trips_through_independent_verifier_with_real_import() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        policy = synthetic_policy()
        payloads = valid_payloads(policy)
        runtime = root / "runtime"
        for relative, data in payloads.items():
            if not relative.startswith("runtime/"):
                continue
            target = runtime / Path(relative.removeprefix("runtime/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        builder_closure = BUILDER.verify_runtime_dependency_closure(runtime)
        verifier_closure = VERIFIER.verify_runtime_dependency_closure(payloads)
        assert builder_closure == verifier_closure == {
            "status": "PASS", "logical_root": "runtime",
            "edge_paths": "POSIX_RELATIVE_TO_LOGICAL_ROOT",
            "excluded_exact_inventory_roots": ["node_modules"],
            "relative_dependency_count": 1,
            "edges": [{
                "source": "modules/corrections/source/safe.mjs",
                "specifier": "./dependency.mjs",
                "target": "modules/corrections/source/dependency.mjs",
            }],
        }
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy, closure_override=builder_closure)
        archive = root / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        binding_sha = json.loads(payloads["R17_BUILD_PROVENANCE.json"])[
            "source_binding"
        ]["complete_source_scope"]["inventory_sha256"]
        report = BUILDER.verify_with_independent_verifier(
            archive, policy, POLICY_SHA, SOURCE_HEAD, binding_sha,
        )
        assert report["dependency_closure"] == builder_closure
        assert report["source_binding"]["inventory_sha256"] == binding_sha

        forged_closure = copy.deepcopy(builder_closure)
        forged_closure["edges"][0]["source"] = "runtime/modules/corrections/source/safe.mjs"
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy, closure_override=forged_closure)
        rejected = root / "rejected" / "OPIU_R17.zip"
        write_archive(rejected, payloads, policy)
        rejected_binding_sha = json.loads(payloads["R17_BUILD_PROVENANCE.json"])[
            "source_binding"
        ]["complete_source_scope"]["inventory_sha256"]
        with pytest.raises(BUILDER.BuildError, match="INDEPENDENT_ARCHIVE_VERIFICATION_FAILED"):
            BUILDER.verify_with_independent_verifier(
                rejected, policy, POLICY_SHA, SOURCE_HEAD, rejected_binding_sha,
            )


def test_builder_and_verifier_accept_existing_directory_url() -> None:
    with tempfile.TemporaryDirectory() as raw:
        runtime = Path(raw) / "runtime"
        source = runtime / "modules/pkg/wasm/native.js"
        source.parent.mkdir(parents=True)
        source.write_text('const base = new URL("./", import.meta.url);\n', encoding="utf-8")
        payloads = {
            "runtime/modules/pkg/wasm/native.js": source.read_bytes(),
        }
        assert BUILDER.verify_runtime_dependency_closure(runtime) == VERIFIER.verify_runtime_dependency_closure(payloads)


@pytest.mark.parametrize("mutation", ["contract", "unicode", "organizations", "safety", "privacy", "toolchain"])
def test_manifest_and_payload_mutations_fail_closed(mutation: str) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        if mutation == "contract":
            payloads[policy["contract"]["package_path"]] += b"tamper"
        elif mutation == "unicode":
            payloads[policy["unicode_settings"][0]["path"]] += b"tamper"
        elif mutation == "organizations":
            payloads[policy["runtime_exact_files"][0]["package_path"]] += b"tamper"
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


@pytest.mark.parametrize(
    ("mutation", "expected"),
    [
        ("missing", "RUNTIME_EXACT_FILE_MISSING"),
        ("tampered", "RUNTIME_EXACT_FILE_SHA256_MISMATCH"),
    ],
)
def test_required_organizations_missing_or_tampered_is_rejected_with_honest_inventories(
    mutation: str, expected: str,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        path = policy["runtime_exact_files"][0]["package_path"]
        if mutation == "missing":
            payloads.pop(path)
        else:
            original = payloads[path]
            payloads[path] = bytes([original[0] ^ 1]) + original[1:]
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        archive = root / mutation / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match=expected):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_runtime_exact_file_binding_claim_must_match_policy() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        manifest = json.loads(payloads["R17_PACKAGE_MANIFEST.json"])
        manifest["runtime_exact_files"] = []
        payloads["R17_PACKAGE_MANIFEST.json"] = json_bytes(manifest)
        archive = root / "binding" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match="RUNTIME_EXACT_FILE_BINDING_MISMATCH"):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_legacy_rules_defaults_remain_forbidden_after_organizations_catalog_returns() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        payloads["runtime/data/defaults/rules.json"] = b"{}\n"
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        archive = root / "rules-defaults" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match="LEGACY_RULES_GATE_BLOCKED"):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_missing_relative_import_is_rejected_with_honest_inventories() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        claimed_closure = json.loads(payloads["runtime/MANIFEST.json"])["dependency_closure"]
        payloads.pop("runtime/modules/corrections/source/dependency.mjs")
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy, closure_override=claimed_closure)
        archive = root / "missing-import" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match="RUNTIME_RELATIVE_IMPORT_MISSING"):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


@pytest.mark.parametrize(
    "mutation", ["missing", "forged_count", "forged_inventory", "forged_source_head"],
)
def test_missing_or_forged_provenance_source_binding_is_rejected(mutation: str) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        provenance = json.loads(payloads["R17_BUILD_PROVENANCE.json"])
        if mutation == "missing":
            provenance.pop("source_binding")
            message = "SOURCE_BINDING_MISSING_OR_STATUS_INVALID"
        elif mutation == "forged_count":
            provenance["source_binding"]["complete_source_scope"]["file_count"] += 1
            message = "SOURCE_BINDING_INVENTORY_MISMATCH"
        elif mutation == "forged_inventory":
            provenance["source_binding"]["complete_source_scope"]["inventory_sha256"] = "F" * 64
            message = "SOURCE_BINDING_INVENTORY_MISMATCH"
        else:
            provenance["source_binding"]["complete_source_scope"]["source_head"] = "c" * 40
            message = "SOURCE_BINDING_COMPLETE_CLAIMS_INVALID"
        payloads["R17_BUILD_PROVENANCE.json"] = json_bytes(provenance)
        rebuild_manifests(payloads, policy)
        archive = root / mutation / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match=message):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"expected_source_head": "c" * 40}, "EXPECTED_SOURCE_HEAD_MISMATCH"),
        ({"expected_source_inventory_sha256": "F" * 64}, "SOURCE_BINDING_EXPECTED_INVENTORY_MISMATCH"),
    ],
)
def test_expected_source_head_and_inventory_bindings_are_enforced(
    kwargs: dict[str, str], message: str,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        archive, policy, _ = make_valid(Path(raw))
        with pytest.raises(VERIFIER.VerificationError, match=message):
            VERIFIER.verify_archive(
                archive, policy, policy_sha256=POLICY_SHA, **kwargs,
            )


def test_self_consistent_forged_git_inventory_is_rejected_against_expected_binding() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        provenance = json.loads(payloads["R17_BUILD_PROVENANCE.json"])
        binding = provenance["source_binding"]
        complete = binding["complete_source_scope"]
        expected_inventory = complete["inventory_sha256"]
        forged_service_row = git_blob_row("service/source/main.go", b"package main\n// forged\n")
        service_record = VERIFIER._git_inventory_record_from_rows([forged_service_row])
        complete_rows = [
            forged_service_row if row["path"] == "service/source/main.go" else row
            for row in complete["files"]
        ]
        complete_record = VERIFIER._git_inventory_record_from_rows(complete_rows)
        for field in ("file_count", "total_size", "inventory_sha256", "files"):
            binding["service_source"][field] = service_record[field]
            complete[field] = complete_record[field]
        payloads["R17_BUILD_PROVENANCE.json"] = json_bytes(provenance)
        rebuild_manifests(payloads, policy)
        archive = root / "forged" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(
            VERIFIER.VerificationError, match="SOURCE_BINDING_EXPECTED_INVENTORY_MISMATCH",
        ):
            VERIFIER.verify_archive(
                archive, policy, policy_sha256=POLICY_SHA,
                expected_source_head=SOURCE_HEAD,
                expected_source_inventory_sha256=expected_inventory,
            )


def test_utf16be_local_profile_path_is_rejected_with_honest_inventories() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        payloads["runtime/privacy.bin"] = "C:\\Users\\NB-FIT\\build".encode("utf-16-be")
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        archive = root / "utf16be" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_privacy_generic_profile_scan_exempts_only_exact_inventory_node_modules() -> None:
    policy = synthetic_policy()
    exception = policy["privacy"]["allowed_upstream_debug_exception"]
    payloads = {
        exception["path"]: policy["_fixture"]["exception"],
        "runtime/node_modules/pkg/virtual.js": b'const home = "/home/web_user";\n',
    }
    evidence = VERIFIER._verify_privacy(payloads, policy)
    assert evidence["exact_inventory_node_modules_generic_profile_scan_exempt"] is True
    payloads["runtime/modules/reconciliation/source/leak.mjs"] = b'const home = "/home/customer";\n'
    with pytest.raises(VERIFIER.VerificationError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
        VERIFIER._verify_privacy(payloads, policy)


@pytest.mark.parametrize(
    ("path", "message"),
    [
        ("runtime/node/extra.dll", "RUNTIME_NODE_FILE_SET_INVALID"),
        ("user-settings/╨Ъ╨Р╨Ъ_╨Э╨Р╨б╨в╨а╨Ю╨Ш╨в╨м.txt", "UNICODE_SETTINGS_FILE_SET_INVALID"),
    ],
)
def test_extra_node_sibling_or_mojibake_setting_is_rejected_with_honest_inventories(
    path: str, message: str,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _, policy, payloads = make_valid(root / "seed")
        payloads[path] = b"honestly inventoried injection"
        payloads.pop("R17_BUILD_PROVENANCE.json")
        rebuild_manifests(payloads, policy)
        archive = root / "extra" / "OPIU_R17.zip"
        write_archive(archive, payloads, policy)
        with pytest.raises(VERIFIER.VerificationError, match=message):
            VERIFIER.verify_archive(archive, policy, policy_sha256=POLICY_SHA)


def test_relocation_smoke_api_fails_closed_for_synthetic_non_executables(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        archive, policy, _ = make_valid(Path(raw))
        expected = "SMOKE_NODE_VERSION_FAILED" if os.name == "nt" else "SMOKE_WINDOWS_REQUIRED"
        if os.name == "nt":
            def forbidden_run(*_args: object, **_kwargs: object) -> None:
                raise AssertionError("invalid PE must be rejected before subprocess.run")

            monkeypatch.setattr(VERIFIER.subprocess, "run", forbidden_run)
        with pytest.raises(VERIFIER.VerificationError, match=expected):
            VERIFIER.verify_archive(
                archive, policy, policy_sha256=POLICY_SHA, run_smoke=True,
                smoke_parent=Path(raw) / "relocated", smoke_timeout=2.0,
            )


@pytest.mark.skipif(os.name != "nt", reason="Windows PE guard")
def test_windows_amd64_executable_guard_rejects_truncated_headers() -> None:
    with tempfile.TemporaryDirectory() as raw:
        executable = Path(raw) / "truncated.exe"
        payload = bytearray(90)
        payload[:2] = b"MZ"
        payload[60:64] = (64).to_bytes(4, "little")
        payload[64:68] = b"PE\0\0"
        payload[68:70] = (0x8664).to_bytes(2, "little")
        payload[70:72] = (1).to_bytes(2, "little")
        payload[84:86] = (112).to_bytes(2, "little")
        payload[86:88] = (0x0002).to_bytes(2, "little")
        payload[88:90] = (0x20B).to_bytes(2, "little")
        executable.write_bytes(payload)

        with pytest.raises(VERIFIER.VerificationError, match="TRUNCATED_PE"):
            VERIFIER._assert_windows_amd64_executable(executable, "TRUNCATED_PE")


@pytest.mark.skipif(os.name != "nt", reason="Windows relocation smoke")
def test_relocation_smoke_rejects_invalid_service_before_popen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        archive, policy, _ = make_valid(root)
        checked: list[str] = []

        def fake_guard(_path: Path, error_code: str) -> None:
            checked.append(error_code)
            if error_code == "SMOKE_SERVICE_START_FAILED":
                raise VERIFIER.VerificationError(error_code)

        def fake_run(command: list[str], **_kwargs: object) -> object:
            stdout = (
                policy["toolchains"]["node"]["version_line"] + "\n"
                if "--version" in command
                else "NODE_RUNTIME_LOAD_AND_CANVAS_PASS"
            )
            return VERIFIER.subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

        def forbidden_popen(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("invalid Service PE must be rejected before subprocess.Popen")

        monkeypatch.setattr(VERIFIER, "_assert_windows_amd64_executable", fake_guard)
        monkeypatch.setattr(VERIFIER.subprocess, "run", fake_run)
        monkeypatch.setattr(VERIFIER.subprocess, "Popen", forbidden_popen)

        with pytest.raises(VERIFIER.VerificationError, match="SMOKE_SERVICE_START_FAILED"):
            VERIFIER.verify_archive(
                archive, policy, policy_sha256=POLICY_SHA, run_smoke=True,
                smoke_parent=root / "relocated", smoke_timeout=2.0,
            )
        assert checked == ["SMOKE_NODE_VERSION_FAILED", "SMOKE_SERVICE_START_FAILED"]


def test_synthetic_smoke_api_requires_two_distinct_relocation_roots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        archive, policy, _ = make_valid(root)
        parents: list[Path | None] = []

        def fake_smoke(
            _archive: Path, _policy: dict[str, object], *,
            smoke_parent: Path | None, timeout: float,
        ) -> dict[str, object]:
            assert timeout == 3.0
            parents.append(smoke_parent)
            return {
                "status": "PASS", "relocated": True, "node_version_verified": True,
                "jszip_loaded": True, "artifact_tool_loaded": True,
                "skia_canvas_loaded": True, "skia_canvas_constructed": True,
                "health_verified": True, "bootstrap_verified": True,
                "organizations_verified": True,
                "port_released": True, "all_outputs_under_extracted_root": True,
                "output_file_count": 1, "localhost_only": True,
                "release_approved": False,
            }

        monkeypatch.setattr(VERIFIER, "_run_relocation_smoke_after_static", fake_smoke)
        report = VERIFIER.verify_archive_relocation_smoke(
            archive, policy, policy_sha256=POLICY_SHA,
            smoke_parent=root / "short", timeout=3.0,
        )
        assert report["relocation_root_count"] == 2
        assert report["skia_canvas_constructed_in_both"] is True
        assert parents == [root / "short" / "relocation-a", root / "short" / "relocation-b"]


@pytest.mark.parametrize("field", ["top_id", "node_type"])
def test_control_organization_must_be_exact_upper_level(field: str) -> None:
    rows = [
        {
            "node_id": node_id, "name": name, "path": name, "top_id": node_id,
            "top_name": name, "parent_id": "", "depth": 0,
            "node_type": "ORGANIZATION", "selectable": True, "source_verified": True,
        }
        for node_id, name in (
            ("ERP-000000224", "9 Управляющая компания"),
            ("ERP-000000076", "3 Сахалин"),
        )
    ]
    VERIFIER.verify_control_organizations(rows)
    rows[0][field] = "BROKEN"
    with pytest.raises(VERIFIER.VerificationError, match="SMOKE_ORGANIZATION_SCOPE_INVALID"):
        VERIFIER.verify_control_organizations(rows)


@pytest.mark.skipif(os.name != "nt", reason="Windows relocation integration")
def test_public_relocation_smoke_api_runs_after_static_verification() -> None:
    with tempfile.TemporaryDirectory() as raw:
        archive, policy, _ = make_valid(Path(raw))
        with pytest.raises(VERIFIER.VerificationError, match="SMOKE_NODE_VERSION_FAILED"):
            VERIFIER.verify_archive_relocation_smoke(
                archive, policy, policy_sha256=POLICY_SHA,
                smoke_parent=Path(raw) / "short", timeout=2.0,
            )


@pytest.mark.skipif(
    os.name != "nt" or not os.environ.get("OPIU_R17_INTEGRATION_ARCHIVE"),
    reason="set OPIU_R17_INTEGRATION_ARCHIVE for the real Windows relocation smoke",
)
def test_real_windows_archive_relocation_smoke() -> None:
    archive = Path(os.environ["OPIU_R17_INTEGRATION_ARCHIVE"])
    policy = VERIFIER.load_policy()
    report = VERIFIER.verify_archive_relocation_smoke(
        archive, policy, policy_sha256=VERIFIER.sha256_file(VERIFIER.POLICY_PATH), timeout=30.0,
    )
    assert report["status"] == "PASS"
    assert report["relocation_root_count"] == 2
    assert report["skia_canvas_constructed_in_both"] is True
    assert report["port_released_in_both"] is True
    assert len(report["relocations"]) == 2
    assert all(item["skia_canvas_constructed"] is True for item in report["relocations"])


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
