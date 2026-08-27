package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExternalR005ConfigurationRequiresExactScopePlaceholders(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_RUNTIME_ROOT", "")
	t.Setenv("OPIU_R005_CMD_JSON", `["r005"]`)
	t.Setenv("OPIU_RULES_CMD_JSON", `["rules"]`)
	t.Setenv("OPIU_R001_CMD_JSON", `["r001"]`)
	if _, err := NewPipeline(store); err == nil {
		t.Fatal("external R005 command without exact run/context/organization placeholders was accepted")
	}
}

func TestPublicJSONRejectsDuplicateAuthorityKeys(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/structural-control-sets", strings.NewReader(`{"run_id":"trusted","run_id":"forged"}`))
	var target struct {
		RunID string `json:"run_id"`
	}
	if err := readJSON(request, &target); err == nil {
		t.Fatal("public JSON accepted a duplicate authority key")
	}
}

func TestContextCreationRejectsOrganizationOutsideAuthoritativeRuntimeCatalog(t *testing.T) {
	root := makeRuntimeFixture(t)
	catalogPath := filepath.Join(root, "data", "defaults", "organizations.json")
	if err := os.WriteFile(catalogPath, []byte(`{
		"schema_version":"opiu-organizations.v1",
		"source":{"path":"../../resources/reference/organizations.xlsx","sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","sheet":"Лист_1","rows":1,"title":"Организации","distribution_seed":"1.9.4"},
		"nodes":[{"node_id":"ORG-9","code":"9","name":"9 Управляющая компания","path":"Холдинг / 9 Управляющая компания","parent_id":"","top_id":"ORG-9","top_name":"9 Управляющая компания","depth":0,"node_type":"ORGANIZATION","selectable":true,"source_row":1,"source_verified":true,"metadata":{"inn":""},"has_children":false,"node_name":"9 Управляющая компания","node_code":"9","hierarchy_path":"Холдинг / 9 Управляющая компания"}]
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "defaults", "rules.json"), []byte(`{"schema_version":"opiu-rule-registry.v2","rules":[],"revisions":[],"applications":[],"approvals":[],"evidence":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPIU_RUNTIME_ROOT", root)
	t.Setenv("OPIU_NODE_PATH", filepath.Join(root, "runtime", "node", "node-test"))
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewPipeline(store); err != nil {
		t.Fatal(err)
	}
	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	if _, err := store.CreateContext(createContextRequest{
		Organization: "Выдуманная организация", OrganizationID: "ORG-FORGED",
		OrganizationName: "Выдуманная организация", OrganizationPath: "Холдинг / Выдуманная организация",
		Period: "2025-10", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	}); err == nil {
		t.Fatal("organization outside the authoritative runtime catalog was accepted")
	}
}

func TestStructuralInventoryBindingRejectsUnknownJSONField(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)
	data, err := os.ReadFile(bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	var binding map[string]any
	if err := json.Unmarshal(data, &binding); err != nil {
		t.Fatal(err)
	}
	binding["unexpected_authority"] = true
	if err := atomicWriteJSON(bindingPath, binding); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err == nil {
		t.Fatal("binding with an unknown authority field was accepted")
	}
}

func TestStructuralInventoryBindingRejectsDuplicateScopeKey(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)
	data, err := os.ReadFile(bindingPath)
	if err != nil {
		t.Fatal(err)
	}
	duplicate := []byte(`{"run_id":"forged",` + string(data[1:]))
	if err := os.WriteFile(bindingPath, duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err == nil {
		t.Fatal("binding with duplicate run_id was accepted")
	}
}

func TestProducerV2FixtureIsAcceptedOnlyForItsExactCurrentRun(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	expectedSHA := writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	actualSHA, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue)
	if err != nil {
		t.Fatalf("producer v2 contract fixture was rejected: %v", err)
	}
	if actualSHA != expectedSHA {
		t.Fatalf("binding digest=%s want=%s", actualSHA, expectedSHA)
	}

	replayed := run
	replayed.ID = "run_replayed_inventory"
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, replayed, contextValue); err == nil {
		t.Fatal("prior-run producer fixture was accepted under a different run identity")
	}
}

func TestPriorRunProvenanceCannotBeRewrappedWithNewBinding(t *testing.T) {
	store, contextValue, originalRun, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventory(t, store, originalRun, contextValue)
	replayedRun, err := store.CreateRun(contextValue.ID)
	if err != nil {
		t.Fatal(err)
	}
	originalDir := filepath.Join(store.RunsDir(), originalRun.ID, "r005")
	replayedDir := filepath.Join(store.RunsDir(), replayedRun.ID, "r005")
	if err := os.MkdirAll(replayedDir, 0o700); err != nil {
		t.Fatal(err)
	}

	originalReport := filepath.Join(originalDir, "reconciliation.xlsx")
	replayedReport := filepath.Join(replayedDir, "reconciliation.xlsx")
	reportBytes, err := os.ReadFile(originalReport)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(replayedReport, reportBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	reportSHA, err := sha256File(replayedReport)
	if err != nil {
		t.Fatal(err)
	}

	var codex map[string]any
	if err := readJSONFile(filepath.Join(originalDir, "reconciliation.codex-input.json"), &codex); err != nil {
		t.Fatal(err)
	}
	// The embedded structural_control_inventory plan deliberately remains bound
	// to originalRun. Rewriting only the visible wrapper must never create a
	// current-run proof.
	codex["output_path"] = replayedReport
	codex["output_sha256"] = reportSHA
	replayedCodex := filepath.Join(replayedDir, "reconciliation.codex-input.json")
	if err := atomicWriteJSON(replayedCodex, codex); err != nil {
		t.Fatal(err)
	}
	codexSHA, err := sha256File(replayedCodex)
	if err != nil {
		t.Fatal(err)
	}

	var manifest map[string]any
	if err := readJSONFile(filepath.Join(originalDir, "reconciliation.manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["output_path"] = replayedReport
	manifest["output_sha256"] = reportSHA
	manifest["codex_input_path"] = replayedCodex
	manifest["codex_input_sha256"] = codexSHA
	replayedManifest := filepath.Join(replayedDir, "reconciliation.manifest.json")
	if err := atomicWriteJSON(replayedManifest, manifest); err != nil {
		t.Fatal(err)
	}
	manifestSHA, err := sha256File(replayedManifest)
	if err != nil {
		t.Fatal(err)
	}

	var inventory map[string]any
	if err := readJSONFile(filepath.Join(originalDir, "structural-control-inventory.json"), &inventory); err != nil {
		t.Fatal(err)
	}
	inventory["run_id"] = replayedRun.ID
	current := inventory["current_run_provenance"].(map[string]any)
	current["run_id"] = replayedRun.ID
	current["report"] = map[string]any{"file": replayedReport, "sha256": reportSHA}
	current["codex_input"] = map[string]any{"file": replayedCodex, "sha256": codexSHA}
	current["manifest"] = map[string]any{"file": replayedManifest, "sha256": manifestSHA}
	replayedInventory := filepath.Join(replayedDir, "structural-control-inventory.json")
	if err := atomicWriteJSON(replayedInventory, inventory); err != nil {
		t.Fatal(err)
	}
	inventorySHA, err := sha256File(replayedInventory)
	if err != nil {
		t.Fatal(err)
	}
	provenanceSHA, err := canonicalJSONSHA256(current)
	if err != nil {
		t.Fatal(err)
	}

	var binding map[string]any
	if err := readJSONFile(filepath.Join(originalDir, structuralControlInventoryFile), &binding); err != nil {
		t.Fatal(err)
	}
	binding["run_id"] = replayedRun.ID
	binding["sha256"] = inventorySHA
	binding["report"] = current["report"]
	binding["codex_input"] = current["codex_input"]
	binding["manifest"] = current["manifest"]
	binding["current_run_provenance_sha256"] = provenanceSHA
	if err := atomicWriteJSON(filepath.Join(replayedDir, structuralControlInventoryFile), binding); err != nil {
		t.Fatal(err)
	}
	if _, err := validateStructuralControlInventoryForAnchor(replayedDir, replayedRun, contextValue); err == nil || !strings.Contains(err.Error(), "embedded plan") {
		t.Fatalf("prior-run embedded provenance rewrap error=%v; want embedded plan rejection", err)
	}
}

func TestStructuralInventoryRejectsReparseRunDirectory(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	writePipelineStructuralInventory(t, store, run, contextValue)
	r005Dir := filepath.Join(store.RunsDir(), run.ID, "r005")
	outside := filepath.Join(store.Root(), "moved-r005-fixture")
	if err := os.Rename(r005Dir, outside); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, r005Dir); err != nil {
		t.Skipf("directory symlink creation unavailable: %v", err)
	}
	pipeline := &Pipeline{store: store}
	if err := pipeline.anchorStructuralControlInventory(run, contextValue, r005Dir); err == nil {
		t.Fatal("reparse-point run directory was accepted")
	}
	if _, ok := store.StructuralControlInventoryAnchor(run.ID); ok {
		t.Fatal("unsafe run directory created an anchor")
	}
}

func TestArchivedContextCannotGainAnchorThroughStaleStoreHandle(t *testing.T) {
	store, contextValue, run, _ := newPipelineStructuralContext(t)
	run.Status = RunCompletedReportOnly
	run.Stage = "DONE"
	if err := store.UpdateRun(run); err != nil {
		t.Fatal(err)
	}
	stale, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveContext(contextValue.ID); err != nil {
		t.Fatal(err)
	}
	if err := stale.AnchorStructuralControlInventory(run.ID, strings.Repeat("A", 64)); err == nil {
		t.Fatal("stale Store handle anchored an inventory after atomic archive")
	}
	reopened, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reopened.StructuralControlInventoryAnchor(run.ID); ok {
		t.Fatal("archived context persisted a structural inventory anchor")
	}
}

func TestResumeRevalidatesImmutableAnchorBeforeRules(t *testing.T) {
	store, run := testWaitingRulesRun(t)
	contextValue, ok := store.Context(run.ContextID)
	if !ok {
		t.Fatal("test context is missing")
	}
	bindingSHA := writePipelineStructuralInventory(t, store, run, contextValue)
	if err := store.AnchorStructuralControlInventory(run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}
	reportPath := filepath.Join(store.RunsDir(), run.ID, "r005", "reconciliation.xlsx")
	if err := os.WriteFile(reportPath, []byte("drift after Rules review"), 0o600); err != nil {
		t.Fatal(err)
	}
	pipeline := &Pipeline{store: store, active: map[string]struct{}{}}
	if err := pipeline.ResumeAfterRuleDecisions(run.ID, filepath.Join(store.Root(), "unused-decisions.json")); err == nil {
		t.Fatal("Rules resume accepted current-run artifact drift")
	}
	current, _ := store.Run(run.ID)
	if current.Status != RunWaitingUserRules || current.Stage != "RULES_REVIEW" {
		t.Fatalf("failed resume mutated run: status=%s stage=%s", current.Status, current.Stage)
	}
}

func TestStoreAnchorCASSubprocessHelper(t *testing.T) {
	root := os.Getenv("OPIU_TEST_STORE_CAS_ROOT")
	if root == "" {
		return
	}
	readyPath := os.Getenv("OPIU_TEST_STORE_CAS_READY")
	resultPath := os.Getenv("OPIU_TEST_STORE_CAS_RESULT")
	gatePath := os.Getenv("OPIU_TEST_STORE_CAS_GATE")
	store, err := OpenStore(root)
	if err != nil {
		_ = os.WriteFile(resultPath, []byte("OPEN_ERROR"), 0o600)
		return
	}
	if err := os.WriteFile(readyPath, []byte("ready"), 0o600); err != nil {
		_ = os.WriteFile(resultPath, []byte("READY_ERROR"), 0o600)
		return
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(gatePath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = os.WriteFile(resultPath, []byte("GATE_TIMEOUT"), 0o600)
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	result := "SUCCESS"
	if err := store.AnchorStructuralControlInventory(os.Getenv("OPIU_TEST_STORE_CAS_RUN"), os.Getenv("OPIU_TEST_STORE_CAS_SHA")); err != nil {
		result = "CONFLICT"
	}
	_ = os.WriteFile(resultPath, []byte(result), 0o600)
}

func TestStoreAnchorCASIsDurableAcrossProcesses(t *testing.T) {
	store, _, run, _ := newPipelineStructuralContext(t)
	syncDir := t.TempDir()
	gatePath := filepath.Join(syncDir, "go")
	type child struct {
		sha, readyPath, resultPath string
		command                    *exec.Cmd
	}
	children := make([]child, 8)
	for index := range children {
		sha := strings.Repeat(string(rune('A'+index)), 64)
		readyPath := filepath.Join(syncDir, "ready-"+string(rune('A'+index)))
		resultPath := filepath.Join(syncDir, "result-"+string(rune('A'+index)))
		command := exec.Command(os.Args[0], "-test.run=^TestStoreAnchorCASSubprocessHelper$")
		command.Env = append(os.Environ(),
			"OPIU_TEST_STORE_CAS_ROOT="+store.Root(),
			"OPIU_TEST_STORE_CAS_RUN="+run.ID,
			"OPIU_TEST_STORE_CAS_SHA="+sha,
			"OPIU_TEST_STORE_CAS_READY="+readyPath,
			"OPIU_TEST_STORE_CAS_RESULT="+resultPath,
			"OPIU_TEST_STORE_CAS_GATE="+gatePath,
		)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		children[index] = child{sha: sha, readyPath: readyPath, resultPath: resultPath, command: command}
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, child := range children {
		for {
			if _, err := os.Stat(child.readyPath); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("subprocesses did not reach the synchronized CAS gate")
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if err := os.WriteFile(gatePath, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}
	successes := 0
	winnerSHA := ""
	for _, child := range children {
		if err := child.command.Wait(); err != nil {
			t.Fatalf("CAS child failed: %v", err)
		}
		result, err := os.ReadFile(child.resultPath)
		if err != nil {
			t.Fatal(err)
		}
		switch string(result) {
		case "SUCCESS":
			successes++
			winnerSHA = child.sha
		case "CONFLICT":
		default:
			t.Fatalf("unexpected CAS child result %q", result)
		}
	}
	if successes != 1 {
		t.Fatalf("cross-process immutable CAS winners=%d want=1", successes)
	}
	reopened, err := OpenStore(store.Root())
	if err != nil {
		t.Fatal(err)
	}
	anchor, ok := reopened.StructuralControlInventoryAnchor(run.ID)
	if !ok || anchor.BindingSHA256 != winnerSHA {
		t.Fatalf("durable CAS anchor=%#v ok=%v winner=%s", anchor, ok, winnerSHA)
	}
}
