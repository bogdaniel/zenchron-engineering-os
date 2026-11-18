package main

import (
	"cmp"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// localOperator names the person acting on a loopback control plane without sign-in.
const localOperator = "local operator"

func (store *workGraphStore) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/objectives/{id}/plans", store.listPlans)
	mux.HandleFunc("POST /api/v1/objectives/{id}/plans", store.proposePlan)
	mux.HandleFunc("POST /api/v1/objectives/{id}/plans/{revision}/approve", store.approvePlan)
	mux.HandleFunc("GET /api/v1/work-graphs", store.listGraphs)
	mux.HandleFunc("GET /api/v1/work-graphs/{id}/report", store.reportGraph)
	mux.HandleFunc("GET /api/v1/products/{id}/environment", store.environment)
	mux.HandleFunc("POST /api/v1/work-graphs/{id}/cancel", store.cancelGraph)
	mux.HandleFunc("POST /api/v1/work-graphs/{id}/units/{key}/retry", store.retryUnit)
	mux.HandleFunc("POST /api/v1/work-graphs/{id}/decisions/{message}", store.resolveDecision)
}

// visibleObjective returns the objective named in the path, or answers 404 exactly as for one that
// does not exist when the caller may not see it.
func (store *workGraphStore) visibleObjective(w http.ResponseWriter, r *http.Request) (objective, bool) {
	item, exists := store.objectives.get(strings.ToLower(r.PathValue("id")))
	if !exists || !store.objectives.visible(accessFor(r), item) {
		http.NotFound(w, r)
		return objective{}, false
	}
	return item, true
}

func (store *workGraphStore) agentProfiles() map[string]agentProfile {
	store.agents.mu.RLock()
	defer store.agents.mu.RUnlock()
	profiles := make(map[string]agentProfile, len(store.agents.items))
	for id, profile := range store.agents.items {
		if persona, exists := store.agents.personas[profile.PersonaID]; profile.PersonaID != "" && exists {
			persona.Responsibilities = append([]string{}, persona.Responsibilities...)
			profile.PersonaSnapshot = &persona
		}
		profiles[id] = profile
	}
	return profiles
}

func (store *workGraphStore) listPlans(w http.ResponseWriter, r *http.Request) {
	item, ok := store.visibleObjective(w, r)
	if !ok {
		return
	}
	store.reconcileAll()
	access := accessFor(r)
	store.mu.Lock()
	// A plan names files and work of its repository, so it is shown only to callers granted that repository.
	plans := slices.DeleteFunc(append([]objectivePlan{}, store.plans[item.ID]...), func(plan objectivePlan) bool {
		return !access.allows(plan.Repository)
	})
	for index := range plans {
		plans[index].ProfileSnapshots = nil
	}
	slices.Reverse(plans)
	body := encodeResponse(plans)
	store.mu.Unlock()
	writeEncoded(w, http.StatusOK, body)
}

