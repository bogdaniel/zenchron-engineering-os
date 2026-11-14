package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const fakeWorkerToken = "worker-token-0123456789abcdef0123456789abcdef"

// runHarness is a real Git repository, a stub control plane, and a deterministic fake CLI provider.
type runHarness struct {
	t          *testing.T
	repository string
	worktree   string
	command    workerapi.AgentRunCommand
	runner     *agentRunner

	mu           sync.Mutex
	events       []workerapi.AgentRunEvent
	results      []workerapi.AgentRunResult
	cancelOnCall int
	staleLease   bool
	progress     int
	// progressStatus, when set, is returned for every progress report after the first.
	progressStatus int
	// finishFailures is how many result deliveries fail with a server error before one succeeds.
	finishFailures int
	finishCalls    int
}

// newRunHarness installs script as the fake Codex CLI. The script runs in the run worktree and prints
// Codex JSONL events, so the real process runner, parser, and lifecycle are exercised.
func newRunHarness(t *testing.T, script string, verify [][]string) *runHarness {
	t.Helper()
	harness := &runHarness{t: t, repository: filepath.Join(t.TempDir(), "repository")}
	if err := os.MkdirAll(harness.repository, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, harness.repository, "init", "-b", "main")
	runGit(t, harness.repository, "config", "user.name", "Zenchron Test")
	runGit(t, harness.repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(harness.repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, harness.repository, "add", "README.md")
	runGit(t, harness.repository, "commit", "-m", "initial")
	worktrees := filepath.Join(t.TempDir(), "worktrees")
	t.Setenv("ZENCHRON_WORKTREES_ROOT", worktrees)
	harness.command = workerapi.AgentRunCommand{
		ID: agentRunTestID, ProjectID: agentRunTestID, Branch: workerapi.AgentRunBranch(agentRunTestID),
		BaseBranch: "main", Prompt: "Resolve the issue.", Attempts: 1,
		Profile: workerapi.AgentProfile{Provider: workerapi.ProviderCodex, Model: defaultModel, Tools: []string{"code.write"}},
	}
	harness.worktree = filepath.Join(worktrees, agentRunTestID, agentRunTestID)
	binary := filepath.Join(t.TempDir(), "fake-codex")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	api := httptest.NewServer(http.HandlerFunc(harness.serve))
	t.Cleanup(api.Close)
	controlURL, err := url.Parse(api.URL)
	if err != nil {
		t.Fatal(err)
	}
	harness.runner = &agentRunner{
		client: api.Client(), baseURL: controlURL, workerID: agentRunTestID, token: fakeWorkerToken,
		limits: runLimits{wallClock: time.Minute, inactivity: time.Minute, toolActivity: time.Minute, verification: time.Minute, gitStage: time.Minute},
		config: &workerConfig{Repositories: map[string]repositoryConfig{"": {Verify: verify,
			Environment: map[string]string{"ZC_TEST_CACHE": "/tmp/zc-cache"}}}},
		providers: map[string]*cliProvider{workerapi.ProviderCodex: {
			id: workerapi.ProviderCodex, path: binary, version: "fake 1.0", ready: true,
			args:  func(workerapi.AgentRunCommand, runWorkspace) []string { return nil },
			parse: func(line []byte) []cliEvent { return []cliEvent{parseCodexEvent(line)} },
		}},
	}
	return harness
}

func (harness *runHarness) serve(w http.ResponseWriter, r *http.Request) {
	harness.mu.Lock()
	defer harness.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agent-runs/claim"):
		_ = json.NewEncoder(w).Encode(harness.command)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/progress"):
		var progress workerapi.AgentRunProgress
		if err := json.NewDecoder(r.Body).Decode(&progress); err != nil {
			harness.t.Errorf("decode progress: %v", err)
		}
		harness.progress++
		if harness.staleLease && harness.progress > 1 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if harness.progressStatus != 0 && harness.progress > 1 {
			w.WriteHeader(harness.progressStatus)
			return
		}
		harness.events = append(harness.events, progress.Events...)
		cancel := harness.cancelOnCall > 0 && harness.progress >= harness.cancelOnCall
		_ = json.NewEncoder(w).Encode(workerapi.AgentRunProgressReply{CancelRequested: cancel})
	case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/agent-runs/"+harness.command.ID):
		var result workerapi.AgentRunResult
		if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
			harness.t.Errorf("decode result: %v", err)
		}
		harness.finishCalls++
		if harness.finishCalls <= harness.finishFailures {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		harness.results = append(harness.results, result)
	default:
		http.NotFound(w, r)
	}
}

