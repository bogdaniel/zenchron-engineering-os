package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestAgentRunSnapshotPersistsAtMaximumRunCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-runs.json")
	store := newAgentRunStore(newWorkerRegistry(), newAgentProfileStore())
	store.path = path
	now := time.Now().UTC()
	agentID := strings.Repeat("a", 32)
	for index := 0; index < maxAgentRuns; index++ {
		id := fmt.Sprintf("%032x", index+1)
		profile := agentProfile{ID: agentID, Name: "Engineer", Provider: workerapi.ProviderCodex, Model: "default",
			Status: "active", SystemPrompt: strings.Repeat("p", 20_000), GoalPrompt: strings.Repeat("g", 5_000),
			Version: 1, UpdatedAt: now, Tools: []string{"code.write"}}
		store.items[id] = agentRun{ID: id, AgentID: agentID, AgentName: "Engineer", ProjectID: testProjectID,
			ProjectName: "platform", Branch: "zenchron/agent-run/" + id, WorkerID: testWorkerID, WorkerName: "worker",
			Prompt: strings.Repeat("t", 5_000), Output: strings.Repeat("o", 20_000),
			IssueContext: strings.Repeat("i", maxIssueContextSize), Result: strings.Repeat("r", workerapi.MaxResultSize),
			ResultAttempt: 1, Status: "succeeded", Attempts: 1, CreatedAt: now, UpdatedAt: now, Profile: &profile}
	}
	if err := store.persistLocked(); err != nil {
		t.Fatalf("persist maximum run snapshot: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxStateFileSize || info.Size() > maxAgentRunStateFileSize {
		t.Fatalf("maximum run snapshot size = %v, error %v", info, err)
	}
	reopened, err := openAgentRunStore(path, store.registry, store.agents)
	if err != nil {
		t.Fatalf("reopen maximum run snapshot: %v", err)
	}
	if len(reopened.items) != maxAgentRuns {
		t.Fatalf("reopened %d runs, want %d", len(reopened.items), maxAgentRuns)
	}
	if _, status, message := reopened.update("00000000000000000000000000000001", func(item *agentRun) (int, string) {
		item.Output = "updated"
		return 0, ""
	}); status != 0 {
		t.Fatalf("update maximum run snapshot returned HTTP %d: %s", status, message)
	}
}

const (
	testWorkerID  = "0123456789abcdef0123456789abcdef"
	testProjectID = "abcdef0123456789abcdef0123456789"
)

