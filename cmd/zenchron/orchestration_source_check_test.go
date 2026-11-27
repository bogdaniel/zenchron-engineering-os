package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func (harness *graphHarness) approvePath(revision int) string {
	return fmt.Sprintf("/api/v1/objectives/%s/plans/%d/approve", harness.objectiveID, revision)
}

func (harness *graphHarness) sourceChecks() int {
	harness.store.mu.Lock()
	defer harness.store.mu.Unlock()
	count := 0
	for _, item := range harness.store.items {
		if item.VerifySource {
			count++
		}
	}
	return count
}

func TestPlanApprovalWaitsForAVerifiedSourceAndPinsItBeforeDispatch(t *testing.T) {
	harness := newGraphHarness(t)
	plan, _ := harness.propose(harness.twoProducerPlan())
	if plan.SourceCommit != commit(9) {
		t.Fatalf("proposed plan source = %q, want the checkout commit the worker reported", plan.SourceCommit)
	}
	path := harness.approvePath(plan.Revision)
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted {
		t.Fatalf("first approval = HTTP %d, want a queued source check", response.Code)
	}
	// Approving again while the check is queued neither approves nor queues a second check.
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted ||
		harness.runCount() != 0 || harness.sourceChecks() != 1 {
		t.Fatalf("approval during the check = HTTP %d, %d work runs, %d checks", response.Code, harness.runCount(), harness.sourceChecks())
	}
	harness.answerSourceCheck(commit(9))
	graph, status := harness.approve(plan.Revision)
	if status != http.StatusCreated || graph.BaseCommit != commit(9) {
		t.Fatalf("approval after the check = HTTP %d, base %q", status, graph.BaseCommit)
	}
	// The base is pinned before any unit is dispatched, so even parallel root units share it.
	if api, ui := harness.claimUnit("api"), harness.claimUnit("ui"); api.StartCommit != commit(9) || ui.StartCommit != commit(9) {
		t.Fatalf("root units start at %q and %q, want the verified %q", api.StartCommit, ui.StartCommit, commit(9))
	}
}

func TestPlanApprovalRequiresReplanningWhenUpstreamMovedSinceProposal(t *testing.T) {
	harness := newGraphHarness(t)
	plan, _ := harness.propose(harness.twoProducerPlan())
	path := harness.approvePath(plan.Revision)
	harness.call(http.MethodPost, path, "")
	// Proposed against commit 9; origin has since moved to commit 7, which the check verifies as current.
	harness.answerSourceCheck(commit(7))
	response := harness.call(http.MethodPost, path, "")
	body := response.Body.String()
	if response.Code != http.StatusConflict || !strings.Contains(body, commit(9)) || !strings.Contains(body, commit(7)) ||
		!strings.Contains(body, "Propose the plan again") || harness.runCount() != 0 {
		t.Fatalf("approval after upstream moved = HTTP %d %q with %d work runs", response.Code, body, harness.runCount())
	}
}

func TestPlanApprovalFailsClosedWhenTheSourceCheckFails(t *testing.T) {
	harness := newGraphHarness(t)
	plan, _ := harness.propose(harness.twoProducerPlan())
	path := harness.approvePath(plan.Revision)
	harness.call(http.MethodPost, path, "")
	check := harness.claim()
	refusal := "Source check failed: local main is at " + commit(1) + " but origin/main is at " + commit(2) + "."
	harness.report(check, workerapi.AgentRunResult{Status: "failed", Error: refusal,
		TerminationReason: workerapi.TerminationWorkerError})
	response := harness.call(http.MethodPost, path, "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), commit(1)) ||
		!strings.Contains(response.Body.String(), commit(2)) || harness.runCount() != 0 {
		t.Fatalf("approval after a failed check = HTTP %d %q", response.Code, response.Body.String())
	}
	// Approving again is the retry path: it starts a fresh check instead of reusing the failed one.
	if response := harness.call(http.MethodPost, path, ""); response.Code != http.StatusAccepted {
		t.Fatalf("retry after a refusal = HTTP %d, want a new source check", response.Code)
	}
	if again := harness.claim(); !again.VerifySource || again.ID == check.ID {
		t.Fatalf("retry did not queue a new source check: %#v", again)
	}
}

func TestPlanApprovalRefusesAPlanWithoutASourceBaseline(t *testing.T) {
	harness := newGraphHarness(t)
	// An older worker reports no checkout commit, so the plan cannot be bound to the code it was prepared against.
	body := `{"name":"worker","providers":[{"id":"codex-cli","version":"1.2.3","ready":true}],"projects":[{"id":"` +
		testProjectID + `","name":"platform","branch":"main","git_remote":"github.com/acme/platform"}]}`
	if response := harness.call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", body); response.Code != http.StatusOK {
		t.Fatalf("heartbeat = HTTP %d", response.Code)
	}
	plan, _ := harness.propose(harness.twoProducerPlan())
	response := harness.call(http.MethodPost, harness.approvePath(plan.Revision), "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "no source commit") || harness.sourceChecks() != 0 {
		t.Fatalf("approval without a baseline = HTTP %d %q", response.Code, response.Body.String())
	}
}

