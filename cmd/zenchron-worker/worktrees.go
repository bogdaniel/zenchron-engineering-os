package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
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
func prepareWorktree(ctx context.Context, root string, project discoveredProject, runID, branch, baseBranch, startCommit, repository string) error {
	if root == "" || !validID(project.ID) || !validID(runID) || !isGitCheckout(project.Path) {
		return errors.New("invalid worktree target")
	}
	if err := validateGitBranch(ctx, project.Path, branch); err != nil {
		return err
	}
	if err := validateGitBranch(ctx, project.Path, baseBranch); err != nil {
		return err
	}
	// Every path below, including a reused worktree or a retained run branch, belongs to this repository.
	if _, err := verifyOriginIdentity(ctx, project.Path, repository); err != nil {
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
		if err != nil {
			return errors.New("worktree destination belongs to a different branch")
		}
		currentBranch = strings.TrimSpace(currentBranch)
		if currentBranch == "" {
			head, headErr := gitOutput(ctx, "-C", path, "rev-parse", "HEAD")
			branchHead, branchErr := gitOutput(ctx, "-C", project.Path, "rev-parse", "--verify", "refs/heads/"+branch)
			if headErr != nil || branchErr != nil || strings.TrimSpace(head) != strings.TrimSpace(branchHead) {
				return errors.New("detached worktree does not match its run branch")
			}
			if err := gitCommand(ctx, "-C", path, "checkout", branch).Run(); err != nil {
				return fmt.Errorf("restore detached run branch: %w", err)
			}
		} else if currentBranch != branch {
			return errors.New("worktree destination belongs to a different branch")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect worktree destination: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create worktree parent: %w", err)
	}
	existingBranch, err := gitOutput(ctx, "-C", project.Path, "branch", "--list", "--format=%(refname:short)", "--", branch)
	if err != nil {
		return fmt.Errorf("check run branch: %w", err)
	}
	args := []string{"-C", project.Path, "worktree", "add", "-b", branch, path, baseBranch}
	if strings.TrimSpace(existingBranch) == branch {
		args = []string{"-C", project.Path, "worktree", "add", path, branch}
	} else if startCommit != "" {
		// The graph pinned this verified base when its first run started; later runs start from exactly it even if
		// origin has advanced since, so every unit of the graph shares one base.
		if _, err := gitOutput(ctx, "-C", project.Path, "rev-parse", "--verify", "--quiet", startCommit+"^{commit}"); err != nil {
			return baseVerificationError{fmt.Errorf("the pinned graph base %s is not in this checkout", startCommit)}
		}
		args[len(args)-1] = startCommit
	} else if !strings.HasPrefix(baseBranch, workerapi.AgentRunBranch("")) {
		// A run that starts from another run's branch inherits that parent's base without rechecking it; only a
		// product base is compared with origin here.
		start, err := verifyBaseMatchesOrigin(ctx, project.Path, baseBranch, repository)
		if err != nil {
			return err
		}
		if start != "" {
			// Branch from the exact verified commit, not the mutable branch name, so the base cannot move in between.
			args[len(args)-1] = start
		}
	}
	if _, err := gitOutput(ctx, args...); err != nil {
		return fmt.Errorf("create isolated worktree: %w", err)
	}
	return nil
}

// staleBaseError refuses a run whose local base is not exactly GitHub's default branch: behind, ahead, or diverged
// all mean the run would build on code other than what the remote holds.
type staleBaseError struct {
	branch, local, remoteBranch, remote string
}

// branchLabelForError caps variable-length branch names before formatting the refusal so neither
// full commit SHA can be pushed past the control plane's bounded error field.
func branchLabelForError(name string) string {
	const maxBytes = 32
	if len(name) <= maxBytes {
		return name
	}
	cut := maxBytes - len("…")
	for cut > 0 && !utf8.RuneStart(name[cut]) {
		cut--
	}
	return name[:cut] + "…"
}

func (err staleBaseError) Error() string {
	return fmt.Sprintf("local %s %s differs from origin/%s %s; fast-forward or reconcile the checkout, then retry",
		branchLabelForError(err.branch), err.local, branchLabelForError(err.remoteBranch), err.remote)
}

// baseVerificationError reports that the base could not be compared with GitHub, so it is not trusted.
type baseVerificationError struct{ err error }

func (err baseVerificationError) Error() string {
	return "could not verify the base against origin: " + err.err.Error()
}

func (err baseVerificationError) Unwrap() error { return err.err }

// verifyOriginIdentity reports whether origin is configured, and fails closed when a run tied to a GitHub
// repository finds origin missing or pointing at another repository.
func verifyOriginIdentity(ctx context.Context, repository, wantRepository string) (bool, error) {
	configured, err := gitOutput(ctx, "-C", repository, "config", "--get", "remote.origin.url")
	if err != nil {
		if wantRepository != "" {
			return false, baseVerificationError{fmt.Errorf("origin is not configured for %s", wantRepository)}
		}
		return false, nil
	}
	if wantRepository != "" && repositoryLocator(configured) != wantRepository {
		return true, baseVerificationError{fmt.Errorf("origin is not %s", wantRepository)}
	}
	return true, nil
}

// verifyDescendsFromPinnedBase proves a (possibly reused) run worktree's HEAD descends from the graph's pinned base.
func verifyDescendsFromPinnedBase(ctx context.Context, worktree, startCommit string) error {
	if _, err := gitOutput(ctx, "-C", worktree, "merge-base", "--is-ancestor", startCommit, "HEAD"); err != nil {
		return baseVerificationError{fmt.Errorf("the run branch does not descend from the pinned graph base %s", startCommit)}
	}
	return nil
}

// baseVerificationTimeout bounds origin's default-branch lookup and fetch, which run while the checkout is locked.
const baseVerificationTimeout = time.Minute

// verifyBaseMatchesOrigin fetches origin's default branch and requires the local base commit to equal it, returning
// that commit. Only remote-tracking metadata changes; local branches are never moved. A run tied to a GitHub
// repository fails closed when origin is missing or is another repository. A checkout without origin that no
// repository requires has nothing to compare against and returns no commit.
func verifyBaseMatchesOrigin(ctx context.Context, repository, baseBranch, wantRepository string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, baseVerificationTimeout)
	defer cancel()
	hasOrigin, err := verifyOriginIdentity(ctx, repository, wantRepository)
	if err != nil || !hasOrigin {
		return "", err
	}
	symref, err := gitOutput(ctx, "-C", repository, "ls-remote", "--symref", "origin", "HEAD")
	if err != nil {
		return "", baseVerificationError{fmt.Errorf("read origin's default branch: %w", err)}
	}
	// The first line is "ref: refs/heads/<default>\tHEAD".
	target, _, _ := strings.Cut(strings.SplitN(symref, "\n", 2)[0], "\t")
	remoteBranch, ok := strings.CutPrefix(strings.TrimPrefix(target, "ref: "), "refs/heads/")
	if !ok || remoteBranch == "" {
		return "", baseVerificationError{errors.New("origin did not report a default branch")}
	}
	if _, err := gitOutput(ctx, "-C", repository, "fetch", "--quiet", "--no-tags", "origin",
		"+refs/heads/"+remoteBranch+":refs/remotes/origin/"+remoteBranch); err != nil {
		return "", baseVerificationError{fmt.Errorf("fetch origin/%s: %w", remoteBranch, err)}
	}
	local, err := gitOutput(ctx, "-C", repository, "rev-parse", "--verify", "refs/heads/"+baseBranch+"^{commit}")
	if err != nil {
		return "", baseVerificationError{fmt.Errorf("resolve local %s: %w", baseBranch, err)}
	}
	remote, err := gitOutput(ctx, "-C", repository, "rev-parse", "--verify", "refs/remotes/origin/"+remoteBranch+"^{commit}")
	if err != nil {
		return "", baseVerificationError{fmt.Errorf("resolve origin/%s: %w", remoteBranch, err)}
	}
	if local, remote = strings.TrimSpace(local), strings.TrimSpace(remote); local != remote {
		return "", staleBaseError{branch: baseBranch, local: local, remoteBranch: remoteBranch, remote: remote}
	}
	return local, nil
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

// gitCommand is the only way the worker runs Git. Hooks are disabled: the worker's Git runs outside the
// provider sandbox with the worker's own environment, and a hook can be a script in the worktree
// (husky's core.hooksPath, a pre-commit configuration) that the agent just wrote.
func gitCommand(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "git", append([]string{"-c", "core.hooksPath=" + os.DevNull}, args...)...)
}

