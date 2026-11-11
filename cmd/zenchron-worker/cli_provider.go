package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	maxCLILineSize       = 1 << 20
	cliDetectionTimeout  = 15 * time.Second
	cliTerminationGrace  = 10 * time.Second
	cliWatchdogInterval  = time.Second
	maxProviderVersion   = 100
	cliOperatingContract = "Work only inside the current directory. Do not commit, push, or switch branches; " +
		"Zenchron commits and publishes the result. Keep tool caches in the system temporary directory, and remove " +
		"caches, build outputs, and temporary files you created; " +
		"only intended source changes may remain. Finish with a short summary of what changed and how it was checked."
)

// cliProvider adapts one installed coding CLI to the run lifecycle. The adapters differ only in the
// arguments they need and the event lines they print; process ownership and limits are shared.
// ponytail: process groups are POSIX-only; add a Windows job-object variant if Windows workers are needed.
type cliProvider struct {
	id          string
	binary      string
	versionArgs []string
	readyArgs   []string
	isReady     func(output []byte, err error) bool
	args        func(command workerapi.AgentRunCommand, workspace runWorkspace) []string
	// guard, when set, is a command prefix that runs the provider under a process that stops it if the
	// worker dies. It is this worker binary's own `guard` command.
	guard []string
	parse func(line []byte) cliEvent

	path    string
	version string
	ready   bool
}

// cliEvent is one provider output line normalized to what the run lifecycle understands.
type cliEvent struct {
	kind         string
	message      string
	toolStarted  string
	toolFinished string
	output       string
	failure      string
	usage        *workerapi.Usage
}

// runWorkspace is where one attempt executes and what its processes may see beyond it.
type runWorkspace struct {
	path        string
	environment []string
	// readPaths are extra locations a sandboxed provider may read: the repository's Git metadata and
	// whatever the operator listed, such as a dependency cache.
	readPaths []string
}

type executionResult struct {
	output string
	reason string
	usage  *workerapi.Usage
}

func (provider *cliProvider) detect(ctx context.Context) {
	provider.path, provider.version, provider.ready = "", "", false
	path, err := exec.LookPath(provider.binary)
	if err != nil {
		return
	}
	provider.path = path
	if output, err := provider.probe(ctx, provider.versionArgs); err == nil {
		line, _, _ := strings.Cut(strings.TrimSpace(string(output)), "\n")
		provider.version = truncateText(strings.TrimSpace(line), maxProviderVersion)
	}
	output, err := provider.probe(ctx, provider.readyArgs)
	provider.ready = provider.isReady(output, err)
}

func (provider *cliProvider) probe(ctx context.Context, args []string) ([]byte, error) {
	probeCtx, cancel := context.WithTimeout(ctx, cliDetectionTimeout)
	defer cancel()
	command := exec.CommandContext(probeCtx, provider.path, args...)
	command.Env = providerEnvironment(os.Environ())
	return command.CombinedOutput()
}

func (provider *cliProvider) status() workerapi.ProviderStatus {
	return workerapi.ProviderStatus{ID: provider.id, Version: provider.version, Ready: provider.ready}
}

// providerEnvironment keeps worker and GitHub credentials away from the agent and removes provider API
// keys so a subscription-authenticated CLI is never silently switched to paid API billing.
func providerEnvironment(environment []string) []string {
	blocked := []string{"GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"}
	return slices.DeleteFunc(slices.Clone(environment), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		return strings.HasPrefix(name, "ZENCHRON_") || slices.Contains(blocked, name)
	})
}

func cliPrompt(command workerapi.AgentRunCommand) string {
	var prompt strings.Builder
	if system := strings.TrimSpace(command.Profile.SystemPrompt); system != "" {
		prompt.WriteString(system + "\n\n")
	}
	if goal := strings.TrimSpace(command.Profile.GoalPrompt); goal != "" {
		prompt.WriteString("Goal: " + goal + "\n\n")
	}
	prompt.WriteString(command.Prompt + "\n\n" + cliOperatingContract + "\n")
	return prompt.String()
}

func (provider *cliProvider) execute(
	ctx context.Context, command workerapi.AgentRunCommand, workspace runWorkspace, limits runLimits,
	emit func(kind, message string),
) (executionResult, error) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	arguments := append(slices.Clone(provider.guard), provider.path)
	arguments = append(arguments, provider.args(command, workspace)...)
	process := exec.CommandContext(runCtx, arguments[0], arguments[1:]...)
	process.Dir = workspace.path
	// The agent must not depend on, or be able to read, the user's personal Git configuration.
	process.Env = append([]string{"GIT_CONFIG_GLOBAL=" + os.DevNull}, workspace.environment...)
	process.Stdin = strings.NewReader(cliPrompt(command))
	ownProcessGroup(process)
	if len(provider.guard) > 0 {
		// The guard watches the read end of this pipe. The worker never writes to it, so the guard sees
		// end-of-file exactly when the worker process is gone, however it died.
		reader, writer, err := os.Pipe()
		if err != nil {
			return executionResult{reason: workerapi.TerminationWorkerError}, fmt.Errorf("create provider guard pipe: %w", err)
		}
		defer writer.Close()
		defer reader.Close()
		process.ExtraFiles = []*os.File{reader}
	}
	session := &cliSession{parse: provider.parse, emit: emit, lastActivity: time.Now(), openTools: map[string]bool{}}
	stderr := &tailBuffer{limit: 2048}
	process.Stdout, process.Stderr = &lineWriter{handle: session.handle}, stderr
	if err := process.Start(); err != nil {
		return executionResult{reason: workerapi.TerminationWorkerError}, fmt.Errorf("start %s: %w", provider.id, err)
	}
	emit("status", fmt.Sprintf("%s %s started", provider.id, provider.version))
	stopWatchdog := session.watch(runCtx, limits, cancel)
	waitErr := process.Wait()
	stopWatchdog()
	// Sweep anything the provider left behind in its process group.
	_ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL)
	return session.result(ctx, waitErr, stderr.String())
}

