package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
