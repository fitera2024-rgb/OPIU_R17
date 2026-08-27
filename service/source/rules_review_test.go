package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testWaitingRulesRun(t *testing.T) (*Store, Run) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureOrganizationCatalog([]organizationNode{{
		ID: "ORG-TEST", Name: "Тестовая организация", Path: "Тестовая организация", Selectable: true,
	}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.PutFile(SourceFile{ID: "erp_test", Name: "erp.xlsx", Kind: SourceERP, Size: 1, CreatedAt: now, DiskName: "erp_test.xlsx", SHA256: "ERP"}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutFile(SourceFile{ID: "intalev_test", Name: "intalev.xlsx", Kind: SourceIntalev, Size: 1, CreatedAt: now, DiskName: "intalev_test.xlsx", SHA256: "INTALEV"}); err != nil {
		t.Fatal(err)
	}
	contextValue, err := store.CreateContext(createContextRequest{
		Organization:     "Тестовая организация",
		OrganizationID:   "ORG-TEST",
		OrganizationName: "Тестовая организация",
		OrganizationPath: "Тестовая организация",
		Period:           "2025-11",
		ERPFileID:        "erp_test",
		IntalevFileID:    "intalev_test",
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	run.Status = RunWaitingUserRules
	run.Stage = "RULES_REVIEW"
	run.Message = "Найдены предложения правил"
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	rulesDir := filepath.Join(store.RunsDir(), run.ID, "rules")
	if err := atomicWriteJSON(filepath.Join(rulesDir, "rule_candidates.json"), map[string]any{
		"schema_version": "opiu-rule-candidates.v1",
		"run_id":         run.ID,
		"candidates": []any{
			map[string]any{
				"candidate_id": "CAND-1",
				"decision":     "NEW_RULE",
				"impact_class": "CONTROL_ONLY",
				"user_status":  "PENDING_REVIEW",
				"intalev":      map[string]any{"article_name": "Инталев 1"},
				"erp":          map[string]any{"article_name": "ERP 1"},
				"action":       map[string]any{"action_type": "MANUAL_REVIEW"},
				"confidence":   map[string]any{"score": 0.8},
				"evidence":     map[string]any{"explanation": "Нужно проверить", "source_file": "C:/secret/source.xlsx", "source_sha256": "SECRET"},
			},
			map[string]any{
				"candidate_id": "CAND-2",
				"decision":     "NO_RULE",
				"impact_class": "CONTROL_ONLY",
				"user_status":  "PENDING_REVIEW",
				"intalev":      map[string]any{"article_name": "Инталев 2"},
				"erp":          map[string]any{"article_name": "ERP 2"},
				"action":       map[string]any{"action_type": "ACCEPT_DIFFERENCE"},
				"confidence":   map[string]any{"score": 0.5},
				"evidence":     map[string]any{"explanation": "Нужно решение"},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteJSON(filepath.Join(rulesDir, "workflow_decision.json"), map[string]any{
		"schema_version":        "opiu-rules-workflow-decision.v1",
		"next_action":           "WAIT_USER_RULES",
		"reasons":               []string{"Нужно решение пользователя по 2 кандидатам."},
		"required_user_actions": []string{"REVIEW"},
		"state":                 map[string]any{"rules_revision_set_hash": "TEST"},
	}); err != nil {
		t.Fatal(err)
	}
	return store, run
}

func TestRulesReviewResultExposesCandidates(t *testing.T) {
	store, run := testWaitingRulesRun(t)
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/rules", nil)
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["ready"] != true {
		t.Fatalf("expected ready=true: %#v", payload)
	}
	if int(payload["candidate_count"].(float64)) != 2 {
		t.Fatalf("candidate_count=%v", payload["candidate_count"])
	}
	if payload["registry_persisted"] != false || int(payload["registry_persisted_count"].(float64)) != 0 {
		t.Fatalf("rules result claimed persistence before CAS merge: %#v", payload)
	}
	candidates := payload["candidates"].([]any)
	first := candidates[0].(map[string]any)
	evidence := first["evidence"].(map[string]any)
	if _, exists := evidence["source_file"]; exists {
		t.Fatal("source_file leaked into public rules review")
	}
	if _, exists := evidence["source_sha256"]; exists {
		t.Fatal("source_sha256 leaked into public rules review")
	}
	if err := atomicWriteJSON(filepath.Join(store.RunsDir(), run.ID, "rules-registry", "persistence.json"), rulesRegistryPersistenceReceipt{
		SchemaVersion:          "opiu-rules-registry-persistence.v1",
		RunID:                  run.ID,
		Phase:                  "after-user",
		RegistryPersisted:      true,
		RegistryPersistedCount: 1,
		RecordedAt:             time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["registry_persisted"] != true || int(payload["registry_persisted_count"].(float64)) != 1 {
		t.Fatalf("rules result did not acknowledge persisted rule: %#v", payload)
	}
}

func TestPersistRuleReviewDecisions(t *testing.T) {
	store, run := testWaitingRulesRun(t)
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	path, err := server.persistRuleReviewDecisions(run, ruleReviewDecisionRequest{
		Author:    "Тест",
		Decisions: []ruleReviewDecision{{CandidateID: "CAND-1", Decision: "MANUAL_REVIEW", Comment: "Проверить вручную"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc ruleReviewDecisionDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.SchemaVersion != "opiu-user-rule-decisions.v1" || doc.RunID != run.ID || len(doc.Decisions) != 1 {
		t.Fatalf("unexpected decisions document: %#v", doc)
	}
}

func TestResumeAfterRuleDecisionsPassesToR001(t *testing.T) {
	store, run := testWaitingRulesRun(t)
	contextValue, ok := store.Context(run.ContextID)
	if !ok {
		t.Fatal("test context is missing")
	}
	_ = writePipelineStructuralInventory(t, store, run, contextValue)
	runDir := filepath.Join(store.RunsDir(), run.ID)
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	r005Dir := filepath.Join(runDir, "r005")
	writeFailSoftR005Fixture(t, r005Dir, contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	refreshFailSoftInventoryProvenance(t, inventoryPath, r005Dir)
	bindingSHA, err := sha256File(filepath.Join(r005Dir, structuralControlInventoryFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	proofPipeline := &Pipeline{store: store}
	_, proofAudit, err := proofPipeline.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, proofAudit); err != nil {
		t.Fatal(err)
	}
	proofPath, _, err := materializeStructuralControlProof(run, contextValue, runDir, filepath.Join(r005Dir, "reconciliation.codex-input.json"))
	if err != nil {
		t.Fatal(err)
	}

	stages := make(chan string, 4)
	rulesRegistry, rulesSeed := newTestRulesRegistry(t, store)
	pipeline := &Pipeline{
		store:         store,
		rulesRegistry: rulesRegistry,
		runtime: &RuntimeAdapter{
			Root:          t.TempDir(),
			Node:          "node",
			RulesScript:   "rules.mjs",
			R001Script:    "r001.mjs",
			RulesRegistry: rulesSeed,
		},
		active: map[string]struct{}{},
	}
	pipeline.runner = func(stage string, command []string, values map[string]string, workDir, runtimeRoot string) error {
		stages <- stage
		switch stage {
		case "RULES_REVIEW":
			contextPath := filepath.Join(workDir, "rules_engine_context_after_user.json")
			var contextDoc map[string]any
			if err := readJSONFile(contextPath, &contextDoc); err != nil {
				return err
			}
			organization, ok := contextDoc["organization"].(map[string]any)
			if !ok || organization["id"] != contextValue.OrganizationID || organization["name"] != contextValue.OrganizationName || organization["path"] != contextValue.OrganizationPath {
				return errors.New("Rules review organization scope is incomplete")
			}
			if organization["include_descendants"] != false {
				return errors.New("Rules review unexpectedly includes descendants")
			}
			paths, ok := contextDoc["paths"].(map[string]any)
			if !ok || !sameCleanPath(paths["rules_registry"].(string), filepath.Join(workDir, "rules-input", "after-user", "current_rules.json")) || sameCleanPath(paths["rules_registry"].(string), rulesSeed) {
				return errors.New("Rules review did not receive the private persistent snapshot")
			}
			outputDir := filepath.Join(workDir, "rules-after-user")
			handoffPath := filepath.Join(workDir, "handoff", "r001", "r001_handoff.json")
			if err := os.MkdirAll(filepath.Dir(handoffPath), 0o700); err != nil {
				return err
			}
			if err := writeStructuralControlHandoffFixture(handoffPath, run, contextValue,
				filepath.Join(r005Dir, "reconciliation.codex-input.json"), proofPath); err != nil {
				return err
			}
			if err := atomicWriteJSON(filepath.Join(outputDir, "workflow_decision.json"), map[string]any{
				"schema_version": "opiu-rules-workflow-decision.v1",
				"run_id":         run.ID,
				"phase":          "AFTER_USER_DECISIONS",
				"next_action":    "PASS_TO_R001",
				"handoff":        map[string]any{"target": "R001", "handoff_path": handoffPath},
			}); err != nil {
				return err
			}
			writeNoopRulesEngineArtifacts(t, contextPath, outputDir, run.ID)
			return nil
		case "R001":
			writeFailSoftR001PackageFixtureForRun(t, filepath.Join(workDir, "r001"), run, contextValue)
			return nil
		default:
			return errors.New("unexpected stage: " + stage)
		}
	}
	server, err := NewServer(store, pipeline)
	if err != nil {
		t.Fatal(err)
	}
	decisionsPath, err := server.persistRuleReviewDecisions(run, ruleReviewDecisionRequest{
		Author:    "Тест",
		Decisions: []ruleReviewDecision{{CandidateID: "CAND-1", Decision: "REJECTED"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := pipeline.ResumeAfterRuleDecisions(run.ID, decisionsPath); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var current Run
	for time.Now().Before(deadline) {
		current, _ = store.Run(run.ID)
		if current.Status == RunCompletedReportOnly || current.Status == RunFailed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if current.Status != RunCompletedReportOnly || current.Stage != "DONE" {
		t.Fatalf("unexpected final run: status=%s stage=%s message=%s", current.Status, current.Stage, current.Message)
	}
	for index, expected := range []string{"RULES_REVIEW", "R001"} {
		select {
		case got := <-stages:
			if got != expected {
				t.Fatalf("stage %d: got %s want %s", index, got, expected)
			}
		default:
			t.Fatalf("stage %d was not executed", index)
		}
	}
}
