package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ponytail: 1s polling is responsive at this scale; switch to streaming if request volume grows.
const agentRunCancellationPollInterval = time.Second

func watchAgentRunCancellation(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID, runID string, cancel context.CancelFunc,
) (<-chan struct{}, func()) {
	watchCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	go func() {
		defer close(done)
		ticker := time.NewTicker(agentRunCancellationPollInterval)
		defer ticker.Stop()
		reportedError := false
		for {
			requested, active, err := agentRunCancellationStatus(watchCtx, client, baseURL, workerID, runID)
			if err == nil {
				reportedError = false
				if !active {
					return
				}
				if requested {
					cancel()
					cancelled <- struct{}{}
					return
				}
			} else if !reportedError && watchCtx.Err() == nil {
				log.Printf("agent run cancellation check failed for %s: %v", runID, err)
				reportedError = true
			}
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return cancelled, func() {
		stop()
		<-done
	}
}

func agentRunCancellationStatus(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID, runID string,
) (requested, active bool, err error) {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + workerID + "/agent-runs/" + runID + "/cancellation"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return false, false, fmt.Errorf("create agent run cancellation check: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return false, false, fmt.Errorf("check agent run cancellation: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusConflict {
		return false, false, nil
	}
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return false, false, fmt.Errorf("agent run cancellation check returned HTTP %d", response.StatusCode)
	}
	var status struct {
		CancelRequested bool `json:"cancel_requested"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&status); err != nil {
		return false, false, fmt.Errorf("decode agent run cancellation check: %w", err)
	}
	return status.CancelRequested, true, nil
}

func finishCancelledAgentRun(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID string,
	command agentRunCommand, worktree string,
) error {
	diff, truncated, err := collectAgentRunDiff(ctx, worktree, command.BaseBranch)
	if err != nil {
		log.Printf("agent run %s cancelled; partial diff capture failed: %v", command.ID, err)
		return finishAgentRun(ctx, client, baseURL, workerID, command, "cancelled",
			"Cancelled; partial diff could not be captured.", "", false, false)
	}
	return finishAgentRun(ctx, client, baseURL, workerID, command, "cancelled", "Cancelled from dashboard.", diff, truncated, true)
}
