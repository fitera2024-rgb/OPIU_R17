package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestStructuralControlManifestAndR005ProofAreOneImmutableChain(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	draft := structuralSourceCreateDraft(t, context, "Финансовые расходы", []string{"I-R045"}, []string{"E-R045"}, 0)
	status, _, raw := structuralSourceFixDraft(t, context, draft)
	if status != 201 {
		t.Fatalf("fix failed: %d %s", status, raw)
	}
	run, _ := context.store.Run(context.runID)
	contextValue, _ := context.store.Context(context.contextID)
	runDir := filepath.Join(context.store.RunsDir(), run.ID)
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)

	pipeline := &Pipeline{store: context.store}
	_, audit, err := pipeline.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
		t.Fatal(err)
	}
	var manifest internalRunManifest
	if err := readStrictJSONFile(filepath.Join(runDir, "run_manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.StructuralControl == nil || manifest.StructuralControl.RunID != run.ID ||
		manifest.StructuralControl.ContextID != contextValue.ID ||
		manifest.StructuralControl.OrganizationID != contextValue.OrganizationID ||
		manifest.StructuralControl.Settings.SHA256 != audit.SettingsSHA256 ||
		manifest.StructuralControl.Registry.SHA256 != audit.RegistrySHA256 ||
		len(manifest.StructuralControl.AppliedVersions) != 1 {
		t.Fatalf("run manifest lost exact structural-control provenance: %#v", manifest.StructuralControl)
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err == nil {
		t.Fatal("immutable run manifest accepted a second structural-control bind")
	}

	r005Dir := filepath.Join(runDir, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	writeStructuralControlCodexProofFixture(t, codexPath, audit)
	proofPath, proof, err := materializeStructuralControlProof(run, contextValue, runDir, codexPath)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Status != "ACTIVE_VERIFIED" || proof.FinancialRows != 0 || proof.PostingRows != 0 || proof.CorrectionAuthority ||
		!validSHA256(proof.StructuralControlProofSHA256) || !regularFile(proofPath) {
		t.Fatalf("unsafe or incomplete proof: %#v", proof)
	}
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, codexPath, proofPath); err != nil {
		t.Fatalf("fresh proof was rejected: %v", err)
	}

	var codex map[string]any
	if err := readStrictJSONFile(codexPath, &codex); err != nil {
		t.Fatal(err)
	}
	codex["posting_rows"] = 1
	if err := atomicWritePrivateJSON(codexPath, codex); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, codexPath, proofPath); err == nil {
		t.Fatal("post-R005 codex-input drift was accepted")
	}
}

func TestPackagedStructuralControlCSVIsPreboundAndVerifiedExactly(t *testing.T) {
	t.Run("exact organization materializes one active set", func(t *testing.T) {
		context := newStructuralSourceTestContext(t)
		run, _ := context.store.Run(context.runID)
		contextValue, _ := context.store.Context(context.contextID)
		runDir := filepath.Join(context.store.RunsDir(), run.ID)
		writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
		sourcePath := filepath.Join(t.TempDir(), structuralControlPackagedCSVFilename)
		sourceBytes := []byte("Организация;Название группы;Блоки Инталев;Блоки ERP;Активна\n" +
			contextValue.Organization + ";Финансовые и внереализационные расходы;R045;R055;Да\n")
		if err := os.WriteFile(sourcePath, sourceBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		audit := structuralControlPipelineAudit{
			Status: "NO_ACTIVE_UI_FIXED_SETS", RunID: run.ID, ContextID: contextValue.ID,
			Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID,
			OrganizationName: contextValue.OrganizationName, OrganizationPath: contextValue.OrganizationPath,
			Period: contextValue.Period, ControlSetIDs: []string{}, AppliedVersions: []structuralControlPipelineVersionRef{},
		}
		_, audit, err := materializePackagedStructuralControlSettingsForTest(t, run, contextValue, runDir, sourcePath, audit)
		if err != nil {
			t.Fatal(err)
		}
		if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
			t.Fatal(err)
		}
		codexPath := writePackagedStructuralControlCodexFixture(t, runDir, contextValue, audit, true)
		proofPath, proof, err := materializeStructuralControlProof(run, contextValue, runDir, codexPath)
		if err != nil {
			t.Fatal(err)
		}
		if proof.Status != "ACTIVE_VERIFIED" || proof.SetCount != 1 {
			t.Fatalf("packaged CSV proof did not preserve the active set: %#v", proof)
		}
		if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, codexPath, proofPath); err != nil {
			t.Fatal(err)
		}
		binding, err := readStructuralControlRunManifest(run, contextValue, runDir)
		if err != nil {
			t.Fatal(err)
		}
		freshPayload := func() map[string]any {
			value, _, loadErr := readStructuralControlObject(codexPath)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			return value
		}
		assertRejected := func(label string, value map[string]any) {
			t.Helper()
			descriptor, descriptorErr := structuralControlProofFromCodexPayload(value)
			if descriptorErr != nil {
				t.Fatalf("%s fixture invalid before manifest check: %v", label, descriptorErr)
			}
			if verifyErr := verifyCodexProofAgainstRunManifest(value, descriptor, binding, runDir); verifyErr == nil {
				t.Fatalf("%s was accepted", label)
			}
		}
		settingsPath := audit.SettingsPath
		settingsDocument, originalSettingsBytes, err := readStructuralControlObject(settingsPath)
		if err != nil {
			t.Fatal(err)
		}
		semanticMutators := map[string]func(map[string]any){
			"name": func(document map[string]any) {
				document["structural_group_control_sets"].([]any)[0].(map[string]any)["name"] = "Подменённая группа"
			},
			"member": func(document map[string]any) {
				document["structural_group_control_sets"].([]any)[0].(map[string]any)["member_codes"].([]any)[0] = "R999"
			},
			"split": func(document map[string]any) {
				document["structural_group_control_sets"].([]any)[0].(map[string]any)["intalev_member_codes"].([]any)[0] = "R999"
			},
			"id": func(document map[string]any) {
				document["structural_group_control_sets"].([]any)[0].(map[string]any)["id"] = "USER-STRUCTURAL-00000000000000000000"
			},
		}
		for label, mutate := range semanticMutators {
			var tampered map[string]any
			cloned, marshalErr := json.Marshal(settingsDocument)
			if marshalErr != nil || json.Unmarshal(cloned, &tampered) != nil {
				t.Fatalf("%s clone failed: %v", label, marshalErr)
			}
			mutate(tampered)
			if err := atomicWritePrivateJSON(settingsPath, tampered); err != nil {
				t.Fatal(err)
			}
			verificationPath := filepath.Join(t.TempDir(), label+".verification.json")
			if err := verifyPackagedStructuralControlSettingsForTest(
				t, contextValue, audit.SourceCSVPath, settingsPath, verificationPath,
			); err == nil {
				t.Fatalf("same-count packaged settings %s tamper passed canonical verifier", label)
			}
			if err := os.WriteFile(settingsPath, originalSettingsBytes, 0o600); err != nil {
				t.Fatal(err)
			}
		}

		tamperedSHA := freshPayload()
		tamperedSHA["structural_control_settings_selection"].(map[string]any)["source_sha256"] = strings.Repeat("F", 64)
		assertRejected("packaged CSV selection hash drift", tamperedSHA)

		tamperedSize := freshPayload()
		tamperedSize["structural_control_settings_selection"].(map[string]any)["source_size"] = binding.SourceCSV.Size + 1
		assertRejected("packaged CSV selection size drift", tamperedSize)

		tamperedSelectionPath := freshPayload()
		tamperedSelectionPath["structural_control_settings_selection"].(map[string]any)["path"] = filepath.Join(t.TempDir(), "foreign-settings.json")
		assertRejected("packaged CSV exact selection path drift", tamperedSelectionPath)

		tamperedProofPath := freshPayload()
		tamperedProofPath["structural_control_settings_selection"].(map[string]any)["selection_proof_path"] = filepath.Join(t.TempDir(), "foreign-proof.json")
		assertRejected("packaged CSV verifier path drift", tamperedProofPath)

		tamperedPath := freshPayload()
		settings := tamperedPath["structural_control_settings_binding"].(map[string]any)
		settingsPath = structuralControlText(settings["input_path"])
		settingsDocument, originalSettingsBytes, err = readStructuralControlObject(settingsPath)
		if err != nil {
			t.Fatal(err)
		}
		settingsDocument["source"].(map[string]any)["path"] = filepath.Join(t.TempDir(), "wrong-source.csv")
		if err := atomicWritePrivateJSON(settingsPath, settingsDocument); err != nil {
			t.Fatal(err)
		}
		changedSettingsBytes, err := os.ReadFile(settingsPath)
		if err != nil {
			t.Fatal(err)
		}
		settings["input_sha256"] = structuralControlBytesSHA256(changedSettingsBytes)
		settings["input_size"] = len(changedSettingsBytes)
		assertRejected("packaged CSV document source path drift", tamperedPath)
		if err := os.WriteFile(settingsPath, originalSettingsBytes, 0o600); err != nil {
			t.Fatal(err)
		}

		tamperedArtifact := freshPayload()
		if err := os.WriteFile(settingsPath, append(append([]byte{}, originalSettingsBytes...), ' '), 0o600); err != nil {
			t.Fatal(err)
		}
		assertRejected("packaged CSV settings artifact drift", tamperedArtifact)
		if err := os.WriteFile(settingsPath, originalSettingsBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(audit.SourceCSVPath, append(append([]byte{}, sourceBytes...), ' '), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readStructuralControlRunManifest(run, contextValue, runDir); err == nil {
			t.Fatal("run-owned packaged CSV byte/size drift was accepted by the immutable manifest")
		}
	})

	t.Run("organization absent from packaged CSV remains explicit default", func(t *testing.T) {
		context := newStructuralSourceTestContext(t)
		run, _ := context.store.Run(context.runID)
		contextValue, _ := context.store.Context(context.contextID)
		runDir := filepath.Join(context.store.RunsDir(), run.ID)
		writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
		sourcePath := filepath.Join(t.TempDir(), structuralControlPackagedCSVFilename)
		sourceBytes := []byte("Организация;Название группы;Коды верхних блоков;Активна\n" +
			"Другая организация;Финансовые и внереализационные расходы;R045,R055;Да\n")
		if err := os.WriteFile(sourcePath, sourceBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		audit := structuralControlPipelineAudit{
			Status: "NO_ACTIVE_UI_FIXED_SETS", RunID: run.ID, ContextID: contextValue.ID,
			Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID,
			OrganizationName: contextValue.OrganizationName, OrganizationPath: contextValue.OrganizationPath,
			Period: contextValue.Period, ControlSetIDs: []string{}, AppliedVersions: []structuralControlPipelineVersionRef{},
		}
		_, audit, err := materializePackagedStructuralControlSettingsForTest(t, run, contextValue, runDir, sourcePath, audit)
		if err != nil {
			t.Fatal(err)
		}
		if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
			t.Fatal(err)
		}
		codexPath := writePackagedStructuralControlCodexFixture(t, runDir, contextValue, audit, false)
		_, proof, err := materializeStructuralControlProof(run, contextValue, runDir, codexPath)
		if err != nil {
			t.Fatal(err)
		}
		if proof.Status != "NO_ACTIVE_DEFAULT_ALL_GROUPS" || proof.SetCount != 0 {
			t.Fatalf("packaged CSV no-match did not preserve the explicit default: %#v", proof)
		}
	})
}

func TestStructuralControlResultsRequireExactlyOneUniqueResultPerActiveSet(t *testing.T) {
	result := func(id string) map[string]any {
		return map[string]any{
			"control_set_id": id, "report_only": true, "posting_allowed": false,
			"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
			"live_1c_allowed": false,
		}
	}
	expected := []string{"SET-A", "SET-B"}
	if err := verifyStructuralControlResultsForSets(map[string]any{
		"structural_group_control_results": []any{result("SET-A"), result("SET-B")},
	}, expected); err != nil {
		t.Fatalf("exact unique result set was rejected: %v", err)
	}
	for label, values := range map[string][]any{
		"missing":   {result("SET-A")},
		"duplicate": {result("SET-A"), result("SET-A")},
		"foreign":   {result("SET-A"), result("SET-X")},
	} {
		if err := verifyStructuralControlResultsForSets(map[string]any{
			"structural_group_control_results": values,
		}, expected); err == nil {
			t.Fatalf("%s structural-control result set was accepted", label)
		}
	}
}

func TestStructuralControlSecureArtifactReadRejectsOversizeAndReparse(t *testing.T) {
	root := t.TempDir()
	regular := filepath.Join(root, "artifact.json")
	if err := os.WriteFile(regular, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readStructuralControlSecureArtifact(root, regular, 3)
	if err != nil || string(data) != "{}\n" {
		t.Fatalf("bounded regular artifact was rejected: data=%q err=%v", data, err)
	}
	oversize := filepath.Join(root, "oversize.json")
	if err := os.WriteFile(oversize, []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readStructuralControlSecureArtifact(root, oversize, 3); err == nil {
		t.Fatal("oversized structural artifact was accepted")
	}
	symlink := filepath.Join(root, "artifact-link.json")
	if err := os.Symlink(regular, symlink); err != nil {
		t.Logf("symlink regression skipped: %v", err)
		return
	}
	if _, err := readStructuralControlSecureArtifact(root, symlink, 3); err == nil {
		t.Fatal("symlink structural artifact was accepted")
	}
}

func materializePackagedStructuralControlSettingsForTest(t *testing.T, run Run, contextValue Context, runDir, sourcePath string, audit structuralControlPipelineAudit) (string, structuralControlPipelineAudit, error) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node runtime required for packaged structural-control test")
	}
	wrapper, err := filepath.Abs(filepath.Join("..", "..", "modules", "reconciliation", "source", "service_r005_owner_wrapper.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	return materializePackagedStructuralControlSettings(run, contextValue, runDir, sourcePath, node, wrapper, audit)
}

func verifyPackagedStructuralControlSettingsForTest(t *testing.T, contextValue Context, sourcePath, settingsPath, outputPath string) error {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("node runtime required for packaged structural-control test")
	}
	wrapper, err := filepath.Abs(filepath.Join("..", "..", "modules", "reconciliation", "source", "service_r005_owner_wrapper.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, wrapper, "verify-structural-control-settings",
		structuralControlSettingsCSVFlag, sourcePath,
		"--structural-control-settings", settingsPath,
		"--organization", contextValue.Organization,
		"--period", contextValue.Period,
		"--verification-output", outputPath,
	)
	command.Dir = filepath.Dir(wrapper)
	output, commandErr := command.CombinedOutput()
	if commandErr != nil {
		return fmt.Errorf("canonical verifier rejected settings: %w: %s", commandErr, strings.TrimSpace(string(output)))
	}
	return nil
}

func TestStructuralControlProofHandoffMustMatchServiceArtifact(t *testing.T) {
	run := Run{ID: "RUN-PROOF-HANDOFF", ContextID: "CTX-PROOF-HANDOFF"}
	contextValue := Context{ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: "ORG-9",
		OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	root := t.TempDir()
	codexPath := filepath.Join(root, "reconciliation.codex-input.json")
	audit := structuralControlPipelineAudit{Status: "NO_ACTIVE_UI_FIXED_SETS", RunID: run.ID, ContextID: contextValue.ID,
		Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period, ControlSetIDs: []string{}, AppliedVersions: []structuralControlPipelineVersionRef{}}
	writeStructuralControlInitialRunManifest(t, root, run, contextValue)
	if err := bindStructuralControlRunManifest(run, contextValue, root, audit); err != nil {
		t.Fatal(err)
	}
	writeStructuralControlCodexProofFixture(t, codexPath, audit)
	proofPath, proof, err := materializeStructuralControlProof(run, contextValue, root, codexPath)
	if err != nil {
		t.Fatal(err)
	}
	handoffPath := filepath.Join(root, "handoff.json")
	if err := atomicWritePrivateJSON(handoffPath, map[string]any{
		"run_id":                   run.ID,
		"organization":             map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":                   contextValue.Period,
		"reconciliation":           map[string]any{"codex_input_path": codexPath, "codex_input_sha256": mustStructuralControlSHA256File(t, codexPath)},
		"structural_control_proof": proof,
	}); err != nil {
		t.Fatal(err)
	}
	if err := verifyStructuralControlProofHandoff(handoffPath, run, contextValue, codexPath, proofPath); err != nil {
		t.Fatalf("exact service proof handoff was rejected: %v", err)
	}
	var handoff map[string]any
	if err := readStrictJSONFile(handoffPath, &handoff); err != nil {
		t.Fatal(err)
	}
	handoffProof := handoff["structural_control_proof"].(map[string]any)
	handoffProof["posting_rows"] = float64(1)
	if err := atomicWritePrivateJSON(handoffPath, handoff); err != nil {
		t.Fatal(err)
	}
	if err := verifyStructuralControlProofHandoff(handoffPath, run, contextValue, codexPath, proofPath); err == nil {
		t.Fatal("Service handoff proof drift was accepted")
	}
}

func TestExternalNoActiveStructuralControlRequiresExactServiceNoneChain(t *testing.T) {
	run := Run{ID: "RUN-SERVICE-NONE", ContextID: "CTX-SERVICE-NONE"}
	contextValue := Context{ID: run.ContextID, Organization: "9 Управляющая компания", OrganizationID: "ORG-9",
		OrganizationName: "9 Управляющая компания", OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10"}
	runDir := t.TempDir()
	audit := structuralControlPipelineAudit{Status: "NO_ACTIVE_UI_FIXED_SETS", RunID: run.ID, ContextID: contextValue.ID,
		Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period, ControlSetIDs: []string{}, AppliedVersions: []structuralControlPipelineVersionRef{}}
	writeStructuralControlInitialRunManifest(t, runDir, run, contextValue)
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, audit); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(runDir, "service-none.codex-input.json")
	writeStructuralControlCodexProofFixture(t, codexPath, audit)
	binding, err := readStructuralControlRunManifest(run, contextValue, runDir)
	if err != nil {
		t.Fatal(err)
	}
	base, _, err := readStructuralControlObject(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(label string, mutate func(map[string]any), accepted bool) {
		t.Helper()
		data, marshalErr := json.Marshal(base)
		var payload map[string]any
		if marshalErr != nil || json.Unmarshal(data, &payload) != nil {
			t.Fatalf("%s clone failed: %v", label, marshalErr)
		}
		if mutate != nil {
			mutate(payload)
		}
		descriptor, descriptorErr := structuralControlProofFromCodexPayload(payload)
		if descriptorErr != nil {
			if accepted {
				t.Fatalf("%s descriptor failed: %v", label, descriptorErr)
			}
			return
		}
		verifyErr := verifyCodexProofAgainstRunManifest(payload, descriptor, binding, runDir)
		if accepted && verifyErr != nil {
			t.Fatalf("%s rejected: %v", label, verifyErr)
		}
		if !accepted && verifyErr == nil {
			t.Fatalf("%s was accepted", label)
		}
	}
	verify("exact service-none", nil, true)
	verify("missing selection", func(payload map[string]any) { delete(payload, "structural_control_settings_selection") }, false)
	verify("standalone authority", func(payload map[string]any) {
		payload["structural_control_settings_selection"].(map[string]any)["authority"] = "standalone"
	}, false)
	verify("nonempty path", func(payload map[string]any) {
		payload["structural_control_settings_selection"].(map[string]any)["path"] = filepath.Join(runDir, "unexpected.json")
	}, false)
	verify("missing explicit default binding", func(payload map[string]any) {
		payload["structural_control_settings_binding"] = nil
	}, false)
}

func TestStructuralControlProofCanonicalDescriptorMatchesR005Implementation(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node runtime is unavailable")
	}
	root := t.TempDir()
	codexPath := filepath.Join(root, "codex.json")
	audit := structuralControlPipelineAudit{
		Status: "ACTIVE_UI_FIXED_SETS_MATERIALIZED", RunID: "RUN-PARITY", ContextID: "CTX-PARITY",
		Organization: "9 Управляющая компания", OrganizationID: "ORG-9", OrganizationName: "9 Управляющая компания",
		OrganizationPath: "Холдинг / 9 Управляющая компания", Period: "2025-10",
		SettingsSHA256: strings.Repeat("A", 64), SourceCSVSHA256: strings.Repeat("B", 64), RegistrySHA256: strings.Repeat("C", 64),
		RegistryRevision: 17, ControlSetIDs: []string{"SC-17"}, SetCount: 1,
		AppliedVersions: []structuralControlPipelineVersionRef{{
			ControlSetID: "SC-17", LineageID: "LINEAGE-17", Version: 3, PayloadSHA256: strings.Repeat("D", 64),
			MaterializedSetID: "USER-STRUCTURAL-17", OriginRunID: "RUN-ORIGIN", OriginContextID: "CTX-ORIGIN",
			OriginInventoryID: "INV-ORIGIN", OriginInventoryBindingSHA256: strings.Repeat("E", 64),
		}},
	}
	writeStructuralControlCodexProofFixture(t, codexPath, audit)
	payload, _, err := readStructuralControlCodexPayload(codexPath)
	if err != nil {
		t.Fatal(err)
	}
	goProof, err := structuralControlProofFromCodexPayload(payload)
	if err != nil {
		t.Fatal(err)
	}
	modulePath, err := filepath.Abs(filepath.Join("..", "..", "modules", "reconciliation", "source", "structural_control_proof.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(root, "proof-parity.mjs")
	script := `import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [modulePath, payloadPath] = process.argv.slice(2);
const module = await import(pathToFileURL(modulePath));
const payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
process.stdout.write(JSON.stringify(module.structuralControlProofFromCodexPayload(payload)));
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(node, scriptPath, modulePath, codexPath).CombinedOutput()
	if err != nil {
		t.Fatalf("R005 proof implementation failed: %v: %s", err, output)
	}
	var rulesProof structuralControlProofDescriptor
	if err := decodeJSONRejectDuplicateKeys(output, &rulesProof, true); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(goProof, rulesProof) {
		t.Fatalf("Service proof differs from R005 proof:\nService=%#v\nR005=%#v", goProof, rulesProof)
	}
}

func writeStructuralControlInitialRunManifest(t *testing.T, runDir string, run Run, contextValue Context) {
	t.Helper()
	erpPath, intalevPath := testServiceSourcePaths(runDir)
	if err := os.MkdirAll(filepath.Dir(erpPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(erpPath, []byte("synthetic pinned ERP package\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(intalevPath, []byte("synthetic pinned Intalev source\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	erpInfo, err := os.Stat(erpPath)
	if err != nil {
		t.Fatal(err)
	}
	intalevInfo, err := os.Stat(intalevPath)
	if err != nil {
		t.Fatal(err)
	}
	erpSHA, err := sha256File(erpPath)
	if err != nil {
		t.Fatal(err)
	}
	intalevSHA, err := sha256File(intalevPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteJSON(filepath.Join(runDir, "run_manifest.json"), internalRunManifest{
		SchemaVersion: "opiu-stable-run.v1", RunID: run.ID, ContextID: contextValue.ID,
		Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID,
		OrganizationName: contextValue.OrganizationName, OrganizationPath: contextValue.OrganizationPath,
		Period:  contextValue.Period,
		ERP:     internalFile{ID: "TEST-ERP", Name: filepath.Base(erpPath), SHA256: strings.ToUpper(erpSHA), Size: erpInfo.Size()},
		Intalev: internalFile{ID: "TEST-INTALEV", Name: filepath.Base(intalevPath), SHA256: strings.ToUpper(intalevSHA), Size: intalevInfo.Size()},
		Safety:  reportOnlySafety(), CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
}

func testServiceSourcePaths(runDir string) (string, string) {
	return filepath.Join(runDir, "test-sources", "erp-package.xlsx"), filepath.Join(runDir, "test-sources", "intalev.xlsx")
}

func writeStructuralControlCodexProofFixture(t *testing.T, path string, audit structuralControlPipelineAudit) {
	t.Helper()
	binding := any(nil)
	results := []any{}
	if audit.Status == "ACTIVE_UI_FIXED_SETS_MATERIALIZED" {
		applied := make([]any, 0, len(audit.AppliedVersions))
		for _, ref := range audit.AppliedVersions {
			var value map[string]any
			data, _ := json.Marshal(ref)
			_ = json.Unmarshal(data, &value)
			applied = append(applied, value)
		}
		binding = map[string]any{
			"status": "ACTIVE_EXACT_ORGANIZATION_MONTH", "input_path": audit.SettingsPath, "input_sha256": audit.SettingsSHA256,
			"source_sha256": audit.SourceCSVSHA256, "set_count": audit.SetCount,
			"sets": []any{map[string]any{"id": audit.AppliedVersions[0].MaterializedSetID}},
			"ui_fixed_registry": map[string]any{
				"status": "ACTIVE_UI_FIXED_REGISTRY_VERIFIED", "registry_revision": audit.RegistryRevision,
				"registry_sha256": audit.RegistrySHA256, "organization_id": audit.OrganizationID,
				"run_id": audit.RunID, "context_id": audit.ContextID, "set_count": audit.SetCount,
				"control_set_ids": audit.ControlSetIDs, "applied_versions": applied,
				"correction_authority": false, "financial_rows": 0, "posting_rows": 0,
			},
			"correction_authority": false, "financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
		}
		results = []any{map[string]any{"control_set_id": audit.AppliedVersions[0].MaterializedSetID, "financial_rows": 0, "posting_rows": 0,
			"execution_allowed": false, "posting_allowed": false, "report_only": true, "ready_to_upload": false,
			"release_allowed": false, "live_1c_allowed": false}}
	} else {
		binding = map[string]any{
			"schema": structuralControlSettingsSchema, "status": "MISSING_DEFAULT_ALL_GROUPS", "set_count": 0,
			"correction_authority": false, "financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
		}
	}
	selection := any(nil)
	if audit.Status == "ACTIVE_UI_FIXED_SETS_MATERIALIZED" {
		selection = map[string]any{"authority": structuralControlAuthorityServiceJSON, "status": "EXPLICIT_CLI_SETTINGS", "path": audit.SettingsPath}
	} else {
		selection = map[string]any{"authority": structuralControlAuthorityServiceNone, "status": "SERVICE_NO_SETTINGS", "path": ""}
	}
	if err := atomicWritePrivateJSON(path, map[string]any{
		"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false,
		"structural_control_settings_selection": selection,
		"structural_control_settings_binding":   binding, "structural_group_control_results": results,
	}); err != nil {
		t.Fatal(err)
	}
}

func writePackagedStructuralControlCodexFixture(t *testing.T, runDir string, contextValue Context, audit structuralControlPipelineAudit, active bool) string {
	t.Helper()
	r005Dir := filepath.Join(runDir, "r005")
	if err := os.MkdirAll(r005Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	selectionProof, selectionProofBytes, err := readStructuralControlObject(audit.SelectionPath)
	if err != nil {
		t.Fatal(err)
	}
	selection := map[string]any{
		"authority": func() string {
			if active {
				return structuralControlAuthorityServiceJSON
			}
			return structuralControlAuthorityServiceNone
		}(),
		"status": func() string {
			if active {
				return "EXPLICIT_CLI_SETTINGS"
			}
			return "SERVICE_NO_SETTINGS"
		}(),
		"path": func() string {
			if active {
				return audit.SettingsPath
			}
			return ""
		}(),
		"materialization_status": func() string {
			if active {
				return "EXACT_ORGANIZATION_MATERIALIZED"
			}
			return "NO_EXACT_ORGANIZATION"
		}(),
		"source_path":            audit.SourceCSVPath,
		"source_sha256":          audit.SourceCSVSHA256,
		"selection_proof_path":   audit.SelectionPath,
		"selection_proof_sha256": audit.SelectionSHA256,
		"selection_proof_size":   len(selectionProofBytes),
	}
	sourceInfo, err := os.Stat(audit.SourceCSVPath)
	if err != nil {
		t.Fatal(err)
	}
	selection["source_size"] = sourceInfo.Size()
	if active {
		selection["verified_settings_path"] = selectionProof["settings_path"]
		selection["verified_settings_sha256"] = selectionProof["settings_sha256"]
		selection["verified_settings_size"] = selectionProof["settings_size"]
		selection["verified_settings_id"] = selectionProof["settings_id"]
		selection["verified_set_count"] = selectionProof["set_count"]
		selection["verified_set_ids"] = selectionProof["set_ids"]
		selection["verified_sets_sha256"] = selectionProof["sets_sha256"]
	}
	binding := map[string]any{
		"schema": structuralControlSettingsSchema, "status": "MISSING_DEFAULT_ALL_GROUPS", "set_count": 0,
		"correction_authority": false, "financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
	}
	if active {
		settingsPath := audit.SettingsPath
		settingsBytes, err := os.ReadFile(settingsPath)
		if err != nil {
			t.Fatal(err)
		}
		binding = map[string]any{
			"status": "ACTIVE_EXACT_ORGANIZATION_MONTH", "organization": contextValue.Organization,
			"period": contextValue.Period, "input_path": settingsPath,
			"input_sha256": audit.SettingsSHA256, "input_size": len(settingsBytes),
			"source_sha256": audit.SourceCSVSHA256, "source_size": sourceInfo.Size(),
			"set_count": audit.SetCount, "sets": []any{map[string]any{"id": audit.ControlSetIDs[0]}},
			"correction_authority": false, "financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
		}
	}
	results := []any{}
	if active {
		results = []any{map[string]any{"control_set_id": audit.ControlSetIDs[0], "financial_rows": 0, "posting_rows": 0,
			"execution_allowed": false, "posting_allowed": false, "report_only": true, "ready_to_upload": false,
			"release_allowed": false, "live_1c_allowed": false}}
	}
	if err := atomicWritePrivateJSON(codexPath, map[string]any{
		"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false,
		"structural_control_settings_selection": selection,
		"structural_control_settings_binding":   binding,
		"structural_group_control_results":      results,
	}); err != nil {
		t.Fatal(err)
	}
	return codexPath
}

func mustStructuralControlSHA256File(t *testing.T, path string) string {
	t.Helper()
	value, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.ToUpper(value)
}

func writeStructuralControlHandoffFixture(path string, run Run, contextValue Context, codexPath, proofPath string) error {
	var proof structuralControlProofDescriptor
	proofBytes, err := os.ReadFile(proofPath)
	if err != nil {
		return err
	}
	if err := decodeJSONRejectDuplicateKeys(proofBytes, &proof, true); err != nil {
		return err
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil {
		return err
	}
	return atomicWritePrivateJSON(path, map[string]any{
		"run_id":                   run.ID,
		"organization":             map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":                   contextValue.Period,
		"reconciliation":           map[string]any{"codex_input_path": codexPath, "codex_input_sha256": codexSHA},
		"structural_control_proof": proof,
	})
}