func (harness *runHarness) process() error {
	return harness.runner.process(context.Background(),
		[]discoveredProject{{ID: harness.command.ProjectID, Name: "repository", Path: harness.repository}})
}

func (harness *runHarness) result() workerapi.AgentRunResult {
	harness.t.Helper()
	harness.mu.Lock()
	defer harness.mu.Unlock()
	if len(harness.results) != 1 {
		harness.t.Fatalf("worker sent %d results, want 1: %#v", len(harness.results), harness.results)
	}
	return harness.results[0]
}

func (harness *runHarness) eventText() string {
	harness.mu.Lock()
	defer harness.mu.Unlock()
	var text strings.Builder
	for _, event := range harness.events {
		text.WriteString(event.Kind + ": " + event.Message + "\n")
	}
	return text.String()
}

const fakeChangeScript = `cat > prompt.txt
echo "changed by agent" >> README.md
echo '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"go test ./..."}}'
echo '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"go test ./...","exit_code":0}}'
echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"m1\",\"type\":\"agent_message\",\"text\":\"Updated README in $PWD using ghp_abcdefghijklmnopqrstuvwxyz0123 and token=$ZENCHRON_WORKER_TOKEN.\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30}}'
`

func TestCLIRunCommitsVerifiedChangeAndReportsRedactedEvidence(t *testing.T) {
	t.Setenv("ZENCHRON_WORKER_TOKEN", fakeWorkerToken)
	harness := newRunHarness(t, fakeChangeScript, [][]string{{"grep", "-q", "changed by agent", "README.md"}})
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := harness.result()
	head := strings.TrimSpace(runGit(t, harness.worktree, "rev-parse", "HEAD"))
	base := strings.TrimSpace(runGit(t, harness.repository, "rev-parse", "main"))
	if result.Status != "succeeded" || result.CommitSHA != head || result.BaseCommit != base ||
		result.Verification != workerapi.VerificationPassed || result.TerminationReason != workerapi.TerminationCompleted ||
		result.ProviderVersion != "fake 1.0" || result.Usage == nil || result.Usage.InputTokens != 120 ||
		result.Usage.OutputTokens != 30 || result.Usage.CostUSD != nil || result.BranchPushed ||
		result.Diff == nil || !strings.Contains(*result.Diff, "+changed by agent") {
		t.Fatalf("result = %#v", result)
	}
	events := harness.eventText()
	for _, want := range []string{"status: codex-cli fake 1.0 started", "tool: $ go test ./...", "tool: exit 0: go test ./...",
		"verification: passed: grep -q changed by agent README.md", "usage: 120 input tokens, 30 output tokens"} {
		if !strings.Contains(events, want) {
			t.Errorf("events missing %q:\n%s", want, events)
		}
	}
	for _, leaked := range []string{fakeWorkerToken, "ghp_abcdefghijklmnopqrstuvwxyz0123", harness.worktree} {
		if strings.Contains(events, leaked) || strings.Contains(result.Output, leaked) {
			t.Errorf("%q leaked into events or output:\n%s\n%s", leaked, events, result.Output)
		}
	}
	if !strings.Contains(result.Output, "Updated README in . using [redacted] and token=.") {
		t.Errorf("output = %q, want redacted path and credentials", result.Output)
	}
	prompt, err := os.ReadFile(filepath.Join(harness.worktree, "prompt.txt"))
	if err != nil || !strings.Contains(string(prompt), "Resolve the issue.") || !strings.Contains(string(prompt), "Do not commit") {
		t.Fatalf("provider prompt = %q, %v", prompt, err)
	}
	if source, err := os.ReadFile(filepath.Join(harness.repository, "README.md")); err != nil || string(source) != "base\n" {
		t.Fatalf("source checkout changed: %q, %v", source, err)
	}
}

