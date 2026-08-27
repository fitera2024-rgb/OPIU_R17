package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

var _ = func(server *Server) {
	var _ http.HandlerFunc = server.handleEmptyArticleBindings
	var _ http.HandlerFunc = server.handleEmptyArticleBindingFix
	var _ http.HandlerFunc = server.handleEmptyArticleBindingDisable
}

const (
	emptyBindingOrganizationID     = "ORG-9"
	emptyBindingOrganizationName   = "9 Управляющая компания"
	emptyBindingOrganizationPath   = "Холдинг / 9 Управляющая компания"
	emptyBindingCatalogRunID       = "run_empty_binding_catalog_org9"
	emptyBindingCatalogContextID   = "ctx_empty_binding_catalog_org9"
	emptyBindingCatalogInventoryID = "SCI-EMPTY-BINDING-ORG9-2025"
	emptyBindingSourcePath         = "Расходы по основной деятельности ИТОГО / _Статьи ОПиУ 2025 / 1_Административные расходы / ФЗП и компенсационные выплаты"
	emptyBindingSourceParentPath   = emptyBindingSourcePath + " / <пустое значение>"
	emptyBindingERPTargetPath      = "Административные расходы / ФЗП и компенсационные выплаты / ФЗП"
	emptyBindingOtherSourcePath    = "Расходы по основной деятельности ИТОГО / Административные расходы"
	emptyBindingOtherParentPath    = emptyBindingOtherSourcePath + " / <пустое значение>"
	emptyBindingOtherERPTargetPath = "ERP / Административные расходы"
)

type emptyBindingCatalogFixture struct {
	RunID, ContextID, InventoryID, BindingSHA256 string
}

func installEmptyBindingVerifiedCatalog(t *testing.T, store *Store, suffix, organizationID, organizationName, organizationPath string) emptyBindingCatalogFixture {
	return installEmptyBindingVerifiedCatalogWithMutation(t, store, suffix, organizationID, organizationName, organizationPath, nil)
}

