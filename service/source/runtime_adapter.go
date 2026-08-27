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
// imported R005 and R001 modules. The Service never downloads or
// executes arbitrary code: every entrypoint is resolved below one explicit
// runtime root and is launched as an argv vector without a shell.
type RuntimeAdapter struct {
	Root                 string
	Node                 string
	R005Script           string
	R001Script           string
	R001DiagnosticScript string
}

type runtimeSafety struct {
	Mode                string `json:"mode"`
	PostingRows         int    `json:"posting_rows"`
	ReadyToUpload       bool   `json:"ready_to_upload"`
	ReleaseAllowed      bool   `json:"release_allowed"`
	OneCActionsExecuted bool   `json:"one_c_actions_executed"`
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
		"r001":      r001Script,
		"r001_core": r001Core,
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

	// Bare ESM imports used by both modules must resolve from a shared
	// ancestor. Packaging materializes this directory from the pinned payload.
	sharedModules := filepath.Join(root, "node_modules")
	if !directoryExists(sharedModules) {
		return nil, errors.New("shared verified node_modules payload is missing")
	}

	return &RuntimeAdapter{
		Root:                 root,
		Node:                 node,
		R005Script:           paths["r005"],
		R001Script:           paths["r001"],
		R001DiagnosticScript: paths["r001_core"],
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
