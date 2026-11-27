package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func validAgentRunResult(input workerapi.AgentRunResult) bool {
	return (input.Status == "succeeded" || input.Status == "failed" || input.Status == "cancelled") &&
		len(input.Output) <= 20000 && len(input.Error) <= workerapi.MaxRunErrorSize &&
		(input.Diff == nil || len(*input.Diff) <= maxAgentRunDiffSize) &&
		input.Attempts >= 1 && input.Attempts <= maxAgentRunAttempts+1 &&
		validCommitSHA(input.CommitSHA) && validCommitSHA(input.CommitTreeSHA) && validCommitSHA(input.BaseCommit) &&
		(input.CommitTreeSHA == "" || input.CommitSHA != "") &&
		!(input.BranchPushed && input.BranchPushFailed) && len(input.ProviderVersion) <= 100 &&
		workerapi.ValidTerminationReason(input.TerminationReason) && workerapi.ValidVerification(input.Verification) &&
		len(input.Result) <= workerapi.MaxResultSize &&
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
	store.mu.Lock()
	before, exists := store.items[runID]
	store.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	update := func(item *agentRun) (int, string) {
		if before.GraphID != "" && store.graphs != nil {
			if graph := store.graphs.graphs[before.GraphID]; graph != nil && graph.Status == graphCancelled {
				item.CancelRequested = true
			}
		}
		// A result from a worker whose grant for the repository was removed is not accepted or published.
		if item.WorkerID == workerID && !access.allows(item.Repository) {
			return http.StatusForbidden, "this worker is no longer approved for the run's repository"
		}
		acceptedAttempt := item.ResultAttempt == input.Attempts && item.ResultAttempt > 0
		if !acceptedAttempt {
			for _, attempt := range item.AttemptLog {
				if attempt.Attempt == input.Attempts && attempt.WorkerID == workerID && attempt.FinishedAt != nil &&
					(attempt.Status == "succeeded" || attempt.Status == "failed" || attempt.Status == "cancelled") {
					acceptedAttempt = true
					break
				}
			}
		}
		if item.WorkerID == workerID && acceptedAttempt {
			return http.StatusConflict, workerapi.AgentRunResultAlreadyAccepted
		}
		return store.applyResult(item, workerID, input)
	}
	var item agentRun
	var status int
	var message string
	if before.GraphID != "" && store.graphs != nil {
		store.graphs.mu.Lock()
		item, status, message = store.update(runID, update)
		store.graphs.mu.Unlock()
	} else {
		item, status, message = store.update(runID, update)
	}
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status", Message: "Attempt finished: " + item.Status})
	if item.Status == "succeeded" && item.PullRequestEnabled && item.publicationAuthorized(item.CommitSHA) &&
		(item.GraphID == "" || store.graphs != nil && store.graphs.publicationReady(item, item.CommitSHA)) {
		if item, status, message = store.publishResult(r.Context(), runID, input.BranchPushed, input.BranchPushFailed); status != 0 {
			http.Error(w, message, status)
			return
		}
	}
	store.graphs.reconcileAll()
	writeJSON(w, http.StatusOK, publicAgentRun(item))
}

