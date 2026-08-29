package main

import (
	"archive/zip"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

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
