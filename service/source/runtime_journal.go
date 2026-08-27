package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
	"time"
)

type runtimeJournal struct {
	mu          sync.Mutex
	runtimePath string
	crashPath   string
	runtimeFile *os.File
}

var serviceJournal *runtimeJournal

func initRuntimeJournal(dataDir, address string) (*runtimeJournal, error) {
	logsDir := filepath.Join(dataDir, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, err
	}
	runtimePath := filepath.Join(logsDir, "service-runtime.log")
	crashPath := filepath.Join(logsDir, "service-crash.log")
	f, err := os.OpenFile(runtimePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	j := &runtimeJournal{runtimePath: runtimePath, crashPath: crashPath, runtimeFile: f}
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	log.Printf("SERVICE_START pid=%d address=%s data_dir=%q", os.Getpid(), address, dataDir)
	return j, nil
}

func (j *runtimeJournal) close() {
	if j == nil || j.runtimeFile == nil {
		return
	}
	log.Printf("SERVICE_STOP pid=%d", os.Getpid())
	_ = j.runtimeFile.Sync()
	_ = j.runtimeFile.Close()
}

func (j *runtimeJournal) recordCrash(kind string, value any, stack []byte) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	f, err := os.OpenFile(j.crashPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		log.Printf("CRASH_LOG_OPEN_FAILED: %v", err)
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "\n[%s] %s pid=%d: %v\n", time.Now().Format(time.RFC3339Nano), kind, os.Getpid(), value)
	if len(stack) > 0 {
		_, _ = f.Write(stack)
		_, _ = f.WriteString("\n")
	}
	_ = f.Sync()
}

func fatalService(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("FATAL: %s", msg)
	if serviceJournal != nil {
		serviceJournal.recordCrash("FATAL", msg, debug.Stack())
	}
	os.Exit(1)
}

func recoverMainPanic() {
	if value := recover(); value != nil {
		stack := debug.Stack()
		log.Printf("PANIC: %v\n%s", value, stack)
		if serviceJournal != nil {
			serviceJournal.recordCrash("PANIC", value, stack)
		}
		os.Exit(2)
	}
}

func runtimeJournalMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		log.Printf("HTTP_BEGIN method=%s path=%s remote=%s", r.Method, r.URL.Path, r.RemoteAddr)
		defer func() {
			if value := recover(); value != nil {
				stack := debug.Stack()
				log.Printf("HTTP_PANIC method=%s path=%s panic=%v\n%s", r.Method, r.URL.Path, value, stack)
				if serviceJournal != nil {
					serviceJournal.recordCrash("HTTP_PANIC", value, stack)
				}
				http.Error(w, "Внутренняя ошибка сервиса", http.StatusInternalServerError)
			}
			log.Printf("HTTP_END method=%s path=%s duration_ms=%d", r.Method, r.URL.Path, time.Since(started).Milliseconds())
		}()
		next.ServeHTTP(w, r)
	})
}
