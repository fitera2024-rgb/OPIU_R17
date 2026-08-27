package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func rulesRevisionContextFixtureV194() rulesEngineCandidateRevisionContextV194 {
	return rulesEngineCandidateRevisionContextV194{
		RunID: "RUN-1", OrganizationID: "ORG-1", OrganizationName: "Organization 1",
		OrganizationPath: "Holding / Organization 1", Period: "2025-01", RulesExecutionID: "RULES-EXEC-1",
	}
}

func TestRulesEnginePublicResultHidesPathsHashesAndExposesOpaqueCandidateRevision(t *testing.T) {
	candidate := map[string]any{
		"kind": "candidate", "candidate_id": "CAND-1", "source_payload_hash": strings.Repeat("A", 64),
		"source_file": `C:\secret\journal.xlsx`, "source_sha256": strings.Repeat("B", 64),
		"intalev":  map[string]any{"article_path": "Расходы / Мат помощь"},
		"evidence": map[string]any{"source_file": `C:\secret\evidence.json`, "source_sha256": strings.Repeat("C", 64), "source_row": "15"},
	}
	result := rulesEnginePublicResultV194(map[string]any{
		"ok": true, "run_id": "RUN-1", "next_action": "PASS_TO_R001",
		"categories":    map[string]any{"review_required": []any{candidate}},
		"decision_rows": []any{candidate},
		"sources":       map[string]any{"rule_candidates.json": map[string]any{"path": `C:\secret\rule_candidates.json`, "sha256": strings.Repeat("D", 64)}},
		"execution":     map[string]any{"status": "COMPLETED", "finished_at": "2026-08-11T00:00:00Z", "stderr_log": `C:\secret\stderr.log`},
	}, rulesRevisionContextFixtureV194())
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{`C:\secret`, "source_payload_hash", "source_sha256", `"sources"`, "stderr_log", strings.Repeat("A", 64)} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("technical state leaked in public result: %s", body)
		}
	}
	rows := anySlice(result["decision_rows"])
	row, _ := rows[0].(map[string]any)
	if revision := asString(row["candidate_revision_id"]); !strings.HasPrefix(revision, "CRV-") || len(revision) != 36 {
		t.Fatalf("opaque candidate revision is missing: %#v", row)
	}
	intalev, _ := row["intalev"].(map[string]any)
	if asString(intalev["article_path"]) != "Расходы / Мат помощь" {
		t.Fatalf("business hierarchy was removed: %#v", row)
	}
	if int(asFloat(result["safety"].(map[string]any)["posting_rows"])) != 0 || asBool(result["safety"].(map[string]any)["live_1c_allowed"]) {
		t.Fatalf("unsafe public result: %#v", result)
	}
}

func TestRulesRegistryPublicDTOHidesLocalPathsAndHashesButKeepsBusinessMapping(t *testing.T) {
	rule := map[string]any{
		"rule_id": "RULE-1", "content_hash": strings.Repeat("A", 64),
		"source": map[string]any{
			"kind": "engine_feedback", "source_file": `C:\secret\rules.json`, "file": `C:\secret\rules.json`,
			"source_sha256": strings.Repeat("B", 64), "source_row": "15",
		},
		"mapping": map[string]any{
			"intalev_source": map[string]any{"article": "Материальная помощь", "path": "Расходы / Персонал"},
		},
		"technical_error": `failed at C:\secret\rules.json`,
	}
	rule["manifest_path"] = "internal/proof.json"
	rule["debug_payload"] = map[string]any{"relative_path": "internal/debug.json"}
	public := rulesRegistryPublicRuleV194(rule)
	encoded, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{`C:\secret`, "content_hash", "source_sha256", "technical_error", "manifest_path", "debug_payload", "engine_feedback"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("technical rule state leaked through public DTO: %s", body)
		}
	}
	source, _ := public["source"].(map[string]any)
	if !asBool(source["source_bound"]) || asString(source["source_row"]) != "15" || source["kind"] != nil || source["status"] != nil {
		t.Fatalf("sanitized source presence is incomplete: %#v", source)
	}
	mapping, _ := public["mapping"].(map[string]any)
	intalev, _ := mapping["intalev_source"].(map[string]any)
	if asString(intalev["path"]) != "Расходы / Персонал" {
		t.Fatalf("business hierarchy was removed: %#v", public)
	}
}

