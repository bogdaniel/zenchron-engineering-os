package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestLongCommandKeepsWorkerPresenceAlive(t *testing.T) {
	received := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/workers/"+workerTestID+"/heartbeat" {
			t.Errorf("heartbeat request = %s %s", r.Method, r.URL.Path)
		}
		received <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), workerHeartbeatInterval+3*time.Second)
	defer cancel()
	_, stop := keepWorkerHeartbeat(ctx, server.Client(), baseURL, workerTestID, workerapi.Heartbeat{Name: "worker"})
	select {
	case <-received:
		stop()
	case <-ctx.Done():
		stop()
		t.Fatal("worker presence heartbeat did not run during command processing")
	}
}
