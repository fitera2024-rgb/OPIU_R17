import assert from "node:assert/strict";
import test from "node:test";

import { scopedManifestRunIdentity } from "./correction_engine_r001.mjs";

test("service R001 manifest binds the exact service run while preserving internal engine identity", () => {
  assert.deepEqual(
    scopedManifestRunIdentity("run_service_exact", "20260825T223500000Z_abc123"),
    { run_id: "run_service_exact", engine_run_id: "20260825T223500000Z_abc123" },
  );
  assert.deepEqual(
    scopedManifestRunIdentity("", "20260825T223500000Z_abc123"),
    { run_id: "20260825T223500000Z_abc123", engine_run_id: "20260825T223500000Z_abc123" },
  );
});

test("run scope metadata changes no financial, physical or workbook fields", () => {
  const unchanged = {
    canonical_financial_rows_total: 2,
    ready_financial_rows: 0,
    sporno_financial_rows: 2,
    storno_rows: 1,
    repost_rows: 1,
    amounts: [-244745, 244745],
    output_routes: ["SPORNO", "SPORNO"],
    output_workbooks: ["owner_СПОРНО.xlsx"],
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
  };
  const before = { ...unchanged, run_id: "20260825T223500000Z_abc123" };
  const after = {
    ...unchanged,
    ...scopedManifestRunIdentity("run_service_exact", "20260825T223500000Z_abc123"),
  };
  const withoutIdentity = ({ run_id, engine_run_id, ...rest }) => rest;
  assert.deepEqual(withoutIdentity(after), withoutIdentity(before));
});
