//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

const (
	messageBoxOK            = 0x00000000
	messageBoxIconError     = 0x00000010
	messageBoxSetForeground = 0x00010000
	messageBoxTopmost       = 0x00040000
)

var windowsMessageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func showFatalServiceDialog(message string) {
	text, textErr := syscall.UTF16PtrFromString(message)
	title, titleErr := syscall.UTF16PtrFromString("OPIU R17 — запуск остановлен")
	if textErr != nil || titleErr != nil {
		return
	}
	_, _, _ = windowsMessageBox.Call(
		0,
		uintptr(unsafe.Pointer(text)),
		uintptr(unsafe.Pointer(title)),
		messageBoxOK|messageBoxIconError|messageBoxSetForeground|messageBoxTopmost,
	)
}
