package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeAdapterPrefersOwnerDecisionWrappersWhenMaterialized(t *testing.T) {
	root := makeRuntimeFixture(t)
	wrappers := []string{
		"modules/reconciliation/source/service_r005_owner_wrapper.mjs",
		"modules/corrections/source/service_r001_owner_wrapper.mjs",
	}
	for _, relative := range wrappers {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("OPIU_NODE_PATH", filepath.Join(root, "runtime", "node", "node-test"))
	adapter, err := runtimeAdapterAt(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(adapter.R005Script) != "service_r005_owner_wrapper.mjs" {
		t.Fatalf("R005 script = %s", adapter.R005Script)
	}
	if filepath.Base(adapter.R001Script) != "service_r001_owner_wrapper.mjs" {
		t.Fatalf("R001 script = %s", adapter.R001Script)
	}
	if filepath.Base(adapter.R001DiagnosticScript) != "correction_engine_r001.mjs" {
		t.Fatalf("R001 diagnostic script = %s", adapter.R001DiagnosticScript)
	}
}

func TestRuntimeAdapterFallsBackToCoreWithoutOwnerDecisionWrappers(t *testing.T) {
	root := makeRuntimeFixture(t)
	t.Setenv("OPIU_NODE_PATH", filepath.Join(root, "runtime", "node", "node-test"))
	adapter, err := runtimeAdapterAt(root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(adapter.R005Script) != "opiu_reconcile.mjs" {
		t.Fatalf("R005 fallback = %s", adapter.R005Script)
	}
	if filepath.Base(adapter.R001Script) != "correction_engine_r001.mjs" {
		t.Fatalf("R001 fallback = %s", adapter.R001Script)
	}
	if filepath.Base(adapter.R001DiagnosticScript) != "correction_engine_r001.mjs" {
		t.Fatalf("R001 diagnostic fallback = %s", adapter.R001DiagnosticScript)
	}
}
