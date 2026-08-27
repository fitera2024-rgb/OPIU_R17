package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type emptyBindingPipelineContext struct {
	store        *Store
	run          Run
	contextValue Context
	runDir       string
}

func newEmptyBindingPipelineContext(t *testing.T, period, suffix string) emptyBindingPipelineContext {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	configureTestOrganizationCatalog(t, store)
	contextValue := Context{
		ID: "ctx_empty_binding_" + suffix, Organization: emptyBindingOrganizationName,
		OrganizationID: emptyBindingOrganizationID, OrganizationName: emptyBindingOrganizationName,
		OrganizationPath: emptyBindingOrganizationPath, Period: period,
	}
	run := Run{
		ID: "run_empty_binding_" + suffix, ContextID: contextValue.ID,
		Status: RunRunning, Stage: "R005", StartedAt: time.Now().UTC(), Safety: reportOnlySafety(),
	}
	store.state.Contexts[contextValue.ID] = contextValue
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	return emptyBindingPipelineContext{store: store, run: run, contextValue: contextValue, runDir: runDir}
}

func fixEmptyBindingForPipeline(t *testing.T, store *Store) string {
	t.Helper()
	installEmptyBindingVerifiedCatalog(t, store, "org9", emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	server := &Server{store: store}
	request := emptyBindingRequest(0)
	request.SourceParent.HierarchyPath = "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 1_Административные расходы / ФЗП и компенсационные выплаты / <пустое значение>"
	request.ERPTarget.HierarchyPath = "Административные расходы / ФЗП и компенсационные выплаты / ФЗП"
	status, draftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, "POST", "/draft", request)
	if status != 201 {
		t.Fatalf("pipeline setting draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	status, fixedPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, "POST", "/fix", emptyBindingFixRequest(draftID, 1))
	if status != 201 {
		t.Fatalf("pipeline setting fix = %d %s", status, raw)
	}
	return publicString(t, publicObject(t, fixedPayload, "fixed_version"), "binding_id")
}

func commandArgument(command []string, flag string) (string, bool) {
	for index := 0; index < len(command); index++ {
		if command[index] == flag && index+1 < len(command) {
			return command[index+1], true
		}
	}
	return "", false
}

func readEmptyBindingSnapshot(t *testing.T, path string) emptyArticleBindingSettingsSnapshot {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot emptyArticleBindingSettingsSnapshot
	if err := decodeExactJSON(data, &snapshot); err != nil {
		t.Fatalf("invalid run-bound settings snapshot: %v\n%s", err, data)
	}
	return snapshot
}

func TestRuntimeR005ReceivesRunBoundFixedEmptyArticleBindingSnapshot(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "runtime_active")
	bindingID := fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{
		store: testContext.store,
		runtime: &RuntimeAdapter{
			Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs",
			R001Script: "correction_engine_r001.mjs",
		},
		active: map[string]struct{}{},
	}
	var captured []string
	pipeline.runner = func(stage string, command []string, _ map[string]string, _, _ string) error {
		if stage != "R005" {
			t.Fatalf("unexpected stage after R005 stop: %s", stage)
		}
		captured = append([]string(nil), command...)
		return errors.New("intentional stop after argv capture")
	}
	pipeline.executeRuntime(testContext.run, testContext.contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", testContext.runDir,
		func(RunStatus, string, string) {})

	snapshotPath, ok := commandArgument(captured, "--empty-article-binding-settings")
	if !ok {
		t.Fatalf("R005 did not receive run-bound settings: %#v", captured)
	}
	expectedPath := filepath.Join(testContext.runDir, "r005-input", emptyArticleBindingSnapshotFile)
	if !sameCleanPath(snapshotPath, expectedPath) {
		t.Fatalf("settings path = %q, expected %q", snapshotPath, expectedPath)
	}
	for flag, expected := range map[string]string{
		"--organization-id":   testContext.contextValue.OrganizationID,
		"--organization-name": testContext.contextValue.OrganizationName,
		"--organization-path": testContext.contextValue.OrganizationPath,
	} {
		if actual, found := commandArgument(captured, flag); !found || actual != expected {
			t.Fatalf("%s = %q found=%v, command=%#v", flag, actual, found, captured)
		}
	}
	snapshot := readEmptyBindingSnapshot(t, snapshotPath)
	if snapshot.Schema != emptyArticleBindingSettingsSchema || snapshot.OrganizationScope.OrganizationID != testContext.contextValue.OrganizationID ||
		strings.Join(snapshot.OrganizationScope.OrganizationHierarchyPath, " / ") != testContext.contextValue.OrganizationPath ||
		len(snapshot.Bindings) != 1 || snapshot.Bindings[0].BindingID != bindingID {
		t.Fatalf("snapshot scope/bindings = %#v", snapshot)
	}
	binding := snapshot.Bindings[0]
	if binding.Target.TargetCode != "R036" || binding.Target.TargetNodeIdentity != "ERP-R036" ||
		binding.Target.DisplayArticle != "ФЗП" || binding.Mode != "CLASSIFICATION_ONLY" || binding.DecisionType != "NO_POSTING" ||
		!binding.Source.BlankAncestorRequired || len(binding.Source.LeafLabels) != 4 {
		t.Fatalf("snapshot binding = %#v", binding)
	}
	if snapshot.Safety != emptyArticleBindingSettingsNoPostingSafety() || snapshot.Safety.PostingRows != 0 || snapshot.Safety.ExecutionAllowed {
		t.Fatalf("snapshot safety = %#v", snapshot.Safety)
	}
	secondPath, err := pipeline.materializeActiveEmptyArticleBindingSettings(testContext.run, testContext.contextValue, testContext.runDir)
	if err != nil || !sameCleanPath(secondPath, snapshotPath) {
		t.Fatalf("immutable repeat snapshot = %q err=%v", secondPath, err)
	}
}

func TestRuntimeR005WithoutActiveFixedSettingPreservesOldArgv(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "runtime_missing")
	installEmptyBindingVerifiedCatalog(t, testContext.store, "org9", emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	server := &Server{store: testContext.store}
	draftRequest := emptyBindingRequest(0)
	status, _, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, "POST", "/draft", draftRequest)
	if status != 201 {
		t.Fatalf("draft-only setting = %d %s", status, raw)
	}
	pipeline := &Pipeline{
		store: testContext.store,
		runtime: &RuntimeAdapter{
			Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs",
			R001Script: "correction_engine_r001.mjs",
		},
		active: map[string]struct{}{},
	}
	var captured []string
	pipeline.runner = func(stage string, command []string, _ map[string]string, _, _ string) error {
		captured = append([]string(nil), command...)
		return errors.New("intentional stop after argv capture")
	}
	pipeline.executeRuntime(testContext.run, testContext.contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", testContext.runDir,
		func(RunStatus, string, string) {})
	if _, found := commandArgument(captured, "--empty-article-binding-settings"); found {
		t.Fatalf("missing setting changed legacy R005 argv: %#v", captured)
	}
	if _, err := os.Stat(filepath.Join(testContext.runDir, "r005-input")); !os.IsNotExist(err) {
		t.Fatalf("missing setting materialized an input directory: %v", err)
	}
}

