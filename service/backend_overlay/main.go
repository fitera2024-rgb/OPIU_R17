package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	serviceVersion = "1.9.4"
	serviceName    = "Автоматическая сверка ОПИУ"
	maxUploadBytes = int64(512 * 1024 * 1024)
	maxJSONBytes   = int64(32 * 1024 * 1024)
)

// defaultPortable is set to "true" only for the portable build via -ldflags.
// The regular installer keeps the historical LocalAppData installation flow.
var defaultPortable = "false"

//go:embed payload.zip
var payloadFS embed.FS

type App struct {
	Root          string
	AppRoot       string
	DataRoot      string
	WebRoot       string
	ConfigDir     string
	InputsDir     string
	OutputsDir    string
	RulesDir      string
	InstrDir      string
	LogsDir       string
	RuntimeDir    string
	mu            sync.Mutex
	referencesMu  sync.Mutex
	diagnosticsMu sync.Mutex
	rulesEngineMu sync.Mutex
	runsMu        sync.Mutex
	logger        *log.Logger
}

type fileInfo struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modified_at"`
	Extension  string `json:"extension"`
}

func main() {
	args := os.Args[1:]
	portable := hasArg(args, "--portable") || strings.EqualFold(strings.TrimSpace(defaultPortable), "true")
	root, err := installRoot()
	if portable {
		root, err = portableRoot()
	}
	if err != nil {
		fatalBox("Не удалось определить папку установки: " + err.Error())
		return
	}
	configureRuntimeEnvironment(root)

	if hasArg(args, "--serve") {
		if err := ensureInstalled(root); err != nil {
			fatalBox("Не удалось подготовить файлы сервиса: " + err.Error())
			return
		}
		port := argInt(args, "--port", 0)
		if err := runServer(root, port); err != nil {
			writeCrash(root, err)
			fatalBox("Сервис завершился с ошибкой. Диагностика сохранена в папке данных.\n\n" + err.Error())
		}
		return
	}

	if hasArg(args, "--open-data") {
		_ = openFolder(filepath.Join(root, "data"))
		return
	}

	if hasArg(args, "--uninstall") {
		_ = stopExisting(root)
		_ = os.RemoveAll(filepath.Join(root, "app"))
		_ = os.Remove(filepath.Join(root, "current-version.txt"))
		if portable {
			infoBox("Рабочие файлы portable-версии удалены. Пользовательские данные сохранены в:\n" + filepath.Join(root, "data"))
		} else {
			_ = removeRegistration(root)
			infoBox("Программа удалена. Пользовательские данные сохранены в:\n" + filepath.Join(root, "data"))
			_ = scheduleSelfDelete(root)
		}
		return
	}

	if portable {
		if err := ensureInstalled(root); err != nil {
			fatalBox("Не удалось подготовить portable-версию: " + err.Error())
			return
		}
		// Portable-поставка остаётся полностью локальной, но создаёт удобный
		// пользовательский ярлык на текущий EXE. Ошибка ярлыка не должна мешать
		// самой сверке: она фиксируется в диагностике и запуск продолжается.
		if err := createPortableShortcut(root); err != nil {
			writeCrash(root, fmt.Errorf("не удалось создать ярлык portable-версии: %w", err))
		}
		if err := launchPortable(root); err != nil {
			fatalBox("Portable-версия не смогла запуститься.\n\n" + err.Error() + "\n\nПапка: " + root)
		}
		return
	}

	// При обновлении сначала закрываем прежний локальный сервис. Это исключает
	// одновременную запись в пользовательские реестры и освобождает старый EXE.
	// Сам новый запускатель сохраняется под версионным именем, поэтому Windows
	// не требуется перезаписывать файл работающего процесса.
	if !samePath(currentExecutable(), installedLauncherPath(root)) {
		if err := stopExisting(root); err != nil {
			fatalBox("Не удалось остановить предыдущую версию сервиса.\n\n" + err.Error())
			return
		}
	}
	if err := ensureInstalled(root); err != nil {
		fatalBox("Установка не выполнена: " + err.Error())
		return
	}
	if err := copySelf(root); err != nil {
		fatalBox("Не удалось установить файл запуска: " + err.Error())
		return
	}
	if err := createShortcuts(root); err != nil {
		fatalBox("Сервис установлен, но не удалось обновить ярлык: " + err.Error())
		return
	}

	if err := launchInstalled(root); err != nil {
		fatalBox("Сервис установлен, но не смог запуститься.\n\n" + err.Error() + "\n\nПапка: " + root)
		return
	}

	if !hasArg(args, "--launch") {
		infoBox("Сервис установлен и открыт в браузере.\n\nЯрлык создан на рабочем столе.\nПользовательские данные сохраняются отдельно от программы.")
	}
}

func hasArg(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
	}
	return false
}

func argInt(args []string, name string, fallback int) int {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == name {
			if n, err := strconv.Atoi(args[i+1]); err == nil {
				return n
			}
		}
	}
	return fallback
}

func installRoot() (string, error) {
	base := os.Getenv("LOCALAPPDATA")
	if strings.TrimSpace(base) == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(base, "OPIU_Service"), nil
}

func portableRoot() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(exe); resolveErr == nil {
		exe = resolved
	}
	return filepath.Dir(exe), nil
}

func configureRuntimeEnvironment(root string) {
	_ = os.Setenv("OPIU_SERVICE_ROOT", root)
	_ = os.Setenv("OPIU_NODE_EXE", filepath.Join(root, "app", serviceVersion, "runtime", "node", "node.exe"))
}

func ensureInstalled(root string) error {
	appRoot := filepath.Join(root, "app", serviceVersion)
	marker := filepath.Join(appRoot, ".installed")
	payload, err := payloadFS.ReadFile("payload.zip")
	if err != nil {
		return err
	}
	payloadSHA := sha256.Sum256(payload)
	markerValue := serviceVersion + "\n" + strings.ToUpper(hex.EncodeToString(payloadSHA[:])) + "\n"
	if b, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(b)) == strings.TrimSpace(markerValue) {
		return ensureDataLayout(root, appRoot)
	}
	if err := os.MkdirAll(filepath.Dir(appRoot), 0755); err != nil {
		return err
	}
	temp := appRoot + ".installing"
	_ = os.RemoveAll(temp)
	if err := os.MkdirAll(temp, 0755); err != nil {
		return err
	}
	if err := extractZip(payload, temp); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(temp, ".installed"), []byte(markerValue), 0644); err != nil {
		return err
	}
	_ = os.RemoveAll(appRoot)
	if err := os.Rename(temp, appRoot); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(root, "current-version.txt"), []byte(serviceVersion+"\n"), 0644); err != nil {
		return err
	}
	return ensureDataLayout(root, appRoot)
}

