package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUI013CompletedResultKeepsServiceAliveWhileUISessionActive(t *testing.T) {
	state := newServiceLifecycleState()
	state.openUISession()

	const resultGrace = 30 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	shutdown := make(chan string, 1)
	startedAt := time.Now()
	go monitorServiceLifecycle(
		ctx,
		state,
		func() bool { return true },
		func() bool { return false },
		5*time.Millisecond,
		resultGrace,
		resultGrace,
		func(reason string) { shutdown <- reason },
	)

	wait := 3 * resultGrace
	select {
	case reason := <-shutdown:
		t.Fatalf(
			"UI-013 RED: shutdown(%q) requested after %v despite active UI snapshot %+v; service must remain alive for at least %v",
			reason,
			time.Since(startedAt),
			state.snapshot(),
			wait,
		)
	case <-time.After(wait):
	}
}

func TestUI013CompletedResultPreservesReconnectGrace(t *testing.T) {
	state := newServiceLifecycleState()
	state.openUISession()

	const resultGrace = 20 * time.Millisecond
	const reconnectGrace = 80 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	shutdown := make(chan string, 1)
	go monitorServiceLifecycle(
		ctx,
		state,
		func() bool { return true },
		func() bool { return false },
		5*time.Millisecond,
		resultGrace,
		reconnectGrace,
		func(reason string) { shutdown <- reason },
	)

	state.closeUISession()
	time.Sleep(30 * time.Millisecond)
	state.openUISession()
	assertNoLifecycleShutdown(t, shutdown, reconnectGrace+resultGrace)
	state.closeUISession()
	assertLifecycleShutdown(t, shutdown, "ui-session-closed", 4*reconnectGrace)
}

