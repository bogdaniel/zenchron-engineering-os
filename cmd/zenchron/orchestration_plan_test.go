package main

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func TestEmptyPlanAndWorkGraphCollectionsAreJSONArrays(t *testing.T) {
	harness := newGraphHarness(t)
	for _, path := range []string{"/api/v1/objectives/" + harness.objectiveID + "/plans", "/api/v1/work-graphs"} {
		response := harness.call(http.MethodGet, path, "")
		if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "[]" {
			t.Fatalf("empty collection %s = HTTP %d %q", path, response.Code, response.Body.String())
		}
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

func TestFailedPlanApprovalRestoresPreviousPlanStatuses(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.twoProducerPlan())
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", ""); response.Code != http.StatusOK {
		t.Fatalf("cancel returned HTTP %d", response.Code)
	}
	proposed, response := harness.propose(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api")))
	if response.StatusCode != http.StatusCreated || proposed.Revision != 2 {
		t.Fatalf("propose replacement: HTTP %d, revision %d", response.StatusCode, proposed.Revision)
	}

	harness.store.graphs.path = filepath.Join(t.TempDir(), "missing", "work-graphs.json")
	if _, status := harness.approve(proposed.Revision); status != http.StatusInternalServerError {
		t.Fatalf("approval with unavailable persistence returned HTTP %d", status)
	}

	harness.store.graphs.mu.Lock()
	defer harness.store.graphs.mu.Unlock()
	plans := harness.store.graphs.plans[harness.objectiveID]
	if len(plans) != 2 || plans[0].Status != planApproved || plans[1].Status != planProposed || plans[1].GraphID != "" {
		t.Fatalf("failed approval left plan history inconsistent: %#v", plans)
	}
}

func TestPlanPinsProfileConfigurationAndRejectsStaleApproval(t *testing.T) {
	harness := newGraphHarness(t)
	harness.profile.SystemPrompt = "Pinned system prompt"
	harness.profile.Version = 1
	personaID := strings.Repeat("d", 32)
	harness.profile.PersonaID = personaID
	harness.store.agents.items[harness.profile.ID] = harness.profile
	harness.store.agents.personas[personaID] = agentPersona{ID: personaID, Name: "CSV specialist", Role: "Implement CSV output",
		Instructions: "Keep exports compatible.", Status: "active", Version: 3, UpdatedAt: time.Now().UTC()}
	response := harness.call(http.MethodPost, "/api/v1/objectives/"+harness.objectiveID+"/plans", harness.twoProducerPlan())
	var proposed objectivePlan
	if err := json.NewDecoder(response.Body).Decode(&proposed); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("propose plan: HTTP %d, %v", response.Code, err)
	}
	if _, exposed := proposed.ProfileSnapshots[harness.profile.ID]; exposed {
		t.Fatal("plan response exposed private provider prompt snapshots")
	}
	stored := harness.store.graphs.plans[harness.objectiveID][proposed.Revision-1]
	if stored.ProfileSnapshots[harness.profile.ID].SystemPrompt != "Pinned system prompt" ||
		stored.ProfileSnapshots[harness.profile.ID].PersonaSnapshot == nil ||
		stored.ProfileSnapshots[harness.profile.ID].PersonaSnapshot.Version != 3 || stored.Units[0].ProfileVersion != 1 ||
		stored.Units[0].PersonaVersion != 3 {
		t.Fatalf("stored plan did not pin profile configuration: %#v", stored)
	}

	harness.store.agents.items[harness.profile.ID] = agentProfile{ID: harness.profile.ID, Name: harness.profile.Name,
		Provider: harness.profile.Provider, Model: harness.profile.Model, Status: "active", SystemPrompt: "Edited prompt",
		PersonaID: personaID, Version: 2, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"}}
	if _, status := harness.approve(proposed.Revision); status != http.StatusConflict {
		t.Fatalf("stale plan approval returned HTTP %d, want 409", status)
	}

	// A later accepted revision uses its stored snapshot even if the live profile changes after approval.
	newer, proposalResponse := harness.propose(harness.twoProducerPlan())
	if proposalResponse.StatusCode != http.StatusCreated {
		t.Fatalf("propose updated plan returned HTTP %d", proposalResponse.StatusCode)
	}
	graph, status := harness.approve(newer.Revision)
	if status != http.StatusCreated {
		t.Fatalf("approve updated plan returned HTTP %d", status)
	}
	reopened, err := openWorkGraphStore(harness.store.graphs.path, harness.store, harness.store.graphs.objectives,
		harness.store.agents, harness.store.graphs.workflows)
	if err != nil || reopened.plans[harness.objectiveID][newer.Revision-1].ProfileSnapshots[harness.profile.ID].PersonaSnapshot.Version != 3 {
		t.Fatalf("restart lost pinned profile or persona snapshot: err=%v plans=%#v", err, reopened.plans)
	}
	run, exists := harness.store.get(graph.unit("api").RunIDs[0])
	if !exists || run.Profile == nil || run.Profile.SystemPrompt != "Edited prompt" || run.Profile.Version != 2 {
		t.Fatalf("approved run did not use pinned profile snapshot: %#v", run.Profile)
	}
	harness.store.agents.items[harness.profile.ID] = agentProfile{ID: harness.profile.ID, Name: harness.profile.Name,
		Provider: harness.profile.Provider, Model: harness.profile.Model, Status: "active", SystemPrompt: "Changed after approval",
		PersonaID: personaID, Version: 3, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"}}
	persona := harness.store.agents.personas[personaID]
	persona.Instructions, persona.Version = "Edited after approval.", 4
	harness.store.agents.personas[personaID] = persona
	claimed := harness.claimUnit("api")
	queued, exists := harness.store.get(claimed.ID)
	if !exists || queued.Profile == nil || queued.Profile.SystemPrompt != "Edited prompt" || queued.Profile.Version != 2 ||
		queued.Profile.PersonaSnapshot == nil || queued.Profile.PersonaSnapshot.Version != 3 ||
		queued.Profile.PersonaSnapshot.Instructions != "Keep exports compatible." {
		t.Fatalf("queued run did not retain the approved profile snapshot: %#v", queued.Profile)
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

func TestPlannerReceivesVersionPinnedWorkflowGuidance(t *testing.T) {
	harness := newGraphHarness(t)
	created := harness.call(http.MethodPost, "/api/v1/workflows", `{"name":"Planner guidance","description":"Workflow v1"}`)
	var definition workflow
	if err := json.NewDecoder(created.Body).Decode(&definition); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create workflow: decode error %v, HTTP %d", err, created.Code)
	}
	definition.Nodes[1].Data.Description = "Original guidance text"
	definition.Nodes[1].Data.AgentID = harness.profile.ID
	definition.Nodes[1].Data.Acceptance = []string{"Preserve this acceptance criterion"}
	save := func() workflow {
		body, err := json.Marshal(struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			Status      string         `json:"status"`
			Nodes       []workflowNode `json:"nodes"`
			Edges       []workflowEdge `json:"edges"`
		}{definition.Name, definition.Description, definition.Status, definition.Nodes, definition.Edges})
		if err != nil {
			t.Fatal(err)
		}
		response := harness.call(http.MethodPut, "/api/v1/workflows/"+definition.ID, string(body))
		var updated workflow
		if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK {
			t.Fatalf("save workflow: decode error %v, HTTP %d", err, response.Code)
		}
		definition = updated
		return updated
	}
	saved := save()
	if saved.Version != 2 {
		t.Fatalf("saved workflow version = %d, want 2", saved.Version)
	}
	body := `{"project_id":"` + testProjectID + `","planner_agent_id":"` + harness.reviewer.ID +
		`","workflow_id":"` + definition.ID + `"}`
	plan, response := harness.propose(body)
	if response.StatusCode != http.StatusCreated || plan.Status != planPlanning || plan.WorkflowID != saved.ID ||
		plan.WorkflowVersion != saved.Version || plan.WorkflowMode != workflowModeGuidance {
		t.Fatalf("planner with workflow guidance: HTTP %d %#v", response.StatusCode, plan)
	}

	definition.Nodes[1].Data.Description = "Edited after the planner was queued"
	definition.Name = "Edited planner guidance"
	if edited := save(); edited.Version != saved.Version+1 {
		t.Fatalf("edited workflow version = %d, want %d", edited.Version, saved.Version+1)
	}
	command := harness.claim()
	for _, expected := range []string{"Workflow guidance only", `"id":"` + saved.ID + `"`,
		`"version":2`, "Original guidance text", "Preserve this acceptance criterion", `"source":"task"`,
		`"target":"integrate"`} {
		if !strings.Contains(command.Prompt, expected) {
			t.Errorf("planner prompt omitted saved workflow detail %q: %s", expected, command.Prompt)
		}
	}
	if strings.Contains(command.Prompt, "Edited after the planner was queued") || strings.Contains(command.Prompt, "Edited planner guidance") {
		t.Fatalf("planner prompt read a later workflow version: %s", command.Prompt)
	}
	valid, _ := json.Marshal(map[string]any{"plan": json.RawMessage(`{"summary":"guided plan","max_parallel":1,"units":[` +
		unitJSON("api", unitProduce, harness.profile.ID) + `,` +
		unitJSON("integrate", unitIntegrate, "", "api") + `]}`)})
	harness.report(command, workerapi.AgentRunResult{Output: "Planned.", Result: string(valid)})
	plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	if len(plans) != 1 || plans[0].Status != planProposed || plans[0].WorkflowID != saved.ID ||
		plans[0].WorkflowVersion != saved.Version || plans[0].WorkflowMode != workflowModeGuidance {
		t.Fatalf("planner proposal lost workflow guidance provenance: %#v", plans)
	}
	graph, status := harness.approve(plans[0].Revision)
	if status != http.StatusCreated || graph.WorkflowID != saved.ID || graph.WorkflowVersion != saved.Version ||
		graph.WorkflowMode != workflowModeGuidance {
		t.Fatalf("guided graph lost workflow provenance: HTTP %d %#v", status, graph)
	}
	report, _ := harness.deliveryReport(graph.ID)
	if report.WorkflowMode != workflowModeGuidance || report.WorkflowVersion != saved.Version {
		t.Fatalf("guided report = mode %q, version %d", report.WorkflowMode, report.WorkflowVersion)
	}
}
