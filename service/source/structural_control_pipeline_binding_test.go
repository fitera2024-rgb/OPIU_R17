package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeR005ReceivesExactActiveUIFixedStructuralSettings(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Финансовые и внереализационные расходы",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	run, ok := context.store.Run(context.runID)
	if !ok {
		t.Fatal("run missing")
	}
	contextValue, ok := context.store.Context(context.contextID)
	if !ok {
		t.Fatal("context missing")
	}
	runDir := filepath.Join(context.store.RunsDir(), run.ID)
	pipeline := &Pipeline{
		store:   context.store,
		runtime: &RuntimeAdapter{Root: t.TempDir(), Node: "node", R005Script: "service_r005_owner_wrapper.mjs"},
		active:  map[string]struct{}{},
	}
	pipeline.runner = func(stage string, command []string, _ map[string]string, _, _ string) error {
		if stage != "R005" {
			t.Fatalf("unexpected stage %s", stage)
		}
		settingsPath, found := commandArgument(command, "--structural-control-settings")
		if !found || settingsPath == "" {
			t.Fatalf("active fixed UI sets were lost from R005 argv: %#v", command)
		}
		assertUIFixedStructuralSettingsDocument(t, settingsPath, run, contextValue, 1)
		assertNodeLoadsUIFixedStructuralSettings(t, settingsPath, run, contextValue)
		return errors.New("intentional stop after argv verification")
	}
	pipeline.executeRuntime(run, contextValue, "erp.xlsx", strings.Repeat("A", 64), "intalev.xlsx", runDir,
		func(RunStatus, string, string) {})
}

func TestExternalR005ReceivesExactActiveUIFixedStructuralSettings(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	runDir := filepath.Join(context.store.RunsDir(), run.ID)
	pipeline := &Pipeline{
		store:    context.store,
		commands: map[string][]string{"R005": {"r005-command"}, "RULES": {"rules-command"}, "R001": {"r001-command"}},
		active:   map[string]struct{}{},
	}
	pipeline.runner = func(stage string, command []string, _ map[string]string, _, _ string) error {
		if stage != "R005" {
			t.Fatalf("unexpected stage %s", stage)
		}
		settingsPath, found := commandArgument(command, "--structural-control-settings")
		if !found || settingsPath == "" {
			t.Fatalf("external R005 lost fixed UI settings: %#v", command)
		}
		for _, key := range []string{"--organization-id", "--organization-name", "--organization-path", "--run-id", "--context-id"} {
			if value, ok := commandArgument(command, key); !ok || value == "" {
				t.Fatalf("external R005 lost exact scope %s: %#v", key, command)
			}
		}
		assertUIFixedStructuralSettingsDocument(t, settingsPath, run, contextValue, 1)
		return errors.New("intentional stop after external argv verification")
	}
	pipeline.executeExternal(run, contextValue, "erp.xlsx", "intalev.xlsx", runDir, func(RunStatus, string, string) {})
}

func TestUIFixedStructuralSettingsMaterializeSeveralDistinctSetsAndFallbackWhenAbsent(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	first := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, context, first)
	if status != 201 {
		t.Fatalf("first fix failed: %d %s", status, raw)
	}
	second := structuralSourceCreateDraft(t, context, "Внереализационные расходы", []string{"I-R055"}, []string{"E-R055"}, int64(fixed["registry_revision"].(float64)))
	status, _, raw = structuralSourceFixDraft(t, context, second)
	if status != 201 {
		t.Fatalf("second fix failed: %d %s", status, raw)
	}
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	pipeline := &Pipeline{store: context.store}
	settingsPath, audit, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, filepath.Join(context.store.RunsDir(), run.ID))
	if err != nil {
		t.Fatal(err)
	}
	if settingsPath == "" || audit.SetCount != 2 || len(audit.ControlSetIDs) != 2 || !validSHA256(audit.SettingsSHA256) {
		t.Fatalf("materialized audit invalid: path=%q audit=%#v", settingsPath, audit)
	}
	assertUIFixedStructuralSettingsDocument(t, settingsPath, run, contextValue, 2)

	emptyContext := newStructuralSourceTestContext(t)
	emptyRun, _ := emptyContext.store.Run(emptyContext.runID)
	emptyContextValue, _ := emptyContext.store.Context(emptyContext.contextID)
	emptyPath, emptyAudit, err := (&Pipeline{store: emptyContext.store}).materializeActiveStructuralControlSettings(
		emptyRun, emptyContextValue, filepath.Join(emptyContext.store.RunsDir(), emptyRun.ID))
	if err != nil || emptyPath != "" || emptyAudit.Status != "NO_ACTIVE_UI_FIXED_SETS" {
		t.Fatalf("default CSV fallback was not preserved: path=%q audit=%#v err=%v", emptyPath, emptyAudit, err)
	}
}

