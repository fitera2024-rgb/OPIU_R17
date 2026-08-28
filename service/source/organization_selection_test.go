package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
	if len(nodes) != 3 {
		t.Fatalf("organization API lost hierarchy nodes: %#v", nodes)
	}
	foundChild := false
	for _, node := range nodes {
		if node.ID == "ORG-1-CHILD" {
			foundChild = true
			if node.Selectable || node.Path != "1 Хабаровск / Вложенное ЮЛ" {
				t.Fatalf("nested organization has selection authority or lost its path: %#v", node)
			}
		} else if node.Depth == 0 && !node.Selectable {
			t.Fatalf("top-level organization is not selectable: %#v", node)
		}
	}
	if !foundChild {
		t.Fatal("nested organization disappeared from API hierarchy")
	}

	stored := store.OrganizationCatalog()
	foundChild = false
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

func TestAuthoritativeOrganizationCatalogKeeps592NodesAndSelectsExactly13Roots(t *testing.T) {
	nodes, err := loadOrganizationCatalog(filepath.Join("..", "..", "data", "defaults", "organizations.json"))
	if err != nil {
		t.Fatal(err)
	}
	server, store, _ := testServer(t)
	if err := store.ConfigureOrganizationCatalog(nodes); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/organizations", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("organizations status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var projected []organizationNode
	if err := json.Unmarshal(recorder.Body.Bytes(), &projected); err != nil {
		t.Fatal(err)
	}
	if len(projected) != 592 {
		t.Fatalf("authoritative hierarchy nodes=%d, want 592", len(projected))
	}
	selectable := 0
	wanted := map[string]bool{"1 Хабаровск": false, "3 Сахалин": false, "9 Управляющая компания": false}
	for _, node := range projected {
		if node.Path == "" {
			t.Fatalf("organization lost full path: %#v", node)
		}
		if node.Selectable {
			selectable++
			if node.Depth != 0 {
				t.Fatalf("nested organization is selectable: %#v", node)
			}
			if _, ok := wanted[node.Name]; ok {
				wanted[node.Name] = true
			}
		}
	}
	if selectable != 13 {
		t.Fatalf("selectable top-level organizations=%d, want 13", selectable)
	}
	for name, found := range wanted {
		if !found {
			t.Errorf("required top-level organization %q is not selectable", name)
		}
	}
}
