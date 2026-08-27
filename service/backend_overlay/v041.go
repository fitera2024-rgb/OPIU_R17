package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const rulePackageSchemaV041 = "opiu-rules-package.v1"

func ensureV041Data(root, appRoot string) error {
	data := filepath.Join(root, "data")
	dirs := []string{
		filepath.Join(data, "runs"), filepath.Join(data, "artifacts"),
		filepath.Join(data, "rules", "exports"), filepath.Join(data, "rules", "imports"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	// Seed the ERP hierarchy only once. A user-verified or normalized hierarchy
	// belongs to persistent data and must never be overwritten by an update.
	organizationsTarget := filepath.Join(data, "config", "organizations.json")
	if _, err := os.Stat(organizationsTarget); errors.Is(err, os.ErrNotExist) {
		if err := copyFile(filepath.Join(appRoot, "data", "defaults", "organizations.json"), organizationsTarget); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	for _, pair := range [][2]string{
		{filepath.Join(appRoot, "data", "defaults", "runs.json"), filepath.Join(data, "runs", "index.json")},
		{filepath.Join(appRoot, "data", "defaults", "artifacts.json"), filepath.Join(data, "artifacts", "index.json")},
	} {
		if _, err := os.Stat(pair[1]); errors.Is(err, os.ErrNotExist) {
			if err := copyFile(pair[0], pair[1]); err != nil {
				return err
			}
		}
	}
	if err := migrateSettingsV041(data, appRoot); err != nil {
		return err
	}
	if err := mergeMaterialsV041(data, appRoot); err != nil {
		return err
	}
	if err := mergeInstructionsV041(data, appRoot); err != nil {
		return err
	}
	if err := seedInstructions(root, appRoot); err != nil {
		return err
	}
	if err := migrateRulesV041(data, appRoot); err != nil {
		return err
	}
	return nil
}

func mergeMaterialsV041(data, appRoot string) error {
	path := filepath.Join(data, "config", "materials.json")
	cur := map[string]any{}
	def := map[string]any{}
	_ = readJSON(path, &cur)
	if err := readJSON(filepath.Join(appRoot, "data", "defaults", "materials.json"), &def); err != nil {
		return err
	}
	items := anySlice(cur["items"])
	existing := map[string]bool{}
	for _, raw := range items {
		if m, _ := raw.(map[string]any); m != nil {
			existing[asString(m["material_id"])] = true
		}
	}
	for _, raw := range anySlice(def["items"]) {
		m, _ := raw.(map[string]any)
		if m != nil && !existing[asString(m["material_id"])] {
			items = append(items, m)
		}
	}
	cur["schema_version"] = defaultString(asString(def["schema_version"]), "opiu-materials.v1")
	cur["items"] = items
	return writeJSONAtomic(path, cur)
}

func mergeInstructionsV041(data, appRoot string) error {
	path := filepath.Join(data, "instructions", "instructions.json")
	cur := map[string]any{}
	def := map[string]any{}
	_ = readJSON(path, &cur)
	if err := readJSON(filepath.Join(appRoot, "data", "defaults", "instructions.json"), &def); err != nil {
		return err
	}
	items := anySlice(cur["instructions"])
	existing := map[string]bool{}
	for _, raw := range items {
		if m, _ := raw.(map[string]any); m != nil {
			existing[asString(m["instruction_id"])] = true
		}
	}
	for _, raw := range anySlice(def["instructions"]) {
		m, _ := raw.(map[string]any)
		if m != nil && !existing[asString(m["instruction_id"])] {
			items = append(items, m)
		}
	}
	cur["schema_version"] = defaultString(asString(def["schema_version"]), "opiu-instructions.v1")
	cur["instructions"] = items
	return writeJSONAtomic(path, cur)
}

func migrateSettingsV041(data, appRoot string) error {
	path := filepath.Join(data, "config", "settings.json")
	cur := map[string]any{}
	_ = readJSON(path, &cur)
	def := map[string]any{}
	if err := readJSON(filepath.Join(appRoot, "data", "defaults", "settings.json"), &def); err != nil {
		return err
	}
	for k, v := range def {
		if _, ok := cur[k]; !ok {
			cur[k] = v
		}
	}
	if asString(cur["organization_name"]) == "" {
		cur["organization_name"] = asString(cur["organization"])
	}
	if asString(cur["organization"]) == "" {
		cur["organization"] = asString(cur["organization_name"])
	}
	cur["schema_version"] = "opiu-service-settings.v2"
	cur["visual_version"] = serviceVersion
	if cur["input_roles"] == nil {
		cur["input_roles"] = map[string]any{"intalev": "", "erp": ""}
	}
	if cur["workflow_stage"] == nil {
		cur["workflow_stage"] = "INPUTS_PENDING"
	}
	// 1.9.4 always activates the pre-RUN proof contract at startup. Tests and
	// recovery tools that construct an unmigrated settings document directly keep
	// their historical compatibility path, while every running service is strict.
	cur["source_proof_required"] = true
	return writeJSONAtomic(path, cur)
}

func migrateRulesV041(data, appRoot string) error {
	path := filepath.Join(data, "rules", "rules.json")
	cur := map[string]any{}
	_ = readJSON(path, &cur)
	def := map[string]any{}
	if err := readJSON(filepath.Join(appRoot, "data", "defaults", "rules.json"), &def); err != nil {
		return err
	}
	if asString(cur["schema_version"]) != "opiu-rule-registry.v2" {
		migrated := map[string]any{
			"schema_version": "opiu-rule-registry.v2", "library_id": defaultString(asString(cur["library_id"]), "OPIU-LOCAL-LIBRARY"),
			"rules": []any{}, "revisions": []any{}, "applications": []any{}, "approvals": []any{}, "evidence": []any{}, "updated_at": nowISO(),
		}
		for _, raw := range anySlice(cur["rules"]) {
			old, _ := raw.(map[string]any)
			if old == nil {
				continue
			}
			r := migrateLegacyRuleV041(old)
			migrated["rules"] = append(anySlice(migrated["rules"]), r)
			migrated["revisions"] = append(anySlice(migrated["revisions"]), cloneMap(r))
			for _, ar := range anySlice(old["approvals"]) {
				ap, _ := ar.(map[string]any)
				if ap == nil {
					continue
				}
				migrated["approvals"] = append(anySlice(migrated["approvals"]), map[string]any{
					"approval_id": newID("APPROVAL"), "rule_id": r["rule_id"], "revision_id": r["revision_id"],
					"node_id": "", "node_name": asString(ap["organization"]), "hierarchy_path": asString(ap["organization"]),
					"scope_type": "ORG_ONLY", "include_descendants": false,
					"decision":    map[bool]string{true: "ADOPTED", false: "REJECTED"}[asString(ap["status"]) == "approved"],
					"approved_by": defaultString(asString(ap["approved_by"]), "Пользователь"), "approved_at": defaultString(asString(ap["approved_at"]), nowISO()), "comment": asString(ap["comment"]),
				})
			}
			if app := legacyApplicationV041(old, r); app != nil {
				migrated["applications"] = append(anySlice(migrated["applications"]), app)
			}
		}
		cur = migrated
	}
	// Merge release seed rules without overwriting local current revisions.
	existing := map[string]bool{}
	for _, raw := range anySlice(cur["rules"]) {
		if m, _ := raw.(map[string]any); m != nil {
			existing[asString(m["rule_id"])] = true
		}
	}
	for _, raw := range anySlice(def["rules"]) {
		m, _ := raw.(map[string]any)
		if m == nil || existing[asString(m["rule_id"])] {
			continue
		}
		cur["rules"] = append(anySlice(cur["rules"]), m)
		cur["revisions"] = append(anySlice(cur["revisions"]), cloneMap(m))
		existing[asString(m["rule_id"])] = true
	}
	existingApps := map[string]bool{}
	for _, raw := range anySlice(cur["applications"]) {
		if m, _ := raw.(map[string]any); m != nil {
			existingApps[asString(m["application_id"])] = true
		}
	}
	for _, raw := range anySlice(def["applications"]) {
		if m, _ := raw.(map[string]any); m != nil && !existingApps[asString(m["application_id"])] {
			cur["applications"] = append(anySlice(cur["applications"]), m)
		}
	}
	if cur["approvals"] == nil {
		cur["approvals"] = []any{}
	}
	if cur["revisions"] == nil {
		cur["revisions"] = []any{}
	}
	if cur["applications"] == nil {
		cur["applications"] = []any{}
	}
	if cur["evidence"] == nil {
		cur["evidence"] = []any{}
	}
	upgradeKnownRulePresentationV045(cur)
	cur["schema_version"] = "opiu-rule-registry.v2"
	cur["updated_at"] = nowISO()
	return writeJSONAtomic(path, cur)
}

func upgradeKnownRulePresentationV045(registry map[string]any) {
	for _, key := range []string{"rules", "revisions"} {
		for _, raw := range anySlice(registry[key]) {
			rule, _ := raw.(map[string]any)
			if rule == nil || asString(rule["rule_id"]) != "FEB-OTH-058" {
				continue
			}
			name := asString(rule["name"])
			if name != "R058 — малая дельта февраля" && name != "Прочие внереализационные расходы" {
				continue
			}
			rule["name"] = "Прочие внереализационные расходы"
			rule["description"] = "Строка ОПИУ R058. Решение по расхождению принимается по доказательствам конкретного запуска; сумма не входит в правило."
			rule["condition_text"] = "Сформировать корректировку или принять обоснованное исключение после проверки доказательств текущего запуска."
			mapping, _ := rule["mapping"].(map[string]any)
			if mapping == nil {
				mapping = map[string]any{}
				rule["mapping"] = mapping
			}
			intalev, _ := mapping["intalev_source"].(map[string]any)
			if intalev == nil {
				intalev = map[string]any{}
				mapping["intalev_source"] = intalev
			}
			if strings.TrimSpace(asString(intalev["article"])) == "" {
				intalev["article"] = "Прочие внереализационные расходы"
			}
			if strings.TrimSpace(asString(intalev["block"])) == "" {
				intalev["block"] = "Внереализационные расходы"
			}
			if strings.TrimSpace(asString(intalev["path"])) == "" {
				intalev["path"] = "Внереализационные расходы / Прочие внереализационные расходы"
			}
			erp, _ := mapping["erp_target"].(map[string]any)
			if erp == nil {
				erp = map[string]any{}
				mapping["erp_target"] = erp
			}
			if strings.TrimSpace(asString(erp["article"])) == "" {
				erp["article"] = "Прочие внереализационные расходы"
			}
			if strings.TrimSpace(asString(erp["block"])) == "" {
				erp["block"] = "Статьи ОПиУ 2025"
			}
			if strings.TrimSpace(asString(erp["path"])) == "" {
				erp["path"] = "Статьи ОПиУ 2025 / Прочие внереализационные расходы"
			}
			if strings.TrimSpace(asString(erp["code"])) == "" {
				erp["code"] = "НК0000231"
			}
			if strings.TrimSpace(asString(erp["uuid"])) == "" {
				erp["uuid"] = "a089037a-dde7-11ef-9ecc-005056975dcd"
			}
			mapping["candidate_articles"] = []any{"Прочие внереализационные расходы"}
			rows := anySlice(mapping["source_rows"])
			for _, line := range []string{"R005: строка R058 — Прочие внереализационные расходы", "Классификатор ERP Хабаровск: a089037a-dde7-11ef-9ecc-005056975dcd"} {
				found := false
				for _, existing := range rows {
					if asString(existing) == line {
						found = true
						break
					}
				}
				if !found {
					rows = append(rows, line)
				}
			}
			mapping["source_rows"] = rows
			rule["content_hash"] = ruleSemanticHashV041(rule)
		}
	}
}

func migrateLegacyRuleV041(old map[string]any) map[string]any {
	scopeOld, _ := old["scope"].(map[string]any)
	if scopeOld == nil {
		scopeOld = map[string]any{}
	}
	arts := anySlice(scopeOld["articles"])
	src, tgt := "", ""
	if len(arts) > 0 {
		src = asString(arts[0])
	}
	if len(arts) > 1 {
		tgt = asString(arts[1])
	}
	year := 2025
	for _, k := range []string{"period_from", "period_to"} {
		if s := asString(scopeOld[k]); len(s) >= 4 {
			if n, e := strconv.Atoi(s[:4]); e == nil {
				year = n
				break
			}
		}
	}
	rt := defaultString(asString(old["rule_type"]), "organization")
	status := "DRAFT"
	if asString(old["status"]) == "published" {
		status = "CURRENT"
	}
	if asString(old["status"]) == "imported_review" {
		status = "REVIEW"
	}
	r := map[string]any{
		"rule_id": defaultString(safeID(asString(old["rule_id"])), newID("RULE")), "origin_rule_id": defaultString(safeID(asString(old["origin_rule_id"])), safeID(asString(old["rule_id"]))),
		"revision_id": defaultString(safeID(asString(old["revision_id"])), newID("REV")), "name": asString(old["name"]), "description": asString(old["description"]),
		"rule_type": rt, "status": status, "enabled": asBool(old["enabled"]), "is_current": true,
		"valid_from_year": year, "valid_to_year": nil,
		"scope": map[string]any{"scope_type": map[bool]string{true: "ALL_ORGS", false: "ORG_ONLY"}[rt == "base"], "node_id": "", "node_name": asString(scopeOld["organization"]), "hierarchy_path": asString(scopeOld["organization"]), "include_descendants": false, "mapping_status": "unmatched"},
		"mapping": map[string]any{
			"intalev_source": map[string]any{"code": src, "article": "", "path": ""}, "intalev_target": map[string]any{"code": tgt, "article": "", "path": ""},
			"erp_source": map[string]any{"article": "", "path": "", "account": "", "side": ""}, "erp_target": map[string]any{"article": "", "path": "", "account": "", "side": ""},
			"opiu_block": "", "candidate_articles": []any{}, "source_rows": []any{},
		},
		"action": defaultString(asString(old["action"]), "REVIEW"), "condition_text": asString(old["description"]),
		"author": defaultString(asString(old["author"]), "Пользователь"), "source": old["source"],
		"created_at": defaultString(asString(old["created_at"]), nowISO()), "updated_at": nowISO(),
	}
	normalizeKnownRuleTextV041(r)
	r["content_hash"] = ruleSemanticHashV041(r)
	return r
}

func normalizeKnownRuleTextV041(r map[string]any) {
	texts := map[string][2]string{
		"FEB-ADM-017018":  {"Кандидат парной переклассификации между R017 и R018. Конкретная сумма определяется только в отдельном применении правила.", "Применять после подтверждения прямой связи исходной и целевой статьи."},
		"FEB-PAY-035036":  {"Кандидат парной переклассификации между R035 и R036. Конкретная сумма определяется только в отдельном применении правила.", "Применять после подтверждения прямого источника и целевого соответствия ФЗП."},
		"FEB-OTH-058":     {"Строка ОПИУ R058 — Прочие внереализационные расходы. Сумма не входит в правило.", "Сформировать корректировку или принять обоснованное исключение после проверки доказательств текущего запуска."},
		"FEB-ADM-ZERO":    {"Совместный контроль статей R014 и R015 без самостоятельной корректировки итоговой группы.", "Индивидуальное разнесение применяется только после подтверждения соответствий."},
		"FEB-IT-RESIDUAL": {"Контроль состава ИТ по статьям R020, R021 и R022. Конкретные суммы и состав запуска хранятся в применении.", "Применять после идентификации соответствующих строк ERP и подтверждения аналитик."},
	}
	if pair, ok := texts[asString(r["rule_id"])]; ok {
		r["description"] = pair[0]
		r["condition_text"] = pair[1]
	}
}

func legacyApplicationV041(old, rule map[string]any) map[string]any {
	cond, _ := old["conditions"].(map[string]any)
	if cond == nil {
		return nil
	}
	amounts := map[string]any{}
	for k, v := range cond {
		switch vv := v.(type) {
		case float64:
			amounts[k] = vv
		case int:
			amounts[k] = vv
		case map[string]any:
			n := map[string]any{}
			for kk, x := range vv {
				switch x.(type) {
				case float64, int:
					n[kk] = x
				}
			}
			if len(n) > 0 {
				amounts[k] = n
			}
		}
	}
	if len(amounts) == 0 {
		return nil
	}
	scope, _ := old["scope"].(map[string]any)
	if scope == nil {
		scope = map[string]any{}
	}
	return map[string]any{"application_id": newID("APP"), "rule_id": rule["rule_id"], "revision_id": rule["revision_id"], "run_id": "MIGRATED-0.4.0", "source": "MIGRATION", "node_id": "", "node_name": asString(scope["organization"]), "hierarchy_path": asString(scope["organization"]), "period": asString(scope["period_from"]), "amount": nil, "amount_details": amounts, "currency": "RUB", "result_type": rule["action"], "decision": "PROPOSED", "evidence_status": "MIGRATED", "comment": "Суммы отделены от правила при обновлении.", "created_at": nowISO(), "created_by": "Миграция 0.4.1"}
}

func (a *App) handleBootstrapV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	_ = a.collectActiveRunArtifactsV041()
	settings, reg, orgs, inst, mats, runs, arts, err := a.readAllV041()
	if err != nil {
		_ = a.logEvent("BOOTSTRAP_READ_FAILED_V194", map[string]any{"technical_error": err.Error()})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "BOOTSTRAP_FAILED", "Не удалось загрузить данные сервиса. Передайте журнал в поддержку.")
		return
	}
	catalogs := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "catalogs.json"), &catalogs)
	referenceStatus := a.referenceStatusV060()
	sourceReadiness := a.sourceProofBusinessReadinessV194(settings, orgs, referenceStatus)
	activeCatalogs := a.catalogEntriesV060(anySlice(catalogs["catalogs"]))
	inputs, _ := listFiles(a.InputsDir)
	outputs, _ := listFiles(a.OutputsDir)
	modules := []any{}
	for _, folder := range []string{"reconciliation", "rules-engine", "corrections"} {
		m := map[string]any{}
		if readJSON(filepath.Join(a.AppRoot, "modules", folder, "MODULE_MANIFEST.json"), &m) == nil {
			launcher := asString(m["launcher"])
			m["launcher_exists"] = launcher != "" && fileExists(filepath.Join(a.AppRoot, "modules", folder, filepath.FromSlash(launcher)))
			m["entrypoint_exists"] = fileExists(filepath.Join(a.AppRoot, "modules", folder, filepath.FromSlash(asString(m["entrypoint"]))))
			modules = append(modules, copyPublicFieldsV194(m, "module_id", "title", "version", "status", "note", "launcher_exists", "entrypoint_exists"))
		}
	}
	approvals := anySlice(reg["approvals"])
	rules := anySlice(reg["rules"])
	publicSettings := sourceProofPublicSettingsV194(settings)
	publicRuns := a.sourceProofPublicRunsV194(anySlice(runs["runs"]), settings)
	publicReferences := sourceProofPublicReferenceStatusV194(referenceStatus)
	publicCatalogs := sourceProofPublicCatalogsV194(activeCatalogs)
	publicArtifacts := sourceProofPublicArtifactsV194(anySlice(arts["artifacts"]))
	publicRules := rulesRegistryPublicRulesV194(rules)
	publicRevisions := rulesRegistryPublicRulesV194(anySlice(reg["revisions"]))
	publicApplications := rulesRegistryPublicApplicationsV194(anySlice(reg["applications"]))
	publicApprovals := rulesRegistryPublicApprovalsV194(approvals)
	organizationSource, _ := orgs["source"].(map[string]any)
	publicOrganizationSource := copyPublicFieldsV194(organizationSource, "title", "status")
	review := 0
	adopted := 0
	for _, raw := range rules {
		m, _ := raw.(map[string]any)
		if m != nil && (asString(m["status"]) == "REVIEW" || asString(m["status"]) == "ORGANIZATION_UNMATCHED") {
			review++
		}
	}
	for _, raw := range approvals {
		m, _ := raw.(map[string]any)
		if m != nil && asString(m["decision"]) == "ADOPTED" {
			adopted++
		}
	}
	workflow := workflowV041(settings, anySlice(runs["runs"]), anySlice(arts["artifacts"]), len(inputs), adopted)
	writeJSON(w, 200, map[string]any{
		"service":   map[string]any{"version": serviceVersion, "host": "127.0.0.1", "report_only": true, "distribution": "ONE_FILE_WINDOWS_INSTALLER"},
		"settings":  publicSettings,
		"opiu_rows": loadOPIURowPresentationV046(a.AppRoot),
		"counts":    map[string]any{"rules": len(rules), "published_rules": adopted, "imported_review": review, "inputs": len(inputs), "outputs": len(outputs), "instructions": len(anySlice(inst["instructions"])), "applications": len(anySlice(reg["applications"])), "artifacts": len(anySlice(arts["artifacts"]))},
		"files":     map[string]any{"inputs": inputs, "outputs": outputs}, "rules": publicRules, "revisions": publicRevisions, "applications": publicApplications, "approvals": publicApprovals,
		"organizations": anySlice(orgs["nodes"]), "organization_source": publicOrganizationSource, "catalogs": publicCatalogs, "reference_status": publicReferences, "source_readiness": sourceReadiness, "instructions": instructionsPublicItemsV194(anySlice(inst["instructions"])), "materials": materialsPublicItemsV194(anySlice(mats["items"])), "modules": modules,
		"runs": publicRuns, "artifacts": publicArtifacts, "workflow": workflow,
	})
}

