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
	agentRunLease = 3 * time.Minute
	maxAgentRuns  = 200
	// Four claims allow one exact-candidate publish pass before and after one change-request pass.
	maxAgentRunAttempts       = 4
	maxAgentRunDiffSize       = 128 << 10
	maxAgentRunStateFileSize  = 64 << 20
	maxIssueContextSize       = 12_000
	runAdmissionPausedMessage = "run admission is paused for a managed release transition"
)

// Publication outcomes are separate from the run status and from verification.
const (
	publicationPublished         = "published"
	publicationPushFailed        = "push_failed"
	publicationPullRequestFailed = "pull_request_failed"
	publicationNoChanges         = "no_changes"
	publicationAwaitingAuthority = "awaiting_authorization"
)

// ponytail: 64 MiB run-state ceiling; externalize large run fields before increasing run or field limits.

type agentRun struct {
	ID                        string                     `json:"id"`
	AgentID                   string                     `json:"agent_id"`
	AgentName                 string                     `json:"agent_name"`
	ProjectID                 string                     `json:"project_id"`
	ProjectName               string                     `json:"project_name"`
	Branch                    string                     `json:"branch"`
	BaseBranch                string                     `json:"base_branch,omitempty"`
	CommitSHA                 string                     `json:"commit_sha,omitempty"`
	CommitTreeSHA             string                     `json:"commit_tree_sha,omitempty"`
	DiffAttempt               int                        `json:"diff_attempt,omitempty"`
	DiffAvailable             bool                       `json:"diff_available,omitempty"`
	DiffTruncated             bool                       `json:"diff_truncated,omitempty"`
	CanRequestChanges         bool                       `json:"can_request_changes,omitempty"`
	PullRequestEnabled        bool                       `json:"pull_request_enabled,omitempty"`
	PublishOnly               bool                       `json:"publish_only,omitempty"`
	PullRequestURL            string                     `json:"pull_request_url,omitempty"`
	PullRequestNumber         int                        `json:"pull_request_number,omitempty"`
	PullRequestError          string                     `json:"pull_request_error,omitempty"`
	BranchPushed              bool                       `json:"branch_pushed,omitempty"`
	PublicationAuthorizations []publicationAuthorization `json:"publication_authorizations,omitempty"`
	Repository                string                     `json:"repository,omitempty"`
	IssueNumber               int                        `json:"issue_number,omitempty"`
	IssueTitle                string                     `json:"issue_title,omitempty"`
	IssueURL                  string                     `json:"issue_url,omitempty"`
	IssueContext              string                     `json:"issue_context,omitempty"`
	BaseCommit                string                     `json:"base_commit,omitempty"`
	Provider                  string                     `json:"provider,omitempty"`
	ProviderVersion           string                     `json:"provider_version,omitempty"`
	TerminationReason         string                     `json:"termination_reason,omitempty"`
	Verification              string                     `json:"verification,omitempty"`
	Publication               string                     `json:"publication,omitempty"`
	Usage                     *workerapi.Usage           `json:"usage,omitempty"`
	AttemptLog                []agentRunAttempt          `json:"attempt_log,omitempty"`
	ImportedReviewID          int64                      `json:"imported_review_id,omitempty"`
	// CreatedBy is the GitHub login that started the run under an access policy.
	CreatedBy string `json:"created_by,omitempty"`
	// Checks and GitHubReviews are what GitHub webhooks reported for the published commit and pull request.
	Checks          []runCheck  `json:"checks,omitempty"`
	GitHubReviews   []runReview `json:"github_reviews,omitempty"`
	WorkerID        string      `json:"worker_id"`
	WorkerName      string      `json:"worker_name"`
	Prompt          string      `json:"prompt"`
	Output          string      `json:"output,omitempty"`
	Error           string      `json:"error,omitempty"`
	Status          string      `json:"status"`
	CancelRequested bool        `json:"cancel_requested,omitempty"`
	Attempts        int         `json:"attempts"`
	CreatedAt       time.Time   `json:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at"`
	LeaseUntil      time.Time   `json:"-"`
	// Publishing is set between a pushed result and GitHub's answer about the pull request. It is not
	// persisted: after a restart an unanswered publication is a failed one that can be retried.
	Publishing     bool              `json:"-"`
	Profile        *agentProfile     `json:"profile,omitempty"`
	ReviewComments []agentRunComment `json:"review_comments,omitempty"`
	// GraphID and UnitKey name the WorkUnit this run executes; both are empty for a run started directly.
	GraphID string `json:"graph_id,omitempty"`
	UnitKey string `json:"unit_key,omitempty"`
	// ObjectivePlanner runs are claimable only after a durable objective plan links their ID.
	ObjectivePlanner bool `json:"objective_planner,omitempty"`
	// ReviewRecovery marks the one automatic same-assignment retry allowed after an invocation failure.
	ReviewRecovery bool `json:"review_recovery,omitempty"`
	// Merge makes this an integration run that combines admitted candidates instead of starting a provider.
	Merge []workerapi.MergeInput `json:"merge,omitempty"`
	// Result is the typed result reported by attempt ResultAttempt; the WorkGraph admits it.
	Result        string `json:"result,omitempty"`
	ResultAttempt int    `json:"result_attempt,omitempty"`
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
	// webhookSecret authenticates GitHub deliveries; empty disables the webhook endpoint.
	webhookSecret []byte
	deliveries    *webhookDeliveries
	// graphs advances WorkGraphs from run outcomes; nil when no orchestration store is wired.
	graphs   *workGraphStore
	quiesced bool
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
	item.Profile, item.IssueContext, item.Result, item.PublishOnly = nil, "", "", false
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
	item.PublicationAuthorizations = slices.Clone(previous.PublicationAuthorizations)
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
	// An invalid secret is reported at startup; here it only leaves the endpoint disabled.
	secret, _ := loadWebhookSecret()
	return &agentRunStore{items: make(map[string]agentRun), diffs: make(map[string]string),
		events: make(map[string][]agentRunEvent), registry: registry, agents: agents,
		webhookSecret: secret, deliveries: &webhookDeliveries{}}
}

