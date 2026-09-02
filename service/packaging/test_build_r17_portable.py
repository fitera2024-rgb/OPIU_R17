from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest


SCRIPT = Path(__file__).with_name("build_r17_portable.py")
SPEC = importlib.util.spec_from_file_location("r17_portable_builder", SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILDER)


def write_synthetic_release_sidecar(output: Path, data: bytes = b"same attestation\n") -> None:
    output.with_name(BUILDER.RELEASE_MANIFEST_NAME).write_bytes(data)


def make_git_source_fixture(root: Path) -> tuple[dict[str, object], str]:
    policy = copy.deepcopy(BUILDER.load_policy())
    repository_root = Path(__file__).parents[2]
    files = {
        "service/source/go.mod": b"module example.invalid/opiu\n\ngo 1.22\n",
        "service/source/main.go": b"package main\nfunc main() {}\n",
        "modules/corrections/source/safe.mjs": b"export const safe = true;\n",
        "modules/reconciliation/source/safe.mjs": b"export const safe = true;\n",
        "resources/reference/ref.json": b"{}\n",
        "data/defaults/organizations.json": b"synthetic organizations\n",
        policy["contract"]["source"]: (
            repository_root / Path(policy["contract"]["source"])
        ).read_bytes(),
        policy["unicode_settings"][0]["path"]: b"setting a",
        policy["unicode_settings"][1]["path"]: b"setting b",
        ".gitignore": b"service/source/ignored.bin\n",
    }
    for relative, data in files.items():
        target = root / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "R17 Test"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "r17@example.invalid"], cwd=root, check=True)
    subprocess.run(["git", "add", "--all"], cwd=root, check=True)
    subprocess.run(["git", "commit", "--quiet", "-m", "fixture"], cwd=root, check=True)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, check=True, text=True,
        encoding="utf-8", stdout=subprocess.PIPE,
    ).stdout.strip()
    return policy, head


def test_canonical_policy_contains_all_exact_pins_and_closed_gates() -> None:
    policy = BUILDER.load_policy()
    assert policy["archive_name"] == "OPIU_R17.zip"
    assert policy["archive_root"] == "OPIU_R17"
    assert policy["executable_name"] == "OPIU_R17.exe"
    assert policy["contract"] == {
        "source": "contracts/Контракт_ОПИУ_v0.5_зафиксированный.docx",
        "package_path": "contract/OPIU_v0.5.docx",
        "sha256": "B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A",
    }
    assert policy["toolchains"]["go"]["file_count"] == 12900
    assert policy["toolchains"]["node"]["inventory_sha256"] == "EA2AF5CAFD6DACC3C9EFAC1FA03627053ECC8B54040202FCC7EA04ADCE261837"
    assert policy["toolchains"]["node_modules"]["packages"] == {
        "jszip": "3.10.1", "@oai/artifact-tool": "2.8.31", "skia-canvas": "3.0.8",
    }
    assert policy["safety"]["mode"] == "REPORT_ONLY"
    assert policy["safety"]["rules_service"] is False
    assert policy["runtime_dependency_closure"] == {
        "logical_root": "runtime", "edge_paths": "POSIX_RELATIVE_TO_LOGICAL_ROOT",
        "relative_imports_required": True, "missing_imports_rejected": True,
    }
    assert policy["relocation_smoke"]["relocation_roots"] == 2
    assert policy["relocation_smoke"]["skia_canvas_construct_required"] is True
    assert policy["build_verification"]["verify_both_archives"] is True
    assert policy["runtime_exact_files"] == BUILDER.expected_runtime_exact_files()
    assert "data/defaults" in policy["runtime_source_roots"]
    BUILDER.assert_closed_safety(policy["safety"])


def test_builder_rejects_policy_rebound_to_v04_even_with_matching_value_hash() -> None:
    policy = copy.deepcopy(BUILDER.load_policy())
    policy["contract"] = {
        "source": "contracts/Контракт_ОПИУ_v0.4_зафиксированный.docx",
        "package_path": "contract/OPIU_v0.4.docx",
        "sha256": "09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD",
    }
    with (
        patch.object(
            BUILDER, "EXPECTED_POLICY_VALUE_SHA256", BUILDER.policy_value_sha256(policy),
        ),
        pytest.raises(BUILDER.BuildError, match="POLICY_CONTRACT_BINDING_INVALID"),
    ):
        BUILDER.validate_policy(policy)


