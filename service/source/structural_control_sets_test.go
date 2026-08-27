package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This is the RED contract for the structural-control implementation in the
// service that is actually compiled and shipped from service/source. These
// names are the complete new production surface required by this test file.
var (
	_ = structuralControlRegistry{}
	_ = structuralControlSetVersion{}
	_ = structuralControlInventory{}
	_ = structuralControlPreview{}

	_ = func(server *Server) {
		var _ http.HandlerFunc = server.handleStructuralControlSets
		var _ http.HandlerFunc = server.handleStructuralControlSetPreview
		var _ http.HandlerFunc = server.handleStructuralControlSetFix
		var _ http.HandlerFunc = server.handleStructuralControlSetDisable
	}
)

const (
	structuralSourceOrganizationID   = "ORG-9"
	structuralSourceOrganizationName = "9 Управляющая компания"
	structuralSourceInventoryID      = "SCI-OCT-2025-V1"
)

type structuralSourceTestContext struct {
	server          *Server
	store           *Store
	contextID       string
	runID           string
	organizationID  string
	inventoryID     string
	inventoryPath   string
	inventorySHA256 string
}

func structuralSourceInventory(runID, contextID string) map[string]any {
	intalevMembers := []any{
		map[string]any{
			"identity": "I-R045", "code": "R045",
			"name":           "Результат по финансовой деятельности",
			"hierarchy_path": "Операционная прибыль / Финансовая деятельность",
			"amount_cents":   12_000_000, "source_order": 0, "selectable_root": true,
		},
		map[string]any{
			"identity": "I-R055", "code": "R055",
			"name":           "Результат по внереализационной деятельности",
			"hierarchy_path": "Прибыль / Внереализационная деятельность",
			"amount_cents":   8_000_000, "source_order": 1, "selectable_root": true,
		},
	}
	erpMembers := []any{
		map[string]any{
			"identity": "E-R045", "code": "R045",
			"name":           "Итоги по финансовой деятельности",
			"hierarchy_path": "ОПИУ ERP / Финансовая деятельность",
			"amount_cents":   15_000_000, "source_order": 0, "selectable_root": true,
		},
		map[string]any{
			"identity": "E-R055", "code": "R055",
			"name":           "Итоги по внереализационной деятельности",
			"hierarchy_path": "ОПИУ ERP / Внереализационная деятельность",
			"amount_cents":   5_000_000, "source_order": 1, "selectable_root": true,
		},
	}
	intalevMemberSHA, _ := canonicalJSONSHA256(intalevMembers)
	erpMemberSHA, _ := canonicalJSONSHA256(erpMembers)
	return map[string]any{
		"schema_version": "opiu-structural-control-inventory.v2",
		"artifact_type":  "STRUCTURAL_CONTROL_INVENTORY",
		"inventory_id":   structuralSourceInventoryID,
		"status":         "VERIFIED",
		"run_id":         runID,
		"context_id":     contextID,
		"organization": map[string]any{
			"id": structuralSourceOrganizationID, "name": structuralSourceOrganizationName,
			"path": "Холдинг / 9 Управляющая компания",
		},
		"period":       "2025-10",
		"generated_at": "2026-08-25T00:00:00Z",
		"hierarchy_versions": map[string]any{
			"intalev": strings.Repeat("1", 64),
			"erp":     strings.Repeat("2", 64),
		},
		"member_hashes": map[string]any{"intalev": intalevMemberSHA, "erp": erpMemberSHA},
		"input_hashes": map[string]any{
			"intalev": []any{map[string]any{"file": "intalev.xlsx", "sha256": strings.Repeat("A", 64)}},
			"erp":     []any{map[string]any{"file": "erp.xlsx", "sha256": strings.Repeat("B", 64)}},
		},
		"current_run_provenance": nil,
		"source_scope": map[string]any{
			"intalev": map[string]any{"node_count": 2, "root_count": 2, "sources": []any{map[string]any{"file": "intalev.xlsx", "sha256": strings.Repeat("A", 64), "sheets": []string{"ОПИУ"}, "first_row": 7, "last_row": 8}}},
			"erp":     map[string]any{"node_count": 2, "root_count": 2, "sources": []any{map[string]any{"file": "erp.xlsx", "sha256": strings.Repeat("B", 64), "sheets": []string{"ОПИУ"}, "first_row": 7, "last_row": 8}}},
		},
		"intalev_members":       intalevMembers,
		"erp_members":           erpMembers,
		"blockers":              []any{},
		"default_behavior":      "PROCESS_ALL_DISCREPANCIES",
		"optional_control_only": true,
		"correction_authority":  false,
		"financial_rows":        0,
		"safety":                reportOnlySafety(),
	}
}