func openAgentRunStore(path string, registry *workerRegistry, agents *agentProfileStore) (*agentRunStore, error) {
	store := newAgentRunStore(registry, agents)
	store.path = path
	store.diffDir = path + ".diffs"
	store.eventDir = path + ".events"
	var err error
	if store.deliveries, err = openWebhookDeliveries(path + ".deliveries"); err != nil {
		return nil, err
	}
	var state struct {
		Version int                 `json:"version"`
		Items   map[string]agentRun `json:"items"`
	}
	exists, err := loadStateFileWithLimit(path, &state, maxAgentRunStateFileSize)
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
		validCommitSHA(item.CommitSHA) && validCommitSHA(item.CommitTreeSHA) &&
		(item.CommitTreeSHA == "" || item.CommitSHA != "") &&
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
		validRunObservations(item.Checks, item.GitHubReviews) && len(item.CreatedBy) <= 100 &&
		validPublicationAuthorizations(item.PublicationAuthorizations, item.Attempts) &&
		(!item.PublishOnly || (item.Status == "queued" || item.Status == "running") && item.PullRequestEnabled &&
			item.publicationAuthorized(item.CommitSHA)) &&
		len(item.Provider) <= 100 && len(item.ProviderVersion) <= 100 && item.DiffAttempt >= 0 && item.DiffAttempt <= item.Attempts &&
		(item.GraphID == "" || validHexID(item.GraphID)) && len(item.UnitKey) <= maxUnitKeySize &&
		len(item.Result) <= workerapi.MaxResultSize && item.ResultAttempt >= 0 && item.ResultAttempt <= item.Attempts &&
		validMergeInputs(item.Merge)
}

func validMergeInputs(inputs []workerapi.MergeInput) bool {
	return len(inputs) <= workerapi.MaxMergeInputs && !slices.ContainsFunc(inputs, func(input workerapi.MergeInput) bool {
		return len(input.Branch) == 0 || len(input.Branch) > 255 || input.Commit == "" || !validCommitSHA(input.Commit)
	})
}

