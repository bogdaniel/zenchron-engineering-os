package main

import (
	"strings"
	"testing"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// Seen live: Codex refused with a usage limit, and the run only said "Agent runtime failed".
const usageLimitScript = `cat > /dev/null
echo '{"type":"error","message":"You have hit your usage limit. Try again at 4:50 AM."}'
echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again at 4:50 AM."}}'
exit 1
`

func TestProviderReportedFailureIsTheRunError(t *testing.T) {
	harness := newRunHarness(t, usageLimitScript, nil)
	if err := harness.process(); err != nil {
		t.Fatalf("process run: %v", err)
	}
	result := harness.lastResult()
	if result.Status != "failed" || result.TerminationReason != workerapi.TerminationProviderExit ||
		!strings.Contains(result.Error, "The provider reported: You have hit your usage limit. Try again at 4:50 AM.") ||
		len(result.Error) > workerapi.MaxRunErrorSize {
		t.Fatalf("run result = status %q reason %q error %q", result.Status, result.TerminationReason, result.Error)
	}
}
