package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func emptyTestRulesRegistry() map[string]any {
	return map[string]any{
		"schema_version": rulesRegistrySchema,
		"library_id":     "TEST-LIBRARY",
		"rules":          []any{},
		"revisions":      []any{},
		"applications":   []any{},
		"approvals":      []any{},
		"evidence":       []any{},
	}
}

func writeTestRulesSeed(t *testing.T, path string) {
	t.Helper()
	if err := atomicWriteJSON(path, emptyTestRulesRegistry()); err != nil {
		t.Fatal(err)
	}
}

func newTestRulesRegistry(t *testing.T, store *Store) (*persistentRulesRegistry, string) {
	t.Helper()
	seed := filepath.Join(t.TempDir(), "rules.json")
	writeTestRulesSeed(t, seed)
	registry, err := newPersistentRulesRegistry(store, seed)
	if err != nil {
		t.Fatal(err)
	}
	return registry, seed
}

func readTestRulesContextRegistry(t *testing.T, contextPath string) (map[string]any, string) {
	t.Helper()
	var contextDocument map[string]any
	if err := readStrictJSONFile(contextPath, &contextDocument); err != nil {
		t.Fatal(err)
	}
	paths, ok := contextDocument["paths"].(map[string]any)
	if !ok {
		t.Fatalf("Rules context has no paths: %#v", contextDocument)
	}
	registryPath, _ := paths["rules_registry"].(string)
	registry, err := readRulesRegistry(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := sha256File(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	return registry, hash
}

func writeTestRulesEngineArtifacts(t *testing.T, outputDir, runID, baseHash string, registry map[string]any, audit []map[string]any) {
	t.Helper()
	phase := "AFTER_R005"
	if filepath.Base(outputDir) == "rules-after-user" {
		phase = "AFTER_USER_DECISIONS"
		if stringField(registry, "rules_revision_set_hash") == "" {
			registry["rules_revision_set_hash"] = strings.Repeat("A", 64)
		}
	}
	resultPath := filepath.Join(outputDir, "registry_result.json")
	if err := atomicWriteJSON(resultPath, map[string]any{
		"schema_version":       rulesRegistryResultSchema,
		"run_id":               runID,
		"base_registry_sha256": baseHash,
		"registry":             registry,
		"decision_audit":       audit,
	}); err != nil {
		t.Fatal(err)
	}
	resultHash, err := sha256File(resultPath)
	if err != nil {
		t.Fatal(err)
	}
	outputHashes := map[string]any{"registry_result.json": resultHash}
	if workflowHash, workflowErr := sha256File(filepath.Join(outputDir, "workflow_decision.json")); workflowErr == nil {
		outputHashes["workflow_decision.json"] = workflowHash
	}
	sourceHashes := map[string]any{}
	rulesReviewDir := filepath.Join(filepath.Dir(outputDir), "rules-review")
	if decisionsHash, hashErr := sha256File(filepath.Join(rulesReviewDir, "user_rule_decisions.json")); hashErr == nil {
		sourceHashes["user_decisions"] = decisionsHash
	}
	manifest := map[string]any{
		"schema_version":        rulesEngineManifestSchema,
		"run_id":                runID,
		"phase":                 phase,
		"registry_input_sha256": baseHash,
		"source_hashes":         sourceHashes,
		"output_hashes":         outputHashes,
	}
	revisionHash := stringField(registry, "rules_revision_set_hash")
	if revisionHash == "" {
		revisionHash = strings.Repeat("A", 64)
	}
	manifest["rules_revision_set_hash"] = revisionHash
	if err := atomicWriteJSON(filepath.Join(outputDir, "engine_manifest.json"), manifest); err != nil {
		t.Fatal(err)
	}
}

func writeTestDecisionBinding(t *testing.T, store *Store, runID, candidateID, decision, candidateDecision, impactClass, actionType string) {
	t.Helper()
	directory := filepath.Join(store.RunsDir(), runID, "rules-review")
	decisionsPath := filepath.Join(directory, "user_rule_decisions.json")
	if err := atomicWritePrivateJSON(decisionsPath, ruleReviewDecisionDocument{
		SchemaVersion:          "opiu-user-rule-decisions.v1",
		RunID:                  runID,
		Author:                 "Test",
		Decisions:              []ruleReviewDecision{{CandidateID: candidateID, Decision: decision}},
		SourceCandidatesSHA256: strings.Repeat("C", 64),
		ServiceCandidateBindings: []rulesDecisionBinding{{
			CandidateID: candidateID, Decision: decision, CandidateDecision: candidateDecision, ImpactClass: impactClass, ActionType: actionType,
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

func writeNoopRulesEngineArtifacts(t *testing.T, contextPath, outputDir, runID string) {
	t.Helper()
	registry, baseHash := readTestRulesContextRegistry(t, contextPath)
	writeTestRulesEngineArtifacts(t, outputDir, runID, baseHash, registry, nil)
}

func testRule(ruleID, revisionID string) map[string]any {
	return map[string]any{
		"rule_id":        ruleID,
		"origin_rule_id": ruleID,
		"revision_id":    revisionID,
		"status":         "ACTIVE",
		"enabled":        true,
		"is_current":     true,
		"content_hash":   strings.Repeat("A", 64),
	}
}

func appendTestRule(registry map[string]any, rule map[string]any) {
	registry["rules"] = append(registry["rules"].([]any), rule)
	registry["revisions"] = append(registry["revisions"].([]any), rule)
}

func TestPersistentRulesRegistrySurvivesRestartAndFeedsNextRun(t *testing.T) {
	storeRoot := t.TempDir()
	store, err := OpenStore(storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	registry, seed := newTestRulesRegistry(t, store)
	writeTestDecisionBinding(t, store, "run_first", "CAND-USER", "CONFIRMED", "NEW_RULE", "CORRECTION_ANALYTICS", "ONE_SIDE")
	_, baseHash, err := registry.snapshot("run_first", "after-user")
	if err != nil {
		t.Fatal(err)
	}
	result, err := readRulesRegistry(registry.Path())
	if err != nil {
		t.Fatal(err)
	}
	newRule := testRule("RULE-USER", "REV-RULE-USER-1")
	appendTestRule(result, newRule)
	result["applications"] = []any{
		map[string]any{"application_id": "APP-USER", "run_id": "run_first", "revision_id": "REV-RULE-USER-1", "result_status": "CONFIRMED"},
		map[string]any{"application_id": "APP-OTHER", "run_id": "run_other", "revision_id": "REV-RULE-USER-1"},
	}
	result["approvals"] = []any{
		map[string]any{"approval_id": "APPROVAL-USER", "rule_id": "RULE-USER", "revision_id": "REV-RULE-USER-1"},
		map[string]any{"approval_id": "APPROVAL-OTHER", "rule_id": "RULE-OTHER", "revision_id": "REV-OTHER"},
	}
	result["evidence"] = []any{
		map[string]any{"evidence_id": "EVIDENCE-USER", "run_id": "run_first"},
		map[string]any{"evidence_id": "EVIDENCE-OTHER", "run_id": "run_other"},
	}
	outputDir := filepath.Join(store.RunsDir(), "run_first", "rules-after-user")
	writeTestRulesEngineArtifacts(t, outputDir, "run_first", baseHash, result, []map[string]any{{
		"candidate_id": "CAND-USER", "action": "NEW_RULE", "rule_id": "RULE-USER", "revision_id": "REV-RULE-USER-1",
	}})
	var exactManifest rulesEngineManifestDocument
	if err := readStrictJSONFile(filepath.Join(outputDir, "engine_manifest.json"), &exactManifest); err != nil {
		t.Fatal(err)
	}
	if exactManifest.SourceHashes["user_decisions"] == "" || exactManifest.SourceHashes["service_decision_binding"] != "" {
		t.Fatalf("fixture does not match the real Rules Engine source-hash contract: %#v", exactManifest.SourceHashes)
	}
	count, err := registry.mergeEngineOutput("run_first", "after-user", outputDir, baseHash)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("persisted rule count=%d", count)
	}
	receipt := registry.persistenceReceipt("run_first")
	if !receipt.RegistryPersisted || receipt.RegistryPersistedCount != 1 {
		t.Fatalf("unexpected persistence receipt: %#v", receipt)
	}

	// A changed bundled seed must not overwrite the private registry on restart.
	changedSeed := emptyTestRulesRegistry()
	appendTestRule(changedSeed, testRule("RULE-NEW-RELEASE", "REV-NEW-RELEASE-1"))
	if err := atomicWriteJSON(seed, changedSeed); err != nil {
		t.Fatal(err)
	}
	restartedStore, err := OpenStore(storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	restartedRegistry, err := newPersistentRulesRegistry(restartedStore, seed)
	if err != nil {
		t.Fatal(err)
	}
	snapshotPath, _, err := restartedRegistry.snapshot("run_next", "initial")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := readRulesRegistry(snapshotPath)
	if err != nil {
		t.Fatal(err)
	}
	rules, _ := objectSlice(snapshot, "rules")
	if len(rules) != 1 || stringField(rules[0], "rule_id") != "RULE-USER" {
		t.Fatalf("next run did not receive persisted user rule: %#v", rules)
	}
	applications, _ := objectSlice(snapshot, "applications")
	approvals, _ := objectSlice(snapshot, "approvals")
	evidence, _ := objectSlice(snapshot, "evidence")
	if len(applications) != 1 || stringField(applications[0], "run_id") != "run_first" || len(approvals) != 1 || len(evidence) != 1 {
		t.Fatalf("run-scoped merge leaked unrelated artifacts: apps=%#v approvals=%#v evidence=%#v", applications, approvals, evidence)
	}
	if nextReceipt := readRulesPersistenceReceipt(store.RunsDir(), "run_next"); nextReceipt.RegistryPersisted || nextReceipt.RegistryPersistedCount != 0 {
		t.Fatalf("next run claimed persistence before Rules merge: %#v", nextReceipt)
	}
}

func TestRulesRegistryMergeFailsClosed(t *testing.T) {
	t.Run("path traversal", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		for _, runID := range []string{"../outside", `..\outside`, "run/child"} {
			if _, _, err := registry.snapshot(runID, "initial"); err == nil {
				t.Fatalf("unsafe run id %q was accepted", runID)
			}
		}
		_, baseHash, err := registry.snapshot("run_path", "initial")
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(store.RunsDir(), "outside", "rules")
		if _, err := registry.mergeEngineOutput("run_path", "initial", outside, baseHash); err == nil {
			t.Fatal("unregistered Rules output directory was accepted")
		}
	})

	t.Run("manifest output hash", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		_, baseHash, err := registry.snapshot("run_hash", "initial")
		if err != nil {
			t.Fatal(err)
		}
		outputDir := filepath.Join(store.RunsDir(), "run_hash", "rules")
		current, _ := readRulesRegistry(registry.Path())
		writeTestRulesEngineArtifacts(t, outputDir, "run_hash", baseHash, current, nil)
		manifestPath := filepath.Join(outputDir, "engine_manifest.json")
		var manifest map[string]any
		if err := readStrictJSONFile(manifestPath, &manifest); err != nil {
			t.Fatal(err)
		}
		manifest["output_hashes"] = map[string]any{"registry_result.json": strings.Repeat("0", 64)}
		if err := atomicWriteJSON(manifestPath, manifest); err != nil {
			t.Fatal(err)
		}
		if _, err := registry.mergeEngineOutput("run_hash", "initial", outputDir, baseHash); err == nil {
			t.Fatal("mismatched manifest output hash was accepted")
		}
		if receipt := readRulesPersistenceReceipt(store.RunsDir(), "run_hash"); receipt.RegistryPersisted || receipt.RegistryPersistedCount != 0 {
			t.Fatalf("failed merge claimed persistence: %#v", receipt)
		}
	})

	t.Run("manifest schema and run", func(t *testing.T) {
		for _, test := range []struct {
			name   string
			mutate func(map[string]any)
		}{
			{name: "schema", mutate: func(manifest map[string]any) { manifest["schema_version"] = "wrong" }},
			{name: "run", mutate: func(manifest map[string]any) { manifest["run_id"] = "run_other" }},
			{name: "base", mutate: func(manifest map[string]any) { manifest["registry_input_sha256"] = strings.Repeat("0", 64) }},
		} {
			t.Run(test.name, func(t *testing.T) {
				store, _ := OpenStore(t.TempDir())
				registry, _ := newTestRulesRegistry(t, store)
				_, baseHash, err := registry.snapshot("run_manifest", "initial")
				if err != nil {
					t.Fatal(err)
				}
				outputDir := filepath.Join(store.RunsDir(), "run_manifest", "rules")
				current, _ := readRulesRegistry(registry.Path())
				writeTestRulesEngineArtifacts(t, outputDir, "run_manifest", baseHash, current, nil)
				manifestPath := filepath.Join(outputDir, "engine_manifest.json")
				var manifest map[string]any
				if err := readStrictJSONFile(manifestPath, &manifest); err != nil {
					t.Fatal(err)
				}
				test.mutate(manifest)
				if err := atomicWriteJSON(manifestPath, manifest); err != nil {
					t.Fatal(err)
				}
				if _, err := registry.mergeEngineOutput("run_manifest", "initial", outputDir, baseHash); err == nil {
					t.Fatalf("invalid manifest %s was accepted", test.name)
				}
			})
		}
	})

	t.Run("registry result schema and run", func(t *testing.T) {
		for _, field := range []string{"schema_version", "run_id"} {
			t.Run(field, func(t *testing.T) {
				store, _ := OpenStore(t.TempDir())
				registry, _ := newTestRulesRegistry(t, store)
				_, baseHash, err := registry.snapshot("run_result", "initial")
				if err != nil {
					t.Fatal(err)
				}
				outputDir := filepath.Join(store.RunsDir(), "run_result", "rules")
				current, _ := readRulesRegistry(registry.Path())
				writeTestRulesEngineArtifacts(t, outputDir, "run_result", baseHash, current, nil)
				resultPath := filepath.Join(outputDir, "registry_result.json")
				var result map[string]any
				if err := readStrictJSONFile(resultPath, &result); err != nil {
					t.Fatal(err)
				}
				result[field] = "wrong"
				if err := atomicWriteJSON(resultPath, result); err != nil {
					t.Fatal(err)
				}
				resultHash, _ := sha256File(resultPath)
				manifestPath := filepath.Join(outputDir, "engine_manifest.json")
				var manifest map[string]any
				if err := readStrictJSONFile(manifestPath, &manifest); err != nil {
					t.Fatal(err)
				}
				manifest["output_hashes"] = map[string]any{"registry_result.json": resultHash}
				if err := atomicWriteJSON(manifestPath, manifest); err != nil {
					t.Fatal(err)
				}
				if _, err := registry.mergeEngineOutput("run_result", "initial", outputDir, baseHash); err == nil {
					t.Fatalf("invalid registry result %s was accepted", field)
				}
			})
		}
	})

	t.Run("CAS conflict", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		_, baseHash, err := registry.snapshot("run_cas", "initial")
		if err != nil {
			t.Fatal(err)
		}
		snapshot, _ := readRulesRegistry(registry.Path())
		outputDir := filepath.Join(store.RunsDir(), "run_cas", "rules")
		writeTestRulesEngineArtifacts(t, outputDir, "run_cas", baseHash, snapshot, nil)
		concurrent := emptyTestRulesRegistry()
		concurrent["applications"] = []any{map[string]any{"application_id": "APP-CONCURRENT", "run_id": "other"}}
		if err := atomicWriteJSON(registry.Path(), concurrent); err != nil {
			t.Fatal(err)
		}
		if _, err := registry.mergeEngineOutput("run_cas", "initial", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "RULE_REGISTRY_CHANGED_DURING_RUN") {
			t.Fatalf("CAS conflict was not rejected: %v", err)
		}
	})

	t.Run("unaudited new rule", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		_, baseHash, err := registry.snapshot("run_unaudited", "initial")
		if err != nil {
			t.Fatal(err)
		}
		result, _ := readRulesRegistry(registry.Path())
		appendTestRule(result, testRule("RULE-HIDDEN", "REV-HIDDEN-1"))
		outputDir := filepath.Join(store.RunsDir(), "run_unaudited", "rules")
		writeTestRulesEngineArtifacts(t, outputDir, "run_unaudited", baseHash, result, nil)
		if _, err := registry.mergeEngineOutput("run_unaudited", "initial", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "unaudited") {
			t.Fatalf("unaudited rule was not rejected: %v", err)
		}
	})

	t.Run("forbidden amount in audited rule", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		writeTestDecisionBinding(t, store, "run_amount", "CAND-AMOUNT", "CONFIRMED", "NEW_RULE", "CORRECTION_ANALYTICS", "ONE_SIDE")
		_, baseHash, err := registry.snapshot("run_amount", "after-user")
		if err != nil {
			t.Fatal(err)
		}
		result, _ := readRulesRegistry(registry.Path())
		rule := testRule("RULE-AMOUNT", "REV-AMOUNT-1")
		rule["conditions"] = []any{map[string]any{"amount": 100}}
		appendTestRule(result, rule)
		outputDir := filepath.Join(store.RunsDir(), "run_amount", "rules-after-user")
		writeTestRulesEngineArtifacts(t, outputDir, "run_amount", baseHash, result, []map[string]any{{
			"candidate_id": "CAND-AMOUNT", "action": "NEW_RULE", "rule_id": "RULE-AMOUNT", "revision_id": "REV-AMOUNT-1",
		}})
		if _, err := registry.mergeEngineOutput("run_amount", "after-user", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "forbidden financial amount") {
			t.Fatalf("rule with financial amount was not rejected: %v", err)
		}
	})

	t.Run("existing rule objects are preserved", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		base := emptyTestRulesRegistry()
		baseRule := testRule("RULE-BASE", "REV-BASE-1")
		baseRule["title"] = "Original title"
		appendTestRule(base, baseRule)
		if err := atomicWriteJSON(registry.Path(), base); err != nil {
			t.Fatal(err)
		}
		_, baseHash, err := registry.snapshot("run_preserve", "initial")
		if err != nil {
			t.Fatal(err)
		}
		result, _ := readRulesRegistry(registry.Path())
		resultRules, _ := objectSlice(result, "rules")
		resultRules[0]["title"] = "Untrusted normalized title"
		resultRules[0]["status"] = "INACTIVE"
		resultRules[0]["enabled"] = false
		result["rules"] = mapsToAny(resultRules)
		outputDir := filepath.Join(store.RunsDir(), "run_preserve", "rules")
		writeTestRulesEngineArtifacts(t, outputDir, "run_preserve", baseHash, result, nil)
		if count, err := registry.mergeEngineOutput("run_preserve", "initial", outputDir, baseHash); err != nil || count != 0 {
			t.Fatalf("no-op merge failed: count=%d err=%v", count, err)
		}
		persisted, _ := readRulesRegistry(registry.Path())
		persistedRules, _ := objectSlice(persisted, "rules")
		if stringField(persistedRules[0], "title") != "Original title" || stringField(persistedRules[0], "status") != "ACTIVE" || !boolFieldDefault(persistedRules[0], "enabled", false) {
			t.Fatalf("existing rule object was replaced from result: %#v", persistedRules[0])
		}
	})
}

func TestPersistentRulesRegistryRejectsCorruptionWithoutMigratingRuns(t *testing.T) {
	store, _ := OpenStore(t.TempDir())
	registry, seed := newTestRulesRegistry(t, store)
	ownerRunArtifact := filepath.Join(store.RunsDir(), "run_f86", "rules-after-user", "registry_result.json")
	if err := os.MkdirAll(filepath.Dir(ownerRunArtifact), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ownerRunArtifact, []byte(`{"registry":{"rules":[{"rule_id":"OWNER-RULE"}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	persisted, err := readRulesRegistry(registry.Path())
	if err != nil {
		t.Fatal(err)
	}
	if rules, _ := objectSlice(persisted, "rules"); len(rules) != 0 {
		t.Fatalf("owner run artifact was auto-migrated: %#v", rules)
	}
	if err := os.WriteFile(registry.Path(), []byte(`{"schema_version":"broken"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newPersistentRulesRegistry(store, seed); err == nil {
		t.Fatal("corrupt persistent registry was silently replaced from seed")
	}
}

func TestRulesRegistryRequiresUniqueSemanticIDs(t *testing.T) {
	missing := emptyTestRulesRegistry()
	missing["rules"] = []any{map[string]any{}}
	if err := validateRulesRegistry(missing); err == nil || !strings.Contains(err.Error(), "rule_id") {
		t.Fatalf("rule without semantic ids was accepted: %v", err)
	}
	duplicate := emptyTestRulesRegistry()
	duplicate["rules"] = []any{
		testRule("RULE-A", "REV-DUPLICATE"),
		testRule("RULE-B", "REV-DUPLICATE"),
	}
	if err := validateRulesRegistry(duplicate); err == nil || !strings.Contains(err.Error(), "duplicate revision_id") {
		t.Fatalf("duplicate semantic revision id was accepted: %v", err)
	}
}

func TestRulesPersistenceReceiptJSONContainsNoPathOrHash(t *testing.T) {
	store, _ := OpenStore(t.TempDir())
	registry, _ := newTestRulesRegistry(t, store)
	if _, _, err := registry.snapshot("run_public", "initial"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(store.RunsDir(), "run_public", "rules-registry", "persistence.json"))
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	for key := range value {
		if strings.Contains(key, "path") || strings.Contains(key, "sha") || strings.Contains(key, "hash") {
			t.Fatalf("technical field leaked into persistence receipt: %s", key)
		}
	}
}

func TestPrivateRulesWriterNeverDeletesLiveDestination(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "rules.json")
	if err := os.WriteFile(destination, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalReplace := replacePrivateFile
	replacePrivateFile = func(_, _ string) error { return errors.New("injected replace failure") }
	defer func() { replacePrivateFile = originalReplace }()
	if err := atomicWritePrivateFile(destination, []byte("new")); err == nil {
		t.Fatal("injected replace failure was ignored")
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "live" {
		t.Fatalf("live destination was removed or changed: data=%q err=%v", data, err)
	}
}

func TestRulesSnapshotIsImmutableAndIdempotent(t *testing.T) {
	store, _ := OpenStore(t.TempDir())
	registry, _ := newTestRulesRegistry(t, store)
	path, firstHash, err := registry.snapshot("run_immutable", "initial")
	if err != nil {
		t.Fatal(err)
	}
	if repeatedPath, repeatedHash, err := registry.snapshot("run_immutable", "initial"); err != nil || repeatedPath != path || repeatedHash != firstHash {
		t.Fatalf("identical snapshot is not idempotent: path=%s hash=%s err=%v", repeatedPath, repeatedHash, err)
	}
	original, _ := os.ReadFile(path)
	changed := emptyTestRulesRegistry()
	changed["applications"] = []any{map[string]any{"application_id": "APP-CHANGED", "run_id": "other"}}
	if err := atomicWritePrivateJSON(registry.Path(), changed); err != nil {
		t.Fatal(err)
	}
	if _, _, err := registry.snapshot("run_immutable", "initial"); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("different content overwrote immutable snapshot: %v", err)
	}
	after, _ := os.ReadFile(path)
	if !strings.EqualFold(sha256Bytes(original), sha256Bytes(after)) {
		t.Fatal("immutable snapshot bytes changed")
	}
}

func TestRulesRegistryPhaseDecisionAndReceiptBindings(t *testing.T) {
	makeAuditedChange := func(t *testing.T, store *Store, registry *persistentRulesRegistry, runID, phase, candidateID string) (string, string) {
		t.Helper()
		_, baseHash, err := registry.snapshot(runID, phase)
		if err != nil {
			t.Fatal(err)
		}
		result, _ := readRulesRegistry(registry.Path())
		appendTestRule(result, testRule("RULE-"+runID, "REV-"+runID+"-1"))
		outputDir := filepath.Join(store.RunsDir(), runID, map[string]string{"initial": "rules", "after-user": "rules-after-user"}[phase])
		writeTestRulesEngineArtifacts(t, outputDir, runID, baseHash, result, []map[string]any{{
			"candidate_id": candidateID, "action": "NEW_RULE", "rule_id": "RULE-" + runID, "revision_id": "REV-" + runID + "-1",
		}})
		return outputDir, baseHash
	}

	t.Run("initial cannot persist audited new rule", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		outputDir, baseHash := makeAuditedChange(t, store, registry, "run_initial_new", "initial", "CAND-INITIAL")
		if _, err := registry.mergeEngineOutput("run_initial_new", "initial", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "initial Rules phase") {
			t.Fatalf("initial audited rule was accepted: %v", err)
		}
	})

	t.Run("after-user requires candidate id and exact eligible decision", func(t *testing.T) {
		for _, test := range []struct {
			name        string
			candidateID string
			decision    string
			impact      string
			want        string
		}{
			{name: "missing candidate id", candidateID: "", decision: "CONFIRMED", impact: "CORRECTION_ANALYTICS", want: "eligible saved user decision"},
			{name: "rejected decision", candidateID: "CAND-REJECTED", decision: "REJECTED", impact: "CORRECTION_ANALYTICS", want: "eligible saved user decision"},
			{name: "control only", candidateID: "CAND-CONTROL", decision: "CONFIRMED", impact: "CONTROL_ONLY", want: "CONTROL_ONLY"},
		} {
			t.Run(test.name, func(t *testing.T) {
				store, _ := OpenStore(t.TempDir())
				registry, _ := newTestRulesRegistry(t, store)
				bindingCandidate := test.candidateID
				if bindingCandidate == "" {
					bindingCandidate = "CAND-SAVED"
				}
				writeTestDecisionBinding(t, store, "run_binding", bindingCandidate, test.decision, "NEW_RULE", test.impact, "ONE_SIDE")
				outputDir, baseHash := makeAuditedChange(t, store, registry, "run_binding", "after-user", test.candidateID)
				if _, err := registry.mergeEngineOutput("run_binding", "after-user", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), test.want) {
					t.Fatalf("invalid binding was accepted: %v", err)
				}
			})
		}
	})

	t.Run("one decision cannot persist two audited rules", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		const runID = "run_duplicate_candidate"
		const candidateID = "CAND-ONE"
		writeTestDecisionBinding(t, store, runID, candidateID, "CONFIRMED", "NEW_RULE", "CORRECTION_ANALYTICS", "ONE_SIDE")
		_, baseHash, err := registry.snapshot(runID, "after-user")
		if err != nil {
			t.Fatal(err)
		}
		result, _ := readRulesRegistry(registry.Path())
		appendTestRule(result, testRule("RULE-ONE", "REV-ONE-1"))
		appendTestRule(result, testRule("RULE-TWO", "REV-TWO-1"))
		outputDir := filepath.Join(store.RunsDir(), runID, "rules-after-user")
		writeTestRulesEngineArtifacts(t, outputDir, runID, baseHash, result, []map[string]any{
			{"candidate_id": candidateID, "action": "NEW_RULE", "rule_id": "RULE-ONE", "revision_id": "REV-ONE-1"},
			{"candidate_id": candidateID, "action": "NEW_RULE", "rule_id": "RULE-TWO", "revision_id": "REV-TWO-1"},
		})
		if _, err := registry.mergeEngineOutput(runID, "after-user", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "more than one audited rule change") {
			t.Fatalf("duplicate audited changes for one decision were accepted: %v", err)
		}
	})

	t.Run("manifest revision hash mismatch", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		_, baseHash, _ := registry.snapshot("run_revision_hash", "initial")
		result, _ := readRulesRegistry(registry.Path())
		result["rules_revision_set_hash"] = strings.Repeat("A", 64)
		outputDir := filepath.Join(store.RunsDir(), "run_revision_hash", "rules")
		writeTestRulesEngineArtifacts(t, outputDir, "run_revision_hash", baseHash, result, nil)
		manifestPath := filepath.Join(outputDir, "engine_manifest.json")
		var manifest map[string]any
		_ = readStrictJSONFile(manifestPath, &manifest)
		manifest["rules_revision_set_hash"] = strings.Repeat("B", 64)
		if err := atomicWriteJSON(manifestPath, manifest); err != nil {
			t.Fatal(err)
		}
		if _, err := registry.mergeEngineOutput("run_revision_hash", "initial", outputDir, baseHash); err == nil || !strings.Contains(err.Error(), "revision hash") {
			t.Fatalf("mismatched revision hash was accepted: %v", err)
		}
	})

	t.Run("failed registry replace has no durable rule or true acknowledgement", func(t *testing.T) {
		store, _ := OpenStore(t.TempDir())
		registry, _ := newTestRulesRegistry(t, store)
		writeTestDecisionBinding(t, store, "run_replace_fail", "CAND-FAIL", "CONFIRMED", "NEW_RULE", "CORRECTION_ANALYTICS", "ONE_SIDE")
		outputDir, baseHash := makeAuditedChange(t, store, registry, "run_replace_fail", "after-user", "CAND-FAIL")
		originalReplace := replacePrivateFile
		replacePrivateFile = func(source, destination string) error {
			if sameCleanPath(destination, registry.Path()) {
				return errors.New("injected registry replace failure")
			}
			return replaceFileAtomically(source, destination)
		}
		defer func() { replacePrivateFile = originalReplace }()
		if _, err := registry.mergeEngineOutput("run_replace_fail", "after-user", outputDir, baseHash); err == nil {
			t.Fatal("injected registry replace failure was ignored")
		}
		persisted, _ := readRulesRegistry(registry.Path())
		if rules, _ := objectSlice(persisted, "rules"); len(rules) != 0 {
			t.Fatalf("rule was durable after failed atomic commit: %#v", rules)
		}
		if receipt := registry.persistenceReceipt("run_replace_fail"); receipt.RegistryPersisted || receipt.RegistryPersistedCount != 0 {
			t.Fatalf("failed commit claimed persistence: %#v", receipt)
		}
	})
}
