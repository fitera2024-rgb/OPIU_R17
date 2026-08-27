from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("build_combined_runtime_service_candidate.py")
SPEC = importlib.util.spec_from_file_location("combined_packaging_hardening", SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BUILDER)


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


class CombinedPackagingHardeningTests(unittest.TestCase):
    def test_every_go_invocation_environment_is_offline(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            environment = BUILDER.BASE.closed_go_environment(Path(raw))
        self.assertEqual(environment.get("GOPROXY"), "off")
        self.assertEqual(environment.get("GOSUMDB"), "off")

    def test_exact_private_carrier_entries_are_removed_and_bundle_is_path_free(self) -> None:
        path = "runtime/private/tool.bin"
        data = b"embedded C:/Users/private/build path"
        expected = {path: (len(data), BUILDER.sha256_bytes(data))}
        with tempfile.TemporaryDirectory() as raw:
            bundle = Path(raw)
            write(bundle / path, data)
            with mock.patch.object(BUILDER, "REMOVED_PRIVATE_CARRIER_FILES", expected):
                removed = BUILDER.remove_exact_private_carrier_files(bundle)
                self.assertEqual(removed["file_count"], 1)
                self.assertFalse((bundle / path).exists())
                leakage = BUILDER.assert_private_path_free(bundle, ())
                self.assertTrue(leakage["whole_zip_user_profile_path_free"])
                self.assertEqual(leakage["private_path_entry_count"], 0)

    def test_all_fourteen_carrier_runtime_references_are_explicit(self) -> None:
        references = BUILDER.PRESERVED_CARRIER_RUNTIME_FILES
        self.assertEqual(len(references), 14)
        self.assertEqual(
            references["node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node"],
            (24231424, "4E5B185CCDFFCEEDE5468B47C4646E2CE66F4E85EC35A753007EC32CB8720498"),
        )
        self.assertEqual(
            references["resources/reference/ОрганизациииерархияЕРП.xlsx"],
            (106560, "3342603C0782FE12871AD55E7E19E778A97651E8CFF2E00F0CE6774295C57522"),
        )
        self.assertEqual(
            references["resources/reference/ПланСчетов_ERP.mxl"],
            (61223, "867E493B4458975D2EF798452F4AD5C249DB9DD378454E5332188D200755A1CD"),
        )

    def test_exact_required_skia_native_is_retained_and_explicitly_acknowledged(self) -> None:
        relative = "runtime/node_modules/@oai/artifact-tool/node_modules/skia-canvas/lib/skia.node"
        data = b"embedded C:/Users/upstream/build path"
        with tempfile.TemporaryDirectory() as raw:
            bundle = Path(raw)
            write(bundle / relative, data)
            binding = {relative: (len(data), BUILDER.sha256_bytes(data))}
            with mock.patch.object(BUILDER, "ACKNOWLEDGED_INHERITED_PRIVATE_PATHS", binding):
                leakage = BUILDER.assert_private_path_free(bundle, ())
            self.assertFalse(leakage["whole_zip_user_profile_path_free"])
            self.assertTrue(leakage["new_build_user_profile_path_free"])
            self.assertTrue(leakage["inherited_carrier_user_profile_paths_present"])
            self.assertEqual(leakage["private_path_entries"], [relative])

    def test_portable_smoke_requires_the_artifact_tool_native_runtime(self) -> None:
        smoke = Path(__file__).with_name("Invoke-PortableSmoke.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("ARTIFACT_TOOL_NATIVE_RUNTIME_MISSING", smoke)
        self.assertIn("ARTIFACT_TOOL_NATIVE_RUNTIME_LOAD_FAILED", smoke)
        self.assertIn("artifact_tool_native_verified = $true", smoke)


if __name__ == "__main__":
    unittest.main()
