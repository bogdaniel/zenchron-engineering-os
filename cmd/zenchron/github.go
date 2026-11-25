package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
const maxGitHubIssueListItems = 100

// ponytail: scans at most 1,000 GitHub records to bound dashboard latency; expand with explicit UI pagination if needed.
const maxGitHubIssueListPages = 10

const gitHubAPIURL = "https://api.github.com"

const (
	gitHubAuthMethodPersonalToken = "personal_access_token"
	gitHubAuthMethodApp           = "github_app"
	gitHubAuthMethodMissing       = "missing"
)

type gitHubClient struct {
	apiURL  string
	token   string
	appAuth *gitHubAppAuth
	client  *http.Client
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
		SHA string `json:"sha"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
	} `json:"base"`
	Mergeable      *bool  `json:"mergeable"`
	MergeableState string `json:"mergeable_state"`
}

type gitHubPullRequestCleanupError struct {
	Number int
	Err    error
}

func (err *gitHubPullRequestCleanupError) Error() string {
	return fmt.Sprintf("GitHub created pull request #%d for a different candidate and closing it failed: %v",
		err.Number, err.Err)
}

func (err *gitHubPullRequestCleanupError) Unwrap() error { return err.Err }

type gitHubIssue struct {
	Number      int            `json:"number"`
	Comments    int            `json:"comments"`
	Title       string         `json:"title"`
	State       string         `json:"state"`
	HTMLURL     string         `json:"html_url"`
	Body        string         `json:"body,omitempty"`
	UpdatedAt   time.Time      `json:"updated_at"`
	PullRequest map[string]any `json:"pull_request,omitempty"`
	// AuthorAssociation is GitHub's statement of the author's relationship to the repository.
	AuthorAssociation string `json:"author_association,omitempty"`
	User              struct {
		Login string `json:"login"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
}

