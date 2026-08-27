package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func sourceProofUIEvidenceV194(t *testing.T, app *App, duplicateERP bool) (map[string]any, string) {
	t.Helper()
	intalevRoot := filepath.Join(app.InputsDir, "INTALEV-A")
	erpRoot := filepath.Join(app.InputsDir, "ERP-A")
	writeSourceV194(t, intalevRoot, "source.xlsx", "intalev-ui-source")
	writeSourceV194(t, erpRoot, "source.xlsx", "erp-ui-source")
	_, intalevEvidence := sourceSpecV194(t, "INTALEV", "INTALEV-UI", intalevRoot, true)
	_, erpEvidence := sourceSpecV194(t, "ERP", "ERP-UI", erpRoot, true)
	if duplicateERP {
		writeSourceV194(t, filepath.Join(app.InputsDir, "ERP-B"), "source.xlsx", "erp-ui-source")
	}
	evidencePath := filepath.Join(app.InputsDir, "source-inventory.json")
	if err := writeJSONAtomic(evidencePath, map[string]any{
		"schema":                       "opiu-issue-65-source-proof-ui-test-v1",
		"report_only":                  true,
		"posting_rows":                 0,
		"ready_to_upload":              false,
		"release_allowed":              false,
		"raw_business_bytes_committed": false,
		"roots":                        []any{intalevEvidence, erpEvidence},
	}); err != nil {
		t.Fatal(err)
	}
	evidenceSHA256, err := fileSHA256V041(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{
		"erp_shared": map[string]any{"status": "PINNED"},
	}, evidenceSHA256
}

func sourceProofUISettingsV194(t *testing.T, app *App) map[string]any {
	t.Helper()
	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	return settings
}

func installPinnedSourceProofReferenceV194(t *testing.T, app *App) {
	t.Helper()
	manifestRelative := filepath.ToSlash(filepath.Join("reference", "erp_shared", "manifest.json"))
	manifestPath := filepath.Join(app.DataRoot, filepath.FromSlash(manifestRelative))
	if err := writeJSONAtomic(manifestPath, map[string]any{"status": "PINNED", "catalog_set_id": "TEST-ERP-REFERENCE", "catalogs": []any{}}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "reference", "erp_shared", "active.json"), map[string]any{"catalog_set_id": "TEST-ERP-REFERENCE", "manifest_path": manifestRelative}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), map[string]any{"nodes": []any{map[string]any{"node_id": "ORG-1", "node_name": "Organization 1", "hierarchy_path": "Holding / Organization 1"}}}); err != nil {
		t.Fatal(err)
	}
}

