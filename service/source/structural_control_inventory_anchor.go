package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type structuralControlPlanAudit struct {
	SchemaVersion          string                             `json:"schema_version"`
	Status                 string                             `json:"status"`
	InventoryID            string                             `json:"inventory_id"`
	RunID                  string                             `json:"run_id"`
	ContextID              string                             `json:"context_id"`
	Organization           structuralControlOrganization      `json:"organization"`
	Period                 string                             `json:"period"`
	HierarchyVersions      structuralControlHierarchyVersions `json:"hierarchy_versions"`
	MemberHashes           structuralControlHierarchyVersions `json:"member_hashes"`
	InputHashes            structuralControlInputHashes       `json:"input_hashes"`
	BlockerCodes           []string                           `json:"blocker_codes"`
	VerifiedBindingWritten bool                               `json:"verified_binding_written"`
	BindingStatus          string                             `json:"binding_status"`
	DefaultBehavior        string                             `json:"default_behavior"`
	OptionalOnly           bool                               `json:"optional_control_only"`
	CorrectionAuthority    bool                               `json:"correction_authority"`
	FinancialRows          int                                `json:"financial_rows"`
	Safety                 SafetyState                        `json:"safety"`
}

const structuralControlInventoryFile = "structural-control-inventory.binding.json"

func validateStructuralControlPipelineScope(run Run, contextValue Context) error {
	if strings.TrimSpace(run.ID) == "" || run.ContextID != contextValue.ID ||
		strings.TrimSpace(contextValue.ID) == "" || strings.TrimSpace(contextValue.Period) == "" ||
		strings.TrimSpace(contextValue.OrganizationID) == "" || strings.TrimSpace(contextValue.OrganizationName) == "" ||
		strings.TrimSpace(contextValue.OrganizationPath) == "" || contextValue.Organization != contextValue.OrganizationName {
		return errors.New("exact structural control scope is incomplete")
	}
	return nil
}

func (p *Pipeline) anchorStructuralControlInventory(run Run, contextValue Context, r005Dir string) error {
	base, err := secureBaseName(run.ID)
	if err != nil || base != run.ID {
		return errors.New("structural inventory run identity is unsafe")
	}
	expectedR005Dir := filepath.Join(p.store.RunsDir(), run.ID, "r005")
	absoluteR005Dir, err := filepath.Abs(r005Dir)
	if err != nil || !sameFilesystemPath(expectedR005Dir, absoluteR005Dir) {
		return errors.New("structural inventory is outside the pinned canonical run root")
	}
	if err := rejectReparsePathComponents(expectedR005Dir); err != nil {
		return fmt.Errorf("structural inventory run root is unsafe: %w", err)
	}
	if _, alreadyAnchored := p.store.StructuralControlInventoryAnchor(run.ID); !alreadyAnchored {
		if err := requireStructuralControlV3ForNewAnchor(r005Dir); err != nil {
			return err
		}
	}
	bindingSHA, err := validateStructuralControlInventoryForAnchor(r005Dir, run, contextValue)
	if err != nil {
		return err
	}
	return p.store.AnchorStructuralControlInventory(run.ID, bindingSHA)
}

func requireStructuralControlV3ForNewAnchor(r005Dir string) error {
	bindingBytes, err := readStructuralControlArtifact(r005Dir, filepath.Join(r005Dir, structuralControlInventoryFile), 1<<20)
	if err != nil {
		return fmt.Errorf("read structural inventory binding: %w", err)
	}
	bindingSchema, err := structuralControlDocumentSchema(bindingBytes)
	if err != nil || bindingSchema != structuralControlBindingSchemaV3 {
		return errors.New("new structural inventory anchor requires binding v3")
	}
	inventoryBytes, err := readStructuralControlArtifact(r005Dir, filepath.Join(r005Dir, "structural-control-inventory.json"), 16<<20)
	if err != nil {
		return fmt.Errorf("read structural inventory: %w", err)
	}
	inventorySchema, err := structuralControlDocumentSchema(inventoryBytes)
	if err != nil || inventorySchema != structuralControlInventorySchemaV3 {
		return errors.New("new structural inventory anchor requires inventory v3")
	}
	return nil
}

