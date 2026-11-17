package main

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
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
		if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' '"+revision+"'\n"), 0o700); err != nil {
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
		if err != nil || strings.TrimSpace(string(output)) != revision {
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
	previousArgs := os.Args
	os.Args = []string{"zenchron-engineering", "doctor"}
	defer func() { os.Args = previousArgs }()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	previousStdout := os.Stdout
	os.Stdout = writer
	doctorErr := run()
	_ = writer.Close()
	os.Stdout = previousStdout
	defer reader.Close()
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
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
	if err := os.WriteFile(profile, []byte("export PATH=\"$HOME/bin:$PATH\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := addLocalBinToZshPath(); err != nil {
		t.Fatal(err)
	}
	if err := addLocalBinToZshPath(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(profile)
	if err != nil || strings.Count(string(contents), "$HOME/.local/bin") != 1 {
		t.Fatalf("zsh profile PATH setup = %q, %v", contents, err)
	}
}
