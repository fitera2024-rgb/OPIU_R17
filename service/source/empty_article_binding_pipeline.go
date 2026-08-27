package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	emptyArticleBindingSettingsSchema = "opiu-empty-article-binding-settings.v1"
	emptyArticleBindingSnapshotFile   = "empty-article-binding-settings.json"
)

type emptyArticleBindingSettingsOrganization struct {
	OrganizationID            string   `json:"organization_id"`
	OrganizationName          string   `json:"organization_name"`
	OrganizationHierarchyPath []string `json:"organization_hierarchy_path"`
}

type emptyArticleBindingSettingsAuthority struct {
	Type        string `json:"type"`
	Scope       string `json:"scope"`
	ApprovalID  string `json:"approval_id"`
	ApprovedBy  string `json:"approved_by"`
	ApprovedAt  string `json:"approved_at"`
	EvidenceRef string `json:"evidence_ref"`
}

type emptyArticleBindingSettingsSafety struct {
	Mode                     string `json:"mode"`
	ReportOnly               bool   `json:"report_only"`
	ClassificationOnly       bool   `json:"classification_only"`
	DecisionType             string `json:"decision_type"`
	CorrectionAuthority      bool   `json:"correction_authority"`
	PhysicalPostingAuthority bool   `json:"physical_posting_authority"`
	FinancialRows            int    `json:"financial_rows"`
	PostingRows              int    `json:"posting_rows"`
	ExecutedPostingRows      int    `json:"executed_posting_rows"`
	LivePostingRows          int    `json:"live_posting_rows"`
	ReadyToUpload            bool   `json:"ready_to_upload"`
	ReleaseAllowed           bool   `json:"release_allowed"`
	ExecutionAllowed         bool   `json:"execution_allowed"`
	Live1CAllowed            bool   `json:"live_1c_allowed"`
	LiveDeleteAllowed        bool   `json:"live_delete_allowed"`
}

type emptyArticleBindingSettingsValidity struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type emptyArticleBindingSettingsSource struct {
	ParentPath            []string `json:"parent_path"`
	LeafLabels            []string `json:"leaf_labels"`
	BlankAncestorRequired bool     `json:"blank_ancestor_required"`
}

type emptyArticleBindingSettingsTarget struct {
	TargetCode         string   `json:"target_code"`
	TargetNodeIdentity string   `json:"target_node_identity"`
	DisplayPath        []string `json:"display_path"`
	DisplayArticle     string   `json:"display_article"`
}

type emptyArticleBindingSettingsRule struct {
	BindingID    string                              `json:"binding_id"`
	Validity     emptyArticleBindingSettingsValidity `json:"validity"`
	Source       emptyArticleBindingSettingsSource   `json:"source"`
	Target       emptyArticleBindingSettingsTarget   `json:"target"`
	Mode         string                              `json:"mode"`
	DecisionType string                              `json:"decision_type"`
	AuthorityRef string                              `json:"authority_ref"`
}

type emptyArticleBindingSettingsSnapshot struct {
	Schema            string                                  `json:"schema"`
	SettingsID        string                                  `json:"settings_id"`
	OrganizationScope emptyArticleBindingSettingsOrganization `json:"organization_scope"`
	Authority         emptyArticleBindingSettingsAuthority    `json:"authority"`
	Safety            emptyArticleBindingSettingsSafety       `json:"safety"`
	Bindings          []emptyArticleBindingSettingsRule       `json:"bindings"`
}

func emptyArticleBindingSettingsNoPostingSafety() emptyArticleBindingSettingsSafety {
	return emptyArticleBindingSettingsSafety{
		Mode: "REPORT_ONLY", ReportOnly: true, ClassificationOnly: true, DecisionType: "NO_POSTING",
		CorrectionAuthority: false, PhysicalPostingAuthority: false,
		FinancialRows: 0, PostingRows: 0, ExecutedPostingRows: 0, LivePostingRows: 0,
		ReadyToUpload:  false,
		ReleaseAllowed: false, ExecutionAllowed: false, Live1CAllowed: false,
		LiveDeleteAllowed: false,
	}
}

