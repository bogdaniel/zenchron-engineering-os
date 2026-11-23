package main

import (
	"context"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublishOnlyRunDoesNotPublishWhenVerificationChangesCandidate(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
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
	repository := harness.runner.config.Repositories[""]
	repository.Verify = [][]string{{"sh", "-c", "touch unreviewed.txt"}}
	harness.runner.config.Repositories[""] = repository
	harness.queue = []workerapi.AgentRunCommand{{
		ID: harness.command.ID, ProjectID: harness.command.ProjectID, Branch: harness.command.Branch,
		BaseBranch: harness.command.BaseBranch, Attempts: 2, PublishPullRequest: true, PublishOnly: true,
		PublishCommit: candidate.CommitSHA,
	}}
	if err := harness.process(); err != nil {
		t.Fatalf("reject candidate changed during verification: %v", err)
	}
	result := harness.results[1]
	if result.Status != "failed" || result.BranchPushed || pushes != 0 {
		t.Fatalf("candidate changed during verification was published: %#v after %d pushes", result, pushes)
	}
}
