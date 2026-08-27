package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const erpAccountCatalogTypeV194 = "CHART_OF_ACCOUNTS"

var mxlTextCellV194 = regexp.MustCompile(`(?s)\{16,\d+,\s*\{1,1,\s*\{"#","((?:""|[^"])*)"\}\s*\},0\},(\d+)`)

type erpAccountCatalogItemV194 struct {
	AccountID string `json:"account_id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
}

type erpAccountCatalogV194 struct {
	VersionID string
	Items     []erpAccountCatalogItemV194
	ByID      map[string]erpAccountCatalogItemV194
}

func publicRuleArticleCatalogItemsV194(value any) []any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []any{}
	}
	rawItems := []map[string]any{}
	if err := json.Unmarshal(encoded, &rawItems); err != nil {
		return []any{}
	}
	items := make([]any, 0, len(rawItems))
	for _, raw := range rawItems {
		articlePath := strings.TrimSpace(defaultString(asString(raw["article_path"]), asString(raw["path"])))
		items = append(items, map[string]any{
			"code":         raw["code"],
			"name":         raw["name"],
			"article":      raw["article"],
			"article_path": articlePath,
			"path":         articlePath,
			"block":        raw["block"],
		})
	}
	return items
}

func accountCatalogIDV194(versionID, code string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(versionID) + "|" + strings.ToUpper(strings.TrimSpace(code))))
	return "ACC-" + strings.ToUpper(hex.EncodeToString(sum[:8]))
}

func resolvedRegularFileWithinV194(root, candidate string) (string, error) {
	rootAbs, err := filepath.Abs(filepath.Clean(strings.TrimSpace(root)))
	if err != nil {
		return "", errors.New("catalog root is invalid")
	}
	candidateAbs, err := filepath.Abs(filepath.Clean(strings.TrimSpace(candidate)))
	if err != nil {
		return "", errors.New("catalog path is invalid")
	}
	rootResolved, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return "", errors.New("catalog root is unavailable")
	}
	candidateResolved, err := filepath.EvalSymlinks(candidateAbs)
	if err != nil {
		return "", errors.New("catalog file is unavailable")
	}
	relative, err := filepath.Rel(rootResolved, candidateResolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return "", errors.New("catalog resolved path is outside data root")
	}
	info, err := os.Lstat(candidateAbs)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("catalog file is not a regular pinned file")
	}
	return candidateResolved, nil
}

func appendMXLAccountRowV194(rows *[]map[int]string, row map[int]string) {
	if len(row) == 0 {
		return
	}
	copyRow := map[int]string{}
	for key, value := range row {
		copyRow[key] = value
	}
	*rows = append(*rows, copyRow)
}

func parseERPAccountCatalogMXLV194(data []byte, versionID string) ([]erpAccountCatalogItemV194, error) {
	if len(data) < 16 || !bytes.HasPrefix(data, []byte("MOXCEL")) {
		return nil, errors.New("invalid ERP account catalog format")
	}
	matches := mxlTextCellV194.FindAllStringSubmatch(string(data), -1)
	if len(matches) == 0 {
		return nil, errors.New("ERP account catalog has no readable cells")
	}
	rows := []map[int]string{}
	row := map[int]string{}
	lastColumn := -1
	for _, match := range matches {
		column, err := strconv.Atoi(match[2])
		if err != nil {
			return nil, errors.New("ERP account catalog column is invalid")
		}
		if lastColumn >= 0 && column <= lastColumn {
			appendMXLAccountRowV194(&rows, row)
			row = map[int]string{}
		}
		row[column] = strings.TrimSpace(strings.ReplaceAll(match[1], `""`, `"`))
		lastColumn = column
	}
	appendMXLAccountRowV194(&rows, row)

	headerSeen := false
	seenCodes := map[string]bool{}
	items := []erpAccountCatalogItemV194{}
	for _, current := range rows {
		code := strings.TrimSpace(current[1])
		name := strings.TrimSpace(current[2])
		if strings.EqualFold(code, "Код счета") && strings.EqualFold(name, "Наименование счета") {
			headerSeen = true
			continue
		}
		if strings.EqualFold(code, "Exception") && strings.EqualFold(name, "Exception") {
			continue
		}
		if !headerSeen || code == "" || name == "" || len(code) > 64 || len(name) > 512 {
			continue
		}
		key := strings.ToUpper(code)
		if seenCodes[key] {
			continue
		}
		seenCodes[key] = true
		items = append(items, erpAccountCatalogItemV194{
			AccountID: accountCatalogIDV194(versionID, code),
			Code:      code,
			Name:      name,
		})
	}
	if !headerSeen || len(items) == 0 {
		return nil, errors.New("ERP account catalog table is missing")
	}
	sort.SliceStable(items, func(i, j int) bool {
		return strings.ToUpper(items[i].Code) < strings.ToUpper(items[j].Code)
	})
	return items, nil
}

