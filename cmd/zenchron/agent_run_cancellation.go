package main

import (
	"net/http"
	"strings"
	"time"
)

func (store *agentRunStore) cancel(w http.ResponseWriter, r *http.Request) {
	runID := strings.ToLower(r.PathValue("id"))
	if !validHexID(runID) {
		http.Error(w, "agent run id is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	alreadyCancelled := store.items[runID].Status == "cancelled"
	store.mu.Unlock()
	item, status, message := store.cancelRun(runID)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	if alreadyCancelled {
		writeJSON(w, http.StatusOK, publicAgentRun(item))
		return
	}
	store.graphs.reconcileAll()
	writeJSON(w, http.StatusAccepted, publicAgentRun(item))
}

// cancelRun cancels a queued run at once and asks the worker to stop a running one. Cancelling a run
// that is already cancelled changes nothing.
func (store *agentRunStore) cancelRun(runID string) (agentRun, int, string) {
	return store.update(runID, func(item *agentRun) (int, string) {
		switch item.Status {
		case "cancelled":
		case "queued":
			item.Status, item.Error, item.UpdatedAt = "cancelled", "Cancelled before worker claim.", time.Now().UTC()
		case "running":
			item.CancelRequested, item.UpdatedAt = true, time.Now().UTC()
		default:
			return http.StatusConflict, "only queued or running agent runs can be cancelled"
		}
		return 0, ""
	})
}
