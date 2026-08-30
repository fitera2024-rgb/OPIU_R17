package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestBusinessBlockedR005ProceedsThroughDirectServiceHandoff(t *testing.T) {
	// The canonical direct-path integration test owns this legacy scenario now.
	TestRuntimePipelineIsDirectR005ServiceHandoffR001(t)
}

func TestBusinessBlockedR001AcceptsOnlyCompleteReportOnlyPackage(t *testing.T) {
	_, run, contextValue, runDir, _ := buildVerifiedServiceHandoffFixture(t)
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		t.Fatalf("complete direct-path package was rejected: %v", err)
	}
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["results"].(map[string]any)["live_1c_allowed"] = true
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err == nil {
		t.Fatal("unsafe direct-path package was accepted")
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
	_, run, contextValue, runDir, _ := buildVerifiedServiceHandoffFixture(t)
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", "PASS_R001", "Direct handoff complete"); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r001Dir, "service-report-package", "technical", "report-package.manifest.json")
	before, err := sha256File(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", "PASS_R001", "Direct handoff complete"); err != nil {
		t.Fatal(err)
	}
	after, err := sha256File(manifestPath)
	if err != nil || before != after {
		t.Fatalf("direct visible package is not deterministic: before=%s after=%s err=%v", before, after, err)
	}
}

