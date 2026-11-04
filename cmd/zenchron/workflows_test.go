package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkflowCanBeReadAndSaved(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workflows", nil))
	var workflows []workflow
	if err := json.NewDecoder(response.Body).Decode(&workflows); err != nil {
		t.Fatalf("decode workflows: %v", err)
	}
	if response.Code != http.StatusOK || len(workflows) != 1 || len(workflows[0].Nodes) < 2 {
		t.Fatalf("workflow list = %#v (HTTP %d)", workflows, response.Code)
	}
	item := workflows[0]
	coverageBranch := false
	for _, edge := range item.Edges {
		coverageBranch = coverageBranch || edge.Source == "router" && edge.Target == "coverage"
	}
	coverageNode := false
	for _, node := range item.Nodes {
		coverageNode = coverageNode || node.ID == "coverage" && node.Type == "coverage-analyzer"
	}
	if !coverageNode || !coverageBranch {
		t.Fatalf("starter workflow missing coverage branch: nodes=%#v edges=%#v", item.Nodes, item.Edges)
	}
	item.Description = "Updated in the dashboard"
	body, err := json.Marshal(struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Status      string         `json:"status"`
		Nodes       []workflowNode `json:"nodes"`
		Edges       []workflowEdge `json:"edges"`
	}{item.Name, item.Description, item.Status, item.Nodes, item.Edges})
	if err != nil {
		t.Fatalf("encode workflow: %v", err)
	}
	response = httptest.NewRecorder()
	path := "/api/v1/workflows/" + item.ID
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, path, strings.NewReader(string(body))))
	var updated workflow
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated workflow: %v", err)
	}
	if response.Code != http.StatusOK || updated.Version != item.Version+1 || updated.Description != item.Description {
		t.Fatalf("updated workflow = %#v (HTTP %d)", updated, response.Code)
	}
}

func TestWorkflowCreateStartsWithValidGraph(t *testing.T) {
	server := newMux()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", strings.NewReader(
		`{"name":"Build and test","description":"Validate changes"}`,
	))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	var created workflow
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode created workflow: %v", err)
	}
	if response.Code != http.StatusCreated || created.ID == "" || !validateWorkflowGraph(created.Nodes, created.Edges) {
		t.Fatalf("created workflow = %#v (HTTP %d)", created, response.Code)
	}
}

func TestWorkflowRejectsBrokenGraphAndUnknownFields(t *testing.T) {
	server := newMux()
	for _, body := range []string{
		`{
      "name":"Broken","description":"","status":"draft",
      "nodes":[{"id":"trigger","type":"trigger","position":{"x":0,"y":0},"data":{"label":"Trigger","description":""}}],
      "edges":[{"id":"edge","source":"trigger","target":"missing","label":""}]
    }`,
		`{"name":"Broken","description":"","status":"draft","nodes":[],"edges":[],"extra":true}`,
	} {
		request := httptest.NewRequest(http.MethodPut, "/api/v1/workflows/pr-review-release", strings.NewReader(body))
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("workflow save returned HTTP %d for %s, want %d", response.Code, body, http.StatusBadRequest)
		}
	}
}