func extractZip(data []byte, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range zr.File {
		name := filepath.Clean(filepath.FromSlash(f.Name))
		if name == "." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) || filepath.IsAbs(name) {
			return fmt.Errorf("недопустимый путь в поставке: %s", f.Name)
		}
		target := filepath.Join(dest, name)
		clean := filepath.Clean(target)
		if !strings.HasPrefix(clean+string(os.PathSeparator), root) && clean != filepath.Clean(dest) {
			return fmt.Errorf("выход за пределы установки: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		closeErr1, closeErr2 := out.Close(), rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr1 != nil {
			return closeErr1
		}
		if closeErr2 != nil {
			return closeErr2
		}
	}
	return nil
}

func ensureDataLayout(root, appRoot string) error {
	dirs := []string{
		filepath.Join(root, "data", "config"), filepath.Join(root, "data", "inputs"), filepath.Join(root, "data", "outputs"),
		filepath.Join(root, "data", "rules", "exports"), filepath.Join(root, "data", "rules", "imports"),
		filepath.Join(root, "data", "instructions", "current"), filepath.Join(root, "data", "instructions", "history"),
		filepath.Join(root, "data", "logs"), filepath.Join(root, "data", "runtime"),
		filepath.Join(root, "data", "reference", "erp_shared", "versions"), filepath.Join(root, "data", "intalev", "versions"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	defaults := map[string]string{
		filepath.Join(appRoot, "data", "defaults", "settings.json"):     filepath.Join(root, "data", "config", "settings.json"),
		filepath.Join(appRoot, "data", "defaults", "rules.json"):        filepath.Join(root, "data", "rules", "rules.json"),
		filepath.Join(appRoot, "data", "defaults", "instructions.json"): filepath.Join(root, "data", "instructions", "instructions.json"),
		filepath.Join(appRoot, "data", "defaults", "materials.json"):    filepath.Join(root, "data", "config", "materials.json"),
		filepath.Join(appRoot, "data", "defaults", "catalogs.json"):     filepath.Join(root, "data", "config", "catalogs.json"),
	}
	for src, dst := range defaults {
		if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
			if err := copyFile(src, dst); err != nil {
				return err
			}
		}
	}
	if err := seedInstructions(root, appRoot); err != nil {
		return err
	}
	if err := ensureSharedERPReferencesV060(root, appRoot); err != nil {
		return err
	}
	return ensureV041Data(root, appRoot)
}

func seedInstructions(root, appRoot string) error {
	manifestPath := filepath.Join(root, "data", "instructions", "instructions.json")
	var manifest map[string]any
	if err := readJSON(manifestPath, &manifest); err != nil {
		return err
	}
	list, _ := manifest["instructions"].([]any)
	changed := false
	for _, raw := range list {
		item, _ := raw.(map[string]any)
		id := safeID(asString(item["instruction_id"]))
		systemPath := filepath.FromSlash(asString(item["system_path"]))
		version := int(asFloat(item["current_version"]))
		if version < 1 {
			version = 1
		}
		ext := filepath.Ext(systemPath)
		if ext == "" {
			ext = ".docx"
		}
		name := fmt.Sprintf("%s_v%d%s", id, version, ext)
		dst := filepath.Join(root, "data", "instructions", "current", name)
		if _, err := os.Stat(dst); errors.Is(err, os.ErrNotExist) {
			if err := copyFile(filepath.Join(appRoot, systemPath), dst); err != nil {
				return err
			}
		}
		rel, _ := filepath.Rel(filepath.Join(root, "data"), dst)
		normalized := filepath.ToSlash(rel)
		if asString(item["current_path"]) != normalized {
			item["current_path"] = normalized
			changed = true
		}
	}
	if changed {
		return writeJSONAtomic(manifestPath, manifest)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func installedLauncherPath(root string) string {
	return filepath.Join(root, "launchers", "OPIU_Service_"+serviceVersion+".exe")
}

func copySelf(root string) error {
	src, err := os.Executable()
	if err != nil {
		return err
	}
	dst := installedLauncherPath(root)
	if samePath(src, dst) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	tmp := dst + ".new"
	_ = os.Remove(tmp)
	if err := copyFile(src, tmp); err != nil {
		return err
	}
	_ = os.Remove(dst)
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(dst, 0755)
	return nil
}

func samePath(a, b string) bool {
	aa, _ := filepath.Abs(a)
	bb, _ := filepath.Abs(b)
	return strings.EqualFold(filepath.Clean(aa), filepath.Clean(bb))
}

func launchInstalled(root string) error {
	if u := findExisting(root); u != "" {
		return openBrowser(u)
	}
	if err := stopExisting(root); err != nil {
		return err
	}
	exe := installedLauncherPath(root)
	if _, err := os.Stat(exe); err != nil {
		return err
	}
	if err := startDetached(exe, []string{"--serve"}, root); err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
		portBytes, _ := os.ReadFile(filepath.Join(root, "data", "runtime", "service.port"))
		port := strings.TrimSpace(string(portBytes))
		if port == "" {
			continue
		}
		u := "http://127.0.0.1:" + port
		resp, err := http.Get(u + "/api/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return openBrowser(u)
			}
			last = resp.Status
		} else {
			last = err.Error()
		}
	}
	if last == "" {
		last = "тайм-аут запуска"
	}
	return errors.New(last)
}

func launchPortable(root string) error {
	if u := findExisting(root); u != "" {
		return openBrowser(u)
	}
	if err := stopExisting(root); err != nil {
		return err
	}
	exe := currentExecutable()
	if exe == "" {
		return errors.New("не найден файл запуска portable-версии")
	}
	if err := startDetached(exe, []string{"--portable", "--serve"}, root); err != nil {
		return err
	}
	return waitForServerAndOpen(root)
}

func waitForServerAndOpen(root string) error {
	deadline := time.Now().Add(20 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
		portBytes, _ := os.ReadFile(filepath.Join(root, "data", "runtime", "service.port"))
		port := strings.TrimSpace(string(portBytes))
		if port == "" {
			continue
		}
		u := "http://127.0.0.1:" + port
		resp, err := http.Get(u + "/api/health")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return openBrowser(u)
			}
			last = resp.Status
		} else {
			last = err.Error()
		}
	}
	if last == "" {
		last = "тайм-аут запуска"
	}
	return errors.New(last)
}

func findExisting(root string) string {
	p, err := os.ReadFile(filepath.Join(root, "data", "runtime", "service.port"))
	if err != nil {
		return ""
	}
	port := strings.TrimSpace(string(p))
	if port == "" {
		return ""
	}
	u := "http://127.0.0.1:" + port
	client := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := client.Get(u + "/api/health")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	var health map[string]any
	if json.NewDecoder(resp.Body).Decode(&health) != nil {
		return ""
	}
	if asString(health["service"]) == "OPIU" && asString(health["version"]) == serviceVersion {
		return u
	}
	return ""
}

