package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// supervisionMinutes names the measurement no record can supply: nothing stores how long a person
// watched a run, so it is always reported as unknown and never as a value.
const supervisionMinutes = "supervision_minutes"

// deliveryReport says what one WorkGraph's run actually did, from durable records only.
type deliveryReport struct {
	GraphID         string               `json:"graph_id"`
	GraphRevision   int                  `json:"graph_revision"`
	ObjectiveID     string               `json:"objective_id"`
	ObjectiveTitle  string               `json:"objective_title"`
	PlanRevision    int                  `json:"plan_revision"`
	WorkflowID      string               `json:"workflow_id,omitempty"`
	WorkflowVersion int                  `json:"workflow_version,omitempty"`
	WorkflowMode    string               `json:"workflow_mode,omitempty"`
	Status          string               `json:"status"`
	ApprovedPlan    reportPlan           `json:"approved_plan"`
	Units           []reportUnit         `json:"units"`
	Handoffs        []reportHandoff      `json:"handoffs"`
	Decisions       []reportDecision     `json:"decisions"`
	Outstanding     []reportOutstanding  `json:"outstanding_steps"`
	Measurements    deliveryMeasurements `json:"measurements"`
	UnknownEvidence []string             `json:"unknown_evidence"`
	PullRequestURL  string               `json:"pull_request_url,omitempty"`
	PullRequest     *reportPullRequest   `json:"pull_request_external_state,omitempty"`
}

type reportPullRequest struct {
	Number               int                    `json:"number"`
	State                string                 `json:"state"`
	Draft                bool                   `json:"draft"`
	Merged               bool                   `json:"merged"`
	HeadSHA              string                 `json:"head_sha"`
	CandidateMatchesHead *bool                  `json:"candidate_matches_head,omitempty"`
	CandidateChecks      *reportCandidateChecks `json:"candidate_checks,omitempty"`
	ObservedAt           time.Time              `json:"observed_at"`
}

type reportCandidateChecks struct {
	HeadSHA    string           `json:"head_sha"`
	ObservedAt time.Time        `json:"observed_at"`
	Runs       []reportCheckRun `json:"runs"`
}

type reportCheckRun struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion,omitempty"`
}

type reportPlan struct {
	Revision   int        `json:"revision"`
	Status     string     `json:"status"`
	Hash       string     `json:"hash"`
	Summary    string     `json:"summary"`
	ApprovedBy string     `json:"approved_by,omitempty"`
	ApprovedAt *time.Time `json:"approved_at,omitempty"`
}

