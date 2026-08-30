package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type reportOnlyArtifactSafety struct {
	ReportOnly        *bool `json:"report_only"`
	PostingRows       *int  `json:"posting_rows"`
	ExecutedRows      *int  `json:"executed_posting_rows"`
	LivePostingRows   *int  `json:"live_posting_rows"`
	ExecutionAllowed  *bool `json:"execution_allowed"`
	ReadyToUpload     *bool `json:"ready_to_upload"`
	ReleaseAllowed    *bool `json:"release_allowed"`
	Live1CAllowed     *bool `json:"live_1c_allowed"`
	LiveDeleteAllowed *bool `json:"live_delete_allowed"`
}

type r001NonFinancialReview struct {
	SchemaVersion          string    `json:"schema_version"`
	PairID                 string    `json:"pair_id"`
	SourceRowID            string    `json:"source_row_id"`
	Operations             []string  `json:"operations"`
	Amounts                []float64 `json:"amounts"`
	BlockerCodes           []string  `json:"blocker_codes"`
	Reason                 string    `json:"reason"`
	ReportOnly             *bool     `json:"report_only"`
	CorrectionAllowed      *bool     `json:"correction_allowed"`
	CanonicalFinancialRows *int      `json:"canonical_financial_rows"`
}

func nonFinancialReviewSetSHA256(reviews []r001NonFinancialReview) (string, error) {
	data, err := json.Marshal(reviews)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%X", digest), nil
}

func validateNonFinancialReviewSet(reviews []r001NonFinancialReview, expectedCount, expectedRows *int, expectedSHA256 string) error {
	if reviews == nil || expectedCount == nil || expectedRows == nil || *expectedCount < 0 || *expectedRows < 0 ||
		*expectedCount != len(reviews) || *expectedRows != len(reviews) || !validSHA256(expectedSHA256) {
		return errors.New("R001 non-financial review count or digest is missing or inconsistent")
	}
	pairs := map[string]bool{}
	for _, review := range reviews {
		pairID := strings.TrimSpace(review.PairID)
		if review.SchemaVersion != "opiu-r001-non-financial-review.v1" || pairID == "" || pairs[pairID] ||
			len(review.Operations) == 0 || len(review.Operations) != len(review.Amounts) || len(review.BlockerCodes) == 0 ||
			strings.TrimSpace(review.Reason) == "" || review.ReportOnly == nil || !*review.ReportOnly ||
			review.CorrectionAllowed == nil || *review.CorrectionAllowed || review.CanonicalFinancialRows == nil || *review.CanonicalFinancialRows != 0 {
			return errors.New("R001 non-financial review is malformed or claims financial authority")
		}
		for _, operation := range review.Operations {
			if strings.TrimSpace(operation) == "" {
				return errors.New("R001 non-financial review operation is missing")
			}
		}
		blockers := map[string]bool{}
		for _, blocker := range review.BlockerCodes {
			blocker = strings.TrimSpace(blocker)
			if blocker == "" || blockers[blocker] {
				return errors.New("R001 non-financial review blocker set is not exact unique")
			}
			blockers[blocker] = true
		}
		pairs[pairID] = true
	}
	actualSHA256, err := nonFinancialReviewSetSHA256(reviews)
	if err != nil || !strings.EqualFold(actualSHA256, expectedSHA256) {
		return errors.New("R001 non-financial review digest mismatch")
	}
	return nil
}

type r005ReportOnlyManifest struct {
	Schema           string `json:"schema"`
	Organization     string `json:"organization"`
	Period           string `json:"period"`
	Status           string `json:"status"`
	OutputSHA256     string `json:"output_sha256"`
	CodexInputSHA256 string `json:"codex_input_sha256"`
	reportOnlyArtifactSafety
}

type r001ReportOnlyManifest struct {
	SchemaVersion string `json:"schema_version"`
	RunID         string `json:"run_id"`
	Inputs        struct {
		Period         string `json:"period"`
		SourceRunID    string `json:"source_run_id"`
		Reconciliation struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
		} `json:"reconciliation"`
		ServiceHandoff *struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
		} `json:"service_handoff"`
	} `json:"inputs"`
	Results struct {
		reportOnlyArtifactSafety
		CanonicalRows            *int                     `json:"canonical_financial_rows_total"`
		ReadyRows                *int                     `json:"ready_financial_rows"`
		SpornoRows               *int                     `json:"sporno_financial_rows"`
		NonFinancialReviewCount  *int                     `json:"non_financial_review_count"`
		NonFinancialReviewRows   *int                     `json:"non_financial_review_row_count"`
		NonFinancialReviewSHA256 string                   `json:"non_financial_review_set_sha256"`
		NonFinancialReviews      []r001NonFinancialReview `json:"non_financial_reviews"`
		OutputRowCounts          []struct {
			FinancialRows int `json:"financial_rows"`
		} `json:"output_file_row_counts"`
		CanonicalOutputIntegrity struct {
			Result                   string `json:"result"`
			CanonicalRows            *int   `json:"canonical_financial_rows_total"`
			WorkbookRows             *int   `json:"workbook_financial_rows"`
			RegistryRows             *int   `json:"registry_financial_rows"`
			CanonicalSHA256          string `json:"canonical_row_set_sha256"`
			NonFinancialReviewRows   *int   `json:"non_financial_review_rows"`
			NonFinancialReviewSHA256 string `json:"non_financial_review_set_sha256"`
			reportOnlyArtifactSafety
		} `json:"canonical_output_integrity"`
	} `json:"results"`
	Outputs map[string]string `json:"outputs"`
}

