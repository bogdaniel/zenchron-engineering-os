package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const mergeHead = "0123456789abcdef0123456789abcdef01234567"
const mergeCommit = "abcdef0123456789abcdef0123456789abcdef01"

func TestGitHubPullRequestMergeRequiresCurrentGovernedState(t *testing.T) {
	tests := []struct {
		name             string
		pull             string
		checks           string
		reviews          string
		mergeStatus      int
		remote           string
		wantStatus       int
		wantMessage      string
		wantMergeRequest bool
	}{
		{name: "merge current clean pull request", pull: mergePull("true", "clean", mergeHead), checks: "[]", reviews: "[]",
			mergeStatus: http.StatusOK, remote: "127.0.0.1:1234", wantStatus: http.StatusOK, wantMergeRequest: true},
		{name: "reject stale head before merge", pull: mergePull("true", "clean", mergeCommit), checks: "[]", reviews: "[]",
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "head changed"},
		{name: "reject closed pull request", pull: strings.Replace(mergePull("true", "clean", mergeHead), `"open"`, `"closed"`, 1),
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "no longer open"},
		{name: "reject unknown mergeability", pull: `{"number":12,"state":"open","head":{"sha":"` + mergeHead + `"}}`,
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "finished computing mergeability"},
		{name: "reject branch policy block", pull: mergePull("true", "blocked", mergeHead), checks: "[]", reviews: "[]",
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "required reviews and status checks"},
		{name: "reject conflicts", pull: mergePull("false", "dirty", mergeHead), checks: "[]", reviews: "[]",
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "conflicting changes"},
		{name: "reject unresolved check", pull: mergePull("true", "clean", mergeHead),
			checks: `[{"name":"required-ci","status":"in_progress"}]`, reviews: "[]",
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "required-ci"},
		{name: "reject failed check", pull: mergePull("true", "clean", mergeHead),
			checks: `[{"name":"required-ci","status":"completed","conclusion":"failure"}]`, reviews: "[]",
			remote: "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "required-ci"},
		{name: "reject outstanding change request", pull: mergePull("true", "clean", mergeHead), checks: "[]",
			reviews: `[{"id":1,"state":"CHANGES_REQUESTED","submitted_at":"2026-11-17T12:00:00Z","user":{"login":"Reviewer"}}]`,
			remote:  "127.0.0.1:1234", wantStatus: http.StatusConflict, wantMessage: "@reviewer"},
		{name: "allow reviewer follow-up approval", pull: mergePull("true", "clean", mergeHead), checks: "[]",
			reviews: `[{"id":1,"state":"CHANGES_REQUESTED","submitted_at":"2026-11-17T12:00:00Z","user":{"login":"reviewer"}},` +
				`{"id":2,"state":"APPROVED","submitted_at":"2026-11-17T12:01:00Z","user":{"login":"reviewer"}}]`,
			mergeStatus: http.StatusOK, remote: "127.0.0.1:1234", wantStatus: http.StatusOK, wantMergeRequest: true},
		{name: "GitHub stale-head race", pull: mergePull("true", "clean", mergeHead), checks: "[]", reviews: "[]",
			mergeStatus: http.StatusConflict, remote: "127.0.0.1:1234", wantStatus: http.StatusConflict,
			wantMessage: "head or branch protection", wantMergeRequest: true},
		{name: "GitHub permission refusal", pull: mergePull("true", "clean", mergeHead), checks: "[]", reviews: "[]",
			mergeStatus: http.StatusForbidden, remote: "127.0.0.1:1234", wantStatus: http.StatusForbidden,
			wantMessage: "lack repository permission", wantMergeRequest: true},
		{name: "unauthorized remote request", remote: "192.0.2.4:1234", wantStatus: http.StatusForbidden,
			wantMessage: "authorized local operator"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("ZENCHRON_GITHUB_TOKEN", "test-token")
			mergeCalls := 0
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/repos/acme/platform/pulls/12":
					_, _ = w.Write([]byte(test.pull))
				case "/repos/acme/platform/commits/" + mergeHead + "/check-runs":
					_, _ = w.Write([]byte(`{"check_runs":` + test.checks + `}`))
				case "/repos/acme/platform/pulls/12/reviews":
					_, _ = w.Write([]byte(test.reviews))
				case "/repos/acme/platform/pulls/12/merge":
					mergeCalls++
					if r.Method != http.MethodPut {
						t.Errorf("merge method = %s", r.Method)
					}
					var input struct {
						SHA string `json:"sha"`
					}
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.SHA != mergeHead {
						t.Errorf("merge head SHA = %q, %v", input.SHA, err)
					}
					if test.mergeStatus != http.StatusOK {
						w.WriteHeader(test.mergeStatus)
						return
					}
					_, _ = w.Write([]byte(`{"sha":"` + mergeCommit + `","merged":true,"message":"Pull Request successfully merged"}`))
				default:
					t.Errorf("unexpected GitHub request: %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer provider.Close()
			registry := newWorkerRegistry()
			registry.github.apiURL, registry.github.client = provider.URL, provider.Client()
			registry.projects["worker:project"] = projectRecord{ID: "project", GitRemote: "github.com/acme/platform"}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/pull-requests/12/merge",
				strings.NewReader(`{"head_sha":"`+mergeHead+`"}`))
			request.RemoteAddr = test.remote
			request.Header.Set("Content-Type", "application/json")
			request.SetPathValue("id", "project")
			request.SetPathValue("number", "12")
			response := httptest.NewRecorder()
			registry.mergeGitHubPullRequest(response, request)
			if response.Code != test.wantStatus || (test.wantMessage != "" && !strings.Contains(response.Body.String(), test.wantMessage)) {
				t.Fatalf("merge returned HTTP %d: %s", response.Code, response.Body.String())
			}
			if test.wantMergeRequest != (mergeCalls == 1) {
				t.Fatalf("merge endpoint called %d times; want merge=%v", mergeCalls, test.wantMergeRequest)
			}
			if test.wantStatus == http.StatusOK && !strings.Contains(response.Body.String(), mergeCommit) {
				t.Fatalf("merge result omitted GitHub merge commit: %s", response.Body.String())
			}
		})
	}
}

func mergePull(mergeable, state, head string) string {
	return `{"number":12,"state":"open","draft":false,"mergeable":` + mergeable +
		`,"mergeable_state":"` + state + `","head":{"ref":"feature","sha":"` + head + `"},"base":{"ref":"main"}}`
}
