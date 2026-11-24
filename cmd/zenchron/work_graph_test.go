package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// graphHarness drives objective orchestration through the real control-plane API, playing the worker.
type graphHarness struct {
	*deliveryHarness
	objectiveID string
	second      agentProfile
	reviewer    agentProfile
}

func newGraphHarness(t *testing.T) *graphHarness {
	t.Helper()
	harness := &graphHarness{deliveryHarness: newDeliveryHarness(t, workerapi.ProviderCodex)}
	harness.pullHead = commit(4)
	harness.store.graphs.path = filepath.Join(filepath.Dir(harness.path), "work-graphs.json")
	now := time.Now().UTC()
	harness.second = agentProfile{ID: strings.Repeat("b", 32), Name: "Second engineer", Provider: workerapi.ProviderCodex,
		Model: "default", Status: "active", Version: 1, UpdatedAt: now, Tools: []string{"code.write", "tests.run"}}
	harness.reviewer = agentProfile{ID: strings.Repeat("c", 32), Name: "Reviewer", Provider: workerapi.ProviderCodex,
		Model: "default", Status: "active", Version: 1, UpdatedAt: now, Tools: []string{"git.diff"}}
	harness.store.agents.items[harness.second.ID] = harness.second
	harness.store.agents.items[harness.reviewer.ID] = harness.reviewer
	response := harness.call(http.MethodPost, "/api/v1/objectives", `{"title":"Ship usage export","description":"Export usage as CSV."}`)
	var created objective
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create objective: HTTP %d, %v", response.Code, err)
	}
	harness.objectiveID = created.ID
	return harness
}

// commit returns a distinct, well-formed commit id.
func commit(digit int) string { return strings.Repeat(fmt.Sprint(digit), 40) }

func unitJSON(key, kind, agentID string, dependsOn ...string) string {
	dependencies, _ := json.Marshal(append([]string{}, dependsOn...))
	return fmt.Sprintf(`{"key":%q,"kind":%q,"title":"Work on %s","instructions":"Do the %s part.","acceptance":["%s works"],`+
		`"depends_on":%s,"capabilities":[],"agent_id":%q}`, key, kind, key, key, key, dependencies, agentID)
}

func (harness *graphHarness) planBody(units ...string) string {
	return `{"project_id":"` + testProjectID + `","plan":{"summary":"Deliver the export","max_parallel":2,"units":[` +
		strings.Join(units, ",") + `]}}`
}

// reviewedPlan has two independent producers, a review of one of them, integration, and a review of
// the integrated candidate.
func (harness *graphHarness) reviewedPlan() string {
	return harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID), unitJSON("ui", unitProduce, harness.second.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api", "ui"),
		unitJSON("review-all", unitReview, harness.reviewer.ID, "integrate"))
}

func (harness *graphHarness) propose(body string) (objectivePlan, *http.Response) {
	harness.t.Helper()
	response := harness.call(http.MethodPost, "/api/v1/objectives/"+harness.objectiveID+"/plans", body)
	var plan objectivePlan
	result := response.Result()
	if result.StatusCode < http.StatusBadRequest {
		if err := json.NewDecoder(response.Body).Decode(&plan); err != nil {
			harness.t.Fatalf("decode plan: %v", err)
		}
	}
	return plan, result
}

func (harness *graphHarness) approve(revision int) (workGraph, int) {
	response := harness.call(http.MethodPost, fmt.Sprintf("/api/v1/objectives/%s/plans/%d/approve", harness.objectiveID, revision), "")
	var graph workGraph
	_ = json.NewDecoder(response.Body).Decode(&graph)
	return graph, response.Code
}

// start proposes and approves a plan and returns its graph.
func (harness *graphHarness) start(body string) workGraph {
	harness.t.Helper()
	plan, response := harness.propose(body)
	if response.StatusCode != http.StatusCreated {
		harness.t.Fatalf("propose plan returned HTTP %d", response.StatusCode)
	}
	graph, status := harness.approve(plan.Revision)
	if status != http.StatusCreated {
		harness.t.Fatalf("approve plan returned HTTP %d", status)
	}
	return graph
}

