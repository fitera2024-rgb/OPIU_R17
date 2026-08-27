package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Rules Engine is a server-side stage between R005 and R001. It never changes
// the green web UI or the financial algorithms of either engine.

func (a *App) handleRulesEnginePrepare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	result, err := a.prepareRulesEngine(body)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_PREPARE_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": safeID(asString(body["run_id"]))})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_PREPARE_FAILED", "Не удалось безопасно подготовить движок правил. Обновите страницу и повторите.")
		return
	}
	writeJSON(w, http.StatusCreated, rulesEnginePublicPrepareV194(result))
}

func (a *App) prepareRulesEngine(body map[string]any) (map[string]any, error) {
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	runID := safeID(defaultString(asString(body["run_id"]), asString(settings["active_run_id"])))
	if runID == "" {
		return nil, errors.New("run_id не определён")
	}
	// Validate exact pre-RUN pins before even the automatic R005 artifact
	// collection can mutate service indexes. Historical runs without the new
	// proof field retain their existing compatibility path.
	sourceRun, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		return nil, err
	}
	var carriedPreRunProof map[string]any
	if runRequiresPreRunProofV194(sourceRun) {
		carriedPreRunProof, err = validateStoredPreRunProofV194(sourceRun)
		if err != nil {
			return nil, err
		}
	}
	// R005 writes its report and companion directly into the run output folder.
	// Collect them here as well as during bootstrap so the next stage can be
	// started immediately without an extra manual "Забрать результаты" click.
	if _, err := a.collectRunArtifactsV041(runID); err != nil {
		return nil, fmt.Errorf("не удалось зарегистрировать результаты R005: %w", err)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	run, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		return nil, err
	}
	if carriedPreRunProof != nil {
		carriedPreRunProof, err = validateStoredPreRunProofV194(run)
		if err != nil {
			return nil, err
		}
	}
	phase := defaultString(asString(body["phase"]), "AFTER_R005")
	if phase != "AFTER_R005" && phase != "AFTER_USER_DECISIONS" && phase != "AFTER_R001" {
		return nil, fmt.Errorf("неподдерживаемая фаза Rules Engine: %s", phase)
	}
	reportArtifact := a.rulesEngineLatestArtifactRecord(runID, "RECONCILIATION_REPORT", "R005")
	sidecarArtifact := a.rulesEngineLatestArtifactRecord(runID, "EVIDENCE_JSON", "R005")
	if reportArtifact == nil && sidecarArtifact == nil {
		return nil, errors.New("R005 ещё не выполнен: отчёт сверки и companion .codex-input.json не найдены в текущем запуске")
	}
	if reportArtifact == nil {
		return nil, errors.New("companion R005 найден, но отчёт сверки .xlsx отсутствует в текущем запуске")
	}
	if sidecarArtifact == nil {
		return nil, errors.New("отчёт R005 найден, но companion .codex-input.json отсутствует в текущем запуске")
	}
	reportPath, reportHash, err := a.rulesEngineVerifiedArtifact(reportArtifact)
	if err != nil {
		return nil, err
	}
	sidecarPath, sidecarHash, err := a.rulesEngineVerifiedArtifact(sidecarArtifact)
	if err != nil {
		return nil, err
	}
	r001FeedbackPath, r001FeedbackHash := "", ""
	if phase == "AFTER_R001" {
		feedbackArtifact := a.rulesEngineLatestArtifactRecord(runID, "RULE_FEEDBACK", "R001")
		if feedbackArtifact == nil {
			return nil, errors.New("для AFTER_R001 не зарегистрирован rule_feedback.json R001")
		}
		r001FeedbackPath, r001FeedbackHash, err = a.rulesEngineVerifiedArtifact(feedbackArtifact)
		if err != nil {
			return nil, err
		}
	}

	executionID := safeID("RULES-" + time.Now().UTC().Format("20060102T150405.000000000") + "-" + lastN(newID(""), 6))
	runDir := filepath.Join(a.DataRoot, "runs", runID)
	inputDir := filepath.Join(runDir, "rules-input", executionID)
	outputDir := filepath.Join(runDir, "rules-output", executionID)
	handoffDir := filepath.Join(runDir, "handoff", executionID)
	contextDir := filepath.Join(runDir, "context")
	for _, dir := range []string{inputDir, outputDir, handoffDir, contextDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, err
		}
	}

	registrySource := filepath.Join(a.RulesDir, "rules.json")
	registrySource, err = a.rulesEngineDataFile(registrySource)
	if err != nil {
		return nil, err
	}
	currentRulesPath := filepath.Join(inputDir, "current_rules.json")
	if err := copyFileAtomicRulesEngine(registrySource, currentRulesPath); err != nil {
		return nil, err
	}
	registryHash, err := fileSHA256V041(currentRulesPath)
	if err != nil {
		return nil, err
	}

	decisionsPath := filepath.Join(contextDir, "user_rule_decisions.json")
	decisionsHash := ""
	if fileExists(decisionsPath) {
		decisionsPath, err = a.rulesEngineDataFile(decisionsPath)
		if err != nil {
			return nil, err
		}
		decisionsHash, _ = fileSHA256V041(decisionsPath)
	} else {
		decisionsPath = ""
	}
	sourcesManifestPath := filepath.Join(contextDir, "sources_manifest.json")
	sourcesManifestHash := ""
	if fileExists(sourcesManifestPath) {
		sourcesManifestPath, err = a.rulesEngineDataFile(sourcesManifestPath)
		if err != nil {
			return nil, err
		}
		sourcesManifestHash, _ = fileSHA256V041(sourcesManifestPath)
	}
	r005SourcesPath := filepath.Join(inputDir, "r005_sources.json")
	r005Sources := map[string]any{
		"schema_version":   "opiu-r005-registered-sources.v1",
		"run_id":           runID,
		"report":           map[string]any{"artifact_id": reportArtifact["artifact_id"], "path": reportPath, "sha256": reportHash},
		"codex_input":      map[string]any{"artifact_id": sidecarArtifact["artifact_id"], "path": sidecarPath, "sha256": sidecarHash},
		"sources_manifest": map[string]any{"path": sourcesManifestPath, "sha256": sourcesManifestHash},
		"created_at":       nowISO(),
	}
	if carriedPreRunProof != nil {
		r005Sources["pre_run_source_proof"] = cloneMap(carriedPreRunProof)
	}
	if err := writeJSONAtomic(r005SourcesPath, r005Sources); err != nil {
		return nil, err
	}
	r005SourcesHash, _ := fileSHA256V041(r005SourcesPath)

	iteration := int(asFloat(run["iteration_number"]))
	if iteration < 1 {
		iteration = 1
	}
	previousState, _ := run["rules_state_snapshot"].(map[string]any)
	contextDoc := map[string]any{
		"schema_version":     "opiu-rules-engine-context.v1",
		"run_id":             runID,
		"parent_run_id":      run["parent_run_id"],
		"rules_execution_id": executionID,
		"phase":              phase,
		"iteration_number":   iteration,
		"organization": map[string]any{
			"id":                  run["organization_id"],
			"name":                run["organization_name"],
			"path":                run["organization_path"],
			"include_descendants": settings["include_descendants"],
		},
		"period": defaultString(asString(run["period"]), asString(settings["period"])),
		"paths": map[string]any{
			"rules_registry":   currentRulesPath,
			"r005_report":      reportPath,
			"r005_codex_input": sidecarPath,
			"r001_feedback":    r001FeedbackPath,
			"user_decisions":   decisionsPath,
			"output_dir":       outputDir,
			"handoff_root":     handoffDir,
		},
		"source_hashes": map[string]any{
			"rules_registry":   registryHash,
			"r005_report":      reportHash,
			"r005_codex_input": sidecarHash,
			"r001_feedback":    r001FeedbackHash,
			"user_decisions":   decisionsHash,
			"sources_manifest": sourcesManifestHash,
			"r005_sources":     r005SourcesHash,
		},
		"previous_state": previousState,
		"options": map[string]any{
			"require_user_confirmation": true,
			"auto_activate_rules":       false,
			"modify_source_files":       false,
		},
		"created_at": nowISO(),
	}
	if carriedPreRunProof != nil {
		contextDoc["pre_run_source_proof"] = cloneMap(carriedPreRunProof)
	}
	contextPath := filepath.Join(inputDir, "rules_engine_context.json")
	if err := writeJSONAtomic(contextPath, contextDoc); err != nil {
		return nil, err
	}
	run["rules_execution_id"] = executionID
	run["rules_engine_context_path"] = contextPath
	run["rules_input_dir"] = inputDir
	run["rules_output_dir"] = outputDir
	run["rules_handoff_dir"] = handoffDir
	run["stage"] = "RULES_ANALYSIS_PREPARED"
	run["updated_at"] = nowISO()
	if err := a.rulesEngineSaveRunRecord(runID, run); err != nil {
		return nil, err
	}
	settings["workflow_stage"] = "RULES_ANALYSIS_PREPARED"
	_ = writeJSONAtomic(filepath.Join(a.ConfigDir, "settings.json"), settings)
	result := map[string]any{"ok": true, "run_id": runID, "phase": phase, "rules_execution_id": executionID, "context_path": contextPath, "input_dir": inputDir, "output_dir": outputDir, "handoff_dir": handoffDir}
	if carriedPreRunProof != nil {
		result["pre_run_source_proof_digest_sha256"] = carriedPreRunProof["proof_digest_sha256"]
	}
	return result, nil
}

