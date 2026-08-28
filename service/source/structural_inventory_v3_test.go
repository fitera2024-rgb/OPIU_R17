package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const structuralSourceInventoryV3ID = "SCI-OCT-2025-V3"

func structuralControlV3SafetyFixture() map[string]any {
	return map[string]any{
		"mode": "REPORT_ONLY", "posting_rows": 0, "ready_to_upload": false,
		"release_allowed": false, "execution_allowed": false, "live_1c_allowed": false,
	}
}

func structuralSourceInventoryV3(runID, contextID string) map[string]any {
	member := func(identity, parent, code, name, hierarchy, sourceFile, sourceSHA string, sourceRow int, amount int64, order, level int) map[string]any {
		return map[string]any{
			"identity": identity, "parent_identity": parent, "code": code,
			"source_identity":       fmt.Sprintf("%s|ОПИУ|%d", sourceSHA, sourceRow),
			"source_identity_scope": sourceSHA + "|ОПИУ|2025-10",
			"dimension_key":         "", "dimension_identity_status": "",
			"source": map[string]any{
				"file": sourceFile, "sheet": "ОПИУ", "row": sourceRow,
				"source_cell": fmt.Sprintf("A%d", sourceRow), "sha256": sourceSHA,
			},
			"name": name, "hierarchy_path": hierarchy, "amount_cents": amount,
			"source_order": order, "level": level, "is_group": true,
			"selectable_root": false, "candidate_selectable": true,
			"business_block_declared":   false,
			"semantic_status":           "BUSINESS_BLOCK_UNPROVEN",
			"requires_user_declaration": true, "correction_authority": false,
		}
	}
	intalevSHA := strings.Repeat("A", 64)
	erpSHA := strings.Repeat("B", 64)
	intalevMembers := []any{
		member("I-R045", "I-ROOT", "R045", "Финансовая деятельность", "ОПИУ / Финансовая деятельность", "intalev.xlsx", intalevSHA, 8, 12_000_000, 0, 2),
		member("I-R055", "I-ROOT", "R055", "Внереализационная деятельность", "ОПИУ / Внереализационная деятельность", "intalev.xlsx", intalevSHA, 9, 8_000_000, 1, 2),
	}
	erpMembers := []any{
		member("E-R045", "E-ROOT", "R045", "Финансовая деятельность ERP", "ОПИУ ERP / Финансовая деятельность", "erp.xlsx", erpSHA, 8, 15_000_000, 0, 2),
		member("E-R055", "E-ROOT", "R055", "Внереализационная деятельность ERP", "ОПИУ ERP / Внереализационная деятельность", "erp.xlsx", erpSHA, 9, 5_000_000, 1, 2),
	}
	intalevMemberSHA, _ := canonicalJSONSHA256(intalevMembers)
	erpMemberSHA, _ := canonicalJSONSHA256(erpMembers)
	return map[string]any{
		"schema_version": "opiu-structural-control-inventory.v3",
		"artifact_type":  "STRUCTURAL_CONTROL_INVENTORY", "status": "VERIFIED",
		"inventory_id": structuralSourceInventoryV3ID, "run_id": runID, "context_id": contextID,
		"organization": map[string]any{
			"id": structuralSourceOrganizationID, "name": structuralSourceOrganizationName,
			"path": "Холдинг / 9 Управляющая компания",
		},
		"period": "2025-10", "generated_at": "2026-08-25T00:00:00Z",
		"hierarchy_versions": map[string]any{"intalev": strings.Repeat("1", 64), "erp": strings.Repeat("2", 64)},
		"member_hashes":      map[string]any{"intalev": intalevMemberSHA, "erp": erpMemberSHA},
		"input_hashes": map[string]any{
			"intalev": []any{map[string]any{"file": "intalev.xlsx", "sha256": intalevSHA}},
			"erp":     []any{map[string]any{"file": "erp.xlsx", "sha256": erpSHA}},
		},
		"current_run_provenance": nil,
		"source_scope": map[string]any{
			"intalev": map[string]any{"node_count": 3, "root_count": 1, "sources": []any{map[string]any{"file": "intalev.xlsx", "sha256": intalevSHA, "sheets": []string{"ОПИУ"}, "first_row": 7, "last_row": 9}}},
			"erp":     map[string]any{"node_count": 3, "root_count": 1, "sources": []any{map[string]any{"file": "erp.xlsx", "sha256": erpSHA, "sheets": []string{"ОПИУ"}, "first_row": 7, "last_row": 9}}},
		},
		"intalev_members": intalevMembers, "erp_members": erpMembers,
		"blockers": []any{}, "default_behavior": "PROCESS_ALL_DISCREPANCIES",
		"optional_control_only": true, "correction_authority": false, "financial_rows": 0,
		"candidate_semantics":                     "USER_DECLARED_CONTROL_ONLY",
		"automatic_business_block_classification": false,
		"user_declaration_required":               true,
		"safety":                                  structuralControlV3SafetyFixture(),
	}
}

