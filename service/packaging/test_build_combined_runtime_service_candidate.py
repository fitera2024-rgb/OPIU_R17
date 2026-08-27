from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("build_combined_runtime_service_candidate.py")
SPEC = importlib.util.spec_from_file_location(
    "build_combined_runtime_service_candidate",
    SCRIPT,
)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILDER)


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def row(path: str, data: bytes, **extra: str) -> dict[str, object]:
    return {
        "path": path,
        "size": len(data),
        "sha256": BUILDER.sha256_bytes(data),
        **extra,
    }


def write_managed_fixture(product: Path) -> None:
    for root in BUILDER.MANAGED_RUNTIME_ROOTS:
        if root == "user-settings":
            for relative in BUILDER.GIT_BOUND_USER_SETTINGS:
                write(product / relative, f"fixture:{relative}\n".encode("utf-8"))
        else:
            write(product / root / "tracked.mjs", b"export const value = 1;\n")


class CombinedPackagingTests(unittest.TestCase):
    def test_structural_control_and_proof_chain_is_an_explicit_fail_closed_closure(self) -> None:
        runtime_rows = [row(path, f"runtime:{path}".encode("utf-8"))
                        for path in BUILDER.REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES]
        service_rows = [row(path, f"service:{path}".encode("utf-8"))
                        for path in BUILDER.REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES]
        runtime = BUILDER.record_from_rows(runtime_rows)
        service = BUILDER.record_from_rows(service_rows)

        proof = BUILDER.verify_structural_control_packaging_closure(runtime, service)
        self.assertEqual(proof["status"], "VERIFIED_EXACT_GIT_HEAD_CLOSURE")
        self.assertEqual(proof["runtime_file_count"], 14)
        self.assertEqual(proof["service_source_file_count"], 10)
        self.assertFalse(proof["correction_authority"])
        self.assertEqual(proof["financial_rows"], 0)
        self.assertEqual(proof["posting_rows"], 0)
        self.assertIn(
            "modules/reconciliation/source/structural_control_report_detail.mjs",
            proof["runtime_files"],
        )
        self.assertIn(
            "modules/corrections/source/service_r005_r001_handoff.mjs",
            proof["runtime_files"],
        )
        self.assertIn("structural_control_proof_pipeline.go", proof["service_source_files"])

        for missing in BUILDER.REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES:
            incomplete = BUILDER.record_from_rows(
                item for item in runtime_rows if item["path"] != missing
            )
            with self.assertRaisesRegex(
                BUILDER.BuildError,
                "STRUCTURAL_CONTROL_RUNTIME_CLOSURE_MISSING",
            ):
                BUILDER.verify_structural_control_packaging_closure(incomplete, service)

        for missing in BUILDER.REQUIRED_STRUCTURAL_CONTROL_SERVICE_SOURCE_FILES:
            incomplete = BUILDER.record_from_rows(
                item for item in service_rows if item["path"] != missing
            )
            with self.assertRaisesRegex(
                BUILDER.BuildError,
                "STRUCTURAL_CONTROL_SERVICE_SOURCE_CLOSURE_MISSING",
            ):
                BUILDER.verify_structural_control_packaging_closure(runtime, incomplete)

    def test_reviewed_runtime_roots_and_carrier_only_set_are_exact(self) -> None:
        self.assertEqual(
            BUILDER.MANAGED_RUNTIME_ROOTS,
            (
                "modules/corrections/source",
                "modules/corrections/contracts",
                "modules/reconciliation/source",
                "user-settings",
            ),
        )
        self.assertEqual(len(BUILDER.PRESERVED_CARRIER_RUNTIME_FILES), 14)
        self.assertEqual(len(BUILDER.GIT_BOUND_RUNTIME_DATA_FILES), 25)
        self.assertIn(
            "modules/corrections/contracts/schemas/service_r005_r001_handoff.schema.json",
            BUILDER.GIT_BOUND_RUNTIME_DATA_FILES,
        )
        self.assertIn(
            "modules/reconciliation/source/resources/ОПИУ_по_образцу_ШАБЛОН.xlsx",
            BUILDER.PRESERVED_CARRIER_RUNTIME_FILES,
        )

    def test_exact_current_head_runtime_inventory_is_complete(self) -> None:
        repository = SCRIPT.parents[2]
        head = subprocess.check_output(
            ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True,
        ).strip()
        record = BUILDER.exact_runtime_overlay_inventory(repository, head)
        paths = {item["path"] for item in record["files"]}
        self.assertEqual(record["file_count"], len(record["files"]))
        self.assertGreaterEqual(record["file_count"], 145)
        self.assertIn(record["git_object_format"], {"sha1", "sha256"})
        self.assertEqual(record["dependency_scan"]["missing"], 0)
        proof = BUILDER.verify_structural_control_packaging_closure(
            record,
            BUILDER.exact_service_source_inventory(repository, head),
        )
        self.assertEqual(proof["runtime_files"], sorted(BUILDER.REQUIRED_STRUCTURAL_CONTROL_RUNTIME_FILES))
        self.assertIn(
            "modules/reconciliation/source/structural_control_inventory_v2.mjs",
            paths,
        )
        self.assertIn(
            "modules/reconciliation/source/structural_control_settings_binding.mjs",
            paths,
        )
        self.assertTrue({
            "modules/corrections/source/r001_group_scoped_posting_rule.mjs",
            "modules/corrections/source/r001_group_scoped_materialization.mjs",
            "modules/corrections/source/r001_hierarchy_authority.mjs",
            "modules/corrections/source/r001_reconciliation_workbook_adapter.mjs",
        }.issubset(paths))
        self.assertEqual(paths & BUILDER.GIT_BOUND_USER_SETTINGS, BUILDER.GIT_BOUND_USER_SETTINGS)

    def test_legacy_rules_runtime_is_removed_and_not_required(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            bundle = Path(raw)
            for relative in BUILDER.LEGACY_RULES_RUNTIME_PATHS:
                target = bundle / relative
                if target.suffix:
                    write(target, b"legacy rules")
                else:
                    write(target / "legacy.mjs", b"legacy rules")
            proof = BUILDER.remove_legacy_rules_runtime(bundle)
            self.assertGreater(proof["file_count"], 0)
            self.assertTrue(all(not (bundle / relative).exists()
                                for relative in BUILDER.LEGACY_RULES_RUNTIME_PATHS))
            self.assertNotIn("rules-engine", BUILDER.MODULE_NAMES)

    def test_exact_inventory_rejects_ignored_extra_runtime_input(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw)
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.email", "qa@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.name", "QA"], check=True)
            product = repository / BUILDER.PRODUCT_ROOT_RELATIVE
            write_managed_fixture(product)
            write(repository / ".gitignore", b"ignored.mjs\n")
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repository), "commit", "-qm", "fixture"], check=True)
            head = subprocess.check_output(
                ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True,
            ).strip()
            write(product / BUILDER.MANAGED_RUNTIME_ROOTS[0] / "ignored.mjs", b"ignored")
            with self.assertRaisesRegex(BUILDER.BuildError, "RUNTIME_OVERLAY_WORKING_TREE_MISMATCH"):
                BUILDER.exact_runtime_overlay_inventory(repository, head)

    def test_exact_inventory_rejects_changed_git_blob(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw)
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.email", "qa@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.name", "QA"], check=True)
            product = repository / BUILDER.PRODUCT_ROOT_RELATIVE
            write_managed_fixture(product)
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repository), "commit", "-qm", "fixture"], check=True)
            head = subprocess.check_output(
                ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True,
            ).strip()
            write(product / BUILDER.MANAGED_RUNTIME_ROOTS[0] / "tracked.mjs", b"changed")
            with self.assertRaisesRegex(BUILDER.BuildError, "RUNTIME_OVERLAY_NOT_EXACT_GIT_BLOB"):
                BUILDER.exact_runtime_overlay_inventory(repository, head)

    def test_dependency_closure_accepts_present_and_rejects_missing(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            product = Path(raw)
            source_path = "modules/reconciliation/source/a.mjs"
            dependency_path = "modules/reconciliation/source/b.mjs"
            write(product / source_path, b'import value from "./b.mjs";\n')
            write(product / dependency_path, b"export default 1;\n")
            valid = BUILDER.record_from_rows((
                row(source_path, (product / source_path).read_bytes()),
                row(dependency_path, (product / dependency_path).read_bytes()),
            ))
            self.assertEqual(BUILDER.verify_relative_dependency_closure(product, valid)["missing"], 0)
            invalid = BUILDER.record_from_rows((row(source_path, (product / source_path).read_bytes()),))
            with self.assertRaisesRegex(BUILDER.BuildError, "RUNTIME_OVERLAY_DEPENDENCY_MISSING"):
                BUILDER.verify_relative_dependency_closure(product, invalid)

    def test_exact_inventory_rejects_new_business_file_formats(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw)
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.email", "qa@example.invalid"], check=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.name", "QA"], check=True)
            product = repository / BUILDER.PRODUCT_ROOT_RELATIVE
            write_managed_fixture(product)
            write(product / "user-settings" / "extra.csv", b"not,allowed\n")
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repository), "commit", "-qm", "fixture"], check=True)
            head = subprocess.check_output(
                ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True,
            ).strip()
            with self.assertRaisesRegex(BUILDER.BuildError, "RUNTIME_OVERLAY_USER_SETTINGS_SET_MISMATCH"):
                BUILDER.exact_runtime_overlay_inventory(repository, head)

    def test_carrier_closure_allows_only_exact_bound_reference(self) -> None:
        relative = "modules/reconciliation/source/resources/reference.bin"
        data = b"immutable reference"
        with tempfile.TemporaryDirectory() as raw:
            bundle = Path(raw)
            write(bundle / "runtime" / relative, data)
            overlay = BUILDER.record_from_rows(())
            expected = {relative: (len(data), BUILDER.sha256_bytes(data))}
            with mock.patch.object(BUILDER, "PRESERVED_CARRIER_RUNTIME_FILES", expected):
                record = BUILDER.verify_carrier_managed_closure(bundle, overlay)
                self.assertEqual(record["file_count"], 1)
                write(bundle / "runtime" / relative, b"drift")
                with self.assertRaisesRegex(BUILDER.BuildError, "CARRIER_REFERENCE_HASH_MISMATCH"):
                    BUILDER.verify_carrier_managed_closure(bundle, overlay)
                write(bundle / "runtime/modules/reconciliation/source/unbound.bin", b"extra")
                with self.assertRaisesRegex(BUILDER.BuildError, "CARRIER_RUNTIME_CLOSURE_MISMATCH"):
                    BUILDER.verify_carrier_managed_closure(bundle, overlay)

    def test_changed_git_bound_user_settings_overlay_bundle_and_bind_manifest(self) -> None:
        head = "d" * 40
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            product = root / "product"
            bundle = root / "bundle"
            rows = []
            for index, relative in enumerate(sorted(BUILDER.GIT_BOUND_USER_SETTINGS)):
                data = f"current-setting-{index}\n".encode("utf-8")
                write(product / relative, data)
                write(bundle / relative, b"stale-carrier-setting\n")
                rows.append(row(relative, data, git_blob="e" * 40, git_mode="100644"))
            overlay = BUILDER.record_from_rows(rows)
            BUILDER.apply_runtime_overlay(bundle, product, overlay)
            BUILDER.verify_overlay_rows(bundle, overlay["files"])
            self.assertFalse((bundle / "runtime" / "user-settings").exists())

            runtime = bundle / "runtime"
            runtime.mkdir(parents=True, exist_ok=True)
            manifest = BUILDER.write_runtime_manifest(
                runtime,
                head,
                overlay,
                BUILDER.record_from_rows(()),
                BUILDER.record_from_rows(()),
                {"go_exe_sha256": "f" * 64},
                {"packaged_sha256": "a" * 64},
            )
            self.assertEqual(manifest["runtime_overlay_inventory"], overlay)
            persisted = json.loads((runtime / "MANIFEST.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["runtime_overlay_inventory"], overlay)

    def test_output_inside_repository_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            repository = Path(raw) / "repo"
            repository.mkdir()
            with self.assertRaisesRegex(BUILDER.BuildError, "OUTPUT_INSIDE_SOURCE_REPOSITORY"):
                BUILDER.assert_outputs_outside_repository(repository, repository / "candidate.zip")

    def test_private_path_checks_reject_every_marker(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            bundle = Path(raw)
            leak = bundle / "leak.txt"
            write(leak, b"C:/Users/private/source")
            with self.assertRaisesRegex(BUILDER.BuildError, "PRIVATE_PATH_LEAK"):
                BUILDER.assert_private_path_free(bundle, ())
            leak.unlink()
            write(bundle / "exact.txt", b"D:/review/private/repo")
            with self.assertRaisesRegex(BUILDER.BuildError, "PRIVATE_PATH_LEAK"):
                BUILDER.assert_private_path_free(
                    bundle, (Path("D:/review/private/repo"),),
                )

    def test_closed_safety_rejects_stale_publication_and_release_claims(self) -> None:
        head = "a" * 40
        valid = {
            "candidate_status": "REPORT_ONLY_REVIEW_CANDIDATE",
            "artifact_publication_authorized_by_owner": False,
            "release_approved": False,
            "live_1c_approved": False,
            "safety": BUILDER.closed_safety(head),
        }
        BUILDER.assert_closed_safety_document(valid)
        for field in (
            "artifact_publication_authorized_by_owner",
            "release_approved",
            "live_1c_approved",
        ):
            stale = dict(valid)
            stale[field] = True
            with self.assertRaisesRegex(BUILDER.BuildError, "STALE_APPROVAL_CLAIM"):
                BUILDER.assert_closed_safety_document(stale)
        stale_status = dict(valid, candidate_status="OWNER_AUTHORIZED_REPORT_ONLY_RELEASE_ARTIFACT")
        with self.assertRaisesRegex(BUILDER.BuildError, "STALE_RELEASE_ARTIFACT_STATUS"):
            BUILDER.assert_closed_safety_document(stale_status)

    def test_module_manifests_are_rebound_and_closed(self) -> None:
        head = "b" * 40
        with tempfile.TemporaryDirectory() as raw:
            runtime = Path(raw)
            data = b"export default 1;\n"
            relative = "modules/reconciliation/source/current.mjs"
            write(runtime / relative, data)
            for module in BUILDER.MODULE_NAMES:
                (runtime / "modules" / module).mkdir(parents=True, exist_ok=True)
            overlay = BUILDER.record_from_rows((row(
                relative, data, git_blob="c" * 40, git_mode="100644",
            ),))
            carrier = BUILDER.record_from_rows(())
            BUILDER.write_module_manifests(runtime, head, overlay, carrier)
            for module in BUILDER.MODULE_NAMES:
                manifest = json.loads(
                    (runtime / "modules" / module / "MODULE_MANIFEST.json").read_text(encoding="utf-8"),
                )
                self.assertEqual(manifest["source_head"], head)
                self.assertEqual(manifest["runtime_source_sha"], head)
                self.assertFalse(manifest["artifact_publication_authorized_by_owner"])
                BUILDER.assert_closed_safety_document(manifest)

    def test_verified_zip_pair_is_deterministic_and_atomic_on_second_validation_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            bundle = root / "bundle"
            write(bundle / BUILDER.SERVICE_EXE_NAME, b"new service")
            write(bundle / "runtime" / "SAFETY.json", b"{}\n")
            first = root / "first.zip"
            second = root / "second.zip"
            result = BUILDER.write_verified_zip_pair(bundle, first, second)
            self.assertTrue(result["byte_identical"])
            self.assertEqual(first.read_bytes(), second.read_bytes())

            rollback_a = root / "rollback-a.zip"
            rollback_b = root / "rollback-b.zip"
            original = BUILDER.validate_zip_entries
            calls = 0

            def fail_second(path: Path, source: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise BUILDER.BuildError("SIMULATED_B_VALIDATION_FAILURE")
                original(path, source)

            with mock.patch.object(BUILDER, "validate_zip_entries", side_effect=fail_second):
                with self.assertRaisesRegex(BUILDER.BuildError, "SIMULATED_B_VALIDATION_FAILURE"):
                    BUILDER.write_verified_zip_pair(bundle, rollback_a, rollback_b)
            self.assertFalse(rollback_a.exists())
            self.assertFalse(rollback_b.exists())

    def test_unsafe_carrier_archive_entries_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            traversal = root / "traversal.zip"
            with zipfile.ZipFile(traversal, "w") as archive:
                archive.writestr("../escape.txt", b"bad")
            with self.assertRaisesRegex(BUILDER.BuildError, "CARRIER_ZIP_ENTRY_UNSAFE"):
                BUILDER.validate_carrier_entries(traversal)

            collision = root / "collision.zip"
            with zipfile.ZipFile(collision, "w") as archive:
                archive.writestr("OPIU/runtime", b"file")
                archive.writestr("OPIU/runtime/child.txt", b"child")
            with self.assertRaisesRegex(BUILDER.BuildError, "CARRIER_ZIP_FILE_DIRECTORY_COLLISION"):
                BUILDER.validate_carrier_entries(collision)

    def test_cli_failure_is_public_code_only(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--carrier", "missing.zip",
                "--repository", ".",
                "--go-exe", "missing-go.exe",
                "--output-a", "a.zip",
                "--output-b", "b.zip",
                "--source-head", "0" * 40,
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(completed.returncode, 2)
        public = json.loads(completed.stderr)
        self.assertEqual(public["status"], "BUILD_BLOCKED")
        self.assertNotIn("Users", completed.stderr)
        self.assertNotIn("\\", completed.stderr)


if __name__ == "__main__":
    unittest.main()