func TestRulesRegistryNormalHandlersUseCuratedPublicDTOs(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	for path, document := range map[string]map[string]any{
		filepath.Join(app.ConfigDir, "organizations.json"): {"nodes": []any{}},
		filepath.Join(app.InstrDir, "instructions.json"):   {"instructions": []any{}},
		filepath.Join(app.ConfigDir, "materials.json"):     {"items": []any{}},
		filepath.Join(app.ConfigDir, "catalogs.json"):      {"catalogs": []any{}},
	} {
		if err := writeJSONAtomic(path, document); err != nil {
			t.Fatal(err)
		}
	}
	registry := map[string]any{}
	if err := readJSON(filepath.Join(app.RulesDir, "rules.json"), &registry); err != nil {
		t.Fatal(err)
	}
	base := anySlice(registry["rules"])[0].(map[string]any)
	base["source"] = map[string]any{
		"kind": "engine_feedback", "source_file": `C:\secret\rule.json`, "source_row": "15",
		"source_sha256": strings.Repeat("A", 64), "manifest_path": "internal/proof.json",
	}
	base["manifest_path"] = "internal/proof.json"
	base["debug_payload"] = map[string]any{"relative_path": "internal/debug.json"}
	if err := writeJSONAtomic(filepath.Join(app.RulesDir, "rules.json"), registry); err != nil {
		t.Fatal(err)
	}

	assertPublic := func(label string, recorder *httptest.ResponseRecorder, expectedStatus int) {
		t.Helper()
		if recorder.Code != expectedStatus {
			t.Fatalf("%s status=%d body=%s", label, recorder.Code, recorder.Body.String())
		}
		body := recorder.Body.String()
		for _, forbidden := range []string{`C:\secret`, "engine_feedback", "source_sha256", "manifest_path", "debug_payload", "content_hash"} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("%s leaked technical rule state: %s", label, body)
			}
		}
	}

	bootstrap := httptest.NewRecorder()
	app.handleBootstrapV041(bootstrap, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	assertPublic("bootstrap", bootstrap, http.StatusOK)
	bootstrapDocument := map[string]any{}
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &bootstrapDocument); err != nil {
		t.Fatal(err)
	}
	bootstrapRule, _ := anySlice(bootstrapDocument["rules"])[0].(map[string]any)
	bootstrapSource, _ := bootstrapRule["source"].(map[string]any)
	if !asBool(bootstrapSource["source_bound"]) || asString(bootstrapSource["source_row"]) != "15" {
		t.Fatalf("bootstrap omitted sanitized source presence: %#v", bootstrapSource)
	}

	saveBody := `{"rule_id":"RULE-NEW","name":"Новое правило","rule_type":"organization","status":"DRAFT","enabled":false,"valid_from_year":2025,"scope":{"scope_type":"ALL_ORGS","mapping_status":"matched"},"mapping":{"intalev_source":{"code":"R001"}},"action":"CONTROL_ONLY","source":{"kind":"engine_feedback","manifest_path":"internal/proof.json"}}`
	save := httptest.NewRecorder()
	app.handleRuleSaveV041(save, httptest.NewRequest(http.MethodPost, "/api/rules/save", strings.NewReader(saveBody)))
	assertPublic("save", save, http.StatusOK)

	copyRecorder := httptest.NewRecorder()
	app.handleRuleCopyV041(copyRecorder, httptest.NewRequest(http.MethodPost, "/api/rules/copy", strings.NewReader(`{"rule_id":"BASE-1"}`)))
	assertPublic("copy", copyRecorder, http.StatusCreated)
}

