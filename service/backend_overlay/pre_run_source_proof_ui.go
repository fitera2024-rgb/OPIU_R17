package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const missingOrganizationHierarchyV194 = "DATA_BLOCKED_ORGANIZATION_HIERARCHY_REFERENCE_MISSING"

func sourceProofBusinessMessageV194(blockers []string) string {
	for _, code := range blockers {
		switch strings.TrimSpace(code) {
		case "BLOCKED_SOURCE_PROOF_ORGANIZATION_REQUIRED":
			return "Выберите организацию."
		case "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH":
			return "Выберите период заново: источники относятся к другому периоду."
		case "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH":
			return "Источники относятся к другой организации. Выберите пакеты заново."
		case "DATA_BLOCKED_ORGANIZATION_HIERARCHY_REFERENCE_MISSING":
			return "Не загружен справочник организаций ERP. Обновите общие справочники."
		case "DATA_BLOCKED_ERP_SOURCE_REQUIRED":
			return "Не выбран пакет ERP. Загрузите или выберите его заново."
		case "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED":
			return "Не выбран пакет Инталев. Загрузите или выберите его заново."
		case "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE":
			return "Не удалось однозначно определить источник. Выберите пакет заново."
		case "BLOCKED_SOURCE_PROOF_HASH_DRIFT":
			return "Источник изменился во время проверки. Выберите пакет заново."
		case "BLOCKED_SOURCE_PROOF_EVIDENCE_SAFETY_CONTRACT_INVALID":
			return "Пакет источников не прошёл безопасную проверку. Передайте пакет в поддержку."
		}
	}
	return "Источники не готовы. Выберите пакеты ERP и Инталев заново."
}

func sourceProofBusinessBlockedV194(blockers []string) map[string]any {
	blockers = uniqueSortedV194(blockers)
	return map[string]any{
		"schema_version": "opiu-business-source-readiness.v1",
		"proof_status":   "BLOCKED_SOURCE_PROOF", "blocker_codes": blockers,
		"blocker_summary": strings.Join(blockers, ", "), "engine_prepare_allowed": false,
		"error": "SOURCE_PROOF_BLOCKED", "message": sourceProofBusinessMessageV194(blockers),
		"run_id": nil, "posting_rows": 0, "ready_to_upload": false,
		"release_allowed": false, "live_1c_allowed": false,
	}
}

func sourceProofBusinessErrorResponseV194(code, message string, runID any) map[string]any {
	return map[string]any{
		"error": code, "message": message, "run_id": runID,
		"posting_rows": 0, "ready_to_upload": false,
		"release_allowed": false, "live_1c_allowed": false,
	}
}

func sourceProofInputDisplayPathV194(inputsDir, path string) string {
	relative, err := filepath.Rel(inputsDir, path)
	if err != nil || strings.HasPrefix(relative, "..") {
		return ""
	}
	relative = filepath.ToSlash(relative)
	if relative == "." {
		return "Входные данные"
	}
	return relative
}

