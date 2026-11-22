package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

type progressRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip progressRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestProgressBufferRetainsInFlightBatchWhenReportFails(t *testing.T) {
	sent := make(chan []workerapi.AgentRunEvent, 1)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	reporter := &progressReporter{
		client: &http.Client{Transport: progressRoundTripper(func(request *http.Request) (*http.Response, error) {
			defer request.Body.Close()
			body, err := io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
			var progress workerapi.AgentRunProgress
			if err := json.Unmarshal(body, &progress); err != nil {
				return nil, err
			}
			sent <- progress.Events
			started <- struct{}{}
			<-release
			return &http.Response{
				StatusCode: http.StatusInternalServerError,
				Body:       io.NopCloser(strings.NewReader("failed")),
				Header:     make(http.Header),
			}, nil
		})},
		endpoint: "http://control-plane/progress",
		redactor: newRedactor(""),
	}
	for i := range maxPendingEvents {
		reporter.pending = append(reporter.pending, workerapi.AgentRunEvent{Kind: "output", Message: fmt.Sprintf("old-%03d", i)})
	}

	flushDone := make(chan bool, 1)
	go func() { flushDone <- reporter.flush(context.Background()) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("progress request did not start")
	}
	for i := range 20 {
		reporter.emit("output", fmt.Sprintf("new-%03d", i))
	}
	close(release)
	select {
	case stop := <-flushDone:
		if stop {
			t.Fatal("a server error marked the attempt as cancelled")
		}
	case <-time.After(time.Second):
		t.Fatal("progress request did not finish")
	}

	batch := <-sent
	if len(batch) != workerapi.MaxProgressEvents {
		t.Fatalf("sent batch has %d events, want %d", len(batch), workerapi.MaxProgressEvents)
	}
	if batch[0].Message != "old-000" {
		t.Fatalf("sent batch starts with %q, want old-000", batch[0].Message)
	}
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	for i := range workerapi.MaxProgressEvents {
		if want := fmt.Sprintf("old-%03d", i); reporter.pending[i].Message != want {
			t.Fatalf("pending event %d = %q, want in-flight event %q", i, reporter.pending[i].Message, want)
		}
	}
}