func TestUIFixedStructuralSettingsFailClosedOnRegistryTamper(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	registryPath := filepath.Join(context.store.Root(), "structural-control-sets.json")
	bytes, err := os.ReadFile(registryPath)
	if err != nil {
		t.Fatal(err)
	}
	bytes = append(bytes[:len(bytes)-2], []byte(",\"tampered\":true}\n")...)
	if err := os.WriteFile(registryPath, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	if _, _, err := (&Pipeline{store: context.store}).materializeActiveStructuralControlSettings(
		run, contextValue, filepath.Join(context.store.RunsDir(), run.ID)); err == nil {
		t.Fatal("tampered registry was accepted")
	}
}

func assertUIFixedStructuralSettingsDocument(t *testing.T, settingsPath string, run Run, contextValue Context, expectedSets int) {
	t.Helper()
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	sets, _ := document["structural_group_control_sets"].([]any)
	if document["schema"] != "opiu-structural-control-settings.v1" ||
		document["organization"] != contextValue.Organization || document["organization_id"] != contextValue.OrganizationID ||
		document["organization_name"] != contextValue.OrganizationName || document["organization_path"] != contextValue.OrganizationPath ||
		document["period"] != contextValue.Period || document["run_id"] != run.ID || document["context_id"] != contextValue.ID || len(sets) != expectedSets {
		t.Fatalf("settings scope/sets mismatch: %s", data)
	}
	safety, _ := document["safety"].(map[string]any)
	if safety["mode"] != "REPORT_ONLY" || safety["posting_rows"] != float64(0) ||
		safety["ready_to_upload"] != false || safety["release_allowed"] != false || safety["execution_allowed"] != false {
		t.Fatalf("settings safety opened: %s", data)
	}
	origin, _ := document["ui_fixed_registry"].(map[string]any)
	refs, _ := origin["active_versions"].([]any)
	if origin["organization_name"] != contextValue.OrganizationName || origin["organization_path"] != contextValue.OrganizationPath ||
		origin["run_id"] != run.ID || origin["context_id"] != contextValue.ID || len(refs) != expectedSets {
		t.Fatalf("fixed version audit missing: %s", data)
	}
	for _, raw := range sets {
		set := raw.(map[string]any)
		if set["exact_organization_id"] != contextValue.OrganizationID ||
			len(set["intalev_member_bindings"].([]any)) == 0 || len(set["erp_member_bindings"].([]any)) == 0 ||
			set["expected_control_delta"] != float64(0) {
			t.Fatalf("typed sides/control invariant lost: %#v", set)
		}
	}
}

func TestStructuralControlPipelineSelectorsAcceptRealEmptyCodeIdentityPathAndRejectOverlap(t *testing.T) {
	owners := map[string]string{}
	members := []structuralControlMember{{Identity: "INTALEV|SHA|SHEET|42", Code: "", HierarchyPath: "ОПИУ / Финансовые расходы"}}
	bindings, err := structuralControlPipelineMemberSelectors(members, "INTALEV", "SC-1", "INV-1", owners)
	if err != nil || len(bindings) != 1 || bindings[0].Code != "" || bindings[0].OriginIdentity != members[0].Identity || bindings[0].HierarchyPath != members[0].HierarchyPath {
		t.Fatalf("real empty-code selector was not preserved: bindings=%#v err=%v", bindings, err)
	}
	if _, err := structuralControlPipelineMemberSelectors(members, "INTALEV", "SC-2", "INV-2", owners); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("same-side identity/path overlap was accepted: %v", err)
	}
	if _, err := structuralControlPipelineMemberSelectors(members, "ERP", "SC-2", "INV-2", owners); err != nil {
		t.Fatalf("distinct side must keep an independent selector namespace: %v", err)
	}
}

