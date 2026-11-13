package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type gitHubWorkflowRunHistoryItem struct {
	CreatedAt  time.Time  `json:"created_at"`
	Status     string     `json:"status"`
	Conclusion *string    `json:"conclusion"`
	StartedAt  *time.Time `json:"run_started_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

type gitHubWorkflowRunHistory struct {
	Items    []gitHubWorkflowRunHistoryItem `json:"items"`
	Complete bool                           `json:"complete"`
}

type gitHubWorkflowRunPage struct {
	TotalCount   int                            `json:"total_count"`
	WorkflowRuns []gitHubWorkflowRunHistoryItem `json:"workflow_runs"`
}

const maxWorkflowRunHistoryPages = 10

func (client gitHubClient) workflowRunHistory(ctx context.Context, owner, repository string, since time.Time) (gitHubWorkflowRunHistory, error) {
	result := gitHubWorkflowRunHistory{Items: make([]gitHubWorkflowRunHistoryItem, 0), Complete: true}
	// ponytail: caps one report at 1,000 workflow runs; add incremental sync if repositories exceed that window.
	for page := 1; page <= maxWorkflowRunHistoryPages; page++ {
		query := make(url.Values)
		query.Set("per_page", "100")
		query.Set("page", strconv.Itoa(page))
		if !since.IsZero() {
			query.Set("created", ">="+since.Format(time.RFC3339))
		}
		body, err := client.requestBytes(ctx, http.MethodGet,
			"/repos/"+owner+"/"+repository+"/actions/runs", "application/vnd.github+json", query, nil)
		if err != nil {
			return gitHubWorkflowRunHistory{}, err
		}
		var runs gitHubWorkflowRunPage
		if err := json.Unmarshal(body, &runs); err != nil {
			return gitHubWorkflowRunHistory{}, err
		}
		if page == 1 && runs.TotalCount > maxWorkflowRunHistoryPages*100 {
			result.Complete = false
		}
		result.Items = append(result.Items, runs.WorkflowRuns...)
		if len(runs.WorkflowRuns) < 100 {
			return result, nil
		}
	}
	return result, nil
}

func (registry *workerRegistry) listGitHubWorkflowRunHistory(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	since, err := reportSince(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	history, err := registry.github.workflowRunHistory(r.Context(), owner, repository, since)
	if err != nil {
		http.Error(w, "GitHub workflow-run history is unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, history)
}

func reportSince(r *http.Request) (time.Time, error) {
	values, found := r.URL.Query()["since"]
	if !found {
		return time.Time{}, nil
	}
	if len(values) != 1 {
		return time.Time{}, fmt.Errorf("since must be one RFC3339 timestamp")
	}
	parsed, err := time.Parse(time.RFC3339, values[0])
	if err != nil || parsed.After(time.Now().Add(time.Minute)) {
		return time.Time{}, fmt.Errorf("since must be a valid past RFC3339 timestamp")
	}
	return parsed, nil
}
