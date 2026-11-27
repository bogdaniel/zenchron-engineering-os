// Package workerapi is the single home of the wire contract between the control plane and local workers.
package workerapi

const (
	// ProtocolVersion identifies the control-plane/worker contract recorded in managed releases.
	ProtocolVersion = 1

	ProviderCodex  = "codex-cli"
	ProviderClaude = "claude-code"

	// MaxJSONRequestBodySize is the largest JSON request body accepted by the control plane.
	MaxJSONRequestBodySize = 1 << 20

	AgentRunResultAlreadyAccepted = "agent run result was already accepted"

	agentRunBranchPrefix = "zenchron/agent-run/"

	MaxProgressEvents   = 50
	MaxEventMessageSize = 1000

	// ResultFence labels the fenced block in an agent's final message that carries its typed result.
	ResultFence = "zenchron-result"
	// MaxResultSize bounds one typed result. A plan of several units with full instructions needs most of it.
	// ponytail: results are stored on the run record, so 200 runs of 48 KiB stay under the 16 MiB snapshot;
	// move results to per-run files, like diffs, if either limit has to grow.
	MaxResultSize  = 48 << 10
	MaxMergeInputs = 8
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
	// TerminationMergeConflict ends an integration run whose inputs could not be combined.
	TerminationMergeConflict = "merge_conflict"
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
		TerminationWorkerError, TerminationMergeConflict:
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
	Name            string           `json:"name"`
	Projects        []Project        `json:"projects"`
	Providers       []ProviderStatus `json:"providers,omitempty"`
	ProtocolVersion int              `json:"protocol_version,omitempty"`
	ReleaseRevision string           `json:"release_revision,omitempty"`
}

const (
	SkippedProjectRepositoryNotGranted = "repository_not_granted"
	SkippedProjectRegisteredElsewhere  = "project_id_registered_by_another_worker"
)

type SkippedProject struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

type HeartbeatReply struct {
	SkippedProjects []SkippedProject `json:"skipped_projects,omitempty"`
}

type AgentProfile struct {
	Provider     string        `json:"provider"`
	Model        string        `json:"model"`
	SystemPrompt string        `json:"system_prompt"`
	GoalPrompt   string        `json:"goal_prompt"`
	Tools        []string      `json:"tools"`
	Persona      *AgentPersona `json:"persona,omitempty"`
}

type AgentPersona struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Role                 string   `json:"role"`
	Responsibilities     []string `json:"responsibilities"`
	Instructions         string   `json:"instructions"`
	Behavior             string   `json:"behavior"`
	ReviewSpecialization string   `json:"review_specialization"`
	Version              int      `json:"version"`
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
	// VerifySource asks the worker only to verify the base branch against origin and report its commit as
	// base_commit; no provider runs and no worktree is created. Plan approval waits for it.
	VerifySource bool `json:"verify_source,omitempty"`
	// StartCommit, when set, is the WorkGraph's pinned base: the run branch starts from exactly this commit.
	StartCommit string `json:"start_commit,omitempty"`
	// Repository, when set, is the GitHub repository this run belongs to; its base must be verified against it.
	Repository string `json:"repository,omitempty"`
	// PublishCommit, when set, is the only commit this attempt may push: the reviewed candidate.
	PublishCommit string `json:"publish_commit,omitempty"`
	// PublishOnly pushes the previously completed candidate without re-running its agent or integration.
	PublishOnly bool `json:"publish_only,omitempty"`
	// Merge makes this an integration run: the worker combines these local branches in order instead of
	// starting a provider. Each branch must still point at the commit named here.
	Merge []MergeInput `json:"merge,omitempty"`
}

// MergeInput is one admitted candidate an integration run combines.
type MergeInput struct {
	Branch string `json:"branch"`
	Commit string `json:"commit"`
}

// MergeResult is what the worker observed while combining branches. It is the typed result of an
// integration run, under the key "integration".
type MergeResult struct {
	Merged []MergeInput `json:"merged,omitempty"`
	// Stale lists branches that no longer point at the commit the control plane admitted.
	Stale []string `json:"stale,omitempty"`
	// ConflictBranch is the first branch that could not be merged, with the files in conflict.
	ConflictBranch string   `json:"conflict_branch,omitempty"`
	ConflictFiles  []string `json:"conflict_files,omitempty"`
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
	CommitTreeSHA     string  `json:"commit_tree_sha,omitempty"`
	Diff              *string `json:"diff,omitempty"`
	DiffTruncated     bool    `json:"diff_truncated,omitempty"`
	BranchPushed      bool    `json:"branch_pushed,omitempty"`
	BranchPushFailed  bool    `json:"branch_push_failed,omitempty"`
	ProviderVersion   string  `json:"provider_version,omitempty"`
	TerminationReason string  `json:"termination_reason,omitempty"`
	Verification      string  `json:"verification,omitempty"`
	Usage             *Usage  `json:"usage,omitempty"`
	// Result is the typed result of the attempt as JSON: the block an agent ended its final message with,
	// or what the worker observed in an integration run. The control plane validates it.
	Result string `json:"result,omitempty"`
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
