package main

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// A finish and a manual retry both publish a run. Either must own the process-local
// barrier exclusively until its GitHub request has completed.
func TestPublicationRequestsDoNotOverlapWithinSameAttempt(t *testing.T) {
	for _, mode := range []string{"finish", "manual retry"} {
		t.Run(mode, func(t *testing.T) {
			harness := newDeliveryHarness(t, workerapi.ProviderCodex)
			run := harness.createIssueRun()
			harness.claim()
			if _, status := harness.finish(run.ID, strings.Replace(pushedResult, `"branch_pushed":true`, `"branch_pushed":false`, 1)); status != http.StatusOK {
				t.Fatalf("finish before authorization returned HTTP %d", status)
			}
			if response := harness.authorizePublication(run.ID, testCommit); response.Code != http.StatusAccepted {
				t.Fatalf("authorize candidate: HTTP %d %s", response.Code, response.Body.String())
			}
			if command := harness.claim(); command.Attempts != 2 || !command.PublishPullRequest || command.PublishCommit != testCommit {
				t.Fatalf("authorized publication command = %#v", command)
			}
			if mode == "manual retry" {
				harness.failPullCreate = true
				if _, status := harness.finish(run.ID, strings.Replace(pushedResult, `"attempts":1`, `"attempts":2`, 1)); status != http.StatusOK {
					t.Fatalf("initial failed publication returned HTTP %d", status)
				}
				harness.failPullCreate = false
				current, exists := harness.store.get(run.ID)
				if !exists || current.Publication != publicationPullRequestFailed || current.Publishing {
					t.Fatalf("run is not ready for a manual publication retry: %#v", current)
				}
			}
			entered := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			releaseGitHub := func() { releaseOnce.Do(func() { close(release) }) }
			defer releaseGitHub()
			harness.duringPullCreate = func() {
				close(entered)
				<-release
			}
			firstStatus := make(chan int, 1)
			go func() {
				if mode == "finish" {
					_, status := harness.finish(run.ID, strings.Replace(pushedResult, `"attempts":1`, `"attempts":2`, 1))
					firstStatus <- status
					return
				}
				firstStatus <- harness.authorizePublication(run.ID, testCommit).Code
			}()
			select {
			case <-entered:
			case <-time.After(10 * time.Second):
				t.Fatal("first publication did not reach GitHub")
			}
			if current, exists := harness.store.get(run.ID); !exists || !current.Publishing {
				t.Fatalf("in-flight publication did not retain its update barrier: %#v", current)
			}
			duplicateStatus := make(chan int, 1)
			go func() {
				duplicateStatus <- harness.authorizePublication(run.ID, testCommit).Code
			}()
			select {
			case status := <-duplicateStatus:
				if status != http.StatusConflict {
					t.Errorf("overlapping publication returned HTTP %d, want 409", status)
				}
			case <-time.After(10 * time.Second):
				t.Error("overlapping publication waited for GitHub rather than rejecting the busy run")
			}
			if current, exists := harness.store.get(run.ID); !exists || !current.Publishing {
				t.Errorf("duplicate publication cleared the active update barrier: %#v", current)
			}
			releaseGitHub()
			select {
			case status := <-firstStatus:
				if status != http.StatusOK {
					t.Errorf("original publication returned HTTP %d, want 200", status)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("original publication failed to finish after GitHub was released")
			}
			current, exists := harness.store.get(run.ID)
			if !exists || current.Publishing || current.Publication != publicationPublished {
				t.Fatalf("completed publication state = %#v", current)
			}
		})
	}
}