func (p *Pipeline) materializeActiveEmptyArticleBindingSettings(run Run, contextValue Context, runDir string) (string, error) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		return "", err
	}
	base, err := secureBaseName(run.ID)
	if err != nil || base != run.ID {
		return "", errors.New("empty-article binding run identity is unsafe")
	}
	expectedRunDir := filepath.Join(p.store.RunsDir(), run.ID)
	absoluteRunDir, err := filepath.Abs(runDir)
	if err != nil || !sameFilesystemPath(expectedRunDir, absoluteRunDir) {
		return "", errors.New("empty-article binding snapshot is outside the exact run root")
	}
	periodFrom, periodTo, err := emptyArticleBindingPeriodRange(contextValue.Period)
	if err != nil {
		return "", err
	}
	organization := emptyArticleBindingOrganization{
		ID: contextValue.OrganizationID, Name: contextValue.OrganizationName,
		HierarchyPath: contextValue.OrganizationPath,
	}
	organizationSegments, err := emptyArticleBindingHierarchySegments(organization.HierarchyPath)
	if err != nil {
		return "", fmt.Errorf("exact organization hierarchy path is invalid: %w", err)
	}

	unlock, err := lockEmptyArticleBindingRegistryForStore(p.store)
	if err != nil {
		return "", err
	}
	registry, loadErr := loadEmptyArticleBindingRegistryForStore(p.store)
	unlock()
	if loadErr != nil {
		return "", loadErr
	}
	active := emptyArticleBindingActiveVersions(registry)
	selected := make([]emptyArticleBindingVersion, 0)
	for _, version := range registry.Versions {
		if !active[version.BindingID] || version.Definition.Organization != organization ||
			version.Definition.Validity.ThroughMonth < periodFrom || periodTo < version.Definition.Validity.FromMonth {
			continue
		}
		selected = append(selected, version)
	}
	if len(selected) == 0 {
		return "", nil
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].BindingID < selected[j].BindingID })
	settingsID := "eab_settings_" + run.ID
	approvalID := "eab_approval_" + run.ID
	approvedAt := selected[0].FixedAt
	bindingIDs := make([]string, 0, len(selected))
	rules := make([]emptyArticleBindingSettingsRule, 0, len(selected))
	for _, version := range selected {
		if version.FixedAt.After(approvedAt) {
			approvedAt = version.FixedAt
		}
		sourcePath, pathErr := emptyArticleBindingHierarchySegments(version.Definition.SourceParent.HierarchyPath)
		if pathErr != nil {
			return "", fmt.Errorf("exact source parent path is invalid for %s: %w", version.BindingID, pathErr)
		}
		targetPath, pathErr := emptyArticleBindingHierarchySegments(version.Definition.ERPTarget.HierarchyPath)
		if pathErr != nil {
			return "", fmt.Errorf("exact ERP target path is invalid for %s: %w", version.BindingID, pathErr)
		}
		if !emptyArticleBindingComparableText(targetPath[len(targetPath)-1], version.Definition.ERPTarget.Article) {
			return "", fmt.Errorf("exact ERP target path/article mismatch for %s", version.BindingID)
		}
		bindingIDs = append(bindingIDs, version.BindingID)
		rules = append(rules, emptyArticleBindingSettingsRule{
			BindingID: version.BindingID,
			Validity: emptyArticleBindingSettingsValidity{
				From: version.Definition.Validity.FromMonth,
				To:   version.Definition.Validity.ThroughMonth,
			},
			Source: emptyArticleBindingSettingsSource{
				ParentPath: sourcePath, LeafLabels: append([]string(nil), version.Definition.SourceLabels...),
				BlankAncestorRequired: true,
			},
			Target: emptyArticleBindingSettingsTarget{
				TargetCode:         version.Definition.ERPTarget.Code,
				TargetNodeIdentity: version.Definition.ERPTarget.Identity,
				DisplayPath:        targetPath, DisplayArticle: version.Definition.ERPTarget.Article,
			},
			Mode: "CLASSIFICATION_ONLY", DecisionType: "NO_POSTING", AuthorityRef: approvalID,
		})
	}
	snapshot := emptyArticleBindingSettingsSnapshot{
		Schema: emptyArticleBindingSettingsSchema, SettingsID: settingsID,
		OrganizationScope: emptyArticleBindingSettingsOrganization{
			OrganizationID: organization.ID, OrganizationName: organization.Name,
			OrganizationHierarchyPath: organizationSegments,
		},
		Authority: emptyArticleBindingSettingsAuthority{
			Type: "BUSINESS_APPROVED", Scope: "CLASSIFICATION_BINDING_ONLY",
			ApprovalID: approvalID, ApprovedBy: "Локальный пользователь",
			ApprovedAt:  approvedAt.UTC().Format(time.RFC3339Nano),
			EvidenceRef: "SERVICE_FIXED_EMPTY_ARTICLE_BINDINGS:" + strings.Join(bindingIDs, ","),
		},
		Safety: emptyArticleBindingSettingsNoPostingSafety(), Bindings: rules,
	}
	if err := validateEmptyArticleBindingSettingsSnapshot(snapshot, run, contextValue); err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return "", err
	}
	encoded = append(encoded, '\n')
	snapshotDir := filepath.Join(expectedRunDir, "r005-input")
	if err := os.MkdirAll(snapshotDir, 0o700); err != nil {
		return "", err
	}
	if err := rejectReparsePathComponents(snapshotDir); err != nil {
		return "", fmt.Errorf("empty-article binding snapshot directory is unsafe: %w", err)
	}
	snapshotPath := filepath.Join(snapshotDir, emptyArticleBindingSnapshotFile)
	if err := writeImmutablePrivateFile(snapshotPath, encoded); err != nil {
		return "", err
	}
	verifiedBytes, err := os.ReadFile(snapshotPath)
	if err != nil || !bytes.Equal(verifiedBytes, encoded) {
		return "", errors.New("empty-article binding run snapshot verification failed")
	}
	return snapshotPath, nil
}

