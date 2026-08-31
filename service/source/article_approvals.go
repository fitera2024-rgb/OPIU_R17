package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const articleApprovalSchema = "opiu-article-approval.v1"
const articleApprovalQueueSchema = "opiu-article-approval-queue.v1"
const articleApprovalDiagnosticSchema = "opiu-article-approval-diagnostics.v1"
const articleApprovalFallbackDiagnosticCode = "ARTICLE_APPROVAL_VERSION_REJECTED_FALLBACK"

const (
	articleApprovalRejectionPublicationRead = "PUBLICATION_READ_FAILED"
	articleApprovalRejectionSidecarMissing  = "SIDECAR_MISSING"
	articleApprovalRejectionSidecarRead     = "SIDECAR_READ_FAILED"
	articleApprovalRejectionSidecarInvalid  = "SIDECAR_INVALID"
	articleApprovalRejectionSHA256Mismatch  = "SHA256_MISMATCH"
	articleApprovalRejectionMalformedJSON   = "MALFORMED_JSON"
	articleApprovalRejectionUnsafeMetadata  = "UNSAFE_METADATA"
	articleApprovalRejectionMetadataInvalid = "METADATA_INVALID"
	articleApprovalRejectionVersionMismatch = "VERSION_MISMATCH"
	articleApprovalRejectionScopeMismatch   = "SCOPE_MISMATCH"
	articleApprovalRejectionSourceInvalid   = "SOURCE_OR_PERIOD_INVALID"
	articleApprovalRejectionDecisions       = "INVALID_DECISIONS"
	articleApprovalRejectionSourceBinding   = "SOURCE_BINDING_INVALID"
	articleApprovalRejectionValidation      = "VALIDATION_REJECTED"
)

var articleApprovalDecisionList = []string{
	"УТВЕРЖДАЮ",
	"ИЗМЕНИТЬ",
	"ЗАПРЕТИТЬ",
	"НУЖНА ПРОВЕРКА",
	"ПРЕДЛОЖЕНО ДВИЖКОМ",
}

var articleApprovalRuleColumns = []string{
	"КлючОбласти",
	"КодОрганизацииERP",
	"ОрганизацияERP",
	"ПериодС",
	"БлокИнталев",
	"ПутьИнталев",
	"СтатьяИнталев",
	"СчетДоходовРасходов",
	"СчетРасчетов",
	"ПредлагаемыйБлокERP",
	"ПредлагаемаяСтатьяERP",
	"КодСтатьиERP",
	"Действие",
	"ОснованиеВыбора",
	"Уверенность",
	"ПримерыПроводок",
	"РешениеПользователя",
	"ПравильныйБлокERP",
	"ПравильнаяСтатьяERP",
	"ПравильныйКодСтатьиERP",
	"КомментарийПользователя",
}

var (
	articleApprovalMonth     = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
	articleApprovalSHA       = regexp.MustCompile(`^[A-Fa-f0-9]{64}$`)
	articleApprovalActor     = regexp.MustCompile(`^[^\\/\s]+\\[^\\/\s]+$`)
	articleApprovalMu        sync.Mutex
	articleApprovalHostActor = currentArticleApprovalHostActor
)

var articleApprovalDecisions = map[string]struct{}{
	"УТВЕРЖДАЮ":          {},
	"ИЗМЕНИТЬ":           {},
	"ЗАПРЕТИТЬ":          {},
	"НУЖНА ПРОВЕРКА":     {},
	"ПРЕДЛОЖЕНО ДВИЖКОМ": {},
}

type articleApprovalScope struct {
	OrganizationID   string `json:"organization_id"`
	OrganizationName string `json:"organization_name"`
	OrganizationPath string `json:"organization_hierarchy_path"`
	Period           string `json:"period"`
}

type articleApprovalSource struct {
	XLSX   string `json:"xlsx"`
	SHA256 string `json:"sha256"`
}

type articleApprovalValidity struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type articleApprovalCatalogItem struct {
	Code    string `json:"code"`
	Block   string `json:"block"`
	Article string `json:"article"`
}

type articleApprovalRow struct {
	ScopeKey             string `json:"scope_key"`
	OrganizationID       string `json:"organization_id"`
	OrganizationName     string `json:"organization_name"`
	Period               string `json:"period"`
	BlockIntalev         string `json:"block_intalev"`
	PathIntalev          string `json:"path_intalev"`
	ArticleIntalev       string `json:"article_intalev"`
	IncomeExpenseAccount string `json:"income_expense_account"`
	SettlementAccount    string `json:"settlement_account"`
	ProposedBlockERP     string `json:"proposed_block_erp"`
	ProposedArticleERP   string `json:"proposed_article_erp"`
	ProposedCodeERP      string `json:"proposed_code_erp"`
	Action               string `json:"action"`
	SelectionReason      string `json:"selection_reason"`
	Confidence           string `json:"confidence"`
	PhysicalExamples     string `json:"physical_examples"`
	UserDecision         string `json:"user_decision"`
	CorrectBlockERP      string `json:"correct_block_erp"`
	CorrectArticleERP    string `json:"correct_article_erp"`
	CorrectCodeERP       string `json:"correct_code_erp"`
	UserComment          string `json:"user_comment"`
}

type articleApprovalSafety struct {
	Mode           string `json:"mode"`
	DecisionType   string `json:"decision_type"`
	FinancialRows  int    `json:"financial_rows"`
	PostingRows    int    `json:"posting_rows"`
	ReadyToUpload  bool   `json:"ready_to_upload"`
	ReleaseAllowed bool   `json:"release_allowed"`
	Live1CAllowed  bool   `json:"live_1c_allowed"`
}

type articleApprovalDocument struct {
	SchemaVersion     string                  `json:"schema_version"`
	Version           int                     `json:"version"`
	ApprovalID        string                  `json:"approval_id"`
	OrganizationScope articleApprovalScope    `json:"organization_scope"`
	Validity          articleApprovalValidity `json:"validity"`
	Source            articleApprovalSource   `json:"source"`
	Actor             string                  `json:"actor"`
	FixedAt           time.Time               `json:"fixed_at"`
	Decisions         []articleApprovalRow    `json:"decisions"`
	Safety            articleApprovalSafety   `json:"safety"`
}

type articleApprovalDiagnostic struct {
	Code                       string `json:"code"`
	RejectionCode              string `json:"rejection_code"`
	RejectedPublication        string `json:"rejected_publication"`
	RejectedApprovalID         string `json:"rejected_approval_id,omitempty"`
	RejectedVersion            int    `json:"rejected_version"`
	SelectedFallbackApprovalID string `json:"selected_fallback_approval_id"`
	SelectedFallbackVersion    int    `json:"selected_fallback_version"`
	SelectedFallbackSHA256     string `json:"selected_fallback_sha256"`
	OrganizationID             string `json:"organization_id"`
	OrganizationName           string `json:"organization_name"`
	OrganizationPath           string `json:"organization_hierarchy_path"`
	Period                     string `json:"period"`
	FallbackOccurred           bool   `json:"fallback_occurred"`
}

type articleApprovalDiagnosticArtifact struct {
	SchemaVersion string                      `json:"schema_version"`
	RunID         string                      `json:"run_id"`
	ContextID     string                      `json:"context_id"`
	Diagnostics   []articleApprovalDiagnostic `json:"diagnostics"`
}

type articleApprovalSelection struct {
	Document    articleApprovalDocument
	Path        string
	SHA256      string
	Diagnostics []articleApprovalDiagnostic
}

type articleApprovalRejectedCandidate struct {
	Publication string
	ApprovalID  string
	Version     int
	Code        string
}

type articleApprovalRejectionError struct {
	code string
	err  error
}

func (e *articleApprovalRejectionError) Error() string {
	return e.err.Error()
}

func (e *articleApprovalRejectionError) Unwrap() error {
	return e.err
}

func newArticleApprovalRejection(code string, err error) error {
	if err == nil {
		return nil
	}
	return &articleApprovalRejectionError{code: code, err: err}
}

func articleApprovalRejectionCode(err error) string {
	var rejection *articleApprovalRejectionError
	if errors.As(err, &rejection) && rejection.code != "" {
		return rejection.code
	}
	return articleApprovalRejectionValidation
}

func articleApprovalDiagnosticApprovalID(document articleApprovalDocument) string {
	value := cleanBusinessText(document.ApprovalID, 160)
	base, err := secureBaseName(value)
	if err != nil || base != value {
		digest := sha256.Sum256([]byte(document.ApprovalID))
		return "approval_id_sha256_" + strings.ToUpper(hex.EncodeToString(digest[:]))
	}
	return value
}

type articleApprovalRequest struct {
	Organization              string                       `json:"organization"`
	OrganizationID            string                       `json:"organization_id"`
	OrganizationName          string                       `json:"organization_name"`
	OrganizationPath          string                       `json:"organization_path"`
	OrganizationHierarchyPath string                       `json:"organization_hierarchy_path"`
	Period                    string                       `json:"period"`
	SourceXLSX                string                       `json:"source_xlsx"`
	SourceSHA256              string                       `json:"source_sha256"`
	Actor                     string                       `json:"actor"`
	User                      string                       `json:"user"`
	Rows                      []articleApprovalRow         `json:"rows"`
	Decisions                 []articleApprovalRow         `json:"decisions"`
	ERPCatalog                []articleApprovalCatalogItem `json:"erp_catalog"`
}

type articleApprovalQueueDecision struct {
	RowID             string `json:"row_id"`
	UserDecision      string `json:"user_decision"`
	CorrectBlockERP   string `json:"correct_block_erp"`
	CorrectArticleERP string `json:"correct_article_erp"`
	CorrectCodeERP    string `json:"correct_code_erp"`
	UserComment       string `json:"user_comment"`
}

type articleApprovalQueueRequest struct {
	RunID       string                         `json:"run_id"`
	Revision    string                         `json:"revision"`
	BulkApprove bool                           `json:"bulk_approve"`
	Decisions   []articleApprovalQueueDecision `json:"decisions"`
}

