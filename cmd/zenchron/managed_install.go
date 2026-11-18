package main

import (
	"bytes"
	"context"
	"debug/buildinfo"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

const managedLaunchAgentLabel = "com.bogdaniel.zenchron-engineering-os"
const managedEntrypointMarker = "# managed by Zenchron Engineering OS"
const legacyZenchronModule = "github.com/bogdaniel/zenchron-engineering"
const currentZenchronModule = "github.com/bogdaniel/zenchron-engineering-os"

func managedHome() (string, error) {
	if home := strings.TrimSpace(os.Getenv("ZENCHRON_MANAGED_HOME")); home != "" {
		return filepath.Abs(home)
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	return filepath.Join(config, "zenchron-installation"), nil
}

func managedDataDirectory(home string) (string, error) {
	directory := strings.TrimSpace(os.Getenv("ZENCHRON_DATA_DIR"))
	if directory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("resolve existing Zenchron state directory: %w", err)
		}
		directory = filepath.Join(config, "zenchron")
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", fmt.Errorf("resolve managed state directory: %w", err)
	}
	return absolute, nil
}

func installManaged() error {
	if runtime.GOOS != "darwin" {
		return errors.New("the managed local installation currently requires macOS LaunchAgents")
	}
	canonical, err := localEntrypointPath()
	if err != nil {
		return err
	}
	if err := validateEntrypointPath(canonical); err != nil {
		return err
	}
	home, err := managedHome()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create managed installation: %w", err)
	}
	if _, err := updater.ActiveRelease(home); err == nil {
		entrypoint, err := installStableEntrypoint(home)
		if err != nil {
			return err
		}
		if err := addLocalBinToZshPath(); err != nil {
			return err
		}
		if err := ensureManagedAgent(home, entrypoint); err != nil {
			return err
		}
		fmt.Printf("Zenchron is already installed at http://127.0.0.1:8080/?mode=live\nCommand: %s\n", entrypoint)
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect existing managed release: %w", err)
	}
	installLock, err := acquireControlPlaneLock(filepath.Join(home, "manager"))
	if err != nil {
		return fmt.Errorf("another managed install or runtime already owns this installation: %w", err)
	}
	defer installLock.Close()
	if _, err := updater.ActiveRelease(home); err == nil {
		return errors.New("managed installation completed concurrently; rerun the command to inspect it")
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("recheck managed release: %w", err)
	}
	dataDir, err := managedDataDirectory(home)
	if err != nil {
		return err
	}
	stateLock, err := acquireControlPlaneLock(dataDir)
	if err != nil {
		return fmt.Errorf("an existing control plane owns the durable state; stop it safely before installing: %w", err)
	}
	if err := stateLock.Close(); err != nil {
		return fmt.Errorf("release state ownership check: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:8080")
	if err != nil {
		return fmt.Errorf("the canonical dashboard port 8080 is already in use: %w", err)
	}
	if err := listener.Close(); err != nil {
		return fmt.Errorf("close managed dashboard port check: %w", err)
	}
	repository := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_REPOSITORY"))
	if repository == "" {
		repository = "bogdaniel/zenchron-engineering-os"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	github := newGitHubClient()
	candidate, err := github.trustedMain(ctx, repository)
	if err != nil {
		return fmt.Errorf("verify the initial trusted release: %w", err)
	}
	credential, err := github.gitFetchCredential(ctx)
	if err != nil {
		return fmt.Errorf("authenticate the initial source fetch: %w", err)
	}
	buildCtx, cancelBuild := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancelBuild()
	if _, err := updater.BuildRelease(buildCtx, home, candidate, credential); err != nil {
		return fmt.Errorf("build the initial managed release: %w", err)
	}
	verifyCtx, cancelVerify := context.WithTimeout(context.Background(), 30*time.Second)
	latest, err := github.trustedMain(verifyCtx, repository)
	cancelVerify()
	if err != nil || latest.Commit != candidate.Commit || latest.Tree != candidate.Tree {
		return errors.New("trusted main advanced or became unverifiable during initial installation; no release was activated")
	}
	if err := updater.SetActiveRelease(home, candidate.Commit); err != nil {
		return err
	}
	entrypoint, err := installStableEntrypoint(home)
	if err != nil {
		return err
	}
	if err := addLocalBinToZshPath(); err != nil {
		return err
	}
	status := updater.Status{RunningRevision: candidate.Commit, LatestRevision: candidate.Commit, State: "idle"}
	if err := updater.WriteStatus(filepath.Join(dataDir, "system-update.json"), status); err != nil {
		return err
	}
	if err := installLock.Close(); err != nil {
		return fmt.Errorf("release installed but managed-install lock could not be released: %w", err)
	}
	if err := installLaunchAgent(home, entrypoint); err != nil {
		return err
	}
	fmt.Printf("Zenchron managed installation is starting at http://127.0.0.1:8080/?mode=live\nCommand: %s\n", entrypoint)
	return nil
}

func ensureManagedAgent(home, entrypoint string) error {
	current, err := user.Current()
	if err != nil {
		return fmt.Errorf("resolve current user: %w", err)
	}
	if _, err := exec.Command("launchctl", "print", "gui/"+current.Uid+"/"+managedLaunchAgentLabel).CombinedOutput(); err == nil {
		return nil
	}
	return installLaunchAgent(home, entrypoint)
}

func installStableEntrypoint(home string) (string, error) {
	path, err := localEntrypointPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create local command directory: %w", err)
	}
	if err := verifyReplaceableEntrypoint(path, nil); err != nil {
		return "", err
	}
	if isZenchronExecutable(path) {
		if err := validateStaleCommandRecoveryPath(path); err != nil {
			return "", err
		}
	}
	if err := migrateShadowingZenchronCommands(path); err != nil {
		return "", err
	}
	contents := managedEntrypointContents(home)
	if err := verifyReplaceableEntrypoint(path, contents); err != nil {
		return "", err
	}
	if isZenchronExecutable(path) {
		if err := retireZenchronCommand(path); err != nil {
			return "", err
		}
	}
	if err := writeInstallFile(path, contents, 0o700); err != nil {
		return "", fmt.Errorf("install canonical Zenchron command: %w", err)
	}
	return path, nil
}

