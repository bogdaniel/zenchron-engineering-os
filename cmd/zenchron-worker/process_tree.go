package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	processTreeInterval = 500 * time.Millisecond
	processListTimeout  = 5 * time.Second
)

// processIdentity names one process. A pid alone can be reused by an unrelated process; together
// with the start time it cannot.
type processIdentity struct {
	pid     int
	started string
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
	members map[int]string
}

func newProcessTree(root int) *processTree {
	return &processTree{root: root, members: map[int]string{}}
}

type processEntry struct {
	parent  int
	started string
}

// listProcesses reads the process table with ps, which prints the same columns on macOS and Linux.
func listProcesses() (map[int]processEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), processListTimeout)
	defer cancel()
	var output bytes.Buffer
	list := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,lstart=")
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
		if len(fields) < 3 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		parent, parentErr := strconv.Atoi(fields[1])
		// The listing command is itself a child of the caller and is gone by now.
		if pidErr != nil || parentErr != nil || pid == self {
			continue
		}
		processes[pid] = processEntry{parent: parent, started: strings.Join(fields[2:], " ")}
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
		if entry, alive := processes[pid]; !alive || entry.started != started {
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

// stop kills every remembered descendant that is still the same process.
func (tree *processTree) stop() {
	_, _ = tree.refresh()
	killProcesses(tree.identities())
}

// killProcesses sends SIGKILL to each listed process that still exists with the recorded start time,
// and reports how many it signalled.
func killProcesses(identities []processIdentity) int {
	if len(identities) == 0 {
		return 0
	}
	processes, err := listProcesses()
	if err != nil {
		return 0
	}
	killed := 0
	for _, identity := range identities {
		if entry, alive := processes[identity.pid]; alive && entry.started == identity.started {
			if syscall.Kill(identity.pid, syscall.SIGKILL) == nil {
				killed++
			}
		}
	}
	return killed
}