func stopExisting(root string) error {
	runtimeDir := filepath.Join(root, "data", "runtime")
	pidPath := filepath.Join(runtimeDir, "service.pid")
	portPath := filepath.Join(runtimeDir, "service.port")
	p, err := os.ReadFile(pidPath)
	if err != nil {
		_ = os.Remove(portPath)
		return nil
	}
	pid := strings.TrimSpace(string(p))
	if pid == "" {
		_ = os.Remove(pidPath)
		_ = os.Remove(portPath)
		return nil
	}

	killErr := killProcess(pid)
	deadline := time.Now().Add(12 * time.Second)
	for processExists(pid) && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	if processExists(pid) {
		if killErr != nil {
			return fmt.Errorf("не удалось остановить предыдущий процесс %s: %w", pid, killErr)
		}
		return fmt.Errorf("предыдущий процесс %s не завершился за 12 секунд", pid)
	}
	_ = os.Remove(pidPath)
	_ = os.Remove(portPath)
	return nil
}

func runServer(root string, requestedPort int) error {
	appRoot := filepath.Join(root, "app", serviceVersion)
	a, err := newApp(root, appRoot)
	if err != nil {
		return err
	}
	port, ln, err := listenLocal(requestedPort)
	if err != nil {
		return err
	}
	defer ln.Close()
	_ = os.WriteFile(filepath.Join(a.RuntimeDir, "service.port"), []byte(strconv.Itoa(port)+"\n"), 0644)
	_ = os.WriteFile(filepath.Join(a.RuntimeDir, "service.pid"), []byte(strconv.Itoa(os.Getpid())+"\n"), 0644)
	_ = a.logEvent("SERVICE_STARTED", map[string]any{"version": serviceVersion, "port": port})
	server := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second}
	err = server.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func listenLocal(requested int) (int, net.Listener, error) {
	start := requested
	if start <= 0 {
		start = 8765
	}
	for p := start; p <= start+30; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			return p, ln, nil
		}
	}
	return 0, nil, fmt.Errorf("не найден свободный локальный порт, начиная с %d", start)
}

func newApp(root, appRoot string) (*App, error) {
	data := filepath.Join(root, "data")
	logPath := filepath.Join(data, "logs", "service.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return nil, err
	}
	lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return nil, err
	}
	a := &App{
		Root: root, AppRoot: appRoot, DataRoot: data, WebRoot: filepath.Join(appRoot, "web"),
		ConfigDir: filepath.Join(data, "config"), InputsDir: filepath.Join(data, "inputs"), OutputsDir: filepath.Join(data, "outputs"),
		RulesDir: filepath.Join(data, "rules"), InstrDir: filepath.Join(data, "instructions"), LogsDir: filepath.Join(data, "logs"), RuntimeDir: filepath.Join(data, "runtime"),
		logger: log.New(lf, "", log.LstdFlags|log.Lmicroseconds),
	}
	if err := ensureDataLayout(root, appRoot); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", a.handleHealth)
	mux.HandleFunc("/api/bootstrap", a.handleBootstrapV041)
	mux.HandleFunc("/api/files", a.handleFiles)
	mux.HandleFunc("/api/files/upload", a.handleUpload)
	mux.HandleFunc("/api/files/download", a.handleDownload)
	mux.HandleFunc("/api/reference-status", a.handleReferenceStatusV060)
	mux.HandleFunc("/api/intalev-packages/finalize", a.handleIntalevPackageFinalizeV060)
	mux.HandleFunc("/api/annual-sources/status", a.handleAnnualSourceStatusV160)
	mux.HandleFunc("/api/annual-sources/finalize", a.handleAnnualSourceFinalizeV160)
	mux.HandleFunc("/api/settings", a.handleSettingsV194)
	mux.HandleFunc("/api/catalogs/upload", a.handleCatalogUploadV044)
	mux.HandleFunc("/api/rules/save", a.handleRuleSaveV041)
	mux.HandleFunc("/api/rules/approve", a.handleRuleApproveV041)
	mux.HandleFunc("/api/rules/approve-bulk", a.handleRuleApproveBulkV041)
	mux.HandleFunc("/api/rules/copy", a.handleRuleCopyV041)
	mux.HandleFunc("/api/rules/export", a.handleRuleExportV041)
	mux.HandleFunc("/api/rules/import", a.handleRuleImportV041)
	mux.HandleFunc("/api/instructions/download", a.handleInstructionDownload)
	mux.HandleFunc("/api/instructions/create", a.handleInstructionCreateV180)
	mux.HandleFunc("/api/instructions/upload", a.handleInstructionUpload)
	mux.HandleFunc("/api/instructions/publish", a.handleInstructionPublish)
	mux.HandleFunc("/api/materials/save", a.handleMaterialSave)
	mux.HandleFunc("/api/materials/download", a.handleMaterialDownload)
	mux.HandleFunc("/api/modules/open", a.handleModuleOpenV041)
	mux.HandleFunc("/api/engine/prepare", a.handleEnginePrepareV041)
	mux.HandleFunc("/api/engine/collect", a.handleEngineCollectV041)
	mux.HandleFunc("/api/rules-engine/prepare", a.handleRulesEnginePrepare)
	mux.HandleFunc("/api/rules-engine/run", a.handleRulesEngineRun)
	mux.HandleFunc("/api/rules-engine/collect", a.handleRulesEngineCollect)
	mux.HandleFunc("/api/rules-engine/apply-decisions", a.handleRulesEngineApplyDecisions)
	mux.HandleFunc("/api/rules-engine/status", a.handleRulesEngineStatus)
	mux.HandleFunc("/api/rules-engine/result", a.handleRulesEngineResultV194)
	mux.HandleFunc("/api/artifacts/download", a.handleArtifactDownloadV041)
	mux.HandleFunc("/api/artifacts/technical-bundle", a.handleTechnicalArtifactsBundleV180)
	mux.HandleFunc("/api/rule-catalog", a.handleRuleCatalogV194)
	mux.HandleFunc("/api/modules/open-folder", a.handleModuleFolder)
	mux.HandleFunc("/api/open-data-folder", a.handleOpenData)
	mux.HandleFunc("/api/events", a.handleEvents)
	mux.HandleFunc("/api/support/errors", a.handleSupportErrorsV160)
	mux.HandleFunc("/api/support-bundle", a.handleSupportBundleV160)
	mux.Handle("/", a.localOnly(http.FileServer(http.Dir(a.WebRoot))))
	return a.withDiagnosticsV160(a.localOnly(mux))
}

func (a *App) localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		if ip != nil && !ip.IsLoopback() {
			writeJSON(w, 403, map[string]any{"error": "LOCAL_ACCESS_ONLY"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "service": "OPIU", "version": serviceVersion})
}