def test_contract_staging_uses_exact_v05_git_blob_and_preserves_historical_v04() -> None:
    repository_root = Path(__file__).parents[2]
    canonical = repository_root / "contracts/Контракт_ОПИУ_v0.5_зафиксированный.docx"
    historical = repository_root / "contracts/Контракт_ОПИУ_v0.4_зафиксированный.docx"
    assert BUILDER.sha256_file(canonical) == "B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A"
    assert BUILDER.sha256_file(historical) == "09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD"

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        repository = root / "repository"
        repository.mkdir()
        policy, head = make_git_source_fixture(repository)
        source_record = BUILDER.exact_git_source_inventory(repository, head, policy)
        target = root / "stage" / Path(policy["contract"]["package_path"])
        BUILDER.extract_git_file(
            repository, source_record, policy["contract"]["source"], target,
        )
        assert target.as_posix().endswith("stage/contract/OPIU_v0.5.docx")
        assert target.read_bytes() == canonical.read_bytes()
        assert BUILDER.sha256_file(target) == policy["contract"]["sha256"]
        contract_row = next(
            row for row in source_record["files"]
            if row["path"] == policy["contract"]["source"]
        )
        assert contract_row["sha256"] == policy["contract"]["sha256"]
        assert policy["contract"]["source"] != historical.relative_to(repository_root).as_posix()


def test_contract_metadata_materializes_exact_v05_binding() -> None:
    policy = BUILDER.load_policy()
    with tempfile.TemporaryDirectory() as raw:
        stage = Path(raw) / "stage"
        stage.mkdir()
        BUILDER._write_metadata(
            stage, policy, "b" * 40, "A" * 64,
            {
                "toolchain": {}, "go_test_passed": True,
                "deterministic_double_build": True, "first_sha256": "C" * 64,
                "second_sha256": "C" * 64, "size": 1,
                "build_command": ["go", "build"], "test_command": ["go", "test"],
            },
            {}, {}, {}, {}, {},
        )
        manifest = json.loads((stage / "R17_PACKAGE_MANIFEST.json").read_text(encoding="utf-8"))
        provenance = json.loads((stage / "R17_BUILD_PROVENANCE.json").read_text(encoding="utf-8"))
        assert manifest["contract"] == policy["contract"]
        assert provenance["contract"] == policy["contract"]
        assert (stage / "CONTRACT_SHA256.txt").read_bytes() == (
            b"B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A "
            b"*contract/OPIU_v0.5.docx\r\n"
        )


def test_organizations_policy_pin_matches_rel13b_golden_manifest() -> None:
    policy = BUILDER.load_policy()
    golden_path = Path(__file__).with_name("golden") / "REL13B_EXACT_OWNER_RUNTIME.json"
    golden = json.loads(golden_path.read_text(encoding="utf-8-sig"))
    rows = [row for row in golden["files"] if row["path"] == "data/defaults/organizations.json"]
    assert len(rows) == 1
    binding = policy["runtime_exact_files"][0]
    assert binding["role"] == "organizations"
    assert binding["source_path"] == rows[0]["path"]
    assert binding["package_path"] == "runtime/data/defaults/organizations.json"
    assert binding["size"] == rows[0]["size"]
    assert binding["sha256"] == rows[0]["sha256"]


def test_policy_rejects_any_open_safety_gate() -> None:
    policy = BUILDER.load_policy()
    opened = copy.deepcopy(policy)
    opened["safety"]["release_allowed"] = True
    with pytest.raises(BUILDER.BuildError, match="POLICY_VALUE_SET_NOT_EXACT"):
        BUILDER.validate_policy(opened)


