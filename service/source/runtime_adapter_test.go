package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
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
	if adapter.RulesScript != "" || adapter.RulesRegistry != "" || directoryExists(filepath.Join(root, "modules", "rules-engine")) {
		t.Fatalf("production runtime unexpectedly requires Rules: %#v", adapter)
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

func TestRulesContextPreservesReportOnlyBoundary(t *testing.T) {
	root := makeRuntimeFixture(t)
	adapter := &RuntimeAdapter{Root: root, RulesRegistry: filepath.Join(root, "data", "defaults", "rules.json")}
	path := filepath.Join(t.TempDir(), "context.json")
	run := Run{ID: "run_test", ContextID: "ctx_test", StartedAt: time.Now()}
	contextValue := Context{ID: "ctx_test", Organization: "Организация", OrganizationID: "ORG-1", OrganizationName: "Организация", OrganizationPath: "Холдинг / Организация", CFO: "ЦФО", Period: "2026-08"}
	sourceDir := t.TempDir()
	r005Codex := filepath.Join(sourceDir, "r005.json")
	proofPath := filepath.Join(sourceDir, "structural-proof.json")
	if err := os.WriteFile(r005Codex, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(proofPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeRulesContext(path, run, contextValue, adapter.RulesRegistry, "r005.xlsx", r005Codex, proofPath, "rules", "handoff"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	if value["schema_version"] != "opiu-rules-engine-context.v1" || value["phase"] != "AFTER_R005" {
		t.Fatalf("unexpected context: %s", data)
	}
	if value["period"] != contextValue.Period {
		t.Fatalf("Rules period must be a string equal to the Service context: %s", data)
	}
	organization, ok := value["organization"].(map[string]any)
	if !ok || organization["id"] != contextValue.OrganizationID || organization["name"] != contextValue.OrganizationName || organization["path"] != contextValue.OrganizationPath {
		t.Fatalf("complete Rules organization scope missing: %s", data)
	}
	if organization["include_descendants"] != false {
		t.Fatalf("Service must not broaden organization scope to descendants: %s", data)
	}
	meta, ok := value["meta"].(map[string]any)
	if !ok || meta["report_only"] != true {
		t.Fatalf("report_only missing: %s", data)
	}
	paths := value["paths"].(map[string]any)
	hashes := value["source_hashes"].(map[string]any)
	if paths["structural_control_proof"] != proofPath || !validSHA256(hashes["structural_control_proof"].(string)) {
		t.Fatalf("Rules context lost the verified Service proof: %s", data)
	}
}

func TestReadRulesWorkflowRequiresNextAction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workflow.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":"opiu-rules-workflow-decision.v1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRulesWorkflow(path); err == nil {
		t.Fatal("workflow without next_action was accepted")
	}
}

func TestValidatedRulesWorkflowIsManifestBoundBeforeMerge(t *testing.T) {
	outputDir := t.TempDir()
	workflowPath := filepath.Join(outputDir, "workflow_decision.json")
	workflow := map[string]any{
		"schema_version": "opiu-rules-workflow-decision.v1",
		"run_id":         "run_workflow",
		"phase":          "AFTER_R005",
		"next_action":    "WAIT_USER_RULES",
	}
	if err := atomicWriteJSON(workflowPath, workflow); err != nil {
		t.Fatal(err)
	}
	workflowHash, _ := sha256File(workflowPath)
	if err := atomicWriteJSON(filepath.Join(outputDir, "engine_manifest.json"), map[string]any{
		"schema_version": rulesEngineManifestSchema,
		"run_id":         "run_workflow",
		"phase":          "AFTER_R005",
		"output_hashes":  map[string]any{"workflow_decision.json": workflowHash},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := readValidatedRulesWorkflow(outputDir, "run_workflow", "initial"); err != nil {
		t.Fatalf("valid workflow was rejected: %v", err)
	}
	workflow["next_action"] = "COMPLETE"
	if err := atomicWriteJSON(workflowPath, workflow); err != nil {
		t.Fatal(err)
	}
	if _, err := readValidatedRulesWorkflow(outputDir, "run_workflow", "initial"); err == nil {
		t.Fatal("workflow modified after the manifest was accepted")
	}
}
