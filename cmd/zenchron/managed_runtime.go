package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	updatePollInterval    = 5 * time.Minute
	updateHealthTimeout   = 30 * time.Second
	updateRunPollInterval = 2 * time.Second
)

type managedRuntime struct {
	home            string
	data            string
	statusPath      string
	repository      string
	status          updater.Status
	client          *http.Client
	supervisorToken string
	api             *managedChild
	worker          *managedChild
}

type managedChild struct {
	command *exec.Cmd
	done    chan error
}

func runManaged() error {
	home, err := managedHome()
	if err != nil {
		return err
	}
	lock, err := acquireControlPlaneLock(filepath.Join(home, "manager"))
	if err != nil {
		return fmt.Errorf("managed runtime already owns this installation: %w", err)
	}
	defer lock.Close()
	active, err := updater.ActiveRelease(home)
	if err != nil {
		return fmt.Errorf("managed installation is not initialized; run zenchron-engineering install: %w", err)
	}
	commit := strings.TrimSpace(os.Getenv("ZENCHRON_MANAGED_REVISION"))
	if commit == "" {
		commit = active
	}
	if len(commit) != 40 || strings.Trim(commit, "0123456789abcdef") != "" {
		return errors.New("managed release override is invalid")
	}
	repository := strings.TrimSpace(os.Getenv("ZENCHRON_UPDATE_REPOSITORY"))
	if repository == "" {
		repository = "bogdaniel/zenchron-engineering-os"
	}
	dataDir, err := managedDataDirectory(home)
	if err != nil {
		return err
	}
	runtime := &managedRuntime{home: home, data: dataDir,
		statusPath: filepath.Join(dataDir, "system-update.json"), repository: repository,
		client: &http.Client{Timeout: 10 * time.Second}}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return fmt.Errorf("create supervisor API credential: %w", err)
	}
	runtime.supervisorToken = hex.EncodeToString(token)
	status, err := updater.ReadStatus(runtime.statusPath)
	if err == nil {
		runtime.status = status
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read managed update status: %w", err)
	}
	activationCandidate := runtime.status.State == "activating" && runtime.status.LatestRevision == commit &&
		runtime.status.RunningRevision != "" && runtime.status.RunningRevision != commit
	if runtime.status.State == "activating" && runtime.status.LatestRevision != active && commit == active {
		runtime.status.State = "failed"
		runtime.status.LastFailure = time.Now().UTC()
		runtime.status.LastFailedRevision = runtime.status.LatestRevision
		runtime.status.BlockReason = "Candidate activation was interrupted before release identity was proven; previous release remains active"
		runtime.status.LastFailureReason = runtime.status.BlockReason
		if err := runtime.writeStatus(); err != nil {
			return err
		}
	}
	manifest, err := updater.VerifyRelease(filepath.Join(home, "releases", commit), updater.Candidate{
		Repository: repository, Commit: commit, Tree: readReleaseTree(home, commit),
	})
	if err != nil {
		return fmt.Errorf("active managed release is invalid: %w", err)
	}
	if manifest.StateSchemaVersion != updater.StateSchemaVersion || manifest.ControlPlaneProtocolVersion != workerapi.ProtocolVersion ||
		manifest.WorkerProtocolVersion != workerapi.ProtocolVersion {
		return errors.New("active release is incompatible with its own control-plane or worker binary")
	}
	if err := runtime.startRelease(commit); err != nil {
		if !activationCandidate && !(runtime.status.State == "activating" && runtime.status.LatestRevision == commit) {
			return err
		}
		if stopErr := runtime.stopChildren(); stopErr != nil {
			return fmt.Errorf("candidate startup failed (%v) and candidate services did not stop cleanly: %w", err, stopErr)
		}
		return runtime.restorePreviousRelease(err)
	}
	if runtime.status.State == "activating" && runtime.status.LatestRevision == commit {
		if err := runtime.activateRelease(commit); err != nil {
			if !activationCanRollback(home, runtime.status.RunningRevision, commit) {
				return fmt.Errorf("release activation crossed its durable boundary; recovery is required: %w", err)
			}
			if stopErr := runtime.stopChildren(); stopErr != nil {
				return fmt.Errorf("candidate health failed (%v) and candidate services did not stop cleanly: %w", err, stopErr)
			}
			return runtime.restorePreviousRelease(err)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	checks := make(chan os.Signal, 1)
	signal.Notify(checks, syscall.SIGUSR1)
	defer signal.Stop(checks)
	ticker := time.NewTicker(updatePollInterval)
	defer ticker.Stop()
	if err := runtime.checkAndUpdate(ctx, commit, false); err != nil {
		logManagedError(err)
	}
	for {
		if runtime.api == nil || runtime.worker == nil {
			return errors.New("managed runtime lost a required child process")
		}
		select {
		case <-ctx.Done():
			return runtime.stopSafely()
		case err := <-runtime.api.done:
			return runtime.stopAfterChildExit("control plane", err)
		case err := <-runtime.worker.done:
			return runtime.stopAfterChildExit("local worker", err)
		case <-checks:
			if err := runtime.checkAndUpdate(ctx, commit, true); err != nil {
				logManagedError(err)
			}
		case <-ticker.C:
			if err := runtime.checkAndUpdate(ctx, commit, false); err != nil {
				logManagedError(err)
			}
		}
	}
}

func (runtime *managedRuntime) stopAfterChildExit(name string, childErr error) error {
	if childErr == nil {
		childErr = errors.New("process exited unexpectedly")
	}
	return errors.Join(fmt.Errorf("managed %s stopped: %w", name, childErr), runtime.stopChildren())
}

func (runtime *managedRuntime) startRelease(commit string) error {
	release := filepath.Join(runtime.home, "releases", commit)
	base := os.Environ()
	apiEnv := withEnvironment(base, map[string]string{
		"ZENCHRON_LISTEN_ADDR": "127.0.0.1:8080", "ZENCHRON_DATA_DIR": runtime.data,
		"ZENCHRON_DASHBOARD_DIR":    filepath.Join(release, "dashboard"),
		"ZENCHRON_RELEASE_REVISION": commit, "ZENCHRON_UPDATE_STATUS_FILE": runtime.statusPath,
		"ZENCHRON_MANAGED_SUPERVISOR_PID":   strconv.Itoa(os.Getpid()),
		"ZENCHRON_MANAGED_SUPERVISOR_TOKEN": runtime.supervisorToken,
	})
	if runtime.status.State == "activating" && runtime.status.LatestRevision == commit {
		apiEnv = withEnvironment(apiEnv, map[string]string{"ZENCHRON_STARTUP_QUIESCED": "true"})
	}
	var err error
	runtime.api, err = startManagedChild(filepath.Join(release, "bin", "zenchron"), []string{"serve"}, runtime.home, apiEnv)
	if err != nil {
		return err
	}
	if err := waitManagedHealth(runtime.api, commit); err != nil {
		runtime.api.stop(5 * time.Second)
		return err
	}
	projectsRoot := strings.TrimSpace(os.Getenv("ZENCHRON_PROJECTS_ROOT"))
	if projectsRoot == "" {
		projectsRoot, _ = os.UserHomeDir()
	}
	workerEnv := managedWorkerEnvironment(base, projectsRoot, commit)
	runtime.worker, err = startManagedChild(filepath.Join(release, "bin", "zenchron-worker"), nil, projectsRoot, workerEnv)
	if err != nil {
		runtime.api.stop(5 * time.Second)
		return err
	}
	if err := waitManagedWorker(runtime.client, commit, runtime.supervisorToken); err != nil {
		runtime.worker.stop(5 * time.Second)
		runtime.api.stop(5 * time.Second)
		return err
	}
	if runtime.status.State != "activating" || runtime.status.LatestRevision != commit {
		runtime.status.RunningRevision = commit
	}
	runtime.status.WorkerCompatible = true
	if runtime.status.State == "" {
		runtime.status.State = "idle"
	}
	if err := runtime.writeStatus(); err != nil {
		runtime.worker.stop(5 * time.Second)
		runtime.api.stop(5 * time.Second)
		return err
	}
	return nil
}

func (runtime *managedRuntime) checkAndUpdate(ctx context.Context, current string, explicitRetry bool) error {
	runtime.status.State, runtime.status.Progress, runtime.status.BlockReason = "checking", "Checking trusted main and required checks", ""
	runtime.status.LastAttempt = time.Now().UTC()
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	github := newGitHubClient()
	candidate, err := github.trustedMain(ctx, runtime.repository)
	if err != nil {
		return runtime.failUpdate("blocked", "Could not verify trusted main: "+err.Error())
	}
	runtime.status.LatestRevision = candidate.Commit
	if shouldDeferFailedCandidate(runtime.status, candidate.Commit, explicitRetry) {
		runtime.status.State, runtime.status.Progress = "failed", ""
		runtime.status.BlockReason = runtime.status.LastFailureReason
		return runtime.writeStatus()
	}
	if candidate.Commit == current {
		runtime.status.State, runtime.status.Progress = "idle", "Running the latest trusted revision"
		return runtime.writeStatus()
	}
	runtime.status.State, runtime.status.Progress = "building", "Building control plane, worker and dashboard from the exact trusted source"
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	buildCtx, cancelBuild := context.WithTimeout(ctx, 30*time.Minute)
	credential, err := github.gitFetchCredential(buildCtx)
	if err != nil {
		cancelBuild()
		return runtime.failUpdate("blocked", "Could not authenticate the trusted source fetch: "+err.Error())
	}
	manifest, err := updater.BuildRelease(buildCtx, runtime.home, candidate, credential)
	cancelBuild()
	if err != nil {
		return runtime.failUpdate("failed", "Release build failed: "+err.Error())
	}
	runtime.status.State, runtime.status.Progress = "verifying", "Verifying source identity, release digests and compatibility"
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	if _, err := updater.VerifyRelease(filepath.Join(runtime.home, "releases", candidate.Commit), candidate); err != nil {
		return runtime.failUpdate("failed", "Release verification failed: "+err.Error())
	}
	oldManifest, err := updater.VerifyRelease(filepath.Join(runtime.home, "releases", current), updater.Candidate{
		Repository: runtime.repository, Commit: current, Tree: readReleaseTree(runtime.home, current),
	})
	if err != nil || releaseTransitionCompatibility(oldManifest, manifest) != nil {
		return runtime.failUpdate("blocked", "The candidate release is incompatible with the active durable state or worker protocol")
	}
	if err := verifyCurrentTrustedCandidate(ctx, newGitHubClient(), candidate); err != nil {
		return runtime.failUpdate("blocked", "Trusted main advanced or became unverifiable during preparation; the staged release was not activated")
	}
	runtime.status.State, runtime.status.Progress, runtime.status.WorkerCompatible = "waiting_for_runs", "Waiting for active CLI attempts to reach a safe boundary", true
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	if err := runtime.setQuiesced(true); err != nil {
		return runtime.failUpdate("failed", "Could not pause new run admission: "+err.Error())
	}
	quiesced := true
	defer func() {
		if quiesced {
			_ = runtime.setQuiesced(false)
		}
	}()
	if err := runtime.waitForActiveRuns(ctx); err != nil {
		return runtime.failUpdate("failed", "Could not wait for active runs to reach a safe boundary: "+err.Error())
	}
	if err := verifyCurrentTrustedCandidate(ctx, newGitHubClient(), candidate); err != nil {
		return runtime.failUpdate("blocked", "Trusted main advanced or became unverifiable while waiting for active runs; the staged release was not activated")
	}
	if err := runtime.stopChildren(); err != nil {
		return runtime.failUpdate("failed", "Could not stop the old release safely: "+err.Error())
	}
	runtime.status.State, runtime.status.Progress = "activating", "Starting the verified release and confirming its live identity"
	runtime.status.LatestRevision = candidate.Commit
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	argv := []string{filepath.Join(runtime.home, "releases", candidate.Commit, "bin", "zenchron"), "managed"}
	environment := withEnvironment(os.Environ(), map[string]string{
		"ZENCHRON_MANAGED_HOME": runtime.home, "ZENCHRON_MANAGED_REVISION": candidate.Commit,
	})
	if err := syscall.Exec(argv[0], argv, environment); err != nil {
		quiesced = false
		if startErr := runtime.startRelease(current); startErr != nil {
			return runtime.failUpdate("blocked", "Activation handoff failed and the previous release could not be restarted: "+startErr.Error())
		}
		return runtime.failUpdate("failed", "Could not replace the managed runtime: "+err.Error())
	}
	return nil
}

func shouldDeferFailedCandidate(status updater.Status, candidate string, explicitRetry bool) bool {
	return !explicitRetry && candidate != "" && candidate == status.LastFailedRevision
}

func activationCanRollback(home, previous, candidate string) bool {
	active, err := updater.ActiveRelease(home)
	return err == nil && previous != "" && previous != candidate && active == previous
}

func releaseTransitionCompatibility(current, candidate updater.Manifest) error {
	if current.StateSchemaVersion != candidate.StateSchemaVersion {
		return errors.New("candidate durable-state schema is incompatible with current state")
	}
	if candidate.ControlPlaneProtocolVersion != candidate.WorkerProtocolVersion {
		return errors.New("candidate control-plane and worker protocols do not match")
	}
	return nil
}

func (runtime *managedRuntime) restorePreviousRelease(startErr error) error {
	previous := runtime.status.RunningRevision
	if err := updater.SetActiveRelease(runtime.home, previous); err != nil {
		return fmt.Errorf("candidate startup failed (%v) and rollback pointer failed: %w", startErr, err)
	}
	runtime.status.State, runtime.status.LastFailure = "failed", time.Now().UTC()
	runtime.status.LastFailedRevision = runtime.status.LatestRevision
	runtime.status.BlockReason = boundedUpdateReason("New release failed its live health check: " + startErr.Error())
	runtime.status.LastFailureReason = runtime.status.BlockReason
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	oldBinary := filepath.Join(runtime.home, "releases", previous, "bin", "zenchron")
	argv := []string{oldBinary, "managed"}
	environment := withEnvironment(os.Environ(), map[string]string{
		"ZENCHRON_MANAGED_HOME": runtime.home, "ZENCHRON_MANAGED_REVISION": "",
	})
	if err := syscall.Exec(oldBinary, argv, environment); err != nil {
		return fmt.Errorf("candidate failed and the previous supervisor could not restart: %w", err)
	}
	return nil
}

func (runtime *managedRuntime) activateRelease(commit string) error {
	previous := runtime.status.RunningRevision
	if err := waitManagedDashboard(runtime.client); err != nil {
		return fmt.Errorf("dashboard release did not become healthy: %w", err)
	}
	if err := updater.SetActiveRelease(runtime.home, commit); err != nil {
		return err
	}
	if err := runtime.setQuiesced(false); err != nil {
		return fmt.Errorf("release identity is verified but run admission could not resume: %w", err)
	}
	runtime.status.RunningRevision, runtime.status.State = commit, "active"
	runtime.status.LastSuccess, runtime.status.LastSuccessRevision = time.Now().UTC(), commit
	runtime.status.WorkerCompatible, runtime.status.BlockReason = true, ""
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	if err := updater.RetainReleases(runtime.home, previous); err != nil {
		logManagedError(fmt.Errorf("release activated but old-release cleanup failed: %w", err))
	}
	return nil
}

func (runtime *managedRuntime) activeRunCount(ctx context.Context) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8080/api/v1/system/update/active-runs", nil)
	if err != nil {
		return 0, err
	}
	response, err := runtime.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("agent run API returned HTTP %d", response.StatusCode)
	}
	var result struct {
		ActiveRuns int `json:"active_runs"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&result); err != nil {
		return 0, err
	}
	if result.ActiveRuns < 0 {
		return 0, errors.New("control plane returned an invalid active run count")
	}
	return result.ActiveRuns, nil
}

func (runtime *managedRuntime) waitForActiveRuns(ctx context.Context) error {
	for {
		active, err := runtime.activeRunCount(ctx)
		if err != nil {
			return err
		}
		runtime.status.ActiveRuns = active
		if err := runtime.writeStatus(); err != nil {
			return err
		}
		if active == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(updateRunPollInterval):
		}
	}
}

func (runtime *managedRuntime) setQuiesced(quiesce bool) error {
	method, path := http.MethodDelete, "/api/v1/system/update/quiesce"
	if quiesce {
		method = http.MethodPost
	}
	request, err := http.NewRequest(method, "http://127.0.0.1:8080"+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("X-Zenchron-Supervisor-Token", runtime.supervisorToken)
	response, err := runtime.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("update transition API returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (runtime *managedRuntime) stopSafely() error {
	if runtime.api != nil {
		if err := runtime.setQuiesced(true); err != nil {
			return fmt.Errorf("pause run admission before shutdown: %w", err)
		}
		if err := runtime.waitForActiveRuns(context.Background()); err != nil {
			return err
		}
	}
	return runtime.stopChildren()
}

func (runtime *managedRuntime) stopChildren() error {
	if runtime.worker != nil {
		if err := runtime.worker.stop(30 * time.Second); err != nil {
			return err
		}
		runtime.worker = nil
	}
	if runtime.api != nil {
		if err := runtime.api.stop(10 * time.Second); err != nil {
			return err
		}
		runtime.api = nil
	}
	return nil
}

func (runtime *managedRuntime) failUpdate(state, reason string) error {
	runtime.status.State, runtime.status.Progress, runtime.status.BlockReason = state, "", boundedUpdateReason(reason)
	runtime.status.LastFailure = time.Now().UTC()
	runtime.status.LastFailedRevision, runtime.status.LastFailureReason = runtime.status.LatestRevision, runtime.status.BlockReason
	if err := runtime.writeStatus(); err != nil {
		return err
	}
	return errors.New(reason)
}

func (runtime *managedRuntime) writeStatus() error {
	return updater.WriteStatus(runtime.statusPath, runtime.status)
}

func readReleaseTree(home, commit string) string {
	manifest, err := os.ReadFile(filepath.Join(home, "releases", commit, "release.json"))
	if err != nil {
		return ""
	}
	var release updater.Manifest
	if json.Unmarshal(manifest, &release) != nil {
		return ""
	}
	return release.Tree
}

func boundedUpdateReason(reason string) string {
	if len(reason) > 500 {
		return reason[:500]
	}
	return reason
}

func logManagedError(err error) {
	fmt.Fprintln(os.Stderr, "Zenchron update:", boundedUpdateReason(err.Error()))
}
