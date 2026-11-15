package main

import (
	"context"
	"log"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
)

const workerHeartbeatInterval = 5 * time.Second

func processWorkerCommands(
	ctx context.Context, runner *agentRunner, heartbeat workerapi.Heartbeat, projects []discoveredProject,
) error {
	commandCtx, stopHeartbeat := keepWorkerHeartbeat(ctx, runner, heartbeat)
	defer stopHeartbeat()
	return runner.process(commandCtx, projects)
}

func keepWorkerHeartbeat(
	ctx context.Context, runner *agentRunner, heartbeat workerapi.Heartbeat,
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
				response, err := sendHeartbeat(heartbeatCtx, runner.client, runner.baseURL, runner.workerID, heartbeat)
				if err == nil {
					err = runner.logSkippedProjects(response, heartbeat.Projects)
				}
				if err != nil && heartbeatCtx.Err() == nil {
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
