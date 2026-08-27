package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	structuralControlInventorySchemaV3  = "opiu-structural-control-inventory.v3"
	structuralControlBindingSchemaV3    = "opiu-structural-control-inventory-binding.v3"
	structuralControlCandidateSemantics = "USER_DECLARED_CONTROL_ONLY"
	structuralControlUnprovenSemantic   = "BUSINESS_BLOCK_UNPROVEN"
)

type structuralControlMemberSourceV3 struct {
	File       string `json:"file"`
	Sheet      string `json:"sheet"`
	Row        int    `json:"row"`
	SourceCell string `json:"source_cell"`
	SHA256     string `json:"sha256"`
}

type structuralControlSafetyV3 struct {
	Mode             string `json:"mode"`
	PostingRows      int    `json:"posting_rows"`
	ReadyToUpload    bool   `json:"ready_to_upload"`
	ReleaseAllowed   bool   `json:"release_allowed"`
	ExecutionAllowed bool   `json:"execution_allowed"`
	Live1CAllowed    bool   `json:"live_1c_allowed"`
}

func (s structuralControlSafetyV3) serviceSafety() SafetyState {
	return SafetyState{Mode: s.Mode, PostingRows: s.PostingRows, ReadyToUpload: s.ReadyToUpload, ReleaseAllowed: s.ReleaseAllowed, Live1CAllowed: s.Live1CAllowed}
}

func (s structuralControlSafetyV3) valid() bool {
	return !s.ExecutionAllowed && s.serviceSafety() == reportOnlySafety()
}

type structuralControlMemberV3 struct {
	Identity                string                          `json:"identity"`
	ParentIdentity          string                          `json:"parent_identity"`
	SourceIdentity          string                          `json:"source_identity"`
	SourceIdentityScope     string                          `json:"source_identity_scope"`
	DimensionKey            string                          `json:"dimension_key"`
	DimensionIdentityStatus string                          `json:"dimension_identity_status"`
	Source                  structuralControlMemberSourceV3 `json:"source"`
	Code                    string                          `json:"code"`
	Name                    string                          `json:"name"`
	HierarchyPath           string                          `json:"hierarchy_path"`
	AmountCents             int64                           `json:"amount_cents"`
	SourceOrder             int                             `json:"source_order"`
	Level                   int                             `json:"level"`
	IsGroup                 bool                            `json:"is_group"`
	SelectableRoot          bool                            `json:"selectable_root"`
	CandidateSelectable     bool                            `json:"candidate_selectable"`
	BusinessBlockDeclared   bool                            `json:"business_block_declared"`
	SemanticStatus          string                          `json:"semantic_status"`
	RequiresUserDeclaration bool                            `json:"requires_user_declaration"`
	CorrectionAuthority     bool                            `json:"correction_authority"`
}

type structuralControlInventoryV3Document struct {
	SchemaVersion                        string                             `json:"schema_version"`
	ArtifactType                         string                             `json:"artifact_type"`
	InventoryID                          string                             `json:"inventory_id"`
	Status                               string                             `json:"status"`
	RunID                                string                             `json:"run_id"`
	ContextID                            string                             `json:"context_id"`
	Organization                         structuralControlOrganization      `json:"organization"`
	Period                               string                             `json:"period"`
	GeneratedAt                          string                             `json:"generated_at"`
	HierarchyVersions                    structuralControlHierarchyVersions `json:"hierarchy_versions"`
	MemberHashes                         structuralControlHierarchyVersions `json:"member_hashes"`
	InputHashes                          structuralControlInputHashes       `json:"input_hashes"`
	CurrentRun                           structuralControlCurrentRun        `json:"current_run_provenance"`
	SourceScope                          structuralControlSourceScope       `json:"source_scope"`
	IntalevMembers                       []structuralControlMemberV3        `json:"intalev_members"`
	ERPMembers                           []structuralControlMemberV3        `json:"erp_members"`
	Blockers                             []json.RawMessage                  `json:"blockers"`
	DefaultBehavior                      string                             `json:"default_behavior"`
	OptionalOnly                         bool                               `json:"optional_control_only"`
	CandidateSemantics                   string                             `json:"candidate_semantics"`
	AutomaticBusinessBlockClassification bool                               `json:"automatic_business_block_classification"`
	UserDeclarationRequired              bool                               `json:"user_declaration_required"`
	CorrectionAuthority                  bool                               `json:"correction_authority"`
	FinancialRows                        int                                `json:"financial_rows"`
	Safety                               structuralControlSafetyV3          `json:"safety"`
}