func sourceProofCandidateRootPathsV194(inputsDir string, inputFiles []preRunSourceFileV194, evidenceRoot map[string]any) []string {
	evidenceHashes := map[string]bool{}
	for _, raw := range anySlice(evidenceRoot["files"]) {
		file, _ := raw.(map[string]any)
		if file != nil {
			evidenceHashes[strings.ToUpper(strings.TrimSpace(asString(file["sha256"])))] = true
		}
	}
	paths := map[string]bool{}
	cleanInputs := filepath.Clean(inputsDir)
	for _, file := range inputFiles {
		if !evidenceHashes[strings.ToUpper(file.SHA256)] {
			continue
		}
		paths[filepath.Clean(file.Path)] = true
		for current := filepath.Dir(file.Path); ; current = filepath.Dir(current) {
			current = filepath.Clean(current)
			relative, err := filepath.Rel(cleanInputs, current)
			if err != nil || strings.HasPrefix(relative, "..") {
				break
			}
			paths[current] = true
			if current == cleanInputs || filepath.Dir(current) == current {
				break
			}
		}
	}
	out := make([]string, 0, len(paths))
	for path := range paths {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

func sourceProofRootCandidatesV194(inputsDir string, inputFiles []preRunSourceFileV194, evidenceRoot map[string]any) []any {
	expectedDigest := strings.ToUpper(strings.TrimSpace(asString(evidenceRoot["package_digest"])))
	if expectedDigest == "" {
		return []any{}
	}
	candidates := []any{}
	for _, path := range sourceProofCandidateRootPathsV194(inputsDir, inputFiles, evidenceRoot) {
		files, digest, blockers, err := scanSourceRootV194(path)
		if err != nil || len(blockers) > 0 || !strings.EqualFold(digest, expectedDigest) {
			continue
		}
		publicFiles := make([]any, 0, len(files))
		for _, file := range files {
			publicFiles = append(publicFiles, map[string]any{
				"relative_path": file.Relative,
				"sha256":        file.SHA256,
				"size":          file.Size,
			})
		}
		candidateKind := "UPLOADED_DIRECTORY"
		if info, statErr := os.Stat(path); statErr == nil && !info.IsDir() {
			candidateKind = "UPLOADED_FILE"
		}
		pathIdentity := pathIdentityV194(path)
		candidates = append(candidates, map[string]any{
			"candidate_id":               "ROOT-" + digestPrefixV194(pathIdentity),
			"display_path":               sourceProofInputDisplayPathV194(inputsDir, path),
			"request_path":               path,
			"path_identity_sha256":       pathIdentity,
			"package_digest_sha256":      digest,
			"approved_package_sha256":    expectedDigest,
			"candidate_kind":             candidateKind,
			"files":                      publicFiles,
			"requires_file_selection":    len(files) != 1,
			"selected_file_count_policy": "EXACTLY_ONE",
		})
	}
	return candidates
}

// sourceProofCanonicalPackageCandidatesV194 gives an exact uploaded file its
// persisted structural identity. Parent directories are scan conveniences, not
// additional business selections. Duplicate files remain ambiguous and folders
// are accepted only when their package digest identifies exactly one directory.
func sourceProofCanonicalPackageCandidatesV194(candidates []any) []any {
	uploadedFiles := []any{}
	for _, raw := range candidates {
		candidate, _ := raw.(map[string]any)
		if candidate != nil && asString(candidate["candidate_kind"]) == "UPLOADED_FILE" {
			uploadedFiles = append(uploadedFiles, candidate)
		}
	}
	if len(uploadedFiles) != 0 {
		return uploadedFiles
	}
	return candidates
}

func sourceProofEvidenceRootsV194(inputsDir string, inputFiles []preRunSourceFileV194, document map[string]any, settings map[string]any) []any {
	roots := []any{}
	for _, raw := range anySlice(document["roots"]) {
		root, _ := raw.(map[string]any)
		if root == nil {
			continue
		}
		role := strings.ToUpper(strings.TrimSpace(asString(root["declared_system"])))
		blockers := []string{}
		for _, blockerRaw := range anySlice(root["blockers"]) {
			if blocker, _ := blockerRaw.(map[string]any); blocker != nil {
				blockers = append(blockers, asString(blocker["code"]))
			} else {
				blockers = append(blockers, asString(blockerRaw))
			}
		}
		if role != "ERP" && role != "INTALEV" {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ROLE_MISMATCH")
		}
		organizationMatches := strings.TrimSpace(asString(root["organization_id"])) == strings.TrimSpace(asString(settings["organization_id"])) &&
			strings.TrimSpace(asString(root["expected_organization"])) == strings.TrimSpace(asString(settings["organization_name"]))
		periodMode := sourceProofEvidencePeriodModeV194(root)
		periodModeMatches := periodMode != "" && periodMode == strings.ToLower(strings.TrimSpace(asString(settings["period_mode"])))
		periodMatches := strings.TrimSpace(asString(root["expected_period"])) == strings.TrimSpace(asString(settings["period"])) && periodModeMatches
		if !organizationMatches {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH")
		}
		if !periodMatches {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
		}
		candidates := sourceProofRootCandidatesV194(inputsDir, inputFiles, root)
		if len(candidates) == 0 {
			blockers = append(blockers, "DATA_BLOCKED_SOURCE_ROOT_MISSING")
		}
		roots = append(roots, map[string]any{
			"root_id":                   safeID(asString(root["root_id"])),
			"role":                      role,
			"organization_id":           strings.TrimSpace(asString(root["organization_id"])),
			"organization_name":         strings.TrimSpace(asString(root["expected_organization"])),
			"period_mode":               periodMode,
			"period":                    strings.TrimSpace(asString(root["expected_period"])),
			"status":                    strings.TrimSpace(asString(root["status"])),
			"package_digest_sha256":     strings.ToUpper(strings.TrimSpace(asString(root["package_digest"]))),
			"context_matches":           organizationMatches && periodMatches,
			"organization_matches":      organizationMatches,
			"period_mode_matches":       periodModeMatches,
			"period_matches":            periodMatches,
			"blocker_codes":             uniqueSortedV194(blockers),
			"candidates":                candidates,
			"requires_root_selection":   len(candidates) != 1,
			"source_identity_authority": "APPROVED_EVIDENCE_BYTES",
		})
	}
	sort.Slice(roots, func(i, j int) bool {
		left := roots[i].(map[string]any)
		right := roots[j].(map[string]any)
		return asString(left["role"])+asString(left["root_id"]) < asString(right["role"])+asString(right["root_id"])
	})
	return roots
}

func sourceProofReferenceReadyV194(referenceStatus map[string]any, organizations map[string]any) (bool, string) {
	erp, _ := referenceStatus["erp_shared"].(map[string]any)
	if erp == nil || asString(erp["status"]) != "PINNED" || len(anySlice(organizations["nodes"])) == 0 {
		return false, missingOrganizationHierarchyV194
	}
	return true, ""
}

func sourceProofEvidencePeriodModeV194(root map[string]any) string {
	if mode := strings.ToLower(strings.TrimSpace(asString(root["expected_period_mode"]))); mode != "" {
		return mode
	}
	period := strings.ToUpper(strings.TrimSpace(asString(root["expected_period"])))
	switch {
	case monthPeriodV180.MatchString(period):
		return "month"
	case quarterPeriodV180.MatchString(period):
		return "quarter"
	case yearPeriodV180.MatchString(period):
		return "year"
	default:
		return ""
	}
}

func (a *App) preRunSourceProofOptionsV194(settings, organizations, referenceStatus map[string]any) map[string]any {
	configuredSHA := strings.ToUpper(strings.TrimSpace(asString(settings["approved_source_evidence_sha256"])))
	configuredInput := safeRelativeFilePath(asString(settings["approved_source_evidence_input"]))
	inputFiles, _, _, scanErr := scanSourceRootV194(a.InputsDir)
	evidenceCandidates := []any{}
	if scanErr == nil {
		for _, file := range inputFiles {
			if !strings.EqualFold(filepath.Ext(file.Relative), ".json") {
				continue
			}
			document, _, actualSHA, evidenceBlockers, err := readSourceEvidenceV194(file.Path)
			if err != nil || document == nil {
				continue
			}
			safetyValid := len(evidenceBlockers) == 0
			evidenceCandidates = append(evidenceCandidates, map[string]any{
				"candidate_id":         "EVID-" + digestPrefixV194(actualSHA),
				"input_name":           file.Relative,
				"request_path":         file.Path,
				"path_identity_sha256": pathIdentityV194(file.Path),
				"sha256":               actualSHA,
				"size":                 file.Size,
				"schema":               asString(document["schema"]),
				"report_only":          asBool(document["report_only"]),
				"safety_valid":         safetyValid,
				"blocker_codes":        evidenceBlockers,
				"approved":             safetyValid && strings.EqualFold(configuredSHA, actualSHA) && strings.EqualFold(configuredInput, file.Relative),
				"roots":                sourceProofEvidenceRootsV194(a.InputsDir, inputFiles, document, settings),
			})
		}
	}
	sort.Slice(evidenceCandidates, func(i, j int) bool {
		return asString(evidenceCandidates[i].(map[string]any)["input_name"]) < asString(evidenceCandidates[j].(map[string]any)["input_name"])
	})
	referenceReady, referenceBlocker := sourceProofReferenceReadyV194(referenceStatus, organizations)
	blockers := []string{}
	if strings.TrimSpace(asString(settings["organization_id"])) == "" || strings.TrimSpace(asString(settings["organization_name"])) == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_REQUIRED")
	}
	if strings.TrimSpace(asString(settings["period"])) == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
	}
	if !referenceReady {
		blockers = append(blockers, referenceBlocker)
	}
	if len(evidenceCandidates) == 0 {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_REQUIRED")
	}
	approvedCandidateFound := false
	for _, raw := range evidenceCandidates {
		candidate := raw.(map[string]any)
		approvedCandidateFound = approvedCandidateFound || asBool(candidate["approved"])
	}
	if configuredSHA == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_APPROVAL_REQUIRED")
	} else if !approvedCandidateFound {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_UNAPPROVED")
	}
	return map[string]any{
		"schema_version": "opiu-source-proof-ui-options.v1",
		"required":       asBool(settings["source_proof_required"]),
		"context": map[string]any{
			"organization_id":   settings["organization_id"],
			"organization_name": settings["organization_name"],
			"organization_path": settings["organization_path"],
			"period_mode":       settings["period_mode"],
			"period":            settings["period"],
		},
		"configured_evidence_sha256": configuredSHA,
		"configured_evidence_input":  configuredInput,
		"evidence_candidates":        evidenceCandidates,
		"reference_ready":            referenceReady,
		"reference_status":           referenceStatus["erp_shared"],
		"blocker_codes":              uniqueSortedV194(blockers),
		"posting_rows":               0,
		"ready_to_upload":            false,
		"release_allowed":            false,
		"live_1c_allowed":            false,
	}
}

