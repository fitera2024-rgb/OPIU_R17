package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func addTestSource(t *testing.T, store *Store, kind SourceKind, name string) SourceFile {
	t.Helper()
	id, err := newOpaqueID("src")
	if err != nil {
		t.Fatal(err)
	}
	ext := filepath.Ext(name)
	file := SourceFile{
		ID:        id,
		Name:      name,
		Kind:      kind,
		Size:      4,
		CreatedAt: time.Now().UTC(),
		DiskName:  id + ext,
		SHA256:    "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08",
	}
	path := filepath.Join(store.FilesDir(), file.DiskName)
	if err := os.WriteFile(path, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.PutFile(file); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestContextPreservesExactSelectedSources(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization:  "Управляющая компания",
		CFO:           "Главный офис",
		Period:        "2026-08",
		ERPFileID:     erp.ID,
		IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if contextValue.ERPFileID != erp.ID || contextValue.IntalevFileID != intalev.ID {
		t.Fatalf("selected source identity changed: %+v", contextValue)
	}
	if err := store.DeleteFile(erp.ID); err == nil {
		t.Fatal("active context source was deleted")
	}
	archived, err := store.ArchiveContext(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !archived.Archived {
		t.Fatal("context was not archived")
	}
	if err := store.DeleteFile(erp.ID); err != nil {
		t.Fatalf("archived source may be removed explicitly: %v", err)
	}
}

func TestPeriodContractSupportsMonthQuarterAndYear(t *testing.T) {
	for _, period := range []string{"2026-08", "2026-Q3", "2026"} {
		if !acceptedPeriod.MatchString(period) {
			t.Errorf("period %q was rejected", period)
		}
	}
	for _, period := range []string{"2026-13", "2026-Q5", "26-08", "latest"} {
		if acceptedPeriod.MatchString(period) {
			t.Errorf("invalid period %q was accepted", period)
		}
	}
}

func TestStoreReopenPreservesPrivateSourceMetadata(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	erp := addTestSource(t, store, SourceERP, "erp.zip")

	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	path, restored, err := sourcePath(reopened, erp.ID, SourceERP)
	if err != nil {
		t.Fatalf("persisted source became unavailable after restart: %v", err)
	}
	if filepath.Base(path) != erp.DiskName || restored.SHA256 != erp.SHA256 {
		t.Fatalf("private source metadata changed after restart: %+v", restored)
	}

	public, err := json.Marshal(reopened.Snapshot(false).Files)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), "disk_name") || strings.Contains(string(public), "sha256") {
		t.Fatalf("private source metadata leaked into public API: %s", public)
	}
}

func TestStoreMigratesLegacyStateWithoutPrivateSourceMetadata(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	erp := addTestSource(t, store, SourceERP, "erp.zip")

	statePath := filepath.Join(root, "state.json")
	raw, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	var legacy map[string]any
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	delete(legacy, "source_metadata")
	raw, err = json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, restored, err := sourcePath(reopened, erp.ID, SourceERP); err != nil {
		t.Fatalf("legacy source was not recovered: %v", err)
	} else if restored.DiskName != erp.DiskName || restored.SHA256 != erp.SHA256 {
		t.Fatalf("legacy source metadata was recovered incorrectly: %+v", restored)
	}

	persisted, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(persisted), "source_metadata") {
		t.Fatal("recovered source metadata was not persisted")
	}
}

