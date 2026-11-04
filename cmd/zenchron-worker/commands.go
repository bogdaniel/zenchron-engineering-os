package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"time"
)

const workerHeartbeatInterval = 5 * time.Second

func processWorkerCommands(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID, workerName string,
	projects []discoveredProject, runtime *agentRuntime,
) error {
	commandCtx, stopHeartbeat := keepWorkerHeartbeat(ctx, client, baseURL, workerID, workerName, projects, runtime != nil)
	defer stopHeartbeat()
	if err := processWorktreeCommand(commandCtx, client, baseURL, workerID, projects); err != nil {
		return err
	}
	return processAgentRunCommand(commandCtx, client, baseURL, workerID, projects, runtime)
}

func keepWorkerHeartbeat(
	ctx context.Context, client *http.Client, baseURL *url.URL, workerID, workerName string,
	projects []discoveredProject, runtimeEnabled bool,
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
				if err := sendHeartbeat(heartbeatCtx, client, baseURL, workerID, workerName, projects, runtimeEnabled); err != nil &&
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
