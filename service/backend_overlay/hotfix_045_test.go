package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sourceRootForTests(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{
		filepath.Clean(filepath.Join("..", "source")),
		filepath.Clean(filepath.Join("..", "OPIU_User_Service_Green_0.4.5")),
		filepath.Clean("source"),
	} {
		if fileExists(filepath.Join(candidate, "web", "index.html")) {
			return candidate
		}
	}
	t.Fatal("service source root was not found for tests")
	return ""
}

func TestFolderUploadPreservesRelativePath(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	relative := "Хабаровск/Проводки/ОПИУ.xlsx"
	req := httptest.NewRequest(http.MethodPost, "/api/files/upload?kind=input", bytes.NewBufferString("test-data"))
	req.Header.Set("X-Relative-Path", url.QueryEscape(relative))
	rec := httptest.NewRecorder()
	app.handleUpload(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := filepath.Join(app.InputsDir, filepath.FromSlash(relative))
	if body, err := os.ReadFile(stored); err != nil || string(body) != "test-data" {
		t.Fatalf("nested file was not preserved: err=%v body=%q", err, body)
	}
	files, err := listFiles(app.InputsDir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range files {
		if item.Name == relative {
			found = true
		}
	}
	if !found {
		t.Fatalf("recursive file list does not contain %q: %#v", relative, files)
	}

	get := httptest.NewRequest(http.MethodGet, "/api/files/download?kind=input&name="+url.QueryEscape(relative), nil)
	getRec := httptest.NewRecorder()
	app.handleDownload(getRec, get)
	if getRec.Code != http.StatusOK || getRec.Body.String() != "test-data" {
		t.Fatalf("download failed status=%d body=%q", getRec.Code, getRec.Body.String())
	}
	if disposition := getRec.Header().Get("Content-Disposition"); !strings.Contains(disposition, url.PathEscape("ОПИУ.xlsx")) {
		t.Fatalf("download filename must use basename, got %q", disposition)
	}

	empty := httptest.NewRequest(http.MethodGet, "/api/files/download?kind=input", nil)
	emptyRec := httptest.NewRecorder()
	app.handleDownload(emptyRec, empty)
	if emptyRec.Code != http.StatusBadRequest {
		t.Fatalf("empty download path status=%d body=%s", emptyRec.Code, emptyRec.Body.String())
	}
}

func TestUploadRejectsRARWithUserMessage(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	req := httptest.NewRequest(http.MethodPost, "/api/files/upload?kind=input", bytes.NewBufferString("rar-data"))
	req.Header.Set("X-Filename", url.QueryEscape("Инталев.rar"))
	rec := httptest.NewRecorder()
	app.handleUpload(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("RAR status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "UNSUPPORTED_ARCHIVE") || !strings.Contains(rec.Body.String(), "ZIP") {
		t.Fatalf("RAR error must be actionable: %s", rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(app.InputsDir, "Инталев.rar")); !os.IsNotExist(err) {
		t.Fatalf("rejected RAR must not be stored: %v", err)
	}
}

func TestContextChangeRequiresConfirmationAndArchivesOnlyActiveFiles(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	settingsPath := filepath.Join(app.ConfigDir, "settings.json")
	settings := map[string]any{
		"organization_id": "ORG-OLD", "organization_name": "Старое ЦФО", "organization_path": "Холдинг / Старое ЦФО",
		"include_descendants": true, "period_mode": "month", "period": "2025-01", "active_run_id": "RUN-OLD",
		"workflow_stage": "R005_COMPLETED", "input_roles": map[string]any{"intalev": "Пакет/Инталев.xlsx", "erp": "Пакет/ERP.zip"},
		"safety": map[string]any{"posting_rows": 0, "ready_to_upload": false},
	}
	if err := writeJSONAtomic(settingsPath, settings); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(app.InputsDir, "Пакет"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app.InputsDir, "Пакет", "Инталев.xlsx"), []byte("i"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app.InputsDir, "Пакет", "ERP.zip"), []byte("e"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app.OutputsDir, "R005.xlsx"), []byte("r"), 0644); err != nil {
		t.Fatal(err)
	}
	catalogsPath := filepath.Join(app.ConfigDir, "catalogs.json")
	if err := os.WriteFile(catalogsPath, []byte("{\"catalogs\":[{\"id\":\"ERP\"}]}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	rulesPath := filepath.Join(app.RulesDir, "rules.json")
	rulesBefore, err := os.ReadFile(rulesPath)
	if err != nil {
		t.Fatal(err)
	}
	catalogsBefore, _ := os.ReadFile(catalogsPath)
	runsPath := filepath.Join(app.DataRoot, "runs", "index.json")
	runsBefore, _ := os.ReadFile(runsPath)
	artifactsPath := filepath.Join(app.DataRoot, "artifacts", "index.json")
	artifactsBefore, _ := os.ReadFile(artifactsPath)

	change := map[string]any{"organization_id": "ORG-NEW", "organization_name": "Новое ЦФО", "organization_path": "Холдинг / Новое ЦФО", "period": "2025-02"}
	body, _ := json.Marshal(change)
	req := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	app.handleSettings(rec, req)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "CONTEXT_RESET_REQUIRED") {
		t.Fatalf("context change must require confirmation: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !fileExists(filepath.Join(app.InputsDir, "Пакет", "Инталев.xlsx")) {
		t.Fatal("unconfirmed context change moved active files")
	}

	change["clear_current_context"] = true
	body, _ = json.Marshal(change)
	req = httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(body))
	rec = httptest.NewRecorder()
	app.handleSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirmed context change status=%d body=%s", rec.Code, rec.Body.String())
	}
	response := map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	archivePath := asString(response["archive_path"])
	if archivePath == "" || !strings.HasPrefix(filepath.Clean(archivePath), filepath.Clean(app.DataRoot)+string(os.PathSeparator)) {
		t.Fatalf("invalid archive path %q", archivePath)
	}
	for _, relative := range []string{"inputs/Пакет/Инталев.xlsx", "inputs/Пакет/ERP.zip", "outputs/R005.xlsx", "context.json"} {
		if !fileExists(filepath.Join(archivePath, filepath.FromSlash(relative))) {
			t.Fatalf("archive does not contain %s", relative)
		}
	}
	inputs, _ := listFiles(app.InputsDir)
	outputs, _ := listFiles(app.OutputsDir)
	if len(inputs) != 0 || len(outputs) != 0 {
		t.Fatalf("active files were not cleared: inputs=%#v outputs=%#v", inputs, outputs)
	}
	updated := map[string]any{}
	if err := readJSON(settingsPath, &updated); err != nil {
		t.Fatal(err)
	}
	if asString(updated["organization_id"]) != "ORG-NEW" || asString(updated["period"]) != "2025-02" || asString(updated["active_run_id"]) != "" {
		t.Fatalf("new context was not saved correctly: %#v", updated)
	}
	roles, _ := updated["input_roles"].(map[string]any)
	if asString(roles["intalev"]) != "" || asString(roles["erp"]) != "" {
		t.Fatalf("input roles were not cleared: %#v", roles)
	}
	rulesAfter, _ := os.ReadFile(rulesPath)
	catalogsAfter, _ := os.ReadFile(catalogsPath)
	runsAfter, _ := os.ReadFile(runsPath)
	artifactsAfter, _ := os.ReadFile(artifactsPath)
	if !bytes.Equal(rulesBefore, rulesAfter) || !bytes.Equal(catalogsBefore, catalogsAfter) || !bytes.Equal(runsBefore, runsAfter) || !bytes.Equal(artifactsBefore, artifactsAfter) {
		t.Fatal("rules, catalogs, run history or artifact history changed during context reset")
	}
}

func TestPrepareEngineAcceptsFilesInsideUploadedFolder(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	settings := map[string]any{
		"organization_id": "ORG-1", "organization_name": "Хабаровск", "organization_path": "1 Хабаровск",
		"include_descendants": true, "period_mode": "month", "period": "2025-01", "author": "Ирина",
		"input_roles": map[string]any{"intalev": "Пакет/ОПИУ Инталев.xlsx", "erp": "Пакет/ERP/Выгрузка.zip"},
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{"Пакет/ОПИУ Инталев.xlsx": "i", "Пакет/ERP/Выгрузка.zip": "e"} {
		full := filepath.Join(app.InputsDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	prepared, err := app.prepareEngineV041(map[string]any{"module_id": "reconciliation-engine", "run_id": "RUN-FOLDER-001"})
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	sources, _ := context["sources"].(map[string]any)
	if !strings.HasSuffix(filepath.ToSlash(asString(sources["intalev_path"])), "Пакет/ОПИУ Инталев.xlsx") {
		t.Fatalf("wrong Intalev path: %#v", sources)
	}
	if !strings.HasSuffix(filepath.ToSlash(asString(sources["erp_path"])), "Пакет/ERP/Выгрузка.zip") {
		t.Fatalf("wrong ERP path: %#v", sources)
	}
}

func TestPrepareEngineAutoMatchesGenericOrganizationFromERP(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	settings := map[string]any{
		"organization_id": "ERP-000000360", "organization_name": "Управленческая организация", "organization_path": "Управленческая организация",
		"include_descendants": true, "period_mode": "month", "period": "2025-01", "author": "Ирина", "active_run_id": "RUN-OLD-GENERIC", "context_revision": 1,
		"input_roles": map[string]any{"intalev": "ОПИУ Инталев.xlsx", "erp": "00_Полный_год_2025_9 УК_v35.zip"},
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	organizations := map[string]any{"nodes": []any{
		map[string]any{"node_id": "ERP-000000360", "node_name": "Управленческая организация", "hierarchy_path": "Управленческая организация", "parent_id": "", "node_type": "BRANCH", "selectable": true, "source_verified": true},
		map[string]any{"node_id": "ERP-000000224", "node_name": "9 Управляющая компания", "hierarchy_path": "9 Управляющая компания", "parent_id": "", "node_type": "ORGANIZATION", "selectable": true, "source_verified": true},
	}}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), organizations); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{"ОПИУ Инталев.xlsx": "i", "00_Полный_год_2025_9 УК_v35.zip": "not-a-real-zip-but-name-is-source-evidence"} {
		if err := os.WriteFile(filepath.Join(app.InputsDir, name), []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	prepared, err := app.prepareEngineV041(map[string]any{"module_id": "reconciliation-engine", "run_id": "RUN-OLD-GENERIC"})
	if err != nil {
		t.Fatal(err)
	}
	if !asBool(prepared["organization_auto_matched"]) || asString(prepared["organization_id"]) != "ERP-000000224" || asString(prepared["organization_name"]) != "9 Управляющая компания" {
		t.Fatalf("organization was not auto-matched from ERP: %#v", prepared)
	}
	if asString(prepared["run_id"]) == "RUN-OLD-GENERIC" {
		t.Fatal("generic run id was reused after organization identity changed")
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	organization, _ := context["organization"].(map[string]any)
	if asString(organization["id"]) != "ERP-000000224" || asString(organization["name"]) != "9 Управляющая компания" {
		t.Fatalf("prepared context contains wrong organization: %#v", organization)
	}
	updated := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &updated); err != nil {
		t.Fatal(err)
	}
	if asString(updated["organization_id"]) != "ERP-000000224" || asString(updated["organization_name"]) != "9 Управляющая компания" {
		t.Fatalf("service settings were not updated to proven organization: %#v", updated)
	}
	if !fileExists(filepath.Join(app.InputsDir, "ОПИУ Инталев.xlsx")) || !fileExists(filepath.Join(app.InputsDir, "00_Полный_год_2025_9 УК_v35.zip")) {
		t.Fatal("automatic organization match moved or deleted user inputs")
	}
}

func TestResolveEngineOrganizationReadsAllVerifiedRootOrganizations(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	cases := []struct {
		id       string
		name     string
		evidence string
	}{
		{"ERP-000000014", "1 Хабаровск", "ERP_Хабаровск_2025.xlsx"},
		{"ERP-000000042", "2 Камчатка", "ERP_Камчатка_2025.xlsx"},
		{"ERP-000000076", "3 Сахалин", "ERP_Сахалин_2025.xlsx"},
		{"ERP-000000041", "4 Владивосток", "ERP_Владивосток_2025.xlsx"},
		{"ERP-000000012", "7 Контрактодержатель", "ERP_Контрактодержатель_2025.xlsx"},
		{"ERP-000000150", "8 Сахалин МА", "ERP_Сахалин_МА_2025.xlsx"},
		{"ERP-000000224", "9 Управляющая компания", "00_Полный_год_2025_9 УК_v35.zip"},
		{"ERP-000000342", "Дистрибьюция", "ERP_Дистрибьюция_2025.xlsx"},
		{"ERP-000000040", "Производитель", "ERP_Производитель_2025.xlsx"},
		{"ERP-000000343", "Холдинг", "ERP_Холдинг_2025.xlsx"},
		{"ERP-000000038", "ЦД/ЦЗ Фонд развития", "ERP_ЦД_ЦЗ_Фонд_развития_2025.xlsx"},
		{"ERP-000000341", "Элиминирующая", "ERP_Элиминирующая_2025.xlsx"},
	}
	nodes := []any{}
	for _, tc := range cases {
		nodes = append(nodes, map[string]any{
			"node_id": tc.id, "node_name": tc.name, "hierarchy_path": tc.name,
			"parent_id": "", "node_type": "ORGANIZATION", "selectable": true, "source_verified": true,
		})
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), map[string]any{"nodes": nodes}); err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"organization_id": "ERP-000000360", "organization_name": "Управленческая организация", "organization_path": "Управленческая организация"}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			resolved, matched, err := app.resolveEngineOrganizationV051(settings, tc.evidence, filepath.Join(app.InputsDir, tc.evidence))
			if err != nil {
				t.Fatalf("%s was not resolved: %v", tc.name, err)
			}
			if !matched || asString(resolved["id"]) != tc.id || asString(resolved["name"]) != tc.name {
				t.Fatalf("wrong organization for %s: matched=%v resolved=%#v", tc.evidence, matched, resolved)
			}
		})
	}
}

func TestResolveEngineOrganizationRejectsDistinctOrganizationsInOneERP(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	organizations := map[string]any{"nodes": []any{
		map[string]any{"node_id": "ERP-000000042", "node_name": "2 Камчатка", "hierarchy_path": "2 Камчатка", "parent_id": "", "node_type": "ORGANIZATION", "selectable": true, "source_verified": true},
		map[string]any{"node_id": "ERP-000000041", "node_name": "4 Владивосток", "hierarchy_path": "4 Владивосток", "parent_id": "", "node_type": "ORGANIZATION", "selectable": true, "source_verified": true},
	}}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), organizations); err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"organization_name": "Управленческая организация"}
	_, matched, err := app.resolveEngineOrganizationV051(settings, "ERP_Камчатка_и_Владивосток_2025.xlsx", filepath.Join(app.InputsDir, "ERP_Камчатка_и_Владивосток_2025.xlsx"))
	if err == nil || matched || !strings.Contains(err.Error(), "несколько подтверждённых организаций") {
		t.Fatalf("distinct organization evidence must be blocked, matched=%v err=%v", matched, err)
	}
}

