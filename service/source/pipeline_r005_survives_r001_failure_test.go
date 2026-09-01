package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const forcedR001SafeMessage = "R001 не сформирован: принудительная проверочная ошибка после успешной R005"

type sakhalinResilientScenario struct {
	root        string
	store       *Store
	context     Context
	stagesMu    sync.Mutex
	stages      []string
	r001Outcome func(string) error
}

func TestRunWorkerRetainsVerifiedR005AfterDeterministicR001Failure(t *testing.T) {
	scenario := newSakhalinResilientScenario(t, func(string) error {
		return errors.New("FORCED_R001_FAILURE_AFTER_VALID_R005")
	})
	server := scenario.server(t)
	acceptedRun := startSakhalinResilientRun(t, server, scenario.context.ID)
	terminal := waitSakhalinTerminalRun(t, scenario.store, acceptedRun.ID)

	assertSakhalinStageOrder(t, scenario, "R005,R001")
	if terminal.Status != RunFailed || terminal.Stage != "R001" || terminal.FinishedAt == nil ||
		!strings.Contains(terminal.Message, forcedR001SafeMessage) || strings.Contains(terminal.Message, "FORCED_R001_FAILURE_AFTER_VALID_R005") {
		t.Fatalf("forced R001 reason was not explicitly and safely terminalized: %+v", terminal)
	}
	assertRetainedR005AndFailedR001(t, server, terminal, "принудительная проверочная ошибка после успешной R005")
}

func TestRunWorkerRetainsVerifiedR005AfterInvalidR001Output(t *testing.T) {
	scenario := newSakhalinResilientScenario(t, func(runDir string) error {
		technicalDir := filepath.Join(runDir, "r001", "CORRUPT_R001", "technical")
		if err := os.MkdirAll(technicalDir, 0o700); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(technicalDir, "manifest.json"), []byte(`{"schema_version":`), 0o600)
	})
	server := scenario.server(t)
	acceptedRun := startSakhalinResilientRun(t, server, scenario.context.ID)
	terminal := waitSakhalinTerminalRun(t, scenario.store, acceptedRun.ID)

	assertSakhalinStageOrder(t, scenario, "R005,R001")
	if terminal.Status != RunFailed || terminal.Stage != "R001" || terminal.FinishedAt == nil ||
		terminal.Message != "R001 не сформирован: манифест R001 повреждён или нечитаем" {
		t.Fatalf("corrupt R001 output was not explicitly terminalized: %+v", terminal)
	}
	assertRetainedR005AndFailedR001(t, server, terminal, "манифест R001 повреждён или нечитаем")
}

func TestRunWorkerRetainsVerifiedR005AfterR001Timeout(t *testing.T) {
	scenario := newSakhalinResilientScenario(t, func(string) error {
		return context.DeadlineExceeded
	})
	server := scenario.server(t)
	acceptedRun := startSakhalinResilientRun(t, server, scenario.context.ID)
	terminal := waitSakhalinTerminalRun(t, scenario.store, acceptedRun.ID)

	assertSakhalinStageOrder(t, scenario, "R005,R001")
	if terminal.Status != RunFailed || terminal.Stage != "R001" || terminal.FinishedAt == nil ||
		!strings.Contains(terminal.Message, "превышен тайм-аут этапа R001") {
		t.Fatalf("R001 timeout was not explicitly terminalized: %+v", terminal)
	}
	assertRetainedR005AndFailedR001(t, server, terminal, "превышен тайм-аут этапа R001")
}

