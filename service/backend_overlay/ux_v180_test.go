package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNormalizePeriodSelectionV180(t *testing.T) {
	valid := []struct{ mode, period string }{
		{"month", "2025-01"}, {"quarter", "2025-Q4"}, {"year", "2025"},
	}
	for _, tc := range valid {
		mode, period, err := normalizePeriodSelectionV180(tc.mode, tc.period)
		if err != nil || mode != tc.mode || period != tc.period {
			t.Fatalf("valid period rejected: %#v => %q %q %v", tc, mode, period, err)
		}
	}
	for _, tc := range []struct{ mode, period string }{{"month", "2025-13"}, {"quarter", "2025-03"}, {"year", "03"}, {"week", "2025-01"}} {
		if _, _, err := normalizePeriodSelectionV180(tc.mode, tc.period); err == nil {
			t.Fatalf("invalid period accepted: %#v", tc)
		}
	}
}

func TestLatestInputRoleV180UsesReplacementAndRejectsJournal(t *testing.T) {
	files := []fileInfo{
		{Name: "Инталев старый.xlsx", ModifiedAt: "2026-08-01T00:00:00Z"},
		{Name: "Инталев новый.zip", ModifiedAt: "2026-08-02T00:00:00Z"},
		{Name: "ERP ОПИУ.xlsx", ModifiedAt: "2026-08-02T00:00:00Z"},
		{Name: "ERP журнал проводок.zip", ModifiedAt: "2026-08-03T00:00:00Z"},
	}
	if got := latestInputRoleV180(files, "intalev"); got != "Инталев новый.zip" {
		t.Fatalf("latest Intalev=%q", got)
	}
	if got := latestInputRoleV180(files, "erp"); got != "ERP ОПИУ.xlsx" {
		t.Fatalf("ERP journal must not replace OPIU source, got %q", got)
	}
}

func TestPrepareEngineV180PersistsUnifiedPeriod(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	prepared, err := app.prepareEngineV041(map[string]any{
		"module_id": "reconciliation-engine", "run_id": runID,
		"period_mode": "quarter", "period": "2025-Q2",
	})
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	if context["period_mode"] != "quarter" || context["period"] != "2025-Q2" {
		t.Fatalf("period was not propagated to engine context: %#v", context)
	}
	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["period_mode"] != "quarter" || settings["period"] != "2025-Q2" {
		t.Fatalf("period was not persisted: %#v", settings)
	}
}

