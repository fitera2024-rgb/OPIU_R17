package main

import (
	"reflect"
	"testing"
)

func TestPipelineRequiresDirectR005AndR001Adapters(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"OPIU_R005_CMD_JSON", "OPIU_RULES_CMD_JSON", "OPIU_R001_CMD_JSON", "OPIU_RUNTIME_ROOT", "OPIU_NODE_PATH"} {
		t.Setenv(name, "")
	}
	pipeline, err := NewPipeline(store)
	if err != nil {
		t.Fatal(err)
	}
	if pipeline.Ready() {
		t.Fatal("partial or empty adapter set was treated as ready")
	}
}

func TestPipelineRejectsRulesAndDirectR001Overrides(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_RUNTIME_ROOT", "")
	t.Setenv("OPIU_ORGANIZATION_CATALOG", "missing-catalog.json")
	t.Setenv("OPIU_R005_CMD_JSON", `["r005","{run_id}","{context_id}","{organization_id}","{organization_name}","{organization_path}"]`)
	t.Setenv("OPIU_R001_CMD_JSON", `["r001","--handoff","{handoff}","--handoff-sha256","{handoff_sha256}"]`)
	t.Setenv("OPIU_RULES_CMD_JSON", `["rules"]`)
	if _, err := NewPipeline(store); err == nil {
		t.Fatal("production accepted OPIU_RULES_CMD_JSON")
	}
	t.Setenv("OPIU_RULES_CMD_JSON", "")
	t.Setenv("OPIU_R001_CMD_JSON", `["r001","--handoff","{handoff}","--handoff-sha256","{handoff_sha256}","--decisions","forged.json"]`)
	if _, err := NewPipeline(store); err == nil {
		t.Fatal("production accepted a direct R001 decisions override")
	}
}

func TestPipelineRejectsShellStringConfiguration(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_R005_CMD_JSON", "node engine.mjs")
	if _, err := NewPipeline(store); err == nil {
		t.Fatal("shell-like string was accepted instead of JSON argv")
	}
}

func TestPipelineRejectsPartialExternalAdapterSet(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_RUNTIME_ROOT", "")
	t.Setenv("OPIU_R005_CMD_JSON", `["node","r005.mjs"]`)
	t.Setenv("OPIU_RULES_CMD_JSON", "")
	t.Setenv("OPIU_R001_CMD_JSON", "")
	if _, err := NewPipeline(store); err == nil {
		t.Fatal("partial external adapter set was accepted")
	}
}

func TestCommandExpansionDoesNotUseShell(t *testing.T) {
	template := []string{"node", "bridge.mjs", "--erp", "{erp}", "--period={period}"}
	actual := expandCommand(template, map[string]string{"{erp}": "/tmp/a file.xlsx", "{period}": "2026-08"})
	expected := []string{"node", "bridge.mjs", "--erp", "/tmp/a file.xlsx", "--period=2026-08"}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("actual = %#v", actual)
	}
}
