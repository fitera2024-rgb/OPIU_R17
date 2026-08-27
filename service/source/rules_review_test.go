package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

func TestRulesReviewResultIsDisabled(t *testing.T) {
	store, run := testWaitingRulesRun(t)
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/rules", nil)
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
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

func TestResumeAfterRuleDecisionsIsUnreachable(t *testing.T) {
	{
		store, run := testWaitingRulesRun(t)
		pipeline := &Pipeline{store: store}
		if err := pipeline.ResumeAfterRuleDecisions(run.ID, "unused"); err == nil || !strings.Contains(err.Error(), "Rules resume отключён") {
			t.Fatalf("legacy Rules resume was reachable: %v", err)
		}
	}
}