func (a *App) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	settings := map[string]any{}
	rules := map[string]any{}
	instructions := map[string]any{}
	materials := map[string]any{}
	if err := readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings); err != nil {
		writeErr(w, err)
		return
	}
	if err := readJSON(filepath.Join(a.RulesDir, "rules.json"), &rules); err != nil {
		writeErr(w, err)
		return
	}
	if err := readJSON(filepath.Join(a.InstrDir, "instructions.json"), &instructions); err != nil {
		writeErr(w, err)
		return
	}
	if err := readJSON(filepath.Join(a.ConfigDir, "materials.json"), &materials); err != nil {
		writeErr(w, err)
		return
	}
	inputs, _ := listFiles(a.InputsDir)
	outputs, _ := listFiles(a.OutputsDir)
	ruleList := anySlice(rules["rules"])
	instList := anySlice(instructions["instructions"])
	imported := 0
	published := 0
	for _, raw := range ruleList {
		m, _ := raw.(map[string]any)
		if asString(m["status"]) == "imported_review" {
			imported++
		}
		if asString(m["status"]) == "published" && asBool(m["enabled"]) {
			published++
		}
	}
	modules := []any{}
	for _, folder := range []string{"reconciliation", "corrections"} {
		m := map[string]any{}
		mp := filepath.Join(a.AppRoot, "modules", folder, "MODULE_MANIFEST.json")
		if readJSON(mp, &m) == nil {
			m["launcher_exists"] = fileExists(filepath.Join(a.AppRoot, "modules", folder, filepath.FromSlash(asString(m["launcher"]))))
			m["entrypoint_exists"] = fileExists(filepath.Join(a.AppRoot, "modules", folder, filepath.FromSlash(asString(m["entrypoint"]))))
			modules = append(modules, m)
		}
	}
	writeJSON(w, 200, map[string]any{
		"service":  map[string]any{"version": serviceVersion, "host": "127.0.0.1", "user_data_dir": a.DataRoot, "report_only": true, "distribution": "ONE_FILE_WINDOWS_INSTALLER"},
		"settings": settings,
		"counts":   map[string]any{"rules": len(ruleList), "published_rules": published, "imported_review": imported, "inputs": len(inputs), "outputs": len(outputs), "instructions": len(instList)},
		"files":    map[string]any{"inputs": inputs, "outputs": outputs}, "rules": ruleList, "instructions": instList, "materials": anySlice(materials["items"]), "modules": modules,
	})
}

func (a *App) handleFiles(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	dir := a.InputsDir
	if kind == "output" {
		dir = a.OutputsDir
	} else {
		kind = "input"
	}
	switch r.Method {
	case http.MethodGet:
		files, err := listFiles(dir)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"kind": kind, "files": files})
	case http.MethodDelete:
		name := safeRelativeFilePath(r.URL.Query().Get("name"))
		if name == "" {
			writeJSON(w, 400, map[string]any{"error": "FILENAME_REQUIRED"})
			return
		}
		full, err := within(dir, name)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "INVALID_PATH"})
			return
		}
		_ = os.Remove(full)
		_ = a.logEvent("FILE_DELETED", map[string]any{"kind": kind, "filename": name})
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		methodNotAllowed(w)
	}
}

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	kind := r.URL.Query().Get("kind")
	dir := a.InputsDir
	if kind == "output" {
		dir = a.OutputsDir
	} else {
		kind = "input"
	}
	raw := r.Header.Get("X-Relative-Path")
	if strings.TrimSpace(raw) == "" {
		raw = r.Header.Get("X-Filename")
	}
	decoded, _ := url.QueryUnescape(raw)
	name := safeRelativeFilePath(decoded)
	if name == "" {
		writeJSON(w, 400, map[string]any{"error": "FILENAME_REQUIRED"})
		return
	}
	if strings.EqualFold(filepath.Ext(name), ".rar") {
		writeJSON(w, 400, map[string]any{
			"error":   "UNSUPPORTED_ARCHIVE",
			"message": "RAR не поддерживается. Распакуйте архив и выберите папку либо создайте ZIP-архив.",
		})
		return
	}
	full, err := within(dir, name)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_PATH"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		writeErr(w, err)
		return
	}
	tmp := full + fmt.Sprintf(".%d.part", time.Now().UnixNano())
	out, err := os.Create(tmp)
	if err != nil {
		writeErr(w, err)
		return
	}
	h := sha256.New()
	limited := io.LimitReader(r.Body, maxUploadBytes+1)
	n, copyErr := io.Copy(io.MultiWriter(out, h), limited)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || n > maxUploadBytes {
		_ = os.Remove(tmp)
		writeJSON(w, 413, map[string]any{"error": "UPLOAD_TOO_LARGE"})
		return
	}
	_ = os.Remove(full)
	if err := os.Rename(tmp, full); err != nil {
		writeErr(w, err)
		return
	}
	hash := strings.ToUpper(hex.EncodeToString(h.Sum(nil)))
	if kind == "input" {
		if err := a.refreshInputRolesAfterUploadV181(); err != nil {
			_ = a.logEvent("INPUT_ROLE_REFRESH_FAILED", map[string]any{"filename": filepath.ToSlash(name), "error": err.Error()})
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "INPUT_ROLE_REFRESH_FAILED", "message": "Файл сохранён, но список источников не обновлён. Обновите страницу или передайте журнал в поддержку."})
			return
		}
	}
	_ = a.logEvent("FILE_UPLOADED", map[string]any{"kind": kind, "filename": filepath.ToSlash(name), "size": n, "sha256": hash})
	writeJSON(w, 201, map[string]any{"ok": true, "file": map[string]any{"name": filepath.ToSlash(name), "size": n}})
}

func (a *App) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	kind := r.URL.Query().Get("kind")
	dir := a.InputsDir
	if kind == "output" {
		dir = a.OutputsDir
	}
	name := safeRelativeFilePath(r.URL.Query().Get("name"))
	if name == "" {
		writeJSON(w, 400, map[string]any{"error": "FILENAME_REQUIRED"})
		return
	}
	full, err := within(dir, name)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_PATH"})
		return
	}
	serveDownload(w, r, full, filepath.Base(name))
}

