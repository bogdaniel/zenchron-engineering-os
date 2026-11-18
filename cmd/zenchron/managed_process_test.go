package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagedWorkerReceivesOnlyExecutionCredentials(t *testing.T) {
	base := []string{
		"PATH=/usr/bin", "ZENCHRON_WORKER_TOKEN=worker-token", "ZENCHRON_GITHUB_TOKEN=github-token",
		"ZENCHRON_GITHUB_WEBHOOK_SECRET=webhook-secret", "ZENCHRON_SESSION_SECRET=session-secret",
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH=/private/app.pem", "ZENCHRON_ACCESS_FILE=/private/access.json",
		"ZENCHRON_DATA_DIR=/private/state", "ZENCHRON_UPDATE_REPOSITORY=owner/repo",
		"ZENCHRON_LOCAL_STATUS_TOKEN=menu-status-token",
	}
	original := append([]string(nil), base...)
	api := withEnvironment(base, map[string]string{"ZENCHRON_DATA_DIR": "/private/state"})
	got := strings.Join(managedWorkerEnvironment(base, "/projects", "0123456789abcdef0123456789abcdef01234567"), "\n")
	if strings.Join(base, "\n") != strings.Join(original, "\n") {
		t.Fatal("worker environment composition mutated the supervisor's environment")
	}
	if !strings.Contains(strings.Join(api, "\n"), "ZENCHRON_DATA_DIR=/private/state") {
		t.Fatal("API environment lost its state directory after worker environment composition")
	}
	for _, key := range []string{"ZENCHRON_GITHUB_TOKEN", "ZENCHRON_GITHUB_WEBHOOK_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", "ZENCHRON_ACCESS_FILE", "ZENCHRON_DATA_DIR", "ZENCHRON_UPDATE_REPOSITORY",
		"ZENCHRON_LOCAL_STATUS_TOKEN"} {
		if strings.Contains(got, key) {
			t.Fatalf("worker received privileged environment variable %s", key)
		}
	}
	for _, expected := range []string{"ZENCHRON_WORKER_TOKEN=worker-token", "ZENCHRON_PROJECTS_ROOT=/projects",
		"ZENCHRON_RELEASE_REVISION=0123456789abcdef0123456789abcdef01234567", "ZENCHRON_CONTROL_PLANE_URL=http://127.0.0.1:8080"} {
		if !strings.Contains(got, expected) {
			t.Fatalf("worker environment omitted %q: %s", expected, got)
		}
	}
}

func TestManagedStartupWaitsHonorCancellationAndWorkerExit(t *testing.T) {
	directory := t.TempDir()
	api, err := startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	worker, err := startManagedChild("/bin/sh", []string{"-c", "exec sleep 30"}, directory, os.Environ())
	if err != nil {
		api.stop(time.Second)
		t.Fatal(err)
	}
	defer func() {
		if err := api.stop(time.Second); err != nil {
			t.Errorf("stop test control plane: %v", err)
		}
	}()
	defer func() {
		if err := worker.stop(time.Second); err != nil {
			t.Errorf("stop test worker: %v", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if err := waitManagedHealth(ctx, &http.Client{Timeout: time.Second}, api, "revision"); err == nil || time.Since(started) > time.Second {
		t.Fatalf("health wait ignored cancellation: %v", err)
	}
	if err := waitManagedWorker(ctx, &http.Client{}, api, worker, "revision", "token"); err == nil || time.Since(started) > time.Second {
		t.Fatalf("worker wait ignored cancellation: %v", err)
	}
	if err := waitManagedDashboard(ctx, &http.Client{}); err == nil {
		t.Fatal("dashboard wait accepted a cancelled startup")
	}

	exited, err := startManagedChild("/bin/sh", []string{"-c", "exit 0"}, directory, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited.done:
	case <-time.After(time.Second):
		t.Fatal("fixture worker did not exit")
	}
	client := &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"compatible":true}`)),
			Header: make(http.Header), Request: request}, nil
	})}
	if err := waitManagedWorker(context.Background(), client, api, exited, "revision", "token"); err == nil {
		t.Fatal("worker readiness accepted an exited candidate worker")
	}
}

func TestOpenVerifiedManagedDashboardOpensOnlyAfterBothHealthChecks(t *testing.T) {
	type response struct {
		status int
		header http.Header
		body   string
	}
	tests := []struct {
		name      string
		responses []response
		cancelAt  int
		wantOpen  bool
	}{
		{name: "matching managed dashboard", responses: []response{
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{"status":"ok","revision":"expected"}`},
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"text/html"}}, body: "dashboard"}}, wantOpen: true},
		{name: "wrong release on canonical port", responses: []response{
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{"status":"ok","revision":"other"}`}}, cancelAt: 1},
		{name: "redirect to unrelated service", responses: []response{
			{status: http.StatusFound, header: http.Header{"Content-Type": []string{"application/json"}, "Location": []string{"https://example.invalid/healthz"}},
				body: `{"status":"ok","revision":"expected"}`}}, cancelAt: 1},
		{name: "healthy API without dashboard", responses: []response{
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{"status":"ok","revision":"expected"}`},
			{status: http.StatusServiceUnavailable, header: http.Header{"Content-Type": []string{"text/plain"}}, body: "unavailable"}}},
		{name: "redirect from dashboard", responses: []response{
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{"status":"ok","revision":"expected"}`},
			{status: http.StatusFound, header: http.Header{"Content-Type": []string{"text/html"}, "Location": []string{"https://example.invalid/"}}, body: "dashboard"}}},
		{name: "non-html service on canonical port", responses: []response{
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{"status":"ok","revision":"expected"}`},
			{status: http.StatusOK, header: http.Header{"Content-Type": []string{"application/json"}}, body: `{}`}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			requests := 0
			client := &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
				if requests >= len(test.responses) {
					return nil, fmt.Errorf("unexpected readiness request %d", requests+1)
				}
				responseIndex := requests
				requests++
				response := test.responses[responseIndex]
				result := &http.Response{StatusCode: response.status, Header: response.header.Clone(),
					Body: io.NopCloser(strings.NewReader(response.body)), Request: request}
				if requests == test.cancelAt {
					cancel()
				}
				return result, nil
			})}
			opened := false
			err := openVerifiedManagedDashboard(ctx, client, "expected", func() error {
				opened = true
				return nil
			})
			if (err == nil) != test.wantOpen || opened != test.wantOpen {
				t.Fatalf("openVerifiedManagedDashboard() error = %v, opened = %t, want open %t", err, opened, test.wantOpen)
			}
			if requests != len(test.responses) {
				t.Fatalf("readiness request count = %d, want %d", requests, len(test.responses))
			}
		})
	}
}

func TestManagedChildrenAliveRejectsExitedControlPlane(t *testing.T) {
	api, err := startManagedChild("/bin/sh", []string{"-c", "exit 0"}, filepath.Clean(t.TempDir()), os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-api.done:
	case <-time.After(time.Second):
		t.Fatal("fixture control plane did not exit")
	}
	if err := managedChildrenAlive(api, nil); err == nil || !strings.Contains(err.Error(), "control plane exited") {
		t.Fatalf("exited control plane was accepted: %v", err)
	}
}
