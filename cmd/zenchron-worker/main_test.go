package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestValidateWorkerName(t *testing.T) {
	tests := []struct {
		label   string
		name    string
		wantErr string
	}{
		{label: "valid", name: "dev-machine"},
		{label: "empty", name: "", wantErr: "worker name must be between 1 and 128 bytes"},
		{label: "too long", name: strings.Repeat("a", 129), wantErr: "worker name must be between 1 and 128 bytes"},
		{label: "newline", name: "dev\nmachine", wantErr: "worker name must not contain control characters"},
		{label: "tab", name: "dev\tmachine", wantErr: "worker name must not contain control characters"},
		{label: "delete", name: "dev\x7fmachine", wantErr: "worker name must not contain control characters"},
	}
	for _, test := range tests {
		t.Run(test.label, func(t *testing.T) {
			err := validateWorkerName(test.name)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("validateWorkerName(%q): %v", test.name, err)
				}
				return
			}
			if err == nil || err.Error() != test.wantErr {
				t.Fatalf("validateWorkerName(%q) error = %v, want %q", test.name, err, test.wantErr)
			}
		})
	}
}

func TestSendHeartbeatUsesWorkerEndpoint(t *testing.T) {
	project := discoveredProject{
		ID: "abcdef0123456789abcdef0123456789", Name: "repo", Branch: "feature/test",
		Remote: "github.com/acme/repo", Path: "/private/repo",
	}
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat" {
			t.Errorf("request = %s %s, want worker heartbeat PUT", r.Method, r.URL.Path)
		}
		var body struct {
			Name     string `json:"name"`
			Projects []struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Branch string `json:"branch"`
				Remote string `json:"git_remote"`
				Path   string `json:"path"`
			} `json:"projects"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name != "dev-machine" ||
			len(body.Projects) != 1 || body.Projects[0].ID != project.ID ||
			body.Projects[0].Name != "repo" || body.Projects[0].Branch != project.Branch ||
			body.Projects[0].Remote != project.Remote || body.Projects[0].Path != "" {
			t.Errorf("heartbeat body = %#v, decode error = %v", body, err)
		}
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"id":"0123456789abcdef0123456789abcdef","skipped_projects":[{"id":"abcdef0123456789abcdef0123456789","reason":"repository_not_granted"}]}`)),
		}, nil
	})}
	baseURL, err := url.Parse("http://control-plane.test")
	if err != nil {
		t.Fatal(err)
	}
	reply, err := sendHeartbeat(context.Background(), client, baseURL,
		"0123456789abcdef0123456789abcdef", workerapi.Heartbeat{Name: "dev-machine",
			Projects: wireProjects([]discoveredProject{project})})
	if err != nil {
		t.Fatalf("sendHeartbeat: %v", err)
	}
	if reply.ID != "0123456789abcdef0123456789abcdef" || len(reply.SkippedProjects) != 1 ||
		reply.SkippedProjects[0].ID != project.ID || reply.SkippedProjects[0].Reason != workerapi.SkippedProjectRepositoryNotGranted {
		t.Fatalf("heartbeat response = %#v", reply)
	}
}

func TestSkippedProjectIsLoggedOnceWhileTheSetIsUnchanged(t *testing.T) {
	var output bytes.Buffer
	previousOutput := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previousOutput) })
	runner := &agentRunner{}
	reply := workerapi.HeartbeatResponse{SkippedProjects: []workerapi.SkippedProject{{
		ID: "abcdef0123456789abcdef0123456789", Reason: workerapi.SkippedProjectRepositoryNotGranted,
	}}}
	projects := []workerapi.Project{{ID: "abcdef0123456789abcdef0123456789", Name: "repo"}}
	for range 2 {
		if err := runner.logSkippedProjects(reply, projects); err != nil {
			t.Fatalf("logSkippedProjects: %v", err)
		}
	}
	if got := strings.Count(output.String(), `project "repo" was not registered: repository_not_granted`); got != 1 {
		t.Fatalf("log output = %q, want one matching line", output.String())
	}
}

func TestWorkerHTTPClientAddsBearerCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer worker-secret-for-auth-tests-1234567890" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := newWorkerHTTPClient("worker-secret-for-auth-tests-1234567890").Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("response status = %d", response.StatusCode)
	}
}

func TestWorkerHTTPClientDoesNotForwardCredentialOnRedirect(t *testing.T) {
	targetAuthorization := make(chan string, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetAuthorization <- r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirect.Close()
	response, err := newWorkerHTTPClient("worker-secret-for-auth-tests-1234567890").Get(redirect.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusFound {
		t.Fatalf("redirect status = %d", response.StatusCode)
	}
	select {
	case authorization := <-targetAuthorization:
		t.Fatalf("redirect target received Authorization %q", authorization)
	default:
	}
}

func TestDiscoverProjectsFindsGitCheckoutsWithoutExposingPaths(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"alpha", "beta", "plain"} {
		path := root + "/" + name
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if name != "plain" {
			if err := os.Mkdir(path+"/.git", 0o700); err != nil {
				t.Fatal(err)
			}
		}
	}
	projects, err := discoverProjects(root, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 || projects[0].Name != "alpha" || projects[1].Name != "beta" {
		t.Fatalf("projects = %#v", projects)
	}
	if projects[0].ID != stableID("0123456789abcdef0123456789abcdef\x00"+projects[0].Path) {
		t.Fatalf("project ID is not stable")
	}
	body, err := json.Marshal(projects)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), root) {
		t.Fatalf("heartbeat payload exposed local root: %s", body)
	}
}

func TestDiscoverProjectsAcceptsGitWorktreeFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(root+"/.git", []byte("gitdir: /private/git"), 0o600); err != nil {
		t.Fatal(err)
	}
	projects, err := discoverProjects(root, "0123456789abcdef0123456789abcdef")
	if err != nil || len(projects) != 1 {
		t.Fatalf("projects = %#v, error = %v", projects, err)
	}
}

func TestCurrentBranchReadsBranchFromGitMetadata(t *testing.T) {
	root := t.TempDir()
	gitDir := root + "/.git"
	if err := os.Mkdir(gitDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gitDir+"/HEAD", []byte("ref: refs/heads/feature/live-status\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if branch := currentBranch(root); branch != "feature/live-status" {
		t.Fatalf("currentBranch() = %q, want feature/live-status", branch)
	}
}

func TestCurrentBranchReadsWorktreeMetadataAndHidesExternalPointers(t *testing.T) {
	root := t.TempDir()
	checkout := root + "/checkout"
	gitDir := root + "/.git/worktrees/checkout"
	if err := os.MkdirAll(checkout, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(gitDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(checkout+"/.git", []byte("gitdir: ../.git/worktrees/checkout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gitDir+"/HEAD", []byte("ref: refs/heads/review/one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if branch := currentBranch(checkout); branch != "review/one" {
		t.Fatalf("worktree currentBranch() = %q, want review/one", branch)
	}
	if err := os.WriteFile(checkout+"/.git", []byte("gitdir: /private/elsewhere\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if branch := currentBranch(checkout); branch != "Unknown" {
		t.Fatalf("external gitdir currentBranch() = %q, want Unknown", branch)
	}
}
