package main

import (
	"cmp"
	"encoding/json/v2"
	"fmt"
	"slices"
	"strings"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// unitResult is the typed result of one attempt. An agent writes it as the fenced block that ends its
// final message; the worker writes Integration itself. Only this decides what a unit achieved: the
// prose around it is never interpreted.
type unitResult struct {
	Handoff *struct {
		Summary string   `json:"summary"`
		Notes   []string `json:"notes"`
	} `json:"handoff"`
	Review *struct {
		Verdict  string          `json:"verdict"`
		Findings []reviewFinding `json:"findings"`
	} `json:"review"`
	DecisionRequest *struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	} `json:"decision_request"`
	CollaborationRequests []struct {
		To      string `json:"to"`
		Request string `json:"request"`
	} `json:"collaboration_requests"`
	StateUpdates []string               `json:"state_updates"`
	Plan         *planProposal          `json:"plan"`
	Integration  *workerapi.MergeResult `json:"integration"`
}

type reviewFinding struct {
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	File     string `json:"file"`
	Line     int    `json:"line"`
	Severity string `json:"severity"`
	// Unit optionally names the produce unit that owns the finding.
	Unit string `json:"unit"`
}

func tooLong(limit int, values ...string) bool {
	return slices.ContainsFunc(values, func(value string) bool { return len(value) > limit })
}

// parseUnitResult decodes and bounds a typed result. Anything unknown or oversized rejects the whole
// result, so a unit never advances on a result the control plane only partly understood.
func parseUnitResult(raw string) (unitResult, error) {
	var result unitResult
	if strings.TrimSpace(raw) == "" {
		return result, fmt.Errorf("the final message did not end with a %s block", workerapi.ResultFence)
	}
	if err := json.Unmarshal([]byte(raw), &result, json.RejectUnknownMembers(true)); err != nil {
		return unitResult{}, fmt.Errorf("the %s block is not valid: %w", workerapi.ResultFence, err)
	}
	switch {
	case result.Handoff != nil && (strings.TrimSpace(result.Handoff.Summary) == "" || len(result.Handoff.Summary) > 2000 ||
		len(result.Handoff.Notes) > 8 || tooLong(500, result.Handoff.Notes...)):
		return unitResult{}, fmt.Errorf("handoff needs a summary of at most 2000 bytes and at most 8 notes of 500 bytes")
	case result.DecisionRequest != nil && (strings.TrimSpace(result.DecisionRequest.Question) == "" ||
		len(result.DecisionRequest.Question) > 1000 || len(result.DecisionRequest.Options) > 6 || tooLong(200, result.DecisionRequest.Options...)):
		return unitResult{}, fmt.Errorf("decision_request needs a question of at most 1000 bytes and at most 6 options of 200 bytes")
	case len(result.CollaborationRequests) > 4 || len(result.StateUpdates) > 4 || tooLong(500, result.StateUpdates...):
		return unitResult{}, fmt.Errorf("at most 4 collaboration requests and 4 state updates of 500 bytes are accepted")
	}
	for _, request := range result.CollaborationRequests {
		if strings.TrimSpace(request.Request) == "" || len(request.Request) > 1000 {
			return unitResult{}, fmt.Errorf("a collaboration request needs a request of at most 1000 bytes")
		}
	}
	if result.Review == nil {
		return result, nil
	}
	blocked := result.Review.Verdict == "block"
	if (result.Review.Verdict != "accept" && !blocked) || blocked != (len(result.Review.Findings) > 0) || len(result.Review.Findings) > 10 {
		return unitResult{}, fmt.Errorf("review needs the verdict accept without findings, or block with 1 to 10 findings")
	}
	for _, finding := range result.Review.Findings {
		if strings.TrimSpace(finding.Title) == "" || len(finding.Title) > 200 || len(finding.Detail) > 2000 ||
			len(finding.File) > 300 || finding.Line < 0 || !slices.Contains([]string{"", "high", "medium", "low"}, finding.Severity) {
			return unitResult{}, fmt.Errorf("a finding needs a title of at most 200 bytes, a detail of at most 2000, and a severity of high, medium, or low")
		}
	}
	return result, nil
}

