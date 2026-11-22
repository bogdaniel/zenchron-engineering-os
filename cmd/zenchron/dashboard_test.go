package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDashboardSetsContentSecurityPolicy(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<!doctype html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerDashboard(mux, directory)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/reviews", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("dashboard response status = %d, want %d", response.Code, http.StatusOK)
	}
	policy := response.Header().Get("Content-Security-Policy")
	for _, directive := range []string{
		"default-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
		"img-src 'self' data: https://avatars.githubusercontent.com", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
	} {
		if !strings.Contains(policy, directive) {
			t.Errorf("Content-Security-Policy %q lacks %q", policy, directive)
		}
	}
}