func TestRestartAfterAnchoredR005RetainsResultAndTerminalizesRun(t *testing.T) {
	r001Reached := make(chan struct{})
	scenario := newSakhalinResilientScenario(t, func(string) error {
		close(r001Reached)
		// Simulate abrupt process termination after the durable R005 inventory
		// anchor and persisted RUNNING/R001 transition, before R001 returns.
		runtime.Goexit()
		return nil
	})
	server := scenario.server(t)
	acceptedRun := startSakhalinResilientRun(t, server, scenario.context.ID)
	select {
	case <-r001Reached:
	case <-time.After(5 * time.Second):
		t.Fatalf("run %s did not reach R001 after anchored R005", acceptedRun.ID)
	}
	preRestart, ok := scenario.store.Run(acceptedRun.ID)
	if !ok || preRestart.Status != RunRunning || preRestart.Stage != "R001" {
		t.Fatalf("restart fixture did not persist RUNNING/R001: %+v", preRestart)
	}
	if _, anchored := scenario.store.StructuralControlInventoryAnchor(acceptedRun.ID); !anchored {
		t.Fatal("R005 structural inventory was not durably anchored before restart")
	}

	reopened, err := OpenStore(scenario.root)
	if err != nil {
		t.Fatal(err)
	}
	terminal, ok := reopened.Run(acceptedRun.ID)
	if !ok || terminal.Status != RunFailed || terminal.Stage != interruptedServiceRestartStage ||
		terminal.Message != interruptedServiceRestartMessage || terminal.FinishedAt == nil {
		t.Fatalf("OpenStore did not terminalize interrupted run honestly: %+v", terminal)
	}
	if _, anchored := reopened.StructuralControlInventoryAnchor(acceptedRun.ID); !anchored {
		t.Fatal("restart lost durable R005 structural inventory anchor")
	}
	projected := findSnapshotRun(t, reopened.Snapshot(true), acceptedRun.ID)
	if !projected.HasStructuralInventory {
		t.Fatalf("restart projection hid anchored R005: %+v", projected)
	}

	restartedServer, err := NewServer(reopened, &Pipeline{store: reopened, active: map[string]struct{}{}})
	if err != nil {
		t.Fatal(err)
	}
	runResponse := httptest.NewRecorder()
	restartedServer.Handler().ServeHTTP(runResponse, httptest.NewRequest(http.MethodGet, "/api/runs/"+acceptedRun.ID, nil))
	if runResponse.Code != http.StatusOK {
		t.Fatalf("GET restarted run status=%d body=%s", runResponse.Code, runResponse.Body.String())
	}
	var apiRun Run
	if err := json.Unmarshal(runResponse.Body.Bytes(), &apiRun); err != nil {
		t.Fatal(err)
	}
	if apiRun.Stage != interruptedServiceRestartStage || !apiRun.HasStructuralInventory {
		t.Fatalf("restart GET run lost terminal/anchor projection: %+v", apiRun)
	}
	assertRetainedR005AndFailedR001(t, restartedServer, terminal, "Предыдущий экземпляр OPIU завершился")

	// Collection/bootstrap must preserve their existing cheap deferred projection:
	// even after an artifact changes they expose only the durable anchor bit and
	// must not hash a potentially 1 GiB workbook. Exact lookup and the result
	// route remain authoritative and revalidate the physical R005 package.
	workbookPath := filepath.Join(reopened.RunsDir(), acceptedRun.ID, "r005", "reconciliation.xlsx")
	if err := os.WriteFile(workbookPath, []byte("tampered-after-restart"), 0o600); err != nil {
		t.Fatal(err)
	}
	collection := httptest.NewRecorder()
	restartedServer.Handler().ServeHTTP(collection, httptest.NewRequest(http.MethodGet, "/api/runs", nil))
	if collection.Code != http.StatusOK {
		t.Fatalf("GET run collection status=%d body=%s", collection.Code, collection.Body.String())
	}
	var collectedRuns []Run
	if err := json.Unmarshal(collection.Body.Bytes(), &collectedRuns); err != nil {
		t.Fatal(err)
	}
	if !findRunInList(t, collectedRuns, acceptedRun.ID).HasStructuralInventory {
		t.Fatal("run collection performed forbidden eager physical R005 validation")
	}
	bootstrap := httptest.NewRecorder()
	restartedServer.Handler().ServeHTTP(bootstrap, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	if bootstrap.Code != http.StatusOK {
		t.Fatalf("GET bootstrap status=%d body=%s", bootstrap.Code, bootstrap.Body.String())
	}
	var bootstrapSnapshot Snapshot
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &bootstrapSnapshot); err != nil {
		t.Fatal(err)
	}
	if !findSnapshotRun(t, bootstrapSnapshot, acceptedRun.ID).HasStructuralInventory {
		t.Fatal("bootstrap performed forbidden eager physical R005 validation")
	}
	exactAfterTamper := httptest.NewRecorder()
	restartedServer.Handler().ServeHTTP(exactAfterTamper, httptest.NewRequest(http.MethodGet, "/api/runs/"+acceptedRun.ID, nil))
	if exactAfterTamper.Code != http.StatusOK {
		t.Fatalf("GET exact run after tamper status=%d body=%s", exactAfterTamper.Code, exactAfterTamper.Body.String())
	}
	if err := json.Unmarshal(exactAfterTamper.Body.Bytes(), &apiRun); err != nil {
		t.Fatal(err)
	}
	if apiRun.HasStructuralInventory {
		t.Fatal("exact run lookup failed to revalidate changed physical R005")
	}
	r005AfterTamper := getRunStageResult(t, restartedServer, terminal.ID, "r005")
	if r005AfterTamper.Ready || len(r005AfterTamper.Files) != 0 {
		t.Fatalf("result route advertised changed physical R005: %+v", r005AfterTamper)
	}
}

