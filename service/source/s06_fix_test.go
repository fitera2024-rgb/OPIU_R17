package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const strictOPIUHealthJSON = `{"status":"ok","service":"OPIU_STABLE","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false,"live_1c_allowed":false}}`

func TestHealthRejectsMissingSafetyKeyAndTrailingContent(t *testing.T) {
	cases := map[string]string{
		"missing safety key": `{"status":"ok","service":"OPIU_STABLE","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false}}`,
		"second object":      strictOPIUHealthJSON + `{}`,
		"trailing garbage":   strictOPIUHealthJSON + ` not-json`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, body)
			}))
			defer server.Close()
			if _, handled := openVerifiedExistingService(server.Listener.Addr().String(), true, server.Client(), nil); handled {
				t.Fatalf("небезопасный health принят: %s", name)
			}
		})
	}
}

func TestHealthRedirectDoesNotBorrowAnotherEndpointIdentity(t *testing.T) {
	valid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, strictOPIUHealthJSON)
	}))
	defer valid.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, valid.URL+"/api/health", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	if _, handled := openVerifiedExistingService(redirect.Listener.Addr().String(), true, redirect.Client(), nil); handled {
		t.Fatal("health другого endpoint принят через redirect")
	}
}

func TestExactEndpointSeparatesSamePortDifferentLoopbackIPs(t *testing.T) {
	first, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := first.Addr().(*net.TCPAddr).Port
	second, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.2", strconv.Itoa(port)))
	if err != nil {
		first.Close()
		t.Skipf("система не поддерживает два loopback IP на одном порту: %v", err)
	}
	first.Close()
	second.Close()

	verifiedAddress := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	foreignAddress := net.JoinHostPort("127.0.0.2", strconv.Itoa(port))
	_, foreignPID := startS06Helper(t, foreignAddress, "foreign")
	_, verifiedPID := startS06Helper(t, verifiedAddress, "verified")

	owner, found, err := servicePortOwner(verifiedAddress)
	if err != nil || !found {
		t.Fatalf("точный владелец не найден: found=%t err=%v", found, err)
	}
	if owner.PID != verifiedPID || owner.PID == foreignPID {
		t.Fatalf("listeners одного порта смешаны: verified=%d foreign=%d owner=%d", verifiedPID, foreignPID, owner.PID)
	}
	t.Logf("endpoint_protocol target=%s owner_pid=%d executable=%s foreign_endpoint=%s foreign_pid=%d", verifiedAddress, owner.PID, filepath.Base(owner.ExecutablePath), foreignAddress, foreignPID)
	listener, replacedPID, err := acquireServiceListenerWithTimeout(verifiedAddress, "test-service-runtime.log", 3*time.Second)
	if err != nil {
		t.Fatalf("точный OPIU не заменён: %v", err)
	}
	listener.Close()
	if replacedPID != verifiedPID {
		t.Fatalf("завершён pid=%d вместо точного pid=%d", replacedPID, verifiedPID)
	}
	waitForPIDGone(t, verifiedPID, 3*time.Second)
	if !isProcessAlive(foreignPID) {
		t.Fatalf("foreign listener pid=%d на другом IP был завершён", foreignPID)
	}
}

func TestIPv6EndpointOwnerIsExact(t *testing.T) {
	probe, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("IPv6 loopback недоступен: %v", err)
	}
	address := probe.Addr().String()
	probe.Close()
	_, pid := startS06Helper(t, address, "verified")
	owner, found, err := servicePortOwner(address)
	if err != nil || !found || owner.PID != pid || owner.Endpoint.Network != "tcp6" {
		t.Fatalf("IPv6 owner mismatch: owner=%+v found=%t err=%v want_pid=%d", owner, found, err, pid)
	}
}

