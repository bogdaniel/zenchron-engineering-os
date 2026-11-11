package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

// ponytail: 2s progress polling is responsive at this scale; switch to streaming if request volume grows.
const (
	agentRunProgressInterval = 2 * time.Second
	maxPendingEvents         = 200
)

var credentialPattern = regexp.MustCompile(
	`(?i)\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})` +
		`|(bearer\s+)[A-Za-z0-9._~+/=-]{16,}`)

// redactor removes credentials and local absolute paths from text before it leaves the workstation.
type redactor struct {
	replacer *strings.Replacer
}

func newRedactor(worktree string, secrets ...string) redactor {
	pairs := []string{}
	for _, secret := range secrets {
		if secret != "" {
			pairs = append(pairs, secret, "[redacted]")
		}
	}
	// macOS reports temporary and cache paths with and without the /private prefix; longest form first.
	for _, path := range []string{"/private" + worktree, worktree, strings.TrimPrefix(worktree, "/private")} {
		if worktree != "" {
			pairs = append(pairs, path, ".")
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" && home != "/" {
		pairs = append(pairs, home, "~")
	}
	return redactor{replacer: strings.NewReplacer(pairs...)}
}

func (redactor redactor) clean(text string) string {
	return credentialPattern.ReplaceAllString(redactor.replacer.Replace(text), "${2}[redacted]")
}

// progressReporter is the one channel from a running attempt to the control plane: it renews the lease,
// delivers bounded redacted events, and learns about cancellation or a lost lease.
type progressReporter struct {
	client   *http.Client
	endpoint string
	attempts int
	redactor redactor

	mu        sync.Mutex
	pending   []workerapi.AgentRunEvent
	cancelled bool
	leaseLost bool
}

func (reporter *progressReporter) emit(kind, message string) {
	message = truncateText(strings.TrimSpace(reporter.redactor.clean(message)), workerapi.MaxEventMessageSize)
	if message == "" {
		return
	}
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	reporter.pending = append(reporter.pending, workerapi.AgentRunEvent{Kind: kind, Message: message})
	if len(reporter.pending) > maxPendingEvents {
		reporter.pending = reporter.pending[len(reporter.pending)-maxPendingEvents:]
	}
}

// start reports until stop is called. It cancels the attempt when the control plane requests
// cancellation or no longer recognizes the lease.
func (reporter *progressReporter) start(ctx context.Context, cancel context.CancelFunc) (stop func()) {
	reportCtx, stopReporting := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(agentRunProgressInterval)
		defer ticker.Stop()
		for {
			if reporter.flush(reportCtx) {
				cancel()
			}
			select {
			case <-reportCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() {
		stopReporting()
		<-done
		flushCtx, cancelFlush := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancelFlush()
		reporter.flush(flushCtx)
	}
}

func (reporter *progressReporter) state() (cancelled, leaseLost bool) {
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	return reporter.cancelled, reporter.leaseLost
}

// flush sends pending events and reports whether the attempt must stop.
func (reporter *progressReporter) flush(ctx context.Context) bool {
	reporter.mu.Lock()
	batch := reporter.pending
	if len(batch) > workerapi.MaxProgressEvents {
		batch = batch[:workerapi.MaxProgressEvents]
	}
	sent := len(batch)
	reporter.mu.Unlock()
	reply, status, err := reporter.send(ctx, batch)
	reporter.mu.Lock()
	defer reporter.mu.Unlock()
	switch {
	case err != nil:
		if ctx.Err() == nil {
			log.Printf("agent run progress report failed: %v", err)
		}
		return false
	case status == http.StatusConflict || status == http.StatusUnauthorized || status == http.StatusForbidden ||
		status == http.StatusNotFound:
		// The control plane no longer recognizes this attempt or this worker; stop working on it.
		reporter.leaseLost = true
		return true
	case status == http.StatusBadRequest:
		// A rejected batch would be rejected again; drop it so later reports can renew the lease.
		log.Printf("agent run progress report was rejected; dropping %d event(s)", sent)
		reporter.pending = reporter.pending[min(sent, len(reporter.pending)):]
		return false
	case status != http.StatusOK:
		log.Printf("agent run progress report returned HTTP %d", status)
		return false
	}
	reporter.pending = reporter.pending[min(sent, len(reporter.pending)):]
	reporter.cancelled = reporter.cancelled || reply.CancelRequested
	return reporter.cancelled
}

func (reporter *progressReporter) send(
	ctx context.Context, events []workerapi.AgentRunEvent,
) (workerapi.AgentRunProgressReply, int, error) {
	var reply workerapi.AgentRunProgressReply
	body, err := json.Marshal(workerapi.AgentRunProgress{Attempts: reporter.attempts, Events: events})
	if err != nil {
		return reply, 0, fmt.Errorf("encode agent run progress: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, reporter.endpoint, bytes.NewReader(body))
	if err != nil {
		return reply, 0, fmt.Errorf("create agent run progress: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := reporter.client.Do(request)
	if err != nil {
		return reply, 0, fmt.Errorf("send agent run progress: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return reply, response.StatusCode, nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&reply); err != nil {
		return reply, 0, fmt.Errorf("decode agent run progress reply: %w", err)
	}
	return reply, http.StatusOK, nil
}

func agentRunEndpoint(baseURL *url.URL, workerID, runID, suffix string) string {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + workerID + "/agent-runs/" + runID + suffix
	return endpoint.String()
}
