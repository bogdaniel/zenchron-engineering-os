package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// ponytail: cap graphs at 100 nodes and 200 edges for browser layout; move layout server-side if limits need to grow.
const (
	maxWorkflowNodes = 100
	maxWorkflowEdges = 200
)

type workflowPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type workflowNodeData struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type workflowNode struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Position workflowPosition `json:"position"`
	Data     workflowNodeData `json:"data"`
}

type workflowEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label"`
}

type workflow struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Status      string         `json:"status"`
	Version     int            `json:"version"`
	Nodes       []workflowNode `json:"nodes"`
	Edges       []workflowEdge `json:"edges"`
	UpdatedAt   time.Time      `json:"updated_at"`
	// CreatedBy is the GitHub login that created the workflow under an access policy. Every signed-in
	// user may read a workflow; only its creator or an administrator may change it.
	CreatedBy string `json:"created_by,omitempty"`
}

type workflowStore struct {
	mu    sync.RWMutex
	items map[string]workflow
	path  string
}

func newWorkflowStore() *workflowStore {
	now := time.Now().UTC()
	initial := workflow{
		ID: "pr-review-release", Name: "PR Review & Release Orchestration",
		Description: "Review changes, validate quality, and gate releases.", Status: "draft", Version: 1,
		UpdatedAt: now,
		Nodes: []workflowNode{
			{ID: "trigger", Type: "trigger", Data: workflowNodeData{
				Label: "Trigger", Description: "Pull request opened or updated",
			}},
			{ID: "planner", Type: "planner", Data: workflowNodeData{Label: "Planner", Description: "Create an execution plan"}},
			{ID: "router", Type: "agent-router", Data: workflowNodeData{
				Label: "Agent Router", Description: "Route work to the right agents",
			}},
			{ID: "review", Type: "code-reviewer", Data: workflowNodeData{
				Label: "Code Reviewer", Description: "Review changes and report findings",
			}},
			{ID: "tests", Type: "test-generator", Data: workflowNodeData{
				Label: "Test Generator", Description: "Generate and run focused tests",
			}},
			{ID: "coverage", Type: "coverage-analyzer", Data: workflowNodeData{
				Label: "Coverage Analyzer", Description: "Measure test coverage and quality",
			}},
			{ID: "approval", Type: "human-approval", Data: workflowNodeData{
				Label: "Human Approval", Description: "Request reviewer approval",
			}},
			{ID: "merge", Type: "merge-gate", Data: workflowNodeData{
				Label: "Merge Gate", Description: "Apply repository and policy checks",
			}},
			{ID: "publish", Type: "publish-report", Data: workflowNodeData{
				Label: "Publish Report", Description: "Publish a release report",
			}},
		},
		Edges: []workflowEdge{
			{ID: "e-trigger-planner", Source: "trigger", Target: "planner"},
			{ID: "e-planner-router", Source: "planner", Target: "router"},
			{ID: "e-router-review", Source: "router", Target: "review"},
			{ID: "e-router-tests", Source: "router", Target: "tests"},
			{ID: "e-router-coverage", Source: "router", Target: "coverage"},
			{ID: "e-review-approval", Source: "review", Target: "approval"},
			{ID: "e-tests-approval", Source: "tests", Target: "approval"},
			{ID: "e-coverage-approval", Source: "coverage", Target: "approval"},
			{ID: "e-approval-merge", Source: "approval", Target: "merge"},
			{ID: "e-merge-publish", Source: "merge", Target: "publish"},
		},
	}
	return &workflowStore{items: map[string]workflow{initial.ID: initial}}
}

