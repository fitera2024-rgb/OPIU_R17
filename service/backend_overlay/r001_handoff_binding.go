package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var r001HandoffSHA256V194 = regexp.MustCompile(`(?i)^[0-9a-f]{64}$`)

type r001HandoffBindingV194 struct {
	RunID                string
	Run                  map[string]any
	HandoffPath          string
	HandoffSHA256        string
	ReconciliationPath   string
	ReconciliationSHA256 string
	CodexInputPath       string
	CodexInputSHA256     string
	RulesPath            string
	RulesSHA256          string
	ApplicationsPath     string
	ApplicationsSHA256   string
	RulesRevisionSetHash string
	OrganizationID       string
	OrganizationName     string
	OrganizationPath     string
	Period               string
}

// verifiedR001HandoffBindingV194 resolves R001 only through the handoff emitted
// by the current Rules Engine execution of the active run. It deliberately does
// not scan artifacts, sort by timestamps, or derive a companion filename from
// an XLSX path.
func (a *App) verifiedR001HandoffBindingV194(body, settings map[string]any) (*r001HandoffBindingV194, error) {
	activeRunID := safeID(asString(settings["active_run_id"]))
	if activeRunID == "" {
		return nil, errors.New("R001_HANDOFF_ACTIVE_RUN_REQUIRED")
	}
	requestedRunID := safeID(asString(body["run_id"]))
	if requestedRunID != "" && requestedRunID != activeRunID {
		return nil, fmt.Errorf("R001_HANDOFF_RUN_MISMATCH: requested=%s active=%s", requestedRunID, activeRunID)
	}

	run, err := a.rulesEngineRunRecord(activeRunID)
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_ACTIVE_RUN_NOT_FOUND: %w", err)
	}
	if asString(run["run_id"]) != activeRunID {
		return nil, errors.New("R001_HANDOFF_RUN_RECORD_MISMATCH")
	}

	nextAction := asString(run["rules_next_action"])
	if nextAction != "PASS_TO_R001" && nextAction != "RERUN_R001" {
		return nil, fmt.Errorf("R001_HANDOFF_NOT_AUTHORIZED: next_action=%s", nextAction)
	}
	handoffRoot, err := a.rulesEngineDataDirectory(asString(run["rules_handoff_dir"]))
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_DIRECTORY_INVALID: %w", err)
	}
	handoffDir := filepath.Join(handoffRoot, "r001")
	handoffPath, err := a.rulesEngineDataFile(filepath.Join(handoffDir, "r001_handoff.json"))
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_NOT_FOUND: %w", err)
	}

	decisionPath, err := a.rulesEngineDataFile(asString(run["rules_workflow_decision_path"]))
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_WORKFLOW_DECISION_MISSING: %w", err)
	}
	decision := map[string]any{}
	if err := readJSON(decisionPath, &decision); err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_WORKFLOW_DECISION_INVALID: %w", err)
	}
	if asString(decision["run_id"]) != activeRunID || asString(decision["next_action"]) != nextAction {
		return nil, errors.New("R001_HANDOFF_WORKFLOW_DECISION_MISMATCH")
	}
	workflowHandoff, _ := decision["handoff"].(map[string]any)
	if workflowHandoff == nil || asString(workflowHandoff["target"]) != "R001" || !sameR001PathV194(asString(workflowHandoff["handoff_path"]), handoffPath) {
		return nil, errors.New("R001_HANDOFF_WORKFLOW_TARGET_MISMATCH")
	}
	if err := a.verifyExactR001ArtifactV194(activeRunID, "RULES_WORKFLOW_DECISION", "RULES", decisionPath, "", asString(run["rules_execution_id"])); err != nil {
		return nil, err
	}

	handoff := map[string]any{}
	if err := readJSON(handoffPath, &handoff); err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_JSON_INVALID: %w", err)
	}
	if asString(handoff["schema_version"]) != "opiu-r001-handoff.v1" {
		return nil, errors.New("R001_HANDOFF_SCHEMA_MISMATCH")
	}
	if asString(handoff["run_id"]) != activeRunID || asString(handoff["source_r005_run_id"]) != activeRunID {
		return nil, errors.New("R001_HANDOFF_RUN_MISMATCH")
	}

	organization, _ := handoff["organization"].(map[string]any)
	if organization == nil {
		return nil, errors.New("R001_HANDOFF_ORGANIZATION_REQUIRED")
	}
	organizationID := strings.TrimSpace(asString(organization["id"]))
	organizationName := strings.TrimSpace(asString(organization["name"]))
	organizationPath := strings.TrimSpace(asString(organization["path"]))
	period := strings.TrimSpace(asString(handoff["period"]))
	if organizationID == "" || organizationName == "" || organizationPath == "" || period == "" {
		return nil, errors.New("R001_HANDOFF_ORGANIZATION_PERIOD_REQUIRED")
	}
	if organizationID != strings.TrimSpace(asString(run["organization_id"])) ||
		organizationName != strings.TrimSpace(asString(run["organization_name"])) ||
		organizationPath != strings.TrimSpace(asString(run["organization_path"])) {
		return nil, errors.New("R001_HANDOFF_ORGANIZATION_MISMATCH")
	}
	if period != strings.TrimSpace(asString(run["period"])) {
		return nil, errors.New("R001_HANDOFF_PERIOD_MISMATCH")
	}
	for key, expected := range map[string]string{
		"organization_id":   organizationID,
		"organization_name": organizationName,
		"organization_path": organizationPath,
		"period":            period,
	} {
		if actual := strings.TrimSpace(asString(settings[key])); actual == "" || actual != expected {
			return nil, fmt.Errorf("R001_HANDOFF_ACTIVE_CONTEXT_MISMATCH: %s", key)
		}
		if requested := strings.TrimSpace(asString(body[key])); requested != "" && requested != expected {
			return nil, fmt.Errorf("R001_HANDOFF_REQUEST_CONTEXT_MISMATCH: %s", key)
		}
	}

	reconciliation, _ := handoff["reconciliation"].(map[string]any)
	rules, _ := handoff["rules"].(map[string]any)
	applications, _ := handoff["applications"].(map[string]any)
	if reconciliation == nil || rules == nil || applications == nil {
		return nil, errors.New("R001_HANDOFF_SECTIONS_REQUIRED")
	}
	reconciliationPath, reconciliationHash, err := a.verifyR001HandoffFileV194(reconciliation, "path", "sha256")
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_RECONCILIATION_INVALID: %w", err)
	}
	codexInputPath, codexInputHash, err := a.verifyR001HandoffFileV194(reconciliation, "codex_input_path", "codex_input_sha256")
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_CODEX_INPUT_INVALID: %w", err)
	}
	rulesPath, rulesHash, err := a.verifyR001HandoffFileV194(rules, "path", "sha256")
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_RULES_INVALID: %w", err)
	}
	applicationsPath, applicationsHash, err := a.verifyR001HandoffFileV194(applications, "path", "sha256")
	if err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_APPLICATIONS_INVALID: %w", err)
	}
	if !sameR001PathV194(rulesPath, filepath.Join(handoffDir, "engine_rules.json")) ||
		!sameR001PathV194(applicationsPath, filepath.Join(handoffDir, "r001_rule_application_drafts.json")) {
		return nil, errors.New("R001_HANDOFF_INTERNAL_PATH_MISMATCH")
	}
	if !sameR001PathV194(asString(workflowHandoff["rules_path"]), rulesPath) ||
		!sameR001PathV194(asString(workflowHandoff["applications_path"]), applicationsPath) {
		return nil, errors.New("R001_HANDOFF_WORKFLOW_FILES_MISMATCH")
	}
	for key, actual := range map[string]string{
		"rules_sha256":        rulesHash,
		"applications_sha256": applicationsHash,
	} {
		expected := strings.TrimSpace(asString(workflowHandoff[key]))
		if !r001HandoffSHA256V194.MatchString(expected) || !strings.EqualFold(expected, actual) {
			return nil, fmt.Errorf("R001_HANDOFF_WORKFLOW_HASH_MISMATCH: %s", key)
		}
	}
	rulesRevisionSetHash := strings.TrimSpace(asString(rules["rules_revision_set_hash"]))
	if rulesRevisionSetHash == "" || rulesRevisionSetHash != strings.TrimSpace(asString(decision["rules_revision_set_hash"])) {
		return nil, errors.New("R001_HANDOFF_RULES_REVISION_MISMATCH")
	}
	if requested := strings.TrimSpace(asString(body["reconciliation_path"])); requested != "" && !sameR001PathV194(requested, reconciliationPath) {
		return nil, errors.New("R001_HANDOFF_RECONCILIATION_REQUEST_MISMATCH")
	}
	if err := a.verifyExactR001ArtifactV194(activeRunID, "RECONCILIATION_REPORT", "R005", reconciliationPath, reconciliationHash, ""); err != nil {
		return nil, err
	}
	if err := a.verifyExactR001ArtifactV194(activeRunID, "EVIDENCE_JSON", "R005", codexInputPath, codexInputHash, ""); err != nil {
		return nil, err
	}

	codexInput := map[string]any{}
	if err := readJSON(codexInputPath, &codexInput); err != nil {
		return nil, fmt.Errorf("R001_HANDOFF_CODEX_INPUT_JSON_INVALID: %w", err)
	}
	if reportHash := strings.TrimSpace(asString(codexInput["report_sha256"])); reportHash == "" || !strings.EqualFold(reportHash, reconciliationHash) {
		return nil, errors.New("R001_HANDOFF_REPORT_CODEX_INPUT_HASH_MISMATCH")
	}
	for label, filePath := range map[string]string{"rules": rulesPath, "applications": applicationsPath} {
		doc := map[string]any{}
		if err := readJSON(filePath, &doc); err != nil || asString(doc["run_id"]) != activeRunID {
			return nil, fmt.Errorf("R001_HANDOFF_%s_RUN_MISMATCH", strings.ToUpper(label))
		}
		if label == "applications" {
			if err := validateR001DraftApplicationsV194(doc, activeRunID, organizationID, period); err != nil {
				return nil, err
			}
			if err := a.validateR001DraftAccountSelectionsV194(doc); err != nil {
				return nil, err
			}
		}
	}

	handoffHash, err := fileSHA256V041(handoffPath)
	if err != nil {
		return nil, err
	}
	workflowHandoffHash := strings.TrimSpace(asString(workflowHandoff["handoff_sha256"]))
	if !r001HandoffSHA256V194.MatchString(workflowHandoffHash) || !strings.EqualFold(workflowHandoffHash, handoffHash) {
		return nil, errors.New("R001_HANDOFF_WORKFLOW_HASH_MISMATCH: handoff_sha256")
	}
	return &r001HandoffBindingV194{
		RunID: activeRunID, Run: run, HandoffPath: handoffPath, HandoffSHA256: handoffHash,
		ReconciliationPath: reconciliationPath, ReconciliationSHA256: reconciliationHash,
		CodexInputPath: codexInputPath, CodexInputSHA256: codexInputHash,
		RulesPath: rulesPath, RulesSHA256: rulesHash,
		ApplicationsPath: applicationsPath, ApplicationsSHA256: applicationsHash,
		RulesRevisionSetHash: rulesRevisionSetHash,
		OrganizationID:       organizationID, OrganizationName: organizationName, OrganizationPath: organizationPath, Period: period,
	}, nil
}