func (store *agentRunStore) applyResult(item *agentRun, workerID string, input workerapi.AgentRunResult) (int, string) {
	now := time.Now().UTC()
	previousCommit := item.CommitSHA
	publishOnly := item.PublishOnly
	if item.WorkerID != workerID || item.Status != "running" || item.Attempts != input.Attempts || now.After(item.LeaseUntil) {
		return http.StatusConflict, "agent run lease is no longer current"
	}
	if item.Attempts > maxAgentRunAttempts &&
		(!item.PublishOnly || item.PullRequestURL == "" || !item.publicationAuthorized(item.CommitSHA)) {
		return http.StatusConflict, "the additional claim is only allowed for an authorized existing pull-request update"
	}
	if item.CancelRequested {
		input.Status, input.Output, input.Error = "cancelled", "", "Cancellation requested from dashboard."
		input.BranchPushed, input.BranchPushFailed, input.TerminationReason = false, false, workerapi.TerminationCancelled
	}
	if publishOnly && !item.CancelRequested && (input.CommitSHA != "" && input.CommitSHA != item.CommitSHA ||
		input.Status == "succeeded" && input.CommitSHA != item.CommitSHA) {
		return http.StatusConflict, "publish-only result does not match the authorized candidate"
	}
	if (input.BranchPushed || input.BranchPushFailed) &&
		(!item.PublishOnly || !item.PullRequestEnabled || input.Status != "succeeded" || input.CommitSHA == "" ||
			input.Verification == workerapi.VerificationFailed) {
		return http.StatusConflict, "agent branch publish result is not allowed"
	}
	if input.Status == "cancelled" && !item.CancelRequested {
		return http.StatusConflict, "agent run cancellation was not requested"
	}
	item.Status, item.Output, item.Error, item.CancelRequested, item.UpdatedAt, item.LeaseUntil, item.PublishOnly =
		input.Status, input.Output, input.Error, false, now, time.Time{}, false
	item.TerminationReason, item.Verification, item.Publication = input.TerminationReason, input.Verification, ""
	if !publishOnly || input.Usage != nil {
		item.Usage = input.Usage
	}
	if !publishOnly || input.ProviderVersion != "" {
		item.ProviderVersion = input.ProviderVersion
	}
	if !publishOnly || input.Result != "" {
		item.Result, item.ResultAttempt = input.Result, input.Attempts
	}
	if input.BranchPushed {
		// Recorded with the result, so a crash before the pull request exists still leaves a retry path.
		item.Publication, item.Publishing = publicationPullRequestFailed, item.PullRequestEnabled
	}
	if input.CommitSHA != "" {
		item.CommitSHA = input.CommitSHA
		if !publishOnly || input.CommitTreeSHA != "" {
			item.CommitTreeSHA = input.CommitTreeSHA
		}
	}
	item.BranchPushed = input.BranchPushed
	if input.Status == "succeeded" && item.CommitSHA != "" && store.publishable(item.Repository) {
		if item.PullRequestURL != "" && input.CommitSHA == "" && item.CommitSHA == previousCommit {
			item.Publication, item.BranchPushed = publicationPublished, true
		} else {
			item.Publication = publicationAwaitingAuthority
		}
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
	item, exists := store.items[runID]
	store.mu.Unlock()
	if !exists {
		return agentRun{}, http.StatusNotFound, "agent run not found"
	}
	if item.Status != "succeeded" {
		return agentRun{}, http.StatusConflict, "only a succeeded agent run can be published"
	}
	attempt := item.Attempts
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
			// Provider details stay in the control-plane log; cleanup failures include a safe recovery action.
			log.Printf("agent run %s: create pull request: %v", runID, err)
			publication, publishError = publicationPullRequestFailed, "The branch was pushed, but GitHub could not create the pull request."
			var cleanupErr *gitHubPullRequestCleanupError
			if errors.As(err, &cleanupErr) {
				publishError = fmt.Sprintf("GitHub created pull request #%d for a different candidate but could not close it. Close it in GitHub before retrying publication.",
					cleanupErr.Number)
			}
		} else {
			publication, number, pullURL = publicationPublished, pull.Number, pull.HTMLURL
		}
	}
	item, status, message := store.update(runID, func(item *agentRun) (int, string) {
		if item.Status != "succeeded" || item.Attempts != attempt {
			return http.StatusConflict, "agent run changed while its pull request was being created"
		}
		item.Publication, item.PullRequestError, item.Publishing = publication, publishError, false
		if number > 0 {
			item.PullRequestNumber, item.PullRequestURL = number, pullURL
		}
		return 0, ""
	})
	if status != 0 {
		if status == http.StatusInternalServerError {
			store.mu.Lock()
			current, exists := store.items[runID]
			released := exists && current.Status == "succeeded" && current.Attempts == attempt &&
				current.Publishing
			if released {
				current.Publishing = false
				store.items[runID] = current
			}
			store.mu.Unlock()
			if released && store.graphs != nil {
				store.graphs.reconcileAll()
			}
			return agentRun{}, status, "pull request state could not be persisted"
		}
		return agentRun{}, status, message
	}
	event := "Publication: " + publication
	if pullURL != "" {
		event += " " + pullURL
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status", Message: event})
	return item, 0, message
}