// proposePlan records a new plan revision for an objective. The body either carries the plan itself or
// names a read-only agent profile that plans it; both go through the same validation, and neither
// starts any work.
func (store *workGraphStore) proposePlan(w http.ResponseWriter, r *http.Request) {
	item, ok := store.visibleObjective(w, r)
	if !ok {
		return
	}
	var input struct {
		ProjectID      string        `json:"project_id"`
		WorkflowID     string        `json:"workflow_id"`
		PlannerAgentID string        `json:"planner_agent_id"`
		Plan           *planProposal `json:"plan"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	access := accessFor(r)
	project, online := store.runs.registry.onlineProject(strings.ToLower(input.ProjectID))
	if !online || !access.allows(project.GitRemote) || !access.mayDispatchTo(project.WorkerID) {
		http.Error(w, "project_id does not identify an online checkout you may dispatch work to", http.StatusConflict)
		return
	}
	var definition *workflow
	if input.WorkflowID != "" {
		item, exists := store.savedWorkflow(input.WorkflowID)
		if !exists {
			http.Error(w, "workflow_id does not identify a saved workflow", http.StatusBadRequest)
			return
		}
		definition = &item
	}
	if input.Plan != nil && definition != nil {
		http.Error(w, "manual plans cannot claim a workflow; omit plan to compile it or select planner guidance", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	full := len(store.plans[item.ID]) >= maxPlanRevisions
	store.mu.Unlock()
	if full {
		http.Error(w, "this objective reached its limit of plan revisions", http.StatusConflict)
		return
	}
	plan := objectivePlan{ObjectiveID: item.ID, ProjectID: project.ID, Repository: project.GitRemote, WorkflowID: input.WorkflowID,
		Status: planProposed, CreatedBy: access.user, CreatedAt: time.Now().UTC()}
	if definition != nil {
		plan.WorkflowVersion = definition.Version
	}
	switch {
	case input.Plan != nil && input.PlannerAgentID == "":
		profiles := store.agentProfiles()
		snapshots, pinProblems := pinPlanProfiles(input.Plan, profiles)
		problems := append(pinProblems, input.Plan.problems(profiles)...)
		if len(problems) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string][]string{"problems": problems})
			return
		}
		plan.planProposal, plan.ProfileSnapshots = *input.Plan, snapshots
		plan.Hash = planHash(project.ID, input.WorkflowID, plan.WorkflowVersion, plan.WorkflowMode, *input.Plan)
	case input.Plan == nil && input.PlannerAgentID == "" && definition != nil:
		profiles := store.agentProfiles()
		proposal, problems := compileWorkflow(*definition, profiles)
		if len(problems) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string][]string{"problems": problems})
			return
		}
		plan.ProfileSnapshots, problems = pinPlanProfiles(&proposal, profiles)
		if problems = append(problems, proposal.problems(profiles)...); len(problems) > 0 {
			writeJSON(w, http.StatusBadRequest, map[string][]string{"problems": problems})
			return
		}
		plan.planProposal = proposal
		plan.WorkflowMode = workflowModeCompiled
		plan.Hash = planHash(project.ID, input.WorkflowID, plan.WorkflowVersion, plan.WorkflowMode, proposal)
	case input.Plan == nil && input.PlannerAgentID != "":
		guidance := ""
		if definition != nil {
			var err error
			guidance, err = plannerWorkflowGuidance(*definition)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			plan.WorkflowMode = workflowModeGuidance
		}
		run, status, message := store.queuePlanner(item, project, strings.ToLower(input.PlannerAgentID), access.user, guidance)
		if status != 0 {
			http.Error(w, message, status)
			return
		}
		plan.Status, plan.PlannerRunID = planPlanning, run.ID
	default:
		http.Error(w, "provide either plan or planner_agent_id", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	// A plan identical to the one already approved and still executing needs no second approval.
	if approved, executing := store.executingPlanLocked(item.ID); executing && plan.Hash != "" && approved.Hash == plan.Hash {
		writeJSON(w, http.StatusOK, publicPlan(approved))
		return
	}
	plan.Revision = len(store.plans[item.ID]) + 1
	store.plans[item.ID] = append(store.plans[item.ID], plan)
	if err := store.persistLocked(); err != nil {
		store.plans[item.ID] = store.plans[item.ID][:plan.Revision-1]
		http.Error(w, "could not persist the plan", http.StatusInternalServerError)
		return
	}
	plan.ProfileSnapshots = nil
	writeJSON(w, http.StatusCreated, plan)
}

// queuePlanner queues the run in which a read-only agent proposes a plan for the objective.
func (store *workGraphStore) queuePlanner(item objective, project projectRecord, agentID, user, workflowGuidance string) (agentRun, int, string) {
	profile, exists := store.agentProfiles()[agentID]
	if !exists || profile.Status != "active" || !workerapi.IsCLIProvider(profile.Provider) || slices.Contains(profile.Tools, "code.write") {
		return agentRun{}, http.StatusConflict, "planner_agent_id must name an active, read-only Codex or Claude Code profile"
	}
	prompt := "Plan the engineering work for this objective: " + item.Title
	if workflowGuidance != "" {
		prompt += "\n\n" + workflowGuidance
	}
	return store.runs.enqueue(agentRun{AgentID: profile.ID, AgentName: profile.Name, ProjectID: project.ID,
		ProjectName: project.Name, Repository: project.GitRemote, BaseBranch: project.Branch, WorkerID: project.WorkerID,
		WorkerName: project.WorkerName, Provider: profile.Provider, Profile: &profile, CreatedBy: user,
		Prompt: truncateUTF8(prompt, 5000)})
}

// executingPlanLocked returns the approved plan of an objective whose graph has not finished.
func (store *workGraphStore) executingPlanLocked(objectiveID string) (objectivePlan, bool) {
	for _, plan := range store.plans[objectiveID] {
		if graph := store.graphs[plan.GraphID]; plan.Status == planApproved && graph != nil &&
			graph.Status != graphCompleted && graph.Status != graphCancelled {
			return plan, true
		}
	}
	return objectivePlan{}, false
}

// admitPlansLocked turns finished planning runs into proposals. A planner's output is only a proposal:
// it is validated like an operator's plan and still needs approval.
func (store *workGraphStore) admitPlansLocked() bool {
	changed := false
	for objectiveID, plans := range store.plans {
		for index := range plans {
			plan := &store.plans[objectiveID][index]
			if plan.Status != planPlanning {
				continue
			}
			run, exists := store.runs.get(plan.PlannerRunID)
			if exists && activeRun(run) {
				continue
			}
			changed = true
			result, err := parseUnitResult(run.Result)
			switch {
			case !exists || run.Status != "succeeded":
				plan.Status, plan.Problems = planInvalid, []string{"The planning run did not finish: " + cmp.Or(run.Error, run.Status, "it no longer exists") + "."}
			case err != nil || result.Plan == nil:
				plan.Status, plan.Problems = planInvalid, []string{"The planner reported no plan: " + cmp.Or(errorText(err), "the result carried none") + "."}
			default:
				plan.planProposal, plan.Status = *result.Plan, planProposed
				profiles := store.agentProfiles()
				plan.ProfileSnapshots, plan.Problems = pinPlanProfiles(&plan.planProposal, profiles)
				plan.Problems = append(plan.Problems, plan.planProposal.problems(profiles)...)
				if len(plan.Problems) > 0 {
					plan.Status = planInvalid
				}
				plan.Hash = planHash(plan.ProjectID, plan.WorkflowID, plan.WorkflowVersion, plan.WorkflowMode, plan.planProposal)
			}
		}
	}
	return changed
}

// approvePlan turns the latest valid proposal into a WorkGraph and starts it. A changed plan is never
// applied to a graph that is still executing: that graph has to be cancelled first, so work admitted
// under the accepted plan is not silently rewritten.
func (store *workGraphStore) approvePlan(w http.ResponseWriter, r *http.Request) {
	item, ok := store.visibleObjective(w, r)
	if !ok {
		return
	}
	revision, err := strconv.Atoi(r.PathValue("revision"))
	graphID, idErr := newHexID()
	if err != nil || idErr != nil {
		http.Error(w, "plan revision is invalid", http.StatusBadRequest)
		return
	}
	access := accessFor(r)
	profiles := store.agentProfiles()
	store.mu.Lock()
	plans := store.plans[item.ID]
	if revision < 1 || revision > len(plans) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	plan := &plans[revision-1]
	project, online := store.runs.registry.onlineProject(plan.ProjectID)
	_, executing := store.executingPlanLocked(item.ID)
	problem := ""
	switch {
	case plan.Status == planApproved && store.graphs[plan.GraphID] != nil && store.mayRead(access, store.graphs[plan.GraphID]):
		// Approving an approved plan again changes nothing.
		body := encodeResponse(store.graphs[plan.GraphID])
		store.mu.Unlock()
		writeEncoded(w, http.StatusOK, body)
		return
	case revision != len(plans) || plan.Status != planProposed:
		problem = "only the latest valid proposal can be approved"
	case executing:
		problem = "this objective already has a plan executing; cancel its work graph before approving a changed plan"
	case len(store.graphs) >= maxWorkGraphs:
		problem = "work graph history is full"
	case !online || !access.allows(project.GitRemote) || !access.mayDispatchTo(project.WorkerID):
		problem = "the plan's project is offline or you may not dispatch work to its worker"
	case len(plan.planProposal.problems(profiles)) > 0:
		problem = "the plan is no longer valid: " + strings.Join(plan.planProposal.problems(profiles), "; ")
	}
	if problem != "" {
		store.mu.Unlock()
		http.Error(w, problem, http.StatusConflict)
		return
	}
	now := time.Now().UTC()
	graph := &workGraph{ID: graphID, ObjectiveID: item.ID, ObjectiveTitle: item.Title, PlanRevision: plan.Revision,
		PlanHash: plan.Hash, Revision: 1, Status: graphActive, ProjectID: project.ID, ProjectName: project.Name,
		Repository: project.GitRemote, WorkerID: project.WorkerID, WorkerName: project.WorkerName, BaseBranch: project.Branch,
		WorkflowID: plan.WorkflowID, WorkflowVersion: plan.WorkflowVersion, WorkflowMode: plan.WorkflowMode,
		MaxParallel: plan.MaxParallel, Messages: []graphMessage{},
		CreatedBy: access.user, CreatedAt: now, UpdatedAt: now}
	for _, unit := range plan.Units {
		graph.Units = append(graph.Units, workUnit{planUnit: unit, AgentName: profiles[unit.AgentID].Name,
			State: unitWaiting, RunIDs: []string{}})
	}
	for index := range plans {
		if plans[index].Status == planApproved {
			plans[index].Status = planSuperseded
		}
	}
	plan.Status, plan.GraphID, plan.ApprovedBy, plan.ApprovedAt = planApproved, graph.ID, cmp.Or(access.user, localOperator), &now
	store.graphs[graph.ID] = graph
	if err := store.persistLocked(); err != nil {
		delete(store.graphs, graph.ID)
		plan.Status, plan.GraphID, plan.ApprovedBy, plan.ApprovedAt = planProposed, "", "", nil
		store.mu.Unlock()
		http.Error(w, "could not persist the work graph", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	store.reconcileAll()
	store.writeGraph(w, http.StatusCreated, graph.ID)
}

func newHexID() (string, error) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return "", err
	}
	return hex.EncodeToString(id), nil
}

// encodeResponse encodes a value while the caller holds the store lock. Graphs are changed in place by
// every reconcile, so a response is never encoded from a graph after the lock is released.
func encodeResponse(value any) []byte {
	// Plans and graphs hold only strings, numbers, times, and slices of them, which always encode.
	body, _ := json.Marshal(value)
	return body
}

func publicPlan(plan objectivePlan) objectivePlan {
	plan.ProfileSnapshots = nil
	return plan
}

func writeEncoded(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

func (store *workGraphStore) writeGraph(w http.ResponseWriter, status int, graphID string) {
	store.mu.Lock()
	body := encodeResponse(store.graphs[graphID])
	store.mu.Unlock()
	writeEncoded(w, status, body)
}

func (store *workGraphStore) listGraphs(w http.ResponseWriter, r *http.Request) {
	store.reconcileAll()
	access := accessFor(r)
	store.mu.Lock()
	graphs := make([]*workGraph, 0, len(store.graphs))
	for _, graph := range store.graphs {
		if store.mayRead(access, graph) {
			graphs = append(graphs, graph)
		}
	}
	slices.SortFunc(graphs, func(a, b *workGraph) int { return b.CreatedAt.Compare(a.CreatedAt) })
	body := encodeResponse(graphs)
	store.mu.Unlock()
	writeEncoded(w, http.StatusOK, body)
}

// reportGraph answers the delivery report of one graph from what is already stored. It never
// reconciles or persists, so reading a report cannot change the run it describes.
func (store *workGraphStore) reportGraph(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
	store.mu.Lock()
	stored := store.graphs[strings.ToLower(r.PathValue("id"))]
	if stored == nil || !store.mayRead(access, stored) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	// Units are rewritten in place by later reconciles; messages are immutable and only appended.
	graph := *stored
	graph.Units = slices.Clone(stored.Units)
	var plan *objectivePlan
	if graph.PlanRevision > 0 && graph.PlanRevision <= len(store.plans[graph.ObjectiveID]) {
		approved := store.plans[graph.ObjectiveID][graph.PlanRevision-1]
		plan = &approved
	}
	store.mu.Unlock()
	report := buildDeliveryReport(graph, store.runs.unitRuns(graph.ID), plan)
	report.observePullRequest(r.Context(), graph.Repository, store.runs.registry.github)
	writeJSON(w, http.StatusOK, report)
}

func (store *workGraphStore) mayRead(access requestAccess, graph *workGraph) bool {
	item, exists := store.objectives.get(graph.ObjectiveID)
	return exists && store.objectives.visible(access, item) && access.allows(graph.Repository)
}

// change applies one authorized change to a graph, persists it, and reconciles. Only a signed-in user
// who may see the objective and dispatch work to the graph's worker may change a graph; worker
// credentials are confined to the worker routes and can never reach these handlers.
func (store *workGraphStore) change(w http.ResponseWriter, r *http.Request, apply func(graph *workGraph) (int, string)) {
	store.changeAfterCommit(w, r, apply, nil)
}

func (store *workGraphStore) changeAfterCommit(
	w http.ResponseWriter, r *http.Request, apply func(graph *workGraph) (int, string),
	afterCommit func(graphID string) (int, string),
) {
	access := accessFor(r)
	store.mu.Lock()
	graph := store.graphs[strings.ToLower(r.PathValue("id"))]
	if graph == nil || !store.mayRead(access, graph) {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if !access.mayDispatchTo(graph.WorkerID) {
		store.mu.Unlock()
		http.Error(w, "this work graph runs on another user's worker", http.StatusForbidden)
		return
	}
	updated := *graph
	updated.Units, updated.Messages = slices.Clone(graph.Units), slices.Clone(graph.Messages)
	// A refused change must leave the graph untouched, so apply validates before it mutates.
	if status, message := apply(&updated); status != 0 {
		store.mu.Unlock()
		http.Error(w, message, status)
		return
	}
	updated.Revision, updated.UpdatedAt = updated.Revision+1, time.Now().UTC()
	store.graphs[updated.ID] = &updated
	if err := store.persistLocked(); err != nil {
		store.graphs[graph.ID] = graph
		store.mu.Unlock()
		http.Error(w, "could not persist work graph", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	if afterCommit != nil {
		if status, message := afterCommit(updated.ID); status != 0 {
			http.Error(w, message, status)
			return
		}
	}
	store.reconcileAll()
	store.writeGraph(w, http.StatusOK, updated.ID)
}

// cancelGraph stops a graph: nothing further is queued and its active runs are cancelled.
func (store *workGraphStore) cancelGraph(w http.ResponseWriter, r *http.Request) {
	store.changeAfterCommit(w, r, func(graph *workGraph) (int, string) {
		if graph.Status == graphCompleted || graph.Status == graphCancelled {
			return http.StatusConflict, "the work graph has already finished"
		}
		graph.Status = graphCancelled
		return 0, ""
	}, store.runs.cancelGraphRuns)
}

// retryUnit gives a failed unit a fresh run with fresh attempts.
func (store *workGraphStore) retryUnit(w http.ResponseWriter, r *http.Request) {
	store.change(w, r, func(graph *workGraph) (int, string) {
		unit := graph.unit(r.PathValue("key"))
		if unit == nil || unit.Failure == "" || graph.Status == graphCancelled {
			return http.StatusConflict, "only a failed unit of an unfinished work graph can be retried"
		}
		if len(unit.RunIDs) >= maxUnitRuns {
			return http.StatusConflict, "the unit has used all of its runs and cannot be retried"
		}
		unit.Failure, unit.Restart = "", true
		return 0, ""
	})
}

// resolveDecision records a person's answer to a unit's decision request. The answer is stored as an
// immutable message; the unit resumes on the next reconcile with the answer in its context.
func (store *workGraphStore) resolveDecision(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Resolution string `json:"resolution"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Resolution = strings.TrimSpace(input.Resolution)
	if input.Resolution == "" || len(input.Resolution) > 2000 {
		http.Error(w, "resolution must be between 1 and 2000 bytes", http.StatusBadRequest)
		return
	}
	store.change(w, r, func(graph *workGraph) (int, string) {
		index := slices.IndexFunc(graph.Messages, func(message graphMessage) bool {
			return message.ID == r.PathValue("message") && message.Type == messageDecisionRequest
		})
		if index < 0 {
			return http.StatusNotFound, "decision request not found"
		}
		request := graph.Messages[index]
		if open, undecided := graph.openDecision(request.From); !undecided || open.ID != request.ID || graph.Status == graphCancelled {
			return http.StatusConflict, "this decision is already resolved or its work graph was cancelled"
		}
		graph.add(graphMessage{Type: messageDecisionResolution, From: "operator", To: []string{request.From},
			Resolves: request.ID, By: cmp.Or(accessFor(r).user, localOperator), Body: input.Resolution})
		return 0, ""
	})
}
