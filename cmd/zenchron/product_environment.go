package main

import (
	"net/http"
	"slices"
	"strings"
	"time"
)

// productEnvironment is the engineering world of one product: its repositories and, by reference, the
// objectives, plans, work graphs, decisions, and pull requests that belong to it. It is a projection of
// records owned elsewhere and stores nothing of its own, so one product can never carry another's work.
type productEnvironment struct {
	ProductID             string                             `json:"product_id"`
	Name                  string                             `json:"name"`
	Description           string                             `json:"description"`
	ConfigurationRevision int                                `json:"configuration_revision"`
	ConfigurationHistory  []productConfigurationRevisionView `json:"configuration_history"`
	ConfigurationComplete bool                               `json:"configuration_history_complete"`
	RepositoryIDs         []string                           `json:"repository_ids"`
	Objectives            []environmentObjective             `json:"objectives"`
	Decisions             []environmentDecision              `json:"decisions"`
	History               []environmentGraph                 `json:"history"`
}

type productConfigurationRevisionView struct {
	Revision             int       `json:"revision"`
	Name                 string    `json:"name"`
	Description          string    `json:"description"`
	RepositoryIDs        []string  `json:"repository_ids"`
	DefaultWorkflowID    string    `json:"default_workflow_id,omitempty"`
	ChangedBy            string    `json:"changed_by,omitempty"`
	ChangedAt            time.Time `json:"changed_at"`
	RepositoriesRedacted bool      `json:"repositories_redacted,omitempty"`
}

// environmentGraph is a product-scoped reference to a durable execution record, without copying its evidence.
type environmentGraph struct {
	ID                           string                  `json:"id"`
	ObjectiveID                  string                  `json:"objective_id"`
	PlanRevision                 int                     `json:"plan_revision"`
	PlanHash                     string                  `json:"plan_hash"`
	ProductConfigurationRevision int                     `json:"product_configuration_revision,omitempty"`
	WorkflowID                   string                  `json:"workflow_id,omitempty"`
	WorkflowVersion              int                     `json:"workflow_version,omitempty"`
	WorkflowMode                 string                  `json:"workflow_mode,omitempty"`
	Assignments                  []environmentAssignment `json:"assignments"`
	Revision                     int                     `json:"revision"`
	Status                       string                  `json:"status"`
	CreatedAt                    time.Time               `json:"created_at"`
	UpdatedAt                    time.Time               `json:"updated_at"`
	RunIDs                       []string                `json:"run_ids"`
	Handoffs                     int                     `json:"handoffs"`
	Findings                     int                     `json:"findings"`
	PullRequestURL               string                  `json:"pull_request_url,omitempty"`
}

// environmentAssignment references the immutable profile and persona revisions captured by a plan unit.
type environmentAssignment struct {
	Unit           string `json:"unit"`
	AgentID        string `json:"agent_id"`
	ProfileVersion int    `json:"profile_version"`
	PersonaID      string `json:"persona_id,omitempty"`
	PersonaVersion int    `json:"persona_version,omitempty"`
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
	configurationHistory, configurationComplete := item.configurationHistoryFor(access)
	environment := productEnvironment{ProductID: item.ID, Name: item.Name, Description: item.Description,
		ConfigurationRevision: item.configurationRevision(), ConfigurationHistory: configurationHistory,
		ConfigurationComplete: configurationComplete,
		RepositoryIDs:         item.RepositoryIDs, Objectives: []environmentObjective{}, Decisions: []environmentDecision{},
		History: []environmentGraph{}}
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
		planConfigurationRevisions := make(map[int]int, len(store.plans[objective.ID]))
		for _, plan := range store.plans[objective.ID] {
			planConfigurationRevisions[plan.Revision] = plan.ProductConfigurationRevision
		}
		var newest environmentGraph
		hasNewest := false
		// ponytail: scans the bounded 100-graph store per objective; index by objective if retention grows.
		for _, graph := range store.graphs {
			if graph.ObjectiveID != objective.ID || !store.mayRead(access, graph) {
				continue
			}
			reference := environmentGraph{ID: graph.ID, ObjectiveID: objective.ID, PlanRevision: graph.PlanRevision,
				PlanHash:                     graph.PlanHash,
				ProductConfigurationRevision: planConfigurationRevisions[graph.PlanRevision],
				WorkflowID:                   graph.WorkflowID, WorkflowVersion: graph.WorkflowVersion,
				WorkflowMode: graph.WorkflowMode, Revision: graph.Revision, Status: graph.Status,
				CreatedAt: graph.CreatedAt, UpdatedAt: graph.UpdatedAt, RunIDs: []string{},
				Assignments: []environmentAssignment{}}
			for _, unit := range graph.Units {
				reference.RunIDs = append(reference.RunIDs, unit.RunIDs...)
				reference.PullRequestURL = max(reference.PullRequestURL, unit.PullRequestURL)
				if unit.AgentID != "" {
					reference.Assignments = append(reference.Assignments, environmentAssignment{Unit: unit.Key,
						AgentID: unit.AgentID, ProfileVersion: unit.ProfileVersion, PersonaID: unit.PersonaID,
						PersonaVersion: unit.PersonaVersion})
				}
			}
			for _, message := range graph.Messages {
				switch message.Type {
				case messageHandoff:
					reference.Handoffs++
				case messageFinding:
					reference.Findings++
				case messageDecisionRequest:
					environment.Decisions = append(environment.Decisions, environmentDecision{GraphID: graph.ID, MessageID: message.ID,
						GraphStatus: graph.Status, ObjectiveID: objective.ID, Unit: message.From, Question: message.Body,
						ResolvedBy: graph.resolvedBy(message.ID)})
				}
			}
			environment.History = append(environment.History, reference)
			if !hasNewest || reference.CreatedAt.After(newest.CreatedAt) ||
				(reference.CreatedAt.Equal(newest.CreatedAt) && reference.ID < newest.ID) {
				newest, hasNewest = reference, true
			}
		}
		if hasNewest {
			entry.GraphID, entry.GraphStatus, entry.PlanRevision = newest.ID, newest.Status, newest.PlanRevision
			entry.Handoffs, entry.Findings, entry.PullRequestURL = newest.Handoffs, newest.Findings, newest.PullRequestURL
		}
		environment.Objectives = append(environment.Objectives, entry)
	}
	slices.SortFunc(environment.Objectives, func(a, b environmentObjective) int { return strings.Compare(a.ID, b.ID) })
	slices.SortFunc(environment.History, func(a, b environmentGraph) int {
		if order := b.CreatedAt.Compare(a.CreatedAt); order != 0 {
			return order
		}
		return strings.Compare(a.ID, b.ID)
	})
	writeJSON(w, http.StatusOK, environment)
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
