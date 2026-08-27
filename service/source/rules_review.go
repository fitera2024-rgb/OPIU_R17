package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var allowedRuleReviewDecisions = map[string]struct{}{
	"CONFIRMED":         {},
	"REJECTED":          {},
	"MANUAL_REVIEW":     {},
	"ACCEPT_DIFFERENCE": {},
	"LINK_TO_EXISTING":  {},
	"CREATE_REVISION":   {},
}

type ruleReviewCandidateDocument struct {
	SchemaVersion string           `json:"schema_version"`
	RunID         string           `json:"run_id"`
	Candidates    []map[string]any `json:"candidates"`
}

type ruleReviewWorkflowDocument struct {
	NextAction          string         `json:"next_action"`
	Reasons             []string       `json:"reasons"`
	RequiredUserActions []string       `json:"required_user_actions"`
	State               map[string]any `json:"state"`
}

type ruleReviewDecision struct {
	CandidateID       string         `json:"candidate_id"`
	CandidateRevision string         `json:"candidate_revision_id,omitempty"`
	Decision          string         `json:"decision"`
	Comment           string         `json:"comment,omitempty"`
	ExistingRuleID    string         `json:"existing_rule_id,omitempty"`
	EditedRule        map[string]any `json:"edited_rule,omitempty"`
	DecidedAt         string         `json:"decided_at,omitempty"`
}

type ruleReviewDecisionRequest struct {
	Author    string               `json:"author,omitempty"`
	Decisions []ruleReviewDecision `json:"decisions"`
}

type ruleReviewDecisionDocument struct {
	SchemaVersion            string                 `json:"schema_version"`
	RunID                    string                 `json:"run_id"`
	Author                   string                 `json:"author"`
	Decisions                []ruleReviewDecision   `json:"decisions"`
	SourceCandidatesSHA256   string                 `json:"service_source_candidates_sha256"`
	ServiceCandidateBindings []rulesDecisionBinding `json:"service_candidate_bindings"`
}

type ruleReviewPublicResult struct {
	Stage                  string           `json:"stage"`
	Ready                  bool             `json:"ready"`
	RunID                  string           `json:"run_id"`
	RunStatus              RunStatus        `json:"run_status"`
	NextAction             string           `json:"next_action"`
	Reasons                []string         `json:"reasons"`
	RequiredUserActions    []string         `json:"required_user_actions"`
	Candidates             []map[string]any `json:"candidates"`
	CandidateCount         int              `json:"candidate_count"`
	PendingReviewCount     int              `json:"pending_review_count"`
	RegistryPersisted      bool             `json:"registry_persisted"`
	RegistryPersistedCount int              `json:"registry_persisted_count"`
	DecisionOptions        []string         `json:"decision_options"`
	Safety                 SafetyState      `json:"safety"`
}

