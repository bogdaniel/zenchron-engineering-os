package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	workerOnlineWindow   = 15 * time.Second
	maxJSONRequestBody   = 1 << 20
	maxProjectsPerWorker = 1000
)

type workerRegistry struct {
	mu       sync.RWMutex
	workers  map[string]workerRecord
	projects map[string]projectRecord
	github   gitHubClient
	runs     *agentRunStore
}

// shortcut: worker presence resets on restart; persist it only if offline history becomes a requirement.

type workerRecord struct {
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	LastSeen            time.Time `json:"last_seen"`
	AgentRuntimeEnabled *bool     `json:"agent_runtime_enabled,omitempty"`
}

type projectRecord struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Branch     string    `json:"branch"`
	GitRemote  string    `json:"git_remote,omitempty"`
	WorkerID   string    `json:"worker_id"`
	WorkerName string    `json:"worker_name"`
	LastSeen   time.Time `json:"last_seen"`
}

type workerStatus struct {
	workerRecord
	Status string `json:"status"`
}

type projectStatus struct {
	projectRecord
	WorkerStatus string `json:"worker_status"`
}

func newMux() http.Handler {
	registry := newWorkerRegistry()
	products := newProductStore()
	agents := newAgentProfileStore()
	return newMuxWithStores(
		newObjectiveStore(products), newWorkflowStore(), agents, products, registry,
		newWorktreeStore(registry), newAgentRunStore(registry, agents),
	)
}

