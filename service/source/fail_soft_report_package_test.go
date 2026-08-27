package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBusinessBlockedR005StillBuildsRulesReviewDiagnosticPackage(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := Run{
		ID: "run_fail_soft_hierarchy", ContextID: "ctx_fail_soft_hierarchy",
		Status: RunRunning, Stage: "R005", StartedAt: time.Now().UTC(), Safety: reportOnlySafety(),
	}
	contextValue := Context{
		ID: run.ContextID, Organization: "9 Управляющая компания",
		OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	rulesRegistry, rulesSeed := newTestRulesRegistry(t, store)
	runDir := filepath.Join(store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runtimeRoot := makeRuntimeFixture(t)
	ownerWrapper := filepath.Join(runtimeRoot, "modules", "corrections", "source", "service_r001_owner_wrapper.mjs")
	if err := os.WriteFile(ownerWrapper, []byte("fixture owner wrapper"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_NODE_PATH", filepath.Join(runtimeRoot, "runtime", "node", "node-test"))
	adapter, err := runtimeAdapterAt(runtimeRoot)
	if err != nil {
		t.Fatal(err)
	}
	adapter.RulesRegistry = rulesSeed
	pipeline := &Pipeline{store: store, rulesRegistry: rulesRegistry, runtime: adapter, active: map[string]struct{}{}}

	stages := []string{}
	pipeline.runner = func(stage string, command []string, values map[string]string, currentRunDir, runtimeRoot string) error {
		stages = append(stages, stage)
		switch stage {
		case "R005":
			writePipelineStructuralInventoryV3(t, store, run, contextValue)
			inventoryPath := filepath.Join(runDir, "r005", "structural-control-inventory.json")
			writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_HIERARCHY_METADATA_MISSING")
			refreshFailSoftInventoryProvenance(t, inventoryPath, filepath.Join(runDir, "r005"))
			if err := validateR005ReportOnlyPackage(filepath.Join(runDir, "r005"), contextValue, true); err != nil {
				t.Fatalf("synthetic safe R005 package rejected: %v", err)
			}
			return errors.New("exit status 1")
		case "RULES":
			contextPath := filepath.Join(runDir, "rules_engine_context.json")
			writeOrchestrationJSON(t, filepath.Join(runDir, "rules", "workflow_decision.json"), map[string]any{
				"schema_version": "opiu-rules-workflow-decision.v1", "run_id": run.ID,
				"phase": "AFTER_R005", "next_action": "WAIT_USER_RULES", "handoff": nil,
			})
			writeNoopRulesEngineArtifacts(t, contextPath, filepath.Join(runDir, "rules"), run.ID)
		case "R001_DIAGNOSTIC":
			if filepath.Base(adapter.R001Script) != "service_r001_owner_wrapper.mjs" || command[1] != adapter.R001DiagnosticScript || filepath.Base(command[1]) != "correction_engine_r001.mjs" {
				t.Fatalf("diagnostic path did not bypass the handoff-only owner wrapper: adapter=%#v command=%#v", adapter, command)
			}
			joined := "\x00" + strings.Join(command, "\x00") + "\x00"
			if strings.Contains(joined, "\x00--handoff\x00") {
				t.Fatal("diagnostic R001 must not fabricate a Rules handoff")
			}
			if !strings.Contains(joined, "\x00--reconciliation\x00") || !strings.Contains(joined, "\x00--codex-input\x00") {
				t.Fatalf("diagnostic R001 did not receive report-only R005 sources: %#v", command)
			}
			writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
		default:
			t.Fatalf("unexpected stage %s", stage)
		}
		return nil
	}

	var status RunStatus
	var terminalStage, message string
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	pipeline.executeRuntime(run, contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", runDir,
		func(gotStatus RunStatus, gotStage, gotMessage string) {
			status, terminalStage, message = gotStatus, gotStage, gotMessage
		})

	if strings.Join(stages, ",") != "R005,RULES,R001_DIAGNOSTIC" {
		t.Fatalf("stages=%v status=%s terminal_stage=%s message=%q; business blocker aborted report generation", stages, status, terminalStage, message)
	}
	if status != RunWaitingUserRules || terminalStage != "RULES_REVIEW" || !strings.Contains(message, "диагностический комплект") {
		t.Fatalf("status=%s stage=%s message=%q", status, terminalStage, message)
	}
	assertNoLoaderWorkbook(t, filepath.Join(runDir, "r001"))
	files, err := collectStageResultFiles(filepath.Join(runDir, "r001"), run.ID, "r001")
	if err != nil {
		t.Fatal(err)
	}
	visibleKinds := map[string]bool{}
	for _, file := range files {
		if file.URL == "" {
			t.Fatalf("visible output lacks direct download URL: %#v", file)
		}
		visibleKinds[file.Kind] = true
	}
	for _, kind := range []string{"registry", "journal", "diagnostics", "manifest"} {
		if !visibleKinds[kind] {
			t.Fatalf("separate visible %s artifact is missing: %#v", kind, files)
		}
	}
	visibleManifestPath := filepath.Join(runDir, "r001", "service-report-package", "technical", "report-package.manifest.json")
	var visibleManifest map[string]any
	if err := readJSONFile(visibleManifestPath, &visibleManifest); err != nil {
		t.Fatal(err)
	}
	if visibleManifest["route_rows"] != float64(0) || visibleManifest["loader_workbook_count"] != float64(0) {
		t.Fatalf("zero-route package declared a loader result: %#v", visibleManifest)
	}
	if len(visibleManifest["correction_registries"].([]any)) == 0 {
		t.Fatalf("visible manifest did not declare the correction registry: %#v", visibleManifest)
	}
	for _, declared := range []string{"diagnostics", "journal", "artifact_registry"} {
		artifact, ok := visibleManifest[declared].(map[string]any)
		if !ok || strings.TrimSpace(artifact["name"].(string)) == "" || !validSHA256(artifact["sha256"].(string)) {
			t.Fatalf("visible manifest did not declare exact %s artifact: %#v", declared, visibleManifest)
		}
	}
	safety := visibleManifest["safety"].(map[string]any)
	if safety["mode"] != "REPORT_ONLY" || safety["posting_rows"] != float64(0) || safety["ready_to_upload"] != false ||
		safety["release_allowed"] != false || safety["live_1c_allowed"] != false {
		t.Fatalf("visible package safety gates opened: %#v", safety)
	}
}

func TestBusinessBlockedR001AcceptsOnlyCompleteReportOnlyPackage(t *testing.T) {
	for _, test := range []struct {
		name          string
		makeUnsafe    bool
		expectVisible bool
		status        RunStatus
		stage         string
	}{
		{name: "unclassified nonzero keeps visible package but fails closed", expectVisible: true, status: RunFailed, stage: "R001"},
		{name: "unsafe package remains failed", makeUnsafe: true, status: RunFailed, stage: "R001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, err := OpenStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			run := Run{ID: "run_r001_fail_soft", ContextID: "ctx_r001_fail_soft", Status: RunRunning, Stage: "R005", StartedAt: time.Now().UTC(), Safety: reportOnlySafety()}
			contextValue := Context{ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
			store.state.Runs[run.ID] = run
			store.state.Contexts[contextValue.ID] = contextValue
			if err := store.saveLocked(); err != nil {
				t.Fatal(err)
			}
			rulesRegistry, rulesSeed := newTestRulesRegistry(t, store)
			runDir := filepath.Join(store.RunsDir(), run.ID)
			if err := os.MkdirAll(runDir, 0o700); err != nil {
				t.Fatal(err)
			}
			pipeline := &Pipeline{store: store, rulesRegistry: rulesRegistry, runtime: &RuntimeAdapter{
				Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs", RulesScript: "cli.mjs",
				R001Script: "correction_engine_r001.mjs", RulesRegistry: rulesSeed,
			}, active: map[string]struct{}{}}

			stages := []string{}
			pipeline.runner = func(stage string, command []string, values map[string]string, currentRunDir, runtimeRoot string) error {
				stages = append(stages, stage)
				switch stage {
				case "R005":
					writePipelineStructuralInventoryV3(t, store, run, contextValue)
					writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_R005_REPASS_REQUIRED")
					refreshFailSoftInventoryProvenance(t, filepath.Join(runDir, "r005", "structural-control-inventory.json"), filepath.Join(runDir, "r005"))
				case "RULES":
					handoffPath := filepath.Join(runDir, "handoff", "r001_handoff.json")
					if err := writeStructuralControlHandoffFixture(handoffPath, run, contextValue,
						filepath.Join(runDir, "r005", "reconciliation.codex-input.json"),
						filepath.Join(runDir, "r005", structuralControlProofFilename)); err != nil {
						t.Fatal(err)
					}
					contextPath := filepath.Join(runDir, "rules_engine_context.json")
					writeOrchestrationJSON(t, filepath.Join(runDir, "rules", "workflow_decision.json"), map[string]any{
						"schema_version": "opiu-rules-workflow-decision.v1", "run_id": run.ID, "phase": "AFTER_R005",
						"next_action": "PASS_TO_R001", "handoff": map[string]any{"target": "R001", "handoff_path": handoffPath},
					})
					writeNoopRulesEngineArtifacts(t, contextPath, filepath.Join(runDir, "rules"), run.ID)
				case "R001":
					joined := "\x00" + strings.Join(command, "\x00") + "\x00"
					if !strings.Contains(joined, "\x00--handoff\x00") {
						t.Fatal("final R001 lost the verified Rules handoff")
					}
					writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
					if test.makeUnsafe {
						manifestPath, err := findR001Manifest(filepath.Join(runDir, "r001"))
						if err != nil {
							t.Fatal(err)
						}
						var manifest map[string]any
						if err := readJSONFile(manifestPath, &manifest); err != nil {
							t.Fatal(err)
						}
						manifest["results"].(map[string]any)["live_1c_allowed"] = true
						writeOrchestrationJSON(t, manifestPath, manifest)
					}
					return errors.New("exit status 1")
				default:
					t.Fatalf("unexpected stage %s", stage)
				}
				return nil
			}

			var status RunStatus
			var terminalStage string
			writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
			pipeline.executeRuntime(run, contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", runDir,
				func(gotStatus RunStatus, gotStage, _ string) { status, terminalStage = gotStatus, gotStage })
			if strings.Join(stages, ",") != "R005,RULES,R001" || status != test.status || terminalStage != test.stage {
				t.Fatalf("stages=%v status=%s stage=%s", stages, status, terminalStage)
			}
			assertNoLoaderWorkbook(t, filepath.Join(runDir, "r001"))
			visibleErr := validateVisibleReportPackage(filepath.Join(runDir, "r001"), run, contextValue)
			if test.expectVisible && visibleErr != nil {
				t.Fatalf("safe diagnostic package was not retained after unclassified nonzero: %v", visibleErr)
			}
			if !test.expectVisible && visibleErr == nil {
				t.Fatal("unsafe R001 package became visible")
			}
		})
	}
}

func TestVisibleReportPackageParentRejectsSymlinkModeBeforeCreation(t *testing.T) {
	if reportPackageParentModeAllowed(os.ModeDir | os.ModeSymlink) {
		t.Fatal("symlink/reparse-like report package parent mode was accepted")
	}
	if !reportPackageParentModeAllowed(os.ModeDir) {
		t.Fatal("regular report package directory mode was rejected")
	}
}

func TestZeroRoutePackageRejectsEmptyLoaderWorkbook(t *testing.T) {
	r001Dir := t.TempDir()
	writeFailSoftR001PackageFixture(t, r001Dir)
	if err := validateR001ReportOnlyPackage(r001Dir); err != nil {
		t.Fatalf("valid zero-route package rejected: %v", err)
	}
	loader := filepath.Join(r001Dir, "OPIU_CORRECTIONS_R001_SYNTHETIC", "КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ СПОРНО", "empty.xlsx")
	if err := os.MkdirAll(filepath.Dir(loader), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(loader, []byte("empty loader must not exist"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateR001ReportOnlyPackage(r001Dir); err == nil || !strings.Contains(err.Error(), "zero-route") {
		t.Fatalf("empty loader workbook accepted: %v", err)
	}
}

func TestVisibleReportPackageIsDeterministicAndImmutable(t *testing.T) {
	for _, test := range []struct {
		name   string
		tamper bool
	}{
		{name: "same run produces identical package"},
		{name: "existing package is not overwritten", tamper: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			runDir := t.TempDir()
			run := Run{ID: "run_deterministic", ContextID: "ctx_deterministic", StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety()}
			contextValue := Context{ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
			writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_HIERARCHY_METADATA_MISSING")
			writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
			if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "RULES", "WAIT_USER_RULES", "Требуется решение пользователя"); err != nil {
				t.Fatal(err)
			}
			manifestPath := filepath.Join(runDir, "r001", "service-report-package", "technical", "report-package.manifest.json")
			before, err := sha256File(manifestPath)
			if err != nil {
				t.Fatal(err)
			}
			if test.tamper {
				diagnosticsPath := filepath.Join(runDir, "r001", "service-report-package", "technical", "diagnostics.json")
				if err := os.WriteFile(diagnosticsPath, []byte("tampered"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "RULES", "WAIT_USER_RULES", "Требуется решение пользователя"); err == nil {
					t.Fatal("materialization overwrote or accepted an existing mutated package")
				}
				return
			}
			if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "RULES", "WAIT_USER_RULES", "Требуется решение пользователя"); err != nil {
				t.Fatal(err)
			}
			after, err := sha256File(manifestPath)
			if err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatalf("same run changed visible package bytes: before=%s after=%s", before, after)
			}
		})
	}
}

func TestR001PackageRejectsReadyWithoutExactPhysicalProof(t *testing.T) {
	r001Dir := t.TempDir()
	run := Run{ID: "run_ready_incomplete"}
	contextValue := Context{Period: "2025-10", OrganizationName: "9 Управляющая компания"}
	writePhysicalRoutingFixture(t, r001Dir, run, contextValue, "READY", false, false, false, false)
	if err := validateR001ReportOnlyPackage(r001Dir); err == nil {
		t.Fatal("READY route with no exact physical source proof passed the service boundary")
	}
}

func TestVisibleReportPackageRejectsEngineManifestMutation(t *testing.T) {
	runDir := t.TempDir()
	run := Run{ID: "run_engine_manifest_mutation", ContextID: "ctx_engine_manifest_mutation", StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety()}
	contextValue := Context{ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_HIERARCHY_METADATA_MISSING")
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "RULES", "WAIT_USER_RULES", "Требуется решение пользователя"); err != nil {
		t.Fatal(err)
	}
	if err := validateVisibleReportPackage(r001Dir, run, contextValue); err != nil {
		t.Fatalf("fresh visible package rejected: %v", err)
	}
	engineManifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(engineManifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["mutation"] = "after-visible-validation"
	writeOrchestrationJSON(t, engineManifestPath, manifest)
	if err := validateVisibleReportPackage(r001Dir, run, contextValue); err == nil {
		t.Fatal("post-validation engine manifest mutation was accepted")
	}
}

func TestR001PhysicalRoutingBoundary(t *testing.T) {
	run := Run{ID: "run_physical_boundary"}
	contextValue := Context{Period: "2025-10", OrganizationName: "9 Управляющая компания"}
	for _, test := range []struct {
		name                   string
		route                  string
		exactPhysical          bool
		spornoAuthority        bool
		sourceRowMismatch      bool
		sourceRowMissingLoader bool
		wantError              bool
	}{
		{name: "READY exact physical source", route: "READY", exactPhysical: true},
		{name: "SPORNO known direction unknown fields blank", route: "SPORNO"},
		{name: "SPORNO cannot claim correction authority", route: "SPORNO", spornoAuthority: true, wantError: true},
		{name: "READY rejects contradictory SourceRowID", route: "READY", exactPhysical: true, sourceRowMismatch: true, wantError: true},
		{name: "SPORNO rejects contradictory known SourceRowID", route: "SPORNO", sourceRowMismatch: true, wantError: true},
		{name: "SPORNO requires known SourceRowID in A:AA", route: "SPORNO", sourceRowMissingLoader: true, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			r001Dir := t.TempDir()
			writePhysicalRoutingFixture(t, r001Dir, run, contextValue, test.route, test.exactPhysical, test.spornoAuthority, test.sourceRowMismatch, test.sourceRowMissingLoader)
			err := validateR001ReportOnlyPackage(r001Dir)
			if (err != nil) != test.wantError {
				t.Fatalf("route=%s exact=%v authority=%v err=%v", test.route, test.exactPhysical, test.spornoAuthority, err)
			}
		})
	}
}

func TestR001PackageRejectsStaleScopeAndLiveDelete(t *testing.T) {
	run := Run{ID: "run_scope_a"}
	contextValue := Context{ID: "ctx_scope_a", OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	contextValue.Organization = contextValue.OrganizationName
	runDir := t.TempDir()
	writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_HIERARCHY_METADATA_MISSING")
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, Run{ID: "run_scope_b"}, contextValue); err == nil {
		t.Fatal("stale cross-run R001 package was accepted")
	}
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, Context{Period: "2025-11"}); err == nil {
		t.Fatal("cross-period R001 package was accepted")
	}
	crossOrganization := contextValue
	crossOrganization.Organization = "1 Хабаровск"
	crossOrganization.OrganizationName = crossOrganization.Organization
	crossOrganization.OrganizationID = "ORG-1"
	crossOrganization.OrganizationPath = "Холдинг / 1 Хабаровск"
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, crossOrganization); err == nil {
		t.Fatal("same-period cross-organization zero-route R001 package was accepted")
	}
	if err := os.WriteFile(filepath.Join(runDir, "r005", "reconciliation.xlsx"), []byte("mutated current R005 source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err == nil {
		t.Fatal("zero-route R001 package survived current R005 source mutation")
	}
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["results"].(map[string]any)["live_delete_allowed"] = true
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackage(r001Dir); err == nil {
		t.Fatal("R001 package with live_delete_allowed=true was accepted")
	}
}

func writeFailSoftR005Fixture(t *testing.T, r005Dir string, contextValue Context, status string) {
	t.Helper()
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	reportPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	if !regularFile(reportPath) {
		if err := os.WriteFile(reportPath, []byte("synthetic report-only reconciliation"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	codex := map[string]any{}
	_ = readJSONFile(codexPath, &codex)
	for key, value := range map[string]any{
		"schema": "opiu-codex-review-input-v1", "organization": contextValue.Organization,
		"period": contextValue.Period, "report_only": true, "posting_rows": 0,
		"executed_posting_rows": 0, "live_posting_rows": 0, "execution_allowed": false,
		"ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false, "live_delete_allowed": false,
		"rows": []any{map[string]any{"code": "R001", "status": status}},
	} {
		codex[key] = value
	}
	writeOrchestrationJSON(t, codexPath, codex)
	reportSHA, err := sha256File(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	manifest := map[string]any{}
	_ = readJSONFile(manifestPath, &manifest)
	for key, value := range map[string]any{
		"schema": "opiu-auto-reconciliation-run-v3", "organization": contextValue.Organization,
		"period": contextValue.Period, "status": status, "report_only": true,
		"posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false, "output_sha256": reportSHA, "codex_input_sha256": codexSHA,
	} {
		manifest[key] = value
	}
	writeOrchestrationJSON(t, manifestPath, manifest)
}

func writeFailSoftR001PackageFixture(t *testing.T, r001Dir string) {
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, Run{}, Context{})
}

func writeFailSoftR001PackageFixtureForRun(t *testing.T, r001Dir string, run Run, contextValue Context) {
	t.Helper()
	packageDir := filepath.Join(r001Dir, "OPIU_CORRECTIONS_R001_SYNTHETIC")
	files := []string{
		"Решения_корректировок_ввод_R001.xlsx",
		filepath.Join("РЕЕСТР", "Реестр_корректировок.xlsx"),
		filepath.Join("РЕЕСТР", "Реестр_проводок_расхождений.xlsx"),
		"reconciliation.xlsx",
	}
	outputs := map[string]any{}
	for _, rel := range files {
		filePath := filepath.Join(packageDir, rel)
		if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
			t.Fatal(err)
		}
		writeSyntheticReportWorkbook(t, filePath, "Sheet1", nil)
		hash, err := sha256File(filePath)
		if err != nil {
			t.Fatal(err)
		}
		outputs[filepath.ToSlash(rel)] = hash
	}
	reconciliationPath := filepath.Join(filepath.Dir(r001Dir), "r005", "reconciliation.xlsx")
	reconciliationSHA := ""
	if regularFile(reconciliationPath) {
		var err error
		reconciliationPath, err = filepath.Abs(reconciliationPath)
		if err != nil {
			t.Fatal(err)
		}
		reconciliationSHA, err = sha256File(reconciliationPath)
		if err != nil {
			t.Fatal(err)
		}
	}
	writeOrchestrationJSON(t, filepath.Join(packageDir, "technical", "manifest.json"), map[string]any{
		"schema_version": "correction-engine-run-1.0.0", "run_id": run.ID,
		"inputs": map[string]any{
			"period": contextValue.Period, "source_run_id": run.ID,
			"reconciliation":  map[string]any{"path": reconciliationPath, "sha256": reconciliationSHA},
			"service_handoff": nil,
		},
		"results": map[string]any{
			"canonical_financial_rows_total": 0, "ready_financial_rows": 0, "sporno_financial_rows": 0,
			"report_only": true, "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
			"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
			"live_1c_allowed": false, "live_delete_allowed": false, "output_file_row_counts": []any{},
			"canonical_output_integrity": map[string]any{
				"result": "PASS", "canonical_financial_rows_total": 0, "workbook_financial_rows": 0, "registry_financial_rows": 0,
				"canonical_row_set_sha256": strings.Repeat("A", 64), "report_only": true,
				"posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
				"execution_allowed": false, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false, "live_delete_allowed": false,
			},
		},
		"outputs": outputs,
	})
}

func writePhysicalRoutingFixture(t *testing.T, r001Dir string, run Run, contextValue Context, route string, exactPhysical, spornoAuthority, sourceRowMismatch, sourceRowMissingLoader bool) {
	t.Helper()
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	packageDir := filepath.Dir(filepath.Dir(manifestPath))
	headers := []any{
		"AuditIdentity", "CaseID", "PairID", "Операция", "Период", "Организация сверки",
		"Организация источника ERP", "SourceRowID", "ERP архив", "SHA256 ERP архива",
		"ERP файл в архиве", "SHA256 ERP файла", "Лист", "ERP строка", "Дата источника",
		"Регистратор/документ", "№ проводки", "Output route", "Статус материализации",
		"Proof status", "Correction allowed", "Correction authority", "Сумма", "Причина",
		"Блокеры", "A:AA JSON", "execution_allowed", "ready_to_upload", "live_1c_allowed",
	}
	loader := make([]any, 27)
	loader[4] = "STORNO"
	loader[9], loader[10] = 100.0, 100.0
	values := make([]any, len(headers))
	for index := range values {
		values[index] = ""
	}
	values[0], values[1], values[2], values[3] = "AUDIT-1", "CASE-1", "PAIR-1", "STORNO"
	values[4], values[5] = contextValue.Period, contextValue.OrganizationName
	values[17], values[18], values[19] = route, "MATERIALIZED_"+route, "UNPROVEN"
	values[20], values[21], values[22] = false, "REVIEW_REQUIRED", 100.0
	values[23], values[24] = "Ручная проверка", "PHYSICAL_SOURCE_INCOMPLETE"
	values[26], values[27], values[28] = false, false, false
	if route == "READY" && exactPhysical {
		values[6], values[7] = "ООО Физический источник", "ERP-ROW-99"
		values[8], values[9] = "archive.zip", strings.Repeat("A", 64)
		values[10], values[11] = "journal.xlsx", strings.Repeat("B", 64)
		values[12], values[13] = "Журнал", "A99:AA99"
		values[14], values[15], values[16] = "2025-10-31", "Документ 99", "99"
		values[19], values[20], values[21] = "PROVEN", true, "EXACT_SOURCE"
		loader[16], loader[17], loader[18] = "26", "70", "ERP-ROW-99"
	}
	if route == "READY" && sourceRowMismatch {
		loader[18] = "ERP-ROW-CONTRADICTS-AUDIT"
	}
	if route == "SPORNO" && sourceRowMismatch {
		values[7] = "ERP-ROW-A"
		loader[18] = "ERP-ROW-B"
	}
	if route == "SPORNO" && sourceRowMissingLoader {
		values[7] = "ERP-ROW-KNOWN"
		loader[18] = nil
	}
	if route == "SPORNO" && spornoAuthority {
		values[20], values[21] = true, "TRUE"
	}
	loaderJSON, err := json.Marshal(loader)
	if err != nil {
		t.Fatal(err)
	}
	values[25] = string(loaderJSON)
	reconciliationPath := filepath.Join(packageDir, "reconciliation.xlsx")
	writeSyntheticReportWorkbook(t, reconciliationPath, materializationSheetName, [][]any{{}, {}, {}, headers, values})
	loaderDirectory := "КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ СПОРНО"
	loaderName := "synthetic_СПОРНО.xlsx"
	if route == "READY" {
		loaderDirectory = "КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ ДЛЯ ЗАГРУЗКИ"
		loaderName = "synthetic_READY.xlsx"
	}
	loaderRelative := filepath.ToSlash(filepath.Join(loaderDirectory, loaderName))
	loaderPath := filepath.Join(packageDir, filepath.FromSlash(loaderRelative))
	writeSyntheticReportWorkbook(t, loaderPath, "Загрузка_A_AA", nil)
	reconciliationSHA, err := sha256File(reconciliationPath)
	if err != nil {
		t.Fatal(err)
	}
	loaderSHA, err := sha256File(loaderPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	results := manifest["results"].(map[string]any)
	results["canonical_financial_rows_total"] = 1
	results["ready_financial_rows"] = 0
	results["sporno_financial_rows"] = 1
	if route == "READY" {
		results["ready_financial_rows"] = 1
		results["sporno_financial_rows"] = 0
	}
	results["output_file_row_counts"] = []any{map[string]any{"financial_rows": 1}}
	results["canonical_output_integrity"] = map[string]any{
		"result": "PASS", "canonical_financial_rows_total": 1, "workbook_financial_rows": 1, "registry_financial_rows": 1,
		"canonical_row_set_sha256": strings.Repeat("C", 64), "report_only": true,
		"posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false, "live_delete_allowed": false,
	}
	outputs := manifest["outputs"].(map[string]any)
	outputs["reconciliation.xlsx"] = reconciliationSHA
	outputs[loaderRelative] = loaderSHA
	writeOrchestrationJSON(t, manifestPath, manifest)
}

func writeSyntheticReportWorkbook(t *testing.T, filePath, sheetName string, rows [][]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	escape := func(value any) string {
		var buffer bytes.Buffer
		if err := xml.EscapeText(&buffer, []byte(fmt.Sprint(value))); err != nil {
			t.Fatal(err)
		}
		return buffer.String()
	}
	columnName := func(index int) string {
		value := ""
		for index++; index > 0; index = (index - 1) / 26 {
			value = string(rune('A'+(index-1)%26)) + value
		}
		return value
	}
	parts := map[string]string{
		"[Content_Types].xml":        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		"_rels/.rels":                `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		"xl/workbook.xml":            `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="` + escape(sheetName) + `" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
	}
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIndex, row := range rows {
		sheet.WriteString(fmt.Sprintf(`<row r="%d">`, rowIndex+1))
		for columnIndex, value := range row {
			reference := columnName(columnIndex) + strconv.Itoa(rowIndex+1)
			sheet.WriteString(`<c r="` + reference + `" t="inlineStr"><is><t>` + escape(value) + `</t></is></c>`)
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	parts["xl/worksheets/sheet1.xml"] = sheet.String()
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"} {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(parts[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func refreshFailSoftInventoryProvenance(t *testing.T, inventoryPath, r005Dir string) {
	t.Helper()
	var inventory map[string]any
	if err := readJSONFile(inventoryPath, &inventory); err != nil {
		t.Fatal(err)
	}
	currentRun := inventory["current_run_provenance"].(map[string]any)
	for key, name := range map[string]string{
		"report": "reconciliation.xlsx", "codex_input": "reconciliation.codex-input.json",
		"manifest": "reconciliation.manifest.json",
	} {
		filePath := filepath.Join(r005Dir, name)
		hash, err := sha256File(filePath)
		if err != nil {
			t.Fatal(err)
		}
		artifact := currentRun[key].(map[string]any)
		artifact["file"] = filePath
		artifact["sha256"] = hash
	}
	if err := atomicWriteJSON(inventoryPath, inventory); err != nil {
		t.Fatal(err)
	}
	inventorySHA, err := sha256File(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	provenanceSHA, err := canonicalJSONSHA256(currentRun)
	if err != nil {
		t.Fatal(err)
	}
	bindingPath := filepath.Join(r005Dir, "structural-control-inventory.binding.json")
	var binding map[string]any
	if err := readJSONFile(bindingPath, &binding); err != nil {
		t.Fatal(err)
	}
	binding["sha256"] = inventorySHA
	binding["report"] = currentRun["report"]
	binding["codex_input"] = currentRun["codex_input"]
	binding["manifest"] = currentRun["manifest"]
	binding["current_run_provenance_sha256"] = provenanceSHA
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
}

func assertNoLoaderWorkbook(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() {
			return err
		}
		lower := strings.ToLower(filepath.ToSlash(path))
		if strings.HasSuffix(lower, ".xlsx") && (strings.Contains(lower, "для загрузки") || strings.Contains(lower, "файлы спорно")) {
			t.Fatalf("zero-route package contains loader workbook: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