func installEmptyBindingVerifiedCatalogWithMutation(t *testing.T, store *Store, suffix, organizationID, organizationName, organizationPath string, mutate func(map[string]any)) emptyBindingCatalogFixture {
	t.Helper()
	fixture := emptyBindingCatalogFixture{
		RunID: "run_empty_binding_catalog_" + suffix, ContextID: "ctx_empty_binding_catalog_" + suffix,
		InventoryID: "SCI-EMPTY-BINDING-" + strings.ToUpper(suffix) + "-2025",
	}
	contextValue := Context{
		ID: fixture.ContextID, Organization: organizationName, OrganizationID: organizationID,
		OrganizationName: organizationName, OrganizationPath: organizationPath, Period: "2025-10",
	}
	finished := time.Now().UTC()
	run := Run{
		ID: fixture.RunID, ContextID: contextValue.ID, Status: RunCompletedReportOnly,
		Stage: "R005_COMPLETED", Message: "Проверенный справочник пустых статей", StartedAt: finished,
		FinishedAt: &finished, Safety: reportOnlySafety(),
	}
	store.state.Contexts[contextValue.ID] = contextValue
	store.state.Runs[run.ID] = run
	if err := store.saveLocked(); err != nil {
		t.Fatal(err)
	}
	inventory := structuralSourceInventoryV3(run.ID, contextValue.ID)
	inventory["inventory_id"] = fixture.InventoryID
	intalev := inventory["intalev_members"].([]any)
	intalev[0].(map[string]any)["identity"] = "INTALEV-CONTROL-R045"
	intalev[0].(map[string]any)["code"] = "R045"
	intalev[0].(map[string]any)["name"] = "Результат по финансовой деятельности"
	intalev[0].(map[string]any)["hierarchy_path"] = "ОПИУ / Результат по финансовой деятельности"
	intalev[1].(map[string]any)["identity"] = "INTALEV-R034"
	intalev[1].(map[string]any)["code"] = "R034"
	intalev[1].(map[string]any)["name"] = "Компенсации"
	intalev[1].(map[string]any)["hierarchy_path"] = "ОПИУ / Расходы / Компенсации"
	erp := inventory["erp_members"].([]any)
	erp[0].(map[string]any)["identity"] = "ERP-CONTROL-R055"
	erp[0].(map[string]any)["code"] = "R055"
	erp[0].(map[string]any)["name"] = "Результат по инвестиционной и внереализационной деятельности"
	erp[0].(map[string]any)["hierarchy_path"] = "ОПИУ ERP / Результат по инвестиционной и внереализационной деятельности"
	erp[1].(map[string]any)["identity"] = "ERP-R035"
	erp[1].(map[string]any)["code"] = "R035"
	erp[1].(map[string]any)["name"] = "НДФЛ"
	erp[1].(map[string]any)["hierarchy_path"] = "ОПИУ ERP / Расходы на персонал / НДФЛ"
	refreshStructuralV3MemberHashes(t, inventory)
	fixture.BindingSHA256 = writePipelineStructuralInventoryDocument(t, store, run, contextValue, inventory)
	fixture.BindingSHA256 = rewriteEmptyBindingRunCatalogAndBinding(t, store, run, contextValue, mutate)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err != nil {
		t.Fatalf("empty-article exact catalog was not verified: %v", err)
	}
	if err := store.AnchorStructuralControlInventory(run.ID, fixture.BindingSHA256); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func rewriteEmptyBindingRunCatalogAndBinding(t *testing.T, store *Store, run Run, contextValue Context, mutate func(map[string]any)) string {
	t.Helper()
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	var codex map[string]any
	if err := readJSONFile(codexPath, &codex); err != nil {
		t.Fatal(err)
	}
	codex["schema"] = "opiu-codex-review-input-v1"
	codex["report_only"] = true
	codex["posting_rows"] = 0
	codex["execution_allowed"] = false
	codex["ready_to_upload"] = false
	codex["release_allowed"] = false
	codex["live_1c_allowed"] = false
	codex["rows"] = []any{
		map[string]any{
			"code": "R033", "intalev_label": "ФЗП и компенсационные выплаты",
			"intalev_paths": []any{emptyBindingSourcePath, emptyBindingSourceParentPath},
			"erp_paths":     []any{"ERP / ФЗП и компенсационные выплаты"},
		},
		map[string]any{
			"code": "R036", "intalev_label": "ФЗП",
			"intalev_paths": []any{emptyBindingSourceParentPath},
			"erp_paths":     []any{emptyBindingERPTargetPath},
		},
		map[string]any{
			"code": "R001", "intalev_label": "Административные расходы",
			"intalev_paths": []any{emptyBindingOtherSourcePath, emptyBindingOtherParentPath},
			"erp_paths":     []any{emptyBindingOtherERPTargetPath},
		},
	}
	codex["hierarchy_periods"] = []any{map[string]any{
		"period": contextValue.Period,
		"intalev_tree": map[string]any{
			"status": "PASS",
			"nodes": []any{
				map[string]any{
					"node_id": "INTALEV-R033", "label": "<пустое значение>",
					"full_path": emptyBindingSourceParentPath,
				},
				map[string]any{
					"node_id": "INTALEV-R001", "label": "<пустое значение>",
					"full_path": emptyBindingOtherParentPath,
				},
			},
		},
		"erp_tree": map[string]any{
			"status": "PASS",
			"nodes": []any{
				map[string]any{
					"node_id": "ERP-R036", "label": "ФЗП", "full_path": emptyBindingERPTargetPath,
					"is_group": false, "immediate_children": []any{}, "source_row_role": "ARTICLE",
				},
				map[string]any{
					"node_id": "ERP-R001", "label": "Административные расходы", "full_path": emptyBindingOtherERPTargetPath,
					"is_group": false, "immediate_children": []any{}, "source_row_role": "ARTICLE",
				},
			},
		},
	}}
	items := make([]any, 0, 5)
	for _, label := range []string{"Заработная плата", "Отпускные", "Премия", "Больничный лист", "НДФЛ"} {
		items = append(items, map[string]any{
			"classification": "UNCLASSIFIED", "article": "", "period": contextValue.Period,
			"source_scope_role": "UNCLASSIFIED_DETAIL", "classification_basis": "EMPTY_ARTICLE_ANCESTOR",
			"source_scope_id":   contextValue.Period + "|SOURCE|TDSheet|123|123",
			"source_scope_path": emptyBindingSourcePath, "blank_branch_source_path": emptyBindingSourceParentPath,
			"source_parent_path": emptyBindingSourceParentPath,
			"source_path":        emptyBindingSourceParentPath + " / " + label, "source_label": label,
			"source_is_leaf": true,
		})
	}
	items = append(items, map[string]any{
		"classification": "UNCLASSIFIED", "article": "", "period": contextValue.Period,
		"source_scope_role": "UNCLASSIFIED_DETAIL", "classification_basis": "EMPTY_ARTICLE_ANCESTOR",
		"source_scope_id":   contextValue.Period + "|SOURCE|TDSheet|11|11",
		"source_scope_path": emptyBindingOtherSourcePath, "blank_branch_source_path": emptyBindingOtherParentPath,
		"source_parent_path": emptyBindingOtherParentPath,
		"source_path":        emptyBindingOtherParentPath + " / SSD-накопитель", "source_label": "SSD-накопитель",
		"source_is_leaf": true,
	})
	codex["intalev_source_scopes"] = []any{map[string]any{"unclassified_items": items}}
	if mutate != nil {
		mutate(codex)
	}
	if err := atomicWriteJSON(codexPath, codex); err != nil {
		t.Fatal(err)
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		t.Fatal(err)
	}

	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	var manifest map[string]any
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["codex_input_sha256"] = codexSHA
	if err := atomicWriteJSON(manifestPath, manifest); err != nil {
		t.Fatal(err)
	}
	manifestSHA, err := sha256File(manifestPath)
	if err != nil {
		t.Fatal(err)
	}

	inventoryPath := filepath.Join(r005Dir, "structural-control-inventory.json")
	var inventory map[string]any
	if err := readJSONFile(inventoryPath, &inventory); err != nil {
		t.Fatal(err)
	}
	current := inventory["current_run_provenance"].(map[string]any)
	current["codex_input"] = map[string]any{"file": codexPath, "sha256": codexSHA}
	current["manifest"] = map[string]any{"file": manifestPath, "sha256": manifestSHA}
	if err := atomicWriteJSON(inventoryPath, inventory); err != nil {
		t.Fatal(err)
	}
	inventorySHA, err := sha256File(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	provenanceSHA, err := canonicalJSONSHA256(current)
	if err != nil {
		t.Fatal(err)
	}

	bindingPath := filepath.Join(r005Dir, "structural-control-inventory.binding.json")
	var binding map[string]any
	if err := readJSONFile(bindingPath, &binding); err != nil {
		t.Fatal(err)
	}
	binding["sha256"] = inventorySHA
	binding["codex_input"] = current["codex_input"]
	binding["manifest"] = current["manifest"]
	binding["current_run_provenance_sha256"] = provenanceSHA
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
	bindingSHA, err := sha256File(bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	return strings.ToUpper(bindingSHA)
}

func emptyBindingTestServer(t *testing.T) (*Server, *Store, *Pipeline) {
	t.Helper()
	server, store, pipeline := testServer(t)
	fixture := installEmptyBindingVerifiedCatalog(t, store, "org9", emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	if fixture.RunID != emptyBindingCatalogRunID || fixture.ContextID != emptyBindingCatalogContextID || fixture.InventoryID != emptyBindingCatalogInventoryID {
		t.Fatalf("default catalog identity drifted: %#v", fixture)
	}
	return server, store, pipeline
}

func emptyBindingRequest(revision int64) emptyArticleBindingDraftRequest {
	return emptyArticleBindingDraftRequest{
		Name:                      "Зарплатные пустые статьи → ФЗП",
		OrganizationID:            emptyBindingOrganizationID,
		OrganizationName:          emptyBindingOrganizationName,
		OrganizationHierarchyPath: emptyBindingOrganizationPath,
		RunID:                     emptyBindingCatalogRunID,
		InventoryID:               emptyBindingCatalogInventoryID,
		ValidFromMonth:            "2025-01",
		ValidThroughMonth:         "2025-12",
		SourceParent: emptyArticleBindingNode{
			Identity: "INTALEV-R033", Code: "R033",
			HierarchyPath: emptyBindingSourceParentPath,
			Article:       "ФЗП и компенсационные выплаты",
		},
		SourceLabels: []string{"Заработная плата", "Отпускные", "Премия", "Больничный лист"},
		ERPTarget: emptyArticleBindingNode{
			Identity: "ERP-R036", Code: "R036",
			HierarchyPath: emptyBindingERPTargetPath,
			Article:       "ФЗП",
		},
		ExpectedRegistryRevision: revision,
	}
}

func emptyBindingSecondRequest(revision int64) emptyArticleBindingDraftRequest {
	request := emptyBindingRequest(revision)
	request.Name = "Оборудование без статьи → Административные расходы"
	request.SourceParent = emptyArticleBindingNode{
		Identity: "INTALEV-R001", Code: "R001", HierarchyPath: emptyBindingOtherParentPath,
		Article: "Административные расходы",
	}
	request.SourceLabels = []string{"SSD-накопитель"}
	request.ERPTarget = emptyArticleBindingNode{
		Identity: "ERP-R001", Code: "R001", HierarchyPath: emptyBindingOtherERPTargetPath,
		Article: "Административные расходы",
	}
	return request
}

func emptyBindingCall(t *testing.T, handler http.HandlerFunc, method, path string, body any) (int, map[string]any, string) {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	return emptyBindingCallRaw(t, handler, method, path, encoded)
}

func emptyBindingCallRaw(t *testing.T, handler http.HandlerFunc, method, path string, encoded []byte) (int, map[string]any, string) {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler(response, request)
	payload := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid JSON response %d: %s", response.Code, response.Body.String())
	}
	return response.Code, payload, response.Body.String()
}

func emptyBindingRouteCall(t *testing.T, server *Server, method, path string, body any) (int, map[string]any, string) {
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
		t.Fatalf("invalid routed JSON response %d: %s", response.Code, response.Body.String())
	}
	return response.Code, payload, response.Body.String()
}

func emptyBindingFixRequest(draftID string, revision int64) emptyArticleBindingFixRequest {
	return emptyArticleBindingFixRequest{
		DraftID: draftID, OrganizationID: emptyBindingOrganizationID,
		OrganizationName:          emptyBindingOrganizationName,
		OrganizationHierarchyPath: emptyBindingOrganizationPath,
		RunID:                     emptyBindingCatalogRunID,
		InventoryID:               emptyBindingCatalogInventoryID,
		ExpectedRegistryRevision:  revision,
	}
}

func emptyBindingListPath(id, name, hierarchyPath string) string {
	values := url.Values{}
	values.Set("organization_id", id)
	values.Set("organization_name", name)
	values.Set("organization_hierarchy_path", hierarchyPath)
	return "/api/empty-article-bindings?" + values.Encode()
}

func publicObject(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := parent[key].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object: %#v", key, parent[key])
	}
	return value
}

func publicString(t *testing.T, parent map[string]any, key string) string {
	t.Helper()
	value, ok := parent[key].(string)
	if !ok {
		t.Fatalf("%s is not a string: %#v", key, parent[key])
	}
	return value
}

func assertEmptyBindingPublicAuthority(t *testing.T, object map[string]any) {
	t.Helper()
	authority := publicObject(t, object, "authority")
	if authority["mode"] != "REPORT_ONLY" || authority["operation"] != "NO_POSTING" ||
		authority["financial_rows"] != float64(0) || authority["posting_rows"] != float64(0) ||
		authority["execution_allowed"] != false || authority["ready_to_upload"] != false ||
		authority["release_allowed"] != false || authority["live_1c_allowed"] != false ||
		authority["correction_authority"] != false {
		t.Fatalf("unsafe empty-article authority: %#v", authority)
	}
}

func assertEmptyBindingPublicSafety(t *testing.T, payload map[string]any) {
	t.Helper()
	safety := publicObject(t, payload, "safety")
	if safety["mode"] != "REPORT_ONLY" || safety["posting_rows"] != float64(0) ||
		safety["ready_to_upload"] != false || safety["release_allowed"] != false || safety["live_1c_allowed"] != false ||
		payload["execution_allowed"] != false {
		t.Fatalf("unsafe empty-article response safety: payload=%#v safety=%#v", payload, safety)
	}
}

func TestEmptyArticleBindingFixIsImmutablePrivateAndProofFreePublic(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	request := emptyBindingRequest(0)
	status, draftPayload, draftRaw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/api/empty-article-bindings", request)
	if status != http.StatusCreated {
		t.Fatalf("draft status = %d: %s", status, draftRaw)
	}
	draft := publicObject(t, draftPayload, "draft")
	draftID := publicString(t, draft, "draft_id")
	for _, forbidden := range []string{"payload_sha256", "provenance", "request_id", "inventory_binding_sha256", "catalog_sha256", store.Root()} {
		if strings.Contains(draftRaw, forbidden) {
			t.Fatalf("draft public projection exposed %q: %s", forbidden, draftRaw)
		}
	}

	privatePath := server.emptyArticleBindingRegistryPath()
	privateBytes, err := os.ReadFile(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	privateText := string(privateBytes)
	for _, required := range []string{"payload_sha256", "provenance", "inventory_binding_sha256", "catalog_sha256", "PENDING_EXPLICIT_FIX", "SERVICE_BUSINESS_SETTINGS"} {
		if !strings.Contains(privateText, required) {
			t.Fatalf("private registry lacks internally generated %q: %s", required, privateText)
		}
	}
	if info, err := os.Stat(privatePath); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("private registry mode = %o", info.Mode().Perm())
	}

	status, fixedPayload, fixedRaw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/api/empty-article-bindings/fix", emptyBindingFixRequest(draftID, 1))
	if status != http.StatusCreated {
		t.Fatalf("fix status = %d: %s", status, fixedRaw)
	}
	fixed := publicObject(t, fixedPayload, "fixed_version")
	bindingID := publicString(t, fixed, "binding_id")
	if fixed["status"] != "FIXED" || fixed["version"] != float64(1) {
		t.Fatalf("fixed identity = %#v", fixed)
	}
	catalog := publicObject(t, fixed, "catalog")
	if catalog["run_id"] != emptyBindingCatalogRunID || catalog["inventory_id"] != emptyBindingCatalogInventoryID || catalog["context_id"] != emptyBindingCatalogContextID {
		t.Fatalf("fixed catalog identity = %#v", catalog)
	}
	definition := publicObject(t, fixed, "definition")
	if definition["semantic_status"] != emptyArticleBindingSemanticStatus || definition["decision"] != emptyArticleBindingDecision || definition["operation"] != emptyArticleBindingOperation {
		t.Fatalf("fixed semantics = %#v", definition)
	}
	target := publicObject(t, definition, "erp_target")
	if target["identity"] != "ERP-R036" || target["code"] != "R036" || target["article"] != "ФЗП" {
		t.Fatalf("exact target = %#v", target)
	}
	labels, ok := definition["source_labels"].([]any)
	if !ok || len(labels) != 4 {
		t.Fatalf("source labels = %#v", definition["source_labels"])
	}
	for _, label := range labels {
		if label == "НДФЛ" {
			t.Fatalf("excluded НДФЛ leaked into binding: %#v", labels)
		}
	}
	authority := publicObject(t, fixed, "authority")
	if authority["mode"] != "REPORT_ONLY" || authority["operation"] != "NO_POSTING" ||
		authority["posting_rows"] != float64(0) || authority["execution_allowed"] != false ||
		authority["ready_to_upload"] != false || authority["release_allowed"] != false ||
		authority["live_1c_allowed"] != false || authority["correction_authority"] != false {
		t.Fatalf("unsafe public authority = %#v", authority)
	}
	for _, forbidden := range []string{"payload_sha256", "provenance", "request_id", "inventory_binding_sha256", "catalog_sha256", store.Root()} {
		if strings.Contains(fixedRaw, forbidden) {
			t.Fatalf("fixed public projection exposed %q: %s", forbidden, fixedRaw)
		}
	}

	reopenedStore, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	configureTestOrganizationCatalog(t, reopenedStore)
	reopenedPipeline, err := NewPipeline(reopenedStore)
	if err != nil {
		t.Fatal(err)
	}
	reopenedServer, err := NewServer(reopenedStore, reopenedPipeline)
	if err != nil {
		t.Fatal(err)
	}
	status, listed, listedRaw := emptyBindingCall(t, reopenedServer.handleEmptyArticleBindings, http.MethodGet,
		emptyBindingListPath(emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath), nil)
	if status != http.StatusOK {
		t.Fatalf("reopened list status = %d: %s", status, listedRaw)
	}
	versions, ok := listed["versions"].([]any)
	if !ok || len(versions) != 1 || versions[0].(map[string]any)["binding_id"] != bindingID {
		t.Fatalf("reopened versions = %#v", listed["versions"])
	}
	for _, forbidden := range []string{"payload_sha256", "provenance", "request_id", "inventory_binding_sha256", "catalog_sha256", store.Root()} {
		if strings.Contains(listedRaw, forbidden) {
			t.Fatalf("list public projection exposed %q: %s", forbidden, listedRaw)
		}
	}
}

func TestEmptyArticleBindingAcceptsExactUICatalogNodesOutsideStructuralMembers(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	inventory, _, err := server.loadStructuralControlInventory(emptyBindingOrganizationID, emptyBindingCatalogRunID, emptyBindingCatalogInventoryID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range append(append([]structuralControlMember{}, inventory.IntalevMembers...), inventory.ERPMembers...) {
		if member.Identity == "INTALEV-R033" || member.Identity == "ERP-R036" {
			t.Fatalf("UI catalog node leaked into structural-control members: %#v", member)
		}
	}
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("exact run-bound UI payload rejected: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 1 || len(registry.Drafts) != 1 {
		t.Fatalf("exact UI draft registry=%#v err=%v", registry, err)
	}
	draft := registry.Drafts[0]
	if draft.Definition.SourceParent.Identity != "INTALEV-R033" || draft.Definition.SourceParent.Code != "R033" ||
		draft.Definition.ERPTarget.Identity != "ERP-R036" || draft.Definition.ERPTarget.Article != "ФЗП" ||
		!validUpperSHA256(draft.Catalog.CatalogSHA256) || draft.Authority != emptyArticleNoPostingAuthority() {
		t.Fatalf("run-bound draft is not exact/report-only: %#v", draft)
	}
	if strings.Contains(raw, "catalog_sha256") || strings.Contains(raw, store.Root()) {
		t.Fatalf("private run catalog proof leaked into UI response: %s", raw)
	}
}

func TestEmptyArticleBindingRejectsFabricatedAndCrossParentSourceLeaves(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*emptyArticleBindingDraftRequest)
	}{
		{
			name: "fabricated direct API label",
			mutate: func(request *emptyArticleBindingDraftRequest) {
				request.SourceLabels = []string{"Заработная плата", "Выдуманная премия"}
			},
		},
		{
			name: "real leaf from different parent",
			mutate: func(request *emptyArticleBindingDraftRequest) {
				request.SourceParent = emptyArticleBindingNode{
					Identity: "INTALEV-R001", Code: "R001", HierarchyPath: emptyBindingOtherParentPath,
					Article: "Административные расходы",
				}
				request.SourceLabels = []string{"Заработная плата"}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, _, _ := emptyBindingTestServer(t)
			request := emptyBindingRequest(0)
			test.mutate(&request)
			status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
			if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_SOURCE_LABEL_CATALOG_MISMATCH" {
				t.Fatalf("unbound source leaf accepted: %d %#v %s", status, payload, raw)
			}
			registry, err := server.loadEmptyArticleBindingRegistry()
			if err != nil || registry.Revision != 0 || len(registry.Drafts) != 0 {
				t.Fatalf("source leaf rejection mutated registry: %#v err=%v", registry, err)
			}
		})
	}
}