func TestBootstrapUsesCuratedPublicMaterialsDTO(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	for path, document := range map[string]map[string]any{
		filepath.Join(app.ConfigDir, "organizations.json"): {"nodes": []any{}},
		filepath.Join(app.InstrDir, "instructions.json"):   {"instructions": []any{}},
		filepath.Join(app.ConfigDir, "catalogs.json"):      {"catalogs": []any{}},
	} {
		if err := writeJSONAtomic(path, document); err != nil {
			t.Fatal(err)
		}
	}
	secretHash := strings.Repeat("D", 64)
	materials := map[string]any{"items": []any{map[string]any{
		"material_id":  "MAT-1",
		"title":        "Business material",
		"description":  "Business description",
		"kind":         "external_link",
		"url":          "https://example.invalid/material",
		"editable":     true,
		"path":         `C:\secret\material.epf`,
		"sha256":       secretHash,
		"content_hash": strings.Repeat("E", 64),
		"debug":        map[string]any{"manifest_path": `C:\secret\manifest.json`},
		"internal":     map[string]any{"technical_state": "SECRET"},
	}}}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "materials.json"), materials); err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	app.handleBootstrapV041(response, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("bootstrap status=%d body=%s", response.Code, response.Body.String())
	}
	document := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	publicMaterials := anySlice(document["materials"])
	if len(publicMaterials) != 1 {
		t.Fatalf("unexpected public materials: %#v", publicMaterials)
	}
	public, _ := publicMaterials[0].(map[string]any)
	allowed := map[string]bool{
		"material_id": true, "title": true, "description": true, "kind": true, "url": true,
	}
	if len(public) != len(allowed) {
		t.Fatalf("public material fields are not an exact allowlist: %#v", public)
	}
	for field := range public {
		if !allowed[field] {
			t.Fatalf("unexpected public material field %q: %#v", field, public)
		}
	}
	if asString(public["material_id"]) != "MAT-1" || asString(public["title"]) != "Business material" || asString(public["url"]) != "https://example.invalid/material" {
		t.Fatalf("business material fields were removed: %#v", public)
	}
	encoded, err := json.Marshal(publicMaterials)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{"path", "sha256", "content_hash", "debug", "internal", `C:\secret`, secretHash, strings.Repeat("E", 64), "technical_state"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("bootstrap materials leaked %q: %s", forbidden, body)
		}
	}

	save := httptest.NewRecorder()
	app.handleMaterialSave(save, httptest.NewRequest(http.MethodPost, "/api/materials/save", strings.NewReader(`{"material_id":"MAT-1","title":"Updated material","url":"https://example.invalid/updated"}`)))
	if save.Code != http.StatusOK {
		t.Fatalf("material save status=%d body=%s", save.Code, save.Body.String())
	}
	for _, forbidden := range []string{"path", "sha256", "content_hash", "debug", "internal", `C:\secret`, secretHash, strings.Repeat("E", 64), "technical_state", "editable"} {
		if strings.Contains(save.Body.String(), forbidden) {
			t.Fatalf("material save leaked %q: %s", forbidden, save.Body.String())
		}
	}
	if !strings.Contains(save.Body.String(), "Updated material") || !strings.Contains(save.Body.String(), "https://example.invalid/updated") {
		t.Fatalf("material save removed business fields: %s", save.Body.String())
	}
	saveDocument := map[string]any{}
	if err := json.Unmarshal(save.Body.Bytes(), &saveDocument); err != nil {
		t.Fatal(err)
	}
	savedItem, _ := saveDocument["item"].(map[string]any)
	if len(savedItem) != len(allowed) {
		t.Fatalf("material save item fields are not an exact allowlist: %#v", savedItem)
	}
	for field := range savedItem {
		if !allowed[field] {
			t.Fatalf("material save returned unexpected field %q: %#v", field, savedItem)
		}
	}

	unsafeSave := httptest.NewRecorder()
	app.handleMaterialSave(unsafeSave, httptest.NewRequest(http.MethodPost, "/api/materials/save", strings.NewReader(`{"material_id":"MAT-1","url":"file:///C:/secret/materials"}`)))
	if unsafeSave.Code != http.StatusBadRequest || strings.Contains(unsafeSave.Body.String(), "file://") || strings.Contains(unsafeSave.Body.String(), `C:\secret`) {
		t.Fatalf("unsafe material URL was not rejected safely: %d %s", unsafeSave.Code, unsafeSave.Body.String())
	}
	for _, unsafeURL := range []string{
		"javascript:alert(1)",
		"data:text/plain,secret",
		`C:\secret\materials`,
		"file://server/share/materials",
		"https://user@example.invalid/materials",
	} {
		if materialPublicHTTPURLV194(unsafeURL) != "" {
			t.Fatalf("unsafe public material URL was accepted: %q", unsafeURL)
		}
	}

	local := materialsPublicItemV194(map[string]any{
		"material_id": "MAT-LOCAL", "title": "Local file", "description": "Download by ID", "kind": "local_file",
		"url": "file:///C:/secret/material.epf", "path": `C:\secret\material.epf`, "sha256": secretHash,
	})
	if len(local) != 4 || local["url"] != nil || asString(local["kind"]) != "local_file" {
		t.Fatalf("local material DTO is not strict: %#v", local)
	}

	unsafeSettings := sourceProofPublicSettingsV194(map[string]any{"materials_root_url": "file:///C:/secret/materials"})
	if unsafeSettings["materials_root_url"] != nil {
		t.Fatalf("unsafe materials root URL leaked through settings: %#v", unsafeSettings)
	}
	safeSettings := sourceProofPublicSettingsV194(map[string]any{"materials_root_url": "https://example.invalid/materials"})
	if asString(safeSettings["materials_root_url"]) != "https://example.invalid/materials" {
		t.Fatalf("safe materials root URL was removed: %#v", safeSettings)
	}
}

