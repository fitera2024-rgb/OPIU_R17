package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type approval008PublicationFixture struct {
	store  *Store
	scope  articleApprovalScope
	source articleApprovalSource
}

func approval008NewPublicationFixture(t *testing.T) approval008PublicationFixture {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	scope := articleApprovalScope{
		OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	sourceRelative := filepath.ToSlash(filepath.Join("runs", "run_approval008_source", "r005", "reconciliation.xlsx"))
	sourcePath := filepath.Join(store.Root(), filepath.FromSlash(sourceRelative))
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0o700); err != nil {
		t.Fatal(err)
	}
	sourceBytes := []byte("APPROVAL-008 immutable source fixture\n")
	if err := os.WriteFile(sourcePath, sourceBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sourceBytes)
	return approval008PublicationFixture{
		store: store, scope: scope,
		source: articleApprovalSource{XLSX: sourceRelative, SHA256: strings.ToUpper(hex.EncodeToString(digest[:]))},
	}
}

func approval008Publish(t *testing.T, fixture approval008PublicationFixture, version int) string {
	t.Helper()
	row := articleApprovalTestRow("УТВЕРЖДАЮ")
	row.OrganizationID = fixture.scope.OrganizationID
	row.OrganizationName = fixture.scope.OrganizationName
	row.Period = fixture.scope.Period
	row.ScopeKey = articleApprovalScopeKey(fixture.scope, row)
	document := articleApprovalDocument{
		SchemaVersion: articleApprovalSchema, Version: version,
		ApprovalID:        fmt.Sprintf("article_approval_approval008_v%03d", version),
		OrganizationScope: fixture.scope,
		Validity:          articleApprovalValidity{From: fixture.scope.Period, To: fixture.scope.Period},
		Source:            fixture.source,
		Actor:             `HOSTDOMAIN\host-user`,
		FixedAt:           time.Date(2025, 10, version, 12, 0, 0, 0, time.UTC),
		Decisions:         []articleApprovalRow{row},
		Safety:            articleApprovalSafety{Mode: "REPORT_ONLY", DecisionType: "CLASSIFICATION_ONLY"},
	}
	data, digest, err := articleApprovalDocumentBytes(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(articleApprovalDirectory(fixture.store), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(articleApprovalDirectory(fixture.store), fmt.Sprintf("article_registry_%s_v%03d.approved.json", articleApprovalOrganizationSlug(fixture.scope), version))
	if err := createArticleApprovalImmutablePair(path, data, []byte(digest+"  "+filepath.Base(path)+"\n")); err != nil {
		t.Fatal(err)
	}
	return path
}

func approval008WritePublication(t *testing.T, path string, data []byte, refreshSidecar bool) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if !refreshSidecar {
		return
	}
	digest := sha256.Sum256(data)
	sidecar := strings.ToUpper(hex.EncodeToString(digest[:])) + "  " + filepath.Base(path) + "\n"
	if err := os.WriteFile(path+".sha256", []byte(sidecar), 0o600); err != nil {
		t.Fatal(err)
	}
}

func approval008RewriteDocument(t *testing.T, path string, mutate func(*articleApprovalDocument)) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document articleApprovalDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		t.Fatal(err)
	}
	mutate(&document)
	data, _, err = articleApprovalDocumentBytes(document)
	if err != nil {
		t.Fatal(err)
	}
	approval008WritePublication(t, path, data, true)
}

