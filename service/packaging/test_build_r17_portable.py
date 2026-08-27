from __future__ import annotations

import copy
import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("build_r17_portable.py")
SPEC = importlib.util.spec_from_file_location("r17_portable_builder", SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILDER)


def make_git_source_fixture(root: Path) -> tuple[dict[str, object], str]:
    policy = copy.deepcopy(BUILDER.load_policy())
    files = {
        "service/source/go.mod": b"module example.invalid/opiu\n\ngo 1.22\n",
        "service/source/main.go": b"package main\nfunc main() {}\n",
        "modules/corrections/source/safe.mjs": b"export const safe = true;\n",
        "modules/reconciliation/source/safe.mjs": b"export const safe = true;\n",
        "resources/reference/ref.json": b"{}\n",
        policy["contract"]["source"]: b"synthetic contract",
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
    assert policy["contract"]["sha256"] == "09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD"
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
    BUILDER.assert_closed_safety(policy["safety"])


def test_policy_rejects_any_open_safety_gate() -> None:
    policy = BUILDER.load_policy()
    opened = copy.deepcopy(policy)
    opened["safety"]["release_allowed"] = True
    with pytest.raises(BUILDER.BuildError, match="POLICY_VALUE_SET_NOT_EXACT"):
        BUILDER.validate_policy(opened)


@pytest.mark.parametrize("mutation", ["rules_token", "rules_fragment", "component", "relative", "full"])
def test_policy_rejects_deleted_rules_guards_and_raised_path_limits(mutation: str) -> None:
    changed = copy.deepcopy(BUILDER.load_policy())
    if mutation == "rules_token":
        changed["legacy_rules_gate"]["forbidden_tokens"]["runtime"].pop()
    elif mutation == "rules_fragment":
        changed["legacy_rules_gate"]["forbidden_package_path_fragments"].clear()
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
        assert first.read_bytes() == second.read_bytes()
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

        real_link = os.link
        calls = 0

        def fail_second(source: Path, target: Path) -> None:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic second promotion failure")
            real_link(source, target)

        monkeypatch.setattr(BUILDER.os, "link", fail_second)
        with pytest.raises(OSError, match="synthetic"):
            BUILDER.promote_independent_pair(
                first, second, producer, "OPIU_R17.zip", lambda _index, _path: {"status": "PASS"},
            )
        assert not first.exists()
        assert not second.exists()


def test_both_independent_archives_are_verified_before_any_promotion() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        first = root / "A" / "OPIU_R17.zip"
        second = root / "B" / "OPIU_R17.zip"
        verified: list[int] = []

        def producer(index: int, output: Path) -> None:
            output.write_bytes(b"same")

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
        leaked = root / "runtime" / "leak.txt"
        leaked.write_bytes(b"C:\\Users\\customer\\build")
        with pytest.raises(BUILDER.BuildError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
            BUILDER.audit_privacy(root, synthetic, ())
        leaked.write_bytes("C:\\Users\\NB-FIT\\build".encode("utf-16-be"))
        with pytest.raises(BUILDER.BuildError, match="LOCAL_CUSTOMER_BUILD_PATH_LEAK"):
            BUILDER.audit_privacy(root, synthetic, ())