func validateReportOnlySafety(safety reportOnlyArtifactSafety) error {
	if safety.ReportOnly == nil || !*safety.ReportOnly {
		return errors.New("report_only=true is required")
	}
	for name, value := range map[string]*int{
		"posting_rows": safety.PostingRows, "executed_posting_rows": safety.ExecutedRows,
		"live_posting_rows": safety.LivePostingRows,
	} {
		if value == nil || *value != 0 {
			return fmt.Errorf("%s=0 is required", name)
		}
	}
	for name, value := range map[string]*bool{
		"execution_allowed": safety.ExecutionAllowed, "ready_to_upload": safety.ReadyToUpload,
		"release_allowed": safety.ReleaseAllowed, "live_1c_allowed": safety.Live1CAllowed,
		"live_delete_allowed": safety.LiveDeleteAllowed,
	} {
		if value == nil || *value {
			return fmt.Errorf("%s=false is required", name)
		}
	}
	return nil
}

func businessBlockerStatus(status string) bool {
	value := strings.ToUpper(strings.TrimSpace(status))
	return strings.HasPrefix(value, "BLOCKED_") || strings.HasPrefix(value, "WAIT_") ||
		strings.HasPrefix(value, "REVIEW_") || strings.HasPrefix(value, "NEEDS_")
}

func validateR005ReportOnlyPackage(r005Dir string, contextValue Context, requireBusinessBlocker bool) error {
	reportPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	for _, required := range []string{reportPath, codexPath, manifestPath} {
		if !regularFile(required) {
			return fmt.Errorf("required R005 artifact is missing: %s", filepath.Base(required))
		}
	}
	var manifest r005ReportOnlyManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return fmt.Errorf("read R005 manifest: %w", err)
	}
	if manifest.Schema != "opiu-auto-reconciliation-run-v3" {
		return errors.New("R005 manifest schema is not accepted")
	}
	if strings.TrimSpace(manifest.Organization) != strings.TrimSpace(contextValue.Organization) ||
		strings.TrimSpace(manifest.Period) != strings.TrimSpace(contextValue.Period) {
		return errors.New("R005 manifest escaped organization or period scope")
	}
	if requireBusinessBlocker && !businessBlockerStatus(manifest.Status) {
		return fmt.Errorf("R005 non-zero exit has no recognized business blocker status: %s", manifest.Status)
	}
	if err := validateReportOnlySafety(manifest.reportOnlyArtifactSafety); err != nil {
		return fmt.Errorf("unsafe R005 manifest: %w", err)
	}
	var codexSafety reportOnlyArtifactSafety
	if err := readJSONFile(codexPath, &codexSafety); err != nil {
		return fmt.Errorf("read R005 codex input: %w", err)
	}
	if err := validateReportOnlySafety(codexSafety); err != nil {
		return fmt.Errorf("unsafe R005 codex input: %w", err)
	}
	reportSHA, err := sha256File(reportPath)
	if err != nil || !validSHA256(manifest.OutputSHA256) || !strings.EqualFold(reportSHA, manifest.OutputSHA256) {
		return errors.New("R005 report hash does not match manifest")
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil || !validSHA256(manifest.CodexInputSHA256) || !strings.EqualFold(codexSHA, manifest.CodexInputSHA256) {
		return errors.New("R005 codex-input hash does not match manifest")
	}
	return nil
}

