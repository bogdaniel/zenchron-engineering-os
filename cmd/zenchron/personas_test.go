package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersonasPersistVersionsAndBindToProfiles(t *testing.T) {
	server := newMux()
	create := `{"name":"Security reviewer","role":"Review security-sensitive changes",` +
		`"responsibilities":["Check trust boundaries"],"instructions":"Inspect auth checks",` +
		`"behavior":"Cite concrete evidence","review_specialization":"Authorization","status":"active"}`
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/personas", strings.NewReader(create)))
	var persona agentPersona
	if err := json.NewDecoder(response.Body).Decode(&persona); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create persona = %#v, decode error = %v, HTTP %d", persona, err, response.Code)
	}
	if persona.ID == "" || persona.Version != 1 {
		t.Fatalf("created persona = %#v, want id and version 1", persona)
	}

	profileBody := `{"name":"Reviewer","provider":"codex-cli","model":"default",` +
		`"status":"active","system_prompt":"Keep reviewing","goal_prompt":"Find defects",` +
		`"tools":["git.read"],"persona_id":"` + persona.ID + `"}`
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(profileBody)))
	var profile agentProfile
	if err := json.NewDecoder(response.Body).Decode(&profile); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create linked profile = %#v, decode error = %v, HTTP %d", profile, err, response.Code)
	}
	if profile.PersonaID != persona.ID {
		t.Fatalf("profile persona_id = %q, want %q", profile.PersonaID, persona.ID)
	}

	update := strings.Replace(create, "Security reviewer", "Platform reviewer", 1)
	response = httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/personas/"+persona.ID, strings.NewReader(update))
	server.ServeHTTP(response, request)
	var revised agentPersona
	if err := json.NewDecoder(response.Body).Decode(&revised); err != nil || response.Code != http.StatusOK {
		t.Fatalf("update persona = %#v, decode error = %v, HTTP %d", revised, err, response.Code)
	}
	if revised.Version != 2 || revised.Name != "Platform reviewer" {
		t.Fatalf("revised persona = %#v, want version 2", revised)
	}

}

func TestAgentProfileRejectsMissingOrDisabledPersona(t *testing.T) {
	server := newMux()
	personaResponse := httptest.NewRecorder()
	server.ServeHTTP(personaResponse, httptest.NewRequest(http.MethodPost, "/api/v1/personas", strings.NewReader(
		`{"name":"Disabled","role":"Disabled role","status":"disabled"}`)))
	var disabled agentPersona
	if err := json.NewDecoder(personaResponse.Body).Decode(&disabled); err != nil || personaResponse.Code != http.StatusCreated {
		t.Fatalf("create disabled persona = %#v, error = %v, HTTP %d", disabled, err, personaResponse.Code)
	}
	for _, personaID := range []string{"missing-persona", disabled.ID, ""} {
		body := `{"name":"Reviewer","provider":"codex-cli","model":"default","status":"active",` +
			`"system_prompt":"","goal_prompt":"","tools":[],"persona_id":"` + personaID + `"}`
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(body)))
		want := http.StatusBadRequest
		if personaID == "" {
			want = http.StatusCreated
		}
		if response.Code != want {
			t.Errorf("profile with persona %q returned HTTP %d, want %d", personaID, response.Code, want)
		}
	}
}

func TestPersonaVersionIsPinnedInRunSnapshotAcrossEditAndRestart(t *testing.T) {
	dir := t.TempDir()
	server, err := newPersistentMux(dir)
	if err != nil {
		t.Fatal(err)
	}
	personaBody := `{"name":"Reviewer","role":"Find defects","instructions":"Check version one","status":"active"}`
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/personas", strings.NewReader(personaBody)))
	var persona agentPersona
	if err := json.NewDecoder(response.Body).Decode(&persona); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create persona: decode error %v, HTTP %d", err, response.Code)
	}
	profileBody := `{"name":"Reviewer","provider":"codex-cli","model":"default","status":"active",` +
		`"tools":["git.read"],"persona_id":"` + persona.ID + `"}`
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents", strings.NewReader(profileBody)))
	var profile agentProfile
	if err := json.NewDecoder(response.Body).Decode(&profile); err != nil || response.Code != http.StatusCreated {
		t.Fatalf("create linked profile: decode error %v, HTTP %d", err, response.Code)
	}
	server, err = newPersistentMux(dir)
	if err != nil {
		t.Fatalf("restart control plane: %v", err)
	}
	store, err := openAgentProfileStore(filepath.Join(dir, "agents.json"))
	if err != nil {
		t.Fatalf("reopen profiles: %v", err)
	}
	started := store.snapshot(store.items[profile.ID])
	if started.PersonaSnapshot == nil || started.PersonaSnapshot.Version != 1 {
		t.Fatalf("run persona snapshot after restart = %#v, want version 1", started.PersonaSnapshot)
	}
	updatedBody := strings.Replace(personaBody, "Check version one", "Check version two", 1)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/api/v1/personas/"+persona.ID, strings.NewReader(updatedBody)))
	if response.Code != http.StatusOK {
		t.Fatalf("update persona returned HTTP %d: %s", response.Code, response.Body.String())
	}
	reopened, err := openAgentProfileStore(filepath.Join(dir, "agents.json"))
	if err != nil {
		t.Fatalf("reopen updated persona: %v", err)
	}
	retried := started
	if retried.PersonaSnapshot.Version != 1 || retried.PersonaSnapshot.Instructions != "Check version one" {
		t.Fatalf("retry changed pinned persona snapshot: %#v", retried.PersonaSnapshot)
	}
	queued := reopened.snapshot(reopened.items[profile.ID])
	if queued.PersonaSnapshot.Version != 2 || queued.PersonaSnapshot.Instructions != "Check version two" {
		t.Fatalf("new run persona snapshot = %#v, want current version 2", queued.PersonaSnapshot)
	}
}