type articleApprovalQueueRow struct {
	RowID                string   `json:"row_id"`
	BlockIntalev         string   `json:"block_intalev"`
	PathIntalev          string   `json:"path_intalev"`
	ArticleIntalev       string   `json:"article_intalev"`
	IncomeExpenseAccount string   `json:"income_expense_account"`
	SettlementAccount    string   `json:"settlement_account"`
	ProposedBlockERP     string   `json:"proposed_block_erp"`
	ProposedArticleERP   string   `json:"proposed_article_erp"`
	ProposedCodeERP      string   `json:"proposed_code_erp"`
	Action               string   `json:"action"`
	SelectionReason      string   `json:"selection_reason"`
	Confidence           string   `json:"confidence"`
	PhysicalExamples     string   `json:"physical_examples"`
	UserDecision         string   `json:"user_decision"`
	CorrectBlockERP      string   `json:"correct_block_erp"`
	CorrectArticleERP    string   `json:"correct_article_erp"`
	CorrectCodeERP       string   `json:"correct_code_erp"`
	UserComment          string   `json:"user_comment"`
	BulkApprovable       bool     `json:"bulk_approvable"`
	BulkApprovalBlockers []string `json:"bulk_approval_blockers"`
}

type articleApprovalQueue struct {
	Status            string                    `json:"status"`
	SchemaVersion     string                    `json:"schema_version"`
	RunID             string                    `json:"run_id"`
	QueueRevision     string                    `json:"queue_revision"`
	OrganizationScope articleApprovalScope      `json:"organization_scope"`
	Actor             string                    `json:"actor"`
	AllowedDecisions  []string                  `json:"allowed_decisions"`
	Rows              []articleApprovalQueueRow `json:"rows"`
	BulkApprovable    int                       `json:"bulk_approvable"`
	Safety            SafetyState               `json:"safety"`
	prepared          articleApprovalPrepared
}

type articleApprovalIssue struct {
	Row     int    `json:"row,omitempty"`
	Code    string `json:"code"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

type articleApprovalPrepared struct {
	Scope   articleApprovalScope
	Source  articleApprovalSource
	Rows    []articleApprovalRow
	Catalog []articleApprovalCatalogItem
}

type articleApprovalXLSXRelationship struct {
	ID         string `xml:"Id,attr"`
	Type       string `xml:"Type,attr"`
	Target     string `xml:"Target,attr"`
	TargetMode string `xml:"TargetMode,attr"`
}

type articleApprovalXLSXRelationships struct {
	Items []articleApprovalXLSXRelationship `xml:"Relationship"`
}

type articleApprovalXLSXSheet struct {
	Name string `xml:"name,attr"`
	ID   string `xml:"id,attr"`
}

type articleApprovalXLSXWorkbook struct {
	Sheets []articleApprovalXLSXSheet `xml:"sheets>sheet"`
}

type articleApprovalXLSXCell struct {
	Reference string `xml:"r,attr"`
	Type      string `xml:"t,attr"`
	Value     string `xml:"v"`
	Inline    struct {
		Text string `xml:"t"`
	} `xml:"is"`
}

type articleApprovalXLSXRow struct {
	Number int                       `xml:"r,attr"`
	Cells  []articleApprovalXLSXCell `xml:"c"`
}

type articleApprovalXLSXWorksheet struct {
	Rows []articleApprovalXLSXRow `xml:"sheetData>row"`
}

type articleApprovalXLSXSharedStrings struct {
	Items []struct {
		Texts []string `xml:"t"`
		Runs  []struct {
			Text string `xml:"t"`
		} `xml:"r"`
	} `xml:"si"`
}

func currentArticleApprovalHostActor() (string, error) {
	domain := cleanBusinessText(os.Getenv("USERDOMAIN"), 200)
	name := cleanBusinessText(os.Getenv("USERNAME"), 200)
	if current, err := user.Current(); err == nil {
		candidate := cleanBusinessText(current.Username, 300)
		if articleApprovalActor.MatchString(candidate) {
			return candidate, nil
		}
		if name == "" {
			name = candidate
		}
	}
	name = strings.TrimPrefix(name, domain+`\`)
	actor := domain + `\` + name
	if domain == "" || name == "" || !articleApprovalActor.MatchString(actor) {
		return "", errors.New("ARTICLE_APPROVAL_HOST_ACTOR_UNAVAILABLE")
	}
	return actor, nil
}

func articleApprovalScopeKey(scope articleApprovalScope, row articleApprovalRow) string {
	normalize := func(value string) string {
		value = strings.ToLower(cleanBusinessText(value, 700))
		value = strings.ReplaceAll(value, "ё", "е")
		value = strings.NewReplacer(`"`, "", "«", "", "»", "").Replace(value)
		return strings.Join(strings.Fields(value), " ")
	}
	return strings.Join([]string{scope.OrganizationID, scope.Period, normalize(row.BlockIntalev), normalize(row.ArticleIntalev)}, "|")
}

func articleApprovalCanonicalRows(rows []articleApprovalRow, scope articleApprovalScope) []articleApprovalRow {
	result := make([]articleApprovalRow, len(rows))
	for index, row := range rows {
		row.ScopeKey = articleApprovalScopeKey(scope, row)
		row.OrganizationID = scope.OrganizationID
		row.OrganizationName = scope.OrganizationName
		row.Period = scope.Period
		result[index] = row
	}
	return result
}

func articleApprovalResolveScope(store *Store, request articleApprovalRequest) (articleApprovalScope, error) {
	requested := articleApprovalScopeFromRequest(request)
	if requested.OrganizationID == "" || !articleApprovalMonth.MatchString(requested.Period) {
		return articleApprovalScope{}, errors.New("ARTICLE_APPROVAL_SCOPE_INVALID")
	}
	for _, item := range store.OrganizationCatalog() {
		if item.ID != requested.OrganizationID {
			continue
		}
		if requested.OrganizationName != "" && requested.OrganizationName != item.Name {
			return articleApprovalScope{}, errors.New("ARTICLE_APPROVAL_ORGANIZATION_MISMATCH")
		}
		if requested.OrganizationPath != "" && requested.OrganizationPath != item.Path {
			return articleApprovalScope{}, errors.New("ARTICLE_APPROVAL_ORGANIZATION_MISMATCH")
		}
		return articleApprovalScope{OrganizationID: item.ID, OrganizationName: item.Name, OrganizationPath: item.Path, Period: requested.Period}, nil
	}
	return articleApprovalScope{}, errors.New("ARTICLE_APPROVAL_ORGANIZATION_UNKNOWN")
}

func articleApprovalPathWithinRoot(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func articleApprovalResolveSource(store *Store, requestedPath, declaredSHA string) (articleApprovalSource, string, error) {
	requestedPath = cleanBusinessText(requestedPath, 1000)
	declaredSHA = strings.ToUpper(cleanBusinessText(declaredSHA, 100))
	if requestedPath == "" {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_XLSX_REQUIRED")
	}
	if !articleApprovalSHA.MatchString(declaredSHA) {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_SHA256_INVALID")
	}
	resolved := requestedPath
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(store.Root(), resolved)
	}
	resolved, err := filepath.Abs(filepath.Clean(resolved))
	if err != nil || !strings.EqualFold(filepath.Ext(resolved), ".xlsx") {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_PATH_INVALID")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_XLSX_MISSING")
	}
	resolvedRoot, err := filepath.EvalSymlinks(store.Root())
	if err != nil {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_PATH_INVALID")
	}
	resolved, err = filepath.EvalSymlinks(resolved)
	if err != nil || !articleApprovalPathWithinRoot(resolvedRoot, resolved) {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_PATH_INVALID")
	}
	file, err := os.Open(resolved)
	if err != nil {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_XLSX_UNREADABLE")
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_XLSX_UNREADABLE")
	}
	actualSHA := strings.ToUpper(hex.EncodeToString(hash.Sum(nil)))
	if actualSHA != declaredSHA {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH")
	}
	relative, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil {
		return articleApprovalSource{}, "", errors.New("ARTICLE_APPROVAL_SOURCE_PATH_INVALID")
	}
	return articleApprovalSource{XLSX: filepath.ToSlash(relative), SHA256: actualSHA}, resolved, nil
}

func articleApprovalZIPRead(archive *zip.Reader, name string) ([]byte, error) {
	canonicalName, err := canonicalXLSXPackagePart(name)
	if err != nil {
		return nil, fmt.Errorf("source XLSX package member is unsafe: %w", err)
	}
	var matched *zip.File
	for _, item := range archive.File {
		if item.Name != canonicalName {
			continue
		}
		if matched != nil {
			return nil, errors.New("source XLSX contains duplicate package entry")
		}
		matched = item
	}
	if matched != nil {
		reader, err := matched.Open()
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil {
			return nil, readErr
		}
		return data, closeErr
	}
	return nil, os.ErrNotExist
}

func articleApprovalResolveXLSXWorksheetTarget(relation articleApprovalXLSXRelationship) (string, error) {
	if !isXLSXWorksheetRelationshipType(relation.Type) {
		return "", errors.New("source XLSX worksheet relationship type is unsupported")
	}
	target := relation.Target
	if strings.TrimSpace(target) != target || target == "" || strings.Contains(target, "\\") {
		return "", errors.New("source XLSX worksheet relationship target is empty or non-canonical")
	}
	if mode := strings.TrimSpace(relation.TargetMode); mode != "" && !strings.EqualFold(mode, "Internal") {
		return "", errors.New("source XLSX worksheet relationship target is external")
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" || strings.Contains(target, "%") {
		return "", errors.New("source XLSX worksheet relationship target is not an internal package URI")
	}
	targetPath := parsed.Path
	if targetPath == "" {
		return "", errors.New("source XLSX worksheet relationship target path is empty")
	}
	for _, component := range strings.Split(strings.TrimPrefix(targetPath, "/"), "/") {
		if component == "" || component == "." || component == ".." {
			return "", errors.New("source XLSX worksheet relationship target contains traversal or non-canonical components")
		}
	}
	resolved := targetPath
	if strings.HasPrefix(targetPath, "/") {
		resolved = strings.TrimPrefix(targetPath, "/")
	} else if !strings.HasPrefix(targetPath, "xl/") {
		resolved = path.Join(path.Dir("xl/workbook.xml"), targetPath)
	}
	canonical, err := canonicalXLSXPackagePart(resolved)
	if err != nil {
		return "", fmt.Errorf("source XLSX worksheet relationship target is unsafe: %w", err)
	}
	return canonical, nil
}

