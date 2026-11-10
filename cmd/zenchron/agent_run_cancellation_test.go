package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestAgentRunCancellationFencesWorkerAndKeepsPartialDiff(t *testing.T) {
	registry := newWorkerRegistry()
	agents := newAgentProfileStore()
	profile := agentProfile{
		ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Review", Provider: "custom", Model: "test",
		Status: "active", Version: 1, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"},
	}
	agents.items[profile.ID] = profile
	runs := newAgentRunStore(registry, agents)
	server := newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), agents,
		newProductStore(), registry, newWorktreeStore(registry), runs)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.ServeHTTP(response, httptest.NewRequest(method, path, strings.NewReader(body)))
		return response
	}
	heartbeat := `{"name":"worker","agent_runtime_enabled":true,"projects":[{"id":"` + testProjectID + `","name":"repo","branch":"main"}]}`
	if response := call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/heartbeat", heartbeat); response.Code != http.StatusOK {
		t.Fatalf("heartbeat returned HTTP %d", response.Code)
	}
	createRun := func(prompt string) agentRun {
		t.Helper()
		response := call(http.MethodPost, "/api/v1/agent-runs", `{"agent_id":"`+profile.ID+`","project_id":"`+testProjectID+`","prompt":"`+prompt+`"}`)
		var run agentRun
		if err := json.NewDecoder(response.Body).Decode(&run); err != nil || response.Code != http.StatusAccepted {
			t.Fatalf("create run = %#v, decode error = %v, HTTP %d", run, err, response.Code)
		}
		return run
	}
	queued := createRun("cancel before claim")
	response := call(http.MethodPost, "/api/v1/agent-runs/"+queued.ID+"/cancel", "")
	var cancelled agentRun
	if err := json.NewDecoder(response.Body).Decode(&cancelled); err != nil || response.Code != http.StatusAccepted ||
		cancelled.Status != "cancelled" || cancelled.Profile != nil {
		t.Fatalf("queued cancellation = %#v, decode error = %v, HTTP %d", cancelled, err, response.Code)
	}
	if response := call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", ""); response.Code != http.StatusNoContent {
		t.Fatalf("claim after queued cancellation returned HTTP %d", response.Code)
	}
	running := createRun("cancel during model call")
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	var command workerapi.AgentRunCommand
	if err := json.NewDecoder(response.Body).Decode(&command); err != nil || response.Code != http.StatusOK || command.ID != running.ID {
		t.Fatalf("claim running request = %#v, decode error = %v, HTTP %d", command, err, response.Code)
	}
	if response := call(http.MethodPost, "/api/v1/workers/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/agent-runs/"+running.ID+"/progress", `{"attempts":1}`); response.Code != http.StatusForbidden {
		t.Fatalf("other worker progress report returned HTTP %d", response.Code)
	}
	response = call(http.MethodPost, "/api/v1/agent-runs/"+running.ID+"/cancel", "")
	if response.Code != http.StatusAccepted {
		t.Fatalf("running cancellation returned HTTP %d: %s", response.Code, response.Body.String())
	}
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+running.ID+"/progress", `{"attempts":1}`)
	var status struct {
		CancelRequested bool `json:"cancel_requested"`
	}
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil || response.Code != http.StatusOK || !status.CancelRequested {
		t.Fatalf("worker cancellation status = %#v, decode error = %v, HTTP %d", status, err, response.Code)
	}
	response = call(http.MethodPut, "/api/v1/workers/"+testWorkerID+"/agent-runs/"+running.ID,
		`{"status":"succeeded","output":"late completion","attempts":1,"diff":"diff --git a/partial.md b/partial.md\n+partial result\n"}`)
	if err := json.NewDecoder(response.Body).Decode(&cancelled); err != nil || response.Code != http.StatusOK ||
		cancelled.Status != "cancelled" || cancelled.Output != "" || cancelled.CancelRequested || !cancelled.DiffAvailable {
		t.Fatalf("cancelled worker completion = %#v, decode error = %v, HTTP %d", cancelled, err, response.Code)
	}
	response = call(http.MethodGet, "/api/v1/agent-runs/"+running.ID+"/diff", "")
	var diff struct {
		Diff string `json:"diff"`
	}
	if err := json.NewDecoder(response.Body).Decode(&diff); err != nil || response.Code != http.StatusOK || !strings.Contains(diff.Diff, "partial result") {
		t.Fatalf("cancelled run diff = %q, decode error = %v, HTTP %d", diff.Diff, err, response.Code)
	}

	abandoned := createRun("cancel before worker disappears")
	response = call(http.MethodPost, "/api/v1/workers/"+testWorkerID+"/agent-runs/claim", "")
	if err := json.NewDecoder(response.Body).Decode(&command); err != nil || response.Code != http.StatusOK || command.ID != abandoned.ID {
		t.Fatalf("claim abandoned run = %#v, decode error = %v, HTTP %d", command, err, response.Code)
	}
	if response := call(http.MethodPost, "/api/v1/agent-runs/"+abandoned.ID+"/cancel", ""); response.Code != http.StatusAccepted {
		t.Fatalf("abandoned run cancellation returned HTTP %d", response.Code)
	}
	runs.mu.Lock()
	item := runs.items[abandoned.ID]
	item.LeaseUntil = time.Now().Add(-time.Second)
	runs.items[abandoned.ID] = item
	runs.mu.Unlock()
	response = call(http.MethodGet, "/api/v1/agent-runs", "")
	var listed []agentRun
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil || response.Code != http.StatusOK {
		t.Fatalf("list after worker loss decode error = %v, HTTP %d", err, response.Code)
	}
	for _, run := range listed {
		if run.ID == abandoned.ID {
			if run.Status != "cancelled" || run.CancelRequested {
				t.Fatalf("expired cancellation = %#v, want terminal cancelled state", run)
			}
			return
		}
	}
	t.Fatalf("expired cancelled run %s missing from history", abandoned.ID)
}
