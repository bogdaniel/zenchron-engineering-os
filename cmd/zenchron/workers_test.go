package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestWorkerHeartbeatAppearsInWorkerList(t *testing.T) {
	server := newMux()
	id := "0123456789abcdef0123456789abcdef"
	body := `{"name":"dev-machine","providers":[{"id":"codex-cli","version":"1.2.3","ready":true}],"projects":[{"id":"abcdef0123456789abcdef0123456789","name":"repo","branch":"feature/work","git_remote":"github.com/acme/repo"}]}`
	request := httptest.NewRequest(http.MethodPut, "/api/v1/workers/"+id+"/heartbeat", strings.NewReader(body))
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("heartbeat status = %d, want %d", response.Code, http.StatusOK)
	}

	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workers", nil))
	var workers []struct {
		ID        string                     `json:"id"`
		Name      string                     `json:"name"`
		Status    string                     `json:"status"`
		Providers []workerapi.ProviderStatus `json:"providers"`
	}
	if err := json.NewDecoder(response.Body).Decode(&workers); err != nil {
		t.Fatalf("decode workers: %v", err)
	}
	if response.Code != http.StatusOK || len(workers) != 1 || workers[0].ID != id ||
		workers[0].Name != "dev-machine" || workers[0].Status != "online" ||
		len(workers[0].Providers) != 1 || !workers[0].Providers[0].Ready || workers[0].Providers[0].Version != "1.2.3" {
		t.Fatalf("worker list = %#v (HTTP %d), want registered online dev-machine", workers, response.Code)
	}
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	var projects []struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Branch       string `json:"branch"`
		GitRemote    string `json:"git_remote"`
		WorkerStatus string `json:"worker_status"`
	}
	if err := json.NewDecoder(response.Body).Decode(&projects); err != nil {
		t.Fatalf("decode projects: %v", err)
	}
	if response.Code != http.StatusOK || len(projects) != 1 ||
		projects[0].ID != "abcdef0123456789abcdef0123456789" || projects[0].Name != "repo" ||
		projects[0].Branch != "feature/work" || projects[0].GitRemote != "github.com/acme/repo" ||
		projects[0].WorkerStatus != "online" {
		t.Fatalf("project list = %#v (HTTP %d)", projects, response.Code)
	}
}

func TestWorkerHeartbeatRejectsInvalidIdentityAndName(t *testing.T) {
	server := newMux()
	for _, testCase := range []struct {
		path string
		body string
	}{
		{path: "/api/v1/workers/not-hex/heartbeat", body: `{"name":"dev-machine"}`},
		{path: "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat", body: `{"name":" "}`},
		{path: "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat", body: `{"name":"dev","projects":[{"id":"abcdef0123456789abcdef0123456789","name":"repo","branch":"bad\nbranch"}]}`},
		{path: "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat", body: `{"name":"dev","projects":[{"id":"abcdef0123456789abcdef0123456789","name":"repo","branch":"main","git_remote":"https://user:secret@github.com/acme/repo.git"}]}`},
	} {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(http.MethodPut, testCase.path, strings.NewReader(testCase.body)))
		if response.Code != http.StatusBadRequest {
			t.Errorf("heartbeat %s returned HTTP %d, want %d", testCase.path, response.Code, http.StatusBadRequest)
		}
	}
}

func TestValidGitRemote(t *testing.T) {
	for _, value := range []struct {
		remote string
		valid  bool
	}{
		{remote: "github.com/acme/repo", valid: true},
		{remote: "git.internal.example:2222/platform/service", valid: true},
		{remote: "github.com/acme", valid: false},
		{remote: "https://github.com/acme/repo", valid: false},
		{remote: "github.com/acme/../repo", valid: false},
		{remote: "github.com/acme/repo?token=secret", valid: false},
	} {
		if got := validGitRemote(value.remote); got != value.valid {
			t.Errorf("validGitRemote(%q) = %t, want %t", value.remote, got, value.valid)
		}
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"127.0.0.1":   true,
		"::1":         true,
		"localhost":   true,
		"0.0.0.0":     false,
		"example.com": false,
	} {
		if got := isLoopbackHost(host); got != want {
			t.Errorf("isLoopbackHost(%q) = %t, want %t", host, got, want)
		}
	}
}

func TestWorkerReadinessRequiresRecentHeartbeat(t *testing.T) {
	server := newMux()
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workers/healthz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("empty worker readiness = HTTP %d, want %d", response.Code, http.StatusServiceUnavailable)
	}

	id := "0123456789abcdef0123456789abcdef"
	heartbeat := httptest.NewRequest(
		http.MethodPut, "/api/v1/workers/"+id+"/heartbeat", strings.NewReader(`{"name":"dev-machine"}`),
	)
	server.ServeHTTP(httptest.NewRecorder(), heartbeat)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/workers/healthz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("worker readiness = HTTP %d, want %d", response.Code, http.StatusOK)
	}
}
