// Compatibility facade for callers that have not yet moved to the neutral
// Service handoff module. Rules/application inputs are intentionally rejected.
export {
  SERVICE_HANDOFF_SCHEMA,
  assertNoDirectR001Overrides,
  rejectDuplicateJsonKeys,
  verifyServiceR001Handoff,
} from "./service_r005_r001_handoff.mjs";

import { verifyServiceR001Handoff } from "./service_r005_r001_handoff.mjs";

export async function verifiedR001HandoffInput(options = {}) {
  const forbidden = ["applicationsPath", "reconciliationPath", "codexInputPath", "requestedRunId", "requestedOrganizationId", "requestedOrganizationName", "requestedPeriod"];
  for (const key of forbidden) {
    if (String(options[key] ?? "").trim()) throw new Error(`R001_DIRECT_SOURCE_OVERRIDE_FORBIDDEN:${key}`);
  }
  return verifyServiceR001Handoff({
    handoffPath: options.handoffPath,
    handoffSha256: options.handoffSha256,
  });
}

export async function requireVerifiedHandoffForRulesApplications({ applicationsPath = "" } = {}) {
  if (String(applicationsPath ?? "").trim()) throw new Error("R001_APPLICATIONS_INPUT_FORBIDDEN");
}
