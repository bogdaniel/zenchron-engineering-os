package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// The protected update API rejects requests without the LaunchAgent status credential; status must send it.
func TestShowManagedStatusReadsLiveStatusWithLocalCredential(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ZENCHRON_LOCAL_STATUS_TOKEN", "owner-local-status-token")
	calls := 0
	client := &http.Client{Transport: managedTestTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Header.Get(localStatusCredentialHeader) != "owner-local-status-token" {
			return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"state":"idle"}`)), Request: request}, nil
	})}
	// An empty HOME has no persisted status, so only the live, credentialed read can succeed.
	if err := showManagedStatus(client); err != nil || calls != 1 {
		t.Fatalf("showManagedStatus = %v after %d requests", err, calls)
	}
}
