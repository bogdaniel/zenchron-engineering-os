package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestRequestChangesDoNotReplayThePreviouslyAuthorizedCandidate(t *testing.T) {
	harness := newDeliveryHarness(t, workerapi.ProviderCodex)
	run := harness.createIssueRun()
	harness.claim()
	withoutPush := strings.Replace(pushedResult, `"branch_pushed":true`, `"branch_pushed":false`, 1)
	if _, status := harness.finish(run.ID, withoutPush); status != http.StatusOK {
		t.Fatalf("candidate result returned HTTP %d", status)
	}
	if response := harness.authorizePublication(run.ID, testCommit); response.Code != http.StatusAccepted {
		t.Fatalf("authorize candidate returned HTTP %d", response.Code)
	}
	restarted, err := openAgentRunStore(harness.path, harness.store.registry, harness.store.agents)
	if err != nil {
		t.Fatalf("reopen authorized run: %v", err)
	}
	harness.store = restarted
	harness.server = newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), restarted.agents,
		newProductStore(), restarted.registry, restarted)
	if command := harness.claim(); !command.PublishOnly || command.PublishCommit != testCommit {
		t.Fatalf("authorized publication command = %#v", command)
	}
	if response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+run.ID+"/cancel", ""); response.Code != http.StatusConflict {
		t.Fatalf("cancellation during authorized publication returned HTTP %d, want %d", response.Code, http.StatusConflict)
	}
	if _, status := harness.finish(run.ID, strings.Replace(pushedResult, `"attempts":1`, `"attempts":2`, 1)); status != http.StatusOK {
		t.Fatalf("published candidate result returned HTTP %d", status)
	}
	response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+run.ID+"/request-changes", `{"comment":"Fix the review finding."}`)
	if response.Code != http.StatusOK {
		t.Fatalf("request changes returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if command := harness.claim(); command.PublishOnly || command.PublishPullRequest || command.PublishCommit != "" {
		t.Fatalf("review remediation was treated as publication: %#v", command)
	}
	newCandidate := strings.Repeat("c", 40)
	result := strings.Replace(pushedResult, `"attempts":1`, `"attempts":3`, 1)
	result = strings.Replace(result, testCommit, newCandidate, 1)
	result = strings.Replace(result, `"branch_pushed":true`, `"branch_pushed":false`, 1)
	awaiting, status := harness.finish(run.ID, result)
	if status != http.StatusOK || awaiting.Publication != publicationAwaitingAuthority ||
		awaiting.CommitSHA != newCandidate || awaiting.PullRequestURL != "https://github.com/acme/platform/pull/23" {
		t.Fatalf("updated candidate state = %#v, HTTP %d", awaiting, status)
	}
	if response := harness.authorizePublication(run.ID, newCandidate); response.Code != http.StatusAccepted {
		t.Fatalf("authorize updated candidate returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if command := harness.claim(); !command.PublishOnly || !command.PublishPullRequest || command.PublishCommit != newCandidate {
		t.Fatalf("updated candidate publication command = %#v", command)
	}
	result = strings.Replace(pushedResult, `"attempts":1`, `"attempts":4`, 1)
	result = strings.Replace(result, testCommit, newCandidate, 1)
	updated, status := harness.finish(run.ID, result)
	if status != http.StatusOK || updated.Publication != publicationPublished || updated.PullRequestURL != awaiting.PullRequestURL {
		t.Fatalf("updated existing pull request = %#v, HTTP %d", updated, status)
	}
	if harness.pullCreates != 1 {
		t.Fatalf("GitHub created %d pull requests while updating the existing one", harness.pullCreates)
	}
}
