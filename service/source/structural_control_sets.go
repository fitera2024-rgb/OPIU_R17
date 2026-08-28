package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	structuralControlRegistrySchema  = "opiu-structural-control-registry.v1"
	structuralControlInventorySchema = "opiu-structural-control-inventory.v2"
	structuralControlBindingSchema   = "opiu-structural-control-inventory-binding.v2"
)

var structuralControlRegistryMu sync.Mutex

type structuralControlMember struct {
	Identity                string `json:"identity"`
	Code                    string `json:"code"`
	Name                    string `json:"name"`
	HierarchyPath           string `json:"hierarchy_path"`
	AmountCents             int64  `json:"amount_cents"`
	SourceOrder             int    `json:"source_order"`
	SelectableRoot          bool   `json:"selectable_root,omitempty"`
	Ambiguous               bool   `json:"-"`
	ParentIdentity          string `json:"-"`
	SemanticStatus          string `json:"-"`
	CandidateSelectable     bool   `json:"-"`
	BusinessBlockDeclared   bool   `json:"-"`
	RequiresUserDeclaration bool   `json:"-"`
	CorrectionAuthority     bool   `json:"-"`
}

type structuralControlInventory struct {
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
	IntalevMembers                       []structuralControlMember          `json:"intalev_members"`
	ERPMembers                           []structuralControlMember          `json:"erp_members"`
	Blockers                             []json.RawMessage                  `json:"blockers"`
	DefaultBehavior                      string                             `json:"default_behavior"`
	OptionalOnly                         bool                               `json:"optional_control_only"`
	CorrectionAuthority                  bool                               `json:"correction_authority"`
	FinancialRows                        int                                `json:"financial_rows"`
	Safety                               SafetyState                        `json:"safety"`
	CandidateSemantics                   string                             `json:"-"`
	AutomaticBusinessBlockClassification bool                               `json:"-"`
	UserDeclarationRequired              bool                               `json:"-"`
	CanonicalMemberHashes                structuralControlHierarchyVersions `json:"-"`
}

type structuralControlOrganization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type structuralControlHierarchyVersions struct {
	Intalev string `json:"intalev"`
	ERP     string `json:"erp"`
}

type structuralControlInputHash struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type structuralControlInputHashes struct {
	Intalev []structuralControlInputHash `json:"intalev"`
	ERP     []structuralControlInputHash `json:"erp"`
}

type structuralControlArtifactDescriptor struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type structuralControlCurrentRun struct {
	Report               structuralControlArtifactDescriptor `json:"report"`
	CodexInput           structuralControlArtifactDescriptor `json:"codex_input"`
	Manifest             structuralControlArtifactDescriptor `json:"manifest"`
	ScopeVerified        bool                                `json:"scope_verified"`
	VerificationBlockers []string                            `json:"verification_blockers"`
	RunID                string                              `json:"run_id"`
	ContextID            string                              `json:"context_id"`
	Organization         structuralControlOrganization       `json:"organization"`
	Period               string                              `json:"period"`
	InventoryID          string                              `json:"inventory_id"`
}

type structuralControlSourceFile struct {
	File     string   `json:"file"`
	SHA256   string   `json:"sha256"`
	Sheets   []string `json:"sheets"`
	FirstRow int      `json:"first_row"`
	LastRow  int      `json:"last_row"`
}

type structuralControlSourceSide struct {
	NodeCount int                           `json:"node_count"`
	RootCount int                           `json:"root_count"`
	Sources   []structuralControlSourceFile `json:"sources"`
}

type structuralControlSourceScope struct {
	Intalev structuralControlSourceSide `json:"intalev"`
	ERP     structuralControlSourceSide `json:"erp"`
}

type structuralControlInventoryBinding struct {
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
	Safety                               SafetyState                         `json:"safety"`
	CandidateSemantics                   string                              `json:"-"`
	AutomaticBusinessBlockClassification bool                                `json:"-"`
	UserDeclarationRequired              bool                                `json:"-"`
	CorrectionAuthority                  bool                                `json:"-"`
}

type structuralControlDraft struct {
	DraftID                string                    `json:"draft_id"`
	SourceControlSetID     string                    `json:"source_control_set_id,omitempty"`
	LineageID              string                    `json:"lineage_id"`
	Name                   string                    `json:"name"`
	OrganizationID         string                    `json:"organization_id"`
	OrganizationName       string                    `json:"organization_name"`
	RunID                  string                    `json:"run_id"`
	ContextID              string                    `json:"context_id"`
	InventoryID            string                    `json:"inventory_id"`
	Author                 string                    `json:"author"`
	Mode                   string                    `json:"mode"`
	ExpectedControlDelta   int64                     `json:"expected_control_delta"`
	ToleranceCents         int64                     `json:"tolerance_cents"`
	IntalevMembers         []structuralControlMember `json:"intalev_members"`
	ERPMembers             []structuralControlMember `json:"erp_members"`
	InventoryBindingSHA256 string                    `json:"inventory_binding_sha256"`
	CreatedAt              time.Time                 `json:"created_at"`
	PayloadSHA256          string                    `json:"payload_sha256"`
	SourceInventorySchema  string                    `json:"source_inventory_schema,omitempty"`
	ControlOnlyDeclared    bool                      `json:"control_only_declared,omitempty"`
	CorrectionAuthority    bool                      `json:"correction_authority,omitempty"`
}

type structuralControlSetVersion struct {
	ControlSetID           string                    `json:"control_set_id"`
	LineageID              string                    `json:"lineage_id"`
	Version                int                       `json:"version"`
	Name                   string                    `json:"name"`
	OrganizationID         string                    `json:"organization_id"`
	OrganizationName       string                    `json:"organization_name"`
	RunID                  string                    `json:"run_id"`
	ContextID              string                    `json:"context_id"`
	InventoryID            string                    `json:"inventory_id"`
	Author                 string                    `json:"author"`
	Mode                   string                    `json:"mode"`
	ExpectedControlDelta   int64                     `json:"expected_control_delta"`
	ToleranceCents         int64                     `json:"tolerance_cents"`
	IntalevMembers         []structuralControlMember `json:"intalev_members"`
	ERPMembers             []structuralControlMember `json:"erp_members"`
	InventoryBindingSHA256 string                    `json:"inventory_binding_sha256"`
	FixedAt                time.Time                 `json:"fixed_at"`
	PayloadSHA256          string                    `json:"payload_sha256"`
	SourceInventorySchema  string                    `json:"source_inventory_schema,omitempty"`
	ControlOnlyDeclared    bool                      `json:"control_only_declared,omitempty"`
	CorrectionAuthority    bool                      `json:"correction_authority,omitempty"`
}