func (a *App) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	if mode, ok := body["period_mode"]; ok {
		period := asString(body["period"])
		normalizedMode, normalizedPeriod, periodErr := normalizePeriodSelectionV180(asString(mode), period)
		if periodErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "INVALID_PERIOD", "message": periodErr.Error()})
			return
		}
		body["period_mode"] = normalizedMode
		body["period"] = normalizedPeriod
	}
	path := filepath.Join(a.ConfigDir, "settings.json")
	current := map[string]any{}
	_ = readJSON(path, &current)
	changedFields := contextChangedFields(current, body)
	needsReset := len(changedFields) > 0 && a.hasActiveContext(current)
	confirmed := asBool(body["clear_current_context"])
	if needsReset && !confirmed {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":          "CONTEXT_RESET_REQUIRED",
			"message":        "При изменении организации, ЦФО, дочерних узлов или периода текущие файлы и результаты нужно снять с активного запуска. Справочники, правила и история сохранятся.",
			"changed_fields": changedFields,
		})
		return
	}
	archivePath := ""
	if needsReset && confirmed {
		archivePath, err = a.archiveActiveContext(current)
		if err != nil {
			writeErr(w, err)
			return
		}
		current["active_run_id"] = ""
		current["workflow_stage"] = "INPUTS_PENDING"
		current["input_roles"] = map[string]any{"intalev": "", "erp": ""}
		current["last_archived_context"] = archivePath
		current["context_revision"] = int(asFloat(current["context_revision"])) + 1
	}
	delete(body, "clear_current_context")
	safety := current["safety"]
	for k, v := range body {
		if k != "safety" {
			current[k] = v
		}
	}
	current["safety"] = safety
	current["updated_at"] = nowISO()
	if err := writeJSONAtomic(path, current); err != nil {
		writeErr(w, err)
		return
	}
	_ = a.logEvent("SETTINGS_UPDATED", map[string]any{"fields": mapKeys(body), "context_reset": needsReset && confirmed, "archive_path": archivePath})
	writeJSON(w, 200, map[string]any{"ok": true, "settings": current, "context_reset": needsReset && confirmed, "archive_path": archivePath})
}

func contextChangedFields(current, body map[string]any) []string {
	fields := []string{"organization_id", "include_descendants", "period_mode", "period"}
	changed := []string{}
	for _, key := range fields {
		if incoming, ok := body[key]; ok && fmt.Sprint(incoming) != fmt.Sprint(current[key]) {
			changed = append(changed, key)
		}
	}
	return changed
}

func (a *App) hasActiveContext(settings map[string]any) bool {
	if strings.TrimSpace(asString(settings["active_run_id"])) != "" {
		return true
	}
	roles, _ := settings["input_roles"].(map[string]any)
	if strings.TrimSpace(asString(roles["intalev"])) != "" || strings.TrimSpace(asString(roles["erp"])) != "" {
		return true
	}
	inputs, _ := listFiles(a.InputsDir)
	outputs, _ := listFiles(a.OutputsDir)
	return len(inputs) > 0 || len(outputs) > 0
}

func (a *App) archiveActiveContext(settings map[string]any) (string, error) {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	label := safeID(asString(settings["organization_id"]))
	if label == "" {
		label = "NO_ORG"
	}
	period := safeID(asString(settings["period"]))
	if period == "" {
		period = "NO_PERIOD"
	}
	archiveRoot := filepath.Join(a.DataRoot, "archive", "contexts", stamp+"_"+label+"_"+period)
	if err := os.MkdirAll(archiveRoot, 0755); err != nil {
		return "", err
	}
	if err := moveDirectoryContents(a.InputsDir, filepath.Join(archiveRoot, "inputs")); err != nil {
		return "", err
	}
	if err := moveDirectoryContents(a.OutputsDir, filepath.Join(archiveRoot, "outputs")); err != nil {
		return "", err
	}
	meta := map[string]any{"archived_at": nowISO(), "settings": settings, "reason": "CONTEXT_CHANGED", "files_are_preserved": true}
	if err := writeJSONAtomic(filepath.Join(archiveRoot, "context.json"), meta); err != nil {
		return "", err
	}
	_ = a.logEvent("ACTIVE_CONTEXT_ARCHIVED", map[string]any{"archive_path": archiveRoot, "organization_id": settings["organization_id"], "period": settings["period"]})
	return archiveRoot, nil
}

func moveDirectoryContents(source, destination string) error {
	if err := os.MkdirAll(destination, 0755); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		if os.IsNotExist(err) {
			return os.MkdirAll(source, 0755)
		}
		return err
	}
	for _, entry := range entries {
		from := filepath.Join(source, entry.Name())
		to := filepath.Join(destination, entry.Name())
		if err := os.Rename(from, to); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) handleRuleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	input, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	lib := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &lib)
	rule := normalizeRule(input, settings)
	list := anySlice(lib["rules"])
	found := -1
	for i, raw := range list {
		m, _ := raw.(map[string]any)
		if asString(m["rule_id"]) == asString(rule["rule_id"]) {
			found = i
			if c := m["created_at"]; c != nil {
				rule["created_at"] = c
			}
			if ap := m["approvals"]; ap != nil {
				rule["approvals"] = ap
			}
			break
		}
	}
	if found >= 0 {
		list[found] = rule
	} else {
		list = append(list, rule)
	}
	lib["rules"] = list
	if err := writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), lib); err != nil {
		writeErr(w, err)
		return
	}
	_ = a.logEvent("RULE_SAVED", map[string]any{"rule_id": rule["rule_id"], "revision_id": rule["revision_id"], "status": rule["status"]})
	writeJSON(w, 200, map[string]any{"ok": true, "rule": rule})
}

func (a *App) handleRuleApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	org := strings.TrimSpace(asString(body["organization"]))
	if org == "" {
		writeJSON(w, 400, map[string]any{"error": "ORGANIZATION_REQUIRED"})
		return
	}
	lib := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &lib)
	list := anySlice(lib["rules"])
	var target map[string]any
	for _, raw := range list {
		m, _ := raw.(map[string]any)
		if asString(m["rule_id"]) == asString(body["rule_id"]) {
			target = m
			break
		}
	}
	if target == nil {
		writeJSON(w, 404, map[string]any{"error": "RULE_NOT_FOUND"})
		return
	}
	approvals := anySlice(target["approvals"])
	approval := map[string]any{"organization": org, "status": "approved", "approved_by": defaultString(asString(body["approved_by"]), "Пользователь"), "approved_at": nowISO(), "comment": asString(body["comment"])}
	if asString(body["status"]) == "rejected" {
		approval["status"] = "rejected"
	}
	idx := -1
	for i, raw := range approvals {
		m, _ := raw.(map[string]any)
		if asString(m["organization"]) == org {
			idx = i
			break
		}
	}
	if idx >= 0 {
		approvals[idx] = approval
	} else {
		approvals = append(approvals, approval)
	}
	target["approvals"] = approvals
	target["updated_at"] = nowISO()
	_ = writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), lib)
	_ = a.logEvent("RULE_APPROVAL_CHANGED", map[string]any{"rule_id": target["rule_id"], "organization": org, "status": approval["status"]})
	writeJSON(w, 200, map[string]any{"ok": true, "rule": target})
}

