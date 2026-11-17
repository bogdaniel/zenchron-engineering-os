package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// ponytail: planner guidance caps at 4 KiB to fit the existing 5 KiB run prompt; raise with that prompt budget.
const maxPlannerWorkflowGuidanceBytes = 4 << 10

func (store *workGraphStore) savedWorkflow(id string) (workflow, bool) {
	store.workflows.mu.RLock()
	defer store.workflows.mu.RUnlock()
	definition, exists := store.workflows.items[id]
	if !exists {
		return workflow{}, false
	}
	definition.Nodes = slices.Clone(definition.Nodes)
	for index := range definition.Nodes {
		definition.Nodes[index].Data.Acceptance = slices.Clone(definition.Nodes[index].Data.Acceptance)
	}
	definition.Edges = slices.Clone(definition.Edges)
	return definition, true
}

func (store *workGraphStore) validateWorkflow(w http.ResponseWriter, r *http.Request) {
	definition, exists := store.savedWorkflow(r.PathValue("id"))
	if !exists {
		http.NotFound(w, r)
		return
	}
	var draft struct {
		Nodes []workflowNode `json:"nodes"`
		Edges []workflowEdge `json:"edges"`
	}
	if !decodeJSONBody(w, r, &draft) {
		return
	}
	definition.Nodes, definition.Edges = draft.Nodes, draft.Edges
	_, problems := compileWorkflow(definition, store.agentProfiles())
	if problems == nil {
		problems = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"valid": len(problems) == 0, "workflow_id": definition.ID,
		"workflow_version": definition.Version, "problems": problems})
}

func plannerWorkflowGuidance(definition workflow) (string, error) {
	snapshot, err := json.Marshal(struct {
		ID          string         `json:"id"`
		Name        string         `json:"name"`
		Version     int            `json:"version"`
		Description string         `json:"description"`
		Nodes       []workflowNode `json:"nodes"`
		Edges       []workflowEdge `json:"edges"`
	}{definition.ID, definition.Name, definition.Version, definition.Description, definition.Nodes, definition.Edges})
	if err != nil {
		return "", fmt.Errorf("encode workflow guidance: %w", err)
	}
	if len(snapshot) > maxPlannerWorkflowGuidanceBytes {
		return "", fmt.Errorf("workflow definition exceeds the %d-byte planner guidance limit", maxPlannerWorkflowGuidanceBytes)
	}
	return "Workflow guidance only; this definition is not a fixed execution contract. Pinned definition:\n" +
		string(snapshot), nil
}