func (a *App) handleSettingsV194(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "INVALID_JSON"})
		return
	}
	for _, retired := range []string{"approved_source_evidence_sha256", "approved_source_evidence_input", "source_proof_required"} {
		delete(body, retired)
	}
	if mode, ok := body["period_mode"]; ok {
		normalizedMode, normalizedPeriod, periodErr := normalizePeriodSelectionV180(asString(mode), asString(body["period"]))
		if periodErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "INVALID_PERIOD", "message": periodErr.Error()})
			return
		}
		body["period_mode"] = normalizedMode
		body["period"] = normalizedPeriod
	}
	path := filepath.Join(a.ConfigDir, "settings.json")
	current := map[string]any{}
	if err := readJSON(path, &current); err != nil {
		_ = a.logEvent("SETTINGS_READ_FAILED_V194", map[string]any{"technical_error": err.Error()})
		writeJSON(w, http.StatusInternalServerError, sourceProofBusinessErrorResponseV194("SETTINGS_UPDATE_FAILED", "Не удалось прочитать настройки. Передайте журнал в поддержку.", nil))
		return
	}
	for _, retired := range []string{"approved_source_evidence_sha256", "approved_source_evidence_input", "source_proof_required"} {
		delete(current, retired)
	}
	changedFields := contextChangedFields(current, body)
	needsReset := len(changedFields) > 0 && a.hasActiveContext(current)
	confirmed := asBool(body["clear_current_context"])
	if needsReset && !confirmed {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "CONTEXT_RESET_REQUIRED", "message": "Изменение организации или периода требует очистить текущий контекст.",
			"changed_fields": changedFields,
		})
		return
	}
	archivePath := ""
	if needsReset && confirmed {
		archivePath, err = a.archiveActiveContext(current)
		if err != nil {
			_ = a.logEvent("SETTINGS_CONTEXT_ARCHIVE_FAILED_V194", map[string]any{"technical_error": err.Error()})
			writeJSON(w, http.StatusInternalServerError, sourceProofBusinessErrorResponseV194("SETTINGS_UPDATE_FAILED", "Не удалось безопасно обновить контекст. Передайте журнал в поддержку.", nil))
			return
		}
		current["active_run_id"] = ""
		current["workflow_stage"] = "INPUTS_PENDING"
		current["input_roles"] = map[string]any{"intalev": "", "erp": ""}
		current["last_archived_context"] = archivePath
		current["context_revision"] = int(asFloat(current["context_revision"])) + 1
	}
	delete(body, "clear_current_context")
	safety := current["safety"]
	for key, value := range body {
		if key != "safety" {
			current[key] = value
		}
	}
	current["safety"] = safety
	current["updated_at"] = nowISO()
	if err := writeJSONAtomic(path, current); err != nil {
		_ = a.logEvent("SETTINGS_WRITE_FAILED_V194", map[string]any{"technical_error": err.Error()})
		writeJSON(w, http.StatusInternalServerError, sourceProofBusinessErrorResponseV194("SETTINGS_UPDATE_FAILED", "Не удалось сохранить настройки. Передайте журнал в поддержку.", nil))
		return
	}
	_ = a.logEvent("SETTINGS_UPDATED", map[string]any{"fields": mapKeys(body), "context_reset": needsReset && confirmed, "archive_path": archivePath})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "settings": sourceProofPublicSettingsV194(current), "context_reset": needsReset && confirmed})
}

func (a *App) readAllV041() (map[string]any, map[string]any, map[string]any, map[string]any, map[string]any, map[string]any, map[string]any, error) {
	vals := make([]map[string]any, 7)
	paths := []string{
		filepath.Join(a.ConfigDir, "settings.json"), filepath.Join(a.RulesDir, "rules.json"), filepath.Join(a.ConfigDir, "organizations.json"), filepath.Join(a.InstrDir, "instructions.json"), filepath.Join(a.ConfigDir, "materials.json"), filepath.Join(a.DataRoot, "runs", "index.json"), filepath.Join(a.DataRoot, "artifacts", "index.json"),
	}
	for i, p := range paths {
		vals[i] = map[string]any{}
		if err := readJSON(p, &vals[i]); err != nil {
			return nil, nil, nil, nil, nil, nil, nil, err
		}
	}
	return vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], nil
}

func workflowV041(settings map[string]any, runs, artifacts []any, inputCount, adopted int) map[string]any {
	stage := asString(settings["workflow_stage"])
	if stage == "" {
		stage = "INPUTS_PENDING"
	}
	if inputCount > 0 && stage == "INPUTS_PENDING" {
		stage = "INPUTS_READY"
	}
	labels := map[string]string{"INPUTS_PENDING": "Ожидает загрузку исходных данных", "INPUTS_READY": "Исходные данные загружены", "R005_PREPARED": "Ожидает запуск сверки R005", "R005_COMPLETED": "Сверка выполнена — проверьте правила", "RULES_CONFIRMED": "Правила подтверждены", "R001_PREPARED": "Ожидает запуск корректировок R001", "R001_COMPLETED": "Комплект корректировок сформирован", "CONTROL_PENDING": "Ожидает контрольную выгрузку из 1С"}
	steps := []any{
		map[string]any{"id": "inputs", "title": "Загрузить пакет", "status": map[bool]string{true: "done", false: "current"}[inputCount > 0]},
		map[string]any{"id": "r005", "title": "Сверить данные", "status": map[bool]string{true: "done", false: "waiting"}[stage == "R005_COMPLETED" || stage == "RULES_CONFIRMED" || stage == "R001_PREPARED" || stage == "R001_COMPLETED" || stage == "CONTROL_PENDING"]},
		map[string]any{"id": "rules", "title": "Подтвердить правила", "status": map[bool]string{true: "done", false: "waiting"}[adopted > 0]},
		map[string]any{"id": "r001", "title": "Сформировать корректировки", "status": map[bool]string{true: "done", false: "waiting"}[stage == "R001_COMPLETED" || stage == "CONTROL_PENDING"]},
		map[string]any{"id": "control", "title": "Контроль после 1С", "status": map[bool]string{true: "current", false: "waiting"}[stage == "CONTROL_PENDING"]},
	}
	return map[string]any{"stage": stage, "stage_label": defaultString(labels[stage], stage), "next_action": defaultString(labels[stage], "Продолжить работу"), "steps": steps, "active_run_id": settings["active_run_id"], "source_delta": "Ожидает сверку", "projected_delta": "Ожидает подтверждение правил", "latest_runs": len(runs), "artifact_count": len(artifacts)}
}

