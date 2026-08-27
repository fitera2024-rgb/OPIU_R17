package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type persistedSourceMetadata struct {
	DiskName string `json:"disk_name"`
	SHA256   string `json:"sha256"`
}

type persistedStoreState struct {
	Files                    map[string]SourceFile                       `json:"files"`
	SourceMetadata           map[string]persistedSourceMetadata          `json:"source_metadata,omitempty"`
	Contexts                 map[string]Context                          `json:"contexts"`
	Runs                     map[string]Run                              `json:"runs"`
	StructuralControlAnchors map[string]structuralControlInventoryAnchor `json:"structural_control_anchors,omitempty"`
}

func persistedState(state storeState) persistedStoreState {
	metadata := make(map[string]persistedSourceMetadata, len(state.Files))
	for id, file := range state.Files {
		if file.DiskName == "" || file.SHA256 == "" {
			continue
		}
		metadata[id] = persistedSourceMetadata{
			DiskName: file.DiskName,
			SHA256:   file.SHA256,
		}
	}
	return persistedStoreState{
		Files:                    state.Files,
		SourceMetadata:           metadata,
		Contexts:                 state.Contexts,
		Runs:                     state.Runs,
		StructuralControlAnchors: state.StructuralControlAnchors,
	}
}

func (s *Store) restoreSourceMetadata(metadata map[string]persistedSourceMetadata) bool {
	changed := false
	for id, file := range s.state.Files {
		stored := metadata[id]
		if stored.DiskName != "" {
			if base, err := secureBaseName(stored.DiskName); err == nil && base == stored.DiskName {
				file.DiskName = stored.DiskName
			}
		}
		if validSHA256(stored.SHA256) {
			file.SHA256 = strings.ToUpper(stored.SHA256)
		}

		if file.DiskName == "" {
			file.DiskName = s.findLegacySourceFile(id, file.Size)
			if file.DiskName != "" {
				changed = true
			}
		}
		if file.DiskName != "" && file.SHA256 == "" {
			if digest, err := sha256File(filepath.Join(s.filesDir, file.DiskName)); err == nil {
				file.SHA256 = digest
				changed = true
			}
		}
		s.state.Files[id] = file
	}
	return changed
}

func (s *Store) findLegacySourceFile(id string, expectedSize int64) string {
	if base, err := secureBaseName(id); err != nil || base != id {
		return ""
	}
	entries, err := os.ReadDir(s.filesDir)
	if err != nil {
		return ""
	}
	candidates := make([]string, 0, 1)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), id+".") {
			continue
		}
		if _, err := allowedSourceExtension(entry.Name()); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
			continue
		}
		candidates = append(candidates, entry.Name())
	}
	sort.Strings(candidates)
	if len(candidates) != 1 {
		return ""
	}
	return candidates[0]
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return strings.ToUpper(hex.EncodeToString(digest.Sum(nil))), nil
}
