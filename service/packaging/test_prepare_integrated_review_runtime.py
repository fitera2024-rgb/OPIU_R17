from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("prepare_integrated_review_runtime.py")
SPEC = importlib.util.spec_from_file_location("integrated_runtime", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
INTEGRATED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INTEGRATED)


class IntegratedRuntimePrepareTest(unittest.TestCase):
    PINNED_R005_CATALOG_RESULT_COMMIT = "d" * 40

    def make_catalog_source_root(self, root: Path) -> tuple[Path, dict[str, str]]:
        source_root = root / "source"
        for relative in (
            list(INTEGRATED.CORRECTIONS_OVERLAY_HASHES)
        ):
            source = INTEGRATED.SOURCE_ROOT / Path(relative)
            target = source_root / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())

        catalog_hashes: dict[str, str] = {}
        for relative in INTEGRATED.R005_CATALOG_OVERLAY_HASHES:
            data = f"catalog:{relative}".encode("utf-8")
            target = source_root / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            catalog_hashes[relative] = INTEGRATED.R005.sha256_bytes(data)
        return source_root, catalog_hashes

    def make_prepared_runtime(self, root: Path, *, unsafe: bool = False) -> Path:
        runtime = root / "runtime"
        safety = {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": unsafe,
            "one_c_actions_executed": False,
            "live_1c_allowed": False,
        }
        files: dict[str, bytes] = {
            relative: f"old:{relative}".encode("utf-8")
            for relative in INTEGRATED.RULES_OVERLAY_HASHES
        }
        files.update({
            "runtime/node/node.exe": b"node",
            "data/defaults/settings.json": b"{}",
            "resources/reference/reference.txt": b"reference",
            "modules/corrections/source/node_modules/jszip/package.json": b"{}",
            "modules/corrections/source/correction_engine_r001.mjs": b"old-r001",
            "modules/corrections/source/rules_application_handoff.mjs": b"old-handoff",
            "VERSION.txt": b"1.9.4\n",
        })
        files["SAFETY.json"] = (json.dumps(safety) + "\n").encode("utf-8")
        rows = []
        for relative, data in files.items():
            path = runtime / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            rows.append({
                "path": relative,
                "size": len(data),
                "sha256": INTEGRATED.R005.sha256_bytes(data),
                "classification": "ENGINE_RUNTIME",
                "source": "synthetic-prepared-r005",
            })
        manifest = {
            "schema": "opiu-package-manifest.v2",
            "package_id": "OPIU_SERVICE_PAYLOAD_1.9.4",
            "version": "1.9.4",
            "review_change": {
                "change_request": INTEGRATED.R005.CHANGE_REQUEST,
                "base_bundle_sha256": INTEGRATED.R005.BASE_BUNDLE_SHA256,
            },
            "safety": {
                "mode": "REPORT_ONLY",
                "posting_rows": 0,
                "ready_to_upload": False,
                "release_allowed": False,
            },
            "protected_core": [{
                "path": "modules/reconciliation/source/opiu_reconcile.mjs",
                "sha256": "0" * 64,
            }],
            "files": rows,
        }
        (runtime / "MANIFEST.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return runtime

    def test_exact_rules_and_r001_overlay_rebinds_manifest_and_safety(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            runtime = self.make_prepared_runtime(root)
            source_root, catalog_hashes = self.make_catalog_source_root(root)
            base_hash = INTEGRATED.sha256_file(runtime / "MANIFEST.json")
            with (
                patch.object(
                    INTEGRATED,
                    "EXPECTED_PREPARED_R005_MANIFEST_SHA256",
                    base_hash,
                ),
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                patch.object(INTEGRATED, "SOURCE_ROOT", source_root),
                patch.dict(
                    INTEGRATED.R005_CATALOG_OVERLAY_HASHES,
                    catalog_hashes,
                    clear=True,
                ),
            ):
                result = INTEGRATED.overlay_integrated_changes(runtime)

            self.assertEqual(result["status"], "PASS_INTEGRATED_REVIEW_RUNTIME_PREPARED")
            self.assertEqual(result["rules_overlay_hashes"], INTEGRATED.RULES_OVERLAY_HASHES)
            self.assertEqual(
                result["integration_release_overlay_hashes"],
                INTEGRATED.INTEGRATION_RELEASE_OVERLAY_HASHES,
            )
            manifest = json.loads((runtime / "MANIFEST.json").read_text(encoding="utf-8"))
            change = manifest["integrated_review_change"]
            self.assertEqual(
                change["change_requests"],
                [
                    INTEGRATED.R005.CHANGE_REQUEST,
                    INTEGRATED.R001_CHANGE_REQUEST,
                    INTEGRATED.R005_CATALOG_CHANGE_REQUEST,
                ],
            )
            self.assertEqual(change["rules_overlay_hashes"], INTEGRATED.RULES_OVERLAY_HASHES)
            self.assertEqual(
                change["corrections_overlay_hashes"],
                INTEGRATED.CORRECTIONS_OVERLAY_HASHES,
            )
            self.assertEqual(change["r001_base_commit"], INTEGRATED.R001_BASE_COMMIT)
            self.assertEqual(change["r001_result_commit"], INTEGRATED.R001_RESULT_COMMIT)
            self.assertEqual(
                change["integration_release_overlay_hashes"],
                INTEGRATED.INTEGRATION_RELEASE_OVERLAY_HASHES,
            )
            self.assertFalse(change["integration_release_packaging_only"])
            self.assertFalse(change["rules_report_controls_fix"])
            self.assertFalse(change["rules_output_safety_passport_fix"])
            self.assertFalse(change["rules_financial_logic_changed"])
            self.assertTrue(change["r001_cross_source_dedup_fix"])
            self.assertTrue(change["r001_financial_logic_changed"])
            self.assertTrue(change["r005_intalev_catalog_auto_binding"])
            self.assertFalse(change["r005_catalog_financial_logic_changed"])
            self.assertFalse(change["r005_organization_crosswalk_verified"])
            self.assertEqual(change["uk9_2025_twelve_month_final_audit"], "PENDING")
            self.assertEqual(change["package_bound_crosswalk"], "NOT_INCLUDED")
            self.assertEqual(change["distribution_status"], "TEST_REPORT_ONLY")
            self.assertFalse(change["user_delivery_approved"])
            self.assertFalse(change["financial_correctness_verified"])
            self.assertEqual(
                change["materialized_payload_file_count"],
                result["materialized_payload_file_count"],
            )
            self.assertEqual(
                change["materialized_payload_inventory_sha256"],
                result["materialized_payload_inventory_sha256"],
            )
            safety = json.loads((runtime / "SAFETY.json").read_text(encoding="utf-8"))
            self.assertEqual(safety["posting_rows"], 0)
            self.assertFalse(safety["execution_allowed"])
            self.assertFalse(safety["ready_to_upload"])
            self.assertFalse(safety["release_allowed"])
            self.assertFalse(safety["live_1c_allowed"])
            self.assertFalse(safety["rules_report_controls_changed"])
            self.assertFalse(safety["rules_output_safety_passport_fix"])
            self.assertTrue(safety["r001_cross_source_dedup_fix"])
            self.assertTrue(safety["r001_financial_logic_changed"])
            self.assertTrue(safety["r005_intalev_catalog_auto_binding"])
            self.assertFalse(safety["r005_organization_crosswalk_verified"])
            self.assertFalse(safety["uk9_2025_twelve_month_final_audit_passed"])
            self.assertEqual(
                manifest["protected_core"][0]["sha256"],
                catalog_hashes["modules/reconciliation/source/opiu_reconcile.mjs"],
            )
            for relative, expected_hash in INTEGRATED.CORRECTIONS_OVERLAY_HASHES.items():
                self.assertEqual(
                    INTEGRATED.sha256_file(runtime / relative), expected_hash
                )
            for relative, expected_hash in catalog_hashes.items():
                self.assertEqual(
                    INTEGRATED.sha256_file(runtime / relative), expected_hash
                )

    def test_unexpected_prepared_r005_manifest_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_prepared_runtime(Path(raw))
            with (
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "PREPARED_R005_MANIFEST_MISMATCH",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_unpinned_r005_catalog_result_commit_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_prepared_runtime(Path(raw))
            with (
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    "PENDING_OWNER_R005_COMMIT",
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "R005_CATALOG_RESULT_COMMIT_NOT_PINNED",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_rules_source_hash_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            runtime = self.make_prepared_runtime(root)
            source_root, _ = self.make_catalog_source_root(root)
            base_hash = INTEGRATED.sha256_file(runtime / "MANIFEST.json")
            first = next(iter(INTEGRATED.CORRECTIONS_OVERLAY_HASHES))
            with (
                patch.object(
                    INTEGRATED,
                    "EXPECTED_PREPARED_R005_MANIFEST_SHA256",
                    base_hash,
                ),
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                patch.object(INTEGRATED, "SOURCE_ROOT", source_root),
                patch.dict(
                    INTEGRATED.CORRECTIONS_OVERLAY_HASHES,
                    {first: "0" * 64},
                    clear=False,
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "CORRECTIONS_OVERLAY_SOURCE_HASH_MISMATCH",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_r001_corrections_source_hash_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_prepared_runtime(Path(raw))
            base_hash = INTEGRATED.sha256_file(runtime / "MANIFEST.json")
            first = next(
                iter(INTEGRATED.CORRECTIONS_OVERLAY_HASHES)
            )
            with (
                patch.object(
                    INTEGRATED,
                    "EXPECTED_PREPARED_R005_MANIFEST_SHA256",
                    base_hash,
                ),
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                patch.dict(
                    INTEGRATED.CORRECTIONS_OVERLAY_HASHES,
                    {first: "0" * 64},
                    clear=False,
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "CORRECTIONS_OVERLAY_SOURCE_HASH_MISMATCH",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_unsafe_prepared_runtime_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runtime = self.make_prepared_runtime(Path(raw), unsafe=True)
            with (
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "RUNTIME_SAFETY_CONTRACT_FAILED",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_r005_catalog_source_hash_drift_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            runtime = self.make_prepared_runtime(root)
            source_root, catalog_hashes = self.make_catalog_source_root(root)
            base_hash = INTEGRATED.sha256_file(runtime / "MANIFEST.json")
            first = next(
                iter(catalog_hashes)
            )
            catalog_hashes[first] = "0" * 64
            with (
                patch.object(
                    INTEGRATED,
                    "EXPECTED_PREPARED_R005_MANIFEST_SHA256",
                    base_hash,
                ),
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                patch.object(INTEGRATED, "SOURCE_ROOT", source_root),
                patch.dict(
                    INTEGRATED.R005_CATALOG_OVERLAY_HASHES,
                    catalog_hashes,
                    clear=True,
                ),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "R005_CATALOG_OVERLAY_SOURCE_HASH_MISMATCH",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)

    def test_r005_catalog_repository_sources_match_pins_after_rebase(self) -> None:
        missing = [
            relative
            for relative in INTEGRATED.R005_CATALOG_OVERLAY_HASHES
            if not (INTEGRATED.SOURCE_ROOT / Path(relative)).is_file()
        ]
        if missing:
            self.skipTest("R005 catalog result commit not rebased into packaging branch")
        for relative, expected_hash in INTEGRATED.R005_CATALOG_OVERLAY_HASHES.items():
            self.assertEqual(
                INTEGRATED.sha256_file(INTEGRATED.SOURCE_ROOT / Path(relative)),
                expected_hash,
            )

    def test_current_authoritative_source_missing_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            runtime = self.make_prepared_runtime(root)
            source_root, _ = self.make_catalog_source_root(root)
            missing = next(iter(INTEGRATED.CORRECTIONS_OVERLAY_HASHES))
            (source_root / Path(missing)).unlink()
            base_hash = INTEGRATED.sha256_file(runtime / "MANIFEST.json")
            with (
                patch.object(
                    INTEGRATED,
                    "EXPECTED_PREPARED_R005_MANIFEST_SHA256",
                    base_hash,
                ),
                patch.object(
                    INTEGRATED,
                    "R005_CATALOG_RESULT_COMMIT",
                    self.PINNED_R005_CATALOG_RESULT_COMMIT,
                ),
                patch.object(INTEGRATED, "SOURCE_ROOT", source_root),
                self.assertRaisesRegex(
                    INTEGRATED.IntegratedPrepareError,
                    "CORRECTIONS_OVERLAY_SOURCE_MISSING",
                ),
            ):
                INTEGRATED.overlay_integrated_changes(runtime)


if __name__ == "__main__":
    unittest.main()