// admit records what a unit's finished attempt achieved, exactly once per attempt. It only records:
// what runs next is decided by the frontier from the recorded state.
func (store *workGraphStore) admit(graph *workGraph, unit *workUnit, runs map[string]agentRun) {
	run, exists := graph.current(unit, runs)
	if !exists || activeRun(run) || (unit.AdmittedRun == run.ID && unit.AdmittedAttempt == run.Attempts) {
		return
	}
	// The same integration run is admitted a second time only for its publication pass.
	publication := unit.Kind == unitIntegrate && unit.AdmittedRun == run.ID && unit.Candidate != ""
	unit.AdmittedRun, unit.AdmittedAttempt = run.ID, run.Attempts
	result, err := parseUnitResult(run.Result)
	origin := graphMessage{From: unit.Key, RunID: run.ID, Attempt: run.Attempts, Commit: run.CommitSHA}
	switch {
	case !graph.pinBase(run):
		unit.Failure = fmt.Sprintf("The run started from base %s, but this graph is pinned to %s.",
			shortCommit(run.BaseCommit), shortCommit(graph.BaseCommit))
	case len(graph.Messages) >= maxGraphMessages:
		unit.Failure = "The graph reached its message limit."
	case run.Status == "cancelled":
		unit.Failure = "The run was cancelled."
	case publication:
		if run.Status != "succeeded" || run.CommitSHA != unit.Candidate {
			unit.Failure = "Publication did not reproduce the reviewed candidate: " + cmp.Or(run.Error, "the commit changed") + "."
		}
	case unit.Kind == unitIntegrate:
		store.admitIntegration(graph, unit, run, result, origin)
	case unit.Kind == unitReview && run.Status != "succeeded":
		failure := cmp.Or(run.Error, "The reviewer invocation failed ("+run.TerminationReason+").")
		if reviewInvocationRecoverable(run) && !unit.RecoveryUsed && run.BaseCommit == graph.unit(unit.DependsOn[0]).Candidate &&
			len(unit.RunIDs) < maxUnitRuns {
			unit.RecoveryUsed = true
			graph.add(graphMessage{Type: messageStateUpdate, From: unit.Key, RunID: run.ID, Attempt: run.Attempts,
				Commit: run.BaseCommit, Body: "Reviewer invocation failed (" + failure +
					"); retrying once with the assigned reviewer against the same candidate."})
			return
		}
		unit.Failure = failure
		if reviewInvocationRecoverable(run) && !unit.RecoveryUsed && len(unit.RunIDs) >= maxUnitRuns {
			unit.Failure += fmt.Sprintf(" The one recovery was not attempted because the %d-run stage budget was exhausted.", maxUnitRuns)
		}
	case run.Status != "succeeded":
		unit.Failure = cmp.Or(run.Error, "The run failed.")
	case unit.Kind == unitReview:
		graph.admitReview(unit, run, result, err, unit.RecoveryUsed, origin, store.fileOwners(graph, runs))
	default:
		graph.admitProduction(unit, run, result, err, origin)
	}
}

// pinBase records the verified base of the first successful run that started from the graph's base branch, and
// reports whether run agrees with the pinned base. Runs on another run's branch inherit and are not compared.
func (graph *workGraph) pinBase(run agentRun) bool {
	if run.BaseBranch != graph.BaseBranch || run.BaseCommit == "" || run.Status != "succeeded" {
		return true
	}
	if graph.BaseCommit == "" {
		graph.BaseCommit = run.BaseCommit
	}
	return graph.BaseCommit == run.BaseCommit
}

