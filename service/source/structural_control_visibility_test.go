package main

import (
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

func fixedStructuralSourceVersion(t *testing.T, context structuralSourceTestContext) map[string]any {
	t.Helper()
	draft := structuralSourceCreateDraft(t, context, "Финансовые и внереализационные расходы",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, draft)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: status=%d body=%s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	if version == nil {
		t.Fatalf("fixed version missing: %#v", fixed)
	}
	return version
}

func TestStructuralControlFixedVersionIsVisibleInBootstrapAndRunPayload(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	version := fixedStructuralSourceVersion(t, context)

	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodGet, "/api/bootstrap", nil)
	if status != http.StatusOK {
		t.Fatalf("bootstrap failed: status=%d body=%s", status, raw)
	}
	assertFixedStructuralRunReference(t, "/api/bootstrap", structuralSourceSlice(payload["runs"]), raw, version, context.inventoryID)

	request := httptest.NewRequest(http.MethodGet, "/api/runs", nil)
	response := httptest.NewRecorder()
	context.server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("runs failed: status=%d body=%s", response.Code, response.Body.String())
	}
	var runs []any
	if err := json.Unmarshal(response.Body.Bytes(), &runs); err != nil {
		t.Fatalf("runs returned invalid JSON: %v body=%s", err, response.Body.String())
	}
	assertFixedStructuralRunReference(t, "/api/runs", runs, response.Body.String(), version, context.inventoryID)

	status, payload, raw = structuralSourceRequest(t, context.server, http.MethodGet, "/api/runs/"+context.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("run by id failed: status=%d body=%s", status, raw)
	}
	assertFixedStructuralRunReference(t, "/api/runs/{id}", []any{payload}, raw, version, context.inventoryID)
}

func assertFixedStructuralRunReference(t *testing.T, path string, runs []any, raw string, version map[string]any, inventoryID string) {
	t.Helper()
	if len(runs) != 1 {
		t.Fatalf("%s run payload=%#v", path, runs)
	}
	run := structuralSourceMap(runs[0])
	refs := structuralSourceSlice(run["structural_control_sets"])
	if len(refs) != 1 {
		t.Fatalf("%s structural refs=%#v", path, refs)
	}
	ref := structuralSourceMap(refs[0])
	if structuralSourceString(ref["control_set_id"]) != structuralSourceString(version["control_set_id"]) ||
		int(ref["version"].(float64)) != int(version["version"].(float64)) ||
		structuralSourceString(ref["inventory_id"]) != inventoryID ||
		structuralSourceString(ref["context_id"]) == "" ||
		structuralSourceString(ref["run_id"]) == "" ||
		structuralSourceString(ref["organization_id"]) == "" ||
		structuralSourceString(ref["lineage_id"]) == "" ||
		structuralSourceString(ref["fixed_at"]) == "" ||
		structuralSourceString(ref["status"]) != "FIXED" {
		t.Fatalf("%s does not expose exact fixed version: %#v", path, ref)
	}
	if strings.Contains(strings.ToLower(raw), "sha256") || strings.Contains(raw, `C:\\`) {
		t.Fatalf("%s leaked private proof/path fields: %s", path, raw)
	}
}

func TestStructuralControlFixIsRecordedInPublicAuditJournal(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	version := fixedStructuralSourceVersion(t, context)

	path := "/api/structural-control-sets?run_id=" + context.runID
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodGet, path, nil)
	if status != http.StatusOK {
		t.Fatalf("registry failed: status=%d body=%s", status, raw)
	}
	events := structuralSourceSlice(payload["lifecycle_events"])
	if len(events) != 1 {
		t.Fatalf("fixed lifecycle event missing: %#v", events)
	}
	event := structuralSourceMap(events[0])
	if structuralSourceString(event["action"]) != "FIXED" ||
		structuralSourceString(event["control_set_id"]) != structuralSourceString(version["control_set_id"]) ||
		structuralSourceString(event["lineage_id"]) == "" ||
		structuralSourceString(event["run_id"]) != context.runID ||
		structuralSourceString(event["context_id"]) != context.contextID ||
		structuralSourceString(event["inventory_id"]) != context.inventoryID ||
		structuralSourceString(event["author"]) == "" ||
		structuralSourceString(event["occurred_at"]) == "" {
		t.Fatalf("fixed lifecycle event incomplete: %#v", event)
	}
	if strings.Contains(strings.ToLower(raw), "sha256") || strings.Contains(raw, `C:\\`) {
		t.Fatalf("public audit leaked private proof/path fields: %s", raw)
	}
}

