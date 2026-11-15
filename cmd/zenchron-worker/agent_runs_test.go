package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const agentRunTestID = "0123456789abcdef0123456789abcdef"

func TestCollectAgentRunDiffBoundsOutput(t *testing.T) {
	repository := t.TempDir()
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial")
	if err := os.WriteFile(filepath.Join(repository, "large.txt"), []byte(strings.Repeat("line value\n", maxAgentRunDiffSize)), 0o600); err != nil {
		t.Fatal(err)
	}
	diff, truncated, err := collectAgentRunDiff(context.Background(), repository, "main")
	if err != nil || !truncated || len(diff) != maxAgentRunDiffSize {
		t.Fatalf("bounded diff length/truncated/error = %d/%t/%v", len(diff), truncated, err)
	}
}
