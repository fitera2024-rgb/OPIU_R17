package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const preRunSourceProofSchemaV194 = "opiu-pre-run-source-proof.v1"
const preRunSourceContractMarkerV194 = "PRE_RUN_SOURCE_PROOF_REQUIRED_V194"

type preRunSourceBlockedErrorV194 struct {
	Result map[string]any
}

func (e *preRunSourceBlockedErrorV194) Error() string {
	return strings.Join(stringSliceV194(e.Result["blocker_codes"]), ",")
}

type preRunSourceFileV194 struct {
	Path     string
	Relative string
	Size     int64
	SHA256   string
}

type preRunSourceRoleV194 struct {
	Role                 string
	RootID               string
	OrganizationID       string
	OrganizationName     string
	Period               string
	RootPath             string
	PackageDigestSHA256  string
	ApprovedDigestSHA256 string
	SelectedPath         string
	SelectedSHA256       string
	SelectedSize         int64
	Files                []preRunSourceFileV194
	RootPathIdentity     string
	SelectedPathIdentity string
}

type preRunSourceProofV194 struct {
	Public  map[string]any
	Roles   []preRunSourceRoleV194
	Digest  string
	Allowed bool
}

var sourceExtensionsV194 = map[string]bool{
	".csv": true, ".json": true, ".mxl": true, ".pdf": true,
	".xls": true, ".xlsx": true, ".xlsm": true, ".zip": true,
}