func (a *App) handleRuleSaveV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	if err := a.bindRuleSaveERPAccountSelectionV194(body); err != nil {
		_ = a.logEvent("RULE_SAVE_ACCOUNT_SELECTION_BLOCKED_V194", map[string]any{"technical_error": err.Error(), "rule_id": safeID(asString(body["rule_id"]))})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "ERP_ACCOUNT_SELECTION_INVALID", "Активное правило со счетами ERP можно сохранить только после выбора счетов из закреплённого плана ERP.")
		return
	}
	reg := map[string]any{}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	list := anySlice(reg["rules"])
	id := safeID(asString(body["rule_id"]))
	var old map[string]any
	idx := -1
	for i, raw := range list {
		m, _ := raw.(map[string]any)
		if m != nil && asString(m["rule_id"]) == id {
			old = m
			idx = i
			break
		}
	}
	if old != nil && asString(old["rule_type"]) == "base" && !asBool(body["allow_base_update"]) {
		writeJSON(w, 409, map[string]any{"error": "BASE_RULE_COPY_REQUIRED", "message": "Базовое правило сохраняется неизменным. Создайте локальную копию."})
		return
	}
	rule := normalizeRuleV041(body, settings, old)
	missing := ruleMissingV041(rule)
	rule["missing_fields"] = strings.Join(missing, "; ")
	if len(missing) > 0 && asString(rule["status"]) == "CURRENT" {
		rule["status"] = "DRAFT"
	}
	if old != nil && asString(old["content_hash"]) != asString(rule["content_hash"]) {
		reg["revisions"] = append(anySlice(reg["revisions"]), cloneMap(old))
		rule["revision_id"] = newRevisionIDV041(asString(rule["rule_id"]))
		rule["content_hash"] = ruleSemanticHashV041(rule)
	}
	if idx >= 0 {
		list[idx] = rule
	} else {
		list = append(list, rule)
		reg["revisions"] = append(anySlice(reg["revisions"]), cloneMap(rule))
	}
	reg["rules"] = list
	reg["updated_at"] = nowISO()
	if err := writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), reg); err != nil {
		_ = a.logEvent("RULE_SAVE_FAILED_V194", map[string]any{"technical_error": err.Error(), "rule_id": rule["rule_id"]})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULE_SAVE_FAILED", "Не удалось сохранить правило. Передайте журнал в поддержку.")
		return
	}
	_ = a.logEvent("RULE_SAVED_V041", map[string]any{"rule_id": rule["rule_id"], "revision_id": rule["revision_id"]})
	writeJSON(w, 200, map[string]any{"ok": true, "rule": rulesRegistryPublicRuleV194(rule), "missing_fields": missing})
}

func normalizeRuleV041(in, settings, old map[string]any) map[string]any {
	now := nowISO()
	id := safeID(asString(in["rule_id"]))
	if id == "" {
		id = newID("RULE")
	}
	rt := asString(in["rule_type"])
	if rt != "base" && rt != "organization" && rt != "imported" {
		rt = "organization"
	}
	scope, _ := in["scope"].(map[string]any)
	if scope == nil {
		scope = map[string]any{}
	}
	mapping, _ := in["mapping"].(map[string]any)
	if mapping == nil {
		mapping = map[string]any{}
	}
	ensureMappingV041(mapping)
	y := int(asFloat(in["valid_from_year"]))
	if y == 0 {
		y = time.Now().Year()
	}
	var yto any = nil
	if n := int(asFloat(in["valid_to_year"])); n > 0 {
		yto = n
	}
	created := now
	origin := id
	rev := newRevisionIDV041(id)
	if old != nil {
		created = defaultString(asString(old["created_at"]), now)
		origin = defaultString(asString(old["origin_rule_id"]), id)
		rev = defaultString(asString(old["revision_id"]), rev)
	}
	var source any = map[string]any{"kind": "local"}
	if old != nil && old["source"] != nil {
		source = old["source"]
	}
	r := map[string]any{
		"rule_id": id, "origin_rule_id": defaultString(safeID(asString(in["origin_rule_id"])), origin), "revision_id": rev,
		"name": defaultString(strings.TrimSpace(asString(in["name"])), "Новое правило"), "description": strings.TrimSpace(asString(in["description"])),
		"rule_type": rt, "status": defaultString(asString(in["status"]), "DRAFT"), "enabled": asBool(in["enabled"]), "is_current": true,
		"valid_from_year": y, "valid_to_year": yto, "scope": scope, "mapping": mapping, "action": defaultString(asString(in["action"]), "REVIEW"), "condition_text": strings.TrimSpace(asString(in["condition_text"])),
		"author": defaultString(strings.TrimSpace(asString(in["author"])), defaultString(asString(settings["author"]), "Пользователь")), "source": source, "created_at": created, "updated_at": now,
	}
	r["content_hash"] = ruleSemanticHashV041(r)
	return r
}

func ensureMappingV041(mapping map[string]any) {
	for _, k := range []string{"intalev_source", "intalev_target", "erp_source", "erp_target"} {
		if _, ok := mapping[k].(map[string]any); !ok {
			mapping[k] = map[string]any{}
		}
	}
	if mapping["candidate_articles"] == nil {
		mapping["candidate_articles"] = []any{}
	}
	if mapping["source_rows"] == nil {
		mapping["source_rows"] = []any{}
	}
}

func ruleSemanticHashV041(r map[string]any) string {
	semantic := map[string]any{"name": r["name"], "description": r["description"], "rule_type": r["rule_type"], "valid_from_year": r["valid_from_year"], "valid_to_year": r["valid_to_year"], "scope": r["scope"], "mapping": r["mapping"], "action": r["action"], "condition_text": r["condition_text"]}
	return hashJSON(semantic)
}
func newRevisionIDV041(ruleID string) string {
	return safeID("REV-" + ruleID + "-" + time.Now().UTC().Format("20060102T150405.000000000"))
}

func ruleMissingV041(rule map[string]any) []string {
	out := []string{}
	if int(asFloat(rule["valid_from_year"])) < 2000 {
		out = append(out, "Укажите год начала")
	}
	scope, _ := rule["scope"].(map[string]any)
	st := asString(scope["scope_type"])
	if st != "ALL_ORGS" && asString(scope["node_id"]) == "" {
		out = append(out, "Выберите организацию или ЦФО из справочника ERP")
	}
	if asString(scope["mapping_status"]) == "unmatched" {
		out = append(out, "Сопоставьте организацию с локальным справочником")
	}
	mapping, _ := rule["mapping"].(map[string]any)
	src, _ := mapping["intalev_source"].(map[string]any)
	if asString(src["code"]) == "" && asString(src["article"]) == "" {
		out = append(out, "Укажите исходную статью Инталев")
	}
	if strings.TrimSpace(asString(rule["action"])) == "" || asString(rule["action"]) == "REVIEW" {
		out = append(out, "Выберите действие правила")
	}
	return out
}

func (a *App) handleRuleCopyV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	reg := map[string]any{}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	var src map[string]any
	for _, raw := range anySlice(reg["rules"]) {
		m, _ := raw.(map[string]any)
		if m != nil && asString(m["rule_id"]) == asString(body["rule_id"]) {
			src = m
			break
		}
	}
	if src == nil {
		writeJSON(w, 404, map[string]any{"error": "RULE_NOT_FOUND"})
		return
	}
	clone := cloneMap(src)
	clone["rule_id"] = newID("RULE-LOCAL")
	clone["origin_rule_id"] = src["rule_id"]
	clone["revision_id"] = newRevisionIDV041(asString(clone["rule_id"]))
	clone["rule_type"] = "organization"
	clone["status"] = "DRAFT"
	clone["enabled"] = false
	clone["name"] = asString(src["name"]) + " — локальная копия"
	clone["author"] = defaultString(asString(settings["author"]), "Пользователь")
	clone["created_at"] = nowISO()
	clone["updated_at"] = nowISO()
	scope, _ := clone["scope"].(map[string]any)
	if scope == nil {
		scope = map[string]any{}
	}
	scope["scope_type"] = "ORG_ONLY"
	scope["node_id"] = settings["organization_id"]
	scope["node_name"] = settings["organization_name"]
	scope["hierarchy_path"] = settings["organization_path"]
	scope["include_descendants"] = false
	scope["mapping_status"] = "matched"
	clone["scope"] = scope
	clone["content_hash"] = ruleSemanticHashV041(clone)
	reg["rules"] = append(anySlice(reg["rules"]), clone)
	reg["revisions"] = append(anySlice(reg["revisions"]), clone)
	reg["updated_at"] = nowISO()
	if err := writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), reg); err != nil {
		_ = a.logEvent("RULE_COPY_FAILED_V194", map[string]any{"technical_error": err.Error(), "source_rule_id": src["rule_id"]})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULE_COPY_FAILED", "Не удалось создать локальную копию правила. Передайте журнал в поддержку.")
		return
	}
	_ = a.logEvent("BASE_RULE_COPIED", map[string]any{"source_rule_id": src["rule_id"], "new_rule_id": clone["rule_id"]})
	writeJSON(w, 201, map[string]any{"ok": true, "rule": rulesRegistryPublicRuleV194(clone)})
}

func (a *App) handleRuleApproveV041(w http.ResponseWriter, r *http.Request) {
	a.handleRuleDecisionV041(w, r, false)
}
func (a *App) handleRuleApproveBulkV041(w http.ResponseWriter, r *http.Request) {
	a.handleRuleDecisionV041(w, r, true)
}

func ruleContextYearV181(body, settings map[string]any) int {
	period := strings.TrimSpace(defaultString(asString(body["period"]), asString(settings["period"])))
	if len(period) >= 4 {
		return int(asFloat(period[:4]))
	}
	return 0
}

func trustedBaseRuleSourceV181(rule map[string]any) bool {
	source, _ := rule["source"].(map[string]any)
	kind := strings.ToLower(strings.TrimSpace(asString(source["kind"])))
	switch kind {
	case "project_rules", "system", "system_seed", "base_rules", "approved_base_rules":
		return true
	default:
		return false
	}
}

// applicableBaseRuleReasonsV181 is the fail-closed server-side gate for bulk
// adoption. The browser may ask to approve all visible rules, but it cannot
// declare a rule applicable. Local, imported and review rules always remain a
// deliberate per-card user decision.
func applicableBaseRuleReasonsV181(rule map[string]any, nodeID, nodePath string, year int) []string {
	reasons := []string{}
	if !strings.EqualFold(asString(rule["rule_type"]), "base") {
		reasons = append(reasons, "не базовое правило")
	}
	if !strings.EqualFold(asString(rule["status"]), "CURRENT") {
		reasons = append(reasons, "статус не CURRENT")
	}
	if !asBool(rule["enabled"]) {
		reasons = append(reasons, "правило выключено")
	}
	if !asBool(rule["is_current"]) {
		reasons = append(reasons, "ревизия не текущая")
	}
	if strings.TrimSpace(asString(rule["revision_id"])) == "" || strings.TrimSpace(asString(rule["content_hash"])) == "" {
		reasons = append(reasons, "нет текущей ревизии или контрольной суммы")
	}
	fromYear, toYear := int(asFloat(rule["valid_from_year"])), int(asFloat(rule["valid_to_year"]))
	if year < 2000 {
		reasons = append(reasons, "не определён год контекста")
	} else if fromYear < 2000 || year < fromYear || (toYear >= 2000 && year > toYear) {
		reasons = append(reasons, "правило не действует в выбранном году")
	}
	if !trustedBaseRuleSourceV181(rule) {
		reasons = append(reasons, "источник не входит в доверенную системную поставку")
	}

	scope, _ := rule["scope"].(map[string]any)
	scopeType := strings.ToUpper(strings.TrimSpace(asString(scope["scope_type"])))
	ruleNodeID := strings.TrimSpace(asString(scope["node_id"]))
	rulePath := strings.TrimSpace(asString(scope["hierarchy_path"]))
	nodePath = strings.TrimSpace(nodePath)
	applicable := false
	switch scopeType {
	case "ALL_ORGS":
		applicable = true
	case "ORG_ONLY", "ORG_OR_BRANCH":
		applicable = ruleNodeID != "" && ruleNodeID == nodeID
	case "ORG_WITH_DESCENDANTS":
		applicable = ruleNodeID != "" && ruleNodeID == nodeID
		if !applicable && asBool(scope["include_descendants"]) && rulePath != "" && nodePath != "" {
			applicable = strings.HasPrefix(nodePath, rulePath+" / ")
		}
	}
	if !applicable {
		reasons = append(reasons, "область действия не включает выбранную организацию")
	}
	if missing := ruleMissingV041(rule); len(missing) > 0 {
		reasons = append(reasons, missing...)
	}
	return reasons
}

