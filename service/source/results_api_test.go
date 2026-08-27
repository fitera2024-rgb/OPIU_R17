package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestR001ResultRequiresCompletedRunAndCoreArtifacts(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name        string
		status      RunStatus
		stage       string
		files       []string
		wantReady   bool
		wantArchive bool
	}{
		{
			name:   "running complete-looking directory",
			status: RunRunning,
			stage:  "R001",
			files: []string{
				"manifest.json",
				"Решения_корректировок_ввод_R001.xlsx",
				filepath.Join("РЕЕСТР", "Реестр_корректировок_ОПИУ_2025-11_R001.xlsx"),
			},
		},
		{
			name:   "completed partial directory",
			status: RunCompletedReportOnly,
			stage:  "DONE",
			files: []string{
				"manifest.json",
				"Решения_корректировок_ввод_R001.xlsx",
				filepath.Join("РЕЕСТР", "Реестр_корректировок_ОПИУ_2025-11_R001.xlsx.inspect.ndjson"),
			},
		},
		{
			name:   "completed same-named text files are not a verified package",
			status: RunCompletedReportOnly,
			stage:  "DONE",
			files: []string{
				"manifest.json",
				"Решения_корректировок_ввод_R001.xlsx",
				filepath.Join("РЕЕСТР", "Реестр_корректировок_ОПИУ_2025-11_R001.xlsx"),
			},
		},
	}

	for index, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			run := Run{ID: "run_result_" + string(rune('a'+index)), Status: tt.status, Stage: tt.stage, Safety: reportOnlySafety()}
			store.state.Runs[run.ID] = run
			if err := store.saveLocked(); err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(store.RunsDir(), run.ID, "r001", "OPIU_CORRECTIONS_R001_TEST")
			for _, relative := range tt.files {
				path := filepath.Join(root, relative)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("report-only fixture"), 0o600); err != nil {
					t.Fatal(err)
				}
			}

			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil)
			server.Handler().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			var result runStageResult
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Ready != tt.wantReady {
				t.Fatalf("ready=%v files=%+v", result.Ready, result.Files)
			}
			if (result.ArchiveURL != "") != tt.wantArchive {
				t.Fatalf("archive_url=%q", result.ArchiveURL)
			}
		})
	}
}

func TestR001ResultCollectionRejectsSymlinkedArtifact(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "technical", "diagnostics.json")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if _, err := collectStageResultFiles(root, "run_symlink", "r001"); err == nil {
		t.Fatal("results API collection accepted a symlinked artifact")
	}
}

func TestReportArtifactModeRejectsSymlinkWithoutPlatformPrivileges(t *testing.T) {
	if isReportArtifactModeAllowed(os.ModeSymlink) {
		t.Fatal("report result boundary accepted an os.ModeSymlink artifact")
	}
	if !isReportArtifactModeAllowed(0) {
		t.Fatal("report result boundary rejected a regular file mode")
	}
}

