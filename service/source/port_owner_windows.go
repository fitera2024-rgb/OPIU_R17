//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32ProcessDLL                 = syscall.NewLazyDLL("kernel32.dll")
	openProcessProcedure               = kernel32ProcessDLL.NewProc("OpenProcess")
	queryFullProcessImageNameProcedure = kernel32ProcessDLL.NewProc("QueryFullProcessImageNameW")
	getProcessTimesProcedure           = kernel32ProcessDLL.NewProc("GetProcessTimes")
	terminateProcessProcedure          = kernel32ProcessDLL.NewProc("TerminateProcess")
	waitForSingleObjectProcedure       = kernel32ProcessDLL.NewProc("WaitForSingleObject")
	closeHandleProcedure               = kernel32ProcessDLL.NewProc("CloseHandle")
	callOpenProcessProcedure           = openProcessProcedure.Call
	callQueryProcessImageProcedure     = queryFullProcessImageNameProcedure.Call
	callGetProcessTimesProcedure       = getProcessTimesProcedure.Call
	callTerminateProcessProcedure      = terminateProcessProcedure.Call
	callWaitForSingleObjectProcedure   = waitForSingleObjectProcedure.Call
	callCloseHandleProcedure           = closeHandleProcedure.Call
	callSnapshotProcessEntries         = snapshotProcessEntries
	processTerminationNow              = time.Now
	processTerminationUntil            = time.Until
)

const (
	processQueryLimitedInformation = 0x1000
	processTerminate               = 0x0001
	processSynchronize             = 0x00100000
	waitObject0                    = 0
	waitTimeout                    = 258
)

func processIDForEndpoint(endpoint listenerEndpoint) (int, error) {
	command := exec.Command("netstat", "-ano", "-n")
	output, err := command.Output()
	if err != nil {
		return 0, err
	}
	return processIDForEndpointFromNetstat(string(output), endpoint)
}

func processIDForEndpointFromNetstat(output string, endpoint listenerEndpoint) (int, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	foundPID := 0
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		if !strings.EqualFold(fields[3], "LISTENING") {
			continue
		}
		localEndpoint, ok := parseNetstatEndpoint(fields[1])
		if !ok || !sameListenerEndpoint(localEndpoint, endpoint) {
			continue
		}
		pid, parseErr := strconv.Atoi(fields[4])
		if parseErr == nil {
			if foundPID != 0 && foundPID != pid {
				return 0, fmt.Errorf("exact endpoint %s has multiple owner PIDs: %d and %d", endpoint.String(), foundPID, pid)
			}
			foundPID = pid
		}
	}
	return foundPID, scanner.Err()
}

func processIdentityByPID(pid int) (string, string, error) {
	if pid <= 0 {
		return "", "", errors.New("invalid pid")
	}
	handle, _, openErr := callOpenProcessProcedure(processQueryLimitedInformation, 0, uintptr(uint32(pid)))
	if handle == 0 {
		return "", "", windowsProcedureError("OpenProcess", openErr)
	}
	defer callCloseHandleProcedure(handle)
	return processIdentityFromHandle(handle)
}

