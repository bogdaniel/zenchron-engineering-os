package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	agentRunLease        = 3 * time.Minute
	maxAgentRuns         = 200
	maxAgentRunDiffSize  = 128 << 10
	agentRunBranchPrefix = "zenchron/agent-run/"
)

// shortcut: 200 runs × 3 attempts × 128 KiB bounds diff storage; add retention if run history grows.

type agentRun struct {
	ID                 string            `json:"id"`
	AgentID            string            `json:"agent_id"`
	AgentName          string            `json:"agent_name"`
	ProjectID          string            `json:"project_id"`
	ProjectName        string            `json:"project_name"`
	Branch             string            `json:"branch"`
	BaseBranch         string            `json:"base_branch,omitempty"`
	CommitSHA          string            `json:"commit_sha,omitempty"`
	DiffAttempt        int               `json:"diff_attempt,omitempty"`
	DiffAvailable      bool              `json:"diff_available,omitempty"`
	DiffTruncated      bool              `json:"diff_truncated,omitempty"`
	CanRequestChanges  bool              `json:"can_request_changes,omitempty"`
	PullRequestEnabled bool              `json:"pull_request_enabled,omitempty"`
	PullRequestURL     string            `json:"pull_request_url,omitempty"`
	PullRequestNumber  int               `json:"pull_request_number,omitempty"`
	PullRequestError   string            `json:"pull_request_error,omitempty"`
	WorkerID           string            `json:"worker_id"`
	WorkerName         string            `json:"worker_name"`
	Prompt             string            `json:"prompt"`
	Output             string            `json:"output,omitempty"`
	Error              string            `json:"error,omitempty"`
	Status             string            `json:"status"`
	CancelRequested    bool              `json:"cancel_requested,omitempty"`
	Attempts           int               `json:"attempts"`
	CreatedAt          time.Time         `json:"created_at"`
	UpdatedAt          time.Time         `json:"updated_at"`
	LeaseUntil         time.Time         `json:"-"`
	Profile            *agentProfile     `json:"profile,omitempty"`
	ReviewComments     []agentRunComment `json:"review_comments,omitempty"`
}

type agentRunStore struct {
	mu       sync.Mutex
	items    map[string]agentRun
	diffs    map[string]string
	path     string
	diffDir  string
	registry *workerRegistry
	agents   *agentProfileStore
}

type agentRunCommand struct {
	ID                 string       `json:"id"`
	ProjectID          string       `json:"project_id"`
	Branch             string       `json:"branch"`
	BaseBranch         string       `json:"base_branch"`
	Prompt             string       `json:"prompt"`
	Profile            agentProfile `json:"profile"`
	Attempts           int          `json:"attempts"`
	PublishPullRequest bool         `json:"publish_pull_request,omitempty"`
}

func newAgentRunStore(registry *workerRegistry, agents *agentProfileStore) *agentRunStore {
	return &agentRunStore{items: make(map[string]agentRun), diffs: make(map[string]string), registry: registry, agents: agents}
}