func newStructuralSourceTestContext(t *testing.T) structuralSourceTestContext {
	t.Helper()
	server, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	contextValue, err := store.CreateContext(createContextRequest{
		Organization: structuralSourceOrganizationName, OrganizationID: structuralSourceOrganizationID,
		OrganizationName: structuralSourceOrganizationName, OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period: "2025-10", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	run.Status = RunCompletedReportOnly
	run.Stage = "R005_COMPLETED"
	run.Message = "Проверенный инвентарь R005 сформирован"
	run.FinishedAt = &now
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}

	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	bindingSHA := writePipelineStructuralInventory(t, store, run, contextValue)
	inventoryBytes, err := os.ReadFile(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(inventoryBytes)
	inventorySHA256 := strings.ToUpper(hex.EncodeToString(digest[:]))
	// The request never supplies a path or a digest. The server must locate this
	// private binding from the exact Store run and re-hash the bound artifact.
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}

	return structuralSourceTestContext{
		server: server, store: store, contextID: contextValue.ID, runID: run.ID,
		organizationID: structuralSourceOrganizationID, inventoryID: structuralSourceInventoryID,
		inventoryPath: inventoryPath, inventorySHA256: inventorySHA256,
	}
}

func structuralSourceRequest(t *testing.T, server *Server, method, path string, body any) (int, map[string]any, string) {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	payload := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid JSON response %d: %s", response.Code, response.Body.String())
	}
	return response.Code, payload, response.Body.String()
}

func structuralSourceMemberRefs(intalevIDs, erpIDs []string, forgedAmount int64) ([]any, []any) {
	intalev := make([]any, 0, len(intalevIDs))
	for _, identity := range intalevIDs {
		intalev = append(intalev, map[string]any{
			"identity": identity, "amount_cents": forgedAmount,
			"name": "Выдуманное имя клиента", "hierarchy_path": `C:\forged\member`,
		})
	}
	erp := make([]any, 0, len(erpIDs))
	for _, identity := range erpIDs {
		erp = append(erp, map[string]any{
			"identity": identity, "amount_cents": forgedAmount,
			"name": "Выдуманное имя клиента", "hierarchy_path": `C:\forged\member`,
		})
	}
	return intalev, erp
}

func structuralSourceDraftBody(context structuralSourceTestContext, name string, intalevIDs, erpIDs []string, revision int64) map[string]any {
	intalev, erp := structuralSourceMemberRefs(intalevIDs, erpIDs, 77_777_777)
	return map[string]any{
		"name":                       name,
		"organization_id":            context.organizationID,
		"run_id":                     context.runID,
		"inventory_id":               context.inventoryID,
		"author":                     "Экономист",
		"mode":                       "SUM_DELTA_ONLY",
		"expected_control_delta":     0,
		"tolerance_cents":            1,
		"intalev_members":            intalev,
		"erp_members":                erp,
		"expected_registry_revision": revision,
	}
}

func structuralSourceCreateDraft(t *testing.T, context structuralSourceTestContext, name string, intalevIDs, erpIDs []string, revision int64) map[string]any {
	t.Helper()
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets",
		structuralSourceDraftBody(context, name, intalevIDs, erpIDs, revision))
	if status != http.StatusCreated {
		t.Fatalf("draft create failed: %d %s", status, raw)
	}
	draft := structuralSourceMap(payload["draft"])
	if draft == nil || structuralSourceString(draft["draft_id"]) == "" {
		t.Fatalf("draft identity missing: %#v", payload)
	}
	assertStructuralSourceSafety(t, payload)
	return payload
}

func structuralSourceFixDraft(t *testing.T, context structuralSourceTestContext, draftPayload map[string]any) (int, map[string]any, string) {
	t.Helper()
	draft := structuralSourceMap(draftPayload["draft"])
	return structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/fix", map[string]any{
		"draft_id":                   draft["draft_id"],
		"organization_id":            context.organizationID,
		"run_id":                     context.runID,
		"inventory_id":               context.inventoryID,
		"expected_registry_revision": draftPayload["registry_revision"],
	})
}

