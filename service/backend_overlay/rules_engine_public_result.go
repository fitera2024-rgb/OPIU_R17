package main

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type rulesEngineCandidateRevisionContextV194 struct {
	RunID            string
	OrganizationID   string
	OrganizationName string
	OrganizationPath string
	Period           string
	RulesExecutionID string
}

func rulesEngineCandidateRevisionV194(candidate map[string]any, context rulesEngineCandidateRevisionContextV194) string {
	candidateID := strings.TrimSpace(asString(candidate["candidate_id"]))
	sourceHash := strings.TrimSpace(asString(candidate["source_payload_hash"]))
	if candidateID == "" || sourceHash == "" || context.RunID == "" || context.OrganizationID == "" || context.Period == "" || context.RulesExecutionID == "" {
		return ""
	}
	digest := hashJSON(map[string]any{
		"candidate_id":        candidateID,
		"source_payload_hash": sourceHash,
		"candidate_state":     candidate,
		"run_id":              context.RunID,
		"organization_id":     context.OrganizationID,
		"organization_name":   context.OrganizationName,
		"organization_path":   context.OrganizationPath,
		"period":              context.Period,
		"rules_execution_id":  context.RulesExecutionID,
	})
	return "CRV-" + digest[:32]
}

func sanitizeRulesEngineValueV194(value any, revisionContext rulesEngineCandidateRevisionContextV194) any {
	switch current := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, child := range current {
			switch key {
			case "source", "source_file", "source_sha256", "source_payload_hash", "report_sha256", "codex_input_sha256", "stdout_log", "stderr_log", "technical_error", "handoff":
				continue
			}
			out[key] = sanitizeRulesEngineValueV194(child, revisionContext)
		}
		if asString(current["kind"]) == "candidate" || strings.TrimSpace(asString(current["candidate_id"])) != "" {
			if revision := rulesEngineCandidateRevisionV194(current, revisionContext); revision != "" {
				out["candidate_revision_id"] = revision
			}
		}
		kind := strings.ToLower(strings.TrimSpace(asString(current["kind"])))
		if kind == "issue" || kind == "engine_error" {
			out["message"] = "Обработка не завершена. Подробности записаны в журнале поддержки."
		}
		return out
	case []any:
		out := make([]any, 0, len(current))
		for _, child := range current {
			out = append(out, sanitizeRulesEngineValueV194(child, revisionContext))
		}
		return out
	default:
		return value
	}
}

func rulesRegistryLocalPathV194(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && (filepath.IsAbs(trimmed) || filepath.VolumeName(trimmed) != "" || strings.HasPrefix(trimmed, `\\`) || strings.HasPrefix(strings.ToLower(trimmed), "file://"))
}

func rulesRegistryPublicStringV194(value any) string {
	text := strings.TrimSpace(asString(value))
	if rulesRegistryLocalPathV194(text) {
		return ""
	}
	return text
}

