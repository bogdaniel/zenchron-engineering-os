package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	}}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
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
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response := httptest.NewRecorder()
	writeLocalSystemStatus(response, request, newWorkerRegistry(), graphs)
	var status systemStatus
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK {
		t.Fatalf("system status response: decode error %v, HTTP %d", err, response.Code)
	}
	if len(status.Work.ActiveGraphLinks) != maxSystemStatusLinks ||
		status.Work.ActiveGraphLinks[0].GraphID != "graph-11" ||
		len(status.Work.Decisions) != maxSystemStatusLinks || status.Work.Decisions[0].ID != "decision-graph-11" ||
		status.Work.ActiveGraphs != 12 || status.Work.OpenDecisions != 12 {
		t.Fatalf("bounded links = %#v, want newest %d of 12", status.Work, maxSystemStatusLinks)
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
			request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
			request.RemoteAddr = "127.0.0.1:4000"
			request.Header.Set("Origin", "http://127.0.0.1:8080")
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

func TestLocalSystemStatusRejectsRemoteAndCrossOriginRequests(t *testing.T) {
	for name, request := range map[string]*http.Request{
		"remote": func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
			r.RemoteAddr = "192.0.2.1:4000"
			r.Header.Set("Origin", "http://127.0.0.1:8080")
			return r
		}(),
		"cross origin": func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
			r.RemoteAddr = "127.0.0.1:4000"
			r.Header.Set("Origin", "https://example.com")
			return r
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			writeLocalSystemStatus(response, request, newWorkerRegistry(), newWorkGraphStore(nil, nil, nil, nil))
			if response.Code != http.StatusForbidden {
				t.Fatalf("system status HTTP = %d, want %d", response.Code, http.StatusForbidden)
			}
		})
	}
}

func TestLocalSystemStatusOmitsActiveGraphWhenNoWorkIsActive(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
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

func TestLocalSystemStatusPassesAuthOnlyForSameOriginLoopbackRead(t *testing.T) {
	server := authHandler(newMux(), testAuthConfig())
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("local system status HTTP = %d, want %d", response.Code, http.StatusOK)
	}

	request = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/status", nil)
	request.RemoteAddr = "192.0.2.1:4000"
	request.Header.Set("Origin", "http://127.0.0.1:8080")
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("remote system status HTTP = %d, want session auth %d", response.Code, http.StatusUnauthorized)
	}
}