func validPublication(publication string) bool {
	switch publication {
	case "", publicationPublished, publicationPushFailed, publicationPullRequestFailed, publicationNoChanges,
		publicationAwaitingAuthority:
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
	return writeStateFileWithLimit(store.path, struct {
		Version int                 `json:"version"`
		Items   map[string]agentRun `json:"items"`
	}{stateFileVersion, store.items}, maxAgentRunStateFileSize)
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
	profile, exists = store.agents.activeSnapshot(profile)
	if !exists {
		http.Error(w, "agent profile or its linked persona is disabled", http.StatusConflict)
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
	item := agentRun{AgentID: profile.ID, AgentName: profile.Name, ProjectID: project.ID,
		ProjectName: project.Name, Repository: project.GitRemote,
		BaseBranch: project.Branch, WorkerID: project.WorkerID, WorkerName: project.WorkerName, Prompt: input.Prompt,
		Provider: profile.Provider, Profile: &profile, CreatedBy: accessFor(r).user}
	if input.IssueNumber > 0 {
		if status, message := store.attachIssue(r.Context(), &item, input.IssueNumber); status != 0 {
			http.Error(w, message, status)
			return
		}
	}
	item, status, message := store.enqueue(item)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	writeJSON(w, http.StatusAccepted, publicAgentRun(item))
}

// publishable reports whether a successful run for a repository can become a GitHub pull request.
func (store *agentRunStore) publishable(repository string) bool {
	return store.registry.github.authConfigured() && isGitHubProject(repository)
}

// enqueue gives a run its identity and branch and adds it to the queue. It is the only way a run is created.
func (store *agentRunStore) enqueue(item agentRun) (agentRun, int, string) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return agentRun{}, http.StatusInternalServerError, "could not create agent run id"
	}
	now := time.Now().UTC()
	item.ID, item.Status, item.CreatedAt, item.UpdatedAt = hex.EncodeToString(id), "queued", now, now
	item.Branch = workerapi.AgentRunBranch(item.ID)
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.quiesced {
		return agentRun{}, http.StatusServiceUnavailable, runAdmissionPausedMessage
	}
	if len(store.items) >= maxAgentRuns {
		return agentRun{}, http.StatusInsufficientStorage, "agent run history is full"
	}
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		return agentRun{}, http.StatusInternalServerError, "could not persist agent run"
	}
	return item, 0, ""
}

func (store *agentRunStore) isQuiesced() bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.quiesced
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
	// A worker asking for work is what moves WorkGraphs forward: finished units are admitted and the
	// runnable frontier is queued before the oldest queued run is leased.
	if !store.graphs.reconcileAll() {
		http.Error(w, "could not persist run recovery before claiming work", http.StatusInternalServerError)
		return
	}
	store.graphs.mu.Lock()
	selected, status, message := store.lease(worker, accessFor(r), store.graphs.plannerRunIDsLocked())
	store.graphs.mu.Unlock()
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	if selected.ID == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	profile := selected.Profile
	writeJSON(w, http.StatusOK, workerapi.AgentRunCommand{
		ID: selected.ID, ProjectID: selected.ProjectID, Branch: selected.Branch, BaseBranch: selected.BaseBranch,
		Prompt: agentRunPrompt(selected) + store.graphs.runContext(selected), Attempts: selected.Attempts,
		PublishPullRequest: selected.PublishOnly, Merge: selected.Merge,
		PublishCommit: store.publicationCommit(selected),
		PublishOnly:   selected.PublishOnly,
		Profile: workerapi.AgentProfile{Provider: profile.Provider, Model: profile.Model,
			SystemPrompt: profile.SystemPrompt, GoalPrompt: profile.GoalPrompt, Tools: profile.Tools,
			Persona: func() *workerapi.AgentPersona {
				if profile.PersonaSnapshot == nil {
					return nil
				}
				persona := profile.PersonaSnapshot
				return &workerapi.AgentPersona{ID: persona.ID, Name: persona.Name, Role: persona.Role,
					Responsibilities: persona.Responsibilities, Instructions: persona.Instructions,
					Behavior: persona.Behavior, ReviewSpecialization: persona.ReviewSpecialization, Version: persona.Version}
			}()},
	})
}

func (store *agentRunStore) publicationCommit(run agentRun) string {
	if !run.PublishOnly || !run.PullRequestEnabled || !run.publicationAuthorized(run.CommitSHA) {
		return ""
	}
	if run.GraphID == "" {
		return run.CommitSHA
	}
	if store.graphs == nil {
		return ""
	}
	return store.graphs.publishCommit(run)
}