func rulesRegistryPublicStringListV194(value any) []any {
	out := []any{}
	for _, raw := range anySlice(value) {
		if item := rulesRegistryPublicStringV194(raw); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func rulesRegistryPublicMappingSideV194(value any) map[string]any {
	side, _ := value.(map[string]any)
	if side == nil {
		return map[string]any{}
	}
	return map[string]any{
		"block": rulesRegistryPublicStringV194(side["block"]), "code": rulesRegistryPublicStringV194(side["code"]),
		"article": rulesRegistryPublicStringV194(side["article"]), "path": rulesRegistryPublicStringV194(side["path"]),
		"uuid": rulesRegistryPublicStringV194(side["uuid"]), "side": rulesRegistryPublicStringV194(side["side"]),
		"account": rulesRegistryPublicStringV194(side["account"]),
	}
}

func rulesRegistryPublicMappingV194(value any) map[string]any {
	mapping, _ := value.(map[string]any)
	if mapping == nil {
		return map[string]any{}
	}
	accounting, _ := mapping["accounting"].(map[string]any)
	selection, _ := mapping["account_selection"].(map[string]any)
	return map[string]any{
		"intalev_source":     rulesRegistryPublicMappingSideV194(mapping["intalev_source"]),
		"intalev_target":     rulesRegistryPublicMappingSideV194(mapping["intalev_target"]),
		"erp_source":         rulesRegistryPublicMappingSideV194(mapping["erp_source"]),
		"erp_target":         rulesRegistryPublicMappingSideV194(mapping["erp_target"]),
		"opiu_block":         rulesRegistryPublicStringV194(mapping["opiu_block"]),
		"candidate_articles": rulesRegistryPublicStringListV194(mapping["candidate_articles"]),
		"source_rows":        rulesRegistryPublicStringListV194(mapping["source_rows"]),
		"account_selection":  copyPublicFieldsV194(selection, "catalog_version_id", "debit_account_id", "credit_account_id"),
		"accounting": copyPublicFieldsV194(accounting,
			"intalev_debit_account", "intalev_credit_account", "intalev_account_status",
			"erp_debit_account", "erp_credit_account", "debit_account", "credit_account",
			"debit_analytics", "credit_analytics", "department", "cfo", "note"),
	}
}

func rulesRegistryPublicRuleV194(value any) map[string]any {
	rule, _ := value.(map[string]any)
	if rule == nil {
		return map[string]any{}
	}
	public := copyPublicFieldsV194(rule,
		"rule_id", "origin_rule_id", "revision_id", "name", "description", "rule_type", "status", "enabled", "is_current",
		"valid_from_year", "valid_to_year", "action", "condition_text", "author", "created_at", "updated_at", "missing_fields")
	scope, _ := rule["scope"].(map[string]any)
	public["scope"] = copyPublicFieldsV194(scope,
		"scope_type", "node_id", "node_name", "hierarchy_path", "include_descendants", "mapping_status", "organization_id", "organization_name", "period")
	public["mapping"] = rulesRegistryPublicMappingV194(rule["mapping"])
	source, _ := rule["source"].(map[string]any)
	hasFile := strings.TrimSpace(asString(source["source_file"])) != "" || strings.TrimSpace(asString(source["file"])) != "" || strings.TrimSpace(asString(source["path"])) != ""
	sourceRow := rulesRegistryPublicStringV194(source["source_row"])
	if sourceRow == "" {
		sourceRow = rulesRegistryPublicStringV194(source["row"])
	}
	public["source"] = map[string]any{"source_bound": hasFile && sourceRow != "", "source_row": sourceRow}
	return public
}

func rulesRegistryPublicRulesV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, rulesRegistryPublicRuleV194(value))
	}
	return out
}

func rulesRegistryPublicApplicationsV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, raw := range values {
		application, _ := raw.(map[string]any)
		if application != nil {
			out = append(out, copyPublicFieldsV194(application,
				"application_id", "rule_id", "revision_id", "run_id", "node_id", "node_name", "hierarchy_path", "period",
				"amount", "currency", "result_type", "result_status", "decision", "evidence_status", "comment", "created_at", "created_by"))
		}
	}
	return out
}

func rulesRegistryPublicApprovalsV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, raw := range values {
		approval, _ := raw.(map[string]any)
		if approval != nil {
			out = append(out, copyPublicFieldsV194(approval,
				"approval_id", "rule_id", "revision_id", "node_id", "node_name", "hierarchy_path", "scope_type",
				"include_descendants", "decision", "approved_by", "approved_at", "comment"))
		}
	}
	return out
}

func instructionsPublicItemV194(value any) map[string]any {
	item, _ := value.(map[string]any)
	if item == nil {
		return map[string]any{}
	}
	return copyPublicFieldsV194(item,
		"instruction_id", "title", "description", "status", "author", "comment",
		"current_version", "display_version", "origin", "immutable", "updated_at")
}

func instructionsPublicItemsV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, instructionsPublicItemV194(value))
	}
	return out
}

func materialsPublicItemV194(value any) map[string]any {
	item, _ := value.(map[string]any)
	if item == nil {
		return map[string]any{}
	}
	materialID := strings.TrimSpace(asString(item["material_id"]))
	kind := strings.TrimSpace(asString(item["kind"]))
	if materialID == "" || safeID(materialID) != materialID || (kind != "local_file" && kind != "external_link") {
		return map[string]any{}
	}
	public := map[string]any{
		"material_id": materialID,
		"title":       strings.TrimSpace(asString(item["title"])),
		"description": strings.TrimSpace(asString(item["description"])),
		"kind":        kind,
	}
	if kind == "external_link" {
		if publicURL := materialPublicHTTPURLV194(item["url"]); publicURL != "" {
			public["url"] = publicURL
		}
	}
	return public
}