func TestOpenStoreRecoversInterruptedRunsAfterServiceRestart(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Date(2026, time.August, 28, 19, 58, 59, 0, time.UTC)
	terminalFinishedAt := time.Date(2026, time.August, 28, 19, 59, 30, 0, time.UTC)
	safety := reportOnlySafety()
	terminalRuns := map[string]Run{
		"completed": {
			ID: "completed", ContextID: "ctx_completed", Status: RunCompletedReportOnly,
			Stage: "READY", Message: "Готово", StartedAt: startedAt, FinishedAt: &terminalFinishedAt,
			HasStructuralInventory: true, Safety: safety,
		},
		"failed": {
			ID: "failed", ContextID: "ctx_failed", Status: RunFailed,
			Stage: "R005", Message: "Исходная ошибка", StartedAt: startedAt, FinishedAt: &terminalFinishedAt,
			Safety: safety,
		},
		"blocked": {
			ID: "blocked", ContextID: "ctx_blocked", Status: RunBlockedInvalidContext,
			Stage: "PREFLIGHT", Message: "Контекст недоступен", StartedAt: startedAt, FinishedAt: &terminalFinishedAt,
			Safety: safety,
		},
		"blocked_engine": {
			ID: "blocked_engine", ContextID: "ctx_blocked_engine", Status: RunBlockedEngineAdapter,
			Stage: "ENGINE_ADAPTER", Message: "Runtime недоступен", StartedAt: startedAt, FinishedAt: &terminalFinishedAt,
			Safety: safety,
		},
		"blocked_inventory": {
			ID: "blocked_inventory", ContextID: "ctx_blocked_inventory", Status: RunBlockedStructuralInventory,
			Stage: "R005_INVENTORY", Message: "Структура не доказана", StartedAt: startedAt, FinishedAt: &terminalFinishedAt,
			Safety: safety,
		},
	}
	store.mu.Lock()
	for id, run := range terminalRuns {
		store.state.Runs[id] = run
	}
	for id, status := range map[string]RunStatus{
		"queued": RunQueued, "preflight": RunPreflight, "running": RunRunning,
	} {
		store.state.Runs[id] = Run{
			ID: id, ContextID: "ctx_" + id, Status: status, Stage: string(status),
			Message: "Незавершённый запуск", StartedAt: startedAt, Safety: safety,
		}
	}
	err = store.saveLocked()
	store.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	// A workbook without the final proof/manifest is deliberately just an
	// orphan artifact. Its presence must not promote the interrupted run.
	orphanDir := filepath.Join(root, "runs", "running", "r005")
	if err := os.MkdirAll(orphanDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphanDir, "reconciliation.xlsx"), []byte("orphan workbook"), 0o600); err != nil {
		t.Fatal(err)
	}

	recoveryStarted := time.Now().UTC()
	reopened, err := OpenStore(root)
	recoveryFinished := time.Now().UTC()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"queued", "preflight", "running"} {
		run, ok := reopened.Run(id)
		if !ok {
			t.Fatalf("recovered run %q is missing", id)
		}
		if run.Status != RunFailed || run.Stage != interruptedServiceRestartStage || run.Message != interruptedServiceRestartMessage {
			t.Fatalf("run %q was not terminalized safely: %+v", id, run)
		}
		if run.FinishedAt == nil || run.FinishedAt.Before(recoveryStarted) || run.FinishedAt.After(recoveryFinished) {
			t.Fatalf("run %q has invalid recovery finish time: %+v", id, run.FinishedAt)
		}
		if run.Safety != safety {
			t.Fatalf("run %q safety changed during recovery: got %+v want %+v", id, run.Safety, safety)
		}
	}
	if hasActiveRuns(reopened) {
		t.Fatal("recovered store still exposes an active run")
	}
	if orphan, _ := reopened.Run("running"); orphan.Status == RunCompletedReportOnly {
		t.Fatalf("orphan workbook was promoted to completed result: %+v", orphan)
	}
	for id, want := range terminalRuns {
		got, ok := reopened.Run(id)
		if !ok || !reflect.DeepEqual(got, want) {
			t.Fatalf("terminal run %q changed: got %+v want %+v", id, got, want)
		}
	}

	statePath := filepath.Join(root, "state.json")
	firstRecovery, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	secondOpen, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	secondRecovery, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(firstRecovery, secondRecovery) {
		t.Fatal("second OpenStore rewrote an already recovered state")
	}
	for _, id := range []string{"queued", "preflight", "running"} {
		first, _ := reopened.Run(id)
		second, _ := secondOpen.Run(id)
		if !reflect.DeepEqual(first, second) {
			t.Fatalf("recovery is not idempotent for %q: first %+v second %+v", id, first, second)
		}
	}
}