func openWorkflowStore(path string) (*workflowStore, error) {
	store := newWorkflowStore()
	store.path = path
	var state struct {
		Version int                 `json:"version"`
		Items   map[string]workflow `json:"items"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load workflows: %w", err)
	}
	if !exists {
		store.mu.Lock()
		if err := store.persistLocked(); err != nil {
			store.mu.Unlock()
			return nil, fmt.Errorf("initialize workflows: %w", err)
		}
		store.mu.Unlock()
		return store, nil
	}
	if state.Version != stateFileVersion || state.Items == nil {
		return nil, fmt.Errorf("load workflows: unsupported or invalid state")
	}
	for id, item := range state.Items {
		if id != item.ID || !validStoredWorkflow(item) {
			return nil, fmt.Errorf("load workflows: invalid record %q", id)
		}
	}
	store.items = state.Items
	return store, nil
}

func (store *workflowStore) persistLocked() error {
	if store.path == "" {
		return nil
	}
	return writeStateFile(store.path, struct {
		Version int                 `json:"version"`
		Items   map[string]workflow `json:"items"`
	}{stateFileVersion, store.items})
}

func validStoredWorkflow(item workflow) bool {
	return item.ID != "" && len(item.ID) <= 64 && strings.TrimSpace(item.Name) != "" &&
		len(item.Name) <= 200 && len(item.Description) <= 1000 && (item.Status == "draft" || item.Status == "active") &&
		item.Version > 0 && !item.UpdatedAt.IsZero() && validateWorkflowGraph(item.Nodes, item.Edges)
}

func (store *workflowStore) list(w http.ResponseWriter, _ *http.Request) {
	store.mu.RLock()
	items := make([]workflow, 0, len(store.items))
	for _, item := range store.items {
		items = append(items, item)
	}
	store.mu.RUnlock()
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	writeJSON(w, http.StatusOK, items)
}

func (store *workflowStore) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 200 || len(input.Description) > 1000 {
		http.Error(w, "workflow name or description is invalid", http.StatusBadRequest)
		return
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "could not create workflow id", http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	item := workflow{
		ID: hex.EncodeToString(idBytes), Name: input.Name, Description: input.Description,
		Status: "draft", Version: 1, UpdatedAt: now, CreatedBy: accessFor(r).creator(),
		Nodes: []workflowNode{
			{ID: "trigger", Type: "trigger", Data: workflowNodeData{Label: "Trigger", Description: "Start this workflow"}},
			{ID: "planner", Type: "planner", Data: workflowNodeData{Label: "Planner", Description: "Plan the work"}},
		},
		Edges: []workflowEdge{{ID: "e-trigger-planner", Source: "trigger", Target: "planner"}},
	}
	store.mu.Lock()
	store.items[item.ID] = item
	if err := store.persistLocked(); err != nil {
		delete(store.items, item.ID)
		store.mu.Unlock()
		http.Error(w, "could not persist workflow", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusCreated, item)
}

func (store *workflowStore) save(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Status      string         `json:"status"`
		Nodes       []workflowNode `json:"nodes"`
		Edges       []workflowEdge `json:"edges"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	if input.Name == "" || len(input.Name) > 200 || len(input.Description) > 1000 {
		http.Error(w, "workflow name or description is invalid", http.StatusBadRequest)
		return
	}
	if input.Status != "draft" && input.Status != "active" {
		http.Error(w, "workflow status must be draft or active", http.StatusBadRequest)
		return
	}
	if !validateWorkflowGraph(input.Nodes, input.Edges) {
		http.Error(w, "workflow graph is invalid", http.StatusBadRequest)
		return
	}
	id := r.PathValue("id")
	store.mu.Lock()
	item, exists := store.items[id]
	if !exists {
		store.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if !accessFor(r).owns(item.CreatedBy) {
		store.mu.Unlock()
		http.Error(w, "only the workflow's creator or an administrator can change it", http.StatusForbidden)
		return
	}
	previous := item
	item.Name = input.Name
	item.Description = input.Description
	item.Status = input.Status
	item.Nodes = input.Nodes
	item.Edges = input.Edges
	item.Version++
	item.UpdatedAt = time.Now().UTC()
	store.items[id] = item
	if err := store.persistLocked(); err != nil {
		store.items[id] = previous
		store.mu.Unlock()
		http.Error(w, "could not persist workflow", http.StatusInternalServerError)
		return
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, item)
}

func validateWorkflowGraph(nodes []workflowNode, edges []workflowEdge) bool {
	if len(nodes) == 0 || len(nodes) > maxWorkflowNodes || len(edges) > maxWorkflowEdges {
		return false
	}
	nodeIDs := make(map[string]struct{}, len(nodes))
	hasTrigger := false
	for _, node := range nodes {
		if node.ID == "" || len(node.ID) > 64 || !validWorkflowNodeType(node.Type) ||
			len(strings.TrimSpace(node.Data.Label)) == 0 || len(node.Data.Label) > 100 || len(node.Data.Description) > 500 ||
			math.Abs(node.Position.X) > 1_000_000 || math.Abs(node.Position.Y) > 1_000_000 {
			return false
		}
		if _, exists := nodeIDs[node.ID]; exists {
			return false
		}
		nodeIDs[node.ID] = struct{}{}
		hasTrigger = hasTrigger || node.Type == "trigger"
	}
	if !hasTrigger {
		return false
	}
	edgeIDs := make(map[string]struct{}, len(edges))
	for _, edge := range edges {
		if edge.ID == "" || len(edge.ID) > 128 || edge.Source == edge.Target || len(edge.Label) > 100 {
			return false
		}
		if _, exists := edgeIDs[edge.ID]; exists {
			return false
		}
		if _, exists := nodeIDs[edge.Source]; !exists {
			return false
		}
		if _, exists := nodeIDs[edge.Target]; !exists {
			return false
		}
		edgeIDs[edge.ID] = struct{}{}
	}
	return true
}

func validWorkflowNodeType(nodeType string) bool {
	switch nodeType {
	case "trigger", "planner", "agent-router", "agent-task", "code-reviewer", "test-generator",
		"coverage-analyzer", "human-approval", "merge-gate", "publish-report", "condition", "loop":
		return true
	default:
		return false
	}
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONRequestBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		http.Error(w, "request body must contain one JSON value", http.StatusBadRequest)
		return false
	}
	return true
}
