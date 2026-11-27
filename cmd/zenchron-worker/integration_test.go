package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

var (
	firstCandidateRun  = strings.Repeat("a", 32)
	secondCandidateRun = strings.Repeat("b", 32)
)

// candidate commits one file change on a run branch of the harness repository and returns the commit.
func (harness *runHarness) candidate(runID, file, content string) workerapi.MergeInput {
	harness.t.Helper()
	branch := workerapi.AgentRunBranch(runID)
	runGit(harness.t, harness.repository, "checkout", "-q", "-b", branch, "main")
	if err := os.WriteFile(filepath.Join(harness.repository, file), []byte(content), 0o600); err != nil {
		harness.t.Fatal(err)
	}
	runGit(harness.t, harness.repository, "add", file)
	runGit(harness.t, harness.repository, "commit", "-q", "-m", "candidate "+file)
	commit := strings.TrimSpace(runGit(harness.t, harness.repository, "rev-parse", "HEAD"))
	runGit(harness.t, harness.repository, "checkout", "-q", "main")
	return workerapi.MergeInput{Branch: branch, Commit: commit}
}

func (harness *runHarness) lastResult() workerapi.AgentRunResult {
	harness.t.Helper()
	harness.mu.Lock()
	defer harness.mu.Unlock()
	if len(harness.results) == 0 {
		harness.t.Fatal("worker sent no result")
	}
	return harness.results[len(harness.results)-1]
}

func TestIntegrationRunMergesExactCandidatesVerifiesTheCombinationAndPublishesOnce(t *testing.T) {
	// The provider script must never run: integration starts no model.
	harness := newRunHarness(t, "exit 9\n", [][]string{{"sh", "-c", "test -f a.txt && test -f b.txt"}})
	bare := filepath.Join(t.TempDir(), "origin.git")
	if err := os.MkdirAll(bare, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, bare, "init", "--bare")
	runGit(t, harness.repository, "remote", "add", "origin", "https://github.com/test/repository.git")
	seedOriginMain(t, harness.repository, bare)
	runGit(t, harness.repository, "config", "url.file://"+filepath.ToSlash(bare)+".insteadOf", "https://github.com/test/repository.git")
	harness.gitRemote = "github.com/test/repository"
	runGit(t, harness.repository, "config", "remote.origin.pushurl", "https://github.com/test/repository")
	harness.runner.config.Repositories[harness.gitRemote] = harness.runner.config.Repositories[""]
	harness.command.Merge = []workerapi.MergeInput{
		harness.candidate(firstCandidateRun, "a.txt", "from a\n"), harness.candidate(secondCandidateRun, "b.txt", "from b\n")}
	harness.command.Profile = workerapi.AgentProfile{Provider: "zenchron-merge", Model: "none"}
	if err := harness.process(); err != nil {
		t.Fatalf("process integration: %v", err)
	}
	result := harness.lastResult()
	head := strings.TrimSpace(runGit(t, harness.worktree, "rev-parse", "HEAD"))
	parents := strings.Fields(runGit(t, harness.worktree, "rev-list", "--parents", "-n", "1", "HEAD"))
	if result.Status != "succeeded" || result.CommitSHA != head || len(parents) != 3 || result.BranchPushed ||
		result.Verification != workerapi.VerificationPassed || result.Diff == nil || !strings.Contains(*result.Diff, "+from a") ||
		!strings.Contains(*result.Diff, "+from b") || !strings.Contains(result.Result, harness.command.Merge[1].Commit) {
		t.Fatalf("integration result = %#v, parents %v", result, parents)
	}
	for _, input := range harness.command.Merge {
		if tip := strings.TrimSpace(runGit(t, harness.repository, "rev-parse", input.Branch)); tip != input.Commit {
			t.Errorf("integration moved input branch %s to %s", input.Branch, tip)
		}
	}

	// The publication pass repeats the run on the same worktree: nothing new is merged, the reviewed
	// commit is reproduced, and only now is the branch pushed.
	var pushed []string
	harness.runner.push = func(_ context.Context, _, _, branch, commitSHA string) error {
		pushed = append(pushed, branch+":"+commitSHA)
		return nil
	}
	// A publication bound to another commit than the worktree reproduces pushes nothing.
	harness.command.Attempts, harness.command.PublishPullRequest, harness.command.PublishCommit = 2, true, strings.Repeat("d", 40)
	if err := harness.process(); err != nil {
		t.Fatalf("process mismatched publication: %v", err)
	}
	if refused := harness.lastResult(); refused.Status != "failed" || refused.BranchPushed || len(pushed) != 0 {
		t.Fatalf("mismatched publication result = %#v, pushed %v", refused, pushed)
	}
	harness.command.Attempts, harness.command.PublishCommit = 3, head
	if err := harness.process(); err != nil {
		t.Fatalf("process publication: %v", err)
	}
	if published := harness.lastResult(); published.CommitSHA != head || !published.BranchPushed || len(pushed) != 1 ||
		pushed[0] != harness.command.Branch+":"+head {
		t.Fatalf("publication result = %#v, pushed %v", published, pushed)
	}
}

