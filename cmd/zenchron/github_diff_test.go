package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubPullRequestDiffRejectsHeadChangedDuringRead(t *testing.T) {
	requests := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "application/vnd.github.diff" {
			_, _ = w.Write([]byte("diff"))
			return
		}
		requests++
		head := testPullRequestHead
		if requests == 2 {
			head = "abcdef0123456789abcdef0123456789abcdef01"
		}
		_, _ = w.Write([]byte(`{"number":12,"state":"open","head":{"sha":"` + head + `"}}`))
	}))
	defer provider.Close()
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	registry := newWorkerRegistry()
	registry.github.apiURL, registry.github.client = provider.URL, provider.Client()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project/pull-requests/12/diff?head_sha="+testPullRequestHead, nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.SetPathValue("id", "project")
	request.SetPathValue("number", "12")
	response := httptest.NewRecorder()
	registry.getGitHubPullRequestDiff(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "head changed") {
		t.Fatalf("head changed during diff returned HTTP %d: %s", response.Code, response.Body.String())
	}
}

func TestGitHubPullRequestDiffReportsOversizedResponse(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") == "application/vnd.github.diff" {
			_, _ = w.Write([]byte(strings.Repeat("x", maxGitHubResponseSize+1)))
			return
		}
		_, _ = w.Write([]byte(`{"number":12,"state":"open","head":{"sha":"` + testPullRequestHead + `"}}`))
	}))
	defer provider.Close()
	t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
	registry := newWorkerRegistry()
	registry.github.apiURL, registry.github.client = provider.URL, provider.Client()
	registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project/pull-requests/12/diff?head_sha="+testPullRequestHead, nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.SetPathValue("id", "project")
	request.SetPathValue("number", "12")
	response := httptest.NewRecorder()
	registry.getGitHubPullRequestDiff(response, request)
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "diff exceeds") {
		t.Fatalf("oversized pull request diff returned HTTP %d: %s", response.Code, response.Body.String())
	}
}