func findR001Manifest(r001Dir string) (string, error) {
	if err := rejectSymlinkTraversal(r001Dir, r001Dir); err != nil {
		return "", err
	}
	manifests := []string{}
	err := filepath.WalkDir(r001Dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := rejectSymlinkTraversal(r001Dir, path); err != nil {
			return err
		}
		if entry == nil || entry.IsDir() || !strings.EqualFold(entry.Name(), "manifest.json") {
			return nil
		}
		if strings.EqualFold(filepath.Base(filepath.Dir(path)), "technical") {
			manifests = append(manifests, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(manifests) != 1 {
		return "", fmt.Errorf("expected one R001 technical manifest, got %d", len(manifests))
	}
	return manifests[0], nil
}

func validateR001ReportOnlyPackage(r001Dir string) error {
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		return err
	}
	packageDir := filepath.Dir(filepath.Dir(manifestPath))
	var manifest r001ReportOnlyManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return fmt.Errorf("read R001 manifest: %w", err)
	}
	if manifest.SchemaVersion != "correction-engine-run-1.0.0" {
		return errors.New("R001 manifest schema is not accepted")
	}
	if err := validateReportOnlySafety(manifest.Results.reportOnlyArtifactSafety); err != nil {
		return fmt.Errorf("unsafe R001 manifest: %w", err)
	}
	if manifest.Results.CanonicalRows == nil || manifest.Results.ReadyRows == nil || manifest.Results.SpornoRows == nil {
		return errors.New("R001 route counts are missing")
	}
	if *manifest.Results.CanonicalRows < 0 || *manifest.Results.ReadyRows < 0 || *manifest.Results.SpornoRows < 0 ||
		*manifest.Results.ReadyRows+*manifest.Results.SpornoRows != *manifest.Results.CanonicalRows {
		return errors.New("R001 route counts are inconsistent")
	}
	if err := validateNonFinancialReviewSet(
		manifest.Results.NonFinancialReviews,
		manifest.Results.NonFinancialReviewCount,
		manifest.Results.NonFinancialReviewRows,
		manifest.Results.NonFinancialReviewSHA256,
	); err != nil {
		return err
	}
	if len(manifest.Outputs) == 0 {
		return errors.New("R001 output registry is empty")
	}
	hasDecisions, hasRegistry, hasReconciliation := false, false, false
	reconciliationPath := ""
	for relative, expectedSHA := range manifest.Outputs {
		cleanRelative := filepath.Clean(filepath.FromSlash(relative))
		if cleanRelative == "." || filepath.IsAbs(cleanRelative) || cleanRelative == ".." || strings.HasPrefix(cleanRelative, ".."+string(os.PathSeparator)) {
			return fmt.Errorf("unsafe R001 output path: %s", relative)
		}
		artifactPath := filepath.Join(packageDir, cleanRelative)
		if err := rejectSymlinkTraversal(packageDir, artifactPath); err != nil {
			return err
		}
		if !regularFile(artifactPath) {
			return fmt.Errorf("registered R001 artifact is missing: %s", relative)
		}
		if strings.HasSuffix(strings.ToLower(artifactPath), ".xlsx") {
			if err := validateOOXMLWorkbook(artifactPath); err != nil {
				return fmt.Errorf("registered R001 workbook is invalid (%s): %w", relative, err)
			}
		}
		actualSHA, err := sha256File(artifactPath)
		if err != nil || !validSHA256(expectedSHA) || !strings.EqualFold(actualSHA, expectedSHA) {
			return fmt.Errorf("registered R001 artifact hash mismatch: %s", relative)
		}
		lower := strings.ToLower(filepath.ToSlash(relative))
		hasDecisions = hasDecisions || lower == strings.ToLower("решения.xlsx") ||
			lower == strings.ToLower("решения_корректировок_ввод_r001.xlsx")
		hasRegistry = hasRegistry || (strings.Contains(lower, strings.ToLower("реестр")) && strings.HasSuffix(lower, ".xlsx"))
		if lower == "reconciliation.xlsx" || lower == "сверка.xlsx" {
			hasReconciliation = true
			reconciliationPath = artifactPath
		}
	}
	if !hasDecisions || !hasRegistry || !hasReconciliation {
		return errors.New("R001 diagnostic workbook, registry or reconciliation is missing")
	}
	integrity := manifest.Results.CanonicalOutputIntegrity
	if integrity.Result != "PASS" || integrity.CanonicalRows == nil || integrity.WorkbookRows == nil || integrity.RegistryRows == nil ||
		*integrity.CanonicalRows != *manifest.Results.CanonicalRows || *integrity.WorkbookRows != *manifest.Results.CanonicalRows ||
		*integrity.RegistryRows != *manifest.Results.CanonicalRows || !validSHA256(integrity.CanonicalSHA256) ||
		integrity.NonFinancialReviewRows == nil || *integrity.NonFinancialReviewRows != *manifest.Results.NonFinancialReviewRows ||
		!strings.EqualFold(integrity.NonFinancialReviewSHA256, manifest.Results.NonFinancialReviewSHA256) {
		return errors.New("R001 canonical output integrity proof is missing or inconsistent")
	}
	if err := validateReportOnlySafety(integrity.reportOnlyArtifactSafety); err != nil {
		return fmt.Errorf("unsafe R001 canonical output integrity: %w", err)
	}
	if *manifest.Results.CanonicalRows > 0 {
		materializationRows, err := readMaterializationTable(reconciliationPath)
		if err != nil {
			return fmt.Errorf("read R001 physical routing audit: %w", err)
		}
		if err := validateMaterializationRouting(materializationRows, *manifest.Results.CanonicalRows, *manifest.Results.ReadyRows, *manifest.Results.SpornoRows); err != nil {
			return err
		}
	}
	if *manifest.Results.CanonicalRows == 0 {
		if len(manifest.Results.OutputRowCounts) != 0 {
			return errors.New("zero-route R001 package registered loader output rows")
		}
		if err := rejectZeroRouteLoaderWorkbooks(packageDir); err != nil {
			return err
		}
	}
	return nil
}

func validateR001ReportOnlyPackageForRun(r001Dir string, run Run, contextValue Context) error {
	if err := validateR001ReportOnlyPackage(r001Dir); err != nil {
		return err
	}
	runDir := filepath.Dir(r001Dir)
	r005Dir := filepath.Join(runDir, "r005")
	if err := validateR005ReportOnlyPackage(r005Dir, contextValue, false); err != nil {
		return fmt.Errorf("current scoped R005 source package is invalid: %w", err)
	}
	manifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		return err
	}
	var manifest r001ReportOnlyManifest
	if err := readJSONFile(manifestPath, &manifest); err != nil {
		return err
	}
	if strings.TrimSpace(manifest.RunID) != strings.TrimSpace(run.ID) ||
		strings.TrimSpace(manifest.Inputs.SourceRunID) != strings.TrimSpace(run.ID) ||
		strings.TrimSpace(manifest.Inputs.Period) != strings.TrimSpace(contextValue.Period) {
		return errors.New("R001 package escaped exact run or period scope")
	}
	expectedReconciliationPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	declaredReconciliationPath, err := filepath.Abs(filepath.Clean(manifest.Inputs.Reconciliation.Path))
	if err != nil {
		return errors.New("R001 package has no exact reconciliation source path")
	}
	expectedReconciliationPath, err = filepath.Abs(expectedReconciliationPath)
	if err != nil || !sameFilesystemPath(declaredReconciliationPath, expectedReconciliationPath) {
		return errors.New("R001 package escaped the exact current R005 reconciliation source")
	}
	if err := rejectSymlinkTraversal(runDir, expectedReconciliationPath); err != nil {
		return err
	}
	reconciliationSHA, err := sha256File(expectedReconciliationPath)
	if err != nil || !validSHA256(manifest.Inputs.Reconciliation.SHA256) || !strings.EqualFold(reconciliationSHA, manifest.Inputs.Reconciliation.SHA256) {
		return errors.New("R001 package reconciliation source hash does not match current R005")
	}
	handoff := manifest.Inputs.ServiceHandoff
	if handoff == nil {
		return errors.New("R001 package omitted mandatory Service handoff")
	}
	handoffPath, err := filepath.Abs(filepath.Clean(handoff.Path))
	if err != nil || rejectSymlinkTraversal(runDir, handoffPath) != nil || !regularFile(handoffPath) {
		return errors.New("R001 package handoff escaped the exact current run")
	}
	expectedHandoffPath := filepath.Join(runDir, "handoff", serviceR001HandoffFilename)
	if !sameFilesystemPath(handoffPath, expectedHandoffPath) {
		return errors.New("R001 package did not use the canonical Service handoff")
	}
	handoffSHA, err := sha256File(handoffPath)
	if err != nil || !validSHA256(handoff.SHA256) || !strings.EqualFold(handoffSHA, handoff.SHA256) {
		return errors.New("R001 package handoff hash does not match current run")
	}
	if _, err := verifyServiceR001Handoff(handoffPath, handoff.SHA256, run, contextValue, runDir); err != nil {
		return fmt.Errorf("R001 package Service handoff is invalid: %w", err)
	}
	if manifest.Results.CanonicalRows != nil && *manifest.Results.CanonicalRows > 0 {
		packageDir := filepath.Dir(filepath.Dir(manifestPath))
		rows, err := readMaterializationTable(filepath.Join(packageDir, "reconciliation.xlsx"))
		if err != nil {
			return err
		}
		for index, row := range rows {
			if strings.TrimSpace(row["Период"]) != strings.TrimSpace(contextValue.Period) ||
				strings.TrimSpace(row["Организация сверки"]) != strings.TrimSpace(contextValue.OrganizationName) {
				return fmt.Errorf("R001 materialization row %d escaped exact organization or period scope", index+5)
			}
		}
	}
	return nil
}

