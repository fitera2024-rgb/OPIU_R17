package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type articleApprovalQueueFixture struct {
	server *Server
	store  *Store
	run    Run
	scope  articleApprovalScope
	queue  articleApprovalQueue
	report string
}

func articleApprovalTestRow(decision string) articleApprovalRow {
	return articleApprovalRow{
		OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания", Period: "2025-10",
		BlockIntalev: "Commercial", PathIntalev: "OPIU / Commercial / Advertising", ArticleIntalev: "Advertising",
		IncomeExpenseAccount: "44", SettlementAccount: "60", ProposedBlockERP: "Commercial",
		ProposedArticleERP: "Advertising", ProposedCodeERP: "ERP-10", Action: "CLASSIFICATION",
		SelectionReason: "single authoritative target", Confidence: "HIGH", PhysicalExamples: "doc-1 / row-7",
		UserDecision: decision,
	}
}

func articleApprovalXMLText(t *testing.T, value string) string {
	t.Helper()
	var result bytes.Buffer
	if err := xml.EscapeText(&result, []byte(value)); err != nil {
		t.Fatal(err)
	}
	return result.String()
}

func articleApprovalWriteTestXLSX(t *testing.T, path string, rows []articleApprovalRow, catalog []articleApprovalCatalogItem, columns []string) {
	t.Helper()
	if columns == nil {
		columns = articleApprovalRuleColumns
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	write := func(name, value string) {
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
	cell := func(reference, value string) string {
		return fmt.Sprintf(`<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, reference, articleApprovalXMLText(t, value))
	}
	columnName := func(index int) string {
		index++
		name := ""
		for index > 0 {
			index--
			name = string(rune('A'+index%26)) + name
			index /= 26
		}
		return name
	}
	ruleSheet := `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="5">`
	for index, value := range columns {
		ruleSheet += cell(columnName(index)+"5", value)
	}
	ruleSheet += `</row>`
	for index, row := range rows {
		line := index + 6
		values := []string{
			row.ScopeKey, row.OrganizationID, row.OrganizationName, row.Period, row.BlockIntalev, row.PathIntalev,
			row.ArticleIntalev, row.IncomeExpenseAccount, row.SettlementAccount, row.ProposedBlockERP,
			row.ProposedArticleERP, row.ProposedCodeERP, row.Action, row.SelectionReason, row.Confidence,
			row.PhysicalExamples, row.UserDecision, row.CorrectBlockERP, row.CorrectArticleERP, row.CorrectCodeERP, row.UserComment,
		}
		ruleSheet += fmt.Sprintf(`<row r="%d">`, line)
		for column, value := range values {
			ruleSheet += cell(fmt.Sprintf("%s%d", columnName(column), line), value)
		}
		ruleSheet += `</row>`
	}
	ruleSheet += `</sheetData></worksheet>`
	write("xl/worksheets/sheet1.xml", ruleSheet)
	erpSheet := `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="4">`
	for index, header := range []string{"Статья ERP", "Код статьи", "Статус справочника", "Путь по справочнику ERP", "Полный путь ERP"} {
		erpSheet += cell(columnName(index)+"4", header)
	}
	erpSheet += `</row>`
	for index, item := range catalog {
		line := index + 5
		path := "ОПИУ ERP / " + item.Block + " / " + item.Article
		erpSheet += fmt.Sprintf(`<row r="%d">`, line)
		for column, value := range []string{item.Article, item.Code, "MATCHED", path, path} {
			erpSheet += cell(fmt.Sprintf("%s%d", columnName(column), line), value)
		}
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
}

func articleApprovalReadMap(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]any{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func articleApprovalFixtureSHA(t *testing.T, path string) string {
	t.Helper()
	value, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func articleApprovalRebindR005Fixture(t *testing.T, store *Store, run Run) string {
	t.Helper()
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	reportPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)
	reportSHA := articleApprovalFixtureSHA(t, reportPath)
	codex := articleApprovalReadMap(t, codexPath)
	codex["output_sha256"] = reportSHA
	if err := atomicWriteJSON(codexPath, codex); err != nil {
		t.Fatal(err)
	}
	codexSHA := articleApprovalFixtureSHA(t, codexPath)
	manifest := articleApprovalReadMap(t, manifestPath)
	manifest["output_sha256"] = reportSHA
	manifest["codex_input_sha256"] = codexSHA
	if err := atomicWriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	manifestSHA := articleApprovalFixtureSHA(t, manifestPath)
	inventory := articleApprovalReadMap(t, inventoryPath)
	currentRun := inventory["current_run_provenance"].(map[string]any)
	currentRun["report"].(map[string]any)["sha256"] = reportSHA
	currentRun["codex_input"].(map[string]any)["sha256"] = codexSHA
	currentRun["manifest"].(map[string]any)["sha256"] = manifestSHA
	if err := atomicWriteJSON(inventoryPath, inventory); err != nil {
		t.Fatal(err)
	}
	inventorySHA := articleApprovalFixtureSHA(t, inventoryPath)
	provenanceSHA, err := canonicalJSONSHA256(currentRun)
	if err != nil {
		t.Fatal(err)
	}
	binding := articleApprovalReadMap(t, bindingPath)
	binding["report"].(map[string]any)["sha256"] = reportSHA
	binding["codex_input"].(map[string]any)["sha256"] = codexSHA
	binding["manifest"].(map[string]any)["sha256"] = manifestSHA
	binding["sha256"] = inventorySHA
	binding["current_run_provenance_sha256"] = provenanceSHA
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
	return articleApprovalFixtureSHA(t, bindingPath)
}

func articleApprovalNewBoundFixture(t *testing.T, rows []articleApprovalRow, catalog []articleApprovalCatalogItem, columns []string) articleApprovalQueueFixture {
	t.Helper()
	originalActor := articleApprovalHostActor
	articleApprovalHostActor = func() (string, error) { return `HOSTDOMAIN\host-user`, nil }
	t.Cleanup(func() { articleApprovalHostActor = originalActor })
	server, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization: "9 Управляющая компания", OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	finishedAt := time.Now().UTC()
	run.Status, run.Stage, run.FinishedAt = RunCompletedReportOnly, "DONE", &finishedAt
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	_ = writePipelineStructuralInventoryV3(t, store, run, contextValue)
	scope := articleApprovalScopeFromContext(contextValue)
	for index := range rows {
		if rows[index].OrganizationID == "" {
			rows[index].OrganizationID = scope.OrganizationID
		}
		if rows[index].OrganizationName == "" {
			rows[index].OrganizationName = scope.OrganizationName
		}
		if rows[index].Period == "" {
			rows[index].Period = scope.Period
		}
		if rows[index].ScopeKey == "" {
			rows[index].ScopeKey = articleApprovalScopeKey(scope, rows[index])
		}
	}
	report := filepath.Join(store.RunsDir(), run.ID, "r005", "reconciliation.xlsx")
	articleApprovalWriteTestXLSX(t, report, rows, catalog, columns)
	bindingSHA := articleApprovalRebindR005Fixture(t, store, run)
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	return articleApprovalQueueFixture{server: server, store: store, run: run, scope: scope, report: report}
}

func articleApprovalNewQueueFixture(t *testing.T, rows []articleApprovalRow, catalog []articleApprovalCatalogItem, columns []string) articleApprovalQueueFixture {
	t.Helper()
	fixture := articleApprovalNewBoundFixture(t, rows, catalog, columns)
	queue, err := fixture.server.prepareArticleApprovalQueue(fixture.run.ID)
	if err != nil {
		t.Fatalf("prepare queue: %v", err)
	}
	fixture.queue = queue
	return fixture
}

func articleApprovalDefaultCatalog(rows []articleApprovalRow) []articleApprovalCatalogItem {
	result := make([]articleApprovalCatalogItem, 0, len(rows))
	for _, row := range rows {
		result = append(result, articleApprovalCatalogItem{Code: row.ProposedCodeERP, Block: row.ProposedBlockERP, Article: row.ProposedArticleERP})
	}
	return result
}

func articleApprovalQueueRequestFor(queue articleApprovalQueue) articleApprovalQueueRequest {
	request := articleApprovalQueueRequest{RunID: queue.RunID, Revision: queue.QueueRevision, Decisions: make([]articleApprovalQueueDecision, len(queue.Rows))}
	for index, row := range queue.Rows {
		request.Decisions[index] = articleApprovalQueueDecision{
			RowID: row.RowID, UserDecision: row.UserDecision, CorrectBlockERP: row.CorrectBlockERP,
			CorrectArticleERP: row.CorrectArticleERP, CorrectCodeERP: row.CorrectCodeERP, UserComment: row.UserComment,
		}
	}
	return request
}

func articleApprovalCall(t *testing.T, server *Server, method, route string, value any) (int, map[string]any, string) {
	t.Helper()
	var body []byte
	if value != nil {
		var err error
		body, err = json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
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

func TestApproval002GETBuildsSafeServerOwnedQueueV1(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	status, payload, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID, nil)
	if status != http.StatusOK || payload["status"] != "PASS" {
		t.Fatalf("queue status=%d body=%s", status, raw)
	}
	if strings.Contains(raw, fixture.store.Root()) || strings.Contains(raw, "source_xlsx") || strings.Contains(raw, "source_sha256") || strings.Contains(raw, `"sha256"`) {
		t.Fatalf("queue leaked file/SHA authority: %s", raw)
	}
	queueValue := payload
	if queueValue["schema_version"] != articleApprovalQueueSchema || queueValue["queue_revision"] == "" || queueValue["actor"] != `HOSTDOMAIN\host-user` {
		t.Fatalf("queue metadata=%#v", queueValue)
	}
	if decisions := queueValue["allowed_decisions"].([]any); len(decisions) != 5 {
		t.Fatalf("allowed decisions=%#v", decisions)
	}
	first := queueValue["rows"].([]any)[0].(map[string]any)
	if !strings.HasPrefix(first["row_id"].(string), "row_") || first["bulk_approvable"] != true || queueValue["bulk_approvable"] != float64(1) {
		t.Fatalf("server row authority=%#v queue=%#v", first, queueValue)
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID+"&period=2025-11", nil)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_RUN_ID_INVALID") {
		t.Fatalf("queue accepted client scope authority: status=%d body=%s", status, raw)
	}
}

func TestApproval002GETRequiresCompletedExactAnchoredR005(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	run, _ := fixture.store.Run(fixture.run.ID)
	run.Status, run.Stage, run.FinishedAt = RunRunning, "R005", nil
	if err := fixture.store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID, nil)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_RUN_NOT_COMPLETED") {
		t.Fatalf("incomplete run accepted: status=%d body=%s", status, raw)
	}
}

func TestApproval002GETRejectsNonExactRulesCatalogAndScope(t *testing.T) {
	t.Run("21 columns", func(t *testing.T) {
		row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
		columns := append([]string{}, articleApprovalRuleColumns...)
		columns[len(columns)-1] = "Комментарий"
		fixture := articleApprovalNewBoundFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), columns)
		status, _, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID, nil)
		if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_SOURCE_RULES_21_COLUMNS_INVALID") {
			t.Fatalf("non-exact columns accepted: status=%d body=%s", status, raw)
		}
	})
	t.Run("authoritative catalog", func(t *testing.T) {
		row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
		catalog := []articleApprovalCatalogItem{{Code: row.ProposedCodeERP, Block: "Administrative", Article: row.ProposedArticleERP}}
		fixture := articleApprovalNewBoundFixture(t, []articleApprovalRow{row}, catalog, nil)
		status, _, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID, nil)
		if status != http.StatusBadRequest || !strings.Contains(raw, "ERP_TARGET_BLOCK_OR_ARTICLE_MISMATCH") {
			t.Fatalf("foreign catalog block accepted: status=%d body=%s", status, raw)
		}
	})
	t.Run("exact scope", func(t *testing.T) {
		row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
		row.OrganizationName = "Foreign organization"
		fixture := articleApprovalNewBoundFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
		status, _, raw := articleApprovalCall(t, fixture.server, http.MethodGet, "/api/article-approvals?run_id="+fixture.run.ID, nil)
		if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_SOURCE_RULE_SCOPE_MISMATCH") {
			t.Fatalf("foreign row scope accepted: status=%d body=%s", status, raw)
		}
	})
}

func TestS04A18QueueRejectsSixthDecisionAndMissingChangeFields(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "SIXTH"
	status, payload, _ := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("sixth decision status=%d payload=%#v", status, payload)
	}
	request = articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "ИЗМЕНИТЬ"
	status, payload, _ = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || payload["status"] != "FAIL" {
		t.Fatalf("incomplete change status=%d payload=%#v", status, payload)
	}
}

func TestS04A19QueueRejectsConflictUnknownTargetAndCreatesNoPartialVersion(t *testing.T) {
	first := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	second := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	second.ProposedCodeERP, second.ProposedArticleERP = "ERP-11", "Other"
	rows := []articleApprovalRow{first, second}
	fixture := articleApprovalNewQueueFixture(t, rows, articleApprovalDefaultCatalog(rows), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision, request.Decisions[1].UserDecision = "УТВЕРЖДАЮ", "УТВЕРЖДАЮ"
	status, payload, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	encoded, _ := json.Marshal(payload["errors"])
	if status != http.StatusBadRequest || !strings.Contains(string(encoded), "CONFLICTING_TARGETS") {
		t.Fatalf("conflict accepted: status=%d body=%s", status, raw)
	}
	if matches, _ := filepath.Glob(filepath.Join(articleApprovalDirectory(fixture.store), "*.approved.json")); len(matches) != 0 {
		t.Fatalf("partial approved file created: %v", matches)
	}
	request = articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0] = articleApprovalQueueDecision{
		RowID: request.Decisions[0].RowID, UserDecision: "ИЗМЕНИТЬ", CorrectBlockERP: "Commercial",
		CorrectArticleERP: "Unknown", CorrectCodeERP: "UNKNOWN", UserComment: "manual correction",
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ERP_CODE_UNKNOWN") {
		t.Fatalf("unknown target accepted: status=%d body=%s", status, raw)
	}
}

func TestApproval002POSTRejectsMissingExtraDuplicateAndClientAuthority(t *testing.T) {
	first := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	second := articleApprovalTestRow("НУЖНА ПРОВЕРКА")
	second.BlockIntalev, second.PathIntalev, second.ArticleIntalev = "Warehouse", "OPIU / Warehouse / Rent", "Rent"
	second.ProposedBlockERP, second.ProposedArticleERP, second.ProposedCodeERP = "Warehouse", "Rent", "ERP-20"
	rows := []articleApprovalRow{first, second}
	fixture := articleApprovalNewQueueFixture(t, rows, articleApprovalDefaultCatalog(rows), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions = request.Decisions[:1]
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_DECISION_SET_INCOMPLETE") {
		t.Fatalf("missing set accepted: status=%d body=%s", status, raw)
	}
	request = articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[1].RowID = request.Decisions[0].RowID
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_ROW_ID_DUPLICATE") {
		t.Fatalf("duplicate row accepted: status=%d body=%s", status, raw)
	}
	request = articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[1].RowID = "row_extra"
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", request)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_ROW_ID_EXTRA") {
		t.Fatalf("extra row accepted: status=%d body=%s", status, raw)
	}
	clientAuthority := map[string]any{
		"run_id": fixture.run.ID, "revision": fixture.queue.QueueRevision, "bulk_approve": false,
		"decisions": request.Decisions, "source_sha256": strings.Repeat("A", 64),
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", clientAuthority)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_REQUEST_INVALID") {
		t.Fatalf("client authority accepted: status=%d body=%s", status, raw)
	}
}

func TestApproval002BulkApprovesOnlyServerEligibleRows(t *testing.T) {
	first := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	second := articleApprovalTestRow("НУЖНА ПРОВЕРКА")
	second.BlockIntalev, second.PathIntalev, second.ArticleIntalev = "Warehouse", "OPIU / Warehouse / Rent", "Rent"
	second.ProposedBlockERP, second.ProposedArticleERP, second.ProposedCodeERP = "Warehouse", "Rent", "ERP-20"
	rows := []articleApprovalRow{first, second}
	fixture := articleApprovalNewQueueFixture(t, rows, articleApprovalDefaultCatalog(rows), nil)
	if !fixture.queue.Rows[0].BulkApprovable || fixture.queue.Rows[1].BulkApprovable {
		t.Fatalf("bulk eligibility=%+v", fixture.queue.Rows)
	}
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.BulkApprove = true
	forged := request
	forged.Decisions = append([]articleApprovalQueueDecision{}, request.Decisions...)
	forged.Decisions[1].UserDecision = "УТВЕРЖДАЮ"
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/validate", forged)
	if status != http.StatusBadRequest || !strings.Contains(raw, "ARTICLE_APPROVAL_BULK_ROW_NOT_ELIGIBLE") {
		t.Fatalf("bulk changed ineligible row: status=%d body=%s", status, raw)
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("bulk fix status=%d body=%s", status, raw)
	}
	document, _, err := articleApprovalLatest(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if document.Decisions[0].UserDecision != "УТВЕРЖДАЮ" || document.Decisions[1].UserDecision != "НУЖНА ПРОВЕРКА" {
		t.Fatalf("bulk crossed server eligibility: %+v", document.Decisions)
	}
}

func TestS04A20QueueVersionsAreImmutableActorBoundAndHaveSeparateSHA(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "УТВЕРЖДАЮ"
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v001 status=%d body=%s", status, raw)
	}
	first, firstPath, err := articleApprovalLatest(fixture.store, fixture.scope)
	if err != nil || first.Version != 1 || first.Actor != `HOSTDOMAIN\host-user` || !strings.HasSuffix(first.Source.XLSX, "/r005/reconciliation.xlsx") {
		t.Fatalf("v001=%+v path=%s err=%v", first, firstPath, err)
	}
	firstBytes, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	request.Decisions[0].UserDecision = "ЗАПРЕТИТЬ"
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("v002 status=%d body=%s", status, raw)
	}
	if actual, _ := os.ReadFile(firstPath); !bytes.Equal(actual, firstBytes) {
		t.Fatal("v001 was overwritten")
	}
	secondPath := filepath.Join(articleApprovalDirectory(fixture.store), fmt.Sprintf("article_registry_%s_v002.approved.json", articleApprovalOrganizationSlug(fixture.scope)))
	if _, err := os.Stat(secondPath + ".sha256"); err != nil {
		t.Fatalf("v002 SHA sidecar: %v", err)
	}
}

func TestS04A21QueueRejectsStaleRevisionAndAnchoredSourceDrift(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Revision = strings.Repeat("0", 64)
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusConflict || !strings.Contains(raw, "ARTICLE_APPROVAL_QUEUE_REVISION_STALE") {
		t.Fatalf("stale revision accepted: status=%d body=%s", status, raw)
	}
	request = articleApprovalQueueRequestFor(fixture.queue)
	data, err := os.ReadFile(fixture.report)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)/2] ^= 1
	if err := os.WriteFile(fixture.report, data, 0o600); err != nil {
		t.Fatal(err)
	}
	status, _, raw = articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusConflict || !strings.Contains(raw, "ARTICLE_APPROVAL_R005_ANCHOR_INVALID") {
		t.Fatalf("source drift accepted: status=%d body=%s", status, raw)
	}
}

func TestS04A21LegacyGETOrganizationPeriodRemainsBackwardSafe(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "ЗАПРЕТИТЬ"
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("fix status=%d body=%s", status, raw)
	}
	route := "/api/article-approvals?organization_id=ORG-9&organization_name=9%20%D0%A3%D0%BF%D1%80%D0%B0%D0%B2%D0%BB%D1%8F%D1%8E%D1%89%D0%B0%D1%8F%20%D0%BA%D0%BE%D0%BC%D0%BF%D0%B0%D0%BD%D0%B8%D1%8F&period=2025-10"
	status, payload, raw := articleApprovalCall(t, fixture.server, http.MethodGet, route, nil)
	if status != http.StatusOK || payload["status"] != "PASS" || payload["document"] == nil {
		t.Fatalf("legacy GET status=%d body=%s", status, raw)
	}
}

func TestS04A22QueueFixPreservesReportOnlyFinancialBarrierAndSafeResponse(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "УТВЕРЖДАЮ"
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", status, raw)
	}
	if strings.Contains(raw, fixture.store.Root()) || strings.Contains(raw, `"sha256"`) || strings.Contains(raw, `"posting_rows":1`) || strings.Contains(raw, `"ready_to_upload":true`) {
		t.Fatalf("fix response leaked authority: %s", raw)
	}
	document, _, err := articleApprovalLatest(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	if document.Safety.Mode != "REPORT_ONLY" || document.Safety.PostingRows != 0 || document.Safety.ReadyToUpload || document.Safety.ReleaseAllowed || document.Safety.Live1CAllowed {
		t.Fatalf("financial barrier opened: %+v", document.Safety)
	}
}

func TestS04A21ApprovedDocumentRejectsMissingReportOnlySafetyKey(t *testing.T) {
	row := articleApprovalTestRow("ПРЕДЛОЖЕНО ДВИЖКОМ")
	fixture := articleApprovalNewQueueFixture(t, []articleApprovalRow{row}, articleApprovalDefaultCatalog([]articleApprovalRow{row}), nil)
	request := articleApprovalQueueRequestFor(fixture.queue)
	request.Decisions[0].UserDecision = "УТВЕРЖДАЮ"
	status, _, raw := articleApprovalCall(t, fixture.server, http.MethodPost, "/api/article-approvals/fix", request)
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%s", status, raw)
	}
	_, approvedPath, err := articleApprovalLatest(fixture.store, fixture.scope)
	if err != nil {
		t.Fatal(err)
	}
	payload := articleApprovalReadMap(t, approvedPath)
	delete(payload["safety"].(map[string]any), "release_allowed")
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
	if _, _, err := articleApprovalLatest(fixture.store, fixture.scope); err == nil || !strings.Contains(err.Error(), "safety metadata is not exact") {
		t.Fatalf("missing false safety key accepted: %v", err)
	}
}
