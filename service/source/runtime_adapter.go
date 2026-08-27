package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// RuntimeAdapter describes a verified local runtime payload containing the
// imported R005, Rules and R001 modules. The Service never downloads or
// executes arbitrary code: every entrypoint is resolved below one explicit
// runtime root and is launched as an argv vector without a shell.
type RuntimeAdapter struct {
	Root                 string
	Node                 string
	R005Script           string
	RulesScript          string
	R001Script           string
	R001DiagnosticScript string
	RulesRegistry        string
}

type runtimeSafety struct {
	Mode                string `json:"mode"`
	PostingRows         int    `json:"posting_rows"`
	ReadyToUpload       bool   `json:"ready_to_upload"`
	ReleaseAllowed      bool   `json:"release_allowed"`
	OneCActionsExecuted bool   `json:"one_c_actions_executed"`
}

type rulesEngineContext struct {
	SchemaVersion string                 `json:"schema_version"`
	RunID         string                 `json:"run_id"`
	Phase         string                 `json:"phase"`
	Organization  rulesOrganization      `json:"organization"`
	Period        string                 `json:"period"`
	Paths         rulesPaths             `json:"paths"`
	SourceHashes  map[string]string      `json:"source_hashes"`
	UserDecisions []any                  `json:"user_decisions"`
	PreviousState map[string]any         `json:"previous_state"`
	Meta          map[string]interface{} `json:"meta,omitempty"`
}

type rulesOrganization struct {
	ID                 string `json:"id"`
	Name               string `json:"name"`
	Path               string `json:"path"`
	CFO                string `json:"cfo,omitempty"`
	IncludeDescendants bool   `json:"include_descendants"`
}

type rulesPaths struct {
	RulesRegistry          string `json:"rules_registry"`
	R005Report             string `json:"r005_report"`
	R005Codex              string `json:"r005_codex_input"`
	StructuralControlProof string `json:"structural_control_proof"`
	OutputDir              string `json:"output_dir"`
	HandoffRoot            string `json:"handoff_root"`
}

type rulesWorkflow struct {
	SchemaVersion string `json:"schema_version"`
	RunID         string `json:"run_id"`
	Phase         string `json:"phase"`
	NextAction    string `json:"next_action"`
	Handoff       struct {
		Target      string `json:"target"`
		HandoffPath string `json:"handoff_path"`
	} `json:"handoff"`
}

func discoverRuntimeAdapter() (*RuntimeAdapter, error) {
	candidates := []string{}
	if configured := strings.TrimSpace(os.Getenv("OPIU_RUNTIME_ROOT")); configured != "" {
		candidates = append(candidates, configured)
	}
	if executable, err := os.Executable(); err == nil {
		base := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(base, "runtime"),
			filepath.Join(base, "payload"),
			base,
		)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "runtime"),
			filepath.Join(cwd, "payload"),
		)
	}

	seen := map[string]struct{}{}
	var firstError error
	for _, candidate := range candidates {
		root, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		root = filepath.Clean(root)
		if _, exists := seen[root]; exists {
			continue
		}
		seen[root] = struct{}{}
		adapter, err := runtimeAdapterAt(root)
		if err == nil {
			return adapter, nil
		}
		if firstError == nil && strings.TrimSpace(os.Getenv("OPIU_RUNTIME_ROOT")) != "" {
			firstError = err
		}
	}
	return nil, firstError
}