func (harness *graphHarness) graph() workGraph {
	harness.t.Helper()
	graphs := decodeList[workGraph](harness.t, harness.call(http.MethodGet, "/api/v1/work-graphs", ""))
	if len(graphs) == 0 {
		harness.t.Fatal("no work graph is listed")
	}
	return graphs[0]
}

func (harness *graphHarness) unit(key string) workUnit {
	harness.t.Helper()
	graph := harness.graph()
	return *graph.unit(key)
}

// claimUnit claims the next run and requires it to execute the named unit.
func (harness *graphHarness) claimUnit(key string) workerapi.AgentRunCommand {
	harness.t.Helper()
	command := harness.claim()
	if run, _ := harness.store.get(command.ID); run.UnitKey != key {
		harness.t.Fatalf("claimed a run for unit %q, want %q", run.UnitKey, key)
	}
	return command
}

func (harness *graphHarness) nothingToClaim() {
	harness.t.Helper()
	if response := harness.call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", ""); response.Code != http.StatusNoContent {
		harness.t.Fatalf("claim returned HTTP %d, want nothing queued", response.Code)
	}
}

func (harness *graphHarness) authorizePublication(runID, candidate string) agentRun {
	harness.t.Helper()
	response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+runID+"/publish",
		fmt.Sprintf(`{"candidate_sha":%q}`, candidate))
	var run agentRun
	if response.Code != http.StatusAccepted || json.NewDecoder(response.Body).Decode(&run) != nil ||
		!run.publicationAuthorized(candidate) {
		harness.t.Fatalf("authorize publication returned HTTP %d: %s", response.Code, response.Body.String())
	}
	return run
}

// report finishes a claimed attempt as the worker would.
func (harness *graphHarness) report(command workerapi.AgentRunCommand, result workerapi.AgentRunResult) {
	harness.t.Helper()
	result.Attempts = command.Attempts
	if result.Status == "" {
		result.Status, result.TerminationReason = "succeeded", workerapi.TerminationCompleted
	}
	body, err := json.Marshal(result)
	if err != nil {
		harness.t.Fatal(err)
	}
	if _, status := harness.finish(command.ID, string(body)); status != http.StatusOK {
		harness.t.Fatalf("finish returned HTTP %d", status)
	}
}

// handOff finishes a producer's attempt with a commit and a typed handoff.
func (harness *graphHarness) handOff(command workerapi.AgentRunCommand, commitSHA, summary string) {
	harness.t.Helper()
	diff := "diff --git a/" + summary + ".go b/" + summary + ".go\n+++ b/" + summary + ".go\n+change\n"
	harness.report(command, workerapi.AgentRunResult{CommitSHA: commitSHA, BaseCommit: commit(9), Diff: &diff,
		Output: "Done.", Verification: workerapi.VerificationPassed, Result: `{"handoff":{"summary":"` + summary + `","notes":["note for ` + summary + `"]}}`})
}

// verdict finishes a review attempt that ran on the commit named reviewed.
func (harness *graphHarness) verdict(command workerapi.AgentRunCommand, reviewed, result string) {
	harness.t.Helper()
	harness.report(command, workerapi.AgentRunResult{BaseCommit: reviewed, Output: "Reviewed.", Result: result})
}

func messagesOf(graph workGraph, messageType string) []graphMessage {
	var messages []graphMessage
	for _, message := range graph.Messages {
		if message.Type == messageType {
			messages = append(messages, message)
		}
	}
	return messages
}

const blockAPI = `{"review":{"verdict":"block","findings":[{"title":"Header row is missing","detail":"The CSV starts with data.","file":"api.go","line":12,"severity":"high"}]}}`

