package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// defaultModel leaves model selection to the CLI's own configuration.
const defaultModel = "default"

func newCLIProviders() map[string]*cliProvider {
	return map[string]*cliProvider{
		workerapi.ProviderCodex: {
			id: workerapi.ProviderCodex, binary: "codex", versionArgs: []string{"--version"},
			readyArgs: []string{"login", "status"},
			isReady:   func(_ []byte, err error) bool { return err == nil },
			args:      codexArguments, parse: func(line []byte) []cliEvent { return []cliEvent{parseCodexEvent(line)} },
			// Codex always runs model commands, so it is ready only where its sandbox is proven to hold.
			confinement: verifyCodexConfinement,
		},
		workerapi.ProviderClaude: {
			id: workerapi.ProviderClaude, binary: "claude", versionArgs: []string{"--version"},
			readyArgs: []string{"auth", "status"},
			isReady: func(output []byte, err error) bool {
				var status struct {
					LoggedIn bool `json:"loggedIn"`
				}
				return err == nil && json.Unmarshal(output, &status) == nil && status.LoggedIn
			},
			args: claudeArguments, parse: parseClaudeEvent, commandSandbox: claudeSandboxAvailable,
		},
	}
}

// modelPattern keeps a control-plane-supplied model name from being read as a CLI option.
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,199}$`)

func canWrite(command workerapi.AgentRunCommand) bool {
	return slices.Contains(command.Profile.Tools, "code.write")
}

// codexArguments uses `codex exec` with JSONL events. The prompt arrives on stdin. Model-run commands
// are confined by a Codex permission profile instead of the stock workspace-write mode, because that
// mode confines writes only: the profile also makes the workspace's deny paths unreadable apart from
// the worktree and the listed read paths. Network access stays off, as in the stock mode.
func codexArguments(command workerapi.AgentRunCommand, workspace runWorkspace) []string {
	args := []string{"exec", "--json", "--color", "never", "-c", `default_permissions="zenchron"`,
		"-c", "permissions.zenchron.filesystem=" + codexFilesystemProfile(workspace, canWrite(command)), "--cd", workspace.path}
	if command.Profile.Model != defaultModel {
		args = append(args, "--model="+command.Profile.Model)
	}
	return append(args, "-")
}

// codexFilesystemProfile is a TOML inline table of path = access. More specific paths win in Codex, so
// the worktree and read paths stay usable inside a denied directory.
func codexFilesystemProfile(workspace runWorkspace, writable bool) string {
	access := "read"
	if writable {
		access = "write"
	}
	entries := []string{`"/"="read"`, strconv.Quote(os.TempDir()) + `="write"`}
	for _, path := range workspace.denyPaths {
		entries = append(entries, strconv.Quote(path)+`="none"`)
	}
	entries = append(entries, strconv.Quote(workspace.path)+"="+strconv.Quote(access))
	for _, path := range workspace.readPaths {
		entries = append(entries, strconv.Quote(path)+`="read"`)
	}
	return "{" + strings.Join(entries, ",") + "}"
}

func parseCodexEvent(line []byte) cliEvent {
	var event struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
		Usage *struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
		Item struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			Text     string `json:"text"`
			Command  string `json:"command"`
			ExitCode *int   `json:"exit_code"`
			Changes  []struct {
				Path string `json:"path"`
				Kind string `json:"kind"`
			} `json:"changes"`
		} `json:"item"`
	}
	if json.Unmarshal(line, &event) != nil {
		return cliEvent{}
	}
	switch event.Type {
	case "turn.completed":
		if event.Usage == nil {
			return cliEvent{}
		}
		usage := &workerapi.Usage{InputTokens: event.Usage.InputTokens, OutputTokens: event.Usage.OutputTokens}
		return cliEvent{usage: usage, kind: "usage",
			message: fmt.Sprintf("%d input tokens, %d output tokens", usage.InputTokens, usage.OutputTokens)}
	case "turn.failed":
		return cliEvent{kind: "error", message: event.Error.Message, failure: nonEmpty(event.Error.Message, "turn failed")}
	case "error":
		return cliEvent{kind: "error", message: event.Message, failure: nonEmpty(event.Message, "provider error")}
	case "item.started":
		if event.Item.Type == "command_execution" {
			return cliEvent{kind: "tool", message: "$ " + event.Item.Command, toolStarted: event.Item.ID}
		}
		return cliEvent{toolStarted: event.Item.ID}
	case "item.completed":
		return codexCompletedItem(event.Item.ID, event.Item.Type, event.Item.Text, event.Item.Command, event.Item.ExitCode,
			len(event.Item.Changes))
	}
	return cliEvent{}
}

func codexCompletedItem(id, itemType, text, command string, exitCode *int, changes int) cliEvent {
	switch itemType {
	case "agent_message":
		return cliEvent{kind: "message", message: text, output: text, toolFinished: id}
	case "command_execution":
		status := "finished"
		if exitCode != nil {
			status = fmt.Sprintf("exit %d", *exitCode)
		}
		return cliEvent{kind: "tool", message: status + ": " + command, toolFinished: id}
	case "file_change":
		return cliEvent{kind: "tool", message: fmt.Sprintf("changed %d file(s)", changes), toolFinished: id}
	case "reasoning":
		return cliEvent{toolFinished: id}
	}
	return cliEvent{kind: "tool", message: itemType, toolFinished: id}
}

// claudeArguments uses print mode with stream-json events. The prompt arrives on stdin. User settings and
// MCP servers are not loaded, which keeps personal plugins and connectors out of runs, and hooks are
// disabled for every profile: a project hook is a script in the worktree that would run outside any sandbox,
// and a writing agent could change it first. Profiles get file tools only, unless they may run tests on a
// machine that has the sandbox backend: then Bash is offered, but only inside Claude Code's own sandbox.
func claudeArguments(command workerapi.AgentRunCommand, workspace runWorkspace) []string {
	tools, mode := "Read,Glob,Grep", "default"
	if canWrite(command) {
		tools, mode = "Read,Edit,Write,Glob,Grep", "acceptEdits"
	}
	sandboxed := workspace.commandSandbox && canWrite(command) && slices.Contains(command.Profile.Tools, "tests.run")
	if sandboxed {
		tools += ",Bash"
	}
	args := []string{"--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
		"--setting-sources", "project", "--strict-mcp-config", "--settings", claudeSettings(workspace, sandboxed),
		"--permission-mode", mode, "--tools", tools}
	if command.Profile.Model != defaultModel {
		args = append(args, "--model="+command.Profile.Model)
	}
	return args
}

// claudeSandboxFallback enables the sandbox and nothing else. It is used only if the full settings
// cannot be encoded, so a run never starts with a shell and without a sandbox.
const claudeSandboxFallback = `{"disableAllHooks":true,"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false}}`

// claudeSettings disables hooks for every run. With sandboxed set it also confines every shell command:
// Claude Code refuses to start when the sandbox cannot be set up, commands that cannot be sandboxed are
// refused, writes are limited to the worktree and the temporary directory, and the workspace's deny
// paths cannot be read apart from the worktree and the read paths.
func claudeSettings(workspace runWorkspace, sandboxed bool) string {
	if !sandboxed {
		return `{"disableAllHooks":true}`
	}
	type filesystem struct {
		DenyRead   []string `json:"denyRead,omitempty"`
		AllowRead  []string `json:"allowRead"`
		AllowWrite []string `json:"allowWrite"`
		DenyWrite  []string `json:"denyWrite,omitempty"`
	}
	type sandbox struct {
		Enabled bool `json:"enabled"`
		// Without this Claude Code runs the shell unconfined when the sandbox backend is missing.
		FailIfUnavailable        bool       `json:"failIfUnavailable"`
		AutoAllowBashIfSandboxed bool       `json:"autoAllowBashIfSandboxed"`
		AllowUnsandboxedCommands bool       `json:"allowUnsandboxedCommands"`
		Filesystem               filesystem `json:"filesystem"`
	}
	rules := filesystem{DenyRead: workspace.denyPaths, AllowRead: append([]string{workspace.path}, workspace.readPaths...),
		AllowWrite: []string{os.TempDir()}}
	// A denied location inside the writable temporary directory would otherwise stay writable. Claude
	// Code lets a write denial win over the worktree nested in it, so locations that contain the
	// worktree cannot be listed.
	// ponytail: with ZENCHRON_WORKTREES_ROOT inside the temporary directory, a Claude Code shell can write
	// (not read) other runs' worktrees; keep the root elsewhere, as the default is.
	for _, path := range workspace.denyPaths {
		if !strings.HasPrefix(workspace.path+string(filepath.Separator), path+string(filepath.Separator)) {
			rules.DenyWrite = append(rules.DenyWrite, path)
		}
	}
	settings, err := json.Marshal(struct {
		DisableAllHooks bool    `json:"disableAllHooks"`
		Sandbox         sandbox `json:"sandbox"`
	}{true, sandbox{Enabled: true, FailIfUnavailable: true, AutoAllowBashIfSandboxed: true, Filesystem: rules}})
	if err != nil {
		return claudeSandboxFallback
	}
	return string(settings)
}

// parseClaudeEvent returns one event per content block: a message can carry text and then start several tools,
// and a tool start that is dropped would leave a long tool run to the shorter inactivity limit.
func parseClaudeEvent(line []byte) []cliEvent {
	var event struct {
		Type    string   `json:"type"`
		Subtype string   `json:"subtype"`
		Model   string   `json:"model"`
		IsError bool     `json:"is_error"`
		Result  string   `json:"result"`
		Cost    *float64 `json:"total_cost_usd"`
		Usage   struct {
			Input         int64 `json:"input_tokens"`
			CacheCreation int64 `json:"cache_creation_input_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			Output        int64 `json:"output_tokens"`
		} `json:"usage"`
		Message struct {
			Content []struct {
				Type      string `json:"type"`
				Text      string `json:"text"`
				ID        string `json:"id"`
				Name      string `json:"name"`
				ToolUseID string `json:"tool_use_id"`
				Input     struct {
					FilePath string `json:"file_path"`
					Pattern  string `json:"pattern"`
					Command  string `json:"command"`
				} `json:"input"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &event) != nil {
		return nil
	}
	switch event.Type {
	case "system":
		if event.Subtype == "init" {
			return []cliEvent{{kind: "status", message: "session started with model " + event.Model}}
		}
	case "result":
		usage := &workerapi.Usage{InputTokens: event.Usage.Input + event.Usage.CacheCreation + event.Usage.CacheRead,
			OutputTokens: event.Usage.Output, CostUSD: event.Cost}
		result := cliEvent{usage: usage, kind: "usage",
			message: fmt.Sprintf("%d input tokens, %d output tokens", usage.InputTokens, usage.OutputTokens)}
		if event.IsError || event.Subtype != "success" {
			result.failure = nonEmpty(event.Result, event.Subtype)
			return []cliEvent{result}
		}
		result.output = event.Result
		return []cliEvent{result}
	case "assistant", "user":
		var events []cliEvent
		for _, block := range event.Message.Content {
			switch block.Type {
			case "text":
				events = append(events, cliEvent{kind: "message", message: block.Text})
			case "tool_use":
				target := nonEmpty(block.Input.Pattern, block.Input.Command)
				if block.Input.FilePath != "" {
					target = filepath.Base(block.Input.FilePath)
				}
				events = append(events, cliEvent{kind: "tool", message: strings.TrimSpace(block.Name + " " + target), toolStarted: block.ID})
			case "tool_result":
				events = append(events, cliEvent{toolFinished: block.ToolUseID})
			}
		}
		return events
	}
	return nil
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
