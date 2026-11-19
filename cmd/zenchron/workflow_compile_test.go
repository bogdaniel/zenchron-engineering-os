package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestCompileWorkflowUsesConfiguredAssignmentsDependenciesAndAcceptance(t *testing.T) {
	writerID, reviewerID := strings.Repeat("a", 32), strings.Repeat("b", 32)
	personaID := strings.Repeat("c", 32)
	definition := workflow{ID: "workflow-1", Version: 3, Description: "Build then review", Nodes: []workflowNode{
		{ID: "start", Type: "trigger", Data: workflowNodeData{Label: "Start"}},
		{ID: "build", Type: "agent-task", Data: workflowNodeData{Label: "Build", Description: "Implement objective",
			AgentID: writerID, PersonaID: personaID, Acceptance: []string{"Tests pass"}}},
		{ID: "review", Type: "code-reviewer", Data: workflowNodeData{Label: "Review", AgentID: reviewerID}},
		{ID: "merge", Type: "integrate", Data: workflowNodeData{Label: "Integrate"}},
	}, Edges: []workflowEdge{
		{ID: "start-build", Source: "start", Target: "build"},
		{ID: "build-review", Source: "build", Target: "review"},
		{ID: "review-merge", Source: "review", Target: "merge"},
	}}
	agents := map[string]agentProfile{
		writerID: {ID: writerID, Name: "Writer", Provider: workerapi.ProviderCodex, Model: "default", Status: "active",
			Tools: []string{"code.write"}, PersonaID: personaID,
			PersonaSnapshot: &agentPersona{ID: personaID, Version: 2, Status: "active"}},
		reviewerID: {ID: reviewerID, Name: "Reviewer", Provider: workerapi.ProviderClaude, Model: "default", Status: "active", Tools: []string{"git.read"}},
	}
	proposal, problems := compileWorkflow(definition, agents)
	if len(problems) != 0 {
		t.Fatalf("compile workflow problems = %v", problems)
	}
	if len(proposal.Units) != 3 || proposal.Units[0].AgentID != writerID || proposal.Units[0].PersonaID != personaID ||
		proposal.Units[0].Acceptance[0] != "Tests pass" ||
		proposal.Units[1].DependsOn[0] != proposal.Units[0].Key || proposal.Units[2].Kind != unitIntegrate {
		t.Fatalf("compiled proposal did not preserve workflow configuration: %#v", proposal)
	}

	definition.Nodes[1].Data.AgentID = reviewerID
	changed, changedProblems := compileWorkflow(definition, agents)
	if len(changedProblems) == 0 || len(changed.Units) == 0 {
		t.Fatalf("incompatible assignment should produce a plan validation problem; got %#v, %v", changed, changedProblems)
	}
}

