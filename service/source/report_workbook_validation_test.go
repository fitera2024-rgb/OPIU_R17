package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestR005027ServiceValidatorAcceptsExactGroupScopedHandoffAuthorityOnly(t *testing.T) {
	readyRow := func(authority string) map[string]string {
		loader := make([]any, 27)
		loader[16], loader[17], loader[18] = "26", "76.5", "ERP-ROW-R005-027"
		loaderJSON, err := json.Marshal(loader)
		if err != nil {
			t.Fatal(err)
		}
		return map[string]string{
			"Output route": "READY", "Операция": "STORNO", "Proof status": "PROVEN",
			"Correction allowed": "TRUE", "Correction authority": authority,
			"Организация источника ERP": "ПВ", "SourceRowID": "ERP-ROW-R005-027",
			"ERP архив": "source.zip", "SHA256 ERP архива": "B2F97D3A7F320EE3BE3A62D0423D4BFB7A215ED92D7ED6A1A771FC04EBCF89D1",
			"ERP файл в архиве": "journal.xlsx", "SHA256 ERP файла": "776D566495175191D1B394C2545FE10B11173C755A51879FD18726A91A40A504",
			"Лист": "Лист_1", "ERP строка": "B1617:AG1617", "Дата источника": "2025-01-31",
			"Регистратор/документ": "Трансляция 0000001782", "№ проводки": "8", "A:AA JSON": string(loaderJSON),
		}
	}

	exact := "SERVICE_HANDOFF_GROUP_SCOPED_PHYSICAL_AUTHORITY"
	if err := validateMaterializationRouting([]map[string]string{readyRow(exact)}, 1, 1, 0); err != nil {
		t.Fatalf("exact verified Service handoff authority was rejected: %v", err)
	}
	actualGroupScopedProof := readyRow(exact)
	actualGroupScopedProof["Proof status"] = "GROUP_SCOPED_ARTICLE_REPLACEMENT_PROVEN"
	if err := validateMaterializationRouting([]map[string]string{actualGroupScopedProof}, 1, 1, 0); err == nil {
		t.Fatal("group-scoped target proof was accepted as standalone READY proof")
	}
	for _, authority := range []string{
		exact + "_FORGED",
		"GROUP_SCOPED_ARTICLE_REPLACEMENT",
		"UNKNOWN_SERVICE_AUTHORITY",
	} {
		if err := validateMaterializationRouting([]map[string]string{readyRow(authority)}, 1, 1, 0); err == nil {
			t.Fatalf("non-exact Service handoff authority %q was accepted", authority)
		}
	}

	sporno := readyRow(exact)
	sporno["Output route"] = "SPORNO"
	sporno["Correction allowed"] = "FALSE"
	if err := validateMaterializationRouting([]map[string]string{sporno}, 1, 0, 1); err == nil {
		t.Fatal("SPORNO row carrying executable Service handoff authority was accepted")
	}

	missingPhysical := readyRow(exact)
	missingPhysical["Лист"] = ""
	if err := validateMaterializationRouting([]map[string]string{missingPhysical}, 1, 1, 0); err == nil {
		t.Fatal("Service handoff authority bypassed a missing physical field")
	}
	badSHA := readyRow(exact)
	badSHA["SHA256 ERP файла"] = "NOT-A-SHA256"
	if err := validateMaterializationRouting([]map[string]string{badSHA}, 1, 1, 0); err == nil {
		t.Fatal("Service handoff authority bypassed an invalid physical source hash")
	}
	contradictorySourceRowID := readyRow(exact)
	var contradictoryLoader []any
	if err := json.Unmarshal([]byte(contradictorySourceRowID["A:AA JSON"]), &contradictoryLoader); err != nil {
		t.Fatal(err)
	}
	contradictoryLoader[18] = "ERP-ROW-CONTRADICTS-AUDIT"
	contradictoryJSON, err := json.Marshal(contradictoryLoader)
	if err != nil {
		t.Fatal(err)
	}
	contradictorySourceRowID["A:AA JSON"] = string(contradictoryJSON)
	if err := validateMaterializationRouting([]map[string]string{contradictorySourceRowID}, 1, 1, 0); err == nil {
		t.Fatal("Service handoff authority bypassed SourceRowID contradiction")
	}
}

