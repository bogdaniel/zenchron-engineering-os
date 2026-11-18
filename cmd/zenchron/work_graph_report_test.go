package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// decodeReport requires a 200 report and returns it with its raw JSON, which shows what was omitted.
func decodeReport(t *testing.T, response *httptest.ResponseRecorder) (deliveryReport, string) {
	t.Helper()
	body := response.Body.String()
	var report deliveryReport
	if err := json.Unmarshal([]byte(body), &report); err != nil || response.Code != http.StatusOK {
		t.Fatalf("report returned HTTP %d, %v: %s", response.Code, err, body)
	}
	return report, body
}

func (harness *graphHarness) deliveryReport(graphID string) (deliveryReport, string) {
	harness.t.Helper()
	return decodeReport(harness.t, harness.call(http.MethodGet, "/api/v1/work-graphs/"+graphID+"/report", ""))
}

func reportedUnit(t *testing.T, report deliveryReport, key string) reportUnit {
	t.Helper()
	index := slices.IndexFunc(report.Units, func(unit reportUnit) bool { return unit.Key == key })
	if index < 0 {
		t.Fatalf("report has no unit %q", key)
	}
	return report.Units[index]
}

func TestWorkGraphReportMeasuresACompletedRun(t *testing.T) {
	harness := newGraphHarness(t)
	started := harness.start(harness.reviewedPlan())

	// Both producers hold a lease before either finishes, so two attempts overlap.
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.handOff(api, commit(1), "api")
	cost, diff := 0.5, "diff --git a/ui.go b/ui.go\n+++ b/ui.go\n+change\n"
	harness.report(ui, workerapi.AgentRunResult{CommitSHA: commit(2), BaseCommit: commit(9), Diff: &diff, Output: "Done.",
		Verification: workerapi.VerificationPassed, ProviderVersion: "1.2.3", Result: `{"handoff":{"summary":"ui"}}`,
		Usage: &workerapi.Usage{InputTokens: 100, OutputTokens: 20, CostUSD: &cost}})

	// One blocking review, one remediation pass of the producer, then an accepting review.
	harness.verdict(harness.claimUnit("review-api"), commit(1), blockAPI)
	harness.handOff(harness.claimUnit("api"), commit(3), "api")
	harness.report(harness.claimUnit("review-api"), workerapi.AgentRunResult{BaseCommit: commit(3), Output: "Reviewed.",
		Result: `{"review":{"verdict":"accept"}}`, Usage: &workerapi.Usage{InputTokens: 50, OutputTokens: 5}})

	integration := harness.claimUnit("integrate")
	merged, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{Merged: integration.Merge}})
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Output: "Merged.",
		Verification: workerapi.VerificationPassed, Result: string(merged)})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)
	harness.report(harness.claimUnit("integrate"), workerapi.AgentRunResult{CommitSHA: commit(4), CommitTreeSHA: commit(5), BaseCommit: commit(9),
		Output: "Merged.", Verification: workerapi.VerificationPassed, BranchPushed: true, Result: string(merged)})
	harness.pullHead = commit(4)

	before := harness.graph()
	report, body := harness.deliveryReport(started.ID)
	if report.GraphID != started.ID || report.ObjectiveID != harness.objectiveID || report.ObjectiveTitle != "Ship usage export" ||
		report.PlanRevision != 1 || report.Status != graphCompleted || before.Status != graphCompleted ||
		report.PullRequestURL != "https://github.com/acme/platform/pull/23" || report.ApprovedPlan.Revision != 1 ||
		report.ApprovedPlan.Status != planApproved || report.ApprovedPlan.ApprovedBy == "" {
		t.Fatalf("report identity = %s", body)
	}
	measured := report.Measurements
	counts := []int{measured.UnitCount, measured.RunCount, measured.AttemptCount, measured.FailedAttempts, measured.ReviewRounds,
		measured.Findings, measured.RemediationPasses, measured.DecisionsRequested, measured.DecisionsResolved,
		measured.HumanActions, measured.MaxConcurrency}
	// 5 units; 6 runs (the blocked review is followed by a second review run); 8 attempts (api 2, integrate 2).
	if want := []int{5, 6, 8, 0, 3, 1, 1, 0, 0, 1, 2}; !slices.Equal(counts, want) {
		t.Fatalf("measurements = %v, want %v: %s", counts, want, body)
	}
	if measured.WallClockSeconds == nil || *measured.WallClockSeconds <= 0 ||
		*measured.WallClockSeconds != before.UpdatedAt.Sub(before.CreatedAt).Seconds() {
		t.Fatalf("wall_clock_seconds = %v for a graph created %s and updated %s", measured.WallClockSeconds, before.CreatedAt, before.UpdatedAt)
	}
	if measured.InputTokens == nil || *measured.InputTokens != 150 || measured.OutputTokens == nil || *measured.OutputTokens != 25 ||
		measured.CostUSD == nil || *measured.CostUSD != 0.5 || measured.HumanActionsComplete ||
		!slices.Equal(measured.Unknown, []string{"cost_usd_for_some_runs", "input_tokens_for_some_runs",
			"output_tokens_for_some_runs", supervisionMinutes, "unrecorded_human_actions"}) {
		t.Fatalf("usage and unknown measurements = %s", body)
	}
	apiUnit, uiUnit, review := reportedUnit(t, report, "api"), reportedUnit(t, report, "ui"), reportedUnit(t, report, "review-api")
	if apiUnit.Kind != unitProduce || apiUnit.AgentName != harness.profile.Name || apiUnit.State != unitCompleted ||
		apiUnit.Candidate != commit(3) || apiUnit.Attempts != 2 || !slices.Equal(apiUnit.RunIDs, []string{api.ID}) ||
		!slices.Equal(apiUnit.Providers, []string{workerapi.ProviderCodex}) {
		t.Fatalf("api unit = %#v", apiUnit)
	}
	if len(apiUnit.Executions) != 1 || apiUnit.Executions[0].ProfileID != harness.profile.ID ||
		apiUnit.Executions[0].ProfileVersion != harness.profile.Version || apiUnit.Executions[0].CandidateCommit != commit(3) ||
		len(report.Handoffs) == 0 || len(report.Outstanding) != 0 {
		t.Fatalf("execution provenance, handoffs, or outstanding steps = report unit %#v, handoffs %#v, outstanding %#v",
			apiUnit, report.Handoffs, report.Outstanding)
	}
	if !slices.Equal(uiUnit.Providers, []string{workerapi.ProviderCodex + " 1.2.3"}) || review.Verdict != "accept" ||
		len(uiUnit.Executions) != 1 || uiUnit.Executions[0].Verification != workerapi.VerificationPassed ||
		len(review.RunIDs) != 2 || review.Attempts != 2 || !slices.Equal(review.Providers, []string{workerapi.ProviderCodex}) {
		t.Fatalf("ui unit = %#v, review unit = %#v", uiUnit, review)
	}
	if !slices.Equal(report.UnknownEvidence, []string{"publication_authority"}) {
		t.Fatalf("unrecorded evidence = %v", report.UnknownEvidence)
	}
	if report.PullRequest == nil || report.PullRequest.State != "open" || !report.PullRequest.Draft || report.PullRequest.Merged ||
		report.PullRequest.HeadSHA != commit(4) || report.PullRequest.CandidateMatchesHead == nil || !*report.PullRequest.CandidateMatchesHead ||
		report.PullRequest.ObservedAt.IsZero() || slices.Contains(report.UnknownEvidence, "pull_request_external_state") {
		t.Fatalf("external pull request state = %#v; unknown evidence = %v", report.PullRequest, report.UnknownEvidence)
	}
	if integration := reportedUnit(t, report, "integrate"); len(integration.Executions) != 1 ||
		integration.Executions[0].CandidateTree != commit(5) {
		t.Fatalf("integration tree provenance = %#v", integration.Executions)
	}
	original := report
	harness.restart()
	replayed, _ := harness.deliveryReport(started.ID)
	// GitHub observation time changes per read; durable report evidence should not.
	if original.PullRequest != nil {
		observed := *original.PullRequest
		observed.ObservedAt = time.Time{}
		original.PullRequest = &observed
	}
	if replayed.PullRequest != nil {
		observed := *replayed.PullRequest
		observed.ObservedAt = time.Time{}
		replayed.PullRequest = &observed
	}
	if !reflect.DeepEqual(replayed, original) {
		t.Fatalf("report after restart = %#v, before restart %#v", replayed, original)
	}

	// Reading the report changed nothing about the graph.
	if after := harness.graph(); after.Revision != before.Revision || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("graph moved from revision %d at %s to revision %d at %s", before.Revision, before.UpdatedAt, after.Revision, after.UpdatedAt)
	}
	harness.store.graphs.mu.Lock()
	graph := harness.store.graphs.graphs[started.ID]
	for index := range graph.Units {
		if graph.Units[index].Kind == unitIntegrate {
			graph.Units[index].Candidate = commit(6)
		}
	}
	harness.store.graphs.mu.Unlock()
	stale, _ := harness.deliveryReport(started.ID)
	if !slices.Contains(stale.UnknownEvidence, "candidate_tree_sha") {
		t.Fatalf("tree for another candidate was accepted: %v", stale.UnknownEvidence)
	}
	harness.pullHead = commit(7)
	changed, _ := harness.deliveryReport(started.ID)
	if changed.PullRequest == nil || changed.PullRequest.CandidateMatchesHead == nil || *changed.PullRequest.CandidateMatchesHead {
		t.Fatalf("changed external PR head was not distinguished from the candidate: %#v", changed.PullRequest)
	}
	harness.failPullStatus = true
	unavailable, _ := harness.deliveryReport(started.ID)
	if unavailable.PullRequest != nil || !slices.Contains(unavailable.UnknownEvidence, "pull_request_external_state") {
		t.Fatalf("unavailable GitHub state was presented as observed: %#v, unknown=%v", unavailable.PullRequest, unavailable.UnknownEvidence)
	}
}

