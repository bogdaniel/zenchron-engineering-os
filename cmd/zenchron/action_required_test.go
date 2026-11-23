package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestActionRequiredProjectsCurrentPlanAndGraphDecisionsAcrossRestart(t *testing.T) {
	harness := newGraphHarness(t)
	plan, response := harness.propose(harness.twoProducerPlan())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("propose plan returned HTTP %d", response.StatusCode)
	}
	items := harness.actionRequired()
	if len(items) != 1 || items[0].Kind != actionPlanApproval || items[0].ObjectiveID != harness.objectiveID ||
		items[0].PlanRevision != plan.Revision || items[0].Subject != plan.Summary || items[0].Reason == "" {
		t.Fatalf("pending plan action = %#v", items)
	}
	request := withRequestAccess(httptest.NewRequest(http.MethodGet, "/api/v1/action-required", nil),
		requestAccess{enforced: true, user: "outsider"})
	responseRecorder := httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	var hidden []actionRequiredItem
	if responseRecorder.Code != http.StatusOK || json.Unmarshal(responseRecorder.Body.Bytes(), &hidden) != nil || len(hidden) != 0 {
		t.Fatalf("ungranted user action response = HTTP %d %s", responseRecorder.Code, responseRecorder.Body.String())
	}

	harness.restart()
	if items = harness.actionRequired(); len(items) != 1 || items[0].Kind != actionPlanApproval || items[0].PlanRevision != plan.Revision {
		t.Fatalf("plan action after restart = %#v", items)
	}
	graph, status := harness.approve(plan.Revision)
	if status != http.StatusCreated {
		t.Fatalf("approve plan returned HTTP %d", status)
	}
	if items = harness.actionRequired(); len(items) != 0 {
		t.Fatalf("approved plan remains pending: %#v", items)
	}

	api := harness.claimUnit("api")
	harness.report(api, workerapi.AgentRunResult{Output: "Need a decision.",
		Result: `{"decision_request":{"question":"Which export format should ship?","options":["JSON","CSV"]}}`})
	graph = harness.graph()
	decisionID := messagesOf(graph, messageDecisionRequest)[0].ID
	items = harness.actionRequired()
	if len(items) != 1 || items[0].Kind != actionDecision || items[0].ID != decisionID ||
		items[0].GraphID != graph.ID || items[0].UnitKey != "api" || items[0].PlanRevision != plan.Revision {
		t.Fatalf("pending graph decision = %#v", items)
	}
	harness.restart()
	if items = harness.actionRequired(); len(items) != 1 || items[0].ID != decisionID {
		t.Fatalf("graph decision after restart = %#v", items)
	}
}

func (harness *graphHarness) actionRequired() []actionRequiredItem {
	harness.t.Helper()
	response := harness.call(http.MethodGet, "/api/v1/action-required", "")
	var items []actionRequiredItem
	if response.Code != http.StatusOK {
		harness.t.Fatalf("action-required returned HTTP %d", response.Code)
	}
	if err := json.NewDecoder(response.Body).Decode(&items); err != nil {
		harness.t.Fatalf("decode action-required: %v", err)
	}
	return items
}