func processIdentityFromHandle(handle uintptr) (string, string, error) {
	if handle == 0 {
		return "", "", errors.New("invalid process handle")
	}

	buffer := make([]uint16, 32768)
	bufferLength := uint32(len(buffer))
	result, _, queryErr := callQueryProcessImageProcedure(
		handle,
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&bufferLength)),
	)
	if result == 0 {
		return "", "", windowsProcedureError("QueryFullProcessImageNameW", queryErr)
	}
	if bufferLength == 0 {
		return "", "", errors.New("empty executable path")
	}
	var creationTime, exitTime, kernelTime, userTime syscall.Filetime
	result, _, timesErr := callGetProcessTimesProcedure(
		handle,
		uintptr(unsafe.Pointer(&creationTime)),
		uintptr(unsafe.Pointer(&exitTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if result == 0 {
		return "", "", windowsProcedureError("GetProcessTimes", timesErr)
	}
	creationIdentity := fmt.Sprintf("%08X%08X", creationTime.HighDateTime, creationTime.LowDateTime)
	return syscall.UTF16ToString(buffer[:bufferLength]), creationIdentity, nil
}

func windowsProcedureError(operation string, value error) error {
	if errno, ok := value.(syscall.Errno); ok && errno == 0 {
		return fmt.Errorf("%s failed", operation)
	}
	if value == nil {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s failed: %w", operation, value)
}

func parseNetstatEndpoint(address string) (listenerEndpoint, bool) {
	host, portString, err := net.SplitHostPort(address)
	if err != nil {
		return listenerEndpoint{}, false
	}
	port, err := strconv.Atoi(portString)
	if err != nil {
		return listenerEndpoint{}, false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return listenerEndpoint{}, false
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return listenerEndpoint{IP: append(net.IP(nil), ipv4...), Port: port, Network: "tcp4"}, true
	}
	return listenerEndpoint{IP: append(net.IP(nil), ip.To16()...), Port: port, Network: "tcp6"}, true
}

func terminateProcessTree(pid int) error {
	return terminateProcessTreeWithExpectedIdentity(pid, nil)
}

type expectedProcessIdentity struct {
	PID              int
	ExecutablePath   string
	CreationIdentity string
}

type processSnapshotEntry struct {
	PID       int
	ParentPID int
}

type processTreeNode struct {
	PID       int
	ParentPID int
	Depth     int
}

type openedTerminationTarget struct {
	PID              int
	ParentPID        int
	Depth            int
	Handle           uintptr
	ExecutablePath   string
	CreationIdentity string
	CreationValue    uint64
}

func terminateProcessTreeWithExpectedIdentity(pid int, expected *expectedProcessIdentity) error {
	return terminateProcessHierarchy(pid, expected, true)
}

func terminateProcessHierarchy(rootPID int, expected *expectedProcessIdentity, terminateRoot bool) error {
	if rootPID <= 0 {
		return errors.New("invalid pid")
	}
	if expected != nil {
		if expected.PID <= 0 || strings.TrimSpace(expected.ExecutablePath) == "" || strings.TrimSpace(expected.CreationIdentity) == "" {
			return errors.New("expected process identity is incomplete")
		}
		if rootPID != expected.PID {
			return fmt.Errorf("termination root pid=%d does not match expected pid=%d", rootPID, expected.PID)
		}
	}

	deadline := processTerminationNow().Add(3 * time.Second)
	entries, err := callSnapshotProcessEntries()
	if err != nil {
		return err
	}
	nodes, err := processTerminationPlanFromEntries(rootPID, entries, true)
	if err != nil {
		return err
	}
	known := make(map[int]openedTerminationTarget, len(nodes))
	allTargets := make([]openedTerminationTarget, 0, len(nodes))
	defer func() {
		closeOpenedTerminationTargets(allTargets)
	}()

	initialTargets, err := openAndValidateTerminationTargets(rootPID, nodes, expected, known)
	if err != nil {
		return err
	}
	allTargets = append(allTargets, initialTargets...)
	for _, target := range initialTargets {
		known[target.PID] = target
	}

	// Close the preflight snapshot race before the first mutation: after all
	// handles from one snapshot are bound, snapshot again and bind any late
	// descendants. No process is terminated until a complete pass adds none.
	for {
		if !processTerminationNow().Before(deadline) {
			return fmt.Errorf("process tree root pid=%d preflight did not reach closure before global deadline", rootPID)
		}
		lateNodes, err := snapshotLateProcessTreeNodes(known)
		if err != nil {
			return err
		}
		if len(lateNodes) == 0 {
			break
		}
		lateTargets, err := openAndValidateTerminationTargets(rootPID, lateNodes, nil, known)
		if err != nil {
			return err
		}
		allTargets = append(allTargets, lateTargets...)
		for _, target := range lateTargets {
			known[target.PID] = target
		}
	}
	toTerminate := terminationRequestOrder(rootPID, allTargets, terminateRoot)
	// The held, verified root handle is always first. Requesting its
	// termination before any child prevents the old service from spawning new
	// work while the already-bound descendant handles are drained.
	if err := requestExactTerminations(toTerminate); err != nil {
		return err
	}
	if err := waitForExactTerminations(toTerminate, deadline); err != nil {
		return err
	}

	// Re-snapshot until the descendant closure is empty. This catches children
	// created after the first Toolhelp snapshot but before root termination.
	for {
		if !processTerminationNow().Before(deadline) {
			return fmt.Errorf("process tree root pid=%d did not reach closure before global deadline", rootPID)
		}
		lateNodes, err := snapshotLateProcessTreeNodes(known)
		if err != nil {
			return err
		}
		if len(lateNodes) == 0 {
			return nil
		}
		lateTargets, err := openAndValidateTerminationTargets(rootPID, lateNodes, nil, known)
		if err != nil {
			return err
		}
		allTargets = append(allTargets, lateTargets...)
		for _, target := range lateTargets {
			known[target.PID] = target
		}
		if err := requestExactTerminations(lateTargets); err != nil {
			return err
		}
		if err := waitForExactTerminations(lateTargets, deadline); err != nil {
			return err
		}
	}
}

func terminationRequestOrder(rootPID int, targets []openedTerminationTarget, includeRoot bool) []openedTerminationTarget {
	result := make([]openedTerminationTarget, 0, len(targets))
	descendants := make([]openedTerminationTarget, 0, len(targets))
	for _, target := range targets {
		if target.PID == rootPID {
			if includeRoot {
				result = append(result, target)
			}
			continue
		}
		descendants = append(descendants, target)
	}
	sort.Slice(descendants, func(left, right int) bool {
		if descendants[left].Depth != descendants[right].Depth {
			return descendants[left].Depth > descendants[right].Depth
		}
		return descendants[left].PID < descendants[right].PID
	})
	return append(result, descendants...)
}

func closeOpenedTerminationTargets(targets []openedTerminationTarget) {
	for _, target := range targets {
		callCloseHandleProcedure(target.Handle)
	}
}

func openAndValidateTerminationTargets(rootPID int, nodes []processTreeNode, expected *expectedProcessIdentity, known map[int]openedTerminationTarget) ([]openedTerminationTarget, error) {
	targets := make([]openedTerminationTarget, 0, len(nodes))
	closeTargets := true
	defer func() {
		if closeTargets {
			closeOpenedTerminationTargets(targets)
		}
	}()
	for _, node := range nodes {
		handle, _, openErr := callOpenProcessProcedure(
			processTerminate|processQueryLimitedInformation|processSynchronize,
			0,
			uintptr(uint32(node.PID)),
		)
		if handle == 0 {
			return nil, fmt.Errorf("open exact process pid=%d for termination: %w", node.PID, windowsProcedureError("OpenProcess", openErr))
		}
		path, creationIdentity, identityErr := processIdentityFromHandle(handle)
		if identityErr != nil || strings.TrimSpace(path) == "" || strings.TrimSpace(creationIdentity) == "" {
			callCloseHandleProcedure(handle)
			return nil, fmt.Errorf("identify exact process pid=%d before termination: path=%q creation=%q err=%v", node.PID, path, creationIdentity, identityErr)
		}
		creationValue, parseErr := strconv.ParseUint(creationIdentity, 16, 64)
		if parseErr != nil {
			callCloseHandleProcedure(handle)
			return nil, fmt.Errorf("parse creation identity for exact process pid=%d: %w", node.PID, parseErr)
		}
		target := openedTerminationTarget{
			PID:              node.PID,
			ParentPID:        node.ParentPID,
			Depth:            node.Depth,
			Handle:           handle,
			ExecutablePath:   path,
			CreationIdentity: creationIdentity,
			CreationValue:    creationValue,
		}
		if expected != nil && node.PID == expected.PID {
			if creationIdentity != expected.CreationIdentity || !sameExecutableFile(path, expected.ExecutablePath) {
				callCloseHandleProcedure(handle)
				return nil, fmt.Errorf("exact root identity mismatch before termination: pid=%d creation=%q path=%q", node.PID, creationIdentity, path)
			}
		}
		targets = append(targets, target)
	}

	combined := make(map[int]openedTerminationTarget, len(known)+len(targets))
	for pid, target := range known {
		combined[pid] = target
	}
	for _, target := range targets {
		combined[target.PID] = target
	}
	if err := validateTerminationLineage(rootPID, targets, combined); err != nil {
		return nil, err
	}
	for _, target := range targets {
		path, creationIdentity, identityErr := processIdentityFromHandle(target.Handle)
		if identityErr != nil || creationIdentity != target.CreationIdentity || !sameExecutableFile(path, target.ExecutablePath) {
			return nil, fmt.Errorf("exact process identity drift before termination: pid=%d creation=%q path=%q err=%v", target.PID, creationIdentity, path, identityErr)
		}
	}
	closeTargets = false
	return targets, nil
}

func validateTerminationLineage(rootPID int, targets []openedTerminationTarget, combined map[int]openedTerminationTarget) error {
	for _, target := range targets {
		if target.PID == rootPID {
			continue
		}
		parent, ok := combined[target.ParentPID]
		if !ok {
			return fmt.Errorf("exact process pid=%d has unbound parent pid=%d", target.PID, target.ParentPID)
		}
		if target.CreationValue < parent.CreationValue {
			return fmt.Errorf("exact process pid=%d creation predates parent pid=%d", target.PID, target.ParentPID)
		}
	}
	return nil
}

func requestExactTerminations(targets []openedTerminationTarget) error {
	for _, target := range targets {
		state, _, stateErr := callWaitForSingleObjectProcedure(target.Handle, 0)
		switch state {
		case waitObject0:
			continue
		case waitTimeout:
			// The process is still alive and the handle identifies the exact
			// process object; no name-wide operation is used.
		default:
			return fmt.Errorf("check exact process pid=%d before termination: %w", target.PID, windowsProcedureError("WaitForSingleObject", stateErr))
		}
		result, _, terminateErr := callTerminateProcessProcedure(target.Handle, 1)
		if result == 0 {
			// ERROR_ACCESS_DENIED can mean that another actor completed the
			// termination between our state check and TerminateProcess. Accept
			// it only when this same held handle is now signaled.
			state, _, _ = callWaitForSingleObjectProcedure(target.Handle, 0)
			if state != waitObject0 {
				return fmt.Errorf("terminate exact process pid=%d: %w", target.PID, windowsProcedureError("TerminateProcess", terminateErr))
			}
		}
	}
	return nil
}

func waitForExactTerminations(targets []openedTerminationTarget, deadline time.Time) error {
	for _, target := range targets {
		remaining := processTerminationUntil(deadline)
		if remaining <= 0 {
			return fmt.Errorf("global process termination deadline elapsed before pid=%d exited", target.PID)
		}
		milliseconds := (remaining + time.Millisecond - 1) / time.Millisecond
		state, _, waitErr := callWaitForSingleObjectProcedure(target.Handle, uintptr(uint32(milliseconds)))
		switch state {
		case waitObject0:
			if processTerminationNow().After(deadline) {
				return fmt.Errorf("exact process pid=%d exited after global deadline", target.PID)
			}
			continue
		case waitTimeout:
			return fmt.Errorf("exact process pid=%d did not exit before global deadline", target.PID)
		default:
			return fmt.Errorf("wait for exact process pid=%d exit: %w", target.PID, windowsProcedureError("WaitForSingleObject", waitErr))
		}
	}
	return nil
}

func terminateVerifiedProcessTree(owner portOwner) error {
	if owner.PID <= 0 || strings.TrimSpace(owner.CreationIdentity) == "" {
		return errors.New("owner identity is incomplete")
	}
	confirmed, found, err := servicePortOwner(owner.Endpoint.Address())
	if err != nil || !found || !samePortOwnerIdentity(owner, confirmed) {
		return fmt.Errorf("owner identity drift before termination: found=%t err=%v", found, err)
	}
	handle, _, openErr := callOpenProcessProcedure(
		processQueryLimitedInformation|processSynchronize,
		0,
		uintptr(uint32(owner.PID)),
	)
	if handle == 0 {
		return windowsProcedureError("OpenProcess", openErr)
	}
	defer callCloseHandleProcedure(handle)
	path, creationIdentity, err := processIdentityFromHandle(handle)
	if err != nil || creationIdentity != owner.CreationIdentity || !sameExecutableFile(path, owner.ExecutablePath) {
		return fmt.Errorf("creation-bound owner identity drift before termination: creation=%q path=%q err=%v", creationIdentity, path, err)
	}
	confirmed, found, err = servicePortOwner(owner.Endpoint.Address())
	if err != nil || !found || !samePortOwnerIdentity(owner, confirmed) {
		return fmt.Errorf("endpoint owner identity drift immediately before termination: found=%t err=%v", found, err)
	}
	if err := terminateProcessTreeWithExpectedIdentity(owner.PID, &expectedProcessIdentity{
		PID:              owner.PID,
		ExecutablePath:   owner.ExecutablePath,
		CreationIdentity: owner.CreationIdentity,
	}); err != nil {
		return err
	}
	return nil
}

func terminateProcessDescendants(pid int) error {
	return terminateProcessHierarchy(pid, nil, false)
}

func processDescendants(pid int) ([]int, error) {
	return processTerminationOrder(pid, false)
}

func processTerminationOrder(pid int, includeRoot bool) ([]int, error) {
	if pid <= 0 {
		return nil, errors.New("invalid pid")
	}
	entries, err := callSnapshotProcessEntries()
	if err != nil {
		return nil, err
	}
	return processTerminationOrderFromEntries(pid, entries, includeRoot)
}

func snapshotProcessEntries() ([]processSnapshotEntry, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer syscall.CloseHandle(snapshot)
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	if err := syscall.Process32First(snapshot, &entry); err != nil {
		return nil, fmt.Errorf("Process32First: %w", err)
	}
	entries := make([]processSnapshotEntry, 0, 256)
	for {
		entries = append(entries, processSnapshotEntry{PID: int(entry.ProcessID), ParentPID: int(entry.ParentProcessID)})
		entry.Size = uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))
		if err := syscall.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, fmt.Errorf("Process32Next: %w", err)
		}
	}
	return entries, nil
}

