package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	serviceR001HandoffSchema   = "opiu-service-r005-r001-handoff.v1"
	serviceR001HandoffType     = "R005_R001_SERVICE_HANDOFF"
	serviceR001HandoffFilename = "r005-r001-service-handoff.json"
)

type serviceHandoffArtifact struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type serviceHandoffJournal struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Sheet  string `json:"sheet"`
}

type serviceHandoffOrganization struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	HierarchyPath string `json:"hierarchy_path"`
}

type serviceHandoffSources struct {
	ERP     serviceHandoffArtifact `json:"erp"`
	Intalev serviceHandoffArtifact `json:"intalev"`
}

type serviceHandoffR005 struct {
	Workbook   serviceHandoffArtifact `json:"workbook"`
	CodexInput serviceHandoffArtifact `json:"codex_input"`
	Manifest   serviceHandoffArtifact `json:"manifest"`
}

type serviceHandoffStructural struct {
	Inventory        serviceHandoffArtifact `json:"inventory"`
	InventoryBinding serviceHandoffArtifact `json:"inventory_binding"`
	Proof            serviceHandoffArtifact `json:"proof"`
	ProofBinding     serviceHandoffArtifact `json:"proof_binding"`
}

type serviceHandoffPhysicalEvidence struct {
	Status             string                 `json:"status"`
	ERPPackage         serviceHandoffArtifact `json:"erp_package"`
	ERPJournal         serviceHandoffJournal  `json:"erp_journal"`
	SourceRowIDs       []string               `json:"source_row_ids"`
	SourceRowIDsSHA256 string                 `json:"source_row_ids_sha256"`
	UniqueCount        int                    `json:"unique_count"`
	ReuseCount         int                    `json:"reuse_count"`
}

type serviceHandoffCrossChecks struct {
	ManifestSchema              string `json:"manifest_schema"`
	CodexInputSchema            string `json:"codex_input_schema"`
	ScopeVerified               bool   `json:"scope_verified"`
	SourceHashesVerified        bool   `json:"source_hashes_verified"`
	R005HashesVerified          bool   `json:"r005_hashes_verified"`
	StructuralInventoryVerified bool   `json:"structural_inventory_verified"`
	StructuralProofVerified     bool   `json:"structural_proof_verified"`
	PhysicalEvidenceBound       bool   `json:"physical_evidence_bound"`
}

type serviceR001Handoff struct {
	SchemaVersion    string                         `json:"schema_version"`
	ArtifactType     string                         `json:"artifact_type"`
	RunID            string                         `json:"run_id"`
	SourceRunID      string                         `json:"source_run_id"`
	ContextID        string                         `json:"context_id"`
	Organization     serviceHandoffOrganization     `json:"organization"`
	Period           string                         `json:"period"`
	Sources          serviceHandoffSources          `json:"sources"`
	R005             serviceHandoffR005             `json:"r005"`
	Structural       serviceHandoffStructural       `json:"structural"`
	PhysicalEvidence serviceHandoffPhysicalEvidence `json:"physical_evidence"`
	CrossChecks      serviceHandoffCrossChecks      `json:"cross_checks"`
	Safety           SafetyState                    `json:"safety"`
}

type serviceR001HandoffRef struct {
	Path   string
	SHA256 string
}

