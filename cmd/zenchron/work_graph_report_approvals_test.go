package main

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestRequiredApprovalsCompleteBeforePublicationFinishes(t *testing.T) {
	harness := newGraphHarness(t)
	started := harness.start(harness.reviewedPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.handOff(api, commit(1), "api")
	harness.handOff(ui, commit(2), "ui")
	harness.verdict(harness.claimUnit("review-api"), commit(1), `{"review":{"verdict":"accept"}}`)
	integration := harness.claimUnit("integrate")
	merged, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{Merged: integration.Merge}})
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9),
		Verification: workerapi.VerificationPassed, Result: string(merged)})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)

	if report, body := harness.deliveryReport(started.ID); report.Measurements.RequiredApprovalsComplete {
		t.Fatalf("approvals are complete before the candidate was authorized: %s", body)
	}
	harness.authorizePublication(integration.ID, commit(4))
	// Publication has not run yet; the approvals are nevertheless all recorded.
	report, body := harness.deliveryReport(started.ID)
	if !report.Measurements.RequiredApprovalsComplete || report.Status == graphCompleted || report.PullRequestURL != "" ||
		report.PublicationAuthority == nil || report.PublicationAuthority.CommitSHA != commit(4) {
		t.Fatalf("authorized but unpublished candidate: %s", body)
	}

	// A publish-only requeue makes the integrate run active, temporarily unsettling its dependent reviewer.
	// The historical exact-candidate authorization remains durable and must remain visible in the report.
	harness.claimUnit("integrate")
	publishing, publishingBody := harness.deliveryReport(started.ID)
	if !publishing.Measurements.RequiredApprovalsComplete || publishing.PublicationAuthority == nil ||
		publishing.PublicationAuthority.CommitSHA != commit(4) ||
		slices.Contains(publishing.UnknownEvidence, "publication_authority") {
		t.Fatalf("publishing candidate lost its recorded authorization: %s", publishingBody)
	}
}

func TestEveryDecisionResolvedMatchesByRequestID(t *testing.T) {
	request := graphMessage{ID: "g-1", Type: messageDecisionRequest}
	for _, test := range []struct {
		name     string
		messages []graphMessage
		want     bool
	}{
		{"none requested", nil, true},
		{"resolved", []graphMessage{request, {ID: "g-2", Type: messageDecisionResolution, Resolves: "g-1"}}, true},
		{"orphan resolution with equal counts", []graphMessage{request,
			{ID: "g-2", Type: messageDecisionResolution, Resolves: "g-9"}}, false},
		{"unresolved", []graphMessage{request}, false},
	} {
		if got := everyDecisionResolved(test.messages); got != test.want {
			t.Errorf("%s: everyDecisionResolved = %t, want %t", test.name, got, test.want)
		}
	}
}
