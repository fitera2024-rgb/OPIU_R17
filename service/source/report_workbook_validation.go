package main

import (
	"archive/zip"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

const materializationSheetName = "10_R001_Материализация"

type xlsxSheetRef struct {
	Name string `xml:"name,attr"`
	RID  string `xml:"id,attr"`
}

type xlsxWorkbook struct {
	Sheets []xlsxSheetRef `xml:"sheets>sheet"`
}

type xlsxRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type xlsxRelationships struct {
	Items []xlsxRelationship `xml:"Relationship"`
}

type xlsxCell struct {
	Reference string `xml:"r,attr"`
	Type      string `xml:"t,attr"`
	Value     string `xml:"v"`
	Inline    struct {
		Text string `xml:"t"`
	} `xml:"is"`
}

type xlsxRow struct {
	Number int        `xml:"r,attr"`
	Cells  []xlsxCell `xml:"c"`
}

type xlsxWorksheet struct {
	Rows []xlsxRow `xml:"sheetData>row"`
}

type xlsxArchive struct {
	reader *zip.ReadCloser
	files  map[string]*zip.File
}

func openXLSXArchive(filePath string) (*xlsxArchive, error) {
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, fmt.Errorf("registered workbook is not OOXML: %w", err)
	}
	files := map[string]*zip.File{}
	for _, file := range reader.File {
		name := path.Clean(strings.ReplaceAll(file.Name, "\\", "/"))
		if name == "." || strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") {
			reader.Close()
			return nil, errors.New("OOXML member path is unsafe")
		}
		if _, exists := files[name]; exists {
			reader.Close()
			return nil, fmt.Errorf("duplicate OOXML member: %s", name)
		}
		files[name] = file
	}
	for _, required := range []string{"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"} {
		if files[required] == nil {
			reader.Close()
			return nil, fmt.Errorf("OOXML workbook member is missing: %s", required)
		}
	}
	return &xlsxArchive{reader: reader, files: files}, nil
}

func (archive *xlsxArchive) close() error { return archive.reader.Close() }

func (archive *xlsxArchive) decode(name string, value any) error {
	file := archive.files[name]
	if file == nil {
		return fmt.Errorf("OOXML member is missing: %s", name)
	}
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(io.LimitReader(reader, 32<<20))
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("decode OOXML member %s: %w", name, err)
	}
	return nil
}

func validateOOXMLWorkbook(filePath string) error {
	archive, err := openXLSXArchive(filePath)
	if err != nil {
		return err
	}
	return archive.close()
}

func validateExactXLSXSheet(filePath, expectedSheet string) error {
	expectedSheet = strings.TrimSpace(expectedSheet)
	if expectedSheet == "" {
		return errors.New("expected worksheet name is missing")
	}
	archive, err := openXLSXArchive(filePath)
	if err != nil {
		return err
	}
	defer archive.close()
	var workbook xlsxWorkbook
	if err := archive.decode("xl/workbook.xml", &workbook); err != nil {
		return err
	}
	var relationships xlsxRelationships
	if err := archive.decode("xl/_rels/workbook.xml.rels", &relationships); err != nil {
		return err
	}
	relationshipTargets := map[string]string{}
	for _, relation := range relationships.Items {
		target := path.Clean(path.Join("xl", strings.TrimPrefix(strings.ReplaceAll(relation.Target, "\\", "/"), "/xl/")))
		if target == "xl" || strings.HasPrefix(target, "../") || !strings.HasPrefix(target, "xl/") {
			return errors.New("OOXML worksheet relationship escaped xl root")
		}
		relationshipTargets[relation.ID] = target
	}
	matchingSheets := 0
	sheetPath := ""
	for _, sheet := range workbook.Sheets {
		if sheet.Name != expectedSheet {
			continue
		}
		matchingSheets++
		sheetPath = relationshipTargets[sheet.RID]
	}
	if matchingSheets != 1 {
		return fmt.Errorf("expected exactly one worksheet %q, found %d", expectedSheet, matchingSheets)
	}
	if sheetPath == "" || archive.files[sheetPath] == nil {
		return fmt.Errorf("worksheet %q relationship target is missing", expectedSheet)
	}
	return nil
}

func xlsxColumnIndex(reference string) (int, error) {
	letters := ""
	for _, symbol := range strings.ToUpper(strings.TrimSpace(reference)) {
		if symbol < 'A' || symbol > 'Z' {
			break
		}
		letters += string(symbol)
	}
	if letters == "" {
		return 0, errors.New("OOXML cell reference is missing")
	}
	index := 0
	for _, symbol := range letters {
		index = index*26 + int(symbol-'A'+1)
	}
	return index - 1, nil
}

