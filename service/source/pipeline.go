package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Pipeline struct {
	store         *Store
	commands      map[string][]string
	runtime       *RuntimeAdapter
	rulesRegistry *persistentRulesRegistry
	runner        pipelineStageRunner
	mu            sync.Mutex
	active        map[string]struct{}
}

type pipelineStageRunner func(stage string, command []string, values map[string]string, runDir, runtimeRoot string) error

type internalRunManifest struct {
	SchemaVersion     string                               `json:"schema_version"`
	RunID             string                               `json:"run_id"`
	ContextID         string                               `json:"context_id"`
	Organization      string                               `json:"organization"`
	OrganizationID    string                               `json:"organization_id"`
	OrganizationName  string                               `json:"organization_name"`
	OrganizationPath  string                               `json:"organization_path"`
	CFO               string                               `json:"cfo,omitempty"`
	Period            string                               `json:"period"`
	ERP               internalFile                         `json:"erp"`
	Intalev           internalFile                         `json:"intalev"`
	Safety            SafetyState                          `json:"safety"`
	CreatedAt         time.Time                            `json:"created_at"`
	StructuralControl *structuralControlRunManifestBinding `json:"structural_control,omitempty"`
}

type internalFile struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func NewPipeline(store *Store) (*Pipeline, error) {
	commands := map[string][]string{}
	for _, item := range []struct {
		stage string
		env   string
	}{
		{stage: "R005", env: "OPIU_R005_CMD_JSON"},
		{stage: "RULES", env: "OPIU_RULES_CMD_JSON"},
		{stage: "R001", env: "OPIU_R001_CMD_JSON"},
	} {
		value := strings.TrimSpace(os.Getenv(item.env))
		if value == "" {
			continue
		}
		var command []string
		if err := json.Unmarshal([]byte(value), &command); err != nil || len(command) == 0 {
			return nil, fmt.Errorf("%s must be a non-empty JSON string array", item.env)
		}
		for _, part := range command {
			if strings.ContainsRune(part, '\x00') {
				return nil, fmt.Errorf("%s contains an invalid argument", item.env)
			}
		}
		commands[item.stage] = command
	}

	var runtimeAdapter *RuntimeAdapter
	var rulesRegistry *persistentRulesRegistry
	if len(commands) == 0 {
		adapter, err := discoverRuntimeAdapter()
		if err != nil {
			return nil, err
		}
		runtimeAdapter = adapter
		if runtimeAdapter != nil {
			rulesRegistry, err = newPersistentRulesRegistry(store, runtimeAdapter.RulesRegistry)
			if err != nil {
				return nil, fmt.Errorf("configure persistent rules registry: %w", err)
			}
		}
	} else if len(commands) != 3 {
		return nil, errors.New("all three external engine adapter commands are required")
	}
	if len(commands) == 3 {
		if err := requireExternalR005ScopePlaceholders(commands["R005"]); err != nil {
			return nil, err
		}
	}

	catalogPath := ""
	if runtimeAdapter != nil {
		catalogPath = filepath.Join(runtimeAdapter.Root, "data", "defaults", "organizations.json")
	} else if len(commands) == 3 {
		catalogPath = strings.TrimSpace(os.Getenv("OPIU_ORGANIZATION_CATALOG"))
		if catalogPath == "" {
			return nil, errors.New("OPIU_ORGANIZATION_CATALOG is required for external engine adapters")
		}
	}
	if catalogPath != "" {
		nodes, err := loadOrganizationCatalog(catalogPath)
		if err != nil {
			return nil, fmt.Errorf("load authoritative organization catalog: %w", err)
		}
		if err := store.ConfigureOrganizationCatalog(nodes); err != nil {
			return nil, fmt.Errorf("configure authoritative organization catalog: %w", err)
		}
	}

	return &Pipeline{
		store:         store,
		commands:      commands,
		runtime:       runtimeAdapter,
		rulesRegistry: rulesRegistry,
		runner:        runStage,
		active:        map[string]struct{}{},
	}, nil
}

func requireExternalR005ScopePlaceholders(command []string) error {
	required := []string{"{run_id}", "{context_id}", "{organization_id}", "{organization_name}", "{organization_path}"}
	for _, placeholder := range required {
		found := false
		for _, argument := range command {
			if strings.Contains(argument, placeholder) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("OPIU_R005_CMD_JSON must include exact scope placeholder %s", placeholder)
		}
	}
	return nil
}

func (p *Pipeline) Ready() bool {
	if p.runtime != nil {
		return true
	}
	return len(p.commands["R005"]) > 0 && len(p.commands["RULES"]) > 0 && len(p.commands["R001"]) > 0
}