func TestObjectiveRunsParallelProducersThroughReviewRemediationIntegrationAndOnePullRequest(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.reviewedPlan())
	if graph.Status != graphActive || graph.unit("api").State != unitQueued || graph.unit("ui").State != unitQueued ||
		graph.unit("integrate").State != unitWaiting {
		t.Fatalf("graph after approval = %s %#v", graph.Status, graph.Units)
	}

	// Both independent producers hold a lease at the same time.
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	if harness.unit("api").State != unitRunning || harness.unit("ui").State != unitRunning || api.Branch == ui.Branch {
		t.Fatalf("producers are not running side by side on separate branches")
	}
	if !strings.Contains(api.Prompt, "Ship usage export") || !strings.Contains(api.Prompt, workerapi.ResultFence) ||
		api.PublishPullRequest || ui.PublishPullRequest {
		t.Fatalf("producer command lacks the objective or the result contract, or would publish on its own: %q", api.Prompt)
	}
	harness.handOff(api, commit(1), "api")
	harness.handOff(ui, commit(2), "ui")

	// The review runs on the producer's exact candidate and blocks it; the finding reaches the producer.
	review := harness.claimUnit("review-api")
	if review.BaseBranch != api.Branch || !strings.Contains(review.Prompt, commit(1)) || !strings.Contains(review.Prompt, "+++ b/api.go") ||
		!strings.Contains(review.Prompt, "note for api") {
		t.Fatalf("review command = base %q, prompt %q", review.BaseBranch, review.Prompt)
	}
	harness.verdict(review, commit(1), blockAPI)
	graph = harness.graph()
	if findings := messagesOf(graph, messageFinding); len(findings) != 1 || findings[0].To[0] != "api" || findings[0].Commit != commit(1) ||
		findings[0].RunID != review.ID || graph.unit("api").State != unitQueued || graph.unit("review-api").State != unitWaiting {
		t.Fatalf("after a blocking review: findings %#v, units %#v", findings, graph.Units)
	}

	// Remediation is another attempt of the same run, with the finding rebuilt into its context.
	remediation := harness.claimUnit("api")
	if remediation.ID != api.ID || remediation.Attempts != 2 || !strings.Contains(remediation.Prompt, "Header row is missing") {
		t.Fatalf("remediation = run %s attempt %d, prompt %q", remediation.ID, remediation.Attempts, remediation.Prompt)
	}
	harness.handOff(remediation, commit(3), "api")

	// A verdict on the old candidate cannot approve the new one: it is discarded and a fresh review runs.
	stale := harness.claimUnit("review-api")
	harness.verdict(stale, commit(1), `{"review":{"verdict":"accept"}}`)
	if unit := harness.unit("review-api"); unit.Verdict != "" || unit.State != unitQueued {
		t.Fatalf("a stale accept changed the review unit: %#v", unit)
	}
	fresh := harness.claimUnit("review-api")
	if fresh.ID == review.ID || fresh.ID == stale.ID {
		t.Fatal("the fresh review reused an earlier review run")
	}
	harness.verdict(fresh, commit(3), `{"review":{"verdict":"accept"}}`)

	// Integration combines the exact admitted candidates and is not published before its own review.
	integration := harness.claimUnit("integrate")
	want := []workerapi.MergeInput{{Branch: api.Branch, Commit: commit(3)}, {Branch: ui.Branch, Commit: commit(2)}}
	if fmt.Sprint(integration.Merge) != fmt.Sprint(want) || integration.PublishPullRequest {
		t.Fatalf("integration command = merge %v publish %v", integration.Merge, integration.PublishPullRequest)
	}
	merged, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{Merged: want}})
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		Verification: workerapi.VerificationPassed, Result: string(merged)})
	if unit := harness.unit("integrate"); unit.Candidate != commit(4) || unit.State != unitWaiting || harness.pullCreates != 0 {
		t.Fatalf("integrated candidate before review: %#v, pull requests %d", unit, harness.pullCreates)
	}
	final := harness.claimUnit("review-all")
	if final.BaseBranch != integration.Branch {
		t.Fatalf("final review base = %q, want the integration branch", final.BaseBranch)
	}
	harness.verdict(final, commit(4), `{"review":{"verdict":"accept"}}`)

	if unit := harness.unit("integrate"); !unit.PublicationAuthorizationRequired || harness.pullCreates != 0 {
		t.Fatalf("reviewed candidate was published without human authorization: %#v, PR creates %d", unit, harness.pullCreates)
	}
	actions := harness.actionRequired()
	if len(actions) != 1 || actions[0].Kind != actionPublication || !actions[0].CanAct ||
		actions[0].RunID != integration.ID || actions[0].Subject != commit(4) {
		t.Fatalf("reviewed candidate action = %#v", actions)
	}
	harness.authorizePublication(integration.ID, commit(4))
	// The authorized second pass may push only the exact reviewed commit.
	publication := harness.claimUnit("integrate")
	if publication.ID != integration.ID || !publication.PublishPullRequest || publication.PublishCommit != commit(4) {
		t.Fatalf("publication = run %s publish %v", publication.ID, publication.PublishPullRequest)
	}
	harness.pullHead = commit(4)
	harness.report(publication, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		Verification: workerapi.VerificationPassed, BranchPushed: true, Result: string(merged)})
	graph = harness.graph()
	if graph.Status != graphCompleted || graph.unit("integrate").PullRequestURL != "https://github.com/acme/platform/pull/23" ||
		harness.pullCreates != 1 {
		t.Fatalf("finished graph = %s, integrate %#v, pull requests %d", graph.Status, graph.unit("integrate"), harness.pullCreates)
	}
	if !strings.Contains(harness.lastPullBody, "Ship usage export") || !strings.Contains(harness.lastPullBody, graph.ID) ||
		!strings.Contains(harness.lastPullBody, "review-all") {
		t.Fatalf("pull request does not describe the objective and its units: %q", harness.lastPullBody)
	}
	if handoffs := messagesOf(graph, messageHandoff); len(handoffs) != 4 || handoffs[2].Commit != commit(3) || handoffs[3].Commit != commit(4) {
		t.Fatalf("handoffs = %#v", handoffs)
	}
	if runs := graph.unit("api").RunIDs; len(runs) != 1 || len(graph.unit("review-api").RunIDs) != 3 {
		t.Fatalf("api runs %v, review runs %v", runs, graph.unit("review-api").RunIDs)
	}
	harness.nothingToClaim()
}

