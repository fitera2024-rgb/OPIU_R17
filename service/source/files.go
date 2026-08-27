package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxSourceBytes int64 = 256 << 20

func parseSourceKind(value string) (SourceKind, error) {
	switch SourceKind(strings.ToLower(strings.TrimSpace(value))) {
	case SourceERP:
		return SourceERP, nil
	case SourceIntalev:
		return SourceIntalev, nil
	default:
		return "", errors.New("kind must be erp or intalev")
	}
}

func allowedSourceExtension(name string) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".xlsx", ".xls", ".zip":
		return ext, nil
	default:
		return "", errors.New("only XLSX, XLS, or ZIP source packages are allowed")
	}
}

func copyUploadedFile(source multipart.File, destination string) (int64, string, error) {
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(source, maxSourceBytes+1))
	if err != nil {
		return 0, "", err
	}
	if written > maxSourceBytes {
		return 0, "", errors.New("source package is larger than 256 MB")
	}
	if err := file.Sync(); err != nil {
		return 0, "", err
	}
	return written, strings.ToUpper(hex.EncodeToString(hash.Sum(nil))), nil
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.Snapshot(s.pipeline.Ready()).Files)
	case http.MethodPost:
		s.handleFileUpload(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	kind, err := parseSourceKind(r.URL.Query().Get("kind"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Выберите тип источника: ERP или Инталев"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSourceBytes+(2<<20))
	if err := r.ParseMultipartForm(maxSourceBytes + (1 << 20)); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Не удалось прочитать файл"})
		return
	}
	source, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Файл не выбран"})
		return
	}
	defer source.Close()
	name, err := secureBaseName(header.Filename)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Недопустимое имя файла"})
		return
	}
	ext, err := allowedSourceExtension(name)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Поддерживаются XLSX, XLS и ZIP"})
		return
	}
	id, err := newOpaqueID("src")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось создать идентификатор"})
		return
	}
	diskName := id + ext
	destination := filepath.Join(s.store.FilesDir(), diskName)
	size, digest, err := copyUploadedFile(source, destination)
	if err != nil {
		_ = os.Remove(destination)
		writeJSON(w, http.StatusBadRequest, apiError{Error: "Не удалось сохранить файл"})
		return
	}
	metadata := SourceFile{
		ID:        id,
		Name:      name,
		Kind:      kind,
		Size:      size,
		CreatedAt: time.Now().UTC(),
		DiskName:  diskName,
		SHA256:    digest,
	}
	if err := s.store.PutFile(metadata); err != nil {
		_ = os.Remove(destination)
		writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось зарегистрировать файл"})
		return
	}
	writeJSON(w, http.StatusCreated, metadata)
}

func (s *Server) handleFileByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/files/")
	if id == "" || strings.Contains(id, "/") {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Файл не найден"})
		return
	}
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", "DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	if err := s.store.DeleteFile(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, apiError{Error: "Файл не найден"})
			return
		}
		writeJSON(w, http.StatusConflict, apiError{Error: "Файл используется активным контекстом"})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func sourcePath(store *Store, id string, kind SourceKind) (string, SourceFile, error) {
	file, ok := store.File(id)
	if !ok || file.Kind != kind {
		return "", SourceFile{}, fmt.Errorf("%s source is unavailable", kind)
	}
	path, err := store.FilePath(file)
	if err != nil {
		return "", SourceFile{}, err
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", SourceFile{}, fmt.Errorf("%s source is unavailable", kind)
	}
	return path, file, nil
}
