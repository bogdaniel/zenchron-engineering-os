package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// fakeSandboxCLI installs a stand-in for `codex sandbox ... -- command` and returns its path.
func fakeSandboxCLI(t *testing.T, script string) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "fake-codex")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"+script), 0o700); err != nil {
		t.Fatal(err)
	}
	return binary
}

func TestConfinementSelfTestRejectsASandboxThatDoesNotConfine(t *testing.T) {
	// Runs the command with no sandbox at all: the denied file is read and the outside write succeeds.
	unconfined := fakeSandboxCLI(t, `while [ "$1" != "--" ]; do shift; done; shift; exec "$@"`)
	if err := verifyCodexConfinement(context.Background(), unconfined); err == nil ||
		!strings.Contains(err.Error(), "read a denied file") {
		t.Errorf("an unconfined sandbox passed the self-test: %v", err)
	}
	// Confines reads but not writes.
	writesAnywhere := fakeSandboxCLI(t, `while [ "$1" != "--" ]; do shift; done; echo x > "$7"; echo x > "$8"`)
	if err := verifyCodexConfinement(context.Background(), writesAnywhere); err == nil ||
		!strings.Contains(err.Error(), "write outside the workspace") {
		t.Errorf("a sandbox that allows outside writes passed the self-test: %v", err)
	}
	// A sandbox subcommand that does not run the command proves nothing.
	if err := verifyCodexConfinement(context.Background(), fakeSandboxCLI(t, "exit 0")); err == nil ||
		!strings.Contains(err.Error(), "could not write inside the workspace") {
		t.Errorf("a sandbox that ran nothing passed the self-test: %v", err)
	}
	// Only the workspace write happens: this is what a confining sandbox looks like.
	confined := fakeSandboxCLI(t, `while [ "$1" != "--" ]; do shift; done; echo x > "$8"`)
	if err := verifyCodexConfinement(context.Background(), confined); err != nil {
		t.Errorf("a confining sandbox failed the self-test: %v", err)
	}
}

func TestProviderIsNotReadyWhenItsSandboxSelfTestFails(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	provider := newCLIProviders()[workerapi.ProviderCodex]
	provider.detect(context.Background())
	if status := provider.status(); status.Ready || status.SandboxedCommands || status.Reason != "sandbox self-test failed" {
		t.Fatalf("status of a signed-in provider with a failing sandbox = %#v", status)
	}
}

// The remaining tests in this group run the installed Codex CLI's real sandbox. They need no model
// call and no sign-in, and are skipped where the CLI is not installed, as in CI.
func installedCodex(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("the Codex CLI is not installed")
	}
	return path
}

func TestInstalledCodexSandboxPassesTheConfinementSelfTest(t *testing.T) {
	if err := verifyCodexConfinement(context.Background(), installedCodex(t)); err != nil {
		t.Fatal(err)
	}
}