func requireFalseR001DraftV194(item map[string]any, key string) bool {
	value, ok := item[key]
	flag, isBool := value.(bool)
	return ok && isBool && !flag
}

func validateR001DraftApplicationsV194(document map[string]any, runID, organizationID, period string) error {
	if asString(document["schema_version"]) != "opiu-rule-applications.v1" {
		return errors.New("R001_HANDOFF_APPLICATIONS_SCHEMA_MISMATCH")
	}
	safety, _ := document["safety"].(map[string]any)
	if safety == nil || !asBool(safety["report_only"]) || int(asFloat(safety["posting_rows"])) != 0 ||
		!requireFalseR001DraftV194(safety, "ready_to_upload") ||
		!requireFalseR001DraftV194(safety, "release_allowed") ||
		!requireFalseR001DraftV194(safety, "live_1c_allowed") {
		return errors.New("R001_HANDOFF_APPLICATIONS_SAFETY_MISMATCH")
	}
	seenApplications := map[string]bool{}
	seenCandidates := map[string]bool{}
	for _, raw := range anySlice(document["applications"]) {
		application, _ := raw.(map[string]any)
		candidate, _ := application["candidate_snapshot"].(map[string]any)
		if application == nil || candidate == nil {
			return errors.New("R001_HANDOFF_APPLICATION_SNAPSHOT_REQUIRED")
		}
		applicationID := strings.TrimSpace(asString(application["application_id"]))
		candidateID := strings.TrimSpace(asString(application["candidate_id"]))
		if applicationID == "" || candidateID == "" || seenApplications[applicationID] || seenCandidates[candidateID] || asString(candidate["candidate_id"]) != candidateID {
			return errors.New("R001_HANDOFF_APPLICATION_IDENTITY_MISMATCH")
		}
		seenApplications[applicationID] = true
		seenCandidates[candidateID] = true
		if asString(application["run_id"]) != runID || asString(application["organization_id"]) != organizationID || asString(application["period"]) != period {
			return errors.New("R001_HANDOFF_APPLICATION_CONTEXT_MISMATCH")
		}
		scope, _ := candidate["scope"].(map[string]any)
		if scope == nil || strings.TrimSpace(asString(scope["organization_id"])) != organizationID {
			return errors.New("R001_HANDOFF_APPLICATION_SCOPE_MISMATCH")
		}
		action, _ := candidate["action"].(map[string]any)
		actionType := strings.ToUpper(strings.TrimSpace(asString(action["action_type"])))
		if actionType != "STORNO_REPOST" && actionType != "ONE_SIDE" {
			return errors.New("R001_HANDOFF_APPLICATION_ACTION_FORBIDDEN")
		}
		status := strings.ToUpper(strings.TrimSpace(asString(application["result_status"])))
		if status != "PROPOSED" && status != "REVIEW" {
			return errors.New("R001_HANDOFF_APPLICATION_STATUS_FORBIDDEN")
		}
		if !requireFalseR001DraftV194(application, "execution_allowed") ||
			!requireFalseR001DraftV194(application, "ready_to_upload") ||
			!requireFalseR001DraftV194(application, "release_allowed") ||
			!requireFalseR001DraftV194(application, "live_1c_allowed") ||
			int(asFloat(application["posting_rows"])) != 0 {
			return errors.New("R001_HANDOFF_APPLICATION_SAFETY_MISMATCH")
		}
		if !asBool(application["disputed_only"]) || strings.ToUpper(strings.TrimSpace(asString(application["output_route"]))) != "СПОРНО" ||
			strings.ToUpper(strings.TrimSpace(asString(application["proof_status"]))) != "UNPROVEN" ||
			strings.ToUpper(strings.TrimSpace(asString(application["review_state"]))) != "NEEDS_REVIEW" {
			return errors.New("R001_HANDOFF_DISPUTED_APPLICATION_MISMATCH")
		}
	}
	return nil
}

