from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("build_reimplemented_service_bundle.py")
SPEC = importlib.util.spec_from_file_location("reimplemented_bundle", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class ReimplementedBundleTest(unittest.TestCase):
    def make_payload(self, root: Path, *, unsafe: bool = False) -> Path:
        payload = root / "payload"
        files = {
            "runtime/node/node.exe": b"node",
            "modules/reconciliation/source/opiu_reconcile.mjs": b"r005",
            "modules/corrections/source/correction_engine_r001.mjs": b"r001",
            "modules/corrections/source/node_modules/jszip/package.json": b"{}",
            "data/defaults/settings.json": b"{}",
            "resources/reference/reference.txt": b"reference",
            "VERSION.txt": b"1.9.4\n",
        }
        safety = {
            "mode": "REPORT_ONLY",
            "posting_rows": 0,
            "ready_to_upload": False,
            "release_allowed": unsafe,
            "one_c_actions_executed": False,
            "live_1c_allowed": False,
        }
        files["SAFETY.json"] = (json.dumps(safety) + "\n").encode()
        for relative, data in files.items():
            path = payload / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        manifest_rows = [
            {
                "path": relative,
                "size": len(data),
                "sha256": BUNDLE.sha256_bytes(data),
            }
            for relative, data in files.items()
        ]
        manifest = {
            "schema": "opiu-package-manifest.v2",
            "package_id": "OPIU_SERVICE_PAYLOAD_1.9.4",
            "version": "1.9.4",
            "safety": {
                "mode": "REPORT_ONLY",
                "posting_rows": 0,
                "ready_to_upload": False,
                "release_allowed": False,
                "live_1c_allowed": False,
            },
            "files": manifest_rows,
        }
        (payload / "MANIFEST.json").write_text(json.dumps(manifest) + "\n")
        return payload

    def apply_integration_release_overlay(
        self,
        payload: Path,
        rows: dict[str, dict[str, object]],
    ) -> None:
        # Kept as a compatibility helper: the retired historical carrier
        # overlay is intentionally empty.
        self.assertEqual(BUNDLE.EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES, {})

    def make_integrated_payload(
        self,
        root: Path,
        *,
        apply_release_overlay: bool = True,
    ) -> Path:
        payload = self.make_payload(root)
        manifest_path = payload / "MANIFEST.json"
        manifest = json.loads(manifest_path.read_text())
        rows = {
            str(row["path"]): row
            for row in manifest["files"]
        }
        source_root = SCRIPT.parents[2]
        for relative, expected_hash in BUNDLE.EXPECTED_RULES_REPORT_CONTROLS_HASHES.items():
            source = source_root / Path(relative)
            data = source.read_bytes()
            self.assertEqual(BUNDLE.sha256_bytes(data), expected_hash)
            path = payload / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            rows[relative] = {
                "path": relative,
                "size": len(data),
                "sha256": expected_hash,
            }
        for relative, expected_hash in BUNDLE.EXPECTED_R001_CORRECTIONS_HASHES.items():
            source = source_root / Path(relative)
            data = source.read_bytes()
            self.assertEqual(BUNDLE.sha256_bytes(data), expected_hash)
            path = payload / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            rows[relative] = {
                "path": relative,
                "size": len(data),
                "sha256": expected_hash,
            }
        if apply_release_overlay:
            self.apply_integration_release_overlay(payload, rows)
        safety_path = payload / "SAFETY.json"
        runtime_safety = json.loads(safety_path.read_text())
        runtime_safety.update({
            "execution_allowed": False,
            "rules_report_controls_changed": False,
            "rules_output_safety_passport_fix": False,
            "r001_cross_source_dedup_fix": True,
            "r001_financial_logic_changed": True,
            "r001_change_request": "CR-R001-20260816-CROSS-SOURCE-DEDUP-001",
        })
        safety_data = (json.dumps(runtime_safety) + "\n").encode()
        safety_path.write_bytes(safety_data)
        rows["SAFETY.json"] = {
            "path": "SAFETY.json",
            "size": len(safety_data),
            "sha256": BUNDLE.sha256_bytes(safety_data),
        }
        manifest["files"] = list(rows.values())
        manifest["safety"].update({
            "execution_allowed": False,
            "live_1c_allowed": False,
            "rules_report_controls_changed": False,
            "rules_financial_logic_changed": False,
            "rules_output_safety_passport_fix": False,
            "r001_cross_source_dedup_fix": True,
            "r001_financial_logic_changed": True,
            "financial_correctness_verified": False,
        })
        manifest["integrated_review_change"] = {
            "schema_version": "opiu-integrated-runtime-review.v1",
            "prepared_r005_manifest_sha256": BUNDLE.EXPECTED_PREPARED_R005_MANIFEST_SHA256,
            "change_requests": BUNDLE.EXPECTED_INTEGRATED_CHANGE_REQUESTS,
            "rules_overlay_hashes": BUNDLE.EXPECTED_RULES_REPORT_CONTROLS_HASHES,
            "integration_release_overlay_hashes":
                BUNDLE.EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES,
            "integration_release_packaging_only": False,
            "rules_safety_overlay_hashes": BUNDLE.EXPECTED_RULES_OUTPUT_SAFETY_HASHES,
            "rules_report_controls_fix": False,
            "rules_output_safety_passport_fix": False,
            "rules_financial_logic_changed": False,
            "r001_base_commit": BUNDLE.EXPECTED_R001_BASE_COMMIT,
            "r001_result_commit": BUNDLE.EXPECTED_R001_RESULT_COMMIT,
            "corrections_overlay_hashes": BUNDLE.EXPECTED_R001_CORRECTIONS_HASHES,
            "r001_cross_source_dedup_fix": True,
            "r001_financial_logic_changed": True,
            "financial_correctness_verified": False,
        }
        manifest_path.write_text(json.dumps(manifest) + "\n")
        materialized = BUNDLE.materialized_payload_inventory(payload)
        manifest["integrated_review_change"].update({
            "materialized_payload_file_count": materialized["file_count"],
            "materialized_payload_inventory_sha256": materialized["sha256"],
        })
        manifest_path.write_text(json.dumps(manifest) + "\n")
        return payload

    def make_r005_catalog_payload(self, root: Path) -> Path:
        payload = self.make_integrated_payload(root, apply_release_overlay=False)
        manifest_path = payload / "MANIFEST.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["review_change"] = {
            "base_bundle_sha256":
                BUNDLE.EXPECTED_R005_CATALOG_OWNER_BUNDLE_SHA256,
            "base_manifest_drift":
                BUNDLE.EXPECTED_R005_CATALOG_OWNER_MANIFEST_DRIFT,
        }
        rows = {str(row["path"]): row for row in manifest["files"]}
        source_root = SCRIPT.parents[2]
        catalog_hashes = {}
        for relative in BUNDLE.EXPECTED_R005_CATALOG_HASHES:
            data = (source_root / Path(relative)).read_bytes()
            expected_hash = BUNDLE.sha256_bytes(data)
            catalog_hashes[relative] = expected_hash
            path = payload / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            rows[relative] = {
                "path": relative,
                "size": len(data),
                "sha256": expected_hash,
            }
        self.apply_integration_release_overlay(payload, rows)

        safety_path = payload / "SAFETY.json"
        runtime_safety = json.loads(safety_path.read_text())
        runtime_safety.update({
            "execution_allowed": False,
            "rules_report_controls_changed": False,
            "rules_output_safety_passport_fix": False,
            "r005_intalev_catalog_auto_binding": True,
            "r005_catalog_financial_logic_changed": False,
            "r005_organization_crosswalk_verified": False,
            "uk9_2025_twelve_month_final_audit_passed": False,
            "r005_catalog_change_request":
                "CR-R005-20260817-INTALEV-CATALOG-AUTO-BINDING-001",
        })
        safety_data = (json.dumps(runtime_safety) + "\n").encode()
        safety_path.write_bytes(safety_data)
        rows["SAFETY.json"] = {
            "path": "SAFETY.json",
            "size": len(safety_data),
            "sha256": BUNDLE.sha256_bytes(safety_data),
        }

        change = manifest["integrated_review_change"]
        change.update({
            "prepared_r005_manifest_sha256":
                BUNDLE.EXPECTED_R005_CATALOG_PREPARED_R005_MANIFEST_SHA256,
            "change_requests": BUNDLE.EXPECTED_R005_CATALOG_CHANGE_REQUESTS,
            "rules_safety_overlay_hashes":
                BUNDLE.EXPECTED_RULES_OUTPUT_SAFETY_HASHES,
            "rules_output_safety_passport_fix": False,
            "r005_catalog_base_commit": BUNDLE.EXPECTED_R005_CATALOG_BASE_COMMIT,
            "r005_catalog_result_commit": BUNDLE.EXPECTED_R005_CATALOG_RESULT_COMMIT,
            "r005_catalog_handoff_head": BUNDLE.EXPECTED_R005_CATALOG_HANDOFF_HEAD,
            "r005_catalog_overlay_hashes": catalog_hashes,
            "r005_intalev_catalog_auto_binding": True,
            "r005_catalog_financial_logic_changed": False,
            "r005_organization_crosswalk_verified": False,
            "uk9_2025_twelve_month_final_audit": "PENDING",
            "package_bound_crosswalk": "NOT_INCLUDED",
            "distribution_status": "TEST_REPORT_ONLY",
            "user_delivery_approved": False,
        })
        manifest["files"] = list(rows.values())
        manifest["safety"].update({
            "rules_report_controls_changed": False,
            "rules_output_safety_passport_fix": False,
            "r005_intalev_catalog_auto_binding": True,
            "r005_catalog_financial_logic_changed": False,
            "r005_organization_crosswalk_verified": False,
            "uk9_2025_twelve_month_final_audit_passed": False,
        })
        manifest_path.write_text(json.dumps(manifest) + "\n")
        materialized = BUNDLE.materialized_payload_inventory(payload)
        change.update({
            "materialized_payload_file_count": materialized["file_count"],
            "materialized_payload_inventory_sha256": materialized["sha256"],
        })
        manifest_path.write_text(json.dumps(manifest) + "\n")
        return payload

    def test_build_materializes_shared_dependencies_and_review_only_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"service")
            result = BUNDLE.build(payload, service, root / "out")
            bundle_root = Path(result["bundle_root"])
            self.assertTrue((bundle_root / "runtime/node_modules/jszip/package.json").is_file())
            self.assertFalse((bundle_root / "runtime/modules/corrections/source/node_modules").exists())
            provenance = json.loads((bundle_root / "BUNDLE_PROVENANCE.json").read_text())
            self.assertEqual(provenance["implementation"], "NEW_COMPATIBLE_IMPLEMENTATION")
            self.assertFalse(provenance["safety"]["release_allowed"])
            with zipfile.ZipFile(result["zip_path"]) as archive:
                names = archive.namelist()
            self.assertTrue(any(name.endswith("/OPIU_STABLE_Service.exe") for name in names))

    def test_unsafe_runtime_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root, unsafe=True)
            service = root / "service.exe"
            service.write_bytes(b"service")
            with self.assertRaises(BUNDLE.BundleError):
                BUNDLE.build(payload, service, root / "out")

    def test_retired_rules_runtime_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            legacy = payload / "modules/rules-engine/source/cli.mjs"
            legacy.parent.mkdir(parents=True)
            legacy.write_bytes(b"legacy-rules")
            with self.assertRaisesRegex(
                BUNDLE.BundleError,
                "LEGACY_RULES_RUNTIME_PRESENT:modules/rules-engine",
            ):
                BUNDLE.validate_payload(payload)

    def test_owner_green_service_is_recorded_without_changing_safety(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"owner-green-service")
            result = BUNDLE.build(
                payload,
                service,
                root / "out",
                "OWNER_GREEN_SERVICE_EXACT",
            )
            provenance = json.loads(
                (Path(result["bundle_root"]) / "BUNDLE_PROVENANCE.json").read_text()
            )
            self.assertEqual(provenance["implementation"], "OWNER_GREEN_SERVICE_EXACT")
            self.assertTrue(provenance["green_ui_preserved"])
            self.assertTrue(provenance["rules_ui_preserved"])
            self.assertFalse(provenance["source_persistence_fix"])
            self.assertFalse(provenance["safety"]["release_allowed"])

    def test_green_persistence_fix_preserves_ui_rules_and_safety(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"green-service-with-source-persistence-fix")
            result = BUNDLE.build(
                payload,
                service,
                root / "out",
                "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
            )
            provenance = json.loads(
                (Path(result["bundle_root"]) / "BUNDLE_PROVENANCE.json").read_text()
            )
            self.assertEqual(
                provenance["implementation"],
                "OWNER_GREEN_SERVICE_PERSISTENCE_FIX",
            )
            self.assertTrue(provenance["green_ui_preserved"])
            self.assertTrue(provenance["rules_ui_preserved"])
            self.assertTrue(provenance["source_persistence_fix"])
            self.assertEqual(provenance["safety"]["posting_rows"], 0)
            self.assertFalse(provenance["safety"]["release_allowed"])

    def test_rules_bulk_fix_records_persistence_ui_and_report_only_safety(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"green-service-with-rules-bulk-fix")
            result = BUNDLE.build(
                payload,
                service,
                root / "out",
                "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
            )
            provenance = json.loads(
                (Path(result["bundle_root"]) / "BUNDLE_PROVENANCE.json").read_text()
            )
            self.assertEqual(
                provenance["implementation"],
                "OWNER_GREEN_SERVICE_PERSISTENCE_RULES_BULK_FIX",
            )
            self.assertTrue(provenance["green_ui_preserved"])
            self.assertTrue(provenance["green_theme_preserved"])
            self.assertFalse(provenance["green_ui_assets_identical"])
            self.assertTrue(provenance["rules_ui_preserved"])
            self.assertTrue(provenance["source_persistence_fix"])
            self.assertTrue(provenance["rules_ui_changed"])
            self.assertTrue(provenance["rules_bulk_decision_fix"])
            self.assertEqual(provenance["safety"]["posting_rows"], 0)
            self.assertFalse(provenance["safety"]["ready_to_upload"])
            self.assertFalse(provenance["safety"]["release_allowed"])

    def test_integrated_r001_dedup_requires_and_records_exact_runtime_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_integrated_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"integrated-green-service")
            service_second = root / "service-second.exe"
            service_second.write_bytes(service.read_bytes())
            service_source = root / "service-source"
            (service_source / "web").mkdir(parents=True)
            (service_source / "web_tests").mkdir()
            (service_source / "main.go").write_text("package main\n")
            (service_source / "go.mod").write_text("module test\n")
            (service_source / "web/results-ui.js").write_text("// integrated ui\n")
            (service_source / "web/index.html").write_text("<html></html>\n")
            (service_source / "web_tests/results-ui.test.cjs").write_text("// test\n")
            change = json.loads((payload / "MANIFEST.json").read_text())[
                "integrated_review_change"
            ]
            manifest_hash = BUNDLE.sha256_file(payload / "MANIFEST.json")
            safety_hash = BUNDLE.sha256_file(payload / "SAFETY.json")
            with (
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_FILE_COUNT",
                    change["materialized_payload_file_count"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_INVENTORY_SHA256",
                    change["materialized_payload_inventory_sha256"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_INTEGRATED_RUNTIME_MANIFEST_SHA256",
                    manifest_hash,
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_INTEGRATED_RUNTIME_SAFETY_SHA256",
                    safety_hash,
                ),
                patch.object(
                    BUNDLE,
                    "verify_source_commit",
                    return_value="a" * 40,
                ),
            ):
                result = BUNDLE.build(
                    payload,
                    service,
                    root / "out",
                    BUNDLE.INTEGRATED_R001_DEDUP_IMPLEMENTATION,
                    service_second,
                    service_source,
                    "a" * 40,
                )
            provenance = json.loads(
                (Path(result["bundle_root"]) / "BUNDLE_PROVENANCE.json").read_text()
            )
            self.assertEqual(provenance["implementation"], BUNDLE.INTEGRATED_R001_DEDUP_IMPLEMENTATION)
            self.assertTrue(provenance["green_theme_preserved"])
            self.assertFalse(provenance["green_ui_assets_identical"])
            self.assertTrue(provenance["source_persistence_fix"])
            self.assertTrue(provenance["rules_bulk_decision_fix"])
            self.assertFalse(provenance["rules_report_controls_fix"])
            self.assertTrue(provenance["r001_result_contract_fix"])
            self.assertTrue(provenance["r001_result_readiness_fix"])
            self.assertTrue(provenance["r001_cross_source_dedup_fix"])
            self.assertTrue(provenance["r001_financial_logic_changed"])
            self.assertTrue(provenance["embedded_web_assets_changed"])
            self.assertFalse(provenance["runtime_rules_changed"])
            self.assertEqual(
                provenance["runtime_change_requests"],
                BUNDLE.EXPECTED_INTEGRATED_CHANGE_REQUESTS,
            )
            self.assertEqual(
                provenance["runtime_rules_overlay_hashes"],
                BUNDLE.EXPECTED_RULES_REPORT_CONTROLS_HASHES,
            )
            self.assertEqual(
                provenance["runtime_corrections_overlay_hashes"],
                BUNDLE.EXPECTED_R001_CORRECTIONS_HASHES,
            )
            self.assertEqual(provenance["runtime_integration_release_work_id"], "")
            self.assertEqual(provenance["runtime_integration_release_base_commit"], "")
            self.assertEqual(
                provenance["runtime_integration_release_overlay_hashes"],
                BUNDLE.EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES,
            )
            self.assertEqual(provenance["r001_base_commit"], BUNDLE.EXPECTED_R001_BASE_COMMIT)
            self.assertEqual(provenance["r001_result_commit"], BUNDLE.EXPECTED_R001_RESULT_COMMIT)
            self.assertFalse(provenance["financial_correctness_verified"])
            self.assertEqual(provenance["safety"]["posting_rows"], 0)
            self.assertFalse(provenance["safety"]["release_allowed"])
            self.assertTrue(provenance["service_build"]["deterministic_double_build"])
            self.assertEqual(provenance["service_build"]["source_commit"], "a" * 40)
            self.assertEqual(
                provenance["service_build"]["embedded_results_ui_sha256"],
                BUNDLE.sha256_file(service_source / "web/results-ui.js"),
            )

    def test_integrated_r001_dedup_rejects_nondeterministic_service_exe(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_integrated_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"first")
            service_second = root / "service-second.exe"
            service_second.write_bytes(b"second")
            service_source = root / "service-source"
            (service_source / "web").mkdir(parents=True)
            (service_source / "web_tests").mkdir()
            (service_source / "main.go").write_text("package main\n")
            (service_source / "web/results-ui.js").write_text("// integrated ui\n")
            change = json.loads((payload / "MANIFEST.json").read_text())[
                "integrated_review_change"
            ]
            manifest_hash = BUNDLE.sha256_file(payload / "MANIFEST.json")
            safety_hash = BUNDLE.sha256_file(payload / "SAFETY.json")
            with (
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_FILE_COUNT",
                    change["materialized_payload_file_count"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_INVENTORY_SHA256",
                    change["materialized_payload_inventory_sha256"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_INTEGRATED_RUNTIME_MANIFEST_SHA256",
                    manifest_hash,
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_INTEGRATED_RUNTIME_SAFETY_SHA256",
                    safety_hash,
                ),
                self.assertRaisesRegex(
                    BUNDLE.BundleError,
                    "SERVICE_EXE_NONDETERMINISTIC",
                ),
            ):
                BUNDLE.build(
                    payload,
                    service,
                    root / "out",
                    BUNDLE.INTEGRATED_R001_DEDUP_IMPLEMENTATION,
                    service_second,
                    service_source,
                    "b" * 40,
                )

    def test_r005_catalog_test_bundle_records_pending_audit_and_closed_live_gates(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_r005_catalog_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"integrated-r005-catalog-service")
            service_second = root / "service-second.exe"
            service_second.write_bytes(service.read_bytes())
            service_source = root / "service-source"
            (service_source / "web").mkdir(parents=True)
            (service_source / "web_tests").mkdir()
            (service_source / "main.go").write_text("package main\n")
            (service_source / "go.mod").write_text("module test\n")
            (service_source / "web/results-ui.js").write_text("// integrated ui\n")
            (service_source / "web/index.html").write_text("<html></html>\n")
            (service_source / "web_tests/results-ui.test.cjs").write_text("// test\n")
            change = json.loads((payload / "MANIFEST.json").read_text())[
                "integrated_review_change"
            ]
            manifest_hash = BUNDLE.sha256_file(payload / "MANIFEST.json")
            safety_hash = BUNDLE.sha256_file(payload / "SAFETY.json")
            with (
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_HASHES",
                    {
                        relative: BUNDLE.sha256_file(SCRIPT.parents[2] / Path(relative))
                        for relative in BUNDLE.EXPECTED_R005_CATALOG_HASHES
                    },
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_FILE_COUNT",
                    change["materialized_payload_file_count"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_INVENTORY_SHA256",
                    change["materialized_payload_inventory_sha256"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_RUNTIME_MANIFEST_SHA256",
                    manifest_hash,
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_RUNTIME_SAFETY_SHA256",
                    safety_hash,
                ),
                patch.object(BUNDLE, "verify_source_commit", return_value="e" * 40),
            ):
                result = BUNDLE.build(
                    payload,
                    service,
                    root / "out",
                    BUNDLE.INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
                    service_second,
                    service_source,
                    "e" * 40,
                )
            provenance = json.loads(
                (Path(result["bundle_root"]) / "BUNDLE_PROVENANCE.json").read_text()
            )
            self.assertFalse(provenance["rules_output_safety_passport_fix"])
            self.assertTrue(provenance["r005_intalev_catalog_auto_binding"])
            self.assertFalse(provenance["r005_catalog_financial_logic_changed"])
            self.assertFalse(provenance["r005_organization_crosswalk_verified"])
            self.assertEqual(
                provenance["uk9_2025_twelve_month_final_audit"],
                "PENDING",
            )
            self.assertEqual(provenance["package_bound_crosswalk"], "NOT_INCLUDED")
            self.assertEqual(provenance["distribution_status"], "TEST_REPORT_ONLY")
            self.assertFalse(provenance["user_delivery_approved"])
            self.assertTrue(provenance["review_output_download_capability_preserved"])
            self.assertFalse(provenance["safety"]["upload_to_1c_executed"])
            self.assertFalse(provenance["safety"]["live_1c_allowed"])

    def test_r005_catalog_test_bundle_rejects_crosswalk_claim(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_r005_catalog_payload(root)
            manifest_path = payload / "MANIFEST.json"
            manifest = json.loads(manifest_path.read_text())
            change = manifest["integrated_review_change"]
            change["r005_organization_crosswalk_verified"] = True
            manifest_path.write_text(json.dumps(manifest) + "\n")
            with (
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_HASHES",
                    {
                        relative: BUNDLE.sha256_file(SCRIPT.parents[2] / Path(relative))
                        for relative in BUNDLE.EXPECTED_R005_CATALOG_HASHES
                    },
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_FILE_COUNT",
                    change["materialized_payload_file_count"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_MATERIALIZED_PAYLOAD_INVENTORY_SHA256",
                    change["materialized_payload_inventory_sha256"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_R005_CATALOG_RUNTIME_MANIFEST_SHA256",
                    BUNDLE.sha256_file(manifest_path),
                ),
                self.assertRaisesRegex(
                    BUNDLE.BundleError,
                    "INTEGRATED_RUNTIME_R005_CROSSWALK_CLAIM_INVALID",
                ),
            ):
                BUNDLE.validate_implementation_payload(
                    payload,
                    manifest,
                    BUNDLE.INTEGRATED_R005_CATALOG_TEST_IMPLEMENTATION,
                )

    def test_integrated_r001_dedup_rejects_corrections_hash_set_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_integrated_payload(root)
            manifest_path = payload / "MANIFEST.json"
            manifest = json.loads(manifest_path.read_text())
            change = manifest["integrated_review_change"]
            change["corrections_overlay_hashes"] = {
                **change["corrections_overlay_hashes"],
                "modules/corrections/source/correction_engine_r001.mjs": "0" * 64,
            }
            manifest_path.write_text(json.dumps(manifest) + "\n")
            with (
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_FILE_COUNT",
                    change["materialized_payload_file_count"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_MATERIALIZED_PAYLOAD_INVENTORY_SHA256",
                    change["materialized_payload_inventory_sha256"],
                ),
                patch.object(
                    BUNDLE,
                    "EXPECTED_INTEGRATED_RUNTIME_MANIFEST_SHA256",
                    BUNDLE.sha256_file(manifest_path),
                ),
                self.assertRaisesRegex(
                    BUNDLE.BundleError,
                    "INTEGRATED_RUNTIME_CORRECTIONS_HASH_SET_MISMATCH",
                ),
            ):
                BUNDLE.validate_implementation_payload(
                    payload,
                    manifest,
                    BUNDLE.INTEGRATED_R001_DEDUP_IMPLEMENTATION,
                )

    def test_integrated_r001_dedup_rejects_stale_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            payload = self.make_payload(root)
            service = root / "service.exe"
            service.write_bytes(b"integrated-green-service")
            with self.assertRaisesRegex(
                BUNDLE.BundleError,
                "INTEGRATED_RUNTIME_PROVENANCE_REQUIRED",
            ):
                BUNDLE.build(
                    payload,
                    service,
                    root / "out",
                    BUNDLE.INTEGRATED_R001_DEDUP_IMPLEMENTATION,
                )

    def test_service_source_commit_rejects_dirty_tree(self) -> None:
        claimed = "c" * 40
        responses = [
            SimpleNamespace(returncode=0, stdout=claimed + "\n", stderr=""),
            SimpleNamespace(returncode=0, stdout=" M web/results-ui.js\n", stderr=""),
        ]
        with (
            patch.object(BUNDLE.subprocess, "run", side_effect=responses),
            self.assertRaisesRegex(
                BUNDLE.BundleError,
                "SERVICE_SOURCE_WORKTREE_NOT_CLEAN",
            ),
        ):
            BUNDLE.verify_source_commit(Path("synthetic-source"), claimed)

    def test_new_implementation_records_source_provenance_when_requested(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            service = root / "service.exe"
            service.write_bytes(b"fresh-service")
            service_second = root / "service-second.exe"
            service_second.write_bytes(b"fresh-service")
            service_source = root / "service-source"
            (service_source / "web").mkdir(parents=True)
            (service_source / "web_tests").mkdir()
            (service_source / "main.go").write_text("package main\n")
            (service_source / "go.mod").write_text("module test\n")
            (service_source / "IMPLEMENTATION_PROVENANCE.json").write_text("{}\n")
            (service_source / "web/results-ui.js").write_text("// ui\n")
            (service_source / "web/index.html").write_text("<html></html>\n")
            with patch.object(BUNDLE, "verify_source_commit", return_value="d" * 40):
                provenance = BUNDLE.validate_service_build_provenance(
                    "NEW_COMPATIBLE_IMPLEMENTATION",
                    service,
                    service_second,
                    service_source,
                    "d" * 40,
                )
            self.assertTrue(provenance["deterministic_double_build"])
            self.assertEqual(provenance["source_commit"], "d" * 40)
            self.assertEqual(
                provenance["embedded_results_ui_sha256"],
                BUNDLE.sha256_file(service_source / "web/results-ui.js"),
            )

    def test_smoke_verifies_served_embedded_results_ui_hash(self) -> None:
        smoke = SCRIPT.with_name("Invoke-PortableSmoke.ps1").read_text(
            encoding="utf-8-sig"
        )
        self.assertIn("/results-ui.js", smoke)
        self.assertIn("embedded_results_ui_sha256", smoke)
        self.assertIn("EMBEDDED_RESULTS_UI_HASH_MISMATCH", smoke)
        self.assertIn("embedded_results_ui_verified", smoke)


if __name__ == "__main__":
    unittest.main()
