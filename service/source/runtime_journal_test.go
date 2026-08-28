package main

import (
	"strings"
	"testing"
)

func TestFatalServiceUserMessageExplainsFailureAndJournal(t *testing.T) {
	message := fatalServiceUserMessage(
		`listen 127.0.0.1:8765: порт занят процессом pid=23636 path="C:\\foreign\\python.exe"`,
		`C:\\data\\logs\\service-runtime.log`,
	)
	for _, expected := range []string{
		"OPIU R17 не запущен",
		"127.0.0.1:8765",
		"pid=23636",
		`C:\\foreign\\python.exe`,
		"Журнал диагностики",
		`C:\\data\\logs\\service-runtime.log`,
		"запустите OPIU повторно",
	} {
		if !strings.Contains(message, expected) {
			t.Fatalf("fatal user message must contain %q: %q", expected, message)
		}
	}
}

func TestFatalServiceUserMessageWorksBeforeJournalInitialization(t *testing.T) {
	message := fatalServiceUserMessage("safety environment is invalid", "")
	if !strings.Contains(message, "safety environment is invalid") {
		t.Fatalf("fatal user message lost the original cause: %q", message)
	}
	if strings.Contains(message, "Журнал диагностики") {
		t.Fatalf("fatal user message must not invent a journal path: %q", message)
	}
}
