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
	maxOwnerRecord    = 64 << 10
	// The guard command finds the worker-liveness pipe, the ownership lock, and the process record here.
	guardLivenessFD = 3
	guardLockFD     = 4
	guardRecordFD   = 5
	// guardStopGrace is how long the guard lets a command exit after the worker asked it to stop. It is
	// shorter than cliTerminationGrace so the guard acts before the worker kills the guard itself.
	guardStopGrace = cliTerminationGrace - 2*time.Second
)

var errWorktreeStillOwned = errors.New("processes from an earlier attempt still hold the run worktree")

// worktreeOwner is the exclusive claim one attempt holds on a run worktree, and the only way to start a
// process there. The claim is an advisory lock on a file beside the worktree. Every process started
// through the owner inherits the locked descriptor, so the lock stays held for as long as any of them
// lives, even after the worker that started them is gone. A second file records the processes the
// attempt started, so the next attempt can stop the ones that survived. Started processes never get
// the record file: an agent that could write it could name processes for the next attempt to kill.
type worktreeOwner struct {
	lock   *os.File
	record *os.File
	// guard is the command prefix that stops a process when this worker dies; empty runs it unguarded.
	guard []string
	// tookOver reports that leftover processes of an earlier attempt had to be stopped first.
	tookOver bool
}

// ownerRecord is what the ownership file says about the processes of the attempt that last wrote it:
// the process group of the guard, and every descendant the guard saw.
type ownerRecord struct {
	group   int
	members []processIdentity
}

func readOwnerRecord(file *os.File) ownerRecord {
	data := make([]byte, maxOwnerRecord)
	count, _ := file.ReadAt(data, 0)
	lines := strings.Split(string(data[:count]), "\n")
	var record ownerRecord
	record.group, _ = strconv.Atoi(strings.TrimSpace(lines[0]))
	for _, line := range lines[1:] {
		pid, started, found := strings.Cut(line, "\t")
		if number, err := strconv.Atoi(pid); found && err == nil && number > 1 {
			record.members = append(record.members, processIdentity{pid: number, started: started})
		}
	}
	return record
}

func writeOwnerRecord(file *os.File, record ownerRecord) error {
	var content strings.Builder
	content.WriteString(strconv.Itoa(record.group) + "\n")
	for _, member := range record.members {
		content.WriteString(strconv.Itoa(member.pid) + "\t" + member.started + "\n")
	}
	if content.Len() > maxOwnerRecord {
		return errors.New("worktree ownership record is too large")
	}
	if err := file.Truncate(0); err != nil {
		return err
	}
	_, err := file.WriteAt([]byte(content.String()), 0)
	return err
}

// acquireWorktree claims the worktree for this attempt. Processes an earlier attempt left behind are
// stopped first: its recorded process group, and every recorded descendant that left that group. If
// something still holds the claim after that, the attempt fails instead of running beside it.
func acquireWorktree(ctx context.Context, worktree string, guard []string) (*worktreeOwner, error) {
	lock, err := os.OpenFile(worktree+".owner", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open worktree ownership lock: %w", err)
	}
	recordFile, err := os.OpenFile(worktree+".owner.processes", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		lock.Close()
		return nil, fmt.Errorf("open worktree process record: %w", err)
	}
	owner := &worktreeOwner{lock: lock, record: recordFile, guard: guard}
	record := readOwnerRecord(recordFile)
	locked := owner.tryLock()
	if !locked && record.group > 1 {
		// ponytail: the lock proves a descendant lives, not that the group id is still its group; if every
		// group member is gone and only a descendant outside the group holds the lock, the id could have
		// been reused. Replace with cgroups or a job object if that ever shows up.
		_ = syscall.Kill(-record.group, syscall.SIGKILL)
	}
	survivors := killProcesses(record.members)
	owner.tookOver = !locked || survivors > 0
	deadline := time.NewTimer(ownerTakeoverWait)
	defer deadline.Stop()
	ticker := time.NewTicker(ownerPollInterval)
	defer ticker.Stop()
	for !locked || survivors > 0 {
		select {
		case <-ctx.Done():
			owner.release()
			return nil, ctx.Err()
		case <-deadline.C:
			owner.release()
			return nil, errWorktreeStillOwned
		case <-ticker.C:
			locked = locked || owner.tryLock()
			survivors = killProcesses(record.members)
		}
	}
	if err := writeOwnerRecord(recordFile, ownerRecord{}); err != nil {
		owner.release()
		return nil, fmt.Errorf("clear worktree ownership record: %w", err)
	}
	return owner, nil
}

