package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type approval007Fixture struct {
	server   *Server
	store    *Store
	pipeline *Pipeline
	october  articleApprovalScope
	november articleApprovalScope
	source   articleApprovalSource
}

func newApproval007Fixture(t *testing.T) approval007Fixture {
	t.Helper()
	server, store, pipeline := testServer(t)
	sourcePath := filepath.Join(store.Root(), "approval007-source.xlsx")
	if err := os.WriteFile(sourcePath, []byte("APPROVAL-007 immutable source fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceSHA, err := sha256File(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	source, _, err := articleApprovalResolveSource(store, sourcePath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	october := articleApprovalScope{
		OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
	}
	november := october
	november.Period = "2025-11"
	return approval007Fixture{server: server, store: store, pipeline: pipeline, october: october, november: november, source: source}
}

func approval007Document(scope articleApprovalScope, source articleApprovalSource, version int, approvalID string) articleApprovalDocument {
	row := articleApprovalTestRow("УТВЕРЖДАЮ")
	row.OrganizationID = scope.OrganizationID
	row.OrganizationName = scope.OrganizationName
	row.Period = scope.Period
	rows := articleApprovalCanonicalRows([]articleApprovalRow{row}, scope)
	return articleApprovalDocument{
		SchemaVersion:     articleApprovalSchema,
		Version:           version,
		ApprovalID:        approvalID,
		OrganizationScope: scope,
		Validity:          articleApprovalValidity{From: scope.Period, To: scope.Period},
		Source:            source,
		Actor:             `HOSTDOMAIN\approval007`,
		FixedAt:           time.Date(2026, time.August, 31, version, 0, 0, 0, time.UTC),
		Decisions:         rows,
		Safety: articleApprovalSafety{
			Mode: "REPORT_ONLY", DecisionType: "CLASSIFICATION_ONLY",
		},
	}
}

func approval007Publish(t *testing.T, fixture approval007Fixture, scope articleApprovalScope, version int, approvalID string) (string, string) {
	t.Helper()
	document := approval007Document(scope, fixture.source, version, approvalID)
	data, digest, err := articleApprovalDocumentBytes(document)
	if err != nil {
		t.Fatal(err)
	}
	directory := articleApprovalDirectory(fixture.store)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	fileName := fmt.Sprintf("article_registry_%s_v%03d.approved.json", articleApprovalOrganizationSlug(scope), version)
	filePath := filepath.Join(directory, fileName)
	if err := createArticleApprovalImmutablePair(filePath, data, []byte(digest+"  "+fileName+"\n")); err != nil {
		t.Fatal(err)
	}
	return filePath, digest
}

func approval007Run(t *testing.T, fixture approval007Fixture, period, suffix string) (Run, Context, string) {
	t.Helper()
	erp := addTestSource(t, fixture.store, SourceERP, "approval007-erp-"+suffix+".xlsx")
	intalev := addTestSource(t, fixture.store, SourceIntalev, "approval007-intalev-"+suffix+".xlsx")
	contextValue, err := fixture.store.CreateContext(createContextRequest{
		Organization: "9 Управляющая компания", OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: period,
		ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := fixture.store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	return run, contextValue, filepath.Join(fixture.store.RunsDir(), run.ID)
}

func TestApproval007OtherMonthIsAbsentNotError(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	document, path, err := articleApprovalLatest(fixture.store, fixture.november)
	if err != nil || path != "" || document.Version != 0 {
		t.Fatalf("November discovery must be NONE: document=%+v path=%q err=%v", document, path, err)
	}
}

func TestApproval007ExactMonthStillLoadsLatestIDVersionAndSHA(t *testing.T) {
	fixture := newApproval007Fixture(t)
	firstPath, _ := approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	firstBefore, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	secondPath, secondSHA := approval007Publish(t, fixture, fixture.october, 2, "article_approval_october_v002")
	secondBefore, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	document, path, err := articleApprovalLatest(fixture.store, fixture.october)
	if err != nil {
		t.Fatal(err)
	}
	_, actualSHA, err := articleApprovalReadFile(path)
	if err != nil || document.ApprovalID != "article_approval_october_v002" || document.Version != 2 || actualSHA != secondSHA {
		t.Fatalf("latest October identity mismatch: id=%q version=%d sha=%q want=%q err=%v", document.ApprovalID, document.Version, actualSHA, secondSHA, err)
	}
	firstAfter, _ := os.ReadFile(firstPath)
	secondAfter, _ := os.ReadFile(secondPath)
	if !bytes.Equal(firstBefore, firstAfter) || !bytes.Equal(secondBefore, secondAfter) {
		t.Fatal("immutable October v001/v002 history changed during discovery")
	}
}

func TestApproval007TwoMonthsRemainIsolated(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	approval007Publish(t, fixture, fixture.november, 2, "article_approval_november_v002")
	october, _, octoberErr := articleApprovalLatest(fixture.store, fixture.october)
	november, _, novemberErr := articleApprovalLatest(fixture.store, fixture.november)
	if octoberErr != nil || novemberErr != nil {
		t.Fatalf("two-month discovery errors: October=%v November=%v", octoberErr, novemberErr)
	}
	if october.ApprovalID != "article_approval_october_v001" || october.OrganizationScope.Period != "2025-10" {
		t.Fatalf("October leaked: %+v", october)
	}
	if november.ApprovalID != "article_approval_november_v002" || november.OrganizationScope.Period != "2025-11" {
		t.Fatalf("November leaked: %+v", november)
	}
}

func TestApproval007ExactScopeCorruptionFailsClosed(t *testing.T) {
	fixture := newApproval007Fixture(t)
	path, _ := approval007Publish(t, fixture, fixture.november, 1, "article_approval_november_v001")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 1
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	document, discoveredPath, err := articleApprovalLatest(fixture.store, fixture.november)
	if err == nil || discoveredPath != "" || document.Version != 0 {
		t.Fatalf("corrupt exact-scope approval became NONE/PASS: document=%+v path=%q err=%v", document, discoveredPath, err)
	}
}

func TestApproval007OtherMonthDoesNotMaterializeSettings(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	run, contextValue, runDir := approval007Run(t, fixture, "2025-11", "november-materialize")
	settingsPath, err := fixture.pipeline.materializeActiveArticleApprovalSettings(run, contextValue, runDir)
	if err != nil || settingsPath != "" {
		t.Fatalf("valid October blocked or became November settings: path=%q err=%v", settingsPath, err)
	}
	if hasArticleApprovalSettingsArgument(appendArticleApprovalSettingsArgument([]string{"r005"}, settingsPath)) {
		t.Fatal("November command received --article-approval-settings")
	}
}

func TestApproval007SameStoreOctoberThenNovemberPassesR005Settings(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	octoberRun, octoberContext, octoberRunDir := approval007Run(t, fixture, "2025-10", "pipeline-october")
	octoberSettings, err := fixture.pipeline.materializeActiveArticleApprovalSettings(octoberRun, octoberContext, octoberRunDir)
	if err != nil || octoberSettings == "" {
		t.Fatalf("October R005_SETTINGS did not consume exact approval: path=%q err=%v", octoberSettings, err)
	}
	novemberRun, novemberContext, novemberRunDir := approval007Run(t, fixture, "2025-11", "pipeline-november")
	novemberSettings, err := fixture.pipeline.materializeActiveArticleApprovalSettings(novemberRun, novemberContext, novemberRunDir)
	if err != nil || novemberSettings != "" {
		t.Fatalf("same-store November did not pass R005_SETTINGS without October approval: path=%q err=%v", novemberSettings, err)
	}
}

func TestApproval007NextOctoberRunConsumesLatestExactApproval(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	latestPath, _ := approval007Publish(t, fixture, fixture.october, 2, "article_approval_october_v002")
	latestBytes, err := os.ReadFile(latestPath)
	if err != nil {
		t.Fatal(err)
	}
	novemberRun, novemberContext, novemberRunDir := approval007Run(t, fixture, "2025-11", "between-octobers")
	if path, err := fixture.pipeline.materializeActiveArticleApprovalSettings(novemberRun, novemberContext, novemberRunDir); err != nil || path != "" {
		t.Fatalf("intermediate November settings: path=%q err=%v", path, err)
	}
	octoberRun, octoberContext, octoberRunDir := approval007Run(t, fixture, "2025-10", "next-october")
	settingsPath, err := fixture.pipeline.materializeActiveArticleApprovalSettings(octoberRun, octoberContext, octoberRunDir)
	if err != nil || settingsPath == "" {
		t.Fatalf("next October settings: path=%q err=%v", settingsPath, err)
	}
	settingsBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(settingsBytes, latestBytes) {
		t.Fatal("next October did not consume byte-identical latest October approved document")
	}
}

func TestApproval007APIExactNovemberReturnsNoneWhenOnlyOctoberExists(t *testing.T) {
	fixture := newApproval007Fixture(t)
	approval007Publish(t, fixture, fixture.october, 1, "article_approval_october_v001")
	route := "/api/article-approvals?organization_id=ORG-9&organization_name=" + url.QueryEscape(fixture.november.OrganizationName) +
		"&organization_path=" + url.QueryEscape(fixture.november.OrganizationPath) + "&period=2025-11"
	status, payload, raw := articleApprovalCall(t, fixture.server, http.MethodGet, route, nil)
	if status != http.StatusOK || payload["status"] != "NONE" {
		t.Fatalf("November API must return NONE, not conflict/VERSION_REJECTED: status=%d body=%s", status, raw)
	}
}
