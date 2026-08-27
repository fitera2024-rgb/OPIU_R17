//go:build windows

package main

import (
	"sync"
	"syscall"
	"time"
)

const (
	errorSharingViolation syscall.Errno = 32
	errorLockViolation    syscall.Errno = 33
)

// acquireStructuralRegistryFileLock relies only on a live kernel handle. The
// ordinary lock file remains on disk; a process crash closes its handle and
// makes the same file immediately acquirable without PID or age heuristics.
func acquireStructuralRegistryFileLock(path string, timeout time.Duration) (func(), error) {
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		handle, openErr := syscall.CreateFile(
			pointer,
			syscall.GENERIC_READ|syscall.GENERIC_WRITE,
			syscall.FILE_SHARE_READ,
			nil,
			syscall.OPEN_ALWAYS,
			syscall.FILE_ATTRIBUTE_NORMAL,
			0,
		)
		if openErr == nil {
			var once sync.Once
			return func() { once.Do(func() { _ = syscall.CloseHandle(handle) }) }, nil
		}
		if openErr != errorSharingViolation && openErr != errorLockViolation {
			return nil, openErr
		}
		if !time.Now().Before(deadline) {
			return nil, openErr
		}
		time.Sleep(25 * time.Millisecond)
	}
}
