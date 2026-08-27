package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	existingServiceHealthLimit  = 64 * 1024
	servicePreflightWaitTimeout = 2 * time.Second
	servicePreflightPollTimeout = 80 * time.Millisecond
	servicePreflightTimeout     = 5 * time.Second
	serviceHealthProbeTimeout   = 700 * time.Millisecond
	serviceResultPollInterval   = 100 * time.Millisecond
	serviceResultShutdownGrace  = 4 * time.Second
	serviceUIReconnectGrace     = 4 * time.Second
	serviceShutdownTimeout      = 2 * time.Second
)

type existingServiceHealth struct {
	Status         *string                `json:"status"`
	Service        *string                `json:"service"`
	Implementation *string                `json:"implementation"`
	Safety         *existingServiceSafety `json:"safety"`
}

type existingServiceSafety struct {
	Mode           *string `json:"mode"`
	PostingRows    *int    `json:"posting_rows"`
	ReadyToUpload  *bool   `json:"ready_to_upload"`
	ReleaseAllowed *bool   `json:"release_allowed"`
	Live1CAllowed  *bool   `json:"live_1c_allowed"`
}

// openVerifiedExistingService checks that the occupied address belongs to this
// exact report-only implementation and then opens it in a browser.
func openVerifiedExistingService(address string, noOpen bool, client *http.Client, opener func(string) error) (string, bool) {
	serviceURL, ok := loopbackServiceURL(address)
	if !ok {
		return "", false
	}
	if client == nil {
		client = &http.Client{
			Timeout: serviceHealthProbeTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	owner, verified, _, err := verifyExistingServiceAtAddress(address, client, serviceHealthProbeTimeout)
	if err != nil || !verified || owner.PID == 0 {
		return "", false
	}
	if !noOpen && opener != nil {
		_ = opener(serviceURL)
	}
	return serviceURL, true
}

func acquireServiceListener(address, runtimeLogPath string) (net.Listener, int, error) {
	return acquireServiceListenerWithTimeout(address, runtimeLogPath, servicePreflightTimeout)
}

func acquireServiceListenerWithTimeout(address, runtimeLogPath string, timeout time.Duration) (net.Listener, int, error) {
	endpoint, endpointErr := exactListenerEndpoint(address)
	if endpointErr != nil {
		return nil, 0, fmt.Errorf("listen %s: требуется точный loopback IP: %w", address, endpointErr)
	}
	address = endpoint.Address()
	if timeout <= 0 {
		timeout = servicePreflightTimeout
	}
	deadline := time.Now().Add(timeout)
	restartedPID := 0
	for {
		listener, err := net.Listen(endpoint.Network, address)
		if err == nil {
			return listener, restartedPID, nil
		}

		owner, verified, reason, err := verifyExistingServiceAtAddress(address, nil, serviceHealthProbeTimeout)
		if err != nil {
			return nil, 0, fmt.Errorf("port %s: не удалось определить состояние сокета: %v (journal: %s)", address, err, runtimeLogPath)
		}
		if !verified {
			return nil, owner.PID, fmt.Errorf("порт %s занят процессом pid=%d path=%q: %s (journal: %s)", address, owner.PID, owner.ExecutablePath, reason, runtimeLogPath)
		}

		confirmedOwner, found, confirmErr := servicePortOwner(address)
		if confirmErr != nil || !found || !samePortOwnerIdentity(owner, confirmedOwner) {
			return nil, owner.PID, fmt.Errorf("владелец точного endpoint %s изменился перед завершением pid=%d path=%q. journal=%s", owner.Endpoint.String(), owner.PID, owner.ExecutablePath, runtimeLogPath)
		}
		log.Printf("Найден предыдущий OPIU endpoint=%s pid=%d path=%q. Завершаю дерево процесса.", owner.Endpoint.String(), owner.PID, owner.ExecutablePath)
		if err := terminateVerifiedProcessTree(owner); err != nil {
			return nil, owner.PID, fmt.Errorf("не удалось завершить предыдущий OPIU на порту %s (pid=%d, path=%q): %v. journal: %s", address, owner.PID, owner.ExecutablePath, err, runtimeLogPath)
		}
		restartedPID = owner.PID

		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, owner.PID, fmt.Errorf("тайм-аут (%v) при завершении предыдущего процесса pid=%d path=%q. journal=%s", timeout, owner.PID, owner.ExecutablePath, runtimeLogPath)
		}
		if err := waitForPortRelease(address, remaining); err != nil {
			return nil, owner.PID, fmt.Errorf("тайм-аут ожидания освобождения порта %s после завершения pid=%d path=%q: %v. journal=%s", address, owner.PID, owner.ExecutablePath, err, runtimeLogPath)
		}
	}
}

func verifyExistingServiceAtAddress(address string, client *http.Client, timeout time.Duration) (portOwner, bool, string, error) {
	serviceURL, ok := loopbackServiceURL(address)
	if !ok {
		return portOwner{}, false, "адрес слушателя не является локальным loopback", fmt.Errorf("invalid loopback listener address %q", address)
	}
	owner, found, err := servicePortOwner(address)
	if err != nil {
		return portOwner{}, false, "ошибка определения процесса слушателя", err
	}
	if !found {
		return portOwner{}, false, "порт не прослушивается", nil
	}
	if strings.TrimSpace(owner.ExecutablePath) == "" {
		return owner, false, "не удалось определить путь исполняемого файла владельца", nil
	}
	expectedExecutablePath, err := currentExecutablePath()
	if err != nil || strings.TrimSpace(expectedExecutablePath) == "" {
		return owner, false, "не удалось определить путь текущего исполняемого файла OPIU", nil
	}
	if !sameExecutableFile(owner.ExecutablePath, expectedExecutablePath) {
		return owner, false, fmt.Sprintf("путь владельца %q не совпадает с текущим OPIU %q", owner.ExecutablePath, expectedExecutablePath), nil
	}
	health, err := fetchServiceHealth(serviceURL, client, timeout)
	if err != nil {
		return owner, false, err.Error(), nil
	}
	if !isOPIUServiceHealth(health) {
		return owner, false, "health-check подтверждает не OPIU_STABLE/NEW_COMPATIBLE_IMPLEMENTATION/REPORT_ONLY", nil
	}
	confirmedOwner, found, err := servicePortOwner(address)
	if err != nil {
		return owner, false, "ошибка повторного определения процесса слушателя", err
	}
	if !found || !samePortOwnerIdentity(owner, confirmedOwner) {
		return confirmedOwner, false, "владелец точного endpoint изменился во время health-check", nil
	}
	return owner, true, "", nil
}

func fetchServiceHealth(serviceURL string, client *http.Client, timeout time.Duration) (existingServiceHealth, error) {
	var health existingServiceHealth
	if client == nil {
		if timeout <= 0 {
			timeout = serviceHealthProbeTimeout
		}
		client = &http.Client{
			Timeout: timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	} else {
		clientCopy := *client
		clientCopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
		if clientCopy.Timeout <= 0 && timeout > 0 {
			clientCopy.Timeout = timeout
		}
		client = &clientCopy
	}
	response, err := client.Get(serviceURL + "api/health")
	if err != nil {
		return health, fmt.Errorf("не удаётся достучаться до /api/health: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return health, fmt.Errorf("неожиданный HTTP-статус /api/health: %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, existingServiceHealthLimit+1))
	if err != nil {
		return health, fmt.Errorf("не удалось прочитать /api/health: %w", err)
	}
	if len(payload) > existingServiceHealthLimit {
		return health, fmt.Errorf("/api/health превышает лимит %d байт", existingServiceHealthLimit)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&health); err != nil {
		return health, fmt.Errorf("невалидный /api/health: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return health, fmt.Errorf("после JSON /api/health обнаружен второй объект")
		}
		return health, fmt.Errorf("после JSON /api/health обнаружено постороннее содержимое: %w", err)
	}
	return health, nil
}

func isOPIUServiceHealth(health existingServiceHealth) bool {
	return health.Status != nil && *health.Status == "ok" &&
		health.Service != nil && *health.Service == "OPIU_STABLE" &&
		health.Implementation != nil && *health.Implementation == "NEW_COMPATIBLE_IMPLEMENTATION" &&
		health.Safety != nil &&
		health.Safety.Mode != nil && *health.Safety.Mode == "REPORT_ONLY" &&
		health.Safety.PostingRows != nil && *health.Safety.PostingRows == 0 &&
		health.Safety.ReadyToUpload != nil && !*health.Safety.ReadyToUpload &&
		health.Safety.ReleaseAllowed != nil && !*health.Safety.ReleaseAllowed &&
		health.Safety.Live1CAllowed != nil && !*health.Safety.Live1CAllowed
}

func samePortOwnerIdentity(left, right portOwner) bool {
	return left.PID > 0 && left.PID == right.PID &&
		strings.TrimSpace(left.CreationIdentity) != "" &&
		left.CreationIdentity == right.CreationIdentity &&
		sameListenerEndpoint(left.Endpoint, right.Endpoint) &&
		sameExecutableFile(left.ExecutablePath, right.ExecutablePath)
}

func waitForPortAndProcessRelease(address string, processPID int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		free, freeErr := isPortAvailable(address)
		if freeErr != nil {
			return freeErr
		}
		if free && !isProcessAlive(processPID) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("port=%s pid=%d alive=%t free=%t", address, processPID, isProcessAlive(processPID), free)
		}
		time.Sleep(servicePreflightPollTimeout)
	}
}