func validateEmptyArticleBindingSettingsSnapshot(snapshot emptyArticleBindingSettingsSnapshot, run Run, contextValue Context) error {
	if snapshot.Schema != emptyArticleBindingSettingsSchema || snapshot.SettingsID != "eab_settings_"+run.ID ||
		snapshot.OrganizationScope.OrganizationID != contextValue.OrganizationID ||
		snapshot.OrganizationScope.OrganizationName != contextValue.OrganizationName ||
		len(snapshot.OrganizationScope.OrganizationHierarchyPath) == 0 ||
		strings.Join(snapshot.OrganizationScope.OrganizationHierarchyPath, " / ") != contextValue.OrganizationPath ||
		snapshot.Authority.Type != "BUSINESS_APPROVED" || snapshot.Authority.Scope != "CLASSIFICATION_BINDING_ONLY" ||
		snapshot.Authority.ApprovalID == "" || snapshot.Authority.ApprovedBy == "" || snapshot.Authority.ApprovedAt == "" ||
		snapshot.Authority.EvidenceRef == "" || snapshot.Safety != emptyArticleBindingSettingsNoPostingSafety() ||
		len(snapshot.Bindings) == 0 {
		return errors.New("empty-article binding run snapshot is invalid")
	}
	seen := map[string]bool{}
	for _, binding := range snapshot.Bindings {
		if binding.BindingID == "" || seen[binding.BindingID] || binding.Mode != "CLASSIFICATION_ONLY" ||
			binding.DecisionType != "NO_POSTING" || binding.AuthorityRef != snapshot.Authority.ApprovalID ||
			!emptyArticleBindingMonth.MatchString(binding.Validity.From) ||
			!emptyArticleBindingMonth.MatchString(binding.Validity.To) || binding.Validity.From > binding.Validity.To ||
			len(binding.Source.ParentPath) == 0 || len(binding.Source.LeafLabels) == 0 || !binding.Source.BlankAncestorRequired ||
			binding.Target.TargetCode == "" || binding.Target.TargetNodeIdentity == "" ||
			len(binding.Target.DisplayPath) == 0 || binding.Target.DisplayArticle == "" ||
			!emptyArticleBindingComparableText(binding.Target.DisplayPath[len(binding.Target.DisplayPath)-1], binding.Target.DisplayArticle) {
			return errors.New("empty-article binding run snapshot contains an invalid fixed binding")
		}
		seen[binding.BindingID] = true
	}
	return nil
}

func emptyArticleBindingPeriodRange(period string) (string, string, error) {
	period = cleanBusinessText(period, 12)
	if emptyArticleBindingMonth.MatchString(period) {
		return period, period, nil
	}
	if len(period) == 4 {
		if _, err := strconv.Atoi(period); err == nil {
			return period + "-01", period + "-12", nil
		}
	}
	if len(period) == 7 && period[4:6] == "-Q" {
		if _, err := strconv.Atoi(period[:4]); err != nil {
			return "", "", errors.New("empty-article binding quarter year is invalid")
		}
		quarter, err := strconv.Atoi(period[6:])
		if err == nil && quarter >= 1 && quarter <= 4 {
			first := (quarter-1)*3 + 1
			return fmt.Sprintf("%s-%02d", period[:4], first), fmt.Sprintf("%s-%02d", period[:4], first+2), nil
		}
	}
	return "", "", errors.New("empty-article binding requires a supported month, quarter or year period")
}

func emptyArticleBindingHierarchySegments(value string) ([]string, error) {
	value = cleanBusinessText(value, 1000)
	if value == "" {
		return nil, errors.New("hierarchy path is empty")
	}
	parts := strings.Split(value, " / ")
	segments := make([]string, 0, len(parts))
	for _, part := range parts {
		part = cleanBusinessText(part, 500)
		if part == "" {
			return nil, errors.New("hierarchy path contains an empty segment")
		}
		segments = append(segments, part)
	}
	return segments, nil
}

func emptyArticleBindingComparableText(left, right string) bool {
	normalize := func(value string) string {
		value = strings.ToLower(strings.Join(strings.Fields(value), " "))
		return strings.ReplaceAll(value, "ё", "е")
	}
	return normalize(left) == normalize(right)
}

func appendEmptyArticleBindingSettingsArgument(command []string, snapshotPath string) []string {
	result := append([]string(nil), command...)
	if strings.TrimSpace(snapshotPath) != "" {
		result = append(result, "--empty-article-binding-settings", snapshotPath)
	}
	return result
}
