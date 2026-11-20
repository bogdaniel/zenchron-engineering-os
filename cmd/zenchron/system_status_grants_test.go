package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMenuStatusGrantIsAdminOnlyScopedRevocableAndAudited(t *testing.T) {
	harness := newAdminHarness(t)
	harness.config.statusGrants = newSystemStatusGrantStore(t.TempDir())
	request := func(login, method, path, token string) *httptest.ResponseRecorder {
		harness.t.Helper()
		session, err := signSession(authUser{Login: login, ExpiresAt: time.Now().Add(time.Hour).Unix()}, harness.config.sessionKey)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "127.0.0.1:41000"
		req.AddCookie(&http.Cookie{Name: authSessionCookie, Value: session})
		req.Header.Set("Origin", harness.config.publicURL.String())
		if token != "" {
			req.Header.Set("X-Zenchron-Status-Grant", token)
		}
		response := httptest.NewRecorder()
		harness.server.ServeHTTP(response, req)
		return response
	}
	if got := request("alice", http.MethodPost, "/api/v1/system/status/credentials", "").Code; got != http.StatusForbidden {
		t.Fatalf("non-admin pairing returned HTTP %d", got)
	}
	if got := request("carol", http.MethodPost, "/api/v1/system/status/credentials", "").Code; got != http.StatusCreated {
		t.Fatalf("admin pairing returned HTTP %d", got)
	}
	created := request("carol", http.MethodPost, "/api/v1/system/status/credentials", "")
	if created.Code != http.StatusCreated {
		t.Fatalf("second admin pairing returned HTTP %d: %s", created.Code, created.Body.String())
	}
	var pair struct {
		ID         string    `json:"id"`
		Credential string    `json:"credential"`
		ExpiresAt  time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &pair); err != nil || pair.Credential == "" || pair.ID == "" {
		t.Fatalf("pairing response = %s, decode error %v", created.Body.String(), err)
	}
	if got := request("", http.MethodGet, "/api/v1/system/status", pair.Credential).Code; got != http.StatusOK {
		t.Fatalf("valid local grant returned HTTP %d", got)
	}
	if got := request("", http.MethodGet, "/api/v1/workers", pair.Credential).Code; got != http.StatusUnauthorized {
		t.Fatalf("status grant reached another API route: HTTP %d", got)
	}
	if got := request("", http.MethodGet, "/api/v1/system/status", "invalid").Code; got != http.StatusUnauthorized {
		t.Fatalf("invalid grant returned HTTP %d", got)
	}
	if got := request("carol", http.MethodDelete, "/api/v1/system/status/credentials/"+pair.ID, "").Code; got != http.StatusNoContent {
		t.Fatalf("revoke returned HTTP %d", got)
	}
	if got := request("", http.MethodGet, "/api/v1/system/status", pair.Credential).Code; got != http.StatusUnauthorized {
		t.Fatalf("revoked grant returned HTTP %d", got)
	}
	audit, err := os.ReadFile(harness.config.statusGrants.path + ".audit.jsonl")
	if err != nil || strings.Count(string(audit), "menu_status_") != 3 || strings.Contains(string(audit), pair.Credential) {
		t.Fatalf("grant audit = %s, read error %v", audit, err)
	}
}

func TestMenuStatusGrantExpiresAndLosesAuthorizationWhenOwnerIsRemoved(t *testing.T) {
	harness := newAdminHarness(t)
	harness.config.statusGrants = newSystemStatusGrantStore(t.TempDir())
	created := authenticatedLoopbackRequest(t, harness, "carol", http.MethodPost, "/api/v1/system/status/credentials")
	if created.Code != http.StatusCreated {
		t.Fatalf("pairing returned HTTP %d: %s", created.Code, created.Body.String())
	}
	var pair struct{ ID, Credential string }
	if err := json.Unmarshal(created.Body.Bytes(), &pair); err != nil {
		t.Fatal(err)
	}
	store := harness.config.statusGrants
	state, err := store.load()
	if err != nil {
		t.Fatal(err)
	}
	state.Grants[0].CreatedAt = time.Now().Add(-systemStatusGrantLifetime - time.Second)
	state.Grants[0].ExpiresAt = state.Grants[0].CreatedAt.Add(systemStatusGrantLifetime)
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	if got := localStatusGrantRequest(harness, pair.Credential).Code; got != http.StatusUnauthorized {
		t.Fatalf("expired grant returned HTTP %d", got)
	}
	state, err = store.load()
	if err != nil {
		t.Fatal(err)
	}
	state.Grants[0].CreatedAt = time.Now()
	state.Grants[0].ExpiresAt = state.Grants[0].CreatedAt.Add(time.Hour)
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(harness.path, []byte(`{"admins":[],"workers":[],"users":{"carol":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := localStatusGrantRequest(harness, pair.Credential).Code; got != http.StatusUnauthorized {
		t.Fatalf("grant after admin removal returned HTTP %d", got)
	}
}

func TestMenuStatusGrantAuditFailureDoesNotLeaveAnUnauditedCredentialChange(t *testing.T) {
	harness := newAdminHarness(t)
	harness.config.statusGrants = newSystemStatusGrantStore(t.TempDir())
	store := harness.config.statusGrants
	if err := os.Mkdir(store.path+".audit.jsonl", 0o700); err != nil {
		t.Fatal(err)
	}
	if response := authenticatedLoopbackRequest(t, harness, "carol", http.MethodPost,
		"/api/v1/system/status/credentials"); response.Code != http.StatusInternalServerError {
		t.Fatalf("unaudited pair creation returned HTTP %d", response.Code)
	}
	state, err := store.load()
	if err != nil || len(state.Grants) != 0 {
		t.Fatalf("unaudited credential remained stored: %#v, %v", state.Grants, err)
	}
	if err := os.Remove(store.path + ".audit.jsonl"); err != nil {
		t.Fatal(err)
	}
	created := authenticatedLoopbackRequest(t, harness, "carol", http.MethodPost,
		"/api/v1/system/status/credentials")
	var pair struct{ ID string }
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &pair) != nil {
		t.Fatalf("audited pair creation returned HTTP %d: %s", created.Code, created.Body.String())
	}
	if err := os.Remove(store.path + ".audit.jsonl"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.path+".audit.jsonl", 0o700); err != nil {
		t.Fatal(err)
	}
	if response := authenticatedLoopbackRequest(t, harness, "carol", http.MethodDelete,
		"/api/v1/system/status/credentials/"+pair.ID); response.Code != http.StatusInternalServerError {
		t.Fatalf("unaudited revocation returned HTTP %d", response.Code)
	}
	state, err = store.load()
	if err != nil || len(state.Grants) != 1 || state.Grants[0].ID != pair.ID {
		t.Fatalf("unaudited revocation changed the stored credential: %#v, %v", state.Grants, err)
	}
}

func authenticatedLoopbackRequest(t *testing.T, harness *accessHarness, login, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	session, err := signSession(authUser{Login: login, ExpiresAt: time.Now().Add(time.Hour).Unix()}, harness.config.sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, nil)
	request.RemoteAddr = "127.0.0.1:41000"
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: session})
	request.Header.Set("Origin", harness.config.publicURL.String())
	response := httptest.NewRecorder()
	harness.server.ServeHTTP(response, request)
	return response
}

func localStatusGrantRequest(harness *accessHarness, token string) *httptest.ResponseRecorder {
	harness.t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system/status", nil)
	request.RemoteAddr = "127.0.0.1:41000"
	request.Header.Set("X-Zenchron-Status-Grant", token)
	response := httptest.NewRecorder()
	harness.server.ServeHTTP(response, request)
	return response
}
