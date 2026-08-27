package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const structuralControlSettingsSchema = "opiu-structural-control-settings.v1"

type structuralControlPipelineAudit struct {
	RunID               string                                `json:"run_id"`
	ContextID           string                                `json:"context_id"`
	Organization        string                                `json:"organization"`
	OrganizationID      string                                `json:"organization_id"`
	OrganizationName    string                                `json:"organization_name"`
	OrganizationPath    string                                `json:"organization_path"`
	Period              string                                `json:"period"`
	Status              string                                `json:"status"`
	SettingsPath        string                                `json:"settings_path,omitempty"`
	SettingsSHA256      string                                `json:"settings_sha256,omitempty"`
	SourceCSVPath       string                                `json:"source_csv_path,omitempty"`
	SourceCSVSHA256     string                                `json:"source_csv_sha256,omitempty"`
	RegistryPath        string                                `json:"registry_path,omitempty"`
	RegistrySHA256      string                                `json:"registry_sha256,omitempty"`
	RegistryRevision    int64                                 `json:"registry_revision,omitempty"`
	ControlSetIDs       []string                              `json:"control_set_ids"`
	AppliedVersions     []structuralControlPipelineVersionRef `json:"applied_versions"`
	SetCount            int                                   `json:"set_count"`
	CorrectionAuthority bool                                  `json:"correction_authority"`
	FinancialRows       int                                   `json:"financial_rows"`
	PostingRows         int                                   `json:"posting_rows"`
}

type structuralControlPipelineSet struct {
	ID                           string                                   `json:"id"`
	Name                         string                                   `json:"name"`
	ReconciliationOrganization   string                                   `json:"reconciliation_organization"`
	ReconciliationOrganizationID string                                   `json:"reconciliation_organization_id"`
	ExactOrganizationID          string                                   `json:"exact_organization_id"`
	Enabled                      bool                                     `json:"enabled"`
	Mode                         string                                   `json:"mode"`
	MemberCodes                  []string                                 `json:"member_codes"`
	IntalevMemberCodes           []string                                 `json:"intalev_member_codes"`
	ERPMemberCodes               []string                                 `json:"erp_member_codes"`
	IntalevMemberBindings        []structuralControlPipelineMemberBinding `json:"intalev_member_bindings"`
	ERPMemberBindings            []structuralControlPipelineMemberBinding `json:"erp_member_bindings"`
	ExpectedControlDelta         int64                                    `json:"expected_control_delta"`
	Tolerance                    float64                                  `json:"tolerance"`
}

type structuralControlPipelineMemberBinding struct {
	Code              string `json:"code"`
	HierarchyPath     string `json:"hierarchy_path"`
	OriginIdentity    string `json:"origin_identity"`
	OriginInventoryID string `json:"origin_inventory_id"`
}

type structuralControlPipelineSource struct {
	Path     string `json:"path"`
	Filename string `json:"filename"`
	Size     int    `json:"size"`
	SHA256   string `json:"sha256"`
	Format   string `json:"format"`
}

type structuralControlPipelineVersionRef struct {
	ControlSetID                 string `json:"control_set_id"`
	LineageID                    string `json:"lineage_id"`
	Version                      int    `json:"version"`
	PayloadSHA256                string `json:"payload_sha256"`
	MaterializedSetID            string `json:"materialized_set_id"`
	OriginRunID                  string `json:"origin_run_id"`
	OriginContextID              string `json:"origin_context_id"`
	OriginInventoryID            string `json:"origin_inventory_id"`
	OriginInventoryBindingSHA256 string `json:"origin_inventory_binding_sha256"`
}

type structuralControlPipelineOrigin struct {
	SchemaVersion    string                                `json:"schema_version"`
	RegistryPath     string                                `json:"registry_path"`
	RegistrySHA256   string                                `json:"registry_sha256"`
	RegistrySize     int                                   `json:"registry_size"`
	RegistryRevision int64                                 `json:"registry_revision"`
	OrganizationID   string                                `json:"organization_id"`
	OrganizationName string                                `json:"organization_name"`
	OrganizationPath string                                `json:"organization_path"`
	RunID            string                                `json:"run_id"`
	ContextID        string                                `json:"context_id"`
	ActiveVersions   []structuralControlPipelineVersionRef `json:"active_versions"`
}