func (a *App) erpAccountCatalogV194() (erpAccountCatalogV194, error) {
	status := a.referenceStatusV060()
	erp, _ := status["erp_shared"].(map[string]any)
	if erp == nil || asString(erp["status"]) != "PINNED" {
		return erpAccountCatalogV194{}, errors.New("ERP reference is not pinned")
	}
	catalogSetID := strings.TrimSpace(asString(erp["catalog_set_id"]))
	manifestPath := strings.TrimSpace(asString(erp["manifest_path"]))
	if catalogSetID == "" || manifestPath == "" {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog identity is missing")
	}
	if !filepath.IsAbs(manifestPath) {
		manifestPath = filepath.Join(a.DataRoot, filepath.FromSlash(manifestPath))
	}
	manifestPath, err := resolvedRegularFileWithinV194(a.DataRoot, manifestPath)
	if err != nil {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog manifest is outside data root")
	}
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return erpAccountCatalogV194{}, err
	}
	manifestSum := sha256.Sum256(manifestData)
	manifestSHA := strings.ToUpper(hex.EncodeToString(manifestSum[:]))
	manifest := map[string]any{}
	if err := json.Unmarshal(manifestData, &manifest); err != nil || asString(manifest["status"]) != "PINNED" || strings.TrimSpace(asString(manifest["catalog_set_id"])) != catalogSetID {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog manifest identity mismatch")
	}
	var selected map[string]any
	for _, raw := range anySlice(manifest["catalogs"]) {
		catalog, _ := raw.(map[string]any)
		if catalog != nil && asString(catalog["role"]) == "chart_of_accounts" && asString(catalog["status"]) == "PINNED" && strings.ToUpper(strings.TrimSpace(asString(catalog["catalog_type"]))) == erpAccountCatalogTypeV194 {
			if selected != nil {
				return erpAccountCatalogV194{}, errors.New("ERP account catalog is ambiguous")
			}
			selected = catalog
		}
	}
	if selected == nil {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog is missing")
	}
	storedFile := strings.TrimSpace(asString(selected["stored_file"]))
	cleanStoredFile := filepath.Clean(storedFile)
	if storedFile == "" || filepath.IsAbs(storedFile) || cleanStoredFile == ".." || strings.HasPrefix(cleanStoredFile, ".."+string(os.PathSeparator)) {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog storage identity is invalid")
	}
	catalogPath, err := resolvedRegularFileWithinV194(a.DataRoot, filepath.Join(filepath.Dir(manifestPath), filepath.FromSlash(storedFile)))
	if err != nil {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog is outside data root")
	}
	data, err := os.ReadFile(catalogPath)
	if err != nil {
		return erpAccountCatalogV194{}, err
	}
	sum := sha256.Sum256(data)
	actualSHA := strings.ToUpper(hex.EncodeToString(sum[:]))
	expectedSHA := strings.ToUpper(strings.TrimSpace(asString(selected["sha256"])))
	if expectedSHA == "" || actualSHA != expectedSHA {
		return erpAccountCatalogV194{}, errors.New("ERP account catalog integrity mismatch")
	}
	versionSum := sha256.Sum256([]byte(catalogSetID + "|" + manifestSHA + "|" + actualSHA))
	versionID := "ERPACCT-" + strings.ToUpper(hex.EncodeToString(versionSum[:16]))
	items, err := parseERPAccountCatalogMXLV194(data, versionID)
	if err != nil {
		return erpAccountCatalogV194{}, err
	}
	byID := map[string]erpAccountCatalogItemV194{}
	for _, item := range items {
		if _, exists := byID[item.AccountID]; exists {
			return erpAccountCatalogV194{}, errors.New("ERP account catalog identifier collision")
		}
		byID[item.AccountID] = item
	}
	return erpAccountCatalogV194{VersionID: versionID, Items: items, ByID: byID}, nil
}

func (a *App) handleRuleCatalogV194(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	system := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("system")))
	catalogType := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("catalog")))
	if catalogType == "" || catalogType == "OPIU_ARTICLES" {
		if system != "ERP" && system != "INTALEV" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "SYSTEM_REQUIRED"})
			return
		}
		items, _ := a.ruleCatalogItemsV180(system)
		publicItems := publicRuleArticleCatalogItemsV194(items)
		writeJSON(w, http.StatusOK, map[string]any{"system": system, "catalog": "OPIU_ARTICLES", "items": publicItems, "count": len(publicItems)})
		return
	}
	if system != "ERP" || catalogType != erpAccountCatalogTypeV194 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "CATALOG_REQUIRED", "message": "Выберите доступный справочник ERP."})
		return
	}
	catalog, err := a.erpAccountCatalogV194()
	if err != nil {
		_ = a.logEvent("ERP_ACCOUNT_CATALOG_BLOCKED_V194", map[string]any{"technical_error": err.Error()})
		writeJSON(w, http.StatusConflict, map[string]any{"error": "ERP_ACCOUNT_CATALOG_UNAVAILABLE", "message": "План счетов ERP не готов. Обновите справочники ERP и повторите."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"system":             "ERP",
		"catalog":            erpAccountCatalogTypeV194,
		"catalog_version_id": catalog.VersionID,
		"items":              catalog.Items,
		"count":              len(catalog.Items),
		"report_only":        true,
		"posting_rows":       0,
		"ready_to_upload":    false,
		"release_allowed":    false,
		"live_1c_allowed":    false,
	})
}

