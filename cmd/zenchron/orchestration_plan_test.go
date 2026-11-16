package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPlanIsRejectedBeforeAnythingRuns(t *testing.T) {
	harness := newGraphHarness(t)
	writer, reviewer := harness.profile.ID, harness.reviewer.ID
	integrate := unitJSON("integrate", unitIntegrate, "", "api")
	cases := map[string]struct {
		units   []string
		problem string
	}{
		"cycle": {[]string{unitJSON("api", unitProduce, writer, "ui"), unitJSON("ui", unitProduce, harness.second.ID, "api"), integrate},
			"cycle through api, ui, integrate"},
		"unknown dependency": {[]string{unitJSON("api", unitProduce, writer, "ghost"), integrate}, `depends on \"ghost\"`},
		"no integrate unit":  {[]string{unitJSON("api", unitProduce, writer)}, "exactly one integrate unit"},
		"lost work": {[]string{unitJSON("api", unitProduce, writer), unitJSON("ui", unitProduce, harness.second.ID), integrate},
			`\"ui\" never reaches the integrate unit`},
		"self review": {[]string{unitJSON("api", unitProduce, writer), unitJSON("check", unitReview, writer, "api"), integrate},
			"may write code"},
		"reviewer of own integrated work": {[]string{unitJSON("api", unitProduce, reviewer), integrate,
			unitJSON("check", unitReview, reviewer, "integrate")}, "may not write code"},
		"unknown agent": {[]string{unitJSON("api", unitProduce, strings.Repeat("d", 32)), integrate}, "does not exist"},
		"agent on integrate": {[]string{unitJSON("api", unitProduce, writer), unitJSON("integrate", unitIntegrate, writer, "api")},
			"takes no agent"},
		"bad kind":      {[]string{unitJSON("api", "deploy", writer), integrate}, "the kinds are produce, review, and integrate"},
		"duplicate key": {[]string{unitJSON("api", unitProduce, writer), unitJSON("api", unitProduce, writer), integrate}, "used twice"},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			_, response := harness.propose(harness.planBody(test.units...))
			body, _ := io.ReadAll(response.Body)
			if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), test.problem) {
				t.Fatalf("HTTP %d %s, want a problem containing %q", response.StatusCode, body, test.problem)
			}
		})
	}
	if harness.runCount() != 0 {
		t.Fatalf("rejected plans queued %d run(s)", harness.runCount())
	}
	// A reviewer whose own profile produced part of the integrated candidate is not independent.
	harness.reviewer.Tools = []string{"code.write"}
	problems := (&planProposal{Units: []planUnit{
		{Key: "api", Kind: unitProduce, Title: "a", AgentID: writer}, {Key: "ui", Kind: unitProduce, Title: "b", AgentID: harness.second.ID},
		{Key: "integrate", Kind: unitIntegrate, Title: "c", DependsOn: []string{"api", "ui"}},
		{Key: "check", Kind: unitReview, Title: "d", AgentID: harness.second.ID, DependsOn: []string{"integrate"}},
	}}).problems(map[string]agentProfile{writer: harness.profile, harness.second.ID: harness.second})
	if len(problems) == 0 || !strings.Contains(strings.Join(problems, " "), "may write code") {
		t.Fatalf("problems = %v", problems)
	}
}

func TestChangedPlanCannotReplaceAnExecutingOneAndAnUnchangedPlanNeedsNoNewApproval(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())

	// The same plan again is recognized: no new revision and nothing to approve.
	same, response := harness.propose(harness.twoProducerPlan())
	if response.StatusCode != http.StatusOK || same.Revision != 1 || same.Status != planApproved || same.GraphID != graph.ID {
		t.Fatalf("unchanged plan: HTTP %d %#v", response.StatusCode, same)
	}
	if again, status := harness.approve(1); status != http.StatusOK || again.ID != graph.ID || harness.runCount() != 2 {
		t.Fatalf("approving an approved plan: HTTP %d, graph %s, runs %d", status, again.ID, harness.runCount())
	}

	// A different plan is recorded as a proposal but cannot be approved while the first one executes.
	changed, response := harness.propose(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api")))
	if response.StatusCode != http.StatusCreated || changed.Revision != 2 || changed.Status != planProposed {
		t.Fatalf("changed plan: HTTP %d %#v", response.StatusCode, changed)
	}
	if _, status := harness.approve(2); status != http.StatusConflict {
		t.Fatalf("approving a changed plan over an executing graph returned HTTP %d", status)
	}
	if _, status := harness.approve(1); status != http.StatusOK {
		t.Fatalf("the executing plan is no longer reported: HTTP %d", status)
	}
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusOK {
		t.Fatalf("cancel returned HTTP %d", response.Code)
	}
	replacement, status := harness.approve(2)
	if status != http.StatusCreated || replacement.ID == graph.ID || len(replacement.Units) != 2 {
		t.Fatalf("approval after cancelling: HTTP %d %#v", status, replacement)
	}
	plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	if len(plans) != 2 || plans[0].Status != planApproved || plans[1].Status != planSuperseded {
		t.Fatalf("plan history = %#v", plans)
	}
}

