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
		item.Profile = nil
		writeJSON(w, http.StatusOK, item)
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
	item.Profile = nil
	writeJSON(w, http.StatusAccepted, item)
}

func (store *agentRunStore) cancellationStatus(w http.ResponseWriter, r *http.Request) {
	workerID, runID := strings.ToLower(r.PathValue("id")), strings.ToLower(r.PathValue("requestID"))
	if !validHexID(workerID) || !validHexID(runID) {
		http.Error(w, "worker or run id is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[runID]
	store.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	if item.WorkerID != workerID {
		http.Error(w, "agent run belongs to another worker", http.StatusForbidden)
		return
	}
	if item.Status != "running" {
		http.Error(w, "agent run is no longer active", http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		CancelRequested bool `json:"cancel_requested"`
	}{item.CancelRequested})
}
