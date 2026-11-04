package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersistentMuxRestoresObjectivesAndWorkflows(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "state")
	server, err := newPersistentMux(dataDir)
	if err != nil {
		t.Fatalf("create first control plane: %v", err)
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/objectives", strings.NewReader(
		`{"title":"Persist this goal","owner":"Platform"}`,
	)))
	var createdObjective objective
	if err := json.NewDecoder(response.Body).Decode(&createdObjective); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create objective = %#v, decode error = %v, HTTP %d", createdObjective, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(
		`{"name":"Persisted reviewer","provider":"custom","model":"review-v1","tools":["git.read"]}`,
	)))
	var createdAgent agentProfile
	if err := json.NewDecoder(response.Body).Decode(&createdAgent); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create agent profile = %#v, decode error = %v, HTTP %d", createdAgent, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/products", strings.NewReader(
		`{"name":"Persisted product","repository_ids":["`+testProjectID+`"]}`,
	)))
	var createdProduct product
	if err := json.NewDecoder(response.Body).Decode(&createdProduct); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create product = %#v, decode error = %v, HTTP %d", createdProduct, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/objectives", strings.NewReader(
		`{"title":"Persisted linked objective","product_id":"`+createdProduct.ID+`"}`,
	)))
	var linkedObjective objective
	if err := json.NewDecoder(response.Body).Decode(&linkedObjective); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create linked objective = %#v, decode error = %v, HTTP %d", linkedObjective, err, response.Code)
	}
	response = httptest.NewRecorder()
	workerHeartbeat := `{"name":"persisted-worker","projects":[{"id":"` + testProjectID +
		`","name":"persisted-project","branch":"main"}]}`
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/heartbeat", strings.NewReader(workerHeartbeat)))
	if response.Code != http.StatusOK {
		t.Fatalf("register worktree worker returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/worktrees", strings.NewReader(
		`{"project_id":"`+testProjectID+`","branch":"feature/persisted"}`,
	)))
	var createdWorktree worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&createdWorktree); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue worktree = %#v, decode error = %v, HTTP %d", createdWorktree, err, response.Code)
	}
	for path, wantMode := range map[string]os.FileMode{
		dataDir: os.FileMode(0o700), filepath.Join(dataDir, "objectives.json"): os.FileMode(0o600),
		filepath.Join(dataDir, "workflows.json"): os.FileMode(0o600),
		filepath.Join(dataDir, "agents.json"):    os.FileMode(0o600),
		filepath.Join(dataDir, "products.json"):  os.FileMode(0o600),
		filepath.Join(dataDir, "worktrees.json"): os.FileMode(0o600),
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Errorf("stat state path %s: %v", path, err)
			continue
		}
		if info.Mode().Perm() != wantMode {
			t.Errorf("state path %s mode = %v, want %v", path, info.Mode().Perm(), wantMode)
		}
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workflows", nil))
	var workflows []workflow
	if err := json.NewDecoder(response.Body).Decode(&workflows); err != nil ||
		response.Code != http.StatusOK || len(workflows) == 0 {
		t.Fatalf("list workflows = %#v, decode error = %v, HTTP %d", workflows, err, response.Code)
	}
	wantWorkflow := workflows[0]
	wantWorkflow.Description = "Persisted workflow edit"
	body, err := json.Marshal(struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Status      string         `json:"status"`
		Nodes       []workflowNode `json:"nodes"`
		Edges       []workflowEdge `json:"edges"`
	}{wantWorkflow.Name, wantWorkflow.Description, wantWorkflow.Status, wantWorkflow.Nodes, wantWorkflow.Edges})
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workflows/"+wantWorkflow.ID, strings.NewReader(string(body))))
	if response.Code != http.StatusOK {
		t.Fatalf("update workflow returned HTTP %d: %s", response.Code, response.Body.String())
	}

	restarted, err := newPersistentMux(dataDir)
	if err != nil {
		t.Fatalf("restart control plane: %v", err)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/objectives", nil))
	var objectives []objective
	if err := json.NewDecoder(response.Body).Decode(&objectives); err != nil || response.Code != http.StatusOK ||
		len(objectives) != 2 || objectives[1].ID != createdObjective.ID || objectives[0].ID != linkedObjective.ID {
		t.Fatalf("restored objectives = %#v, decode error = %v, HTTP %d", objectives, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workflows", nil))
	var restoredWorkflows []workflow
	if err := json.NewDecoder(response.Body).Decode(&restoredWorkflows); err != nil || response.Code != http.StatusOK ||
		len(restoredWorkflows) == 0 || restoredWorkflows[0].Description != wantWorkflow.Description ||
		restoredWorkflows[0].Version != wantWorkflow.Version+1 {
		t.Fatalf("restored workflows = %#v, decode error = %v, HTTP %d", restoredWorkflows, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/agents", nil))
	var agents []agentProfile
	if err := json.NewDecoder(response.Body).Decode(&agents); err != nil || response.Code != http.StatusOK ||
		len(agents) != 1 || agents[0].ID != createdAgent.ID || agents[0].Name != createdAgent.Name {
		t.Fatalf("restored agent profiles = %#v, decode error = %v, HTTP %d", agents, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/products", nil))
	var products []product
	if err := json.NewDecoder(response.Body).Decode(&products); err != nil || response.Code != http.StatusOK ||
		len(products) != 1 || products[0].ID != createdProduct.ID ||
		len(products[0].RepositoryIDs) != 1 || products[0].RepositoryIDs[0] != testProjectID {
		t.Fatalf("restored products = %#v, decode error = %v, HTTP %d", products, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/objectives", nil))
	var restoredObjectives []objective
	if err := json.NewDecoder(response.Body).Decode(&restoredObjectives); err != nil || response.Code != http.StatusOK ||
		len(restoredObjectives) != 2 || restoredObjectives[0].ID != linkedObjective.ID ||
		restoredObjectives[0].ProductID != createdProduct.ID || restoredObjectives[0].Product != createdProduct.Name {
		t.Fatalf("restored objectives = %#v, decode error = %v, HTTP %d", restoredObjectives, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/worktrees", nil))
	var worktrees []worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&worktrees); err != nil || response.Code != http.StatusOK ||
		len(worktrees) != 1 || worktrees[0].ID != createdWorktree.ID || worktrees[0].Status != "queued" {
		t.Fatalf("restored worktree requests = %#v, decode error = %v, HTTP %d", worktrees, err, response.Code)
	}
	response = httptest.NewRecorder()
	restarted.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workers", nil))
	var workers []workerStatus
	if err := json.NewDecoder(response.Body).Decode(&workers); err != nil || len(workers) != 0 {
		t.Fatalf("workers should remain transient after restart, got %#v: %v", workers, err)
	}
}

func TestPersistentMuxRejectsUnsupportedStateVersion(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.WriteFile(dataDir+"/objectives.json", []byte(`{"version":99,"items":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newPersistentMux(dataDir); err == nil {
		t.Fatal("newPersistentMux accepted an unsupported objectives file version")
	}
}