func articleApprovalXLSXStrings(archive *zip.Reader) ([]string, error) {
	data, err := articleApprovalZIPRead(archive, "xl/sharedStrings.xml")
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var shared articleApprovalXLSXSharedStrings
	if err := xml.Unmarshal(data, &shared); err != nil {
		return nil, err
	}
	result := make([]string, len(shared.Items))
	for index, item := range shared.Items {
		parts := append([]string{}, item.Texts...)
		for _, run := range item.Runs {
			parts = append(parts, run.Text)
		}
		result[index] = strings.Join(parts, "")
	}
	return result, nil
}

func articleApprovalXLSXColumn(reference string) int {
	column := 0
	for _, character := range reference {
		if character < 'A' || character > 'Z' {
			break
		}
		column = column*26 + int(character-'A'+1)
	}
	return column
}

func articleApprovalXLSXRows(path, sheetName string) ([]map[int]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return articleApprovalXLSXRowsData(data, sheetName)
}

func articleApprovalXLSXRowsData(data []byte, sheetName string) ([]map[int]string, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("source is not a readable XLSX: %w", err)
	}
	workbookData, err := articleApprovalZIPRead(archive, "xl/workbook.xml")
	if err != nil {
		return nil, err
	}
	relationshipData, err := articleApprovalZIPRead(archive, "xl/_rels/workbook.xml.rels")
	if err != nil {
		return nil, err
	}
	var workbook articleApprovalXLSXWorkbook
	var relationships articleApprovalXLSXRelationships
	if err := xml.Unmarshal(workbookData, &workbook); err != nil {
		return nil, err
	}
	if err := xml.Unmarshal(relationshipData, &relationships); err != nil {
		return nil, err
	}
	relationshipByID := map[string]articleApprovalXLSXRelationship{}
	for _, item := range relationships.Items {
		if strings.TrimSpace(item.ID) == "" {
			return nil, errors.New("source XLSX workbook relationship is malformed")
		}
		if _, exists := relationshipByID[item.ID]; exists {
			return nil, fmt.Errorf("source XLSX workbook relationship id is duplicated: %s", item.ID)
		}
		relationshipByID[item.ID] = item
	}
	var relationship articleApprovalXLSXRelationship
	foundRelationship := false
	for _, sheet := range workbook.Sheets {
		if sheet.Name == sheetName {
			relationship, foundRelationship = relationshipByID[sheet.ID]
			break
		}
	}
	if !foundRelationship {
		return nil, fmt.Errorf("required XLSX sheet %q is missing", sheetName)
	}
	target, err := articleApprovalResolveXLSXWorksheetTarget(relationship)
	if err != nil {
		return nil, fmt.Errorf("required XLSX sheet %q relationship is invalid: %w", sheetName, err)
	}
	sheetData, err := articleApprovalZIPRead(archive, target)
	if err != nil {
		return nil, err
	}
	shared, err := articleApprovalXLSXStrings(archive)
	if err != nil {
		return nil, err
	}
	var worksheet articleApprovalXLSXWorksheet
	if err := xml.Unmarshal(sheetData, &worksheet); err != nil {
		return nil, err
	}
	result := make([]map[int]string, 0, len(worksheet.Rows))
	for _, row := range worksheet.Rows {
		values := map[int]string{}
		for _, cell := range row.Cells {
			column := articleApprovalXLSXColumn(cell.Reference)
			value := cell.Value
			if cell.Type == "s" {
				index, parseErr := strconv.Atoi(value)
				if parseErr != nil || index < 0 || index >= len(shared) {
					return nil, errors.New("source XLSX shared string index is invalid")
				}
				value = shared[index]
			} else if cell.Type == "inlineStr" {
				value = cell.Inline.Text
			}
			values[column] = cleanBusinessText(value, 1000)
		}
		result = append(result, values)
	}
	return result, nil
}

func articleApprovalCatalogFromSource(path string) ([]articleApprovalCatalogItem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return articleApprovalCatalogFromData(data)
}

func articleApprovalCatalogFromData(data []byte) ([]articleApprovalCatalogItem, error) {
	erpRows, err := articleApprovalXLSXRowsData(data, "04_ERP_статьи")
	if err != nil {
		return nil, fmt.Errorf("ARTICLE_APPROVAL_SOURCE_ERP_CATALOG_INVALID: %w", err)
	}
	erpHeaders := map[string]int{}
	erpHeaderIndex := -1
	for index, row := range erpRows {
		for column, value := range row {
			erpHeaders[value] = column
		}
		if erpHeaders["Статья ERP"] > 0 && erpHeaders["Код статьи"] > 0 && erpHeaders["Статус справочника"] > 0 {
			erpHeaderIndex = index
			break
		}
		erpHeaders = map[string]int{}
	}
	if erpHeaderIndex < 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_ERP_CATALOG_HEADERS_INVALID")
	}
	result := []articleApprovalCatalogItem{}
	seen := map[string]struct{}{}
	for _, row := range erpRows[erpHeaderIndex+1:] {
		if !strings.HasPrefix(strings.ToUpper(cleanBusinessText(row[erpHeaders["Статус справочника"]], 100)), "MATCHED") {
			continue
		}
		article := cleanBusinessText(row[erpHeaders["Статья ERP"]], 300)
		catalogPath := cleanBusinessText(row[erpHeaders["Путь по справочнику ERP"]], 700)
		if catalogPath == "" {
			catalogPath = cleanBusinessText(row[erpHeaders["Полный путь ERP"]], 700)
		}
		parts := strings.Split(catalogPath, "/")
		cleanParts := make([]string, 0, len(parts))
		for _, part := range parts {
			if part = cleanBusinessText(part, 300); part != "" {
				cleanParts = append(cleanParts, part)
			}
		}
		block := ""
		if len(cleanParts) >= 2 && strings.EqualFold(cleanParts[len(cleanParts)-1], article) {
			block = cleanParts[len(cleanParts)-2]
		} else if len(cleanParts) >= 1 {
			block = cleanParts[len(cleanParts)-1]
		}
		codes := strings.FieldsFunc(row[erpHeaders["Код статьи"]], func(character rune) bool {
			return character == ',' || character == ';' || character == '|' || character == '\n' || character == '\r'
		})
		for _, code := range codes {
			code = cleanBusinessText(code, 200)
			if code == "" || block == "" || article == "" {
				continue
			}
			key := strings.ToLower(code + "|" + block + "|" + article)
			if _, exists := seen[key]; !exists {
				seen[key] = struct{}{}
				result = append(result, articleApprovalCatalogItem{Code: code, Block: block, Article: article})
			}
		}
	}
	if len(result) == 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_ERP_CATALOG_EMPTY")
	}
	return result, nil
}

func articleApprovalRulesFromData(data []byte, scope articleApprovalScope) ([]articleApprovalRow, error) {
	values, err := articleApprovalXLSXRowsData(data, "01_Правила")
	if err != nil {
		return nil, fmt.Errorf("ARTICLE_APPROVAL_SOURCE_RULES_INVALID: %w", err)
	}
	headerIndex := -1
	for index, row := range values {
		exact := true
		for column, expected := range articleApprovalRuleColumns {
			if cleanBusinessText(row[column+1], 300) != expected {
				exact = false
				break
			}
		}
		if exact {
			for column, value := range row {
				if column < 1 || column > len(articleApprovalRuleColumns) {
					if cleanBusinessText(value, 300) != "" {
						exact = false
						break
					}
				}
			}
		}
		if exact {
			headerIndex = index
			break
		}
	}
	if headerIndex < 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_RULES_21_COLUMNS_INVALID")
	}
	rows := []articleApprovalRow{}
	for _, valuesByColumn := range values[headerIndex+1:] {
		nonempty := false
		for column, value := range valuesByColumn {
			if cleanBusinessText(value, 1000) == "" {
				continue
			}
			nonempty = true
			if column < 1 || column > len(articleApprovalRuleColumns) {
				return nil, errors.New("ARTICLE_APPROVAL_SOURCE_RULES_21_COLUMNS_INVALID")
			}
		}
		if !nonempty {
			continue
		}
		row := articleApprovalRow{
			ScopeKey: valuesByColumn[1], OrganizationID: valuesByColumn[2], OrganizationName: valuesByColumn[3], Period: valuesByColumn[4],
			BlockIntalev: valuesByColumn[5], PathIntalev: valuesByColumn[6], ArticleIntalev: valuesByColumn[7],
			IncomeExpenseAccount: valuesByColumn[8], SettlementAccount: valuesByColumn[9],
			ProposedBlockERP: valuesByColumn[10], ProposedArticleERP: valuesByColumn[11], ProposedCodeERP: valuesByColumn[12],
			Action: valuesByColumn[13], SelectionReason: valuesByColumn[14], Confidence: valuesByColumn[15], PhysicalExamples: valuesByColumn[16],
			UserDecision: valuesByColumn[17], CorrectBlockERP: valuesByColumn[18], CorrectArticleERP: valuesByColumn[19],
			CorrectCodeERP: valuesByColumn[20], UserComment: valuesByColumn[21],
		}
		expectedKey := articleApprovalScopeKey(scope, row)
		if row.ScopeKey != expectedKey || row.OrganizationID != scope.OrganizationID || row.OrganizationName != scope.OrganizationName || row.Period != scope.Period {
			return nil, errors.New("ARTICLE_APPROVAL_SOURCE_RULE_SCOPE_MISMATCH")
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_RULES_EMPTY")
	}
	return articleApprovalCanonicalRows(rows, scope), nil
}

func articleApprovalReadBoundWorkbook(path string, allowance verifiedResultArtifact) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != allowance.Size || allowance.Size <= 0 || allowance.Size > allowance.Limit {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_SIZE_MISMATCH")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_XLSX_UNREADABLE")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, allowance.Size+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || int64(len(data)) != allowance.Size {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_SIZE_MISMATCH")
	}
	digest := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(digest[:]), allowance.SHA256) {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH")
	}
	return data, nil
}