func newSakhalinResilientScenario(t *testing.T, r001Outcome func(string) error) *sakhalinResilientScenario {
	t.Helper()
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureOrganizationCatalog([]organizationNode{{
		ID: "ERP-000000076", Code: "3", Name: "3 Сахалин", Path: "3 Сахалин", Selectable: true,
	}}); err != nil {
		t.Fatal(err)
	}
	erp := addTestSource(t, store, SourceERP, "sakhalin-erp.zip")
	intalev := addTestSource(t, store, SourceIntalev, "sakhalin-intalev.zip")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization: "3 Сахалин", OrganizationID: "ERP-000000076",
		OrganizationName: "3 Сахалин", OrganizationPath: "3 Сахалин",
		Period: "2025-01", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &sakhalinResilientScenario{root: root, store: store, context: contextValue, r001Outcome: r001Outcome}
}

func (scenario *sakhalinResilientScenario) server(t *testing.T) *Server {
	t.Helper()
	pipeline := &Pipeline{
		store: scenario.store,
		runtime: &RuntimeAdapter{
			Root: t.TempDir(), Node: "node", R005Script: "opiu_reconcile.mjs", R001Script: "service_r001_owner_wrapper.mjs",
		},
		active: map[string]struct{}{},
	}
	pipeline.runner = func(stage string, command []string, _ map[string]string, runDir, _ string) error {
		scenario.stagesMu.Lock()
		scenario.stages = append(scenario.stages, stage)
		scenario.stagesMu.Unlock()
		switch stage {
		case "R005":
			runID, ok := commandArgument(command, "--run-id")
			if !ok || runID == "" {
				t.Fatalf("production R005 command omitted --run-id: %#v", command)
			}
			run, ok := scenario.store.Run(runID)
			if !ok {
				t.Fatalf("production worker run %q is absent from Store", runID)
			}
			writePipelineStructuralInventoryV3(t, scenario.store, run, scenario.context)
			r005Dir := filepath.Join(runDir, "r005")
			writeSyntheticReportWorkbook(t, filepath.Join(r005Dir, "reconciliation.xlsx"), "01_Сверка_дерево", [][]any{{"3 Сахалин", "2025-01"}})
			writeFailSoftR005Fixture(t, r005Dir, scenario.context, "PASS_R005")
			refreshFailSoftInventoryProvenance(t, filepath.Join(r005Dir, "structural-control-inventory.json"), r005Dir)
			return nil
		case "R001":
			return scenario.r001Outcome(runDir)
		default:
			t.Fatalf("unexpected production pipeline stage: %s", stage)
			return nil
		}
	}
	server, err := NewServer(scenario.store, pipeline)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func startSakhalinResilientRun(t *testing.T, server *Server, contextID string) Run {
	t.Helper()
	requestBody, err := json.Marshal(createRunRequest{ContextID: contextID})
	if err != nil {
		t.Fatal(err)
	}
	created := httptest.NewRecorder()
	server.Handler().ServeHTTP(created, httptest.NewRequest(http.MethodPost, "/api/runs", bytes.NewReader(requestBody)))
	if created.Code != http.StatusAccepted {
		t.Fatalf("POST /api/runs status=%d body=%s", created.Code, created.Body.String())
	}
	var acceptedRun Run
	if err := json.Unmarshal(created.Body.Bytes(), &acceptedRun); err != nil {
		t.Fatal(err)
	}
	return acceptedRun
}

func waitSakhalinTerminalRun(t *testing.T, store *Store, runID string) Run {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		current, ok := store.Run(runID)
		if ok && current.Status != RunQueued && current.Status != RunPreflight && current.Status != RunRunning {
			return current
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("run %s did not reach a terminal state", runID)
	return Run{}
}

func assertSakhalinStageOrder(t *testing.T, scenario *sakhalinResilientScenario, want string) {
	t.Helper()
	scenario.stagesMu.Lock()
	got := strings.Join(append([]string(nil), scenario.stages...), ",")
	scenario.stagesMu.Unlock()
	if got != want {
		t.Fatalf("production stage order=%s, want %s", got, want)
	}
}

func assertRetainedR005AndFailedR001(t *testing.T, server *Server, terminal Run, reason string) {
	t.Helper()
	assertClosedReportOnlySafety(t, terminal.Safety)
	r005 := getRunStageResult(t, server, terminal.ID, "r005")
	if !r005.Ready || len(r005.Files) != 3 {
		t.Fatalf("verified R005 was not retained after downstream R001 failure: %+v", r005)
	}
	for _, name := range []string{"reconciliation.xlsx", "reconciliation.manifest.json"} {
		file := findResultFile(t, r005.Files, name)
		download := httptest.NewRecorder()
		server.Handler().ServeHTTP(download, httptest.NewRequest(http.MethodGet, file.URL, nil))
		if download.Code != http.StatusOK || download.Body.Len() == 0 {
			t.Fatalf("R005 direct file %s status=%d bytes=%d", name, download.Code, download.Body.Len())
		}
		if name == "reconciliation.xlsx" {
			if _, err := zip.NewReader(bytes.NewReader(download.Body.Bytes()), int64(download.Body.Len())); err != nil {
				t.Fatalf("retained R005 workbook is not a physical XLSX package: %v", err)
			}
		}
	}
	r001 := getRunStageResult(t, server, terminal.ID, "r001")
	if r001.Ready || r001.ArchiveURL != "" || len(r001.Files) != 0 {
		t.Fatalf("failed R001 was falsely advertised as ready: %+v", r001)
	}
	diagnostics := httptest.NewRecorder()
	server.Handler().ServeHTTP(diagnostics, httptest.NewRequest(http.MethodGet, "/api/runs/"+terminal.ID+"/diagnostics", nil))
	if diagnostics.Code != http.StatusOK || !strings.Contains(diagnostics.Body.String(), terminal.Message) || !strings.Contains(diagnostics.Body.String(), reason) {
		t.Fatalf("R001 failure reason missing from diagnostics: status=%d body=%s", diagnostics.Code, diagnostics.Body.String())
	}
}

func findSnapshotRun(t *testing.T, snapshot Snapshot, runID string) Run {
	t.Helper()
	for _, run := range snapshot.Runs {
		if run.ID == runID {
			return run
		}
	}
	t.Fatalf("run %s missing from snapshot", runID)
	return Run{}
}

func findRunInList(t *testing.T, runs []Run, runID string) Run {
	t.Helper()
	for _, run := range runs {
		if run.ID == runID {
			return run
		}
	}
	t.Fatalf("run %s missing from collection", runID)
	return Run{}
}

func getRunStageResult(t *testing.T, server *Server, runID, stage string) runStageResult {
	t.Helper()
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs/"+runID+"/result/"+stage, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s result status=%d body=%s", stage, recorder.Code, recorder.Body.String())
	}
	var result runStageResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func findResultFile(t *testing.T, files []resultFile, name string) resultFile {
	t.Helper()
	for _, file := range files {
		if filepath.ToSlash(file.Name) == name {
			return file
		}
	}
	t.Fatalf("result file %q is absent: %+v", name, files)
	return resultFile{}
}

func assertClosedReportOnlySafety(t *testing.T, safety SafetyState) {
	t.Helper()
	if safety != reportOnlySafety() {
		t.Fatalf("REPORT_ONLY safety changed: got=%+v want=%+v", safety, reportOnlySafety())
	}
}