def test_runtime_safety_is_materialized_with_exact_canonical_bytes_and_sha() -> None:
    policy = BUILDER.load_policy()
    expected = BUILDER.canonical_json(policy["safety"])
    with tempfile.TemporaryDirectory() as raw:
        stage = Path(raw) / "stage"
        record = BUILDER.materialize_runtime_safety(stage, policy)
        target = stage / "runtime" / "SAFETY.json"
        assert target.read_bytes() == expected
        assert record == {
            "path": "runtime/SAFETY.json",
            "size": len(expected),
            "sha256": BUILDER.sha256_bytes(expected),
        }
        target.write_text("{}\n", encoding="utf-8")
        with pytest.raises(BUILDER.BuildError, match="RUNTIME_SAFETY_PREEXISTING_CONFLICT"):
            BUILDER.materialize_runtime_safety(stage, policy)


@pytest.mark.parametrize("mutation", ["rules_token", "rules_fragment", "organizations_binding", "component", "relative", "full"])
def test_policy_rejects_deleted_rules_guards_and_raised_path_limits(mutation: str) -> None:
    changed = copy.deepcopy(BUILDER.load_policy())
    if mutation == "rules_token":
        changed["legacy_rules_gate"]["forbidden_tokens"]["runtime"].pop()
    elif mutation == "rules_fragment":
        changed["legacy_rules_gate"]["forbidden_package_path_fragments"].clear()
    elif mutation == "organizations_binding":
        changed["runtime_exact_files"][0]["sha256"] = "0" * 64
    else:
        key = {"component": "component_max", "relative": "relative_max", "full": "full_path_max"}[mutation]
        changed["path_limits"][key] += 1
    with pytest.raises(BUILDER.BuildError, match="POLICY_VALUE_SET_NOT_EXACT"):
        BUILDER.validate_policy(changed)


@pytest.mark.parametrize(
    "relative",
    ["../escape", "/absolute", "//server/share", "C:/absolute", "bad\\name", "a/./b"],
)
def test_unsafe_archive_paths_are_rejected(relative: str) -> None:
    with pytest.raises(BUILDER.BuildError, match="PACKAGE_PATH_UNSAFE"):
        BUILDER.validate_relative_path(relative, BUILDER.load_policy())


def test_all_short_path_limits_are_enforced() -> None:
    policy = BUILDER.load_policy()
    with pytest.raises(BUILDER.BuildError, match="PACKAGE_COMPONENT_TOO_LONG"):
        BUILDER.validate_relative_path("a" * 81, policy)
    with pytest.raises(BUILDER.BuildError, match="PACKAGE_RELATIVE_PATH_TOO_LONG"):
        BUILDER.validate_relative_path("/".join(["a" * 60] * 3), policy)
    tightened = copy.deepcopy(policy)
    tightened["path_limits"]["full_path_max"] = 30
    with pytest.raises(BUILDER.BuildError, match="PACKAGE_FULL_PATH_TOO_LONG"):
        BUILDER.validate_relative_path("runtime/file.txt", tightened)


def test_exact_git_blob_inventory_and_blob_extraction() -> None:
    with tempfile.TemporaryDirectory() as raw:
        repository = Path(raw)
        policy, head = make_git_source_fixture(repository)
        record = BUILDER.exact_git_source_inventory(repository, head, policy)
        assert record["source_head"] == head
        assert record["exact_git_blobs"] is True
        assert record["ignored_injection_checked"] is True
        assert all(row["git_blob"] and row["git_mode"] for row in record["files"])
        with tempfile.TemporaryDirectory() as destination_raw:
            destination = Path(destination_raw)
            BUILDER.extract_git_tree(repository, record, "service/source", destination)
            assert (destination / "main.go").read_bytes() == b"package main\nfunc main() {}\n"


def test_service_test_tree_preserves_git_bound_cross_runtime_topology() -> None:
    with tempfile.TemporaryDirectory() as raw:
        repository = Path(raw)
        policy, head = make_git_source_fixture(repository)
        record = BUILDER.exact_git_source_inventory(repository, head, policy)
        with tempfile.TemporaryDirectory() as destination_raw:
            target = Path(destination_raw) / "source"
            service_source, service_record, support_records = BUILDER.extract_service_test_tree(
                repository, record, target, policy,
            )
            assert service_source == target / "service" / "source"
            assert service_record["file_count"] == 2
            assert set(support_records) == set(policy["runtime_source_roots"])
            assert (service_source / "main.go").is_file()
            assert (target / "modules" / "reconciliation" / "source" / "safe.mjs").is_file()
            assert (target / "modules" / "corrections" / "source" / "safe.mjs").is_file()
            assert (target / "resources" / "reference" / "ref.json").is_file()
            assert (target / "data" / "defaults" / "organizations.json").is_file()