func installCanonicalPersistedUploadPairV194(t *testing.T, app *App) (string, string) {
	t.Helper()
	installPinnedSourceProofReferenceV194(t, app)
	intalevName := "intalev-user-package.zip"
	erpName := "erp-user-package.zip"
	intalevPath := filepath.Join(app.InputsDir, intalevName)
	erpPath := filepath.Join(app.InputsDir, erpName)
	if err := os.WriteFile(intalevPath, []byte("canonical-intalev-user-package"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(erpPath, []byte("canonical-erp-user-package"), 0644); err != nil {
		t.Fatal(err)
	}
	intalevSHA, err := fileSHA256V041(intalevPath)
	if err != nil {
		t.Fatal(err)
	}
	intalevInfo, err := os.Stat(intalevPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestRelative := filepath.ToSlash(filepath.Join("intalev", "versions", "INTALEV-CANONICAL", "manifest.json"))
	manifestPath := filepath.Join(app.DataRoot, filepath.FromSlash(manifestRelative))
	if err := writeJSONAtomic(manifestPath, map[string]any{
		"schema_version": "opiu-intalev-package.v1", "package_id": "INTALEV-CANONICAL",
		"status": "ACTIVE", "source_file_count": 1,
		"source_files": []any{map[string]any{
			"relative_path": intalevName, "sha256": intalevSHA, "size": intalevInfo.Size(),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "intalev", "active.json"), map[string]any{
		"package_id": "INTALEV-CANONICAL", "manifest_path": manifestRelative,
	}); err != nil {
		t.Fatal(err)
	}
	settings := sourceProofUISettingsV194(t, app)
	settings["input_roles"] = map[string]any{"intalev": intalevName, "erp": erpName}
	delete(settings, "approved_source_evidence_sha256")
	delete(settings, "approved_source_evidence_input")
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	return intalevPath, erpPath
}

func candidateByRoleV194(t *testing.T, options map[string]any, role string) map[string]any {
	t.Helper()
	evidence := anySlice(options["evidence_candidates"])
	if len(evidence) != 1 {
		t.Fatalf("expected exactly one evidence candidate, got %#v", evidence)
	}
	for _, raw := range anySlice(evidence[0].(map[string]any)["roots"]) {
		root := raw.(map[string]any)
		if asString(root["role"]) == role {
			return root
		}
	}
	t.Fatalf("missing %s root", role)
	return nil
}

func TestPreRunSourceProofOptionsRequireExplicitExactEvidenceApprovalV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, evidenceSHA256 := sourceProofUIEvidenceV194(t, app, false)
	settings := sourceProofUISettingsV194(t, app)
	organizations := map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}

	options := app.preRunSourceProofOptionsV194(settings, organizations, referenceStatus)
	if !asBool(options["reference_ready"]) {
		t.Fatalf("expected pinned hierarchy reference to be ready: %#v", options)
	}
	requireBlockerV194(t, stringSliceV194(options["blocker_codes"]), "BLOCKED_SOURCE_PROOF_EVIDENCE_APPROVAL_REQUIRED")
	evidence := anySlice(options["evidence_candidates"])[0].(map[string]any)
	if asBool(evidence["approved"]) {
		t.Fatal("evidence must not be approved before an explicit settings binding")
	}

	settings["approved_source_evidence_sha256"] = evidenceSHA256
	settings["approved_source_evidence_input"] = "source-inventory.json"
	options = app.preRunSourceProofOptionsV194(settings, organizations, referenceStatus)
	evidence = anySlice(options["evidence_candidates"])[0].(map[string]any)
	if !asBool(evidence["approved"]) || len(stringSliceV194(options["blocker_codes"])) != 0 {
		t.Fatalf("expected exact approved evidence binding, got %#v", options)
	}
	for _, role := range []string{"ERP", "INTALEV"} {
		root := candidateByRoleV194(t, options, role)
		candidates := anySlice(root["candidates"])
		if len(candidates) == 0 || !asBool(root["context_matches"]) {
			t.Fatalf("expected at least one exact %s root candidate, got %#v", role, root)
		}
		if asBool(root["requires_root_selection"]) != (len(candidates) != 1) {
			t.Fatalf("root selection policy does not match candidate count: %#v", root)
		}
		candidate := candidates[0].(map[string]any)
		if asString(candidate["request_path"]) == "" || asString(candidate["path_identity_sha256"]) == "" || asString(candidate["package_digest_sha256"]) != asString(root["package_digest_sha256"]) {
			t.Fatalf("candidate lacks exact path/hash identity: %#v", candidate)
		}
	}
	if int(asFloat(options["posting_rows"])) != 0 || asBool(options["ready_to_upload"]) || asBool(options["release_allowed"]) || asBool(options["live_1c_allowed"]) {
		t.Fatalf("unsafe UI options contract: %#v", options)
	}
}

func TestPreRunSourceProofOptionsNeverSelectLatestAmongEqualRootsV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, evidenceSHA256 := sourceProofUIEvidenceV194(t, app, true)
	settings := sourceProofUISettingsV194(t, app)
	settings["approved_source_evidence_sha256"] = evidenceSHA256
	settings["approved_source_evidence_input"] = "source-inventory.json"
	options := app.preRunSourceProofOptionsV194(settings, map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}, referenceStatus)
	erp := candidateByRoleV194(t, options, "ERP")
	if len(anySlice(erp["candidates"])) < 2 || !asBool(erp["requires_root_selection"]) {
		t.Fatalf("identical approved bytes must remain an explicit operator choice: %#v", erp)
	}
}

func TestPreRunSourceProofOptionsBlockWithoutOrganizationHierarchyV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, _ := sourceProofUIEvidenceV194(t, app, false)
	referenceStatus["erp_shared"] = map[string]any{"status": "NOT_PINNED"}
	options := app.preRunSourceProofOptionsV194(sourceProofUISettingsV194(t, app), map[string]any{"nodes": []any{}}, referenceStatus)
	if asBool(options["reference_ready"]) {
		t.Fatal("missing organization hierarchy must fail closed")
	}
	requireBlockerV194(t, stringSliceV194(options["blocker_codes"]), missingOrganizationHierarchyV194)
}