func readSharedStrings(archive *xlsxArchive) ([]string, error) {
	file := archive.files["xl/sharedStrings.xml"]
	if file == nil {
		return nil, nil
	}
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	decoder := xml.NewDecoder(io.LimitReader(reader, 32<<20))
	values := []string{}
	current := strings.Builder{}
	inItem := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch item := token.(type) {
		case xml.StartElement:
			if item.Name.Local == "si" {
				inItem = true
				current.Reset()
			}
			if inItem && item.Name.Local == "t" {
				var text string
				if err := decoder.DecodeElement(&text, &item); err != nil {
					return nil, err
				}
				current.WriteString(text)
			}
		case xml.EndElement:
			if item.Name.Local == "si" && inItem {
				values = append(values, current.String())
				inItem = false
			}
		}
	}
	return values, nil
}

func xlsxCellText(cell xlsxCell, shared []string) (string, error) {
	switch cell.Type {
	case "inlineStr":
		return cell.Inline.Text, nil
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(cell.Value))
		if err != nil || index < 0 || index >= len(shared) {
			return "", errors.New("OOXML shared string index is invalid")
		}
		return shared[index], nil
	case "b":
		if strings.TrimSpace(cell.Value) == "1" {
			return "TRUE", nil
		}
		return "FALSE", nil
	default:
		return cell.Value, nil
	}
}

func readMaterializationTable(filePath string) ([]map[string]string, error) {
	archive, err := openXLSXArchive(filePath)
	if err != nil {
		return nil, err
	}
	defer archive.close()
	var workbook xlsxWorkbook
	if err := archive.decode("xl/workbook.xml", &workbook); err != nil {
		return nil, err
	}
	var relationships xlsxRelationships
	if err := archive.decode("xl/_rels/workbook.xml.rels", &relationships); err != nil {
		return nil, err
	}
	relationshipTargets := map[string]string{}
	for _, relation := range relationships.Items {
		target := path.Clean(path.Join("xl", strings.TrimPrefix(strings.ReplaceAll(relation.Target, "\\", "/"), "/xl/")))
		if target == "xl" || strings.HasPrefix(target, "../") || !strings.HasPrefix(target, "xl/") {
			return nil, errors.New("OOXML worksheet relationship escaped xl root")
		}
		relationshipTargets[relation.ID] = target
	}
	sheetPath := ""
	for _, sheet := range workbook.Sheets {
		if sheet.Name == materializationSheetName {
			sheetPath = relationshipTargets[sheet.RID]
			break
		}
	}
	if sheetPath == "" || archive.files[sheetPath] == nil {
		return nil, fmt.Errorf("required worksheet %s is missing", materializationSheetName)
	}
	shared, err := readSharedStrings(archive)
	if err != nil {
		return nil, err
	}
	var worksheet xlsxWorksheet
	if err := archive.decode(sheetPath, &worksheet); err != nil {
		return nil, err
	}
	rows := map[int]map[int]string{}
	for _, row := range worksheet.Rows {
		values := map[int]string{}
		for _, cell := range row.Cells {
			index, err := xlsxColumnIndex(cell.Reference)
			if err != nil {
				return nil, err
			}
			value, err := xlsxCellText(cell, shared)
			if err != nil {
				return nil, err
			}
			values[index] = strings.TrimSpace(value)
		}
		rows[row.Number] = values
	}
	headers := rows[4]
	if len(headers) == 0 {
		return nil, errors.New("materialization worksheet header is missing")
	}
	result := []map[string]string{}
	for rowNumber := 5; ; rowNumber++ {
		values, exists := rows[rowNumber]
		if !exists {
			if rowNumber > len(rows)+4 {
				break
			}
			continue
		}
		record := map[string]string{}
		nonEmpty := false
		for column, header := range headers {
			if header == "" {
				continue
			}
			record[header] = values[column]
			nonEmpty = nonEmpty || values[column] != ""
		}
		if nonEmpty {
			result = append(result, record)
		}
	}
	return result, nil
}

func workbookBoolean(value string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	return normalized == "TRUE" || normalized == "1" || normalized == "ИСТИНА"
}

func executableCorrectionAuthority(value string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	return normalized == "TRUE" || normalized == "1" || normalized == "ИСТИНА" || normalized == "EXACT_SOURCE" || normalized == "ECONOMIC_CORRECTION_PROVEN"
}