func articleApprovalQueueRowID(runID, sourceSHA string, index int, row articleApprovalRow) string {
	data, _ := json.Marshal(struct {
		RunID     string
		SourceSHA string
		Index     int
		Row       articleApprovalRow
	}{runID, sourceSHA, index, row})
	digest := sha256.Sum256(data)
	return "row_" + hex.EncodeToString(digest[:16])
}

func articleApprovalBulkBlockers(rows []articleApprovalRow, index int, catalog []articleApprovalCatalogItem) []string {
	row := rows[index]
	blockers := []string{}
	if row.UserDecision != "ПРЕДЛОЖЕНО ДВИЖКОМ" {
		blockers = append(blockers, "INITIAL_DECISION_NOT_ENGINE_PROPOSAL")
	}
	matches := 0
	codeMatches := 0
	for _, item := range catalog {
		if item.Code == row.ProposedCodeERP {
			codeMatches++
			if strings.EqualFold(item.Block, row.ProposedBlockERP) && strings.EqualFold(item.Article, row.ProposedArticleERP) {
				matches++
			}
		}
	}
	if matches != 1 || codeMatches != 1 {
		blockers = append(blockers, "ERP_TARGET_NOT_UNIQUE")
	}
	targets := map[string]struct{}{}
	for _, candidate := range rows {
		if articleApprovalScopeKey(articleApprovalScope{OrganizationID: row.OrganizationID, Period: row.Period}, candidate) != articleApprovalScopeKey(articleApprovalScope{OrganizationID: row.OrganizationID, Period: row.Period}, row) {
			continue
		}
		targets[strings.ToLower(candidate.ProposedBlockERP+"|"+candidate.ProposedArticleERP+"|"+candidate.ProposedCodeERP)] = struct{}{}
	}
	if len(targets) != 1 {
		blockers = append(blockers, "SCOPE_TARGET_CONFLICT")
	}
	return blockers
}

func (s *Server) prepareArticleApprovalQueue(runID string) (articleApprovalQueue, error) {
	runID = cleanBusinessText(runID, 180)
	base, err := secureBaseName(runID)
	if err != nil || base != runID {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_RUN_ID_INVALID")
	}
	run, ok := s.store.Run(runID)
	if !ok {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_RUN_NOT_FOUND")
	}
	if run.Status != RunCompletedReportOnly || run.FinishedAt == nil || (run.Stage != "DONE" && run.Stage != "R005_COMPLETED") {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_RUN_NOT_COMPLETED")
	}
	contextValue, ok := s.store.Context(run.ContextID)
	if !ok || contextValue.Archived {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_RUN_SCOPE_INVALID")
	}
	requestedScope := articleApprovalScopeFromContext(contextValue)
	scope, err := articleApprovalResolveScope(s.store, articleApprovalRequest{
		OrganizationID: requestedScope.OrganizationID, OrganizationName: requestedScope.OrganizationName,
		OrganizationPath: requestedScope.OrganizationPath, Period: requestedScope.Period,
	})
	if err != nil || !articleApprovalScopeEqual(scope, requestedScope) {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_RUN_SCOPE_INVALID")
	}
	root := filepath.Join(s.store.RunsDir(), run.ID, "r005")
	allowances, err := s.validatedR005ResultAllowances(root, run)
	if err != nil {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_R005_ANCHOR_INVALID")
	}
	allowance, ok := allowances["reconciliation.xlsx"]
	if !ok || allowance.Name != "reconciliation.xlsx" {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_R005_REPORT_INVALID")
	}
	reportPath := filepath.Join(root, "reconciliation.xlsx")
	workbook, err := articleApprovalReadBoundWorkbook(reportPath, allowance)
	if err != nil {
		return articleApprovalQueue{}, err
	}
	catalog, err := articleApprovalCatalogFromData(workbook)
	if err != nil {
		return articleApprovalQueue{}, err
	}
	rows, err := articleApprovalRulesFromData(workbook, scope)
	if err != nil {
		return articleApprovalQueue{}, err
	}
	if issues := articleApprovalValidateRows(rows, scope, catalog, true); len(issues) > 0 {
		return articleApprovalQueue{}, fmt.Errorf("ARTICLE_APPROVAL_SOURCE_RULES_INVALID: %s", issues[0].Code)
	}
	actor, err := articleApprovalHostActor()
	if err != nil || !articleApprovalActor.MatchString(actor) {
		return articleApprovalQueue{}, errors.New("ARTICLE_APPROVAL_HOST_ACTOR_UNAVAILABLE")
	}
	sourceRelative := filepath.ToSlash(filepath.Join("runs", run.ID, "r005", "reconciliation.xlsx"))
	prepared := articleApprovalPrepared{Scope: scope, Source: articleApprovalSource{XLSX: sourceRelative, SHA256: allowance.SHA256}, Rows: rows, Catalog: catalog}
	queueRows := make([]articleApprovalQueueRow, len(rows))
	bulkCount := 0
	for index, row := range rows {
		blockers := articleApprovalBulkBlockers(rows, index, catalog)
		approvable := len(blockers) == 0
		if approvable {
			bulkCount++
		}
		queueRows[index] = articleApprovalQueueRow{
			RowID:        articleApprovalQueueRowID(run.ID, allowance.SHA256, index, row),
			BlockIntalev: row.BlockIntalev, PathIntalev: row.PathIntalev, ArticleIntalev: row.ArticleIntalev,
			IncomeExpenseAccount: row.IncomeExpenseAccount, SettlementAccount: row.SettlementAccount,
			ProposedBlockERP: row.ProposedBlockERP, ProposedArticleERP: row.ProposedArticleERP, ProposedCodeERP: row.ProposedCodeERP,
			Action: row.Action, SelectionReason: row.SelectionReason, Confidence: row.Confidence, PhysicalExamples: row.PhysicalExamples,
			UserDecision: row.UserDecision, CorrectBlockERP: row.CorrectBlockERP, CorrectArticleERP: row.CorrectArticleERP,
			CorrectCodeERP: row.CorrectCodeERP, UserComment: row.UserComment,
			BulkApprovable: approvable, BulkApprovalBlockers: blockers,
		}
	}
	revisionPayload := struct {
		Schema  string
		RunID   string
		Size    int64
		SHA256  string
		Scope   articleApprovalScope
		Actor   string
		Rows    []articleApprovalQueueRow
		Catalog []articleApprovalCatalogItem
	}{articleApprovalQueueSchema, run.ID, allowance.Size, allowance.SHA256, scope, actor, queueRows, catalog}
	revisionData, err := json.Marshal(revisionPayload)
	if err != nil {
		return articleApprovalQueue{}, err
	}
	revisionDigest := sha256.Sum256(revisionData)
	return articleApprovalQueue{
		Status: "PASS", SchemaVersion: articleApprovalQueueSchema, RunID: run.ID,
		QueueRevision: strings.ToUpper(hex.EncodeToString(revisionDigest[:])), OrganizationScope: scope, Actor: actor,
		AllowedDecisions: append([]string{}, articleApprovalDecisionList...), Rows: queueRows, BulkApprovable: bulkCount,
		Safety: reportOnlySafety(), prepared: prepared,
	}, nil
}

func articleApprovalApplyQueueRequest(queue articleApprovalQueue, request articleApprovalQueueRequest) (articleApprovalPrepared, []articleApprovalIssue, error) {
	if request.RunID != queue.RunID || request.Revision != queue.QueueRevision {
		return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_QUEUE_REVISION_STALE")
	}
	if len(request.Decisions) != len(queue.Rows) {
		return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_DECISION_SET_INCOMPLETE")
	}
	byID := make(map[string]articleApprovalQueueDecision, len(request.Decisions))
	allowedIDs := make(map[string]struct{}, len(queue.Rows))
	for _, row := range queue.Rows {
		allowedIDs[row.RowID] = struct{}{}
	}
	for _, decision := range request.Decisions {
		decision.RowID = cleanBusinessText(decision.RowID, 100)
		if decision.RowID == "" {
			return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_ROW_ID_INVALID")
		}
		if _, exists := byID[decision.RowID]; exists {
			return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_ROW_ID_DUPLICATE")
		}
		if _, exists := allowedIDs[decision.RowID]; !exists {
			return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_ROW_ID_EXTRA")
		}
		byID[decision.RowID] = decision
	}
	hydrated := make([]articleApprovalRow, len(queue.Rows))
	for index, queueRow := range queue.Rows {
		decision, exists := byID[queueRow.RowID]
		if !exists {
			return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_DECISION_SET_INCOMPLETE")
		}
		delete(byID, queueRow.RowID)
		row := queue.prepared.Rows[index]
		decision.UserDecision = cleanBusinessText(decision.UserDecision, 80)
		decision.CorrectBlockERP = cleanBusinessText(decision.CorrectBlockERP, 300)
		decision.CorrectArticleERP = cleanBusinessText(decision.CorrectArticleERP, 300)
		decision.CorrectCodeERP = cleanBusinessText(decision.CorrectCodeERP, 200)
		decision.UserComment = cleanBusinessText(decision.UserComment, 1000)
		if request.BulkApprove {
			if queueRow.BulkApprovable {
				decision.UserDecision = "УТВЕРЖДАЮ"
				decision.CorrectBlockERP, decision.CorrectArticleERP, decision.CorrectCodeERP, decision.UserComment = "", "", "", ""
			} else if decision.UserDecision != row.UserDecision || decision.CorrectBlockERP != row.CorrectBlockERP || decision.CorrectArticleERP != row.CorrectArticleERP || decision.CorrectCodeERP != row.CorrectCodeERP || decision.UserComment != row.UserComment {
				return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_BULK_ROW_NOT_ELIGIBLE")
			}
		}
		row.UserDecision = decision.UserDecision
		row.CorrectBlockERP = decision.CorrectBlockERP
		row.CorrectArticleERP = decision.CorrectArticleERP
		row.CorrectCodeERP = decision.CorrectCodeERP
		row.UserComment = decision.UserComment
		hydrated[index] = row
	}
	if len(byID) != 0 {
		return articleApprovalPrepared{}, nil, errors.New("ARTICLE_APPROVAL_ROW_ID_EXTRA")
	}
	issues := articleApprovalValidateRows(hydrated, queue.prepared.Scope, queue.prepared.Catalog, true)
	prepared := queue.prepared
	prepared.Rows = articleApprovalCanonicalRows(hydrated, prepared.Scope)
	return prepared, issues, nil
}

