package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// runExecutor performs one agent attempt inside a prepared worktree. It has two kinds of
// implementation today: the chat-completions runtime and the installed coding CLIs.
type runExecutor interface {
	execute(
		ctx context.Context, command workerapi.AgentRunCommand, worktree string, limits runLimits,
		emit func(kind, message string),
	) (executionResult, error)
	versionLabel() string
}

func (provider *cliProvider) versionLabel() string { return provider.version }

func (runtime *agentRuntime) versionLabel() string { return "" }

func (runtime *agentRuntime) execute(
	ctx context.Context, command workerapi.AgentRunCommand, worktree string, _ runLimits, _ func(kind, message string),
) (executionResult, error) {
	output, err := runtime.complete(ctx, command, worktree)
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return executionResult{reason: workerapi.TerminationWallClock}, ctx.Err()
	case ctx.Err() != nil:
		return executionResult{reason: workerapi.TerminationCancelled}, ctx.Err()
	case err != nil:
		return executionResult{reason: workerapi.TerminationProviderExit}, err
	}
	return executionResult{output: output, reason: workerapi.TerminationCompleted}, nil
}

// agentRunner owns the local half of a run: worktree, provider process, verification, commit and push.
type agentRunner struct {
	client    *http.Client
	baseURL   *url.URL
	workerID  string
	token     string
	chat      *agentRuntime
	providers map[string]*cliProvider
	limits    runLimits
	config    *workerConfig
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
	return runner.chat != nil || slices.ContainsFunc(runner.providerStatuses(), func(status workerapi.ProviderStatus) bool {
		return status.Ready
	})
}

func (runner *agentRunner) executorFor(provider string) runExecutor {
	if cli := runner.providers[provider]; cli != nil {
		if cli.ready {
			return cli
		}
		return nil
	}
	if runner.chat == nil || workerapi.IsCLIProvider(provider) {
		return nil
	}
	return runner.chat
}

func (runner *agentRunner) process(ctx context.Context, projects []discoveredProject) error {
	if !runner.canExecute() {
		return nil
	}
	command, found, err := claimAgentRun(ctx, runner.client, runner.baseURL, runner.workerID)
	if err != nil || !found {
		return err
	}
	result, report := runner.run(ctx, command, projects)
	if !report {
		return fmt.Errorf("agent run %s attempt %d was interrupted; its worktree is kept for the next attempt",
			command.ID, command.Attempts)
	}
	result.Attempts = command.Attempts
	return runner.finish(ctx, command.ID, result)
}

func failedRun(reason, message string) workerapi.AgentRunResult {
	return workerapi.AgentRunResult{Status: "failed", Error: message, TerminationReason: reason}
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
	executor := runner.executorFor(command.Profile.Provider)
	if executor == nil {
		return failedRun(workerapi.TerminationWorkerError, "The agent provider is not ready on this worker."), true
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
	result := runner.attempt(activeCtx, command, project, root, worktree, executor, reporter)
	stopReporting()
	if _, leaseLost := reporter.state(); leaseLost || ctx.Err() != nil {
		return result, false
	}
	return result, true
}

func (runner *agentRunner) attempt(
	ctx context.Context, command workerapi.AgentRunCommand, project discoveredProject, root, worktree string,
	executor runExecutor, reporter *progressReporter,
) workerapi.AgentRunResult {
	result := workerapi.AgentRunResult{ProviderVersion: executor.versionLabel()}
	fail := func(reason, message string) workerapi.AgentRunResult {
		result.Status, result.Error, result.TerminationReason = "failed", message, reason
		return result
	}
	err := prepareWorktree(ctx, root, project, worktreeCommand{
		ID: command.ID, ProjectID: command.ProjectID, Branch: command.Branch, BaseBranch: command.BaseBranch,
	})
	if cancelled, _ := reporter.state(); cancelled && err != nil {
		return cancelledRun(result)
	}
	if err != nil {
		return fail(workerapi.TerminationWorkerError, "Could not prepare an isolated branch.")
	}
	unlock := lockWorktree(project.Path, worktree)
	defer unlock()
	if base, err := gitOutput(ctx, "-C", worktree, "merge-base", command.BaseBranch, "HEAD"); err == nil {
		result.BaseCommit = strings.TrimSpace(base)
	}
	reporter.emit("status", fmt.Sprintf("Isolated worktree ready on %s from %s", command.Branch, command.BaseBranch))

	runCtx, cancelRun := context.WithTimeout(ctx, runner.limits.wallClock)
	execution, runErr := executor.execute(runCtx, command, worktree, runner.limits, reporter.emit)
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
		return fail(workerapi.TerminationWorkerError, "Could not collect the isolated branch diff.")
	}
	if runErr != nil {
		log.Printf("agent run %s attempt %d: %v", command.ID, command.Attempts, reporter.redactor.clean(runErr.Error()))
		reporter.emit("error", runErr.Error())
		return fail(execution.reason, executionFailureMessage(execution.reason))
	}
	result.Output = truncateText(reporter.redactor.clean(execution.output), maxAgentRunOutputSize)
	result.CommitSHA, err = commitAgentRunChanges(gitCtx, worktree, command.BaseBranch, command.ID, command.Attempts)
	if err != nil {
		return fail(workerapi.TerminationWorkerError, "Could not commit isolated branch changes.")
	}
	if result.CommitSHA == "" {
		reporter.emit("status", "The agent finished without changing any files.")
		result.Status = "succeeded"
		return result
	}
	reporter.emit("status", "Committed "+result.CommitSHA[:12]+" on the run branch.")
	result.Verification = runVerification(ctx, worktree, runner.config.verificationCommands(project.Remote),
		runner.limits.verification, reporter.emit)
	if cancelled, _ := reporter.state(); cancelled {
		return cancelledRun(result)
	}
	if result.Verification == workerapi.VerificationFailed {
		return fail(workerapi.TerminationVerification, "Verification failed; the changes are committed on the isolated branch.")
	}
	if command.PublishPullRequest {
		if err := pushAgentBranch(gitCtx, worktree, project.Remote, command.Branch); err != nil {
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

func (runner *agentRunner) finish(ctx context.Context, runID string, result workerapi.AgentRunResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("encode agent run result: %w", err)
	}
	endpoint := agentRunEndpoint(runner.baseURL, runner.workerID, runID, "")
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create agent run result: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	// The control plane may create the pull request while handling the result.
	client := *runner.client
	client.Timeout = time.Minute
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("send agent run result: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("agent run result returned HTTP %d", response.StatusCode)
	}
	return nil
}
