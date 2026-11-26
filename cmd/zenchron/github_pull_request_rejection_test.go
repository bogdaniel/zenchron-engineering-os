package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubPullRequest422ExplainsUnrelatedHistory(t *testing.T) {
	for _, test := range []struct {
		name          string
		compareStatus int
		want          string
	}{
		{"unrelated history", http.StatusNotFound, "shares no history with acme/platform main"},
		{"other rejection", http.StatusOK, "GitHub rejected the pull request from zenchron/agent-run/123 into main"},
	} {
		t.Run(test.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/repos/acme/platform/pulls":
					_, _ = w.Write([]byte(`[]`))
				case r.Method == http.MethodPost && r.URL.Path == "/repos/acme/platform/pulls":
					w.WriteHeader(http.StatusUnprocessableEntity)
				case r.Method == http.MethodGet && r.URL.Path == "/repos/acme/platform/compare/main...zenchron/agent-run/123":
					w.WriteHeader(test.compareStatus)
					_, _ = w.Write([]byte(`{}`))
				default:
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer provider.Close()
			t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
			client := newGitHubClient()
			client.apiURL = provider.URL
			_, err := client.createPullRequest(context.Background(), "acme", "platform", "zenchron/agent-run/123", "main",
				testCommit, "Add review flow", "Agent summary.")
			if !errors.Is(err, errGitHubUnprocessableEntity) || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}
