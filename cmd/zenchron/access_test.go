package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	aliceWorkerID  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	bobWorkerID    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	sharedWorkerID = "cccccccccccccccccccccccccccccccc"
	aliceToken     = "alice-worker-token-0123456789abcdef"
	bobToken       = "bob-worker-token-0123456789abcdef00"
	sharedToken    = "shared-worker-token-0123456789abcd"
	projectA       = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
	projectC       = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
	repositoryA    = "github.com/acme/project-a"
	repositoryC    = "github.com/acme/project-c"
)

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func writeAccessFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "access.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// accessHarness is the authenticated control plane with Alice on project A, Bob on project C, each
// with their own worker, and a shared worker on project A.
type accessHarness struct {
	t       *testing.T
	server  http.Handler
	config  *authConfig
	path    string
	profile agentProfile
}

func accessFileContent(workers string) string {
	return fmt.Sprintf(`{"workers":[%s],"users":{"Alice":[%q],"bob":[%q]}}`, workers, repositoryA, repositoryC)
}

func enrolledWorkers() string {
	return fmt.Sprintf(`{"id":%q,"token_sha256":%q,"owner":"alice","repositories":[%q]},`+
		`{"id":%q,"token_sha256":%q,"owner":"bob","repositories":[%q]},`+
		`{"id":%q,"token_sha256":%q,"owner":"","repositories":[%q]}`,
		aliceWorkerID, tokenHash(aliceToken), repositoryA, bobWorkerID, tokenHash(bobToken), repositoryC,
		sharedWorkerID, tokenHash(sharedToken), repositoryA)
}

func newAccessHarness(t *testing.T) *accessHarness {
	t.Helper()
	harness := &accessHarness{t: t, path: writeAccessFile(t, accessFileContent(enrolledWorkers()))}
	harness.config = testAuthConfig()
	harness.config.allowedUsers = []string{"alice", "bob", "carol"}
	harness.config.access = &accessPolicy{path: harness.path}
	registry := newWorkerRegistry()
	agents := newAgentProfileStore()
	harness.profile = agentProfile{ID: "abcdefabcdefabcdefabcdefabcdefab", Name: "Engineer", Provider: "codex-cli", Model: "default",
		Status: "active", Version: 1, UpdatedAt: time.Now().UTC(), Tools: []string{"code.write"}}
	agents.items[harness.profile.ID] = harness.profile
	harness.server = authHandler(newMuxWithStores(newObjectiveStore(newProductStore()), newWorkflowStore(), agents,
		newProductStore(), registry, newWorktreeStore(registry), newAgentRunStore(registry, agents)), harness.config)
	return harness
}

func (harness *accessHarness) worker(method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	harness.server.ServeHTTP(response, request)
	return response
}

func (harness *accessHarness) user(login, method, path, body string) *httptest.ResponseRecorder {
	harness.t.Helper()
	session, err := signSession(authUser{Login: login, ExpiresAt: time.Now().Add(time.Hour).Unix()}, harness.config.sessionKey)
	if err != nil {
		harness.t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.RemoteAddr = "203.0.113.10:41000"
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: session})
	response := httptest.NewRecorder()
	harness.server.ServeHTTP(response, request)
	return response
}

func (harness *accessHarness) heartbeat(workerID, token, projects string) int {
	body := `{"name":"worker-` + workerID[:4] + `","providers":[{"id":"codex-cli","version":"1","ready":true}],"projects":[` + projects + `]}`
	return harness.worker(http.MethodPut, "/api/v1/workers/"+workerID+"/heartbeat", token, body).Code
}

func projectJSON(id, repository string) string {
	return fmt.Sprintf(`{"id":%q,"name":"repo","branch":"main","git_remote":%q}`, id, repository)
}

func decodeList[T any](t *testing.T, response *httptest.ResponseRecorder) []T {
	t.Helper()
	var items []T
	if err := json.NewDecoder(response.Body).Decode(&items); err != nil || response.Code != http.StatusOK {
		t.Fatalf("list returned HTTP %d, %v", response.Code, err)
	}
	return items
}

