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
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
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

func TestShutdownStopsChildrenWhenAdmissionPauseFails(t *testing.T) {
	directory := t.TempDir()
	client := &http.Client{Transport: managedTestTransport(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("control plane did not respond")
	})}
	runtime := &managedRuntime{client: client}
	var err error
	runtime.api, err = startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	runtime.worker, err = startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		if stopErr := runtime.api.stop(time.Second); stopErr != nil {
			t.Errorf("stop test control plane: %v", stopErr)
		}
		t.Fatal(err)
	}
	if err := runtime.stopSafely(); err == nil {
		t.Fatal("shutdown hid the admission pause failure")
	}
	if runtime.api != nil || runtime.worker != nil {
		t.Fatalf("shutdown left children owned: api=%v worker=%v", runtime.api, runtime.worker)
	}
}

func TestFailedCandidateWaitsForExplicitRetryOrNewMain(t *testing.T) {
	failed := "0123456789abcdef0123456789abcdef01234567"
	newer := "abcdef0123456789abcdef0123456789abcdef01"
	status := updater.Status{LastFailedRevision: failed}
	if !shouldDeferFailedCandidate(status, failed, "previous", false) {
		t.Fatal("automatic poll retried the same failed release")
	}
	if shouldDeferFailedCandidate(status, failed, "previous", true) {
		t.Fatal("explicit operator retry was suppressed")
	}
	if shouldDeferFailedCandidate(status, newer, "previous", false) {
		t.Fatal("new trusted main was suppressed by an older failure")
	}
	if shouldDeferFailedCandidate(status, failed, failed, false) {
		t.Fatal("currently running failed revision remained in failed state")
	}
}

func TestFailUpdatePersistsUTF8SafeBoundedReason(t *testing.T) {
	path := filepath.Join(t.TempDir(), "system-update.json")
	runtime := &managedRuntime{statusPath: path, status: updater.Status{LatestRevision: "0123456789abcdef0123456789abcdef01234567"}}
	reason := strings.Repeat("a", 499) + "✓" + strings.Repeat("x", 20)
	if err := runtime.failUpdate("failed", reason); err == nil {
		t.Fatal("failed update was reported as successful")
	}
	status, err := updater.ReadStatus(path)
	if err != nil {
		t.Fatalf("read persisted update status: %v", err)
	}
	if len(status.LastFailureReason) > 500 || !utf8.ValidString(status.LastFailureReason) {
		t.Fatalf("persisted failure reason has invalid size or encoding: %d bytes, valid UTF-8=%t",
			len(status.LastFailureReason), utf8.ValidString(status.LastFailureReason))
	}
	if status.LastFailureReason != strings.Repeat("a", 499) {
		t.Fatalf("persisted failure reason = %q, want truncated text before split rune", status.LastFailureReason)
	}
}

func TestOnlyFailedUpdatesSuppressAutomaticRetry(t *testing.T) {
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	for _, test := range []struct {
		state     string
		wantDefer bool
	}{
		{state: "blocked"},
		{state: "failed", wantDefer: true},
	} {
		t.Run(test.state, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "system-update.json")
			runtime := &managedRuntime{statusPath: path, status: updater.Status{LatestRevision: candidate}}
			if err := runtime.failUpdate(test.state, "transient fetch failure"); err == nil {
				t.Fatal("update failure was not reported")
			}
			status, err := updater.ReadStatus(path)
			if err != nil || status.State != test.state || status.LastFailureReason == "" {
				t.Fatalf("persisted update status = %#v, %v", status, err)
			}
			if got := shouldDeferFailedCandidate(status, candidate, "previous", false); got != test.wantDefer {
				t.Fatalf("automatic retry defer = %t, want %t", got, test.wantDefer)
			}
		})
	}
}

