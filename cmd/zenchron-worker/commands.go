package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const workerHeartbeatInterval = 5 * time.Second

func processWorkerCommands(
	ctx context.Context, runner *agentRunner, heartbeat workerapi.Heartbeat, projects []discoveredProject,
) error {
	commandCtx, stopHeartbeat := keepWorkerHeartbeat(ctx, runner.client, runner.baseURL, runner.workerID, heartbeat)
	defer stopHeartbeat()
	if err := processWorktreeCommand(commandCtx, runner.client, runner.baseURL, runner.workerID, projects); err != nil {
		return err
	}
	return runner.process(commandCtx, projects)
}

func keepWorkerHeartbeat(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID string, heartbeat workerapi.Heartbeat,
) (context.Context, func()) {
	heartbeatCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(workerHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-ticker.C:
				if err := sendHeartbeat(heartbeatCtx, client, baseURL, workerID, heartbeat); err != nil &&
					heartbeatCtx.Err() == nil {
					log.Printf("worker heartbeat failed during command: %v", err)
				}
			}
		}
	}()
	return heartbeatCtx, func() {
		cancel()
		<-done
	}
}
