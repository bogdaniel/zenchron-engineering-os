package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestWorkGraphPinsTheFirstVerifiedBaseForLaterRootRuns(t *testing.T) {
	harness := newGraphHarness(t)
	started := harness.start(harness.reviewedPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.handOff(api, commit(1), "api")
	if graph := harness.graph(); graph.BaseCommit != commit(9) {
		t.Fatalf("graph base after the first root run = %q, want %q", graph.BaseCommit, commit(9))
	}
	harness.handOff(ui, commit(2), "ui")
	harness.verdict(harness.claimUnit("review-api"), commit(1), `{"review":{"verdict":"accept"}}`)

	integration := harness.claimUnit("integrate")
	if integration.StartCommit != commit(9) {
		t.Fatalf("integration command start commit = %q, want the pinned base %q", integration.StartCommit, commit(9))
	}
	merged, _ := json.Marshal(map[string]any{"integration": workerapi.MergeResult{Merged: integration.Merge}})
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9),
		Verification: workerapi.VerificationPassed, Result: string(merged)})
	if graph := harness.graph(); graph.ID != started.ID || graph.BaseCommit != commit(9) {
		t.Fatalf("graph base changed after integration: %q", graph.BaseCommit)
	}
}

func TestStoredWorkGraphRejectsAMalformedBaseCommit(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.reviewedPlan())
	graph := harness.graph()
	if !validStoredWorkGraph(graph) {
		t.Fatal("a fresh graph is invalid")
	}
	graph.BaseCommit = "not-a-commit"
	if validStoredWorkGraph(graph) {
		t.Fatal("a graph with a malformed base commit was accepted")
	}
}

func TestWorkGraphFailsARootRunFromAnotherBase(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.reviewedPlan())
	api, ui := harness.claimUnit("api"), harness.claimUnit("ui")
	harness.handOff(api, commit(1), "api")
	diff := "diff --git a/ui.go b/ui.go\n+++ b/ui.go\n+change\n"
	// origin advanced between the two parallel root runs, so ui verified and started from a newer base.
	harness.report(ui, workerapi.AgentRunResult{CommitSHA: commit(2), BaseCommit: commit(8), Diff: &diff,
		Output: "Done.", Verification: workerapi.VerificationPassed, Result: `{"handoff":{"summary":"ui"}}`})
	graph := harness.graph()
	if unit := graph.unit("ui"); unit.State != unitFailed || !strings.Contains(unit.Reason, "pinned to "+shortCommit(commit(9))) {
		t.Fatalf("ui unit from another base = %s / %q, want failed against the pinned base", unit.State, unit.Reason)
	}
	// The retry must not continue the rejected branch: it starts over from the pinned base.
	if response := harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/units/ui/retry", ""); response.Code != http.StatusOK {
		t.Fatalf("retry returned HTTP %d: %s", response.Code, response.Body.String())
	}
	harness.claimUnit("review-api")
	retry := harness.claimUnit("ui")
	if retry.BaseBranch != graph.BaseBranch || retry.StartCommit != commit(9) || retry.BaseBranch == ui.Branch {
		t.Fatalf("retry after a base rejection = base %q start %q, want %q at the pinned %q",
			retry.BaseBranch, retry.StartCommit, graph.BaseBranch, commit(9))
	}
}
