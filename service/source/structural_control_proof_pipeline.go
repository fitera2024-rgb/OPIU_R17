package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

const (
	structuralControlRunManifestSchema  = "opiu-structural-control-run-binding.v1"
	structuralControlProofSchema        = "opiu-structural-control-proof.v1"
	structuralControlProofBindingSchema = "opiu-service-structural-control-proof-binding.v1"
	structuralControlProofFilename      = "structural-control-proof.json"
	structuralControlProofBindingFile   = "structural-control-proof.binding.json"
)

type structuralControlArtifactRef struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type structuralControlRegistryRef struct {
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	Revision int64  `json:"revision"`
}

type structuralControlProofContract struct {
	SchemaVersion string `json:"schema_version"`
	Path          string `json:"path"`
	BindingPath   string `json:"binding_path"`
}

type structuralControlRunManifestBinding struct {
	SchemaVersion            string                                `json:"schema_version"`
	Status                   string                                `json:"status"`
	RunID                    string                                `json:"run_id"`
	ContextID                string                                `json:"context_id"`
	Organization             string                                `json:"organization"`
	OrganizationID           string                                `json:"organization_id"`
	OrganizationName         string                                `json:"organization_name"`
	OrganizationPath         string                                `json:"organization_path"`
	Period                   string                                `json:"period"`
	PreBindingManifestSHA256 string                                `json:"pre_binding_manifest_sha256"`
	Settings                 structuralControlArtifactRef          `json:"settings"`
	SourceCSV                structuralControlArtifactRef          `json:"source_csv"`
	Selection                structuralControlArtifactRef          `json:"selection"`
	Registry                 structuralControlRegistryRef          `json:"registry"`
	AppliedVersions          []structuralControlPipelineVersionRef `json:"applied_versions"`
	ControlSetIDs            []string                              `json:"control_set_ids"`
	SetCount                 int                                   `json:"set_count"`
	ProofContract            structuralControlProofContract        `json:"proof_contract"`
	CorrectionAuthority      bool                                  `json:"correction_authority"`
	FinancialRows            int                                   `json:"financial_rows"`
	PostingRows              int                                   `json:"posting_rows"`
	Safety                   structuralControlPipelineSafety       `json:"safety"`
}

type structuralControlProofDescriptor struct {
	SchemaVersion                string   `json:"schema_version"`
	Status                       string   `json:"status"`
	SettingsStatus               string   `json:"settings_status"`
	SettingsBindingSHA256        string   `json:"settings_binding_sha256"`
	ControlResultsSHA256         string   `json:"control_results_sha256"`
	StructuralControlProofSHA256 string   `json:"structural_control_proof_sha256"`
	SetCount                     int      `json:"set_count"`
	ControlResultCount           int      `json:"control_result_count"`
	AppliedVersionIDs            []string `json:"applied_version_ids"`
	ReportOnly                   bool     `json:"report_only"`
	FinancialRows                int      `json:"financial_rows"`
	PostingRows                  int      `json:"posting_rows"`
	CorrectionAuthority          bool     `json:"correction_authority"`
	ExecutionAllowed             bool     `json:"execution_allowed"`
}

type structuralControlProofBinding struct {
	SchemaVersion       string                          `json:"schema_version"`
	RunID               string                          `json:"run_id"`
	ContextID           string                          `json:"context_id"`
	OrganizationID      string                          `json:"organization_id"`
	OrganizationName    string                          `json:"organization_name"`
	OrganizationPath    string                          `json:"organization_path"`
	Period              string                          `json:"period"`
	RunManifestSHA256   string                          `json:"run_manifest_sha256"`
	CodexInput          structuralControlArtifactRef    `json:"codex_input"`
	Proof               structuralControlArtifactRef    `json:"proof"`
	CorrectionAuthority bool                            `json:"correction_authority"`
	FinancialRows       int                             `json:"financial_rows"`
	PostingRows         int                             `json:"posting_rows"`
	Safety              structuralControlPipelineSafety `json:"safety"`
}

func bindStructuralControlRunManifest(run Run, contextValue Context, runDir string, audit structuralControlPipelineAudit) error {
	manifestPath := filepath.Join(runDir, "run_manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return err
	}
	var manifest internalRunManifest
	if err := decodeJSONRejectDuplicateKeys(manifestBytes, &manifest, true); err != nil {
		return fmt.Errorf("run manifest invalid before structural-control binding: %w", err)
	}
	if manifest.StructuralControl != nil {
		return errors.New("immutable run manifest already has a structural-control binding")
	}
	if err := validateStructuralControlManifestScope(manifest, run, contextValue); err != nil {
		return err
	}
	if err := validateStructuralControlAuditScope(audit, run, contextValue); err != nil {
		return err
	}
	binding := structuralControlRunManifestBinding{
		SchemaVersion: structuralControlRunManifestSchema,
		Status:        audit.Status, RunID: run.ID, ContextID: contextValue.ID,
		Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID,
		OrganizationName: contextValue.OrganizationName, OrganizationPath: contextValue.OrganizationPath,
		Period: contextValue.Period, PreBindingManifestSHA256: structuralControlBytesSHA256(manifestBytes),
		AppliedVersions: append([]structuralControlPipelineVersionRef{}, audit.AppliedVersions...),
		ControlSetIDs:   append([]string{}, audit.ControlSetIDs...), SetCount: audit.SetCount,
		ProofContract: structuralControlProofContract{
			SchemaVersion: structuralControlProofSchema,
			Path:          filepath.ToSlash(filepath.Join("r005", structuralControlProofFilename)),
			BindingPath:   filepath.ToSlash(filepath.Join("r005", structuralControlProofBindingFile)),
		},
		CorrectionAuthority: false, FinancialRows: 0, PostingRows: 0,
		Safety: structuralControlClosedSafety(),
	}
	if audit.Status == "ACTIVE_UI_FIXED_SETS_MATERIALIZED" {
		if err := validateActiveStructuralControlAudit(audit); err != nil {
			return err
		}
		binding.Settings, err = structuralControlManifestArtifact(runDir, audit.SettingsPath, audit.SettingsSHA256)
		if err != nil {
			return err
		}
		binding.SourceCSV, err = structuralControlManifestArtifact(runDir, audit.SourceCSVPath, audit.SourceCSVSHA256)
		if err != nil {
			return err
		}
		registryInfo, statErr := os.Stat(audit.RegistryPath)
		if statErr != nil || !registryInfo.Mode().IsRegular() {
			return errors.New("structural-control registry is unavailable during manifest binding")
		}
		binding.Registry = structuralControlRegistryRef{
			Path: audit.RegistryPath, SHA256: strings.ToUpper(audit.RegistrySHA256), Size: registryInfo.Size(), Revision: audit.RegistryRevision,
		}
	} else if audit.Status == structuralControlPackagedCSVStatus {
		if audit.SetCount < 1 || len(audit.ControlSetIDs) != audit.SetCount || len(audit.AppliedVersions) != 0 ||
			!validSHA256(audit.SettingsSHA256) || !validSHA256(audit.SourceCSVSHA256) || !validSHA256(audit.SelectionSHA256) ||
			strings.TrimSpace(audit.SettingsPath) == "" || strings.TrimSpace(audit.SourceCSVPath) == "" {
			return errors.New("packaged structural-control settings audit is inconsistent")
		}
		binding.Settings, err = structuralControlManifestArtifact(runDir, audit.SettingsPath, audit.SettingsSHA256)
		if err != nil {
			return err
		}
		binding.SourceCSV, err = structuralControlManifestArtifact(runDir, audit.SourceCSVPath, audit.SourceCSVSHA256)
		if err != nil {
			return err
		}
		binding.Selection, err = structuralControlManifestArtifact(runDir, audit.SelectionPath, audit.SelectionSHA256)
		if err != nil {
			return err
		}
	} else if audit.Status == structuralControlPackagedNoExactStatus {
		if audit.SetCount != 0 || len(audit.ControlSetIDs) != 0 || len(audit.AppliedVersions) != 0 ||
			!validSHA256(audit.SourceCSVSHA256) || !validSHA256(audit.SelectionSHA256) || strings.TrimSpace(audit.SourceCSVPath) == "" {
			return errors.New("packaged structural-control no-exact audit is inconsistent")
		}
		binding.SourceCSV, err = structuralControlManifestArtifact(runDir, audit.SourceCSVPath, audit.SourceCSVSHA256)
		if err != nil {
			return err
		}
		binding.Selection, err = structuralControlManifestArtifact(runDir, audit.SelectionPath, audit.SelectionSHA256)
		if err != nil {
			return err
		}
	} else if audit.Status != "NO_ACTIVE_UI_FIXED_SETS" || audit.SetCount != 0 || len(audit.ControlSetIDs) != 0 || len(audit.AppliedVersions) != 0 {
		return errors.New("structural-control default audit is inconsistent")
	}
	manifest.StructuralControl = &binding
	if err := atomicWriteJSON(manifestPath, manifest); err != nil {
		return err
	}
	_, err = readStructuralControlRunManifest(run, contextValue, runDir)
	return err
}