func materialsPublicItemsV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		if item := materialsPublicItemV194(value); len(item) > 0 {
			out = append(out, item)
		}
	}
	return out
}

func materialPublicHTTPURLV194(value any) string {
	raw := strings.TrimSpace(asString(value))
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	return raw
}

func eventPublicLabelV194(eventType string) string {
	upper := strings.ToUpper(strings.TrimSpace(eventType))
	switch {
	case strings.Contains(upper, "FAILED"), strings.Contains(upper, "BLOCKED"), strings.Contains(upper, "ERROR"):
		return "Операция не завершена"
	case strings.Contains(upper, "FILE_UPLOADED"):
		return "Файл загружен"
	case strings.Contains(upper, "SETTINGS_UPDATED"):
		return "Настройки обновлены"
	case strings.Contains(upper, "RULE_PACK_IMPORTED"):
		return "Пакет правил импортирован"
	case strings.Contains(upper, "RULE_PACK_EXPORTED"):
		return "Пакет правил сформирован"
	case strings.Contains(upper, "RULE") && strings.Contains(upper, "SAVED"):
		return "Правило сохранено"
	case strings.Contains(upper, "RULES_DECISION"):
		return "Решение по правилам сохранено"
	case strings.Contains(upper, "INSTRUCTION") && strings.Contains(upper, "PUBLISHED"):
		return "Инструкция опубликована"
	case strings.Contains(upper, "INSTRUCTION"):
		return "Инструкция обновлена"
	case strings.Contains(upper, "ENGINE") && strings.Contains(upper, "COMPLETED"):
		return "Обработка завершена"
	case strings.Contains(upper, "ENGINE"), strings.Contains(upper, "MODULE_UI"):
		return "Движок запущен"
	default:
		return "Событие сервиса"
	}
}

func eventsPublicItemsV194(values []any) []any {
	out := make([]any, 0, len(values))
	for _, raw := range values {
		event, _ := raw.(map[string]any)
		if event == nil {
			continue
		}
		out = append(out, map[string]any{
			"timestamp": event["timestamp"],
			"label":     eventPublicLabelV194(asString(event["type"])),
		})
	}
	return out
}

func rulesEnginePublicPrepareV194(result map[string]any) map[string]any {
	return map[string]any{
		"ok": result["ok"], "run_id": result["run_id"], "phase": result["phase"], "rules_execution_id": result["rules_execution_id"],
		"safety": map[string]any{
			"report_only": true, "posting_rows": 0, "ready_to_upload": false,
			"release_allowed": false, "live_1c_allowed": false,
		},
	}
}

func enginePublicPrepareV194(result map[string]any) map[string]any {
	return map[string]any{
		"ok": result["ok"], "run_id": result["run_id"], "rules_count": result["rules_count"],
		"organization_auto_matched": result["organization_auto_matched"], "organization_id": result["organization_id"], "organization_name": result["organization_name"],
		"safety": map[string]any{
			"report_only": true, "posting_rows": 0, "ready_to_upload": false,
			"release_allowed": false, "live_1c_allowed": false,
		},
	}
}

func enginePublicOpenV194(prepared map[string]any, ready bool, message string) map[string]any {
	return map[string]any{
		"ok": true, "ui_ready": ready, "run_id": prepared["run_id"], "message": message,
		"organization_auto_matched": prepared["organization_auto_matched"], "organization_id": prepared["organization_id"], "organization_name": prepared["organization_name"],
		"posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
	}
}

