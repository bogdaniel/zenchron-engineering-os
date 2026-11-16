package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestProductEnvironmentReferencesOnlyItsOwnObjectivesGraphsAndDecisions(t *testing.T) {
	harness := newGraphHarness(t)
	products := harness.store.graphs.objectives.products
	product := func(name string) string {
		t.Helper()
		// The objective store of the harness validates product ids against this product store.
		item := product{ID: commit(len(name))[:32], Name: name, RepositoryIDs: []string{testProjectID}}
		item.CreatedAt, item.UpdatedAt = harness.profile.UpdatedAt, harness.profile.UpdatedAt
		products.mu.Lock()
		products.items[item.ID] = item
		products.mu.Unlock()
		return item.ID
	}
	alpha, beta := product("alpha"), product("be")
	var created objective
	response := harness.call(http.MethodPost, "/api/v1/objectives", `{"title":"Alpha export","product_id":"`+alpha+`"}`)
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create objective: HTTP %d, %v", response.Code, err)
	}
	harness.objectiveID = created.ID
	graph := harness.start(harness.twoProducerPlan())
	api := harness.claimUnit("api")
	harness.report(api, workerapi.AgentRunResult{Output: "x", Result: `{"decision_request":{"question":"Which separator?"}}`})
	harness.handOff(harness.claimUnit("ui"), commit(2), "ui")

	environment := func(productID string) (productEnvironment, int) {
		var body productEnvironment
		response := harness.call(http.MethodGet, "/api/v1/products/"+productID+"/environment", "")
		_ = json.NewDecoder(response.Body).Decode(&body)
		return body, response.Code
	}
	own, status := environment(alpha)
	if status != http.StatusOK || own.Name != "alpha" || len(own.Objectives) != 1 || own.Objectives[0].ID != created.ID ||
		own.Objectives[0].GraphID != graph.ID || own.Objectives[0].PlanRevisions != 1 || own.Objectives[0].Handoffs != 1 ||
		len(own.Decisions) != 1 || own.Decisions[0].Unit != "api" || own.Decisions[0].ResolvedBy != "" {
		t.Fatalf("environment of the product = HTTP %d %#v", status, own)
	}
	harness.call(http.MethodPost, "/api/v1/work-graphs/"+graph.ID+"/decisions/"+own.Decisions[0].MessageID, `{"resolution":"Comma."}`)
	if own, _ = environment(alpha); own.Decisions[0].ResolvedBy != localOperator {
		t.Fatalf("resolved decision = %#v", own.Decisions)
	}
	// Another product shares the repository but none of the work.
	other, status := environment(beta)
	if status != http.StatusOK || len(other.Objectives) != 0 || len(other.Decisions) != 0 {
		t.Fatalf("environment of another product = HTTP %d %#v", status, other)
	}
	if _, status := environment(commit(7)[:32]); status != http.StatusNotFound {
		t.Fatalf("unknown product returned HTTP %d", status)
	}
}