func (a *App) handleRuleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	lib := map[string]any{}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &lib)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	ids := map[string]bool{}
	for _, id := range strings.Split(r.URL.Query().Get("ids"), ",") {
		if s := safeID(id); s != "" {
			ids[s] = true
		}
	}
	selected := []any{}
	for _, raw := range anySlice(lib["rules"]) {
		m, _ := raw.(map[string]any)
		if len(ids) == 0 || ids[asString(m["rule_id"])] {
			selected = append(selected, m)
		}
	}
	pack := map[string]any{"schema_version": "opiu-rule-exchange.v1", "package_id": newID("RULEPACK"), "exported_at": nowISO(), "exported_by": defaultString(asString(settings["author"]), "Пользователь"), "source_library_id": defaultString(asString(lib["library_id"]), "local-library"), "safety": settings["safety"], "rules": selected}
	data, _ := json.MarshalIndent(pack, "", "  ")
	data = append(data, '\n')
	name := fmt.Sprintf("OPIU_Rules_%s_%s.json", time.Now().Format("2006-01-02"), lastN(asString(pack["package_id"]), 8))
	_ = os.WriteFile(filepath.Join(a.RulesDir, "exports", name), data, 0644)
	_ = a.logEvent("RULE_PACK_EXPORTED", map[string]any{"package_id": pack["package_id"], "count": len(selected), "filename": name})
	downloadBytes(w, name, "application/json; charset=utf-8", data)
}

func (a *App) handleRuleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	pack, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	incomingRules := anySlice(pack["rules"])
	if asString(pack["schema_version"]) != "opiu-rule-exchange.v1" || incomingRules == nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_RULE_PACK"})
		return
	}
	lib := map[string]any{}
	settings := map[string]any{}
	_ = readJSON(filepath.Join(a.RulesDir, "rules.json"), &lib)
	_ = readJSON(filepath.Join(a.ConfigDir, "settings.json"), &settings)
	list := anySlice(lib["rules"])
	added, skipped, conflicts := 0, 0, 0
	ids := []string{}
	for _, raw := range incomingRules {
		im, _ := raw.(map[string]any)
		copyMap := cloneMap(im)
		if asString(copyMap["rule_type"]) != "base" {
			copyMap["rule_type"] = "imported"
		}
		copyMap["status"] = "imported_review"
		copyMap["enabled"] = false
		copyMap["source"] = map[string]any{"kind": "rule_exchange", "package_id": pack["package_id"], "exported_by": pack["exported_by"], "imported_at": nowISO(), "original_source": im["source"]}
		n := normalizeRule(copyMap, settings)
		origID := safeID(asString(im["rule_id"]))
		if origID != "" {
			n["rule_id"] = origID
		}
		n["origin_rule_id"] = safeID(defaultString(asString(im["origin_rule_id"]), origID))
		if h := asString(im["content_hash"]); h != "" {
			n["content_hash"] = h
		}
		sameRevision := false
		var sameID map[string]any
		for _, lr := range list {
			m, _ := lr.(map[string]any)
			if asString(m["rule_id"]) == asString(n["rule_id"]) {
				sameID = m
				if asString(m["content_hash"]) == asString(n["content_hash"]) {
					sameRevision = true
				}
				break
			}
		}
		if sameRevision {
			skipped++
			continue
		}
		if sameID != nil {
			n["rule_id"] = newID("RULE-IMPORT")
			n["origin_rule_id"] = defaultString(asString(sameID["origin_rule_id"]), asString(sameID["rule_id"]))
			src, _ := n["source"].(map[string]any)
			src["conflict_with_local_rule_id"] = sameID["rule_id"]
			conflicts++
		} else {
			added++
		}
		list = append(list, n)
		ids = append(ids, asString(n["rule_id"]))
	}
	lib["rules"] = list
	_ = writeJSONAtomic(filepath.Join(a.RulesDir, "rules.json"), lib)
	importName := safeID(defaultString(asString(pack["package_id"]), newID("RULEPACK"))) + ".json"
	raw, _ := json.MarshalIndent(pack, "", "  ")
	_ = os.WriteFile(filepath.Join(a.RulesDir, "imports", importName), append(raw, '\n'), 0644)
	result := map[string]any{"added": added, "skipped": skipped, "conflicts": conflicts, "imported_rule_ids": ids}
	_ = a.logEvent("RULE_PACK_IMPORTED", map[string]any{"package_id": pack["package_id"], "added": added, "skipped": skipped, "conflicts": conflicts})
	writeJSON(w, 200, map[string]any{"ok": true, "result": result})
}

func (a *App) handleInstructionDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	man := map[string]any{}
	_ = readJSON(filepath.Join(a.InstrDir, "instructions.json"), &man)
	id := safeID(r.URL.Query().Get("id"))
	var item map[string]any
	for _, raw := range anySlice(man["instructions"]) {
		m, _ := raw.(map[string]any)
		if asString(m["instruction_id"]) == id {
			item = m
			break
		}
	}
	if item == nil {
		writeJSON(w, 404, map[string]any{"error": "INSTRUCTION_NOT_FOUND"})
		return
	}
	full, err := within(a.DataRoot, filepath.FromSlash(asString(item["current_path"])))
	if err != nil {
		writeErr(w, err)
		return
	}
	ext := strings.ToLower(asString(item["file_type"]))
	if ext != ".pdf" {
		ext = ".docx"
	}
	name := fmt.Sprintf("%s_v%s%s", safeFileName(asString(item["title"])), defaultString(asString(item["display_version"]), fmt.Sprint(int(asFloat(item["current_version"])))), ext)
	serveDownload(w, r, full, name)
}

func (a *App) handleInstructionUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	id := safeID(r.Header.Get("X-Instruction-Id"))
	author, _ := url.QueryUnescape(r.Header.Get("X-Author"))
	comment, _ := url.QueryUnescape(r.Header.Get("X-Comment"))
	man := map[string]any{}
	_ = readJSON(filepath.Join(a.InstrDir, "instructions.json"), &man)
	var item map[string]any
	for _, raw := range anySlice(man["instructions"]) {
		m, _ := raw.(map[string]any)
		if asString(m["instruction_id"]) == id {
			item = m
			break
		}
	}
	if item == nil {
		writeJSON(w, 404, map[string]any{"error": "INSTRUCTION_NOT_FOUND"})
		return
	}
	if instructionIsSystemV180(item) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "SYSTEM_INSTRUCTION_IMMUTABLE", "message": "Системная инструкция доступна только для чтения. Создайте отдельную пользовательскую инструкцию."})
		return
	}
	next := int(asFloat(item["current_version"])) + 1
	name := fmt.Sprintf("%s_v%d.docx", id, next)
	history := filepath.Join(a.InstrDir, "history", name)
	h := sha256.New()
	out, err := os.Create(history)
	if err != nil {
		writeErr(w, err)
		return
	}
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(r.Body, maxUploadBytes+1))
	_ = out.Close()
	if err != nil || n > maxUploadBytes {
		_ = os.Remove(history)
		writeJSON(w, 413, map[string]any{"error": "UPLOAD_TOO_LARGE"})
		return
	}
	current := filepath.Join(a.InstrDir, "current", name)
	_ = copyFile(history, current)
	rel, _ := filepath.Rel(a.DataRoot, current)
	item["current_version"] = next
	item["current_path"] = filepath.ToSlash(rel)
	item["status"] = "draft"
	item["author"] = defaultString(author, "Пользователь")
	item["comment"] = defaultString(comment, "Новая редакция")
	item["updated_at"] = nowISO()
	item["sha256"] = strings.ToUpper(hex.EncodeToString(h.Sum(nil)))
	_ = writeJSONAtomic(filepath.Join(a.InstrDir, "instructions.json"), man)
	_ = a.logEvent("INSTRUCTION_VERSION_UPLOADED", map[string]any{"instruction_id": id, "version": next, "author": item["author"], "sha256": item["sha256"]})
	writeJSON(w, 201, map[string]any{"ok": true, "instruction": instructionsPublicItemV194(item)})
}

