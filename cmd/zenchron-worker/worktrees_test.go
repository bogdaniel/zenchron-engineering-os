package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const workerTestID = "0123456789abcdef0123456789abcdef"

func TestPrepareWorktreeCreatesIsolatedBranchAndReusesItAfterCleanup(t *testing.T) {
	repository := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial commit")
	project := projectAt(repository, workerTestID)
	const branch = "zenchron/review-fix"
	root := filepath.Join(t.TempDir(), "worker-checkouts")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := prepareWorktree(ctx, root, project, workerTestID, branch, "main"); err != nil {
		t.Fatalf("prepareWorktree() error = %v", err)
	}
	worktree := filepath.Join(root, project.ID, workerTestID)
	if current := strings.TrimSpace(runGit(t, worktree, "branch", "--show-current")); current != branch {
		t.Fatalf("worktree branch = %q, want %q", current, branch)
	}
	if err := prepareWorktree(ctx, root, project, workerTestID, branch, "main"); err != nil {
		t.Fatalf("repeated prepareWorktree() error = %v, want idempotent success", err)
	}
	if branch := strings.TrimSpace(runGit(t, repository, "branch", "--show-current")); branch != "main" {
		t.Fatalf("base checkout moved to %q, want main", branch)
	}
	if status := strings.TrimSpace(runGit(t, repository, "status", "--porcelain")); status != "" {
		t.Fatalf("base checkout has changes after worktree preparation: %s", status)
	}
	removed, kept, err := cleanupWorktrees(ctx, root, []discoveredProject{project})
	if err != nil || len(removed) != 1 || len(kept) != 0 {
		t.Fatalf("cleanupWorktrees() = removed %v, kept %v, error %v", removed, kept, err)
	}
	runGit(t, repository, "show-ref", "--verify", "refs/heads/"+branch)
	if err := prepareWorktree(ctx, root, project, workerTestID, branch, "main"); err != nil {
		t.Fatalf("prepareWorktree() after cleanup error = %v", err)
	}
	if current := strings.TrimSpace(runGit(t, worktree, "branch", "--show-current")); current != branch {
		t.Fatalf("recreated worktree branch = %q, want %q", current, branch)
	}
}

func TestPushAgentBranchRestrictsOriginAndPushesOnlyTheRunBranch(t *testing.T) {
	root := t.TempDir()
	repository := filepath.Join(root, "repository")
	bare := filepath.Join(root, "origin.git")
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(bare, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, bare, "init", "--bare")
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial")
	runGit(t, repository, "remote", "add", "origin", bare)
	branch := "zenchron/agent-run/" + workerTestID
	worktree := filepath.Join(root, "worktree")
	runGit(t, repository, "worktree", "add", "-b", branch, worktree, "main")
	if err := os.WriteFile(filepath.Join(worktree, "README.md"), []byte("agent change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := commitAgentRunChanges(context.Background(), worktree, "main", workerTestID, 1); err != nil {
		t.Fatal(err)
	}
	commitSHA := strings.TrimSpace(runGit(t, worktree, "rev-parse", "HEAD"))
	if err := pushAgentBranch(context.Background(), worktree, "github.com/acme/repo", branch, commitSHA); err == nil {
		t.Fatal("agent branch push accepted an origin outside GitHub")
	}
	if err := pushGitCommit(context.Background(), worktree, branch, commitSHA); err != nil {
		t.Fatalf("push isolated branch to test remote: %v", err)
	}
	runGit(t, bare, "show-ref", "--verify", "refs/heads/"+branch)
	if current := strings.TrimSpace(runGit(t, repository, "branch", "--show-current")); current != "main" {
		t.Fatalf("source checkout moved to branch %q", current)
	}
}

func TestPrepareWorktreeRejectsInvalidBranchWithoutChangingRepository(t *testing.T) {
	repository := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "init", "-b", "main")
	project := projectAt(repository, workerTestID)
	err := prepareWorktree(context.Background(), filepath.Join(t.TempDir(), "worktrees"), project, workerTestID, "../../outside", "main")
	if err == nil {
		t.Fatal("prepareWorktree() accepted a traversal branch name")
	}
	if branches := strings.TrimSpace(runGit(t, repository, "branch", "--list")); branches != "" {
		t.Fatalf("invalid request created branches: %s", branches)
	}
}

func runGit(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v: %s", args, err, output)
	}
	return string(output)
}