func (a *App) handleRulesEngineRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	result, err := a.runRulesEngine(body)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_RUN_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": safeID(asString(body["run_id"]))})
		status := http.StatusInternalServerError
		if errors.Is(err, errRulesEngineBusyV194) {
			status = http.StatusConflict
		}
		writeRulesEnginePublicErrorV194(w, status, "RULES_ENGINE_RUN_FAILED", "Движок правил не завершил обработку. Подробности записаны в журнале поддержки.")
		return
	}
	runID := safeID(asString(result["run_id"]))
	public, err := a.publicRulesEngineResultV194(runID, result)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_RUN_CONTEXT_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_RESULT_UNAVAILABLE", "Результат правил пока не готов. Повторите после завершения обработки.")
		return
	}
	writeJSON(w, http.StatusOK, public)
}

var errRulesEngineBusyV194 = errors.New("Rules Engine уже выполняется; дождитесь завершения текущего запуска")

func (a *App) runRulesEngine(body map[string]any) (map[string]any, error) {
	if !a.rulesEngineMu.TryLock() {
		return nil, errRulesEngineBusyV194
	}
	defer a.rulesEngineMu.Unlock()
	return a.runRulesEngineLockedV194(body)
}

func (a *App) runRulesEngineLockedV194(body map[string]any) (map[string]any, error) {
	prepared, err := a.prepareRulesEngine(body)
	if err != nil {
		return nil, err
	}
	if proofDigest := strings.TrimSpace(asString(prepared["pre_run_source_proof_digest_sha256"])); proofDigest != "" {
		run, proofErr := a.rulesEngineRunRecord(asString(prepared["run_id"]))
		if proofErr != nil {
			return nil, proofErr
		}
		proof, proofErr := validateStoredPreRunProofV194(run)
		if proofErr != nil {
			return nil, proofErr
		}
		if !strings.EqualFold(proofDigest, asString(proof["proof_digest_sha256"])) {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
	}
	contextPath := asString(prepared["context_path"])
	outputDir := asString(prepared["output_dir"])
	nodePath, err := a.rulesEngineNodeExecutable()
	if err != nil {
		return nil, err
	}
	scriptPath := filepath.Join(a.AppRoot, "modules", "rules-engine", "source", "cli.mjs")
	if !fileExists(scriptPath) {
		return nil, fmt.Errorf("не найден Rules Engine CLI: %s", scriptPath)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, nodePath, scriptPath, "run", "--context", contextPath, "--out", outputDir)
	cmd.Dir = filepath.Dir(scriptPath)
	cmd.Env = append(os.Environ(), "OPIU_SERVICE_ROOT="+a.Root, "OPIU_DATA_ROOT="+a.DataRoot)
	configureBackgroundCommand(cmd)
	stdoutPath := filepath.Join(outputDir, "rules_engine.stdout.log")
	stderrPath := filepath.Join(outputDir, "rules_engine.stderr.log")
	stdoutFile, err := os.OpenFile(stdoutPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("не удалось открыть журнал stdout Rules Engine: %w", err)
	}
	stderrFile, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
	if err != nil {
		_ = stdoutFile.Close()
		return nil, fmt.Errorf("не удалось открыть журнал stderr Rules Engine: %w", err)
	}
	cmd.Stdout = stdoutFile
	cmd.Stderr = stderrFile
	startedAt := nowISO()
	if err := cmd.Start(); err != nil {
		_ = stdoutFile.Close()
		_ = stderrFile.Close()
		_ = a.updateRulesEngineProcessV160(asString(prepared["run_id"]), map[string]any{
			"status": "FAILED", "started_at": startedAt, "finished_at": nowISO(), "error": err.Error(),
			"stdout_log": stdoutPath, "stderr_log": stderrPath,
		})
		return nil, fmt.Errorf("не удалось запустить Rules Engine: %w", err)
	}
	processPatch := map[string]any{
		"status": "RUNNING", "pid": cmd.Process.Pid, "started_at": startedAt, "finished_at": "", "error": "",
		"stdout_log": stdoutPath, "stderr_log": stderrPath, "context_path": contextPath, "output_dir": outputDir,
	}
	if err := a.updateRulesEngineProcessV160(asString(prepared["run_id"]), processPatch); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = stdoutFile.Close()
		_ = stderrFile.Close()
		return nil, err
	}
	_ = a.logEvent("RULES_ENGINE_STARTED_V160", map[string]any{"run_id": prepared["run_id"], "rules_execution_id": prepared["rules_execution_id"], "pid": cmd.Process.Pid, "stdout_log": stdoutPath, "stderr_log": stderrPath})
	err = cmd.Wait()
	_ = stdoutFile.Close()
	_ = stderrFile.Close()
	exitCode := -1
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() == context.DeadlineExceeded {
		message := "Rules Engine превысил лимит 20 минут"
		_ = a.updateRulesEngineProcessV160(asString(prepared["run_id"]), map[string]any{"status": "TIMED_OUT", "finished_at": nowISO(), "exit_code": exitCode, "error": message})
		_ = a.logEvent("RULES_ENGINE_TIMED_OUT_V160", map[string]any{"run_id": prepared["run_id"], "rules_execution_id": prepared["rules_execution_id"], "stderr_log": stderrPath})
		return nil, errors.New(message)
	}
	if err != nil {
		stderrTail := rulesEngineLogTailV160(stderrPath)
		message := fmt.Sprintf("Rules Engine завершился с ошибкой: %v", err)
		_ = a.updateRulesEngineProcessV160(asString(prepared["run_id"]), map[string]any{"status": "FAILED", "finished_at": nowISO(), "exit_code": exitCode, "error": message})
		_ = a.logEvent("RULES_ENGINE_FAILED_V160", map[string]any{"run_id": prepared["run_id"], "rules_execution_id": prepared["rules_execution_id"], "exit_code": exitCode, "stderr_log": stderrPath})
		if stderrTail != "" {
			return nil, fmt.Errorf("%s\n%s", message, stderrTail)
		}
		return nil, errors.New(message)
	}
	collected, collectErr := a.collectRulesEngine(asString(prepared["run_id"]))
	if collectErr != nil {
		_ = a.updateRulesEngineProcessV160(asString(prepared["run_id"]), map[string]any{"status": "FAILED_COLLECT", "finished_at": nowISO(), "exit_code": exitCode, "error": collectErr.Error()})
		return nil, collectErr
	}
	_ = a.updateRulesEngineProcessV160(asString(prepared["run_id"]), map[string]any{"status": "COMPLETED", "finished_at": nowISO(), "exit_code": exitCode, "error": "", "collected": collected})
	_ = a.logEvent("RULES_ENGINE_COMPLETED", map[string]any{"run_id": prepared["run_id"], "rules_execution_id": prepared["rules_execution_id"], "collected": collected})
	result, resultErr := a.rulesEngineResultV160(asString(prepared["run_id"]))
	if resultErr != nil {
		return map[string]any{"ok": true, "run_id": prepared["run_id"], "rules_execution_id": prepared["rules_execution_id"], "context_path": contextPath, "output_dir": outputDir, "collected": collected, "stdout_log": stdoutPath, "stderr_log": stderrPath}, nil
	}
	result["context_path"] = contextPath
	result["output_dir"] = outputDir
	result["collected"] = collected
	return result, nil
}

