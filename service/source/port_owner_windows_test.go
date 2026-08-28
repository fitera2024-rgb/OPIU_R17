//go:build windows

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestWINPROC001TerminationOrderRootFirstThenDeepestDescendants(t *testing.T) {
	entries := []processSnapshotEntry{
		{PID: 10, ParentPID: 1},
		{PID: 12, ParentPID: 10},
		{PID: 11, ParentPID: 10},
		{PID: 14, ParentPID: 12},
		{PID: 13, ParentPID: 11},
		{PID: 15, ParentPID: 13},
		{PID: 99, ParentPID: 1},
	}
	withRoot, err := processTerminationOrderFromEntries(10, entries, true)
	if err != nil {
		t.Fatal(err)
	}
	if want := []int{10, 15, 13, 14, 11, 12}; !reflect.DeepEqual(withRoot, want) {
		t.Fatalf("termination order=%v, want=%v", withRoot, want)
	}
	withoutRoot, err := processTerminationOrderFromEntries(10, entries, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := []int{15, 13, 14, 11, 12}; !reflect.DeepEqual(withoutRoot, want) {
		t.Fatalf("descendant order=%v, want=%v", withoutRoot, want)
	}
}

func TestWINPROC001LateChildClosureAndCreationLineage(t *testing.T) {
	known := map[int]openedTerminationTarget{
		10: {PID: 10, Depth: 0, CreationValue: 100},
		11: {PID: 11, ParentPID: 10, Depth: 1, CreationValue: 110},
	}
	entries := []processSnapshotEntry{
		{PID: 11, ParentPID: 10},
		{PID: 12, ParentPID: 10},
		{PID: 13, ParentPID: 12},
		{PID: 99, ParentPID: 1},
	}
	late, err := lateProcessTreeNodes(entries, known)
	if err != nil {
		t.Fatal(err)
	}
	if want := []processTreeNode{{PID: 13, ParentPID: 12, Depth: 2}, {PID: 12, ParentPID: 10, Depth: 1}}; !reflect.DeepEqual(late, want) {
		t.Fatalf("late closure=%+v, want=%+v", late, want)
	}
	combined := map[int]openedTerminationTarget{
		10: known[10],
		12: {PID: 12, ParentPID: 10, CreationValue: 99},
	}
	if err := validateTerminationLineage(10, []openedTerminationTarget{combined[12]}, combined); err == nil || !strings.Contains(err.Error(), "predates") {
		t.Fatalf("older child creation was not rejected: %v", err)
	}
}

func TestWINPROC001SecondSnapshotFindsLateChild(t *testing.T) {
	savedSnapshot := callSnapshotProcessEntries
	t.Cleanup(func() { callSnapshotProcessEntries = savedSnapshot })
	calls := 0
	callSnapshotProcessEntries = func() ([]processSnapshotEntry, error) {
		calls++
		if calls == 1 {
			return []processSnapshotEntry{{PID: 10, ParentPID: 1}}, nil
		}
		return []processSnapshotEntry{{PID: 10, ParentPID: 1}, {PID: 11, ParentPID: 10}}, nil
	}
	initialEntries, err := callSnapshotProcessEntries()
	if err != nil {
		t.Fatal(err)
	}
	initial, err := processTerminationPlanFromEntries(10, initialEntries, true)
	if err != nil || len(initial) != 1 || initial[0].PID != 10 {
		t.Fatalf("initial snapshot=%+v err=%v", initial, err)
	}
	late, err := snapshotLateProcessTreeNodes(map[int]openedTerminationTarget{10: {PID: 10, Depth: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || !reflect.DeepEqual(late, []processTreeNode{{PID: 11, ParentPID: 10, Depth: 1}}) {
		t.Fatalf("second snapshot calls=%d late=%+v", calls, late)
	}
}

func TestWINPROC001AccessDeniedAcceptedOnlyForSignaledHeldHandle(t *testing.T) {
	savedWait := callWaitForSingleObjectProcedure
	savedTerminate := callTerminateProcessProcedure
	t.Cleanup(func() {
		callWaitForSingleObjectProcedure = savedWait
		callTerminateProcessProcedure = savedTerminate
	})
	targets := []openedTerminationTarget{{PID: 42, Handle: 99}}
	waits := 0
	callWaitForSingleObjectProcedure = func(...uintptr) (uintptr, uintptr, error) {
		waits++
		if waits == 1 {
			return waitTimeout, 0, nil
		}
		return waitObject0, 0, nil
	}
	callTerminateProcessProcedure = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, syscall.ERROR_ACCESS_DENIED
	}
	if err := requestExactTerminations(targets); err != nil {
		t.Fatalf("signaled held handle did not resolve access-denied race: %v", err)
	}

	waits = 0
	callWaitForSingleObjectProcedure = func(...uintptr) (uintptr, uintptr, error) {
		waits++
		return waitTimeout, 0, nil
	}
	if err := requestExactTerminations(targets); err == nil || !strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		t.Fatalf("live access-denied target was not rejected: %v", err)
	}
}

func TestWINPROC001PreflightAccessDeniedMakesZeroTerminateCalls(t *testing.T) {
	savedOpen := callOpenProcessProcedure
	savedTerminate := callTerminateProcessProcedure
	t.Cleanup(func() {
		callOpenProcessProcedure = savedOpen
		callTerminateProcessProcedure = savedTerminate
	})
	terminateCalls := 0
	callOpenProcessProcedure = func(...uintptr) (uintptr, uintptr, error) {
		return 0, 0, syscall.ERROR_ACCESS_DENIED
	}
	callTerminateProcessProcedure = func(...uintptr) (uintptr, uintptr, error) {
		terminateCalls++
		return 1, 0, nil
	}
	_, err := openAndValidateTerminationTargets(10, []processTreeNode{{PID: 10}}, nil, nil)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "access is denied") {
		t.Fatalf("preflight access denial was not returned: %v", err)
	}
	if terminateCalls != 0 {
		t.Fatalf("preflight failure made %d terminate calls", terminateCalls)
	}
}

func TestWINPROC001GlobalDeadlineIsSharedAndHandlesClose(t *testing.T) {
	savedWait := callWaitForSingleObjectProcedure
	savedClose := callCloseHandleProcedure
	savedNow := processTerminationNow
	savedUntil := processTerminationUntil
	t.Cleanup(func() {
		callWaitForSingleObjectProcedure = savedWait
		callCloseHandleProcedure = savedClose
		processTerminationNow = savedNow
		processTerminationUntil = savedUntil
	})
	current := time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC)
	deadline := current.Add(3 * time.Second)
	processTerminationNow = func() time.Time { return current }
	processTerminationUntil = func(target time.Time) time.Duration { return target.Sub(current) }
	callWaitForSingleObjectProcedure = func(...uintptr) (uintptr, uintptr, error) {
		current = current.Add(2 * time.Second)
		return waitObject0, 0, nil
	}
	targets := []openedTerminationTarget{{PID: 41, Handle: 91}, {PID: 42, Handle: 92}}
	if err := waitForExactTerminations(targets, deadline); err == nil || !strings.Contains(err.Error(), "global deadline") {
		t.Fatalf("per-process waits exceeded shared deadline without failure: %v", err)
	}
	closed := make([]uintptr, 0, 2)
	callCloseHandleProcedure = func(arguments ...uintptr) (uintptr, uintptr, error) {
		closed = append(closed, arguments[0])
		return 1, 0, nil
	}
	closeOpenedTerminationTargets(targets)
	if want := []uintptr{91, 92}; !reflect.DeepEqual(closed, want) {
		t.Fatalf("closed handles=%v, want=%v", closed, want)
	}
}

