package main

import "testing"

func TestReportOnlySafetyIsFailClosed(t *testing.T) {
	safety := reportOnlySafety()
	if safety.Mode != "REPORT_ONLY" {
		t.Fatalf("mode = %q", safety.Mode)
	}
	if safety.PostingRows != 0 || safety.ReadyToUpload || safety.ReleaseAllowed || safety.Live1CAllowed {
		t.Fatalf("unsafe state: %+v", safety)
	}
}

func TestUnsafeEnvironmentIsRejected(t *testing.T) {
	for _, variable := range []string{
		"OPIU_ALLOW_LIVE_1C",
		"OPIU_READY_TO_UPLOAD",
		"OPIU_RELEASE_ALLOWED",
		"OPIU_ENABLE_POSTING",
	} {
		t.Run(variable, func(t *testing.T) {
			t.Setenv(variable, "true")
			if err := enforceSafetyEnvironment(); err == nil {
				t.Fatal("unsafe authority was accepted")
			}
		})
	}
}
