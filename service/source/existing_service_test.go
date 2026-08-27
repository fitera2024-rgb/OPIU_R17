package main

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"
)

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
