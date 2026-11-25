package main

import (
	"cmp"
	"net/http"
	"slices"
	"strconv"
)

const (
	actionPlanApproval = "plan_approval"
	actionDecision     = "work_graph_decision"
	actionPublication  = "publication_authorization"
)

type actionRequiredItem struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	ObjectiveID    string   `json:"objective_id"`
	ObjectiveTitle string   `json:"objective_title"`
	PlanRevision   int      `json:"plan_revision"`
	GraphID        string   `json:"graph_id,omitempty"`
	UnitKey        string   `json:"unit_key,omitempty"`
	Stage          string   `json:"stage"`
	UnitTitle      string   `json:"unit_title,omitempty"`
	RunID          string   `json:"run_id,omitempty"`
	Subject        string   `json:"subject"`
	Reason         string   `json:"reason"`
	Options        []string `json:"options"`
	CanAct         bool     `json:"can_act"`
	ActionBlocker  string   `json:"action_blocker,omitempty"`
}

// actionRequired projects current human work from the existing plans and WorkGraphs. The plan and
// decision endpoints remain the only owners of authorization and mutation.
func (store *workGraphStore) actionRequired(w http.ResponseWriter, r *http.Request) {
	store.reconcileAll()
	access := accessFor(r)
	items := make([]actionRequiredItem, 0)
	store.mu.Lock()
	for objectiveID, plans := range store.plans {
		item, exists := store.objectives.get(objectiveID)
		visible := exists && store.objectives.visible(access, item)
		if !visible || len(plans) == 0 {
			continue
		}
		plan := plans[len(plans)-1]
		if plan.Status != planProposed || !access.allows(plan.Repository) {
			continue
		}
		project, online := store.runs.registry.onlineProject(plan.ProjectID)
		canAct := online && access.allows(project.GitRemote) && access.mayDispatchTo(project.WorkerID)
		blocker := ""
		if !online {
			blocker = "The plan's worker is offline."
		} else if !access.allows(project.GitRemote) {
			blocker = "Your current access does not include the plan's current repository."
		} else if !canAct {
			blocker = "Your current access cannot dispatch work to the plan's worker."
		}
		items = append(items, actionRequiredItem{ID: "plan:" + objectiveID + ":" + strconv.Itoa(plan.Revision),
			Kind: actionPlanApproval, ObjectiveID: objectiveID, ObjectiveTitle: item.Title, PlanRevision: plan.Revision,
			Stage: "Plan approval", Subject: plan.Summary,
			Reason: "This proposed revision needs approval before work can start.", Options: []string{},
			CanAct: canAct, ActionBlocker: blocker})
	}
	for _, graph := range store.graphs {
		if graph.Status == graphCancelled || !store.mayRead(access, graph) {
			continue
		}
		resolved := make(map[string]bool)
		for _, message := range graph.Messages {
			if message.Type == messageDecisionResolution {
				resolved[message.Resolves] = true
			}
		}
		for _, message := range graph.Messages {
			if message.Type != messageDecisionRequest || resolved[message.ID] {
				continue
			}
			unit := graph.unit(message.From)
			stage, title, reason := "stage", "", "Not recorded"
			if unit != nil {
				stage, title = unit.Kind, unit.Title
				reason = cmp.Or(unit.Reason, reason)
			}
			canAct := access.mayDispatchTo(graph.WorkerID)
			blocker := ""
			if !canAct {
				blocker = "Your current access cannot dispatch work to this graph's worker."
			}
			items = append(items, actionRequiredItem{ID: message.ID, Kind: actionDecision, ObjectiveID: graph.ObjectiveID,
				ObjectiveTitle: graph.ObjectiveTitle, PlanRevision: graph.PlanRevision, GraphID: graph.ID,
				UnitKey: message.From, Stage: stage, UnitTitle: title,
				RunID: message.RunID, Subject: message.Body, Reason: reason,
				Options: append([]string{}, message.Notes...), CanAct: canAct, ActionBlocker: blocker})
		}
		for index := range graph.Units {
			unit := &graph.Units[index]
			if !unit.PublicationAuthorizationRequired || len(unit.RunIDs) == 0 {
				continue
			}
			canAct := access.allows(graph.Repository) && access.mayDispatchTo(graph.WorkerID)
			blocker := ""
			if !access.allows(graph.Repository) {
				blocker = "Your current access does not include this repository."
			} else if !canAct {
				blocker = "Your current access cannot dispatch work to this graph's worker."
			}
			items = append(items, actionRequiredItem{ID: "publication:" + graph.ID + ":" + unit.Candidate,
				Kind: actionPublication, ObjectiveID: graph.ObjectiveID, ObjectiveTitle: graph.ObjectiveTitle,
				PlanRevision: graph.PlanRevision, GraphID: graph.ID, UnitKey: unit.Key, Stage: "Publication authorization",
				UnitTitle: unit.Title, RunID: unit.RunIDs[len(unit.RunIDs)-1], Subject: unit.Candidate,
				Reason:  "The current candidate passed its assigned independent review; a person must authorize PR creation.",
				Options: []string{"Authorize pull request creation"}, CanAct: canAct, ActionBlocker: blocker})
		}
	}
	slices.SortFunc(items, func(a, b actionRequiredItem) int {
		if order := cmp.Compare(a.ObjectiveTitle, b.ObjectiveTitle); order != 0 {
			return order
		}
		return cmp.Compare(a.ID, b.ID)
	})
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, items)
}