func TestEmptyArticleBindingRejectsAmbiguousRunCatalog(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{
			name: "duplicate blank leaf",
			mutate: func(codex map[string]any) {
				scopes := codex["intalev_source_scopes"].([]any)
				items := scopes[0].(map[string]any)["unclassified_items"].([]any)
				duplicate := map[string]any{}
				for key, value := range items[0].(map[string]any) {
					duplicate[key] = value
				}
				scopes[0].(map[string]any)["unclassified_items"] = append(items, duplicate)
			},
		},
		{
			name: "duplicate ERP article node",
			mutate: func(codex map[string]any) {
				periods := codex["hierarchy_periods"].([]any)
				erpTree := periods[0].(map[string]any)["erp_tree"].(map[string]any)
				nodes := erpTree["nodes"].([]any)
				duplicate := map[string]any{}
				for key, value := range nodes[0].(map[string]any) {
					duplicate[key] = value
				}
				erpTree["nodes"] = append(nodes, duplicate)
			},
		},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, store, _ := testServer(t)
			installEmptyBindingVerifiedCatalogWithMutation(t, store, "ambiguous_"+strconv.Itoa(index), emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath, test.mutate)
			request := emptyBindingRequest(0)
			request.RunID = "run_empty_binding_catalog_ambiguous_" + strconv.Itoa(index)
			request.InventoryID = "SCI-EMPTY-BINDING-AMBIGUOUS_" + strconv.Itoa(index) + "-2025"
			status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
			if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED" {
				t.Fatalf("ambiguous run catalog accepted: %d %#v %s", status, payload, raw)
			}
		})
	}
}