func materializeServiceR001Handoff(run Run, contextValue Context, runDir, erpPath, intalevPath string) (serviceR001HandoffRef, error) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		return serviceR001HandoffRef{}, err
	}
	r005Dir := filepath.Join(runDir, "r005")
	workbookPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")

	runManifest, err := readServiceRunManifest(run, contextValue, runDir)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	erpRef, err := handoffSourceArtifact(erpPath, runManifest.ERP)
	if err != nil {
		return serviceR001HandoffRef{}, fmt.Errorf("ERP source binding: %w", err)
	}
	intalevRef, err := handoffSourceArtifact(intalevPath, runManifest.Intalev)
	if err != nil {
		return serviceR001HandoffRef{}, fmt.Errorf("Intalev source binding: %w", err)
	}
	workbookRef, err := handoffArtifact(workbookPath)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	codexRef, err := handoffArtifact(codexPath)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	manifestRef, err := handoffArtifact(manifestPath)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}

	codex, manifest, err := validateR005HandoffInputs(run, contextValue, workbookRef, codexRef, manifestRef)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	if _, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue); err != nil {
		return serviceR001HandoffRef{}, fmt.Errorf("structural inventory: %w", err)
	}
	proofPath := filepath.Join(r005Dir, structuralControlProofFilename)
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, codexPath, proofPath); err != nil {
		return serviceR001HandoffRef{}, fmt.Errorf("structural proof: %w", err)
	}
	structural, err := handoffStructuralArtifacts(r005Dir)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	physical, err := physicalEvidenceFromR005(codex, erpRef)
	if err != nil {
		return serviceR001HandoffRef{}, err
	}

	document := serviceR001Handoff{
		SchemaVersion: serviceR001HandoffSchema,
		ArtifactType:  serviceR001HandoffType,
		RunID:         run.ID,
		SourceRunID:   run.ID,
		ContextID:     contextValue.ID,
		Organization: serviceHandoffOrganization{
			ID: contextValue.OrganizationID, Name: contextValue.OrganizationName,
			HierarchyPath: contextValue.OrganizationPath,
		},
		Period:           contextValue.Period,
		Sources:          serviceHandoffSources{ERP: erpRef, Intalev: intalevRef},
		R005:             serviceHandoffR005{Workbook: workbookRef, CodexInput: codexRef, Manifest: manifestRef},
		Structural:       structural,
		PhysicalEvidence: physical,
		CrossChecks: serviceHandoffCrossChecks{
			ManifestSchema: "opiu-auto-reconciliation-run-v3", CodexInputSchema: "opiu-codex-review-input-v1",
			ScopeVerified: true, SourceHashesVerified: true, R005HashesVerified: true,
			StructuralInventoryVerified: true, StructuralProofVerified: true, PhysicalEvidenceBound: true,
		},
		Safety: reportOnlySafety(),
	}
	_ = manifest

	handoffDir := filepath.Join(runDir, "handoff")
	path := filepath.Join(handoffDir, serviceR001HandoffFilename)
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return serviceR001HandoffRef{}, err
	}
	data = append(data, '\n')
	if err := writeImmutablePrivateFile(path, data); err != nil {
		return serviceR001HandoffRef{}, err
	}
	digest := sha256.Sum256(data)
	hash := strings.ToUpper(hex.EncodeToString(digest[:]))
	if err := writeImmutablePrivateFile(path+".sha256", []byte(hash+"\n")); err != nil {
		return serviceR001HandoffRef{}, err
	}
	if _, err := verifyServiceR001Handoff(path, hash, run, contextValue, runDir); err != nil {
		return serviceR001HandoffRef{}, err
	}
	return serviceR001HandoffRef{Path: path, SHA256: hash}, nil
}

func verifyServiceR001Handoff(path, expectedSHA string, run Run, contextValue Context, runDir string) (serviceR001Handoff, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return serviceR001Handoff{}, err
	}
	digest := sha256.Sum256(data)
	actualSHA := strings.ToUpper(hex.EncodeToString(digest[:]))
	if !validSHA256(expectedSHA) || !strings.EqualFold(actualSHA, expectedSHA) {
		return serviceR001Handoff{}, errors.New("service handoff SHA-256 mismatch")
	}
	sidecar, err := os.ReadFile(path + ".sha256")
	if err != nil || strings.TrimSpace(string(sidecar)) != actualSHA {
		return serviceR001Handoff{}, errors.New("service handoff SHA-256 sidecar mismatch")
	}
	expectedPath := filepath.Join(runDir, "handoff", serviceR001HandoffFilename)
	if !sameFilesystemPath(path, expectedPath) || rejectSymlinkTraversal(runDir, path) != nil {
		return serviceR001Handoff{}, errors.New("service handoff path escaped canonical run")
	}
	var document serviceR001Handoff
	if err := decodeJSONRejectDuplicateKeys(data, &document, true); err != nil {
		return serviceR001Handoff{}, err
	}
	if document.SchemaVersion != serviceR001HandoffSchema || document.ArtifactType != serviceR001HandoffType ||
		document.RunID != run.ID || document.SourceRunID != run.ID || document.ContextID != contextValue.ID ||
		document.Organization.ID != contextValue.OrganizationID || document.Organization.Name != contextValue.OrganizationName ||
		document.Organization.HierarchyPath != contextValue.OrganizationPath || document.Period != contextValue.Period ||
		document.Safety != reportOnlySafety() {
		return serviceR001Handoff{}, errors.New("service handoff scope or REPORT_ONLY safety mismatch")
	}
	checks := document.CrossChecks
	if checks.ManifestSchema != "opiu-auto-reconciliation-run-v3" || checks.CodexInputSchema != "opiu-codex-review-input-v1" ||
		!checks.ScopeVerified || !checks.SourceHashesVerified || !checks.R005HashesVerified ||
		!checks.StructuralInventoryVerified || !checks.StructuralProofVerified || !checks.PhysicalEvidenceBound {
		return serviceR001Handoff{}, errors.New("service handoff cross-check closure is incomplete")
	}
	for _, ref := range []serviceHandoffArtifact{
		document.Sources.ERP, document.Sources.Intalev,
		document.R005.Workbook, document.R005.CodexInput, document.R005.Manifest,
		document.Structural.Inventory, document.Structural.InventoryBinding,
		document.Structural.Proof, document.Structural.ProofBinding,
	} {
		if err := verifyHandoffArtifact(ref); err != nil {
			return serviceR001Handoff{}, err
		}
	}
	if !reflectArtifact(document.PhysicalEvidence.ERPPackage, document.Sources.ERP) {
		return serviceR001Handoff{}, errors.New("physical ERP package is not the pinned source")
	}
	if err := verifyHandoffJournal(document.PhysicalEvidence.ERPJournal); err != nil {
		return serviceR001Handoff{}, err
	}
	if err := validatePhysicalDigest(document.PhysicalEvidence); err != nil {
		return serviceR001Handoff{}, err
	}
	if _, _, err := validateR005HandoffInputs(run, contextValue, document.R005.Workbook, document.R005.CodexInput, document.R005.Manifest); err != nil {
		return serviceR001Handoff{}, err
	}
	if _, err := validateStructuralControlInventoryForAnchor(filepath.Join(runDir, "r005"), run, contextValue); err != nil {
		return serviceR001Handoff{}, err
	}
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, document.R005.CodexInput.Path, document.Structural.Proof.Path); err != nil {
		return serviceR001Handoff{}, err
	}
	return document, nil
}

