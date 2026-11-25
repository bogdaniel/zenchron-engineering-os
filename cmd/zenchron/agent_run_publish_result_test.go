package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublishOnlyFailureWithoutCandidateSHAIsPersistedAndReplayIsIdempotent(t *testing.T) {
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
	command := harness.claim()
	failure, err := json.Marshal(workerapi.AgentRunResult{Status: "failed", Attempts: command.Attempts,
		Error: "Could not validate the run branch's GitHub remote.", TerminationReason: workerapi.TerminationWorkerError})
	if err != nil {
		t.Fatal(err)
	}
	finished, status := harness.finish(run.ID, string(failure))
	if status != http.StatusOK || finished.Status != "failed" || finished.Error == "" || finished.CommitSHA != testCommit {
		t.Fatalf("publish-only remote validation failure = %#v, HTTP %d", finished, status)
	}

	restarted, err := openAgentRunStore(harness.path, harness.store.registry, harness.store.agents)
	if err != nil {
		t.Fatalf("reopen run store: %v", err)
	}
	harness.store = restarted
	harness.server = newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), restarted.agents,
		newProductStore(), restarted.registry, restarted)
	replay := harness.call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+run.ID, string(failure))
	if replay.Code != http.StatusConflict || !strings.Contains(replay.Body.String(), workerapi.AgentRunResultAlreadyAccepted) {
		t.Fatalf("replayed failed publish-only result = HTTP %d: %s", replay.Code, replay.Body.String())
	}
	stored, exists := restarted.get(run.ID)
	if !exists || stored.Status != "failed" || stored.CommitSHA != testCommit || stored.Attempts != command.Attempts ||
		stored.AttemptLog[len(stored.AttemptLog)-1].Status != "failed" || harness.pullCreates != 0 {
		t.Fatalf("failed publish-only result or replay state = %#v, PR creates %d", stored, harness.pullCreates)
	}
}

func TestPublishOnlyResultReplayAfterRestartPreservesExecutionEvidence(t *testing.T) {
	harness := newDeliveryHarness(t, workerapi.ProviderCodex)
	run := harness.createIssueRun()
	harness.claim()
	first := strings.Replace(pushedResult, `"branch_pushed":true`, `"branch_pushed":false`, 1)
	first = strings.Replace(first, `"provider_version":"1.2.3"`, `"result":"{\"summary\":\"execution\"}","provider_version":"1.2.3"`, 1)
	if _, status := harness.finish(run.ID, first); status != http.StatusOK {
		t.Fatalf("execution result returned HTTP %d", status)
	}
	if response := harness.authorizePublication(run.ID, testCommit); response.Code != http.StatusAccepted {
		t.Fatalf("authorize candidate returned HTTP %d", response.Code)
	}
	command := harness.claim()
	publication := strings.Replace(pushedResult, `"attempts":1`, `"attempts":`+strconv.Itoa(command.Attempts), 1)
	finished, status := harness.finish(run.ID, publication)
	if status != http.StatusOK || finished.Publication != publicationPublished || finished.ResultAttempt != 1 {
		t.Fatalf("publish-only completion = %#v, HTTP %d", finished, status)
	}

	restarted, err := openAgentRunStore(harness.path, harness.store.registry, harness.store.agents)
	if err != nil {
		t.Fatalf("reopen run store: %v", err)
	}
	harness.store = restarted
	harness.server = newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), restarted.agents,
		newProductStore(), restarted.registry, restarted)
	replay := harness.call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+run.ID, publication)
	if replay.Code != http.StatusConflict || !strings.Contains(replay.Body.String(), workerapi.AgentRunResultAlreadyAccepted) {
		t.Fatalf("replayed successful publish-only result = HTTP %d: %s", replay.Code, replay.Body.String())
	}
	stale := strings.Replace(publication, `"attempts":`+strconv.Itoa(command.Attempts), `"attempts":`+strconv.Itoa(command.Attempts+1), 1)
	if response := harness.call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+run.ID, stale); response.Code != http.StatusConflict ||
		strings.Contains(response.Body.String(), workerapi.AgentRunResultAlreadyAccepted) {
		t.Fatalf("different attempt was acknowledged as duplicate: HTTP %d: %s", response.Code, response.Body.String())
	}
	stored, exists := restarted.get(run.ID)
	if !exists || stored.Status != "succeeded" || stored.Result != `{"summary":"execution"}` || stored.ResultAttempt != 1 ||
		stored.AttemptLog[len(stored.AttemptLog)-1].Attempt != command.Attempts || harness.pullCreates != 1 {
		t.Fatalf("successful publish-only replay changed durable evidence: %#v, PR creates %d", stored, harness.pullCreates)
	}
}
