package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
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
	parse       func(line []byte) []cliEvent
	// confinement, when set, proves at detection time that the CLI's sandbox enforces the worker's
	// filesystem rules on this machine. A provider that fails it is not ready.
	confinement func(ctx context.Context, binary string) error
	// commandSandbox reports whether the provider's sandbox for repository commands exists on this
	// machine. Nil means the provider sandboxes every command and is ready only when that is proven.
	commandSandbox func() bool

	path    string
	version string
	ready   bool
	// reason says why an installed provider is not ready.
	reason string
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
	// denyPaths are locations a sandboxed provider must not read. The worktree and the read paths lie
	// inside them and stay readable because the more specific rule wins in both provider sandboxes.
	denyPaths []string
	// owner holds the attempt's exclusive claim on the worktree and starts every process in it.
	owner *worktreeOwner
	// commandSandbox is set by the provider: its sandbox for repository commands exists on this machine.
	commandSandbox bool
}

type executionResult struct {
	output string
	reason string
	usage  *workerapi.Usage
}

func (provider *cliProvider) detect(ctx context.Context) {
	provider.path, provider.version, provider.ready, provider.reason = "", "", false, ""
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
	if !provider.isReady(output, err) {
		provider.reason = "not signed in"
		return
	}
	if provider.confinement != nil {
		if err := provider.confinement(ctx, provider.path); err != nil {
			log.Printf("%s is not ready: %v", provider.id, err)
			provider.reason = "sandbox self-test failed"
			return
		}
	}
	provider.ready = true
}

func (provider *cliProvider) probe(ctx context.Context, args []string) ([]byte, error) {
	probeCtx, cancel := context.WithTimeout(ctx, cliDetectionTimeout)
	defer cancel()
	command := exec.CommandContext(probeCtx, provider.path, args...)
	command.Env = providerEnvironment(os.Environ())
	return command.CombinedOutput()
}

func (provider *cliProvider) status() workerapi.ProviderStatus {
	return workerapi.ProviderStatus{ID: provider.id, Version: provider.version, Ready: provider.ready,
		Reason: provider.reason, SandboxedCommands: provider.ready && provider.sandboxesCommands()}
}

func (provider *cliProvider) sandboxesCommands() bool {
	return provider.commandSandbox == nil || provider.commandSandbox()
}

// inheritedEnvironment names the only worker variables that provider and verification processes
// inherit: what a CLI and a build tool need to find programs, the user's directories, certificates and
// proxies. Everything else in the worker's environment, such as tokens and connection strings of the
// developer's shell, never reaches an agent, so it cannot end up in an event or a pull request.
// Operators add what a repository needs under `environment` in the worker configuration.
var inheritedEnvironment = []string{
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "TZ", "LANG", "LANGUAGE", "__CF_USER_TEXT_ENCODING",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
	"CODEX_HOME", "CLAUDE_CONFIG_DIR",
}

// providerEnvironment reduces the worker's environment to the inherited names. The worker's own Git
// push does not use this environment.
func providerEnvironment(environment []string) []string {
	return slices.DeleteFunc(slices.Clone(environment), func(entry string) bool {
		name, _, _ := strings.Cut(entry, "=")
		return !slices.Contains(inheritedEnvironment, name) && !strings.HasPrefix(name, "LC_")
	})
}

// reservedEnvironmentName reports names an operator may not set for a repository: worker and GitHub
// credentials, and provider API keys, which would silently switch a subscription-authenticated CLI to
// paid API billing.
func reservedEnvironmentName(name string) bool {
	reserved := []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "SSH_AUTH_SOCK"}
	return strings.HasPrefix(name, "ZENCHRON_") || slices.Contains(reserved, name)
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
	workspace.commandSandbox = provider.sandboxesCommands()
	process := workspace.owner.command(runCtx, append([]string{provider.path}, provider.args(command, workspace)...))
	process.Dir = workspace.path
	// The agent must not depend on, or be able to read, the user's personal Git configuration.
	process.Env = append([]string{"GIT_CONFIG_GLOBAL=" + os.DevNull}, workspace.environment...)
	process.Stdin = strings.NewReader(cliPrompt(command))
	session := &cliSession{parse: provider.parse, emit: emit, lastActivity: time.Now(), openTools: map[string]bool{}}
	stderr := &tailBuffer{limit: 2048}
	process.Stdout, process.Stderr = &lineWriter{handle: session.handle}, stderr
	sweep, err := workspace.owner.start(process)
	if err != nil {
		return executionResult{reason: workerapi.TerminationWorkerError}, fmt.Errorf("start %s: %w", provider.id, err)
	}
	emit("status", fmt.Sprintf("%s %s started", provider.id, provider.version))
	stopWatchdog := session.watch(runCtx, limits, cancel)
	waitErr := process.Wait()
	stopWatchdog()
	sweep()
	if errors.Is(waitErr, exec.ErrWaitDelay) && process.ProcessState.Success() {
		// The provider exited cleanly but something it started kept its output open; the sweep stopped it.
		waitErr = nil
	}
	return session.result(ctx, waitErr, stderr.String())
}

// cliSession tracks one provider process: its normalized result and how recently it showed activity.
type cliSession struct {
	parse func(line []byte) []cliEvent
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
	// One provider line can carry several events, for example a message followed by the tool it starts.
	events := session.parse(line)
	session.mu.Lock()
	session.lastActivity = time.Now()
	for _, event := range events {
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
	}
	session.mu.Unlock()
	for _, event := range events {
		if event.kind != "" && event.message != "" {
			session.emit(event.kind, event.message)
		}
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