func validateStructuralControlInventoryForAnchor(r005Dir string, run Run, contextValue Context) (string, error) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		return "", err
	}
	bindingPath := filepath.Join(r005Dir, structuralControlInventoryFile)
	bindingBytes, err := readStructuralControlArtifact(r005Dir, bindingPath, 1<<20)
	if err != nil {
		return "", fmt.Errorf("read structural inventory binding: %w", err)
	}
	bindingDigest := sha256.Sum256(bindingBytes)
	bindingSHA := strings.ToUpper(hex.EncodeToString(bindingDigest[:]))

	binding, err := decodeStructuralControlBinding(bindingBytes)
	if err != nil {
		return "", errors.New("structural inventory binding is malformed")
	}
	if (binding.SchemaVersion != structuralControlBindingSchema && binding.SchemaVersion != structuralControlBindingSchemaV3) ||
		binding.ArtifactType != "STRUCTURAL_CONTROL_INVENTORY" ||
		!binding.Verified || binding.RunID != run.ID || binding.ContextID != contextValue.ID ||
		binding.OrganizationID != contextValue.OrganizationID || binding.OrganizationName != contextValue.OrganizationName ||
		binding.OrganizationPath != contextValue.OrganizationPath || binding.Period != contextValue.Period ||
		strings.TrimSpace(binding.InventoryID) == "" || !validUpperSHA256(binding.SHA256) || binding.Safety != reportOnlySafety() {
		return "", errors.New("structural inventory binding is not verified for the exact run scope")
	}
	base, err := secureBaseName(binding.InventoryFile)
	if err != nil || base != binding.InventoryFile || base != "structural-control-inventory.json" {
		return "", errors.New("structural inventory filename is unsafe")
	}
	inventoryBytes, err := readStructuralControlArtifact(r005Dir, filepath.Join(r005Dir, base), 16<<20)
	if err != nil {
		return "", fmt.Errorf("read structural inventory: %w", err)
	}
	inventoryDigest := sha256.Sum256(inventoryBytes)
	actualInventorySHA := strings.ToUpper(hex.EncodeToString(inventoryDigest[:]))
	if !strings.EqualFold(actualInventorySHA, binding.SHA256) {
		return "", errors.New("structural inventory digest mismatch")
	}
	inventory, err := decodeStructuralControlInventory(inventoryBytes)
	if err != nil {
		return "", errors.New("structural inventory is malformed")
	}
	if !structuralControlBindingMatchesInventorySchema(binding.SchemaVersion, inventory.SchemaVersion) ||
		inventory.ArtifactType != "STRUCTURAL_CONTROL_INVENTORY" || inventory.Status != "VERIFIED" ||
		inventory.RunID != run.ID || inventory.ContextID != contextValue.ID || inventory.InventoryID != binding.InventoryID ||
		inventory.Organization.ID != contextValue.OrganizationID || inventory.Organization.Name != contextValue.OrganizationName ||
		inventory.Organization.Path != contextValue.OrganizationPath || inventory.Period != contextValue.Period ||
		!validUpperSHA256(inventory.HierarchyVersions.Intalev) || !validUpperSHA256(inventory.HierarchyVersions.ERP) ||
		inventory.Safety != reportOnlySafety() {
		return "", errors.New("structural inventory is not verified for the exact run scope")
	}
	if err := validateStructuralControlInventoryV2(inventory, binding, r005Dir, run, contextValue); err != nil {
		return "", err
	}
	if err := validateStructuralControlInventoryMembers(inventory.IntalevMembers); err != nil {
		return "", errors.New("Intalev structural inventory members are not verified")
	}
	if err := validateStructuralControlInventoryMembers(inventory.ERPMembers); err != nil {
		return "", errors.New("ERP structural inventory members are not verified")
	}
	return bindingSHA, nil
}

func validUpperSHA256(value string) bool {
	return validSHA256(value) && value == strings.ToUpper(value)
}

