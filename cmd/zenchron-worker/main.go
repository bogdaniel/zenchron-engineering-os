package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/bogdaniel/zenchron-engineering-os/internal/workerapi"
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
	workerToken := strings.TrimSpace(os.Getenv("ZENCHRON_WORKER_TOKEN"))
	if !isLoopbackWorkerHost(baseURL.Hostname()) && workerToken == "" {
		return fmt.Errorf("ZENCHRON_WORKER_TOKEN is required for a remote control plane")
	}
	if !isLoopbackWorkerHost(baseURL.Hostname()) && baseURL.Scheme != "https" {
		return fmt.Errorf("remote control plane URLs must use https")
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
	identity, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("get user config directory: %w", err)
	}
	workerID := stableID(hostname + "\x00" + identity)
	projectsRoot := strings.TrimSpace(os.Getenv("ZENCHRON_PROJECTS_ROOT"))
	if projectsRoot == "" {
		projectsRoot = "."
	}
	config, err := loadWorkerConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 {
		switch {
		case len(os.Args) == 2 && os.Args[1] == "cleanup-worktrees":
			return runWorktreeCleanup(ctx, projectsRoot, workerID, config)
		case len(os.Args) == 2 && os.Args[1] == "id":
			// The stable id an operator enrolls in the control plane's access file.
			fmt.Println(workerID)
			return nil
		}
		return fmt.Errorf("unknown command; the commands are id and cleanup-worktrees")
	}
	runner := &agentRunner{client: newWorkerHTTPClient(workerToken), baseURL: baseURL, workerID: workerID,
		token: workerToken, providers: newCLIProviders(), config: config}
	if runner.chat, err = loadAgentRuntime(); err != nil {
		return err
	}
	if runner.limits, err = loadRunLimits(); err != nil {
		return err
	}
	// ponytail: providers are detected once at startup; restart the worker after installing or signing in to a CLI.
	for _, provider := range runner.providers {
		provider.detect(ctx)
	}
	runtimeEnabled := runner.chat != nil
	ticker := time.NewTicker(workerHeartbeatInterval)
	defer ticker.Stop()
	for {
		projects, err := discoverServedProjects(projectsRoot, workerID, config)
		if err != nil {
			log.Printf("project discovery failed: %v", err)
		} else {
			heartbeat := workerapi.Heartbeat{Name: name, Projects: wireProjects(projects),
				AgentRuntimeEnabled: &runtimeEnabled, Providers: runner.providerStatuses()}
			if err := sendHeartbeat(ctx, runner.client, baseURL, workerID, heartbeat); err != nil {
				log.Printf("worker heartbeat failed: %v", err)
			} else if err := processWorkerCommands(ctx, runner, heartbeat, projects); err != nil {
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

// discoverServedProjects returns the checkouts this worker may advertise and execute work for.
func discoverServedProjects(root, workerID string, config *workerConfig) ([]discoveredProject, error) {
	projects, err := discoverProjects(root, workerID)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(projects, func(project discoveredProject) bool { return !config.serves(project.Remote) }), nil
}

func wireProjects(projects []discoveredProject) []workerapi.Project {
	wire := make([]workerapi.Project, 0, len(projects))
	for _, project := range projects {
		wire = append(wire, workerapi.Project{ID: project.ID, Name: project.Name, Branch: project.Branch, Remote: project.Remote})
	}
	return wire
}

func runWorktreeCleanup(ctx context.Context, projectsRoot, workerID string, config *workerConfig) error {
	projects, err := discoverServedProjects(projectsRoot, workerID, config)
	if err != nil {
		return err
	}
	root, err := worktreeRoot()
	if err != nil {
		return err
	}
	removed, kept, err := cleanupWorktrees(ctx, root, projects)
	fmt.Printf("removed %d worktree(s); kept %d active or modified worktree(s)\n", len(removed), len(kept))
	for _, label := range kept {
		fmt.Println("kept " + label)
	}
	return err
}

func isLoopbackWorkerHost(host string) bool {
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

type workerAuthTransport struct {
	token string
}

func (transport workerAuthTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if transport.token != "" {
		request = request.Clone(request.Context())
		request.Header.Set("Authorization", "Bearer "+transport.token)
	}
	return http.DefaultTransport.RoundTrip(request)
}

func newWorkerHTTPClient(token string) *http.Client {
	return &http.Client{Transport: workerAuthTransport{token: token}, Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func sendHeartbeat(
	ctx context.Context, client *http.Client, baseURL *url.URL, id string, heartbeat workerapi.Heartbeat,
) error {
	endpoint := *baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/api/v1/workers/" + id + "/heartbeat"
	body, err := json.Marshal(heartbeat)
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