def test_independent_build_passes_verified_modules_to_temporary_go_test_staging() -> None:
    policy = BUILDER.load_policy()
    expected_source_record = {"files": [], "inventory_sha256": "A" * 64}
    captured: dict[str, object] = {}

    class StopAfterTestStaging(Exception):
        pass

    def test_and_build(go_exe, source_root, build_root, **kwargs):
        captured.update({
            "go_exe": go_exe, "source_root": source_root,
            "build_root": build_root, **kwargs,
        })
        raise StopAfterTestStaging

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        repository = root / "repository"
        repository.mkdir()
        modules = root / "verified-modules"
        modules.mkdir()
        with (
            patch.object(BUILDER, "exact_git_source_inventory", return_value=expected_source_record),
            patch.object(
                BUILDER, "extract_service_test_tree",
                return_value=(root / "source/service/source", {}, {}),
            ),
            patch.object(BUILDER.BASE, "test_and_build_service", side_effect=test_and_build),
            pytest.raises(StopAfterTestStaging),
        ):
            BUILDER._build_one(
                0, root / "OPIU_R17.zip", repository, "b" * 40,
                root / "go.exe", root / "node.exe", modules,
                policy, "C" * 64, expected_source_record,
            )
    assert captured["test_node_exe"] == root / "node.exe"
    assert captured["test_node_modules"] == modules
    assert captured["expected_test_node_modules_inventory"] == policy["toolchains"]["node_modules"]


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ("missing", "RUNTIME_EXACT_FILE_MISSING"),
        ("size", "RUNTIME_EXACT_FILE_SIZE_MISMATCH"),
        ("sha", "RUNTIME_EXACT_FILE_SHA256_MISMATCH"),
    ],
)
def test_staged_runtime_organizations_rejects_missing_size_or_sha_drift(
    state: str, expected: str,
) -> None:
    policy = copy.deepcopy(BUILDER.load_policy())
    with tempfile.TemporaryDirectory() as raw:
        stage = Path(raw)
        target = stage / "runtime/data/defaults/organizations.json"
        if state != "missing":
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x" if state == "size" else b"synthetic")
            if state == "sha":
                policy["runtime_exact_files"][0].update({
                    "size": len(b"synthetic"), "sha256": "0" * 64,
                })
        with pytest.raises(BUILDER.BuildError, match=expected):
            BUILDER.verify_staged_runtime_exact_files(stage, policy)


def test_exact_runtime_organizations_is_git_bound_and_copied_byte_for_byte() -> None:
    with tempfile.TemporaryDirectory() as raw:
        repository = Path(raw) / "repository"
        repository.mkdir()
        policy, head = make_git_source_fixture(repository)
        catalog_path = repository / "data/defaults/organizations.json"
        policy["runtime_exact_files"][0].update({
            "size": catalog_path.stat().st_size,
            "sha256": BUILDER.sha256_file(catalog_path),
        })
        contract_path = repository / Path(policy["contract"]["source"])
        policy["contract"]["sha256"] = BUILDER.sha256_file(contract_path)
        for row in policy["unicode_settings"]:
            row["sha256"] = BUILDER.sha256_file(repository / Path(row["path"]))
        source_record = BUILDER.exact_git_source_inventory(repository, head, policy)
        evidence = BUILDER.verify_contract_and_settings(source_record, policy)
        assert evidence["runtime_exact_files"] == policy["runtime_exact_files"]
        stage = Path(raw) / "stage"
        stage.mkdir()
        BUILDER.copy_runtime_sources(repository, source_record, stage, policy)
        verified = BUILDER.verify_staged_runtime_exact_files(stage, policy)
        assert verified == policy["runtime_exact_files"]
        packaged = stage / "runtime/data/defaults/organizations.json"
        assert packaged.read_bytes() == catalog_path.read_bytes()