func validateStructuralControlInventoryV2(inventory structuralControlInventory, binding structuralControlInventoryBinding, r005Dir string, run Run, contextValue Context) error {
	if _, err := time.Parse(time.RFC3339Nano, inventory.GeneratedAt); err != nil || len(inventory.Blockers) != 0 ||
		inventory.DefaultBehavior != "PROCESS_ALL_DISCREPANCIES" || !inventory.OptionalOnly || inventory.CorrectionAuthority ||
		inventory.FinancialRows != 0 || !validUpperSHA256(inventory.MemberHashes.Intalev) || !validUpperSHA256(inventory.MemberHashes.ERP) {
		return errors.New("structural inventory v2 authority fields are invalid")
	}
	if err := validateStructuralInputHashes(inventory.InputHashes); err != nil {
		return err
	}
	computedMemberHashes := inventory.CanonicalMemberHashes
	if inventory.SchemaVersion == structuralControlInventorySchema {
		intalevMemberSHA, intalevErr := canonicalJSONSHA256(inventory.IntalevMembers)
		erpMemberSHA, erpErr := canonicalJSONSHA256(inventory.ERPMembers)
		if intalevErr != nil || erpErr != nil {
			return errors.New("structural inventory member digest mismatch")
		}
		computedMemberHashes = structuralControlHierarchyVersions{Intalev: intalevMemberSHA, ERP: erpMemberSHA}
	}
	if computedMemberHashes != inventory.MemberHashes {
		return errors.New("structural inventory member digest mismatch")
	}
	if err := validateStructuralSourceScope(inventory.SourceScope, inventory.InputHashes); err != nil {
		return err
	}
	current := inventory.CurrentRun
	if !current.ScopeVerified || len(current.VerificationBlockers) != 0 || current.RunID != run.ID || current.ContextID != contextValue.ID ||
		current.Organization != inventory.Organization || current.Period != inventory.Period || current.InventoryID != inventory.InventoryID {
		return errors.New("structural inventory current-run provenance is not exact")
	}
	if !reflect.DeepEqual(binding.InputHashes, inventory.InputHashes) || binding.HierarchyVersions != inventory.HierarchyVersions ||
		binding.MemberHashes != inventory.MemberHashes || binding.Report != current.Report || binding.CodexInput != current.CodexInput ||
		binding.Manifest != current.Manifest {
		return errors.New("structural inventory binding cross-links do not match inventory")
	}
	provenanceSHA, err := canonicalJSONSHA256(current)
	if err != nil || binding.CurrentRunProvenanceSHA256 != provenanceSHA {
		return errors.New("structural inventory current-run provenance digest mismatch")
	}
	for _, artifact := range []struct {
		descriptor structuralControlArtifactDescriptor
		name       string
		limit      int64
	}{
		{current.Report, "reconciliation.xlsx", 1 << 30},
		{current.CodexInput, "reconciliation.codex-input.json", 64 << 20},
		{current.Manifest, "reconciliation.manifest.json", 64 << 20},
	} {
		expectedPath := filepath.Join(r005Dir, artifact.name)
		if !sameFilesystemPath(artifact.descriptor.File, expectedPath) || !validUpperSHA256(artifact.descriptor.SHA256) {
			return errors.New("structural inventory current-run artifact path is not canonical")
		}
		actualSHA, err := sha256StructuralControlArtifact(r005Dir, expectedPath, artifact.limit)
		if err != nil || actualSHA != artifact.descriptor.SHA256 {
			return errors.New("structural inventory current-run artifact digest mismatch")
		}
	}
	return validateStructuralPlanCrossLinks(inventory, r005Dir)
}

func validateStructuralInputHashes(hashes structuralControlInputHashes) error {
	for _, side := range [][]structuralControlInputHash{hashes.Intalev, hashes.ERP} {
		if len(side) == 0 {
			return errors.New("structural inventory input hashes are missing")
		}
		seen := map[string]string{}
		for _, item := range side {
			file := strings.TrimSpace(item.File)
			if file == "" || !validUpperSHA256(item.SHA256) {
				return errors.New("structural inventory input hash is invalid")
			}
			if previous, exists := seen[file]; exists && previous != item.SHA256 {
				return errors.New("structural inventory input file has conflicting hashes")
			}
			if _, exists := seen[file]; exists {
				return errors.New("structural inventory input hash is duplicated")
			}
			seen[file] = item.SHA256
		}
	}
	return nil
}

func validateStructuralSourceScope(scope structuralControlSourceScope, hashes structuralControlInputHashes) error {
	for _, side := range []struct {
		scope  structuralControlSourceSide
		hashes []structuralControlInputHash
	}{{scope.Intalev, hashes.Intalev}, {scope.ERP, hashes.ERP}} {
		if side.scope.NodeCount < 1 || side.scope.RootCount < 1 || len(side.scope.Sources) == 0 {
			return errors.New("structural inventory source scope is incomplete")
		}
		expected := map[string]string{}
		for _, item := range side.hashes {
			expected[item.File] = item.SHA256
		}
		seenSources := map[string]bool{}
		for _, source := range side.scope.Sources {
			if seenSources[source.File] || expected[source.File] != source.SHA256 || len(source.Sheets) == 0 || source.FirstRow < 1 || source.LastRow < source.FirstRow {
				return errors.New("structural inventory source scope does not match input hashes")
			}
			seenSources[source.File] = true
		}
		if len(seenSources) != len(expected) {
			return errors.New("structural inventory source scope does not cover exact inputs")
		}
	}
	return nil
}