func TestValidateExactXLSXSheetUsesOOXMLPartSemantics(t *testing.T) {
	const (
		validRelationshipType = xlsxWorksheetRelationshipType
		validTarget           = "worksheets/sheet1.xml"
		validPart             = "xl/worksheets/sheet1.xml"
		validContentType      = xlsxWorksheetContentType
		worksheetXML          = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
	)
	tests := []struct {
		name          string
		expectedSheet string
		sheetName     string
		relationship  string
		target        string
		targetMode    string
		part          string
		contentType   string
		partXML       string
		wantErr       bool
	}{
		{
			name: "valid worksheet relationship and part", expectedSheet: "Journal", sheetName: "Journal",
			relationship: validRelationshipType, target: validTarget, part: validPart,
			contentType: validContentType, partXML: worksheetXML,
		},
		{
			name: "wrong worksheet name", expectedSheet: "Journal", sheetName: "Other",
			relationship: validRelationshipType, target: validTarget, part: validPart,
			contentType: validContentType, partXML: worksheetXML, wantErr: true,
		},
		{
			name: "non-worksheet relationship type", expectedSheet: "Journal", sheetName: "Journal",
			relationship: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
			target:       validTarget, part: validPart, contentType: validContentType, partXML: worksheetXML, wantErr: true,
		},
		{
			name: "non-worksheet XML part", expectedSheet: "Journal", sheetName: "Journal",
			relationship: validRelationshipType, target: "sharedStrings.xml", part: "xl/sharedStrings.xml",
			contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
			partXML:     `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`, wantErr: true,
		},
		{
			name: "external relationship", expectedSheet: "Journal", sheetName: "Journal",
			relationship: validRelationshipType, target: "https://example.invalid/sheet1.xml", targetMode: "External",
			part: validPart, contentType: validContentType, partXML: worksheetXML, wantErr: true,
		},
		{
			name: "path traversal target", expectedSheet: "Journal", sheetName: "Journal",
			relationship: validRelationshipType, target: "../worksheets/sheet1.xml", part: validPart,
			contentType: validContentType, partXML: worksheetXML, wantErr: true,
		},
		{
			name: "malformed target", expectedSheet: "Journal", sheetName: "Journal",
			relationship: validRelationshipType, target: "./worksheets/sheet1.xml", part: validPart,
			contentType: validContentType, partXML: worksheetXML, wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			filePath := filepath.Join(t.TempDir(), "journal.xlsx")
			writeXLSXValidationFixture(t, filePath, test.sheetName, test.relationship, test.target,
				test.targetMode, test.part, test.contentType, test.partXML)
			err := validateExactXLSXSheet(filePath, test.expectedSheet)
			if test.wantErr && err == nil {
				t.Fatal("malformed worksheet relationship was accepted")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("valid worksheet relationship was rejected: %v", err)
			}
		})
	}
}

func TestValidateExactXLSXSheetAcceptsUTF8BOM(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "journal.xlsx")
	writeXLSXValidationFixture(t, filePath, "Journal", xlsxWorksheetRelationshipType,
		"worksheets/sheet1.xml", "", "xl/worksheets/sheet1.xml", xlsxWorksheetContentType,
		`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`)
	prependXLSXMember(t, filePath, "xl/workbook.xml", []byte{0xef, 0xbb, 0xbf})
	if err := validateExactXLSXSheet(filePath, "Journal"); err != nil {
		t.Fatalf("valid OOXML UTF-8 BOM was rejected: %v", err)
	}
}

func TestValidateExactXLSXSheetRejectsNonBOMPrefix(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "journal.xlsx")
	writeXLSXValidationFixture(t, filePath, "Journal", xlsxWorksheetRelationshipType,
		"worksheets/sheet1.xml", "", "xl/worksheets/sheet1.xml", xlsxWorksheetContentType,
		`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`)
	prependXLSXMember(t, filePath, "xl/workbook.xml", []byte(" \ufeff"))
	if err := validateExactXLSXSheet(filePath, "Journal"); err == nil {
		t.Fatal("non-leading UTF-8 BOM was accepted")
	}
}

func prependXLSXMember(t *testing.T, filePath, member string, prefix []byte) {
	t.Helper()
	source, err := zip.OpenReader(filePath)
	if err != nil {
		t.Fatal(err)
	}
	tmpPath := filepath.Join(t.TempDir(), "rewritten.xlsx")
	tmp, err := os.Create(tmpPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(tmp)
	for _, sourceEntry := range source.File {
		entry, err := writer.Create(sourceEntry.Name)
		if err != nil {
			tmp.Close()
			t.Fatal(err)
		}
		data, err := sourceEntry.Open()
		if err != nil {
			tmp.Close()
			t.Fatal(err)
		}
		if sourceEntry.Name == member {
			if _, err := entry.Write(prefix); err != nil {
				data.Close()
				tmp.Close()
				t.Fatal(err)
			}
		}
		if _, err := io.Copy(entry, data); err != nil {
			data.Close()
			tmp.Close()
			t.Fatal(err)
		}
		data.Close()
	}
	if err := writer.Close(); err != nil {
		tmp.Close()
		t.Fatal(err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		t.Fatal(err)
	}
}

func writeXLSXValidationFixture(t *testing.T, filePath, sheetName, relationshipType, target, targetMode, targetPart, contentType, targetXML string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
		t.Fatal(err)
	}
	workbookXML := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="%s" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>`, xlsxMainNamespace, xmlEscape(sheetName))
	relationshipXML := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="%s"><Relationship Id="rId1" Type="%s" Target="%s"%s/></Relationships>`, packageRelationshipsNamespace, xmlEscape(relationshipType), xmlEscape(target), targetModeAttribute(targetMode))
	contentTypesXML := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="%s"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/%s" ContentType="%s"/></Types>`, packageContentTypesNamespace, targetPart, xmlEscape(contentType))
	parts := map[string]string{
		"[Content_Types].xml":        contentTypesXML,
		"xl/workbook.xml":            workbookXML,
		"xl/_rels/workbook.xml.rels": relationshipXML,
		targetPart:                   targetXML,
	}
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, content := range parts {
		entry, err := writer.Create(name)
		if err != nil {
			file.Close()
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			writer.Close()
			file.Close()
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func targetModeAttribute(mode string) string {
	if mode == "" {
		return ""
	}
	return fmt.Sprintf(` TargetMode="%s"`, xmlEscape(mode))
}

func xmlEscape(value string) string {
	var buffer []byte
	for _, symbol := range value {
		switch symbol {
		case '&':
			buffer = append(buffer, []byte("&amp;")...)
		case '<':
			buffer = append(buffer, []byte("&lt;")...)
		case '>':
			buffer = append(buffer, []byte("&gt;")...)
		case '"':
			buffer = append(buffer, []byte("&quot;")...)
		case '\'':
			buffer = append(buffer, []byte("&apos;")...)
		default:
			buffer = append(buffer, string(symbol)...)
		}
	}
	return string(buffer)
}
