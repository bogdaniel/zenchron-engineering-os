package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

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

// prepareWorktree creates the worktree of one run at root/<project id>/<run id>, on a new branch from
// baseBranch. A worktree that already exists on that branch is reused, so a later attempt continues in it.
func prepareWorktree(ctx context.Context, root string, project discoveredProject, runID, branch, baseBranch string) error {
	if root == "" || !validID(project.ID) || !validID(runID) || !isGitCheckout(project.Path) {
		return errors.New("invalid worktree target")
	}
	if err := validateGitBranch(ctx, project.Path, branch); err != nil {
		return err
	}
	if err := validateGitBranch(ctx, project.Path, baseBranch); err != nil {
		return err
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve worktree root: %w", err)
	}
	path := filepath.Join(absoluteRoot, project.ID, runID)
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() {
			return errors.New("worktree destination is not a directory")
		}
		currentBranch, err := gitOutput(ctx, "-C", path, "branch", "--show-current")
		if err != nil || strings.TrimSpace(currentBranch) != branch {
			return errors.New("worktree destination belongs to a different branch")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect worktree destination: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create worktree parent: %w", err)
	}
	args := []string{"-C", project.Path, "worktree", "add", "-b", branch, path, baseBranch}
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