func readServiceRunManifest(run Run, contextValue Context, runDir string) (internalRunManifest, error) {
	data, err := os.ReadFile(filepath.Join(runDir, "run_manifest.json"))
	if err != nil {
		return internalRunManifest{}, err
	}
	var manifest internalRunManifest
	if err := decodeJSONRejectDuplicateKeys(data, &manifest, true); err != nil {
		return internalRunManifest{}, err
	}
	if err := validateStructuralControlManifestScope(manifest, run, contextValue); err != nil {
		return internalRunManifest{}, err
	}
	return manifest, nil
}

func handoffSourceArtifact(path string, expected internalFile) (serviceHandoffArtifact, error) {
	ref, err := handoffArtifact(path)
	if err != nil {
		return serviceHandoffArtifact{}, err
	}
	if ref.Size != expected.Size || !strings.EqualFold(ref.SHA256, expected.SHA256) {
		return serviceHandoffArtifact{}, errors.New("source size or SHA-256 drift")
	}
	return ref, nil
}

func handoffArtifact(path string) (serviceHandoffArtifact, error) {
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return serviceHandoffArtifact{}, err
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		return serviceHandoffArtifact{}, errors.New("handoff artifact is missing or not regular")
	}
	hash, err := sha256File(absolute)
	if err != nil {
		return serviceHandoffArtifact{}, err
	}
	return serviceHandoffArtifact{Path: absolute, Size: info.Size(), SHA256: strings.ToUpper(hash)}, nil
}

func verifyHandoffArtifact(ref serviceHandoffArtifact) error {
	if strings.TrimSpace(ref.Path) == "" || ref.Size < 0 || !validUpperSHA256(ref.SHA256) {
		return errors.New("handoff artifact descriptor is incomplete")
	}
	actual, err := handoffArtifact(ref.Path)
	if err != nil || !reflectArtifact(actual, ref) {
		return errors.New("handoff artifact size or SHA-256 drift")
	}
	return nil
}

func reflectArtifact(left, right serviceHandoffArtifact) bool {
	return sameFilesystemPath(left.Path, right.Path) && left.Size == right.Size && strings.EqualFold(left.SHA256, right.SHA256)
}

