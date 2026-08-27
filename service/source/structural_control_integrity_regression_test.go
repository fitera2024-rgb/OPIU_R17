package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func structuralIntegrityRegistryPath(context structuralSourceTestContext) string {
	return filepath.Join(context.store.Root(), "structural-control-sets.json")
}

func structuralIntegrityBindingPath(context structuralSourceTestContext) string {
	return filepath.Join(context.store.RunsDir(), context.runID, "r005", "structural-control-inventory.binding.json")
}

func structuralIntegrityDocument(t *testing.T, context structuralSourceTestContext) map[string]any {
	t.Helper()
	data, err := os.ReadFile(structuralIntegrityRegistryPath(context))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document
}

func structuralIntegrityWriteDocument(t *testing.T, context structuralSourceTestContext, document map[string]any) {
	t.Helper()
	if err := atomicWriteJSON(structuralIntegrityRegistryPath(context), document); err != nil {
		t.Fatal(err)
	}
}

func structuralIntegritySHA256(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:]))
}

func structuralIntegrityFirstRecord(t *testing.T, document map[string]any, field string) map[string]any {
	t.Helper()
	items := structuralSourceSlice(document[field])
	if len(items) == 0 {
		t.Fatalf("registry field %s is empty: %#v", field, document)
	}
	item := structuralSourceMap(items[0])
	if item == nil {
		t.Fatalf("registry field %s does not contain an object: %#v", field, items[0])
	}
	return item
}

func structuralIntegrityExpectRegistryInvalid(t *testing.T, context structuralSourceTestContext) {
	t.Helper()
	path := "/api/structural-control-sets?organization_id=" + context.organizationID +
		"&run_id=" + context.runID + "&inventory_id=" + context.inventoryID
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodGet, path, nil)
	if status != http.StatusConflict || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_REGISTRY_INVALID" {
		t.Fatalf("corrupted registry was accepted: status=%d body=%s", status, raw)
	}
}

func TestStructuralControlIntegrityBindingByteDriftAfterAnchorIsBlocked(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	file, err := os.OpenFile(structuralIntegrityBindingPath(context), os.O_APPEND|os.O_WRONLY, 0o600)
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
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/preview", map[string]any{
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"intalev_members": intalev, "erp_members": erp,
		"mode": "SUM_DELTA_ONLY", "expected_control_delta": 0, "tolerance_cents": 1,
	})
	if status != http.StatusConflict || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_INVENTORY_STALE" {
		t.Fatalf("binding byte drift after anchor was accepted: status=%d body=%s", status, raw)
	}
}

func TestStructuralControlIntegrityDraftAndVersionPersistExactBindingSHA(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	bindingSHA := structuralIntegritySHA256(t, structuralIntegrityBindingPath(context))
	if strings.EqualFold(bindingSHA, context.inventorySHA256) {
		t.Fatal("fixture binding and inventory unexpectedly have the same SHA-256")
	}
	draftPayload := structuralSourceCreateDraft(t, context, "Exact binding SHA",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	document := structuralIntegrityDocument(t, context)
	draft := structuralIntegrityFirstRecord(t, document, "drafts")
	if got := structuralSourceString(draft["inventory_binding_sha256"]); !strings.EqualFold(got, bindingSHA) {
		t.Errorf("draft binding SHA=%q, want exact binding-file SHA=%q", got, bindingSHA)
	}
	if got := structuralSourceString(draft["inventory_binding_sha256"]); strings.EqualFold(got, context.inventorySHA256) {
		t.Errorf("draft persisted inventory SHA under inventory_binding_sha256: %s", got)
	}

	status, fixed, raw := structuralSourceFixDraft(t, context, draftPayload)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: status=%d body=%s", status, raw)
	}
	document = structuralIntegrityDocument(t, context)
	version := structuralIntegrityFirstRecord(t, document, "versions")
	if got := structuralSourceString(version["inventory_binding_sha256"]); !strings.EqualFold(got, bindingSHA) {
		t.Errorf("fixed version binding SHA=%q, want exact binding-file SHA=%q; response=%#v", got, bindingSHA, fixed)
	}
	if got := structuralSourceString(version["inventory_binding_sha256"]); strings.EqualFold(got, context.inventorySHA256) {
		t.Errorf("fixed version persisted inventory SHA under inventory_binding_sha256: %s", got)
	}
}

