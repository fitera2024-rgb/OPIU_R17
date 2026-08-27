from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build_reimplemented_service_bundle.py")
SPEC = importlib.util.spec_from_file_location("reimplemented_bundle_golden", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)

GOLDEN_PATH = (
    Path(__file__).with_name("golden") / "REL13B_EXACT_OWNER_RUNTIME.json"
)
REPO_ROOT = SCRIPT.parents[3]
SOURCE_ROOT = SCRIPT.parents[2]


class ExactOwnerRuntimeGoldenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))

    @staticmethod
    def inventory_sha256(rows: list[dict[str, object]]) -> str:
        payload = (json.dumps(
            rows,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n").encode("utf-8")
        return BUNDLE.sha256_bytes(payload)

    @staticmethod
    def git_blob_bytes(source_root: Path, commit: str, relative: str) -> bytes:
        blob_path = f"{REPO_ROOT.name}/{source_root.name}/{relative}"
        result = subprocess.run(
            [
                "git",
                "-C",
                str(REPO_ROOT),
                "show",
                f"{commit}:{blob_path}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            raise AssertionError(
                f"INTEGRATION_OVERLAY_BLOB_READ_ERROR:commit={commit}:path={relative}:stderr={stderr}"
            )
        return result.stdout

    @staticmethod
    def git_blob_sha256(source_root: Path, commit: str, relative: str) -> str:
        return BUNDLE.sha256_bytes(ExactOwnerRuntimeGoldenTest.git_blob_bytes(source_root, commit, relative))

    def validate_strict(
        self,
        *,
        rows: list[dict[str, object]] | None = None,
        file_count: int | None = None,
        inventory_sha256: str | None = None,
        manifest_sha256: str | None = None,
        safety_sha256: str | None = None,
        owner_bundle_sha256: str | None = None,
        owner_manifest_drift: object | None = None,
    ) -> None:
        selected_rows = self.golden["files"] if rows is None else rows
        BUNDLE.validate_r005_catalog_materialized_provenance(
            owner_bundle_sha256=(
                self.golden["owner_bundle_sha256"]
                if owner_bundle_sha256 is None
                else owner_bundle_sha256
            ),
            owner_manifest_drift=(
                self.golden["owner_manifest_drift"]
                if owner_manifest_drift is None
                else owner_manifest_drift
            ),
            file_count=(
                len(selected_rows) if file_count is None else file_count
            ),
            inventory_sha256=(
                self.inventory_sha256(selected_rows)
                if inventory_sha256 is None
                else inventory_sha256
            ),
            manifest_sha256=(
                self.golden["runtime_manifest_sha256"]
                if manifest_sha256 is None
                else manifest_sha256
            ),
            safety_sha256=(
                self.golden["runtime_safety_sha256"]
                if safety_sha256 is None
                else safety_sha256
            ),
        )

    def test_exact_owner_golden_passes_strict_final_builder_validation(self) -> None:
        rows = self.golden["files"]
        paths = [row["path"] for row in rows]
        self.assertEqual(
            self.golden["schema_version"],
            "opiu-exact-owner-runtime-golden.v1",
        )
        self.assertEqual(
            self.golden["source_commit"],
            "7dc94e1cb9102f2e7effd974b94f6f6a64840903",
        )
        self.assertEqual(
            self.golden["integration_overlay_source_commit"],
            BUNDLE.EXPECTED_INTEGRATION_RELEASE_BASE_COMMIT,
        )
        self.assertEqual(paths, sorted(paths))
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(
            len(rows),
            self.golden["materialized_payload_file_count"],
        )
        self.assertEqual(
            self.inventory_sha256(rows),
            self.golden["materialized_payload_inventory_sha256"],
        )
        safety_row = next(row for row in rows if row["path"] == "SAFETY.json")
        self.assertEqual(
            safety_row["sha256"],
            self.golden["runtime_safety_sha256"],
        )
        self.assertEqual(
            set(self.golden["owner_manifest_drift"]),
            set(BUNDLE.EXPECTED_R005_CATALOG_OWNER_MANIFEST_DRIFT),
        )
        self.assertEqual(len(self.golden["owner_manifest_drift"]), 8)
        self.validate_strict()

    def test_golden_overlay_rows_match_exact_repository_sources(self) -> None:
        rows = {row["path"]: row for row in self.golden["files"]}
        source_root = SOURCE_ROOT
        overlay_source_commit = self.golden["integration_overlay_source_commit"]
        for relative, expected_hash in (
            BUNDLE.EXPECTED_INTEGRATION_RELEASE_OVERLAY_HASHES.items()
        ):
            self.assertIn(relative, rows)
            actual_blob_hash = self.git_blob_sha256(
                source_root,
                overlay_source_commit,
                relative,
            )
            self.assertEqual(
                rows[relative]["sha256"],
                expected_hash,
                f"GOLDEN_OVERLAY_ROW_MISMATCH:path={relative}:expected={expected_hash}:actual={rows[relative]['sha256']}",
            )
            self.assertEqual(
                actual_blob_hash,
                expected_hash,
                f"INTEGRATION_OVERLAY_BLOB_MISMATCH:commit={overlay_source_commit}:path={relative}:expected={expected_hash}:actual={actual_blob_hash}",
            )

    def test_432_to_433_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH",
        ):
            self.validate_strict(file_count=433)

    def test_431_to_430_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH",
        ):
            self.validate_strict(file_count=430)

    def test_inventory_sha_mismatch_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_INVENTORY_PROVENANCE_MISMATCH",
        ):
            self.validate_strict(inventory_sha256="0" * 64)

    def test_manifest_sha_mismatch_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_MANIFEST_SHA256_MISMATCH",
        ):
            self.validate_strict(manifest_sha256="0" * 64)

    def test_safety_sha_mismatch_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_R001_SAFETY_SHA256_MISMATCH",
        ):
            self.validate_strict(safety_sha256="0" * 64)

    def test_unexpected_additional_file_fails(self) -> None:
        rows = copy.deepcopy(self.golden["files"])
        rows.append({
            "path": "unexpected/debug.tmp",
            "size": 1,
            "sha256": "0" * 64,
        })
        rows.sort(key=lambda row: str(row["path"]))
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH",
        ):
            self.validate_strict(rows=rows)

    def test_missing_expected_file_fails(self) -> None:
        rows = copy.deepcopy(self.golden["files"])
        rows = [row for row in rows if row["path"] != "VERSION.txt"]
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_FILE_COUNT_MISMATCH",
        ):
            self.validate_strict(rows=rows)

    def test_different_owner_bundle_sha_fails(self) -> None:
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_OWNER_BUNDLE_SHA256_MISMATCH",
        ):
            self.validate_strict(owner_bundle_sha256="0" * 64)

    def test_unexpected_owner_manifest_drift_fails(self) -> None:
        drift = copy.deepcopy(self.golden["owner_manifest_drift"])
        drift["unexpected/debug.mjs"] = {
            "recorded_size": 0,
            "actual_size": 1,
            "recorded_sha256": "0" * 64,
            "actual_sha256": "1" * 64,
        }
        with self.assertRaisesRegex(
            BUNDLE.BundleError,
            "INTEGRATED_RUNTIME_OWNER_MANIFEST_DRIFT_MISMATCH",
        ):
            self.validate_strict(owner_manifest_drift=drift)


if __name__ == "__main__":
    unittest.main()