func newPersistentMux(dataDir string) (http.Handler, error) {
	absoluteDir, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if err := os.MkdirAll(absoluteDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	products, err := openProductStore(filepath.Join(absoluteDir, "products.json"))
	if err != nil {
		return nil, err
	}
	objectives, err := openObjectiveStore(filepath.Join(absoluteDir, "objectives.json"), products)
	if err != nil {
		return nil, err
	}
	workflows, err := openWorkflowStore(filepath.Join(absoluteDir, "workflows.json"))
	if err != nil {
		return nil, err
	}
	agents, err := openAgentProfileStore(filepath.Join(absoluteDir, "agents.json"))
	if err != nil {
		return nil, err
	}
	registry := newWorkerRegistry()
	worktrees, err := openWorktreeStore(filepath.Join(absoluteDir, "worktrees.json"), registry)
	if err != nil {
		return nil, err
	}
	runs, err := openAgentRunStore(filepath.Join(absoluteDir, "agent-runs.json"), registry, agents)
	if err != nil {
		return nil, err
	}
	return newMuxWithStores(objectives, workflows, agents, products, registry, worktrees, runs), nil
}

func newWorkerRegistry() *workerRegistry {
	return &workerRegistry{
		workers:  make(map[string]workerRecord),
		projects: make(map[string]projectRecord),
		github:   newGitHubClient(),
	}
}

func newMuxWithStores(
	objectives *objectiveStore, workflows *workflowStore, agents *agentProfileStore, products *productStore,
	registry *workerRegistry, worktrees *worktreeStore, runs *agentRunStore,
) http.Handler {
	registry.runs = runs
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/v1/workers", registry.listWorkers)
	mux.HandleFunc("GET /api/v1/workers/healthz", registry.ready)
	mux.HandleFunc("GET /api/v1/projects", registry.listProjects)
	mux.HandleFunc("GET /api/v1/projects/{id}/pull-requests", registry.listGitHubPullRequests)
	mux.HandleFunc("GET /api/v1/projects/{id}/pull-request-history", registry.listGitHubPullRequestHistory)
	mux.HandleFunc("GET /api/v1/projects/{id}/workflow-run-history", registry.listGitHubWorkflowRunHistory)
	mux.HandleFunc("GET /api/v1/projects/{id}/pull-requests/{number}/diff", registry.getGitHubPullRequestDiff)
	mux.HandleFunc("POST /api/v1/projects/{id}/pull-requests/{number}/reviews", registry.reviewGitHubPullRequest)
	mux.HandleFunc("GET /api/v1/projects/{id}/issues", registry.listGitHubIssues)
	mux.HandleFunc("POST /api/v1/projects/{id}/issues/{number}/comments", registry.commentGitHubIssue)
	mux.HandleFunc("PATCH /api/v1/projects/{id}/issues/{number}", registry.updateGitHubIssue)
	mux.HandleFunc("PUT /api/v1/workers/{id}/heartbeat", registry.heartbeat)
	mux.HandleFunc("GET /api/v1/objectives", objectives.list)
	mux.HandleFunc("POST /api/v1/objectives", objectives.create)
	mux.HandleFunc("PATCH /api/v1/objectives/{id}", objectives.update)
	mux.HandleFunc("GET /api/v1/workflows", workflows.list)
	mux.HandleFunc("POST /api/v1/workflows", workflows.create)
	mux.HandleFunc("PUT /api/v1/workflows/{id}", workflows.save)
	mux.HandleFunc("GET /api/v1/agents", agents.list)
	mux.HandleFunc("POST /api/v1/agents", agents.create)
	mux.HandleFunc("PUT /api/v1/agents/{id}", agents.update)
	mux.HandleFunc("GET /api/v1/products", products.list)
	mux.HandleFunc("POST /api/v1/products", products.create)
	mux.HandleFunc("PUT /api/v1/products/{id}", products.update)
	mux.HandleFunc("GET /api/v1/worktrees", worktrees.list)
	mux.HandleFunc("POST /api/v1/worktrees", worktrees.create)
	mux.HandleFunc("POST /api/v1/worktrees/{id}/cancel", worktrees.cancel)
	mux.HandleFunc("POST /api/v1/workers/{id}/worktrees/claim", worktrees.claim)
	mux.HandleFunc("PUT /api/v1/workers/{id}/worktrees/{requestID}", worktrees.finish)
	mux.HandleFunc("GET /api/v1/agent-runs", runs.list)
	mux.HandleFunc("GET /api/v1/agent-runs/{id}/diff", runs.diff)
	mux.HandleFunc("POST /api/v1/agent-runs/{id}/cancel", runs.cancel)
	mux.HandleFunc("POST /api/v1/agent-runs/{id}/comments", runs.addComment)
	mux.HandleFunc("POST /api/v1/agent-runs/{id}/request-changes", runs.requestChanges)
	mux.HandleFunc("POST /api/v1/agent-runs", runs.create)
	mux.HandleFunc("POST /api/v1/workers/{id}/agent-runs/claim", runs.claim)
	mux.HandleFunc("GET /api/v1/workers/{id}/agent-runs/{requestID}/cancellation", runs.cancellationStatus)
	mux.HandleFunc("PUT /api/v1/workers/{id}/agent-runs/{requestID}", runs.finish)
	return mux
}

func (registry *workerRegistry) ready(w http.ResponseWriter, _ *http.Request) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for _, worker := range registry.workers {
		if time.Since(worker.LastSeen) <= workerOnlineWindow {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
	}
	http.Error(w, "no workers online", http.StatusServiceUnavailable)
}

func (registry *workerRegistry) listWorkers(w http.ResponseWriter, _ *http.Request) {
	registry.mu.RLock()
	workers := make([]workerStatus, 0, len(registry.workers))
	for _, worker := range registry.workers {
		status := "offline"
		if time.Since(worker.LastSeen) <= workerOnlineWindow {
			status = "online"
		}
		workers = append(workers, workerStatus{workerRecord: worker, Status: status})
	}
	registry.mu.RUnlock()
	sort.Slice(workers, func(i, j int) bool {
		return workers[i].Name < workers[j].Name
	})
	writeJSON(w, http.StatusOK, workers)
}

func (registry *workerRegistry) listProjects(w http.ResponseWriter, _ *http.Request) {
	registry.mu.RLock()
	projects := make([]projectStatus, 0, len(registry.projects))
	for _, project := range registry.projects {
		status := "offline"
		if time.Since(project.LastSeen) <= workerOnlineWindow {
			status = "online"
		}
		projects = append(projects, projectStatus{projectRecord: project, WorkerStatus: status})
	}
	registry.mu.RUnlock()
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].Name == projects[j].Name {
			return projects[i].WorkerID < projects[j].WorkerID
		}
		return projects[i].Name < projects[j].Name
	})
	writeJSON(w, http.StatusOK, projects)
}