func TestStructuralControlScopeArgumentsAreAppendedOnce(t *testing.T) {
	command := appendStructuralControlScopeArguments([]string{"node", "r005.mjs", "run", "--run-id", "EXISTING"})
	for _, key := range []string{"--organization-id", "--organization-name", "--organization-path", "--run-id", "--context-id"} {
		count := 0
		for _, token := range command {
			if token == key {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("scope argument %s count=%d command=%#v", key, count, command)
		}
	}
}

func TestExternalR005RejectsPreexistingStructuralSettingsArgumentBeforeSpawn(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	pipeline := &Pipeline{store: context.store, active: map[string]struct{}{}, commands: map[string][]string{
		"R005":  {"r005", "--structural-control-settings", "preexisting.json"},
		"RULES": {"rules"}, "R001": {"r001"},
	}}
	spawned := false
	pipeline.runner = func(string, []string, map[string]string, string, string) error { spawned = true; return nil }
	finalStage := ""
	pipeline.executeExternal(run, contextValue, "erp.xlsx", "intalev.xlsx", filepath.Join(context.store.RunsDir(), run.ID),
		func(_ RunStatus, stage, _ string) { finalStage = stage })
	if spawned || finalStage != "R005_SETTINGS" {
		t.Fatalf("duplicate structural settings reached spawn: spawned=%v stage=%s", spawned, finalStage)
	}
}

func assertNodeLoadsUIFixedStructuralSettings(t *testing.T, settingsPath string, run Run, contextValue Context) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node runtime required for cross-runtime structural settings validation")
	}
	modulePath, err := filepath.Abs(filepath.Join("..", "..", "modules", "reconciliation", "source", "structural_control_settings_binding.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(t.TempDir(), "load-ui-fixed-structural-settings.mjs")
	script := `import { pathToFileURL } from "node:url";
const [modulePath, settingsPath, organization, period, organizationId, organizationName, organizationPath, runId, contextId] = process.argv.slice(2);
const binding = await import(pathToFileURL(modulePath));
const loaded = await binding.loadStructuralControlSettingsDocument(settingsPath, { organization, period, organizationId, organizationName, organizationPath, runId, contextId });
if (loaded.audit?.ui_fixed_registry?.status !== "ACTIVE_UI_FIXED_REGISTRY_VERIFIED") process.exit(23);
process.stdout.write(JSON.stringify({ set_count: loaded.groups.length, audit: loaded.audit.ui_fixed_registry.status }));
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, scriptPath, modulePath, settingsPath, contextValue.Organization, contextValue.Period,
		contextValue.OrganizationID, contextValue.OrganizationName, contextValue.OrganizationPath, run.ID, contextValue.ID)
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), `"audit":"ACTIVE_UI_FIXED_REGISTRY_VERIFIED"`) {
		t.Fatalf("Node loader rejected Go UI-fixed snapshot: err=%v output=%s", err, output)
	}
}

func TestUIFixedStructuralSettingsUseLatestLineageAndDisabledLineageFallsBack(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	firstDraft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, firstFixed, raw := structuralSourceFixDraft(t, context, firstDraft)
	if status != 201 {
		t.Fatalf("first fix failed: %d %s", status, raw)
	}
	firstVersion := structuralSourceMap(firstFixed["fixed_version"])
	secondBody := structuralSourceDraftBody(context, "Финансовые расходы — уточнение",
		[]string{"I-R045"}, []string{"E-R045"}, int64(structuralSourceFloat(firstFixed["registry_revision"])))
	secondBody["source_control_set_id"] = firstVersion["control_set_id"]
	secondBody["lineage_id"] = firstVersion["lineage_id"]
	status, secondDraft, raw := structuralSourceRequest(t, context.server, "POST", "/api/structural-control-sets", secondBody)
	if status != 201 {
		t.Fatalf("second draft failed: %d %s", status, raw)
	}
	status, secondFixed, raw := structuralSourceFixDraft(t, context, secondDraft)
	if status != 201 {
		t.Fatalf("second fix failed: %d %s", status, raw)
	}
	secondVersion := structuralSourceMap(secondFixed["fixed_version"])
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	pipeline := &Pipeline{store: context.store}
	_, audit, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, filepath.Join(context.store.RunsDir(), run.ID))
	if err != nil || audit.SetCount != 1 || audit.ControlSetIDs[0] != structuralSourceString(secondVersion["control_set_id"]) {
		t.Fatalf("latest lineage version not selected: audit=%#v err=%v", audit, err)
	}
	status, disabled, raw := structuralSourceRequest(t, context.server, "POST", "/api/structural-control-sets/disable", map[string]any{
		"control_set_id": secondVersion["control_set_id"], "organization_id": context.organizationID,
		"run_id": context.runID, "inventory_id": context.inventoryID, "reason": "Проверка отключения",
		"expected_registry_revision": secondFixed["registry_revision"],
	})
	if status != 200 {
		t.Fatalf("disable failed: %d %s", status, raw)
	}
	if structuralSourceString(disabled["status"]) != "DISABLED" {
		t.Fatalf("disable audit missing: %#v", disabled)
	}
	path, afterDisable, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, filepath.Join(context.store.RunsDir(), run.ID))
	if err != nil || path != "" || afterDisable.Status != "NO_ACTIVE_UI_FIXED_SETS" {
		t.Fatalf("disabled lineage remained active: path=%q audit=%#v err=%v", path, afterDisable, err)
	}
}

func TestUIFixedStructuralSettingsApplyAcrossLaterRunsOnlyForExactOrganization(t *testing.T) {
	origin := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, origin, "Финансовые и внереализационные расходы",
		[]string{"I-R045", "I-R055"}, []string{"E-R045", "E-R055"}, 0)
	status, fixed, raw := structuralSourceFixDraft(t, origin, draft)
	if status != 201 {
		t.Fatalf("origin fix failed: %d %s", status, raw)
	}
	originVersion := structuralSourceMap(fixed["fixed_version"])
	privateRegistry, err := origin.server.loadStructuralControlRegistry()
	if err != nil {
		t.Fatal(err)
	}
	privateVersion, found := structuralControlVersion(privateRegistry, structuralSourceString(originVersion["control_set_id"]))
	if !found || !validSHA256(privateVersion.PayloadSHA256) {
		t.Fatalf("private fixed payload hash missing: %#v", privateVersion)
	}
	later := addStructuralSourceRun(t, origin, "SCI-NOV-2025-CROSS-RUN", "2025-11")
	laterRun, _ := later.store.Run(later.runID)
	laterContext, _ := later.store.Context(later.contextID)
	settingsPath, audit, err := (&Pipeline{store: later.store}).materializeActiveStructuralControlSettings(
		laterRun, laterContext, filepath.Join(later.store.RunsDir(), laterRun.ID))
	if err != nil {
		t.Fatal(err)
	}
	if settingsPath == "" || audit.SetCount != 1 || audit.ControlSetIDs[0] != structuralSourceString(originVersion["control_set_id"]) {
		t.Fatalf("origin fixed setting was not applied to later run: path=%q audit=%#v", settingsPath, audit)
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	originAudit := document["ui_fixed_registry"].(map[string]any)
	refs := originAudit["active_versions"].([]any)
	ref := refs[0].(map[string]any)
	if originAudit["run_id"] != laterRun.ID || originAudit["context_id"] != laterContext.ID ||
		ref["origin_run_id"] != origin.runID || ref["origin_context_id"] != origin.contextID ||
		ref["origin_inventory_id"] != origin.inventoryID || ref["payload_sha256"] != privateVersion.PayloadSHA256 {
		t.Fatalf("current/origin binding is not explicit: %s", data)
	}
	driftedPath := laterContext
	driftedPath.OrganizationPath = "Холдинг / Подменённый путь"
	if _, _, err := (&Pipeline{store: later.store}).materializeActiveStructuralControlSettings(
		laterRun, driftedPath, filepath.Join(later.store.RunsDir(), laterRun.ID, "drifted-path")); err == nil {
		t.Fatal("same organization ID with a drifted exact path was accepted")
	}

	otherOrganization := laterContext
	otherOrganization.OrganizationID = "ORG-OTHER"
	otherOrganization.Organization = "1 Хабаровск"
	otherOrganization.OrganizationName = "1 Хабаровск"
	otherPath, otherAudit, err := (&Pipeline{store: later.store}).materializeActiveStructuralControlSettings(
		laterRun, otherOrganization, filepath.Join(later.store.RunsDir(), laterRun.ID, "other-org"))
	if err != nil || otherPath != "" || otherAudit.Status != "NO_ACTIVE_UI_FIXED_SETS" {
		t.Fatalf("setting crossed organization scope: path=%q audit=%#v err=%v", otherPath, otherAudit, err)
	}
}
