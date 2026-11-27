package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPlanApprovalWaitsForAVerifiedSourceAndPinsItBeforeDispatch(t *testing.T) {
	harness := newGraphHarness(t)
	plan, _ := harness.propose(harness.twoProducerPlan())
	path := fmt.Sprintf("/api/v1/objectives/%s/plans/%d/approve", harness.objectiveID, plan.Revision)
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted {
		t.Fatalf("first approval = HTTP %d, want a queued source check", response.Code)
	}
	// Approving again while the check is still queued neither approves nor queues a second check.
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted || harness.runCount() != 0 {
		t.Fatalf("approval during the check = HTTP %d with %d work runs", response.Code, harness.runCount())
	}
	harness.answerSourceCheck(commit(7))
	graph, status := harness.approve(plan.Revision)
	if status != http.StatusCreated || graph.BaseCommit != commit(7) {
		t.Fatalf("approval after the check = HTTP %d, base %q", status, graph.BaseCommit)
	}
	// The base is pinned before any unit is dispatched, so even parallel root units share it.
	if api, ui := harness.claimUnit("api"), harness.claimUnit("ui"); api.StartCommit != commit(7) || ui.StartCommit != commit(7) {
		t.Fatalf("root units start at %q and %q, want the verified %q", api.StartCommit, ui.StartCommit, commit(7))
	}
}

func TestPlanApprovalFailsClosedWhenTheSourceCheckFails(t *testing.T) {
	harness := newGraphHarness(t)
	plan, _ := harness.propose(harness.twoProducerPlan())
	path := fmt.Sprintf("/api/v1/objectives/%s/plans/%d/approve", harness.objectiveID, plan.Revision)
	harness.call(http.MethodPost, path, "")
	check := harness.claim()
	refusal := "Source check failed: local main is at " + commit(1) + " but origin/main is at " + commit(2) + "."
	harness.report(check, workerapi.AgentRunResult{Status: "failed", Error: refusal,
		TerminationReason: workerapi.TerminationWorkerError})
	response := harness.call(http.MethodPost, path, "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), commit(1)) ||
		!strings.Contains(response.Body.String(), commit(2)) {
		t.Fatalf("approval after a failed check = HTTP %d %q, want a refusal naming both commits", response.Code, response.Body.String())
	}
	if harness.runCount() != 0 {
		t.Fatalf("a refused approval dispatched %d work runs", harness.runCount())
	}
	// Approving again is the retry path: it starts a fresh check instead of reusing the failed one.
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted {
		t.Fatalf("retry after a refusal = HTTP %d, want a new source check", response.Code)
	}
	if again := harness.claim(); !again.VerifySource || again.ID == check.ID {
		t.Fatalf("retry did not queue a new source check: %#v", again)
	}
}

func TestJudgeSourceRequiresAFreshMatchingCheck(t *testing.T) {
	now := time.Date(2026, time.November, 27, 12, 0, 0, 0, time.UTC)
	plan := objectivePlan{SourceCheckRunID: "check"}
	planner := agentRun{ID: "planner", BaseCommit: commit(1)}
	verified := agentRun{ID: "check", Status: "succeeded", BaseCommit: commit(1), UpdatedAt: now}
	for _, test := range []struct {
		name  string
		plan  objectivePlan
		check agentRun
		want  sourceVerdict
	}{
		{"no check yet", objectivePlan{}, agentRun{}, sourceNeedsCheck},
		{"another run", plan, agentRun{ID: "other", Status: "succeeded", BaseCommit: commit(1), UpdatedAt: now}, sourceNeedsCheck},
		{"still running", plan, agentRun{ID: "check", Status: "running"}, sourceChecking},
		{"failed", plan, agentRun{ID: "check", Status: "failed", Error: "offline"}, sourceRefused},
		{"source moved since planning", plan, agentRun{ID: "check", Status: "succeeded", BaseCommit: commit(2), UpdatedAt: now}, sourceRefused},
		{"stale", plan, agentRun{ID: "check", Status: "succeeded", BaseCommit: commit(1), UpdatedAt: now.Add(-3 * time.Minute)}, sourceNeedsCheck},
		{"verified", plan, verified, sourceVerified},
	} {
		if _, got := test.plan.judgeSource(test.check, planner, now); got != test.want {
			t.Errorf("%s: verdict = %d, want %d", test.name, got, test.want)
		}
	}
}
