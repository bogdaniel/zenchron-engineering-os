package main

import (
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// WorkUnit states, projected from the unit's durable record and its current run on every reconcile.
const (
	unitWaiting   = "waiting"
	unitQueued    = "queued"
	unitRunning   = "running"
	unitBlocked   = "blocked"
	unitCompleted = "completed"
	unitFailed    = "failed"
	unitCancelled = "cancelled"

	graphActive    = "active"
	graphBlocked   = "blocked"
	graphCompleted = "completed"
	graphFailed    = "failed"
	graphCancelled = "cancelled"
)

// Message types are the whole vocabulary units and people use to talk to each other.
const (
	messageHandoff            = "handoff"
	messageCollaboration      = "collaboration_request"
	messageFinding            = "finding"
	messageDecisionRequest    = "decision_request"
	messageDecisionResolution = "decision_resolution"
	messageStateUpdate        = "state_update"
)

const (
	// ponytail: 100 graphs of at most 400 bounded messages fit the 16 MiB snapshot; add retention or a
	// database table when objective history grows past that.
	maxWorkGraphs    = 100
	maxGraphMessages = 400
	// maxUnitRuns bounds how many separate runs a review or integrate unit may start; a produce unit is
	// bounded by the attempts of its one run.
	maxUnitRuns = 6
	// zenchronSender marks messages written by the control plane itself.
	zenchronSender = "zenchron"
)

// workUnit is one responsibility of a WorkGraph and everything admitted about it.
type workUnit struct {
	planUnit
	AgentName string `json:"agent_name,omitempty"`
	State     string `json:"state"`
	// Reason says what a waiting or blocked unit waits for; Failure says why a unit failed.
	Reason  string `json:"reason,omitempty"`
	Failure string `json:"failure,omitempty"`
	// RunIDs are the runs that executed this unit, oldest first; the last one is current.
	RunIDs []string `json:"run_ids"`
	// Candidate is the commit the worker reported for the unit's latest admitted handoff.
	Candidate string `json:"candidate,omitempty"`
	// HandoffAt is the position after the unit's latest handoff in the graph's messages; zero means none.
	HandoffAt int `json:"handoff_at,omitzero"`
	// Seen is how many messages existed when the unit's work was last queued. Later messages addressed
	// to it are still unanswered, and a consumer whose input handed off later is out of date.
	Seen int `json:"seen,omitzero"`
	// Verdict is a review unit's verdict on the candidate it last examined.
	Verdict string `json:"verdict,omitempty"`
	// AdmittedRun and AdmittedAttempt name the last attempt whose result was admitted, so none is admitted twice.
	AdmittedRun     string `json:"admitted_run,omitempty"`
	AdmittedAttempt int    `json:"admitted_attempt,omitzero"`
	// Inputs are the exact candidates the integrate unit last combined.
	Inputs         []workerapi.MergeInput `json:"inputs,omitempty"`
	PullRequestURL string                 `json:"pull_request_url,omitempty"`
	// Restart asks for a fresh run after an operator retried a failed unit.
	Restart bool `json:"restart,omitzero"`
}

// graphMessage is one immutable typed message. Commit is always what the worker observed for the run
// that produced the message, never something a model claimed.
type graphMessage struct {
	ID   string   `json:"id"`
	Type string   `json:"type"`
	From string   `json:"from"`
	To   []string `json:"to,omitempty"`
	// RunID and Attempt name the execution that produced the message; a person's message has neither.
	RunID    string   `json:"run_id,omitempty"`
	Attempt  int      `json:"attempt,omitzero"`
	Commit   string   `json:"commit,omitempty"`
	Title    string   `json:"title,omitempty"`
	Body     string   `json:"body,omitempty"`
	Notes    []string `json:"notes,omitempty"`
	File     string   `json:"file,omitempty"`
	Line     int      `json:"line,omitzero"`
	Severity string   `json:"severity,omitempty"`
	// Resolves names the decision request a resolution answers; By is the person who answered.
	Resolves  string    `json:"resolves,omitempty"`
	By        string    `json:"by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// workGraph is the durable operational record of one approved plan.
type workGraph struct {
	ID             string `json:"id"`
	ObjectiveID    string `json:"objective_id"`
	ObjectiveTitle string `json:"objective_title"`
	PlanRevision   int    `json:"plan_revision"`
	PlanHash       string `json:"plan_hash"`
	// Revision counts every persisted change to the graph.
	Revision        int            `json:"revision"`
	Status          string         `json:"status"`
	ProjectID       string         `json:"project_id"`
	ProjectName     string         `json:"project_name"`
	Repository      string         `json:"repository,omitempty"`
	WorkerID        string         `json:"worker_id"`
	WorkerName      string         `json:"worker_name"`
	BaseBranch      string         `json:"base_branch"`
	WorkflowID      string         `json:"workflow_id,omitempty"`
	WorkflowVersion int            `json:"workflow_version,omitempty"`
	MaxParallel     int            `json:"max_parallel"`
	Units           []workUnit     `json:"units"`
	Messages        []graphMessage `json:"messages"`
	CreatedBy       string         `json:"created_by,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// workGraphStore owns plans and WorkGraphs. It never executes anything: it creates and requeues runs in
// the agent-run store, which stays the only queue, lease, and attempt implementation.
// Lock order: this store's lock may be held while calling the run store, never the reverse.
type workGraphStore struct {
	mu         sync.Mutex
	plans      map[string][]objectivePlan
	graphs     map[string]*workGraph
	path       string
	runs       *agentRunStore
	objectives *objectiveStore
	agents     *agentProfileStore
	workflows  *workflowStore
}

type workGraphState struct {
	Version int                        `json:"version"`
	Plans   map[string][]objectivePlan `json:"plans"`
	Graphs  map[string]*workGraph      `json:"graphs"`
}

func newWorkGraphStore(runs *agentRunStore, objectives *objectiveStore, agents *agentProfileStore, workflows *workflowStore) *workGraphStore {
	return &workGraphStore{plans: map[string][]objectivePlan{}, graphs: map[string]*workGraph{},
		runs: runs, objectives: objectives, agents: agents, workflows: workflows}
}

func openWorkGraphStore(
	path string, runs *agentRunStore, objectives *objectiveStore, agents *agentProfileStore, workflows *workflowStore,
) (*workGraphStore, error) {
	store := newWorkGraphStore(runs, objectives, agents, workflows)
	store.path = path
	var state workGraphState
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load work graphs: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Plans == nil || state.Graphs == nil {
		return nil, fmt.Errorf("load work graphs: unsupported or invalid state")
	}
	for id, graph := range state.Graphs {
		if graph == nil || id != graph.ID || !validStoredWorkGraph(*graph) {
			return nil, fmt.Errorf("load work graphs: invalid record %q", id)
		}
	}
	for objectiveID, plans := range state.Plans {
		for index, plan := range plans {
			if !validHexID(objectiveID) || plan.ObjectiveID != objectiveID || plan.Revision != index+1 {
				return nil, fmt.Errorf("load work graphs: invalid plan for objective %q", objectiveID)
			}
		}
	}
	store.plans, store.graphs = state.Plans, state.Graphs
	return store, nil
}

func validStoredWorkGraph(graph workGraph) bool {
	if !validHexID(graph.ObjectiveID) || !validHexID(graph.ProjectID) || !validHexID(graph.WorkerID) ||
		graph.MaxParallel < 1 || graph.MaxParallel > maxPlanParallel || len(graph.Units) == 0 ||
		len(graph.Units) > maxPlanUnits || graph.CreatedAt.IsZero() ||
		!slices.Contains([]string{graphActive, graphBlocked, graphCompleted, graphFailed, graphCancelled}, graph.Status) {
		return false
	}
	plan := make([]planUnit, 0, len(graph.Units))
	for _, unit := range graph.Units {
		plan = append(plan, unit.planUnit)
	}
	if len(dependencyCycle(plan)) > 0 {
		return false
	}
	return !slices.ContainsFunc(graph.Units, func(unit workUnit) bool {
		return !unitKeyPattern.MatchString(unit.Key) || unit.HandoffAt < 0 || unit.HandoffAt > len(graph.Messages) ||
			(unit.Kind == unitReview && len(unit.DependsOn) != 1) ||
			slices.ContainsFunc(unit.DependsOn, func(key string) bool { return graph.unit(key) == nil }) ||
			slices.ContainsFunc(unit.RunIDs, func(id string) bool { return !validHexID(id) })
	})
}

func (store *workGraphStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, workGraphState{stateFileVersion, store.plans, store.graphs})
}

func (graph *workGraph) unit(key string) *workUnit {
	index := slices.IndexFunc(graph.Units, func(unit workUnit) bool { return unit.Key == key })
	if index < 0 {
		return nil
	}
	return &graph.Units[index]
}

// add appends an immutable message and returns the position after it.
func (graph *workGraph) add(message graphMessage) int {
	message.ID = fmt.Sprintf("%s-%d", graph.ID[:8], len(graph.Messages)+1)
	message.CreatedAt = time.Now().UTC()
	graph.Messages = append(graph.Messages, message)
	return len(graph.Messages)
}

// pending reports whether a finding or a decision resolution addressed to the unit arrived after its
// work was last queued, which means the unit owes another pass.
func (graph *workGraph) pending(unit *workUnit) bool {
	return slices.ContainsFunc(graph.Messages[min(unit.Seen, len(graph.Messages)):], func(message graphMessage) bool {
		return (message.Type == messageFinding || message.Type == messageDecisionResolution) &&
			slices.Contains(message.To, unit.Key)
	})
}

// openDecision returns the unit's decision request that nobody has resolved yet.
func (graph *workGraph) openDecision(key string) (graphMessage, bool) {
	for _, request := range graph.Messages {
		if request.Type != messageDecisionRequest || request.From != key {
			continue
		}
		if !slices.ContainsFunc(graph.Messages, func(message graphMessage) bool {
			return message.Type == messageDecisionResolution && message.Resolves == request.ID
		}) {
			return request, true
		}
	}
	return graphMessage{}, false
}

// producers returns the produce units in plan order: the inputs of the integrate unit.
func (graph *workGraph) producers() []*workUnit {
	var producers []*workUnit
	for index := range graph.Units {
		if graph.Units[index].Kind == unitProduce {
			producers = append(producers, &graph.Units[index])
		}
	}
	return producers
}

// reviewersOf returns the review units that judge the candidate of the unit named key.
func (graph *workGraph) reviewersOf(key string) []*workUnit {
	var reviewers []*workUnit
	for index := range graph.Units {
		if unit := &graph.Units[index]; unit.Kind == unitReview && unit.DependsOn[0] == key {
			reviewers = append(reviewers, unit)
		}
	}
	return reviewers
}

// upstreamFailed reports whether a unit can never start because something it depends on failed.
func (graph *workGraph) upstreamFailed(unit *workUnit) bool {
	return slices.ContainsFunc(unit.DependsOn, func(key string) bool {
		dependency := graph.unit(key)
		return dependency.Failure != "" || graph.upstreamFailed(dependency)
	})
}