func (a *App) handleInstructionPublish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	man := map[string]any{}
	_ = readJSON(filepath.Join(a.InstrDir, "instructions.json"), &man)
	var item map[string]any
	for _, raw := range anySlice(man["instructions"]) {
		m, _ := raw.(map[string]any)
		if asString(m["instruction_id"]) == asString(body["instruction_id"]) {
			item = m
			break
		}
	}
	if item == nil {
		writeJSON(w, 404, map[string]any{"error": "INSTRUCTION_NOT_FOUND"})
		return
	}
	if instructionIsSystemV180(item) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "SYSTEM_INSTRUCTION_IMMUTABLE", "message": "Системная инструкция не изменяется."})
		return
	}
	item["status"] = "published"
	item["author"] = defaultString(asString(body["author"]), defaultString(asString(item["author"]), "Пользователь"))
	item["comment"] = defaultString(asString(body["comment"]), "Опубликовано")
	item["updated_at"] = nowISO()
	_ = writeJSONAtomic(filepath.Join(a.InstrDir, "instructions.json"), man)
	_ = a.logEvent("INSTRUCTION_PUBLISHED", map[string]any{"instruction_id": item["instruction_id"], "version": item["current_version"], "author": item["author"]})
	writeJSON(w, 200, map[string]any{"ok": true, "instruction": instructionsPublicItemV194(item)})
}

func (a *App) handleMaterialSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	reg := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "materials.json"), &reg)
	var item map[string]any
	for _, raw := range anySlice(reg["items"]) {
		m, _ := raw.(map[string]any)
		if asString(m["material_id"]) == asString(body["material_id"]) {
			item = m
			break
		}
	}
	if item == nil || !asBool(item["editable"]) {
		writeJSON(w, 403, map[string]any{"error": "MATERIAL_NOT_EDITABLE"})
		return
	}
	for _, k := range []string{"title", "description"} {
		if v := asString(body[k]); v != "" {
			item[k] = strings.TrimSpace(v)
		}
	}
	if requestedURL := strings.TrimSpace(asString(body["url"])); requestedURL != "" {
		publicURL := materialPublicHTTPURLV194(requestedURL)
		if asString(item["kind"]) != "external_link" || publicURL == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"message": "Укажите полную ссылку, начинающуюся с http:// или https://."})
			return
		}
		item["url"] = publicURL
	}
	item["updated_at"] = nowISO()
	if err := writeJSONAtomic(filepath.Join(a.ConfigDir, "materials.json"), reg); err != nil {
		_ = a.logEvent("MATERIAL_UPDATE_FAILED", map[string]any{"material_id": item["material_id"], "technical_error": err.Error()})
		writeJSON(w, http.StatusInternalServerError, map[string]any{"message": "Не удалось сохранить ссылку на материалы. Передайте журнал в поддержку."})
		return
	}
	_ = a.logEvent("MATERIAL_UPDATED", map[string]any{"material_id": item["material_id"]})
	writeJSON(w, 200, map[string]any{"ok": true, "item": materialsPublicItemV194(item)})
}

func (a *App) handleMaterialDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	reg := map[string]any{}
	_ = readJSON(filepath.Join(a.ConfigDir, "materials.json"), &reg)
	id := safeID(r.URL.Query().Get("id"))
	var item map[string]any
	for _, raw := range anySlice(reg["items"]) {
		m, _ := raw.(map[string]any)
		if asString(m["material_id"]) == id && asString(m["kind"]) == "local_file" {
			item = m
			break
		}
	}
	if item == nil {
		writeJSON(w, 404, map[string]any{"error": "MATERIAL_NOT_FOUND"})
		return
	}
	full, err := within(a.AppRoot, filepath.FromSlash(asString(item["path"])))
	if err != nil {
		writeErr(w, err)
		return
	}
	serveDownload(w, r, full, filepath.Base(full))
}

func (a *App) handleModuleOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, err := decodeJSONBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": "INVALID_JSON"})
		return
	}
	folders := map[string]string{"reconciliation-engine": "reconciliation", "correction-files-engine": "corrections"}
	folder := folders[asString(body["module_id"])]
	if folder == "" {
		writeJSON(w, 404, map[string]any{"error": "MODULE_NOT_FOUND"})
		return
	}
	man := map[string]any{}
	_ = readJSON(filepath.Join(a.AppRoot, "modules", folder, "MODULE_MANIFEST.json"), &man)
	launcher, err := within(filepath.Join(a.AppRoot, "modules", folder), filepath.FromSlash(asString(man["launcher"])))
	if err != nil || !fileExists(launcher) {
		writeJSON(w, 404, map[string]any{"error": "LAUNCHER_NOT_FOUND"})
		return
	}
	ext := strings.ToLower(filepath.Ext(launcher))
	var cmd *exec.Cmd
	if ext == ".cmd" || ext == ".bat" {
		cmd = exec.Command("cmd.exe", "/c", "start", "", launcher)
	} else if ext == ".ps1" {
		cmd = exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", launcher)
	} else {
		writeJSON(w, 409, map[string]any{"error": "UNSUPPORTED_LAUNCHER"})
		return
	}
	cmd.Dir = filepath.Dir(launcher)
	if err := cmd.Start(); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	_ = a.logEvent("MODULE_UI_OPENED", map[string]any{"module_id": body["module_id"], "launcher": launcher})
	writeJSON(w, 200, map[string]any{"ok": true, "module_id": body["module_id"]})
}

func (a *App) handleModuleFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	body, _ := decodeJSONBody(r)
	folders := map[string]string{"reconciliation-engine": "reconciliation", "correction-files-engine": "corrections"}
	folder := folders[asString(body["module_id"])]
	if folder == "" {
		writeJSON(w, 404, map[string]any{"error": "MODULE_NOT_FOUND"})
		return
	}
	p := filepath.Join(a.AppRoot, "modules", folder, "source")
	if err := openFolder(p); err != nil {
		writeErr(w, err)
		return
	}
	_ = a.logEvent("MODULE_FOLDER_OPENED", map[string]any{"module_id": body["module_id"], "path": p})
	writeJSON(w, 200, map[string]any{"ok": true, "opened": true})
}

