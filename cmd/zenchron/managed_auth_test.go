package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestManagedOAuthConfigEnablesLoopbackSignInWithoutReplacingWorkerCredential(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := managedOAuthConfig{ClientID: "oauth-client", ClientSecret: "oauth-secret",
		SessionKey: strings.Repeat("s", 48), AllowedUsers: []string{"Engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, config); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(managedOAuthConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("OAuth config permissions = %04o, want 0600", info.Mode().Perm())
	}

	existingWorkerToken := "existing-worker-token-value-123456789"
	environment, err := managedOAuthEnvironment(home, []string{"PATH=/bin", "ZENCHRON_WORKER_TOKEN=" + existingWorkerToken})
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(key string) string {
		for _, entry := range environment {
			if value, ok := strings.CutPrefix(entry, key+"="); ok {
				return value
			}
		}
		return ""
	}
	if lookup("ZENCHRON_WORKER_TOKEN") != existingWorkerToken {
		t.Fatal("managed OAuth setup replaced the existing worker credential")
	}
	auth, configured, err := loadAuthConfigFrom(lookup)
	if err != nil || !configured {
		t.Fatalf("managed OAuth config = (%v, %v, %v)", auth, configured, err)
	}
	if auth.publicURL.String() != "http://127.0.0.1:8080" {
		t.Fatalf("OAuth origin = %q, want loopback origin", auth.publicURL)
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/auth/github?return="+url.QueryEscape("/?mode=live#settings"), nil)
	authHandler(http.NotFoundHandler(), auth).ServeHTTP(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("OAuth start returned HTTP %d: %s", response.Code, response.Body.String())
	}
	authorizeURL, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if got := authorizeURL.Query().Get("redirect_uri"); got != managedOAuthCallback {
		t.Fatalf("OAuth redirect_uri = %q, want %q", got, managedOAuthCallback)
	}
}

func TestManagedOAuthSetupCompletesAllowlistedDashboardLogin(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := managedOAuthConfig{ClientID: "managed-client", ClientSecret: "managed-secret",
		SessionKey: strings.Repeat("s", 48), AllowedUsers: []string{"engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, config); err != nil {
		t.Fatal(err)
	}
	environment, err := managedOAuthEnvironment(home, []string{"PATH=/bin"})
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(key string) string { return environmentValue(environment, key) }
	auth, configured, err := loadAuthConfigFrom(lookup)
	if err != nil || !configured {
		t.Fatalf("loaded managed OAuth config = (%v, %v, %v)", auth, configured, err)
	}
	auth.githubURL, auth.githubAPIURL = "https://github.test", "https://api.github.test"
	auth.oauthHTTPClient = &http.Client{Transport: oauthTestTransport(func(request *http.Request) (*http.Response, error) {
		body := `{"access_token":"one-time-user-token"}`
		if request.URL.Path == "/login/oauth/access_token" {
			if err := request.ParseForm(); err != nil {
				return nil, err
			}
			if request.Form.Get("client_secret") != config.ClientSecret || request.Form.Get("redirect_uri") != managedOAuthCallback {
				t.Errorf("OAuth exchange contained unexpected secret or callback")
			}
		} else if request.URL.Path == "/user" {
			if request.Header.Get("Authorization") != "Bearer one-time-user-token" {
				t.Errorf("identity request did not use exchanged GitHub token")
			}
			body = `{"login":"Engineer"}`
		} else {
			return nil, fmt.Errorf("unexpected GitHub path %q", request.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	server := authHandler(http.NotFoundHandler(), auth)
	returnTo := "/?mode=live#settings"
	start := httptest.NewRecorder()
	server.ServeHTTP(start, httptest.NewRequest(http.MethodGet,
		"/auth/github?return="+url.QueryEscape(returnTo), nil))
	stateCookie := start.Result().Cookies()[0]
	authorizeURL, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := authorizeURL.Query().Get("state")
	callback := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet,
		"/auth/github/callback?code=short-lived&state="+url.QueryEscape(state), nil)
	request.AddCookie(stateCookie)
	server.ServeHTTP(callback, request)
	if callback.Code != http.StatusSeeOther || callback.Header().Get("Location") != returnTo {
		t.Fatalf("OAuth callback = %d to %q, want %q", callback.Code, callback.Header().Get("Location"), returnTo)
	}
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name != authSessionCookie {
			continue
		}
		check := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
		check.AddCookie(cookie)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, check)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"login":"Engineer"`) {
			t.Fatalf("authenticated session = %d %s", response.Code, response.Body.String())
		}
		return
	}
	t.Fatal("OAuth callback did not create a session cookie")
}

type oauthTestTransport func(*http.Request) (*http.Response, error)

func (transport oauthTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestManagedOAuthConfigIsNotOverwrittenAndInsecureFileIsRejected(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	first := managedOAuthConfig{ClientID: "first", ClientSecret: "secret", SessionKey: strings.Repeat("s", 48),
		AllowedUsers: []string{"engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, first); err != nil {
		t.Fatal(err)
	}
	second := first
	second.ClientID = "second"
	if err := writeManagedOAuthConfig(home, second); err == nil || !strings.Contains(err.Error(), "already configured") {
		t.Fatalf("second setup error = %v, want refusal to overwrite", err)
	}
	stored, err := readManagedOAuthConfig(home)
	if err != nil || stored.ClientID != "first" {
		t.Fatalf("stored config after repeated setup = (%#v, %v)", stored, err)
	}

	if err := os.Chmod(managedOAuthConfigPath(home), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedOAuthConfig(home); err == nil || !strings.Contains(err.Error(), "private regular file") {
		t.Fatalf("insecure config mode error = %v, want fail-closed privacy check", err)
	}
}

func TestManagedOAuthConfigRejectsFileSymlinks(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(home, "existing-owner-file")
	if err := os.WriteFile(target, []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, managedOAuthConfigPath(home)); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedOAuthConfig(home); err == nil || !strings.Contains(err.Error(), "private regular file") {
		t.Fatalf("symlink config read error = %v, want rejection", err)
	}
	config := managedOAuthConfig{ClientID: "dummy", ClientSecret: "dummy", SessionKey: strings.Repeat("s", 48),
		AllowedUsers: []string{"engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, config); err == nil || !strings.Contains(err.Error(), "already configured") {
		t.Fatalf("symlink config write error = %v, want no-overwrite refusal", err)
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "preserved" {
		t.Fatalf("symlink target changed: %q, %v", contents, err)
	}
}

func TestManagedOAuthDoesNotReplaceExistingAccessPolicyCredentials(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	config := managedOAuthConfig{ClientID: "client", ClientSecret: "secret", SessionKey: strings.Repeat("s", 48),
		AllowedUsers: []string{"engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, config); err != nil {
		t.Fatal(err)
	}
	if _, err := managedOAuthEnvironment(home, []string{"ZENCHRON_ACCESS_FILE=/private/existing-access.json"}); err == nil ||
		!strings.Contains(err.Error(), "existing enrolled worker token") {
		t.Fatalf("access-file setup error = %v, want fail-closed preservation", err)
	}
	existingClientID := "existing-oauth-client"
	environment := []string{"ZENCHRON_GITHUB_CLIENT_ID=" + existingClientID}
	merged, err := managedOAuthEnvironment(home, environment)
	if err != nil || len(merged) != 1 || merged[0] != environment[0] {
		t.Fatalf("existing environment config was changed: %v, %v", merged, err)
	}
}

func TestGitHubSignInNotConfiguredExplainsManagedSetup(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/auth/github", nil)
	authHandler(http.NotFoundHandler(), nil).ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "zenchron-engineering auth setup") ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unconfigured OAuth response = %d %q headers=%v", response.Code, response.Body.String(), response.Header())
	}
}

func TestManagedOAuthSetupRecognizesExistingOAuthSession(t *testing.T) {
	configured, err := managedOAuthSessionIsConfigured(http.StatusOK,
		strings.NewReader(`{"authenticated":true,"local":false,"login":"engineer"}`))
	if err != nil || !configured {
		t.Fatalf("configured OAuth session = (%v, %v), want true, nil", configured, err)
	}
	configured, err = managedOAuthSessionIsConfigured(http.StatusOK,
		strings.NewReader(`{"authenticated":true,"local":true,"login":"Local workspace"}`))
	if err != nil || configured {
		t.Fatalf("local workspace session = (%v, %v), want false, nil", configured, err)
	}
	configured, err = managedOAuthSessionIsConfigured(http.StatusUnauthorized, strings.NewReader(""))
	if err != nil || !configured {
		t.Fatalf("unauthenticated OAuth session = (%v, %v), want true, nil", configured, err)
	}
}

func TestManagedOAuthRollbackRestartsAndVerifiesLocalWorkspace(t *testing.T) {
	home := t.TempDir()
	path := managedOAuthConfigPath(home)
	if err := os.WriteFile(path, []byte(`{"client_id":"temporary"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls []string
	err := rollbackManagedOAuthConfig(home, func() error {
		calls = append(calls, "restart")
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("OAuth configuration still exists during rollback restart")
		}
		return nil
	}, func(readyHome string) error {
		calls = append(calls, "verify")
		if readyHome != home {
			t.Fatalf("rollback checked managed home %q, want %q", readyHome, home)
		}
		return nil
	})
	if err != nil || !reflect.DeepEqual(calls, []string{"restart", "verify"}) {
		t.Fatalf("rollback = (%v, %v), want restart then verify", calls, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("OAuth config survived rollback: %v", err)
	}
}

func TestManagedOAuthConfigRejectsInsecureInstallHome(t *testing.T) {
	parent := t.TempDir()
	home := filepath.Join(parent, "public")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	config := managedOAuthConfig{ClientID: "id", ClientSecret: "secret", SessionKey: strings.Repeat("s", 48),
		AllowedUsers: []string{"engineer"}, WorkerToken: testWorkerToken}
	if err := writeManagedOAuthConfig(home, config); err == nil || !strings.Contains(err.Error(), "private real directory") {
		t.Fatalf("public install home error = %v, want rejection", err)
	}
	linkedHome := filepath.Join(parent, "linked")
	if err := os.Symlink(parent, linkedHome); err != nil {
		t.Fatal(err)
	}
	if _, err := readManagedOAuthConfig(linkedHome); err == nil || !strings.Contains(err.Error(), "private real directory") {
		t.Fatalf("symlinked install home read error = %v, want rejection", err)
	}
	if err := writeManagedOAuthConfig(linkedHome, config); err == nil || !strings.Contains(err.Error(), "private real directory") {
		t.Fatalf("symlinked install home write error = %v, want rejection", err)
	}
}

func TestManagedOAuthSetupCollectsAllowedUsersWithoutEchoingSecret(t *testing.T) {
	var output bytes.Buffer
	config, err := collectManagedOAuthConfig(strings.NewReader("client-id\nEngineer, Maintainer\n"), &output,
		func(io.Writer) (string, error) { return "private-client-secret", nil })
	if err != nil {
		t.Fatal(err)
	}
	if config.ClientID != "client-id" || config.ClientSecret != "private-client-secret" ||
		len(config.AllowedUsers) != 2 || config.AllowedUsers[0] != "engineer" || config.AllowedUsers[1] != "maintainer" {
		t.Fatalf("collected OAuth config = %#v", config)
	}
	if strings.Contains(output.String(), config.ClientSecret) || !strings.Contains(output.String(), managedOAuthCallback) {
		t.Fatalf("setup output leaked a secret or omitted callback instructions: %q", output.String())
	}
	if len(config.SessionKey) < 32 || len(config.WorkerToken) < 32 {
		t.Fatal("setup did not generate sufficient session and worker credentials")
	}
}
