package main

import (
	"context"
	"flag"
	"fmt"
	"log"
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

	runtimeLogPath := filepath.Join(*dataDir, "logs", "service-runtime.log")
	journal, err := initRuntimeJournal(*dataDir, *address)
	if err != nil {
		fatalService("init runtime journal: %v", err)
	}
	serviceJournal = journal
	defer journal.close()

	listener, _, err := acquireServiceListener(*address, runtimeLogPath)
	if err != nil {
		fatalService("listen %s: %v", *address, err)
	}

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
	lifecycleState := newServiceLifecycleState()
	trackedHandler := trackServiceActivity(service.Handler(), lifecycleState)
	server := &http.Server{
		Handler:           withUISessionEndpoint(trackedHandler, lifecycleState),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	lifecycleContext, stopLifecycle := context.WithCancel(context.Background())
	defer stopLifecycle()
	shutdownRequested := make(chan string, 1)
	completedRuns := newCompletedRunTracker(store)
	go monitorServiceLifecycle(
		lifecycleContext,
		lifecycleState,
		completedRuns.hasNewCompletion,
		func() bool { return hasActiveRuns(store) },
		serviceResultPollInterval,
		serviceResultShutdownGrace,
		serviceUIReconnectGrace,
		func(reason string) {
			select {
			case shutdownRequested <- reason:
			default:
			}
		},
	)
	go func() {
		select {
		case reason := <-shutdownRequested:
			log.Printf("Завершение текущего OPIU: reason=%s pid=%d endpoint=%s", reason, os.Getpid(), listener.Addr().String())
			shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), serviceShutdownTimeout)
			defer cancelShutdown()
			if err := server.Shutdown(shutdownContext); err != nil {
				log.Printf("Контролируемый shutdown: %v", err)
				_ = server.Close()
			}
		case <-lifecycleContext.Done():
		}
	}()
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
	stopLifecycle()
	_ = listener.Close()
	if err := terminateProcessDescendants(os.Getpid()); err != nil {
		fatalService("post-run process tree cleanup pid=%d: %v", os.Getpid(), err)
	}
	if err := waitForPortRelease(*address, servicePreflightWaitTimeout); err != nil {
		fatalService("post-run endpoint release %s pid=%d: %v", *address, os.Getpid(), err)
	}
	log.Printf("Текущий OPIU завершён: pid=%d endpoint=%s port_free=true", os.Getpid(), *address)
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
