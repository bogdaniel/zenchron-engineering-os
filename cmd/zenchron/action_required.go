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
		items = append(items, actionRequiredItem{ID: "plan:" + objectiveID + ":" + strconv.Itoa(plan.Revision),
			Kind: actionPlanApproval, ObjectiveID: objectiveID, ObjectiveTitle: item.Title, PlanRevision: plan.Revision,
			Stage: "Plan approval", Subject: plan.Summary,
			Reason: "This proposed revision needs approval before work can start.", Options: []string{}})
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
			items = append(items, actionRequiredItem{ID: message.ID, Kind: actionDecision, ObjectiveID: graph.ObjectiveID,
				ObjectiveTitle: graph.ObjectiveTitle, PlanRevision: graph.PlanRevision, GraphID: graph.ID,
				UnitKey: message.From, Stage: stage, UnitTitle: title,
				RunID: message.RunID, Subject: message.Body, Reason: reason,
				Options: append([]string{}, message.Notes...)})
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