func (a *App) handleRulesEngineCollect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	runID := safeID(defaultString(asString(body["run_id"]), asString(settings["active_run_id"])))
	if runID == "" {
		writeJSON(w, 400, map[string]any{"error": "RUN_REQUIRED"})
		return
	}
	count, err := a.collectRulesEngine(runID)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_COLLECT_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_COLLECT_FAILED", "Результат правил пока не готов. Повторите после завершения обработки.")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "run_id": runID, "collected": count, "safety": map[string]any{"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false}})
}

func (a *App) collectRulesEngine(runID string) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	run, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		return 0, err
	}
	outputDir := asString(run["rules_output_dir"])
	if outputDir == "" {
		return 0, errors.New("каталог результата Rules Engine не зарегистрирован")
	}
	outputDir, err = a.rulesEngineDataDirectory(outputDir)
	if err != nil {
		return 0, err
	}
	registryResultPath := filepath.Join(outputDir, "registry_result.json")
	manifestPath := filepath.Join(outputDir, "engine_manifest.json")
	if !fileExists(registryResultPath) || !fileExists(manifestPath) {
		return 0, errors.New("Rules Engine не сформировал registry_result.json или engine_manifest.json")
	}
	changed, err := a.mergeRulesEngineRegistryResult(runID, registryResultPath, manifestPath)
	if err != nil {
		return 0, err
	}

	artifacts := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "artifacts", "index.json"), &artifacts)
	list := anySlice(artifacts["artifacts"])
	seen := map[string]bool{}
	for _, raw := range list {
		m, _ := raw.(map[string]any)
		if m != nil {
			seen[asString(m["path"])+"|"+asString(m["sha256"])] = true
		}
	}
	count := 0
	workflowPath := ""
	err = filepath.Walk(outputDir, func(filePath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info == nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(filePath))
		if ext != ".json" && ext != ".csv" && ext != ".xlsx" && ext != ".log" {
			return nil
		}
		hash, hashErr := fileSHA256V041(filePath)
		if hashErr != nil {
			return hashErr
		}
		key := filePath + "|" + hash
		if seen[key] {
			return nil
		}
		name := strings.ToLower(filepath.Base(filePath))
		typeName := "RULES_ENGINE_ARTIFACT"
		switch {
		case strings.Contains(name, "rule_candidates"):
			typeName = "RULE_CANDIDATES"
		case strings.Contains(name, "rule_applications"):
			typeName = "RULE_APPLICATIONS"
		case strings.Contains(name, "workflow_decision"):
			typeName = "RULES_WORKFLOW_DECISION"
			workflowPath = filePath
		case strings.Contains(name, "matching_report"):
			typeName = "RULES_MATCHING_REPORT"
		case strings.Contains(name, "rule_feedback"):
			typeName = "RULE_FEEDBACK"
		case strings.Contains(name, "registry_result"):
			typeName = "RULE_REGISTRY_RESULT"
		case strings.Contains(name, "manifest"):
			typeName = "RULES_ENGINE_MANIFEST"
		}
		list = append(list, map[string]any{
			"artifact_id":        "ART-" + lastN(hash, 16),
			"run_id":             runID,
			"stage":              "RULES",
			"artifact_type":      typeName,
			"name":               filepath.Base(filePath),
			"path":               filePath,
			"size":               info.Size(),
			"sha256":             hash,
			"created_at":         info.ModTime().UTC().Format(time.RFC3339),
			"source_engine":      "RULES_ENGINE",
			"rules_execution_id": run["rules_execution_id"],
			"downloadable":       true,
		})
		seen[key] = true
		count++
		return nil
	})
	if err != nil {
		return 0, err
	}
	artifacts["artifacts"] = list
	if err := writeJSONAtomic(filepath.Join(a.DataRoot, "artifacts", "index.json"), artifacts); err != nil {
		return 0, err
	}
	if workflowPath == "" {
		workflowPath = filepath.Join(outputDir, "workflow_decision.json")
	}
	decision := map[string]any{}
	if err := readJSON(workflowPath, &decision); err != nil {
		return 0, err
	}
	next := asString(decision["next_action"])
	run["rules_workflow_decision_path"] = workflowPath
	run["rules_next_action"] = next
	run["rules_registry_changes"] = changed
	run["rules_state_snapshot"] = decision["state"]
	if state, _ := run["rules_state_snapshot"].(map[string]any); state != nil {
		state["state_fingerprint"] = decision["state_fingerprint"]
	}
	run["stage"] = rulesEngineStageForNextAction(next)
	run["updated_at"] = nowISO()
	if err := a.rulesEngineSaveRunRecord(runID, run); err != nil {
		return 0, err
	}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	settings["workflow_stage"] = run["stage"]
	_ = writeJSONAtomic(filepath.Join(a.ConfigDir, "settings.json"), settings)
	return count, nil
}