func TestWorkGraphReportOmitsWhatWasNotRecorded(t *testing.T) {
	harness := newGraphHarness(t)
	started := harness.start(harness.twoProducerPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")

	// One producer asks a person and is answered; the other fails its attempt. Nobody reports usage.
	harness.report(api, workerapi.AgentRunResult{Output: "x", Result: `{"decision_request":{"question":"Which format?"}}`})
	request := messagesOf(harness.graph(), messageDecisionRequest)
	if len(request) != 1 {
		t.Fatalf("decision requests = %#v", request)
	}
	decision := fmt.Sprintf("/api/v1/work-graphs/%s/decisions/%s", started.ID, request[0].ID)
	if response := harness.call(http.MethodPost, decision, `{"resolution":"CSV"}`); response.Code != http.StatusOK {
		t.Fatalf("resolve decision returned HTTP %d: %s", response.Code, response.Body.String())
	}
	harness.report(ui, workerapi.AgentRunResult{Status: "failed", Error: "provider crashed"})

	before := harness.graph()
	report, body := harness.deliveryReport(started.ID)
	if report.Status != before.Status || report.Status == graphCompleted || report.PullRequestURL != "" {
		t.Fatalf("report of an unfinished graph = %s", body)
	}
	for _, omitted := range []string{"wall_clock_seconds", "input_tokens", "output_tokens", "cost_usd", "pull_request_url",
		supervisionMinutes, "candidate", "verdict"} {
		if strings.Contains(body, `"`+omitted+`":`) {
			t.Fatalf("report carries %s, which nothing recorded: %s", omitted, body)
		}
	}
	measured := report.Measurements
	unknown := []string{"cost_usd", "input_tokens", "output_tokens", supervisionMinutes, "wall_clock_seconds"}
	unknown = append(unknown, "unrecorded_human_actions")
	slices.Sort(unknown)
	if !slices.Equal(measured.Unknown, unknown) {
		t.Fatalf("unknown = %v, want %v", measured.Unknown, unknown)
	}
	counts := []int{measured.UnitCount, measured.RunCount, measured.AttemptCount, measured.FailedAttempts, measured.ReviewRounds,
		measured.Findings, measured.RemediationPasses, measured.DecisionsRequested, measured.DecisionsResolved,
		measured.HumanActions, measured.MaxConcurrency}
	if want := []int{3, 2, 2, 1, 0, 0, 0, 1, 1, 2, 2}; !slices.Equal(counts, want) {
		t.Fatalf("measurements = %v, want %v: %s", counts, want, body)
	}
	// A unit that never ran still reports arrays, not null.
	if integrate := reportedUnit(t, report, "integrate"); integrate.RunIDs == nil || len(integrate.RunIDs) != 0 ||
		integrate.Providers == nil || len(integrate.Providers) != 0 || integrate.Attempts != 0 {
		t.Fatalf("integrate unit = %#v in %s", integrate, body)
	}
	if after := harness.graph(); after.Revision != before.Revision || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("graph moved from revision %d to %d", before.Revision, after.Revision)
	}

	// A run id whose run is no longer stored is still a run of the unit, and adds nothing else.
	harness.store.mu.Lock()
	delete(harness.store.items, ui.ID)
	harness.store.mu.Unlock()
	report, body = harness.deliveryReport(started.ID)
	measured = report.Measurements
	if lost := reportedUnit(t, report, "ui"); measured.RunCount != 2 || measured.AttemptCount != 1 || measured.FailedAttempts != 0 ||
		measured.MaxConcurrency != 1 || lost.Attempts != 0 || len(lost.Providers) != 0 || !slices.Equal(lost.RunIDs, []string{ui.ID}) {
		t.Fatalf("report after a run was lost = %s", body)
	}
}