func structuralControlManifestArtifact(runDir, artifactPath, expectedSHA string) (structuralControlArtifactRef, error) {
	relative, err := filepath.Rel(runDir, artifactPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
		return structuralControlArtifactRef{}, errors.New("structural-control run artifact escaped run directory")
	}
	limit := structuralControlSettingsJSONMaxBytes
	if strings.EqualFold(filepath.Ext(artifactPath), ".csv") {
		limit = structuralControlPackagedCSVMaxBytes
	}
	data, err := readStructuralControlSecureArtifact(runDir, artifactPath, limit)
	actualSHA := structuralControlBytesSHA256(data)
	if err != nil || !validSHA256(expectedSHA) || !strings.EqualFold(actualSHA, expectedSHA) {
		return structuralControlArtifactRef{}, errors.New("structural-control manifest artifact hash mismatch")
	}
	return structuralControlArtifactRef{Path: filepath.ToSlash(relative), SHA256: strings.ToUpper(actualSHA), Size: int64(len(data))}, nil
}

func readStructuralControlRunManifest(run Run, contextValue Context, runDir string) (structuralControlRunManifestBinding, error) {
	manifestPath := filepath.Join(runDir, "run_manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return structuralControlRunManifestBinding{}, err
	}
	var manifest internalRunManifest
	if err := decodeJSONRejectDuplicateKeys(data, &manifest, true); err != nil {
		return structuralControlRunManifestBinding{}, err
	}
	if err := validateStructuralControlManifestScope(manifest, run, contextValue); err != nil {
		return structuralControlRunManifestBinding{}, err
	}
	if manifest.StructuralControl == nil {
		return structuralControlRunManifestBinding{}, errors.New("run manifest has no structural-control binding")
	}
	binding := *manifest.StructuralControl
	if binding.SchemaVersion != structuralControlRunManifestSchema || binding.RunID != run.ID || binding.ContextID != contextValue.ID ||
		binding.Organization != contextValue.Organization || binding.OrganizationID != contextValue.OrganizationID ||
		binding.OrganizationName != contextValue.OrganizationName || binding.OrganizationPath != contextValue.OrganizationPath ||
		binding.Period != contextValue.Period || !validSHA256(binding.PreBindingManifestSHA256) ||
		binding.CorrectionAuthority || binding.FinancialRows != 0 || binding.PostingRows != 0 ||
		!structuralControlSafetyClosed(binding.Safety) || binding.ProofContract.SchemaVersion != structuralControlProofSchema ||
		binding.ProofContract.Path != filepath.ToSlash(filepath.Join("r005", structuralControlProofFilename)) ||
		binding.ProofContract.BindingPath != filepath.ToSlash(filepath.Join("r005", structuralControlProofBindingFile)) {
		return structuralControlRunManifestBinding{}, errors.New("run manifest structural-control binding is incomplete or unsafe")
	}
	if binding.Status == "ACTIVE_UI_FIXED_SETS_MATERIALIZED" {
		if binding.SetCount < 1 || len(binding.ControlSetIDs) != binding.SetCount || len(binding.AppliedVersions) != binding.SetCount ||
			!validSHA256(binding.Settings.SHA256) || !validSHA256(binding.SourceCSV.SHA256) ||
			!validSHA256(binding.Registry.SHA256) || binding.Registry.Revision < 1 || !structuralControlArtifactRefEmpty(binding.Selection) {
			return structuralControlRunManifestBinding{}, errors.New("run manifest active structural-control refs are incomplete")
		}
		for _, artifact := range []structuralControlArtifactRef{binding.Settings, binding.SourceCSV} {
			resolved, err := resolveStructuralControlRunArtifact(runDir, artifact.Path)
			if err != nil {
				return structuralControlRunManifestBinding{}, err
			}
			limit := structuralControlSettingsJSONMaxBytes
			if strings.EqualFold(filepath.Ext(artifact.Path), ".csv") {
				limit = structuralControlPackagedCSVMaxBytes
			}
			data, err := readStructuralControlSecureArtifact(runDir, resolved, limit)
			if err != nil || !strings.EqualFold(structuralControlBytesSHA256(data), artifact.SHA256) || int64(len(data)) != artifact.Size {
				return structuralControlRunManifestBinding{}, errors.New("run manifest structural-control artifact drift")
			}
		}
	} else if binding.Status == structuralControlPackagedCSVStatus {
		if binding.SetCount < 1 || len(binding.ControlSetIDs) != binding.SetCount || len(binding.AppliedVersions) != 0 ||
			!validSHA256(binding.Settings.SHA256) || binding.Settings.Size < 1 || strings.TrimSpace(binding.Settings.Path) == "" ||
			!validSHA256(binding.SourceCSV.SHA256) || binding.SourceCSV.Size < 1 || strings.TrimSpace(binding.SourceCSV.Path) == "" ||
			!validSHA256(binding.Selection.SHA256) || binding.Selection.Size < 1 || strings.TrimSpace(binding.Selection.Path) == "" ||
			validSHA256(binding.Registry.SHA256) {
			return structuralControlRunManifestBinding{}, errors.New("run manifest packaged structural-control settings refs are incomplete")
		}
		for _, artifact := range []structuralControlArtifactRef{binding.Settings, binding.SourceCSV, binding.Selection} {
			resolved, err := resolveStructuralControlRunArtifact(runDir, artifact.Path)
			if err != nil {
				return structuralControlRunManifestBinding{}, err
			}
			limit := structuralControlSettingsJSONMaxBytes
			if artifact.Path == binding.SourceCSV.Path || artifact.Path == binding.Selection.Path {
				limit = structuralControlPackagedCSVMaxBytes
			}
			bytes, err := readStructuralControlSecureArtifact(runDir, resolved, limit)
			if err != nil || !strings.EqualFold(structuralControlBytesSHA256(bytes), artifact.SHA256) || int64(len(bytes)) != artifact.Size {
				return structuralControlRunManifestBinding{}, errors.New("run manifest packaged structural-control artifact drift")
			}
		}
	} else if binding.Status == structuralControlPackagedNoExactStatus {
		if binding.SetCount != 0 || len(binding.ControlSetIDs) != 0 || len(binding.AppliedVersions) != 0 ||
			!validSHA256(binding.SourceCSV.SHA256) || binding.SourceCSV.Size < 1 || strings.TrimSpace(binding.SourceCSV.Path) == "" ||
			!validSHA256(binding.Selection.SHA256) || binding.Selection.Size < 1 || strings.TrimSpace(binding.Selection.Path) == "" ||
			!structuralControlArtifactRefEmpty(binding.Settings) || validSHA256(binding.Registry.SHA256) ||
			strings.TrimSpace(binding.Registry.Path) != "" || binding.Registry.Size != 0 || binding.Registry.Revision != 0 {
			return structuralControlRunManifestBinding{}, errors.New("run manifest packaged structural-control no-exact ref is incomplete")
		}
		resolved, err := resolveStructuralControlRunArtifact(runDir, binding.SourceCSV.Path)
		if err != nil {
			return structuralControlRunManifestBinding{}, err
		}
		bytes, err := readStructuralControlSecureArtifact(runDir, resolved, structuralControlPackagedCSVMaxBytes)
		if err != nil || !strings.EqualFold(structuralControlBytesSHA256(bytes), binding.SourceCSV.SHA256) || int64(len(bytes)) != binding.SourceCSV.Size {
			return structuralControlRunManifestBinding{}, errors.New("run manifest packaged structural-control CSV drift")
		}
		resolvedSelection, err := resolveStructuralControlRunArtifact(runDir, binding.Selection.Path)
		if err != nil {
			return structuralControlRunManifestBinding{}, err
		}
		selectionBytes, err := readStructuralControlSecureArtifact(runDir, resolvedSelection, structuralControlPackagedCSVMaxBytes)
		if err != nil || !strings.EqualFold(structuralControlBytesSHA256(selectionBytes), binding.Selection.SHA256) || int64(len(selectionBytes)) != binding.Selection.Size {
			return structuralControlRunManifestBinding{}, errors.New("run manifest packaged structural-control selection drift")
		}
	} else if binding.Status != "NO_ACTIVE_UI_FIXED_SETS" || binding.SetCount != 0 || len(binding.ControlSetIDs) != 0 || len(binding.AppliedVersions) != 0 ||
		!structuralControlArtifactRefEmpty(binding.Settings) || !structuralControlArtifactRefEmpty(binding.SourceCSV) ||
		!structuralControlArtifactRefEmpty(binding.Selection) || strings.TrimSpace(binding.Registry.Path) != "" ||
		strings.TrimSpace(binding.Registry.SHA256) != "" || binding.Registry.Size != 0 || binding.Registry.Revision != 0 {
		return structuralControlRunManifestBinding{}, errors.New("run manifest structural-control default state is invalid")
	}
	return binding, nil
}