func TestReviewedCandidateWaitsForExactHumanPublicationAuthorization(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api"),
		unitJSON("review-all", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	harness.verdict(harness.claimUnit("review-api"), commit(1), `{"review":{"verdict":"accept"}}`)
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)
	graph = harness.graph()
	if !graph.unit("integrate").PublicationAuthorizationRequired || harness.pullCreates != 0 {
		t.Fatalf("reviewed candidate did not wait for a person: graph %#v, PR creates %d", graph, harness.pullCreates)
	}
	actions := harness.actionRequired()
	if len(actions) != 1 || actions[0].Kind != actionPublication || !actions[0].CanAct || actions[0].GraphID != graph.ID ||
		actions[0].RunID != integration.ID || actions[0].Subject != commit(4) {
		t.Fatalf("pending publication action = %#v", actions)
	}
	if response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
		`{"candidate_sha":"`+commit(3)+`"}`); response.Code != http.StatusConflict {
		t.Fatalf("stale candidate authorization returned HTTP %d", response.Code)
	}
	request := withRequestAccess(jsonRequest(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
		strings.NewReader(`{"candidate_sha":"`+commit(4)+`"}`)), requestAccess{enforced: true, user: "outsider"})
	request.SetPathValue("id", integration.ID)
	response := httptest.NewRecorder()
	harness.store.publish(response, request)
	run, _ := harness.store.get(integration.ID)
	if response.Code != http.StatusForbidden || len(run.PublicationAuthorizations) != 0 {
		t.Fatalf("unauthorized publication returned HTTP %d and authority %#v", response.Code,
			run.PublicationAuthorizations)
	}
	harness.restart()
	if actions = harness.actionRequired(); len(actions) != 1 || actions[0].Subject != commit(4) {
		t.Fatalf("publication action after restart = %#v", actions)
	}
	const duplicateAuthorizations = 16
	start := make(chan struct{})
	var requests sync.WaitGroup
	for range duplicateAuthorizations {
		requests.Add(1)
		go func() {
			defer requests.Done()
			<-start
			harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
				`{"candidate_sha":"`+commit(4)+`"}`)
		}()
	}
	close(start)
	requests.Wait()
	authorized, _ := harness.store.get(integration.ID)
	if len(authorized.PublicationAuthorizations) != 1 || authorized.PublicationAuthorizations[0].By != localOperator ||
		authorized.PublicationAuthorizations[0].CommitSHA != commit(4) ||
		authorized.PublicationAuthorizations[0].GraphID != graph.ID ||
		authorized.PublicationAuthorizations[0].GraphRevision != graph.Revision ||
		authorized.PublicationAuthorizations[0].PlanRevision != graph.PlanRevision ||
		authorized.PublicationAuthorizations[0].PlanHash != graph.PlanHash {
		t.Fatalf("publication authority record = %#v", authorized.PublicationAuthorizations)
	}
	command := harness.claimUnit("integrate")
	if !command.PublishPullRequest || command.PublishCommit != commit(4) {
		t.Fatalf("authorized publication command = %#v", command)
	}
	harness.pullHead = commit(4)
	harness.report(command, workerapi.AgentRunResult{CommitSHA: commit(4), BranchPushed: true, Result: `{"integration":{}}`})
	if graph = harness.graph(); graph.Status != graphCompleted || graph.unit("integrate").PullRequestURL == "" || harness.pullCreates != 1 {
		t.Fatalf("authorized delivery = graph %s, unit %#v, PR creates %d", graph.Status, graph.unit("integrate"), harness.pullCreates)
	}
	report, _ := harness.deliveryReport(graph.ID)
	if report.PublicationAuthority == nil || report.PublicationAuthority.By != localOperator ||
		report.PublicationAuthority.PlanHash != graph.PlanHash || report.PublicationAuthority.PlanRevision != graph.PlanRevision ||
		slices.Contains(report.UnknownEvidence, "publication_authority") {
		t.Fatalf("publication authority report = %#v, unknown=%v", report.PublicationAuthority, report.UnknownEvidence)
	}
}

