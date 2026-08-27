package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	emptyArticleBindingRegistrySchema = "opiu-empty-article-binding-registry.v3"
	emptyArticleBindingMode           = "REPORT_ONLY"
	emptyArticleBindingSemanticStatus = "SOURCE_CLASSIFICATION_GAP"
	emptyArticleBindingDecision       = "UPDATE_MAPPING"
	emptyArticleBindingOperation      = "NO_POSTING"
	emptyArticleBindingOrigin         = "SERVICE_BUSINESS_SETTINGS"
	emptyArticleBindingActor          = "LOCAL_USER"
)

var (
	emptyArticleBindingRegistryMu sync.Mutex
	emptyArticleBindingMonth      = regexp.MustCompile(`^\d{4}-(?:0[1-9]|1[0-2])$`)
)

// emptyArticleBindingOrganization is the exact selectable organization
// identity. HierarchyPath is a business hierarchy path, never a filesystem
// path.
type emptyArticleBindingOrganization struct {
	ID            string `json:"organization_id"`
	Name          string `json:"organization_name"`
	HierarchyPath string `json:"organization_hierarchy_path"`
}

type emptyArticleBindingValidity struct {
	FromMonth    string `json:"from_month"`
	ThroughMonth string `json:"through_month"`
}

type emptyArticleBindingNode struct {
	Identity      string `json:"identity"`
	Code          string `json:"code"`
	HierarchyPath string `json:"hierarchy_path"`
	Article       string `json:"article"`
}

// emptyArticleBindingCatalogIdentity is private proof that the selected
// business nodes were resolved from one exact, verified R005 run and its exact
// reconciliation.codex-input.json catalog. Proof hashes are deliberately
// excluded from public projections.
type emptyArticleBindingCatalogIdentity struct {
	RunID                  string `json:"run_id"`
	ContextID              string `json:"context_id"`
	InventoryID            string `json:"inventory_id"`
	InventoryBindingSHA256 string `json:"inventory_binding_sha256"`
	CatalogSHA256          string `json:"catalog_sha256"`
}

type emptyArticleBindingCatalogSource struct {
	Node   emptyArticleBindingNode
	Period string
	Labels map[string]string
}

type emptyArticleBindingCatalogTarget struct {
	Node   emptyArticleBindingNode
	Period string
}

type emptyArticleBindingVerifiedCatalog struct {
	Sources []emptyArticleBindingCatalogSource
	Targets []emptyArticleBindingCatalogTarget
}

type emptyArticleBindingRunRow struct {
	Code         string   `json:"code"`
	IntalevLabel string   `json:"intalev_label"`
	IntalevPaths []string `json:"intalev_paths"`
	ERPPaths     []string `json:"erp_paths"`
}

type emptyArticleBindingRunTreeNode struct {
	NodeID            string            `json:"node_id"`
	Label             string            `json:"label"`
	Name              string            `json:"name"`
	FullPath          string            `json:"full_path"`
	IsGroup           *bool             `json:"is_group"`
	ImmediateChildren []json.RawMessage `json:"immediate_children"`
	SourceRowRole     string            `json:"source_row_role"`
}

type emptyArticleBindingRunTree struct {
	Status string                           `json:"status"`
	Nodes  []emptyArticleBindingRunTreeNode `json:"nodes"`
}

type emptyArticleBindingRunHierarchyPeriod struct {
	Period      string                     `json:"period"`
	IntalevTree emptyArticleBindingRunTree `json:"intalev_tree"`
	ERPTree     emptyArticleBindingRunTree `json:"erp_tree"`
}

type emptyArticleBindingRunPeriodRows struct {
	Period string                      `json:"period"`
	Rows   []emptyArticleBindingRunRow `json:"rows"`
}

type emptyArticleBindingRunUnclassifiedItem struct {
	Classification        string `json:"classification"`
	Article               string `json:"article"`
	Period                string `json:"period"`
	SourceScopeRole       string `json:"source_scope_role"`
	ClassificationBasis   string `json:"classification_basis"`
	SourceScopeID         string `json:"source_scope_id"`
	SourceScopePath       string `json:"source_scope_path"`
	BlankBranchSourcePath string `json:"blank_branch_source_path"`
	SourceParentPath      string `json:"source_parent_path"`
	SourcePath            string `json:"source_path"`
	SourceLabel           string `json:"source_label"`
	SourceIsLeaf          *bool  `json:"source_is_leaf"`
}

type emptyArticleBindingRunSourceScope struct {
	UnclassifiedItems []emptyArticleBindingRunUnclassifiedItem `json:"unclassified_items"`
}

type emptyArticleBindingRunDocument struct {
	Schema              string                                  `json:"schema"`
	Organization        string                                  `json:"organization"`
	Period              string                                  `json:"period"`
	Periods             []string                                `json:"periods"`
	ReportOnly          *bool                                   `json:"report_only"`
	PostingRows         *int                                    `json:"posting_rows"`
	ExecutionAllowed    *bool                                   `json:"execution_allowed"`
	ReadyToUpload       *bool                                   `json:"ready_to_upload"`
	ReleaseAllowed      *bool                                   `json:"release_allowed"`
	Live1CAllowed       *bool                                   `json:"live_1c_allowed"`
	Rows                []emptyArticleBindingRunRow             `json:"rows"`
	PeriodRows          []emptyArticleBindingRunPeriodRows      `json:"period_rows"`
	HierarchyPeriods    []emptyArticleBindingRunHierarchyPeriod `json:"hierarchy_periods"`
	IntalevSourceScopes []emptyArticleBindingRunSourceScope     `json:"intalev_source_scopes"`
	IntalevSourceScope  *emptyArticleBindingRunSourceScope      `json:"intalev_source_scope"`
}

type emptyArticleBindingDefinition struct {
	Name           string                          `json:"name"`
	Organization   emptyArticleBindingOrganization `json:"organization"`
	Validity       emptyArticleBindingValidity     `json:"validity"`
	SourceParent   emptyArticleBindingNode         `json:"source_parent"`
	SourceLabels   []string                        `json:"source_labels"`
	ERPTarget      emptyArticleBindingNode         `json:"erp_target"`
	SemanticStatus string                          `json:"semantic_status"`
	Decision       string                          `json:"decision"`
	Operation      string                          `json:"operation"`
}

// emptyArticleBindingProvenance is private service-generated audit data. It is
// deliberately absent from public projections.
type emptyArticleBindingProvenance struct {
	Origin         string    `json:"origin"`
	Actor          string    `json:"actor"`
	RequestID      string    `json:"request_id"`
	ApprovalMethod string    `json:"approval_method"`
	RecordedAt     time.Time `json:"recorded_at"`
}

type emptyArticleBindingAuthority struct {
	Mode                string `json:"mode"`
	Operation           string `json:"operation"`
	FinancialRows       int    `json:"financial_rows"`
	PostingRows         int    `json:"posting_rows"`
	ExecutionAllowed    bool   `json:"execution_allowed"`
	ReadyToUpload       bool   `json:"ready_to_upload"`
	ReleaseAllowed      bool   `json:"release_allowed"`
	Live1CAllowed       bool   `json:"live_1c_allowed"`
	CorrectionAuthority bool   `json:"correction_authority"`
}

type emptyArticleBindingDraft struct {
	DraftID         string                             `json:"draft_id"`
	SourceBindingID string                             `json:"source_binding_id,omitempty"`
	LineageID       string                             `json:"lineage_id"`
	Catalog         emptyArticleBindingCatalogIdentity `json:"catalog"`
	Definition      emptyArticleBindingDefinition      `json:"definition"`
	ApprovalStatus  string                             `json:"approval_status"`
	Provenance      emptyArticleBindingProvenance      `json:"provenance"`
	Authority       emptyArticleBindingAuthority       `json:"authority"`
	CreatedAt       time.Time                          `json:"created_at"`
	PayloadSHA256   string                             `json:"payload_sha256"`
}

