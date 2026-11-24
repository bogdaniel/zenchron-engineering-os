package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestStableEntrypointFollowsTwoSuccessiveReleases(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("PATH", filepath.Join(userHome, ".local", "bin")+string(os.PathListSeparator)+"/usr/bin:/bin")
	managedHome := filepath.Join(userHome, ".config", "Zenchron")
	first := "0123456789abcdef0123456789abcdef01234567"
	second := "abcdef0123456789abcdef0123456789abcdef01"
	for _, revision := range []string{first, second} {
		binary := filepath.Join(managedHome, "releases", revision, "bin", "zenchron")
		if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s %s' '"+revision+"' \"$ZENCHRON_MANAGED_HOME\"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	entrypoint, err := installStableEntrypoint(managedHome)
	if err != nil {
		t.Fatal(err)
	}
	if repeated, err := installStableEntrypoint(managedHome); err != nil || repeated != entrypoint {
		t.Fatalf("repeated installation changed the entrypoint: %q, %v", repeated, err)
	}
	for _, revision := range []string{first, second} {
		if err := updater.SetActiveRelease(managedHome, revision); err != nil {
			t.Fatal(err)
		}
		output, err := exec.Command(entrypoint, "status").Output()
		if err != nil || strings.TrimSpace(string(output)) != revision+" "+managedHome {
			t.Fatalf("entrypoint for %s returned %q, %v", revision, output, err)
		}
	}
	if _, err := os.Stat(filepath.Join(userHome, ".local", "bin", "zenchron-engineering")); err != nil {
		t.Fatalf("stable public entrypoint missing: %v", err)
	}
}

func TestLaunchEnvironmentResolvesRelativeStateDirectory(t *testing.T) {
	workingDirectory := t.TempDir()
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(workingDirectory); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chdir(previousDirectory); err != nil {
			t.Error(err)
		}
	}()
	t.Setenv("ZENCHRON_DATA_DIR", "relative-state")
	environment, err := launchEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.Abs("relative-state")
	if err != nil {
		t.Fatal(err)
	}
	if environment["ZENCHRON_DATA_DIR"] != want {
		t.Fatalf("LaunchAgent state directory = %q, want %q", environment["ZENCHRON_DATA_DIR"], want)
	}
	if len(environment["ZENCHRON_LOCAL_STATUS_TOKEN"]) != 43 {
		t.Fatalf("local status credential length = %d, want 43", len(environment["ZENCHRON_LOCAL_STATUS_TOKEN"]))
	}
}

func TestManagedLaunchAgentDoesNotForceKillGracefulShutdown(t *testing.T) {
	contents := renderLaunchAgent("entrypoint", "home", "logs", map[string]string{"PATH": "/usr/bin:/bin"})
	if !strings.Contains(string(contents), "<key>ExitTimeOut</key><integer>0</integer>") {
		t.Fatal("managed LaunchAgent does not allow the supervisor to finish graceful shutdown")
	}
	legacy := bytes.Replace(contents, []byte("<key>ExitTimeOut</key><integer>0</integer>"),
		[]byte("<key>ExitTimeOut</key><integer>20</integer>"), 1)
	updated, err := withLaunchAgentExitTimeout(legacy)
	if err != nil || !bytes.Contains(updated, []byte("<key>ExitTimeOut</key><integer>0</integer>")) {
		t.Fatalf("LaunchAgent reload did not remove its finite shutdown timeout: error=%v", err)
	}
}

