package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installVerifiedR001HandoffV194(t *testing.T, app *App, runID, nextAction string) map[string]string {
	t.Helper()
	runDir := filepath.Join(app.DataRoot, "runs", runID)
	reportPath := filepath.Join(runDir, "r005-output", "reconciliation.xlsx")
	codexInputPath := filepath.Join(runDir, "r005-output", "explicit-companion.json")
	reportHash, err := fileSHA256V041(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(codexInputPath, map[string]any{"report_sha256": reportHash, "operation_evidence": map[string]any{"pair_candidates": []any{}}}); err != nil {
		t.Fatal(err)
	}
	codexInputHash, _ := fileSHA256V041(codexInputPath)

	executionID := "RULES-EXEC-1"
	handoffRoot := filepath.Join(runDir, "handoff", executionID)
	handoffDir := filepath.Join(handoffRoot, "r001")
	outputDir := filepath.Join(runDir, "rules-output", executionID)
	for _, dir := range []string{handoffDir, outputDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	rulesPath := filepath.Join(handoffDir, "engine_rules.json")
	applicationsPath := filepath.Join(handoffDir, "r001_rule_application_drafts.json")
	if err := writeJSONAtomic(rulesPath, map[string]any{"schema_version": "opiu-engine-rules.v1", "run_id": runID, "rules": []any{}}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(applicationsPath, map[string]any{
		"schema_version": "opiu-rule-applications.v1", "run_id": runID, "applications": []any{},
		"safety": map[string]any{"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false},
	}); err != nil {
		t.Fatal(err)
	}
	rulesHash, _ := fileSHA256V041(rulesPath)
	applicationsHash, _ := fileSHA256V041(applicationsPath)
	rulesRevisionSetHash := strings.Repeat("A", 64)
	handoffPath := filepath.Join(handoffDir, "r001_handoff.json")
	if err := writeJSONAtomic(handoffPath, map[string]any{
		"schema_version": "opiu-r001-handoff.v1", "run_id": runID, "source_r005_run_id": runID,
		"organization":   map[string]any{"id": "ORG-1", "name": "Organization 1", "path": "Holding / Organization 1", "include_descendants": false},
		"period":         "2025-01",
		"reconciliation": map[string]any{"path": reportPath, "sha256": reportHash, "codex_input_path": codexInputPath, "codex_input_sha256": codexInputHash},
		"rules":          map[string]any{"path": rulesPath, "sha256": rulesHash, "rules_revision_set_hash": rulesRevisionSetHash},
		"applications":   map[string]any{"path": applicationsPath, "sha256": applicationsHash},
	}); err != nil {
		t.Fatal(err)
	}
	handoffHash, _ := fileSHA256V041(handoffPath)
	decisionPath := filepath.Join(outputDir, "workflow_decision.json")
	if err := writeJSONAtomic(decisionPath, map[string]any{
		"schema_version": "opiu-rules-workflow-decision.v1", "run_id": runID, "next_action": nextAction,
		"rules_revision_set_hash": rulesRevisionSetHash,
		"handoff": map[string]any{
			"target": "R001", "handoff_path": handoffPath, "handoff_sha256": handoffHash,
			"rules_path": rulesPath, "rules_sha256": rulesHash,
			"applications_path": applicationsPath, "applications_sha256": applicationsHash,
		},
	}); err != nil {
		t.Fatal(err)
	}
	decisionHash, _ := fileSHA256V041(decisionPath)

	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	run, _ := anySlice(runs["runs"])[0].(map[string]any)
	for key, value := range map[string]any{
		"organization_id": "ORG-1", "organization_name": "Organization 1", "organization_path": "Holding / Organization 1",
		"period": "2025-01", "period_mode": "month", "rules_execution_id": executionID,
		"rules_handoff_dir": handoffRoot, "rules_workflow_decision_path": decisionPath, "rules_next_action": nextAction,
	} {
		run[key] = value
	}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "runs", "index.json"), runs); err != nil {
		t.Fatal(err)
	}

	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]any{
		"active_run_id": runID, "organization_id": "ORG-1", "organization_name": "Organization 1",
		"organization_path": "Holding / Organization 1", "period": "2025-01", "period_mode": "month",
	} {
		settings[key] = value
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}

	artifacts := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "artifacts", "index.json"), &artifacts); err != nil {
		t.Fatal(err)
	}
	list := anySlice(artifacts["artifacts"])
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		if item == nil {
			continue
		}
		if asString(item["artifact_type"]) == "EVIDENCE_JSON" {
			item["path"] = codexInputPath
			item["sha256"] = codexInputHash
		}
	}
	list = append(list, map[string]any{
		"artifact_id": "ART-WORKFLOW", "run_id": runID, "stage": "RULES", "artifact_type": "RULES_WORKFLOW_DECISION",
		"path": decisionPath, "sha256": decisionHash, "rules_execution_id": executionID, "created_at": "2026-08-09T00:00:00Z",
	})
	artifacts["artifacts"] = list
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), artifacts); err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"report": reportPath, "codex_input": codexInputPath, "rules": rulesPath, "applications": applicationsPath,
		"handoff": handoffPath, "decision": decisionPath,
	}
}

