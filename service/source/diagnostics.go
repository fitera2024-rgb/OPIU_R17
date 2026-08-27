package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const diagnosticFileLimit = int64(256 * 1024)
const diagnosticTotalLimit = int64(1024 * 1024)

type diagnosticFile struct {
	Path string `json:"path"`
	Size int64 `json:"size"`
	Content string `json:"content,omitempty"`
	Omitted string `json:"omitted,omitempty"`
}

type diagnosticBundle struct {
	SchemaVersion string `json:"schema_version"`
	GeneratedAt time.Time `json:"generated_at"`
	Service string `json:"service"`
	Run Run `json:"run"`
	Context *Context `json:"context,omitempty"`
	Safety SafetyState `json:"safety"`
	Files []diagnosticFile `json:"files"`
}

func (s *Server) handleRunDiagnostics(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	run, ok := s.store.Run(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	bundle := diagnosticBundle{SchemaVersion: "opiu-stable-diagnostics.v1", GeneratedAt: time.Now().UTC(), Service: "OPIU_STABLE 1.9.4", Run: run, Safety: reportOnlySafety()}
	if contextValue, exists := s.store.Context(run.ContextID); exists { bundle.Context = &contextValue }
	bundle.Files = collectDiagnosticFiles(filepath.Join(s.store.RunsDir(), id))
	data, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось сформировать диагностику"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="OPIU_DIAGNOSTICS_%s.json"`, id))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func collectDiagnosticFiles(root string) []diagnosticFile {
	var paths []string
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() { return nil }
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext == ".log" || ext == ".json" || ext == ".txt" || ext == ".ndjson" { paths = append(paths, path) }
		return nil
	})
	sort.Strings(paths)
	result := make([]diagnosticFile, 0, len(paths))
	var total int64
	for _, path := range paths {
		info, err := os.Stat(path); if err != nil { continue }
		rel, err := filepath.Rel(root, path); if err != nil { rel = filepath.Base(path) }
		item := diagnosticFile{Path: filepath.ToSlash(rel), Size: info.Size()}
		if info.Size() > diagnosticFileLimit { item.Omitted = "file_too_large"; result = append(result, item); continue }
		if total + info.Size() > diagnosticTotalLimit { item.Omitted = "bundle_limit_reached"; result = append(result, item); continue }
		data, err := os.ReadFile(path); if err != nil { item.Omitted = "read_error"; result = append(result, item); continue }
		item.Content = string(data); total += int64(len(data)); result = append(result, item)
	}
	return result
}
