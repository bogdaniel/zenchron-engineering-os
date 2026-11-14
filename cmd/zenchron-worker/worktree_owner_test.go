package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	guardTestRole     = "WORKER_GUARD_TEST_ROLE"
	guardTestWorktree = "WORKER_GUARD_TEST_WORKTREE"
)

// TestMain lets the test binary stand in for the worker binary: as the `guard` command, and as a worker
// that claims a worktree, starts a guarded provider in it exactly as a run does, and waits to be killed.
func TestMain(m *testing.M) {
	switch os.Getenv(guardTestRole) {
	case "guard":
		os.Exit(runGuard(os.Args[1:]))
	case "worker":
		os.Exit(runWorkerStandIn())
	}
	os.Exit(m.Run())
}

func runWorkerStandIn() int {
	owner, err := acquireWorktree(context.Background(), os.Getenv(guardTestWorktree), []string{os.Args[0]})
	if err != nil {
		return 3
	}
	provider := owner.command(context.Background(), []string{"sh", "-c", "sleep 60 & echo $! ; wait"})
	provider.Env = append(os.Environ(), guardTestRole+"=guard")
	provider.Stdout = os.Stdout
	if _, err := owner.start(provider); err != nil {
		return 4
	}
	time.Sleep(time.Minute)
	return 0
}

func processExists(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func waitUntilGone(pid int, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for processExists(pid) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	return !processExists(pid)
}

// startWorkerStandIn returns the stand-in worker, the worktree it claimed, and the pid of a process its
// provider started in the background.
func startWorkerStandIn(t *testing.T) (worker *exec.Cmd, worktree string, grandchild int) {
	t.Helper()
	worktree = filepath.Join(t.TempDir(), "worktree")
	worker = exec.Command(os.Args[0])
	worker.Env = append(os.Environ(), guardTestRole+"=worker", guardTestWorktree+"="+worktree)
	output, err := worker.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = worker.Process.Kill()
		_ = worker.Wait()
	})
	if _, err := fmt.Fscan(output, &grandchild); err != nil || grandchild <= 0 {
		t.Fatalf("read provider child pid: %d, %v", grandchild, err)
	}
	if !processExists(grandchild) {
		t.Fatal("provider child was not running before the worker was killed")
	}
	t.Cleanup(func() { _ = syscall.Kill(grandchild, syscall.SIGKILL) })
	return worker, worktree, grandchild
}

func recordedOwnerGroup(t *testing.T, worktree string) int {
	t.Helper()
	data, err := os.ReadFile(worktree + ".owner")
	group, convertErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || convertErr != nil || group <= 1 {
		t.Fatalf("recorded owner group = %q, %v, %v", data, err, convertErr)
	}
	return group
}

func TestGuardStopsProviderProcessesWhenTheWorkerIsKilled(t *testing.T) {
	worker, worktree, grandchild := startWorkerStandIn(t)
	// SIGKILL gives the worker no chance to clean up; only the guard can stop what it started.
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if !waitUntilGone(grandchild, cliTerminationGrace+5*time.Second) {
		t.Fatal("provider child survived the death of the worker")
	}
	// With every process gone the worktree is free again, and nothing had to be stopped to take it.
	owner, err := acquireWorktree(context.Background(), worktree, nil)
	if err != nil || owner.tookOver {
		t.Fatalf("claim after the guard cleaned up = %#v, %v", owner, err)
	}
	owner.release()
}

func TestNextAttemptStopsProviderThatOutlivedBothWorkerAndGuard(t *testing.T) {
	worker, worktree, grandchild := startWorkerStandIn(t)
	guard := recordedOwnerGroup(t, worktree)
	// Killing the guard first removes the only process that would have stopped the provider.
	if err := syscall.Kill(guard, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = worker.Wait()
	if !waitUntilGone(guard, 5*time.Second) || !processExists(grandchild) {
		t.Fatalf("setup: guard gone = %v, orphaned provider child alive = %v", !processExists(guard), processExists(grandchild))
	}
	owner, err := acquireWorktree(context.Background(), worktree, nil)
	if err != nil {
		t.Fatalf("a new attempt could not claim the worktree: %v", err)
	}
	defer owner.release()
	if !owner.tookOver {
		t.Error("the new attempt did not report that it stopped leftover processes")
	}
	if !waitUntilGone(grandchild, 2*time.Second) {
		t.Fatal("the orphaned provider child still runs beside the new attempt")
	}
}

func TestAttemptFailsClosedWhileALeftoverProcessCannotBeStopped(t *testing.T) {
	worktree := filepath.Join(t.TempDir(), "worktree")
	first, err := acquireWorktree(context.Background(), worktree, nil)
	if err != nil {
		t.Fatal(err)
	}
	leftover := first.command(context.Background(), []string{"sleep", "60"})
	stop, err := first.start(leftover)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		stop()
		_ = leftover.Wait()
	}()
	// A process that left the recorded group still holds the claim but cannot be signalled through it.
	if err := first.record(0); err != nil {
		t.Fatal(err)
	}
	first.release()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if owner, err := acquireWorktree(ctx, worktree, nil); err == nil {
		owner.release()
		t.Fatal("a second attempt claimed a worktree that a live process still holds")
	}
	if !processExists(leftover.Process.Pid) {
		t.Fatal("the leftover process was stopped although its group was not recorded")
	}
}

func TestGuardReturnsTheProviderExitCode(t *testing.T) {
	for _, want := range []int{0, 7} {
		owner, err := acquireWorktree(context.Background(), filepath.Join(t.TempDir(), "worktree"), []string{os.Args[0]})
		if err != nil {
			t.Fatal(err)
		}
		guarded := owner.command(context.Background(), []string{"sh", "-c", "exit " + strconv.Itoa(want)})
		guarded.Env = append(os.Environ(), guardTestRole+"=guard")
		stop, err := owner.start(guarded)
		if err != nil {
			t.Fatal(err)
		}
		err = guarded.Wait()
		stop()
		owner.release()
		if got := guarded.ProcessState.ExitCode(); got != want {
			t.Fatalf("guard exit code = %d (%v), want %d", got, err, want)
		}
	}
}

func TestCLIRunThroughTheGuardVerifiesAndDeliversItsResult(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, [][]string{{"grep", "-q", "changed by agent", "README.md"}})
	t.Setenv(guardTestRole, "guard")
	harness.runner.guard = []string{os.Args[0]}
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || len(result.CommitSHA) != 40 ||
		result.Verification != workerapi.VerificationPassed {
		t.Fatalf("guarded run result = %#v", result)
	}
}

const strayWriterScript = `cat > /dev/null
(while :; do echo stray >> stray.log; sleep 0.05; done) &
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`

func TestRunLeavesNoProviderProcessWritingInTheWorktree(t *testing.T) {
	harness := newRunHarness(t, strayWriterScript, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" {
		t.Fatalf("result = %#v", result)
	}
	// The provider left a background writer behind; the sweep must have stopped it, so a later attempt
	// can claim the worktree at once and without stopping anything.
	owner, err := acquireWorktree(context.Background(), harness.worktree, nil)
	if err != nil || owner.tookOver {
		t.Fatalf("claim after the run = %#v, %v", owner, err)
	}
	owner.release()
}
