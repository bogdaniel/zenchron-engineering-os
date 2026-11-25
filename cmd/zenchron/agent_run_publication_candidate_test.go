package main

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPullRequestPublicationRejectsAnExistingPRForAnotherCandidate(t *testing.T) {
	harness := newDeliveryHarness(t, workerapi.ProviderCodex)
	run := harness.createIssueRun()
	harness.claim()
	awaiting, status := harness.finish(run.ID, strings.Replace(pushedResult, `"branch_pushed":true`, `"branch_pushed":false`, 1))
	if status != http.StatusOK || awaiting.Publication != publicationAwaitingAuthority {
		t.Fatalf("run before authorization = %#v, HTTP %d", awaiting, status)
	}
	if response := harness.authorizePublication(run.ID, testCommit); response.Code != http.StatusAccepted {
		t.Fatalf("authorize candidate: HTTP %d, %s", response.Code, response.Body.String())
	}
	command := harness.claim()
	harness.mu.Lock()
	harness.pulls = []string{fmt.Sprintf(`{"number":23,"state":"open","html_url":"https://github.com/acme/platform/pull/23","head":{"ref":%q,"sha":%q},"base":{"ref":%q}}`,
		command.Branch, strings.Repeat("c", 40), "main")}
	harness.mu.Unlock()
	published, status := harness.finish(run.ID, strings.Replace(pushedResult, `"attempts":1`, `"attempts":2`, 1))
	if status != http.StatusOK || published.Publication != publicationPullRequestFailed || published.PullRequestNumber != 0 ||
		published.PullRequestURL != "" || published.PullRequestError == "" || harness.pullCreates != 0 {
		t.Fatalf("mismatched candidate was recorded as published: %#v, HTTP %d, creates %d", published, status, harness.pullCreates)
	}
}