func TestExternalR005ReceivesSnapshotAndExactOrganizationValues(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "external_active")
	fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{
		store: testContext.store,
		commands: map[string][]string{
			"R005":  {"node", "r005.mjs", "--organization-id", "{organization_id}", "--organization-name", "{organization_name}", "--organization-path", "{organization_path}"},
			"RULES": {"node", "rules.mjs"}, "R001": {"node", "r001.mjs"},
		},
		active: map[string]struct{}{},
	}
	var captured []string
	var values map[string]string
	pipeline.runner = func(stage string, command []string, replacements map[string]string, _, _ string) error {
		captured = append([]string(nil), command...)
		values = replacements
		return errors.New("intentional stop after argv capture")
	}
	pipeline.executeExternal(testContext.run, testContext.contextValue, "erp.xlsx", "intalev.xlsx", testContext.runDir,
		func(RunStatus, string, string) {})
	snapshotPath, found := commandArgument(captured, "--empty-article-binding-settings")
	if !found || !sameCleanPath(snapshotPath, filepath.Join(testContext.runDir, "r005-input", emptyArticleBindingSnapshotFile)) {
		t.Fatalf("external R005 settings argv = %#v", captured)
	}
	for placeholder, expected := range map[string]string{
		"{organization_id}": testContext.contextValue.OrganizationID, "{organization_name}": testContext.contextValue.OrganizationName,
		"{organization_path}": testContext.contextValue.OrganizationPath,
	} {
		if values[placeholder] != expected {
			t.Fatalf("external exact scope %s = %q, expected %q", placeholder, values[placeholder], expected)
		}
	}
}