func TestRapidTripleAcquireKeepsExactlyOneNewListener(t *testing.T) {
	address := acquireFreeTCPAddress(t)
	first := startS06FixHelper(t, address, "launcher")
	if first.replacedPID != 0 {
		t.Fatalf("первый запуск неожиданно заменил pid=%d", first.replacedPID)
	}
	second := startS06FixHelper(t, address, "launcher")
	if second.replacedPID != first.pid {
		t.Fatalf("второй запуск заменил pid=%d, ожидался %d", second.replacedPID, first.pid)
	}
	waitForPIDGone(t, first.pid, 3*time.Second)
	third := startS06FixHelper(t, address, "launcher")
	if third.replacedPID != second.pid {
		t.Fatalf("третий запуск заменил pid=%d, ожидался %d", third.replacedPID, second.pid)
	}
	waitForPIDGone(t, second.pid, 3*time.Second)

	owner, found, err := servicePortOwner(address)
	if err != nil || !found || owner.PID != third.pid {
		t.Fatalf("после третьего запуска владелец=%+v found=%t err=%v, ожидался pid=%d", owner, found, err, third.pid)
	}
	if isProcessAlive(first.pid) || isProcessAlive(second.pid) || !isProcessAlive(third.pid) {
		t.Fatalf("после третьего запуска должен жить только pid=%d", third.pid)
	}
	t.Logf("restart_protocol endpoint=%s first_pid=%d second_pid=%d third_pid=%d executable=%s", address, first.pid, second.pid, third.pid, filepath.Base(owner.ExecutablePath))
	if err := terminateProcessTree(third.pid); err != nil {
		t.Fatalf("не удалось завершить третий экземпляр: %v", err)
	}
	waitForPIDGone(t, third.pid, 3*time.Second)
	if err := waitForPortRelease(address, 3*time.Second); err != nil {
		t.Fatalf("после третьего запуска порт не освобождён: %v", err)
	}
}

func TestAcquireRejectsNonExactLoopbackBeforeFirstListen(t *testing.T) {
	freeAddress := acquireFreeTCPAddress(t)
	_, port, err := net.SplitHostPort(freeAddress)
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{
		net.JoinHostPort("0.0.0.0", port),
		net.JoinHostPort("localhost", port),
		net.JoinHostPort("192.0.2.1", port),
		"127.0.0.1:0",
	} {
		t.Run(address, func(t *testing.T) {
			listener, _, err := acquireServiceListenerWithTimeout(address, "test-service-runtime.log", 250*time.Millisecond)
			if err == nil {
				listener.Close()
				t.Fatalf("небезопасный адрес %q был привязан", address)
			}
			if listener != nil {
				t.Fatalf("при pre-bind отказе для %q создан listener", address)
			}
		})
	}
}

func TestPortOwnerIdentityRejectsCreationTimeDrift(t *testing.T) {
	path, err := currentExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := exactListenerEndpoint("127.0.0.1:8765")
	if err != nil {
		t.Fatal(err)
	}
	left := portOwner{PID: os.Getpid(), ExecutablePath: path, CreationIdentity: "creation-a", Endpoint: endpoint}
	right := left
	right.CreationIdentity = "creation-b"
	if samePortOwnerIdentity(left, right) {
		t.Fatal("одинаковый PID с другой creation identity принят как тот же процесс")
	}
	right.CreationIdentity = left.CreationIdentity
	if !samePortOwnerIdentity(left, right) {
		t.Fatal("совпадающая полная identity не распознана")
	}
}

func TestCurrentProcessIdentityIncludesCreationIdentity(t *testing.T) {
	path, creationIdentity, err := processIdentityByPID(os.Getpid())
	if err != nil {
		t.Fatalf("identity текущего процесса недоступна: %v", err)
	}
	if strings.TrimSpace(path) == "" || strings.TrimSpace(creationIdentity) == "" {
		t.Fatalf("неполная identity: path=%q creation=%q", path, creationIdentity)
	}
}

func TestVerifiedTerminationBlocksCreationIdentityDriftWithoutKill(t *testing.T) {
	address := acquireFreeTCPAddress(t)
	_, pid := startS06Helper(t, address, "verified")
	owner, found, err := servicePortOwner(address)
	if err != nil || !found || owner.PID != pid {
		t.Fatalf("owner not found: owner=%+v found=%t err=%v", owner, found, err)
	}
	owner.CreationIdentity += "-drift"
	if err := terminateVerifiedProcessTree(owner); err == nil {
		t.Fatal("termination accepted drifted creation identity")
	}
	if !isProcessAlive(pid) {
		t.Fatalf("process pid=%d was killed after creation identity drift", pid)
	}
}

func TestVerifiedRestartTerminatesChildAndGrandchild(t *testing.T) {
	address := acquireFreeTCPAddress(t)
	tree := startS06FixHelper(t, address, "tree-root")
	if tree.childPID == 0 || tree.grandchildPID == 0 {
		t.Fatalf("helper не создал child/grandchild: %+v", tree)
	}
	t.Logf("process_tree_protocol endpoint=%s root_pid=%d child_pid=%d grandchild_pid=%d executable=%s", address, tree.pid, tree.childPID, tree.grandchildPID, filepath.Base(os.Args[0]))
	listener, replacedPID, err := acquireServiceListenerWithTimeout(address, "test-service-runtime.log", 4*time.Second)
	if err != nil {
		t.Fatalf("дерево доказанного OPIU не завершено: %v", err)
	}
	if replacedPID != tree.pid {
		listener.Close()
		t.Fatalf("завершён pid=%d вместо root=%d", replacedPID, tree.pid)
	}
	listener.Close()
	for _, pid := range []int{tree.pid, tree.childPID, tree.grandchildPID} {
		waitForPIDGone(t, pid, 4*time.Second)
	}
	if err := waitForPortRelease(address, 3*time.Second); err != nil {
		t.Fatalf("порт дерева не освобождён: %v", err)
	}
}

