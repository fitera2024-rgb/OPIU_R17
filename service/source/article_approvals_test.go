package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func articleApprovalTestRow(decision string) articleApprovalRow {
	return articleApprovalRow{
		ScopeKey: "client-controlled", OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		Period: "2025-01", BlockIntalev: "Commercial", PathIntalev: "OPIU / Commercial / Advertising",
		ArticleIntalev: "Advertising", ProposedBlockERP: "Commercial", ProposedArticleERP: "Advertising",
		ProposedCodeERP: "ERP-10", Action: "CLASSIFICATION", UserDecision: decision,
	}
}

func articleApprovalWriteTestXLSX(t *testing.T, store *Store, rows []articleApprovalRow) (string, string) {
	t.Helper()
	path := filepath.Join(store.Root(), "runs", "s04-source", "reconciliation.xlsx")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	write := func(name, value string) {
		t.Helper()
		entry, createErr := archive.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(value)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	write("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="01_Правила" sheetId="1" r:id="rId1"/><sheet name="04_ERP_статьи" sheetId="2" r:id="rId2"/></sheets></workbook>`)
	write("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)
	header := []string{"ПредлагаемыйБлокERP", "ПредлагаемаяСтатьяERP", "КодСтатьиERP"}
	cell := func(reference, value string) string {
		return fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, reference, value)
	}
	sheet := `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="5">`
	for index, value := range header {
		sheet += cell(fmt.Sprintf("%c5", 'A'+index), value)
	}
	sheet += `</row>`
	for index, row := range rows {
		line := index + 6
		sheet += fmt.Sprintf(`<row r="%d">`, line)
		sheet += cell(fmt.Sprintf("A%d", line), row.ProposedBlockERP)
		sheet += cell(fmt.Sprintf("B%d", line), row.ProposedArticleERP)
		sheet += cell(fmt.Sprintf("C%d", line), row.ProposedCodeERP)
		sheet += `</row>`
	}
	sheet += `</sheetData></worksheet>`
	write("xl/worksheets/sheet1.xml", sheet)
	erpSheet := `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="4">`
	erpSheet += cell("A4", "Статья ERP") + cell("B4", "Код статьи") + cell("C4", "Статус справочника") + `</row>`
	for index, row := range rows {
		line := index + 5
		erpSheet += fmt.Sprintf(`<row r="%d">`, line)
		erpSheet += cell(fmt.Sprintf("A%d", line), row.ProposedArticleERP)
		erpSheet += cell(fmt.Sprintf("B%d", line), row.ProposedCodeERP)
		erpSheet += cell(fmt.Sprintf("C%d", line), "MATCHED")
		erpSheet += `</row>`
	}
	erpSheet += `</sheetData></worksheet>`
	write("xl/worksheets/sheet2.xml", erpSheet)
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return path, strings.ToUpper(hex.EncodeToString(digest[:]))
}

func articleApprovalTestRequest(t *testing.T, store *Store, rows []articleApprovalRow) articleApprovalRequest {
	t.Helper()
	t.Setenv("USERDOMAIN", "HOSTDOMAIN")
	t.Setenv("USERNAME", "host-user")
	sourcePath, sourceSHA := articleApprovalWriteTestXLSX(t, store, rows)
	return articleApprovalRequest{
		OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period: "2025-01", SourceXLSX: sourcePath, SourceSHA256: sourceSHA,
		Actor: `CLIENT\spoofed`, User: `CLIENT\spoofed-too`, Decisions: rows,
		ERPCatalog: []articleApprovalCatalogItem{{Code: "ERP-10", Block: "Commercial", Article: "Advertising"}},
	}
}

func articleApprovalCall(t *testing.T, server *Server, method, route string, value any) (int, map[string]any, string) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(method, route, bytes.NewReader(body)))
	result := map[string]any{}
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode response: %v: %s", err, recorder.Body.String())
		}
	}
	return recorder.Code, result, recorder.Body.String()
}

func TestS04A18ArticleApprovalAPIRejectsSixthDecisionAndMissingChangeFields(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("SIXTH")})
	status, payload, _ := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("invalid decision status=%d payload=%#v", status, payload)
	}
	request = articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("ИЗМЕНИТЬ")})
	status, payload, _ = articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("incomplete change status=%d payload=%#v", status, payload)
	}
}