func openAgentRunStore(path string, registry *workerRegistry, agents *agentProfileStore) (*agentRunStore, error) {
	store := newAgentRunStore(registry, agents)
	store.path = path
	store.diffDir = path + ".diffs"
	var state struct {
		Version int                 `json:"version"`
		Items   map[string]agentRun `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load agent runs: %w", err)
	}
	if !exists {
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load agent runs: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredAgentRun(item) {
			return nil, fmt.Errorf("load agent runs: invalid record %q", id)
		}
		item.LeaseUntil = time.Time{}
		if item.Status == "running" {
			item.UpdatedAt = time.Now().UTC()
			if item.CancelRequested {
				item.Status, item.Error, item.CancelRequested = "cancelled", "Worker stopped after cancellation was requested.", false
			} else if item.Attempts >= 3 {
				item.Status, item.Error = "failed", "worker lease expired"
			} else {
				item.Status = "queued"
			}
		}
		state.Items[id] = item
	}
	store.items = state.Items
	if err := store.persistLocked(); err != nil {
		return nil, fmt.Errorf("recover agent run leases: %w", err)
	}
	return store, nil
}

func validStoredAgentRun(item agentRun) bool {
	id, err := hex.DecodeString(item.ID)
	agentID, agentErr := hex.DecodeString(item.AgentID)
	projectID, projectErr := hex.DecodeString(item.ProjectID)
	workerID, workerErr := hex.DecodeString(item.WorkerID)
	return err == nil && len(id) == 16 && agentErr == nil && len(agentID) == 16 &&
		projectErr == nil && len(projectID) == 16 && workerErr == nil && len(workerID) == 16 &&
		item.AgentName != "" && item.ProjectName != "" && item.WorkerName != "" &&
		validCommitSHA(item.CommitSHA) &&
		len(item.Prompt) > 0 && len(item.Prompt) <= 5000 && len(item.Output) <= 20000 && len(item.Error) <= 255 &&
		len(item.PullRequestURL) <= 2048 && len(item.PullRequestError) <= 255 && item.PullRequestNumber >= 0 &&
		(item.PullRequestURL == "" || (strings.HasPrefix(item.PullRequestURL, "https://github.com/") && item.PullRequestNumber > 0)) &&
		(item.Status == "queued" || item.Status == "running" || item.Status == "succeeded" || item.Status == "failed" ||
			item.Status == "cancelled") && (!item.CancelRequested || item.Status == "running") &&
		item.Attempts >= 0 && item.Attempts <= 3 && !item.CreatedAt.IsZero() && !item.UpdatedAt.IsZero() &&
		item.Profile != nil && validStoredAgentProfile(*item.Profile) && validAgentRunComments(item.ReviewComments)
}

func validCommitSHA(value string) bool {
	if value == "" {
		return true
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && (len(decoded) == 20 || len(decoded) == 32)
}

func (store *agentRunStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, struct {
		Version int                 `json:"version"`
		Items   map[string]agentRun `json:"items"`
	}{stateFileVersion, store.items})
}

func (store *agentRunStore) list(w http.ResponseWriter, _ *http.Request) {
	store.mu.Lock()
	if store.recoverExpiredLocked(time.Now().UTC()) {
		if err := store.persistLocked(); err != nil {
			store.mu.Unlock()
			http.Error(w, "could not persist expired agent run lease", http.StatusInternalServerError)
			return
		}
	}
	items := make([]agentRun, 0, len(store.items))
	for _, item := range store.items {
		item.CanRequestChanges = store.canRequestChanges(item)
		item.Profile = nil
		items = append(items, item)
	}
	store.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (store *agentRunStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AgentID   string `json:"agent_id"`
		ProjectID string `json:"project_id"`
		Prompt    string `json:"prompt"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.AgentID, input.ProjectID, input.Prompt = strings.ToLower(input.AgentID), strings.ToLower(input.ProjectID), strings.TrimSpace(input.Prompt)
	if !validHexID(input.AgentID) || !validHexID(input.ProjectID) || input.Prompt == "" || len(input.Prompt) > 5000 {
		http.Error(w, "agent, project, or prompt is invalid", http.StatusBadRequest)
		return
	}
	store.agents.mu.RLock()
	profile, exists := store.agents.items[input.AgentID]
	store.agents.mu.RUnlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	if profile.Status != "active" {
		http.Error(w, "agent profile is disabled", http.StatusConflict)
		return
	}
	store.registry.mu.RLock()
	var project projectRecord
	for _, item := range store.registry.projects {
		if item.ID == input.ProjectID && time.Since(item.LastSeen) <= workerOnlineWindow {
			project = item
			break
		}
	}
	store.registry.mu.RUnlock()
	if project.ID == "" {
		http.Error(w, "project has no online worker", http.StatusConflict)
		return
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		http.Error(w, "could not create agent run id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := agentRun{ID: hex.EncodeToString(id), AgentID: profile.ID, AgentName: profile.Name, ProjectID: project.ID,
		ProjectName: project.Name, Branch: agentRunBranch(hex.EncodeToString(id)), BaseBranch: project.Branch,
		WorkerID: project.WorkerID, WorkerName: project.WorkerName, Prompt: input.Prompt,
		Status: "queued", CreatedAt: now, UpdatedAt: now, Profile: &profile,
		PullRequestEnabled: store.registry.github.token != "" && isGitHubProject(project.GitRemote)}
	store.mu.Lock()
	if len(store.items) >= maxAgentRuns {
		store.mu.Unlock()
		http.Error(w, "agent run history is full", http.StatusInsufficientStorage)
		return
	}
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist agent run", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	response := item
	response.Profile = nil
	writeJSON(w, http.StatusAccepted, response)
}

func (store *agentRunStore) claim(w http.ResponseWriter, r *http.Request) {
	workerID := strings.ToLower(r.PathValue("id"))
	if !validHexID(workerID) {
		http.Error(w, "worker id is invalid", http.StatusBadRequest)
		return
	}
	store.registry.mu.RLock()
	worker, online := store.registry.workers[workerID]
	online = online && time.Since(worker.LastSeen) <= workerOnlineWindow
	store.registry.mu.RUnlock()
	if !online {
		http.Error(w, "worker is offline", http.StatusConflict)
		return
	}
	store.mu.Lock()
	now := time.Now().UTC()
	recovered := store.recoverExpiredLocked(now)
	var selected agentRun
	for _, item := range store.items {
		if item.WorkerID == workerID && item.Status == "queued" && (selected.ID == "" || item.CreatedAt.Before(selected.CreatedAt)) {
			selected = item
		}
	}
	if selected.ID == "" {
		if recovered {
			if err := store.persistLocked(); err != nil {
				store.mu.Unlock()
				http.Error(w, "could not persist expired agent run lease", http.StatusInternalServerError)
				return
			}
		}
		store.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if slices.Contains(selected.Profile.Tools, "code.write") &&
		(worker.AgentRuntimeEnabled == nil || !*worker.AgentRuntimeEnabled) {
		if recovered {
			if err := store.persistLocked(); err != nil {
				store.mu.Unlock()
				http.Error(w, "could not persist expired agent run lease", http.StatusInternalServerError)
				return
			}
		}
		store.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if selected.Branch == "" || selected.BaseBranch == "" {
		store.registry.mu.RLock()
		var project projectRecord
		for _, candidate := range store.registry.projects {
			if candidate.ID == selected.ProjectID && candidate.WorkerID == workerID &&
				time.Since(candidate.LastSeen) <= workerOnlineWindow {
				project = candidate
				break
			}
		}
		store.registry.mu.RUnlock()
		if project.ID == "" {
			store.mu.Unlock()
			http.Error(w, "agent run project is unavailable", http.StatusConflict)
			return
		}
		selected.Branch = agentRunBranch(selected.ID)
		selected.BaseBranch = project.Branch
	}
	selected.Status, selected.Attempts, selected.UpdatedAt, selected.LeaseUntil = "running", selected.Attempts+1, now, now.Add(agentRunLease)
	store.items[selected.ID] = selected
	if err := store.persistLocked(); err != nil {
		selected.Status = "queued"
		selected.LeaseUntil = time.Time{}
		selected.Attempts--
		store.items[selected.ID] = selected
		store.mu.Unlock()
		http.Error(w, "could not persist agent run lease", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, agentRunCommand{
		ID: selected.ID, ProjectID: selected.ProjectID, Branch: selected.Branch, BaseBranch: selected.BaseBranch,
		Prompt: agentRunPrompt(selected), Profile: *selected.Profile, Attempts: selected.Attempts,
		PublishPullRequest: selected.PullRequestEnabled,
	})
}

func isGitHubProject(remote string) bool {
	_, _, ok := githubRepositoryParts(remote)
	return ok
}

func agentRunBranch(runID string) string {
	return agentRunBranchPrefix + runID
}

func (store *agentRunStore) finish(w http.ResponseWriter, r *http.Request) {
	workerID, runID := strings.ToLower(r.PathValue("id")), strings.ToLower(r.PathValue("requestID"))
	if !validHexID(workerID) || !validHexID(runID) {
		http.Error(w, "worker or run id is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		Status           string  `json:"status"`
		Output           string  `json:"output"`
		Error            string  `json:"error"`
		Attempts         int     `json:"attempts"`
		CommitSHA        string  `json:"commit_sha"`
		Diff             *string `json:"diff"`
		Truncated        bool    `json:"diff_truncated"`
		BranchPushed     bool    `json:"branch_pushed"`
		BranchPushFailed bool    `json:"branch_push_failed"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if (input.Status != "succeeded" && input.Status != "failed" && input.Status != "cancelled") ||
		len(input.Output) > 20000 || len(input.Error) > 255 ||
		input.Diff != nil && len(*input.Diff) > maxAgentRunDiffSize || input.Attempts < 1 || input.Attempts > 3 {
		http.Error(w, "agent run result is invalid", http.StatusBadRequest)
		return
	}
	if !validCommitSHA(input.CommitSHA) {
		http.Error(w, "agent run commit id is invalid", http.StatusBadRequest)
		return
	}
	if input.BranchPushed && input.BranchPushFailed {
		http.Error(w, "agent branch publish result is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[runID]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.WorkerID != workerID || item.Status != "running" || item.Attempts != input.Attempts || time.Now().After(item.LeaseUntil) {
		store.mu.Unlock()
		http.Error(w, "agent run lease is no longer current", http.StatusConflict)
		return
	}
	if item.CancelRequested {
		input.Status, input.Output, input.Error = "cancelled", "", "Cancellation requested from dashboard."
		input.BranchPushed, input.BranchPushFailed = false, false
	}
	if (input.BranchPushed || input.BranchPushFailed) &&
		(!item.PullRequestEnabled || input.Status != "succeeded" || input.CommitSHA == "" || input.Truncated) {
		store.mu.Unlock()
		http.Error(w, "agent branch publish result is not allowed", http.StatusConflict)
		return
	}
	if input.Status == "cancelled" && !item.CancelRequested {
		store.mu.Unlock()
		http.Error(w, "agent run cancellation was not requested", http.StatusConflict)
		return
	}
	previous := item
	item.Status, item.Output, item.Error, item.CancelRequested, item.UpdatedAt, item.LeaseUntil =
		input.Status, input.Output, input.Error, false, time.Now().UTC(), time.Time{}
	if input.CommitSHA != "" {
		item.CommitSHA = input.CommitSHA
	}
	if input.Diff != nil {
		if err := store.writeDiff(runID, input.Attempts, *input.Diff); err != nil {
			store.mu.Unlock()
			http.Error(w, "could not persist agent run diff", http.StatusInternalServerError)
			return
		}
		item.DiffAttempt, item.DiffAvailable, item.DiffTruncated = input.Attempts, true, input.Truncated
	}
	store.items[runID] = item
	if err := store.persistLocked(); err != nil {
		store.items[runID] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist agent run result", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	if item.Status == "succeeded" && item.PullRequestEnabled {
		switch {
		case item.CommitSHA == "":
			item.PullRequestError = "No committed changes to publish."
		case input.BranchPushFailed:
			item.PullRequestError = "Git could not push the branch; the local diff is still available."
		case input.BranchPushed:
			item = store.createPullRequest(r.Context(), item)
		default:
			item.PullRequestError = "The worker did not publish the branch; the local diff is still available."
		}
		store.mu.Lock()
		store.items[runID] = item
		if err := store.persistLocked(); err != nil {
			store.mu.Unlock()
			http.Error(w, "pull request state could not be persisted", http.StatusInternalServerError)
			return
		}
		store.mu.Unlock()
	}
	item.Profile = nil
	writeJSON(w, http.StatusOK, item)
}

func (store *agentRunStore) createPullRequest(ctx context.Context, item agentRun) agentRun {
	store.registry.mu.RLock()
	var remote string
	for _, project := range store.registry.projects {
		if project.ID == item.ProjectID {
			remote = project.GitRemote
			break
		}
	}
	store.registry.mu.RUnlock()
	owner, repository, ok := githubRepositoryParts(remote)
	if !ok {
		item.PullRequestError = "The project no longer has a GitHub origin."
		return item
	}
	title := firstLine(item.Prompt)
	if title == "" {
		title = "Agent changes " + item.ID[:8]
	}
	if len([]rune(title)) > 200 {
		title = string([]rune(title)[:200])
	}
	body := strings.TrimSpace(item.Output)
	if body == "" {
		body = "Completed agent changes are ready for review."
	}
	body += "\n\nGenerated by Zenchron run `" + item.ID + "`."
	if bodyRunes := []rune(body); len(bodyRunes) > 10_000 {
		body = string(bodyRunes[:10_000])
	}
	pull, err := store.registry.github.createPullRequest(ctx, owner, repository, item.Branch, item.BaseBranch, title, body)
	if err != nil || pull.Number < 1 || !strings.HasPrefix(pull.HTMLURL, "https://github.com/") {
		item.PullRequestError = "The branch was pushed, but GitHub could not create the pull request."
		return item
	}
	item.PullRequestNumber, item.PullRequestURL, item.PullRequestError = pull.Number, pull.HTMLURL, ""
	return item
}

func firstLine(value string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(value), "\n")
	return strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "# "))
}

func (store *agentRunStore) diff(w http.ResponseWriter, r *http.Request) {
	runID := strings.ToLower(r.PathValue("id"))
	if !validHexID(runID) {
		http.Error(w, "agent run id is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[runID]
	var diff string
	if exists && item.DiffAvailable && store.diffDir == "" {
		diff, _ = store.diffs[fmt.Sprintf("%s-%d", runID, item.DiffAttempt)]
	}
	store.mu.Unlock()
	if !exists || !item.DiffAvailable || item.DiffAttempt < 1 || item.DiffAttempt > item.Attempts {
		http.NotFound(w, r)
		return
	}
	if store.diffDir != "" {
		path := filepath.Join(store.diffDir, fmt.Sprintf("%s-%d.diff", runID, item.DiffAttempt))
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxAgentRunDiffSize {
			http.Error(w, "agent run diff is unavailable", http.StatusInternalServerError)
			return
		}
		diffBytes, err := os.ReadFile(path)
		if err != nil || len(diffBytes) > maxAgentRunDiffSize {
			http.Error(w, "agent run diff is unavailable", http.StatusInternalServerError)
			return
		}
		diff = string(diffBytes)
	}
	writeJSON(w, http.StatusOK, struct {
		RunID     string `json:"run_id"`
		Diff      string `json:"diff"`
		Truncated bool   `json:"truncated"`
	}{runID, diff, item.DiffTruncated})
}

func (store *agentRunStore) writeDiff(runID string, attempt int, diff string) error {
	if store.diffDir == "" {
		store.diffs[fmt.Sprintf("%s-%d", runID, attempt)] = diff
		return nil
	}
	if err := os.MkdirAll(store.diffDir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(store.diffDir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("diff storage is not a directory")
	}
	temp, err := os.CreateTemp(store.diffDir, ".zenchron-diff-*.tmp")
	if err != nil {
		return err
	}
	path := temp.Name()
	defer os.Remove(path)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.WriteString(diff); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(path, filepath.Join(store.diffDir, fmt.Sprintf("%s-%d.diff", runID, attempt)))
}

func (store *agentRunStore) recoverExpiredLocked(now time.Time) bool {
	changed := false
	for id, item := range store.items {
		if item.Status == "running" && !now.Before(item.LeaseUntil) {
			item.LeaseUntil = time.Time{}
			item.UpdatedAt = now
			if item.CancelRequested {
				item.Status, item.Error, item.CancelRequested = "cancelled", "Worker stopped after cancellation was requested.", false
			} else if item.Attempts >= 3 {
				item.Status, item.Error = "failed", "worker lease expired"
			} else {
				item.Status = "queued"
			}
			store.items[id] = item
			changed = true
		}
	}
	return changed
}