func TestWorkerTokenIsBoundToItsEnrolledIdentity(t *testing.T) {
	harness := newAccessHarness(t)
	for name, test := range map[string]struct {
		workerID, token string
		status          int
	}{
		"own identity":              {aliceWorkerID, aliceToken, http.StatusOK},
		"another worker's identity": {bobWorkerID, aliceToken, http.StatusUnauthorized},
		"unenrolled identity":       {"dddddddddddddddddddddddddddddddd", aliceToken, http.StatusUnauthorized},
		"legacy shared token":       {aliceWorkerID, testWorkerToken, http.StatusUnauthorized},
		"token hash as token":       {aliceWorkerID, tokenHash(aliceToken), http.StatusUnauthorized},
		"no token":                  {aliceWorkerID, "", http.StatusUnauthorized},
	} {
		if status := harness.heartbeat(test.workerID, test.token, ""); status != test.status {
			t.Errorf("%s: heartbeat returned HTTP %d, want %d", name, status, test.status)
		}
	}
	for _, path := range []string{"/agent-runs/claim", "/worktrees/claim"} {
		if response := harness.worker(http.MethodPost, "/api/v1/workers/"+bobWorkerID+path, aliceToken, ""); response.Code != http.StatusUnauthorized {
			t.Errorf("Alice's worker claimed Bob's %s: HTTP %d", path, response.Code)
		}
	}
	if response := harness.worker(http.MethodGet, "/api/v1/workers/healthz", bobToken, ""); response.Code == http.StatusUnauthorized {
		t.Errorf("enrolled worker readiness probe was rejected")
	}
	if response := harness.worker(http.MethodGet, "/api/v1/agent-runs", aliceToken, ""); response.Code != http.StatusUnauthorized {
		t.Errorf("worker token read the dashboard API: HTTP %d", response.Code)
	}
}

func TestWorkerRegistersOnlyApprovedRepositoriesAndUsersSeeOnlyTheirProjects(t *testing.T) {
	harness := newAccessHarness(t)
	// Alice's worker also reports Bob's repository and a checkout without a remote; neither is approved.
	if status := harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA)+","+
		projectJSON(projectC, repositoryC)+`,{"id":"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1","name":"scratch","branch":"main"}`); status != http.StatusOK {
		t.Fatalf("heartbeat returned HTTP %d", status)
	}
	if status := harness.heartbeat(bobWorkerID, bobToken, projectJSON(projectC, repositoryC)); status != http.StatusOK {
		t.Fatalf("heartbeat returned HTTP %d", status)
	}
	alice := decodeList[projectStatus](t, harness.user("alice", http.MethodGet, "/api/v1/projects", ""))
	bob := decodeList[projectStatus](t, harness.user("bob", http.MethodGet, "/api/v1/projects", ""))
	if len(alice) != 1 || alice[0].GitRemote != repositoryA || alice[0].WorkerID != aliceWorkerID ||
		len(bob) != 1 || bob[0].GitRemote != repositoryC || bob[0].WorkerID != bobWorkerID {
		t.Fatalf("visible projects: alice %#v, bob %#v", alice, bob)
	}
	if carol := decodeList[projectStatus](t, harness.user("carol", http.MethodGet, "/api/v1/projects", "")); len(carol) != 0 {
		t.Fatalf("signed-in user without grants sees %#v", carol)
	}
	if workers := decodeList[workerStatus](t, harness.user("bob", http.MethodGet, "/api/v1/workers", "")); len(workers) != 1 || workers[0].ID != bobWorkerID {
		t.Fatalf("Bob sees workers %#v", workers)
	}
	for _, path := range []string{"/issues", "/pull-requests", "/pull-request-history"} {
		if response := harness.user("bob", http.MethodGet, "/api/v1/projects/"+projectA+path, ""); response.Code != http.StatusNotFound {
			t.Errorf("Bob read project A %s: HTTP %d", path, response.Code)
		}
	}
	if response := harness.user("bob", http.MethodPost, "/api/v1/projects/"+projectA+"/issues", `{"title":"x"}`); response.Code != http.StatusNotFound {
		t.Errorf("Bob created an issue in project A: HTTP %d", response.Code)
	}
}

