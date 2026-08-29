package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestR005R001HandoffKeepsJournalAfterTemporaryWorkDirRemoval(t *testing.T) {
	store, contextValue, run, runDir := newPipelineStructuralContext(t)
	r005Dir := filepath.Join(runDir, "r005")
	temporaryWorkDir := filepath.Join(t.TempDir(), "reconciliation-work")
	temporaryJournalPath := filepath.Join(temporaryWorkDir, "erp_archives", "journal.xlsx")
	writeSyntheticReportWorkbook(t, temporaryJournalPath, "Лист_1", nil)
	temporaryJournalSHA, err := sha256File(temporaryJournalPath)
	if err != nil {
		t.Fatal(err)
	}

	writePipelineStructuralInventoryV3(t, store, run, contextValue)
	writeFailSoftR005Fixture(t, r005Dir, contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	if err := os.RemoveAll(filepath.Join(r005Dir, "physical-evidence")); err != nil {
		t.Fatal(err)
	}
	setR005LifecycleJournal(t, r005Dir, temporaryJournalPath, temporaryJournalSHA)

	persistentJournalPath := filepath.Join(r005Dir, "physical-evidence", "erp-journal.xlsx")
	gotPersistentPath := runNodeJournalPersistence(t, temporaryWorkDir, filepath.Join(r005Dir, "reconciliation.xlsx"), temporaryJournalPath, temporaryJournalSHA)
	if !sameFilesystemPath(gotPersistentPath, persistentJournalPath) {
		t.Fatalf("persistent journal path=%q want=%q", gotPersistentPath, persistentJournalPath)
	}
	if err := os.RemoveAll(temporaryWorkDir); err != nil {
		t.Fatal(err)
	}
	if regularFile(temporaryJournalPath) {
		t.Fatal("temporary ERP journal survived workDir cleanup")
	}
	if !regularFile(persistentJournalPath) {
		t.Fatal("persistent ERP journal copy was not materialized")
	}
	setR005LifecycleJournal(t, r005Dir, persistentJournalPath, temporaryJournalSHA)

	pipeline := &Pipeline{store: store}
	_, audit, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
		t.Fatal(err)
	}
	if _, _, err := materializeStructuralControlProof(run, contextValue, runDir, filepath.Join(r005Dir, "reconciliation.codex-input.json")); err != nil {
		t.Fatal(err)
	}

	erpPath, intalevPath := testServiceSourcePaths(runDir)
	handoff, err := materializeServiceR001Handoff(run, contextValue, runDir, erpPath, intalevPath)
	if err != nil {
		t.Fatalf("R005→R001 handoff was not materialized after workDir cleanup: %v", err)
	}
	document, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir)
	if err != nil {
		t.Fatalf("persistent R005→R001 handoff did not revalidate: %v", err)
	}
	if !sameFilesystemPath(document.PhysicalEvidence.ERPJournal.Path, persistentJournalPath) ||
		document.PhysicalEvidence.ERPJournal.SHA256 != strings.ToUpper(temporaryJournalSHA) ||
		document.PhysicalEvidence.ERPJournal.Sheet != "Лист_1" {
		t.Fatalf("handoff lost persistent journal binding: %#v", document.PhysicalEvidence.ERPJournal)
	}

	r001Dir := filepath.Join(runDir, "r001")
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		t.Fatalf("R001 could not consume the verified handoff: %v", err)
	}
}

func setR005LifecycleJournal(t *testing.T, r005Dir, journalPath, journalSHA string) {
	t.Helper()
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	var codex map[string]any
	if err := readJSONFile(codexPath, &codex); err != nil {
		t.Fatal(err)
	}
	codex["cross_journal_discrepancy_evidence"] = map[string]any{
		"applicable":   true,
		"organization": "9 Управляющая компания",
		"period":       "2025-10",
		"sources": map[string]any{
			"erp": map[string]any{"path": journalPath, "sha256": strings.ToUpper(journalSHA), "sheet": "Лист_1"},
		},
		"rows":   []any{},
		"counts": map[string]any{"reused_intalev_rows": 0, "reused_erp_rows": 0},
	}
	writeOrchestrationJSON(t, codexPath, codex)
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["codex_input_path"] = codexPath
	manifest["codex_input_sha256"] = strings.ToUpper(codexSHA)
	writeOrchestrationJSON(t, manifestPath, manifest)
	refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)
}

func runNodeJournalPersistence(t *testing.T, workDir, outputPath, journalPath, journalSHA string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("required Node runtime is unavailable: %v", err)
	}
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	modulePath, err := filepath.Abs(filepath.Join(workingDirectory, "..", "..", "modules", "reconciliation", "source", "run_workdir.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	script := `import { pathToFileURL } from "node:url";
const { persistImmutableErpJournalEvidence } = await import(pathToFileURL(process.env.OPIU_R005_TEST_MODULE).href);
const result = await persistImmutableErpJournalEvidence({
  workDir: process.env.OPIU_R005_TEST_WORK_DIR,
  outputPath: process.env.OPIU_R005_TEST_OUTPUT,
  crossJournalEvidence: {
    applicable: true,
    sources: { erp: { path: process.env.OPIU_R005_TEST_JOURNAL, sha256: process.env.OPIU_R005_TEST_SHA, sheet: "Лист_1" } },
  },
});
process.stdout.write(result.path);`
	command := exec.Command(node, "--input-type=module", "-e", script)
	command.Env = append(os.Environ(),
		"OPIU_R005_TEST_MODULE="+modulePath,
		"OPIU_R005_TEST_WORK_DIR="+workDir,
		"OPIU_R005_TEST_OUTPUT="+outputPath,
		"OPIU_R005_TEST_JOURNAL="+journalPath,
		"OPIU_R005_TEST_SHA="+strings.ToUpper(journalSHA),
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Node journal persistence failed: %v: %s", err, output)
	}
	if strings.TrimSpace(string(output)) == "" {
		t.Fatal("Node journal persistence returned an empty path")
	}
	return strings.TrimSpace(string(output))
}