func TestWINPROC001TerminationOrderRejectsMissingRootAndCycle(t *testing.T) {
	if _, err := processTerminationOrderFromEntries(100, []processSnapshotEntry{{PID: 10, ParentPID: 1}}, true); err == nil || !strings.Contains(err.Error(), "absent") {
		t.Fatalf("missing root was not rejected: %v", err)
	}
	cycle := []processSnapshotEntry{
		{PID: 10, ParentPID: 11},
		{PID: 11, ParentPID: 10},
	}
	if _, err := processTerminationOrderFromEntries(10, cycle, true); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("cycle was not rejected: %v", err)
	}
}

func TestWINPROC001TerminatesExactSpawnedProcess(t *testing.T) {
	helper := startWINPROC001Helper(t)
	if err := terminateProcessTree(helper.pid); err != nil {
		t.Fatalf("exact helper pid=%d was not terminated: %v", helper.pid, err)
	}
	helper.waitForExit(t, 2*time.Second)
	if processRunningByExactHandle(helper.pid) {
		t.Fatalf("exact helper pid=%d is still alive", helper.pid)
	}
}

func TestWINPROC001IdentityMismatchFailsClosed(t *testing.T) {
	helper := startWINPROC001Helper(t)
	path, creationIdentity, err := processIdentityByPID(helper.pid)
	if err != nil {
		t.Fatal(err)
	}
	err = terminateProcessTreeWithExpectedIdentity(helper.pid, &expectedProcessIdentity{
		PID:              helper.pid,
		ExecutablePath:   path,
		CreationIdentity: creationIdentity + "-drift",
	})
	if err == nil || !strings.Contains(err.Error(), "identity mismatch") {
		t.Fatalf("drifted identity was not rejected: %v", err)
	}
	if !processRunningByExactHandle(helper.pid) {
		t.Fatalf("helper pid=%d was terminated after identity mismatch", helper.pid)
	}
}

