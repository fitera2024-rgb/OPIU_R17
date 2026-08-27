package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var acceptedPeriod = regexp.MustCompile(`^\d{4}(?:-(?:0[1-9]|1[0-2])|-Q[1-4])?$`)

var storeStateFileMu sync.Mutex

type storeState struct {
	Files                    map[string]SourceFile                       `json:"files"`
	Contexts                 map[string]Context                          `json:"contexts"`
	Runs                     map[string]Run                              `json:"runs"`
	StructuralControlAnchors map[string]structuralControlInventoryAnchor `json:"-"`
}

type structuralControlInventoryAnchor struct {
	BindingSHA256 string `json:"binding_sha256"`
}

type Store struct {
	mu                  sync.RWMutex
	root                string
	filesDir            string
	runsDir             string
	statePath           string
	organizationCatalog map[string]organizationNode
	state               storeState
}

func OpenStore(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("data directory is required")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	store := &Store{
		root:                root,
		filesDir:            filepath.Join(root, "files"),
		runsDir:             filepath.Join(root, "runs"),
		statePath:           filepath.Join(root, "state.json"),
		organizationCatalog: map[string]organizationNode{},
		state: storeState{
			Files:                    map[string]SourceFile{},
			Contexts:                 map[string]Context{},
			Runs:                     map[string]Run{},
			StructuralControlAnchors: map[string]structuralControlInventoryAnchor{},
		},
	}
	for _, directory := range []string{store.root, store.filesDir, store.runsDir} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, err
		}
	}
	releaseStateLock, err := store.lockDurableState()
	if err != nil {
		return nil, err
	}
	defer releaseStateLock()
	data, err := os.ReadFile(store.statePath)
	if err != nil {
		if os.IsNotExist(err) {
			if err := store.saveLocked(); err != nil {
				return nil, err
			}
			return store, nil
		}
		return nil, err
	}
	var persisted persistedStoreState
	if err := json.Unmarshal(data, &persisted); err != nil {
		return nil, fmt.Errorf("read state: %w", err)
	}
	store.state = storeState{
		Files:                    persisted.Files,
		Contexts:                 persisted.Contexts,
		Runs:                     persisted.Runs,
		StructuralControlAnchors: persisted.StructuralControlAnchors,
	}
	if store.state.Files == nil {
		store.state.Files = map[string]SourceFile{}
	}
	if store.state.Contexts == nil {
		store.state.Contexts = map[string]Context{}
	}
	if store.state.Runs == nil {
		store.state.Runs = map[string]Run{}
	}
	if store.state.StructuralControlAnchors == nil {
		store.state.StructuralControlAnchors = map[string]structuralControlInventoryAnchor{}
	}
	if store.restoreSourceMetadata(persisted.SourceMetadata) {
		if err := store.saveLocked(); err != nil {
			return nil, fmt.Errorf("persist recovered source metadata: %w", err)
		}
	}
	return store, nil
}

func (s *Store) ConfigureOrganizationCatalog(nodes []organizationNode) error {
	catalog := make(map[string]organizationNode, len(nodes))
	for _, node := range nodes {
		node.ID = cleanBusinessText(node.ID, 200)
		node.Name = cleanBusinessText(node.Name, 200)
		node.Path = cleanBusinessText(node.Path, 500)
		if node.ID == "" || node.Name == "" || node.Path == "" {
			return errors.New("organization catalog contains incomplete exact identity")
		}
		key := strings.ToUpper(node.ID)
		if _, exists := catalog[key]; exists {
			return errors.New("organization catalog contains duplicate identity")
		}
		catalog[key] = node
	}
	if len(catalog) == 0 {
		return errors.New("organization catalog is empty")
	}
	s.mu.Lock()
	s.organizationCatalog = catalog
	s.mu.Unlock()
	return nil
}

func (s *Store) OrganizationCatalog() []organizationNode {
	s.mu.RLock()
	defer s.mu.RUnlock()
	nodes := make([]organizationNode, 0, len(s.organizationCatalog))
	for _, node := range s.organizationCatalog {
		nodes = append(nodes, node)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Path < nodes[j].Path })
	return nodes
}

func (s *Store) saveLocked() error {
	return atomicWriteJSON(s.statePath, persistedState(s.state))
}

func (s *Store) lockDurableState() (func(), error) {
	storeStateFileMu.Lock()
	releaseFileLock, err := acquireStructuralRegistryFileLock(filepath.Join(s.root, ".store-state.lock"), 2*time.Second)
	if err != nil {
		storeStateFileMu.Unlock()
		return nil, fmt.Errorf("store state is busy: %w", err)
	}
	return func() {
		releaseFileLock()
		storeStateFileMu.Unlock()
	}, nil
}