type structuralControlLifecycleEvent struct {
	EventID        string    `json:"event_id"`
	Action         string    `json:"action"`
	ControlSetID   string    `json:"control_set_id"`
	OrganizationID string    `json:"organization_id"`
	Reason         string    `json:"reason,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	PayloadSHA256  string    `json:"payload_sha256"`
}

type structuralControlRegistry struct {
	SchemaVersion   string                            `json:"schema_version"`
	Revision        int64                             `json:"revision"`
	Drafts          []structuralControlDraft          `json:"drafts"`
	Versions        []structuralControlSetVersion     `json:"versions"`
	LifecycleEvents []structuralControlLifecycleEvent `json:"lifecycle_events"`
}

type structuralControlPreview struct {
	IntalevTotalCents                  int64                        `json:"intalev_total_cents"`
	ERPTotalCents                      int64                        `json:"erp_total_cents"`
	ControlDeltaCents                  int64                        `json:"control_delta_cents"`
	RootEffectiveDeltaCents            int64                        `json:"root_effective_delta_cents"`
	DescendantResidualConsumptionCents int64                        `json:"descendant_residual_consumption_cents"`
	Status                             string                       `json:"status"`
	ControlClassification              string                       `json:"control_classification"`
	PostingClassification              string                       `json:"posting_classification"`
	PhysicalProofStatus                string                       `json:"physical_proof_status"`
	StructuralEffectConsumedOnce       bool                         `json:"structural_effect_consumed_once"`
	DescendantInternalChecksActive     bool                         `json:"descendant_internal_checks_active"`
	IntergroupSearchRequired           bool                         `json:"intergroup_search_required"`
	CorrectionAuthority                bool                         `json:"correction_authority"`
	FinancialRows                      int                          `json:"financial_rows"`
	PostingRows                        int                          `json:"posting_rows"`
	Safety                             structuralControlSafetyState `json:"safety"`
}

type structuralControlSafetyState struct {
	Mode                string `json:"mode"`
	ReportOnly          bool   `json:"report_only"`
	PostingRows         int    `json:"posting_rows"`
	ExecutedPostingRows int    `json:"executed_posting_rows"`
	LivePostingRows     int    `json:"live_posting_rows"`
	ExecutionAllowed    bool   `json:"execution_allowed"`
	ReadyToUpload       bool   `json:"ready_to_upload"`
	ReleaseAllowed      bool   `json:"release_allowed"`
	Live1CAllowed       bool   `json:"live_1c_allowed"`
	LiveDeleteAllowed   bool   `json:"live_delete_allowed"`
}

func structuralControlReportOnlySafety() structuralControlSafetyState {
	return structuralControlSafetyState{
		Mode: "REPORT_ONLY", ReportOnly: true, PostingRows: 0,
		ExecutedPostingRows: 0, LivePostingRows: 0, ExecutionAllowed: false,
		ReadyToUpload: false, ReleaseAllowed: false, Live1CAllowed: false,
		LiveDeleteAllowed: false,
	}
}

type structuralControlMemberRef struct {
	Identity      string  `json:"identity"`
	AmountCents   float64 `json:"amount_cents,omitempty"`
	Name          string  `json:"name,omitempty"`
	HierarchyPath string  `json:"hierarchy_path,omitempty"`
}

type structuralControlSelectionRequest struct {
	Name                     string                       `json:"name,omitempty"`
	OrganizationID           string                       `json:"organization_id"`
	RunID                    string                       `json:"run_id"`
	InventoryID              string                       `json:"inventory_id"`
	Author                   string                       `json:"author,omitempty"`
	Mode                     string                       `json:"mode"`
	ExpectedControlDelta     float64                      `json:"expected_control_delta"`
	ToleranceCents           float64                      `json:"tolerance_cents"`
	IntalevMembers           []structuralControlMemberRef `json:"intalev_members"`
	ERPMembers               []structuralControlMemberRef `json:"erp_members"`
	ExpectedRegistryRevision int64                        `json:"expected_registry_revision,omitempty"`
	SourceControlSetID       string                       `json:"source_control_set_id,omitempty"`
	LineageID                string                       `json:"lineage_id,omitempty"`
	ReadyToUpload            bool                         `json:"ready_to_upload,omitempty"`
	ReleaseAllowed           bool                         `json:"release_allowed,omitempty"`
	Live1CAllowed            bool                         `json:"live_1c_allowed,omitempty"`
	ControlOnlyDeclaration   bool                         `json:"control_only_declaration,omitempty"`
}

type structuralControlFixRequest struct {
	DraftID                  string `json:"draft_id"`
	OrganizationID           string `json:"organization_id"`
	RunID                    string `json:"run_id"`
	InventoryID              string `json:"inventory_id"`
	ExpectedRegistryRevision int64  `json:"expected_registry_revision"`
}

type structuralControlDisableRequest struct {
	ControlSetID             string `json:"control_set_id"`
	OrganizationID           string `json:"organization_id"`
	RunID                    string `json:"run_id"`
	InventoryID              string `json:"inventory_id"`
	Reason                   string `json:"reason"`
	ExpectedRegistryRevision int64  `json:"expected_registry_revision"`
}

type structuralControlFailure struct {
	status int
	code   string
}

func (failure structuralControlFailure) Error() string { return failure.code }

func structuralControlFail(status int, code string) error {
	return structuralControlFailure{status: status, code: code}
}

func writeStructuralControlError(w http.ResponseWriter, err error) {
	var failure structuralControlFailure
	if errors.As(err, &failure) {
		writeJSON(w, failure.status, apiError{Error: failure.code})
		return
	}
	writeJSON(w, http.StatusInternalServerError, apiError{Error: "STRUCTURAL_CONTROL_INTERNAL_ERROR"})
}

func (s *Server) handleStructuralControlSets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleStructuralControlSetList(w, r)
	case http.MethodPost:
		s.handleStructuralControlSetDraft(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleStructuralControlSetList(w http.ResponseWriter, r *http.Request) {
	organizationID := cleanBusinessText(r.URL.Query().Get("organization_id"), 200)
	runID := cleanBusinessText(r.URL.Query().Get("run_id"), 200)
	inventoryID := cleanBusinessText(r.URL.Query().Get("inventory_id"), 200)
	if organizationID == "" || inventoryID == "" {
		binding, err := s.discoverStructuralControlBinding(runID)
		if err != nil {
			writeStructuralControlError(w, err)
			return
		}
		if organizationID == "" {
			organizationID = binding.OrganizationID
		}
		if inventoryID == "" {
			inventoryID = binding.InventoryID
		}
	}
	inventory, _, err := s.loadStructuralControlInventory(organizationID, runID, inventoryID)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	unlock, err := s.lockStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.structuralControlPublicRegistry(registry, inventory))
}

func (s *Server) discoverStructuralControlBinding(runID string) (structuralControlInventoryBinding, error) {
	binding, _, _, _, _, err := s.loadStructuralControlBinding(runID)
	return binding, err
}

func (s *Server) handleStructuralControlSetDraft(w http.ResponseWriter, r *http.Request) {
	var request structuralControlSelectionRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_REQUEST_INVALID"})
		return
	}
	if request.ReadyToUpload || request.ReleaseAllowed || request.Live1CAllowed {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_UNSAFE_AUTHORITY"})
		return
	}
	if err := s.ensureStructuralControlContextScope(request.OrganizationID, request.RunID); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	inventory, bindingSHA, err := s.loadStructuralControlInventory(request.OrganizationID, request.RunID, request.InventoryID)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if inventory.SchemaVersion == structuralControlInventorySchemaV3 && !request.ControlOnlyDeclaration {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_DECLARATION_REQUIRED"})
		return
	}
	boundIntalev, boundERP, tolerance, err := validateStructuralControlSelection(request, inventory)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if _, err := makeStructuralControlPreview(boundIntalev, boundERP, tolerance); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	name := cleanBusinessText(request.Name, 200)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_NAME_REQUIRED"})
		return
	}
	author := "Локальный пользователь"

	unlock, err := s.lockStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_REGISTRY_REVISION_CONFLICT"})
		return
	}
	lineageID := cleanBusinessText(request.LineageID, 200)
	sourceID := cleanBusinessText(request.SourceControlSetID, 200)
	if lineageID != "" && sourceID == "" {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_SOURCE_VERSION_MISMATCH"})
		return
	}
	if sourceID != "" {
		source, ok := structuralControlVersion(registry, sourceID)
		if !ok || source.OrganizationID != request.OrganizationID || (lineageID != "" && lineageID != source.LineageID) {
			writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_SOURCE_VERSION_MISMATCH"})
			return
		}
		lineageID = source.LineageID
	}
	if lineageID == "" {
		lineageID, err = newOpaqueID("sc_lineage")
		if err != nil {
			writeStructuralControlError(w, err)
			return
		}
	}
	draftID, err := newOpaqueID("sc_draft")
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	draft := structuralControlDraft{
		DraftID: draftID, SourceControlSetID: sourceID, LineageID: lineageID,
		Name: name, OrganizationID: inventory.Organization.ID, OrganizationName: inventory.Organization.Name,
		RunID: inventory.RunID, ContextID: inventory.ContextID, InventoryID: inventory.InventoryID,
		Author: author, Mode: "SUM_DELTA_ONLY", ExpectedControlDelta: 0, ToleranceCents: tolerance,
		IntalevMembers: boundIntalev, ERPMembers: boundERP, InventoryBindingSHA256: bindingSHA,
		CreatedAt: time.Now().UTC(), SourceInventorySchema: inventory.SchemaVersion,
		ControlOnlyDeclared: inventory.SchemaVersion == structuralControlInventorySchemaV3,
		CorrectionAuthority: false,
	}
	draft.PayloadSHA256, err = structuralControlDraftSHA(draft)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	registry.Drafts = append(registry.Drafts, draft)
	registry.Revision++
	if err := s.saveStructuralControlRegistry(registry); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"draft": structuralControlPublicDraftWithCalculation(draft), "registry_revision": registry.Revision,
		"safety": structuralControlReportOnlySafety(),
	})
}

func (s *Server) handleStructuralControlSetPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request structuralControlSelectionRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_REQUEST_INVALID"})
		return
	}
	if request.ReadyToUpload || request.ReleaseAllowed || request.Live1CAllowed {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_UNSAFE_AUTHORITY"})
		return
	}
	if err := s.ensureStructuralControlContextScope(request.OrganizationID, request.RunID); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	inventory, _, err := s.loadStructuralControlInventory(request.OrganizationID, request.RunID, request.InventoryID)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	intalev, erp, tolerance, err := validateStructuralControlSelection(request, inventory)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	preview, err := makeStructuralControlPreview(intalev, erp, tolerance)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func (s *Server) handleStructuralControlSetFix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request structuralControlFixRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_REQUEST_INVALID"})
		return
	}
	if err := s.ensureStructuralControlContextScope(request.OrganizationID, request.RunID); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	inventory, bindingSHA, err := s.loadStructuralControlInventory(request.OrganizationID, request.RunID, request.InventoryID)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	unlock, err := s.lockStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_REGISTRY_REVISION_CONFLICT"})
		return
	}
	draftIndex := -1
	var draft structuralControlDraft
	for index, candidate := range registry.Drafts {
		if candidate.DraftID == cleanBusinessText(request.DraftID, 200) {
			draftIndex, draft = index, candidate
			break
		}
	}
	if draftIndex < 0 {
		writeJSON(w, http.StatusNotFound, apiError{Error: "STRUCTURAL_CONTROL_DRAFT_NOT_FOUND"})
		return
	}
	if draft.OrganizationID != inventory.Organization.ID || draft.RunID != inventory.RunID ||
		draft.InventoryID != inventory.InventoryID || draft.ContextID != inventory.ContextID ||
		draft.InventoryBindingSHA256 != bindingSHA ||
		(draft.SourceInventorySchema != "" && draft.SourceInventorySchema != inventory.SchemaVersion) ||
		(inventory.SchemaVersion == structuralControlInventorySchemaV3 && (!draft.ControlOnlyDeclared || draft.CorrectionAuthority)) {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_DRAFT_SCOPE_STALE"})
		return
	}
	intalev, err := bindStructuralControlMembers(memberRefsFromMembers(draft.IntalevMembers), inventory.IntalevMembers, "INTALEV")
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	erp, err := bindStructuralControlMembers(memberRefsFromMembers(draft.ERPMembers), inventory.ERPMembers, "ERP")
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if structuralControlOverlap(registry, draft.LineageID, draft.OrganizationID, draft.RunID, draft.ContextID, draft.InventoryID, intalev, erp) {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_SET_MEMBER_OVERLAP"})
		return
	}
	if _, err := makeStructuralControlPreview(intalev, erp, draft.ToleranceCents); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	controlSetID, err := newOpaqueID("sc_set")
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	versionNumber := 1
	for _, version := range registry.Versions {
		if version.OrganizationID == draft.OrganizationID && version.LineageID == draft.LineageID && version.Version >= versionNumber {
			versionNumber = version.Version + 1
		}
	}
	version := structuralControlSetVersion{
		ControlSetID: controlSetID, LineageID: draft.LineageID, Version: versionNumber,
		Name: draft.Name, OrganizationID: draft.OrganizationID, OrganizationName: draft.OrganizationName,
		RunID: draft.RunID, ContextID: draft.ContextID, InventoryID: draft.InventoryID,
		Author: draft.Author, Mode: draft.Mode, ExpectedControlDelta: 0, ToleranceCents: draft.ToleranceCents,
		IntalevMembers: intalev, ERPMembers: erp, InventoryBindingSHA256: bindingSHA,
		FixedAt: time.Now().UTC(), SourceInventorySchema: inventory.SchemaVersion,
		ControlOnlyDeclared: draft.ControlOnlyDeclared, CorrectionAuthority: false,
	}
	version.PayloadSHA256, err = structuralControlPayloadSHA(version)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if previous := structuralControlActiveLineageVersion(registry, version.OrganizationID, version.RunID, version.ContextID, version.InventoryID, version.LineageID); previous != "" {
		event, eventErr := newStructuralControlEvent("SUPERSEDED", previous, version.OrganizationID, "Новая версия настройки")
		if eventErr != nil {
			writeStructuralControlError(w, eventErr)
			return
		}
		registry.LifecycleEvents = append(registry.LifecycleEvents, event)
	}
	registry.Versions = append(registry.Versions, version)
	fixedEvent, err := newStructuralControlEvent("FIXED", version.ControlSetID, version.OrganizationID, "Версия настройки зафиксирована")
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	registry.LifecycleEvents = append(registry.LifecycleEvents, fixedEvent)
	registry.Drafts = append(registry.Drafts[:draftIndex], registry.Drafts[draftIndex+1:]...)
	registry.Revision++
	if err := s.saveStructuralControlRegistry(registry); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"fixed_version":     structuralControlPublicVersionWithCalculation(version, true),
		"registry_revision": registry.Revision, "safety": structuralControlReportOnlySafety(),
	})
}

func (s *Server) handleStructuralControlSetDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request structuralControlDisableRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_REQUEST_INVALID"})
		return
	}
	if err := s.ensureStructuralControlContextScope(request.OrganizationID, request.RunID); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	inventory, bindingSHA, err := s.loadStructuralControlInventory(request.OrganizationID, request.RunID, request.InventoryID)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	unlock, err := s.lockStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadStructuralControlRegistry()
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_REGISTRY_REVISION_CONFLICT"})
		return
	}
	version, ok := structuralControlVersion(registry, cleanBusinessText(request.ControlSetID, 200))
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "STRUCTURAL_CONTROL_SET_NOT_FOUND"})
		return
	}
	if !structuralControlVersionMatchesInventory(version, inventory) || version.InventoryBindingSHA256 != bindingSHA {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_SET_SCOPE_MISMATCH"})
		return
	}
	if !structuralControlActiveVersions(registry)[version.ControlSetID] {
		writeJSON(w, http.StatusConflict, apiError{Error: "STRUCTURAL_CONTROL_SET_NOT_ACTIVE"})
		return
	}
	reason := cleanBusinessText(request.Reason, 500)
	if reason == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "STRUCTURAL_CONTROL_DISABLE_REASON_REQUIRED"})
		return
	}
	event, err := newStructuralControlEvent("DISABLED", version.ControlSetID, version.OrganizationID, reason)
	if err != nil {
		writeStructuralControlError(w, err)
		return
	}
	registry.LifecycleEvents = append(registry.LifecycleEvents, event)
	registry.Revision++
	if err := s.saveStructuralControlRegistry(registry); err != nil {
		writeStructuralControlError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "DISABLED", "control_set_id": version.ControlSetID,
		"registry_revision": registry.Revision, "safety": structuralControlReportOnlySafety(),
	})
}

func (s *Server) ensureStructuralControlContextScope(organizationID, runID string) error {
	run, ok := s.store.Run(cleanBusinessText(runID, 200))
	if !ok {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_RUN_MISMATCH")
	}
	contextValue, ok := s.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_RUN_MISMATCH")
	}
	if contextValue.OrganizationID == "" {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_CONTEXT_ORGANIZATION_ID_REQUIRED")
	}
	if contextValue.OrganizationID != cleanBusinessText(organizationID, 200) {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_ORGANIZATION_MISMATCH")
	}
	return nil
}

func (s *Server) loadStructuralControlInventory(organizationID, runID, inventoryID string) (structuralControlInventory, string, error) {
	organizationID = cleanBusinessText(organizationID, 200)
	runID = cleanBusinessText(runID, 200)
	inventoryID = cleanBusinessText(inventoryID, 200)
	binding, run, contextValue, r005Dir, bindingSHA, err := s.loadStructuralControlBinding(runID)
	if err != nil {
		return structuralControlInventory{}, "", err
	}
	if organizationID == "" || binding.OrganizationID != organizationID {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_ORGANIZATION_MISMATCH")
	}
	if inventoryID == "" || binding.InventoryID != inventoryID {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_MISMATCH")
	}
	base, err := secureBaseName(binding.InventoryFile)
	if err != nil || base != binding.InventoryFile || !validSHA256(binding.SHA256) {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	inventoryPath := filepath.Join(r005Dir, base)
	inventoryBytes, err := readStructuralControlArtifact(r005Dir, inventoryPath, 16<<20)
	if err != nil {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_STALE")
	}
	digest := sha256.Sum256(inventoryBytes)
	actualSHA := strings.ToUpper(hex.EncodeToString(digest[:]))
	if !strings.EqualFold(actualSHA, binding.SHA256) {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_STALE")
	}
	inventory, err := decodeStructuralControlInventory(inventoryBytes)
	if err != nil {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	if !structuralControlBindingMatchesInventorySchema(binding.SchemaVersion, inventory.SchemaVersion) ||
		inventory.ArtifactType != "STRUCTURAL_CONTROL_INVENTORY" || inventory.Status != "VERIFIED" ||
		inventory.RunID != run.ID || inventory.ContextID != contextValue.ID || inventory.InventoryID != binding.InventoryID ||
		inventory.Organization.ID != binding.OrganizationID || inventory.Organization.Name != binding.OrganizationName ||
		inventory.Organization.Path != binding.OrganizationPath || inventory.Safety != reportOnlySafety() ||
		inventory.Period != contextValue.Period || inventory.HierarchyVersions.Intalev == "" || inventory.HierarchyVersions.ERP == "" {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	if contextValue.OrganizationID == "" || inventory.Organization.ID != contextValue.OrganizationID ||
		inventory.Organization.Name != contextValue.OrganizationName || inventory.Organization.Path != contextValue.OrganizationPath {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_CONTEXT_ORGANIZATION_ID_REQUIRED")
	}
	if err := validateStructuralControlInventoryV2(inventory, binding, r005Dir, run, contextValue); err != nil {
		return structuralControlInventory{}, "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	if err := validateStructuralControlInventoryMembers(inventory.IntalevMembers); err != nil {
		return structuralControlInventory{}, "", err
	}
	if err := validateStructuralControlInventoryMembers(inventory.ERPMembers); err != nil {
		return structuralControlInventory{}, "", err
	}
	return inventory, bindingSHA, nil
}

func (s *Server) loadStructuralControlBinding(runID string) (structuralControlInventoryBinding, Run, Context, string, string, error) {
	runID = cleanBusinessText(runID, 200)
	run, ok := s.store.Run(runID)
	if !ok || run.Status != RunCompletedReportOnly {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_RUN_MISMATCH")
	}
	contextValue, ok := s.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_RUN_MISMATCH")
	}
	anchor, ok := s.store.StructuralControlInventoryAnchor(run.ID)
	if !ok || !validSHA256(anchor.BindingSHA256) {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	r005Dir := filepath.Join(s.store.RunsDir(), run.ID, "r005")
	bindingPath := filepath.Join(r005Dir, "structural-control-inventory.binding.json")
	bindingBytes, err := readStructuralControlArtifact(r005Dir, bindingPath, 1<<20)
	if err != nil {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNAVAILABLE")
	}
	digest := sha256.Sum256(bindingBytes)
	bindingSHA := strings.ToUpper(hex.EncodeToString(digest[:]))
	if !strings.EqualFold(anchor.BindingSHA256, bindingSHA) {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_STALE")
	}
	binding, err := decodeStructuralControlBinding(bindingBytes)
	if err != nil {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	if (binding.SchemaVersion != structuralControlBindingSchema && binding.SchemaVersion != structuralControlBindingSchemaV3) ||
		binding.ArtifactType != "STRUCTURAL_CONTROL_INVENTORY" ||
		!binding.Verified || binding.RunID != run.ID || binding.ContextID != contextValue.ID ||
		binding.OrganizationID == "" || binding.InventoryID == "" || binding.OrganizationID != contextValue.OrganizationID ||
		binding.OrganizationName != contextValue.OrganizationName || binding.OrganizationPath != contextValue.OrganizationPath ||
		binding.Period != contextValue.Period || binding.InventoryFile != "structural-control-inventory.json" ||
		!validUpperSHA256(binding.SHA256) || !validUpperSHA256(binding.CurrentRunProvenanceSHA256) || binding.Safety != reportOnlySafety() {
		return structuralControlInventoryBinding{}, Run{}, Context{}, "", "", structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	return binding, run, contextValue, r005Dir, bindingSHA, nil
}

func readStructuralControlArtifact(root, path string, limit int64) ([]byte, error) {
	file, err := openStructuralControlArtifact(root, path, limit)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("structural artifact exceeds size limit")
	}
	return data, nil
}

func sha256StructuralControlArtifact(root, path string, limit int64) (string, error) {
	file, err := openStructuralControlArtifact(root, path, limit)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, io.LimitReader(file, limit+1)); err != nil {
		return "", err
	}
	return strings.ToUpper(hex.EncodeToString(digest.Sum(nil))), nil
}

func openStructuralControlArtifact(root, path string, limit int64) (*os.File, error) {
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
		return nil, errors.New("structural artifact escaped run directory")
	}
	if err := rejectReparsePathComponents(cleanRoot); err != nil {
		return nil, fmt.Errorf("structural run root is unsafe: %w", err)
	}
	if err := rejectReparsePathComponents(cleanPath); err != nil {
		return nil, fmt.Errorf("structural artifact path is unsafe: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(cleanRoot)
	if err != nil || !sameFilesystemPath(resolvedRoot, cleanRoot) {
		return nil, errors.New("structural run root is not canonical")
	}
	resolvedPath, err := filepath.EvalSymlinks(cleanPath)
	if err != nil || !sameFilesystemPath(resolvedPath, cleanPath) {
		return nil, errors.New("structural artifact path is not canonical")
	}
	info, err := os.Lstat(cleanPath)
	if err != nil || !isBoundedStructuralControlArtifact(info.Mode(), info.Size(), limit) {
		return nil, errors.New("structural artifact is not a bounded regular file")
	}
	file, err := os.Open(cleanPath)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func sameFilesystemPath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if filepath.Separator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func rejectReparsePathComponents(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	absolute = filepath.Clean(absolute)
	volume := filepath.VolumeName(absolute)
	root := volume + string(os.PathSeparator)
	if volume == "" {
		root = string(os.PathSeparator)
	}
	relative, err := filepath.Rel(root, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return errors.New("path is outside its volume root")
	}
	current := root
	if relative == "." {
		return nil
	}
	for _, component := range strings.Split(relative, string(os.PathSeparator)) {
		if component == "" || component == "." || component == ".." {
			return errors.New("path contains an invalid component")
		}
		current = filepath.Join(current, component)
		reparse, err := pathIsReparsePoint(current)
		if err != nil {
			return err
		}
		if reparse {
			return errors.New("path contains a symlink, junction or reparse point")
		}
	}
	return nil
}

func isBoundedStructuralControlArtifact(mode os.FileMode, size, limit int64) bool {
	return mode&os.ModeSymlink == 0 && mode.IsRegular() && size >= 0 && size <= limit
}

func validateStructuralControlInventoryMembers(members []structuralControlMember) error {
	if len(members) == 0 {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
	}
	seen := map[string]bool{}
	for index, member := range members {
		v2Root := member.SelectableRoot && !member.CandidateSelectable
		v3Candidate := !member.SelectableRoot && member.CandidateSelectable && member.ParentIdentity != "" &&
			member.SemanticStatus == structuralControlUnprovenSemantic && !member.BusinessBlockDeclared &&
			member.RequiresUserDeclaration && !member.CorrectionAuthority
		if strings.TrimSpace(member.Identity) == "" ||
			strings.TrimSpace(member.Name) == "" || strings.TrimSpace(member.HierarchyPath) == "" ||
			seen[member.Identity] || (!v2Root && !v3Candidate) || member.Ambiguous || member.SourceOrder != index {
			return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED")
		}
		seen[member.Identity] = true
	}
	return nil
}

func validateStructuralControlSelection(request structuralControlSelectionRequest, inventory structuralControlInventory) ([]structuralControlMember, []structuralControlMember, int64, error) {
	if request.Mode != "SUM_DELTA_ONLY" {
		return nil, nil, 0, structuralControlFail(http.StatusBadRequest, "STRUCTURAL_CONTROL_MODE_INVALID")
	}
	if request.ExpectedControlDelta != 0 {
		return nil, nil, 0, structuralControlFail(http.StatusBadRequest, "STRUCTURAL_CONTROL_EXPECTED_DELTA_INVALID")
	}
	if math.IsNaN(request.ToleranceCents) || math.IsInf(request.ToleranceCents, 0) || request.ToleranceCents < 0 ||
		math.Trunc(request.ToleranceCents) != request.ToleranceCents || request.ToleranceCents >= math.Exp2(63) {
		return nil, nil, 0, structuralControlFail(http.StatusBadRequest, "STRUCTURAL_CONTROL_TOLERANCE_CENTS_INVALID")
	}
	intalev, err := bindStructuralControlMembers(request.IntalevMembers, inventory.IntalevMembers, "INTALEV")
	if err != nil {
		return nil, nil, 0, err
	}
	erp, err := bindStructuralControlMembers(request.ERPMembers, inventory.ERPMembers, "ERP")
	if err != nil {
		return nil, nil, 0, err
	}
	return intalev, erp, int64(request.ToleranceCents), nil
}

func bindStructuralControlMembers(refs []structuralControlMemberRef, inventory []structuralControlMember, side string) ([]structuralControlMember, error) {
	if len(refs) == 0 {
		return nil, structuralControlFail(http.StatusBadRequest, "STRUCTURAL_CONTROL_"+side+"_MEMBERS_REQUIRED")
	}
	byID := make(map[string]structuralControlMember, len(inventory))
	for _, member := range inventory {
		byID[member.Identity] = member
	}
	seen := map[string]bool{}
	bound := make([]structuralControlMember, 0, len(refs))
	for _, ref := range refs {
		identity := cleanBusinessText(ref.Identity, 200)
		if seen[identity] {
			return nil, structuralControlFail(http.StatusBadRequest, "STRUCTURAL_CONTROL_MEMBER_DUPLICATE")
		}
		seen[identity] = true
		member, ok := byID[identity]
		if !ok || (!member.SelectableRoot && !member.CandidateSelectable) || member.Ambiguous {
			return nil, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_MEMBER_UNKNOWN")
		}
		bound = append(bound, member)
	}
	sort.Slice(bound, func(i, j int) bool { return bound[i].Identity < bound[j].Identity })
	return bound, nil
}

func memberRefsFromMembers(members []structuralControlMember) []structuralControlMemberRef {
	refs := make([]structuralControlMemberRef, 0, len(members))
	for _, member := range members {
		refs = append(refs, structuralControlMemberRef{Identity: member.Identity})
	}
	return refs
}

func makeStructuralControlPreview(intalev, erp []structuralControlMember, tolerance int64) (structuralControlPreview, error) {
	var intalevTotal, erpTotal int64
	for _, member := range intalev {
		if (member.AmountCents > 0 && intalevTotal > math.MaxInt64-member.AmountCents) ||
			(member.AmountCents < 0 && intalevTotal < math.MinInt64-member.AmountCents) {
			return structuralControlPreview{}, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_AMOUNT_OVERFLOW")
		}
		intalevTotal += member.AmountCents
	}
	for _, member := range erp {
		if (member.AmountCents > 0 && erpTotal > math.MaxInt64-member.AmountCents) ||
			(member.AmountCents < 0 && erpTotal < math.MinInt64-member.AmountCents) {
			return structuralControlPreview{}, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_AMOUNT_OVERFLOW")
		}
		erpTotal += member.AmountCents
	}
	if (erpTotal < 0 && intalevTotal > math.MaxInt64+erpTotal) || (erpTotal > 0 && intalevTotal < math.MinInt64+erpTotal) {
		return structuralControlPreview{}, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_AMOUNT_OVERFLOW")
	}
	delta := intalevTotal - erpTotal
	absDelta := delta
	if absDelta < 0 {
		if absDelta == math.MinInt64 {
			return structuralControlPreview{}, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_AMOUNT_OVERFLOW")
		}
		absDelta = -absDelta
	}
	status := "INTER_GROUP_RECLASS_OPEN"
	closed := absDelta <= tolerance
	if closed {
		status = "INTRA_CONTROL_SET_RECLASS_CLOSED"
	}
	rootEffectiveDelta := delta
	if closed {
		rootEffectiveDelta = 0
	}
	return structuralControlPreview{
		IntalevTotalCents: intalevTotal, ERPTotalCents: erpTotal,
		ControlDeltaCents: delta, RootEffectiveDeltaCents: rootEffectiveDelta,
		DescendantResidualConsumptionCents: 0, Status: status,
		ControlClassification: "CONTROL_ONLY", PostingClassification: "NON_POSTING",
		PhysicalProofStatus: "UNPROVEN", StructuralEffectConsumedOnce: closed,
		DescendantInternalChecksActive: true, IntergroupSearchRequired: !closed,
		CorrectionAuthority: false, FinancialRows: 0, PostingRows: 0,
		Safety: structuralControlReportOnlySafety(),
	}, nil
}

func (s *Server) structuralControlRegistryPath() string {
	return filepath.Join(s.store.Root(), "structural-control-sets.json")
}

func (s *Server) loadStructuralControlRegistry() (structuralControlRegistry, error) {
	registry := structuralControlRegistry{
		SchemaVersion: structuralControlRegistrySchema,
		Drafts:        []structuralControlDraft{}, Versions: []structuralControlSetVersion{},
		LifecycleEvents: []structuralControlLifecycleEvent{},
	}
	path := s.structuralControlRegistryPath()
	data, err := readStructuralControlArtifact(s.store.Root(), path, 16<<20)
	if errors.Is(err, os.ErrNotExist) {
		return registry, nil
	}
	if err != nil {
		return registry, err
	}
	if err := decodeExactJSON(data, &registry); err != nil || registry.SchemaVersion != structuralControlRegistrySchema || registry.Revision < 0 {
		return structuralControlRegistry{}, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_INVALID")
	}
	if registry.Drafts == nil {
		registry.Drafts = []structuralControlDraft{}
	}
	if registry.Versions == nil {
		registry.Versions = []structuralControlSetVersion{}
	}
	if registry.LifecycleEvents == nil {
		registry.LifecycleEvents = []structuralControlLifecycleEvent{}
	}
	if err := validateStructuralControlRegistry(registry); err != nil {
		return structuralControlRegistry{}, err
	}
	return registry, nil
}

func (s *Server) saveStructuralControlRegistry(registry structuralControlRegistry) error {
	if err := validateStructuralControlRegistry(registry); err != nil {
		return err
	}
	path := s.structuralControlRegistryPath()
	if err := atomicWritePrivateJSON(path, registry); err != nil {
		return err
	}
	verified, err := s.loadStructuralControlRegistry()
	if err != nil || verified.Revision != registry.Revision {
		return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_COMMIT_UNVERIFIED")
	}
	return nil
}

func structuralControlVersion(registry structuralControlRegistry, id string) (structuralControlSetVersion, bool) {
	for _, version := range registry.Versions {
		if version.ControlSetID == id {
			return version, true
		}
	}
	return structuralControlSetVersion{}, false
}

func structuralControlActiveVersions(registry structuralControlRegistry) map[string]bool {
	active := make(map[string]bool, len(registry.Versions))
	for _, version := range registry.Versions {
		active[version.ControlSetID] = true
	}
	for _, event := range registry.LifecycleEvents {
		if event.Action == "DISABLED" || event.Action == "SUPERSEDED" {
			active[event.ControlSetID] = false
		}
	}
	return active
}

const structuralControlRecentProjectionLimit = 8

func structuralControlRunIsActive(run Run) bool {
	return run.Status == RunQueued || run.Status == RunPreflight || run.Status == RunRunning
}

// structuralControlProjectionRunIDs bounds expensive filesystem-backed proof
// verification for collection endpoints. The store already orders runs newest
// first. All executing runs are included even when they are older than the
// recent window; an exact run endpoint supplies exactRunID and projects that
// run regardless of age.
func structuralControlProjectionRunIDs(runs []Run, exactRunID string) map[string]bool {
	selected := map[string]bool{}
	if exactRunID != "" {
		selected[exactRunID] = true
		return selected
	}
	for index, run := range runs {
		if index < structuralControlRecentProjectionLimit || structuralControlRunIsActive(run) {
			selected[run.ID] = true
		}
	}
	return selected
}

func (s *Server) snapshotWithStructuralControlSets() (Snapshot, error) {
	return s.snapshotWithStructuralControlSetsForRun("")
}

func (s *Server) snapshotWithStructuralControlSetsForRun(exactRunID string) (Snapshot, error) {
	snapshot := s.store.Snapshot(s.pipeline.Ready())
	selected := structuralControlProjectionRunIDs(snapshot.Runs, exactRunID)
	needsRegistry := false
	for index := range snapshot.Runs {
		if !selected[snapshot.Runs[index].ID] {
			// nil deliberately means deferred projection. The run and its
			// inventory flag remain visible; /api/runs/{id} verifies it fully.
			snapshot.Runs[index].StructuralControlSets = nil
			continue
		}
		snapshot.Runs[index].StructuralControlSets = []StructuralControlSetReference{}
		if snapshot.Runs[index].HasStructuralInventory {
			needsRegistry = true
		}
	}
	if !needsRegistry {
		return snapshot, nil
	}
	unlock, err := s.lockStructuralControlRegistry()
	if err != nil {
		return Snapshot{}, err
	}
	defer unlock()
	registry, err := s.loadStructuralControlRegistry()
	if err != nil {
		return Snapshot{}, err
	}
	active := structuralControlActiveVersions(registry)
	versionsByRunID := make(map[string][]structuralControlSetVersion, len(registry.Versions))
	for _, version := range registry.Versions {
		versionsByRunID[version.RunID] = append(versionsByRunID[version.RunID], version)
	}
	for index := range snapshot.Runs {
		run := snapshot.Runs[index]
		if !selected[run.ID] {
			continue
		}
		references := []StructuralControlSetReference{}
		if run.HasStructuralInventory {
			binding, bindingRun, contextValue, _, bindingSHA, loadErr := s.loadStructuralControlBinding(run.ID)
			if loadErr != nil {
				snapshot.Runs[index].HasStructuralInventory = false
			} else if inventory, verifiedBindingSHA, loadErr := s.loadStructuralControlInventory(binding.OrganizationID, run.ID, binding.InventoryID); loadErr != nil || verifiedBindingSHA != bindingSHA {
				snapshot.Runs[index].HasStructuralInventory = false
			} else {
				for _, version := range versionsByRunID[run.ID] {
					if !structuralControlVersionMatchesRun(version, bindingRun, contextValue) ||
						!structuralControlVersionMatchesInventory(version, inventory) || version.InventoryBindingSHA256 != bindingSHA {
						continue
					}
					status := "INACTIVE"
					if active[version.ControlSetID] {
						status = "FIXED"
					}
					references = append(references, structuralControlRunReference(version, status))
				}
			}
		}
		snapshot.Runs[index].StructuralControlSets = references
	}
	return snapshot, nil
}

func structuralControlRunReference(version structuralControlSetVersion, status string) StructuralControlSetReference {
	return StructuralControlSetReference{
		ControlSetID: version.ControlSetID, LineageID: version.LineageID,
		Version: version.Version, Name: version.Name,
		OrganizationID: version.OrganizationID, OrganizationName: version.OrganizationName,
		ContextID: version.ContextID, RunID: version.RunID, InventoryID: version.InventoryID,
		Author: version.Author, Mode: version.Mode, FixedAt: version.FixedAt, Status: status,
	}
}

func structuralControlVersionMatchesRun(version structuralControlSetVersion, run Run, contextValue Context) bool {
	return version.OrganizationID != "" && version.RunID == run.ID && version.ContextID == run.ContextID &&
		contextValue.ID == run.ContextID && contextValue.OrganizationID != "" &&
		version.OrganizationID == contextValue.OrganizationID
}

func structuralControlVersionMatchesInventory(version structuralControlSetVersion, inventory structuralControlInventory) bool {
	return version.OrganizationID == inventory.Organization.ID && version.RunID == inventory.RunID &&
		version.ContextID == inventory.ContextID && version.InventoryID == inventory.InventoryID
}

func structuralControlActiveLineageVersion(registry structuralControlRegistry, organizationID, runID, contextID, inventoryID, lineageID string) string {
	active := structuralControlActiveVersions(registry)
	latest := structuralControlSetVersion{}
	for _, version := range registry.Versions {
		if version.OrganizationID == organizationID && version.RunID == runID && version.ContextID == contextID &&
			version.InventoryID == inventoryID && version.LineageID == lineageID && active[version.ControlSetID] && version.Version >= latest.Version {
			latest = version
		}
	}
	return latest.ControlSetID
}

func structuralControlOverlap(registry structuralControlRegistry, lineageID, organizationID, runID, contextID, inventoryID string, intalev, erp []structuralControlMember) bool {
	wanted := map[string]bool{}
	for _, member := range intalev {
		wanted["I:"+member.Identity] = true
	}
	for _, member := range erp {
		wanted["E:"+member.Identity] = true
	}
	active := structuralControlActiveVersions(registry)
	for _, version := range registry.Versions {
		if !active[version.ControlSetID] || version.OrganizationID != organizationID || version.RunID != runID ||
			version.ContextID != contextID || version.InventoryID != inventoryID || version.LineageID == lineageID {
			continue
		}
		for _, member := range version.IntalevMembers {
			if wanted["I:"+member.Identity] {
				return true
			}
		}
		for _, member := range version.ERPMembers {
			if wanted["E:"+member.Identity] {
				return true
			}
		}
	}
	return false
}

func structuralControlPayloadSHA(version structuralControlSetVersion) (string, error) {
	version.PayloadSHA256 = ""
	payload := structuralControlPublicVersion(version, false)
	payload["inventory_binding_sha256"] = version.InventoryBindingSHA256
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func structuralControlDraftSHA(draft structuralControlDraft) (string, error) {
	draft.PayloadSHA256 = ""
	encoded, err := json.Marshal(draft)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func structuralControlEventSHA(event structuralControlLifecycleEvent) (string, error) {
	event.PayloadSHA256 = ""
	encoded, err := json.Marshal(event)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func validateStructuralControlRegistry(registry structuralControlRegistry) error {
	draftIDs := map[string]bool{}
	versionIDs := map[string]bool{}
	eventIDs := map[string]bool{}
	fixedEvents := map[string]int{}
	terminalEvents := map[string]int{}
	lineageVersions := map[string]bool{}
	versionsByID := map[string]structuralControlSetVersion{}
	for _, draft := range registry.Drafts {
		expected, err := structuralControlDraftSHA(draft)
		if err != nil || draft.DraftID == "" || draftIDs[draft.DraftID] || draft.OrganizationID == "" || draft.LineageID == "" ||
			!validSHA256(draft.InventoryBindingSHA256) || !strings.EqualFold(expected, draft.PayloadSHA256) ||
			draft.Mode != "SUM_DELTA_ONLY" || draft.ExpectedControlDelta != 0 || draft.ToleranceCents < 0 ||
			len(draft.IntalevMembers) == 0 || len(draft.ERPMembers) == 0 ||
			!structuralControlStoredAuthorityValid(draft.SourceInventorySchema, draft.ControlOnlyDeclared, draft.CorrectionAuthority) {
			return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_INVALID")
		}
		draftIDs[draft.DraftID] = true
	}
	for _, version := range registry.Versions {
		key := version.OrganizationID + "\x00" + version.LineageID + "\x00" + strconv.Itoa(version.Version)
		expected, err := structuralControlPayloadSHA(version)
		if err != nil || version.ControlSetID == "" || versionIDs[version.ControlSetID] || version.LineageID == "" ||
			version.OrganizationID == "" || version.Version < 1 || lineageVersions[key] || !strings.EqualFold(expected, version.PayloadSHA256) ||
			!structuralControlStoredAuthorityValid(version.SourceInventorySchema, version.ControlOnlyDeclared, version.CorrectionAuthority) {
			return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_INVALID")
		}
		versionIDs[version.ControlSetID] = true
		lineageVersions[key] = true
		versionsByID[version.ControlSetID] = version
	}
	for _, event := range registry.LifecycleEvents {
		version, ok := versionsByID[event.ControlSetID]
		expected, err := structuralControlEventSHA(event)
		if err != nil || event.EventID == "" || eventIDs[event.EventID] || !ok || version.OrganizationID != event.OrganizationID ||
			(event.Action != "FIXED" && event.Action != "DISABLED" && event.Action != "SUPERSEDED") || !strings.EqualFold(expected, event.PayloadSHA256) {
			return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_INVALID")
		}
		eventIDs[event.EventID] = true
		if event.Action == "FIXED" {
			fixedEvents[event.ControlSetID]++
		} else {
			terminalEvents[event.ControlSetID]++
		}
	}
	for controlSetID := range versionsByID {
		if fixedEvents[controlSetID] != 1 || terminalEvents[controlSetID] > 1 {
			return structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_INVALID")
		}
	}
	return nil
}

func structuralControlStoredAuthorityValid(schema string, declared, correctionAuthority bool) bool {
	if correctionAuthority {
		return false
	}
	switch schema {
	case "", structuralControlInventorySchema:
		return !declared
	case structuralControlInventorySchemaV3:
		return declared
	default:
		return false
	}
}

func (s *Server) lockStructuralControlRegistry() (func(), error) {
	structuralControlRegistryMu.Lock()
	lockPath := filepath.Join(s.store.Root(), ".structural-control-registry.lock")
	releaseFileLock, err := acquireStructuralRegistryFileLock(lockPath, 2*time.Second)
	if err != nil {
		structuralControlRegistryMu.Unlock()
		return nil, structuralControlFail(http.StatusConflict, "STRUCTURAL_CONTROL_REGISTRY_BUSY")
	}
	return func() {
		releaseFileLock()
		structuralControlRegistryMu.Unlock()
	}, nil
}

func newStructuralControlEvent(action, controlSetID, organizationID, reason string) (structuralControlLifecycleEvent, error) {
	eventID, err := newOpaqueID("sc_event")
	if err != nil {
		return structuralControlLifecycleEvent{}, err
	}
	event := structuralControlLifecycleEvent{
		EventID: eventID, Action: action, ControlSetID: controlSetID,
		OrganizationID: organizationID, Reason: reason, CreatedAt: time.Now().UTC(),
	}
	event.PayloadSHA256, err = structuralControlEventSHA(event)
	return event, err
}

func structuralControlPublicMember(member structuralControlMember, schema string) map[string]any {
	result := map[string]any{
		"identity": member.Identity, "code": member.Code, "name": member.Name,
		"hierarchy_path": member.HierarchyPath, "amount_cents": member.AmountCents,
	}
	if schema == structuralControlInventorySchemaV3 {
		result["semantic_status"] = structuralControlUnprovenSemantic
		result["candidate_selectable"] = true
		result["business_block_declared"] = false
		result["requires_user_declaration"] = true
		result["correction_authority"] = false
	}
	return result
}

func structuralControlPublicMembers(members []structuralControlMember, schema string) []any {
	result := make([]any, 0, len(members))
	for _, member := range members {
		result = append(result, structuralControlPublicMember(member, schema))
	}
	return result
}

func structuralControlPublicDraft(draft structuralControlDraft) map[string]any {
	result := map[string]any{
		"draft_id": draft.DraftID, "source_control_set_id": draft.SourceControlSetID,
		"lineage_id": draft.LineageID, "name": draft.Name,
		"organization_id": draft.OrganizationID, "organization_name": draft.OrganizationName,
		"run_id": draft.RunID, "context_id": draft.ContextID, "inventory_id": draft.InventoryID,
		"author": draft.Author, "mode": draft.Mode,
		"expected_control_delta": draft.ExpectedControlDelta, "tolerance_cents": draft.ToleranceCents,
		"intalev_members": structuralControlPublicMembers(draft.IntalevMembers, draft.SourceInventorySchema),
		"erp_members":     structuralControlPublicMembers(draft.ERPMembers, draft.SourceInventorySchema), "created_at": draft.CreatedAt,
	}
	if draft.SourceInventorySchema != "" {
		result["source_inventory_schema"] = draft.SourceInventorySchema
		result["control_only_declared"] = draft.ControlOnlyDeclared
		result["correction_authority"] = false
	}
	return result
}

func structuralControlCalculationFields(intalev, erp []structuralControlMember, tolerance int64) map[string]any {
	preview, err := makeStructuralControlPreview(intalev, erp, tolerance)
	if err != nil {
		return map[string]any{"control_status": "BLOCKED_INVALID_CONTROL_TOTAL"}
	}
	return map[string]any{
		"intalev_total_cents":                   preview.IntalevTotalCents,
		"erp_total_cents":                       preview.ERPTotalCents,
		"control_delta_cents":                   preview.ControlDeltaCents,
		"root_effective_delta_cents":            preview.RootEffectiveDeltaCents,
		"control_status":                        preview.Status,
		"control_classification":                preview.ControlClassification,
		"posting_classification":                preview.PostingClassification,
		"physical_proof_status":                 preview.PhysicalProofStatus,
		"structural_effect_consumed_once":       preview.StructuralEffectConsumedOnce,
		"descendant_internal_checks_active":     preview.DescendantInternalChecksActive,
		"descendant_residual_consumption_cents": preview.DescendantResidualConsumptionCents,
		"intergroup_search_required":            preview.IntergroupSearchRequired,
		"correction_authority":                  false, "financial_rows": 0, "posting_rows": 0,
	}
}

func structuralControlPublicDraftWithCalculation(draft structuralControlDraft) map[string]any {
	result := structuralControlPublicDraft(draft)
	for key, value := range structuralControlCalculationFields(draft.IntalevMembers, draft.ERPMembers, draft.ToleranceCents) {
		result[key] = value
	}
	return result
}

func structuralControlPublicVersion(version structuralControlSetVersion, active bool) map[string]any {
	result := map[string]any{
		"control_set_id": version.ControlSetID, "lineage_id": version.LineageID,
		"version": version.Version, "name": version.Name,
		"organization_id": version.OrganizationID, "organization_name": version.OrganizationName,
		"run_id": version.RunID, "context_id": version.ContextID, "inventory_id": version.InventoryID,
		"author": version.Author, "mode": version.Mode,
		"expected_control_delta": version.ExpectedControlDelta, "tolerance_cents": version.ToleranceCents,
		"intalev_members": structuralControlPublicMembers(version.IntalevMembers, version.SourceInventorySchema),
		"erp_members":     structuralControlPublicMembers(version.ERPMembers, version.SourceInventorySchema),
		"fixed_at":        version.FixedAt, "status": map[bool]string{true: "FIXED", false: "INACTIVE"}[active],
	}
	if version.SourceInventorySchema != "" {
		result["source_inventory_schema"] = version.SourceInventorySchema
		result["control_only_declared"] = version.ControlOnlyDeclared
		result["correction_authority"] = false
	}
	return result
}

func structuralControlPublicVersionWithCalculation(version structuralControlSetVersion, active bool) map[string]any {
	result := structuralControlPublicVersion(version, active)
	for key, value := range structuralControlCalculationFields(version.IntalevMembers, version.ERPMembers, version.ToleranceCents) {
		result[key] = value
	}
	return result
}

func (s *Server) structuralControlPublicRegistry(registry structuralControlRegistry, inventory structuralControlInventory) map[string]any {
	active := structuralControlActiveVersions(registry)
	drafts := []any{}
	for _, draft := range registry.Drafts {
		if draft.OrganizationID == inventory.Organization.ID {
			public := structuralControlPublicDraftWithCalculation(draft)
			public["status"] = "DRAFT"
			if draft.RunID != inventory.RunID || draft.InventoryID != inventory.InventoryID {
				public["status"] = "HISTORICAL"
			}
			drafts = append(drafts, public)
		}
	}
	versions := []any{}
	for _, version := range registry.Versions {
		if version.OrganizationID == inventory.Organization.ID {
			public := structuralControlPublicVersionWithCalculation(version, active[version.ControlSetID])
			if !structuralControlVersionMatchesInventory(version, inventory) {
				public["status"] = "HISTORICAL"
			}
			versions = append(versions, public)
		}
	}
	events := []any{}
	for _, event := range registry.LifecycleEvents {
		version, ok := structuralControlVersion(registry, event.ControlSetID)
		if !ok || !structuralControlVersionMatchesInventory(version, inventory) {
			continue
		}
		events = append(events, map[string]any{
			"event_id": event.EventID, "action": event.Action, "control_set_id": event.ControlSetID,
			"lineage_id": version.LineageID, "version": version.Version, "name": version.Name,
			"organization_id": version.OrganizationID, "context_id": version.ContextID,
			"run_id": version.RunID, "inventory_id": version.InventoryID, "author": version.Author,
			"reason": event.Reason, "occurred_at": event.CreatedAt,
		})
	}
	return map[string]any{
		"registry_revision": registry.Revision,
		"organization":      inventory.Organization, "period": inventory.Period,
		"context_id": inventory.ContextID, "run_id": inventory.RunID,
		"inventory_id": inventory.InventoryID, "inventory_status": inventory.Status,
		"source_inventory_schema":                 inventory.SchemaVersion,
		"candidate_semantics":                     inventory.CandidateSemantics,
		"user_declaration_required":               inventory.UserDeclarationRequired,
		"automatic_business_block_classification": inventory.AutomaticBusinessBlockClassification,
		"correction_authority":                    false,
		"intalev_members":                         structuralControlPublicMembers(inventory.IntalevMembers, inventory.SchemaVersion),
		"erp_members":                             structuralControlPublicMembers(inventory.ERPMembers, inventory.SchemaVersion),
		"drafts":                                  drafts, "versions": versions, "lifecycle_events": events,
		"safety": structuralControlReportOnlySafety(),
	}
}
