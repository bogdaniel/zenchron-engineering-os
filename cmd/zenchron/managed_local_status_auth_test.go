package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
