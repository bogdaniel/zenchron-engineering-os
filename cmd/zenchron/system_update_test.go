package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	if strings.Contains(response.Body.String(), "authentication_method") || strings.Contains(response.Body.String(), "app_config_fingerprint") {
		t.Fatal("ordinary updater status exposed local authentication provenance")
	}
}

func TestLocalUpdaterStatusReportsRuntimeGitHubAuthentication(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", "local-status-test-token")
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "")
	path := filepath.Join(t.TempDir(), "update.json")
	if err := updater.WriteStatus(path, updater.Status{State: "idle"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", path)
	key := writeManagedAppTestKey(t, t.TempDir(), 0o600)
	t.Setenv("ZENCHRON_GITHUB_APP_ID", "123")
	t.Setenv("ZENCHRON_GITHUB_INSTALLATION_ID", "456")
	t.Setenv("ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", key)
	handler := authHandler(newMux(), &authConfig{sessionKey: []byte("test-test-test-test-test-test-test-test")})
	call := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/system/update", nil)
		request.RemoteAddr, request.Host = "127.0.0.1:1234", "127.0.0.1:8080"
		request.Header.Set(localStatusCredentialHeader, "local-status-test-token")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	response := call()
	var appStatus map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &appStatus); err != nil || response.Code != http.StatusOK {
		t.Fatalf("local updater status response = %d %s, decode error %v", response.Code, response.Body.String(), err)
	}
	fingerprint, fingerprintIsString := appStatus["app_config_fingerprint"].(string)
	if appStatus["authentication_method"] != gitHubAuthMethodApp || !fingerprintIsString || fingerprint == "" {
		t.Fatal("local updater response omitted its GitHub App authentication fingerprint")
	}

	t.Setenv("ZENCHRON_GITHUB_TOKEN", "personal-token-test")
	response = call()
	appStatus = nil
	if err := json.Unmarshal(response.Body.Bytes(), &appStatus); err != nil || response.Code != http.StatusOK {
		t.Fatalf("PAT updater status response = %d %s, decode error %v", response.Code, response.Body.String(), err)
	}
	if appStatus["authentication_method"] != gitHubAuthMethodPersonalToken || appStatus["app_config_fingerprint"] != nil {
		t.Fatalf("PAT precedence evidence = %#v", appStatus)
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
	runs.items["running"] = agentRun{ID: "running", Status: "running", LeaseUntil: time.Now().Add(time.Minute)}
	handler := authHandler(newMuxWithStores(newObjectiveStore(products), newWorkflowStore(), agents, products, registry, runs),
		&authConfig{sessionKey: []byte("test-test-test-test-test-test-test-test")})
	call := func(method, path, token string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, nil)
		request.RemoteAddr = "127.0.0.1:1234"
		request.Host = "127.0.0.1:8080"
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
	request.Host = "127.0.0.1:8080"
	request.RemoteAddr = "127.0.0.1:1234"
	request.Host = "127.0.0.1:8080"
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

func TestSystemUpdateRunControlsRequireSupervisorTokenAndRecoverLeases(t *testing.T) {
	t.Setenv("ZENCHRON_MANAGED_SUPERVISOR_TOKEN", "supervisor-secret")
	registry, agents := newWorkerRegistry(), newAgentProfileStore()
	runs := newAgentRunStore(registry, agents)
	runs.path = filepath.Join(t.TempDir(), "agent-runs.json")
	expiredID, publishingID := "0123456789abcdef0123456789abcdef", "abcdef0123456789abcdef0123456789"
	runs.items[expiredID] = agentRun{ID: expiredID, Status: "running", LeaseUntil: time.Now().Add(-time.Second)}
	runs.items[publishingID] = agentRun{ID: publishingID, Status: "succeeded", Publishing: true}
	products := newProductStore()
	handler := authHandler(newMuxWithStores(newObjectiveStore(products), newWorkflowStore(), agents, products, registry, runs), nil)
	call := func(method, path, token string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, path, nil)
		request.Host = "127.0.0.1:8080"
		request.RemoteAddr = "127.0.0.1:1234"
		request.Host = "127.0.0.1:8080"
		if token != "" {
			request.Header.Set("X-Zenchron-Supervisor-Token", token)
		}
		handler.ServeHTTP(response, request)
		return response
	}
	if response := call(http.MethodPost, "/api/v1/system/update/quiesce", ""); response.Code != http.StatusForbidden {
		t.Fatalf("unauthorized process changed run admission: HTTP %d", response.Code)
	}
	if response := call(http.MethodGet, "/api/v1/system/update/active-runs", ""); response.Code != http.StatusForbidden {
		t.Fatalf("unauthorized process read internal run state: HTTP %d", response.Code)
	}
	response := call(http.MethodGet, "/api/v1/system/update/active-runs", "supervisor-secret")
	if response.Code != http.StatusOK || response.Body.String() != "{\"active_runs\":1}\n" {
		t.Fatalf("active-run count = HTTP %d %s", response.Code, response.Body.String())
	}
	if runs.items[expiredID].Status != "queued" {
		t.Fatalf("expired lease state = %q, want queued", runs.items[expiredID].Status)
	}
	var persisted struct {
		Items map[string]agentRun `json:"items"`
	}
	data, err := os.ReadFile(runs.path)
	if err != nil || json.Unmarshal(data, &persisted) != nil || persisted.Items[expiredID].Status != "queued" {
		t.Fatalf("recovered lease was not persisted: %s, %v", data, err)
	}
}
