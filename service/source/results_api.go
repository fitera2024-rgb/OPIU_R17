package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type resultFile struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
	URL  string `json:"url,omitempty"`
}

type runStageResult struct {
	Stage                    string       `json:"stage"`
	Ready                    bool         `json:"ready"`
	VerifiedPackageAvailable bool         `json:"verified_package_available"`
	Files                    []resultFile `json:"files"`
	ArchiveURL               string       `json:"archive_url,omitempty"`
}

type verifiedResultArtifact struct {
	Name   string
	Size   int64
	SHA256 string
	Limit  int64
}

func (s *Server) handleRunResult(w http.ResponseWriter, r *http.Request, runID, stage string) {
	stage = strings.ToLower(stage)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	run, ok := s.store.Run(runID)
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	if stage != "r005" && stage != "r001" {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Результат этапа не найден"})
		return
	}
	root := filepath.Join(s.store.RunsDir(), runID, stage)
	var r005Allowances map[string]verifiedResultArtifact
	if stage == "r005" {
		var allowanceErr error
		r005Allowances, allowanceErr = s.validatedR005ResultAllowances(root, run)
		if allowanceErr != nil {
			writeJSON(w, http.StatusOK, runStageResult{Stage: "R005", Ready: false, Files: []resultFile{}})
			return
		}
	}
	if stage == "r001" {
		contextValue, contextOK := s.store.Context(run.ContextID)
		if !contextOK || validateVisibleReportPackage(root, run, contextValue) != nil {
			if r.URL.Query().Get("archive") == "1" {
				writeJSON(w, http.StatusNotFound, apiError{Error: "Полный проверенный результат R001 ещё не сформирован"})
				return
			}
			writeJSON(w, http.StatusOK, runStageResult{Stage: "R001", Ready: false, Files: []resultFile{}})
			return
		}
	}
	files, err := collectStageResultFiles(root, runID, stage)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, runStageResult{Stage: strings.ToUpper(stage), Ready: false, Files: []resultFile{}})
			return
		}
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось прочитать результат этапа"})
		return
	}
	if stage == "r001" {
		verifiedFiles := make([]resultFile, 0, len(files))
		for _, file := range files {
			if _, err := visibleReportDownloadAllowance(root, file.Name); err == nil {
				verifiedFiles = append(verifiedFiles, file)
			}
		}
		files = verifiedFiles
	} else {
		verifiedFiles := make([]resultFile, 0, len(files))
		for _, file := range files {
			allowance, ok := r005Allowances[file.Name]
			if ok && file.Size == allowance.Size {
				verifiedFiles = append(verifiedFiles, file)
			}
		}
		files = verifiedFiles
	}
	ready := stageResultReady(run, stage, files)

	if r.URL.Query().Get("archive") == "1" {
		if stage != "r001" {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Архив для этого этапа не поддерживается"})
			return
		}
		if !ready {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Полный результат R001 ещё не сформирован"})
			return
		}
		s.writeStageResultArchive(w, root, files)
		return
	}

	archiveURL := ""
	if stage == "r001" && ready {
		archiveURL = "/api/runs/" + runID + "/result/r001?archive=1"
	}
	writeJSON(w, http.StatusOK, runStageResult{
		Stage: strings.ToUpper(stage), Ready: ready,
		VerifiedPackageAvailable: len(files) > 0,
		Files:                    files, ArchiveURL: archiveURL,
	})
}

func stageResultReady(run Run, stage string, files []resultFile) bool {
	if stage != "r001" {
		return len(files) > 0
	}
	if run.Status != RunCompletedReportOnly || run.Stage != "DONE" {
		return false
	}
	manifestReady := false
	decisionsReady := false
	registryReady := false
	for _, file := range files {
		name := strings.ToLower(filepath.ToSlash(file.Name))
		switch file.Kind {
		case "manifest":
			manifestReady = manifestReady || strings.HasSuffix(name, "/manifest.json") || name == "manifest.json"
		case "decisions":
			decisionsReady = strings.HasSuffix(name, ".xlsx")
		case "registry":
			if strings.HasSuffix(name, ".xlsx") {
				registryReady = true
			}
		}
	}
	return manifestReady && decisionsReady && registryReady
}

