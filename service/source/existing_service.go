package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const existingServiceHealthLimit = 64 * 1024

type existingServiceHealth struct {
	Status         string      `json:"status"`
	Service        string      `json:"service"`
	Implementation string      `json:"implementation"`
	Safety         SafetyState `json:"safety"`
}

// openVerifiedExistingService handles a second launch only when the occupied
// loopback address proves that it belongs to this exact report-only service.
// A foreign or unsafe listener remains a startup error in main.
func openVerifiedExistingService(address string, noOpen bool, client *http.Client, opener func(string) error) (string, bool) {
	serviceURL, ok := loopbackServiceURL(address)
	if !ok {
		return "", false
	}
	if client == nil {
		client = &http.Client{
			Timeout: 700 * time.Millisecond,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	response, err := client.Get(serviceURL + "api/health")
	if err != nil {
		return "", false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", false
	}
	var health existingServiceHealth
	decoder := json.NewDecoder(io.LimitReader(response.Body, existingServiceHealthLimit))
	if err := decoder.Decode(&health); err != nil {
		return "", false
	}
	if health.Status != "ok" || health.Service != "OPIU_STABLE" ||
		health.Implementation != "NEW_COMPATIBLE_IMPLEMENTATION" ||
		health.Safety != reportOnlySafety() {
		return "", false
	}
	if !noOpen && opener != nil {
		// The running service is healthy even when Windows cannot dispatch the
		// default browser. Keep the second launch non-fatal in that case.
		_ = opener(serviceURL)
	}
	return serviceURL, true
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
