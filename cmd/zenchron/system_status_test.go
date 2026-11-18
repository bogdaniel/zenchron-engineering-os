package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

func TestLocalSystemStatusSummarizesRecordedWorkAndUpdate(t *testing.T) {
	revision := strings.Repeat("a", 40)
	t.Setenv("ZENCHRON_RELEASE_REVISION", revision)
	updateFile := filepath.Join(t.TempDir(), "update.json")
	if err := updater.WriteStatus(updateFile, updater.Status{State: "active", RunningRevision: revision,
		LatestRevision: revision, Progress: "Release is active"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", updateFile)
	registry := newWorkerRegistry()
	registry.workers["online"] = workerRecord{ID: "online", LastSeen: time.Now()}
	registry.workers["offline"] = workerRecord{ID: "offline", LastSeen: time.Now().Add(-time.Minute)}
	graphs := &workGraphStore{graphs: map[string]*workGraph{
		"graph": {ID: "graph", ObjectiveID: "objective", ObjectiveTitle: "Ship the dashboard",
			Status: graphBlocked, Units: []workUnit{
				{State: unitQueued}, {State: unitRunning}, {State: unitWaiting}, {State: unitFailed},
			}, Messages: []graphMessage{
				{ID: "open", Type: messageDecisionRequest},
				{ID: "resolved", Type: messageDecisionRequest},
				{Type: messageDecisionResolution, Resolves: "resolved"},
			}},
		"active-older": {ID: "active-older", ObjectiveID: "objective-old", ObjectiveTitle: "Older objective",
			Status: graphActive, UpdatedAt: time.Now().Add(-time.Minute)},
		"active-newer": {ID: "active-newer", ObjectiveID: "objective-new", ObjectiveTitle: "Current objective",
			Status: graphActive, UpdatedAt: time.Now()},
		"cancelled": {ID: "cancelled", ObjectiveID: "objective-cancelled", Status: graphCancelled,
			Messages: []graphMessage{{ID: "stale", Type: messageDecisionRequest}}},
	}}
	request := localStatusTestRequest(t)
	response := httptest.NewRecorder()
	writeLocalSystemStatus(response, request, registry, graphs)
	var status systemStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
		t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
	}
	if status.Workers.Online != 1 || status.Workers.Total != 2 || status.Work.ActiveGraphs != 2 ||
		status.Work.BlockedGraphs != 1 || status.Work.ActiveGraph == nil ||
		status.Work.ActiveGraph.GraphID != "active-newer" || status.Work.ActiveGraph.ObjectiveID != "objective-new" ||
		status.Work.ActiveGraph.ObjectiveTitle != "Current objective" ||
		len(status.Work.ActiveGraphLinks) != 2 || status.Work.ActiveGraphLinks[0].GraphID != "active-newer" ||
		len(status.Work.Decisions) != 1 || status.Work.Decisions[0].ID != "open" ||
		status.Work.Decisions[0].GraphID != "graph" || status.Work.Decisions[0].ObjectiveID != "objective" ||
		status.Work.QueuedUnits != 1 || status.Work.RunningUnits != 1 || status.Work.WaitingUnits != 1 ||
		status.Work.FailedUnits != 1 || status.Work.OpenDecisions != 1 || status.UpdateState != "active" ||
		status.UpdateRevision != revision || status.UpdateProgress != "Release is active" {
		t.Fatalf("system status = %#v", status)
	}
}

func TestLocalSystemStatusBoundsAndOrdersActionLinks(t *testing.T) {
	graphs := &workGraphStore{graphs: make(map[string]*workGraph)}
	for index := 0; index < 12; index++ {
		id := fmt.Sprintf("graph-%02d", index)
		graphs.graphs[id] = &workGraph{ID: id, ObjectiveID: "objective-" + id, Status: graphActive,
			UpdatedAt: time.Unix(int64(index), 0), Messages: []graphMessage{
				{ID: "decision-" + id, Type: messageDecisionRequest, From: "reviewer", CreatedAt: time.Unix(int64(index), 0)},
			}}
	}
	request := localStatusTestRequest(t)
	response := httptest.NewRecorder()
	writeLocalSystemStatus(response, request, newWorkerRegistry(), graphs)
	var status systemStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
		t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
	}
	wantGraphIDs := []string{"graph-11", "graph-10", "graph-09", "graph-08", "graph-07"}
	wantDecisionIDs := []string{"decision-graph-11", "decision-graph-10", "decision-graph-09", "decision-graph-08", "decision-graph-07"}
	if len(status.Work.ActiveGraphLinks) != len(wantGraphIDs) || len(status.Work.Decisions) != len(wantDecisionIDs) ||
		status.Work.ActiveGraphs != 12 || status.Work.OpenDecisions != 12 {
		t.Fatalf("bounded links = %#v, want newest %d of 12", status.Work, maxSystemStatusLinks)
	}
	for index := range wantGraphIDs {
		if status.Work.ActiveGraphLinks[index].GraphID != wantGraphIDs[index] || status.Work.Decisions[index].ID != wantDecisionIDs[index] {
			t.Fatalf("bounded link order at %d = %q, %q", index,
				status.Work.ActiveGraphLinks[index].GraphID, status.Work.Decisions[index].ID)
		}
	}
}