func (a *App) validateR001DraftAccountSelectionsV194(document map[string]any) error {
	var catalog erpAccountCatalogV194
	loaded := false
	for _, raw := range anySlice(document["applications"]) {
		application, _ := raw.(map[string]any)
		candidate, _ := application["candidate_snapshot"].(map[string]any)
		selection, _ := candidate["account_selection"].(map[string]any)
		if selection == nil {
			continue
		}
		if !loaded {
			var err error
			catalog, err = a.erpAccountCatalogV194()
			if err != nil {
				return errors.New("R001_HANDOFF_ACCOUNT_CATALOG_UNAVAILABLE")
			}
			loaded = true
		}
		if strings.TrimSpace(asString(selection["catalog_version_id"])) != catalog.VersionID {
			return errors.New("R001_HANDOFF_ACCOUNT_CATALOG_VERSION_MISMATCH")
		}
		accounting, _ := candidate["accounting"].(map[string]any)
		selected := 0
		for idKey, codeKey := range map[string]string{"debit_account_id": "debit_account", "credit_account_id": "credit_account"} {
			id := strings.TrimSpace(asString(selection[idKey]))
			if id == "" {
				continue
			}
			selected++
			item, ok := catalog.ByID[id]
			if !ok || accounting == nil || strings.TrimSpace(asString(accounting[codeKey])) != item.Code {
				return errors.New("R001_HANDOFF_ACCOUNT_SELECTION_MISMATCH")
			}
		}
		if selected == 0 {
			return errors.New("R001_HANDOFF_ACCOUNT_SELECTION_EMPTY")
		}
	}
	return nil
}