func handoffStructuralArtifacts(r005Dir string) (serviceHandoffStructural, error) {
	paths := []string{
		filepath.Join(r005Dir, "structural-control-inventory.json"),
		filepath.Join(r005Dir, structuralControlInventoryFile),
		filepath.Join(r005Dir, structuralControlProofFilename),
		filepath.Join(r005Dir, structuralControlProofBindingFile),
	}
	refs := make([]serviceHandoffArtifact, 0, len(paths))
	for _, path := range paths {
		ref, err := handoffArtifact(path)
		if err != nil {
			return serviceHandoffStructural{}, err
		}
		refs = append(refs, ref)
	}
	return serviceHandoffStructural{Inventory: refs[0], InventoryBinding: refs[1], Proof: refs[2], ProofBinding: refs[3]}, nil
}

func validateR005HandoffInputs(run Run, contextValue Context, workbook, codexRef, manifestRef serviceHandoffArtifact) (map[string]any, map[string]any, error) {
	for _, ref := range []serviceHandoffArtifact{workbook, codexRef, manifestRef} {
		if err := verifyHandoffArtifact(ref); err != nil {
			return nil, nil, err
		}
	}
	codex, err := readLooseJSONMap(codexRef.Path)
	if err != nil {
		return nil, nil, err
	}
	manifest, err := readLooseJSONMap(manifestRef.Path)
	if err != nil {
		return nil, nil, err
	}
	if mapText(codex, "schema") != "opiu-codex-review-input-v1" || mapText(manifest, "schema") != "opiu-auto-reconciliation-run-v3" ||
		mapText(codex, "organization") != contextValue.OrganizationName || mapText(manifest, "organization") != contextValue.OrganizationName ||
		mapText(codex, "organization_code") != contextValue.OrganizationID || mapText(manifest, "organization_code") != contextValue.OrganizationID ||
		mapText(codex, "period") != contextValue.Period || mapText(manifest, "period") != contextValue.Period {
		return nil, nil, errors.New("R005 codex/manifest scope mismatch")
	}
	if !closedR005Map(codex) || !closedR005Map(manifest) {
		return nil, nil, errors.New("R005 codex/manifest REPORT_ONLY safety mismatch")
	}
	if !sameFilesystemPath(mapText(codex, "report_path"), workbook.Path) || !strings.EqualFold(mapText(codex, "report_sha256"), workbook.SHA256) ||
		!sameFilesystemPath(mapText(manifest, "output_path"), workbook.Path) || !strings.EqualFold(mapText(manifest, "output_sha256"), workbook.SHA256) ||
		!sameFilesystemPath(mapText(manifest, "codex_input_path"), codexRef.Path) || !strings.EqualFold(mapText(manifest, "codex_input_sha256"), codexRef.SHA256) {
		return nil, nil, errors.New("R005 artifact cross-links mismatch")
	}
	_ = run
	return codex, manifest, nil
}

func readLooseJSONMap(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := decodeJSONRejectDuplicateKeys(data, &value, false); err != nil {
		return nil, err
	}
	return value, nil
}

func closedR005Map(value map[string]any) bool {
	reportOnly, reportOnlyOK := value["report_only"].(bool)
	if !reportOnlyOK || !reportOnly {
		return false
	}
	for _, key := range []string{"posting_rows", "executed_posting_rows", "live_posting_rows"} {
		number, ok := value[key].(float64)
		if !ok || number != 0 {
			return false
		}
	}
	for _, key := range []string{"execution_allowed", "ready_to_upload", "release_allowed", "live_1c_allowed", "live_delete_allowed"} {
		flag, ok := value[key].(bool)
		if !ok || flag {
			return false
		}
	}
	return true
}

