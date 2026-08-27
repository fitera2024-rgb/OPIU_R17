import assert from "node:assert/strict";
import test from "node:test";

import { closedStructuralControlGroups } from "./service_r005_owner_wrapper.mjs";

test("only zero-delta structural groups are passed to the post-processing exemption", () => {
  const closed = closedStructuralControlGroups({
    structural_group_control_sets: [
      { id: "ZERO", member_codes: ["R023", "R033"] },
      { id: "NONZERO", member_codes: ["R045", "R055"] },
    ],
    structural_group_control_results: [
      { group_id: "ZERO", classification: "STRUCTURAL_GROUP_SUM_OK" },
      { group_id: "NONZERO", classification: "STRUCTURAL_GROUP_SUM_MISMATCH" },
    ],
  });
  assert.deepEqual(closed.map((group) => group.id), ["ZERO"]);
});

test("no calculated result means no exemption", () => {
  assert.deepEqual(closedStructuralControlGroups({
    structural_group_control_sets: [{ id: "CONFIGURED", member_codes: ["R001", "R002"] }],
  }), []);
});