func (a *App) mergeRulesEngineRegistryResult(runID, resultPath, manifestPath string) (int, error) {
	result := map[string]any{}
	manifest := map[string]any{}
	if err := readJSON(resultPath, &result); err != nil {
		return 0, err
	}
	if err := readJSON(manifestPath, &manifest); err != nil {
		return 0, err
	}
	if asString(result["schema_version"]) != "opiu-rule-registry-result.v1" || asString(result["run_id"]) != runID {
		return 0, errors.New("некорректный registry_result.json")
	}
	registryResult, _ := result["registry"].(map[string]any)
	if registryResult == nil {
		return 0, errors.New("registry_result.json не содержит registry")
	}
	registryPath := filepath.Join(a.RulesDir, "rules.json")
	currentHash, err := fileSHA256V041(registryPath)
	if err != nil {
		return 0, err
	}
	baseHash := defaultString(asString(result["base_registry_sha256"]), asString(manifest["registry_input_sha256"]))
	if baseHash == "" || !strings.EqualFold(baseHash, currentHash) {
		return 0, errors.New("RULE_REGISTRY_CHANGED_DURING_RUN: повторите Rules Engine на актуальном реестре")
	}
	current := map[string]any{}
	if err := readJSON(registryPath, &current); err != nil {
		return 0, err
	}
	currentRules := anySlice(current["rules"])
	currentRevisions := anySlice(current["revisions"])
	currentApplications := anySlice(current["applications"])
	currentApprovals := anySlice(current["approvals"])
	currentEvidence := anySlice(current["evidence"])
	resultRules := anySlice(registryResult["rules"])
	resultApplications := anySlice(registryResult["applications"])
	resultApprovals := anySlice(registryResult["approvals"])
	resultEvidence := anySlice(registryResult["evidence"])
	changed := 0

	for _, rawAudit := range anySlice(result["decision_audit"]) {
		audit, _ := rawAudit.(map[string]any)
		if audit == nil || (asString(audit["action"]) != "NEW_RULE" && asString(audit["action"]) != "NEW_REVISION") {
			continue
		}
		revisionID := asString(audit["revision_id"])
		var canonical map[string]any
		for _, rawRule := range resultRules {
			rule, _ := rawRule.(map[string]any)
			if rule != nil && asString(rule["revision_id"]) == revisionID {
				canonical = rule
				break
			}
		}
		if canonical == nil {
			return 0, fmt.Errorf("registry_result не содержит revision_id %s", revisionID)
		}
		ruleID := asString(canonical["rule_id"])
		if asString(audit["action"]) == "NEW_REVISION" {
			for _, rawRule := range currentRules {
				rule, _ := rawRule.(map[string]any)
				if rule != nil && asString(rule["rule_id"]) == ruleID && asBool(rule["is_current"]) {
					rule["is_current"] = false
					rule["enabled"] = false
					rule["status"] = "INACTIVE"
					rule["updated_at"] = nowISO()
				}
			}
		}
		legacy := canonicalRuleToV041(canonical)
		if !containsRevisionV041(currentRules, revisionID) {
			currentRules = append(currentRules, legacy)
			currentRevisions = append(currentRevisions, cloneMap(legacy))
			changed++
		}
	}

	for _, raw := range resultApplications {
		application, _ := raw.(map[string]any)
		if application == nil || asString(application["run_id"]) != runID {
			continue
		}
		application = applicationToV041(application)
		id := asString(application["application_id"])
		if replaceByIDV041(&currentApplications, application, "application_id", id) {
			changed++
		}
	}
	for _, raw := range resultApprovals {
		approval, _ := raw.(map[string]any)
		if approval == nil {
			continue
		}
		id := asString(approval["approval_id"])
		if id != "" && replaceByIDV041(&currentApprovals, cloneMap(approval), "approval_id", id) {
			changed++
		}
	}
	for _, raw := range resultEvidence {
		evidence, _ := raw.(map[string]any)
		if evidence == nil || asString(evidence["run_id"]) != runID {
			continue
		}
		id := asString(evidence["evidence_id"])
		if id != "" && replaceByIDV041(&currentEvidence, cloneMap(evidence), "evidence_id", id) {
			changed++
		}
	}
	current["rules"] = currentRules
	current["revisions"] = currentRevisions
	current["applications"] = currentApplications
	current["approvals"] = currentApprovals
	current["evidence"] = currentEvidence
	current["rules_revision_set_hash"] = registryResult["rules_revision_set_hash"]
	current["updated_at"] = nowISO()
	if changed > 0 {
		if err := writeJSONAtomic(registryPath, current); err != nil {
			return 0, err
		}
	}
	return changed, nil
}