type structuralControlPipelineSafety struct {
	Mode             string `json:"mode"`
	PostingRows      int    `json:"posting_rows"`
	ReadyToUpload    bool   `json:"ready_to_upload"`
	ReleaseAllowed   bool   `json:"release_allowed"`
	ExecutionAllowed bool   `json:"execution_allowed"`
	Live1CAllowed    bool   `json:"live_1c_allowed"`
}

type structuralControlPipelineDocument struct {
	Schema                     string                          `json:"schema"`
	SettingsID                 string                          `json:"settings_id"`
	Organization               string                          `json:"organization"`
	OrganizationID             string                          `json:"organization_id"`
	OrganizationName           string                          `json:"organization_name"`
	OrganizationPath           string                          `json:"organization_path"`
	Period                     string                          `json:"period"`
	RunID                      string                          `json:"run_id"`
	ContextID                  string                          `json:"context_id"`
	Source                     structuralControlPipelineSource `json:"source"`
	StructuralGroupControlSets []structuralControlPipelineSet  `json:"structural_group_control_sets"`
	UIFixedRegistry            structuralControlPipelineOrigin `json:"ui_fixed_registry"`
	Safety                     structuralControlPipelineSafety `json:"safety"`
}

type structuralControlGroupIDPayload struct {
	Organization     string                                   `json:"organization"`
	Name             string                                   `json:"name"`
	IntalevSelectors []structuralControlPipelineMemberBinding `json:"intalev_selectors"`
	ERPSelectors     []structuralControlPipelineMemberBinding `json:"erp_selectors"`
}

type structuralControlSettingsSetBinding struct {
	ID                 string   `json:"id"`
	MemberCodes        []string `json:"member_codes"`
	IntalevMemberCodes []string `json:"intalev_member_codes"`
	ERPMemberCodes     []string `json:"erp_member_codes"`
}

type structuralControlSettingsBinding struct {
	Organization               string                                `json:"organization"`
	Period                     string                                `json:"period"`
	CSV_SHA256                 string                                `json:"csv_sha256"`
	StructuralGroupControlSets []structuralControlSettingsSetBinding `json:"structural_group_control_sets"`
}

func appendStructuralControlSettingsArgument(command []string, settingsPath string) []string {
	if strings.TrimSpace(settingsPath) == "" {
		return command
	}
	return append(command, "--structural-control-settings", settingsPath)
}

func hasStructuralControlSettingsArgument(command []string) bool {
	for _, token := range command {
		if token == "--structural-control-settings" {
			return true
		}
	}
	return false
}

func appendStructuralControlScopeArguments(command []string) []string {
	result := append([]string{}, command...)
	for _, pair := range [][2]string{
		{"--organization-id", "{organization_id}"}, {"--organization-name", "{organization_name}"},
		{"--organization-path", "{organization_path}"}, {"--run-id", "{run_id}"}, {"--context-id", "{context_id}"},
	} {
		found := false
		for _, token := range result {
			if token == pair[0] {
				found = true
				break
			}
		}
		if !found {
			result = append(result, pair[0], pair[1])
		}
	}
	return result
}

