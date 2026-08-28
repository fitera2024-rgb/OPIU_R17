package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUI011R005FailureMessageShowsExactSafeStructuralCause(t *testing.T) {
	runDir := t.TempDir()
	logPath := filepath.Join(runDir, "r005.log")
	privatePath := `C:\Users\private\structural-control-settings.json`
	logText := privatePath + "\nError: BLOCKED_STRUCTURAL_CONTROL_SETTINGS_SOURCE_INVALID\n"
	if err := os.WriteFile(logPath, []byte(logText), 0o600); err != nil {
		t.Fatal(err)
	}
	message := r005StageFailureMessage(runDir)
	if message != "R005 отклонил настройку группировки: формат источника не поддерживается" {
		t.Fatalf("unexpected safe R005 message: %q", message)
	}
	if strings.Contains(message, privatePath) || strings.Contains(message, "BLOCKED_") {
		t.Fatalf("technical details leaked into user message: %q", message)
	}
}

func TestUI011R005FailureMessageKeepsUnknownFailureGeneric(t *testing.T) {
	runDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(runDir, "r005.log"), []byte("C:\\private\\engine.mjs: unknown failure"), 0o600); err != nil {
		t.Fatal(err)
	}
	message := r005StageFailureMessage(runDir)
	if message != "Сверка завершилась ошибкой; безопасный отчётный комплект не сформирован" || strings.Contains(message, "private") {
		t.Fatalf("unknown failure was not safely summarized: %q", message)
	}
}

func TestUI011R005FailureMessageRejectsOversizedLog(t *testing.T) {
	runDir := t.TempDir()
	logPath := filepath.Join(runDir, "r005.log")
	file, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate((8 << 20) + 1); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if message := r005StageFailureMessage(runDir); message != "Сверка завершилась ошибкой; безопасный отчётный комплект не сформирован" {
		t.Fatalf("oversized log was trusted: %q", message)
	}
}