// admitProduction turns a producer's attempt into a handoff bound to the commit the worker reported,
// into a decision request, or into a finding against the producer itself when the attempt ended without
// a usable typed result. Exiting successfully is never enough to complete the unit.
func (graph *workGraph) admitProduction(unit *workUnit, run agentRun, result unitResult, err error, origin graphMessage) {
	missing := func(detail string) {
		graph.add(graphMessage{Type: messageFinding, From: zenchronSender, To: []string{unit.Key}, RunID: run.ID,
			Attempt: run.Attempts, Commit: run.CommitSHA, Title: "The attempt ended without an admissible result", Body: detail})
	}
	if err != nil {
		missing(err.Error())
		return
	}
	for _, update := range result.StateUpdates {
		message := origin
		message.Type, message.Body = messageStateUpdate, update
		graph.add(message)
	}
	for _, request := range result.CollaborationRequests {
		// A request reaches only another producer: one addressed to a reviewer would let work speak to its own judge.
		if target := graph.unit(request.To); target == nil || target.Kind != unitProduce || request.To == unit.Key {
			continue
		}
		message := origin
		message.Type, message.To, message.Body = messageCollaboration, []string{request.To}, request.Request
		graph.add(message)
	}
	switch {
	case result.DecisionRequest != nil:
		message := origin
		message.Type, message.Body, message.Notes = messageDecisionRequest, result.DecisionRequest.Question, result.DecisionRequest.Options
		graph.add(message)
	case result.Handoff == nil:
		missing("The result carried neither a handoff nor a decision request.")
	case run.CommitSHA == "":
		missing("The handoff describes work, but the attempt committed no change.")
	default:
		message := origin
		message.Type, message.Body, message.Notes = messageHandoff, result.Handoff.Summary, result.Handoff.Notes
		unit.Candidate, unit.HandoffAt = run.CommitSHA, graph.add(message)
	}
}

// admitReview accepts a verdict only for the exact commit the review ran on. The worker reports that
// commit as the base of the review run, so a verdict on a candidate that has since changed is discarded
// and can never approve the newer code. Findings go to the unit that owns the affected work.
func (graph *workGraph) admitReview(
	unit *workUnit, run agentRun, result unitResult, err error, recoveryUsed bool, origin graphMessage, owners map[string]string,
) {
	target := graph.unit(unit.DependsOn[0])
	origin.Commit = run.BaseCommit
	note := func(body string) {
		message := origin
		message.Type, message.Body = messageStateUpdate, body
		graph.add(message)
	}
	switch {
	case run.CommitSHA != "":
		unit.Failure = "The reviewer changed files; a review must not modify its subject."
	case run.BaseCommit != target.Candidate:
		note("Discarded a review of a candidate that is no longer current.")
	case err != nil || result.Review == nil:
		failure := "Reviewer invocation did not produce an admissible verdict: " + cmp.Or(errorText(err), "no review was reported") + "."
		if !recoveryUsed && len(unit.RunIDs) < maxUnitRuns {
			unit.RecoveryUsed = true
			note(failure + " Retrying once with the assigned reviewer against the same candidate.")
			return
		}
		unit.Failure = failure
		if !recoveryUsed && len(unit.RunIDs) >= maxUnitRuns {
			unit.Failure += fmt.Sprintf(" The one recovery was not attempted because the %d-run stage budget was exhausted.", maxUnitRuns)
		}
		note(failure)
	case result.Review.Verdict == "accept":
		unit.Verdict = "accept"
		note("Accepted candidate " + shortCommit(run.BaseCommit) + ".")
	default:
		unit.Verdict = "block"
		for _, finding := range result.Review.Findings {
			message := origin
			message.Type, message.To = messageFinding, []string{graph.findingOwner(target, finding, owners)}
			message.Title, message.Body, message.File = finding.Title, finding.Detail, finding.File
			message.Line, message.Severity = finding.Line, finding.Severity
			graph.add(message)
		}
	}
}

func reviewInvocationRecoverable(run agentRun) bool {
	switch run.TerminationReason {
	case workerapi.TerminationProviderExit, workerapi.TerminationWallClock, workerapi.TerminationInactivity,
		workerapi.TerminationToolTimeout:
		return true
	default:
		return false
	}
}

