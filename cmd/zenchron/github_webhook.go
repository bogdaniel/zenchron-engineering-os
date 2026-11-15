package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	gitHubWebhookPath       = "/api/v1/github/webhook"
	maxWebhookBody          = 2 << 20
	minWebhookSecretSize    = 16
	maxRememberedDeliveries = 5000
	maxRunChecks            = 50
	maxRunReviews           = 20
	maxObservationWord      = 40
	// A delivery with this outcome is not remembered: the run may publish the commit it names a moment
	// later, and GitHub or an operator can then deliver it again.
	deferredOutcome = "deferred: not for the run's current commit"
)

// runCheck is one check run GitHub reported for a run's published commit.
type runCheck struct {
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion,omitempty"`
	URL         string    `json:"url,omitempty"`
	CommitSHA   string    `json:"commit_sha"`
	CompletedAt time.Time `json:"completed_at"`
}

// runReview is one review GitHub reported for a run's pull request. Imported says that its text was
// handed to the run as feedback; Queued says that it started a follow-up attempt.
type runReview struct {
	ID          int64     `json:"id"`
	State       string    `json:"state"`
	Author      string    `json:"author"`
	CommitSHA   string    `json:"commit_sha"`
	SubmittedAt time.Time `json:"submitted_at"`
	Imported    bool      `json:"imported,omitempty"`
	Queued      bool      `json:"queued,omitempty"`
}

func validRunObservations(checks []runCheck, reviews []runReview) bool {
	if len(checks) > maxRunChecks || len(reviews) > maxRunReviews {
		return false
	}
	for _, check := range checks {
		if check.Name == "" || len(check.Name) > 200 || len(check.URL) > 2048 || !validCommitSHA(check.CommitSHA) ||
			len(check.Status) > maxObservationWord || len(check.Conclusion) > maxObservationWord {
			return false
		}
	}
	for _, review := range reviews {
		if review.ID < 1 || len(review.Author) > 100 || !validCommitSHA(review.CommitSHA) || len(review.State) > maxObservationWord {
			return false
		}
	}
	return true
}

// webhookDeliveries remembers which GitHub deliveries were handled, so a redelivery changes nothing.
// ponytail: the newest 5,000 delivery ids in one file; a replay older than that is still harmless,
// because reviews and checks are applied idempotently.
type webhookDeliveries struct {
	mu   sync.Mutex
	path string
	ids  []string
}

func openWebhookDeliveries(path string) (*webhookDeliveries, error) {
	deliveries := &webhookDeliveries{path: path}
	if path == "" {
		return deliveries, nil
	}
	var state struct {
		Version int      `json:"version"`
		IDs     []string `json:"ids"`
	}
	exists, err := loadStateFile(path, &state)
	if err != nil {
		return nil, fmt.Errorf("load webhook deliveries: %w", err)
	}
	if exists && (state.Version != stateFileVersion || len(state.IDs) > maxRememberedDeliveries) {
		return nil, fmt.Errorf("load webhook deliveries: unsupported or invalid state")
	}
	deliveries.ids = state.IDs
	return deliveries, nil
}

func (deliveries *webhookDeliveries) seen(id string) bool {
	deliveries.mu.Lock()
	defer deliveries.mu.Unlock()
	return slices.Contains(deliveries.ids, id)
}

func (deliveries *webhookDeliveries) remember(id string) error {
	deliveries.mu.Lock()
	defer deliveries.mu.Unlock()
	if slices.Contains(deliveries.ids, id) {
		return nil
	}
	previous := deliveries.ids
	deliveries.ids = append(slices.Clone(deliveries.ids), id)
	if len(deliveries.ids) > maxRememberedDeliveries {
		deliveries.ids = deliveries.ids[len(deliveries.ids)-maxRememberedDeliveries:]
	}
	if deliveries.path == "" {
		return nil
	}
	err := writeStateFile(deliveries.path, struct {
		Version int      `json:"version"`
		IDs     []string `json:"ids"`
	}{stateFileVersion, deliveries.ids})
	if err != nil {
		deliveries.ids = previous
	}
	return err
}

// loadWebhookSecret reads the secret shared with the GitHub webhook. Without it the endpoint does not exist.
func loadWebhookSecret() ([]byte, error) {
	secret := os.Getenv("ZENCHRON_GITHUB_WEBHOOK_SECRET")
	if secret == "" {
		return nil, nil
	}
	if len(secret) < minWebhookSecretSize {
		return nil, fmt.Errorf("ZENCHRON_GITHUB_WEBHOOK_SECRET must contain at least %d bytes", minWebhookSecretSize)
	}
	return []byte(secret), nil
}

func validWebhookSignature(secret, body []byte, header string) bool {
	signature, found := strings.CutPrefix(header, "sha256=")
	provided, err := hex.DecodeString(signature)
	if !found || err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}