func (p *Pipeline) Start(run Run) error {
	p.mu.Lock()
	if _, exists := p.active[run.ID]; exists {
		p.mu.Unlock()
		return errors.New("run already active")
	}
	p.active[run.ID] = struct{}{}
	p.mu.Unlock()
	go func() {
		defer func() {
			p.mu.Lock()
			delete(p.active, run.ID)
			p.mu.Unlock()
		}()
		p.execute(run)
	}()
	return nil
}

func (p *Pipeline) execute(run Run) {
	finish := func(status RunStatus, stage, message string) {
		now := time.Now().UTC()
		run.Status = status
		run.Stage = stage
		run.Message = message
		run.FinishedAt = &now
		_ = p.store.UpdateRun(run)
	}

	run.Status = RunPreflight
	run.Stage = "PREFLIGHT"
	run.Message = "Проверяются выбранные источники"
	if err := p.store.UpdateRun(run); err != nil {
		return
	}
	contextValue, ok := p.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Контекст недоступен или архивирован")
		return
	}
	erpPath, erp, err := sourcePath(p.store, contextValue.ERPFileID, SourceERP)
	if err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Источник ERP недоступен")
		return
	}
	intalevPath, intalev, err := sourcePath(p.store, contextValue.IntalevFileID, SourceIntalev)
	if err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Источник Инталев недоступен")
		return
	}
	runDir := filepath.Join(p.store.RunsDir(), run.ID)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		finish(RunFailed, "PREFLIGHT", "Не удалось подготовить рабочую папку запуска")
		return
	}
	manifest := internalRunManifest{
		SchemaVersion:    "opiu-stable-run.v1",
		RunID:            run.ID,
		ContextID:        contextValue.ID,
		Organization:     contextValue.Organization,
		OrganizationID:   contextValue.OrganizationID,
		OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath,
		CFO:              contextValue.CFO,
		Period:           contextValue.Period,
		ERP:              internalFile{ID: erp.ID, Name: erp.Name, SHA256: erp.SHA256, Size: erp.Size},
		Intalev:          internalFile{ID: intalev.ID, Name: intalev.Name, SHA256: intalev.SHA256, Size: intalev.Size},
		Safety:           reportOnlySafety(),
		CreatedAt:        time.Now().UTC(),
	}
	if err := atomicWriteJSON(filepath.Join(runDir, "run_manifest.json"), manifest); err != nil {
		finish(RunFailed, "PREFLIGHT", "Не удалось сохранить паспорт запуска")
		return
	}
	if !p.Ready() {
		finish(RunBlockedEngineAdapter, "ENGINE_ADAPTER", "Расчётный runtime не найден; исходники сервиса сохранены безопасно")
		return
	}

	if p.runtime != nil {
		p.executeRuntime(run, contextValue, erpPath, erp.SHA256, intalevPath, runDir, finish)
		return
	}
	p.executeExternal(run, contextValue, erpPath, intalevPath, runDir, finish)
}