func TestIntegrationRunReportsConflictsAndStaleInputsWithoutCombiningThem(t *testing.T) {
	harness := newRunHarness(t, "exit 9\n", nil)
	conflictPath := "release notes.md"
	first := harness.candidate(firstCandidateRun, conflictPath, "first version\n")
	second := harness.candidate(secondCandidateRun, conflictPath, "second version\n")
	harness.command.Merge = []workerapi.MergeInput{first, second}
	if err := harness.process(); err != nil {
		t.Fatalf("process conflicting integration: %v", err)
	}
	result := harness.lastResult()
	if result.Status != "failed" || result.TerminationReason != workerapi.TerminationMergeConflict || result.CommitSHA != "" ||
		!strings.Contains(result.Result, `"conflict_branch":"`+second.Branch+`"`) ||
		!strings.Contains(result.Result, `"conflict_files":["release notes.md"]`) ||
		!strings.Contains(result.Result, first.Commit) {
		t.Fatalf("conflict result = %#v", result)
	}
	// The conflicting merge was aborted: the worktree is clean and holds only the first candidate.
	if status := runGit(t, harness.worktree, "status", "--porcelain"); status != "" {
		t.Fatalf("worktree after an aborted merge:\n%s", status)
	}
	if content, err := os.ReadFile(filepath.Join(harness.worktree, conflictPath)); err != nil || string(content) != "first version\n" {
		t.Fatalf("conflict file after an aborted merge = %q, %v", content, err)
	}

	// A branch that moved after its candidate was admitted is refused before anything is merged.
	stale := newRunHarness(t, "exit 9\n", nil)
	admitted := stale.candidate(firstCandidateRun, "a.txt", "admitted\n")
	runGit(t, stale.repository, "checkout", "-q", admitted.Branch)
	runGit(t, stale.repository, "commit", "-q", "--allow-empty", "-m", "not admitted")
	runGit(t, stale.repository, "checkout", "-q", "main")
	stale.command.Merge = []workerapi.MergeInput{admitted}
	if err := stale.process(); err != nil {
		t.Fatalf("process stale integration: %v", err)
	}
	base := strings.TrimSpace(runGit(t, stale.repository, "rev-parse", "main"))
	if result := stale.lastResult(); result.Status != "failed" || !strings.Contains(result.Result, `"stale":["`+admitted.Branch+`"]`) ||
		strings.TrimSpace(runGit(t, stale.worktree, "rev-parse", "HEAD")) != base {
		t.Fatalf("stale result = %#v", result)
	}
}

func TestTypedResultIsTheLastFencedResultBlockOfTheFinalMessage(t *testing.T) {
	fence := "```"
	block := fence + workerapi.ResultFence + "\n" + `{"handoff":{"summary":"s"}}` + "\n" + fence
	cases := map[string]struct{ output, want string }{
		"no block":          {"All done.", ""},
		"one block":         {"Summary.\n" + block + "\n", `{"handoff":{"summary":"s"}}`},
		"last block wins":   {fence + workerapi.ResultFence + "\n{\"old\":1}\n" + fence + "\n" + block, `{"handoff":{"summary":"s"}}`},
		"unclosed block":    {fence + workerapi.ResultFence + "\n{\"handoff\":{}}", ""},
		"other fenced code": {fence + "json\n{}\n" + fence, ""},
		"oversized block":   {fence + workerapi.ResultFence + "\n" + strings.Repeat("x", workerapi.MaxResultSize+1) + "\n" + fence, ""},
	}
	for name, test := range cases {
		if got := typedResult(test.output); got != test.want {
			t.Errorf("%s: typedResult = %q, want %q", name, got, test.want)
		}
	}

	// Through a real run: the block in the provider's final message arrives as the attempt's result.
	script := `cat > /dev/null
echo change >> README.md
printf '%s\n' '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done.\n` + "```" + workerapi.ResultFence +
		`\n{\"handoff\":{\"summary\":\"changed the readme\"}}\n` + "```" + `"}}'
`
	harness := newRunHarness(t, script, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || result.Result != `{"handoff":{"summary":"changed the readme"}}` {
		t.Fatalf("result = %#v", result)
	}
}
