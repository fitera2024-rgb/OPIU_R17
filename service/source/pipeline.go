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
	store    *Store
	commands map[string][]string
	runtime  *RuntimeAdapter
	runner   pipelineStageRunner
	mu       sync.Mutex
	active   map[string]struct{}
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
	if len(commands) == 0 {
		adapter, err := discoverRuntimeAdapter()
		if err != nil {
			return nil, err
		}
		runtimeAdapter = adapter
	} else if len(commands) != 2 {
		return nil, errors.New("both direct R005 and R001 external engine adapter commands are required")
	}
	if len(commands) == 2 {
		if err := requireExternalR005ScopePlaceholders(commands["R005"]); err != nil {
			return nil, err
		}
		if err := requireExternalR001HandoffPlaceholders(commands["R001"]); err != nil {
			return nil, err
		}
	}

	catalogPath := ""
	if runtimeAdapter != nil {
		catalogPath = filepath.Join(runtimeAdapter.Root, "data", "defaults", "organizations.json")
	} else if len(commands) == 2 {
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
		store:    store,
		commands: commands,
		runtime:  runtimeAdapter,
		runner:   runStage,
		active:   map[string]struct{}{},
	}, nil
}

func requireExternalR001HandoffPlaceholders(command []string) error {
	positions := map[string]int{}
	for index, argument := range command {
		for _, forbidden := range []string{"--decisions", "--rules", "--applications", "--reconciliation", "--codex-input", "--period", "--organization", "--run-id", "--organization-id"} {
			if argument == forbidden || strings.HasPrefix(argument, forbidden+"=") {
				return fmt.Errorf("OPIU_R001_CMD_JSON contains forbidden direct source override %s", forbidden)
			}
		}
		if argument == "--handoff" || argument == "--handoff-sha256" {
			if _, duplicate := positions[argument]; duplicate {
				return fmt.Errorf("OPIU_R001_CMD_JSON repeats immutable Service argument %s", argument)
			}
			positions[argument] = index
		}
	}
	for flag, placeholder := range map[string]string{"--handoff": "{handoff}", "--handoff-sha256": "{handoff_sha256}"} {
		index, found := positions[flag]
		if !found || index+1 >= len(command) || command[index+1] != placeholder {
			return fmt.Errorf("OPIU_R001_CMD_JSON must contain exact pair %s %s", flag, placeholder)
		}
	}
	return nil
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
	return len(p.commands["R005"]) > 0 && len(p.commands["R001"]) > 0
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
	articleApprovalSettingsPath, err := p.materializeActiveArticleApprovalSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Утверждённые статьи недоступны или повреждены")
		return
	}
	structuralControlSettingsPath, structuralControlAudit, err := p.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", structuralControlSettingsFailureMessage(err))
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
	r005Command := appendEmptyArticleBindingSettingsArgument(p.commands["R005"], emptyArticleBindingSettingsPath)
	r005Command = appendArticleApprovalSettingsArgument(r005Command, articleApprovalSettingsPath)
	r005Command, err = appendStructuralControlAuthorityArguments(r005Command, structuralControlAudit, structuralControlSettingsPath)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Команда сверки содержит неоднозначный источник настройки группировки блоков")
		return
	}
	r005Command = appendStructuralControlScopeArguments(r005Command)
	if !p.updateStage(&run, "R005") {
		return
	}
	if err := p.verifyStructuralControlPipelineAudit(structuralControlAudit); err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков изменилась до запуска сверки")
		return
	}
	if err := p.runStage("R005", r005Command, values, runDir, ""); err != nil {
		finish(RunFailed, "R005", r005StageFailureMessage(runDir))
		return
	}
	r005Dir := filepath.Join(runDir, "r005")
	r005Codex := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	if err := validateR005ReportOnlyPackage(r005Dir, contextValue, false); err != nil {
		finish(RunFailed, "R005", "Сверка создала неполный или небезопасный отчётный комплект")
		return
	}
	if err := p.anchorStructuralControlInventory(run, contextValue, r005Dir); err != nil {
		finish(RunBlockedStructuralInventory, "R005_INVENTORY", "Проверенный состав верхних блоков R005 недоступен")
		return
	}
	if _, _, err = materializeStructuralControlProof(run, contextValue, runDir, r005Codex); err != nil {
		finish(RunFailed, "R005_PROOF", "R005 не подтвердил применённую настройку группировки блоков")
		return
	}
	handoff, err := materializeServiceR001Handoff(run, contextValue, runDir, erpPath, intalevPath)
	if err != nil {
		finish(RunFailed, "R005_HANDOFF", "Service не создал точную неизменяемую передачу R005→R001")
		return
	}
	if _, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir); err != nil {
		finish(RunFailed, "R005_HANDOFF", "Неизменяемая передача R005→R001 не прошла повторную проверку")
		return
	}
	values["{handoff}"] = handoff.Path
	values["{handoff_sha256}"] = handoff.SHA256
	if err := resetR001OutputDirectory(runDir, filepath.Join(runDir, "r001")); err != nil {
		finish(RunFailed, "R001", "Не удалось подготовить отдельный финальный комплект R001")
		return
	}
	if !p.updateStage(&run, "R001") {
		return
	}
	if err := p.runStage("R001", p.commands["R001"], values, runDir, ""); err != nil {
		finish(RunFailed, "R001", r001FailureMessage(err, nil))
		return
	}
	if err := validateR001ReportOnlyPackageForRun(filepath.Join(runDir, "r001"), run, contextValue); err != nil {
		finish(RunFailed, "R001", r001FailureMessage(nil, err))
		return
	}
	finish(RunCompletedReportOnly, "DONE", "Отчётный запуск завершён; запись в 1С не выполнялась")
}