func (p *Pipeline) executeExternal(run Run, contextValue Context, erpPath, intalevPath, runDir string, finish func(RunStatus, string, string)) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Для сверки не определена точная организация")
		return
	}
	emptyArticleBindingSettingsPath, err := p.materializeActiveEmptyArticleBindingSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка привязки пустых статей недоступна или повреждена")
		return
	}
	structuralControlSettingsPath, structuralControlAudit, err := p.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков недоступна или повреждена")
		return
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, structuralControlAudit); err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков не привязана к паспорту запуска")
		return
	}
	values := map[string]string{
		"{erp}":               erpPath,
		"{intalev}":           intalevPath,
		"{period}":            contextValue.Period,
		"{organization}":      contextValue.Organization,
		"{organization_id}":   contextValue.OrganizationID,
		"{organization_name}": contextValue.OrganizationName,
		"{organization_path}": contextValue.OrganizationPath,
		"{cfo}":               contextValue.CFO,
		"{run_dir}":           runDir,
		"{context_id}":        contextValue.ID,
		"{run_id}":            run.ID,
	}
	structuralControlProofPath := ""
	for _, stage := range []string{"R005", "RULES", "R001"} {
		run.Status = RunRunning
		run.Stage = stage
		run.Message = stageMessage(stage)
		if err := p.store.UpdateRun(run); err != nil {
			return
		}
		command := p.commands[stage]
		if stage == "R005" {
			command = appendEmptyArticleBindingSettingsArgument(command, emptyArticleBindingSettingsPath)
			if structuralControlSettingsPath != "" && hasStructuralControlSettingsArgument(command) {
				finish(RunFailed, "R005_SETTINGS", "Команда сверки содержит повторную настройку группировки блоков")
				return
			}
			command = appendStructuralControlSettingsArgument(command, structuralControlSettingsPath)
			command = appendStructuralControlScopeArguments(command)
			if err := p.verifyStructuralControlPipelineAudit(structuralControlAudit); err != nil {
				finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков изменилась до запуска сверки")
				return
			}
		} else {
			if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir,
				filepath.Join(runDir, "r005", "reconciliation.codex-input.json"), structuralControlProofPath); err != nil {
				finish(RunFailed, "R005_PROOF", "Доказательство настройки группировки блоков изменилось после R005")
				return
			}
			command = appendStructuralControlProofArgument(command, structuralControlProofPath)
		}
		if err := p.runStage(stage, command, values, runDir, ""); err != nil {
			finish(RunFailed, stage, "Этап завершился ошибкой; технические детали сохранены в журнале запуска")
			return
		}
		if stage == "R005" {
			if err := p.anchorStructuralControlInventory(run, contextValue, filepath.Join(runDir, "r005")); err != nil {
				finish(RunBlockedStructuralInventory, "R005_INVENTORY", "Проверенный состав верхних блоков R005 недоступен; правила не запускались")
				return
			}
			structuralControlProofPath, _, err = materializeStructuralControlProof(run, contextValue, runDir,
				filepath.Join(runDir, "r005", "reconciliation.codex-input.json"))
			if err != nil {
				finish(RunFailed, "R005_PROOF", "R005 не подтвердил применённую настройку группировки блоков")
				return
			}
		}
	}
	finish(RunCompletedReportOnly, "DONE", "Отчётный запуск завершён; запись в 1С не выполнялась")
}

