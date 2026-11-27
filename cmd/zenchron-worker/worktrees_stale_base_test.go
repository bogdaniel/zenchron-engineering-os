package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
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
	return prepareWorktree(ctx, root, projectAt(checkout, workerTestID), workerTestID, "zenchron/agent-run/"+workerTestID, "main", "", "")
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

func TestPrepareWorktreeFailsClosedForAGitHubRunWithoutItsOrigin(t *testing.T) {
	dir, checkout, _ := staleBaseFixture(t)
	root := filepath.Join(dir, "worktrees")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := projectAt(checkout, workerTestID)
	var unverified baseVerificationError
	err := prepareWorktree(ctx, root, project, workerTestID, "zenchron/agent-run/"+workerTestID, "main", "", "github.com/acme/other")
	if !errors.As(err, &unverified) || !strings.Contains(err.Error(), "origin is not github.com/acme/other") {
		t.Fatalf("origin of another repository: error = %v", err)
	}
	runGit(t, checkout, "remote", "remove", "origin")
	err = prepareWorktree(ctx, root, project, workerTestID, "zenchron/agent-run/"+workerTestID, "main", "", "github.com/acme/platform")
	if !errors.As(err, &unverified) || !strings.Contains(err.Error(), "origin is not configured") {
		t.Fatalf("missing origin for a GitHub run: error = %v", err)
	}
}

func TestPrepareWorktreeStartsFromTheVerifiedCommit(t *testing.T) {
	dir, checkout, _ := staleBaseFixture(t)
	runGit(t, checkout, "pull", "--quiet", "--ff-only")
	root := filepath.Join(dir, "worktrees")
	if err := prepareFixtureRun(t, root, checkout); err != nil {
		t.Fatal(err)
	}
	worktree := filepath.Join(root, projectAt(checkout, workerTestID).ID, workerTestID)
	if got, want := runGit(t, worktree, "rev-parse", "HEAD"), runGit(t, checkout, "rev-parse", "origin/main"); got != want {
		t.Fatalf("run started at %s, want the verified origin commit %s", got, want)
	}
}

func TestPrepareWorktreeStartsAtThePinnedGraphBaseEvenAfterOriginAdvances(t *testing.T) {
	dir, checkout, _ := staleBaseFixture(t)
	pinned := strings.TrimSpace(runGit(t, checkout, "rev-parse", "main"))
	root := filepath.Join(dir, "worktrees")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := projectAt(checkout, workerTestID)
	// origin is ahead of the checkout, which would refuse an unpinned run; the pinned base is used as is.
	var foreign baseVerificationError
	if err := prepareWorktree(ctx, root, project, workerTestID, "zenchron/agent-run/"+workerTestID, "main", pinned,
		"github.com/acme/other"); !errors.As(err, &foreign) || !strings.Contains(err.Error(), "origin is not github.com/acme/other") {
		t.Fatalf("pinned run with another repository's origin: error = %v", err)
	}
	if err := prepareWorktree(ctx, root, project, workerTestID, "zenchron/agent-run/"+workerTestID, "main", pinned, ""); err != nil {
		t.Fatalf("pinned run: error = %v", err)
	}
	worktree := filepath.Join(root, project.ID, workerTestID)
	if got := strings.TrimSpace(runGit(t, worktree, "rev-parse", "HEAD")); got != pinned {
		t.Fatalf("pinned run started at %s, want %s", got, pinned)
	}
	// A retry reuses this worktree; it is still refused when origin is now another repository.
	if err := prepareWorktree(ctx, root, project, workerTestID, "zenchron/agent-run/"+workerTestID, "main", pinned,
		"github.com/acme/other"); !errors.As(err, &foreign) {
		t.Fatalf("reused pinned worktree with another repository's origin: error = %v", err)
	}
	var unverified baseVerificationError
	missing := strings.Repeat("e", 40)
	other := "ffffffffffffffffffffffffffffffff"
	err := prepareWorktree(ctx, root, project, other, "zenchron/agent-run/"+other, "main", missing, "")
	if !errors.As(err, &unverified) || !strings.Contains(err.Error(), "pinned graph base") {
		t.Fatalf("missing pinned base: error = %v", err)
	}
}

func TestReusedWorktreeMustDescendFromThePinnedBase(t *testing.T) {
	_, checkout, commit := staleBaseFixture(t)
	pinned := strings.TrimSpace(runGit(t, checkout, "rev-parse", "main"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := verifyDescendsFromPinnedBase(ctx, checkout, pinned); err != nil {
		t.Fatalf("HEAD at the pinned base: error = %v", err)
	}
	runGit(t, checkout, "checkout", "--quiet", "--orphan", "unrelated")
	commit(checkout, "unrelated", false)
	var unverified baseVerificationError
	if err := verifyDescendsFromPinnedBase(ctx, checkout, pinned); !errors.As(err, &unverified) {
		t.Fatalf("HEAD unrelated to the pinned base: error = %v", err)
	}
}

func TestVerifySourceReportsTheVerifiedCommitOrRefuses(t *testing.T) {
	_, checkout, _ := staleBaseFixture(t)
	runner := &agentRunner{}
	project := projectAt(checkout, workerTestID)
	command := workerapi.AgentRunCommand{ID: workerTestID, VerifySource: true, BaseBranch: "main"}
	if result := runner.verifySource(context.Background(), command, project); result.Status != "failed" ||
		!strings.Contains(result.Error, "Source check failed: local main ") || !strings.Contains(result.Error, "differs from origin/main") {
		t.Fatalf("behind checkout: %#v", result)
	}
	runGit(t, checkout, "pull", "--quiet", "--ff-only")
	want := strings.TrimSpace(runGit(t, checkout, "rev-parse", "main"))
	if result := runner.verifySource(context.Background(), command, project); result.Status != "succeeded" || result.BaseCommit != want {
		t.Fatalf("matching checkout: %#v, want base %s", result, want)
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