func TestNormalSupportDTOsHidePathsHashesAndArbitraryEventDetails(t *testing.T) {
	instruction := instructionsPublicItemV194(map[string]any{
		"instruction_id": "INS-1", "title": "Регламент", "current_version": 2,
		"current_path": `C:\secret\instruction.docx`, "sha256": strings.Repeat("A", 64),
	})
	events := eventsPublicItemsV194([]any{map[string]any{
		"timestamp": "2026-08-11T00:00:00Z", "type": "ENGINE_PUBLIC_PREPARE_BLOCKED_V194",
		"technical_error": `failed at C:\secret\context.json`, "context_path": `C:\secret\context.json`, "sha256": strings.Repeat("B", 64),
	}})
	encoded, err := json.Marshal(map[string]any{"instruction": instruction, "events": events})
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{`C:\secret`, "current_path", "sha256", "technical_error", "context_path", strings.Repeat("A", 64), strings.Repeat("B", 64)} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("normal support DTO leaked technical state: %s", body)
		}
	}
	if !strings.Contains(body, "Регламент") || !strings.Contains(body, "Операция не завершена") {
		t.Fatalf("normal business labels were removed: %s", body)
	}
}

func TestRulesEnginePrepareCollectAndRuleExportNeverLeakTechnicalState(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)

	prepare := httptest.NewRecorder()
	app.handleRulesEnginePrepare(prepare, httptest.NewRequest(http.MethodPost, "/api/rules-engine/prepare", strings.NewReader(`{"run_id":"`+runID+`","phase":"AFTER_R005"}`)))
	if prepare.Code != http.StatusCreated {
		t.Fatalf("prepare failed: %d %s", prepare.Code, prepare.Body.String())
	}
	for _, forbidden := range []string{"context_path", "input_dir", "output_dir", "handoff_dir", "proof_digest", `C:\`} {
		if strings.Contains(prepare.Body.String(), forbidden) {
			t.Fatalf("prepare leaked technical state: %s", prepare.Body.String())
		}
	}

	collect := httptest.NewRecorder()
	app.handleRulesEngineCollect(collect, httptest.NewRequest(http.MethodPost, "/api/rules-engine/collect", strings.NewReader(`{"run_id":"RUN-MISSING"}`)))
	if collect.Code != http.StatusConflict || strings.Contains(collect.Body.String(), app.DataRoot) || strings.Contains(collect.Body.String(), "technical_error") {
		t.Fatalf("collect leaked technical failure: %d %s", collect.Code, collect.Body.String())
	}

	registry := map[string]any{}
	if err := readJSON(filepath.Join(app.RulesDir, "rules.json"), &registry); err != nil {
		t.Fatal(err)
	}
	rule := anySlice(registry["rules"])[0].(map[string]any)
	rule["source"] = map[string]any{"source_file": `C:\secret\rule.json`, "source_row": "15", "source_sha256": strings.Repeat("A", 64), "manifest_path": "internal/proof.json"}
	rule["debug_payload"] = map[string]any{"relative_path": "internal/debug.json"}
	if err := writeJSONAtomic(filepath.Join(app.RulesDir, "rules.json"), registry); err != nil {
		t.Fatal(err)
	}
	_ = writeJSONAtomic(filepath.Join(app.ConfigDir, "organizations.json"), map[string]any{"nodes": []any{map[string]any{
		"node_id": "ORG-1", "node_name": "Организация", "hierarchy_path": "Организация", "source_file": `C:\secret\org.json`, "source_sha256": strings.Repeat("B", 64), "manifest_path": "internal/org-proof.json",
	}}})
	exported := httptest.NewRecorder()
	app.handleRuleExportV041(exported, httptest.NewRequest(http.MethodGet, "/api/rules/export?ids=BASE-1", nil))
	if exported.Code != http.StatusOK {
		t.Fatalf("export failed: %d %s", exported.Code, exported.Body.String())
	}
	reader, err := zip.NewReader(bytes.NewReader(exported.Body.Bytes()), int64(exported.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	foundRules := false
	for _, file := range reader.File {
		stream, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(stream)
		_ = stream.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{`C:\secret`, "source_sha256", "manifest_path", "debug_payload"} {
			if strings.Contains(string(content), forbidden) {
				t.Fatalf("export file %s leaked technical state: %s", file.Name, content)
			}
		}
		foundRules = foundRules || file.Name == "rules.json"
	}
	if !foundRules {
		t.Fatal("rules.json missing from export")
	}
}

func TestGenericAndEnginePublicResponsesNeverEchoInternalErrorsOrPaths(t *testing.T) {
	internal := map[string]any{
		"ok": true, "run_id": "RUN-1", "rules_count": 3, "organization_id": "ORG-1", "organization_name": "Организация",
		"context_path": `C:\secret\context.json`, "input_dir": `C:\secret\input`, "output_dir": `C:\secret\output`,
		"r001_handoff_path": `C:\secret\handoff.json`, "r001_handoff_sha256": strings.Repeat("A", 64), "proof_digest": strings.Repeat("B", 64),
	}
	for label, response := range map[string]map[string]any{
		"prepare": enginePublicPrepareV194(internal),
		"open":    enginePublicOpenV194(internal, true, "Рабочее окно открыто."),
	} {
		encoded, _ := json.Marshal(response)
		for _, forbidden := range []string{`C:\secret`, "context_path", "input_dir", "output_dir", "handoff", "sha256", "proof_digest"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Fatalf("%s response leaked technical state: %s", label, encoded)
			}
		}
	}
	recorder := httptest.NewRecorder()
	writeErr(recorder, errors.New(`failed at C:\secret\settings.json with `+strings.Repeat("C", 64)))
	if strings.Contains(recorder.Body.String(), `C:\secret`) || strings.Contains(recorder.Body.String(), strings.Repeat("C", 64)) {
		t.Fatalf("generic error leaked internal detail: %s", recorder.Body.String())
	}
}

func TestRulesEngineCandidateRevisionBindsContextExecutionAndCurrentState(t *testing.T) {
	candidate := map[string]any{"candidate_id": "CAND-1", "source_payload_hash": strings.Repeat("A", 64), "user_status": "PENDING_REVIEW"}
	baseContext := rulesRevisionContextFixtureV194()
	base := rulesEngineCandidateRevisionV194(candidate, baseContext)
	if base == "" {
		t.Fatal("candidate revision is empty")
	}
	contexts := []rulesEngineCandidateRevisionContextV194{
		{RunID: "RUN-2", OrganizationID: baseContext.OrganizationID, OrganizationName: baseContext.OrganizationName, OrganizationPath: baseContext.OrganizationPath, Period: baseContext.Period, RulesExecutionID: baseContext.RulesExecutionID},
		{RunID: baseContext.RunID, OrganizationID: "ORG-2", OrganizationName: baseContext.OrganizationName, OrganizationPath: baseContext.OrganizationPath, Period: baseContext.Period, RulesExecutionID: baseContext.RulesExecutionID},
		{RunID: baseContext.RunID, OrganizationID: baseContext.OrganizationID, OrganizationName: baseContext.OrganizationName, OrganizationPath: baseContext.OrganizationPath, Period: "2025-02", RulesExecutionID: baseContext.RulesExecutionID},
		{RunID: baseContext.RunID, OrganizationID: baseContext.OrganizationID, OrganizationName: baseContext.OrganizationName, OrganizationPath: baseContext.OrganizationPath, Period: baseContext.Period, RulesExecutionID: "RULES-EXEC-2"},
	}
	for _, changed := range contexts {
		if got := rulesEngineCandidateRevisionV194(candidate, changed); got == base {
			t.Fatalf("candidate revision did not change with context: %#v", changed)
		}
	}
	changedCandidate := cloneMap(candidate)
	changedCandidate["user_status"] = "MANUAL_REVIEW"
	if got := rulesEngineCandidateRevisionV194(changedCandidate, baseContext); got == base {
		t.Fatal("candidate revision did not change with current candidate state")
	}
}

func TestRulesEnginePublicErrorNeverReturnsTechnicalDetail(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeRulesEnginePublicErrorV194(recorder, http.StatusConflict, "RULES_ENGINE_RUN_FAILED", "Обработка не завершена.")
	body := recorder.Body.String()
	for _, forbidden := range []string{`C:\secret`, "stderr", strings.Repeat("A", 64)} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("technical detail leaked through public error: %s", body)
		}
	}
}

func TestRulesEngineApplyDecisionsIsSingleFlightBeforeValidationOrWrite(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	app.rulesEngineMu.Lock()
	defer app.rulesEngineMu.Unlock()
	request := httptest.NewRequest(http.MethodPost, "/api/rules-engine/apply-decisions", strings.NewReader(`{"run_id":"`+runID+`","decisions":[{"candidate_id":"CAND-1"}]}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	app.handleRulesEngineApplyDecisions(recorder, request)
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "RULES_ENGINE_BUSY") {
		t.Fatalf("concurrent apply was not blocked before validation: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestRulesEngineStatusHidesWorkflowHandoffHashesAndProcessLogs(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	secret := `C:\secret\rules-output`
	decisionPath := filepath.Join(app.DataRoot, "runs", runID, "workflow-decision-secret.json")
	if err := writeJSONAtomic(decisionPath, map[string]any{
		"run_id": runID, "next_action": "PASS_TO_R001", "reasons": []any{"Готово"},
		"handoff": map[string]any{"handoff_path": secret, "handoff_sha256": strings.Repeat("A", 64)},
		"state":   map[string]any{"state_fingerprint": strings.Repeat("B", 64)},
	}); err != nil {
		t.Fatal(err)
	}
	run, err := app.rulesEngineRunRecord(runID)
	if err != nil {
		t.Fatal(err)
	}
	run["rules_workflow_decision_path"] = decisionPath
	run["rules_process"] = map[string]any{"status": "COMPLETED", "stderr_log": secret + `\stderr.log`, "error": "stderr secret", "context_path": secret + `\context.json`}
	if err := app.rulesEngineSaveRunRecord(runID, run); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	app.handleRulesEngineStatus(recorder, httptest.NewRequest(http.MethodGet, "/api/rules-engine/status?run_id="+runID, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status endpoint failed: %d %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, forbidden := range []string{secret, "handoff_path", "handoff_sha256", "state_fingerprint", "stderr_log", "context_path", strings.Repeat("A", 64), strings.Repeat("B", 64)} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("technical status state leaked: %s", body)
		}
	}
}
