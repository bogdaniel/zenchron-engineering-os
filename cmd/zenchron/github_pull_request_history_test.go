package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGitHubPullRequestHistoryPaginatesToDateCutoff(t *testing.T) {
	since := time.Date(2025, time.February, 1, 0, 0, 0, 0, time.UTC)
	requestedPages := make(chan string, 3)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/platform/pulls" || r.URL.Query().Get("state") != "all" ||
			r.URL.Query().Get("per_page") != "100" || r.URL.Query().Get("sort") != "updated" ||
			r.URL.Query().Get("direction") != "desc" {
			t.Errorf("history request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		requestedPages <- r.URL.Query().Get("page")
		var pulls []gitHubPullRequest
		switch r.URL.Query().Get("page") {
		case "1":
			for range 100 {
				pulls = append(pulls, gitHubPullRequest{State: "closed", CreatedAt: since, UpdatedAt: since.Add(48 * time.Hour)})
			}
		case "2":
			for range 100 {
				pulls = append(pulls, gitHubPullRequest{State: "closed", CreatedAt: since.Add(-48 * time.Hour),
					UpdatedAt: since.Add(-24 * time.Hour)})
			}
		default:
			t.Errorf("unexpected history page %q", r.URL.Query().Get("page"))
		}
		_ = json.NewEncoder(w).Encode(pulls)
	}))
	defer provider.Close()
	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project/pull-request-history?since="+since.Format(time.RFC3339), nil)
	request.SetPathValue("id", "project")
	response := httptest.NewRecorder()
	registry.listGitHubPullRequestHistory(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("history returned HTTP %d: %s", response.Code, response.Body.String())
	}
	var history gitHubPullRequestHistory
	if err := json.Unmarshal(response.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if !history.Complete || len(history.Items) != 200 || history.Items[0].CreatedAt.IsZero() {
		t.Fatalf("history result = %#v", history)
	}
	if first, second := <-requestedPages, <-requestedPages; first != "1" || second != "2" {
		t.Fatalf("history requested pages %q and %q; expected cutoff at page 2", first, second)
	}
}

func TestGitHubPullRequestHistoryRejectsInvalidSince(t *testing.T) {
	registry := newWorkerRegistry()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/project/pull-request-history?since=tomorrow", nil)
	request.SetPathValue("id", "project")
	response := httptest.NewRecorder()
	registry.listGitHubPullRequestHistory(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid since returned HTTP %d", response.Code)
	}
}

func TestGitHubPullRequestHistoryMarksPageLimitIncomplete(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var pulls []gitHubPullRequest
		for range 100 {
			pulls = append(pulls, gitHubPullRequest{State: "closed", UpdatedAt: time.Now().UTC()})
		}
		_ = json.NewEncoder(w).Encode(pulls)
	}))
	defer provider.Close()
	client := newGitHubClient()
	client.apiURL = provider.URL
	history, err := client.pullRequestHistory(t.Context(), "acme", "platform", time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if history.Complete || len(history.Items) != 2_000 {
		t.Fatalf("limited history = complete:%t items:%d", history.Complete, len(history.Items))
	}
}
