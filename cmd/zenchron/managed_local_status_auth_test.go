package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/updater"
)

func TestLocalStatusCredentialReadsUpdaterAndActiveRunsWithSessionAuthEnabled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	harness := newAdminHarness(t)
	token := "owner-local-status-token"
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", token)
	statusPath := filepath.Join(t.TempDir(), "system-update.json")
	want := updater.Status{RunningRevision: "0123456789abcdef0123456789abcdef01234567",
		LatestRevision: "0123456789abcdef0123456789abcdef01234567", State: "idle",
		LastAttempt: time.Now().UTC()}
	if err := updater.WriteStatus(statusPath, want); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZENCHRON_UPDATE_STATUS_FILE", statusPath)

	request := func(method, path, credential, remote string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = remote
		req.Host = "127.0.0.1:8080"
		if credential != "" {
			req.Header.Set(localStatusCredentialHeader, credential)
		}
		response := httptest.NewRecorder()
		harness.server.ServeHTTP(response, req)
		return response
	}
	for _, path := range []string{"/api/v1/system/update", "/api/v1/system/update/active-runs"} {
		if got := request(http.MethodGet, path, token, "127.0.0.1:43210"); got.Code != http.StatusOK {
			t.Errorf("local status token request to %s returned HTTP %d: %s", path, got.Code, got.Body.String())
		}
		for _, credential := range []string{"", "invalid-local-status-token"} {
			if got := request(http.MethodGet, path, credential, "127.0.0.1:43210"); got.Code != http.StatusUnauthorized {
				t.Errorf("request to %s with invalid credentials returned HTTP %d, want %d", path, got.Code, http.StatusUnauthorized)
			}
		}
		if got := request(http.MethodGet, path, token, "192.0.2.20:43210"); got.Code != http.StatusUnauthorized {
			t.Errorf("remote local-status token request to %s returned HTTP %d, want %d", path, got.Code, http.StatusUnauthorized)
		}
	}
	if got := request(http.MethodGet, "/api/v1/system/status", token, "127.0.0.1:43210"); got.Code != http.StatusUnauthorized {
		t.Fatalf("local status token bypassed system-status session auth: HTTP %d", got.Code)
	}
	if got := request(http.MethodGet, "/api/v1/workers", token, "127.0.0.1:43210"); got.Code != http.StatusUnauthorized {
		t.Fatalf("local status token reached another API route: HTTP %d", got.Code)
	}
	if got := request(http.MethodPost, "/api/v1/system/update", token, "127.0.0.1:43210"); got.Code != http.StatusUnauthorized {
		t.Fatalf("local status token reached a non-read-only method: HTTP %d", got.Code)
	}
}

func TestManagedStatusRequestsDoNotFollowRedirects(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	token := "owner-local-status-token"
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", token)
	for _, scenario := range []struct {
		name string
		call func(*http.Client) error
	}{
		{name: "updater status", call: func(client *http.Client) error {
			_, _, _, err := readManagedUpdaterStatus(client)
			return err
		}},
		{name: "active-run preflight", call: func(client *http.Client) error {
			_, err := managedOAuthActiveRunCount(token, client)
			return err
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
				calls++
				if request.URL.Host != "127.0.0.1:8080" || request.Header.Get(localStatusCredentialHeader) != token {
					t.Fatalf("local status request target or credential was incorrect")
				}
				response := &http.Response{StatusCode: http.StatusFound, Header: make(http.Header), Body: http.NoBody, Request: request}
				response.Header.Set("Location", "https://example.invalid/credential-target")
				return response, nil
			})}
			if err := scenario.call(client); err == nil {
				t.Fatal("redirect response was treated as successful")
			}
			if calls != 1 {
				t.Fatalf("local status request made %d HTTP requests, want 1", calls)
			}
		})
	}
}

func TestReadManagedUpdaterStatusDecodesRuntimeAuthenticationEvidence(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", "owner-local-status-token")
	client := &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "127.0.0.1:8080" || request.Header.Get(localStatusCredentialHeader) != "owner-local-status-token" {
			t.Fatal("runtime authentication evidence request used the wrong target or credential")
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body:    io.NopCloser(strings.NewReader(`{"state":"idle","authentication_method":"github_app","app_config_fingerprint":"runtime-fingerprint"}`)),
			Request: request}, nil
	})}
	status, method, fingerprint, err := readManagedUpdaterStatus(client)
	if err != nil || status.State != "idle" || method != gitHubAuthMethodApp || fingerprint != "runtime-fingerprint" {
		t.Fatalf("runtime updater evidence = (%#v, %q, %q, %v)", status, method, fingerprint, err)
	}
}
