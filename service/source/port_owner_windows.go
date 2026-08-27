//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os/exec"
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
	waitForSingleObjectProcedure       = kernel32ProcessDLL.NewProc("WaitForSingleObject")
	closeHandleProcedure               = kernel32ProcessDLL.NewProc("CloseHandle")
)

const (
	processQueryLimitedInformation = 0x1000
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
	handle, _, openErr := openProcessProcedure.Call(processQueryLimitedInformation, 0, uintptr(uint32(pid)))
	if handle == 0 {
		return "", "", windowsProcedureError("OpenProcess", openErr)
	}
	defer closeHandleProcedure.Call(handle)
	return processIdentityFromHandle(handle)
}

func processIdentityFromHandle(handle uintptr) (string, string, error) {
	if handle == 0 {
		return "", "", errors.New("invalid process handle")
	}

	buffer := make([]uint16, 32768)
	bufferLength := uint32(len(buffer))
	result, _, queryErr := queryFullProcessImageNameProcedure.Call(
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
	result, _, timesErr := getProcessTimesProcedure.Call(
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
	if pid <= 0 {
		return errors.New("invalid pid")
	}
	command := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("taskkill failed: %w: %s", err, strings.TrimSpace(string(output)))
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
	handle, _, openErr := openProcessProcedure.Call(
		processQueryLimitedInformation|processSynchronize,
		0,
		uintptr(uint32(owner.PID)),
	)
	if handle == 0 {
		return windowsProcedureError("OpenProcess", openErr)
	}
	defer closeHandleProcedure.Call(handle)
	path, creationIdentity, err := processIdentityFromHandle(handle)
	if err != nil || creationIdentity != owner.CreationIdentity || !sameExecutableFile(path, owner.ExecutablePath) {
		return fmt.Errorf("creation-bound owner identity drift before termination: creation=%q path=%q err=%v", creationIdentity, path, err)
	}
	confirmed, found, err = servicePortOwner(owner.Endpoint.Address())
	if err != nil || !found || !samePortOwnerIdentity(owner, confirmed) {
		return fmt.Errorf("endpoint owner identity drift immediately before termination: found=%t err=%v", found, err)
	}
	if err := terminateProcessTree(owner.PID); err != nil {
		return err
	}
	result, _, waitErr := waitForSingleObjectProcedure.Call(handle, uintptr(uint32((3*time.Second)/time.Millisecond)))
	switch result {
	case waitObject0:
		return nil
	case waitTimeout:
		return fmt.Errorf("creation-bound process pid=%d did not exit", owner.PID)
	default:
		return windowsProcedureError("WaitForSingleObject", waitErr)
	}
}

func terminateProcessDescendants(pid int) error {
	descendants, err := processDescendants(pid)
	if err != nil {
		return err
	}
	for index := len(descendants) - 1; index >= 0; index-- {
		childPID := descendants[index]
		if !isProcessAlive(childPID) {
			continue
		}
		_ = terminateProcessTree(childPID)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		remaining := make([]int, 0)
		for _, childPID := range descendants {
			if isProcessAlive(childPID) {
				remaining = append(remaining, childPID)
			}
		}
		if len(remaining) == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("descendant processes still alive: %v", remaining)
		}
		time.Sleep(40 * time.Millisecond)
	}
}

func processDescendants(pid int) ([]int, error) {
	snapshot, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(snapshot)
	entry := syscall.ProcessEntry32{Size: uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))}
	if err := syscall.Process32First(snapshot, &entry); err != nil {
		return nil, err
	}
	childrenByParent := make(map[int][]int)
	for {
		processPID := int(entry.ProcessID)
		parentPID := int(entry.ParentProcessID)
		childrenByParent[parentPID] = append(childrenByParent[parentPID], processPID)
		entry.Size = uint32(unsafe.Sizeof(syscall.ProcessEntry32{}))
		if err := syscall.Process32Next(snapshot, &entry); err != nil {
			if errors.Is(err, syscall.ERROR_NO_MORE_FILES) {
				break
			}
			return nil, err
		}
	}
	result := make([]int, 0)
	stack := []int{pid}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, childPID := range childrenByParent[current] {
			result = append(result, childPID)
			stack = append(stack, childPID)
		}
	}
	return result, nil
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	command := exec.Command("tasklist", "/FO", "CSV", "/NH", "/FI", fmt.Sprintf("PID eq %d", pid))
	output, err := command.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(output), fmt.Sprintf("\"%d\"", pid))
}
