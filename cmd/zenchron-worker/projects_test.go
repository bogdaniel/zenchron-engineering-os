package main

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestRepositoryLocator(t *testing.T) {
	for _, test := range []struct {
		remote string
		want   string
	}{
		{"https://user:secret@github.com/acme/repo.git?token=hidden", "github.com/acme/repo"},
		{"git@github.com:acme/repo.git", "github.com/acme/repo"},
		{"ssh://git@git.example.com:2222/group/acme/repo.git", "git.example.com:2222/group/acme/repo"},
		{"file:///Users/alex/repo", ""},
		{"/Users/alex/repo", ""},
		{"https://github.com/acme", ""},
	} {
		if got := repositoryLocator(test.remote); got != test.want {
			t.Errorf("repositoryLocator(%q) = %q, want %q", test.remote, got, test.want)
		}
	}
}

func TestGitRemoteScrubsCredentialsFromHeartbeat(t *testing.T) {
	repository := t.TempDir()
	for _, args := range [][]string{
		{"init", "-b", "main", repository},
		{"-C", repository, "remote", "add", "origin", "https://user:secret@github.com/acme/repo.git?token=hidden"},
	} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	project := projectAt(repository, "0123456789abcdef0123456789abcdef")
	encoded, err := json.Marshal(project)
	if err != nil {
		t.Fatal(err)
	}
	if project.Remote != "github.com/acme/repo" || strings.Contains(string(encoded), "secret") ||
		strings.Contains(string(encoded), "hidden") || strings.Contains(string(encoded), repository) {
		t.Fatalf("project heartbeat disclosed an unsafe or missing locator: %s", encoded)
	}
}
