package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

const structuralControlSettingsSchema = "opiu-structural-control-settings.v1"

const (
	structuralControlAuthorityFlag         = "--structural-control-authority"
	structuralControlSettingsCSVFlag       = "--structural-control-settings-csv"
	structuralControlSelectionProofFlag    = "--structural-control-selection-proof"
	structuralControlAuthorityServiceJSON  = "service-json"
	structuralControlAuthorityServiceCSV   = "service-csv"
	structuralControlAuthorityServiceNone  = "service-none"
	structuralControlPackagedCSVStatus     = "PACKAGED_USER_CSV_MATERIALIZED"
	structuralControlPackagedNoExactStatus = "PACKAGED_USER_CSV_NO_EXACT_SCOPE"
	structuralControlPackagedCSVFilename   = "Настройка_группировки_блоков.csv"
	structuralControlPackagedCSVMaxBytes   = int64(1 << 20)
	structuralControlSettingsJSONMaxBytes  = int64(4 << 20)
)

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
	SelectionPath       string                                `json:"selection_path,omitempty"`
	SelectionSHA256     string                                `json:"selection_sha256,omitempty"`
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

type structuralControlPackagedSelection struct {
	Schema         string   `json:"schema"`
	Authority      string   `json:"authority"`
	Status         string   `json:"status"`
	Path           string   `json:"path"`
	SourcePath     string   `json:"source_path"`
	SourceSHA256   string   `json:"source_sha256"`
	SourceSize     int64    `json:"source_size"`
	SettingsPath   string   `json:"settings_path"`
	SettingsSHA256 string   `json:"settings_sha256"`
	SettingsSize   int64    `json:"settings_size"`
	SettingsID     string   `json:"settings_id"`
	SetCount       int      `json:"set_count"`
	SetIDs         []string `json:"set_ids"`
	SetsSHA256     string   `json:"sets_sha256"`
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

func hasStructuralControlAuthorityArgument(command []string) bool {
	for _, token := range command {
		if token == structuralControlAuthorityFlag || token == structuralControlSettingsCSVFlag || token == structuralControlSelectionProofFlag {
			return true
		}
	}
	return false
}

func appendStructuralControlAuthorityArguments(command []string, audit structuralControlPipelineAudit, settingsPath string) ([]string, error) {
	if hasStructuralControlSettingsArgument(command) || hasStructuralControlAuthorityArgument(command) {
		return nil, errors.New("structural control authority is already present in R005 command")
	}
	result := append([]string{}, command...)
	switch audit.Status {
	case "ACTIVE_UI_FIXED_SETS_MATERIALIZED":
		if strings.TrimSpace(settingsPath) == "" || !sameFilesystemPath(settingsPath, audit.SettingsPath) {
			return nil, errors.New("active UI structural control settings path is missing or inconsistent")
		}
		return append(result,
			structuralControlAuthorityFlag, structuralControlAuthorityServiceJSON,
			"--structural-control-settings", settingsPath,
		), nil
	case structuralControlPackagedCSVStatus:
		if strings.TrimSpace(settingsPath) == "" || !sameFilesystemPath(settingsPath, audit.SettingsPath) ||
			strings.TrimSpace(audit.SourceCSVPath) == "" || strings.TrimSpace(audit.SelectionPath) == "" ||
			!validSHA256(audit.SelectionSHA256) {
			return nil, errors.New("packaged structural control settings authority is incomplete")
		}
		return append(result,
			structuralControlAuthorityFlag, structuralControlAuthorityServiceJSON,
			"--structural-control-settings", settingsPath,
			structuralControlSelectionProofFlag, audit.SelectionPath,
		), nil
	case structuralControlPackagedNoExactStatus:
		if strings.TrimSpace(settingsPath) != "" || strings.TrimSpace(audit.SourceCSVPath) == "" || strings.TrimSpace(audit.SelectionPath) == "" ||
			!validSHA256(audit.SelectionSHA256) {
			return nil, errors.New("packaged structural control no-exact authority is inconsistent")
		}
		return append(result, structuralControlAuthorityFlag, structuralControlAuthorityServiceNone,
			structuralControlSelectionProofFlag, audit.SelectionPath), nil
	case "NO_ACTIVE_UI_FIXED_SETS":
		if strings.TrimSpace(settingsPath) != "" {
			return nil, errors.New("default structural control state unexpectedly has a settings path")
		}
		return append(result, structuralControlAuthorityFlag, structuralControlAuthorityServiceNone), nil
	default:
		return nil, fmt.Errorf("unsupported structural control authority status: %s", audit.Status)
	}
}

func packagedStructuralControlSettingsCSV(runtimeRoot string) string {
	root := filepath.Clean(strings.TrimSpace(runtimeRoot))
	if root == "." || root == "" {
		return ""
	}
	productRoot := root
	if strings.EqualFold(filepath.Base(root), "runtime") {
		productRoot = filepath.Dir(root)
	}
	return filepath.Join(productRoot, "user-settings", structuralControlPackagedCSVFilename)
}

func materializePackagedStructuralControlSettings(
	run Run,
	contextValue Context,
	runDir, sourcePath, nodePath, wrapperPath string,
	audit structuralControlPipelineAudit,
) (string, structuralControlPipelineAudit, error) {
	if audit.Status != "NO_ACTIVE_UI_FIXED_SETS" {
		return "", audit, nil
	}
	requested := strings.TrimSpace(sourcePath)
	if requested == "" {
		return "", audit, nil
	}
	_, err := os.Lstat(requested)
	if errors.Is(err, os.ErrNotExist) {
		return "", audit, nil
	}
	if err != nil {
		return "", audit, err
	}
	bytes, err := readStructuralControlSecureArtifact(filepath.Dir(requested), requested, structuralControlPackagedCSVMaxBytes)
	if err != nil {
		return "", audit, fmt.Errorf("packaged structural control settings CSV is unsafe: %w", err)
	}
	destination := filepath.Join(runDir, "r005-settings", "structural-control-settings.packaged.csv")
	if err := atomicWritePrivateFile(destination, bytes); err != nil {
		return "", audit, err
	}
	settingsPath := filepath.Join(runDir, "r005-settings", "structural-control-settings.packaged.json")
	selectionPath := filepath.Join(runDir, "r005-settings", "structural-control-settings.packaged.selection.json")
	command := exec.Command(
		nodePath, wrapperPath, "materialize-structural-control-settings",
		structuralControlSettingsCSVFlag, destination,
		"--organization", contextValue.Organization,
		"--period", contextValue.Period,
		"--output", settingsPath,
		"--selection-output", selectionPath,
	)
	command.Dir = filepath.Dir(wrapperPath)
	if output, commandErr := command.CombinedOutput(); commandErr != nil {
		return "", audit, fmt.Errorf("packaged structural control settings materialization failed: %w: %s", commandErr, strings.TrimSpace(string(output)))
	}
	selectionBytes, err := readStructuralControlSecureArtifact(runDir, selectionPath, structuralControlPackagedCSVMaxBytes)
	if err != nil {
		return "", audit, err
	}
	var selection structuralControlPackagedSelection
	if err := decodeJSONRejectDuplicateKeys(selectionBytes, &selection, true); err != nil {
		return "", audit, err
	}
	sourceSHA := structuralControlBytesSHA256(bytes)
	if selection.Schema != "opiu-service-structural-control-selection.v1" ||
		selection.Authority != structuralControlAuthorityServiceCSV ||
		!sameFilesystemPath(selection.SourcePath, destination) ||
		!strings.EqualFold(selection.SourceSHA256, sourceSHA) || selection.SourceSize != int64(len(bytes)) {
		return "", audit, errors.New("packaged structural control selection proof does not match the run-owned CSV")
	}
	audit.SourceCSVPath = destination
	audit.SourceCSVSHA256 = sourceSHA
	switch selection.Status {
	case "EXACT_ORGANIZATION_MATERIALIZED":
		if !sameFilesystemPath(selection.Path, settingsPath) {
			return "", audit, errors.New("packaged structural control selection path does not match the expected settings path")
		}
		verificationPath := filepath.Join(runDir, "r005-settings", "structural-control-settings.packaged.verification.json")
		verificationCommand := exec.Command(
			nodePath, wrapperPath, "verify-structural-control-settings",
			structuralControlSettingsCSVFlag, destination,
			"--structural-control-settings", settingsPath,
			"--organization", contextValue.Organization,
			"--period", contextValue.Period,
			"--verification-output", verificationPath,
		)
		verificationCommand.Dir = filepath.Dir(wrapperPath)
		if output, commandErr := verificationCommand.CombinedOutput(); commandErr != nil {
			return "", audit, fmt.Errorf("packaged structural control settings verification failed: %w: %s", commandErr, strings.TrimSpace(string(output)))
		}
		selectionBytes, err = readStructuralControlSecureArtifact(runDir, verificationPath, structuralControlPackagedCSVMaxBytes)
		if err != nil {
			return "", audit, err
		}
		if err := decodeJSONRejectDuplicateKeys(selectionBytes, &selection, true); err != nil {
			return "", audit, err
		}
		settingsBytes, err := readStructuralControlSecureArtifact(runDir, settingsPath, structuralControlSettingsJSONMaxBytes)
		if err != nil {
			return "", audit, err
		}
		settingsSHA := structuralControlBytesSHA256(settingsBytes)
		setIDs, err := validatePackagedStructuralControlSettings(settingsBytes, contextValue, destination, sourceSHA, int64(len(bytes)))
		if err != nil {
			return "", audit, err
		}
		if selection.Schema != "opiu-service-structural-control-verification.v1" ||
			selection.Authority != structuralControlAuthorityServiceCSV || selection.Status != "EXACT_ORGANIZATION_MATERIALIZED" ||
			!sameFilesystemPath(selection.Path, settingsPath) || !sameFilesystemPath(selection.SettingsPath, settingsPath) ||
			!sameFilesystemPath(selection.SourcePath, destination) ||
			!strings.EqualFold(selection.SourceSHA256, sourceSHA) || selection.SourceSize != int64(len(bytes)) ||
			!strings.EqualFold(selection.SettingsSHA256, settingsSHA) || selection.SettingsSize != int64(len(settingsBytes)) ||
			selection.SettingsID == "" || selection.SetCount != len(setIDs) || !reflect.DeepEqual(selection.SetIDs, setIDs) ||
			!validSHA256(selection.SetsSHA256) {
			return "", audit, errors.New("packaged structural control canonical verification does not match materialized settings")
		}
		audit.Status = structuralControlPackagedCSVStatus
		audit.SettingsPath = settingsPath
		audit.SettingsSHA256 = settingsSHA
		audit.ControlSetIDs = setIDs
		audit.SetCount = len(setIDs)
		audit.SelectionPath = verificationPath
		audit.SelectionSHA256 = structuralControlBytesSHA256(selectionBytes)
		return settingsPath, audit, nil
	case "NO_EXACT_ORGANIZATION", "NO_ACTIVE_SETS":
		if strings.TrimSpace(selection.Path) != "" {
			return "", audit, errors.New("packaged structural control empty selection unexpectedly has a settings path")
		}
		if _, statErr := os.Lstat(settingsPath); !errors.Is(statErr, os.ErrNotExist) {
			return "", audit, errors.New("packaged structural control empty selection unexpectedly materialized settings")
		}
		audit.Status = structuralControlPackagedNoExactStatus
		audit.SelectionPath = selectionPath
		audit.SelectionSHA256 = structuralControlBytesSHA256(selectionBytes)
		return "", audit, nil
	default:
		return "", audit, fmt.Errorf("packaged structural control selection status is invalid: %s", selection.Status)
	}
}

func structuralControlExactStringSlice(value any, label string) ([]string, error) {
	raw, ok := value.([]any)
	if !ok || len(raw) == 0 {
		return nil, fmt.Errorf("%s must be a non-empty array", label)
	}
	result := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		text, ok := item.(string)
		text = strings.ToUpper(strings.TrimSpace(text))
		if !ok || text == "" || seen[text] {
			return nil, fmt.Errorf("%s contains an invalid or duplicate code", label)
		}
		seen[text] = true
		result = append(result, text)
	}
	return result, nil
}