func TestAgentRunQueuePersistsAndFencesClaims(t *testing.T) {
	registry := newWorkerRegistry()
	agents := newAgentProfileStore()
	profile := agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Review", Provider: workerapi.ProviderCodex, Model: "default",
		Status: "active", SystemPrompt: "Review changes", Version: 1, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"}}
	agents.items[profile.ID] = profile
	store, err := openAgentRunStore(filepath.Join(t.TempDir(), "agent-runs.json"), registry, agents)
	if err != nil {
		t.Fatal(err)
	}
	server := newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), agents,
		newProductStore(), registry, store)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, jsonRequest(method, path, strings.NewReader(body)))
		return response
	}
	heartbeat := `{"name":"worker","projects":[{"id":"` + testProjectID + `","name":"repo","branch":"main"}]}`
	if response := call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat); response.Code != http.StatusOK {
		t.Fatalf("heartbeat returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response := call(http.MethodPost, "/api/v1/agent-runs", `{"agent_id":"`+profile.ID+`","project_id":"`+testProjectID+`","prompt":"Review this repo"}`)
	var queued agentRun
	if err := json.NewDecoder(response.Body).Decode(&queued); err != nil || response.Code != http.StatusAccepted {
		t.Fatalf("queue run = %#v, decode error = %v, HTTP %d", queued, err, response.Code)
	}
	if queued.Profile != nil || queued.Status != "queued" || queued.Branch != workerapi.AgentRunBranch(queued.ID) || queued.BaseBranch != "main" {
		t.Fatalf("public run leaked profile or has wrong status: %#v", queued)
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	if response.Code != http.StatusNoContent {
		t.Fatalf("a worker without the provider claimed a run: HTTP %d", response.Code)
	}
	heartbeat = `{"name":"worker","providers":[{"id":"codex-cli","version":"1","ready":true}],"projects":[{"id":"` + testProjectID + `","name":"repo","branch":"main"}]}`
	if response := call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat); response.Code != http.StatusOK {
		t.Fatalf("provider-ready heartbeat returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	var first workerapi.AgentRunCommand
	if err := json.NewDecoder(response.Body).Decode(&first); err != nil || response.Code != http.StatusOK {
		t.Fatalf("claim run = %#v, decode error = %v, HTTP %d", first, err, response.Code)
	}
	if first.ID != queued.ID || first.Attempts != 1 || first.Profile.SystemPrompt != profile.SystemPrompt ||
		first.Branch != queued.Branch || first.BaseBranch != "main" || first.Profile.Tools[0] != "code.write" {
		t.Fatalf("worker claim = %#v", first)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID,
		`{"status":"succeeded","output":"Review complete","attempts":0}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid attempt result returned HTTP %d", response.Code)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID,
		`{"status":"succeeded","output":"Review complete","attempts":1,"commit_sha":"invalid"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid commit id returned HTTP %d", response.Code)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID,
		`{"status":"succeeded","attempts":1,"commit_tree_sha":"`+strings.Repeat("b", 40)+`"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("tree without commit returned HTTP %d", response.Code)
	}
	tooLargeDiff, err := json.Marshal(map[string]any{
		"status": "succeeded", "attempts": 1, "diff": strings.Repeat("x", maxAgentRunDiffSize+1),
	})
	if err != nil {
		t.Fatalf("encode oversized diff: %v", err)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID, string(tooLargeDiff))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized diff returned HTTP %d", response.Code)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID,
		`{"status":"failed","error":"First attempt failed","attempts":1,"diff":"diff --git a/README.md b/README.md\n+Updated\n"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("finish run returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = call(http.MethodGet, "/api/v1/agent-runs/"+first.ID+"/diff", "")
	var diffResult struct {
		RunID     string `json:"run_id"`
		Diff      string `json:"diff"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.NewDecoder(response.Body).Decode(&diffResult); err != nil || response.Code != http.StatusOK ||
		diffResult.RunID != first.ID || diffResult.Diff != "diff --git a/README.md b/README.md\n+Updated\n" || diffResult.Truncated {
		t.Fatalf("agent run diff = %#v, decode error = %v, HTTP %d", diffResult, err, response.Code)
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+first.ID+"/comments", `{"comment":"Please explain the new API behavior."}`)
	var reviewed agentRun
	if err := json.NewDecoder(response.Body).Decode(&reviewed); err != nil || response.Code != http.StatusOK ||
		reviewed.Status != "failed" || len(reviewed.ReviewComments) != 1 {
		t.Fatalf("add review comment = %#v, decode error = %v, HTTP %d", reviewed, err, response.Code)
	}
	tooLongComment, err := json.Marshal(map[string]string{"comment": strings.Repeat("x", maxAgentRunCommentSize+1)})
	if err != nil {
		t.Fatalf("encode oversized review comment: %v", err)
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+first.ID+"/comments", string(tooLongComment))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("oversized review comment returned HTTP %d", response.Code)
	}
	response = call(http.MethodGet, "/api/v1/agent-runs", "")
	var listed []agentRun
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil || response.Code != http.StatusOK ||
		len(listed) != 1 || !listed[0].CanRequestChanges {
		t.Fatalf("request-changes capability = %#v, decode error = %v, HTTP %d", listed, err, response.Code)
	}
	heartbeat = `{"name":"worker","providers":[{"id":"codex-cli","version":"1","ready":false}],"projects":[{"id":"` + testProjectID + `","name":"repo","branch":"main"}]}`
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat)
	var worker workerRecord
	if err := json.NewDecoder(response.Body).Decode(&worker); err != nil || response.Code != http.StatusOK ||
		len(worker.Providers) != 1 || worker.Providers[0].Ready {
		t.Fatalf("signed-out provider heartbeat = %#v, decode error = %v, HTTP %d", worker, err, response.Code)
	}
	listed = nil
	response = call(http.MethodGet, "/api/v1/agent-runs", "")
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil || response.Code != http.StatusOK ||
		len(listed) != 1 || listed[0].CanRequestChanges {
		t.Fatalf("disabled request-changes capability = %#v, decode error = %v, HTTP %d", listed, err, response.Code)
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+first.ID+"/request-changes", `{"comment":"Update the response to address the review."}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("request changes without a ready provider returned HTTP %d", response.Code)
	}
	heartbeat = `{"name":"worker","providers":[{"id":"codex-cli","version":"1","ready":true}],"projects":[{"id":"` + testProjectID + `","name":"repo","branch":"main"}]}`
	if response := call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat); response.Code != http.StatusOK {
		t.Fatalf("provider-ready-again heartbeat returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+first.ID+"/request-changes", `{"comment":"Update the response to address the review."}`)
	var queuedForChanges agentRun
	if err := json.NewDecoder(response.Body).Decode(&queuedForChanges); err != nil || response.Code != http.StatusOK ||
		queuedForChanges.Status != "queued" || len(queuedForChanges.ReviewComments) != 2 || !queuedForChanges.DiffAvailable {
		t.Fatalf("request changes = %#v, decode error = %v, HTTP %d", queuedForChanges, err, response.Code)
	}
	response = call(http.MethodGet, "/api/v1/agent-runs/"+first.ID+"/diff", "")
	if response.Code != http.StatusOK {
		t.Fatalf("previous diff unavailable while follow-up is queued: HTTP %d", response.Code)
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	var second workerapi.AgentRunCommand
	if err := json.NewDecoder(response.Body).Decode(&second); err != nil || response.Code != http.StatusOK ||
		second.ID != first.ID || second.Attempts != 2 || second.Branch != first.Branch ||
		!strings.Contains(second.Prompt, "Please explain the new API behavior.") ||
		!strings.Contains(second.Prompt, "Update the response to address the review.") {
		t.Fatalf("follow-up claim = %#v, decode error = %v, HTTP %d", second, err, response.Code)
	}
	commitSHA := strings.Repeat("a", 40)
	treeSHA := strings.Repeat("c", 40)
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+second.ID,
		`{"status":"succeeded","output":"Review addressed","attempts":2,"commit_sha":"`+commitSHA+`","commit_tree_sha":"`+treeSHA+`","diff":"diff --git a/README.md b/README.md\n+Addressed\n"}`)
	var treeEvidence agentRun
	if err := json.NewDecoder(response.Body).Decode(&treeEvidence); err != nil || response.Code != http.StatusOK ||
		treeEvidence.CommitSHA != commitSHA || treeEvidence.CommitTreeSHA != treeSHA {
		t.Fatalf("finish follow-up returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+first.ID,
		`{"status":"succeeded","output":"stale","attempts":1}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("duplicate result returned HTTP %d", response.Code)
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+first.ID+"/request-changes",
		`{"comment":"Publish a replacement candidate without tree evidence."}`)
	var queuedAgain agentRun
	if err := json.NewDecoder(response.Body).Decode(&queuedAgain); err != nil || response.Code != http.StatusOK ||
		queuedAgain.Status != "queued" || queuedAgain.Attempts != 2 {
		t.Fatalf("request another candidate = %#v, decode error = %v, HTTP %d", queuedAgain, err, response.Code)
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	var third workerapi.AgentRunCommand
	if err := json.NewDecoder(response.Body).Decode(&third); err != nil || response.Code != http.StatusOK || third.Attempts != 3 {
		t.Fatalf("claim replacement candidate = %#v, decode error = %v, HTTP %d", third, err, response.Code)
	}
	replacementSHA := strings.Repeat("d", 40)
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+third.ID,
		`{"status":"succeeded","output":"Replacement candidate","attempts":3,"commit_sha":"`+replacementSHA+`"}`)
	var replacement agentRun
	if err := json.NewDecoder(response.Body).Decode(&replacement); err != nil || response.Code != http.StatusOK ||
		replacement.CommitSHA != replacementSHA || replacement.CommitTreeSHA != "" {
		t.Fatalf("replacement candidate retained stale tree evidence: %#v, decode error %v, HTTP %d",
			replacement, err, response.Code)
	}
	restored, err := openAgentRunStore(store.path, newWorkerRegistry(), agents)
	if err != nil {
		t.Fatalf("restore run history: %v", err)
	}
	if restored.items[queued.ID].Status != "succeeded" || restored.items[queued.ID].Profile == nil ||
		restored.items[queued.ID].Branch != queued.Branch {
		t.Fatalf("restored run = %#v, want succeeded with its profile snapshot", restored.items[queued.ID])
	}
	if !restored.items[queued.ID].DiffAvailable || restored.items[queued.ID].DiffAttempt != 2 ||
		len(restored.items[queued.ID].ReviewComments) != 3 || restored.items[queued.ID].CommitSHA != replacementSHA ||
		restored.items[queued.ID].CommitTreeSHA != "" {
		t.Fatalf("restored diff metadata = %#v", restored.items[queued.ID])
	}
}

func TestAgentRunFinishCreatesPullRequestAfterWorkerPush(t *testing.T) {
	runID := "fedcbafedcbafedcbafedcbafedcbafe"
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("GitHub authorization was not set")
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		var input struct {
			Title string `json:"title"`
			Head  string `json:"head"`
			Base  string `json:"base"`
			Body  string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Title != "Add review flow" ||
			input.Head != workerapi.AgentRunBranch(runID) || input.Base != "main" {
			t.Errorf("pull request input = %#v, decode error = %v", input, err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":23,"title":"Add review flow","state":"open","html_url":"https://github.com/acme/platform/pull/23","head":{"ref":"` + workerapi.AgentRunBranch(runID) + `","sha":"` + strings.Repeat("a", 40) + `"},"base":{"ref":"main"}}`))
	}))
	defer provider.Close()
	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: testProjectID, GitRemote: "github.com/acme/platform"}
	profile := agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Reviewer", Provider: workerapi.ProviderCodex, Model: "default",
		Status: "active", SystemPrompt: "Review", Version: 1, UpdatedAt: time.Now().UTC()}
	store := newAgentRunStore(registry, newAgentProfileStore())
	item := agentRun{ID: runID, AgentID: profile.ID, AgentName: profile.Name, ProjectID: testProjectID,
		Repository:  "github.com/acme/platform",
		ProjectName: "platform", WorkerID: testWorkerID, WorkerName: "worker", Branch: workerapi.AgentRunBranch(runID),
		BaseBranch: "main", Prompt: "Add review flow", Output: "Agent summary.", CommitSHA: strings.Repeat("a", 40),
		Status: "running", Attempts: 1,
		LeaseUntil: time.Now().Add(time.Minute), CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		Profile: &profile, PullRequestEnabled: true, PublishOnly: true, PublicationAuthorizations: []publicationAuthorization{{
			CommitSHA: strings.Repeat("a", 40), By: "test operator", At: time.Now().UTC(), Attempt: 1,
		}}}
	store.items[item.ID] = item
	request := jsonRequest(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+item.ID,
		strings.NewReader(`{"status":"succeeded","output":"Agent summary.","attempts":1,"commit_sha":"`+
			strings.Repeat("a", 40)+`","diff":"diff --git a/file b/file\n+change","branch_pushed":true}`))
	request.SetPathValue("id", testWorkerID)
	request.SetPathValue("requestID", item.ID)
	response := httptest.NewRecorder()
	store.finish(response, request)
	responseBody := response.Body.String()
	var result agentRun
	if err := json.NewDecoder(strings.NewReader(responseBody)).Decode(&result); err != nil || response.Code != http.StatusOK ||
		result.PullRequestNumber != 23 || result.PullRequestURL != "https://github.com/acme/platform/pull/23" || result.PullRequestError != "" {
		t.Fatalf("finished run = %#v, decode error = %v, HTTP %d: %s", result, err, response.Code, responseBody)
	}
}

func TestAgentRunClaimDoesNotAuthorizePullRequestForGitHubProjectWithToken(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	registry := newWorkerRegistry()
	registry.workers[testWorkerID] = workerRecord{ID: testWorkerID, Name: "worker", LastSeen: time.Now().UTC(),
		Providers: []workerapi.ProviderStatus{{ID: workerapi.ProviderCodex, Ready: true}}}
	registry.projects["worker:project"] = projectRecord{ID: testProjectID, Name: "platform", Branch: "main",
		GitRemote: "github.com/acme/platform", WorkerID: testWorkerID, WorkerName: "worker", LastSeen: time.Now().UTC()}
	profile := agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Reviewer", Provider: workerapi.ProviderCodex, Model: "default",
		Status: "active", SystemPrompt: "Review", Version: 1, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"}}
	agents := newAgentProfileStore()
	agents.items[profile.ID] = profile
	store := newAgentRunStore(registry, agents)
	response := httptest.NewRecorder()
	request := jsonRequest(http.MethodPost, "/api/v1/agent-runs",
		strings.NewReader(`{"agent_id":"`+profile.ID+`","project_id":"`+testProjectID+`","prompt":"Add a feature"}`))
	store.create(response, request)
	var queued agentRun
	if err := json.NewDecoder(response.Body).Decode(&queued); err != nil || response.Code != http.StatusAccepted || queued.PullRequestEnabled {
		t.Fatalf("queued run = %#v, decode error = %v, HTTP %d", queued, err, response.Code)
	}
	response = httptest.NewRecorder()
	request = jsonRequest(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", nil)
	request.SetPathValue("id", testWorkerID)
	store.claim(response, request)
	var command workerapi.AgentRunCommand
	if err := json.NewDecoder(response.Body).Decode(&command); err != nil || response.Code != http.StatusOK || command.PublishPullRequest {
		t.Fatalf("claimed run = %#v, decode error = %v, HTTP %d", command, err, response.Code)
	}
}

func TestAgentRunRefusesProfilesWithoutAnExecutionAdapter(t *testing.T) {
	registry := newWorkerRegistry()
	registry.workers[testWorkerID] = workerRecord{ID: testWorkerID, Name: "worker", LastSeen: time.Now().UTC(),
		Providers: []workerapi.ProviderStatus{{ID: workerapi.ProviderCodex, Ready: true}}}
	registry.projects["worker:project"] = projectRecord{ID: testProjectID, Name: "platform", Branch: "main",
		WorkerID: testWorkerID, WorkerName: "worker", LastSeen: time.Now().UTC()}
	profile := agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Reviewer", Provider: "custom", Model: "review-v1",
		Status: "active", Version: 1, UpdatedAt: time.Now().UTC()}
	agents := newAgentProfileStore()
	agents.items[profile.ID] = profile
	store := newAgentRunStore(registry, agents)
	response := httptest.NewRecorder()
	store.create(response, jsonRequest(http.MethodPost, "/api/v1/agent-runs",
		strings.NewReader(`{"agent_id":"`+profile.ID+`","project_id":"`+testProjectID+`","prompt":"Add a feature"}`)))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "no execution adapter") || len(store.items) != 0 {
		t.Fatalf("run for a provider without an adapter: HTTP %d %q, %d queued", response.Code, response.Body.String(), len(store.items))
	}
}