func TestRunsAreScopedToProjectAccessAndWorkerOwnership(t *testing.T) {
	harness := newAccessHarness(t)
	harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA))
	harness.heartbeat(bobWorkerID, bobToken, projectJSON(projectC, repositoryC))
	create := func(login, project string) *httptest.ResponseRecorder {
		return harness.user(login, http.MethodPost, "/api/v1/agent-runs",
			`{"agent_id":"`+harness.profile.ID+`","project_id":"`+project+`","prompt":"Fix it"}`)
	}
	if response := create("bob", projectA); response.Code != http.StatusConflict {
		t.Fatalf("Bob started a run on project A: HTTP %d", response.Code)
	}
	if response := create("carol", projectA); response.Code != http.StatusConflict {
		t.Fatalf("user without grants started a run: HTTP %d", response.Code)
	}
	response := create("alice", projectA)
	var run agentRun
	if err := json.NewDecoder(response.Body).Decode(&run); err != nil || response.Code != http.StatusAccepted || run.WorkerID != aliceWorkerID {
		t.Fatalf("Alice's run = %#v, HTTP %d, %v", run, response.Code, err)
	}
	if runs := decodeList[agentRun](t, harness.user("bob", http.MethodGet, "/api/v1/agent-runs", "")); len(runs) != 0 {
		t.Fatalf("Bob lists Alice's runs: %#v", runs)
	}
	if runs := decodeList[agentRun](t, harness.user("alice", http.MethodGet, "/api/v1/agent-runs", "")); len(runs) != 1 {
		t.Fatalf("Alice lists %d runs", len(runs))
	}
	for _, request := range [][3]string{
		{http.MethodGet, "/diff", ""}, {http.MethodGet, "/events", ""}, {http.MethodGet, "/pull-request", ""},
		{http.MethodPost, "/cancel", ""}, {http.MethodPost, "/comments", `{"comment":"x"}`},
		{http.MethodPost, "/request-changes", `{"comment":"x"}`}, {http.MethodPost, "/publish", ""},
		{http.MethodPost, "/sync-reviews", ""},
	} {
		if response := harness.user("bob", request[0], "/api/v1/agent-runs/"+run.ID+request[1], request[2]); response.Code != http.StatusNotFound {
			t.Errorf("Bob reached Alice's run %s %s: HTTP %d", request[0], request[1], response.Code)
		}
	}
	// Bob's worker cannot claim, report on, or finish Alice's run even with its own valid token.
	if response := harness.worker(http.MethodPost, "/api/v1/workers/"+bobWorkerID+"/agent-runs/claim", bobToken, ""); response.Code != http.StatusNoContent {
		t.Errorf("Bob's worker claimed work it was not assigned: HTTP %d", response.Code)
	}
	if response := harness.worker(http.MethodPost, "/api/v1/workers/"+aliceWorkerID+"/agent-runs/claim", aliceToken, ""); response.Code != http.StatusOK {
		t.Fatalf("Alice's worker claim returned HTTP %d", response.Code)
	}
	for _, request := range [][3]string{
		{http.MethodPost, "/agent-runs/" + run.ID + "/progress", `{"attempts":1}`},
		{http.MethodPut, "/agent-runs/" + run.ID, `{"status":"succeeded","attempts":1}`},
	} {
		if response := harness.worker(request[0], "/api/v1/workers/"+bobWorkerID+request[1], bobToken, request[2]); response.Code != http.StatusForbidden && response.Code != http.StatusConflict {
			t.Errorf("Bob's worker %s %s returned HTTP %d", request[0], request[1], response.Code)
		}
	}
	if response := harness.user("alice", http.MethodPost, "/api/v1/agent-runs/"+run.ID+"/cancel", ""); response.Code != http.StatusAccepted {
		t.Fatalf("Alice could not cancel her own run: HTTP %d", response.Code)
	}
}

