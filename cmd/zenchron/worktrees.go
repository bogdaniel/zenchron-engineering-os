package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	worktreeLeaseDuration = 10 * time.Minute
	maxWorktreeAttempts   = 3
	maxWorktreeRequests   = 1000
)

// ponytail: keep 1,000 worktree requests; add retention after teams need longer run history.

type worktreeRequest struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	ProjectName string    `json:"project_name"`
	WorkerID    string    `json:"worker_id"`
	WorkerName  string    `json:"worker_name"`
	Branch      string    `json:"branch"`
	BaseBranch  string    `json:"base_branch"`
	Status      string    `json:"status"`
	Error       string    `json:"error,omitempty"`
	Attempts    int       `json:"attempts"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	LeaseUntil  time.Time `json:"lease_until,omitempty"`
}

type worktreeStore struct {
	mu       sync.Mutex
	items    map[string]worktreeRequest
	path     string
	registry *workerRegistry
}

func newWorktreeStore(registry *workerRegistry) *worktreeStore {
	return &worktreeStore{items: make(map[string]worktreeRequest), registry: registry}
}

func openWorktreeStore(path string, registry *workerRegistry) (*worktreeStore, error) {
	store := newWorktreeStore(registry)
	store.path = path
	var state struct {
		Version int                        `json:"version"`
		Items   map[string]worktreeRequest `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load worktree requests: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load worktree requests: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredWorktreeRequest(item) {
			return nil, fmt.Errorf("load worktree requests: invalid record %q", id)
		}
	}
	store.items = state.Items
	return store, nil
}

func (store *worktreeStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, struct {
		Version int                        `json:"version"`
		Items   map[string]worktreeRequest `json:"items"`
	}{stateFileVersion, store.items})
}

func validStoredWorktreeRequest(item worktreeRequest) bool {
	id, err := hex.DecodeString(item.ID)
	projectID, projectErr := hex.DecodeString(item.ProjectID)
	workerID, workerErr := hex.DecodeString(item.WorkerID)
	return err == nil && len(id) == 16 && projectErr == nil && len(projectID) == 16 &&
		workerErr == nil && len(workerID) == 16 && item.Attempts >= 0 && item.Attempts <= maxWorktreeAttempts &&
		item.ProjectName != "" && len(item.ProjectName) <= 255 && item.WorkerName != "" && len(item.WorkerName) <= 128 &&
		validStoredBranch(item.Branch) && validStoredBranch(item.BaseBranch) && validWorktreeStatus(item.Status) &&
		(item.Status == "preparing") == !item.LeaseUntil.IsZero() &&
		len(item.Error) <= 255 && !item.CreatedAt.IsZero() && !item.UpdatedAt.IsZero()
}

// Records persisted before create enforced Git's ref rules must still load, so stored branches keep the older rule.
func validStoredBranch(branch string) bool {
	return branch != "" && branch == strings.TrimSpace(branch) && len(branch) <= 255 &&
		!strings.ContainsAny(branch, "\r\n")
}