func validatePackagedStructuralControlSettings(data []byte, contextValue Context, sourcePath, sourceSHA string, sourceSize int64) ([]string, error) {
	var document map[string]any
	if err := decodeJSONRejectDuplicateKeys(data, &document, false); err != nil {
		return nil, err
	}
	if structuralControlText(document["schema"]) != structuralControlSettingsSchema ||
		structuralControlText(document["settings_id"]) == "" ||
		structuralControlText(document["organization"]) != contextValue.Organization ||
		structuralControlText(document["period"]) != contextValue.Period {
		return nil, errors.New("packaged structural control settings scope is invalid")
	}
	source, ok := document["source"].(map[string]any)
	if !ok || structuralControlText(source["format"]) != "BUSINESS_CSV_SEMICOLON_UTF8" ||
		!sameFilesystemPath(structuralControlText(source["path"]), sourcePath) ||
		!strings.EqualFold(structuralControlText(source["sha256"]), sourceSHA) {
		return nil, errors.New("packaged structural control settings source binding is invalid")
	}
	size, err := structuralControlInteger(source["size"])
	if err != nil || int64(size) != sourceSize {
		return nil, errors.New("packaged structural control settings source size is invalid")
	}
	safety, ok := document["safety"].(map[string]any)
	postingRows, postingRowsErr := structuralControlInteger(safety["posting_rows"])
	if !ok || structuralControlText(safety["mode"]) != "REPORT_ONLY" || postingRowsErr != nil || postingRows != 0 ||
		safety["ready_to_upload"] != false ||
		safety["release_allowed"] != false || safety["execution_allowed"] != false || safety["live_1c_allowed"] != false {
		return nil, errors.New("packaged structural control settings safety is open")
	}
	sets, ok := document["structural_group_control_sets"].([]any)
	if !ok || len(sets) == 0 {
		return nil, errors.New("packaged structural control settings sets are missing")
	}
	ids := make([]string, 0, len(sets))
	seenIDs, seenNames, codeOwners := map[string]bool{}, map[string]bool{}, map[string]string{}
	for index, raw := range sets {
		set, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("packaged structural control set %d is invalid", index)
		}
		id, name := structuralControlText(set["id"]), structuralControlText(set["name"])
		if id == "" || name == "" || seenIDs[id] || seenNames[name] || set["enabled"] != true ||
			structuralControlText(set["mode"]) != "SUM_DELTA_ONLY" ||
			structuralControlText(set["reconciliation_organization"]) != contextValue.Organization ||
			structuralControlText(set["reconciliation_organization_id"]) != contextValue.Organization {
			return nil, fmt.Errorf("packaged structural control set %d identity is invalid", index)
		}
		if delta, deltaErr := structuralControlInteger(set["expected_control_delta"]); deltaErr != nil || delta != 0 {
			return nil, fmt.Errorf("packaged structural control set %s expected delta is invalid", id)
		}
		tolerance, ok := set["tolerance"].(float64)
		if !ok || tolerance != 0.01 {
			return nil, fmt.Errorf("packaged structural control set %s tolerance is invalid", id)
		}
		members, err := structuralControlExactStringSlice(set["member_codes"], id+".member_codes")
		if err != nil || len(members) < 2 {
			return nil, fmt.Errorf("packaged structural control set %s members are invalid", id)
		}
		intalevRaw, hasIntalev := set["intalev_member_codes"]
		erpRaw, hasERP := set["erp_member_codes"]
		if hasIntalev != hasERP {
			return nil, fmt.Errorf("packaged structural control set %s split sides are incomplete", id)
		}
		if hasIntalev {
			intalev, intalevErr := structuralControlExactStringSlice(intalevRaw, id+".intalev_member_codes")
			erp, erpErr := structuralControlExactStringSlice(erpRaw, id+".erp_member_codes")
			if intalevErr != nil || erpErr != nil {
				return nil, fmt.Errorf("packaged structural control set %s split sides are invalid", id)
			}
			union := map[string]bool{}
			for _, code := range append(append([]string{}, intalev...), erp...) {
				union[code] = true
			}
			if len(union) != len(members) {
				return nil, fmt.Errorf("packaged structural control set %s split union is invalid", id)
			}
			for _, code := range members {
				if !union[code] {
					return nil, fmt.Errorf("packaged structural control set %s split union drift", id)
				}
			}
		}
		for _, code := range members {
			if owner := codeOwners[code]; owner != "" {
				return nil, fmt.Errorf("packaged structural control code %s overlaps %s and %s", code, owner, id)
			}
			codeOwners[code] = id
		}
		seenIDs[id], seenNames[name] = true, true
		ids = append(ids, id)
	}
	return ids, nil
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
	if audit.Status == structuralControlPackagedCSVStatus || audit.Status == structuralControlPackagedNoExactStatus {
		active := audit.Status == structuralControlPackagedCSVStatus
		if len(audit.AppliedVersions) != 0 || strings.TrimSpace(audit.SourceCSVPath) == "" ||
			strings.TrimSpace(audit.SelectionPath) == "" || !validSHA256(audit.SelectionSHA256) || !validSHA256(audit.SourceCSVSHA256) ||
			(active && (audit.SetCount < 1 || len(audit.ControlSetIDs) != audit.SetCount ||
				strings.TrimSpace(audit.SettingsPath) == "" || !validSHA256(audit.SettingsSHA256))) ||
			(!active && (audit.SetCount != 0 || len(audit.ControlSetIDs) != 0 || strings.TrimSpace(audit.SettingsPath) != "")) {
			return errors.New("packaged structural control audit is incomplete")
		}
		runRoot := filepath.Dir(filepath.Dir(audit.SourceCSVPath))
		bytes, err := readStructuralControlSecureArtifact(runRoot, audit.SourceCSVPath, structuralControlPackagedCSVMaxBytes)
		if err != nil || !strings.EqualFold(structuralControlBytesSHA256(bytes), audit.SourceCSVSHA256) {
			return errors.New("packaged structural control CSV drift")
		}
		if active {
			settingsBytes, err := readStructuralControlSecureArtifact(runRoot, audit.SettingsPath, structuralControlSettingsJSONMaxBytes)
			if err != nil || !strings.EqualFold(structuralControlBytesSHA256(settingsBytes), audit.SettingsSHA256) {
				return errors.New("packaged structural control settings drift")
			}
		}
		selectionBytes, err := readStructuralControlSecureArtifact(runRoot, audit.SelectionPath, structuralControlPackagedCSVMaxBytes)
		if err != nil || !strings.EqualFold(structuralControlBytesSHA256(selectionBytes), audit.SelectionSHA256) {
			return errors.New("packaged structural control selection drift")
		}
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
