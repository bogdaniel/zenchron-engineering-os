package main

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// unitAction is one step the runnable frontier asks for.
type unitAction struct {
	key  string
	kind string
}

const (
	actionStart   = "start"   // queue a new run for the unit
	actionRequeue = "requeue" // another pass of the unit's run: remediation or a resolved decision
	actionPublish = "publish" // another pass of the integration run that pushes the reviewed candidate
)

// reconcileAll brings every unfinished graph up to date with the run store: it admits finished
// attempts, queues the runnable frontier, and projects unit states. It is idempotent, so it is safe to
// call after any event and after a restart; nothing else moves a graph forward.
func (store *workGraphStore) reconcileAll() bool {
	if store == nil {
		return true
	}
	if store.runs != nil && store.runs.isQuiesced() {
		return true
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	changed := store.admitPlansLocked()
	cancellationsPersisted := true
	// Oldest graph first, so graphs queue their runs in the order they were approved.
	graphs := make([]*workGraph, 0, len(store.graphs))
	for _, graph := range store.graphs {
		graphs = append(graphs, graph)
	}
	slices.SortFunc(graphs, func(a, b *workGraph) int {
		return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	for _, graph := range graphs {
		if graph.Status == graphCompleted {
			continue
		}
		// Encoding a graph cannot fail: it holds only strings, numbers, times, and slices of them.
		before, _ := json.Marshal(graph)
		if graph.Status == graphCancelled {
			if status, message := store.runs.cancelGraphRuns(graph.ID); status != 0 {
				log.Printf("could not reconcile cancelled work graph %s: %s", graph.ID, message)
				cancellationsPersisted = false
			}
			graph.project(store.runs.unitRuns(graph.ID), false)
		} else {
			store.reconcile(graph)
		}
		if after, _ := json.Marshal(graph); !bytes.Equal(before, after) {
			graph.Revision, graph.UpdatedAt, changed = graph.Revision+1, time.Now().UTC(), true
		}
	}
	if !changed {
		return cancellationsPersisted
	}
	// The run store already holds whatever was queued; the next reconcile adopts those runs and
	// repeats the projection, so a failed write loses nothing.
	if err := store.persistLocked(); err != nil {
		log.Printf("could not persist work graphs: %v", err)
	}
	return cancellationsPersisted
}

func (store *workGraphStore) reconcile(graph *workGraph) {
	runs := store.runs.unitRuns(graph.ID)
	graph.adopt(runs)
	for index := range graph.Units {
		store.admit(graph, &graph.Units[index], runs)
	}
	active := 0
	for index := range graph.Units {
		if run, exists := graph.current(&graph.Units[index], runs); exists && activeRun(run) {
			active++
		}
	}
	publishable := store.runs.publishable(graph.Repository)
	for _, action := range graph.frontier(runs, publishable) {
		if active >= graph.MaxParallel {
			break
		}
		if store.perform(graph, action, runs) {
			active++
		}
	}
	graph.project(runs, publishable)
}

func activeRun(run agentRun) bool { return run.Status == "queued" || run.Status == "running" }

// current returns the run that currently executes a unit.
func (graph *workGraph) current(unit *workUnit, runs map[string]agentRun) (agentRun, bool) {
	if len(unit.RunIDs) == 0 {
		return agentRun{}, false
	}
	run, exists := runs[unit.RunIDs[len(unit.RunIDs)-1]]
	return run, exists
}

// adopt attaches runs that were queued for a unit but not recorded on it, which happens when the
// control plane stops between the two writes. Without it a restart would queue the same work twice.
func (graph *workGraph) adopt(runs map[string]agentRun) {
	orphans := make([]agentRun, 0)
	for _, run := range runs {
		if unit := graph.unit(run.UnitKey); unit != nil && !slices.Contains(unit.RunIDs, run.ID) {
			orphans = append(orphans, run)
		}
	}
	slices.SortFunc(orphans, func(a, b agentRun) int { return a.CreatedAt.Compare(b.CreatedAt) })
	for _, run := range orphans {
		unit := graph.unit(run.UnitKey)
		unit.RunIDs, unit.Seen, unit.Restart = append(unit.RunIDs, run.ID), len(graph.Messages), false
		unit.RecoveryUsed = unit.RecoveryUsed || run.ReviewRecovery
		if unit.Kind == unitReview {
			// The adopted run is a new round; the verdict of the round before it no longer counts.
			unit.Verdict = ""
		}
		if unit.Kind == unitIntegrate {
			unit.Inputs, unit.Candidate = run.Merge, ""
		}
	}
}

// settled reports whether a unit's output may be consumed by the units that depend on it.
func (graph *workGraph) settled(unit *workUnit, runs map[string]agentRun) bool {
	if run, exists := graph.current(unit, runs); unit.Failure != "" || unit.Restart || (exists && activeRun(run)) {
		return false
	}
	switch unit.Kind {
	case unitProduce:
		_, undecided := graph.openDecision(unit.Key)
		return unit.HandoffAt > 0 && !undecided && !graph.pending(unit)
	case unitReview:
		target := graph.unit(unit.DependsOn[0])
		// A verdict counts only for the handoff the review started from.
		return unit.Verdict == "accept" && unit.Seen >= target.HandoffAt && graph.settled(target, runs)
	case unitIntegrate:
		return graph.producersSettled(runs) && unit.Candidate != "" && !graph.integrationDue(unit)
	default:
		return unit.Candidate != "" && !graph.integrationDue(unit)
	}
}

func (graph *workGraph) producersSettled(runs map[string]agentRun) bool {
	return !slices.ContainsFunc(graph.producers(), func(producer *workUnit) bool {
		return !graph.settled(producer, runs)
	})
}

// integrationDue reports whether a producer handed off after the integrate unit last combined them.
func (graph *workGraph) integrationDue(unit *workUnit) bool {
	return slices.ContainsFunc(graph.producers(), func(producer *workUnit) bool { return producer.HandoffAt > unit.Seen })
}

// frontier returns the actions that are runnable now, in plan order. It reads only the graph and the
// run snapshot, so the same state always yields the same frontier.
func (graph *workGraph) frontier(runs map[string]agentRun, publishable bool) []unitAction {
	var actions []unitAction
	for index := range graph.Units {
		unit := &graph.Units[index]
		run, started := graph.current(unit, runs)
		if unit.Failure != "" || graph.upstreamFailed(unit) || (started && activeRun(run)) {
			continue
		}
		dependenciesSettled := !slices.ContainsFunc(unit.DependsOn, func(key string) bool {
			return !graph.settled(graph.unit(key), runs)
		})
		if unit.Kind == unitIntegrate {
			dependenciesSettled = dependenciesSettled && graph.producersSettled(runs)
		}
		_, undecided := graph.openDecision(unit.Key)
		switch {
		case unit.Kind == unitProduce && (!started || unit.Restart):
			if dependenciesSettled {
				actions = append(actions, unitAction{unit.Key, actionStart})
			}
		case unit.Kind == unitProduce:
			if !undecided && graph.pending(unit) {
				actions = append(actions, unitAction{unit.Key, actionRequeue})
			}
		case unit.Kind == unitReview:
			// A new round is due when there is no verdict yet or the target handed off again.
			if target := graph.unit(unit.DependsOn[0]); dependenciesSettled && (unit.Verdict == "" || target.HandoffAt > unit.Seen) {
				actions = append(actions, unitAction{unit.Key, actionStart})
			}
		case !dependenciesSettled:
		case !started || unit.Restart || graph.integrationDue(unit):
			actions = append(actions, unitAction{unit.Key, actionStart})
		// A reviewed candidate is published by another pass of its run; a push that failed is tried again,
		// for as long as the run has attempts.
		case publishable && unit.Candidate != "" && graph.reviewed(unit, runs) &&
			(!run.PullRequestEnabled || run.Publication == publicationPushFailed):
			actions = append(actions, unitAction{unit.Key, actionPublish})
		}
	}
	return actions
}

// reviewed reports whether every review of a unit's candidate has accepted it.
func (graph *workGraph) reviewed(unit *workUnit, runs map[string]agentRun) bool {
	return !slices.ContainsFunc(graph.reviewersOf(unit.Key), func(reviewer *workUnit) bool {
		return !graph.settled(reviewer, runs)
	})
}

// perform executes one frontier action through the run store and reports whether a run became active.
// A refusal by the run store fails the unit with the reason, so exhausted budgets are visible.
func (store *workGraphStore) perform(graph *workGraph, action unitAction, runs map[string]agentRun) bool {
	unit := graph.unit(action.key)
	if action.kind != actionStart {
		run, status, message := store.runs.requeueForUnit(unit.RunIDs[len(unit.RunIDs)-1], action.kind == actionPublish)
		if status != 0 {
			if status == http.StatusServiceUnavailable && message == runAdmissionPausedMessage {
				return false
			}
			unit.Failure = "No further pass is possible: " + message + "."
			return false
		}
		if action.kind == actionRequeue {
			unit.Seen = len(graph.Messages)
		}
		runs[run.ID] = run
		return true
	}
	if len(unit.RunIDs) >= maxUnitRuns {
		unit.Failure = fmt.Sprintf("The unit used all %d of its runs.", maxUnitRuns)
		return false
	}
	item, failure := store.newUnitRun(graph, unit, runs)
	if failure != "" {
		unit.Failure = failure
		return false
	}
	if unit.Kind == unitReview && unit.RecoveryUsed && !reviewRecoveryUsed(unit, runs) {
		item.ReviewRecovery = true
	}
	run, status, message := store.runs.enqueue(item)
	if status != 0 {
		if status == http.StatusServiceUnavailable && message == runAdmissionPausedMessage {
			return false
		}
		unit.Failure = "Could not queue a run: " + message + "."
		return false
	}
	unit.RunIDs, unit.Seen, unit.Restart = append(unit.RunIDs, run.ID), len(graph.Messages), false
	if unit.Kind == unitReview {
		unit.Verdict = ""
	}
	if unit.Kind == unitIntegrate {
		unit.Inputs, unit.Candidate = run.Merge, ""
	}
	runs[run.ID] = run
	return true
}

// integratorProfile is recorded on integration runs, which start no provider.
var integratorProfile = agentProfile{
	ID: strings.Repeat("0", 32), Name: "Zenchron integrator", Description: "Combines admitted candidates with Git.",
	Provider: "zenchron-merge", Model: "none", Status: "active", Tools: []string{}, Version: 1,
	UpdatedAt: time.Date(2026, time.November, 15, 0, 0, 0, 0, time.UTC),
}

// newUnitRun builds the run that executes a unit, or says why it cannot be built.
func (store *workGraphStore) newUnitRun(graph *workGraph, unit *workUnit, runs map[string]agentRun) (agentRun, string) {
	item := agentRun{ProjectID: graph.ProjectID, ProjectName: graph.ProjectName, Repository: graph.Repository,
		BaseBranch: graph.BaseBranch, WorkerID: graph.WorkerID, WorkerName: graph.WorkerName, CreatedBy: graph.CreatedBy,
		GraphID: graph.ID, UnitKey: unit.Key, Prompt: unitPrompt(*unit)}
	profile := integratorProfile
	switch unit.Kind {
	case unitIntegrate:
		for _, producer := range graph.producers() {
			run, _ := graph.current(producer, runs)
			item.Merge = append(item.Merge, workerapi.MergeInput{Branch: run.Branch, Commit: producer.Candidate})
		}
		// The pull request is named after the objective. A reviewed candidate is published only after
		// its review, by a second pass of this run.
		item.Prompt = truncateUTF8(graph.ObjectiveTitle, 5000)
		item.PullRequestEnabled = store.runs.publishable(graph.Repository) && len(graph.reviewersOf(unit.Key)) == 0
	default:
		var exists bool
		if graph.PlanRevision > 0 && graph.PlanRevision <= len(store.plans[graph.ObjectiveID]) {
			profile, exists = store.plans[graph.ObjectiveID][graph.PlanRevision-1].ProfileSnapshots[unit.AgentID]
		}
		if !exists {
			store.agents.mu.RLock()
			profile, exists = store.agents.items[unit.AgentID]
			store.agents.mu.RUnlock()
			if exists {
				profile = store.agents.snapshot(profile)
			}
		}
		if !exists || profile.Status != "active" {
			return agentRun{}, "The assigned agent profile no longer exists or is disabled."
		}
		// A review starts from the exact candidate it judges; a producer that builds on another producer,
		// or continues after a retry, starts from that branch.
		for _, key := range unit.DependsOn {
			if dependency := graph.unit(key); unit.Kind == unitReview || dependency.Kind == unitProduce {
				run, _ := graph.current(dependency, runs)
				item.BaseBranch = run.Branch
			}
		}
		if previous, exists := graph.current(unit, runs); exists && unit.Kind == unitProduce && previous.CommitSHA != "" {
			item.BaseBranch = previous.Branch
		}
	}
	item.AgentID, item.AgentName, item.Provider, item.Profile = profile.ID, profile.Name, profile.Provider, &profile
	return item, ""
}

// unitPrompt is the stored task of a unit's run; everything else is added when the run is claimed.
func unitPrompt(unit workUnit) string {
	return truncateUTF8(strings.TrimSpace(unit.Title+"\n\n"+unit.Instructions), 5000)
}

// project derives every unit's state and the graph's status from the durable record and the runs.
func (graph *workGraph) project(runs map[string]agentRun, publishable bool) {
	states := map[string]int{}
	for index := range graph.Units {
		unit := &graph.Units[index]
		unit.State, unit.Reason = graph.unitState(unit, runs, publishable)
		if graph.Status == graphCancelled && unit.State != unitCompleted && unit.State != unitRunning {
			unit.State, unit.Reason = unitCancelled, ""
		}
		states[unit.State]++
	}
	switch {
	case graph.Status == graphCancelled:
	case states[unitCompleted] == len(graph.Units):
		graph.Status = graphCompleted
	case states[unitFailed] > 0:
		graph.Status = graphFailed
	case states[unitBlocked] > 0 && states[unitQueued]+states[unitRunning] == 0:
		graph.Status = graphBlocked
	default:
		graph.Status = graphActive
	}
}

func (graph *workGraph) unitState(unit *workUnit, runs map[string]agentRun, publishable bool) (string, string) {
	run, started := graph.current(unit, runs)
	_, undecided := graph.openDecision(unit.Key)
	switch {
	case unit.Failure != "":
		return unitFailed, unit.Failure
	case graph.upstreamFailed(unit):
		return unitBlocked, "A responsibility this one depends on failed."
	case started && run.Status == "queued":
		return unitQueued, ""
	case started && run.Status == "running":
		return unitRunning, ""
	case undecided:
		return unitBlocked, "Waiting for a decision from a person."
	case unit.Kind == unitIntegrate:
		return graph.integrationState(unit, run, runs, publishable)
	case graph.settled(unit, runs):
		return unitCompleted, ""
	case unit.Kind == unitReview && unit.Verdict == "block":
		return unitWaiting, "Waiting for the findings of this review to be remediated."
	case unit.Kind == unitReview:
		return unitWaiting, "Waiting for a candidate to review."
	case !started:
		return unitWaiting, "Waiting for the responsibilities it depends on."
	}
	return unitWaiting, "Waiting for a free slot to continue."
}

func (graph *workGraph) integrationState(unit *workUnit, run agentRun, runs map[string]agentRun, publishable bool) (string, string) {
	unit.PullRequestURL = run.PullRequestURL
	switch {
	case !graph.producersSettled(runs) || unit.Candidate == "" || graph.integrationDue(unit):
		return unitWaiting, "Waiting for every produced candidate to be admitted."
	case !graph.reviewed(unit, runs):
		return unitWaiting, "Waiting for review of the integrated candidate."
	case run.PullRequestURL != "":
		return unitCompleted, ""
	case run.Publishing:
		return unitWaiting, "Creating the pull request."
	case run.PullRequestEnabled:
		return unitBlocked, cmp.Or(run.PullRequestError, "The pull request was not created.")
	case publishable:
		return unitWaiting, "Waiting to publish the reviewed candidate."
	}
	return unitCompleted, "GitHub publication is not configured; the integrated candidate is on a local branch."
}