type structuralControlInventoryBindingV3 struct {
	SchemaVersion                        string                              `json:"schema_version"`
	ArtifactType                         string                              `json:"artifact_type"`
	RunID                                string                              `json:"run_id"`
	ContextID                            string                              `json:"context_id"`
	OrganizationID                       string                              `json:"organization_id"`
	OrganizationName                     string                              `json:"organization_name"`
	OrganizationPath                     string                              `json:"organization_path"`
	Period                               string                              `json:"period"`
	InventoryID                          string                              `json:"inventory_id"`
	InventoryFile                        string                              `json:"inventory_file"`
	SHA256                               string                              `json:"sha256"`
	InputHashes                          structuralControlInputHashes        `json:"input_hashes"`
	HierarchyVersions                    structuralControlHierarchyVersions  `json:"hierarchy_versions"`
	MemberHashes                         structuralControlHierarchyVersions  `json:"member_hashes"`
	Report                               structuralControlArtifactDescriptor `json:"report"`
	CodexInput                           structuralControlArtifactDescriptor `json:"codex_input"`
	Manifest                             structuralControlArtifactDescriptor `json:"manifest"`
	CurrentRunProvenanceSHA256           string                              `json:"current_run_provenance_sha256"`
	Verified                             bool                                `json:"verified"`
	CandidateSemantics                   string                              `json:"candidate_semantics"`
	AutomaticBusinessBlockClassification bool                                `json:"automatic_business_block_classification"`
	UserDeclarationRequired              bool                                `json:"user_declaration_required"`
	CorrectionAuthority                  bool                                `json:"correction_authority"`
	Safety                               structuralControlSafetyV3           `json:"safety"`
}

type structuralControlPlanAuditV3 struct {
	SchemaVersion                        string                             `json:"schema_version"`
	Status                               string                             `json:"status"`
	InventoryID                          string                             `json:"inventory_id"`
	RunID                                string                             `json:"run_id"`
	ContextID                            string                             `json:"context_id"`
	Organization                         structuralControlOrganization      `json:"organization"`
	Period                               string                             `json:"period"`
	HierarchyVersions                    structuralControlHierarchyVersions `json:"hierarchy_versions"`
	MemberHashes                         structuralControlHierarchyVersions `json:"member_hashes"`
	InputHashes                          structuralControlInputHashes       `json:"input_hashes"`
	BlockerCodes                         []string                           `json:"blocker_codes"`
	VerifiedBindingWritten               bool                               `json:"verified_binding_written"`
	BindingStatus                        string                             `json:"binding_status"`
	DefaultBehavior                      string                             `json:"default_behavior"`
	OptionalOnly                         bool                               `json:"optional_control_only"`
	CandidateSemantics                   string                             `json:"candidate_semantics"`
	AutomaticBusinessBlockClassification bool                               `json:"automatic_business_block_classification"`
	UserDeclarationRequired              bool                               `json:"user_declaration_required"`
	CorrectionAuthority                  bool                               `json:"correction_authority"`
	FinancialRows                        int                                `json:"financial_rows"`
	Safety                               structuralControlSafetyV3          `json:"safety"`
}

func structuralControlDocumentSchema(data []byte) (string, error) {
	var document map[string]json.RawMessage
	if err := decodeJSONRejectDuplicateKeys(data, &document, false); err != nil {
		return "", err
	}
	var schema string
	if err := json.Unmarshal(document["schema_version"], &schema); err != nil || strings.TrimSpace(schema) == "" {
		return "", errors.New("structural control schema is missing")
	}
	return schema, nil
}