func TestApproval008FallbackGETExposesSHARejectionDiagnostic(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "УТВЕРЖДАЮ"
	for version := 1; version <= 2; version++ {
		status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
		if status != http.StatusCreated {
			t.Fatalf("publish v%03d status=%d body=%s", version, status, raw)
		}
	}

	latestPath := filepath.Join(articleApprovalDirectory(fixture.store), "article_registry_"+articleApprovalOrganizationSlug(fixture.scope)+"_v002.approved.json")
	latestBytes, err := os.ReadFile(latestPath)
	if err != nil {
		t.Fatal(err)
	}
	latestBytes[len(latestBytes)/2] ^= 0x01
	if err := os.WriteFile(latestPath, latestBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	route := "/api/article-approvals?organization_id=ORG-9&organization_name=9%20%D0%A3%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%8E%D1%89%D0%B0%D1%8F%20%D0%BA%D0%BE%D0%BC%D0%BF%D0%B0%D0%BD%D0%B8%D1%8F&period=2025-10"
	status, payload, raw := articleApprovalCall(t, fixture.server, http.MethodGet, route, nil)
	if status != http.StatusOK || payload["status"] != "PASS" {
		t.Fatalf("fallback GET status=%d body=%s", status, raw)
	}
	document := payload["document"].(map[string]any)
	if document["version"] != float64(1) {
		t.Fatalf("selected version=%v body=%s", document["version"], raw)
	}
	diagnostics, ok := payload["diagnostics"].([]any)
	if !ok || len(diagnostics) != 1 {
		t.Fatalf("fallback diagnostic missing: %s", raw)
	}
	diagnostic := diagnostics[0].(map[string]any)
	if diagnostic["code"] != "ARTICLE_APPROVAL_VERSION_REJECTED_FALLBACK" ||
		diagnostic["rejection_code"] != "SHA256_MISMATCH" ||
		diagnostic["rejected_version"] != float64(2) ||
		diagnostic["selected_fallback_version"] != float64(1) ||
		diagnostic["fallback_occurred"] != true {
		t.Fatalf("fallback diagnostic=%#v", diagnostic)
	}
	if diagnostic["rejected_publication"] != filepath.Base(latestPath) ||
		diagnostic["selected_fallback_approval_id"] != document["approval_id"] ||
		diagnostic["organization_id"] != fixture.scope.OrganizationID ||
		diagnostic["organization_name"] != fixture.scope.OrganizationName ||
		diagnostic["organization_hierarchy_path"] != fixture.scope.OrganizationPath ||
		diagnostic["period"] != fixture.scope.Period || strings.Contains(raw, fixture.store.Root()) {
		t.Fatalf("fallback diagnostic identity/scope leaked or drifted: %s", raw)
	}
}

func TestApproval008SelectorFallbackReasonMatrix(t *testing.T) {
	tests := []struct {
		name         string
		rejection    string
		mutateLatest func(*testing.T, string)
	}{
		{
			name: "D1 SHA-invalid", rejection: articleApprovalRejectionSHA256Mismatch,
			mutateLatest: func(t *testing.T, path string) {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				data[len(data)/2] ^= 0x01
				approval008WritePublication(t, path, data, false)
			},
		},
		{
			name: "D2 malformed JSON", rejection: articleApprovalRejectionMalformedJSON,
			mutateLatest: func(t *testing.T, path string) {
				approval008WritePublication(t, path, []byte("{\"schema_version\":"), true)
			},
		},
		{
			name: "D3 missing sidecar", rejection: articleApprovalRejectionSidecarMissing,
			mutateLatest: func(t *testing.T, path string) {
				if err := os.Remove(path + ".sha256"); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "D4 unsafe metadata", rejection: articleApprovalRejectionUnsafeMetadata,
			mutateLatest: func(t *testing.T, path string) {
				approval008RewriteDocument(t, path, func(document *articleApprovalDocument) {
					document.Safety.FinancialRows = 1
				})
			},
		},
		{
			name: "D5 invalid stored-source binding", rejection: articleApprovalRejectionSourceBinding,
			mutateLatest: func(t *testing.T, path string) {
				approval008RewriteDocument(t, path, func(document *articleApprovalDocument) {
					document.Source.XLSX = strings.Replace(document.Source.XLSX, "/r005/", "/r005/../r005/", 1)
				})
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := approval008NewPublicationFixture(t)
			_ = approval008Publish(t, fixture, 1)
			fallbackPath := approval008Publish(t, fixture, 2)
			rejectedPath := approval008Publish(t, fixture, 3)
			fallbackBefore, err := os.ReadFile(fallbackPath)
			if err != nil {
				t.Fatal(err)
			}
			fallbackSidecarBefore, err := os.ReadFile(fallbackPath + ".sha256")
			if err != nil {
				t.Fatal(err)
			}
			test.mutateLatest(t, rejectedPath)

			selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
			if err != nil {
				t.Fatalf("fallback rejected: %v", err)
			}
			if selection.Document.Version != 2 || selection.Path != fallbackPath || len(selection.Diagnostics) != 1 {
				t.Fatalf("selection=%+v", selection)
			}
			diagnostic := selection.Diagnostics[0]
			if diagnostic.Code != articleApprovalFallbackDiagnosticCode || diagnostic.RejectionCode != test.rejection ||
				diagnostic.RejectedPublication != filepath.Base(rejectedPath) || diagnostic.RejectedVersion != 3 ||
				diagnostic.SelectedFallbackApprovalID != selection.Document.ApprovalID || diagnostic.SelectedFallbackVersion != 2 ||
				diagnostic.SelectedFallbackSHA256 != selection.SHA256 || diagnostic.OrganizationID != fixture.scope.OrganizationID ||
				diagnostic.OrganizationName != fixture.scope.OrganizationName || diagnostic.OrganizationPath != fixture.scope.OrganizationPath ||
				diagnostic.Period != fixture.scope.Period || !diagnostic.FallbackOccurred {
				t.Fatalf("diagnostic=%+v", diagnostic)
			}
			diagnosticJSON, err := json.Marshal(diagnostic)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{fixture.store.Root(), `"financial_rows"`, `"posting_rows"`, `"ready_to_upload"`, `"release_allowed"`, `"live_1c_allowed"`} {
				if strings.Contains(string(diagnosticJSON), forbidden) {
					t.Fatalf("diagnostic contains forbidden authority/host data %q: %s", forbidden, diagnosticJSON)
				}
			}
			fallbackAfter, err := os.ReadFile(fallbackPath)
			if err != nil {
				t.Fatal(err)
			}
			fallbackSidecarAfter, err := os.ReadFile(fallbackPath + ".sha256")
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(fallbackBefore, fallbackAfter) || !bytes.Equal(fallbackSidecarBefore, fallbackSidecarAfter) {
				t.Fatal("selector mutated approved fallback history")
			}
		})
	}
}

func TestApproval008SelectorReportsEveryRejectedCandidateInDescendingOrder(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	fallbackPath := approval008Publish(t, fixture, 2)
	missingSidecarPath := approval008Publish(t, fixture, 3)
	invalidDecisionsPath := approval008Publish(t, fixture, 4)
	if err := os.Remove(missingSidecarPath + ".sha256"); err != nil {
		t.Fatal(err)
	}
	approval008RewriteDocument(t, invalidDecisionsPath, func(document *articleApprovalDocument) {
		document.Decisions[0].UserDecision = "ШЕСТОЕ РЕШЕНИЕ"
	})

	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Path != fallbackPath || len(selection.Diagnostics) != 2 {
		t.Fatalf("selection=%+v", selection)
	}
	if selection.Diagnostics[0].RejectedVersion != 4 || selection.Diagnostics[0].RejectionCode != articleApprovalRejectionDecisions ||
		selection.Diagnostics[1].RejectedVersion != 3 || selection.Diagnostics[1].RejectionCode != articleApprovalRejectionSidecarMissing {
		t.Fatalf("diagnostic order=%+v", selection.Diagnostics)
	}
}

func TestApproval008FilenameVersionMismatchFallsBack(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	fallbackPath := approval008Publish(t, fixture, 2)
	rejectedPath := approval008Publish(t, fixture, 3)
	approval008RewriteDocument(t, rejectedPath, func(document *articleApprovalDocument) {
		document.Version = 1
	})

	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Path != fallbackPath || selection.Document.Version != 2 || len(selection.Diagnostics) != 1 {
		t.Fatalf("selection=%+v", selection)
	}
	if selection.Diagnostics[0].RejectedVersion != 3 || selection.Diagnostics[0].RejectionCode != articleApprovalRejectionVersionMismatch {
		t.Fatalf("version mismatch diagnostic=%+v", selection.Diagnostics)
	}
}

func TestApproval008LegacyApprovalIDRemainsValid(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	path := approval008Publish(t, fixture, 1)
	approval008RewriteDocument(t, path, func(document *articleApprovalDocument) {
		document.ApprovalID = "legacy approval 2025"
	})
	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Path != path || selection.Document.ApprovalID != "legacy approval 2025" || len(selection.Diagnostics) != 0 {
		t.Fatalf("legacy approval selection=%+v", selection)
	}
}

func TestApproval008FinalVerificationRejectsPublicationOrSourceDrift(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, approval008PublicationFixture, string)
	}{
		{
			name: "sidecar removed after selection",
			mutate: func(t *testing.T, _ approval008PublicationFixture, path string) {
				if err := os.Remove(path + ".sha256"); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "stored source changed after selection",
			mutate: func(t *testing.T, fixture approval008PublicationFixture, _ string) {
				sourcePath := filepath.Join(fixture.store.Root(), filepath.FromSlash(fixture.source.XLSX))
				if err := os.WriteFile(sourcePath, []byte("changed source\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := approval008NewPublicationFixture(t)
			path := approval008Publish(t, fixture, 1)
			selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
			if err != nil {
				t.Fatal(err)
			}
			test.mutate(t, fixture, path)
			if _, err := articleApprovalVerifiedPublicationBytes(fixture.store, selection, fixture.scope); err == nil {
				t.Fatal("final verification accepted drift after selection")
			}
		})
	}
}

func TestApproval008D6CleanLatestHasNoFallbackDiagnostic(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	_ = approval008Publish(t, fixture, 2)
	latestPath := approval008Publish(t, fixture, 3)
	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Path != latestPath || selection.Document.Version != 3 || len(selection.Diagnostics) != 0 {
		t.Fatalf("clean latest selection=%+v", selection)
	}
}

func TestApproval008D7ValidOtherMonthIsIsolationNotFallback(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	exactPath := approval008Publish(t, fixture, 2)
	otherMonthPath := approval008Publish(t, fixture, 3)
	approval008RewriteDocument(t, otherMonthPath, func(document *articleApprovalDocument) {
		otherScope := document.OrganizationScope
		otherScope.Period = "2025-11"
		document.OrganizationScope = otherScope
		document.Validity = articleApprovalValidity{From: otherScope.Period, To: otherScope.Period}
		for index := range document.Decisions {
			document.Decisions[index].Period = otherScope.Period
			document.Decisions[index].ScopeKey = articleApprovalScopeKey(otherScope, document.Decisions[index])
		}
	})

	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Path != exactPath || selection.Document.Version != 2 || len(selection.Diagnostics) != 0 {
		t.Fatalf("valid other-month became corrupt fallback: %+v", selection)
	}
	contextValue := Context{
		ID: "ctx_approval008_d7", Organization: fixture.scope.OrganizationName,
		OrganizationID: fixture.scope.OrganizationID, OrganizationName: fixture.scope.OrganizationName,
		OrganizationPath: fixture.scope.OrganizationPath, Period: fixture.scope.Period,
	}
	run := Run{ID: "run_approval008_d7", ContextID: contextValue.ID, Safety: reportOnlySafety()}
	runDir := filepath.Join(fixture.store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Pipeline{store: fixture.store}).materializeActiveArticleApprovalSettings(run, contextValue, runDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(articleApprovalDiagnosticArtifactPath(runDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("valid other month emitted fallback artifact: %v", err)
	}
}

func TestApproval008D8InvalidWithoutPreviousValidRemainsFailClosed(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	rejectedPath := approval008Publish(t, fixture, 1)
	data, err := os.ReadFile(rejectedPath)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 0x01
	approval008WritePublication(t, rejectedPath, data, false)

	selection, err := articleApprovalLatestSelection(fixture.store, fixture.scope)
	if err == nil || articleApprovalRejectionCode(err) != articleApprovalRejectionSHA256Mismatch {
		t.Fatalf("invalid only candidate did not fail closed: selection=%+v err=%v", selection, err)
	}
	if selection.Path != "" || selection.Document.Version != 0 || len(selection.Diagnostics) != 0 {
		t.Fatalf("invalid only candidate claimed fallback: %+v", selection)
	}
}

func TestApproval008RunMaterializationRetainsDiagnosticArtifactAndExactSettings(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "УТВЕРЖДАЮ"
	for version := 1; version <= 3; version++ {
		status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
		if status != http.StatusCreated {
			t.Fatalf("publish v%03d status=%d body=%s", version, status, raw)
		}
	}
	slug := articleApprovalOrganizationSlug(fixture.scope)
	fallbackPath := filepath.Join(articleApprovalDirectory(fixture.store), "article_registry_"+slug+"_v002.approved.json")
	rejectedPath := filepath.Join(articleApprovalDirectory(fixture.store), "article_registry_"+slug+"_v003.approved.json")
	fallbackBytes, err := os.ReadFile(fallbackPath)
	if err != nil {
		t.Fatal(err)
	}
	rejectedBytes, err := os.ReadFile(rejectedPath)
	if err != nil {
		t.Fatal(err)
	}
	rejectedBytes[len(rejectedBytes)/2] ^= 0x01
	approval008WritePublication(t, rejectedPath, rejectedBytes, false)

	historyBefore := map[string][]byte{}
	entries, err := os.ReadDir(articleApprovalDirectory(fixture.store))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(articleApprovalDirectory(fixture.store), entry.Name())
		historyBefore[entry.Name()], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
	}

	contextValue, ok := fixture.store.Context(fixture.run.ContextID)
	if !ok {
		t.Fatal("fixture context missing")
	}
	pipeline := &Pipeline{store: fixture.store}
	runDir := filepath.Join(fixture.store.RunsDir(), fixture.run.ID)
	settingsPath, err := pipeline.materializeActiveArticleApprovalSettings(fixture.run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	settingsBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(settingsBytes, fallbackBytes) {
		t.Fatal("materialized fallback settings are not byte-identical to approved v002")
	}

	diagnosticPath := articleApprovalDiagnosticArtifactPath(runDir)
	diagnosticBytes, err := os.ReadFile(diagnosticPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{fixture.store.Root(), `"financial_rows"`, `"posting_rows"`, `"ready_to_upload"`, `"release_allowed"`, `"live_1c_allowed"`} {
		if strings.Contains(string(diagnosticBytes), forbidden) {
			t.Fatalf("diagnostic artifact contains forbidden authority/host data %q: %s", forbidden, diagnosticBytes)
		}
	}
	artifactDiagnostics, err := articleApprovalReadDiagnosticArtifact(runDir, fixture.run, &contextValue)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifactDiagnostics) != 1 || artifactDiagnostics[0].RejectedVersion != 3 ||
		artifactDiagnostics[0].SelectedFallbackVersion != 2 || artifactDiagnostics[0].Period != fixture.scope.Period {
		t.Fatalf("artifact diagnostics=%+v", artifactDiagnostics)
	}

	status, bundle, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/runs/"+fixture.run.ID+"/diagnostics", nil)
	if status != http.StatusOK {
		t.Fatalf("run diagnostics status=%d body=%s", status, raw)
	}
	topLevel, ok := bundle["article_approval_diagnostics"].([]any)
	if !ok || len(topLevel) != 1 {
		t.Fatalf("run diagnostic projection missing: %s", raw)
	}
	foundArtifact := false
	for _, item := range bundle["files"].([]any) {
		file := item.(map[string]any)
		if file["path"] == "r005-input/article-approval-fallback-diagnostics.json" {
			foundArtifact = strings.Contains(file["content"].(string), articleApprovalFallbackDiagnosticCode)
		}
	}
	if !foundArtifact {
		t.Fatalf("durable diagnostic artifact missing from bundle: %s", raw)
	}
	storedRun, ok := fixture.store.Run(fixture.run.ID)
	if !ok || storedRun.Safety.Mode != "REPORT_ONLY" || storedRun.Safety.PostingRows != 0 ||
		storedRun.Safety.ReadyToUpload || storedRun.Safety.ReleaseAllowed || storedRun.Safety.Live1CAllowed {
		t.Fatalf("run safety changed: %+v", storedRun)
	}
	for name, before := range historyBefore {
		after, err := os.ReadFile(filepath.Join(articleApprovalDirectory(fixture.store), name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, after) {
			t.Fatalf("materialization mutated approved history file %s", name)
		}
	}

	diagnosticSidecar := diagnosticPath + ".sha256"
	originalSidecar, err := os.ReadFile(diagnosticSidecar)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(diagnosticSidecar, []byte(strings.Repeat("0", 64)+"  "+filepath.Base(diagnosticPath)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodGet, "/api/runs/"+fixture.run.ID+"/diagnostics", nil)
	if status != http.StatusConflict || !strings.Contains(raw, "ARTICLE_APPROVAL_DIAGNOSTIC_INTEGRITY_INVALID") {
		t.Fatalf("corrupt diagnostic sidecar did not fail closed: status=%d body=%s", status, raw)
	}
	if err := os.WriteFile(diagnosticSidecar, originalSidecar, 0o600); err != nil {
		t.Fatal(err)
	}
	var artifact articleApprovalDiagnosticArtifact
	if err := decodeStrictJSON(diagnosticBytes, &artifact); err != nil {
		t.Fatal(err)
	}
	artifact.RunID = "run_copied_diagnostic"
	forged, err := json.MarshalIndent(artifact, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	forged = append(forged, '\n')
	approval008WritePublication(t, diagnosticPath, forged, true)
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodGet, "/api/runs/"+fixture.run.ID+"/diagnostics", nil)
	if status != http.StatusConflict || !strings.Contains(raw, "ARTICLE_APPROVAL_DIAGNOSTIC_INTEGRITY_INVALID") {
		t.Fatalf("cross-run diagnostic copy did not fail closed: status=%d body=%s", status, raw)
	}
}

func TestApproval008SettingsWriteFailureCannotPublishFallbackDiagnostic(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	rejectedPath := approval008Publish(t, fixture, 2)
	data, err := os.ReadFile(rejectedPath)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 0x01
	approval008WritePublication(t, rejectedPath, data, false)
	contextValue := Context{
		ID: "ctx_approval008_write_failure", Organization: fixture.scope.OrganizationName,
		OrganizationID: fixture.scope.OrganizationID, OrganizationName: fixture.scope.OrganizationName,
		OrganizationPath: fixture.scope.OrganizationPath, Period: fixture.scope.Period,
	}
	run := Run{ID: "run_approval008_write_failure", ContextID: contextValue.ID, Safety: reportOnlySafety()}
	runDir := filepath.Join(fixture.store.RunsDir(), run.ID)
	destination := filepath.Join(runDir, "r005-input", "article-approval-settings.json")
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("occupied\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Pipeline{store: fixture.store}).materializeActiveArticleApprovalSettings(run, contextValue, runDir); err == nil {
		t.Fatal("materialization unexpectedly overwrote an existing settings publication")
	}
	if _, err := os.Lstat(articleApprovalDiagnosticArtifactPath(runDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("diagnostic claimed fallback after settings write failure: %v", err)
	}
	if occupied, err := os.ReadFile(destination); err != nil || string(occupied) != "occupied\n" {
		t.Fatalf("existing settings changed: data=%q err=%v", occupied, err)
	}
}

func TestApproval008CleanMaterializationDoesNotCreateDiagnosticArtifact(t *testing.T) {
	fixture := approval008NewPublicationFixture(t)
	_ = approval008Publish(t, fixture, 1)
	_ = approval008Publish(t, fixture, 2)
	latestPath := approval008Publish(t, fixture, 3)
	latestBytes, err := os.ReadFile(latestPath)
	if err != nil {
		t.Fatal(err)
	}
	contextValue := Context{
		ID: "ctx_approval008_clean", Organization: fixture.scope.OrganizationName,
		OrganizationID: fixture.scope.OrganizationID, OrganizationName: fixture.scope.OrganizationName,
		OrganizationPath: fixture.scope.OrganizationPath, Period: fixture.scope.Period,
	}
	run := Run{ID: "run_approval008_clean", ContextID: contextValue.ID, Safety: reportOnlySafety()}
	runDir := filepath.Join(fixture.store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	settingsPath, err := (&Pipeline{store: fixture.store}).materializeActiveArticleApprovalSettings(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	settingsBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(settingsBytes, latestBytes) {
		t.Fatal("clean latest materialization changed approved bytes")
	}
	if _, err := os.Stat(articleApprovalDiagnosticArtifactPath(runDir)); !os.IsNotExist(err) {
		t.Fatalf("clean latest emitted fallback diagnostic: %v", err)
	}
}