func (s *Server) prepareArticleApproval(request articleApprovalRequest) (articleApprovalPrepared, []articleApprovalIssue, error) {
	scope, err := articleApprovalResolveScope(s.store, request)
	if err != nil {
		return articleApprovalPrepared{}, nil, err
	}
	source, sourcePath, err := articleApprovalResolveSource(s.store, request.SourceXLSX, request.SourceSHA256)
	if err != nil {
		return articleApprovalPrepared{}, nil, err
	}
	catalog, err := articleApprovalCatalogFromSource(sourcePath)
	if err != nil {
		return articleApprovalPrepared{}, nil, err
	}
	rows := request.Decisions
	if rows == nil {
		rows = request.Rows
	}
	issues := articleApprovalValidateRows(rows, scope, catalog, true)
	return articleApprovalPrepared{Scope: scope, Source: source, Rows: articleApprovalCanonicalRows(rows, scope), Catalog: catalog}, issues, nil
}

func articleApprovalScopeFromRequest(request articleApprovalRequest) articleApprovalScope {
	name := cleanBusinessText(request.OrganizationName, 300)
	if name == "" {
		name = cleanBusinessText(request.Organization, 300)
	}
	path := cleanBusinessText(request.OrganizationPath, 700)
	if path == "" {
		path = cleanBusinessText(request.OrganizationHierarchyPath, 700)
	}
	return articleApprovalScope{
		OrganizationID: cleanBusinessText(request.OrganizationID, 200), OrganizationName: name,
		OrganizationPath: path, Period: cleanBusinessText(request.Period, 20),
	}
}

func articleApprovalScopeFromContext(contextValue Context) articleApprovalScope {
	return articleApprovalScope{
		OrganizationID: contextValue.OrganizationID, OrganizationName: contextValue.OrganizationName,
		OrganizationPath: contextValue.OrganizationPath, Period: contextValue.Period,
	}
}

func articleApprovalScopeEqual(left, right articleApprovalScope) bool {
	return left.OrganizationID == right.OrganizationID && left.OrganizationName == right.OrganizationName &&
		left.OrganizationPath == right.OrganizationPath && left.Period == right.Period
}

func articleApprovalOrganizationScopeEqual(left, right articleApprovalScope) bool {
	return left.OrganizationID == right.OrganizationID && left.OrganizationName == right.OrganizationName &&
		left.OrganizationPath == right.OrganizationPath
}

func articleApprovalTarget(row articleApprovalRow) (string, string, string) {
	if row.UserDecision == "ИЗМЕНИТЬ" {
		return cleanBusinessText(row.CorrectBlockERP, 300), cleanBusinessText(row.CorrectArticleERP, 300), cleanBusinessText(row.CorrectCodeERP, 200)
	}
	return cleanBusinessText(row.ProposedBlockERP, 300), cleanBusinessText(row.ProposedArticleERP, 300), cleanBusinessText(row.ProposedCodeERP, 200)
}

func articleApprovalValidateRows(rows []articleApprovalRow, scope articleApprovalScope, catalog []articleApprovalCatalogItem, requireCatalog bool) []articleApprovalIssue {
	issues := []articleApprovalIssue{}
	catalogByCode := map[string][]articleApprovalCatalogItem{}
	for _, item := range catalog {
		item.Code = cleanBusinessText(item.Code, 200)
		item.Block = cleanBusinessText(item.Block, 300)
		item.Article = cleanBusinessText(item.Article, 300)
		if item.Code != "" {
			catalogByCode[item.Code] = append(catalogByCode[item.Code], item)
		}
	}
	if len(rows) == 0 {
		return []articleApprovalIssue{{Code: "ARTICLE_APPROVAL_ROWS_REQUIRED", Message: "Нужна хотя бы одна строка решения"}}
	}
	seenTargets := map[string]string{}
	for index, original := range rows {
		rowNumber := index + 1
		row := original
		row.ScopeKey = cleanBusinessText(row.ScopeKey, 800)
		row.OrganizationID = cleanBusinessText(row.OrganizationID, 200)
		row.OrganizationName = cleanBusinessText(row.OrganizationName, 300)
		row.Period = cleanBusinessText(row.Period, 20)
		row.BlockIntalev = cleanBusinessText(row.BlockIntalev, 300)
		row.PathIntalev = cleanBusinessText(row.PathIntalev, 700)
		row.ArticleIntalev = cleanBusinessText(row.ArticleIntalev, 300)
		row.UserDecision = cleanBusinessText(row.UserDecision, 80)
		for field, value := range map[string]string{
			"organization_id": row.OrganizationID, "organization_name": row.OrganizationName,
			"period": row.Period, "block_intalev": row.BlockIntalev, "path_intalev": row.PathIntalev,
			"article_intalev": row.ArticleIntalev, "user_decision": row.UserDecision,
		} {
			if value == "" {
				issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "REQUIRED_FIELD_MISSING", Field: field, Message: "Обязательное поле не заполнено"})
			}
		}
		if row.OrganizationID != scope.OrganizationID || row.OrganizationName != scope.OrganizationName {
			issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "ORGANIZATION_SCOPE_MISMATCH", Message: "Строка относится к другой организации"})
		}
		if row.Period != scope.Period || !articleApprovalMonth.MatchString(row.Period) {
			issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "PERIOD_SCOPE_MISMATCH", Message: "Строка относится к другому или неверному месяцу"})
		}
		if _, ok := articleApprovalDecisions[row.UserDecision]; !ok {
			issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "DECISION_INVALID", Message: "Допустимы только пять решений S04"})
			continue
		}
		if row.UserDecision == "ИЗМЕНИТЬ" && (cleanBusinessText(row.CorrectBlockERP, 300) == "" || cleanBusinessText(row.CorrectArticleERP, 300) == "" || cleanBusinessText(row.CorrectCodeERP, 200) == "" || cleanBusinessText(row.UserComment, 1000) == "") {
			issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "CHANGE_FIELDS_REQUIRED", Message: "Для ИЗМЕНИТЬ обязательны блок, статья, код и комментарий"})
		}
		block, article, code := articleApprovalTarget(row)
		requireKnownTarget := row.UserDecision == "УТВЕРЖДАЮ" || row.UserDecision == "ИЗМЕНИТЬ" || row.UserDecision == "ПРЕДЛОЖЕНО ДВИЖКОМ"
		if code != "" && requireKnownTarget {
			if requireCatalog && len(catalogByCode) == 0 {
				issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "ERP_CATALOG_REQUIRED", Message: "Для проверки ERP-кода нужен каталог выбранного блока"})
			} else if items, ok := catalogByCode[code]; requireCatalog && !ok {
				issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "ERP_CODE_UNKNOWN", Message: "Код ERP отсутствует в проверенном каталоге"})
			} else if ok {
				matched := false
				for _, item := range items {
					if strings.EqualFold(item.Block, block) && strings.EqualFold(item.Article, article) {
						matched = true
						break
					}
				}
				if !matched {
					issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "ERP_TARGET_BLOCK_OR_ARTICLE_MISMATCH", Message: "ERP-статья не принадлежит выбранному блоку"})
				}
			}
		}
		if (row.UserDecision == "УТВЕРЖДАЮ" || row.UserDecision == "ИЗМЕНИТЬ") && (block == "" || article == "" || code == "") {
			issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "APPROVED_TARGET_REQUIRED", Message: "Утверждаемая ERP-цель неполна"})
		}
		if row.UserDecision == "УТВЕРЖДАЮ" || row.UserDecision == "ИЗМЕНИТЬ" {
			targetKey := strings.ToLower(block) + "|" + strings.ToLower(article) + "|" + code
			scopeKey := articleApprovalScopeKey(scope, row)
			if previous, exists := seenTargets[scopeKey]; exists && previous != targetKey {
				issues = append(issues, articleApprovalIssue{Row: rowNumber, Code: "CONFLICTING_TARGETS", Message: "В одной области указаны две разные ERP-цели"})
			}
			seenTargets[scopeKey] = targetKey
		}
	}
	return issues
}

func articleApprovalOrganizationSlug(scope articleApprovalScope) string {
	transliterated := strings.NewReplacer(
		"А", "A", "Б", "B", "В", "V", "Г", "G", "Д", "D", "Е", "E", "Ё", "E", "Ж", "Zh", "З", "Z", "И", "I", "Й", "Y", "К", "K", "Л", "L", "М", "M", "Н", "N", "О", "O", "П", "P", "Р", "R", "С", "S", "Т", "T", "У", "U", "Ф", "F", "Х", "Kh", "Ц", "Ts", "Ч", "Ch", "Ш", "Sh", "Щ", "Sch", "Ъ", "", "Ы", "Y", "Ь", "", "Э", "E", "Ю", "Yu", "Я", "Ya",
		"а", "a", "б", "b", "в", "v", "г", "g", "д", "d", "е", "e", "ё", "e", "ж", "zh", "з", "z", "и", "i", "й", "y", "к", "k", "л", "l", "м", "m", "н", "n", "о", "o", "п", "p", "р", "r", "с", "s", "т", "t", "у", "u", "ф", "f", "х", "kh", "ц", "ts", "ч", "ch", "ш", "sh", "щ", "sch", "ъ", "", "ы", "y", "ь", "", "э", "e", "ю", "yu", "я", "ya",
	).Replace(scope.OrganizationID + "_" + scope.OrganizationName)
	result := strings.ToLower(transliterated)
	result = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(result, "_")
	return strings.Trim(result, "_")
}

func articleApprovalDirectory(store *Store) string {
	return filepath.Join(store.Root(), "user-settings", "approvals")
}

func articleApprovalVersionPattern(slug string) *regexp.Regexp {
	return regexp.MustCompile(`^article_registry_` + regexp.QuoteMeta(slug) + `_v([0-9]+)\.approved\.json$`)
}

