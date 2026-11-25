package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	harness.authorizePublication(integration.ID, commit(4))

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

func TestCancelledRequeuedProducerFailsItsWorkGraphUnit(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api")))
	api := harness.claimUnit("api")
	harness.handOff(api, commit(1), "api")
	harness.verdict(harness.claimUnit("review-api"), commit(1), blockAPI)
	queued, exists := harness.store.get(api.ID)
	if !exists || queued.Status != "queued" || queued.Attempts != 1 {
		t.Fatalf("remediation run = status %q attempt %d", queued.Status, queued.Attempts)
	}
	if response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+api.ID+"/cancel", ""); response.Code != http.StatusAccepted {
		t.Fatalf("cancel requeued remediation returned HTTP %d", response.Code)
	}
	graph = harness.graph()
	if unit := graph.unit("api"); unit.State != unitFailed || unit.Failure == "" || graph.Status != graphFailed {
		t.Fatalf("cancelled remediation left graph %s and unit %#v", graph.Status, unit)
	}
}

func TestCancelledQueuedPublicationFailsItsWorkGraphUnit(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api"),
		unitJSON("check", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		Result: "{\"integration\":{}}"})
	harness.verdict(harness.claimUnit("check"), commit(4), "{\"review\":{\"verdict\":\"accept\"}}")
	if queued, exists := harness.store.get(integration.ID); !exists || queued.Status != "succeeded" {
		t.Fatalf("candidate was queued for publication before authorization: %#v", queued)
	}
	harness.authorizePublication(integration.ID, commit(4))
	queued, exists := harness.store.get(integration.ID)
	if !exists || queued.Status != "queued" || queued.Attempts != 1 {
		t.Fatalf("publication run = exists %t status %q attempt %d", exists, queued.Status, queued.Attempts)
	}
	if response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/cancel", ""); response.Code != http.StatusAccepted {
		t.Fatalf("cancel queued publication returned HTTP %d", response.Code)
	}
	graph := harness.graph()
	if unit := graph.unit("integrate"); unit.State != unitFailed || unit.Failure == "" || graph.Status != graphFailed {
		t.Fatalf("cancelled publication left graph %s and unit %#v", graph.Status, unit)
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

func TestUnitIsNotReportedBlockedWhileItsPullRequestIsBeingCreated(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID), unitJSON("integrate", unitIntegrate, "", "api"),
		unitJSON("check", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("check"), commit(4), `{"review":{"verdict":"accept"}}`)
	harness.authorizePublication(integration.ID, commit(4))
	publication := harness.claimUnit("integrate")
	graphID := harness.graph().ID
	var during workGraph
	var cancelStatus int
	harness.duringPullCreate = func() {
		current, exists := harness.store.get(integration.ID)
		if !exists || !current.Publishing {
			t.Error("authorized publication did not hold its in-flight barrier")
		}
		cancelStatus = harness.call(http.MethodPost, "/api/v1/work-graphs/"+graphID+"/cancel", "").Code
		during = harness.graph()
	}
	harness.report(publication, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		BranchPushed: true, Result: `{"integration":{}}`})
	if cancelStatus != http.StatusConflict {
		t.Fatalf("cancellation during authorized PR creation returned HTTP %d, want %d", cancelStatus, http.StatusConflict)
	}
	if unit := during.unit("integrate"); unit.State != unitWaiting || unit.Reason != "Creating the pull request." || during.Status != graphActive {
		t.Fatalf("while GitHub was answering: graph %s, integrate %s %q", during.Status, unit.State, unit.Reason)
	}
	if graph := harness.graph(); graph.Status != graphCompleted {
		t.Fatalf("after publication: %s", graph.Status)
	}
}

