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
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	controlPlaneURL := strings.TrimRight(os.Getenv("ZENCHRON_CONTROL_PLANE_URL"), "/")
	if controlPlaneURL == "" {
		controlPlaneURL = "http://127.0.0.1:8080"
	}
	baseURL, err := url.ParseRequestURI(controlPlaneURL)
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return fmt.Errorf("ZENCHRON_CONTROL_PLANE_URL must be an http or https URL")
	}
	hostname, err := os.Hostname()
	if err != nil {
		return fmt.Errorf("get worker hostname: %w", err)
	}
	name := strings.TrimSpace(os.Getenv("ZENCHRON_WORKER_NAME"))
	if name == "" {
		name = hostname
	}
	if name == "" || len(name) > 128 {
		return fmt.Errorf("worker name must be between 1 and 128 bytes")
	}
	llm, err := loadAgentRuntime()
	if err != nil {
		return err
	}
	identity, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("get user config directory: %w", err)
	}
	workerID := stableID(hostname + "\x00" + identity)
	projectsRoot := strings.TrimSpace(os.Getenv("ZENCHRON_PROJECTS_ROOT"))
	if projectsRoot == "" {
		projectsRoot = "."
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := &http.Client{Timeout: 5 * time.Second}
	ticker := time.NewTicker(workerHeartbeatInterval)
	defer ticker.Stop()
	for {
		projects, err := discoverProjects(projectsRoot, workerID)
		if err != nil {
			log.Printf("project discovery failed: %v", err)
		} else {
			runtimeEnabled := llm != nil
			if err := sendHeartbeat(ctx, client, baseURL, workerID, name, projects, runtimeEnabled); err != nil {
				log.Printf("worker heartbeat failed: %v", err)
			} else if err := processWorkerCommands(ctx, client, baseURL, workerID, name, projects, llm); err != nil {
				log.Printf("worker command failed: %v", err)
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func sendHeartbeat(
	ctx context.Context, client *http.Client, baseURL *url.URL, id, name string, projects []discoveredProject,
	runtimeEnabled bool,
) error {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + id + "/heartbeat"
	body, err := json.Marshal(struct {
		Name                string              `json:"name"`
		Projects            []discoveredProject `json:"projects"`
		AgentRuntimeEnabled bool                `json:"agent_runtime_enabled"`
	}{Name: name, Projects: projects, AgentRuntimeEnabled: runtimeEnabled})
	if err != nil {
		return fmt.Errorf("encode heartbeat: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create heartbeat request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("send heartbeat: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat returned HTTP %d", response.StatusCode)
	}
	return nil
}