func TestPrepareR001UsesExactVerifiedHandoffInsteadOfLatestArtifact(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	paths := installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
	newerReport := filepath.Join(app.DataRoot, "runs", runID, "r005-output", "newer-but-not-handed-off.xlsx")
	if err := os.WriteFile(newerReport, []byte("newer"), 0644); err != nil {
		t.Fatal(err)
	}
	newerHash, _ := fileSHA256V041(newerReport)
	artifacts := map[string]any{}
	_ = readJSON(filepath.Join(app.DataRoot, "artifacts", "index.json"), &artifacts)
	artifacts["artifacts"] = append(anySlice(artifacts["artifacts"]), map[string]any{
		"artifact_id": "ART-NEWER", "run_id": runID, "stage": "R005", "artifact_type": "RECONCILIATION_REPORT",
		"path": newerReport, "sha256": newerHash, "created_at": "2099-01-01T00:00:00Z",
	})
	_ = writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), artifacts)

	prepared, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID})
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	sources, _ := context["sources"].(map[string]any)
	if !sameR001PathV194(asString(sources["reconciliation_path"]), paths["report"]) {
		t.Fatalf("R001 selected a non-handoff XLSX: %#v", sources)
	}
	if !sameR001PathV194(asString(sources["codex_input_path"]), paths["codex_input"]) {
		t.Fatalf("R001 did not bind the explicit companion: %#v", sources)
	}
}

func TestPrepareR001AcceptsVerifiedRerunHandoff(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	installVerifiedR001HandoffV194(t, app, runID, "RERUN_R001")
	if _, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID}); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareR001FailsClosedOnContextMismatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"run", map[string]any{"run_id": "RUN-OTHER"}},
		{"organization", map[string]any{"organization_id": "ORG-OTHER"}},
		{"period", map[string]any{"period": "2025-02"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app, runID := newRulesEngineTestApp(t)
			installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
			tc.body["module_id"] = "correction-files-engine"
			if _, err := app.prepareEngineV041(tc.body); err == nil || !strings.Contains(err.Error(), "R001_HANDOFF") {
				t.Fatalf("mismatch was not blocked: %v", err)
			}
		})
	}
}

func TestPrepareR001FailsClosedOnHandoffHashMismatch(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	paths := installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
	if err := os.WriteFile(paths["codex_input"], []byte(`{"report_sha256":"tampered"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID}); err == nil || !strings.Contains(err.Error(), "HASH_MISMATCH") {
		t.Fatalf("tampered handoff input was not blocked: %v", err)
	}
}

func TestR001DraftApplicationsRejectUnsafeUnconfirmedApplication(t *testing.T) {
	doc := map[string]any{
		"schema_version": "opiu-rule-applications.v1", "run_id": "RUN-1",
		"safety": map[string]any{"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false},
		"applications": []any{map[string]any{
			"application_id": "APP-1", "candidate_id": "CAND-1", "run_id": "RUN-1", "organization_id": "ORG-1", "period": "2025-01",
			"result_status": "REVIEW", "proof_status": "UNPROVEN", "review_state": "NEEDS_REVIEW", "output_route": "СПОРНО", "disputed_only": true,
			"execution_allowed": false, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": true,
			"candidate_snapshot": map[string]any{
				"candidate_id": "CAND-1", "scope": map[string]any{"organization_id": "ORG-1"}, "action": map[string]any{"action_type": "STORNO_REPOST"},
			},
		}},
	}
	if err := validateR001DraftApplicationsV194(doc, "RUN-1", "ORG-1", "2025-01"); err == nil || !strings.Contains(err.Error(), "SAFETY") {
		t.Fatalf("unsafe disputed application was not blocked: %v", err)
	}
	application := anySlice(doc["applications"])[0].(map[string]any)
	application["live_1c_allowed"] = false
	application["result_status"] = "CONFIRMED"
	application["proof_status"] = "PROVEN"
	application["review_state"] = "NOT_REQUIRED"
	application["output_route"] = "ГОТОВО"
	application["disputed_only"] = false
	if err := validateR001DraftApplicationsV194(doc, "RUN-1", "ORG-1", "2025-01"); err == nil || !strings.Contains(err.Error(), "STATUS_FORBIDDEN") {
		t.Fatalf("confirmed application crossed disputed-draft handoff: %v", err)
	}
}

func TestPrepareR001FailsClosedOnWorkflowBoundHashMismatch(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	paths := installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
	decision := map[string]any{}
	if err := readJSON(paths["decision"], &decision); err != nil {
		t.Fatal(err)
	}
	handoff := decision["handoff"].(map[string]any)
	handoff["applications_sha256"] = strings.Repeat("F", 64)
	if err := writeJSONAtomic(paths["decision"], decision); err != nil {
		t.Fatal(err)
	}
	decisionHash, _ := fileSHA256V041(paths["decision"])
	artifacts := map[string]any{}
	_ = readJSON(filepath.Join(app.DataRoot, "artifacts", "index.json"), &artifacts)
	for _, raw := range anySlice(artifacts["artifacts"]) {
		item, _ := raw.(map[string]any)
		if item != nil && asString(item["artifact_type"]) == "RULES_WORKFLOW_DECISION" {
			item["sha256"] = decisionHash
		}
	}
	_ = writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), artifacts)
	if _, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID}); err == nil || !strings.Contains(err.Error(), "WORKFLOW_HASH_MISMATCH") {
		t.Fatalf("workflow-bound hash mismatch was not blocked: %v", err)
	}
}
