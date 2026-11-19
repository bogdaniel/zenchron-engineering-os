package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func (harness *graphHarness) twoProducerPlan() string {
	return harness.planBody(unitJSON("api", unitProduce, harness.profile.ID), unitJSON("ui", unitProduce, harness.second.ID),
		unitJSON("integrate", unitIntegrate, "", "api", "ui"))
}

// restart reopens the run store and the graph store from disk, as a restarted control plane does.
func (harness *graphHarness) restart() {
	harness.t.Helper()
	graphs := harness.store.graphs
	runs, err := openAgentRunStore(harness.path, harness.store.registry, harness.store.agents)
	if err != nil {
		harness.t.Fatal(err)
	}
	if runs.graphs, err = openWorkGraphStore(graphs.path, runs, graphs.objectives, graphs.agents, graphs.workflows); err != nil {
		harness.t.Fatal(err)
	}
	harness.store = runs
	harness.server = newMuxWithStores(graphs.objectives, graphs.workflows, runs.agents, newProductStore(), runs.registry, runs)
}

func (harness *graphHarness) runCount() int {
	harness.store.mu.Lock()
	defer harness.store.mu.Unlock()
	return len(harness.store.items)
}

func TestWorkGraphRecoversAfterRestartWithoutQueueingWorkTwice(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	harness.restart()
	// The interrupted attempt is queued again by the run store; the graph still points at the same runs.
	if recovered := harness.graph(); recovered.ID != graph.ID || recovered.unit("api").State != unitQueued ||
		recovered.unit("api").RunIDs[0] != api.ID || harness.runCount() != 2 {
		t.Fatalf("graph after restart = %#v, runs %d", recovered.Units, harness.runCount())
	}

	// A control plane that stopped after queueing a run but before recording it on the unit adopts the
	// run instead of queueing the same work a second time.
	harness.store.graphs.mu.Lock()
	harness.store.graphs.graphs[graph.ID].unit("ui").RunIDs = []string{}
	harness.store.graphs.mu.Unlock()
	if unit := harness.unit("ui"); len(unit.RunIDs) != 1 || harness.runCount() != 2 {
		t.Fatalf("unrecorded run was not adopted: %#v, runs %d", unit, harness.runCount())
	}
	second := harness.claim()
	harness.claim()
	if second.Attempts < 1 || harness.runCount() != 2 {
		t.Fatalf("reclaim after restart created runs: %d", harness.runCount())
	}
}

func TestIntegrationWaitsForRetriedTransitiveProducer(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("ui", unitProduce, harness.second.ID, "api"),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "ui")))
	api := harness.claimUnit("api")
	harness.handOff(api, commit(1), "api")
	ui, review := harness.claimUnit("ui"), harness.claimUnit("review-api")
	harness.verdict(review, commit(1), blockAPI)
	failedAttempt := harness.claimUnit("api")
	harness.report(failedAttempt, workerapi.AgentRunResult{
		CommitSHA: commit(1), BaseCommit: commit(9), Output: "No handoff.",
	})
	lastAttempt := harness.claimUnit("api")
	if lastAttempt.Attempts != 3 {
		t.Fatalf("last producer attempt = %d, want 3", lastAttempt.Attempts)
	}
	harness.handOff(ui, commit(2), "ui")
	harness.report(lastAttempt, workerapi.AgentRunResult{
		CommitSHA: commit(1), BaseCommit: commit(9), Output: "No handoff.",
	})
	graph = harness.graph()
	if unit := graph.unit("api"); unit.Failure == "" || graph.unit("integrate").State != unitBlocked {
		t.Fatalf("exhausted producer did not block integration: %#v", unit)
	}
	retryPath := "/api/v1/work-graphs/" + graph.ID + "/units/api/retry"
	if response := harness.call(http.MethodPost, retryPath, ""); response.Code != http.StatusOK {
		t.Fatalf("retry returned HTTP %d", response.Code)
	}
	graph = harness.graph()
	apiUnit := graph.unit("api")
	if len(apiUnit.RunIDs) == 0 {
		t.Fatal("producer retry did not create a run")
	}
	retried, exists := harness.store.get(apiUnit.RunIDs[len(apiUnit.RunIDs)-1])
	if !exists || retried.ID == api.ID || retried.Branch == api.Branch || retried.Status != "queued" {
		t.Fatalf("retry did not queue a fresh producer run and branch: %#v", retried)
	}
	if graph.unit("api").State != unitQueued || graph.unit("api").Candidate != commit(1) ||
		graph.unit("integrate").State != unitWaiting || len(graph.unit("integrate").RunIDs) != 0 || harness.pullCreates != 0 {
		t.Fatalf("integration advanced during producer retry: api %#v, integrate %#v, pull requests %d",
			graph.unit("api"), graph.unit("integrate"), harness.pullCreates)
	}
	retriedAPI := harness.claimUnit("api")
	harness.handOff(retriedAPI, commit(3), "api retry")
	graph = harness.graph()
	integrationUnit := graph.unit("integrate")
	if len(integrationUnit.RunIDs) == 0 {
		t.Fatal("integration did not start after every producer settled")
	}
	integration, exists := harness.store.get(integrationUnit.RunIDs[0])
	if !exists || len(integration.Merge) != 2 || integration.Merge[0].Branch != retriedAPI.Branch ||
		integration.Merge[0].Commit != commit(3) {
		t.Fatalf("integration inputs pair a producer branch with a stale candidate: %#v", integration.Merge)
	}
}