func physicalEvidenceFromR005(codex map[string]any, erpPackage serviceHandoffArtifact) (serviceHandoffPhysicalEvidence, error) {
	cross, _ := codex["cross_journal_discrepancy_evidence"].(map[string]any)
	operation, _ := codex["operation_evidence"].(map[string]any)
	journalPath, journalSHA, journalSheet := "", "", ""
	ids := []string{}
	reuseCount := 0
	if cross != nil && mapBool(cross, "applicable") {
		sources, _ := cross["sources"].(map[string]any)
		erp, _ := sources["erp"].(map[string]any)
		journalPath, journalSHA, journalSheet = mapText(erp, "path"), strings.ToUpper(mapText(erp, "sha256")), mapText(erp, "sheet")
		rows, _ := cross["rows"].([]any)
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			id := mapText(row, "erp_source_row_id")
			if id != "" && mapText(row, "financial_gate_status") == "ДОКАЗАНО" {
				ids = append(ids, id)
			}
			archiveSHA := strings.ToUpper(mapText(row, "source_archive_sha256"))
			if archiveSHA != "" && !strings.EqualFold(archiveSHA, erpPackage.SHA256) {
				return serviceHandoffPhysicalEvidence{}, errors.New("physical row escaped pinned ERP package")
			}
		}
		counts, _ := cross["counts"].(map[string]any)
		reuseCount = int(mapNumber(counts, "reused_intalev_rows") + mapNumber(counts, "reused_erp_rows"))
	}
	if journalSHA == "" && operation != nil {
		journalSHA, journalSheet = strings.ToUpper(mapText(operation, "journal_sha256")), mapText(operation, "journal_sheet")
		input, _ := operation["input"].(map[string]any)
		journalPath = mapText(input, "journal_source")
		rows, _ := operation["rows"].([]any)
		for _, raw := range rows {
			row, _ := raw.(map[string]any)
			if mapText(row, "evidence_status") == "PROVEN" {
				if id := mapText(row, "source_row_id"); id != "" {
					ids = append(ids, id)
				}
			}
		}
	}
	if reuseCount != 0 {
		return serviceHandoffPhysicalEvidence{}, errors.New("R005 reports reused physical rows")
	}
	ids, err := exactUniqueSourceRowIDs(ids)
	if err != nil {
		return serviceHandoffPhysicalEvidence{}, err
	}
	journalRef, err := handoffJournal(journalPath, journalSHA, journalSheet)
	if err != nil {
		return serviceHandoffPhysicalEvidence{}, err
	}
	digest, err := sourceRowIDsSHA256(ids)
	if err != nil {
		return serviceHandoffPhysicalEvidence{}, err
	}
	return serviceHandoffPhysicalEvidence{
		Status: "VERIFIED_JOURNAL_REPORT_ONLY", ERPPackage: erpPackage, ERPJournal: journalRef,
		SourceRowIDs: ids, SourceRowIDsSHA256: digest, UniqueCount: len(ids), ReuseCount: 0,
	}, nil
}

func handoffJournal(path, expectedSHA, sheet string) (serviceHandoffJournal, error) {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(sheet) == "" || !validSHA256(expectedSHA) {
		return serviceHandoffJournal{}, errors.New("R005 physical ERP journal proof is incomplete")
	}
	ref, err := handoffArtifact(path)
	if err != nil || !strings.EqualFold(ref.SHA256, expectedSHA) {
		return serviceHandoffJournal{}, errors.New("R005 physical ERP journal SHA-256 mismatch")
	}
	return serviceHandoffJournal{Path: ref.Path, Size: ref.Size, SHA256: ref.SHA256, Sheet: strings.TrimSpace(sheet)}, nil
}

func verifyHandoffJournal(ref serviceHandoffJournal) error {
	if strings.TrimSpace(ref.Sheet) == "" {
		return errors.New("handoff ERP journal sheet is missing")
	}
	return verifyHandoffArtifact(serviceHandoffArtifact{Path: ref.Path, Size: ref.Size, SHA256: ref.SHA256})
}

func exactUniqueSourceRowIDs(values []string) ([]string, error) {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if seen[value] {
			return nil, errors.New("duplicate physical SourceRowID")
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func sourceRowIDsSHA256(values []string) (string, error) {
	data, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func validatePhysicalDigest(value serviceHandoffPhysicalEvidence) error {
	if value.Status != "VERIFIED_JOURNAL_REPORT_ONLY" || value.ReuseCount != 0 || value.UniqueCount != len(value.SourceRowIDs) {
		return errors.New("handoff physical evidence counters are invalid")
	}
	exact, err := exactUniqueSourceRowIDs(value.SourceRowIDs)
	if err != nil || len(exact) != len(value.SourceRowIDs) {
		return errors.New("handoff physical SourceRowIDs are not exact and unique")
	}
	for index := range exact {
		if exact[index] != value.SourceRowIDs[index] {
			return errors.New("handoff physical SourceRowIDs are not canonically sorted")
		}
	}
	digest, err := sourceRowIDsSHA256(value.SourceRowIDs)
	if err != nil || digest != value.SourceRowIDsSHA256 {
		return errors.New("handoff physical SourceRowID digest mismatch")
	}
	return nil
}

func mapText(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return strings.TrimSpace(text)
}

func mapBool(value map[string]any, key string) bool {
	result, _ := value[key].(bool)
	return result
}

func mapNumber(value map[string]any, key string) float64 {
	switch typed := value[key].(type) {
	case float64:
		return typed
	case json.Number:
		result, _ := typed.Float64()
		return result
	default:
		return 0
	}
}