func TestSavedWorkflowCompilesToVersionedObjectivePlan(t *testing.T) {
	harness := newGraphHarness(t)
	created := harness.call(http.MethodPost, "/api/v1/workflows", `{"name":"Build and review","description":"Deliver code"}`)
	var definition workflow
	if err := json.NewDecoder(created.Body).Decode(&definition); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create workflow: decode error %v, HTTP %d", err, created.Code)
	}
	definition.Nodes = []workflowNode{
		{ID: "start", Type: "trigger", Data: workflowNodeData{Label: "Trigger"}},
		{ID: "build", Type: "agent-task", Data: workflowNodeData{Label: "Implement export", Description: "Build CSV output",
			AgentID: harness.profile.ID, Acceptance: []string{"CSV is valid"}}},
		{ID: "review", Type: "code-reviewer", Data: workflowNodeData{Label: "Review export", AgentID: harness.reviewer.ID}},
		{ID: "merge", Type: "integrate", Data: workflowNodeData{Label: "Integrate"}},
	}
	definition.Edges = []workflowEdge{{ID: "1", Source: "start", Target: "build"},
		{ID: "2", Source: "build", Target: "review"}, {ID: "3", Source: "review", Target: "merge"}}
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
	definition.Version = 1
	save()
	validateBody, _ := json.Marshal(map[string]any{"nodes": definition.Nodes, "edges": definition.Edges})
	validated := harness.call(http.MethodPost, "/api/v1/workflows/"+definition.ID+"/validate", string(validateBody))
	var validation struct {
		Valid    bool     `json:"valid"`
		Problems []string `json:"problems"`
	}
	if err := json.NewDecoder(validated.Body).Decode(&validation); err != nil || validated.Code != http.StatusOK || !validation.Valid {
		t.Fatalf("validate workflow = %#v, error %v, HTTP %d", validation, err, validated.Code)
	}
	propose := func() objectivePlan {
		plan, response := harness.propose(fmt.Sprintf(`{"project_id":%q,"workflow_id":%q}`, testProjectID, definition.ID))
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("workflow plan returned HTTP %d: %s", response.StatusCode, response.Body)
		}
		return plan
	}
	first := propose()
	if first.WorkflowVersion != definition.Version || first.WorkflowMode != workflowModeCompiled || len(first.Units) != 3 || first.Units[0].Title != "Implement export" ||
		first.Units[0].AgentID != harness.profile.ID || first.Units[0].Acceptance[0] != "CSV is valid" {
		t.Fatalf("compiled objective plan = %#v", first)
	}
	definition.Nodes[1].Data.Acceptance = []string{"CSV is valid", "Usage totals match"}
	save()
	second := propose()
	if second.WorkflowVersion != first.WorkflowVersion+1 || second.Hash == first.Hash ||
		len(second.Units[0].Acceptance) != 2 {
		t.Fatalf("workflow edit did not change pinned compiled plan: first=%#v second=%#v", first, second)
	}
	manual := fmt.Sprintf(`{"project_id":%q,"workflow_id":%q,"plan":{"summary":"unrelated","max_parallel":1,"units":[%s,%s]}}`,
		testProjectID, definition.ID, unitJSON("manual", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "manual"))
	_, response := harness.propose(manual)
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "manual plans cannot claim a workflow") {
		t.Fatalf("unrelated manual plan with workflow identity returned HTTP %d: %s", response.StatusCode, body)
	}
	plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", ""))
	if len(plans) != 2 {
		t.Fatalf("rejected manual workflow claim persisted a plan: %#v", plans)
	}
	graph, status := harness.approve(second.Revision)
	if status != http.StatusCreated || graph.WorkflowMode != workflowModeCompiled || graph.WorkflowVersion != definition.Version {
		t.Fatalf("compiled workflow graph = HTTP %d %#v", status, graph)
	}
	report, _ := harness.deliveryReport(graph.ID)
	if report.WorkflowMode != workflowModeCompiled {
		t.Fatalf("compiled workflow report mode = %q", report.WorkflowMode)
	}
}

