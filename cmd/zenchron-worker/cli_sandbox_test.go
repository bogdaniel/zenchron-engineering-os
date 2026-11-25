package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

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

func TestConfinementSelfTestPreservesEscapeEvidenceWhenCommandFails(t *testing.T) {
	leaksThenFails := fakeSandboxCLI(t, `while [ "$1" != "--" ]; do shift; done; shift; "$@"; exit 1`)
	if err := verifyCodexConfinement(context.Background(), leaksThenFails); !errors.Is(err, errConfinementViolation) {
		t.Fatalf("sandbox escape followed by a failed command was not latched as a confinement violation: %v", err)
	}
}

func TestConfinementSelfTestStopsDescendantsOnCancellation(t *testing.T) {
	directory := t.TempDir()
	release := filepath.Join(directory, "release")
	pidFile := filepath.Join(directory, "child.pid")
	t.Cleanup(func() {
		if err := os.WriteFile(release, nil, 0o600); err != nil {
			t.Error(err)
		}
	})
	script := "/bin/sh -c 'while [ ! -f \"$1\" ]; do sleep 0.01; done' sh " + strconv.Quote(release) +
		" &\necho $! > " + strconv.Quote(pidFile) + "\nwait\n"
	binary := fakeSandboxCLI(t, script)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- verifyCodexConfinement(ctx, binary) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(pidFile); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(pidFile); err != nil {
		cancel()
		t.Fatal("sandbox probe descendant did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		if err := os.WriteFile(release, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("cancelled confinement probe waited on a descendant's inherited output pipes")
		}
		t.Fatal("cancelled confinement probe did not stop its descendant promptly")
	}
	contents, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	var childPID int
	if _, err := fmt.Sscanf(string(contents), "%d", &childPID); err != nil {
		t.Fatal(err)
	}
	waitForProcessExit(t, childPID)
}

func TestProviderLatchesConfirmedSandboxEscapeAtContextExpiry(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "codex")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, phase := range []string{"startup", "heartbeat"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			provider := newCLIProviders()[workerapi.ProviderCodex]
			provider.confinement = func(context.Context, string) error {
				cancel()
				return errConfinementViolation
			}
			if phase == "startup" {
				provider.detect(ctx)
			} else {
				provider.path = binary
				provider.setReadiness(false, false, "sandbox verification pending")
				provider.refreshReadiness(ctx)
			}
			provider.readinessMu.RLock()
			ready, reason := provider.ready, provider.reason
			provider.readinessMu.RUnlock()
			if ready || reason != "sandbox self-test failed" {
				t.Fatalf("confirmed sandbox escape at context expiry = ready %t, reason %q", ready, reason)
			}
		})
	}
}

