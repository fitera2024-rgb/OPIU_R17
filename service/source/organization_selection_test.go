package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOrganizationSelectionExposesAndAcceptsOnlyTopLevel(t *testing.T) {
	server, store, _ := testServer(t)
	if err := store.ConfigureOrganizationCatalog([]organizationNode{
		{ID: "ORG-1", Code: "1", Name: "1 Хабаровск", Path: "1 Хабаровск", Depth: 0, Selectable: true},
		{ID: "ORG-1-CHILD", Code: "11", Name: "Вложенное ЮЛ", Path: "1 Хабаровск / Вложенное ЮЛ", ParentID: "ORG-1", TopID: "ORG-1", Depth: 1, Selectable: true},
		{ID: "ORG-9", Code: "9", Name: "9 Управляющая компания", Path: "9 Управляющая компания", Depth: 0, Selectable: true},
	}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/organizations", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("organizations status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var nodes []organizationNode
	if err := json.Unmarshal(recorder.Body.Bytes(), &nodes); err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || nodes[0].Depth != 0 || nodes[1].Depth != 0 || !nodes[0].Selectable || !nodes[1].Selectable {
		t.Fatalf("organization selector exposed non-root nodes: %#v", nodes)
	}
	for _, node := range nodes {
		if node.ID == "ORG-1-CHILD" {
			t.Fatalf("nested organization is visible in selector: %#v", nodes)
		}
	}

	stored := store.OrganizationCatalog()
	foundChild := false
	for _, node := range stored {
		if node.ID == "ORG-1-CHILD" {
			foundChild = true
			if node.Selectable {
				t.Fatalf("nested organization retained selection authority: %#v", node)
			}
		}
	}
	if !foundChild {
		t.Fatal("nested organization disappeared from the authoritative hierarchy")
	}

	erp := addTestSource(t, store, SourceERP, "erp.xlsx")
	intalev := addTestSource(t, store, SourceIntalev, "intalev.xlsx")
	if _, err := store.CreateContext(createContextRequest{
		Organization: "Вложенное ЮЛ", OrganizationID: "ORG-1-CHILD",
		OrganizationName: "Вложенное ЮЛ", OrganizationPath: "1 Хабаровск / Вложенное ЮЛ",
		Period: "2025-10", ERPFileID: erp.ID, IntalevFileID: intalev.ID,
	}); err == nil {
		t.Fatal("nested organization was accepted as a reconciliation context")
	}
}