func canonicalRuleToV041(rule map[string]any) map[string]any {
	scope, _ := rule["scope"].(map[string]any)
	intalev, _ := rule["intalev"].(map[string]any)
	erp, _ := rule["erp"].(map[string]any)
	accounting, _ := rule["accounting"].(map[string]any)
	action, _ := rule["action"].(map[string]any)
	source, _ := rule["source"].(map[string]any)
	if scope == nil {
		scope = map[string]any{}
	}
	if intalev == nil {
		intalev = map[string]any{}
	}
	if erp == nil {
		erp = map[string]any{}
	}
	if accounting == nil {
		accounting = map[string]any{}
	}
	if action == nil {
		action = map[string]any{}
	}
	if source == nil {
		source = map[string]any{}
	}
	accountPair := strings.Trim(strings.Join([]string{asString(accounting["debit_account"]), asString(accounting["credit_account"])}, " / "), " / ")
	legacy := map[string]any{
		"rule_id": rule["rule_id"], "origin_rule_id": rule["origin_rule_id"], "revision_id": rule["revision_id"], "parent_revision_id": rule["parent_revision_id"],
		"name": rule["title"], "description": rule["description"], "rule_type": "organization", "status": "CURRENT", "enabled": true, "is_current": true,
		"valid_from_year": rule["valid_from_year"], "valid_to_year": rule["valid_to_year"],
		"scope": map[string]any{"scope_type": scope["scope_type"], "node_id": scope["organization_id"], "node_name": scope["organization_name"], "hierarchy_path": scope["organization_path"], "include_descendants": scope["include_descendants"], "mapping_status": scope["mapping_status"]},
		"mapping": map[string]any{
			"intalev_source": map[string]any{"code": intalev["article_code"], "article": intalev["article_name"], "path": intalev["article_path"]},
			"intalev_target": map[string]any{"code": erp["article_code"], "article": erp["article_name"], "path": erp["article_path"]},
			"erp_source":     map[string]any{"article": intalev["article_name"], "path": intalev["article_path"], "account": accountPair, "side": "Дт / Кт"},
			"erp_target":     map[string]any{"code": erp["article_code"], "article": erp["article_name"], "path": erp["article_path"], "account": accountPair, "side": "Дт / Кт"},
			"opiu_block":     defaultString(asString(erp["opiu_block_path"]), asString(erp["opiu_block_name"])), "candidate_articles": []any{}, "source_rows": []any{},
		},
		"action": action["action_type"], "condition_text": action["condition_text"], "author": source["author"],
		"source":     map[string]any{"kind": "rules_engine", "source_engine": source["source_engine"], "run_id": source["source_run_id"], "file": source["source_file"], "sha256": source["source_sha256"]},
		"created_at": rule["created_at"], "updated_at": rule["updated_at"], "content_hash": rule["content_hash"],
	}
	ensureRuleNoApplicationsV041(legacy)
	return legacy
}

