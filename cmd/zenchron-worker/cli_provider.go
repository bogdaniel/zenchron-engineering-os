package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
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
		"Zenchron commits and publishes the result. Remove caches, build outputs, and temporary files you created; " +
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
	args        func(command workerapi.AgentRunCommand, worktree string) []string
	parse       func(line []byte) cliEvent

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
	ctx context.Context, command workerapi.AgentRunCommand, worktree string, limits runLimits,
	emit func(kind, message string),
) (executionResult, error) {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	process := exec.CommandContext(runCtx, provider.path, provider.args(command, worktree)...)
	process.Dir = worktree
	process.Env = providerEnvironment(os.Environ())
	process.Stdin = strings.NewReader(cliPrompt(command))
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	process.Cancel = func() error { return syscall.Kill(-process.Process.Pid, syscall.SIGTERM) }
	process.WaitDelay = cliTerminationGrace
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
