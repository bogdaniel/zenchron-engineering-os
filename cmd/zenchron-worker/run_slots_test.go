package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// twoQueuedRuns makes the stub control plane hand out two runs of the same checkout.
func (harness *runHarness) twoQueuedRuns() []discoveredProject {
	second := harness.command
	second.ID = strings.Repeat("c", 32)
	second.Branch = workerapi.AgentRunBranch(second.ID)
	harness.queue = []workerapi.AgentRunCommand{harness.command, second}
	return []discoveredProject{{ID: harness.command.ProjectID, Name: "repository", Path: harness.repository}}
}

func TestWorkerExecutesTwoRunsOfOneCheckoutAtTheSameTimeInSeparateWorktrees(t *testing.T) {
	barrier := t.TempDir()
	// Each provider process announces itself and then refuses to finish until it sees the other one
	// running. Two runs that were only queued together, or executed one after the other, time out here.
	script := `cat > /dev/null
touch "` + barrier + `/$$"
waited=0
while [ "$(ls "` + barrier + `" | wc -l)" -lt 2 ]; do
  waited=$((waited + 1))
  [ "$waited" -gt 300 ] && exit 1
  sleep 0.1
done
basename "$PWD" > owner.txt
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`
	harness := newRunHarness(t, script, nil)
	projects := harness.twoQueuedRuns()
	harness.runner.slots = make(chan struct{}, 2)
	if err := harness.runner.dispatch(context.Background(), projects); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	harness.runner.running.Wait()
	harness.mu.Lock()
	results := harness.results
	harness.mu.Unlock()
	if len(results) != 2 || results[0].Status != "succeeded" || results[1].Status != "succeeded" ||
		results[0].CommitSHA == "" || results[0].CommitSHA == results[1].CommitSHA {
		t.Fatalf("results of two overlapping runs = %#v", results)
	}
	// Each run wrote only into its own worktree, on its own branch; the source checkout is untouched.
	for _, runID := range []string{agentRunTestID, strings.Repeat("c", 32)} {
		worktree := filepath.Join(filepath.Dir(harness.worktree), runID)
		owner, err := os.ReadFile(filepath.Join(worktree, "owner.txt"))
		branch := strings.TrimSpace(runGit(t, worktree, "branch", "--show-current"))
		if err != nil || strings.TrimSpace(string(owner)) != runID || branch != workerapi.AgentRunBranch(runID) {
			t.Errorf("worktree of run %s: owner %q, branch %q, %v", runID, owner, branch, err)
		}
	}
	if _, err := os.Stat(filepath.Join(harness.repository, "owner.txt")); !os.IsNotExist(err) {
		t.Errorf("a run wrote into the source checkout: %v", err)
	}
}

func TestWorkerWithOneSlotExecutesQueuedRunsOneAfterTheOther(t *testing.T) {
	journal := filepath.Join(t.TempDir(), "journal")
	script := `cat > /dev/null
echo start >> "` + journal + `"
sleep 0.3
echo end >> "` + journal + `"
echo change > change.txt
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`
	harness := newRunHarness(t, script, nil)
	projects := harness.twoQueuedRuns()
	harness.runner.slots = make(chan struct{}, 1)
	for range 2 {
		if err := harness.runner.dispatch(context.Background(), projects); err != nil {
			t.Fatalf("dispatch: %v", err)
		}
		// With its only slot taken, a second dispatch starts nothing until the first run is done.
		if err := harness.runner.dispatch(context.Background(), projects); err != nil {
			t.Fatalf("dispatch with a full slot: %v", err)
		}
		harness.runner.running.Wait()
	}
	recorded, err := os.ReadFile(journal)
	if err != nil || string(recorded) != "start\nend\nstart\nend\n" {
		t.Fatalf("journal = %q, %v", recorded, err)
	}
}

func TestRunConcurrencyIsConfigurableAndBounded(t *testing.T) {
	for value, want := range map[string]int{"": defaultRunConcurrency, "1": 1, "8": 8} {
		t.Setenv("ZENCHRON_WORKER_CONCURRENCY", value)
		if concurrency, err := loadRunConcurrency(); err != nil || concurrency != want {
			t.Errorf("ZENCHRON_WORKER_CONCURRENCY=%q = %d, %v; want %d", value, concurrency, err, want)
		}
	}
	for _, value := range []string{"0", "9", "many"} {
		t.Setenv("ZENCHRON_WORKER_CONCURRENCY", value)
		if _, err := loadRunConcurrency(); err == nil {
			t.Errorf("ZENCHRON_WORKER_CONCURRENCY=%q was accepted", value)
		}
	}
}