func stringSliceV194(value any) []string {
	out := []string{}
	if direct, ok := value.([]string); ok {
		for _, raw := range direct {
			if text := strings.TrimSpace(raw); text != "" {
				out = append(out, text)
			}
		}
		return out
	}
	for _, raw := range anySlice(value) {
		if text := strings.TrimSpace(asString(raw)); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func digestPrefixV194(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) >= 20 {
		return value[:20]
	}
	if value == "" {
		return "UNAVAILABLE"
	}
	return value
}

func uniqueSortedV194(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func digestJSONV194(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func preRunProofRequestV194(body map[string]any) map[string]any {
	proof, _ := body["source_proof"].(map[string]any)
	if proof == nil {
		proof = map[string]any{}
	}
	return proof
}

func sourceProofRequiredV194(body, settings map[string]any) bool {
	if asBool(settings["source_proof_required"]) || asBool(body["preflight_only"]) || strings.TrimSpace(asString(body["expected_preflight_digest_sha256"])) != "" {
		return true
	}
	proof, ok := body["source_proof"].(map[string]any)
	return ok && proof != nil
}

func pathIdentityV194(path string) string {
	absolute, err := filepath.Abs(filepath.Clean(strings.TrimSpace(path)))
	if err != nil {
		absolute = filepath.Clean(strings.TrimSpace(path))
	}
	return digestJSONV194(map[string]any{"normalized_absolute_path": strings.ToLower(filepath.ToSlash(absolute))})
}

func pathWithinV194(root, candidate string) bool {
	root = strings.TrimSpace(root)
	candidate = strings.TrimSpace(candidate)
	if root == "" || candidate == "" {
		return false
	}
	rootAbs, rootErr := filepath.Abs(filepath.Clean(root))
	candidateAbs, candidateErr := filepath.Abs(filepath.Clean(candidate))
	if rootErr != nil || candidateErr != nil {
		return false
	}
	relative, err := filepath.Rel(rootAbs, candidateAbs)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

func readSourceEvidenceV194(path string) (map[string]any, map[string]map[string]any, string, []string, error) {
	blockers := []string{}
	data, err := os.ReadFile(filepath.Clean(path))
	if errors.Is(err, os.ErrNotExist) {
		return nil, map[string]map[string]any{}, "", []string{"DATA_BLOCKED_SOURCE_PROOF_EVIDENCE_MISSING"}, nil
	}
	if err != nil {
		return nil, nil, "", nil, err
	}
	if len(data) == 0 || int64(len(data)) > maxJSONBytes {
		return nil, map[string]map[string]any{}, "", []string{"BLOCKED_SOURCE_PROOF_EVIDENCE_INVALID"}, nil
	}
	sum := sha256.Sum256(data)
	actual := strings.ToUpper(hex.EncodeToString(sum[:]))
	document := map[string]any{}
	if json.Unmarshal(data, &document) != nil {
		return nil, map[string]map[string]any{}, actual, []string{"BLOCKED_SOURCE_PROOF_EVIDENCE_INVALID"}, nil
	}
	if !strings.HasPrefix(strings.TrimSpace(asString(document["schema"])), "opiu-issue-") ||
		!asBool(document["report_only"]) || int(asFloat(document["posting_rows"])) != 0 ||
		asBool(document["ready_to_upload"]) || asBool(document["release_allowed"]) ||
		asBool(document["live_1c_allowed"]) || asBool(document["raw_business_bytes_committed"]) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_SAFETY_CONTRACT_INVALID")
	}
	roots := map[string]map[string]any{}
	for _, raw := range anySlice(document["roots"]) {
		root, _ := raw.(map[string]any)
		if root == nil {
			continue
		}
		rootID := safeID(asString(root["root_id"]))
		if rootID == "" || roots[rootID] != nil {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_ROOT_ID_INVALID")
			continue
		}
		roots[rootID] = root
	}
	return document, roots, actual, uniqueSortedV194(blockers), nil
}

func loadApprovedSourceEvidenceV194(request map[string]any) (map[string]map[string]any, string, []string, error) {
	path := strings.TrimSpace(asString(request["evidence_path"]))
	approved := strings.ToUpper(strings.TrimSpace(asString(request["approved_evidence_sha256"])))
	if path == "" || approved == "" {
		return map[string]map[string]any{}, "", []string{"BLOCKED_SOURCE_PROOF_EVIDENCE_REQUIRED"}, nil
	}
	_, roots, actual, blockers, err := readSourceEvidenceV194(path)
	if err != nil {
		return nil, "", nil, err
	}
	if actual != "" && !strings.EqualFold(actual, approved) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_HASH_MISMATCH")
	}
	return roots, actual, uniqueSortedV194(blockers), nil
}

func sourceRoleRequestsV194(proof map[string]any) []map[string]any {
	requests := []map[string]any{}
	for _, raw := range anySlice(proof["source_roots"]) {
		if item, _ := raw.(map[string]any); item != nil {
			requests = append(requests, item)
		}
	}
	return requests
}

func scanSourceRootV194(path string) ([]preRunSourceFileV194, string, []string, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || path == "" {
		return nil, "", []string{"DATA_BLOCKED_SOURCE_ROOT_MISSING"}, nil
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", []string{"DATA_BLOCKED_SOURCE_ROOT_MISSING"}, nil
	}
	if err != nil {
		return nil, "", nil, err
	}
	root := path
	paths := []string{}
	if !info.IsDir() {
		paths = append(paths, path)
		root = filepath.Dir(path)
	} else {
		err = filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("BLOCKED_SOURCE_PROOF_SYMLINK_FORBIDDEN")
			}
			if entry.IsDir() || !sourceExtensionsV194[strings.ToLower(filepath.Ext(entry.Name()))] {
				return nil
			}
			paths = append(paths, current)
			return nil
		})
		if err != nil {
			if strings.Contains(err.Error(), "BLOCKED_SOURCE_PROOF_SYMLINK_FORBIDDEN") {
				return nil, "", []string{"BLOCKED_SOURCE_PROOF_SYMLINK_FORBIDDEN"}, nil
			}
			return nil, "", nil, err
		}
	}
	sort.Slice(paths, func(i, j int) bool {
		left, _ := filepath.Rel(root, paths[i])
		right, _ := filepath.Rel(root, paths[j])
		return filepath.ToSlash(left) < filepath.ToSlash(right)
	})
	files := []preRunSourceFileV194{}
	lines := []string{}
	for _, current := range paths {
		stat, statErr := os.Stat(current)
		if statErr != nil || stat.IsDir() {
			return nil, "", nil, fmt.Errorf("SOURCE_STAT_FAILED")
		}
		hash, hashErr := fileSHA256V041(current)
		if hashErr != nil {
			return nil, "", nil, hashErr
		}
		relative, relErr := filepath.Rel(root, current)
		if relErr != nil {
			return nil, "", nil, relErr
		}
		relative = filepath.ToSlash(relative)
		files = append(files, preRunSourceFileV194{Path: current, Relative: relative, Size: stat.Size(), SHA256: hash})
		lines = append(lines, fmt.Sprintf("%s\t%d\t%s", relative, stat.Size(), strings.ToLower(hash)))
	}
	packageSum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	packageDigest := strings.ToUpper(hex.EncodeToString(packageSum[:]))
	blockers := []string{}
	if len(files) == 0 {
		blockers = append(blockers, "DATA_BLOCKED_SOURCE_ROOT_EMPTY")
	}
	return files, packageDigest, blockers, nil
}