type emptyArticleBindingVersion struct {
	BindingID       string                             `json:"binding_id"`
	SourceBindingID string                             `json:"source_binding_id,omitempty"`
	LineageID       string                             `json:"lineage_id"`
	Version         int                                `json:"version"`
	Catalog         emptyArticleBindingCatalogIdentity `json:"catalog"`
	Definition      emptyArticleBindingDefinition      `json:"definition"`
	ApprovalStatus  string                             `json:"approval_status"`
	Provenance      emptyArticleBindingProvenance      `json:"provenance"`
	Authority       emptyArticleBindingAuthority       `json:"authority"`
	FixedAt         time.Time                          `json:"fixed_at"`
	PayloadSHA256   string                             `json:"payload_sha256"`
}

type emptyArticleBindingLifecycleEvent struct {
	EventID        string    `json:"event_id"`
	Action         string    `json:"action"`
	BindingID      string    `json:"binding_id"`
	OrganizationID string    `json:"organization_id"`
	Reason         string    `json:"reason,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	PayloadSHA256  string    `json:"payload_sha256"`
}

type emptyArticleBindingRegistry struct {
	SchemaVersion   string                              `json:"schema_version"`
	Revision        int64                               `json:"revision"`
	Drafts          []emptyArticleBindingDraft          `json:"drafts"`
	Versions        []emptyArticleBindingVersion        `json:"versions"`
	LifecycleEvents []emptyArticleBindingLifecycleEvent `json:"lifecycle_events"`
}

type emptyArticleBindingDraftRequest struct {
	Name                      string                  `json:"name,omitempty"`
	OrganizationID            string                  `json:"organization_id"`
	OrganizationName          string                  `json:"organization_name"`
	OrganizationHierarchyPath string                  `json:"organization_hierarchy_path"`
	RunID                     string                  `json:"run_id"`
	InventoryID               string                  `json:"inventory_id"`
	ValidFromMonth            string                  `json:"valid_from_month"`
	ValidThroughMonth         string                  `json:"valid_through_month"`
	SourceParent              emptyArticleBindingNode `json:"source_parent"`
	SourceLabels              []string                `json:"source_labels"`
	ERPTarget                 emptyArticleBindingNode `json:"erp_target"`
	SourceBindingID           string                  `json:"source_binding_id,omitempty"`
	ExpectedRegistryRevision  int64                   `json:"expected_registry_revision"`
	PostingRows               int                     `json:"posting_rows,omitempty"`
	ExecutionAllowed          bool                    `json:"execution_allowed,omitempty"`
	ReadyToUpload             bool                    `json:"ready_to_upload,omitempty"`
	ReleaseAllowed            bool                    `json:"release_allowed,omitempty"`
	Live1CAllowed             bool                    `json:"live_1c_allowed,omitempty"`
	CorrectionAuthority       bool                    `json:"correction_authority,omitempty"`
}

type emptyArticleBindingFixRequest struct {
	DraftID                   string `json:"draft_id"`
	OrganizationID            string `json:"organization_id"`
	OrganizationName          string `json:"organization_name"`
	OrganizationHierarchyPath string `json:"organization_hierarchy_path"`
	RunID                     string `json:"run_id"`
	InventoryID               string `json:"inventory_id"`
	ExpectedRegistryRevision  int64  `json:"expected_registry_revision"`
	PostingRows               int    `json:"posting_rows,omitempty"`
	ExecutionAllowed          bool   `json:"execution_allowed,omitempty"`
	ReadyToUpload             bool   `json:"ready_to_upload,omitempty"`
	ReleaseAllowed            bool   `json:"release_allowed,omitempty"`
	Live1CAllowed             bool   `json:"live_1c_allowed,omitempty"`
	CorrectionAuthority       bool   `json:"correction_authority,omitempty"`
}

type emptyArticleBindingDisableRequest struct {
	BindingID                 string `json:"binding_id"`
	OrganizationID            string `json:"organization_id"`
	OrganizationName          string `json:"organization_name"`
	OrganizationHierarchyPath string `json:"organization_hierarchy_path"`
	Reason                    string `json:"reason"`
	ExpectedRegistryRevision  int64  `json:"expected_registry_revision"`
	PostingRows               int    `json:"posting_rows,omitempty"`
	ExecutionAllowed          bool   `json:"execution_allowed,omitempty"`
	ReadyToUpload             bool   `json:"ready_to_upload,omitempty"`
	ReleaseAllowed            bool   `json:"release_allowed,omitempty"`
	Live1CAllowed             bool   `json:"live_1c_allowed,omitempty"`
	CorrectionAuthority       bool   `json:"correction_authority,omitempty"`
}

type emptyArticleBindingFailure struct {
	status int
	code   string
}

func (failure emptyArticleBindingFailure) Error() string { return failure.code }

func emptyArticleBindingFail(status int, code string) error {
	return emptyArticleBindingFailure{status: status, code: code}
}

func writeEmptyArticleBindingError(w http.ResponseWriter, err error) {
	var failure emptyArticleBindingFailure
	if errors.As(err, &failure) {
		writeJSON(w, failure.status, apiError{Error: failure.code})
		return
	}
	writeJSON(w, http.StatusInternalServerError, apiError{Error: "EMPTY_ARTICLE_BINDING_INTERNAL_ERROR"})
}

func emptyArticleNoPostingAuthority() emptyArticleBindingAuthority {
	return emptyArticleBindingAuthority{
		Mode: emptyArticleBindingMode, Operation: emptyArticleBindingOperation,
		FinancialRows: 0, PostingRows: 0, ExecutionAllowed: false,
		ReadyToUpload: false, ReleaseAllowed: false, Live1CAllowed: false,
		CorrectionAuthority: false,
	}
}

func emptyArticleBindingUnsafe(postingRows int, executionAllowed, readyToUpload, releaseAllowed, live1CAllowed, correctionAuthority bool) bool {
	return postingRows != 0 || executionAllowed || readyToUpload || releaseAllowed || live1CAllowed || correctionAuthority
}

// handleEmptyArticleBindings serves the registered business-settings routes.
func (s *Server) handleEmptyArticleBindings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleEmptyArticleBindingList(w, r)
	case http.MethodPost:
		s.handleEmptyArticleBindingDraft(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleEmptyArticleBindingList(w http.ResponseWriter, r *http.Request) {
	organization, err := s.exactEmptyArticleBindingOrganization(
		r.URL.Query().Get("organization_id"),
		r.URL.Query().Get("organization_name"),
		r.URL.Query().Get("organization_hierarchy_path"),
	)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	unlock, err := s.lockEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, emptyArticleBindingPublicRegistry(registry, organization))
}

func (s *Server) handleEmptyArticleBindingDraft(w http.ResponseWriter, r *http.Request) {
	var request emptyArticleBindingDraftRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_REQUEST_INVALID"})
		return
	}
	if emptyArticleBindingUnsafe(request.PostingRows, request.ExecutionAllowed, request.ReadyToUpload, request.ReleaseAllowed, request.Live1CAllowed, request.CorrectionAuthority) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY"})
		return
	}
	organization, err := s.exactEmptyArticleBindingOrganization(request.OrganizationID, request.OrganizationName, request.OrganizationHierarchyPath)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	definition, err := normalizeEmptyArticleBindingDefinition(request, organization)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	definition, catalog, err := s.bindEmptyArticleDefinitionToVerifiedCatalog(definition, organization, request.RunID, request.InventoryID)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	unlock, err := s.lockEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_REGISTRY_REVISION_CONFLICT"})
		return
	}
	lineageID := ""
	sourceBindingID := cleanBusinessText(request.SourceBindingID, 200)
	if sourceBindingID != "" {
		source, ok := emptyArticleBindingVersionByID(registry, sourceBindingID)
		if !ok || source.Definition.Organization != organization {
			writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_SOURCE_VERSION_MISMATCH"})
			return
		}
		lineageID = source.LineageID
	}
	if lineageID == "" {
		lineageID, err = newOpaqueID("eab_lineage")
		if err != nil {
			writeEmptyArticleBindingError(w, err)
			return
		}
	}
	if emptyArticleBindingRegistryOverlap(registry, lineageID, definition) {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_SCOPE_OVERLAP"})
		return
	}
	draftID, err := newOpaqueID("eab_draft")
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	requestID, err := newOpaqueID("eab_request")
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	now := time.Now().UTC()
	draft := emptyArticleBindingDraft{
		DraftID: draftID, SourceBindingID: sourceBindingID, LineageID: lineageID,
		Catalog: catalog, Definition: definition, ApprovalStatus: "PENDING_USER_FIX",
		Provenance: emptyArticleBindingProvenance{
			Origin: emptyArticleBindingOrigin, Actor: emptyArticleBindingActor,
			RequestID: requestID, ApprovalMethod: "PENDING_EXPLICIT_FIX", RecordedAt: now,
		},
		Authority: emptyArticleNoPostingAuthority(), CreatedAt: now,
	}
	draft.PayloadSHA256, err = emptyArticleBindingDraftSHA(draft)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	registry.Drafts = append(registry.Drafts, draft)
	registry.Revision++
	if err := s.saveEmptyArticleBindingRegistry(registry); err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"draft":             emptyArticleBindingPublicDraft(draft),
		"registry_revision": registry.Revision,
		"safety":            reportOnlySafety(), "execution_allowed": false,
	})
}

func (s *Server) handleEmptyArticleBindingFix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request emptyArticleBindingFixRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_REQUEST_INVALID"})
		return
	}
	if emptyArticleBindingUnsafe(request.PostingRows, request.ExecutionAllowed, request.ReadyToUpload, request.ReleaseAllowed, request.Live1CAllowed, request.CorrectionAuthority) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY"})
		return
	}
	organization, err := s.exactEmptyArticleBindingOrganization(request.OrganizationID, request.OrganizationName, request.OrganizationHierarchyPath)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	catalog, verified, err := s.verifiedEmptyArticleBindingCatalog(organization, request.RunID, request.InventoryID)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	unlock, err := s.lockEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_REGISTRY_REVISION_CONFLICT"})
		return
	}
	draftIndex := -1
	var draft emptyArticleBindingDraft
	for index, candidate := range registry.Drafts {
		if candidate.DraftID == cleanBusinessText(request.DraftID, 200) {
			draftIndex, draft = index, candidate
			break
		}
	}
	if draftIndex < 0 {
		writeJSON(w, http.StatusNotFound, apiError{Error: "EMPTY_ARTICLE_BINDING_DRAFT_NOT_FOUND"})
		return
	}
	if draft.Definition.Organization != organization {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_ORGANIZATION_MISMATCH"})
		return
	}
	if draft.Catalog != catalog || !emptyArticleBindingDefinitionMatchesCatalog(draft.Definition, verified) {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_DRAFT_CATALOG_STALE"})
		return
	}
	if emptyArticleBindingRegistryOverlap(registry, draft.LineageID, draft.Definition) {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_SCOPE_OVERLAP"})
		return
	}
	bindingID, err := newOpaqueID("eab_binding")
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	versionNumber := 1
	for _, version := range registry.Versions {
		if version.LineageID == draft.LineageID && version.Version >= versionNumber {
			versionNumber = version.Version + 1
		}
	}
	fixedAt := time.Now().UTC()
	provenance := draft.Provenance
	provenance.ApprovalMethod = "EXPLICIT_USER_FIX"
	provenance.RecordedAt = fixedAt
	version := emptyArticleBindingVersion{
		BindingID: bindingID, SourceBindingID: draft.SourceBindingID,
		LineageID: draft.LineageID, Version: versionNumber, Catalog: draft.Catalog,
		Definition: draft.Definition, ApprovalStatus: "FIXED",
		Provenance: provenance, Authority: emptyArticleNoPostingAuthority(), FixedAt: fixedAt,
	}
	version.PayloadSHA256, err = emptyArticleBindingVersionSHA(version)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	if previous := emptyArticleBindingActiveLineageVersion(registry, version.Definition.Organization.ID, version.LineageID); previous != "" {
		event, eventErr := newEmptyArticleBindingEvent("SUPERSEDED", previous, version.Definition.Organization.ID, "Новая версия настройки")
		if eventErr != nil {
			writeEmptyArticleBindingError(w, eventErr)
			return
		}
		registry.LifecycleEvents = append(registry.LifecycleEvents, event)
	}
	registry.Versions = append(registry.Versions, version)
	fixedEvent, err := newEmptyArticleBindingEvent("FIXED", version.BindingID, version.Definition.Organization.ID, "Версия настройки зафиксирована")
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	registry.LifecycleEvents = append(registry.LifecycleEvents, fixedEvent)
	registry.Drafts = append(registry.Drafts[:draftIndex], registry.Drafts[draftIndex+1:]...)
	registry.Revision++
	if err := s.saveEmptyArticleBindingRegistry(registry); err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"fixed_version":     emptyArticleBindingPublicVersion(version, true),
		"registry_revision": registry.Revision,
		"safety":            reportOnlySafety(), "execution_allowed": false,
	})
}

func (s *Server) handleEmptyArticleBindingDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request emptyArticleBindingDisableRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_REQUEST_INVALID"})
		return
	}
	if emptyArticleBindingUnsafe(request.PostingRows, request.ExecutionAllowed, request.ReadyToUpload, request.ReleaseAllowed, request.Live1CAllowed, request.CorrectionAuthority) {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_UNSAFE_AUTHORITY"})
		return
	}
	organization, err := s.exactEmptyArticleBindingOrganization(request.OrganizationID, request.OrganizationName, request.OrganizationHierarchyPath)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	reason := cleanBusinessText(request.Reason, 500)
	if reason == "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "EMPTY_ARTICLE_BINDING_DISABLE_REASON_REQUIRED"})
		return
	}
	unlock, err := s.lockEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	defer unlock()
	registry, err := s.loadEmptyArticleBindingRegistry()
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	if registry.Revision != request.ExpectedRegistryRevision {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_REGISTRY_REVISION_CONFLICT"})
		return
	}
	version, ok := emptyArticleBindingVersionByID(registry, cleanBusinessText(request.BindingID, 200))
	if !ok {
		writeJSON(w, http.StatusNotFound, apiError{Error: "EMPTY_ARTICLE_BINDING_VERSION_NOT_FOUND"})
		return
	}
	if version.Definition.Organization != organization {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_ORGANIZATION_MISMATCH"})
		return
	}
	if !emptyArticleBindingActiveVersions(registry)[version.BindingID] {
		writeJSON(w, http.StatusConflict, apiError{Error: "EMPTY_ARTICLE_BINDING_VERSION_INACTIVE"})
		return
	}
	event, err := newEmptyArticleBindingEvent("DISABLED", version.BindingID, organization.ID, reason)
	if err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	registry.LifecycleEvents = append(registry.LifecycleEvents, event)
	registry.Revision++
	if err := s.saveEmptyArticleBindingRegistry(registry); err != nil {
		writeEmptyArticleBindingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"disabled_version":  emptyArticleBindingPublicVersion(version, false),
		"registry_revision": registry.Revision,
		"safety":            reportOnlySafety(), "execution_allowed": false,
	})
}

func (s *Server) exactEmptyArticleBindingOrganization(id, name, hierarchyPath string) (emptyArticleBindingOrganization, error) {
	id = cleanBusinessText(id, 200)
	name = cleanBusinessText(name, 200)
	hierarchyPath = cleanBusinessText(hierarchyPath, 1000)
	if id == "" || name == "" || hierarchyPath == "" {
		return emptyArticleBindingOrganization{}, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_ORGANIZATION_REQUIRED")
	}
	for _, node := range s.store.OrganizationCatalog() {
		if strings.EqualFold(node.ID, id) {
			if !node.Selectable || node.Name != name || node.Path != hierarchyPath {
				return emptyArticleBindingOrganization{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_ORGANIZATION_MISMATCH")
			}
			return emptyArticleBindingOrganization{ID: node.ID, Name: node.Name, HierarchyPath: node.Path}, nil
		}
	}
	return emptyArticleBindingOrganization{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_ORGANIZATION_UNKNOWN")
}

func (s *Server) verifiedEmptyArticleBindingCatalog(organization emptyArticleBindingOrganization, runID, inventoryID string) (emptyArticleBindingCatalogIdentity, emptyArticleBindingVerifiedCatalog, error) {
	runID = cleanBusinessText(runID, 200)
	inventoryID = cleanBusinessText(inventoryID, 200)
	if runID == "" || inventoryID == "" {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_CATALOG_SCOPE_REQUIRED")
	}
	inventory, bindingSHA, err := s.loadStructuralControlInventory(organization.ID, runID, inventoryID)
	if err != nil {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED")
	}
	if inventory.Organization.ID != organization.ID || inventory.Organization.Name != organization.Name ||
		inventory.Organization.Path != organization.HierarchyPath || inventory.RunID != runID || inventory.InventoryID != inventoryID ||
		inventory.ContextID == "" || !validUpperSHA256(bindingSHA) || !validUpperSHA256(inventory.CurrentRun.CodexInput.SHA256) {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_SCOPE_MISMATCH")
	}
	contextValue, ok := s.store.Context(inventory.ContextID)
	if !ok || contextValue.Archived || contextValue.OrganizationID != organization.ID ||
		contextValue.OrganizationName != organization.Name || contextValue.OrganizationPath != organization.HierarchyPath ||
		contextValue.Period != inventory.Period {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_SCOPE_MISMATCH")
	}
	r005Dir := filepath.Join(s.store.RunsDir(), inventory.RunID, "r005")
	codexPath := filepath.Join(r005Dir, "reconciliation.codex-input.json")
	codexBytes, err := readStructuralControlArtifact(r005Dir, codexPath, 64<<20)
	if err != nil {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED")
	}
	digest := sha256.Sum256(codexBytes)
	catalogSHA := strings.ToUpper(hex.EncodeToString(digest[:]))
	if catalogSHA != inventory.CurrentRun.CodexInput.SHA256 {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_STALE")
	}
	verified, err := decodeEmptyArticleBindingRunCatalog(codexBytes, organization, inventory.Period)
	if err != nil {
		return emptyArticleBindingCatalogIdentity{}, emptyArticleBindingVerifiedCatalog{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_UNVERIFIED")
	}
	return emptyArticleBindingCatalogIdentity{
		RunID: inventory.RunID, ContextID: inventory.ContextID, InventoryID: inventory.InventoryID,
		InventoryBindingSHA256: bindingSHA, CatalogSHA256: catalogSHA,
	}, verified, nil
}

func (s *Server) bindEmptyArticleDefinitionToVerifiedCatalog(definition emptyArticleBindingDefinition, organization emptyArticleBindingOrganization, runID, inventoryID string) (emptyArticleBindingDefinition, emptyArticleBindingCatalogIdentity, error) {
	catalog, verified, err := s.verifiedEmptyArticleBindingCatalog(organization, runID, inventoryID)
	if err != nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingCatalogIdentity{}, err
	}
	bound, err := bindEmptyArticleDefinitionToRunCatalog(definition, verified)
	if err != nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingCatalogIdentity{}, err
	}
	return bound, catalog, nil
}

func bindEmptyArticleDefinitionToRunCatalog(definition emptyArticleBindingDefinition, catalog emptyArticleBindingVerifiedCatalog) (emptyArticleBindingDefinition, error) {
	var source *emptyArticleBindingCatalogSource
	for index := range catalog.Sources {
		candidate := &catalog.Sources[index]
		if candidate.Node.Identity != definition.SourceParent.Identity {
			continue
		}
		if candidate.Node != definition.SourceParent || source != nil {
			return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_SOURCE_PARENT_CATALOG_MISMATCH")
		}
		source = candidate
	}
	if source == nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_SOURCE_PARENT_CATALOG_MISMATCH")
	}
	canonicalLabels := make([]string, 0, len(definition.SourceLabels))
	for _, label := range definition.SourceLabels {
		canonical, exists := source.Labels[emptyArticleBindingCatalogNormalize(label)]
		if !exists || canonical != label {
			return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_SOURCE_LABEL_CATALOG_MISMATCH")
		}
		canonicalLabels = append(canonicalLabels, canonical)
	}
	canonicalLabels, err := normalizeEmptyArticleBindingLabels(canonicalLabels)
	if err != nil {
		return emptyArticleBindingDefinition{}, err
	}

	var target *emptyArticleBindingCatalogTarget
	for index := range catalog.Targets {
		candidate := &catalog.Targets[index]
		if candidate.Node.Identity != definition.ERPTarget.Identity {
			continue
		}
		if candidate.Node != definition.ERPTarget || target != nil {
			return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_ERP_TARGET_CATALOG_MISMATCH")
		}
		target = candidate
	}
	if target == nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_ERP_TARGET_CATALOG_MISMATCH")
	}
	if source.Period != target.Period || source.Period < definition.Validity.FromMonth || source.Period > definition.Validity.ThroughMonth {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_CATALOG_PERIOD_MISMATCH")
	}
	definition.SourceParent = source.Node
	definition.SourceLabels = canonicalLabels
	definition.ERPTarget = target.Node
	return definition, nil
}

func emptyArticleBindingDefinitionMatchesCatalog(definition emptyArticleBindingDefinition, catalog emptyArticleBindingVerifiedCatalog) bool {
	bound, err := bindEmptyArticleDefinitionToRunCatalog(definition, catalog)
	return err == nil && emptyArticleBindingDefinitionsEqual(bound, definition)
}

func emptyArticleBindingDefinitionsEqual(left, right emptyArticleBindingDefinition) bool {
	if left.Name != right.Name || left.Organization != right.Organization || left.Validity != right.Validity ||
		left.SourceParent != right.SourceParent || left.ERPTarget != right.ERPTarget ||
		left.SemanticStatus != right.SemanticStatus || left.Decision != right.Decision || left.Operation != right.Operation ||
		len(left.SourceLabels) != len(right.SourceLabels) {
		return false
	}
	for index := range left.SourceLabels {
		if left.SourceLabels[index] != right.SourceLabels[index] {
			return false
		}
	}
	return true
}

func decodeEmptyArticleBindingRunCatalog(data []byte, organization emptyArticleBindingOrganization, expectedPeriod string) (emptyArticleBindingVerifiedCatalog, error) {
	var generic any
	if err := decodeJSONRejectDuplicateKeys(data, &generic, false); err != nil {
		return emptyArticleBindingVerifiedCatalog{}, err
	}
	if err := validateEmptyArticleBindingCatalogKeyCase(generic); err != nil {
		return emptyArticleBindingVerifiedCatalog{}, err
	}
	var document emptyArticleBindingRunDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return emptyArticleBindingVerifiedCatalog{}, err
	}
	if document.Schema != "opiu-codex-review-input-v1" || document.Organization != organization.Name ||
		document.ReportOnly == nil || !*document.ReportOnly || document.PostingRows == nil || *document.PostingRows != 0 ||
		document.ExecutionAllowed == nil || *document.ExecutionAllowed || document.ReadyToUpload == nil || *document.ReadyToUpload ||
		document.ReleaseAllowed == nil || *document.ReleaseAllowed || document.Live1CAllowed == nil || *document.Live1CAllowed {
		return emptyArticleBindingVerifiedCatalog{}, errors.New("run catalog safety or organization is not exact")
	}
	resultPeriods := document.Periods
	if resultPeriods == nil {
		resultPeriods = []string{document.Period}
	}
	filterExpectedMonth := emptyArticleBindingMonth.MatchString(expectedPeriod)
	foundExpectedPeriod := false
	for _, period := range resultPeriods {
		if period == expectedPeriod {
			foundExpectedPeriod = true
		}
	}
	if expectedPeriod == "" || (filterExpectedMonth && !foundExpectedPeriod) {
		return emptyArticleBindingVerifiedCatalog{}, errors.New("run catalog period is not exact")
	}

	hierarchyByPeriod := map[string]int{}
	for index := range document.HierarchyPeriods {
		entry := document.HierarchyPeriods[index]
		if !emptyArticleBindingMonth.MatchString(entry.Period) || entry.IntalevTree.Status != "PASS" || entry.ERPTree.Status != "PASS" ||
			entry.IntalevTree.Nodes == nil || entry.ERPTree.Nodes == nil {
			return emptyArticleBindingVerifiedCatalog{}, errors.New("run hierarchy catalog is incomplete")
		}
		if _, duplicate := hierarchyByPeriod[entry.Period]; duplicate {
			return emptyArticleBindingVerifiedCatalog{}, errors.New("run hierarchy period is ambiguous")
		}
		hierarchyByPeriod[entry.Period] = index
	}
	if len(hierarchyByPeriod) == 0 {
		return emptyArticleBindingVerifiedCatalog{}, errors.New("run hierarchy catalog is missing")
	}

	sourceGroups := map[string]*emptyArticleBindingCatalogSource{}
	scopes := document.IntalevSourceScopes
	if scopes == nil && document.IntalevSourceScope != nil {
		scopes = []emptyArticleBindingRunSourceScope{*document.IntalevSourceScope}
	}
	for _, scope := range scopes {
		for _, item := range scope.UnclassifiedItems {
			if item.Classification != "UNCLASSIFIED" || item.Article != "" || item.SourceScopeRole != "UNCLASSIFIED_DETAIL" ||
				item.ClassificationBasis != "EMPTY_ARTICLE_ANCESTOR" || item.SourceIsLeaf == nil || !*item.SourceIsLeaf {
				continue
			}
			period := strings.TrimSpace(item.Period)
			sourceScopeID := strings.TrimSpace(item.SourceScopeID)
			sourceScopePath := strings.TrimSpace(item.SourceScopePath)
			sourceParentPath := strings.TrimSpace(item.SourceParentPath)
			blankBranchPath := strings.TrimSpace(item.BlankBranchSourcePath)
			sourcePath := strings.TrimSpace(item.SourcePath)
			sourceLabel := strings.TrimSpace(item.SourceLabel)
			if !emptyArticleBindingMonth.MatchString(period) || sourceScopeID == "" || sourceScopePath == "" ||
				sourceParentPath == "" || blankBranchPath == "" || sourcePath == "" || sourceLabel == "" ||
				!emptyArticleBindingCatalogSamePath(sourcePath, sourceParentPath+" / "+sourceLabel) {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev leaf lacks exact identity")
			}
			if filterExpectedMonth && period != expectedPeriod {
				continue
			}
			hierarchyIndex, exists := hierarchyByPeriod[period]
			if !exists {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev leaf hierarchy is missing")
			}
			hierarchy := document.HierarchyPeriods[hierarchyIndex]
			blankNodes := make([]emptyArticleBindingRunTreeNode, 0, 1)
			for _, node := range hierarchy.IntalevTree.Nodes {
				if strings.TrimSpace(node.NodeID) != "" && emptyArticleBindingCatalogSamePath(node.FullPath, sourceParentPath) {
					blankNodes = append(blankNodes, node)
				}
			}
			if len(blankNodes) != 1 {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev parent is ambiguous")
			}
			scopeLeaf := emptyArticleBindingCatalogPathLeaf(sourceScopePath)
			ownerRows := make([]emptyArticleBindingRunRow, 0, 1)
			for _, row := range emptyArticleBindingRowsForPeriod(document, period) {
				if strings.TrimSpace(row.Code) == "" || strings.TrimSpace(row.IntalevLabel) == "" ||
					emptyArticleBindingCatalogNormalize(row.IntalevLabel) != emptyArticleBindingCatalogNormalize(scopeLeaf) ||
					!emptyArticleBindingCatalogContainsPath(row.IntalevPaths, sourceScopePath) {
					continue
				}
				ownerRows = append(ownerRows, row)
			}
			if len(ownerRows) == 0 {
				continue
			}
			if len(ownerRows) != 1 {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev economic owner is ambiguous")
			}
			owner := ownerRows[0]
			groupKey := emptyArticleBindingCatalogFingerprint(period, blankNodes[0].NodeID, owner.Code, sourceParentPath)
			canonicalNode := emptyArticleBindingNode{
				Identity: strings.TrimSpace(blankNodes[0].NodeID), Code: strings.TrimSpace(owner.Code),
				HierarchyPath: sourceParentPath, Article: strings.TrimSpace(owner.IntalevLabel),
			}
			group := sourceGroups[groupKey]
			if group == nil {
				group = &emptyArticleBindingCatalogSource{
					Node:   canonicalNode,
					Period: period, Labels: map[string]string{},
				}
				sourceGroups[groupKey] = group
			} else if group.Node != canonicalNode || group.Period != period {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev parent identity is ambiguous")
			}
			labelKey := emptyArticleBindingCatalogNormalize(sourceLabel)
			if _, duplicate := group.Labels[labelKey]; duplicate {
				return emptyArticleBindingVerifiedCatalog{}, errors.New("blank Intalev leaf is duplicated")
			}
			group.Labels[labelKey] = sourceLabel
		}
	}

	verified := emptyArticleBindingVerifiedCatalog{}
	for _, group := range sourceGroups {
		if len(group.Labels) != 0 {
			verified.Sources = append(verified.Sources, *group)
		}
	}
	for period, hierarchyIndex := range hierarchyByPeriod {
		if filterExpectedMonth && period != expectedPeriod {
			continue
		}
		rows := emptyArticleBindingRowsForPeriod(document, period)
		for _, node := range document.HierarchyPeriods[hierarchyIndex].ERPTree.Nodes {
			identity := strings.TrimSpace(node.NodeID)
			name := strings.TrimSpace(node.Label)
			if name == "" {
				name = strings.TrimSpace(node.Name)
			}
			hierarchyPath := strings.TrimSpace(node.FullPath)
			if identity == "" || name == "" || hierarchyPath == "" || node.IsGroup == nil || *node.IsGroup ||
				len(node.ImmediateChildren) != 0 || node.SourceRowRole != "ARTICLE" {
				continue
			}
			owners := make([]emptyArticleBindingRunRow, 0, 1)
			for _, row := range rows {
				if strings.TrimSpace(row.Code) != "" && emptyArticleBindingCatalogContainsPath(row.ERPPaths, hierarchyPath) {
					owners = append(owners, row)
				}
			}
			if len(owners) != 1 {
				continue
			}
			verified.Targets = append(verified.Targets, emptyArticleBindingCatalogTarget{
				Node: emptyArticleBindingNode{
					Identity: identity, Code: strings.TrimSpace(owners[0].Code), HierarchyPath: hierarchyPath, Article: name,
				},
				Period: period,
			})
		}
	}
	if err := validateEmptyArticleBindingRunCatalogUniqueness(verified); err != nil {
		return emptyArticleBindingVerifiedCatalog{}, err
	}
	return verified, nil
}

func validateEmptyArticleBindingCatalogKeyCase(value any) error {
	canonicalKeys := map[string]string{}
	for _, key := range []string{
		"schema", "organization", "period", "periods", "report_only", "posting_rows", "execution_allowed",
		"ready_to_upload", "release_allowed", "live_1c_allowed", "rows", "period_rows", "hierarchy_periods",
		"intalev_source_scopes", "intalev_source_scope", "intalev_tree", "erp_tree", "status", "nodes",
		"code", "intalev_label", "intalev_paths", "erp_paths", "node_id", "label", "name", "full_path",
		"is_group", "immediate_children", "source_row_role", "unclassified_items", "classification", "article",
		"source_scope_role", "classification_basis", "source_scope_id", "source_scope_path", "blank_branch_source_path",
		"source_parent_path", "source_path", "source_label", "source_is_leaf",
	} {
		canonicalKeys[strings.ToLower(key)] = key
	}
	var walk func(any) error
	walk = func(current any) error {
		switch typed := current.(type) {
		case map[string]any:
			for key, child := range typed {
				if canonical, sensitive := canonicalKeys[strings.ToLower(key)]; sensitive && key != canonical {
					return errors.New("run catalog uses non-canonical security field")
				}
				if err := walk(child); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range typed {
				if err := walk(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(value)
}

func emptyArticleBindingRowsForPeriod(document emptyArticleBindingRunDocument, period string) []emptyArticleBindingRunRow {
	if document.Period == period && document.Rows != nil {
		return document.Rows
	}
	var rows []emptyArticleBindingRunRow
	matches := 0
	for _, periodRows := range document.PeriodRows {
		if periodRows.Period == period && periodRows.Rows != nil {
			matches++
			rows = periodRows.Rows
		}
	}
	if matches != 1 {
		return nil
	}
	return rows
}

func emptyArticleBindingCatalogNormalize(value string) string {
	return strings.ToUpper(strings.Join(strings.Fields(value), " "))
}

func emptyArticleBindingCatalogPathParts(value string) []string {
	raw := strings.Split(value, " / ")
	parts := make([]string, 0, len(raw))
	for _, part := range raw {
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

func emptyArticleBindingCatalogSamePath(left, right string) bool {
	return emptyArticleBindingCatalogNormalize(strings.Join(emptyArticleBindingCatalogPathParts(left), " / ")) ==
		emptyArticleBindingCatalogNormalize(strings.Join(emptyArticleBindingCatalogPathParts(right), " / "))
}

func emptyArticleBindingCatalogPathLeaf(value string) string {
	parts := emptyArticleBindingCatalogPathParts(value)
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func emptyArticleBindingCatalogContainsPath(paths []string, wanted string) bool {
	for _, path := range paths {
		if emptyArticleBindingCatalogSamePath(path, wanted) {
			return true
		}
	}
	return false
}

func emptyArticleBindingCatalogFingerprint(values ...string) string {
	normalized := make([]string, len(values))
	for index, value := range values {
		normalized[index] = emptyArticleBindingCatalogNormalize(value)
	}
	return strings.Join(normalized, "|")
}

func validateEmptyArticleBindingRunCatalogUniqueness(catalog emptyArticleBindingVerifiedCatalog) error {
	if len(catalog.Sources) == 0 || len(catalog.Targets) == 0 {
		return errors.New("run catalog has no exact selectable nodes")
	}
	validate := func(nodes []emptyArticleBindingCatalogTarget) error {
		identities := map[string]bool{}
		fingerprints := map[string]bool{}
		for _, member := range nodes {
			identity := emptyArticleBindingCatalogNormalize(member.Node.Identity)
			fingerprint := emptyArticleBindingCatalogFingerprint(member.Period, member.Node.Code, member.Node.Article, member.Node.HierarchyPath)
			if identity == "" || identities[identity] || fingerprints[fingerprint] {
				return errors.New("run catalog exact node is ambiguous")
			}
			identities[identity] = true
			fingerprints[fingerprint] = true
		}
		return nil
	}
	sources := make([]emptyArticleBindingCatalogTarget, 0, len(catalog.Sources))
	for _, source := range catalog.Sources {
		sources = append(sources, emptyArticleBindingCatalogTarget{Node: source.Node, Period: source.Period})
	}
	if err := validate(sources); err != nil {
		return err
	}
	return validate(catalog.Targets)
}

func normalizeEmptyArticleBindingDefinition(request emptyArticleBindingDraftRequest, organization emptyArticleBindingOrganization) (emptyArticleBindingDefinition, error) {
	validity := emptyArticleBindingValidity{
		FromMonth:    cleanBusinessText(request.ValidFromMonth, 7),
		ThroughMonth: cleanBusinessText(request.ValidThroughMonth, 7),
	}
	if !emptyArticleBindingMonth.MatchString(validity.FromMonth) || !emptyArticleBindingMonth.MatchString(validity.ThroughMonth) || validity.FromMonth > validity.ThroughMonth {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_VALIDITY_INVALID")
	}
	sourceParent, err := normalizeEmptyArticleBindingNode(request.SourceParent)
	if err != nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_SOURCE_PARENT_INVALID")
	}
	target, err := normalizeEmptyArticleBindingNode(request.ERPTarget)
	if err != nil {
		return emptyArticleBindingDefinition{}, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_ERP_TARGET_INVALID")
	}
	labels, err := normalizeEmptyArticleBindingLabels(request.SourceLabels)
	if err != nil {
		return emptyArticleBindingDefinition{}, err
	}
	name := cleanBusinessText(request.Name, 200)
	if name == "" {
		name = cleanBusinessText("Пустые статьи → "+target.Article, 200)
	}
	return emptyArticleBindingDefinition{
		Name: name, Organization: organization, Validity: validity,
		SourceParent: sourceParent, SourceLabels: labels, ERPTarget: target,
		SemanticStatus: emptyArticleBindingSemanticStatus,
		Decision:       emptyArticleBindingDecision, Operation: emptyArticleBindingOperation,
	}, nil
}

func normalizeEmptyArticleBindingNode(node emptyArticleBindingNode) (emptyArticleBindingNode, error) {
	node.Identity = cleanBusinessText(node.Identity, 500)
	node.Code = cleanBusinessText(node.Code, 200)
	node.HierarchyPath = cleanBusinessText(node.HierarchyPath, 1000)
	node.Article = cleanBusinessText(node.Article, 500)
	if node.Identity == "" || node.Code == "" || node.HierarchyPath == "" || node.Article == "" {
		return emptyArticleBindingNode{}, errors.New("incomplete exact node identity")
	}
	return node, nil
}

func normalizeEmptyArticleBindingLabels(labels []string) ([]string, error) {
	if len(labels) == 0 || len(labels) > 100 {
		return nil, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_SOURCE_LABELS_REQUIRED")
	}
	type normalizedLabel struct{ key, value string }
	normalized := make([]normalizedLabel, 0, len(labels))
	seen := map[string]bool{}
	for _, label := range labels {
		value := cleanBusinessText(strings.Join(strings.Fields(label), " "), 500)
		key := strings.ToUpper(value)
		if value == "" {
			return nil, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_SOURCE_LABEL_INVALID")
		}
		if seen[key] {
			return nil, emptyArticleBindingFail(http.StatusBadRequest, "EMPTY_ARTICLE_BINDING_SOURCE_LABEL_DUPLICATE")
		}
		seen[key] = true
		normalized = append(normalized, normalizedLabel{key: key, value: value})
	}
	sort.Slice(normalized, func(i, j int) bool { return normalized[i].key < normalized[j].key })
	result := make([]string, 0, len(normalized))
	for _, label := range normalized {
		result = append(result, label.value)
	}
	return result, nil
}

func emptyArticleBindingDefinitionValid(definition emptyArticleBindingDefinition) bool {
	if definition.Organization.ID == "" || definition.Organization.ID != cleanBusinessText(definition.Organization.ID, 200) ||
		definition.Organization.Name == "" || definition.Organization.Name != cleanBusinessText(definition.Organization.Name, 200) ||
		definition.Organization.HierarchyPath == "" || definition.Organization.HierarchyPath != cleanBusinessText(definition.Organization.HierarchyPath, 1000) ||
		definition.Name == "" || definition.Name != cleanBusinessText(definition.Name, 200) ||
		definition.SemanticStatus != emptyArticleBindingSemanticStatus ||
		definition.Decision != emptyArticleBindingDecision || definition.Operation != emptyArticleBindingOperation ||
		!emptyArticleBindingMonth.MatchString(definition.Validity.FromMonth) ||
		!emptyArticleBindingMonth.MatchString(definition.Validity.ThroughMonth) ||
		definition.Validity.FromMonth > definition.Validity.ThroughMonth {
		return false
	}
	sourceParent, err := normalizeEmptyArticleBindingNode(definition.SourceParent)
	if err != nil || sourceParent != definition.SourceParent {
		return false
	}
	target, err := normalizeEmptyArticleBindingNode(definition.ERPTarget)
	if err != nil || target != definition.ERPTarget {
		return false
	}
	labels, err := normalizeEmptyArticleBindingLabels(definition.SourceLabels)
	if err != nil || len(labels) != len(definition.SourceLabels) {
		return false
	}
	for index := range labels {
		if labels[index] != definition.SourceLabels[index] {
			return false
		}
	}
	return true
}

func emptyArticleBindingCatalogIdentityValid(catalog emptyArticleBindingCatalogIdentity) bool {
	return catalog.RunID != "" && catalog.RunID == cleanBusinessText(catalog.RunID, 200) &&
		catalog.ContextID != "" && catalog.ContextID == cleanBusinessText(catalog.ContextID, 200) &&
		catalog.InventoryID != "" && catalog.InventoryID == cleanBusinessText(catalog.InventoryID, 200) &&
		validUpperSHA256(catalog.InventoryBindingSHA256) && validUpperSHA256(catalog.CatalogSHA256)
}

func emptyArticleBindingAuthorityValid(authority emptyArticleBindingAuthority) bool {
	return authority == emptyArticleNoPostingAuthority()
}

func emptyArticleBindingProvenanceValid(provenance emptyArticleBindingProvenance, fixed bool) bool {
	expectedMethod := "PENDING_EXPLICIT_FIX"
	if fixed {
		expectedMethod = "EXPLICIT_USER_FIX"
	}
	return provenance.Origin == emptyArticleBindingOrigin && provenance.Actor == emptyArticleBindingActor &&
		provenance.RequestID != "" && provenance.ApprovalMethod == expectedMethod && !provenance.RecordedAt.IsZero()
}

func (s *Server) emptyArticleBindingRegistryPath() string {
	return emptyArticleBindingRegistryPathForStore(s.store)
}

func (s *Server) loadEmptyArticleBindingRegistry() (emptyArticleBindingRegistry, error) {
	return loadEmptyArticleBindingRegistryForStore(s.store)
}

func emptyArticleBindingRegistryPathForStore(store *Store) string {
	return filepath.Join(store.Root(), "private-settings", "empty-article-bindings.json")
}

func loadEmptyArticleBindingRegistryForStore(store *Store) (emptyArticleBindingRegistry, error) {
	registry := emptyArticleBindingRegistry{
		SchemaVersion: emptyArticleBindingRegistrySchema,
		Drafts:        []emptyArticleBindingDraft{}, Versions: []emptyArticleBindingVersion{},
		LifecycleEvents: []emptyArticleBindingLifecycleEvent{},
	}
	data, err := os.ReadFile(emptyArticleBindingRegistryPathForStore(store))
	if errors.Is(err, os.ErrNotExist) {
		return registry, nil
	}
	if err != nil {
		return emptyArticleBindingRegistry{}, err
	}
	if len(data) > 16<<20 || decodeExactJSON(data, &registry) != nil ||
		registry.SchemaVersion != emptyArticleBindingRegistrySchema || registry.Revision < 0 {
		return emptyArticleBindingRegistry{}, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
	}
	if registry.Drafts == nil {
		registry.Drafts = []emptyArticleBindingDraft{}
	}
	if registry.Versions == nil {
		registry.Versions = []emptyArticleBindingVersion{}
	}
	if registry.LifecycleEvents == nil {
		registry.LifecycleEvents = []emptyArticleBindingLifecycleEvent{}
	}
	if err := validateEmptyArticleBindingRegistry(registry); err != nil {
		return emptyArticleBindingRegistry{}, err
	}
	return registry, nil
}

func (s *Server) saveEmptyArticleBindingRegistry(registry emptyArticleBindingRegistry) error {
	return saveEmptyArticleBindingRegistryForStore(s.store, registry)
}

func saveEmptyArticleBindingRegistryForStore(store *Store, registry emptyArticleBindingRegistry) error {
	if err := validateEmptyArticleBindingRegistry(registry); err != nil {
		return err
	}
	if err := atomicWritePrivateJSON(emptyArticleBindingRegistryPathForStore(store), registry); err != nil {
		return err
	}
	verified, err := loadEmptyArticleBindingRegistryForStore(store)
	if err != nil || verified.Revision != registry.Revision {
		return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_COMMIT_UNVERIFIED")
	}
	return nil
}

func (s *Server) lockEmptyArticleBindingRegistry() (func(), error) {
	return lockEmptyArticleBindingRegistryForStore(s.store)
}

func lockEmptyArticleBindingRegistryForStore(store *Store) (func(), error) {
	emptyArticleBindingRegistryMu.Lock()
	lockPath := filepath.Join(store.Root(), ".empty-article-binding-registry.lock")
	releaseFileLock, err := acquireStructuralRegistryFileLock(lockPath, 2*time.Second)
	if err != nil {
		emptyArticleBindingRegistryMu.Unlock()
		return nil, emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_BUSY")
	}
	return func() {
		releaseFileLock()
		emptyArticleBindingRegistryMu.Unlock()
	}, nil
}

func emptyArticleBindingDraftSHA(draft emptyArticleBindingDraft) (string, error) {
	draft.PayloadSHA256 = ""
	return emptyArticleBindingJSONSHA(draft)
}

func emptyArticleBindingVersionSHA(version emptyArticleBindingVersion) (string, error) {
	version.PayloadSHA256 = ""
	return emptyArticleBindingJSONSHA(version)
}

func emptyArticleBindingEventSHA(event emptyArticleBindingLifecycleEvent) (string, error) {
	event.PayloadSHA256 = ""
	return emptyArticleBindingJSONSHA(event)
}

func emptyArticleBindingJSONSHA(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func validateEmptyArticleBindingRegistry(registry emptyArticleBindingRegistry) error {
	if registry.SchemaVersion != emptyArticleBindingRegistrySchema || registry.Revision < 0 {
		return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
	}
	draftIDs := map[string]bool{}
	versionIDs := map[string]bool{}
	eventIDs := map[string]bool{}
	lineageVersions := map[string]bool{}
	versionsByID := map[string]emptyArticleBindingVersion{}
	fixedEvents := map[string]int{}
	terminalEvents := map[string]int{}
	for _, draft := range registry.Drafts {
		expected, err := emptyArticleBindingDraftSHA(draft)
		if err != nil || draft.DraftID == "" || draftIDs[draft.DraftID] || draft.LineageID == "" ||
			draft.ApprovalStatus != "PENDING_USER_FIX" || !emptyArticleBindingCatalogIdentityValid(draft.Catalog) ||
			!emptyArticleBindingDefinitionValid(draft.Definition) ||
			!emptyArticleBindingAuthorityValid(draft.Authority) || !emptyArticleBindingProvenanceValid(draft.Provenance, false) ||
			draft.CreatedAt.IsZero() || !draft.CreatedAt.Equal(draft.Provenance.RecordedAt) ||
			!strings.EqualFold(expected, draft.PayloadSHA256) {
			return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
		}
		draftIDs[draft.DraftID] = true
	}
	for _, version := range registry.Versions {
		key := version.LineageID + "\x00" + strconv.Itoa(version.Version)
		expected, err := emptyArticleBindingVersionSHA(version)
		if err != nil || version.BindingID == "" || versionIDs[version.BindingID] || version.LineageID == "" ||
			version.Version < 1 || lineageVersions[key] || version.ApprovalStatus != "FIXED" ||
			!emptyArticleBindingCatalogIdentityValid(version.Catalog) || !emptyArticleBindingDefinitionValid(version.Definition) ||
			!emptyArticleBindingAuthorityValid(version.Authority) ||
			!emptyArticleBindingProvenanceValid(version.Provenance, true) || version.FixedAt.IsZero() ||
			!version.FixedAt.Equal(version.Provenance.RecordedAt) ||
			!strings.EqualFold(expected, version.PayloadSHA256) {
			return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
		}
		versionIDs[version.BindingID] = true
		lineageVersions[key] = true
		versionsByID[version.BindingID] = version
	}
	for _, draft := range registry.Drafts {
		if draft.SourceBindingID != "" {
			source, ok := versionsByID[draft.SourceBindingID]
			if !ok || source.LineageID != draft.LineageID || source.Definition.Organization != draft.Definition.Organization {
				return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
			}
		}
	}
	for _, version := range registry.Versions {
		if version.SourceBindingID != "" {
			source, ok := versionsByID[version.SourceBindingID]
			if !ok || source.LineageID != version.LineageID || source.Version >= version.Version {
				return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
			}
		}
	}
	for _, event := range registry.LifecycleEvents {
		version, ok := versionsByID[event.BindingID]
		expected, err := emptyArticleBindingEventSHA(event)
		if err != nil || event.EventID == "" || eventIDs[event.EventID] || !ok ||
			version.Definition.Organization.ID != event.OrganizationID ||
			(event.Action != "FIXED" && event.Action != "DISABLED" && event.Action != "SUPERSEDED") ||
			event.OrganizationID != cleanBusinessText(event.OrganizationID, 200) ||
			event.Reason != cleanBusinessText(event.Reason, 500) || event.CreatedAt.IsZero() ||
			!strings.EqualFold(expected, event.PayloadSHA256) {
			return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
		}
		eventIDs[event.EventID] = true
		if event.Action == "FIXED" {
			fixedEvents[event.BindingID]++
		} else {
			terminalEvents[event.BindingID]++
		}
	}
	for id := range versionsByID {
		if fixedEvents[id] != 1 || terminalEvents[id] > 1 {
			return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
		}
	}
	active := emptyArticleBindingActiveVersions(registry)
	for i, left := range registry.Versions {
		if !active[left.BindingID] {
			continue
		}
		for _, right := range registry.Versions[i+1:] {
			if active[right.BindingID] && left.LineageID != right.LineageID && emptyArticleBindingDefinitionsOverlap(left.Definition, right.Definition) {
				return emptyArticleBindingFail(http.StatusConflict, "EMPTY_ARTICLE_BINDING_REGISTRY_INVALID")
			}
		}
	}
	return nil
}

func emptyArticleBindingVersionByID(registry emptyArticleBindingRegistry, bindingID string) (emptyArticleBindingVersion, bool) {
	for _, version := range registry.Versions {
		if version.BindingID == bindingID {
			return version, true
		}
	}
	return emptyArticleBindingVersion{}, false
}

func emptyArticleBindingActiveVersions(registry emptyArticleBindingRegistry) map[string]bool {
	active := make(map[string]bool, len(registry.Versions))
	for _, version := range registry.Versions {
		active[version.BindingID] = true
	}
	for _, event := range registry.LifecycleEvents {
		if event.Action == "DISABLED" || event.Action == "SUPERSEDED" {
			active[event.BindingID] = false
		}
	}
	return active
}

func emptyArticleBindingActiveLineageVersion(registry emptyArticleBindingRegistry, organizationID, lineageID string) string {
	active := emptyArticleBindingActiveVersions(registry)
	latest := emptyArticleBindingVersion{}
	for _, version := range registry.Versions {
		if active[version.BindingID] && version.Definition.Organization.ID == organizationID &&
			version.LineageID == lineageID && version.Version >= latest.Version {
			latest = version
		}
	}
	return latest.BindingID
}

func emptyArticleBindingRegistryOverlap(registry emptyArticleBindingRegistry, lineageID string, definition emptyArticleBindingDefinition) bool {
	active := emptyArticleBindingActiveVersions(registry)
	for _, version := range registry.Versions {
		if active[version.BindingID] && version.LineageID != lineageID && emptyArticleBindingDefinitionsOverlap(version.Definition, definition) {
			return true
		}
	}
	for _, draft := range registry.Drafts {
		if draft.LineageID != lineageID && emptyArticleBindingDefinitionsOverlap(draft.Definition, definition) {
			return true
		}
	}
	return false
}

func emptyArticleBindingDefinitionsOverlap(left, right emptyArticleBindingDefinition) bool {
	if left.Organization.ID != right.Organization.ID ||
		left.SourceParent.Identity != right.SourceParent.Identity ||
		left.Validity.ThroughMonth < right.Validity.FromMonth || right.Validity.ThroughMonth < left.Validity.FromMonth {
		return false
	}
	labels := map[string]bool{}
	for _, label := range left.SourceLabels {
		labels[strings.ToUpper(strings.Join(strings.Fields(label), " "))] = true
	}
	for _, label := range right.SourceLabels {
		if labels[strings.ToUpper(strings.Join(strings.Fields(label), " "))] {
			return true
		}
	}
	return false
}

func newEmptyArticleBindingEvent(action, bindingID, organizationID, reason string) (emptyArticleBindingLifecycleEvent, error) {
	eventID, err := newOpaqueID("eab_event")
	if err != nil {
		return emptyArticleBindingLifecycleEvent{}, err
	}
	event := emptyArticleBindingLifecycleEvent{
		EventID: eventID, Action: action, BindingID: bindingID,
		OrganizationID: organizationID, Reason: cleanBusinessText(reason, 500), CreatedAt: time.Now().UTC(),
	}
	event.PayloadSHA256, err = emptyArticleBindingEventSHA(event)
	return event, err
}

func emptyArticleBindingPublicDraft(draft emptyArticleBindingDraft) map[string]any {
	return map[string]any{
		"draft_id": draft.DraftID, "source_binding_id": draft.SourceBindingID,
		"lineage_id": draft.LineageID, "status": "DRAFT",
		"definition": draft.Definition, "catalog": emptyArticleBindingPublicCatalog(draft.Catalog), "created_at": draft.CreatedAt,
		"approval_status": "Ожидает явной фиксации пользователем",
		"authority":       emptyArticleBindingPublicAuthority(),
	}
}

func emptyArticleBindingPublicVersion(version emptyArticleBindingVersion, active bool) map[string]any {
	status := "INACTIVE"
	if active {
		status = "FIXED"
	}
	return map[string]any{
		"binding_id": version.BindingID, "source_binding_id": version.SourceBindingID,
		"lineage_id": version.LineageID, "version": version.Version, "status": status,
		"definition": version.Definition, "catalog": emptyArticleBindingPublicCatalog(version.Catalog), "fixed_at": version.FixedAt,
		"approval_status": "Зафиксировано пользователем",
		"authority":       emptyArticleBindingPublicAuthority(),
	}
}

func emptyArticleBindingPublicCatalog(catalog emptyArticleBindingCatalogIdentity) map[string]any {
	return map[string]any{
		"run_id": catalog.RunID, "context_id": catalog.ContextID, "inventory_id": catalog.InventoryID,
	}
}

func emptyArticleBindingPublicAuthority() map[string]any {
	return map[string]any{
		"mode": emptyArticleBindingMode, "operation": emptyArticleBindingOperation,
		"financial_rows": 0, "posting_rows": 0, "execution_allowed": false,
		"ready_to_upload": false, "release_allowed": false,
		"live_1c_allowed": false, "correction_authority": false,
	}
}

func emptyArticleBindingPublicRegistry(registry emptyArticleBindingRegistry, organization emptyArticleBindingOrganization) map[string]any {
	active := emptyArticleBindingActiveVersions(registry)
	drafts := []any{}
	for _, draft := range registry.Drafts {
		if draft.Definition.Organization == organization {
			drafts = append(drafts, emptyArticleBindingPublicDraft(draft))
		}
	}
	versions := []any{}
	for _, version := range registry.Versions {
		if version.Definition.Organization == organization {
			versions = append(versions, emptyArticleBindingPublicVersion(version, active[version.BindingID]))
		}
	}
	events := []any{}
	for _, event := range registry.LifecycleEvents {
		version, ok := emptyArticleBindingVersionByID(registry, event.BindingID)
		if !ok || version.Definition.Organization != organization {
			continue
		}
		events = append(events, map[string]any{
			"event_id": event.EventID, "action": event.Action,
			"binding_id": event.BindingID, "lineage_id": version.LineageID,
			"version": version.Version, "name": version.Definition.Name,
			"reason": event.Reason, "occurred_at": event.CreatedAt,
		})
	}
	return map[string]any{
		"registry_revision": registry.Revision, "organization": organization,
		"drafts": drafts, "versions": versions, "lifecycle_events": events,
		"semantic_status": emptyArticleBindingSemanticStatus,
		"decision":        emptyArticleBindingDecision, "operation": emptyArticleBindingOperation,
		"safety": reportOnlySafety(), "execution_allowed": false,
	}
}
