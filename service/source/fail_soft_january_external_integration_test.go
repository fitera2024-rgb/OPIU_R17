package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	externalJanuaryRunID                = "r13-empty-article-fzp-full-year-20260825-05-2025-01"
	externalJanuaryContextID            = "ctx-r13-january-fail-soft-external-copy-20260825-01"
	externalJanuaryPeriod               = "2025-01"
	externalJanuaryOrganizationID       = "ERP-000000224"
	externalJanuaryOrganizationName     = "9 Управляющая компания"
	externalJanuaryOrganizationPath     = "9 Управляющая компания"
	externalJanuaryAcceptanceName       = "r13-empty-article-fzp-full-year-20260825-05.acceptance.json"
	externalJanuaryAcceptanceSHA256     = "7E756EFDA99CFDCD8793EBD83707E0CB7E3CDAE9819180FCFCE25E07A44F885D"
	externalJanuaryR005WorkbookSHA256   = "F9655B197457E47DE75102179FE7B5EEC154CEC2C06CFECBFFCCA097FFB67D20"
	externalJanuaryR005CodexSHA256      = "F137C9B9A4488A20DB61E6AD0FD4EE28369800E8E6A3573F6560154E1638907F"
	externalJanuaryR005ManifestSHA256   = "ED4CCB07C922EF76CC931BE1DB726A2AE4B6755D3C51EEB4AD1BD710D798C620"
	externalJanuaryRulesWorkflowSHA256  = "1357C404E6A861D81FBAA760535711C674FCBAE70269B18D679308E688449AC5"
	externalJanuaryR001CoreSHA256       = "2DAFD0FA95B6473459B66C25B0F799B2E4923EBF792836A6A9A27B8B974DD4AC"
	externalJanuaryNodeSHA256           = "3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237"
	externalJanuaryStartedAt            = "2026-08-25T10:11:38.682Z"
	externalJanuaryAcceptanceSessionDir = "r13-empty-article-fzp-full-year-20260825-05"
)

type externalJanuaryFileProof struct {
	Size   int64
	SHA256 string
}

