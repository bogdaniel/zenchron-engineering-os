// Package workerapi is the single home of the wire contract between the control plane and local workers.
package workerapi

const (
	ProviderCodex  = "codex-cli"
	ProviderClaude = "claude-code"

	agentRunBranchPrefix = "zenchron/agent-run/"

	MaxProgressEvents   = 50
	MaxEventMessageSize = 1000
)

// Verification outcomes reported by the worker. An empty value means verification did not run.
const (
	VerificationPassed        = "passed"
	VerificationFailed        = "failed"
	VerificationNotConfigured = "not_configured"
)

// Termination reasons explain why an execution attempt ended, independent of the run status.
const (
	TerminationCompleted    = "completed"
	TerminationProviderExit = "provider_exit"
	TerminationWallClock    = "wall_clock_timeout"
	TerminationInactivity   = "inactivity_timeout"
	TerminationToolTimeout  = "tool_timeout"
	TerminationCancelled    = "cancelled"
	TerminationLeaseLost    = "lease_lost"
	TerminationVerification = "verification_failed"
	TerminationWorkerError  = "worker_error"
)

// IsCLIProvider reports whether an agent profile provider runs through a locally installed coding CLI.
func IsCLIProvider(provider string) bool {
	return provider == ProviderCodex || provider == ProviderClaude
}

// AgentRunBranch is the only branch a run may create, commit to, and push.
func AgentRunBranch(runID string) string {
	return agentRunBranchPrefix + runID
}

func ValidTerminationReason(reason string) bool {
	switch reason {
	case "", TerminationCompleted, TerminationProviderExit, TerminationWallClock, TerminationInactivity,
		TerminationToolTimeout, TerminationCancelled, TerminationLeaseLost, TerminationVerification,
		TerminationWorkerError:
		return true
	default:
		return false
	}
}

func ValidVerification(status string) bool {
	return status == "" || status == VerificationPassed || status == VerificationFailed ||
		status == VerificationNotConfigured
}

func ValidEventKind(kind string) bool {
	switch kind {
	case "status", "message", "tool", "verification", "usage", "error":
		return true
	default:
		return false
	}
}

type ProviderStatus struct {
	ID      string `json:"id"`
	Version string `json:"version,omitempty"`
	Ready   bool   `json:"ready"`
	// Reason says why an installed provider is not ready, for example a failed sandbox self-test.
	Reason string `json:"reason,omitempty"`
	// SandboxedCommands reports that the provider can run repository commands, such as tests, inside
	// its sandbox on this worker. Without it the provider edits files but cannot execute anything.
	SandboxedCommands bool `json:"sandboxed_commands"`
}

type Project struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Branch string `json:"branch"`
	Remote string `json:"git_remote,omitempty"`
}

type Heartbeat struct {
	Name                string           `json:"name"`
	Projects            []Project        `json:"projects"`
	AgentRuntimeEnabled *bool            `json:"agent_runtime_enabled,omitempty"`
	Providers           []ProviderStatus `json:"providers,omitempty"`
}

type AgentProfile struct {
	Provider     string   `json:"provider"`
	Model        string   `json:"model"`
	SystemPrompt string   `json:"system_prompt"`
	GoalPrompt   string   `json:"goal_prompt"`
	Tools        []string `json:"tools"`
}

type AgentRunCommand struct {
	ID                 string       `json:"id"`
	ProjectID          string       `json:"project_id"`
	Branch             string       `json:"branch"`
	BaseBranch         string       `json:"base_branch"`
	Prompt             string       `json:"prompt"`
	Profile            AgentProfile `json:"profile"`
	Attempts           int          `json:"attempts"`
	PublishPullRequest bool         `json:"publish_pull_request,omitempty"`
}

// Usage carries only what the provider reported. CostUSD is nil when the provider reports no cost.
type Usage struct {
	InputTokens  int64    `json:"input_tokens"`
	OutputTokens int64    `json:"output_tokens"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
}

type AgentRunResult struct {
	Status            string  `json:"status"`
	Output            string  `json:"output,omitempty"`
	Error             string  `json:"error,omitempty"`
	Attempts          int     `json:"attempts"`
	BaseCommit        string  `json:"base_commit,omitempty"`
	CommitSHA         string  `json:"commit_sha,omitempty"`
	Diff              *string `json:"diff,omitempty"`
	DiffTruncated     bool    `json:"diff_truncated,omitempty"`
	BranchPushed      bool    `json:"branch_pushed,omitempty"`
	BranchPushFailed  bool    `json:"branch_push_failed,omitempty"`
	ProviderVersion   string  `json:"provider_version,omitempty"`
	TerminationReason string  `json:"termination_reason,omitempty"`
	Verification      string  `json:"verification,omitempty"`
	Usage             *Usage  `json:"usage,omitempty"`
}

type AgentRunEvent struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// AgentRunProgress renews the attempt lease and carries any new events. An empty batch is a heartbeat.
type AgentRunProgress struct {
	Attempts int             `json:"attempts"`
	Events   []AgentRunEvent `json:"events,omitempty"`
}

type AgentRunProgressReply struct {
	CancelRequested bool `json:"cancel_requested"`
}