func sourceProofRoleRequiredCodeV194(role string) string {
	if role == "ERP" {
		return "DATA_BLOCKED_ERP_SOURCE_REQUIRED"
	}
	return "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED"
}

func canonicalBusinessSourceFileV194(file preRunSourceFileV194) bool {
	switch strings.ToLower(filepath.Ext(file.Relative)) {
	case ".csv", ".mxl", ".xls", ".xlsx", ".xlsm", ".zip":
		return true
	default:
		return false
	}
}

func canonicalPersistedRoleNameMatchesV194(settings map[string]any, role, relative string) bool {
	roles, _ := settings["input_roles"].(map[string]any)
	if roles == nil {
		return false
	}
	configured := safeRelativeFilePath(asString(roles[strings.ToLower(role)]))
	return configured != "" && strings.EqualFold(filepath.ToSlash(configured), filepath.ToSlash(relative))
}

func canonicalPersistedRoleV194(role string, file preRunSourceFileV194, settings map[string]any) (preRunSourceRoleV194, []string) {
	result := preRunSourceRoleV194{
		Role: role, RootID: "CANON-" + role + "-" + digestPrefixV194(file.SHA256),
		OrganizationID:   strings.TrimSpace(asString(settings["organization_id"])),
		OrganizationName: strings.TrimSpace(asString(settings["organization_name"])),
		Period:           strings.TrimSpace(asString(settings["period"])), RootPath: file.Path,
		SelectedPath: file.Path, SelectedSHA256: file.SHA256, SelectedSize: file.Size,
		Files: []preRunSourceFileV194{file}, RootPathIdentity: pathIdentityV194(file.Path),
		SelectedPathIdentity: pathIdentityV194(file.Path),
	}
	_, packageDigest, blockers, err := scanSourceRootV194(file.Path)
	if err != nil {
		return result, []string{"BLOCKED_SOURCE_PROOF_SOURCE_SCAN_FAILED"}
	}
	result.PackageDigestSHA256 = packageDigest
	result.ApprovedDigestSHA256 = packageDigest
	return result, blockers
}