@pytest.mark.parametrize("injection", ["tracked_drift", "untracked", "ignored"])
def test_exact_git_source_inventory_rejects_all_worktree_injection(injection: str) -> None:
    with tempfile.TemporaryDirectory() as raw:
        repository = Path(raw)
        policy, head = make_git_source_fixture(repository)
        if injection == "tracked_drift":
            (repository / "service/source/main.go").write_bytes(b"package main\n// drift\n")
            expected = "SOURCE_REPOSITORY_NOT_CLEAN"
        elif injection == "untracked":
            (repository / "service/source/injected.go").write_bytes(b"package injected\n")
            expected = "SOURCE_REPOSITORY_NOT_CLEAN"
        else:
            (repository / "service/source/ignored.bin").write_bytes(b"ignored injection")
            expected = "SOURCE_SCOPE_INJECTION_OR_MISSING"
        with pytest.raises(BUILDER.BuildError, match=expected):
            BUILDER.exact_git_source_inventory(repository, head, policy)


def test_runtime_dependency_closure_rejects_missing_relative_import() -> None:
    with tempfile.TemporaryDirectory() as raw:
        runtime = Path(raw)
        source = runtime / "modules/corrections/source/main.mjs"
        source.parent.mkdir(parents=True)
        source.write_text('import "./missing.mjs";\n', encoding="utf-8")
        with pytest.raises(BUILDER.BuildError, match="RUNTIME_RELATIVE_IMPORT_MISSING"):
            BUILDER.verify_runtime_dependency_closure(runtime)


def test_runtime_dependency_closure_accepts_existing_directory_url() -> None:
    with tempfile.TemporaryDirectory() as raw:
        runtime = Path(raw)
        source = runtime / "modules/pkg/wasm/native.js"
        source.parent.mkdir(parents=True)
        source.write_text('const base = new URL("./", import.meta.url);\n', encoding="utf-8")
        result = BUILDER.verify_runtime_dependency_closure(runtime)
        assert result["relative_dependency_count"] == 1
        assert result["edges"] == [{
            "source": "modules/pkg/wasm/native.js",
            "specifier": "./",
            "target": "modules/pkg/wasm/",
        }]


def test_runtime_dependency_closure_excludes_exact_inventory_node_modules_sources() -> None:
    with tempfile.TemporaryDirectory() as raw:
        runtime = Path(raw)
        bundled = runtime / "node_modules/jszip/dist/jszip.js"
        bundled.parent.mkdir(parents=True)
        bundled.write_text('const internal = require("../base64");\n', encoding="utf-8")
        result = BUILDER.verify_runtime_dependency_closure(runtime)
        assert result["excluded_exact_inventory_roots"] == ["node_modules"]
        assert result["relative_dependency_count"] == 0
        assert result["edges"] == []


def test_release_attestation_is_derived_from_actual_post_archive_bytes() -> None:
    policy = BUILDER.load_policy()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        stage = root / "stage"
        stage.mkdir()
        executable = b"MZ deterministic executable"
        embedded_manifest = b'{"schema_version":"synthetic"}\n'
        (stage / policy["executable_name"]).write_bytes(executable)
        (stage / "R17_PACKAGE_MANIFEST.json").write_bytes(embedded_manifest)
        archive = root / "OPIU_R17.zip"
        BUILDER.write_deterministic_zip(stage, archive, policy)
        attestation = BUILDER.write_release_attestation(
            archive, policy, "C" * 64, "b" * 40, "A" * 64,
        )
        document = json.loads(attestation.read_text(encoding="utf-8"))
        assert document["source_branch"] == "release/r17"
        assert document["source_head"] == "b" * 40
        assert document["source_inventory_sha256"] == "A" * 64
        assert document["contract_version"] == "0.5"
        assert document["contract_sha256"] == policy["contract"]["sha256"]
        assert document["embedded_package_manifest"] == {
            "path": "R17_PACKAGE_MANIFEST.json", "size": len(embedded_manifest),
            "sha256": BUILDER.sha256_bytes(embedded_manifest),
        }
        assert document["executable"] == {
            "path": policy["executable_name"], "size": len(executable),
            "sha256": BUILDER.sha256_bytes(executable),
        }
        assert document["archive"] == {
            "name": archive.name, "size": archive.stat().st_size,
            "sha256": BUILDER.sha256_file(archive),
        }
        assert document["safety"] == policy["safety"]
        assert document["release_approved"] is False


