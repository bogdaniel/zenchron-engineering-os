package main

import (
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

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	agentRunLease       = 3 * time.Minute
	maxAgentRuns        = 200
	maxAgentRunAttempts = 3
	maxAgentRunDiffSize = 128 << 10
	maxIssueContextSize = 12_000
)

// Publication outcomes are separate from the run status and from verification.
const (
	publicationPublished         = "published"
	publicationPushFailed        = "push_failed"
	publicationPullRequestFailed = "pull_request_failed"
	publicationNoChanges         = "no_changes"
)

// ponytail: 200 runs × 3 attempts × 128 KiB bounds diff storage; add retention if run history grows.

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
	Repository         string            `json:"repository,omitempty"`
	IssueNumber        int               `json:"issue_number,omitempty"`
	IssueTitle         string            `json:"issue_title,omitempty"`
	IssueURL           string            `json:"issue_url,omitempty"`
	IssueContext       string            `json:"issue_context,omitempty"`
	BaseCommit         string            `json:"base_commit,omitempty"`
	Provider           string            `json:"provider,omitempty"`
	ProviderVersion    string            `json:"provider_version,omitempty"`
	TerminationReason  string            `json:"termination_reason,omitempty"`
	Verification       string            `json:"verification,omitempty"`
	Publication        string            `json:"publication,omitempty"`
	Usage              *workerapi.Usage  `json:"usage,omitempty"`
	AttemptLog         []agentRunAttempt `json:"attempt_log,omitempty"`
	ImportedReviewID   int64             `json:"imported_review_id,omitempty"`
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
	eventDir string
	events   map[string][]agentRunEvent
	registry *workerRegistry
	agents   *agentProfileStore
}

// agentRunAttempt records one claim of a run by a worker and how that attempt ended.
type agentRunAttempt struct {
	Attempt           int        `json:"attempt"`
	WorkerID          string     `json:"worker_id"`
	StartedAt         time.Time  `json:"started_at"`
	FinishedAt        *time.Time `json:"finished_at,omitempty"`
	Status            string     `json:"status,omitempty"`
	TerminationReason string     `json:"termination_reason,omitempty"`
	CommitSHA         string     `json:"commit_sha,omitempty"`
}

// publicAgentRun removes the fields that are only needed to build the worker command.
func publicAgentRun(item agentRun) agentRun {
	item.Profile, item.IssueContext = nil, ""
	return item
}

// update applies one validated change to a run and persists it, or leaves the run untouched.
func (store *agentRunStore) update(runID string, change func(item *agentRun) (int, string)) (agentRun, int, string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	previous, exists := store.items[runID]
	if !exists {
		return agentRun{}, http.StatusNotFound, "agent run not found"
	}
	item := previous
	item.AttemptLog = slices.Clone(previous.AttemptLog)
	if status, message := change(&item); status != 0 {
		return agentRun{}, status, message
	}
	store.items[runID] = item
	if err := store.persistLocked(); err != nil {
		store.items[runID] = previous
		return agentRun{}, http.StatusInternalServerError, "could not persist agent run"
	}
	return item, 0, ""
}

// closeAttempt records how the current attempt ended.
func (item *agentRun) closeAttempt(now time.Time, status, reason string) {
	if len(item.AttemptLog) == 0 || item.AttemptLog[len(item.AttemptLog)-1].FinishedAt != nil {
		return
	}
	last := &item.AttemptLog[len(item.AttemptLog)-1]
	last.FinishedAt, last.Status, last.TerminationReason, last.CommitSHA = &now, status, reason, item.CommitSHA
}

func newAgentRunStore(registry *workerRegistry, agents *agentProfileStore) *agentRunStore {
	return &agentRunStore{items: make(map[string]agentRun), diffs: make(map[string]string),
		events: make(map[string][]agentRunEvent), registry: registry, agents: agents}
}

