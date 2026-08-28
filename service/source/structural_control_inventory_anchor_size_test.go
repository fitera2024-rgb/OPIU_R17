package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func padStructuralCodexInput(t *testing.T, path string, targetSize int64) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() > targetSize {
		t.Fatalf("codex input fixture size=%d exceeds target=%d", info.Size(), targetSize)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte{' '}, 1<<20)
	remaining := targetSize - info.Size()
	for remaining > 0 {
		writeSize := int64(len(chunk))
		if remaining < writeSize {
			writeSize = remaining
		}
		if _, err := file.Write(chunk[:int(writeSize)]); err != nil {
			file.Close()
			t.Fatal(err)
		}
		remaining -= writeSize
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func rebindStructuralCodexInput(t *testing.T, r005Dir string) {
	t.Helper()
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["codex_input_sha256"] = codexSHA
	if err := atomicWriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)
}

func TestS10CodexInputLimitBoundaries(t *testing.T) {
	if structuralControlCodexInputMaxBytes != 128<<20 {
		t.Fatalf("codex input limit=%d; want=%d", structuralControlCodexInputMaxBytes, int64(128<<20))
	}
	regular := os.FileMode(0o600)
	if !isBoundedStructuralControlArtifact(regular, 64<<20+1, structuralControlCodexInputMaxBytes) {
		t.Fatal("codex input between 64 and 128 MiB was rejected")
	}
	if !isBoundedStructuralControlArtifact(regular, 128<<20, structuralControlCodexInputMaxBytes) {
		t.Fatal("codex input at 128 MiB was rejected")
	}
	if isBoundedStructuralControlArtifact(regular, 128<<20+1, structuralControlCodexInputMaxBytes) {
		t.Fatal("codex input above 128 MiB was accepted")
	}
	if isBoundedStructuralControlArtifact(regular, 64<<20+1, 64<<20) {
		t.Fatal("unchanged 64 MiB manifest limit was widened")
	}
}

func TestS10StructuralInventoryAcceptsCodexInputAbove64MiB(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventoryV3(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	padStructuralCodexInput(t, codexPath, 64<<20+1)
	rebindStructuralCodexInput(t, r005Dir)

	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err != nil {
		t.Fatalf("codex input above 64 MiB was rejected: %v", err)
	}
}

func TestS10StructuralInventoryRejectsCodexInputAbove128MiB(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventoryV3(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	if err := os.Truncate(codexPath, structuralControlCodexInputMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err == nil {
		t.Fatal("codex input above 128 MiB was accepted by current-run digest validation")
	}

	data, err := readStructuralControlArtifact(r005Dir, filepath.Join(r005Dir, "structural-control-inventory.json"), 16<<20)
	if err != nil {
		t.Fatal(err)
	}
	inventory, err := decodeStructuralControlInventory(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateStructuralPlanCrossLinks(inventory, r005Dir); err == nil {
		t.Fatal("codex input above 128 MiB was accepted by plan cross-link validation")
	}
}
