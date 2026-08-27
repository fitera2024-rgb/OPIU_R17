/**
 * Built-in, versioned policy for automatic discovery from the R005 evidence
 * package.  It is executable configuration shipped with the standalone
 * correction engine, not an external input and not a user-authored file.
 */
export const CORRECTION_SELF_DISCOVERY_POLICY = Object.freeze({
  schema_version: "opiu-correction-self-discovery-policy.v1",
  policy_version: "R001-R12-PHYSICAL-RECLASS-NDFL-20260826",
  zero_sum_internal_reclassification: Object.freeze({
    enabled: true,
    article_scope: "ALL_ARTICLES_DISCOVERED_IN_RECONCILIATION_AND_CATALOG",
    organization_source: "reconciliation_passport_top_level",
    operation: "REPOST",
    keep_disputed_when_source_subset_missing: true,
    global_rule: Object.freeze({
      enabled: true,
      difference_formula: "intalev_minus_erp",
      excess_delta_sign: "negative",
      shortage_delta_sign: "positive",
      account_evidence_fields: Object.freeze(["disclosure", "analytics3"]),
      normal_side_evidence: "account must match exactly one of debit or credit",
      exclude_accounts: Object.freeze(["99"]),
      require_one_source: true,
      require_exact_zero_sum_cents: true,
      candidate_tolerance_rubles: 1,
      posting_tolerance_rubles: 0,
      require_unique_account_side_profile: true,
      require_same_normal_side: true,
      debit_direction: "Dr target account/article; Cr source account/article",
      credit_direction: "Dr source account/article; Cr target account/article",
      fail_closed_on_ambiguity: true,
    }),
    organization_reference: Object.freeze({
      top_level_name: "9 Управляющая компания",
    }),
  }),
});