func (a *App) handleRuleDecisionV041(w http.ResponseWriter, r *http.Request, bulk bool) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	ids := []string{}
	if bulk {
		for _, v := range anySlice(body["rule_ids"]) {
			if s := safeID(asString(v)); s != "" {
				ids = append(ids, s)
			}
		}
	} else {
		if s := safeID(asString(body["rule_id"])); s != "" {
			ids = []string{s}
		}
	}
	settings := map[string]any{}
	reg := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	nodeID := defaultString(asString(body["node_id"]), asString(settings["organization_id"]))
	nodeName := defaultString(asString(body["node_name"]), asString(settings["organization_name"]))
	path := defaultString(asString(body["hierarchy_path"]), asString(settings["organization_path"]))
	if nodeID == "" {
		writeJSON(w, 400, map[string]any{"error": "ORGANIZATION_REQUIRED", "message": "Сначала выберите организацию или ЦФО."})
		return
	}
	decision := strings.ToUpper(defaultString(asString(body["decision"]), "ADOPTED"))
	if decision != "ADOPTED" && decision != "REJECTED" && decision != "DISPUTED" {
		decision = "ADOPTED"
	}
	safeBaseBulk := bulk && decision == "ADOPTED"
	if safeBaseBulk && len(ids) == 0 && asBool(body["applicable_base_only"]) {
		for _, raw := range anySlice(reg["rules"]) {
			if rule, _ := raw.(map[string]any); rule != nil {
				if id := safeID(asString(rule["rule_id"])); id != "" {
					ids = append(ids, id)
				}
			}
		}
	}
	if len(ids) == 0 {
		writeJSON(w, 400, map[string]any{"error": "RULES_REQUIRED", "message": "Выберите правила."})
		return
	}
	contextYear := ruleContextYearV181(body, settings)
	rulesByID := map[string]map[string]any{}
	for _, raw := range anySlice(reg["rules"]) {
		if m, _ := raw.(map[string]any); m != nil {
			rulesByID[asString(m["rule_id"])] = m
		}
	}
	approvals := anySlice(reg["approvals"])
	confirmed := []string{}
	notConfirmed := []any{}
	for _, id := range ids {
		rule := rulesByID[id]
		if rule == nil {
			notConfirmed = append(notConfirmed, map[string]any{"rule_id": id, "reasons": []string{"Правило не найдено"}})
			continue
		}
		if safeBaseBulk {
			if reasons := applicableBaseRuleReasonsV181(rule, nodeID, path, contextYear); len(reasons) > 0 {
				notConfirmed = append(notConfirmed, map[string]any{"rule_id": id, "name": rule["name"], "reasons": reasons})
				continue
			}
		}
		missing := ruleMissingV041(rule)
		if decision == "ADOPTED" && len(missing) > 0 {
			notConfirmed = append(notConfirmed, map[string]any{"rule_id": id, "name": rule["name"], "reasons": missing})
			continue
		}
		ap := map[string]any{"approval_id": approvalIDV041(id, nodeID), "rule_id": id, "revision_id": rule["revision_id"], "node_id": nodeID, "node_name": nodeName, "hierarchy_path": path, "scope_type": defaultString(asString(body["scope_type"]), "ORG_ONLY"), "include_descendants": asBool(body["include_descendants"]), "decision": decision, "approved_by": defaultString(asString(body["approved_by"]), defaultString(asString(settings["author"]), "Пользователь")), "approved_at": nowISO(), "comment": asString(body["comment"])}
		idx := -1
		for i, raw := range approvals {
			m, _ := raw.(map[string]any)
			if m != nil && asString(m["approval_id"]) == asString(ap["approval_id"]) {
				idx = i
				break
			}
		}
		if idx >= 0 {
			approvals[idx] = ap
		} else {
			approvals = append(approvals, ap)
		}
		confirmed = append(confirmed, id)
	}
	reg["approvals"] = approvals
	reg["updated_at"] = nowISO()
	_ = writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), reg)
	if decision == "ADOPTED" && len(confirmed) > 0 {
		settings["workflow_stage"] = "RULES_CONFIRMED"
		settings["updated_at"] = nowISO()
		_ = writeJSONAtomic(filepath.Join(a.ConfigDir, "settings.json"), settings)
	}
	_ = a.logEvent("RULES_DECISION", map[string]any{"decision": decision, "confirmed": confirmed, "not_confirmed": len(notConfirmed), "node_id": nodeID, "safe_base_bulk": safeBaseBulk})
	writeJSON(w, 200, map[string]any{"ok": true, "decision": decision, "confirmed_rule_ids": confirmed, "not_confirmed": notConfirmed, "eligible_count": len(confirmed), "skipped_count": len(notConfirmed), "safe_base_bulk": safeBaseBulk})
}
func approvalIDV041(ruleID, nodeID string) string {
	h := sha256.Sum256([]byte(ruleID + "|" + nodeID))
	return "APPROVAL-" + strings.ToUpper(hex.EncodeToString(h[:8]))
}

func (a *App) handleRuleExportV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	reg := map[string]any{}
	settings := map[string]any{}
	orgs := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	_ = readJSON(filepath.Join(a.ConfigDir, "organizations.json"), &orgs)
	idFilter := map[string]bool{}
	for _, s := range strings.Split(r.URL.Query().Get("ids"), ",") {
		if id := safeID(s); id != "" {
			idFilter[id] = true
		}
	}
	selected := []any{}
	selectedIDs := map[string]bool{}
	nodeIDs := map[string]bool{}
	for _, raw := range anySlice(reg["rules"]) {
		m, _ := raw.(map[string]any)
		if m == nil || !asBool(m["is_current"]) || asString(m["status"]) == "RETIRED" {
			continue
		}
		id := asString(m["rule_id"])
		if len(idFilter) > 0 && !idFilter[id] {
			continue
		}
		selected = append(selected, rulesRegistryPublicRuleV194(m))
		selectedIDs[id] = true
		if s, _ := m["scope"].(map[string]any); s != nil && asString(s["node_id"]) != "" {
			nodeIDs[asString(s["node_id"])] = true
		}
	}
	aps := []any{}
	for _, raw := range anySlice(reg["approvals"]) {
		m, _ := raw.(map[string]any)
		if m != nil && selectedIDs[asString(m["rule_id"])] {
			aps = append(aps, rulesRegistryPublicApprovalsV194([]any{m})[0])
			nodeIDs[asString(m["node_id"])] = true
		}
	}
	orgSel := []any{}
	for _, raw := range anySlice(orgs["nodes"]) {
		m, _ := raw.(map[string]any)
		if m != nil && nodeIDs[asString(m["node_id"])] {
			orgSel = append(orgSel, copyPublicFieldsV194(m, "node_id", "node_name", "hierarchy_path", "parent_id", "parent_node_id", "status", "type", "kind"))
		}
	}
	author := strings.TrimSpace(r.URL.Query().Get("author"))
	if author == "" {
		author = defaultString(asString(settings["author"]), "Пользователь")
	}
	packageID := newID("RULEPACK")
	manifest := map[string]any{"schema_version": rulePackageSchemaV041, "package_id": packageID, "exported_at": nowISO(), "exported_by": author, "source_library_id": reg["library_id"], "rules_count": len(selected), "contains_applications": false, "current_revisions_only": true, "safety": settings["safety"]}
	files := map[string][]byte{}
	files["manifest.json"] = prettyJSONV041(manifest)
	files["rules.json"] = prettyJSONV041(map[string]any{"schema_version": "opiu-rules.v2", "rules": selected})
	files["approvals.json"] = prettyJSONV041(map[string]any{"schema_version": "opiu-approvals.v1", "approvals": aps})
	files["organizations.json"] = prettyJSONV041(map[string]any{"schema_version": "opiu-organizations-min.v1", "nodes": orgSel})
	files["README.txt"] = []byte("ПАКЕТ ПРАВИЛ ОПИУ\r\n\r\nФайл содержит только актуальные правила и подтверждения областей применения.\r\nКонкретные суммы, исходные финансовые файлы и применения правил в пакет не включены.\r\nИмпортированные правила не активируются автоматически: получатель должен подтвердить их для своей организации.\r\n")
	checks := map[string]any{}
	for n, b := range files {
		h := sha256.Sum256(b)
		checks[n] = strings.ToUpper(hex.EncodeToString(h[:]))
	}
	files["checksums.json"] = prettyJSONV041(map[string]any{"algorithm": "SHA-256", "files": checks})
	data, err := zipBytesV041(files)
	if err != nil {
		_ = a.logEvent("RULE_PACK_EXPORT_FAILED_V194", map[string]any{"technical_error": err.Error(), "package_id": packageID})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULE_PACK_EXPORT_FAILED", "Не удалось сформировать пакет правил. Передайте журнал в поддержку.")
		return
	}
	name := fmt.Sprintf("Правила_ОПИУ_%s_%s.opiu-rules", time.Now().Format("2006-01-02"), lastN(packageID, 8))
	_ = os.WriteFile(filepath.Join(a.RulesDir, "exports", name), data, 0644)
	_ = a.logEvent("RULE_PACK_EXPORTED_V041", map[string]any{"package_id": packageID, "count": len(selected), "filename": name})
	downloadBytes(w, name, "application/octet-stream", data)
}

func (a *App) handleRuleImportV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBytes+1))
	if err != nil || int64(len(raw)) > maxJSONBytes {
		writeJSON(w, 413, map[string]any{"error": "PACKAGE_TOO_LARGE"})
		return
	}
	packRules := []any{}
	packageID := ""
	foreignApprovals := []any{}
	if len(raw) >= 4 && string(raw[:2]) == "PK" {
		files, err := unzipBytesV041(raw)
		if err != nil {
			_ = a.logEvent("RULE_PACK_INVALID_V194", map[string]any{"technical_error": err.Error()})
			writeJSON(w, 400, map[string]any{"error": "INVALID_RULE_PACKAGE", "message": "Пакет правил повреждён или имеет неподдерживаемый формат."})
			return
		}
		manifest := map[string]any{}
		if json.Unmarshal(files["manifest.json"], &manifest) != nil || asString(manifest["schema_version"]) != rulePackageSchemaV041 {
			writeJSON(w, 400, map[string]any{"error": "INVALID_RULE_PACKAGE"})
			return
		}
		packageID = asString(manifest["package_id"])
		if err := verifyChecksumsV041(files); err != nil {
			_ = a.logEvent("RULE_PACK_CHECKSUM_MISMATCH_V194", map[string]any{"technical_error": err.Error(), "package_id": packageID})
			writeJSON(w, 400, map[string]any{"error": "CHECKSUM_MISMATCH", "message": "Контрольная сумма пакета правил не совпала."})
			return
		}
		rr := map[string]any{}
		_ = json.Unmarshal(files["rules.json"], &rr)
		packRules = anySlice(rr["rules"])
		aa := map[string]any{}
		_ = json.Unmarshal(files["approvals.json"], &aa)
		foreignApprovals = anySlice(aa["approvals"])
	} else {
		legacy := map[string]any{}
		if json.Unmarshal(raw, &legacy) != nil {
			writeJSON(w, 400, map[string]any{"error": "INVALID_RULE_PACKAGE"})
			return
		}
		packageID = asString(legacy["package_id"])
		packRules = anySlice(legacy["rules"])
	}
	reg := map[string]any{}
	settings := map[string]any{}
	orgs := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	_ = readJSON(filepath.Join(a.ConfigDir, "organizations.json"), &orgs)
	localNodes := map[string]bool{}
	for _, x := range anySlice(orgs["nodes"]) {
		if m, _ := x.(map[string]any); m != nil {
			localNodes[asString(m["node_id"])] = true
		}
	}
	list := anySlice(reg["rules"])
	existingByID := map[string]map[string]any{}
	existingByOriginHash := map[string]bool{}
	for _, x := range list {
		if m, _ := x.(map[string]any); m != nil {
			existingByID[asString(m["rule_id"])] = m
			existingByOriginHash[asString(m["origin_rule_id"])+"|"+asString(m["content_hash"])] = true
		}
	}
	added, skipped, conflicts, unmatched := 0, 0, 0, 0
	ids := []string{}
	for _, x := range packRules {
		im, _ := x.(map[string]any)
		if im == nil {
			continue
		}
		r := cloneMap(im)
		ensureRuleNoApplicationsV041(r)
		id := safeID(asString(r["rule_id"]))
		if id == "" {
			id = newID("RULE-IMPORT")
		}
		origin := defaultString(safeID(asString(r["origin_rule_id"])), id)
		hash := asString(r["content_hash"])
		if hash == "" {
			hash = ruleSemanticHashV041(r)
			r["content_hash"] = hash
		}
		if existingByOriginHash[origin+"|"+hash] {
			skipped++
			continue
		}
		if local := existingByID[id]; local != nil {
			r["rule_id"] = newID("RULE-IMPORT")
			r["origin_rule_id"] = origin
			r["status"] = "REVIEW"
			src, _ := r["source"].(map[string]any)
			if src == nil {
				src = map[string]any{}
			}
			src["conflict_with_local_rule_id"] = local["rule_id"]
			src["package_id"] = packageID
			r["source"] = src
			conflicts++
		} else {
			r["rule_id"] = id
			r["origin_rule_id"] = origin
			r["status"] = "REVIEW"
			added++
		}
		r["rule_type"] = "imported"
		r["enabled"] = false
		r["is_current"] = true
		r["updated_at"] = nowISO()
		r["created_at"] = defaultString(asString(r["created_at"]), nowISO())
		r["revision_id"] = defaultString(asString(r["revision_id"]), newRevisionIDV041(asString(r["rule_id"])))
		scope, _ := r["scope"].(map[string]any)
		if scope == nil {
			scope = map[string]any{}
		}
		nid := asString(scope["node_id"])
		if nid != "" && !localNodes[nid] {
			scope["mapping_status"] = "unmatched"
			r["status"] = "ORGANIZATION_UNMATCHED"
			unmatched++
		} else if asString(scope["mapping_status"]) == "" {
			scope["mapping_status"] = "matched"
		}
		r["scope"] = scope
		src, _ := r["source"].(map[string]any)
		if src == nil {
			src = map[string]any{}
		}
		src["kind"] = "rule_exchange"
		src["package_id"] = packageID
		src["imported_at"] = nowISO()
		src["foreign_approvals_count"] = len(foreignApprovals)
		r["source"] = src
		list = append(list, r)
		reg["revisions"] = append(anySlice(reg["revisions"]), cloneMap(r))
		ids = append(ids, asString(r["rule_id"]))
		existingByOriginHash[origin+"|"+hash] = true
	}
	reg["rules"] = list
	reg["updated_at"] = nowISO()
	name := safeID(defaultString(packageID, newID("RULEPACK"))) + ".opiu-rules"
	if err := os.WriteFile(filepath.Join(a.RulesDir, "imports", name), raw, 0644); err != nil {
		_ = a.logEvent("RULE_PACK_ARCHIVE_FAILED_V194", map[string]any{"technical_error": err.Error(), "package_id": packageID})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULE_PACK_IMPORT_FAILED", "Не удалось сохранить пакет правил. Передайте журнал в поддержку.")
		return
	}
	if err := writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), reg); err != nil {
		_ = a.logEvent("RULE_PACK_IMPORT_FAILED_V194", map[string]any{"technical_error": err.Error(), "package_id": packageID})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "RULE_PACK_IMPORT_FAILED", "Не удалось импортировать правила. Передайте журнал в поддержку.")
		return
	}
	result := map[string]any{"added": added, "skipped": skipped, "conflicts": conflicts, "unmatched_organizations": unmatched, "imported_rule_ids": ids}
	_ = a.logEvent("RULE_PACK_IMPORTED_V041", map[string]any{"package_id": packageID, "result": result})
	writeJSON(w, 200, map[string]any{"ok": true, "result": result})
}