// validBranchInput rejects names `git check-ref-format --branch` would refuse, before a request is queued.
func validBranchInput(branch string) bool {
	if !validStoredBranch(branch) || strings.HasPrefix(branch, "-") || strings.HasSuffix(branch, ".") ||
		strings.Contains(branch, "..") || strings.Contains(branch, "@{") ||
		strings.ContainsAny(branch, " ~^:?*[\\") || strings.ContainsFunc(branch, unicode.IsControl) {
		return false
	}
	// An empty component covers a leading or trailing "/" and "//".
	for _, component := range strings.Split(branch, "/") {
		if component == "" || strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
}

func validWorktreeStatus(status string) bool {
	switch status {
	case "queued", "preparing", "ready", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func (store *worktreeStore) list(w http.ResponseWriter, _ *http.Request) {
	store.mu.Lock()
	if store.requeueExpiredLocked(time.Now().UTC()) {
		if err := store.persistLocked(); err != nil {
			store.mu.Unlock()
			http.Error(w, "could not persist expired worktree lease", http.StatusInternalServerError)
			return
		}
	}
	items := make([]worktreeRequest, 0, len(store.items))
	for _, item := range store.items {
		item.LeaseUntil = time.Time{}
		items = append(items, item)
	}
	store.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (store *worktreeStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProjectID  string `json:"project_id"`
		Branch     string `json:"branch"`
		BaseBranch string `json:"base_branch"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.ProjectID = strings.ToLower(input.ProjectID)
	projectBytes, err := hex.DecodeString(input.ProjectID)
	if err != nil || len(projectBytes) != 16 || !validBranchInput(input.Branch) {
		http.Error(w, "project id or branch is invalid", http.StatusBadRequest)
		return
	}
	store.registry.mu.RLock()
	var project projectRecord
	found := false
	for _, candidate := range store.registry.projects {
		if candidate.ID == input.ProjectID && time.Since(candidate.LastSeen) <= workerOnlineWindow {
			project, found = candidate, true
			break
		}
	}
	store.registry.mu.RUnlock()
	if !found {
		http.Error(w, "project has no online worker", http.StatusConflict)
		return
	}
	if input.BaseBranch == "" || input.BaseBranch == "Unknown" || input.BaseBranch == "Detached HEAD" {
		input.BaseBranch = project.Branch
	}
	if !validBranchInput(input.BaseBranch) || input.BaseBranch == "Unknown" || input.BaseBranch == "Detached HEAD" {
		http.Error(w, "a named base branch is required", http.StatusBadRequest)
		return
	}
	requestID := make([]byte, 16)
	if _, err := rand.Read(requestID); err != nil {
		http.Error(w, "could not create worktree request id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := worktreeRequest{
		ID: hex.EncodeToString(requestID), ProjectID: project.ID, ProjectName: project.Name,
		WorkerID: project.WorkerID, WorkerName: project.WorkerName, Branch: input.Branch,
		BaseBranch: input.BaseBranch, Status: "queued", CreatedAt: now, UpdatedAt: now,
	}
	store.mu.Lock()
	if len(store.items) >= maxWorktreeRequests {
		store.mu.Unlock()
		http.Error(w, "worktree request history is full", http.StatusInsufficientStorage)
		return
	}
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist worktree request", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusAccepted, item)
}

func (store *worktreeStore) claim(w http.ResponseWriter, r *http.Request) {
	workerID := strings.ToLower(r.PathValue("id"))
	if !validHexID(workerID) {
		http.Error(w, "worker id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	now := time.Now().UTC()
	requeued := store.requeueExpiredLocked(now)
	for id, item := range store.items {
		if item.WorkerID != workerID || item.Status != "queued" {
			continue
		}
		item.Status = "preparing"
		item.Attempts++
		item.UpdatedAt = now
		item.LeaseUntil = now.Add(worktreeLeaseDuration)
		store.items[id] = item
		if err := store.persistLocked(); err != nil {
			item.Status = "queued"
			item.Attempts--
			item.LeaseUntil = time.Time{}
			store.items[id] = item
			store.mu.Unlock()
			http.Error(w, "could not persist worktree lease", http.StatusInternalServerError)
			return
		}
		item.LeaseUntil = time.Time{}
		store.mu.Unlock()
		writeJSON(w, http.StatusOK, item)
		return
	}
	if requeued {
		if err := store.persistLocked(); err != nil {
			store.mu.Unlock()
			http.Error(w, "could not persist expired worktree lease", http.StatusInternalServerError)
			return
		}
	}
	store.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (store *worktreeStore) finish(w http.ResponseWriter, r *http.Request) {
	workerID := strings.ToLower(r.PathValue("id"))
	requestID := strings.ToLower(r.PathValue("requestID"))
	if !validHexID(workerID) || !validHexID(requestID) {
		http.Error(w, "worker or request id is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		Status   string `json:"status"`
		Error    string `json:"error"`
		Attempts int    `json:"attempts"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if input.Status != "ready" && input.Status != "failed" || len(input.Error) > 255 ||
		strings.ContainsAny(input.Error, "\r\n") || (input.Status == "ready" && input.Error != "") ||
		(input.Status == "failed" && strings.TrimSpace(input.Error) == "") {
		http.Error(w, "worktree result is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[requestID]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.WorkerID != workerID || item.Status != "preparing" || item.Attempts != input.Attempts ||
		time.Now().After(item.LeaseUntil) {
		store.mu.Unlock()
		http.Error(w, "worktree request lease is not active", http.StatusConflict)
		return
	}
	previous := item
	item.Status = input.Status
	item.Error = strings.TrimSpace(input.Error)
	item.UpdatedAt = time.Now().UTC()
	item.LeaseUntil = time.Time{}
	store.items[requestID] = item
	if err := store.persistLocked(); err != nil {
		store.items[requestID] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist worktree result", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item)
}

func (store *worktreeStore) cancel(w http.ResponseWriter, r *http.Request) {
	requestID := strings.ToLower(r.PathValue("id"))
	if !validHexID(requestID) {
		http.Error(w, "request id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[requestID]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.Status != "queued" {
		store.mu.Unlock()
		http.Error(w, "only queued worktree requests can be cancelled", http.StatusConflict)
		return
	}
	previous := item
	item.Status = "cancelled"
	item.UpdatedAt = time.Now().UTC()
	store.items[requestID] = item
	if err := store.persistLocked(); err != nil {
		store.items[requestID] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist cancelled worktree request", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item)
}

func (store *worktreeStore) requeueExpiredLocked(now time.Time) bool {
	changed := false
	for id, item := range store.items {
		if item.Status != "preparing" || item.LeaseUntil.IsZero() || now.Before(item.LeaseUntil) {
			continue
		}
		item.LeaseUntil = time.Time{}
		item.UpdatedAt = now
		if item.Attempts >= maxWorktreeAttempts {
			item.Status = "failed"
			item.Error = "worker lease expired too many times"
		} else {
			item.Status = "queued"
		}
		store.items[id] = item
		changed = true
	}
	return changed
}

func validHexID(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 16
}