func (p *Pipeline) executeRuntime(run Run, contextValue Context, erpPath, erpSHA256, intalevPath, runDir string, finish func(RunStatus, string, string)) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Для сверки не определена точная организация")
		return
	}
	adapter := p.runtime
	rulesRegistry := p.rulesRegistry
	if rulesRegistry == nil {
		var err error
		rulesRegistry, err = newPersistentRulesRegistry(p.store, adapter.RulesRegistry)
		if err != nil {
			finish(RunFailed, "RULES", "Постоянный реестр правил недоступен или повреждён")
			return
		}
		p.rulesRegistry = rulesRegistry
	}
	mode, err := periodMode(contextValue.Period)
	if err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Период контекста не поддерживается")
		return
	}

	r005Dir := filepath.Join(runDir, "r005")
	rulesDir := filepath.Join(runDir, "rules")
	handoffDir := filepath.Join(runDir, "handoff")
	r001Dir := filepath.Join(runDir, "r001")
	for _, directory := range []string{r005Dir, rulesDir, handoffDir, r001Dir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			finish(RunFailed, "PREFLIGHT", "Не удалось подготовить рабочую папку этапа")
			return
		}
	}
	emptyArticleBindingSettingsPath, err := p.materializeActiveEmptyArticleBindingSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка привязки пустых статей недоступна или повреждена")
		return
	}
	structuralControlSettingsPath, structuralControlAudit, err := p.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков недоступна или повреждена")
		return
	}
	if err := bindStructuralControlRunManifest(run, contextValue, runDir, structuralControlAudit); err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков не привязана к паспорту запуска")
		return
	}

	r005Report := filepath.Join(r005Dir, "reconciliation.xlsx")
	r005Codex := strings.TrimSuffix(r005Report, filepath.Ext(r005Report)) + ".codex-input.json"
	r005Command := []string{
		adapter.Node,
		adapter.R005Script,
		"run",
		"--erp", erpPath,
		"--erp-sha256", erpSHA256,
		"--intalev", intalevPath,
		"--mode", mode,
		"--period", contextValue.Period,
		"--organization", contextValue.Organization,
		"--run-id", run.ID,
		"--context-id", contextValue.ID,
		"--organization-id", contextValue.OrganizationID,
		"--organization-name", contextValue.OrganizationName,
		"--organization-path", contextValue.OrganizationPath,
		"--output", r005Report,
	}
	r005Command = appendEmptyArticleBindingSettingsArgument(r005Command, emptyArticleBindingSettingsPath)
	if structuralControlSettingsPath != "" && hasStructuralControlSettingsArgument(r005Command) {
		finish(RunFailed, "R005_SETTINGS", "Команда сверки содержит повторную настройку группировки блоков")
		return
	}
	r005Command = appendStructuralControlSettingsArgument(r005Command, structuralControlSettingsPath)
	if !p.updateStage(&run, "R005") {
		return
	}
	if err := p.verifyStructuralControlPipelineAudit(structuralControlAudit); err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков изменилась до запуска сверки")
		return
	}
	if err := p.runStage("R005", r005Command, nil, runDir, adapter.Root); err != nil {
		if packageErr := validateR005ReportOnlyPackage(r005Dir, contextValue, true); packageErr != nil {
			finish(RunFailed, "R005", "Сверка завершилась ошибкой; безопасный отчётный комплект не сформирован")
			return
		}
	}
	if !regularFile(r005Report) || !regularFile(r005Codex) {
		finish(RunFailed, "R005", "Сверка не создала обязательный отчётный комплект")
		return
	}
	if err := validateR005ReportOnlyPackage(r005Dir, contextValue, false); err != nil {
		finish(RunFailed, "R005", "Сверка создала неполный или небезопасный отчётный комплект")
		return
	}
	if err := p.anchorStructuralControlInventory(run, contextValue, r005Dir); err != nil {
		finish(RunBlockedStructuralInventory, "R005_INVENTORY", "Проверенный состав верхних блоков R005 недоступен; правила не запускались")
		return
	}
	structuralControlProofPath, _, err := materializeStructuralControlProof(run, contextValue, runDir, r005Codex)
	if err != nil {
		finish(RunFailed, "R005_PROOF", "R005 не подтвердил применённую настройку группировки блоков")
		return
	}

	rulesRegistrySnapshot, rulesRegistryBaseHash, err := rulesRegistry.snapshot(run.ID, "initial")
	if err != nil {
		finish(RunFailed, "RULES", "Не удалось подготовить проверенный снимок реестра правил")
		return
	}
	rulesContextPath := filepath.Join(runDir, "rules_engine_context.json")
	if err := writeRulesContext(rulesContextPath, run, contextValue, rulesRegistrySnapshot, r005Report, r005Codex,
		structuralControlProofPath, rulesDir, handoffDir); err != nil {
		finish(RunFailed, "RULES", "Не удалось подготовить контекст движка правил")
		return
	}
	if !p.updateStage(&run, "RULES") {
		return
	}
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, r005Codex, structuralControlProofPath); err != nil {
		finish(RunFailed, "R005_PROOF", "Доказательство настройки группировки блоков изменилось до Rules")
		return
	}
	rulesCommand := []string{adapter.Node, adapter.RulesScript, "run", "--context", rulesContextPath, "--out", rulesDir}
	if err := p.runStage("RULES", rulesCommand, nil, runDir, adapter.Root); err != nil {
		finish(RunFailed, "RULES", "Движок правил завершился ошибкой; технические детали сохранены в журнале запуска")
		return
	}
	workflow, err := readValidatedRulesWorkflow(rulesDir, run.ID, "initial")
	if err != nil {
		finish(RunFailed, "RULES", "Движок правил не создал обязательное решение workflow")
		return
	}
	if workflow.NextAction == "FAILED" || workflow.NextAction == "FAILED_NO_STATE_CHANGE" {
		finish(RunFailed, "RULES", "Workflow движка правил остановлен fail-closed")
		return
	}
	if _, err := rulesRegistry.mergeEngineOutput(run.ID, "initial", rulesDir, rulesRegistryBaseHash); err != nil {
		finish(RunFailed, "RULES", "Результат движка правил не прошёл безопасное сохранение в библиотеку")
		return
	}

	switch workflow.NextAction {
	case "WAIT_USER_RULES":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir, r005Report, r005Codex, r001Dir,
			"RULES", "WAIT_USER_RULES", "Найдены предложения правил; требуется решение пользователя"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Правила требуют решения пользователя; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunWaitingUserRules, "RULES_REVIEW", "Найдены предложения правил; сформирован безопасный диагностический комплект без проводок")
		return
	case "RERUN_R005":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir, r005Report, r005Codex, r001Dir,
			"RULES", "RERUN_R005", "Правила требуют повторной сверки R005"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Требуется повторная сверка R005; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunWaitingUserRules, "RULES_REVIEW", "Правила требуют повторной сверки R005; сформирован безопасный диагностический комплект без проводок")
		return
	case "COMPLETE":
		if err := p.runDiagnosticR001Package(adapter, run, contextValue, runDir, r005Report, r005Codex, r001Dir,
			"RULES", "COMPLETE_NO_R001", "Корректировки R001 не требуются"); err != nil {
			finish(RunFailed, "R001_DIAGNOSTIC", "Корректировки не требуются; диагностический комплект R001 не сформирован")
			return
		}
		finish(RunCompletedReportOnly, "DONE", "Сверка и проверка правил завершены; сформирован нулевой диагностический комплект без проводок")
		return
	case "PASS_TO_R001", "RERUN_R001":
		// Continue below only with an explicit, existing handoff file.
	default:
		finish(RunFailed, "RULES", "Движок правил вернул неподдерживаемое действие")
		return
	}

	handoffPath := strings.TrimSpace(workflow.Handoff.HandoffPath)
	if workflow.Handoff.Target != "R001" || handoffPath == "" || !regularFile(handoffPath) {
		finish(RunFailed, "RULES", "Передача в R001 не подтверждена обязательным handoff-файлом")
		return
	}
	if err := verifyStructuralControlProofHandoff(handoffPath, run, contextValue, r005Codex, structuralControlProofPath); err != nil {
		finish(RunFailed, "RULES", "Rules передал в R001 другое доказательство настройки группировки блоков")
		return
	}
	if err := resetR001OutputDirectory(runDir, r001Dir); err != nil {
		finish(RunFailed, "R001", "Не удалось подготовить отдельный финальный комплект R001")
		return
	}
	if !p.updateStage(&run, "R001") {
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
	packageErr := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue)
	if packageErr != nil {
		finish(RunFailed, "R001", "R001 не сформировал полный безопасный диагностический комплект")
		return
	}
	blockerStatus := "PASS_R001"
	blockerMessage := "R001 сформировал безопасный отчётный комплект"
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
	finish(RunCompletedReportOnly, "DONE", "Сверка, правила и диагностический комплект R001 завершены; запись в 1С не выполнялась")
}

