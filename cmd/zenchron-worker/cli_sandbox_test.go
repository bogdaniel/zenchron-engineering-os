package main

import (
	"encoding/json"
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

// TestMain lets the test binary stand in for the worker binary: as the `guard` command, and as a worker
// that starts a guarded child and then waits to be killed.
func TestMain(m *testing.M) {
	switch os.Getenv("WORKER_GUARD_TEST_ROLE") {
	case "guard":
		os.Exit(runGuard(os.Args[1:]))
	case "worker":
		reader, writer, err := os.Pipe()
		if err != nil {
			os.Exit(3)
		}
		child := exec.Command(os.Args[0], "sh", "-c", "sleep 60 & echo $! ; wait")
		child.Env = append(os.Environ(), "WORKER_GUARD_TEST_ROLE=guard")
		child.Stdout, child.ExtraFiles = os.Stdout, []*os.File{reader}
		// Same process-group arrangement the worker uses for a provider.
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := child.Start(); err != nil {
			os.Exit(4)
		}
		_ = writer // Held open until this process dies, exactly like the real worker.
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func processExists(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func TestGuardStopsProviderProcessesWhenTheWorkerIsKilled(t *testing.T) {
	worker := exec.Command(os.Args[0])
	worker.Env = append(os.Environ(), "WORKER_GUARD_TEST_ROLE=worker")
	output, err := worker.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	var grandchild int
	if _, err := fmt.Fscan(output, &grandchild); err != nil || grandchild <= 0 {
		_ = worker.Process.Kill()
		t.Fatalf("read provider child pid: %d, %v", grandchild, err)
	}
	if !processExists(grandchild) {
		t.Fatal("provider child was not running before the worker was killed")
	}
	// SIGKILL gives the worker no chance to clean up; only the guard can stop what it started.
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = worker.Wait()
	deadline := time.Now().Add(cliTerminationGrace + 5*time.Second)
	for processExists(grandchild) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if processExists(grandchild) {
		_ = syscall.Kill(grandchild, syscall.SIGKILL)
		t.Fatal("provider child survived the death of the worker")
	}
}

func TestGuardReturnsTheProviderExitCode(t *testing.T) {
	for _, want := range []int{0, 7} {
		guarded := exec.Command(os.Args[0], "sh", "-c", "exit "+strconv.Itoa(want))
		guarded.Env = append(os.Environ(), "WORKER_GUARD_TEST_ROLE=guard")
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		guarded.ExtraFiles = []*os.File{reader}
		err = guarded.Run()
		writer.Close()
		reader.Close()
		if got := guarded.ProcessState.ExitCode(); got != want {
			t.Fatalf("guard exit code = %d (%v), want %d", got, err, want)
		}
	}
}

func TestCLIRunThroughTheGuardStillDeliversItsResult(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	t.Setenv("WORKER_GUARD_TEST_ROLE", "guard")
	harness.runner.providers[workerapi.ProviderCodex].guard = []string{os.Args[0]}
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || len(result.CommitSHA) != 40 {
		t.Fatalf("guarded run result = %#v", result)
	}
}

func TestProviderArgumentsBoundAgentPermissions(t *testing.T) {
	home, _ := os.UserHomeDir()
	workspace := runWorkspace{path: "/work/tree", readPaths: []string{"/repo/.git", home + "/go/pkg/mod"}}
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
	for _, entry := range []string{`"/"="read"`, strconv.Quote(home) + `="none"`, `"/work/tree"="write"`,
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
	var settings struct {
		DisableAllHooks bool `json:"disableAllHooks"`
		Sandbox         struct {
			Enabled                  bool  `json:"enabled"`
			AllowUnsandboxedCommands *bool `json:"allowUnsandboxedCommands"`
			Filesystem               struct {
				DenyRead, AllowRead, AllowWrite []string
			} `json:"filesystem"`
		} `json:"sandbox"`
	}
	if err := json.Unmarshal([]byte(arguments[settingsIndex+1]), &settings); err != nil || !settings.Sandbox.Enabled || !settings.DisableAllHooks ||
		settings.Sandbox.AllowUnsandboxedCommands == nil || *settings.Sandbox.AllowUnsandboxedCommands ||
		!slices.Equal(settings.Sandbox.Filesystem.DenyRead, []string{home}) ||
		!slices.Equal(settings.Sandbox.Filesystem.AllowRead, []string{"/work/tree", "/repo/.git", home + "/go/pkg/mod"}) ||
		!slices.Equal(settings.Sandbox.Filesystem.AllowWrite, []string{os.TempDir()}) {
		t.Fatalf("claude sandbox settings = %s, %v", arguments[settingsIndex+1], err)
	}
	readOnlyTests := workerapi.AgentRunCommand{Profile: workerapi.AgentProfile{Model: defaultModel, Tools: []string{"tests.run"}}}
	if strings.Contains(strings.Join(claudeArguments(readOnlyTests, workspace), " "), "Bash") {
		t.Error("a profile without code.write was offered a shell")
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
