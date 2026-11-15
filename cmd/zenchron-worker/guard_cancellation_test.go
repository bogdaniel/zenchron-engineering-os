package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// stubbornProviderScript is a provider that ignores the request to stop, as Codex does while a tool is
// running, with a tool command in a session of its own.
const stubbornProviderScript = `cat > /dev/null
trap '' TERM
perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "64"' 3>&- </dev/null >/dev/null 2>&1 &
echo $! > tool.pid
while true; do echo '{"type":"turn.started"}'; sleep 0.2; done
`

func TestCancellingAGuardedRunStopsAProviderThatIgnoresTheRequestAndItsToolCommand(t *testing.T) {
	harness := newRunHarness(t, stubbornProviderScript, nil)
	harness.runner.config.Repositories[""].Environment[guardTestRole] = "guard"
	harness.runner.guard = []string{os.Args[0]}
	harness.cancelOnCall = 2
	started := time.Now()
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "cancelled" {
		t.Fatalf("result = %#v", result)
	}
	// The guard must have ended the run itself: it acts before the worker's own grace period runs out
	// and the worker kills the guard, which would leave the tool command to a later sweep.
	if elapsed := time.Since(started); elapsed >= cliTerminationGrace+agentRunProgressInterval {
		t.Errorf("cancellation took %s; the guard did not stop the run within its grace period", elapsed)
	}
	data, err := os.ReadFile(filepath.Join(harness.worktree, "tool.pid"))
	tool, convertErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || convertErr != nil {
		t.Fatalf("tool pid = %q, %v, %v", data, err, convertErr)
	}
	t.Cleanup(func() { _ = syscall.Kill(tool, syscall.SIGKILL) })
	if !waitUntilGone(tool, time.Second) {
		t.Fatal("the tool command kept running after the run was cancelled")
	}
}