func (p *Pipeline) executeRuntime(run Run, contextValue Context, erpPath, erpSHA256, intalevPath, runDir string, finish func(RunStatus, string, string)) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Для сверки не определена точная организация")
		return
	}
	adapter := p.runtime
	mode, err := periodMode(contextValue.Period)
	if err != nil {
		finish(RunBlockedInvalidContext, "PREFLIGHT", "Период контекста не поддерживается")
		return
	}

	r005Dir := filepath.Join(runDir, "r005")
	r001Dir := filepath.Join(runDir, "r001")
	for _, directory := range []string{r005Dir, filepath.Join(runDir, "handoff"), r001Dir} {
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
	articleApprovalSettingsPath, err := p.materializeActiveArticleApprovalSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Утверждённые статьи недоступны или повреждены")
		return
	}
	structuralControlSettingsPath, structuralControlAudit, err := p.materializeActiveStructuralControlSettings(run, contextValue, runDir)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", structuralControlSettingsFailureMessage(err))
		return
	}
	var packagedStructuralControlSettingsPath string
	packagedStructuralControlSettingsPath, structuralControlAudit, err = materializePackagedStructuralControlSettings(
		run, contextValue, runDir,
		packagedStructuralControlSettingsCSV(adapter.Root), adapter.Node, adapter.R005Script,
		structuralControlAudit,
	)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Пакетная настройка группировки блоков недоступна или повреждена")
		return
	}
	if packagedStructuralControlSettingsPath != "" {
		structuralControlSettingsPath = packagedStructuralControlSettingsPath
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
	r005Command = appendArticleApprovalSettingsArgument(r005Command, articleApprovalSettingsPath)
	r005Command, err = appendStructuralControlAuthorityArguments(r005Command, structuralControlAudit, structuralControlSettingsPath)
	if err != nil {
		finish(RunFailed, "R005_SETTINGS", "Команда сверки содержит неоднозначный источник настройки группировки блоков")
		return
	}
	if !p.updateStage(&run, "R005") {
		return
	}
	if err := p.verifyStructuralControlPipelineAudit(structuralControlAudit); err != nil {
		finish(RunFailed, "R005_SETTINGS", "Настройка группировки блоков изменилась до запуска сверки")
		return
	}
	if err := p.runStage("R005", r005Command, nil, runDir, adapter.Root); err != nil {
		if packageErr := validateR005ReportOnlyPackage(r005Dir, contextValue, true); packageErr != nil {
			finish(RunFailed, "R005", r005StageFailureMessage(runDir))
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

	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, r005Codex, structuralControlProofPath); err != nil {
		finish(RunFailed, "R005_PROOF", "Доказательство настройки группировки блоков изменилось после R005")
		return
	}
	handoff, err := materializeServiceR001Handoff(run, contextValue, runDir, erpPath, intalevPath)
	if err != nil {
		finish(RunFailed, "R005_HANDOFF", "Service не создал точную неизменяемую передачу R005→R001")
		return
	}
	if _, err := verifyServiceR001Handoff(handoff.Path, handoff.SHA256, run, contextValue, runDir); err != nil {
		finish(RunFailed, "R005_HANDOFF", "Неизменяемая передача R005→R001 не прошла повторную проверку")
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
		"--handoff", handoff.Path,
		"--handoff-sha256", handoff.SHA256,
		"--output", r001Dir,
	}
	r001Err := p.runStage("R001", r001Command, nil, runDir, adapter.Root)
	packageErr := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue)
	if packageErr != nil {
		finish(RunFailed, "R001", r001FailureMessage(r001Err, packageErr))
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
		finish(RunFailed, "R001", r001FailureMessage(r001Err, nil)+"; диагностический комплект доступен, запись в 1С не выполнялась")
		return
	}
	finish(RunCompletedReportOnly, "DONE", "Сверка R005 и диагностический комплект R001 завершены напрямую; запись в 1С не выполнялась")
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

func structuralControlSettingsFailureMessage(err error) string {
	const prefix = "Настройка группировки блоков не прошла проверку: "
	if err == nil {
		return prefix + "причина не определена"
	}
	known := []struct {
		needle  string
		message string
	}{
		{"structural inventory Codex input does not bind exact report", "файл доказательств Codex не связан с точным отчётом"},
		{"structural inventory manifest does not bind exact Codex input", "манифест не связан с точным файлом доказательств Codex"},
		{"structural inventory current-run JSON scope does not match", "организация, период или отчёт в доказательствах не совпадают"},
		{"structural inventory embedded plan cross-link does not match", "встроенный план группировки не совпадает с подтверждённым инвентарём"},
		{"structural inventory current-run artifact digest mismatch", "контрольная сумма файла доказательств не совпадает"},
		{"structural inventory current-run provenance digest mismatch", "контрольная сумма происхождения запуска не совпадает"},
		{"structural inventory member digest mismatch", "состав статей группы изменён"},
		{"STRUCTURAL_CONTROL_INVENTORY_STALE", "подтверждённый инвентарь был изменён"},
		{"STRUCTURAL_CONTROL_INVENTORY_UNAVAILABLE", "подтверждённый инвентарь отсутствует"},
		{"STRUCTURAL_CONTROL_RUN_MISMATCH", "исходный запуск группировки не совпадает"},
	}
	text := err.Error()
	for _, item := range known {
		if strings.Contains(text, item.needle) {
			return prefix + item.message
		}
	}
	return prefix + "целостность подтверждённых данных не доказана"
}

func r005StageFailureMessage(runDir string) string {
	const generic = "Сверка завершилась ошибкой; безопасный отчётный комплект не сформирован"
	logPath := filepath.Join(runDir, "r005.log")
	info, err := os.Lstat(logPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 8<<20 {
		return generic
	}
	payload, err := os.ReadFile(logPath)
	if err != nil {
		return generic
	}
	logText := string(payload)
	known := []struct {
		code    string
		message string
	}{
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_SOURCE_INVALID", "R005 отклонил настройку группировки: формат источника не поддерживается"},
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_CSV_HEADERS_INVALID", "R005 отклонил настройку группировки: заголовки файла не соответствуют его формату"},
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_DOCUMENT_SOURCE_BINDING_MISMATCH", "R005 отклонил настройку группировки: выбранные пути не совпадают с подтверждёнными настройками"},
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_SOURCE_DRIFT", "R005 отклонил настройку группировки: исходный файл был изменён"},
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_RUN_SCOPE_MISMATCH", "R005 отклонил настройку группировки: организация или период не совпадают"},
		{"BLOCKED_STRUCTURAL_CONTROL_SETTINGS_GROUP_CONFIG_INVALID", "R005 отклонил настройку группировки: состав группы не прошёл проверку"},
	}
	for _, item := range known {
		if strings.Contains(logText, item.code) {
			return item.message
		}
	}
	if strings.Contains(logText, "BLOCKED_STRUCTURAL_CONTROL_SETTINGS_") {
		return "R005 отклонил настройку группировки: целостность подтверждённых данных не доказана"
	}
	return generic
}

func r001FailureMessage(processErr, packageErr error) string {
	reasons := make([]string, 0, 2)
	if processErr != nil {
		reasons = append(reasons, r001ProcessFailureReason(processErr))
	}
	if packageErr != nil {
		reasons = append(reasons, r001PackageFailureReason(packageErr))
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "причина не определена; подробности сохранены в диагностике запуска")
	}
	return "R001 не сформирован: " + strings.Join(reasons, "; ")
}

func r001ProcessFailureReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(err.Error()), "timed out") {
		return "превышен тайм-аут этапа R001"
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Sprintf("процесс R001 завершился с ненулевым кодом %d", exitErr.ExitCode())
	}
	if reason := safeR001DiagnosticReason(err.Error()); reason != "" {
		return reason
	}
	return "процесс R001 завершился ошибкой; подробности сохранены в журнале запуска"
}