func TestFullYearScopeSelects2025BindingAndLeaves2026Unchanged(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025", "full_year_2025")
	fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{store: testContext.store}
	path, err := pipeline.materializeActiveEmptyArticleBindingSettings(testContext.run, testContext.contextValue, testContext.runDir)
	if err != nil || path == "" {
		t.Fatalf("2025 full-year binding path = %q err=%v", path, err)
	}
	snapshot := readEmptyBindingSnapshot(t, path)
	if len(snapshot.Bindings) != 1 || snapshot.Bindings[0].Validity.From != "2025-01" || snapshot.Bindings[0].Validity.To != "2025-12" {
		t.Fatalf("2025 full-year snapshot = %#v", snapshot)
	}

	outside := testContext.contextValue
	outside.ID = "ctx_empty_binding_full_year_2026"
	outside.Period = "2026"
	outsideRun := testContext.run
	outsideRun.ID = "run_empty_binding_full_year_2026"
	outsideRun.ContextID = outside.ID
	outsideDir := filepath.Join(testContext.store.RunsDir(), outsideRun.ID)
	if err := os.MkdirAll(outsideDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path, err = pipeline.materializeActiveEmptyArticleBindingSettings(outsideRun, outside, outsideDir)
	if err != nil || path != "" {
		t.Fatalf("2026 must retain no-active behavior: path=%q err=%v", path, err)
	}
}

func TestRunBoundSettingsSnapshotHasExactEngineJSONKeys(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "json_keys")
	fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{store: testContext.store}
	path, err := pipeline.materializeActiveEmptyArticleBindingSettings(testContext.run, testContext.contextValue, testContext.runDir)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schema", "settings_id", "organization_scope", "authority", "safety", "bindings"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("snapshot lacks engine key %q: %s", key, data)
		}
	}
	if len(raw) != 6 {
		t.Fatalf("snapshot has unexpected engine keys: %s", data)
	}
	safety, ok := raw["safety"].(map[string]any)
	if !ok {
		t.Fatalf("snapshot safety is not an object: %s", data)
	}
	expectedSafety := map[string]any{
		"mode": "REPORT_ONLY", "report_only": true, "classification_only": true, "decision_type": "NO_POSTING",
		"correction_authority": false, "physical_posting_authority": false,
		"financial_rows": float64(0), "posting_rows": float64(0),
		"executed_posting_rows": float64(0), "live_posting_rows": float64(0),
		"ready_to_upload": false, "release_allowed": false, "execution_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false,
	}
	if len(safety) != len(expectedSafety) {
		t.Fatalf("snapshot safety has unexpected exact keys: %#v", safety)
	}
	for key, expected := range expectedSafety {
		if safety[key] != expected {
			t.Fatalf("snapshot safety %s=%#v expected=%#v: %#v", key, safety[key], expected, safety)
		}
	}
}

