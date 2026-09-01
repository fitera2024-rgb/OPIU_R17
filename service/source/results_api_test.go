package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
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

func TestUI012CanonicalR001ResultDiscovery(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID:               "ctx_ui012_canonical",
		Organization:     "9 Управляющая компания",
		OrganizationID:   structuralSourceOrganizationID,
		OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period:           "2025-10",
	}
	run := Run{
		ID:        "run_ui012_canonical",
		ContextID: contextValue.ID,
		Status:    RunCompletedReportOnly,
		Stage:     "DONE",
		StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC),
		Safety:    reportOnlySafety(),
	}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}

	runDir := filepath.Join(store.RunsDir(), run.ID)
	prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
	packageDir := writeUI012CanonicalR001PackageFixture(t, filepath.Join(runDir, "r001"), run, contextValue)
	if err := materializeVisibleReportPackage(run, contextValue, runDir, filepath.Join(runDir, "r001"), "R001", "R001_COMPLETED_WITH_BLOCKERS", "Безопасный отчётный пакет"); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var result runStageResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}

	expected := map[string]string{
		"Решения.xlsx": "decisions",
		"СПОРНО/[ГК][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx":                          "disputed",
		"СПОРНО/[ООО Группа компаний Планета][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx": "disputed",
		"СПОРНО/[ООО Планета Инноваций][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx":       "disputed",
	}
	missing := make(map[string]string, len(expected))
	for name, kind := range expected {
		missing[name] = kind
	}
	decisions, disputed := 0, 0
	for _, file := range result.Files {
		name := strings.TrimPrefix(filepath.ToSlash(file.Name), filepath.Base(packageDir)+"/")
		wantKind, ok := expected[name]
		if !ok {
			continue
		}
		if file.Kind != wantKind {
			t.Errorf("canonical artifact %q kind=%q want=%q", name, file.Kind, wantKind)
		}
		info, err := os.Stat(filepath.Join(packageDir, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if file.Size != info.Size() || file.URL == "" {
			t.Errorf("canonical artifact %q size=%d want=%d url=%q", name, file.Size, info.Size(), file.URL)
		}
		delete(missing, name)
		if file.Kind == "decisions" {
			decisions++
		}
		if file.Kind == "disputed" {
			disputed++
		}
	}
	if !result.Ready || !result.VerifiedPackageAvailable || result.ArchiveURL == "" || len(missing) != 0 || decisions != 1 || disputed != 3 {
		t.Fatalf("UI012 canonical discovery: ready=%v verified=%v archive=%q listed=%d decisions=%d disputed=%d missing=%d (%v)", result.Ready, result.VerifiedPackageAvailable, result.ArchiveURL, len(result.Files), decisions, disputed, len(missing), missing)
	}

	var registry struct {
		Artifacts []visibleReportArtifact `json:"artifacts"`
	}
	registryPath := filepath.Join(runDir, "r001", "service-report-package", "technical", "artifact-registry.json")
	if err := readJSONFile(registryPath, &registry); err != nil {
		t.Fatal(err)
	}
	registryByName := map[string]visibleReportArtifact{}
	for _, artifact := range registry.Artifacts {
		registryByName[strings.TrimPrefix(artifact.Name, "r001/")] = artifact
	}
	resultByName := map[string]resultFile{}
	for _, file := range result.Files {
		resultByName[file.Name] = file
	}
	for relative := range expected {
		name := filepath.ToSlash(filepath.Join(filepath.Base(packageDir), filepath.FromSlash(relative)))
		file, ok := resultByName[name]
		if !ok {
			t.Fatalf("canonical direct-download artifact missing from API: %s", name)
		}
		download := httptest.NewRecorder()
		server.Handler().ServeHTTP(download, httptest.NewRequest(http.MethodGet, file.URL, nil))
		if download.Code != http.StatusOK {
			t.Fatalf("canonical direct download %q status=%d body=%s", name, download.Code, download.Body.String())
		}
		physical, err := os.ReadFile(filepath.Join(runDir, "r001", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(download.Body.Bytes(), physical) {
			t.Fatalf("canonical direct download bytes differ from physical artifact: %s", name)
		}
		downloadSHA256 := sha256.Sum256(download.Body.Bytes())
		registered, ok := registryByName[name]
		if !ok || !strings.EqualFold(fmt.Sprintf("%X", downloadSHA256), registered.SHA256) {
			t.Fatalf("canonical direct download %q SHA=%X registered=%q", name, downloadSHA256, registered.SHA256)
		}
	}

	unlistedNames := []string{
		filepath.ToSlash(filepath.Join(filepath.Base(packageDir), "arbitrary-unlisted.xlsx")),
		filepath.ToSlash(filepath.Join(filepath.Base(packageDir), "СПОРНО", "[FAKE][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx")),
	}
	for _, name := range unlistedNames {
		writeSyntheticReportWorkbook(t, filepath.Join(runDir, "r001", filepath.FromSlash(name)), "Загрузка_A_AA", nil)
	}
	foreignPath := filepath.Join(store.RunsDir(), "run_ui012_foreign", "r001", "foreign-owner.xlsx")
	writeSyntheticReportWorkbook(t, foreignPath, "Загрузка_A_AA", nil)

	secondListing := httptest.NewRecorder()
	server.Handler().ServeHTTP(secondListing, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001", nil))
	if secondListing.Code != http.StatusOK {
		t.Fatalf("listing with private files status=%d body=%s", secondListing.Code, secondListing.Body.String())
	}
	var listedAgain runStageResult
	if err := json.Unmarshal(secondListing.Body.Bytes(), &listedAgain); err != nil {
		t.Fatal(err)
	}
	if !listedAgain.Ready || len(listedAgain.Files) != len(result.Files) {
		t.Fatalf("private/foreign files changed verified listing: before=%d after=%d ready=%v", len(result.Files), len(listedAgain.Files), listedAgain.Ready)
	}
	for _, file := range listedAgain.Files {
		for _, unlisted := range unlistedNames {
			if file.Name == unlisted {
				t.Fatalf("unlisted result leaked into API: %s", unlisted)
			}
		}
		if strings.Contains(file.Name, "foreign-owner.xlsx") {
			t.Fatalf("foreign-run result leaked into API: %s", file.Name)
		}
	}
	for _, name := range unlistedNames {
		rejected := httptest.NewRecorder()
		url := "/api/runs/" + run.ID + "/result/r001/file?path=" + urlQueryEscape(name)
		server.Handler().ServeHTTP(rejected, httptest.NewRequest(http.MethodGet, url, nil))
		if rejected.Code != http.StatusNotFound {
			t.Fatalf("unlisted direct download %q status=%d body=%s", name, rejected.Code, rejected.Body.String())
		}
	}
	traversal := httptest.NewRecorder()
	server.Handler().ServeHTTP(traversal, httptest.NewRequest(http.MethodGet, "/api/runs/"+run.ID+"/result/r001/file?path=../../run_ui012_foreign/r001/foreign-owner.xlsx", nil))
	if traversal.Code != http.StatusBadRequest {
		t.Fatalf("path traversal status=%d body=%s", traversal.Code, traversal.Body.String())
	}

	archiveRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(archiveRecorder, httptest.NewRequest(http.MethodGet, result.ArchiveURL, nil))
	if archiveRecorder.Code != http.StatusOK {
		t.Fatalf("canonical archive status=%d body=%s", archiveRecorder.Code, archiveRecorder.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(archiveRecorder.Body.Bytes()), int64(archiveRecorder.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	archiveNames := map[string]bool{}
	for _, entry := range archive.File {
		name := filepath.ToSlash(entry.Name)
		if archiveNames[name] {
			t.Fatalf("canonical archive duplicated %q", name)
		}
		archiveNames[name] = true
		file, ok := resultByName[name]
		if !ok {
			t.Fatalf("canonical archive contained unexpected/unlisted artifact %q", name)
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		archived, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		physical, err := os.ReadFile(filepath.Join(runDir, "r001", filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(archived, physical) || int64(len(archived)) != file.Size {
			t.Fatalf("canonical archive bytes/size differ for %q", name)
		}
	}
	if len(archiveNames) != len(result.Files) {
		t.Fatalf("canonical archive entries=%d API files=%d", len(archiveNames), len(result.Files))
	}
	for name := range resultByName {
		if !archiveNames[name] {
			t.Fatalf("canonical archive omitted API artifact %q", name)
		}
	}
}

func writeUI012CanonicalR001PackageFixture(t *testing.T, r001Dir string, run Run, contextValue Context) string {
	t.Helper()
	writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		t.Fatal(err)
	}
	packageDir := filepath.Dir(filepath.Dir(manifestPath))
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	outputs := manifest["outputs"].(map[string]any)
	legacyDecision := "Решения_корректировок_ввод_R001.xlsx"
	canonicalDecision := "Решения.xlsx"
	if err := os.Rename(filepath.Join(packageDir, legacyDecision), filepath.Join(packageDir, canonicalDecision)); err != nil {
		t.Fatal(err)
	}
	outputs[canonicalDecision] = outputs[legacyDecision]
	delete(outputs, legacyDecision)

	for _, relative := range []string{
		"СПОРНО/[ГК][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
		"СПОРНО/[ООО Группа компаний Планета][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
		"СПОРНО/[ООО Планета Инноваций][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx",
	} {
		path := filepath.Join(packageDir, filepath.FromSlash(relative))
		writeSyntheticReportWorkbook(t, path, "Загрузка_A_AA", nil)
		hash, err := sha256File(path)
		if err != nil {
			t.Fatal(err)
		}
		outputs[relative] = hash
	}
	writeOrchestrationJSON(t, manifestPath, manifest)
	return packageDir
}

type ui012ResultFixture struct {
	store      *Store
	server     *Server
	run        Run
	context    Context
	runDir     string
	packageDir string
}

func newUI012ResultFixture(t *testing.T, suffix string, canonical bool) ui012ResultFixture {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID: "ctx_ui012_" + suffix, Organization: "9 Управляющая компания",
		OrganizationID: structuralSourceOrganizationID, OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	run := Run{
		ID: "run_ui012_" + suffix, ContextID: contextValue.ID,
		Status: RunCompletedReportOnly, Stage: "DONE",
		StartedAt: time.Date(2025, 10, 31, 12, 0, 0, 0, time.UTC), Safety: reportOnlySafety(),
	}
	store.state.Runs[run.ID] = run
	store.state.Contexts[contextValue.ID] = contextValue
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	runDir := filepath.Join(store.RunsDir(), run.ID)
	prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
	r001Dir := filepath.Join(runDir, "r001")
	packageDir := filepath.Join(r001Dir, "OPIU_CORRECTIONS_R001_SYNTHETIC")
	if canonical {
		packageDir = writeUI012CanonicalR001PackageFixture(t, r001Dir, run, contextValue)
	} else {
		writeFailSoftR001PackageFixtureForRun(t, r001Dir, run, contextValue)
	}
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", "R001_COMPLETED_WITH_BLOCKERS", "Безопасный отчётный пакет"); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, &Pipeline{})
	if err != nil {
		t.Fatal(err)
	}
	return ui012ResultFixture{store: store, server: server, run: run, context: contextValue, runDir: runDir, packageDir: packageDir}
}

func ui012Result(t *testing.T, fixture ui012ResultFixture) runStageResult {
	t.Helper()
	recorder := httptest.NewRecorder()
	fixture.server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+fixture.run.ID+"/result/r001", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("R001 result status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var result runStageResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertUI012MutatedResultRejected(t *testing.T, fixture ui012ResultFixture, relative string) {
	t.Helper()
	result := ui012Result(t, fixture)
	if result.Ready || result.VerifiedPackageAvailable || result.ArchiveURL != "" || len(result.Files) != 0 {
		t.Fatalf("unsafe/mutated result remained visible: %+v", result)
	}
	direct := httptest.NewRecorder()
	url := "/api/runs/" + fixture.run.ID + "/result/r001/file?path=" + urlQueryEscape(relative)
	fixture.server.Handler().ServeHTTP(direct, httptest.NewRequest(http.MethodGet, url, nil))
	if direct.Code != http.StatusNotFound {
		t.Fatalf("unsafe/mutated direct download status=%d body=%s", direct.Code, direct.Body.String())
	}
	archive := httptest.NewRecorder()
	fixture.server.Handler().ServeHTTP(archive, httptest.NewRequest(http.MethodGet, "/api/runs/"+fixture.run.ID+"/result/r001?archive=1", nil))
	if archive.Code != http.StatusNotFound {
		t.Fatalf("unsafe/mutated archive status=%d body=%s", archive.Code, archive.Body.String())
	}
}

func TestUI012CanonicalR001SecurityMatrix(t *testing.T) {
	t.Run("N1_N2_N3_N9_unlisted_foreign_traversal_and_lookalike", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "unlisted", true)
		before := ui012Result(t, fixture)
		if !before.Ready {
			t.Fatalf("verified canonical fixture is not ready: %+v", before)
		}
		unlisted := []string{
			filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "arbitrary.xlsx")),
			filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "СПОРНО", "[FAKE]_ОПИУ_ГОТОВО_СПОРНО.xlsx")),
		}
		for _, name := range unlisted {
			writeSyntheticReportWorkbook(t, filepath.Join(fixture.runDir, "r001", filepath.FromSlash(name)), "Загрузка_A_AA", nil)
		}
		foreignRelative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "foreign-owner.xlsx"))
		writeSyntheticReportWorkbook(t, filepath.Join(fixture.store.RunsDir(), "run_ui012_other", "r001", filepath.FromSlash(foreignRelative)), "Загрузка_A_AA", nil)
		after := ui012Result(t, fixture)
		if !after.Ready || len(after.Files) != len(before.Files) {
			t.Fatalf("unlisted/foreign artifacts changed listing: before=%d after=%d ready=%v", len(before.Files), len(after.Files), after.Ready)
		}
		for _, file := range after.Files {
			if file.Name == unlisted[0] || file.Name == unlisted[1] || file.Name == foreignRelative {
				t.Fatalf("unlisted/foreign artifact leaked: %s", file.Name)
			}
		}
		for _, name := range append(unlisted, foreignRelative) {
			direct := httptest.NewRecorder()
			fixture.server.Handler().ServeHTTP(direct, httptest.NewRequest(http.MethodGet, "/api/runs/"+fixture.run.ID+"/result/r001/file?path="+urlQueryEscape(name), nil))
			if direct.Code != http.StatusNotFound {
				t.Fatalf("unlisted/foreign %q direct status=%d", name, direct.Code)
			}
		}
		traversal := httptest.NewRecorder()
		fixture.server.Handler().ServeHTTP(traversal, httptest.NewRequest(http.MethodGet, "/api/runs/"+fixture.run.ID+"/result/r001/file?path=../../run_ui012_other/r001/"+urlQueryEscape(foreignRelative), nil))
		if traversal.Code != http.StatusBadRequest {
			t.Fatalf("traversal status=%d body=%s", traversal.Code, traversal.Body.String())
		}
	})

	t.Run("N4_symlink", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "symlink", true)
		relative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения.xlsx"))
		path := filepath.Join(fixture.runDir, "r001", filepath.FromSlash(relative))
		target := path + ".target"
		if err := os.Rename(path, target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, path); err != nil {
			t.Skipf("Windows symlink privilege unavailable: %v", err)
		}
		assertUI012MutatedResultRejected(t, fixture, relative)
	})

	t.Run("N5_reparse_point", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("Windows reparse-point regression")
		}
		fixture := newUI012ResultFixture(t, "reparse", true)
		target := filepath.Join(fixture.store.Root(), "ui012-reparse-target")
		if err := os.Rename(fixture.packageDir, target); err != nil {
			t.Fatal(err)
		}
		command := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", fixture.packageDir, target)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("create mandatory junction regression: %v output=%s", err, output)
		}
		defer os.Remove(fixture.packageDir)
		relative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения.xlsx"))
		assertUI012MutatedResultRejected(t, fixture, relative)
	})

	t.Run("N6_tampered_canonical_file", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "tamper", true)
		relative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения.xlsx"))
		path := filepath.Join(fixture.runDir, "r001", filepath.FromSlash(relative))
		if err := os.WriteFile(path, []byte("tampered canonical workbook"), 0o600); err != nil {
			t.Fatal(err)
		}
		assertUI012MutatedResultRejected(t, fixture, relative)
	})

	t.Run("N7_size_mismatch", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "size", true)
		relative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения.xlsx"))
		path := filepath.Join(fixture.runDir, "r001", filepath.FromSlash(relative))
		file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte{0}); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		assertUI012MutatedResultRejected(t, fixture, relative)
	})

	t.Run("N8_sha_mismatch", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "sha", true)
		relative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения.xlsx"))
		path := filepath.Join(fixture.runDir, "r001", filepath.FromSlash(relative))
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		data[len(data)/2] ^= 0x01
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		assertUI012MutatedResultRejected(t, fixture, relative)
	})

	t.Run("N10_verified_legacy_package_only", func(t *testing.T) {
		fixture := newUI012ResultFixture(t, "legacy", false)
		result := ui012Result(t, fixture)
		legacyRelative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения_корректировок_ввод_R001.xlsx"))
		legacyFound := false
		for _, file := range result.Files {
			legacyFound = legacyFound || (file.Name == legacyRelative && file.Kind == "decisions")
		}
		if !result.Ready || !legacyFound {
			t.Fatalf("verified legacy package unavailable: %+v", result)
		}
		fakeRelative := filepath.ToSlash(filepath.Join(filepath.Base(fixture.packageDir), "Решения_корректировок_ввод_R001_FAKE.xlsx"))
		writeSyntheticReportWorkbook(t, filepath.Join(fixture.runDir, "r001", filepath.FromSlash(fakeRelative)), "Sheet1", nil)
		after := ui012Result(t, fixture)
		if !after.Ready || len(after.Files) != len(result.Files) {
			t.Fatalf("unverified legacy lookalike changed listing: before=%d after=%d", len(result.Files), len(after.Files))
		}
		for _, file := range after.Files {
			if file.Name == fakeRelative {
				t.Fatalf("unverified legacy lookalike leaked: %s", fakeRelative)
			}
		}
	})
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
	prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
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
	prepareVerifiedServiceHandoffForRun(t, store, run, contextValue, runDir)
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
