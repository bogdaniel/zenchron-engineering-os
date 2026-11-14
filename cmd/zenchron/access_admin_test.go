package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const rotatedToken = "alice-rotated-token-0123456789abcdef"

// newAdminHarness is the access harness with Carol as the administrator, one product store shared by
// products and objectives, and both developers' workers registered with their projects.
func newAdminHarness(t *testing.T) *accessHarness {
	t.Helper()
	harness := newAccessHarness(t)
	content := fmt.Sprintf(`{"admins":["carol"],"workers":[%s],"users":{"alice":[%q],"bob":[%q]}}`,
		enrolledWorkers(), repositoryA, repositoryC)
	if err := os.WriteFile(harness.path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	harness.config.access = &accessPolicy{path: harness.path, auditPath: harness.path + ".audit.jsonl"}
	registry, agents, products := newWorkerRegistry(), newAgentProfileStore(), newProductStore()
	agents.items[harness.profile.ID] = harness.profile
	harness.server = authHandler(newMuxWithStores(newObjectiveStore(products), newWorkflowStore(), agents,
		products, registry, newWorktreeStore(registry), newAgentRunStore(registry, agents)), harness.config)
	if harness.heartbeat(aliceWorkerID, aliceToken, projectJSON(projectA, repositoryA)) != http.StatusOK ||
		harness.heartbeat(bobWorkerID, bobToken, projectJSON(projectC, repositoryC)) != http.StatusOK {
		t.Fatal("workers could not register their projects")
	}
	return harness
}

func decodeBody[T any](t *testing.T, response *httptest.ResponseRecorder, wantStatus int) T {
	t.Helper()
	var value T
	if response.Code != wantStatus {
		t.Fatalf("HTTP %d, want %d: %s", response.Code, wantStatus, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatalf("decode %s: %v", response.Body.String(), err)
	}
	return value
}

func (harness *accessHarness) audit() []auditRecord {
	harness.t.Helper()
	return decodeBody[[]auditRecord](harness.t, harness.user("carol", http.MethodGet, "/api/v1/admin/audit", ""), http.StatusOK)
}

func TestAdminAPIRequiresAnAdministratorAndNeverReturnsTokenHashes(t *testing.T) {
	harness := newAdminHarness(t)
	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/admin/access", ""},
		{http.MethodGet, "/api/v1/admin/audit", ""},
		{http.MethodPut, "/api/v1/admin/users/alice", `{"admin":true,"repositories":[]}`},
		{http.MethodDelete, "/api/v1/admin/users/bob", ""},
		{http.MethodPut, "/api/v1/admin/workers/" + bobWorkerID, `{"owner":"alice","repositories":[]}`},
		{http.MethodDelete, "/api/v1/admin/workers/" + bobWorkerID, ""},
	} {
		if response := harness.user("alice", request.method, request.path, request.body); response.Code != http.StatusForbidden {
			t.Errorf("a developer's %s %s returned HTTP %d", request.method, request.path, response.Code)
		}
		if response := harness.worker(request.method, request.path, aliceToken, request.body); response.Code != http.StatusUnauthorized {
			t.Errorf("a worker token's %s %s returned HTTP %d", request.method, request.path, response.Code)
		}
	}
	if len(harness.audit()) != 0 {
		t.Error("refused changes left audit records")
	}
	response := harness.user("carol", http.MethodGet, "/api/v1/admin/access", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), aliceWorkerID) ||
		!strings.Contains(response.Body.String(), `"login":"carol","admin":true`) ||
		strings.Contains(response.Body.String(), tokenHash(aliceToken)) || strings.Contains(response.Body.String(), "token_sha256") {
		t.Fatalf("access listing = HTTP %d %s", response.Code, response.Body.String())
	}
}

