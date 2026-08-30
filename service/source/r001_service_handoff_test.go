package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func buildVerifiedServiceHandoffFixture(t *testing.T) (*Store, Run, Context, string, serviceR001HandoffRef) {
	t.Helper()
	store, contextValue, run, runDir := newPipelineStructuralContext(t)
	handoff := prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
	return store, run, contextValue, runDir, handoff
}

func prepareVerifiedServiceHandoffForRun(t *testing.T, store *Store, run Run, contextValue Context, runDir string) serviceR001HandoffRef {
	t.Helper()
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	writePipelineStructuralInventoryV3(t, store, run, contextValue)
	r005Dir := filepath.Join(runDir, "r005")
	writeFailSoftR005Fixture(t, r005Dir, contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)

	pipeline := &Pipeline{store: store}
	_, audit, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
		t.Fatal(err)
	}
	if _, _, err := materializeStructuralControlProof(run, contextValue, runDir, filepath.Join(r005Dir, "reconciliation.codex-input.json")); err != nil {
		t.Fatal(err)
	}
	erpPath, intalevPath := testServiceSourcePaths(runDir)
	handoff, err := materializeServiceR001Handoff(run, contextValue, runDir, erpPath, intalevPath)
	if err != nil {
		t.Fatal(err)
	}
	return handoff
}

func TestServiceR001HandoffProducerAndVerifier(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	document, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	if document.SourceRunID != run.ID || document.RunID != run.ID || document.ContextID != contextValue.ID ||
		document.Organization.ID != contextValue.OrganizationID || document.Period != contextValue.Period ||
		document.Safety != reportOnlyServiceR001HandoffSafety() || document.PhysicalEvidence.ReuseCount != 0 ||
		!validUpperSHA256(document.PhysicalEvidence.SourceRowIDsSHA256) {
		t.Fatalf("handoff lost exact scope, physical digest, or REPORT_ONLY closure: %#v", document)
	}
}

func TestServiceR001HandoffSerializesExactClosedSafetyObject(t *testing.T) {
	_, _, _, _, handoff := buildVerifiedServiceHandoffFixture(t)
	data, err := os.ReadFile(handoff.Path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("serialized handoff JSON is invalid: %v", err)
	}
	safetyRaw, ok := document["safety"]
	if !ok {
		t.Fatal("serialized handoff omitted safety object")
	}
	var safety map[string]json.RawMessage
	if err := json.Unmarshal(safetyRaw, &safety); err != nil {
		t.Fatalf("serialized safety object is invalid: %v", err)
	}
	expectedKeys := []string{
		"mode", "posting_rows", "ready_to_upload", "release_allowed", "execution_allowed", "live_1c_allowed",
	}
	if len(safety) != len(expectedKeys) {
		t.Fatalf("serialized safety object has %d keys, want exactly %d: %#v", len(safety), len(expectedKeys), safety)
	}
	for _, key := range expectedKeys {
		if _, ok := safety[key]; !ok {
			t.Fatalf("serialized safety object omitted required key %q: %#v", key, safety)
		}
	}
	var mode string
	var postingRows int
	var readyToUpload, releaseAllowed, executionAllowed, live1CAllowed bool
	if err := json.Unmarshal(safety["mode"], &mode); err != nil {
		t.Fatalf("serialized mode is invalid: %v", err)
	}
	if err := json.Unmarshal(safety["posting_rows"], &postingRows); err != nil {
		t.Fatalf("serialized posting_rows is invalid: %v", err)
	}
	if err := json.Unmarshal(safety["ready_to_upload"], &readyToUpload); err != nil {
		t.Fatalf("serialized ready_to_upload is invalid: %v", err)
	}
	if err := json.Unmarshal(safety["release_allowed"], &releaseAllowed); err != nil {
		t.Fatalf("serialized release_allowed is invalid: %v", err)
	}
	if err := json.Unmarshal(safety["execution_allowed"], &executionAllowed); err != nil {
		t.Fatalf("serialized execution_allowed is invalid: %v", err)
	}
	if err := json.Unmarshal(safety["live_1c_allowed"], &live1CAllowed); err != nil {
		t.Fatalf("serialized live_1c_allowed is invalid: %v", err)
	}
	if mode != "REPORT_ONLY" || postingRows != 0 || readyToUpload || releaseAllowed || executionAllowed || live1CAllowed {
		t.Fatalf("serialized safety object is not exactly closed REPORT_ONLY: mode=%q posting_rows=%d ready_to_upload=%t release_allowed=%t execution_allowed=%t live_1c_allowed=%t", mode, postingRows, readyToUpload, releaseAllowed, executionAllowed, live1CAllowed)
	}
}