// lease hands the worker its oldest queued run, or a run with an empty id when nothing is queued for it.
func (store *agentRunStore) lease(worker workerRecord, access requestAccess, plannerRunIDs map[string]struct{}) (agentRun, int, string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	now := time.Now().UTC()
	recovered := store.recoverExpiredLocked(now)
	if store.quiesced {
		if recovered {
			if err := store.persistLocked(); err != nil {
				return agentRun{}, http.StatusInternalServerError, "could not persist expired agent run lease"
			}
		}
		return agentRun{}, 0, ""
	}
	var selected agentRun
	for _, item := range store.items {
		// A run waits in the queue until its worker reports the provider it needs, and is never handed to
		// a worker whose grant for the repository has been removed since the run was created. An
		// integration run starts no provider.
		_, plannerLinked := plannerRunIDs[item.ID]
		if item.WorkerID == worker.ID && item.Status == "queued" && (!item.ObjectivePlanner || plannerLinked) &&
			(len(item.Merge) > 0 || workerRunsProfile(worker, *item.Profile)) &&
			access.allows(item.Repository) &&
			(selected.ID == "" || item.CreatedAt.Before(selected.CreatedAt)) {
			selected = item
		}
	}
	if selected.ID == "" {
		if recovered {
			if err := store.persistLocked(); err != nil {
				return agentRun{}, http.StatusInternalServerError, "could not persist expired agent run lease"
			}
		}
		return agentRun{}, 0, ""
	}
	previous := selected
	selected.Status, selected.Attempts, selected.UpdatedAt, selected.LeaseUntil = "running", selected.Attempts+1, now, now.Add(agentRunLease)
	selected.AttemptLog = append(slices.Clone(selected.AttemptLog), agentRunAttempt{
		Attempt: selected.Attempts, WorkerID: worker.ID, StartedAt: now,
	})
	store.items[selected.ID] = selected
	if err := store.persistLocked(); err != nil {
		store.items[selected.ID] = previous
		return agentRun{}, http.StatusInternalServerError, "could not persist agent run lease"
	}
	store.appendEventsLocked(selected.ID, selected.Attempts, workerapi.AgentRunEvent{
		Kind: "status", Message: fmt.Sprintf("Attempt %d claimed by worker %s", selected.Attempts, worker.Name),
	})
	return selected, 0, ""
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
	store.mu.Unlock()
	if !exists || !item.DiffAvailable || item.DiffAttempt < 1 || item.DiffAttempt > item.Attempts {
		http.NotFound(w, r)
		return
	}
	diff, err := store.readDiff(item)
	if err != nil {
		http.Error(w, "agent run diff is unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		RunID     string `json:"run_id"`
		Diff      string `json:"diff"`
		Truncated bool   `json:"truncated"`
	}{runID, diff, item.DiffTruncated})
}

func (store *agentRunStore) get(runID string) (agentRun, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	item, exists := store.items[runID]
	return item, exists
}

// unitRuns returns the runs that execute the units of one WorkGraph, by run id.
func (store *agentRunStore) unitRuns(graphID string) map[string]agentRun {
	store.mu.Lock()
	defer store.mu.Unlock()
	return unitRunsForGraph(store.items, graphID)
}

func unitRunsForGraph(items map[string]agentRun, graphID string) map[string]agentRun {
	runs := map[string]agentRun{}
	for id, item := range items {
		if item.GraphID == graphID {
			runs[id] = item
		}
	}
	return runs
}

// graphPublicationInProgress reports an external PR operation that graph cancellation cannot undo.
func (store *agentRunStore) graphPublicationInProgress(graphID string) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, item := range store.items {
		publishingRun := item.Status == "running" && item.PublishOnly
		if item.GraphID == graphID && (item.Publishing || item.PullRequestURL != "" || publishingRun) {
			return true
		}
	}
	return false
}

// readDiff returns the stored diff of a run's latest attempt that captured one.
func (store *agentRunStore) readDiff(item agentRun) (string, error) {
	if store.diffDir == "" {
		store.mu.Lock()
		defer store.mu.Unlock()
		return store.diffs[fmt.Sprintf("%s-%d", item.ID, item.DiffAttempt)], nil
	}
	path := filepath.Join(store.diffDir, fmt.Sprintf("%s-%d.diff", item.ID, item.DiffAttempt))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxAgentRunDiffSize {
		return "", fmt.Errorf("agent run diff is not a readable file within the size limit")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read agent run diff: %w", err)
	}
	return string(data), nil
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
		item.Status, item.Error, item.CancelRequested, item.PublishOnly = "cancelled", "Worker stopped after cancellation was requested.", false, false
	case item.Attempts >= maxAgentRunAttempts:
		item.Status, item.Error, item.TerminationReason, item.PublishOnly = "failed", "worker lease expired", workerapi.TerminationLeaseLost, false
	default:
		item.Status = "queued"
	}
}

func validHexID(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 16
}
