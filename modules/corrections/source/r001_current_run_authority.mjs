import { applyStandaloneStornoMaterialization } from "./owner_decision_r001.mjs";
import { bridgeR001DecisionsToMaterializationCases } from "./r001_materialization_bridge.mjs";
import { materializeStandaloneStornoCases } from "./r001_standalone_storno_materialization.mjs";

export const EXTERNAL_CANONICAL_AUTHORITY_FIELDS = Object.freeze([
  "canonical_posting_row",
  "materialization_case",
  "standalone_storno_result",
  "standalone_storno_blockers",
]);

function text(value) { return String(value ?? "").trim(); }

export function stripExternalCanonicalAuthority(decision = {}) {
  const sanitized = { ...decision };
  const stripped = [];
  for (const field of EXTERNAL_CANONICAL_AUTHORITY_FIELDS) {
    if (Object.hasOwn(sanitized, field)) stripped.push(field);
    delete sanitized[field];
  }
  return Object.freeze({
    decision: Object.freeze(sanitized),
    stripped_fields: Object.freeze(stripped),
  });
}

/**
 * Rebuild the canonical authority inside the active core process.
 *
 * Serialized MaterializationCase/CanonicalPostingRow values are output from a
 * prior process, not proof.  This boundary discards them, rebuilds cases from
 * the accepted decision semantics, and invokes the exact standalone source
 * materializer again for this run before returning any canonical row.
 */
export async function deriveCurrentRunCanonicalAuthority(decisions = [], {
  provenance = {},
  reopenSource,
} = {}) {
  if (!Array.isArray(decisions)) throw new TypeError("Current-run authority decisions must be an array");
  const sanitizedResults = decisions.map(stripExternalCanonicalAuthority);
  const sanitizedDecisions = sanitizedResults.map((item) => item.decision);
  const bridge = bridgeR001DecisionsToMaterializationCases(sanitizedDecisions, {
    provenance: {
      ...provenance,
      source: text(provenance?.source) || "CURRENT_RUN_CORE_REDERIVATION",
    },
  });
  const caseByIndex = new Map(bridge.case_links.map((link) => [
    link.upstream_decision_index,
    link.materialization_case,
  ]));
  const bridgedDecisions = sanitizedDecisions.map((decision, index) => caseByIndex.has(index)
    ? Object.freeze({ ...decision, materialization_case: caseByIndex.get(index) })
    : decision);
  const standalone = await materializeStandaloneStornoCases(bridgedDecisions, { reopenSource });
  const merged = applyStandaloneStornoMaterialization({
    decisions: bridgedDecisions,
    materialization_bridge: bridge,
  }, standalone);
  const trustedDecisions = merged.decisions.map((decision) => Object.freeze(decision));
  const strippedFieldCounts = Object.fromEntries(EXTERNAL_CANONICAL_AUTHORITY_FIELDS.map((field) => [
    field,
    sanitizedResults.filter((item) => item.stripped_fields.includes(field)).length,
  ]));
  return Object.freeze({
    decisions: Object.freeze(trustedDecisions),
    bridge: merged.materialization_bridge,
    standalone,
    canonical_posting_rows: Object.freeze(standalone.canonical_posting_rows ?? []),
    audit: Object.freeze({
      input_decision_count: decisions.length,
      stripped_field_counts: Object.freeze(strippedFieldCounts),
      stripped_external_canonical_row_count: strippedFieldCounts.canonical_posting_row,
      stripped_external_materialization_case_count: strippedFieldCounts.materialization_case,
      current_run_ready_row_count: standalone.audit.ready_row_count,
      current_run_sporno_row_count: standalone.audit.sporno_row_count,
      current_run_blocked_case_count: standalone.audit.blocked_case_count,
      current_run_skipped_count: standalone.audit.skipped_count,
    }),
  });
}
