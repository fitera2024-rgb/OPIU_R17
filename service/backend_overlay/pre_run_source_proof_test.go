package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newPreRunTestAppV194(t *testing.T) *App {
	t.Helper()
	app, _ := newRulesEngineTestApp(t)
	settings := map[string]any{
		"active_run_id": "", "workflow_stage": "INPUTS_PENDING",
		"source_proof_required": true,
		"organization_id":       "ORG-1", "organization_name": "Organization 1",
		"organization_path": "Holding / Organization 1", "period_mode": "month",
		"period": "2025-01", "author": "QA", "include_descendants": false,
		"input_roles": map[string]any{"intalev": "stale-intalev.xlsx", "erp": "stale-erp.xlsx"},
	}
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "runs", "index.json"), map[string]any{"runs": []any{}}); err != nil {
		t.Fatal(err)
	}
	return app
}

func writeSourceV194(t *testing.T, root, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func sourceSpecV194(t *testing.T, role, rootID, root string, selectFile bool, blockers ...string) (map[string]any, map[string]any) {
	t.Helper()
	files, digest, scanBlockers, err := scanSourceRootV194(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(scanBlockers) > 0 && len(files) > 0 {
		t.Fatalf("unexpected scan blockers: %v", scanBlockers)
	}
	request := map[string]any{
		"role": role, "root_id": rootID, "path": root,
	}
	if selectFile && len(files) > 0 {
		request["selected_file_sha256"] = files[0].SHA256
	}
	evidenceFiles := []any{}
	for _, file := range files {
		evidenceFiles = append(evidenceFiles, map[string]any{"sha256": file.SHA256, "bytes": file.Size})
	}
	evidenceBlockers := []any{}
	status := "PASS"
	for _, code := range blockers {
		evidenceBlockers = append(evidenceBlockers, map[string]any{"code": code})
		status = "BLOCKED_SOURCE_PROOF"
		if strings.HasPrefix(code, "DATA_BLOCKED") {
			status = "DATA_BLOCKED"
		}
	}
	evidence := map[string]any{
		"root_id": rootID, "organization_id": "ORG-1", "declared_system": role,
		"expected_organization": "Organization 1",
		"expected_period":       "2025-01", "files": evidenceFiles, "blockers": evidenceBlockers,
		"package_digest": digest, "status": status,
	}
	return request, evidence
}

func bindEvidenceV194(t *testing.T, app *App, proof map[string]any, roots ...map[string]any) {
	t.Helper()
	evidencePath := filepath.Join(app.InputsDir, "approved", "SOURCE_INVENTORY.json")
	document := map[string]any{
		"schema": "opiu-issue-59-source-preflight-test-v1", "report_only": true,
		"posting_rows": 0, "ready_to_upload": false, "release_allowed": false,
		"raw_business_bytes_committed": false,
	}
	items := []any{}
	for _, root := range roots {
		items = append(items, root)
	}
	document["roots"] = items
	if err := writeJSONAtomic(evidencePath, document); err != nil {
		t.Fatal(err)
	}
	evidenceSHA256, err := fileSHA256V041(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	proof["evidence_path"] = evidencePath
	proof["approved_evidence_sha256"] = evidenceSHA256
	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	settings["approved_source_evidence_sha256"] = evidenceSHA256
	if err := writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings); err != nil {
		t.Fatal(err)
	}
}

func validProofBodyV194(t *testing.T, app *App) (map[string]any, string) {
	t.Helper()
	intalevRoot := filepath.Join(app.InputsDir, "approved", "intalev")
	erpRoot := filepath.Join(app.InputsDir, "approved", "erp")
	writeSourceV194(t, intalevRoot, "intalev.xlsx", "intalev-source-v1")
	writeSourceV194(t, erpRoot, "erp.xlsx", "erp-source-v1")
	intalevRequest, intalevEvidence := sourceSpecV194(t, "INTALEV", "INTALEV-ROOT", intalevRoot, true)
	erpRequest, erpEvidence := sourceSpecV194(t, "ERP", "ERP-ROOT", erpRoot, true)
	proof := map[string]any{
		"organization_id": "ORG-1", "organization_name": "Organization 1",
		"period_mode": "month", "period": "2025-01",
		"source_roots": []any{intalevRequest, erpRequest},
	}
	bindEvidenceV194(t, app, proof, intalevEvidence, erpEvidence)
	body := map[string]any{
		"module_id": "reconciliation-engine", "preflight_only": true,
		"source_proof": proof,
	}
	return body, erpRoot
}

func blockerCodesFromErrorV194(t *testing.T, err error) []string {
	t.Helper()
	blocked, ok := err.(*preRunSourceBlockedErrorV194)
	if !ok {
		t.Fatalf("expected pre-run blocked error, got %T: %v", err, err)
	}
	return stringSliceV194(blocked.Result["blocker_codes"])
}

func requireBlockerV194(t *testing.T, codes []string, expected string) {
	t.Helper()
	for _, code := range codes {
		if code == expected {
			return
		}
	}
	t.Fatalf("missing blocker %s in %v", expected, codes)
}

func assertNoFinancialRunV194(t *testing.T, app *App) {
	t.Helper()
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 0 {
		t.Fatalf("blocked preflight allocated a RUN: %#v", runs)
	}
	settings := map[string]any{}
	if err := readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings); err != nil {
		t.Fatal(err)
	}
	if asString(settings["active_run_id"]) != "" || asString(settings["workflow_stage"]) != "INPUTS_PENDING" {
		t.Fatalf("blocked preflight mutated active context: %#v", settings)
	}
}

func registerR005ArtifactsV194(t *testing.T, app *App, runID string) {
	t.Helper()
	outputDir := filepath.Join(app.DataRoot, "runs", runID, "r005-output")
	reportPath := writeSourceV194(t, outputDir, "reconciliation.xlsx", "r005-report")
	sidecarPath := writeSourceV194(t, outputDir, "reconciliation.codex-input.json", `{"schema":"opiu-codex-review-input-v1","rows":[]}`)
	reportSHA256, err := fileSHA256V041(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	sidecarSHA256, err := fileSHA256V041(sidecarPath)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := map[string]any{"artifacts": []any{
		map[string]any{"artifact_id": "ART-R005-REPORT", "run_id": runID, "stage": "R005", "artifact_type": "RECONCILIATION_REPORT", "path": reportPath, "sha256": reportSHA256, "created_at": "2026-08-10T00:00:01Z"},
		map[string]any{"artifact_id": "ART-R005-SIDECAR", "run_id": runID, "stage": "R005", "artifact_type": "EVIDENCE_JSON", "path": sidecarPath, "sha256": sidecarSHA256, "created_at": "2026-08-10T00:00:02Z"},
	}}
	if err := writeJSONAtomic(filepath.Join(app.DataRoot, "artifacts", "index.json"), artifacts); err != nil {
		t.Fatal(err)
	}
}

func allocateValidPreRunV194(t *testing.T, app *App) (map[string]any, string) {
	t.Helper()
	body, erpRoot := validProofBodyV194(t, app)
	preflight, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	proof := preflight["pre_run_source_proof"].(map[string]any)
	delete(body, "preflight_only")
	body["expected_preflight_digest_sha256"] = proof["proof_digest_sha256"]
	prepared, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	return prepared, erpRoot
}

func mutateRunRecordV194(t *testing.T, app *App, runID string, mutate func(map[string]any)) {
	t.Helper()
	runs := map[string]any{}
	path := filepath.Join(app.DataRoot, "runs", "index.json")
	if err := readJSON(path, &runs); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, raw := range anySlice(runs["runs"]) {
		run, _ := raw.(map[string]any)
		if run != nil && asString(run["run_id"]) == runID {
			mutate(run)
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("run %s not found", runID)
	}
	if err := writeJSONAtomic(path, runs); err != nil {
		t.Fatal(err)
	}
}

func TestPreRunValidUniqueSourcesAllocateOneRunWithExactPinsV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	body, _ := validProofBodyV194(t, app)
	preflight, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	if preflight["run_id"] != nil {
		t.Fatalf("preflight-only allocated a RUN: %#v", preflight)
	}
	proof, _ := preflight["pre_run_source_proof"].(map[string]any)
	if asString(proof["proof_status"]) != "PASS" || !asBool(proof["engine_prepare_allowed"]) {
		t.Fatalf("valid proof did not pass: %#v", proof)
	}
	assertNoFinancialRunV194(t, app)

	delete(body, "preflight_only")
	body["expected_preflight_digest_sha256"] = proof["proof_digest_sha256"]
	prepared, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	runID := asString(prepared["run_id"])
	if runID == "" {
		t.Fatal("prepared RUN has no run_id")
	}
	runs := map[string]any{}
	if err := readJSON(filepath.Join(app.DataRoot, "runs", "index.json"), &runs); err != nil {
		t.Fatal(err)
	}
	if len(anySlice(runs["runs"])) != 1 {
		t.Fatalf("expected exactly one RUN, got %#v", runs)
	}
	run := anySlice(runs["runs"])[0].(map[string]any)
	bound := run["pre_run_source_proof"].(map[string]any)
	if asString(bound["proof_digest_sha256"]) != asString(proof["proof_digest_sha256"]) {
		t.Fatalf("RUN proof digest changed: %#v", bound)
	}
	context := map[string]any{}
	if err := readJSON(asString(prepared["context_path"]), &context); err != nil {
		t.Fatal(err)
	}
	sources := context["sources"].(map[string]any)
	contextProof := sources["pre_run_source_proof"].(map[string]any)
	if asString(contextProof["proof_digest_sha256"]) != asString(proof["proof_digest_sha256"]) {
		t.Fatalf("context proof digest changed: %#v", contextProof)
	}
}

func TestPreRunKnownBlockersAllocateNoRunV194(t *testing.T) {
	tests := []struct {
		name      string
		expected  string
		buildERP  func(t *testing.T, root string)
		blockers  []string
		selectERP bool
	}{
		{"ambiguous_archives", "BLOCKED_SOURCE_PROOF_AMBIGUOUS_ARCHIVES", func(t *testing.T, root string) {
			writeSourceV194(t, root, "one.zip", "archive-one")
			writeSourceV194(t, root, "two.zip", "archive-two")
		}, nil, false},
		{"empty_root", "DATA_BLOCKED_SOURCE_ROOT_EMPTY", func(t *testing.T, root string) {
			if err := os.MkdirAll(root, 0755); err != nil {
				t.Fatal(err)
			}
		}, nil, false},
		{"period_conflict", "BLOCKED_SOURCE_PROOF_PERIOD_METADATA_CONFLICT", func(t *testing.T, root string) {
			writeSourceV194(t, root, "erp.zip", "period-conflict-archive")
		}, []string{"BLOCKED_SOURCE_PROOF_PERIOD_METADATA_CONFLICT"}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			intalevRoot := filepath.Join(app.InputsDir, "approved", "intalev")
			erpRoot := filepath.Join(app.InputsDir, "approved", "erp")
			writeSourceV194(t, intalevRoot, "intalev.xlsx", "intalev")
			tc.buildERP(t, erpRoot)
			intalevRequest, intalevEvidence := sourceSpecV194(t, "INTALEV", "INTALEV-ROOT", intalevRoot, true)
			erpRequest, erpEvidence := sourceSpecV194(t, "ERP", "ERP-ROOT", erpRoot, tc.selectERP, tc.blockers...)
			proof := map[string]any{
				"organization_id": "ORG-1", "organization_name": "Organization 1", "period_mode": "month", "period": "2025-01",
				"source_roots": []any{intalevRequest, erpRequest},
			}
			bindEvidenceV194(t, app, proof, intalevEvidence, erpEvidence)
			body := map[string]any{
				"module_id": "reconciliation-engine", "preflight_only": true,
				"source_proof": proof,
			}
			_, err := app.prepareEngineWithTrustedSourceProofV194(body)
			if err == nil {
				t.Fatal("blocked source proof unexpectedly passed")
			}
			requireBlockerV194(t, blockerCodesFromErrorV194(t, err), tc.expected)
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestPreRunMutationBetweenDigestAndPrepareFailsClosedV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	body, erpRoot := validProofBodyV194(t, app)
	preflight, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	proof := preflight["pre_run_source_proof"].(map[string]any)
	if err := os.WriteFile(filepath.Join(erpRoot, "erp.xlsx"), []byte("mutated-after-preflight"), 0644); err != nil {
		t.Fatal(err)
	}
	delete(body, "preflight_only")
	body["expected_preflight_digest_sha256"] = proof["proof_digest_sha256"]
	_, err = app.prepareEngineWithTrustedSourceProofV194(body)
	if err == nil {
		t.Fatal("source drift unexpectedly allocated a RUN")
	}
	requireBlockerV194(t, blockerCodesFromErrorV194(t, err), "BLOCKED_SOURCE_PROOF_HASH_DRIFT")
	assertNoFinancialRunV194(t, app)
}

func TestPreRunDigestPinsExactRootPathEvenForIdenticalBytesV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	body, erpRoot := validProofBodyV194(t, app)
	first, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	firstProof := first["pre_run_source_proof"].(map[string]any)
	substituteRoot := filepath.Join(app.InputsDir, "substituted", "erp")
	writeSourceV194(t, substituteRoot, "erp.xlsx", "erp-source-v1")
	proofRequest := body["source_proof"].(map[string]any)
	roots := anySlice(proofRequest["source_roots"])
	for _, raw := range roots {
		root := raw.(map[string]any)
		if asString(root["role"]) == "ERP" {
			root["path"] = substituteRoot
		}
	}
	second, err := app.prepareEngineWithTrustedSourceProofV194(body)
	if err != nil {
		t.Fatal(err)
	}
	secondProof := second["pre_run_source_proof"].(map[string]any)
	if asString(firstProof["proof_digest_sha256"]) == asString(secondProof["proof_digest_sha256"]) {
		t.Fatal("identical bytes at a substituted root produced the same proof digest")
	}
	delete(body, "preflight_only")
	body["expected_preflight_digest_sha256"] = firstProof["proof_digest_sha256"]
	_, err = app.prepareEngineWithTrustedSourceProofV194(body)
	if err == nil {
		t.Fatal("substituted root accepted under the prior exact proof digest")
	}
	requireBlockerV194(t, blockerCodesFromErrorV194(t, err), "BLOCKED_SOURCE_PROOF_HASH_DRIFT")
	assertNoFinancialRunV194(t, app)
	if !fileExists(filepath.Join(erpRoot, "erp.xlsx")) {
		t.Fatal("test unexpectedly changed the approved root")
	}
}

func TestPreRunRejectsWrongContextAndStaleRunV194(t *testing.T) {
	for _, tc := range []struct {
		name, expected string
		mutate         func(map[string]any)
	}{
		{"wrong_organization", "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH", func(body map[string]any) {
			body["source_proof"].(map[string]any)["organization_id"] = "ORG-OTHER"
		}},
		{"wrong_period", "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH", func(body map[string]any) {
			body["source_proof"].(map[string]any)["period"] = "2025-02"
		}},
		{"stale_run", "BLOCKED_SOURCE_PROOF_STALE_RUN_REUSE", func(body map[string]any) {
			body["run_id"] = "RUN-OLD"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			body, _ := validProofBodyV194(t, app)
			tc.mutate(body)
			_, err := app.prepareEngineWithTrustedSourceProofV194(body)
			if err == nil {
				t.Fatal("invalid context unexpectedly passed")
			}
			codes := blockerCodesFromErrorV194(t, err)
			requireBlockerV194(t, codes, tc.expected)
			if strings.Join(codes, ",") == "" {
				t.Fatal("blocked response omitted blocker codes")
			}
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestPreRunRejectsUnapprovedEvidenceAndNonExactRolesV194(t *testing.T) {
	for _, tc := range []struct {
		name, expected string
		mutate         func(t *testing.T, app *App, body map[string]any)
	}{
		{"unapproved_evidence", "BLOCKED_SOURCE_PROOF_EVIDENCE_UNAPPROVED", func(t *testing.T, app *App, body map[string]any) {
			settings := map[string]any{}
			_ = readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings)
			settings["approved_source_evidence_sha256"] = strings.Repeat("A", 64)
			_ = writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings)
		}},
		{"evidence_byte_drift", "BLOCKED_SOURCE_PROOF_EVIDENCE_HASH_MISMATCH", func(t *testing.T, app *App, body map[string]any) {
			proof := body["source_proof"].(map[string]any)
			document := map[string]any{}
			_ = readJSON(asString(proof["evidence_path"]), &document)
			document["changed_after_approval"] = true
			_ = writeJSONAtomic(asString(proof["evidence_path"]), document)
		}},
		{"request_role_relabel", "BLOCKED_SOURCE_PROOF_ROLE_MISMATCH", func(t *testing.T, app *App, body map[string]any) {
			roots := anySlice(body["source_proof"].(map[string]any)["source_roots"])
			roots[0].(map[string]any)["role"] = "ERP"
		}},
		{"authoritative_organization_name_mismatch", "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH", func(t *testing.T, app *App, body map[string]any) {
			proof := body["source_proof"].(map[string]any)
			document := map[string]any{}
			_ = readJSON(asString(proof["evidence_path"]), &document)
			roots := anySlice(document["roots"])
			roots[0].(map[string]any)["expected_organization"] = "Another Organization"
			_ = writeJSONAtomic(asString(proof["evidence_path"]), document)
			newSHA256, _ := fileSHA256V041(asString(proof["evidence_path"]))
			proof["approved_evidence_sha256"] = newSHA256
			settings := map[string]any{}
			_ = readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings)
			settings["approved_source_evidence_sha256"] = newSHA256
			_ = writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings)
		}},
		{"extra_role", "BLOCKED_SOURCE_PROOF_ROLE_SET_MISMATCH", func(t *testing.T, app *App, body map[string]any) {
			proof := body["source_proof"].(map[string]any)
			roots := anySlice(proof["source_roots"])
			duplicate := cloneMap(roots[1].(map[string]any))
			proof["source_roots"] = append(roots, duplicate)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			body, _ := validProofBodyV194(t, app)
			tc.mutate(t, app, body)
			_, err := app.prepareEngineWithTrustedSourceProofV194(body)
			if err == nil {
				t.Fatal("unapproved or non-exact proof unexpectedly passed")
			}
			requireBlockerV194(t, blockerCodesFromErrorV194(t, err), tc.expected)
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestPreRunHTTPBlockIsStructuredAndUICompatibleV194(t *testing.T) {
	app := newPreRunTestAppV194(t)
	body, _ := validProofBodyV194(t, app)
	settings := map[string]any{}
	_ = readJSON(filepath.Join(app.ConfigDir, "settings.json"), &settings)
	settings["approved_source_evidence_sha256"] = strings.Repeat("F", 64)
	_ = writeJSONAtomic(filepath.Join(app.ConfigDir, "settings.json"), settings)
	payload, _ := json.Marshal(body)
	request := httptest.NewRequest(http.MethodPost, "/api/engine/prepare", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	result := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if asString(result["error"]) != "SOURCE_PROOF_BLOCKED" || strings.TrimSpace(asString(result["message"])) == "" {
		t.Fatalf("blocked response is not UI-compatible: %#v", result)
	}
	if result["run_id"] != nil || asBool(result["engine_prepare_allowed"]) {
		t.Fatalf("blocked response claims a RUN/prepare permission: %#v", result)
	}
	assertNoFinancialRunV194(t, app)
}

func TestPreRunDirectEndpointsCannotBypassCanonicalProofV194(t *testing.T) {
	for _, endpoint := range []string{"/api/engine/prepare", "/api/modules/open"} {
		t.Run(strings.TrimPrefix(endpoint, "/api/"), func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			settingsPayload, _ := json.Marshal(map[string]any{"source_proof_required": false})
			settingsRequest := httptest.NewRequest(http.MethodPost, "/api/settings", bytes.NewReader(settingsPayload))
			settingsRequest.RemoteAddr = "127.0.0.1:12345"
			settingsResponse := httptest.NewRecorder()
			app.routes().ServeHTTP(settingsResponse, settingsRequest)
			if settingsResponse.Code >= 400 {
				t.Fatalf("settings precondition failed: status=%d body=%s", settingsResponse.Code, settingsResponse.Body.String())
			}
			payload, _ := json.Marshal(map[string]any{"module_id": "reconciliation-engine"})
			request := httptest.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
			request.RemoteAddr = "127.0.0.1:12345"
			response := httptest.NewRecorder()
			app.routes().ServeHTTP(response, request)
			if response.Code < 400 {
				t.Fatalf("direct endpoint bypassed proof: status=%d body=%s", response.Code, response.Body.String())
			}
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestPreRunRejectsPathsOutsideInputsV194(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(t *testing.T, app *App, body map[string]any)
	}{
		{"source_root", func(t *testing.T, app *App, body map[string]any) {
			outsideRoot := filepath.Join(app.Root, "outside-inputs", "erp")
			writeSourceV194(t, outsideRoot, "erp.xlsx", "erp-source-v1")
			for _, raw := range anySlice(body["source_proof"].(map[string]any)["source_roots"]) {
				root := raw.(map[string]any)
				if asString(root["role"]) == "ERP" {
					root["path"] = outsideRoot
				}
			}
		}},
		{"evidence", func(t *testing.T, app *App, body map[string]any) {
			proof := body["source_proof"].(map[string]any)
			original := asString(proof["evidence_path"])
			data, err := os.ReadFile(original)
			if err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(app.Root, "outside-inputs", "SOURCE_INVENTORY.json")
			if err := os.MkdirAll(filepath.Dir(outside), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(outside, data, 0644); err != nil {
				t.Fatal(err)
			}
			proof["evidence_path"] = outside
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			body, _ := validProofBodyV194(t, app)
			tc.mutate(t, app, body)
			_, err := app.prepareEngineWithTrustedSourceProofV194(body)
			if err == nil {
				t.Fatal("path outside Inputs produced a proof")
			}
			requireBlockerV194(t, blockerCodesFromErrorV194(t, err), "BLOCKED_SOURCE_PROOF_PATH_OUTSIDE_INPUTS")
			assertNoFinancialRunV194(t, app)
		})
	}
}

func TestRulesPrepareCarriesExactProofAndRejectsSourceDriftV194(t *testing.T) {
	t.Run("proof_digest_carried", func(t *testing.T) {
		app := newPreRunTestAppV194(t)
		prepared, _ := allocateValidPreRunV194(t, app)
		runID := asString(prepared["run_id"])
		registerR005ArtifactsV194(t, app, runID)
		rulesPrepared, err := app.prepareRulesEngine(map[string]any{"run_id": runID, "phase": "AFTER_R005"})
		if err != nil {
			t.Fatal(err)
		}
		context := map[string]any{}
		if err := readJSON(asString(rulesPrepared["context_path"]), &context); err != nil {
			t.Fatal(err)
		}
		carried := context["pre_run_source_proof"].(map[string]any)
		if asString(carried["proof_digest_sha256"]) != asString(rulesPrepared["pre_run_source_proof_digest_sha256"]) {
			t.Fatalf("Rules context changed proof digest: %#v", context)
		}
	})

	t.Run("source_drift_before_rules_is_zero_mutation", func(t *testing.T) {
		app := newPreRunTestAppV194(t)
		prepared, erpRoot := allocateValidPreRunV194(t, app)
		runID := asString(prepared["run_id"])
		registerR005ArtifactsV194(t, app, runID)
		if err := os.WriteFile(filepath.Join(erpRoot, "erp.xlsx"), []byte("mutated-before-rules"), 0644); err != nil {
			t.Fatal(err)
		}
		_, err := app.prepareRulesEngine(map[string]any{"run_id": runID, "phase": "AFTER_R005"})
		if err == nil || !strings.Contains(err.Error(), "BLOCKED_SOURCE_PROOF_HASH_DRIFT") {
			t.Fatalf("Rules prepare did not fail closed on source drift: %v", err)
		}
		if fileExists(filepath.Join(app.DataRoot, "runs", runID, "rules-input")) {
			t.Fatal("blocked Rules prepare created rules-input")
		}
	})
}

func TestRulesAndR001RejectMissingOrTamperedStoredProofV194(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(t *testing.T, app *App, run map[string]any)
	}{
		{"missing_public_proof", func(t *testing.T, app *App, run map[string]any) {
			delete(run, "pre_run_source_proof")
		}},
		{"missing_all_roots", func(t *testing.T, app *App, run map[string]any) {
			delete(run, "pre_run_source_roots")
		}},
		{"missing_one_root", func(t *testing.T, app *App, run map[string]any) {
			roots := anySlice(run["pre_run_source_roots"])
			run["pre_run_source_roots"] = roots[:1]
		}},
		{"coordinated_internal_repoint", func(t *testing.T, app *App, run map[string]any) {
			roots := anySlice(run["pre_run_source_roots"])
			stored := roots[1].(map[string]any)
			substituteRoot := filepath.Join(app.Root, "coordinated-substitute", "erp")
			selectedPath := writeSourceV194(t, substituteRoot, "erp.xlsx", "erp-source-v1")
			files, digest, blockers, err := scanSourceRootV194(substituteRoot)
			if err != nil || len(blockers) != 0 || len(files) != 1 {
				t.Fatalf("substitute scan failed: files=%d blockers=%v err=%v", len(files), blockers, err)
			}
			stored["root_path"] = substituteRoot
			stored["root_path_identity_sha256"] = pathIdentityV194(substituteRoot)
			stored["package_digest_sha256"] = digest
			stored["selected_path"] = selectedPath
			stored["selected_path_identity_sha256"] = pathIdentityV194(selectedPath)
			stored["selected_file_sha256"] = files[0].SHA256
		}},
	} {
		t.Run("rules_"+tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			prepared, _ := allocateValidPreRunV194(t, app)
			runID := asString(prepared["run_id"])
			registerR005ArtifactsV194(t, app, runID)
			mutateRunRecordV194(t, app, runID, func(run map[string]any) { tc.mutate(t, app, run) })
			_, err := app.prepareRulesEngine(map[string]any{"run_id": runID, "phase": "AFTER_R005"})
			if err == nil || !strings.Contains(err.Error(), "BLOCKED_SOURCE_PROOF") {
				t.Fatalf("tampered stored proof reached Rules: %v", err)
			}
			if fileExists(filepath.Join(app.DataRoot, "runs", runID, "rules-input")) {
				t.Fatal("blocked stored proof created rules-input")
			}
		})

		t.Run("r001_"+tc.name, func(t *testing.T) {
			app := newPreRunTestAppV194(t)
			prepared, _ := allocateValidPreRunV194(t, app)
			runID := asString(prepared["run_id"])
			registerR005ArtifactsV194(t, app, runID)
			installVerifiedR001HandoffV194(t, app, runID, "PASS_TO_R001")
			mutateRunRecordV194(t, app, runID, func(run map[string]any) { tc.mutate(t, app, run) })
			_, err := app.prepareEngineV041(map[string]any{"module_id": "correction-files-engine", "run_id": runID})
			if err == nil || !strings.Contains(err.Error(), "BLOCKED_SOURCE_PROOF") {
				t.Fatalf("tampered stored proof reached R001: %v", err)
			}
		})
	}
}