// canonicalPersistedSourceProofV194 resolves the normal user upload flow from
// server-owned state only. The active Intalev package supplies an exact
// relative path/hash identity; ERP is accepted only when exactly one other
// business source remains and both persisted role names match those exact
// files. No filename scoring, recency, client path, or client proof is used.
func (a *App) canonicalPersistedSourceProofV194(settings, organizations, referenceStatus map[string]any) (*preRunSourceProofV194, map[string]any, []string) {
	blockers := []string{}
	organizationID := strings.TrimSpace(asString(settings["organization_id"]))
	organizationName := strings.TrimSpace(asString(settings["organization_name"]))
	periodMode := strings.ToLower(strings.TrimSpace(asString(settings["period_mode"])))
	period := strings.TrimSpace(asString(settings["period"]))
	if organizationID == "" || organizationName == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_REQUIRED")
	}
	if periodMode == "" || period == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
	}
	if ready, code := sourceProofReferenceReadyV194(referenceStatus, organizations); !ready {
		blockers = append(blockers, code)
	}
	inputFiles, _, scanBlockers, err := scanSourceRootV194(a.InputsDir)
	if err != nil {
		return nil, nil, []string{"BLOCKED_SOURCE_PROOF_SOURCE_SCAN_FAILED"}
	}
	blockers = append(blockers, scanBlockers...)
	businessFiles := []preRunSourceFileV194{}
	for _, file := range inputFiles {
		if canonicalBusinessSourceFileV194(file) {
			businessFiles = append(businessFiles, file)
		}
	}

	intalevStatus, _ := referenceStatus["intalev"].(map[string]any)
	intalevSources := []any{}
	if intalevStatus != nil && strings.EqualFold(asString(intalevStatus["status"]), "ACTIVE") {
		intalevSources = anySlice(intalevStatus["source_files"])
	}
	if len(intalevSources) == 0 {
		blockers = append(blockers, "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED")
	}
	intalevOrigins := map[string]bool{}
	for _, key := range []string{"cfo_catalog", "bdr_articles"} {
		catalog, _ := intalevStatus[key].(map[string]any)
		if catalog == nil {
			continue
		}
		if origin := safeRelativeFilePath(asString(catalog["source_path"])); origin != "" {
			intalevOrigins[filepath.ToSlash(origin)] = true
		}
	}
	selectedIntalevSources := []map[string]any{}
	if len(intalevOrigins) == 1 {
		origin := ""
		for value := range intalevOrigins {
			origin = value
		}
		for _, raw := range intalevSources {
			source, _ := raw.(map[string]any)
			if source != nil && strings.EqualFold(filepath.ToSlash(safeRelativeFilePath(asString(source["relative_path"]))), origin) {
				selectedIntalevSources = append(selectedIntalevSources, source)
			}
		}
	} else if len(intalevOrigins) == 0 && len(intalevSources) == 1 {
		if source, _ := intalevSources[0].(map[string]any); source != nil {
			selectedIntalevSources = append(selectedIntalevSources, source)
		}
	} else if len(intalevSources) != 0 {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
	}

	var intalevFile preRunSourceFileV194
	intalevMatches := []preRunSourceFileV194{}
	if len(selectedIntalevSources) == 1 {
		source := selectedIntalevSources[0]
		relative := safeRelativeFilePath(asString(source["relative_path"]))
		expectedSHA := strings.ToUpper(strings.TrimSpace(asString(source["sha256"])))
		expectedSize := int64(asFloat(source["size"]))
		if relative == "" || expectedSHA == "" || expectedSize <= 0 {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_SAFETY_CONTRACT_INVALID")
		} else {
			for _, file := range businessFiles {
				if strings.EqualFold(filepath.ToSlash(file.Relative), filepath.ToSlash(relative)) &&
					strings.EqualFold(file.SHA256, expectedSHA) && file.Size == expectedSize {
					intalevMatches = append(intalevMatches, file)
				}
			}
		}
	}
	if len(intalevMatches) == 1 {
		intalevFile = intalevMatches[0]
		if !canonicalPersistedRoleNameMatchesV194(settings, "INTALEV", intalevFile.Relative) {
			blockers = append(blockers, "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED")
		}
	} else if len(intalevSources) != 0 {
		if len(intalevMatches) == 0 {
			blockers = append(blockers, "DATA_BLOCKED_INTALEV_SOURCE_REQUIRED")
		} else {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
		}
	}

	erpCandidates := []preRunSourceFileV194{}
	for _, file := range businessFiles {
		if intalevFile.Path != "" && filepath.Clean(file.Path) == filepath.Clean(intalevFile.Path) {
			continue
		}
		erpCandidates = append(erpCandidates, file)
	}
	var erpFile preRunSourceFileV194
	if len(erpCandidates) == 1 {
		erpFile = erpCandidates[0]
		if !canonicalPersistedRoleNameMatchesV194(settings, "ERP", erpFile.Relative) {
			blockers = append(blockers, "DATA_BLOCKED_ERP_SOURCE_REQUIRED")
		}
	} else if len(erpCandidates) == 0 {
		blockers = append(blockers, "DATA_BLOCKED_ERP_SOURCE_REQUIRED")
	} else {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
	}
	blockers = uniqueSortedV194(blockers)
	if len(blockers) != 0 {
		return nil, nil, blockers
	}

	intalevRole, intalevBlockers := canonicalPersistedRoleV194("INTALEV", intalevFile, settings)
	erpRole, erpBlockers := canonicalPersistedRoleV194("ERP", erpFile, settings)
	blockers = uniqueSortedV194(append(intalevBlockers, erpBlockers...))
	if len(blockers) != 0 {
		return nil, nil, blockers
	}
	roles := []preRunSourceRoleV194{erpRole, intalevRole}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Role < roles[j].Role })
	rolePublic := []any{}
	selectionBasis := []any{}
	packageBasis := []any{}
	businessSources := map[string]any{}
	for _, role := range roles {
		public := sourceRolePublicV194(role)
		rolePublic = append(rolePublic, public)
		selectionBasis = append(selectionBasis, map[string]any{
			"role": role.Role, "relative_path": role.Files[0].Relative,
			"sha256": role.SelectedSHA256, "size": role.SelectedSize,
		})
		packageBasis = append(packageBasis, map[string]any{
			"role": role.Role, "root_id": role.RootID,
			"package_digest_sha256": role.PackageDigestSHA256,
			"selected_file_sha256":  role.SelectedSHA256,
		})
		name := filepath.Base(filepath.FromSlash(role.Files[0].Relative))
		businessSources[strings.ToLower(role.Role)] = map[string]any{"package_name": name, "input_name": name}
	}
	selectionDigest := digestJSONV194(map[string]any{
		"schema_version":   "opiu-canonical-persisted-source-selection.v1",
		"context_revision": settings["context_revision"],
		"organization_id":  organizationID, "organization_name": organizationName,
		"period_mode": periodMode, "period": period, "sources": selectionBasis,
	})
	packageDigest := digestJSONV194(packageBasis)
	basis := map[string]any{
		"schema_version": preRunSourceProofSchemaV194,
		"organization":   map[string]any{"id": organizationID, "name": organizationName},
		"period_mode":    periodMode, "period": period, "source_roles": rolePublic,
		"approved_evidence_sha256": selectionDigest,
		"package_digest_sha256":    packageDigest, "blocker_codes": []string{},
	}
	proofDigest := digestJSONV194(basis)
	public := map[string]any{
		"schema_version": preRunSourceProofSchemaV194,
		"organization":   basis["organization"], "period_mode": periodMode, "period": period,
		"source_roles": rolePublic, "package_id": "PKGCTX-" + proofDigest[:20],
		"approved_evidence_sha256": selectionDigest,
		"package_digest_sha256":    packageDigest, "proof_digest_sha256": proofDigest,
		"proof_status": "PASS", "blocker_codes": []string{}, "blocker_summary": "",
		"engine_prepare_allowed": true, "error": "", "message": "Source proof PASS",
		"run_id": nil, "posting_rows": 0, "ready_to_upload": false,
		"release_allowed": false, "live_1c_allowed": false,
	}
	business := map[string]any{
		"ready": true, "status": "READY", "message": "РСЃС‚РѕС‡РЅРёРєРё РіРѕС‚РѕРІС‹",
		"organization_name": organizationName, "period": period, "sources": businessSources,
		"posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
	}
	return &preRunSourceProofV194{Public: public, Roles: roles, Digest: proofDigest, Allowed: true}, business, nil
}