func rejectZeroRouteLoaderWorkbooks(packageDir string) error {
	return filepath.WalkDir(packageDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry == nil || entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".xlsx") {
			return nil
		}
		if err := rejectSymlinkTraversal(packageDir, path); err != nil {
			return err
		}
		lower := strings.ToLower(filepath.ToSlash(path))
		if strings.Contains(lower, strings.ToLower("корректировочные файлы для загрузки")) ||
			strings.Contains(lower, strings.ToLower("корректировочные файлы спорно")) {
			return fmt.Errorf("zero-route R001 package contains loader workbook: %s", path)
		}
		return nil
	})
}

func rejectSymlinkTraversal(root, target string) error {
	cleanRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return err
	}
	cleanTarget, err := filepath.Abs(filepath.Clean(target))
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("report artifact escaped its exact root")
	}
	if err := rejectReparsePathComponents(cleanRoot); err != nil {
		return fmt.Errorf("report root contains a symlink, junction or reparse point: %w", err)
	}
	if err := rejectReparsePathComponents(cleanTarget); err != nil {
		return fmt.Errorf("report artifact contains a symlink, junction or reparse point: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil {
		return err
	}
	if !sameFilesystemPath(resolvedRoot, cleanRoot) {
		return errors.New("report root is not canonical")
	}
	resolvedTarget, err := filepath.EvalSymlinks(cleanTarget)
	if err != nil {
		return err
	}
	if !sameFilesystemPath(resolvedTarget, cleanTarget) {
		return errors.New("report artifact path is not canonical")
	}
	resolvedRelative, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil || resolvedRelative == ".." || strings.HasPrefix(resolvedRelative, ".."+string(os.PathSeparator)) {
		return errors.New("report artifact resolved outside its exact root")
	}
	return nil
}

func isReportArtifactModeAllowed(mode os.FileMode) bool {
	return mode&os.ModeSymlink == 0 && mode.IsRegular()
}

func reportPackageParentModeAllowed(mode os.FileMode) bool {
	return mode&os.ModeSymlink == 0 && mode.IsDir()
}

