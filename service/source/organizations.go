package main

import (
	"errors"
	"net/http"
	"os"
	"strings"
)

type organizationCatalog struct {
	SchemaVersion string             `json:"schema_version,omitempty"`
	Source        organizationSource `json:"source,omitempty"`
	Nodes         []organizationNode `json:"nodes"`
}

type organizationSource struct {
	Path             string `json:"path"`
	SHA256           string `json:"sha256"`
	Sheet            string `json:"sheet"`
	Rows             int    `json:"rows"`
	Title            string `json:"title"`
	DistributionSeed string `json:"distribution_seed"`
}

type organizationNode struct {
	ID             string            `json:"node_id"`
	Code           string            `json:"code"`
	Name           string            `json:"name"`
	Path           string            `json:"path"`
	ParentID       string            `json:"parent_id"`
	TopID          string            `json:"top_id"`
	TopName        string            `json:"top_name"`
	Depth          int               `json:"depth"`
	NodeType       string            `json:"node_type"`
	Selectable     bool              `json:"selectable"`
	SourceRow      int               `json:"source_row"`
	SourceVerified bool              `json:"source_verified"`
	Metadata       map[string]string `json:"metadata"`
	HasChildren    bool              `json:"has_children"`
	NodeName       string            `json:"node_name"`
	NodeCode       string            `json:"node_code"`
	HierarchyPath  string            `json:"hierarchy_path"`
}

func loadOrganizationCatalog(path string) ([]organizationNode, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var catalog organizationCatalog
	if err := decodeExactJSON(payload, &catalog); err != nil {
		return nil, err
	}
	if len(catalog.Nodes) == 0 {
		return nil, errors.New("organization catalog has no nodes")
	}
	seen := map[string]struct{}{}
	for index := range catalog.Nodes {
		node := &catalog.Nodes[index]
		node.ID = cleanBusinessText(node.ID, 200)
		node.Name = cleanBusinessText(node.Name, 200)
		node.Path = cleanBusinessText(node.Path, 500)
		if node.ID == "" || node.Name == "" || node.Path == "" {
			return nil, errors.New("organization catalog contains incomplete exact identity")
		}
		key := strings.ToUpper(node.ID)
		if _, exists := seen[key]; exists {
			return nil, errors.New("organization catalog contains duplicate identity")
		}
		seen[key] = struct{}{}
	}
	return catalog.Nodes, nil
}

func (s *Server) handleOrganizations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSON(w, http.StatusMethodNotAllowed, apiError{Error: "Метод не поддерживается"})
		return
	}
	if s.pipeline == nil {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "Иерархия организаций недоступна: runtime не подключён"})
		return
	}
	nodes := s.store.OrganizationCatalog()
	if len(nodes) == 0 {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "Иерархия организаций отсутствует в runtime"})
		return
	}
	selectableRoots := make([]organizationNode, 0, len(nodes))
	for _, node := range nodes {
		if node.Depth != 0 || !node.Selectable {
			continue
		}
		selectableRoots = append(selectableRoots, node)
	}
	if len(selectableRoots) == 0 {
		writeJSON(w, http.StatusServiceUnavailable, apiError{Error: "В иерархии организаций отсутствует верхний уровень"})
		return
	}
	writeJSON(w, http.StatusOK, selectableRoots)
}