func TestWorkGraphReportIsHiddenFromOtherCallers(t *testing.T) {
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
	if response := harness.user("alice", http.MethodPost, plans, plan); response.Code != http.StatusCreated {
		t.Fatalf("propose returned HTTP %d: %s", response.Code, response.Body.String())
	}
	var graph workGraph
	response = harness.user("alice", http.MethodPost, plans+"/1/approve", "")
	if err := json.NewDecoder(response.Body).Decode(&graph); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("approve: HTTP %d, %v", response.Code, err)
	}

	path := "/api/v1/work-graphs/" + graph.ID + "/report"
	if report, body := decodeReport(t, harness.user("alice", http.MethodGet, path, "")); report.GraphID != graph.ID ||
		report.ObjectiveID != created.ID || report.Measurements.UnitCount != 2 {
		t.Fatalf("the owner's report = %s", body)
	}
	// Another user gets exactly what an unknown id gets, and a worker credential is not a reader.
	if response := harness.user("bob", http.MethodGet, path, ""); response.Code != http.StatusNotFound {
		t.Fatalf("another user's report returned HTTP %d", response.Code)
	}
	unknown := "/api/v1/work-graphs/" + strings.Repeat("0", 32) + "/report"
	if response := harness.user("alice", http.MethodGet, unknown, ""); response.Code != http.StatusNotFound {
		t.Fatalf("report of an unknown graph returned HTTP %d", response.Code)
	}
	if response := harness.worker(http.MethodGet, path, aliceToken, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("report with a worker credential returned HTTP %d", response.Code)
	}
}