func TestIntegrationConflictGoesToItsOwnerAndStaleInputsFailVisibly(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.twoProducerPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.handOff(api, commit(1), "api")
	harness.handOff(ui, commit(2), "ui")
	integration := harness.claimUnit("integrate")
	conflict, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{
		Merged: integration.Merge[:1], ConflictBranch: ui.Branch, ConflictFiles: []string{"export.go"}}})
	harness.report(integration, workerapi.AgentRunResult{Status: "failed", Error: "Candidates conflict.",
		TerminationReason: workerapi.TerminationMergeConflict, Result: string(conflict)})
	graph := harness.graph()
	findings := messagesOf(graph, messageFinding)
	if len(findings) != 1 || findings[0].To[0] != "ui" || findings[0].File != "export.go" || findings[0].Commit != commit(2) ||
		graph.unit("ui").State != unitQueued || graph.unit("integrate").State != unitWaiting || graph.Status != graphActive {
		t.Fatalf("after a merge conflict: findings %#v, units %#v", findings, graph.Units)
	}
	remediation := harness.claimUnit("ui")
	if remediation.ID != ui.ID || !strings.Contains(remediation.Prompt, "export.go") {
		t.Fatalf("conflict remediation = run %s, prompt %q", remediation.ID, remediation.Prompt)
	}
	harness.handOff(remediation, commit(3), "ui")

	// The next integration is a new run over the new candidates. A branch that moved away from its
	// admitted commit is refused, not merged.
	second := harness.claimUnit("integrate")
	if second.ID == integration.ID || second.Merge[1].Commit != commit(3) {
		t.Fatalf("second integration = run %s, inputs %v", second.ID, second.Merge)
	}
	stale, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{Stale: []string{api.Branch}}})
	harness.report(second, workerapi.AgentRunResult{Status: "failed", Error: "An input changed.",
		TerminationReason: workerapi.TerminationWorkerError, Result: string(stale)})
	graph = harness.graph()
	if unit := graph.unit("integrate"); unit.State != unitFailed || !strings.Contains(unit.Failure, api.Branch) || graph.Status != graphFailed {
		t.Fatalf("after a stale input: %s %#v", graph.Status, unit)
	}

	// An operator can retry the failed unit, which gets a fresh run.
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/units/integrate/retry", ""); response.Code != http.StatusOK {
		t.Fatalf("retry returned HTTP %d", response.Code)
	}
	if third := harness.claimUnit("integrate"); third.ID == second.ID {
		t.Fatal("retry reused the failed run")
	}
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/units/api/retry", ""); response.Code != http.StatusConflict {
		t.Fatalf("retrying a unit that did not fail returned HTTP %d", response.Code)
	}
}

