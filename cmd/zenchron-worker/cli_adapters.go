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
			args:      codexArguments, parse: parseCodexEvent,
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
			args: claudeArguments, parse: parseClaudeEvent,
		},
	}
}

// modelPattern keeps a control-plane-supplied model name from being read as a CLI option.
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,199}$`)

func canWrite(command workerapi.AgentRunCommand) bool {
	return slices.Contains(command.Profile.Tools, "code.write")
}

// sandboxRoots are the locations both provider sandboxes are built from.
func sandboxRoots() (home, temporary string) {
	home, err := os.UserHomeDir()
	if err != nil || home == "/" {
		home = ""
	}
	return home, os.TempDir()
}

// codexArguments uses `codex exec` with JSONL events. The prompt arrives on stdin. Model-run commands
// are confined by a Codex permission profile instead of the stock workspace-write mode, because that
// mode confines writes only: the profile also makes the home directory unreadable apart from the
// worktree and the listed read paths. Network access stays off, as in the stock mode.
func codexArguments(command workerapi.AgentRunCommand, workspace runWorkspace) []string {
	args := []string{"exec", "--json", "--color", "never", "-c", `default_permissions="zenchron"`,
		"-c", "permissions.zenchron.filesystem=" + codexFilesystemProfile(workspace, canWrite(command)), "--cd", workspace.path}
	if command.Profile.Model != defaultModel {
		args = append(args, "--model="+command.Profile.Model)
	}
	return append(args, "-")
}

// codexFilesystemProfile is a TOML inline table of path = access. More specific paths win in Codex, so
// the worktree and read paths stay usable inside a denied home directory.
func codexFilesystemProfile(workspace runWorkspace, writable bool) string {
	home, temporary := sandboxRoots()
	access := "read"
	if writable {
		access = "write"
	}
	entries := []string{`"/"="read"`}
	if home != "" {
		entries = append(entries, strconv.Quote(home)+`="none"`)
	}
	entries = append(entries, strconv.Quote(workspace.path)+"="+strconv.Quote(access), strconv.Quote(temporary)+`="write"`)
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
// MCP servers are not loaded, which keeps personal plugins and connectors out of runs. Profiles get file
// tools only, unless they may run tests: then Bash is offered, but only inside Claude Code's own sandbox.
func claudeArguments(command workerapi.AgentRunCommand, workspace runWorkspace) []string {
	tools, mode := "Read,Glob,Grep", "default"
	if canWrite(command) {
		tools, mode = "Read,Edit,Write,Glob,Grep", "acceptEdits"
	}
	args := []string{"--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
		"--setting-sources", "project", "--strict-mcp-config", "--permission-mode", mode}
	if canWrite(command) && slices.Contains(command.Profile.Tools, "tests.run") {
		tools += ",Bash"
		args = append(args, "--settings", claudeSandboxSettings(workspace))
	}
	args = append(args, "--tools", tools)
	if command.Profile.Model != defaultModel {
		args = append(args, "--model="+command.Profile.Model)
	}
	return args
}

// claudeSandboxSettings confines every shell command of a run: commands that cannot be sandboxed are
// refused, writes are limited to the worktree and the temporary directory, and the home directory cannot
// be read apart from the worktree itself.
func claudeSandboxSettings(workspace runWorkspace) string {
	type filesystem struct {
		DenyRead   []string `json:"denyRead,omitempty"`
		AllowRead  []string `json:"allowRead"`
		AllowWrite []string `json:"allowWrite"`
	}
	type sandbox struct {
		Enabled                  bool       `json:"enabled"`
		AutoAllowBashIfSandboxed bool       `json:"autoAllowBashIfSandboxed"`
		AllowUnsandboxedCommands bool       `json:"allowUnsandboxedCommands"`
		Filesystem               filesystem `json:"filesystem"`
	}
	home, temporary := sandboxRoots()
	rules := filesystem{AllowRead: append([]string{workspace.path}, workspace.readPaths...), AllowWrite: []string{temporary}}
	if home != "" {
		rules.DenyRead = []string{home}
	}
	settings, err := json.Marshal(struct {
		Sandbox sandbox `json:"sandbox"`
	}{sandbox{Enabled: true, AutoAllowBashIfSandboxed: true, Filesystem: rules}})
	if err != nil {
		// The value is built from strings only; if it cannot be encoded, give the CLI settings that enable
		// the sandbox and nothing else rather than running without one.
		return `{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}`
	}
	return string(settings)
}

func parseClaudeEvent(line []byte) cliEvent {
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
		return cliEvent{}
	}
	switch event.Type {
	case "system":
		if event.Subtype == "init" {
			return cliEvent{kind: "status", message: "session started with model " + event.Model}
		}
	case "result":
		usage := &workerapi.Usage{InputTokens: event.Usage.Input + event.Usage.CacheCreation + event.Usage.CacheRead,
			OutputTokens: event.Usage.Output, CostUSD: event.Cost}
		result := cliEvent{usage: usage, kind: "usage",
			message: fmt.Sprintf("%d input tokens, %d output tokens", usage.InputTokens, usage.OutputTokens)}
		if event.IsError || event.Subtype != "success" {
			result.failure = nonEmpty(event.Result, event.Subtype)
			return result
		}
		result.output = event.Result
		return result
	case "assistant", "user":
		for _, block := range event.Message.Content {
			switch block.Type {
			case "text":
				return cliEvent{kind: "message", message: block.Text}
			case "tool_use":
				target := nonEmpty(block.Input.Pattern, block.Input.Command)
				if block.Input.FilePath != "" {
					target = filepath.Base(block.Input.FilePath)
				}
				return cliEvent{kind: "tool", message: strings.TrimSpace(block.Name + " " + target), toolStarted: block.ID}
			case "tool_result":
				return cliEvent{toolFinished: block.ToolUseID}
			}
		}
	}
	return cliEvent{}
}

func nonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
