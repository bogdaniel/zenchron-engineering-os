package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

type gitHubMergeResult struct {
	SHA     string `json:"sha"`
	Merged  bool   `json:"merged"`
	Message string `json:"message"`
}

type gitHubCommitStatus struct {
	State    string `json:"state"`
	Statuses []struct {
		State string `json:"state"`
	} `json:"statuses"`
}

func (client gitHubClient) mergePullRequest(ctx context.Context, owner, repository string, number int, expectedHead, method string) (gitHubMergeResult, error) {
	if !client.authConfigured() {
		return gitHubMergeResult{}, errors.New("GitHub authentication is not configured")
	}
	payload, err := json.Marshal(struct {
		SHA         string `json:"sha"`
		MergeMethod string `json:"merge_method"`
	}{expectedHead, method})
	if err != nil {
		return gitHubMergeResult{}, err
	}
	path := "/repos/" + owner + "/" + repository + "/pulls/" + strconv.Itoa(number) + "/merge"
	response, err := client.requestBytes(ctx, http.MethodPut, path, "application/vnd.github+json", nil, payload)
	if err != nil {
		return gitHubMergeResult{}, err
	}
	var result gitHubMergeResult
	if err := json.Unmarshal(response, &result); err != nil {
		return gitHubMergeResult{}, fmt.Errorf("decode GitHub merge result: %w", err)
	}
	if !result.Merged || !fullGitSHA(result.SHA) {
		return gitHubMergeResult{}, errors.New("GitHub did not confirm a merged commit")
	}
	return result, nil
}