func prepareVisibleReportPackageDirectory(r001Dir, servicePackageDir string) error {
	if err := rejectSymlinkTraversal(r001Dir, r001Dir); err != nil {
		return err
	}
	serviceRoot := filepath.Dir(servicePackageDir)
	if info, err := os.Lstat(serviceRoot); err == nil {
		if !reportPackageParentModeAllowed(info.Mode()) {
			return errors.New("visible report package parent is not a safe directory")
		}
		if err := rejectSymlinkTraversal(r001Dir, serviceRoot); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(servicePackageDir, 0o700); err != nil {
		return err
	}
	return rejectSymlinkTraversal(r001Dir, servicePackageDir)
}

func resetR001OutputDirectory(runDir, r001Dir string) error {
	cleanRunDir, err := filepath.Abs(filepath.Clean(runDir))
	if err != nil {
		return err
	}
	cleanR001Dir, err := filepath.Abs(filepath.Clean(r001Dir))
	if err != nil {
		return err
	}
	if filepath.Dir(cleanR001Dir) != cleanRunDir || !strings.EqualFold(filepath.Base(cleanR001Dir), "r001") {
		return errors.New("R001 output directory escaped the exact run directory")
	}
	if err := os.RemoveAll(cleanR001Dir); err != nil {
		return err
	}
	return os.MkdirAll(cleanR001Dir, 0o700)
}

type visibleReportArtifact struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func completeReportOnlySafety() map[string]any {
	return map[string]any{
		"mode": "REPORT_ONLY", "report_only": true,
		"posting_rows": 0, "executed_posting_rows": 0, "live_posting_rows": 0,
		"execution_allowed": false, "ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "live_delete_allowed": false,
	}
}

func writeImmutableJSON(path string, value any) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil {
		if !bytes.Equal(existing, buffer.Bytes()) {
			return fmt.Errorf("immutable report artifact already exists with different bytes: %s", filepath.Base(path))
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return atomicWriteJSON(path, value)
}

func visibleArtifact(runDir, artifactPath, kind string) (visibleReportArtifact, error) {
	if err := rejectSymlinkTraversal(runDir, artifactPath); err != nil {
		return visibleReportArtifact{}, err
	}
	relative, err := filepath.Rel(runDir, artifactPath)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return visibleReportArtifact{}, errors.New("visible artifact escaped run directory")
	}
	info, err := os.Lstat(artifactPath)
	if err != nil || !isReportArtifactModeAllowed(info.Mode()) {
		return visibleReportArtifact{}, errors.New("visible artifact is not a regular file")
	}
	hash, err := sha256File(artifactPath)
	if err != nil {
		return visibleReportArtifact{}, err
	}
	return visibleReportArtifact{Name: filepath.ToSlash(relative), Kind: kind, Size: info.Size(), SHA256: hash}, nil
}

func materializeVisibleReportPackage(run Run, contextValue Context, runDir, r001Dir, blockerStage, blockerStatus, blockerMessage string) error {
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		return err
	}
	engineManifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		return err
	}
	enginePackageDir := filepath.Dir(filepath.Dir(engineManifestPath))
	var engineManifest map[string]any
	if err := readJSONFile(engineManifestPath, &engineManifest); err != nil {
		return err
	}
	results, ok := engineManifest["results"].(map[string]any)
	if !ok {
		return errors.New("R001 results are missing from manifest")
	}
	servicePackageDir := filepath.Join(r001Dir, "service-report-package", "technical")
	if err := prepareVisibleReportPackageDirectory(r001Dir, servicePackageDir); err != nil {
		return err
	}
	generatedAt := run.StartedAt.UTC()
	diagnosticsPath := filepath.Join(servicePackageDir, "diagnostics.json")
	diagnostics := map[string]any{
		"schema_version": "opiu-report-only-diagnostics.v1", "generated_at": generatedAt,
		"run_id": run.ID, "context_id": contextValue.ID,
		"organization":                    map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":                          contextValue.Period,
		"blocker":                         map[string]any{"stage": blockerStage, "status": blockerStatus, "message": blockerMessage},
		"route_rows":                      results["canonical_financial_rows_total"],
		"non_financial_review_count":      results["non_financial_review_count"],
		"non_financial_review_row_count":  results["non_financial_review_row_count"],
		"non_financial_review_set_sha256": results["non_financial_review_set_sha256"],
		"non_financial_reviews":           results["non_financial_reviews"],
		"safety":                          completeReportOnlySafety(),
	}
	if err := writeImmutableJSON(diagnosticsPath, diagnostics); err != nil {
		return err
	}
	journalPath := filepath.Join(servicePackageDir, "action-journal.json")
	journal := map[string]any{
		"schema_version": "opiu-report-only-action-journal.v1", "generated_at": generatedAt,
		"run_id": run.ID, "context_id": contextValue.ID,
		"organization":                         map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":                               contextValue.Period,
		"materialization_cases":                results["materialization_cases"],
		"canonical_financial_audit_identities": results["canonical_financial_audit_identities"],
		"disputed_blockers":                    results["disputed_blockers"],
		"non_financial_review_count":           results["non_financial_review_count"],
		"non_financial_review_row_count":       results["non_financial_review_row_count"],
		"non_financial_review_set_sha256":      results["non_financial_review_set_sha256"],
		"non_financial_reviews":                results["non_financial_reviews"],
		"route_rows":                           results["canonical_financial_rows_total"], "safety": completeReportOnlySafety(),
	}
	if err := writeImmutableJSON(journalPath, journal); err != nil {
		return err
	}

	artifacts := []visibleReportArtifact{}
	var engineManifestArtifact, diagnosticsArtifact, journalArtifact visibleReportArtifact
	for _, item := range []struct{ path, kind string }{
		{filepath.Join(runDir, "r005", "reconciliation.xlsx"), "reconciliation"},
		{filepath.Join(runDir, "r005", "reconciliation.codex-input.json"), "details"},
		{filepath.Join(runDir, "r005", "reconciliation.manifest.json"), "manifest"},
		{engineManifestPath, "manifest"},
		{diagnosticsPath, "diagnostics"}, {journalPath, "journal"},
	} {
		artifact, err := visibleArtifact(runDir, item.path, item.kind)
		if err != nil {
			return err
		}
		artifacts = append(artifacts, artifact)
		if item.kind == "diagnostics" {
			diagnosticsArtifact = artifact
		}
		if item.kind == "journal" {
			journalArtifact = artifact
		}
		if sameFilesystemPath(item.path, engineManifestPath) {
			engineManifestArtifact = artifact
		}
	}
	outputs, ok := engineManifest["outputs"].(map[string]any)
	if !ok {
		return errors.New("R001 output registry is missing")
	}
	outputNames := make([]string, 0, len(outputs))
	for name := range outputs {
		outputNames = append(outputNames, name)
	}
	sort.Strings(outputNames)
	correctionRegistries := []string{}
	loaderWorkbookCount := 0
	for _, name := range outputNames {
		artifactPath := filepath.Join(enginePackageDir, filepath.Clean(filepath.FromSlash(name)))
		kind := resultKind("r001", name)
		artifact, err := visibleArtifact(runDir, artifactPath, kind)
		if err != nil {
			return err
		}
		artifacts = append(artifacts, artifact)
		lower := strings.ToLower(filepath.ToSlash(name))
		if kind == "registry" && strings.HasSuffix(lower, ".xlsx") {
			correctionRegistries = append(correctionRegistries, artifact.Name)
		}
		if kind == "upload" || kind == "disputed" {
			loaderWorkbookCount++
		}
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].Name < artifacts[j].Name })
	registryPath := filepath.Join(servicePackageDir, "artifact-registry.json")
	registry := map[string]any{
		"schema_version": "opiu-report-only-artifact-registry.v1", "generated_at": generatedAt,
		"run_id": run.ID, "context_id": contextValue.ID,
		"organization": map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":       contextValue.Period, "artifacts": artifacts,
		"correction_registries": correctionRegistries, "safety": completeReportOnlySafety(),
		"route_rows":                      results["canonical_financial_rows_total"],
		"non_financial_review_count":      results["non_financial_review_count"],
		"non_financial_review_row_count":  results["non_financial_review_row_count"],
		"non_financial_review_set_sha256": results["non_financial_review_set_sha256"],
		"non_financial_reviews":           results["non_financial_reviews"],
	}
	if err := writeImmutableJSON(registryPath, registry); err != nil {
		return err
	}
	registryArtifact, err := visibleArtifact(runDir, registryPath, "registry")
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(servicePackageDir, "report-package.manifest.json")
	packageManifest := map[string]any{
		"schema_version": "opiu-report-only-visible-package.v1", "generated_at": generatedAt,
		"run_id": run.ID, "context_id": contextValue.ID,
		"organization":                    map[string]any{"id": contextValue.OrganizationID, "name": contextValue.OrganizationName, "path": contextValue.OrganizationPath},
		"period":                          contextValue.Period,
		"blocker_status":                  blockerStatus,
		"route_rows":                      results["canonical_financial_rows_total"],
		"non_financial_review_count":      results["non_financial_review_count"],
		"non_financial_review_row_count":  results["non_financial_review_row_count"],
		"non_financial_review_set_sha256": results["non_financial_review_set_sha256"],
		"non_financial_reviews":           results["non_financial_reviews"],
		"loader_workbook_count":           loaderWorkbookCount,
		"correction_registries":           correctionRegistries,
		"diagnostics":                     diagnosticsArtifact,
		"journal":                         journalArtifact,
		"artifact_registry":               registryArtifact,
		"engine_manifest":                 engineManifestArtifact,
		"safety":                          completeReportOnlySafety(),
	}
	return writeImmutableJSON(manifestPath, packageManifest)
}

