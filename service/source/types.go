package main

import "time"

type SourceKind string

const (
	SourceERP     SourceKind = "erp"
	SourceIntalev SourceKind = "intalev"
)

type SourceFile struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Kind      SourceKind `json:"kind"`
	Size      int64      `json:"size"`
	CreatedAt time.Time  `json:"created_at"`
	DiskName  string     `json:"-"`
	SHA256    string     `json:"-"`
}

type Context struct {
	ID               string    `json:"id"`
	Organization     string    `json:"organization"`
	OrganizationID   string    `json:"organization_id,omitempty"`
	OrganizationName string    `json:"organization_name,omitempty"`
	OrganizationPath string    `json:"organization_path,omitempty"`
	CFO              string    `json:"cfo,omitempty"`
	Period           string    `json:"period"`
	ERPFileID        string    `json:"erp_file_id"`
	IntalevFileID    string    `json:"intalev_file_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
	Archived         bool      `json:"archived"`
}

type RunStatus string

const (
	RunQueued                     RunStatus = "QUEUED"
	RunPreflight                  RunStatus = "PREFLIGHT"
	RunRunning                    RunStatus = "RUNNING"
	RunCompletedReportOnly        RunStatus = "COMPLETED_REPORT_ONLY"
	RunWaitingUserRules           RunStatus = "WAITING_USER_RULES"
	RunBlockedEngineAdapter       RunStatus = "BLOCKED_ENGINE_ADAPTER"
	RunBlockedInvalidContext      RunStatus = "BLOCKED_INVALID_CONTEXT"
	RunBlockedStructuralInventory RunStatus = "BLOCKED_STRUCTURAL_INVENTORY"
	RunFailed                     RunStatus = "FAILED"
)

type Run struct {
	ID                     string                          `json:"id"`
	ContextID              string                          `json:"context_id"`
	Status                 RunStatus                       `json:"status"`
	Stage                  string                          `json:"stage"`
	Message                string                          `json:"message"`
	StartedAt              time.Time                       `json:"started_at"`
	FinishedAt             *time.Time                      `json:"finished_at,omitempty"`
	HasStructuralInventory bool                            `json:"has_structural_inventory"`
	StructuralControlSets  []StructuralControlSetReference `json:"structural_control_sets"`
	Safety                 SafetyState                     `json:"safety"`
}

// StructuralControlSetReference is the public, proof-free identity of an
// immutable settings version bound to one exact report-only run. Private
// inventory paths and SHA-256 anchors deliberately stay in the registry only.
type StructuralControlSetReference struct {
	ControlSetID     string    `json:"control_set_id"`
	LineageID        string    `json:"lineage_id"`
	Version          int       `json:"version"`
	Name             string    `json:"name"`
	OrganizationID   string    `json:"organization_id"`
	OrganizationName string    `json:"organization_name"`
	ContextID        string    `json:"context_id"`
	RunID            string    `json:"run_id"`
	InventoryID      string    `json:"inventory_id"`
	Author           string    `json:"author"`
	Mode             string    `json:"mode"`
	FixedAt          time.Time `json:"fixed_at"`
	Status           string    `json:"status"`
}

type Snapshot struct {
	ServiceVersion     string       `json:"service_version"`
	Implementation     string       `json:"implementation"`
	Safety             SafetyState  `json:"safety"`
	EngineAdapterReady bool         `json:"engine_adapter_ready"`
	Files              []SourceFile `json:"files"`
	Contexts           []Context    `json:"contexts"`
	Runs               []Run        `json:"runs"`
}

type createContextRequest struct {
	Organization     string `json:"organization"`
	OrganizationID   string `json:"organization_id,omitempty"`
	OrganizationName string `json:"organization_name,omitempty"`
	OrganizationPath string `json:"organization_path,omitempty"`
	CFO              string `json:"cfo"`
	Period           string `json:"period"`
	ERPFileID        string `json:"erp_file_id"`
	IntalevFileID    string `json:"intalev_file_id"`
}

type createRunRequest struct {
	ContextID string `json:"context_id"`
}

type apiError struct {
	Error string `json:"error"`
}
