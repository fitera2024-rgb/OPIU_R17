from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("build_owner_contract_service_candidate.py")
SPEC = importlib.util.spec_from_file_location("owner_contract_builder", MODULE_PATH)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(BUILDER)


class OwnerContractCandidateTests(unittest.TestCase):
    def make_fixture(self, root: Path) -> tuple[Path, Path]:
        bundle = root / "OPIU"
        runtime = bundle / "runtime"
        repository = root / "repo"
        runtime.mkdir(parents=True)
        (bundle / "OPIU_STABLE_Service.exe").write_bytes(b"verified-service")
        (bundle / "BUNDLE_PROVENANCE.json").write_text(json.dumps({
            "runtime_source_sha": BUILDER.BASE_RUNTIME_SOURCE_SHA,
        }), encoding="utf-8")
        (bundle / "BUNDLE_MANIFEST.json").write_text("{}", encoding="utf-8")
        (runtime / "SAFETY.json").write_text(json.dumps({
            "mode": "REPORT_ONLY", "posting_rows": 0,
            "ready_to_upload": False, "release_allowed": False,
            "execution_allowed": False, "live_1c_allowed": False,
            "live_delete_allowed": False,
        }), encoding="utf-8")
        (runtime / "MANIFEST.json").write_text(json.dumps({"files": []}), encoding="utf-8")
        for relative in BUILDER.PRODUCTION_OVERLAYS:
            source = repository / "development" / "OPIU_1.9.4" / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(f"// {relative}\n", encoding="utf-8")
        return bundle, repository

    def test_overlay_set_is_exact_accepted_production_delta(self) -> None:
        self.assertEqual(set(BUILDER.PRODUCTION_OVERLAYS), {
            "modules/corrections/source/correction_engine_r001.mjs",
            "modules/corrections/source/r001_canonical_output_contract.mjs",
            "modules/corrections/source/r001_materialization_contract.mjs",
            "modules/corrections/source/rules_application_handoff.mjs",
            "modules/reconciliation/source/owner_decision_projection.mjs",
            "modules/reconciliation/source/owner_presentation_block_exemption.mjs",
            "modules/reconciliation/source/economic_route_proof_binding.mjs",
            "modules/reconciliation/source/generic_reclassification_detection.mjs",
            "modules/reconciliation/source/opiu_reconcile.mjs",
            "modules/reconciliation/source/service_r005_owner_wrapper.mjs",
            "modules/reconciliation/source/residual_allocation_proof.mjs",
            "modules/reconciliation/source/structural_control_groups.mjs",
            "modules/reconciliation/source/structural_control_settings_binding.mjs",
            "modules/reconciliation/source/owner_economic_route_proofs/uk9_2025_10_owner_approved.json",
            "modules/rules-engine/source/adapters/r005_adapter.mjs",
            "modules/rules-engine/source/handoff.mjs",
            "modules/rules-engine/source/workflow.mjs",
            "user-settings/Настройка_группировки_блоков.csv",
            "user-settings/КАК_НАСТРОИТЬ_ГРУППИРОВКУ.txt",
        })

    def test_assembly_rebinds_sources_manifests_and_closed_safety(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opiu-owner-contract-builder-test-") as temporary:
            root = Path(temporary)
            bundle, repository = self.make_fixture(root)
            with mock.patch.object(BUILDER, "BASE_SERVICE_EXE_SHA256", BUILDER.sha256(bundle / "OPIU_STABLE_Service.exe")):
                result = BUILDER.assemble_bundle(bundle, repository, "a" * 40, verify_git=False)
            self.assertEqual(set(result["production_overlay_hashes"]), set(BUILDER.PRODUCTION_OVERLAYS))
            safety = json.loads((bundle / "runtime" / "SAFETY.json").read_text(encoding="utf-8"))
            self.assertEqual(safety["posting_rows"], 0)
            self.assertFalse(safety["ready_to_upload"])
            self.assertFalse(safety["release_allowed"])
            self.assertFalse(safety["execution_allowed"])
            self.assertFalse(safety["live_1c_allowed"])
            runtime_manifest = json.loads((bundle / "runtime" / "MANIFEST.json").read_text(encoding="utf-8"))
            self.assertEqual(
                set(runtime_manifest["owner_contract_candidate"]["production_overlay_hashes"]),
                set(BUILDER.PRODUCTION_OVERLAYS),
            )
            self.assertEqual(runtime_manifest["owner_contract_candidate"]["full_year_strategy"], "TWELVE_MONTH_LOCAL_CONTEXTS")
            self.assertFalse(runtime_manifest["owner_contract_candidate"]["cross_month_netting"])
            self.assertEqual(
                runtime_manifest["owner_contract_candidate"]["accepted_rules_handoff_result"],
                BUILDER.ACCEPTED_RULES_HANDOFF_RESULT,
            )
            self.assertEqual(
                runtime_manifest["owner_contract_candidate"]["accepted_r001_sporno_result"],
                BUILDER.ACCEPTED_R001_SPORNO_RESULT,
            )
            self.assertTrue((bundle / "OWNER_CONTRACT_CANDIDATE.json").is_file())
            self.assertNotIn("Загруженные.zip", {item.name for item in bundle.rglob("*")})

    def test_assembly_rejects_open_safety(self) -> None:
        with tempfile.TemporaryDirectory(prefix="opiu-owner-contract-builder-test-") as temporary:
            root = Path(temporary)
            bundle, repository = self.make_fixture(root)
            (bundle / "runtime" / "SAFETY.json").write_text(json.dumps({
                "mode": "REPORT_ONLY", "posting_rows": 0,
                "ready_to_upload": True, "release_allowed": False,
            }), encoding="utf-8")
            with mock.patch.object(BUILDER, "BASE_SERVICE_EXE_SHA256", BUILDER.sha256(bundle / "OPIU_STABLE_Service.exe")):
                with self.assertRaisesRegex(BUILDER.BuildError, "BASE_SAFETY_GATE_OPEN"):
                    BUILDER.assemble_bundle(bundle, repository, "a" * 40, verify_git=False)


if __name__ == "__main__":
    unittest.main()
