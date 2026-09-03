from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("build_user_delivery_candidate.py")
VERIFIER_SCRIPT = Path(__file__).with_name("verify_user_delivery_candidate.py")
SPEC = importlib.util.spec_from_file_location("candidate_builder", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class CandidateBuilderContractTest(unittest.TestCase):
    def test_repository_authority_is_checkout_local(self) -> None:
        self.assertEqual(BUILDER.REPO_ROOT, SCRIPT.resolve().parents[2])
        for path in (
            BUILDER.RUNTIME_SOURCE_ROOT,
            BUILDER.OVERLAY_ROOT,
            BUILDER.BACKEND_PROVENANCE,
            BUILDER.UI_OVERLAY_ROOT,
            BUILDER.UI_PROVENANCE,
        ):
            path.resolve().relative_to(BUILDER.REPO_ROOT.resolve())
        builder_source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("Path.home()", builder_source)
        self.assertNotIn("C:\\Users\\NB-FIT", builder_source)

    def test_runtime_source_pins_resolve_and_match(self) -> None:
        root = BUILDER.RUNTIME_SOURCE_ROOT
        for relative, expected in BUILDER.RUNTIME_SOURCE_PINS.items():
            path = root / Path(relative)
            self.assertTrue(path.is_file(), relative)
            self.assertEqual(BUILDER.sha256_file(path), expected, relative)

    def test_require_hash_fails_closed(self) -> None:
        path = BUILDER.RUNTIME_SOURCE_ROOT / Path(next(iter(BUILDER.RUNTIME_SOURCE_PINS)))
        BUILDER.require_hash(path, BUILDER.sha256_file(path), "TEST")
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.require_hash(path, "0" * 64, "TEST")
        with self.assertRaisesRegex(BUILDER.BuildError, r"TEST_MISSING:missing\.mjs"):
            BUILDER.require_hash(path.with_name("missing.mjs"), "0" * 64, "TEST")

    def test_missing_authoritative_provenance_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary) / "BASELINE_PROVENANCE.json"
            with patch.object(BUILDER, "UI_PROVENANCE", missing):
                with self.assertRaisesRegex(
                    BUILDER.BuildError, r"UI_PROVENANCE_MISSING:BASELINE_PROVENANCE\.json"
                ):
                    BUILDER.load_ui_overlay_provenance()

    def test_mismatched_authoritative_provenance_fails_closed(self) -> None:
        value = json.loads(BUILDER.UI_PROVENANCE.read_text(encoding="utf-8"))
        value["files"][0]["overlay_sha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as temporary:
            provenance = Path(temporary) / "BASELINE_PROVENANCE.json"
            provenance.write_text(json.dumps(value), encoding="utf-8")
            with (
                patch.object(BUILDER, "UI_PROVENANCE", provenance),
                patch.object(BUILDER, "PINNED_UI_PROVENANCE_SHA256", BUILDER.sha256_file(provenance)),
            ):
                with self.assertRaisesRegex(
                    BUILDER.BuildError, "UI_PROVENANCE_FILE_SET_MISMATCH"
                ):
                    BUILDER.load_ui_overlay_provenance()

    def test_staging_materializes_allowlist_only(self) -> None:
        fake_common = SimpleNamespace(
            expand_allowlist=lambda _root, _policy: {
                "web/index.html": SimpleNamespace(data=b"pinned-ui")
            }
        )
        source = BUILDER.REPO_ROOT / "synthetic-raw-source-not-read"
        staging = BUILDER.REPO_ROOT / "synthetic-staging-not-written"
        with (
            patch.object(Path, "mkdir"),
            patch.object(Path, "write_bytes") as write_bytes,
            patch.object(BUILDER.shutil, "copy2"),
            patch.object(BUILDER.shutil, "copytree") as copytree,
            patch.object(BUILDER, "require_hash"),
            patch.object(BUILDER, "sha256_file", return_value="A" * 64),
        ):
            pins, count, transform_paths = BUILDER.verify_and_stage_runtime(source, staging, fake_common, {})
        self.assertEqual(count, 1)
        self.assertEqual(transform_paths, [])
        self.assertEqual(set(pins), set(BUILDER.RUNTIME_SOURCE_PINS))
        write_bytes.assert_called_once_with(b"pinned-ui")
        copytree.assert_not_called()

    def test_candidate_policy_requires_both_new_modules(self) -> None:
        policy = BUILDER.make_candidate_policy({
            "source_globs": ["baseline.txt"],
            "transforms": [
                {"path": "web/index.html", "type": "sanitize_web_index"},
                {"path": "VERSION.txt", "type": "version"},
            ],
        })
        self.assertIn("modules/corrections/source/r001_analytical_policy.mjs", policy["source_globs"])
        self.assertIn("modules/corrections/source/r001_handoff_input.mjs", policy["source_globs"])
        self.assertNotIn(
            {"path": "web/index.html", "type": "sanitize_web_index"},
            policy["transforms"],
        )
        self.assertIn({"path": "VERSION.txt", "type": "version"}, policy["transforms"])

    def test_final_runtime_gate_rejects_each_missing_new_module(self) -> None:
        missing_candidates = (
            "r001_analytical_policy.mjs",
            "r001_handoff_input.mjs",
        )
        for missing_name in missing_candidates:
            with self.subTest(missing=missing_name):
                def require_hash(path: Path, _expected: str, _label: str) -> None:
                    if path.name == missing_name:
                        raise BUILDER.BuildError(f"STAGED_RUNTIME_MISSING:{missing_name}")

                with patch.object(BUILDER, "require_hash", side_effect=require_hash):
                    with self.assertRaises(BUILDER.BuildError):
                        BUILDER.verify_candidate_runtime_tree(Path("synthetic-staging"))

    def test_transform_source_path_traversal_is_rejected(self) -> None:
        fake_common = SimpleNamespace(expand_allowlist=lambda _root, _policy: {})
        policy = {"transforms": [{"path": "../outside.json"}]}
        with patch.object(Path, "mkdir"):
            with self.assertRaises(BUILDER.BuildError):
                BUILDER.verify_and_stage_runtime(Path("raw"), Path("staging"), fake_common, policy)

    def test_transform_source_symlink_is_rejected(self) -> None:
        fake_common = SimpleNamespace(expand_allowlist=lambda _root, _policy: {})
        policy = {"transforms": [{"path": "data/defaults/organizations.json"}]}
        with (
            patch.object(Path, "mkdir"),
            patch.object(Path, "is_file", return_value=True),
            patch.object(Path, "is_symlink", return_value=True),
        ):
            with self.assertRaises(BUILDER.BuildError):
                BUILDER.verify_and_stage_runtime(Path("raw"), Path("staging"), fake_common, policy)

    def test_staging_layout_preserves_service_test_contract(self) -> None:
        app, source = BUILDER.staging_layout(Path("staging"))
        self.assertEqual(app.name, "OPIU_User_Service_Green_0.4.5")
        self.assertEqual(source.name, "OPIU_Service_Installer_0.4.5_Source")
        self.assertEqual(app.parent, source.parent)

    def test_go_test_uses_only_bounded_pinned_support(self) -> None:
        builder_source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("shutil.copytree(", builder_source)
        self.assertIn("stage_go_test_support", builder_source)
        self.assertIn("GO_TEST_FORBIDDEN_RUNTIME_DATA", builder_source)

    def test_go_test_nonpayload_support_is_exactly_pinned(self) -> None:
        self.assertEqual(
            set(BUILDER.GO_TEST_NONPAYLOAD_PINS),
            {
                "build_payload.py",
                "web/preview-data-044.js",
                "modules/reconciliation/source/data/reconciliation_decisions.json",
            },
        )

    def test_issue_59_runtime_files_are_in_exact_overlay(self) -> None:
        self.assertIn("pre_run_source_proof.go", BUILDER.EXPECTED_OVERLAY)
        self.assertIn("pre_run_source_proof_test.go", BUILDER.EXPECTED_OVERLAY)
        self.assertIn("rules_engine_bridge.go", BUILDER.EXPECTED_OVERLAY)

    def test_pr72_backend_overlay_provenance_is_exact(self) -> None:
        provenance = BUILDER.verify_backend_overlay()
        self.assertEqual(provenance["change_request"], BUILDER.OVERLAY_CHANGE_REQUEST)
        self.assertEqual(provenance["overlay_files"], BUILDER.EXPECTED_OVERLAY)
        self.assertIn("pre_run_source_proof_ui.go", BUILDER.EXPECTED_OVERLAY)
        self.assertIn("pre_run_source_proof_ui_test.go", BUILDER.EXPECTED_OVERLAY)
        self.assertIn("main.go", BUILDER.EXPECTED_OVERLAY)
        self.assertEqual(len(BUILDER.EXPECTED_OVERLAY), 17)

    def test_pr72_ui_overlay_provenance_is_exact(self) -> None:
        provenance = BUILDER.load_ui_overlay_provenance()
        self.assertEqual(provenance["change_request"], BUILDER.OVERLAY_CHANGE_REQUEST)
        self.assertEqual(set(BUILDER.EXPECTED_UI_OVERLAY), {
            "web/app.js", "web/app.css", "web/index.html",
        })
        self.assertEqual(len(BUILDER.EXPECTED_UI_OVERLAY), 3)

    def test_release_lineage_allows_only_packaging_and_bounded_governance(self) -> None:
        self.assertEqual(
            BUILDER.SOURCE_PRODUCT_HEAD.lower(),
            "a5d033be9aa2df583ed751e7959f7bcdf8429200",
        )
        self.assertIn("development/OPIU_1.9.4/service/packaging/", BUILDER.ALLOWED_RELEASE_DIFFS)
        self.assertIn("governance/changes/CR-REL-20260811-005.md", BUILDER.ALLOWED_RELEASE_DIFFS)
        self.assertFalse(any("20260811-003" in path or "20260811-004" in path for path in BUILDER.ALLOWED_RELEASE_DIFFS))
        self.assertNotIn("development/OPIU_1.9.4/service/backend_overlay/", BUILDER.ALLOWED_RELEASE_DIFFS)
        self.assertNotIn("development/OPIU_1.9.4/service/ui_overlay/", BUILDER.ALLOWED_RELEASE_DIFFS)
        self.assertTrue(BUILDER.release_path_allowed("development/OPIU_1.9.4/service/packaging/file.py"))
        self.assertTrue(BUILDER.release_path_allowed("governance/changes/CR-REL-20260811-005.md"))
        self.assertFalse(BUILDER.release_path_allowed("governance/changes/CR-REL-20260811-005.md.evil"))
        self.assertFalse(BUILDER.release_path_allowed("development/OPIU_1.9.4/service/packaging-evil/file.py"))

    def test_pr72_static_verifier_matches_builder(self) -> None:
        verifier = VERIFIER_SCRIPT.read_text(encoding="utf-8")
        self.assertIn(BUILDER.SOURCE_PRODUCT_HEAD.lower(), verifier.lower())
        self.assertIn(BUILDER.OVERLAY_CHANGE_REQUEST, verifier)
        self.assertIn("PR72_UI_CHANGE_MISSING", verifier)
        self.assertNotIn("PR66_UI_CHANGE_MISSING", verifier)
        for expected in BUILDER.EXPECTED_UI_OVERLAY.values():
            self.assertIn(expected, verifier)

    def test_candidate_manifest_has_explicit_report_only_and_qa_gates(self) -> None:
        builder = SCRIPT.read_text(encoding="utf-8")
        verifier = VERIFIER_SCRIPT.read_text(encoding="utf-8")
        for contract in (
            '"mode": "REPORT_ONLY"',
            '"report_only": True',
            '"independent_qa_status": "INDEPENDENT_QA_PENDING"',
        ):
            self.assertIn(contract, builder)
            self.assertIn(contract, verifier)

    def test_go_cache_and_temp_are_scoped_to_candidate_root(self) -> None:
        root = Path("candidate-root")
        environment, cache, temp = BUILDER.go_environment(root)
        self.assertEqual(cache, root / "go-cache")
        self.assertEqual(temp, root / "go-temp")
        self.assertEqual(Path(environment["GOCACHE"]), cache)
        self.assertEqual(Path(environment["GOTMPDIR"]), temp)

    def test_go_test_success_evidence_excludes_nondeterministic_stdout(self) -> None:
        results = (
            SimpleNamespace(returncode=0, stdout="ok\topiu.service\t1.001s\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="ok\topiu.service\t2.002s\n", stderr=""),
        )
        evidence = []
        for result in results:
            with patch.object(BUILDER.subprocess, "run", return_value=result):
                evidence.append(
                    BUILDER.run_checked(
                        "GO_TEST",
                        ["go", "test", "./..."],
                        Path("staging"),
                        include_stdout_hash=False,
                    )
                )
        self.assertEqual(evidence[0], evidence[1])
        self.assertEqual(evidence[0]["exit_code"], 0)
        self.assertNotIn("stdout_sha256", evidence[0])

    def test_smoke_uses_dotnet_process_without_environment_rewrite(self) -> None:
        smoke = SCRIPT.with_name("Invoke-PortableSmoke.ps1").read_text(encoding="utf-8-sig")
        self.assertNotIn("Start-Process", smoke)
        self.assertIn("[System.Diagnostics.ProcessStartInfo]::new()", smoke)
        self.assertNotIn("EnvironmentVariables", smoke)


if __name__ == "__main__":
    unittest.main()