func TestS04A19ArticleApprovalAPIReportsScopeCodeAndConflictErrors(t *testing.T) {
	server, store, _ := testServer(t)
	first := articleApprovalTestRow("УТВЕРЖДАЮ")
	second := articleApprovalTestRow("УТВЕРЖДАЮ")
	second.ProposedCodeERP, second.ProposedArticleERP = "ERP-11", "Other"
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{first, second})
	request.ERPCatalog = append(request.ERPCatalog, articleApprovalCatalogItem{Code: "ERP-11", Block: "Commercial", Article: "Other"})
	request.Decisions[0].OrganizationName = "Foreign"
	status, payload, _ := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("validation status=%d payload=%#v", status, payload)
	}
	raw, _ := json.Marshal(payload["errors"])
	if !strings.Contains(string(raw), "ORGANIZATION_SCOPE_MISMATCH") || !strings.Contains(string(raw), "CONFLICTING_TARGETS") {
		t.Fatalf("missing row diagnostics: %s", raw)
	}
	request = articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	request.Decisions[0].ProposedCodeERP = "UNKNOWN"
	status, payload, _ = articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("unknown code status=%d payload=%#v", status, payload)
	}
}

func TestS04A20ArticleApprovalVersionsAreImmutableAndHaveSeparateSHA(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	status, _, _ := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v001 status=%d", status)
	}
	scope := articleApprovalScopeFromRequest(request)
	first, firstPath, err := articleApprovalLatest(store, scope)
	if err != nil || first.Version != 1 {
		t.Fatalf("v001 load=%+v path=%s err=%v", first, firstPath, err)
	}
	firstBytes, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	request.Decisions[0].UserDecision = "ЗАПРЕТИТЬ"
	status, _, _ = articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v002 status=%d", status)
	}
	if actual, _ := os.ReadFile(firstPath); !bytes.Equal(actual, firstBytes) {
		t.Fatal("v001 was overwritten")
	}
	secondPath := filepath.Join(store.Root(), "user-settings", "approvals", fmt.Sprintf("article_registry_%s_v002.approved.json", articleApprovalOrganizationSlug(scope)))
	if _, err := os.Stat(secondPath + ".sha256"); err != nil {
		t.Fatalf("v002 SHA sidecar: %v", err)
	}
}

func TestS04A21ArticleApprovalLatestUsesExactScopeAndFallsBackFromDamagedSHA(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	status, _, _ := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v001 status=%d", status)
	}
	request.Decisions[0].UserDecision = "ЗАПРЕТИТЬ"
	status, _, _ = articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v002 status=%d", status)
	}
	secondPath := filepath.Join(store.Root(), "user-settings", "approvals", fmt.Sprintf("article_registry_%s_v002.approved.json", articleApprovalOrganizationSlug(articleApprovalScopeFromRequest(request))))
	if err := os.WriteFile(secondPath+".sha256", []byte(strings.Repeat("0", 64)+"  broken\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	document, selectedPath, err := articleApprovalLatest(store, articleApprovalScopeFromRequest(request))
	if err != nil || document.Version != 1 || !strings.HasSuffix(selectedPath, "v001.approved.json") {
		t.Fatalf("fallback document=%+v path=%s err=%v", document, selectedPath, err)
	}
	foreign := articleApprovalScopeFromRequest(request)
	foreign.OrganizationName = "Foreign"
	if _, path, err := articleApprovalLatest(store, foreign); err != nil || path != "" {
		t.Fatalf("foreign scope selected document: path=%s err=%v", path, err)
	}
}

func TestS04A22ArticleApprovalAPIPreservesReportOnlyFinancialBarrier(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	status, payload, raw := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", status, raw)
	}
	encoded, _ := json.Marshal(payload)
	if strings.Contains(string(encoded), `"posting_rows":1`) || strings.Contains(string(encoded), `"ready_to_upload":true`) {
		t.Fatalf("financial authority opened: %s", encoded)
	}
}

