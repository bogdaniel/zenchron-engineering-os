package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func validAgentRunResult(input workerapi.AgentRunResult) bool {
	return (input.Status == "succeeded" || input.Status == "failed" || input.Status == "cancelled") &&
		len(input.Output) <= 20000 && len(input.Error) <= 255 &&
		(input.Diff == nil || len(*input.Diff) <= maxAgentRunDiffSize) &&
		input.Attempts >= 1 && input.Attempts <= maxAgentRunAttempts &&
		validCommitSHA(input.CommitSHA) && validCommitSHA(input.BaseCommit) &&
		!(input.BranchPushed && input.BranchPushFailed) && len(input.ProviderVersion) <= 100 &&
		workerapi.ValidTerminationReason(input.TerminationReason) && workerapi.ValidVerification(input.Verification) &&
		(input.Usage == nil || input.Usage.InputTokens >= 0 && input.Usage.OutputTokens >= 0 &&
			(input.Usage.CostUSD == nil || *input.Usage.CostUSD >= 0))
}

// finish records the result of the current attempt. Only the worker holding the current lease can
// finish a run, so a stale attempt can never overwrite a newer one.
func (store *agentRunStore) finish(w http.ResponseWriter, r *http.Request) {
	workerID, runID := strings.ToLower(r.PathValue("id")), strings.ToLower(r.PathValue("requestID"))
	if !validHexID(workerID) || !validHexID(runID) {
		http.Error(w, "worker or run id is invalid", http.StatusBadRequest)
		return
	}
	var input workerapi.AgentRunResult
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if !validAgentRunResult(input) {
		http.Error(w, "agent run result is invalid", http.StatusBadRequest)
		return
	}
	access := accessFor(r)
	item, status, message := store.update(runID, func(item *agentRun) (int, string) {
		// A result from a worker whose grant for the repository was removed is not accepted or published.
		if item.WorkerID == workerID && !access.allows(item.Repository) {
			return http.StatusForbidden, "this worker is no longer approved for the run's repository"
		}
		return store.applyResult(item, workerID, input)
	})
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status", Message: "Attempt finished: " + item.Status})
	if item.Status == "succeeded" && item.PullRequestEnabled {
		if item, status, message = store.publishResult(r.Context(), runID, input.BranchPushed, input.BranchPushFailed); status != 0 {
			http.Error(w, message, status)
			return
		}
	}
	writeJSON(w, http.StatusOK, publicAgentRun(item))
}

func (store *agentRunStore) applyResult(item *agentRun, workerID string, input workerapi.AgentRunResult) (int, string) {
	now := time.Now().UTC()
	if item.WorkerID != workerID || item.Status != "running" || item.Attempts != input.Attempts || now.After(item.LeaseUntil) {
		return http.StatusConflict, "agent run lease is no longer current"
	}
	if item.CancelRequested {
		input.Status, input.Output, input.Error = "cancelled", "", "Cancellation requested from dashboard."
		input.BranchPushed, input.BranchPushFailed, input.TerminationReason = false, false, workerapi.TerminationCancelled
	}
	if (input.BranchPushed || input.BranchPushFailed) &&
		(!item.PullRequestEnabled || input.Status != "succeeded" || input.CommitSHA == "" ||
			input.Verification == workerapi.VerificationFailed) {
		return http.StatusConflict, "agent branch publish result is not allowed"
	}
	if input.Status == "cancelled" && !item.CancelRequested {
		return http.StatusConflict, "agent run cancellation was not requested"
	}
	item.Status, item.Output, item.Error, item.CancelRequested, item.UpdatedAt, item.LeaseUntil =
		input.Status, input.Output, input.Error, false, now, time.Time{}
	item.TerminationReason, item.Verification, item.Usage = input.TerminationReason, input.Verification, input.Usage
	item.ProviderVersion, item.Publication = input.ProviderVersion, ""
	if input.BranchPushed {
		// Recorded with the result, so a crash before the pull request exists still leaves a retry path.
		item.Publication = publicationPullRequestFailed
	}
	if input.CommitSHA != "" {
		item.CommitSHA = input.CommitSHA
	}
	if input.BaseCommit != "" {
		item.BaseCommit = input.BaseCommit
	}
	if input.Diff != nil {
		if err := store.writeDiff(item.ID, input.Attempts, *input.Diff); err != nil {
			return http.StatusInternalServerError, "could not persist agent run diff"
		}
		item.DiffAttempt, item.DiffAvailable, item.DiffTruncated = input.Attempts, true, input.DiffTruncated
	}
	item.closeAttempt(now, input.Status, input.TerminationReason)
	return 0, ""
}