func structuralControlArtifactRefEmpty(ref structuralControlArtifactRef) bool {
	return strings.TrimSpace(ref.Path) == "" && strings.TrimSpace(ref.SHA256) == "" && ref.Size == 0
}

func validateStructuralControlManifestScope(manifest internalRunManifest, run Run, contextValue Context) error {
	if manifest.SchemaVersion != "opiu-stable-run.v1" || manifest.RunID != run.ID || manifest.ContextID != contextValue.ID ||
		manifest.Organization != contextValue.Organization || manifest.OrganizationID != contextValue.OrganizationID ||
		manifest.OrganizationName != contextValue.OrganizationName || manifest.OrganizationPath != contextValue.OrganizationPath ||
		manifest.Period != contextValue.Period || manifest.Safety.Mode != "REPORT_ONLY" || manifest.Safety.PostingRows != 0 ||
		manifest.Safety.ReadyToUpload || manifest.Safety.ReleaseAllowed || manifest.Safety.Live1CAllowed {
		return errors.New("run manifest scope or REPORT_ONLY safety does not match")
	}
	return nil
}

func validateStructuralControlAuditScope(audit structuralControlPipelineAudit, run Run, contextValue Context) error {
	if audit.RunID != run.ID || audit.ContextID != contextValue.ID || audit.Organization != contextValue.Organization ||
		audit.OrganizationID != contextValue.OrganizationID || audit.OrganizationName != contextValue.OrganizationName ||
		audit.OrganizationPath != contextValue.OrganizationPath || audit.Period != contextValue.Period ||
		audit.CorrectionAuthority || audit.FinancialRows != 0 || audit.PostingRows != 0 {
		return errors.New("structural-control materialization audit scope or authority does not match")
	}
	return nil
}

func validateActiveStructuralControlAudit(audit structuralControlPipelineAudit) error {
	if audit.SetCount < 1 || len(audit.ControlSetIDs) != audit.SetCount || len(audit.AppliedVersions) != audit.SetCount ||
		!validSHA256(audit.SettingsSHA256) || !validSHA256(audit.SourceCSVSHA256) || !validSHA256(audit.RegistrySHA256) {
		return errors.New("active structural-control materialization audit is incomplete")
	}
	for index, ref := range audit.AppliedVersions {
		if ref.ControlSetID != audit.ControlSetIDs[index] || ref.LineageID == "" || ref.Version < 1 ||
			!validSHA256(ref.PayloadSHA256) || ref.MaterializedSetID == "" || ref.OriginRunID == "" || ref.OriginContextID == "" ||
			ref.OriginInventoryID == "" || !validSHA256(ref.OriginInventoryBindingSHA256) {
			return errors.New("active structural-control version reference is incomplete")
		}
	}
	return nil
}

func structuralControlClosedSafety() structuralControlPipelineSafety {
	return structuralControlPipelineSafety{Mode: "REPORT_ONLY", PostingRows: 0, ReadyToUpload: false,
		ReleaseAllowed: false, ExecutionAllowed: false, Live1CAllowed: false}
}

func structuralControlSafetyClosed(value structuralControlPipelineSafety) bool {
	return value.Mode == "REPORT_ONLY" && value.PostingRows == 0 && !value.ReadyToUpload && !value.ReleaseAllowed &&
		!value.ExecutionAllowed && !value.Live1CAllowed
}

func resolveStructuralControlRunArtifact(runDir, relative string) (string, error) {
	if strings.TrimSpace(relative) == "" || filepath.IsAbs(relative) {
		return "", errors.New("structural-control run artifact path is not relative")
	}
	root, err := filepath.Abs(runDir)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", errors.New("structural-control run artifact escaped run directory")
	}
	return resolved, nil
}

