package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const agentRunTestID = "0123456789abcdef0123456789abcdef"

func TestWorkerClaimsAgentRunCallsChatToolsAndCompletesIt(t *testing.T) {
	repository := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(repository, 0o700); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("Local project evidence.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial")
	worktrees := filepath.Join(t.TempDir(), "worktrees")
	t.Setenv("ZENCHRON_WORKTREES_ROOT", worktrees)
	modelCalls := 0
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("model request = %s %s, authorization set = %t", r.Method, r.URL.Path, r.Header.Get("Authorization") != "")
		}
		var request struct {
			Model    string        `json:"model"`
			Messages []chatMessage `json:"messages"`
			Tools    []chatTool    `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode model request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Model != "review-model" || len(request.Tools) != 1 || request.Tools[0].Function.Name != "code.write" {
			t.Errorf("model/model tools = %q/%v", request.Model, request.Tools)
		}
		modelCalls++
		w.Header().Set("Content-Type", "application/json")
		if modelCalls == 1 {
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"write-1","type":"function","function":{"name":"code.write","arguments":"{\"path\":\"README.md\",\"content\":\"Updated in isolated branch.\\n\"}"}}]}}]}`)
			return
		}
		if modelCalls == 2 {
			if len(request.Messages) != 4 || request.Messages[3].Role != "tool" || request.Messages[3].Content != "Updated README.md." {
				t.Errorf("first tool result was not returned to the model: %#v", request.Messages)
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"write-2","type":"function","function":{"name":"code.write","arguments":"{\"path\":\"notes.md\",\"content\":\"Created in isolated branch.\\n\"}"}}]}}]}`)
			return
		}
		if modelCalls == 4 {
			prompt, isText := "", false
			if len(request.Messages) == 2 {
				prompt, isText = request.Messages[1].Content.(string)
			}
			if !isText || !strings.Contains(prompt, "Requested changes: Update the response") {
				t.Errorf("review feedback missing from follow-up prompt: %#v", request.Messages)
			}
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Review feedback addressed."}}]}`)
			return
		}
		if len(request.Messages) != 6 || request.Messages[5].Role != "tool" ||
			request.Messages[5].Content != "Updated notes.md." {
			t.Errorf("tool result was not returned to the model: %#v", request.Messages)
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"The README was updated on an isolated branch."}}]}`)
	}))
	defer model.Close()
	modelURL, err := url.Parse(model.URL + "/v1/chat/completions")
	if err != nil {
		t.Fatal(err)
	}
	runtime := &agentRuntime{endpoint: modelURL, apiKey: "test-key", client: model.Client()}
	command := workerapi.AgentRunCommand{
		ID: agentRunTestID, ProjectID: agentRunTestID, Branch: "zenchron/agent-run/" + agentRunTestID,
		BaseBranch: "main", Prompt: "Update the README.", Attempts: 1,
		Profile: workerapi.AgentProfile{Model: "review-model", SystemPrompt: "Be concise.", Tools: []string{"code.write"}},
	}
	type runResult struct {
		Status    string `json:"status"`
		Output    string `json:"output"`
		Error     string `json:"error"`
		Attempts  int    `json:"attempts"`
		CommitSHA string `json:"commit_sha"`
		Diff      string `json:"diff"`
		Truncated bool   `json:"diff_truncated"`
	}
	var result runResult
	var results []runResult
	claims := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agent-runs/claim") {
			claims++
			w.Header().Set("Content-Type", "application/json")
			next := command
			if claims == 2 {
				next.Attempts = 2
				next.Prompt += "\n\nReviewer feedback:\n- Requested changes: Update the response to address the review.\n"
			}
			_ = json.NewEncoder(w).Encode(next)
			return
		}
		if r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/agent-runs/"+command.ID) {
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Errorf("decode worker result: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			results = append(results, result)
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/progress") {
			_, _ = io.WriteString(w, `{"cancel_requested":false}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer api.Close()
	controlURL, _ := url.Parse(api.URL)
	runner := &agentRunner{client: api.Client(), baseURL: controlURL, workerID: agentRunTestID, chat: runtime,
		limits: runLimits{wallClock: time.Minute, inactivity: time.Minute, toolActivity: time.Minute, verification: time.Minute, gitStage: time.Minute}}
	projects := []discoveredProject{{ID: command.ProjectID, Path: repository}}
	err = runner.process(context.Background(), projects)
	if err != nil {
		t.Fatalf("process agent run: %v", err)
	}
	worktree := filepath.Join(worktrees, command.ProjectID, command.ID)
	if len(results) != 1 || results[0].Status != "succeeded" || results[0].Output != "The README was updated on an isolated branch." ||
		results[0].Attempts != 1 || results[0].Error != "" || modelCalls != 3 || results[0].Truncated ||
		len(results[0].CommitSHA) != 40 ||
		!strings.Contains(results[0].Diff, "Updated in isolated branch.") ||
		!strings.Contains(results[0].Diff, "Created in isolated branch.") {
		t.Fatalf("first run result = %#v, model calls = %d", results, modelCalls)
	}
	if err := runner.process(context.Background(), projects); err != nil {
		t.Fatalf("process review follow-up: %v", err)
	}
	if len(results) != 2 || results[1].Status != "succeeded" || results[1].Output != "Review feedback addressed." ||
		results[1].Attempts != 2 || modelCalls != 4 || results[1].CommitSHA != results[0].CommitSHA ||
		!strings.Contains(results[1].Diff, "Created in isolated branch.") {
		t.Fatalf("follow-up run result = %#v, model calls = %d", results, modelCalls)
	}
	if content, err := os.ReadFile(filepath.Join(worktree, "README.md")); err != nil || string(content) != "Updated in isolated branch.\n" {
		t.Fatalf("worktree README = %q, %v", content, err)
	}
	if content, err := os.ReadFile(filepath.Join(repository, "README.md")); err != nil || string(content) != "Local project evidence.\n" {
		t.Fatalf("source README changed = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(repository, "notes.md")); !os.IsNotExist(err) {
		t.Fatalf("new source file unexpectedly exists: %v", err)
	}
	if branch := strings.TrimSpace(runGit(t, worktree, "branch", "--show-current")); branch != command.Branch {
		t.Fatalf("agent run branch = %q, want %q", branch, command.Branch)
	}
	if commit := strings.TrimSpace(runGit(t, worktree, "rev-parse", "HEAD")); commit != results[0].CommitSHA {
		t.Fatalf("agent branch commit = %q, reported %q", commit, results[0].CommitSHA)
	}
	if staged := strings.TrimSpace(runGit(t, worktree, "status", "--porcelain")); staged != "" {
		t.Fatalf("agent branch has uncommitted changes after success: %s", staged)
	}
}

