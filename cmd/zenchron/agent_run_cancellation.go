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

// cancelGraphRuns persists every cancellation for a graph in one run-store write.
func (store *agentRunStore) cancelGraphRuns(graphID string) (int, string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	previous := make(map[string]agentRun)
	now := time.Now().UTC()
	for id, item := range store.items {
		if item.GraphID != graphID {
			continue
		}
		switch item.Status {
		case "queued":
			previous[id] = item
			item.Status, item.Error, item.UpdatedAt = "cancelled", "Cancelled before worker claim.", now
		case "running":
			if item.CancelRequested {
				continue
			}
			previous[id] = item
			item.CancelRequested, item.UpdatedAt = true, now
		default:
			continue
		}
		store.items[id] = item
	}
	if len(previous) == 0 {
		return 0, ""
	}
	if err := store.persistLocked(); err != nil {
		for id, item := range previous {
			store.items[id] = item
		}
		return http.StatusInternalServerError, "could not persist work-graph run cancellations"
	}
	return 0, ""
}
