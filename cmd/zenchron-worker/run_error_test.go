package main

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

func TestFailedRunErrorsFitTheControlPlaneLimit(t *testing.T) {
	// The live stale-base refusal was rejected as an invalid result (HTTP 400) and the run expired as a lost lease.
	stale := staleBaseError{branch: "main", local: strings.Repeat("e", 40), remoteBranch: "main", remote: strings.Repeat("7", 40)}
	result := failedRun(workerapi.TerminationWorkerError, "Refused to start: "+stale.Error()+".")
	if len(result.Error) > workerapi.MaxRunErrorSize || !strings.Contains(result.Error, stale.local) ||
		!strings.Contains(result.Error, stale.remote) {
		t.Fatalf("stale-base refusal = %d bytes %q, want both commits within %d bytes", len(result.Error), result.Error, workerapi.MaxRunErrorSize)
	}
	// Long branch names must not push the second full SHA out of the stored result.
	for _, branch := range []string{strings.Repeat("x", 255), strings.Repeat("é", 125)} {
		stale.branch, stale.remoteBranch = branch, branch
		for _, prefix := range []string{"Refused to start: ", "Source check failed: "} {
			result := failedRun(workerapi.TerminationWorkerError, prefix+stale.Error()+".")
			if len(result.Error) > workerapi.MaxRunErrorSize || !utf8.ValidString(result.Error) ||
				!strings.Contains(result.Error, stale.local) || !strings.Contains(result.Error, stale.remote) {
				t.Errorf("long-branch refusal = %d bytes %q, want both full commits", len(result.Error), result.Error)
			}
		}
	}

	long := failedRun(workerapi.TerminationWorkerError, strings.Repeat("é", 300))
	if len(long.Error) > workerapi.MaxRunErrorSize || !utf8.ValidString(long.Error) || !strings.HasSuffix(long.Error, "…") {
		t.Fatalf("long error = %d bytes, valid UTF-8 %t", len(long.Error), utf8.ValidString(long.Error))
	}
}