func TestCanonicalSourceProofUsesOneExactPersistedPairV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, _ := sourceProofUIEvidenceV194(t, app, false)
	settings := sourceProofUISettingsV194(t, app)
	organizations := map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}

	proof, business, blockers := app.canonicalSourceProofV194(settings, organizations, referenceStatus)
	if len(blockers) != 0 || proof == nil || business == nil {
		t.Fatalf("exact persisted pair was not resolved: blockers=%v proof=%#v business=%#v", blockers, proof, business)
	}
	if len(anySlice(proof["source_roots"])) != 2 || !asBool(business["ready"]) {
		t.Fatalf("canonical resolution lost an exact role or readiness: proof=%#v business=%#v", proof, business)
	}
	readiness := app.sourceProofBusinessReadinessV194(settings, organizations, referenceStatus)
	encoded, err := json.Marshal(readiness)
	if err != nil {
		t.Fatal(err)
	}
	public := string(encoded)
	for _, forbidden := range []string{"request_path", "evidence_path", "sha256", "source_roots", "evidence_input"} {
		if strings.Contains(public, forbidden) {
			t.Fatalf("business readiness leaked %s: %s", forbidden, public)
		}
	}
	if int(asFloat(readiness["posting_rows"])) != 0 || asBool(readiness["ready_to_upload"]) || asBool(readiness["release_allowed"]) || asBool(readiness["live_1c_allowed"]) {
		t.Fatalf("unsafe business readiness: %#v", readiness)
	}
}

func TestNormalUserUploadsResolveWithoutTechnicalEvidenceJSONV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	_, erpPath := installCanonicalPersistedUploadPairV194(t, app)
	settings := sourceProofUISettingsV194(t, app)
	organizations := map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}
	readiness := app.sourceProofBusinessReadinessV194(settings, organizations, app.referenceStatusV060())
	if !asBool(readiness["ready"]) {
		t.Fatalf("normal user uploads remained blocked: %#v", readiness)
	}
	sources, _ := readiness["sources"].(map[string]any)
	if asString(sources["erp"].(map[string]any)["package_name"]) != "erp-user-package.zip" ||
		asString(sources["intalev"].(map[string]any)["package_name"]) != "intalev-user-package.zip" {
		t.Fatalf("business source labels did not reflect the persisted upload pair: %#v", readiness)
	}
	serialized, err := json.Marshal(readiness)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"sha256", "request_path", "evidence", "source_roots", app.InputsDir} {
		if strings.Contains(string(serialized), forbidden) {
			t.Fatalf("normal readiness leaked %q: %s", forbidden, serialized)
		}
	}
	prepared, replayed, err := app.prepareBusinessR005V194(map[string]any{
		"module_id": "reconciliation-engine", "resolve_source_proof": true,
		"business_action_id": "ACTION-R005-NORMAL-UPLOADS",
	})
	if err != nil || replayed || asString(prepared["run_id"]) == "" {
		t.Fatalf("one normal business action did not allocate exactly one RUN: replayed=%v err=%v prepared=%#v", replayed, err, prepared)
	}
	if _, err := os.Stat(erpPath); err != nil {
		t.Fatalf("source upload was unexpectedly moved or deleted: %v", err)
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 {
		t.Fatalf("normal business action allocated %d RUNs", len(anySlice(runs["runs"])))
	}
	run := anySlice(runs["runs"])[0].(map[string]any)
	proof, err := validateStoredPreRunProofV194(run)
	if err != nil || int(asFloat(proof["posting_rows"])) != 0 || asBool(proof["ready_to_upload"]) || asBool(proof["release_allowed"]) || asBool(proof["live_1c_allowed"]) {
		t.Fatalf("stored canonical proof is invalid or unsafe: proof=%#v err=%v", proof, err)
	}
}