// observePullRequest reads current state from GitHub without changing the durable report source.
// When GitHub is unavailable or the recorded link does not match this graph's repository, the
// existing unknown-evidence marker remains authoritative.
func (report *deliveryReport) observePullRequest(ctx context.Context, repository string, client gitHubClient) {
	if report.PullRequestURL == "" {
		return
	}
	owner, repositoryName, ok := githubRepositoryParts(repository)
	if !ok {
		return
	}
	number, ok := reportPullRequestNumber(report.PullRequestURL, owner, repositoryName)
	if !ok {
		return
	}
	path := "/repos/" + owner + "/" + repositoryName + "/pulls/" + strconv.Itoa(number)
	body, err := client.requestBytes(ctx, http.MethodGet, path, "application/vnd.github+json", nil, nil)
	if err != nil {
		return
	}
	var pull struct {
		Number  int             `json:"number"`
		State   string          `json:"state"`
		HTMLURL string          `json:"html_url"`
		Draft   *bool           `json:"draft"`
		Merged  json.RawMessage `json:"merged_at"`
		Head    struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := json.Unmarshal(body, &pull); err != nil || pull.Number != number || (pull.State != "open" && pull.State != "closed") ||
		!fullGitSHA(pull.Head.SHA) || pull.Draft == nil || len(pull.Merged) == 0 || !json.Valid(pull.Merged) {
		return
	}
	merged := string(pull.Merged) != "null"
	if merged {
		var mergedAt string
		if json.Unmarshal(pull.Merged, &mergedAt) != nil {
			return
		}
		if _, err := time.Parse(time.RFC3339, mergedAt); err != nil {
			return
		}
	}
	responseNumber, matchesRepository := reportPullRequestNumber(pull.HTMLURL, owner, repositoryName)
	if !matchesRepository || responseNumber != number {
		return
	}
	state := &reportPullRequest{Number: number, State: pull.State, Draft: *pull.Draft,
		Merged: merged, HeadSHA: pull.Head.SHA, ObservedAt: time.Now().UTC()}
	for _, unit := range report.Units {
		if unit.Kind != unitIntegrate || !fullGitSHA(unit.Candidate) {
			continue
		}
		checks, err := client.commitCheckRuns(ctx, owner, repositoryName, unit.Candidate)
		if err != nil {
			break
		}
		runs := make([]reportCheckRun, 0, len(checks))
		valid := true
		for _, check := range checks {
			if check.ID <= 0 || check.HeadSHA != unit.Candidate || strings.TrimSpace(check.Name) == "" {
				valid = false
				break
			}
			switch check.Status {
			case "queued", "in_progress", "completed", "waiting", "requested", "pending":
			default:
				valid = false
			}
			if !valid {
				break
			}
			runs = append(runs, reportCheckRun{ID: check.ID, Name: check.Name, Status: check.Status, Conclusion: check.Conclusion})
		}
		if !valid {
			break
		}
		state.CandidateChecks = &reportCandidateChecks{HeadSHA: unit.Candidate, ObservedAt: time.Now().UTC(), Runs: runs}
		report.UnknownEvidence = slices.DeleteFunc(report.UnknownEvidence, func(evidence string) bool {
			return evidence == "candidate_checks"
		})
		break
	}
	for _, unit := range report.Units {
		if unit.Kind != unitIntegrate || unit.Candidate == "" {
			continue
		}
		matches := strings.EqualFold(pull.Head.SHA, unit.Candidate)
		state.CandidateMatchesHead = &matches
		break
	}
	report.PullRequest = state
	report.UnknownEvidence = slices.DeleteFunc(report.UnknownEvidence, func(evidence string) bool {
		return evidence == "pull_request_external_state"
	})
}

func reportPullRequestNumber(value, owner, repository string) (int, bool) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, "github.com") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return 0, false
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || !strings.EqualFold(parts[0], owner) || !strings.EqualFold(parts[1], repository) || parts[2] != "pull" {
		return 0, false
	}
	number, err := strconv.Atoi(parts[3])
	return number, err == nil && number > 0
}

type reportUnit struct {
	Key       string   `json:"key"`
	Kind      string   `json:"kind"`
	AgentID   string   `json:"agent_id,omitempty"`
	AgentName string   `json:"agent_name"`
	State     string   `json:"state"`
	Reason    string   `json:"reason,omitempty"`
	Candidate string   `json:"candidate,omitempty"`
	Verdict   string   `json:"verdict,omitempty"`
	RunIDs    []string `json:"run_ids"`
	// Attempts sums the attempts counter of the unit's stored runs.
	Attempts   int               `json:"attempts"`
	Providers  []string          `json:"providers"`
	Executions []reportExecution `json:"executions"`
}

type reportExecution struct {
	RunID           string    `json:"run_id"`
	ResultAttempt   int       `json:"result_attempt"`
	UpdatedAt       time.Time `json:"updated_at"`
	Status          string    `json:"status"`
	ProfileID       string    `json:"profile_id,omitempty"`
	ProfileName     string    `json:"profile_name,omitempty"`
	ProfileVersion  int       `json:"profile_version,omitempty"`
	PersonaID       string    `json:"persona_id,omitempty"`
	PersonaName     string    `json:"persona_name,omitempty"`
	PersonaVersion  int       `json:"persona_version,omitempty"`
	Provider        string    `json:"provider,omitempty"`
	ProviderVersion string    `json:"provider_version,omitempty"`
	Verification    string    `json:"verification,omitempty"`
	Attempts        int       `json:"attempts"`
	CandidateCommit string    `json:"candidate_commit,omitempty"`
	CandidateTree   string    `json:"candidate_tree_sha,omitempty"`
	ReviewVerdict   string    `json:"review_verdict,omitempty"`
	Publication     string    `json:"publication,omitempty"`
	PullRequestURL  string    `json:"pull_request_url,omitempty"`
	FailureRecorded bool      `json:"failure_recorded,omitempty"`
}

type reportHandoff struct {
	MessageID string   `json:"message_id"`
	From      string   `json:"from"`
	RunID     string   `json:"run_id,omitempty"`
	Attempt   int      `json:"attempt,omitempty"`
	Commit    string   `json:"commit,omitempty"`
	Summary   string   `json:"summary"`
	Notes     []string `json:"notes"`
}