func validateVisibleArtifactDescriptor(runDir string, raw any, expectedName, expectedKind string) error {
	value, ok := raw.(map[string]any)
	if !ok {
		return errors.New("visible artifact descriptor is missing")
	}
	name, _ := value["name"].(string)
	kind, _ := value["kind"].(string)
	hash, _ := value["sha256"].(string)
	if filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))) != filepath.ToSlash(filepath.Clean(filepath.FromSlash(expectedName))) || kind != expectedKind || !validSHA256(hash) {
		return errors.New("visible artifact descriptor identity is invalid")
	}
	artifactPath := filepath.Join(runDir, filepath.FromSlash(name))
	if err := rejectSymlinkTraversal(runDir, artifactPath); err != nil {
		return err
	}
	info, err := os.Lstat(artifactPath)
	if err != nil || !isReportArtifactModeAllowed(info.Mode()) {
		return errors.New("visible artifact descriptor points to a non-regular file")
	}
	actualHash, err := sha256File(artifactPath)
	if err != nil || !strings.EqualFold(actualHash, hash) {
		return errors.New("visible artifact descriptor hash mismatch")
	}
	size, ok := value["size"].(float64)
	if !ok || int64(size) != info.Size() {
		return errors.New("visible artifact descriptor size mismatch")
	}
	return nil
}

func validateVisibleDocumentScope(value map[string]any, schema string, run Run, contextValue Context) error {
	if value["schema_version"] != schema || value["run_id"] != run.ID || value["context_id"] != contextValue.ID || value["period"] != contextValue.Period {
		return errors.New("visible report document escaped exact run context")
	}
	organization, ok := value["organization"].(map[string]any)
	if !ok || organization["id"] != contextValue.OrganizationID || organization["name"] != contextValue.OrganizationName || organization["path"] != contextValue.OrganizationPath {
		return errors.New("visible report document escaped exact organization scope")
	}
	safetyData, err := json.Marshal(value["safety"])
	if err != nil {
		return err
	}
	var safety reportOnlyArtifactSafety
	if err := json.Unmarshal(safetyData, &safety); err != nil {
		return err
	}
	return validateReportOnlySafety(safety)
}

