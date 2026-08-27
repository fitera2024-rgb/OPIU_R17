package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const articleApprovalSchema = "opiu-article-approval.v1"

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
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
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

func articleApprovalZIPRead(archive *zip.ReadCloser, name string) ([]byte, error) {
	name = filepath.ToSlash(filepath.Clean(name))
	name = strings.TrimPrefix(name, "/")
	for _, item := range archive.File {
		if filepath.ToSlash(item.Name) != name {
			continue
		}
		reader, err := item.Open()
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

func articleApprovalXLSXStrings(archive *zip.ReadCloser) ([]string, error) {
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
	archive, err := zip.OpenReader(path)
	if err != nil {
		return nil, fmt.Errorf("source is not a readable XLSX: %w", err)
	}
	defer archive.Close()
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
	relationshipByID := map[string]string{}
	for _, item := range relationships.Items {
		relationshipByID[item.ID] = item.Target
	}
	target := ""
	for _, sheet := range workbook.Sheets {
		if sheet.Name == sheetName {
			target = relationshipByID[sheet.ID]
			break
		}
	}
	if target == "" {
		return nil, fmt.Errorf("required XLSX sheet %q is missing", sheetName)
	}
	if !strings.HasPrefix(filepath.ToSlash(target), "xl/") {
		target = filepath.ToSlash(filepath.Join("xl", target))
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
	erpRows, err := articleApprovalXLSXRows(path, "04_ERP_статьи")
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
	authoritativeTargets := map[string]struct{}{}
	for _, row := range erpRows[erpHeaderIndex+1:] {
		if !strings.HasPrefix(strings.ToUpper(cleanBusinessText(row[erpHeaders["Статус справочника"]], 100)), "MATCHED") {
			continue
		}
		article := cleanBusinessText(row[erpHeaders["Статья ERP"]], 300)
		codes := strings.FieldsFunc(row[erpHeaders["Код статьи"]], func(character rune) bool {
			return character == ',' || character == ';' || character == '\n' || character == '\r'
		})
		for _, code := range codes {
			code = cleanBusinessText(code, 200)
			if code != "" && article != "" {
				authoritativeTargets[strings.ToLower(code+"|"+article)] = struct{}{}
			}
		}
	}
	if len(authoritativeTargets) == 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_ERP_CATALOG_EMPTY")
	}
	rows, err := articleApprovalXLSXRows(path, "01_Правила")
	if err != nil {
		return nil, fmt.Errorf("ARTICLE_APPROVAL_SOURCE_RULES_INVALID: %w", err)
	}
	headers := map[string]int{}
	headerIndex := -1
	for index, row := range rows {
		for column, value := range row {
			headers[value] = column
		}
		if headers["ПредлагаемыйБлокERP"] > 0 && headers["ПредлагаемаяСтатьяERP"] > 0 && headers["КодСтатьиERP"] > 0 {
			headerIndex = index
			break
		}
		headers = map[string]int{}
	}
	if headerIndex < 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_RULES_HEADERS_INVALID")
	}
	result := []articleApprovalCatalogItem{}
	seen := map[string]struct{}{}
	for _, row := range rows[headerIndex+1:] {
		item := articleApprovalCatalogItem{
			Code:    cleanBusinessText(row[headers["КодСтатьиERP"]], 200),
			Block:   cleanBusinessText(row[headers["ПредлагаемыйБлокERP"]], 300),
			Article: cleanBusinessText(row[headers["ПредлагаемаяСтатьяERP"]], 300),
		}
		if item.Code == "" || item.Block == "" || item.Article == "" {
			continue
		}
		if _, exists := authoritativeTargets[strings.ToLower(item.Code+"|"+item.Article)]; !exists {
			continue
		}
		key := strings.ToLower(item.Code + "|" + item.Block + "|" + item.Article)
		if _, exists := seen[key]; !exists {
			seen[key] = struct{}{}
			result = append(result, item)
		}
	}
	if len(result) == 0 {
		return nil, errors.New("ARTICLE_APPROVAL_SOURCE_ERP_CATALOG_EMPTY")
	}
	return result, nil
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
		if code != "" {
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

func articleApprovalReadFile(path string) (articleApprovalDocument, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return articleApprovalDocument{}, "", err
	}
	sidecar, err := os.ReadFile(path + ".sha256")
	if err != nil {
		return articleApprovalDocument{}, "", fmt.Errorf("approved SHA-256 sidecar is missing: %w", err)
	}
	actual := sha256.Sum256(data)
	actualSHA := strings.ToUpper(hex.EncodeToString(actual[:]))
	fields := strings.Fields(string(sidecar))
	if len(fields) != 2 || fields[1] != filepath.Base(path) {
		return articleApprovalDocument{}, "", errors.New("approved SHA-256 sidecar metadata is invalid")
	}
	declared := strings.ToUpper(fields[0])
	if !articleApprovalSHA.MatchString(declared) || declared != actualSHA {
		return articleApprovalDocument{}, "", errors.New("approved SHA-256 does not match JSON")
	}
	var document articleApprovalDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		return articleApprovalDocument{}, "", err
	}
	if err := validateArticleApprovalRawSafety(data); err != nil {
		return articleApprovalDocument{}, "", err
	}
	return document, actualSHA, nil
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
		return errors.New("approved document metadata is invalid")
	}
	if !articleApprovalScopeEqual(document.OrganizationScope, scope) || document.Validity.From != scope.Period || document.Validity.To != scope.Period {
		return errors.New("approved document organization or period scope mismatch")
	}
	if !articleApprovalMonth.MatchString(document.Validity.From) || document.Source.XLSX == "" || !articleApprovalSHA.MatchString(document.Source.SHA256) {
		return errors.New("approved document source or period is invalid")
	}
	if document.Safety.Mode != "REPORT_ONLY" || document.Safety.DecisionType != "CLASSIFICATION_ONLY" || document.Safety.FinancialRows != 0 || document.Safety.PostingRows != 0 || document.Safety.ReadyToUpload || document.Safety.ReleaseAllowed || document.Safety.Live1CAllowed {
		return errors.New("approved document opens financial authority")
	}
	issues := articleApprovalValidateRows(document.Decisions, scope, nil, false)
	if len(issues) > 0 {
		return fmt.Errorf("approved document contains invalid decisions: %s", issues[0].Code)
	}
	return nil
}