func TestCurrentServerExitsAndReleasesPortAfterResultOrInterfaceClose(t *testing.T) {
	for _, mode := range []string{"lifecycle-result", "lifecycle-ui-close"} {
		t.Run(mode, func(t *testing.T) {
			address := acquireFreeTCPAddress(t)
			helper := startS06FixHelper(t, address, mode)
			path := "/api/ui-session"
			if mode == "lifecycle-result" {
				path = "/complete"
			}
			response, err := http.Get("http://" + address + path)
			if err != nil {
				t.Fatalf("lifecycle request failed: %v", err)
			}
			if mode == "lifecycle-ui-close" {
				buffer := make([]byte, 1)
				_, _ = response.Body.Read(buffer)
			} else {
				_, _ = io.Copy(io.Discard, response.Body)
			}
			response.Body.Close()
			t.Logf("shutdown_protocol mode=%s endpoint=%s root_pid=%d child_pid=%d grandchild_pid=%d executable=%s", mode, address, helper.pid, helper.childPID, helper.grandchildPID, filepath.Base(os.Args[0]))
			waitForPIDGone(t, helper.pid, 4*time.Second)
			for _, pid := range []int{helper.childPID, helper.grandchildPID} {
				if pid != 0 {
					waitForPIDGone(t, pid, 4*time.Second)
				}
			}
			if err := waitForPortRelease(address, 3*time.Second); err != nil {
				t.Fatalf("после %s порт не свободен: %v", mode, err)
			}
		})
	}
}

func TestLifecycleDoesNotShutdownWhileRequestInFlight(t *testing.T) {
	state := newServiceLifecycleState()
	state.openUISession()
	state.closeUISession()
	state.beginRequest()
	shutdown := startLifecycleMonitorForTest(t, state, func() bool { return false }, func() bool { return false }, 30*time.Millisecond)
	assertNoLifecycleShutdown(t, shutdown, 100*time.Millisecond)
	state.endRequest()
	assertLifecycleShutdown(t, shutdown, "ui-session-closed", 300*time.Millisecond)
}

func TestTrackServiceActivityCoversEntireLongRequest(t *testing.T) {
	state := newServiceLifecycleState()
	started := make(chan struct{})
	release := make(chan struct{})
	handler := trackServiceActivity(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}), state)
	server := httptest.NewServer(handler)
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		response, err := http.Get(server.URL)
		if err == nil {
			response.Body.Close()
		}
		done <- err
	}()
	<-started
	if snapshot := state.snapshot(); snapshot.InFlight != 1 {
		t.Fatalf("long request not tracked in flight: %+v", snapshot)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	waitForLifecycleSnapshot(t, state, func(snapshot serviceLifecycleSnapshot) bool { return snapshot.InFlight == 0 })
}

func TestLifecycleDoesNotTreatRequestSilenceAsUIClosure(t *testing.T) {
	state := newServiceLifecycleState()
	shutdown := startLifecycleMonitorForTest(t, state, func() bool { return false }, func() bool { return false }, 20*time.Millisecond)
	assertNoLifecycleShutdown(t, shutdown, 120*time.Millisecond)
}

func TestLifecycleWaitsForActiveRunAfterUISessionClose(t *testing.T) {
	state := newServiceLifecycleState()
	state.openUISession()
	state.closeUISession()
	var active atomic.Bool
	active.Store(true)
	shutdown := startLifecycleMonitorForTest(t, state, func() bool { return false }, active.Load, 25*time.Millisecond)
	assertNoLifecycleShutdown(t, shutdown, 100*time.Millisecond)
	active.Store(false)
	assertLifecycleShutdown(t, shutdown, "ui-session-closed", 300*time.Millisecond)
}