func readStructuralControlSecureArtifact(root, path string, limit int64) ([]byte, error) {
	if limit < 1 {
		return nil, errors.New("structural artifact size limit is invalid")
	}
	cleanRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	cleanRoot = filepath.Clean(cleanRoot)
	cleanPath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	cleanPath = filepath.Clean(cleanPath)
	relative, err := filepath.Rel(cleanRoot, cleanPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return nil, errors.New("structural artifact escaped trusted directory")
	}
	if err := rejectReparsePathComponents(cleanRoot); err != nil {
		return nil, fmt.Errorf("structural artifact root is unsafe: %w", err)
	}
	if err := rejectReparsePathComponents(cleanPath); err != nil {
		return nil, fmt.Errorf("structural artifact path is unsafe: %w", err)
	}
	pathBefore, err := os.Lstat(cleanPath)
	if err != nil || !isBoundedStructuralControlArtifact(pathBefore.Mode(), pathBefore.Size(), limit) || pathBefore.Size() < 1 {
		return nil, errors.New("structural artifact is not a bounded regular file")
	}
	file, err := os.Open(cleanPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	handleBefore, err := file.Stat()
	if err != nil || !isBoundedStructuralControlArtifact(handleBefore.Mode(), handleBefore.Size(), limit) || handleBefore.Size() < 1 ||
		!os.SameFile(pathBefore, handleBefore) {
		return nil, errors.New("structural artifact changed before bounded read")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit || int64(len(data)) != handleBefore.Size() {
		return nil, errors.New("structural artifact changed size during bounded read")
	}
	handleAfter, err := file.Stat()
	pathAfter, pathErr := os.Lstat(cleanPath)
	if err != nil || pathErr != nil || !os.SameFile(handleBefore, handleAfter) || !os.SameFile(handleAfter, pathAfter) ||
		handleAfter.Size() != handleBefore.Size() || pathAfter.Size() != handleBefore.Size() ||
		!isBoundedStructuralControlArtifact(pathAfter.Mode(), pathAfter.Size(), limit) {
		return nil, errors.New("structural artifact changed after bounded read")
	}
	if err := rejectReparsePathComponents(cleanPath); err != nil {
		return nil, fmt.Errorf("structural artifact path changed to unsafe: %w", err)
	}
	return data, nil
}

func materializeStructuralControlProof(run Run, contextValue Context, runDir, codexPath string) (string, structuralControlProofDescriptor, error) {
	manifestBinding, err := readStructuralControlRunManifest(run, contextValue, runDir)
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	payload, codexBytes, err := readStructuralControlCodexPayload(codexPath)
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	descriptor, err := structuralControlProofFromCodexPayload(payload)
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	if err := verifyCodexProofAgainstRunManifest(payload, descriptor, manifestBinding, runDir); err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	r005Dir := filepath.Join(runDir, "r005")
	proofPath := filepath.Join(r005Dir, structuralControlProofFilename)
	proofBytes, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	proofBytes = append(proofBytes, '\n')
	if err := writeImmutablePrivateFile(proofPath, proofBytes); err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	proofRef, err := structuralControlManifestArtifact(runDir, proofPath, structuralControlBytesSHA256(proofBytes))
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	codexRef, err := structuralControlManifestArtifact(runDir, codexPath, structuralControlBytesSHA256(codexBytes))
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	manifestSHA, err := sha256File(filepath.Join(runDir, "run_manifest.json"))
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	proofBinding := structuralControlProofBinding{
		SchemaVersion: structuralControlProofBindingSchema, RunID: run.ID, ContextID: contextValue.ID,
		OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period,
		RunManifestSHA256: strings.ToUpper(manifestSHA), CodexInput: codexRef, Proof: proofRef,
		CorrectionAuthority: false, FinancialRows: 0, PostingRows: 0, Safety: structuralControlClosedSafety(),
	}
	bindingBytes, err := json.MarshalIndent(proofBinding, "", "  ")
	if err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	bindingBytes = append(bindingBytes, '\n')
	if err := writeImmutablePrivateFile(filepath.Join(r005Dir, structuralControlProofBindingFile), bindingBytes); err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	if _, err := verifyStructuralControlProofArtifact(run, contextValue, runDir, codexPath, proofPath); err != nil {
		return "", structuralControlProofDescriptor{}, err
	}
	return proofPath, descriptor, nil
}

func verifyStructuralControlProofArtifact(run Run, contextValue Context, runDir, codexPath, proofPath string) (structuralControlProofDescriptor, error) {
	manifestBinding, err := readStructuralControlRunManifest(run, contextValue, runDir)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	payload, codexBytes, err := readStructuralControlCodexPayload(codexPath)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	expected, err := structuralControlProofFromCodexPayload(payload)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if err := verifyCodexProofAgainstRunManifest(payload, expected, manifestBinding, runDir); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	proofBytes, err := os.ReadFile(proofPath)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	var actual structuralControlProofDescriptor
	if err := decodeJSONRejectDuplicateKeys(proofBytes, &actual, true); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if !reflect.DeepEqual(actual, expected) {
		return structuralControlProofDescriptor{}, errors.New("structural-control proof descriptor drift")
	}
	bindingPath := filepath.Join(runDir, "r005", structuralControlProofBindingFile)
	bindingBytes, err := os.ReadFile(bindingPath)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	var binding structuralControlProofBinding
	if err := decodeJSONRejectDuplicateKeys(bindingBytes, &binding, true); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	manifestSHA, err := sha256File(filepath.Join(runDir, "run_manifest.json"))
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if binding.SchemaVersion != structuralControlProofBindingSchema || binding.RunID != run.ID || binding.ContextID != contextValue.ID ||
		binding.OrganizationID != contextValue.OrganizationID || binding.OrganizationName != contextValue.OrganizationName ||
		binding.OrganizationPath != contextValue.OrganizationPath || binding.Period != contextValue.Period ||
		!strings.EqualFold(binding.RunManifestSHA256, manifestSHA) || binding.CorrectionAuthority ||
		binding.FinancialRows != 0 || binding.PostingRows != 0 || !structuralControlSafetyClosed(binding.Safety) {
		return structuralControlProofDescriptor{}, errors.New("structural-control proof binding scope or authority drift")
	}
	if err := verifyStructuralControlBoundArtifact(runDir, binding.CodexInput, codexPath, codexBytes); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if err := verifyStructuralControlBoundArtifact(runDir, binding.Proof, proofPath, proofBytes); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	return actual, nil
}

func verifyStructuralControlBoundArtifact(runDir string, ref structuralControlArtifactRef, requestedPath string, data []byte) error {
	resolved, err := resolveStructuralControlRunArtifact(runDir, ref.Path)
	if err != nil {
		return err
	}
	if !sameFilesystemPath(resolved, requestedPath) || ref.Size != int64(len(data)) || !validSHA256(ref.SHA256) ||
		!strings.EqualFold(ref.SHA256, structuralControlBytesSHA256(data)) {
		return errors.New("structural-control bound artifact drift")
	}
	return nil
}

func verifyStructuralControlProofHandoff(handoffPath string, run Run, contextValue Context, codexPath, proofPath string) error {
	expected, err := verifyStructuralControlProofArtifact(run, contextValue, filepath.Dir(filepath.Dir(proofPath)), codexPath, proofPath)
	if err != nil {
		return err
	}
	handoff, _, err := readStructuralControlObject(handoffPath)
	if err != nil {
		return err
	}
	if structuralControlText(handoff["run_id"]) != run.ID || structuralControlText(handoff["period"]) != contextValue.Period {
		return errors.New("Service handoff structural-control run or period mismatch")
	}
	organization, ok := handoff["organization"].(map[string]any)
	if !ok || structuralControlText(organization["id"]) != contextValue.OrganizationID ||
		structuralControlText(organization["name"]) != contextValue.OrganizationName ||
		structuralControlText(organization["path"]) != contextValue.OrganizationPath {
		return errors.New("Service handoff structural-control organization mismatch")
	}
	reconciliation, ok := handoff["reconciliation"].(map[string]any)
	if !ok || !sameFilesystemPath(structuralControlText(reconciliation["codex_input_path"]), codexPath) {
		return errors.New("Service handoff structural-control codex-input path mismatch")
	}
	codexSHA, err := sha256File(codexPath)
	if err != nil || !strings.EqualFold(structuralControlText(reconciliation["codex_input_sha256"]), codexSHA) {
		return errors.New("Service handoff structural-control codex-input hash mismatch")
	}
	actualProof, ok := handoff["structural_control_proof"]
	if !ok {
		return errors.New("Service handoff has no structural-control proof")
	}
	expectedHash, err := canonicalStructuralControlSHA256(expected)
	if err != nil {
		return err
	}
	actualHash, err := canonicalStructuralControlSHA256(actualProof)
	if err != nil || actualHash != expectedHash {
		return errors.New("Service handoff structural-control proof differs from Service artifact")
	}
	return nil
}

func readStructuralControlCodexPayload(path string) (map[string]any, []byte, error) {
	payload, data, err := readStructuralControlObject(path)
	if err != nil {
		return nil, nil, err
	}
	return payload, data, nil
}

func readStructuralControlObject(path string) (map[string]any, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	duplicateDecoder := json.NewDecoder(bytes.NewReader(data))
	if err := scanJSONValueForDuplicateKeys(duplicateDecoder); err != nil {
		return nil, nil, err
	}
	if _, err := duplicateDecoder.Token(); err != io.EOF {
		return nil, nil, errors.New("multiple JSON values are forbidden")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, nil, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, nil, errors.New("multiple JSON values are forbidden")
	}
	if value == nil {
		return nil, nil, errors.New("JSON object is required")
	}
	return value, data, nil
}

func readStructuralControlObjectWithin(root, path string, limit int64) (map[string]any, []byte, error) {
	data, err := readStructuralControlSecureArtifact(root, path, limit)
	if err != nil {
		return nil, nil, err
	}
	duplicateDecoder := json.NewDecoder(bytes.NewReader(data))
	if err := scanJSONValueForDuplicateKeys(duplicateDecoder); err != nil {
		return nil, nil, err
	}
	if _, err := duplicateDecoder.Token(); err != io.EOF {
		return nil, nil, errors.New("multiple JSON values are forbidden")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, nil, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF || value == nil {
		return nil, nil, errors.New("one JSON object is required")
	}
	return value, data, nil
}

func structuralControlProofFromCodexPayload(payload map[string]any) (structuralControlProofDescriptor, error) {
	if value, ok := payload["report_only"].(bool); !ok || !value {
		return structuralControlProofDescriptor{}, errors.New("structural-control proof requires REPORT_ONLY codex-input")
	}
	if err := structuralControlRequireZero(payload["posting_rows"], "codex.posting_rows"); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if err := structuralControlRequireFalse(payload["ready_to_upload"], "codex.ready_to_upload"); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	if err := structuralControlRequireFalse(payload["release_allowed"], "codex.release_allowed"); err != nil {
		return structuralControlProofDescriptor{}, err
	}
	binding := payload["structural_control_settings_binding"]
	resultsValue, exists := payload["structural_group_control_results"]
	if !exists {
		resultsValue = []any{}
	}
	results, ok := resultsValue.([]any)
	if !ok {
		return structuralControlProofDescriptor{}, errors.New("structural-control results are not an array")
	}
	if binding != nil {
		bindingMap, ok := binding.(map[string]any)
		if !ok {
			return structuralControlProofDescriptor{}, errors.New("structural-control settings binding is invalid")
		}
		for label, value := range map[string]any{"binding.financial_rows": bindingMap["financial_rows"], "binding.posting_rows": bindingMap["posting_rows"]} {
			if err := structuralControlRequireZero(value, label); err != nil {
				return structuralControlProofDescriptor{}, err
			}
		}
		if err := structuralControlRequireFalse(bindingMap["correction_authority"], "binding.correction_authority"); err != nil {
			return structuralControlProofDescriptor{}, err
		}
		if err := structuralControlRequireFalse(bindingMap["execution_allowed"], "binding.execution_allowed"); err != nil {
			return structuralControlProofDescriptor{}, err
		}
	} else if len(results) != 0 {
		return structuralControlProofDescriptor{}, errors.New("structural-control results exist without settings binding")
	}
	for index, raw := range results {
		result, ok := raw.(map[string]any)
		if !ok {
			return structuralControlProofDescriptor{}, errors.New("structural-control result is invalid")
		}
		if err := structuralControlRequireZero(result["financial_rows"], fmt.Sprintf("results[%d].financial_rows", index)); err != nil {
			return structuralControlProofDescriptor{}, err
		}
		if err := structuralControlRequireZero(result["posting_rows"], fmt.Sprintf("results[%d].posting_rows", index)); err != nil {
			return structuralControlProofDescriptor{}, err
		}
		if err := structuralControlRequireFalse(result["execution_allowed"], fmt.Sprintf("results[%d].execution_allowed", index)); err != nil {
			return structuralControlProofDescriptor{}, err
		}
		if value, exists := result["posting_allowed"]; exists {
			if err := structuralControlRequireFalse(value, fmt.Sprintf("results[%d].posting_allowed", index)); err != nil {
				return structuralControlProofDescriptor{}, err
			}
		}
	}
	settingsStatus := "MISSING_DEFAULT_ALL_GROUPS"
	setCount := 0
	var applied []string
	if bindingMap, ok := binding.(map[string]any); ok {
		if value := structuralControlText(bindingMap["status"]); value != "" {
			settingsStatus = value
		}
		var err error
		setCount, err = structuralControlInteger(bindingMap["set_count"])
		if err != nil {
			if sets, ok := bindingMap["sets"].([]any); ok {
				setCount = len(sets)
			} else {
				return structuralControlProofDescriptor{}, errors.New("structural-control set count is invalid")
			}
		}
		applied, err = structuralControlAppliedVersionIDs(bindingMap)
		if err != nil {
			return structuralControlProofDescriptor{}, err
		}
	}
	if setCount < 0 {
		return structuralControlProofDescriptor{}, errors.New("structural-control set count is invalid")
	}
	if settingsStatus == "ACTIVE_EXACT_ORGANIZATION_MONTH" && (setCount == 0 || len(applied) != setCount) {
		return structuralControlProofDescriptor{}, errors.New("active structural-control version count mismatch")
	}
	if settingsStatus == "MISSING_DEFAULT_ALL_GROUPS" && (setCount != 0 || len(applied) != 0 || len(results) != 0) {
		return structuralControlProofDescriptor{}, errors.New("default structural-control state mismatch")
	}
	settingsHash, err := canonicalStructuralControlSHA256(binding)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	resultsHash, err := canonicalStructuralControlSHA256(resultsValue)
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	proofHash, err := canonicalStructuralControlSHA256(map[string]any{
		"structural_control_settings_binding": binding,
		"structural_group_control_results":    resultsValue,
	})
	if err != nil {
		return structuralControlProofDescriptor{}, err
	}
	status := "ACTIVE_VERIFIED"
	if settingsStatus == "MISSING_DEFAULT_ALL_GROUPS" {
		status = "NO_ACTIVE_DEFAULT_ALL_GROUPS"
	}
	return structuralControlProofDescriptor{
		SchemaVersion: structuralControlProofSchema, Status: status, SettingsStatus: settingsStatus,
		SettingsBindingSHA256: settingsHash, ControlResultsSHA256: resultsHash,
		StructuralControlProofSHA256: proofHash, SetCount: setCount, ControlResultCount: len(results),
		AppliedVersionIDs: applied, ReportOnly: true, FinancialRows: 0, PostingRows: 0,
		CorrectionAuthority: false, ExecutionAllowed: false,
	}, nil
}

func structuralControlAppliedVersionIDs(binding map[string]any) ([]string, error) {
	registry, _ := binding["ui_fixed_registry"].(map[string]any)
	var values []any
	mode := ""
	if active, ok := registry["active_versions"].([]any); ok && len(active) > 0 {
		values, mode = active, "version"
	} else if ids, ok := registry["control_set_ids"].([]any); ok {
		values, mode = ids, "id"
	} else if sets, ok := binding["sets"].([]any); ok {
		values, mode = sets, "set"
	}
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, raw := range values {
		value := ""
		switch mode {
		case "version":
			version, ok := raw.(map[string]any)
			if !ok {
				return nil, errors.New("structural-control applied version is invalid")
			}
			id := structuralControlText(version["control_set_id"])
			number, err := structuralControlInteger(version["version"])
			payloadSHA := strings.ToUpper(structuralControlText(version["payload_sha256"]))
			if err != nil || number < 1 || id == "" || !validSHA256(payloadSHA) {
				return nil, errors.New("structural-control applied version is invalid")
			}
			value = id + "@" + strconv.Itoa(number) + ":" + payloadSHA
		case "id":
			value = structuralControlText(raw)
		case "set":
			set, ok := raw.(map[string]any)
			if !ok {
				return nil, errors.New("structural-control set ref is invalid")
			}
			value = structuralControlText(set["id"])
		}
		if value == "" || seen[value] {
			return nil, errors.New("structural-control applied version is empty or duplicate")
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func verifyCodexProofAgainstRunManifest(payload map[string]any, descriptor structuralControlProofDescriptor, binding structuralControlRunManifestBinding, runDir string) error {
	rawBinding := payload["structural_control_settings_binding"]
	if binding.Status == "NO_ACTIVE_UI_FIXED_SETS" {
		selection, selectionOK := payload["structural_control_settings_selection"].(map[string]any)
		if descriptor.Status != "NO_ACTIVE_DEFAULT_ALL_GROUPS" || descriptor.SetCount != 0 || descriptor.ControlResultCount != 0 ||
			!selectionOK || structuralControlText(selection["authority"]) != structuralControlAuthorityServiceNone ||
			structuralControlText(selection["status"]) != "SERVICE_NO_SETTINGS" || structuralControlText(selection["path"]) != "" {
			return errors.New("R005 codex-input did not preserve the manifest default structural-control state")
		}
		if err := verifyDefaultStructuralControlBinding(rawBinding); err != nil {
			return fmt.Errorf("R005 codex-input default structural-control binding is invalid: %w", err)
		}
		return nil
	}
	if binding.Status == structuralControlPackagedCSVStatus || binding.Status == structuralControlPackagedNoExactStatus {
		return verifyPackagedStructuralControlProof(payload, descriptor, binding, runDir)
	}
	settings, ok := rawBinding.(map[string]any)
	if !ok || descriptor.Status != "ACTIVE_VERIFIED" || descriptor.SetCount != binding.SetCount ||
		!strings.EqualFold(structuralControlText(settings["input_sha256"]), binding.Settings.SHA256) ||
		!strings.EqualFold(structuralControlText(settings["source_sha256"]), binding.SourceCSV.SHA256) {
		return errors.New("R005 codex-input structural-control settings do not match run manifest")
	}
	selection, ok := payload["structural_control_settings_selection"].(map[string]any)
	manifestSettingsPath, selectionErr := resolveStructuralControlRunArtifact(runDir, binding.Settings.Path)
	if !ok || selectionErr != nil || structuralControlText(selection["authority"]) != structuralControlAuthorityServiceJSON ||
		structuralControlText(selection["status"]) != "EXPLICIT_CLI_SETTINGS" ||
		!sameFilesystemPath(structuralControlText(selection["path"]), manifestSettingsPath) ||
		!sameFilesystemPath(structuralControlText(settings["input_path"]), manifestSettingsPath) {
		return errors.New("R005 codex-input structural-control selection path does not match run manifest")
	}
	registry, ok := settings["ui_fixed_registry"].(map[string]any)
	if !ok || structuralControlText(registry["status"]) != "ACTIVE_UI_FIXED_REGISTRY_VERIFIED" ||
		structuralControlText(registry["organization_id"]) != binding.OrganizationID ||
		structuralControlText(registry["run_id"]) != binding.RunID || structuralControlText(registry["context_id"]) != binding.ContextID ||
		!strings.EqualFold(structuralControlText(registry["registry_sha256"]), binding.Registry.SHA256) {
		return errors.New("R005 codex-input structural-control registry proof scope does not match run manifest")
	}
	revision, err := structuralControlInteger(registry["registry_revision"])
	if err != nil || int64(revision) != binding.Registry.Revision {
		return errors.New("R005 codex-input registry revision drift")
	}
	controlIDs, err := structuralControlStringArray(registry["control_set_ids"])
	if err != nil || !reflect.DeepEqual(controlIDs, binding.ControlSetIDs) {
		return errors.New("R005 codex-input control-set refs drift")
	}
	appliedValues, ok := registry["applied_versions"].([]any)
	if !ok || len(appliedValues) != len(binding.AppliedVersions) {
		return errors.New("R005 codex-input applied-version refs are missing")
	}
	var applied []structuralControlPipelineVersionRef
	data, err := json.Marshal(appliedValues)
	if err != nil || json.Unmarshal(data, &applied) != nil || !reflect.DeepEqual(applied, binding.AppliedVersions) {
		return errors.New("R005 codex-input applied-version refs drift")
	}
	settingsSetIDs, err := structuralControlSetIDsFromBinding(settings)
	if err != nil || len(settingsSetIDs) != binding.SetCount {
		return errors.New("R005 codex-input materialized set refs are invalid")
	}
	return verifyStructuralControlResultsForSets(payload, settingsSetIDs)
}

func verifyPackagedStructuralControlProof(payload map[string]any, descriptor structuralControlProofDescriptor, binding structuralControlRunManifestBinding, runDir string) error {
	selection, ok := payload["structural_control_settings_selection"].(map[string]any)
	if !ok {
		return errors.New("R005 codex-input packaged structural-control authority is missing")
	}
	manifestSelectionPath, err := resolveStructuralControlRunArtifact(runDir, binding.Selection.Path)
	if err != nil || !sameFilesystemPath(structuralControlText(selection["selection_proof_path"]), manifestSelectionPath) ||
		!strings.EqualFold(structuralControlText(selection["selection_proof_sha256"]), binding.Selection.SHA256) {
		return errors.New("R005 codex-input packaged structural-control selection proof artifact mismatch")
	}
	selectionProofSize, err := structuralControlInteger(selection["selection_proof_size"])
	if err != nil || int64(selectionProofSize) != binding.Selection.Size {
		return errors.New("R005 codex-input packaged structural-control selection proof size mismatch")
	}
	selectionProof, selectionProofBytes, err := readStructuralControlObjectWithin(runDir, manifestSelectionPath, structuralControlPackagedCSVMaxBytes)
	if err != nil || int64(len(selectionProofBytes)) != binding.Selection.Size ||
		!strings.EqualFold(structuralControlBytesSHA256(selectionProofBytes), binding.Selection.SHA256) {
		return errors.New("R005 packaged structural-control selection proof drift")
	}
	manifestSourcePath, err := resolveStructuralControlRunArtifact(runDir, binding.SourceCSV.Path)
	if err != nil || !sameFilesystemPath(structuralControlText(selection["source_path"]), manifestSourcePath) {
		return errors.New("R005 codex-input packaged structural-control source path mismatch")
	}
	if !strings.EqualFold(structuralControlText(selection["source_sha256"]), binding.SourceCSV.SHA256) {
		return errors.New("R005 codex-input packaged structural-control source hash mismatch")
	}
	selectionSize, err := structuralControlInteger(selection["source_size"])
	if err != nil || int64(selectionSize) != binding.SourceCSV.Size {
		return errors.New("R005 codex-input packaged structural-control source size mismatch")
	}
	selectionStatus := structuralControlText(selection["status"])
	materializationStatus := structuralControlText(selection["materialization_status"])
	if structuralControlText(selectionProof["authority"]) != structuralControlAuthorityServiceCSV ||
		structuralControlText(selectionProof["status"]) != materializationStatus ||
		!sameFilesystemPath(structuralControlText(selectionProof["source_path"]), manifestSourcePath) ||
		!strings.EqualFold(structuralControlText(selectionProof["source_sha256"]), binding.SourceCSV.SHA256) {
		return errors.New("R005 codex-input packaged structural-control selection proof content mismatch")
	}
	proofSourceSize, err := structuralControlInteger(selectionProof["source_size"])
	if err != nil || int64(proofSourceSize) != binding.SourceCSV.Size {
		return errors.New("R005 packaged structural-control selection proof source size mismatch")
	}
	rawBinding := payload["structural_control_settings_binding"]
	if binding.Status == structuralControlPackagedNoExactStatus {
		if descriptor.Status != "NO_ACTIVE_DEFAULT_ALL_GROUPS" || descriptor.SetCount != 0 ||
			structuralControlText(selection["authority"]) != structuralControlAuthorityServiceNone ||
			selectionStatus != "SERVICE_NO_SETTINGS" || structuralControlText(selection["path"]) != "" ||
			(materializationStatus != "NO_EXACT_ORGANIZATION" && materializationStatus != "NO_ACTIVE_SETS") {
			return errors.New("R005 codex-input packaged structural-control empty selection is inconsistent")
		}
		if structuralControlText(selectionProof["schema"]) != "opiu-service-structural-control-selection.v1" ||
			structuralControlText(selectionProof["path"]) != "" {
			return errors.New("R005 codex-input packaged structural-control empty selection proof is invalid")
		}
		if err := verifyDefaultStructuralControlBinding(rawBinding); err != nil {
			return fmt.Errorf("R005 codex-input packaged structural-control default binding is invalid: %w", err)
		}
		return nil
	}
	if binding.Status != structuralControlPackagedCSVStatus || descriptor.Status != "ACTIVE_VERIFIED" ||
		descriptor.SetCount != binding.SetCount || structuralControlText(selection["authority"]) != structuralControlAuthorityServiceJSON ||
		selectionStatus != "EXPLICIT_CLI_SETTINGS" || materializationStatus != "EXACT_ORGANIZATION_MATERIALIZED" {
		return errors.New("R005 codex-input packaged structural-control active selection is invalid")
	}
	if structuralControlText(selectionProof["schema"]) != "opiu-service-structural-control-verification.v1" {
		return errors.New("R005 packaged structural-control canonical verification is missing")
	}
	settings, ok := rawBinding.(map[string]any)
	if !ok || structuralControlText(settings["status"]) != "ACTIVE_EXACT_ORGANIZATION_MONTH" ||
		structuralControlText(settings["organization"]) != binding.Organization ||
		structuralControlText(settings["period"]) != binding.Period ||
		!strings.EqualFold(structuralControlText(settings["source_sha256"]), binding.SourceCSV.SHA256) {
		return errors.New("R005 codex-input packaged structural-control settings scope or source mismatch")
	}
	setCount, err := structuralControlInteger(settings["set_count"])
	if err != nil || setCount != binding.SetCount {
		return errors.New("R005 codex-input packaged structural-control set count mismatch")
	}
	sourceSize, err := structuralControlInteger(settings["source_size"])
	if err != nil || int64(sourceSize) != binding.SourceCSV.Size {
		return errors.New("R005 codex-input packaged structural-control source size drift")
	}
	inputPath := structuralControlText(settings["input_path"])
	inputSHA := structuralControlText(settings["input_sha256"])
	inputSize, err := structuralControlInteger(settings["input_size"])
	manifestSettingsPath, manifestSettingsErr := resolveStructuralControlRunArtifact(runDir, binding.Settings.Path)
	if err != nil || manifestSettingsErr != nil || inputPath == "" || !sameFilesystemPath(inputPath, manifestSettingsPath) ||
		!sameFilesystemPath(structuralControlText(selection["path"]), inputPath) ||
		!strings.EqualFold(inputSHA, binding.Settings.SHA256) || inputSize != int(binding.Settings.Size) {
		return errors.New("R005 codex-input packaged structural-control settings artifact is incomplete")
	}
	verifiedSetIDs, err := structuralControlStringArray(selection["verified_set_ids"])
	proofSetIDs, proofSetIDsErr := structuralControlStringArray(selectionProof["set_ids"])
	verifiedSetCount, verifiedSetCountErr := structuralControlInteger(selection["verified_set_count"])
	proofSetCount, proofSetCountErr := structuralControlInteger(selectionProof["set_count"])
	if err != nil || proofSetIDsErr != nil || verifiedSetCountErr != nil || proofSetCountErr != nil ||
		verifiedSetCount != binding.SetCount || proofSetCount != binding.SetCount ||
		!reflect.DeepEqual(verifiedSetIDs, binding.ControlSetIDs) || !reflect.DeepEqual(proofSetIDs, binding.ControlSetIDs) ||
		!sameFilesystemPath(structuralControlText(selection["verified_settings_path"]), manifestSettingsPath) ||
		!sameFilesystemPath(structuralControlText(selectionProof["settings_path"]), manifestSettingsPath) ||
		!strings.EqualFold(structuralControlText(selection["verified_settings_sha256"]), binding.Settings.SHA256) ||
		!strings.EqualFold(structuralControlText(selectionProof["settings_sha256"]), binding.Settings.SHA256) ||
		structuralControlText(selection["verified_settings_id"]) == "" ||
		structuralControlText(selection["verified_settings_id"]) != structuralControlText(selectionProof["settings_id"]) ||
		!validSHA256(structuralControlText(selection["verified_sets_sha256"])) ||
		!strings.EqualFold(structuralControlText(selection["verified_sets_sha256"]), structuralControlText(selectionProof["sets_sha256"])) {
		return errors.New("R005 codex-input packaged structural-control canonical verification drift")
	}
	verifiedSettingsSize, verifiedSettingsSizeErr := structuralControlInteger(selection["verified_settings_size"])
	proofSettingsSize, proofSettingsSizeErr := structuralControlInteger(selectionProof["settings_size"])
	if verifiedSettingsSizeErr != nil || proofSettingsSizeErr != nil || int64(verifiedSettingsSize) != binding.Settings.Size ||
		int64(proofSettingsSize) != binding.Settings.Size {
		return errors.New("R005 codex-input packaged structural-control canonical settings size drift")
	}
	inputDocument, inputBytes, err := readStructuralControlObjectWithin(runDir, inputPath, structuralControlSettingsJSONMaxBytes)
	if err != nil || len(inputBytes) != inputSize || !strings.EqualFold(structuralControlBytesSHA256(inputBytes), inputSHA) {
		return errors.New("R005 packaged structural-control settings artifact drift")
	}
	if structuralControlText(inputDocument["schema"]) != structuralControlSettingsSchema ||
		structuralControlText(inputDocument["organization"]) != binding.Organization ||
		structuralControlText(inputDocument["period"]) != binding.Period {
		return errors.New("R005 packaged structural-control settings document scope mismatch")
	}
	documentSource, ok := inputDocument["source"].(map[string]any)
	if !ok || !strings.EqualFold(structuralControlText(documentSource["sha256"]), binding.SourceCSV.SHA256) {
		return errors.New("R005 packaged structural-control settings document source mismatch")
	}
	documentSourceSize, err := structuralControlInteger(documentSource["size"])
	if err != nil || int64(documentSourceSize) != binding.SourceCSV.Size {
		return errors.New("R005 packaged structural-control settings document source size mismatch")
	}
	if !sameFilesystemPath(structuralControlText(documentSource["path"]), manifestSourcePath) {
		return errors.New("R005 packaged structural-control settings document source path mismatch")
	}
	documentSetIDs, err := structuralControlSetIDsFromDocument(inputDocument)
	if err != nil || !reflect.DeepEqual(documentSetIDs, binding.ControlSetIDs) {
		return errors.New("R005 packaged structural-control settings document set refs mismatch")
	}
	settingsSetIDs, err := structuralControlSetIDsFromBinding(settings)
	if err != nil || !reflect.DeepEqual(settingsSetIDs, binding.ControlSetIDs) {
		return errors.New("R005 packaged structural-control effective set refs mismatch")
	}
	return verifyStructuralControlResultsForSets(payload, binding.ControlSetIDs)
}

func verifyDefaultStructuralControlBinding(raw any) error {
	settings, ok := raw.(map[string]any)
	if !ok || structuralControlText(settings["schema"]) != structuralControlSettingsSchema ||
		structuralControlText(settings["status"]) != "MISSING_DEFAULT_ALL_GROUPS" {
		return errors.New("explicit default binding is required")
	}
	setCount, err := structuralControlInteger(settings["set_count"])
	if err != nil || setCount != 0 ||
		settings["correction_authority"] != false || settings["execution_allowed"] != false {
		return errors.New("default binding is incomplete or unsafe")
	}
	if rawSets, exists := settings["sets"]; exists {
		sets, setsOK := rawSets.([]any)
		if !setsOK || len(sets) != 0 {
			return errors.New("default binding sets are not empty")
		}
	}
	if err := structuralControlRequireZero(settings["financial_rows"], "default.financial_rows"); err != nil {
		return err
	}
	return structuralControlRequireZero(settings["posting_rows"], "default.posting_rows")
}

func structuralControlSetIDsFromBinding(binding map[string]any) ([]string, error) {
	sets, ok := binding["sets"].([]any)
	if !ok {
		return nil, errors.New("sets are missing")
	}
	return structuralControlSetIDsFromValues(sets)
}

func structuralControlSetIDsFromDocument(document map[string]any) ([]string, error) {
	sets, ok := document["structural_group_control_sets"].([]any)
	if !ok {
		return nil, errors.New("sets are missing")
	}
	return structuralControlSetIDsFromValues(sets)
}

func structuralControlSetIDsFromValues(values []any) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, raw := range values {
		set, ok := raw.(map[string]any)
		id := structuralControlText(set["id"])
		if !ok || id == "" || seen[id] {
			return nil, errors.New("set id is invalid or duplicate")
		}
		seen[id] = true
		result = append(result, id)
	}
	return result, nil
}

func verifyStructuralControlResultsForSets(payload map[string]any, expected []string) error {
	values, ok := payload["structural_group_control_results"].([]any)
	if !ok || len(values) != len(expected) {
		return errors.New("R005 structural-control result count mismatch")
	}
	wanted := map[string]bool{}
	for _, id := range expected {
		wanted[id] = true
	}
	seen := map[string]bool{}
	for index, raw := range values {
		result, ok := raw.(map[string]any)
		id := structuralControlText(result["control_set_id"])
		if !ok || !wanted[id] || seen[id] {
			return fmt.Errorf("R005 structural-control result %d set id mismatch", index)
		}
		if result["report_only"] != true || result["posting_allowed"] != false || result["execution_allowed"] != false ||
			result["ready_to_upload"] != false || result["release_allowed"] != false || result["live_1c_allowed"] != false {
			return fmt.Errorf("R005 structural-control result %s safety is incomplete", id)
		}
		seen[id] = true
	}
	return nil
}

func canonicalStructuralControlSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var canonical any
	if err := decoder.Decode(&canonical); err != nil {
		return "", err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(canonical); err != nil {
		return "", err
	}
	data := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func structuralControlRequireZero(value any, label string) error {
	number, err := structuralControlNumber(value)
	if err != nil || number != 0 {
		return fmt.Errorf("structural-control proof unsafe nonzero: %s", label)
	}
	return nil
}

func structuralControlRequireFalse(value any, label string) error {
	boolean, ok := value.(bool)
	if !ok || boolean {
		return fmt.Errorf("structural-control proof unsafe true or missing: %s", label)
	}
	return nil
}

func structuralControlNumber(value any) (float64, error) {
	switch typed := value.(type) {
	case json.Number:
		return typed.Float64()
	case float64:
		return typed, nil
	case float32:
		return float64(typed), nil
	case int:
		return float64(typed), nil
	case int64:
		return float64(typed), nil
	default:
		return 0, errors.New("number required")
	}
}

func structuralControlInteger(value any) (int, error) {
	number, err := structuralControlNumber(value)
	if err != nil || number != float64(int(number)) {
		return 0, errors.New("integer required")
	}
	return int(number), nil
}

func structuralControlText(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func structuralControlStringArray(value any) ([]string, error) {
	values, ok := value.([]any)
	if !ok {
		return nil, errors.New("string array required")
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		text := structuralControlText(value)
		if text == "" {
			return nil, errors.New("non-empty string required")
		}
		result = append(result, text)
	}
	return result, nil
}

func appendStructuralControlProofArgument(command []string, proofPath string) []string {
	if strings.TrimSpace(proofPath) == "" {
		return command
	}
	for _, token := range command {
		if token == "--structural-control-proof" {
			return command
		}
	}
	return append(command, "--structural-control-proof", proofPath)
}
