package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublicationPassIsBoundToTheReviewedCommitAndAFailedPushIsRetried(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID), unitJSON("integrate", unitIntegrate, "", "api"),
		unitJSON("check", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	if integration.PublishCommit != "" {
		t.Fatalf("the first integration pass was bound to a commit before any existed: %q", integration.PublishCommit)
	}
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.", Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("check"), commit(4), `{"review":{"verdict":"accept"}}`)

	// The worker is told the one commit it may push, and refuses any other before pushing.
	publication := harness.claimUnit("integrate")
	if publication.PublishCommit != commit(4) || !publication.PublishPullRequest {
		t.Fatalf("publication command = commit %q publish %v", publication.PublishCommit, publication.PublishPullRequest)
	}
	harness.report(publication, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		BranchPushFailed: true, Result: `{"integration":{}}`})
	if harness.pullCreates != 0 {
		t.Fatalf("a pull request was created without a pushed branch")
	}
	// A failed push is not a dead end: the same run publishes again while it has attempts.
	retry := harness.claimUnit("integrate")
	if retry.ID != integration.ID || retry.Attempts != 3 || retry.PublishCommit != commit(4) {
		t.Fatalf("publication retry = run %s attempt %d commit %q", retry.ID, retry.Attempts, retry.PublishCommit)
	}
	harness.report(retry, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		BranchPushed: true, Result: `{"integration":{}}`})
	if graph := harness.graph(); graph.Status != graphCompleted || harness.pullCreates != 1 {
		t.Fatalf("after the retried push: %s, pull requests %d", graph.Status, harness.pullCreates)
	}
}

func TestAdoptedReviewRunDoesNotInheritTheVerdictOfTheRoundBeforeIt(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("check", unitReview, harness.reviewer.ID, "api"), unitJSON("integrate", unitIntegrate, "", "check")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	first := harness.claimUnit("check")
	// The control plane stopped after queueing the review run and before recording it: an accept from an
	// earlier round is still on the unit when the run is adopted.
	harness.store.graphs.mu.Lock()
	unit := harness.store.graphs.graphs[graph.ID].unit("check")
	unit.RunIDs, unit.Verdict = []string{}, "accept"
	harness.store.graphs.mu.Unlock()
	if adopted := harness.unit("check"); adopted.Verdict != "" || len(adopted.RunIDs) != 1 || adopted.State == unitCompleted {
		t.Fatalf("adopted review unit = %#v", adopted)
	}
	// Its result carries no verdict, so the candidate stays unreviewed and integration does not start.
	harness.verdict(first, commit(1), "")
	if graph := harness.graph(); graph.unit("check").State == unitCompleted || len(graph.unit("integrate").RunIDs) != 0 {
		t.Fatalf("an unreviewed candidate reached integration: %#v", graph.Units)
	}
}

func TestCancelledGraphFollowsItsRunningRunUntilItStops(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", "")
	if unit := harness.unit("api"); unit.State != unitRunning {
		t.Fatalf("unit of a run that is still stopping = %s", unit.State)
	}
	harness.report(api, workerapi.AgentRunResult{Status: "cancelled", TerminationReason: workerapi.TerminationCancelled})
	if graph := harness.graph(); graph.unit("api").State != unitCancelled || graph.Status != graphCancelled {
		t.Fatalf("after the run stopped: %s %s", graph.Status, graph.unit("api").State)
	}
}

func TestPlanHistoryIsBoundedAndAPlanNeedsAProducer(t *testing.T) {
	harness := newGraphHarness(t)
	if _, response := harness.propose(harness.planBody(unitJSON("integrate", unitIntegrate, ""))); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("a plan without a produce unit returned HTTP %d", response.StatusCode)
	}
	for revision := 1; revision <= maxPlanRevisions; revision++ {
		body := harness.planBody(unitJSON(fmt.Sprintf("unit-%d", revision), unitProduce, harness.profile.ID),
			unitJSON("integrate", unitIntegrate, "", fmt.Sprintf("unit-%d", revision)))
		if _, response := harness.propose(body); response.StatusCode != http.StatusCreated {
			t.Fatalf("revision %d returned HTTP %d", revision, response.StatusCode)
		}
	}
	if _, response := harness.propose(harness.twoProducerPlan()); response.StatusCode != http.StatusConflict {
		t.Fatalf("a revision past the limit returned HTTP %d", response.StatusCode)
	}
}

func TestPlansAndGraphsNeedTheRepositoryGrantNotOnlyTheObjective(t *testing.T) {
	harness := newAccessHarness(t)
	harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA))
	var created objective
	_ = json.NewDecoder(harness.user("alice", http.MethodPost, "/api/v1/objectives", `{"title":"Export"}`).Body).Decode(&created)
	plans := "/api/v1/objectives/" + created.ID + "/plans"
	plan := `{"project_id":"` + projectA + `","plan":{"summary":"","max_parallel":1,"units":[` +
		unitJSON("api", unitProduce, harness.profile.ID) + `,` + unitJSON("integrate", unitIntegrate, "", "api") + `]}}`
	harness.user("alice", http.MethodPost, plans, plan)
	if response := harness.user("alice", http.MethodPost, plans+"/1/approve", ""); response.Code != http.StatusCreated {
		t.Fatalf("approve returned HTTP %d", response.Code)
	}
	// Alice keeps her objective but loses the repository.
	revoked := fmt.Sprintf(`{"workers":[%s],"users":{"alice":[],"bob":[%q]}}`, enrolledWorkers(), repositoryC)
	if err := os.WriteFile(harness.path, []byte(revoked), 0o600); err != nil {
		t.Fatal(err)
	}
	if visible := decodeList[objective](t, harness.user("alice", http.MethodGet, "/api/v1/objectives", "")); len(visible) != 1 {
		t.Fatalf("alice no longer sees her objective: %#v", visible)
	}
	if listed := decodeList[objectivePlan](t, harness.user("alice", http.MethodGet, plans, "")); len(listed) != 0 {
		t.Fatalf("plans of a repository without a grant are listed: %#v", listed)
	}
	if response := harness.user("alice", http.MethodPost, plans+"/1/approve", ""); response.Code == http.StatusOK {
		t.Fatalf("re-approving returned the graph of a repository without a grant: %s", response.Body.String())
	}
	if graphs := decodeList[workGraph](t, harness.user("alice", http.MethodGet, "/api/v1/work-graphs", "")); len(graphs) != 0 {
		t.Fatalf("graphs of a repository without a grant are listed: %#v", graphs)
	}
}