func TestAgentRuntimeConfigurationRequiresSecureEndpoint(t *testing.T) {
	t.Setenv("ZENCHRON_LLM_API_KEY", "")
	t.Setenv("ZENCHRON_LLM_BASE_URL", "")
	runtime, err := loadAgentRuntime()
	if err != nil || runtime != nil {
		t.Fatalf("unconfigured runtime = %#v, %v", runtime, err)
	}
	t.Setenv("ZENCHRON_LLM_API_KEY", "key-without-endpoint")
	if _, err := loadAgentRuntime(); err == nil {
		t.Fatal("API key without endpoint was accepted")
	}
	t.Setenv("ZENCHRON_LLM_API_KEY", "")
	t.Setenv("ZENCHRON_LLM_BASE_URL", "http://example.com/v1")
	if _, err := loadAgentRuntime(); err == nil {
		t.Fatal("non-loopback HTTP endpoint was accepted")
	}
	t.Setenv("ZENCHRON_LLM_BASE_URL", "http://localhost:1234/v1")
	runtime, err = loadAgentRuntime()
	if err != nil || runtime == nil || runtime.endpoint.Path != "/v1/chat/completions" {
		t.Fatalf("loopback endpoint = %#v, %v", runtime, err)
	}
}

func TestSafeRepositoryPathRejectsTraversalAndSymlinkEscape(t *testing.T) {
	repository, outside := t.TempDir(), t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(repository, "linked-secret.txt")); err != nil {
		t.Fatal(err)
	}
	for _, requested := range []string{"../secret.txt", ".git/config", "linked-secret.txt"} {
		if _, err := safeRepositoryPath(repository, requested); err == nil {
			t.Errorf("safeRepositoryPath(%q) accepted an unsafe path", requested)
		}
		if _, err := safeRepositoryWritePath(repository, requested); err == nil {
			t.Errorf("safeRepositoryWritePath(%q) accepted an unsafe path", requested)
		}
	}
}

func TestWriteRepositoryFileCreatesAndReplacesOnlyRepositoryFiles(t *testing.T) {
	repository := t.TempDir()
	path := filepath.Join(repository, "README.md")
	if err := os.WriteFile(path, []byte("old\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	result, err := writeRepositoryFile(repository, `{"path":"README.md","content":"updated\n"}`)
	if err != nil || result != "Updated README.md." {
		t.Fatalf("write existing file = %q, %v", result, err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("existing file permissions = %v, %v", info, err)
	}
	if _, err := writeRepositoryFile(repository, `{"path":"notes/new.md","content":"new\n"}`); err == nil {
		t.Fatal("write into a missing directory was accepted")
	}
	newPath := filepath.Join(repository, "new.md")
	if _, err := writeRepositoryFile(repository, `{"path":"new.md","content":"created\n"}`); err != nil {
		t.Fatalf("create file in repository: %v", err)
	}
	if content, err := os.ReadFile(newPath); err != nil || string(content) != "created\n" {
		t.Fatalf("new file = %q, %v", content, err)
	}
}

func TestCollectAgentRunDiffBoundsOutput(t *testing.T) {
	repository := t.TempDir()
	runGit(t, repository, "init", "-b", "main")
	runGit(t, repository, "config", "user.name", "Zenchron Test")
	runGit(t, repository, "config", "user.email", "zenchron-test@example.invalid")
	if err := os.WriteFile(filepath.Join(repository, "README.md"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repository, "add", "README.md")
	runGit(t, repository, "commit", "-m", "initial")
	if err := os.WriteFile(filepath.Join(repository, "large.txt"), []byte(strings.Repeat("line value\n", maxAgentRunDiffSize)), 0o600); err != nil {
		t.Fatal(err)
	}
	diff, truncated, err := collectAgentRunDiff(context.Background(), repository, "main")
	if err != nil || !truncated || len(diff) != maxAgentRunDiffSize {
		t.Fatalf("bounded diff length/truncated/error = %d/%t/%v", len(diff), truncated, err)
	}
}
