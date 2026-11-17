package main

import (
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func reviewerRecoveryHarness(t *testing.T) (*graphHarness, workGraph, workerapi.AgentRunCommand) {
	t.Helper()
	harness := newGraphHarness(t)
	harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api")))
	producer := harness.claimUnit("api")
	harness.handOff(producer, commit(1), "api")
	return harness, harness.graph(), harness.claimUnit("review-api")
}

func TestReviewerInvocationRecoveryKeepsAssignmentCandidateAndSurvivesRestart(t *testing.T) {
	harness, graph, failed := reviewerRecoveryHarness(t)
	harness.report(failed, workerapi.AgentRunResult{Status: "failed", Error: "provider request timed out",
		TerminationReason: workerapi.TerminationProviderExit, BaseCommit: commit(1)})

	recovered := harness.unit("review-api")
	if len(recovered.RunIDs) != 2 || !recovered.RecoveryUsed || recovered.Candidate != "" || recovered.Failure != "" ||
		recovered.AgentID != harness.reviewer.ID || graph.PlanHash != harness.graph().PlanHash {
		t.Fatalf("reviewer recovery changed assignment or graph state: %#v", recovered)
	}
	harness.restart()
	if harness.runCount() != 3 || !harness.unit("review-api").RecoveryUsed {
		t.Fatalf("restart duplicated or forgot recovery: %d runs, %#v", harness.runCount(), harness.unit("review-api"))
	}
	retry := harness.claimUnit("review-api")
	run, _ := harness.store.get(retry.ID)
	previous, _ := harness.store.get(failed.ID)
	if retry.ID == failed.ID || run.AgentID != harness.reviewer.ID || run.BaseBranch != previous.BaseBranch ||
		!strings.Contains(retry.Prompt, commit(1)) || !run.ReviewRecovery {
		t.Fatalf("recovery run lost its assignment or candidate: %#v, %#v", retry, run)
	}
	harness.verdict(retry, commit(1), `{"review":{"verdict":"accept"}}`)
	if unit := harness.unit("review-api"); unit.Verdict != "accept" || unit.Failure != "" || len(unit.RunIDs) != 2 {
		t.Fatalf("recovery verdict was not admitted on the same candidate: %#v", unit)
	}
}

func TestReviewerRecoveryExhaustionReportsFailureWithoutInventingVerdict(t *testing.T) {
	harness, _, first := reviewerRecoveryHarness(t)
	harness.report(first, workerapi.AgentRunResult{Status: "failed", Error: "provider timed out",
		TerminationReason: workerapi.TerminationWallClock, BaseCommit: commit(1)})
	retry := harness.claimUnit("review-api")
	harness.report(retry, workerapi.AgentRunResult{Status: "failed", Error: "provider exited again",
		TerminationReason: workerapi.TerminationProviderExit, BaseCommit: commit(1)})
	unit := harness.unit("review-api")
	if unit.State != unitFailed || unit.Verdict != "" || unit.Failure != "provider exited again" || len(unit.RunIDs) != 2 {
		t.Fatalf("exhausted recovery state = %#v", unit)
	}
	if harness.unit("api").Candidate != commit(1) || harness.graph().Status != graphFailed {
		t.Fatalf("failed review discarded the held candidate or graph failure: %#v", harness.unit("api"))
	}
	harness.nothingToClaim()
}

func TestReviewerProtocolFailureGetsOnlyOneRecovery(t *testing.T) {
	harness, _, first := reviewerRecoveryHarness(t)
	harness.report(first, workerapi.AgentRunResult{BaseCommit: commit(1), Output: "Review finished without a typed verdict."})
	retry := harness.claimUnit("review-api")
	harness.report(retry, workerapi.AgentRunResult{BaseCommit: commit(1), Output: "Still no typed verdict."})
	unit := harness.unit("review-api")
	if unit.State != unitFailed || unit.Verdict != "" || !strings.Contains(unit.Failure, "did not produce an admissible verdict") ||
		len(unit.RunIDs) != 2 {
		t.Fatalf("protocol recovery state = %#v", unit)
	}
	harness.nothingToClaim()
}
