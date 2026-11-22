package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// agentRunner owns the local half of a run: worktree, provider process, verification, commit and push.
type agentRunner struct {
	client    *http.Client
	baseURL   *url.URL
	workerID  string
	token     string
	providers map[string]*cliProvider
	limits    runLimits
	config    *workerConfig
	// guard is the command prefix that stops provider and verification processes when this worker dies:
	// this binary's own `guard` command. Empty runs them unguarded.
	guard []string
	// push publishes the run branch; nil uses pushAgentBranch. Tests replace this network boundary.
	push func(ctx context.Context, worktree, remote, branch string) error
	// finishRetryDelay overrides the pause between result deliveries; zero uses the default.
	finishRetryDelay time.Duration
	// slots bounds how many runs execute at once; running tracks them so the worker can wait for them.
	slots   chan struct{}
	running sync.WaitGroup
	// checkout serializes the Git commands that change a shared checkout's list of worktrees, which
	// concurrent runs of the same repository would otherwise race on.
	checkout sync.Mutex
}

func (runner *agentRunner) providerStatuses() []workerapi.ProviderStatus {
	statuses := make([]workerapi.ProviderStatus, 0, len(runner.providers))
	for _, provider := range runner.providers {
		if provider.path != "" {
			statuses = append(statuses, provider.status())
		}
	}
	slices.SortFunc(statuses, func(a, b workerapi.ProviderStatus) int { return strings.Compare(a.ID, b.ID) })
	return statuses
}

func (runner *agentRunner) canExecute() bool {
	for _, provider := range runner.providers {
		if provider.ready {
			return true
		}
	}
	return false
}

// process claims one run and executes it before returning.
func (runner *agentRunner) process(ctx context.Context, projects []discoveredProject) error {
	if !runner.canExecute() {
		return nil
	}
	command, found, err := claimAgentRun(ctx, runner.client, runner.baseURL, runner.workerID)
	if err != nil || !found {
		return err
	}
	return runner.execute(ctx, command, projects)
}

// dispatch claims runs for as long as a slot is free and executes each in its own goroutine, in its own
// worktree. It returns as soon as nothing more can start; wait blocks until the started runs are done.
func (runner *agentRunner) dispatch(ctx context.Context, projects []discoveredProject) error {
	if !runner.canExecute() {
		return nil
	}
	for {
		select {
		case runner.slots <- struct{}{}:
		default:
			return nil
		}
		command, found, err := claimAgentRun(ctx, runner.client, runner.baseURL, runner.workerID)
		if err != nil || !found {
			<-runner.slots
			return err
		}
		runner.running.Go(func() {
			defer func() { <-runner.slots }()
			if err := runner.execute(ctx, command, projects); err != nil {
				log.Printf("worker command failed: %v", err)
			}
		})
	}
}

// execute runs one claimed attempt and delivers its result.
func (runner *agentRunner) execute(ctx context.Context, command workerapi.AgentRunCommand, projects []discoveredProject) error {
	result, report := runner.run(ctx, command, projects)
	if !report {
		return fmt.Errorf("agent run %s attempt %d was interrupted; its worktree is kept for the next attempt",
			command.ID, command.Attempts)
	}
	result.Attempts = command.Attempts
	return runner.finish(ctx, command.ID, result)
}

func failedRun(reason, message string) workerapi.AgentRunResult {
	return failed(workerapi.AgentRunResult{}, reason, message)
}

// failed marks a result as failed while keeping the evidence already collected in it.
func failed(result workerapi.AgentRunResult, reason, message string) workerapi.AgentRunResult {
	result.Status, result.Error, result.TerminationReason = "failed", message, reason
	return result
}