type reportDecision struct {
	RequestID  string     `json:"request_id"`
	Question   string     `json:"question"`
	Options    []string   `json:"options"`
	Resolution string     `json:"resolution,omitempty"`
	ResolvedBy string     `json:"resolved_by,omitempty"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
}

type reportOutstanding struct {
	Key    string `json:"key"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// deliveryMeasurements holds counts that are always known and, as pointers, values that are present
// only when something recorded them. Every absent one is named in Unknown.
type deliveryMeasurements struct {
	UnitCount            int      `json:"unit_count"`
	RunCount             int      `json:"run_count"`
	AttemptCount         int      `json:"attempt_count"`
	FailedAttempts       int      `json:"failed_attempts"`
	ReviewRounds         int      `json:"review_rounds"`
	Findings             int      `json:"findings"`
	RemediationPasses    int      `json:"remediation_passes"`
	DecisionsRequested   int      `json:"decisions_requested"`
	DecisionsResolved    int      `json:"decisions_resolved"`
	HumanActions         int      `json:"human_actions"`
	HumanActionsComplete bool     `json:"human_actions_complete"`
	MaxConcurrency       int      `json:"max_concurrency"`
	WallClockSeconds     *float64 `json:"wall_clock_seconds,omitempty"`
	InputTokens          *int64   `json:"input_tokens,omitempty"`
	OutputTokens         *int64   `json:"output_tokens,omitempty"`
	CostUSD              *float64 `json:"cost_usd,omitempty"`
	RunsWithUsage        int      `json:"runs_with_usage"`
	RunsWithCost         int      `json:"runs_with_cost"`
	Unknown              []string `json:"unknown"`
}

// buildDeliveryReport computes the report of a graph from the graph and its stored runs. A run id
// whose run is no longer stored still counts as a run but contributes nothing else.
func buildDeliveryReport(graph workGraph, runs map[string]agentRun, plan *objectivePlan) deliveryReport {
	report := deliveryReport{GraphID: graph.ID, GraphRevision: graph.Revision, ObjectiveID: graph.ObjectiveID,
		ObjectiveTitle: graph.ObjectiveTitle,
		PlanRevision:   graph.PlanRevision, WorkflowID: graph.WorkflowID, WorkflowVersion: graph.WorkflowVersion,
		WorkflowMode: graph.WorkflowMode,
		Status:       graph.Status, Units: make([]reportUnit, 0, len(graph.Units)), Handoffs: []reportHandoff{},
		Decisions: []reportDecision{}, Outstanding: []reportOutstanding{},
		UnknownEvidence: []string{"candidate_tree_sha", "candidate_checks", "policy_backed_assurance", "publication_authority",
			"pull_request_external_state"}}
	if plan != nil {
		report.ApprovedPlan = reportPlan{Revision: plan.Revision, Status: plan.Status, Hash: plan.Hash, Summary: plan.Summary,
			ApprovedBy: plan.ApprovedBy, ApprovedAt: plan.ApprovedAt}
	}
	measured := &report.Measurements
	measured.UnitCount = len(graph.Units)
	var attempts []agentRunAttempt
	for _, unit := range graph.Units {
		unitAttempts := unitAttemptLog(unit, runs)
		attempts = append(attempts, unitAttempts...)
		summary := summarizeUnit(unit, runs)
		summary.Executions = summarizeExecutions(unit, runs)
		if unit.Kind == unitIntegrate && hasCandidateTree(unit, runs) {
			report.UnknownEvidence = slices.DeleteFunc(report.UnknownEvidence, func(evidence string) bool {
				return evidence == "candidate_tree_sha"
			})
		}
		report.Units = append(report.Units, summary)
		if unit.State != unitCompleted {
			report.Outstanding = append(report.Outstanding, reportOutstanding{Key: unit.Key, State: unit.State,
				Reason: firstNonEmpty(unit.Failure, unit.Reason)})
		}
		measured.RunCount += len(unit.RunIDs)
		measured.AttemptCount += summary.Attempts
		switch unit.Kind {
		case unitReview:
			measured.ReviewRounds += len(unit.RunIDs)
		case unitProduce:
			measured.RemediationPasses += remediationPasses(unit.Key, unitAttempts, graph.Messages)
		case unitIntegrate:
			report.PullRequestURL = unit.PullRequestURL
		}
	}
	report.Handoffs, report.Decisions = summarizeMessages(graph.Messages)
	for _, attempt := range attempts {
		if attempt.FinishedAt != nil && attempt.Status != "succeeded" {
			measured.FailedAttempts++
		}
	}
	measured.MaxConcurrency = maxConcurrency(attempts)
	measured.Findings = countMessages(graph.Messages, messageFinding)
	measured.DecisionsRequested = countMessages(graph.Messages, messageDecisionRequest)
	measured.DecisionsResolved = countMessages(graph.Messages, messageDecisionResolution)
	// The plan approval that created the graph is the one human action every graph has.
	measured.HumanActions = measured.DecisionsResolved + 1
	measured.HumanActionsComplete = false
	measured.Unknown = []string{supervisionMinutes}
	measured.Unknown = append(measured.Unknown, "unrecorded_human_actions")
	if graph.Status == graphCompleted {
		seconds := graph.UpdatedAt.Sub(graph.CreatedAt).Seconds()
		measured.WallClockSeconds = &seconds
	} else {
		measured.Unknown = append(measured.Unknown, "wall_clock_seconds")
	}
	measured.sumUsage(graph, runs)
	slices.Sort(measured.Unknown)
	return report
}

func hasCandidateTree(unit workUnit, runs map[string]agentRun) bool {
	for _, id := range unit.RunIDs {
		run := runs[id]
		if run.Status == "succeeded" && run.CommitSHA == unit.Candidate && run.CommitTreeSHA != "" {
			return true
		}
	}
	return false
}

func summarizeExecutions(unit workUnit, runs map[string]agentRun) []reportExecution {
	executions := make([]reportExecution, 0, len(unit.RunIDs))
	for _, id := range unit.RunIDs {
		run, exists := runs[id]
		if !exists {
			continue
		}
		execution := reportExecution{RunID: id, ResultAttempt: run.ResultAttempt, UpdatedAt: run.UpdatedAt,
			Status: run.Status, Attempts: run.Attempts,
			CandidateCommit: run.CommitSHA, CandidateTree: run.CommitTreeSHA, Provider: run.Provider, ProviderVersion: run.ProviderVersion,
			Verification: run.Verification, Publication: run.Publication, PullRequestURL: run.PullRequestURL,
			FailureRecorded: run.Error != ""}
		if run.Profile != nil {
			execution.ProfileID, execution.ProfileName, execution.ProfileVersion = run.Profile.ID, run.Profile.Name, run.Profile.Version
			if persona := run.Profile.PersonaSnapshot; persona != nil {
				execution.PersonaID, execution.PersonaName, execution.PersonaVersion = persona.ID, persona.Name, persona.Version
			}
		}
		if result, err := parseUnitResult(run.Result); err == nil && result.Review != nil {
			execution.ReviewVerdict = result.Review.Verdict
		}
		executions = append(executions, execution)
	}
	return executions
}

func summarizeMessages(messages []graphMessage) ([]reportHandoff, []reportDecision) {
	var handoffs []reportHandoff
	var decisions []reportDecision
	decisionIndex := make(map[string]int)
	for _, message := range messages {
		switch message.Type {
		case messageHandoff:
			handoffs = append(handoffs, reportHandoff{MessageID: message.ID, From: message.From, RunID: message.RunID,
				Attempt: message.Attempt, Commit: message.Commit, Summary: message.Body, Notes: append([]string{}, message.Notes...)})
		case messageDecisionRequest:
			decisionIndex[message.ID] = len(decisions)
			decisions = append(decisions, reportDecision{RequestID: message.ID, Question: message.Body,
				Options: append([]string{}, message.Notes...)})
		case messageDecisionResolution:
			if index, exists := decisionIndex[message.Resolves]; exists {
				decisions[index].Resolution, decisions[index].ResolvedBy = message.Body, message.By
				resolvedAt := message.CreatedAt
				decisions[index].ResolvedAt = &resolvedAt
			}
		}
	}
	if handoffs == nil {
		handoffs = []reportHandoff{}
	}
	if decisions == nil {
		decisions = []reportDecision{}
	}
	return handoffs, decisions
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// sumUsage adds up what the providers reported and names what none of them did.
func (measured *deliveryMeasurements) sumUsage(graph workGraph, runs map[string]agentRun) {
	missingUsage, missingCost := 0, 0
	for _, unit := range graph.Units {
		for _, id := range unit.RunIDs {
			run, exists := runs[id]
			if !exists {
				missingUsage++
				missingCost++
				continue
			}
			usage := run.Usage
			if usage == nil {
				missingUsage++
				missingCost++
				continue
			}
			measured.RunsWithUsage++
			if measured.InputTokens == nil {
				measured.InputTokens, measured.OutputTokens = new(int64), new(int64)
			}
			*measured.InputTokens += usage.InputTokens
			*measured.OutputTokens += usage.OutputTokens
			if usage.CostUSD == nil {
				missingCost++
				continue
			}
			measured.RunsWithCost++
			if measured.CostUSD == nil {
				measured.CostUSD = new(float64)
			}
			*measured.CostUSD += *usage.CostUSD
		}
	}
	if measured.InputTokens == nil {
		measured.Unknown = append(measured.Unknown, "input_tokens", "output_tokens")
	}
	if measured.CostUSD == nil {
		measured.Unknown = append(measured.Unknown, "cost_usd")
	} else if missingCost > 0 {
		measured.Unknown = append(measured.Unknown, "cost_usd_for_some_runs")
	}
	if measured.InputTokens != nil && missingUsage > 0 {
		measured.Unknown = append(measured.Unknown, "input_tokens_for_some_runs", "output_tokens_for_some_runs")
	}
}

func summarizeUnit(unit workUnit, runs map[string]agentRun) reportUnit {
	summary := reportUnit{Key: unit.Key, Kind: unit.Kind, AgentID: unit.AgentID, AgentName: unit.AgentName, State: unit.State,
		Reason:    unit.Reason,
		Candidate: unit.Candidate, Verdict: unit.Verdict, RunIDs: append([]string{}, unit.RunIDs...), Providers: []string{}}
	for _, id := range unit.RunIDs {
		run, stored := runs[id]
		if !stored {
			continue
		}
		summary.Attempts += run.Attempts
		if provider := strings.TrimSpace(run.Provider + " " + run.ProviderVersion); provider != "" {
			summary.Providers = append(summary.Providers, provider)
		}
	}
	slices.Sort(summary.Providers)
	summary.Providers = slices.Compact(summary.Providers)
	return summary
}

// unitAttemptLog returns every recorded attempt of a unit's stored runs, oldest start first.
func unitAttemptLog(unit workUnit, runs map[string]agentRun) []agentRunAttempt {
	var attempts []agentRunAttempt
	for _, id := range unit.RunIDs {
		attempts = append(attempts, runs[id].AttemptLog...)
	}
	slices.SortStableFunc(attempts, func(a, b agentRunAttempt) int { return a.StartedAt.Compare(b.StartedAt) })
	return attempts
}

// remediationPasses counts a produce unit's attempts after its first that followed a finding: one
// addressed to the unit and created between the previous attempt's start and the attempt's own start.
func remediationPasses(key string, attempts []agentRunAttempt, messages []graphMessage) int {
	passes := 0
	for index := 1; index < len(attempts); index++ {
		previous, current := attempts[index-1].StartedAt, attempts[index].StartedAt
		if slices.ContainsFunc(messages, func(message graphMessage) bool {
			return message.Type == messageFinding && slices.Contains(message.To, key) &&
				!message.CreatedAt.Before(previous) && message.CreatedAt.Before(current)
		}) {
			passes++
		}
	}
	return passes
}

// maxConcurrency is the largest number of attempts running at one instant. An attempt occupies the
// half-open interval [started_at, finished_at) and an unfinished one never ends, so the peak is always
// reached at some attempt's start.
// ponytail: quadratic in attempts, which maxUnitRuns and maxAgentRunAttempts keep in the low hundreds
// per graph; sort the interval ends and sweep if those limits grow.
func maxConcurrency(attempts []agentRunAttempt) int {
	peak := 0
	for _, started := range attempts {
		instant, running := started.StartedAt, 0
		for _, attempt := range attempts {
			if !attempt.StartedAt.After(instant) && (attempt.FinishedAt == nil || attempt.FinishedAt.After(instant)) {
				running++
			}
		}
		peak = max(peak, running)
	}
	return peak
}

func countMessages(messages []graphMessage, messageType string) int {
	count := 0
	for _, message := range messages {
		if message.Type == messageType {
			count++
		}
	}
	return count
}