func TestWINPROC001SleepHelper(t *testing.T) {
	if os.Getenv("OPIU_WINPROC001_HELPER") != "1" {
		return
	}
	fmt.Println("WINPROC001_READY")
	for {
		time.Sleep(time.Hour)
	}
}

type winproc001Helper struct {
	command *exec.Cmd
	pid     int
	done    <-chan struct{}
}

func startWINPROC001Helper(t *testing.T) winproc001Helper {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestWINPROC001SleepHelper$")
	command.Env = append(os.Environ(), "OPIU_WINPROC001_HELPER=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = command.Wait()
		close(done)
	}()
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
			return
		}
		ready <- ""
	}()
	select {
	case line := <-ready:
		if line != "WINPROC001_READY" {
			_ = command.Process.Kill()
			t.Fatalf("helper did not report readiness: %q", line)
		}
	case <-time.After(3 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("helper readiness timed out")
	}
	helper := winproc001Helper{command: command, pid: command.Process.Pid, done: done}
	t.Cleanup(func() {
		if processRunningByExactHandle(helper.pid) {
			_ = helper.command.Process.Kill()
		}
		select {
		case <-helper.done:
		case <-time.After(2 * time.Second):
			t.Errorf("helper pid=%d cleanup wait timed out", helper.pid)
		}
	})
	return helper
}

func (helper winproc001Helper) waitForExit(t *testing.T, timeout time.Duration) {
	t.Helper()
	select {
	case <-helper.done:
	case <-time.After(timeout):
		t.Fatalf("helper pid=%d did not exit in %v", helper.pid, timeout)
	}
}

func processRunningByExactHandle(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, _, _ := openProcessProcedure.Call(processQueryLimitedInformation|processSynchronize, 0, uintptr(uint32(pid)))
	if handle == 0 {
		return false
	}
	defer closeHandleProcedure.Call(handle)
	state, _, _ := waitForSingleObjectProcedure.Call(handle, 0)
	return state == waitTimeout
}
