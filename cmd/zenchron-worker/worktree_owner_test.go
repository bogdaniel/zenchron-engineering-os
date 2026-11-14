package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	guardTestProvider = "WORKER_GUARD_TEST_PROVIDER"

	// groupProvider keeps a child in the provider's process group. sessionProvider starts its child the
	// way Codex starts a tool command: as a session of its own, without the inherited ownership lock, so
	// neither a signal to the group nor the lock reaches it.
	groupProvider   = `sleep 60 & echo $! ; wait`
	sessionProvider = `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "61"' 3>&- & echo $! ; wait`
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
	provider := owner.command(context.Background(), []string{"sh", "-c", os.Getenv(guardTestProvider)})
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
func startWorkerStandIn(t *testing.T, provider string) (worker *exec.Cmd, worktree string, grandchild int) {
	t.Helper()
	worktree = filepath.Join(t.TempDir(), "worktree")
	worker = exec.Command(os.Args[0])
	worker.Env = append(os.Environ(), guardTestRole+"=worker", guardTestWorktree+"="+worktree, guardTestProvider+"="+provider)
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

func recordedOwner(t *testing.T, worktree string) ownerRecord {
	t.Helper()
	file, err := os.Open(worktree + ".owner.processes")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	record, err := readOwnerRecord(file)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

// waitUntilRecorded waits for the guard to have seen a process, as it does within one polling interval.
func waitUntilRecorded(t *testing.T, worktree string, pid int) ownerRecord {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		record := recordedOwner(t, worktree)
		if record.group > 1 && slices.ContainsFunc(record.members, func(member processIdentity) bool { return member.pid == pid }) {
			return record
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the guard never recorded process %d: %#v", pid, recordedOwner(t, worktree))
	return ownerRecord{}
}

func TestGuardStopsProcessThatLeftTheProviderGroupWhenTheWorkerIsKilled(t *testing.T) {
	worker, worktree, escaped := startWorkerStandIn(t, sessionProvider)
	waitUntilRecorded(t, worktree, escaped)
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if !waitUntilGone(escaped, cliTerminationGrace+5*time.Second) {
		t.Fatal("a process that left the provider's group survived the death of the worker")
	}
}

func TestNextAttemptStopsProcessThatLeftTheGroupAfterWorkerAndGuardDied(t *testing.T) {
	worker, worktree, escaped := startWorkerStandIn(t, sessionProvider)
	guard := waitUntilRecorded(t, worktree, escaped).group
	if err := syscall.Kill(guard, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = worker.Wait()
	if !waitUntilGone(guard, 5*time.Second) || !processExists(escaped) {
		t.Fatalf("setup: guard gone = %v, escaped process alive = %v", !processExists(guard), processExists(escaped))
	}
	owner, err := acquireWorktree(context.Background(), worktree, nil)
	if err != nil {
		t.Fatalf("a new attempt could not claim the worktree: %v", err)
	}
	defer owner.release()
	if !owner.tookOver || !waitUntilGone(escaped, 2*time.Second) {
		t.Fatalf("took over = %v, escaped process alive = %v", owner.tookOver, processExists(escaped))
	}
}

func TestRecordedProcessIsNotKilledOnceItsPidBelongsToAnotherProcess(t *testing.T) {
	bystander := exec.Command("sleep", "60")
	if err := bystander.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = bystander.Process.Kill()
		_ = bystander.Wait()
	}()
	// The record names the bystander's pid with the start time of a process that no longer exists.
	stale := []processIdentity{{pid: bystander.Process.Pid, started: time.Now().Add(-time.Hour)}}
	if alive, err := killProcesses(stale); err != nil || alive != 0 || !processExists(bystander.Process.Pid) {
		t.Fatalf("%d recorded process(es) matched, %v; bystander alive = %v", alive, err, processExists(bystander.Process.Pid))
	}
	// With its real start time the same pid is recognised, whatever locale and time zone the listing ran in.
	t.Setenv("TZ", "Asia/Tokyo")
	t.Setenv("LC_ALL", "de_DE.UTF-8")
	processes, err := listProcesses()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TZ", "UTC")
	t.Setenv("LC_ALL", "C")
	current := []processIdentity{{pid: bystander.Process.Pid, started: processes[bystander.Process.Pid].started}}
	if alive, err := killProcesses(current); err != nil || alive != 1 {
		t.Fatalf("a live recorded process was not recognised: %d, %v", alive, err)
	}
}

func TestAttemptFailsWhenTheProcessTableCannotBeRead(t *testing.T) {
	worktree := filepath.Join(t.TempDir(), "worktree")
	first, err := acquireWorktree(context.Background(), worktree, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeOwnerRecord(first.record, ownerRecord{group: 2, members: []processIdentity{{pid: 999999, started: time.Now()}}}); err != nil {
		t.Fatal(err)
	}
	first.release()
	// Without ps nobody can tell whether the recorded process still runs; that must not read as "gone".
	t.Setenv("PATH", t.TempDir())
	if owner, err := acquireWorktree(context.Background(), worktree, nil); err == nil {
		owner.release()
		t.Fatal("an attempt claimed the worktree although the earlier attempt's processes could not be checked")
	}
	if err := os.WriteFile(worktree+".owner.processes", []byte("not a record\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if owner, err := acquireWorktree(context.Background(), worktree, nil); err == nil {
		owner.release()
		t.Fatal("an attempt claimed the worktree although its process record is damaged")
	}
}

func TestGuardStopsProviderProcessesWhenTheWorkerIsKilled(t *testing.T) {
	worker, worktree, grandchild := startWorkerStandIn(t, groupProvider)
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
	worker, worktree, grandchild := startWorkerStandIn(t, groupProvider)
	guard := waitUntilRecorded(t, worktree, grandchild).group
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
	if err := writeOwnerRecord(first.record, ownerRecord{}); err != nil {
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
	// The role reaches the stand-in guard the way an operator variable reaches a real process.
	harness.runner.config.Repositories[""].Environment[guardTestRole] = "guard"
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

// sessionToolScript starts a tool command as its own session, as Codex does, and finishes while that
// command is still running.
const sessionToolScript = `cat > /dev/null
perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "62"' 3>&- </dev/null >/dev/null 2>&1 &
echo $! > tool.pid
sleep 2
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`

func TestGuardedRunStopsAToolCommandThatOutlivesTheProvider(t *testing.T) {
	harness := newRunHarness(t, sessionToolScript, nil)
	harness.runner.config.Repositories[""].Environment[guardTestRole] = "guard"
	harness.runner.guard = []string{os.Args[0]}
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" {
		t.Fatalf("result = %#v", result)
	}
	data, err := os.ReadFile(filepath.Join(harness.worktree, "tool.pid"))
	tool, convertErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || convertErr != nil {
		t.Fatalf("tool pid = %q, %v, %v", data, err, convertErr)
	}
	t.Cleanup(func() { _ = syscall.Kill(tool, syscall.SIGKILL) })
	if !waitUntilGone(tool, 2*time.Second) {
		t.Fatal("a tool command started in its own session kept running after the provider finished")
	}
}

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
