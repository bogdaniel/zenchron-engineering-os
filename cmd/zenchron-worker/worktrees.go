package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const worktreePreparationTimeout = 8 * time.Minute

type worktreeCommand struct {
	ID         string `json:"id"`
	ProjectID  string `json:"project_id"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"base_branch"`
	Attempts   int    `json:"attempts"`
}

func processWorktreeCommand(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID string, projects []discoveredProject,
) error {
	command, found, err := claimWorktreeCommand(ctx, client, baseURL, workerID)
	if err != nil || !found {
		return err
	}
	var project *discoveredProject
	for i := range projects {
		if projects[i].ID == command.ProjectID {
			project = &projects[i]
			break
		}
	}
	if project == nil {
		return sendWorktreeResult(ctx, client, baseURL, workerID, command.ID, command.Attempts,
			"failed", "project checkout is unavailable")
	}
	commandCtx, cancel := context.WithTimeout(ctx, worktreePreparationTimeout)
	defer cancel()
	root, err := worktreeRoot()
	if err == nil {
		err = prepareWorktree(commandCtx, root, *project, command)
	}
	if err != nil {
		return sendWorktreeResult(ctx, client, baseURL, workerID, command.ID, command.Attempts,
			"failed", "worktree preparation failed")
	}
	return sendWorktreeResult(ctx, client, baseURL, workerID, command.ID, command.Attempts, "ready", "")
}

func claimWorktreeCommand(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID string,
) (worktreeCommand, bool, error) {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + workerID + "/worktrees/claim"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), nil)
	if err != nil {
		return worktreeCommand{}, false, fmt.Errorf("create worktree claim: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return worktreeCommand{}, false, fmt.Errorf("claim worktree request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		return worktreeCommand{}, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return worktreeCommand{}, false, fmt.Errorf("worktree claim returned HTTP %d", response.StatusCode)
	}
	var command worktreeCommand
	if err := decodeClaimResponse(response.Body, &command); err != nil {
		return worktreeCommand{}, false, fmt.Errorf("decode worktree command: %w", err)
	}
	return command, true, nil
}

func sendWorktreeResult(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID, requestID string, attempts int,
	status, message string,
) error {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + workerID + "/worktrees/" + requestID
	body, err := json.Marshal(struct {
		Status   string `json:"status"`
		Error    string `json:"error,omitempty"`
		Attempts int    `json:"attempts"`
	}{Status: status, Error: message, Attempts: attempts})
	if err != nil {
		return fmt.Errorf("encode worktree result: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create worktree result: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("send worktree result: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("worktree result returned HTTP %d", response.StatusCode)
	}
	return nil
}

func worktreeRoot() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("ZENCHRON_WORKTREES_ROOT")); configured != "" {
		return filepath.Abs(configured)
	}
	cacheDirectory, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("find cache directory: %w", err)
	}
	return filepath.Join(cacheDirectory, "zenchron", "worktrees"), nil
}

func prepareWorktree(ctx context.Context, root string, project discoveredProject, command worktreeCommand) error {
	if root == "" || !validID(project.ID) || !validID(command.ID) || command.ProjectID != project.ID ||
		!isGitCheckout(project.Path) {
		return errors.New("invalid worktree target")
	}
	if err := validateGitBranch(ctx, project.Path, command.Branch); err != nil {
		return err
	}
	if err := validateGitBranch(ctx, project.Path, command.BaseBranch); err != nil {
		return err
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve worktree root: %w", err)
	}
	path := filepath.Join(absoluteRoot, project.ID, command.ID)
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() {
			return errors.New("worktree destination is not a directory")
		}
		currentBranch, err := gitOutput(ctx, "-C", path, "branch", "--show-current")
		if err != nil || strings.TrimSpace(currentBranch) != command.Branch {
			return errors.New("worktree destination belongs to a different branch")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect worktree destination: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create worktree parent: %w", err)
	}
	args := []string{"-C", project.Path, "worktree", "add", "-b", command.Branch, path, command.BaseBranch}
	if _, err := gitOutput(ctx, args...); err != nil {
		return fmt.Errorf("create isolated worktree: %w", err)
	}
	return nil
}

func validateGitBranch(ctx context.Context, repository, branch string) error {
	if branch == "" || len(branch) > 255 {
		return errors.New("branch name is invalid")
	}
	if _, err := gitOutput(ctx, "-C", repository, "check-ref-format", "--branch", branch); err != nil {
		return errors.New("branch name is invalid")
	}
	return nil
}

func gitOutput(ctx context.Context, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, "git", args...).Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func validID(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 16
}

// lockWorktree marks a worktree as in use with Git's own lock so cleanup never removes the worktree of a
// running attempt. A worker that crashes leaves the lock in place, which keeps that worktree too.
func lockWorktree(repository, worktree string) (unlock func()) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	// A crashed earlier attempt leaves the worktree locked; locking again fails harmlessly.
	_, _ = gitOutput(ctx, "-C", repository, "worktree", "lock", "--reason", "zenchron run in progress", worktree)
	return func() {
		unlockCtx, cancelUnlock := context.WithTimeout(context.Background(), time.Minute)
		defer cancelUnlock()
		if _, err := gitOutput(unlockCtx, "-C", repository, "worktree", "unlock", worktree); err != nil {
			log.Printf("unlock worktree for %s: %v", filepath.Base(worktree), err)
		}
	}
}

// cleanupWorktrees removes run worktrees that Git considers safe to remove: not locked by a running or
// crashed attempt and without modified or untracked files. Run branches and their commits are kept.
func cleanupWorktrees(ctx context.Context, root string, projects []discoveredProject) (removed, kept []string, err error) {
	for _, project := range projects {
		entries, readErr := os.ReadDir(filepath.Join(root, project.ID))
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			return removed, kept, fmt.Errorf("read worktrees for %s: %w", project.Name, readErr)
		}
		for _, entry := range entries {
			if !entry.IsDir() || !validID(entry.Name()) {
				continue
			}
			label := project.Name + "/" + entry.Name()
			path := filepath.Join(root, project.ID, entry.Name())
			if _, removeErr := gitOutput(ctx, "-C", project.Path, "worktree", "remove", path); removeErr != nil {
				kept = append(kept, label)
				continue
			}
			removed = append(removed, label)
		}
	}
	return removed, kept, nil
}
