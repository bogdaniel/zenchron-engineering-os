package main

import (
	"context"
	"fmt"
	"strings"
)

func reconcileRunBranch(ctx context.Context, worktree, branch, runID string, attempt int) error {
	if err := validateGitBranch(ctx, worktree, branch); err != nil {
		return err
	}
	remoteRef := "refs/heads/" + branch
	output, err := agentRunGitCommand(ctx, "-C", worktree, "ls-remote", "--refs", "origin", remoteRef).Output()
	if err != nil {
		return fmt.Errorf("inspect published run branch: %w", err)
	}
	fields := strings.Fields(string(output))
	if len(fields) == 0 {
		return nil
	}
	if len(fields) != 2 || fields[1] != remoteRef {
		return fmt.Errorf("unexpected published run branch response %q", strings.TrimSpace(string(output)))
	}
	if err := agentRunGitCommand(ctx, "-C", worktree, "fetch", "--no-tags", "origin", remoteRef).Run(); err != nil {
		return fmt.Errorf("fetch published run branch: %w", err)
	}
	remoteCommitOutput, err := agentRunGitCommand(ctx, "-C", worktree, "rev-parse", "--verify", "FETCH_HEAD^{commit}").Output()
	if err != nil {
		return fmt.Errorf("read fetched run branch: %w", err)
	}
	remoteCommit := strings.TrimSpace(string(remoteCommitOutput))
	if err := agentRunGitCommand(ctx, "-C", worktree, "merge-base", "--is-ancestor", remoteCommit, "HEAD").Run(); err == nil {
		return nil
	}
	status, err := agentRunGitCommand(ctx, "-C", worktree, "status", "--porcelain", "--untracked-files=all").Output()
	if err != nil {
		return fmt.Errorf("check run worktree before recovery: %w", err)
	}
	if len(status) != 0 {
		return fmt.Errorf("run worktree has changes that cannot be recovered automatically")
	}
	localCommitOutput, err := agentRunGitCommand(ctx, "-C", worktree, "rev-parse", "HEAD").Output()
	if err != nil {
		return fmt.Errorf("read local run commit: %w", err)
	}
	localCommit := strings.TrimSpace(string(localCommitOutput))
	recoveryBranch := fmt.Sprintf("zenchron/recovery/%s/%d-%s", runID, attempt, localCommit)
	existingRecoveryOutput, err := agentRunGitCommand(ctx, "-C", worktree, "branch", "--list", "--format=%(objectname)", "--", recoveryBranch).Output()
	if err != nil {
		return fmt.Errorf("inspect recovery branch: %w", err)
	}
	existingRecovery := strings.TrimSpace(string(existingRecoveryOutput))
	if existingRecovery != "" && existingRecovery != localCommit {
		return fmt.Errorf("recovery branch points to a different commit")
	}
	if existingRecovery == "" {
		if err := agentRunGitCommand(ctx, "-C", worktree, "branch", recoveryBranch, localCommit).Run(); err != nil {
			return fmt.Errorf("preserve unpublished run commit: %w", err)
		}
	}
	if err := agentRunGitCommand(ctx, "-C", worktree, "reset", "--hard", remoteCommit).Run(); err != nil {
		return fmt.Errorf("reset run branch to published commit: %w", err)
	}
	return nil
}
