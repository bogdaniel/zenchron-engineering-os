package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
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
	runGit(t, repository, "config", "remote.origin.pushurl", "https://github.com/acme/repo.git")
	if err := validateAgentRunRemote(context.Background(), worktree, "github.com/acme/repo", branch); err == nil {
		t.Fatal("agent run accepted a fetch origin outside the project repository")
	}
	runGit(t, repository, "config", "--unset", "remote.origin.pushurl")
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

func TestCleanupRejectsAStaleOwnerDescriptorAfterReattach(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	if err := harness.process(); err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(filepath.Dir(harness.worktree))
	project := discoveredProject{ID: agentRunTestID, Name: "repository", Path: harness.repository}
	staleLock, err := os.OpenFile(harness.worktree+".owner", os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer staleLock.Close()
	cleaned := make(chan error, 1)
	go func() {
		removed, kept, err := cleanupWorktrees(context.Background(), root, []discoveredProject{project})
		if err == nil && (len(removed) != 1 || len(kept) != 0) {
			err = errors.New("cleanup did not remove the unlocked worktree")
		}
		cleaned <- err
	}()
	if err := <-cleaned; err != nil {
		t.Fatalf("cleanup with stale open descriptor: %v", err)
	}
	if err := syscall.Flock(int(staleLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("lock the stale owner descriptor: %v", err)
	}
	if _, err := os.Stat(harness.worktree); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("clean worktree remains after cleanup: %v", err)
	}

	lifecycleLock, err := lockWorktreeLifecycle(context.Background(), root, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := prepareWorktree(context.Background(), root, project, agentRunTestID, "zenchron/agent-run/"+agentRunTestID, "main"); err != nil {
		_ = lifecycleLock.Close()
		t.Fatalf("reattach clean worktree: %v", err)
	}
	owner, err := acquireWorktree(context.Background(), harness.worktree, nil)
	if err != nil {
		_ = lifecycleLock.Close()
		t.Fatalf("acquire reattached worktree: %v", err)
	}
	if err := verifyWorktreeOwnerLock(staleLock, harness.worktree); err == nil {
		owner.release()
		_ = lifecycleLock.Close()
		t.Fatal("stale owner descriptor still matched the reattached worktree path")
	}
	if err := verifyWorktreeOwnerLock(owner.lock, harness.worktree); err != nil {
		owner.release()
		_ = lifecycleLock.Close()
		t.Fatalf("new owner descriptor does not match reattached path: %v", err)
	}
	owner.release()
	if err := lifecycleLock.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupAggregatesFailuresAcrossProjects(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	if err := harness.process(); err != nil {
		t.Fatal(err)
	}
	root := filepath.Dir(filepath.Dir(harness.worktree))
	processesPath := harness.worktree + ".owner.processes"
	if err := os.Remove(processesPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(processesPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(processesPath, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	secondProjectID := "abcdef0123456789abcdef0123456789"
	if err := os.WriteFile(filepath.Join(root, secondProjectID), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := cleanupWorktrees(context.Background(), root, []discoveredProject{
		{ID: agentRunTestID, Name: "first", Path: harness.repository},
		{ID: secondProjectID, Name: "second", Path: harness.repository},
	})
	if err == nil || !strings.Contains(err.Error(), "remove ownership files") || !strings.Contains(err.Error(), "lock worktrees for second") {
		t.Fatalf("cleanup error = %v, want both first-project sidecar failure and later-project error", err)
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