func TestDecisionRequestBlocksItsUnitUntilAPersonResolvesIt(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.report(api, workerapi.AgentRunResult{Output: "Need a decision.",
		Result: `{"decision_request":{"question":"Comma or semicolon as the separator?","options":["comma","semicolon"]}}`})
	graph = harness.graph()
	requests := messagesOf(graph, messageDecisionRequest)
	if len(requests) != 1 || requests[0].From != "api" || requests[0].RunID != api.ID || graph.unit("api").State != unitBlocked ||
		graph.Status != graphActive {
		t.Fatalf("after a decision request: %s, requests %#v, api %#v", graph.Status, requests, graph.unit("api"))
	}
	// The other producer is unaffected; once it is done only the decision is left.
	harness.handOff(ui, commit(2), "ui")
	harness.nothingToClaim()
	if graph = harness.graph(); graph.Status != graphBlocked {
		t.Fatalf("graph status = %s, want blocked on the decision", graph.Status)
	}

	path := "/api/v1/work-graphs/" + graph.ID + "/decisions/" + requests[0].ID
	if response := harness.call(http.MethodPost, path, `{"resolution":" "}`); response.Code != http.StatusBadRequest {
		t.Fatalf("empty resolution returned HTTP %d", response.Code)
	}
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/decisions/unknown", `{"resolution":"comma"}`); response.Code != http.StatusNotFound {
		t.Fatalf("unknown decision returned HTTP %d", response.Code)
	}
	if response := harness.call(http.MethodPost, path, `{"resolution":"Use a comma."}`); response.Code != http.StatusOK {
		t.Fatalf("resolution returned HTTP %d: %s", response.Code, response.Body.String())
	}
	graph = harness.graph()
	if resolutions := messagesOf(graph, messageDecisionResolution); len(resolutions) != 1 || resolutions[0].By != localOperator ||
		resolutions[0].Resolves != requests[0].ID || graph.unit("api").State != unitQueued {
		t.Fatalf("after the resolution: %#v, api %#v", resolutions, graph.unit("api"))
	}
	if response := harness.call(http.MethodPost, path, `{"resolution":"Use a semicolon."}`); response.Code != http.StatusConflict {
		t.Fatalf("second resolution returned HTTP %d", response.Code)
	}
	// The unit resumes by itself with the decision in its context.
	resumed := harness.claimUnit("api")
	if resumed.ID != api.ID || resumed.Attempts != 2 || !strings.Contains(resumed.Prompt, "Use a comma.") ||
		!strings.Contains(resumed.Prompt, "Comma or semicolon") {
		t.Fatalf("resumed run = %s attempt %d, prompt %q", resumed.ID, resumed.Attempts, resumed.Prompt)
	}
	// The decision stays in the unit's context after it handed off: a later pass must not ask again.
	harness.handOff(resumed, commit(1), "api")
	if response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+api.ID+"/request-changes", `{"comment":"Add a header."}`); response.Code != http.StatusOK {
		t.Fatalf("request changes returned HTTP %d", response.Code)
	}
	if later := harness.claimUnit("api"); later.Attempts != 3 || !strings.Contains(later.Prompt, "Use a comma.") ||
		!strings.Contains(later.Prompt, "Add a header.") {
		t.Fatalf("pass after the handoff = attempt %d, prompt %q", later.Attempts, later.Prompt)
	}
}