func reviewRecoveryUsed(unit *workUnit, runs map[string]agentRun) bool {
	return slices.ContainsFunc(unit.RunIDs, func(id string) bool { return runs[id].ReviewRecovery })
}

// findingOwner routes a finding to the produce unit responsible for it: the reviewed producer, the
// producer the reviewer named, or the producer that changed the file.
// ponytail: a finding on the integrated candidate that names no producer and no produced file goes to
// the first producer; let the reviewer of an integration name the unit when plans grow wider.
func (graph *workGraph) findingOwner(target *workUnit, finding reviewFinding, owners map[string]string) string {
	if target.Kind == unitProduce {
		return target.Key
	}
	if named := graph.unit(finding.Unit); named != nil && named.Kind == unitProduce {
		return named.Key
	}
	return cmp.Or(owners[finding.File], graph.producers()[0].Key)
}

// fileOwners maps each file a producer changed to that producer, from the stored diffs. The first
// producer in plan order owns a file that several changed.
func (store *workGraphStore) fileOwners(graph *workGraph, runs map[string]agentRun) map[string]string {
	owners := map[string]string{}
	for _, producer := range graph.producers() {
		for _, runID := range producer.RunIDs {
			diff, err := store.runs.readDiff(runs[runID])
			if !runs[runID].DiffAvailable || err != nil {
				continue
			}
			for line := range strings.SplitSeq(diff, "\n") {
				if file, changed := strings.CutPrefix(line, "+++ b/"); changed {
					owners[file] = cmp.Or(owners[file], producer.Key)
				}
			}
		}
	}
	return owners
}

// admitIntegration records the combined candidate, or reports why the inputs could not be combined. A
// textual conflict becomes a finding for the producer whose branch did not merge; nothing is dropped.
func (store *workGraphStore) admitIntegration(graph *workGraph, unit *workUnit, run agentRun, result unitResult, origin graphMessage) {
	merge := cmp.Or(result.Integration, &workerapi.MergeResult{})
	switch {
	case run.Status == "succeeded" && run.CommitSHA != "":
		message := origin
		message.Type = messageHandoff
		message.Body = fmt.Sprintf("Combined %d admitted candidate(s) into one commit; verification on the combined candidate: %s.",
			len(unit.Inputs), verificationLabel(run.Verification))
		for _, input := range merge.Merged {
			message.Notes = append(message.Notes, shortCommit(input.Commit)+" from "+input.Branch)
		}
		unit.Candidate, unit.HandoffAt = run.CommitSHA, graph.add(message)
	case merge.ConflictBranch != "":
		owner := graph.producers()[0]
		for _, producer := range graph.producers() {
			if slices.ContainsFunc(producer.RunIDs, func(id string) bool { return workerapi.AgentRunBranch(id) == merge.ConflictBranch }) {
				owner = producer
			}
		}
		message := origin
		message.Type, message.To, message.Commit = messageFinding, []string{owner.Key}, owner.Candidate
		message.Title, message.Severity = "Merge conflict with work that is already integrated", "high"
		message.Body = "This unit's candidate does not merge with the candidates combined before it. Conflicting files: " +
			truncateUTF8(strings.Join(merge.ConflictFiles, ", "), 1500) + ". Change this unit's work so both changes apply."
		if len(merge.ConflictFiles) > 0 {
			message.File = truncateUTF8(merge.ConflictFiles[0], 300)
		}
		graph.add(message)
	case len(merge.Stale) > 0:
		unit.Failure = "An input branch no longer points at its admitted commit: " + truncateUTF8(strings.Join(merge.Stale, ", "), 300) + "."
	default:
		unit.Failure = "Integration failed: " + cmp.Or(run.Error, "the combined candidate produced no commit") + "."
		message := origin
		message.Type, message.Body = messageStateUpdate, "The combined candidate was not accepted: "+unit.Failure
		graph.add(message)
	}
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func shortCommit(commit string) string { return commit[:min(12, len(commit))] }
