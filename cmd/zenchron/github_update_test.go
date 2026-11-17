package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type updateTestTransport func(*http.Request) (*http.Response, error)

func (transport updateTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func updateTestClient(handler http.Handler) gitHubClient {
	return gitHubClient{apiURL: "https://github.test", token: "test-token", client: &http.Client{
		Transport: updateTestTransport(func(request *http.Request) (*http.Response, error) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			return recorder.Result(), nil
		}),
	}}
}

func TestTrustedMainRequiresProtectionSuccessfulChecksAndMergedPullRequest(t *testing.T) {
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const tree = "abcdef0123456789abcdef0123456789abcdef01"
	var failedCheck bool
	branchName := "main"
	mainCommit := commit
	client := updateTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/branches/main":
			w.Write([]byte(`{"name":"` + branchName + `","commit":{"sha":"` + mainCommit + `","commit":{"tree":{"sha":"` + tree + `"}}}}`))
		case "/repos/owner/repo/commits/" + mainCommit:
			w.Write([]byte(`{"sha":"` + mainCommit + `","commit":{"tree":{"sha":"` + tree + `"},"verification":{"verified":true}}}`))
		case "/repos/owner/repo/branches/main/protection":
			w.Write([]byte(`{"required_status_checks":{"contexts":["ci"],"checks":[{"context":"build","app_id":17}]}}`))
		case "/repos/owner/repo/commits/" + mainCommit + "/statuses":
			state := "success"
			if failedCheck {
				state = "failure"
			}
			w.Write([]byte(`[{"context":"ci","state":"` + state + `"}]`))
		case "/repos/owner/repo/commits/" + mainCommit + "/check-runs":
			w.Write([]byte(`{"check_runs":[{"name":"build","status":"completed","conclusion":"success","app":{"id":17}}]}`))
		case "/repos/owner/repo/commits/" + mainCommit + "/pulls":
			w.Write([]byte(`[{"merged_at":"2026-11-17T00:00:00Z","base":{"ref":"main"}}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	candidate, err := client.trustedMain(context.Background(), "owner/repo")
	if err != nil || candidate.Commit != commit || candidate.Tree != tree {
		t.Fatalf("trustedMain() = %#v, %v", candidate, err)
	}
	if err := verifyCurrentTrustedCandidate(context.Background(), client, candidate); err != nil {
		t.Fatalf("unchanged trusted main was rejected: %v", err)
	}
	mainCommit = "abcdef0123456789abcdef0123456789abcdef01"
	if err := verifyCurrentTrustedCandidate(context.Background(), client, candidate); err == nil || !strings.Contains(err.Error(), "advanced") {
		t.Fatalf("advanced main revalidation error = %v", err)
	}
	mainCommit = commit
	failedCheck = true
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err == nil || !strings.Contains(err.Error(), `required main check "ci"`) {
		t.Fatalf("trustedMain() error = %v; want failed required check", err)
	}
	failedCheck = false
	branchName = "feature"
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err == nil || !strings.Contains(err.Error(), "incomplete main revision") {
		t.Fatalf("trustedMain() error = %v; want untrusted branch refusal", err)
	}
}

func TestTrustedMainFailsClosedWhenProtectionOrMergedPRIsUnavailable(t *testing.T) {
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const tree = "abcdef0123456789abcdef0123456789abcdef01"
	var handler http.HandlerFunc = func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/branches/main":
			w.Write([]byte(`{"name":"main","commit":{"sha":"` + commit + `","commit":{"tree":{"sha":"` + tree + `"}}}}`))
		case "/repos/owner/repo/commits/" + commit:
			w.Write([]byte(`{"sha":"` + commit + `","commit":{"tree":{"sha":"` + tree + `"},"verification":{"verified":true}}}`))
		case "/repos/owner/repo/branches/main/protection":
			w.Write([]byte(`{"required_status_checks":{"contexts":["ci"]}}`))
		case "/repos/owner/repo/commits/" + commit + "/statuses":
			w.Write([]byte(`[{"context":"ci","state":"success"}]`))
		case "/repos/owner/repo/commits/" + commit + "/check-runs":
			w.Write([]byte(`{"check_runs":[]}`))
		case "/repos/owner/repo/commits/" + commit + "/pulls":
			w.Write([]byte(`[{"merged_at":null,"base":{"ref":"main"}}]`))
		default:
			http.NotFound(w, r)
		}
	}
	client := updateTestClient(handler)
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err == nil || !strings.Contains(err.Error(), "not associated with a merged PR") {
		t.Fatalf("trustedMain() error = %v; want merged PR refusal", err)
	}
}

func TestTrustedMainAcceptsEffectiveRulesetChecksAndRejectsUnsignedCommit(t *testing.T) {
	const commit = "0123456789abcdef0123456789abcdef01234567"
	const tree = "abcdef0123456789abcdef0123456789abcdef01"
	unsigned := false
	client := updateTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/owner/repo/branches/main":
			w.Write([]byte(`{"name":"main","commit":{"sha":"` + commit + `","commit":{"tree":{"sha":"` + tree + `"}}}}`))
		case "/repos/owner/repo/commits/" + commit:
			verified := !unsigned
			if verified {
				w.Write([]byte(`{"sha":"` + commit + `","commit":{"tree":{"sha":"` + tree + `"},"verification":{"verified":true}}}`))
			} else {
				w.Write([]byte(`{"sha":"` + commit + `","commit":{"tree":{"sha":"` + tree + `"},"verification":{"verified":false}}}`))
			}
		case "/repos/owner/repo/rules/branches/main":
			w.Write([]byte(`[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build","integration_id":17}]}}]`))
		case "/repos/owner/repo/commits/" + commit + "/statuses":
			w.Write([]byte(`[]`))
		case "/repos/owner/repo/commits/" + commit + "/check-runs":
			w.Write([]byte(`{"check_runs":[{"name":"build","status":"completed","conclusion":"success","app":{"id":17}}]}`))
		case "/repos/owner/repo/commits/" + commit + "/pulls":
			w.Write([]byte(`[{"merged_at":"2026-11-17T00:00:00Z","base":{"ref":"main"}}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err != nil {
		t.Fatalf("trustedMain() rejected eligible ruleset revision: %v", err)
	}
	unsigned = true
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("trustedMain() error = %v; want unverified signature refusal", err)
	}
}

func TestTrustedMainRejectsUnauthenticatedAndUnprotectedRepositories(t *testing.T) {
	client := gitHubClient{}
	if _, err := client.trustedMain(context.Background(), "owner/repo"); err == nil || !strings.Contains(err.Error(), "authentication") {
		t.Fatalf("trustedMain() error = %v; want auth refusal", err)
	}
}