func TestCompileWorkflowRejectsUnsupportedNodesCyclesAndIneligibleAgents(t *testing.T) {
	harness := newGraphHarness(t)
	created := harness.call(http.MethodPost, "/api/v1/workflows", `{"name":"Validation","description":"Test invalid graphs"}`)
	var definition workflow
	if err := json.NewDecoder(created.Body).Decode(&definition); err != nil || created.Code != http.StatusCreated {
		t.Fatalf("create workflow: decode error %v, HTTP %d", err, created.Code)
	}
	validate := func(candidate workflow) []string {
		t.Helper()
		body, err := json.Marshal(struct {
			Nodes []workflowNode `json:"nodes"`
			Edges []workflowEdge `json:"edges"`
		}{candidate.Nodes, candidate.Edges})
		if err != nil {
			t.Fatal(err)
		}
		response := harness.call(http.MethodPost, "/api/v1/workflows/"+definition.ID+"/validate", string(body))
		var result struct {
			Valid    bool     `json:"valid"`
			Problems []string `json:"problems"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil || response.Code != http.StatusOK {
			t.Fatalf("validate workflow: decode error %v, HTTP %d", err, response.Code)
		}
		if result.Valid != (len(result.Problems) == 0) {
			t.Fatalf("validation result contradicts problems: %#v", result)
		}
		return result.Problems
	}
	base := workflow{Nodes: []workflowNode{
		{ID: "start", Type: "trigger", Data: workflowNodeData{Label: "Start"}},
		{ID: "build", Type: "agent-task", Data: workflowNodeData{Label: "Build", AgentID: harness.reviewer.ID}},
		{ID: "merge", Type: "integrate", Data: workflowNodeData{Label: "Integrate"}},
	}, Edges: []workflowEdge{
		{ID: "a", Source: "start", Target: "build"}, {ID: "b", Source: "build", Target: "merge"},
	}}
	problems := validate(base)
	if !strings.Contains(strings.Join(problems, " "), "lacks code.write") {
		t.Fatalf("ineligible profile problems = %v", problems)
	}

	unsupported := base
	unsupported.Nodes = append(append([]workflowNode{}, base.Nodes...), workflowNode{ID: "condition", Type: "condition", Data: workflowNodeData{Label: "Condition"}})
	unsupported.Edges = append(append([]workflowEdge{}, base.Edges...), workflowEdge{ID: "c", Source: "merge", Target: "condition"})
	problems = validate(unsupported)
	if !strings.Contains(strings.Join(problems, " "), "design-only") {
		t.Fatalf("unsupported node problems = %v", problems)
	}

	cycle := base
	cycle.Edges = append(append([]workflowEdge{}, base.Edges...), workflowEdge{ID: "c", Source: "merge", Target: "build"})
	problems = validate(cycle)
	if !strings.Contains(strings.Join(problems, " "), "cycle") {
		t.Fatalf("cycle problems = %v", problems)
	}

	definition.Nodes, definition.Edges = unsupported.Nodes, unsupported.Edges
	saveBody, err := json.Marshal(struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Status      string         `json:"status"`
		Nodes       []workflowNode `json:"nodes"`
		Edges       []workflowEdge `json:"edges"`
	}{definition.Name, definition.Description, definition.Status, definition.Nodes, definition.Edges})
	if err != nil {
		t.Fatal(err)
	}
	saved := harness.call(http.MethodPut, "/api/v1/workflows/"+definition.ID, string(saveBody))
	if saved.Code != http.StatusOK {
		t.Fatalf("save unsupported workflow returned HTTP %d: %s", saved.Code, saved.Body)
	}
	body, err := json.Marshal(struct {
		ProjectID  string `json:"project_id"`
		WorkflowID string `json:"workflow_id"`
	}{testProjectID, definition.ID})
	if err != nil {
		t.Fatal(err)
	}
	_, response := harness.propose(string(body))
	responseBody, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusBadRequest || !strings.Contains(string(responseBody), "design-only") {
		t.Fatalf("unsupported workflow proposal returned HTTP %d: %s (read error %v)", response.StatusCode, responseBody, err)
	}
	if plans := decodeList[objectivePlan](t, harness.call(http.MethodGet, "/api/v1/objectives/"+harness.objectiveID+"/plans", "")); len(plans) != 0 {
		t.Fatalf("invalid workflow persisted a plan: %#v", plans)
	}
}

func TestMergeGateRemainsDesignOnly(t *testing.T) {
	definition := workflow{Nodes: []workflowNode{
		{ID: "start", Type: "trigger", Data: workflowNodeData{Label: "Start"}},
		{ID: "build", Type: "agent-task", Data: workflowNodeData{Label: "Build", AgentID: strings.Repeat("a", 32)}},
		{ID: "merge", Type: "merge-gate", Data: workflowNodeData{Label: "Merge gate"}},
	}, Edges: []workflowEdge{{ID: "a", Source: "start", Target: "build"}, {ID: "b", Source: "build", Target: "merge"}}}
	agents := map[string]agentProfile{strings.Repeat("a", 32): {ID: strings.Repeat("a", 32), Provider: workerapi.ProviderCodex,
		Status: "active", Tools: []string{"code.write"}}}
	if _, problems := compileWorkflow(definition, agents); !strings.Contains(strings.Join(problems, " "), "design-only") {
		t.Fatalf("merge-gate should be rejected as design-only; problems = %v", problems)
	}
}

func TestPlannerWorkflowGuidanceRejectsOversizedDefinition(t *testing.T) {
	definition := workflow{ID: "workflow-1", Name: "Large workflow", Version: 1}
	for index := 0; index < 10; index++ {
		definition.Nodes = append(definition.Nodes, workflowNode{ID: fmt.Sprintf("node-%d", index), Type: "agent-task",
			Data: workflowNodeData{Label: fmt.Sprintf("Step %d", index), Description: strings.Repeat("x", 500)}})
	}
	if _, err := plannerWorkflowGuidance(definition); err == nil ||
		!strings.Contains(err.Error(), "planner guidance limit") {
		t.Fatalf("oversized planner guidance error = %v, want explicit size limit", err)
	}
}
