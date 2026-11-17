package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestSystemUpdateStatusReadsPersistedManagerState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "update.json")
	want := updater.Status{RunningRevision: "0123456789abcdef0123456789abcdef01234567",
		LatestRevision: "abcdef0123456789abcdef0123456789abcdef01", State: "waiting_for_runs", ActiveRuns: 1}
	if err := updater.WriteStatus(path, want); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", path)
	response := httptest.NewRecorder()
	newMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/system/update", nil))
	var got updater.Status
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || response.Code != http.StatusOK || got != want {
		t.Fatalf("update status = %#v, decode error = %v, HTTP %d", got, err, response.Code)
	}
}

func TestSystemUpdateActionsRequireLocalSupervisor(t *testing.T) {
	t.Setenv("ZENCHRON_MANAGED_SUPERVISOR_PID", "")
	for _, test := range []struct {
		remote string
		want   int
	}{
		{remote: "198.51.100.7:1234", want: http.StatusForbidden},
		{remote: "127.0.0.1:1234", want: http.StatusServiceUnavailable},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/system/update/check", nil)
		request.RemoteAddr = test.remote
		if test.remote == "127.0.0.1:1234" {
			request.Host = "127.0.0.1:8080"
			request.Header.Set("Origin", "http://127.0.0.1:8080")
		}
		newMux().ServeHTTP(response, request)
		if response.Code != test.want {
			t.Fatalf("POST update from %s returned %d, want %d", test.remote, response.Code, test.want)
		}
	}
}

func TestManagedSupervisorCanQuiesceWithoutCreatingAnotherAdmissionPath(t *testing.T) {
	t.Setenv("ZENCHRON_MANAGED_SUPERVISOR_TOKEN", "local-supervisor-test-token")
	products := newProductStore()
	agents := newAgentProfileStore()
	registry := newWorkerRegistry()
	runs := newAgentRunStore(registry, agents)
	runs.items["running"] = agentRun{ID: "running", Status: "running"}
	handler := authHandler(newMuxWithStores(newObjectiveStore(products), newWorkflowStore(), agents, products, registry, runs),
		&authConfig{sessionKey: []byte("test-test-test-test-test-test-test-test")})
	call := func(method, path, token string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, nil)
		request.RemoteAddr = "127.0.0.1:1234"
		if token != "" {
			request.Header.Set("X-Zenchron-Supervisor-Token", token)
		}
		handler.ServeHTTP(response, request)
		return response
	}
	if response := call(http.MethodGet, "/api/v1/system/update/active-runs", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated supervisor request returned %d", response.Code)
	}
	if response := call(http.MethodPost, "/api/v1/system/update/quiesce", "local-supervisor-test-token"); response.Code != http.StatusNoContent {
		t.Fatalf("quiesce returned %d: %s", response.Code, response.Body.String())
	}
	if _, status, _ := runs.enqueue(agentRun{}); status != http.StatusServiceUnavailable {
		t.Fatalf("enqueue during release transition returned %d, want unavailable", status)
	}
	if response := call(http.MethodGet, "/api/v1/system/update/active-runs", "local-supervisor-test-token"); response.Code != http.StatusOK || response.Body.String() != "{\"active_runs\":1}\n" {
		t.Fatalf("active run observation returned %d: %s", response.Code, response.Body.String())
	}
	if runs.items["running"].Status != "running" {
		t.Fatal("quiescing changed the active agent run")
	}
	if response := call(http.MethodDelete, "/api/v1/system/update/quiesce", "local-supervisor-test-token"); response.Code != http.StatusNoContent {
		t.Fatalf("resume returned %d: %s", response.Code, response.Body.String())
	}
	if _, status, _ := runs.enqueue(agentRun{}); status != 0 {
		t.Fatalf("enqueue after release transition returned %d", status)
	}
}

func TestManagedWorkerCompatibilityRequiresMatchingLiveHeartbeat(t *testing.T) {
	t.Setenv("ZENCHRON_RELEASE_REVISION", "0123456789abcdef0123456789abcdef01234567")
	t.Setenv("ZENCHRON_MANAGED_SUPERVISOR_TOKEN", "local-supervisor-test-token")
	registry := newWorkerRegistry()
	registry.workers["matching"] = workerRecord{ID: "matching", LastSeen: time.Now(), ProtocolVersion: workerapi.ProtocolVersion,
		ReleaseRevision: os.Getenv("ZENCHRON_RELEASE_REVISION")}
	runs := newAgentRunStore(registry, newAgentProfileStore())
	products, agents := newProductStore(), newAgentProfileStore()
	handler := authHandler(newMuxWithStores(newObjectiveStore(products), newWorkflowStore(), agents, products, registry, runs), nil)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/update/worker-compatible", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Zenchron-Supervisor-Token", os.Getenv("ZENCHRON_MANAGED_SUPERVISOR_TOKEN"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"compatible\":true}\n" {
		t.Fatalf("matching worker compatibility = %d %s", response.Code, response.Body.String())
	}
	registry.mu.Lock()
	worker := registry.workers["matching"]
	worker.ProtocolVersion++
	registry.workers[worker.ID] = worker
	registry.mu.Unlock()
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "{\"compatible\":false}\n" {
		t.Fatalf("incompatible worker compatibility = %d %s", response.Code, response.Body.String())
	}
}