func decodeStructuralControlBinding(data []byte) (structuralControlInventoryBinding, error) {
	schema, err := structuralControlDocumentSchema(data)
	if err != nil {
		return structuralControlInventoryBinding{}, err
	}
	if schema == structuralControlBindingSchema {
		var binding structuralControlInventoryBinding
		if err := decodeExactJSON(data, &binding); err != nil {
			return structuralControlInventoryBinding{}, err
		}
		return binding, nil
	}
	if schema != structuralControlBindingSchemaV3 {
		return structuralControlInventoryBinding{}, errors.New("unsupported structural control binding schema")
	}
	var source structuralControlInventoryBindingV3
	if err := decodeExactJSON(data, &source); err != nil {
		return structuralControlInventoryBinding{}, err
	}
	if source.CandidateSemantics != structuralControlCandidateSemantics || source.AutomaticBusinessBlockClassification ||
		!source.UserDeclarationRequired || source.CorrectionAuthority || !source.Safety.valid() {
		return structuralControlInventoryBinding{}, errors.New("structural control binding v3 semantics are unsafe")
	}
	return structuralControlInventoryBinding{
		SchemaVersion: source.SchemaVersion, ArtifactType: source.ArtifactType,
		RunID: source.RunID, ContextID: source.ContextID,
		OrganizationID: source.OrganizationID, OrganizationName: source.OrganizationName, OrganizationPath: source.OrganizationPath,
		Period: source.Period, InventoryID: source.InventoryID, InventoryFile: source.InventoryFile, SHA256: source.SHA256,
		InputHashes: source.InputHashes, HierarchyVersions: source.HierarchyVersions, MemberHashes: source.MemberHashes,
		Report: source.Report, CodexInput: source.CodexInput, Manifest: source.Manifest,
		CurrentRunProvenanceSHA256: source.CurrentRunProvenanceSHA256, Verified: source.Verified, Safety: source.Safety.serviceSafety(),
		CandidateSemantics:                   source.CandidateSemantics,
		AutomaticBusinessBlockClassification: source.AutomaticBusinessBlockClassification,
		UserDeclarationRequired:              source.UserDeclarationRequired, CorrectionAuthority: source.CorrectionAuthority,
	}, nil
}

func decodeStructuralControlInventory(data []byte) (structuralControlInventory, error) {
	schema, err := structuralControlDocumentSchema(data)
	if err != nil {
		return structuralControlInventory{}, err
	}
	if schema == structuralControlInventorySchema {
		var inventory structuralControlInventory
		if err := decodeExactJSON(data, &inventory); err != nil {
			return structuralControlInventory{}, err
		}
		return inventory, nil
	}
	if schema != structuralControlInventorySchemaV3 {
		return structuralControlInventory{}, errors.New("unsupported structural control inventory schema")
	}
	var source structuralControlInventoryV3Document
	if err := decodeExactJSON(data, &source); err != nil {
		return structuralControlInventory{}, err
	}
	if source.CandidateSemantics != structuralControlCandidateSemantics || source.AutomaticBusinessBlockClassification ||
		!source.UserDeclarationRequired || source.CorrectionAuthority || !source.Safety.valid() {
		return structuralControlInventory{}, errors.New("structural control inventory v3 semantics are unsafe")
	}
	intalevSHA, err := canonicalJSONSHA256(source.IntalevMembers)
	if err != nil {
		return structuralControlInventory{}, err
	}
	erpSHA, err := canonicalJSONSHA256(source.ERPMembers)
	if err != nil {
		return structuralControlInventory{}, err
	}
	computed := structuralControlHierarchyVersions{Intalev: intalevSHA, ERP: erpSHA}
	if computed != source.MemberHashes {
		return structuralControlInventory{}, errors.New("structural control inventory v3 member digest mismatch")
	}
	intalev, err := validateAndNormalizeStructuralControlMembersV3(source.IntalevMembers, source.InputHashes.Intalev, source.SourceScope.Intalev, source.Period)
	if err != nil {
		return structuralControlInventory{}, err
	}
	erp, err := validateAndNormalizeStructuralControlMembersV3(source.ERPMembers, source.InputHashes.ERP, source.SourceScope.ERP, source.Period)
	if err != nil {
		return structuralControlInventory{}, err
	}
	return structuralControlInventory{
		SchemaVersion: source.SchemaVersion, ArtifactType: source.ArtifactType, InventoryID: source.InventoryID, Status: source.Status,
		RunID: source.RunID, ContextID: source.ContextID, Organization: source.Organization, Period: source.Period,
		GeneratedAt: source.GeneratedAt, HierarchyVersions: source.HierarchyVersions, MemberHashes: source.MemberHashes,
		InputHashes: source.InputHashes, CurrentRun: source.CurrentRun, SourceScope: source.SourceScope,
		IntalevMembers: intalev, ERPMembers: erp, Blockers: source.Blockers,
		DefaultBehavior: source.DefaultBehavior, OptionalOnly: source.OptionalOnly,
		CorrectionAuthority: source.CorrectionAuthority, FinancialRows: source.FinancialRows, Safety: source.Safety.serviceSafety(),
		CandidateSemantics:                   source.CandidateSemantics,
		AutomaticBusinessBlockClassification: source.AutomaticBusinessBlockClassification,
		UserDeclarationRequired:              source.UserDeclarationRequired, CanonicalMemberHashes: computed,
	}, nil
}

