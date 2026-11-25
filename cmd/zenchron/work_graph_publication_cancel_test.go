package main

import (
	"net/http"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestGraphCancellationIsRejectedDuringAuthorizedPublishPass(t *testing.T) {
	harness := newGraphHarness(t)
	graph := harness.start(harness.planBody(
		unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("integrate", unitIntegrate, "", "api"),
		unitJSON("review", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9),
		Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("review"), commit(4), `{"review":{"verdict":"accept"}}`)
	harness.authorizePublication(integration.ID, commit(4))
	publication := harness.claimUnit("integrate")
	if !publication.PublishOnly || publication.PublishCommit != commit(4) {
		t.Fatalf("authorized publication command = %#v", publication)
	}

	response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/cancel", "")
	if response.Code != http.StatusConflict {
		t.Fatalf("cancellation during authorized publish pass returned HTTP %d, want %d", response.Code, http.StatusConflict)
	}
	if current := harness.graph(); current.Status == graphCancelled {
		t.Fatalf("graph was cancelled during its authorized publish pass: %#v", current)
	}
}