// publishResult records what happened to a successful run's branch and creates or reuses its pull
// request. GitHub is called without holding the store lock.
func (store *agentRunStore) publishResult(ctx context.Context, runID string, pushed, pushFailed bool) (agentRun, int, string) {
	store.mu.Lock()
	item := store.items[runID]
	store.mu.Unlock()
	publication, publishError, number, pullURL := "", "", 0, ""
	switch {
	case item.CommitSHA == "":
		publication, publishError = publicationNoChanges, "No committed changes to publish."
	case pushFailed:
		publication, publishError = publicationPushFailed, "Git could not push the branch; the local diff is still available."
	case !pushed:
		publication, publishError = publicationPushFailed, "The worker did not publish the branch; the local diff is still available."
	default:
		pull, err := store.createPullRequest(ctx, item)
		if err != nil {
			publication, publishError = publicationPullRequestFailed, "The branch was pushed, but GitHub could not create the pull request."
		} else {
			publication, number, pullURL = publicationPublished, pull.Number, pull.HTMLURL
		}
	}
	item, status, message := store.update(runID, func(item *agentRun) (int, string) {
		item.Publication, item.PullRequestError = publication, publishError
		if number > 0 {
			item.PullRequestNumber, item.PullRequestURL = number, pullURL
		}
		return 0, ""
	})
	if status != 0 {
		return agentRun{}, status, "pull request state could not be persisted"
	}
	event := "Publication: " + publication
	if pullURL != "" {
		event += " " + pullURL
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status", Message: event})
	return item, 0, message
}

// publish retries pull-request creation for a run whose branch is already on GitHub. Creation reuses an
// open pull request for the same branch, so repeating it never produces a duplicate.
func (store *agentRunStore) publish(w http.ResponseWriter, r *http.Request) {
	runID := strings.ToLower(r.PathValue("id"))
	if !validHexID(runID) {
		http.Error(w, "agent run id is invalid", http.StatusBadRequest)
		return
	}
	store.mu.Lock()
	item, exists := store.items[runID]
	store.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	if item.Status != "succeeded" || item.Publication != publicationPullRequestFailed {
		http.Error(w, "only a pushed run without a pull request can be published again", http.StatusConflict)
		return
	}
	item, status, message := store.publishResult(r.Context(), runID, true, false)
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	writeJSON(w, http.StatusOK, publicAgentRun(item))
}

func (store *agentRunStore) createPullRequest(ctx context.Context, item agentRun) (gitHubPullRequest, error) {
	owner, repository, ok := githubRepositoryParts(item.Repository)
	if !ok {
		return gitHubPullRequest{}, fmt.Errorf("run repository is not a GitHub repository")
	}
	title := item.IssueTitle
	if title == "" {
		title = firstLine(item.Prompt)
	}
	if title == "" {
		title = "Agent changes " + item.ID[:8]
	}
	if len([]rune(title)) > 200 {
		title = string([]rune(title)[:200])
	}
	body := strings.TrimSpace(item.Output)
	if body == "" {
		body = "Completed agent changes are ready for review."
	}
	if bodyRunes := []rune(body); len(bodyRunes) > 9_000 {
		body = string(bodyRunes[:9_000])
	}
	if item.IssueNumber > 0 {
		body += fmt.Sprintf("\n\nCloses #%d", item.IssueNumber)
	}
	provider := item.ProviderVersion
	if !strings.Contains(provider, item.Provider) {
		provider = strings.TrimSpace(item.Provider + " " + item.ProviderVersion)
	}
	body += fmt.Sprintf("\n\nGenerated by Zenchron run `%s` with %s; verification on the worker: %s.",
		item.ID, provider, verificationLabel(item.Verification))
	pull, err := store.registry.github.createPullRequest(ctx, owner, repository, item.Branch, item.BaseBranch, title, body)
	if err != nil {
		return gitHubPullRequest{}, err
	}
	if pull.Number < 1 || !strings.HasPrefix(pull.HTMLURL, "https://github.com/") {
		return gitHubPullRequest{}, fmt.Errorf("GitHub returned an invalid pull request")
	}
	return pull, nil
}

func verificationLabel(verification string) string {
	switch verification {
	case workerapi.VerificationPassed:
		return "passed"
	case workerapi.VerificationNotConfigured:
		return "not configured"
	default:
		return "not run"
	}
}

func firstLine(value string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(value), "\n")
	return strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "# "))
}
