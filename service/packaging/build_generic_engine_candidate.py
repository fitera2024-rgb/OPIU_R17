#!/usr/bin/env python3
"""Build a deterministic REPORT_ONLY generic-engine candidate from a proven bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

WORK_ID = "OPIU-2026-08-20-GENERIC-MULTIPERIOD-MULTIORG-YEAR-ENGINE"
FIXED_ZIP_TIME = (2026, 8, 20, 0, 0, 0)
OVERLAYS = (
    "modules/corrections/source/correction_engine_r001.mjs",
    "modules/corrections/source/owner_decision_r001.mjs",
    "modules/corrections/source/r001_analytical_policy.mjs",
    "modules/corrections/source/r001_sporno_materialization.mjs",
    "modules/corrections/source/service_r001_owner_wrapper.mjs",
    "modules/reconciliation/source/arbitrary_period_operation_evidence.mjs",
    "modules/reconciliation/source/opiu_reconcile.mjs",
    "modules/reconciliation/source/owner_decision_projection.mjs",
    "modules/reconciliation/source/service_r005_owner_wrapper.mjs",
)
# Vendored node_modules are required runtime dependencies. Only transient/build
# state is forbidden from the portable candidate.
FORBIDDEN_PARTS = {".git", "__pycache__", ".pytest_cache", "work", "tmp", "temp"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def files(root: Path) -> list[Path]:
    return sorted((path for path in root.rglob("*") if path.is_file()), key=lambda p: p.relative_to(root).as_posix())


def inventory(root: Path, excluded: set[str] | None = None) -> list[dict[str, object]]:
    excluded = excluded or set()
    return [
        {"path": path.relative_to(root).as_posix(), "size": path.stat().st_size, "sha256": sha256(path)}
        for path in files(root)
        if path.relative_to(root).as_posix() not in excluded
    ]


def update_runtime_manifest(runtime: Path, source_head: str) -> None:
    path = runtime / "MANIFEST.json"
    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    by_path = {row["path"]: row for row in manifest.get("files", [])}
    for relative in OVERLAYS:
        target = runtime / relative
        by_path[relative] = {
            "path": relative,
            "size": target.stat().st_size,
            "sha256": sha256(target),
            "classification": "RUNTIME_SOURCE",
            "source": f"{WORK_ID}: authoritative source at {source_head}",
        }
    manifest["files"] = [by_path[key] for key in sorted(by_path)]
    manifest["generic_engine_candidate"] = {
        "work_id": WORK_ID,
        "source_head": source_head,
        "period_modes": ["month", "quarter", "year"],
        "organization_scope": "SOURCE_DRIVEN",
        "physical_source_proof_separate_from_economic_correction_proof": True,
    }
    safety = manifest.setdefault("safety", {})
    safety.update({
        "mode": "REPORT_ONLY", "posting_rows": 0, "ready_to_upload": False,
        "release_allowed": False, "live_1c_allowed": False, "execution_allowed": False,
    })
    path.write_bytes(json_bytes(manifest))


def write_zip(root: Path, output: Path) -> None:
    if output.exists():
        raise FileExistsError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files(root):
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(f"OPIU/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def build(base: Path, repository: Path, executable: Path, output: Path, source_head: str) -> dict[str, object]:
    for required in (base / "runtime", base / "ЗАПУСТИТЬ_OPIU_STABLE.cmd", executable):
        if not required.exists():
            raise FileNotFoundError(required)
    with tempfile.TemporaryDirectory(prefix="opiu-generic-engine-") as temporary:
        bundle = Path(temporary) / "OPIU"
        shutil.copytree(base, bundle)
        shutil.copy2(executable, bundle / "OPIU_STABLE_Service.exe")
        overlay_hashes: dict[str, str] = {}
        for relative in OVERLAYS:
            source = repository / "development/OPIU_1.9.4" / relative
            target = bundle / "runtime" / relative
            if not source.is_file():
                raise FileNotFoundError(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            overlay_hashes[relative] = sha256(target)
        update_runtime_manifest(bundle / "runtime", source_head)
        leaked = [p.relative_to(bundle).as_posix() for p in bundle.rglob("*") if any(part.lower() in FORBIDDEN_PARTS for part in p.relative_to(bundle).parts)]
        if leaked:
            raise RuntimeError(f"forbidden package paths: {leaked[:10]}")
        candidate = {
            "schema": "opiu-generic-engine-candidate.v1",
            "work_id": WORK_ID,
            "source_head": source_head,
            "base_bundle_id": base.name,
            "base_bundle_inventory_sha256": hashlib.sha256(json_bytes(inventory(base))).hexdigest().upper(),
            "service_exe_sha256": sha256(bundle / "OPIU_STABLE_Service.exe"),
            "overlay_hashes": overlay_hashes,
            "safety": {"mode": "REPORT_ONLY", "posting_rows": 0, "ready_to_upload": False, "release_allowed": False, "live_1c_allowed": False},
        }
        (bundle / "GENERIC_ENGINE_MANIFEST.json").write_bytes(json_bytes(candidate))
        provenance = bundle / "BUNDLE_PROVENANCE.json"
        if provenance.exists():
            value = json.loads(provenance.read_text(encoding="utf-8-sig"))
            value["generic_engine_candidate"] = candidate
            provenance.write_bytes(json_bytes(value))
        bundle_manifest = bundle / "BUNDLE_MANIFEST.json"
        manifest = dict(candidate)
        manifest["files"] = inventory(bundle, {"BUNDLE_MANIFEST.json"})
        manifest["file_count"] = len(manifest["files"])
        bundle_manifest.write_bytes(json_bytes(manifest))
        write_zip(bundle, output)
    return {"status": "BUILT", "package": str(output), "size": output.stat().st_size, "sha256": sha256(output), **candidate}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-head", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.base.resolve(), args.repository.resolve(), args.executable.resolve(), args.output.resolve(), args.source_head), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
