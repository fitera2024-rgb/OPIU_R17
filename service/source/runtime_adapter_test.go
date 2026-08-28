package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

func makePortableRuntimeFixture(t *testing.T, executableDir string) (string, string) {
	t.Helper()
	root := filepath.Join(executableDir, "runtime")
	for _, relative := range []string{
		"modules/reconciliation/source/opiu_reconcile.mjs",
		"modules/corrections/source/correction_engine_r001.mjs",
		"SAFETY.json",
		"node_modules/.keep",
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
	nodeName := "node"
	if runtime.GOOS == "windows" {
		nodeName = "node.exe"
	}
	nodePath := filepath.Join(root, "node", nodeName)
	if err := os.MkdirAll(filepath.Dir(nodePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nodePath, []byte("portable node fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	return root, nodePath
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

func TestRuntimeAdapterDiscoversExactAdjacentPortableNode(t *testing.T) {
	executableDir := t.TempDir()
	root, nodePath := makePortableRuntimeFixture(t, executableDir)
	t.Setenv("OPIU_NODE_PATH", filepath.Join(t.TempDir(), "must-not-be-used"))

	adapter, err := discoverRuntimeAdapterFrom("", filepath.Join(executableDir, "OPIU_R17.exe"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if adapter == nil || adapter.Root != filepath.Clean(root) || adapter.Node != filepath.Clean(nodePath) {
		t.Fatalf("portable adapter = %#v, node=%q", adapter, nodePath)
	}
}

func TestRuntimeAdapterFailsFastForBrokenAdjacentRuntime(t *testing.T) {
	executableDir := t.TempDir()
	brokenRoot, _ := makePortableRuntimeFixture(t, executableDir)
	if err := os.Remove(filepath.Join(brokenRoot, "SAFETY.json")); err != nil {
		t.Fatal(err)
	}

	validCWD := t.TempDir()
	makePortableRuntimeFixture(t, validCWD)
	_, err := discoverRuntimeAdapterFrom("", filepath.Join(executableDir, "OPIU_R17.exe"), validCWD)
	if err == nil || !strings.Contains(err.Error(), "adjacent portable runtime is invalid") || !strings.Contains(err.Error(), "SAFETY.json") {
		t.Fatalf("broken adjacent runtime was hidden by fallback: %v", err)
	}
}

func TestRuntimeAdapterFailsFastForAdjacentRuntimeWithoutPortableNode(t *testing.T) {
	executableDir := t.TempDir()
	root, nodePath := makePortableRuntimeFixture(t, executableDir)
	if err := os.Remove(nodePath); err != nil {
		t.Fatal(err)
	}
	legacyNode := filepath.Join(root, "node.exe")
	if err := os.WriteFile(legacyNode, []byte("legacy must not mask broken portable layout"), 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := discoverRuntimeAdapterFrom("", filepath.Join(executableDir, "OPIU_R17.exe"), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "portable Node runtime is missing") {
		t.Fatalf("non-portable adjacent node was accepted: %v", err)
	}
}

func TestRuntimeAdapterFailsFastForBrokenExplicitRoot(t *testing.T) {
	brokenRoot := t.TempDir()
	validCWD := t.TempDir()
	makePortableRuntimeFixture(t, validCWD)

	_, err := discoverRuntimeAdapterFrom(brokenRoot, filepath.Join(t.TempDir(), "OPIU_R17.exe"), validCWD)
	if err == nil || !strings.Contains(err.Error(), "configured runtime is invalid") {
		t.Fatalf("broken explicit root was hidden by fallback: %v", err)
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