func managedEntrypointContents(home string) []byte {
	script := "#!/bin/sh\n" + managedEntrypointMarker + "\nset -eu\nroot=" + shellQuote(home) + "\n"
	script += "revision=$(cat \"$root/active-release\")\n"
	script += "case \"$revision\" in " + strings.Repeat("[0-9a-f]", 40) + ") ;; *) echo 'invalid Zenchron release pointer' >&2; exit 1 ;; esac\n"
	script += "export ZENCHRON_MANAGED_HOME=\"$root\"\n"
	script += "exec \"$root/releases/$revision/bin/zenchron\" \"$@\"\n"
	return []byte(script)
}

func localEntrypointPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve user home: %w", err)
	}
	return filepath.Join(home, ".local", "bin", "zenchron-engineering"), nil
}

func verifyReplaceableEntrypoint(path string, expected []byte) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing Zenchron command: %w", err)
	}
	if info.Mode().IsRegular() && info.Size() <= 4096 {
		contents, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read existing Zenchron command: %w", err)
		}
		if bytes.Equal(contents, expected) || bytes.Contains(contents, []byte(managedEntrypointMarker)) {
			return nil
		}
	}
	if info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		build, err := buildinfo.ReadFile(path)
		if err == nil && isZenchronModule(build.Main.Path) {
			return nil
		}
	}
	return errors.New("refusing to replace an existing zenchron-engineering command that is not a Zenchron installation")
}

func isZenchronModule(module string) bool {
	return module == currentZenchronModule || module == legacyZenchronModule
}

func migrateShadowingZenchronCommands(canonical string) error {
	paths, err := shadowingCommandPaths(canonical)
	if err != nil {
		return err
	}
	for _, path := range paths {
		if isZenchronExecutable(path) {
			if err := retireZenchronCommand(path); err != nil {
				return err
			}
			continue
		}
		return fmt.Errorf("PATH resolves zenchron-engineering to %s before canonical entrypoint %s; refusing to replace an unrelated command", path, canonical)
	}
	return nil
}

func validateEntrypointPath(canonical string) error {
	if err := verifyReplaceableEntrypoint(canonical, nil); err != nil {
		return err
	}
	if isZenchronExecutable(canonical) {
		if err := validateStaleCommandRecoveryPath(canonical); err != nil {
			return err
		}
	}
	paths, err := shadowingCommandPaths(canonical)
	if err != nil {
		return err
	}
	for _, path := range paths {
		if !isZenchronExecutable(path) {
			return fmt.Errorf("PATH resolves zenchron-engineering to %s before canonical entrypoint %s; refusing to replace an unrelated command", path, canonical)
		}
		if err := validateStaleCommandRecoveryPath(path); err != nil {
			return err
		}
	}
	return nil
}

