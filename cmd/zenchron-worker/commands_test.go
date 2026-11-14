package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestLongCommandKeepsWorkerPresenceAlive(t *testing.T) {
	received := make(chan struct{}, 1)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/v1/workers/"+workerTestID+"/heartbeat" {
			t.Errorf("heartbeat request = %s %s", r.Method, r.URL.Path)
		}
		received <- struct{}{}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"id":"` + workerTestID + `"}`))}, nil
	})}
	baseURL, err := url.Parse("http://control-plane.test")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), workerHeartbeatInterval+3*time.Second)
	defer cancel()
	_, stop := keepWorkerHeartbeat(ctx, &agentRunner{
		client: client, baseURL: baseURL, workerID: workerTestID,
	}, workerapi.Heartbeat{Name: "worker"})
	select {
	case <-received:
		stop()
	case <-ctx.Done():
		stop()
		t.Fatal("worker presence heartbeat did not run during command processing")
	}
}