func refreshStructuralV3MemberHashes(t *testing.T, inventory map[string]any) {
	t.Helper()
	intalev, ok := inventory["intalev_members"].([]any)
	if !ok {
		t.Fatal("invalid Intalev member fixture")
	}
	erp, ok := inventory["erp_members"].([]any)
	if !ok {
		t.Fatal("invalid ERP member fixture")
	}
	intalevSHA, err := canonicalJSONSHA256(intalev)
	if err != nil {
		t.Fatal(err)
	}
	erpSHA, err := canonicalJSONSHA256(erp)
	if err != nil {
		t.Fatal(err)
	}
	inventory["member_hashes"] = map[string]any{"intalev": intalevSHA, "erp": erpSHA}
}

func newStructuralV3SourceTestContext(t *testing.T) structuralSourceTestContext {
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
	run.Status, run.Stage, run.Message, run.FinishedAt = RunCompletedReportOnly, "R005_COMPLETED", "v3", &now
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	inventory := structuralSourceInventoryV3(run.ID, contextValue.ID)
	bindingSHA := writePipelineStructuralInventoryDocument(t, store, run, contextValue, inventory)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err != nil {
		t.Fatalf("exact producer v3 was not accepted: %v", err)
	}
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	return structuralSourceTestContext{
		server: server, store: store, contextID: contextValue.ID, runID: run.ID,
		organizationID: contextValue.OrganizationID, inventoryID: structuralSourceInventoryV3ID,
		inventoryPath: filepath.Join(r005Dir, "structural-control-inventory.json"),
	}
}

func structuralV3DraftBody(context structuralSourceTestContext, declared bool) map[string]any {
	body := structuralSourceDraftBody(context, "Финансовые + внереализационные", []string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	body["control_only_declaration"] = declared
	return body
}

func TestStructuralInventoryV3AnchorsAndExposesOnlyUnprovenCandidates(t *testing.T) {
	context := newStructuralV3SourceTestContext(t)
	registry, raw := structuralSourceRegistry(t, context, context.server)
	for _, side := range []string{"intalev_members", "erp_members"} {
		members := structuralSourceSlice(registry[side])
		if len(members) != 2 {
			t.Fatalf("%s=%#v", side, members)
		}
		for _, value := range members {
			member := structuralSourceMap(value)
			if member["semantic_status"] != "BUSINESS_BLOCK_UNPROVEN" || member["candidate_selectable"] != true ||
				member["business_block_declared"] != false || member["requires_user_declaration"] != true ||
				member["correction_authority"] != false {
				t.Fatalf("unsafe public candidate: %#v", member)
			}
		}
	}
	for _, private := range []string{"sha256", "current_run_provenance", "input_hashes", "source_scope", "physical_source"} {
		if strings.Contains(strings.ToLower(raw), private) {
			t.Fatalf("public DTO leaked %s: %s", private, raw)
		}
	}
}

func TestStructuralInventoryV3RequiresExplicitControlOnlyDeclaration(t *testing.T) {
	context := newStructuralV3SourceTestContext(t)
	status, payload, _ := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets", structuralV3DraftBody(context, false))
	if status != http.StatusBadRequest || payload["error"] != "STRUCTURAL_CONTROL_DECLARATION_REQUIRED" {
		t.Fatalf("missing declaration status=%d payload=%#v", status, payload)
	}
	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodPost, "/api/structural-control-sets", structuralV3DraftBody(context, true))
	if status != http.StatusCreated {
		t.Fatalf("declared draft status=%d %s", status, raw)
	}
	draft := structuralSourceMap(payload["draft"])
	if draft["control_only_declared"] != true || draft["correction_authority"] != false || draft["source_inventory_schema"] != "opiu-structural-control-inventory.v3" {
		t.Fatalf("draft declaration was not persisted: %#v", draft)
	}
	status, fixed, raw := structuralSourceFixDraft(t, context, payload)
	if status != http.StatusCreated {
		t.Fatalf("fix status=%d %s", status, raw)
	}
	version := structuralSourceMap(fixed["fixed_version"])
	if version["control_only_declared"] != true || version["correction_authority"] != false {
		t.Fatalf("fixed version gained authority: %#v", version)
	}
}