func structuralSourceRegistry(t *testing.T, context structuralSourceTestContext, server *Server) (map[string]any, string) {
	t.Helper()
	path := "/api/structural-control-sets?organization_id=" + context.organizationID +
		"&run_id=" + context.runID + "&inventory_id=" + context.inventoryID
	status, payload, raw := structuralSourceRequest(t, server, http.MethodGet, path, nil)
	if status != http.StatusOK {
		t.Fatalf("registry GET failed: %d %s", status, raw)
	}
	assertStructuralSourceSafety(t, payload)
	return payload, raw
}

func structuralSourceString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func structuralSourceFloat(value any) float64 {
	number, _ := value.(float64)
	return number
}

func structuralSourceBool(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func structuralSourceMap(value any) map[string]any {
	object, _ := value.(map[string]any)
	return object
}

func structuralSourceSlice(value any) []any {
	items, _ := value.([]any)
	return items
}

func assertStructuralSourceSafety(t *testing.T, payload map[string]any) {
	t.Helper()
	safety := structuralSourceMap(payload["safety"])
	if safety == nil || structuralSourceString(safety["mode"]) != "REPORT_ONLY" ||
		!structuralSourceBool(safety["report_only"]) ||
		int(structuralSourceFloat(safety["posting_rows"])) != 0 ||
		int(structuralSourceFloat(safety["executed_posting_rows"])) != 0 ||
		int(structuralSourceFloat(safety["live_posting_rows"])) != 0 ||
		structuralSourceBool(safety["execution_allowed"]) ||
		structuralSourceBool(safety["ready_to_upload"]) ||
		structuralSourceBool(safety["release_allowed"]) ||
		structuralSourceBool(safety["live_1c_allowed"]) ||
		structuralSourceBool(safety["live_delete_allowed"]) {
		t.Fatalf("structural-control API opened a safety gate: %#v", payload)
	}
}

func structuralSourceVersionByID(t *testing.T, payload map[string]any, controlSetID string) map[string]any {
	t.Helper()
	for _, raw := range structuralSourceSlice(payload["versions"]) {
		version := structuralSourceMap(raw)
		if structuralSourceString(version["control_set_id"]) == controlSetID {
			return version
		}
	}
	t.Fatalf("fixed version %s is missing: %#v", controlSetID, payload)
	return nil
}

func structuralSourceCanonical(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func structuralSourceImmutableProjection(version map[string]any) map[string]any {
	return map[string]any{
		"control_set_id":         version["control_set_id"],
		"lineage_id":             version["lineage_id"],
		"version":                version["version"],
		"name":                   version["name"],
		"organization_id":        version["organization_id"],
		"run_id":                 version["run_id"],
		"inventory_id":           version["inventory_id"],
		"mode":                   version["mode"],
		"expected_control_delta": version["expected_control_delta"],
		"tolerance_cents":        version["tolerance_cents"],
		"intalev_members":        version["intalev_members"],
		"erp_members":            version["erp_members"],
	}
}

func TestStructuralControlSourcePreviewUsesSeparateServerInventoryArraysAndIntegerCents(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	intalev, erp := structuralSourceMemberRefs([]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 1)
	status, zero, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/preview", map[string]any{
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"intalev_members": intalev, "erp_members": erp,
		"mode": "SUM_DELTA_ONLY", "expected_control_delta": 0, "tolerance_cents": 1,
	})
	if status != http.StatusOK {
		t.Fatalf("zero preview failed: %d %s", status, raw)
	}
	if int64(structuralSourceFloat(zero["intalev_total_cents"])) != 20_000_000 ||
		int64(structuralSourceFloat(zero["erp_total_cents"])) != 20_000_000 ||
		int64(structuralSourceFloat(zero["control_delta_cents"])) != 0 ||
		structuralSourceString(zero["status"]) != "INTRA_CONTROL_SET_RECLASS_CLOSED" {
		t.Fatalf("wrong exact-cent zero preview: %#v", zero)
	}
	if !structuralSourceBool(zero["structural_effect_consumed_once"]) ||
		!structuralSourceBool(zero["descendant_internal_checks_active"]) ||
		int64(structuralSourceFloat(zero["descendant_residual_consumption_cents"])) != 0 ||
		structuralSourceString(zero["physical_proof_status"]) != "UNPROVEN" {
		t.Fatalf("zero preview did not close roots once while preserving children: %#v", zero)
	}
	if strings.Contains(raw, "77777777") || strings.Contains(raw, "Выдуманное") || strings.Contains(raw, `C:\\forged`) {
		t.Fatalf("caller-supplied amounts or facts were trusted: %s", raw)
	}
	assertStructuralSourceSafety(t, zero)

	intalev, erp = structuralSourceMemberRefs([]string{"I-R045"}, []string{"E-R055"}, -9)
	status, open, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/preview", map[string]any{
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"intalev_members": intalev, "erp_members": erp,
		"mode": "SUM_DELTA_ONLY", "expected_control_delta": 0, "tolerance_cents": 1,
	})
	if status != http.StatusOK {
		t.Fatalf("nonzero preview failed: %d %s", status, raw)
	}
	if int64(structuralSourceFloat(open["intalev_total_cents"])) != 12_000_000 ||
		int64(structuralSourceFloat(open["erp_total_cents"])) != 5_000_000 ||
		int64(structuralSourceFloat(open["control_delta_cents"])) != 7_000_000 ||
		structuralSourceString(open["status"]) != "INTER_GROUP_RECLASS_OPEN" {
		t.Fatalf("wrong exact-cent nonzero preview: %#v", open)
	}
	if structuralSourceBool(open["structural_effect_consumed_once"]) ||
		!structuralSourceBool(open["intergroup_search_required"]) ||
		!structuralSourceBool(open["descendant_internal_checks_active"]) ||
		int64(structuralSourceFloat(open["financial_rows"])) != 0 ||
		int64(structuralSourceFloat(open["posting_rows"])) != 0 {
		t.Fatalf("nonzero preview did not remain report-only intergroup-open: %#v", open)
	}
	assertStructuralSourceSafety(t, open)
}