func TestEmptyArticleBindingRoutesExposeBusinessProjectionOnly(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	status, draftPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("routed draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	status, fixedPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/fix", emptyBindingFixRequest(draftID, 1))
	if status != http.StatusCreated {
		t.Fatalf("routed fix = %d %s", status, raw)
	}
	bindingID := publicString(t, publicObject(t, fixedPayload, "fixed_version"), "binding_id")
	status, listed, raw := emptyBindingRouteCall(t, server, http.MethodGet,
		emptyBindingListPath(emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath), nil)
	if status != http.StatusOK || len(listed["versions"].([]any)) != 1 {
		t.Fatalf("routed list = %d %#v %s", status, listed, raw)
	}
	for _, forbidden := range []string{"payload_sha256", "provenance", "request_id", "inventory_binding_sha256", "catalog_sha256", store.Root()} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("routed public projection exposed %q: %s", forbidden, raw)
		}
	}
	disable := emptyArticleBindingDisableRequest{
		BindingID: bindingID, OrganizationID: emptyBindingOrganizationID,
		OrganizationName: emptyBindingOrganizationName, OrganizationHierarchyPath: emptyBindingOrganizationPath,
		Reason: "Настройка отключена пользователем", ExpectedRegistryRevision: 2,
	}
	status, disabled, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/disable", disable)
	if status != http.StatusOK || publicObject(t, disabled, "disabled_version")["status"] != "INACTIVE" {
		t.Fatalf("routed disable = %d %#v %s", status, disabled, raw)
	}
}