func TestCLIRunVerificationFailureKeepsCommitAndDoesNotPublish(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, [][]string{{"sh", "-c", "echo boom-detail; exit 3"}})
	harness.command.PublishPullRequest = true
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := harness.result()
	if result.Status != "failed" || result.Verification != workerapi.VerificationFailed ||
		result.TerminationReason != workerapi.TerminationVerification || len(result.CommitSHA) != 40 ||
		result.BranchPushed || result.BranchPushFailed {
		t.Fatalf("result = %#v", result)
	}
	if events := harness.eventText(); !strings.Contains(events, "verification: failed: sh -c echo boom-detail; exit 3\nboom-detail") {
		t.Fatalf("events missing verification failure:\n%s", events)
	}
}

func TestOperatorEnvironmentReachesProviderAndVerificationButCannotRestoreCredentials(t *testing.T) {
	script := `echo "cache=$ZC_TEST_CACHE" >> README.md
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`
	harness := newRunHarness(t, script, [][]string{{"sh", "-c", `test "$ZC_TEST_CACHE" = /tmp/zc-cache && test -z "$ZENCHRON_WORKER_TOKEN"`}})
	t.Setenv("ZENCHRON_WORKER_TOKEN", fakeWorkerToken)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := harness.result()
	if result.Status != "succeeded" || result.Verification != workerapi.VerificationPassed ||
		!strings.Contains(*result.Diff, "+cache=/tmp/zc-cache") {
		t.Fatalf("result = %#v", result)
	}
	for _, reserved := range []string{`{"ZENCHRON_WORKER_TOKEN":"x"}`, `{"ANTHROPIC_API_KEY":"x"}`, `{"GH_TOKEN":"x"}`, `{"BAD NAME":"x"}`, `{"A=B":"x"}`} {
		path := filepath.Join(t.TempDir(), "worker.json")
		content := `{"repositories":{"github.com/acme/api":{"environment":` + reserved + `}}}`
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("ZENCHRON_WORKER_CONFIG", path)
		if _, err := loadWorkerConfig(); err == nil {
			t.Errorf("worker config accepted environment %s", reserved)
		}
	}
}

func TestCLIRunWithoutVerificationConfigReportsNotConfigured(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || result.Verification != workerapi.VerificationNotConfigured {
		t.Fatalf("result = %#v", result)
	}
}