func TestWorkGraphDefersHandoffAndQueueDuringManagedQuiesce(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.reviewedPlan())
	producer, secondProducer := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.store.mu.Lock()
	harness.store.quiesced = true
	harness.store.mu.Unlock()
	harness.handOff(producer, commit(1), "api")
	harness.handOff(secondProducer, commit(2), "ui")
	graph = harness.graph()
	if graph.unit("review-api").Failure != "" || graph.unit("review-api").State == unitFailed {
		t.Fatalf("quiesce turned a runnable review into a failed unit: %#v", graph.unit("review-api"))
	}
	if response := harness.call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", ""); response.Code != http.StatusNoContent {
		t.Fatalf("quiesced claim returned HTTP %d, want no queued run", response.Code)
	}
	harness.store.mu.Lock()
	harness.store.quiesced = false
	harness.store.mu.Unlock()
	harness.claimUnit("review-api")
}

func TestWorkGraphAdmissionPauseRaceDoesNotFailUnit(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.reviewedPlan())
	harness.store.mu.Lock()
	harness.store.quiesced = true
	harness.store.mu.Unlock()
	unit := graph.unit("api")
	harness.store.graphs.perform(&graph, unitAction{key: unit.Key, kind: actionStart}, map[string]agentRun{})
	if unit.Failure != "" {
		t.Fatalf("temporary admission pause failed the unit: %q", unit.Failure)
	}
}

func TestProducerIsNotCompleteWithoutAnAdmittedHandoff(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID), unitJSON("integrate", unitIntegrate, "", "api")))
	first := harness.claimUnit("api")
	// The provider exited successfully and committed, but reported no typed result.
	diff := "diff"
	harness.report(first, workerapi.AgentRunResult{CommitSHA: commit(1), BaseCommit: commit(9), Diff: &diff, Output: "All done!"})
	if unit := harness.unit("api"); unit.State != unitQueued || unit.Candidate != "" || unit.HandoffAt != 0 {
		t.Fatalf("unit advanced without a handoff: %#v", unit)
	}
	second := harness.claimUnit("api")
	if second.Attempts != 2 || !strings.Contains(second.Prompt, "without an admissible result") {
		t.Fatalf("second pass = attempt %d, prompt %q", second.Attempts, second.Prompt)
	}
	harness.report(second, workerapi.AgentRunResult{CommitSHA: commit(1), BaseCommit: commit(9), Output: "x", Result: `{"handoff":{"summary":"api","extra":true}}`})
	third := harness.claimUnit("api")
	harness.report(third, workerapi.AgentRunResult{CommitSHA: commit(1), BaseCommit: commit(9), Output: "x"})
	graph := harness.graph()
	if unit := graph.unit("api"); unit.State != unitFailed || graph.Status != graphFailed || graph.unit("integrate").State != unitBlocked {
		t.Fatalf("after the attempt limit: %s %#v", graph.Status, graph.Units)
	}
}