func (p *Pipeline) updateStage(run *Run, stage string) bool {
	run.Status = RunRunning
	run.Stage = stage
	run.Message = stageMessage(stage)
	return p.store.UpdateRun(*run) == nil
}

func stageMessage(stage string) string {
	switch stage {
	case "R005":
		return "Выполняется сверка ERP и Инталев"
	case "R005_INVENTORY":
		return "Проверяется состав верхних блоков"
	case "RULES":
		return "Проверяются правила"
	case "R001":
		return "Формируется черновик корректировок"
	default:
		return "Выполняется отчётный этап"
	}
}

func expandCommand(command []string, values map[string]string) []string {
	expanded := make([]string, len(command))
	for index, value := range command {
		for placeholder, replacement := range values {
			value = strings.ReplaceAll(value, placeholder, replacement)
		}
		expanded[index] = value
	}
	return expanded
}

func (p *Pipeline) runStage(stage string, command []string, values map[string]string, runDir, runtimeRoot string) error {
	if p.runner != nil {
		return p.runner(stage, command, values, runDir, runtimeRoot)
	}
	return runStage(stage, command, values, runDir, runtimeRoot)
}

func runStage(stage string, template []string, values map[string]string, runDir, runtimeRoot string) error {
	command := template
	if values != nil {
		command = expandCommand(template, values)
	}
	if len(command) == 0 {
		return errors.New("empty command")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	process := exec.CommandContext(ctx, command[0], command[1:]...)
	process.Dir = runDir
	if runtimeRoot != "" && len(command) > 1 {
		scriptDir := filepath.Dir(command[1])
		if info, statErr := os.Stat(scriptDir); statErr == nil && info.IsDir() {
			process.Dir = scriptDir
		}
	}
	process.Env = append(os.Environ(),
		"OPIU_MODE=REPORT_ONLY",
		"OPIU_POSTING_ROWS=0",
		"OPIU_READY_TO_UPLOAD=false",
		"OPIU_RELEASE_ALLOWED=false",
		"OPIU_LIVE_1C_ALLOWED=false",
	)
	if runtimeRoot != "" {
		process.Env = append(process.Env, "OPIU_RUNTIME_ROOT="+runtimeRoot)
	}
	logPath := filepath.Join(runDir, strings.ToLower(stage)+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	limited := &limitedWriter{writer: logFile, remaining: 8 << 20}
	process.Stdout = limited
	process.Stderr = limited
	if err := process.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%s timed out: %w", stage, ctx.Err())
		}
		return err
	}
	return logFile.Sync()
}

type limitedWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	original := len(data)
	if w.remaining <= 0 {
		return original, nil
	}
	if int64(len(data)) > w.remaining {
		data = data[:w.remaining]
	}
	written, err := w.writer.Write(data)
	w.remaining -= int64(written)
	if err != nil {
		return written, err
	}
	return original, nil
}
