package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const (
	organizationScopeID   = "ORG-9"
	organizationScopeName = "9 Управляющая компания"
	organizationScopePath = "Холдинг / 9 Управляющая компания"
)

func organizationScopeJSON(t *testing.T, value any) map[string]any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func requireOrganizationScope(t *testing.T, value map[string]any) {
	t.Helper()
	for field, expected := range map[string]string{
		"organization_id":   organizationScopeID,
		"organization_name": organizationScopeName,
		"organization_path": organizationScopePath,
	} {
		if actual, _ := value[field].(string); actual != expected {
			t.Fatalf("%s = %q, want %q; payload=%#v", field, actual, expected, value)
		}
	}
}

func organizationScopeRequest(t *testing.T, server *Server, method, path string, body any) (int, map[string]any, string) {
	t.Helper()
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(method, path, bytes.NewReader(encoded)))
	raw := recorder.Body.String()
	payload := map[string]any{}
	if raw != "" {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s %s response: %v; body=%s", method, path, err, raw)
		}
	}
	return recorder.Code, payload, raw
}

func TestContextAPIAndStorePreserveStableOrganizationScope(t *testing.T) {
	server, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	body, err := json.Marshal(map[string]any{
		"organization":      organizationScopeName,
		"organization_id":   organizationScopeID,
		"organization_name": organizationScopeName,
		"organization_path": organizationScopePath,
		"period":            "2025-10",
		"erp_file_id":       erp.ID,
		"intalev_file_id":   intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/contexts", bytes.NewReader(body)))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("create exact-scope context: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	requireOrganizationScope(t, created)
	contextID, _ := created["id"].(string)
	if contextID == "" {
		t.Fatalf("created context id is missing: %#v", created)
	}

	reopenedStore, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	reopened, ok := reopenedStore.Context(contextID)
	if !ok {
		t.Fatalf("context %s disappeared after Store reopen", contextID)
	}
	requireOrganizationScope(t, organizationScopeJSON(t, reopened))

	reopenedPipeline, err := NewPipeline(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	reopenedServer, err := NewServer(reopenedStore, reopenedPipeline)
	if err != nil {
		t.Fatal(err)
	}
	bootstrap := httptest.NewRecorder()
	reopenedServer.Handler().ServeHTTP(bootstrap, httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil))
	if bootstrap.Code != http.StatusOK {
		t.Fatalf("bootstrap after Store reopen: status=%d body=%s", bootstrap.Code, bootstrap.Body.String())
	}
	var snapshot map[string]any
	if err := json.Unmarshal(bootstrap.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	contexts, _ := snapshot["contexts"].([]any)
	if len(contexts) != 1 {
		t.Fatalf("bootstrap contexts=%#v", snapshot["contexts"])
	}
	publicContext, _ := contexts[0].(map[string]any)
	requireOrganizationScope(t, publicContext)
}

func writeLegacyStructuralInventory(t *testing.T, store *Store, contextValue Context, run Run) (string, string) {
	t.Helper()
	inventoryID := "SCI-LEGACY-CONTEXT"
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	if err := atomicWriteJSON(inventoryPath, map[string]any{
		"schema_version": "opiu-structural-control-inventory.v1",
		"inventory_id":   inventoryID,
		"status":         "VERIFIED",
		"run_id":         run.ID,
		"context_id":     contextValue.ID,
		"organization": map[string]any{
			"id": organizationScopeID, "name": organizationScopeName, "path": contextValue.OrganizationPath,
		},
		"period": contextValue.Period,
		"hierarchy_versions": map[string]any{
			"intalev": "INTALEV-HIERARCHY-V1", "erp": "ERP-HIERARCHY-V1",
		},
		"intalev_members": []any{map[string]any{
			"identity": "I-R045", "code": "R045", "name": "Финансовые расходы",
			"hierarchy_path": "Инталев / Финансовые расходы", "amount_cents": 10000,
			"selectable_root": true, "ambiguous": false,
		}},
		"erp_members": []any{map[string]any{
			"identity": "E-R045", "code": "R045", "name": "Финансовые расходы",
			"hierarchy_path": "ERP / Финансовые расходы", "amount_cents": 10000,
			"selectable_root": true, "ambiguous": false,
		}},
		"safety": reportOnlySafety(),
	}); err != nil {
		t.Fatal(err)
	}
	sha, err := sha256File(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteJSON(filepath.Join(r005Dir, "structural-control-inventory.binding.json"), map[string]any{
		"schema_version":    "opiu-structural-control-inventory-binding.v1",
		"artifact_type":     "STRUCTURAL_CONTROL_INVENTORY",
		"status":            "VERIFIED",
		"verified":          true,
		"run_id":            run.ID,
		"context_id":        contextValue.ID,
		"organization_id":   organizationScopeID,
		"organization_name": contextValue.OrganizationName,
		"organization_path": contextValue.OrganizationPath,
		"period":            contextValue.Period,
		"inventory_id":      inventoryID,
		"inventory_file":    filepath.Base(inventoryPath),
		"sha256":            sha,
	}); err != nil {
		t.Fatal(err)
	}
	return inventoryID, sha
}

func TestLegacyContextLoadsButCannotFixStructuralSetWithoutExactOrganizationID(t *testing.T) {
	_, store, _ := testServer(t)
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	legacy, err := store.CreateContext(createContextRequest{
		Organization: organizationScopeName, Period: "2025-10",
		ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	reopenedStore, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	legacyAfterReopen, ok := reopenedStore.Context(legacy.ID)
	if !ok || legacyAfterReopen.Organization != organizationScopeName {
		t.Fatalf("legacy context did not survive Store reopen: ok=%v context=%+v", ok, legacyAfterReopen)
	}
	legacyJSON := organizationScopeJSON(t, legacyAfterReopen)
	if exactID, _ := legacyJSON["organization_id"].(string); exactID != "" {
		t.Fatalf("legacy organization string was silently promoted to exact id %q", exactID)
	}

	run, err := reopenedStore.CreateRun(legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	inventoryID, _ := writeLegacyStructuralInventory(t, reopenedStore, legacyAfterReopen, run)
	pipeline, err := NewPipeline(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(reopenedStore, pipeline)
	if err != nil {
		t.Fatal(err)
	}
	draftBody := map[string]any{
		"name": "Финансовые расходы", "organization_id": organizationScopeID,
		"run_id": run.ID, "inventory_id": inventoryID, "author": "Экономист",
		"mode": "SUM_DELTA_ONLY", "expected_control_delta": 0, "tolerance_cents": 1,
		"expected_registry_revision": 0,
		"intalev_members":            []any{map[string]any{"identity": "I-R045"}},
		"erp_members":                []any{map[string]any{"identity": "E-R045"}},
	}
	draftStatus, draft, raw := organizationScopeRequest(t, server, http.MethodPost, "/api/structural-control-sets", draftBody)
	if draftStatus == http.StatusConflict {
		if draft["error"] != "STRUCTURAL_CONTROL_CONTEXT_ORGANIZATION_ID_REQUIRED" {
			t.Fatalf("legacy context blocked with wrong reason: %s", raw)
		}
		return
	}
	if draftStatus != http.StatusCreated {
		t.Fatalf("draft status=%d body=%s", draftStatus, raw)
	}
	draftPayload, _ := draft["draft"].(map[string]any)
	fixStatus, fix, fixRaw := organizationScopeRequest(t, server, http.MethodPost, "/api/structural-control-sets/fix", map[string]any{
		"draft_id": draftPayload["draft_id"], "organization_id": organizationScopeID,
		"run_id": run.ID, "inventory_id": inventoryID,
		"expected_registry_revision": draft["registry_revision"],
	})
	if fixStatus != http.StatusConflict || fix["error"] != "STRUCTURAL_CONTROL_CONTEXT_ORGANIZATION_ID_REQUIRED" {
		t.Fatalf("legacy context fixed structural set without exact organization id: status=%d body=%s", fixStatus, fixRaw)
	}
}