func TestRefusedPlannerRunReadsAsOneSentence(t *testing.T) {
	harness := newGraphHarness(t)
	harness.propose(`{"project_id":"` + testProjectID + `","planner_agent_id":"` + harness.reviewer.ID + `"}`)
	command := harness.claim()
	harness.report(command, workerapi.AgentRunResult{Status: "failed", TerminationReason: workerapi.TerminationWorkerError,
		Error: "Refused to start: local main differs from origin/main; fast-forward or reconcile the checkout, then retry."})
	plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	want := "The planning run did not finish: Refused to start: local main differs from origin/main; " +
		"fast-forward or reconcile the checkout, then retry."
	if len(plans) != 1 || plans[0].Status != planInvalid || len(plans[0].Problems) != 1 || plans[0].Problems[0] != want {
		t.Fatalf("refused planner problem = %#v, want %q", plans, want)
	}
}

func TestJudgeSourceRequiresAFreshBoundMatchingCheck(t *testing.T) {
	now := time.Date(2026, time.November, 27, 12, 0, 0, 0, time.UTC)
	project := projectRecord{ID: testProjectID, WorkerID: testWorkerID, Branch: "main"}
	plan := objectivePlan{ObjectiveID: "objective", Revision: 2, Hash: "hash", ProjectID: testProjectID,
		Repository: "github.com/acme/platform", SourceCommit: commit(1), SourceCheckRunID: "check"}
	bound := func(change func(*agentRun)) agentRun {
		check := agentRun{ID: "check", VerifySource: true, SourceCheckFor: plan.sourceCheckFor(), ProjectID: testProjectID,
			WorkerID: testWorkerID, BaseBranch: "main", Repository: plan.Repository, Status: "succeeded",
			BaseCommit: commit(1), UpdatedAt: now}
		if change != nil {
			change(&check)
		}
		return check
	}
	withoutBaseline := plan
	withoutBaseline.SourceCommit = ""
	for _, test := range []struct {
		name  string
		plan  objectivePlan
		check agentRun
		want  sourceVerdict
	}{
		{"no baseline", withoutBaseline, bound(nil), sourceNoBaseline},
		{"verified", plan, bound(nil), sourceVerified},
		{"another plan revision", plan, bound(func(c *agentRun) { c.SourceCheckFor = "objective:1:hash" }), sourceNeedsCheck},
		{"another worker", plan, bound(func(c *agentRun) { c.WorkerID = "other" }), sourceNeedsCheck},
		{"another branch", plan, bound(func(c *agentRun) { c.BaseBranch = "release" }), sourceNeedsCheck},
		{"another repository", plan, bound(func(c *agentRun) { c.Repository = "github.com/acme/other" }), sourceNeedsCheck},
		{"not a source check", plan, bound(func(c *agentRun) { c.VerifySource = false }), sourceNeedsCheck},
		{"missing after restart", plan, agentRun{}, sourceNeedsCheck},
		{"still running", plan, bound(func(c *agentRun) { c.Status = "running" }), sourceChecking},
		{"failed", plan, bound(func(c *agentRun) { c.Status = "failed" }), sourceRefused},
		{"upstream moved", plan, bound(func(c *agentRun) { c.BaseCommit = commit(2) }), sourceRefused},
		{"stale", plan, bound(func(c *agentRun) { c.UpdatedAt = now.Add(-3 * time.Minute) }), sourceNeedsCheck},
	} {
		if _, got := test.plan.judgeSource(test.check, project, now); got != test.want {
			t.Errorf("%s: verdict = %d, want %d", test.name, got, test.want)
		}
	}
}
