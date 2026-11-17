package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func startManagedChild(path string, args []string, directory string, environment []string) (*managedChild, error) {
	command := exec.Command(path, args...)
	command.Dir, command.Env, command.Stdout, command.Stderr = directory, environment, os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", filepath.Base(path), err)
	}
	child := &managedChild{command: command, done: make(chan error, 1)}
	go func() { child.done <- command.Wait() }()
	return child, nil
}

func (child *managedChild) stop(timeout time.Duration) error {
	if child == nil || child.command == nil || child.command.Process == nil {
		return nil
	}
	if err := child.command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return fmt.Errorf("signal %s to stop: %w", child.command.Path, err)
	} else if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	select {
	case <-child.done:
		return nil
	case <-time.After(timeout):
		if err := child.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("force stop %s: %w", child.command.Path, err)
		}
		<-child.done
		return fmt.Errorf("%s did not stop within %s", child.command.Path, timeout)
	}
}

func waitManagedHealth(api *managedChild, expectedRevision string) error {
	deadline := time.Now().Add(updateHealthTimeout)
	client := &http.Client{Timeout: time.Second}
	for time.Now().Before(deadline) {
		request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/healthz", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err == nil {
			var health struct {
				Status   string `json:"status"`
				Revision string `json:"revision"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&health)
			response.Body.Close()
			if decodeErr == nil && response.StatusCode == http.StatusOK && health.Status == "ok" && health.Revision == expectedRevision {
				return nil
			}
		}
		select {
		case err := <-api.done:
			return fmt.Errorf("control plane failed before activation: %w", err)
		case <-time.After(250 * time.Millisecond):
		}
	}
	return errors.New("control plane did not report the expected managed release identity")
}

func waitManagedWorker(client *http.Client, expectedRevision, supervisorToken string) error {
	deadline := time.Now().Add(updateHealthTimeout)
	for time.Now().Before(deadline) {
		request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/v1/system/update/worker-compatible", nil)
		if err != nil {
			return err
		}
		request.Header.Set("X-Zenchron-Supervisor-Token", supervisorToken)
		response, err := client.Do(request)
		if err == nil {
			var result struct {
				Compatible bool `json:"compatible"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&result)
			response.Body.Close()
			if decodeErr == nil && response.StatusCode == http.StatusOK && result.Compatible {
				return nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("worker did not report the active release and protocol")
}

func waitManagedDashboard(client *http.Client) error {
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:8080/", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
		return fmt.Errorf("dashboard returned HTTP %d with content type %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	if _, err := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20)); err != nil {
		return fmt.Errorf("read dashboard response: %w", err)
	}
	return nil
}

func withEnvironment(environment []string, values map[string]string) []string {
	result := environment
	for key, value := range values {
		result = withoutEnvironment(result, key)
		result = append(result, key+"="+value)
	}
	return result
}

func withoutEnvironment(environment []string, key string) []string {
	result := environment[:0]
	for _, value := range environment {
		if !strings.HasPrefix(value, key+"=") {
			result = append(result, value)
		}
	}
	return result
}

func managedWorkerEnvironment(base []string, projectsRoot, revision string) []string {
	environment := withEnvironment(base, map[string]string{
		"ZENCHRON_CONTROL_PLANE_URL": "http://127.0.0.1:8080", "ZENCHRON_PROJECTS_ROOT": projectsRoot,
		"ZENCHRON_RELEASE_REVISION": revision,
	})
	for _, key := range []string{"ZENCHRON_GITHUB_TOKEN", "ZENCHRON_GITHUB_APP_ID", "ZENCHRON_INSTALLATION_ID",
		"ZENCHRON_GITHUB_INSTALLATION_ID", "ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH", "ZENCHRON_GITHUB_CLIENT_ID",
		"ZENCHRON_GITHUB_CLIENT_SECRET", "ZENCHRON_GITHUB_WEBHOOK_SECRET", "ZENCHRON_SESSION_SECRET",
		"ZENCHRON_GITHUB_ALLOWED_USERS", "ZENCHRON_PUBLIC_URL", "ZENCHRON_ACCESS_FILE", "ZENCHRON_DATA_DIR",
		"ZENCHRON_UPDATE_REPOSITORY"} {
		environment = withoutEnvironment(environment, key)
	}
	return environment
}
