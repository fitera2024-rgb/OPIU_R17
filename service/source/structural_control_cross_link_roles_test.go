package main

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestUI010ActiveUIFixedVersionMaterializesRealShapedCodexInput(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	now := time.Now().UTC()
	run.Status = RunCompletedReportOnly
	run.Stage = "R005_COMPLETED"
	run.Message = "Проверенный инвентарь R005 сформирован"
	run.FinishedAt = &now
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	rewriteStructuralCrossLinkFixture(t, r005Dir, func(document map[string]any) {
		delete(document, "output_path")
		delete(document, "output_sha256")
	}, nil)
	bindingSHA, err := sha256File(filepath.Join(r005Dir, structuralControlInventoryFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	context := structuralSourceTestContext{
		server:         &Server{store: store},
		store:          store,
		contextID:      contextValue.ID,
		runID:          run.ID,
		organizationID: contextValue.OrganizationID,
		inventoryID:    structuralSourceInventoryID,
		inventoryPath:  filepath.Join(r005Dir, "structural-control-inventory.json"),
	}
	draft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	settingsPath, audit, err := (&Pipeline{store: store}).materializeActiveStructuralControlSettings(
		run, contextValue, filepath.Join(store.RunsDir(), run.ID))
	if err != nil || settingsPath == "" || audit.Status != "ACTIVE_UI_FIXED_SETS_MATERIALIZED" || audit.SetCount != 1 {
		t.Fatalf("active UI-fixed legacy-shaped origin was not materialized: path=%q audit=%#v err=%v", settingsPath, audit, err)
	}
}

func TestUI010StructuralCrossLinksUseRoleSpecificReportFields(t *testing.T) {
	tests := []struct {
		name           string
		mutateCodex    func(map[string]any)
		mutateManifest func(map[string]any)
		wantError      string
	}{
		{
			name: "real shaped Codex input without manifest output fields",
			mutateCodex: func(document map[string]any) {
				delete(document, "output_path")
				delete(document, "output_sha256")
			},
		},
		{
			name: "current dual field Codex input remains valid",
		},
		{
			name: "Codex report path tamper",
			mutateCodex: func(document map[string]any) {
				document["report_path"] = filepath.Join("C:\\wrong", "reconciliation.xlsx")
			},
			wantError: "Codex input does not bind exact report",
		},
		{
			name: "Codex report digest tamper",
			mutateCodex: func(document map[string]any) {
				document["report_sha256"] = strings.Repeat("F", 64)
			},
			wantError: "Codex input does not bind exact report",
		},
		{
			name: "manifest output path tamper",
			mutateManifest: func(document map[string]any) {
				document["output_path"] = filepath.Join("C:\\wrong", "reconciliation.xlsx")
			},
			wantError: "current-run JSON scope does not match",
		},
		{
			name: "manifest output digest tamper",
			mutateManifest: func(document map[string]any) {
				document["output_sha256"] = strings.Repeat("F", 64)
			},
			wantError: "current-run JSON scope does not match",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, contextValue, run, _ := newPipelineStructuralContext(t)
			writePipelineStructuralInventory(t, store, run, contextValue)
			r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
			rewriteStructuralCrossLinkFixture(t, r005Dir, test.mutateCodex, test.mutateManifest)

			_, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue)
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("role-specific structural proof rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error=%v; want %q", err, test.wantError)
			}
		})
	}
}

func TestUI010PipelineStructuralErrorMessageIsExactAndDoesNotLeakPaths(t *testing.T) {
	message := structuralControlSettingsFailureMessage(errors.New(
		`active origin C:\\private\\run: STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED: structural inventory Codex input does not bind exact report`,
	))
	if message != "Настройка группировки блоков не прошла проверку: файл доказательств Codex не связан с точным отчётом" {
		t.Fatalf("unexpected exact message: %q", message)
	}
	if strings.Contains(message, `C:\\private`) || strings.Contains(message, "STRUCTURAL_CONTROL_") {
		t.Fatalf("private technical detail leaked: %q", message)
	}
	unknown := structuralControlSettingsFailureMessage(errors.New(`open C:\\private\\registry.json: access denied`))
	if unknown != "Настройка группировки блоков не прошла проверку: целостность подтверждённых данных не доказана" ||
		strings.Contains(unknown, `C:\\private`) {
		t.Fatalf("unknown error was not safely summarized: %q", unknown)
	}
}

func rewriteStructuralCrossLinkFixture(
	t *testing.T,
	r005Dir string,
	mutateCodex func(map[string]any),
	mutateManifest func(map[string]any),
) {
	t.Helper()
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)

	var codex map[string]any
	if err := readJSONFile(codexPath, &codex); err != nil {
		t.Fatal(err)
	}
	if mutateCodex != nil {
		mutateCodex(codex)
	}
	if err := atomicWriteJSON(codexPath, codex); err != nil {
		t.Fatal(err)
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}

	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["codex_input_path"] = codexPath
	manifest["codex_input_sha256"] = codexSHA
	if mutateManifest != nil {
		mutateManifest(manifest)
	}
	if err := atomicWriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	manifestSHA, err := sha256File(manifestPath)
	if err != nil {
		t.Fatal(err)
	}

	var inventory map[string]any
	if err := readJSONFile(inventoryPath, &inventory); err != nil {
		t.Fatal(err)
	}
	current := inventory["current_run_provenance"].(map[string]any)
	current["codex_input"] = map[string]any{"file": codexPath, "sha256": codexSHA}
	current["manifest"] = map[string]any{"file": manifestPath, "sha256": manifestSHA}
	if err := atomicWriteJSON(inventoryPath, inventory); err != nil {
		t.Fatal(err)
	}
	inventorySHA, err := sha256File(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	provenanceSHA, err := canonicalJSONSHA256(current)
	if err != nil {
		t.Fatal(err)
	}

	var binding map[string]any
	if err := readJSONFile(bindingPath, &binding); err != nil {
		t.Fatal(err)
	}
	binding["sha256"] = inventorySHA
	binding["codex_input"] = current["codex_input"]
	binding["manifest"] = current["manifest"]
	binding["current_run_provenance_sha256"] = provenanceSHA
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
}