func waitForPortRelease(address string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		free, err := isPortAvailable(address)
		if err != nil {
			return err
		}
		if free {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("port=%s free=false", address)
		}
		time.Sleep(servicePreflightPollTimeout)
	}
}

func isPortAvailable(address string) (bool, error) {
	endpoint, err := exactListenerEndpoint(address)
	if err != nil {
		return false, err
	}
	listener, err := net.Listen(endpoint.Network, endpoint.Address())
	if err != nil {
		return false, nil
	}
	if err := listener.Close(); err != nil {
		return false, err
	}
	return true, nil
}

type completedRunTracker struct {
	store    *Store
	baseline map[string]struct{}
}

func newCompletedRunTracker(store *Store) *completedRunTracker {
	tracker := &completedRunTracker{store: store, baseline: make(map[string]struct{})}
	for _, run := range store.Snapshot(false).Runs {
		if run.Status == RunCompletedReportOnly {
			tracker.baseline[run.ID] = struct{}{}
		}
	}
	return tracker
}

func (tracker *completedRunTracker) hasNewCompletion() bool {
	for _, run := range tracker.store.Snapshot(false).Runs {
		if run.Status != RunCompletedReportOnly {
			continue
		}
		if _, existed := tracker.baseline[run.ID]; existed {
			continue
		}
		tracker.baseline[run.ID] = struct{}{}
		return true
	}
	return false
}