func TestUI013VerifiedResultDownloadsFinishBeforeShutdownAndPortRelease(t *testing.T) {
	fixture := newUI012ResultFixture(t, "ui013_download_lifecycle", true)
	r005Dir := filepath.Join(fixture.runDir, "r005")
	bindingSHA, err := validateStructuralControlInventoryForAnchor(r005Dir, fixture.run, fixture.context)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.AnchorStructuralControlInventory(fixture.run.ID, bindingSHA); err != nil {
		t.Fatal(err)
	}

	state := newServiceLifecycleState()
	state.openUISession()
	var gatedDownloadName string
	downloadStarted := make(chan struct{})
	releaseDownload := make(chan struct{})
	var gateOnce sync.Once
	application := fixture.server.Handler()
	gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gatedDownloadName != "" && r.URL.Path == "/api/runs/"+fixture.run.ID+"/result/r001/file" && r.URL.Query().Get("path") == gatedDownloadName {
			gateOnce.Do(func() { close(downloadStarted) })
			<-releaseDownload
		}
		application.ServeHTTP(w, r)
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	httpServer := &http.Server{Handler: withUISessionEndpoint(trackServiceActivity(gated, state), state)}
	serveDone := make(chan error, 1)
	go func() {
		err := httpServer.Serve(listener)
		if err == http.ErrServerClosed {
			err = nil
		}
		serveDone <- err
	}()
	t.Cleanup(func() {
		_ = httpServer.Close()
	})

	const resultGrace = 25 * time.Millisecond
	const reconnectGrace = 40 * time.Millisecond
	lifecycleContext, stopLifecycle := context.WithCancel(context.Background())
	t.Cleanup(stopLifecycle)
	shutdown := make(chan string, 1)
	go monitorServiceLifecycle(
		lifecycleContext,
		state,
		func() bool { return true },
		func() bool { return false },
		5*time.Millisecond,
		resultGrace,
		reconnectGrace,
		func(reason string) {
			shutdown <- reason
			shutdownContext, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = httpServer.Shutdown(shutdownContext)
		},
	)

	client := &http.Client{Timeout: 10 * time.Second}
	baseURL := "http://" + address
	get := func(path string) []byte {
		t.Helper()
		response, err := client.Get(baseURL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%s", path, response.StatusCode, body)
		}
		return body
	}

	health := string(get("/api/health"))
	if !strings.Contains(health, `"mode":"REPORT_ONLY"`) || !strings.Contains(health, `"rules_service":false`) || !strings.Contains(health, `"posting_rows":0`) {
		t.Fatalf("unsafe health response: %s", health)
	}
	bootstrap := string(get("/api/bootstrap"))
	if !strings.Contains(bootstrap, `"mode":"REPORT_ONLY"`) || !strings.Contains(bootstrap, `"posting_rows":0`) {
		t.Fatalf("unsafe bootstrap response: %s", bootstrap)
	}
	var terminal Run
	if err := json.Unmarshal(get("/api/runs/"+fixture.run.ID), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Status != RunCompletedReportOnly || terminal.Stage != "DONE" {
		t.Fatalf("terminal status regressed to %s/%s", terminal.Status, terminal.Stage)
	}

	var r005 runStageResult
	if err := json.Unmarshal(get("/api/runs/"+fixture.run.ID+"/result/r005"), &r005); err != nil {
		t.Fatal(err)
	}
	var r005Workbook resultFile
	for _, file := range r005.Files {
		if file.Name == "reconciliation.xlsx" {
			r005Workbook = file
			break
		}
	}
	if !r005.Ready || r005Workbook.URL == "" {
		t.Fatalf("verified R005 result unavailable: %+v", r005)
	}
	wantR005, err := os.ReadFile(filepath.Join(r005Dir, "reconciliation.xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	if downloaded := get(r005Workbook.URL); !bytes.Equal(downloaded, wantR005) {
		t.Fatal("R005.xlsx direct download differs from the verified physical artifact")
	}

	var r001 runStageResult
	if err := json.Unmarshal(get("/api/runs/"+fixture.run.ID+"/result/r001"), &r001); err != nil {
		t.Fatal(err)
	}
	var decisions, disputed resultFile
	for _, file := range r001.Files {
		switch {
		case file.Kind == "decisions":
			decisions = file
		case file.Kind == "disputed" && disputed.URL == "":
			disputed = file
		}
	}
	if !r001.Ready || r001.ArchiveURL == "" || decisions.URL == "" || disputed.URL == "" {
		t.Fatalf("verified R001 result unavailable: %+v", r001)
	}
	wantDecisions, err := os.ReadFile(filepath.Join(fixture.runDir, "r001", filepath.FromSlash(decisions.Name)))
	if err != nil {
		t.Fatal(err)
	}
	wantDisputed, err := os.ReadFile(filepath.Join(fixture.runDir, "r001", filepath.FromSlash(disputed.Name)))
	if err != nil {
		t.Fatal(err)
	}
	if downloaded := get(decisions.URL); !bytes.Equal(downloaded, wantDecisions) {
		t.Fatal("decisions workbook direct download differs from the verified physical artifact")
	}
	if downloaded := get(disputed.URL); !bytes.Equal(downloaded, wantDisputed) {
		t.Fatal("SPORNO workbook direct download differs from the verified physical artifact")
	}

	archiveBytes := get(r001.ArchiveURL)
	archive, err := zip.NewReader(bytes.NewReader(archiveBytes), int64(len(archiveBytes)))
	if err != nil {
		t.Fatal(err)
	}
	wantArchiveEntries := map[string][]byte{decisions.Name: wantDecisions, disputed.Name: wantDisputed}
	for _, entry := range archive.File {
		want, ok := wantArchiveEntries[filepath.ToSlash(entry.Name)]
		if !ok {
			continue
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		actual, readErr := io.ReadAll(reader)
		reader.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !bytes.Equal(actual, want) {
			t.Fatalf("archive entry %q differs from physical artifact", entry.Name)
		}
		delete(wantArchiveEntries, filepath.ToSlash(entry.Name))
	}
	if len(wantArchiveEntries) != 0 {
		t.Fatalf("archive omitted verified owner artifacts: %v", wantArchiveEntries)
	}

	assertNoLifecycleShutdown(t, shutdown, 3*resultGrace)
	if response, err := client.Get(baseURL + "/api/health"); err != nil || response.StatusCode != http.StatusOK {
		if response != nil {
			response.Body.Close()
		}
		t.Fatalf("active UI lost health after completed result: status=%v err=%v", response, err)
	} else {
		response.Body.Close()
	}

	gatedDownloadName = decisions.Name
	type downloadResult struct {
		body []byte
		err  error
	}
	downloadDone := make(chan downloadResult, 1)
	go func() {
		response, err := client.Get(baseURL + decisions.URL)
		if err != nil {
			downloadDone <- downloadResult{err: err}
			return
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK && readErr == nil {
			readErr = fmt.Errorf("download status=%d", response.StatusCode)
		}
		downloadDone <- downloadResult{body: body, err: readErr}
	}()
	select {
	case <-downloadStarted:
	case <-time.After(time.Second):
		t.Fatal("verified direct download did not enter the in-flight gate")
	}
	waitForLifecycleSnapshot(t, state, func(snapshot serviceLifecycleSnapshot) bool { return snapshot.InFlight == 1 })
	state.closeUISession()
	assertNoLifecycleShutdown(t, shutdown, 2*reconnectGrace)
	close(releaseDownload)
	download := <-downloadDone
	if download.err != nil {
		t.Fatal(download.err)
	}
	if !bytes.Equal(download.body, wantDecisions) {
		t.Fatal("in-flight verified download did not complete byte-identically")
	}
	select {
	case reason := <-shutdown:
		t.Fatalf("shutdown %q raced ahead of completed download observation", reason)
	default:
	}
	assertLifecycleShutdown(t, shutdown, "ui-session-closed", 5*reconnectGrace)
	if err := <-serveDone; err != nil {
		t.Fatal(err)
	}
	if err := waitForPortRelease(address, time.Second); err != nil {
		t.Fatal(err)
	}
	restarted, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("immediate restart could not reacquire released port: %v", err)
	}
	restarted.Close()
}

func TestSecondLaunchOpensVerifiedRunningService(t *testing.T) {
	running := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok","service":"OPIU_STABLE","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false,"live_1c_allowed":false}}`)
	}))
	defer running.Close()

	address := running.Listener.Addr().String()
	duplicate, err := net.Listen("tcp", address)
	if err == nil {
		duplicate.Close()
		t.Fatal("reproduction failed: second listener unexpectedly acquired the occupied address")
	}

	var opened string
	serviceURL, handled := openVerifiedExistingService(address, false, running.Client(), func(value string) error {
		opened = value
		return nil
	})
	if !handled {
		t.Fatal("verified running OPIU was not handled as a second launch")
	}
	if opened != serviceURL || serviceURL != running.URL+"/" {
		t.Fatalf("opened URL = %q, service URL = %q, want %q", opened, serviceURL, running.URL+"/")
	}
}

func TestSecondLaunchNoOpenDoesNotDispatchBrowser(t *testing.T) {
	running := verifiedExistingServiceFixture(t)
	defer running.Close()

	opened := false
	_, handled := openVerifiedExistingService(running.Listener.Addr().String(), true, running.Client(), func(string) error {
		opened = true
		return nil
	})
	if !handled {
		t.Fatal("verified running OPIU was not handled with --no-open")
	}
	if opened {
		t.Fatal("browser was dispatched despite --no-open")
	}
}

func TestOccupiedPortWithForeignOrUnsafeServiceRemainsBlocked(t *testing.T) {
	for name, body := range map[string]string{
		"foreign": `{"status":"ok","service":"OTHER","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false,"live_1c_allowed":false}}`,
		"unsafe":  `{"status":"ok","service":"OPIU_STABLE","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":1,"ready_to_upload":false,"release_allowed":false,"live_1c_allowed":false}}`,
	} {
		t.Run(name, func(t *testing.T) {
			running := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, body)
			}))
			defer running.Close()

			opened := false
			if _, handled := openVerifiedExistingService(running.Listener.Addr().String(), false, running.Client(), func(string) error {
				opened = true
				return nil
			}); handled {
				t.Fatal("unverified listener was accepted as OPIU_STABLE")
			}
			if opened {
				t.Fatal("browser was opened for an unverified listener")
			}
		})
	}
}