// compileWorkflow turns only the WorkGraph-backed nodes into a normal validated objective plan.
func compileWorkflow(definition workflow, agents map[string]agentProfile) (planProposal, []string) {
	var problems []string
	add := func(message string) { problems = append(problems, message) }
	if !validateWorkflowGraph(definition.Nodes, definition.Edges) {
		return planProposal{}, []string{"workflow graph is invalid"}
	}
	if len(definition.Nodes) > maxPlanUnits+1 {
		add(fmt.Sprintf("workflow may contain at most %d executable nodes plus a trigger", maxPlanUnits))
	}
	nodes := make(map[string]workflowNode, len(definition.Nodes))
	for _, node := range definition.Nodes {
		nodes[node.ID] = node
	}
	triggerCount := 0
	for _, node := range definition.Nodes {
		switch node.Type {
		case "trigger":
			triggerCount++
		case "agent-task", "test-generator", "code-reviewer", "integrate":
		default:
			add(fmt.Sprintf("node %q (%s) is design-only and cannot execute", node.Data.Label, node.Type))
		}
		if len(node.Data.Acceptance) > maxUnitAcceptance || slices.ContainsFunc(node.Data.Acceptance,
			func(value string) bool { return strings.TrimSpace(value) == "" || len(value) > 300 }) {
			add(fmt.Sprintf("node %q must have at most %d acceptance criteria of 1 to 300 bytes", node.Data.Label, maxUnitAcceptance))
		}
	}
	if triggerCount != 1 {
		add("workflow needs exactly one Trigger node")
	}
	if len(problems) > 0 {
		return planProposal{}, problems
	}

	incoming := make(map[string][]string, len(nodes))
	outgoing := make(map[string][]string, len(nodes))
	indegree := make(map[string]int, len(nodes))
	for _, edge := range definition.Edges {
		incoming[edge.Target] = append(incoming[edge.Target], edge.Source)
		outgoing[edge.Source] = append(outgoing[edge.Source], edge.Target)
		indegree[edge.Target]++
	}
	var trigger string
	for id, node := range nodes {
		if node.Type == "trigger" {
			trigger = id
			break
		}
	}
	if len(incoming[trigger]) != 0 || len(outgoing[trigger]) == 0 {
		add("Trigger must be a root connected to an execution node")
	}
	visited := map[string]bool{trigger: true}
	frontier := []string{trigger}
	for len(frontier) > 0 {
		id := frontier[0]
		frontier = frontier[1:]
		for _, next := range outgoing[id] {
			if !visited[next] {
				visited[next] = true
				frontier = append(frontier, next)
			}
		}
	}
	for id, node := range nodes {
		if !visited[id] {
			add(fmt.Sprintf("node %q is not connected to Trigger", node.Data.Label))
		}
	}

	order := make([]string, 0, len(nodes))
	ready := make([]string, 0, len(nodes))
	for id := range nodes {
		if indegree[id] == 0 {
			ready = append(ready, id)
		}
	}
	slices.Sort(ready)
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		order = append(order, id)
		for _, next := range outgoing[id] {
			indegree[next]--
			if indegree[next] == 0 {
				ready = append(ready, next)
				slices.Sort(ready)
			}
		}
	}
	if len(order) != len(nodes) {
		add("workflow connections contain a cycle")
	}
	if len(problems) > 0 {
		return planProposal{}, problems
	}

	proposal := planProposal{Summary: definition.Description, MaxParallel: defaultPlanParallel}
	keyByNode := make(map[string]string, len(nodes))
	for _, id := range order {
		node := nodes[id]
		if node.Type == "trigger" {
			continue
		}
		key := fmt.Sprintf("step-%d", len(proposal.Units)+1)
		keyByNode[id] = key
		unit := planUnit{Key: key, Title: node.Data.Label, Instructions: node.Data.Description,
			Acceptance: append([]string{}, node.Data.Acceptance...)}
		switch node.Type {
		case "agent-task", "test-generator":
			unit.Kind = unitProduce
		case "code-reviewer":
			unit.Kind = unitReview
		case "integrate":
			unit.Kind = unitIntegrate
		}
		if unit.Kind != unitIntegrate {
			profile, reason := workflowAssignedProfile(node.Data, unit.Kind, agents)
			if reason != "" {
				add(fmt.Sprintf("node %q %s", node.Data.Label, reason))
			} else {
				unit.AgentID, unit.PersonaID = profile.ID, profile.PersonaID
			}
		}
		for _, dependency := range incoming[id] {
			if nodes[dependency].Type != "trigger" {
				unit.DependsOn = append(unit.DependsOn, keyByNode[dependency])
			}
		}
		proposal.Units = append(proposal.Units, unit)
	}
	if len(proposal.Units) > 0 {
		producers := 0
		for _, unit := range proposal.Units {
			if unit.Kind == unitProduce {
				producers++
			}
		}
		if producers == 1 {
			proposal.MaxParallel = 1
		}
	}
	if len(problems) > 0 {
		return proposal, problems
	}
	problems = append(problems, proposal.problems(agents)...)
	return proposal, problems
}

func workflowAssignedProfile(data workflowNodeData, kind string, agents map[string]agentProfile) (agentProfile, string) {
	profile, exists := agents[strings.ToLower(strings.TrimSpace(data.AgentID))]
	if data.AgentID == "" && data.PersonaID != "" {
		for _, candidate := range agents {
			if candidate.PersonaID == data.PersonaID && candidate.Status == "active" && workerapi.IsCLIProvider(candidate.Provider) &&
				(kind != unitProduce || slices.Contains(candidate.Tools, "code.write")) &&
				(kind != unitReview || !slices.Contains(candidate.Tools, "code.write")) {
				if exists {
					return agentProfile{}, fmt.Sprintf("selects persona %q, which has more than one eligible profile", data.PersonaID)
				}
				profile, exists = candidate, true
			}
		}
	}
	if !exists {
		return agentProfile{}, "needs an assigned CLI profile or a persona with one eligible profile"
	}
	if data.PersonaID != "" && profile.PersonaID != data.PersonaID {
		return agentProfile{}, fmt.Sprintf("assigns persona %q, but profile %q is bound to %q", data.PersonaID, profile.Name, profile.PersonaID)
	}
	if profile.Status != "active" {
		return agentProfile{}, fmt.Sprintf("is assigned to disabled profile %q", profile.Name)
	}
	if !workerapi.IsCLIProvider(profile.Provider) {
		return agentProfile{}, fmt.Sprintf("is assigned to %q without a Codex or Claude CLI adapter", profile.Name)
	}
	if profile.PersonaID != "" && (profile.PersonaSnapshot == nil || profile.PersonaSnapshot.Status != "active") {
		return agentProfile{}, fmt.Sprintf("is assigned to %q with an unavailable persona", profile.Name)
	}
	if kind == unitProduce && !slices.Contains(profile.Tools, "code.write") {
		return agentProfile{}, fmt.Sprintf("produces code but profile %q lacks code.write", profile.Name)
	}
	if kind == unitReview && slices.Contains(profile.Tools, "code.write") {
		return agentProfile{}, fmt.Sprintf("reviews code but profile %q may write code", profile.Name)
	}
	return profile, ""
}
