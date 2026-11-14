package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// ownerTakeoverWait is how long a new attempt waits for leftover processes to die after stopping them.
	ownerTakeoverWait = 10 * time.Second
	ownerPollInterval = 100 * time.Millisecond
	// guardLivenessFD and guardOwnerFD are where the guard command finds the worker-liveness pipe and the
	// worktree ownership lock.
	guardLivenessFD = 3
	guardOwnerFD    = 4
)

var errWorktreeStillOwned = errors.New("processes from an earlier attempt still hold the run worktree")

// worktreeOwner is the exclusive claim one attempt holds on a run worktree, and the only way to start a
// process there. The claim is an advisory lock on a file beside the worktree. Every process started
// through the owner inherits the locked descriptor, so the lock stays held for as long as any of them
// lives, even after the worker that started them is gone, and the next attempt cannot start a second
// writer in the same files.
type worktreeOwner struct {
	lock *os.File
	// guard is the command prefix that stops a process when this worker dies; empty runs it unguarded.
	guard []string
	// tookOver reports that leftover processes of an earlier attempt had to be stopped first.
	tookOver bool
}

// acquireWorktree claims the worktree for this attempt. If processes of an earlier attempt still hold
// it, their recorded process group is stopped; if the claim is still held after that, the attempt
// fails instead of running beside them.
func acquireWorktree(ctx context.Context, worktree string, guard []string) (*worktreeOwner, error) {
	lock, err := os.OpenFile(worktree+".owner", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open worktree ownership file: %w", err)
	}
	owner := &worktreeOwner{lock: lock, guard: guard}
	if owner.tryLock() {
		return owner, nil
	}
	owner.tookOver = true
	// ponytail: only the recorded process group is signalled. A descendant that left the group keeps the
	// lock, is not stopped, and makes the attempt fail closed; and if every member of the group is gone
	// while such a descendant lives, the id could belong to an unrelated group by now. Track descendants
	// with cgroups or a job object if providers start leaving their group.
	if group := owner.recordedGroup(); group > 1 {
		_ = syscall.Kill(-group, syscall.SIGKILL)
	}
	deadline := time.NewTimer(ownerTakeoverWait)
	defer deadline.Stop()
	ticker := time.NewTicker(ownerPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			lock.Close()
			return nil, ctx.Err()
		case <-deadline.C:
			lock.Close()
			return nil, errWorktreeStillOwned
		case <-ticker.C:
			if owner.tryLock() {
				return owner, nil
			}
		}
	}
}

func (owner *worktreeOwner) tryLock() bool {
	return syscall.Flock(int(owner.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}

func (owner *worktreeOwner) recordedGroup() int {
	data := make([]byte, 32)
	count, _ := owner.lock.ReadAt(data, 0)
	group, err := strconv.Atoi(strings.TrimSpace(string(data[:count])))
	if err != nil {
		return 0
	}
	return group
}

func (owner *worktreeOwner) record(group int) error {
	if err := owner.lock.Truncate(0); err != nil {
		return err
	}
	_, err := owner.lock.WriteAt([]byte(strconv.Itoa(group)+"\n"), 0)
	return err
}

// release drops this worker's hold. The lock itself stays held while a started process still lives.
func (owner *worktreeOwner) release() {
	_ = owner.lock.Close()
}

// command builds a process that runs in its own process group under the guard.
func (owner *worktreeOwner) command(ctx context.Context, arguments []string) *exec.Cmd {
	arguments = append(append([]string{}, owner.guard...), arguments...)
	process := exec.CommandContext(ctx, arguments[0], arguments[1:]...)
	ownProcessGroup(process)
	return process
}

// start runs a process built by command. The returned stop must be called after the process has been
// waited for; it sweeps whatever the process left behind in its group.
func (owner *worktreeOwner) start(process *exec.Cmd) (stop func(), err error) {
	closers := []io.Closer{}
	closeAll := func() {
		for _, closer := range closers {
			_ = closer.Close()
		}
	}
	process.ExtraFiles = []*os.File{owner.lock}
	if len(owner.guard) > 0 {
		// The guard watches the read end of this pipe. The worker never writes to it, so the guard sees
		// end-of-file exactly when the worker process is gone, however it died.
		reader, writer, pipeErr := os.Pipe()
		if pipeErr != nil {
			return nil, fmt.Errorf("create process guard pipe: %w", pipeErr)
		}
		closers = append(closers, reader, writer)
		process.ExtraFiles = []*os.File{reader, owner.lock}
	}
	if err := process.Start(); err != nil {
		closeAll()
		return nil, err
	}
	// The process is the leader of its own group, so its pid is the group id.
	if err := owner.record(process.Process.Pid); err != nil {
		_ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL)
		_ = process.Wait()
		closeAll()
		return nil, fmt.Errorf("record worktree owner: %w", err)
	}
	return func() {
		_ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL)
		closeAll()
	}, nil
}

// runGuard is the `guard` command: it runs a command and stops the whole process group when the
// liveness descriptor reaches end-of-file, which happens when the worker that started it no longer
// exists. Without it a provider would keep editing the worktree after a worker crash. The command
// inherits the ownership lock, so it keeps the worktree claimed until it and its children are gone.
func runGuard(arguments []string) int {
	if len(arguments) == 0 {
		fmt.Fprintln(os.Stderr, "guard needs a command")
		return 2
	}
	// The guard must outlive the SIGTERM it sends to its own group so it can escalate. Catching the signal
	// does that; ignoring it would be inherited by the command, which then could not be stopped gracefully.
	signal.Notify(make(chan os.Signal, 1), syscall.SIGTERM)
	command := exec.Command(arguments[0], arguments[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.ExtraFiles = []*os.File{os.NewFile(guardOwnerFD, "worktree-owner")}
	if err := command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "guard could not start the command:", err)
		return 127
	}
	go func() {
		_, _ = io.Copy(io.Discard, os.NewFile(guardLivenessFD, "worker-liveness"))
		_ = syscall.Kill(0, syscall.SIGTERM)
		time.Sleep(cliTerminationGrace)
		_ = syscall.Kill(0, syscall.SIGKILL)
	}()
	err := command.Wait()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit) && exit.ExitCode() >= 0:
		return exit.ExitCode()
	default:
		return 1
	}
}

// ownProcessGroup makes cancellation stop a command together with everything it started: the group gets
// SIGTERM, then the command is killed after a grace period.
func ownProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGTERM) }
	command.WaitDelay = cliTerminationGrace
}