func (p *Pipeline) materializeActiveStructuralControlSettings(run Run, contextValue Context, runDir string) (string, structuralControlPipelineAudit, error) {
	audit := structuralControlPipelineAudit{
		Status: "NO_ACTIVE_UI_FIXED_SETS", ControlSetIDs: []string{},
		RunID: run.ID, ContextID: contextValue.ID, Organization: contextValue.Organization,
		OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period,
		AppliedVersions:     []structuralControlPipelineVersionRef{},
		CorrectionAuthority: false, FinancialRows: 0, PostingRows: 0,
	}
	if p == nil || p.store == nil {
		return "", audit, errors.New("structural control pipeline store is unavailable")
	}
	server := &Server{store: p.store}
	unlock, err := server.lockStructuralControlRegistry()
	if err != nil {
		return "", audit, err
	}
	defer unlock()
	registry, err := server.loadStructuralControlRegistry()
	if err != nil {
		return "", audit, err
	}
	active := structuralControlActiveVersions(registry)
	latestByLineage := map[string]structuralControlSetVersion{}
	for _, version := range registry.Versions {
		if !active[version.ControlSetID] {
			continue
		}
		if version.OrganizationID != contextValue.OrganizationID {
			continue
		}
		prior, found := latestByLineage[version.LineageID]
		if !found || version.Version > prior.Version ||
			(version.Version == prior.Version && version.FixedAt.After(prior.FixedAt)) {
			latestByLineage[version.LineageID] = version
		}
	}
	versions := make([]structuralControlSetVersion, 0, len(latestByLineage))
	for _, version := range latestByLineage {
		versions = append(versions, version)
	}
	if len(versions) == 0 {
		return "", audit, nil
	}
	sort.Slice(versions, func(left, right int) bool { return versions[left].ControlSetID < versions[right].ControlSetID })
	registryPath := server.structuralControlRegistryPath()
	registryBytes, err := os.ReadFile(registryPath)
	if err != nil {
		return "", audit, err
	}
	registrySHA := structuralControlBytesSHA256(registryBytes)
	sets := make([]structuralControlPipelineSet, 0, len(versions))
	refs := make([]structuralControlPipelineVersionRef, 0, len(versions))
	owners := map[string]string{}
	for _, version := range versions {
		originBinding, originRun, originContext, _, originBindingSHA, loadErr := server.loadStructuralControlBinding(version.RunID)
		if loadErr != nil {
			return "", audit, fmt.Errorf("active structural control origin binding unavailable: %s: %w", version.ControlSetID, loadErr)
		}
		originInventory, verifiedBindingSHA, loadErr := server.loadStructuralControlInventory(
			originBinding.OrganizationID, version.RunID, originBinding.InventoryID)
		if loadErr != nil || verifiedBindingSHA != originBindingSHA {
			return "", audit, fmt.Errorf("active structural control origin inventory is not verified: %s", version.ControlSetID)
		}
		if originBinding.OrganizationID != contextValue.OrganizationID ||
			originBinding.OrganizationName != contextValue.OrganizationName ||
			originBinding.OrganizationPath != contextValue.OrganizationPath ||
			!structuralControlVersionMatchesRun(version, originRun, originContext) ||
			!structuralControlVersionMatchesInventory(version, originInventory) ||
			version.InventoryBindingSHA256 != originBindingSHA || version.Mode != "SUM_DELTA_ONLY" ||
			version.ExpectedControlDelta != 0 || version.CorrectionAuthority {
			return "", audit, fmt.Errorf("active structural control set is not valid for R005: %s", version.ControlSetID)
		}
		intalevBindings, err := structuralControlPipelineMemberSelectors(version.IntalevMembers, "INTALEV", version.ControlSetID, version.InventoryID, owners)
		if err != nil {
			return "", audit, err
		}
		erpBindings, err := structuralControlPipelineMemberSelectors(version.ERPMembers, "ERP", version.ControlSetID, version.InventoryID, owners)
		if err != nil {
			return "", audit, err
		}
		intalevCodes := structuralControlOptionalCodes(version.IntalevMembers)
		erpCodes := structuralControlOptionalCodes(version.ERPMembers)
		memberCodes := structuralControlUnionCodes(intalevCodes, erpCodes)
		setID, err := structuralControlPipelineGroupID(contextValue.Organization, version.Name, intalevBindings, erpBindings)
		if err != nil {
			return "", audit, err
		}
		sets = append(sets, structuralControlPipelineSet{
			ID: setID, Name: version.Name,
			ReconciliationOrganization:   contextValue.Organization,
			ReconciliationOrganizationID: contextValue.Organization,
			ExactOrganizationID:          contextValue.OrganizationID,
			Enabled:                      true, Mode: "SUM_DELTA_ONLY", MemberCodes: memberCodes,
			IntalevMemberCodes: intalevCodes, ERPMemberCodes: erpCodes,
			IntalevMemberBindings: intalevBindings, ERPMemberBindings: erpBindings,
			ExpectedControlDelta: 0, Tolerance: float64(version.ToleranceCents) / 100,
		})
		refs = append(refs, structuralControlPipelineVersionRef{
			ControlSetID: version.ControlSetID, LineageID: version.LineageID, Version: version.Version,
			PayloadSHA256: version.PayloadSHA256, MaterializedSetID: setID,
			OriginRunID: version.RunID, OriginContextID: version.ContextID,
			OriginInventoryID: version.InventoryID, OriginInventoryBindingSHA256: originBindingSHA,
		})
	}

	settingsDir := filepath.Join(runDir, "r005-settings")
	csvPath := filepath.Join(settingsDir, "structural-control-settings.ui-fixed.csv")
	csvBytes, err := structuralControlPipelineCSV(contextValue.Organization, sets)
	if err != nil {
		return "", audit, err
	}
	if err := atomicWritePrivateFile(csvPath, csvBytes); err != nil {
		return "", audit, err
	}
	csvSHA := structuralControlBytesSHA256(csvBytes)
	bindingSets := make([]structuralControlSettingsSetBinding, 0, len(sets))
	for _, set := range sets {
		bindingSets = append(bindingSets, structuralControlSettingsSetBinding{
			ID: set.ID, MemberCodes: set.MemberCodes,
			IntalevMemberCodes: set.IntalevMemberCodes, ERPMemberCodes: set.ERPMemberCodes,
		})
	}
	settingsBinding := structuralControlSettingsBinding{
		Organization: contextValue.Organization, Period: contextValue.Period, CSV_SHA256: csvSHA,
		StructuralGroupControlSets: bindingSets,
	}
	settingsBindingBytes, err := json.Marshal(settingsBinding)
	if err != nil {
		return "", audit, err
	}
	settingsID := "STRUCTURAL-SETTINGS-" + structuralControlBytesSHA256(settingsBindingBytes)[:24]
	document := structuralControlPipelineDocument{
		Schema: structuralControlSettingsSchema, SettingsID: settingsID,
		Organization: contextValue.Organization, OrganizationID: contextValue.OrganizationID,
		OrganizationName: contextValue.OrganizationName, OrganizationPath: contextValue.OrganizationPath,
		Period: contextValue.Period, RunID: run.ID, ContextID: contextValue.ID,
		Source: structuralControlPipelineSource{
			Path: csvPath, Filename: filepath.Base(csvPath), Size: len(csvBytes), SHA256: csvSHA,
			Format: "UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1",
		},
		StructuralGroupControlSets: sets,
		UIFixedRegistry: structuralControlPipelineOrigin{
			SchemaVersion: registry.SchemaVersion, RegistryPath: registryPath, RegistrySHA256: registrySHA,
			RegistrySize: len(registryBytes), RegistryRevision: registry.Revision,
			OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
			OrganizationPath: contextValue.OrganizationPath, RunID: run.ID, ContextID: contextValue.ID,
			ActiveVersions: refs,
		},
		Safety: structuralControlPipelineSafety{
			Mode: "REPORT_ONLY", PostingRows: 0, ReadyToUpload: false, ReleaseAllowed: false,
			ExecutionAllowed: false, Live1CAllowed: false,
		},
	}
	settingsPath := filepath.Join(settingsDir, "structural-control-settings.ui-fixed.json")
	if err := atomicWritePrivateJSON(settingsPath, document); err != nil {
		return "", audit, err
	}
	settingsSHA, err := sha256File(settingsPath)
	if err != nil {
		return "", audit, err
	}
	controlSetIDs := make([]string, 0, len(refs))
	for _, ref := range refs {
		controlSetIDs = append(controlSetIDs, ref.ControlSetID)
	}
	audit = structuralControlPipelineAudit{
		Status: "ACTIVE_UI_FIXED_SETS_MATERIALIZED", SettingsPath: settingsPath, SettingsSHA256: settingsSHA,
		RunID: run.ID, ContextID: contextValue.ID, Organization: contextValue.Organization,
		OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period,
		SourceCSVPath: csvPath, SourceCSVSHA256: csvSHA, RegistryPath: registryPath,
		RegistrySHA256: registrySHA, RegistryRevision: registry.Revision,
		ControlSetIDs: controlSetIDs, AppliedVersions: refs, SetCount: len(sets), CorrectionAuthority: false, FinancialRows: 0, PostingRows: 0,
	}
	if err := atomicWritePrivateJSON(filepath.Join(settingsDir, "structural-control-settings.audit.json"), audit); err != nil {
		return "", audit, err
	}
	return settingsPath, audit, nil
}

