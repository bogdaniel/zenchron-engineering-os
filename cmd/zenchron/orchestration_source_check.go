package main

import (
	"fmt"
	"net/http"
	"time"
)

// sourceCheckFreshness is how recent a successful source check must be for approval to use it.
const sourceCheckFreshness = 2 * time.Minute

// sourceCheckProfile is recorded on source-check runs, which start no provider.
var sourceCheckProfile = agentProfile{
	ID: "1" + integratorProfile.ID[1:], Name: "Zenchron source check", Description: "Verifies a plan's source against origin.",
	Provider: "zenchron-source-check", Model: "none", Status: "active", Tools: []string{}, Version: 1,
	UpdatedAt: time.Date(2026, time.November, 27, 0, 0, 0, 0, time.UTC),
}

type sourceVerdict int

const (
	sourceVerified   sourceVerdict = iota // a fresh check bound to this plan found origin at the plan's source
	sourceChecking                        // the plan's check is queued or running
	sourceNeedsCheck                      // no usable check for this plan: queue one
	sourceRefused                         // the check failed, or origin moved away from the plan's source
	sourceNoBaseline                      // the plan records no source commit, so it cannot be bound to code
)

// sourceCheckFor names the exact plan revision and content a source check verifies.
func (plan objectivePlan) sourceCheckFor() string {
	return fmt.Sprintf("%s:%d:%s", plan.ObjectiveID, plan.Revision, plan.Hash)
}

// judgeSource decides whether approval may proceed. Only a fresh, successful check bound to this plan, its
// project, worker, branch and repository counts, and only when origin is still at the commit the plan was
// prepared against. A check that failed, could not run, is stale or belongs elsewhere never counts.
func (plan objectivePlan) judgeSource(check agentRun, project projectRecord, now time.Time) (string, sourceVerdict) {
	switch {
	case plan.SourceCommit == "":
		return "", sourceNoBaseline
	case plan.SourceCheckRunID == "" || check.ID != plan.SourceCheckRunID || !check.VerifySource ||
		check.SourceCheckFor != plan.sourceCheckFor() || check.ProjectID != plan.ProjectID ||
		check.WorkerID != project.WorkerID || check.BaseBranch != project.Branch || check.Repository != plan.Repository:
		return "", sourceNeedsCheck
	case activeRun(check):
		return "", sourceChecking
	case check.Status != "succeeded" || check.BaseCommit == "":
		return "", sourceRefused
	case check.BaseCommit != plan.SourceCommit:
		return "", sourceRefused
	case now.Sub(check.UpdatedAt) > sourceCheckFreshness:
		return "", sourceNeedsCheck
	}
	return check.BaseCommit, sourceVerified
}

// answerSourceCheckLocked queues the plan's source check, reports one in progress, or explains a refusal. It is
// called with the graph store locked and unlocks it. The check's run ID is reserved on the plan and the run queued
// under that lock, so concurrent approvals share one check; a refusal clears the check so approving again starts a
// fresh one.
func (store *workGraphStore) answerSourceCheckLocked(w http.ResponseWriter, plan *objectivePlan, project projectRecord,
	user string, verdict sourceVerdict, check agentRun,
) {
	checking := map[string]string{"status": "checking_source",
		"message": "Checking that the checkout still matches GitHub before approval."}
	switch verdict {
	case sourceChecking:
		store.mu.Unlock()
		writeJSON(w, http.StatusAccepted, checking)
		return
	case sourceNoBaseline:
		store.mu.Unlock()
		http.Error(w, "Approval refused: this plan records no source commit, so it cannot be bound to the code it was "+
			"prepared against. Propose the plan again.", http.StatusConflict)
		return
	case sourceRefused:
		message := "Approval refused: " + check.Error
		if check.Status == "succeeded" {
			message = "Approval refused: the plan was prepared against " + plan.SourceCommit + ", but " + plan.Repository +
				" is now at " + check.BaseCommit + ". Propose the plan again so it reflects the current code."
		}
		previous := *plan
		plan.SourceCheckRunID, plan.SourceCheckError = "", message
		if err := store.persistLocked(); err != nil {
			*plan = previous
		}
		store.mu.Unlock()
		http.Error(w, message, http.StatusConflict)
		return
	}
	id, err := newHexID()
	if err != nil {
		store.mu.Unlock()
		http.Error(w, "could not create the source check", http.StatusInternalServerError)
		return
	}
	// Lock order is graph store, then run store, as elsewhere in this store.
	_, status, problem := store.runs.enqueue(agentRun{ID: id, AgentID: sourceCheckProfile.ID, AgentName: sourceCheckProfile.Name,
		ProjectID: project.ID, ProjectName: project.Name, Repository: plan.Repository, BaseBranch: project.Branch,
		WorkerID: project.WorkerID, WorkerName: project.WorkerName, Provider: sourceCheckProfile.Provider,
		Profile: &sourceCheckProfile, CreatedBy: user, VerifySource: true, SourceCheckFor: plan.sourceCheckFor(),
		Prompt: "Verify the plan's source against origin before approval."})
	if status != 0 {
		store.mu.Unlock()
		http.Error(w, problem, status)
		return
	}
	previous := *plan
	plan.SourceCheckRunID, plan.SourceCheckError = id, ""
	if err := store.persistLocked(); err != nil {
		*plan = previous
		store.mu.Unlock()
		http.Error(w, "could not record the source check", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusAccepted, checking)
}