func TestAcquireServiceListenerKillsVerifiedOPIUAndStartsNew(t *testing.T) {
	helperAddress := acquireFreeTCPAddress(t)

	command := exec.Command(os.Args[0], "-test.run=^TestS06ServicePortOwnerHelper$")
	command.Env = append(os.Environ(),
		"OPIU_S06_HELPER_ADDRESS="+helperAddress,
		"OPIU_S06_HELPER_SCENARIO=verified",
	)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("не удалось получить stdout helper: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("не удалось запустить helper: %v", err)
	}
	t.Cleanup(func() {
		if command.Process != nil && command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		_ = command.Process.Kill()
		t.Fatalf("helper не стартовал")
	}
	var helperPID int
	if _, scanErr := fmt.Sscanf(scanner.Text(), "S06_HELPER_READY %d", &helperPID); scanErr != nil {
		t.Fatalf("неверный сигнал готовности helper: %q", scanner.Text())
	}

	listener, previousPID, err := acquireServiceListenerWithTimeout(helperAddress, "test-service-runtime.log", 2*time.Second)
	if err != nil {
		t.Fatalf("ожидался перезапуск: %v", err)
	}
	defer listener.Close()
	if previousPID != helperPID {
		t.Fatalf("ожидался старый pid=%d, получен pid=%d", helperPID, previousPID)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		if !isProcessAlive(previousPID) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("helper-процесс pid=%d не завершился", previousPID)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestAcquireServiceListenerBlocksForeignOwner(t *testing.T) {
	helperAddress := acquireFreeTCPAddress(t)

	command := exec.Command(os.Args[0], "-test.run=^TestS06ServicePortOwnerHelper$")
	command.Env = append(os.Environ(),
		"OPIU_S06_HELPER_ADDRESS="+helperAddress,
		"OPIU_S06_HELPER_SCENARIO=foreign",
	)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("не удалось получить stdout helper: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("не удалось запустить helper: %v", err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		_ = command.Process.Kill()
		t.Fatalf("foreign helper не стартовал")
	}
	t.Cleanup(func() {
		if command.Process != nil && command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	listener, previousPID, err := acquireServiceListenerWithTimeout(helperAddress, "test-service-runtime.log", 1*time.Second)
	if err == nil {
		listener.Close()
		t.Fatalf("ожидалась блокировка запуска по foreign-сценарию")
	}
	if previousPID == 0 {
		t.Fatalf("ожидался pid чужого процесса для диагностики")
	}
	if !isProcessAlive(previousPID) {
		t.Fatalf("чужой процесс pid=%d был завершён", previousPID)
	}
}

func TestExecutableIdentityRequiresSamePhysicalFile(t *testing.T) {
	currentPath, err := currentExecutablePath()
	if err != nil {
		t.Fatalf("не удалось определить текущий executable: %v", err)
	}
	if !sameExecutableFile(currentPath, currentPath) {
		t.Fatal("один и тот же executable не распознан")
	}
	foreignPath := t.TempDir() + string(os.PathSeparator) + "foreign.exe"
	if err := os.WriteFile(foreignPath, []byte("not-opiu"), 0o600); err != nil {
		t.Fatalf("не удалось создать foreign fixture: %v", err)
	}
	if sameExecutableFile(currentPath, foreignPath) {
		t.Fatal("чужой физический файл принят за текущий OPIU")
	}
}

func TestS06ServicePortOwnerHelper(t *testing.T) {
	helperAddress := os.Getenv("OPIU_S06_HELPER_ADDRESS")
	if helperAddress == "" {
		return
	}
	scenario := os.Getenv("OPIU_S06_HELPER_SCENARIO")
	mux := http.NewServeMux()
	switch scenario {
	case "verified":
		mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ok","service":"OPIU_STABLE","implementation":"NEW_COMPATIBLE_IMPLEMENTATION","safety":{"mode":"REPORT_ONLY","posting_rows":0,"ready_to_upload":false,"release_allowed":false,"live_1c_allowed":false}}`)
		})
	default:
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			http.NotFound(w, r)
		})
	}
	server := &http.Server{Handler: mux}
	listener, err := net.Listen("tcp", helperAddress)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		_ = server.Serve(listener)
	}()
	fmt.Printf("S06_HELPER_READY %d\n", os.Getpid())
	select {}
}

func acquireFreeTCPAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("не удалось получить свободный порт: %v", err)
	}
	defer listener.Close()
	return listener.Addr().String()
}

func startS06Helper(t *testing.T, helperAddress, scenario string) (*exec.Cmd, int) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestS06ServicePortOwnerHelper$")
	command.Env = append(os.Environ(),
		"OPIU_S06_HELPER_ADDRESS="+helperAddress,
		"OPIU_S06_HELPER_SCENARIO="+scenario,
	)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatalf("не удалось получить stdout helper: %v", err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatalf("не удалось запустить helper: %v", err)
	}
	t.Cleanup(func() {
		if command.Process != nil && command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		_ = command.Process.Kill()
		t.Fatalf("helper не стартовал")
	}
	var helperPID int
	if _, scanErr := fmt.Sscanf(scanner.Text(), "S06_HELPER_READY %d", &helperPID); scanErr != nil {
		t.Fatalf("неверный сигнал готовности helper: %q", scanner.Text())
	}
	return command, helperPID
}

func verifiedExistingServiceFixture(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, strictOPIUHealthJSON)
	}))
}