func (s *Store) reloadLocked() error {
	data, err := os.ReadFile(s.statePath)
	if err != nil {
		return err
	}
	var persisted persistedStoreState
	if err := json.Unmarshal(data, &persisted); err != nil {
		return fmt.Errorf("read state: %w", err)
	}
	s.state = storeState{
		Files:                    persisted.Files,
		Contexts:                 persisted.Contexts,
		Runs:                     persisted.Runs,
		StructuralControlAnchors: persisted.StructuralControlAnchors,
	}
	if s.state.Files == nil {
		s.state.Files = map[string]SourceFile{}
	}
	if s.state.Contexts == nil {
		s.state.Contexts = map[string]Context{}
	}
	if s.state.Runs == nil {
		s.state.Runs = map[string]Run{}
	}
	if s.state.StructuralControlAnchors == nil {
		s.state.StructuralControlAnchors = map[string]structuralControlInventoryAnchor{}
	}
	s.restoreSourceMetadata(persisted.SourceMetadata)
	return nil
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) FilesDir() string {
	return s.filesDir
}

func (s *Store) RunsDir() string {
	return s.runsDir
}

func (s *Store) PutFile(file SourceFile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	if file.ID == "" || file.DiskName == "" || file.SHA256 == "" {
		return errors.New("incomplete file metadata")
	}
	if _, exists := s.state.Files[file.ID]; exists {
		return errors.New("file id already exists")
	}
	s.state.Files[file.ID] = file
	if err := s.saveLocked(); err != nil {
		delete(s.state.Files, file.ID)
		return err
	}
	return nil
}

func (s *Store) File(id string) (SourceFile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, ok := s.state.Files[id]
	return file, ok
}

func (s *Store) FilePath(file SourceFile) (string, error) {
	base, err := secureBaseName(file.DiskName)
	if err != nil {
		return "", err
	}
	path := filepath.Join(s.filesDir, base)
	cleanFiles := filepath.Clean(s.filesDir) + string(os.PathSeparator)
	cleanPath := filepath.Clean(path)
	if cleanPath != filepath.Clean(s.filesDir) && len(cleanPath) >= len(cleanFiles) && cleanPath[:len(cleanFiles)] != cleanFiles {
		return "", errors.New("file path escaped store")
	}
	return cleanPath, nil
}

func (s *Store) DeleteFile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	file, ok := s.state.Files[id]
	if !ok {
		return os.ErrNotExist
	}
	for _, context := range s.state.Contexts {
		if !context.Archived && (context.ERPFileID == id || context.IntalevFileID == id) {
			return errors.New("file is used by an active context")
		}
	}
	path, err := s.FilePath(file)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	delete(s.state.Files, id)
	return s.saveLocked()
}

func (s *Store) CreateContext(request createContextRequest) (Context, error) {
	organizationID := cleanBusinessText(request.OrganizationID, 200)
	organizationName := cleanBusinessText(request.OrganizationName, 200)
	organizationPath := cleanBusinessText(request.OrganizationPath, 500)
	organization := cleanBusinessText(request.Organization, 200)
	if organizationName != "" {
		organization = organizationName
	}
	cfo := cleanBusinessText(request.CFO, 200)
	period := cleanBusinessText(request.Period, 12)
	if organization == "" {
		return Context{}, errors.New("organization is required")
	}
	if organizationID != "" && (organizationName == "" || organizationPath == "") {
		return Context{}, errors.New("exact organization name and path are required")
	}
	if organizationID == "" && (organizationName != "" || organizationPath != "") {
		return Context{}, errors.New("exact organization id is required")
	}
	if organizationID != "" {
		s.mu.RLock()
		node, ok := s.organizationCatalog[strings.ToUpper(organizationID)]
		s.mu.RUnlock()
		if !ok || !node.Selectable || node.Name != organizationName || node.Path != organizationPath {
			return Context{}, errors.New("exact organization is not present in the authoritative catalog")
		}
	}
	if !acceptedPeriod.MatchString(period) {
		return Context{}, errors.New("period must be YYYY, YYYY-Q1..Q4, or YYYY-MM")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return Context{}, err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return Context{}, err
	}
	erp, ok := s.state.Files[request.ERPFileID]
	if !ok || erp.Kind != SourceERP {
		return Context{}, errors.New("selected ERP source is unavailable")
	}
	intalev, ok := s.state.Files[request.IntalevFileID]
	if !ok || intalev.Kind != SourceIntalev {
		return Context{}, errors.New("selected Intalev source is unavailable")
	}
	id, err := newOpaqueID("ctx")
	if err != nil {
		return Context{}, err
	}
	now := time.Now().UTC()
	context := Context{
		ID: id, Organization: organization,
		OrganizationID: organizationID, OrganizationName: organizationName, OrganizationPath: organizationPath,
		CFO: cfo, Period: period, ERPFileID: erp.ID, IntalevFileID: intalev.ID,
		CreatedAt: now, UpdatedAt: now,
	}
	s.state.Contexts[id] = context
	if err := s.saveLocked(); err != nil {
		delete(s.state.Contexts, id)
		return Context{}, err
	}
	return context, nil
}