func TestUISessionReconnectCancelsPendingShutdown(t *testing.T) {
	state := newServiceLifecycleState()
	state.openUISession()
	state.closeUISession()
	shutdown := startLifecycleMonitorForTest(t, state, func() bool { return false }, func() bool { return false }, 90*time.Millisecond)
	time.Sleep(35 * time.Millisecond)
	state.openUISession()
	assertNoLifecycleShutdown(t, shutdown, 120*time.Millisecond)
	state.closeUISession()
	assertLifecycleShutdown(t, shutdown, "ui-session-closed", 350*time.Millisecond)
}

func TestCompletedResultShutsDownOnlyAfterInFlightRequestEnds(t *testing.T) {
	state := newServiceLifecycleState()
	state.beginRequest()
	shutdown := startLifecycleMonitorForTest(t, state, func() bool { return true }, func() bool { return false }, 25*time.Millisecond)
	assertNoLifecycleShutdown(t, shutdown, 100*time.Millisecond)
	state.endRequest()
	assertLifecycleShutdown(t, shutdown, "result-completed", 300*time.Millisecond)
}

func TestUISessionEndpointTracksOpenAndClose(t *testing.T) {
	state := newServiceLifecycleState()
	server := httptest.NewServer(withUISessionEndpoint(http.NotFoundHandler(), state))
	defer server.Close()
	requestContext, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, server.URL+"/api/ui-session", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("unexpected content type %q", response.Header.Get("Content-Type"))
	}
	waitForLifecycleSnapshot(t, state, func(snapshot serviceLifecycleSnapshot) bool { return snapshot.UISessions == 1 })
	cancel()
	response.Body.Close()
	waitForLifecycleSnapshot(t, state, func(snapshot serviceLifecycleSnapshot) bool {
		return snapshot.UISessionSeen && snapshot.UISessions == 0
	})
}

func TestWebAppMaintainsUISessionUntilPageHide(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("web", "app.js"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, `new EventSource("/api/ui-session")`) {
		t.Fatal("web app does not open the UI session stream")
	}
	if !strings.Contains(text, `window.addEventListener("pagehide", () => uiSession.close(), { once: true })`) {
		t.Fatal("web app does not close the UI session on pagehide")
	}
}

func startLifecycleMonitorForTest(t *testing.T, state *serviceLifecycleState, completed, active func() bool, reconnectGrace time.Duration) <-chan string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	shutdown := make(chan string, 1)
	go monitorServiceLifecycle(ctx, state, completed, active, 5*time.Millisecond, reconnectGrace, reconnectGrace, func(reason string) {
		shutdown <- reason
	})
	return shutdown
}

func assertNoLifecycleShutdown(t *testing.T, shutdown <-chan string, wait time.Duration) {
	t.Helper()
	select {
	case reason := <-shutdown:
		t.Fatalf("неожиданный shutdown: %s", reason)
	case <-time.After(wait):
	}
}

func assertLifecycleShutdown(t *testing.T, shutdown <-chan string, expected string, wait time.Duration) {
	t.Helper()
	select {
	case reason := <-shutdown:
		if reason != expected {
			t.Fatalf("shutdown reason=%q, want %q", reason, expected)
		}
	case <-time.After(wait):
		t.Fatalf("shutdown %q не наступил за %v", expected, wait)
	}
}