func TestNormalUserUploadsStayBlockedWhenERPPairIsAmbiguousV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	installCanonicalPersistedUploadPairV194(t, app)
	if err := os.WriteFile(filepath.Join(app.InputsDir, "second-erp-package.zip"), []byte("second-erp"), 0644); err != nil {
		t.Fatal(err)
	}
	settings := sourceProofUISettingsV194(t, app)
	proof, _, blockers := app.canonicalPersistedSourceProofV194(settings, map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}, app.referenceStatusV060())
	if proof != nil {
		t.Fatalf("ambiguous normal uploads were auto-picked: %#v", proof)
	}
	requireBlockerV194(t, blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
	assertNoFinancialRunV194(t, app)
}

func TestCanonicalSourceProofFailsClosedForBusinessBlockersV194(t *testing.T) {
	for _, tc := range []struct {
		name, expected string
		mutate         func(t *testing.T, app *App, settings map[string]any)
	}{
		{"missing_erp", "DATA_BLOCKED_ERP_SOURCE_REQUIRED", func(t *testing.T, app *App, settings map[string]any) {
			if err := os.RemoveAll(filepath.Join(app.InputsDir, "ERP-A")); err != nil {
				t.Fatal(err)
			}
		}},
		{"missing_intalev", "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED", func(t *testing.T, app *App, settings map[string]any) {
			if err := os.RemoveAll(filepath.Join(app.InputsDir, "INTALEV-A")); err != nil {
				t.Fatal(err)
			}
		}},
		{"mixed_organization", "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH", func(t *testing.T, app *App, settings map[string]any) {
			settings["organization_id"] = "ORG-OTHER"
			settings["organization_name"] = "Organization Other"
		}},
		{"mixed_period", "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH", func(t *testing.T, app *App, settings map[string]any) {
			settings["period"] = "2025-02"
		}},
		{"mixed_period_mode", "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH", func(t *testing.T, app *App, settings map[string]any) {
			settings["period_mode"] = "year"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			referenceStatus, _ := sourceProofUIEvidenceV194(t, app, false)
			settings := sourceProofUISettingsV194(t, app)
			tc.mutate(t, app, settings)
			proof, _, blockers := app.canonicalSourceProofV194(settings, map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}, referenceStatus)
			if proof != nil {
				t.Fatalf("blocked case returned a proof: %#v", proof)
			}
			requireBlockerV194(t, blockers, tc.expected)
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestCanonicalSourceProofNeverAutoPicksAmbiguousBytesV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, _ := sourceProofUIEvidenceV194(t, app, true)
	proof, _, blockers := app.canonicalSourceProofV194(sourceProofUISettingsV194(t, app), map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}, referenceStatus)
	if proof != nil {
		t.Fatalf("ambiguous exact bytes were auto-picked: %#v", proof)
	}
	requireBlockerV194(t, blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
	assertNoFinancialRunV194(t, app)
}

func TestCanonicalSourceProofRejectsLive1CFlagV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	referenceStatus, _ := sourceProofUIEvidenceV194(t, app, false)
	evidencePath := filepath.Join(app.InputsDir, "source-inventory.json")
	document := map[string]any{}
	if err := readJSON(evidencePath, &document); err != nil {
		t.Fatal(err)
	}
	document["live_1c_allowed"] = true
	if err := writeJSONAtomic(evidencePath, document); err != nil {
		t.Fatal(err)
	}
	proof, _, blockers := app.canonicalSourceProofV194(sourceProofUISettingsV194(t, app), map[string]any{"nodes": []any{map[string]any{"organization_id": "ORG-1"}}}, referenceStatus)
	if proof != nil {
		t.Fatalf("unsafe evidence produced a canonical proof: %#v", proof)
	}
	requireBlockerV194(t, blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_SAFETY_CONTRACT_INVALID")
	assertNoFinancialRunV194(t, app)
}

func TestBusinessR005OneActionIsIdempotentAndCarriesContinuityV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	body := map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-ONE"}
	if _, err := app.prepareRulesEngine(map[string]any{}); err == nil {
		t.Fatal("Rules became available before a validated R005 RUN")
	}
	if _, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine"}); err == nil {
		t.Fatal("R001 became available before a verified handoff")
	}

	type result struct {
		prepared map[string]any
		replayed bool
		err      error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			prepared, replayed, err := app.prepareBusinessR005V194(body)
			results <- result{prepared: prepared, replayed: replayed, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	runID := ""
	replayCount := 0
	for item := range results {
		if item.err != nil {
			t.Fatal(item.err)
		}
		if item.replayed {
			replayCount++
		}
		if candidate := asString(item.prepared["run_id"]); runID == "" {
			runID = candidate
		} else if candidate != runID {
			t.Fatalf("one action produced different RUNs: %s and %s", runID, candidate)
		}
	}
	if replayCount != 1 || runID == "" {
		t.Fatalf("idempotency result invalid: replay_count=%d run_id=%q", replayCount, runID)
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 {
		t.Fatalf("one action allocated %d RUNs", len(anySlice(runs["runs"])))
	}
	settings := sourceProofUISettingsV194(t, app)
	settings["period"] = "2025-02"
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if _, _, err := app.prepareBusinessR005V194(body); err == nil {
		t.Fatal("the same action was replayed after the business context changed")
	}
	settings["period"] = "2025-01"
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 {
		t.Fatalf("context-changed replay allocated %d RUNs", len(anySlice(runs["runs"])))
	}

	registerR005ArtifactsV194(t, app, runID)
	if _, err := app.prepareRulesEngine(map[string]any{"run_id": runID, "phase": "AFTER_R005"}); err != nil {
		t.Fatalf("Rules unavailable after validated business RUN: %v", err)
	}
	installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
	if _, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID}); err != nil {
		t.Fatalf("R001 unavailable after verified handoff: %v", err)
	}
}

func TestBusinessR005DriftBetweenInternalStepsAllocatesNoRunV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	body := map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-DRIFT"}
	_, _, err := app.prepareBusinessR005WithCheckpointV194(body, func() {
		_ = os.WriteFile(filepath.Join(app.InputsDir, "ERP-A", "source.xlsx"), []byte("mutated-between-internal-steps"), 0644)
	})
	if err == nil {
		t.Fatal("internal source drift unexpectedly allocated a RUN")
	}
	assertNoFinancialRunV194(t, app)
}

