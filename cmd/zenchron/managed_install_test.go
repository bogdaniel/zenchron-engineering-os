package main

import (
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

func TestStableEntrypointDoesNotFallBackWhenActiveReleaseIsMissing(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
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