// TestJanuaryWaitUserRulesFailSoftExternalCopy is an opt-in acceptance test.
// It is intentionally skipped in ordinary CI because it consumes an external,
// owner-pinned January catalog and leaves a reviewable result below a new,
// caller-selected release-build directory.
func TestJanuaryWaitUserRulesFailSoftExternalCopy(t *testing.T) {
	acceptanceRoot := strings.TrimSpace(os.Getenv("OPIU_FAIL_SOFT_SOURCE_ACCEPTANCE_ROOT"))
	outputRoot := strings.TrimSpace(os.Getenv("OPIU_FAIL_SOFT_OUTPUT_ROOT"))
	nodePath := strings.TrimSpace(os.Getenv("OPIU_NODE_PATH"))
	if acceptanceRoot == "" || outputRoot == "" || nodePath == "" {
		t.Skip("external January fail-soft acceptance requires OPIU_FAIL_SOFT_SOURCE_ACCEPTANCE_ROOT, OPIU_FAIL_SOFT_OUTPUT_ROOT and OPIU_NODE_PATH")
	}

	acceptanceRoot = externalJanuaryAbsolutePath(t, acceptanceRoot)
	outputRoot = externalJanuaryAbsolutePath(t, outputRoot)
	nodePath = externalJanuaryAbsolutePath(t, nodePath)
	if !strings.EqualFold(filepath.Clean(filepath.Dir(acceptanceRoot)), filepath.Clean(filepath.Dir(outputRoot))) {
		t.Fatal("output root must be a new sibling of the pinned acceptance catalog below the same release-builds directory")
	}
	if externalJanuaryPathWithin(acceptanceRoot, outputRoot) || externalJanuaryPathWithin(outputRoot, acceptanceRoot) {
		t.Fatal("source acceptance and output roots must not contain one another")
	}
	if _, err := os.Lstat(outputRoot); err == nil {
		t.Fatalf("fail-if-exists output root already exists: %s", outputRoot)
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}

	acceptancePath := filepath.Join(acceptanceRoot, externalJanuaryAcceptanceName)
	r005Source := filepath.Join(acceptanceRoot, "months", externalJanuaryPeriod, "r005")
	sessionSource := filepath.Join(acceptanceRoot, "sessions", externalJanuaryAcceptanceSessionDir, externalJanuaryPeriod)
	rulesSource := filepath.Join(sessionSource, "rules")
	rulesContextSource := filepath.Join(sessionSource, "rules_engine_context.json")
	externalJanuaryRequirePinnedHash(t, acceptancePath, externalJanuaryAcceptanceSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Source, "reconciliation.xlsx"), externalJanuaryR005WorkbookSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Source, "reconciliation.codex-input.json"), externalJanuaryR005CodexSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Source, "reconciliation.manifest.json"), externalJanuaryR005ManifestSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(rulesSource, "workflow_decision.json"), externalJanuaryRulesWorkflowSHA256)

	sourceBefore, err := externalJanuarySourceSnapshot(acceptancePath, r005Source, rulesSource, rulesContextSource)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		sourceAfter, snapshotErr := externalJanuarySourceSnapshot(acceptancePath, r005Source, rulesSource, rulesContextSource)
		if snapshotErr != nil {
			t.Errorf("re-read pinned January sources: %v", snapshotErr)
			return
		}
		if !reflect.DeepEqual(sourceBefore, sourceAfter) {
			t.Error("pinned January acceptance source bytes changed during fail-soft demonstration")
		}
	}()

	externalJanuaryAssertWorkflow(t, filepath.Join(rulesSource, "workflow_decision.json"))
	externalJanuaryAssertRulesContext(t, rulesContextSource)
	externalJanuaryRequirePinnedHash(t, nodePath, externalJanuaryNodeSHA256)

	runtimeRoot := externalJanuaryAbsolutePath(t, filepath.Join("..", ".."))
	r001Core := filepath.Join(runtimeRoot, "modules", "corrections", "source", "correction_engine_r001.mjs")
	r001Wrapper := filepath.Join(runtimeRoot, "modules", "corrections", "source", "service_r001_owner_wrapper.mjs")
	externalJanuaryRequirePinnedHash(t, r001Core, externalJanuaryR001CoreSHA256)
	if !regularFile(r001Wrapper) {
		t.Fatalf("verified final R001 wrapper is missing: %s", r001Wrapper)
	}

	store, err := OpenStore(filepath.Join(outputRoot, "store"))
	if err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), externalJanuaryRunID)
	r005Copy := filepath.Join(runDir, "r005")
	rulesCopy := filepath.Join(runDir, "rules")
	rulesContextCopy := filepath.Join(runDir, "rules_engine_context.json")
	if err := externalJanuaryCopyTree(r005Source, r005Copy); err != nil {
		t.Fatal(err)
	}
	if err := externalJanuaryCopyTree(rulesSource, rulesCopy); err != nil {
		t.Fatal(err)
	}
	if err := externalJanuaryCopyFile(rulesContextSource, rulesContextCopy); err != nil {
		t.Fatal(err)
	}
	externalJanuaryAssertCopiedTree(t, r005Source, r005Copy)
	externalJanuaryAssertCopiedTree(t, rulesSource, rulesCopy)
	externalJanuaryRequirePinnedHash(t, rulesContextCopy, mustExternalJanuarySHA256(t, rulesContextSource))
	externalJanuaryAssertWorkflow(t, filepath.Join(rulesCopy, "workflow_decision.json"))
	externalJanuaryAssertRulesContext(t, rulesContextCopy)
	rulesCopyBefore, err := externalJanuaryTreeSnapshot(rulesCopy)
	if err != nil {
		t.Fatal(err)
	}

	startedAt, err := time.Parse(time.RFC3339Nano, externalJanuaryStartedAt)
	if err != nil {
		t.Fatal(err)
	}
	run := Run{
		ID: externalJanuaryRunID, ContextID: externalJanuaryContextID,
		Status: RunWaitingUserRules, Stage: "RULES_REVIEW",
		Message:   "Найдены предложения правил; требуется решение пользователя",
		StartedAt: startedAt, Safety: reportOnlySafety(),
	}
	contextValue := Context{
		ID: externalJanuaryContextID, Organization: externalJanuaryOrganizationName,
		OrganizationID: externalJanuaryOrganizationID, OrganizationName: externalJanuaryOrganizationName,
		OrganizationPath: externalJanuaryOrganizationPath, Period: externalJanuaryPeriod,
		CreatedAt: startedAt, UpdatedAt: startedAt,
	}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}

	adapter := &RuntimeAdapter{
		Root: runtimeRoot, Node: nodePath,
		R001Script: r001Wrapper, R001DiagnosticScript: r001Core,
	}
	pipeline := &Pipeline{store: store, runtime: adapter, active: map[string]struct{}{}}
	stageCalls := 0
	pipeline.runner = func(stage string, command []string, values map[string]string, currentRunDir, currentRuntimeRoot string) error {
		stageCalls++
		if stage != "R001_DIAGNOSTIC" || values != nil || !sameFilesystemPath(currentRunDir, runDir) || !sameFilesystemPath(currentRuntimeRoot, runtimeRoot) {
			return fmt.Errorf("unexpected external diagnostic invocation: stage=%s run_dir=%s runtime_root=%s", stage, currentRunDir, currentRuntimeRoot)
		}
		if len(command) < 2 || !sameFilesystemPath(command[0], nodePath) || !sameFilesystemPath(command[1], adapter.R001DiagnosticScript) {
			return fmt.Errorf("diagnostic command did not use the exact node/core pair: %#v", command)
		}
		if sameFilesystemPath(command[1], adapter.R001Script) || filepath.Base(command[1]) == filepath.Base(adapter.R001Script) {
			return errors.New("diagnostic command invoked the handoff-only R001 wrapper")
		}
		for _, forbidden := range []string{"--handoff", "--decisions"} {
			if externalJanuaryHasArgument(command, forbidden) {
				return fmt.Errorf("diagnostic command invented forbidden authority: %s", forbidden)
			}
		}
		expectedArguments := map[string]string{
			"--reconciliation":  filepath.Join(r005Copy, "reconciliation.xlsx"),
			"--codex-input":     filepath.Join(r005Copy, "reconciliation.codex-input.json"),
			"--output":          filepath.Join(runDir, "r001"),
			"--period":          externalJanuaryPeriod,
			"--organization":    externalJanuaryOrganizationName,
			"--run-id":          externalJanuaryRunID,
			"--organization-id": externalJanuaryOrganizationID,
		}
		for flag, expected := range expectedArguments {
			actual, ok := externalJanuaryArgumentValue(command, flag)
			if !ok || (strings.HasPrefix(flag, "--reconciliation") || flag == "--codex-input" || flag == "--output") && !sameFilesystemPath(actual, expected) ||
				!(strings.HasPrefix(flag, "--reconciliation") || flag == "--codex-input" || flag == "--output") && actual != expected {
				return fmt.Errorf("diagnostic argument %s=%q, expected %q", flag, actual, expected)
			}
		}
		return runStage(stage, command, values, currentRunDir, currentRuntimeRoot)
	}

	r001Dir := filepath.Join(runDir, "r001")
	if err := pipeline.runDiagnosticR001Package(
		adapter, run, contextValue, runDir,
		filepath.Join(r005Copy, "reconciliation.xlsx"),
		filepath.Join(r005Copy, "reconciliation.codex-input.json"),
		r001Dir, "RULES", "WAIT_USER_RULES",
		"Нужно решение пользователя по недоказанному кандидату; правило и проводка не создаются",
	); err != nil {
		t.Fatal(err)
	}
	if stageCalls != 1 {
		t.Fatalf("diagnostic stage calls=%d, expected 1", stageCalls)
	}
	if directoryExists(filepath.Join(runDir, "handoff")) {
		t.Fatal("fail-soft diagnostic invented a handoff directory")
	}

	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Copy, "reconciliation.xlsx"), externalJanuaryR005WorkbookSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Copy, "reconciliation.codex-input.json"), externalJanuaryR005CodexSHA256)
	externalJanuaryRequirePinnedHash(t, filepath.Join(r005Copy, "reconciliation.manifest.json"), externalJanuaryR005ManifestSHA256)
	externalJanuaryAssertWorkflow(t, filepath.Join(rulesCopy, "workflow_decision.json"))
	rulesCopyAfter, err := externalJanuaryTreeSnapshot(rulesCopy)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rulesCopyBefore, rulesCopyAfter) {
		t.Fatal("copied Rules evidence changed during diagnostic R001 materialization")
	}

	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		t.Fatalf("real January R001 diagnostic package is invalid: %v", err)
	}
	if err := validateVisibleReportPackage(r001Dir, run, contextValue); err != nil {
		t.Fatalf("real January visible report package is invalid: %v", err)
	}
	externalJanuaryAssertZeroRouteEngineManifest(t, r001Dir, run, contextValue)
	externalJanuaryAssertVisiblePackage(t, runDir, r001Dir, run, contextValue)
	externalJanuaryAssertNoLoaders(t, r001Dir, run.ID)
}