// runGuard is the `guard` command: it runs a provider and stops the whole process group when file
// descriptor 3 reaches end-of-file, which happens when the worker that started it no longer exists.
// Without it a provider would keep editing the worktree after a worker crash while the next attempt
// starts a second provider there.
func runGuard(arguments []string) int {
	if len(arguments) == 0 {
		fmt.Fprintln(os.Stderr, "guard needs a command")
		return 2
	}
	// The guard must outlive the SIGTERM it sends to its own group so it can escalate.
	signal.Ignore(syscall.SIGTERM)
	command := exec.Command(arguments[0], arguments[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "guard could not start the command:", err)
		return 127
	}
	go func() {
		_, _ = io.Copy(io.Discard, os.NewFile(3, "worker-liveness"))
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

// cliSession tracks one provider process: its normalized result and how recently it showed activity.
type cliSession struct {
	parse func(line []byte) cliEvent
	emit  func(kind, message string)

	mu           sync.Mutex
	lastActivity time.Time
	openTools    map[string]bool
	output       string
	failure      string
	usage        *workerapi.Usage
	timeout      string
}

func (session *cliSession) handle(line []byte) {
	event := session.parse(line)
	session.mu.Lock()
	session.lastActivity = time.Now()
	if event.toolStarted != "" {
		session.openTools[event.toolStarted] = true
	}
	delete(session.openTools, event.toolFinished)
	if event.output != "" {
		session.output = event.output
	}
	if event.failure != "" {
		session.failure = event.failure
	}
	if event.usage != nil {
		session.usage = event.usage
	}
	session.mu.Unlock()
	if event.kind != "" && event.message != "" {
		session.emit(event.kind, event.message)
	}
}

// watch stops a silent provider. A provider waiting on its own running tool gets the longer tool limit:
// a long test run is activity, not idleness.
func (session *cliSession) watch(ctx context.Context, limits runLimits, cancel context.CancelFunc) func() {
	watchCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(cliWatchdogInterval)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
			}
			session.mu.Lock()
			limit, reason := limits.inactivity, workerapi.TerminationInactivity
			if len(session.openTools) > 0 {
				limit, reason = limits.toolActivity, workerapi.TerminationToolTimeout
			}
			expired := time.Since(session.lastActivity) > limit
			if expired {
				session.timeout = reason
			}
			session.mu.Unlock()
			if expired {
				cancel()
				return
			}
		}
	}()
	return func() {
		stop()
		<-done
	}
}

func (session *cliSession) result(ctx context.Context, waitErr error, stderr string) (executionResult, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	result := executionResult{output: session.output, usage: session.usage, reason: workerapi.TerminationCompleted}
	switch {
	case session.timeout != "":
		result.reason = session.timeout
		return result, fmt.Errorf("provider stopped after %s", session.timeout)
	case ctx.Err() != nil:
		result.reason = workerapi.TerminationCancelled
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			result.reason = workerapi.TerminationWallClock
		}
		return result, ctx.Err()
	case session.failure != "":
		result.reason = workerapi.TerminationProviderExit
		return result, fmt.Errorf("provider reported failure: %s", session.failure)
	case waitErr != nil:
		result.reason = workerapi.TerminationProviderExit
		return result, fmt.Errorf("provider exited: %w: %s", waitErr, stderr)
	case strings.TrimSpace(session.output) == "":
		result.reason = workerapi.TerminationProviderExit
		return result, errors.New("provider finished without a final message")
	}
	return result, nil
}

// lineWriter hands complete output lines to handle. Oversized lines are dropped, not buffered.
type lineWriter struct {
	handle   func(line []byte)
	buffer   []byte
	overflow bool
}

func (writer *lineWriter) Write(data []byte) (int, error) {
	written := len(data)
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			writer.append(data)
			break
		}
		writer.append(data[:end])
		if !writer.overflow && len(bytes.TrimSpace(writer.buffer)) > 0 {
			writer.handle(writer.buffer)
		}
		writer.buffer, writer.overflow = writer.buffer[:0], false
		data = data[end+1:]
	}
	return written, nil
}

func (writer *lineWriter) append(data []byte) {
	if writer.overflow || len(writer.buffer)+len(data) > maxCLILineSize {
		writer.buffer, writer.overflow = writer.buffer[:0], true
		return
	}
	writer.buffer = append(writer.buffer, data...)
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	limit int
	data  []byte
}

func (buffer *tailBuffer) Write(data []byte) (int, error) {
	buffer.data = append(buffer.data, data...)
	if len(buffer.data) > buffer.limit {
		buffer.data = buffer.data[len(buffer.data)-buffer.limit:]
	}
	return len(data), nil
}

func (buffer *tailBuffer) String() string { return strings.ToValidUTF8(string(buffer.data), "") }

func truncateText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return strings.ToValidUTF8(value[:limit], "")
}