func newGitHubClient() gitHubClient {
	return gitHubClient{
		apiURL: gitHubAPIURL, token: strings.TrimSpace(os.Getenv("ZENCHRON_GITHUB_TOKEN")),
		appAuth: newGitHubAppAuthFromEnv(), client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (client gitHubClient) authenticationMethod() string {
	if client.token != "" {
		return gitHubAuthMethodPersonalToken
	}
	if client.appAuth != nil && client.appAuth.configured() {
		return gitHubAuthMethodApp
	}
	return gitHubAuthMethodMissing
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

var errPullRequestHeadChanged = errors.New("pull request head changed while the diff was being read")
var errPullRequestDiffTooLarge = errors.New("pull request diff exceeds the size limit")

func (client gitHubClient) pullRequestDiff(ctx context.Context, owner, repository string, number int, expectedHead string) (string, error) {
	current, err := client.pullRequest(ctx, owner, repository, number)
	if err != nil {
		return "", err
	}
	if current.Head.SHA != expectedHead {
		return "", errPullRequestHeadChanged
	}
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number)
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github.diff", nil, nil)
	if err != nil {
		if errors.Is(err, errGitHubResponseTooLarge) {
			return "", errPullRequestDiffTooLarge
		}
		return "", err
	}
	latest, err := client.pullRequest(ctx, owner, repository, number)
	if err != nil {
		return "", err
	}
	if latest.Head.SHA != expectedHead {
		return "", errPullRequestHeadChanged
	}
	return string(body), nil
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
	if !client.authConfigured() {
		return fmt.Errorf("GitHub authentication is not configured")
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
	if !client.authConfigured() {
		return fmt.Errorf("GitHub authentication is not configured")
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
	if !client.authConfigured() {
		return fmt.Errorf("GitHub authentication is not configured")
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

func (client gitHubClient) createPullRequest(
	ctx context.Context, owner, repository, head, base, candidateSHA, title, body string,
) (gitHubPullRequest, error) {
	query := make(url.Values)
	query.Set("state", "all")
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
	var closed *gitHubPullRequest
	for index := range existing {
		pull := &existing[index]
		if pull.Head.Ref == head && pull.Base.Ref == base {
			if pull.State == "open" {
				if pull.Head.SHA != candidateSHA {
					return gitHubPullRequest{}, fmt.Errorf("open pull request head does not match candidate")
				}
				return *pull, nil
			}
			if pull.Head.SHA == candidateSHA && closed == nil {
				closed = pull
			}
		}
	}
	if closed != nil {
		return *closed, nil
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
	if pull.Head.SHA != candidateSHA {
		if pull.Number < 1 {
			return gitHubPullRequest{}, fmt.Errorf("GitHub created a mismatched pull request without a valid number to close it")
		}
		// The pull request exists, so caller cancellation must not skip cleanup.
		if err := client.closePullRequest(context.WithoutCancel(ctx), owner, repository, pull.Number); err != nil {
			return gitHubPullRequest{}, &gitHubPullRequestCleanupError{Number: pull.Number, Err: err}
		}
		return gitHubPullRequest{}, fmt.Errorf("GitHub created pull request #%d for a different candidate; it was closed",
			pull.Number)
	}
	return pull, nil
}

func (client gitHubClient) closePullRequest(ctx context.Context, owner, repository string, number int) error {
	if number < 1 {
		return fmt.Errorf("pull request number is invalid")
	}
	payload, err := json.Marshal(struct {
		State string `json:"state"`
	}{State: "closed"})
	if err != nil {
		return err
	}
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number)
	_, err = client.requestBytes(ctx, http.MethodPatch, path, "application/vnd.github+json", nil, payload)
	return err
}

// localOrAuthorizedClient gates GitHub writes made with the control plane's own credentials. A remote
// client qualifies only through an enforced access policy, which projectRepository then applies.
func localOrAuthorizedClient(r *http.Request) bool {
	if accessFor(r).enforced {
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	remoteIP := net.ParseIP(host)
	return err == nil && remoteIP != nil && remoteIP.IsLoopback()
}

// projectRepository resolves the GitHub repository behind a project the caller is allowed to touch.
// A project outside the caller's access is reported exactly like one that does not exist.
func (registry *workerRegistry) projectRepository(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	remote, _ := registry.repositoryOf(r.PathValue("id"))
	owner, repository, ok := githubRepositoryParts(remote)
	if !ok || !accessFor(r).allows(remote) {
		http.Error(w, "project is not connected to a GitHub repository", http.StatusNotFound)
		return "", "", false
	}
	return owner, repository, true
}

// repositoryOf resolves a registered project id to its repository.
func (registry *workerRegistry) repositoryOf(projectID string) (string, bool) {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	for _, project := range registry.projects {
		if project.ID == projectID {
			return project.GitRemote, true
		}
	}
	return "", false
}

func githubRepositoryParts(remote string) (string, string, bool) {
	host, path, found := strings.Cut(remote, "/")
	parts := strings.Split(path, "/")
	if !found || !strings.EqualFold(host, "github.com") || len(parts) != 2 || !validGitRemote(remote) {
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
	expectedHead := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("head_sha")))
	if !fullGitSHA(expectedHead) {
		http.Error(w, "a full inspected pull request head SHA is required", http.StatusBadRequest)
		return
	}
	diff, err := registry.github.pullRequestDiff(r.Context(), owner, repository, number, expectedHead)
	if err != nil {
		if errors.Is(err, errPullRequestHeadChanged) {
			http.Error(w, "pull request head changed; refresh and inspect the current revision", http.StatusConflict)
			return
		}
		if errors.Is(err, errPullRequestDiffTooLarge) {
			http.Error(w, fmt.Sprintf("pull request diff exceeds the %d-byte limit", maxGitHubResponseSize),
				http.StatusUnprocessableEntity)
			return
		}
		http.Error(w, "GitHub pull request diff is unavailable", http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"head_sha": expectedHead, "diff": diff})
}

func (registry *workerRegistry) listGitHubIssues(w http.ResponseWriter, r *http.Request) {
	owner, repository, ok := registry.projectRepository(w, r)
	if !ok {
		return
	}
	path := "/repos/" + owner + "/" + repository + "/issues"
	items := make([]gitHubIssue, 0, maxGitHubIssueListItems)
	complete := false
	for page := 1; page <= maxGitHubIssueListPages; page++ {
		query := make(url.Values)
		query.Set("state", "open")
		query.Set("per_page", strconv.Itoa(maxGitHubIssueListItems))
		query.Set("sort", "updated")
		query.Set("direction", "desc")
		query.Set("page", strconv.Itoa(page))
		body, err := registry.github.requestBytes(r.Context(), http.MethodGet, path, "application/vnd.github+json", query, nil)
		if err != nil {
			http.Error(w, "GitHub issues are unavailable", http.StatusBadGateway)
			return
		}
		var records []gitHubIssue
		if err := json.Unmarshal(body, &records); err != nil {
			http.Error(w, "GitHub issues are unavailable", http.StatusBadGateway)
			return
		}
		for _, issue := range records {
			if issue.PullRequest != nil {
				continue
			}
			if len(items) == maxGitHubIssueListItems {
				w.Header().Set("X-Zenchron-Complete", "false")
				writeJSON(w, http.StatusOK, items)
				return
			}
			items = append(items, issue)
		}
		if len(records) < maxGitHubIssueListItems {
			complete = true
			break
		}
	}
	w.Header().Set("X-Zenchron-Complete", strconv.FormatBool(complete))
	writeJSON(w, http.StatusOK, items)
}

func (registry *workerRegistry) commentGitHubIssue(w http.ResponseWriter, r *http.Request) {
	if !localOrAuthorizedClient(r) {
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
	if !registry.github.authConfigured() {
		http.Error(w, "GitHub authentication is not configured on the control plane", http.StatusServiceUnavailable)
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
	if !localOrAuthorizedClient(r) {
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
	if !registry.github.authConfigured() {
		http.Error(w, "GitHub authentication is not configured on the control plane", http.StatusServiceUnavailable)
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
	if !localOrAuthorizedClient(r) {
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
	if !registry.github.authConfigured() {
		http.Error(w, "GitHub authentication is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	pull, err := registry.github.pullRequest(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub pull request details are unavailable; review was not submitted", http.StatusBadGateway)
		return
	}
	runID := ""
	if registry.runs != nil {
		runID, _ = registry.runs.findByPullRequest("github.com/"+owner+"/"+repository, pull.Number)
	}
	recordedAsComment := false
	err = registry.github.submitPullRequestReview(r.Context(), owner, repository, number, input.Body, input.Event)
	if errors.Is(err, errGitHubUnprocessableEntity) && input.Event == "REQUEST_CHANGES" && runID != "" {
		if err := registry.github.submitPullRequestReview(r.Context(), owner, repository, number, input.Body, "COMMENT"); err != nil {
			http.Error(w, "GitHub rejected the change request and could not record a comment instead",
				http.StatusBadGateway)
			return
		}
		recordedAsComment = true
	} else if errors.Is(err, errGitHubUnprocessableEntity) {
		http.Error(w, "GitHub rejected this review (HTTP 422); check the pull request state and reviewer permissions",
			http.StatusBadGateway)
		return
	} else if err != nil {
		http.Error(w, "GitHub could not submit this review; verify token permissions and provider access", http.StatusBadGateway)
		return
	}
	result := struct {
		Status            string `json:"status"`
		AgentRunLinked    bool   `json:"agent_run_linked"`
		AgentRunQueued    bool   `json:"agent_run_queued"`
		RecordedAsComment bool   `json:"github_request_changes_recorded_as_comment,omitempty"`
		FeedbackSyncError string `json:"feedback_sync_error,omitempty"`
	}{Status: "submitted", RecordedAsComment: recordedAsComment}
	if runID == "" {
		writeJSON(w, http.StatusOK, result)
		return
	}
	run, status, message := registry.runs.recordReview(
		accessFor(r), runID, r.PathValue("id"), input.Body, input.Event == "REQUEST_CHANGES", false,
	)
	if status == 0 {
		result.AgentRunLinked = true
		result.AgentRunQueued = run.Status == "queued"
	} else if status != http.StatusNotFound {
		result.FeedbackSyncError = message
	}
	writeJSON(w, http.StatusOK, result)
}