func articleApprovalPublicationVersionPattern(slug string) *regexp.Regexp {
	return regexp.MustCompile(`^article_registry_` + regexp.QuoteMeta(slug) + `_v([0-9]+)\.approved\.json(?:\.sha256)?$`)
}

func articleApprovalReadFileBytes(path string) (articleApprovalDocument, string, []byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionPublicationRead, err)
	}
	if !info.Mode().IsRegular() {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionPublicationRead, errors.New("approved publication is not a regular file"))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionPublicationRead, err)
	}
	sidecarInfo, err := os.Lstat(path + ".sha256")
	if err != nil {
		code := articleApprovalRejectionSidecarRead
		if errors.Is(err, os.ErrNotExist) {
			code = articleApprovalRejectionSidecarMissing
		}
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(code, fmt.Errorf("approved SHA-256 sidecar is missing: %w", err))
	}
	if !sidecarInfo.Mode().IsRegular() {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionSidecarRead, errors.New("approved SHA-256 sidecar is not a regular file"))
	}
	sidecar, err := os.ReadFile(path + ".sha256")
	if err != nil {
		code := articleApprovalRejectionSidecarRead
		if errors.Is(err, os.ErrNotExist) {
			code = articleApprovalRejectionSidecarMissing
		}
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(code, fmt.Errorf("approved SHA-256 sidecar is missing: %w", err))
	}
	actual := sha256.Sum256(data)
	actualSHA := strings.ToUpper(hex.EncodeToString(actual[:]))
	fields := strings.Fields(string(sidecar))
	if len(fields) != 2 || fields[1] != filepath.Base(path) {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionSidecarInvalid, errors.New("approved SHA-256 sidecar metadata is invalid"))
	}
	declared := strings.ToUpper(fields[0])
	if !articleApprovalSHA.MatchString(declared) || declared != actualSHA {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionSHA256Mismatch, errors.New("approved SHA-256 does not match JSON"))
	}
	var document articleApprovalDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		return articleApprovalDocument{}, "", nil, newArticleApprovalRejection(articleApprovalRejectionMalformedJSON, err)
	}
	if err := validateArticleApprovalRawSafety(data); err != nil {
		return document, "", nil, newArticleApprovalRejection(articleApprovalRejectionUnsafeMetadata, err)
	}
	return document, actualSHA, data, nil

}

func articleApprovalReadFile(path string) (articleApprovalDocument, string, error) {
	document, digest, _, err := articleApprovalReadFileBytes(path)
	return document, digest, err
}

func validateArticleApprovalRawSafety(data []byte) error {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return err
	}
	raw, ok := top["safety"]
	if !ok {
		return errors.New("approved document safety metadata is missing")
	}
	var safety map[string]json.RawMessage
	if err := json.Unmarshal(raw, &safety); err != nil {
		return errors.New("approved document safety metadata is invalid")
	}
	expected := []string{"mode", "decision_type", "financial_rows", "posting_rows", "ready_to_upload", "release_allowed", "live_1c_allowed"}
	if len(safety) != len(expected) {
		return errors.New("approved document safety metadata is not exact")
	}
	for _, key := range expected {
		if _, exists := safety[key]; !exists {
			return errors.New("approved document safety metadata is not exact")
		}
	}
	var mode, decisionType string
	var financialRows, postingRows int
	var readyToUpload, releaseAllowed, live1CAllowed bool
	if json.Unmarshal(safety["mode"], &mode) != nil || json.Unmarshal(safety["decision_type"], &decisionType) != nil ||
		json.Unmarshal(safety["financial_rows"], &financialRows) != nil || json.Unmarshal(safety["posting_rows"], &postingRows) != nil ||
		json.Unmarshal(safety["ready_to_upload"], &readyToUpload) != nil || json.Unmarshal(safety["release_allowed"], &releaseAllowed) != nil ||
		json.Unmarshal(safety["live_1c_allowed"], &live1CAllowed) != nil {
		return errors.New("approved document safety metadata has invalid types")
	}
	if mode != "REPORT_ONLY" || decisionType != "CLASSIFICATION_ONLY" || financialRows != 0 || postingRows != 0 || readyToUpload || releaseAllowed || live1CAllowed {
		return errors.New("approved document opens financial authority")
	}
	return nil
}

func validateArticleApprovalDocument(document articleApprovalDocument, scope articleApprovalScope) error {
	if document.SchemaVersion != articleApprovalSchema || document.Version < 1 || document.ApprovalID == "" || !articleApprovalActor.MatchString(document.Actor) {
		return newArticleApprovalRejection(articleApprovalRejectionMetadataInvalid, errors.New("approved document metadata is invalid"))
	}
	if !articleApprovalScopeEqual(document.OrganizationScope, scope) || document.Validity.From != scope.Period || document.Validity.To != scope.Period {
		return newArticleApprovalRejection(articleApprovalRejectionScopeMismatch, errors.New("approved document organization or period scope mismatch"))
	}
	if !articleApprovalMonth.MatchString(document.Validity.From) || document.Source.XLSX == "" || !articleApprovalSHA.MatchString(document.Source.SHA256) {
		return newArticleApprovalRejection(articleApprovalRejectionSourceInvalid, errors.New("approved document source or period is invalid"))
	}
	if document.Safety.Mode != "REPORT_ONLY" || document.Safety.DecisionType != "CLASSIFICATION_ONLY" || document.Safety.FinancialRows != 0 || document.Safety.PostingRows != 0 || document.Safety.ReadyToUpload || document.Safety.ReleaseAllowed || document.Safety.Live1CAllowed {
		return newArticleApprovalRejection(articleApprovalRejectionUnsafeMetadata, errors.New("approved document opens financial authority"))
	}
	issues := articleApprovalValidateRows(document.Decisions, scope, nil, false)
	if len(issues) > 0 {
		return newArticleApprovalRejection(articleApprovalRejectionDecisions, fmt.Errorf("approved document contains invalid decisions: %s", issues[0].Code))
	}
	return nil
}

func validateArticleApprovalStoredSource(store *Store, source articleApprovalSource) error {
	resolved, _, err := articleApprovalResolveSource(store, source.XLSX, source.SHA256)
	if err != nil {
		return newArticleApprovalRejection(articleApprovalRejectionSourceBinding, err)
	}
	if resolved.XLSX != source.XLSX || resolved.SHA256 != source.SHA256 {
		return newArticleApprovalRejection(articleApprovalRejectionSourceBinding, errors.New("approved document source binding is not canonical"))
	}
	return nil
}

func articleApprovalLatestSelection(store *Store, scope articleApprovalScope) (articleApprovalSelection, error) {
	slug := articleApprovalOrganizationSlug(scope)
	entries, err := os.ReadDir(articleApprovalDirectory(store))
	if errors.Is(err, os.ErrNotExist) {
		return articleApprovalSelection{}, nil
	}
	if err != nil {
		return articleApprovalSelection{}, err
	}
	pattern := articleApprovalVersionPattern(slug)
	type candidate struct {
		version int
		path    string
	}
	candidates := []candidate{}
	for _, entry := range entries {
		match := pattern.FindStringSubmatch(entry.Name())
		if len(match) != 2 || entry.IsDir() {
			continue
		}
		version, parseErr := strconv.Atoi(match[1])
		if parseErr == nil {
			candidates = append(candidates, candidate{version: version, path: filepath.Join(articleApprovalDirectory(store), entry.Name())})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].version > candidates[j].version })
	var firstError error
	rejected := []articleApprovalRejectedCandidate{}
	for _, item := range candidates {
		document, publicationSHA, readErr := articleApprovalReadFile(item.path)
		if readErr != nil {
			if firstError == nil {
				firstError = readErr
			}
			rejected = append(rejected, articleApprovalRejectedCandidate{
				Publication: filepath.Base(item.path), Version: item.version, Code: articleApprovalRejectionCode(readErr),
			})
			continue
		}
		if document.Version != item.version {
			versionErr := newArticleApprovalRejection(articleApprovalRejectionVersionMismatch, errors.New("approved document version does not match publication name"))
			if firstError == nil {
				firstError = versionErr
			}
			rejected = append(rejected, articleApprovalRejectedCandidate{
				Publication: filepath.Base(item.path), ApprovalID: articleApprovalDiagnosticApprovalID(document),
				Version: item.version, Code: articleApprovalRejectionCode(versionErr),
			})
			continue
		}
		validationScope := scope
		otherMonth := articleApprovalOrganizationScopeEqual(document.OrganizationScope, scope) && document.OrganizationScope.Period != scope.Period
		if otherMonth {
			validationScope = document.OrganizationScope
		}
		if validateErr := validateArticleApprovalDocument(document, validationScope); validateErr != nil {
			if firstError == nil {
				firstError = validateErr
			}
			rejected = append(rejected, articleApprovalRejectedCandidate{
				Publication: filepath.Base(item.path), Version: item.version, Code: articleApprovalRejectionCode(validateErr),
			})
			continue
		}
		if validateErr := validateArticleApprovalStoredSource(store, document.Source); validateErr != nil {
			if firstError == nil {
				firstError = validateErr
			}
			rejected = append(rejected, articleApprovalRejectedCandidate{
				Publication: filepath.Base(item.path), ApprovalID: articleApprovalDiagnosticApprovalID(document),
				Version: item.version, Code: articleApprovalRejectionCode(validateErr),
			})
			continue
		}
		if otherMonth {
			continue
		}
		diagnostics := make([]articleApprovalDiagnostic, 0, len(rejected))
		for _, item := range rejected {
			diagnostics = append(diagnostics, articleApprovalDiagnostic{
				Code: articleApprovalFallbackDiagnosticCode, RejectionCode: item.Code,
				RejectedPublication: item.Publication, RejectedApprovalID: item.ApprovalID, RejectedVersion: item.Version,
				SelectedFallbackApprovalID: articleApprovalDiagnosticApprovalID(document), SelectedFallbackVersion: document.Version,
				SelectedFallbackSHA256: publicationSHA, OrganizationID: scope.OrganizationID,
				OrganizationName: scope.OrganizationName, OrganizationPath: scope.OrganizationPath,
				Period: scope.Period, FallbackOccurred: true,
			})
		}
		return articleApprovalSelection{Document: document, Path: item.path, SHA256: publicationSHA, Diagnostics: diagnostics}, nil
	}
	if firstError != nil {
		return articleApprovalSelection{}, firstError
	}
	return articleApprovalSelection{}, nil
}

