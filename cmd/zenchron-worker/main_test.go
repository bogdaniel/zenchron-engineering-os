package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestSendHeartbeatUsesWorkerEndpoint(t *testing.T) {
	project := discoveredProject{
		ID: "abcdef0123456789abcdef0123456789", Name: "repo", Branch: "feature/test",
		Remote: "github.com/acme/repo", Path: "/private/repo",
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat" {
			t.Errorf("request = %s %s, want worker heartbeat PUT", r.Method, r.URL.Path)
		}
		var body struct {
			Name                string `json:"name"`
			AgentRuntimeEnabled bool   `json:"agent_runtime_enabled"`
			Projects            []struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Branch string `json:"branch"`
				Remote string `json:"git_remote"`
				Path   string `json:"path"`
			} `json:"projects"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name != "dev-machine" ||
			!body.AgentRuntimeEnabled ||
			len(body.Projects) != 1 || body.Projects[0].ID != project.ID ||
			body.Projects[0].Name != "repo" || body.Projects[0].Branch != project.Branch ||
			body.Projects[0].Remote != project.Remote || body.Projects[0].Path != "" {
			t.Errorf("heartbeat body = %#v, decode error = %v", body, err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if err := sendHeartbeat(context.Background(), server.Client(), baseURL,
		"0123456789abcdef0123456789abcdef", "dev-machine", []discoveredProject{project}, true); err != nil {
		t.Fatalf("sendHeartbeat: %v", err)
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