func inspectSourceRoleV194(raw, evidenceRoot map[string]any, expectedOrganizationID, expectedOrganizationName, expectedPeriod string) (preRunSourceRoleV194, []string, error) {
	rootID := safeID(asString(raw["root_id"]))
	role := strings.ToUpper(strings.TrimSpace(asString(evidenceRoot["declared_system"])))
	result := preRunSourceRoleV194{
		Role: role, RootID: rootID, OrganizationID: strings.TrimSpace(asString(evidenceRoot["organization_id"])),
		OrganizationName: strings.TrimSpace(asString(evidenceRoot["expected_organization"])),
		Period:           strings.TrimSpace(asString(evidenceRoot["expected_period"])), RootPath: strings.TrimSpace(asString(raw["path"])),
		ApprovedDigestSHA256: strings.ToUpper(asString(evidenceRoot["package_digest"])),
	}
	result.RootPathIdentity = pathIdentityV194(result.RootPath)
	blockers := []string{}
	for _, blockerRaw := range anySlice(evidenceRoot["blockers"]) {
		blocker, _ := blockerRaw.(map[string]any)
		if blocker != nil {
			blockers = append(blockers, asString(blocker["code"]))
		} else {
			blockers = append(blockers, asString(blockerRaw))
		}
	}
	requestedRole := strings.ToUpper(strings.TrimSpace(asString(raw["role"])))
	if requestedRole != "" && requestedRole != role {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ROLE_MISMATCH")
	}
	if role != "INTALEV" && role != "ERP" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ROLE_MISMATCH")
	}
	if result.OrganizationID == "" || result.OrganizationID != expectedOrganizationID {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH")
	}
	if result.OrganizationName == "" || result.OrganizationName != expectedOrganizationName {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH")
	}
	if result.Period == "" || result.Period != expectedPeriod {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
	}
	files, packageDigest, scanBlockers, err := scanSourceRootV194(result.RootPath)
	if err != nil {
		return result, nil, err
	}
	result.Files = files
	result.PackageDigestSHA256 = packageDigest
	blockers = append(blockers, scanBlockers...)
	if result.ApprovedDigestSHA256 == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_PACKAGE_DIGEST_REQUIRED")
	} else if packageDigest != "" && !strings.EqualFold(result.ApprovedDigestSHA256, packageDigest) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PACKAGE_DIGEST_MISMATCH")
	}
	evidenceFileHashes := map[string]bool{}
	for _, fileRaw := range anySlice(evidenceRoot["files"]) {
		file, _ := fileRaw.(map[string]any)
		if file != nil {
			evidenceFileHashes[strings.ToUpper(asString(file["sha256"]))] = true
		}
	}
	selected := strings.ToUpper(strings.TrimSpace(defaultString(asString(raw["selected_file_sha256"]), asString(raw["approved_source_sha256"]))))
	if selected != "" && !evidenceFileHashes[selected] {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_SELECTED_SOURCE_NOT_IN_EVIDENCE")
	}
	if selected != "" {
		matches := []preRunSourceFileV194{}
		for _, file := range files {
			if strings.EqualFold(file.SHA256, selected) {
				matches = append(matches, file)
			}
		}
		if len(matches) == 1 {
			result.SelectedPath, result.SelectedSHA256, result.SelectedSize = matches[0].Path, matches[0].SHA256, matches[0].Size
			result.SelectedPathIdentity = pathIdentityV194(matches[0].Path)
		} else if len(matches) == 0 {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_SELECTED_SOURCE_NOT_FOUND")
		} else {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_SELECTED_SOURCE_AMBIGUOUS")
		}
	} else if len(files) == 1 {
		result.SelectedPath, result.SelectedSHA256, result.SelectedSize = files[0].Path, files[0].SHA256, files[0].Size
		result.SelectedPathIdentity = pathIdentityV194(files[0].Path)
		if !evidenceFileHashes[result.SelectedSHA256] {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_SELECTED_SOURCE_NOT_IN_EVIDENCE")
		}
	} else if len(files) > 1 {
		archiveHashes := map[string]bool{}
		for _, file := range files {
			if strings.EqualFold(filepath.Ext(file.Relative), ".zip") {
				archiveHashes[file.SHA256] = true
			}
		}
		if len(archiveHashes) > 1 {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_AMBIGUOUS_ARCHIVES")
		} else {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_SELECTED_SOURCE_PIN_REQUIRED")
		}
	}
	return result, uniqueSortedV194(blockers), nil
}