func TestBusinessR005DriftAfterConfirmValidationAllocatesNoRunV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	body := map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-POST-CONFIRM-DRIFT"}
	_, _, err := app.prepareBusinessR005WithCheckpointsV194(body, nil, func() {
		_ = os.WriteFile(filepath.Join(app.InputsDir, "ERP-A", "source.xlsx"), []byte("mutated-after-confirm-validation"), 0644)
	})
	if err == nil {
		t.Fatal("post-confirm source drift unexpectedly allocated a RUN")
	}
	assertNoFinancialRunV194(t, app)
}

func TestBusinessR005ContextUsesImmutableRunSnapshotV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	prepared, _, err := app.prepareBusinessR005V194(map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-SNAPSHOT"})
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	sources, _ := context["sources"].(map[string]any)
	erpSnapshot := asString(sources["erp_path"])
	if !pathWithinV194(filepath.Join(app.DataRoot, "runs", asString(prepared["run_id"]), "source-snapshot"), erpSnapshot) || pathWithinV194(app.InputsDir, erpSnapshot) {
		t.Fatalf("engine context is not bound to a run-local snapshot: %q", erpSnapshot)
	}
	before, err := fileSHA256V041(erpSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app.InputsDir, "ERP-A", "source.xlsx"), []byte("mutated-after-run-allocation"), 0644); err != nil {
		t.Fatal(err)
	}
	after, err := fileSHA256V041(erpSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("run-local snapshot changed after the original Inputs file drifted")
	}
}

func TestSettingsEndpointRemovesRetiredProofStateAndHidesArchivePathV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	settings := sourceProofUISettingsV194(t, app)
	settings["approved_source_evidence_sha256"] = "SECRET-SHA256"
	settings["approved_source_evidence_input"] = `C:\secret\evidence.json`
	settings["source_proof_required"] = false
	settings["last_archived_context"] = `C:\secret\archive`
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"organization_id": "ORG-2", "clear_current_context": true})
	request := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("settings endpoint failed: %d %s", response.Code, response.Body.String())
	}
	serialized := response.Body.String()
	for _, forbidden := range []string{`C:\secret`, "SECRET-SHA256", "approved_source_evidence", "source_proof_required", "archive_path", "last_archived_context"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("settings endpoint leaked %q: %s", forbidden, serialized)
		}
	}
	persisted := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &persisted); err != nil {
		t.Fatal(err)
	}
	for _, retired := range []string{"approved_source_evidence_sha256", "approved_source_evidence_input", "source_proof_required"} {
		if _, exists := persisted[retired]; exists {
			t.Fatalf("retired proof setting remained persisted: %s", retired)
		}
	}
}