func ensureRuleNoApplicationsV041(r map[string]any) {
	delete(r, "applications")
	delete(r, "amount")
	delete(r, "amounts")
	if r["mapping"] == nil {
		r["mapping"] = map[string]any{}
	}
	if r["scope"] == nil {
		r["scope"] = map[string]any{}
	}
}
func prettyJSONV041(v any) []byte { b, _ := json.MarshalIndent(v, "", "  "); return append(b, '\n') }
func zipBytesV041(files map[string][]byte) ([]byte, error) {
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		h := &zip.FileHeader{Name: n, Method: zip.Deflate}
		h.SetModTime(time.Now())
		w, e := zw.CreateHeader(h)
		if e != nil {
			return nil, e
		}
		if _, e = w.Write(files[n]); e != nil {
			return nil, e
		}
	}
	if e := zw.Close(); e != nil {
		return nil, e
	}
	return b.Bytes(), nil
}
func unzipBytesV041(data []byte) (map[string][]byte, error) {
	zr, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		return nil, e
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		name := filepath.ToSlash(filepath.Clean(f.Name))
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return nil, fmt.Errorf("недопустимый путь %s", name)
		}
		rc, e := f.Open()
		if e != nil {
			return nil, e
		}
		b, e := io.ReadAll(io.LimitReader(rc, maxJSONBytes))
		rc.Close()
		if e != nil {
			return nil, e
		}
		out[name] = b
	}
	return out, nil
}
func verifyChecksumsV041(files map[string][]byte) error {
	var c map[string]any
	if json.Unmarshal(files["checksums.json"], &c) != nil {
		return errors.New("checksums.json не найден")
	}
	fm, _ := c["files"].(map[string]any)
	for n, v := range fm {
		b, ok := files[n]
		if !ok {
			return fmt.Errorf("нет файла %s", n)
		}
		h := sha256.Sum256(b)
		if !strings.EqualFold(asString(v), hex.EncodeToString(h[:])) {
			return fmt.Errorf("контрольная сумма %s", n)
		}
	}
	return nil
}

func (a *App) handleEnginePrepareV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, e := decodeJSONBody(r)
	if e != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	res, e := a.prepareEngineWithSourcePolicyV194(body, false)
	if e != nil {
		var blocked *preRunSourceBlockedErrorV194
		if errors.As(e, &blocked) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "SOURCE_PROOF_BLOCKED", "message": sourceProofBusinessMessageV194(stringSliceV194(blocked.Result["blocker_codes"])),
				"run_id": nil, "engine_prepare_allowed": false, "posting_rows": 0,
				"ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
			})
			return
		}
		_ = a.logEvent("ENGINE_PUBLIC_PREPARE_BLOCKED_V194", map[string]any{"technical_error": e.Error(), "module_id": safeID(asString(body["module_id"])), "run_id": safeID(asString(body["run_id"]))})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "PREPARE_FAILED", "Не удалось безопасно подготовить движок. Обновите страницу и повторите.")
		return
	}
	writeJSON(w, http.StatusCreated, enginePublicPrepareV194(res))
}

func (a *App) prepareEngineV041(body map[string]any) (map[string]any, error) {
	return a.prepareEngineWithSourcePolicyV194(body, true)
}

// prepareEngineWithTrustedSourceProofV194 and prepareEngineV041 preserve the
// lower-level compatibility seam used by historical Go tests. Every HTTP and
// business-product call passes trustedSourceProof=false explicitly.
func (a *App) prepareEngineWithTrustedSourceProofV194(body map[string]any) (map[string]any, error) {
	return a.prepareEngineWithSourcePolicyV194(body, true)
}

func (a *App) prepareEngineWithSourcePolicyV194(body map[string]any, trustedSourceProof bool) (map[string]any, error) {
	return a.prepareEngineWithSourcePolicyAndCheckpointV194(body, trustedSourceProof, nil)
}