func externalJanuaryAbsolutePath(t *testing.T, path string) string {
	t.Helper()
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func externalJanuaryPathWithin(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator)))
}

func externalJanuaryRequirePinnedHash(t *testing.T, path, expected string) {
	t.Helper()
	actual, err := sha256File(path)
	if err != nil {
		t.Fatalf("hash %s: %v", path, err)
	}
	if !strings.EqualFold(actual, expected) {
		t.Fatalf("pinned SHA-256 mismatch for %s: got %s, expected %s", path, actual, expected)
	}
}

func mustExternalJanuarySHA256(t *testing.T, path string) string {
	t.Helper()
	hash, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func externalJanuaryTreeSnapshot(root string) (map[string]externalJanuaryFileProof, error) {
	result := map[string]externalJanuaryFileProof{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("pinned source tree contains a symlink: %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("pinned source tree contains a non-regular file: %s", path)
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		hash, err := sha256File(path)
		if err != nil {
			return err
		}
		result[filepath.ToSlash(relative)] = externalJanuaryFileProof{Size: info.Size(), SHA256: hash}
		return nil
	})
	return result, err
}

func externalJanuarySourceSnapshot(acceptancePath, r005Dir, rulesDir, rulesContextPath string) (map[string]externalJanuaryFileProof, error) {
	result := map[string]externalJanuaryFileProof{}
	for prefix, root := range map[string]string{"r005": r005Dir, "rules": rulesDir} {
		tree, err := externalJanuaryTreeSnapshot(root)
		if err != nil {
			return nil, err
		}
		for name, proof := range tree {
			result[prefix+"/"+name] = proof
		}
	}
	for name, path := range map[string]string{"acceptance": acceptancePath, "rules_context": rulesContextPath} {
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("required source file is unavailable: %s", path)
		}
		hash, err := sha256File(path)
		if err != nil {
			return nil, err
		}
		result[name] = externalJanuaryFileProof{Size: info.Size(), SHA256: hash}
	}
	return result, nil
}

func externalJanuaryCopyTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refuse to copy symlink from pinned source: %s", path)
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("refuse to copy non-regular source: %s", path)
		}
		return externalJanuaryCopyFile(path, target)
	})
}

func externalJanuaryCopyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func externalJanuaryAssertCopiedTree(t *testing.T, source, destination string) {
	t.Helper()
	sourceSnapshot, err := externalJanuaryTreeSnapshot(source)
	if err != nil {
		t.Fatal(err)
	}
	destinationSnapshot, err := externalJanuaryTreeSnapshot(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sourceSnapshot, destinationSnapshot) {
		t.Fatalf("copied source tree differs from pinned bytes: source=%s destination=%s", source, destination)
	}
}

func externalJanuaryAssertWorkflow(t *testing.T, path string) {
	t.Helper()
	var workflow struct {
		SchemaVersion string          `json:"schema_version"`
		RunID         string          `json:"run_id"`
		Phase         string          `json:"phase"`
		NextAction    string          `json:"next_action"`
		Handoff       json.RawMessage `json:"handoff"`
	}
	if err := readJSONFile(path, &workflow); err != nil {
		t.Fatal(err)
	}
	if workflow.SchemaVersion != "opiu-rules-workflow-decision.v1" || workflow.RunID != externalJanuaryRunID ||
		workflow.Phase != "AFTER_R005" || workflow.NextAction != "WAIT_USER_RULES" ||
		!bytes.Equal(bytes.TrimSpace(workflow.Handoff), []byte("null")) {
		t.Fatalf("January Rules state drifted from WAIT_USER_RULES/handoff=null: %#v handoff=%s", workflow, workflow.Handoff)
	}
}