func TestServiceMaterializedSnapshotLoadsInStrictNodeEngine(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is unavailable for strict cross-runtime snapshot verification")
	}
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "strict_node_loader")
	fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{store: testContext.store}
	snapshotPath, err := pipeline.materializeActiveEmptyArticleBindingSettings(testContext.run, testContext.contextValue, testContext.runDir)
	if err != nil {
		t.Fatal(err)
	}
	loaderPath, err := filepath.Abs(filepath.Join("..", "..", "modules", "reconciliation", "source", "empty_article_binding_settings.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	hierarchy, err := emptyArticleBindingHierarchySegments(testContext.contextValue.OrganizationPath)
	if err != nil {
		t.Fatal(err)
	}
	hierarchyJSON, err := json.Marshal(hierarchy)
	if err != nil {
		t.Fatal(err)
	}
	script := `
import { pathToFileURL } from "node:url";
const [loaderPath, snapshotPath, organizationId, organizationName, hierarchyJSON, period] = process.argv.slice(1);
const { loadEmptyArticleBindingSettingsDocument } = await import(pathToFileURL(loaderPath).href);
const result = await loadEmptyArticleBindingSettingsDocument(snapshotPath, {
  organizationId,
  organizationName,
  organizationHierarchyPath: JSON.parse(hierarchyJSON),
  period,
});
process.stdout.write(JSON.stringify({ audit: result.audit, safety: result.document.safety }));
`
	command := exec.Command(node, "--input-type=module", "--eval", script,
		loaderPath, snapshotPath, testContext.contextValue.OrganizationID, testContext.contextValue.OrganizationName,
		string(hierarchyJSON), testContext.contextValue.Period)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("strict Node loader rejected service snapshot: %v\n%s\nsnapshot=%s", err, output, snapshotPath)
	}
	var result struct {
		Audit  map[string]any `json:"audit"`
		Safety map[string]any `json:"safety"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("strict Node loader returned invalid evidence: %v\n%s", err, output)
	}
	if result.Audit["status"] != "ACTIVE_EXACT_ORGANIZATION_PERIOD" || result.Audit["report_only"] != true ||
		result.Audit["posting_rows"] != float64(0) || result.Audit["executed_posting_rows"] != float64(0) ||
		result.Audit["live_posting_rows"] != float64(0) || result.Audit["live_delete_allowed"] != false {
		t.Fatalf("strict Node audit is unsafe: %#v", result.Audit)
	}
	for key, expected := range map[string]any{
		"report_only": true, "executed_posting_rows": float64(0),
		"live_posting_rows": float64(0), "live_delete_allowed": false,
	} {
		if result.Safety[key] != expected {
			t.Fatalf("strict Node safety %s=%#v expected=%#v: %#v", key, result.Safety[key], expected, result.Safety)
		}
	}
}

func TestEmptyArticleBindingSettingsSnapshotRejectsEveryPostingSafetyDrift(t *testing.T) {
	testContext := newEmptyBindingPipelineContext(t, "2025-10", "safety_drift")
	fixEmptyBindingForPipeline(t, testContext.store)
	pipeline := &Pipeline{store: testContext.store}
	snapshotPath, err := pipeline.materializeActiveEmptyArticleBindingSettings(testContext.run, testContext.contextValue, testContext.runDir)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := readEmptyBindingSnapshot(t, snapshotPath)
	if snapshot.Safety != emptyArticleBindingSettingsNoPostingSafety() {
		t.Fatalf("baseline snapshot is unsafe: %#v", snapshot.Safety)
	}
	tests := []struct {
		name   string
		mutate func(*emptyArticleBindingSettingsSnapshot)
	}{
		{"report only false", func(value *emptyArticleBindingSettingsSnapshot) { value.Safety.ReportOnly = false }},
		{"executed posting rows", func(value *emptyArticleBindingSettingsSnapshot) { value.Safety.ExecutedPostingRows = 1 }},
		{"live posting rows", func(value *emptyArticleBindingSettingsSnapshot) { value.Safety.LivePostingRows = 1 }},
		{"live delete allowed", func(value *emptyArticleBindingSettingsSnapshot) { value.Safety.LiveDeleteAllowed = true }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := snapshot
			test.mutate(&candidate)
			if err := validateEmptyArticleBindingSettingsSnapshot(candidate, testContext.run, testContext.contextValue); err == nil {
				t.Fatalf("unsafe snapshot accepted: %#v", candidate.Safety)
			}
		})
	}
}