func waitForLifecycleSnapshot(t *testing.T, state *serviceLifecycleState, matches func(serviceLifecycleSnapshot) bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		if matches(state.snapshot()) {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("lifecycle state timeout: %+v", state.snapshot())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type s06FixHelperProcess struct {
	command       *exec.Cmd
	pid           int
	replacedPID   int
	childPID      int
	grandchildPID int
}

func startS06FixHelper(t *testing.T, address, mode string) s06FixHelperProcess {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestS06FixProcessHelper$")
	command.Env = append(os.Environ(), "OPIU_S06_FIX_ADDRESS="+address, "OPIU_S06_FIX_MODE="+mode)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	result := s06FixHelperProcess{command: command}
	readyLine := ""
	deadline := time.NewTimer(7 * time.Second)
	defer deadline.Stop()
	observed := make([]string, 0, 4)
	for readyLine == "" {
		select {
		case line, ok := <-lines:
			if !ok {
				_ = command.Wait()
				t.Fatalf("S06 helper %s завершился без готовности; stdout=%q", mode, strings.Join(observed, " | "))
			}
			observed = append(observed, line)
			if strings.HasPrefix(line, "S06_FIX_READY ") {
				readyLine = line
			}
		case <-deadline.C:
			_ = command.Process.Kill()
			_ = command.Wait()
			t.Fatalf("S06 helper %s не сообщил готовность; stdout=%q", mode, strings.Join(observed, " | "))
		}
	}
	if _, err := fmt.Sscanf(readyLine, "S06_FIX_READY %d %d %d %d", &result.pid, &result.replacedPID, &result.childPID, &result.grandchildPID); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("неверный сигнал helper %s: %q (%v)", mode, readyLine, err)
	}
	t.Cleanup(func() {
		if isProcessAlive(result.pid) {
			_ = terminateProcessTree(result.pid)
		}
		_ = command.Wait()
	})
	return result
}

func waitForPIDGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for isProcessAlive(pid) {
		if !time.Now().Before(deadline) {
			t.Fatalf("pid=%d не завершился за %v", pid, timeout)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestS06FixProcessHelper(t *testing.T) {
	mode := os.Getenv("OPIU_S06_FIX_MODE")
	if mode == "" {
		return
	}
	address := os.Getenv("OPIU_S06_FIX_ADDRESS")
	switch mode {
	case "tree-child":
		grandchild := exec.Command(os.Args[0], "-test.run=^TestS06FixProcessHelper$")
		grandchild.Env = append(os.Environ(), "OPIU_S06_FIX_MODE=tree-grandchild")
		grandchild.Stderr = os.Stderr
		if err := grandchild.Start(); err != nil {
			t.Fatal(err)
		}
		fmt.Printf("S06_FIX_CHILD %d %d\n", os.Getpid(), grandchild.Process.Pid)
		for {
			time.Sleep(time.Hour)
		}
	case "tree-grandchild":
		for {
			time.Sleep(time.Hour)
		}
	case "tree-root":
		_, childPID, grandchildPID := startS06FixChildTree(t)
		serveS06FixHelper(t, address, 0, childPID, grandchildPID)
	case "launcher":
		listener, replacedPID, err := acquireServiceListenerWithTimeout(address, "test-service-runtime.log", 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		serveS06FixListener(t, listener, replacedPID, 0, 0)
	case "lifecycle-result", "lifecycle-ui-close":
		serveS06LifecycleHelper(t, address, mode)
	default:
		t.Fatalf("unknown helper mode %q", mode)
	}
}

func serveS06FixHelper(t *testing.T, address string, replacedPID, childPID, grandchildPID int) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	serveS06FixListener(t, listener, replacedPID, childPID, grandchildPID)
}

func serveS06FixListener(t *testing.T, listener net.Listener, replacedPID, childPID, grandchildPID int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, strictOPIUHealthJSON)
	})
	fmt.Printf("S06_FIX_READY %d %d %d %d\n", os.Getpid(), replacedPID, childPID, grandchildPID)
	if err := http.Serve(listener, mux); err != nil && !strings.Contains(err.Error(), "closed") {
		t.Fatal(err)
	}
}

func serveS06LifecycleHelper(t *testing.T, address, mode string) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	lifecycleState := newServiceLifecycleState()
	var completed atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, strictOPIUHealthJSON)
	})
	mux.HandleFunc("/complete", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "result-ready")
		completed.Store(true)
	})
	server := &http.Server{Handler: withUISessionEndpoint(trackServiceActivity(mux, lifecycleState), lifecycleState)}
	var childCommand *exec.Cmd
	childPID, grandchildPID := 0, 0
	if mode == "lifecycle-result" {
		childCommand, childPID, grandchildPID = startS06FixChildTree(t)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go monitorServiceLifecycle(ctx, lifecycleState, completed.Load, func() bool { return false }, 15*time.Millisecond, 80*time.Millisecond, 150*time.Millisecond, func(string) {
		shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), time.Second)
		defer shutdownCancel()
		_ = server.Shutdown(shutdownContext)
	})
	fmt.Printf("S06_FIX_READY %d 0 %d %d\n", os.Getpid(), childPID, grandchildPID)
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
	if err := terminateProcessDescendants(os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if childCommand != nil {
		_ = childCommand.Wait()
	}
}

func startS06FixChildTree(t *testing.T) (*exec.Cmd, int, int) {
	child := exec.Command(os.Args[0], "-test.run=^TestS06FixProcessHelper$")
	child.Env = append(os.Environ(), "OPIU_S06_FIX_MODE=tree-child")
	childOutput, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(childOutput)
	if !scanner.Scan() {
		t.Fatal("child helper не сообщил grandchild")
	}
	var childPID, grandchildPID int
	if _, err := fmt.Sscanf(scanner.Text(), "S06_FIX_CHILD %d %d", &childPID, &grandchildPID); err != nil {
		t.Fatal(err)
	}
	return child, childPID, grandchildPID
}