func articleApprovalLatest(store *Store, scope articleApprovalScope) (articleApprovalDocument, string, error) {
	selection, err := articleApprovalLatestSelection(store, scope)
	return selection.Document, selection.Path, err
}

func articleApprovalDocumentBytes(document articleApprovalDocument) ([]byte, string, error) {
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, "", err
	}
	data = append(data, '\n')
	digest := sha256.Sum256(data)
	return data, strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func articleApprovalVerifiedPublicationBytes(store *Store, selection articleApprovalSelection, scope articleApprovalScope) ([]byte, error) {
	if selection.Path == "" || !articleApprovalSHA.MatchString(selection.SHA256) {
		return nil, errors.New("selected article approval publication identity is incomplete")
	}
	document, actual, data, err := articleApprovalReadFileBytes(selection.Path)
	if err != nil {
		return nil, err
	}
	if actual != selection.SHA256 || document.Version != selection.Document.Version || document.ApprovalID != selection.Document.ApprovalID {
		return nil, errors.New("selected article approval publication changed after validation")
	}
	if err := validateArticleApprovalDocument(document, scope); err != nil {
		return nil, err
	}
	if err := validateArticleApprovalStoredSource(store, document.Source); err != nil {
		return nil, err
	}
	return data, nil
}

func articleApprovalDiagnosticArtifactBytes(run Run, diagnostics []articleApprovalDiagnostic) ([]byte, string, error) {
	artifact := articleApprovalDiagnosticArtifact{
		SchemaVersion: articleApprovalDiagnosticSchema, RunID: run.ID, ContextID: run.ContextID, Diagnostics: diagnostics,
	}
	data, err := json.MarshalIndent(artifact, "", "  ")
	if err != nil {
		return nil, "", err
	}
	data = append(data, '\n')
	digest := sha256.Sum256(data)
	return data, strings.ToUpper(hex.EncodeToString(digest[:])), nil
}

func articleApprovalDiagnosticArtifactPath(runDir string) string {
	return filepath.Join(runDir, "r005-input", "article-approval-fallback-diagnostics.json")
}

func articleApprovalReadVerifiedPair(path string) ([]byte, string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, "", errors.New("immutable JSON publication is not a regular file")
	}
	sidecarPath := path + ".sha256"
	sidecarInfo, err := os.Lstat(sidecarPath)
	if err != nil {
		return nil, "", err
	}
	if !sidecarInfo.Mode().IsRegular() {
		return nil, "", errors.New("immutable SHA-256 sidecar is not a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	sidecar, err := os.ReadFile(sidecarPath)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(data)
	actual := strings.ToUpper(hex.EncodeToString(digest[:]))
	fields := strings.Fields(string(sidecar))
	if len(fields) != 2 || fields[1] != filepath.Base(path) || !articleApprovalSHA.MatchString(fields[0]) || strings.ToUpper(fields[0]) != actual {
		return nil, "", errors.New("immutable SHA-256 sidecar does not match JSON")
	}
	return data, actual, nil
}

func articleApprovalKnownRejectionCode(code string) bool {
	switch code {
	case articleApprovalRejectionPublicationRead, articleApprovalRejectionSidecarMissing,
		articleApprovalRejectionSidecarRead, articleApprovalRejectionSidecarInvalid,
		articleApprovalRejectionSHA256Mismatch, articleApprovalRejectionMalformedJSON,
		articleApprovalRejectionUnsafeMetadata, articleApprovalRejectionMetadataInvalid,
		articleApprovalRejectionVersionMismatch, articleApprovalRejectionScopeMismatch,
		articleApprovalRejectionSourceInvalid, articleApprovalRejectionDecisions,
		articleApprovalRejectionSourceBinding, articleApprovalRejectionValidation:
		return true
	default:
		return false
	}
}

func articleApprovalReadDiagnosticArtifact(runDir string, run Run, contextValue *Context) ([]articleApprovalDiagnostic, error) {
	diagnosticPath := articleApprovalDiagnosticArtifactPath(runDir)
	_, diagnosticErr := os.Lstat(diagnosticPath)
	_, sidecarErr := os.Lstat(diagnosticPath + ".sha256")
	if errors.Is(diagnosticErr, os.ErrNotExist) && errors.Is(sidecarErr, os.ErrNotExist) {
		return nil, nil
	}
	if diagnosticErr != nil || sidecarErr != nil || contextValue == nil {
		return nil, errors.New("article approval diagnostic identity is incomplete")
	}
	data, _, err := articleApprovalReadVerifiedPair(diagnosticPath)
	if err != nil {
		return nil, err
	}
	var artifact articleApprovalDiagnosticArtifact
	if err := decodeStrictJSON(data, &artifact); err != nil || artifact.SchemaVersion != articleApprovalDiagnosticSchema ||
		artifact.RunID != run.ID || artifact.ContextID != run.ContextID || len(artifact.Diagnostics) == 0 {
		return nil, errors.New("article approval diagnostic artifact metadata is invalid")
	}
	settingsPath := filepath.Join(runDir, "r005-input", "article-approval-settings.json")
	settingsData, settingsSHA, err := articleApprovalReadVerifiedPair(settingsPath)
	if err != nil {
		return nil, err
	}
	var settings articleApprovalDocument
	if err := decodeStrictJSON(settingsData, &settings); err != nil || validateArticleApprovalRawSafety(settingsData) != nil {
		return nil, errors.New("article approval settings artifact is invalid")
	}
	scope := articleApprovalScopeFromContext(*contextValue)
	if err := validateArticleApprovalDocument(settings, scope); err != nil {
		return nil, errors.New("article approval settings scope is invalid")
	}
	selectedApprovalID := articleApprovalDiagnosticApprovalID(settings)
	for _, diagnostic := range artifact.Diagnostics {
		if diagnostic.Code != articleApprovalFallbackDiagnosticCode || !articleApprovalKnownRejectionCode(diagnostic.RejectionCode) ||
			diagnostic.RejectedPublication == "" || filepath.Base(diagnostic.RejectedPublication) != diagnostic.RejectedPublication ||
			diagnostic.RejectedVersion < 1 || selectedApprovalID == "" || diagnostic.SelectedFallbackApprovalID != selectedApprovalID ||
			diagnostic.SelectedFallbackVersion != settings.Version || diagnostic.SelectedFallbackSHA256 != settingsSHA ||
			diagnostic.OrganizationID != scope.OrganizationID || diagnostic.OrganizationName != scope.OrganizationName ||
			diagnostic.OrganizationPath != scope.OrganizationPath || diagnostic.Period != scope.Period || !diagnostic.FallbackOccurred {
			return nil, errors.New("article approval diagnostic evidence does not match run settings")
		}
	}
	return artifact.Diagnostics, nil
}

func createArticleApprovalImmutableFile(path string, data []byte) error {
	if _, err := os.Lstat(path); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".article-approval-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tempName, 0o600); err != nil {
		return err
	}
	if err := os.Link(tempName, path); err != nil {
		return err
	}
	return nil
}

func createArticleApprovalImmutablePair(jsonPath string, data, sidecar []byte) error {
	sidecarPath := jsonPath + ".sha256"
	if _, err := os.Lstat(jsonPath); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	if _, err := os.Lstat(sidecarPath); err == nil {
		return os.ErrExist
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := createArticleApprovalImmutableFile(sidecarPath, sidecar); err != nil {
		return err
	}
	if err := createArticleApprovalImmutableFile(jsonPath, data); err != nil {
		if cleanupErr := os.Remove(sidecarPath); cleanupErr != nil && !os.IsNotExist(cleanupErr) {
			return errors.Join(err, fmt.Errorf("cleanup unpublished SHA sidecar: %w", cleanupErr))
		}
		return err
	}
	return nil
}

func (s *Server) createArticleApproval(request articleApprovalRequest) (map[string]any, int, error) {
	prepared, issues, err := s.prepareArticleApproval(request)
	if err != nil {
		status := http.StatusBadRequest
		if err.Error() == "ARTICLE_APPROVAL_ORGANIZATION_MISMATCH" {
			status = http.StatusConflict
		}
		return nil, status, err
	}
	if len(issues) > 0 {
		return map[string]any{"status": "FAIL", "errors": issues}, http.StatusBadRequest, errors.New("ARTICLE_APPROVAL_VALIDATION_FAILED")
	}
	actor, err := articleApprovalHostActor()
	if err != nil || !articleApprovalActor.MatchString(actor) {
		return nil, http.StatusInternalServerError, errors.New("ARTICLE_APPROVAL_HOST_ACTOR_UNAVAILABLE")
	}
	scope := prepared.Scope
	articleApprovalMu.Lock()
	defer articleApprovalMu.Unlock()
	entries, err := os.ReadDir(articleApprovalDirectory(s.store))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, http.StatusInternalServerError, err
	}
	slug := articleApprovalOrganizationSlug(scope)
	pattern := articleApprovalPublicationVersionPattern(slug)
	version := 1
	for _, entry := range entries {
		if match := pattern.FindStringSubmatch(entry.Name()); len(match) == 2 {
			if candidate, parseErr := strconv.Atoi(match[1]); parseErr == nil && candidate >= version {
				version = candidate + 1
			}
		}
	}
	approvalID, err := newOpaqueID("article_approval")
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	now := time.Now().UTC()
	document := articleApprovalDocument{
		SchemaVersion: articleApprovalSchema, Version: version, ApprovalID: approvalID,
		OrganizationScope: scope, Validity: articleApprovalValidity{From: scope.Period, To: scope.Period},
		Source: prepared.Source,
		Actor:  actor, FixedAt: now, Decisions: prepared.Rows,
		Safety: articleApprovalSafety{Mode: "REPORT_ONLY", DecisionType: "CLASSIFICATION_ONLY"},
	}
	data, digest, err := articleApprovalDocumentBytes(document)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	directory := articleApprovalDirectory(s.store)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	filePath := filepath.Join(directory, fmt.Sprintf("article_registry_%s_v%03d.approved.json", slug, version))
	if err := createArticleApprovalImmutablePair(filePath, data, []byte(digest+"  "+filepath.Base(filePath)+"\n")); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return map[string]any{"status": "PASS", "approved": map[string]any{
		"schema_version": articleApprovalSchema, "version": version, "approval_id": approvalID,
		"path": filePath, "sha256": digest, "organization_scope": scope, "period": scope.Period,
		"safety": reportOnlySafety(), "posting_rows": 0,
	}}, http.StatusCreated, nil
}