func (a *App) verifyR001HandoffFileV194(section map[string]any, pathKey, hashKey string) (string, string, error) {
	expectedHash := strings.TrimSpace(asString(section[hashKey]))
	if !r001HandoffSHA256V194.MatchString(expectedHash) {
		return "", "", fmt.Errorf("%s is not SHA-256", hashKey)
	}
	filePath, err := a.rulesEngineDataFile(asString(section[pathKey]))
	if err != nil {
		return "", "", err
	}
	actualHash, err := fileSHA256V041(filePath)
	if err != nil {
		return "", "", err
	}
	if !strings.EqualFold(expectedHash, actualHash) {
		return "", "", fmt.Errorf("R001_HANDOFF_HASH_MISMATCH: %s", filepath.Base(filePath))
	}
	return filePath, actualHash, nil
}

func (a *App) verifyExactR001ArtifactV194(runID, artifactType, stage, expectedPath, expectedHash, executionID string) error {
	artifacts := map[string]any{}
	if err := readJSON(filepath.Join(a.DataRoot, "artifacts", "index.json"), &artifacts); err != nil {
		return err
	}
	for _, raw := range anySlice(artifacts["artifacts"]) {
		item, _ := raw.(map[string]any)
		if item == nil || asString(item["run_id"]) != runID || asString(item["artifact_type"]) != artifactType || asString(item["stage"]) != stage {
			continue
		}
		if executionID != "" && asString(item["rules_execution_id"]) != executionID {
			continue
		}
		if !sameR001PathV194(asString(item["path"]), expectedPath) {
			continue
		}
		registeredHash := strings.TrimSpace(asString(item["sha256"]))
		if !r001HandoffSHA256V194.MatchString(registeredHash) {
			return fmt.Errorf("R001_HANDOFF_ARTIFACT_HASH_REQUIRED: %s", artifactType)
		}
		actualHash, err := fileSHA256V041(expectedPath)
		if err != nil {
			return err
		}
		if !strings.EqualFold(registeredHash, actualHash) || (expectedHash != "" && !strings.EqualFold(expectedHash, actualHash)) {
			return fmt.Errorf("R001_HANDOFF_ARTIFACT_HASH_MISMATCH: %s", artifactType)
		}
		return nil
	}
	return fmt.Errorf("R001_HANDOFF_EXACT_ARTIFACT_NOT_REGISTERED: %s", artifactType)
}

func sameR001PathV194(left, right string) bool {
	if strings.TrimSpace(left) == "" || strings.TrimSpace(right) == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(filepath.Clean(left))
	rightAbs, rightErr := filepath.Abs(filepath.Clean(right))
	return leftErr == nil && rightErr == nil && strings.EqualFold(leftAbs, rightAbs)
}