func (s *Server) handleRulesReviewResult(w http.ResponseWriter, r *http.Request, runID string) {
	run, ok := s.store.Run(runID)
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "Запуск не найден"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		result, err := s.readRulesReviewResult(run)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSON(w, http.StatusOK, ruleReviewPublicResult{Stage: "RULES", Ready: false, RunID: runID, RunStatus: run.Status, Candidates: []map[string]any{}, DecisionOptions: ruleReviewDecisionOptions(), Safety: reportOnlySafety()})
				return
			}
			writeJSON(w, http.StatusInternalServerError, apiError{Error: "Не удалось прочитать предложения правил"})
			return
		}
		writeJSON(w, http.StatusOK, result)
	case http.MethodPost:
		if run.Status != RunWaitingUserRules {
			writeJSON(w, http.StatusConflict, apiError{Error: "Запуск не ожидает решений по правилам"})
			return
		}
		var request ruleReviewDecisionRequest
		if err := readJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "Проверьте выбранные решения по правилам"})
			return
		}
		decisionsPath, err := s.persistRuleReviewDecisions(run, request)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
			return
		}
		if err := s.pipeline.ResumeAfterRuleDecisions(run.ID, decisionsPath); err != nil {
			writeJSON(w, http.StatusConflict, apiError{Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"ok":      true,
			"run_id":  run.ID,
			"status":  RunRunning,
			"stage":   "RULES_REVIEW",
			"message": "Решения приняты; сервис продолжает отчётный маршрут",
			"safety":  reportOnlySafety(),
		})
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func ruleReviewDecisionOptions() []string {
	return []string{"MANUAL_REVIEW", "ACCEPT_DIFFERENCE", "REJECTED", "CONFIRMED"}
}

func (s *Server) readRulesReviewResult(run Run) (ruleReviewPublicResult, error) {
	runDir := filepath.Join(s.store.RunsDir(), run.ID)
	rulesDir, err := latestRulesReviewDir(runDir)
	if err != nil {
		return ruleReviewPublicResult{}, err
	}
	var candidatesDoc ruleReviewCandidateDocument
	if err := readJSONFile(filepath.Join(rulesDir, "rule_candidates.json"), &candidatesDoc); err != nil {
		return ruleReviewPublicResult{}, err
	}
	var workflow ruleReviewWorkflowDocument
	if err := readJSONFile(filepath.Join(rulesDir, "workflow_decision.json"), &workflow); err != nil {
		return ruleReviewPublicResult{}, err
	}
	candidates := make([]map[string]any, 0, len(candidatesDoc.Candidates))
	pending := 0
	for _, candidate := range candidatesDoc.Candidates {
		sanitized, _ := sanitizeRuleReviewValue(candidate).(map[string]any)
		candidates = append(candidates, sanitized)
		status := strings.ToUpper(strings.TrimSpace(fmt.Sprint(candidate["user_status"])))
		if status == "PENDING_REVIEW" || status == "MANUAL_REVIEW" || status == "" {
			pending++
		}
	}
	persistence := readRulesPersistenceReceipt(s.store.RunsDir(), run.ID)
	if s.pipeline != nil && s.pipeline.rulesRegistry != nil {
		persistence = s.pipeline.rulesRegistry.persistenceReceipt(run.ID)
	}
	return ruleReviewPublicResult{
		Stage:                  "RULES",
		Ready:                  true,
		RunID:                  run.ID,
		RunStatus:              run.Status,
		NextAction:             workflow.NextAction,
		Reasons:                workflow.Reasons,
		RequiredUserActions:    workflow.RequiredUserActions,
		Candidates:             candidates,
		CandidateCount:         len(candidates),
		PendingReviewCount:     pending,
		RegistryPersisted:      persistence.RegistryPersisted,
		RegistryPersistedCount: persistence.RegistryPersistedCount,
		DecisionOptions:        ruleReviewDecisionOptions(),
		Safety:                 reportOnlySafety(),
	}, nil
}

func sanitizeRuleReviewValue(value any) any {
	switch current := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(current))
		for key, child := range current {
			switch key {
			case "source_file", "source_sha256", "source_payload_hash", "report_sha256", "codex_input_sha256", "stdout_log", "stderr_log", "technical_error":
				continue
			default:
				out[key] = sanitizeRuleReviewValue(child)
			}
		}
		return out
	case []any:
		out := make([]any, 0, len(current))
		for _, child := range current {
			out = append(out, sanitizeRuleReviewValue(child))
		}
		return out
	default:
		return value
	}
}

func latestRulesReviewDir(runDir string) (string, error) {
	for _, name := range []string{"rules-after-user", "rules"} {
		dir := filepath.Join(runDir, name)
		if regularFile(filepath.Join(dir, "rule_candidates.json")) && regularFile(filepath.Join(dir, "workflow_decision.json")) {
			return dir, nil
		}
	}
	return "", os.ErrNotExist
}

func readJSONFile(path string, dst any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dst)
}