func processTerminationOrderFromEntries(rootPID int, entries []processSnapshotEntry, includeRoot bool) ([]int, error) {
	nodes, err := processTerminationPlanFromEntries(rootPID, entries, includeRoot)
	if err != nil {
		return nil, err
	}
	result := make([]int, 0, len(nodes))
	for _, node := range nodes {
		result = append(result, node.PID)
	}
	return result, nil
}

func processTerminationPlanFromEntries(rootPID int, entries []processSnapshotEntry, includeRoot bool) ([]processTreeNode, error) {
	if rootPID <= 0 {
		return nil, errors.New("invalid pid")
	}
	present := make(map[int]bool, len(entries))
	childrenByParent := make(map[int][]int)
	for _, entry := range entries {
		if entry.PID <= 0 {
			continue
		}
		if present[entry.PID] {
			return nil, fmt.Errorf("duplicate pid=%d in process snapshot", entry.PID)
		}
		present[entry.PID] = true
		childrenByParent[entry.ParentPID] = append(childrenByParent[entry.ParentPID], entry.PID)
	}
	if !present[rootPID] {
		return nil, fmt.Errorf("root pid=%d is absent from process snapshot", rootPID)
	}
	for parentPID := range childrenByParent {
		sort.Ints(childrenByParent[parentPID])
	}
	nodes := make([]processTreeNode, 0)
	depthByPID := map[int]int{rootPID: 0}
	stack := []int{rootPID}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, childPID := range childrenByParent[current] {
			if childPID == rootPID {
				return nil, fmt.Errorf("process snapshot cycle reaches root pid=%d", rootPID)
			}
			if _, visited := depthByPID[childPID]; visited {
				return nil, fmt.Errorf("process snapshot repeats descendant pid=%d", childPID)
			}
			depthByPID[childPID] = depthByPID[current] + 1
			nodes = append(nodes, processTreeNode{PID: childPID, ParentPID: current, Depth: depthByPID[childPID]})
			stack = append(stack, childPID)
		}
	}
	sort.Slice(nodes, func(left, right int) bool {
		if nodes[left].Depth != nodes[right].Depth {
			return nodes[left].Depth > nodes[right].Depth
		}
		return nodes[left].PID < nodes[right].PID
	})
	if includeRoot {
		nodes = append([]processTreeNode{{PID: rootPID, Depth: 0}}, nodes...)
	}
	return nodes, nil
}

