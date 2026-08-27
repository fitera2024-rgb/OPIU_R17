package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBlockedR005RepassArtifactsProceedDirectlyToR001WithStringPeriod(t *testing.T) {
	TestRuntimePipelineIsDirectR005ServiceHandoffR001(t)
	return
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := Run{
		ID:        "run_uk9_2025_11",
		ContextID: "ctx_uk9",
		Status:    RunRunning,
		Stage:     "R005",
		StartedAt: time.Now().UTC(),
		Safety:    reportOnlySafety(),
	}
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID:               run.ContextID,
		Organization:     "9 Управляющая компания",
		OrganizationID:   structuralSourceOrganizationID,
		OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period:           "2025-11",
	}
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	rulesRegistry, rulesSeed := newTestRulesRegistry(t, store)
	pipeline := &Pipeline{
		store:         store,
		rulesRegistry: rulesRegistry,
		runtime: &RuntimeAdapter{
			Root:          t.TempDir(),
			Node:          "node",
			R005Script:    "opiu_reconcile.mjs",
			RulesScript:   "cli.mjs",
			R001Script:    "correction_engine_r001.mjs",
			RulesRegistry: rulesSeed,
		},
		active: map[string]struct{}{},
	}

	stages := []string{}
	pipeline.runner = func(stage string, command []string, values map[string]string, currentRunDir, runtimeRoot string) error {
		stages = append(stages, stage)
		switch stage {
		case "R005":
			joined := "\x00" + strings.Join(command, "\x00")
			for _, expected := range []string{run.ID, contextValue.ID, contextValue.OrganizationID, contextValue.OrganizationName, contextValue.OrganizationPath} {
				if !containsNULTerm(joined, expected) {
					t.Errorf("exact runtime R005 argv value missing: %q in %#v", expected, command)
				}
			}
			writePipelineStructuralInventoryV3(t, store, run, contextValue)
			writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_R005_REPASS_REQUIRED")
			refreshFailSoftInventoryProvenance(t, filepath.Join(runDir, "r005", "structural-control-inventory.json"), filepath.Join(runDir, "r005"))
		case "RULES":
			contextPath := filepath.Join(runDir, "rules_engine_context.json")
			data, err := os.ReadFile(contextPath)
			if err != nil {
				t.Fatal(err)
			}
			var rulesContext map[string]any
			if err := json.Unmarshal(data, &rulesContext); err != nil {
				t.Fatal(err)
			}
			if rulesContext["period"] != contextValue.Period {
				t.Fatalf("Rules received invalid period contract: %s", data)
			}
			if rulesContext["phase"] != "AFTER_R005" {
				t.Fatalf("Rules received invalid phase: %s", data)
			}
			paths := rulesContext["paths"].(map[string]any)
			expectedRegistry := filepath.Join(runDir, "rules-input", "initial", "current_rules.json")
			if !sameCleanPath(paths["rules_registry"].(string), expectedRegistry) || sameCleanPath(paths["rules_registry"].(string), rulesSeed) {
				t.Fatalf("Rules did not receive the private persistent snapshot: %s", data)
			}
			writeOrchestrationJSON(t, filepath.Join(runDir, "rules", "workflow_decision.json"), map[string]any{
				"schema_version": "opiu-rules-workflow-decision.v1",
				"run_id":         run.ID,
				"phase":          "AFTER_R005",
				"next_action":    "WAIT_USER_RULES",
				"handoff":        nil,
			})
			writeNoopRulesEngineArtifacts(t, contextPath, filepath.Join(runDir, "rules"), run.ID)
		case "R001_DIAGNOSTIC":
			joined := "\x00" + strings.Join(command, "\x00") + "\x00"
			if strings.Contains(joined, "\x00--handoff\x00") {
				t.Fatal("diagnostic R001 must not fabricate a Rules handoff")
			}
			writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
		case "R001":
			t.Fatal("financial R001 must not run before an explicit Rules decision and handoff")
		}
		return nil
	}

	var status RunStatus
	var stage string
	pipeline.executeRuntime(
		run,
		contextValue,
		"erp.xlsx",
		strings.Repeat("A", 64),
		"intalev.xlsx",
		runDir,
		func(gotStatus RunStatus, gotStage, _ string) {
			status, stage = gotStatus, gotStage
		},
	)

	if strings.Join(stages, ",") != "R005,RULES,R001_DIAGNOSTIC" {
		t.Fatalf("stages=%v; expected R005, Rules, then report-only R001 diagnostics", stages)
	}
	if status != RunWaitingUserRules || stage != "RULES_REVIEW" {
		t.Fatalf("status=%s stage=%s", status, stage)
	}
	stored, ok := store.Run(run.ID)
	if !ok || stored.Safety != reportOnlySafety() {
		t.Fatalf("REPORT_ONLY safety changed: %#v", stored.Safety)
	}
}

func TestNonZeroR005RemainsFailClosedEvenWhenReportArtifactsExist(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := Run{ID: "run_failed_r005", ContextID: "ctx_uk9", Status: RunRunning, Stage: "R005", StartedAt: time.Now().UTC(), Safety: reportOnlySafety()}
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID,
		OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-11",
	}
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	rulesRegistry, rulesSeed := newTestRulesRegistry(t, store)
	pipeline := &Pipeline{
		store:         store,
		rulesRegistry: rulesRegistry,
		runtime: &RuntimeAdapter{
			Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs",
			RulesScript: "cli.mjs", R001Script: "correction_engine_r001.mjs", RulesRegistry: rulesSeed,
		},
		active: map[string]struct{}{},
	}
	stages := []string{}
	pipeline.runner = func(stage string, command []string, values map[string]string, currentRunDir, runtimeRoot string) error {
		stages = append(stages, stage)
		if stage != "R005" {
			t.Fatalf("stage %s ran after non-zero R005", stage)
		}
		writeBlockedR005RepassFixture(t, filepath.Join(runDir, "r005"), contextValue)
		return errors.New("exit status 1")
	}

	var status RunStatus
	var stage string
	pipeline.executeRuntime(run, contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", runDir,
		func(gotStatus RunStatus, gotStage, _ string) { status, stage = gotStatus, gotStage })

	if strings.Join(stages, ",") != "R005" || status != RunFailed || stage != "R005" {
		t.Fatalf("stages=%v status=%s stage=%s", stages, status, stage)
	}
}

func writeBlockedR005RepassFixture(t *testing.T, r005Dir string, contextValue Context) {
	t.Helper()
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r005Dir, "reconciliation.xlsx"), []byte("synthetic report-only workbook"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeOrchestrationJSON(t, filepath.Join(r005Dir, "reconciliation.codex-input.json"), map[string]any{
		"schema":          "opiu-codex-review-input-v1",
		"organization":    contextValue.Organization,
		"profile_id":      "UK_R005",
		"period":          contextValue.Period,
		"report_only":     true,
		"posting_rows":    0,
		"ready_to_upload": false,
		"release_allowed": false,
		"rows":            []any{map[string]any{"code": "R001"}},
	})
	writeOrchestrationJSON(t, filepath.Join(r005Dir, "reconciliation.manifest.json"), map[string]any{
		"schema":          "opiu-auto-reconciliation-run-v3",
		"organization":    contextValue.Organization,
		"profile_id":      "UK_R005",
		"period":          contextValue.Period,
		"status":          "BLOCKED_R005_REPASS_REQUIRED",
		"report_only":     true,
		"posting_rows":    0,
		"ready_to_upload": false,
		"release_allowed": false,
	})
}

func writeOrchestrationJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}