func TestStructuralInventoryV3RejectsUnsafeCandidateSemantics(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"raw root", func(member map[string]any) { member["parent_identity"] = ""; member["level"] = 0 }},
		{"leaf", func(member map[string]any) { member["is_group"] = false }},
		{"selectable root", func(member map[string]any) { member["selectable_root"] = true }},
		{"candidate disabled", func(member map[string]any) { member["candidate_selectable"] = false }},
		{"business block predeclared", func(member map[string]any) { member["business_block_declared"] = true }},
		{"semantic guessed", func(member map[string]any) { member["semantic_status"] = "BUSINESS_BLOCK" }},
		{"declaration bypass", func(member map[string]any) { member["requires_user_declaration"] = false }},
		{"correction authority", func(member map[string]any) { member["correction_authority"] = true }},
		{"self parent", func(member map[string]any) { member["parent_identity"] = member["identity"] }},
		{"order gap", func(member map[string]any) { member["source_order"] = 9 }},
		{"fractional cents", func(member map[string]any) { member["amount_cents"] = 1.5 }},
		{"fractional level", func(member map[string]any) { member["level"] = 1.5 }},
		{"source identity missing", func(member map[string]any) { member["source_identity"] = "" }},
		{"source scope missing", func(member map[string]any) { member["source_identity_scope"] = "" }},
		{"source file drift", func(member map[string]any) { member["source"].(map[string]any)["file"] = "other.xlsx" }},
		{"source hash drift", func(member map[string]any) { member["source"].(map[string]any)["sha256"] = strings.Repeat("C", 64) }},
		{"source row outside scope", func(member map[string]any) { member["source"].(map[string]any)["row"] = 99 }},
		{"source cell missing", func(member map[string]any) { member["source"].(map[string]any)["source_cell"] = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, contextValue, run, _ := newPipelineStructuralContext(t)
			inventory := structuralSourceInventoryV3(run.ID, contextValue.ID)
			member := inventory["intalev_members"].([]any)[0].(map[string]any)
			test.mutate(member)
			refreshStructuralV3MemberHashes(t, inventory)
			writePipelineStructuralInventoryDocument(t, store, run, contextValue, inventory)
			if _, err := validateStructuralControlInventoryForAnchor(filepath.Join(store.RunsDir(), run.ID, "r005"), run, contextValue); err == nil {
				t.Fatal("unsafe v3 candidate was accepted")
			}
		})
	}
}

func TestStructuralInventoryV3MatchesProducerCrossLanguageFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "structural-control-inventory-v3.fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Inventory json.RawMessage `json:"inventory"`
		Binding   json.RawMessage `json:"binding"`
	}
	if err := decodeExactJSON(data, &fixture); err != nil {
		t.Fatal(err)
	}
	inventory, err := decodeStructuralControlInventory(fixture.Inventory)
	if err != nil {
		t.Fatalf("producer v3 inventory fixture rejected: %v", err)
	}
	binding, err := decodeStructuralControlBinding(fixture.Binding)
	if err != nil {
		t.Fatalf("producer v3 binding fixture rejected: %v", err)
	}
	if inventory.SchemaVersion != structuralControlInventorySchemaV3 || binding.SchemaVersion != structuralControlBindingSchemaV3 ||
		inventory.MemberHashes.Intalev != "D34BCD73CF881BB30BE6EDCC0CC93E15C28BF7AC174926A42BFF7BF82A360D0D" ||
		inventory.MemberHashes.ERP != "F573E44190BA0E3FD110903063EB34CE858CE25CF60436F81E2D822E0D8870B3" ||
		binding.MemberHashes != inventory.MemberHashes || len(inventory.IntalevMembers) != 1 || len(inventory.ERPMembers) != 1 {
		t.Fatalf("producer v3 fixture cross-link changed: inventory=%#v binding=%#v", inventory.MemberHashes, binding.MemberHashes)
	}
	for _, member := range append(inventory.IntalevMembers, inventory.ERPMembers...) {
		if member.SelectableRoot || !member.CandidateSelectable || member.SemanticStatus != structuralControlUnprovenSemantic || member.CorrectionAuthority {
			t.Fatalf("producer candidate gained unsafe authority: %#v", member)
		}
	}
}