// canonicalSourceProofV194 is the server-only bridge from the persisted input
// inventory to the existing exact proof contract. It never guesses by name or
// recency: exactly one safe evidence document, one root, one package candidate
// and one selected file must be provable for each required business role.
func (a *App) canonicalSourceProofV194(settings, organizations, referenceStatus map[string]any) (map[string]any, map[string]any, []string) {
	options := a.preRunSourceProofOptionsV194(settings, organizations, referenceStatus)
	blockers := []string{}
	for _, code := range stringSliceV194(options["blocker_codes"]) {
		switch code {
		case "BLOCKED_SOURCE_PROOF_EVIDENCE_APPROVAL_REQUIRED", "BLOCKED_SOURCE_PROOF_EVIDENCE_UNAPPROVED":
			// Manual evidence approval belongs to the retired technical UI. The
			// server still validates exact bytes and the REPORT_ONLY contract.
		default:
			blockers = append(blockers, code)
		}
	}
	type exactCandidate struct {
		evidence map[string]any
		roots    map[string]map[string]any
		packages map[string]map[string]any
		files    map[string]map[string]any
	}
	valid := []exactCandidate{}
	candidateBlockers := []string{}
	for _, rawEvidence := range anySlice(options["evidence_candidates"]) {
		evidence, _ := rawEvidence.(map[string]any)
		if evidence == nil {
			continue
		}
		local := append([]string{}, stringSliceV194(evidence["blocker_codes"])...)
		if !asBool(evidence["safety_valid"]) {
			local = append(local, "BLOCKED_SOURCE_PROOF_EVIDENCE_SAFETY_CONTRACT_INVALID")
		}
		item := exactCandidate{evidence: evidence, roots: map[string]map[string]any{}, packages: map[string]map[string]any{}, files: map[string]map[string]any{}}
		for _, rawRoot := range anySlice(evidence["roots"]) {
			root, _ := rawRoot.(map[string]any)
			if root == nil {
				continue
			}
			role := strings.ToUpper(strings.TrimSpace(asString(root["role"])))
			if role != "ERP" && role != "INTALEV" {
				local = append(local, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
				continue
			}
			if item.roots[role] != nil {
				local = append(local, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
				continue
			}
			item.roots[role] = root
			local = append(local, stringSliceV194(root["blocker_codes"])...)
			if !asBool(root["organization_matches"]) {
				local = append(local, "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH")
			}
			if !asBool(root["period_matches"]) {
				local = append(local, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
			}
			packages := sourceProofCanonicalPackageCandidatesV194(anySlice(root["candidates"]))
			if len(packages) == 0 {
				local = append(local, sourceProofRoleRequiredCodeV194(role))
				continue
			}
			if len(packages) != 1 {
				local = append(local, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
				continue
			}
			candidate, _ := packages[0].(map[string]any)
			if candidate == nil {
				local = append(local, sourceProofRoleRequiredCodeV194(role))
				continue
			}
			files := anySlice(candidate["files"])
			if len(files) == 0 {
				local = append(local, sourceProofRoleRequiredCodeV194(role))
				continue
			}
			if len(files) != 1 {
				local = append(local, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
				continue
			}
			file, _ := files[0].(map[string]any)
			if file == nil || strings.TrimSpace(asString(file["sha256"])) == "" {
				local = append(local, sourceProofRoleRequiredCodeV194(role))
				continue
			}
			item.packages[role] = candidate
			item.files[role] = file
		}
		for _, role := range []string{"ERP", "INTALEV"} {
			if item.roots[role] == nil {
				local = append(local, sourceProofRoleRequiredCodeV194(role))
			}
		}
		local = uniqueSortedV194(local)
		if len(local) == 0 {
			valid = append(valid, item)
		} else {
			candidateBlockers = append(candidateBlockers, local...)
		}
	}
	if len(valid) != 1 {
		if len(valid) > 1 {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE")
		} else if len(anySlice(options["evidence_candidates"])) == 0 {
			blockers = append(blockers, "DATA_BLOCKED_SOURCE_PROOF_REQUIRED")
		} else {
			blockers = append(blockers, candidateBlockers...)
		}
		return nil, nil, uniqueSortedV194(blockers)
	}
	if len(blockers) != 0 {
		return nil, nil, uniqueSortedV194(blockers)
	}
	selected := valid[0]
	proof := map[string]any{
		"organization_id": settings["organization_id"], "organization_name": settings["organization_name"],
		"period_mode": settings["period_mode"], "period": settings["period"],
		"evidence_path":            selected.evidence["request_path"],
		"approved_evidence_sha256": strings.ToUpper(asString(selected.evidence["sha256"])),
	}
	roleRequests := []any{}
	businessSources := map[string]any{}
	for _, role := range []string{"ERP", "INTALEV"} {
		root, candidate, file := selected.roots[role], selected.packages[role], selected.files[role]
		roleRequests = append(roleRequests, map[string]any{
			"role": role, "root_id": root["root_id"], "path": candidate["request_path"],
			"selected_file_sha256": strings.ToUpper(asString(file["sha256"])),
		})
		packageName := filepath.Base(filepath.FromSlash(asString(candidate["display_path"])))
		inputName := filepath.Base(filepath.FromSlash(asString(file["relative_path"])))
		businessSources[strings.ToLower(role)] = map[string]any{"package_name": packageName, "input_name": inputName}
	}
	proof["source_roots"] = roleRequests
	business := map[string]any{
		"ready": true, "status": "READY", "message": "Источники готовы",
		"organization_name": settings["organization_name"], "period": settings["period"],
		"sources":      businessSources,
		"posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
		"evidence_input": selected.evidence["input_name"],
	}
	return proof, business, nil
}

func (a *App) sourceProofBusinessReadinessV194(settings, organizations, referenceStatus map[string]any) map[string]any {
	if proof, business, blockers := a.canonicalPersistedSourceProofV194(settings, organizations, referenceStatus); proof != nil && len(blockers) == 0 {
		return business
	}
	_, business, blockers := a.canonicalSourceProofV194(settings, organizations, referenceStatus)
	if len(blockers) == 0 {
		// The evidence filename is server-only provenance, not a business UI field.
		delete(business, "evidence_input")
		return business
	}
	return map[string]any{
		"ready": false, "status": "BLOCKED", "message": sourceProofBusinessMessageV194(blockers),
		"organization_name": settings["organization_name"], "period": settings["period"],
		"sources":      map[string]any{},
		"posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
	}
}

func copyPublicFieldsV194(source map[string]any, fields ...string) map[string]any {
	public := map[string]any{}
	for _, field := range fields {
		if value, ok := source[field]; ok {
			public[field] = value
		}
	}
	return public
}

func sourceProofPublicSettingsV194(settings map[string]any) map[string]any {
	public := copyPublicFieldsV194(settings,
		"organization", "organization_id", "organization_name", "organization_path",
		"include_descendants", "period_mode", "period", "author", "active_run_id",
		"workflow_stage", "context_revision", "updated_at",
	)
	if materialsRootURL := materialPublicHTTPURLV194(settings["materials_root_url"]); materialsRootURL != "" {
		public["materials_root_url"] = materialsRootURL
	}
	return public
}

func (a *App) sourceProofPublicRunsV194(runs []any, settings map[string]any) []any {
	activeRunID := asString(settings["active_run_id"])
	publicRuns := make([]any, 0, len(runs))
	for _, raw := range runs {
		run, _ := raw.(map[string]any)
		if run == nil {
			continue
		}
		public := copyPublicFieldsV194(run,
			"run_id", "organization_id", "organization_name", "organization_path",
			"period_mode", "period", "author", "stage", "created_at", "updated_at",
		)
		valid := false
		if asString(run["run_id"]) == activeRunID && runRequiresPreRunProofV194(run) {
			_, err := validateStoredPreRunProofV194(run)
			valid = err == nil
		}
		public["source_proof_valid"] = valid
		public["rules_available"] = valid
		r001Available := false
		if valid {
			_, err := a.verifiedR001HandoffBindingV194(map[string]any{"run_id": activeRunID}, settings)
			r001Available = err == nil
		}
		public["r001_available"] = r001Available
		publicRuns = append(publicRuns, public)
	}
	return publicRuns
}

func sourceProofPublicReferenceStatusV194(status map[string]any) map[string]any {
	public := map[string]any{}
	if erp, _ := status["erp_shared"].(map[string]any); erp != nil {
		item := copyPublicFieldsV194(erp, "status", "catalog_set_id", "immutable")
		catalogs := []any{}
		for _, raw := range anySlice(erp["catalogs"]) {
			catalog, _ := raw.(map[string]any)
			if catalog != nil {
				catalogs = append(catalogs, copyPublicFieldsV194(catalog, "role", "catalog_type", "title", "items_count"))
			}
		}
		item["catalogs"] = catalogs
		public["erp_shared"] = item
	}
	if intalev, _ := status["intalev"].(map[string]any); intalev != nil {
		item := copyPublicFieldsV194(intalev, "status", "package_id", "immutable")
		for _, field := range []string{"cfo_catalog", "bdr_articles"} {
			if catalog, _ := intalev[field].(map[string]any); catalog != nil {
				item[field] = copyPublicFieldsV194(catalog, "source_name", "items_count", "status")
			}
		}
		public["intalev"] = item
	}
	return public
}

func sourceProofPublicCatalogsV194(catalogs []any) []any {
	public := make([]any, 0, len(catalogs))
	for _, raw := range catalogs {
		catalog, _ := raw.(map[string]any)
		if catalog != nil {
			public = append(public, copyPublicFieldsV194(catalog,
				"catalog_id", "catalog_type", "system", "title", "status", "scope", "items_count", "scope_node_name",
			))
		}
	}
	return public
}

func sourceProofPublicArtifactsV194(artifacts []any) []any {
	public := make([]any, 0, len(artifacts))
	for _, raw := range artifacts {
		artifact, _ := raw.(map[string]any)
		if artifact != nil {
			public = append(public, copyPublicFieldsV194(artifact,
				"artifact_id", "name", "artifact_type", "run_id", "period", "stage", "size", "created_at", "updated_at",
			))
		}
	}
	return public
}
