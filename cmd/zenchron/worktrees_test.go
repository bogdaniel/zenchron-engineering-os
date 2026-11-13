package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testWorkerID  = "0123456789abcdef0123456789abcdef"
	testProjectID = "abcdef0123456789abcdef0123456789"
)

func TestWorktreeRequestClaimFinishAndCancel(t *testing.T) {
	server := newMux()
	heartbeat := `{"name":"dev-worker","projects":[{"id":"` + testProjectID +
		`","name":"sample-repo","branch":"main"}]}`
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/heartbeat", strings.NewReader(heartbeat)))
	if response.Code != http.StatusOK {
		t.Fatalf("register worker = HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/worktrees", strings.NewReader(
		`{"project_id":"`+testProjectID+`","branch":"feature/fix-login"}`,
	)))
	var request worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&request); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue worktree = %#v, decode error = %v, HTTP %d", request, err, response.Code)
	}
	if request.Status != "queued" || request.BaseBranch != "main" || request.WorkerID != testWorkerID {
		t.Fatalf("queued request = %#v, want queued main-base request for registered worker", request)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/workers/"+testWorkerID+"/worktrees/claim", nil))
	var claimed worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&claimed); err != nil || response.Code != http.StatusOK {
		t.Fatalf("claim worktree = %#v, decode error = %v, HTTP %d", claimed, err, response.Code)
	}
	if claimed.ID != request.ID || claimed.Status != "preparing" || claimed.Attempts != 1 ||
		!claimed.LeaseUntil.IsZero() {
		t.Fatalf("claimed request = %#v, want preparing with a hidden active lease", claimed)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/workers/"+testWorkerID+"/worktrees/claim", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("duplicate claim returned HTTP %d, want no second delivery: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/worktrees/"+request.ID,
		strings.NewReader(`{"status":"ready","attempts":1}`)))
	var completed worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&completed); err != nil || response.Code != http.StatusOK {
		t.Fatalf("finish worktree = %#v, decode error = %v, HTTP %d", completed, err, response.Code)
	}
	if completed.Status != "ready" || completed.Branch != "feature/fix-login" {
		t.Fatalf("completed request = %#v, want ready feature branch", completed)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/worktrees", strings.NewReader(`{"project_id":"`+testProjectID+`","branch":"feature/cancel-me"}`)))
	var queued worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&queued); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue cancel candidate = %#v, decode error = %v, HTTP %d", queued, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/worktrees/"+queued.ID+"/cancel", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"cancelled"`) {
		t.Fatalf("cancel queued request returned HTTP %d: %s", response.Code, response.Body.String())
	}
}