func TestInstalledCodexSandboxCannotReadOtherCheckoutsOrTheHomeDirectory(t *testing.T) {
	codex := installedCodex(t)
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Skip("no user cache directory")
	}
	// A file under the real home directory, which a run must never read.
	homeSecret, err := os.CreateTemp(cache, "zenchron-confinement-home-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(homeSecret.Name()) })
	_, _ = homeSecret.WriteString("canary-home")
	homeSecret.Close()
	// An unrelated project checkout and another run's worktree, both outside the home directory.
	base := t.TempDir()
	otherProject, worktreeRoot := filepath.Join(base, "projects", "other"), filepath.Join(base, "worktrees")
	worktree, otherRun := filepath.Join(worktreeRoot, "project", "run"), filepath.Join(worktreeRoot, "project", "other-run")
	for path, content := range map[string]string{
		filepath.Join(otherProject, ".env"): "canary-project", filepath.Join(otherRun, "notes.txt"): "canary-run",
		filepath.Join(worktree, "README.md"): "canary-own-worktree",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	workspace := runWorkspace{path: worktree,
		denyPaths: confidentialRoots(worktreeRoot, []discoveredProject{{Path: otherProject}})}
	script := `cat "$1" "$2" "$3" "$4"; echo x > "$5"; echo x > "$6"; echo x > written.txt`
	probe := exec.Command(codex, "sandbox", "-c", `default_permissions="zenchron"`, "-c",
		"permissions.zenchron.filesystem="+codexFilesystemProfile(workspace, true), "--", "/bin/sh", "-c", script, "sh",
		homeSecret.Name(), filepath.Join(otherProject, ".env"), filepath.Join(otherRun, "notes.txt"),
		filepath.Join(worktree, "README.md"), filepath.Join(otherProject, "written.txt"), filepath.Join(otherRun, "written.txt"))
	probe.Dir = worktree
	output, _ := probe.CombinedOutput()
	if !strings.Contains(string(output), "canary-own-worktree") {
		t.Fatalf("the sandboxed command could not read its own worktree: %s", output)
	}
	for _, canary := range []string{"canary-home", "canary-project", "canary-run"} {
		if strings.Contains(string(output), canary) {
			t.Errorf("the sandbox exposed %s", canary)
		}
	}
	for _, path := range []string{filepath.Join(otherProject, "written.txt"), filepath.Join(otherRun, "written.txt")} {
		if _, err := os.Stat(path); err == nil {
			t.Errorf("the sandbox allowed a write to %s", path)
		}
	}
	if _, err := os.Stat(filepath.Join(worktree, "written.txt")); err != nil {
		t.Errorf("the sandbox refused a write inside the worktree: %v", err)
	}
}

func TestConfidentialRootsCoverHomeWorktreesAndEveryCheckout(t *testing.T) {
	home, _ := os.UserHomeDir()
	roots := confidentialRoots("/var/worktrees", []discoveredProject{{Path: "/srv-other/api"}, {Path: "/srv-other/web"}})
	for _, want := range []string{home, "/var/worktrees", "/srv-other/api", "/srv-other/web"} {
		if !slices.Contains(roots, want) {
			t.Errorf("confidential roots %v lack %s", roots, want)
		}
	}
	if !slices.IsSorted(roots) || len(slices.Compact(slices.Clone(roots))) != len(roots) {
		t.Errorf("confidential roots are not sorted and unique: %v", roots)
	}
}

func TestProviderArgumentsBoundAgentPermissions(t *testing.T) {
	home, _ := os.UserHomeDir()
	workspace := runWorkspace{path: "/work/tree", readPaths: []string{"/repo/.git", home + "/go/pkg/mod"},
		denyPaths: []string{home, "/Volumes"}, commandSandbox: true}
	write := workerapi.AgentRunCommand{Profile: workerapi.AgentProfile{Model: "gpt-test", Tools: []string{"code.write"}}}
	read := workerapi.AgentRunCommand{Profile: workerapi.AgentProfile{Model: defaultModel}}

	codexWrite, codexRead := codexArguments(write, workspace), codexArguments(read, workspace)
	if strings.Join(codexWrite[:6], " ") != `exec --json --color never -c default_permissions="zenchron"` ||
		!slices.Contains(codexWrite, "--model=gpt-test") || codexWrite[len(codexWrite)-1] != "-" ||
		slices.Contains(codexRead, "--model=default") || strings.Contains(strings.Join(codexWrite, " "), "--sandbox") ||
		strings.Contains(strings.Join(codexWrite, " "), "dangerously") {
		t.Fatalf("codex arguments = %v / %v", codexWrite, codexRead)
	}
	profile := func(arguments []string) string {
		index := slices.IndexFunc(arguments, func(argument string) bool {
			return strings.HasPrefix(argument, "permissions.zenchron.filesystem=")
		})
		if index < 0 || arguments[index-1] != "-c" {
			t.Fatalf("codex arguments lack the filesystem profile: %v", arguments)
		}
		return strings.TrimPrefix(arguments[index], "permissions.zenchron.filesystem=")
	}
	for _, entry := range []string{`"/"="read"`, strconv.Quote(home) + `="none"`, `"/Volumes"="none"`, `"/work/tree"="write"`,
		strconv.Quote(os.TempDir()) + `="write"`, `"/repo/.git"="read"`, strconv.Quote(home+"/go/pkg/mod") + `="read"`} {
		if !strings.Contains(profile(codexWrite), entry) {
			t.Errorf("codex write profile %s lacks %s", profile(codexWrite), entry)
		}
	}
	if !strings.Contains(profile(codexRead), `"/work/tree"="read"`) || strings.Contains(profile(codexRead), `"/work/tree"="write"`) {
		t.Errorf("codex read-only profile grants writes: %s", profile(codexRead))
	}
	hostile := profile(codexArguments(write, runWorkspace{path: `/work/a"="write","/"="write`}))
	if strings.Contains(hostile, `"/"="write"`) {
		t.Errorf("a worktree path could rewrite the profile: %s", hostile)
	}

	claudeWrite, claudeRead := strings.Join(claudeArguments(write, workspace), " "), strings.Join(claudeArguments(read, workspace), " ")
	if !strings.Contains(claudeWrite, "--permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep --model=gpt-test") ||
		!strings.Contains(claudeRead, "--permission-mode default --tools Read,Glob,Grep") ||
		strings.Contains(claudeWrite+claudeRead, "Bash") || strings.Contains(claudeWrite+claudeRead, "dangerously") ||
		!strings.Contains(claudeRead, "--strict-mcp-config") ||
		!strings.Contains(claudeWrite, `--settings {"disableAllHooks":true}`) || !strings.Contains(claudeRead, `--settings {"disableAllHooks":true}`) {
		t.Errorf("claude arguments = %s / %s", claudeWrite, claudeRead)
	}
	// Shell access is offered only together with settings that force every command into the sandbox.
	tests := workerapi.AgentRunCommand{Profile: workerapi.AgentProfile{Model: defaultModel, Tools: []string{"code.write", "tests.run"}}}
	arguments := claudeArguments(tests, workspace)
	settingsIndex := slices.Index(arguments, "--settings")
	if settingsIndex < 0 || !slices.Contains(arguments, "Read,Edit,Write,Glob,Grep,Bash") {
		t.Fatalf("claude test-running arguments = %v", arguments)
	}
	type sandboxSettings struct {
		DisableAllHooks bool `json:"disableAllHooks"`
		Sandbox         struct {
			Enabled                  bool  `json:"enabled"`
			FailIfUnavailable        bool  `json:"failIfUnavailable"`
			AllowUnsandboxedCommands *bool `json:"allowUnsandboxedCommands"`
			Filesystem               struct {
				DenyRead, AllowRead, AllowWrite, DenyWrite []string
			} `json:"filesystem"`
		} `json:"sandbox"`
	}
	var settings sandboxSettings
	if err := json.Unmarshal([]byte(arguments[settingsIndex+1]), &settings); err != nil || !settings.Sandbox.Enabled || !settings.DisableAllHooks ||
		!settings.Sandbox.FailIfUnavailable ||
		settings.Sandbox.AllowUnsandboxedCommands == nil || *settings.Sandbox.AllowUnsandboxedCommands ||
		!slices.Equal(settings.Sandbox.Filesystem.DenyRead, []string{home, "/Volumes"}) ||
		!slices.Equal(settings.Sandbox.Filesystem.AllowRead, []string{"/work/tree", "/repo/.git", home + "/go/pkg/mod"}) ||
		!slices.Equal(settings.Sandbox.Filesystem.AllowWrite, []string{os.TempDir()}) {
		t.Fatalf("claude sandbox settings = %s, %v", arguments[settingsIndex+1], err)
	}
	// Writes are denied in every confidential location except those that contain the worktree itself.
	nested := workspace
	nested.denyPaths = []string{"/Volumes", "/work", "/work/tree-other"}
	arguments = claudeArguments(tests, nested)
	var nestedSettings sandboxSettings
	if err := json.Unmarshal([]byte(arguments[slices.Index(arguments, "--settings")+1]), &nestedSettings); err != nil ||
		!slices.Equal(settings.Sandbox.Filesystem.DenyWrite, []string{home, "/Volumes"}) ||
		!slices.Equal(nestedSettings.Sandbox.Filesystem.DenyWrite, []string{"/Volumes", "/work/tree-other"}) {
		t.Errorf("claude write denials = %v and %v, %v", settings.Sandbox.Filesystem.DenyWrite, nestedSettings.Sandbox.Filesystem.DenyWrite, err)
	}
	var fallback sandboxSettings
	if err := json.Unmarshal([]byte(claudeSandboxFallback), &fallback); err != nil || !fallback.Sandbox.Enabled ||
		!fallback.Sandbox.FailIfUnavailable || fallback.Sandbox.AllowUnsandboxedCommands == nil || *fallback.Sandbox.AllowUnsandboxedCommands {
		t.Errorf("the fallback settings would allow an unconfined shell: %s, %v", claudeSandboxFallback, err)
	}
	readOnlyTests := workerapi.AgentRunCommand{Profile: workerapi.AgentProfile{Model: defaultModel, Tools: []string{"tests.run"}}}
	if strings.Contains(strings.Join(claudeArguments(readOnlyTests, workspace), " "), "Bash") {
		t.Error("a profile without code.write was offered a shell")
	}
	// Where the sandbox backend is missing, no shell is offered and no sandbox settings are needed.
	workspace.commandSandbox = false
	if unsandboxed := strings.Join(claudeArguments(tests, workspace), " "); strings.Contains(unsandboxed, "Bash") ||
		!strings.Contains(unsandboxed, `--settings {"disableAllHooks":true}`) {
		t.Errorf("a worker without the sandbox backend offered a shell: %s", unsandboxed)
	}
}

func TestWorkerConfigReadPathsMustBeAbsoluteAndClean(t *testing.T) {
	write := func(paths string) {
		t.Helper()
		path := filepath.Join(t.TempDir(), "worker.json")
		content := `{"repositories":{"github.com/acme/api":{"read_paths":` + paths + `}}}`
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("ZENCHRON_WORKER_CONFIG", path)
	}
	write(`["/home/dev/go/pkg/mod"]`)
	config, err := loadWorkerConfig()
	if err != nil || !slices.Equal(config.readPaths("github.com/acme/api"), []string{"/home/dev/go/pkg/mod"}) ||
		config.readPaths("github.com/acme/other") != nil {
		t.Fatalf("read paths = %#v, %v", config, err)
	}
	for _, invalid := range []string{`["relative/cache"]`, `["/"]`, `["/home/dev/../../etc"]`, `["/home/dev/"]`} {
		write(invalid)
		if _, err := loadWorkerConfig(); err == nil {
			t.Errorf("read paths %s were accepted", invalid)
		}
	}
}
