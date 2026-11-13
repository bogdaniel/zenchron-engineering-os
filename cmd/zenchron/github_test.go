package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestGitHubIssuesAndPullRequestsUseRemoteAndKeepDistinct(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Errorf("GitHub request headers/query = %#v / %s", r.Header, r.URL.RawQuery)
		}
		if r.Method == http.MethodGet && (r.URL.Path == "/repos/acme/platform/pulls" ||
			r.URL.Path == "/repos/acme/platform/issues") &&
			(r.URL.Query().Get("state") != "open" || r.URL.Query().Get("per_page") != "100") {
			t.Errorf("GitHub list query = %s", r.URL.RawQuery)
		}
		switch r.URL.Path {
		case "/repos/acme/platform/pulls":
			w.Write([]byte(`[{"number":12,"title":"Improve review","state":"open","html_url":"https://github.com/acme/platform/pull/12","draft":false,"head":{"ref":"feature/review"},"base":{"ref":"main"}}]`))
		case "/repos/acme/platform/pulls/12":
			if r.Method != http.MethodGet || r.URL.RawQuery != "" {
				t.Errorf("pull request detail request method/query = %s / %q", r.Method, r.URL.RawQuery)
			}
			if r.Header.Get("Accept") == "application/vnd.github.diff" {
				w.Header().Set("Content-Type", "application/vnd.github.diff")
				_, _ = w.Write([]byte("diff --git a/retry.go b/retry.go\n+return retry(ctx)\n"))
				break
			}
			if r.Header.Get("Accept") != "application/vnd.github+json" {
				t.Errorf("pull request diff request method/query/accept = %s / %q / %q", r.Method,
					r.URL.RawQuery, r.Header.Get("Accept"))
			}
			_, _ = w.Write([]byte(`{"number":12,"title":"Improve review","state":"open","html_url":"https://github.com/acme/platform/pull/12","draft":false,"head":{"ref":"feature/review"},"base":{"ref":"main"}}`))
		case "/repos/acme/platform/pulls/13":
			w.Write([]byte(strings.Repeat("x", maxGitHubResponseSize+1)))
		case "/repos/acme/platform/issues":
			w.Write([]byte(`[{"number":13,"title":"Document setup","state":"open","html_url":"https://github.com/acme/platform/issues/13","labels":[{"name":"docs"}]},{"number":12,"title":"Improve review","state":"open","pull_request":{"url":"https://api.github.com/repos/acme/platform/pulls/12"}}]`))
		case "/repos/acme/platform/issues/13/comments":
			var comment struct {
				Body string `json:"body"`
			}
			if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" ||
				json.NewDecoder(r.Body).Decode(&comment) != nil || comment.Body != "I will add the setup steps." {
				t.Errorf("issue comment request = %s %s, body = %#v", r.Method, r.Header.Get("Content-Type"), comment)
			}
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"id":1,"body":"I will add the setup steps."}`))
		case "/repos/acme/platform/issues/13":
			if r.Method == http.MethodGet {
				w.Write([]byte(`{"number":13,"title":"Document setup","state":"open"}`))
				break
			}
			var input struct {
				State string `json:"state"`
			}
			if r.Method != http.MethodPatch || json.NewDecoder(r.Body).Decode(&input) != nil || input.State != "closed" {
				t.Errorf("issue update request = %s, state = %#v", r.Method, input)
			}
			w.Write([]byte(`{"number":13,"state":"closed"}`))
		case "/repos/acme/platform/pulls/12/reviews":
			if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("review request method/content type = %s / %q", r.Method, r.Header.Get("Content-Type"))
			}
			var review struct {
				Body  string `json:"body"`
				Event string `json:"event"`
			}
			if err := json.NewDecoder(r.Body).Decode(&review); err != nil ||
				review.Body != "Please fix the retry behavior." || review.Event != "REQUEST_CHANGES" {
				t.Errorf("submitted review = %#v, decode error %v", review, err)
			}
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected GitHub API path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")

	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/projects/{id}/pull-requests", registry.listGitHubPullRequests)
	mux.HandleFunc("GET /api/v1/projects/{id}/pull-requests/{number}/diff", registry.getGitHubPullRequestDiff)
	mux.HandleFunc("POST /api/v1/projects/{id}/pull-requests/{number}/reviews", registry.reviewGitHubPullRequest)
	mux.HandleFunc("GET /api/v1/projects/{id}/issues", registry.listGitHubIssues)
	mux.HandleFunc("POST /api/v1/projects/{id}/issues/{number}/comments", registry.commentGitHubIssue)
	mux.HandleFunc("PATCH /api/v1/projects/{id}/issues/{number}", registry.updateGitHubIssue)
	server := httptest.NewServer(mux)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/v1/projects/project/pull-requests")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("pull request list returned HTTP %d", response.StatusCode)
	}
	var pulls []gitHubPullRequest
	if err := json.NewDecoder(response.Body).Decode(&pulls); err != nil {
		response.Body.Close()
		t.Fatal(err)
	}
	response.Body.Close()
	if len(pulls) != 1 || pulls[0].Number != 12 || pulls[0].Head.Ref != "feature/review" || pulls[0].Base.Ref != "main" {
		t.Fatalf("pull requests = %#v", pulls)
	}

	response, err = http.Get(server.URL + "/api/v1/projects/project/pull-requests/12/diff")
	if err != nil {
		t.Fatal(err)
	}
	var diff struct {
		Diff string `json:"diff"`
	}
	if err := json.NewDecoder(response.Body).Decode(&diff); err != nil || response.StatusCode != http.StatusOK ||
		diff.Diff != "diff --git a/retry.go b/retry.go\n+return retry(ctx)\n" {
		response.Body.Close()
		t.Fatalf("pull request diff = %#v, decode error = %v, HTTP %d", diff, err, response.StatusCode)
	}
	response.Body.Close()

	response, err = http.Get(server.URL + "/api/v1/projects/project/pull-requests/0/diff")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusBadRequest {
		response.Body.Close()
		t.Fatalf("invalid pull request number returned HTTP %d", response.StatusCode)
	}
	response.Body.Close()
	response, err = http.Get(server.URL + "/api/v1/projects/project/pull-requests/13/diff")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusBadGateway {
		response.Body.Close()
		t.Fatalf("oversized pull request diff returned HTTP %d", response.StatusCode)
	}
	response.Body.Close()

	response, err = http.Get(server.URL + "/api/v1/projects/project/issues")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var issues []gitHubIssue
	if err := json.NewDecoder(response.Body).Decode(&issues); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || len(issues) != 1 || issues[0].Number != 13 || issues[0].Labels[0].Name != "docs" {
		t.Fatalf("issue list = %#v (HTTP %d), pull requests must be filtered", issues, response.StatusCode)
	}

	response, err = http.Post(server.URL+"/api/v1/projects/project/issues/13/comments", "application/json",
		strings.NewReader(`{"body":"I will add the setup steps."}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("issue comment returned HTTP %d", response.StatusCode)
	}

	request, err := http.NewRequest(http.MethodPatch, server.URL+"/api/v1/projects/project/issues/13",
		strings.NewReader(`{"state":"closed"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("issue state update returned HTTP %d", response.StatusCode)
	}

	response, err = http.Post(server.URL+"/api/v1/projects/project/pull-requests/12/reviews", "application/json",
		strings.NewReader(`{"body":"Please fix the retry behavior.","event":"REQUEST_CHANGES"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("pull request review returned HTTP %d", response.StatusCode)
	}
	response.Body.Close()
}

func TestGitHubIssueCommentRequiresLoopbackTokenAndValidBody(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	registry := newWorkerRegistry()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	call := func(remoteAddr, contentType, body string) int {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/issues/13/comments", strings.NewReader(body))
		request.RemoteAddr = remoteAddr
		request.Header.Set("Content-Type", contentType)
		request.SetPathValue("id", "project")
		request.SetPathValue("number", "13")
		response := httptest.NewRecorder()
		registry.commentGitHubIssue(response, request)
		return response.Code
	}
	if status := call("192.0.2.8:1234", "application/json", `{"body":"comment"}`); status != http.StatusForbidden {
		t.Fatalf("non-loopback issue comment returned HTTP %d", status)
	}
	if status := call("127.0.0.1:1234", "text/plain", `comment`); status != http.StatusUnsupportedMediaType {
		t.Fatalf("non-JSON issue comment returned HTTP %d", status)
	}
	if status := call("127.0.0.1:1234", "application/json", `{"body":" "}`); status != http.StatusBadRequest {
		t.Fatalf("empty issue comment returned HTTP %d", status)
	}
	if status := call("127.0.0.1:1234", "application/json", `{"body":"valid"}`); status != http.StatusServiceUnavailable {
		t.Fatalf("issue comment without token returned HTTP %d", status)
	}
}

func TestGitHubIssueStateUpdateRequiresLoopbackTokenAndValidState(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	registry := newWorkerRegistry()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	call := func(remoteAddr, state string) int {
		t.Helper()
		request := httptest.NewRequest(http.MethodPatch, "/api/v1/projects/project/issues/13",
			strings.NewReader(`{"state":"`+state+`"}`))
		request.RemoteAddr = remoteAddr
		request.Header.Set("Content-Type", "application/json")
		request.SetPathValue("id", "project")
		request.SetPathValue("number", "13")
		response := httptest.NewRecorder()
		registry.updateGitHubIssue(response, request)
		return response.Code
	}
	if status := call("192.0.2.8:1234", "closed"); status != http.StatusForbidden {
		t.Fatalf("non-loopback issue update returned HTTP %d", status)
	}
	if status := call("127.0.0.1:1234", "merged"); status != http.StatusBadRequest {
		t.Fatalf("unsupported issue state returned HTTP %d", status)
	}
	if status := call("127.0.0.1:1234", "closed"); status != http.StatusServiceUnavailable {
		t.Fatalf("issue update without token returned HTTP %d", status)
	}
}

func TestGitHubIssueWritesRejectPullRequestNumbers(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/repos/acme/platform/issues/13" {
			t.Errorf("PR number should be rejected before provider write: %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"number":13,"pull_request":{"url":"https://api.github.com/repos/acme/platform/pulls/13"}}`))
	}))
	defer provider.Close()
	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	for _, test := range []struct {
		name string
		call func(http.ResponseWriter, *http.Request)
		body string
	}{
		{name: "comment", call: registry.commentGitHubIssue, body: `{"body":"Comment on a pull request."}`},
		{name: "state", call: registry.updateGitHubIssue, body: `{"state":"closed"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/issues/13",
				strings.NewReader(test.body))
			if test.name == "state" {
				request = httptest.NewRequest(http.MethodPatch, "/api/v1/projects/project/issues/13", strings.NewReader(test.body))
			}
			request.RemoteAddr = "127.0.0.1:1234"
			request.Header.Set("Content-Type", "application/json")
			request.SetPathValue("id", "project")
			request.SetPathValue("number", "13")
			response := httptest.NewRecorder()
			test.call(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("PR number returned HTTP %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestGitHubRoutesRejectRepositoriesOutsideGitHub(t *testing.T) {
	registry := newWorkerRegistry()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "evil.example/acme/platform"}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/project/pull-requests", nil)
	request.SetPathValue("id", "project")
	registry.listGitHubPullRequests(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unsupported repository returned HTTP %d", response.Code)
	}
}

func TestGitHubCreatesPullRequestFromPublishedBranch(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("GitHub authorization header was not set")
		}
		if r.Method == http.MethodGet {
			if r.URL.Path != "/repos/acme/platform/pulls" || r.URL.Query().Get("head") != "acme:zenchron/agent-run/123" ||
				r.URL.Query().Get("base") != "main" || r.URL.Query().Get("state") != "open" {
				t.Errorf("existing PR lookup = %s %s", r.Method, r.URL.String())
			}
			_, _ = w.Write([]byte(`[]`))
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/repos/acme/platform/pulls" {
			t.Errorf("create PR request = %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var input struct {
			Title string `json:"title"`
			Head  string `json:"head"`
			Base  string `json:"base"`
			Body  string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Title != "Add review flow" ||
			input.Head != "zenchron/agent-run/123" || input.Base != "main" || input.Body != "Agent summary." {
			t.Errorf("create PR payload = %#v, decode error = %v", input, err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"number":23,"title":"Add review flow","state":"open","html_url":"https://github.com/acme/platform/pull/23","head":{"ref":"zenchron/agent-run/123"},"base":{"ref":"main"}}`))
	}))
	defer provider.Close()
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	client := newGitHubClient()
	client.apiURL = provider.URL
	pull, err := client.createPullRequest(context.Background(), "acme", "platform", "zenchron/agent-run/123", "main", "Add review flow", "Agent summary.")
	if err != nil || pull.Number != 23 || pull.HTMLURL != "https://github.com/acme/platform/pull/23" {
		t.Fatalf("created pull request = %#v, error = %v", pull, err)
	}
}

