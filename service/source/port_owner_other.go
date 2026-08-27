//go:build !windows

package main

import (
	"bufio"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func processIDForEndpoint(endpoint listenerEndpoint) (int, error) {
	inodes, err := listeningSocketInodes(endpoint)
	if err != nil {
		return 0, err
	}
	foundPID := 0
	for _, inode := range inodes {
		pid, err := processIDFromSocketInode(inode)
		if err != nil {
			continue
		}
		if pid != 0 {
			if foundPID != 0 && foundPID != pid {
				return 0, fmt.Errorf("exact endpoint %s has multiple owner PIDs: %d and %d", endpoint.String(), foundPID, pid)
			}
			foundPID = pid
		}
	}
	return foundPID, nil
}

func processIDFromSocketInode(inode string) (int, error) {
	procEntries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	for _, procEntry := range procEntries {
		pid, err := strconv.Atoi(procEntry.Name())
		if err != nil {
			continue
		}
		fdDir := filepath.Join("/proc", procEntry.Name(), "fd")
		fdEntries, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		socketTarget := fmt.Sprintf("socket:[%s]", inode)
		for _, fd := range fdEntries {
			target, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			if target == socketTarget {
				return pid, nil
			}
		}
	}
	return 0, nil
}

func listeningSocketInodes(endpoint listenerEndpoint) ([]string, error) {
	path := "/proc/net/tcp"
	if endpoint.Network == "tcp6" {
		path = "/proc/net/tcp6"
	}
	return collectListeningInodesFromProcNet(path, endpoint)
}

func collectListeningInodesFromProcNet(path string, endpoint listenerEndpoint) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	result := make([]string, 0, 1)
	for i := 0; scanner.Scan(); i++ {
		if i == 0 {
			continue
		}
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 || fields[3] != "0A" {
			continue
		}
		localAddress := fields[1]
		parts := strings.SplitN(localAddress, ":", 2)
		if len(parts) != 2 {
			continue
		}
		listenPort, err := strconv.ParseInt(parts[1], 16, 32)
		listenIP, err := procNetIP(parts[0], endpoint.Network)
		if err != nil || int(listenPort) != endpoint.Port || !listenIP.Equal(endpoint.IP) {
			continue
		}
		inode := fields[9]
		if inode != "" {
			result = append(result, inode)
		}
	}
	if scanner.Err() != nil {
		return nil, scanner.Err()
	}
	return result, nil
}

func procNetIP(value, network string) (net.IP, error) {
	raw, err := hex.DecodeString(value)
	if err != nil {
		return nil, err
	}
	switch network {
	case "tcp4":
		if len(raw) != net.IPv4len {
			return nil, errors.New("invalid IPv4 address in proc net")
		}
		for left, right := 0, len(raw)-1; left < right; left, right = left+1, right-1 {
			raw[left], raw[right] = raw[right], raw[left]
		}
		return net.IP(raw), nil
	case "tcp6":
		if len(raw) != net.IPv6len {
			return nil, errors.New("invalid IPv6 address in proc net")
		}
		for offset := 0; offset < len(raw); offset += 4 {
			raw[offset], raw[offset+3] = raw[offset+3], raw[offset]
			raw[offset+1], raw[offset+2] = raw[offset+2], raw[offset+1]
		}
		return net.IP(raw), nil
	default:
		return nil, errors.New("unsupported listener network")
	}
}

func processIdentityByPID(pid int) (string, string, error) {
	if pid <= 0 {
		return "", "", errors.New("invalid pid")
	}
	path, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return "", "", err
	}
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", "", err
	}
	closingParenthesis := strings.LastIndexByte(string(stat), ')')
	if closingParenthesis < 0 {
		return "", "", errors.New("invalid /proc process stat")
	}
	fields := strings.Fields(string(stat)[closingParenthesis+1:])
	if len(fields) <= 19 || strings.TrimSpace(fields[19]) == "" {
		return "", "", errors.New("process start time not found")
	}
	return path, fields[19], nil
}

func terminateProcessTree(pid int) error {
	if pid <= 0 {
		return errors.New("invalid pid")
	}
	children, err := processDescendants(pid)
	if err != nil {
		return err
	}
	for i := len(children) - 1; i >= 0; i-- {
		_ = signalProcess(children[i], syscall.SIGTERM)
	}
	_ = signalProcess(pid, syscall.SIGTERM)

	if err := waitForProcessTreeGone(append(children, pid), 900*time.Millisecond); err == nil {
		return nil
	}
	for i := len(children) - 1; i >= 0; i-- {
		_ = signalProcess(children[i], syscall.SIGKILL)
	}
	_ = signalProcess(pid, syscall.SIGKILL)
	return waitForProcessTreeGone(append(children, pid), 900*time.Millisecond)
}

func terminateVerifiedProcessTree(owner portOwner) error {
	if owner.PID <= 0 || strings.TrimSpace(owner.CreationIdentity) == "" {
		return errors.New("owner identity is incomplete")
	}
	confirmed, found, err := servicePortOwner(owner.Endpoint.Address())
	if err != nil || !found || !samePortOwnerIdentity(owner, confirmed) {
		return fmt.Errorf("owner identity drift immediately before termination: found=%t err=%v", found, err)
	}
	return terminateProcessTree(owner.PID)
}

func terminateProcessDescendants(pid int) error {
	children, err := processDescendants(pid)
	if err != nil {
		return err
	}
	for i := len(children) - 1; i >= 0; i-- {
		_ = signalProcess(children[i], syscall.SIGTERM)
	}
	if err := waitForProcessTreeGone(children, 900*time.Millisecond); err == nil {
		return nil
	}
	for i := len(children) - 1; i >= 0; i-- {
		_ = signalProcess(children[i], syscall.SIGKILL)
	}
	return waitForProcessTreeGone(children, 900*time.Millisecond)
}

func waitForProcessTreeGone(pids []int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		liveCount := 0
		for _, pid := range pids {
			if isProcessAlive(pid) {
				liveCount++
			}
		}
		if liveCount == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("processes still alive: %v", pids)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func processDescendants(pid int) ([]int, error) {
	childrenByParent := make(map[int][]int)
	procEntries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	for _, entry := range procEntries {
		childPID, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		parent, err := processParentID(childPID)
		if err != nil {
			continue
		}
		childrenByParent[parent] = append(childrenByParent[parent], childPID)
	}
	result := make([]int, 0)
	var stack = []int{pid}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, child := range childrenByParent[current] {
			result = append(result, child)
			stack = append(stack, child)
		}
	}
	return result, nil
}

func processParentID(pid int) (int, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "PPid:") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, "PPid:"))
		return strconv.Atoi(value)
	}
	return 0, errors.New("PPid not found")
}

func signalProcess(pid int, signal syscall.Signal) error {
	if pid <= 0 {
		return nil
	}
	if !isProcessAlive(pid) {
		return nil
	}
	return syscall.Kill(pid, signal)
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err == nil || err == syscall.EPERM {
		return true
	}
	return false
}
