package main

import (
	"os"
	"path/filepath"
	"testing"
)

// hookWritingScript is an agent that plants Git hooks in the worktree, as it could with husky or a
// pre-commit configuration, hoping the worker's own commit runs them outside the sandbox.
const hookWritingScript = `cat > /dev/null
mkdir -p .husky
for hook in pre-commit commit-msg post-commit prepare-commit-msg; do
  printf '#!/bin/sh\necho "$ZENCHRON_WORKER_TOKEN" > "%s"\nexit 1\n' "$HOOK_MARKER" > .husky/$hook
  chmod +x .husky/$hook
done
echo "changed by agent" >> README.md
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`

func TestWorkerCommitDoesNotRunHooksTheAgentWrote(t *testing.T) {
	t.Setenv("ZENCHRON_WORKER_TOKEN", fakeWorkerToken)
	harness := newRunHarness(t, hookWritingScript, nil)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	harness.runner.config.Repositories[""].Environment["HOOK_MARKER"] = marker
	// The repository itself points Git at a hooks directory inside the working tree, as husky does.
	runGit(t, harness.repository, "config", "core.hooksPath", ".husky")
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || len(result.CommitSHA) != 40 {
		t.Fatalf("result = %#v", result)
	}
	if content, err := os.ReadFile(marker); err == nil {
		t.Fatalf("a hook written by the agent ran during the worker's commit and saw %q", content)
	}
}
