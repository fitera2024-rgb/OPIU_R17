package main

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) (*Server, *Store, *Pipeline) {
	t.Helper()
	for _, name := range []string{"OPIU_R005_CMD_JSON", "OPIU_R001_CMD_JSON"} {
		t.Setenv(name, "")
	}
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	configureTestOrganizationCatalog(t, store)
	pipeline, err := NewPipeline(store)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(store, pipeline)
	if err != nil {
		t.Fatal(err)
	}
	return server, store, pipeline
}

func configureTestOrganizationCatalog(t *testing.T, store *Store) {
	t.Helper()
	if err := store.ConfigureOrganizationCatalog([]organizationNode{
		{ID: "ORG-9", Name: "9 Управляющая компания", Path: "Холдинг / 9 Управляющая компания", Selectable: true},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHealthAndBootstrapKeepSafetyFalse(t *testing.T) {
	server, store, _ := testServer(t)
	file := addTestSource(t, store, SourceERP, "erp.xlsx")
	file.SHA256 = "DO-NOT-EXPOSE-HASH"
	store.mu.Lock()
	store.state.Files[file.ID] = file
	if err := store.saveLocked(); err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	store.mu.Unlock()

	for _, path := range []string{"/api/health", "/api/bootstrap"} {
		recorder := httptest.NewRecorder()
		server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d", path, recorder.Code)
		}
		body := recorder.Body.String()
		if path == "/api/health" && (!strings.Contains(body, `"rules_service":false`) || !strings.Contains(body, `"pipeline":"R005_SERVICE_HANDOFF_R001"`)) {
			t.Fatalf("health omitted direct pipeline capability closure: %s", body)
		}
		for _, forbidden := range []string{"DO-NOT-EXPOSE-HASH", store.Root(), `"live_1c_allowed":true`, `"ready_to_upload":true`, `"posting_rows":1`} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("%s exposed forbidden value %q: %s", path, forbidden, body)
			}
		}
	}
}

func TestUploadNormalizesTraversalNameWithinStore(t *testing.T) {
	server, _, _ := testServer(t)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "../escape.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("xlsx"))
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/files?kind=erp", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var uploaded SourceFile
	if err := json.Unmarshal(recorder.Body.Bytes(), &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.Name != "escape.xlsx" {
		t.Fatalf("normalized name = %q", uploaded.Name)
	}
}

func TestContextRunStopsAtUnconfiguredEngineAdapter(t *testing.T) {
	server, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextBody, _ := json.Marshal(createContextRequest{
		Organization:  "Управляющая компания",
		Period:        "2026-08",
		ERPFileID:     erp.ID,
		IntalevFileID: intalev.ID,
	})
	contextRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(contextRecorder, httptest.NewRequest(http.MethodPost, "/api/contexts", bytes.NewReader(contextBody)))
	if contextRecorder.Code != http.StatusCreated {
		t.Fatalf("create context: %d %s", contextRecorder.Code, contextRecorder.Body.String())
	}
	var contextValue Context
	if err := json.Unmarshal(contextRecorder.Body.Bytes(), &contextValue); err != nil {
		t.Fatal(err)
	}
	runBody, _ := json.Marshal(createRunRequest{ContextID: contextValue.ID})
	runRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(runRecorder, httptest.NewRequest(http.MethodPost, "/api/runs", bytes.NewReader(runBody)))
	if runRecorder.Code != http.StatusAccepted {
		t.Fatalf("create run: %d %s", runRecorder.Code, runRecorder.Body.String())
	}
	var queued Run
	if err := json.Unmarshal(runRecorder.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		run, ok := store.Run(queued.ID)
		if ok && run.FinishedAt != nil {
			if run.Status != RunBlockedEngineAdapter {
				t.Fatalf("status = %s, run = %+v", run.Status, run)
			}
			if run.Safety.PostingRows != 0 || run.Safety.Live1CAllowed {
				t.Fatalf("unsafe run: %+v", run)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run did not finish preflight")
}

func TestEmbeddedUIUsesBusinessLanguage(t *testing.T) {
	server, _, _ := testServer(t)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	body := recorder.Body.String()
	for _, required := range []string{"Перевыбрать пакеты ERP и Инталев", "Запись в 1С отключена", "Запустить сверку"} {
		if !strings.Contains(body, required) {
			t.Errorf("UI is missing %q", required)
		}
	}
	for _, forbidden := range []string{"SHA-256", "локальный путь", "proof JSON"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("UI exposes technical control %q", forbidden)
		}
	}
}

func TestRunsAPIOrdersNewestCreatedRunFirst(t *testing.T) {
	server, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization:  "9 Управляющая компания",
		Period:        "2025-11",
		ERPFileID:     erp.ID,
		IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/runs", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("list runs: status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var runs []Run
	if err := json.Unmarshal(recorder.Body.Bytes(), &runs); err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 || runs[0].ID != second.ID || runs[1].ID != first.ID {
		t.Fatalf("runs were not returned newest first: %+v", runs)
	}
}

func TestDiagnosticsUITracksNewestCreatedRunBeforeFilteringDiagnostics(t *testing.T) {
	data, err := os.ReadFile("web/diagnostics-ui.js")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	latest := strings.Index(source, "diagnosticUI.latestRunId = orderedRuns[0]?.id || \"\";")
	filtered := strings.Index(source, "const relevant = orderedRuns.filter")
	if latest < 0 || filtered < 0 || latest > filtered {
		t.Fatalf("diagnostics UI must select latest created run before filtering: latest=%d filtered=%d", latest, filtered)
	}
}