func (s *Server) persistRuleReviewDecisions(run Run, request ruleReviewDecisionRequest) (string, error) {
	rulesDir, err := latestRulesReviewDir(filepath.Join(s.store.RunsDir(), run.ID))
	if err != nil {
		return "", errors.New("Предложения правил ещё не готовы")
	}
	var candidatesDoc ruleReviewCandidateDocument
	candidatesPath := filepath.Join(rulesDir, "rule_candidates.json")
	if err := readStrictJSONFile(candidatesPath, &candidatesDoc); err != nil || candidatesDoc.SchemaVersion != "opiu-rule-candidates.v1" || candidatesDoc.RunID != run.ID {
		return "", errors.New("Предложения правил ещё не готовы")
	}
	if len(request.Decisions) == 0 {
		return "", errors.New("Выберите хотя бы одно решение")
	}
	known := make(map[string]map[string]any, len(candidatesDoc.Candidates))
	for _, candidate := range candidatesDoc.Candidates {
		id := strings.TrimSpace(fmt.Sprint(candidate["candidate_id"]))
		if id != "" {
			known[id] = candidate
		}
	}
	seen := map[string]struct{}{}
	decisions := make([]ruleReviewDecision, 0, len(request.Decisions))
	for _, item := range request.Decisions {
		item.CandidateID = cleanBusinessText(item.CandidateID, 240)
		item.CandidateRevision = cleanBusinessText(item.CandidateRevision, 240)
		item.Decision = strings.ToUpper(cleanBusinessText(item.Decision, 40))
		item.Comment = cleanBusinessText(item.Comment, 1000)
		item.ExistingRuleID = cleanBusinessText(item.ExistingRuleID, 240)
		if _, ok := known[item.CandidateID]; !ok || item.CandidateID == "" {
			return "", fmt.Errorf("Неизвестный кандидат правила: %s", item.CandidateID)
		}
		if _, duplicate := seen[item.CandidateID]; duplicate {
			return "", fmt.Errorf("Решение по кандидату %s передано дважды", item.CandidateID)
		}
		seen[item.CandidateID] = struct{}{}
		if _, ok := allowedRuleReviewDecisions[item.Decision]; !ok {
			return "", fmt.Errorf("Неподдерживаемое решение: %s", item.Decision)
		}
		if (item.Decision == "LINK_TO_EXISTING" || item.Decision == "CREATE_REVISION") && item.ExistingRuleID == "" {
			return "", fmt.Errorf("Решение %s требует существующее правило", item.Decision)
		}
		if item.DecidedAt == "" {
			item.DecidedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		decisions = append(decisions, item)
	}
	author := cleanBusinessText(request.Author, 200)
	if author == "" {
		author = "Пользователь"
	}
	candidatesHash, err := sha256File(candidatesPath)
	if err != nil {
		return "", errors.New("Не удалось связать решения по правилам")
	}
	bindings := make([]rulesDecisionBinding, 0, len(decisions))
	for _, decision := range decisions {
		candidate := known[decision.CandidateID]
		action, _ := candidate["action"].(map[string]any)
		bindings = append(bindings, rulesDecisionBinding{
			CandidateID:       decision.CandidateID,
			Decision:          decision.Decision,
			CandidateDecision: strings.ToUpper(strings.TrimSpace(fmt.Sprint(candidate["decision"]))),
			ImpactClass:       strings.ToUpper(strings.TrimSpace(fmt.Sprint(candidate["impact_class"]))),
			ActionType:        strings.ToUpper(strings.TrimSpace(fmt.Sprint(action["action_type"]))),
		})
	}
	doc := ruleReviewDecisionDocument{
		SchemaVersion:            "opiu-user-rule-decisions.v1",
		RunID:                    run.ID,
		Author:                   author,
		Decisions:                decisions,
		SourceCandidatesSHA256:   candidatesHash,
		ServiceCandidateBindings: bindings,
	}
	path := filepath.Join(s.store.RunsDir(), run.ID, "rules-review", "user_rule_decisions.json")
	if err := atomicWritePrivateJSON(path, doc); err != nil {
		return "", errors.New("Не удалось сохранить решения по правилам")
	}
	return path, nil
}

func (p *Pipeline) ResumeAfterRuleDecisions(runID, decisionsPath string) error {
	return errors.New("Rules resume отключён: production использует прямую неизменяемую передачу R005→R001")
	/* Legacy implementation retained unreachable for first-stage cleanup.
	if p.runtime == nil {
		return errors.New("Продолжение после правил доступно только во встроенном runtime")
	}
	if !regularFile(decisionsPath) {
		return errors.New("Файл решений по правилам не найден")
	}
	run, ok := p.store.Run(runID)
	if !ok {
		return errors.New("Запуск не найден")
	}
	if run.Status != RunWaitingUserRules {
		return errors.New("Запуск не ожидает решений по правилам")
	}
	contextValue, ok := p.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		return errors.New("Контекст недоступен или архивирован")
	}
	if err := p.anchorStructuralControlInventory(run, contextValue, filepath.Join(p.store.RunsDir(), run.ID, "r005")); err != nil {
		return errors.New("Проверенный состав верхних блоков R005 изменился; продолжение остановлено")
	}
	p.mu.Lock()
	if _, exists := p.active[runID]; exists {
		p.mu.Unlock()
		return errors.New("Запуск уже выполняется")
	}
	p.active[runID] = struct{}{}
	p.mu.Unlock()

	run.Status = RunRunning
	run.Stage = "RULES_REVIEW"
	run.Message = "Применяются решения пользователя по предложениям правил"
	run.FinishedAt = nil
	if err := p.store.UpdateRun(run); err != nil {
		p.mu.Lock()
		delete(p.active, runID)
		p.mu.Unlock()
		return err
	}
	go func() {
		defer func() {
			p.mu.Lock()
			delete(p.active, runID)
			p.mu.Unlock()
		}()
		p.executeAfterRuleDecisions(run, decisionsPath)
	}()
	return nil */
}

func (p *Pipeline) executeAfterRuleDecisions(run Run, decisionsPath string) {
	finish := func(status RunStatus, stage, message string) {
		now := time.Now().UTC()
		run.Status = status
		run.Stage = stage
		run.Message = message
		run.FinishedAt = &now
		_ = p.store.UpdateRun(run)
	}
	contextValue, ok := p.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		finish(RunBlockedInvalidContext, "RULES_REVIEW", "Контекст недоступен или архивирован")
		return
	}
	adapter := p.runtime
	rulesRegistry := p.rulesRegistry
	if rulesRegistry == nil {
		var registryErr error
		rulesRegistry, registryErr = newPersistentRulesRegistry(p.store, adapter.RulesRegistry)
		if registryErr != nil {
			finish(RunFailed, "RULES_REVIEW", "Постоянный реестр правил недоступен или повреждён")
			return
		}
		p.rulesRegistry = rulesRegistry
	}
	runDir := filepath.Join(p.store.RunsDir(), run.ID)
	r005Dir := filepath.Join(runDir, "r005")
	handoffDir := filepath.Join(runDir, "handoff")
	r001Dir := filepath.Join(runDir, "r001")
	if err := p.anchorStructuralControlInventory(run, contextValue, r005Dir); err != nil {
		finish(RunBlockedStructuralInventory, "R005_INVENTORY", "Проверенный состав верхних блоков R005 изменился; правила не запускались")
		return
	}
	r005Codex := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	structuralControlProofPath := filepath.Join(r005Dir, structuralControlProofFilename)
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, r005Codex, structuralControlProofPath); err != nil {
		finish(RunFailed, "R005_PROOF", "Доказательство настройки группировки блоков изменилось до повторной проверки Rules")
		return
	}
	r005CodexSHA, err := sha256File(r005Codex)
	if err != nil {
		finish(RunFailed, "R005_PROOF", "Не удалось проверить codex-input перед повторной проверкой Rules")
		return
	}
	structuralControlProofSHA, err := sha256File(structuralControlProofPath)
	if err != nil {
		finish(RunFailed, "R005_PROOF", "Не удалось проверить доказательство перед повторной проверкой Rules")
		return
	}
	previousRulesDir, err := latestRulesReviewDir(runDir)
	if err != nil {
		finish(RunFailed, "RULES_REVIEW", "Предыдущий результат движка правил не найден")
		return
	}
	var previousWorkflow ruleReviewWorkflowDocument
	_ = readJSONFile(filepath.Join(previousRulesDir, "workflow_decision.json"), &previousWorkflow)
	nextRulesDir := filepath.Join(runDir, "rules-after-user")
	if err := os.RemoveAll(nextRulesDir); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Не удалось подготовить повторную проверку правил")
		return
	}
	if err := os.MkdirAll(nextRulesDir, 0o700); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Не удалось подготовить повторную проверку правил")
		return
	}
	contextPath := filepath.Join(runDir, "rules_engine_context_after_user.json")
	rulesRegistrySnapshot, rulesRegistryBaseHash, err := rulesRegistry.snapshot(run.ID, "after-user")
	if err != nil {
		finish(RunFailed, "RULES_REVIEW", "Не удалось подготовить проверенный снимок реестра правил")
		return
	}
	contextDoc := map[string]any{
		"schema_version": "opiu-rules-engine-context.v1",
		"run_id":         run.ID,
		"phase":          "AFTER_USER_DECISIONS",
		"organization": map[string]any{
			"id":                  contextValue.OrganizationID,
			"name":                contextValue.OrganizationName,
			"path":                contextValue.OrganizationPath,
			"cfo":                 contextValue.CFO,
			"include_descendants": false,
		},
		"period": contextValue.Period,
		"paths": map[string]any{
			"rules_registry":           rulesRegistrySnapshot,
			"r005_report":              filepath.Join(r005Dir, "reconciliation.xlsx"),
			"r005_codex_input":         r005Codex,
			"structural_control_proof": structuralControlProofPath,
			"user_decisions":           decisionsPath,
			"output_dir":               nextRulesDir,
			"handoff_root":             handoffDir,
		},
		"source_hashes": map[string]string{
			"r005_codex_input":         strings.ToUpper(r005CodexSHA),
			"structural_control_proof": strings.ToUpper(structuralControlProofSHA),
		},
		"previous_state": previousWorkflow.State,
		"options": map[string]any{
			"require_user_confirmation": true,
			"auto_activate_rules":       false,
			"modify_source_files":       false,
		},
		"meta": map[string]any{
			"service_context_id": contextValue.ID,
			"report_only":        true,
		},
	}
	if err := atomicWriteJSON(contextPath, contextDoc); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Не удалось подготовить контекст решений по правилам")
		return
	}
	command := []string{adapter.Node, adapter.RulesScript, "run", "--context", contextPath, "--out", nextRulesDir}
	if err := p.runStage("RULES_REVIEW", command, nil, runDir, adapter.Root); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Повторная проверка правил завершилась ошибкой; детали сохранены в журнале")
		return
	}
	workflow, err := readValidatedRulesWorkflow(nextRulesDir, run.ID, "after-user")
	if err != nil {
		finish(RunFailed, "RULES_REVIEW", "Движок правил не создал обязательное решение workflow")
		return
	}
	if workflow.NextAction == "FAILED" || workflow.NextAction == "FAILED_NO_STATE_CHANGE" {
		finish(RunFailed, "RULES_REVIEW", "Workflow движка правил остановлен fail-closed")
		return
	}
	if _, err := rulesRegistry.mergeEngineOutput(run.ID, "after-user", nextRulesDir, rulesRegistryBaseHash); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Результат решений по правилам не прошёл безопасное сохранение в библиотеку")
		return
	}
	switch workflow.NextAction {
	case "WAIT_USER_RULES":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir,
			filepath.Join(r005Dir, "reconciliation.xlsx"), filepath.Join(r005Dir, "reconciliation.codex-input.json"), r001Dir,
			"RULES_REVIEW", "WAIT_USER_RULES", "Остались предложения правил после решения пользователя"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Остались предложения правил; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunWaitingUserRules, "RULES_REVIEW", "Остались предложения правил; сформирован безопасный диагностический комплект без проводок")
		return
	case "RERUN_R005":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir,
			filepath.Join(r005Dir, "reconciliation.xlsx"), filepath.Join(r005Dir, "reconciliation.codex-input.json"), r001Dir,
			"RULES_REVIEW", "RERUN_R005", "Подтверждённые правила требуют повторной сверки R005"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Требуется повторная сверка R005; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunWaitingUserRules, "RULES_REVIEW", "Подтверждённые правила требуют повторной сверки R005; диагностический комплект сформирован без проводок")
		return
	case "COMPLETE":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir,
			filepath.Join(r005Dir, "reconciliation.xlsx"), filepath.Join(r005Dir, "reconciliation.codex-input.json"), r001Dir,
			"RULES_REVIEW", "COMPLETE_NO_R001", "Корректировки R001 не требуются после решения пользователя"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Корректировки не требуются; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunCompletedReportOnly, "DONE", "Проверка правил завершена; сформирован нулевой диагностический комплект без проводок")
		return
	case "PASS_TO_R001", "RERUN_R001":
		// Continue below only with a verified handoff created by the rules engine.
	default:
		finish(RunFailed, "RULES_REVIEW", "Движок правил вернул неподдерживаемое действие")
		return
	}
	handoffPath := strings.TrimSpace(workflow.Handoff.HandoffPath)
	if workflow.Handoff.Target != "R001" || handoffPath == "" || !regularFile(handoffPath) {
		finish(RunFailed, "RULES_REVIEW", "Передача в R001 не подтверждена обязательным handoff-файлом")
		return
	}
	if err := verifyStructuralControlProofHandoff(handoffPath, run, contextValue, r005Codex, structuralControlProofPath); err != nil {
		finish(RunFailed, "RULES_REVIEW", "Rules передал в R001 другое доказательство настройки группировки блоков")
		return
	}
	if err := resetR001OutputDirectory(runDir, r001Dir); err != nil {
		finish(RunFailed, "R001", "Не удалось подготовить рабочую папку R001")
		return
	}
	run.Status = RunRunning
	run.Stage = "R001"
	run.Message = stageMessage("R001")
	run.FinishedAt = nil
	if err := p.store.UpdateRun(run); err != nil {
		return
	}
	r001Command := []string{
		adapter.Node,
		adapter.R001Script,
		"--handoff", handoffPath,
		"--output", r001Dir,
		"--period", contextValue.Period,
		"--organization", contextValue.Organization,
		"--run-id", run.ID,
		"--organization-id", contextValue.OrganizationID,
	}
	r001Command = appendStructuralControlProofArgument(r001Command, structuralControlProofPath)
	r001Err := p.runStage("R001", r001Command, nil, runDir, adapter.Root)
	if packageErr := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); packageErr != nil {
		finish(RunFailed, "R001", "R001 не сформировал полный безопасный диагностический комплект")
		return
	}
	blockerStatus := "PASS_R001"
	blockerMessage := "R001 сформировал безопасный отчётный комплект после решения пользователя"
	if r001Err != nil {
		blockerStatus = "R001_NONZERO_UNCLASSIFIED"
		blockerMessage = "R001 вернул ненулевой exit без распознанного бизнес-кода; комплект сохранён только для диагностики"
	}
	if err := materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, "R001", blockerStatus, blockerMessage); err != nil {
		finish(RunFailed, "R001", "R001 сформировал внутренние файлы, но видимые журнал и диагностика недоступны")
		return
	}
	if r001Err != nil {
		finish(RunFailed, "R001", "R001 вернул ненулевой exit без распознанного бизнес-блокера; диагностический комплект доступен, запись в 1С не выполнялась")
		return
	}
	finish(RunCompletedReportOnly, "DONE", "Решения по правилам и диагностический комплект R001 завершены; запись в 1С не выполнялась")
}
