package main

import (
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
	sourceVerified   sourceVerdict = iota // a fresh check matches the planned source; approval proceeds on it
	sourceChecking                        // a check is queued or running
	sourceNeedsCheck                      // no usable check: queue one
	sourceRefused                         // the last check failed, or the source moved since planning
)

// sourceRuns returns the latest source-check run and the planner run of a plan revision, read without the
// graph store lock held.
func (store *workGraphStore) sourceRuns(objectiveID string, revision int) (check, planner agentRun) {
	store.mu.Lock()
	var checkID, plannerID string
	if plans := store.plans[objectiveID]; revision >= 1 && revision <= len(plans) {
		checkID, plannerID = plans[revision-1].SourceCheckRunID, plans[revision-1].PlannerRunID
	}
	store.mu.Unlock()
	check, _ = store.runs.get(checkID)
	planner, _ = store.runs.get(plannerID)
	return check, planner
}

// judgeSource decides whether approval may proceed. A plan proposed by a planner run must still be on the
// commit that run read; a check that failed, could not run, or is stale never counts as verification.
func (plan objectivePlan) judgeSource(check, planner agentRun, now time.Time) (string, sourceVerdict) {
	switch {
	case plan.SourceCheckRunID == "" || check.ID != plan.SourceCheckRunID:
		return "", sourceNeedsCheck
	case activeRun(check):
		return "", sourceChecking
	case check.Status != "succeeded" || check.BaseCommit == "":
		return "", sourceRefused
	case planner.ID != "" && planner.BaseCommit != "" && planner.BaseCommit != check.BaseCommit:
		return "", sourceRefused
	case now.Sub(check.UpdatedAt) > sourceCheckFreshness:
		return "", sourceNeedsCheck
	}
	return check.BaseCommit, sourceVerified
}

// answerSourceCheck queues a source check, reports one in progress, or explains a refusal. A refusal clears the
// check so that approving again starts a fresh one.
func (store *workGraphStore) answerSourceCheck(w http.ResponseWriter, objectiveID string, revision int, repository string,
	project projectRecord, user string, verdict sourceVerdict, check, planner agentRun,
) {
	switch verdict {
	case sourceChecking:
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "checking_source",
			"message": "Checking that the checkout still matches GitHub before approval."})
		return
	case sourceRefused:
		message := "Approval refused: " + check.Error
		if check.Status == "succeeded" {
			message = "Approval refused: the plan was made against " + planner.BaseCommit + ", but " + repository +
				" is now at " + check.BaseCommit + ". Propose the plan again so it reflects the current code."
		}
		store.setSourceCheck(objectiveID, revision, "", message)
		http.Error(w, message, http.StatusConflict)
		return
	}
	run, status, problem := store.runs.enqueue(agentRun{AgentID: sourceCheckProfile.ID, AgentName: sourceCheckProfile.Name,
		ProjectID: project.ID, ProjectName: project.Name, Repository: repository, BaseBranch: project.Branch,
		WorkerID: project.WorkerID, WorkerName: project.WorkerName, Provider: sourceCheckProfile.Provider,
		Profile: &sourceCheckProfile, CreatedBy: user, VerifySource: true,
		Prompt: "Verify the plan's source against origin before approval."})
	if status != 0 {
		http.Error(w, problem, status)
		return
	}
	if !store.setSourceCheck(objectiveID, revision, run.ID, "") {
		http.Error(w, "could not record the source check", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "checking_source",
		"message": "Checking that the checkout still matches GitHub before approval."})
}

// setSourceCheck records the current source check and refusal of a plan revision.
func (store *workGraphStore) setSourceCheck(objectiveID string, revision int, runID, refusal string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	plans := store.plans[objectiveID]
	if revision < 1 || revision > len(plans) {
		return false
	}
	previous := plans[revision-1]
	plans[revision-1].SourceCheckRunID, plans[revision-1].SourceCheckError = runID, refusal
	if err := store.persistLocked(); err != nil {
		plans[revision-1] = previous
		return false
	}
	return true
}
