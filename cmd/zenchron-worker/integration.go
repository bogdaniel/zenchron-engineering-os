package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// maxConflictFiles bounds how many conflicting paths an integration run reports.
const maxConflictFiles = 50

// typedResult returns the content of the last fenced block labelled with the result fence in an agent's
// final message. The worker does not interpret it; the control plane validates it.
func typedResult(output string) string {
	_, block, found := strings.CutLast(output, "```"+workerapi.ResultFence)
	if !found {
		return ""
	}
	block, _, closed := strings.Cut(block, "```")
	if block = strings.TrimSpace(block); !closed || len(block) > workerapi.MaxResultSize {
		return ""
	}
	return block
}

// integrate executes an integration run: it merges the admitted candidates into the run's worktree in
// the order given, without a model. Every input must still be the exact commit the control plane
// admitted, and a conflict stops the run with nothing dropped: the conflicting merge is aborted and
// reported. A combined candidate then goes through the same commit, verification, and push as any run.
func (runner *agentRunner) integrate(
	ctx context.Context, command workerapi.AgentRunCommand, project discoveredProject, workspace runWorkspace,
	result workerapi.AgentRunResult, reporter *progressReporter,
) workerapi.AgentRunResult {
	gitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), runner.limits.gitStage)
	defer cancel()
	worktree := workspace.path
	var merge workerapi.MergeResult
	report := func() string {
		// A list of branch names, commits, and paths always encodes.
		encoded, _ := json.Marshal(map[string]workerapi.MergeResult{"integration": merge})
		return string(encoded)
	}
	for _, input := range command.Merge {
		tip, err := gitOutput(gitCtx, "-C", worktree, "rev-parse", "--verify", "--quiet", "refs/heads/"+input.Branch+"^{commit}")
		if err != nil || strings.TrimSpace(tip) != input.Commit {
			merge.Stale = append(merge.Stale, input.Branch)
		}
	}
	if len(merge.Stale) > 0 {
		result.Result = report()
		return failed(result, workerapi.TerminationWorkerError, "An input branch no longer points at its admitted commit.")
	}
	for _, input := range command.Merge {
		arguments := append([]string{"-C", worktree}, agentIdentity...)
		mergeCommand := gitCommand(gitCtx, append(arguments, "merge", "--no-ff", "--no-edit", "-m", "Integrate "+input.Branch, input.Commit)...)
		mergeCommand.Stdout, mergeCommand.Stderr = io.Discard, io.Discard
		if err := mergeCommand.Run(); err != nil {
			conflicts, _ := gitOutput(gitCtx, "-C", worktree, "diff", "--name-only", "--diff-filter=U")
			merge.ConflictBranch, merge.ConflictFiles = input.Branch, strings.Fields(conflicts)
			merge.ConflictFiles = merge.ConflictFiles[:min(len(merge.ConflictFiles), maxConflictFiles)]
			if _, abortErr := gitOutput(gitCtx, "-C", worktree, "merge", "--abort"); abortErr != nil {
				return failed(result, workerapi.TerminationWorkerError, "A merge failed and could not be aborted; the integration worktree needs inspection.")
			}
			reporter.emit("error", "Merge conflict in "+input.Branch)
			result.Result = report()
			return failed(result, workerapi.TerminationMergeConflict, "Admitted candidates conflict; the conflicting merge was aborted.")
		}
		merge.Merged = append(merge.Merged, input)
		reporter.emit("status", fmt.Sprintf("Merged %s from %s", input.Commit[:min(12, len(input.Commit))], input.Branch))
	}
	if cancelled, _ := reporter.state(); cancelled {
		return cancelledRun(result)
	}
	diff, truncated, err := collectAgentRunDiff(gitCtx, worktree, command.BaseBranch)
	if err != nil {
		return failed(result, workerapi.TerminationWorkerError, "Could not collect the integrated diff.")
	}
	result.Diff, result.DiffTruncated, result.Result = &diff, truncated, report()
	result.Output = fmt.Sprintf("Combined %d admitted candidate(s) with Git.", len(merge.Merged))
	result.TerminationReason = workerapi.TerminationCompleted
	return runner.deliver(ctx, gitCtx, command, project, workspace, result, reporter)
}