// gitHubWebhookEvent holds the fields of the review and check-run events that the control plane uses.
type gitHubWebhookEvent struct {
	Action     string `json:"action"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	PullRequest struct {
		Number int `json:"number"`
		Head   struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
	} `json:"pull_request"`
	Review struct {
		gitHubReview
		CommitID string `json:"commit_id"`
	} `json:"review"`
	CheckRun struct {
		gitHubCheckRun
		HeadSHA      string    `json:"head_sha"`
		CompletedAt  time.Time `json:"completed_at"`
		PullRequests []struct {
			Number int `json:"number"`
		} `json:"pull_requests"`
	} `json:"check_run"`
}

// gitHubWebhook receives GitHub deliveries for pull-request reviews and check runs. A delivery is
// accepted only with a valid signature, is handled once, and changes a run only when it names that run's
// repository, pull request, branch, and exact published commit. Everything else is acknowledged and
// ignored, so GitHub does not retry and a forged or stale event cannot start work.
func (store *agentRunStore) gitHubWebhook(w http.ResponseWriter, r *http.Request) {
	if len(store.webhookSecret) == 0 {
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		http.Error(w, "webhook body is too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	if !validWebhookSignature(store.webhookSecret, body, r.Header.Get("X-Hub-Signature-256")) {
		http.Error(w, "webhook signature is invalid", http.StatusUnauthorized)
		return
	}
	delivery := r.Header.Get("X-GitHub-Delivery")
	if delivery == "" || len(delivery) > 100 || strings.ContainsAny(delivery, "\r\n") {
		http.Error(w, "webhook delivery id is invalid", http.StatusBadRequest)
		return
	}
	if store.deliveries.seen(delivery) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}
	var event gitHubWebhookEvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "webhook body is not valid JSON", http.StatusBadRequest)
		return
	}
	outcome, status := "ignored: event is not handled", 0
	switch r.Header.Get("X-GitHub-Event") {
	case "ping":
		outcome = "pong"
	case "pull_request_review":
		outcome, status = store.applyReviewEvent(accessFor(r), event)
	case "check_run":
		outcome, status = store.applyCheckRunEvent(event)
	}
	if status != 0 {
		// Not remembered: GitHub or an operator can deliver it again once the cause is fixed.
		http.Error(w, outcome, status)
		return
	}
	if outcome == deferredOutcome {
		writeJSON(w, http.StatusOK, map[string]string{"status": outcome})
		return
	}
	if err := store.deliveries.remember(delivery); err != nil {
		http.Error(w, "could not persist the webhook delivery", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": outcome})
}

func webhookRepository(event gitHubWebhookEvent) string {
	return "github.com/" + event.Repository.FullName
}

// applyReviewEvent records a submitted review on the run that published the pull request, and lets a
// change request from a repository owner, member, or collaborator queue a follow-up attempt.
func (store *agentRunStore) applyReviewEvent(access requestAccess, event gitHubWebhookEvent) (string, int) {
	review := event.Review
	if event.Action != "submitted" || review.ID < 1 {
		return "ignored: not a submitted review", 0
	}
	runID, found := store.findByPullRequest(webhookRepository(event), event.PullRequest.Number)
	if !found {
		return "ignored: no run published this pull request", 0
	}
	store.mu.Lock()
	item := store.items[runID]
	store.mu.Unlock()
	if event.PullRequest.Head.Ref != item.Branch || !validCommitSHA(review.CommitID) {
		return "ignored: the review is not for the run's branch", 0
	}
	if review.CommitID == "" || review.CommitID != item.CommitSHA {
		return deferredOutcome, 0
	}
	if !trustedGitHubAuthor(review.AuthorAssociation) {
		return "ignored: the reviewer is not an owner, member, or collaborator", 0
	}
	if slices.ContainsFunc(item.GitHubReviews, func(known runReview) bool { return known.ID == review.ID }) ||
		review.ID <= item.ImportedReviewID {
		return "ignored: the review is already recorded", 0
	}
	observation := runReview{ID: review.ID, State: truncateUTF8(strings.ToLower(review.State), maxObservationWord), Author: truncateUTF8(review.User.Login, 100),
		CommitSHA: review.CommitID, SubmittedAt: review.SubmittedAt}
	requestsChanges := observation.State == "changes_requested" && strings.TrimSpace(review.Body) != ""
	outcome := "recorded"
	// The follow-up runs under the authority of whoever started the run, checked against today's policy:
	// a creator who lost the repository or the worker can no longer have work queued in their name. Such a
	// request is not imported either, so an authorized user can still import and queue it with sync-reviews.
	creator := access.forUser(item.CreatedBy)
	switch {
	case !requestsChanges || !reviewableAgentRun(item):
	case !creator.allows(item.Repository) || !creator.mayDispatchTo(item.WorkerID):
		outcome = "recorded; the run's creator may no longer queue work, import it with sync-reviews"
	default:
		queued, status, message := store.importReview(creator, item, review.gitHubReview, true)
		if status == http.StatusConflict {
			// A full feedback history is a normal end state, not a failure GitHub should see.
			outcome = "recorded; " + message
			break
		}
		if status != 0 {
			return message, status
		}
		observation.Imported, observation.Queued = true, queued.Status == "queued"
		outcome = "feedback recorded"
		if observation.Queued {
			outcome = "follow-up attempt queued"
		}
	}
	_, status, message := store.update(runID, func(item *agentRun) (int, string) {
		item.GitHubReviews = append(slices.Clone(item.GitHubReviews), observation)
		if len(item.GitHubReviews) > maxRunReviews {
			item.GitHubReviews = item.GitHubReviews[len(item.GitHubReviews)-maxRunReviews:]
		}
		return 0, ""
	})
	if status != 0 {
		return message, status
	}
	store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "status",
		Message: fmt.Sprintf("GitHub review by %s: %s (%s)", observation.Author, observation.State, outcome)})
	return outcome, 0
}

// importReview hands one GitHub change request to a run as feedback and remembers that it was imported.
// With queue set it also starts a follow-up attempt when the run and the caller allow one.
func (store *agentRunStore) importReview(access requestAccess, item agentRun, review gitHubReview, queue bool) (agentRun, int, string) {
	comment := truncateUTF8(review.User.Login+" on GitHub: "+strings.TrimSpace(review.Body), maxAgentRunCommentSize)
	if _, status, message := store.recordReview(access, item.ID, "", comment, queue, false); status != 0 {
		return agentRun{}, status, message
	}
	return store.update(item.ID, func(item *agentRun) (int, string) {
		item.ImportedReviewID = max(item.ImportedReviewID, review.ID)
		return 0, ""
	})
}

// applyCheckRunEvent stores a completed check run on the run whose published commit it checked. A
// failed check is evidence shown with the run; it never starts work by itself.
func (store *agentRunStore) applyCheckRunEvent(event gitHubWebhookEvent) (string, int) {
	check := event.CheckRun
	if event.Action != "completed" || check.Name == "" || check.HeadSHA == "" {
		return "ignored: not a completed check run", 0
	}
	repository := webhookRepository(event)
	store.mu.Lock()
	runID := ""
	for id, item := range store.items {
		if item.Repository == repository && item.PullRequestNumber > 0 && item.CommitSHA == check.HeadSHA {
			runID = id
			break
		}
	}
	item := store.items[runID]
	store.mu.Unlock()
	if runID == "" {
		return deferredOutcome, 0
	}
	// GitHub lists the pull requests of a check run except for forks; when it does, it must name the run's.
	if len(check.PullRequests) > 0 && !slices.ContainsFunc(check.PullRequests, func(pull struct {
		Number int `json:"number"`
	}) bool {
		return pull.Number == item.PullRequestNumber
	}) {
		return "ignored: the check run belongs to another pull request", 0
	}
	observation := runCheck{Name: truncateUTF8(check.Name, 200), Status: truncateUTF8(check.Status, maxObservationWord),
		Conclusion: truncateUTF8(check.Conclusion, maxObservationWord),
		URL:        check.HTMLURL, CommitSHA: check.HeadSHA, CompletedAt: check.CompletedAt}
	if len(observation.URL) > 2048 || !strings.HasPrefix(observation.URL, "https://") {
		observation.URL = ""
	}
	outcome := "check recorded"
	_, status, message := store.update(runID, func(item *agentRun) (int, string) {
		// The commit may have moved on between the lookup and this update.
		if item.CommitSHA != check.HeadSHA {
			outcome = deferredOutcome
			return 0, ""
		}
		// Results for a commit the run has since replaced say nothing about its current candidate.
		checks := slices.DeleteFunc(slices.Clone(item.Checks), func(known runCheck) bool { return known.CommitSHA != item.CommitSHA })
		index := slices.IndexFunc(checks, func(known runCheck) bool { return known.Name == observation.Name })
		switch {
		case index >= 0 && !observation.CompletedAt.After(checks[index].CompletedAt):
			outcome = "ignored: a newer result of this check is already recorded"
			return 0, ""
		case index >= 0:
			checks[index] = observation
		case len(checks) >= maxRunChecks:
			outcome = "ignored: the run already holds the maximum number of checks"
			return 0, ""
		default:
			checks = append(checks, observation)
		}
		item.Checks = checks
		return 0, ""
	})
	if status != 0 {
		return message, status
	}
	if outcome == "check recorded" && observation.Conclusion != "success" && observation.Conclusion != "neutral" && observation.Conclusion != "skipped" {
		store.appendEvents(runID, item.Attempts, workerapi.AgentRunEvent{Kind: "error",
			Message: fmt.Sprintf("GitHub check %q finished with %s on %s", observation.Name, observation.Conclusion, observation.CommitSHA[:min(12, len(observation.CommitSHA))])})
	}
	return outcome, 0
}
