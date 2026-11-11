package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// GitHub reads and writes used by the issue-to-pull-request delivery path.

type gitHubIssueComment struct {
	Body              string `json:"body"`
	AuthorAssociation string `json:"author_association"`
	User              struct {
		Login string `json:"login"`
	} `json:"user"`
}

type gitHubReview struct {
	ID                int64     `json:"id"`
	State             string    `json:"state"`
	Body              string    `json:"body"`
	AuthorAssociation string    `json:"author_association"`
	SubmittedAt       time.Time `json:"submitted_at"`
	User              struct {
		Login string `json:"login"`
	} `json:"user"`
}

type gitHubCheckRun struct {
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	HTMLURL    string `json:"html_url"`
}

// trustedGitHubAuthor reports whether GitHub says the author can push to or belongs to the repository.
// Issue, comment, and review text from anyone else is never placed into an agent prompt.
func trustedGitHubAuthor(association string) bool {
	return association == "OWNER" || association == "MEMBER" || association == "COLLABORATOR"
}

func (client gitHubClient) get(ctx context.Context, path string, query url.Values, target any) error {
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", query, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}

func (client gitHubClient) issueComments(ctx context.Context, owner, repository string, number int) ([]gitHubIssueComment, error) {
	comments := make([]gitHubIssueComment, 0)
	path := "/repos/" + owner + "/" + repository + "/issues/" + strconv.Itoa(number) + "/comments"
	return comments, client.get(ctx, path, url.Values{"per_page": {"50"}}, &comments)
}

func (client gitHubClient) pullRequestReviews(ctx context.Context, owner, repository string, number int) ([]gitHubReview, error) {
	reviews := make([]gitHubReview, 0)
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number) + "/reviews"
	return reviews, client.get(ctx, path, url.Values{"per_page": {"100"}}, &reviews)
}

func (client gitHubClient) commitCheckRuns(ctx context.Context, owner, repository, commit string) ([]gitHubCheckRun, error) {
	var result struct {
		CheckRuns []gitHubCheckRun `json:"check_runs"`
	}
	path := "/repos/" + owner + "/" + repository + "/commits/" + commit + "/check-runs"
	return result.CheckRuns, client.get(ctx, path, url.Values{"per_page": {"100"}}, &result)
}

func (client gitHubClient) createIssue(ctx context.Context, owner, repository, title, body string) (gitHubIssue, error) {
	var issue gitHubIssue
	if !client.authConfigured() {
		return issue, fmt.Errorf("GitHub authentication is not configured")
	}
	payload, err := json.Marshal(struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}{Title: title, Body: body})
	if err != nil {
		return issue, err
	}
	response, err := client.requestBytes(ctx, http.MethodPost, "/repos/"+owner+"/"+repository+"/issues",
		"application/vnd.github+json", nil, payload)
	if err != nil {
		return issue, err
	}
	return issue, json.Unmarshal(response, &issue)
}

func (registry *workerRegistry) createGitHubIssue(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	var input struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Title, input.Body = strings.TrimSpace(input.Title), strings.TrimSpace(input.Body)
	if input.Title == "" || len(input.Title) > 256 || len(input.Body) > 20_000 {
		http.Error(w, "issue title must be 1 to 256 bytes and the body at most 20000 bytes", http.StatusBadRequest)
		return
	}
	if !registry.github.authConfigured() {
		http.Error(w, "GitHub authentication is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	issue, err := registry.github.createIssue(r.Context(), owner, repository, input.Title, input.Body)
	if err != nil || issue.Number < 1 {
		http.Error(w, "GitHub could not create this issue; verify token permissions and provider access", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusCreated, issue)
}
