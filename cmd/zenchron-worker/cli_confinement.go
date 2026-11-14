package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
)

// sharedDataRoots are where operating systems keep other users' files and mounted volumes. They are
// denied as a whole; system directories such as /usr and /etc stay readable because tools need them.
var sharedDataRoots = []string{"/Users", "/Volumes", "/home", "/root", "/mnt", "/media", "/srv"}

// credentialDirectoryVariables name directories where the CLIs and other tools keep sign-ins and
// configuration. They are passed to the provider, which needs them, and denied to its sandboxed commands.
var credentialDirectoryVariables = []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
	"XDG_STATE_HOME", "XDG_CACHE_HOME"}

// confidentialRoots lists what no provider sandbox may read: every home directory and mounted volume,
// the CLIs' configuration directories, every checkout this worker serves, and the directory holding
// all run worktrees. A run's own worktree and its read paths are re-allowed by a more specific rule.
func confidentialRoots(worktreeRoot string, projects []discoveredProject) []string {
	roots := []string{worktreeRoot}
	// A checkout or configuration directory reached through a symbolic link is denied under both names.
	addResolved := func(path string) {
		roots = append(roots, path)
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			roots = append(roots, resolved)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" && home != "/" {
		roots = append(roots, home)
	}
	for _, root := range sharedDataRoots {
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			roots = append(roots, root)
		}
	}
	for _, variable := range credentialDirectoryVariables {
		if directory := os.Getenv(variable); filepath.IsAbs(directory) && filepath.Clean(directory) != "/" {
			addResolved(filepath.Clean(directory))
		}
	}
	for _, project := range projects {
		addResolved(project.Path)
	}
	slices.Sort(roots)
	return slices.Compact(roots)
}

const confinementCanary = "zenchron-confinement-canary"

// verifyCodexConfinement runs one shell command under Codex's own sandbox with the same filesystem
// profile a run gets, and fails unless the sandbox let it write inside the workspace, refused a write
// outside it, and refused to read a denied file next to it. It needs no model call. Passing arguments
// alone would not show that this Codex version on this operating system enforces them.
func verifyCodexConfinement(ctx context.Context, binary string) error {
	base, err := os.MkdirTemp("", "zenchron-confinement-")
	if err != nil {
		return fmt.Errorf("create sandbox self-test directory: %w", err)
	}
	defer os.RemoveAll(base)
	denied := filepath.Join(base, "denied")
	workspace := runWorkspace{path: filepath.Join(denied, "workspace"), denyPaths: []string{denied}}
	secret, outside, inside := filepath.Join(denied, "secret.txt"), filepath.Join(denied, "written.txt"), filepath.Join(workspace.path, "written.txt")
	if err := os.MkdirAll(workspace.path, 0o700); err != nil {
		return fmt.Errorf("create sandbox self-test workspace: %w", err)
	}
	if err := os.WriteFile(secret, []byte(confinementCanary), 0o600); err != nil {
		return fmt.Errorf("create sandbox self-test fixture: %w", err)
	}
	probeCtx, cancel := context.WithTimeout(ctx, cliDetectionTimeout)
	defer cancel()
	probe := exec.CommandContext(probeCtx, binary, "sandbox", "-c", `default_permissions="zenchron"`,
		"-c", "permissions.zenchron.filesystem="+codexFilesystemProfile(workspace, true), "--",
		"/bin/sh", "-c", `cat "$1"; echo x > "$2"; echo x > "$3"`, "sh", secret, outside, inside)
	probe.Dir, probe.Env = workspace.path, providerEnvironment(os.Environ())
	output, _ := probe.CombinedOutput()
	if _, err := os.Stat(inside); err != nil {
		return fmt.Errorf("codex sandbox self-test: the sandboxed command could not write inside the workspace: %w", err)
	}
	if bytes.Contains(output, []byte(confinementCanary)) {
		return errors.New("codex sandbox self-test: the sandbox let a command read a denied file")
	}
	if _, err := os.Stat(outside); !errors.Is(err, os.ErrNotExist) {
		return errors.New("codex sandbox self-test: the sandbox let a command write outside the workspace")
	}
	return nil
}

// claudeSandboxAvailable reports whether Claude Code's shell sandbox has its operating-system backend:
// Seatbelt on macOS, bubblewrap with socat on Linux. Elsewhere Claude Code gets no shell at all.
func claudeSandboxAvailable() bool {
	switch runtime.GOOS {
	case "darwin":
		_, err := exec.LookPath("sandbox-exec")
		return err == nil
	case "linux":
		_, bubblewrapErr := exec.LookPath("bwrap")
		_, socatErr := exec.LookPath("socat")
		return bubblewrapErr == nil && socatErr == nil
	default:
		return false
	}
}
