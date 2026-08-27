package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestStructuralRegistryCrashLockHelper(t *testing.T) {
	path := os.Getenv("OPIU_TEST_STRUCTURAL_LOCK_PATH")
	if path == "" {
		return
	}
	release, err := acquireStructuralRegistryFileLock(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	fmt.Println("LOCKED")
	for {
		time.Sleep(time.Hour)
	}
}

func TestStructuralRegistryLiveHandleCannotBeStolenAndReleasedHandleReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "structural-control.lock")
	release, err := acquireStructuralRegistryFileLock(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("persistent lock file missing: %v", err)
	}
	if secondRelease, secondErr := acquireStructuralRegistryFileLock(path, 75*time.Millisecond); secondErr == nil {
		secondRelease()
		release()
		t.Fatal("a second owner acquired the live registry handle")
	}
	release()

	reopened, err := acquireStructuralRegistryFileLock(path, time.Second)
	if err != nil {
		t.Fatalf("released or crashed owner must not leave a stale lock: %v", err)
	}
	reopened()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("lock file must persist as a harmless kernel-handle anchor: %v", err)
	}
}

func TestStructuralRegistryCrashReleasesKernelHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "structural-control.lock")
	command := exec.Command(os.Args[0], "-test.run=^TestStructuralRegistryCrashLockHelper$")
	command.Env = append(os.Environ(), "OPIU_TEST_STRUCTURAL_LOCK_PATH="+path)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "LOCKED" {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("child did not acquire lock: %q err=%v", scanner.Text(), scanner.Err())
	}
	if release, err := acquireStructuralRegistryFileLock(path, 75*time.Millisecond); err == nil {
		release()
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal("parent stole the live child handle")
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	release, err := acquireStructuralRegistryFileLock(path, time.Second)
	if err != nil {
		t.Fatalf("crashed process left a stale registry lock: %v", err)
	}
	release()
}