func TestS04A19ServerOwnsActorCatalogScopeMetadataAndScopeKey(t *testing.T) {
	server, store, _ := testServer(t)
	originalActor := articleApprovalHostActor
	articleApprovalHostActor = func() (string, error) { return `HOSTDOMAIN\host-user`, nil }
	t.Cleanup(func() { articleApprovalHostActor = originalActor })
	row := articleApprovalTestRow("УТВЕРЖДАЮ")
	row.ScopeKey = "attacker|selected|key"
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{row})
	request.OrganizationName = ""
	request.OrganizationPath = ""
	request.Actor = `CLIENT\administrator`
	request.User = `CLIENT\administrator`
	request.ERPCatalog = []articleApprovalCatalogItem{{Code: "ERP-10", Block: "Forged", Article: "Forged"}}
	status, _, raw := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", status, raw)
	}
	scope, err := articleApprovalResolveScope(store, request)
	if err != nil {
		t.Fatal(err)
	}
	document, _, err := articleApprovalLatest(store, scope)
	if err != nil {
		t.Fatal(err)
	}
	if document.Actor != `HOSTDOMAIN\host-user` || document.OrganizationScope.OrganizationName != "9 Управляющая компания" || document.OrganizationScope.OrganizationPath != "Холдинг / 9 Управляющая компания" {
		t.Fatalf("client metadata survived: actor=%q scope=%+v", document.Actor, document.OrganizationScope)
	}
	if len(document.Decisions) != 1 || document.Decisions[0].ScopeKey != articleApprovalScopeKey(scope, row) || document.Decisions[0].ScopeKey == row.ScopeKey {
		t.Fatalf("scope key was not server-owned: %+v", document.Decisions)
	}
}

func TestS04A19RecomputedScopeKeyCannotHideConflict(t *testing.T) {
	server, store, _ := testServer(t)
	first := articleApprovalTestRow("УТВЕРЖДАЮ")
	first.ScopeKey = "client-key-one"
	second := articleApprovalTestRow("УТВЕРЖДАЮ")
	second.ScopeKey = "client-key-two"
	second.ProposedCodeERP = "ERP-11"
	second.ProposedArticleERP = "Other"
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{first, second})
	status, payload, raw := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	encoded, _ := json.Marshal(payload["errors"])
	if status != http.StatusBadRequest || !strings.Contains(string(encoded), "CONFLICTING_TARGETS") {
		t.Fatalf("client scope keys hid conflict: status=%d body=%s", status, raw)
	}
}

func TestS04A19SourceXLSXMustExistInsideStoreAndMatchServerSHA(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	request.SourceXLSX = filepath.Join(store.Root(), "missing.xlsx")
	status, _, raw := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_SOURCE_XLSX_MISSING") {
		t.Fatalf("missing source accepted: status=%d body=%s", status, raw)
	}
	request = articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	request.SourceSHA256 = strings.Repeat("0", 64)
	status, _, raw = articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH") {
		t.Fatalf("mismatched source SHA accepted: status=%d body=%s", status, raw)
	}
}

func TestS04A21ApprovedDocumentRejectsMissingReportOnlySafetyKey(t *testing.T) {
	server, store, _ := testServer(t)
	request := articleApprovalTestRequest(t, store, []articleApprovalRow{articleApprovalTestRow("УТВЕРЖДАЮ")})
	status, _, raw := articleApprovalCall(t, server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", status, raw)
	}
	scope := articleApprovalScopeFromRequest(request)
	_, approvedPath, err := articleApprovalLatest(store, scope)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(approvedPath)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	safety := payload["safety"].(map[string]any)
	delete(safety, "release_allowed")
	damaged, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	damaged = append(damaged, '\n')
	if err := os.WriteFile(approvedPath, damaged, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(damaged)
	if err := os.WriteFile(approvedPath+".sha256", []byte(strings.ToUpper(hex.EncodeToString(digest[:]))+"  "+filepath.Base(approvedPath)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := articleApprovalLatest(store, scope); err == nil || !strings.Contains(err.Error(), "safety metadata is not exact") {
		t.Fatalf("missing false safety key accepted: %v", err)
	}
}