func applicationToV041(application map[string]any) map[string]any {
	out := cloneMap(application)
	out["node_id"] = application["organization_id"]
	out["node_name"] = application["organization_name"]
	out["decision"] = application["result_status"]
	return out
}

func containsRevisionV041(list []any, revisionID string) bool {
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		if item != nil && asString(item["revision_id"]) == revisionID {
			return true
		}
	}
	return false
}

func replaceByIDV041(list *[]any, item map[string]any, key, id string) bool {
	if id == "" {
		return false
	}
	for index, raw := range *list {
		current, _ := raw.(map[string]any)
		if current != nil && asString(current[key]) == id {
			if fmt.Sprint(current) == fmt.Sprint(item) {
				return false
			}
			(*list)[index] = item
			return true
		}
	}
	*list = append(*list, item)
	return true
}

func (a *App) handleRulesEngineApplyDecisions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	runID := safeID(asString(body["run_id"]))
	if runID == "" {
		writeJSON(w, 400, map[string]any{"error": "RUN_REQUIRED"})
		return
	}
	decisions := anySlice(body["decisions"])
	if len(decisions) == 0 {
		writeJSON(w, 400, map[string]any{"error": "DECISIONS_REQUIRED"})
		return
	}
	if !a.rulesEngineMu.TryLock() {
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_BUSY", "Движок правил уже обрабатывает другое решение. Обновите результат и повторите.")
		return
	}
	defer a.rulesEngineMu.Unlock()
	run, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "RUN_NOT_FOUND"})
		return
	}
	revisionContext, err := rulesEngineRevisionContextFromRunV194(run)
	if err != nil || revisionContext.RunID != runID {
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULE_DECISION_CONTEXT_CHANGED", "Контекст изменился. Обновите страницу и выберите решение заново.")
		return
	}
	settings := map[string]any{}
	if err := readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings); err != nil ||
		safeID(asString(settings["active_run_id"])) != runID ||
		strings.TrimSpace(asString(settings["organization_id"])) != revisionContext.OrganizationID ||
		strings.TrimSpace(asString(settings["organization_name"])) != revisionContext.OrganizationName ||
		strings.TrimSpace(asString(settings["organization_path"])) != revisionContext.OrganizationPath ||
		strings.TrimSpace(asString(settings["period"])) != revisionContext.Period ||
		strings.TrimSpace(asString(body["organization_id"])) != revisionContext.OrganizationID {
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULE_DECISION_CONTEXT_CHANGED", "Контекст изменился. Обновите страницу и выберите решение заново.")
		return
	}
	candidatesPath := filepath.Join(asString(run["rules_output_dir"]), "rule_candidates.json")
	if err := a.verifyExactR001ArtifactV194(runID, "RULE_CANDIDATES", "RULES", candidatesPath, "", revisionContext.RulesExecutionID); err != nil {
		_ = a.logEvent("RULE_CANDIDATES_EXACT_BINDING_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULE_CANDIDATE_CHANGED", "Предложение правила изменилось. Обновите страницу и выберите решение заново.")
		return
	}
	candidatesDoc := map[string]any{}
	if err := readJSON(candidatesPath, &candidatesDoc); err != nil || strings.TrimSpace(asString(candidatesDoc["run_id"])) != runID {
		writeJSON(w, 409, map[string]any{"error": "RULE_CANDIDATES_NOT_COLLECTED"})
		return
	}
	known := map[string]map[string]any{}
	for _, raw := range anySlice(candidatesDoc["candidates"]) {
		candidate, _ := raw.(map[string]any)
		if candidate != nil {
			known[asString(candidate["candidate_id"])] = candidate
		}
	}
	seen := map[string]bool{}
	allowed := map[string]bool{"CONFIRMED": true, "REJECTED": true, "MANUAL_REVIEW": true, "ACCEPT_DIFFERENCE": true, "LINK_TO_EXISTING": true, "CREATE_REVISION": true}
	for _, raw := range decisions {
		decision, _ := raw.(map[string]any)
		candidateID := asString(decision["candidate_id"])
		candidate := known[candidateID]
		if decision == nil || candidate == nil || seen[candidateID] || !allowed[asString(decision["decision"])] {
			writeJSON(w, 400, map[string]any{"error": "INVALID_RULE_DECISION"})
			return
		}
		if expected := rulesEngineCandidateRevisionV194(candidate, revisionContext); expected == "" || expected != strings.TrimSpace(asString(decision["candidate_revision_id"])) {
			writeJSON(w, 409, map[string]any{"error": "RULE_CANDIDATE_CHANGED", "message": "Предложение правила изменилось. Обновите страницу и выберите решение заново."})
			return
		}
		if (asString(decision["decision"]) == "LINK_TO_EXISTING" || asString(decision["decision"]) == "CREATE_REVISION") && safeID(asString(decision["existing_rule_id"])) == "" {
			writeJSON(w, 400, map[string]any{"error": "EXISTING_RULE_REQUIRED"})
			return
		}
		seen[asString(decision["candidate_id"])] = true
	}
	if err := a.bindRulesEngineAccountSelectionsV194(decisions); err != nil {
		_ = a.logEvent("RULE_ACCOUNT_SELECTION_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID})
		writeJSON(w, 409, map[string]any{"error": "ERP_ACCOUNT_SELECTION_INVALID", "message": "Выбранный счёт ERP больше недоступен. Обновите страницу и выберите счёт заново."})
		return
	}
	contextDir := filepath.Join(a.DataRoot, "runs", runID, "context")
	historyDir := filepath.Join(contextDir, "decision-history")
	if err := os.MkdirAll(historyDir, 0755); err != nil {
		writeErr(w, err)
		return
	}
	doc := map[string]any{"schema_version": "opiu-user-rule-decisions.v1", "run_id": runID, "author": body["author"], "organization_id": body["organization_id"], "decisions": decisions, "created_at": nowISO()}
	historyPath := filepath.Join(historyDir, safeID("DECISIONS-"+time.Now().UTC().Format("20060102T150405.000000000"))+".json")
	if err := writeJSONAtomic(historyPath, doc); err != nil {
		writeErr(w, err)
		return
	}
	decisionsPath := filepath.Join(contextDir, "user_rule_decisions.json")
	if err := writeJSONAtomic(decisionsPath, doc); err != nil {
		writeErr(w, err)
		return
	}
	body["phase"] = "AFTER_USER_DECISIONS"
	result, err := a.runRulesEngineLockedV194(body)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_APPLY_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID, "decision_history_path": historyPath})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULES_ENGINE_DECISION_APPLY_FAILED", "Решение не обработано. Подробности записаны в журнале поддержки.")
		return
	}
	public, err := a.publicRulesEngineResultV194(runID, result)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_APPLY_CONTEXT_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "run_id": runID, "decision_history_path": historyPath})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_RESULT_UNAVAILABLE", "Результат правил пока не готов. Повторите после завершения обработки.")
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (a *App) handleRulesEngineStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	runID := safeID(r.URL.Query().Get("run_id"))
	if runID == "" {
		settings := map[string]any{}
		_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
		runID = safeID(asString(settings["active_run_id"]))
	}
	if runID == "" {
		writeJSON(w, 400, map[string]any{"error": "RUN_REQUIRED"})
		return
	}
	run, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "RUN_NOT_FOUND"})
		return
	}
	decision := map[string]any{}
	decisionPath := asString(run["rules_workflow_decision_path"])
	if decisionPath != "" {
		_ = readJSON(decisionPath, &decision)
	}
	execution, _ := run["rules_process"].(map[string]any)
	if execution == nil {
		execution = map[string]any{"status": "NOT_STARTED"}
	}
	publicDecision := map[string]any{
		"next_action":               decision["next_action"],
		"reasons":                   decision["reasons"],
		"required_user_actions":     decision["required_user_actions"],
		"disputed_draft_count":      decision["disputed_draft_count"],
		"blocking_unresolved_count": decision["blocking_unresolved_count"],
	}
	publicExecution := map[string]any{
		"status": execution["status"], "started_at": execution["started_at"], "finished_at": execution["finished_at"],
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "run_id": runID, "rules_execution_id": run["rules_execution_id"], "stage": run["stage"], "next_action": run["rules_next_action"],
		"decision": publicDecision, "execution": publicExecution, "result_url": "/api/rules-engine/result?run_id=" + runID,
		"safety": map[string]any{"report_only": true, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false},
	})
}