func openAgentRunStore(path string, registry *workerRegistry, agents *agentProfileStore) (*agentRunStore, error) {
	store := newAgentRunStore(registry, agents)
	store.path = path
	store.diffDir = path + ".diffs"
	store.eventDir = path + ".events"
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
			item.expireLease(time.Now().UTC())
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
		item.Attempts >= 0 && item.Attempts <= maxAgentRunAttempts && !item.CreatedAt.IsZero() && !item.UpdatedAt.IsZero() &&
		item.Profile != nil && validStoredAgentProfile(*item.Profile) && validAgentRunComments(item.ReviewComments) &&
		validCommitSHA(item.BaseCommit) && (item.Repository == "" || validGitRemote(item.Repository)) &&
		item.IssueNumber >= 0 && len(item.IssueContext) <= maxIssueContextSize && len(item.IssueTitle) <= 300 &&
		workerapi.ValidTerminationReason(item.TerminationReason) && workerapi.ValidVerification(item.Verification) &&
		len(item.AttemptLog) <= maxAgentRunAttempts && validPublication(item.Publication) &&
		len(item.Provider) <= 100 && len(item.ProviderVersion) <= 100 && item.DiffAttempt >= 0 && item.DiffAttempt <= item.Attempts
}

func validPublication(publication string) bool {
	switch publication {
	case "", publicationPublished, publicationPushFailed, publicationPullRequestFailed, publicationNoChanges:
		return true
	default:
		return false
	}
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

// authorized hides a run from callers who may not touch its repository, exactly as if it did not exist.
func (store *agentRunStore) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store.mu.Lock()
		item, exists := store.items[strings.ToLower(r.PathValue("id"))]
		store.mu.Unlock()
		if exists && !accessFor(r).allows(item.Repository) {
			http.NotFound(w, r)
			return
		}
		next(w, r)
	}
}

func (store *agentRunStore) list(w http.ResponseWriter, r *http.Request) {
	access := accessFor(r)
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
		if !access.allows(item.Repository) {
			continue
		}
		item.CanRequestChanges = store.canRequestChanges(item)
		items = append(items, publicAgentRun(item))
	}
	store.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	writeJSON(w, http.StatusOK, items)
}