type serviceLifecycleSnapshot struct {
	InFlight      int
	UISessions    int
	UISessionSeen bool
}

type serviceLifecycleState struct {
	mu            sync.Mutex
	inFlight      int
	uiSessions    int
	uiSessionSeen bool
}

func newServiceLifecycleState() *serviceLifecycleState {
	return &serviceLifecycleState{}
}

func (state *serviceLifecycleState) beginRequest() {
	state.mu.Lock()
	state.inFlight++
	state.mu.Unlock()
}

func (state *serviceLifecycleState) endRequest() {
	state.mu.Lock()
	if state.inFlight > 0 {
		state.inFlight--
	}
	state.mu.Unlock()
}

func (state *serviceLifecycleState) openUISession() {
	state.mu.Lock()
	state.uiSessionSeen = true
	state.uiSessions++
	state.mu.Unlock()
}

func (state *serviceLifecycleState) closeUISession() {
	state.mu.Lock()
	if state.uiSessions > 0 {
		state.uiSessions--
	}
	state.mu.Unlock()
}

func (state *serviceLifecycleState) snapshot() serviceLifecycleSnapshot {
	state.mu.Lock()
	defer state.mu.Unlock()
	return serviceLifecycleSnapshot{
		InFlight:      state.inFlight,
		UISessions:    state.uiSessions,
		UISessionSeen: state.uiSessionSeen,
	}
}

func trackServiceActivity(next http.Handler, state *serviceLifecycleState) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state.beginRequest()
		defer state.endRequest()
		next.ServeHTTP(w, r)
	})
}

func withUISessionEndpoint(next http.Handler, state *serviceLifecycleState) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ui-session" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		state.openUISession()
		defer state.closeUISession()
		_, _ = io.WriteString(w, "event: connected\ndata: ok\n\n")
		flusher.Flush()
		heartbeat := time.NewTicker(2 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-heartbeat.C:
				if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	})
}

func monitorServiceLifecycle(ctx context.Context, state *serviceLifecycleState, completed, active func() bool, pollInterval, resultGrace, uiReconnectGrace time.Duration, shutdown func(string)) {
	if pollInterval <= 0 {
		pollInterval = serviceResultPollInterval
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	resultPending := false
	var resultReadyAt time.Time
	var uiClosedReadyAt time.Time

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			if !resultPending && completed != nil && completed() {
				resultPending = true
			}
			snapshot := state.snapshot()
			hasActiveRun := active != nil && active()
			safeToStop := snapshot.InFlight == 0 && !hasActiveRun

			if resultPending {
				if !safeToStop {
					resultReadyAt = time.Time{}
				} else if resultReadyAt.IsZero() {
					resultReadyAt = now.Add(resultGrace)
				} else if !now.Before(resultReadyAt) {
					shutdown("result-completed")
					return
				}
			}

			if !snapshot.UISessionSeen || snapshot.UISessions > 0 || !safeToStop {
				uiClosedReadyAt = time.Time{}
				continue
			}
			if uiClosedReadyAt.IsZero() {
				uiClosedReadyAt = now.Add(uiReconnectGrace)
				continue
			}
			if !now.Before(uiClosedReadyAt) {
				shutdown("ui-session-closed")
				return
			}
		}
	}
}

func hasActiveRuns(store *Store) bool {
	for _, run := range store.Snapshot(false).Runs {
		switch run.Status {
		case RunQueued, RunPreflight, RunRunning:
			return true
		}
	}
	return false
}

func loopbackServiceURL(address string) (string, bool) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.TrimSpace(port) == "" {
		return "", false
	}
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return "", false
		}
	}
	return (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), Path: "/"}).String(), true
}