func sourceRolePublicV194(role preRunSourceRoleV194) map[string]any {
	selectedID := ""
	if role.SelectedSHA256 != "" {
		selectedID = "SRC-" + role.Role + "-" + role.SelectedSHA256[:20]
	}
	return map[string]any{
		"role": role.Role, "root_id": role.RootID, "organization_id": role.OrganizationID,
		"organization_name": role.OrganizationName,
		"period":            role.Period, "file_count": len(role.Files),
		"root_path_identity_sha256":      role.RootPathIdentity,
		"package_id":                     "PKG-" + role.RootID + "-" + digestPrefixV194(role.PackageDigestSHA256),
		"package_digest_sha256":          role.PackageDigestSHA256,
		"approved_package_digest_sha256": role.ApprovedDigestSHA256,
		"selected_source_id":             selectedID, "selected_file_sha256": role.SelectedSHA256,
		"selected_path_identity_sha256": role.SelectedPathIdentity, "selected_size": role.SelectedSize,
	}
}

func proofStatusV194(blockers []string) string {
	if len(blockers) == 0 {
		return "PASS"
	}
	for _, code := range blockers {
		if strings.HasPrefix(code, "DATA_BLOCKED") {
			return "DATA_BLOCKED"
		}
	}
	return "BLOCKED_SOURCE_PROOF"
}

