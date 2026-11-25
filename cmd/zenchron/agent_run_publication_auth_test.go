package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestPublicationRequiresAccessToTheRunWorker(t *testing.T) {
	harness := newDeliveryHarness(t, workerapi.ProviderCodex)
	run := harness.createIssueRun()
	harness.claim()
	result := strings.Replace(pushedResult, `"branch_pushed":true`, `"branch_pushed":false`, 1)
	if _, status := harness.finish(run.ID, result); status != http.StatusOK {
		t.Fatalf("finish candidate returned HTTP %d", status)
	}
	config := requirePublicationAccess(t, harness, "bob")
	response := publishAs(t, harness.server, config, "alice", run.ID, testCommit)
	if response.Code != http.StatusForbidden {
		t.Fatalf("publish from another user's worker returned HTTP %d: %s", response.Code, response.Body.String())
	}
	assertPublicationWasNotQueued(t, harness, run.ID, 1)
}

func TestPublicationRequiresVisibilityOfItsObjective(t *testing.T) {
	harness := newGraphHarness(t)
	harness.start(harness.planBody(unitJSON("api", unitProduce, harness.profile.ID),
		unitJSON("review-api", unitReview, harness.reviewer.ID, "api"),
		unitJSON("integrate", unitIntegrate, "", "review-api"),
		unitJSON("review-all", unitReview, harness.reviewer.ID, "integrate")))
	harness.handOff(harness.claimUnit("api"), commit(1), "api")
	harness.verdict(harness.claimUnit("review-api"), commit(1), `{"review":{"verdict":"accept"}}`)
	integration := harness.claimUnit("integrate")
	harness.report(integration, workerapi.AgentRunResult{CommitSHA: commit(4), BaseCommit: commit(9), Result: `{"integration":{}}`})
	harness.verdict(harness.claimUnit("review-all"), commit(4), `{"review":{"verdict":"accept"}}`)
	config := requirePublicationAccess(t, harness.deliveryHarness, "")
	response := publishAs(t, harness.server, config, "alice", integration.ID, commit(4))
	if response.Code != http.StatusNotFound {
		t.Fatalf("publish for an invisible objective returned HTTP %d: %s", response.Code, response.Body.String())
	}
	assertPublicationWasNotQueued(t, harness.deliveryHarness, integration.ID, integration.Attempts)
}

func requirePublicationAccess(t *testing.T, harness *deliveryHarness, workerOwner string) *authConfig {
	t.Helper()
	content := fmt.Sprintf(`{"workers":[{"id":%q,"token_sha256":%q,"owner":%q,"repositories":[%q]}],`+
		`"users":{"alice":[%q]}}`, testWorkerID, tokenHash("publication-auth-test-worker-token"), workerOwner,
		"github.com/acme/platform", "github.com/acme/platform")
	path := writeAccessFile(t, content)
	policy, err := loadAccessPolicyAt(path)
	if err != nil {
		t.Fatal(err)
	}
	config := testAuthConfig()
	config.allowedUsers = []string{"alice", "bob"}
	config.access = policy
	graphs := harness.store.graphs
	harness.server = authHandler(newMuxWithStores(graphs.objectives, graphs.workflows, harness.store.agents,
		newProductStore(), harness.store.registry, harness.store), config)
	return config
}

func publishAs(t *testing.T, server http.Handler, config *authConfig, login, runID, candidate string) *httptest.ResponseRecorder {
	t.Helper()
	session, err := signSession(authUser{Login: login, ExpiresAt: time.Now().Add(time.Hour).Unix()}, config.sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	request := jsonRequest(http.MethodPost, "/api/v1/agent-runs/"+runID+"/publish",
		strings.NewReader(fmt.Sprintf(`{"candidate_sha":%q}`, candidate)))
	request.RemoteAddr = "203.0.113.10:41000"
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: session})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func assertPublicationWasNotQueued(t *testing.T, harness *deliveryHarness, runID string, attempts int) {
	t.Helper()
	current, exists := harness.store.get(runID)
	if !exists || current.Status != "succeeded" || current.Attempts != attempts || current.Publishing ||
		current.PublishOnly || len(current.PublicationAuthorizations) != 0 || harness.pullCreates != 0 {
		t.Fatalf("rejected publication changed run state: exists %t run %#v pull creates %d", exists, current, harness.pullCreates)
	}
}