func (p *Pipeline) verifyStructuralControlPipelineAudit(audit structuralControlPipelineAudit) error {
	if audit.Status == "NO_ACTIVE_UI_FIXED_SETS" {
		return nil
	}
	if audit.Status != "ACTIVE_UI_FIXED_SETS_MATERIALIZED" || audit.SetCount == 0 ||
		len(audit.ControlSetIDs) != audit.SetCount || !validSHA256(audit.SettingsSHA256) ||
		!validSHA256(audit.SourceCSVSHA256) || !validSHA256(audit.RegistrySHA256) {
		return errors.New("structural control pipeline audit is incomplete")
	}
	for path, expected := range map[string]string{
		audit.SettingsPath:  audit.SettingsSHA256,
		audit.SourceCSVPath: audit.SourceCSVSHA256,
		audit.RegistryPath:  audit.RegistrySHA256,
	} {
		actual, err := sha256File(path)
		if err != nil || !strings.EqualFold(actual, expected) {
			return errors.New("structural control pipeline artifact drift")
		}
	}
	server := &Server{store: p.store}
	unlock, err := server.lockStructuralControlRegistry()
	if err != nil {
		return err
	}
	defer unlock()
	registry, err := server.loadStructuralControlRegistry()
	if err != nil || registry.Revision != audit.RegistryRevision {
		return errors.New("structural control registry changed before R005")
	}
	active := structuralControlActiveVersions(registry)
	for _, id := range audit.ControlSetIDs {
		if !active[id] {
			return errors.New("structural control set became inactive before R005")
		}
	}
	return nil
}

