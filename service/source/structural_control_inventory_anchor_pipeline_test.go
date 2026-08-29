package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePipelineStructuralInventory(t *testing.T, store *Store, run Run, contextValue Context) string {
	return writePipelineStructuralInventoryDocument(t, store, run, contextValue, structuralSourceInventory(run.ID, contextValue.ID))
}

func writePipelineStructuralInventoryV3(t *testing.T, store *Store, run Run, contextValue Context) string {
	return writePipelineStructuralInventoryDocument(t, store, run, contextValue, structuralSourceInventoryV3(run.ID, contextValue.ID))
}

func writePipelineStructuralInventoryDocument(t *testing.T, store *Store, run Run, contextValue Context, inventory map[string]any) string {
	t.Helper()
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	organization := inventory["organization"].(map[string]any)
	organization["id"] = contextValue.OrganizationID
	organization["name"] = contextValue.OrganizationName
	organization["path"] = contextValue.OrganizationPath
	originalPeriod, _ := inventory["period"].(string)
	inventory["period"] = contextValue.Period
	if inventory["schema_version"] == "opiu-structural-control-inventory.v3" {
		if originalPeriod != contextValue.Period {
			for _, side := range []string{"intalev_members", "erp_members"} {
				for _, rawMember := range inventory[side].([]any) {
					member := rawMember.(map[string]any)
					source := member["source"].(map[string]any)
					member["source_identity_scope"] = source["sha256"].(string) + "|" + source["sheet"].(string) + "|" + contextValue.Period
				}
			}
		}
		refreshStructuralV3MemberHashes(t, inventory)
		inventory["safety"] = structuralControlV3SafetyFixture()
	}
	reportPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	if err := os.WriteFile(reportPath, []byte("exact report bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	reportSHA, err := sha256File(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(r005Dir, "erp-operation-journal.xlsx")
	writeSyntheticReportWorkbook(t, journalPath, "Лист_1", nil)
	journalSHA, err := sha256File(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	plan := map[string]any{
		"schema_version":           inventory["schema_version"],
		"status":                   "ELIGIBLE_PENDING_CURRENT_RUN_PROVENANCE",
		"inventory_id":             inventory["inventory_id"],
		"run_id":                   run.ID,
		"context_id":               contextValue.ID,
		"organization":             organization,
		"period":                   contextValue.Period,
		"hierarchy_versions":       inventory["hierarchy_versions"],
		"member_hashes":            inventory["member_hashes"],
		"input_hashes":             inventory["input_hashes"],
		"blocker_codes":            []any{},
		"verified_binding_written": false,
		"binding_status":           "PENDING_CURRENT_RUN_PROVENANCE",
		"default_behavior":         "PROCESS_ALL_DISCREPANCIES",
		"optional_control_only":    true,
		"correction_authority":     false,
		"financial_rows":           0,
		"safety":                   reportOnlySafety(),
	}
	if inventory["schema_version"] == "opiu-structural-control-inventory.v3" {
		plan["candidate_semantics"] = "USER_DECLARED_CONTROL_ONLY"
		plan["automatic_business_block_classification"] = false
		plan["user_declaration_required"] = true
		plan["safety"] = structuralControlV3SafetyFixture()
	}
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	if err := atomicWriteJSON(codexPath, map[string]any{
		"schema": "opiu-codex-review-input-v1", "organization": contextValue.OrganizationName,
		"organization_code": contextValue.OrganizationID, "period": contextValue.Period,
		"report_path": reportPath, "report_sha256": strings.ToUpper(reportSHA),
		"output_path": reportPath, "output_sha256": strings.ToUpper(reportSHA), "structural_control_inventory": plan,
		"report_only": true, "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false,
		"operation_evidence": map[string]any{
			"journal_sha256": strings.ToUpper(journalSHA), "journal_sheet": "Лист_1",
			"input": map[string]any{"journal_source": journalPath}, "rows": []any{},
		},
		"structural_control_settings_binding": map[string]any{
			"schema": structuralControlSettingsSchema, "status": "MISSING_DEFAULT_ALL_GROUPS", "set_count": 0, "sets": []any{},
			"correction_authority": false, "financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
		},
		"structural_control_settings_selection": map[string]any{
			"authority": structuralControlAuthorityServiceNone, "status": "SERVICE_NO_SETTINGS", "path": "",
		},
		"structural_group_control_results": []any{},
	}); err != nil {
		t.Fatal(err)
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	if err := atomicWriteJSON(manifestPath, map[string]any{
		"schema": "opiu-auto-reconciliation-run-v3", "organization": contextValue.OrganizationName,
		"organization_code": contextValue.OrganizationID, "period": contextValue.Period, "status": "PASS_R005",
		"output_path": reportPath, "output_sha256": strings.ToUpper(reportSHA), "structural_control_inventory": plan,
		"codex_input_path": codexPath, "codex_input_sha256": strings.ToUpper(codexSHA),
		"report_only": true, "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false,
	}); err != nil {
		t.Fatal(err)
	}
	manifestSHA, err := sha256File(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	currentRun := map[string]any{
		"report":         map[string]any{"file": reportPath, "sha256": reportSHA},
		"codex_input":    map[string]any{"file": codexPath, "sha256": codexSHA},
		"manifest":       map[string]any{"file": manifestPath, "sha256": manifestSHA},
		"scope_verified": true, "verification_blockers": []any{},
		"run_id": run.ID, "context_id": contextValue.ID, "organization": organization,
		"period": contextValue.Period, "inventory_id": inventory["inventory_id"],
	}
	inventory["current_run_provenance"] = currentRun
	if err := atomicWriteJSON(inventoryPath, inventory); err != nil {
		t.Fatal(err)
	}
	inventoryBytes, err := os.ReadFile(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	inventoryDigest := sha256.Sum256(inventoryBytes)
	inventorySHA := strings.ToUpper(hex.EncodeToString(inventoryDigest[:]))
	bindingPath := filepath.Join(r005Dir, "structural-control-inventory.binding.json")
	provenanceSHA, err := canonicalJSONSHA256(currentRun)
	if err != nil {
		t.Fatal(err)
	}
	bindingSchema := "opiu-structural-control-inventory-binding.v2"
	if inventory["schema_version"] == "opiu-structural-control-inventory.v3" {
		bindingSchema = "opiu-structural-control-inventory-binding.v3"
	}
	binding := map[string]any{
		"schema_version":                bindingSchema,
		"artifact_type":                 "STRUCTURAL_CONTROL_INVENTORY",
		"run_id":                        run.ID,
		"context_id":                    contextValue.ID,
		"organization_id":               contextValue.OrganizationID,
		"organization_name":             contextValue.OrganizationName,
		"organization_path":             contextValue.OrganizationPath,
		"period":                        contextValue.Period,
		"inventory_id":                  inventory["inventory_id"],
		"inventory_file":                filepath.Base(inventoryPath),
		"sha256":                        inventorySHA,
		"input_hashes":                  inventory["input_hashes"],
		"hierarchy_versions":            inventory["hierarchy_versions"],
		"member_hashes":                 inventory["member_hashes"],
		"report":                        currentRun["report"],
		"codex_input":                   currentRun["codex_input"],
		"manifest":                      currentRun["manifest"],
		"current_run_provenance_sha256": provenanceSHA,
		"verified":                      true,
		"safety":                        reportOnlySafety(),
	}
	if bindingSchema == "opiu-structural-control-inventory-binding.v3" {
		binding["candidate_semantics"] = "USER_DECLARED_CONTROL_ONLY"
		binding["automatic_business_block_classification"] = false
		binding["user_declaration_required"] = true
		binding["correction_authority"] = false
		binding["safety"] = structuralControlV3SafetyFixture()
	}
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
	bindingBytes, err := os.ReadFile(bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	bindingDigest := sha256.Sum256(bindingBytes)
	return strings.ToUpper(hex.EncodeToString(bindingDigest[:]))
}

func newPipelineStructuralContext(t *testing.T) (*Store, Context, Run, string) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	configureTestOrganizationCatalog(t, store)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization: structuralSourceOrganizationName, OrganizationID: structuralSourceOrganizationID,
		OrganizationName: structuralSourceOrganizationName, OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period: "2025-10", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	return store, contextValue, run, runDir
}

func TestExternalPipelineAnchorsVerifiedInventoryBeforeDirectR001(t *testing.T) {
	{
		store, contextValue, run, runDir := newPipelineStructuralContext(t)
		erpPath, intalevPath := testServiceSourcePaths(runDir)
		stages := []string{}
		pipeline := &Pipeline{store: store, commands: map[string][]string{
			"R005": {"r005", "--run-id", "{run_id}", "--context-id", "{context_id}", "--organization-id", "{organization_id}", "--organization-name", "{organization_name}", "--organization-path", "{organization_path}"},
			"R001": {"r001", "--handoff", "{handoff}", "--handoff-sha256", "{handoff_sha256}"},
		}}
		pipeline.runner = func(stage string, command []string, values map[string]string, _, _ string) error {
			stages = append(stages, stage)
			switch stage {
			case "R005":
				writePipelineStructuralInventoryV3(t, store, run, contextValue)
				r005Dir := filepath.Join(runDir, "r005")
				writeFailSoftR005Fixture(t, r005Dir, contextValue, "BLOCKED_R005_REPASS_REQUIRED")
				refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)
			case "R001":
				if _, ok := store.StructuralControlInventoryAnchor(run.ID); !ok {
					t.Fatal("R001 started before immutable structural inventory anchor")
				}
				expanded := expandCommand(command, values)
				joined := "\x00" + strings.Join(expanded, "\x00") + "\x00"
				if !strings.Contains(joined, "\x00--handoff\x00") || !strings.Contains(joined, "\x00--handoff-sha256\x00") {
					t.Fatalf("external R001 lost canonical handoff arguments: %#v", expanded)
				}
				writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
			default:
				t.Fatalf("legacy stage became reachable: %s", stage)
			}
			return nil
		}
		var finalStatus RunStatus
		var finalStage string
		pipeline.executeExternal(run, contextValue, erpPath, intalevPath, runDir, func(status RunStatus, stage, _ string) {
			finalStatus, finalStage = status, stage
		})
		if strings.Join(stages, ",") != "R005,R001" || finalStatus != RunCompletedReportOnly || finalStage != "DONE" {
			t.Fatalf("external direct result: stages=%v status=%s stage=%s", stages, finalStatus, finalStage)
		}
	}
}

func TestExternalPipelineBlocksBeforeHandoffWithoutVerifiedInventory(t *testing.T) {
	{
		store, contextValue, run, runDir := newPipelineStructuralContext(t)
		erpPath, intalevPath := testServiceSourcePaths(runDir)
		pipeline := &Pipeline{store: store, commands: map[string][]string{
			"R005": {"r005"}, "R001": {"r001", "--handoff", "{handoff}", "--handoff-sha256", "{handoff_sha256}"},
		}}
		pipeline.runner = func(stage string, _ []string, _ map[string]string, _, _ string) error {
			if stage != "R005" {
				t.Fatalf("downstream stage ran without inventory: %s", stage)
			}
			writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_STRUCTURAL_INVENTORY")
			return nil
		}
		var finalStatus RunStatus
		var finalStage string
		pipeline.executeExternal(run, contextValue, erpPath, intalevPath, runDir, func(status RunStatus, stage, _ string) {
			finalStatus, finalStage = status, stage
		})
		if finalStatus != RunBlockedStructuralInventory || finalStage != "R005_INVENTORY" {
			t.Fatalf("missing inventory status=%s stage=%s", finalStatus, finalStage)
		}
	}
}

func TestExternalPipelineBlocksIncompleteExactOrganizationBeforeR005(t *testing.T) {
	store, contextValue, run, runDir := newPipelineStructuralContext(t)
	contextValue.OrganizationPath = ""
	r005Started := false
	var finalStatus RunStatus
	var finalStage string
	pipeline := &Pipeline{store: store, commands: map[string][]string{"R005": {"r005"}, "RULES": {"rules"}, "R001": {"r001"}}}
	pipeline.runner = func(stage string, _ []string, _ map[string]string, _, _ string) error {
		if stage == "R005" {
			r005Started = true
		}
		return nil
	}
	pipeline.executeExternal(run, contextValue, "erp.xlsx", "intalev.xlsx", runDir, func(status RunStatus, stage, _ string) {
		finalStatus, finalStage = status, stage
	})
	if r005Started || finalStatus != RunBlockedInvalidContext || finalStage != "PREFLIGHT" {
		t.Fatalf("r005=%v status=%s stage=%s", r005Started, finalStatus, finalStage)
	}
}

func TestExternalPipelineRejectsUnverifiedStructuralInventoryBeforeHandoff(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, string)
	}{
		{
			name: "binding blocked",
			mutate: func(t *testing.T, r005Dir string) {
				mutateStructuralJSON(t, filepath.Join(r005Dir, structuralControlInventoryFile), func(value map[string]any) {
					value["status"] = "BLOCKED"
				})
			},
		},
		{
			name: "binding malformed",
			mutate: func(t *testing.T, r005Dir string) {
				if err := os.WriteFile(filepath.Join(r005Dir, structuralControlInventoryFile), []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "organization path mismatch",
			mutate: func(t *testing.T, r005Dir string) {
				mutateStructuralJSON(t, filepath.Join(r005Dir, structuralControlInventoryFile), func(value map[string]any) {
					value["organization_path"] = "Холдинг / другая организация"
				})
			},
		},
		{
			name: "inventory digest drift",
			mutate: func(t *testing.T, r005Dir string) {
				path := filepath.Join(r005Dir, "structural-control-inventory.json")
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.WriteString("\n"); err != nil {
					file.Close()
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "inventory blocked",
			mutate: func(t *testing.T, r005Dir string) {
				inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
				mutateStructuralJSON(t, inventoryPath, func(value map[string]any) { value["status"] = "BLOCKED" })
				inventorySHA, err := sha256File(inventoryPath)
				if err != nil {
					t.Fatal(err)
				}
				mutateStructuralJSON(t, filepath.Join(r005Dir, structuralControlInventoryFile), func(value map[string]any) {
					value["sha256"] = inventorySHA
				})
			},
		},
		{
			name: "inventory path escape",
			mutate: func(t *testing.T, r005Dir string) {
				mutateStructuralJSON(t, filepath.Join(r005Dir, structuralControlInventoryFile), func(value map[string]any) {
					value["inventory_file"] = filepath.Join("..", "outside.json")
				})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, contextValue, run, runDir := newPipelineStructuralContext(t)
			rulesStarted := false
			var finalStatus RunStatus
			var finalStage string
			pipeline := &Pipeline{store: store, commands: map[string][]string{"R005": {"r005"}, "RULES": {"rules"}, "R001": {"r001"}}}
			pipeline.runner = func(stage string, _ []string, _ map[string]string, _, _ string) error {
				if stage == "R005" {
					writePipelineStructuralInventoryV3(t, store, run, contextValue)
					test.mutate(t, filepath.Join(runDir, "r005"))
				}
				if stage == "RULES" {
					rulesStarted = true
				}
				return nil
			}
			pipeline.executeExternal(run, contextValue, "erp.xlsx", "intalev.xlsx", runDir, func(status RunStatus, stage, _ string) {
				finalStatus, finalStage = status, stage
			})
			if rulesStarted || finalStatus != RunBlockedStructuralInventory || finalStage != "R005_INVENTORY" {
				t.Fatalf("rules=%v status=%s stage=%s", rulesStarted, finalStatus, finalStage)
			}
			if _, ok := store.StructuralControlInventoryAnchor(run.ID); ok {
				t.Fatal("unverified inventory created an anchor")
			}
		})
	}
}

func TestStructuralArtifactSymlinkModeIsRejected(t *testing.T) {
	if isBoundedStructuralControlArtifact(os.ModeSymlink, 10, 100) {
		t.Fatal("symlink mode passed the production bounded-file predicate")
	}
}

func TestStructuralInventoryBindingSymlinkIsRejected(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)
	bindingBytes, err := os.ReadFile(bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(t.TempDir(), "binding.json")
	if err := os.WriteFile(outsidePath, bindingBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(bindingPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePath, bindingPath); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err == nil {
		t.Fatal("symlinked binding was accepted")
	}
	if _, ok := store.StructuralControlInventoryAnchor(run.ID); ok {
		t.Fatal("symlinked binding created an anchor")
	}
}

func TestStructuralInventoryAnchorPersistsAndRejectsReplacement(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	expectedSHA := strings.ToUpper(writePipelineStructuralInventoryDocument(t, store, run, contextValue, structuralSourceInventoryV3(run.ID, contextValue.ID)))
	pipeline := &Pipeline{store: store}
	if err := pipeline.anchorStructuralControlInventory(run, contextValue, filepath.Join(store.RunsDir(), run.ID, "r005")); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(store.root)
	if err != nil {
		t.Fatal(err)
	}
	anchor, ok := reopened.StructuralControlInventoryAnchor(run.ID)
	if !ok || anchor.BindingSHA256 != expectedSHA {
		t.Fatalf("persisted anchor=%#v ok=%v expected=%s", anchor, ok, expectedSHA)
	}
	if err := reopened.AnchorStructuralControlInventory(run.ID, strings.Repeat("B", 64)); err == nil {
		t.Fatal("different replacement anchor was accepted")
	}
	anchor, _ = reopened.StructuralControlInventoryAnchor(run.ID)
	if anchor.BindingSHA256 != expectedSHA {
		t.Fatal("immutable anchor changed after rejected replacement")
	}
}

func mutateStructuralJSON(t *testing.T, path string, mutate func(map[string]any)) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value := map[string]any{}
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	mutate(value)
	if err := atomicWriteJSON(path, value); err != nil {
		t.Fatal(err)
	}
}

func containsNULTerm(joined, value string) bool {
	return value != "" && len(joined) >= len(value)+1 && stringContains(joined, "\x00"+value)
}

func stringContains(value, fragment string) bool {
	for index := 0; index+len(fragment) <= len(value); index++ {
		if value[index:index+len(fragment)] == fragment {
			return true
		}
	}
	return false
}