func (a *App) preflightSourcesV194(body, settings map[string]any) (*preRunSourceProofV194, error) {
	request := cloneMap(preRunProofRequestV194(body))
	organizationID := strings.TrimSpace(defaultString(asString(request["organization_id"]), asString(body["organization_id"])))
	organizationName := strings.TrimSpace(defaultString(asString(request["organization_name"]), asString(body["organization_name"])))
	periodMode := strings.TrimSpace(defaultString(asString(request["period_mode"]), asString(settings["period_mode"])))
	period := strings.TrimSpace(defaultString(asString(request["period"]), asString(settings["period"])))
	blockers := []string{}
	if organizationID == "" || organizationName == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_REQUIRED")
	}
	if organizationID != asString(settings["organization_id"]) || organizationName != asString(settings["organization_name"]) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ORGANIZATION_MISMATCH")
	}
	if periodMode != asString(settings["period_mode"]) || period != asString(settings["period"]) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PERIOD_MISMATCH")
	}
	if strings.TrimSpace(asString(body["run_id"])) != "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_STALE_RUN_REUSE")
	}
	if evidencePath := strings.TrimSpace(asString(request["evidence_path"])); evidencePath != "" && !pathWithinV194(a.InputsDir, evidencePath) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PATH_OUTSIDE_INPUTS")
		request["evidence_path"] = ""
	}
	safeRoots := []any{}
	for _, raw := range sourceRoleRequestsV194(request) {
		item := cloneMap(raw)
		if rootPath := strings.TrimSpace(asString(item["path"])); rootPath != "" && !pathWithinV194(a.InputsDir, rootPath) {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_PATH_OUTSIDE_INPUTS")
			item["path"] = ""
		}
		safeRoots = append(safeRoots, item)
	}
	request["source_roots"] = safeRoots
	evidenceRoots, evidenceSHA256, evidenceBlockers, err := loadApprovedSourceEvidenceV194(request)
	if err != nil {
		return nil, err
	}
	blockers = append(blockers, evidenceBlockers...)
	configuredEvidenceSHA256 := strings.ToUpper(strings.TrimSpace(asString(settings["approved_source_evidence_sha256"])))
	requestedEvidenceSHA256 := strings.ToUpper(strings.TrimSpace(asString(request["approved_evidence_sha256"])))
	if configuredEvidenceSHA256 == "" {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_APPROVAL_REQUIRED")
	} else if requestedEvidenceSHA256 == "" || !strings.EqualFold(configuredEvidenceSHA256, requestedEvidenceSHA256) {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_UNAPPROVED")
	}
	roles := []preRunSourceRoleV194{}
	rolePublic := []any{}
	roleSeen := map[string]bool{}
	for _, raw := range sourceRoleRequestsV194(request) {
		rootID := safeID(asString(raw["root_id"]))
		evidenceRoot := evidenceRoots[rootID]
		if evidenceRoot == nil {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_EVIDENCE_ROOT_NOT_FOUND")
			evidenceRoot = map[string]any{}
		}
		role, roleBlockers, err := inspectSourceRoleV194(raw, evidenceRoot, organizationID, organizationName, period)
		if err != nil {
			return nil, err
		}
		if roleSeen[role.Role] {
			blockers = append(blockers, "BLOCKED_SOURCE_PROOF_DUPLICATE_ROLE")
		}
		roleSeen[role.Role] = true
		roles = append(roles, role)
		rolePublic = append(rolePublic, sourceRolePublicV194(role))
		blockers = append(blockers, roleBlockers...)
	}
	if len(roles) == 0 {
		blockers = append(blockers, "DATA_BLOCKED_SOURCE_PROOF_REQUIRED")
	}
	if !roleSeen["INTALEV"] || !roleSeen["ERP"] {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_REQUIRED_ROLES_MISSING")
	}
	if len(roles) != 2 || len(roleSeen) != 2 {
		blockers = append(blockers, "BLOCKED_SOURCE_PROOF_ROLE_SET_MISMATCH")
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Role+roles[i].RootID < roles[j].Role+roles[j].RootID })
	sort.Slice(rolePublic, func(i, j int) bool {
		left, _ := rolePublic[i].(map[string]any)
		right, _ := rolePublic[j].(map[string]any)
		return asString(left["role"])+asString(left["root_id"]) < asString(right["role"])+asString(right["root_id"])
	})
	blockers = uniqueSortedV194(blockers)
	packageBasis := []any{}
	for _, raw := range rolePublic {
		role := raw.(map[string]any)
		packageBasis = append(packageBasis, map[string]any{
			"role": role["role"], "root_id": role["root_id"],
			"package_digest_sha256": role["package_digest_sha256"],
			"selected_file_sha256":  role["selected_file_sha256"],
		})
	}
	packageDigest := digestJSONV194(packageBasis)
	basis := map[string]any{
		"schema_version": preRunSourceProofSchemaV194,
		"organization":   map[string]any{"id": organizationID, "name": organizationName},
		"period_mode":    periodMode, "period": period, "source_roles": rolePublic,
		"approved_evidence_sha256": evidenceSHA256,
		"package_digest_sha256":    packageDigest, "blocker_codes": blockers,
	}
	proofDigest := digestJSONV194(basis)
	status := proofStatusV194(blockers)
	errorCode := ""
	message := "Source proof PASS"
	if status != "PASS" {
		errorCode = "SOURCE_PROOF_BLOCKED"
		message = strings.Join(blockers, ", ")
	}
	public := map[string]any{
		"schema_version": preRunSourceProofSchemaV194,
		"organization":   basis["organization"], "period_mode": periodMode, "period": period,
		"source_roles": rolePublic, "package_id": "PKGCTX-" + proofDigest[:20],
		"approved_evidence_sha256": evidenceSHA256,
		"package_digest_sha256":    packageDigest, "proof_digest_sha256": proofDigest,
		"proof_status": status, "blocker_codes": blockers,
		"blocker_summary": strings.Join(blockers, ", "), "engine_prepare_allowed": status == "PASS",
		"error": errorCode, "message": message,
		"run_id": nil, "posting_rows": 0, "ready_to_upload": false, "release_allowed": false, "live_1c_allowed": false,
	}
	proof := &preRunSourceProofV194{Public: public, Roles: roles, Digest: proofDigest, Allowed: status == "PASS"}
	expected := strings.ToUpper(strings.TrimSpace(asString(body["expected_preflight_digest_sha256"])))
	if expected != "" && !strings.EqualFold(expected, proof.Digest) {
		public["proof_status"] = "BLOCKED_SOURCE_PROOF"
		public["blocker_codes"] = []string{"BLOCKED_SOURCE_PROOF_HASH_DRIFT"}
		public["blocker_summary"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
		public["engine_prepare_allowed"] = false
		public["error"] = "SOURCE_PROOF_BLOCKED"
		public["message"] = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
		public["expected_preflight_digest_sha256"] = expected
		a.writePreRunDiagnosticV194(public)
		return proof, &preRunSourceBlockedErrorV194{Result: public}
	}
	if !proof.Allowed {
		a.writePreRunDiagnosticV194(public)
		return proof, &preRunSourceBlockedErrorV194{Result: public}
	}
	if asBool(body["preflight_only"]) {
		return proof, nil
	}
	if expected == "" {
		public["proof_status"] = "BLOCKED_SOURCE_PROOF"
		public["blocker_codes"] = []string{"BLOCKED_SOURCE_PROOF_PREFLIGHT_CONFIRMATION_REQUIRED"}
		public["blocker_summary"] = "BLOCKED_SOURCE_PROOF_PREFLIGHT_CONFIRMATION_REQUIRED"
		public["engine_prepare_allowed"] = false
		public["error"] = "SOURCE_PROOF_BLOCKED"
		public["message"] = "BLOCKED_SOURCE_PROOF_PREFLIGHT_CONFIRMATION_REQUIRED"
		a.writePreRunDiagnosticV194(public)
		return proof, &preRunSourceBlockedErrorV194{Result: public}
	}
	return proof, nil
}