func structuralControlPipelineMemberSelectors(members []structuralControlMember, side, controlSetID, inventoryID string, owners map[string]string) ([]structuralControlPipelineMemberBinding, error) {
	if len(members) == 0 {
		return nil, fmt.Errorf("active structural control set side is empty: %s:%s", controlSetID, side)
	}
	bindings := make([]structuralControlPipelineMemberBinding, 0, len(members))
	local := map[string]bool{}
	for _, member := range members {
		identity := strings.TrimSpace(member.Identity)
		hierarchyPath := strings.TrimSpace(member.HierarchyPath)
		if identity == "" || hierarchyPath == "" {
			return nil, fmt.Errorf("active structural control set has incomplete identity/path selector: %s:%s", controlSetID, side)
		}
		selectorKey := identity + "\x00" + hierarchyPath
		if local[selectorKey] {
			return nil, fmt.Errorf("active structural control set has duplicate identity/path selector: %s:%s", controlSetID, side)
		}
		local[selectorKey] = true
		ownerKey := side + "\x00" + selectorKey
		if prior := owners[ownerKey]; prior != "" && prior != controlSetID {
			return nil, fmt.Errorf("active structural control sets overlap: %s:%s:%s", side, hierarchyPath, prior)
		}
		owners[ownerKey] = controlSetID
		bindings = append(bindings, structuralControlPipelineMemberBinding{
			Code: strings.ToUpper(strings.TrimSpace(member.Code)), HierarchyPath: hierarchyPath,
			OriginIdentity: identity, OriginInventoryID: inventoryID,
		})
	}
	return bindings, nil
}

func structuralControlOptionalCodes(members []structuralControlMember) []string {
	result := make([]string, 0, len(members))
	seen := map[string]bool{}
	for _, member := range members {
		code := strings.ToUpper(strings.TrimSpace(member.Code))
		if code != "" && !seen[code] {
			result = append(result, code)
			seen[code] = true
		}
	}
	return result
}

func structuralControlUnionCodes(intalev, erp []string) []string {
	result := make([]string, 0, len(intalev)+len(erp))
	seen := map[string]bool{}
	for _, code := range append(append([]string{}, intalev...), erp...) {
		if !seen[code] {
			seen[code] = true
			result = append(result, code)
		}
	}
	return result
}

func structuralControlPipelineGroupID(organization, name string, intalev, erp []structuralControlPipelineMemberBinding) (string, error) {
	payload, err := json.Marshal(structuralControlGroupIDPayload{
		Organization: organization, Name: name, IntalevSelectors: intalev, ERPSelectors: erp,
	})
	if err != nil {
		return "", err
	}
	return "USER-STRUCTURAL-" + structuralControlBytesSHA256(payload)[:20], nil
}

func structuralControlPipelineCSV(organization string, sets []structuralControlPipelineSet) ([]byte, error) {
	var builder strings.Builder
	writer := csv.NewWriter(&builder)
	writer.Comma = ';'
	writer.UseCRLF = false
	if err := writer.Write([]string{"Организация", "Название группы", "Пути блоков Инталев", "Пути блоков ERP", "Активна"}); err != nil {
		return nil, err
	}
	for _, set := range sets {
		if err := writer.Write([]string{
			organization, set.Name, structuralControlSelectorPaths(set.IntalevMemberBindings), structuralControlSelectorPaths(set.ERPMemberBindings), "Да",
		}); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return []byte(builder.String()), nil
}

func structuralControlSelectorPaths(bindings []structuralControlPipelineMemberBinding) string {
	paths := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		paths = append(paths, binding.HierarchyPath)
	}
	return strings.Join(paths, " | ")
}

func structuralControlBytesSHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(digest[:]))
}