func (a *App) prepareEngineWithSourcePolicyAndCheckpointV194(body map[string]any, trustedSourceProof bool, afterProofValidation func()) (map[string]any, error) {
	moduleID := asString(body["module_id"])
	if moduleID != "reconciliation-engine" && moduleID != "correction-files-engine" {
		return nil, errors.New("неизвестный движок")
	}
	settings := map[string]any{}
	reg := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	var canonicalPreRunProof *preRunSourceProofV194
	if moduleID == "reconciliation-engine" && !trustedSourceProof {
		organizations := map[string]any{}
		_ = readJSON(filepath.Join(a.ConfigDir, "organizations.json"), &organizations)
		referenceStatus := a.referenceStatusV060()
		directProof, _, directBlockers := a.canonicalPersistedSourceProofV194(settings, organizations, referenceStatus)
		if directProof != nil && len(directBlockers) == 0 {
			canonicalPreRunProof = directProof
		} else {
			proof, business, blockers := a.canonicalSourceProofV194(settings, organizations, referenceStatus)
			if len(blockers) != 0 {
				useDirect := false
				for _, code := range blockers {
					if code == "DATA_BLOCKED_SOURCE_PROOF_REQUIRED" {
						useDirect = len(directBlockers) != 0
						break
					}
				}
				if useDirect {
					blockers = directBlockers
				}
				blocked := sourceProofBusinessBlockedV194(blockers)
				a.writePreRunDiagnosticV194(blocked)
				return nil, &preRunSourceBlockedErrorV194{Result: blocked}
			}
			body["source_proof"] = proof
			// The exact binding is intentionally transient. Persisting it would expose
			// implementation hashes through the normal bootstrap settings payload.
			settings["approved_source_evidence_sha256"] = proof["approved_evidence_sha256"]
			settings["approved_source_evidence_input"] = business["evidence_input"]
		}
	}
	var r001Binding *r001HandoffBindingV194
	if moduleID == "correction-files-engine" {
		var bindingErr error
		r001Binding, bindingErr = a.verifiedR001HandoffBindingV194(body, settings)
		if bindingErr != nil {
			return nil, bindingErr
		}
	} else if strings.TrimSpace(asString(body["period_mode"])) != "" || strings.TrimSpace(asString(body["period"])) != "" {
		mode := defaultString(asString(body["period_mode"]), asString(settings["period_mode"]))
		period := defaultString(asString(body["period"]), asString(settings["period"]))
		normalizedMode, normalizedPeriod, periodErr := normalizePeriodSelectionV180(mode, period)
		if periodErr != nil {
			return nil, periodErr
		}
		settings["period_mode"] = normalizedMode
		settings["period"] = normalizedPeriod
	}
	inputRoles, _ := settings["input_roles"].(map[string]any)
	if inputRoles == nil {
		inputRoles = map[string]any{}
	}
	// R005 proof is a server invariant, not a mutable setting. This prevents
	// /api/settings or a forged direct request from re-enabling the legacy
	// latest-upload fallback.
	proofRequired := moduleID == "reconciliation-engine" && (!trustedSourceProof || asBool(settings["source_proof_required"]))
	intalevName := strings.TrimSpace(asString(body["intalev_file"]))
	erpName := strings.TrimSpace(asString(body["erp_file"]))
	if moduleID == "reconciliation-engine" && trustedSourceProof && !proofRequired {
		// Historical low-level tests exercise the pre-SVC-005 selection contract.
		// No HTTP or business-product path can enter this compatibility seam.
		files, _ := listFiles(a.InputsDir)
		intalevName = defaultString(intalevName, defaultString(asString(inputRoles["intalev"]), latestInputRoleV180(files, "intalev")))
		erpName = defaultString(erpName, defaultString(asString(inputRoles["erp"]), latestInputRoleV180(files, "erp")))
	}
	if r001Binding != nil {
		// R001 inherits the source names recorded by its active run. They are audit
		// context only; no global latest-upload fallback is allowed here.
		intalevName = asString(r001Binding.Run["intalev_file"])
		erpName = asString(r001Binding.Run["erp_file"])
	}
	intalevPath, erpPath := "", ""
	year := periodYearV041(asString(settings["period"]))
	organizationAutoMatched := false
	annualSources := map[string]any{"selection_mode": "PRE_RUN_EXACT_PROOF", "manual_pinning_required": true}
	if moduleID == "reconciliation-engine" && trustedSourceProof && !proofRequired {
		annualSources = map[string]any{"selection_mode": "LATEST_UPLOAD", "manual_pinning_required": false}
	}
	var preRunProof *preRunSourceProofV194
	var carriedPreRunProof map[string]any
	var proofErr error
	if moduleID == "reconciliation-engine" && proofRequired {
		if canonicalPreRunProof != nil {
			preRunProof = canonicalPreRunProof
			proofErr = a.validateCanonicalPreRunRequestV194(preRunProof, body)
		} else {
			preRunProof, proofErr = a.preflightSourcesV194(body, settings)
		}
		if proofErr != nil {
			return nil, proofErr
		}
		if asBool(body["preflight_only"]) {
			return map[string]any{"ok": true, "run_id": nil, "pre_run_source_proof": preRunProof.Public}, nil
		}
		if proofErr = validatePreRunProofCurrentV194(preRunProof); proofErr != nil {
			blocked := cloneMap(preRunProof.Public)
			blocked["proof_status"] = "BLOCKED_SOURCE_PROOF"
			blocked["blocker_codes"] = []string{"BLOCKED_SOURCE_PROOF_HASH_DRIFT"}
			blocked["blocker_summary"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
			blocked["engine_prepare_allowed"] = false
			blocked["error"] = "SOURCE_PROOF_BLOCKED"
			blocked["message"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
			a.writePreRunDiagnosticV194(blocked)
			return nil, &preRunSourceBlockedErrorV194{Result: blocked}
		}
		if afterProofValidation != nil {
			afterProofValidation()
		}
		intalevPath, erpPath = preRunSelectedPathsV194(preRunProof)
		intalevName, erpName = filepath.Base(intalevPath), filepath.Base(erpPath)
		annualSources["package_id"] = preRunProof.Public["package_id"]
		annualSources["package_digest_sha256"] = preRunProof.Public["package_digest_sha256"]
		annualSources["proof_digest_sha256"] = preRunProof.Public["proof_digest_sha256"]
	} else if moduleID == "correction-files-engine" {
		if runRequiresPreRunProofV194(r001Binding.Run) {
			carriedPreRunProof, proofErr = validateStoredPreRunProofV194(r001Binding.Run)
			if proofErr != nil {
				return nil, proofErr
			}
			for _, raw := range anySlice(r001Binding.Run["pre_run_source_roots"]) {
				stored, _ := raw.(map[string]any)
				if stored == nil {
					continue
				}
				switch strings.ToUpper(asString(stored["role"])) {
				case "INTALEV":
					intalevPath = asString(stored["selected_path"])
				case "ERP":
					erpPath = asString(stored["selected_path"])
				}
			}
		}
	}
	if intalevPath == "" && intalevName != "" {
		p, e := within(a.InputsDir, safeRelativeFilePath(intalevName))
		if e != nil || !fileExists(p) {
			return nil, fmt.Errorf("файл Инталев не найден: %s", intalevName)
		}
		intalevPath = p
	}
	if erpPath == "" && erpName != "" {
		p, e := within(a.InputsDir, safeRelativeFilePath(erpName))
		if e != nil || !fileExists(p) {
			return nil, fmt.Errorf("файл ERP не найден: %s", erpName)
		}
		erpPath = p
	}
	if moduleID == "reconciliation-engine" && !proofRequired {
		if intalevName != "" {
			if err := a.validateEngineIntalevSelectionV160(intalevName, year); err != nil {
				return nil, err
			}
		}
		resolved, matched, resolveErr := a.resolveEngineOrganizationV051(settings, erpName, erpPath)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if matched {
			organizationAutoMatched = true
			settings["organization"] = resolved["name"]
			settings["organization_id"] = resolved["id"]
			settings["organization_name"] = resolved["name"]
			settings["organization_path"] = resolved["path"]
			settings["context_revision"] = int(asFloat(settings["context_revision"])) + 1
			settings["active_run_id"] = ""
			settings["workflow_stage"] = "INPUTS_PENDING"
			_ = a.logEvent("ENGINE_ORGANIZATION_AUTO_MATCHED_V051", map[string]any{"erp_file": erpName, "organization_id": resolved["id"], "organization_name": resolved["name"]})
		}
	}
	runID := safeID(asString(body["run_id"]))
	if r001Binding != nil {
		runID = r001Binding.RunID
	}
	if organizationAutoMatched {
		runID = ""
	}
	if moduleID == "reconciliation-engine" && proofRequired {
		runID = ""
	}
	if runID == "" {
		if moduleID == "correction-files-engine" {
			runID = safeID(asString(settings["active_run_id"]))
		}
		if runID == "" {
			runID = "RUN-" + time.Now().UTC().Format("20060102-150405") + "-" + lastN(newID(""), 6)
		}
	}
	runDir := filepath.Join(a.DataRoot, "runs", runID)
	ctxDir := filepath.Join(runDir, "context")
	r005Out := filepath.Join(runDir, "r005-output")
	r001Out := filepath.Join(runDir, "r001-output")
	for _, d := range []string{ctxDir, r005Out, r001Out} {
		if e := os.MkdirAll(d, 0755); e != nil {
			return nil, e
		}
	}
	if preRunProof != nil {
		snapshots, snapshotErr := snapshotPreRunSelectedSourcesV194(preRunProof, filepath.Join(runDir, "source-snapshot"))
		if snapshotErr != nil {
			blocked := cloneMap(preRunProof.Public)
			blocked["proof_status"] = "BLOCKED_SOURCE_PROOF"
			blocked["blocker_codes"] = []string{"BLOCKED_SOURCE_PROOF_HASH_DRIFT"}
			blocked["blocker_summary"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
			blocked["engine_prepare_allowed"] = false
			blocked["error"] = "SOURCE_PROOF_BLOCKED"
			blocked["message"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
			a.writePreRunDiagnosticV194(blocked)
			return nil, &preRunSourceBlockedErrorV194{Result: blocked}
		}
		intalevPath, erpPath = snapshots["INTALEV"], snapshots["ERP"]
	}
	reconciliationPath := strings.TrimSpace(asString(body["reconciliation_path"]))
	if r001Binding != nil {
		reconciliationPath = r001Binding.ReconciliationPath
	}
	if reconciliationPath != "" {
		clean := filepath.Clean(reconciliationPath)
		base := filepath.Clean(a.DataRoot) + string(os.PathSeparator)
		if !strings.HasPrefix(clean+string(os.PathSeparator), base) || !fileExists(clean) {
			return nil, errors.New("готовая сверка должна быть зарегистрированным файлом сервиса")
		}
		reconciliationPath = clean
	}
	rules := applicableRulesV041(reg, settings, year)
	rulesPath := filepath.Join(ctxDir, "engine_rules.json")
	_ = os.WriteFile(rulesPath, prettyJSONV041(map[string]any{"schema_version": "opiu-engine-rules.v1", "run_id": runID, "rules": rules}), 0644)
	referenceCatalogs := a.activeReferencePathsV060()
	var boundPreRunProof map[string]any
	if preRunProof != nil {
		boundPreRunProof = cloneMap(preRunProof.Public)
		boundPreRunProof["run_id"] = runID
	} else if carriedPreRunProof != nil {
		boundPreRunProof = cloneMap(carriedPreRunProof)
		boundPreRunProof["run_id"] = runID
	}
	sources := map[string]any{"intalev": sourceDescriptorV041(intalevPath), "erp": sourceDescriptorV041(erpPath), "reconciliation": sourceDescriptorV041(reconciliationPath), "reference_catalogs": referenceCatalogs, "annual_sources": annualSources}
	if boundPreRunProof != nil {
		sources["pre_run_source_proof"] = boundPreRunProof
	}
	if r001Binding != nil {
		sources["codex_input"] = sourceDescriptorV041(r001Binding.CodexInputPath)
		sources["approved_rule_applications"] = sourceDescriptorV041(r001Binding.ApplicationsPath)
		sources["rules_handoff"] = sourceDescriptorV041(r001Binding.RulesPath)
		sources["r001_handoff"] = sourceDescriptorV041(r001Binding.HandoffPath)
	}
	_ = os.WriteFile(filepath.Join(ctxDir, "sources_manifest.json"), prettyJSONV041(map[string]any{"schema_version": "opiu-sources.v1", "run_id": runID, "sources": sources}), 0644)
	contextSources := map[string]any{"intalev_path": intalevPath, "erp_path": erpPath, "reconciliation_path": reconciliationPath, "reference_catalogs": referenceCatalogs, "annual_sources": annualSources}
	if boundPreRunProof != nil {
		contextSources["pre_run_source_proof"] = boundPreRunProof
	}
	if r001Binding != nil {
		contextSources["codex_input_path"] = r001Binding.CodexInputPath
		contextSources["approved_rule_applications_path"] = r001Binding.ApplicationsPath
		contextSources["rules_handoff_path"] = r001Binding.RulesPath
		contextSources["r001_handoff_path"] = r001Binding.HandoffPath
		contextSources["r001_handoff_sha256"] = r001Binding.HandoffSHA256
		contextSources["rules_revision_set_hash"] = r001Binding.RulesRevisionSetHash
	}
	context := map[string]any{"schema_version": "opiu-engine-context.v1", "run_id": runID, "module_id": moduleID, "organization": map[string]any{"id": settings["organization_id"], "name": settings["organization_name"], "path": settings["organization_path"], "include_descendants": settings["include_descendants"]}, "period_mode": settings["period_mode"], "period": settings["period"], "author": settings["author"], "sources": contextSources, "outputs": map[string]any{"r005_dir": r005Out, "r001_dir": r001Out}, "rules_path": rulesPath, "created_at": nowISO()}
	ctxPath := filepath.Join(ctxDir, "engine_context.json")
	_ = os.WriteFile(ctxPath, prettyJSONV041(context), 0644)
	_ = os.WriteFile(filepath.Join(ctxDir, "run_context.json"), prettyJSONV041(context), 0644)
	a.runsMu.Lock()
	runs := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "runs", "index.json"), &runs)
	list := anySlice(runs["runs"])
	rec := map[string]any{"run_id": runID, "organization_id": settings["organization_id"], "organization_name": settings["organization_name"], "organization_path": settings["organization_path"], "include_descendants": settings["include_descendants"], "context_revision": settings["context_revision"], "period_mode": settings["period_mode"], "period": settings["period"], "author": settings["author"], "stage": map[bool]string{true: "R005_PREPARED", false: "R001_PREPARED"}[moduleID == "reconciliation-engine"], "context_path": ctxPath, "r005_output_dir": r005Out, "r001_output_dir": r001Out, "intalev_file": intalevName, "erp_file": erpName, "reconciliation_path": reconciliationPath, "reference_catalogs": referenceCatalogs, "annual_sources": annualSources, "rules_count": len(rules), "created_at": nowISO(), "updated_at": nowISO()}
	if moduleID == "reconciliation-engine" {
		if actionID := safeID(asString(body["business_action_id"])); actionID != "" {
			rec["business_action_id"] = actionID
			rec["business_action_status"] = "PREPARED"
		}
	}
	if preRunProof != nil {
		rec["source_proof_contract"] = preRunSourceContractMarkerV194
		rec["pre_run_source_proof"] = boundPreRunProof
		rec["pre_run_source_roots"] = preRunInternalRecordV194(preRunProof)
		rec["pre_run_execution_sources"] = map[string]any{
			"erp":     map[string]any{"path": erpPath, "sha256": sourceDescriptorV041(erpPath)["sha256"]},
			"intalev": map[string]any{"path": intalevPath, "sha256": sourceDescriptorV041(intalevPath)["sha256"]},
		}
	} else if carriedPreRunProof != nil {
		rec["pre_run_source_proof"] = boundPreRunProof
		rec["pre_run_source_roots"] = r001Binding.Run["pre_run_source_roots"]
	}
	if r001Binding != nil {
		rec["r001_handoff_path"] = r001Binding.HandoffPath
		rec["r001_handoff_sha256"] = r001Binding.HandoffSHA256
		rec["r001_codex_input_path"] = r001Binding.CodexInputPath
		rec["r001_applications_path"] = r001Binding.ApplicationsPath
	}
	idx := -1
	for i, x := range list {
		m, _ := x.(map[string]any)
		if m != nil && asString(m["run_id"]) == runID {
			idx = i
			break
		}
	}
	if idx >= 0 {
		old, _ := list[idx].(map[string]any)
		for k, v := range rec {
			old[k] = v
		}
		list[idx] = old
	} else {
		list = append(list, rec)
	}
	runs["runs"] = list
	_ = writeJSONAtomic(filepath.Join(a.DataRoot, "runs", "index.json"), runs)
	a.runsMu.Unlock()
	settings["active_run_id"] = runID
	settings["workflow_stage"] = rec["stage"]
	inputRoles["intalev"] = intalevName
	inputRoles["erp"] = erpName
	settings["input_roles"] = inputRoles
	settings["updated_at"] = nowISO()
	if moduleID == "reconciliation-engine" {
		delete(settings, "approved_source_evidence_sha256")
		delete(settings, "approved_source_evidence_input")
	}
	_ = writeJSONAtomic(filepath.Join(a.ConfigDir, "settings.json"), settings)
	_ = a.logEvent("ENGINE_CONTEXT_PREPARED", map[string]any{"module_id": moduleID, "run_id": runID, "rules_count": len(rules), "context_path": ctxPath})
	result := map[string]any{"ok": true, "run_id": runID, "context_path": ctxPath, "rules_count": len(rules), "output_dir": map[bool]string{true: r005Out, false: r001Out}[moduleID == "reconciliation-engine"], "organization_auto_matched": organizationAutoMatched, "organization_id": settings["organization_id"], "organization_name": settings["organization_name"]}
	if boundPreRunProof != nil {
		result["pre_run_source_proof"] = boundPreRunProof
	}
	if r001Binding != nil {
		result["r001_handoff_path"] = r001Binding.HandoffPath
		result["r001_handoff_sha256"] = r001Binding.HandoffSHA256
	}
	return result, nil
}

func normalizeOrganizationEvidenceV051(value string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			b.WriteRune(r)
			space = false
		} else {
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

func organizationAliasesV051(name string) []string {
	canonical := normalizeOrganizationEvidenceV051(name)
	aliases := []string{canonical}
	parts := strings.Fields(canonical)
	if len(parts) > 1 {
		if _, err := strconv.Atoi(parts[0]); err == nil {
			aliases = append(aliases, strings.Join(parts[1:], " "))
		}
	}
	if strings.Contains(canonical, "управляющая компания") {
		aliases = append(aliases, strings.ReplaceAll(canonical, "управляющая компания", "ук"))
		aliases = append(aliases, "ук")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, alias := range aliases {
		alias = strings.TrimSpace(alias)
		if len([]rune(alias)) >= 4 && !seen[alias] {
			seen[alias] = true
			out = append(out, alias)
		}
	}
	return out
}

func erpOrganizationEvidenceV051(erpName, erpPath string) string {
	parts := []string{erpName, filepath.Base(erpPath)}
	if strings.EqualFold(filepath.Ext(erpPath), ".zip") {
		if archive, err := zip.OpenReader(erpPath); err == nil {
			defer archive.Close()
			for i, entry := range archive.File {
				if i >= 5000 {
					break
				}
				parts = append(parts, entry.Name)
			}
		}
	}
	return " " + normalizeOrganizationEvidenceV051(strings.Join(parts, " ")) + " "
}

func isGenericOrganizationV051(name string) bool {
	normalized := normalizeOrganizationEvidenceV051(name)
	switch normalized {
	case "", "управленческая организация", "организация не определена", "не определено":
		return true
	default:
		return false
	}
}

func (a *App) resolveEngineOrganizationV051(settings map[string]any, erpName, erpPath string) (map[string]any, bool, error) {
	current := map[string]any{"id": settings["organization_id"], "name": settings["organization_name"], "path": settings["organization_path"]}
	if !isGenericOrganizationV051(asString(current["name"])) || strings.TrimSpace(erpPath) == "" {
		return current, false, nil
	}
	orgs := map[string]any{}
	if err := readJSON(filepath.Join(a.ConfigDir, "organizations.json"), &orgs); err != nil {
		return nil, false, fmt.Errorf("не удалось прочитать справочник организаций ERP: %w", err)
	}
	evidence := erpOrganizationEvidenceV051(erpName, erpPath)
	type organizationMatchV051 struct {
		organization map[string]any
		alias        string
	}
	matches := []organizationMatchV051{}
	for _, raw := range anySlice(orgs["nodes"]) {
		node, _ := raw.(map[string]any)
		if node == nil || strings.TrimSpace(asString(node["parent_id"])) != "" || !asBool(node["selectable"]) || !asBool(node["source_verified"]) {
			continue
		}
		if strings.EqualFold(asString(node["node_type"]), "BRANCH") {
			continue
		}
		name := defaultString(asString(node["node_name"]), asString(node["name"]))
		matchedAlias := ""
		for _, alias := range organizationAliasesV051(name) {
			if strings.Contains(evidence, " "+alias+" ") && len([]rune(alias)) > len([]rune(matchedAlias)) {
				matchedAlias = alias
			}
		}
		if matchedAlias != "" {
			matches = append(matches, organizationMatchV051{
				organization: map[string]any{"id": node["node_id"], "name": name, "path": defaultString(asString(node["hierarchy_path"]), name)},
				alias:        matchedAlias,
			})
		}
	}
	// A short organization name can be a token-prefix of a more specific one
	// (for example, "Сахалин" and "Сахалин МА"). In that case only the
	// specific match is evidence. Distinct organization names remain ambiguous.
	filtered := []organizationMatchV051{}
	for i, candidate := range matches {
		shadowed := false
		for j, other := range matches {
			if i == j || len([]rune(other.alias)) <= len([]rune(candidate.alias)) {
				continue
			}
			if strings.Contains(" "+other.alias+" ", " "+candidate.alias+" ") {
				shadowed = true
				break
			}
		}
		if !shadowed {
			filtered = append(filtered, candidate)
		}
	}
	if len(filtered) == 1 {
		return filtered[0].organization, true, nil
	}
	if len(filtered) > 1 {
		return nil, false, errors.New("ERP содержит несколько подтверждённых организаций; выберите нужную организацию на вкладке «Обзор»")
	}
	return nil, false, fmt.Errorf("организация не определена по выбранному ERP «%s»; выберите организацию на вкладке «Обзор»", erpName)
}

func periodYearV041(p string) int {
	if len(p) >= 4 {
		if n, e := strconv.Atoi(p[:4]); e == nil {
			return n
		}
	}
	return time.Now().Year()
}
func sourceDescriptorV041(path string) map[string]any {
	m := map[string]any{"path": path, "exists": false, "sha256": ""}
	if path == "" {
		return m
	}
	if st, e := os.Stat(path); e == nil && !st.IsDir() {
		m["exists"] = true
		m["size"] = st.Size()
		if h, e := fileSHA256V041(path); e == nil {
			m["sha256"] = h
		}
	}
	return m
}
func fileSHA256V041(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	if _, e = io.Copy(h, f); e != nil {
		return "", e
	}
	return strings.ToUpper(hex.EncodeToString(h.Sum(nil))), nil
}

func applicableRulesV041(reg, settings map[string]any, year int) []any {
	aps := anySlice(reg["approvals"])
	adopted := map[string]bool{}
	nodeID := asString(settings["organization_id"])
	currentPath := strings.TrimSpace(asString(settings["organization_path"]))
	for _, x := range aps {
		m, _ := x.(map[string]any)
		if m == nil || asString(m["decision"]) != "ADOPTED" {
			continue
		}
		sameNode := asString(m["node_id"]) == nodeID
		approvalPath := strings.TrimSpace(asString(m["hierarchy_path"]))
		isDescendant := asBool(m["include_descendants"]) && approvalPath != "" && (currentPath == approvalPath || strings.HasPrefix(currentPath, approvalPath+" /"))
		if sameNode || isDescendant {
			adopted[asString(m["rule_id"])] = true
		}
	}
	out := []any{}
	for _, x := range anySlice(reg["rules"]) {
		r, _ := x.(map[string]any)
		if r == nil || !asBool(r["is_current"]) || !asBool(r["enabled"]) {
			continue
		}
		from := int(asFloat(r["valid_from_year"]))
		to := int(asFloat(r["valid_to_year"]))
		if from > 0 && year < from {
			continue
		}
		if to > 0 && year > to {
			continue
		}
		scope, _ := r["scope"].(map[string]any)
		if scope == nil {
			scope = map[string]any{}
		}
		if asString(scope["scope_type"]) == "ALL_ORGS" || adopted[asString(r["rule_id"])] {
			out = append(out, r)
		}
	}
	return out
}

func businessActionIDV194(body map[string]any) (string, error) {
	raw := strings.TrimSpace(asString(body["business_action_id"]))
	actionID := safeID(raw)
	if actionID == "" || actionID != raw || len(actionID) > 100 {
		return "", errors.New("R005_BUSINESS_ACTION_ID_REQUIRED")
	}
	return actionID, nil
}

func (a *App) existingBusinessActionRunV194(actionID string) map[string]any {
	a.runsMu.Lock()
	defer a.runsMu.Unlock()
	runs := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "runs", "index.json"), &runs)
	for _, raw := range anySlice(runs["runs"]) {
		run, _ := raw.(map[string]any)
		if run != nil && asString(run["business_action_id"]) == actionID {
			return cloneMap(run)
		}
	}
	return nil
}

func businessActionContextMatchesV194(run, settings map[string]any) bool {
	if asString(settings["active_run_id"]) != asString(run["run_id"]) {
		return false
	}
	for _, key := range []string{"organization_id", "organization_name", "organization_path", "period_mode", "period"} {
		if strings.TrimSpace(asString(run[key])) != strings.TrimSpace(asString(settings[key])) {
			return false
		}
	}
	if asBool(run["include_descendants"]) != asBool(settings["include_descendants"]) || int(asFloat(run["context_revision"])) != int(asFloat(settings["context_revision"])) {
		return false
	}
	return true
}

func (a *App) prepareBusinessR005V194(body map[string]any) (map[string]any, bool, error) {
	a.rulesEngineMu.Lock()
	defer a.rulesEngineMu.Unlock()
	return a.prepareBusinessR005LockedV194(body, nil, nil)
}

// The checkpoint is nil in production and gives the drift regression a
// deterministic boundary between the two mandatory internal proof steps.
func (a *App) prepareBusinessR005WithCheckpointV194(body map[string]any, checkpoint func()) (map[string]any, bool, error) {
	a.rulesEngineMu.Lock()
	defer a.rulesEngineMu.Unlock()
	return a.prepareBusinessR005LockedV194(body, checkpoint, nil)
}

func (a *App) prepareBusinessR005WithCheckpointsV194(body map[string]any, betweenProofSteps, afterProofValidation func()) (map[string]any, bool, error) {
	a.rulesEngineMu.Lock()
	defer a.rulesEngineMu.Unlock()
	return a.prepareBusinessR005LockedV194(body, betweenProofSteps, afterProofValidation)
}

func (a *App) prepareBusinessR005LockedV194(body map[string]any, checkpoint, afterProofValidation func()) (map[string]any, bool, error) {
	actionID, err := businessActionIDV194(body)
	if err != nil {
		return nil, false, err
	}
	if existing := a.existingBusinessActionRunV194(actionID); existing != nil {
		settings := map[string]any{}
		if err := readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings); err != nil {
			return nil, false, err
		}
		if !businessActionContextMatchesV194(existing, settings) {
			return nil, false, errors.New("R005_BUSINESS_ACTION_CONTEXT_CHANGED")
		}
		if _, err := validateStoredPreRunProofV194(existing); err != nil {
			return nil, false, err
		}
		return map[string]any{
			"ok": true, "run_id": existing["run_id"], "context_path": existing["context_path"],
			"organization_id": existing["organization_id"], "organization_name": existing["organization_name"],
			"business_action_status": defaultString(asString(existing["business_action_status"]), "PREPARED"),
		}, true, nil
	}
	preflightBody := cloneMap(body)
	preflightBody["preflight_only"] = true
	delete(preflightBody, "expected_preflight_digest_sha256")
	preflight, err := a.prepareEngineWithSourcePolicyV194(preflightBody, false)
	if err != nil {
		return nil, false, err
	}
	proof, _ := preflight["pre_run_source_proof"].(map[string]any)
	if proof == nil || asString(proof["proof_status"]) != "PASS" || !asBool(proof["engine_prepare_allowed"]) || preflight["run_id"] != nil {
		return nil, false, errors.New("SOURCE_PROOF_INTERNAL_PREFLIGHT_FAILED")
	}
	if checkpoint != nil {
		checkpoint()
	}
	confirmBody := cloneMap(body)
	confirmBody["expected_preflight_digest_sha256"] = proof["proof_digest_sha256"]
	delete(confirmBody, "preflight_only")
	prepared, err := a.prepareEngineWithSourcePolicyAndCheckpointV194(confirmBody, false, afterProofValidation)
	return prepared, false, err
}

func (a *App) updateBusinessActionStateV194(runID, actionID, status string) error {
	if strings.TrimSpace(runID) == "" || strings.TrimSpace(actionID) == "" {
		return errors.New("R005_BUSINESS_ACTION_STATE_ID_REQUIRED")
	}
	a.runsMu.Lock()
	defer a.runsMu.Unlock()
	path := filepath.Join(a.DataRoot, "runs", "index.json")
	runs := map[string]any{}
	if err := readJSON(path, &runs); err != nil {
		return err
	}
	list := anySlice(runs["runs"])
	for _, raw := range list {
		run, _ := raw.(map[string]any)
		if run != nil && asString(run["run_id"]) == runID && asString(run["business_action_id"]) == actionID {
			run["business_action_status"] = status
			run["updated_at"] = nowISO()
			return writeJSONAtomic(path, runs)
		}
	}
	return errors.New("R005_BUSINESS_ACTION_RUN_NOT_FOUND")
}

func (a *App) handleModuleOpenV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, e := decodeJSONBody(r)
	if e != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	moduleID := asString(body["module_id"])
	businessStart := moduleID == "reconciliation-engine" && asBool(body["resolve_source_proof"])
	businessActionID := ""
	businessReplayState := ""
	writePrepareError := func(err error) {
		var blocked *preRunSourceBlockedErrorV194
		if errors.As(err, &blocked) {
			if businessStart {
				writeJSON(w, http.StatusConflict, sourceProofBusinessErrorResponseV194("SOURCES_NOT_READY", sourceProofBusinessMessageV194(stringSliceV194(blocked.Result["blocker_codes"])), nil))
				return
			}
			writeJSON(w, http.StatusConflict, blocked.Result)
			return
		}
		if businessStart {
			_ = a.logEvent("R005_BUSINESS_PREPARE_FAILED_V194", map[string]any{"module_id": moduleID, "technical_error": err.Error()})
			writeJSON(w, http.StatusConflict, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Не удалось безопасно подготовить сверку. Выберите пакеты заново.", nil))
			return
		}
		_ = a.logEvent("MODULE_PUBLIC_PREPARE_FAILED_V194", map[string]any{"module_id": moduleID, "technical_error": err.Error()})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "PREPARE_FAILED", "Не удалось безопасно подготовить движок. Обновите страницу и повторите.")
	}
	if businessStart {
		a.rulesEngineMu.Lock()
		defer a.rulesEngineMu.Unlock()
		businessActionID, e = businessActionIDV194(body)
		if e != nil {
			writePrepareError(e)
			return
		}
		prep, replayed, e := a.prepareBusinessR005LockedV194(body, nil, nil)
		if e != nil {
			writePrepareError(e)
			return
		}
		if replayed {
			businessReplayState = strings.ToUpper(asString(prep["business_action_status"]))
			switch businessReplayState {
			case "READY":
				writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ui_ready": true, "run_id": prep["run_id"], "message": "Запуск R005 уже подтверждён.", "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
				return
			case "PENDING":
				writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ui_ready": false, "run_id": prep["run_id"], "message": "Команда запуска R005 уже передана. Проверьте рабочее окно.", "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
				return
			case "FAILED":
				writeJSON(w, http.StatusConflict, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Предыдущий запуск R005 не открыл рабочее окно. Повторите запуск новой командой.", prep["run_id"]))
				return
			}
		}
		body["_prepared_business_r005"] = prep
	}
	prep, _ := body["_prepared_business_r005"].(map[string]any)
	e = nil
	if prep == nil {
		if moduleID == "reconciliation-engine" {
			prep, e = a.prepareEngineWithSourcePolicyV194(body, false)
		} else {
			prep, e = a.prepareEngineV041(body)
		}
	}
	if e != nil {
		writePrepareError(e)
		return
	}
	setBusinessActionState := func(status string) bool {
		if !businessStart {
			return true
		}
		if err := a.updateBusinessActionStateV194(asString(prep["run_id"]), businessActionID, status); err != nil {
			_ = a.logEvent("R005_BUSINESS_ACTION_STATE_FAILED_V194", map[string]any{"run_id": prep["run_id"], "state": status, "technical_error": err.Error()})
			writeJSON(w, http.StatusInternalServerError, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Не удалось подтвердить состояние запуска R005. Передайте журнал в поддержку.", prep["run_id"]))
			return false
		}
		return true
	}
	folder := "reconciliation"
	launcher := "source/ui_loader.ps1"
	if moduleID == "correction-files-engine" {
		folder = "corrections"
		launcher = "source/correction_ui_loader.ps1"
	}
	full := filepath.Join(a.AppRoot, "modules", folder, filepath.FromSlash(launcher))
	if !fileExists(full) {
		if businessStart {
			_ = a.logEvent("R005_BUSINESS_LAUNCHER_MISSING_V194", map[string]any{"module_id": moduleID, "launcher_path": full})
			if !setBusinessActionState("FAILED") {
				return
			}
			writeJSON(w, 500, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Не удалось открыть рабочее окно R005. Передайте журнал в поддержку.", prep["run_id"]))
			return
		}
		writeJSON(w, 404, map[string]any{"error": "LAUNCHER_NOT_FOUND"})
		return
	}
	contextPath := asString(prep["context_path"])
	readyFile := "r005_ui_ready.json"
	if moduleID == "correction-files-engine" {
		readyFile = "r001_ui_ready.json"
	}
	readyPath := filepath.Join(filepath.Dir(contextPath), readyFile)
	if businessStart && (businessReplayState == "PREPARED" || businessReplayState == "LAUNCHING") {
		existingMarker, existingFound := waitForEngineUIReadyV045(readyPath, 100*time.Millisecond)
		existingStatus := strings.ToUpper(asString(existingMarker["status"]))
		if existingFound && existingStatus == "READY" {
			if !setBusinessActionState("READY") {
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ui_ready": true, "run_id": prep["run_id"], "message": "Запуск R005 уже подтверждён.", "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
			return
		}
		if existingFound && existingStatus == "ERROR" {
			if !setBusinessActionState("FAILED") {
				return
			}
			writeJSON(w, http.StatusConflict, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Предыдущий запуск R005 не открыл рабочее окно. Повторите запуск новой командой.", prep["run_id"]))
			return
		}
		if businessReplayState == "LAUNCHING" {
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ui_ready": false, "run_id": prep["run_id"], "message": "Запуск R005 выполняется. Проверьте рабочее окно.", "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
			return
		}
	}
	_ = os.Remove(readyPath)
	if businessStart && !setBusinessActionState("LAUNCHING") {
		return
	}
	args := []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", full, "-ContextPath", contextPath, "-ReadyPath", readyPath}
	extraEnv := map[string]string{}
	if moduleID == "correction-files-engine" {
		extraEnv["OPIU_R001_HANDOFF_PATH"] = asString(prep["r001_handoff_path"])
		extraEnv["OPIU_R001_RUN_ID"] = asString(prep["run_id"])
		extraEnv["OPIU_R001_ORGANIZATION_ID"] = asString(prep["organization_id"])
		extraEnv["OPIU_R001_ORGANIZATION_NAME"] = asString(prep["organization_name"])
		for key, value := range extraEnv {
			if strings.TrimSpace(value) == "" {
				_ = a.logEvent("R001_HANDOFF_CONTEXT_INCOMPLETE_V194", map[string]any{"run_id": prep["run_id"], "field": key})
				writeRulesEnginePublicErrorV194(w, http.StatusConflict, "R001_HANDOFF_CONTEXT_INCOMPLETE", "R001 пока недоступен: не завершена проверка исходного запуска.")
				return
			}
		}
	}
	if e := startDetachedWithEnv("powershell.exe", args, filepath.Dir(full), extraEnv); e != nil {
		if businessStart {
			_ = a.logEvent("R005_BUSINESS_UI_START_FAILED_V194", map[string]any{"module_id": moduleID, "run_id": prep["run_id"], "technical_error": e.Error(), "launcher_path": full})
			if !setBusinessActionState("FAILED") {
				return
			}
			writeJSON(w, 500, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Не удалось открыть рабочее окно R005. Передайте журнал в поддержку.", prep["run_id"]))
			return
		}
		_ = a.logEvent("MODULE_PUBLIC_UI_START_FAILED_V194", map[string]any{"module_id": moduleID, "run_id": prep["run_id"], "technical_error": e.Error(), "launcher_path": full})
		writeRulesEnginePublicErrorV194(w, http.StatusInternalServerError, "ENGINE_UI_START_FAILED", "Не удалось открыть рабочее окно движка. Передайте журнал в поддержку.")
		return
	}
	marker, markerFound := waitForEngineUIReadyV045(readyPath, 6*time.Second)
	status := strings.ToUpper(asString(marker["status"]))
	logPath := filepath.Join(filepath.Dir(full), "ui_loader.log")
	if markerFound && status == "ERROR" {
		message := defaultString(asString(marker["message"]), "Рабочее окно движка не открылось")
		_ = a.logEvent("MODULE_UI_FAILED_V045", map[string]any{"module_id": moduleID, "run_id": prep["run_id"], "context_path": contextPath, "message": message, "log_path": logPath})
		if businessStart {
			if !setBusinessActionState("FAILED") {
				return
			}
			writeJSON(w, 500, sourceProofBusinessErrorResponseV194("R005_START_FAILED", "Рабочее окно R005 сообщило об ошибке. Передайте журнал в поддержку.", prep["run_id"]))
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "ENGINE_UI_FAILED", "message": "Рабочее окно движка сообщило об ошибке. Передайте журнал в поддержку.", "run_id": prep["run_id"], "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
		return
	}
	if markerFound && status == "READY" {
		_ = a.logEvent("MODULE_UI_OPENED_V045", map[string]any{"module_id": moduleID, "run_id": prep["run_id"], "context_path": contextPath, "ready_path": readyPath})
		if businessStart {
			if !setBusinessActionState("READY") {
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true, "ui_ready": true, "run_id": prep["run_id"], "message": "Сверка R005 запущена.", "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
			return
		}
		writeJSON(w, http.StatusOK, enginePublicOpenV194(prep, true, "Рабочее окно движка открыто."))
		return
	}
	_ = a.logEvent("MODULE_UI_LAUNCH_PENDING_V045", map[string]any{"module_id": moduleID, "run_id": prep["run_id"], "context_path": contextPath, "ready_path": readyPath, "log_path": logPath})
	if businessStart {
		if !setBusinessActionState("PENDING") {
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ui_ready": false, "message": "Команда запуска R005 передана. Проверьте рабочее окно.", "run_id": prep["run_id"], "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
		return
	}
	writeJSON(w, http.StatusAccepted, enginePublicOpenV194(prep, false, "Команда запуска передана. Проверьте рабочее окно Windows."))
}

func waitForEngineUIReadyV045(path string, timeout time.Duration) (map[string]any, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil {
			b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
			marker := map[string]any{}
			if json.Unmarshal(b, &marker) == nil && strings.TrimSpace(asString(marker["status"])) != "" {
				return marker, true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return map[string]any{}, false
}

func (a *App) handleEngineCollectV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, _ := decodeJSONBody(r)
	runID := safeID(asString(body["run_id"]))
	if runID == "" {
		settings := map[string]any{}
		_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
		runID = safeID(asString(settings["active_run_id"]))
	}
	if runID == "" {
		writeJSON(w, 400, map[string]any{"error": "RUN_REQUIRED"})
		return
	}
	n, e := a.collectRunArtifactsV041(runID)
	if e != nil {
		_ = a.logEvent("ENGINE_PUBLIC_COLLECT_FAILED_V194", map[string]any{"run_id": runID, "technical_error": e.Error()})
		writeRulesEnginePublicErrorV194(w, http.StatusConflict, "ENGINE_COLLECT_FAILED", "Не удалось обновить список результатов. Передайте журнал в поддержку.")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "run_id": runID, "collected": n, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false})
}
func (a *App) collectActiveRunArtifactsV041() error {
	settings := map[string]any{}
	if readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings) != nil {
		return nil
	}
	id := safeID(asString(settings["active_run_id"]))
	if id == "" {
		return nil
	}
	_, e := a.collectRunArtifactsV041(id)
	return e
}
func (a *App) collectRunArtifactsV041(runID string) (int, error) {
	runs := map[string]any{}
	arts := map[string]any{}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "runs", "index.json"), &runs)
	_ = readJSON(filepath.Join(a.DataRoot, "artifacts", "index.json"), &arts)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	var run map[string]any
	for _, x := range anySlice(runs["runs"]) {
		m, _ := x.(map[string]any)
		if m != nil && asString(m["run_id"]) == runID {
			run = m
			break
		}
	}
	if run == nil {
		return 0, errors.New("запуск не найден")
	}
	list := anySlice(arts["artifacts"])
	seen := map[string]bool{}
	for _, x := range list {
		m, _ := x.(map[string]any)
		if m != nil {
			seen[asString(m["path"])+"|"+asString(m["sha256"])] = true
		}
	}
	count := 0
	r005Found := false
	r001Found := false
	roots := []struct{ stage, dir string }{{"R005", asString(run["r005_output_dir"])}, {"R001", asString(run["r001_output_dir"])}}
	for _, root := range roots {
		if root.dir == "" {
			continue
		}
		_ = filepath.Walk(root.dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil || info.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".xlsx" && ext != ".zip" && ext != ".json" && ext != ".csv" && ext != ".log" {
				return nil
			}
			h, e := fileSHA256V041(path)
			if e != nil {
				return nil
			}
			key := path + "|" + h
			if seen[key] {
				return nil
			}
			typ := artifactTypeV041(path, root.stage)
			id := "ART-" + lastN(h, 16)
			rec := map[string]any{"artifact_id": id, "run_id": runID, "stage": root.stage, "artifact_type": typ, "name": filepath.Base(path), "path": path, "size": info.Size(), "sha256": h, "created_at": info.ModTime().UTC().Format(time.RFC3339), "source_engine": root.stage, "period_mode": run["period_mode"], "period": run["period"], "downloadable": true}
			list = append(list, rec)
			seen[key] = true
			count++
			if root.stage == "R005" && ext == ".xlsx" {
				r005Found = true
			}
			if root.stage == "R001" && (ext == ".zip" || ext == ".xlsx") {
				r001Found = true
			}
			if ext == ".json" {
				a.ingestRuleFeedbackV041(path, runID)
			}
			return nil
		})
	}
	arts["artifacts"] = list
	_ = writeJSONAtomic(filepath.Join(a.DataRoot, "artifacts", "index.json"), arts)
	if r001Found {
		run["stage"] = "R001_COMPLETED"
		settings["workflow_stage"] = "R001_COMPLETED"
	} else if r005Found && asString(run["stage"]) != "RULES_CONFIRMED" {
		run["stage"] = "R005_COMPLETED"
		settings["workflow_stage"] = "R005_COMPLETED"
	}
	run["updated_at"] = nowISO()
	_ = writeJSONAtomic(filepath.Join(a.DataRoot, "runs", "index.json"), runs)
	_ = writeJSONAtomic(filepath.Join(a.ConfigDir, "settings.json"), settings)
	if count > 0 {
		_ = a.logEvent("ENGINE_ARTIFACTS_COLLECTED", map[string]any{"run_id": runID, "count": count})
	}
	return count, nil
}
func artifactTypeV041(path, stage string) string {
	n := strings.ToLower(filepath.Base(path))
	if strings.Contains(n, "codex-input") {
		return "EVIDENCE_JSON"
	}
	if strings.Contains(n, "manifest") || strings.Contains(n, "passport") || strings.Contains(n, "паспорт") {
		return "MANIFEST"
	}
	if strings.Contains(n, "rule") || strings.Contains(n, "правил") {
		return "RULE_FEEDBACK"
	}
	if filepath.Ext(n) == ".zip" {
		return "CORRECTION_PACKAGE_ZIP"
	}
	if stage == "R005" && filepath.Ext(n) == ".xlsx" {
		return "RECONCILIATION_REPORT"
	}
	if stage == "R001" && filepath.Ext(n) == ".xlsx" {
		return "CORRECTION_WORKBOOK"
	}
	return "ENGINE_ARTIFACT"
}
func (a *App) ingestRuleFeedbackV041(path, runID string) {
	name := strings.ToLower(filepath.Base(path))
	if !strings.Contains(name, "rule_results") && !strings.Contains(name, "rule_candidates") && !strings.Contains(name, "rule_feedback") {
		return
	}
	doc := map[string]any{}
	if readJSON(path, &doc) != nil {
		return
	}
	reg := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &reg)
	for _, x := range anySlice(doc["candidates"]) {
		m, _ := x.(map[string]any)
		if m == nil {
			continue
		}
		m["rule_id"] = defaultString(asString(m["rule_id"]), newID("RULE-ENGINE"))
		m["origin_rule_id"] = defaultString(asString(m["origin_rule_id"]), asString(m["rule_id"]))
		m["revision_id"] = defaultString(asString(m["revision_id"]), newRevisionIDV041(asString(m["rule_id"])))
		m["rule_type"] = "imported"
		m["status"] = "REVIEW"
		m["enabled"] = false
		m["is_current"] = true
		m["source"] = map[string]any{"kind": "engine_feedback", "run_id": runID, "file": filepath.Base(path)}
		ensureRuleNoApplicationsV041(m)
		m["content_hash"] = ruleSemanticHashV041(m)
		reg["rules"] = append(anySlice(reg["rules"]), m)
		reg["revisions"] = append(anySlice(reg["revisions"]), cloneMap(m))
	}
	for _, x := range anySlice(doc["applications"]) {
		m, _ := x.(map[string]any)
		if m != nil {
			m["application_id"] = defaultString(asString(m["application_id"]), newID("APP"))
			m["run_id"] = runID
			reg["applications"] = append(anySlice(reg["applications"]), m)
		}
	}
	_ = writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), reg)
}

func (a *App) handleArtifactDownloadV041(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	id := safeID(r.URL.Query().Get("id"))
	arts := map[string]any{}
	_ = readJSON(filepath.Join(a.DataRoot, "artifacts", "index.json"), &arts)
	for _, x := range anySlice(arts["artifacts"]) {
		m, _ := x.(map[string]any)
		if m != nil && asString(m["artifact_id"]) == id {
			p := asString(m["path"])
			clean := filepath.Clean(p)
			base := filepath.Clean(a.DataRoot) + string(os.PathSeparator)
			if !strings.HasPrefix(clean+string(os.PathSeparator), base) {
				writeJSON(w, 403, map[string]any{"error": "INVALID_PATH"})
				return
			}
			serveDownload(w, r, p, filepath.Base(p))
			return
		}
	}
	writeJSON(w, 404, map[string]any{"error": "ARTIFACT_NOT_FOUND"})
}

// Keep exec imported on all targets when this file is built with the installer.
var _ = exec.ErrNotFound
var _ = url.QueryEscape