func articleApprovalQueueErrorStatus(err error) int {
	if err == nil {
		return http.StatusOK
	}
	switch err.Error() {
	case "ARTICLE_APPROVAL_RUN_NOT_FOUND":
		return http.StatusNotFound
	case "ARTICLE_APPROVAL_QUEUE_REVISION_STALE", "ARTICLE_APPROVAL_R005_ANCHOR_INVALID", "ARTICLE_APPROVAL_SOURCE_SHA256_MISMATCH", "ARTICLE_APPROVAL_SOURCE_SIZE_MISMATCH":
		return http.StatusConflict
	case "ARTICLE_APPROVAL_HOST_ACTOR_UNAVAILABLE":
		return http.StatusInternalServerError
	default:
		return http.StatusBadRequest
	}
}

func (s *Server) publishArticleApprovalPreparedLocked(prepared articleApprovalPrepared, actor string) (map[string]any, int, error) {
	entries, err := os.ReadDir(articleApprovalDirectory(s.store))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, http.StatusInternalServerError, err
	}
	scope := prepared.Scope
	slug := articleApprovalOrganizationSlug(scope)
	pattern := articleApprovalPublicationVersionPattern(slug)
	version := 1
	for _, entry := range entries {
		if match := pattern.FindStringSubmatch(entry.Name()); len(match) == 2 {
			if candidate, parseErr := strconv.Atoi(match[1]); parseErr == nil && candidate >= version {
				version = candidate + 1
			}
		}
	}
	approvalID, err := newOpaqueID("article_approval")
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	document := articleApprovalDocument{
		SchemaVersion: articleApprovalSchema, Version: version, ApprovalID: approvalID,
		OrganizationScope: scope, Validity: articleApprovalValidity{From: scope.Period, To: scope.Period},
		Source: prepared.Source, Actor: actor, FixedAt: time.Now().UTC(), Decisions: prepared.Rows,
		Safety: articleApprovalSafety{Mode: "REPORT_ONLY", DecisionType: "CLASSIFICATION_ONLY"},
	}
	data, digest, err := articleApprovalDocumentBytes(document)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	directory := articleApprovalDirectory(s.store)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	fileName := fmt.Sprintf("article_registry_%s_v%03d.approved.json", slug, version)
	filePath := filepath.Join(directory, fileName)
	if err := createArticleApprovalImmutablePair(filePath, data, []byte(digest+"  "+fileName+"\n")); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return map[string]any{"status": "PASS", "approved": map[string]any{
		"schema_version": articleApprovalSchema, "version": version, "approval_id": approvalID,
		"file_name": fileName, "integrity_file_name": fileName + ".sha256", "organization_scope": scope,
		"period": scope.Period, "safety": reportOnlySafety(), "posting_rows": 0,
	}}, http.StatusCreated, nil
}

func (s *Server) createArticleApprovalFromQueue(request articleApprovalQueueRequest) (map[string]any, int, error) {
	articleApprovalMu.Lock()
	defer articleApprovalMu.Unlock()
	queue, err := s.prepareArticleApprovalQueue(request.RunID)
	if err != nil {
		return nil, articleApprovalQueueErrorStatus(err), err
	}
	prepared, issues, err := articleApprovalApplyQueueRequest(queue, request)
	if err != nil {
		return nil, articleApprovalQueueErrorStatus(err), err
	}
	if len(issues) > 0 {
		return map[string]any{"status": "FAIL", "errors": issues}, http.StatusBadRequest, errors.New("ARTICLE_APPROVAL_VALIDATION_FAILED")
	}
	return s.publishArticleApprovalPreparedLocked(prepared, queue.Actor)
}

func (s *Server) handleArticleApprovals(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		query := r.URL.Query()
		if runIDs, queueMode := query["run_id"]; queueMode {
			if len(query) != 1 || len(runIDs) != 1 {
				writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_RUN_ID_INVALID"})
				return
			}
			runID := runIDs[0]
			queue, err := s.prepareArticleApprovalQueue(runID)
			if err != nil {
				writeJSON(w, articleApprovalQueueErrorStatus(err), apiError{Error: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, queue)
			return
		}
		request := articleApprovalRequest{OrganizationID: r.URL.Query().Get("organization_id"), OrganizationName: r.URL.Query().Get("organization_name"), OrganizationPath: r.URL.Query().Get("organization_path"), Period: r.URL.Query().Get("period")}
		scope, scopeErr := articleApprovalResolveScope(s.store, request)
		if scopeErr != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_SCOPE_INVALID"})
			return
		}
		selection, err := articleApprovalLatestSelection(s.store, scope)
		if err != nil {
			writeJSON(w, http.StatusConflict, apiError{Error: "ARTICLE_APPROVAL_VERSION_REJECTED"})
			return
		}
		if selection.Path == "" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "NONE", "organization_scope": scope, "safety": reportOnlySafety()})
			return
		}
		payload := map[string]any{
			"status": "PASS", "file_name": filepath.Base(selection.Path), "document": selection.Document,
			"safety": reportOnlySafety(),
		}
		if len(selection.Diagnostics) > 0 {
			payload["diagnostics"] = selection.Diagnostics
		}
		writeJSON(w, http.StatusOK, payload)
	case http.MethodPost:
		var request articleApprovalQueueRequest
		if err := readJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
			return
		}
		payload, status, err := s.createArticleApprovalFromQueue(request)
		if err != nil {
			if payload != nil {
				writeJSON(w, status, payload)
			} else {
				writeJSON(w, status, apiError{Error: err.Error()})
			}
			return
		}
		writeJSON(w, status, payload)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
	}
}

func (s *Server) handleArticleApprovalValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request articleApprovalQueueRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
		return
	}
	queue, err := s.prepareArticleApprovalQueue(request.RunID)
	if err != nil {
		writeJSON(w, articleApprovalQueueErrorStatus(err), map[string]any{"status": "FAIL", "errors": []articleApprovalIssue{{Code: err.Error(), Message: "Серверная очередь текущего R005 не прошла проверку"}}})
		return
	}
	_, issues, err := articleApprovalApplyQueueRequest(queue, request)
	if err != nil {
		writeJSON(w, articleApprovalQueueErrorStatus(err), map[string]any{"status": "FAIL", "errors": []articleApprovalIssue{{Code: err.Error(), Message: "Полный набор решений не соответствует серверной очереди"}}})
		return
	}
	if len(issues) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"status": "FAIL", "errors": issues})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "PASS", "errors": []articleApprovalIssue{}, "safety": reportOnlySafety()})
}

func (s *Server) handleArticleApprovalFix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	var request articleApprovalQueueRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
		return
	}
	payload, status, err := s.createArticleApprovalFromQueue(request)
	if err != nil {
		if payload != nil {
			writeJSON(w, status, payload)
		} else {
			writeJSON(w, status, apiError{Error: err.Error()})
		}
		return
	}
	writeJSON(w, status, payload)
}

func appendArticleApprovalSettingsArgument(command []string, settingsPath string) []string {
	if settingsPath == "" {
		return command
	}
	result := append([]string{}, command...)
	result = append(result, "--article-approval-settings", settingsPath)
	return result
}

func hasArticleApprovalSettingsArgument(command []string) bool {
	for _, value := range command {
		if value == "--article-approval-settings" {
			return true
		}
	}
	return false
}

func (p *Pipeline) materializeActiveArticleApprovalSettings(run Run, contextValue Context, runDir string) (string, error) {
	if err := validateStructuralControlPipelineScope(run, contextValue); err != nil {
		return "", err
	}
	base, err := secureBaseName(run.ID)
	if err != nil || base != run.ID {
		return "", errors.New("article approval run identity is unsafe")
	}
	expectedRunDir := filepath.Join(p.store.RunsDir(), run.ID)
	absoluteRunDir, err := filepath.Abs(runDir)
	if err != nil || !sameFilesystemPath(expectedRunDir, absoluteRunDir) {
		return "", errors.New("article approval settings escaped exact run root")
	}
	scope := articleApprovalScopeFromContext(contextValue)
	selection, err := articleApprovalLatestSelection(p.store, scope)
	if err != nil {
		return "", err
	}
	document := selection.Document
	if document.Version == 0 {
		return "", nil
	}
	if err := validateArticleApprovalDocument(document, scope); err != nil {
		return "", err
	}
	data, err := articleApprovalVerifiedPublicationBytes(p.store, selection, scope)
	if err != nil {
		return "", err
	}
	digest := selection.SHA256
	if digest == "" {
		return "", errors.New("article approval settings digest is empty")
	}
	destination := filepath.Join(expectedRunDir, "r005-input", "article-approval-settings.json")
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", err
	}
	if err := createArticleApprovalImmutablePair(destination, data, []byte(digest+"  "+filepath.Base(destination)+"\n")); err != nil {
		return "", err
	}
	if len(selection.Diagnostics) > 0 {
		diagnosticData, diagnosticSHA, err := articleApprovalDiagnosticArtifactBytes(run, selection.Diagnostics)
		if err == nil {
			diagnosticPath := articleApprovalDiagnosticArtifactPath(expectedRunDir)
			err = createArticleApprovalImmutablePair(diagnosticPath, diagnosticData, []byte(diagnosticSHA+"  "+filepath.Base(diagnosticPath)+"\n"))
		}
		if err != nil {
			cleanupErrors := []error{}
			for _, path := range []string{destination, destination + ".sha256"} {
				if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
					cleanupErrors = append(cleanupErrors, removeErr)
				}
			}
			if cleanupErr := errors.Join(cleanupErrors...); cleanupErr != nil {
				return "", errors.Join(err, fmt.Errorf("cleanup unpublished article approval settings: %w", cleanupErr))
			}
			return "", err
		}
	}
	return destination, nil
}
