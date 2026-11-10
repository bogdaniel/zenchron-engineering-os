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
	item, exists := store.items[runID]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.Status == "cancelled" {
		store.mu.Unlock()
		writeJSON(w, http.StatusOK, publicAgentRun(item))
		return
	}
	if item.Status != "queued" && item.Status != "running" {
		store.mu.Unlock()
		http.Error(w, "only queued or running agent runs can be cancelled", http.StatusConflict)
		return
	}
	previous := item
	item.UpdatedAt = time.Now().UTC()
	if item.Status == "queued" {
		item.Status, item.Error = "cancelled", "Cancelled before worker claim."
	} else {
		item.CancelRequested = true
	}
	store.items[runID] = item
	if err := store.persistLocked(); err != nil {
		store.items[runID] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist agent run cancellation", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusAccepted, publicAgentRun(item))
}