func (owner *worktreeOwner) tryLock() bool {
	return syscall.Flock(int(owner.lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}

// release drops this worker's hold. The lock itself stays held while a started process still lives.
func (owner *worktreeOwner) release() {
	_ = owner.lock.Close()
	_ = owner.record.Close()
}

// command builds a process that runs in its own process group under the guard.
func (owner *worktreeOwner) command(ctx context.Context, arguments []string) *exec.Cmd {
	arguments = append(append([]string{}, owner.guard...), arguments...)
	process := exec.CommandContext(ctx, arguments[0], arguments[1:]...)
	ownProcessGroup(process)
	if len(owner.guard) > 0 {
		// Only the guard is told to stop. It looks at the process table once more while the command's
		// children still have their parent, and then stops the group itself.
		process.Cancel = func() error { return syscall.Kill(process.Process.Pid, syscall.SIGTERM) }
	}
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
		process.ExtraFiles = []*os.File{reader, owner.lock, owner.record}
	}
	if err := process.Start(); err != nil {
		closeAll()
		return nil, err
	}
	// The process is the leader of its own group, so its pid is the group id.
	if err := writeOwnerRecord(owner.record, ownerRecord{group: process.Process.Pid}); err != nil {
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

// runGuard is the `guard` command. It runs one command, remembers every process that command starts,
// and stops them all when the command exits, when the worker asks the group to stop, or when the
// liveness descriptor reaches end-of-file because the worker that started it no longer exists. Without
// it a provider, or a test it started in a session of its own, would keep editing the worktree after a
// cancellation or a worker crash. The command inherits the ownership lock and nothing else; the guard
// keeps the process record current for the next attempt.
func runGuard(arguments []string) int {
	if len(arguments) == 0 {
		fmt.Fprintln(os.Stderr, "guard needs a command")
		return 2
	}
	// The guard must outlive the SIGTERM sent to its group so it can escalate. Catching the signal does
	// that; ignoring it would be inherited by the command, which then could not be stopped gracefully.
	stopRequested := make(chan os.Signal, 1)
	signal.Notify(stopRequested, syscall.SIGTERM)
	recordFile := os.NewFile(guardRecordFD, "worktree-processes")
	// Inherited descriptors are not close-on-exec; the command must get neither of these.
	syscall.CloseOnExec(guardLivenessFD)
	syscall.CloseOnExec(guardRecordFD)
	command := exec.Command(arguments[0], arguments[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.ExtraFiles = []*os.File{os.NewFile(guardLockFD, "worktree-owner")}
	if err := command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "guard could not start the command:", err)
		return 127
	}
	tree := newProcessTree(os.Getpid())
	exited, workerGone := make(chan struct{}), make(chan struct{})
	var waitErr error
	go func() {
		waitErr = command.Wait()
		close(exited)
	}()
	go func() {
		_, _ = io.Copy(io.Discard, os.NewFile(guardLivenessFD, "worker-liveness"))
		close(workerGone)
	}()
	go recordProcessTree(tree, recordFile, exited)
	select {
	case <-exited:
	case <-stopRequested:
		_, _ = tree.refresh()
		_ = syscall.Kill(0, syscall.SIGTERM)
		waitUpTo(exited, guardStopGrace)
	case <-workerGone:
		_, _ = tree.refresh()
		_ = syscall.Kill(0, syscall.SIGTERM)
		waitUpTo(exited, cliTerminationGrace)
	}
	tree.stop()
	select {
	case <-exited:
	default:
		_ = syscall.Kill(0, syscall.SIGKILL)
		return 1
	}
	var exit *exec.ExitError
	switch {
	case waitErr == nil:
		return 0
	case errors.As(waitErr, &exit) && exit.ExitCode() >= 0:
		return exit.ExitCode()
	default:
		return 1
	}
}

// recordProcessTree keeps the recorded list of descendants current until the command exits.
func recordProcessTree(tree *processTree, recordFile *os.File, exited <-chan struct{}) {
	ticker := time.NewTicker(processTreeInterval)
	defer ticker.Stop()
	for {
		if changed, err := tree.refresh(); err == nil && changed {
			_ = writeOwnerRecord(recordFile, ownerRecord{group: os.Getpid(), members: tree.identities()})
		}
		select {
		case <-exited:
			return
		case <-ticker.C:
		}
	}
}

func waitUpTo(done <-chan struct{}, limit time.Duration) {
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

// ownProcessGroup makes cancellation stop a command together with everything it started: the group gets
// SIGTERM, then the command is killed after a grace period.
func ownProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGTERM) }
	command.WaitDelay = cliTerminationGrace
}
