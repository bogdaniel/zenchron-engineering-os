package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublishOnlyRunDoesNotPublishWhenVerificationChangesCandidate(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	bare := filepath.Join(t.TempDir(), "remote.git")
	if err := os.MkdirAll(bare, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, bare, "init", "--bare")
	runGit(t, harness.repository, "remote", "add", "origin", "https://github.com/test/repository.git")
	seedOriginMain(t, harness.repository, bare)
	runGit(t, harness.repository, "config", "url.file://"+filepath.ToSlash(bare)+".insteadOf", "https://github.com/test/repository.git")
	runGit(t, harness.repository, "config", "remote.origin.pushurl", "https://github.com/test/repository")
	harness.gitRemote = "github.com/test/repository"
	harness.runner.config.Repositories[harness.gitRemote] = harness.runner.config.Repositories[""]
	var pushes int
	harness.runner.push = func(context.Context, string, string, string, string) error {
		pushes++
		return nil
	}
	if err := harness.process(); err != nil {
		t.Fatalf("create candidate: %v", err)
	}
	candidate := harness.results[0]
	runGit(t, harness.worktree, "reset", "--hard", candidate.CommitSHA)
	runGit(t, harness.worktree, "commit", "--allow-empty", "-m", "advance local branch")
	repository := harness.runner.config.Repositories[""]
	repository.Verify = [][]string{{"sh", "-c", "touch unreviewed.txt"}}
	harness.runner.config.Repositories[""] = repository
	harness.runner.config.Repositories[harness.gitRemote] = repository
	harness.queue = []workerapi.AgentRunCommand{{
		ID: harness.command.ID, ProjectID: harness.command.ProjectID, Branch: harness.command.Branch,
		BaseBranch: harness.command.BaseBranch, Attempts: 2, PublishPullRequest: true, PublishOnly: true,
		PublishCommit: candidate.CommitSHA,
	}}
	if err := harness.process(); err != nil {
		t.Fatalf("reject candidate changed during verification: %v", err)
	}
	result := harness.results[1]
	branch := strings.TrimSpace(runGit(t, harness.worktree, "branch", "--show-current"))
	if result.Status != "failed" || result.CommitSHA != candidate.CommitSHA ||
		!strings.Contains(result.Error, "Could not confirm the worktree") ||
		result.ProviderVersion != "" || result.BranchPushed || pushes != 0 || branch != harness.command.Branch ||
		!strings.Contains(runGit(t, harness.worktree, "status", "--porcelain"), "unreviewed.txt") {
		t.Fatalf("candidate changed during verification was published: %#v after %d pushes", result, pushes)
	}
}

func TestPublishOnlySuccessDoesNotReportSyntheticProviderVersion(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	bare := filepath.Join(t.TempDir(), "remote.git")
	if err := os.MkdirAll(bare, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, bare, "init", "--bare")
	runGit(t, harness.repository, "remote", "add", "origin", "https://github.com/test/repository.git")
	seedOriginMain(t, harness.repository, bare)
	runGit(t, harness.repository, "config", "url.file://"+filepath.ToSlash(bare)+".insteadOf", "https://github.com/test/repository.git")
	runGit(t, harness.repository, "config", "remote.origin.pushurl", "https://github.com/test/repository")
	harness.gitRemote = "github.com/test/repository"
	harness.runner.config.Repositories[harness.gitRemote] = harness.runner.config.Repositories[""]
	harness.runner.push = func(context.Context, string, string, string, string) error { return nil }
	if err := harness.process(); err != nil {
		t.Fatalf("create candidate: %v", err)
	}
	candidate := harness.results[0]
	harness.queue = []workerapi.AgentRunCommand{{
		ID: harness.command.ID, ProjectID: harness.command.ProjectID, Branch: harness.command.Branch,
		BaseBranch: harness.command.BaseBranch, Attempts: 2, PublishPullRequest: true, PublishOnly: true,
		PublishCommit: candidate.CommitSHA,
	}}
	if err := harness.process(); err != nil {
		t.Fatalf("publish authorized candidate: %v", err)
	}
	result := harness.results[1]
	if result.Status != "succeeded" || !result.BranchPushed || result.ProviderVersion != "" {
		t.Fatalf("publish-only result overwrote provider evidence: %#v", result)
	}
}

func TestPublishOnlyRemoteValidationFailureHasNoCandidateOrProviderVersion(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("create candidate: %v", err)
	}
	candidate := harness.results[0]
	harness.gitRemote = "github.com/test/repository"
	harness.runner.config.Repositories[harness.gitRemote] = harness.runner.config.Repositories[""]
	harness.queue = []workerapi.AgentRunCommand{{
		ID: harness.command.ID, ProjectID: harness.command.ProjectID, Branch: harness.command.Branch,
		BaseBranch: harness.command.BaseBranch, Attempts: 2, PublishPullRequest: true, PublishOnly: true,
		PublishCommit: candidate.CommitSHA,
	}}
	if err := harness.process(); err != nil {
		t.Fatalf("report remote validation failure: %v", err)
	}
	result := harness.results[1]
	if result.Status != "failed" || result.CommitSHA != "" || result.ProviderVersion != "" ||
		!strings.Contains(result.Error, "Could not validate the run branch's GitHub remote") {
		t.Fatalf("publish-only remote validation failure = %#v", result)
	}
}