func (s *Server) writeStageResultArchive(w http.ResponseWriter, root string, files []resultFile) {
	snapshot, cleanup, err := prepareStageResultArchiveSnapshot(root, files)
	if err != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Полный проверенный результат R001 изменился; сформируйте архив повторно"})
		return
	}
	defer cleanup()
	info, err := snapshot.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось подготовить архив результата"})
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\"R001.zip\"")
	http.ServeContent(w, &http.Request{}, "R001.zip", info.ModTime(), snapshot)
}

func prepareStageResultArchiveSnapshot(root string, files []resultFile) (*os.File, func(), error) {
	if err := rejectReparsePathComponents(root); err != nil {
		return nil, nil, err
	}
	snapshot, err := os.CreateTemp(filepath.Dir(root), ".opiu-r001-result-*.zip")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() {
		name := snapshot.Name()
		_ = snapshot.Close()
		_ = os.Remove(name)
	}
	fail := func(err error) (*os.File, func(), error) {
		cleanup()
		return nil, nil, err
	}
	writer := zip.NewWriter(snapshot)

	for _, file := range files {
		allowance, err := visibleReportDownloadAllowance(root, file.Name)
		if err != nil || allowance.Size != file.Size {
			_ = writer.Close()
			return fail(errors.New("R001 archive artifact is no longer verified"))
		}
		path := filepath.Join(root, filepath.FromSlash(file.Name))
		if err := rejectSymlinkTraversal(root, path); err != nil {
			_ = writer.Close()
			return fail(err)
		}
		source, err := os.Open(path)
		if err != nil {
			_ = writer.Close()
			return fail(err)
		}
		info, statErr := source.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != allowance.Size {
			source.Close()
			_ = writer.Close()
			return fail(errors.New("R001 archive artifact size changed"))
		}
		entry, err := writer.Create(filepath.ToSlash(file.Name))
		if err != nil {
			source.Close()
			_ = writer.Close()
			return fail(err)
		}
		digest := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(entry, digest), io.LimitReader(source, allowance.Size+1))
		closeErr := source.Close()
		actualSHA := strings.ToUpper(hex.EncodeToString(digest.Sum(nil)))
		if copyErr != nil || closeErr != nil || written != allowance.Size || !strings.EqualFold(actualSHA, allowance.SHA256) {
			_ = writer.Close()
			return fail(errors.New("R001 archive artifact digest changed"))
		}
	}
	if err := writer.Close(); err != nil {
		return fail(err)
	}
	if err := snapshot.Sync(); err != nil {
		return fail(err)
	}
	if _, err := snapshot.Seek(0, io.SeekStart); err != nil {
		return fail(err)
	}
	return snapshot, cleanup, nil
}

func (s *Server) validatedR005ResultAllowances(root string, run Run) (map[string]verifiedResultArtifact, error) {
	contextValue, ok := s.store.Context(run.ContextID)
	if !ok {
		return nil, errors.New("R005 result context is missing")
	}
	anchor, ok := s.store.StructuralControlInventoryAnchor(run.ID)
	if !ok || !validUpperSHA256(anchor.BindingSHA256) {
		return nil, errors.New("R005 structural inventory anchor is missing")
	}
	bindingSHA, err := validateStructuralControlInventoryForAnchor(root, run, contextValue)
	if err != nil || !strings.EqualFold(bindingSHA, anchor.BindingSHA256) {
		return nil, errors.New("R005 structural inventory anchor is stale")
	}
	bindingBytes, err := readStructuralControlArtifact(root, filepath.Join(root, structuralControlInventoryFile), 1<<20)
	if err != nil {
		return nil, err
	}
	bindingDigest := sha256.Sum256(bindingBytes)
	if !strings.EqualFold(hex.EncodeToString(bindingDigest[:]), anchor.BindingSHA256) {
		return nil, errors.New("R005 structural inventory binding changed")
	}
	binding, err := decodeStructuralControlBinding(bindingBytes)
	if err != nil {
		return nil, err
	}
	artifacts := []struct {
		name       string
		descriptor structuralControlArtifactDescriptor
		limit      int64
	}{
		{"reconciliation.xlsx", binding.Report, 1 << 30},
		{"reconciliation.codex-input.json", binding.CodexInput, 64 << 20},
		{"reconciliation.manifest.json", binding.Manifest, 64 << 20},
	}
	allowances := make(map[string]verifiedResultArtifact, len(artifacts))
	for _, artifact := range artifacts {
		path := filepath.Join(root, artifact.name)
		if !sameFilesystemPath(artifact.descriptor.File, path) || !validUpperSHA256(artifact.descriptor.SHA256) {
			return nil, errors.New("R005 result descriptor is not canonical")
		}
		info, err := os.Lstat(path)
		if err != nil || !isBoundedStructuralControlArtifact(info.Mode(), info.Size(), artifact.limit) {
			return nil, errors.New("R005 result artifact is not a bounded regular file")
		}
		actualSHA, err := sha256StructuralControlArtifact(root, path, artifact.limit)
		if err != nil || !strings.EqualFold(actualSHA, artifact.descriptor.SHA256) {
			return nil, errors.New("R005 result artifact digest changed")
		}
		allowances[artifact.name] = verifiedResultArtifact{
			Name: artifact.name, Size: info.Size(), SHA256: artifact.descriptor.SHA256, Limit: artifact.limit,
		}
	}
	return allowances, nil
}

