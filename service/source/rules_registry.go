package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	rulesRegistrySchema       = "opiu-rule-registry.v2"
	rulesRegistryResultSchema = "opiu-rule-registry-result.v1"
	rulesEngineManifestSchema = "opiu-rules-engine-manifest.v1"
)

var internalRulesRunID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,240}$`)

type persistentRulesRegistry struct {
	mu          sync.Mutex
	path        string
	bundledSeed string
	runsRoot    string
}

type rulesRegistryPersistenceReceipt struct {
	SchemaVersion          string    `json:"schema_version"`
	RunID                  string    `json:"run_id"`
	Phase                  string    `json:"phase"`
	RegistryPersisted      bool      `json:"registry_persisted"`
	RegistryPersistedCount int       `json:"registry_persisted_count"`
	RecordedAt             time.Time `json:"recorded_at"`
}

type rulesEngineManifestDocument struct {
	SchemaVersion        string            `json:"schema_version"`
	RunID                string            `json:"run_id"`
	Phase                string            `json:"phase"`
	RegistryInputSHA256  string            `json:"registry_input_sha256"`
	SourceHashes         map[string]string `json:"source_hashes"`
	OutputHashes         map[string]string `json:"output_hashes"`
	RulesRevisionSetHash string            `json:"rules_revision_set_hash"`
}

type rulesRegistryResultDocument struct {
	SchemaVersion      string           `json:"schema_version"`
	RunID              string           `json:"run_id"`
	BaseRegistrySHA256 string           `json:"base_registry_sha256"`
	Registry           map[string]any   `json:"registry"`
	DecisionAudit      []map[string]any `json:"decision_audit"`
}

type rulesDecisionBinding struct {
	CandidateID       string `json:"candidate_id"`
	Decision          string `json:"decision"`
	CandidateDecision string `json:"candidate_decision"`
	ImpactClass       string `json:"impact_class"`
	ActionType        string `json:"action_type"`
}

func newPersistentRulesRegistry(store *Store, bundledSeed string) (*persistentRulesRegistry, error) {
	if store == nil || strings.TrimSpace(bundledSeed) == "" {
		return nil, errors.New("persistent rules registry requires a store and bundled seed")
	}
	seedPath, err := filepath.Abs(bundledSeed)
	if err != nil {
		return nil, err
	}
	registry := &persistentRulesRegistry{
		path:        filepath.Join(store.Root(), "rules", "rules.json"),
		bundledSeed: seedPath,
		runsRoot:    store.RunsDir(),
	}
	if err := registry.initialize(); err != nil {
		return nil, err
	}
	return registry, nil
}

func (r *persistentRulesRegistry) initialize() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return fmt.Errorf("create persistent rules directory: %w", err)
	}
	if _, err := os.Stat(r.path); err == nil {
		if _, err := readRulesRegistry(r.path); err != nil {
			return fmt.Errorf("persistent rules registry is invalid: %w", err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	seed, err := os.ReadFile(r.bundledSeed)
	if err != nil {
		return fmt.Errorf("read bundled rules registry: %w", err)
	}
	if _, err := decodeRulesRegistry(seed); err != nil {
		return fmt.Errorf("bundled rules registry is invalid: %w", err)
	}
	if err := atomicWritePrivateFile(r.path, seed); err != nil {
		return fmt.Errorf("seed persistent rules registry: %w", err)
	}
	return nil
}

func (r *persistentRulesRegistry) Path() string {
	return r.path
}

func (r *persistentRulesRegistry) snapshot(runID, phase string) (string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !internalRulesRunID.MatchString(runID) {
		return "", "", errors.New("invalid run id for rules snapshot")
	}
	if phase != "initial" && phase != "after-user" {
		return "", "", errors.New("invalid rules snapshot phase")
	}
	if err := r.writePersistenceReceiptLocked(runID, phase, false, 0); err != nil {
		return "", "", fmt.Errorf("initialize rules persistence receipt: %w", err)
	}
	data, err := os.ReadFile(r.path)
	if err != nil {
		return "", "", fmt.Errorf("read persistent rules registry: %w", err)
	}
	if _, err := decodeRulesRegistry(data); err != nil {
		return "", "", fmt.Errorf("persistent rules registry is invalid: %w", err)
	}
	hash := sha256Bytes(data)
	destination := filepath.Join(r.runsRoot, runID, "rules-input", phase, "current_rules.json")
	if err := writeImmutablePrivateFile(destination, data); err != nil {
		return "", "", fmt.Errorf("write rules snapshot: %w", err)
	}
	return destination, hash, nil
}

func (r *persistentRulesRegistry) mergeEngineOutput(runID, phase, outputDir, expectedBaseSHA256 string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !internalRulesRunID.MatchString(runID) || (phase != "initial" && phase != "after-user") {
		return 0, errors.New("invalid run or phase for rules registry merge")
	}
	expectedOutputDir := filepath.Join(r.runsRoot, runID, map[string]string{"initial": "rules", "after-user": "rules-after-user"}[phase])
	actualOutputDir, err := filepath.Abs(outputDir)
	if err != nil || !sameCleanPath(actualOutputDir, expectedOutputDir) {
		return 0, errors.New("Rules Engine output directory is outside the registered run phase")
	}
	if !validSHA256(expectedBaseSHA256) {
		return 0, errors.New("invalid expected rules registry hash")
	}
	manifestPath := filepath.Join(outputDir, "engine_manifest.json")
	resultPath := filepath.Join(outputDir, "registry_result.json")
	var manifest rulesEngineManifestDocument
	if err := readStrictJSONFile(manifestPath, &manifest); err != nil {
		return 0, fmt.Errorf("read Rules Engine manifest: %w", err)
	}
	expectedEnginePhase := map[string]string{"initial": "AFTER_R005", "after-user": "AFTER_USER_DECISIONS"}[phase]
	if manifest.SchemaVersion != rulesEngineManifestSchema || manifest.RunID != runID || manifest.Phase != expectedEnginePhase {
		return 0, errors.New("Rules Engine manifest schema or run does not match")
	}
	manifestInputHash := strings.ToUpper(strings.TrimSpace(manifest.RegistryInputSHA256))
	if !validSHA256(manifestInputHash) || !strings.EqualFold(manifestInputHash, expectedBaseSHA256) {
		return 0, errors.New("Rules Engine manifest registry input hash does not match snapshot")
	}
	expectedResultHash := strings.ToUpper(strings.TrimSpace(manifest.OutputHashes["registry_result.json"]))
	if !validSHA256(expectedResultHash) {
		return 0, errors.New("Rules Engine manifest does not bind registry_result.json")
	}
	actualResultHash, err := sha256File(resultPath)
	if err != nil {
		return 0, fmt.Errorf("hash registry_result.json: %w", err)
	}
	if !strings.EqualFold(expectedResultHash, actualResultHash) {
		return 0, errors.New("registry_result.json hash does not match Rules Engine manifest")
	}
	var result rulesRegistryResultDocument
	if err := readStrictJSONFile(resultPath, &result); err != nil {
		return 0, fmt.Errorf("read registry_result.json: %w", err)
	}
	if result.SchemaVersion != rulesRegistryResultSchema || result.RunID != runID {
		return 0, errors.New("registry_result.json schema or run does not match")
	}
	baseHash := strings.ToUpper(strings.TrimSpace(result.BaseRegistrySHA256))
	if !validSHA256(baseHash) || !strings.EqualFold(baseHash, manifestInputHash) || !strings.EqualFold(baseHash, expectedBaseSHA256) {
		return 0, errors.New("registry_result.json base hash does not match manifest snapshot")
	}
	if err := validateRulesRegistry(result.Registry); err != nil {
		return 0, fmt.Errorf("registry_result.json contains invalid registry: %w", err)
	}
	currentHash, err := sha256File(r.path)
	if err != nil {
		return 0, fmt.Errorf("hash persistent rules registry: %w", err)
	}
	if !strings.EqualFold(currentHash, baseHash) {
		return 0, errors.New("RULE_REGISTRY_CHANGED_DURING_RUN")
	}
	current, err := readRulesRegistry(r.path)
	if err != nil {
		return 0, fmt.Errorf("read persistent rules registry: %w", err)
	}
	resultRevisionHash := strings.ToUpper(strings.TrimSpace(stringField(result.Registry, "rules_revision_set_hash")))
	manifestRevisionHash := strings.ToUpper(strings.TrimSpace(manifest.RulesRevisionSetHash))
	if !validSHA256(manifestRevisionHash) || (phase == "after-user" && resultRevisionHash == "") || (resultRevisionHash != "" && (!validSHA256(resultRevisionHash) || !strings.EqualFold(resultRevisionHash, manifestRevisionHash))) {
		return 0, errors.New("registry_result rules revision hash does not match Rules Engine manifest")
	}
	decisionBindings, err := r.readDecisionBindingsLocked(runID, phase, manifest)
	if err != nil {
		return 0, err
	}
	merged, changed, persistedRuleCount, err := mergeAuditedRegistryResult(current, result.Registry, result.DecisionAudit, runID, phase, decisionBindings)
	if err != nil {
		return 0, err
	}
	if persistedRuleCount > 0 {
		addPersistenceMarker(merged, runID, phase, persistedRuleCount)
		delete(merged, "rules_revision_set_hash")
		changed = true
	}
	if changed {
		if err := atomicWritePrivateJSON(r.path, merged); err != nil {
			return 0, fmt.Errorf("write persistent rules registry: %w", err)
		}
	}
	return persistedRuleCount, nil
}

func (r *persistentRulesRegistry) writePersistenceReceiptLocked(runID, phase string, persisted bool, count int) error {
	receipt := rulesRegistryPersistenceReceipt{
		SchemaVersion:          "opiu-rules-registry-persistence.v1",
		RunID:                  runID,
		Phase:                  phase,
		RegistryPersisted:      persisted,
		RegistryPersistedCount: count,
		RecordedAt:             time.Now().UTC(),
	}
	return atomicWritePrivateJSON(filepath.Join(r.runsRoot, runID, "rules-registry", "persistence.json"), receipt)
}

func (r *persistentRulesRegistry) readDecisionBindingsLocked(runID, phase string, manifest rulesEngineManifestDocument) (map[string]rulesDecisionBinding, error) {
	if phase == "initial" {
		return map[string]rulesDecisionBinding{}, nil
	}
	decisionsPath := filepath.Join(r.runsRoot, runID, "rules-review", "user_rule_decisions.json")
	decisionsHash, err := sha256File(decisionsPath)
	if err != nil {
		return nil, fmt.Errorf("hash saved user decisions: %w", err)
	}
	if !strings.EqualFold(manifest.SourceHashes["user_decisions"], decisionsHash) {
		return nil, errors.New("Rules Engine manifest does not bind the exact saved user decisions")
	}
	var decisions ruleReviewDecisionDocument
	if err := readStrictJSONFile(decisionsPath, &decisions); err != nil || decisions.SchemaVersion != "opiu-user-rule-decisions.v1" || decisions.RunID != runID || !validSHA256(decisions.SourceCandidatesSHA256) {
		return nil, errors.New("saved user decisions are invalid")
	}
	decisionByCandidate := make(map[string]string, len(decisions.Decisions))
	for _, decision := range decisions.Decisions {
		candidateID := strings.TrimSpace(decision.CandidateID)
		if candidateID == "" || decisionByCandidate[candidateID] != "" {
			return nil, errors.New("saved user decisions contain an invalid candidate id")
		}
		decisionByCandidate[candidateID] = strings.ToUpper(strings.TrimSpace(decision.Decision))
	}
	bindings := make(map[string]rulesDecisionBinding, len(decisions.ServiceCandidateBindings))
	for _, binding := range decisions.ServiceCandidateBindings {
		binding.CandidateID = strings.TrimSpace(binding.CandidateID)
		binding.Decision = strings.ToUpper(strings.TrimSpace(binding.Decision))
		if binding.CandidateID == "" || bindings[binding.CandidateID].CandidateID != "" || decisionByCandidate[binding.CandidateID] != binding.Decision {
			return nil, errors.New("candidate binding does not match saved user decisions")
		}
		bindings[binding.CandidateID] = binding
	}
	if len(bindings) != len(decisionByCandidate) {
		return nil, errors.New("candidate binding is incomplete")
	}
	return bindings, nil
}

func eligibleDecisionForAudit(decision, action string) bool {
	decision = strings.ToUpper(strings.TrimSpace(decision))
	if action == "NEW_RULE" {
		return decision == "CONFIRMED"
	}
	return action == "NEW_REVISION" && (decision == "CONFIRMED" || decision == "CREATE_REVISION")
}

func addPersistenceMarker(registry map[string]any, runID, phase string, count int) {
	markers, _ := registry["service_persistence"].(map[string]any)
	if markers == nil {
		markers = map[string]any{}
	}
	markers[runID] = map[string]any{
		"schema_version":           "opiu-rules-registry-persistence.v1",
		"run_id":                   runID,
		"phase":                    phase,
		"registry_persisted":       true,
		"registry_persisted_count": count,
		"recorded_at":              time.Now().UTC().Format(time.RFC3339Nano),
	}
	registry["service_persistence"] = markers
}

func (r *persistentRulesRegistry) persistenceReceipt(runID string) rulesRegistryPersistenceReceipt {
	r.mu.Lock()
	defer r.mu.Unlock()
	if internalRulesRunID.MatchString(runID) {
		if registry, err := readRulesRegistry(r.path); err == nil {
			if markers, ok := registry["service_persistence"].(map[string]any); ok {
				if marker, ok := markers[runID].(map[string]any); ok {
					count, countOK := intField(marker, "registry_persisted_count")
					if countOK && count > 0 && stringField(marker, "run_id") == runID {
						return rulesRegistryPersistenceReceipt{SchemaVersion: "opiu-rules-registry-persistence.v1", RunID: runID, Phase: stringField(marker, "phase"), RegistryPersisted: true, RegistryPersistedCount: count}
					}
				}
			}
		}
	}
	return readRulesPersistenceReceipt(r.runsRoot, runID)
}

func readRulesPersistenceReceipt(runsRoot, runID string) rulesRegistryPersistenceReceipt {
	receipt := rulesRegistryPersistenceReceipt{RunID: runID}
	if !internalRulesRunID.MatchString(runID) {
		return receipt
	}
	path := filepath.Join(runsRoot, runID, "rules-registry", "persistence.json")
	if err := readStrictJSONFile(path, &receipt); err != nil || receipt.SchemaVersion != "opiu-rules-registry-persistence.v1" || receipt.RunID != runID || receipt.RegistryPersistedCount < 0 {
		return rulesRegistryPersistenceReceipt{RunID: runID}
	}
	if !receipt.RegistryPersisted {
		receipt.RegistryPersistedCount = 0
	}
	return receipt
}

func mergeAuditedRegistryResult(current, result map[string]any, audit []map[string]any, runID, phase string, bindings map[string]rulesDecisionBinding) (map[string]any, bool, int, error) {
	next, err := cloneJSONObject(current)
	if err != nil {
		return nil, false, 0, err
	}
	currentRules, _ := objectSlice(next, "rules")
	currentRevisions, _ := objectSlice(next, "revisions")
	resultRules, _ := objectSlice(result, "rules")
	resultRevisions, _ := objectSlice(result, "revisions")
	resultRuleByRevision, err := indexObjects(resultRules, "revision_id")
	if err != nil {
		return nil, false, 0, fmt.Errorf("index result rules: %w", err)
	}
	resultRevisionByID, err := indexObjects(resultRevisions, "revision_id")
	if err != nil {
		return nil, false, 0, fmt.Errorf("index result revisions: %w", err)
	}
	currentRuleByRevision, err := indexObjects(currentRules, "revision_id")
	if err != nil {
		return nil, false, 0, fmt.Errorf("index current rules: %w", err)
	}
	currentRevisionByID, err := indexObjects(currentRevisions, "revision_id")
	if err != nil {
		return nil, false, 0, fmt.Errorf("index current revisions: %w", err)
	}

	auditedRevisions := map[string]map[string]any{}
	auditedCandidates := map[string]bool{}
	for _, entry := range audit {
		action := stringField(entry, "action")
		if action != "NEW_RULE" && action != "NEW_REVISION" {
			continue
		}
		if phase == "initial" {
			return nil, false, 0, errors.New("initial Rules phase cannot persist a new rule or revision")
		}
		candidateID := stringField(entry, "candidate_id")
		binding, ok := bindings[candidateID]
		if candidateID == "" || !ok || !eligibleDecisionForAudit(binding.Decision, action) {
			return nil, false, 0, errors.New("audited rule change is not bound to an eligible saved user decision")
		}
		if auditedCandidates[candidateID] {
			return nil, false, 0, fmt.Errorf("candidate %s produced more than one audited rule change", candidateID)
		}
		auditedCandidates[candidateID] = true
		if strings.EqualFold(binding.ImpactClass, "CONTROL_ONLY") || strings.EqualFold(binding.CandidateDecision, "NO_RULE") || strings.EqualFold(binding.ActionType, "CONTROL_ONLY") {
			return nil, false, 0, errors.New("CONTROL_ONLY candidate cannot persist a rule")
		}
		ruleID := stringField(entry, "rule_id")
		revisionID := stringField(entry, "revision_id")
		if ruleID == "" || revisionID == "" {
			return nil, false, 0, errors.New("audited rule change is missing rule_id or revision_id")
		}
		if _, duplicate := auditedRevisions[revisionID]; duplicate {
			return nil, false, 0, fmt.Errorf("duplicate audited revision %s", revisionID)
		}
		rule := resultRuleByRevision[revisionID]
		revision := resultRevisionByID[revisionID]
		if rule == nil || revision == nil || stringField(rule, "rule_id") != ruleID || stringField(revision, "rule_id") != ruleID {
			return nil, false, 0, fmt.Errorf("audited revision %s is not bound to its result rule", revisionID)
		}
		if containsForbiddenRuleAmount(rule) || containsForbiddenRuleAmount(revision) {
			return nil, false, 0, fmt.Errorf("audited revision %s contains forbidden financial amount", revisionID)
		}
		auditedRevisions[revisionID] = map[string]any{"action": action, "rule_id": ruleID, "rule": rule, "revision": revision}
	}

	for revisionID, baseRule := range currentRuleByRevision {
		resultRule := resultRuleByRevision[revisionID]
		if resultRule == nil {
			return nil, false, 0, fmt.Errorf("registry_result removed existing rule revision %s", revisionID)
		}
		if err := validateExistingRuleInvariant(baseRule, resultRule); err != nil {
			return nil, false, 0, fmt.Errorf("registry_result changed unaudited revision %s: %w", revisionID, err)
		}
	}
	for revisionID := range currentRevisionByID {
		if resultRevisionByID[revisionID] == nil {
			return nil, false, 0, fmt.Errorf("registry_result removed existing revision history %s", revisionID)
		}
	}
	for revisionID := range resultRuleByRevision {
		if currentRuleByRevision[revisionID] == nil && auditedRevisions[revisionID] == nil {
			return nil, false, 0, fmt.Errorf("registry_result contains unaudited new rule revision %s", revisionID)
		}
	}
	for revisionID := range resultRevisionByID {
		if currentRevisionByID[revisionID] == nil && auditedRevisions[revisionID] == nil {
			return nil, false, 0, fmt.Errorf("registry_result contains unaudited revision history %s", revisionID)
		}
	}

	changed := false
	persistedRuleCount := 0
	allowedApprovalRevisions := map[string]bool{}
	for revisionID, entry := range auditedRevisions {
		action := stringField(entry, "action")
		ruleID := stringField(entry, "rule_id")
		if action == "NEW_RULE" {
			for _, existing := range currentRules {
				if stringField(existing, "rule_id") == ruleID && stringField(existing, "revision_id") != revisionID {
					return nil, false, 0, fmt.Errorf("NEW_RULE conflicts with existing rule_id %s", ruleID)
				}
			}
		} else {
			foundCurrent := false
			for index, existing := range currentRules {
				if stringField(existing, "rule_id") != ruleID || !boolFieldDefault(existing, "is_current", true) {
					continue
				}
				foundCurrent = true
				if stringField(existing, "revision_id") != revisionID {
					updated, cloneErr := cloneJSONObject(existing)
					if cloneErr != nil {
						return nil, false, 0, cloneErr
					}
					updated["is_current"] = false
					updated["enabled"] = false
					updated["status"] = "INACTIVE"
					currentRules[index] = updated
					changed = true
				}
			}
			if !foundCurrent {
				return nil, false, 0, fmt.Errorf("NEW_REVISION has no current rule %s", ruleID)
			}
		}
		if currentRuleByRevision[revisionID] == nil {
			currentRules = append(currentRules, entry["rule"].(map[string]any))
			changed = true
			persistedRuleCount++
		}
		if currentRevisionByID[revisionID] == nil {
			currentRevisions = append(currentRevisions, entry["revision"].(map[string]any))
			changed = true
		}
		allowedApprovalRevisions[revisionID] = true
	}
	next["rules"] = mapsToAny(currentRules)
	next["revisions"] = mapsToAny(currentRevisions)

	currentApplications, _ := objectSlice(next, "applications")
	resultApplications, _ := objectSlice(result, "applications")
	currentApplications, applicationsChanged, err := mergeRunScopedObjects(currentApplications, resultApplications, "application_id", runID)
	if err != nil {
		return nil, false, 0, fmt.Errorf("merge rule applications: %w", err)
	}
	changed = changed || applicationsChanged
	for _, application := range resultApplications {
		if stringField(application, "run_id") == runID {
			if revisionID := stringField(application, "revision_id"); revisionID != "" {
				allowedApprovalRevisions[revisionID] = true
			}
		}
	}
	next["applications"] = mapsToAny(currentApplications)

	currentApprovals, _ := objectSlice(next, "approvals")
	resultApprovals, _ := objectSlice(result, "approvals")
	seenApprovals := map[string]bool{}
	for _, approval := range resultApprovals {
		approvalID := stringField(approval, "approval_id")
		revisionID := stringField(approval, "revision_id")
		if approvalID == "" || !allowedApprovalRevisions[revisionID] {
			continue
		}
		if seenApprovals[approvalID] {
			return nil, false, 0, fmt.Errorf("duplicate approval_id %s", approvalID)
		}
		seenApprovals[approvalID] = true
		var approvalChanged bool
		currentApprovals, approvalChanged, err = upsertObjectByID(currentApprovals, approval, "approval_id", "")
		if err != nil {
			return nil, false, 0, fmt.Errorf("merge rule approval: %w", err)
		}
		changed = changed || approvalChanged
	}
	next["approvals"] = mapsToAny(currentApprovals)

	currentEvidence, _ := objectSlice(next, "evidence")
	resultEvidence, _ := objectSlice(result, "evidence")
	currentEvidence, evidenceChanged, err := mergeRunScopedObjects(currentEvidence, resultEvidence, "evidence_id", runID)
	if err != nil {
		return nil, false, 0, fmt.Errorf("merge rule evidence: %w", err)
	}
	changed = changed || evidenceChanged
	next["evidence"] = mapsToAny(currentEvidence)

	if changed {
		next["updated_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	}
	return next, changed, persistedRuleCount, nil
}

func mergeRunScopedObjects(current, result []map[string]any, idKey, runID string) ([]map[string]any, bool, error) {
	changed := false
	seen := map[string]bool{}
	for _, item := range result {
		if stringField(item, "run_id") != runID {
			continue
		}
		id := stringField(item, idKey)
		if id == "" || seen[id] {
			return nil, false, fmt.Errorf("invalid or duplicate %s", idKey)
		}
		seen[id] = true
		var itemChanged bool
		var err error
		current, itemChanged, err = upsertObjectByID(current, item, idKey, runID)
		if err != nil {
			return nil, false, err
		}
		changed = changed || itemChanged
	}
	return current, changed, nil
}

func upsertObjectByID(current []map[string]any, item map[string]any, idKey, requiredRunID string) ([]map[string]any, bool, error) {
	id := stringField(item, idKey)
	for index, existing := range current {
		if stringField(existing, idKey) != id {
			continue
		}
		if requiredRunID != "" && stringField(existing, "run_id") != requiredRunID {
			return nil, false, fmt.Errorf("%s %s belongs to another run", idKey, id)
		}
		if reflect.DeepEqual(existing, item) {
			return current, false, nil
		}
		current[index] = item
		return current, true, nil
	}
	return append(current, item), true, nil
}

func validateExistingRuleInvariant(base, result map[string]any) error {
	for _, key := range []string{"rule_id", "revision_id", "origin_rule_id", "content_hash"} {
		if baseValue, exists := base[key]; exists && !reflect.DeepEqual(baseValue, result[key]) {
			return fmt.Errorf("field %s changed", key)
		}
	}
	return nil
}

func sameCleanPath(left, right string) bool {
	left, leftErr := filepath.Abs(left)
	right, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func containsForbiddenRuleAmount(value any) bool {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			if strings.EqualFold(key, "amount") || strings.EqualFold(key, "amounts") || containsForbiddenRuleAmount(child) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if containsForbiddenRuleAmount(child) {
				return true
			}
		}
	}
	return false
}

func readRulesRegistry(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return decodeRulesRegistry(data)
}

func decodeRulesRegistry(data []byte) (map[string]any, error) {
	var value map[string]any
	if err := decodeStrictJSON(data, &value); err != nil {
		return nil, err
	}
	if err := validateRulesRegistry(value); err != nil {
		return nil, err
	}
	return value, nil
}

func validateRulesRegistry(value map[string]any) error {
	if value == nil || stringField(value, "schema_version") != rulesRegistrySchema {
		return fmt.Errorf("expected %s", rulesRegistrySchema)
	}
	for _, key := range []string{"rules", "revisions", "applications", "approvals", "evidence"} {
		if _, err := objectSlice(value, key); err != nil {
			return err
		}
	}
	for _, contract := range []struct {
		array      string
		uniqueKey  string
		requiredID []string
	}{
		{array: "rules", uniqueKey: "revision_id", requiredID: []string{"rule_id", "revision_id"}},
		{array: "revisions", uniqueKey: "revision_id", requiredID: []string{"rule_id", "revision_id"}},
		{array: "applications", uniqueKey: "application_id", requiredID: []string{"application_id"}},
		{array: "approvals", uniqueKey: "approval_id", requiredID: []string{"approval_id"}},
		{array: "evidence", uniqueKey: "evidence_id", requiredID: []string{"evidence_id"}},
	} {
		items, _ := objectSlice(value, contract.array)
		seen := map[string]bool{}
		for _, item := range items {
			for _, key := range contract.requiredID {
				if stringField(item, key) == "" {
					return fmt.Errorf("registry field %s contains an object without %s", contract.array, key)
				}
			}
			identity := stringField(item, contract.uniqueKey)
			if seen[identity] {
				return fmt.Errorf("registry field %s contains duplicate %s %s", contract.array, contract.uniqueKey, identity)
			}
			seen[identity] = true
		}
	}
	return nil
}

func objectSlice(value map[string]any, key string) ([]map[string]any, error) {
	raw, exists := value[key]
	if !exists {
		return nil, fmt.Errorf("registry field %s is missing", key)
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("registry field %s is not an array", key)
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("registry field %s contains a non-object", key)
		}
		result = append(result, object)
	}
	return result, nil
}

func indexObjects(items []map[string]any, key string) (map[string]map[string]any, error) {
	result := make(map[string]map[string]any, len(items))
	for _, item := range items {
		id := stringField(item, key)
		if id == "" {
			return nil, fmt.Errorf("missing %s", key)
		}
		if _, duplicate := result[id]; duplicate {
			return nil, fmt.Errorf("duplicate %s %s", key, id)
		}
		result[id] = item
	}
	return result, nil
}

func cloneJSONObject(value map[string]any) (map[string]any, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var cloned map[string]any
	if err := decodeStrictJSON(data, &cloned); err != nil {
		return nil, err
	}
	return cloned, nil
}

func mapsToAny(items []map[string]any) []any {
	result := make([]any, len(items))
	for index, item := range items {
		result[index] = item
	}
	return result
}

func stringField(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return strings.TrimSpace(text)
}

func boolFieldDefault(value map[string]any, key string, fallback bool) bool {
	result, ok := value[key].(bool)
	if !ok {
		return fallback
	}
	return result
}

func intField(value map[string]any, key string) (int, bool) {
	number, ok := value[key].(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Int64()
	if err != nil || parsed < 0 || parsed > int64(^uint(0)>>1) {
		return 0, false
	}
	return int(parsed), true
}

func readStrictJSONFile(path string, destination any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return decodeStrictJSON(data, destination)
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("multiple JSON values are forbidden")
	}
	return nil
}

func atomicWritePrivateFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".tmp-rules-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporaryName, 0o600); err != nil {
		return err
	}
	return replacePrivateFile(temporaryName, path)
}

func atomicWritePrivateJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWritePrivateFile(path, data)
}

func writeImmutablePrivateFile(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
		return errors.New("immutable rules snapshot already exists with different content")
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".tmp-rules-snapshot-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temporaryName, 0o600); err != nil {
		return err
	}
	if err := os.Link(temporaryName, path); err != nil {
		if existing, readErr := os.ReadFile(path); readErr == nil {
			if bytes.Equal(existing, data) {
				return nil
			}
			return errors.New("immutable rules snapshot already exists with different content")
		}
		return err
	}
	return nil
}

func sha256Bytes(data []byte) string {
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:]))
}
