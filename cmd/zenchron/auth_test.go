package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAuthenticationSeparatesDashboardAndWorkerRequests(t *testing.T) {
	config := testAuthConfig()
	server := authHandler(newMux(), config)
	for _, test := range []struct {
		method, path, authorization string
		status                      int
	}{
		{http.MethodGet, "/api/v1/workers", "", http.StatusUnauthorized},
		{http.MethodPut, "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat", "", http.StatusUnauthorized},
		{http.MethodPut, "/api/v1/workers/0123456789abcdef0123456789abcdef/heartbeat", "Bearer " + testWorkerToken, http.StatusOK},
		{http.MethodGet, "/api/v1/workers", "Bearer " + testWorkerToken, http.StatusUnauthorized},
	} {
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(`{"name":"test"}`))
		request.Header.Set("Authorization", test.authorization)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Errorf("%s %s with %q returned %d, want %d", test.method, test.path, test.authorization, response.Code, test.status)
		}
	}
}

func TestGitHubOAuthCreatesAllowlistedSession(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/oauth/access_token":
			if err := r.ParseForm(); err != nil || r.Form.Get("code") != "one-time-code" || r.Form.Get("client_secret") != "client-secret" {
				t.Errorf("token request form = %v, error = %v", r.Form, err)
			}
			_, _ = w.Write([]byte(`{"access_token":"temporary-user-token"}`))
		case "/api/user":
			if r.Header.Get("Authorization") != "Bearer temporary-user-token" {
				t.Errorf("identity authorization = %q", r.Header.Get("Authorization"))
			}
			if r.Header.Get("X-GitHub-Api-Version") != "2022-11-28" || r.Header.Get("User-Agent") != "Zenchron-Engineering" {
				t.Errorf("GitHub API headers = %v", r.Header)
			}
			_, _ = w.Write([]byte(`{"login":"Engineer","avatar_url":"https://avatars.example/u.png"}`))
		default:
			t.Errorf("unexpected provider path %q", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	config := testAuthConfig()
	config.githubURL = provider.URL
	server := authHandler(newMux(), config)

	start := httptest.NewRecorder()
	server.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/auth/github", nil))
	if start.Code != http.StatusFound {
		t.Fatalf("OAuth start returned HTTP %d", start.Code)
	}
	stateCookie := start.Result().Cookies()[0]
	authorizeURL, err := url.Parse(start.Header().Get("Location"))
	if err != nil || authorizeURL.Query().Get("state") != stateCookie.Value || authorizeURL.Query().Get("scope") != "read:user" {
		t.Fatalf("authorization URL = %q, parse error = %v", start.Header().Get("Location"), err)
	}

	callback := httptest.NewRequest(http.MethodGet, "/auth/github/callback?code=one-time-code&state="+url.QueryEscape(stateCookie.Value), nil)
	callback.AddCookie(stateCookie)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, callback)
	if response.Code != http.StatusSeeOther {
		t.Fatalf("OAuth callback returned HTTP %d: %s", response.Code, response.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == authSessionCookie {
			sessionCookie = cookie
		}
	}
	if sessionCookie == nil || !sessionCookie.HttpOnly || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie = %#v", sessionCookie)
	}
	sessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	sessionRequest.AddCookie(sessionCookie)
	sessionResponse := httptest.NewRecorder()
	server.ServeHTTP(sessionResponse, sessionRequest)
	var session map[string]any
	if err := json.Unmarshal(sessionResponse.Body.Bytes(), &session); err != nil || sessionResponse.Code != http.StatusOK ||
		session["login"] != "Engineer" || session["authenticated"] != true {
		t.Fatalf("session = %#v, body %s, error %v, HTTP %d", session, sessionResponse.Body.String(), err, sessionResponse.Code)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/workers", nil)
	request.AddCookie(sessionCookie)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("allowlisted session could not read dashboard API: HTTP %d", response.Code)
	}
	logout := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logout.Host = "zenchron.example"
	logout.Header.Set("Origin", "https://zenchron.example")
	logout.AddCookie(sessionCookie)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, logout)
	if response.Code != http.StatusNoContent || response.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatalf("logout response = HTTP %d, cookies %#v", response.Code, response.Result().Cookies())
	}
	logout.Header.Set("Origin", "https://attacker.example")
	response = httptest.NewRecorder()
	server.ServeHTTP(response, logout)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin logout returned HTTP %d", response.Code)
	}
}

func TestGitHubOAuthRejectsStateAndUnlistedUsers(t *testing.T) {
	config := testAuthConfig()
	server := authHandler(newMux(), config)
	request := httptest.NewRequest(http.MethodGet, "/auth/github/callback?code=x&state=wrong", nil)
	request.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "expected"})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("mismatched OAuth state returned HTTP %d", response.Code)
	}

	config.allowedUsers = []string{"someone-else"}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login/oauth/access_token" {
			_, _ = w.Write([]byte(`{"access_token":"temporary"}`))
			return
		}
		_, _ = w.Write([]byte(`{"login":"Engineer"}`))
	}))
	defer provider.Close()
	config.githubURL = provider.URL
	start := httptest.NewRecorder()
	server.ServeHTTP(start, httptest.NewRequest(http.MethodGet, "/auth/github", nil))
	state := start.Result().Cookies()[0]
	request = httptest.NewRequest(http.MethodGet, "/auth/github/callback?code=x&state="+url.QueryEscape(state.Value), nil)
	request.AddCookie(state)
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("unlisted GitHub account returned HTTP %d", response.Code)
	}
}