func retireZenchronCommand(path string) error {
	retired := path + ".legacy"
	if err := validateStaleCommandRecoveryPath(path); err != nil {
		return err
	}
	if sameFile(path, retired) {
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("finish retiring stale Zenchron command %s: %w", path, err)
		}
		return nil
	}
	if err := os.Link(path, retired); err != nil {
		return fmt.Errorf("preserve stale Zenchron command %s before migration: %w", path, err)
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("recovery copy is preserved at %s but stale command %s remains: %w", retired, path, err)
	}
	return nil
}

func validateStaleCommandRecoveryPath(path string) error {
	retired := path + ".legacy"
	if _, err := os.Lstat(retired); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect stale Zenchron recovery path %s: %w", retired, err)
	}
	if sameFile(path, retired) {
		return nil
	}
	return fmt.Errorf("cannot migrate stale Zenchron command %s because its recovery path already exists at %s", path, retired)
}

func shadowingCommandPaths(canonical string) ([]string, error) {
	paths, err := commandPaths()
	if err != nil {
		return nil, err
	}
	for index, path := range paths {
		if path == canonical {
			return paths[:index], nil
		}
	}
	return paths, nil
}

func isZenchronExecutable(path string) bool {
	build, err := buildinfo.ReadFile(path)
	return err == nil && isZenchronModule(build.Main.Path)
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func addLocalBinToZshPath() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".zprofile")
	mode := os.FileMode(0o600)
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("resolve zsh profile: %w", err)
	} else if _, lstatErr := os.Lstat(path); lstatErr == nil {
		return errors.New("refusing to replace a broken zsh profile symlink")
	} else if !errors.Is(lstatErr, os.ErrNotExist) {
		return fmt.Errorf("inspect zsh profile symlink: %w", lstatErr)
	}
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect zsh profile: %w", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read zsh profile: %w", err)
	}
	if strings.Contains(string(contents), "# Zenchron managed entrypoint") {
		return nil
	}
	addition := "\n# Zenchron managed entrypoint\nexport PATH=\"$HOME/.local/bin:$PATH\"\n"
	return writeInstallFile(path, append(contents, []byte(addition)...), mode)
}

