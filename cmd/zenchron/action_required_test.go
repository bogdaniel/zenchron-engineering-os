package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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

func TestActionRequiredMarksWorkerAuthorizationFromCurrentAccess(t *testing.T) {
	harness := newGraphHarness(t)
	plan, response := harness.propose(harness.twoProducerPlan())
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("propose plan returned HTTP %d", response.StatusCode)
	}
	access := requestAccess{enforced: true, user: "reviewer", admin: true, policy: &accessFile{
		Workers: []workerGrant{{ID: testWorkerID, Owner: "worker-owner"}},
	}}
	responseRecorder := httptest.NewRecorder()
	request := withRequestAccess(httptest.NewRequest(http.MethodGet, "/api/v1/action-required", nil), access)
	harness.server.ServeHTTP(responseRecorder, request)
	var actions []actionRequiredItem
	if responseRecorder.Code != http.StatusOK || json.Unmarshal(responseRecorder.Body.Bytes(), &actions) != nil ||
		len(actions) != 1 || actions[0].Kind != actionPlanApproval || actions[0].CanAct || actions[0].ActionBlocker == "" {
		t.Fatalf("unauthorized plan action = HTTP %d %s, %#v", responseRecorder.Code, responseRecorder.Body.String(), actions)
	}
	request = withRequestAccess(httptest.NewRequest(http.MethodPost,
		"/api/v1/objectives/"+harness.objectiveID+"/plans/"+strconv.Itoa(plan.Revision)+"/approve", nil), access)
	responseRecorder = httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	if responseRecorder.Code != http.StatusConflict {
		t.Fatalf("unauthorized plan approval returned HTTP %d, want conflict", responseRecorder.Code)
	}
	graph, status := harness.approve(plan.Revision)
	if status != http.StatusCreated {
		t.Fatalf("approve plan returned HTTP %d", status)
	}
	producer := harness.claimUnit("api")
	harness.report(producer, workerapi.AgentRunResult{Output: "Need a decision.",
		Result: `{"decision_request":{"question":"Which export format should ship?","options":["JSON","CSV"]}}`})
	graph = harness.graph()
	decisionID := messagesOf(graph, messageDecisionRequest)[0].ID
	responseRecorder = httptest.NewRecorder()
	request = withRequestAccess(httptest.NewRequest(http.MethodGet, "/api/v1/action-required", nil), access)
	harness.server.ServeHTTP(responseRecorder, request)
	if responseRecorder.Code != http.StatusOK || json.Unmarshal(responseRecorder.Body.Bytes(), &actions) != nil ||
		len(actions) != 1 || actions[0].ID != decisionID || actions[0].CanAct || actions[0].ActionBlocker == "" {
		t.Fatalf("unauthorized decision action = HTTP %d %s, %#v", responseRecorder.Code, responseRecorder.Body.String(), actions)
	}
	request = withRequestAccess(jsonRequest(http.MethodPost,
		"/api/v1/work-graphs/"+graph.ID+"/decisions/"+decisionID, strings.NewReader(`{"resolution":"Use JSON."}`)), access)
	responseRecorder = httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	if responseRecorder.Code != http.StatusForbidden {
		t.Fatalf("unauthorized decision resolution returned HTTP %d, want forbidden", responseRecorder.Code)
	}
}

func TestActionRequiredRechecksCurrentRepositoryAuthorization(t *testing.T) {
	harness := newGraphHarness(t)
	access := requestAccess{enforced: true, user: "reviewer", repositories: []string{"github.com/acme/platform"},
		policy: &accessFile{Users: map[string][]string{"reviewer": {"github.com/acme/platform"}},
			Workers: []workerGrant{{ID: testWorkerID, Owner: "reviewer"}}}}
	request := withRequestAccess(jsonRequest(http.MethodPost, "/api/v1/objectives",
		strings.NewReader(`{"title":"Review the current repository grant"}`)), access)
	responseRecorder := httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	var item objective
	if responseRecorder.Code != http.StatusCreated || json.Unmarshal(responseRecorder.Body.Bytes(), &item) != nil {
		t.Fatalf("create objective returned HTTP %d: %s", responseRecorder.Code, responseRecorder.Body.String())
	}
	harness.objectiveID = item.ID
	request = withRequestAccess(jsonRequest(http.MethodPost, "/api/v1/objectives/"+item.ID+"/plans",
		strings.NewReader(harness.twoProducerPlan())), access)
	responseRecorder = httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	var plan objectivePlan
	if responseRecorder.Code != http.StatusCreated || json.Unmarshal(responseRecorder.Body.Bytes(), &plan) != nil {
		t.Fatalf("propose plan returned HTTP %d: %s", responseRecorder.Code, responseRecorder.Body.String())
	}

	registry := harness.store.registry
	registry.mu.Lock()
	project := registry.projects[testWorkerID+":"+testProjectID]
	project.GitRemote = "github.com/acme/renamed"
	registry.projects[testWorkerID+":"+testProjectID] = project
	registry.mu.Unlock()

	request = withRequestAccess(httptest.NewRequest(http.MethodGet, "/api/v1/action-required", nil), access)
	responseRecorder = httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	var actions []actionRequiredItem
	if responseRecorder.Code != http.StatusOK || json.Unmarshal(responseRecorder.Body.Bytes(), &actions) != nil ||
		len(actions) != 1 || actions[0].ID != "plan:"+harness.objectiveID+":"+strconv.Itoa(plan.Revision) ||
		actions[0].CanAct || actions[0].ActionBlocker != "Your current access does not include the plan's current repository." {
		t.Fatalf("stale repository authorization = HTTP %d %s, %#v", responseRecorder.Code, responseRecorder.Body.String(), actions)
	}
	request = withRequestAccess(httptest.NewRequest(http.MethodPost,
		"/api/v1/objectives/"+harness.objectiveID+"/plans/"+strconv.Itoa(plan.Revision)+"/approve", nil), access)
	responseRecorder = httptest.NewRecorder()
	harness.server.ServeHTTP(responseRecorder, request)
	if responseRecorder.Code != http.StatusConflict {
		t.Fatalf("stale repository authorization approval returned HTTP %d, want conflict", responseRecorder.Code)
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