func (store *agentRunStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		AgentID     string `json:"agent_id"`
		ProjectID   string `json:"project_id"`
		Prompt      string `json:"prompt"`
		IssueNumber int    `json:"issue_number"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.AgentID, input.ProjectID, input.Prompt = strings.ToLower(input.AgentID), strings.ToLower(input.ProjectID), strings.TrimSpace(input.Prompt)
	if !validHexID(input.AgentID) || !validHexID(input.ProjectID) || len(input.Prompt) > 5000 ||
		input.IssueNumber < 0 || (input.Prompt == "" && input.IssueNumber == 0) {
		http.Error(w, "agent, project, prompt, or issue is invalid", http.StatusBadRequest)
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
	// Only the coding CLIs execute runs; any other profile would wait in the queue for ever.
	if !workerapi.IsCLIProvider(profile.Provider) {
		http.Error(w, "this agent profile's provider has no execution adapter; use codex-cli or claude-code", http.StatusConflict)
		return
	}
	project, online := store.registry.onlineProject(input.ProjectID)
	if !online || !accessFor(r).allows(project.GitRemote) {
		http.Error(w, "project has no online worker", http.StatusConflict)
		return
	}
	if !accessFor(r).mayDispatchTo(project.WorkerID) {
		http.Error(w, "this worker belongs to another user", http.StatusForbidden)
		return
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		http.Error(w, "could not create agent run id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := agentRun{ID: hex.EncodeToString(id), AgentID: profile.ID, AgentName: profile.Name, ProjectID: project.ID,
		ProjectName: project.Name, Repository: project.GitRemote, Branch: workerapi.AgentRunBranch(hex.EncodeToString(id)),
		BaseBranch: project.Branch, WorkerID: project.WorkerID, WorkerName: project.WorkerName, Prompt: input.Prompt,
		Provider: profile.Provider, Status: "queued", CreatedAt: now, UpdatedAt: now, Profile: &profile,
		PullRequestEnabled: store.registry.github.authConfigured() && isGitHubProject(project.GitRemote)}
	if input.IssueNumber > 0 {
		if status, message := store.attachIssue(r.Context(), &item, input.IssueNumber); status != 0 {
			http.Error(w, message, status)
			return
		}
	}
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
	writeJSON(w, http.StatusAccepted, publicAgentRun(item))
}

// workerRunsProfile reports whether a worker has the execution provider an agent profile names.
func workerRunsProfile(worker workerRecord, profile agentProfile) bool {
	return slices.ContainsFunc(worker.Providers, func(status workerapi.ProviderStatus) bool {
		return status.ID == profile.Provider && status.Ready
	})
}

func (store *agentRunStore) claim(w http.ResponseWriter, r *http.Request) {
	workerID := strings.ToLower(r.PathValue("id"))
	if !validHexID(workerID) {
		http.Error(w, "worker id is invalid", http.StatusBadRequest)
		return
	}
	worker, online := store.registry.onlineWorker(workerID)
	if !online {
		http.Error(w, "worker is offline", http.StatusConflict)
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	now := time.Now().UTC()
	recovered := store.recoverExpiredLocked(now)
	access := accessFor(r)
	var selected agentRun
	for _, item := range store.items {
		// A run waits in the queue until its worker reports the provider it needs, and is never handed to
		// a worker whose grant for the repository has been removed since the run was created.
		if item.WorkerID == workerID && item.Status == "queued" && workerRunsProfile(worker, *item.Profile) &&
			access.allows(item.Repository) &&
			(selected.ID == "" || item.CreatedAt.Before(selected.CreatedAt)) {
			selected = item
		}
	}
	if selected.ID == "" {
		if recovered {
			if err := store.persistLocked(); err != nil {
				http.Error(w, "could not persist expired agent run lease", http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	previous := selected
	selected.Status, selected.Attempts, selected.UpdatedAt, selected.LeaseUntil = "running", selected.Attempts+1, now, now.Add(agentRunLease)
	selected.AttemptLog = append(slices.Clone(selected.AttemptLog), agentRunAttempt{
		Attempt: selected.Attempts, WorkerID: workerID, StartedAt: now,
	})
	store.items[selected.ID] = selected
	if err := store.persistLocked(); err != nil {
		store.items[selected.ID] = previous
		http.Error(w, "could not persist agent run lease", http.StatusInternalServerError)
		return
	}
	store.appendEventsLocked(selected.ID, selected.Attempts, workerapi.AgentRunEvent{
		Kind: "status", Message: fmt.Sprintf("Attempt %d claimed by worker %s", selected.Attempts, worker.Name),
	})
	profile := selected.Profile
	writeJSON(w, http.StatusOK, workerapi.AgentRunCommand{
		ID: selected.ID, ProjectID: selected.ProjectID, Branch: selected.Branch, BaseBranch: selected.BaseBranch,
		Prompt: agentRunPrompt(selected), Attempts: selected.Attempts, PublishPullRequest: selected.PullRequestEnabled,
		Profile: workerapi.AgentProfile{Provider: profile.Provider, Model: profile.Model,
			SystemPrompt: profile.SystemPrompt, GoalPrompt: profile.GoalPrompt, Tools: profile.Tools},
	})
}

func isGitHubProject(remote string) bool {
	_, _, ok := githubRepositoryParts(remote)
	return ok
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
	if err := ensurePrivateDirectory(store.diffDir); err != nil {
		return err
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
			item.AttemptLog = slices.Clone(item.AttemptLog)
			item.expireLease(now)
			store.items[id] = item
			changed = true
		}
	}
	return changed
}

// expireLease ends an attempt whose worker stopped renewing it. Losing a worker is an infrastructure
// failure, so the run is queued again until its attempts are used up.
func (item *agentRun) expireLease(now time.Time) {
	item.LeaseUntil, item.UpdatedAt = time.Time{}, now
	item.closeAttempt(now, "lease_expired", workerapi.TerminationLeaseLost)
	switch {
	case item.CancelRequested:
		item.Status, item.Error, item.CancelRequested = "cancelled", "Worker stopped after cancellation was requested.", false
	case item.Attempts >= maxAgentRunAttempts:
		item.Status, item.Error, item.TerminationReason = "failed", "worker lease expired", workerapi.TerminationLeaseLost
	default:
		item.Status = "queued"
	}
}
