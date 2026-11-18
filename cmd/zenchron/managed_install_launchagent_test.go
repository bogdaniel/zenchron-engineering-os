package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallLaunchAgentUsesManagedEntrypoint(t *testing.T) {
	userHome := t.TempDir()
	managedHome := filepath.Join(userHome, ".config", "Zenchron")
	entrypoint := filepath.Join(userHome, ".local", "bin", "zenchron-engineering")
	launchctlDirectory := t.TempDir()
	launchctlLog := filepath.Join(t.TempDir(), "launchctl.log")
	if err := os.WriteFile(filepath.Join(launchctlDirectory, "launchctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"\nif [ \"$1\" = print ]; then exit 1; fi\n[ \"$1\" = bootstrap ]\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", userHome)
	t.Setenv("ZENCHRON_MANAGED_HOME", managedHome)
	t.Setenv("LAUNCHCTL_LOG", launchctlLog)
	t.Setenv("PATH", launchctlDirectory+string(os.PathListSeparator)+"/usr/bin:/bin")

	if err := installLaunchAgent(managedHome, entrypoint); err != nil {
		t.Fatal(err)
	}

	currentUser, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(userHome, "Library", "LaunchAgents", managedLaunchAgentLabel+".plist")
	info, err := os.Stat(plist)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("LaunchAgent permissions = %04o, want 0600", info.Mode().Perm())
	}
	contents, err := os.ReadFile(plist)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{entrypoint, "<string>managed</string>", "<key>RunAtLoad</key><true/>", "<key>KeepAlive</key><true/>"} {
		if !strings.Contains(string(contents), expected) {
			t.Errorf("LaunchAgent plist does not contain %q", expected)
		}
	}
	commands, err := os.ReadFile(launchctlLog)
	if err != nil {
		t.Fatal(err)
	}
	want := "print gui/" + currentUser.Uid + "/" + managedLaunchAgentLabel + "\n" +
		"bootstrap gui/" + currentUser.Uid + " " + plist + "\n"
	if string(commands) != want {
		t.Fatalf("launchctl calls = %q, want %q", commands, want)
	}
	if err := os.WriteFile(filepath.Join(launchctlDirectory, "launchctl"), []byte("#!/bin/sh\nif [ \"$1\" = print ]; then exit 1; fi\nprintf 'bootstrap denied\\n' >&2\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := installLaunchAgent(managedHome, entrypoint); err == nil || !strings.Contains(err.Error(), "bootstrap denied") {
		t.Fatalf("LaunchAgent bootstrap failure = %v, want the launchctl error", err)
	}
}
