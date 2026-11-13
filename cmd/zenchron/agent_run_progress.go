package main

import (
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// ponytail: each run keeps its newest 300 events in one small file rewritten per batch; move to an
// append-only log or database table if event volume or retention needs grow.
const maxAgentRunEvents = 300

type agentRunEvent struct {
	Sequence int       `json:"sequence"`
	Attempt  int       `json:"attempt"`
	At       time.Time `json:"at"`
	Kind     string    `json:"kind"`
	Message  string    `json:"message"`
}

type agentRunEventFile struct {
	Version int             `json:"version"`
	Events  []agentRunEvent `json:"events"`
}

// progress is the worker's single reporting channel for a running attempt: it renews the lease, stores
// new events, and tells the worker whether cancellation was requested. A worker that does not hold the
// current lease gets a conflict and must stop.
func (store *agentRunStore) progress(w http.ResponseWriter, r *http.Request) {
	workerID, runID := strings.ToLower(r.PathValue("id")), strings.ToLower(r.PathValue("requestID"))
	if !validHexID(workerID) || !validHexID(runID) {
		http.Error(w, "worker or run id is invalid", http.StatusBadRequest)
		return
	}
	var input workerapi.AgentRunProgress
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if len(input.Events) > workerapi.MaxProgressEvents {
		http.Error(w, "too many agent run events", http.StatusBadRequest)
		return
	}
	for _, event := range input.Events {
		if !workerapi.ValidEventKind(event.Kind) || event.Message == "" || len(event.Message) > workerapi.MaxEventMessageSize {
			http.Error(w, "agent run event is invalid", http.StatusBadRequest)
			return
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	now := time.Now().UTC()
	item, exists := store.items[runID]
	if !exists {
		http.NotFound(w, r)
		return
	}
	if item.WorkerID != workerID {
		http.Error(w, "agent run belongs to another worker", http.StatusForbidden)
		return
	}
	if item.Status != "running" || item.Attempts != input.Attempts || now.After(item.LeaseUntil) {
		http.Error(w, "agent run lease is no longer current", http.StatusConflict)
		return
	}
	// The lease lives only in memory; a control-plane restart requeues running attempts.
	item.LeaseUntil = now.Add(agentRunLease)
	store.items[runID] = item
	store.appendEventsLocked(runID, input.Attempts, input.Events...)
	writeJSON(w, http.StatusOK, workerapi.AgentRunProgressReply{CancelRequested: item.CancelRequested})
}

func (store *agentRunStore) listEvents(w http.ResponseWriter, r *http.Request) {
	runID := strings.ToLower(r.PathValue("id"))
	after, err := strconv.Atoi(r.URL.Query().Get("after"))
	if !validHexID(runID) || (r.URL.Query().Has("after") && (err != nil || after < 0)) {
		http.Error(w, "agent run id or event cursor is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	_, exists := store.items[runID]
	events := store.loadEventsLocked(runID)
	store.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	newer := make([]agentRunEvent, 0, len(events))
	for _, event := range events {
		if event.Sequence > after {
			newer = append(newer, event)
		}
	}
	writeJSON(w, http.StatusOK, newer)
}

func (store *agentRunStore) appendEvents(runID string, attempt int, events ...workerapi.AgentRunEvent) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.appendEventsLocked(runID, attempt, events...)
}

// appendEventsLocked stores events as evidence. A storage failure is logged and never fails the run.
func (store *agentRunStore) appendEventsLocked(runID string, attempt int, events ...workerapi.AgentRunEvent) {
	if len(events) == 0 {
		return
	}
	stored := store.loadEventsLocked(runID)
	sequence, now := 0, time.Now().UTC()
	if len(stored) > 0 {
		sequence = stored[len(stored)-1].Sequence
	}
	for _, event := range events {
		sequence++
		stored = append(stored, agentRunEvent{Sequence: sequence, Attempt: attempt, At: now, Kind: event.Kind, Message: event.Message})
	}
	if len(stored) > maxAgentRunEvents {
		stored = stored[len(stored)-maxAgentRunEvents:]
	}
	if store.eventDir == "" {
		store.events[runID] = stored
		return
	}
	if err := store.saveEvents(runID, stored); err != nil {
		log.Printf("could not persist events for agent run %s: %v", runID, err)
	}
}

func (store *agentRunStore) loadEventsLocked(runID string) []agentRunEvent {
	if store.eventDir == "" {
		return store.events[runID]
	}
	var file agentRunEventFile
	exists, err := loadStateFile(filepath.Join(store.eventDir, runID+".json"), &file)
	if err != nil {
		log.Printf("could not read events for agent run %s: %v", runID, err)
	}
	if !exists || err != nil || file.Version != stateFileVersion {
		return nil
	}
	return file.Events
}

func (store *agentRunStore) saveEvents(runID string, events []agentRunEvent) error {
	if err := ensurePrivateDirectory(store.eventDir); err != nil {
		return err
	}
	return writeStateFile(filepath.Join(store.eventDir, runID+".json"), agentRunEventFile{stateFileVersion, events})
}