func (a *App) rulesEngineNodeExecutable() (string, error) {
	candidates := []string{
		strings.TrimSpace(os.Getenv("OPIU_NODE_EXE")),
		filepath.Join(a.AppRoot, "runtime", "node", "node.exe"),
		filepath.Join(a.AppRoot, "runtime", "node.exe"),
	}
	for _, candidate := range candidates {
		if candidate != "" && fileExists(candidate) {
			return candidate, nil
		}
	}
	for _, name := range []string{"node.exe", "node"} {
		if found, err := exec.LookPath(name); err == nil {
			return found, nil
		}
	}
	return "", errors.New("Node.js runtime для Rules Engine не найден")
}

func (a *App) rulesEngineRunRecord(runID string) (map[string]any, error) {
	a.runsMu.Lock()
	defer a.runsMu.Unlock()
	runs := map[string]any{}
	if err := readJSON(filepath.Join(a.DataRoot, "runs", "index.json"), &runs); err != nil {
		return nil, err
	}
	for _, raw := range anySlice(runs["runs"]) {
		record, _ := raw.(map[string]any)
		if record != nil && asString(record["run_id"]) == runID {
			return record, nil
		}
	}
	return nil, errors.New("запуск не найден")
}

func (a *App) rulesEngineSaveRunRecord(runID string, updated map[string]any) error {
	a.runsMu.Lock()
	defer a.runsMu.Unlock()
	runs := map[string]any{}
	path := filepath.Join(a.DataRoot, "runs", "index.json")
	if err := readJSON(path, &runs); err != nil {
		return err
	}
	list := anySlice(runs["runs"])
	found := false
	for index, raw := range list {
		record, _ := raw.(map[string]any)
		if record != nil && asString(record["run_id"]) == runID {
			list[index] = updated
			found = true
			break
		}
	}
	if !found {
		return errors.New("запуск не найден")
	}
	runs["runs"] = list
	return writeJSONAtomic(path, runs)
}