func (a *App) bindRulesEngineAccountSelectionsV194(decisions []any) error {
	var catalog erpAccountCatalogV194
	catalogLoaded := false
	for _, raw := range decisions {
		decision, _ := raw.(map[string]any)
		edited, _ := decision["edited_rule"].(map[string]any)
		if edited == nil {
			continue
		}
		accounting, _ := edited["accounting"].(map[string]any)
		selection, _ := edited["account_selection"].(map[string]any)
		callerDebit := ""
		callerCredit := ""
		if accounting != nil {
			callerDebit = strings.TrimSpace(asString(accounting["debit_account"]))
			callerCredit = strings.TrimSpace(asString(accounting["credit_account"]))
		}
		if selection == nil {
			if callerDebit != "" || callerCredit != "" {
				return errors.New("ERP_ACCOUNT_SELECTION_REQUIRED")
			}
			continue
		}
		if !catalogLoaded {
			var err error
			catalog, err = a.erpAccountCatalogV194()
			if err != nil {
				return errors.New("ERP_ACCOUNT_CATALOG_UNAVAILABLE")
			}
			catalogLoaded = true
		}
		if strings.TrimSpace(asString(selection["catalog_version_id"])) != catalog.VersionID {
			return errors.New("ERP_ACCOUNT_CATALOG_VERSION_MISMATCH")
		}
		resolve := func(key string) (string, error) {
			id := strings.TrimSpace(asString(selection[key]))
			if id == "" {
				return "", nil
			}
			item, ok := catalog.ByID[id]
			if !ok {
				return "", errors.New("ERP_ACCOUNT_NOT_IN_PINNED_CATALOG")
			}
			return item.Code, nil
		}
		debit, err := resolve("debit_account_id")
		if err != nil {
			return err
		}
		credit, err := resolve("credit_account_id")
		if err != nil {
			return err
		}
		if debit == "" && credit == "" {
			return errors.New("ERP_ACCOUNT_SELECTION_EMPTY")
		}
		if accounting == nil {
			accounting = map[string]any{}
		}
		if callerDebit != "" && callerDebit != debit || callerCredit != "" && callerCredit != credit {
			return errors.New("ERP_ACCOUNT_TEXT_OVERRIDE_FORBIDDEN")
		}
		accounting["debit_account"] = debit
		accounting["credit_account"] = credit
		edited["accounting"] = accounting
	}
	return nil
}

func ruleSaveRequestsActivationV194(body map[string]any) bool {
	status := strings.ToUpper(strings.TrimSpace(asString(body["status"])))
	return asBool(body["enabled"]) || status == "CURRENT" || status == "ACTIVE" || status == "CONFIRMED"
}

func ruleSaveHasERPAccountTextV194(mapping map[string]any) bool {
	accounting, _ := mapping["accounting"].(map[string]any)
	if accounting != nil {
		for _, key := range []string{"debit_account", "credit_account", "erp_debit_account", "erp_credit_account"} {
			if strings.TrimSpace(asString(accounting[key])) != "" {
				return true
			}
		}
	}
	for _, key := range []string{"erp_source", "erp_target"} {
		side, _ := mapping[key].(map[string]any)
		if side != nil && strings.TrimSpace(asString(side["account"])) != "" {
			return true
		}
	}
	return false
}

func (a *App) bindRuleSaveERPAccountSelectionV194(body map[string]any) error {
	mapping, _ := body["mapping"].(map[string]any)
	if mapping == nil {
		return nil
	}
	selection, _ := mapping["account_selection"].(map[string]any)
	if selection == nil {
		if ruleSaveRequestsActivationV194(body) && ruleSaveHasERPAccountTextV194(mapping) {
			return errors.New("ERP_ACCOUNT_SELECTION_REQUIRED_FOR_ACTIVE_RULE")
		}
		return nil
	}
	accounting, _ := mapping["accounting"].(map[string]any)
	edited := map[string]any{"account_selection": selection, "accounting": accounting}
	decisions := []any{map[string]any{"edited_rule": edited}}
	if err := a.bindRulesEngineAccountSelectionsV194(decisions); err != nil {
		return err
	}
	boundAccounting, _ := edited["accounting"].(map[string]any)
	mapping["accounting"] = boundAccounting
	legacy := strings.Trim(strings.Join([]string{asString(boundAccounting["debit_account"]), asString(boundAccounting["credit_account"])}, " / "), " / ")
	for _, key := range []string{"erp_source", "erp_target"} {
		side, _ := mapping[key].(map[string]any)
		if side == nil {
			side = map[string]any{}
			mapping[key] = side
		}
		side["account"] = legacy
	}
	return nil
}