func TestGraphChangesRollBackWhenPersistenceFails(t *testing.T) {
	for _, action := range []string{"retry", "resolve"} {
		t.Run(action, func(t *testing.T) {
			harness := newGraphHarness(t)
			graph := harness.start(harness.twoProducerPlan())
			harness.store.graphs.mu.Lock()
			stored := harness.store.graphs.graphs[graph.ID]
			if action == "retry" {
				stored.unit("api").Failure = "The run failed."
				stored.Status = graphFailed
			} else {
				stored.Messages = append(stored.Messages, graphMessage{ID: graph.ID[:8] + "-1",
					Type: messageDecisionRequest, From: "api"})
				stored.Status = graphBlocked
			}
			revision := stored.Revision
			harness.store.graphs.mu.Unlock()
			harness.store.graphs.path = filepath.Join(t.TempDir(), "missing", "work-graphs.json")

			path, body := "/api/v1/work-graphs/"+graph.ID+"/units/api/retry", ""
			if action == "resolve" {
				path, body = "/api/v1/work-graphs/"+graph.ID+"/decisions/"+graph.ID[:8]+"-1", `{"resolution":"Continue."}`
			}
			if response := harness.call(http.MethodPost, path, body); response.Code != http.StatusInternalServerError {
				t.Fatalf("%s with failed persistence returned HTTP %d", action, response.Code)
			}
			harness.store.graphs.mu.Lock()
			defer harness.store.graphs.mu.Unlock()
			stored = harness.store.graphs.graphs[graph.ID]
			if stored.Revision != revision || stored.Status == graphCompleted ||
				(action == "retry" && (stored.unit("api").Failure == "" || stored.unit("api").Restart)) ||
				(action == "resolve" && len(stored.Messages) != 1) {
				t.Fatalf("%s mutated graph after persistence failure: %#v", action, stored)
			}
		})
	}
}

func TestCancelGraphReportsRunCancellationPersistenceFailure(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	ui := harness.unit("ui").RunIDs[0]
	runPath := harness.store.path
	harness.store.path = filepath.Join(t.TempDir(), "missing", "agent-runs.json")
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusInternalServerError {
		t.Fatalf("cancel with failed run persistence returned HTTP %d", response.Code)
	}
	harness.store.mu.Lock()
	apiRun, uiRun := harness.store.items[api.ID], harness.store.items[ui]
	harness.store.mu.Unlock()
	harness.store.graphs.mu.Lock()
	stored := harness.store.graphs.graphs[graph.ID]
	harness.store.graphs.mu.Unlock()
	if apiRun.Status != "running" || apiRun.CancelRequested || uiRun.Status != "queued" || stored.Status != graphCancelled {
		t.Fatalf("cancel persistence failure changed runs %#v, %#v or lost intent %#v", apiRun, uiRun, stored)
	}
	claim := harness.call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	if claim.Code != http.StatusInternalServerError {
		t.Fatalf("claim while cancellation persistence is failing returned HTTP %d", claim.Code)
	}
	harness.store.path = runPath
	harness.restart()
	if !harness.store.graphs.reconcileAll() {
		t.Fatal("cancelled graph did not recover its run cancellations after restart")
	}
	harness.restart()
	if recovered := harness.graph(); recovered.Status != graphCancelled {
		t.Fatalf("restarted graph status = %s, want cancelled", recovered.Status)
	}
	for _, run := range harness.store.unitRuns(graph.ID) {
		if run.Status == "queued" || (run.Status == "running" && !run.CancelRequested) {
			t.Fatalf("restarted graph left a runnable run after cancellation recovery: %#v", run)
		}
	}
}

func TestCancelGraphIntentPersistenceFailureLeavesRunsUntouchedAfterRestart(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	graphPath := harness.store.graphs.path
	harness.store.graphs.path = filepath.Join(t.TempDir(), "missing", "work-graphs.json")
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusInternalServerError {
		t.Fatalf("cancel with failed graph-intent persistence returned HTTP %d", response.Code)
	}
	harness.store.graphs.path = graphPath
	harness.restart()
	if recovered := harness.graph(); recovered.Status != graphActive {
		t.Fatalf("graph after failed intent persistence = %s, want active", recovered.Status)
	}
	run, exists := harness.store.get(api.ID)
	if !exists || run.Status != "queued" || run.CancelRequested {
		t.Fatalf("failed intent persistence changed the run: %#v", run)
	}
}