func TestBusinessR005ReplayNeverClaimsReadyBeforeLauncherMarkerV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	payload, _ := json.Marshal(map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-LAUNCH-LIFECYCLE"})
	call := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/modules/open", bytes.NewReader(payload))
		request.RemoteAddr = "127.0.0.1:12345"
		response := httptest.NewRecorder()
		app.routes().ServeHTTP(response, request)
		return response
	}
	first := call()
	second := call()
	for index, response := range []*httptest.ResponseRecorder{first, second} {
		if response.Code < 400 {
			t.Fatalf("call %d claimed launcher success without a launcher: %d %s", index+1, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), `"ui_ready":true`) || strings.Contains(response.Body.String(), "context_path") || strings.Contains(response.Body.String(), `C:\`) {
			t.Fatalf("call %d leaked or claimed readiness: %s", index+1, response.Body.String())
		}
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 || asString(anySlice(runs["runs"])[0].(map[string]any)["business_action_status"]) != "FAILED" {
		t.Fatalf("replayed action lifecycle is not fail-closed: %#v", runs)
	}
}

func TestBusinessR005LaunchingReplayDoesNotStartSecondProcessV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	sourceProofUIEvidenceV194(t, app, false)
	installPinnedSourceProofReferenceV194(t, app)
	body := map[string]any{"module_id": "reconciliation-engine", "resolve_source_proof": true, "business_action_id": "ACTION-R005-LAUNCHING"}
	prepared, _, err := app.prepareBusinessR005V194(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.updateBusinessActionStateV194(asString(prepared["run_id"]), asString(body["business_action_id"]), "LAUNCHING"); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(app.AppRoot, "modules", "reconciliation", "source", "ui_loader.ps1")
	if err := os.MkdirAll(filepath.Dir(launcher), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher, []byte("throw 'must not start'"), 0644); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(body)
	request := httptest.NewRequest(http.MethodPost, "/api/modules/open", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || strings.Contains(response.Body.String(), `"ui_ready":true`) {
		t.Fatalf("LAUNCHING replay was not observed safely: %d %s", response.Code, response.Body.String())
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 || asString(anySlice(runs["runs"])[0].(map[string]any)["business_action_status"]) != "LAUNCHING" {
		t.Fatalf("LAUNCHING replay changed lifecycle or RUN count: %#v", runs)
	}
}

func TestSourceProofPublicDTOsAndBusinessErrorsHideTechnicalStateV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	settings := sourceProofUISettingsV194(t, app)
	settings["approved_source_evidence_sha256"] = "SECRET-SHA256"
	settings["approved_source_evidence_input"] = `C:\secret\evidence.json`
	settings["source_proof_required"] = true
	runs := []any{map[string]any{
		"run_id": "RUN-SECRET", "context_path": `C:\secret\context.json`,
		"pre_run_source_proof": map[string]any{"blocker_codes": []any{"SECRET-CODE"}},
		"pre_run_source_roots": []any{map[string]any{"root_path": `C:\secret\root`}},
		"business_action_id":   "SECRET-ACTION",
	}}
	artifacts := []any{map[string]any{
		"artifact_id": "ART-1", "name": "report.xlsx", "path": `C:\secret\report.xlsx`, "sha256": "SECRET-SHA256",
	}}
	public := map[string]any{
		"settings":  sourceProofPublicSettingsV194(settings),
		"runs":      app.sourceProofPublicRunsV194(runs, settings),
		"artifacts": sourceProofPublicArtifactsV194(artifacts),
		"error":     sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Короткое сообщение.", nil),
	}
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	for _, forbidden := range []string{`C:\secret`, "SECRET-SHA256", "SECRET-CODE", "SECRET-ACTION", "context_path", "root_path", "blocker_codes", "business_action_id"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("public response leaked %q: %s", forbidden, serialized)
		}
	}
	errorDTO := public["error"].(map[string]any)
	if int(asFloat(errorDTO["posting_rows"])) != 0 || asBool(errorDTO["ready_to_upload"]) || asBool(errorDTO["release_allowed"]) || asBool(errorDTO["live_1c_allowed"]) {
		t.Fatalf("unsafe public error response: %#v", errorDTO)
	}
}