func TestEnsureManagedAgentRepairsLoadedLaunchAgentWithoutRestart(t *testing.T) {
	userHome := t.TempDir()
	managed := filepath.Join(userHome, "installation")
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_MANAGED_HOME", managed)
	commands := filepath.Join(t.TempDir(), "launchctl.log")
	commandDirectory := t.TempDir()
	launchctl := filepath.Join(commandDirectory, "launchctl")
	if err := os.WriteFile(launchctl, []byte("#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$COMMAND_LOG\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("COMMAND_LOG", commands)
	t.Setenv("PATH", commandDirectory+string(os.PathListSeparator)+os.Getenv("PATH"))

	launchDirectory := filepath.Join(userHome, "Library", "LaunchAgents")
	if err := os.MkdirAll(launchDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(launchDirectory, managedLaunchAgentLabel+".plist")
	entrypoint := filepath.Join(userHome, ".local", "bin", "zenchron-engineering")
	contents := renderLaunchAgent(entrypoint, userHome, filepath.Join(managed, "logs"), map[string]string{
		"PATH": "/usr/bin:/bin", "ZENCHRON_DATA_DIR": filepath.Join(userHome, "state"),
	})
	if err := os.WriteFile(plist, contents, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := ensureManagedAgent(managed, entrypoint); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(plist)
	if err != nil {
		t.Fatal(err)
	}
	token, found, err := launchAgentStatusCredential(updated)
	if err != nil || !found || len(token) != 43 {
		t.Fatalf("repaired LaunchAgent credential = %q, found %t, error %v", token, found, err)
	}
	log, err := os.ReadFile(commands)
	if err != nil || string(log) != "print\n" {
		t.Fatalf("loaded agent commands = %q, %v; want no restart", log, err)
	}

	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", "")
	if got := localStatusCredential(); got != token {
		t.Fatalf("status credential from repaired LaunchAgent = %q, want %q", got, token)
	}
	if err := ensureManagedAgent(managed, entrypoint); err != nil {
		t.Fatal(err)
	}
	unchanged, err := os.ReadFile(plist)
	if err != nil || string(unchanged) != string(updated) {
		t.Fatalf("repeated install rotated the existing credential: %v", err)
	}
	log, err = os.ReadFile(commands)
	if err != nil || string(log) != "print\nprint\n" {
		t.Fatalf("repeated loaded-agent commands = %q, %v; want no restart", log, err)
	}
}

func TestStableEntrypointRefusesToReplaceUnrelatedCommand(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	path := filepath.Join(userHome, ".local", "bin", "zenchron-engineering")
	t.Setenv("PATH", filepath.Dir(path)+string(os.PathListSeparator)+"/usr/bin:/bin")
	contents := []byte("#!/bin/sh\necho user command\n")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := installStableEntrypoint(filepath.Join(userHome, "managed")); err == nil {
		t.Fatal("installer replaced an unrelated existing command")
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != string(contents) {
		t.Fatalf("unrelated command changed to %q: %v", actual, err)
	}
}

func TestInstallMigratesLegacyCommandBeforeCanonicalEntrypoint(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	root := t.TempDir()
	legacyDirectory := filepath.Join(root, "legacy-bin")
	canonicalDirectory := filepath.Join(userHome, ".local", "bin")
	if err := os.MkdirAll(legacyDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	legacyModule := filepath.Join(root, "legacy-source")
	if err := os.MkdirAll(legacyModule, 0o700); err != nil {
		t.Fatal(err)
	}
	goMod := "module github.com/bogdaniel/zenchron-engineering\n\ngo 1.23\n"
	if err := os.WriteFile(filepath.Join(legacyModule, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatal(err)
	}
	mainSource := "package main\nfunc main() {}\n"
	if err := os.WriteFile(filepath.Join(legacyModule, "main.go"), []byte(mainSource), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyCommand := filepath.Join(legacyDirectory, "zenchron-engineering")
	path := strings.Join([]string{legacyDirectory, canonicalDirectory, "/usr/bin", "/bin"}, string(os.PathListSeparator))
	build := exec.Command("go", "build", "-o", legacyCommand, ".")
	build.Dir = legacyModule
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build legacy fixture: %v: %s", err, output)
	}
	t.Setenv("PATH", path)
	recoveryCopy := legacyCommand + ".legacy"
	copyContents := []byte("preexisting recovery data")
	if err := os.WriteFile(recoveryCopy, copyContents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateEntrypointPath(canonicalDirectory + string(os.PathSeparator) + "zenchron-engineering"); err == nil {
		t.Fatal("installer accepted a conflicting legacy recovery path")
	}
	if contents, err := os.ReadFile(recoveryCopy); err != nil || string(contents) != string(copyContents) {
		t.Fatalf("existing recovery data changed to %q: %v", contents, err)
	}
	if err := os.Remove(recoveryCopy); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(legacyCommand, recoveryCopy); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(canonicalDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(canonicalDirectory, "zenchron-engineering")
	if err := os.Link(legacyCommand, canonical); err != nil {
		t.Fatal(err)
	}
	managedHome := filepath.Join(userHome, ".config", "Zenchron")
	entrypoint, err := installStableEntrypoint(managedHome)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacyCommand); !os.IsNotExist(err) {
		t.Fatalf("stale PATH command remains at its public name: %v", err)
	}
	if _, err := os.Stat(recoveryCopy); err != nil {
		t.Fatalf("stale command recovery copy was not preserved: %v", err)
	}
	if _, err := os.Stat(canonical + ".legacy"); err != nil {
		t.Fatalf("canonical legacy binary recovery copy was not preserved: %v", err)
	}
	resolved, err := exec.LookPath("zenchron-engineering")
	if err != nil || resolved != entrypoint {
		t.Fatalf("PATH resolves %q, %v; want canonical entrypoint %q", resolved, err, entrypoint)
	}
	if _, err := installStableEntrypoint(managedHome); err != nil {
		t.Fatalf("repeat installation: %v", err)
	}
	if _, err := os.Stat(legacyCommand + ".legacy.legacy"); !os.IsNotExist(err) {
		t.Fatalf("repeated install created another migration copy: %v", err)
	}
}

func TestInstallRefusesUnrelatedEarlierPathCommand(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	root := t.TempDir()
	first := filepath.Join(root, "first")
	canonicalDirectory := filepath.Join(userHome, ".local", "bin")
	for _, directory := range []string{first, canonicalDirectory} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	shadow := filepath.Join(first, "zenchron-engineering")
	contents := []byte("#!/bin/sh\necho unrelated\n")
	if err := os.WriteFile(shadow, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", first+string(os.PathListSeparator)+canonicalDirectory)
	_, err := installStableEntrypoint(filepath.Join(userHome, "managed"))
	if err == nil || !strings.Contains(err.Error(), shadow) {
		t.Fatalf("install error = %v; want explicit unrelated PATH shadow %s", err, shadow)
	}
	actual, err := os.ReadFile(shadow)
	if err != nil || string(actual) != string(contents) {
		t.Fatalf("unrelated command changed to %q: %v", actual, err)
	}
}

func TestStableEntrypointDoesNotFallBackWhenActiveReleaseIsMissing(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("PATH", filepath.Join(userHome, ".local", "bin")+string(os.PathListSeparator)+"/usr/bin:/bin")
	managedHome := filepath.Join(userHome, ".config", "Zenchron")
	if err := updater.SetActiveRelease(managedHome, "0123456789abcdef0123456789abcdef01234567"); err != nil {
		t.Fatal(err)
	}
	entrypoint, err := installStableEntrypoint(managedHome)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(entrypoint, "status").CombinedOutput(); err == nil {
		t.Fatalf("entrypoint unexpectedly ran without active binary: %q", output)
	}
}

func TestDoctorRejectsAlteredCanonicalEntrypoint(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_UPDATE_REPOSITORY", "bogdaniel/zenchron-engineering-os")
	managedHome := filepath.Join(userHome, ".config", "Zenchron")
	t.Setenv("ZENCHRON_MANAGED_HOME", managedHome)
	t.Setenv("PATH", filepath.Join(userHome, ".local", "bin")+string(os.PathListSeparator)+"/usr/bin:/bin")
	revision := "0123456789abcdef0123456789abcdef01234567"
	writeManagedReleaseFixture(t, managedHome, revision)
	entrypoint, err := installStableEntrypoint(managedHome)
	if err != nil {
		t.Fatal(err)
	}
	output, doctorErr := captureDoctorOutput(t)
	var report struct {
		Reaches  bool   `json:"reaches_active"`
		Valid    bool   `json:"entrypoint_valid"`
		Revision string `json:"active_revision"`
	}
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("doctor output %q is not JSON: %v", output, err)
	}
	if doctorErr != nil || !report.Reaches || !report.Valid || report.Revision != revision {
		t.Fatalf("doctor result = %#v, error %v; wanted the current managed launcher to be healthy", report, doctorErr)
	}
	activeBinary := filepath.Join(managedHome, "releases", revision, "bin", "zenchron")
	if err := os.Chmod(activeBinary, 0o601); err != nil {
		t.Fatal(err)
	}
	output, doctorErr = captureDoctorOutput(t)
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("doctor output %q is not JSON: %v", output, err)
	}
	if doctorErr == nil || !strings.Contains(doctorErr.Error(), "not executable") || report.Reaches || !report.Valid {
		t.Fatalf("doctor result = %#v, error %v; wanted a broken active binary to fail closed", report, doctorErr)
	}
	if err := os.Chmod(activeBinary, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	output, doctorErr = captureDoctorOutput(t)
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("doctor output %q is not JSON: %v", output, err)
	}
	if doctorErr == nil || !strings.Contains(doctorErr.Error(), "canonical Zenchron entrypoint is invalid") ||
		report.Reaches || report.Valid || report.Revision != revision {
		t.Fatalf("doctor result = %#v, error %v; wanted a broken launcher to fail closed", report, doctorErr)
	}
}

func TestReadManagedEntrypointRejectsNamedPipe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zenchron-engineering")
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedEntrypoint(path, []byte("expected")); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("readManagedEntrypoint() error = %v; want a non-regular-file error", err)
	}
}

func TestManagedEntrypointIdentityDetectsPathReplacement(t *testing.T) {
	directory := t.TempDir()
	canonical := filepath.Join(directory, "canonical")
	shadow := filepath.Join(directory, "shadow")
	expected := []byte("managed launcher")
	for _, path := range []string{canonical, shadow} {
		if err := os.WriteFile(path, expected, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	opened, err := readManagedEntrypoint(canonical, expected)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(canonical); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(shadow, canonical); err != nil {
		t.Fatal(err)
	}
	if sameFileInfo(opened, canonical) {
		t.Fatal("replaced canonical launcher still matches the opened file identity")
	}
}

func writeManagedReleaseFixture(t *testing.T, home, revision string) {
	t.Helper()
	tree := "abcdef0123456789abcdef0123456789abcdef01"
	releaseDir := filepath.Join(home, "releases", revision)
	artifacts := map[string]string{"bin/zenchron": "control-plane", "bin/zenchron-worker": "worker",
		"dashboard/index.html": "dashboard"}
	repository := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_REPOSITORY"))
	if repository == "" {
		repository = "bogdaniel/zenchron-engineering-os"
	}
	manifest := updater.Manifest{Repository: repository, Commit: revision, Tree: tree,
		StateSchemaVersion: updater.StateSchemaVersion, ControlPlaneProtocolVersion: workerapi.ProtocolVersion,
		WorkerProtocolVersion: workerapi.ProtocolVersion, Artifacts: make(map[string]string, len(artifacts))}
	for path, content := range artifacts {
		fullPath := filepath.Join(releaseDir, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o700); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(content))
		manifest.Artifacts[path] = hex.EncodeToString(digest[:])
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "release.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := updater.SetActiveRelease(home, revision); err != nil {
		t.Fatal(err)
	}
}

func captureDoctorOutput(t *testing.T) ([]byte, error) {
	t.Helper()
	previousArgs := os.Args
	os.Args = []string{"zenchron-engineering", "doctor"}
	defer func() { os.Args = previousArgs }()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = writer
	defer func() {
		os.Stdout = previousStdout
		_ = writer.Close()
	}()
	doctorErr := run()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stdout = previousStdout
	defer reader.Close()
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return output, doctorErr
}

func TestCommandPathDiagnosticFindsEarlierShadowingExecutable(t *testing.T) {
	root := t.TempDir()
	first, second := filepath.Join(root, "bin-one"), filepath.Join(root, "bin-two")
	for _, directory := range []string{first, second} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "zenchron-engineering"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", first+string(os.PathListSeparator)+second)
	paths, err := commandPaths()
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 || paths[0] != filepath.Join(first, "zenchron-engineering") || paths[1] != filepath.Join(second, "zenchron-engineering") {
		t.Fatalf("commandPaths() = %#v", paths)
	}
	resolved, err := exec.LookPath("zenchron-engineering")
	if err != nil || resolved != paths[0] {
		t.Fatalf("PATH resolves %q, %v; want earlier stale entry %q", resolved, err, paths[0])
	}
}

func TestDoctorReportsShadowingCommandAndDoesNotPass(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	managedHome := filepath.Join(userHome, "managed")
	t.Setenv("ZENCHRON_MANAGED_HOME", managedHome)
	first := filepath.Join(userHome, "stale-bin")
	canonical := filepath.Join(userHome, ".local", "bin")
	for _, directory := range []string{first, canonical} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	shadow := filepath.Join(first, "zenchron-engineering")
	for _, path := range []string{shadow, filepath.Join(canonical, "zenchron-engineering")} {
		if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	revision := "0123456789abcdef0123456789abcdef01234567"
	if err := updater.SetActiveRelease(managedHome, revision); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", first+string(os.PathListSeparator)+canonical+string(os.PathListSeparator)+"/usr/bin:/bin")
	output, doctorErr := captureDoctorOutput(t)
	var report struct {
		Resolved  string   `json:"resolved_entrypoint"`
		Reaches   bool     `json:"reaches_active"`
		Shadowing []string `json:"shadowing_entries"`
	}
	if err := json.Unmarshal(output, &report); err != nil {
		t.Fatalf("doctor output %q is not JSON: %v", output, err)
	}
	if doctorErr == nil || report.Resolved != shadow || report.Reaches || len(report.Shadowing) != 1 || report.Shadowing[0] != shadow {
		t.Fatalf("doctor result = %#v, error %v; expected the winning shadow to be reported as unhealthy", report, doctorErr)
	}
}

func TestZshPathSetupPrependsCanonicalCommandDirectoryOnce(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	profile := filepath.Join(userHome, ".zprofile")
	dotfile := filepath.Join(userHome, "dotfiles", "zprofile")
	if err := os.MkdirAll(filepath.Dir(dotfile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dotfile, []byte("export PATH=\"$HOME/bin:$PATH\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dotfile, profile); err != nil {
		t.Fatal(err)
	}
	if err := addLocalBinToZshPath(); err != nil {
		t.Fatal(err)
	}
	if err := addLocalBinToZshPath(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(profile)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("managed setup replaced the symlinked zsh profile: %v", err)
	}
	contents, err := os.ReadFile(dotfile)
	if err != nil || strings.Count(string(contents), "$HOME/.local/bin") != 1 {
		t.Fatalf("zsh profile PATH setup = %q, %v", contents, err)
	}
	if info, err := os.Stat(dotfile); err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("zsh profile mode = %v, %v; want 0644", info, err)
	}
}