func externalJanuaryAssertRulesContext(t *testing.T, path string) {
	t.Helper()
	var context rulesEngineContext
	if err := readJSONFile(path, &context); err != nil {
		t.Fatal(err)
	}
	if context.SchemaVersion != "opiu-rules-engine-context.v1" || context.RunID != externalJanuaryRunID || context.Phase != "AFTER_R005" ||
		context.Period != externalJanuaryPeriod || context.Organization.ID != externalJanuaryOrganizationID ||
		context.Organization.Name != externalJanuaryOrganizationName || context.Organization.Path != externalJanuaryOrganizationPath ||
		!strings.EqualFold(context.SourceHashes["r005_report"], externalJanuaryR005WorkbookSHA256) ||
		!strings.EqualFold(context.SourceHashes["r005_codex_input"], externalJanuaryR005CodexSHA256) {
		t.Fatalf("January Rules context escaped pinned run/organization/period/source scope: %#v", context)
	}
}

func externalJanuaryHasArgument(command []string, argument string) bool {
	for _, value := range command {
		if value == argument {
			return true
		}
	}
	return false
}

func externalJanuaryArgumentValue(command []string, argument string) (string, bool) {
	for index, value := range command {
		if value == argument && index+1 < len(command) {
			return command[index+1], true
		}
	}
	return "", false
}

func externalJanuaryAssertZeroRouteEngineManifest(t *testing.T, r001Dir string, run Run, contextValue Context) {
	t.Helper()
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	var manifest r001ReportOnlyManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.RunID != run.ID || manifest.Inputs.SourceRunID != run.ID || manifest.Inputs.Period != contextValue.Period {
		t.Fatalf("R001 manifest escaped exact run/period: %#v", manifest.Inputs)
	}
	if manifest.Results.CanonicalRows == nil || *manifest.Results.CanonicalRows != 0 ||
		manifest.Results.ReadyRows == nil || *manifest.Results.ReadyRows != 0 ||
		manifest.Results.SpornoRows == nil || *manifest.Results.SpornoRows != 0 || len(manifest.Results.OutputRowCounts) != 0 {
		t.Fatalf("January fail-soft diagnostic created financial routes: canonical=%v ready=%v sporno=%v output_counts=%#v",
			manifest.Results.CanonicalRows, manifest.Results.ReadyRows, manifest.Results.SpornoRows, manifest.Results.OutputRowCounts)
	}
	if err := validateReportOnlySafety(manifest.Results.reportOnlyArtifactSafety); err != nil {
		t.Fatalf("R001 result safety is open: %v", err)
	}
	integrity := manifest.Results.CanonicalOutputIntegrity
	if integrity.Result != "PASS" || integrity.CanonicalRows == nil || *integrity.CanonicalRows != 0 ||
		integrity.WorkbookRows == nil || *integrity.WorkbookRows != 0 || integrity.RegistryRows == nil || *integrity.RegistryRows != 0 {
		t.Fatalf("zero-route canonical integrity is incomplete: %#v", integrity)
	}
	if err := validateReportOnlySafety(integrity.reportOnlyArtifactSafety); err != nil {
		t.Fatalf("canonical output safety is open: %v", err)
	}
}

