package main

import (
	"slices"
	"strings"
)

// supervisionMinutes names the measurement no record can supply: nothing stores how long a person
// watched a run, so it is always reported as unknown and never as a value.
const supervisionMinutes = "supervision_minutes"

// deliveryReport says what one WorkGraph's run actually did, from durable records only.
type deliveryReport struct {
	GraphID        string               `json:"graph_id"`
	ObjectiveID    string               `json:"objective_id"`
	ObjectiveTitle string               `json:"objective_title"`
	PlanRevision   int                  `json:"plan_revision"`
	Status         string               `json:"status"`
	Units          []reportUnit         `json:"units"`
	Measurements   deliveryMeasurements `json:"measurements"`
	PullRequestURL string               `json:"pull_request_url,omitempty"`
}

type reportUnit struct {
	Key       string   `json:"key"`
	Kind      string   `json:"kind"`
	AgentName string   `json:"agent_name"`
	State     string   `json:"state"`
	Candidate string   `json:"candidate,omitempty"`
	Verdict   string   `json:"verdict,omitempty"`
	RunIDs    []string `json:"run_ids"`
	// Attempts sums the attempts counter of the unit's stored runs.
	Attempts  int      `json:"attempts"`
	Providers []string `json:"providers"`
}

// deliveryMeasurements holds counts that are always known and, as pointers, values that are present
// only when something recorded them. Every absent one is named in Unknown.
type deliveryMeasurements struct {
	UnitCount          int      `json:"unit_count"`
	RunCount           int      `json:"run_count"`
	AttemptCount       int      `json:"attempt_count"`
	FailedAttempts     int      `json:"failed_attempts"`
	ReviewRounds       int      `json:"review_rounds"`
	Findings           int      `json:"findings"`
	RemediationPasses  int      `json:"remediation_passes"`
	DecisionsRequested int      `json:"decisions_requested"`
	DecisionsResolved  int      `json:"decisions_resolved"`
	HumanActions       int      `json:"human_actions"`
	MaxConcurrency     int      `json:"max_concurrency"`
	WallClockSeconds   *float64 `json:"wall_clock_seconds,omitempty"`
	InputTokens        *int64   `json:"input_tokens,omitempty"`
	OutputTokens       *int64   `json:"output_tokens,omitempty"`
	CostUSD            *float64 `json:"cost_usd,omitempty"`
	Unknown            []string `json:"unknown"`
}

// buildDeliveryReport computes the report of a graph from the graph and its stored runs. A run id
// whose run is no longer stored still counts as a run but contributes nothing else.
func buildDeliveryReport(graph workGraph, runs map[string]agentRun) deliveryReport {
	report := deliveryReport{GraphID: graph.ID, ObjectiveID: graph.ObjectiveID, ObjectiveTitle: graph.ObjectiveTitle,
		PlanRevision: graph.PlanRevision, Status: graph.Status, Units: make([]reportUnit, 0, len(graph.Units))}
	measured := &report.Measurements
	measured.UnitCount = len(graph.Units)
	var attempts []agentRunAttempt
	for _, unit := range graph.Units {
		unitAttempts := unitAttemptLog(unit, runs)
		attempts = append(attempts, unitAttempts...)
		summary := summarizeUnit(unit, runs)
		report.Units = append(report.Units, summary)
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
	measured.Unknown = []string{supervisionMinutes}
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

// sumUsage adds up what the providers reported and names what none of them did.
func (measured *deliveryMeasurements) sumUsage(graph workGraph, runs map[string]agentRun) {
	for _, unit := range graph.Units {
		for _, id := range unit.RunIDs {
			usage := runs[id].Usage
			if usage == nil {
				continue
			}
			if measured.InputTokens == nil {
				measured.InputTokens, measured.OutputTokens = new(int64), new(int64)
			}
			*measured.InputTokens += usage.InputTokens
			*measured.OutputTokens += usage.OutputTokens
			if usage.CostUSD == nil {
				continue
			}
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
	}
}

func summarizeUnit(unit workUnit, runs map[string]agentRun) reportUnit {
	summary := reportUnit{Key: unit.Key, Kind: unit.Kind, AgentName: unit.AgentName, State: unit.State,
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