func TestNonFinancialReviewIsVisibleAndImmutable(t *testing.T) {
	_, run, contextValue, runDir, _ := buildVerifiedServiceHandoffFixture(t)
	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	reportOnly, correctionAllowed, zero := true, false, 0
	reviews := []r001NonFinancialReview{{
		SchemaVersion: "opiu-r001-non-financial-review.v1", PairID: "PAIR-UNBALANCED", SourceRowID: "ROW-12",
		Operations: []string{"STORNO", "REPOST"}, Amounts: []float64{100, 80},
		BlockerCodes: []string{"SERVICE_HANDOFF_PAIR_UNBALANCED_NON_FINANCIAL"}, Reason: "Суммы STORNO и REPOST не равны",
		ReportOnly: &reportOnly, CorrectionAllowed: &correctionAllowed, CanonicalFinancialRows: &zero,
	}}
	reviewSHA256, err := nonFinancialReviewSetSHA256(reviews)
	if err != nil {
		t.Fatal(err)
	}
	if reviewSHA256 != "6C6BFD0FC2A7A27DA041C85CA2790ED41D812BC145A8C70E4EE7460609DF1661" {
		t.Fatalf("cross-runtime non-financial review digest drifted: %s", reviewSHA256)
	}
	results := manifest["results"].(map[string]any)
	results["non_financial_review_count"] = 1
	results["non_financial_review_row_count"] = 1
	results["non_financial_review_set_sha256"] = reviewSHA256
	results["non_financial_reviews"] = reviews
	integrity := results["canonical_output_integrity"].(map[string]any)
	integrity["non_financial_review_rows"] = 1
	integrity["non_financial_review_set_sha256"] = reviewSHA256
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		t.Fatalf("non-financial review package rejected: %v", err)
	}
	for _, field := range []string{"non_financial_review_count", "non_financial_review_row_count", "non_financial_review_set_sha256", "non_financial_reviews"} {
		original := results[field]
		delete(results, field)
		writeOrchestrationJSON(t, manifestPath, manifest)
		if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err == nil {
			t.Fatalf("R001 manifest without mandatory %s was accepted", field)
		}
		results[field] = original
	}
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", "PASS_R001", "Direct handoff complete"); err != nil {
		t.Fatal(err)
	}
	technicalDir := filepath.Join(r001Dir, "service-report-package", "technical")
	for _, name := range []string{"diagnostics.json", "action-journal.json", "artifact-registry.json", "report-package.manifest.json"} {
		var document map[string]any
		if err := readJSONFile(filepath.Join(technicalDir, name), &document); err != nil {
			t.Fatal(err)
		}
		if document["non_financial_review_count"] != float64(1) || document["non_financial_review_row_count"] != float64(1) ||
			document["non_financial_review_set_sha256"] != reviewSHA256 {
			t.Fatalf("%s lost non-financial review summary: %#v", name, document)
		}
		visibleReviews, ok := document["non_financial_reviews"].([]any)
		if !ok || len(visibleReviews) != 1 {
			t.Fatalf("%s lost the exact non-financial review: %#v", name, document)
		}
		visible := visibleReviews[0].(map[string]any)
		if visible["pair_id"] != "PAIR-UNBALANCED" || visible["source_row_id"] != "ROW-12" ||
			visible["reason"] != "Суммы STORNO и REPOST не равны" || visible["canonical_financial_rows"] != float64(0) ||
			visible["report_only"] != true || visible["correction_allowed"] != false || document["route_rows"] != float64(0) {
			t.Fatalf("%s changed the visible non-financial review: %#v", name, visible)
		}
		if !reflect.DeepEqual(visible["operations"], []any{"STORNO", "REPOST"}) ||
			!reflect.DeepEqual(visible["amounts"], []any{float64(100), float64(80)}) ||
			!reflect.DeepEqual(visible["blocker_codes"], []any{"SERVICE_HANDOFF_PAIR_UNBALANCED_NON_FINANCIAL"}) {
			t.Fatalf("%s lost non-financial review operations, amounts or blockers: %#v", name, visible)
		}
	}
	if err := validateVisibleReportPackage(r001Dir, run, contextValue); err != nil {
		t.Fatalf("visible non-financial review package rejected: %v", err)
	}
	diagnosticsPath := filepath.Join(technicalDir, "diagnostics.json")
	var diagnostics map[string]any
	if err := readJSONFile(diagnosticsPath, &diagnostics); err != nil {
		t.Fatal(err)
	}
	diagnostics["non_financial_reviews"].([]any)[0].(map[string]any)["amounts"] = []any{100.0, 100.0}
	writeOrchestrationJSON(t, diagnosticsPath, diagnostics)
	if err := validateVisibleReportPackage(r001Dir, run, contextValue); err == nil {
		t.Fatal("tampered visible non-financial review was accepted")
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
	{
		_, run, contextValue, runDir, _ := buildVerifiedServiceHandoffFixture(t)
		r001Dir := filepath.Join(runDir, "r001")
		writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
		if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", "PASS_R001", "Direct handoff complete"); err != nil {
			t.Fatal(err)
		}
		engineManifestPath, err := findR001Manifest(r001Dir)
		if err != nil {
			t.Fatal(err)
		}
		var engineManifest map[string]any
		if err := readJSONFile(engineManifestPath, &engineManifest); err != nil {
			t.Fatal(err)
		}
		engineManifest["mutation"] = "after-visible-validation"
		writeOrchestrationJSON(t, engineManifestPath, engineManifest)
		if err := validateVisibleReportPackage(r001Dir, run, contextValue); err == nil {
			t.Fatal("post-validation engine manifest mutation was accepted")
		}
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
	journalPath := filepath.Join(r005Dir, "physical-evidence", "erp-journal.xlsx")
	if !regularFile(reportPath) {
		if err := os.WriteFile(reportPath, []byte("synthetic report-only reconciliation"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeSyntheticReportWorkbook(t, journalPath, "Лист_1", nil)
	journalSHA, err := sha256File(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	reportSHA, err := sha256File(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	codex := map[string]any{}
	_ = readJSONFile(codexPath, &codex)
	for key, value := range map[string]any{
		"schema": "opiu-codex-review-input-v1", "organization": contextValue.Organization,
		"organization_code": contextValue.OrganizationID,
		"period":            contextValue.Period, "report_only": true, "posting_rows": 0,
		"executed_posting_rows": 0, "live_posting_rows": 0, "execution_allowed": false,
		"ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false, "live_delete_allowed": false,
		"report_path": reportPath, "report_sha256": strings.ToUpper(reportSHA),
		"output_path": reportPath, "output_sha256": strings.ToUpper(reportSHA),
		"operation_evidence": map[string]any{
			"journal_sha256": strings.ToUpper(journalSHA), "journal_sheet": "Лист_1",
			"input": map[string]any{"journal_source": journalPath}, "rows": []any{},
		},
		"structural_control_settings_selection": map[string]any{
			"authority": structuralControlAuthorityServiceNone, "status": "SERVICE_NO_SETTINGS", "path": "",
		},
		"structural_control_settings_binding": map[string]any{
			"schema": structuralControlSettingsSchema, "status": "MISSING_DEFAULT_ALL_GROUPS", "set_count": 0,
			"sets": []any{}, "correction_authority": false, "financial_rows": 0, "posting_rows": 0,
			"execution_allowed": false,
		},
		"structural_group_control_results": []any{},
		"rows":                             []any{map[string]any{"code": "R001", "status": status}},
	} {
		codex[key] = value
	}
	writeOrchestrationJSON(t, codexPath, codex)
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	manifest := map[string]any{}
	_ = readJSONFile(manifestPath, &manifest)
	for key, value := range map[string]any{
		"schema": "opiu-auto-reconciliation-run-v3", "organization": contextValue.Organization,
		"organization_code": contextValue.OrganizationID,
		"period":            contextValue.Period, "status": status, "report_only": true,
		"posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false,
		"output_path": reportPath, "output_sha256": strings.ToUpper(reportSHA),
		"codex_input_path": codexPath, "codex_input_sha256": strings.ToUpper(codexSHA),
	} {
		manifest[key] = value
	}
	writeOrchestrationJSON(t, manifestPath, manifest)
}

func writeFailSoftR001PackageFixture(t *testing.T, r001Dir string) {
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, Run{}, Context{})
}

func TestValidateR001ReportOnlyPackageAcceptsCanonicalDecisionWorkbookName(t *testing.T) {
	r001Dir := t.TempDir()
	writeFailSoftR001PackageFixture(t, r001Dir)
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	packageDir := filepath.Dir(filepath.Dir(manifestPath))
	oldRelative := "Решения_корректировок_ввод_R001.xlsx"
	newRelative := "Решения.xlsx"
	oldPath := filepath.Join(packageDir, oldRelative)
	newPath := filepath.Join(packageDir, newRelative)
	if err := os.Rename(oldPath, newPath); err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	outputs, ok := manifest["outputs"].(map[string]any)
	if !ok {
		t.Fatal("R001 fixture outputs are missing")
	}
	hash, ok := outputs[oldRelative].(string)
	if !ok {
		t.Fatal("R001 fixture decision workbook hash is missing")
	}
	delete(outputs, oldRelative)
	outputs[newRelative] = hash
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackage(r001Dir); err != nil {
		t.Fatalf("canonical Рeшения.xlsx workbook was rejected: %v", err)
	}
}

func TestValidateR001ReportOnlyPackageRejectsCanonicalDecisionWorkbookInSubdirectory(t *testing.T) {
	r001Dir := t.TempDir()
	writeFailSoftR001PackageFixture(t, r001Dir)
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	packageDir := filepath.Dir(filepath.Dir(manifestPath))
	oldRelative := "Решения_корректировок_ввод_R001.xlsx"
	canonicalRelative := filepath.Join("foreign", "Решения.xlsx")
	oldPath := filepath.Join(packageDir, oldRelative)
	canonicalPath := filepath.Join(packageDir, canonicalRelative)
	if err := os.MkdirAll(filepath.Dir(canonicalPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(oldPath, canonicalPath); err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	outputs, ok := manifest["outputs"].(map[string]any)
	if !ok {
		t.Fatal("R001 fixture outputs are missing")
	}
	hash, ok := outputs[oldRelative].(string)
	if !ok {
		t.Fatal("R001 fixture decision workbook hash is missing")
	}
	delete(outputs, oldRelative)
	outputs[filepath.ToSlash(canonicalRelative)] = hash
	writeOrchestrationJSON(t, manifestPath, manifest)
	if err := validateR001ReportOnlyPackage(r001Dir); err == nil {
		t.Fatal("canonical Рeшения.xlsx workbook in a subdirectory was accepted")
	}
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
	var serviceHandoff any
	handoffPath := filepath.Join(filepath.Dir(r001Dir), "handoff", serviceR001HandoffFilename)
	if regularFile(handoffPath) {
		handoffSHA, err := sha256File(handoffPath)
		if err != nil {
			t.Fatal(err)
		}
		serviceHandoff = map[string]any{"path": handoffPath, "sha256": strings.ToUpper(handoffSHA)}
	}
	emptyNonFinancialReviews := []r001NonFinancialReview{}
	emptyNonFinancialReviewSHA256, err := nonFinancialReviewSetSHA256(emptyNonFinancialReviews)
	if err != nil {
		t.Fatal(err)
	}
	writeOrchestrationJSON(t, filepath.Join(packageDir, "technical", "manifest.json"), map[string]any{
		"schema_version": "correction-engine-run-1.0.0", "run_id": run.ID,
		"inputs": map[string]any{
			"period": contextValue.Period, "source_run_id": run.ID,
			"reconciliation":  map[string]any{"path": reconciliationPath, "sha256": reconciliationSHA},
			"service_handoff": serviceHandoff,
		},
		"results": map[string]any{
			"canonical_financial_rows_total": 0, "ready_financial_rows": 0, "sporno_financial_rows": 0,
			"non_financial_review_count": 0, "non_financial_review_row_count": 0,
			"non_financial_review_set_sha256": emptyNonFinancialReviewSHA256, "non_financial_reviews": emptyNonFinancialReviews,
			"report_only": true, "posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
			"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
			"live_1c_allowed": false, "live_delete_allowed": false, "output_file_row_counts": []any{},
			"canonical_output_integrity": map[string]any{
				"result": "PASS", "canonical_financial_rows_total": 0, "workbook_financial_rows": 0, "registry_financial_rows": 0,
				"canonical_row_set_sha256": strings.Repeat("A", 64), "report_only": true,
				"non_financial_review_rows": 0, "non_financial_review_set_sha256": emptyNonFinancialReviewSHA256,
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
		"non_financial_review_rows": 0, "non_financial_review_set_sha256": results["non_financial_review_set_sha256"],
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