func (a *App) handleOpenData(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if err := openFolder(a.DataRoot); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "opened": true})
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	data, _ := os.ReadFile(filepath.Join(a.LogsDir, "events.ndjson"))
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	events := []any{}
	for i := len(lines) - 1; i >= 0 && len(events) < 200; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(lines[i]), &m) == nil {
			events = append(events, m)
		}
	}
	writeJSON(w, 200, map[string]any{"events": eventsPublicItemsV194(events)})
}

func (a *App) logEvent(event string, details map[string]any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	details = cloneMap(details)
	details["timestamp"] = nowISO()
	details["type"] = event
	b, _ := json.Marshal(details)
	f, err := os.OpenFile(filepath.Join(a.LogsDir, "events.ndjson"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

func normalizeRule(input, settings map[string]any) map[string]any {
	now := nowISO()
	ruleType := asString(input["rule_type"])
	if ruleType != "base" && ruleType != "organization" && ruleType != "imported" {
		ruleType = "organization"
	}
	scope, _ := input["scope"].(map[string]any)
	if scope == nil {
		scope = map[string]any{}
	}
	if ruleType != "base" && strings.TrimSpace(asString(scope["organization"])) == "" {
		scope["organization"] = asString(settings["organization"])
	}
	if _, ok := scope["articles"].([]any); !ok {
		scope["articles"] = []any{}
	}
	status := asString(input["status"])
	if status != "draft" && status != "published" && status != "imported_review" && status != "retired" {
		status = "draft"
	}
	rule := map[string]any{"rule_id": defaultString(safeID(asString(input["rule_id"])), newID("RULE")), "origin_rule_id": "", "revision_id": defaultString(safeID(asString(input["revision_id"])), newID("REV")), "name": defaultString(strings.TrimSpace(asString(input["name"])), "Новое правило"), "description": strings.TrimSpace(asString(input["description"])), "rule_type": ruleType, "status": status, "enabled": asBool(input["enabled"]), "scope": scope, "action": defaultString(strings.TrimSpace(asString(input["action"])), "REVIEW"), "conditions": input["conditions"], "author": defaultString(strings.TrimSpace(asString(input["author"])), defaultString(asString(settings["author"]), "Пользователь")), "source": input["source"], "approvals": input["approvals"], "created_at": defaultString(asString(input["created_at"]), now), "updated_at": now}
	if rule["conditions"] == nil {
		rule["conditions"] = map[string]any{}
	}
	if rule["source"] == nil {
		rule["source"] = map[string]any{"kind": "local"}
	}
	if rule["approvals"] == nil {
		rule["approvals"] = []any{}
	}
	rule["origin_rule_id"] = defaultString(safeID(asString(input["origin_rule_id"])), asString(rule["rule_id"]))
	semantic := map[string]any{"name": rule["name"], "description": rule["description"], "rule_type": rule["rule_type"], "scope": rule["scope"], "action": rule["action"], "conditions": rule["conditions"], "enabled": rule["enabled"]}
	rule["content_hash"] = hashJSON(semantic)
	return rule
}

func listFiles(dir string) ([]fileInfo, error) {
	out := []fileInfo{}
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".part") {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return nil
		}
		name := filepath.ToSlash(rel)
		out = append(out, fileInfo{Name: name, Size: info.Size(), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339), Extension: strings.ToLower(filepath.Ext(entry.Name()))})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModifiedAt > out[j].ModifiedAt })
	return out, nil
}
func readJSON(path string, out any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}
func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + fmt.Sprintf(".%d.tmp", time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0644); err != nil {
		return err
	}
	_ = os.Remove(path)
	return os.Rename(tmp, path)
}
func decodeJSONBody(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxJSONBytes {
		return nil, errors.New("PAYLOAD_TOO_LARGE")
	}
	m := map[string]any{}
	if len(bytes.TrimSpace(b)) == 0 {
		return m, nil
	}
	err = json.Unmarshal(b, &m)
	return m, err
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
func writeErr(w http.ResponseWriter, err error) {
	_ = err
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "INTERNAL_ERROR", "message": "Операция не завершена. Подробности записаны в журнале поддержки."})
}
func methodNotAllowed(w http.ResponseWriter) {
	writeJSON(w, 405, map[string]any{"error": "METHOD_NOT_ALLOWED"})
}
func serveDownload(w http.ResponseWriter, r *http.Request, path, name string) {
	if !fileExists(path) {
		writeJSON(w, 404, map[string]any{"error": "NOT_FOUND"})
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(name)))
	http.ServeFile(w, r, path)
}
func downloadBytes(w http.ResponseWriter, name, contentType string, b []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.PathEscape(name)))
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
}
func safeFileName(s string) string {
	s = filepath.Base(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "\x00", "")
	if s == "." || s == string(os.PathSeparator) {
		return ""
	}
	return s
}

func safeRelativeFilePath(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\x00", ""))
	s = strings.ReplaceAll(s, "\\", "/")
	if s == "" || strings.HasPrefix(s, "/") || filepath.IsAbs(s) || filepath.VolumeName(s) != "" {
		return ""
	}
	clean := filepath.Clean(filepath.FromSlash(s))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return ""
	}
	return clean
}
func safeID(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func within(base, rel string) (string, error) {
	target := filepath.Clean(filepath.Join(base, rel))
	root := filepath.Clean(base)
	rr, err := filepath.Rel(root, target)
	if err != nil || rr == ".." || strings.HasPrefix(rr, ".."+string(os.PathSeparator)) {
		return "", errors.New("INVALID_PATH")
	}
	return target, nil
}
func newID(prefix string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%08X-%04X-%04X-%04X-%012X", prefix, b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func hashJSON(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return strings.ToUpper(hex.EncodeToString(h[:]))
}
func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }
func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case fmt.Stringer:
		return x.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}
func asFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}
func asBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(x, "true")
	}
	return false
}
func anySlice(v any) []any {
	if v == nil {
		return []any{}
	}
	if x, ok := v.([]any); ok {
		return x
	}
	return []any{}
}
func cloneMap(m map[string]any) map[string]any {
	n := map[string]any{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
func mapKeys(m map[string]any) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
func defaultString(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}
func lastN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
func fileExists(p string) bool { i, e := os.Stat(p); return e == nil && !i.IsDir() }
func writeCrash(root string, err error) {
	_ = os.MkdirAll(filepath.Join(root, "data", "logs"), 0755)
	_ = os.WriteFile(filepath.Join(root, "data", "logs", "crash.log"), []byte(time.Now().Format(time.RFC3339)+" "+err.Error()+"\n"), 0644)
}
func _mimeInit() { _ = mime.TypeByExtension(".js") }
func init() {
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	mime.AddExtensionType(".json", "application/json; charset=utf-8")
}

// platform functions are implemented in platform_windows.go / platform_other.go.
var _ = runtime.GOOS
