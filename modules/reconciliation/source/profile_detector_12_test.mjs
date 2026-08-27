import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditConfiguredRootProfiles,
  detectConfiguredRootProfile,
} from "./organization_profile_registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await fs.readFile(path.join(here, "organization_profiles.json"), "utf8"));
const reconciliationSource = await fs.readFile(path.join(here, "opiu_reconcile.mjs"), "utf8");
assert.match(reconciliationSource, /detectConfiguredRootProfile\(\s*organizationProfileRegistry,\s*organizationHint,/s, "detectReconciliationProfile must use the configured root registry");
const expected = [
  "1 Хабаровск",
  "2 Камчатка",
  "3 Сахалин",
  "4 Владивосток",
  "7 Контрактодержатель",
  "8 Сахалин МА",
  "9 Управляющая компания",
  "Дистрибьюция",
  "Производитель",
  "Управленческая организация",
  "Холдинг",
  "ЦД/ЦЗ Фонд развития",
  "Элиминирующая",
];

const audit = auditConfiguredRootProfiles(registry);
assert.equal(audit.roots.length, 13, "the registry must contain exactly 13 allowed root profiles");
assert.deepEqual(audit.duplicates, [], "allowed root organization names must be unique");

const rows = expected.map((organization) => {
  const profile = detectConfiguredRootProfile(registry, organization);
  assert.ok(profile, `profile not detected for ${organization}`);
  assert.ok(profile.id, `profile id missing for ${organization}`);
  assert.ok(profile.rules_path, `rules path missing for ${organization}`);
  assert.ok(profile.status === "BLOCKED_PROFILE_REVIEW_REQUIRED" || profile.status === "BLOCKED_R005_REPASS_REQUIRED", `unsafe status for ${organization}: ${profile.status}`);
  return {
    organization,
    profile: profile.id,
    rulesPath: profile.rules_path,
    status: profile.status,
  };
});

assert.equal(detectConfiguredRootProfile(registry, "Хабаровск")?.organization, "1 Хабаровск");
assert.equal(detectConfiguredRootProfile(registry, "Сахалин")?.organization, "3 Сахалин");
assert.equal(detectConfiguredRootProfile(registry, "Управляющая компания")?.organization, "9 Управляющая компания");
assert.equal(detectConfiguredRootProfile(registry, "Планета Запад"), null);

console.log("PROFILE_DETECTOR_13_13=PASS");
for (const row of rows) console.log(`${row.organization}\t${row.profile}\t${row.rulesPath}\t${row.status}`);