func validateStructuralPlanCrossLinks(inventory structuralControlInventory, r005Dir string) error {
	reportPath := filepath.Join(r005Dir, "reconciliation.xlsx")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	manifestPath := filepath.Join(r005Dir, "reconciliation.manifest.json")
	reportSHA := inventory.CurrentRun.Report.SHA256
	codexSHA := inventory.CurrentRun.CodexInput.SHA256
	for _, item := range []struct {
		path       string
		isManifest bool
	}{{codexPath, false}, {manifestPath, true}} {
		data, err := readStructuralControlArtifact(r005Dir, item.path, 64<<20)
		if err != nil {
			return errors.New("structural inventory current-run JSON is unavailable")
		}
		var document map[string]json.RawMessage
		if err := decodeJSONRejectDuplicateKeys(data, &document, false); err != nil {
			return errors.New("structural inventory current-run JSON is ambiguous")
		}
		var organization, period, outputPath, outputSHA string
		if err := json.Unmarshal(document["organization"], &organization); err != nil || organization != inventory.Organization.Name ||
			json.Unmarshal(document["period"], &period) != nil || period != inventory.Period ||
			json.Unmarshal(document["output_path"], &outputPath) != nil || !sameFilesystemPath(outputPath, reportPath) ||
			json.Unmarshal(document["output_sha256"], &outputSHA) != nil || strings.ToUpper(outputSHA) != reportSHA {
			return errors.New("structural inventory current-run JSON scope does not match")
		}
		audit, err := decodeStructuralControlPlanAudit(document["structural_control_inventory"], inventory.SchemaVersion)
		if err != nil || audit.SchemaVersion != inventory.SchemaVersion || audit.Status != "ELIGIBLE_PENDING_CURRENT_RUN_PROVENANCE" ||
			audit.InventoryID != inventory.InventoryID || audit.RunID != inventory.RunID || audit.ContextID != inventory.ContextID ||
			audit.Organization != inventory.Organization || audit.Period != inventory.Period ||
			audit.HierarchyVersions != inventory.HierarchyVersions || audit.MemberHashes != inventory.MemberHashes ||
			!reflect.DeepEqual(audit.InputHashes, inventory.InputHashes) || len(audit.BlockerCodes) != 0 || audit.VerifiedBindingWritten ||
			audit.BindingStatus != "PENDING_CURRENT_RUN_PROVENANCE" || audit.DefaultBehavior != "PROCESS_ALL_DISCREPANCIES" ||
			!audit.OptionalOnly || audit.CorrectionAuthority || audit.FinancialRows != 0 || audit.Safety != reportOnlySafety() {
			return errors.New("structural inventory embedded plan cross-link does not match")
		}
		if item.isManifest {
			var codexInputPath, codexInputSHA string
			if json.Unmarshal(document["codex_input_path"], &codexInputPath) != nil || !sameFilesystemPath(codexInputPath, codexPath) ||
				json.Unmarshal(document["codex_input_sha256"], &codexInputSHA) != nil || strings.ToUpper(codexInputSHA) != codexSHA {
				return errors.New("structural inventory manifest does not bind exact Codex input")
			}
		}
	}
	return nil
}

func canonicalJSONSHA256(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(generic)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func decodeStructuralControlPlanAudit(data []byte, inventorySchema string) (structuralControlPlanAudit, error) {
	if inventorySchema == structuralControlInventorySchema {
		var audit structuralControlPlanAudit
		if err := decodeExactJSON(data, &audit); err != nil {
			return structuralControlPlanAudit{}, err
		}
		return audit, nil
	}
	if inventorySchema != structuralControlInventorySchemaV3 {
		return structuralControlPlanAudit{}, errors.New("unsupported structural plan schema")
	}
	var audit structuralControlPlanAuditV3
	if err := decodeExactJSON(data, &audit); err != nil {
		return structuralControlPlanAudit{}, err
	}
	if audit.CandidateSemantics != structuralControlCandidateSemantics || audit.AutomaticBusinessBlockClassification ||
		!audit.UserDeclarationRequired || audit.CorrectionAuthority || !audit.Safety.valid() {
		return structuralControlPlanAudit{}, errors.New("structural plan v3 semantics are unsafe")
	}
	return structuralControlPlanAudit{
		SchemaVersion: audit.SchemaVersion, Status: audit.Status, InventoryID: audit.InventoryID,
		RunID: audit.RunID, ContextID: audit.ContextID, Organization: audit.Organization, Period: audit.Period,
		HierarchyVersions: audit.HierarchyVersions, MemberHashes: audit.MemberHashes, InputHashes: audit.InputHashes,
		BlockerCodes: audit.BlockerCodes, VerifiedBindingWritten: audit.VerifiedBindingWritten,
		BindingStatus: audit.BindingStatus, DefaultBehavior: audit.DefaultBehavior, OptionalOnly: audit.OptionalOnly,
		CorrectionAuthority: audit.CorrectionAuthority, FinancialRows: audit.FinancialRows, Safety: audit.Safety.serviceSafety(),
	}, nil
}
