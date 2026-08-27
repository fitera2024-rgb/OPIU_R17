package main

import (
	"os"
	"path/filepath"
	"testing"
)

func makeRuntimeFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, relative := range []string{
		"modules/reconciliation/source/opiu_reconcile.mjs",
		"modules/corrections/source/correction_engine_r001.mjs",
		"modules/corrections/source/service_r001_owner_wrapper.mjs",
		"SAFETY.json",
		"node_modules/.keep",
		"runtime/node/node-test",
	} {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		content := []byte("fixture")
		if relative == "SAFETY.json" {
			content = []byte(`{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false,"one_c_actions_executed":false}`)
		}
		if err := os.WriteFile(path, content, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestRuntimeAdapterDiscoveryUsesExplicitRoot(t *testing.T) {
	root := makeRuntimeFixture(t)
	t.Setenv("OPIU_RUNTIME_ROOT", root)
	t.Setenv("OPIU_NODE_PATH", filepath.Join(root, "runtime", "node", "node-test"))
	adapter, err := discoverRuntimeAdapter()
	if err != nil {
		t.Fatal(err)
	}
	if adapter == nil || adapter.Root != filepath.Clean(root) {
		t.Fatalf("adapter = %#v", adapter)
	}
	if adapter.R005Script == "" || adapter.R001Script == "" {
		t.Fatalf("production runtime lacks a direct engine entrypoint: %#v", adapter)
	}
}

func TestRuntimeAdapterRejectsMissingSharedDependencies(t *testing.T) {
	root := makeRuntimeFixture(t)
	if err := os.RemoveAll(filepath.Join(root, "node_modules")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_NODE_PATH", filepath.Join(root, "runtime", "node", "node-test"))
	if _, err := runtimeAdapterAt(root); err == nil {
		t.Fatal("runtime without shared node_modules was accepted")
	}
}

func TestPeriodMode(t *testing.T) {
	cases := []struct {
		period string
		mode   string
	}{
		{period: "2026-08", mode: "month"},
		{period: "2026-Q3", mode: "quarter"},
		{period: "2026", mode: "year"},
	}
	for _, test := range cases {
		mode, err := periodMode(test.period)
		if err != nil {
			t.Fatalf("%s: %v", test.period, err)
		}
		if mode != test.mode {
			t.Fatalf("%s mode = %s", test.period, mode)
		}
	}
}
