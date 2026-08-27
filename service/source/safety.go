package main

import (
	"errors"
	"os"
	"strings"
)

// SafetyState is immutable for the stabilization service. It is deliberately
// returned by the public API so that UI and tests can verify the fail-closed
// operating mode without exposing local paths, hashes, or credentials.
type SafetyState struct {
	Mode           string `json:"mode"`
	PostingRows    int    `json:"posting_rows"`
	ReadyToUpload  bool   `json:"ready_to_upload"`
	ReleaseAllowed bool   `json:"release_allowed"`
	Live1CAllowed  bool   `json:"live_1c_allowed"`
}

func reportOnlySafety() SafetyState {
	return SafetyState{
		Mode:           "REPORT_ONLY",
		PostingRows:    0,
		ReadyToUpload:  false,
		ReleaseAllowed: false,
		Live1CAllowed:  false,
	}
}

func enforceSafetyEnvironment() error {
	for _, name := range []string{
		"OPIU_ALLOW_LIVE_1C",
		"OPIU_READY_TO_UPLOAD",
		"OPIU_RELEASE_ALLOWED",
		"OPIU_ENABLE_POSTING",
	} {
		value := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
		if value == "1" || value == "true" || value == "yes" || value == "on" {
			return errors.New("unsafe execution authority is forbidden in OPIU_STABLE")
		}
	}
	return nil
}