// publish retries pull-request creation for a run whose branch is already on GitHub. Creation reuses an
// existing pull request for the same branch and base, so an uncertain response cannot create a duplicate.
func (store *agentRunStore) publish(w http.ResponseWriter, r *http.Request) {
	runID := strings.ToLower(r.PathValue("id"))
	if !validHexID(runID) {
		http.Error(w, "agent run id is invalid", http.StatusBadRequest)
		return
	}
	var input struct {
		CandidateSHA string `json:"candidate_sha"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	if !fullGitSHA(input.CandidateSHA) {
		http.Error(w, "candidate_sha must be a full commit SHA", http.StatusBadRequest)
		return
	}
	access := accessFor(r)
	store.mu.Lock()
	before, exists := store.items[runID]
	store.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	update := func(item *agentRun) (int, string) {
		switch {
		case !access.allows(item.Repository):
			return http.StatusForbidden, "you may not publish changes from this repository"
		case !access.mayDispatchTo(item.WorkerID):
			return http.StatusForbidden, "this run's worker is not available to this user"
		case item.GraphID != "" && (store.graphs == nil || store.graphs.graphs[item.GraphID] == nil ||
			!store.graphs.mayRead(access, store.graphs.graphs[item.GraphID])):
			return http.StatusNotFound, "agent run not found"
		case item.Status != "succeeded" || item.CommitSHA != input.CandidateSHA:
			return http.StatusConflict, "the candidate changed or the run has not completed"
		case item.PullRequestURL != "" && item.Publication == publicationPublished && item.CommitSHA == input.CandidateSHA:
			return http.StatusConflict, "this candidate already has a pull request"
		case !store.publishable(item.Repository):
			return http.StatusConflict, "GitHub publication is not configured for this repository"
		case item.Publishing:
			return http.StatusConflict, "pull request publication is already in progress"
		}
		graphRevision, planRevision, planHash, graphReady := 0, 0, "", item.GraphID == ""
		if item.GraphID != "" && store.graphs != nil {
			runs := unitRunsForGraph(store.items, item.GraphID)
			graphRevision, planRevision, planHash, graphReady =
				store.graphs.publicationBindingLocked(*item, input.CandidateSHA, runs)
		}
		if !graphReady {
			return http.StatusConflict, "the WorkGraph candidate has not passed its current independent reviews"
		}
		preauthorized := item.publicationAuthorized(input.CandidateSHA)
		if item.GraphID != "" {
			preauthorized = item.publicationAuthorizedFor(input.CandidateSHA, item.GraphID, planRevision, planHash)
		}
		if !preauthorized {
			actor := access.user
			if !access.enforced {
				actor = localOperator
			}
			if actor == "" {
				return http.StatusForbidden, "a signed-in person is required to authorize publication"
			}
			item.PublicationAuthorizations = append(item.PublicationAuthorizations, publicationAuthorization{
				CommitSHA: input.CandidateSHA, GraphID: item.GraphID, GraphRevision: graphRevision,
				PlanRevision: planRevision, PlanHash: planHash, By: actor, At: time.Now().UTC(), Attempt: item.Attempts})
		}
		if item.BranchPushed {
			item.Publishing = true
			return 0, ""
		}
		if item.GraphID == "" && item.Attempts >= maxAgentRunAttempts &&
			(item.Attempts != maxAgentRunAttempts || item.PullRequestURL == "" || item.Publication != publicationAwaitingAuthority || item.BranchPushed) {
			return http.StatusConflict, "the run has used all of its attempts"
		}
		if item.GraphID == "" {
			item.PullRequestEnabled = true
			item.requeue()
			item.PublishOnly = true
		}
		return 0, ""
	}
	var item agentRun
	var status int
	var message string
	if before.GraphID != "" && store.graphs != nil {
		store.graphs.mu.Lock()
		item, status, message = store.update(runID, update)
		store.graphs.mu.Unlock()
	} else {
		item, status, message = store.update(runID, update)
	}
	if status != 0 {
		http.Error(w, message, status)
		return
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status",
		Message: "A person authorized pull request creation for candidate " + input.CandidateSHA})
	if !item.BranchPushed {
		if store.graphs != nil {
			store.graphs.reconcileAll()
			if current, exists := store.get(runID); exists {
				item = current
			}
		}
		writeJSON(w, http.StatusAccepted, publicAgentRun(item))
		return
	}
	item, status, message = store.publishResult(r.Context(), runID, true, false)
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
	if item.GraphID != "" {
		// An integrated candidate is described from the WorkGraph that produced it.
		body = cmp.Or(store.graphs.pullRequestBody(item), body)
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
	pull, err := store.registry.github.createPullRequest(ctx, owner, repository, item.Branch, item.BaseBranch,
		item.CommitSHA, title, body)
	if err != nil {
		return gitHubPullRequest{}, err
	}
	if pull.Number < 1 || !strings.HasPrefix(pull.HTMLURL, "https://github.com/") || pull.Head.SHA != item.CommitSHA {
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