func TestCancelledGraphIntentSurvivesProjectionPersistenceFailure(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusOK {
		t.Fatalf("cancel returned HTTP %d", response.Code)
	}
	graphPath := harness.store.graphs.path
	harness.store.graphs.path = filepath.Join(t.TempDir(), "missing", "work-graphs.json")
	harness.store.graphs.mu.Lock()
	harness.store.graphs.graphs[graph.ID].unit("api").State = unitQueued
	harness.store.graphs.mu.Unlock()
	if !harness.store.graphs.reconcileAll() {
		t.Fatal("run cancellation should remain persisted despite graph projection failure")
	}
	harness.store.graphs.path = graphPath
	harness.restart()
	if !harness.store.graphs.reconcileAll() {
		t.Fatal("cancelled graph did not reconcile after projection persistence recovered")
	}
	if recovered := harness.graph(); recovered.Status != graphCancelled {
		t.Fatalf("restarted graph status = %s, want cancelled", recovered.Status)
	}
	run, exists := harness.store.get(api.ID)
	if !exists || run.Status != "cancelled" || run.CancelRequested {
		t.Fatalf("run cancellation after projection failure = %#v", run)
	}
}

func TestRetryUnitRejectsAnExhaustedRunBudget(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	harness.store.graphs.mu.Lock()
	stored := harness.store.graphs.graphs[graph.ID]
	unit := stored.unit("api")
	unit.RunIDs = make([]string, maxUnitRuns)
	for index := range unit.RunIDs {
		unit.RunIDs[index] = strings.Repeat("a", 32)
	}
	unit.Failure, stored.Status = "The unit used all of its runs.", graphFailed
	revision := stored.Revision
	harness.store.graphs.mu.Unlock()

	path := "/api/v1/work-graphs/" + graph.ID + "/units/api/retry"
	response := harness.call(http.MethodPost, path, "")
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "used all") {
		t.Fatalf("retry of exhausted unit returned HTTP %d: %s", response.Code, response.Body.String())
	}
	harness.store.graphs.mu.Lock()
	defer harness.store.graphs.mu.Unlock()
	stored = harness.store.graphs.graphs[graph.ID]
	unit = stored.unit("api")
	if stored.Revision != revision || unit.Failure == "" || unit.Restart {
		t.Fatalf("rejected retry changed graph revision or failure state: %#v", unit)
	}
}

func TestCancellingAGraphStopsItsRunsAndFailedUnitsBlockTheirDependents(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusOK {
		t.Fatalf("cancel returned HTTP %d", response.Code)
	}
	running, _ := harness.store.get(api.ID)
	queued, _ := harness.store.get(harness.unit("ui").RunIDs[0])
	if graph = harness.graph(); graph.Status != graphCancelled || !running.CancelRequested || queued.Status != "cancelled" ||
		graph.unit("ui").State != unitCancelled {
		t.Fatalf("cancelled graph = %s, running %#v, queued %s", graph.Status, running.CancelRequested, queued.Status)
	}
	harness.nothingToClaim()

	// A producer whose run fails stops the graph, and the integrate unit that needs it reports why.
	harness.objectiveID = ""
	response := harness.call(http.MethodPost, "/api/v1/objectives", `{"title":"Second objective"}`)
	var created objective
	_ = json.NewDecoder(response.Body).Decode(&created)
	harness.objectiveID = created.ID
	harness.start(harness.twoProducerPlan())
	failing := harness.claimUnit("api")
	harness.report(failing, workerapi.AgentRunResult{Status: "failed", Error: "Verification failed.",
		TerminationReason: workerapi.TerminationVerification, Verification: workerapi.VerificationFailed})
	graph = harness.graph()
	if graph.Status != graphFailed || graph.unit("api").Failure != "Verification failed." || graph.unit("integrate").State != unitBlocked {
		t.Fatalf("after a failed producer: %s %#v", graph.Status, graph.Units)
	}
}

