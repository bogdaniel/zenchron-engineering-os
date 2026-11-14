package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	processTreeInterval = 500 * time.Millisecond
	processListTimeout  = 3 * time.Second
	// processStartTolerance absorbs the one-second jitter some ps versions show when they derive a start
	// time from the system uptime. A pid cannot be reused by a process started that close to the old one.
	processStartTolerance = 2 * time.Second
	processStartLayout    = "Mon Jan _2 15:04:05 2006"
)

// processIdentity names one process. A pid alone can be reused by an unrelated process; together
// with the start time it cannot.
type processIdentity struct {
	pid     int
	started time.Time
}

func (identity processIdentity) matches(entry processEntry) bool {
	difference := identity.started.Sub(entry.started)
	return difference >= -processStartTolerance && difference <= processStartTolerance
}

// processTree remembers every process descended from a root, including those that leave the root's
// process group or outlive their parent. Codex starts each tool command as its own session, so
// signalling the provider's process group does not reach a running test or server it started.
// ponytail: descendants are found by polling the process table, so one that is started and detaches
// from an already finished parent between two polls is missed. Use cgroups on Linux, or a kernel
// process-lifecycle feed, if that window matters.
type processTree struct {
	root int

	mu      sync.Mutex
	members map[int]time.Time
}

func newProcessTree(root int) *processTree {
	return &processTree{root: root, members: map[int]time.Time{}}
}

type processEntry struct {
	parent  int
	started time.Time
}

// listProcesses reads the process table with ps, which prints these columns on macOS and Linux. The
// locale and time zone are fixed so that two listings made in different environments agree on a start
// time. Zombies are left out: they hold no files and run no code.
func listProcesses() (map[int]processEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), processListTimeout)
	defer cancel()
	var output bytes.Buffer
	list := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,stat=,lstart=")
	list.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
	list.Stdout = &output
	if err := list.Start(); err != nil {
		return nil, fmt.Errorf("list processes: %w", err)
	}
	self := list.Process.Pid
	if err := list.Wait(); err != nil {
		return nil, fmt.Errorf("list processes: %w", err)
	}
	processes := map[int]processEntry{}
	for _, line := range strings.Split(output.String(), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		parent, parentErr := strconv.Atoi(fields[1])
		started, startErr := time.Parse(processStartLayout, strings.Join(fields[3:8], " "))
		// The listing command is itself a child of the caller and is gone by now.
		if pidErr != nil || parentErr != nil || startErr != nil || pid == self || strings.HasPrefix(fields[2], "Z") {
			continue
		}
		processes[pid] = processEntry{parent: parent, started: started}
	}
	if len(processes) == 0 {
		return nil, fmt.Errorf("list processes: ps printed no process in the expected format")
	}
	return processes, nil
}

// refresh adds newly started descendants and forgets members that no longer exist. It reports whether
// the membership changed.
func (tree *processTree) refresh() (bool, error) {
	processes, err := listProcesses()
	if err != nil {
		return false, err
	}
	tree.mu.Lock()
	defer tree.mu.Unlock()
	changed := false
	for pid, started := range tree.members {
		if entry, alive := processes[pid]; !alive || !(processIdentity{pid, started}).matches(entry) {
			delete(tree.members, pid)
			changed = true
		}
	}
	// A child can be listed before its parent, so repeat until a pass adds nothing.
	for added := true; added; {
		added = false
		for pid, entry := range processes {
			_, known := tree.members[pid]
			_, parentKnown := tree.members[entry.parent]
			if known || pid == tree.root || (entry.parent != tree.root && !parentKnown) {
				continue
			}
			tree.members[pid] = entry.started
			added, changed = true, true
		}
	}
	return changed, nil
}

func (tree *processTree) identities() []processIdentity {
	tree.mu.Lock()
	defer tree.mu.Unlock()
	identities := make([]processIdentity, 0, len(tree.members))
	for pid, started := range tree.members {
		identities = append(identities, processIdentity{pid: pid, started: started})
	}
	return identities
}

// stop kills every remembered descendant that is still the same process. If the process table cannot
// be read now, the members seen earlier are still signalled.
func (tree *processTree) stop() error {
	_, refreshErr := tree.refresh()
	if _, err := killProcesses(tree.identities()); err != nil {
		return err
	}
	return refreshErr
}

// killProcesses sends SIGKILL to each listed process that still exists with the recorded start time,
// and reports how many were still alive. An unreadable process table is an error, never "none alive".
func killProcesses(identities []processIdentity) (int, error) {
	if len(identities) == 0 {
		return 0, nil
	}
	processes, err := listProcesses()
	if err != nil {
		return 0, err
	}
	alive := 0
	for _, identity := range identities {
		if entry, exists := processes[identity.pid]; exists && identity.matches(entry) {
			alive++
			_ = syscall.Kill(identity.pid, syscall.SIGKILL)
		}
	}
	return alive, nil
}
