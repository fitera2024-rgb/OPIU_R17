package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	defer recoverMainPanic()
	if err := enforceSafetyEnvironment(); err != nil {
		fatalService("safety environment: %v", err)
	}
	defaultDataDir := filepath.Join(defaultUserConfigDir(), "OPIU_STABLE")
	address := flag.String("addr", "127.0.0.1:8765", "local listen address")
	dataDir := flag.String("data-dir", defaultDataDir, "private service data directory")
	noOpen := flag.Bool("no-open", false, "do not open the browser automatically")
	flag.Parse()

	listener, err := net.Listen("tcp", *address)
	if err != nil {
		if existingURL, ok := openVerifiedExistingService(*address, *noOpen, nil, openBrowser); ok {
			fmt.Printf("OPIU_STABLE already running: %s\n", existingURL)
			return
		}
		fatalService("listen %s: %v", *address, err)
	}

	journal, err := initRuntimeJournal(*dataDir, *address)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init runtime journal: %v\n", err)
		os.Exit(1)
	}
	serviceJournal = journal
	defer journal.close()

	store, err := OpenStore(*dataDir)
	if err != nil {
		fatalService("open store: %v", err)
	}
	pipeline, err := NewPipeline(store)
	if err != nil {
		fatalService("configure report-only pipeline: %v", err)
	}
	service, err := NewServer(store, pipeline)
	if err != nil {
		fatalService("create server: %v", err)
	}
	server := &http.Server{
		Handler:           service.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	url := "http://" + listener.Addr().String() + "/"
	fmt.Printf("OPIU_STABLE 1.9.4: %s\n", url)
	fmt.Println("Режим: REPORT_ONLY. Запись в 1С отключена.")
	fmt.Printf("Журналы сервиса: %s\n", filepath.Join(*dataDir, "logs"))
	if !*noOpen {
		go func() {
			time.Sleep(350 * time.Millisecond)
			_ = openBrowser(url)
		}()
	}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		fatalService("serve: %v", err)
	}
}

func defaultUserConfigDir() string {
	root, err := os.UserConfigDir()
	if err == nil && root != "" {
		return root
	}
	root, err = os.UserHomeDir()
	if err == nil && root != "" {
		return filepath.Join(root, ".config")
	}
	return "."
}