// run executes one claimed attempt. It reports false when the attempt must not be finished by this
// worker: the worker is stopping or the control plane no longer recognizes the lease.
func (runner *agentRunner) run(
	ctx context.Context, command workerapi.AgentRunCommand, projects []discoveredProject,
) (workerapi.AgentRunResult, bool) {
	index := slices.IndexFunc(projects, func(project discoveredProject) bool { return project.ID == command.ProjectID })
	if index < 0 {
		return failedRun(workerapi.TerminationWorkerError, "Project checkout is unavailable."), true
	}
	project := projects[index]
	if command.Branch != workerapi.AgentRunBranch(command.ID) {
		return failedRun(workerapi.TerminationWorkerError, "Run branch is not the branch authorized for this run."), true
	}
	// An integration run combines branches with Git and starts no provider.
	var provider *cliProvider
	if len(command.Merge) == 0 {
		if !modelPattern.MatchString(command.Profile.Model) {
			return failedRun(workerapi.TerminationWorkerError, "The agent profile's model name is not valid for a CLI provider."), true
		}
		provider = runner.providers[command.Profile.Provider]
		if provider == nil || !provider.ready {
			return failedRun(workerapi.TerminationWorkerError, "The agent provider is not ready on this worker."), true
		}
	}
	root, err := worktreeRoot()
	if err != nil {
		return failedRun(workerapi.TerminationWorkerError, "Could not prepare an isolated branch."), true
	}
	worktree := filepath.Join(root, project.ID, command.ID)
	activeCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	reporter := &progressReporter{
		client: runner.client, attempts: command.Attempts, redactor: newRedactor(worktree, runner.token),
		endpoint: agentRunEndpoint(runner.baseURL, runner.workerID, command.ID, "/progress"),
	}
	stopReporting := reporter.start(ctx, cancel)
	workspace := runWorkspace{path: worktree, environment: runner.config.processEnvironment(project.Remote),
		readPaths: runner.config.readPaths(project.Remote), denyPaths: confidentialRoots(root, projects)}
	result := runner.attempt(activeCtx, command, project, root, workspace, provider, reporter)
	stopReporting()
	if _, leaseLost := reporter.state(); leaseLost || ctx.Err() != nil {
		return result, false
	}
	return result, true
}

func (runner *agentRunner) attempt(
	ctx context.Context, command workerapi.AgentRunCommand, project discoveredProject, root string,
	workspace runWorkspace, provider *cliProvider, reporter *progressReporter,
) workerapi.AgentRunResult {
	result := workerapi.AgentRunResult{ProviderVersion: "git merge"}
	if provider != nil {
		result.ProviderVersion = provider.version
	}
	worktree := workspace.path
	runner.checkout.Lock()
	err := prepareWorktree(ctx, root, project, command.ID, command.Branch, command.BaseBranch)
	runner.checkout.Unlock()
	if cancelled, _ := reporter.state(); cancelled && err != nil {
		return cancelledRun(result)
	}
	if err != nil {
		return failed(result, workerapi.TerminationWorkerError, "Could not prepare an isolated branch.")
	}
	// No process of this attempt starts before every process of an earlier attempt is gone.
	owner, err := acquireWorktree(ctx, worktree, runner.guard)
	if cancelled, _ := reporter.state(); cancelled && err != nil {
		return cancelledRun(result)
	}
	if err != nil {
		log.Printf("agent run %s attempt %d: %v", command.ID, command.Attempts, err)
		return failed(result, workerapi.TerminationWorkerError, "The run worktree is still in use by an earlier attempt's processes.")
	}
	defer owner.release()
	workspace.owner = owner
	if owner.tookOver {
		reporter.emit("status", "Stopped processes left in the worktree by an earlier attempt.")
	}
	runner.checkout.Lock()
	unlock := lockWorktree(project.Path, worktree)
	runner.checkout.Unlock()
	defer func() {
		runner.checkout.Lock()
		defer runner.checkout.Unlock()
		unlock()
	}()
	if base, err := gitOutput(ctx, "-C", worktree, "merge-base", command.BaseBranch, "HEAD"); err == nil {
		result.BaseCommit = strings.TrimSpace(base)
	}
	reporter.emit("status", fmt.Sprintf("Isolated worktree ready on %s from %s", command.Branch, command.BaseBranch))
	if len(command.Merge) > 0 {
		return runner.integrate(ctx, command, project, workspace, result, reporter)
	}

	runCtx, cancelRun := context.WithTimeout(ctx, runner.limits.wallClock)
	// Git keeps a worktree's metadata in the source checkout; a sandboxed agent needs to read it.
	if gitDir, err := gitOutput(ctx, "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"); err == nil {
		workspace.readPaths = append(workspace.readPaths, strings.TrimSpace(gitDir))
	}
	execution, runErr := provider.execute(runCtx, command, workspace, runner.limits, reporter.emit)
	cancelRun()
	result.Usage, result.TerminationReason = execution.usage, execution.reason

	// Git bookkeeping must still run after cancellation or a timeout, so it gets its own deadline that
	// starts only once the provider has stopped.
	gitCtx, cancelGit := context.WithTimeout(context.WithoutCancel(ctx), runner.limits.gitStage)
	defer cancelGit()
	diff, truncated, diffErr := collectAgentRunDiff(gitCtx, worktree, command.BaseBranch)
	if diffErr == nil {
		result.Diff, result.DiffTruncated = &diff, truncated
	}
	if cancelled, _ := reporter.state(); cancelled {
		return cancelledRun(result)
	}
	if diffErr != nil {
		return failed(result, workerapi.TerminationWorkerError, "Could not collect the isolated branch diff.")
	}
	if runErr != nil {
		log.Printf("agent run %s attempt %d: %v", command.ID, command.Attempts, reporter.redactor.clean(runErr.Error()))
		reporter.emit("error", runErr.Error())
		return failed(result, execution.reason, executionFailureMessage(execution.reason))
	}
	result.Output = truncateText(reporter.redactor.clean(execution.output), maxAgentRunOutputSize)
	result.Result = typedResult(reporter.redactor.clean(execution.output))
	return runner.deliver(ctx, gitCtx, command, project, workspace, result, reporter)
}

