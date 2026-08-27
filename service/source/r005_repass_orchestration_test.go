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
	pipeline := &Pipeline{
		store: store,
		runtime: &RuntimeAdapter{
			Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs",
			R001Script: "correction_engine_r001.mjs",
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