func TestEmptyArticleBindingHTTPMultipleCorrespondencesLifecycleIsolation(t *testing.T) {
	server, _, _ := emptyBindingTestServer(t)

	status, firstDraftPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("first draft = %d %s", status, raw)
	}
	assertEmptyBindingPublicSafety(t, firstDraftPayload)
	firstDraft := publicObject(t, firstDraftPayload, "draft")
	assertEmptyBindingPublicAuthority(t, firstDraft)
	firstDraftID := publicString(t, firstDraft, "draft_id")

	unsafeFix := emptyBindingFixRequest(firstDraftID, 1)
	unsafeFix.ReadyToUpload = true
	status, payload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/fix", unsafeFix)
	if status != http.StatusBadRequest || payload["error"] != "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY" {
		t.Fatalf("unsafe fix authority accepted: %d %#v %s", status, payload, raw)
	}
	status, firstFixedPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/fix", emptyBindingFixRequest(firstDraftID, 1))
	if status != http.StatusCreated {
		t.Fatalf("first fix = %d %s", status, raw)
	}
	assertEmptyBindingPublicSafety(t, firstFixedPayload)
	firstFixed := publicObject(t, firstFixedPayload, "fixed_version")
	assertEmptyBindingPublicAuthority(t, firstFixed)
	firstBindingID := publicString(t, firstFixed, "binding_id")
	firstLineageID := publicString(t, firstFixed, "lineage_id")

	status, secondDraftPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", emptyBindingSecondRequest(2))
	if status != http.StatusCreated {
		t.Fatalf("second independent draft = %d %s", status, raw)
	}
	secondDraft := publicObject(t, secondDraftPayload, "draft")
	assertEmptyBindingPublicAuthority(t, secondDraft)
	secondDraftID := publicString(t, secondDraft, "draft_id")
	status, secondFixedPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/fix", emptyBindingFixRequest(secondDraftID, 3))
	if status != http.StatusCreated {
		t.Fatalf("second independent fix = %d %s", status, raw)
	}
	secondFixed := publicObject(t, secondFixedPayload, "fixed_version")
	assertEmptyBindingPublicAuthority(t, secondFixed)
	secondBindingID := publicString(t, secondFixed, "binding_id")
	secondLineageID := publicString(t, secondFixed, "lineage_id")
	if firstBindingID == secondBindingID || firstLineageID == secondLineageID {
		t.Fatalf("independent mappings share identity: first=%#v second=%#v", firstFixed, secondFixed)
	}

	listPath := emptyBindingListPath(emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	status, listed, raw := emptyBindingRouteCall(t, server, http.MethodGet, listPath, nil)
	if status != http.StatusOK {
		t.Fatalf("two-mapping list = %d %s", status, raw)
	}
	assertEmptyBindingPublicSafety(t, listed)
	versions := listed["versions"].([]any)
	if len(versions) != 2 || listed["registry_revision"] != float64(4) {
		t.Fatalf("independent versions not preserved: %#v", listed)
	}
	for _, rawVersion := range versions {
		version := rawVersion.(map[string]any)
		if version["status"] != "FIXED" {
			t.Fatalf("independent version is not active: %#v", version)
		}
		assertEmptyBindingPublicAuthority(t, version)
	}

	edit := emptyBindingRequest(4)
	edit.SourceBindingID = firstBindingID
	edit.Name = "Зарплатные пустые статьи → ФЗП (уточнено)"
	status, editDraftPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", edit)
	if status != http.StatusCreated {
		t.Fatalf("edit-as-new-version draft = %d %s", status, raw)
	}
	editDraftID := publicString(t, publicObject(t, editDraftPayload, "draft"), "draft_id")
	status, editFixedPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/fix", emptyBindingFixRequest(editDraftID, 5))
	if status != http.StatusCreated {
		t.Fatalf("edit-as-new-version fix = %d %s", status, raw)
	}
	edited := publicObject(t, editFixedPayload, "fixed_version")
	assertEmptyBindingPublicAuthority(t, edited)
	editedBindingID := publicString(t, edited, "binding_id")
	if edited["version"] != float64(2) || edited["lineage_id"] != firstLineageID || editedBindingID == firstBindingID {
		t.Fatalf("edited lineage/version is not immutable: first=%#v edited=%#v", firstFixed, edited)
	}

	status, listed, raw = emptyBindingRouteCall(t, server, http.MethodGet, listPath, nil)
	if status != http.StatusOK {
		t.Fatalf("post-edit list = %d %s", status, raw)
	}
	versions = listed["versions"].([]any)
	statuses := map[string]string{}
	for _, rawVersion := range versions {
		version := rawVersion.(map[string]any)
		statuses[publicString(t, version, "binding_id")] = publicString(t, version, "status")
	}
	if len(versions) != 3 || statuses[firstBindingID] != "INACTIVE" || statuses[editedBindingID] != "FIXED" || statuses[secondBindingID] != "FIXED" {
		t.Fatalf("edit overwrote another correspondence: versions=%#v statuses=%#v", versions, statuses)
	}

	unsafeDisable := emptyArticleBindingDisableRequest{
		BindingID: editedBindingID, OrganizationID: emptyBindingOrganizationID,
		OrganizationName: emptyBindingOrganizationName, OrganizationHierarchyPath: emptyBindingOrganizationPath,
		Reason: "Проверка authority gate", ExpectedRegistryRevision: 6, Live1CAllowed: true,
	}
	status, payload, raw = emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/disable", unsafeDisable)
	if status != http.StatusBadRequest || payload["error"] != "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY" {
		t.Fatalf("unsafe disable authority accepted: %d %#v %s", status, payload, raw)
	}
	disable := unsafeDisable
	disable.Live1CAllowed = false
	disable.Reason = "Соответствие отключено пользователем"
	status, disabledPayload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings/disable", disable)
	if status != http.StatusOK {
		t.Fatalf("disable edited first mapping = %d %s", status, raw)
	}
	assertEmptyBindingPublicSafety(t, disabledPayload)
	assertEmptyBindingPublicAuthority(t, publicObject(t, disabledPayload, "disabled_version"))

	status, listed, raw = emptyBindingRouteCall(t, server, http.MethodGet, listPath, nil)
	if status != http.StatusOK {
		t.Fatalf("final list = %d %s", status, raw)
	}
	versions = listed["versions"].([]any)
	statuses = map[string]string{}
	for _, rawVersion := range versions {
		version := rawVersion.(map[string]any)
		statuses[publicString(t, version, "binding_id")] = publicString(t, version, "status")
		assertEmptyBindingPublicAuthority(t, version)
	}
	if len(versions) != 3 || statuses[firstBindingID] != "INACTIVE" || statuses[editedBindingID] != "INACTIVE" || statuses[secondBindingID] != "FIXED" ||
		listed["registry_revision"] != float64(7) {
		t.Fatalf("disable erased or overwrote correspondence: versions=%#v statuses=%#v", versions, statuses)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || len(registry.Versions) != 3 {
		t.Fatalf("private multi-mapping registry invalid: versions=%d err=%v", len(registry.Versions), err)
	}
	for _, version := range registry.Versions {
		if version.Authority != emptyArticleNoPostingAuthority() {
			t.Fatalf("private version gained posting authority: %#v", version)
		}
	}
}

func TestEmptyArticleBindingHTTPRejectsCrossScopeAndEveryAuthorityEscalation(t *testing.T) {
	authorityTests := []struct {
		name   string
		mutate func(*emptyArticleBindingDraftRequest)
	}{
		{"posting rows", func(request *emptyArticleBindingDraftRequest) { request.PostingRows = 1 }},
		{"execution", func(request *emptyArticleBindingDraftRequest) { request.ExecutionAllowed = true }},
		{"ready to upload", func(request *emptyArticleBindingDraftRequest) { request.ReadyToUpload = true }},
		{"release", func(request *emptyArticleBindingDraftRequest) { request.ReleaseAllowed = true }},
		{"live 1C", func(request *emptyArticleBindingDraftRequest) { request.Live1CAllowed = true }},
		{"correction authority", func(request *emptyArticleBindingDraftRequest) { request.CorrectionAuthority = true }},
	}
	for _, test := range authorityTests {
		t.Run(test.name, func(t *testing.T) {
			server, _, _ := emptyBindingTestServer(t)
			request := emptyBindingRequest(0)
			test.mutate(&request)
			status, payload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", request)
			if status != http.StatusBadRequest || payload["error"] != "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY" {
				t.Fatalf("authority escalation accepted: %d %#v %s", status, payload, raw)
			}
			registry, err := server.loadEmptyArticleBindingRegistry()
			if err != nil || registry.Revision != 0 || len(registry.Drafts) != 0 || len(registry.Versions) != 0 {
				t.Fatalf("authority rejection mutated registry: %#v err=%v", registry, err)
			}
		})
	}

	server, store, _ := emptyBindingTestServer(t)
	if err := store.ConfigureOrganizationCatalog([]organizationNode{
		{ID: emptyBindingOrganizationID, Name: emptyBindingOrganizationName, Path: emptyBindingOrganizationPath, Selectable: true},
		{ID: "ORG-1", Name: "1 Хабаровск", Path: "Холдинг / 1 Хабаровск", Selectable: true},
	}); err != nil {
		t.Fatal(err)
	}
	replayed := installEmptyBindingVerifiedCatalog(t, store, "org9_http_replayed", emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	crossScopeTests := []struct {
		name   string
		mutate func(*emptyArticleBindingDraftRequest)
	}{
		{
			name: "cross run",
			mutate: func(request *emptyArticleBindingDraftRequest) {
				request.RunID = replayed.RunID
			},
		},
		{
			name: "cross inventory",
			mutate: func(request *emptyArticleBindingDraftRequest) {
				request.InventoryID = replayed.InventoryID
			},
		},
		{
			name: "cross organization",
			mutate: func(request *emptyArticleBindingDraftRequest) {
				request.OrganizationID = "ORG-1"
				request.OrganizationName = "1 Хабаровск"
				request.OrganizationHierarchyPath = "Холдинг / 1 Хабаровск"
			},
		},
	}
	for _, test := range crossScopeTests {
		t.Run(test.name, func(t *testing.T) {
			request := emptyBindingRequest(0)
			test.mutate(&request)
			status, payload, raw := emptyBindingRouteCall(t, server, http.MethodPost, "/api/empty-article-bindings", request)
			if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED" {
				t.Fatalf("cross-scope request accepted: %d %#v %s", status, payload, raw)
			}
		})
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 0 || len(registry.Drafts) != 0 || len(registry.Versions) != 0 {
		t.Fatalf("cross-scope rejection mutated registry: %#v err=%v", registry, err)
	}
}

func TestEmptyArticleBindingNewVersionSupersedesWithoutMutatingPriorVersion(t *testing.T) {
	server, _, _ := emptyBindingTestServer(t)
	status, draftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	status, fixedPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", emptyBindingFixRequest(draftID, 1))
	if status != http.StatusCreated {
		t.Fatalf("fix = %d %s", status, raw)
	}
	first := publicObject(t, fixedPayload, "fixed_version")
	firstID := publicString(t, first, "binding_id")

	replacement := emptyBindingRequest(2)
	replacement.SourceBindingID = firstID
	replacement.Name = "Новая версия зарплатной привязки"
	status, replacementDraftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", replacement)
	if status != http.StatusCreated {
		t.Fatalf("replacement draft = %d %s", status, raw)
	}
	replacementDraftID := publicString(t, publicObject(t, replacementDraftPayload, "draft"), "draft_id")
	status, secondPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", emptyBindingFixRequest(replacementDraftID, 3))
	if status != http.StatusCreated {
		t.Fatalf("replacement fix = %d %s", status, raw)
	}
	second := publicObject(t, secondPayload, "fixed_version")
	if second["version"] != float64(2) || second["lineage_id"] != first["lineage_id"] || second["binding_id"] == firstID {
		t.Fatalf("replacement version = %#v; first = %#v", second, first)
	}

	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil {
		t.Fatal(err)
	}
	if len(registry.Versions) != 2 || registry.Versions[0].Version != 1 || registry.Versions[0].Definition.Name != "Зарплатные пустые статьи → ФЗП" || registry.Versions[1].Version != 2 {
		t.Fatalf("immutable versions = %#v", registry.Versions)
	}
	active := emptyArticleBindingActiveVersions(registry)
	if active[registry.Versions[0].BindingID] || !active[registry.Versions[1].BindingID] {
		t.Fatalf("active versions = %#v", active)
	}
	status, listed, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodGet,
		emptyBindingListPath(emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath), nil)
	if status != http.StatusOK {
		t.Fatalf("list = %d %s", status, raw)
	}
	versions := listed["versions"].([]any)
	if len(versions) != 2 || versions[0].(map[string]any)["status"] != "INACTIVE" || versions[1].(map[string]any)["status"] != "FIXED" {
		t.Fatalf("public version statuses = %#v", versions)
	}
}

func TestEmptyArticleBindingRejectsUnsafeAmbiguousAndForgedInternalInput(t *testing.T) {
	tests := []struct {
		name     string
		mutate   func(*emptyArticleBindingDraftRequest)
		wantCode int
		wantErr  string
	}{
		{
			name: "unsafe posting", mutate: func(request *emptyArticleBindingDraftRequest) { request.PostingRows = 1 },
			wantCode: http.StatusBadRequest, wantErr: "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY",
		},
		{
			name: "organization mismatch", mutate: func(request *emptyArticleBindingDraftRequest) {
				request.OrganizationName = "Выдуманная организация"
			},
			wantCode: http.StatusConflict, wantErr: "EMPTY_ARTICLE_BINDING_ORGANIZATION_MISMATCH",
		},
		{
			name: "invalid validity", mutate: func(request *emptyArticleBindingDraftRequest) { request.ValidFromMonth = "2025-13" },
			wantCode: http.StatusBadRequest, wantErr: "EMPTY_ARTICLE_BINDING_VALIDITY_INVALID",
		},
		{
			name: "duplicate normalized label", mutate: func(request *emptyArticleBindingDraftRequest) {
				request.SourceLabels = []string{"Отпускные", "  отпускные  "}
			},
			wantCode: http.StatusBadRequest, wantErr: "EMPTY_ARTICLE_BINDING_SOURCE_LABEL_DUPLICATE",
		},
		{
			name: "incomplete exact target", mutate: func(request *emptyArticleBindingDraftRequest) { request.ERPTarget.Identity = "" },
			wantCode: http.StatusBadRequest, wantErr: "EMPTY_ARTICLE_BINDING_ERP_TARGET_INVALID",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, _, _ := emptyBindingTestServer(t)
			request := emptyBindingRequest(0)
			test.mutate(&request)
			status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
			if status != test.wantCode || payload["error"] != test.wantErr {
				t.Fatalf("status/payload = %d %#v: %s", status, payload, raw)
			}
		})
	}

	server, _, _ := emptyBindingTestServer(t)
	encoded, err := json.Marshal(emptyBindingRequest(0))
	if err != nil {
		t.Fatal(err)
	}
	forged := append(encoded[:len(encoded)-1], []byte(`,"approval_status":"FIXED","provenance":{"actor":"OWNER"}}`)...)
	status, payload, raw := emptyBindingCallRaw(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", forged)
	if status != http.StatusBadRequest || payload["error"] != "EMPTY_ARTICLE_BINDING_REQUEST_INVALID" {
		t.Fatalf("forged internal fields accepted: %d %#v %s", status, payload, raw)
	}
}

func TestEmptyArticleBindingRejectsUnboundFabricatedCatalogNodes(t *testing.T) {
	server, _, _ := testServer(t)
	request := emptyBindingRequest(0)
	request.RunID = ""
	request.InventoryID = ""
	request.SourceParent = emptyArticleBindingNode{
		Identity: "FABRICATED-INTALEV", Code: "R999",
		HierarchyPath: "Выдуманный Инталев / Выдуманный родитель", Article: "Выдуманный родитель",
	}
	request.ERPTarget = emptyArticleBindingNode{
		Identity: "FABRICATED-ERP", Code: "R998",
		HierarchyPath: "Выдуманный ERP / Выдуманная статья", Article: "Выдуманная статья",
	}
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
	if status != http.StatusBadRequest || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_SCOPE_REQUIRED" {
		t.Fatalf("unbound fabricated catalog nodes accepted: %d %#v %s", status, payload, raw)
	}
}