func TestOnlyAnAuthorizedPersonCanResolveADecision(t *testing.T) {
	harness := newAccessHarness(t)
	if harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA)) != http.StatusOK {
		t.Fatal("heartbeat failed")
	}
	response := harness.user("alice", http.MethodPost, "/api/v1/objectives", `{"title":"Export"}`)
	var created objective
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create objective: HTTP %d, %v", response.Code, err)
	}
	plan := `{"project_id":"` + projectA + `","plan":{"summary":"","max_parallel":1,"units":[` +
		unitJSON("api", unitProduce, harness.profile.ID) + `,` + unitJSON("integrate", unitIntegrate, "", "api") + `]}}`
	plans := "/api/v1/objectives/" + created.ID + "/plans"
	if response := harness.user("bob", http.MethodPost, plans, plan); response.Code != http.StatusNotFound {
		t.Fatalf("planning another user's objective returned HTTP %d", response.Code)
	}
	if response := harness.user("alice", http.MethodPost, plans, plan); response.Code != http.StatusCreated {
		t.Fatalf("propose returned HTTP %d: %s", response.Code, response.Body.String())
	}
	var graph workGraph
	response = harness.user("alice", http.MethodPost, plans+"/1/approve", "")
	if err := json.NewDecoder(response.Body).Decode(&graph); err != nil || response.Code != http.StatusCreated || graph.CreatedBy != "alice" {
		t.Fatalf("approve: HTTP %d, %v, %#v", response.Code, err, graph)
	}
	claim := harness.worker(http.MethodPost, "/api/v1/workers/"+aliceWorkerID+"/agent-runs/claim", aliceToken, "")
	var command workerapi.AgentRunCommand
	if err := json.NewDecoder(claim.Body).Decode(&command); err != nil || claim.Code != http.StatusOK {
		t.Fatalf("claim: HTTP %d, %v", claim.Code, err)
	}
	result := `{"status":"succeeded","attempts":1,"output":"x","result":"{\"decision_request\":{\"question\":\"Which format?\"}}"}`
	if response := harness.worker(http.MethodPut, "/api/v1/workers/"+aliceWorkerID+"/agent-runs/"+command.ID, aliceToken, result); response.Code != http.StatusOK {
		t.Fatalf("finish returned HTTP %d", response.Code)
	}
	graphs := decodeList[workGraph](t, harness.user("alice", http.MethodGet, "/api/v1/work-graphs", ""))
	requests := messagesOf(graphs[0], messageDecisionRequest)
	if len(requests) != 1 {
		t.Fatalf("decision requests = %#v", requests)
	}
	path := "/api/v1/work-graphs/" + graph.ID + "/decisions/" + requests[0].ID
	// A worker credential, which is all an agent's machine holds, cannot answer the agent's own question.
	if response := harness.worker(http.MethodPost, path, aliceToken, `{"resolution":"CSV"}`); response.Code != http.StatusUnauthorized {
		t.Fatalf("worker credential on the decision route returned HTTP %d", response.Code)
	}
	if visible := decodeList[workGraph](t, harness.user("bob", http.MethodGet, "/api/v1/work-graphs", "")); len(visible) != 0 {
		t.Fatalf("another user sees the graph: %#v", visible)
	}
	if response := harness.user("bob", http.MethodPost, path, `{"resolution":"CSV"}`); response.Code != http.StatusNotFound {
		t.Fatalf("resolution by a user without access returned HTTP %d", response.Code)
	}
	response = harness.user("alice", http.MethodPost, path, `{"resolution":"CSV"}`)
	if err := json.NewDecoder(response.Body).Decode(&graph); err != nil || response.Code != http.StatusOK {
		t.Fatalf("resolution by the owner: HTTP %d, %v", response.Code, err)
	}
	if resolutions := messagesOf(graph, messageDecisionResolution); len(resolutions) != 1 || resolutions[0].By != "alice" {
		t.Fatalf("resolution provenance = %#v", resolutions)
	}
}