func TestStructuralControlSourceDraftRetainsTypedSidesAndIgnoresCallerFacts(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	payload := structuralSourceCreateDraft(t, context, "Финансовые и внереализационные",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	draft := structuralSourceMap(payload["draft"])
	intalev := structuralSourceSlice(draft["intalev_members"])
	erp := structuralSourceSlice(draft["erp_members"])
	if len(intalev) != 2 || len(erp) != 2 {
		t.Fatalf("typed member arrays were collapsed: %#v", draft)
	}
	if structuralSourceString(structuralSourceMap(intalev[0])["identity"]) != "I-R045" ||
		structuralSourceString(structuralSourceMap(erp[0])["identity"]) != "E-R045" {
		t.Fatalf("typed identities changed: %#v", draft)
	}
	encoded := string(structuralSourceCanonical(t, draft))
	for _, forbidden := range []string{"77777777", "Выдуманное имя клиента", `C:\forged\member`} {
		if strings.Contains(encoded, forbidden) {
			t.Fatalf("caller facts survived server inventory binding: %s", encoded)
		}
	}
}

func TestStructuralControlSourceScopeInventoryAndSafetyValidationFailClosed(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(map[string]any)
		wantStatus int
		wantError  string
	}{
		{"empty Intalev side", func(body map[string]any) { body["intalev_members"] = []any{} }, http.StatusBadRequest, "STRUCTURAL_CONTROL_INTALEV_MEMBERS_REQUIRED"},
		{"empty ERP side", func(body map[string]any) { body["erp_members"] = []any{} }, http.StatusBadRequest, "STRUCTURAL_CONTROL_ERP_MEMBERS_REQUIRED"},
		{"duplicate typed member", func(body map[string]any) {
			members := body["intalev_members"].([]any)
			body["intalev_members"] = append(members, members[0])
		}, http.StatusBadRequest, "STRUCTURAL_CONTROL_MEMBER_DUPLICATE"},
		{"unknown identity", func(body map[string]any) {
			body["erp_members"] = []any{map[string]any{"identity": "E-UNKNOWN"}}
		}, http.StatusConflict, "STRUCTURAL_CONTROL_MEMBER_UNKNOWN"},
		{"foreign organization", func(body map[string]any) { body["organization_id"] = "ORG-OTHER" }, http.StatusConflict, "STRUCTURAL_CONTROL_ORGANIZATION_MISMATCH"},
		{"stale run", func(body map[string]any) { body["run_id"] = "run_old" }, http.StatusConflict, "STRUCTURAL_CONTROL_RUN_MISMATCH"},
		{"stale inventory", func(body map[string]any) { body["inventory_id"] = "SCI-OLD" }, http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_MISMATCH"},
		{"wrong mode", func(body map[string]any) { body["mode"] = "WHITELIST" }, http.StatusBadRequest, "STRUCTURAL_CONTROL_MODE_INVALID"},
		{"nonzero expected delta", func(body map[string]any) { body["expected_control_delta"] = 1 }, http.StatusBadRequest, "STRUCTURAL_CONTROL_EXPECTED_DELTA_INVALID"},
		{"fractional cents", func(body map[string]any) { body["tolerance_cents"] = 0.5 }, http.StatusBadRequest, "STRUCTURAL_CONTROL_TOLERANCE_CENTS_INVALID"},
		{"unsafe authority", func(body map[string]any) {
			body["ready_to_upload"] = true
			body["release_allowed"] = true
			body["live_1c_allowed"] = true
		}, http.StatusBadRequest, "STRUCTURAL_CONTROL_UNSAFE_AUTHORITY"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context := newStructuralSourceTestContext(t)
			body := structuralSourceDraftBody(context, test.name, []string{"I-R045"}, []string{"E-R045"}, 0)
			test.mutate(body)
			status, payload, _ := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets", body)
			if status != test.wantStatus || structuralSourceString(payload["error"]) != test.wantError {
				t.Fatalf("wrong fail-closed response: got %d %#v, want %d %s", status, payload, test.wantStatus, test.wantError)
			}
		})
	}
}

