package main

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

//go:embed web/*
var embeddedWeb embed.FS

type Server struct {
	store    *Store
	pipeline *Pipeline
	static   http.Handler
}

func NewServer(store *Store, pipeline *Pipeline) (*Server, error) {
	webRoot, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, err
	}
	return &Server{store: store, pipeline: pipeline, static: http.FileServer(http.FS(webRoot))}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/bootstrap", s.handleBootstrap)
	mux.HandleFunc("/api/organizations", s.handleOrganizations)
	mux.HandleFunc("/api/files", s.handleFiles)
	mux.HandleFunc("/api/files/", s.handleFileByID)
	mux.HandleFunc("/api/contexts", s.handleContexts)
	mux.HandleFunc("/api/contexts/", s.handleContextByID)
	mux.HandleFunc("/api/runs", s.handleRuns)
	mux.HandleFunc("/api/runs/", s.handleRunByID)
	mux.HandleFunc("/api/structural-control-sets", s.handleStructuralControlSets)
	mux.HandleFunc("/api/structural-control-sets/preview", s.handleStructuralControlSetPreview)
	mux.HandleFunc("/api/structural-control-sets/fix", s.handleStructuralControlSetFix)
	mux.HandleFunc("/api/structural-control-sets/disable", s.handleStructuralControlSetDisable)
	mux.HandleFunc("/api/empty-article-bindings", s.handleEmptyArticleBindings)
	mux.HandleFunc("/api/empty-article-bindings/fix", s.handleEmptyArticleBindingFix)
	mux.HandleFunc("/api/empty-article-bindings/disable", s.handleEmptyArticleBindingDisable)
	mux.HandleFunc("/api/article-approvals", s.handleArticleApprovals)
	mux.HandleFunc("/api/article-approvals/validate", s.handleArticleApprovalValidate)
	mux.HandleFunc("/api/article-approvals/fix", s.handleArticleApprovalFix)
	mux.HandleFunc("/api/service-journal", s.handleServiceJournal)
	mux.HandleFunc("/api/service-crash-journal", s.handleServiceCrashJournal)
	mux.HandleFunc("/", s.handleStatic)
	return runtimeJournalMiddleware(securityHeaders(mux))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok", "service": "OPIU_STABLE", "implementation": "NEW_COMPATIBLE_IMPLEMENTATION",
		"rules_service": false, "pipeline": "R005_SERVICE_HANDOFF_R001", "safety": reportOnlySafety(),
	})
}

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	snapshot, err := s.snapshotWithStructuralControlSets()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleContexts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.Snapshot(s.pipeline.Ready()).Contexts)
	case http.MethodPost:
		var request createContextRequest
		if err := readJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "Проверьте организацию, период и выбранные источники"})
			return
		}
		contextValue, err := s.store.CreateContext(request)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, contextValue)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleContextByID(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/contexts/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] != "archive" {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Контекст не найден"})
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	contextValue, err := s.store.ArchiveContext(parts[0])
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Контекст не найден"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось архивировать контекст"})
		return
	}
	writeJSON(w, http.StatusOK, contextValue)
}

func (s *Server) handleRuns(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		snapshot, err := s.snapshotWithStructuralControlSets()
		if err != nil {
			writeStructuralControlError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, snapshot.Runs)
	case http.MethodPost:
		var request createRunRequest
		if err := readJSON(r, &request); err != nil || strings.TrimSpace(request.ContextID) == "" {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "Выберите активный контекст"})
			return
		}
		run, err := s.store.CreateRun(strings.TrimSpace(request.ContextID))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "Активный контекст недоступен"})
			return
		}
		if err := s.pipeline.Start(run); err != nil {
			writeJSON(w, http.StatusConflict, apiError{Error: "Этот запуск уже выполняется"})
			return
		}
		writeJSON(w, http.StatusAccepted, run)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleRunByID(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/runs/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 2 && parts[0] != "" && parts[1] == "diagnostics" {
		s.handleRunDiagnostics(w, r, parts[0])
		return
	}
	if len(parts) == 3 && parts[0] != "" && parts[1] == "result" {
		s.handleRunResult(w, r, parts[0], parts[2])
		return
	}
	if len(parts) == 4 && parts[0] != "" && parts[1] == "result" && parts[3] == "file" {
		s.handleRunResultFile(w, r, parts[0], parts[2])
		return
	}
	if len(parts) != 1 || parts[0] == "" {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	snapshot, err := s.snapshotWithStructuralControlSets()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	for _, run := range snapshot.Runs {
		if run.ID == parts[0] {
			writeJSON(w, http.StatusOK, run)
			return
		}
	}
	if _, ok := s.store.Run(parts[0]); !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_RUN_PROJECTION_MISSING"})
}

func (s *Server) handleServiceJournal(w http.ResponseWriter, r *http.Request) {
	s.serveJournalFile(w, r, false)
}

func (s *Server) handleServiceCrashJournal(w http.ResponseWriter, r *http.Request) {
	s.serveJournalFile(w, r, true)
}

func (s *Server) serveJournalFile(w http.ResponseWriter, r *http.Request, crash bool) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	if serviceJournal == nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Журнал сервиса недоступен"})
		return
	}
	path := serviceJournal.runtimePath
	name := "OPIU_SERVICE_RUNTIME.log"
	if crash {
		path = serviceJournal.crashPath
		name = "OPIU_SERVICE_CRASH.log"
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Журнал пока пуст"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось открыть журнал"})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	http.ServeFile(w, r, path)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Команда не найдена"})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	if r.URL.Path != "/" && !strings.Contains(filepathBase(r.URL.Path), ".") {
		r.URL.Path = "/"
	}
	s.static.ServeHTTP(w, r)
}

func filepathBase(value string) string {
	value = strings.TrimSuffix(value, "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		return value[index+1:]
	}
	return value
}
