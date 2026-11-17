package main

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

type managedTestTransport func(*http.Request) (*http.Response, error)

func (transport managedTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestManagedRuntimeStopsSiblingAfterChildFailure(t *testing.T) {
	workingDirectory := t.TempDir()
	runtime := &managedRuntime{}
	var err error
	runtime.api, err = startManagedChild("/bin/sh", []string{"-c", "exit 7"}, workingDirectory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	worker, err := startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, workingDirectory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	runtime.worker = worker
	childErr := <-runtime.api.done
	if err := runtime.stopAfterChildExit("control plane", childErr); err == nil {
		t.Fatal("unexpected control-plane exit was not reported")
	}
	if runtime.api != nil || runtime.worker != nil {
		t.Fatalf("managed children remained owned after failure: api=%v worker=%v", runtime.api, runtime.worker)
	}
	if worker.command.ProcessState == nil {
		t.Fatal("sibling worker process was left running")
	}
}

func TestManagedRuntimePreservesCLIChildrenUntilActiveRunsReachSafeBoundary(t *testing.T) {
	directory := t.TempDir()
	firstActiveCount := make(chan struct{}, 1)
	secondActiveCount := make(chan struct{}, 1)
	releaseZeroCount := make(chan struct{})
	activeChecks := 0
	runtime := &managedRuntime{statusPath: filepath.Join(directory, "system-update.json"), status: updater.Status{State: "waiting_for_runs"},
		client: &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
			if strings.HasSuffix(request.URL.Path, "/quiesce") {
				return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody, Header: make(http.Header), Request: request}, nil
			}
			activeChecks++
			if activeChecks == 1 {
				firstActiveCount <- struct{}{}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"active_runs":1}`)), Header: make(http.Header), Request: request}, nil
			}
			secondActiveCount <- struct{}{}
			<-releaseZeroCount
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"active_runs":0}`)), Header: make(http.Header), Request: request}, nil
		})}}
	var err error
	runtime.api, err = startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	runtime.worker, err = startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	worker := runtime.worker
	defer func() {
		select {
		case releaseZeroCount <- struct{}{}:
		default:
		}
		_ = runtime.stopChildren()
	}()

	stopped := make(chan error, 1)
	go func() { stopped <- runtime.stopSafely() }()
	select {
	case <-firstActiveCount:
	case <-time.After(5 * time.Second):
		t.Fatal("managed runtime did not inspect the active run count")
	}
	select {
	case <-secondActiveCount:
	case err := <-stopped:
		t.Fatalf("managed runtime stopped before rechecking active runs: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("managed runtime did not recheck active runs")
	}
	if worker.command.ProcessState != nil {
		t.Fatal("worker was stopped while an active CLI run remained")
	}
	if err := worker.command.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("active CLI child was not preserved at the safe boundary: %v", err)
	}
	releaseZeroCount <- struct{}{}
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatalf("safe managed shutdown failed after active runs drained: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("managed runtime did not stop after the active run count reached zero")
	}
	if worker.command.ProcessState == nil {
		t.Fatal("worker was not stopped after all CLI attempts drained")
	}
}

func TestReleaseTransitionRequiresSameStateSchemaAndCandidateProtocolPair(t *testing.T) {
	current := updater.Manifest{StateSchemaVersion: 1, ControlPlaneProtocolVersion: 1, WorkerProtocolVersion: 1}
	candidate := updater.Manifest{StateSchemaVersion: 1, ControlPlaneProtocolVersion: 2, WorkerProtocolVersion: 2}
	if err := releaseTransitionCompatibility(current, candidate); err != nil {
		t.Fatalf("compatible paired protocol transition refused: %v", err)
	}
	candidate.StateSchemaVersion++
	if err := releaseTransitionCompatibility(current, candidate); err == nil {
		t.Fatal("incompatible durable-state schema accepted")
	}
	candidate.StateSchemaVersion = current.StateSchemaVersion
	candidate.WorkerProtocolVersion++
	if err := releaseTransitionCompatibility(current, candidate); err == nil {
		t.Fatal("mismatched candidate control-plane/worker protocols accepted")
	}
}

func TestReleasePointerAdvancesOnlyAfterDashboardProof(t *testing.T) {
	root := t.TempDir()
	old := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	for _, revision := range []string{old, candidate} {
		if err := os.MkdirAll(filepath.Join(root, "releases", revision), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := updater.SetActiveRelease(root, old); err != nil {
		t.Fatal(err)
	}
	makeRuntime := func(statusCode int) *managedRuntime {
		return &managedRuntime{home: root, statusPath: filepath.Join(root, "data", "system-update.json"),
			status:          updater.Status{RunningRevision: old, LatestRevision: candidate, State: "activating"},
			supervisorToken: "test-supervisor", client: &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
				if request.Method == http.MethodDelete {
					if request.Header.Get("X-Zenchron-Supervisor-Token") != "test-supervisor" {
						return nil, errors.New("missing supervisor authentication")
					}
					return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody, Header: make(http.Header), Request: request}, nil
				}
				header := make(http.Header)
				header.Set("Content-Type", "text/html")
				return &http.Response{StatusCode: statusCode, Body: io.NopCloser(strings.NewReader("<html>zenchron</html>")), Header: header, Request: request}, nil
			})}}
	}
	failed := makeRuntime(http.StatusServiceUnavailable)
	if err := failed.activateRelease(candidate); err == nil {
		t.Fatal("activation accepted an unavailable dashboard")
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != old {
		t.Fatalf("failed dashboard proof changed active pointer to %q: %v", active, err)
	}
	if failed.status.State != "activating" {
		t.Fatalf("failed dashboard proof claimed state %q", failed.status.State)
	}
	ready := makeRuntime(http.StatusOK)
	if err := ready.activateRelease(candidate); err != nil {
		t.Fatal(err)
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != candidate {
		t.Fatalf("verified activation pointer = %q, %v", active, err)
	}
	if ready.status.State != "active" || ready.status.RunningRevision != candidate {
		t.Fatalf("verified activation status = %#v", ready.status)
	}
	if persisted, err := updater.ReadStatus(ready.statusPath); err != nil || persisted.State != "active" {
		t.Fatalf("persisted activation = %#v, %v", persisted, err)
	}
}
