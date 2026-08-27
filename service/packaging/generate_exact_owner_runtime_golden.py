#!/usr/bin/env python3
"""Generate the compact exact-OWNER materialized-runtime provenance golden."""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
from pathlib import Path


BUILDER_PATH = Path(__file__).with_name("build_reimplemented_service_bundle.py")
BUILDER_SPEC = importlib.util.spec_from_file_location(
    "opiu_final_bundle_builder",
    BUILDER_PATH,
)
if BUILDER_SPEC is None or BUILDER_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError("FINAL_BUILDER_IMPORT_FAILED")
BUILDER = importlib.util.module_from_spec(BUILDER_SPEC)
BUILDER_SPEC.loader.exec_module(BUILDER)


def generate(runtime_root: Path, source_commit: str) -> dict[str, object]:
    runtime_root = runtime_root.resolve()
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise BUILDER.BundleError("SOURCE_COMMIT_NOT_EXACT")

    manifest = BUILDER.load_json(runtime_root / "MANIFEST.json")
    review_change = manifest.get("review_change")
    integrated_change = manifest.get("integrated_review_change")
    if not isinstance(review_change, dict):
        raise BUILDER.BundleError("OWNER_REVIEW_CHANGE_REQUIRED")
    if not isinstance(integrated_change, dict):
        raise BUILDER.BundleError("INTEGRATED_REVIEW_CHANGE_REQUIRED")

    rows = BUILDER.materialized_payload_inventory_rows(runtime_root)
    inventory_payload = (json.dumps(
        rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n").encode("utf-8")
    inventory_sha256 = BUILDER.sha256_bytes(inventory_payload)
    manifest_sha256 = BUILDER.sha256_file(runtime_root / "MANIFEST.json")
    safety_sha256 = BUILDER.sha256_file(runtime_root / "SAFETY.json")

    BUILDER.validate_r005_catalog_materialized_provenance(
        owner_bundle_sha256=review_change.get("base_bundle_sha256"),
        owner_manifest_drift=review_change.get("base_manifest_drift"),
        file_count=len(rows),
        inventory_sha256=inventory_sha256,
        manifest_sha256=manifest_sha256,
        safety_sha256=safety_sha256,
    )

    return {
        "schema_version": "opiu-exact-owner-runtime-golden.v1",
        "work_id": "OPIU-2026-08-18-REL-13B-FINAL-BUILDER-PROVENANCE-REBIND",
        "source_repository": "fitera2024-rgb/OPIU_STABLE",
        "source_commit": source_commit,
        "integration_overlay_source_commit": integrated_change.get(
            "integration_release_base_commit"
        ),
        "owner_bundle_sha256": review_change.get("base_bundle_sha256"),
        "materialized_payload_file_count": len(rows),
        "materialized_payload_inventory_sha256": inventory_sha256,
        "runtime_manifest_sha256": manifest_sha256,
        "runtime_safety_sha256": safety_sha256,
        "owner_manifest_drift": review_change.get("base_manifest_drift"),
        "files": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    golden = generate(args.runtime_root, args.source_commit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(golden, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "status": "PASS_EXACT_OWNER_RUNTIME_GOLDEN_CREATED",
        "output": str(args.output.resolve()),
        "file_count": golden["materialized_payload_file_count"],
        "inventory_sha256": golden["materialized_payload_inventory_sha256"],
        "manifest_sha256": golden["runtime_manifest_sha256"],
        "safety_sha256": golden["runtime_safety_sha256"],
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (BUILDER.BundleError, OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