func TestUsersDispatchOnlyToTheirOwnOrSharedWorkers(t *testing.T) {
	harness := newAccessHarness(t)
	// Grant Bob project A as well; Alice's personal worker must still refuse his work.
	content := strings.Replace(accessFileContent(enrolledWorkers()), `"bob":["`+repositoryC+`"]`,
		`"bob":["`+repositoryC+`","`+repositoryA+`"]`, 1)
	if err := os.WriteFile(harness.path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	sharedProject := "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"
	harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA))
	harness.heartbeat(sharedWorkerID, sharedToken, projectJSON(sharedProject, repositoryA))
	create := func(project string) int {
		return harness.user("bob", http.MethodPost, "/api/v1/agent-runs",
			`{"agent_id":"`+harness.profile.ID+`","project_id":"`+project+`","prompt":"Fix it"}`).Code
	}
	if status := create(projectA); status != http.StatusForbidden {
		t.Errorf("Bob dispatched to Alice's personal worker: HTTP %d", status)
	}
	if status := create(sharedProject); status != http.StatusAccepted {
		t.Errorf("Bob could not dispatch to the shared worker: HTTP %d", status)
	}
	worktree := harness.user("bob", http.MethodPost, "/api/v1/worktrees", `{"project_id":"`+projectA+`","branch":"feature/x"}`)
	if worktree.Code != http.StatusConflict {
		t.Errorf("Bob requested a worktree on Alice's personal worker: HTTP %d", worktree.Code)
	}
}

func TestRevokingAGrantTakesEffectWithoutRestartAndInvalidPolicyDeniesAll(t *testing.T) {
	harness := newAccessHarness(t)
	if status := harness.heartbeat(aliceWorkerID, aliceToken, ""); status != http.StatusOK {
		t.Fatalf("heartbeat before revocation returned HTTP %d", status)
	}
	rewrite := func(content string) {
		t.Helper()
		if err := os.WriteFile(harness.path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		// Make the change visible on filesystems with coarse modification times.
		future := time.Now().Add(time.Duration(len(content)) * time.Second)
		if err := os.Chtimes(harness.path, future, future); err != nil {
			t.Fatal(err)
		}
	}
	rewrite(accessFileContent(strings.Replace(enrolledWorkers(), tokenHash(aliceToken), tokenHash("rotated-token-0123456789abcdef0123"), 1)))
	if status := harness.heartbeat(aliceWorkerID, aliceToken, ""); status != http.StatusUnauthorized {
		t.Fatalf("revoked worker token returned HTTP %d", status)
	}
	if status := harness.heartbeat(bobWorkerID, bobToken, ""); status != http.StatusOK {
		t.Fatalf("unrelated worker was affected by revocation: HTTP %d", status)
	}
	rewrite(`{"workers":[{"id":"not-hex"}]}`)
	if status := harness.heartbeat(bobWorkerID, bobToken, ""); status != http.StatusServiceUnavailable {
		t.Fatalf("invalid policy admitted a worker: HTTP %d", status)
	}
	if response := harness.user("alice", http.MethodGet, "/api/v1/projects", ""); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("invalid policy admitted a user: HTTP %d", response.Code)
	}
}

func TestAccessFileRejectsMalformedGrants(t *testing.T) {
	valid := fmt.Sprintf(`{"id":%q,"token_sha256":%q,"repositories":[%q]}`, aliceWorkerID, tokenHash(aliceToken), repositoryA)
	for name, content := range map[string]string{
		"plain token instead of hash": `{"workers":[{"id":"` + aliceWorkerID + `","token_sha256":"` + aliceToken + `"}]}`,
		"duplicate worker":            `{"workers":[` + valid + `,` + valid + `]}`,
		"repository traversal":        `{"workers":[],"users":{"alice":["github.com/acme/../secret"]}}`,
		"repository with credentials": `{"workers":[],"users":{"alice":["user@github.com/acme/repo"]}}`,
		"blank user":                  `{"workers":[],"users":{" ":["github.com/acme/repo"]}}`,
		"unknown field":               `{"workers":[],"users":{},"admins":["alice"]}`,
	} {
		t.Setenv("ZENCHRON_ACCESS_FILE", writeAccessFile(t, content))
		if _, err := loadAccessPolicy(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	t.Setenv("ZENCHRON_ACCESS_FILE", writeAccessFile(t, `{"workers":[`+valid+`],"users":{"Alice":["`+repositoryA+`"]}}`))
	policy, err := loadAccessPolicy()
	if err != nil {
		t.Fatal(err)
	}
	if file, err := policy.current(); err != nil || len(file.Users["alice"]) != 1 {
		t.Fatalf("valid policy = %#v, %v", file, err)
	}
}
