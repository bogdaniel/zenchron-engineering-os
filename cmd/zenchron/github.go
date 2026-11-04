package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxGitHubResponseSize = 1 << 20

const gitHubAPIURL = "https://api.github.com"

type gitHubClient struct {
	apiURL string
	token  string
	client *http.Client
}

type gitHubPullRequest struct {
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	State     string     `json:"state"`
	HTMLURL   string     `json:"html_url"`
	Body      string     `json:"body,omitempty"`
	Draft     bool       `json:"draft"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	ClosedAt  *time.Time `json:"closed_at"`
	MergedAt  *time.Time `json:"merged_at"`
	User      struct {
		Login string `json:"login"`
	} `json:"user"`
	Head struct {
		Ref string `json:"ref"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
}

type gitHubIssue struct {
	Number      int            `json:"number"`
	Title       string         `json:"title"`
	State       string         `json:"state"`
	HTMLURL     string         `json:"html_url"`
	Body        string         `json:"body,omitempty"`
	UpdatedAt   time.Time      `json:"updated_at"`
	PullRequest map[string]any `json:"pull_request,omitempty"`
	User        struct {
		Login string `json:"login"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
}

func newGitHubClient() gitHubClient {
	return gitHubClient{
		apiURL: gitHubAPIURL, token: strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_TOKEN")),
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (client gitHubClient) request(ctx context.Context, path string, target any) error {
	query := make(url.Values)
	query.Set("state", "open")
	query.Set("per_page", "100")
	query.Set("sort", "updated")
	query.Set("direction", "desc")
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", query, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}

func (client gitHubClient) requestBytes(
	ctx context.Context, method, path, accept string, query url.Values, payload []byte,
) ([]byte, error) {
	base, err := url.Parse(client.apiURL)
	if err != nil || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(base.Scheme != "https" && !(base.Scheme == "http" && isLoopbackHost(base.Hostname()))) {
		return nil, fmt.Errorf("GitHub API URL must be HTTPS or loopback HTTP")
	}
	if strings.ContainsAny(client.token, "\r\n") || len(client.token) > 4096 {
		return nil, fmt.Errorf("GitHub token is invalid")
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	if query != nil {
		base.RawQuery = query.Encode()
	}
	var body io.Reader
	if payload != nil {
		body = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, base.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Zenchron-Engineering-Control-Plane")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if client.token != "" {
		request.Header.Set("Authorization", "Bearer "+client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxGitHubResponseSize+1))
	if err != nil {
		return nil, err
	}
	if len(responseBody) > maxGitHubResponseSize {
		return nil, fmt.Errorf("GitHub response exceeded the size limit")
	}
	return responseBody, nil
}

func (client gitHubClient) pullRequestDiff(ctx context.Context, owner, repository string, number int) (string, error) {
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number)
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github.diff", nil, nil)
	return string(body), err
}

func (client gitHubClient) pullRequest(ctx context.Context, owner, repository string, number int) (gitHubPullRequest, error) {
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number)
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", nil, nil)
	if err != nil {
		return gitHubPullRequest{}, err
	}
	var pull gitHubPullRequest
	if err := json.Unmarshal(body, &pull); err != nil {
		return gitHubPullRequest{}, err
	}
	return pull, nil
}

func (client gitHubClient) submitPullRequestReview(ctx context.Context, owner, repository string, number int, body, event string) error {
	if client.token == "" {
		return fmt.Errorf("GitHub review token is not configured")
	}
	payload, err := json.Marshal(struct {
		Body  string `json:"body"`
		Event string `json:"event"`
	}{Body: body, Event: event})
	if err != nil {
		return err
	}
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number) + "/reviews"
	_, err = client.requestBytes(ctx, http.MethodPost, path, "application/vnd.github+json", nil, payload)
	return err
}

func (client gitHubClient) createIssueComment(ctx context.Context, owner, repository string, number int, body string) error {
	if client.token == "" {
		return fmt.Errorf("GitHub issue comment token is not configured")
	}
	payload, err := json.Marshal(struct {
		Body string `json:"body"`
	}{Body: body})
	if err != nil {
		return err
	}
	path := "/repos/" + owner + "/" + repository + "/issues/" + strconv.Itoa(number) + "/comments"
	_, err = client.requestBytes(ctx, http.MethodPost, path, "application/vnd.github+json", nil, payload)
	return err
}

func (client gitHubClient) issue(ctx context.Context, owner, repository string, number int) (gitHubIssue, error) {
	path := "/repos/" + owner + "/" + repository + "/issues/" + strconv.Itoa(number)
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", nil, nil)
	if err != nil {
		return gitHubIssue{}, err
	}
	var issue gitHubIssue
	if err := json.Unmarshal(body, &issue); err != nil {
		return gitHubIssue{}, err
	}
	return issue, nil
}

func (client gitHubClient) updateIssueState(ctx context.Context, owner, repository string, number int, state string) error {
	if client.token == "" {
		return fmt.Errorf("GitHub issue update token is not configured")
	}
	payload, err := json.Marshal(struct {
		State string `json:"state"`
	}{State: state})
	if err != nil {
		return err
	}
	path := "/repos/" + owner + "/" + repository + "/issues/" + strconv.Itoa(number)
	_, err = client.requestBytes(ctx, http.MethodPatch, path, "application/vnd.github+json", nil, payload)
	return err
}

func (client gitHubClient) createPullRequest(ctx context.Context, owner, repository, head, base, title, body string) (gitHubPullRequest, error) {
	query := make(url.Values)
	query.Set("state", "open")
	query.Set("head", owner+":"+head)
	query.Set("base", base)
	query.Set("per_page", "100")
	existing := make([]gitHubPullRequest, 0)
	response, err := client.requestBytes(ctx, http.MethodGet, "/repos/"+owner+"/"+repository+"/pulls", "application/vnd.github+json", query, nil)
	if err != nil {
		return gitHubPullRequest{}, err
	}
	if err := json.Unmarshal(response, &existing); err != nil {
		return gitHubPullRequest{}, err
	}
	for _, pull := range existing {
		if pull.Head.Ref == head && pull.Base.Ref == base {
			return pull, nil
		}
	}
	payload, err := json.Marshal(struct {
		Title string `json:"title"`
		Head  string `json:"head"`
		Base  string `json:"base"`
		Body  string `json:"body"`
	}{Title: title, Head: head, Base: base, Body: body})
	if err != nil {
		return gitHubPullRequest{}, err
	}
	response, err = client.requestBytes(ctx, http.MethodPost, "/repos/"+owner+"/"+repository+"/pulls", "application/vnd.github+json", nil, payload)
	if err != nil {
		return gitHubPullRequest{}, err
	}
	var pull gitHubPullRequest
	if err := json.Unmarshal(response, &pull); err != nil {
		return gitHubPullRequest{}, err
	}
	return pull, nil
}

func (registry *workerRegistry) projectRepository(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	projectID := r.PathValue("id")
	registry.mu.RLock()
	var remote string
	for _, project := range registry.projects {
		if project.ID == projectID {
			remote = project.GitRemote
			break
		}
	}
	registry.mu.RUnlock()
	owner, repository, ok := githubRepositoryParts(remote)
	if !ok {
		http.Error(w, "project is not connected to a GitHub repository", http.StatusNotFound)
		return "", "", false
	}
	return owner, repository, true
}

func githubRepositoryParts(remote string) (string, string, bool) {
	host, path, found := strings.Cut(remote, "/")
	parts := strings.Split(path, "/")
	if !found || host != "github.com" || len(parts) != 2 || !validGitRemote(remote) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (registry *workerRegistry) listGitHubPullRequests(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	items := make([]gitHubPullRequest, 0)
	if err := registry.github.request(r.Context(), "/repos/"+owner+"/"+repository+"/pulls", &items); err != nil {
		http.Error(w, "GitHub pull requests are unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (registry *workerRegistry) getGitHubPullRequestDiff(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	number, err := strconv.Atoi(r.PathValue("number"))
	if err != nil || number < 1 {
		http.Error(w, "pull request number is invalid", http.StatusBadRequest)
		return
	}
	diff, err := registry.github.pullRequestDiff(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub pull request diff is unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"diff": diff})
}

func (registry *workerRegistry) listGitHubIssues(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	records := make([]gitHubIssue, 0)
	if err := registry.github.request(r.Context(), "/repos/"+owner+"/"+repository+"/issues", &records); err != nil {
		http.Error(w, "GitHub issues are unavailable", http.StatusBadGateway)
		return
	}
	items := make([]gitHubIssue, 0, len(records))
	for _, issue := range records {
		if issue.PullRequest == nil {
			items = append(items, issue)
		}
	}
	writeJSON(w, http.StatusOK, items)
}

func (registry *workerRegistry) commentGitHubIssue(w http.ResponseWriter, r *http.Request) {
	host, _, remoteErr := net.SplitHostPort(r.RemoteAddr)
	remoteIP := net.ParseIP(host)
	if remoteErr != nil || remoteIP == nil || !remoteIP.IsLoopback() {
		http.Error(w, "GitHub issue comments are available only from a local client", http.StatusForbidden)
		return
	}
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	number, err := strconv.Atoi(r.PathValue("number"))
	if err != nil || number < 1 {
		http.Error(w, "issue number is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		Body string `json:"body"`
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "issue comment must use application/json", http.StatusUnsupportedMediaType)
		return
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Body = strings.TrimSpace(input.Body)
	if input.Body == "" || len(input.Body) > 1000 {
		http.Error(w, "issue comment must be between 1 and 1000 bytes", http.StatusBadRequest)
		return
	}
	if registry.github.token == "" {
		http.Error(w, "GitHub issue comment token is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	issue, err := registry.github.issue(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub issue details are unavailable; comment was not submitted", http.StatusBadGateway)
		return
	}
	if issue.PullRequest != nil {
		http.Error(w, "pull request numbers cannot be used for issue comments", http.StatusBadRequest)
		return
	}
	if err := registry.github.createIssueComment(r.Context(), owner, repository, number, input.Body); err != nil {
		http.Error(w, "GitHub could not submit this issue comment; verify token permissions and provider access", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "submitted"})
}

func (registry *workerRegistry) updateGitHubIssue(w http.ResponseWriter, r *http.Request) {
	host, _, remoteErr := net.SplitHostPort(r.RemoteAddr)
	remoteIP := net.ParseIP(host)
	if remoteErr != nil || remoteIP == nil || !remoteIP.IsLoopback() {
		http.Error(w, "GitHub issue updates are available only from a local client", http.StatusForbidden)
		return
	}
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	number, err := strconv.Atoi(r.PathValue("number"))
	if err != nil || number < 1 {
		http.Error(w, "issue number is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		State string `json:"state"`
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "issue update must use application/json", http.StatusUnsupportedMediaType)
		return
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if input.State != "open" && input.State != "closed" {
		http.Error(w, "issue state must be open or closed", http.StatusBadRequest)
		return
	}
	if registry.github.token == "" {
		http.Error(w, "GitHub issue update token is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	issue, err := registry.github.issue(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub issue details are unavailable; state was not changed", http.StatusBadGateway)
		return
	}
	if issue.PullRequest != nil {
		http.Error(w, "pull request numbers cannot be used for issue state changes", http.StatusBadRequest)
		return
	}
	if err := registry.github.updateIssueState(r.Context(), owner, repository, number, input.State); err != nil {
		http.Error(w, "GitHub could not update this issue; verify token permissions and provider access", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "state": input.State})
}

func (registry *workerRegistry) reviewGitHubPullRequest(w http.ResponseWriter, r *http.Request) {
	host, _, remoteErr := net.SplitHostPort(r.RemoteAddr)
	remoteIP := net.ParseIP(host)
	if remoteErr != nil || remoteIP == nil || !remoteIP.IsLoopback() {
		http.Error(w, "GitHub reviews are available only from a local client", http.StatusForbidden)
		return
	}
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	number, err := strconv.Atoi(r.PathValue("number"))
	if err != nil || number < 1 {
		http.Error(w, "pull request number is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		Body  string `json:"body"`
		Event string `json:"event"`
	}
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "review request must use application/json", http.StatusUnsupportedMediaType)
		return
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.Body = strings.TrimSpace(input.Body)
	if input.Body == "" || len(input.Body) > 1000 {
		http.Error(w, "review body must be between 1 and 1000 bytes", http.StatusBadRequest)
		return
	}
	if input.Event != "COMMENT" && input.Event != "REQUEST_CHANGES" {
		http.Error(w, "review event must be COMMENT or REQUEST_CHANGES", http.StatusBadRequest)
		return
	}
	if registry.github.token == "" {
		http.Error(w, "GitHub review token is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	pull, err := registry.github.pullRequest(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub pull request details are unavailable; review was not submitted", http.StatusBadGateway)
		return
	}
	if err := registry.github.submitPullRequestReview(r.Context(), owner, repository, number, input.Body, input.Event); err != nil {
		http.Error(w, "GitHub could not submit this review; verify token permissions and provider access", http.StatusBadGateway)
		return
	}
	result := struct {
		Status            string `json:"status"`
		AgentRunLinked    bool   `json:"agent_run_linked"`
		AgentRunQueued    bool   `json:"agent_run_queued"`
		FeedbackSyncError string `json:"feedback_sync_error,omitempty"`
	}{Status: "submitted"}
	if runID, ok := strings.CutPrefix(pull.Head.Ref, agentRunBranchPrefix); ok && validHexID(runID) && registry.runs != nil {
		run, status, message := registry.runs.recordReview(
			runID, r.PathValue("id"), input.Body, input.Event == "REQUEST_CHANGES", false,
		)
		if status == 0 {
			result.AgentRunLinked = true
			result.AgentRunQueued = run.Status == "queued"
		} else if status != http.StatusNotFound {
			result.FeedbackSyncError = message
		}
	}
	writeJSON(w, http.StatusOK, result)
}