func TestStructuralControlSourceInventoryHashDriftIsBlocked(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	file, err := os.OpenFile(context.inventoryPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	intalev, erp := structuralSourceMemberRefs([]string{"I-R045"}, []string{"E-R045"}, 1)
	status, payload, _ := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/preview", map[string]any{
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"intalev_members": intalev, "erp_members": erp,
		"mode": "SUM_DELTA_ONLY", "expected_control_delta": 0, "tolerance_cents": 1,
	})
	if status != http.StatusConflict || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_INVENTORY_STALE" {
		t.Fatalf("inventory hash drift was not blocked: %d %#v", status, payload)
	}
}

func TestStructuralControlSourceFixedVersionsAreImmutableVersionedAndPersistent(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	firstDraft := structuralSourceCreateDraft(t, context, "Финансовые и внереализационные",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	status, fixedFirst, raw := structuralSourceFixDraft(t, context, firstDraft)
	if status != http.StatusCreated {
		t.Fatalf("first fix failed: %d %s", status, raw)
	}
	assertStructuralSourceSafety(t, fixedFirst)
	firstVersion := structuralSourceMap(fixedFirst["fixed_version"])
	firstID := structuralSourceString(firstVersion["control_set_id"])
	lineageID := structuralSourceString(firstVersion["lineage_id"])
	if firstID == "" || lineageID == "" || int(structuralSourceFloat(firstVersion["version"])) != 1 {
		t.Fatalf("first immutable version identity is incomplete: %#v", firstVersion)
	}
	if int64(structuralSourceFloat(firstVersion["intalev_total_cents"])) != 20_000_000 ||
		int64(structuralSourceFloat(firstVersion["erp_total_cents"])) != 20_000_000 ||
		int64(structuralSourceFloat(firstVersion["control_delta_cents"])) != 0 ||
		structuralSourceString(firstVersion["control_status"]) != "INTRA_CONTROL_SET_RECLASS_CLOSED" {
		t.Fatalf("fixed version omitted immutable integer-cent control result: %#v", firstVersion)
	}
	registryFirst, _ := structuralSourceRegistry(t, context, context.server)
	firstStored := structuralSourceVersionByID(t, registryFirst, firstID)
	firstProjection := structuralSourceCanonical(t, structuralSourceImmutableProjection(firstStored))

	secondBody := structuralSourceDraftBody(context, "Финансовые и внереализационные — уточнение",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, int64(structuralSourceFloat(fixedFirst["registry_revision"])))
	secondBody["source_control_set_id"] = firstID
	secondBody["lineage_id"] = lineageID
	status, secondDraft, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets", secondBody)
	if status != http.StatusCreated {
		t.Fatalf("edit draft failed: %d %s", status, raw)
	}
	status, fixedSecond, raw := structuralSourceFixDraft(t, context, secondDraft)
	if status != http.StatusCreated {
		t.Fatalf("second fix failed: %d %s", status, raw)
	}
	secondVersion := structuralSourceMap(fixedSecond["fixed_version"])
	if structuralSourceString(secondVersion["lineage_id"]) != lineageID ||
		structuralSourceString(secondVersion["control_set_id"]) == firstID ||
		int(structuralSourceFloat(secondVersion["version"])) != 2 {
		t.Fatalf("edit did not create version 2 in the same lineage: first=%#v second=%#v", firstVersion, secondVersion)
	}
	registrySecond, _ := structuralSourceRegistry(t, context, context.server)
	if len(structuralSourceSlice(registrySecond["versions"])) != 2 {
		t.Fatalf("fixed history was not retained: %#v", registrySecond)
	}
	firstAfterEdit := structuralSourceVersionByID(t, registrySecond, firstID)
	if !bytes.Equal(firstProjection, structuralSourceCanonical(t, structuralSourceImmutableProjection(firstAfterEdit))) {
		t.Fatalf("old fixed payload was mutated:\nold=%s\nnew=%s", firstProjection,
			structuralSourceCanonical(t, structuralSourceImmutableProjection(firstAfterEdit)))
	}

	reopenedStore, err := OpenStore(context.store.Root())
	if err != nil {
		t.Fatal(err)
	}
	reopenedPipeline, err := NewPipeline(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	reopenedServer, err := NewServer(reopenedStore, reopenedPipeline)
	if err != nil {
		t.Fatal(err)
	}
	restarted, _ := structuralSourceRegistry(t, context, reopenedServer)
	if len(structuralSourceSlice(restarted["versions"])) != 2 {
		t.Fatalf("fixed versions were not persisted through Store reopen: %#v", restarted)
	}
}

func TestStructuralControlSourceOverlapAndRegistryRevisionConflictsAreBlocked(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	firstDraft := structuralSourceCreateDraft(t, context, "Первый набор", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, firstDraft)
	if status != http.StatusCreated {
		t.Fatalf("first fix failed: %d %s", status, raw)
	}
	revision := int64(structuralSourceFloat(fixed["registry_revision"]))
	overlapDraft := structuralSourceCreateDraft(t, context, "Перекрывающийся набор", []string{"I-R045"}, []string{"E-R055"}, revision)
	status, blocked, _ := structuralSourceFixDraft(t, context, overlapDraft)
	if status != http.StatusConflict || structuralSourceString(blocked["error"]) != "STRUCTURAL_CONTROL_SET_MEMBER_OVERLAP" {
		t.Fatalf("active typed-member overlap was not blocked: %d %#v", status, blocked)
	}

	staleBody := structuralSourceDraftBody(context, "Устаревшая запись", []string{"I-R055"}, []string{"E-R055"}, 0)
	status, stale, _ := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets", staleBody)
	if status != http.StatusConflict || structuralSourceString(stale["error"]) != "STRUCTURAL_CONTROL_REGISTRY_REVISION_CONFLICT" {
		t.Fatalf("lost update was not blocked: %d %#v", status, stale)
	}
	registry, _ := structuralSourceRegistry(t, context, context.server)
	if len(structuralSourceSlice(registry["versions"])) != 1 {
		t.Fatalf("blocked operation created a fixed version: %#v", registry)
	}
}

func TestStructuralControlSourceSupportsSeveralIndependentSetsWithSerializedTotals(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	firstDraft := structuralSourceCreateDraft(t, context, "Финансовая деятельность",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	status, firstFixed, raw := structuralSourceFixDraft(t, context, firstDraft)
	if status != http.StatusCreated {
		t.Fatalf("first independent set failed: %d %s", status, raw)
	}
	secondDraft := structuralSourceCreateDraft(t, context, "Внереализационная деятельность",
		[]string{"I-R055"}, []string{"E-R055"}, int64(structuralSourceFloat(firstFixed["registry_revision"])))
	status, _, raw = structuralSourceFixDraft(t, context, secondDraft)
	if status != http.StatusCreated {
		t.Fatalf("second independent set failed: %d %s", status, raw)
	}
	payload, _ := structuralSourceRegistry(t, context, context.server)
	versions := structuralSourceSlice(payload["versions"])
	if len(versions) != 2 {
		t.Fatalf("several independent sets were not retained: %#v", payload)
	}
	actualDeltas := map[int64]bool{}
	for _, rawVersion := range versions {
		version := structuralSourceMap(rawVersion)
		delta := int64(structuralSourceFloat(version["control_delta_cents"]))
		actualDeltas[delta] = true
		if structuralSourceString(version["status"]) != "FIXED" ||
			structuralSourceString(version["control_status"]) != "INTER_GROUP_RECLASS_OPEN" ||
			structuralSourceBool(version["structural_effect_consumed_once"]) ||
			!structuralSourceBool(version["intergroup_search_required"]) ||
			!structuralSourceBool(version["descendant_internal_checks_active"]) ||
			int64(structuralSourceFloat(version["descendant_residual_consumption_cents"])) != 0 {
			t.Fatalf("independent set lost its exact control result: %#v", version)
		}
	}
	if !actualDeltas[-3_000_000] || !actualDeltas[3_000_000] {
		t.Fatalf("independent sets lost their exact integer-cent open residuals: %#v", versions)
	}
	assertStructuralSourceSafety(t, payload)
}

func TestStructuralControlSourceDisableAppendsHistoryWithoutMutatingFixedVersion(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Отключаемый набор", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, draft)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	controlSetID := structuralSourceString(version["control_set_id"])
	beforeRegistry, _ := structuralSourceRegistry(t, context, context.server)
	before := structuralSourceCanonical(t, structuralSourceImmutableProjection(structuralSourceVersionByID(t, beforeRegistry, controlSetID)))

	status, disabled, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/disable", map[string]any{
		"organization_id":            context.organizationID,
		"run_id":                     context.runID,
		"inventory_id":               context.inventoryID,
		"control_set_id":             controlSetID,
		"reason":                     "Иерархия изменилась",
		"expected_registry_revision": fixed["registry_revision"],
	})
	if status != http.StatusOK || structuralSourceString(disabled["status"]) != "DISABLED" {
		t.Fatalf("disable failed: %d %s", status, raw)
	}
	assertStructuralSourceSafety(t, disabled)
	afterRegistry, _ := structuralSourceRegistry(t, context, context.server)
	after := structuralSourceCanonical(t, structuralSourceImmutableProjection(structuralSourceVersionByID(t, afterRegistry, controlSetID)))
	if !bytes.Equal(before, after) {
		t.Fatalf("disable mutated fixed payload:\nold=%s\nnew=%s", before, after)
	}
	found := false
	for _, rawEvent := range structuralSourceSlice(afterRegistry["lifecycle_events"]) {
		event := structuralSourceMap(rawEvent)
		if structuralSourceString(event["action"]) == "DISABLED" && structuralSourceString(event["control_set_id"]) == controlSetID {
			found = true
		}
	}
	if !found {
		t.Fatalf("disable audit history is missing: %#v", afterRegistry)
	}

	revision := int64(structuralSourceFloat(disabled["registry_revision"]))
	replacement := structuralSourceCreateDraft(t, context, "Новый активный набор", []string{"I-R045"}, []string{"E-R045"}, revision)
	status, _, raw = structuralSourceFixDraft(t, context, replacement)
	if status != http.StatusCreated {
		t.Fatalf("disabled membership was incorrectly treated as active overlap: %d %s", status, raw)
	}
}

func TestStructuralControlSourcePublicDTOIsSanitizedAndReportOnly(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Публичный набор", []string{"I-R045"}, []string{"E-R055"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, draft)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	assertStructuralSourceSafety(t, fixed)
	payload, raw := structuralSourceRegistry(t, context, context.server)
	if len(structuralSourceSlice(payload["versions"])) != 1 {
		t.Fatalf("fixed version is missing from public DTO: %#v", payload)
	}
	lower := strings.ToLower(raw)
	for _, forbidden := range []string{
		strings.ToLower(context.store.Root()),
		strings.ToLower(context.inventoryPath),
		strings.ToLower(context.inventorySHA256),
		`c:\private\r005`, "source_path", "source_sha256", "artifact_path", "payload_sha256",
		"inventory_file", "disk_name", "proof_json", "debug_code",
	} {
		if forbidden != "" && strings.Contains(lower, forbidden) {
			t.Fatalf("private implementation evidence leaked through public DTO (%s): %s", forbidden, raw)
		}
	}
	for _, unsafe := range []string{`"ready_to_upload":true`, `"release_allowed":true`, `"live_1c_allowed":true`} {
		if strings.Contains(strings.ReplaceAll(lower, " ", ""), unsafe) {
			t.Fatalf("unsafe public DTO: %s", raw)
		}
	}
}