func TestPrepareEngineRejectsUnprovenGenericOrganizationBeforeLaunch(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	settings := map[string]any{
		"organization_id": "ERP-000000360", "organization_name": "Управленческая организация", "organization_path": "Управленческая организация",
		"include_descendants": true, "period_mode": "month", "period": "2025-01", "author": "Ирина",
		"input_roles": map[string]any{"intalev": "ОПИУ Инталев.xlsx", "erp": "ERP_без_организации.zip"},
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	organizations := map[string]any{"nodes": []any{map[string]any{"node_id": "ERP-000000224", "node_name": "9 Управляющая компания", "hierarchy_path": "9 Управляющая компания", "parent_id": "", "node_type": "ORGANIZATION", "selectable": true, "source_verified": true}}}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), organizations); err != nil {
		t.Fatal(err)
	}
	for name := range map[string]bool{"ОПИУ Инталев.xlsx": true, "ERP_без_организации.zip": true} {
		if err := os.WriteFile(filepath.Join(app.InputsDir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	_, err := app.prepareEngineV041(map[string]any{"module_id": "reconciliation-engine"})
	if err == nil || !strings.Contains(err.Error(), "организация не определена") {
		t.Fatalf("generic unproven organization must fail before engine launch, got %v", err)
	}
}

func TestWindowsEngineLauncherKeepsGUIVisibleWithoutConsole(t *testing.T) {
	source, err := os.ReadFile("platform_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "0x08000000 | 0x00000200") {
		t.Fatal("startDetached does not use CREATE_NO_WINDOW + CREATE_NEW_PROCESS_GROUP")
	}
	start := strings.Index(text, "func startDetached")
	end := strings.Index(text[start:], "func openBrowser")
	if start < 0 || end < 0 {
		t.Fatal("startDetached function not found")
	}
	functionText := text[start : start+end]
	if strings.Contains(functionText, "0x00000008") {
		t.Fatal("startDetached still uses DETACHED_PROCESS, which hid the engine window")
	}
	if strings.Contains(functionText, "HideWindow: true") {
		t.Fatal("startDetached still sends SW_HIDE to the engine process")
	}
}

func TestWindowsInstallerCreatesUserDesktopShortcut(t *testing.T) {
	source, err := os.ReadFile("platform_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"[Environment]::GetFolderPath('Desktop')",
		"Автоматическая сверка ОПИУ.lnk",
		"$s.TargetPath='%s'",
		"$s.Arguments='--launch'",
		"$s.WorkingDirectory='%s'",
		"$s.Save()",
	} {
		if !strings.Contains(text, required) {
			t.Fatalf("desktop shortcut contract is incomplete: missing %q", required)
		}
	}
}

func TestR001PortableNodeRuntimeIsBundled(t *testing.T) {
	root := sourceRootForTests(t)
	required := []string{
		"modules/corrections/source/node_modules/@oai/artifact-tool/package.json",
		"modules/corrections/source/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs",
		"modules/corrections/source/node_modules/@oai/artifact-tool/node_modules/skia-canvas/package.json",
		"modules/corrections/source/node_modules/@oai/artifact-tool/node_modules/@oai/walnut/package.json",
		"modules/corrections/source/node_modules/jszip/package.json",
		"modules/corrections/source/node_modules/pako/package.json",
		"modules/corrections/source/node_modules/readable-stream/package.json",
	}
	for _, relative := range required {
		if !fileExists(filepath.Join(root, filepath.FromSlash(relative))) {
			t.Fatalf("R001 runtime dependency is missing: %s", relative)
		}
	}

	buildScript, err := os.ReadFile("build_payload.py")
	if err != nil {
		t.Fatalf("read payload builder: %v", err)
	}
	if !bytes.Contains(buildScript, []byte(`R001_NODE_RUNTIME_PREFIX = "modules/corrections/source/node_modules/"`)) {
		t.Fatal("payload builder does not include the pinned R001 Node runtime")
	}
}

func TestOPIURowPresentationUsesReadableNamesWithoutInventingR036Path(t *testing.T) {
	rows := loadOPIURowPresentationV046(sourceRootForTests(t))
	expected := map[string]string{
		"R017": "Прочие адм.расходы",
		"R018": "Юридические расходы",
		"R035": "НДФЛ",
		"R036": "ФЗП",
	}
	for code, label := range expected {
		row, _ := rows[code].(map[string]any)
		if row == nil || asString(row["label"]) != label {
			t.Fatalf("%s display label=%q want=%q", code, asString(row["label"]), label)
		}
	}
	r036, _ := rows["R036"].(map[string]any)
	if !strings.Contains(asString(r036["intalev_path"]), "<пустое значение>") {
		t.Fatalf("R036 source path was invented instead of preserving the evidence: %#v", r036)
	}
	if asString(r036["intalev_block"]) != "ФЗП и компенсационные выплаты" || asString(r036["source_warning"]) == "" {
		t.Fatalf("R036 source warning/block missing: %#v", r036)
	}
}

func TestHotfixVisualAndLoaderFilesArePresent(t *testing.T) {
	sourceRoot := sourceRootForTests(t)
	htmlBytes, err := os.ReadFile(filepath.Join(sourceRoot, "web", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(htmlBytes)
	for _, required := range []string{
		"Рабочий релиз 1.9.4",
		"global-run-dashboard",
		"overview-source-delta",
		"overview-project-delta",
		"input-folder",
		"Выбрать Excel / ZIP",
		"Выбрать папку",
		"source-readiness-panel",
		"Загрузите точные пакеты ERP и Инталев",
		".zip",
	} {
		if !strings.Contains(html, required) {
			t.Fatalf("web UI is missing %q", required)
		}
	}
	jsBytes, err := os.ReadFile(filepath.Join(sourceRoot, "web", "app.js"))
	if err != nil {
		t.Fatal(err)
	}
	js := string(jsBytes)
	for _, required := range []string{"CONTEXT_RESET_REQUIRED", "clear_current_context", "webkitRelativePath", "X-Relative-Path", "ruleLineCodes", "friendlyRuleName", "ИСХОДНАЯ СТРОКА", "СВЯЗАННАЯ СТРОКА", "Статья ERP не сопоставлена", "Строка ОПИУ / статья", "Статья ERP", "SOURCE_PROOF_LOGIC_START", "startR005", "resolve_source_proof:true", "Запустить сверку R005"} {
		if !strings.Contains(js, required) {
			t.Fatalf("web behavior is missing %q", required)
		}
	}
	for _, forbidden := range []string{"source-proof-panel", "source-proof-evidence", "source-proof-approve", "source-proof-preflight", "source-proof-confirm", "latestRoleCandidate", "evidence JSON", "SHA-256", "package digest", "proof digest", "path identity", "digest"} {
		if strings.Contains(html, forbidden) || strings.Contains(js, forbidden) {
			t.Fatalf("normal web UI still exposes technical source-proof control %q", forbidden)
		}
	}
	for _, relative := range []string{
		"modules/reconciliation/source/ui_loader.ps1",
		"modules/corrections/source/correction_ui_loader.ps1",
	} {
		data, err := os.ReadFile(filepath.Join(sourceRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, required := range []string{"ContextPath", "ReadyPath", "ui_loader.log", "MessageBox"} {
			if !strings.Contains(text, required) {
				t.Fatalf("%s is missing %q", relative, required)
			}
		}
	}
}

func TestEngineReadyMarkerAcceptsPowerShellUTF8BOM(t *testing.T) {
	markerPath := filepath.Join(t.TempDir(), "ready.json")
	payload := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"status":"READY","module":"R005"}`)...)
	if err := os.WriteFile(markerPath, payload, 0644); err != nil {
		t.Fatal(err)
	}
	marker, ok := waitForEngineUIReadyV045(markerPath, 100*time.Millisecond)
	if !ok || asString(marker["status"]) != "READY" {
		t.Fatalf("PowerShell ready marker was not accepted: ok=%v marker=%#v", ok, marker)
	}
}

func TestUpdateDoesNotOverwriteUserOrganizationHierarchy(t *testing.T) {
	root := t.TempDir()
	appRoot := filepath.Join(root, "app", serviceVersion)
	defaults := filepath.Join(appRoot, "data", "defaults")
	if err := os.MkdirAll(defaults, 0755); err != nil {
		t.Fatal(err)
	}
	defaultFiles := map[string]string{
		"organizations.json": `{"schema_version":"org.v1","nodes":[{"node_id":"DEFAULT"}]}`,
		"runs.json":          `{"runs":[]}`,
		"artifacts.json":     `{"artifacts":[]}`,
		"settings.json":      `{"organization_id":"DEFAULT","input_roles":{"intalev":"","erp":""}}`,
		"materials.json":     `{"schema_version":"materials.v1","items":[]}`,
		"instructions.json":  `{"schema_version":"instructions.v1","instructions":[]}`,
		"rules.json":         `{"schema_version":"opiu-rule-registry.v2","rules":[],"revisions":[],"applications":[],"approvals":[],"evidence":[]}`,
	}
	for name, value := range defaultFiles {
		if err := os.WriteFile(filepath.Join(defaults, name), []byte(value), 0644); err != nil {
			t.Fatal(err)
		}
	}
	data := filepath.Join(root, "data")
	for _, dir := range []string{filepath.Join(data, "config"), filepath.Join(data, "rules"), filepath.Join(data, "instructions")} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	userOrganizations := []byte(`{"schema_version":"org.v1","nodes":[{"node_id":"USER-KHV","node_name":"Хабаровск"}]}` + "\n")
	organizationsPath := filepath.Join(data, "config", "organizations.json")
	if err := os.WriteFile(organizationsPath, userOrganizations, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "config", "settings.json"), []byte(defaultFiles["settings.json"]), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "config", "materials.json"), []byte(defaultFiles["materials.json"]), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "instructions", "instructions.json"), []byte(defaultFiles["instructions.json"]), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "rules", "rules.json"), []byte(defaultFiles["rules.json"]), 0644); err != nil {
		t.Fatal(err)
	}
	if err := ensureV041Data(root, appRoot); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(organizationsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, userOrganizations) {
		t.Fatalf("user organization hierarchy was overwritten during update: %s", after)
	}
}

func TestKnownR058PresentationUpgradeIsSafe(t *testing.T) {
	seeded := map[string]any{
		"rule_id": "FEB-OTH-058",
		"name":    "R058 — малая дельта февраля",
		"mapping": map[string]any{
			"intalev_source": map[string]any{"code": "R058", "article": "", "path": "", "block": ""},
			"erp_target":     map[string]any{"article": "", "path": "", "block": "", "code": "", "uuid": ""},
		},
	}
	registry := map[string]any{"rules": []any{seeded}, "revisions": []any{cloneMap(seeded)}}
	upgradeKnownRulePresentationV045(registry)
	for _, key := range []string{"rules", "revisions"} {
		rule, _ := anySlice(registry[key])[0].(map[string]any)
		if asString(rule["name"]) != "Прочие внереализационные расходы" {
			t.Fatalf("%s R058 title was not upgraded: %#v", key, rule)
		}
		mapping, _ := rule["mapping"].(map[string]any)
		intalev, _ := mapping["intalev_source"].(map[string]any)
		erp, _ := mapping["erp_target"].(map[string]any)
		if asString(intalev["article"]) != "Прочие внереализационные расходы" || asString(intalev["path"]) == "" {
			t.Fatalf("%s Intalev R058 hierarchy was not filled: %#v", key, intalev)
		}
		if asString(erp["article"]) != "Прочие внереализационные расходы" || asString(erp["code"]) != "НК0000231" || asString(erp["uuid"]) != "a089037a-dde7-11ef-9ecc-005056975dcd" {
			t.Fatalf("%s ERP R058 mapping was not filled: %#v", key, erp)
		}
		if strings.TrimSpace(asString(rule["content_hash"])) == "" {
			t.Fatalf("%s R058 content hash was not recalculated", key)
		}
	}

	custom := map[string]any{
		"rule_id": "FEB-OTH-058",
		"name":    "Моё подтверждённое правило R058",
		"mapping": map[string]any{"intalev_source": map[string]any{"code": "R058", "article": "Пользовательское название"}},
	}
	customRegistry := map[string]any{"rules": []any{custom}, "revisions": []any{}}
	upgradeKnownRulePresentationV045(customRegistry)
	if asString(custom["name"]) != "Моё подтверждённое правило R058" {
		t.Fatalf("custom R058 title was overwritten: %#v", custom)
	}
	mapping, _ := custom["mapping"].(map[string]any)
	intalev, _ := mapping["intalev_source"].(map[string]any)
	if asString(intalev["article"]) != "Пользовательское название" {
		t.Fatalf("custom R058 article was overwritten: %#v", intalev)
	}
}

func TestSeedAndPreviewUseReadableR058Title(t *testing.T) {
	sourceRoot := sourceRootForTests(t)
	seedPath := filepath.Join(sourceRoot, "data", "defaults", "rules.json")
	seed := map[string]any{}
	if err := readJSON(seedPath, &seed); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"rules", "revisions"} {
		found := false
		for _, raw := range anySlice(seed[key]) {
			rule, _ := raw.(map[string]any)
			if rule == nil || asString(rule["rule_id"]) != "FEB-OTH-058" {
				continue
			}
			found = true
			if asString(rule["name"]) != "Прочие внереализационные расходы" || strings.Contains(asString(rule["name"]), "малая дельта") {
				t.Fatalf("seed %s contains technical R058 title: %#v", key, rule)
			}
		}
		if !found {
			t.Fatalf("seed %s does not contain FEB-OTH-058", key)
		}
	}

	previewBytes, err := os.ReadFile(filepath.Join(sourceRoot, "web", "preview-data-044.js"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(previewBytes), "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[1], "const __OPIU_PREVIEW_BOOTSTRAP__=") {
		t.Fatal("preview bootstrap declaration not found")
	}
	payload := strings.TrimSuffix(strings.TrimPrefix(lines[1], "const __OPIU_PREVIEW_BOOTSTRAP__="), ";")
	preview := map[string]any{}
	if err := json.Unmarshal([]byte(payload), &preview); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"rules", "revisions"} {
		for _, raw := range anySlice(preview[key]) {
			rule, _ := raw.(map[string]any)
			if rule != nil && asString(rule["rule_id"]) == "FEB-OTH-058" && asString(rule["name"]) != "Прочие внереализационные расходы" {
				t.Fatalf("preview %s contains old R058 title: %#v", key, rule)
			}
		}
	}
}