func TestEmptyArticleBindingRejectsFabricatedNodesAgainstVerifiedCatalog(t *testing.T) {
	server, _, _ := emptyBindingTestServer(t)
	request := emptyBindingRequest(0)
	request.SourceParent = emptyArticleBindingNode{
		Identity: "FABRICATED-INTALEV", Code: "R999",
		HierarchyPath: "Выдуманный Инталев / Выдуманный родитель", Article: "Выдуманный родитель",
	}
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_SOURCE_PARENT_CATALOG_MISMATCH" {
		t.Fatalf("fabricated source node accepted: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 0 || len(registry.Drafts) != 0 {
		t.Fatalf("rejected fabricated node mutated registry: revision=%d drafts=%d err=%v", registry.Revision, len(registry.Drafts), err)
	}
}

func TestEmptyArticleBindingRejectsCrossOrganizationCatalogRun(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	if err := store.ConfigureOrganizationCatalog([]organizationNode{
		{ID: emptyBindingOrganizationID, Name: emptyBindingOrganizationName, Path: emptyBindingOrganizationPath, Selectable: true},
		{ID: "ORG-1", Name: "1 Хабаровск", Path: "Холдинг / 1 Хабаровск", Selectable: true},
	}); err != nil {
		t.Fatal(err)
	}
	request := emptyBindingRequest(0)
	request.OrganizationID = "ORG-1"
	request.OrganizationName = "1 Хабаровск"
	request.OrganizationHierarchyPath = "Холдинг / 1 Хабаровск"
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", request)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED" {
		t.Fatalf("cross-organization catalog run accepted: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 0 || len(registry.Drafts) != 0 {
		t.Fatalf("cross-organization rejection mutated registry: revision=%d drafts=%d err=%v", registry.Revision, len(registry.Drafts), err)
	}
}

func TestEmptyArticleBindingFixRejectsDifferentVerifiedRunCatalog(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	status, draftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	otherCatalog := installEmptyBindingVerifiedCatalog(t, store, "org9_replayed", emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath)
	fix := emptyBindingFixRequest(draftID, 1)
	fix.RunID = otherCatalog.RunID
	fix.InventoryID = otherCatalog.InventoryID
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", fix)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_DRAFT_CATALOG_STALE" {
		t.Fatalf("draft fixed through a different verified run: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 1 || len(registry.Drafts) != 1 || len(registry.Versions) != 0 {
		t.Fatalf("different-run fix mutated registry: revision=%d drafts=%d versions=%d err=%v", registry.Revision, len(registry.Drafts), len(registry.Versions), err)
	}
}

func TestEmptyArticleBindingFixRejectsStaleRunInventoryWithoutPosting(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	status, draftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	inventoryPath := filepath.Join(store.RunsDir(), emptyBindingCatalogRunID, "r005", "structural-control-inventory.json")
	file, err := os.OpenFile(inventoryPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", emptyBindingFixRequest(draftID, 1))
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED" {
		t.Fatalf("stale inventory fixed: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 1 || len(registry.Drafts) != 1 || len(registry.Versions) != 0 {
		t.Fatalf("stale fix mutated registry: revision=%d drafts=%d versions=%d err=%v", registry.Revision, len(registry.Drafts), len(registry.Versions), err)
	}
	if registry.Drafts[0].Authority != emptyArticleNoPostingAuthority() {
		t.Fatalf("stale fix changed REPORT_ONLY authority: %#v", registry.Drafts[0].Authority)
	}
}

func TestEmptyArticleBindingFixRevalidatesExactRunCatalogWithoutPosting(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	status, draftPayload, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("draft = %d %s", status, raw)
	}
	draftID := publicString(t, publicObject(t, draftPayload, "draft"), "draft_id")
	codexPath := filepath.Join(store.RunsDir(), emptyBindingCatalogRunID, "r005", "reconciliation.codex-input.json")
	file, err := os.OpenFile(codexPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	status, payload, raw := emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", emptyBindingFixRequest(draftID, 1))
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED" {
		t.Fatalf("drifted exact run catalog was fixed: %d %#v %s", status, payload, raw)
	}
	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil || registry.Revision != 1 || len(registry.Drafts) != 1 || len(registry.Versions) != 0 {
		t.Fatalf("drifted catalog fix mutated registry: revision=%d drafts=%d versions=%d err=%v", registry.Revision, len(registry.Drafts), len(registry.Versions), err)
	}
	if registry.Drafts[0].Authority != emptyArticleNoPostingAuthority() {
		t.Fatalf("catalog drift changed REPORT_ONLY authority: %#v", registry.Drafts[0].Authority)
	}
}

func TestEmptyArticleBindingScopeOverlapCASIsolationDisableAndTamperDetection(t *testing.T) {
	server, store, _ := emptyBindingTestServer(t)
	if err := store.ConfigureOrganizationCatalog([]organizationNode{
		{ID: emptyBindingOrganizationID, Name: emptyBindingOrganizationName, Path: emptyBindingOrganizationPath, Selectable: true},
		{ID: "ORG-1", Name: "1 Хабаровск", Path: "Холдинг / 1 Хабаровск", Selectable: true},
	}); err != nil {
		t.Fatal(err)
	}
	otherCatalog := installEmptyBindingVerifiedCatalog(t, store, "org1", "ORG-1", "1 Хабаровск", "Холдинг / 1 Хабаровск")
	status, firstDraft, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", emptyBindingRequest(0))
	if status != http.StatusCreated {
		t.Fatalf("first draft = %d %s", status, raw)
	}
	firstDraftID := publicString(t, publicObject(t, firstDraft, "draft"), "draft_id")
	status, _, raw = emptyBindingCall(t, server.handleEmptyArticleBindingFix, http.MethodPost, "/fix", emptyBindingFixRequest(firstDraftID, 1))
	if status != http.StatusCreated {
		t.Fatalf("first fix = %d %s", status, raw)
	}

	stale := emptyBindingRequest(0)
	status, payload, _ := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", stale)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_REGISTRY_REVISION_CONFLICT" {
		t.Fatalf("stale CAS = %d %#v", status, payload)
	}
	overlap := emptyBindingRequest(2)
	status, payload, _ = emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", overlap)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_SCOPE_OVERLAP" {
		t.Fatalf("overlap = %d %#v", status, payload)
	}

	other := emptyBindingRequest(2)
	other.OrganizationID = "ORG-1"
	other.OrganizationName = "1 Хабаровск"
	other.OrganizationHierarchyPath = "Холдинг / 1 Хабаровск"
	other.RunID = otherCatalog.RunID
	other.InventoryID = otherCatalog.InventoryID
	status, otherDraft, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodPost, "/draft", other)
	if status != http.StatusCreated {
		t.Fatalf("other organization draft = %d %s", status, raw)
	}
	status, listed, raw := emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodGet,
		emptyBindingListPath("ORG-1", "1 Хабаровск", "Холдинг / 1 Хабаровск"), nil)
	if status != http.StatusOK {
		t.Fatalf("other organization list = %d %s", status, raw)
	}
	if len(listed["versions"].([]any)) != 0 || len(listed["drafts"].([]any)) != 1 ||
		listed["drafts"].([]any)[0].(map[string]any)["draft_id"] != publicObject(t, otherDraft, "draft")["draft_id"] {
		t.Fatalf("organization isolation failed: %#v", listed)
	}

	registry, err := server.loadEmptyArticleBindingRegistry()
	if err != nil {
		t.Fatal(err)
	}
	firstBindingID := registry.Versions[0].BindingID
	disable := emptyArticleBindingDisableRequest{
		BindingID: firstBindingID, OrganizationID: emptyBindingOrganizationID,
		OrganizationName: emptyBindingOrganizationName, OrganizationHierarchyPath: emptyBindingOrganizationPath,
		Reason: "Настройка больше не применяется", ExpectedRegistryRevision: 3,
	}
	status, disabled, raw := emptyBindingCall(t, server.handleEmptyArticleBindingDisable, http.MethodPost, "/disable", disable)
	if status != http.StatusOK {
		t.Fatalf("disable = %d %s", status, raw)
	}
	if publicObject(t, disabled, "disabled_version")["status"] != "INACTIVE" {
		t.Fatalf("disabled version = %#v", disabled)
	}

	registry, err = server.loadEmptyArticleBindingRegistry()
	if err != nil {
		t.Fatal(err)
	}
	registry.Versions[0].Definition.ERPTarget.Article = "Подменённая статья"
	if err := atomicWritePrivateJSON(server.emptyArticleBindingRegistryPath(), registry); err != nil {
		t.Fatal(err)
	}
	status, payload, raw = emptyBindingCall(t, server.handleEmptyArticleBindings, http.MethodGet,
		emptyBindingListPath(emptyBindingOrganizationID, emptyBindingOrganizationName, emptyBindingOrganizationPath), nil)
	if status != http.StatusConflict || payload["error"] != "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID" {
		t.Fatalf("tampered registry accepted: %d %#v %s", status, payload, raw)
	}
}