// deliver turns a finished execution into a candidate: commit, verify, and push the run branch.
// Verification that fails keeps the commit local; nothing unverified is published.
func (runner *agentRunner) deliver(
	ctx, gitCtx context.Context, command workerapi.AgentRunCommand, project discoveredProject, workspace runWorkspace,
	result workerapi.AgentRunResult, reporter *progressReporter,
) workerapi.AgentRunResult {
	var err error
	worktree := workspace.path
	result.CommitSHA, err = commitAgentRunChanges(gitCtx, worktree, command.BaseBranch, command.ID, command.Attempts)
	if err != nil {
		return failed(result, workerapi.TerminationWorkerError, "Could not commit isolated branch changes.")
	}
	if result.CommitSHA == "" {
		reporter.emit("status", "The agent finished without changing any files.")
		result.Status = "succeeded"
		return result
	}
	result.CommitTreeSHA, err = gitOutput(gitCtx, "-C", worktree, "rev-parse", "--verify", result.CommitSHA+"^{tree}")
	if err != nil {
		return failed(result, workerapi.TerminationWorkerError, "Could not read the committed candidate tree.")
	}
	result.CommitTreeSHA = strings.TrimSpace(result.CommitTreeSHA)
	reporter.emit("status", "Committed "+result.CommitSHA[:12]+" on the run branch.")
	result.Verification = runVerification(ctx, workspace, runner.config.verificationCommands(project.Remote),
		runner.limits.verification, reporter.emit)
	if cancelled, _ := reporter.state(); cancelled {
		return cancelledRun(result)
	}
	if result.Verification == workerapi.VerificationFailed {
		return failed(result, workerapi.TerminationVerification, "Verification failed; the changes are committed on the isolated branch.")
	}
	if _, leaseLost := reporter.state(); leaseLost || ctx.Err() != nil {
		// This attempt no longer owns the run; the commit stays local for the attempt that does.
		return result
	}
	if command.PublishCommit != "" && result.CommitSHA != command.PublishCommit {
		// The worktree no longer reproduces the reviewed candidate; nothing unreviewed is published.
		return failed(result, workerapi.TerminationWorkerError, "The commit differs from the reviewed candidate; nothing was pushed.")
	}
	if command.PublishPullRequest {
		push := runner.push
		if push == nil {
			push = pushAgentBranch
		}
		pushCtx, cancelPush := context.WithTimeout(context.WithoutCancel(ctx), runner.limits.gitStage)
		defer cancelPush()
		if err := push(pushCtx, worktree, project.Remote, command.Branch); err != nil {
			result.BranchPushFailed = true
			reporter.emit("error", "Git could not push the run branch.")
		} else {
			result.BranchPushed = true
			reporter.emit("status", "Pushed the run branch to origin.")
		}
	}
	result.Status = "succeeded"
	return result
}