func gitOutput(ctx context.Context, args ...string) (string, error) {
	output, err := gitCommand(ctx, args...).Output()
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

// ponytail: one lifecycle lock per project serializes setup and cleanup; shard by run if project contention grows.
func lockWorktreeLifecycle(ctx context.Context, root, projectID string) (*os.File, error) {
	if !validID(projectID) {
		return nil, errors.New("invalid worktree project id")
	}
	projectRoot := filepath.Join(root, projectID)
	if err := os.MkdirAll(projectRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create worktree project directory: %w", err)
	}
	lock, err := os.OpenFile(filepath.Join(projectRoot, ".lifecycle.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open worktree lifecycle lock: %w", err)
	}
	ticker := time.NewTicker(ownerPollInterval)
	defer ticker.Stop()
	for {
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			return lock, nil
		} else if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return nil, errors.Join(fmt.Errorf("lock worktree lifecycle: %w", err), lock.Close())
		}
		select {
		case <-ctx.Done():
			return nil, errors.Join(ctx.Err(), lock.Close())
		case <-ticker.C:
		}
	}
}

// cleanupWorktrees removes run worktrees that Git considers safe to remove: not locked by a running or
// crashed attempt and without modified or untracked files. Run branches and their commits are kept.
func cleanupWorktrees(ctx context.Context, root string, projects []discoveredProject) (removed, kept []string, err error) {
	var cleanupErr error
	for _, project := range projects {
		projectRoot := filepath.Join(root, project.ID)
		if _, statErr := os.Stat(projectRoot); errors.Is(statErr, os.ErrNotExist) {
			continue
		} else if statErr != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("inspect worktrees for %s: %w", project.Name, statErr))
			continue
		}
		lifecycleLock, lockErr := lockWorktreeLifecycle(ctx, root, project.ID)
		if lockErr != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("lock worktrees for %s: %w", project.Name, lockErr))
			continue
		}
		entries, readErr := os.ReadDir(projectRoot)
		if errors.Is(readErr, os.ErrNotExist) {
			if closeErr := lifecycleLock.Close(); closeErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close worktree lifecycle lock for %s: %w", project.Name, closeErr))
			}
			continue
		}
		if readErr != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("read worktrees for %s: %w", project.Name, readErr))
			if closeErr := lifecycleLock.Close(); closeErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close worktree lifecycle lock for %s: %w", project.Name, closeErr))
			}
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !validID(entry.Name()) {
				continue
			}
			label := project.Name + "/" + entry.Name()
			path := filepath.Join(root, project.ID, entry.Name())
			ownerPath := path + ".owner"
			ownerLock, lockErr := os.OpenFile(ownerPath, os.O_RDWR|os.O_CREATE, 0o600)
			if lockErr != nil {
				kept = append(kept, label)
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("open ownership lock for %s: %w", label, lockErr))
				continue
			}
			if lockErr = syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); lockErr != nil {
				closeErr := ownerLock.Close()
				if errors.Is(lockErr, syscall.EWOULDBLOCK) || errors.Is(lockErr, syscall.EAGAIN) {
					kept = append(kept, label)
					if closeErr != nil {
						cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close ownership lock for %s: %w", label, closeErr))
					}
					continue
				}
				kept = append(kept, label)
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("lock ownership file for %s: %w", label, lockErr))
				if closeErr != nil {
					cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close ownership lock for %s: %w", label, closeErr))
				}
				continue
			}
			if _, removeErr := gitOutput(ctx, "-C", project.Path, "worktree", "remove", path); removeErr != nil {
				kept = append(kept, label)
				if closeErr := ownerLock.Close(); closeErr != nil {
					cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close ownership lock for %s: %w", label, closeErr))
				}
				continue
			}
			removed = append(removed, label)
			if removeErr := removeWorktreeOwnershipFiles(path); removeErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("remove ownership files for %s: %w", label, removeErr))
			}
			if closeErr := ownerLock.Close(); closeErr != nil {
				cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close ownership lock for %s: %w", label, closeErr))
			}
		}
		if closeErr := lifecycleLock.Close(); closeErr != nil {
			cleanupErr = errors.Join(cleanupErr, fmt.Errorf("close worktree lifecycle lock for %s: %w", project.Name, closeErr))
		}
	}
	return removed, kept, cleanupErr
}

func removeWorktreeOwnershipFiles(worktree string) error {
	var err error
	for _, path := range []string{worktree + ".owner.processes", worktree + ".owner"} {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, fmt.Errorf("remove %s: %w", path, removeErr))
		}
	}
	return err
}
