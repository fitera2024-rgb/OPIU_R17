package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceR001HandoffRejectsPhysicalEvidenceSHA256Drift(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	journalPath := filepath.Join(runDir, "r005", "physical-evidence", "erp-journal.xlsx")
	bytes, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journalPath, append(bytes, 'x'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir); err == nil {
		t.Fatal("handoff accepted persistent ERP journal SHA-256 drift")
	}
}

func TestServiceR001HandoffRejectsScopeDrift(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	tests := []struct {
		name   string
		mutate func(*Run, *Context)
	}{
		{name: "run id", mutate: func(run *Run, _ *Context) { run.ID = "different-run" }},
		{name: "context id", mutate: func(_ *Run, context *Context) { context.ID = "different-context" }},
		{name: "organization", mutate: func(_ *Run, context *Context) { context.OrganizationName = "Другая организация" }},
		{name: "period", mutate: func(_ *Run, context *Context) { context.Period = "2025-11" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			alteredRun, alteredContext := run, contextValue
			test.mutate(&alteredRun, &alteredContext)
			if _, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, alteredRun, alteredContext, runDir); err == nil {
				t.Fatal("handoff accepted scope drift")
			}
		})
	}
}

func TestServiceR001HandoffRejectsWrongWorksheetName(t *testing.T) {
	_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
	rewriteServiceHandoffForTest(t, handoff.Path, func(document *serviceR001Handoff) {
		document.PhysicalEvidence.ERPJournal.Sheet = "Wrong worksheet"
	})
	if _, err := verifyServiceR001Handoff(handoff.Path, mustSHA256File(t, handoff.Path), run, contextValue, runDir); err == nil {
		t.Fatal("handoff accepted an expected worksheet name that is absent")
	}
}

func TestServiceR001HandoffRejectsEvidenceOutsidePersistentRunLocation(t *testing.T) {
	tests := []struct {
		name string
		path func(*testing.T, string, []byte) string
	}{
		{
			name: "temporary workDir",
			path: func(t *testing.T, _ string, bytes []byte) string {
				path := filepath.Join(t.TempDir(), "reconciliation-work", "erp_archives", "journal.xlsx")
				writeTestBytes(t, path, bytes)
				return path
			},
		},
		{
			name: "foreign persistent directory",
			path: func(t *testing.T, _ string, bytes []byte) string {
				path := filepath.Join(t.TempDir(), "foreign-run", "physical-evidence", "erp-journal.xlsx")
				writeTestBytes(t, path, bytes)
				return path
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, run, contextValue, runDir, handoff := buildVerifiedServiceHandoffFixture(t)
			persistentPath := filepath.Join(runDir, "r005", "physical-evidence", "erp-journal.xlsx")
			bytes, err := os.ReadFile(persistentPath)
			if err != nil {
				t.Fatal(err)
			}
			foreignPath := test.path(t, persistentPath, bytes)
			rewriteServiceHandoffForTest(t, handoff.Path, func(document *serviceR001Handoff) {
				document.PhysicalEvidence.ERPJournal.Path = foreignPath
			})
			if _, err := verifyServiceR001Handoff(handoff.Path, mustSHA256File(t, handoff.Path), run, contextValue, runDir); err == nil {
				t.Fatal("handoff accepted evidence outside the expected run-owned persistent location")
			}
		})
	}
}

func rewriteServiceHandoffForTest(t *testing.T, handoffPath string, mutate func(*serviceR001Handoff)) {
	t.Helper()
	data, err := os.ReadFile(handoffPath)
	if err != nil {
		t.Fatal(err)
	}
	var document serviceR001Handoff
	if err := decodeJSONRejectDuplicateKeys(data, &document, true); err != nil {
		t.Fatal(err)
	}
	mutate(&document)
	data, err = json.MarshalIndent(document, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(handoffPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	if err := os.WriteFile(handoffPath+".sha256", []byte(strings.ToUpper(hex.EncodeToString(digest[:]))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustSHA256File(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:]))
}

func writeTestBytes(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