func (a *App) validateCanonicalPreRunRequestV194(proof *preRunSourceProofV194, body map[string]any) error {
	if proof == nil || !proof.Allowed || asString(proof.Public["proof_status"]) != "PASS" {
		return &preRunSourceBlockedErrorV194{Result: sourceProofBusinessBlockedV194([]string{"DATA_BLOCKED_SOURCE_PROOF_REQUIRED"})}
	}
	if asBool(body["preflight_only"]) {
		return nil
	}
	expected := strings.ToUpper(strings.TrimSpace(asString(body["expected_preflight_digest_sha256"])))
	blocker := ""
	if expected == "" {
		blocker = "BLOCKED_SOURCE_PROOF_PREFLIGHT_CONFIRMATION_REQUIRED"
	} else if !strings.EqualFold(expected, proof.Digest) {
		blocker = "BLOCKED_SOURCE_PROOF_HASH_DRIFT"
	}
	if blocker == "" {
		return nil
	}
	proof.Allowed = false
	proof.Public["proof_status"] = "BLOCKED_SOURCE_PROOF"
	proof.Public["blocker_codes"] = []string{blocker}
	proof.Public["blocker_summary"] = blocker
	proof.Public["engine_prepare_allowed"] = false
	proof.Public["error"] = "SOURCE_PROOF_BLOCKED"
	proof.Public["message"] = blocker
	if expected != "" {
		proof.Public["expected_preflight_digest_sha256"] = expected
	}
	a.writePreRunDiagnosticV194(proof.Public)
	return &preRunSourceBlockedErrorV194{Result: proof.Public}
}

func (a *App) writePreRunDiagnosticV194(result map[string]any) {
	digest := asString(result["proof_digest_sha256"])
	if len(digest) < 20 {
		digest = digestJSONV194(result)
	}
	record := cloneMap(result)
	record["diagnostic_id"] = "DIAG-PRERUN-" + digest[:20]
	record["support_safe"] = true
	_ = writeJSONAtomic(filepath.Join(a.DataRoot, "diagnostics", "pre-run", asString(record["diagnostic_id"])+".json"), record)
}

func preRunSelectedPathsV194(proof *preRunSourceProofV194) (string, string) {
	intalev, erp := "", ""
	for _, role := range proof.Roles {
		switch role.Role {
		case "INTALEV":
			intalev = role.SelectedPath
		case "ERP":
			erp = role.SelectedPath
		}
	}
	return intalev, erp
}

func snapshotPreRunSelectedSourcesV194(proof *preRunSourceProofV194, snapshotRoot string) (map[string]string, error) {
	if proof == nil || len(proof.Roles) != 2 {
		return nil, errors.New("SOURCE_PROOF_SNAPSHOT_ROLES_INVALID")
	}
	result := map[string]string{}
	for _, role := range proof.Roles {
		roleName := strings.ToUpper(strings.TrimSpace(role.Role))
		if roleName != "ERP" && roleName != "INTALEV" {
			return nil, errors.New("SOURCE_PROOF_SNAPSHOT_ROLE_INVALID")
		}
		roleDir := filepath.Join(snapshotRoot, strings.ToLower(roleName))
		if err := os.MkdirAll(roleDir, 0755); err != nil {
			return nil, err
		}
		target := filepath.Join(roleDir, filepath.Base(role.SelectedPath))
		temporary := target + ".partial"
		source, err := os.Open(role.SelectedPath)
		if err != nil {
			return nil, err
		}
		destination, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			source.Close()
			return nil, err
		}
		hash := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(destination, hash), source)
		closeDestinationErr := destination.Close()
		closeSourceErr := source.Close()
		if copyErr != nil || closeDestinationErr != nil || closeSourceErr != nil {
			_ = os.Remove(temporary)
			if copyErr != nil {
				return nil, copyErr
			}
			if closeDestinationErr != nil {
				return nil, closeDestinationErr
			}
			return nil, closeSourceErr
		}
		actualSHA256 := strings.ToUpper(hex.EncodeToString(hash.Sum(nil)))
		if written != role.SelectedSize || !strings.EqualFold(actualSHA256, role.SelectedSHA256) {
			_ = os.Remove(temporary)
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		if err := os.Rename(temporary, target); err != nil {
			_ = os.Remove(temporary)
			return nil, err
		}
		if err := os.Chmod(target, 0444); err != nil {
			return nil, err
		}
		verifiedSHA256, err := fileSHA256V041(target)
		if err != nil || !strings.EqualFold(verifiedSHA256, role.SelectedSHA256) {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		result[roleName] = target
	}
	if result["ERP"] == "" || result["INTALEV"] == "" {
		return nil, errors.New("SOURCE_PROOF_SNAPSHOT_ROLES_INVALID")
	}
	return result, nil
}