func externalJanuaryAssertVisiblePackage(t *testing.T, runDir, r001Dir string, run Run, contextValue Context) {
	t.Helper()
	technicalDir := filepath.Join(r001Dir, "service-report-package", "technical")
	files := map[string]string{
		"diagnostics.json":             "opiu-report-only-diagnostics.v1",
		"action-journal.json":          "opiu-report-only-action-journal.v1",
		"artifact-registry.json":       "opiu-report-only-artifact-registry.v1",
		"report-package.manifest.json": "opiu-report-only-visible-package.v1",
	}
	for name, schema := range files {
		path := filepath.Join(technicalDir, name)
		var document map[string]any
		if err := readJSONFile(path, &document); err != nil {
			t.Fatalf("read visible %s: %v", name, err)
		}
		if err := validateVisibleDocumentScope(document, schema, run, contextValue); err != nil {
			t.Fatalf("visible %s escaped exact scope/safety: %v", name, err)
		}
		if name != "artifact-registry.json" && document["route_rows"] != float64(0) {
			t.Fatalf("visible %s route_rows=%v, expected 0", name, document["route_rows"])
		}
		if name == "diagnostics.json" {
			blocker, _ := document["blocker"].(map[string]any)
			if blocker["stage"] != "RULES" || blocker["status"] != "WAIT_USER_RULES" {
				t.Fatalf("visible diagnostics lost January blocker: %#v", blocker)
			}
		}
		if name == "report-package.manifest.json" {
			if document["blocker_status"] != "WAIT_USER_RULES" || document["loader_workbook_count"] != float64(0) {
				t.Fatalf("visible package opened a loader or lost blocker: %#v", document)
			}
			registries, _ := document["correction_registries"].([]any)
			if len(registries) == 0 {
				t.Fatal("visible package omitted the zero-route correction registry")
			}
		}
	}
	filesForAPI, err := collectStageResultFiles(r001Dir, run.ID, "r001")
	if err != nil {
		t.Fatal(err)
	}
	visibleKinds := map[string]bool{}
	for _, file := range filesForAPI {
		if file.URL == "" {
			t.Fatalf("visible artifact has no exact download URL: %#v", file)
		}
		visibleKinds[file.Kind] = true
	}
	for _, kind := range []string{"diagnostics", "journal", "registry", "manifest"} {
		if !visibleKinds[kind] {
			t.Fatalf("result API projection omitted visible %s artifact", kind)
		}
	}
	_ = runDir
}

func externalJanuaryAssertNoLoaders(t *testing.T, r001Dir, runID string) {
	t.Helper()
	if err := filepath.WalkDir(r001Dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry == nil || entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".xlsx") {
			return nil
		}
		relative, err := filepath.Rel(r001Dir, path)
		if err != nil {
			return err
		}
		lower := strings.ToLower(filepath.ToSlash(relative))
		if strings.Contains(lower, strings.ToLower("КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ ДЛЯ ЗАГРУЗКИ")) ||
			strings.Contains(lower, strings.ToLower("КОРРЕКТИРОВОЧНЫЕ ФАЙЛЫ СПОРНО")) ||
			resultKind("r001", filepath.ToSlash(relative)) == "upload" || resultKind("r001", filepath.ToSlash(relative)) == "disputed" {
			return fmt.Errorf("zero-route January package contains a loader workbook: %s", relative)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	files, err := collectStageResultFiles(r001Dir, runID, "r001")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Kind == "upload" || file.Kind == "disputed" {
			t.Fatalf("zero-route January package exposes a loader artifact: %#v", file)
		}
	}
}