func (s *Store) Context(id string) (Context, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	context, ok := s.state.Contexts[id]
	return context, ok
}

func (s *Store) ArchiveContext(id string) (Context, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return Context{}, err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return Context{}, err
	}
	context, ok := s.state.Contexts[id]
	if !ok {
		return Context{}, os.ErrNotExist
	}
	for _, run := range s.state.Runs {
		if run.ContextID == id && (run.Status == RunQueued || run.Status == RunPreflight ||
			run.Status == RunRunning || run.Status == RunWaitingUserRules) {
			return Context{}, errors.New("context has an active report-only run")
		}
	}
	context.Archived = true
	context.UpdatedAt = time.Now().UTC()
	s.state.Contexts[id] = context
	if err := s.saveLocked(); err != nil {
		return Context{}, err
	}
	return context, nil
}

func (s *Store) CreateRun(contextID string) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return Run{}, err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return Run{}, err
	}
	context, ok := s.state.Contexts[contextID]
	if !ok || context.Archived {
		return Run{}, errors.New("active context is unavailable")
	}
	id, err := newOpaqueID("run")
	if err != nil {
		return Run{}, err
	}
	run := Run{
		ID:        id,
		ContextID: contextID,
		Status:    RunQueued,
		Stage:     "QUEUED",
		Message:   "Задача поставлена в очередь",
		StartedAt: time.Now().UTC(),
		Safety:    reportOnlySafety(),
	}
	s.state.Runs[id] = run
	if err := s.saveLocked(); err != nil {
		delete(s.state.Runs, id)
		return Run{}, err
	}
	return run, nil
}

func (s *Store) Run(id string) (Run, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, ok := s.state.Runs[id]
	return run, ok
}

func (s *Store) UpdateRun(run Run) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	if _, exists := s.state.Runs[run.ID]; !exists {
		return os.ErrNotExist
	}
	run.Safety = reportOnlySafety()
	s.state.Runs[run.ID] = run
	return s.saveLocked()
}

func (s *Store) AnchorStructuralControlInventory(runID, bindingSHA256 string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	releaseStateLock, err := s.lockDurableState()
	if err != nil {
		return err
	}
	defer releaseStateLock()
	if err := s.reloadLocked(); err != nil {
		return err
	}
	run, exists := s.state.Runs[runID]
	contextValue, contextExists := s.state.Contexts[run.ContextID]
	if !exists || !contextExists || contextValue.Archived || !validSHA256(bindingSHA256) {
		return errors.New("invalid structural control inventory anchor")
	}
	bindingSHA256 = strings.ToUpper(bindingSHA256)
	if existing, exists := s.state.StructuralControlAnchors[runID]; exists {
		if existing.BindingSHA256 == bindingSHA256 {
			return nil
		}
		return errors.New("structural control inventory anchor is immutable")
	}
	s.state.StructuralControlAnchors[runID] = structuralControlInventoryAnchor{BindingSHA256: bindingSHA256}
	if err := s.saveLocked(); err != nil {
		delete(s.state.StructuralControlAnchors, runID)
		return err
	}
	return nil
}

func (s *Store) StructuralControlInventoryAnchor(runID string) (structuralControlInventoryAnchor, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	anchor, ok := s.state.StructuralControlAnchors[runID]
	return anchor, ok
}

func (s *Store) Snapshot(engineReady bool) Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	files := make([]SourceFile, 0, len(s.state.Files))
	for _, file := range s.state.Files {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].CreatedAt.After(files[j].CreatedAt) })
	contexts := make([]Context, 0, len(s.state.Contexts))
	for _, context := range s.state.Contexts {
		contexts = append(contexts, context)
	}
	sort.Slice(contexts, func(i, j int) bool { return contexts[i].CreatedAt.After(contexts[j].CreatedAt) })
	runs := make([]Run, 0, len(s.state.Runs))
	for _, run := range s.state.Runs {
		_, run.HasStructuralInventory = s.state.StructuralControlAnchors[run.ID]
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt.After(runs[j].StartedAt) })
	return Snapshot{
		ServiceVersion:     "1.9.4-stable-reimplementation.1",
		Implementation:     "NEW_COMPATIBLE_IMPLEMENTATION",
		Safety:             reportOnlySafety(),
		EngineAdapterReady: engineReady,
		Files:              files,
		Contexts:           contexts,
		Runs:               runs,
	}
}
