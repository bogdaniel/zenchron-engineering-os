package main

import (
	"net/http"
	"slices"
	"strings"
)

// productEnvironment is the engineering world of one product: its repositories and, by reference, the
// objectives, plans, work graphs, decisions, and pull requests that belong to it. It is a projection of
// records owned elsewhere and stores nothing of its own, so one product can never carry another's work.
type productEnvironment struct {
	ProductID     string                 `json:"product_id"`
	Name          string                 `json:"name"`
	Description   string                 `json:"description"`
	RepositoryIDs []string               `json:"repository_ids"`
	Objectives    []environmentObjective `json:"objectives"`
	Decisions     []environmentDecision  `json:"decisions"`
}

// environmentObjective names an objective of the product and where its execution stands.
type environmentObjective struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Status        string `json:"status"`
	PlanRevisions int    `json:"plan_revisions"`
	// GraphID, GraphStatus and the counts describe the objective's newest work graph, when it has one.
	GraphID        string `json:"graph_id,omitempty"`
	GraphStatus    string `json:"graph_status,omitempty"`
	PlanRevision   int    `json:"plan_revision,omitzero"`
	Handoffs       int    `json:"handoffs,omitzero"`
	Findings       int    `json:"findings,omitzero"`
	PullRequestURL string `json:"pull_request_url,omitempty"`
}

// environmentDecision names a decision asked within the product and whether a person answered it.
type environmentDecision struct {
	GraphID     string `json:"graph_id"`
	GraphStatus string `json:"graph_status"`
	MessageID   string `json:"message_id"`
	ObjectiveID string `json:"objective_id"`
	Unit        string `json:"unit"`
	Question    string `json:"question"`
	ResolvedBy  string `json:"resolved_by,omitempty"`
}

// environment answers GET /api/v1/products/{id}/environment. A product the caller may not see is
// reported exactly like one that does not exist, and so is everything in it the caller may not see.
func (store *workGraphStore) environment(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
	item, exists := store.objectives.products.get(strings.ToLower(r.PathValue("id")))
	if !exists || !item.visible(access) {
		http.NotFound(w, r)
		return
	}
	environment := productEnvironment{ProductID: item.ID, Name: item.Name, Description: item.Description,
		RepositoryIDs: item.RepositoryIDs, Objectives: []environmentObjective{}, Decisions: []environmentDecision{}}
	objectives := store.objectives.ofProduct(item.ID)
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, objective := range objectives {
		if !store.objectives.visible(access, objective) {
			continue
		}
		entry := environmentObjective{ID: objective.ID, Title: objective.Title, Status: objective.Status}
		for _, plan := range store.plans[objective.ID] {
			if access.allows(plan.Repository) {
				entry.PlanRevisions++
			}
		}
		if graph := store.newestGraphLocked(access, objective.ID); graph != nil {
			entry.GraphID, entry.GraphStatus, entry.PlanRevision = graph.ID, graph.Status, graph.PlanRevision
			for _, message := range graph.Messages {
				switch message.Type {
				case messageHandoff:
					entry.Handoffs++
				case messageFinding:
					entry.Findings++
				case messageDecisionRequest:
					environment.Decisions = append(environment.Decisions, environmentDecision{GraphID: graph.ID, MessageID: message.ID,
						GraphStatus: graph.Status, ObjectiveID: objective.ID, Unit: message.From, Question: message.Body,
						ResolvedBy: graph.resolvedBy(message.ID)})
				}
			}
			for _, unit := range graph.Units {
				entry.PullRequestURL = max(entry.PullRequestURL, unit.PullRequestURL)
			}
		}
		environment.Objectives = append(environment.Objectives, entry)
	}
	slices.SortFunc(environment.Objectives, func(a, b environmentObjective) int { return strings.Compare(a.ID, b.ID) })
	writeJSON(w, http.StatusOK, environment)
}

// newestGraphLocked returns the newest work graph of an objective that the caller may read.
func (store *workGraphStore) newestGraphLocked(access requestAccess, objectiveID string) *workGraph {
	var newest *workGraph
	for _, graph := range store.graphs {
		if graph.ObjectiveID == objectiveID && store.mayRead(access, graph) && (newest == nil || graph.CreatedAt.After(newest.CreatedAt)) {
			newest = graph
		}
	}
	return newest
}

// resolvedBy returns who answered a decision request, or nothing while it is open.
func (graph *workGraph) resolvedBy(requestID string) string {
	for _, message := range graph.Messages {
		if message.Type == messageDecisionResolution && message.Resolves == requestID {
			return message.By
		}
	}
	return ""
}
