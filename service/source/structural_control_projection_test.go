package main

import (
	"net/http"
	"testing"
	"time"
)

func TestStructuralControlProjectionKeepsRecentAndAllActiveRuns(t *testing.T) {
	runs := make([]Run, structuralControlRecentProjectionLimit+4)
	for index := range runs {
		runs[index] = Run{ID: "run-" + time.Unix(int64(index), 0).Format("150405"), Status: RunCompletedReportOnly}
	}
	runs[len(runs)-1].Status = RunRunning

	selected := structuralControlProjectionRunIDs(runs, "")
	for index, run := range runs {
		want := index < structuralControlRecentProjectionLimit || run.Status == RunRunning
		if selected[run.ID] != want {
			t.Fatalf("run %s selected=%v want=%v", run.ID, selected[run.ID], want)
		}
	}
}

func TestStructuralControlProjectionExactRunIgnoresHistoryWindow(t *testing.T) {
	runs := []Run{{ID: "new", Status: RunCompletedReportOnly}, {ID: "old", Status: RunCompletedReportOnly}}
	selected := structuralControlProjectionRunIDs(runs, "old")
	if len(selected) != 1 || !selected["old"] || selected["new"] {
		t.Fatalf("exact projection selected %#v", selected)
	}
}

func TestHistoricalStructuralControlProjectionIsDeferredButExactRunRemainsComplete(t *testing.T) {
	context := newStructuralSourceTestContext(t)
	version := fixedStructuralSourceVersion(t, context)
	baseTime := time.Now().UTC().Add(time.Hour)
	for index := 0; index < structuralControlRecentProjectionLimit; index++ {
		run, err := context.store.CreateRun(context.contextID)
		if err != nil {
			t.Fatal(err)
		}
		finishedAt := baseTime.Add(time.Duration(index) * time.Second)
		run.StartedAt = finishedAt
		run.FinishedAt = &finishedAt
		run.Status = RunCompletedReportOnly
		run.Stage = "DONE"
		if err := context.store.UpdateRun(run); err != nil {
			t.Fatal(err)
		}
	}

	status, payload, raw := structuralSourceRequest(t, context.server, http.MethodGet, "/api/bootstrap", nil)
	if status != http.StatusOK {
		t.Fatalf("bootstrap failed: status=%d body=%s", status, raw)
	}
	found := false
	for _, value := range structuralSourceSlice(payload["runs"]) {
		run := structuralSourceMap(value)
		if structuralSourceString(run["id"]) != context.runID {
			continue
		}
		found = true
		if run["has_structural_inventory"] != true || run["structural_control_sets"] != nil {
			t.Fatalf("historical projection was not deferred safely: %#v", run)
		}
	}
	if !found {
		t.Fatal("historical run disappeared from bootstrap")
	}

	status, payload, raw = structuralSourceRequest(t, context.server, http.MethodGet, "/api/runs/"+context.runID, nil)
	if status != http.StatusOK {
		t.Fatalf("exact historical run failed: status=%d body=%s", status, raw)
	}
	assertFixedStructuralRunReference(t, "/api/runs/{id}", []any{payload}, raw, version, context.inventoryID)
}