func TestLocalSystemStatusIncludesRecordedBlockedUpdateReason(t *testing.T) {
	tests := []struct {
		name   string
		update updater.Status
		reason string
	}{
		{name: "blocked reason", update: updater.Status{State: "blocked", BlockReason: "active runs must finish"},
			reason: "active runs must finish"},
		{name: "failed reason fallback", update: updater.Status{State: "failed", LastFailureReason: "release build failed"},
			reason: "release build failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			update := test.update
			update.LatestRevision = strings.Repeat("b", 40)
			updateFile := filepath.Join(t.TempDir(), "update.json")
			if err := updater.WriteStatus(updateFile, update); err != nil {
				t.Fatal(err)
			}
			t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", updateFile)
			request := localStatusTestRequest(t)
			response := httptest.NewRecorder()
			writeLocalSystemStatus(response, request, newWorkerRegistry(), newWorkGraphStore(nil, nil, nil, nil))
			var status systemStatus
			if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
				t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
			}
			if status.UpdateState != update.State || status.UpdateReason != test.reason ||
				status.UpdateRevision != update.LatestRevision {
				t.Fatalf("update status = %#v", status)
			}
		})
	}
}

func TestLocalSystemStatusReportsUnreadableConfiguredUpdaterStatus(t *testing.T) {
	t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", filepath.Join(t.TempDir(), "missing.json"))
	graphs := &workGraphStore{graphs: map[string]*workGraph{
		"active": {ID: "active", ObjectiveID: "objective", Status: graphActive},
	}}
	request := localStatusTestRequest(t)
	response := httptest.NewRecorder()
	writeLocalSystemStatus(response, request, newWorkerRegistry(), graphs)
	var status systemStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
		t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
	}
	if status.UpdateState != "unavailable" || status.UpdateReason != "Updater status is unavailable" || status.Work.ActiveGraphs != 1 {
		t.Fatalf("unreadable updater status = %#v", status)
	}
}

func TestLocalSystemStatusRejectsRemoteAndUncredentialedRequests(t *testing.T) {
	for name, request := range map[string]*http.Request{
		"remote": func() *http.Request {
			r := localStatusTestRequest(t)
			r.RemoteAddr = "192.0.2.1:4000"
			return r
		}(),
		"spoofed loopback host and origin without credential": func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
			r.RemoteAddr = "127.0.0.1:4000"
			r.Header.Set("Origin", "http://127.0.0.1:8080")
			return r
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeLocalSystemStatus(response, request, newWorkerRegistry(), newWorkGraphStore(nil, nil, nil, nil))
			want := http.StatusForbidden
			if name == "spoofed loopback host and origin without credential" {
				want = http.StatusUnauthorized
			}
			if response.Code != want {
				t.Fatalf("system status HTTP = %d, want %d", response.Code, want)
			}
		})
	}
}

func TestLocalSystemStatusOmitsActiveGraphWhenNoWorkIsActive(t *testing.T) {
	request := localStatusTestRequest(t)
	graphs := &workGraphStore{graphs: map[string]*workGraph{
		"blocked": {ID: "blocked", ObjectiveID: "objective", Status: graphBlocked},
	}}
	response := httptest.NewRecorder()
	writeLocalSystemStatus(response, request, newWorkerRegistry(), graphs)
	var status systemStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
		t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
	}
	if status.Work.ActiveGraphs != 0 || status.Work.ActiveGraph != nil {
		t.Fatalf("inactive work status = %#v, want no active graph", status.Work)
	}
}

func TestLocalSystemStatusRequiresSessionAndAdministratorWithAccessPolicy(t *testing.T) {
	config := testAuthConfig()
	server := authHandler(newMux(), config)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated local system status HTTP = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	accessPath := writeAccessFile(t,
		`{"admins":["admin"],"workers":[],"users":{"engineer":["github.com/acme/project"]}}`)
	config.access = &accessPolicy{path: accessPath}
	server = authHandler(newMux(), config)
	for _, test := range []struct {
		login string
		want  int
	}{{login: "engineer", want: http.StatusForbidden}, {login: "admin", want: http.StatusOK}} {
		t.Run(test.login, func(t *testing.T) {
			value, err := signSession(authUser{Login: test.login, ExpiresAt: time.Now().Add(time.Hour).Unix()}, config.sessionKey)
			if err != nil {
				t.Fatal(err)
			}
			request := localStatusTestRequest(t)
			request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: value})
			response := httptest.NewRecorder()
			server.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("system status for %s HTTP = %d, want %d", test.login, response.Code, test.want)
			}
		})
	}

	if err := os.Remove(accessPath); err != nil {
		t.Fatal(err)
	}
	value, err := signSession(authUser{Login: "admin", ExpiresAt: time.Now().Add(time.Hour).Unix()}, config.sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	request = localStatusTestRequest(t)
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: value})
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status with unreadable access policy HTTP = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func localStatusTestRequest(t *testing.T) *http.Request {
	t.Helper()
	token := "test-local-status-token"
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", token)
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("X-Zenchron-Local-Status-Token", token)
	return request
}
