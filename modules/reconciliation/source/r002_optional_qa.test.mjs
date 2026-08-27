import assert from "node:assert/strict";
import test from "node:test";

import { loadR002OperationEvidence } from "./r002_operation_evidence.mjs";

test("legacy pinned R002 QA files are optional in the portable runtime", async () => {
  const result = await loadR002OperationEvidence({
    erpPath: "missing-current-source-is-not-read-by-the-legacy-loader.zip",
    organization: "3 Сахалин",
    mode: "month",
    period: "2025-01",
  });

  assert.equal(result.applicable, false);
  assert.equal(result.status, "NOT_APPLICABLE_LEGACY_R002_QA_NOT_PACKAGED");
  assert.match(result.note, /not a runtime dependency/i);
});
