from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("build_clean_source_service_candidate.py")
SPEC = importlib.util.spec_from_file_location("build_clean_source_service_candidate", SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILDER)


class CleanSourceServiceCandidateTests(unittest.TestCase):
    def make_source(self, root: Path) -> Path:
        source = root / "development" / "OPIU_1.9.4" / "service" / "source"
        (source / "web").mkdir(parents=True)
        (source / "web_tests").mkdir()
        (source / "main.go").write_text("package main\n", encoding="utf-8")
        (source / "go.mod").write_text("module example.test/service\n\ngo 1.22\n", encoding="utf-8")
        (source / "web" / "index.html").write_text("<html></html>\n", encoding="utf-8")
        (source / "web_tests" / "contract.test.cjs").write_text("// test\n", encoding="utf-8")
        (source / "nested" / "evidence").mkdir(parents=True)
        (source / "nested" / "evidence" / "input.txt").write_text("included\n", encoding="utf-8")
        return source

    def make_bundle(self, root: Path, *, old_exe: bytes = b"old-carrier-exe") -> Path:
        bundle = root / "OPIU"
        runtime = bundle / "runtime"
        (runtime / "modules").mkdir(parents=True)
        (runtime / "modules" / "overlay.mjs").write_text("export const stable = true;\n", encoding="utf-8")
        safety = {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "executed_posting_rows": 0,
            "live_posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": False,
            "execution_allowed": False,
            "live_1c_allowed": False,
            "live_delete_allowed": False,
        }
        (runtime / "SAFETY.json").write_text(json.dumps(safety), encoding="utf-8")
        (runtime / "MANIFEST.json").write_text(
            json.dumps({"safety": safety, "files": []}), encoding="utf-8"
        )
        (bundle / "OPIU_STABLE_Service.exe").write_bytes(old_exe)
        (bundle / "unchanged.txt").write_text("carrier\n", encoding="utf-8")
        return bundle

    def test_full_source_inventory_includes_every_regular_nested_file(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            source = self.make_source(Path(raw))
            result = BUILDER.source_inventory(source)
            expected = sorted(
                path.relative_to(source).as_posix()
                for path in source.rglob("*")
                if path.is_file()
            )
            self.assertEqual([row["path"] for row in result["files"]], expected)
            self.assertEqual(result["file_count"], len(expected))
            self.assertEqual(len(result["sha256"]), 64)

    def test_repository_binding_requires_exact_root_head_and_whole_tree_clean(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw).resolve()
            head = "a" * 40
            with patch.object(
                BUILDER,
                "git_text",
                side_effect=[str(repository), head, ""],
            ):
                self.assertEqual(BUILDER.verify_repository(repository, head), head)
            with patch.object(
                BUILDER,
                "git_text",
                side_effect=[str(repository), head, "?? outside-service.txt"],
            ):
                with self.assertRaisesRegex(BUILDER.BuildError, "SOURCE_REPOSITORY_NOT_CLEAN"):
                    BUILDER.verify_repository(repository, head)

    def test_repository_binding_rejects_revision_and_root_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw).resolve()
            with patch.object(BUILDER, "git_text", return_value=str(repository.parent)):
                with self.assertRaisesRegex(BUILDER.BuildError, "SOURCE_REPOSITORY_ROOT_MISMATCH"):
                    BUILDER.verify_repository(repository, "b" * 40)
            with patch.object(
                BUILDER,
                "git_text",
                side_effect=[str(repository), "c" * 40],
            ):
                with self.assertRaisesRegex(BUILDER.BuildError, "SOURCE_HEAD_MISMATCH"):
                    BUILDER.verify_repository(repository, "b" * 40)

    def test_ignored_go_file_outside_exact_git_tree_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw).resolve()
            source = self.make_source(repository)
            subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "qa@example.invalid"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Packaging QA"], cwd=repository, check=True)
            (repository / ".gitignore").write_text("ignored.go\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-qm", "exact source"], cwd=repository, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
            (source / "ignored.go").write_text(
                'package main\nfunc HiddenBuildInput() string { return "outside-head" }\n',
                encoding="utf-8",
            )
            self.assertEqual(
                subprocess.check_output(
                    ["git", "status", "--porcelain=v1", "--untracked-files=all"],
                    cwd=repository,
                    text=True,
                ).strip(),
                "",
            )
            BUILDER.verify_repository(repository, head)
            with self.assertRaisesRegex(BUILDER.BuildError, "SERVICE_SOURCE_NOT_EXACT_GIT_TREE"):
                BUILDER.exact_source_inventory(repository, head, source)

    def test_source_is_reverified_after_build_to_close_revision_race(self) -> None:
        expected = {"file_count": 1, "sha256": "A" * 64, "files": []}
        changed = {"file_count": 1, "sha256": "B" * 64, "files": []}
        with (
            patch.object(BUILDER, "verify_repository", return_value="a" * 40) as verify,
            patch.object(BUILDER, "exact_source_inventory", return_value=changed),
            self.assertRaisesRegex(BUILDER.BuildError, "SERVICE_SOURCE_CHANGED_DURING_BUILD"),
        ):
            BUILDER.verify_source_unchanged(
                Path("repository"),
                "a" * 40,
                Path("source"),
                expected,
            )
        verify.assert_called_once()

    def test_toolchain_is_exact_go_1_22_12_windows_amd64(self) -> None:
        completed = subprocess.CompletedProcess([], 0, "go version go1.22.12 windows/amd64\n", "")
        binding = {
            "go_exe_sha256": BUILDER.EXPECTED_GO_EXE_SHA256,
            "toolchain_file_count": BUILDER.EXPECTED_GO_TOOLCHAIN_FILE_COUNT,
            "toolchain_inventory_sha256": BUILDER.EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256,
        }
        with (
            patch.object(BUILDER, "verify_toolchain_files", return_value=binding),
            patch.object(BUILDER, "run_process", return_value=completed),
        ):
            result = BUILDER.verify_toolchain(Path("go.exe"))
        self.assertEqual(result["version"], "go1.22.12")
        self.assertEqual(result["platform"], "windows/amd64")
        wrong = subprocess.CompletedProcess([], 0, "go version go1.23.12 windows/amd64\n", "")
        with (
            patch.object(BUILDER, "verify_toolchain_files", return_value=binding),
            patch.object(BUILDER, "run_process", return_value=wrong),
        ):
            with self.assertRaisesRegex(BUILDER.BuildError, "GO_TOOLCHAIN_MISMATCH"):
                BUILDER.verify_toolchain(Path("go.exe"))

    def test_fake_go_version_shim_is_rejected_by_pinned_hash(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fake = Path(raw) / "go" / "bin" / "go.exe"
            fake.parent.mkdir(parents=True)
            fake.write_bytes(b"fake shim that claims go version go1.22.12 windows/amd64")
            with self.assertRaisesRegex(BUILDER.BuildError, "GO_EXECUTABLE_SHA256_MISMATCH"):
                BUILDER.verify_toolchain_files(fake)

    def test_go_tests_precede_two_deterministic_builds_and_environment_is_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_source(root)
            node = root / "pinned-node" / "node.exe"
            node.parent.mkdir()
            node.write_bytes(b"pinned test node")
            node_modules = root / "pinned-node-modules"
            (node_modules / "jszip").mkdir(parents=True)
            (node_modules / "jszip" / "package.json").write_text(
                '{"name":"jszip","version":"3.10.1"}\n', encoding="utf-8",
            )
            node_modules_inventory = BUILDER.verified_test_node_modules_inventory(node_modules)
            source_before = BUILDER.source_inventory(source)
            test_modules_target = source.parent.parent / "node_modules"
            commands: list[list[str]] = []
            environments: list[dict[str, str]] = []

            def run(command, *, cwd, env):
                commands.append([str(value) for value in command])
                environments.append(dict(env))
                if "test" in command:
                    self.assertEqual(Path(cwd), source.resolve())
                    self.assertEqual(
                        (test_modules_target / "jszip" / "package.json").read_bytes(),
                        (node_modules / "jszip" / "package.json").read_bytes(),
                    )
                if "build" in command:
                    self.assertFalse(test_modules_target.exists())
                    output = Path(command[command.index("-o") + 1])
                    output.parent.mkdir(parents=True, exist_ok=True)
                    output.write_bytes(b"deterministic-new-exe")
                return subprocess.CompletedProcess(command, 0, "ok\n", "")

            with (
                patch.object(
                    BUILDER,
                    "verify_toolchain",
                    return_value={"version": "go1.22.12", "platform": "windows/amd64"},
                ),
                patch.object(BUILDER, "run_process", side_effect=run),
                patch.object(BUILDER, "verify_toolchain_files", return_value={
                    "go_exe_sha256": BUILDER.EXPECTED_GO_EXE_SHA256,
                    "toolchain_file_count": BUILDER.EXPECTED_GO_TOOLCHAIN_FILE_COUNT,
                    "toolchain_inventory_sha256": BUILDER.EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256,
                }),
            ):
                result = BUILDER.test_and_build_service(
                    Path("go.exe"), source, root / "build", test_node_exe=node,
                    test_node_modules=node_modules,
                    expected_test_node_modules_inventory=node_modules_inventory,
                )

            self.assertIn("test", commands[0])
            self.assertIn("build", commands[1])
            self.assertIn("build", commands[2])
            self.assertTrue(result["deterministic_double_build"])
            self.assertEqual(result["first_sha256"], result["second_sha256"])
            self.assertEqual(
                environments[0]["PATH"].split(os.pathsep, 1)[0], str(node.parent.resolve()),
            )
            self.assertEqual(environments[0]["NODE_OPTIONS"], "")
            self.assertEqual(environments[0]["NODE_PATH"], "")
            self.assertEqual(environments[0]["NODE_ENV"], "production")
            self.assertFalse(test_modules_target.exists())
            self.assertEqual(BUILDER.source_inventory(source), source_before)
            for env in environments:
                self.assertEqual(env["GOTOOLCHAIN"], "local")
                self.assertEqual(env["GOOS"], "windows")
                self.assertEqual(env["GOARCH"], "amd64")
                self.assertEqual(env["CGO_ENABLED"], "0")
                self.assertEqual(env["GOPROXY"], "off")
                self.assertEqual(env["GOSUMDB"], "off")

    def test_test_node_modules_collision_fails_before_go_process(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_source(root)
            modules = root / "verified-modules"
            modules.mkdir()
            (modules / "package.json").write_text("{}\n", encoding="utf-8")
            target = source.parent.parent / "node_modules"
            target.mkdir()
            with self.assertRaisesRegex(BUILDER.BuildError, "TEST_NODE_MODULES_TARGET_COLLISION"):
                BUILDER.materialize_test_node_modules(
                    source, modules, BUILDER.verified_test_node_modules_inventory(modules),
                )

    def test_test_node_modules_tamper_after_go_test_fails_before_build(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_source(root)
            modules = root / "verified-modules"
            modules.mkdir()
            (modules / "package.json").write_text("{}\n", encoding="utf-8")
            expected = BUILDER.verified_test_node_modules_inventory(modules)
            commands: list[list[str]] = []

            def run(command, *, cwd, env):
                commands.append([str(value) for value in command])
                if "test" in command:
                    (source.parent.parent / "node_modules" / "package.json").write_text(
                        '{"tampered":true}\n', encoding="utf-8",
                    )
                return subprocess.CompletedProcess(command, 0, "ok\n", "")

            with (
                patch.object(BUILDER, "verify_toolchain", return_value={}),
                patch.object(BUILDER, "run_process", side_effect=run),
                patch.object(BUILDER, "verify_toolchain_files", return_value={}),
                self.assertRaisesRegex(BUILDER.BuildError, "TEST_NODE_MODULES_INVENTORY_MISMATCH"),
            ):
                BUILDER.test_and_build_service(
                    Path("go.exe"), source, root / "build",
                    test_node_modules=modules,
                    expected_test_node_modules_inventory=expected,
                )
            self.assertEqual(len(commands), 1)
            self.assertIn("test", commands[0])
            self.assertFalse((source.parent.parent / "node_modules").exists())

    def test_test_node_modules_reparse_input_is_inventory_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_source(root)
            modules = root / "verified-modules"
            modules.mkdir()
            (modules / "package.json").write_text("{}\n", encoding="utf-8")
            expected = BUILDER.verified_test_node_modules_inventory(modules)
            original = BUILDER.is_reparse_point
            with (
                patch.object(
                    BUILDER, "is_reparse_point",
                    side_effect=lambda path: Path(path) == modules.absolute() or original(path),
                ),
                self.assertRaisesRegex(BUILDER.BuildError, "TEST_NODE_MODULES_INVENTORY_MISMATCH"),
            ):
                BUILDER.materialize_test_node_modules(source, modules, expected)

    def test_nondeterministic_service_build_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_source(root)
            counter = 0

            def run(command, *, cwd, env):
                nonlocal counter
                if "build" in command:
                    counter += 1
                    Path(command[command.index("-o") + 1]).write_bytes(f"exe-{counter}".encode())
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                patch.object(
                    BUILDER,
                    "verify_toolchain",
                    return_value={"version": "go1.22.12", "platform": "windows/amd64"},
                ),
                patch.object(BUILDER, "run_process", side_effect=run),
                patch.object(BUILDER, "verify_toolchain_files", return_value={
                    "go_exe_sha256": BUILDER.EXPECTED_GO_EXE_SHA256,
                    "toolchain_file_count": BUILDER.EXPECTED_GO_TOOLCHAIN_FILE_COUNT,
                    "toolchain_inventory_sha256": BUILDER.EXPECTED_GO_TOOLCHAIN_INVENTORY_SHA256,
                }),
            ):
                with self.assertRaisesRegex(BUILDER.BuildError, "SERVICE_EXE_NONDETERMINISTIC"):
                    BUILDER.test_and_build_service(Path("go.exe"), source, root / "build")

    def test_candidate_replaces_old_exe_preserves_runtime_and_records_full_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            old_exe = b"old-carrier-exe"
            new_exe = root / "new.exe"
            new_exe.write_bytes(b"new-source-built-exe")
            bundle = self.make_bundle(root / "carrier", old_exe=old_exe)
            source = self.make_source(root / "repo")
            source_record = BUILDER.source_inventory(source)
            runtime_before = BUILDER.inventory(bundle / "runtime")
            with patch.object(BUILDER, "BASE_SERVICE_EXE_SHA256", BUILDER.sha256_bytes(old_exe)):
                result = BUILDER.assemble_candidate(
                    bundle,
                    new_exe,
                    "d" * 40,
                    {"version": "go1.22.12", "platform": "windows/amd64"},
                    source_record,
                )
            self.assertEqual((bundle / "OPIU_STABLE_Service.exe").read_bytes(), new_exe.read_bytes())
            self.assertEqual(BUILDER.inventory(bundle / "runtime"), runtime_before)
            self.assertNotEqual(result["old_service_exe_sha256"], result["service_exe_sha256"])
            provenance = json.loads((bundle / "SERVICE_BUILD_PROVENANCE.json").read_text(encoding="utf-8"))
            self.assertEqual(provenance["source_inventory"]["files"], source_record["files"])
            self.assertTrue(provenance["deterministic_double_build"])
            self.assertEqual(
                provenance["service_build"]["first_sha256"],
                provenance["service_build"]["second_sha256"],
            )
            self.assertFalse(provenance["release_approved"])
            self.assertFalse(provenance["full_year_financial_e2e_performed"])
            self.assertEqual(provenance["safety"]["posting_rows"], 0)
            self.assertFalse(provenance["safety"]["live_1c_allowed"])
            manifest = json.loads((bundle / "BUNDLE_MANIFEST.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["source_head"], "d" * 40)
            self.assertEqual(manifest["runtime_inventory_sha256"], provenance["runtime_inventory"]["sha256"])

    def test_whole_zip_leakage_claim_distinguishes_inherited_from_new_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            old_exe = b"old-carrier-exe"
            bundle = self.make_bundle(root / "carrier", old_exe=old_exe)
            (bundle / "runtime" / "modules" / "native.node").write_bytes(
                rb"C:\Users\runneradmin\.cargo\source.rs"
            )
            source_record = BUILDER.source_inventory(self.make_source(root / "repo"))
            safe_exe = root / "safe.exe"
            safe_exe.write_bytes(b"source-built-service-with-trimpath")
            with patch.object(BUILDER, "BASE_SERVICE_EXE_SHA256", BUILDER.sha256_bytes(old_exe)):
                result = BUILDER.assemble_candidate(
                    bundle, safe_exe, "d" * 40,
                    {"version": "go1.22.12", "platform": "windows/amd64"},
                    source_record,
                )
            leakage = result["path_leakage"]
            self.assertFalse(leakage["whole_zip_user_profile_path_free"])
            self.assertTrue(leakage["new_build_user_profile_path_free"])
            self.assertTrue(leakage["inherited_carrier_user_profile_paths_present"])
            self.assertEqual(leakage["inherited_carrier_entry_count"], 1)

            inherited_path_exe = rb"old C:\Users\runneradmin\source\service.go"
            unsafe_bundle = self.make_bundle(
                root / "unsafe-carrier",
                old_exe=inherited_path_exe,
            )
            unsafe_exe = root / "unsafe.exe"
            unsafe_exe.write_bytes(rb"new C:\Users\current-user\private path")
            with (
                patch.object(
                    BUILDER,
                    "BASE_SERVICE_EXE_SHA256",
                    BUILDER.sha256_bytes(inherited_path_exe),
                ),
                self.assertRaisesRegex(BUILDER.BuildError, "NEW_BUILD_USER_PROFILE_PATH_LEAK"),
            ):
                BUILDER.assemble_candidate(
                    unsafe_bundle, unsafe_exe, "d" * 40,
                    {"version": "go1.22.12", "platform": "windows/amd64"},
                    source_record,
                )

    def test_missing_or_open_report_only_gate_is_rejected(self) -> None:
        safety = {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "executed_posting_rows": 0,
            "live_posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": False,
            "execution_allowed": False,
            "live_1c_allowed": False,
            "live_delete_allowed": False,
        }
        BUILDER.assert_report_only(safety)
        for key in ("ready_to_upload", "release_allowed", "execution_allowed", "live_1c_allowed"):
            unsafe = dict(safety)
            unsafe.pop(key)
            with self.assertRaisesRegex(BUILDER.BuildError, "REPORT_ONLY_SAFETY_GATE_INVALID"):
                BUILDER.assert_report_only(unsafe)

    def test_archive_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            archive = root / "carrier.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../escape.txt", b"unsafe")
            with self.assertRaisesRegex(BUILDER.BuildError, "UNSAFE_ARCHIVE_ENTRY"):
                BUILDER.checked_extract(archive, root / "extract")

    def test_two_deterministic_zip_outputs_are_byte_identical_and_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            bundle = self.make_bundle(root / "carrier")
            first = root / "first.zip"
            second = root / "second.zip"
            result = BUILDER.write_identical_zip_pair(bundle, first, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(result["first_sha256"], result["second_sha256"])
            self.assertEqual(result["first_output_name"], "first.zip")
            self.assertEqual(result["second_output_name"], "second.zip")
            self.assertNotIn(str(root), json.dumps(result))
            with self.assertRaisesRegex(BUILDER.BuildError, "OUTPUT_ALREADY_EXISTS"):
                BUILDER.write_identical_zip_pair(bundle, first, root / "third.zip")
            with self.assertRaisesRegex(BUILDER.BuildError, "OUTPUT_PATHS_MUST_BE_DISTINCT"):
                BUILDER.write_identical_zip_pair(bundle, root / "same.zip", root / "same.zip")

    def test_second_zip_failure_rolls_back_entire_output_pair(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            bundle = self.make_bundle(root / "carrier")
            first, second = root / "first.zip", root / "second.zip"
            real_write = BUILDER.write_deterministic_zip
            calls = 0

            def fail_second(bundle_path, output_path):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated second output failure")
                return real_write(bundle_path, output_path)

            with (
                patch.object(BUILDER, "write_deterministic_zip", side_effect=fail_second),
                self.assertRaisesRegex(OSError, "simulated second output failure"),
            ):
                BUILDER.write_identical_zip_pair(bundle, first, second)
            self.assertFalse(first.exists())
            self.assertFalse(second.exists())
            self.assertEqual(list(root.glob("*.building")), [])

    def test_readme_contains_only_current_clean_source_contract(self) -> None:
        readme = SCRIPT.with_name("README_RU.md").read_text(encoding="utf-8")
        for obsolete in ("Go 1.23.12", "PR #72", "--integration-head"):
            self.assertNotIn(obsolete, readme)
        self.assertIn("Go 1.22.12", readme)
        self.assertIn("whole_zip_user_profile_path_free=false", readme)


if __name__ == "__main__":
    unittest.main()
