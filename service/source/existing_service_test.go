package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
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

func verifiedExistingServiceFixture(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, existingServiceHealth{
			Status: "ok", Service: "OPIU_STABLE", Implementation: "NEW_COMPATIBLE_IMPLEMENTATION", Safety: reportOnlySafety(),
		})
	}))
}
