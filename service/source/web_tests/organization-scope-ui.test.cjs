const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8");

test("organization selector keeps stable node id separate from business name and hierarchy path", () => {
  assert.match(app, /option\.value\s*=\s*node\.node_id\s*;/,
    "option value must be the stable organization node_id");
  assert.match(app, /option\.dataset\.organizationName\s*=\s*node\.name\s*;/,
    "organization name must be retained separately from the stable id");
  assert.match(app, /option\.dataset\.organizationPath\s*=\s*node\.path\s*;/,
    "organization hierarchy path must be retained separately from the stable id");
  assert.doesNotMatch(app, /option\.value\s*=\s*node\.path\s*\|\|/,
    "name/path fallback must not become structural organization identity");
});

test("context request sends exact organization id, name and path as separate fields", () => {
  assert.match(app, /selectedOptions\s*\[\s*0\s*\]/,
    "context creation must read the selected organization option metadata");
  assert.match(app, /organization_id\s*:/,
    "context request is missing organization_id");
  assert.match(app, /organization_name\s*:/,
    "context request is missing organization_name");
  assert.match(app, /organization_path\s*:/,
    "context request is missing organization_path");
});
