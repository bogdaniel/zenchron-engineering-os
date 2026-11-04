package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentProfilesCreateAndUpdate(t *testing.T) {
	server := newMux()
	body := `{"name":"Code Reviewer","description":"Review diffs","provider":"custom","model":"review-v1",` +
		`"system_prompt":"Review safely","goal_prompt":"Find defects","tools":["git.read","code.write"]}`
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(body)))
	var created agentProfile
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create agent profile = %#v, decode error = %v, HTTP %d", created, err, response.Code)
	}
	if created.Status != "active" || created.Version != 1 || len(created.Tools) != 2 {
		t.Fatalf("created agent profile = %#v, want active version 1 with two tools", created)
	}
	update := agentProfileInput{
		Name: created.Name, Description: "Updated review profile", Provider: created.Provider,
		Model: created.Model, Status: "disabled", SystemPrompt: created.SystemPrompt,
		GoalPrompt: created.GoalPrompt, Tools: created.Tools,
	}
	bodyBytes, err := json.Marshal(update)
	if err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
		"/api/v1/agents/"+created.ID, strings.NewReader(string(bodyBytes))))
	var updated agentProfile
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil || response.Code != http.StatusOK {
		t.Fatalf("update agent profile = %#v, decode error = %v, HTTP %d", updated, err, response.Code)
	}
	if updated.Status != "disabled" || updated.Version != 2 || updated.Description != "Updated review profile" {
		t.Fatalf("updated agent profile = %#v, want disabled version 2", updated)
	}
}

func TestAgentProfilesRejectUnsupportedOrInvalidFields(t *testing.T) {
	server := newMux()
	for _, body := range []string{
		`{"name":"No model","provider":"custom"}`,
		`{"name":"Bad tool","provider":"custom","model":"v1","tools":["shell.exec"]}`,
		`{"name":"Duplicate tool","provider":"custom","model":"v1","tools":["git.read","git.read"]}`,
		`{"name":"Unexpected field","provider":"custom","model":"v1","unknown":true}`,
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Errorf("create with body %s returned HTTP %d, want %d", body, response.Code, http.StatusBadRequest)
		}
	}
}