func physicalPlaceholder(value string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	return normalized == "UNKNOWN" || normalized == "НЕИЗВЕСТНО" || normalized == "НЕ ОПРЕДЕЛЕНО" || normalized == "НЕ ОПРЕДЕЛЕНА"
}

func validateMaterializationRouting(rows []map[string]string, expectedTotal, expectedReady, expectedSporno int) error {
	if len(rows) != expectedTotal {
		return fmt.Errorf("materialization row count=%d, expected=%d", len(rows), expectedTotal)
	}
	ready, sporno := 0, 0
	for index, row := range rows {
		route := strings.ToUpper(row["Output route"])
		operation := strings.ToUpper(row["Операция"])
		if operation != "STORNO" && operation != "REPOST" {
			return fmt.Errorf("materialization row %d has no exact STORNO/REPOST direction", index+5)
		}
		var loader []any
		if err := json.Unmarshal([]byte(row["A:AA JSON"]), &loader); err != nil || len(loader) != 27 {
			return fmt.Errorf("materialization row %d has invalid exact A:AA payload", index+5)
		}
		auditSourceRowID := strings.TrimSpace(row["SourceRowID"])
		loaderSourceRowID := ""
		if loader[18] != nil {
			loaderSourceRowID = strings.TrimSpace(fmt.Sprint(loader[18]))
		}
		switch route {
		case "READY":
			ready++
			if strings.ToUpper(row["Proof status"]) != "PROVEN" || !workbookBoolean(row["Correction allowed"]) || !executableCorrectionAuthority(row["Correction authority"]) {
				return fmt.Errorf("READY materialization row %d lacks proven correction authority", index+5)
			}
			for _, field := range []string{"Организация источника ERP", "SourceRowID", "ERP архив", "SHA256 ERP архива", "ERP файл в архиве", "SHA256 ERP файла", "Лист", "ERP строка", "Дата источника", "Регистратор/документ", "№ проводки"} {
				if strings.TrimSpace(row[field]) == "" || physicalPlaceholder(row[field]) {
					return fmt.Errorf("READY materialization row %d lacks exact physical field %s", index+5, field)
				}
			}
			if !validSHA256(row["SHA256 ERP архива"]) || !validSHA256(row["SHA256 ERP файла"]) {
				return fmt.Errorf("READY materialization row %d has invalid physical source hash", index+5)
			}
			if strings.TrimSpace(fmt.Sprint(loader[16])) == "" || strings.TrimSpace(fmt.Sprint(loader[17])) == "" || strings.TrimSpace(fmt.Sprint(loader[18])) == "" {
				return fmt.Errorf("READY materialization row %d lacks source accounts or SourceRowID in A:AA", index+5)
			}
			if auditSourceRowID != loaderSourceRowID {
				return fmt.Errorf("READY materialization row %d contradicts SourceRowID between audit and A:AA", index+5)
			}
		case "SPORNO":
			sporno++
			if workbookBoolean(row["Correction allowed"]) {
				return fmt.Errorf("SPORNO materialization row %d has correction_allowed=true", index+5)
			}
			if executableCorrectionAuthority(row["Correction authority"]) {
				return fmt.Errorf("SPORNO materialization row %d claims executable correction authority", index+5)
			}
			for _, field := range []string{"Организация источника ERP", "SourceRowID", "ERP архив", "ERP файл в архиве", "Лист", "ERP строка", "Дата источника", "Регистратор/документ", "№ проводки"} {
				if physicalPlaceholder(row[field]) {
					return fmt.Errorf("SPORNO materialization row %d invented placeholder in %s; unknown must stay blank", index+5, field)
				}
			}
			if auditSourceRowID != loaderSourceRowID {
				return fmt.Errorf("SPORNO materialization row %d contradicts SourceRowID between audit and A:AA", index+5)
			}
			for _, field := range []string{"SHA256 ERP архива", "SHA256 ERP файла"} {
				if value := strings.TrimSpace(row[field]); value != "" && !validSHA256(value) {
					return fmt.Errorf("SPORNO materialization row %d has fabricated %s", index+5, field)
				}
			}
		default:
			return fmt.Errorf("materialization row %d has unsupported route %s", index+5, route)
		}
	}
	if ready != expectedReady || sporno != expectedSporno {
		return fmt.Errorf("materialization routes READY=%d SPORNO=%d, expected %d/%d", ready, sporno, expectedReady, expectedSporno)
	}
	return nil
}