func validateVisibleNonFinancialReviewProjection(value map[string]any, engineManifest r001ReportOnlyManifest) error {
	countValue, countOK := value["non_financial_review_count"].(float64)
	rowCountValue, rowCountOK := value["non_financial_review_row_count"].(float64)
	digest, digestOK := value["non_financial_review_set_sha256"].(string)
	rawReviews, reviewsOK := value["non_financial_reviews"]
	if !countOK || !rowCountOK || !digestOK || !reviewsOK || countValue < 0 || rowCountValue < 0 ||
		countValue != float64(int(countValue)) || rowCountValue != float64(int(rowCountValue)) {
		return errors.New("visible non-financial review projection is missing")
	}
	reviewData, err := json.Marshal(rawReviews)
	if err != nil {
		return err
	}
	var reviews []r001NonFinancialReview
	if err := json.Unmarshal(reviewData, &reviews); err != nil {
		return errors.New("visible non-financial review projection is malformed")
	}
	count, rowCount := int(countValue), int(rowCountValue)
	if err := validateNonFinancialReviewSet(reviews, &count, &rowCount, digest); err != nil {
		return fmt.Errorf("invalid visible non-financial review projection: %w", err)
	}
	if engineManifest.Results.NonFinancialReviewCount == nil || engineManifest.Results.NonFinancialReviewRows == nil ||
		count != *engineManifest.Results.NonFinancialReviewCount || rowCount != *engineManifest.Results.NonFinancialReviewRows ||
		!strings.EqualFold(digest, engineManifest.Results.NonFinancialReviewSHA256) {
		return errors.New("visible non-financial review projection drifted from the immutable R001 manifest")
	}
	return nil
}

func validateVisibleReportPackage(r001Dir string, run Run, contextValue Context) error {
	if err := validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue); err != nil {
		return err
	}
	engineManifestPath, err := findR001Manifest(r001Dir)
	if err != nil {
		return err
	}
	var engineManifest r001ReportOnlyManifest
	if err := readJSONFile(engineManifestPath, &engineManifest); err != nil {
		return err
	}
	enginePackageDir := filepath.Dir(filepath.Dir(engineManifestPath))
	runDir := filepath.Dir(r001Dir)
	technicalDir := filepath.Join(r001Dir, "service-report-package", "technical")
	paths := map[string]string{
		"manifest":    filepath.Join(technicalDir, "report-package.manifest.json"),
		"diagnostics": filepath.Join(technicalDir, "diagnostics.json"),
		"journal":     filepath.Join(technicalDir, "action-journal.json"),
		"registry":    filepath.Join(technicalDir, "artifact-registry.json"),
	}
	for _, filePath := range paths {
		if err := rejectSymlinkTraversal(runDir, filePath); err != nil {
			return err
		}
		if !regularFile(filePath) {
			return fmt.Errorf("required visible report artifact is missing: %s", filepath.Base(filePath))
		}
	}
	var packageManifest map[string]any
	if err := readJSONFile(paths["manifest"], &packageManifest); err != nil {
		return err
	}
	if err := validateVisibleDocumentScope(packageManifest, "opiu-report-only-visible-package.v1", run, contextValue); err != nil {
		return err
	}
	routeRows, routeRowsOK := packageManifest["route_rows"].(float64)
	loaderCount, loaderCountOK := packageManifest["loader_workbook_count"].(float64)
	if !routeRowsOK || engineManifest.Results.CanonicalRows == nil || int(routeRows) != *engineManifest.Results.CanonicalRows || !loaderCountOK {
		return errors.New("visible report manifest route counts are missing or inconsistent")
	}
	if err := validateVisibleNonFinancialReviewProjection(packageManifest, engineManifest); err != nil {
		return err
	}
	for field, expected := range map[string]struct{ name, kind string }{
		"diagnostics":       {filepath.ToSlash(filepath.Join("r001", "service-report-package", "technical", "diagnostics.json")), "diagnostics"},
		"journal":           {filepath.ToSlash(filepath.Join("r001", "service-report-package", "technical", "action-journal.json")), "journal"},
		"artifact_registry": {filepath.ToSlash(filepath.Join("r001", "service-report-package", "technical", "artifact-registry.json")), "registry"},
		"engine_manifest":   {filepath.ToSlash(filepath.Join("r001", filepath.Base(enginePackageDir), "technical", "manifest.json")), "manifest"},
	} {
		if err := validateVisibleArtifactDescriptor(runDir, packageManifest[field], expected.name, expected.kind); err != nil {
			return err
		}
	}
	for key, schema := range map[string]string{
		"diagnostics": "opiu-report-only-diagnostics.v1",
		"journal":     "opiu-report-only-action-journal.v1",
		"registry":    "opiu-report-only-artifact-registry.v1",
	} {
		var document map[string]any
		if err := readJSONFile(paths[key], &document); err != nil {
			return err
		}
		if err := validateVisibleDocumentScope(document, schema, run, contextValue); err != nil {
			return err
		}
		if err := validateVisibleNonFinancialReviewProjection(document, engineManifest); err != nil {
			return err
		}
	}
	var registry struct {
		Artifacts            []visibleReportArtifact `json:"artifacts"`
		CorrectionRegistries []string                `json:"correction_registries"`
	}
	if err := readJSONFile(paths["registry"], &registry); err != nil {
		return err
	}
	if len(registry.Artifacts) == 0 || len(registry.CorrectionRegistries) == 0 {
		return errors.New("visible report registry does not declare required output artifacts")
	}
	declared := map[string]bool{}
	actualLoaderCount := 0
	for _, artifact := range registry.Artifacts {
		if declared[artifact.Name] {
			return fmt.Errorf("visible report registry duplicated artifact: %s", artifact.Name)
		}
		declared[artifact.Name] = true
		if err := validateVisibleArtifactDescriptor(runDir, map[string]any{
			"name": artifact.Name, "kind": artifact.Kind, "size": float64(artifact.Size), "sha256": artifact.SHA256,
		}, artifact.Name, artifact.Kind); err != nil {
			return err
		}
		if artifact.Kind == "upload" || artifact.Kind == "disputed" {
			actualLoaderCount++
		}
	}
	if int(loaderCount) != actualLoaderCount {
		return errors.New("visible report manifest loader workbook count is inconsistent")
	}
	for _, required := range []string{
		filepath.ToSlash(filepath.Join("r005", "reconciliation.xlsx")),
		filepath.ToSlash(filepath.Join("r005", "reconciliation.codex-input.json")),
		filepath.ToSlash(filepath.Join("r005", "reconciliation.manifest.json")),
		filepath.ToSlash(filepath.Join("r001", "service-report-package", "technical", "diagnostics.json")),
		filepath.ToSlash(filepath.Join("r001", "service-report-package", "technical", "action-journal.json")),
		filepath.ToSlash(filepath.Join("r001", filepath.Base(enginePackageDir), "technical", "manifest.json")),
	} {
		if !declared[required] {
			return fmt.Errorf("visible report registry omitted artifact: %s", required)
		}
	}
	for _, registryName := range registry.CorrectionRegistries {
		if !declared[registryName] || resultKind("r001", strings.TrimPrefix(registryName, "r001/")) != "registry" {
			return errors.New("visible package correction registry declaration is invalid")
		}
	}
	for outputName := range engineManifest.Outputs {
		outputPath := filepath.Join(enginePackageDir, filepath.FromSlash(outputName))
		relative, err := filepath.Rel(runDir, outputPath)
		if err != nil || !declared[filepath.ToSlash(relative)] {
			return fmt.Errorf("visible report registry omitted engine output: %s", outputName)
		}
	}
	return nil
}

