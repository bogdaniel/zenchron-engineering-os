package main

import (
	"context"
	"fmt"
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

func TestCollectAgentRunDiffDoesNotRunNestedRepositoryFsmonitor(t *testing.T) {
	repository := t.TempDir()
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial")

	nested := filepath.Join(repository, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, nested, "init", "-b", "main")
	runGit(t, nested, "config", "user.name", "Zenchron Test")
	runGit(t, nested, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(nested, "file.txt"), []byte("nested\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, nested, "add", "file.txt")
	runGit(t, nested, "commit", "-m", "nested")

	marker := filepath.Join(t.TempDir(), "fsmonitor-ran")
	fsmonitor := filepath.Join(t.TempDir(), "fsmonitor")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s' \"$ZENCHRON_WORKER_TOKEN\" > %q\n", marker)
	if err := os.WriteFile(fsmonitor, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, nested, "config", "core.fsmonitor", fsmonitor)
	t.Setenv("ZENCHRON_WORKER_TOKEN", "worker-secret")

	if _, _, err := collectAgentRunDiff(context.Background(), repository, "main"); err != nil {
		t.Fatalf("collectAgentRunDiff() error = %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("nested fsmonitor ran (marker stat error = %v)", err)
	}
}
