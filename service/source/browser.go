package main

import (
	"errors"
	"os/exec"
	"runtime"
)

func openBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	case "linux":
		command = exec.Command("xdg-open", url)
	default:
		return errors.New("browser launch is not supported on this platform")
	}
	return command.Start()
}
