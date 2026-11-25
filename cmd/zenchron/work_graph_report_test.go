package main

import (
	"encoding/json"
	"fmt"
	"io"
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

func TestWorkGraphReportRequiresExplicitGitHubPRState(t *testing.T) {
	valid := `"number":23,"state":"open","html_url":"https://github.com/acme/platform/pull/23","head":{"sha":"` + commit(4) + `"}`
	for _, test := range []struct {
		name       string
		body       string
		checksBody string
		checksCode int
		want       bool
		wantChecks bool
		wantRuns   int
	}{
		{name: "missing draft", body: `{` + valid + `,"merged_at":null}`},
		{name: "missing merged timestamp", body: `{` + valid + `,"draft":false}`},
		{name: "invalid merged timestamp", body: `{` + valid + `,"draft":false,"merged_at":false}`},
		{name: "explicit false and null", body: `{` + valid + `,"draft":false,"merged_at":null}`, want: true, wantChecks: true, wantRuns: 1},
		{name: "mismatched candidate check head", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":[{"id":1,"name":"go","status":"completed","head_sha":"` + commit(7) + `"}]}`, want: true},
		{name: "missing check run id", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":[{"name":"go","status":"completed","head_sha":"` + commit(4) + `"}]}`, want: true},
		{name: "waiting and completed candidate checks", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":[{"id":1,"name":"waiting","status":"waiting","head_sha":"` + commit(4) + `"},` +
				`{"id":2,"name":"go","status":"completed","head_sha":"` + commit(4) + `"}]}`, want: true, wantChecks: true, wantRuns: 2},
		{name: "unknown candidate check status", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":[{"id":1,"name":"go","status":"unknown","head_sha":"` + commit(4) + `"}]}`, want: true},
		{name: "missing candidate check array", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{}`, want: true},
		{name: "null candidate check array", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":null}`, want: true},
		{name: "empty candidate check array", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksBody: `{"check_runs":[]}`, want: true, wantChecks: true},
		{name: "unavailable candidate checks", body: `{` + valid + `,"draft":false,"merged_at":null}`,
			checksCode: http.StatusBadGateway, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			report := deliveryReport{PullRequestURL: "https://github.com/acme/platform/pull/23",
				Units:           []reportUnit{{Kind: unitIntegrate, Candidate: commit(4)}},
				UnknownEvidence: []string{"pull_request_external_state", "candidate_checks"}}
			report.observePullRequest(t.Context(), "github.com/acme/platform", gitHubClient{
				apiURL: "https://api.github.com", client: &http.Client{Transport: updateTestTransport(
					func(request *http.Request) (*http.Response, error) {
						status, responseBody := http.StatusOK, test.body
						if strings.HasSuffix(request.URL.Path, "/check-runs") {
							if request.URL.Path != "/repos/acme/platform/commits/"+commit(4)+"/check-runs" {
								t.Fatalf("candidate check path = %s", request.URL.Path)
							}
							status, responseBody = test.checksCode, test.checksBody
							if status == 0 {
								status = http.StatusOK
							}
							if responseBody == "" {
								responseBody = `{"check_runs":[{"id":1,"name":"go","status":"completed","conclusion":"success","head_sha":"` + commit(4) + `"}]}`
							}
						} else if request.URL.Path != "/repos/acme/platform/pulls/23" {
							t.Fatalf("request path = %s", request.URL.Path)
						}
						return &http.Response{StatusCode: status, Header: make(http.Header),
							Body: io.NopCloser(strings.NewReader(responseBody)), Request: request}, nil
					})},
			})
			if (report.PullRequest != nil) != test.want {
				t.Fatalf("observed PR = %#v, want present %t", report.PullRequest, test.want)
			}
			if test.want && (report.PullRequest.Draft || report.PullRequest.Merged || slices.Contains(report.UnknownEvidence, "pull_request_external_state")) {
				t.Fatalf("explicit false/null state = %#v, unknown=%v", report.PullRequest, report.UnknownEvidence)
			}
			if test.wantChecks != (report.PullRequest != nil && report.PullRequest.CandidateChecks != nil) {
				t.Fatalf("candidate checks = %#v, want present %t", report.PullRequest, test.wantChecks)
			}
			if test.wantChecks && len(report.PullRequest.CandidateChecks.Runs) != test.wantRuns {
				t.Fatalf("candidate check runs = %#v, want %d", report.PullRequest.CandidateChecks.Runs, test.wantRuns)
			}
			if test.wantChecks && len(report.PullRequest.CandidateChecks.Runs) > 0 &&
				report.PullRequest.CandidateChecks.Runs[0].ID <= 0 {
				t.Fatalf("candidate check run has no source id: %#v", report.PullRequest.CandidateChecks.Runs[0])
			}
			if !test.wantChecks && !slices.Contains(report.UnknownEvidence, "candidate_checks") {
				t.Fatalf("unavailable candidate checks were not marked unknown: %v", report.UnknownEvidence)
			}
			if !test.want && !slices.Contains(report.UnknownEvidence, "pull_request_external_state") {
				t.Fatalf("missing or invalid state removed unknown evidence: %v", report.UnknownEvidence)
			}
		})
	}
}

func TestWorkGraphReportOmitsUnacceptedResultAttempt(t *testing.T) {
	for _, status := range []string{"queued", "running"} {
		t.Run(status, func(t *testing.T) {
			harness := newGraphHarness(t)
			started := harness.start(harness.twoProducerPlan())
			if status == "running" {
				harness.claimUnit("api")
			}

			report, body := harness.deliveryReport(started.ID)
			executions := reportedUnit(t, report, "api").Executions
			if len(executions) != 1 || executions[0].Status != status || executions[0].ResultAttempt != 0 {
				t.Fatalf("execution = %#v, want a %s run without an accepted result", executions, status)
			}
			if strings.Contains(body, `"result_attempt"`) {
				t.Fatalf("report claims an unaccepted result attempt: %s", body)
			}
		})
	}
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
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9),
		Output:       "private provider transcript sentinel",
		Verification: workerapi.VerificationPassed, Result: string(merged)})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)
	harness.authorizePublication(integration.ID, commit(4))
	publication := harness.claimUnit("integrate")
	harness.pullHead = commit(4)
	harness.report(publication, workerapi.AgentRunResult{CommitSHA: commit(4), CommitTreeSHA: commit(5), BaseCommit: commit(9),
		Output: "Merged.", Verification: workerapi.VerificationPassed, BranchPushed: true, Result: string(merged)})
	updatedProfile, err := json.Marshal(agentProfileInput{Name: harness.profile.Name, Provider: harness.profile.Provider,
		Model: "changed-after-run", Status: harness.profile.Status, SystemPrompt: harness.profile.SystemPrompt,
		GoalPrompt: harness.profile.GoalPrompt, Tools: harness.profile.Tools})
	if err != nil {
		t.Fatal(err)
	}
	if response := harness.call(http.MethodPut, "/api/v1/agents/"+harness.profile.ID, string(updatedProfile)); response.Code != http.StatusOK {
		t.Fatalf("update current agent profile returned HTTP %d: %s", response.Code, response.Body.String())
	}

	before := harness.graph()
	report, body := harness.deliveryReport(started.ID)
	if strings.Contains(body, "private provider transcript sentinel") {
		t.Fatalf("delivery report exposed the provider transcript: %s", body)
	}
	if report.GraphID != started.ID || report.GraphRevision != before.Revision || report.ObjectiveID != harness.objectiveID ||
		report.ObjectiveTitle != "Ship usage export" ||
		report.PlanRevision != 1 || report.Status != graphCompleted || before.Status != graphCompleted ||
		report.PullRequestURL != "https://github.com/acme/platform/pull/23" || report.ApprovedPlan == nil ||
		report.ApprovedPlan.Revision != 1 || report.ApprovedPlan.Status != planApproved || report.ApprovedPlan.ApprovedBy == "" {
		t.Fatalf("report identity = %s", body)
	}
	measured := report.Measurements
	counts := []int{measured.UnitCount, measured.RunCount, measured.AttemptCount, measured.FailedAttempts, measured.ReviewRounds,
		measured.Findings, measured.RemediationPasses, measured.DecisionsRequested, measured.DecisionsResolved,
		measured.HumanActions, measured.MaxConcurrency}
	// 5 units; 6 runs; 8 attempts; one explicit publication authorization in addition to plan approval.
	if want := []int{5, 6, 8, 0, 3, 1, 1, 0, 0, 2, 2}; !slices.Equal(counts, want) {
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
		apiUnit.Executions[0].ProfileVersion != harness.profile.Version || apiUnit.Executions[0].Model != harness.profile.Model ||
		apiUnit.Executions[0].CandidateCommit != commit(3) ||
		apiUnit.Executions[0].ResultAttempt != 2 || apiUnit.Executions[0].UpdatedAt.IsZero() ||
		len(report.Handoffs) == 0 || report.Handoffs[0].MessageID == "" || len(report.Outstanding) != 0 {
		t.Fatalf("execution provenance, handoffs, or outstanding steps = report unit %#v, handoffs %#v, outstanding %#v",
			apiUnit, report.Handoffs, report.Outstanding)
	}
	if !slices.Equal(uiUnit.Providers, []string{workerapi.ProviderCodex + " 1.2.3"}) || review.Verdict != "accept" ||
		len(uiUnit.Executions) != 1 || uiUnit.Executions[0].Verification != workerapi.VerificationPassed ||
		len(review.RunIDs) != 2 || review.Attempts != 2 || !slices.Equal(review.Providers, []string{workerapi.ProviderCodex}) ||
		len(review.Executions) != 2 || review.Executions[0].BaseCommit != commit(1) || review.Executions[1].BaseCommit != commit(3) {
		t.Fatalf("ui unit = %#v, review unit = %#v", uiUnit, review)
	}
	authorizedRun, exists := harness.store.get(integration.ID)
	if !exists || len(authorizedRun.PublicationAuthorizations) != 1 {
		t.Fatalf("persisted publication authorization = %#v, exists %t", authorizedRun.PublicationAuthorizations, exists)
	}
	authorization := authorizedRun.PublicationAuthorizations[0]
	if !slices.Equal(report.UnknownEvidence, []string{"policy_backed_assurance"}) || report.PublicationAuthority == nil ||
		report.PublicationAuthority.By != authorization.By || report.PublicationAuthority.CommitSHA != authorization.CommitSHA ||
		report.PublicationAuthority.SourceRunID != integration.ID || report.PublicationAuthority.GraphID != authorization.GraphID ||
		report.PublicationAuthority.GraphRevision != authorization.GraphRevision ||
		report.PublicationAuthority.PlanRevision != authorization.PlanRevision ||
		report.PublicationAuthority.PlanHash != authorization.PlanHash || report.PublicationAuthority.Attempt != authorization.Attempt {
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
		if observed.CandidateChecks != nil {
			checks := *observed.CandidateChecks
			checks.ObservedAt = time.Time{}
			observed.CandidateChecks = &checks
		}
		original.PullRequest = &observed
	}
	if replayed.PullRequest != nil {
		observed := *replayed.PullRequest
		observed.ObservedAt = time.Time{}
		if observed.CandidateChecks != nil {
			checks := *observed.CandidateChecks
			checks.ObservedAt = time.Time{}
			observed.CandidateChecks = &checks
		}
		replayed.PullRequest = &observed
	}
	if !reflect.DeepEqual(replayed, original) {
		t.Fatalf("report after restart = %#v, before restart %#v", replayed, original)
	}
	harness.store.mu.Lock()
	delete(harness.store.items, api.ID)
	persistErr := harness.store.persistLocked()
	harness.store.mu.Unlock()
	if persistErr != nil {
		t.Fatalf("persist missing run record: %v", persistErr)
	}
	harness.restart()
	restarted, body := harness.deliveryReport(started.ID)
	apiAfterRestart := reportedUnit(t, restarted, "api")
	if restarted.Status != graphCompleted || !slices.Contains(restarted.UnknownEvidence, "missing_run_records") ||
		apiAfterRestart.Attempts != 0 || !slices.Equal(apiAfterRestart.RunIDs, []string{api.ID}) ||
		!slices.Contains(restarted.Measurements.Unknown, "attempt_count_for_some_runs") ||
		!slices.Contains(restarted.Measurements.Unknown, "remediation_passes_for_some_runs") {
		t.Fatalf("report after restarting with a lost run record = %s", body)
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
	if !slices.Contains(report.UnknownEvidence, "policy_backed_assurance") {
		t.Fatalf("report implied policy-backed assurance without a recorded authority: %v", report.UnknownEvidence)
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

	// A lost run stays counted by its graph reference while its attempt-derived details are marked unknown.
	harness.store.mu.Lock()
	delete(harness.store.items, ui.ID)
	harness.store.mu.Unlock()
	report, body = harness.deliveryReport(started.ID)
	measured = report.Measurements
	if lost := reportedUnit(t, report, "ui"); measured.RunCount != 2 || measured.AttemptCount != 1 || measured.FailedAttempts != 0 ||
		measured.MaxConcurrency != 1 || lost.Attempts != 0 || len(lost.Providers) != 0 || !slices.Equal(lost.RunIDs, []string{ui.ID}) {
		t.Fatalf("report after a run was lost = %s", body)
	}
	if !slices.Contains(report.UnknownEvidence, "missing_run_records") {
		t.Fatalf("missing run record is not identified as unknown evidence: %v", report.UnknownEvidence)
	}
	for _, missing := range []string{"attempt_count_for_some_runs", "failed_attempts_for_some_runs",
		"max_concurrency_for_some_runs", "remediation_passes_for_some_runs"} {
		if !slices.Contains(measured.Unknown, missing) {
			t.Fatalf("missing run record did not mark %q unknown: %v", missing, measured.Unknown)
		}
	}
}

func TestWorkGraphReportMarksMissingApprovedPlanUnknown(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.reviewedPlan())
	harness.store.graphs.mu.Lock()
	delete(harness.store.graphs.plans, graph.ObjectiveID)
	harness.store.graphs.mu.Unlock()

	report, body := harness.deliveryReport(graph.ID)
	if report.ApprovedPlan != nil || !slices.Contains(report.UnknownEvidence, "approved_plan") ||
		report.Measurements.HumanActions != 0 || strings.Contains(body, `"approved_plan":`) {
		t.Fatalf("missing plan source was reported as observed evidence: %s", body)
	}
}

func TestWorkGraphReportPreservesHistoricalPlanApprovalAfterSupersession(t *testing.T) {
	harness := newGraphHarness(t)
	firstPlan, response := harness.propose(harness.twoProducerPlan())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("propose first plan returned HTTP %d", response.StatusCode)
	}
	firstGraph, status := harness.approve(firstPlan.Revision)
	if status != http.StatusCreated {
		t.Fatalf("approve first plan returned HTTP %d", status)
	}
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+firstGraph.ID+"/cancel", ""); response.Code >= http.StatusBadRequest {
		t.Fatalf("cancel first graph returned HTTP %d: %s", response.Code, response.Body.String())
	}
	secondPlan, response := harness.propose(harness.twoProducerPlan())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("propose second plan returned HTTP %d", response.StatusCode)
	}
	if _, status := harness.approve(secondPlan.Revision); status != http.StatusCreated {
		t.Fatalf("approve second plan returned HTTP %d", status)
	}

	report, body := harness.deliveryReport(firstGraph.ID)
	if report.ApprovedPlan == nil || report.ApprovedPlan.Revision != firstPlan.Revision ||
		report.ApprovedPlan.Status != planSuperseded || report.ApprovedPlan.ApprovedBy == "" ||
		report.ApprovedPlan.ApprovedAt == nil || report.Measurements.HumanActions != 1 {
		t.Fatalf("historical plan approval was not preserved: %s", body)
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