func TestStructuralControlIntegrityDraftTamperBeforeFixIsBlocked(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draftPayload := structuralSourceCreateDraft(t, context, "Tamper protected draft",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	document := structuralIntegrityDocument(t, context)
	draft := structuralIntegrityFirstRecord(t, document, "drafts")
	draft["mode"] = "POST_AND_RELEASE"
	draft["expected_control_delta"] = 1
	draft["tolerance_cents"] = -1
	structuralIntegrityWriteDocument(t, context, document)

	status, payload, raw := structuralSourceFixDraft(t, context, draftPayload)
	if status != http.StatusConflict || structuralSourceString(payload["error"]) != "STRUCTURAL_CONTROL_REGISTRY_INVALID" {
		t.Fatalf("tampered draft was fixed: status=%d body=%s", status, raw)
	}
}

func TestStructuralControlIntegrityDraftAndLifecycleEventsCarryPayloadHashes(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draftPayload := structuralSourceCreateDraft(t, context, "Integrity hashes",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	document := structuralIntegrityDocument(t, context)
	draft := structuralIntegrityFirstRecord(t, document, "drafts")
	if digest := structuralSourceString(draft["payload_sha256"]); !validSHA256(digest) {
		t.Errorf("draft has no valid payload_sha256: %#v", draft)
	}

	status, fixed, raw := structuralSourceFixDraft(t, context, draftPayload)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: status=%d body=%s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	status, _, raw = structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/disable", map[string]any{
		"control_set_id":  structuralSourceString(version["control_set_id"]),
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"reason": "Проверка integrity", "expected_registry_revision": fixed["registry_revision"],
	})
	if status != http.StatusOK {
		t.Fatalf("disable failed: status=%d body=%s", status, raw)
	}
	document = structuralIntegrityDocument(t, context)
	event := structuralIntegrityFirstRecord(t, document, "lifecycle_events")
	if digest := structuralSourceString(event["payload_sha256"]); !validSHA256(digest) {
		t.Errorf("lifecycle event has no valid payload_sha256: %#v", event)
	}
}

func TestStructuralControlIntegrityDuplicateLifecycleEventIsRejected(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draftPayload := structuralSourceCreateDraft(t, context, "Duplicate event",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, draftPayload)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: status=%d body=%s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	status, _, raw = structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets/disable", map[string]any{
		"control_set_id":  structuralSourceString(version["control_set_id"]),
		"organization_id": context.organizationID, "run_id": context.runID, "inventory_id": context.inventoryID,
		"reason": "Первое отключение", "expected_registry_revision": fixed["registry_revision"],
	})
	if status != http.StatusOK {
		t.Fatalf("disable failed: status=%d body=%s", status, raw)
	}
	document := structuralIntegrityDocument(t, context)
	events := structuralSourceSlice(document["lifecycle_events"])
	if len(events) != 2 {
		t.Fatalf("expected FIXED and DISABLED lifecycle events, got %#v", events)
	}
	document["lifecycle_events"] = append(events, events[0])
	structuralIntegrityWriteDocument(t, context, document)
	structuralIntegrityExpectRegistryInvalid(t, context)
}

func TestStructuralControlIntegrityForgedLifecycleEventIsRejected(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draftPayload := structuralSourceCreateDraft(t, context, "Forged event",
		[]string{"I-R045"}, []string{"E-R045"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, draftPayload)
	if status != http.StatusCreated {
		t.Fatalf("fix failed: status=%d body=%s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	document := structuralIntegrityDocument(t, context)
	document["lifecycle_events"] = []any{map[string]any{
		"event_id": "sc_event_forged_without_server_integrity",
		"action":   "DISABLED", "control_set_id": structuralSourceString(version["control_set_id"]),
		"organization_id": context.organizationID, "reason": "Подложное отключение",
		"created_at": time.Now().UTC(),
	}}
	structuralIntegrityWriteDocument(t, context, document)
	structuralIntegrityExpectRegistryInvalid(t, context)
}
