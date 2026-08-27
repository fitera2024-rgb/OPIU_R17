//go:build windows

package main

import (
	"encoding/csv"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func hiddenCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	configureBackgroundCommand(cmd)
	return cmd
}

// configureBackgroundCommand keeps command-line engines invisible while the
// service waits for them and captures their stdout/stderr. CREATE_NO_WINDOW is
// required in addition to HideWindow for console executables such as node.exe.
func configureBackgroundCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

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
	// CREATE_NO_WINDOW hides the PowerShell console, while the WinForms/WPF
	// window created by the script remains visible. HideWindow sends SW_HIDE
	// to the process and also hides the WinForms window on some Windows builds.
	// CREATE_NEW_PROCESS_GROUP keeps the engine independent from the web host.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 | 0x00000200}
	return cmd.Start()
}

func openBrowser(url string) error {
	return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
}

func openFolder(path string) error { return exec.Command("explorer.exe", path).Start() }

func killProcess(pid string) error {
	if _, err := strconv.Atoi(strings.TrimSpace(pid)); err != nil {
		return nil
	}
	return hiddenCommand("taskkill.exe", "/PID", strings.TrimSpace(pid), "/T", "/F").Run()
}

func processExists(pid string) bool {
	pid = strings.TrimSpace(pid)
	if _, err := strconv.Atoi(pid); err != nil {
		return false
	}
	out, err := hiddenCommand("tasklist.exe", "/FI", "PID eq "+pid, "/FO", "CSV", "/NH").Output()
	if err != nil {
		return false
	}
	r := csv.NewReader(strings.NewReader(string(out)))
	records, err := r.ReadAll()
	if err != nil {
		return false
	}
	for _, rec := range records {
		if len(rec) > 1 && strings.TrimSpace(rec[1]) == pid {
			return true
		}
	}
	return false
}

func createShortcuts(root string) error {
	exe := installedLauncherPath(root)
	uninstall := fmt.Sprintf("\"%s\" --uninstall", exe)
	script := fmt.Sprintf(`$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $desktop=[Environment]::GetFolderPath('Desktop'); $s=$shell.CreateShortcut((Join-Path $desktop 'Автоматическая сверка ОПИУ.lnk')); $s.TargetPath='%s'; $s.Arguments='--launch'; $s.WorkingDirectory='%s'; $s.IconLocation='%s,0'; $s.Description='Локальный сервис сверки ОПИУ'; $s.Save(); $reg='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OPIU_Service'; New-Item -Path $reg -Force | Out-Null; Set-ItemProperty -Path $reg -Name DisplayName -Value 'Автоматическая сверка ОПИУ'; Set-ItemProperty -Path $reg -Name DisplayVersion -Value '%s'; Set-ItemProperty -Path $reg -Name Publisher -Value 'OPIU Service'; Set-ItemProperty -Path $reg -Name InstallLocation -Value '%s'; Set-ItemProperty -Path $reg -Name DisplayIcon -Value '%s'; Set-ItemProperty -Path $reg -Name UninstallString -Value '%s'; Set-ItemProperty -Path $reg -Name NoModify -Value 1 -Type DWord; Set-ItemProperty -Path $reg -Name NoRepair -Value 1 -Type DWord`, psQuote(exe), psQuote(root), psQuote(exe), serviceVersion, psQuote(root), psQuote(exe), psQuote(uninstall))
	return hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script).Run()
}

func createPortableShortcut(root string) error {
	exe := currentExecutable()
	script := fmt.Sprintf(`$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $desktop=[Environment]::GetFolderPath('Desktop'); $s=$shell.CreateShortcut((Join-Path $desktop 'Автоматическая сверка ОПИУ 1.9.4.lnk')); $s.TargetPath='%s'; $s.WorkingDirectory='%s'; $s.IconLocation='%s,0'; $s.Description='Локальная portable-сверка ОПИУ 1.9.4'; $s.Save()`, psQuote(exe), psQuote(root), psQuote(exe))
	return hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script).Run()
}

func removeRegistration(root string) error {
	script := `$desktop=[Environment]::GetFolderPath('Desktop'); Remove-Item (Join-Path $desktop 'Автоматическая сверка ОПИУ.lnk') -Force -ErrorAction SilentlyContinue; Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OPIU_Service' -Recurse -Force -ErrorAction SilentlyContinue`
	return hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script).Run()
}

func scheduleSelfDelete(root string) error {
	exe := currentExecutable()
	launchers := filepath.Join(root, "launchers")
	legacy := filepath.Join(root, "OPIU_Service.exe")
	cleanup := fmt.Sprintf("timeout /t 2 /nobreak >nul & del /f /q \"%s\" 2>nul & del /f /q \"%s\" 2>nul & rmdir /s /q \"%s\" 2>nul", exe, legacy, launchers)
	cmd := exec.Command("cmd.exe", "/c", "start", "", "/b", "cmd.exe", "/c", cleanup)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000008 | 0x00000200}
	return cmd.Start()
}

func psQuote(s string) string { return strings.ReplaceAll(s, "'", "''") }

func infoBox(message string)  { showBox(message, "Сервис сверки ОПИУ", "Information") }
func fatalBox(message string) { showBox(message, "Сервис сверки ОПИУ", "Error") }
func showBox(message, title, icon string) {
	script := fmt.Sprintf(`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('%s','%s','OK','%s') | Out-Null`, psQuote(message), psQuote(title), icon)
	_ = hiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script).Run()
}

func currentExecutable() string { p, _ := os.Executable(); return p }