func rulesEnginePublicResultV194(result map[string]any, revisionContext rulesEngineCandidateRevisionContextV194) map[string]any {
	public := map[string]any{
		"ok":                       result["ok"],
		"run_id":                   result["run_id"],
		"rules_execution_id":       result["rules_execution_id"],
		"stage":                    result["stage"],
		"next_action":              result["next_action"],
		"counts":                   result["counts"],
		"category_labels":          result["category_labels"],
		"categories":               sanitizeRulesEngineValueV194(result["categories"], revisionContext),
		"decision_rows":            sanitizeRulesEngineValueV194(result["decision_rows"], revisionContext),
		"unassigned_evidence_rows": sanitizeRulesEngineValueV194(result["unassigned_evidence_rows"], revisionContext),
		"safety": map[string]any{
			"report_only": true, "posting_rows": 0, "ready_to_upload": false,
			"release_allowed": false, "live_1c_allowed": false,
		},
	}
	if execution, ok := result["execution"].(map[string]any); ok {
		public["execution"] = map[string]any{
			"status": execution["status"], "started_at": execution["started_at"], "finished_at": execution["finished_at"],
		}
	}
	if workflow, ok := result["workflow"].(map[string]any); ok {
		public["workflow"] = map[string]any{
			"next_action": workflow["next_action"], "reasons": workflow["reasons"],
			"required_user_actions":     workflow["required_user_actions"],
			"disputed_draft_count":      workflow["disputed_draft_count"],
			"blocking_unresolved_count": workflow["blocking_unresolved_count"],
		}
	}
	return public
}

func rulesEngineRevisionContextFromRunV194(run map[string]any) (rulesEngineCandidateRevisionContextV194, error) {
	context := rulesEngineCandidateRevisionContextV194{
		RunID:            strings.TrimSpace(asString(run["run_id"])),
		OrganizationID:   strings.TrimSpace(asString(run["organization_id"])),
		OrganizationName: strings.TrimSpace(asString(run["organization_name"])),
		OrganizationPath: strings.TrimSpace(asString(run["organization_path"])),
		Period:           strings.TrimSpace(asString(run["period"])),
		RulesExecutionID: strings.TrimSpace(asString(run["rules_execution_id"])),
	}
	if context.RunID == "" || context.OrganizationID == "" || context.OrganizationName == "" || context.OrganizationPath == "" || context.Period == "" || context.RulesExecutionID == "" {
		return rulesEngineCandidateRevisionContextV194{}, errors.New("RULE_DECISION_CONTEXT_INCOMPLETE")
	}
	return context, nil
}

func rulesEnginePublicResultHasCandidatesV194(result map[string]any) bool {
	if len(anySlice(result["decision_rows"])) > 0 {
		return true
	}
	categories, _ := result["categories"].(map[string]any)
	for _, key := range []string{"effective", "candidates_to_add", "review_required"} {
		if len(anySlice(categories[key])) > 0 {
			return true
		}
	}
	return false
}

func (a *App) publicRulesEngineResultV194(runID string, result map[string]any) (map[string]any, error) {
	run, err := a.rulesEngineRunRecord(runID)
	if err != nil {
		return nil, err
	}
	context, err := rulesEngineRevisionContextFromRunV194(run)
	if err != nil {
		if rulesEnginePublicResultHasCandidatesV194(result) {
			return nil, err
		}
		return rulesEnginePublicResultV194(result, rulesEngineCandidateRevisionContextV194{}), nil
	}
	return rulesEnginePublicResultV194(result, context), nil
}

func writeRulesEnginePublicErrorV194(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": code, "message": message})
}

func (a *App) handleRulesEngineResultV194(w http.ResponseWriter, r *http.Request) {
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
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "RUN_REQUIRED", "message": "Сначала выполните сверку R005."})
		return
	}
	result, err := a.rulesEngineResultV160(runID)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_RESULT_BLOCKED_V194", map[string]any{"run_id": runID, "technical_error": err.Error()})
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "RULES_ENGINE_RESULT_NOT_FOUND", "message": "Для активной сверки результат правил ещё не сформирован."})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": "RULES_ENGINE_RESULT_UNAVAILABLE", "message": "Результат правил пока не готов. Повторите после завершения обработки."})
		return
	}
	public, err := a.publicRulesEngineResultV194(runID, result)
	if err != nil {
		_ = a.logEvent("RULES_ENGINE_PUBLIC_RESULT_CONTEXT_BLOCKED_V194", map[string]any{"run_id": runID, "technical_error": err.Error()})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "RULES_ENGINE_RESULT_UNAVAILABLE", "Результат правил пока не готов. Повторите после завершения обработки.")
		return
	}
	writeJSON(w, http.StatusOK, public)
}