func TestCLIRunFailsWhenProviderExitsNonZeroOrReportsFailure(t *testing.T) {
	for name, script := range map[string]string{
		"exit code":      "echo partial >> README.md\necho 'fatal: quota' >&2\nexit 7\n",
		"reported error": `echo '{"type":"turn.failed","error":{"message":"model refused"}}'` + "\n",
		"no message":     "exit 0\n",
	} {
		t.Run(name, func(t *testing.T) {
			harness := newRunHarness(t, script, nil)
			if err := harness.process(); err != nil {
				t.Fatalf("process run: %v", err)
			}
			result := harness.result()
			if result.Status != "failed" || result.TerminationReason != workerapi.TerminationProviderExit ||
				result.CommitSHA != "" || result.Verification != "" {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}

func TestCLIRunStopsSilentProviderButAllowsLongRunningTool(t *testing.T) {
	silent := newRunHarness(t, "echo partial >> README.md\nsleep 30 &\nwait\n", nil)
	silent.runner.limits.inactivity = 1500 * time.Millisecond
	started := time.Now()
	if err := silent.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := silent.result()
	if result.Status != "failed" || result.TerminationReason != workerapi.TerminationInactivity ||
		result.Diff == nil || !strings.Contains(*result.Diff, "+partial") || time.Since(started) > 20*time.Second {
		t.Fatalf("silent result = %#v after %s", result, time.Since(started))
	}

	busy := newRunHarness(t, `echo '{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"go test"}}'
sleep 4
echo '{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"go test","exit_code":0}}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"done"}}'
`, nil)
	busy.runner.limits.inactivity = 1500 * time.Millisecond
	if err := busy.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := busy.result(); result.Status != "succeeded" || result.TerminationReason != workerapi.TerminationCompleted {
		t.Fatalf("busy result = %#v", result)
	}
}

func TestGitStageDeadlineStartsAfterProviderFinishes(t *testing.T) {
	harness := newRunHarness(t, "sleep 2\n"+fakeChangeScript, nil)
	harness.runner.limits.gitStage = time.Second
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || len(result.CommitSHA) != 40 {
		t.Fatalf("run longer than the git stage deadline = %#v", result)
	}
}

func TestCLIRunWallClockLimitIsReportedSeparately(t *testing.T) {
	harness := newRunHarness(t, "while true; do echo '{\"type\":\"turn.started\"}'; sleep 0.2; done\n", nil)
	harness.runner.limits.wallClock = time.Second
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "failed" || result.TerminationReason != workerapi.TerminationWallClock {
		t.Fatalf("result = %#v", result)
	}
}

func TestCLIRunCancellationStopsProviderAndKeepsPartialDiff(t *testing.T) {
	harness := newRunHarness(t, "echo partial >> README.md\nwhile true; do echo '{\"type\":\"turn.started\"}'; sleep 0.2; done\n", nil)
	harness.cancelOnCall = 2
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := harness.result()
	if result.Status != "cancelled" || result.TerminationReason != workerapi.TerminationCancelled ||
		result.CommitSHA != "" || result.Diff == nil || !strings.Contains(*result.Diff, "+partial") {
		t.Fatalf("result = %#v", result)
	}
	if status := runGit(t, harness.worktree, "status", "--porcelain"); !strings.Contains(status, "README.md") {
		t.Fatalf("cancelled worktree lost its partial change: %q", status)
	}
}

func TestStaleLeaseStopsAttemptWithoutReportingResult(t *testing.T) {
	harness := newRunHarness(t, "echo partial >> README.md\nwhile true; do echo '{\"type\":\"turn.started\"}'; sleep 0.2; done\n", nil)
	harness.staleLease = true
	if err := harness.process(); err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("process error = %v, want interrupted attempt", err)
	}
	harness.mu.Lock()
	results := len(harness.results)
	harness.mu.Unlock()
	if results != 0 {
		t.Fatalf("stale attempt reported %d results", results)
	}
	if status := runGit(t, harness.worktree, "status", "--porcelain"); !strings.Contains(status, "README.md") {
		t.Fatalf("interrupted worktree lost its partial change: %q", status)
	}
	root := filepath.Dir(filepath.Dir(harness.worktree))
	projects := []discoveredProject{{ID: agentRunTestID, Name: "repository", Path: harness.repository}}
	if removed, _, err := cleanupWorktrees(context.Background(), root, projects); err != nil || len(removed) != 0 {
		t.Fatalf("cleanup removed interrupted worktree %v, error %v", removed, err)
	}
}

func TestResultDeliveryIsRetriedAfterServerErrors(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	harness.runner.finishRetryDelay, harness.finishFailures = 10*time.Millisecond, 2
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || harness.finishCalls != 3 {
		t.Fatalf("result = %#v after %d deliveries", result, harness.finishCalls)
	}
	exhausted := newRunHarness(t, fakeChangeScript, nil)
	exhausted.runner.finishRetryDelay, exhausted.finishFailures = 10*time.Millisecond, 99
	if err := exhausted.process(); err == nil || exhausted.finishCalls != finishAttempts {
		t.Fatalf("exhausted delivery error = %v after %d deliveries", err, exhausted.finishCalls)
	}
}

func TestWorkerStopsWhenControlPlaneRejectsItsIdentityOrRun(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound} {
		harness := newRunHarness(t, "echo partial >> README.md\nwhile true; do echo '{\"type\":\"turn.started\"}'; sleep 0.2; done\n", nil)
		harness.progressStatus = status
		started := time.Now()
		if err := harness.process(); err == nil || !strings.Contains(err.Error(), "interrupted") {
			t.Fatalf("HTTP %d: process error = %v, want interrupted attempt", status, err)
		}
		if time.Since(started) > 20*time.Second || len(harness.results) != 0 {
			t.Fatalf("HTTP %d: worker kept running for %s and sent %d results", status, time.Since(started), len(harness.results))
		}
	}
}

func TestBoundedDiffStaysValidAndWithinLimitWhenCutMidCharacter(t *testing.T) {
	buffer := &boundedDiff{}
	_, _ = buffer.Write([]byte(strings.Repeat("é", maxAgentRunDiffSize) + "\xff\xfe"))
	diff := buffer.String()
	encoded, err := json.Marshal(diff)
	var decoded string
	if err != nil || json.Unmarshal(encoded, &decoded) != nil || len(decoded) > maxAgentRunDiffSize || !buffer.truncated ||
		strings.ContainsRune(decoded, '\uFFFD') {
		t.Fatalf("diff of %d bytes decodes to %d bytes, truncated %t, error %v", len(diff), len(decoded), buffer.truncated, err)
	}
}

func TestAttemptThatLosesItsLeaseAfterCommittingDoesNotPush(t *testing.T) {
	pushes := 0
	countPush := func(context.Context, string, string, string) error {
		pushes++
		return nil
	}
	published := newRunHarness(t, fakeChangeScript, nil)
	published.command.PublishPullRequest, published.runner.push = true, countPush
	if err := published.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := published.result(); !result.BranchPushed || pushes != 1 {
		t.Fatalf("current attempt result = %#v after %d pushes", result, pushes)
	}

	// The same delivery stage, entered by an attempt whose lease was lost while the provider ran.
	pushes = 0
	stale := newRunHarness(t, fakeChangeScript, nil)
	stale.command.PublishPullRequest, stale.runner.push = true, countPush
	project := discoveredProject{ID: stale.command.ProjectID, Name: "repository", Path: stale.repository}
	root := filepath.Dir(filepath.Dir(stale.worktree))
	if err := prepareWorktree(context.Background(), root, project, stale.command.ID, stale.command.Branch, "main"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale.worktree, "README.md"), []byte("late change\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reporter := &progressReporter{leaseLost: true, redactor: newRedactor(stale.worktree)}
	owner, err := acquireWorktree(context.Background(), stale.worktree, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.release()
	result := stale.runner.deliver(context.Background(), context.Background(), stale.command, project,
		runWorkspace{path: stale.worktree, owner: owner}, workerapi.AgentRunResult{}, reporter)
	if pushes != 0 || result.BranchPushed || result.Status == "succeeded" || len(result.CommitSHA) != 40 {
		t.Fatalf("stale attempt pushed %d times: %#v", pushes, result)
	}
	if commit := strings.TrimSpace(runGit(t, stale.worktree, "rev-parse", "HEAD")); commit != result.CommitSHA {
		t.Fatalf("stale attempt did not keep its local commit: %q", commit)
	}
}

func TestRunRejectsBranchOtherThanItsOwnRunBranch(t *testing.T) {
	for _, branch := range []string{"main", "zenchron/agent-run/ffffffffffffffffffffffffffffffff", "../escape"} {
		harness := newRunHarness(t, fakeChangeScript, nil)
		harness.command.Branch = branch
		if err := harness.process(); err != nil {
			t.Fatalf("process run: %v", err)
		}
		if result := harness.result(); result.Status != "failed" || !strings.Contains(result.Error, "not the branch authorized") {
			t.Fatalf("branch %q result = %#v", branch, result)
		}
		if _, err := os.Stat(harness.worktree); !os.IsNotExist(err) {
			t.Fatalf("branch %q created a worktree: %v", branch, err)
		}
	}
}

func TestRunRejectsModelNamesThatCouldBeReadAsOptions(t *testing.T) {
	for _, model := range []string{"--dangerously-bypass-approvals-and-sandbox", "-s danger-full-access", "gpt x", "", "a\nb"} {
		harness := newRunHarness(t, fakeChangeScript, nil)
		harness.command.Profile.Model = model
		if err := harness.process(); err != nil {
			t.Fatalf("process run: %v", err)
		}
		if result := harness.result(); result.Status != "failed" || !strings.Contains(result.Error, "model name is not valid") {
			t.Fatalf("model %q result = %#v", model, result)
		}
		if _, err := os.Stat(harness.worktree); !os.IsNotExist(err) {
			t.Fatalf("model %q reached worktree preparation: %v", model, err)
		}
	}
}

func TestRunFailsWhenRequestedProviderIsNotReady(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	harness.command.Profile.Provider = workerapi.ProviderClaude
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "failed" || !strings.Contains(result.Error, "not ready") {
		t.Fatalf("result = %#v", result)
	}
}

func TestCleanupWorktreesKeepsLockedAndModifiedWorktrees(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	root := filepath.Dir(filepath.Dir(harness.worktree))
	projects := []discoveredProject{{ID: agentRunTestID, Name: "repository", Path: harness.repository}}
	prepare := func(id string) string {
		t.Helper()
		if err := prepareWorktree(context.Background(), root, projects[0], id, workerapi.AgentRunBranch(id), "main"); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(root, agentRunTestID, id)
	}
	dirty := prepare("11111111111111111111111111111111")
	if err := os.WriteFile(filepath.Join(dirty, "uncommitted.txt"), []byte("keep me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	locked := prepare("22222222222222222222222222222222")
	lockWorktree(harness.repository, locked)
	removed, kept, err := cleanupWorktrees(context.Background(), root, projects)
	if err != nil || len(removed) != 1 || removed[0] != "repository/"+agentRunTestID || len(kept) != 2 {
		t.Fatalf("cleanup removed %v, kept %v, error %v", removed, kept, err)
	}
	for _, path := range []string{dirty, locked} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("cleanup removed protected worktree %s: %v", path, err)
		}
	}
	if _, err := os.Stat(harness.worktree); !os.IsNotExist(err) {
		t.Fatalf("finished clean worktree still exists: %v", err)
	}
	if commit := runGit(t, harness.repository, "rev-parse", harness.command.Branch); len(strings.TrimSpace(commit)) != 40 {
		t.Fatalf("cleanup lost the run branch: %q", commit)
	}
}

func TestProviderEnvironmentInheritsOnlyNamedVariables(t *testing.T) {
	environment := providerEnvironment([]string{"PATH=/bin", "HOME=/home/dev", "ZENCHRON_WORKER_TOKEN=secret",
		"GH_TOKEN=secret", "GITHUB_TOKEN=secret", "ANTHROPIC_API_KEY=secret",
		"OPENAI_API_KEY=secret", "CODEX_API_KEY=secret", "SSH_AUTH_SOCK=/tmp/agent.sock", "GH_ENTERPRISE_TOKEN=secret",
		"GITHUB_ENTERPRISE_TOKEN=secret", "AWS_ACCESS_KEY_ID=id", "AWS_SECRET_ACCESS_KEY=secret", "AWS_SESSION_TOKEN=secret",
		"GOOGLE_APPLICATION_CREDENTIALS=/home/dev/key.json",
		// Secrets under names no denylist could anticipate must not be inherited either.
		"NPM_TOKEN=secret", "DATABASE_URL=postgres://user:secret@db/app", "MY_COMPANY_DEPLOY_KEY=secret",
		"LC_ALL=en_US.UTF-8", "HTTPS_PROXY=http://proxy:3128"})
	if strings.Join(environment, " ") != "PATH=/bin HOME=/home/dev LC_ALL=en_US.UTF-8 HTTPS_PROXY=http://proxy:3128" {
		t.Fatalf("provider environment = %v", environment)
	}
}

func TestWorkerConfigIsRepositoryAllowlistAndRejectsInvalidCommands(t *testing.T) {
	write := func(content string) {
		t.Helper()
		path := filepath.Join(t.TempDir(), "worker.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("ZENCHRON_WORKER_CONFIG", path)
	}
	t.Setenv("ZENCHRON_WORKER_CONFIG", "")
	if config, err := loadWorkerConfig(); err != nil || !config.serves("github.com/any/repo") || config.verificationCommands("x") != nil {
		t.Fatalf("unconfigured worker = %#v, %v", config, err)
	}
	write(`{"repositories":{"github.com/acme/api":{"verify":[["go","vet","./..."]]}}}`)
	config, err := loadWorkerConfig()
	if err != nil || !config.serves("github.com/acme/api") || config.serves("github.com/acme/other") ||
		len(config.verificationCommands("github.com/acme/api")) != 1 {
		t.Fatalf("configured worker = %#v, %v", config, err)
	}
	for _, invalid := range []string{`{"repositories":{"github.com/acme/api":{"verify":[[]]}}}`,
		`{"repositories":{"../escape":{}}}`, `{"repositories":{},"shell":"sh -c"}`, `not json`} {
		write(invalid)
		if _, err := loadWorkerConfig(); err == nil {
			t.Errorf("config %s was accepted", invalid)
		}
	}
}

func TestRunLimitsRejectInvalidDurations(t *testing.T) {
	t.Setenv("ZENCHRON_RUN_TIMEOUT", "3h")
	if limits, err := loadRunLimits(); err != nil || limits.wallClock != 3*time.Hour || limits.inactivity != 15*time.Minute {
		t.Fatalf("limits = %#v, %v", limits, err)
	}
	for _, invalid := range []string{"0s", "-5m", "forever"} {
		t.Setenv("ZENCHRON_RUN_INACTIVITY_TIMEOUT", invalid)
		if _, err := loadRunLimits(); err == nil {
			t.Errorf("inactivity limit %q was accepted", invalid)
		}
	}
}

func TestProviderEventParsersNormalizeRecordedOutput(t *testing.T) {
	codex := parseCodexEvent([]byte(`{"type":"turn.completed","usage":{"input_tokens":37846,"cached_input_tokens":31488,"output_tokens":94}}`))
	if codex.usage == nil || codex.usage.InputTokens != 37846 || codex.usage.OutputTokens != 94 || codex.usage.CostUSD != nil {
		t.Fatalf("codex usage = %#v", codex.usage)
	}
	if event := parseCodexEvent([]byte(`not json`)); event != (cliEvent{}) {
		t.Fatalf("unparseable line produced %#v", event)
	}
	claude := parseClaudeEvent([]byte(`{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01325,` +
		`"usage":{"input_tokens":2,"cache_creation_input_tokens":730,"cache_read_input_tokens":6970,"output_tokens":4}}`))[0]
	if claude.output != "ok" || claude.failure != "" || claude.usage.InputTokens != 7702 || claude.usage.OutputTokens != 4 ||
		claude.usage.CostUSD == nil || *claude.usage.CostUSD != 0.01325 {
		t.Fatalf("claude result = %#v, usage %#v", claude, claude.usage)
	}
	failed := parseClaudeEvent([]byte(`{"type":"result","subtype":"error_max_turns","is_error":true,"usage":{}}`))[0]
	if failed.failure != "error_max_turns" || failed.output != "" {
		t.Fatalf("claude failure = %#v", failed)
	}
	tool := parseClaudeEvent([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/work/tree/a.txt"}}]}}`))[0]
	done := parseClaudeEvent([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`))[0]
	if tool.toolStarted != "t1" || tool.message != "Edit a.txt" || done.toolFinished != "t1" {
		t.Fatalf("claude tool events = %#v / %#v", tool, done)
	}
	// Text before a tool start, and two tools started by one message, must all be reported.
	mixed := parseClaudeEvent([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"Running the tests."},` +
		`{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"go test ./..."}},{"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"TODO"}}]}}`))
	if len(mixed) != 3 || mixed[0].message != "Running the tests." || mixed[1].toolStarted != "t2" ||
		mixed[1].message != "Bash go test ./..." || mixed[2].toolStarted != "t3" {
		t.Fatalf("claude multi-block message = %#v", mixed)
	}
	if events := parseClaudeEvent([]byte(`not json`)); events != nil {
		t.Fatalf("unparseable claude line produced %#v", events)
	}
}

func TestSessionKeepsEveryToolStartedByOneLineOpen(t *testing.T) {
	session := &cliSession{parse: parseClaudeEvent, emit: func(string, string) {}, openTools: map[string]bool{}}
	session.handle([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"Checking."},` +
		`{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"sleep 600"}},{"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"x"}}]}}`))
	if !session.openTools["t2"] || !session.openTools["t3"] {
		t.Fatalf("open tools after a multi-block message = %v", session.openTools)
	}
	session.handle([]byte(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"ok"}]}}`))
	if !session.openTools["t2"] || session.openTools["t3"] {
		t.Fatalf("open tools after one result = %v", session.openTools)
	}
}

func TestClaimedRunBodyIsBounded(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"id":"`+agentRunTestID+`","prompt":"`+strings.Repeat("a", 2<<20)+`"}`)
	}))
	defer api.Close()
	controlURL, _ := url.Parse(api.URL)
	if _, _, err := claimAgentRun(context.Background(), api.Client(), controlURL, agentRunTestID); err == nil {
		t.Fatal("oversized claim was accepted")
	}
	// A valid command followed by padding past the limit is still an oversized response.
	padded := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"id":"`+agentRunTestID+`"}`+strings.Repeat(" ", maxClaimResponseSize))
	}))
	defer padded.Close()
	paddedURL, _ := url.Parse(padded.URL)
	if _, _, err := claimAgentRun(context.Background(), padded.Client(), paddedURL, agentRunTestID); err == nil {
		t.Fatal("a valid claim padded past the limit was accepted")
	}
}