func r001PackageFailureReason(err error) string {
	text := strings.ToLower(err.Error())
	known := []struct {
		needle string
		reason string
	}{
		{"expected one r001 technical manifest", "обязательный манифест R001 отсутствует или неоднозначен"},
		{"read r001 manifest", "манифест R001 повреждён или нечитаем"},
		{"manifest schema is not accepted", "схема манифеста R001 не поддерживается"},
		{"unsafe r001 manifest", "манифест R001 нарушает ограничения REPORT_ONLY"},
		{"route counts", "контрольные счётчики R001 отсутствуют или противоречат друг другу"},
		{"output registry is empty", "реестр выходных файлов R001 пуст"},
		{"unsafe r001 output path", "реестр R001 содержит небезопасный путь"},
		{"registered r001 artifact is missing", "зарегистрированный файл R001 отсутствует"},
		{"registered r001 workbook is invalid", "зарегистрированный файл R001 повреждён"},
		{"artifact hash mismatch", "контрольная сумма файла R001 не совпадает"},
		{"diagnostic workbook, registry or reconciliation is missing", "обязательный диагностический файл R001 отсутствует"},
		{"canonical output integrity", "целостность канонического выхода R001 не доказана"},
		{"escaped exact run or period scope", "комплект R001 не соответствует точному запуску или месяцу"},
		{"exact reconciliation source", "комплект R001 не связан с точной сверкой R005"},
		{"reconciliation source hash", "комплект R001 ссылается на изменённую сверку R005"},
		{"mandatory service handoff", "комплект R001 не содержит обязательную передачу Service"},
		{"handoff escaped the exact current run", "передача R005→R001 относится к другому запуску"},
		{"handoff hash", "контрольная сумма передачи R005→R001 не совпадает"},
		{"service handoff is invalid", "передача R005→R001 не прошла проверку целостности"},
	}
	for _, item := range known {
		if strings.Contains(text, item.needle) {
			return item.reason
		}
	}
	return "выходной комплект R001 не прошёл проверку целостности"
}

func safeR001DiagnosticReason(text string) string {
	allowed := map[string]string{
		"FORCED_R001_FAILURE_AFTER_VALID_R005": "принудительная проверочная ошибка после успешной R005",
	}
	for _, token := range strings.FieldsFunc(text, func(value rune) bool {
		return !((value >= 'A' && value <= 'Z') || (value >= '0' && value <= '9') || value == '_')
	}) {
		if reason, ok := allowed[token]; ok {
			return reason
		}
	}
	return ""
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