func TestGraphCancellationIsRejectedDuringAuthorizedPullRequestRetry(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api"), unitJSON("check", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("check"), commit(4), `{"review":{"verdict":"accept"}}`)
	graphID := harness.graph().ID
	harness.authorizePublication(integration.ID, commit(4))
	publication := harness.claimUnit("integrate")
	harness.mu.Lock()
	harness.failPullCreate = true
	harness.mu.Unlock()
	harness.report(publication, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		BranchPushed: true, Result: `{"integration":{}}`})
	if run, _ := harness.store.get(integration.ID); run.Publication != publicationPullRequestFailed || run.Publishing {
		t.Fatalf("failed initial publication = %#v", run)
	}
	harness.mu.Lock()
	harness.failPullCreate = false
	harness.mu.Unlock()

	var cancelStatus int
	harness.duringPullCreate = func() {
		cancelStatus = harness.call(http.MethodPost, "/api/v1/work-graphs/"+graphID+"/cancel", "").Code
	}
	response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
		fmt.Sprintf(`{"candidate_sha":%q}`, commit(4)))
	var retried agentRun
	if err := json.NewDecoder(response.Body).Decode(&retried); err != nil || response.Code != http.StatusOK || retried.PullRequestURL == "" {
		t.Fatalf("authorized PR retry = HTTP %d, run %#v, decode error %v", response.Code, retried, err)
	}
	if cancelStatus != http.StatusConflict {
		t.Fatalf("cancellation during PR creation returned HTTP %d, want %d", cancelStatus, http.StatusConflict)
	}
	if graph := harness.graph(); graph.Status == graphCancelled {
		t.Fatalf("work graph was cancelled while its authorized PR was being created: %#v", graph)
	}
}

func TestPublicationPersistenceFailureReleasesUpdateBarrier(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api"), unitJSON("check", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("check"), commit(4), `{"review":{"verdict":"accept"}}`)
	harness.authorizePublication(integration.ID, commit(4))
	publication := harness.claimUnit("integrate")
	statePath := harness.store.path
	failedPath := filepath.Join(t.TempDir(), "missing", "agent-runs.json")
	harness.duringPullCreate = func() {
		harness.store.path = failedPath
	}
	result, _ := json.Marshal(workerapi.AgentRunResult{Status: "succeeded", Attempts: publication.Attempts,
		CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.", BranchPushed: true,
		TerminationReason: workerapi.TerminationCompleted})
	if _, status := harness.finish(integration.ID, string(result)); status != http.StatusInternalServerError {
		t.Fatalf("finish after the post-publication write failure returned HTTP %d", status)
	}
	harness.store.path = statePath
	harness.store.mu.Lock()
	item := harness.store.items[integration.ID]
	harness.store.mu.Unlock()
	if item.Publishing {
		t.Fatal("failed publication persistence left the run marked as publishing")
	}

	t.Setenv("ZENCHRON_MANAGED_SUPERVISOR_TOKEN", "supervisor-secret")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/update/active-runs", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Zenchron-Supervisor-Token", "supervisor-secret")
	response := httptest.NewRecorder()
	activeSystemRunCount(response, request, harness.store)
	var active struct {
		Runs int `json:"active_runs"`
	}
	if err := json.NewDecoder(response.Body).Decode(&active); err != nil || response.Code != http.StatusOK || active.Runs != 0 {
		t.Fatalf("active runs after publication write failure = %d, HTTP %d, %v", active.Runs, response.Code, err)
	}
	if unit := harness.unit("integrate"); unit.Reason == "Creating the pull request." {
		t.Fatal("WorkGraph remained stuck on pull-request creation after the write failure")
	}
	restarted, err := openAgentRunStore(statePath, harness.store.registry, harness.store.agents)
	if err != nil {
		t.Fatalf("reopen run store after publication failure: %v", err)
	}
	if restarted.items[integration.ID].Publishing {
		t.Fatal("recovered run was marked as publishing")
	}
	harness.duringPullCreate = nil
	harness.restart()
	response = harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
		fmt.Sprintf(`{"candidate_sha":%q}`, commit(4)))
	var published agentRun
	if err := json.NewDecoder(response.Body).Decode(&published); err != nil || response.Code != http.StatusOK ||
		published.Publication != publicationPublished || published.PullRequestURL == "" {
		t.Fatalf("publication retry after restart = HTTP %d, run %#v, decode error %v", response.Code, published, err)
	}
	if harness.pullCreates != 1 {
		t.Fatalf("restart retry created %d pull requests, want the already-created pull request to be reused", harness.pullCreates)
	}
}