func runtimeAdapterAt(root string) (*RuntimeAdapter, error) {
	registry := filepath.Join(root, "rules", "rule_registry.json")
	if !regularFile(registry) {
		registry = filepath.Join(root, "data", "defaults", "rules.json")
	}

	r005Core := filepath.Join(root, "modules", "reconciliation", "source", "opiu_reconcile.mjs")
	r001Core := filepath.Join(root, "modules", "corrections", "source", "correction_engine_r001.mjs")
	r005Script := r005Core
	r001Script := r001Core
	r005Wrapper := filepath.Join(root, "modules", "reconciliation", "source", "service_r005_owner_wrapper.mjs")
	r001Wrapper := filepath.Join(root, "modules", "corrections", "source", "service_r001_owner_wrapper.mjs")
	if regularFile(r005Wrapper) {
		r005Script = r005Wrapper
	}
	if regularFile(r001Wrapper) {
		r001Script = r001Wrapper
	}

	paths := map[string]string{
		"r005":      r005Script,
		"r005_core": r005Core,
		"rules":     filepath.Join(root, "modules", "rules-engine", "source", "cli.mjs"),
		"r001":      r001Script,
		"r001_core": r001Core,
		"registry":  registry,
		"safety":    filepath.Join(root, "SAFETY.json"),
	}
	for label, path := range paths {
		if err := requireRegularBelowRoot(root, path); err != nil {
			return nil, fmt.Errorf("runtime %s: %w", label, err)
		}
	}
	if err := verifyRuntimeSafety(paths["safety"]); err != nil {
		return nil, err
	}

	nodeCandidates := []string{}
	if configured := strings.TrimSpace(os.Getenv("OPIU_NODE_PATH")); configured != "" {
		nodeCandidates = append(nodeCandidates, configured)
	}
	if runtime.GOOS == "windows" {
		nodeCandidates = append(nodeCandidates,
			filepath.Join(root, "runtime", "node", "node.exe"),
			filepath.Join(root, "runtime", "node.exe"),
			filepath.Join(root, "node.exe"),
		)
	} else {
		nodeCandidates = append(nodeCandidates,
			filepath.Join(root, "runtime", "node", "node"),
			filepath.Join(root, "runtime", "node"),
			filepath.Join(root, "node"),
		)
	}
	var node string
	for _, candidate := range nodeCandidates {
		if candidate == "" {
			continue
		}
		absolute, err := filepath.Abs(candidate)
		if err == nil && regularFile(absolute) {
			node = absolute
			break
		}
	}
	if node == "" {
		resolved, err := exec.LookPath("node")
		if err != nil {
			return nil, errors.New("Node runtime not found")
		}
		node, _ = filepath.Abs(resolved)
	}

	// Bare ESM imports used by all three modules must resolve from a shared
	// ancestor. Packaging materializes this directory from the pinned payload.
	sharedModules := filepath.Join(root, "node_modules")
	if !directoryExists(sharedModules) {
		return nil, errors.New("shared verified node_modules payload is missing")
	}

	return &RuntimeAdapter{
		Root:                 root,
		Node:                 node,
		R005Script:           paths["r005"],
		RulesScript:          paths["rules"],
		R001Script:           paths["r001"],
		R001DiagnosticScript: paths["r001_core"],
		RulesRegistry:        paths["registry"],
	}, nil
}

func verifyRuntimeSafety(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var safety runtimeSafety
	if err := json.Unmarshal(data, &safety); err != nil {
		return fmt.Errorf("invalid runtime SAFETY.json: %w", err)
	}
	if safety.Mode != "REPORT_ONLY" || safety.PostingRows != 0 || safety.ReadyToUpload || safety.ReleaseAllowed || safety.OneCActionsExecuted {
		return errors.New("runtime safety contract is not REPORT_ONLY")
	}
	return nil
}

func requireRegularBelowRoot(root, path string) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("path escaped runtime root")
	}
	if !regularFile(path) {
		return fmt.Errorf("required file is missing: %s", relative)
	}
	return nil
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func directoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func periodMode(period string) (string, error) {
	period = strings.TrimSpace(period)
	switch {
	case len(period) == 4:
		return "year", nil
	case len(period) == 7 && strings.Contains(period, "-Q"):
		return "quarter", nil
	case len(period) == 7:
		return "month", nil
	default:
		return "", fmt.Errorf("unsupported period: %s", period)
	}
}