func validateAndNormalizeStructuralControlMembersV3(source []structuralControlMemberV3, hashes []structuralControlInputHash, scope structuralControlSourceSide, period string) ([]structuralControlMember, error) {
	if len(source) == 0 || strings.TrimSpace(period) == "" {
		return nil, errors.New("structural control inventory v3 candidates are missing")
	}
	inputByFile := make(map[string]string, len(hashes))
	for _, item := range hashes {
		inputByFile[item.File] = item.SHA256
	}
	scopeByFile := make(map[string]structuralControlSourceFile, len(scope.Sources))
	for _, item := range scope.Sources {
		scopeByFile[item.File] = item
	}
	seenIdentity := map[string]bool{}
	seenSourceIdentity := map[string]bool{}
	result := make([]structuralControlMember, 0, len(source))
	for index, member := range source {
		trace := member.Source
		sourceScope, scopeExists := scopeByFile[trace.File]
		sheetExists := false
		for _, sheet := range sourceScope.Sheets {
			if sheet == trace.Sheet {
				sheetExists = true
				break
			}
		}
		expectedSourceIdentity := trace.SHA256 + "|" + trace.Sheet + "|" + strconv.Itoa(trace.Row)
		expectedIdentityScope := trace.SHA256 + "|" + trace.Sheet + "|" + period
		if strings.TrimSpace(member.Identity) == "" || strings.TrimSpace(member.ParentIdentity) == "" || member.ParentIdentity == member.Identity ||
			seenIdentity[member.Identity] || strings.TrimSpace(member.Name) == "" || strings.TrimSpace(member.HierarchyPath) == "" ||
			member.SourceOrder != index || member.Level < 1 || !member.IsGroup || member.SelectableRoot || !member.CandidateSelectable ||
			member.BusinessBlockDeclared || member.SemanticStatus != structuralControlUnprovenSemantic || !member.RequiresUserDeclaration || member.CorrectionAuthority ||
			strings.TrimSpace(trace.File) == "" || strings.TrimSpace(trace.Sheet) == "" || trace.Row < 1 || strings.TrimSpace(trace.SourceCell) == "" ||
			!validUpperSHA256(trace.SHA256) || inputByFile[trace.File] != trace.SHA256 || !scopeExists || sourceScope.SHA256 != trace.SHA256 ||
			!sheetExists || trace.Row < sourceScope.FirstRow || trace.Row > sourceScope.LastRow ||
			member.SourceIdentity != expectedSourceIdentity || member.SourceIdentityScope != expectedIdentityScope || seenSourceIdentity[member.SourceIdentity] {
			return nil, fmt.Errorf("structural control inventory v3 candidate %d is not exact", index)
		}
		seenIdentity[member.Identity] = true
		seenSourceIdentity[member.SourceIdentity] = true
		result = append(result, structuralControlMember{
			Identity: member.Identity, ParentIdentity: member.ParentIdentity, Code: member.Code, Name: member.Name,
			HierarchyPath: member.HierarchyPath, AmountCents: member.AmountCents, SourceOrder: member.SourceOrder,
			SemanticStatus: member.SemanticStatus, CandidateSelectable: member.CandidateSelectable,
			BusinessBlockDeclared: member.BusinessBlockDeclared, RequiresUserDeclaration: member.RequiresUserDeclaration,
			CorrectionAuthority: member.CorrectionAuthority,
		})
	}
	return result, nil
}

func structuralControlBindingMatchesInventorySchema(bindingSchema, inventorySchema string) bool {
	return (bindingSchema == structuralControlBindingSchema && inventorySchema == structuralControlInventorySchema) ||
		(bindingSchema == structuralControlBindingSchemaV3 && inventorySchema == structuralControlInventorySchemaV3)
}
