//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

func configureBackgroundCommand(cmd *exec.Cmd) {}

func startDetached(exe string, args []string, dir string) error {
	return startDetachedWithEnv(exe, args, dir, nil)
}

func startDetachedWithEnv(exe string, args []string, dir string, extraEnv map[string]string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	for key, value := range extraEnv {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd.Start()
}
func openBrowser(url string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", url).Start()
	}
	return exec.Command("xdg-open", url).Start()
}
func openFolder(path string) error { return openBrowser("file://" + path) }
func killProcess(pid string) error {
	n, err := strconv.Atoi(strings.TrimSpace(pid))
	if err != nil {
		return nil
	}
	p, err := os.FindProcess(n)
	if err != nil {
		return nil
	}
	return p.Kill()
}
func processExists(pid string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(pid))
	if err != nil {
		return false
	}
	p, err := os.FindProcess(n)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
func createShortcuts(root string) error        { return nil }
func createPortableShortcut(root string) error { return nil }
func removeRegistration(root string) error     { return nil }
func scheduleSelfDelete(root string) error     { return nil }
func infoBox(message string)                   { fmt.Println(message) }
func fatalBox(message string)                  { fmt.Println(message) }
func currentExecutable() string                { p, _ := os.Executable(); return p }