func TestOAuthTokenExchangeDoesNotFollowRedirects(t *testing.T) {
	targetHit := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHit <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer provider.Close()
	config := testAuthConfig()
	config.githubURL = provider.URL
	request := httptest.NewRequest(http.MethodGet, "/auth/github/callback", nil)
	if _, err := fetchGitHubUser(request, config, "one-time-code"); err == nil {
		t.Fatal("OAuth redirect was accepted")
	}
	select {
	case <-targetHit:
		t.Fatal("OAuth redirect target was reached")
	default:
	}
}

func TestReadSessionRejectsTamperingAndExpiry(t *testing.T) {
	config := testAuthConfig()
	user := authUser{Login: "Engineer", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	value, err := signSession(user, config.sessionKey)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: value})
	if _, ok := readSession(request, config); !ok {
		t.Fatal("valid session was rejected")
	}
	request = httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: "x" + value})
	if _, ok := readSession(request, config); ok {
		t.Fatal("tampered session was accepted")
	}
	value, _ = signSession(authUser{Login: "Engineer", ExpiresAt: time.Now().Add(-time.Hour).Unix()}, config.sessionKey)
	request = httptest.NewRequest(http.MethodGet, "/", nil)
	request.AddCookie(&http.Cookie{Name: authSessionCookie, Value: value})
	if _, ok := readSession(request, config); ok {
		t.Fatal("expired session was accepted")
	}
}

func testAuthConfig() *authConfig {
	return &authConfig{clientID: "client-id", clientSecret: "client-secret", sessionKey: []byte(strings.Repeat("s", 32)),
		workerToken: testWorkerToken, allowedUsers: []string{"engineer"}, publicURL: mustURL("https://zenchron.example"), https: true,
		githubURL: "https://github.com"}
}

const testWorkerToken = "worker-secret-for-auth-tests-1234567890"

func TestLoadAuthConfigRequiresCompleteRemoteConfiguration(t *testing.T) {
	keys := []string{"ZENCHRON_GITHUB_CLIENT_ID", "ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_WORKER_TOKEN", "ZENCHRON_GITHUB_ALLOWED_USERS", "ZENCHRON_PUBLIC_URL"}
	for _, key := range keys {
		t.Setenv(key, "")
	}
	if config, configured, err := loadAuthConfig(); err != nil || configured || config != nil {
		t.Fatalf("empty auth configuration = (%v, %v, %v)", config, configured, err)
	}
	t.Setenv("ZENCHRON_GITHUB_CLIENT_ID", "client")
	if _, _, err := loadAuthConfig(); err == nil {
		t.Fatal("partial authentication configuration was accepted")
	}
	t.Setenv("ZENCHRON_GITHUB_CLIENT_SECRET", "secret")
	t.Setenv("ZENCHRON_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("ZENCHRON_WORKER_TOKEN", testWorkerToken)
	t.Setenv("ZENCHRON_GITHUB_ALLOWED_USERS", " Engineer, Maintainer ")
	t.Setenv("ZENCHRON_PUBLIC_URL", "https://zenchron.example")
	config, configured, err := loadAuthConfig()
	if err != nil || !configured || len(config.allowedUsers) != 2 || config.allowedUsers[0] != "engineer" || !config.https {
		t.Fatalf("valid auth configuration = (%v, %v, %v)", config, configured, err)
	}
}

func TestRunRejectsRemoteListenerWithoutSecureAuthentication(t *testing.T) {
	t.Setenv("ZENCHRON_LISTEN_ADDR", "0.0.0.0:0")
	for _, key := range []string{"ZENCHRON_GITHUB_CLIENT_ID", "ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_WORKER_TOKEN", "ZENCHRON_GITHUB_ALLOWED_USERS", "ZENCHRON_PUBLIC_URL"} {
		t.Setenv(key, "")
	}
	if err := run(); err == nil || !strings.Contains(err.Error(), "requires GitHub authentication") {
		t.Fatalf("remote listener without auth returned %v", err)
	}
	t.Setenv("ZENCHRON_GITHUB_CLIENT_ID", "client")
	t.Setenv("ZENCHRON_GITHUB_CLIENT_SECRET", "secret")
	t.Setenv("ZENCHRON_SESSION_SECRET", strings.Repeat("s", 32))
	t.Setenv("ZENCHRON_WORKER_TOKEN", testWorkerToken)
	t.Setenv("ZENCHRON_GITHUB_ALLOWED_USERS", "engineer")
	t.Setenv("ZENCHRON_PUBLIC_URL", "http://zenchron.example")
	if err := run(); err == nil || !strings.Contains(err.Error(), "must use https") {
		t.Fatalf("remote listener without HTTPS returned %v", err)
	}
}

func mustURL(value string) *url.URL {
	parsed, _ := url.Parse(value)
	return parsed
}