func (registry *workerRegistry) mergeGitHubPullRequest(w http.ResponseWriter, r *http.Request) {
	if !localOrAuthorizedClient(r) {
		http.Error(w, "GitHub pull request merges require an authorized local operator", http.StatusForbidden)
		return
	}
	operator := accessFor(r).user
	if operator == "" {
		http.Error(w, "sign in with GitHub before merging a pull request", http.StatusForbidden)
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
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		http.Error(w, "merge request must use application/json", http.StatusUnsupportedMediaType)
		return
	}
	var input struct {
		HeadSHA string `json:"head_sha"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	input.HeadSHA = strings.ToLower(strings.TrimSpace(input.HeadSHA))
	if !fullGitSHA(input.HeadSHA) {
		http.Error(w, "expected head SHA must be a full lowercase Git commit SHA", http.StatusBadRequest)
		return
	}
	if !registry.github.authConfigured() {
		http.Error(w, "GitHub authentication is not configured on the control plane", http.StatusServiceUnavailable)
		return
	}
	pull, err := registry.github.pullRequest(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "GitHub pull request state is unavailable; nothing was merged", http.StatusBadGateway)
		return
	}
	if pull.Number != number || pull.State != "open" || pull.MergedAt != nil {
		http.Error(w, "pull request is no longer open", http.StatusConflict)
		return
	}
	if pull.Head.SHA != input.HeadSHA {
		http.Error(w, "pull request head changed; refresh and review the current revision", http.StatusConflict)
		return
	}
	if pull.Draft {
		http.Error(w, "draft pull requests cannot be merged", http.StatusConflict)
		return
	}
	if pull.Mergeable == nil {
		http.Error(w, "GitHub has not finished computing mergeability; refresh and try again", http.StatusConflict)
		return
	}
	if !*pull.Mergeable || pull.MergeableState != "clean" {
		http.Error(w, mergeabilityMessage(pull.MergeableState), http.StatusConflict)
		return
	}
	checks, err := registry.github.commitCheckRuns(r.Context(), owner, repository, input.HeadSHA)
	if err != nil {
		http.Error(w, "current pull request checks are unavailable; nothing was merged", http.StatusBadGateway)
		return
	}
	status, err := registry.github.commitStatus(r.Context(), owner, repository, input.HeadSHA)
	if err != nil {
		http.Error(w, "current pull request status checks are unavailable; nothing was merged", http.StatusBadGateway)
		return
	}
	reviews, err := registry.github.pullRequestReviews(r.Context(), owner, repository, number)
	if err != nil {
		http.Error(w, "current pull request reviews are unavailable; nothing was merged", http.StatusBadGateway)
		return
	}
	if reviewer := outstandingChangeRequest(reviews); reviewer != "" {
		http.Error(w, "review from @"+reviewer+" still requests changes; obtain a fresh approval on GitHub", http.StatusConflict)
		return
	}
	if !hasCurrentApproval(reviews, input.HeadSHA) {
		http.Error(w, "a trusted human approval on the current pull request head is required", http.StatusConflict)
		return
	}
	if !hasSuccessfulCheck(checks, status) {
		http.Error(w, "at least one successful CI check on the current pull request head is required", http.StatusConflict)
		return
	}
	permission, err := registry.github.collaboratorPermission(r.Context(), owner, repository, operator)
	if err != nil {
		http.Error(w, "GitHub could not verify your repository merge permission; nothing was merged", http.StatusBadGateway)
		return
	}
	if !canMergeWithPermission(permission) {
		http.Error(w, "your GitHub account lacks write permission to merge this repository", http.StatusForbidden)
		return
	}
	method, err := registry.github.pullRequestMergeMethod(r.Context(), owner, repository)
	if err != nil {
		http.Error(w, "GitHub repository merge settings are unavailable; nothing was merged", http.StatusBadGateway)
		return
	}
	result, err := registry.github.mergePullRequest(r.Context(), owner, repository, number, input.HeadSHA, method)
	if err != nil {
		http.Error(w, githubMergeFailure(err), mergeFailureStatus(err))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Status    string `json:"status"`
		CommitSHA string `json:"commit_sha"`
		HeadSHA   string `json:"head_sha"`
		Message   string `json:"message"`
	}{"merged", result.SHA, input.HeadSHA, result.Message})
}

func mergeabilityMessage(state string) string {
	switch state {
	case "dirty":
		return "pull request has conflicting changes; update the branch before merging"
	case "blocked":
		return "GitHub branch policy blocks this merge; check required reviews and status checks"
	case "behind":
		return "pull request branch is behind its base; update and review the new head"
	case "unstable":
		return "GitHub reports a failing required check"
	default:
		return "GitHub cannot confirm this pull request is ready to merge; refresh its current state"
	}
}

func outstandingChangeRequest(reviews []gitHubReview) string {
	for _, review := range latestPullRequestDecisions(reviews) {
		if review.State == "CHANGES_REQUESTED" {
			return strings.ToLower(strings.TrimSpace(review.User.Login))
		}
	}
	return ""
}

func latestPullRequestDecisions(reviews []gitHubReview) []gitHubReview {
	latest := make(map[string]gitHubReview)
	for _, review := range reviews {
		login := strings.ToLower(strings.TrimSpace(review.User.Login))
		if login == "" || (review.State != "CHANGES_REQUESTED" && review.State != "APPROVED" && review.State != "DISMISSED") {
			continue
		}
		previous, exists := latest[login]
		if !exists || review.SubmittedAt.After(previous.SubmittedAt) ||
			(review.SubmittedAt.Equal(previous.SubmittedAt) && review.ID > previous.ID) {
			latest[login] = review
		}
	}
	decisions := make([]gitHubReview, 0, len(latest))
	for _, review := range latest {
		decisions = append(decisions, review)
	}
	slices.SortFunc(decisions, func(a, b gitHubReview) int {
		return strings.Compare(strings.ToLower(a.User.Login), strings.ToLower(b.User.Login))
	})
	return decisions
}

func hasCurrentApproval(reviews []gitHubReview, head string) bool {
	for _, review := range latestPullRequestDecisions(reviews) {
		if review.State == "APPROVED" && review.CommitID == head && trustedGitHubAuthor(review.AuthorAssociation) {
			return true
		}
	}
	return false
}

func hasSuccessfulCheck(checks []gitHubCheckRun, status gitHubCommitStatus) bool {
	for _, check := range checks {
		if check.Status == "completed" && check.Conclusion == "success" {
			return true
		}
	}
	if status.State == "success" {
		return true
	}
	return slices.ContainsFunc(status.Statuses, func(check struct {
		State string `json:"state"`
	}) bool {
		return check.State == "success"
	})
}

func (client gitHubClient) commitStatus(ctx context.Context, owner, repository, commit string) (gitHubCommitStatus, error) {
	var status gitHubCommitStatus
	path := "/repos/" + owner + "/" + repository + "/commits/" + commit + "/status"
	if err := client.get(ctx, path, nil, &status); err != nil {
		return gitHubCommitStatus{}, err
	}
	return status, nil
}

func (client gitHubClient) collaboratorPermission(ctx context.Context, owner, repository, login string) (string, error) {
	var result struct {
		Permission string `json:"permission"`
	}
	path := "/repos/" + owner + "/" + repository + "/collaborators/" + url.PathEscape(login) + "/permission"
	if err := client.get(ctx, path, nil, &result); err != nil {
		return "", err
	}
	return result.Permission, nil
}

func canMergeWithPermission(permission string) bool {
	switch permission {
	case "write", "maintain", "admin":
		return true
	default:
		return false
	}
}

func (client gitHubClient) pullRequestMergeMethod(ctx context.Context, owner, repository string) (string, error) {
	var settings struct {
		AllowSquash bool `json:"allow_squash_merge"`
		AllowMerge  bool `json:"allow_merge_commit"`
		AllowRebase bool `json:"allow_rebase_merge"`
	}
	if err := client.get(ctx, "/repos/"+owner+"/"+repository, nil, &settings); err != nil {
		return "", err
	}
	if settings.AllowSquash {
		return "squash", nil
	}
	if settings.AllowMerge {
		return "merge", nil
	}
	if settings.AllowRebase {
		return "rebase", nil
	}
	return "", errors.New("repository has no enabled merge method")
}

func mergeFailureStatus(err error) int {
	switch {
	case strings.Contains(err.Error(), "GitHub returned HTTP 403"):
		return http.StatusForbidden
	case strings.Contains(err.Error(), "GitHub returned HTTP 409"):
		return http.StatusConflict
	case strings.Contains(err.Error(), "GitHub returned HTTP 405"), strings.Contains(err.Error(), "GitHub returned HTTP 422"):
		return http.StatusConflict
	default:
		return http.StatusBadGateway
	}
}

func githubMergeFailure(err error) string {
	switch mergeFailureStatus(err) {
	case http.StatusForbidden:
		return "GitHub denied the merge because the configured credentials lack repository permission"
	case http.StatusConflict:
		return "GitHub refused the merge because its head or branch protection state changed; refresh and review the pull request"
	default:
		return "GitHub could not complete the merge: " + err.Error()
	}
}

func fullGitSHA(value string) bool {
	if len(value) != 40 || strings.ToLower(value) != value {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}