func writeRulesContext(path string, run Run, contextValue Context, rulesRegistry, r005Report, r005Codex, structuralControlProof, rulesOutput, handoffRoot string) error {
	codexSHA, err := sha256File(r005Codex)
	if err != nil {
		return err
	}
	proofSHA, err := sha256File(structuralControlProof)
	if err != nil {
		return err
	}
	value := rulesEngineContext{
		SchemaVersion: "opiu-rules-engine-context.v1",
		RunID:         run.ID,
		Phase:         "AFTER_R005",
		Organization: rulesOrganization{
			ID:                 contextValue.OrganizationID,
			Name:               contextValue.OrganizationName,
			Path:               contextValue.OrganizationPath,
			CFO:                contextValue.CFO,
			IncludeDescendants: false,
		},
		Period: contextValue.Period,
		Paths: rulesPaths{
			RulesRegistry:          rulesRegistry,
			R005Report:             r005Report,
			R005Codex:              r005Codex,
			StructuralControlProof: structuralControlProof,
			OutputDir:              rulesOutput,
			HandoffRoot:            handoffRoot,
		},
		SourceHashes: map[string]string{
			"r005_codex_input":         strings.ToUpper(codexSHA),
			"structural_control_proof": strings.ToUpper(proofSHA),
		},
		UserDecisions: []any{},
		PreviousState: map[string]any{},
		Meta: map[string]interface{}{
			"service_context_id": contextValue.ID,
			"report_only":        true,
		},
	}
	return atomicWriteJSON(path, value)
}

func readRulesWorkflow(path string) (rulesWorkflow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return rulesWorkflow{}, err
	}
	var workflow rulesWorkflow
	if err := json.Unmarshal(data, &workflow); err != nil {
		return rulesWorkflow{}, err
	}
	if strings.TrimSpace(workflow.NextAction) == "" {
		return rulesWorkflow{}, errors.New("rules workflow next_action is missing")
	}
	return workflow, nil
}

func readValidatedRulesWorkflow(outputDir, runID, phase string) (rulesWorkflow, error) {
	workflowPath := filepath.Join(outputDir, "workflow_decision.json")
	workflow, err := readRulesWorkflow(workflowPath)
	if err != nil {
		return rulesWorkflow{}, err
	}
	expectedPhase := map[string]string{"initial": "AFTER_R005", "after-user": "AFTER_USER_DECISIONS"}[phase]
	if workflow.SchemaVersion != "opiu-rules-workflow-decision.v1" || workflow.RunID != runID || workflow.Phase != expectedPhase {
		return rulesWorkflow{}, errors.New("rules workflow schema, run or phase does not match")
	}
	switch workflow.NextAction {
	case "WAIT_USER_RULES", "RERUN_R005", "COMPLETE", "FAILED", "FAILED_NO_STATE_CHANGE":
	case "PASS_TO_R001", "RERUN_R001":
		if workflow.Handoff.Target != "R001" || strings.TrimSpace(workflow.Handoff.HandoffPath) == "" || !regularFile(workflow.Handoff.HandoffPath) {
			return rulesWorkflow{}, errors.New("rules workflow handoff is invalid")
		}
	default:
		return rulesWorkflow{}, errors.New("rules workflow next_action is unsupported")
	}
	var manifest rulesEngineManifestDocument
	if err := readStrictJSONFile(filepath.Join(outputDir, "engine_manifest.json"), &manifest); err != nil {
		return rulesWorkflow{}, err
	}
	if manifest.SchemaVersion != rulesEngineManifestSchema || manifest.RunID != runID || manifest.Phase != expectedPhase {
		return rulesWorkflow{}, errors.New("rules workflow schema, run or phase does not match")
	}
	expectedHash := strings.ToUpper(strings.TrimSpace(manifest.OutputHashes["workflow_decision.json"]))
	actualHash, err := sha256File(workflowPath)
	if err != nil || !validSHA256(expectedHash) || !strings.EqualFold(expectedHash, actualHash) {
		return rulesWorkflow{}, errors.New("rules workflow does not match engine manifest")
	}
	return workflow, nil
}
