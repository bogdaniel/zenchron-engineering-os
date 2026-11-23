package main

import (
	"context"
	"strings"
	"testing"
)

func TestRunBranchRemoteGitKeepsSSHAgentButNotProviderSecrets(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "/tmp/zenchron-test-agent.sock")
	t.Setenv("GH_TOKEN", "not-for-the-agent")
	t.Setenv("GITHUB_TOKEN", "not-for-the-agent")
	command := runBranchRemoteGitCommand(context.Background(), "version")
	variables := map[string]string{}
	for _, entry := range command.Env {
		name, value, _ := strings.Cut(entry, "=")
		variables[name] = value
	}
	if variables["SSH_AUTH_SOCK"] != "/tmp/zenchron-test-agent.sock" {
		t.Fatalf("remote git did not inherit the SSH agent socket")
	}
	if variables["GH_TOKEN"] != "" || variables["GITHUB_TOKEN"] != "" {
		t.Fatal("remote git inherited an unrelated GitHub API token")
	}
}
