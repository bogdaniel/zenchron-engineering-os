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
	item, status, message := store.recordReview(runID, "", input.Comment, requestChanges, true)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	writeJSON(w, http.StatusOK, publicAgentRun(item))
}

func (store *agentRunStore) recordReview(
	runID, projectID, comment string, requestChanges, requireQueue bool,
) (agentRun, int, string) {
	store.mu.Lock()
	item, exists := store.items[runID]
	if !exists {
		store.mu.Unlock()
		return agentRun{}, http.StatusNotFound, "agent run not found"
	}
	if projectID != "" && item.ProjectID != projectID {
		store.mu.Unlock()
		return agentRun{}, http.StatusNotFound, "agent run not found"
	}
	if !reviewableAgentRun(item) {
		store.mu.Unlock()
		return agentRun{}, http.StatusConflict, "only completed agent runs can be reviewed"
	}
	if len(item.ReviewComments) >= maxAgentRunComments {
		store.mu.Unlock()
		return agentRun{}, http.StatusConflict, "agent run review history is full"
	}
	canQueue := requestChanges && store.canRequestChanges(item)
	if requestChanges && !canQueue && requireQueue {
		store.mu.Unlock()
		return agentRun{}, http.StatusConflict, "agent run cannot accept another code-change pass"
	}
	previous := item
	item.ReviewComments = append(item.ReviewComments, agentRunComment{
		Body: comment, RequestChanges: requestChanges, CreatedAt: time.Now().UTC(),
	})
	item.UpdatedAt = time.Now().UTC()
	if canQueue {
		item.Status, item.Output, item.Error, item.CancelRequested, item.LeaseUntil = "queued", "", "", false, time.Time{}
		item.TerminationReason, item.Verification, item.Publication = "", "", ""
	}
	store.items[runID] = item
	if err := store.persistLocked(); err != nil {
		store.items[runID] = previous
		store.mu.Unlock()
		return agentRun{}, http.StatusInternalServerError, "could not persist agent run review"
	}
	store.mu.Unlock()
	return item, 0, ""
}