func TestGitHubReviewFeedbackReturnsToAgentRun(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	runID := "fedcbafedcbafedcbafedcbafedcbafe"
	providerBranch := workerapi.AgentRunBranch(runID)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("GitHub authorization was not set")
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"number":23,"title":"Agent change","state":"open","html_url":"https://github.com/acme/platform/pull/23","head":{"ref":"` + providerBranch + `"},"base":{"ref":"main"}}`))
			return
		}
		var review struct {
			Body  string `json:"body"`
			Event string `json:"event"`
		}
		if err := json.NewDecoder(r.Body).Decode(&review); err != nil || review.Body == "" {
			t.Errorf("review request = %#v, decode error = %v", review, err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer provider.Close()
	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: testProjectID, GitRemote: "github.com/acme/platform"}
	runtimeEnabled := true
	registry.workers[testWorkerID] = workerRecord{ID: testWorkerID, Name: "worker", LastSeen: time.Now(), AgentRuntimeEnabled: &runtimeEnabled}
	profile := agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Reviewer", Provider: "custom", Model: "review-v1",
		Status: "active", SystemPrompt: "Review", Version: 1, UpdatedAt: time.Now(), Tools: []string{"code.write"}}
	store := newAgentRunStore(registry, newAgentProfileStore())
	store.items[runID] = agentRun{ID: runID, AgentID: profile.ID, AgentName: profile.Name, ProjectID: testProjectID,
		Repository: "github.com/acme/platform", PullRequestNumber: 23,
		PullRequestURL: "https://github.com/acme/platform/pull/23",
		ProjectName:    "platform", WorkerID: testWorkerID, WorkerName: "worker", Branch: workerapi.AgentRunBranch(runID),
		BaseBranch: "main", Prompt: "Add a feature", Status: "succeeded", Attempts: 1, DiffAvailable: true,
		CreatedAt: time.Now(), UpdatedAt: time.Now(), Profile: &profile}
	registry.runs = store

	callReview := func(event, body string) map[string]any {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+testProjectID+"/pull-requests/23/reviews",
			strings.NewReader(`{"body":"`+body+`","event":"`+event+`"}`))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.SetPathValue("id", testProjectID)
		request.SetPathValue("number", "23")
		response := httptest.NewRecorder()
		registry.reviewGitHubPullRequest(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("GitHub review returned HTTP %d: %s", response.Code, response.Body.String())
		}
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	comment := callReview("COMMENT", "Please keep the response backward compatible.")
	if comment["agent_run_linked"] != true || comment["agent_run_queued"] != false || store.items[runID].Status != "succeeded" {
		t.Fatalf("GitHub comment sync = %#v, run = %#v", comment, store.items[runID])
	}
	changes := callReview("REQUEST_CHANGES", "Update the response to keep it backward compatible.")
	item := store.items[runID]
	if changes["agent_run_linked"] != true || changes["agent_run_queued"] != true || item.Status != "queued" ||
		len(item.ReviewComments) != 2 || !item.ReviewComments[1].RequestChanges {
		t.Fatalf("GitHub change request sync = %#v, run = %#v", changes, item)
	}
	waitingRunID := "abcdefabcdefabcdefabcdefabcdef12"
	store.items[waitingRunID] = agentRun{ID: waitingRunID, AgentID: profile.ID, AgentName: profile.Name,
		ProjectID: testProjectID, ProjectName: "platform", WorkerID: testWorkerID, WorkerName: "worker",
		Branch: workerapi.AgentRunBranch(waitingRunID), BaseBranch: "main", Prompt: "Add another feature", Status: "succeeded",
		Attempts: 1, DiffAvailable: true, CreatedAt: time.Now(), UpdatedAt: time.Now(), Profile: &profile,
		Repository: "github.com/acme/platform", PullRequestNumber: 23}
	// The provider stub serves one pull request, so hand its identity to the second run.
	item.PullRequestNumber = 0
	store.items[runID] = item
	providerBranch = workerapi.AgentRunBranch(waitingRunID)
	worker := registry.workers[testWorkerID]
	worker.LastSeen = time.Now().Add(-2 * workerOnlineWindow)
	registry.workers[testWorkerID] = worker
	waiting := callReview("REQUEST_CHANGES", "Store feedback until the worker returns.")
	waitingRun := store.items[waitingRunID]
	if waiting["agent_run_linked"] != true || waiting["agent_run_queued"] != false || waitingRun.Status != "succeeded" ||
		len(waitingRun.ReviewComments) != 1 || !waitingRun.ReviewComments[0].RequestChanges {
		t.Fatalf("offline worker review sync = %#v, run = %#v", waiting, waitingRun)
	}
}

func TestGitHubPullRequestReviewRequiresTokenAndValidEvent(t *testing.T) {
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	registry := newWorkerRegistry()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}

	for _, test := range []struct {
		name        string
		path        string
		body        string
		contentType string
		remoteAddr  string
		wantStatus  int
	}{
		{name: "missing token", path: "/api/v1/projects/project/pull-requests/12/reviews", body: `{"body":"Review body","event":"COMMENT"}`, contentType: "application/json", wantStatus: http.StatusServiceUnavailable},
		{name: "invalid event", path: "/api/v1/projects/project/pull-requests/12/reviews", body: `{"body":"Review body","event":"APPROVE"}`, contentType: "application/json", wantStatus: http.StatusBadRequest},
		{name: "invalid number", path: "/api/v1/projects/project/pull-requests/0/reviews", body: `{"body":"Review body","event":"COMMENT"}`, contentType: "application/json", wantStatus: http.StatusBadRequest},
		{name: "non-loopback client", path: "/api/v1/projects/project/pull-requests/12/reviews", body: `{"body":"Review body","event":"COMMENT"}`, contentType: "application/json", remoteAddr: "192.0.2.8:4321", wantStatus: http.StatusForbidden},
		{name: "non-JSON content type", path: "/api/v1/projects/project/pull-requests/12/reviews", body: `{"body":"Review body","event":"COMMENT"}`, contentType: "text/plain", wantStatus: http.StatusUnsupportedMediaType},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.RemoteAddr = test.remoteAddr
			if request.RemoteAddr == "" {
				request.RemoteAddr = "127.0.0.1:12345"
			}
			request.Header.Set("Content-Type", test.contentType)
			response := httptest.NewRecorder()
			mux := http.NewServeMux()
			mux.HandleFunc("POST /api/v1/projects/{id}/pull-requests/{number}/reviews", registry.reviewGitHubPullRequest)
			mux.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("review returned HTTP %d, want %d: %s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}
}
