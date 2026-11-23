package main

import (
	"net/http"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublicationAuthorizationStopsAfterAProducerHandsOffAgain(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api"),
		unitJSON("review-all", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	harness.verdict(harness.claimUnit("review-api"), commit(1), `{"review":{"verdict":"accept"}}`)
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9),
		Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)
	authorized := harness.authorizePublication(integration.ID, commit(4))

	harness.store.graphs.mu.Lock()
	graph := harness.store.graphs.graphs[authorized.GraphID]
	graph.unit("api").HandoffAt = graph.unit("integrate").Seen + 1
	harness.store.graphs.mu.Unlock()
	if candidate := harness.store.graphs.publishCommit(authorized); candidate != "" {
		t.Fatalf("stale publication authorization supplied candidate %s", candidate)
	}
	response := harness.call(http.MethodPost, "/api/v1/agent-runs/"+integration.ID+"/publish",
		`{"candidate_sha":"`+commit(4)+`"}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("stale candidate authorization returned HTTP %d: %s", response.Code, response.Body.String())
	}
}