func TestExpiredWorktreeLeaseRecoversAfterControlPlaneRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worktrees.json")
	registry := newWorkerRegistry()
	worktrees := newWorktreeStore(registry)
	worktrees.path = path
	products := newProductStore()
	server := newMuxWithStores(
		newObjectiveStore(products), newWorkflowStore(), newAgentProfileStore(), products, registry, worktrees,
		newAgentRunStore(registry, newAgentProfileStore()),
	)
	call := func(method, url, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(method, url, strings.NewReader(body)))
		return response
	}
	heartbeat := `{"name":"dev-worker","projects":[{"id":"` + testProjectID +
		`","name":"sample-repo","branch":"main"}]}`
	if response := call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat); response.Code != http.StatusOK {
		t.Fatalf("register worker = HTTP %d: %s", response.Code, response.Body.String())
	}
	response := call(http.MethodPost, "/api/v1/worktrees", `{"project_id":"`+testProjectID+`","branch":"feature/retry"}`)
	var queued worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&queued); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue worktree = %#v, decode error = %v, HTTP %d", queued, err, response.Code)
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/worktrees/claim", "")
	var firstAttempt worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&firstAttempt); err != nil || response.Code != http.StatusOK {
		t.Fatalf("claim worktree = %#v, decode error = %v, HTTP %d", firstAttempt, err, response.Code)
	}
	worktrees.mu.Lock()
	request := worktrees.items[queued.ID]
	request.LeaseUntil = time.Now().UTC().Add(-time.Second)
	worktrees.items[queued.ID] = request
	if err := worktrees.persistLocked(); err != nil {
		worktrees.mu.Unlock()
		t.Fatalf("persist expired lease: %v", err)
	}
	worktrees.mu.Unlock()

	restartedRegistry := newWorkerRegistry()
	restartedWorktrees, err := openWorktreeStore(path, restartedRegistry)
	if err != nil {
		t.Fatalf("restore worktree queue: %v", err)
	}
	restartedProducts := newProductStore()
	server = newMuxWithStores(
		newObjectiveStore(restartedProducts), newWorkflowStore(), newAgentProfileStore(), restartedProducts,
		restartedRegistry, restartedWorktrees, newAgentRunStore(restartedRegistry, newAgentProfileStore()),
	)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/heartbeat", strings.NewReader(heartbeat)))
	if response.Code != http.StatusOK {
		t.Fatalf("worker reconnect after restart = HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/workers/"+testWorkerID+"/worktrees/claim", nil))
	var secondAttempt worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&secondAttempt); err != nil || response.Code != http.StatusOK {
		t.Fatalf("reclaim expired worktree = %#v, decode error = %v, HTTP %d", secondAttempt, err, response.Code)
	}
	if secondAttempt.ID != queued.ID || secondAttempt.Status != "preparing" || secondAttempt.Attempts != 2 {
		t.Fatalf("reclaimed request = %#v, want same request on attempt 2", secondAttempt)
	}
	finish := "/api/v1/workers/" + testWorkerID + "/worktrees/" + queued.ID
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, finish,
		strings.NewReader(`{"status":"ready","attempts":1}`)))
	if response.Code != http.StatusConflict {
		t.Fatalf("stale completion returned HTTP %d, want 409: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, finish,
		strings.NewReader(`{"status":"ready","attempts":2}`)))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"ready"`) {
		t.Fatalf("current completion returned HTTP %d: %s", response.Code, response.Body.String())
	}
}

func TestWorktreeRejectsMismatchedAttemptResult(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/heartbeat", strings.NewReader(
			`{"name":"dev-worker","projects":[{"id":"`+testProjectID+`","name":"sample-repo","branch":"main"}]}`,
		)))
	if response.Code != http.StatusOK {
		t.Fatalf("register worker returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/worktrees", strings.NewReader(
		`{"project_id":"`+testProjectID+`","branch":"feature/stale-ack"}`,
	)))
	var queued worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&queued); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue worktree = %#v, decode error = %v, HTTP %d", queued, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/v1/workers/"+testWorkerID+"/worktrees/claim", nil))
	var claimed worktreeRequest
	if err := json.NewDecoder(response.Body).Decode(&claimed); err != nil || response.Code != http.StatusOK {
		t.Fatalf("claim worktree = %#v, decode error = %v, HTTP %d", claimed, err, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/workers/"+testWorkerID+"/worktrees/"+queued.ID,
		strings.NewReader(`{"status":"ready","attempts":0}`)))
	if response.Code != http.StatusConflict {
		t.Fatalf("stale worktree result returned HTTP %d, want 409: %s", response.Code, response.Body.String())
	}
}

func TestWorktreeRequestRejectsUnknownProjectsAndMalformedBranches(t *testing.T) {
	server := newMux()
	for _, body := range []string{
		`{"project_id":"` + testProjectID + `","branch":" "}`,
		`{"project_id":"bad","branch":"feature/okay"}`,
		`{"project_id":"` + testProjectID + `","branch":"feature/okay","unknown":true}`,
		`{"project_id":"` + testProjectID + `","branch":"-rf"}`,
		`{"project_id":"` + testProjectID + `","branch":"feature..x"}`,
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/worktrees", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Errorf("create worktree with body %s returned HTTP %d, want 400", body, response.Code)
		}
	}
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/worktrees", strings.NewReader(
		`{"project_id":"`+testProjectID+`","branch":"feature/okay"}`,
	)))
	if response.Code != http.StatusConflict {
		t.Fatalf("create request for unavailable project = HTTP %d, want 409", response.Code)
	}
}

func TestValidBranchInput(t *testing.T) {
	for _, test := range []struct {
		branch string
		want   bool
	}{
		{"feature/login", true},
		{"zenchron/agent-run/0123456789abcdef0123456789abcdef", true},
		{"fix-123_a.b", true},
		{strings.Repeat("a", 255), true},
		{"", false},
		{" lead", false},
		{strings.Repeat("a", 256), false},
		{"line\nbreak", false},
		{"-rf", false},
		{"/lead", false},
		{"trail/", false},
		{"trail.", false},
		{"feature..x", false},
		{"feature//x", false},
		{"x@{1}", false},
		{".hidden", false},
		{"feature/.hidden", false},
		{"topic.lock", false},
		{"topic.lock/x", false},
		{"a b", false},
		{"a~b", false},
		{"a^b", false},
		{"a:b", false},
		{"a?b", false},
		{"a*b", false},
		{"a[b", false},
		{`a\b`, false},
		{"a\tb", false},
		{"a\x7fb", false},
		{"a\u0085b", false},
	} {
		if got := validBranchInput(test.branch); got != test.want {
			t.Errorf("validBranchInput(%q) = %t, want %t", test.branch, got, test.want)
		}
	}
}

func TestWorktreeStoreLoadsBranchesQueuedBeforeGitRefValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worktrees.json")
	now := time.Now().UTC()
	store := newWorktreeStore(newWorkerRegistry())
	store.path = path
	store.items[testProjectID] = worktreeRequest{
		ID: testProjectID, ProjectID: testProjectID, ProjectName: "demo", WorkerID: testWorkerID, WorkerName: "local",
		Branch: "a b", BaseBranch: "main", Status: "failed", CreatedAt: now, UpdatedAt: now,
	}
	if err := store.persistLocked(); err != nil {
		t.Fatalf("persist worktree request: %v", err)
	}
	if _, err := openWorktreeStore(path, newWorkerRegistry()); err != nil {
		t.Fatalf("open store holding a previously accepted branch: %v", err)
	}
}