func TestServiceR001HandoffRejectsTamperAndExactSchemaDrift(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	original, err := os.ReadFile(handoff.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(handoff.Path, append(original, ' '), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir); err == nil {
		t.Fatal("handoff byte tamper was accepted")
	}
	if err := os.WriteFile(handoff.Path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	duplicate := strings.Replace(string(original), `"run_id":`, `"run_id":"DUPLICATE", "run_id":`, 1)
	if err := os.WriteFile(handoff.Path, []byte(duplicate), 0o600); err != nil {
		t.Fatal(err)
	}
	duplicateSHA, err := sha256File(handoff.Path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(handoff.Path+".sha256", []byte(strings.ToUpper(duplicateSHA)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyServiceR001Handoff(handoff.Path, duplicateSHA, run, contextValue, runDir); err == nil {
		t.Fatal("duplicate handoff key was accepted")
	}
}

func TestR001PackageRequiresAndRevalidatesServiceHandoff(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		t.Fatalf("package with exact Service handoff was rejected: %v", err)
	}
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["inputs"].(map[string]any)["service_handoff"] = nil
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err == nil {
		t.Fatal("R001 package without mandatory Service handoff was accepted")
	}
	if err := os.WriteFile(handoff.Path, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimePipelineIsDirectR005ServiceHandoffR001(t *testing.T) {
	store, contextValue, run, runDir := newPipelineStructuralContext(t)
	erpPath, intalevPath := testServiceSourcePaths(runDir)
	erpSHA, err := sha256File(erpPath)
	if err != nil {
		t.Fatal(err)
	}
	pipeline := &Pipeline{store: store, runtime: &RuntimeAdapter{
		Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs", R001Script: "service_r001_owner_wrapper.mjs",
	}, active: map[string]struct{}{}}
	stages := []string{}
	pipeline.runner = func(stage string, command []string, _ map[string]string, _, _ string) error {
		stages = append(stages, stage)
		switch stage {
		case "R005":
			writePipelineStructuralInventoryV3(t, store, run, contextValue)
			r005Dir := filepath.Join(runDir, "r005")
			writeFailSoftR005Fixture(t, r005Dir, contextValue, "BLOCKED_R005_REPASS_REQUIRED")
			refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)
		case "R001":
			joined := "\x00" + strings.Join(command, "\x00") + "\x00"
			for _, required := range []string{"--handoff", "--handoff-sha256"} {
				if !strings.Contains(joined, "\x00"+required+"\x00") {
					t.Fatalf("R001 command omitted %s: %#v", required, command)
				}
			}
			for _, forbidden := range []string{"--decisions", "--rules", "--applications", "--reconciliation", "--codex-input"} {
				if strings.Contains(joined, "\x00"+forbidden+"\x00") {
					t.Fatalf("R001 command exposed forbidden direct input %s: %#v", forbidden, command)
				}
			}
			writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
		default:
			t.Fatalf("legacy stage became reachable: %s", stage)
		}
		return nil
	}
	var status RunStatus
	var terminalStage string
	pipeline.executeRuntime(run, contextValue, erpPath, erpSHA, intalevPath, runDir,
		func(gotStatus RunStatus, gotStage, _ string) { status, terminalStage = gotStatus, gotStage })
	if strings.Join(stages, ",") != "R005,R001" || status != RunCompletedReportOnly || terminalStage != "DONE" {
		t.Fatalf("direct pipeline failed: stages=%v status=%s stage=%s", stages, status, terminalStage)
	}
}
