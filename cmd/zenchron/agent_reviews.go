package main

import (
	"net/http"
	"slices"
	"strings"
	"time"
)

const (
	maxAgentRunComments    = 10
	maxAgentRunCommentSize = 1000
)

type agentRunComment struct {
	Body           string    `json:"body"`
	RequestChanges bool      `json:"request_changes"`
	CreatedAt      time.Time `json:"created_at"`
}

func validAgentRunComments(comments []agentRunComment) bool {
	if len(comments) > maxAgentRunComments {
		return false
	}
	for _, comment := range comments {
		if strings.TrimSpace(comment.Body) == "" || len(comment.Body) > maxAgentRunCommentSize || comment.CreatedAt.IsZero() {
			return false
		}
	}
	return true
}

func agentRunPrompt(item agentRun) string {
	var prompt strings.Builder
	prompt.WriteString(item.Prompt)
	prompt.WriteString(issuePromptSection(item))
	if len(item.ReviewComments) == 0 {
		return prompt.String()
	}
	prompt.WriteString("\n\nReviewer feedback:\n")
	for _, comment := range item.ReviewComments {
		prompt.WriteString("- ")
		if comment.RequestChanges {
			prompt.WriteString("Requested changes: ")
		}
		prompt.WriteString(comment.Body)
		prompt.WriteByte('\n')
	}
	return prompt.String()
}

func (store *agentRunStore) canRequestChanges(item agentRun) bool {
	if !reviewableAgentRun(item) || item.Attempts >= maxAgentRunAttempts || item.Profile == nil ||
		!slices.Contains(item.Profile.Tools, "code.write") {
		return false
	}
	worker, online := store.registry.onlineWorker(item.WorkerID)
	return online && workerRunsProfile(worker, *item.Profile)
}

func reviewableAgentRun(item agentRun) bool {
	return item.DiffAvailable && (item.Status == "succeeded" || item.Status == "failed" || item.Status == "cancelled")
}

func (store *agentRunStore) addComment(w http.ResponseWriter, r *http.Request) {
	store.reviewRun(w, r, false)
}

func (store *agentRunStore) requestChanges(w http.ResponseWriter, r *http.Request) {
	store.reviewRun(w, r, true)
}

func (store *agentRunStore) reviewRun(w http.ResponseWriter, r *http.Request, requestChanges bool) {
	runID := strings.ToLower(r.PathValue("id"))
	if !validHexID(runID) {
		http.Error(w, "agent run id is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		Comment string `json:"comment"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Comment = strings.TrimSpace(input.Comment)
	if input.Comment == "" || len(input.Comment) > maxAgentRunCommentSize {
		http.Error(w, "review comment is invalid", http.StatusBadRequest)
		return
	}
	item, status, message := store.recordReview(accessFor(r), runID, "", input.Comment, requestChanges, true)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	writeJSON(w, http.StatusOK, publicAgentRun(item))
}

// recordReview stores feedback on a finished run. A change request queues another pass only when the
// caller may dispatch work to the run's worker; feedback alone never starts work on someone's machine.
func (store *agentRunStore) recordReview(
	access requestAccess, runID, projectID, comment string, requestChanges, requireQueue bool,
) (agentRun, int, string) {
	updated, status, message := store.update(runID, func(item *agentRun) (int, string) {
		if projectID != "" && item.ProjectID != projectID {
			return http.StatusNotFound, "agent run not found"
		}
		return store.recordReviewLocked(item, access, comment, requestChanges, requireQueue)
	})
	if status == http.StatusInternalServerError {
		return agentRun{}, status, "could not persist agent run review"
	}
	return updated, status, message
}

// recordReviewLocked changes a run's review state while its store lock is held.
func (store *agentRunStore) recordReviewLocked(
	item *agentRun, access requestAccess, comment string, requestChanges, requireQueue bool,
) (int, string) {
	if !reviewableAgentRun(*item) {
		return http.StatusConflict, "only completed agent runs can be reviewed"
	}
	if len(item.ReviewComments) >= maxAgentRunComments {
		return http.StatusConflict, "agent run review history is full"
	}
	canQueue := requestChanges && store.canRequestChanges(*item) && access.mayDispatchTo(item.WorkerID)
	if requestChanges && !canQueue && requireQueue {
		return http.StatusConflict, "agent run cannot accept another code-change pass"
	}
	if canQueue && item.GraphID != "" && store.graphPublicationAttemptActiveLocked(item.GraphID) {
		return http.StatusConflict, "a reviewed WorkGraph candidate is being published; retry the change request afterward"
	}
	item.ReviewComments = append(item.ReviewComments, agentRunComment{
		Body: comment, RequestChanges: requestChanges, CreatedAt: time.Now().UTC(),
	})
	item.UpdatedAt = time.Now().UTC()
	if canQueue {
		item.requeue()
	}
	return 0, ""
}

// requeue returns a finished run to the queue for another pass on the same branch and worktree.
func (item *agentRun) requeue() {
	item.Status, item.Output, item.Error, item.CancelRequested, item.LeaseUntil = "queued", "", "", false, time.Time{}
	item.TerminationReason, item.Verification, item.Publication, item.PublishOnly = "", "", "", false
	item.UpdatedAt = time.Now().UTC()
}

// requeueForUnit queues another pass of a WorkUnit's finished run: remediation, a resumed decision, or
// publication of a reviewed candidate. The run's attempt limit bounds how often this can happen. A run
// that is already queued or running is left alone, so repeating the call is harmless.
func (store *agentRunStore) requeueForUnit(runID string, publish bool) (agentRun, int, string) {
	return store.update(runID, func(item *agentRun) (int, string) {
		if item.Status == "queued" || item.Status == "running" {
			return 0, ""
		}
		if item.Attempts >= maxAgentRunAttempts {
			return http.StatusConflict, "the run has used all of its attempts"
		}
		item.requeue()
		item.PullRequestEnabled = item.PullRequestEnabled || publish
		item.PublishOnly = publish
		return 0, ""
	})
}