func TestRunnerChecksProviderReadinessConcurrently(t *testing.T) {
	directory := t.TempDir()
	startedPath := filepath.Join(directory, "started")
	releasePath := filepath.Join(directory, "release")
	providers := map[string]*cliProvider{}
	for _, id := range []string{workerapi.ProviderCodex, workerapi.ProviderClaude} {
		path := filepath.Join(directory, id)
		script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' '%s' >> '%s'\nwhile [ ! -e '%s' ]; do sleep 0.01; done\nprintf '{\"loggedIn\":true}\n'\n", id, startedPath, releasePath)
		if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		provider := &cliProvider{id: id, path: path,
			isReady: func(output []byte, err error) bool { return err == nil && strings.Contains(string(output), "loggedIn") }}
		provider.setReadiness(true, true, "")
		providers[id] = provider
	}
	defer os.WriteFile(releasePath, nil, 0o600)
	runner := &agentRunner{providers: providers}
	done := make(chan []workerapi.ProviderStatus, 1)
	go func() { done <- runner.providerStatuses(context.Background()) }()

	deadline := time.Now().Add(3 * time.Second)
	bothStarted := false
	for time.Now().Before(deadline) {
		started, _ := os.ReadFile(startedPath)
		if strings.Contains(string(started), workerapi.ProviderCodex) &&
			strings.Contains(string(started), workerapi.ProviderClaude) {
			bothStarted = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.WriteFile(releasePath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case statuses := <-done:
		if !bothStarted || len(statuses) != 2 || !statuses[0].Ready || !statuses[1].Ready {
			t.Fatalf("provider readiness was not checked concurrently and successfully: started=%t statuses=%#v", bothStarted, statuses)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("provider readiness checks did not finish after release")
	}
}

func TestProviderRetriesIncompleteSandboxSelfTest(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	provider := newCLIProviders()[workerapi.ProviderCodex]
	attempts := 0
	provider.confinement = func(context.Context, string) error {
		attempts++
		if attempts == 1 {
			return errors.New("sandbox command did not finish")
		}
		return nil
	}
	provider.detect(context.Background())
	if status := provider.status(context.Background()); !status.Ready || attempts != 2 {
		t.Fatalf("status after incomplete then successful sandbox checks = %#v, attempts %d", status, attempts)
	}
}

func TestSlowAuthProbeLeavesASeparateSandboxBudget(t *testing.T) {
	provider := &cliProvider{id: workerapi.ProviderCodex, path: filepath.Join(t.TempDir(), "codex"),
		isReady: func(_ []byte, err error) bool { return err == nil }}
	if err := os.WriteFile(provider.path, []byte("#!/bin/sh\nsleep 2\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	provider.setReadiness(false, false, "sandbox verification pending")
	var remaining time.Duration
	provider.confinement = func(ctx context.Context, _ string) error {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("sandbox check has no independent deadline")
		}
		remaining = time.Until(deadline)
		return nil
	}
	if status := provider.status(context.Background()); !status.Ready || remaining < 4*time.Second {
		t.Fatalf("status after slow auth probe = %#v, sandbox budget left %s", status, remaining)
	}
}

func TestProviderLatchesRealSandboxEscape(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "codex"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	provider := newCLIProviders()[workerapi.ProviderCodex]
	attempts := 0
	provider.confinement = func(context.Context, string) error {
		attempts++
		return fmt.Errorf("%w: denied path was readable", errConfinementViolation)
	}
	provider.detect(context.Background())
	if status := provider.status(context.Background()); status.Ready || status.SandboxedCommands ||
		status.Reason != "sandbox self-test failed" || attempts != 1 {
		t.Fatalf("status after a real sandbox escape = %#v, attempts %d", status, attempts)
	}
}

func TestCodexSignedOutStatusUsesItsExitAndOutput(t *testing.T) {
	directory := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake-codex; exit 0; fi\necho 'Not logged in'\nexit 1\n"
	if err := os.WriteFile(filepath.Join(directory, "codex"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	provider := newCLIProviders()[workerapi.ProviderCodex]
	provider.detect(context.Background())
	if status := provider.status(context.Background()); status.Ready || status.Reason != "not signed in" {
		t.Fatalf("Codex sign-out status = %#v", status)
	}
}

func TestClaudeSuccessfulMalformedAuthStatusIsUnavailable(t *testing.T) {
	directory := t.TempDir()
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake-claude; exit 0; fi\necho not-json\nexit 0\n"
	if err := os.WriteFile(filepath.Join(directory, "claude"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	provider := newCLIProviders()[workerapi.ProviderClaude]
	provider.detect(context.Background())
	if status := provider.status(context.Background()); status.Ready || status.Reason != "auth status unavailable" {
		t.Fatalf("Claude malformed auth status = %#v", status)
	}
}

func TestProviderProbeStopsDescendantsWhenCancelled(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "path with spaces", "child.pid")
	if err := os.MkdirAll(filepath.Dir(pidFile), 0o700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nsleep 30 &\necho $! > \"$1\"\nwait\n"
	provider := &cliProvider{id: workerapi.ProviderClaude}
	provider.path = filepath.Join(t.TempDir(), "probe")
	if err := os.WriteFile(provider.path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		_, err := provider.probe(ctx, []string{pidFile})
		finished <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	var childPID int
	for time.Now().Before(deadline) {
		if content, err := os.ReadFile(pidFile); err == nil {
			if _, err := fmt.Sscanf(string(content), "%d", &childPID); err != nil {
				t.Fatal(err)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 {
		cancel()
		t.Fatal("probe child did not start")
	}
	cancel()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled probe succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled probe waited on a descendant's inherited output pipes")
	}
	waitForProcessExit(t, childPID)
}

func waitForProcessExit(t *testing.T, pid int) {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if err != nil {
			t.Fatalf("check descendant process %d: %v", pid, err)
		}
		select {
		case <-timer.C:
			t.Fatalf("cancelled probe descendant %d is still running", pid)
		case <-ticker.C:
		}
	}
}

func TestProviderStatusRefreshesAuthenticationUnderWorkerEnvironment(t *testing.T) {
	binDir, configDir := t.TempDir(), t.TempDir()
	readyFile := filepath.Join(configDir, "readiness.json")
	if err := os.WriteFile(readyFile, []byte(`{"loggedIn":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte(
		"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo fake-claude; exit 0; fi\n"+
			"status=$(cat \"$XDG_CONFIG_HOME/readiness.json\") || exit $?\n"+
			"printf '%s\\n' \"$status\"\n"+
			"case \"$status\" in *'\"loggedIn\":false'*) exit 1;; esac\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("XDG_CONFIG_HOME", configDir)
	provider := newCLIProviders()[workerapi.ProviderClaude]
	provider.detect(context.Background())
	if status := provider.status(context.Background()); !status.Ready {
		t.Fatalf("signed-in provider status = %#v", status)
	}
	if err := os.WriteFile(readyFile, []byte(`{"loggedIn":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if status := provider.status(context.Background()); status.Ready || status.Reason != "not signed in" {
		t.Fatalf("signed-out provider status = %#v", status)
	}
	if err := os.Remove(readyFile); err != nil {
		t.Fatal(err)
	}
	if status := provider.status(context.Background()); status.Ready || status.Reason != "auth status unavailable" {
		t.Fatalf("unavailable authentication status = %#v", status)
	}
	if err := os.WriteFile(readyFile, []byte(`{"loggedIn":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if status := provider.status(context.Background()); !status.Ready {
		t.Fatalf("re-authenticated provider status = %#v", status)
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
	t.Setenv("CODEX_HOME", "/data/codex")
	t.Setenv("XDG_CONFIG_HOME", "relative/config")
	if withEnvironment := confidentialRoots("/var/worktrees", nil); !slices.Contains(withEnvironment, "/data/codex") ||
		slices.Contains(withEnvironment, "relative/config") {
		t.Errorf("confidential roots with CLI directories = %v", withEnvironment)
	}
	cleaned := newRedactor("/work/tree").clean("proxy https://user:s3cret@proxy.example:3128 and https://github.com/acme/api")
	if strings.Contains(cleaned, "s3cret") || !strings.Contains(cleaned, "https://[redacted]@proxy.example:3128") ||
		!strings.Contains(cleaned, "https://github.com/acme/api") {
		t.Errorf("URL credentials were not redacted: %s", cleaned)
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
	writeArgs, readArgs := claudeArguments(write, workspace), claudeArguments(read, workspace)
	writeSource, readSource := slices.Index(writeArgs, "--setting-sources"), slices.Index(readArgs, "--setting-sources")
	if !strings.Contains(claudeWrite, "--permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep --model=gpt-test") ||
		!strings.Contains(claudeRead, "--permission-mode default --tools Read,Glob,Grep") ||
		strings.Contains(claudeWrite+claudeRead, "Bash") || strings.Contains(claudeWrite+claudeRead, "dangerously") ||
		writeSource < 0 || writeArgs[writeSource+1] != "user" || readSource < 0 || readArgs[readSource+1] != "user" ||
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