func lateProcessTreeNodes(entries []processSnapshotEntry, known map[int]openedTerminationTarget) ([]processTreeNode, error) {
	present := make(map[int]bool, len(entries))
	childrenByParent := make(map[int][]int)
	for _, entry := range entries {
		if entry.PID <= 0 {
			continue
		}
		if present[entry.PID] {
			return nil, fmt.Errorf("duplicate pid=%d in process snapshot", entry.PID)
		}
		present[entry.PID] = true
		childrenByParent[entry.ParentPID] = append(childrenByParent[entry.ParentPID], entry.PID)
	}
	anchors := make([]int, 0, len(known))
	depthByPID := make(map[int]int, len(known))
	for pid, target := range known {
		anchors = append(anchors, pid)
		depthByPID[pid] = target.Depth
	}
	sort.Ints(anchors)
	queue := append([]int(nil), anchors...)
	newNodes := make([]processTreeNode, 0)
	for len(queue) > 0 {
		parentPID := queue[0]
		queue = queue[1:]
		children := childrenByParent[parentPID]
		sort.Ints(children)
		for _, childPID := range children {
			if _, alreadyKnown := known[childPID]; alreadyKnown {
				continue
			}
			if _, discovered := depthByPID[childPID]; discovered {
				return nil, fmt.Errorf("process snapshot repeats late descendant pid=%d", childPID)
			}
			depthByPID[childPID] = depthByPID[parentPID] + 1
			newNodes = append(newNodes, processTreeNode{PID: childPID, ParentPID: parentPID, Depth: depthByPID[childPID]})
			queue = append(queue, childPID)
		}
	}
	sort.Slice(newNodes, func(left, right int) bool {
		if newNodes[left].Depth != newNodes[right].Depth {
			return newNodes[left].Depth > newNodes[right].Depth
		}
		return newNodes[left].PID < newNodes[right].PID
	})
	return newNodes, nil
}

func snapshotLateProcessTreeNodes(known map[int]openedTerminationTarget) ([]processTreeNode, error) {
	entries, err := callSnapshotProcessEntries()
	if err != nil {
		return nil, err
	}
	return lateProcessTreeNodes(entries, known)
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, _, _ := callOpenProcessProcedure(processQueryLimitedInformation|processSynchronize, 0, uintptr(uint32(pid)))
	if handle == 0 {
		return false
	}
	defer callCloseHandleProcedure(handle)
	state, _, _ := callWaitForSingleObjectProcedure(handle, 0)
	return state == waitTimeout
}