func TestStructuralControlRunProjectionRevalidatesExactInventoryBytes(t *testing.T) {
	for _, mutate := range []struct {
		name string
		do   func(t *testing.T, context structuralSourceTestContext)
	}{
		{name: "inventory deleted", do: func(t *testing.T, context structuralSourceTestContext) {
			if err := os.Remove(context.inventoryPath); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "inventory drift", do: func(t *testing.T, context structuralSourceTestContext) {
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
		}},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			context := newStructuralSourceTestContext(t)
			fixedStructuralSourceVersion(t, context)
			mutate.do(t, context)
			status, payload, raw := structuralSourceRequest(t, context.server, http.MethodGet, "/api/bootstrap", nil)
			if status != http.StatusOK {
				t.Fatalf("bootstrap unavailable after stale inventory: status=%d body=%s", status, raw)
			}
			runs := structuralSourceSlice(payload["runs"])
			if len(runs) != 1 {
				t.Fatalf("runs=%#v", runs)
			}
			run := structuralSourceMap(runs[0])
			if run["has_structural_inventory"] != false || len(structuralSourceSlice(run["structural_control_sets"])) != 0 {
				t.Fatalf("stale inventory still advertised as fixed: %#v", run)
			}
		})
	}
}

func addStructuralSourceRun(t *testing.T, base structuralSourceTestContext, inventoryID, period string) structuralSourceTestContext {
	t.Helper()
	snapshot := base.store.Snapshot(false)
	var erpID, intalevID string
	for _, file := range snapshot.Files {
		if file.Kind == SourceERP {
			erpID = file.ID
		} else if file.Kind == SourceIntalev {
			intalevID = file.ID
		}
	}
	contextValue, err := base.store.CreateContext(createContextRequest{
		Organization: structuralSourceOrganizationName, OrganizationID: structuralSourceOrganizationID,
		OrganizationName: structuralSourceOrganizationName, OrganizationPath: "Холдинг / 9 Управляющая компания",
		Period: period, ERPFileID: erpID, IntalevFileID: intalevID,
	})
	if err != nil {
		t.Fatal(err)
	}
	run, err := base.store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	run.Status, run.Stage, run.Message, run.FinishedAt = RunCompletedReportOnly, "R005_COMPLETED", "Проверенный инвентарь R005 сформирован", &now
	if err := base.store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	r005Dir := filepath.Join(base.store.RunsDir(), run.ID, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	inventoryDocument := structuralSourceInventory(run.ID, contextValue.ID)
	inventoryDocument["inventory_id"] = inventoryID
	inventoryDocument["period"] = period
	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	bindingSHA := writePipelineStructuralInventoryDocument(t, base.store, run, contextValue, inventoryDocument)
	inventoryBytes, err := os.ReadFile(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	inventoryDigest := sha256.Sum256(inventoryBytes)
	inventorySHA := strings.ToUpper(hex.EncodeToString(inventoryDigest[:]))
	if err := base.store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err != nil {
		t.Fatalf("generated v2 visibility fixture is invalid: %v", err)
	}
	return structuralSourceTestContext{server: base.server, store: base.store, contextID: contextValue.ID, runID: run.ID,
		organizationID: structuralSourceOrganizationID, inventoryID: inventoryID, inventoryPath: inventoryPath, inventorySHA256: inventorySHA}
}

func TestStructuralControlHistoricalRunIsIsolatedFromCurrentRun(t *testing.T) {
	first := newStructuralSourceTestContext(t)
	firstVersion := fixedStructuralSourceVersion(t, first)
	second := addStructuralSourceRun(t, first, "SCI-NOV-2025-V1", "2025-11")

	status, registry, raw := structuralSourceRequest(t, second.server, http.MethodGet, "/api/structural-control-sets?run_id="+second.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("second registry failed: status=%d body=%s", status, raw)
	}
	revision := int64(registry["registry_revision"].(float64))
	draft := structuralSourceCreateDraft(t, second, "Та же группа в новом запуске", []string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, revision)
	status, fixed, raw := structuralSourceFixDraft(t, second, draft)
	if status != http.StatusCreated {
		t.Fatalf("historical members blocked the new run: status=%d body=%s", status, raw)
	}

	status, payload, raw := structuralSourceRequest(t, second.server, http.MethodPost, "/api/structural-control-sets/disable", map[string]any{
		"control_set_id": structuralSourceString(firstVersion["control_set_id"]), "organization_id": second.organizationID,
		"run_id": second.runID, "inventory_id": second.inventoryID, "reason": "Неверный чужой scope",
		"expected_registry_revision": fixed["registry_revision"],
	})
	if status != http.StatusConflict || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_SET_SCOPE_MISMATCH" {
		t.Fatalf("historical version disabled through another run: status=%d body=%s", status, raw)
	}

	status, registry, raw = structuralSourceRequest(t, second.server, http.MethodGet, "/api/structural-control-sets?run_id="+second.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("second registry reload failed: status=%d body=%s", status, raw)
	}
	events := structuralSourceSlice(registry["lifecycle_events"])
	if len(events) != 1 || structuralSourceString(structuralSourceMap(events[0])["run_id"]) != second.runID {
		t.Fatalf("public audit crossed run scope: %#v", events)
	}
}

func TestStructuralControlDisableRequiresReasonWithoutChangingAudit(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	version := fixedStructuralSourceVersion(t, context)
	status, registry, raw := structuralSourceRequest(t, context.server, http.MethodGet, "/api/structural-control-sets?run_id="+context.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("registry failed: status=%d body=%s", status, raw)
	}
	revision := registry["registry_revision"]
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/disable", map[string]any{
		"control_set_id": structuralSourceString(version["control_set_id"]), "organization_id": context.organizationID,
		"run_id": context.runID, "inventory_id": context.inventoryID, "reason": "   ",
		"expected_registry_revision": revision,
	})
	if status != http.StatusBadRequest || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_DISABLE_REASON_REQUIRED" {
		t.Fatalf("empty disable reason was accepted: status=%d body=%s", status, raw)
	}
	status, registry, raw = structuralSourceRequest(t, context.server, http.MethodGet, "/api/structural-control-sets?run_id="+context.runID, nil)
	if status != http.StatusOK || registry["registry_revision"] != revision || len(structuralSourceSlice(registry["lifecycle_events"])) != 1 {
		t.Fatalf("rejected disable changed registry: status=%d body=%s", status, raw)
	}
}

func TestStructuralControlFixedAuditSurvivesStoreAndServerRestart(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	version := fixedStructuralSourceVersion(t, context)
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
	status, registry, raw := structuralSourceRequest(t, reopenedServer, http.MethodGet, "/api/structural-control-sets?run_id="+context.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("restarted server lost registry: status=%d body=%s", status, raw)
	}
	events := structuralSourceSlice(registry["lifecycle_events"])
	if len(events) != 1 || structuralSourceString(structuralSourceMap(events[0])["control_set_id"]) != structuralSourceString(version["control_set_id"]) {
		t.Fatalf("restarted server lost exact fixed audit: %#v", events)
	}
}