func cancelledRun(result workerapi.AgentRunResult) workerapi.AgentRunResult {
	result.Status, result.Error, result.TerminationReason = "cancelled", "Cancelled from dashboard.", workerapi.TerminationCancelled
	if result.Diff == nil {
		result.Error = "Cancelled; partial diff could not be captured."
	}
	result.Output, result.BranchPushed, result.BranchPushFailed = "", false, false
	return result
}

func executionFailureMessage(reason string) string {
	switch reason {
	case workerapi.TerminationWallClock:
		return "The run exceeded its wall-clock limit; partial changes are kept in the worktree."
	case workerapi.TerminationInactivity:
		return "The agent produced no activity within the inactivity limit; partial changes are kept."
	case workerapi.TerminationToolTimeout:
		return "A tool started by the agent exceeded the tool-activity limit; partial changes are kept."
	default:
		return "Agent runtime failed; inspect the run events and worker logs."
	}
}

const (
	finishAttempts   = 4
	finishRetryDelay = 3 * time.Second
)

// finish retries failed deliveries and only treats a conflict as delivered when the server confirms
// that this attempt's result was already accepted.
func (runner *agentRunner) finish(ctx context.Context, runID string, result workerapi.AgentRunResult) error {
	body, err := encodeAgentRunResult(result)
	if err != nil {
		return fmt.Errorf("encode agent run result: %w", err)
	}
	endpoint := agentRunEndpoint(runner.baseURL, runner.workerID, runID, "")
	// The control plane may create the pull request while handling the result.
	client := *runner.client
	client.Timeout = time.Minute
	var lastErr error
	for attempt := 1; attempt <= finishAttempts; attempt++ {
		status, responseBody, err := putJSON(ctx, &client, endpoint, body)
		switch {
		case err == nil && status == http.StatusOK:
			return nil
		case err == nil && status == http.StatusConflict && lastErr != nil &&
			strings.TrimSpace(responseBody) == workerapi.AgentRunResultAlreadyAccepted:
			return nil
		case err == nil && status < http.StatusInternalServerError:
			return fmt.Errorf("agent run result returned HTTP %d: %s", status, strings.TrimSpace(responseBody))
		case err != nil:
			lastErr = err
		default:
			lastErr = fmt.Errorf("agent run result returned HTTP %d", status)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("send agent run result: %w", lastErr)
		case <-time.After(runner.finishDelay()):
		}
	}
	return fmt.Errorf("send agent run result: %w", lastErr)
}

func encodeAgentRunResult(result workerapi.AgentRunResult) ([]byte, error) {
	encode := func(result workerapi.AgentRunResult) ([]byte, error) {
		var body bytes.Buffer
		encoder := json.NewEncoder(&body)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(result); err != nil {
			return nil, err
		}
		return bytes.TrimSuffix(body.Bytes(), []byte{'\n'}), nil
	}
	body, err := encode(result)
	if err != nil || len(body) <= workerapi.MaxJSONRequestBodySize {
		return body, err
	}
	if result.Diff == nil {
		return nil, fmt.Errorf("encoded agent run result exceeds %d bytes", workerapi.MaxJSONRequestBodySize)
	}

	diff := []rune(*result.Diff)
	low, high := 0, len(diff)
	var bounded []byte
	for low <= high {
		middle := low + (high-low)/2
		truncated := string(diff[:middle])
		candidate := result
		candidate.Diff, candidate.DiffTruncated = &truncated, true
		encoded, err := encode(candidate)
		if err != nil {
			return nil, err
		}
		if len(encoded) <= workerapi.MaxJSONRequestBodySize {
			bounded, low = encoded, middle+1
			continue
		}
		high = middle - 1
	}
	if bounded == nil {
		return nil, fmt.Errorf("agent run result exceeds %d bytes without its diff", workerapi.MaxJSONRequestBodySize)
	}
	return bounded, nil
}

func (runner *agentRunner) finishDelay() time.Duration {
	if runner.finishRetryDelay > 0 {
		return runner.finishRetryDelay
	}
	return finishRetryDelay
}

func putJSON(ctx context.Context, client *http.Client, endpoint string, body []byte) (int, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if err != nil {
		return response.StatusCode, "", err
	}
	return response.StatusCode, string(responseBody), nil
}
