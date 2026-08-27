import { ownerDecisionRows } from "../../reconciliation/source/owner_decision_projection.mjs";
import { rulesApplicationsToDisputedDecisions } from "./rules_application_handoff.mjs";
import { bridgeR001DecisionsToMaterializationCases } from "./r001_materialization_bridge.mjs";

function text(value) { return String(value ?? "").trim(); }
function exactRowCode(value) { return /^R\d{3}$/i.test(text(value)) ? text(value).toUpperCase() : ""; }
const ID_KEYS = new Set(["application_id", "candidate_id", "pair_id", "row_id", "row_code", "reconciliation_row", "reconciliation_row_code", "code"]);

export function exactRowCodesFromApplication(application) {
  const result = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return; }
    if (value && typeof value === "object") { for (const [childKey, child] of Object.entries(value)) visit(child, childKey); return; }
    if (typeof value !== "string") return;
    const direct = exactRowCode(value);
    if (direct) { result.add(direct); return; }
    if (!ID_KEYS.has(key)) return;
    const matches = [...value.toUpperCase().matchAll(/(?:^|[-_:])(R\d{3})(?=$|[-_:])/g)];
    if (matches.length) result.add(matches[matches.length - 1][1]);
  };
  visit(application);
  return result;
}

function ownerCoveredRows(projection) {
  const covered = new Set(
    (projection?.presentation_block_exemptions ?? [])
      .map((item) => exactRowCode(item?.code))
      .filter(Boolean),
  );
  for (const [code, caseIds] of Object.entries(projection?.row_links ?? {})) {
    // The owner projection is authoritative for every explicitly classified
    // row, including REVIEW_ONLY. Retaining a Rules ONE_SIDE fallback for the
    // same row would reintroduce a second, weaker economic interpretation.
    const scopedCode = exactRowCode(text(code).split("|").at(-1));
    if ((caseIds ?? []).length > 0 && scopedCode) covered.add(scopedCode);
  }
  return covered;
}

export function mergeOwnerAndRuleDecisions({ applicationsDocument = {}, projection, organization = "", period = "", provenance = {} } = {}) {
  const covered = ownerCoveredRows(projection);
  const applications = Array.isArray(applicationsDocument?.applications) ? applicationsDocument.applications : [];
  const filteredApplicationIds = [];
  const retained = [];
  for (const application of applications) {
    const codes = exactRowCodesFromApplication(application);
    const conflict = [...codes].some((code) => covered.has(code));
    if (conflict) filteredApplicationIds.push(text(application?.application_id || application?.candidate_id));
    else retained.push(application);
  }
  const retainedPayload = { ...applicationsDocument, applications: retained };
  const ruleDecisions = rulesApplicationsToDisputedDecisions(retainedPayload, { organization, period }).map((decision) => ({
    ...decision,
    proof_status: text(decision?.proof_status || decision?.evidence_state || "UNPROVEN").toUpperCase(),
    original_proof_status: text(decision?.original_proof_status || decision?.proof_status || decision?.evidence_state || "UNPROVEN").toUpperCase(),
    review_state: text(decision?.review_state) || "NEEDS_REVIEW",
    bridge_source: "RULES_APPLICATION",
    notes: [text(decision?.notes), "Источник: rules application, сохранён только потому что не перекрыт owner economic CaseID."].filter(Boolean).join(" | "),
  }));
  const ownerRows = ownerDecisionRows(projection).map((decision) => ({
    ...decision,
    bridge_source: "R005_OWNER_PROJECTION",
    notes: [
      text(decision?.notes),
      provenance?.handoff_sha256 ? `R001 handoff SHA256=${provenance.handoff_sha256}` : "",
      provenance?.applications_sha256 ? `Rules applications SHA256=${provenance.applications_sha256}` : "",
    ].filter(Boolean).join(" | "),
  }));
  const sourceDecisions = [...ownerRows, ...ruleDecisions];
  const materializationBridge = bridgeR001DecisionsToMaterializationCases(sourceDecisions, {
    provenance: {
      source: "PINNED_R005_RULES",
      handoff_sha256: provenance?.handoff_sha256,
      applications_sha256: provenance?.applications_sha256,
    },
  });
  const canonicalByIndex = new Map(materializationBridge.case_links.map((link) => [
    link.upstream_decision_index,
    link.materialization_case,
  ]));
  const decisions = sourceDecisions.map((decision, index) => canonicalByIndex.has(index)
    ? { ...decision, materialization_case: canonicalByIndex.get(index) }
    : decision);
  return {
    decisions,
    materialization_bridge: materializationBridge,
    filtered_application_ids: filteredApplicationIds.filter(Boolean),
    retained_application_count: retained.length,
    owner_decision_count: ownerRows.length,
    rule_decision_count: ruleDecisions.length,
  };
}

export function applyStandaloneStornoMaterialization(merged, standalone) {
  const updates = new Map((standalone?.case_updates ?? []).map((item) => [
    item.upstream_decision_index,
    item,
  ]));
  const decisions = (merged?.decisions ?? []).map((decision, index) => {
    const update = updates.get(index);
    if (!update) return decision;
    return {
      ...decision,
      materialization_case: update.materialization_case,
      canonical_posting_row: update.canonical_posting_row,
      standalone_storno_result: update.result,
      standalone_storno_blockers: update.blockers,
    };
  });
  const bridge = merged?.materialization_bridge ?? {};
  const caseLinks = (bridge.case_links ?? []).map((link) => {
    const update = updates.get(link.upstream_decision_index);
    return update ? { ...link, materialization_case: update.materialization_case } : link;
  });
  const financialCases = caseLinks
    .filter((link) => link.category === "FINANCIAL")
    .map((link) => link.materialization_case);
  const reviewOnlyCases = caseLinks
    .filter((link) => link.category === "REVIEW_ONLY")
    .map((link) => link.materialization_case);
  const canonicalPostingRows = [
    ...(bridge.canonical_posting_rows ?? []),
    ...(standalone?.canonical_posting_rows ?? []),
  ];
  return {
    ...merged,
    decisions,
    materialization_bridge: {
      ...bridge,
      financial_cases: financialCases,
      review_only_cases: reviewOnlyCases,
      canonical_posting_rows: canonicalPostingRows,
      standalone_storno: standalone,
      audit: {
        ...(bridge.audit ?? {}),
        financial_case_count: financialCases.length,
        review_only_case_count: reviewOnlyCases.length,
        canonical_posting_row_count: canonicalPostingRows.length,
        standalone_storno_ready_row_count: standalone?.audit?.ready_row_count ?? 0,
        standalone_storno_sporno_row_count: standalone?.audit?.sporno_row_count ?? 0,
        standalone_storno_blocked_case_count: standalone?.audit?.blocked_case_count ?? 0,
      },
    },
  };
}
