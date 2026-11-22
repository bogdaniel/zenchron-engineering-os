package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	maxAgentRunOutputSize = 20_000
	maxAgentRunDiffSize   = 128 << 10
	maxClaimResponseSize  = 1 << 20
)

func pushAgentBranch(ctx context.Context, worktree, expectedRemote, branch string) error {
	parts := strings.Split(expectedRemote, "/")
	if len(parts) != 3 || parts[0] != "github.com" || parts[1] == "" || parts[2] == "" {
		return errors.New("project is not a GitHub repository")
	}
	if err := validateGitBranch(ctx, worktree, branch); err != nil {
		return err
	}
	remote, err := gitOutput(ctx, "-C", worktree, "remote", "get-url", "--push", "origin")
	if err != nil || repositoryLocator(strings.TrimSpace(remote)) != expectedRemote {
		return errors.New("Git push origin does not match the project's GitHub repository")
	}
	return pushGitBranch(ctx, worktree, branch)
}

func pushGitBranch(ctx context.Context, worktree, branch string) error {
	pushCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	push := gitCommand(pushCtx, "-C", worktree, "push", "origin",
		"refs/heads/"+branch+":refs/heads/"+branch)
	push.Stdout, push.Stderr = io.Discard, io.Discard
	if err := push.Run(); err != nil {
		return errors.New("Git push failed")
	}
	return nil
}

// Agent-created nested repositories can install fsmonitor commands, so these Git children get
// neither that hook nor worker secrets.
func agentRunGitCommand(ctx context.Context, args ...string) *exec.Cmd {
	command := gitCommand(ctx, args...)
	command.Env = append(providerEnvironment(os.Environ()),
		"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=core.fsmonitor", "GIT_CONFIG_VALUE_0=false")
	return command
}

// agentIdentity is the author of every commit the worker creates on a run branch.
var agentIdentity = []string{"-c", "user.name=Zenchron Agent", "-c", "user.email=agent@zenchron.invalid", "-c", "commit.gpgsign=false"}

type boundedDiff struct {
	data      []byte
	truncated bool
}

func (buffer *boundedDiff) Write(input []byte) (int, error) {
	remaining := maxAgentRunDiffSize - len(buffer.data)
	if remaining > 0 {
		if len(input) > remaining {
			buffer.data = append(buffer.data, input[:remaining]...)
		} else {
			buffer.data = append(buffer.data, input...)
		}
	}
	if len(input) > remaining {
		buffer.truncated = true
	}
	return len(input), nil
}

// String drops a character cut in half by the raw diff limit and bytes that are not UTF-8. The final
// result encoder separately accounts for JSON escaping against the control plane's request limit.
func (buffer *boundedDiff) String() string { return strings.ToValidUTF8(string(buffer.data), "") }

func collectAgentRunDiff(ctx context.Context, worktree, baseBranch string) (string, bool, error) {
	add := agentRunGitCommand(ctx, "add", "--intent-to-add", "--", ".")
	add.Dir = worktree
	if err := add.Run(); err != nil {
		return "", false, err
	}
	mergeBase := agentRunGitCommand(ctx, "merge-base", baseBranch, "HEAD")
	mergeBase.Dir = worktree
	base, err := mergeBase.Output()
	if err != nil {
		return "", false, fmt.Errorf("find agent branch base: %w", err)
	}
	command := agentRunGitCommand(ctx, "diff", strings.TrimSpace(string(base)), "--no-ext-diff", "--no-textconv",
		"--no-color", "--ignore-submodules=all", "--")
	command.Dir = worktree
	buffer := &boundedDiff{}
	command.Stdout, command.Stderr = buffer, io.Discard
	if err := command.Run(); err != nil {
		return "", false, err
	}
	return buffer.String(), buffer.truncated, nil
}

func commitAgentRunChanges(ctx context.Context, worktree, baseBranch, runID string, attempt int) (string, error) {
	add := agentRunGitCommand(ctx, "add", "-A", "--", ".")
	add.Dir = worktree
	if err := add.Run(); err != nil {
		return "", fmt.Errorf("stage agent branch changes: %w", err)
	}
	check := agentRunGitCommand(ctx, "diff", "--cached", "--quiet")
	check.Dir = worktree
	if err := check.Run(); err != nil {
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
			return "", fmt.Errorf("check staged agent changes: %w", err)
		}
		commit := agentRunGitCommand(ctx, append(slices.Clone(agentIdentity), "commit", "-m",
			fmt.Sprintf("Agent run %s attempt %d", runID, attempt))...)
		commit.Dir = worktree
		commit.Stdout, commit.Stderr = io.Discard, io.Discard
		if err := commit.Run(); err != nil {
			return "", fmt.Errorf("create isolated agent commit: %w", err)
		}
	}
	head := agentRunGitCommand(ctx, "rev-parse", "--verify", "HEAD")
	head.Dir = worktree
	commitID, err := head.Output()
	if err != nil {
		return "", fmt.Errorf("read isolated agent commit: %w", err)
	}
	base := agentRunGitCommand(ctx, "merge-base", baseBranch, "HEAD")
	base.Dir = worktree
	baseID, err := base.Output()
	if err != nil {
		return "", fmt.Errorf("find isolated agent branch base: %w", err)
	}
	commitSHA := strings.TrimSpace(string(commitID))
	if commitSHA == strings.TrimSpace(string(baseID)) {
		return "", nil
	}
	return commitSHA, nil
}

func claimAgentRun(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID string,
) (workerapi.AgentRunCommand, bool, error) {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + workerID + "/agent-runs/claim"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
	if err != nil {
		return workerapi.AgentRunCommand{}, false, fmt.Errorf("create agent run claim: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return workerapi.AgentRunCommand{}, false, fmt.Errorf("claim agent run: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return workerapi.AgentRunCommand{}, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return workerapi.AgentRunCommand{}, false, fmt.Errorf("agent run claim returned HTTP %d", response.StatusCode)
	}
	var command workerapi.AgentRunCommand
	if err := decodeClaimResponse(response.Body, &command); err != nil {
		return workerapi.AgentRunCommand{}, false, fmt.Errorf("decode agent run claim: %w", err)
	}
	return command, true, nil
}

// decodeClaimResponse rejects a body over the claim limit as a whole. A limited reader alone would let a
// valid command followed by padding through, because the decoder stops at the end of the first value.
func decodeClaimResponse(body io.Reader, command any) error {
	data, err := io.ReadAll(io.LimitReader(body, maxClaimResponseSize+1))
	if err != nil {
		return err
	}
	if len(data) > maxClaimResponseSize {
		return fmt.Errorf("claim response exceeds %d bytes", maxClaimResponseSize)
	}
	return json.Unmarshal(data, command)
}