func visibleReportDownloadAllowance(r001Dir, relative string) (visibleReportArtifact, error) {
	runDir := filepath.Dir(r001Dir)
	cleanRelative := filepath.Clean(filepath.FromSlash(relative))
	if cleanRelative == "." || filepath.IsAbs(cleanRelative) || cleanRelative == ".." || strings.HasPrefix(cleanRelative, ".."+string(os.PathSeparator)) {
		return visibleReportArtifact{}, errors.New("requested report artifact path is unsafe")
	}
	expectedName := filepath.ToSlash(filepath.Join("r001", cleanRelative))
	technicalDir := filepath.Join(r001Dir, "service-report-package", "technical")
	packageManifestPath := filepath.Join(technicalDir, "report-package.manifest.json")
	if sameFilesystemPath(filepath.Join(r001Dir, cleanRelative), packageManifestPath) {
		return visibleArtifact(runDir, packageManifestPath, "manifest")
	}
	var packageManifest map[string]any
	if err := readJSONFile(packageManifestPath, &packageManifest); err != nil {
		return visibleReportArtifact{}, err
	}
	for _, field := range []string{"diagnostics", "journal", "artifact_registry", "engine_manifest"} {
		raw, ok := packageManifest[field].(map[string]any)
		if !ok || raw["name"] != expectedName {
			continue
		}
		artifact := visibleReportArtifact{}
		data, err := json.Marshal(raw)
		if err != nil || json.Unmarshal(data, &artifact) != nil || artifact.Name != expectedName || !validSHA256(artifact.SHA256) || artifact.Size < 0 {
			return visibleReportArtifact{}, errors.New("visible report artifact descriptor is invalid")
		}
		return artifact, nil
	}
	var registry struct {
		Artifacts []visibleReportArtifact `json:"artifacts"`
	}
	if err := readJSONFile(filepath.Join(technicalDir, "artifact-registry.json"), &registry); err != nil {
		return visibleReportArtifact{}, err
	}
	for _, artifact := range registry.Artifacts {
		if artifact.Name == expectedName && validSHA256(artifact.SHA256) && artifact.Size >= 0 {
			return artifact, nil
		}
	}
	return visibleReportArtifact{}, errors.New("requested file is not in the verified report-package allowlist")
}

func (p *Pipeline) runDiagnosticR001Package(adapter *RuntimeAdapter, run Run, contextValue Context, runDir, r005Report, r005Codex, r001Dir, blockerStage, blockerStatus, blockerMessage string) error {
	if err := validateR005ReportOnlyPackage(filepath.Dir(r005Report), contextValue, false); err != nil {
		return err
	}
	if err := resetR001OutputDirectory(runDir, r001Dir); err != nil {
		return err
	}
	structuralControlProofPath := filepath.Join(filepath.Dir(r005Codex), structuralControlProofFilename)
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, r005Codex, structuralControlProofPath); err != nil {
		return err
	}
	diagnosticScript := strings.TrimSpace(adapter.R001DiagnosticScript)
	if diagnosticScript == "" {
		// Compatibility for explicitly constructed test/legacy adapters. Runtime
		// discovery always binds this to the separately verified R001 core.
		diagnosticScript = adapter.R001Script
	}
	command := []string{
		adapter.Node, diagnosticScript,
		"--reconciliation", r005Report,
		"--codex-input", r005Codex,
		"--output", r001Dir,
		"--period", contextValue.Period,
		"--organization", contextValue.Organization,
		"--run-id", run.ID,
		"--organization-id", contextValue.OrganizationID,
	}
	command = appendStructuralControlProofArgument(command, structuralControlProofPath)
	runErr := p.runStage("R001_DIAGNOSTIC", command, nil, runDir, adapter.Root)
	packageErr := validateR001ReportOnlyPackage(r001Dir)
	if packageErr == nil {
		packageErr = validateR001ReportOnlyPackageForRun(r001Dir, run, contextValue)
	}
	if packageErr == nil {
		return materializeVisibleReportPackage(run, contextValue, runDir, r001Dir, blockerStage, blockerStatus, blockerMessage)
	}
	if runErr != nil {
		return fmt.Errorf("R001 diagnostic stage failed: %v; package invalid: %w", runErr, packageErr)
	}
	return packageErr
}