func installLaunchAgent(home, entrypoint string) error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	launchDir := filepath.Join(userHome, "Library", "LaunchAgents")
	logDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(launchDir, 0o700); err != nil {
		return fmt.Errorf("create LaunchAgents directory: %w", err)
	}
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return fmt.Errorf("create managed logs directory: %w", err)
	}
	plist := filepath.Join(launchDir, managedLaunchAgentLabel+".plist")
	environment, err := launchEnvironment()
	if err != nil {
		return err
	}
	contents := renderLaunchAgent(entrypoint, userHome, logDir, environment)
	if err := writeInstallFile(plist, contents, 0o600); err != nil {
		return fmt.Errorf("write managed LaunchAgent: %w", err)
	}
	uid, err := user.Current()
	if err != nil {
		return fmt.Errorf("resolve current user for LaunchAgent: %w", err)
	}
	domain := "gui/" + uid.Uid
	if _, err := exec.Command("launchctl", "print", domain+"/"+managedLaunchAgentLabel).CombinedOutput(); err == nil {
		output, err := exec.Command("launchctl", "bootout", domain, plist).CombinedOutput()
		if err != nil {
			return fmt.Errorf("stop existing managed LaunchAgent: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if output, err := exec.Command("launchctl", "bootstrap", domain, plist).CombinedOutput(); err != nil {
		return fmt.Errorf("start managed LaunchAgent: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func renderLaunchAgent(entrypoint, home, logDir string, environment map[string]string) []byte {
	var body strings.Builder
	body.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	body.WriteString("<plist version=\"1.0\"><dict>")
	writePlistString(&body, "Label", managedLaunchAgentLabel)
	body.WriteString("<key>ProgramArguments</key><array>")
	for _, argument := range []string{entrypoint, "managed"} {
		writePlistValue(&body, argument)
	}
	body.WriteString("</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>")
	writePlistString(&body, "WorkingDirectory", home)
	writePlistString(&body, "StandardOutPath", filepath.Join(logDir, "stdout.log"))
	writePlistString(&body, "StandardErrorPath", filepath.Join(logDir, "stderr.log"))
	body.WriteString("<key>EnvironmentVariables</key><dict>")
	for key, value := range environment {
		writePlistString(&body, key, value)
	}
	body.WriteString("</dict></dict></plist>\n")
	return []byte(body.String())
}

func writePlistString(body *strings.Builder, key, value string) {
	body.WriteString("<key>")
	xml.EscapeText(body, []byte(key))
	body.WriteString("</key><string>")
	xml.EscapeText(body, []byte(value))
	body.WriteString("</string>")
}

func writePlistValue(body *strings.Builder, value string) {
	body.WriteString("<string>")
	xml.EscapeText(body, []byte(value))
	body.WriteString("</string>")
}

func launchEnvironment() (map[string]string, error) {
	keys := []string{"ZENCHRON_UPDATE_REPOSITORY", "ZENCHRON_DATA_DIR", "ZENCHRON_GITHUB_TOKEN", "ZENCHRON_GITHUB_APP_ID",
		"ZENCHRON_GITHUB_INSTALLATION_ID", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", "ZENCHRON_GITHUB_CLIENT_ID",
		"ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_GITHUB_WEBHOOK_SECRET", "ZENCHRON_SESSION_SECRET", "ZENCHRON_GITHUB_ALLOWED_USERS",
		"ZENCHRON_PUBLIC_URL", "ZENCHRON_WORKER_TOKEN", "ZENCHRON_ACCESS_FILE", "ZENCHRON_PROJECTS_ROOT",
		"ZENCHRON_WORKER_CONFIG", "ZENCHRON_WORKER_CONFIG_PATH", "ZENCHRON_WORKER_CONCURRENCY", "ZENCHRON_RUN_LIMITS",
		"ZENCHRON_RUN_TIMEOUT", "ZENCHRON_RUN_INACTIVITY_TIMEOUT", "ZENCHRON_RUN_TOOL_TIMEOUT",
		"ZENCHRON_VERIFY_TIMEOUT", "ZENCHRON_WORKTREES_ROOT"}
	path := os.Getenv("PATH")
	if path == "" {
		path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	}
	managed, err := managedHome()
	if err != nil {
		return nil, err
	}
	environment := map[string]string{"PATH": path, "ZENCHRON_MANAGED_HOME": managed}
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			environment[key] = value
		}
	}
	data, err := managedDataDirectory(managed)
	if err != nil {
		return nil, err
	}
	environment["ZENCHRON_DATA_DIR"] = data
	statusToken, err := randomToken(32)
	if err != nil {
		return nil, fmt.Errorf("generate local status credential: %w", err)
	}
	environment["ZENCHRON_LOCAL_STATUS_TOKEN"] = statusToken
	return environment, nil
}

func writeInstallFile(path string, contents []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, contents, mode); err != nil {
		return err
	}
	if err := os.Chmod(temporary, mode); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}