func TestPlannerRunOnlyProposesAndItsPlanIsValidatedLikeAnyOther(t *testing.T) {
	harness := newGraphHarness(t)
	planner := `{"project_id":"` + testProjectID + `","planner_agent_id":"` + harness.reviewer.ID + `"}`
	if _, response := harness.propose(`{"project_id":"` + testProjectID + `","planner_agent_id":"` + harness.profile.ID + `"}`); response.StatusCode != http.StatusConflict {
		t.Fatalf("a planner that may write code returned HTTP %d", response.StatusCode)
	}
	plan, response := harness.propose(planner)
	if response.StatusCode != http.StatusCreated || plan.Status != planPlanning || plan.PlannerRunID == "" {
		t.Fatalf("planner proposal: HTTP %d %#v", response.StatusCode, plan)
	}
	command := harness.claim()
	if command.ID != plan.PlannerRunID || !strings.Contains(command.Prompt, "agent_id "+harness.profile.ID) ||
		!strings.Contains(command.Prompt, "Export usage as CSV.") || !strings.Contains(command.Prompt, `"plan"`) ||
		!strings.Contains(command.Prompt, "instructions 4000") || !strings.Contains(command.Prompt, `an empty "capabilities" list`) {
		t.Fatalf("planner command = %q", command.Prompt)
	}
	// The model proposes a reviewer that may write code; deterministic validation refuses it.
	invalid, _ := json.Marshal(map[string]any{"plan": json.RawMessage(`{"summary":"s","max_parallel":1,"units":[` +
		unitJSON("api", unitProduce, harness.profile.ID) + `,` + unitJSON("check", unitReview, harness.second.ID, "api") + `,` +
		unitJSON("integrate", unitIntegrate, "", "check") + `]}`)})
	harness.report(command, workerapi.AgentRunResult{Output: "Planned.", Result: string(invalid)})
	plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	if len(plans) != 1 || plans[0].Status != planInvalid || !strings.Contains(strings.Join(plans[0].Problems, " "), "may write code") {
		t.Fatalf("invalid planner output = %#v", plans)
	}
	if _, status := harness.approve(1); status != http.StatusConflict || harness.runCount() != 1 {
		t.Fatalf("an invalid plan was approvable: HTTP %d, runs %d", status, harness.runCount())
	}

	// A valid proposal waits for approval; nothing runs before it.
	if _, response := harness.propose(planner); response.StatusCode != http.StatusCreated {
		t.Fatalf("second planner proposal returned HTTP %d", response.StatusCode)
	}
	command = harness.claim()
	valid, _ := json.Marshal(map[string]any{"plan": json.RawMessage(`{"summary":"s","max_parallel":1,"units":[` +
		unitJSON("api", unitProduce, harness.profile.ID) + `,` + unitJSON("integrate", unitIntegrate, "", "api") + `]}`)})
	harness.report(command, workerapi.AgentRunResult{Output: "Planned.", Result: string(valid)})
	plans = decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	if plans[0].Revision != 2 || plans[0].Status != planProposed || len(plans[0].Units) != 2 || plans[0].Hash == "" {
		t.Fatalf("valid planner output = %#v", plans[0])
	}
	harness.nothingToClaim()
	if graph, status := harness.approve(2); status != http.StatusCreated || graph.unit("api").State != unitQueued {
		t.Fatalf("approval of the planner's plan: HTTP %d %#v", status, graph)
	}
}