def test_two_independent_zip_producers_are_byte_identical_atomic_and_no_overwrite() -> None:
    policy = BUILDER.load_policy()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        calls: list[int] = []
        verified: list[int] = []

        def producer(index: int, output: Path) -> None:
            calls.append(index)
            stage = root / f"stage-{index}"
            stage.mkdir()
            (stage / "same.txt").write_bytes(b"same bytes")
            BUILDER.write_deterministic_zip(stage, output, policy)
            write_synthetic_release_sidecar(output)

        def verifier(index: int, output: Path) -> dict[str, object]:
            verified.append(index)
            assert output.name == "OPIU_R17.zip"
            return {"status": "PASS_REPORT_ONLY_CANDIDATE"}

        first = root / "A" / "OPIU_R17.zip"
        second = root / "B" / "OPIU_R17.zip"
        result = BUILDER.promote_independent_pair(
            first, second, producer, "OPIU_R17.zip", verifier,
        )
        assert calls == [0, 1]
        assert verified == [0, 1]
        assert result["independent_complete_builds"] == 2
        assert result["atomic_no_overwrite"] is True
        assert result["release_manifests_byte_identical"] is True
        assert first.read_bytes() == second.read_bytes()
        assert first.with_name(BUILDER.RELEASE_MANIFEST_NAME).read_bytes() == second.with_name(
            BUILDER.RELEASE_MANIFEST_NAME
        ).read_bytes()
        with pytest.raises(BUILDER.BuildError, match="OUTPUT_ALREADY_EXISTS"):
            BUILDER.promote_independent_pair(
                first, root / "C" / "OPIU_R17.zip", producer, "OPIU_R17.zip", verifier,
            )


def test_pair_rolls_back_first_promotion_if_second_promotion_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        first = root / "A" / "OPIU_R17.zip"
        second = root / "B" / "OPIU_R17.zip"

        def producer(_: int, output: Path) -> None:
            output.write_bytes(b"identical")
            write_synthetic_release_sidecar(output)

        real_link = os.link
        calls = 0

        def fail_second(source: Path, target: Path) -> None:
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("synthetic second promotion failure")
            real_link(source, target)

        monkeypatch.setattr(BUILDER.os, "link", fail_second)
        with pytest.raises(OSError, match="synthetic"):
            BUILDER.promote_independent_pair(
                first, second, producer, "OPIU_R17.zip", lambda _index, _path: {"status": "PASS"},
            )
        assert not first.exists()
        assert not second.exists()
        assert not first.with_name(BUILDER.RELEASE_MANIFEST_NAME).exists()
        assert not second.with_name(BUILDER.RELEASE_MANIFEST_NAME).exists()


def test_both_independent_archives_are_verified_before_any_promotion() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        first = root / "A" / "OPIU_R17.zip"
        second = root / "B" / "OPIU_R17.zip"
        verified: list[int] = []

        def producer(index: int, output: Path) -> None:
            output.write_bytes(b"same")
            write_synthetic_release_sidecar(output)

        def reject_closure(index: int, _output: Path) -> dict[str, object]:
            verified.append(index)
            raise BUILDER.BuildError("RUNTIME_DEPENDENCY_CLOSURE_EVIDENCE_MISMATCH")

        with pytest.raises(BUILDER.BuildError, match="INDEPENDENT_ARCHIVE_PAIR_VERIFICATION_FAILED:1,2"):
            BUILDER.promote_independent_pair(
                first, second, producer, "OPIU_R17.zip", reject_closure,
            )
        assert verified == [0, 1]
        assert not first.exists()
        assert not second.exists()


