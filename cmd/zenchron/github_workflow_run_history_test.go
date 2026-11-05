package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGitHubWorkflowRunHistoryFiltersByDateAndPaginates(t *testing.T) {
	since := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	requestedPages := make(chan string, 2)
	createdAt := since.Add(time.Hour)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/platform/actions/runs" || r.URL.Query().Get("per_page") != "100" ||
			r.URL.Query().Get("created") != ">="+since.Format(time.RFC3339) {
			t.Errorf("workflow-run request = %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		requestedPages <- r.URL.Query().Get("page")
		runs := gitHubWorkflowRunPage{TotalCount: 101}
		if r.URL.Query().Get("page") == "1" {
			runs.WorkflowRuns = make([]gitHubWorkflowRunHistoryItem, 100)
		} else {
			conclusion := "success"
			runs.WorkflowRuns = []gitHubWorkflowRunHistoryItem{{
				CreatedAt: createdAt, Status: "completed", Conclusion: &conclusion,
			}}
		}
		_ = json.NewEncoder(w).Encode(runs)
	}))
	defer provider.Close()
	registry := newWorkerRegistry()
	registry.github.apiURL = provider.URL
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project/workflow-run-history?since="+since.Format(time.RFC3339), nil)
	request.SetPathValue("id", "project")
	response := httptest.NewRecorder()
	registry.listGitHubWorkflowRunHistory(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("history returned HTTP %d: %s", response.Code, response.Body.String())
	}
	var history gitHubWorkflowRunHistory
	if err := json.Unmarshal(response.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if !history.Complete || len(history.Items) != 101 || history.Items[100].Status != "completed" ||
		history.Items[100].Conclusion == nil || *history.Items[100].Conclusion != "success" ||
		!history.Items[100].CreatedAt.Equal(createdAt) {
		t.Fatalf("history result = complete:%t items:%d", history.Complete, len(history.Items))
	}
	if first, second := <-requestedPages, <-requestedPages; first != "1" || second != "2" {
		t.Fatalf("history requested pages %q and %q", first, second)
	}
}

func TestGitHubWorkflowRunHistoryMarksProviderLimitIncomplete(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(gitHubWorkflowRunPage{TotalCount: 1_001,
			WorkflowRuns: make([]gitHubWorkflowRunHistoryItem, 100)})
	}))
	defer provider.Close()
	client := newGitHubClient()
	client.apiURL = provider.URL
	history, err := client.workflowRunHistory(t.Context(), "acme", "platform", time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if history.Complete {
		t.Fatal("history with more than 1,000 results was marked complete")
	}
}