func TestPrepareEngineV181PrefersCurrentContextERPOverGlobalLatest(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	fundERP := "ERP_Фонд_ОПИУ.xlsx"
	oldUKERP := "ERP_УК_ОПИУ.xlsx"
	for _, name := range []string{fundERP, oldUKERP} {
		if err := os.WriteFile(filepath.Join(app.InputsDir, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// The UK file is globally newest, but it belongs to another organization.
	fundTime := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	ukTime := fundTime.Add(time.Hour)
	if err := os.Chtimes(filepath.Join(app.InputsDir, fundERP), fundTime, fundTime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(app.InputsDir, oldUKERP), ukTime, ukTime); err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{}
	settingsPath := filepath.Join(app.ConfigDir, "settings.json")
	if err := readJSON(settingsPath, &settings); err != nil {
		t.Fatal(err)
	}
	settings["input_roles"] = map[string]any{"intalev": "", "erp": fundERP}
	if err := writeJSONAtomic(settingsPath, settings); err != nil {
		t.Fatal(err)
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	run, _ := anySlice(runs["runs"])[0].(map[string]any)
	run["erp_file"] = fundERP
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "runs", "index.json"), runs); err != nil {
		t.Fatal(err)
	}
	installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
	files, err := listFiles(app.InputsDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := latestInputRoleV180(files, "erp"); got != oldUKERP {
		t.Fatalf("fixture must make UK globally latest, got %q", got)
	}
	prepared, err := app.prepareEngineV041(map[string]any{
		"module_id": "correction-files-engine",
		"run_id":    runID,
	})
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	sources, _ := context["sources"].(map[string]any)
	if got := filepath.Base(asString(sources["erp_path"])); got != fundERP {
		t.Fatalf("global latest ERP replaced current Fund context: got %q want %q", got, fundERP)
	}
}

func TestRefreshInputRolesAfterUploadV181UsesLatestSuitableSources(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	oldERP := "ERP_УК_ОПИУ.xlsx"
	newERP := "ERP_Фонд_ОПИУ.xlsx"
	journal := "ERP_Фонд_журнал_проводок.xlsx"
	intalev := "Фонд_Архив_Инталев.zip"
	base := time.Date(2026, 8, 6, 1, 0, 0, 0, time.UTC)
	for index, name := range []string{oldERP, newERP, journal, intalev} {
		path := filepath.Join(app.InputsDir, name)
		if err := os.WriteFile(path, []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
		stamp := base.Add(time.Duration(index) * time.Minute)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.refreshInputRolesAfterUploadV181(); err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	roles, _ := settings["input_roles"].(map[string]any)
	if got := asString(roles["erp"]); got != newERP {
		t.Fatalf("journal or old ERP selected: got %q want %q", got, newERP)
	}
	if got := asString(roles["intalev"]); got != intalev {
		t.Fatalf("latest Intalev not selected: got %q want %q", got, intalev)
	}
}

func TestTechnicalArtifactsBundleV180(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	runID := "RUN-TECH-180"
	dir := filepath.Join(app.DataRoot, "runs", runID, "r005-output")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	logPath, jsonPath, xlsxPath := filepath.Join(dir, "engine.log"), filepath.Join(dir, "context.json"), filepath.Join(dir, "report.xlsx")
	for path, body := range map[string]string{logPath: "log", jsonPath: `{"ok":true}`, xlsxPath: "xlsx"} {
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manifest := map[string]any{"artifacts": []any{
		map[string]any{"artifact_id": "A1", "run_id": runID, "stage": "R005", "name": "engine.log", "path": logPath},
		map[string]any{"artifact_id": "A2", "run_id": runID, "stage": "R005", "name": "context.json", "path": jsonPath},
		map[string]any{"artifact_id": "A3", "run_id": runID, "stage": "R005", "name": "report.xlsx", "path": xlsxPath},
	}}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), manifest); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/artifacts/technical-bundle?run_id="+runID, nil)
	rec := httptest.NewRecorder()
	app.handleTechnicalArtifactsBundleV180(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("bundle status=%d type=%q body=%s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, file := range zr.File {
		names = append(names, file.Name)
	}
	joined := strings.Join(names, "|")
	if !strings.Contains(joined, "engine.log") || !strings.Contains(joined, "context.json") || strings.Contains(joined, "report.xlsx") {
		t.Fatalf("unexpected technical bundle: %v", names)
	}
}

func writeCatalogFixtureV180(t *testing.T, path string) {
	t.Helper()
	buffer := bytes.NewBuffer(nil)
	zw := zip.NewWriter(buffer)
	parts := map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
		// The Intalev exporter uses this mixed-case part name. XLSX ZIP part
		// lookup must be case-insensitive.
		"xl/SharedStrings.xml":     `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Код</t></si><si><t>Наименование</t></si><si><t>Полный путь</t></si><si><t>R017</t></si><si><t>Расходы связи</t></si><si><t>Расходы / Расходы связи</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>`,
	}
	for name, content := range parts {
		entry, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
}

func writeERPArticleCatalogFixtureV180(t *testing.T, path string) {
	t.Helper()
	buffer := bytes.NewBuffer(nil)
	zw := zip.NewWriter(buffer)
	parts := map[string]string{
		"[Content_Types].xml":  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
		"xl/SharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Статья доходов и расходов</t></si><si><t>Код</t></si><si><t>Содержание складов</t></si><si><t>Коммунальные расходы</t></si><si><t>Счет затрат 44.2</t></si><si><t>ЦБ-000253</t></si></sst>`,
		"xl/worksheets/Sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="7"><c r="A7" t="s"><v>0</v></c></row>
<row r="8"><c r="A8" t="inlineStr"><is><t>Группа раскрытия</t></is></c><c r="O8" t="s"><v>1</v></c></row>
<row r="458" outlineLevel="1"><c r="A458" t="s"><v>2</v></c></row>
<row r="459" outlineLevel="2"><c r="A459" t="s"><v>3</v></c></row>
<row r="460" outlineLevel="3"><c r="A460" t="s"><v>4</v></c><c r="O460" t="s"><v>5</v></c></row>
</sheetData></worksheet>`,
	}
	for name, content := range parts {
		entry, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buffer.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestReadXLSXCatalogItemsV180KeepsAtomicIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Статьи.xlsx")
	writeCatalogFixtureV180(t, path)
	items := readXLSXCatalogItemsV180(path, "INTALEV", "текущий пакет")
	if len(items) != 1 {
		t.Fatalf("catalog items=%d %#v", len(items), items)
	}
	item := items[0].(map[string]any)
	if item["code"] != "R017" || item["name"] != "Расходы связи" || item["path"] != "Расходы / Расходы связи" {
		t.Fatalf("atomic identity lost: %#v", item)
	}
}

func TestReadXLSXCatalogItemsV180PairsERPArticleWithDetailCode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "СтатьиДоходовИРасходовЕРП.xlsx")
	writeERPArticleCatalogFixtureV180(t, path)
	items := readXLSXCatalogItemsV180(path, "ERP", "фиксированный справочник ERP")
	if len(items) != 1 {
		t.Fatalf("ERP catalog items=%d %#v", len(items), items)
	}
	item := items[0].(map[string]any)
	if item["code"] != "ЦБ-000253" || item["name"] != "Коммунальные расходы" {
		t.Fatalf("two-row ERP identity lost: %#v", item)
	}
	if item["path"] != "Содержание складов / Коммунальные расходы" || item["source_row"] != 460 {
		t.Fatalf("ERP hierarchy/source trace lost: %#v", item)
	}
}

func TestUserInstructionCreationAndSystemImmutabilityV180(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	manifest := map[string]any{"schema_version": "opiu-instructions.v1", "instructions": []any{
		map[string]any{"instruction_id": "INST-SYSTEM", "title": "Системная", "system_path": "resources/system.docx", "current_version": 1},
	}}
	if err := writeJSONAtomic(filepath.Join(app.InstrDir, "instructions.json"), manifest); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/instructions/create", bytes.NewBufferString("docx"))
	req.Header.Set("X-Instruction-Title", url.QueryEscape("Моя инструкция"))
	req.Header.Set("X-Instruction-Version", url.QueryEscape("2.1"))
	req.Header.Set("X-Instruction-Author", url.QueryEscape("Экономист"))
	req.Header.Set("X-Filename", url.QueryEscape("Инструкция.docx"))
	rec := httptest.NewRecorder()
	app.handleInstructionCreateV180(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	item := response["instruction"].(map[string]any)
	if item["display_version"] != "2.1" || item["author"] != "Экономист" || item["origin"] != "user" {
		t.Fatalf("instruction metadata=%#v", item)
	}
	upload := httptest.NewRequest(http.MethodPost, "/api/instructions/upload", bytes.NewBufferString("replacement"))
	upload.Header.Set("X-Instruction-Id", "INST-SYSTEM")
	uploadRec := httptest.NewRecorder()
	app.handleInstructionUpload(uploadRec, upload)
	if uploadRec.Code != http.StatusForbidden {
		t.Fatalf("system instruction must be immutable, status=%d body=%s", uploadRec.Code, uploadRec.Body.String())
	}
}
