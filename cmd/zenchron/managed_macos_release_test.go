package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

func TestManagedReleaseInstallsAndUpdatesMenuBarBundleUnderDisposableHome(t *testing.T) {
	root := t.TempDir()
	home, managedHome := filepath.Join(root, "home"), filepath.Join(root, "managed")
	repository := "test/zenchron"
	// The fake open command prevents this Go-only HOME override from reaching the packaged app.
	t.Setenv("HOME", home)
	t.Setenv("ZENCHRON_UPDATE_REPOSITORY", repository)
	tools := filepath.Join(root, "tools")
	if err := os.MkdirAll(tools, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "ditto"), []byte("#!/bin/sh\ncp -R \"$1\" \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	launchCapture := filepath.Join(root, "open-capture")
	openScript := strings.Join([]string{
		"#!/bin/sh",
		`[ "$1" = "-g" ] || exit 2`,
		`printf '%s|' "$(cat "$2/Contents/MacOS/zenchron-menubar")" > "$ZENCHRON_TEST_OPEN_CAPTURE"`,
		`cat "$ZENCHRON_MANAGED_HOME/active-release" >> "$ZENCHRON_TEST_OPEN_CAPTURE"`,
		"",
	}, "\n")
	if err := os.WriteFile(filepath.Join(tools, "open"), []byte(openScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_TEST_OPEN_CAPTURE", launchCapture)
	t.Setenv("ZENCHRON_MANAGED_HOME", managedHome)
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))

	writeRelease := func(revision, executable string) {
		t.Helper()
		release := filepath.Join(managedHome, "releases", revision)
		const appContents = "macos/Zenchron Menu Bar.app/Contents/"
		files := map[string]string{
			"bin/zenchron": "control plane", "bin/zenchron-worker": "worker", "dashboard/index.html": "dashboard",
			appContents + "Info.plist": "<plist><dict><key>CFBundleIdentifier</key><string>" + managedMenuBarBundleID +
				"</string></dict></plist>",
			appContents + "MacOS/zenchron-menubar": executable,
		}
		manifest := updater.Manifest{
			Repository: repository, Commit: revision, Tree: strings.Repeat("b", 40),
			StateSchemaVersion: 1, ControlPlaneProtocolVersion: 1, WorkerProtocolVersion: 1,
			Platform: "darwin-arm64", Artifacts: make(map[string]string, len(files)),
		}
		for relative, content := range files {
			path := filepath.Join(release, filepath.FromSlash(relative))
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			mode := os.FileMode(0o600)
			if strings.HasSuffix(relative, "zenchron-menubar") {
				mode = 0o700
			}
			if err := os.WriteFile(path, []byte(content), mode); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256([]byte(content))
			manifest.Artifacts[relative] = hex.EncodeToString(digest[:])
		}
		data, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(release, "release.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	firstRevision, secondRevision := strings.Repeat("1", 40), strings.Repeat("2", 40)
	writeRelease(firstRevision, "release-one")
	if err := updater.SetActiveRelease(managedHome, firstRevision); err != nil {
		t.Fatal(err)
	}
	if err := installManagedMenuBarAppAtHome(managedHome, firstRevision, home); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(home, "Applications", "Zenchron Menu Bar.app")
	first, err := os.ReadFile(filepath.Join(installed, "Contents", "MacOS", "zenchron-menubar"))
	if err != nil || string(first) != "release-one" {
		t.Fatalf("first managed app = %q, %v", first, err)
	}

	writeRelease(secondRevision, "release-two")
	if err := installManagedMenuBarAppAtHome(managedHome, secondRevision, home); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(filepath.Join(installed, "Contents", "MacOS", "zenchron-menubar"))
	if err != nil || string(second) != "release-two" {
		t.Fatalf("updated managed app = %q, %v", second, err)
	}

	runtime := &managedRuntime{
		home: managedHome, statusPath: filepath.Join(managedHome, "data", "system-update.json"),
		status:          updater.Status{RunningRevision: firstRevision, LatestRevision: secondRevision, State: "activating"},
		supervisorToken: "test-supervisor",
		client: &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
			header := make(http.Header)
			header.Set("Content-Type", "text/html")
			status := http.StatusOK
			body := "<html>Zenchron</html>"
			if request.Method == http.MethodDelete {
				if request.Header.Get("X-Zenchron-Supervisor-Token") != "test-supervisor" {
					return nil, errors.New("update admission request was not authenticated")
				}
				status, body = http.StatusNoContent, ""
			}
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)),
				Header: header, Request: request}, nil
		})},
	}
	if err := runtime.activateRelease(context.Background(), secondRevision); err != nil {
		t.Fatalf("managed activation did not install and launch the candidate companion: %v", err)
	}
	opened, err := os.ReadFile(launchCapture)
	if err != nil || string(opened) != "release-two|"+firstRevision+"\n" {
		t.Fatalf("companion launched with %q before activation, %v", opened, err)
	}
	if active, err := updater.ActiveRelease(managedHome); err != nil || active != secondRevision {
		t.Fatalf("candidate activation pointer = %q, %v", active, err)
	}

	artifact := filepath.Join(managedHome, "releases", secondRevision, "macos", "Zenchron Menu Bar.app",
		"Contents", "MacOS", "zenchron-menubar")
	if err := os.WriteFile(artifact, []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := installManagedMenuBarAppAtHome(managedHome, secondRevision, home); err == nil {
		t.Fatal("tampered menu-bar artifact was installed")
	}
	retained, err := os.ReadFile(filepath.Join(installed, "Contents", "MacOS", "zenchron-menubar"))
	if err != nil || string(retained) != "release-two" {
		t.Fatalf("failed release changed installed app to %q, %v", retained, err)
	}
}
