package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestManagedOAuthSetupCompletesLocalOnboarding(t *testing.T) {
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}

	var runtime http.Handler
	restarts := 0
	var output strings.Builder
	err := setupManagedOAuth(home, strings.NewReader("managed-client\nEngineer\n"), &output,
		func(io.Writer) (string, error) { return "private-client-secret", nil },
		func() error { return nil }, func() (int, error) { return 0, nil },
		func() error {
			restarts++
			config, err := readManagedOAuthConfig(home)
			if err != nil || config == nil {
				return fmt.Errorf("load saved OAuth configuration: %v", err)
			}
			environment, err := managedOAuthEnvironment(home, []string{"PATH=/bin"})
			if err != nil {
				return err
			}
			lookup := func(key string) string { return environmentValue(environment, key) }
			auth, configured, err := loadAuthConfigFrom(lookup)
			if err != nil || !configured {
				return fmt.Errorf("start managed OAuth runtime: configured=%t, error=%v", configured, err)
			}
			auth.githubURL, auth.githubAPIURL = "https://github.test", "https://api.github.test"
			auth.oauthHTTPClient = &http.Client{Transport: oauthTestTransport(
				func(request *http.Request) (*http.Response, error) {
					body := `{"access_token":"one-time-user-token"}`
					if request.URL.Path == "/login/oauth/access_token" {
						if err := request.ParseForm(); err != nil {
							return nil, err
						}
						if request.Form.Get("client_secret") != config.ClientSecret ||
							request.Form.Get("redirect_uri") != managedOAuthCallback {
							return nil, fmt.Errorf("token exchange used unexpected credentials or callback")
						}
					} else if request.URL.Path == "/user" {
						if request.Header.Get("Authorization") != "Bearer one-time-user-token" {
							return nil, fmt.Errorf("identity request omitted the exchanged token")
						}
						body = `{"login":"Engineer"}`
					} else {
						return nil, fmt.Errorf("unexpected GitHub request path %q", request.URL.Path)
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
						Body: io.NopCloser(strings.NewReader(body))}, nil
				})}
			runtime = authHandler(http.NotFoundHandler(), auth)
			return nil
		},
		func(string) error {
			if runtime == nil {
				return fmt.Errorf("managed runtime was not started")
			}
			request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
			request.Host = "127.0.0.1:8080"
			response := httptest.NewRecorder()
			runtime.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				return fmt.Errorf("new OAuth runtime session status = %d, want %d", response.Code, http.StatusUnauthorized)
			}
			return nil
		}, func(string) error { return nil })
	if err != nil {
		t.Fatalf("complete managed OAuth setup: %v", err)
	}
	if restarts != 1 {
		t.Fatalf("managed runtime restarts = %d, want 1", restarts)
	}
	if strings.Contains(output.String(), "private-client-secret") ||
		!strings.Contains(output.String(), managedOAuthCallback) {
		t.Fatalf("setup output leaked a secret or omitted callback instructions: %q", output.String())
	}
	info, err := os.Stat(managedOAuthConfigPath(home))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("saved OAuth configuration permissions = %v, %v; want 0600", info, err)
	}

	returnTo := "/?mode=live#settings"
	start := httptest.NewRecorder()
	startRequest := httptest.NewRequest(http.MethodGet,
		"/auth/github?return="+url.QueryEscape(returnTo), nil)
	startRequest.Host = "127.0.0.1:8080"
	runtime.ServeHTTP(start, startRequest)
	if start.Code != http.StatusFound {
		t.Fatalf("OAuth start returned HTTP %d: %s", start.Code, start.Body.String())
	}
	stateCookie := start.Result().Cookies()[0]
	authorizeURL, err := url.Parse(start.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	callback := httptest.NewRecorder()
	callbackRequest := httptest.NewRequest(http.MethodGet,
		"/auth/github/callback?code=short-lived&state="+url.QueryEscape(authorizeURL.Query().Get("state")), nil)
	callbackRequest.Host = "127.0.0.1:8080"
	callbackRequest.AddCookie(stateCookie)
	runtime.ServeHTTP(callback, callbackRequest)
	if callback.Code != http.StatusSeeOther || callback.Header().Get("Location") != returnTo {
		t.Fatalf("OAuth callback = %d to %q, want %q", callback.Code, callback.Header().Get("Location"), returnTo)
	}
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name != authSessionCookie {
			continue
		}
		request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
		request.Host = "127.0.0.1:8080"
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		runtime.ServeHTTP(response, request)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"login":"Engineer"`) {
			t.Fatalf("allowlisted login session = %d %s", response.Code, response.Body.String())
		}
		return
	}
	t.Fatal("allowlisted OAuth callback did not create a session cookie")
}