func TestAdminGrantsAndRevokesUserAccessWithAuditRecords(t *testing.T) {
	harness := newAdminHarness(t)
	visibleProjects := func(login string) int {
		return len(decodeList[projectStatus](t, harness.user(login, http.MethodGet, "/api/v1/projects", "")))
	}
	if visibleProjects("bob") != 1 {
		t.Fatal("setup: Bob should see only his own project")
	}
	body := fmt.Sprintf(`{"repositories":[%q,%q]}`, repositoryC, repositoryA)
	if response := harness.user("carol", http.MethodPut, "/api/v1/admin/users/bob", body); response.Code != http.StatusOK {
		t.Fatalf("grant returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if visibleProjects("bob") != 2 {
		t.Error("the new grant did not take effect on Bob's next request")
	}
	// Dave is not on the operator's sign-in allowlist: the policy alone admits him, and removing him
	// ends his session at the next request.
	if harness.user("dave", http.MethodGet, "/api/v1/projects", "").Code != http.StatusUnauthorized {
		t.Fatal("an unknown login had a session")
	}
	harness.user("carol", http.MethodPut, "/api/v1/admin/users/dave", fmt.Sprintf(`{"repositories":[%q]}`, repositoryA))
	if visibleProjects("dave") != 1 {
		t.Error("a user added through the API could not use their grant")
	}
	if response := harness.user("carol", http.MethodDelete, "/api/v1/admin/users/dave", ""); response.Code != http.StatusOK {
		t.Fatalf("removal returned HTTP %d", response.Code)
	}
	if harness.user("dave", http.MethodGet, "/api/v1/projects", "").Code != http.StatusUnauthorized {
		t.Error("a removed user kept a session")
	}
	if response := harness.user("carol", http.MethodDelete, "/api/v1/admin/users/bob", ""); response.Code != http.StatusOK || visibleProjects("bob") != 0 {
		t.Errorf("revocation returned HTTP %d; Bob still sees %d project(s)", response.Code, visibleProjects("bob"))
	}
	for _, refused := range []struct{ method, path, body string }{
		{http.MethodDelete, "/api/v1/admin/users/carol", ""},
		{http.MethodPut, "/api/v1/admin/users/carol", `{"admin":false,"repositories":[]}`},
	} {
		if response := harness.user("carol", refused.method, refused.path, refused.body); response.Code != http.StatusConflict {
			t.Errorf("removing the last administrator returned HTTP %d", response.Code)
		}
	}
	if response := harness.user("carol", http.MethodPut, "/api/v1/admin/users/eve", `{"repositories":["github.com/acme/../secret"]}`); response.Code != http.StatusBadRequest {
		t.Errorf("an invalid repository grant returned HTTP %d", response.Code)
	}
	records := harness.audit()
	if len(records) != 4 {
		t.Fatalf("audit holds %d records, want the 4 applied changes: %#v", len(records), records)
	}
	newest, oldest := records[0], records[3]
	if newest.Action != "user.delete" || newest.Target != "bob" || newest.Actor != "carol" || newest.Time.IsZero() ||
		oldest.Action != "user.set" || oldest.Target != "bob" || oldest.Actor != "carol" {
		t.Fatalf("audit records = %#v ... %#v", newest, oldest)
	}
	before, after := fmt.Sprint(oldest.Before), fmt.Sprint(oldest.After)
	if !strings.Contains(before, repositoryC) || strings.Contains(before, repositoryA) || !strings.Contains(after, repositoryA) {
		t.Errorf("the grant record does not show what changed: before %s, after %s", before, after)
	}
}

func TestWorkerTokenRotationOverlapsAndRevocationIsImmediateForThatWorkerOnly(t *testing.T) {
	harness := newAdminHarness(t)
	heartbeat := func(id, token string) int { return harness.heartbeat(id, token, projectJSON(projectA, repositoryA)) }
	rotate := fmt.Sprintf(`{"owner":"alice","repositories":[%q],"token_sha256":%q}`, repositoryA, tokenHash(rotatedToken))
	if response := harness.user("carol", http.MethodPut, "/api/v1/admin/workers/"+aliceWorkerID, rotate); response.Code != http.StatusOK ||
		strings.Contains(response.Body.String(), tokenHash(rotatedToken)) {
		t.Fatalf("rotation returned HTTP %d: %s", response.Code, response.Body.String())
	}
	if heartbeat(aliceWorkerID, aliceToken) != http.StatusOK || heartbeat(aliceWorkerID, rotatedToken) != http.StatusOK {
		t.Error("the old and the new token must both work during the rotation overlap")
	}
	if harness.heartbeat(bobWorkerID, rotatedToken, "") != http.StatusUnauthorized ||
		harness.heartbeat(bobWorkerID, bobToken, projectJSON(projectC, repositoryC)) != http.StatusOK {
		t.Error("rotating one worker's token changed another worker's credential")
	}
	revoke := fmt.Sprintf(`{"owner":"alice","repositories":[%q],"revoke_previous_token":true}`, repositoryA)
	harness.user("carol", http.MethodPut, "/api/v1/admin/workers/"+aliceWorkerID, revoke)
	if heartbeat(aliceWorkerID, aliceToken) != http.StatusUnauthorized || heartbeat(aliceWorkerID, rotatedToken) != http.StatusOK {
		t.Error("revoking the previous token did not end it at once, or broke the new token")
	}
	// An overlap that has run out ends the previous token without any further request.
	expired := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	content := fmt.Sprintf(`{"admins":["carol"],"workers":[{"id":%q,"token_sha256":%q,"previous_token_sha256":%q,`+
		`"previous_token_expires_at":%q,"owner":"alice","repositories":[%q]}],"users":{}}`,
		aliceWorkerID, tokenHash(rotatedToken), tokenHash(aliceToken), expired, repositoryA)
	if err := os.WriteFile(harness.path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if heartbeat(aliceWorkerID, aliceToken) != http.StatusUnauthorized || heartbeat(aliceWorkerID, rotatedToken) != http.StatusOK {
		t.Error("an expired previous token was accepted")
	}
	if response := harness.user("carol", http.MethodDelete, "/api/v1/admin/workers/"+aliceWorkerID, ""); response.Code != http.StatusOK ||
		heartbeat(aliceWorkerID, rotatedToken) != http.StatusUnauthorized {
		t.Errorf("removing the worker returned HTTP %d and its token still works: %v", response.Code, heartbeat(aliceWorkerID, rotatedToken) == http.StatusOK)
	}
	enroll := fmt.Sprintf(`{"owner":"","repositories":[%q]}`, repositoryA)
	if response := harness.user("carol", http.MethodPut, "/api/v1/admin/workers/"+aliceWorkerID, enroll); response.Code != http.StatusBadRequest {
		t.Errorf("enrolling a worker without a token hash returned HTTP %d", response.Code)
	}
	log, err := os.ReadFile(harness.path + ".audit.jsonl")
	if err != nil || !strings.Contains(string(log), `"token_changed":true`) || !strings.Contains(string(log), `"previous_token_revoked":true`) ||
		!strings.Contains(string(log), `"action":"worker.delete"`) ||
		strings.Contains(string(log), tokenHash(rotatedToken)) || strings.Contains(string(log), tokenHash(aliceToken)) {
		t.Fatalf("audit log = %s, %v", log, err)
	}
}

func TestProductsAndObjectivesFollowRepositoryAccess(t *testing.T) {
	harness := newAdminHarness(t)
	productBody := func(name, project string) string {
		return fmt.Sprintf(`{"name":%q,"description":"","repository_ids":[%q]}`, name, project)
	}
	created := harness.user("alice", http.MethodPost, "/api/v1/products", productBody("Payments", projectA))
	if strings.Contains(created.Body.String(), "access_repositories") || strings.Contains(created.Body.String(), repositoryA) {
		t.Errorf("the product response exposes its repositories: %s", created.Body.String())
	}
	payments := decodeBody[product](t, created, http.StatusCreated)
	objectiveBody := fmt.Sprintf(`{"title":"Ship refunds","product_id":%q}`, payments.ID)
	refunds := decodeBody[objective](t, harness.user("alice", http.MethodPost, "/api/v1/objectives", objectiveBody), http.StatusCreated)
	private := decodeBody[objective](t, harness.user("alice", http.MethodPost, "/api/v1/objectives", `{"title":"Private note"}`), http.StatusCreated)

	listed := func(login, path string) string { return harness.user(login, http.MethodGet, path, "").Body.String() }
	for _, path := range []string{"/api/v1/products", "/api/v1/objectives"} {
		if body := listed("bob", path); strings.TrimSpace(body) != "[]" {
			t.Errorf("Bob's %s lists another project's data: %s", path, body)
		}
	}
	for name, response := range map[string]*httptest.ResponseRecorder{
		"edit the product":                harness.user("bob", http.MethodPut, "/api/v1/products/"+payments.ID, productBody("Taken over", projectC)),
		"edit the objective":              harness.user("bob", http.MethodPatch, "/api/v1/objectives/"+refunds.ID, `{"title":"Changed"}`),
		"edit the product-less objective": harness.user("bob", http.MethodPatch, "/api/v1/objectives/"+private.ID, `{"title":"Changed"}`),
		"attach an objective":             harness.user("bob", http.MethodPost, "/api/v1/objectives", objectiveBody),
		"link a project he cannot access": harness.user("bob", http.MethodPost, "/api/v1/products", productBody("Mine", projectA)),
		"link an unregistered project":    harness.user("bob", http.MethodPost, "/api/v1/products", productBody("Mine", "dddddddddddddddddddddddddddddddd")),
	} {
		if response.Code < 400 {
			t.Errorf("Bob could %s: HTTP %d %s", name, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "Payments") || strings.Contains(response.Body.String(), "Ship refunds") {
			t.Errorf("the refusal to %s reveals the other project's data: %s", name, response.Body.String())
		}
	}
	// A hidden product's name is not revealed by the uniqueness check.
	if response := harness.user("bob", http.MethodPost, "/api/v1/products", productBody("Payments", projectC)); response.Code != http.StatusCreated {
		t.Errorf("Bob's product with a name used in another project returned HTTP %d", response.Code)
	}
	if !strings.Contains(listed("alice", "/api/v1/objectives"), "Ship refunds") || !strings.Contains(listed("alice", "/api/v1/objectives"), "Private note") ||
		strings.Count(listed("alice", "/api/v1/products"), `"name"`) != 1 {
		t.Error("Alice does not see exactly her own product and objectives")
	}
	if strings.Count(listed("carol", "/api/v1/products"), `"name"`) != 2 || !strings.Contains(listed("carol", "/api/v1/objectives"), "Private note") {
		t.Error("the administrator does not see every product and objective")
	}
	// Losing the repository grant hides the product and its objectives, but not a creator's own record.
	harness.user("carol", http.MethodPut, "/api/v1/admin/users/alice", `{"repositories":[]}`)
	harness.user("carol", http.MethodPut, "/api/v1/admin/users/erin", fmt.Sprintf(`{"repositories":[%q]}`, repositoryA))
	if !strings.Contains(listed("erin", "/api/v1/products"), "Payments") || !strings.Contains(listed("erin", "/api/v1/objectives"), "Ship refunds") ||
		strings.Contains(listed("erin", "/api/v1/objectives"), "Private note") {
		t.Error("a user granted the repository does not see exactly its product and objectives")
	}
}

func TestProfilesAndWorkflowsAreReadableByAllAndChangedOnlyByCreatorOrAdministrator(t *testing.T) {
	harness := newAdminHarness(t)
	profileBody := `{"name":"Reviewer","provider":"codex-cli","model":"default","tools":[]}`
	profile := decodeBody[agentProfile](t, harness.user("alice", http.MethodPost, "/api/v1/agents", profileBody), http.StatusCreated)
	workflowItem := decodeBody[workflow](t, harness.user("alice", http.MethodPost, "/api/v1/workflows", `{"name":"Release"}`), http.StatusCreated)
	if profile.CreatedBy != "alice" || workflowItem.CreatedBy != "alice" {
		t.Fatalf("creators = %q, %q", profile.CreatedBy, workflowItem.CreatedBy)
	}
	if !strings.Contains(harness.user("bob", http.MethodGet, "/api/v1/agents", "").Body.String(), "Reviewer") ||
		!strings.Contains(harness.user("bob", http.MethodGet, "/api/v1/workflows", "").Body.String(), "Release") {
		t.Error("profiles and workflows must be readable by every signed-in user")
	}
	workflowBody := `{"name":"Release 2","description":"","status":"draft","nodes":[{"id":"trigger","type":"trigger","position":{"x":0,"y":0},"data":{"label":"Trigger","description":""}}],"edges":[]}`
	changes := []struct{ method, path, body string }{
		{http.MethodPut, "/api/v1/agents/" + profile.ID, profileBody},
		{http.MethodPut, "/api/v1/workflows/" + workflowItem.ID, workflowBody},
	}
	for _, change := range changes {
		if response := harness.user("bob", change.method, change.path, change.body); response.Code != http.StatusForbidden {
			t.Errorf("another developer's %s returned HTTP %d", change.path, response.Code)
		}
		if response := harness.user("alice", change.method, change.path, change.body); response.Code != http.StatusOK {
			t.Errorf("the creator's %s returned HTTP %d: %s", change.path, response.Code, response.Body.String())
		}
		if response := harness.user("carol", change.method, change.path, change.body); response.Code != http.StatusOK {
			t.Errorf("the administrator's %s returned HTTP %d", change.path, response.Code)
		}
	}
	// Definitions without a recorded creator predate the policy and are left to administrators.
	for _, legacy := range []string{"/api/v1/agents/" + harness.profile.ID, "/api/v1/workflows/pr-review-release"} {
		body := profileBody
		if strings.Contains(legacy, "workflows") {
			body = workflowBody
		}
		if response := harness.user("alice", http.MethodPut, legacy, body); response.Code != http.StatusForbidden {
			t.Errorf("a developer changed %s: HTTP %d", legacy, response.Code)
		}
		if response := harness.user("carol", http.MethodPut, legacy, body); response.Code != http.StatusOK {
			t.Errorf("the administrator could not change %s: HTTP %d %s", legacy, response.Code, response.Body.String())
		}
	}
}

func TestWorkerIsStoppedAndItsResultRefusedOnceItsRepositoryGrantIsRemoved(t *testing.T) {
	harness := newAdminHarness(t)
	runBody := fmt.Sprintf(`{"agent_id":%q,"project_id":%q,"prompt":"Do the work."}`, harness.profile.ID, projectA)
	run := decodeBody[agentRun](t, harness.user("alice", http.MethodPost, "/api/v1/agent-runs", runBody), http.StatusAccepted)
	if response := harness.worker(http.MethodPost, "/api/v1/workers/"+aliceWorkerID+"/agent-runs/claim", aliceToken, ""); response.Code != http.StatusOK {
		t.Fatalf("claim returned HTTP %d", response.Code)
	}
	progressPath := "/api/v1/workers/" + aliceWorkerID + "/agent-runs/" + run.ID + "/progress"
	if response := harness.worker(http.MethodPost, progressPath, aliceToken, `{"attempts":1}`); response.Code != http.StatusOK {
		t.Fatalf("progress before revocation returned HTTP %d", response.Code)
	}
	revoke := `{"owner":"alice","repositories":[]}`
	if response := harness.user("carol", http.MethodPut, "/api/v1/admin/workers/"+aliceWorkerID, revoke); response.Code != http.StatusOK {
		t.Fatalf("revocation returned HTTP %d", response.Code)
	}
	if response := harness.worker(http.MethodPost, progressPath, aliceToken, `{"attempts":1}`); response.Code != http.StatusForbidden {
		t.Errorf("progress after revocation returned HTTP %d; the worker would keep running", response.Code)
	}
	result := `{"status":"succeeded","output":"done","attempts":1,"termination_reason":"completed"}`
	finishPath := "/api/v1/workers/" + aliceWorkerID + "/agent-runs/" + run.ID
	if response := harness.worker(http.MethodPut, finishPath, aliceToken, result); response.Code != http.StatusForbidden {
		t.Errorf("a result after revocation returned HTTP %d", response.Code)
	}
}
