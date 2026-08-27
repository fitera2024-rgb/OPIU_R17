import assert from "node:assert/strict";
import test from "node:test";
import { selectExactDiagnosticCandidate } from "./r005_intalev_diagnostic.mjs";

test("a unique literal full-path node is selected from a repeated-label chain", () => {
  const root = {
    normalized_label: "амортизация",
    normalized_path: "амортизация",
  };
  const child = {
    normalized_label: "амортизация",
    normalized_path: "амортизация / статьи / амортизация",
  };
  assert.equal(
    selectExactDiagnosticCandidate([root, child], "амортизация"),
    root,
  );
});

test("diagnostic selection remains blocked when an exact path is ambiguous", () => {
  const duplicate = { normalized_path: "амортизация" };
  assert.equal(
    selectExactDiagnosticCandidate([duplicate, { ...duplicate }], "амортизация"),
    null,
  );
});