func TestStructuralInventoryV3AcceptsNodeCanonicalSHAWithEmptyArticleAndRejectsTamper(t *testing.T) {
	const nodeCanonicalSHA = "19B235E5449644998949069786D5056E5DE3474F1A150128022BD74724253ABB"

	inventory := structuralSourceInventoryV3("RUN-NODE-SHA", "CONTEXT-NODE-SHA")
	intalevMembers := inventory["intalev_members"].([]any)
	emptyArticle := intalevMembers[0].(map[string]any)
	emptyArticle["name"] = "<пустое значение>"
	emptyArticle["hierarchy_path"] = "ОПИУ / <пустое значение>"

	actualSHA, err := canonicalJSONSHA256(intalevMembers)
	if err != nil {
		t.Fatal(err)
	}
	if actualSHA != nodeCanonicalSHA {
		t.Fatalf("Go canonical member SHA does not match Node: got %s want %s", actualSHA, nodeCanonicalSHA)
	}
	inventory["member_hashes"].(map[string]any)["intalev"] = nodeCanonicalSHA

	encoded, err := json.Marshal(inventory)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeStructuralControlInventory(encoded)
	if err != nil {
		t.Fatalf("v3 member with Node canonical SHA was rejected: %v", err)
	}
	if decoded.CanonicalMemberHashes.Intalev != nodeCanonicalSHA {
		t.Fatalf("accepted v3 member SHA changed: got %s want %s", decoded.CanonicalMemberHashes.Intalev, nodeCanonicalSHA)
	}

	emptyArticle["name"] = "<подменённое значение>"
	tampered, err := json.Marshal(inventory)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeStructuralControlInventory(tampered); err == nil || !strings.Contains(err.Error(), "member digest mismatch") {
		t.Fatalf("tampered v3 member did not fail closed: %v", err)
	}
}

func TestStructuralInventoryV3RejectsIncompleteTraceAndV2DoesNotWiden(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	v3 := structuralSourceInventoryV3(run.ID, contextValue.ID)
	v3["source_scope"].(map[string]any)["intalev"].(map[string]any)["sources"] = []any{}
	writePipelineStructuralInventoryDocument(t, store, run, contextValue, v3)
	if _, err := validateStructuralControlInventoryForAnchor(filepath.Join(store.RunsDir(), run.ID, "r005"), run, contextValue); err == nil {
		t.Fatal("v3 with incomplete source trace was accepted")
	}

	store, contextValue, run, _ = newPipelineStructuralContext(t)
	v2 := structuralSourceInventory(run.ID, contextValue.ID)
	v2["intalev_members"].([]any)[0].(map[string]any)["candidate_selectable"] = true
	refresh := v2["intalev_members"].([]any)
	memberSHA, err := canonicalJSONSHA256(refresh)
	if err != nil {
		t.Fatal(err)
	}
	v2["member_hashes"].(map[string]any)["intalev"] = memberSHA
	writePipelineStructuralInventoryDocument(t, store, run, contextValue, v2)
	if _, err := validateStructuralControlInventoryForAnchor(filepath.Join(store.RunsDir(), run.ID, "r005"), run, contextValue); err == nil {
		t.Fatal("v2 silently accepted a v3-only field")
	}
}

func TestStructuralInventoryV3BlockedDocumentNeverHasAuthority(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	blocked := structuralSourceInventoryV3(run.ID, contextValue.ID)
	blocked["status"] = "BLOCKED"
	blocked["blockers"] = []any{map[string]any{"code": "STRUCTURAL_INVENTORY_SOURCE_TRACE_INCOMPLETE"}}
	if err := atomicWriteJSON(filepath.Join(r005Dir, "structural-control-inventory.blocked.json"), blocked); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err == nil {
		t.Fatal("blocked v3 document created authority without a binding")
	}
}

func TestStructuralInventoryNewAnchorRequiresV3ButHistoricalV2RemainsReadable(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	bindingSHA := writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	pipeline := &Pipeline{store: store}
	if err := pipeline.anchorStructuralControlInventory(run, contextValue, r005Dir); err == nil || !strings.Contains(err.Error(), "requires binding v3") {
		t.Fatalf("new v2 anchor was not blocked: %v", err)
	}
	if _, ok := store.StructuralControlInventoryAnchor(run.ID); ok {
		t.Fatal("blocked new v2 anchor was persisted")
	}

	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	run.Status, run.Stage, run.FinishedAt = RunCompletedReportOnly, "R005_COMPLETED", &now
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	server := &Server{store: store}
	inventory, actualBindingSHA, err := server.loadStructuralControlInventory(contextValue.OrganizationID, run.ID, structuralSourceInventoryID)
	if err != nil {
		t.Fatalf("pre-existing immutable v2 anchor was not readable: %v", err)
	}
	if inventory.SchemaVersion != structuralControlInventorySchema || actualBindingSHA != bindingSHA {
		t.Fatalf("historical v2 scope changed: schema=%s binding=%s", inventory.SchemaVersion, actualBindingSHA)
	}
}
