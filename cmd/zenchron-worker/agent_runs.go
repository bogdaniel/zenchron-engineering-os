package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const (
	maxAgentRunOutputSize = 20_000
	maxAgentRunDiffSize   = 128 << 10
)

type agentRuntime struct {
	endpoint *url.URL
	apiKey   string
	client   *http.Client
}

func loadAgentRuntime() (*agentRuntime, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(os.Getenv("ZENCHRON_LLM_BASE_URL")), "/")
	apiKey := strings.TrimSpace(os.Getenv("ZENCHRON_LLM_API_KEY"))
	if baseURL == "" {
		if apiKey != "" {
			return nil, errors.New("ZENCHRON_LLM_API_KEY requires ZENCHRON_LLM_BASE_URL")
		}
		return nil, nil
	}
	endpoint, err := url.ParseRequestURI(baseURL)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && isLoopbackModelHost(endpoint.Hostname()))) {
		return nil, errors.New("ZENCHRON_LLM_BASE_URL must be HTTPS or loopback HTTP without credentials or query data")
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/chat/completions"
	return &agentRuntime{endpoint: endpoint, apiKey: apiKey, client: &http.Client{Timeout: 45 * time.Second}}, nil
}

func isLoopbackModelHost(host string) bool {
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

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
	push := exec.CommandContext(pushCtx, "git", "-C", worktree, "push", "origin",
		"refs/heads/"+branch+":refs/heads/"+branch)
	push.Stdout, push.Stderr = io.Discard, io.Discard
	if err := push.Run(); err != nil {
		return errors.New("Git push failed")
	}
	return nil
}

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

func (buffer *boundedDiff) String() string { return string(buffer.data) }

func collectAgentRunDiff(ctx context.Context, worktree, baseBranch string) (string, bool, error) {
	add := exec.CommandContext(ctx, "git", "add", "--intent-to-add", "--", ".")
	add.Dir = worktree
	if err := add.Run(); err != nil {
		return "", false, err
	}
	mergeBase := exec.CommandContext(ctx, "git", "merge-base", baseBranch, "HEAD")
	mergeBase.Dir = worktree
	base, err := mergeBase.Output()
	if err != nil {
		return "", false, fmt.Errorf("find agent branch base: %w", err)
	}
	command := exec.CommandContext(ctx, "git", "diff", strings.TrimSpace(string(base)), "--no-ext-diff", "--no-color", "--")
	command.Dir = worktree
	buffer := &boundedDiff{}
	command.Stdout, command.Stderr = buffer, io.Discard
	if err := command.Run(); err != nil {
		return "", false, err
	}
	return buffer.String(), buffer.truncated, nil
}

func commitAgentRunChanges(ctx context.Context, worktree, baseBranch, runID string, attempt int) (string, error) {
	add := exec.CommandContext(ctx, "git", "add", "-A", "--", ".")
	add.Dir = worktree
	if err := add.Run(); err != nil {
		return "", fmt.Errorf("stage agent branch changes: %w", err)
	}
	check := exec.CommandContext(ctx, "git", "diff", "--cached", "--quiet")
	check.Dir = worktree
	if err := check.Run(); err != nil {
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) || exitError.ExitCode() != 1 {
			return "", fmt.Errorf("check staged agent changes: %w", err)
		}
		commit := exec.CommandContext(ctx, "git", "-c", "user.name=Zenchron Agent", "-c",
			"user.email=agent@zenchron.invalid", "-c", "commit.gpgsign=false", "commit", "-m",
			fmt.Sprintf("Agent run %s attempt %d", runID, attempt))
		commit.Dir = worktree
		commit.Stdout, commit.Stderr = io.Discard, io.Discard
		if err := commit.Run(); err != nil {
			return "", fmt.Errorf("create isolated agent commit: %w", err)
		}
	}
	head := exec.CommandContext(ctx, "git", "rev-parse", "--verify", "HEAD")
	head.Dir = worktree
	commitID, err := head.Output()
	if err != nil {
		return "", fmt.Errorf("read isolated agent commit: %w", err)
	}
	base := exec.CommandContext(ctx, "git", "merge-base", baseBranch, "HEAD")
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
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&command); err != nil {
		return workerapi.AgentRunCommand{}, false, fmt.Errorf("decode agent run claim: %w", err)
	}
	return command, true, nil
}
