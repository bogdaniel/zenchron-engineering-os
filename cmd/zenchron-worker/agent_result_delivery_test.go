package main

import (
	"strings"
	"testing"
	"time"
)

func TestResultDeliveryIsRetriedAfterServerErrors(t *testing.T) {
	harness := newRunHarness(t, fakeChangeScript, nil)
	harness.runner.finishRetryDelay, harness.finishFailures = 10*time.Millisecond, 2
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	if result := harness.result(); result.Status != "succeeded" || harness.finishCalls != 3 {
		t.Fatalf("result = %#v after %d deliveries", result, harness.finishCalls)
	}
	exhausted := newRunHarness(t, fakeChangeScript, nil)
	exhausted.runner.finishRetryDelay, exhausted.finishFailures = 10*time.Millisecond, 99
	if err := exhausted.process(); err == nil || exhausted.finishCalls != finishAttempts {
		t.Fatalf("exhausted delivery error = %v after %d deliveries", err, exhausted.finishCalls)
	}
}

func TestResultDeliveryAcknowledgesOnlyAnAlreadyAcceptedResult(t *testing.T) {
	accepted := newRunHarness(t, fakeChangeScript, nil)
	accepted.runner.finishRetryDelay, accepted.finishFailures = 10*time.Millisecond, 1
	accepted.finishAcceptedBeforeTimeout = true
	accepted.finishDropResponse = true
	accepted.finishConflictBody = "agent run result was already accepted\n"
	if err := accepted.process(); err != nil {
		t.Fatalf("accepted result retry: %v", err)
	}
	if result := accepted.result(); result.Status != "succeeded" || accepted.finishCalls != 2 {
		t.Fatalf("accepted result = %#v after %d deliveries", result, accepted.finishCalls)
	}

	expired := newRunHarness(t, fakeChangeScript, nil)
	expired.runner.finishRetryDelay, expired.finishFailures = 10*time.Millisecond, 1
	expired.finishDropResponse = true
	expired.finishConflictBody = "agent run lease is no longer current\n"
	if err := expired.process(); err == nil || !strings.Contains(err.Error(), "HTTP 409") || len(expired.results) != 0 {
		t.Fatalf("expired lease delivery = %v, results %#v", err, expired.results)
	}
}