func validateArticleApprovalStoredSource(store *Store, source articleApprovalSource) error {
	resolved, _, err := articleApprovalResolveSource(store, source.XLSX, source.SHA256)
	if err != nil {
		return err
	}
	if resolved.XLSX != source.XLSX || resolved.SHA256 != source.SHA256 {
		return errors.New("approved document source binding is not canonical")
	}
	return nil
}

func articleApprovalLatest(store *Store, scope articleApprovalScope) (articleApprovalDocument, string, error) {
	slug := articleApprovalOrganizationSlug(scope)
	entries, err := os.ReadDir(articleApprovalDirectory(store))
	if errors.Is(err, os.ErrNotExist) {
		return articleApprovalDocument{}, "", nil
	}
	if err != nil {
		return articleApprovalDocument{}, "", err
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
	for _, item := range candidates {
		document, _, readErr := articleApprovalReadFile(item.path)
		if readErr != nil {
			if firstError == nil {
				firstError = readErr
			}
			continue
		}
		if validateErr := validateArticleApprovalDocument(document, scope); validateErr != nil {
			if firstError == nil {
				firstError = validateErr
			}
			continue
		}
		if validateErr := validateArticleApprovalStoredSource(store, document.Source); validateErr != nil {
			if firstError == nil {
				firstError = validateErr
			}
			continue
		}
		return document, item.path, nil
	}
	if firstError != nil {
		return articleApprovalDocument{}, "", firstError
	}
	return articleApprovalDocument{}, "", nil
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
	pattern := articleApprovalVersionPattern(slug)
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

func (s *Server) handleArticleApprovals(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		request := articleApprovalRequest{OrganizationID: r.URL.Query().Get("organization_id"), OrganizationName: r.URL.Query().Get("organization_name"), OrganizationPath: r.URL.Query().Get("organization_path"), Period: r.URL.Query().Get("period")}
		scope, scopeErr := articleApprovalResolveScope(s.store, request)
		if scopeErr != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_SCOPE_INVALID"})
			return
		}
		document, filePath, err := articleApprovalLatest(s.store, scope)
		if err != nil {
			writeJSON(w, http.StatusConflict, apiError{Error: "ARTICLE_APPROVAL_VERSION_REJECTED"})
			return
		}
		if filePath == "" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "NONE", "organization_scope": scope, "safety": reportOnlySafety()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "PASS", "path": filePath, "document": document, "safety": reportOnlySafety()})
	case http.MethodPost:
		var request articleApprovalRequest
		if err := readJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
			return
		}
		payload, status, err := s.createArticleApproval(request)
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
	var request articleApprovalRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
		return
	}
	_, issues, err := s.prepareArticleApproval(request)
	if err != nil {
		issues = append(issues, articleApprovalIssue{Code: err.Error(), Message: "Серверная проверка scope, XLSX или каталога не пройдена"})
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
	var request articleApprovalRequest
	if err := readJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "ARTICLE_APPROVAL_REQUEST_INVALID"})
		return
	}
	payload, status, err := s.createArticleApproval(request)
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
	document, _, err := articleApprovalLatest(p.store, scope)
	if err != nil {
		return "", err
	}
	if document.Version == 0 {
		return "", nil
	}
	if err := validateArticleApprovalDocument(document, scope); err != nil {
		return "", err
	}
	data, digest, err := articleApprovalDocumentBytes(document)
	if err != nil {
		return "", err
	}
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
	return destination, nil
}