func TestR001ArchiveRejectsPartialResult(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	run := Run{ID: "run_partial_archive", Status: RunCompletedReportOnly, Stage: "DONE", Safety: reportOnlySafety()}
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(store.RunsDir(), run.ID, "r001", "OPIU_CORRECTIONS_R001_TEST")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001?archive=1", nil)
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("partial archive status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestR001OwnerArchiveUsesActualOwnerFilesThroughDownloadRoute(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{ID: "ctx_owner_archive", Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	run := Run{ID: "run_owner_archive", ContextID: contextValue.ID, Status: RunCompletedReportOnly, Stage: "DONE", StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety()}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}

	runDir := filepath.Join(store.RunsDir(), run.ID)
	writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "R001", "R001_COMPLETED_WITH_BLOCKERS", "Безопасный отчётный пакет"); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	resultRequest := httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil)
	resultRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(resultRecorder, resultRequest)
	if resultRecorder.Code != http.StatusOK {
		t.Fatalf("result status=%d body=%s", resultRecorder.Code, resultRecorder.Body.String())
	}
	var result runStageResult
	if err := json.Unmarshal(resultRecorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Ready || !result.VerifiedPackageAvailable || result.ArchiveURL == "" {
		t.Fatalf("R001 download route not ready: %+v", result)
	}
	journalURL := "/api/runs/" + run.ID + "/result/r001/file?path=service-report-package/technical/action-journal.json"
	journalRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(journalRecorder, httptest.NewRequest(http.MethodGet, journalURL, nil))
	if journalRecorder.Code != http.StatusOK || !strings.Contains(journalRecorder.Body.String(), "opiu-report-only-action-journal.v1") {
		t.Fatalf("verified direct journal download status=%d body=%s", journalRecorder.Code, journalRecorder.Body.String())
	}
	unlistedPath := filepath.Join(runDir, "r001", "unlisted-private.txt")
	if err := os.WriteFile(unlistedPath, []byte("must not be downloadable"), 0o600); err != nil {
		t.Fatal(err)
	}
	unlistedRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(unlistedRecorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001/file?path=unlisted-private.txt", nil))
	if unlistedRecorder.Code != http.StatusNotFound {
		t.Fatalf("unlisted direct result status=%d body=%s", unlistedRecorder.Code, unlistedRecorder.Body.String())
	}

	archiveRecorder := httptest.NewRecorder()
	archiveRequest := httptest.NewRequest(http.MethodGet, result.ArchiveURL, nil)
	server.Handler().ServeHTTP(archiveRecorder, archiveRequest)
	if archiveRecorder.Code != http.StatusOK {
		t.Fatalf("archive status=%d body=%s", archiveRecorder.Code, archiveRecorder.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(archiveRecorder.Body.Bytes()), int64(archiveRecorder.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}

	legacy := map[string]bool{
		"01_manifest.json": true, "02_disputed.xlsx": true, "03_disputed.ndjson": true,
		"04_registry.xlsx": true, "05_registry.ndjson": true, "06_registry.xlsx": true,
		"07_registry.ndjson": true, "08_decisions.xlsx": true, "09_r001.ndjson": true,
		"10_delete.xlsx": true, "11_delete.ndjson": true,
	}
	want := map[string]bool{
		"РЕЕСТР/Реестр_корректировок.xlsx":        true,
		"РЕЕСТР/Реестр_проводок_расхождений.xlsx": true,
		"technical/manifest.json":                                       true,
		"service-report-package/technical/action-journal.json":          true,
		"service-report-package/technical/diagnostics.json":             true,
		"service-report-package/technical/artifact-registry.json":       true,
		"service-report-package/technical/report-package.manifest.json": true,
	}
	entries := make([]string, 0, len(archive.File))
	legacyCount := 0
	ndjsonNextToOwnerCount := 0
	provenUploadCount := 0
	for _, entry := range archive.File {
		name := filepath.ToSlash(entry.Name)
		entries = append(entries, name)
		if legacy[filepath.Base(entry.Name)] {
			legacyCount++
		}
		if filepath.Ext(entry.Name) == ".ndjson" && !strings.Contains(name, "/technical/") {
			ndjsonNextToOwnerCount++
		}
		if strings.HasSuffix(entry.Name, "_ОПИУ_ГОТОВО.xlsx") {
			provenUploadCount++
		}
	}
	sort.Strings(entries)
	for required := range want {
		found := false
		for _, entry := range entries {
			if strings.HasSuffix(entry, required) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("required owner workbook missing: %s; listing=%v", required, entries)
		}
	}
	if legacyCount != 0 {
		t.Fatalf("legacy root filename count=%d; listing=%v", legacyCount, entries)
	}
	if ndjsonNextToOwnerCount != 0 {
		t.Fatalf("ndjson next to owner XLSX count=%d; listing=%v", ndjsonNextToOwnerCount, entries)
	}
	if provenUploadCount != 0 {
		t.Fatalf("UNPROVEN *_ОПИУ_ГОТОВО.xlsx count=%d; listing=%v", provenUploadCount, entries)
	}
	unlistedJSONPath := filepath.Join(runDir, "r001", "unlisted-private.json")
	if err := os.WriteFile(unlistedJSONPath, []byte(`{"private":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	unlistedListRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(unlistedListRecorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil))
	var unlistedList runStageResult
	if err := json.Unmarshal(unlistedListRecorder.Body.Bytes(), &unlistedList); err != nil {
		t.Fatal(err)
	}
	if !unlistedList.Ready {
		t.Fatalf("unlisted JSON invalidated otherwise verified R001 result: %+v", unlistedList)
	}
	for _, file := range unlistedList.Files {
		if file.Name == "unlisted-private.json" {
			t.Fatalf("unlisted JSON leaked into R001 result listing: %+v", unlistedList)
		}
	}
	if len(unlistedList.Files) == 0 {
		t.Fatalf("unlisted JSON leaked into R001 result listing: %+v", unlistedList)
	}
	unlistedArchiveRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(unlistedArchiveRecorder, httptest.NewRequest(http.MethodGet, result.ArchiveURL, nil))
	if unlistedArchiveRecorder.Code != http.StatusOK {
		t.Fatalf("unlisted JSON blocked verified R001 archive status=%d", unlistedArchiveRecorder.Code)
	}
	unlistedArchive, err := zip.NewReader(bytes.NewReader(unlistedArchiveRecorder.Body.Bytes()), int64(unlistedArchiveRecorder.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range unlistedArchive.File {
		if filepath.Base(entry.Name) == "unlisted-private.json" {
			t.Fatal("unlisted JSON entered verified R001 archive")
		}
	}
	if err := os.Remove(unlistedJSONPath); err != nil {
		t.Fatal(err)
	}
	diagnosticsPath := filepath.Join(runDir, "r001", "service-report-package", "technical", "diagnostics.json")
	if err := os.WriteFile(diagnosticsPath, []byte(`{"tampered":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mutatedRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(mutatedRecorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil))
	var mutated runStageResult
	if err := json.Unmarshal(mutatedRecorder.Body.Bytes(), &mutated); err != nil {
		t.Fatal(err)
	}
	if mutated.Ready || len(mutated.Files) != 0 {
		t.Fatalf("post-validation mutation remained visible: %+v", mutated)
	}
	mutatedArchive := httptest.NewRecorder()
	server.Handler().ServeHTTP(mutatedArchive, httptest.NewRequest(http.MethodGet, result.ArchiveURL, nil))
	if mutatedArchive.Code != http.StatusNotFound {
		t.Fatalf("post-validation mutation archive status=%d", mutatedArchive.Code)
	}
	mutatedDownload := httptest.NewRecorder()
	server.Handler().ServeHTTP(mutatedDownload, httptest.NewRequest(http.MethodGet, journalURL, nil))
	if mutatedDownload.Code != http.StatusNotFound {
		t.Fatalf("post-validation mutation direct download status=%d", mutatedDownload.Code)
	}
	t.Logf("extracted R001 listing=%v", entries)
	t.Logf("legacy root filenames=%d; ndjson next to owner XLSX=%d; UNPROVEN *_ОПИУ_ГОТОВО.xlsx=%d", legacyCount, ndjsonNextToOwnerCount, provenUploadCount)
}

func TestR001VerifiedDiagnosticPackageRemainsAvailableBeforeFinalReady(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{ID: "ctx_diagnostic_available", Organization: "9 Управляющая компания", OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	run := Run{ID: "run_diagnostic_available", ContextID: contextValue.ID, Status: RunFailed, Stage: "R001", StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety()}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "R001", "R001_COMPLETED_WITH_BLOCKERS", "Безопасный диагностический пакет"); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("diagnostic result status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var result runStageResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Ready || !result.VerifiedPackageAvailable || result.ArchiveURL != "" {
		t.Fatalf("diagnostic package confused with final readiness: %+v", result)
	}
	diagnosticURL := ""
	for _, file := range result.Files {
		if file.Kind == "diagnostics" {
			diagnosticURL = file.URL
			break
		}
	}
	if diagnosticURL == "" {
		t.Fatalf("verified diagnostics missing from non-ready result: %+v", result)
	}
	download := httptest.NewRecorder()
	server.Handler().ServeHTTP(download, httptest.NewRequest(http.MethodGet, diagnosticURL, nil))
	if download.Code != http.StatusOK || !strings.Contains(download.Body.String(), "opiu-report-only-diagnostics.v1") {
		t.Fatalf("verified diagnostics download status=%d body=%s", download.Code, download.Body.String())
	}
	archive := httptest.NewRecorder()
	server.Handler().ServeHTTP(archive, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001?archive=1", nil))
	if archive.Code != http.StatusNotFound {
		t.Fatalf("non-ready diagnostic package exposed final archive: status=%d", archive.Code)
	}
	unlisted := filepath.Join(runDir, "r001", "unlisted-diagnostic.json")
	if err := os.WriteFile(unlisted, []byte(`{"private":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	unlistedDownload := httptest.NewRecorder()
	server.Handler().ServeHTTP(unlistedDownload, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001/file?path=unlisted-diagnostic.json", nil))
	if unlistedDownload.Code != http.StatusNotFound {
		t.Fatalf("non-allowlisted diagnostic exposed: status=%d body=%s", unlistedDownload.Code, unlistedDownload.Body.String())
	}
}

func TestR005DirectResultRequiresImmutableStructuralAnchorAndSurvivesLateFailure(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID: "ctx_r005_result_anchor", Organization: "9 Управляющая компания",
		OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	run := Run{
		ID: "run_r005_result_anchor", ContextID: contextValue.ID,
		Status: RunFailed, Stage: "R001", Safety: reportOnlySafety(),
	}
	store.state.Contexts[contextValue.ID] = contextValue
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	bindingSHA := writePipelineStructuralInventoryV3(t, store, run, contextValue)
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}

	requestResult := func() runStageResult {
		t.Helper()
		recorder := httptest.NewRecorder()
		server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r005", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("R005 result status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var result runStageResult
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := requestResult(); result.Ready || len(result.Files) != 0 {
		t.Fatalf("unanchored R005 result was exposed: %+v", result)
	}
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	allowances, err := server.validatedR005ResultAllowances(filepath.Join(store.RunsDir(), run.ID, "r005"), run)
	if err != nil {
		t.Fatal(err)
	}
	if allowance := allowances["reconciliation.xlsx"]; allowance.Limit != 1<<30 {
		t.Fatalf("R005 workbook direct-download limit=%d, want=%d", allowance.Limit, int64(1<<30))
	}
	result := requestResult()
	if !result.Ready || len(result.Files) != 3 {
		t.Fatalf("anchored R005 result unavailable after late run failure: %+v", result)
	}
	reportURL := "/api/runs/" + run.ID + "/result/r005/file?path=reconciliation.xlsx"
	reportRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(reportRecorder, httptest.NewRequest(http.MethodGet, reportURL, nil))
	if reportRecorder.Code != http.StatusOK || reportRecorder.Body.String() != "exact report bytes" {
		t.Fatalf("anchored R005 direct download status=%d body=%q", reportRecorder.Code, reportRecorder.Body.String())
	}
	if snapshots, err := filepath.Glob(filepath.Join(store.RunsDir(), run.ID, "r005", ".opiu-direct-result-*")); err != nil || len(snapshots) != 0 {
		t.Fatalf("direct result snapshots not cleaned: %v err=%v", snapshots, err)
	}

	reportPath := filepath.Join(store.RunsDir(), run.ID, "r005", "reconciliation.xlsx")
	reportBytes, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	reportBytes[0] ^= 0x01
	if err := os.WriteFile(reportPath, reportBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if result := requestResult(); result.Ready || len(result.Files) != 0 {
		t.Fatalf("SHA-changed R005 result remained exposed: %+v", result)
	}
	tamperedRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(tamperedRecorder, httptest.NewRequest(http.MethodGet, reportURL, nil))
	if tamperedRecorder.Code != http.StatusNotFound {
		t.Fatalf("SHA-changed R005 direct download status=%d body=%s", tamperedRecorder.Code, tamperedRecorder.Body.String())
	}
}

func TestR001ArchiveRejectsValidationToOpenMutationBeforeHTTP200(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID: "ctx_archive_snapshot", Organization: "9 Управляющая компания",
		OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	run := Run{
		ID: "run_archive_snapshot", ContextID: contextValue.ID,
		Status: RunCompletedReportOnly, Stage: "DONE",
		StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety(),
	}
	store.state.Contexts[contextValue.ID] = contextValue
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	writeFailSoftR005Fixture(t, filepath.Join(runDir, "r005"), contextValue, "BLOCKED_R005_REPASS_REQUIRED")
	writeFailSoftR001PackageFixtureForRun(t, filepath.Join(runDir, "r001"), run, contextValue)
	root := filepath.Join(runDir, "r001")
	if err := materializeVisibleReportPackage(run, contextValue, runDir, root, "R001", "R001_COMPLETED_WITH_BLOCKERS", "Безопасный отчётный пакет"); err != nil {
		t.Fatal(err)
	}
	files, err := collectStageResultFiles(root, run.ID, "r001")
	if err != nil {
		t.Fatal(err)
	}
	verified := make([]resultFile, 0, len(files))
	for _, file := range files {
		if _, err := visibleReportDownloadAllowance(root, file.Name); err == nil {
			verified = append(verified, file)
		}
	}
	diagnosticsPath := filepath.Join(root, "service-report-package", "technical", "diagnostics.json")
	diagnosticsBytes, err := os.ReadFile(diagnosticsPath)
	if err != nil {
		t.Fatal(err)
	}
	diagnosticsBytes[len(diagnosticsBytes)/2] ^= 0x01
	if err := os.WriteFile(diagnosticsPath, diagnosticsBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.writeStageResultArchive(recorder, root, verified)
	if recorder.Code == http.StatusOK {
		t.Fatalf("R001 archive committed HTTP 200 after validation-to-open mutation; bytes=%d", recorder.Body.Len())
	}
}

func TestR005ResultRejectsMutationOfEveryAnchoredArtifact(t *testing.T) {
	for _, artifactName := range []string{
		"reconciliation.xlsx",
		"reconciliation.codex-input.json",
		"reconciliation.manifest.json",
	} {
		t.Run(artifactName, func(t *testing.T) {
			store, err := OpenStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			contextValue := Context{
				ID: "ctx_r005_mutation", Organization: "9 Управляющая компания",
				OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания",
				OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
			}
			run := Run{
				ID: "run_r005_mutation", ContextID: contextValue.ID,
				Status: RunCompletedReportOnly, Stage: "DONE", Safety: reportOnlySafety(),
			}
			store.state.Contexts[contextValue.ID] = contextValue
			store.state.Runs[run.ID] = run
			if err := store.saveLocked(); err != nil {
				t.Fatal(err)
			}
			bindingSHA := writePipelineStructuralInventoryV3(t, store, run, contextValue)
			if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
				t.Fatal(err)
			}
			artifactPath := filepath.Join(store.RunsDir(), run.ID, "r005", artifactName)
			artifactBytes, err := os.ReadFile(artifactPath)
			if err != nil {
				t.Fatal(err)
			}
			artifactBytes[len(artifactBytes)/2] ^= 0x01
			if err := os.WriteFile(artifactPath, artifactBytes, 0o600); err != nil {
				t.Fatal(err)
			}
			server, err := NewServer(store, &Pipeline{})
			if err != nil {
				t.Fatal(err)
			}
			listing := httptest.NewRecorder()
			server.Handler().ServeHTTP(listing, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r005", nil))
			if listing.Code != http.StatusOK {
				t.Fatalf("R005 listing status=%d body=%s", listing.Code, listing.Body.String())
			}
			var result runStageResult
			if err := json.Unmarshal(listing.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Ready || len(result.Files) != 0 {
				t.Fatalf("mutated %s remained exposed: %+v", artifactName, result)
			}
		})
	}
}
