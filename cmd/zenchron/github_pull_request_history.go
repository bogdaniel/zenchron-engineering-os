package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

type gitHubPullRequestHistoryItem struct {
	CreatedAt time.Time  `json:"created_at"`
	ClosedAt  *time.Time `json:"closed_at"`
	MergedAt  *time.Time `json:"merged_at"`
}

type gitHubPullRequestHistory struct {
	Items    []gitHubPullRequestHistoryItem `json:"items"`
	Complete bool                           `json:"complete"`
}

const maxPullRequestHistoryPages = 20

func (client gitHubClient) pullRequestHistory(ctx context.Context, owner, repository string, since time.Time) (gitHubPullRequestHistory, error) {
	result := gitHubPullRequestHistory{Items: make([]gitHubPullRequestHistoryItem, 0), Complete: true}
	// ponytail: caps one report at 2,000 PRs per repository; add incremental sync if larger histories are needed.
	for page := 1; page <= maxPullRequestHistoryPages+1; page++ {
		query := make(url.Values)
		query.Set("state", "all")
		query.Set("per_page", "100")
		query.Set("sort", "updated")
		query.Set("direction", "desc")
		query.Set("page", strconv.Itoa(page))
		body, err := client.requestBytes(ctx, http.MethodGet,
			"/repos/"+owner+"/"+repository+"/pulls", "application/vnd.github+json", query, nil)
		if err != nil {
			return gitHubPullRequestHistory{}, err
		}
		var pulls []gitHubPullRequest
		if err := json.Unmarshal(body, &pulls); err != nil {
			return gitHubPullRequestHistory{}, err
		}
		if len(pulls) == 0 {
			return result, nil
		}
		if page > maxPullRequestHistoryPages {
			result.Complete = false
			return result, nil
		}
		for _, pull := range pulls {
			result.Items = append(result.Items, gitHubPullRequestHistoryItem{
				CreatedAt: pull.CreatedAt, ClosedAt: pull.ClosedAt, MergedAt: pull.MergedAt,
			})
		}
		lastUpdated := pulls[len(pulls)-1].UpdatedAt
		if len(pulls) < 100 || (!since.IsZero() && !lastUpdated.IsZero() && lastUpdated.Before(since)) {
			return result, nil
		}
	}
	return result, nil
}

func (registry *workerRegistry) listGitHubPullRequestHistory(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	since, err := reportSince(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	history, err := registry.github.pullRequestHistory(r.Context(), owner, repository, since)
	if err != nil {
		http.Error(w, "GitHub pull-request history is unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, history)
}