func preRunInternalRecordV194(proof *preRunSourceProofV194) []any {
	out := []any{}
	for _, role := range proof.Roles {
		out = append(out, map[string]any{
			"role": role.Role, "root_id": role.RootID, "organization_id": role.OrganizationID,
			"organization_name": role.OrganizationName,
			"period":            role.Period, "root_path": role.RootPath,
			"root_path_identity_sha256":      role.RootPathIdentity,
			"package_digest_sha256":          role.PackageDigestSHA256,
			"approved_package_digest_sha256": role.ApprovedDigestSHA256,
			"selected_path":                  role.SelectedPath, "selected_file_sha256": role.SelectedSHA256,
			"selected_path_identity_sha256": role.SelectedPathIdentity,
		})
	}
	return out
}

func validatePreRunProofCurrentV194(proof *preRunSourceProofV194) error {
	for _, role := range proof.Roles {
		if pathIdentityV194(role.RootPath) != role.RootPathIdentity || pathIdentityV194(role.SelectedPath) != role.SelectedPathIdentity {
			return errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		files, digest, blockers, err := scanSourceRootV194(role.RootPath)
		if err != nil || len(blockers) > 0 || !strings.EqualFold(digest, role.PackageDigestSHA256) {
			return errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		selectedMatches := 0
		for _, file := range files {
			if strings.EqualFold(file.SHA256, role.SelectedSHA256) && file.Path == role.SelectedPath {
				selectedMatches++
			}
		}
		if selectedMatches != 1 {
			return errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
	}
	return nil
}

func runRequiresPreRunProofV194(run map[string]any) bool {
	if asString(run["source_proof_contract"]) == preRunSourceContractMarkerV194 {
		return true
	}
	if public, _ := run["pre_run_source_proof"].(map[string]any); public != nil {
		return true
	}
	return len(anySlice(run["pre_run_source_roots"])) > 0
}

func validateStoredPreRunProofV194(run map[string]any) (map[string]any, error) {
	if asString(run["source_proof_contract"]) != preRunSourceContractMarkerV194 {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	public, _ := run["pre_run_source_proof"].(map[string]any)
	if public == nil || asString(public["schema_version"]) != preRunSourceProofSchemaV194 ||
		asString(public["proof_status"]) != "PASS" || !asBool(public["engine_prepare_allowed"]) ||
		len(stringSliceV194(public["blocker_codes"])) != 0 || int(asFloat(public["posting_rows"])) != 0 ||
		asBool(public["ready_to_upload"]) || asBool(public["release_allowed"]) || asBool(public["live_1c_allowed"]) ||
		asString(public["run_id"]) != asString(run["run_id"]) {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_REQUIRED")
	}
	storedRoots := anySlice(run["pre_run_source_roots"])
	if len(storedRoots) != 2 {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	roleSeen := map[string]bool{}
	expectedRolePublic := []any{}
	for _, raw := range storedRoots {
		stored, _ := raw.(map[string]any)
		if stored == nil {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
		}
		role := strings.ToUpper(strings.TrimSpace(asString(stored["role"])))
		if (role != "INTALEV" && role != "ERP") || roleSeen[role] || safeID(asString(stored["root_id"])) == "" {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
		}
		roleSeen[role] = true
		if asString(stored["organization_id"]) != asString(run["organization_id"]) ||
			asString(stored["organization_name"]) != asString(run["organization_name"]) ||
			asString(stored["period"]) != asString(run["period"]) {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
		}
		rootPath := asString(stored["root_path"])
		selectedPath := asString(stored["selected_path"])
		if pathIdentityV194(rootPath) != asString(stored["root_path_identity_sha256"]) ||
			pathIdentityV194(selectedPath) != asString(stored["selected_path_identity_sha256"]) {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		files, digest, blockers, err := scanSourceRootV194(rootPath)
		if err != nil || len(blockers) > 0 || !strings.EqualFold(digest, asString(stored["package_digest_sha256"])) {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		selectedMatches := []preRunSourceFileV194{}
		for _, file := range files {
			if strings.EqualFold(file.SHA256, asString(stored["selected_file_sha256"])) &&
				strings.EqualFold(filepath.Clean(file.Path), filepath.Clean(selectedPath)) {
				selectedMatches = append(selectedMatches, file)
			}
		}
		if len(selectedMatches) != 1 || strings.TrimSpace(asString(stored["approved_package_digest_sha256"])) == "" {
			return nil, errors.New("BLOCKED_SOURCE_PROOF_HASH_DRIFT")
		}
		expectedRolePublic = append(expectedRolePublic, sourceRolePublicV194(preRunSourceRoleV194{
			Role: role, RootID: asString(stored["root_id"]),
			OrganizationID: asString(stored["organization_id"]), OrganizationName: asString(stored["organization_name"]),
			Period: asString(stored["period"]), RootPath: rootPath, Files: files,
			PackageDigestSHA256: digest, ApprovedDigestSHA256: asString(stored["approved_package_digest_sha256"]),
			SelectedPath: selectedPath, SelectedSHA256: selectedMatches[0].SHA256, SelectedSize: selectedMatches[0].Size,
			RootPathIdentity: asString(stored["root_path_identity_sha256"]), SelectedPathIdentity: asString(stored["selected_path_identity_sha256"]),
		}))
	}
	if !roleSeen["INTALEV"] || !roleSeen["ERP"] {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	sort.Slice(expectedRolePublic, func(i, j int) bool {
		left := expectedRolePublic[i].(map[string]any)
		right := expectedRolePublic[j].(map[string]any)
		return asString(left["role"])+asString(left["root_id"]) < asString(right["role"])+asString(right["root_id"])
	})
	publicRoles := append([]any{}, anySlice(public["source_roles"])...)
	if len(publicRoles) != 2 {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	sort.Slice(publicRoles, func(i, j int) bool {
		left, _ := publicRoles[i].(map[string]any)
		right, _ := publicRoles[j].(map[string]any)
		return asString(left["role"])+asString(left["root_id"]) < asString(right["role"])+asString(right["root_id"])
	})
	if digestJSONV194(publicRoles) != digestJSONV194(expectedRolePublic) {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	packageBasis := []any{}
	for _, raw := range expectedRolePublic {
		role := raw.(map[string]any)
		packageBasis = append(packageBasis, map[string]any{
			"role": role["role"], "root_id": role["root_id"],
			"package_digest_sha256": role["package_digest_sha256"],
			"selected_file_sha256":  role["selected_file_sha256"],
		})
	}
	packageDigest := digestJSONV194(packageBasis)
	organization, _ := public["organization"].(map[string]any)
	if organization == nil || asString(organization["id"]) != asString(run["organization_id"]) ||
		asString(organization["name"]) != asString(run["organization_name"]) ||
		asString(public["period_mode"]) != asString(run["period_mode"]) || asString(public["period"]) != asString(run["period"]) ||
		len(strings.TrimSpace(asString(public["approved_evidence_sha256"]))) != 64 {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	basis := map[string]any{
		"schema_version": preRunSourceProofSchemaV194,
		"organization":   organization,
		"period_mode":    public["period_mode"], "period": public["period"], "source_roles": expectedRolePublic,
		"approved_evidence_sha256": public["approved_evidence_sha256"],
		"package_digest_sha256":    packageDigest, "blocker_codes": []string{},
	}
	proofDigest := digestJSONV194(basis)
	if !strings.EqualFold(proofDigest, asString(public["proof_digest_sha256"])) ||
		!strings.EqualFold(packageDigest, asString(public["package_digest_sha256"])) ||
		asString(public["package_id"]) != "PKGCTX-"+proofDigest[:20] {
		return nil, errors.New("BLOCKED_SOURCE_PROOF_ACTIVE_RUN_INVALID")
	}
	return public, nil
}