func collectStageResultFiles(root, runID, stage string) ([]resultFile, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	if err := rejectSymlinkTraversal(root, root); err != nil {
		return nil, err
	}
	wanted := func(rel string, entry fs.DirEntry) bool {
		name := strings.ToLower(entry.Name())
		if stage == "r005" {
			return !entry.IsDir() && (name == "reconciliation.xlsx" || name == "reconciliation.codex-input.json" || name == "reconciliation.manifest.json")
		}
		if entry.IsDir() {
			return false
		}
		lowerRel := strings.ToLower(filepath.ToSlash(rel))
		if strings.HasPrefix(lowerRel, "technical/") || strings.Contains(lowerRel, "/technical/") {
			return true
		}
		if strings.HasSuffix(lowerRel, ".ndjson") {
			return false
		}
		return strings.HasPrefix(name, strings.ToLower("решения_корректировок_ввод_r001")) ||
			name == "manifest.json" || name == "manifest" ||
			strings.Contains(strings.ToLower(rel), strings.ToLower("реестр")) ||
			strings.Contains(strings.ToLower(rel), strings.ToLower("корректировочные файлы спорно")) ||
			strings.Contains(strings.ToLower(rel), strings.ToLower("корректировочные файлы для заг")) ||
			strings.Contains(strings.ToLower(rel), strings.ToLower("файлы для удаления операций"))
	}
	items := []resultFile{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := rejectSymlinkTraversal(root, path); err != nil {
			return err
		}
		if path == root || entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || strings.HasPrefix(rel, "..") {
			return nil
		}
		if !wanted(rel, entry) {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		items = append(items, resultFile{
			Name: filepath.ToSlash(rel),
			Kind: resultKind(stage, rel),
			Size: info.Size(),
			URL:  "/api/runs/" + runID + "/result/" + stage + "/file?path=" + urlQueryEscape(filepath.ToSlash(rel)),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}

func resultKind(stage, rel string) string {
	lower := strings.ToLower(filepath.ToSlash(rel))
	if stage == "r005" {
		switch {
		case strings.HasSuffix(lower, "reconciliation.xlsx"):
			return "reconciliation"
		case strings.HasSuffix(lower, "codex-input.json"):
			return "details"
		case strings.HasSuffix(lower, "manifest.json"):
			return "manifest"
		}
	}
	switch {
	case strings.HasSuffix(lower, "/action-journal.json") || lower == "action-journal.json":
		return "journal"
	case strings.HasSuffix(lower, "/diagnostics.json") || lower == "diagnostics.json":
		return "diagnostics"
	case strings.HasSuffix(lower, "/artifact-registry.json") || lower == "artifact-registry.json":
		return "registry"
	case strings.Contains(lower, strings.ToLower("решения_корректировок_ввод_r001")) && strings.HasSuffix(lower, ".xlsx"):
		return "decisions"
	case strings.Contains(lower, strings.ToLower("реестр")):
		return "registry"
	case strings.Contains(lower, strings.ToLower("корректировочные файлы спорно")):
		return "disputed"
	case strings.Contains(lower, strings.ToLower("корректировочные файлы для заг")):
		return "upload"
	case strings.Contains(lower, strings.ToLower("файлы для удаления операций")):
		return "delete"
	case strings.HasSuffix(lower, "manifest.json") || strings.HasSuffix(lower, "/manifest") || lower == "manifest":
		return "manifest"
	default:
		return "file"
	}
}

func (s *Server) handleRunResultFile(w http.ResponseWriter, r *http.Request, runID, stage string) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	run, ok := s.store.Run(runID)
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	stage = strings.ToLower(stage)
	if stage != "r005" && stage != "r001" {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Результат этапа не найден"})
		return
	}
	rel := filepath.Clean(filepath.FromSlash(strings.TrimSpace(r.URL.Query().Get("path"))))
	if rel == "." || rel == "" || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Некорректный путь результата"})
		return
	}
	root := filepath.Join(s.store.RunsDir(), runID, stage)
	var r001Allowance visibleReportArtifact
	var r005Allowance verifiedResultArtifact
	if stage == "r005" {
		allowances, allowanceErr := s.validatedR005ResultAllowances(root, run)
		var allowed bool
		r005Allowance, allowed = allowances[filepath.ToSlash(rel)]
		if allowanceErr != nil || !allowed {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
			return
		}
	}
	if stage == "r001" {
		contextValue, contextOK := s.store.Context(run.ContextID)
		if !contextOK || validateVisibleReportPackage(root, run, contextValue) != nil {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
			return
		}
		var allowanceErr error
		r001Allowance, allowanceErr = visibleReportDownloadAllowance(root, rel)
		if allowanceErr != nil || validateVisibleReportPackage(root, run, contextValue) != nil {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
			return
		}
	}
	path := filepath.Join(root, rel)
	cleanRoot := filepath.Clean(root) + string(os.PathSeparator)
	cleanPath := filepath.Clean(path)
	if !strings.HasPrefix(cleanPath, cleanRoot) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Некорректный путь результата"})
		return
	}
	if err := rejectSymlinkTraversal(root, cleanPath); err != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
		return
	}
	file, err := os.Open(cleanPath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
		return
	}
	const maximumR001DirectResultBytes int64 = 512 << 20
	maximumDirectResultBytes := maximumR001DirectResultBytes
	if stage == "r005" {
		maximumDirectResultBytes = r005Allowance.Limit
	}
	if (stage == "r001" && info.Size() != r001Allowance.Size) ||
		(stage == "r005" && info.Size() != r005Allowance.Size) || info.Size() > maximumDirectResultBytes {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
		return
	}
	expectedSHA := r001Allowance.SHA256
	if stage == "r005" {
		expectedSHA = r005Allowance.SHA256
	}
	snapshot, cleanup, err := prepareDirectResultSnapshot(file, info.Size(), maximumDirectResultBytes, expectedSHA)
	if err != nil {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл результата не найден"})
		return
	}
	defer cleanup()
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+urlQueryEscape(filepath.Base(cleanPath)))
	http.ServeContent(w, r, filepath.Base(cleanPath), info.ModTime(), snapshot)
}

func prepareDirectResultSnapshot(source *os.File, size, limit int64, expectedSHA string) (*os.File, func(), error) {
	snapshot, err := os.CreateTemp(filepath.Dir(source.Name()), ".opiu-direct-result-*")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() {
		name := snapshot.Name()
		_ = snapshot.Close()
		_ = os.Remove(name)
	}
	fail := func(err error) (*os.File, func(), error) {
		cleanup()
		return nil, nil, err
	}
	digest := sha256.New()
	read, err := io.Copy(io.MultiWriter(snapshot, digest), io.LimitReader(source, limit+1))
	if err != nil || read != size || read > limit || !strings.EqualFold(hex.EncodeToString(digest.Sum(nil)), expectedSHA) {
		return fail(errors.New("direct result artifact changed"))
	}
	if err := snapshot.Sync(); err != nil {
		return fail(err)
	}
	if _, err := snapshot.Seek(0, io.SeekStart); err != nil {
		return fail(err)
	}
	return snapshot, cleanup, nil
}

func urlQueryEscape(value string) string {
	replacer := strings.NewReplacer("%", "%25", " ", "%20", "#", "%23", "?", "%3F", "&", "%26", "+", "%2B")
	return replacer.Replace(value)
}