func (registry *workerRegistry) heartbeat(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.PathValue("id"))
	decodedID, err := hex.DecodeString(id)
	if err != nil || len(decodedID) != 16 {
		http.Error(w, "worker id must be 32 hexadecimal characters", http.StatusBadRequest)
		return
	}

	var request struct {
		Name                string `json:"name"`
		AgentRuntimeEnabled *bool  `json:"agent_runtime_enabled"`
		Projects            []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Branch string `json:"branch"`
			Remote string `json:"git_remote"`
		} `json:"projects"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONRequestBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid heartbeat body", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "heartbeat body must contain one JSON object", http.StatusBadRequest)
		return
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" || len(request.Name) > 128 {
		http.Error(w, "worker name must be between 1 and 128 bytes", http.StatusBadRequest)
		return
	}
	if len(request.Projects) > maxProjectsPerWorker {
		http.Error(w, "too many projects in heartbeat", http.StatusBadRequest)
		return
	}

	seen := make(map[string]struct{}, len(request.Projects))
	for i := range request.Projects {
		project := &request.Projects[i]
		project.ID = strings.ToLower(project.ID)
		decodedProjectID, err := hex.DecodeString(project.ID)
		if err != nil || len(decodedProjectID) != 16 {
			http.Error(w, "project id must be 32 hexadecimal characters", http.StatusBadRequest)
			return
		}
		project.Name = strings.TrimSpace(project.Name)
		if project.Name == "" || len(project.Name) > 255 {
			http.Error(w, "project name must be between 1 and 255 bytes", http.StatusBadRequest)
			return
		}
		if len(project.Branch) > 255 || strings.ContainsAny(project.Branch, "\r\n") {
			http.Error(w, "project branch is invalid", http.StatusBadRequest)
			return
		}
		project.Branch = strings.TrimSpace(project.Branch)
		if project.Branch == "" {
			project.Branch = "Unknown"
		}
		if !validGitRemote(project.Remote) {
			http.Error(w, "project Git remote is invalid", http.StatusBadRequest)
			return
		}
		if _, exists := seen[project.ID]; exists {
			http.Error(w, "project ids must be unique per worker", http.StatusBadRequest)
			return
		}
		seen[project.ID] = struct{}{}
	}

	now := time.Now().UTC()
	worker := workerRecord{
		ID: id, Name: request.Name, LastSeen: now, AgentRuntimeEnabled: request.AgentRuntimeEnabled,
	}
	registry.mu.Lock()
	registry.workers[id] = worker
	for key, project := range registry.projects {
		if project.WorkerID == id {
			delete(registry.projects, key)
		}
	}
	for _, project := range request.Projects {
		key := id + ":" + project.ID
		registry.projects[key] = projectRecord{
			ID: project.ID, Name: project.Name, Branch: project.Branch, GitRemote: project.Remote,
			WorkerID: id, WorkerName: request.Name, LastSeen: now,
		}
	}
	registry.mu.Unlock()
	writeJSON(w, http.StatusOK, worker)
}

func validGitRemote(remote string) bool {
	if remote == "" {
		return true
	}
	if len(remote) > 512 || strings.ContainsAny(remote, "@?#\\\r\n\t ") {
		return false
	}
	host, path, ok := strings.Cut(remote, "/")
	parsed, err := url.Parse("https://" + host)
	if !ok || err != nil || parsed.Hostname() == "" || parsed.Path != "" || path == "" {
		return false
	}
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
