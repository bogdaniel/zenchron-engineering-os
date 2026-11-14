package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

const workerTestID = "0123456789abcdef0123456789abcdef"

func TestPrepareWorktreeCreatesIsolatedBranchAndIsIdempotent(t *testing.T) {
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
	if err := pushAgentBranch(context.Background(), worktree, "github.com/acme/repo", branch); err == nil {
		t.Fatal("agent branch push accepted an origin outside GitHub")
	}
	if err := pushGitBranch(context.Background(), worktree, branch); err != nil {
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

// cleanupFixture is a repository with one clean, unlocked run worktree per id, each with the ownership
// files an attempt leaves beside it.
func cleanupFixture(t *testing.T, ids ...string) (root string, projects []discoveredProject, worktrees []string) {
	t.Helper()
	repository := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "-c", "user.name=Zenchron Test", "-c", "user.email=zenchron-test@example.invalid",
		"commit", "--allow-empty", "-m", "initial commit")
	project := projectAt(repository, workerTestID)
	root = filepath.Join(t.TempDir(), "worktrees")
	for _, id := range ids {
		if err := prepareWorktree(context.Background(), root, project, id, "zenchron/agent-run/"+id, "main"); err != nil {
			t.Fatal(err)
		}
		worktree := filepath.Join(root, project.ID, id)
		for _, suffix := range []string{ownerLockSuffix, ownerRecordSuffix} {
			if err := os.WriteFile(worktree+suffix, nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		worktrees = append(worktrees, worktree)
	}
	return root, []discoveredProject{project}, worktrees
}

func TestCleanupWorktreesRemovesOwnershipFilesOnlyOfRemovedWorktrees(t *testing.T) {
	root, projects, worktrees := cleanupFixture(t, "11111111111111111111111111111111",
		"22222222222222222222222222222222", "33333333333333333333333333333333")
	clean, dirty, owned := worktrees[0], worktrees[1], worktrees[2]
	if err := os.WriteFile(filepath.Join(dirty, "uncommitted.txt"), []byte("keep me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Another open file description holding the lock stands in for a live process of the run.
	holder, err := os.Open(owned + ownerLockSuffix)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	removed, kept, err := cleanupWorktrees(context.Background(), root, projects)
	wantKept := []string{"repository/" + filepath.Base(dirty), "repository/" + filepath.Base(owned)}
	if err != nil || !slices.Equal(removed, []string{"repository/" + filepath.Base(clean)}) || !slices.Equal(kept, wantKept) {
		t.Fatalf("cleanup removed %v, kept %v, error %v", removed, kept, err)
	}
	for _, gone := range []string{clean, clean + ownerLockSuffix, clean + ownerRecordSuffix} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Fatalf("cleanup left %s behind: %v", gone, err)
		}
	}
	for _, worktree := range []string{dirty, owned} {
		for _, protected := range []string{worktree, worktree + ownerLockSuffix, worktree + ownerRecordSuffix} {
			if _, err := os.Lstat(protected); err != nil {
				t.Fatalf("cleanup removed protected %s: %v", protected, err)
			}
		}
	}
}

func TestCleanupWorktreesReportsOwnershipFileItCannotRemove(t *testing.T) {
	root, projects, worktrees := cleanupFixture(t, "11111111111111111111111111111111")
	// A non-empty directory in place of the process record cannot be removed like a file.
	record := worktrees[0] + ownerRecordSuffix
	if err := os.Remove(record); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(record, "blocker"), 0o700); err != nil {
		t.Fatal(err)
	}
	removed, kept, err := cleanupWorktrees(context.Background(), root, projects)
	if err == nil || !strings.Contains(err.Error(), "repository/"+filepath.Base(worktrees[0])) {
		t.Fatalf("cleanup error = %v, want the ownership file failure for the worktree", err)
	}
	if len(removed) != 1 || len(kept) != 0 {
		t.Fatalf("cleanup removed %v, kept %v", removed, kept)
	}
	if _, err := os.Lstat(worktrees[0] + ownerLockSuffix); !os.IsNotExist(err) {
		t.Fatalf("cleanup left the ownership lock behind: %v", err)
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