func showManagedStatus() error {
	response, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://127.0.0.1:8080/api/v1/system/update")
	if err != nil {
		return printPersistedManagedStatus("managed update API is unavailable: " + err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return printPersistedManagedStatus(fmt.Sprintf("managed update API returned HTTP %d", response.StatusCode))
	}
	var status updater.Status
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		return fmt.Errorf("decode managed status: %w", err)
	}
	encoded, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func printPersistedManagedStatus(reason string) error {
	home, err := managedHome()
	if err != nil {
		return err
	}
	dataDir, err := managedDataDirectory(home)
	if err != nil {
		return err
	}
	status, err := updater.ReadStatus(filepath.Join(dataDir, "system-update.json"))
	if err != nil {
		return fmt.Errorf("%s; persisted update status is unavailable: %w", reason, err)
	}
	encoded, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	fmt.Fprintln(os.Stderr, reason+"; showing the last persisted update state")
	return nil
}

func showManagedDoctor() error {
	home, err := managedHome()
	if err != nil {
		return err
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	canonical := filepath.Join(userHome, ".local", "bin", "zenchron-engineering")
	resolved, lookupErr := exec.LookPath("zenchron-engineering")
	if lookupErr == nil {
		resolved, err = filepath.Abs(resolved)
		if err != nil {
			return err
		}
	}
	active, activeErr := updater.ActiveRelease(home)
	activeBinary := ""
	if activeErr == nil {
		activeBinary = filepath.Join(home, "releases", active, "bin", "zenchron")
		repository := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_REPOSITORY"))
		if repository == "" {
			repository = "bogdaniel/zenchron-engineering-os"
		}
		if _, err := updater.VerifyRelease(filepath.Join(home, "releases", active), updater.Candidate{
			Repository: repository, Commit: active, Tree: readReleaseTree(home, active),
		}); err != nil {
			activeErr = fmt.Errorf("active release verification failed: %w", err)
		} else if err := syscall.Access(activeBinary, 1); err != nil {
			activeErr = fmt.Errorf("active release executable is not executable: %w", err)
		}
	}
	paths, pathErr := commandPaths()
	if pathErr != nil {
		return pathErr
	}
	shadowing := make([]string, 0)
	for _, path := range paths {
		if path == canonical {
			break
		}
		shadowing = append(shadowing, path)
	}
	expectedEntrypoint := managedEntrypointContents(home)
	entrypointInfo, entrypointErr := readManagedEntrypoint(canonical, expectedEntrypoint)
	reachesActive := lookupErr == nil && activeErr == nil && entrypointErr == nil && sameFileInfo(entrypointInfo, resolved) && sameFileInfo(entrypointInfo, canonical)
	report := map[string]any{"canonical_entrypoint": canonical, "resolved_entrypoint": resolved,
		"active_revision": active, "active_binary": activeBinary, "reaches_active": reachesActive,
		"entrypoint_valid": entrypointErr == nil, "shadowing_entries": shadowing}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	if lookupErr != nil {
		return fmt.Errorf("canonical Zenchron command is not on PATH: %w", lookupErr)
	}
	if activeErr != nil {
		return fmt.Errorf("managed active release is unavailable: %w", activeErr)
	}
	if entrypointErr != nil {
		return fmt.Errorf("canonical Zenchron entrypoint is invalid: %w", entrypointErr)
	}
	if !reachesActive {
		return errors.New("PATH resolves zenchron-engineering to a shadowing entry instead of the canonical release")
	}
	return nil
}

func readManagedEntrypoint(path string, expected []byte) (os.FileInfo, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("canonical Zenchron command is not a regular file")
	}
	contents, err := io.ReadAll(io.LimitReader(file, int64(len(expected)+1)))
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(contents, expected) {
		return nil, errors.New("canonical Zenchron command does not match the managed launcher")
	}
	return info, nil
}

func sameFileInfo(opened os.FileInfo, path string) bool {
	if opened == nil {
		return false
	}
	current, err := os.Stat(path)
	return err == nil && os.SameFile(opened, current)
}

func commandPaths() ([]string, error) {
	paths := make([]string, 0)
	for _, directory := range filepath.SplitList(os.Getenv("PATH")) {
		if directory == "" {
			continue
		}
		path := filepath.Join(directory, "zenchron-engineering")
		info, err := os.Stat(path)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			absolute, err := filepath.Abs(path)
			if err != nil {
				return nil, fmt.Errorf("resolve PATH entry for zenchron-engineering: %w", err)
			}
			paths = append(paths, absolute)
		}
	}
	return paths, nil
}

func sameFile(first, second string) bool {
	firstInfo, firstErr := os.Stat(first)
	secondInfo, secondErr := os.Stat(second)
	return firstErr == nil && secondErr == nil && os.SameFile(firstInfo, secondInfo)
}

func startManaged() error {
	if runtime.GOOS != "darwin" {
		return errors.New("the managed local installation currently requires macOS LaunchAgents")
	}
	current, err := user.Current()
	if err != nil {
		return fmt.Errorf("resolve current user: %w", err)
	}
	domain := "gui/" + current.Uid
	if output, err := exec.Command("launchctl", "kickstart", domain+"/"+managedLaunchAgentLabel).CombinedOutput(); err != nil {
		return fmt.Errorf("managed installation is not loaded; run zenchron-engineering install first: %w: %s", err,
			strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("open", "http://127.0.0.1:8080/?mode=live").CombinedOutput(); err != nil {
		return fmt.Errorf("managed runtime started, but could not open the dashboard: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