def test_publish_outputs_inside_repository_are_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        repository = root / "repo"
        repository.mkdir()
        outside = root / "outside" / "OPIU_R17.zip"
        with pytest.raises(BUILDER.BuildError, match="OUTPUT_OR_PUBLISH_PATH_INSIDE_REPOSITORY"):
            BUILDER.assert_publish_paths_outside_repository(
                repository, repository / "A" / "OPIU_R17.zip", outside, "OPIU_R17.zip",
            )
        BUILDER.assert_publish_paths_outside_repository(
            repository, root / "A" / "OPIU_R17.zip", root / "B" / "OPIU_R17.zip",
            "OPIU_R17.zip",
        )
        monkeypatch.setattr(BUILDER.tempfile, "gettempdir", lambda: str(repository / "temp"))
        with pytest.raises(BUILDER.BuildError, match="BUILD_TEMP_ROOT_INSIDE_REPOSITORY"):
            BUILDER.assert_publish_paths_outside_repository(
                repository, root / "A" / "OPIU_R17.zip", root / "B" / "OPIU_R17.zip",
                "OPIU_R17.zip",
            )


def test_immutable_r001_correction_rules_are_not_misclassified_as_external_rules_service() -> None:
    policy = BUILDER.load_policy()
    with tempfile.TemporaryDirectory() as raw:
        repository = Path(raw)
        correction = repository / policy["legacy_rules_gate"]["immutable_r001_exception"]
        correction.parent.mkdir(parents=True)
        correction.write_text('{"schema":"immutable-r001"}\n', encoding="utf-8")
        (repository / "service" / "source").mkdir(parents=True)
        result = BUILDER.audit_legacy_rules_repository(repository, policy)
        assert result["status"] == "PASS"
        assert result["rules_service"] is False


@pytest.mark.skipif(os.name != "nt", reason="Windows integration")
def test_current_pre_arch_repository_is_fail_closed_by_legacy_rules_gate() -> None:
    repository = SCRIPT.parents[2]
    policy = BUILDER.load_policy()
    legacy_paths_exist = any(
        (repository / Path(relative)).exists()
        for relative in policy["legacy_rules_gate"]["forbidden_repository_paths"]
    )
    if legacy_paths_exist:
        with pytest.raises(BUILDER.BuildError, match="LEGACY_RULES_GATE_BLOCKED"):
            BUILDER.audit_legacy_rules_repository(repository, policy)
    else:
        assert BUILDER.audit_legacy_rules_repository(repository, policy)["status"] == "PASS"


@pytest.mark.skipif(os.name != "nt", reason="Windows integration")
def test_symlink_or_reparse_input_is_rejected_when_windows_allows_fixture_creation() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        target = root / "target.txt"
        target.write_text("x", encoding="utf-8")
        link = root / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            pytest.skip("Windows symlink creation is not available for this account")
        with pytest.raises(BUILDER.BuildError, match="SYMLINK_OR_REPARSE_FORBIDDEN"):
            BUILDER.safe_files(root)


def test_privacy_gate_allows_only_the_exact_bound_upstream_exception() -> None:
    policy = BUILDER.load_policy()
    synthetic = copy.deepcopy(policy)
    data = b"runneradmin D:\\a\\"
    exception = synthetic["privacy"]["allowed_upstream_debug_exception"]
    exception.update({
        "size": len(data), "sha256": BUILDER.sha256_bytes(data),
        "runneradmin_hits": 1, "d_drive_a_hits": 1,
    })
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        path = root / Path(exception["path"])
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
        evidence = BUILDER.audit_privacy(root, synthetic, ())
        assert evidence["whole_zip_user_profile_path_free"] is False
        virtual_home = root / "runtime" / "node_modules" / "pkg" / "virtual.js"
        virtual_home.parent.mkdir(parents=True)
        virtual_home.write_bytes(b'const home = "/home/web_user";\n')
        evidence = BUILDER.audit_privacy(root, synthetic, ())
        assert evidence["exact_inventory_node_modules_generic_profile_scan_exempt"] is True
        leaked = root / "runtime" / "leak.txt"
        leaked.write_bytes(b"C:\\Users\\customer\\build")
        with pytest.raises(BUILDER.BuildError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
            BUILDER.audit_privacy(root, synthetic, ())
        leaked.write_bytes("C:\\Users\\NB-FIT\\build".encode("utf-16-be"))
        with pytest.raises(BUILDER.BuildError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
            BUILDER.audit_privacy(root, synthetic, ())
