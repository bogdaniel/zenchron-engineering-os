package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// staleBaseFixture returns a checkout cloned from origin, plus a second clone used to advance origin.
func staleBaseFixture(t *testing.T) (dir, checkout string, commit func(repository, name string, push bool)) {
	t.Helper()
	dir = t.TempDir()
	origin := filepath.Join(dir, "origin.git")
	runGit(t, dir, "init", "--quiet", "--bare", "-b", "main", origin)
	upstream := filepath.Join(dir, "upstream")
	runGit(t, dir, "clone", "--quiet", origin, upstream)
	commit = func(repository, name string, push bool) {
		runGit(t, repository, "config", "user.name", "Zenchron Test")
		runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
		if err := os.WriteFile(filepath.Join(repository, name), []byte(name+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		runGit(t, repository, "add", name)
		runGit(t, repository, "commit", "--quiet", "-m", name)
		if push {
			runGit(t, repository, "push", "--quiet", "origin", "main")
		}
	}
	commit(upstream, "first", true)
	checkout = filepath.Join(dir, "checkout")
	runGit(t, dir, "clone", "--quiet", origin, checkout)
	commit(upstream, "second", true)
	return dir, checkout, commit
}

func prepareFixtureRun(t *testing.T, root, checkout string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return prepareWorktree(ctx, root, projectAt(checkout, workerTestID), workerTestID, "zenchron/agent-run/"+workerTestID, "main")
}

func TestPrepareWorktreeRequiresTheBaseToEqualOrigin(t *testing.T) {
	dir, checkout, commit := staleBaseFixture(t)
	root := filepath.Join(dir, "worktrees")
	localBefore := strings.TrimSpace(runGit(t, checkout, "rev-parse", "main"))

	// Behind: origin has a commit the checkout lacks.
	err := prepareFixtureRun(t, root, checkout)
	var stale staleBaseError
	if !errors.As(err, &stale) || stale.local != localBefore || stale.remote == stale.local ||
		!strings.Contains(err.Error(), stale.local) || !strings.Contains(err.Error(), stale.remote) {
		t.Fatalf("behind checkout: error = %v, want a refusal naming both commits", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, projectAt(checkout, workerTestID).ID, workerTestID)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("a refused run left a worktree: %v", statErr)
	}
	if after := strings.TrimSpace(runGit(t, checkout, "rev-parse", "main")); after != localBefore {
		t.Fatal("verification moved the local main branch")
	}

	// Diverged/ahead: a local commit origin does not have is refused too.
	runGit(t, checkout, "merge", "--quiet", "--ff-only", "origin/main")
	commit(checkout, "local-only", false)
	if err := prepareFixtureRun(t, root, checkout); !errors.As(err, &stale) {
		t.Fatalf("ahead checkout: error = %v, want a stale base refusal", err)
	}

	// Matching: once local main equals origin, the run starts.
	runGit(t, checkout, "reset", "--quiet", "--hard", "origin/main")
	if err := prepareFixtureRun(t, root, checkout); err != nil {
		t.Fatalf("matching checkout: error = %v", err)
	}
}

func TestPrepareWorktreeRefusesWhenOriginCannotBeReached(t *testing.T) {
	dir, checkout, _ := staleBaseFixture(t)
	runGit(t, checkout, "remote", "set-url", "origin", filepath.Join(dir, "missing.git"))
	var unverified baseVerificationError
	if err := prepareFixtureRun(t, filepath.Join(dir, "worktrees"), checkout); !errors.As(err, &unverified) {
		t.Fatalf("unreachable origin: error = %v, want a verification error", err)
	}
}
