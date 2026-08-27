package main

import (
	"reflect"
	"testing"
)

func TestPipelineRequiresAllThreeAdapters(t *testing.T) {
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