func TestManagedRuntimePreservesCLIChildrenUntilActiveRunsReachSafeBoundary(t *testing.T) {
	directory := t.TempDir()
	firstActiveCount := make(chan struct{}, 1)
	secondActiveCount := make(chan struct{}, 1)
	releaseZeroCount := make(chan struct{})
	var releaseOnce sync.Once
	releaseZero := func() { releaseOnce.Do(func() { close(releaseZeroCount) }) }
	activeChecks := 0
	runtime := &managedRuntime{statusPath: filepath.Join(directory, "system-update.json"), status: updater.Status{State: "waiting_for_runs"},
		supervisorToken: "test-supervisor",
		client: &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
			if strings.HasSuffix(request.URL.Path, "/quiesce") {
				return &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody, Header: make(http.Header), Request: request}, nil
			}
			if request.Header.Get("X-Zenchron-Supervisor-Token") != "test-supervisor" {
				return nil, errors.New("active-run request omitted supervisor token")
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
	stopped := make(chan error, 1)
	go func() { stopped <- runtime.stopSafely() }()
	stopCompleted := false
	defer func() {
		releaseZero()
		if !stopCompleted {
			select {
			case err := <-stopped:
				if err != nil {
					t.Errorf("managed shutdown cleanup failed: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Error("managed shutdown did not finish during cleanup")
			}
		}
	}()

	select {
	case <-firstActiveCount:
	case <-time.After(5 * time.Second):
		t.Fatal("managed runtime did not inspect the active run count")
	}
	select {
	case <-secondActiveCount:
	case err := <-stopped:
		stopCompleted = true
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
	releaseZero()
	select {
	case err := <-stopped:
		stopCompleted = true
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

func TestActivationRollbackStopsAtDurablePointerBoundary(t *testing.T) {
	root := t.TempDir()
	previous := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	if err := updater.SetActiveRelease(root, previous); err != nil {
		t.Fatal(err)
	}
	if !activationCanRollback(root, previous, candidate) {
		t.Fatal("pre-activation pointer did not permit recovery to the previous release")
	}
	if err := updater.SetActiveRelease(root, candidate); err != nil {
		t.Fatal(err)
	}
	if activationCanRollback(root, previous, candidate) {
		t.Fatal("release pointer crossed its durable boundary but rollback remained allowed")
	}
	if err := updater.SetActiveRelease(root, "123456789abcdef0123456789abcdef012345678"); err != nil {
		t.Fatal(err)
	}
	if activationCanRollback(root, previous, candidate) {
		t.Fatal("unexpected active release was treated as a safe rollback boundary")
	}
	if activationCanRollback(filepath.Join(root, "missing"), previous, candidate) {
		t.Fatal("missing active pointer was treated as permission to roll back")
	}
}

func TestPreActivationRecoveryRestoresPreviousPointerAndFailureStatus(t *testing.T) {
	root := t.TempDir()
	previous := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	statusPath := filepath.Join(root, "data", "system-update.json")
	runtime := &managedRuntime{home: root, statusPath: statusPath,
		status: updater.Status{RunningRevision: previous, LatestRevision: candidate, State: "activating"}}
	if err := updater.SetActiveRelease(root, previous); err != nil {
		t.Fatal(err)
	}
	if err := runtime.restorePreviousRelease(errors.New("candidate failed before health proof")); err == nil {
		t.Fatal("recovery unexpectedly exec'd a missing previous binary")
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != previous {
		t.Fatalf("recovery active release = %q, %v", active, err)
	}
	status, err := updater.ReadStatus(statusPath)
	if err != nil || status.State != "failed" || status.LastFailedRevision != candidate ||
		!strings.Contains(status.LastFailureReason, "candidate failed before health proof") {
		t.Fatalf("recovery status = %#v, %v", status, err)
	}
}

func TestInterruptedCandidateStartupCannotRollBackAfterPointerAdvance(t *testing.T) {
	root := t.TempDir()
	previous := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	statusPath := filepath.Join(root, "data", "system-update.json")
	runtime := &managedRuntime{home: root, statusPath: statusPath,
		status: updater.Status{RunningRevision: previous, LatestRevision: candidate, State: "activating"}}
	if err := updater.SetActiveRelease(root, candidate); err != nil {
		t.Fatal(err)
	}
	if err := runtime.restorePreviousRelease(errors.New("candidate failed during startup")); err == nil ||
		!strings.Contains(err.Error(), "automatic rollback is blocked") {
		t.Fatalf("interrupted activation recovery error = %v", err)
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != candidate {
		t.Fatalf("startup recovery moved the active pointer to %q: %v", active, err)
	}
	status, err := updater.ReadStatus(statusPath)
	if err != nil || status.State != "blocked" || status.RunningRevision != "" ||
		status.LastFailedRevision != candidate || !strings.Contains(status.BlockReason, "durable boundary") {
		t.Fatalf("blocked recovery status = %#v, %v", status, err)
	}
}

func TestInvalidInterruptedCandidateIsPersistentlyBlocked(t *testing.T) {
	home, dataDir := t.TempDir(), t.TempDir()
	previous := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	if err := updater.SetActiveRelease(home, candidate); err != nil {
		t.Fatal(err)
	}
	statusPath := filepath.Join(dataDir, "system-update.json")
	status := updater.Status{RunningRevision: previous, LatestRevision: candidate, State: "activating"}
	if err := updater.WriteStatus(statusPath, status); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_MANAGED_HOME", home)
	t.Setenv("ZENCHRON_DATA_DIR", dataDir)
	t.Setenv("ZENCHRON_MANAGED_REVISION", "")
	if err := runManaged(); err == nil || !strings.Contains(err.Error(), "automatic rollback is blocked") {
		t.Fatalf("invalid interrupted candidate recovery error = %v", err)
	}
	active, err := updater.ActiveRelease(home)
	if err != nil || active != candidate {
		t.Fatalf("invalid candidate recovery moved active pointer to %q: %v", active, err)
	}
	persisted, err := updater.ReadStatus(statusPath)
	if err != nil || persisted.State != "blocked" || persisted.RunningRevision != "" || persisted.LastFailedRevision != candidate {
		t.Fatalf("invalid candidate recovery status = %#v, %v", persisted, err)
	}
}

func TestBlockedActivationRecoverySurvivesSupervisorRestart(t *testing.T) {
	const restartTestEnv = "ZENCHRON_TEST_BLOCKED_ACTIVATION_RESTART"
	if os.Getenv(restartTestEnv) == "1" {
		err := runManaged()
		if err == nil || !strings.Contains(err.Error(), "control plane and worker were not started") {
			t.Fatalf("blocked supervisor restart returned %v", err)
		}
		return
	}

	home := t.TempDir()
	dataDir := filepath.Join(home, "state")
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	tree := "0123456789abcdef0123456789abcdef01234567"
	marker := filepath.Join(home, "child-started")
	releaseDir := filepath.Join(home, "releases", candidate)
	controlPlane := "#!/bin/sh\nprintf started >> \"$ZENCHRON_BLOCKED_START_MARKER\"\nexit 0\n"
	worker := controlPlane
	dashboard := "<html>candidate</html>"
	artifacts := map[string]string{"bin/zenchron": controlPlane, "bin/zenchron-worker": worker,
		"dashboard/index.html": dashboard}
	for path, content := range artifacts {
		fullPath := filepath.Join(releaseDir, path)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	manifest := updater.Manifest{Repository: "bogdaniel/zenchron-engineering-os", Commit: candidate, Tree: tree,
		StateSchemaVersion: updater.StateSchemaVersion, ControlPlaneProtocolVersion: workerapi.ProtocolVersion,
		WorkerProtocolVersion: workerapi.ProtocolVersion, Artifacts: make(map[string]string, len(artifacts))}
	for path, content := range artifacts {
		digest := sha256.Sum256([]byte(content))
		manifest.Artifacts[path] = hex.EncodeToString(digest[:])
	}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "release.json"), manifestData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := updater.SetActiveRelease(home, candidate); err != nil {
		t.Fatal(err)
	}
	status := updater.Status{State: "blocked", LatestRevision: candidate, LastFailedRevision: candidate,
		BlockReason: activationRecoveryBlockedReason, LastFailureReason: activationRecoveryBlockedReason}
	statusPath := filepath.Join(dataDir, "system-update.json")
	if err := updater.WriteStatus(statusPath, status); err != nil {
		t.Fatal(err)
	}

	command := exec.Command(os.Args[0], "-test.run=^TestBlockedActivationRecoverySurvivesSupervisorRestart$")
	command.Env = withEnvironment(os.Environ(), map[string]string{
		"ZENCHRON_MANAGED_HOME": home, "ZENCHRON_DATA_DIR": dataDir,
		"ZENCHRON_BLOCKED_START_MARKER": marker, restartTestEnv: "1",
	})
	output, err := command.CombinedOutput()
	if _, markerErr := os.Stat(marker); !errors.Is(markerErr, os.ErrNotExist) {
		t.Fatalf("candidate child started after blocked supervisor restart; stat error=%v, output=%s", markerErr, output)
	}
	if err != nil {
		t.Fatalf("blocked supervisor restart failed: %v\n%s", err, output)
	}
	active, err := updater.ActiveRelease(home)
	if err != nil || active != candidate {
		t.Fatalf("blocked supervisor restart changed active release to %q: %v", active, err)
	}
	after, err := updater.ReadStatus(statusPath)
	if err != nil || after.State != status.State || after.RunningRevision != "" || after.LatestRevision != candidate ||
		after.BlockReason != status.BlockReason || after.LastFailedRevision != candidate {
		t.Fatalf("blocked status changed during supervisor restart: %#v, %v", after, err)
	}
}

func TestReleasePointerAdvancesOnlyAfterDashboardProof(t *testing.T) {
	root := t.TempDir()
	old := "0123456789abcdef0123456789abcdef01234567"
	candidate := "abcdef0123456789abcdef0123456789abcdef01"
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	t.Setenv("PATH", filepath.Join(userHome, ".local", "bin")+string(os.PathListSeparator)+"/usr/bin:/bin")
	for _, revision := range []string{old, candidate} {
		binary := filepath.Join(root, "releases", revision, "bin", "zenchron")
		if err := os.MkdirAll(filepath.Dir(binary), 0o700); err != nil {
			t.Fatal(err)
		}
		contents := "#!/bin/sh\nprintf '%s %s' '" + revision + "' \"$ZENCHRON_MANAGED_HOME\"\n"
		if err := os.WriteFile(binary, []byte(contents), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := updater.SetActiveRelease(root, old); err != nil {
		t.Fatal(err)
	}
	entrypoint, err := installStableEntrypoint(root)
	if err != nil {
		t.Fatal(err)
	}
	entrypointInfo, err := os.Stat(entrypoint)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command(entrypoint, "inspect-self").Output(); err != nil ||
		strings.TrimSpace(string(output)) != old+" "+root {
		t.Fatalf("initial public command returned %q, %v", output, err)
	}
	makeRuntime := func(statusCode, admissionStatus int, status updater.Status) *managedRuntime {
		return &managedRuntime{home: root, statusPath: filepath.Join(root, "data", "system-update.json"),
			status:          status,
			supervisorToken: "test-supervisor", client: &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
				if request.Method == http.MethodDelete {
					if request.Header.Get("X-Zenchron-Supervisor-Token") != "test-supervisor" {
						return nil, errors.New("missing supervisor authentication")
					}
					return &http.Response{StatusCode: admissionStatus, Body: http.NoBody, Header: make(http.Header), Request: request}, nil
				}
				header := make(http.Header)
				header.Set("Content-Type", "text/html")
				return &http.Response{StatusCode: statusCode, Body: io.NopCloser(strings.NewReader("<html>zenchron</html>")), Header: header, Request: request}, nil
			})}}
	}
	initial := updater.Status{RunningRevision: old, LatestRevision: candidate, State: "activating"}
	failed := makeRuntime(http.StatusServiceUnavailable, http.StatusNoContent, initial)
	if err := failed.activateRelease(context.Background(), candidate); err == nil {
		t.Fatal("activation accepted an unavailable dashboard")
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != old {
		t.Fatalf("failed dashboard proof changed active pointer to %q: %v", active, err)
	}
	if failed.status.State != "activating" {
		t.Fatalf("failed dashboard proof claimed state %q", failed.status.State)
	}
	ready := makeRuntime(http.StatusOK, http.StatusNoContent, initial)
	if err := ready.activateRelease(context.Background(), candidate); err != nil {
		t.Fatal(err)
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != candidate {
		t.Fatalf("verified activation pointer = %q, %v", active, err)
	}
	if output, err := exec.Command("zenchron-engineering", "inspect-self").Output(); err != nil ||
		strings.TrimSpace(string(output)) != candidate+" "+root {
		t.Fatalf("public command after activation returned %q, %v", output, err)
	}
	currentEntrypointInfo, err := os.Stat(entrypoint)
	if err != nil || !os.SameFile(entrypointInfo, currentEntrypointInfo) {
		t.Fatalf("activation replaced the public entrypoint: %v", err)
	}
	if ready.status.State != "active" || ready.status.RunningRevision != candidate {
		t.Fatalf("verified activation status = %#v", ready.status)
	}
	if persisted, err := updater.ReadStatus(ready.statusPath); err != nil || persisted.State != "active" {
		t.Fatalf("persisted activation = %#v, %v", persisted, err)
	}
	if err := updater.SetActiveRelease(root, old); err != nil {
		t.Fatal(err)
	}
	interrupted := makeRuntime(http.StatusOK, http.StatusInternalServerError, initial)
	if err := updater.WriteStatus(interrupted.statusPath, initial); err != nil {
		t.Fatal(err)
	}
	if err := interrupted.activateRelease(context.Background(), candidate); err == nil {
		t.Fatal("activation reported success after run admission failed to reopen")
	}
	if active, err := updater.ActiveRelease(root); err != nil || active != candidate {
		t.Fatalf("post-pointer activation failure rolled back to %q: %v", active, err)
	}
	persisted, err := updater.ReadStatus(interrupted.statusPath)
	if err != nil || persisted.State != "activating" || persisted.LastSuccessRevision != "" {
		t.Fatalf("post-pointer failure claimed successful activation: %#v, %v", persisted, err)
	}
	recovered, err := updater.ReadStatus(interrupted.statusPath)
	if err != nil {
		t.Fatal(err)
	}
	restarted := makeRuntime(http.StatusOK, http.StatusNoContent, recovered)
	if err := restarted.activateRelease(context.Background(), candidate); err != nil {
		t.Fatalf("activation retry after pointer advance: %v", err)
	}
	if status, err := updater.ReadStatus(restarted.statusPath); err != nil || status.State != "active" || status.RunningRevision != candidate {
		t.Fatalf("recovered activation state = %#v, %v", status, err)
	}
}
