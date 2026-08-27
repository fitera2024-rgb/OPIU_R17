package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mxlAccountCellV194(value string, column int) string {
	return "{16,1,{1,1,{\"#\",\"" + strings.ReplaceAll(value, "\"", "\"\"") + "\"}},0}," + asString(column)
}

func syntheticERPAccountCatalogV194() []byte {
	rows := [][]string{
		{"Код счета", "Наименование счета"},
		{"26", "Общехозяйственные расходы"},
		{"79.1", "Внутрихозяйственные расчёты"},
		{"Z01", "Служебный счет"},
		{"26", "Дубликат не должен создавать второй вариант"},
		{"Exception", "Exception"},
	}
	var builder strings.Builder
	builder.WriteString("MOXCEL\n")
	for _, row := range rows {
		builder.WriteString(mxlAccountCellV194(row[0], 1))
		builder.WriteByte('\n')
		builder.WriteString(mxlAccountCellV194(row[1], 2))
		builder.WriteByte('\n')
	}
	return []byte(builder.String())
}

func installERPAccountCatalogV194(t *testing.T, app *App) erpAccountCatalogV194 {
	t.Helper()
	base := filepath.Join(app.DataRoot, "reference", "erp_shared", "versions", "ERP-ACCOUNTS-TEST")
	if err := os.MkdirAll(base, 0755); err != nil {
		t.Fatal(err)
	}
	data := syntheticERPAccountCatalogV194()
	catalogPath := filepath.Join(base, "accounts.mxl")
	if err := os.WriteFile(catalogPath, data, 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	digest := strings.ToUpper(hex.EncodeToString(sum[:]))
	manifestPath := filepath.Join(base, "manifest.json")
	if err := writeJSONAtomic(manifestPath, map[string]any{
		"status": "PINNED", "catalog_set_id": "ERP-ACCOUNTS-TEST",
		"catalogs": []any{map[string]any{
			"role": "chart_of_accounts", "status": "PINNED", "catalog_type": erpAccountCatalogTypeV194,
			"stored_file": "accounts.mxl", "sha256": digest, "items_count": 5,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	activePath := filepath.Join(app.DataRoot, "reference", "erp_shared", "active.json")
	if err := writeJSONAtomic(activePath, map[string]any{
		"catalog_set_id": "ERP-ACCOUNTS-TEST",
		"manifest_path":  filepath.ToSlash(strings.TrimPrefix(manifestPath, app.DataRoot+string(os.PathSeparator))),
	}); err != nil {
		t.Fatal(err)
	}
	catalog, err := app.erpAccountCatalogV194()
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestERPAccountCatalogUsesExactPinnedMXLAndSanitizedDTO(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	catalog := installERPAccountCatalogV194(t, app)
	if !strings.HasPrefix(catalog.VersionID, "ERPACCT-") || len(catalog.VersionID) != 40 || len(catalog.Items) != 3 {
		t.Fatalf("unexpected account catalog: %#v", catalog)
	}
	for _, code := range []string{"26", "79.1", "Z01"} {
		found := false
		for _, item := range catalog.Items {
			found = found || item.Code == code
		}
		if !found {
			t.Fatalf("account %s is missing: %#v", code, catalog.Items)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/rule-catalog?system=ERP&catalog=CHART_OF_ACCOUNTS", nil)
	recorder := httptest.NewRecorder()
	app.handleRuleCatalogV194(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("catalog endpoint failed: %d %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(recorder.Body.String())
	for _, forbidden := range []string{"source_file", "manifest_path", "stored_file", "sha256", app.DataRoot} {
		if strings.Contains(encoded, strings.ToLower(forbidden)) {
			t.Fatalf("technical catalog state leaked through public DTO: %s", recorder.Body.String())
		}
	}
	if int(asFloat(payload["posting_rows"])) != 0 || asBool(payload["ready_to_upload"]) || asBool(payload["release_allowed"]) || asBool(payload["live_1c_allowed"]) {
		t.Fatalf("unsafe catalog DTO: %#v", payload)
	}
}

func TestERPAccountCatalogVersionChangesWhenPinnedBytesChangeUnderSameSetID(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	first := installERPAccountCatalogV194(t, app)
	base := filepath.Join(app.DataRoot, "reference", "erp_shared", "versions", "ERP-ACCOUNTS-TEST")
	catalogPath := filepath.Join(base, "accounts.mxl")
	changed := append(syntheticERPAccountCatalogV194(), []byte(mxlAccountCellV194("44", 1)+"\n"+mxlAccountCellV194("Расходы на продажу", 2)+"\n")...)
	if err := os.WriteFile(catalogPath, changed, 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(changed)
	if err := writeJSONAtomic(filepath.Join(base, "manifest.json"), map[string]any{
		"status": "PINNED", "catalog_set_id": "ERP-ACCOUNTS-TEST",
		"catalogs": []any{map[string]any{
			"role": "chart_of_accounts", "status": "PINNED", "catalog_type": erpAccountCatalogTypeV194,
			"stored_file": "accounts.mxl", "sha256": strings.ToUpper(hex.EncodeToString(sum[:])),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	second, err := app.erpAccountCatalogV194()
	if err != nil {
		t.Fatal(err)
	}
	if first.VersionID == second.VersionID {
		t.Fatal("catalog version did not change when exact pinned bytes changed")
	}
	if first.Items[0].AccountID == second.Items[0].AccountID {
		t.Fatal("opaque account IDs were not rebound to exact catalog bytes")
	}
}

func TestERPAccountCatalogRejectsResolvedParentLinkOutsideDataRoot(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	installERPAccountCatalogV194(t, app)
	base := filepath.Join(app.DataRoot, "reference", "erp_shared", "versions", "ERP-ACCOUNTS-TEST")
	outside := t.TempDir()
	data := syntheticERPAccountCatalogV194()
	if err := os.WriteFile(filepath.Join(outside, "accounts.mxl"), data, 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "linked-parent")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("directory symlink is unavailable on this host: %v", err)
	}
	sum := sha256.Sum256(data)
	if err := writeJSONAtomic(filepath.Join(base, "manifest.json"), map[string]any{
		"status": "PINNED", "catalog_set_id": "ERP-ACCOUNTS-TEST",
		"catalogs": []any{map[string]any{
			"role": "chart_of_accounts", "status": "PINNED", "catalog_type": erpAccountCatalogTypeV194,
			"stored_file": filepath.ToSlash(filepath.Join("linked-parent", "accounts.mxl")), "sha256": strings.ToUpper(hex.EncodeToString(sum[:])),
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := app.erpAccountCatalogV194(); err == nil {
		t.Fatal("catalog through an escaping parent link was accepted")
	}
}

func TestPublicRuleArticleCatalogAllowlistDropsTechnicalFields(t *testing.T) {
	items := publicRuleArticleCatalogItemsV194([]any{map[string]any{
		"code": "R025", "name": "Мат помощь", "path": "Расходы / Мат помощь", "block": "Расходы",
		"source_file": `C:\secret\articles.xlsx`, "source_row": "15", "sha256": strings.Repeat("A", 64),
	}})
	encoded, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, forbidden := range []string{"source_file", "source_row", "sha256", `C:\secret`, strings.Repeat("A", 64)} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("technical article catalog state leaked: %s", body)
		}
	}
	if !strings.Contains(body, "Расходы / Мат помощь") {
		t.Fatalf("business article path was removed: %s", body)
	}
}

func TestERPAccountSelectionBindsOpaqueIDsAndRejectsTextOverride(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	catalog := installERPAccountCatalogV194(t, app)
	debitID := ""
	creditID := ""
	for _, item := range catalog.Items {
		if item.Code == "26" {
			debitID = item.AccountID
		}
		if item.Code == "79.1" {
			creditID = item.AccountID
		}
	}
	decisions := []any{map[string]any{"edited_rule": map[string]any{
		"account_selection": map[string]any{
			"catalog_version_id": catalog.VersionID,
			"debit_account_id":   debitID, "credit_account_id": creditID,
		},
	}}}
	if err := app.bindRulesEngineAccountSelectionsV194(decisions); err != nil {
		t.Fatal(err)
	}
	edited := decisions[0].(map[string]any)["edited_rule"].(map[string]any)
	accounting := edited["accounting"].(map[string]any)
	if asString(accounting["debit_account"]) != "26" || asString(accounting["credit_account"]) != "79.1" {
		t.Fatalf("account IDs were not resolved exactly: %#v", accounting)
	}

	for name, selection := range map[string]map[string]any{
		"unknown account": {"catalog_version_id": catalog.VersionID, "debit_account_id": "ACC-FORGED"},
		"stale catalog":   {"catalog_version_id": "ERP-OLD", "debit_account_id": debitID},
		"empty selection": {"catalog_version_id": catalog.VersionID},
	} {
		t.Run(name, func(t *testing.T) {
			input := []any{map[string]any{"edited_rule": map[string]any{"account_selection": selection}}}
			if err := app.bindRulesEngineAccountSelectionsV194(input); err == nil {
				t.Fatal("forged account selection was accepted")
			}
		})
	}
	textOverride := []any{map[string]any{"edited_rule": map[string]any{
		"accounting":        map[string]any{"debit_account": "99"},
		"account_selection": map[string]any{"catalog_version_id": catalog.VersionID, "debit_account_id": debitID},
	}}}
	if err := app.bindRulesEngineAccountSelectionsV194(textOverride); err == nil {
		t.Fatal("caller-supplied account text override was accepted")
	}
}

func TestRuleSaveCannotActivateFreeTextERPAccounts(t *testing.T) {
	app, _ := newRulesEngineTestApp(t)
	catalog := installERPAccountCatalogV194(t, app)
	activeFreeText := map[string]any{
		"status": "CURRENT", "enabled": true,
		"mapping": map[string]any{"accounting": map[string]any{"debit_account": "99", "credit_account": "79.1"}},
	}
	if err := app.bindRuleSaveERPAccountSelectionV194(activeFreeText); err == nil {
		t.Fatal("active rule with free-text ERP accounts was accepted")
	}
	draftFreeText := map[string]any{
		"status": "DRAFT", "enabled": false,
		"mapping": map[string]any{"accounting": map[string]any{"debit_account": "99"}},
	}
	if err := app.bindRuleSaveERPAccountSelectionV194(draftFreeText); err != nil {
		t.Fatalf("report-only draft was unexpectedly rejected: %v", err)
	}
	debitID := ""
	for _, item := range catalog.Items {
		if item.Code == "26" {
			debitID = item.AccountID
		}
	}
	activeOpaque := map[string]any{
		"status": "CURRENT", "enabled": true,
		"mapping": map[string]any{
			"account_selection": map[string]any{"catalog_version_id": catalog.VersionID, "debit_account_id": debitID},
			"accounting":        map[string]any{},
		},
	}
	if err := app.bindRuleSaveERPAccountSelectionV194(activeOpaque); err != nil {
		t.Fatalf("exact opaque rule account selection was rejected: %v", err)
	}
	mapping := activeOpaque["mapping"].(map[string]any)
	accounting := mapping["accounting"].(map[string]any)
	if asString(accounting["debit_account"]) != "26" {
		t.Fatalf("opaque rule account was not resolved exactly: %#v", accounting)
	}
}

func TestRulesApplyDirectAPIRejectsStaleCandidateAndForgedAccountBeforeMutation(t *testing.T) {
	app, runID := newRulesEngineTestApp(t)
	catalog := installERPAccountCatalogV194(t, app)
	outputDir := filepath.Join(app.DataRoot, "runs", runID, "rules-output", "RULES-TEST")
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		t.Fatal(err)
	}
	candidate := map[string]any{"candidate_id": "CAND-1", "source_payload_hash": strings.Repeat("A", 64), "user_status": "PENDING_REVIEW"}
	candidatesPath := filepath.Join(outputDir, "rule_candidates.json")
	if err := writeJSONAtomic(candidatesPath, map[string]any{"run_id": runID, "candidates": []any{candidate}}); err != nil {
		t.Fatal(err)
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	run, _ := anySlice(runs["runs"])[0].(map[string]any)
	run["rules_output_dir"] = outputDir
	run["rules_execution_id"] = "RULES-TEST"
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "runs", "index.json"), runs); err != nil {
		t.Fatal(err)
	}
	revisionContext, err := rulesEngineRevisionContextFromRunV194(run)
	if err != nil {
		t.Fatal(err)
	}
	candidatesHash, err := fileSHA256V041(candidatesPath)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "artifacts", "index.json"), &artifacts); err != nil {
		t.Fatal(err)
	}
	artifacts["artifacts"] = append(anySlice(artifacts["artifacts"]), map[string]any{
		"artifact_id": "ART-RULE-CANDIDATES", "run_id": runID, "stage": "RULES", "artifact_type": "RULE_CANDIDATES",
		"path": candidatesPath, "sha256": candidatesHash, "rules_execution_id": "RULES-TEST", "created_at": "2026-08-11T00:00:00Z",
	})
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), artifacts); err != nil {
		t.Fatal(err)
	}
	decisionPath := filepath.Join(app.DataRoot, "runs", runID, "context", "user_rule_decisions.json")

	cases := []struct {
		name     string
		revision string
		account  string
	}{
		{"stale candidate", "CRV-STALE", ""},
		{"forged account", rulesEngineCandidateRevisionV194(candidate, revisionContext), "ACC-FORGED"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"run_id": runID, "organization_id": "ORG-1",
				"decisions": []any{map[string]any{
					"candidate_id": "CAND-1", "candidate_revision_id": tc.revision, "decision": "MANUAL_REVIEW",
					"edited_rule": map[string]any{"account_selection": map[string]any{
						"catalog_version_id": catalog.VersionID, "debit_account_id": tc.account,
					}},
				}},
			})
			recorder := httptest.NewRecorder()
			app.handleRulesEngineApplyDecisions(recorder, httptest.NewRequest(http.MethodPost, "/api/rules-engine/apply-decisions", bytes.NewReader(body)))
			if recorder.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if fileExists(decisionPath) {
				t.Fatalf("rejected direct API call persisted a decision: %s", decisionPath)
			}
		})
	}
}