func (a *App) rulesEngineLatestArtifactRecord(runID, artifactType, stage string) map[string]any {
	artifacts := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "artifacts", "index.json"), &artifacts)
	var best map[string]any
	for _, raw := range anySlice(artifacts["artifacts"]) {
		item, _ := raw.(map[string]any)
		if item == nil || asString(item["run_id"]) != runID {
			continue
		}
		if artifactType != "" && asString(item["artifact_type"]) != artifactType {
			continue
		}
		if stage != "" && asString(item["stage"]) != stage {
			continue
		}
		if best == nil || asString(item["created_at"]) > asString(best["created_at"]) {
			best = item
		}
	}
	return best
}

func (a *App) rulesEngineVerifiedArtifact(artifact map[string]any) (string, string, error) {
	filePath, err := a.rulesEngineDataFile(asString(artifact["path"]))
	if err != nil {
		return "", "", err
	}
	hash, err := fileSHA256V041(filePath)
	if err != nil {
		return "", "", err
	}
	expected := asString(artifact["sha256"])
	if expected != "" && !strings.EqualFold(expected, hash) {
		return "", "", fmt.Errorf("хэш зарегистрированного артефакта изменился: %s", filepath.Base(filePath))
	}
	return filePath, hash, nil
}

func (a *App) rulesEngineDataFile(filePath string) (string, error) {
	clean, err := a.rulesEngineDataPath(filePath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(clean)
	if err != nil || info.IsDir() {
		return "", fmt.Errorf("файл данных не найден: %s", clean)
	}
	return clean, nil
}

func (a *App) rulesEngineDataDirectory(dirPath string) (string, error) {
	clean, err := a.rulesEngineDataPath(dirPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(clean)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("каталог данных не найден: %s", clean)
	}
	return clean, nil
}

func (a *App) rulesEngineDataPath(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", errors.New("пустой путь данных")
	}
	clean, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(filepath.Clean(a.DataRoot))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, clean)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return "", errors.New("Rules Engine принимает только зарегистрированные пути внутри data")
	}
	if evaluated, evalErr := filepath.EvalSymlinks(clean); evalErr == nil {
		evaluatedAbs, _ := filepath.Abs(evaluated)
		evaluatedRel, relErr := filepath.Rel(root, evaluatedAbs)
		if relErr != nil || evaluatedRel == ".." || strings.HasPrefix(evaluatedRel, ".."+string(os.PathSeparator)) || filepath.IsAbs(evaluatedRel) {
			return "", errors.New("символическая ссылка выводит Rules Engine за пределы data")
		}
	}
	return clean, nil
}

func copyFileAtomicRulesEngine(source, target string) error {
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	temp := target + ".tmp-" + lastN(newID(""), 8)
	if err := os.WriteFile(temp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

func rulesEngineStageForNextAction(next string) string {
	switch next {
	case "WAIT_USER_RULES":
		return "RULES_REVIEW_REQUIRED"
	case "RERUN_R005":
		return "R005_RERUN_REQUIRED"
	case "PASS_TO_R001":
		return "R001_PREPARED"
	case "RERUN_R001":
		return "R001_RERUN_REQUIRED"
	case "COMPLETE":
		return "RULE_FEEDBACK_REGISTERED"
	case "FAILED_NO_STATE_CHANGE", "FAILED":
		return "FAILED"
	default:
		return "RULES_ANALYZED"
	}
}
